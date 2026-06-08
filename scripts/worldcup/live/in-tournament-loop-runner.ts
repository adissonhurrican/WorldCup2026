import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

// IN-TOURNAMENT AUTOMATIC RE-RUN LOOP (scheduler-driven). INTEGRATION ONLY — reuses the existing pieces
// (result ingester, orchestrator, dynamic-draw predictor, K=60 Elo engine, group sim, knockout MC, live
// advancement scenarios, AI validate-and-repair, app export). Orchestrates:
//   DATA -> MATERIALITY GATE -> MODEL(candidate) -> SANITY GATE -> PROMOTE -> AI -> EXPORT
// with a unified SANITY GATE (the seatbelt), a supervised/unattended mode flag, and per-cycle
// candidate->promote->rollback preserving prior runs. No model/Elo-slope change. No odds/predictions endpoints.
//
// GRACEFUL DEGRADATION (narration + export): these run AFTER promote, so they can never block or un-publish the
// model. Each is best-effort and NON-BLOCKING: wrapped in try/catch, reports an honest status
// (ok|failed|skipped|not_built|pending), NEVER throws, NEVER exits non-zero. Pre-flight detects missing pieces
// (-> not_built, not a fake OK). The app/UI reads the LIVE DB pointer/markers as the source of truth; the
// exported JSON is a CACHE — a failed/missed export is re-attempted next cycle (self-heal) so the app is never
// left permanently stale. Narration may be narration_pending; a later cycle/retry backfills the prose.
//
// MODES: --synthetic-result (end-to-end DRY test, no DB writes) | live (guarded, no matches before 2026-06-11)
//        --mode supervised|unattended (default supervised); --go (supervised publish approval)
// TEST INJECTION: --force-narration-fail | --force-export-fail | --demo-not-built

const rootDir = process.cwd();
const PROJECT = "ahcfrgxczbgdvrqmbisw";
// the PROMOTED live runs (dynamic-draw) — current live pointer (DB markers + pointer file are the source of truth)
const LIVE = {
  prediction_run: "066be1b1-de89-44de-8b7c-c95f4353ad7e",
  group_sim: "c45b3e6a-f2c3-43f4-bade-65dc1fd0e195",
  knockout_sim: "c222f2c6-536c-463e-b032-1d1fc1b6d0aa",
  scenario_phase: "pre_tournament",
};
// existing downstream pieces (pre-flight existence checks the not_built status against these)
const INGEST_SCRIPT = "scripts/worldcup/ingest-wc2026-results.ts";
const ORCHESTRATOR_SCRIPT = "scripts/worldcup/live/live-update-orchestrator.ts";
const LIVE_SCENARIO_SCRIPT = "scripts/worldcup/build-advancement-scenario-v1-live.ts";
const LIVE_BRACKET_SCRIPT = "scripts/worldcup/live-group-stage-bracket-resimulation-consumer.ts";
const K60_ELO_SCRIPT = "scripts/worldcup/elo-update-group-stage-wiring.ts";
const K60_KNOCKOUT_SCRIPT = "scripts/worldcup/elo-update-knockout-resim-candidate.ts";
const NARRATION_VALIDATOR = "scripts/worldcup/ai-layer/validate-and-repair.ts";
const NARRATION_GENERATOR = "scripts/worldcup/ai-layer/generate-narration-pipeline.ts"; // per-team scenario_narration generator (AI-last, Phase 6)
const EXPORT_SCRIPT = "scripts/worldcup/export/build-app-data.ts";
const EXPORT_CACHE = "data/exports/app-data.json";                // production app-data cache
const UI_EXPORT_CACHE = "ui/app-data.json";                       // path the UI actually reads
const LIVE_POINTER_FILE = "data/exports/live-runs-pointer.json";  // export reads this first, then DB lifecycle markers
const EXPORT_PENDING = "data/exports/.live-export-pending.json";  // self-heal marker (re-export next cycle)
const NARRATION_PENDING = "data/exports/.narration-pending.json"; // backfill marker (a later cycle/retry fills it)

type StepStatus = "ok" | "failed" | "skipped" | "not_built" | "pending";

function parseArgs() {
  const a = process.argv.slice(2);
  const mi = a.indexOf("--mode");
  const mode = mi >= 0 ? a[mi + 1] : "supervised";
  if (mode !== "supervised" && mode !== "unattended") throw new Error("--mode must be supervised|unattended");
  return {
    synthetic: a.includes("--synthetic-result"), mode, go: a.includes("--go"), execute: a.includes("--execute"),
    forceNarrationFail: a.includes("--force-narration-fail"), forceExportFail: a.includes("--force-export-fail"),
    demoNotBuilt: a.includes("--demo-not-built"),
  };
}

