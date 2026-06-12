import { readFile } from "node:fs/promises";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { Aux } from "./tiebreaker-ladders-2026";
import { runGroupSim, buildDocument, condDists, lockKey, GROUPS, GROUP_KEYS, teamGroup, ALL_TEAMS, r4, type Fixture, type Locked } from "./advancement-scenario-core";

// P0b Phase 2 — LIVE advancement-scenario-v1: after each VERIFIED result, re-compute every team's scenario
// conditioned on results-so-far and store it as a NEW append-only row (phase='live', as_of_result_count=N) — never
// overwriting the pre-tournament row or prior live rows (unique key: run, version, phase, as_of_result_count).
// Reads ONLY verified results (the K=60 gate). Corrected Article-13 ladder. Probabilities come from the conditioned
// re-sim (consistent-with-sim). Modes: default=live update (no-op while 0 verified results), --synthetic-test
// (in-memory Canada arc, NO DB writes), --regression (core reproduces cfdc88ca), --execute (store live row if N>=1).

type DbConfig = { dbUrl: string; restUrl: string; serviceRoleKey: string; projectRef: string };
const rootDir = process.cwd();
const credentialsPath = path.join(rootDir, "supebase.txt");
const tempDir = path.join(rootDir, ".tmp", "worldcup-sql");
const worldCupDevProjectRef = "ahcfrgxczbgdvrqmbisw";
const SOURCE_PRED_RUN = "066be1b1-de89-44de-8b7c-c95f4353ad7e"; // PROMOTED live group predictions (dynamic-draw); was 85555853
const SOURCE_SIM_RUN = "c45b3e6a-f2c3-43f4-bade-65dc1fd0e195"; // PROMOTED live group sim (dynamic-draw); was cfdc88ca
const FIFA_SNAPSHOT = "2026-06-11" /* pre-WC FIFA edition published 2026-06-11; prior pins: 2026-04-01 (kept additively in fifa_world_rankings) */; const SEED = 20260602; const N = 20000;
const SCHEMA_VERSION = "advancement-scenario-v1"; const LADDER_VERSION = "fifa-2026-article-13-v1";
const args = process.argv;
const MODE = args.includes("--synthetic-test") ? "synthetic" : args.includes("--regression") ? "regression" : "live";
const execute = args.includes("--execute");
let tmp = 0;

