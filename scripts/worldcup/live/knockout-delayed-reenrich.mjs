// WC2026 KNOCKOUT DELAYED RE-ENRICH — matures xG + assists for played knockout fixtures AFTER the provider
// finalizes them (the group stage proved capture-at-FT misses them), and refreshes the context aggregates.
//
// PROJECT: ahcfrgxczbgdvrqmbisw
//
// ISOLATION (load-bearing): this writes ONLY to API-Football enrichment + context tables. It NEVER touches
// app-data.json, the bracket/results/elo/prediction tables, or git. It is a SEPARATE workflow from the live
// loop and shares no files — so a failure here can NEVER affect results/bracket/K=60/publish. Fail-soft: every
// fixture + aggregate is wrapped in try/catch; one failure is logged and skipped, never thrown. Idempotent:
// gap-fill (COALESCE, NULLs only — never overwrites) for player_stats, insert-missing for statistics, upsert
// for aggregates — re-running is a safe no-op once data is matured.
//
// TARGETING: played knockout fixtures (round contains "Round of"/"Final"/etc, status FT/AET/PEN) that still
// need maturation — no expected_goals stored yet, OR finished within the last 48h (catch late-maturing assists).
// No speculative firing: if nothing is played+un-matured, it does nothing.
//
// USAGE: node knockout-delayed-reenrich.mjs            (DRY-RUN — no writes)
//        node knockout-delayed-reenrich.mjs --execute  (writes)
// Creds: env (SUPABASE_DB_URL + API_FOOTBALL_KEY) first [CI], else local .env.local + supebase.txt.

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const EXECUTE = process.argv.includes("--execute");
const MAT_WINDOW_MS = 48 * 3600 * 1000;
const FINISHED = new Set(["FT", "AET", "PEN"]);
const ROOT = process.cwd();

// ---- creds (never logged) ----
function fromEnvFiles() {
  for (const f of [".env.local", ".env"]) {
    const p = `${ROOT}/${f}`; if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+)$/); if (!m) continue;
      if (!process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}
fromEnvFiles();
const API_KEY = (process.env.API_FOOTBALL_KEY || "").trim();
if (!API_KEY) { console.error("API_FOOTBALL_KEY missing"); process.exit(1); }

function pgConn() {
  if (process.env.SUPABASE_DB_URL) return { connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } };
  const credPath = `${ROOT}/supebase.txt`;
  if (!existsSync(credPath)) throw new Error("no SUPABASE_DB_URL and no supebase.txt");
  const cred = readFileSync(credPath, "utf8");
  const pick = (l) => cred.match(new RegExp(l + "\\s*:\\s*(\\S+)", "i"))?.[1];
  return { host: pick("supabase db host"), port: Number(pick("supabase db port")), database: pick("supabase db database"),
    user: pick("supabase db user"), password: cred.match(/supebase password\s*:\s*(.+)/i)?.[1]?.trim(), ssl: { rejectUnauthorized: false } };
}
const { Client } = require("pg");

// ---- helpers (ingest-identical hash) ----
function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,e])=>`${JSON.stringify(k)}:${stableJson(e)}`).join(",")}}`;
  return JSON.stringify(v);
}
const sha256 = (val) => createHash("sha256").update(typeof val === "string" ? val : stableJson(val)).digest("hex");
const toInt = (x) => (x==null||x===""?null:Number.isFinite(Number(x))?Math.trunc(Number(x)):null);
const toNum = (x) => (x==null||x===""?null:Number.isFinite(Number(x))?Number(x):null);
const asText = (x) => (x==null?null:String(x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let calls = 0;
async function api(p){ await sleep(110); calls++; const r = await fetch(`https://v3.football.api-sports.io/${p}`,{headers:{"x-apisports-key":API_KEY,accept:"application/json"}}); return r.json(); }

