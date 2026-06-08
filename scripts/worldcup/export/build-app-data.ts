import { readFile } from "node:fs/promises";
import { copyFileSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { buildRealStandings, type TeamInfo, type ResultInput } from "../standings-core";
import { ALL_TEAMS, teamGroup } from "../advancement-scenario-core";
import type { Aux } from "../tiebreaker-ladders-2026";
import { buildProjectedFinishers, resolveTeamPath, type KnockoutRow, type SimFinishRow } from "../knockout-path-core";
import { buildResultLookup, resultForFixture } from "./result-join";

// BUILD app-data.json — ONE vetted public app-data file from the LIVE PROMOTED runs only.
// Reads (read-only): live group predictions, live group sim, live knockout sim, live advancement scenarios,
// coach/tactical context, and validated AI narration if a narration table exists (else narration: []).
// Strips ALL internal IDs (UUIDs / table names / model-version tags / status jargon) -> plain source_labels.
// Probabilities are DECIMALS 0..1. Validates against data/exports/app-data.contract.json (shape + ranges + sums
// + ID-leak scan) BEFORE writing — fails loud on any violation. Idempotent: meta.generated_at = the live runs'
// provenance time, so re-running on the same live state yields a byte-identical file (loop step 7 self-heal).
// No model/prediction changes. No odds/predictions endpoints. CLI reads; writes the JSON file only.

const rootDir = process.cwd();
const PROJECT = "ahcfrgxczbgdvrqmbisw";
const credentialsPath = path.join(rootDir, "supebase.txt");
const tempDir = path.join(rootDir, ".tmp", "worldcup-sql");
const OUT = "data/exports/app-data.json";
const UI_OUTS = ["ui/app-data.json", "ui-v2/public/app-data.json", "ui-v2/dist/app-data.json"];
const CONTRACT = "data/exports/app-data.contract.json";
const LIVE_POINTER = "data/exports/live-runs-pointer.json";
const FLAG_MANIFEST = "data/exports/team-flags.json";
const API_FOOTBALL_FIXTURE_CACHE = "data/external/api-football/cache/fixtures_league1_season2026.json";
let tmp = 0;

async function dbUrl() {
  // CI-first: use the env DB URL (SUPABASE_DB_URL) so this works on GitHub Actions where supebase.txt is absent.
  // Fall back to the local supebase.txt file when env is unset (local runs unchanged).
  const envDbUrl = process.env.SUPABASE_DB_URL;
  if (envDbUrl) {
    const envRef = envDbUrl.match(/postgres\.([a-z0-9]+):/)?.[1] ?? envDbUrl.match(/\/\/([^.]+)\.supabase\.co/)?.[1] ?? "";
    if (envRef !== PROJECT) throw new Error(`Unexpected project ref from SUPABASE_DB_URL: ${envRef || "unknown"}`);
    return envDbUrl;
  }
  const text = await readFile(credentialsPath, "utf8");
  const ref = text.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];
  const pw = text.match(/supebase password\s*:\s*(\S+)/i)?.[1];
  if (ref !== PROJECT) throw new Error(`Unexpected project ref: ${ref}`);
  if (!pw) throw new Error("no password");
  return `postgresql://postgres.${ref}:${encodeURIComponent(pw)}@aws-1-us-west-1.pooler.supabase.com:5432/postgres`;
}
function q<X = any>(url: string, sql: string): X[] {
  if (/\b(insert|update|delete|drop|alter|truncate|create|grant|revoke)\b/i.test(sql.replace(/'[^']*'/g, ""))) throw new Error("export is read-only; refused mutating SQL");
  mkdirSync(tempDir, { recursive: true }); tmp++;
  const fp = path.join(tempDir, `appdata-${tmp}.sql`); writeFileSync(fp, sql, "utf8");
  const r = process.platform === "win32"
    ? spawnSync("cmd.exe", ["/c", "npx.cmd", "supabase", "db", "query", "--db-url", url, "--output", "json", "--file", fp], { encoding: "utf8", maxBuffer: 3e8 })
    : spawnSync("npx", ["supabase", "db", "query", "--db-url", url, "--output", "json", "--file", fp], { encoding: "utf8", maxBuffer: 3e8 });
  if ((r.status ?? 1) !== 0) throw new Error((r.stderr || r.stdout || "").slice(0, 400));
  const o = r.stdout.trim(); if (!o) return []; const p = JSON.parse(o); return (Array.isArray(p) ? p : p.rows ?? p) as X[];
}
function dec(v: any): number | null { if (v === null || v === undefined) return null; if (typeof v === "number") return v; if (typeof v === "string") { const n = Number(v); return Number.isNaN(n) ? null : n; } if (typeof v === "object") { if (v.NaN === true) return null; if ("Int" in v) return Number(v.Int) * Math.pow(10, Number(v.Exp ?? 0)); } const n = Number(v); return Number.isNaN(n) ? null : n; }
const num = (v: any) => dec(v) ?? 0;
const d4 = (v: number) => Number(v.toFixed(4));
const humanScope = (s: string) => s.replace(/_/g, " ");
// Supabase CLI serializes Postgres text[] as a literal "{a,b,c}" string (not a JSON array) — parse it.
function pgArray(v: any): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (v && typeof v === "object" && Array.isArray(v.Elements)) return v.Elements.map(String); // supabase CLI array shape
  if (typeof v === "string") { const s = v.trim(); if (s.startsWith("{") && s.endsWith("}")) { const inner = s.slice(1, -1); return inner ? inner.split(",").map((x) => x.replace(/^"|"$/g, "").trim()).filter(Boolean) : []; } }
  return [];
}

// plain-language source labels (NEVER expose run IDs / version tags)
const SRC = { groupModel: "our group-stage match model", groupSim: "the group-stage tournament simulation", knockout: "the knockout tournament simulation", advancement: "the 2026 advancement rules", tactical: "coach & tactical profile" };
const TIEBREAK: Record<string, string> = { points: "points", head_to_head: "head-to-head", overall_gd: "goal difference", overall_gf: "goals scored", fair_play: "fair play", fifa_ranking: "FIFA ranking" };
const FINISH = ["1st", "2nd", "3rd", "4th"];

// Static venue -> {city, state/province, country, IANA timezone}. fixture_metadata has venue_name + (partial) city
// but no timezone/state/country, so we derive them here from the known WC2026 host venues. Missing venue -> all null
// (the UI then shows the viewer clock only). This is static fixture metadata, not a prediction input.
const VENUE_GEO: Record<string, { city: string; state: string; country: string; tz: string }> = {
  "Estadio Banorte": { city: "Mexico City", state: "Mexico City", country: "Mexico", tz: "America/Mexico_City" },
  "Estadio Azteca": { city: "Mexico City", state: "Mexico City", country: "Mexico", tz: "America/Mexico_City" },
  "Estadio Akron": { city: "Guadalajara", state: "Jalisco", country: "Mexico", tz: "America/Mexico_City" },
  "Estadio BBVA": { city: "Monterrey", state: "Nuevo León", country: "Mexico", tz: "America/Monterrey" },
  "BMO Field": { city: "Toronto", state: "Ontario", country: "Canada", tz: "America/Toronto" },
  "BC Place": { city: "Vancouver", state: "British Columbia", country: "Canada", tz: "America/Vancouver" },
  "MetLife Stadium": { city: "New York/New Jersey", state: "New Jersey", country: "United States", tz: "America/New_York" },
  "Gillette Stadium": { city: "Boston", state: "Massachusetts", country: "United States", tz: "America/New_York" },
  "NRG Stadium": { city: "Houston", state: "Texas", country: "United States", tz: "America/Chicago" },
  "Lincoln Financial Field": { city: "Philadelphia", state: "Pennsylvania", country: "United States", tz: "America/New_York" },
  "SoFi Stadium": { city: "Los Angeles", state: "California", country: "United States", tz: "America/Los_Angeles" },
  "Mercedes-Benz Stadium": { city: "Atlanta", state: "Georgia", country: "United States", tz: "America/New_York" },
  "Lumen Field": { city: "Seattle", state: "Washington", country: "United States", tz: "America/Los_Angeles" },
  "Hard Rock Stadium": { city: "Miami", state: "Florida", country: "United States", tz: "America/New_York" },
  "Arrowhead Stadium": { city: "Kansas City", state: "Missouri", country: "United States", tz: "America/Chicago" },
  "AT&T Stadium": { city: "Dallas", state: "Texas", country: "United States", tz: "America/Chicago" },
  "Levi's Stadium": { city: "San Francisco Bay Area", state: "California", country: "United States", tz: "America/Los_Angeles" },
};

function readApiFootballVenueFallback(): Record<string, { name: string; city: string | null }> {
  const fp = path.join(rootDir, API_FOOTBALL_FIXTURE_CACHE);
  if (!existsSync(fp)) return {};
  const doc = JSON.parse(readFileSync(fp, "utf8"));
  const rows = doc?.response?.response ?? doc?.response ?? [];
  if (!Array.isArray(rows)) return {};
  const map: Record<string, { name: string; city: string | null }> = {};
  for (const row of rows) {
    const id = row?.fixture?.id;
    const venue = row?.fixture?.venue;
    if (id == null || !venue?.name) continue;
    map[String(id)] = { name: String(venue.name), city: venue.city ? String(venue.city) : null };
  }
  return map;
}

function readLivePointer() {
  const fp = path.join(rootDir, LIVE_POINTER);
  if (!existsSync(fp)) return null;
  const doc = JSON.parse(readFileSync(fp, "utf8"));
  const runs = doc.runs ?? doc.live_pointer ?? doc;
  if (!runs?.prediction_run || !runs?.group_sim || !runs?.knockout_sim) {
    throw new Error(`${LIVE_POINTER} exists but is missing prediction_run/group_sim/knockout_sim`);
  }
  return {
    pred: String(runs.prediction_run),
    gsim: String(runs.group_sim),
    ko: String(runs.knockout_sim),
    source: LIVE_POINTER,
  };
}

function readFlagMap(): Record<string, string> {
  const fp = path.join(rootDir, FLAG_MANIFEST);
  if (!existsSync(fp)) return {};
  const doc = JSON.parse(readFileSync(fp, "utf8"));
  const map: Record<string, string> = {};
  for (const row of doc.flags ?? []) {
    const code = String(row.code ?? "");
    const asset = typeof row.asset === "string" ? row.asset : "";
    if (!/^[A-Z0-9]{3}$/.test(code)) continue;
    if (!/^flags\/[A-Z0-9]{3}\.(png|svg|jpg|webp)$/i.test(asset)) continue;
    if (/^https?:\/\//i.test(asset)) continue;
    map[code] = asset;
  }
  return map;
}

// ---------- lightweight contract validation (shape + numeric ranges, driven by the contract) ----------
function validateShape(data: any, schema: any, p: string, errs: string[]) {
  if (!schema) return;
  if (schema.type === "number" && typeof data === "number") {
    if (typeof schema.minimum === "number" && data < schema.minimum - 1e-9) errs.push(`${p} = ${data} < min ${schema.minimum}`);
    if (typeof schema.maximum === "number" && data > schema.maximum + 1e-9) errs.push(`${p} = ${data} > max ${schema.maximum}`);
  }
  if (schema.type === "array" && Array.isArray(data) && schema.items) data.forEach((el, i) => validateShape(el, schema.items, `${p}[${i}]`, errs));
  if (Array.isArray(schema.required) && data && typeof data === "object") for (const k of schema.required) if (!(k in data)) errs.push(`${p}.${k} MISSING`);
  if (schema.properties && data && typeof data === "object") for (const k of Object.keys(schema.properties)) if (k in data) validateShape(data[k], schema.properties[k], `${p}.${k}`, errs);
}

// ---------- ID-leak scan: fail loud if any internal token slips through ----------
function idLeakScan(jsonStr: string): string[] {
  const hits: string[] = [];
  const uuid = jsonStr.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g);
  if (uuid) hits.push(`UUID(s): ${[...new Set(uuid)].slice(0, 3).join(", ")}`);
  const tokens = [
    "tournament_simulation", "match_predictions", "prediction_run", "tournament_advancement", "team_tactical_profiles",
    "team_coaches", "source_snapshot", "model_candidates", "tournament_event_log", "simulation_run",
    "current_best", "not_global_current_best", "lifecycle", "superseded", "candidate", "needs_review", "review_status", "run_status",
    "dynamic-draw", "monte-carlo", "monte_carlo", "elo-group-matrix", "form-plus-elo", "match-predictor", "coach-tactical-context",
    "all-groups-group-stage", "full-tournament-knockout", "corrected-tiebreakers", "066be1b1", "c45b3e6a", "c222f2c6",
  ];
  for (const t of tokens) if (jsonStr.toLowerCase().includes(t.toLowerCase())) hits.push(`token: ${t}`);
  const ver = jsonStr.match(/\bv\d+\.\d+\b|-v\d{8}\b/g); if (ver) hits.push(`version-tag(s): ${[...new Set(ver)].slice(0, 3).join(", ")}`);
  return hits;
}

async function main() {
  const url = await dbUrl();
  console.log(`PROJECT ID: ${PROJECT} | build-app-data (read-only)`);

  // ---- resolve LIVE runs from the pointer file first, else lifecycle markers; never infer "latest" ----
  const pointerLive = readLivePointer();
  const live = pointerLive ?? q(url, `select
      (select id::text from prediction_runs where source_snapshot->>'lifecycle'='live_current' limit 1) pred,
      (select id::text from tournament_simulation_runs where scope='all-groups-group-stage' and source_snapshot->>'lifecycle'='live_current' limit 1) gsim,
      (select id::text from tournament_simulation_runs where scope='full-tournament-knockout' and source_snapshot->>'lifecycle'='live_current' limit 1) ko`)[0];
  if (!live?.pred || !live?.gsim || !live?.ko) throw new Error(`could not resolve all live runs: ${JSON.stringify(live)}`);
  const asOf = q(url, `select max(created_at)::text t from (
      select created_at from prediction_runs where id='${live.pred}'
      union all select created_at from tournament_simulation_runs where id in ('${live.gsim}','${live.ko}')) x`)[0]?.t;

  // ---- pulls (read-only) ----
  const gs = q(url, `select team_code, team_name, group_code,
      win_group_probability::float8 wg, finish_2nd_probability::float8 f2, advance_top_2_probability::float8 t2,
      reach_round_of_32_probability::float8 adv, finish_1st_probability::float8 f1, finish_3rd_probability::float8 f3, finish_4th_probability::float8 f4,
      (source_snapshot->>'advance_as_best_third_probability')::float8 bt
    from tournament_simulation_team_results where simulation_run_id='${live.gsim}' order by group_code, win_group_probability desc`);
  const ko = q(url, `select team_code,
      reach_round_of_32_probability::float8 r32, reach_round_of_16_probability::float8 r16, reach_quarterfinal_probability::float8 qf,
      reach_semifinal_probability::float8 sf, reach_final_probability::float8 fin, champion_probability::float8 ch
    from tournament_simulation_team_results where simulation_run_id='${live.ko}'`);
  const fx = q(url, `select mp.team_a_code a, mp.team_b_code b,
      mp.team_a_win_probability::float8 pa, mp.draw_probability::float8 pd, mp.team_b_win_probability::float8 pb,
      fm.kickoff_at::date kdate,
      to_char(fm.kickoff_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') kutc,
      fm.venue_name venue, fm.city dbcity, fm.external_fixture_id extid
    from match_predictions mp left join fixture_metadata fm on fm.id=mp.fixture_metadata_id
    where mp.prediction_run_id='${live.pred}'`);
  const scenRow = q(url, `select document->'teams' teams, as_of_result_count aoc from tournament_advancement_scenarios
      where simulation_run_id='${live.gsim}' and phase in ('live','pre_tournament') order by as_of_result_count desc, created_at desc limit 1`)[0];
  const scen = scenRow?.teams ?? {};
  const scenConditioned = num(scenRow?.aoc) > 0; // true once real results condition the advancement run (as_of_result_count>0); pre-tournament=0 -> group sim verbatim
  const tac = q(url, `select p.team_code, c.name coach,
      p.formation_primary fp, p.formation_alternatives alts, p.pressing_intensity press, p.build_up_style build, p.transition_style trans,
      p.defensive_block_depth block, p.attacking_width width, p.set_piece_strength setp, p.confidence_score::float8 conf
    from team_tactical_profiles p
    join teams t on t.id=p.team_id left join team_coaches c on c.team_id=t.id
    where p.profile_version='coach-tactical-context-v20260604'`);
  // narration: only if a narration table exists; else []. Carry the lightweight target key (team_code for
  // scope=team, group for scope=group) so the UI can match a narration to its team/group reliably instead of
  // guessing from the prose. Contract allows extra narration fields (additionalProperties:true); these are
  // plain codes/letters, never internal IDs. Graceful: group_code only exists on ai_narrations.
  const narrTable = q(url, `select to_regclass('public.ai_narrations')::text a, to_regclass('public.match_narrations')::text b`)[0];
  let narration: any[] = [];
  if (narrTable?.a) {
    try {
      // group_narration is PARKED: the 12 rows remain in the DB (not deleted) but are NOT surfaced, so the app
      // carries only the per-team narrations and no stale group text ships. Re-enable = drop the content_type filter.
      const rows = q(url, `select content_type, headline, body, team_code, group_code from public.ai_narrations where coalesce(validated,true)=true and content_type <> 'group_narration' order by created_at desc limit 200`);
      narration = rows.map((r: any) => ({ content_type: r.content_type, headline: r.headline, body: r.body, ...(r.team_code ? { team_code: r.team_code } : {}), ...(r.group_code ? { group: r.group_code } : {}) }));
    } catch { narration = []; }
  } else if (narrTable?.b) {
    try { narration = q(url, `select content_type, headline, body from public.match_narrations where coalesce(validated,true)=true order by created_at desc limit 200`); } catch { narration = []; }
  }

  // ---- REAL standings inputs (verified results only, K=60 gate) + FIFA snapshot for the Article-13 final tiebreaker.
  // Distinct from the predicted `groups` block: this is the actual table, full Article-13 ladder + cross-group best-third. ----
  const verifiedRows = q(url, `select team_a_code a, team_b_code b, team_a_goals::int ga, team_b_goals::int gb, api_football_fixture_id::text afid
    from match_results
    where tournament_code='WC_2026' and match_status='finished' and api_football_fixture_id is not null
      and source_payload_hash is not null and coalesce(review_status,'')<>'rejected'
      and (fixture_metadata_id in (select id from fixture_metadata where tournament_code='WC_2026') or round_name ilike 'group%')`);
  // verified final scores -> fixture cards (K-gated rows above). Identity by API-Football id
  // (fm.external_fixture_id == match_results.api_football_fixture_id), code-pair fallback;
  // goals mapped by team code into each fixture's orientation. See result-join.ts.
  const resultLookup = buildResultLookup(verifiedRows.map((r: any) => ({ a: r.a, b: r.b, ga: num(r.ga), gb: num(r.gb), afid: r.afid ?? null })));
  const frRows = q(url, `select team_code, fifa_rank from fifa_world_rankings where ranking_snapshot_date='2026-04-01'`);
  const realFifa: Record<string, number> = {}; for (const r of frRows) realFifa[r.team_code] = num(r.fifa_rank);
  const realAux: Aux = { fairPlay: {}, fifaRank: realFifa };

  // ---- group map + matchday (from kickoff dates, per group) ----
  const teamGroup: Record<string, string> = {}; for (const r of gs) teamGroup[r.team_code] = r.group_code;
  const fxByGroup: Record<string, any[]> = {};
  for (const f of fx) { const g = teamGroup[f.a]; (fxByGroup[g] ??= []).push(f); }
  const matchdayOf = new Map<string, number>(); // "A|B" -> md (each group: 6 fixtures sorted by kickoff, paired 2 per matchday)
  for (const g of Object.keys(fxByGroup)) {
    const sorted = fxByGroup[g].slice().sort((x, y) => String(x.kts ?? "").localeCompare(String(y.kts ?? "")) || `${x.a}${x.b}`.localeCompare(`${y.a}${y.b}`));
    sorted.forEach((f, i) => matchdayOf.set(`${f.a}|${f.b}`, Math.floor(i / 2) + 1));
  }

  // ============ BUILD BLOCKS ============
  const teamName: Record<string, string> = {}; for (const r of gs) teamName[r.team_code] = r.team_name;
  const koByCode: Record<string, any> = {}; for (const r of ko) koByCode[r.team_code] = r;

  const meta = {
    tournament: "FIFA World Cup 2026",
    generated_at: asOf ?? "unknown",
    model_label: "our World Cup 2026 simulation model",
    simulation_count: 20000,
    disclaimer: "Model simulation outputs for information and entertainment only — not betting odds or guarantees.",
    model_note: "Probabilities come from simulating the whole tournament many times from current team strength; they update as real results come in.",
  };
  const flagMap = readFlagMap();
  const apiFootballVenueFallback = readApiFootballVenueFallback();
  const teams = gs.map((r) => ({ code: r.team_code, name: r.team_name, group: r.group_code, flag: flagMap[r.team_code] ?? null }))
    .sort((a, b) => a.group.localeCompare(b.group) || a.code.localeCompare(b.code));

  // HERO advance % — single source of truth with the AI summary. Reads the RESULTS-CONDITIONED advancement run
  // (`scen` = the same tournament_advancement_scenarios doc the narration reads, latest as_of_result_count), so once
  // groups play it updates (eliminated -> ~0, clinched -> ~1) and can never contradict the AI. Pre-tournament the
  // stored row's advance_total is pinned to the group sim (verified identical for all 48 teams), so today is unchanged.
  // Graceful per-team fallback to the frozen group sim if the conditioned value is ever absent. (Hero only — win_group,
  // finish_distribution, knockout odds and the W/D/L bars are unchanged.)
  const heroAdvance = (code: string, gsimAdv: any) => {
    const sv = (scen as any)?.[code]?.probabilities?.advance_total;
    return sv != null && sv !== "" ? d4(num(sv)) : d4(num(gsimAdv));
  };
  // GROUPS-TAB tournament numbers — SAME single source of truth as the hero + scenario card + AI: the RESULTS-CONDITIONED
  // advancement run (`scen`, latest as_of_result_count). win_group=finish-1st, runner_up=finish-2nd, finish_third/fourth,
  // advance_total, and top_2=win_group+runner_up all exist in that doc. Pre-tournament the doc overlays the group sim
  // (verified byte-identical for all 48), so today is unchanged; once groups play it conditions (eliminated -> ~0,
  // clinched -> ~1) and can never contradict the scenario card beside it. Graceful per-field fallback to the frozen group
  // sim value if a conditioned value is absent. (Does NOT touch the W/D/L bars, real_standings, or knockout odds.)
  const cprob = (code: string) => (scen as any)?.[code]?.probabilities ?? null;
  const condField = (code: string, key: string, gsimVal: any): number => { if (!scenConditioned) return d4(num(gsimVal)); const v = cprob(code)?.[key]; return v != null && v !== "" ? d4(num(v)) : d4(num(gsimVal)); };
  const condTop2 = (code: string, gsimT2: any): number => { if (!scenConditioned) return d4(num(gsimT2)); const p = cprob(code); return (p && p.win_group != null && p.runner_up != null) ? d4(num(p.win_group) + num(p.runner_up)) : d4(num(gsimT2)); };
  const groupsMap: Record<string, any[]> = {};
  for (const r of gs) {
    const first = condField(r.team_code, "win_group", r.f1), second = condField(r.team_code, "runner_up", r.f2), third = condField(r.team_code, "finish_third", r.f3), fourth = condField(r.team_code, "finish_fourth", r.f4);
    const fd = [first, second, third, fourth];
    const proj = FINISH[fd.indexOf(Math.max(...fd))];
    (groupsMap[r.group_code] ??= []).push({ code: r.team_code, win_group: condField(r.team_code, "win_group", r.wg), top_2: condTop2(r.team_code, r.t2), advance: heroAdvance(r.team_code, r.adv), finish_distribution: { "1st": first, "2nd": second, "3rd": third, "4th": fourth }, projected_finish: proj });
  }
  const groups = Object.keys(groupsMap).sort().map((g) => ({ group: g, standings: groupsMap[g].sort((a, b) => b.win_group - a.win_group) }));

  const fixtures = fx.map((f) => {
    const cachedVenue = f.extid ? apiFootballVenueFallback[String(f.extid)] : null;
    const venueName = f.venue ?? cachedVenue?.name ?? null;
    const venueCity = f.dbcity ?? cachedVenue?.city ?? null;
    const geo = venueName ? VENUE_GEO[venueName] : null;
    return {
      home: f.a, away: f.b, group: teamGroup[f.a], matchday: matchdayOf.get(`${f.a}|${f.b}`) ?? 1,
      kickoff: f.kdate ? String(f.kdate) : null,
      kickoff_utc: f.kutc ?? null,
      venue: venueName,
      city: geo?.city ?? venueCity,
      state: geo?.state ?? null,
      country: geo?.country ?? null,
      venue_timezone: geo?.tz ?? null,
      probabilities: { home_win: d4(num(f.pa)), draw: d4(num(f.pd)), away_win: d4(num(f.pb)) },
      result: resultForFixture(f.a, f.b, f.extid, resultLookup),
      live_score_ref: null,
    };
  }).sort((a, b) => a.group.localeCompare(b.group) || a.matchday - b.matchday || a.home.localeCompare(b.home));

  // group games per team (their perspective)
  const teamGames: Record<string, any[]> = {};
  for (const f of fx) {
    const md = matchdayOf.get(`${f.a}|${f.b}`) ?? 1;
    (teamGames[f.a] ??= []).push({ opponent: f.b, matchday: md, win: d4(num(f.pa)), draw: d4(num(f.pd)), loss: d4(num(f.pb)) });
    (teamGames[f.b] ??= []).push({ opponent: f.a, matchday: md, win: d4(num(f.pb)), draw: d4(num(f.pd)), loss: d4(num(f.pa)) });
  }
  const team_paths = gs.map((r) => { const k = koByCode[r.team_code] ?? {}; return {
    code: r.team_code, advance: d4(num(k.r32 ?? r.adv)),
    knockout: { reach_round_of_16: d4(num(k.r16)), reach_quarterfinal: d4(num(k.qf)), reach_semifinal: d4(num(k.sf)), reach_final: d4(num(k.fin)), champion: d4(num(k.ch)) },
    group_games: (teamGames[r.team_code] ?? []).sort((a, b) => a.matchday - b.matchday),
  }; }).sort((a, b) => b.knockout.champion - a.knockout.champion);

  // scenarios (from the live advancement scenario document)
  const scenarios = Object.keys(scen).sort().map((code) => {
    const s = scen[code] ?? {}; const pr = s.probabilities ?? {}; const tpd = s.third_place_dependency ?? {};
    const inHands = (num(pr.win_group) + num(pr.runner_up)) >= num(pr.third_place_advance);
    const routes = (s.what_they_need ?? []).map((w: any) => ({
      route: w.condition_label, chance: d4(num(w.scenario_weight)),
      own_form: String(w.own_results_needed ?? ""), depends_on_other_groups: w.depends_on_groups ?? [],
      decided_by: (w.tiebreaker_path ?? []).map((t: string) => TIEBREAK[t] ?? t),
    }));
    return { code, advance_chance: d4(num(pr.advance_total)), in_their_hands: inHands, routes,
      third_place_race: { in_race: tpd.is_in_third_race === true, advances_if_third: tpd.passes_cutoff_in_pct != null ? d4(num(tpd.passes_cutoff_in_pct)) : null, race_position: tpd.group_third_race_rank ?? null, watch_groups: tpd.competing_third_groups ?? [] } };
  });

  // tactical_context
  const clean = (v: any) => (v == null || String(v).toLowerCase() === "unknown") ? null : String(v).replace(/_/g, " ");
  const tactical_context = tac.map((t) => ({
    code: t.team_code, coach: t.coach ?? null, formation_primary: clean(t.fp) ?? (t.fp === "variable" ? "variable" : null),
    reported_range: pgArray(t.alts),
    style: { build_up: clean(t.build), pressing: clean(t.press), transition: clean(t.trans), defensive_block: clean(t.block), attacking_width: clean(t.width), set_pieces: clean(t.setp) },
    confidence: t.conf != null ? d4(num(t.conf)) : null, source_label: SRC.tactical,
  })).sort((a, b) => a.code.localeCompare(b.code));

  // REAL standings block (full Article-13 ladder + cross-group best-third), built from verified results only.
  // teamGroup is the canonical engine map -> the displayed table agrees with the conditional engine. Graceful pre-tournament.
  const realTeams: TeamInfo[] = ALL_TEAMS.map((c) => ({ code: c, name: teamName[c] ?? c, group: teamGroup[c] }));
  const validPair = new Set<string>(); for (const c of ALL_TEAMS) for (const d of ALL_TEAMS) if (teamGroup[c] === teamGroup[d] && c < d) validPair.add([c, d].sort().join("|"));
  const seenPair = new Set<string>(); const realResults: ResultInput[] = [];
  for (const r of verifiedRows) { const k = [r.a, r.b].sort().join("|"); if (!validPair.has(k) || seenPair.has(k)) continue; seenPair.add(k); realResults.push({ a: r.a, b: r.b, ga: num(r.ga), gb: num(r.gb) }); }
  const real_standings = buildRealStandings(realTeams, realResults, realAux);

  // knockout_paths: deterministic R32 route per team (thin lookup) — reads the authoritative knockout_schedule (R32 slots
  // cross-checked vs roundOf32Slots) and DELEGATES the opponent name to the live group sim's projected finishers (gs).
  // Slot + venue are certain; R32 dates are the round window; real_opponent is a null hook for the bracket resolver.
  const asObj = (v: any) => (typeof v === "string" ? JSON.parse(v) : v);
  const r32raw = q(url, `select match_number, round, slot_a_label, slot_b_label, slot_a, slot_b, venue, city, venue_timezone, round_window,
      match_date::text mdate, to_char(kickoff_utc at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') kutc, date_confirmed
    from knockout_schedule where round='round_of_32' order by match_number`);
  const r32rows: KnockoutRow[] = r32raw.map((r: any) => ({ match_number: num(r.match_number), round: r.round, slot_a_label: r.slot_a_label, slot_b_label: r.slot_b_label, slot_a: asObj(r.slot_a), slot_b: asObj(r.slot_b), venue: r.venue ?? null, city: r.city ?? null, venue_timezone: r.venue_timezone ?? null, round_window: r.round_window ?? null, match_date: r.mdate ?? null, kickoff_utc: r.kutc ?? null, date_confirmed: r.date_confirmed === true || r.date_confirmed === "t" }));
  const simRows: SimFinishRow[] = gs.map((r: any) => ({ code: r.team_code, name: r.team_name, group: r.group_code, p1: num(r.f1), p2: num(r.f2), p3: num(r.f3), bestThird: num(r.bt) }));
  const pf = buildProjectedFinishers(simRows);
  const knockout_paths = gs.map((r: any) => ({ code: r.team_code, group: r.group_code, ...resolveTeamPath(r.group_code, r32rows, pf) }))
    .sort((a, b) => a.group.localeCompare(b.group) || a.code.localeCompare(b.code));

  // knockout_fixtures: ALL 32 knockout matches (R32 -> Final) as SLOT-LABEL cards (no teams until the post-group
  // bracket resolver fills them). Slot definitions are read VERBATIM from knockout_schedule — group_winner/runner_up
  // carry the group letter, best_third carries the REAL Annex C eligible-group pool for THAT slot, later rounds carry
  // the source match number. Each side has team:null as the forward-compat hook (resolver fills the real team later).
  // The UI renders these alongside the group fixtures and they share the city filter. No prediction (slots, not teams).
  const KO_ROUND: Record<string, { label: string; order: number }> = {
    round_of_32: { label: "Round of 32", order: 1 }, round_of_16: { label: "Round of 16", order: 2 },
    quarter_final: { label: "Quarter-finals", order: 3 }, semi_final: { label: "Semi-finals", order: 4 },
    third_place: { label: "Third-place play-off", order: 5 }, final: { label: "Final", order: 6 },
  };
  const MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const fmtWindow = (w: string | null): string | null => {
    if (!w) return null;
    const m = w.match(/(\d{4})-(\d{2})-(\d{2})(?:\s+to\s+(\d{4})-(\d{2})-(\d{2}))?/);
    if (!m) return w;
    const a = `${MON3[+m[2] - 1]} ${+m[3]}`;
    if (!m[4]) return a;
    const b = m[5] === m[2] ? `${+m[6]}` : `${MON3[+m[5] - 1]} ${+m[6]}`;
    return `${a} – ${b}`;
  };
  const koSide = (label: string | null, slot: any) => {
    const s = asObj(slot) ?? {};
    return {
      label: label ?? s.label ?? null,
      type: s.type ?? null,                                    // group_winner | group_runner_up | best_third | match_winner | match_loser
      group: s.group ?? null,                                  // winner / runner-up group letter
      pool: Array.isArray(s.pool) ? s.pool.map(String) : null, // best_third eligible groups (Annex C), real per slot
      source_match: s.match != null ? num(s.match) : null,     // progression source match (R16 onward)
      team: null,                                              // forward-compat: real team filled by the bracket resolver
    };
  };
  const koRaw = q(url, `select match_number, round, slot_a_label, slot_b_label, slot_a, slot_b, venue, city, country, venue_timezone, round_window,
      match_date::text mdate, to_char(kickoff_utc at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') kutc, date_confirmed
    from knockout_schedule order by match_number`);
  const knockout_fixtures = koRaw.map((r: any) => {
    const ro = KO_ROUND[r.round] ?? { label: humanScope(r.round), order: 9 };
    return {
      match_number: num(r.match_number), round: ro.label, round_key: r.round, round_order: ro.order,
      round_window: r.round_window ?? null, round_window_label: fmtWindow(r.round_window ?? null),
      side_a: koSide(r.slot_a_label, r.slot_a), side_b: koSide(r.slot_b_label, r.slot_b),
      kickoff: r.mdate ?? null, kickoff_utc: r.kutc ?? null, date_confirmed: r.date_confirmed === true || r.date_confirmed === "t",
      venue: r.venue ?? null, city: r.city ?? null, country: r.country ?? null, venue_timezone: r.venue_timezone ?? null,
    };
  });

  const appData = { meta, teams, groups, fixtures, knockout_fixtures, team_paths, scenarios, narration, tactical_context, real_standings, knockout_paths };

  // ============ VALIDATE BEFORE WRITING ============
  const errs: string[] = [];
  const contract = JSON.parse(readFileSync(path.join(rootDir, CONTRACT), "utf8"));
  validateShape(appData, contract, "$", errs);

  // sums (12 / 12 / 24 / 8 / 32)
  const sum = (f: (r: any) => number) => +gs.reduce((s, r) => s + f(r), 0).toFixed(3);
  const sums = { win_group: sum((r) => num(r.wg)), runner_up: sum((r) => num(r.f2)), top_2: sum((r) => num(r.t2)), best_third: sum((r) => num(r.bt)), advance: sum((r) => num(r.adv)) };
  const sumOk = (got: number, want: number, tol = 0.06) => Math.abs(got - want) <= tol;
  if (!sumOk(sums.win_group, 12)) errs.push(`sum win_group ${sums.win_group} != 12`);
  if (!sumOk(sums.runner_up, 12)) errs.push(`sum runner_up ${sums.runner_up} != 12`);
  if (!sumOk(sums.top_2, 24)) errs.push(`sum top_2 ${sums.top_2} != 24`);
  if (!sumOk(sums.best_third, 8)) errs.push(`sum best_third ${sums.best_third} != 8`);
  if (!sumOk(sums.advance, 32)) errs.push(`sum advance ${sums.advance} != 32`);
  if (teams.length !== 48) errs.push(`teams ${teams.length} != 48`);
  if (fixtures.length !== 72) errs.push(`fixtures ${fixtures.length} != 72`);
  if (knockout_fixtures.length !== 32) errs.push(`knockout_fixtures ${knockout_fixtures.length} != 32`);

  // ID-leak scan on the serialized output
  const jsonStr = JSON.stringify(appData, null, 2);
  const leaks = idLeakScan(jsonStr);
  if (leaks.length) errs.push(`ID-LEAK: ${leaks.join(" | ")}`);

  const report = { project_id: PROJECT, source_of_truth: pointerLive ? LIVE_POINTER : "lifecycle=live_current markers", source_labels: SRC, as_of: meta.generated_at, sums, sum_check_pass: errs.filter((e) => e.startsWith("sum")).length === 0, id_leak_scan: leaks.length === 0 ? "CLEAN" : leaks, counts: { teams: teams.length, teams_with_flags: teams.filter((t) => t.flag).length, groups: groups.length, fixtures: fixtures.length, knockout_fixtures: knockout_fixtures.length, team_paths: team_paths.length, scenarios: scenarios.length, tactical: tactical_context.length, narration: narration.length }, contract_errors: errs };
  if (errs.length) { console.error(JSON.stringify({ ...report, RESULT: "VALIDATION FAILED — NOT WRITTEN" }, null, 2)); process.exit(1); }

  mkdirSync(path.join(rootDir, "data/exports"), { recursive: true });
  writeFileSync(path.join(rootDir, OUT), jsonStr, "utf8");
  for (const uiOut of UI_OUTS) {
    mkdirSync(path.dirname(path.join(rootDir, uiOut)), { recursive: true });
    copyFileSync(path.join(rootDir, OUT), path.join(rootDir, uiOut));
  }
  console.log(JSON.stringify({ ...report, RESULT: "OK — wrote " + OUT, narration_note: narration.length ? "validated narration present" : "no narration table -> narration: [] (not a failure)", canada_sample: { group: groups.find((g) => g.group === "B"), path: team_paths.find((t) => t.code === "CAN"), scenario: scenarios.find((s) => s.code === "CAN"), tactical: tactical_context.find((t) => t.code === "CAN") } }, null, 2));
}
main().catch((e) => { console.error("ERROR:", e?.message ?? e); process.exit(1); });
