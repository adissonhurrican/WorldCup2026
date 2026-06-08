# In-Tournament Automatic Re-Run Loop — Runbook

Project: `ahcfrgxczbgdvrqmbisw` · Runner: `scripts/worldcup/live/in-tournament-loop-runner.ts`
**Integration only** — reuses existing pieces; no model/Elo-slope change; no odds/predictions endpoints; CLI writes only.

## The cycle (per finished match), ordering enforced
`DATA → MATERIALITY GATE → MODEL(candidate) → SANITY GATE → PROMOTE → AI → EXPORT`

| # | Phase | Reused piece | Candidate/live |
|---|---|---|---|
| 1 | Detect + ingest (K=60 verified), event-log, dedupe on fixture + `source_payload_hash` | `ingest-wc2026-results.ts --execute` + `tournament_event_log` | writes results+standings+log |
| 2 | Materiality gate | `live-update-orchestrator.ts` gate | verified result = material; lineups/cards/injuries = context_only → log & stop |
| 3 | Regenerate bundle | dynamic-draw predictor, `elo-update-engine` (K=60), group sim, `live-group-stage-bracket-resimulation-consumer.ts --execute`, `build-advancement-scenario-v1-live.ts --execute` | **candidate-only** |
| 4 | **SANITY GATE** | new code in runner | sums (12/24/8/32) · direction (winner ↑/=, loser ↓/=) · cross-group isolation · no nulls · row counts · no errors. **Any fail → HALT, no repoint, notify.** |
| 5 | Promote | established repoint-pointer + `source_snapshot.lifecycle` markers | supervised: **hold for `--go`**; unattended: auto |
| 6 | AI "what changed" | `ai-layer/validate-and-repair.ts` | only validated output stored |
| 7 | Export app-data | live advancement export (IDs stripped) | live runs only |

## Modes (single flag, default supervised)
- `--mode supervised` (default): runs everything through the sanity gate automatically; on PASS it **waits for an explicit `--go`** before repointing live. Human eyes the first real results before publish.
- `--mode unattended`: sanity-PASS auto-publishes. Flip after ~3–4 clean real cycles.

## Sanity gate (the seatbelt)
Halts the cycle before go-live if **any** check fails:
1. Sums: Σwin≈12, Σtop-2≈24, Σbest-thirds≈8, Σadvance≈32.
2. Direction: the winning team's advance % must rise-or-hold; the loser's fall-or-hold (flags a result that moved probabilities the wrong way).
3. Cross-group isolation: a result must not move unaffected groups' win/top-2.
4. No null/garbage/partial values; expected row counts (48 teams).
5. No regeneration errors / non-zero exit from any reused harness.

## Per-cycle promotion discipline (preserved)
Candidate → sanity → promote → rollback-ready. Prior runs **preserved** (`lifecycle=superseded`), never deleted. The `mc_never_current_best` / `tas_never_current_best` CHECK constraints stay intact; "live" = the pointer file `data/exports/live-runs-pointer.json` + `source_snapshot.lifecycle` markers + repointed `SOURCE_*` constants. Each cycle writes a rollback file.

## Graceful degradation — narration & export (read this before reacting to a `failed`)
Narration (Phase 6) and export (Phase 7) run **after** promote, so they can never block or un-publish the model. Both are **best-effort and non-blocking** — wrapped so a failure is logged and the cycle continues. **The published probabilities are correct regardless of what these two report.**

**Status fields** (in each cycle summary → `data/audits/in-tournament-loop-synthetic-cycle.json`): `narration_status` / `export_status` =
- **`ok`** — ran cleanly.
- **`pending`** — deferred this cycle; queued for automatic re-attempt next cycle.
- **`failed`** — threw this cycle; **absorbed** (logged, marked pending), cycle continued.
- **`not_built`** — the downstream piece isn't wired yet; reported **honestly, not faked `OK`**; marked pending.
- Companion flags: `narration_pending`, `export_pending_marker_present`, `model_un_published_on_downstream_failure` (always `false`), `process_exit_code` (`0`).

