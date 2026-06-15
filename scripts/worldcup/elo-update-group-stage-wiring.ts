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

// ---- idempotency plan (pure; unit-tested via --unit-test) ----
// Decides what the writer should do given how many candidate rows ALREADY exist for THIS tag+date:
//   exactly `expected` (48) -> "guard": snapshot already present -> skip insert, exit 0 (keeps learnedEloReady TRUE)
//   0                       -> "write": first write -> insert the 48 rows (unchanged behavior)
//   anything else (1..47)   -> "partial": a prior write was incomplete -> do NOT skip, do NOT double-insert (409);
//                              surface + fail so a human reviews (the runner falls back to FROZEN meanwhile — safe).
// Pure: no DB, no I/O. The count query + insert stay in main(); messages live here so they are single-sourced and
// the guard/write lines are GUARANTEED free of the "GRACEFUL WAIT" phrase the runner greps to compute eloGracefulWait.
export type CandidatePlan = { action: "write" | "guard" | "partial"; exit0: boolean; lines: string[] };
export function planCandidateWrite(candAtDate: number, expected: number, tag: string, lastDate: string): CandidatePlan {
  if (candAtDate === expected) return {
    action: "guard", exit0: true,
    lines: [
      `\nALREADY PRESENT — learned K=60 snapshot ready (${candAtDate} rows, tag ${tag}, date ${lastDate}). Idempotent: skipping insert, 0 writes.`,
      `learned end-of-group Elo stays consumable by the knockout bracket (tag ${tag}); learnedEloReady remains TRUE.`,
    ],
  };
  if (candAtDate === 0) return {
    action: "write", exit0: true,
    lines: [`\nFIRST WRITE — no ${tag} rows exist yet for ${lastDate}; inserting ${expected} (additive).`],
  };
  return {
    action: "partial", exit0: false,
    lines: [`PARTIAL candidate snapshot: ${candAtDate}/${expected} rows already exist for ${tag}@${lastDate} — refusing to skip (incomplete) or double-insert (would 409). Manual review needed.`],
  };
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

  // ---- IDEMPOTENCY GUARD (runs every cycle; the only thing that changed) ----
  // The loop runs this writer on EVERY material cycle. Once 72/72 holds, `lastDate` is stable, so a naive re-run
  // recomputes the SAME 48 rows with the SAME unique key. team_elo_history has UNIQUE index
  // (source_provider, elo_name, rating_date) and restInsert is a plain POST (no upsert), so the 2nd cycle would
  // 409 -> throw -> exit(1) -> runner learnedEloReady=false -> knockouts silently revert to FROZEN Elo. The guard
  // checks the EXACT count for this tag+date: 48 -> already present (skip, exit 0); 0 -> first write; else partial.
  const candAtDate = dec(q<{ n: number }>(c, `select count(*) n from team_elo_history where source_provider='${SOURCE_TAG}' and rating_date = date '${lastDate}'`)[0].n);
  const plan = planCandidateWrite(candAtDate, snapshotRows.length, SOURCE_TAG, lastDate);
  if (plan.action === "partial") throw new Error(plan.lines[0]);
  if (plan.action === "guard") {
    for (const l of plan.lines) console.log(l);
    const frozenIntactG = dec(q<{ n: number }>(c, `select count(*) n from team_elo_history where source_provider='${PRETOURNAMENT_SOURCE}'`)[0].n);
    console.log(`protected counts: ${SOURCE_TAG} rows total=${candBefore} (unchanged) | pre-tournament(${PRETOURNAMENT_SOURCE}) rows=${frozenIntactG} (intact: ${frozenIntactG === 19300}) | DB writes: 0`);
    return; // exit 0 -> learnedEloReady stays TRUE -> bracket keeps consuming the K=60 tag
  }
  for (const l of plan.lines) console.log(l); // action === "write" — no candidate rows exist yet for this tag+date

  if (!args.execute) {
    console.log(`DRY-RUN: would insert ${snapshotRows.length} ${SOURCE_TAG} snapshots (additive). 0 writes now.`);
    console.log(`protected counts: team_elo_history ${tehBefore} (would -> ${tehBefore + snapshotRows.length}); pre-tournament snapshot untouched.`);
    return;
  }
  // ---- EXECUTE (gated; first write only — guard above already handled the already-present case) ----
  console.log(`PROJECT ID: ${c.projectRef} — WRITING ${snapshotRows.length} ${SOURCE_TAG} snapshots (additive; pre-tournament snapshot untouched).`);
  const inserted = await restInsert(c, snapshotRows);
  const tehAfter = dec(q<{ n: number }>(c, `select count(*) n from team_elo_history`)[0].n);
  const candAfter = dec(q<{ n: number }>(c, `select count(*) n from team_elo_history where source_provider='${SOURCE_TAG}'`)[0].n);
  const frozenIntact = dec(q<{ n: number }>(c, `select count(*) n from team_elo_history where source_provider='${PRETOURNAMENT_SOURCE}'`)[0].n);
  console.log(`INSERTED ${inserted}. team_elo_history ${tehBefore}->${tehAfter} (+${tehAfter - tehBefore}); ${SOURCE_TAG} ${candBefore}->${candAfter}; pre-tournament(${PRETOURNAMENT_SOURCE}) rows=${frozenIntact} (unchanged: ${frozenIntact === 19300}).`);
}
// ---- guard unit test (no DB; simulates the post-72 cycle 1 -> cycle 2 transition) ----
// Run:  npx tsx scripts/worldcup/elo-update-group-stage-wiring.ts --guard-test
// (distinct flag: the imported elo-update-engine has its own --unit-test block that would exit on import.)
function runGuardUnitTest(): boolean {
  const TAG = SOURCE_TAG, DATE = "2026-06-27", N = allTeams.length; // expected rows = 48 teams (== snapshotRows.length in main)
  console.log("=== K=60 writer idempotency guard — unit test (no DB) ===");
  const cases: Array<{ name: string; cand: number; action: CandidatePlan["action"]; exit0: boolean }> = [
    { name: "no rows yet -> first write", cand: 0, action: "write", exit0: true },
    { name: "exactly 48 -> guard (already present)", cand: 48, action: "guard", exit0: true },
    { name: "partial 1/48 -> partial (throw, no double-insert)", cand: 1, action: "partial", exit0: false },
    { name: "partial 47/48 -> partial (throw)", cand: 47, action: "partial", exit0: false },
    { name: "over 48 (defensive) -> partial", cand: 49, action: "partial", exit0: false },
  ];
  let pass = true;
  for (const c of cases) {
    const p = planCandidateWrite(c.cand, N, TAG, DATE);
    const ok = p.action === c.action && p.exit0 === c.exit0;
    if (!ok) pass = false;
    console.log(`  [${ok ? "OK" : "XX"}] cand=${String(c.cand).padStart(2)}/48 -> action=${p.action.padEnd(7)} exit0=${p.exit0}  (${c.name})`);
  }
  // The crux: simulate the runner across two consecutive post-72 cycles and prove learnedEloReady stays TRUE.
  // Runner logic: elo.ok = (exit code 0); eloGracefulWait = /GRACEFUL WAIT/i.test(stdout); learnedEloReady = elo.ok && !eloGracefulWait.
  const cycle1 = planCandidateWrite(0, N, TAG, DATE);   // first post-72 cycle: rows do not exist yet -> write
  const cycle2 = planCandidateWrite(N, N, TAG, DATE);   // next material cycle: 48 rows now exist -> guard
  const learnedReady = (plan: CandidatePlan) => plan.exit0 && !/GRACEFUL WAIT/i.test(plan.lines.join("\n"));
  const checks: Array<[string, boolean]> = [
    ["cycle 1 -> write (inserts the snapshot)", cycle1.action === "write"],
    ["cycle 2 -> guard (NO duplicate insert / 409)", cycle2.action === "guard"],
    ["cycle 1 learnedEloReady = TRUE", learnedReady(cycle1) === true],
    ["cycle 2 learnedEloReady = TRUE (stays learned — bug fixed)", learnedReady(cycle2) === true],
    ["guard output contains no 'GRACEFUL WAIT' phrase", !/GRACEFUL WAIT/i.test(cycle2.lines.join("\n"))],
  ];
  for (const [label, ok] of checks) { if (!ok) pass = false; console.log(`  [${ok ? "OK" : "XX"}] ${label}`); }
  return pass;
}
if (process.argv.includes("--guard-test")) {
  const ok = runGuardUnitTest();
  console.log("\nGUARD UNIT TEST:", ok ? "PASS — idempotent: cycle 1 writes, cycle 2+ guard, learnedEloReady stays TRUE (knockouts keep K=60)." : "FAIL");
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("ERROR:", e?.message ?? e); process.exit(1); });