const PCOLS = ["rating","minutes","offsides","shots_total","shots_on","goals_total","goals_conceded","assists","saves","passes_total","passes_key","passes_accuracy","tackles_total","tackles_blocks","tackles_interceptions","duels_total","duels_won","dribbles_attempts","dribbles_success","fouls_drawn","fouls_committed"];
const pv = (st) => ({ rating:toNum(st?.games?.rating), minutes:toInt(st?.games?.minutes), offsides:toInt(st?.offsides), shots_total:toInt(st?.shots?.total), shots_on:toInt(st?.shots?.on), goals_total:toInt(st?.goals?.total), goals_conceded:toInt(st?.goals?.conceded), assists:toInt(st?.goals?.assists), saves:toInt(st?.goals?.saves), passes_total:toInt(st?.passes?.total), passes_key:toInt(st?.passes?.key), passes_accuracy:asText(st?.passes?.accuracy), tackles_total:toInt(st?.tackles?.total), tackles_blocks:toInt(st?.tackles?.blocks), tackles_interceptions:toInt(st?.tackles?.interceptions), duels_total:toInt(st?.duels?.total), duels_won:toInt(st?.duels?.won), dribbles_attempts:toInt(st?.dribbles?.attempts), dribbles_success:toInt(st?.dribbles?.success), fouls_drawn:toInt(st?.fouls?.drawn), fouls_committed:toInt(st?.fouls?.committed) });
const NOW = new Date().toISOString();
const KO_RE = /round of|final|quarter|semi|play-?off|knockout/i;