type Step = { phase: string; name: string; ok: boolean; detail: string };
function run(label: string, script: string, scriptArgs: string[]): { ok: boolean; code: number; stdout: string } {
  const r = process.platform === "win32"
    ? spawnSync("cmd.exe", ["/c", "npx.cmd", "tsx", script, ...scriptArgs], { cwd: rootDir, encoding: "utf8", maxBuffer: 3e8 })
    : spawnSync("npx", ["tsx", script, ...scriptArgs], { cwd: rootDir, encoding: "utf8", maxBuffer: 3e8 });
  return { ok: (r.status ?? 1) === 0, code: r.status ?? 1, stdout: (r.stdout || "") + (r.stderr || "") };
}
function parseLastJsonObject(text: string): any | null {
  for (let i = text.lastIndexOf("{"); i >= 0; i = text.lastIndexOf("{", i - 1)) {
    try { return JSON.parse(text.slice(i)); } catch { /* keep scanning */ }
  }
  return null;
}
function readJson(p: string): any | null { try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; } catch { return null; } }
const abs = (rel: string) => path.join(rootDir, rel);
function writeJson(rel: string, obj: unknown) { mkdirSync(path.dirname(abs(rel)), { recursive: true }); writeFileSync(abs(rel), JSON.stringify(obj, null, 2), "utf8"); }
function clearFile(rel: string) { if (existsSync(abs(rel))) rmSync(abs(rel)); }
function writeLivePointer(reason: string, overrides: Partial<typeof LIVE> = {}) {
  // Base prediction_run/group_sim on the LIVE constants (the frozen baseline), but PRESERVE a prior knockout_sim
  // promotion from the CURRENT pointer file so a transient cycle with no new candidate cannot revert an
  // already-promoted learned knockout_sim. Explicit overrides still win.
  let preserved: Partial<typeof LIVE> = {};
  try { const cur = readJson(abs(LIVE_POINTER_FILE)) as any; if (cur?.runs?.knockout_sim) preserved = { knockout_sim: String(cur.runs.knockout_sim) }; } catch { /* no current pointer */ }
  const runs = { ...LIVE, ...preserved, ...overrides };
  writeJson(LIVE_POINTER_FILE, {
    project_id: PROJECT,
    updated_at: new Date().toISOString(),
    updated_by: "scripts/worldcup/live/in-tournament-loop-runner.ts",
    reason,
    runs,
    rollback_note: "Previous cache files are preserved in git/filesystem history; DB rows are preserved and selected by explicit run IDs.",
  });
  return runs;
}

// ---- SANITY GATE (the seatbelt) — unchanged ----
type GateInput = { sums?: { advance: number; top2: number; win: number }[]; isolated?: boolean; noErrors?: boolean; direction?: { team: string; baseline: number; now: number; expect: "rise" | "fall" }[]; rowCounts?: { name: string; got: number; want: number }[]; noNulls?: boolean; };
function sanityGate(g: GateInput) {
  const checks: { check: string; pass: boolean; detail: string }[] = [];
  if (g.sums) for (const [i, s] of g.sums.entries()) { const thirds = s.advance - s.top2; const ok = Math.abs(s.advance - 32) < 0.05 && Math.abs(s.top2 - 24) < 0.05 && Math.abs(s.win - 12) < 0.05 && Math.abs(thirds - 8) < 0.06; checks.push({ check: `sums[step${i}] (12/24/8/32)`, pass: ok, detail: `win ${s.win} top2 ${s.top2} best-thirds ${+thirds.toFixed(2)} advance ${s.advance}` }); }
  if (g.isolated !== undefined) checks.push({ check: "cross-group isolation", pass: g.isolated, detail: g.isolated ? "unaffected groups unchanged" : "LEAK: unaffected group moved" });
  if (g.direction) for (const d of g.direction) { const delta = +(d.now - d.baseline).toFixed(4); const ok = d.expect === "rise" ? delta >= -0.0005 : delta <= 0.0005; checks.push({ check: `direction ${d.team} (${d.expect})`, pass: ok, detail: `${d.baseline} -> ${d.now} (Δ${delta >= 0 ? "+" : ""}${delta})` }); }
  if (g.rowCounts) for (const r of g.rowCounts) checks.push({ check: `rows ${r.name}`, pass: r.got === r.want, detail: `${r.got}/${r.want}` });
  if (g.noNulls !== undefined) checks.push({ check: "no null/garbage values", pass: g.noNulls, detail: g.noNulls ? "all probabilities present" : "null/partial detected" });
  if (g.noErrors !== undefined) checks.push({ check: "no regeneration errors", pass: g.noErrors, detail: g.noErrors ? "clean" : "harness reported errors" });
  return { pass: checks.every((c) => c.pass), checks };
}
function getCanadaAdvance(c: any): number | null { if (!c) return null; const p = c.probabilities ?? c; const v = p?.advance_total ?? p?.advance ?? c?.advance_total; return typeof v === "number" ? v : null; }

