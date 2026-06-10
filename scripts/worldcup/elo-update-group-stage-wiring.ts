import { readFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { applyMatch, WORLD_CUP_K } from "./elo-update-engine";

// PHASE 2 — In-tournament K=60 group-stage update wiring (CANDIDATE, additive). Dry-run default; --execute gated.
// Reads ONLY verified spine results (match_results: finished + api_football_fixture_id + source_payload_hash,
// not rejected). Fires ONLY when all 72 group fixtures are final+verified. From the FROZEN pre-tournament Elo
// (latest team_elo_history rating_date < 2026-06-11 = 2026-03-31 snapshot) it applies per-match K=60 updates in
// chronological order -> post-group Elo, written as NEW dated, TAGGED snapshots (source_provider=
// 'in-tournament-k60-candidate'). NEVER overwrites the pre-tournament snapshot. No /predictions, no /odds.

type DbConfig = { dbUrl: string; restUrl: string; serviceRoleKey: string; projectRef: string };
const rootDir = process.cwd();
const credentialsPath = path.join(rootDir, "supebase.txt");
const tempDir = path.join(rootDir, ".tmp", "worldcup-sql");
const worldCupProjectRef = "ahcfrgxczbgdvrqmbisw";
const SOURCE_TAG = "in-tournament-k60-candidate";
const PRETOURNAMENT_SOURCE = "international-football_eloratings_net";
const KICKOFF_BOUNDARY = "2026-06-11"; // pre-tournament Elo = latest rating_date strictly before this
const EXPECTED_GROUP_FIXTURES = 72;
const groups: Record<string, string[]> = {
  A: ["MEX", "RSA", "KOR", "CZE"], B: ["CAN", "BIH", "SUI", "QAT"], C: ["BRA", "HAI", "MAR", "SCO"],
  D: ["AUS", "PAR", "TUR", "USA"], E: ["CIV", "CUW", "ECU", "GER"], F: ["JPN", "NED", "SWE", "TUN"],
  G: ["BEL", "EGY", "IRN", "NZL"], H: ["CPV", "ESP", "KSA", "URU"], I: ["FRA", "IRQ", "NOR", "SEN"],
  J: ["ALG", "ARG", "AUT", "JOR"], K: ["COD", "COL", "POR", "UZB"], L: ["CRO", "ENG", "GHA", "PAN"],
};
const allTeams = Object.values(groups).flat();
let tmp = 0;
const args = { execute: process.argv.includes("--execute") };

async function readDbConfig(): Promise<DbConfig> {
  // CI-first: use env creds (SUPABASE_DB_URL + SUPABASE_SERVICE_ROLE_KEY) so this works on GitHub Actions where
  // supebase.txt is absent. Fall back to the local supebase.txt file when env is unset (local runs unchanged).
  const envDbUrl = process.env.SUPABASE_DB_URL;
  const envServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (envDbUrl && envServiceRoleKey) {
    const projectRef = envDbUrl.match(/postgres\.([a-z0-9]+):/)?.[1] ?? envDbUrl.match(/\/\/([^.]+)\.supabase\.co/)?.[1] ?? "";
    if (projectRef !== worldCupProjectRef) throw new Error(`Unexpected project ref from SUPABASE_DB_URL: ${projectRef || "unknown"}`);
    return { projectRef, restUrl: `https://${projectRef}.supabase.co/rest/v1`, serviceRoleKey: envServiceRoleKey, dbUrl: envDbUrl };
  }
  const text = await readFile(credentialsPath, "utf8");
  const projectRef = text.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];
  const password = text.match(/supebase password\s*:\s*(\S+)/i)?.[1];
  const restUrl = text.match(/https:\/\/[^\s]+\/rest\/v1\/?/)?.[0]?.replace(/\/$/, "");
  const serviceRoleKey = text.match(/service role secret\s*:\s*(\S+)/i)?.[1];
  if (projectRef !== worldCupProjectRef) throw new Error(`Unexpected project ref: ${projectRef ?? "unknown"}`);
  if (!password || !restUrl || !serviceRoleKey) throw new Error("Missing Supabase credentials");
  return { projectRef, restUrl, serviceRoleKey, dbUrl: `postgresql://postgres.${projectRef}:${encodeURIComponent(password)}@aws-1-us-west-1.pooler.supabase.com:5432/postgres` };
}
function q<X = any>(c: DbConfig, sql: string): X[] {
  if (/\b(insert|update|delete|drop|alter|truncate|create)\b/i.test(sql.replace(/'[^']*'/g, ""))) throw new Error("read helper refuses mutating SQL");
  mkdirSync(tempDir, { recursive: true }); tmp += 1;
  const fp = path.join(tempDir, `elo-wire-${tmp}.sql`); writeFileSync(fp, sql, "utf8");
  const r = process.platform === "win32"
    ? spawnSync("cmd.exe", ["/c", "npx.cmd", "supabase", "db", "query", "--db-url", c.dbUrl, "--output", "json", "--file", fp], { encoding: "utf8", maxBuffer: 2e8 })
    : spawnSync("npx", ["supabase", "db", "query", "--db-url", c.dbUrl, "--output", "json", "--file", fp], { encoding: "utf8", maxBuffer: 2e8 });
  if ((r.status ?? 1) !== 0) throw new Error((r.stderr || r.stdout || "query failed").slice(0, 400));
  const p = JSON.parse(r.stdout.trim()); return (Array.isArray(p) ? p : p.rows ?? []) as X[];
}
const dec = (v: any): number => v && typeof v === "object" && "Int" in v ? Number(v.Int) * Math.pow(10, Number(v.Exp || 0)) : Number(v ?? 0);

async function restInsert(c: DbConfig, rows: any[]) {
  const res = await fetch(`${c.restUrl}/team_elo_history`, {
    method: "POST",
    headers: { apikey: c.serviceRoleKey, authorization: `Bearer ${c.serviceRoleKey}`, "content-type": "application/json", prefer: "return=minimal" },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`team_elo_history insert failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return rows.length;
}

async function main() {
  const c = await readDbConfig();
  // ECHO PROJECT ID (before any potential write)
  console.log(`PROJECT ID: ${c.projectRef}  | mode: ${args.execute ? "EXECUTE" : "DRY-RUN"} | candidate source tag: ${SOURCE_TAG}`);

  const tehBefore = dec(q<{ n: number }>(c, `select count(*) n from team_elo_history`)[0].n);
  const candBefore = dec(q<{ n: number }>(c, `select count(*) n from team_elo_history where source_provider='${SOURCE_TAG}'`)[0].n);

  // ---- read ONLY verified spine group results ----
  // verified := finished + fixture-ID present + result payload hash present + not rejected
  const verifiedPredicate = `match_status='finished' and api_football_fixture_id is not null and source_payload_hash is not null and coalesce(review_status,'') <> 'rejected'`;
  // group fixture := links to one of the 72 fixture_metadata group fixtures (authoritative), or round_name marks group stage
  const groupJoin = `(fixture_metadata_id in (select id from fixture_metadata where tournament_code='WC_2026') or round_name ilike 'group%')`;
  const counts = q<any>(c, `select
      (select count(*) from fixture_metadata where tournament_code='WC_2026') group_fixtures_defined,
      (select count(*) from match_results where tournament_code='WC_2026' and ${verifiedPredicate} and ${groupJoin}) verified_group_results,
      (select count(*) from match_results where tournament_code='WC_2026' and match_status='finished' and ${groupJoin}) finished_group_results,
      (select count(*) from match_results where tournament_code='WC_2026' and match_status='finished' and ${groupJoin} and (api_football_fixture_id is null or source_payload_hash is null)) finished_but_unverified`)[0];
  const defined = dec(counts.group_fixtures_defined), verified = dec(counts.verified_group_results), finished = dec(counts.finished_group_results), unverified = dec(counts.finished_but_unverified);
  console.log(`group fixtures defined: ${defined} | finished group results: ${finished} | verified: ${verified} | finished-but-unverified (excluded): ${unverified}`);

  // ---- snapshot-tagging scheme (documented; applied only on fire) ----
  console.log(`\nsnapshot-tagging scheme (what an UPDATE would write, additive):`);
  console.log(`  table=team_elo_history  source_provider='${SOURCE_TAG}'  rating_date=<date of last group match>  one row per team (48)`);
  console.log(`  elo_rating=post-group K=60 Elo (from frozen ${PRETOURNAMENT_SOURCE} rating_date<${KICKOFF_BOUNDARY}); review_status='pending'`);
  console.log(`  identity_map_id resolved per team; pre-tournament snapshot is NEVER modified (different source+date).`);

  // ---- graceful-wait gate ----
  if (verified < EXPECTED_GROUP_FIXTURES) {
    console.log(`\nGRACEFUL WAIT: ${verified}/${EXPECTED_GROUP_FIXTURES} group fixtures verified-final. Group stage not complete -> NO update computed, NOTHING written.`);
    const tehAfter = dec(q<{ n: number }>(c, `select count(*) n from team_elo_history`)[0].n);
    console.log(`\nprotected counts: team_elo_history ${tehBefore} -> ${tehAfter} (unchanged) | ${SOURCE_TAG} rows ${candBefore} (unchanged) | DB writes: 0`);
    console.log(args.execute ? "EXECUTE requested but gate not met -> 0 writes (correct wait behavior)." : "DRY-RUN: 0 writes.");
    return;
  }

  // ---- READY: compute post-group Elo (only reached once all 72 are verified-final) ----
  console.log(`\nREADY: all ${EXPECTED_GROUP_FIXTURES} group fixtures verified-final. Computing post-group K=60 Elo from frozen pre-tournament snapshot.`);
  // pre-tournament frozen Elo (explicit source + latest date < boundary), identity-mapped
  const eloRows = q<{ fifa_code: string; identity_map_id: string; elo_rating: number }>(c, `
    with wc as (select fifa_code, lower(name) nm from teams where fifa_code = any(array[${allTeams.map((t) => `'${t}'`).join(",")}])),
    idm as (select w.fifa_code, (select m.id from national_team_identity_map m where m.fifa_code=w.fifa_code or lower(m.canonical_name)=w.nm or lower(m.elo_name)=w.nm or exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(m.aliases)='array' then m.aliases else '[]'::jsonb end) a where lower(a)=w.nm) order by (m.fifa_code=w.fifa_code) desc nulls last limit 1) identity_map_id from wc w)
    select i.fifa_code, i.identity_map_id::text identity_map_id,
      (select e.elo_rating::float8 from team_elo_history e where e.identity_map_id=i.identity_map_id and e.source_provider='${PRETOURNAMENT_SOURCE}' and e.rating_date < date '${KICKOFF_BOUNDARY}' order by e.rating_date desc limit 1) elo_rating
    from idm i order by i.fifa_code`);
  const identityOf: Record<string, string> = {}; let ratings: Record<string, number> = {};
  for (const r of eloRows) { identityOf[r.fifa_code] = r.identity_map_id; ratings[r.fifa_code] = dec(r.elo_rating); }
  const missing = allTeams.filter((t) => !Number.isFinite(ratings[t]) || !identityOf[t]);
  if (missing.length) throw new Error(`missing pre-tournament Elo/identity for: ${missing.join(",")}`);

  // verified group results in chronological order
  const results = q<any>(c, `select team_a_code a, team_b_code b, team_a_goals::int ga, team_b_goals::int gb, finished_at::text, kickoff_at::text
    from match_results where tournament_code='WC_2026' and ${verifiedPredicate} and ${groupJoin}
    order by coalesce(finished_at, kickoff_at), fixture_label`);
  let lastDate = KICKOFF_BOUNDARY;
  for (const m of results) {
    if (!(m.a in ratings) || !(m.b in ratings)) throw new Error(`result references unknown team ${m.a}/${m.b}`);
    ratings = applyMatch(ratings, m.a, m.b, dec(m.ga), dec(m.gb), WORLD_CUP_K);
    lastDate = (m.finished_at || m.kickoff_at || lastDate).slice(0, 10);
  }
  const snapshotRows = allTeams.map((t) => ({
    identity_map_id: identityOf[t], elo_name: t, rating_date: lastDate, elo_rating: Math.round(ratings[t]),
    elo_rank: null, source_provider: SOURCE_TAG,
    source_url: "derived:in-tournament K=60 update from frozen pre-tournament Elo + verified group results",
    source_snapshot: { method: "R'=R+60*G*(S-E) neutral, eloratings GD index", base_source: PRETOURNAMENT_SOURCE, base_boundary: KICKOFF_BOUNDARY, group_fixtures: EXPECTED_GROUP_FIXTURES, k: WORLD_CUP_K, candidate: true, not_current_best: true },
    confidence_score: 0.7, review_status: "pending",
  }));
  console.log(`computed post-group Elo for ${snapshotRows.length} teams (rating_date=${lastDate}). top: ` +
    [...snapshotRows].sort((x, y) => y.elo_rating - x.elo_rating).slice(0, 5).map((r) => `${r.elo_name} ${r.elo_rating}`).join(", "));

  if (!args.execute) {
    console.log(`\nDRY-RUN: would insert ${snapshotRows.length} ${SOURCE_TAG} snapshots (additive). 0 writes now.`);
    console.log(`protected counts: team_elo_history ${tehBefore} (would -> ${tehBefore + snapshotRows.length}); pre-tournament snapshot untouched.`);
    return;
  }
  // ---- EXECUTE (gated) ----
  console.log(`PROJECT ID: ${c.projectRef} — WRITING ${snapshotRows.length} ${SOURCE_TAG} snapshots (additive; pre-tournament snapshot untouched).`);
  const inserted = await restInsert(c, snapshotRows);
  const tehAfter = dec(q<{ n: number }>(c, `select count(*) n from team_elo_history`)[0].n);
  const candAfter = dec(q<{ n: number }>(c, `select count(*) n from team_elo_history where source_provider='${SOURCE_TAG}'`)[0].n);
  const frozenIntact = dec(q<{ n: number }>(c, `select count(*) n from team_elo_history where source_provider='${PRETOURNAMENT_SOURCE}'`)[0].n);
  console.log(`INSERTED ${inserted}. team_elo_history ${tehBefore}->${tehAfter} (+${tehAfter - tehBefore}); ${SOURCE_TAG} ${candBefore}->${candAfter}; pre-tournament(${PRETOURNAMENT_SOURCE}) rows=${frozenIntact} (unchanged: ${frozenIntact === 19300}).`);
}
main().catch((e) => { console.error("ERROR:", e?.message ?? e); process.exit(1); });
