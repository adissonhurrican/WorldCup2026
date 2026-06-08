/* write-live-scores.ts — LIVE-SCORES SIDE JOB (display-only commodity data).
 *
 * PROJECT: ahcfrgxczbgdvrqmbisw
 *
 * WHAT IT DOES
 *   Polls API-Football's LIVE in-play feed for WC2026 fixtures currently in play and writes
 *   ui/live-scores.json in the exact shape the UI's matchState() reads. When a match finishes it
 *   drops from the feed (the UI then falls back to OUR verified result from the export). Writes an
 *   empty match list when nothing is live. After the score file writes, it best-effort refreshes
 *   events.json from stored api_football_fixture_events rows so the match sheet timeline updates on
 *   the same display cadence whenever the server-side event ingester has stored rows.
 *
 * HARD SEPARATION (guardrails) — this is NOT the prediction loop:
 *   - DISPLAY-ONLY. Its outputs are static JSON overlays (live-scores.json plus best-effort
 *     events.json). It writes no DB table, no result, no standing, no prediction; it never triggers
 *     the loop and never feeds the materiality gate.
 *   - The prediction loop (ingest-wc2026-results.ts) polls /fixtures for VERIFIED FINALS (FT/AET/PEN),
 *     applies the K=60 material gate, and is what moves predictions. THIS job polls live in-play
 *     scores only — never material, never moves predictions. Two pollers, two purposes, no shared path.
 *   - Endpoint is livescore/fixtures-in-play ONLY (/fixtures?live=all). NO odds, NO predictions endpoints.
 *
 * RUN
 *   npx tsx scripts/worldcup/live/write-live-scores.ts --once            # single poll (default)
 *   npx tsx scripts/worldcup/live/write-live-scores.ts --watch           # poll every 30s (match windows)
 *   npx tsx scripts/worldcup/live/write-live-scores.ts --watch --interval 45
 *   npx tsx scripts/worldcup/live/write-live-scores.ts --once --dry-run  # fetch + transform, no write
 *
 * CRON (separate from the prediction loop's cron): schedule every 30–60s during match windows,
 *   activates 2026-06-11. See docs/kickoff-checklist.md.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ID = "ahcfrgxczbgdvrqmbisw";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.cwd();
const APP_DATA_PATH = path.join(ROOT, "data", "exports", "app-data.json");
const API_FIXTURE_CACHE_PATH = path.join(ROOT, "data", "external", "api-football", "cache", "fixtures_league1_season2026.json");

/* API-Football fixture.status.short values that mean "currently in play". FT/AET/PEN (finished),
 * NS/TBD/PST/CANC (not started) are intentionally excluded so finished matches drop from the feed. */
const IN_PLAY = new Set(["1H", "HT", "2H", "ET", "BT", "P", "LIVE", "INT", "SUSP"]);

type ApiFixture = {
  fixture?: { id?: number; status?: { short?: string; elapsed?: number | null } };
  league?: { id?: number; season?: number };
  teams?: { home?: { id?: number; name?: string }; away?: { id?: number; name?: string } };
  goals?: { home?: number | null; away?: number | null };
};
type LiveEntry = { api_fixture_id?: number; home: string; away: string; status: "live"; minute: number | null; home_score: number; away_score: number };
type FixtureOrder = { home: string; away: string };

function pairKey(a: string, b: string) {
  return [a, b].sort().join("|");
}

function apiFixtureRowsFromCache(): ApiFixture[] {
  if (!existsSync(API_FIXTURE_CACHE_PATH)) return [];
  const doc = JSON.parse(readFileSync(API_FIXTURE_CACHE_PATH, "utf8"));
  const rows = doc?.response?.response ?? doc?.response ?? [];
  return Array.isArray(rows) ? rows : [];
}