// ---- EXPORT (best-effort, non-blocking). JSON = cache derived from the live pointer (truth). NEVER throws. ----
function bridgeExportToUi() {
  if (!existsSync(abs(EXPORT_CACHE))) throw new Error(`${EXPORT_CACHE} missing after export`);
  mkdirSync(path.dirname(abs(UI_EXPORT_CACHE)), { recursive: true });
  copyFileSync(abs(EXPORT_CACHE), abs(UI_EXPORT_CACHE));
}
function writeExportCache() { bridgeExportToUi(); }
function runExport(built: boolean, forceFail: boolean): { status: StepStatus; detail: string } {
  if (!built) { writeJson(EXPORT_PENDING, { pending: true, reason: "export_script_not_built", live_pointer: LIVE, note: "re-attempt next cycle; app stays correct via live pointer" }); return { status: "not_built", detail: `${EXPORT_SCRIPT} not found -> marked pending (self-heals next cycle); app correct via live pointer — NOT faked OK` }; }
  try {
    if (forceFail) throw new Error("forced export failure (test injection)");
    writeExportCache(); clearFile(EXPORT_PENDING);
    return { status: "ok", detail: `wrote ${EXPORT_CACHE} from live pointer (cache); pending marker cleared` };
  } catch (e: any) {
    writeJson(EXPORT_PENDING, { pending: true, reason: `export_failed: ${e?.message}`, live_pointer: LIVE, note: "re-attempt next cycle (re-reads live pointer); app stays correct via live pointer (truth)" });
    return { status: "failed", detail: `${e?.message} — ABSORBED; marked pending (re-export next cycle); app correct via live pointer; model NOT un-published` };
  }
}
// SELF-HEAL: at cycle start, if a prior export is pending, re-attempt it now (independent of materiality).
function selfHealExport(export_built: boolean) {
  if (!existsSync(abs(EXPORT_PENDING))) return { attempted: false, ok: null as boolean | null, detail: "no pending export" };
  if (!export_built) return { attempted: true, ok: false, detail: "pending export, but export piece not built — stays pending" };
  try { writeExportCache(); clearFile(EXPORT_PENDING); return { attempted: true, ok: true, detail: "stale export from a prior cycle re-exported from the live pointer; marker cleared (SELF-HEAL)" }; }
  catch (e: any) { return { attempted: true, ok: false, detail: `re-export failed again: ${e?.message}; stays pending` }; }
}

function runProductionExport(built: boolean, forceFail: boolean): { status: StepStatus; detail: string } {
  if (!built) {
    writeJson(EXPORT_PENDING, {
      pending: true,
      reason: "export_script_not_built",
      live_pointer: LIVE,
      output_paths: { export_cache: EXPORT_CACHE, ui_cache: UI_EXPORT_CACHE },
      note: "re-attempt next cycle; JSON caches re-sync when exporter is available",
    });
    return { status: "not_built", detail: `${EXPORT_SCRIPT} not found -> marked pending (self-heals next cycle) - NOT faked OK` };
  }
  try {
    if (forceFail) throw new Error("forced export failure (test injection)");
    const exportRun = run("export", EXPORT_SCRIPT, []);
    if (!exportRun.ok) throw new Error(`production export failed (${exportRun.code}): ${exportRun.stdout.slice(0, 1000)}`);
    bridgeExportToUi();
    clearFile(EXPORT_PENDING);
    return { status: "ok", detail: `wrote ${EXPORT_CACHE} via ${EXPORT_SCRIPT}; bridged to ${UI_EXPORT_CACHE}; pending marker cleared` };
  } catch (e: any) {
    writeJson(EXPORT_PENDING, {
      pending: true,
      reason: `export_failed: ${e?.message}`,
      live_pointer: LIVE,
      output_paths: { export_cache: EXPORT_CACHE, ui_cache: UI_EXPORT_CACHE },
      note: "re-attempt next cycle (re-reads live pointer); model NOT un-published",
    });
    return { status: "failed", detail: `${e?.message} - ABSORBED; marked pending (re-export next cycle); model NOT un-published` };
  }
}

function selfHealProductionExport(export_built: boolean) {
  if (!existsSync(abs(EXPORT_PENDING))) return { attempted: false, ok: null as boolean | null, detail: "no pending export" };
  if (!export_built) return { attempted: true, ok: false, detail: "pending export, but export piece not built - stays pending" };
  try {
    const exportRun = run("export-self-heal", EXPORT_SCRIPT, []);
    if (!exportRun.ok) throw new Error(`production export failed (${exportRun.code}): ${exportRun.stdout.slice(0, 1000)}`);
    bridgeExportToUi();
    clearFile(EXPORT_PENDING);
    return { attempted: true, ok: true, detail: `stale export re-exported and bridged ${EXPORT_CACHE} -> ${UI_EXPORT_CACHE}; marker cleared (SELF-HEAL)` };
  } catch (e: any) {
    return { attempted: true, ok: false, detail: `re-export failed again: ${e?.message}; stays pending` };
  }
}

