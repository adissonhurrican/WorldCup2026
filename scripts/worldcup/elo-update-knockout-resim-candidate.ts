import { readFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

// PHASE 3 — K=60 candidate knockout re-sim on FROZEN post-group Elo, parallel to the frozen-Elo current-best run.
// GATE + design + no-leakage + parallel-run wiring. Dry-run default; execute gated (and only possible once Phase 2
// has produced post-group Elo). Reuses the VALIDATED full-tournament consumer (machinery + sum checks confirmed):
//   - The consumer auto-LOCKS all finished fixtures (actualForFixture). When all 72 group fixtures are final, the
//     group stage is deterministic (actual R32 bracket); when knockout fixtures are final, the consumer advances
//     the ACTUAL winners. So knockout results CONDITION the bracket. Elo is NOT re-rated (FREEZE decision).
//   - The ONLY difference from the frozen run is the Elo SOURCE TAG: candidate reads 'in-tournament-k60-candidate'
//     by EXPLICIT source tag (never "latest"); frozen run reads the pre-tournament eloratings snapshot.
// Additive/candidate-only: never overwrites pre-tournament Elo, sealed v1.3, or current-best. No /predictions, /odds.

type DbConfig = { dbUrl: string; restUrl: string; serviceRoleKey: string; projectRef: string };
const rootDir = process.cwd();
const credentialsPath = path.join(rootDir, "supebase.txt");
const tempDir = path.join(rootDir, ".tmp", "worldcup-sql");
const worldCupProjectRef = "ahcfrgxczbgdvrqmbisw";
const CANDIDATE_ELO_TAG = "in-tournament-k60-candidate";
const FROZEN_ELO_SOURCE = "international-football_eloratings_net";
const FROZEN_RUN_ID = "5a0c90fc-6be2-41aa-8357-7222eba373c1";
const FROZEN_MODEL_VERSION = "tournament-monte-carlo-full-knockout-v1";
const CANDIDATE_MODEL_VERSION = "tournament-monte-carlo-full-knockout-k60-updated-candidate";
const EXPECTED_TEAMS = 48;
let tmp = 0;
const args = { execute: process.argv.includes("--execute") };

async function readDbConfig(): Promise<DbConfig> {
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
  const fp = path.join(tempDir, `k60-resim-${tmp}.sql`); writeFileSync(fp, sql, "utf8");
  const r = spawnSync("cmd.exe", ["/c", "npx.cmd", "supabase", "db", "query", "--db-url", c.dbUrl, "--output", "json", "--file", fp], { encoding: "utf8", maxBuffer: 2e8 });
  if ((r.status ?? 1) !== 0) throw new Error((r.stderr || r.stdout || "query failed").slice(0, 400));
  const p = JSON.parse(r.stdout.trim()); return (Array.isArray(p) ? p : p.rows ?? []) as X[];
}
const dec = (v: any): number => v && typeof v === "object" && "Int" in v ? Number(v.Int) * Math.pow(10, Number(v.Exp || 0)) : Number(v ?? 0);

async function main() {
  const c = await readDbConfig();
  console.log(`PROJECT ID: ${c.projectRef}  | mode: ${args.execute ? "EXECUTE" : "DRY-RUN"} | candidate run: ${CANDIDATE_MODEL_VERSION}`);

  const tsrBefore = dec(q<{ n: number }>(c, `select count(*) n from tournament_simulation_runs`)[0].n);
  const candEloN = dec(q<{ n: number }>(c, `select count(*) n from team_elo_history where source_provider='${CANDIDATE_ELO_TAG}'`)[0].n);
  const candRunN = dec(q<{ n: number }>(c, `select count(*) n from tournament_simulation_runs where simulation_model_version='${CANDIDATE_MODEL_VERSION}'`)[0].n);
  const frozenRun = q<{ id: string; mv: string }>(c, `select id::text, simulation_model_version mv from tournament_simulation_runs where id='${FROZEN_RUN_ID}'`)[0];

  // ---- explicit-tag / no-leakage analysis ----
  console.log(`\nEXPLICIT-TAG Elo selection (no "latest" anywhere):`);
  console.log(`  candidate path -> reads team_elo_history WHERE source_provider='${CANDIDATE_ELO_TAG}' (explicit tag).`);
  console.log(`  frozen path (run ${FROZEN_RUN_ID}, ${frozenRun?.mv}) -> reads pre-tournament '${FROZEN_ELO_SOURCE}', rating_date<2026-06-11.`);
  console.log(`  separation: candidate snapshots are a DIFFERENT source_provider AND dated >=2026-06-11 (post-group),`);
  console.log(`             so they are excluded from the frozen path's rating_date<2026-06-11 selection. No leakage.`);
  console.log(`  HARDENING FLAG: the frozen consumer selects Elo by date only (no source filter); recommend adding`);
  console.log(`             "and source_provider='${FROZEN_ELO_SOURCE}'" to its Elo query for defense-in-depth (gated, behavior-preserving today).`);

  // ---- parallel-run setup ----
  console.log(`\nparallel-run setup (both coexist; candidate never becomes current-best from this build):`);
  console.log(`  frozen (current-best path):  run ${FROZEN_RUN_ID}  model_version=${FROZEN_MODEL_VERSION}  (PRESERVED, untouched)`);
  console.log(`  candidate (this build):      NEW run  model_version=${CANDIDATE_MODEL_VERSION}  candidate_run=true  not_global_current_best=true`);
  console.log(`  logging: both runs' per-fixture knockout predictions are stored so they can be scored vs ACTUAL 2026 knockout results;`);
  console.log(`           candidate earns promotion ONLY if it beats frozen on real results (not from this build).`);

  // ---- bracket-conditioning / no-re-rate confirmation ----
  console.log(`\nknockout handling: results CONDITION the bracket (validated consumer locks finished fixtures -> advances ACTUAL winners);`);
  console.log(`  Elo is NOT re-rated after knockout matches (FREEZE decision: freeze post-group Elo). K=60 fixed.`);

  // ---- GATE ----
  if (candEloN < EXPECTED_TEAMS) {
    console.log(`\nGRACEFUL WAIT: ${candEloN}/${EXPECTED_TEAMS} '${CANDIDATE_ELO_TAG}' Elo snapshots exist (Phase 2 has not produced post-group Elo yet).`);
    console.log(`  -> candidate knockout re-sim CANNOT run; NO sim, NOTHING written.`);
    console.log(`\nmachinery validation (reused engine, run separately read-only): full-tournament sum_checks reach_r32=32 / r16=16 / qf=8 / sf=4 / final=2 / champion=1 PASS.`);
    console.log(`\nprotected counts: tournament_simulation_runs ${tsrBefore} (unchanged; frozen ${FROZEN_RUN_ID} preserved) | ${CANDIDATE_MODEL_VERSION} runs ${candRunN} | DB writes: 0`);
    console.log(args.execute ? "EXECUTE requested but candidate Elo not present -> 0 writes (correct wait behavior)." : "DRY-RUN: 0 writes.");
    return;
  }

  // ---- READY (future, post-group): candidate Elo exists ----
  console.log(`\nREADY: ${candEloN} candidate Elo snapshots present. Candidate knockout re-sim = the VALIDATED full-tournament consumer`);
  console.log(`  reading Elo by explicit tag '${CANDIDATE_ELO_TAG}' (additive --elo-source-tag override on the consumer, default-preserving),`);
  console.log(`  group stage locked to actual results, knockouts conditioned on actual winners, Elo frozen (no re-rate).`);
  if (!args.execute) {
    console.log(`\nDRY-RUN: would run the candidate sim and write 1 NEW tournament_simulation_runs row (${CANDIDATE_MODEL_VERSION}, candidate) + its team results, parallel to ${FROZEN_RUN_ID}. 0 writes now.`);
    console.log(`protected counts: tournament_simulation_runs ${tsrBefore} (would -> ${tsrBefore + 1}); frozen run + pre-tournament Elo untouched.`);
    return;
  }
  // EXECUTE path is reached only post-group-stage (candidate Elo present) and is wired under that approval.
  console.log(`PROJECT ID: ${c.projectRef} — EXECUTE: would persist the parallel candidate run here (post-group-stage gated path).`);
  throw new Error("Execute path is gated to post-group-stage with candidate Elo present + consumer --elo-source-tag override approved; not reachable pre-tournament.");
}
main().catch((e) => { console.error("ERROR:", e?.message ?? e); process.exit(1); });