**Normal vs. needs-attention — do NOT panic on a `failed`.** A `failed` / `pending` / `not_built` on narration **or** export is **expected and non-alarming**: the model still **published** (or **held**, in supervised) and the **cycle exits 0**. **Do not intervene or manually re-publish — it's the seatbelt working.** The live prediction is unchanged and correct.

**Self-heal (export) — the user-visible guarantee.** The **live DB pointer + `source_snapshot.lifecycle` markers are the source of truth**; the exported JSON is a **cache**. A failed/missed export writes a pending marker (`data/exports/.live-export-pending.json`) and is **re-attempted at the start of the next cycle** (re-reads the live pointer). So a transient export failure **heals automatically on the next match — no manual re-export.** Current UI delivery depends on the exported app-data handoff; the runner now writes `data/exports/app-data.json` via the production exporter and copies it to `ui/app-data.json`, which is the path the browser reads.

**Narration backfill.** `narration_pending` is fine — **published probabilities never wait on prose.** A later cycle/retry fills the "what changed" narration. Marker: `data/exports/.narration-pending.json`.

**When to actually worry** (the only narration/export-adjacent things that need a human):
1. A **CORE** failure — ingest or model-regeneration harness crash, or the runner **exits non-zero** (narration/export never cause a non-zero exit).
2. The **sanity gate HALTs** (a genuinely bad regeneration — see *Sanity gate* above; live runs are left unchanged).
3. An **export stuck `pending` across several consecutive cycles** — that means the export piece is genuinely broken (not transient). Fix the export script. The app is still correct via the live pointer, so this is a stale-cache repair, not an emergency.

Validated 2026-06-04: forced narration+export failures were absorbed (statuses `failed`, exit `0`, model published, live unchanged); a pending export **self-healed** on the next cycle; `--demo-not-built` reported `not_built` honestly (no fake `OK`).

## Synthetic end-to-end (validated 2026-06-04)
`npx tsx scripts/worldcup/live/in-tournament-loop-runner.ts --synthetic-result --mode supervised`
Feeds CAN 2-1 BIH through the chain (no DB writes). Result: gate=material; candidate regeneration runs; **sanity gate PASS** (sums 12/24/8/32 across 4 conditioned steps; direction CAN advance 0.734→0.836 ↑; isolation clean; 48 teams; no errors); **supervised held for `--go`**; unattended auto-publishes. Output: `data/audits/in-tournament-loop-synthetic-cycle.json`.

## Scheduler
No live cron is active (no finished matches before 2026-06-11). At kickoff, schedule the runner to poll on an interval, **supervised**:
```
# every 10 min during the tournament (supervised — holds for --go before publish)
*/10 * * * *  cd "<repo>" && npx tsx scripts/worldcup/live/in-tournament-loop-runner.ts --mode supervised
```
The cycle is idempotent (dedupe on fixture + result hash), so re-polling an already-processed match is a no-op.

2026-06-04 scheduler update: the staged cron entry is now `ops/cron/wc2026-in-tournament-loop-supervised.cron`. It calls `scripts/worldcup/live/run-supervised-loop-cron.mjs`, which no-ops until `2026-06-11T19:00:00Z` and then runs `in-tournament-loop-runner.ts --mode supervised` without `--go`.

2026-06-05 live-chain update: the code-level live chain is now connected through the runner, production export, and UI data-file bridge. Keep supervised mode for launch; do not switch to unattended until several real match cycles pass cleanly. See `docs/in-tournament-loop-live-chain-verification-2026-06-04.md`.

## Post-match-1 rollout
1. **Opener (2026-06-11), supervised:** let the loop ingest → gate → regenerate → sanity-gate the first real result. Human reviews the candidate + the "what changed" narration, then `--go` to publish. Confirm the app export updates and the rollback file exists.
2. **Matches 2–4, supervised:** repeat; confirm sums/direction/isolation hold on real results and the AI narration validates each time.
3. **After ~3–4 clean cycles:** flip `--mode unattended`. Sanity-PASS now auto-publishes; the gate still halts on any anomaly.
4. **Any HALT:** loop stops before publish, notifies, leaves live runs unchanged — investigate the flagged check, fix data/re-run, do not override the gate.
