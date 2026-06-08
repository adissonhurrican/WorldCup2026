# WC2026 Kickoff Checklist

Project: `ahcfrgxczbgdvrqmbisw`. Today: 2026-06-04. Tournament opens **2026-06-11** (match 1).

Consolidated list of near-kickoff / launch-window / post-match-1 tasks so none is lost in the rush. Each entry: trigger → action → script/path → status. **All are scoped to read/verify or AI-context-only loads unless explicitly stated; none change the live predictor (none_elo_only) or adopt the v1.4 strength candidate.**

## 1. Squad re-verification at lock — trigger: **June 11+ (and rolling until each team's first match)**
- Re-pull official FIFA final squads; diff vs the current verified **1,248** (48×26).
- Apply any injury replacements: verify + API-map the new player, flag the replaced player (don't hard-delete — `wc2026_status`/`review_status` flag, per the surplus-preservation convention).
- Then run the **exhaustive per-player name-diff** against the FINAL official list (needs the FIFA CSV saved to a path, e.g. `c:/tmp/FIFA_WC2026_squads.csv` — the count/structure/DOB reconciliation already passed; only the full name-by-name diff is outstanding).
- **Resolve the 6 unconfirmable commons** against the final list via the recent-friendly `/fixtures/players` lineups: IRQ Ali Jassim (#542644), KSA Jehad Thikri (#543059), IRQ Zaid Ismail (#626479), QAT Alhussein (#542542), QAT Ayoub Aloui (#542548), QAT Issa Laye Gueye (#542536).
- Status: ☐ pending (lock not reached).

## 2. FIFA ranking refresh — trigger: **next FIFA ranking release (pre-tournament)**
- Insert a new **dated** ranking snapshot (do not overwrite prior); then **regenerate advancement scenarios** off the refreshed ranks.
- Status: ☐ pending. (Memory: dated-snapshot convention.)

## 3. Weather forecast (7-day window + honest confidence) — trigger: **scheduled refresh during the tournament**
- **Window extended 72h → 168h (7 days)** — Open-Meteo's free horizon (default 7d, 16 max; no key for non-commercial). The fetch refuses fixtures outside the 7-day window or in the past.
- **Honest confidence** stamped from fetch lead time: **high ≤48h, medium 2–4d, low/early 5–7d**. The overlay carries `confidence` (+ `lead_hours`); the UI shows it ("Forecast" / "Forecast firming up" / "Early forecast — may change", with a colored dot, and the match-card chip muted when far out) so a 7-day-out forecast is never shown as certain. Re-running closer to kickoff lifts the confidence.
- **feels-like added:** the fetch now requests `apparent_temperature` → `feels_like_c` populates the "Feels like" line (useful for the hot venues — Dallas/Houston/Monterrey).
- **Run (one shot, ready for cron/Actions):** `node scripts/worldcup/weather/refresh-weather.mjs` (fetch 7d → rebuild overlay). Or the two steps: `fetch-venue-weather.mjs --fetch --all-imminent --window-hours 168` then `build-weather-overlay.mjs --write`. The overlay `weather.json` syncs to **all 4 locations** (`data/exports/`, `ui/`, `ui-v2/public/`, `ui-v2/dist/`) like squads/lineups.
- **Scheduled refresh (TODO — wire in the GitHub Actions task):** run `refresh-weather.mjs` **daily**, and **more often (e.g. every 6–12h) within ~48h of kickoff** so confidence climbs to "high" and forecasts update. Display-only; never touches the model.
- Done 2026-06-06: real forecasts populated for the 5 in-window openers (MEX-RSA, KOR-CZE, CAN-BIH, USA-PAR, QAT-SUI), all "low" (5–7d out) — stub replaced; UI renders real data + confidence. Status: ☑ built + populated / ☐ wire the scheduled refresh in Actions.

## 4. xG coverage re-check — trigger: **post-match-1 (after 2026-06-11)**
- Confirm API-Football populates `expected_goals` for WC2026 fixtures (coverage is provider-dependent and often lights up once matches are played).
- Status: ☐ pending.

## 5. Events / cards re-check — trigger: **post-match-1 (after 2026-06-11)**
- Confirm fixture `events` populate; verify the **card-type → deduction** encoding feeding `computeFairPlay` (yellow / second-yellow / red point values) against real event data.
- Status: ☐ pending.

## 6. Migration-history reconciliation — trigger: **separate deliberate task (no date)**
- **`tournament_event_log` is LIVE** — verified 2026-06-04 read-only: `table_exists=true`, **RLS on**, **12 indexes**, **0 rows**. It was applied **directly via execSql**; do **NOT** re-apply.
- The residual is record-keeping only: the file is named **`DRY_RUN_ONLY_20260604_tournament_event_log.sql`** and the migration is **NOT in `schema_migrations`** (`migration_recorded: []`). Reconcile = rename to a real migration + record it in `schema_migrations`, and normalize duplicate version prefixes across the history.
- This **corrects the stale "not applied" note** in `docs/api-football-update-map.md` (gap #1) — the table exists and works; only the migration record is missing. Non-blocking.
- Status: ☐ pending.

## 7. (CONDITIONAL) Thin-team strength recompute post-merge — trigger: **only if usage is later fetched for the 37 newly-mapped players**
- **Per the 2026-06-04 verification: NOT needed now.** The 37-player soft-duplicate merge did **not** change any team's v1.3 strength inputs:
  - Zero `national_team_usage_records` exist for the 37 newly-mapped `api_player_id`s.
  - `v1.3-usage-clean` **neutralizes** `recent_national_usage_score` (null) for **all** 1,248 players — usage volume does not drive strength.
  - All 37 were already in the v1.3 build with neutral usage; a recompute today would be identical.
- So recompute is only warranted **if** a future usage-fetch populates usage for those 37 api_ids (then: candidate-only, AI-context, snapshots flagged not overwritten).
- Status: ☑ not required as of 2026-06-04 (re-evaluate only after a usage fetch).

## 8. Enable the live-update orchestrator `--execute` path — trigger: **opener day (2026-06-11)**
- `scripts/worldcup/live/live-update-orchestrator.ts` currently **blocks `--execute`** (synthetic/dry-run scaffold: *"--execute is intentionally blocked … no live matches before 2026-06-11"*). Enable the live execute path so the per-match cascade (results → standings/Elo → candidate predictions/MC → AI) fires on real fixtures, gated by the materiality rule (only verified results are material).
- **Real pre-kickoff action.** Status: ☐ pending.

## 9. `api_football_fixture_player_stats` ingestion — trigger: **post-match-1 (verify WC2026 coverage)**
- The per-match results enrichment (`ingest-wc2026-results.ts`) now fetches `/fixtures/players`, parses post-match player stats into `api_football_fixture_player_stats`, and records `player_stats_status` / `player_stats_count` in `wc2026_fixture_enrichment_status`.
- Context-only: player ratings/stats never move probabilities and are not prediction inputs. Pre-kickoff dry-run on real fixture `1379342` parsed 40 player-stat rows; post-match-1 still verifies WC2026 endpoint coverage. Status: ☑ wired / ☐ verify live coverage.

## 11. Start the live-scores side job cron — trigger: **opener day (2026-06-11); during match windows**
- `scripts/worldcup/live/write-live-scores.ts` polls API-Football's live in-play feed and writes `ui/live-scores.json` for the UI. Schedule a **separate cron from the prediction loop**, every 30–60s during match windows: `npx tsx scripts/worldcup/live/write-live-scores.ts --watch --interval 30`.
- **DISPLAY-ONLY and fully separate:** writes ONLY `ui/live-scores.json`; never a prediction input; never triggers the loop or the materiality gate; livescore/in-play endpoint only (no odds/predictions). The loop's result-ingestion (verified finals, K=60 material gate) is a different poller with a different purpose — they must not cross.
- Verified 2026-06-04: pure transform unit-tested (8/8 cases); live connectivity OK (0 live now → empty feed); team map `scripts/worldcup/live/api-team-code-map.json` covers 48/48. Status: ☑ built + tested / ☐ schedule the cron at kickoff.

## 12. Start the lineup pipeline (pre-match XIs + post-match player stats) — trigger: **opener day (2026-06-11); per fixture in its T-60 window**
- **Pre-match lineups (the new capability / parked-spec gap):** `node scripts/worldcup/live/fetch-match-lineups.mjs --watch --interval 600 --export` polls `/fixtures/lineups` in each fixture's **T-60 → kickoff** window, stores the confirmed XIs in `api_football_fixture_lineups`, then refreshes `lineups.json` to every UI location. Identity is alias-safe (team resolved by **numeric** API id → FIFA code, so USA/CPV are correct — no name-matching bug); writes are **idempotent** (stable `source_lineup_hash`); a fixture is **skipped once both XIs are in**; the **"not published yet" empty state is graceful** (logged, no error, no write). Server-side key (`x-apisports-key`), **no client widget**.
- **Post-match player stats (reuse):** `node scripts/worldcup/live/fetch-match-lineups.mjs --post-match --fixture <id>` (or windowed via `--post-match`) pulls `/fixtures/players` into `api_football_fixture_player_stats` — the **same table** item #9's `ingest-wc2026-results.ts` already writes, and the **same rows the squad build's Layer 2 reads** (goals / cards / minutes, joined to internal players via `api_football_player_identity_map`). **One fetch path feeds both** the match-card lineup AND the squad per-player status.
- **Export:** `node scripts/worldcup/live/export-lineups.mjs` rebuilds `lineups.json` from the DB (→ `ui/`, `ui-v2/public/`, `ui-v2/dist/`, plus `data/exports/`), keyed `HOME_AWAY` and **oriented by FIFA code, not the provider's home/away** (same discipline as `live-scores.json`). The match card reads `lineups.json` only and shows the **"~60 min before kickoff" placeholder** until a fixture's XI exists. **DISPLAY-ONLY** — never a prediction/standing/odds input.
- **Call budget:** ≈10 requests/game (≈6 T-60 lineup polls at 10-min cadence + ≈4 post-match) ≈ **1,040 for the whole tournament** — trivial vs 75k/day. Guarded by `--max-requests` (default 60/cycle); already-confirmed fixtures are skipped to avoid waste. Read-only preview anytime: `--dry-run`.
- Verified 2026-06-06 (isolated, DB read-only except a scoped insert→delete on test fixture `1489369`): **18/18 e2e checks pass** — transforms, alias-safe resolution, graceful empty, idempotent upsert, orientation (with provider home/away deliberately reversed), squad-stats join, and full restore to baseline (`lineups=207`, `pstats=199`); empty `lineups.json` shipped to all 4 locations; v2 UI builds clean. Status: ☑ built + tested / ☐ schedule the cron at kickoff.

## 13. Squad card stats + availability refresh — trigger: **AUTO post-match (rides item #12's post-match pull)**
- **Auto-refresh (wired):** when `fetch-match-lineups.mjs --post-match` stores player stats, it now calls `buildSquadsJson()` in the same cycle (mirrors the lineups export-after-pull pattern; non-blocking try/catch). So `squads.json` per-player **minutes / goals / assists / cards** refresh automatically after each matchday — no manual step. Manual fallback if ever needed: `node scripts/worldcup/export/build-squads-json.mjs`.
- **Availability / injuries (wired end-to-end):** `build-squads-json.mjs` reads `player_status_events` (latest **tournament-scope**, **non-rejected** event per player; joined by the **internal `players.id`** — alias-safe, no api-id mapping needed) → adds a per-player `availability {status: out/doubtful/suspended, severity, expected_return, review_status}` to `squads.json`. The Squad card shows an availability **chip** (pending seeds render muted/unconfirmed, confirmed render amber). Today: the 2 vetted CAN seeds (Davies, Bombito — `doubtful`, `pending`) show; everyone else is clean. **Display-only — `review_status='pending'` events never touch prediction math** (that stays gated on a future approved availability model).
- **UI:** `MyTeamView` SquadPanel renders minutes+assists (graceful — only once a player has appeared) and the availability chip; the existing goals/cards (`PlayerStatus`) rendering is unchanged. UI reads `squads.json` only.
- Status: ☑ built + tested 2026-06-06 (isolated synthetic stat → render → restore; 2 CAN injuries surface; v2 build clean) / auto-refresh rides the item #12 post-match cron.

---

## 10. Post-launch lambda naming refactor - trigger: **after launch, deliberate schema pass**
- `match_predictions.team_a_expected_goals` and `team_b_expected_goals` are model Poisson lambdas: pre-match predicted goal-rate parameters fitted from the predictor output. They are **not observed xG**.
- Observed xG belongs only in the post-match statistics/enrichment layer (`api_football_fixture_statistics`, and `match_performance_metrics.xg_for/xg_against` when populated).
- Live DB column comments were applied 2026-06-04 to make this explicit at the schema level.
- Post-launch tech debt: rename `team_a_expected_goals` / `team_b_expected_goals` to `team_a_poisson_lambda` / `team_b_poisson_lambda`, updating Monte Carlo, scenario, display, and audit consumers in one coordinated pass. Do not rename before kickoff.
- AI wording rule: user-facing narration must call these values "predicted goal rate", "model goal-rate parameter", or "model expected scoreline" when exposed. Reserve "xG" for observed provider xG only.
- Status: post-launch refactor recorded; non-blocking.

---

### Verification reference (2026-06-04, read-only)
- Active strength data = `team-strength-final-squad-v1.3-usage-clean-all48` (48 teams, 1/team) + `player-impact-final-squad-v1.3-usage-clean-all48` (1,248 = 26/team, 48 teams). Prior versions (v1.0/v1.1/v0.x) exist but are isolated by `model_version` — not mixed into the active set.
- Usage integrity: usage records are confirmed-players-only (0 non-confirmed), 0 youth/U21/women rows, `recent_national_usage_score` neutralized for all (no usage-volume contamination).
- Use-rule intact: live predictor run = `none_elo_only`; no prediction_run consumes v1.3 strength; all model_candidates `current_best=false`; `match-predictor-v1.4-strength-aware-candidate` = `recorded_not_adopted_pending_forward_validation`.