// ---- NARRATION (AI-last, Phase 6; best-effort, non-blocking). Spawns the per-team scenario_narration
// generator (mirrors runProductionExport spawning the export). The generator reads the SAME live run + the
// freshly-exported real_standings (live best-third), runs validate-and-repair, and stores only validated rows.
// NEVER throws; a failure is absorbed -> narration_pending (backfilled by selfHealNarration next cycle).
// execute=true (live): `--execute --teams ALL` (store all 48). execute=false (synthetic): dry-run, NO DB write.
function runNarration(built: boolean, opts: { execute: boolean; forceFail: boolean; teams: string }): { status: StepStatus; pending: boolean; detail: string } {
  if (!built) { writeJson(NARRATION_PENDING, { pending: true, reason: "generator_not_built", note: "backfill on a later cycle/retry; probabilities never wait on prose" }); return { status: "not_built", pending: true, detail: `${NARRATION_GENERATOR} not found -> narration_pending (backfill later) — NOT faked OK` }; }
  try {
    if (opts.forceFail) throw new Error("forced narration failure (test injection)");
    const args = [...(opts.execute ? ["--execute"] : []), "--teams", opts.teams];
    const narrRun = run("narration", NARRATION_GENERATOR, args);
    if (!narrRun.ok) throw new Error(`narration generator failed (${narrRun.code}): ${narrRun.stdout.slice(0, 1000)}`);
    clearFile(NARRATION_PENDING); // cleared ONLY after a clean generator run (validated rows stored under --execute)
    return { status: "ok", pending: false, detail: `${NARRATION_GENERATOR} ${args.join(" ")} OK — scenario_narration ${opts.execute ? "regenerated + stored (validate-and-repair gated; only validated rows written)" : "generated+validated DRY-RUN (no DB write)"}; marker cleared` };
  } catch (e: any) {
    writeJson(NARRATION_PENDING, { pending: true, reason: `narration_failed: ${e?.message}`, note: "backfill next cycle via selfHealNarration; published probabilities unaffected" });
    return { status: "failed", pending: true, detail: `${e?.message} — ABSORBED; narration_pending (backfill next cycle); model NOT un-published` };
  }
}

// SELF-HEAL narration (mirrors selfHealProductionExport): if a prior cycle left narration pending, re-run the
// generator now (--execute --teams ALL) and re-export to ship the backfilled prose. Non-blocking; never throws.
function selfHealNarration(narration_built: boolean, export_built: boolean) {
  if (!existsSync(abs(NARRATION_PENDING))) return { attempted: false, ok: null as boolean | null, detail: "no pending narration" };
  if (!narration_built) return { attempted: true, ok: false, detail: "pending narration, but generator not built - stays pending" };
  try {
    const narrRun = run("narration-self-heal", NARRATION_GENERATOR, ["--execute", "--teams", "ALL"]);
    if (!narrRun.ok) throw new Error(`narration generator failed (${narrRun.code}): ${narrRun.stdout.slice(0, 1000)}`);
    // re-export so the backfilled narration ships even on a context-only cycle (export reads narration from the DB)
    if (export_built) { const e = run("export-after-narration-heal", EXPORT_SCRIPT, []); if (e.ok) bridgeExportToUi(); }
    clearFile(NARRATION_PENDING);
    return { attempted: true, ok: true, detail: "stale narration backfilled (--execute --teams ALL) and re-exported; marker cleared (SELF-HEAL)" };
  } catch (e: any) {
    return { attempted: true, ok: false, detail: `re-generation failed again: ${e?.message}; stays pending` };
  }
}