async function readDbConfig(): Promise<DbConfig> {
  // CI-first: use env creds (SUPABASE_DB_URL + SUPABASE_SERVICE_ROLE_KEY) so this works on GitHub Actions where
  // supebase.txt is absent. Fall back to the local supebase.txt file when env is unset (local runs unchanged).
  const envDbUrl = process.env.SUPABASE_DB_URL;
  const envServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (envDbUrl && envServiceRoleKey) {
    const projectRef = envDbUrl.match(/postgres\.([a-z0-9]+):/)?.[1] ?? envDbUrl.match(/\/\/([^.]+)\.supabase\.co/)?.[1] ?? "";
    if (projectRef !== worldCupDevProjectRef) throw new Error(`Unexpected project ref from SUPABASE_DB_URL: ${projectRef || "unknown"}`);
    return { projectRef, restUrl: `https://${projectRef}.supabase.co/rest/v1`, serviceRoleKey: envServiceRoleKey, dbUrl: envDbUrl };
  }
  const text = await readFile(credentialsPath, "utf8");
  const projectRef = text.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];
  const password = text.match(/supebase password\s*:\s*(\S+)/i)?.[1];
  const restUrl = text.match(/https:\/\/[^\s]+\/rest\/v1\/?/)?.[0]?.replace(/\/$/, "");
  const serviceRoleKey = text.match(/service role secret\s*:\s*(\S+)/i)?.[1];
  if (projectRef !== worldCupDevProjectRef) throw new Error(`Unexpected project ref: ${projectRef ?? "unknown"}`);
  if (!password || !restUrl || !serviceRoleKey) throw new Error("Missing credentials");
  return { projectRef, restUrl, serviceRoleKey, dbUrl: `postgresql://postgres.${projectRef}:${encodeURIComponent(password)}@aws-1-us-west-1.pooler.supabase.com:5432/postgres` };
}
function runSql<X = any>(dbUrl: string, sql: string, allowMutate = false): X[] {
  if (!allowMutate && /\b(insert|update|delete|drop|alter|truncate|create)\b/i.test(sql.replace(/'[^']*'/g, ""))) throw new Error("read helper refuses mutating SQL");
  mkdirSync(tempDir, { recursive: true }); tmp += 1;
  const fp = path.join(tempDir, `live-${tmp}.sql`); writeFileSync(fp, sql, "utf8");
  const r = process.platform === "win32"
    ? spawnSync("cmd.exe", ["/c", "npx.cmd", "supabase", "db", "query", "--db-url", dbUrl, "--output", "json", "--file", fp], { encoding: "utf8", maxBuffer: 2e8 })
    : spawnSync("npx", ["supabase", "db", "query", "--db-url", dbUrl, "--output", "json", "--file", fp], { encoding: "utf8", maxBuffer: 2e8 });
  if ((r.status ?? 1) !== 0) throw new Error((r.stderr || r.stdout || "").slice(0, 400));
  const out = r.stdout.trim(); if (!out) return []; const p = JSON.parse(out); return (Array.isArray(p) ? p : p.rows ?? p) as X[];
}
function execSql(dbUrl: string, sql: string): string { // DDL/DML returning no rows: no --output json, no parse
  mkdirSync(tempDir, { recursive: true }); tmp += 1;
  const fp = path.join(tempDir, `live-ddl-${tmp}.sql`); writeFileSync(fp, sql, "utf8");
  const r = process.platform === "win32"
    ? spawnSync("cmd.exe", ["/c", "npx.cmd", "supabase", "db", "query", "--db-url", dbUrl, "--file", fp], { encoding: "utf8", maxBuffer: 2e8 })
    : spawnSync("npx", ["supabase", "db", "query", "--db-url", dbUrl, "--file", fp], { encoding: "utf8", maxBuffer: 2e8 });
  if ((r.status ?? 1) !== 0) throw new Error(`execSql failed: ${(r.stderr || r.stdout || "").slice(0, 400)}`);
  return `${r.stdout ?? ""}`.trim();
}
function dec(v: any): number | null { if (v === null || v === undefined) return null; if (typeof v === "number") return v; if (typeof v === "string") { const n = Number(v); return Number.isNaN(n) ? null : n; } if (typeof v === "object") { if ("Int" in v) return Number(v.Int) * Math.pow(10, Number(v.Exp ?? 0)); } return Number(v); }
const num = (v: any) => dec(v) ?? 0;

// VERIFIED group-result reader — mirrors the K=60 gate EXACTLY (finished + fixture-ID + hash + not-rejected + group)
const VERIFIED_RESULTS_SQL = `select fixture_label, team_a_code, team_b_code, team_a_goals::int ga, team_b_goals::int gb, coalesce(finished_at, kickoff_at) result_time
from match_results
where tournament_code='WC_2026' and match_status='finished' and api_football_fixture_id is not null
  and source_payload_hash is not null and coalesce(review_status,'') <> 'rejected'
  and (fixture_metadata_id in (select id from fixture_metadata where tournament_code='WC_2026') or round_name ilike 'group%')
order by coalesce(finished_at, kickoff_at), fixture_label`;

async function loadInputs(config: DbConfig) {
  const rawPreds = runSql(config.dbUrl, `select fixture_label, team_a_code a, team_b_code b, team_a_win_probability::float8 pa, draw_probability::float8 pd, team_b_win_probability::float8 pb, (scoreline_probabilities->>'lambda_a')::float8 la, (scoreline_probabilities->>'lambda_b')::float8 lb from match_predictions where prediction_run_id='${SOURCE_PRED_RUN}' order by fixture_label`);
  if ((rawPreds as any[]).length !== 72) throw new Error(`expected 72 predictions, got ${(rawPreds as any[]).length}`);
  const fixtures: Fixture[] = (rawPreds as any[]).map((r) => { const cd = condDists(num(r.la), num(r.lb)); return { label: r.fixture_label, a: r.a, b: r.b, group: teamGroup[r.a], pa: num(r.pa), pd: num(r.pd), pb: num(r.pb), condA: cd.A, condD: cd.D, condB: cd.B, cA: cd.cA, cD: cd.cD, cB: cd.cB }; });
  const frRows = runSql(config.dbUrl, `select team_code, fifa_rank from fifa_world_rankings where ranking_snapshot_date='${FIFA_SNAPSHOT}'`);
  const fifaRank: Record<string, number> = {}; for (const r of frRows as any[]) fifaRank[r.team_code] = num(r.fifa_rank);
  const aux: Aux = { fairPlay: {}, fifaRank };
  const teamRows = runSql(config.dbUrl, `select fifa_code, name, id::text id from teams`);
  const teamName: Record<string, string> = {}; const teamId: Record<string, string> = {};
  for (const t of teamRows as any[]) { teamName[t.fifa_code] = t.name; teamId[t.fifa_code] = t.id; }
  const storedRows = runSql(config.dbUrl, `select team_code, finish_1st_probability::float8 p1, finish_2nd_probability::float8 p2, finish_3rd_probability::float8 p3, finish_4th_probability::float8 p4, win_group_probability::float8 wg, advance_top_2_probability::float8 t2, reach_round_of_32_probability::float8 adv, source_snapshot from tournament_simulation_team_results where simulation_run_id='${SOURCE_SIM_RUN}'`);
  const stored: any = {}; for (const r of storedRows as any[]) { const ss = r.source_snapshot || {}; stored[r.team_code] = { p1: num(r.p1), p2: num(r.p2), p3: num(r.p3), p4: num(r.p4), wg: num(r.wg), t2: num(r.t2), adv: num(r.adv), bestThird: num(ss.advance_as_best_third_probability), eliminated: num(ss.eliminated_group_stage_probability) }; }
  return { fixtures, fifaRank, aux, teamName, teamId, stored };
}
const baseOpts = (extra: any) => ({ aux: extra.aux, fifaRank: extra.fifaRank, teamName: extra.teamName, sourceSimRun: SOURCE_SIM_RUN, sourcePredRun: SOURCE_PRED_RUN, fifaSnapshot: FIFA_SNAPSHOT, ladderVersion: LADDER_VERSION, schemaVersion: SCHEMA_VERSION, seed: SEED });

function verifyDoc(v: any): string[] {
  const errs: string[] = [];
  if (v.team_count !== 48) errs.push(`team_count ${v.team_count} != 48`);
  if (Math.abs(v.sum_advance_total - 32) > 0.05) errs.push(`Σadvance ${v.sum_advance_total} != 32`);
  if (Math.abs(v.sum_top2 - 24) > 0.05) errs.push(`Σtop2 ${v.sum_top2} != 24`);
  if (Math.abs(v.sum_win_group - 12) > 0.05) errs.push(`Σwin ${v.sum_win_group} != 12`);
  if (v.max_advance_total_decomp_err > 0.002) errs.push(`advance decomp err ${v.max_advance_total_decomp_err}`);
  if (v.best_third_le_third_violation > 0.002) errs.push(`best_third>third ${v.best_third_le_third_violation}`);
  return errs;
}
const canSummary = (doc: any) => { const c = doc.teams.CAN; const bt = c.what_they_need.find((w: any) => w.condition_label === "Advance as best third"); return { played: c.current_standing.played, cur_pts: c.current_standing.pts, cur_pos: c.current_standing.position, win: c.probabilities.win_group, ru: c.probabilities.runner_up, p3: c.probabilities.finish_third, p4: c.probabilities.finish_fourth, third_adv: c.probabilities.third_place_advance, advance: c.probabilities.advance_total, elim: c.probabilities.eliminated, pass_cut: c.third_place_dependency.passes_cutoff_in_pct, comp: c.third_place_dependency.competing_third_groups, needs: c.third_place_dependency.needs, wtn: c.what_they_need.map((w: any) => `${w.condition_label} (${w.scenario_weight}): ${w.own_results_needed}`) }; };

function crossGroupIsolation(base: any, cond: any, affectedGroup: string) {
  let maxWinDelta = 0, maxTop2Delta = 0; const movers: string[] = []; let nonAffectedCount = 0;
  for (const t of ALL_TEAMS) {
    if (teamGroup[t] === affectedGroup) continue; nonAffectedCount++;
    const b = base.teams[t].probabilities, c = cond.teams[t].probabilities;
    maxWinDelta = Math.max(maxWinDelta, Math.abs(c.win_group - b.win_group));
    maxTop2Delta = Math.max(maxTop2Delta, Math.abs((c.win_group + c.runner_up) - (b.win_group + b.runner_up)));
    if (Math.abs(c.advance_total - b.advance_total) > 0.002) movers.push(`${t} ${r4(c.advance_total - b.advance_total)}`);
  }
  return { affected_group: affectedGroup, non_affected_teams: nonAffectedCount, max_win_group_delta: r4(maxWinDelta), max_top2_delta: r4(maxTop2Delta), win_top2_exactly_isolated: maxWinDelta === 0 && maxTop2Delta === 0, advance_movers_via_third_pool: movers.length, examples: movers.slice(0, 8) };
}

async function main() {
  const config = await readDbConfig();
  console.log(`PROJECT ID: ${config.projectRef} | mode: ${MODE}${execute ? " + EXECUTE" : ""} | model: ${SCHEMA_VERSION} (live)`);
  const inputs = await loadInputs(config);

  // ===== REGRESSION: core@locked={} must reproduce cfdc88ca (probabilities) =====
  if (MODE === "regression") {
    const sim = runGroupSim(inputs.fixtures, inputs.aux, { seed: SEED, N, locked: {} });
    const { document, verification } = buildDocument({ ...baseOpts(inputs), sim, locked: {}, phase: "pre_tournament", resultCount: 0, storedOverlay: inputs.stored });
    const errs = verifyDoc(verification);
    let phase1Match: any = "preview-not-found";
    const prev = path.join(rootDir, "data/audits/advancement-scenario-v1-pretournament-preview.json");
    if (existsSync(prev)) { const p1 = JSON.parse(readFileSync(prev, "utf8")); const a = p1.teams.CAN.probabilities, b = document.teams.CAN.probabilities; phase1Match = { CAN_advance_phase1: a.advance_total, CAN_advance_core: b.advance_total, identical: JSON.stringify(a) === JSON.stringify(b) }; }
    console.log(JSON.stringify({ regression: true, reproduces_cfdc88ca: verification.stored_overlay_max_drift !== null && verification.stored_overlay_max_drift < 0.0005, stored_overlay_max_drift: verification.stored_overlay_max_drift, drifters: verification.stored_overlay_drifters, verification, phase1_preview_match: phase1Match, errors: errs }, null, 2));
    return;
  }

  // ===== SYNTHETIC TEST: in-memory Canada arc, NO DB writes =====
  if (MODE === "synthetic") {
    const mk = (m: Record<string, Record<string, number>>): Locked => { const o: Locked = {}; for (const k of Object.keys(m)) o[k] = m[k]; return o; };
    const step1 = mk({ [lockKey("CAN", "BIH")]: { CAN: 0, BIH: 1 } });
    const step2 = mk({ [lockKey("CAN", "BIH")]: { CAN: 0, BIH: 1 }, [lockKey("CAN", "QAT")]: { CAN: 2, QAT: 0 } });
    const full = mk({ [lockKey("CAN", "BIH")]: { CAN: 0, BIH: 1 }, [lockKey("CAN", "QAT")]: { CAN: 2, QAT: 0 }, [lockKey("CAN", "SUI")]: { CAN: 0, SUI: 2 }, [lockKey("BIH", "SUI")]: { BIH: 1, SUI: 1 }, [lockKey("BIH", "QAT")]: { BIH: 2, QAT: 0 }, [lockKey("SUI", "QAT")]: { SUI: 3, QAT: 0 } });
    const build = (locked: Locked, rc: number, phase: "pre_tournament" | "live") => { const sim = runGroupSim(inputs.fixtures, inputs.aux, { seed: SEED, N, locked }); return buildDocument({ ...baseOpts(inputs), sim, locked, phase, resultCount: rc, storedOverlay: undefined }); };
    const d0 = build({}, 0, "pre_tournament");
    const d1 = build(step1, 1, "live");
    const d2 = build(step2, 2, "live");
    const d3 = build(full, 6, "live");
    const steps = [
      { label: "result_count=0 (pre-tournament baseline)", doc: d0.document, ver: d0.verification, iso: null },
      { label: "result 1: CAN 0-1 BIH", doc: d1.document, ver: d1.verification, iso: crossGroupIsolation(d0.document, d1.document, "B") },
      { label: "result 2: + CAN 2-0 QAT (CAN on 3 pts)", doc: d2.document, ver: d2.verification, iso: crossGroupIsolation(d0.document, d2.document, "B") },
      { label: "full Group B: SUI 1st, BIH 2nd, CAN 3rd (3pts/GD-1/GF2), QAT 4th", doc: d3.document, ver: d3.verification, iso: crossGroupIsolation(d0.document, d3.document, "B") },
    ];
    const walk = steps.map((s) => ({ step: s.label, errors: verifyDoc(s.ver), sums: { advance: s.ver.sum_advance_total, top2: s.ver.sum_top2, win: s.ver.sum_win_group }, canada: canSummary(s.doc), cross_group_isolation: s.iso }));
    const allErrors = walk.flatMap((w, i) => w.errors.map((e) => `step${i}:${e}`));
    const isoOk = walk.slice(1).every((w) => w.cross_group_isolation!.win_top2_exactly_isolated);
    const out = { synthetic_test: true, db_writes: 0, reads_only_verified: true, corrected_ladder: "fifa-2026-article-13", all_sums_hold: walk.every((w) => Math.abs(w.sums.advance - 32) < 0.05 && Math.abs(w.sums.top2 - 24) < 0.05 && Math.abs(w.sums.win - 12) < 0.05), cross_group_win_top2_isolated_every_step: isoOk, append_only_note: "synthetic only — no rows written; live execute uses key (run,version,phase,as_of_result_count) so each result_count is a new row", errors: allErrors, walk };
    writeFileSync(path.join(rootDir, "data/audits/advancement-scenario-v1-live-synthetic-walk.json"), JSON.stringify(out, null, 2), "utf8");
    console.log(JSON.stringify({ ...out, walk: "(see below)" }, null, 2));
    for (const w of walk) { console.log(`\n=== ${w.step} ===`); console.log("sums:", JSON.stringify(w.sums), "| step errors:", w.errors.length ? JSON.stringify(w.errors) : "none"); console.log("CANADA:", JSON.stringify(w.canada, null, 1)); if (w.cross_group_isolation) console.log("cross-group:", JSON.stringify(w.cross_group_isolation)); }
    if (allErrors.length || !isoOk) process.exit(1);
    return;
  }

  // ===== LIVE update: read verified results, condition, (store if >=1 and --execute) =====
  const verified = runSql(config.dbUrl, VERIFIED_RESULTS_SQL);
  const vcount = (verified as any[]).length; // raw verified rows
  // only condition on results whose pair is one of the 72 group fixtures; dedup by pair (last-write). resultCount =
  // distinct in-72 locked pairs, so the append-only key and fixtures_finished stay consistent if a duplicate/orphan row appears.
  const validPairs = new Set(inputs.fixtures.map((f) => lockKey(f.a, f.b)));
  const locked: Locked = {}; let orphanRows = 0; let dupPairRows = 0;
  for (const r of verified as any[]) { const a = r.team_a_code, b = r.team_b_code; const key = lockKey(a, b); if (!validPairs.has(key)) { orphanRows++; continue; } if (locked[key]) dupPairRows++; locked[key] = { [a]: num(r.ga), [b]: num(r.gb) }; }
  const resultCount = Object.keys(locked).length; const phase = resultCount > 0 ? "live" : "pre_tournament";
  console.log(`\nverified group results (K=60 gate): ${vcount} rows -> ${resultCount} distinct in-72 locked pairs (orphan rows: ${orphanRows}, duplicate-pair rows: ${dupPairRows})`);
  const sim = runGroupSim(inputs.fixtures, inputs.aux, { seed: SEED, N, locked });
  const { document, verification } = buildDocument({ ...baseOpts(inputs), sim, locked, phase, resultCount, storedOverlay: resultCount === 0 ? inputs.stored : undefined });
  const errs = verifyDoc(verification);

  const before = runSql(config.dbUrl, `select count(*) c from tournament_advancement_scenarios`)[0];
  let inserted = 0; let newRowId: string | null = null; let note = "";
  if (resultCount === 0) {
    note = `0 verified group results${orphanRows ? ` (${orphanRows} non-group/orphan rows ignored)` : ""} — nothing to store; the pre-tournament row (phase=pre_tournament, as_of_result_count=0) already covers this state. Live rows are written only once real verified results exist.`;
  } else if (execute) {
    if (errs.length) throw new Error(`abort execute: ${errs.join("; ")}`);
    console.log(`PROJECT ID: ${config.projectRef} — EXECUTE: append-only live row (phase=live, as_of_result_count=${resultCount}).`);
    const snapshot = { generator: "scripts/worldcup/build-advancement-scenario-v1-live.ts", source_sim_run_id: SOURCE_SIM_RUN, conditioned_on_locked_pairs: resultCount, verified_rows: vcount, orphan_rows: orphanRows, duplicate_pair_rows: dupPairRows, verified_gate: "match_status=finished + api_football_fixture_id + source_payload_hash + not-rejected", sum_advance_total: verification.sum_advance_total, candidate_run: true, not_global_current_best: true, no_odds: true, api_football_predictions_used: false };
    const docEsc = JSON.stringify(document).replace(/'/g, "''"); const snapEsc = JSON.stringify(snapshot).replace(/'/g, "''");
    execSql(config.dbUrl, `insert into public.tournament_advancement_scenarios (simulation_run_id, scenario_model_version, tournament_code, phase, as_of_result_count, source_prediction_run_id, fifa_ranking_snapshot_date, tiebreaker_ladder_version, team_count, sum_advance_total, document, source_snapshot) values ('${SOURCE_SIM_RUN}','${SCHEMA_VERSION}','WC_2026','live',${resultCount},'${SOURCE_PRED_RUN}','${FIFA_SNAPSHOT}','${LADDER_VERSION}',48,${verification.sum_advance_total},'${docEsc}'::jsonb,'${snapEsc}'::jsonb) on conflict (simulation_run_id, scenario_model_version, phase, as_of_result_count) do nothing`);
    const row = runSql(config.dbUrl, `select id::text id from tournament_advancement_scenarios where simulation_run_id='${SOURCE_SIM_RUN}' and scenario_model_version='${SCHEMA_VERSION}' and phase='live' and as_of_result_count=${resultCount}`)[0];
    newRowId = row?.id ?? null; inserted = newRowId ? 1 : 0;
    writeFileSync(path.join(rootDir, `data/exports/advancement-scenario-v1-live-r${resultCount}-app.json`), JSON.stringify(document, null, 2), "utf8");
  } else { note = `${resultCount} verified group results — DRY-RUN; pass --execute to store the live row (phase=live, as_of_result_count=${resultCount}).`; }
  const after = runSql(config.dbUrl, `select count(*) c from tournament_advancement_scenarios`)[0];

  console.log(JSON.stringify({ live_update: true, verified_rows: vcount, locked_pairs: resultCount, orphan_rows: orphanRows, duplicate_pair_rows: dupPairRows, phase, as_of_result_count: resultCount, reads_only_verified: true, verification, errors: errs, inserted, new_row_id: newRowId, tas_rows_before: num(before.c), tas_rows_after: num(after.c), note }, null, 2));
}
main().catch((e) => { console.error("ERROR:", e?.message ?? e); process.exit(1); });