// Build api_fixture_id -> OUR exported fixture order from static files only.
export function loadFixtureOrderByApiId(codeMap: Record<string, string>): Record<string, FixtureOrder> {
  if (!existsSync(APP_DATA_PATH)) return {};
  const app = JSON.parse(readFileSync(APP_DATA_PATH, "utf8"));
  const exported = new Map<string, FixtureOrder>();
  for (const fx of app?.fixtures ?? []) {
    if (fx?.home && fx?.away) exported.set(pairKey(String(fx.home), String(fx.away)), { home: String(fx.home), away: String(fx.away) });
  }
  const orderByApiId: Record<string, FixtureOrder> = {};
  for (const row of apiFixtureRowsFromCache()) {
    const id = row?.fixture?.id;
    const apiHome = codeMap[String(row?.teams?.home?.id)];
    const apiAway = codeMap[String(row?.teams?.away?.id)];
    if (id == null || !apiHome || !apiAway) continue;
    const order = exported.get(pairKey(apiHome, apiAway));
    if (order) orderByApiId[String(id)] = order;
  }
  return orderByApiId;
}

/* PURE transform — unit-testable without any network. Maps API-Football live fixtures to the UI's
 * code-keyed entries (home/away = our FIFA codes), keeping only WC (league 1) in-play matches. */
export function liveFixturesToEntries(apiFixtures: ApiFixture[], codeMap: Record<string, string>, leagueId = 1, fixtureOrderByApiId: Record<string, FixtureOrder> = {}) {
  const entries: LiveEntry[] = [];
  const skipped: Array<{ id?: number; reason: string; home?: string; away?: string }> = [];
  for (const f of apiFixtures || []) {
    if ((f.league?.id ?? null) !== leagueId) continue;            // WC only
    const short = f.fixture?.status?.short ?? "";
    if (!IN_PLAY.has(short)) continue;                            // in-play only; finished/not-started dropped
    const apiFixtureId = f.fixture?.id;
    const providerHome = codeMap[String(f.teams?.home?.id)];
    const providerAway = codeMap[String(f.teams?.away?.id)];
    if (!providerHome || !providerAway) { skipped.push({ id: apiFixtureId, reason: "unmapped_team", home: f.teams?.home?.name, away: f.teams?.away?.name }); continue; }
    const order = (apiFixtureId != null ? fixtureOrderByApiId[String(apiFixtureId)] : null) ?? { home: providerHome, away: providerAway };
    const scoreByCode = new Map<string, number>([
      [providerHome, f.goals?.home ?? 0],
      [providerAway, f.goals?.away ?? 0],
    ]);
    const homeScore = scoreByCode.get(order.home);
    const awayScore = scoreByCode.get(order.away);
    if (homeScore === undefined || awayScore === undefined) {
      skipped.push({ id: apiFixtureId, reason: "fixture_order_team_mismatch", home: f.teams?.home?.name, away: f.teams?.away?.name });
      continue;
    }
    entries.push({
      api_fixture_id: apiFixtureId,
      home: order.home, away: order.away, status: "live",
      minute: typeof f.fixture?.status?.elapsed === "number" ? f.fixture!.status!.elapsed! : null,
      home_score: homeScore,
      away_score: awayScore,
    });
  }
  return { entries, skipped };
}

function loadKey(): string {
  if (process.env.API_FOOTBALL_KEY) return process.env.API_FOOTBALL_KEY;
  try { const m = readFileSync(path.join(ROOT, ".env.example"), "utf8").match(/API_FOOTBALL_KEY\s*=\s*(\S+)/i); if (m) return m[1]; } catch { /* ignore */ }
  throw new Error("API_FOOTBALL_KEY not set (env or .env.example).");
}
function loadMap(): Record<string, string> {
  const raw = JSON.parse(readFileSync(path.join(__dirname, "api-team-code-map.json"), "utf8")) as Record<string, string>;
  const map: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (k !== "_comment" && /^\d+$/.test(k)) map[k] = v;
  return map;
}