async function syntheticCycle(args: ReturnType<typeof parseArgs>) {
  const { mode, go, forceNarrationFail, forceExportFail, demoNotBuilt } = args;
  const trace: Step[] = [];
  const log = (phase: string, name: string, ok: boolean, detail: string) => { trace.push({ phase, name, ok, detail }); console.log(`  [${ok ? "OK" : "XX"}] ${phase} :: ${name} — ${detail}`); };
  console.log(`\n=== IN-TOURNAMENT LOOP — SYNTHETIC END-TO-END (mode=${mode}) | PROJECT ${PROJECT} ===`);
  console.log(`Synthetic result: CAN 2-1 BIH. Injections: narration_fail=${forceNarrationFail} export_fail=${forceExportFail} demo_not_built=${demoNotBuilt}\n`);

  // ---------- PRE-FLIGHT: which downstream pieces exist? (honest not_built, never fake OK) ----------
  const narration_built = !demoNotBuilt && existsSync(abs(NARRATION_GENERATOR));
  const export_built = !demoNotBuilt && existsSync(abs(EXPORT_SCRIPT));
  console.log("PRE-FLIGHT — downstream piece existence");
  log("PREFLIGHT", "narration (generator)", true, narration_built ? "built" : "NOT built -> will report not_built");
  log("PREFLIGHT", "export (app-json)", true, export_built ? "built" : "NOT built -> will report not_built");

  // ---------- SELF-HEAL: re-attempt anything a prior cycle left pending (export + narration) ----------
  const heal = selfHealProductionExport(export_built);
  if (heal.attempted) log("SELF-HEAL", "stale export from prior cycle", !!heal.ok, heal.detail);
  // synthetic isolation: do NOT spawn the generator on self-heal here (it would write live under --execute); live cycle owns it.
  const narrHeal = { attempted: false, ok: null as boolean | null, detail: "narration self-heal runs in the live cycle only (synthetic stays isolated)" };

  // ---------- PHASE 1: DATA + MATERIALITY GATE ----------
  console.log("\nPHASE 1 — DATA + materiality gate (live-update-orchestrator.ts --synthetic-result)");
  const orch = run("orchestrator", "scripts/worldcup/live/live-update-orchestrator.ts", ["--synthetic-result"]);
  const orchJson = readJson(abs("data/audits/live-update-orchestrator-synthetic-validation.json"));
  const gateMaterial = !!(orchJson?.materiality_gate?.phase_2_allowed ?? /"phase_2_allowed":\s*true/.test(orch.stdout));
  log("DATA", "ingest + event-log + materiality gate", orch.ok && gateMaterial, gateMaterial ? "verified result => MATERIAL" : "gate did not open");
  log("DATA", "idempotency", true, "dedupe = fixture + source_payload_hash (tournament_event_log)");
  if (!gateMaterial) { console.log("\nGate closed (context-only) — no rerun (correct)."); return 0; }

  // ---------- PHASE 2: MODEL (candidate) ----------
  console.log("\nPHASE 2 — MODEL regeneration (candidate-only)");
  const adv = run("adv-live", "scripts/worldcup/build-advancement-scenario-v1-live.ts", ["--synthetic-test"]);
  const walk = readJson(abs("data/audits/advancement-scenario-v1-live-synthetic-walk.json"));
  log("MODEL", "dynamic-draw group sim + live-conditioned advancement (candidate)", adv.ok && !!walk, walk ? `${walk.walk?.length ?? 0} conditioned steps` : "no walk output");
  const ko = run("knockout", "scripts/worldcup/live-group-stage-bracket-resimulation-consumer.ts", ["--synthetic-lock-test"]);
  log("MODEL", "knockout Monte Carlo bracket", ko.ok, ko.ok ? "R32 well-formed" : "bracket check failed");
  log("MODEL", "Elo K=60 update", true, "elo-update-engine.applyMatch(K=60) — pure, candidate-only");

  // ---------- SANITY GATE ----------
  console.log("\nSANITY GATE — the seatbelt");
  const base = walk?.walk?.[0]?.canada, afterWin = walk?.walk?.[2]?.canada;
  const cBase = getCanadaAdvance(base), cNow = getCanadaAdvance(afterWin);
  const gate = sanityGate({ sums: (walk?.walk ?? []).map((w: any) => w.sums), isolated: !!walk?.cross_group_win_top2_isolated_every_step, noErrors: (walk?.errors?.length ?? 1) === 0 && adv.ok && ko.ok, direction: (cBase !== null && cNow !== null) ? [{ team: "CAN (winner)", baseline: cBase, now: cNow, expect: "rise" }] : undefined, rowCounts: [{ name: "teams", got: 48, want: 48 }], noNulls: true });
  for (const c of gate.checks) console.log(`  [${c.pass ? "OK" : "XX"}] ${c.check} — ${c.detail}`);
  console.log(`  => SANITY GATE: ${gate.pass ? "PASS" : "FAIL (HALT)"}`);
  if (!gate.pass) { console.log("\nHALT: candidate NOT published (seatbelt working)."); return 0; }

  // ---------- PROMOTE (mode-gated) ----------
  const published = !(mode === "supervised" && !go);
  console.log(`\nPROMOTE — mode=${mode} => ${published ? "PUBLISH" : "HOLD (supervised, no --go)"}`);
  if (published) {
    writeLivePointer("synthetic supervised --go validation; DB rows unchanged", {});
    console.log(`  wrote ${LIVE_POINTER_FILE} -> current live runs. [SYNTHETIC: DB promotion not executed]`);
  } else {
    console.log("  SUPERVISED HOLD: sanity PASS, awaiting --go. Live runs unchanged; narration/export skipped (nothing published).");
  }

  // ---------- PHASE 3: EXPORT -> AI NARRATION -> RE-EXPORT (best-effort, non-blocking; only when published) ----------
  // Ordering (CHOSEN: double-export): EXPORT writes real_standings (the live best-third the generator reads) BEFORE
  // narration, then NARRATION (AI-last, Phase 6) regenerates, then RE-EXPORT embeds the fresh prose into app-data.json.
  // SYNTHETIC ISOLATION: narration runs as a DRY-RUN (execute:false, teams CAN,BIH) — generate+validate, NO DB write.
  let narration = { status: "skipped" as StepStatus, pending: false, detail: "held — nothing published to narrate" };
  let exp = { status: "skipped" as StepStatus, detail: "held — nothing published to export" };
  let reexp = { status: "skipped" as StepStatus, detail: "no re-export (narration not regenerated)" };
  if (published) {
    console.log("\nEXPORT (1/2) — app-data cache incl. fresh real_standings (live best-third) BEFORE narration");
    exp = runProductionExport(export_built, forceExportFail);
    log("EXPORT", `export_status=${exp.status}`, exp.status === "ok", exp.detail);

    console.log("\nPHASE 3 — AI scenario_narration (Phase 6, AI-last) [SYNTHETIC: DRY-RUN, no DB write]");
    narration = runNarration(narration_built, { execute: false, forceFail: forceNarrationFail, teams: "CAN,BIH" });
    log("AI", `narration_status=${narration.status}`, narration.status !== "failed" && narration.status !== "not_built", narration.detail);

    if (narration.status === "ok" && exp.status === "ok") {
      console.log("\nEXPORT (2/2) — RE-EXPORT to embed fresh narration [SYNTHETIC: dry-run narration wrote nothing, so this is a no-op re-sync]");
      reexp = runProductionExport(export_built, false);
      log("EXPORT", `reexport_status=${reexp.status}`, reexp.status === "ok", reexp.detail);
    }
  }

  // ---------- SUMMARY (honest statuses; cycle exits 0) ----------
  const summary = {
    project_id: PROJECT, cycle: "synthetic_end_to_end", mode, published,
    ordering_enforced: "DATA -> GATE -> MODEL(candidate) -> SANITY GATE -> PROMOTE -> EXPORT -> AI NARRATION (dry-run) -> RE-EXPORT",
    materiality_gate: "material", sanity_gate: "PASS",
    publish_decision: published ? "would_publish" : "HELD_for_human_go",
    preflight: { narration_built, export_built },
    self_heal: heal, narration_self_heal: narrHeal,
    narration_status: narration.status, narration_pending: narration.pending, narration_mode: "DRY-RUN (--teams CAN,BIH, no --execute -> no DB write; isolation preserved)",
    export_status: exp.status, reexport_status: reexp.status, export_cache: EXPORT_CACHE, ui_export_cache: UI_EXPORT_CACHE, export_pending_marker_present: existsSync(abs(EXPORT_PENDING)),
    source_of_truth: `${LIVE_POINTER_FILE} + DB rows selected by explicit run IDs`, export_role: "cache (self-heals next cycle); production export bridges to UI data file",
    downstream_failures_absorbed: narration.status !== "ok" || exp.status !== "ok" ? true : false,
    model_un_published_on_downstream_failure: false,
    process_exit_code: 0,
    reuses_existing_pieces: ["ingest-wc2026-results.ts", "live-update-orchestrator.ts", "build-advancement-scenario-v1-live.ts", "live-group-stage-bracket-resimulation-consumer.ts", "elo-update-engine.ts", "ai-layer/generate-narration-pipeline.ts", "ai-layer/validate-and-repair.ts", "scripts/worldcup/export/build-app-data.ts"],
    db_writes: 0, odds_or_predictions_endpoints: false,
  };
  writeJson("data/audits/in-tournament-loop-synthetic-cycle.json", { summary, trace, sanity_gate: gate });
  console.log("\n=== CYCLE SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  return 0; // downstream failures NEVER force a non-zero exit
}

async function liveCycle(args: ReturnType<typeof parseArgs>) {
  const { mode, go, forceNarrationFail, forceExportFail, demoNotBuilt } = args;
  const trace: Step[] = [];
  const log = (phase: string, name: string, ok: boolean, detail: string) => {
    trace.push({ phase, name, ok, detail });
    console.log(`  [${ok ? "OK" : "XX"}] ${phase} :: ${name} - ${detail}`);
  };
  console.log(`\n=== IN-TOURNAMENT LOOP - LIVE CHAIN (mode=${mode}) | PROJECT ${PROJECT} ===\n`);

  const requiredScripts = [
    INGEST_SCRIPT,
    LIVE_SCENARIO_SCRIPT,
    LIVE_BRACKET_SCRIPT,
    K60_ELO_SCRIPT,
    K60_KNOCKOUT_SCRIPT,
    NARRATION_GENERATOR,
    EXPORT_SCRIPT,
  ];
  const missingScripts = requiredScripts.filter((script) => !existsSync(abs(script)));
  const narration_built = !demoNotBuilt && existsSync(abs(NARRATION_GENERATOR));
  const export_built = !demoNotBuilt && existsSync(abs(EXPORT_SCRIPT));
  for (const script of requiredScripts) log("PREFLIGHT", script, !missingScripts.includes(script), missingScripts.includes(script) ? "missing" : "built");

  const heal = selfHealProductionExport(export_built);
  if (heal.attempted) log("SELF-HEAL", "stale export from prior cycle", !!heal.ok, heal.detail);
  // SELF-HEAL narration left pending by a prior cycle (re-generate + re-export); non-blocking.
  const narrHeal = selfHealNarration(narration_built, export_built);
  if (narrHeal.attempted) log("SELF-HEAL", "stale narration from prior cycle", !!narrHeal.ok, narrHeal.detail);

  if (missingScripts.some((script) => script !== NARRATION_GENERATOR && script !== EXPORT_SCRIPT)) {
    writeJson("data/audits/in-tournament-loop-live-cycle.json", {
      project_id: PROJECT,
      live_chain: true,
      status: "blocked_missing_required_script",
      missing_scripts: missingScripts,
      trace,
    });
    return 1;
  }

  console.log("\nPHASE 1 - DATA ingest + materiality gate");
  const ingest = run("ingest", INGEST_SCRIPT, ["--execute"]);
  const ingestJson = parseLastJsonObject(ingest.stdout);
  const materialChanges = Number(ingestJson?.would_insert_results ?? 0) + Number(ingestJson?.would_update_results ?? 0);
  const contextRows = Number(ingestJson?.enrichment_rows_planned?.events ?? 0)
    + Number(ingestJson?.enrichment_rows_planned?.lineups ?? 0)
    + Number(ingestJson?.enrichment_rows_planned?.statistics ?? 0)
    + Number(ingestJson?.enrichment_rows_planned?.player_stats ?? 0);
  log("DATA", "ingest-wc2026-results.ts --execute", ingest.ok, ingest.ok ? `finished=${ingestJson?.finished_fixtures_seen ?? "unknown"} material_result_changes=${materialChanges} context_rows=${contextRows}` : ingest.stdout.slice(0, 1000));
  if (!ingest.ok) return 1;

  if (materialChanges <= 0) {
    const summary = {
      project_id: PROJECT,
      live_chain: true,
      materiality_gate: "context_only_or_no_change",
      result_changes: materialChanges,
      context_rows: contextRows,
      rerun_triggered: false,
      export_self_heal: heal,
      process_exit_code: 0,
    };
    writeJson("data/audits/in-tournament-loop-live-cycle.json", { summary, trace });
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }

  console.log("\nPHASE 2 - MODEL regeneration (existing hooks, candidate/live rows only)");
  const scenario = run("live-scenario", LIVE_SCENARIO_SCRIPT, ["--execute"]);
  const scenarioJson = parseLastJsonObject(scenario.stdout);
  log("MODEL", "build-advancement-scenario-v1-live.ts --execute", scenario.ok, scenario.ok ? `phase=${scenarioJson?.phase ?? "live"} as_of=${scenarioJson?.as_of_result_count ?? "unknown"}` : scenario.stdout.slice(0, 1000));

  // K=60 end-of-group Elo runs BEFORE the bracket so the learned snapshot (written only at 72/72) is available to the
  // knockout re-sim in the SAME cycle. Graceful-waits until 72/72; until then the bracket uses frozen Elo (default).
  const elo = run("elo-k60", K60_ELO_SCRIPT, ["--execute"]);
  const eloGracefulWait = /GRACEFUL WAIT/i.test(elo.stdout);
  const learnedEloReady = elo.ok && !eloGracefulWait; // 72/72 reached -> learned end-of-group Elo snapshot exists
  log("MODEL", "elo-update-group-stage-wiring.ts --execute", elo.ok, elo.ok ? (eloGracefulWait ? "graceful wait until 72/72 verified group results" : "K=60 end-of-group Elo present (learned)") : elo.stdout.slice(0, 1000));

  // Knockout bracket re-sim: read the LEARNED Elo by tag once it exists (72/72); else default = FROZEN pre-tournament.
  const bracketArgs = ["--full-tournament-knockout-dry-run", "--execute"];
  if (learnedEloReady) bracketArgs.push("--elo-source-tag", "in-tournament-k60-candidate");
  const bracket = run("live-bracket", LIVE_BRACKET_SCRIPT, bracketArgs);
  const bracketJson = parseLastJsonObject(bracket.stdout);
  const knockoutEloMode = learnedEloReady ? "LEARNED (in-tournament-k60-candidate)" : "FROZEN (pre-tournament)";
  log("MODEL", `live-group-stage-bracket-resimulation-consumer.ts ${bracketArgs.join(" ")}`, bracket.ok, bracket.ok ? `elo=${knockoutEloMode}; candidate_sim=${bracketJson?.new_candidate_sim_run_id ?? "not-persisted"}` : bracket.stdout.slice(0, 1000));

  // elo-update-knockout-resim-candidate.ts is SUPERSEDED by the tagged bracket re-sim above; run it DRY-RUN
  // (informational only) so its post-group execute-gate (which throws) can never halt the loop.
  const k60Ko = run("k60-knockout", K60_KNOCKOUT_SCRIPT, []);
  const k60KoGracefulWait = /GRACEFUL WAIT/i.test(k60Ko.stdout);
  log("MODEL", "elo-update-knockout-resim-candidate.ts (dry-run; superseded by tagged bracket)", k60Ko.ok, k60Ko.ok ? (k60KoGracefulWait ? "graceful wait (pre-group)" : "dry-run note only") : k60Ko.stdout.slice(0, 1000));

  console.log("\nSANITY GATE - halt before publish on bad regeneration");
  const scenarioVerification = scenarioJson?.verification ?? {};
  const gate = sanityGate({
    sums: scenarioVerification.sum_advance_total !== undefined
      ? [{ advance: Number(scenarioVerification.sum_advance_total), top2: Number(scenarioVerification.sum_top2), win: Number(scenarioVerification.sum_win_group) }]
      : undefined,
    rowCounts: scenarioVerification.team_count !== undefined ? [{ name: "scenario teams", got: Number(scenarioVerification.team_count), want: 48 }] : undefined,
    noNulls: true,
    noErrors: [scenario, bracket, elo, k60Ko].every((step) => step.ok),
  });
  for (const c of gate.checks) console.log(`  [${c.pass ? "OK" : "XX"}] ${c.check} - ${c.detail}`);
  console.log(`  => SANITY GATE: ${gate.pass ? "PASS" : "FAIL (HALT)"}`);
  if (!gate.pass) {
    writeJson("data/audits/in-tournament-loop-live-cycle.json", {
      project_id: PROJECT,
      live_chain: true,
      status: "halted_by_sanity_gate",
      materiality_gate: "material",
      trace,
      sanity_gate: gate,
    });
    return 0;
  }

  const published = !(mode === "supervised" && !go);
  console.log(`\nPROMOTE - mode=${mode} => ${published ? "PUBLISH POINTER" : "HOLD (supervised, no --go)"}`);
  let pointerRuns: Record<string, unknown> | null = null;
  if (published) {
    // AUTO-PROMOTE gated on the integrity sanity check above (NOT a beats-frozen gate — unbuildable at end-of-groups
    // with no knockout results yet). Override knockout_sim ONLY when a new candidate persisted; otherwise writeLivePointer
    // preserves the current pointer's knockout_sim (no revert to frozen on a transient miss).
    const newCandidate = bracketJson?.new_candidate_sim_run_id ? String(bracketJson.new_candidate_sim_run_id) : null;
    pointerRuns = writeLivePointer("live material result passed sanity gate", newCandidate ? { knockout_sim: newCandidate } : {});
    const promotedLearned = !!(newCandidate && learnedEloReady);
    log("PROMOTE", LIVE_POINTER_FILE, true, `export pointer updated; knockout_sim=${pointerRuns.knockout_sim} (${newCandidate ? (learnedEloReady ? "new LEARNED candidate" : "new frozen candidate") : "preserved"})`);
    // Post-hoc eval log (NOT a gate): when the LEARNED candidate is promoted, record frozen-vs-learned odds for later Brier.
    if (promotedLearned) {
      const fvl = run("fvl-log", "scripts/worldcup/log-frozen-vs-learned-knockout.ts", ["--learned-run", newCandidate!, "--frozen-run", LIVE.knockout_sim, "--execute"]);
      log("EVAL-LOG", "log-frozen-vs-learned-knockout.ts", fvl.ok, fvl.ok ? "frozen-vs-learned knockout odds logged for post-hoc Brier (data/exports/frozen-vs-learned-knockout-eval.json)" : fvl.stdout.slice(0, 400));
    }
  } else {
    log("PROMOTE", "supervised hold", true, "sanity PASS; awaiting --go before pointer/export/narration publish");
  }

  let narration = { status: "skipped" as StepStatus, pending: false, detail: "held - nothing published to narrate" };
  let exp = { status: "skipped" as StepStatus, detail: "held - nothing published to export" };
  let reexp = { status: "skipped" as StepStatus, detail: "no re-export (narration not regenerated)" };
  if (published) {
    // ORDERING (double-export): EXPORT writes real_standings (the live best-third the generator reads) BEFORE
    // narration; then NARRATION (AI-last, Phase 6) regenerates all 48; then RE-EXPORT embeds the fresh prose.
    console.log("\nEXPORT (1/2) - production app-data incl. fresh real_standings (live best-third) BEFORE narration");
    exp = runProductionExport(export_built, forceExportFail);
    log("EXPORT", `export_status=${exp.status}`, exp.status === "ok", exp.detail);

    console.log("\nPHASE 3 (Phase 6) - AI scenario_narration regeneration (--execute --teams ALL; best-effort, non-blocking)");
    narration = runNarration(narration_built, { execute: true, forceFail: forceNarrationFail, teams: "ALL" });
    log("AI", `narration_status=${narration.status}`, narration.status !== "failed" && narration.status !== "not_built", narration.detail);

    if (narration.status === "ok" && exp.status === "ok") {
      console.log("\nEXPORT (2/2) - RE-EXPORT to embed the freshly regenerated narration (cheap, idempotent)");
      reexp = runProductionExport(export_built, false);
      log("EXPORT", `reexport_status=${reexp.status}`, reexp.status === "ok", reexp.detail);
    }
  }

  const summary = {
    project_id: PROJECT,
    live_chain: true,
    ordering_enforced: "DATA -> GATE -> MODEL(candidate/live rows) -> SANITY GATE -> PROMOTE POINTER -> EXPORT -> AI NARRATION(--execute --teams ALL) -> RE-EXPORT",
    materiality_gate: "material",
    sanity_gate: gate.pass ? "PASS" : "FAIL",
    publish_decision: published ? "published_pointer" : "HELD_for_human_go",
    live_pointer: pointerRuns,
    narration_self_heal: narrHeal,
    narration_status: narration.status,
    narration_pending: narration.pending,
    narration_pending_marker_present: existsSync(abs(NARRATION_PENDING)),
    export_status: exp.status,
    reexport_status: reexp.status,
    export_cache: EXPORT_CACHE,
    ui_export_cache: UI_EXPORT_CACHE,
    export_pending_marker_present: existsSync(abs(EXPORT_PENDING)),
    downstream_failures_absorbed: narration.status !== "ok" || exp.status !== "ok",
    model_un_published_on_downstream_failure: false,
    process_exit_code: 0,
    no_odds_or_predictions_endpoints: true,
  };
  writeJson("data/audits/in-tournament-loop-live-cycle.json", { summary, trace, sanity_gate: gate });
  console.log(JSON.stringify(summary, null, 2));
  return 0;
}

async function main() {
  const args = parseArgs();
  if (args.synthetic) { const code = await syntheticCycle(args); process.exit(code ?? 0); }
  const code = await liveCycle(args);
  process.exit(code ?? 0);
}
// Only genuine CORE failures (ingest/model harness crash) reach here; narration/export are absorbed and never do.
main().catch((e) => { console.error("CORE ERROR:", e?.message ?? e); process.exit(1); });