async function run() {
  console.log(`KO delayed re-enrich — ${EXECUTE ? "EXECUTE" : "DRY-RUN"} | ${NOW}`);
  const c = new Client(pgConn());
  await c.connect();
  await c.query("BEGIN");
  let stat_ins = 0, pl_fixtures = 0, pl_filled = 0, agg = {}, targeted = [];
  try {
    // ---- 1) target played KO fixtures needing maturation ----
    const all = (await api(`fixtures?league=1&season=2026`))?.response || [];
    const koPlayed = all.filter((f) => KO_RE.test(f.league?.round || "") && FINISHED.has(f.fixture?.status?.short || ""));
    const haveXg = new Set((await c.query(`select distinct fixture_id from api_football_fixture_statistics where source_provider='api-football' and stat_type='expected_goals'`)).rows.map((r)=>Number(r.fixture_id)));
    const nowMs = Date.parse(NOW);
    for (const f of koPlayed) {
      const fid = toInt(f.fixture?.id); if (fid == null) continue;
      const ageMs = nowMs - Date.parse(f.fixture?.date || NOW);
      const needs = !haveXg.has(fid) || ageMs < MAT_WINDOW_MS;
      if (needs) targeted.push({ fid, round: f.league?.round, label: `${f.teams?.home?.name} v ${f.teams?.away?.name}` });
    }
    console.log(`KO played: ${koPlayed.length} | targeted for re-enrich: ${targeted.length}`);

    // ---- 2) per-fixture: insert missing stats + gap-fill players (fail-soft each) ----
    for (const t of targeted) {
      try {
        // statistics: insert only missing stat_types
        const existing = await c.query(`select team_id, stat_type from api_football_fixture_statistics where source_provider='api-football' and fixture_id=$1`, [t.fid]);
        const have = new Set(existing.rows.map((r)=>`${r.team_id}|${r.stat_type}`));
        const sresp = (await api(`fixtures/statistics?fixture=${t.fid}`))?.response || [];
        const sHash = sha256(sresp);
        for (const tr of sresp) {
          const teamId = toInt(tr?.team?.id), teamName = asText(tr?.team?.name);
          const stats = Array.isArray(tr?.statistics) ? tr.statistics : [];
          for (const [index, stat] of stats.entries()) {
            const stype = asText(stat?.type) ?? "unknown";
            if (have.has(`${teamId}|${stype}`)) continue;
            const snap = { fixture_id: t.fid, endpoint: "/fixtures/statistics", kind: "statistic", payload: stat, index, response_hash: sHash, source: "knockout-delayed-reenrich" };
            const r = await c.query(`insert into api_football_fixture_statistics
              (fixture_id,source_provider,source_stat_hash,team_id,team_name,stat_type,stat_value,stat_value_numeric,source_snapshot,api_response_hash,review_status)
              values ($1,'api-football',$2,$3,$4,$5,$6,$7,$8,$9,'pending') on conflict (source_provider,fixture_id,source_stat_hash) do nothing`,
              [t.fid, sha256(["stat", t.fid, teamId, stat, index]), teamId, teamName, stype, asText(stat?.value), toNum(stat?.value), JSON.stringify(snap), sHash]);
            stat_ins += r.rowCount;
          }
        }
        // players: gap-fill (COALESCE NULLs only), player_id>0 only (id<=0 is ambiguous — see Jordan id=0 lesson)
        const presp = (await api(`fixtures/players?fixture=${t.fid}`))?.response || [];
        const rows = [];
        for (const team of presp) for (const p of team.players || []) {
          const pid = toInt(p?.player?.id); if (pid == null || pid <= 0) continue;
          rows.push([t.fid, pid, ...PCOLS.map((cc) => pv(p.statistics?.[0] || {})[cc])]);
        }
        if (rows.length) {
          await c.query(`create temp table if not exists _re (fixture_id bigint, player_id bigint, ${PCOLS.map((cc)=>cc+(cc==="rating"?" numeric":cc==="passes_accuracy"?" text":" integer")).join(", ")}) on commit drop`);
          await c.query(`truncate _re`);
          const nc = PCOLS.length + 2;
          for (let i=0;i<rows.length;i+=400){ const ch=rows.slice(i,i+400); const ph=ch.map((_,r)=>`(${Array.from({length:nc},(__,k)=>`$${r*nc+k+1}`).join(",")})`).join(","); await c.query(`insert into _re values ${ph}`, ch.flat()); }
          const fill = ["assists",...PCOLS.filter(x=>x!=="assists")].map((cc)=>`(t.${cc} IS NULL AND p.${cc} IS NOT NULL)`).join(" OR ");
          const set = PCOLS.map((cc)=>`${cc}=COALESCE(t.${cc},p.${cc})`).join(", ");
          const u = await c.query(`update api_football_fixture_player_stats t set ${set} from _re p
            where t.source_provider='api-football' and t.fixture_id=p.fixture_id and t.player_id=p.player_id and (${fill})`);
          pl_filled += u.rowCount; pl_fixtures++;
        }
      } catch (e) { console.error(`  fixture ${t.fid} (${t.label}) re-enrich failed (skipped):`, e?.message || e); }
    }
    console.log(`statistics rows inserted: ${stat_ins} | player fixtures touched: ${pl_fixtures} | player rows gap-filled: ${pl_filled}`);

    // ---- 3) refresh context aggregates (upsert; fail-soft each board) ----
    const LB = [["top_scorers","topscorers",(s)=>s?.goals?.total],["top_assists","topassists",(s)=>s?.goals?.assists],["top_yellow_cards","topyellowcards",(s)=>s?.cards?.yellow],["top_red_cards","topredcards",(s)=>s?.cards?.red]];
    agg.leaderboards = 0;
    for (const [type, ep, vf] of LB) { try {
      const resp = (await api(`players/${ep}?league=1&season=2026`))?.response || [];
      for (const [i,e] of resp.entries()){ const s=e.statistics?.[0]||{};
        await c.query(`insert into wc2026_player_leaderboards (leaderboard_type,rank,player_id,player_name,team_id,team_name,value,goals,assists,yellow,red,appearances,minutes,source_snapshot,retrieved_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          on conflict (leaderboard_type,league_id,season,player_id) do update set rank=excluded.rank,value=excluded.value,goals=excluded.goals,assists=excluded.assists,yellow=excluded.yellow,red=excluded.red,appearances=excluded.appearances,minutes=excluded.minutes,source_snapshot=excluded.source_snapshot,retrieved_at=excluded.retrieved_at`,
          [type,i+1,toInt(e.player?.id),e.player?.name,toInt(s.team?.id),s.team?.name,toInt(vf(s)),toInt(s.goals?.total),toInt(s.goals?.assists),toInt(s.cards?.yellow),toInt(s.cards?.red),toInt(s.games?.appearences),toInt(s.games?.minutes),JSON.stringify(e),NOW]);
        agg.leaderboards++; }
    } catch (e) { console.error(`  leaderboard ${type} failed (skipped):`, e?.message||e); } }

    try { const inj=(await api(`injuries?league=1&season=2026`))?.response||[]; agg.injuries=0;
      for (const i of inj){ const pid=toInt(i.player?.id),fid=toInt(i.fixture?.id); if(pid==null&&fid==null)continue;
        await c.query(`insert into wc2026_injuries (player_id,player_name,team_id,team_name,fixture_id,injury_type,reason,injury_date,source_snapshot,retrieved_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (player_id,fixture_id,reason) do update set player_name=excluded.player_name,team_name=excluded.team_name,injury_type=excluded.injury_type,injury_date=excluded.injury_date,source_snapshot=excluded.source_snapshot,retrieved_at=excluded.retrieved_at`,
          [pid,i.player?.name,toInt(i.team?.id),i.team?.name,fid,i.player?.type,i.player?.reason??null,i.fixture?.date,JSON.stringify(i),NOW]); agg.injuries++; }
    } catch (e) { console.error(`  injuries failed (skipped):`, e?.message||e); }

    try { const teams=(await api(`teams?league=1&season=2026`))?.response||[]; agg.team_stats=0;
      for (const tm of teams){ const tid=toInt(tm.team?.id); if(tid==null)continue;
        const r=(await api(`teams/statistics?league=1&season=2026&team=${tid}`))?.response; if(!r||!r.team)continue;
        await c.query(`insert into wc2026_team_statistics (team_id,team_name,form,played,wins,draws,loses,goals_for,goals_against,clean_sheets,failed_to_score,streak_wins,streak_draws,streak_loses,biggest_win_home,biggest_win_away,source_snapshot,retrieved_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
          on conflict (team_id,league_id,season) do update set form=excluded.form,played=excluded.played,wins=excluded.wins,draws=excluded.draws,loses=excluded.loses,goals_for=excluded.goals_for,goals_against=excluded.goals_against,clean_sheets=excluded.clean_sheets,failed_to_score=excluded.failed_to_score,streak_wins=excluded.streak_wins,streak_draws=excluded.streak_draws,streak_loses=excluded.streak_loses,biggest_win_home=excluded.biggest_win_home,biggest_win_away=excluded.biggest_win_away,source_snapshot=excluded.source_snapshot,retrieved_at=excluded.retrieved_at`,
          [tid,r.team?.name,r.form,toInt(r.fixtures?.played?.total),toInt(r.fixtures?.wins?.total),toInt(r.fixtures?.draws?.total),toInt(r.fixtures?.loses?.total),toInt(r.goals?.for?.total?.total),toInt(r.goals?.against?.total?.total),toInt(r.clean_sheet?.total),toInt(r.failed_to_score?.total),toInt(r.biggest?.streak?.wins),toInt(r.biggest?.streak?.draws),toInt(r.biggest?.streak?.loses),r.biggest?.wins?.home??null,r.biggest?.wins?.away??null,JSON.stringify(r),NOW]); agg.team_stats++; }
    } catch (e) { console.error(`  team_statistics failed (skipped):`, e?.message||e); }

    // ---- 4) H2H for all CURRENT knockout pairings (any round with both teams) ----
    try { agg.h2h_pairings=0;
      const koAll = all.filter((f)=>KO_RE.test(f.league?.round||"") && f.teams?.home?.id && f.teams?.away?.id);
      for (const fx of koAll){ const a=fx.teams.home,b=fx.teams.away; const key=[a.id,b.id].sort((x,y)=>x-y).join("-");
        const h2h=(await api(`fixtures/headtohead?h2h=${a.id}-${b.id}`))?.response||[];
        for (const m of h2h){ const hg=toInt(m.goals?.home),ag=toInt(m.goals?.away); const winner=m.teams?.home?.winner?toInt(m.teams?.home?.id):m.teams?.away?.winner?toInt(m.teams?.away?.id):null;
          await c.query(`insert into wc2026_head_to_head (pairing_key,team_a_id,team_a_name,team_b_id,team_b_name,knockout_round,knockout_match_number,fixture_id,meeting_date,league_name,home_team_id,home_team_name,away_team_id,away_team_name,home_goals,away_goals,winner_team_id,source_snapshot,retrieved_at)
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) on conflict (pairing_key,fixture_id) do update set home_goals=excluded.home_goals,away_goals=excluded.away_goals,winner_team_id=excluded.winner_team_id,knockout_round=excluded.knockout_round,source_snapshot=excluded.source_snapshot,retrieved_at=excluded.retrieved_at`,
            [key,toInt(a.id),a.name,toInt(b.id),b.name,fx.league?.round,toInt(fx.fixture?.id),toInt(m.fixture?.id),m.fixture?.date,m.league?.name,toInt(m.teams?.home?.id),m.teams?.home?.name,toInt(m.teams?.away?.id),m.teams?.away?.name,hg,ag,winner,JSON.stringify(m),NOW]); }
        agg.h2h_pairings++; }
    } catch (e) { console.error(`  h2h failed (skipped):`, e?.message||e); }

    console.log(`aggregates refreshed:`, JSON.stringify(agg));
    console.log(`API calls: ${calls}`);
    if (EXECUTE) { await c.query("COMMIT"); console.log("COMMITTED ✓"); }
    else { await c.query("ROLLBACK"); console.log("ROLLED BACK (dry-run) ✓"); }
  } catch (e) {
    await c.query("ROLLBACK").catch(()=>{});
    console.error("FATAL (rolled back — live loop UNAFFECTED):", e?.message || e);
    process.exitCode = 1;
  } finally { await c.end(); }
}
run().catch((e) => { console.error("top-level error (non-blocking):", e?.message || e); process.exitCode = 1; });