function parseArgs() {
  const a = process.argv.slice(2);
  const intIdx = a.indexOf("--interval");
  return {
    watch: a.includes("--watch"),
    dryRun: a.includes("--dry-run"),
    intervalSec: intIdx >= 0 ? Math.max(15, Number(a[intIdx + 1]) || 30) : 30,
    out: (() => { const i = a.indexOf("--out"); return i >= 0 ? a[i + 1] : path.join(ROOT, "ui", "live-scores.json"); })(),
    league: (() => { const i = a.indexOf("--league"); return i >= 0 ? Number(a[i + 1]) : 1; })(),
    season: (() => { const i = a.indexOf("--season"); return i >= 0 ? Number(a[i + 1]) : 2026; })(),
  };
}

async function refreshEventsOverlay(dryRun: boolean) {
  if (dryRun) return;
  try {
    const { exportEvents } = await import("./export-events.mjs");
    const ex = await exportEvents();
    console.log(`[events] wrote ${ex.events} event(s) across ${ex.matches} match(es) -> ${ex.written.join(", ")}`);
  } catch (e: any) {
    console.error(`[events] export failed/non-blocking: ${e?.message ?? e}`);
  }
}

async function pollOnce(key: string, map: Record<string, string>, args: ReturnType<typeof parseArgs>): Promise<boolean> {
  const url = `https://v3.football.api-sports.io/fixtures?live=all&league=${args.league}&season=${args.season}`;
  let j: any;
  try {
    const r = await fetch(url, { headers: { "x-apisports-key": key, accept: "application/json" } });
    if (!r.ok) { console.error(`[live] HTTP ${r.status} — preserving last file, not overwriting.`); return false; }
    j = await r.json();
  } catch (e: any) {
    console.error(`[live] fetch error: ${e?.message ?? e} — preserving last file, not overwriting.`); return false;
  }
  if (j?.errors && Object.keys(j.errors).length) console.error(`[live] api errors: ${JSON.stringify(j.errors)}`);
  const fixtureOrderByApiId = loadFixtureOrderByApiId(map);
  const { entries, skipped } = liveFixturesToEntries(j?.response || [], map, args.league, fixtureOrderByApiId);
  const payload = {
    as_of: new Date().toISOString(),
    source: "API-Football livescore (in-play) — display-only; never a prediction input",
    note: "Cleared when a match finishes; the UI then shows our verified result from the export.",
    matches: entries,
  };
  if (args.dryRun) {
    console.log(`[live] DRY-RUN — would write ${entries.length} live match(es)${skipped.length ? `, skipped ${skipped.length} unmapped` : ""}.`);
    console.log(JSON.stringify(payload, null, 2));
    return true;
  }
  mkdirSync(path.dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(payload, null, 2) + "\n");
  console.log(`[live] wrote ${entries.length} live match(es) -> ${path.relative(ROOT, args.out)}${skipped.length ? ` (skipped ${skipped.length} unmapped: ${skipped.map((s) => `${s.home}-${s.away}`).join(", ")})` : ""}`);
  await refreshEventsOverlay(args.dryRun);
  return true;
}

async function main() {
  const args = parseArgs();
  console.log(`PROJECT ID: ${PROJECT_ID} | live-scores side job (DISPLAY-ONLY; separate from the prediction loop; no odds/predictions). out=${path.relative(ROOT, args.out)} ${args.watch ? `watch=${args.intervalSec}s` : "once"}${args.dryRun ? " dry-run" : ""}`);
  const key = loadKey();
  const map = loadMap();
  await pollOnce(key, map, args);
  if (!args.watch) return;
  let running = false;
  setInterval(async () => { if (running) return; running = true; try { await pollOnce(key, map, args); } finally { running = false; } }, args.intervalSec * 1000);
}

// Only run when invoked directly (so the pure transform can be imported by tests without polling).
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) main().catch((e) => { console.error("ERROR:", e?.message ?? e); process.exit(1); });
