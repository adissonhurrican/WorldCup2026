/* fetch-match-lineups.mjs — PRE-MATCH LINEUP + POST-MATCH PLAYER-STATS FETCHER (server-side).
 *
 * PROJECT: ahcfrgxczbgdvrqmbisw
 *
 * WHAT IT DOES (one fetch path, two reuses)
 *   PRE-MATCH  : for an upcoming WC2026 fixture, polls API-Football /fixtures/lineups in the
 *                T-60 -> kickoff window and stores the confirmed XIs in api_football_fixture_lineups.
 *   POST-MATCH : for a finished fixture, pulls /fixtures/players and stores per-player match stats
 *                (goals / cards / minutes / ...) in api_football_fixture_player_stats.
 *   The SAME stored rows feed BOTH the match-card lineup (via export-lineups.mjs -> lineups.json)
 *   AND the squad per-player status (the squad build's Layer 2 reads api_football_fixture_player_stats,
 *   joined to internal players through api_football_player_identity_map). DB-first => reusable,
 *   survives restarts, no re-fetching.
 *
 * HARD RULES (guardrails)
 *   - SERVER-SIDE ONLY. The API key is read from the environment / local env file and sent in the
 *     x-apisports-key header. It is NEVER printed and NEVER shipped to the client. No widget.
 *   - Endpoints are /fixtures/lineups and /fixtures/players ONLY. Odds/predictions endpoints are refused.
 *   - Identity is resolved by NUMERIC API id (team.id -> FIFA code via api-team-code-map.json; player.id
 *     stored as-is and later joined via api_football_player_identity_map). Numeric ids are alias-immune,
 *     so USA / Cape Verde resolve correctly (no name-matching => no USA/CPV-style resolution bug).
 *   - Writes are idempotent: a stable source_lineup_hash / source_player_stat_hash means re-polling the
 *     same fixture upserts in place (UNIQUE(source_provider, fixture_id, source_*_hash)).
 *   - Graceful empty state: before the XI drops the API returns no lineup -> we log and move on, no error.
 *   - This job writes NO prediction, standing, result, or odds. It is display/stat commodity data.
 *
 * RUN
 *   node scripts/worldcup/live/fetch-match-lineups.mjs --window-min 60 --dry-run   # read-only: scan window, show what would store
 *   node scripts/worldcup/live/fetch-match-lineups.mjs --window-min 60 --export    # store XIs in window, refresh lineups.json
 *   node scripts/worldcup/live/fetch-match-lineups.mjs --fixture 1489369 --export  # one fixture's lineup
 *   node scripts/worldcup/live/fetch-match-lineups.mjs --post-match --fixture 1489369  # finished fixture -> player stats
 *   node scripts/worldcup/live/fetch-match-lineups.mjs --watch --interval 600 --export # poll every 10 min (T-60 cadence)
 *
 * CRON (see docs): pre-match every ~10 min during each fixture's T-60 window; post-match once after FT.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ID = "ahcfrgxczbgdvrqmbisw";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.cwd();
const API_BASE = "https://v3.football.api-sports.io";
const CACHE_DIR = path.join(ROOT, "data", "external", "api-football", "cache");
const FORBIDDEN = /\b(?:odds|predictions?|bets?)\b/i;
const FINAL_STATUS = new Set(["FT", "AET", "PEN"]);

let requestsUsed = 0;

// ---------------- args ----------------
function parseArgs() {
  const a = process.argv.slice(2);
  const val = (flag, def) => { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : def; };
  return {
    dryRun: a.includes("--dry-run"),
    watch: a.includes("--watch"),
    postMatch: a.includes("--post-match"),
    doExport: a.includes("--export"),
    all: a.includes("--all"),                                   // ignore the window (manual backfill / testing)
    fixture: val("--fixture", null) ? Number(val("--fixture", null)) : null,
    windowMin: Number(val("--window-min", 60)),                 // start polling this many min before kickoff
    postGraceMin: Number(val("--post-grace-min", 20)),          // keep polling this many min after kickoff (late XI drops)
    intervalSec: Math.max(60, Number(val("--interval", 600))),  // watch cadence (default 10 min)
    maxRequests: Number(val("--max-requests", 60)),             // call-budget guard (~10/game)
  };
}

// ---------------- credentials (server-side only) ----------------
function loadEnvFile() {
  for (const file of [".env", ".env.local", ".env.example"]) {
    const fp = path.join(ROOT, file);
    if (!existsSync(fp)) continue;
    for (const line of readFileSync(fp, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const m = t.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;
      if (process.env[m[1]]) continue;
      const v = m[2].trim().replace(/^["']|["']$/g, "");
      if (v) process.env[m[1]] = v;
    }
  }
}
function getApiKey() {
  loadEnvFile();
  const key = process.env.API_FOOTBALL_KEY?.trim() || process.env.API_FOOTBALL_API_KEY?.trim();
  if (!key) throw new Error("API_FOOTBALL_KEY is required (env or local env file); it is never printed or shipped to the client.");
  return key;
}
function readSupabaseConfig() {
  // CI-first: use env creds (SUPABASE_DB_URL for the project ref + SUPABASE_SERVICE_ROLE_KEY) so this works on
  // GitHub Actions where supebase.txt is absent. Fall back to the local supebase.txt file when env is unset.
  const envDbUrl = process.env.SUPABASE_DB_URL;
  const envServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (envDbUrl && envServiceRoleKey) {
    const envRef = envDbUrl.match(/postgres\.([a-z0-9]+):/)?.[1] ?? envDbUrl.match(/\/\/([^.]+)\.supabase\.co/)?.[1] ?? "";
    if (envRef !== PROJECT_ID) throw new Error(`Unexpected Supabase project ref from SUPABASE_DB_URL: ${envRef || "unknown"} (expected ${PROJECT_ID})`);
    return { projectRef: envRef, restUrl: `https://${envRef}.supabase.co/rest/v1`, serviceRoleKey: envServiceRoleKey };
  }
  const text = readFileSync(path.join(ROOT, "supebase.txt"), "utf8");
  const projectRef = text.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];
  const restUrl = text.match(/https:\/\/[^\s]+\/rest\/v1\/?/)?.[0]?.replace(/\/$/, "");
  const serviceRoleKey = text.match(/service role secret\s*:\s*(\S+)/i)?.[1];
  if (projectRef !== PROJECT_ID) throw new Error(`Unexpected Supabase project ref: ${projectRef ?? "unknown"} (expected ${PROJECT_ID})`);
  if (!restUrl || !serviceRoleKey) throw new Error("Missing Supabase REST URL or service-role key in supebase.txt");
  return { projectRef, restUrl, serviceRoleKey };
}
async function sb(config, table, init = {}) {
  const res = await fetch(`${config.restUrl}/${table}${init.search ?? ""}`, {
    ...init,
    headers: {
      apikey: config.serviceRoleKey,
      authorization: `Bearer ${config.serviceRoleKey}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${table} ${res.status}: ${await res.text()}`);
  const txt = await res.text();
  return txt.trim() ? JSON.parse(txt) : null;
}

// ---------------- helpers ----------------
function loadTeamCodeMap() {
  const raw = JSON.parse(readFileSync(path.join(__dirname, "api-team-code-map.json"), "utf8"));
  const map = {};
  for (const [k, v] of Object.entries(raw)) if (/^\d+$/.test(k)) map[k] = v;   // numeric api-team-id -> FIFA code (alias-immune)
  return map;
}
const stableHash = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const responseHash = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const safeCacheName = (endpoint, params) =>
  endpoint.replace(/^\//, "").replace(/\//g, "_") + "__" + Object.entries(params).map(([k, v]) => `${k}_${String(v).replace(/[^a-z0-9_-]/gi, "_")}`).join("__") + ".json";

async function apiFootball(endpoint, params, apiKey, dryRun) {
  if (FORBIDDEN.test(endpoint)) throw new Error(`Forbidden API-Football endpoint: ${endpoint}`);
  if (requestsUsed >= ARGS.maxRequests) return { ok: false, status: null, errors: { budget: "max_requests_reached" }, response: [] };
  requestsUsed += 1;
  const url = new URL(`${API_BASE}${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  let body;
  try {
    const res = await fetch(url, { headers: { "x-apisports-key": apiKey, accept: "application/json" } });
    body = await res.json();
    const payload = {
      ok: res.ok && !(body.errors && Object.keys(body.errors).length),
      status: res.status,
      errors: body.errors ?? null,
      results: body.results ?? null,
      response: Array.isArray(body.response) ? body.response : [],
    };
    if (!dryRun) {  // raw cache for auditability (server-side only)
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(path.join(CACHE_DIR, safeCacheName(endpoint, params)),
        JSON.stringify({ retrieved_at: new Date().toISOString(), endpoint, params, ...payload }, null, 2), "utf8");
    }
    await new Promise((r) => setTimeout(r, 150));
    return payload;
  } catch (e) {
    return { ok: false, status: null, errors: String(e?.message ?? e), response: [] };
  }
}

// ---------------- transforms (pure) ----------------
// One API /fixtures/lineups response (array of team-lineup objects) -> flat rows for api_football_fixture_lineups.
export function lineupRowsFromResponse(fixtureId, response, teamCodeMap) {
  const rows = [];
  const skipped = [];
  for (const obj of response || []) {
    const apiTeamId = obj?.team?.id ?? null;
    const apiTeamName = obj?.team?.name ?? null;
    const fifa = apiTeamId != null ? teamCodeMap[String(apiTeamId)] ?? null : null;
    if (apiTeamId == null) { skipped.push({ reason: "no_team_id", team: apiTeamName }); continue; }
    if (!fifa) skipped.push({ reason: "team_id_unmapped_to_fifa_code", api_team_id: apiTeamId, team: apiTeamName });
    const formation = obj?.formation ?? null;
    const coachId = obj?.coach?.id ?? null;
    const coachName = obj?.coach?.name ?? null;
    const snapBase = { provider: "api-football", api_fixture_id: fixtureId, api_team_id: apiTeamId, resolved_fifa_code: fifa, retrieved_at: new Date().toISOString() };

    const pushPlayer = (p, role) => {
      const player = p?.player ?? {};
      rows.push({
        fixture_id: fixtureId,
        source_provider: "api-football",
        source_lineup_hash: stableHash([fixtureId, apiTeamId, role, player.id ?? null, player.number ?? null]),
        team_id: apiTeamId, team_name: apiTeamName, formation,
        coach_id: coachId, coach_name: coachName,
        player_id: player.id ?? null, player_name: player.name ?? null,
        player_number: player.number ?? null, player_position: player.pos ?? null, grid: player.grid ?? null,
        lineup_role: role,
        source_snapshot: { ...snapBase, role, player: player ?? null },
        api_response_hash: responseHash(p),
        review_status: "pending",
      });
    };
    for (const p of obj?.startXI ?? []) pushPlayer(p, "startXI");
    for (const p of obj?.substitutes ?? []) pushPlayer(p, "substitute");
    // one coach/formation marker row per team (mirrors the existing convention)
    rows.push({
      fixture_id: fixtureId, source_provider: "api-football",
      source_lineup_hash: stableHash([fixtureId, apiTeamId, "coach", coachId ?? null]),
      team_id: apiTeamId, team_name: apiTeamName, formation,
      coach_id: coachId, coach_name: coachName,
      player_id: null, player_name: null, player_number: null, player_position: null, grid: null,
      lineup_role: "coach",
      source_snapshot: { ...snapBase, role: "coach", formation, coach: obj?.coach ?? null },
      api_response_hash: responseHash(obj?.coach ?? {}),
      review_status: "pending",
    });
  }
  // confirmed = at least one team with a non-empty startXI on each side (both sides present)
  const startSides = new Set(rows.filter((r) => r.lineup_role === "startXI").map((r) => r.team_id));
  return { rows, skipped, confirmed: startSides.size >= 2 };
}

const n = (v) => (typeof v === "number" ? v : null);
const intOrNull = (v) => (typeof v === "number" ? Math.trunc(v) : null);
// One API /fixtures/players response -> flat rows for api_football_fixture_player_stats.
export function playerStatRowsFromResponse(fixtureId, response, teamCodeMap) {
  const rows = [];
  for (const teamBlock of response || []) {
    const apiTeamId = teamBlock?.team?.id ?? null;
    const apiTeamName = teamBlock?.team?.name ?? null;
    const fifa = apiTeamId != null ? teamCodeMap[String(apiTeamId)] ?? null : null;
    for (const pe of teamBlock?.players ?? []) {
      const pid = pe?.player?.id ?? null;
      const s = (pe?.statistics ?? [])[0] ?? {};
      const games = s.games ?? {}, goals = s.goals ?? {}, shots = s.shots ?? {}, passes = s.passes ?? {};
      const tackles = s.tackles ?? {}, duels = s.duels ?? {}, dribbles = s.dribbles ?? {}, fouls = s.fouls ?? {};
      const cards = s.cards ?? {}, pen = s.penalty ?? {};
      rows.push({
        fixture_id: fixtureId, source_provider: "api-football",
        source_player_stat_hash: stableHash([fixtureId, apiTeamId, pid]),
        team_id: apiTeamId, team_name: apiTeamName,
        player_id: pid, player_name: pe?.player?.name ?? null,
        position: games.position ?? null, rating: games.rating ?? null,
        captain: games.captain ?? null, substitute: games.substitute ?? null,
        minutes: intOrNull(games.minutes), number: intOrNull(games.number), offsides: intOrNull(s.offsides),
        shots_total: intOrNull(shots.total), shots_on: intOrNull(shots.on),
        goals_total: intOrNull(goals.total), goals_conceded: intOrNull(goals.conceded), assists: intOrNull(goals.assists), saves: intOrNull(goals.saves),
        passes_total: intOrNull(passes.total), passes_key: intOrNull(passes.key), passes_accuracy: passes.accuracy != null ? String(passes.accuracy) : null,
        tackles_total: intOrNull(tackles.total), tackles_blocks: intOrNull(tackles.blocks), tackles_interceptions: intOrNull(tackles.interceptions),
        duels_total: intOrNull(duels.total), duels_won: intOrNull(duels.won),
        dribbles_attempts: intOrNull(dribbles.attempts), dribbles_success: intOrNull(dribbles.success),
        fouls_drawn: intOrNull(fouls.drawn), fouls_committed: intOrNull(fouls.committed),
        cards_yellow: intOrNull(cards.yellow), cards_red: intOrNull(cards.red),
        penalty_won: intOrNull(pen.won), penalty_committed: intOrNull(pen.commited ?? pen.committed),
        penalty_scored: intOrNull(pen.scored), penalty_missed: intOrNull(pen.missed), penalty_saved: intOrNull(pen.saved),
        source_snapshot: { provider: "api-football", api_fixture_id: fixtureId, api_team_id: apiTeamId, resolved_fifa_code: fifa, player_id: pid, retrieved_at: new Date().toISOString() },
        api_response_hash: responseHash(pe),
        review_status: "pending",
      });
    }
  }
  return rows;
}

// ---------------- DB upserts (idempotent) ----------------
async function upsert(config, table, rows, onConflict) {
  if (!rows.length) return 0;
  await sb(config, `${table}?on_conflict=${onConflict}`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
  return rows.length;
}

// ---------------- fixture window selection ----------------
async function selectFixtures(config, args) {
  const fm = await sb(config, "fixture_metadata",
    { search: "?select=external_fixture_id,team_a_code,team_b_code,kickoff_at,status&tournament_code=eq.WC_2026&external_fixture_id=not.is.null" });
  const now = Date.now();
  const out = [];
  for (const f of fm || []) {
    const id = Number(f.external_fixture_id);
    if (!Number.isFinite(id)) continue;
    const ko = f.kickoff_at ? new Date(f.kickoff_at).getTime() : null;
    const minsToKo = ko != null ? (ko - now) / 60000 : null;
    const rec = { fixture_id: id, home: f.team_a_code, away: f.team_b_code, kickoff_at: f.kickoff_at, mins_to_kickoff: minsToKo };
    if (args.fixture != null) { if (id === args.fixture) out.push(rec); continue; }
    if (args.all) { out.push(rec); continue; }
    if (args.postMatch) {
      // finished, or kickoff comfortably in the past (≈ full match elapsed)
      if (minsToKo != null && minsToKo <= -110) out.push(rec);
    } else {
      // pre-match lineup window: T-windowMin .. kickoff + postGrace
      if (minsToKo != null && minsToKo <= args.windowMin && minsToKo >= -args.postGraceMin) out.push(rec);
    }
  }
  return out;
}

// which selected fixtures already have BOTH-side startXI stored (skip to save calls / stay idempotent)
async function alreadyConfirmed(config, fixtureIds) {
  if (!fixtureIds.length) return new Set();
  const rows = await sb(config, "api_football_fixture_lineups",
    { search: `?select=fixture_id,team_id,lineup_role&source_provider=eq.api-football&lineup_role=eq.startXI&fixture_id=in.(${fixtureIds.join(",")})` });
  const byFx = new Map();
  for (const r of rows || []) { const s = byFx.get(r.fixture_id) ?? new Set(); s.add(r.team_id); byFx.set(r.fixture_id, s); }
  return new Set([...byFx.entries()].filter(([, s]) => s.size >= 2).map(([k]) => k));
}

// ---------------- one cycle ----------------
async function runOnce(config, apiKey, teamCodeMap, args, confirmedSet) {
  const fixtures = await selectFixtures(config, args);
  const targets = fixtures.filter((f) => !confirmedSet.has(f.fixture_id));
  const summary = { mode: args.postMatch ? "post-match" : "pre-match", selected: fixtures.length, processed: 0, stored_rows: 0, confirmed: [], not_published: [], unmapped: [], budget_used: requestsUsed };

  if (!args.postMatch && targets.length) {
    const conf = await alreadyConfirmed(config, targets.map((f) => f.fixture_id));
    for (const id of conf) confirmedSet.add(id);
  }

  for (const fx of targets) {
    if (confirmedSet.has(fx.fixture_id)) continue;
    if (requestsUsed >= args.maxRequests) { summary.budget_capped = true; break; }

    if (args.postMatch) {
      const r = await apiFootball("/fixtures/players", { fixture: fx.fixture_id }, apiKey, args.dryRun);
      summary.processed += 1;
      if (!r.ok) { summary.not_published.push({ ...labelOf(fx), reason: `api_error:${JSON.stringify(r.errors)}` }); continue; }
      const rows = playerStatRowsFromResponse(fx.fixture_id, r.response, teamCodeMap);
      if (!rows.length) { summary.not_published.push({ ...labelOf(fx), reason: "no_player_stats_yet" }); continue; }
      if (args.dryRun) { summary.stored_rows += rows.length; summary.confirmed.push({ ...labelOf(fx), rows: rows.length, dry_run: true }); continue; }
      const stored = await upsert(config, "api_football_fixture_player_stats", rows, "source_provider,fixture_id,source_player_stat_hash");
      summary.stored_rows += stored; summary.confirmed.push({ ...labelOf(fx), player_stat_rows: stored });
    } else {
      const r = await apiFootball("/fixtures/lineups", { fixture: fx.fixture_id }, apiKey, args.dryRun);
      summary.processed += 1;
      if (!r.ok) { summary.not_published.push({ ...labelOf(fx), reason: `api_error:${JSON.stringify(r.errors)}` }); continue; }
      const { rows, skipped, confirmed } = lineupRowsFromResponse(fx.fixture_id, r.response, teamCodeMap);
      for (const s of skipped) if (s.reason === "team_id_unmapped_to_fifa_code") summary.unmapped.push({ ...labelOf(fx), ...s });
      const hasXI = rows.some((x) => x.lineup_role === "startXI");
      if (!hasXI) { summary.not_published.push({ ...labelOf(fx), mins_to_kickoff: round(fx.mins_to_kickoff) }); continue; } // graceful: XI not out yet
      if (args.dryRun) { summary.stored_rows += rows.length; summary.confirmed.push({ ...labelOf(fx), rows: rows.length, confirmed, dry_run: true }); continue; }
      const stored = await upsert(config, "api_football_fixture_lineups", rows, "source_provider,fixture_id,source_lineup_hash");
      summary.stored_rows += stored;
      summary.confirmed.push({ ...labelOf(fx), lineup_rows: stored, both_sides: confirmed });
      if (confirmed) confirmedSet.add(fx.fixture_id);   // stop polling this fixture once both XIs are in
    }
  }
  summary.budget_used = requestsUsed;
  return summary;
}

const labelOf = (fx) => ({ fixture_id: fx.fixture_id, match: `${fx.home}-${fx.away}` });
const round = (x) => (x == null ? null : Math.round(x));

// ---------------- main ----------------
const ARGS = parseArgs();
async function main() {
  console.log(`PROJECT ID: ${PROJECT_ID} | fetch-match-lineups (${ARGS.postMatch ? "post-match player stats" : "pre-match lineups"}) | server-side key | endpoints: ${ARGS.postMatch ? "/fixtures/players" : "/fixtures/lineups"} | no odds/predictions${ARGS.dryRun ? " | DRY-RUN (no DB writes)" : ""}`);
  const apiKey = getApiKey();
  const config = readSupabaseConfig();
  const teamCodeMap = loadTeamCodeMap();
  const confirmedSet = new Set();

  const cycle = async () => {
    const s = await runOnce(config, apiKey, teamCodeMap, ARGS, confirmedSet);
    console.log(JSON.stringify({ project_id: PROJECT_ID, as_of: new Date().toISOString(), ...s }, null, 2));
    if (ARGS.doExport && !ARGS.dryRun && s.stored_rows > 0) {
      if (ARGS.postMatch) {
        // FIX 3: post-match player stats were just stored -> auto-refresh squads.json so per-player
        // minutes/goals/assists/cards surface on the squad card (same proven export-after-pull pattern
        // as lineups). Non-blocking: a rebuild failure never fails the cycle.
        try {
          const { buildSquadsJson } = await import("../export/build-squads-json.mjs");
          const sq = await buildSquadsJson({ dryRun: false });
          console.log(`[squads.json] rebuilt (${sq.coverage.players} players, ${sq.coverage.with_availability_flag} availability flags) -> ${sq.written.join(", ")}`);
        } catch (e) {
          console.error(`[squads.json] rebuild failed (non-blocking): ${e?.message ?? e}`);
        }
      } else {
        const { exportLineups } = await import("./export-lineups.mjs");
        const ex = await exportLineups();
        console.log(`[lineups.json] wrote ${ex.matches} match lineup(s) -> ${ex.written.join(", ")}`);
      }
    }
    return s;
  };

  await cycle();
  if (!ARGS.watch) return;
  console.log(`[watch] polling every ${ARGS.intervalSec}s (T-${ARGS.windowMin} lineup window); confirmed fixtures are skipped.`);
  let running = false;
  setInterval(async () => { if (running) return; running = true; try { await cycle(); } finally { running = false; } }, ARGS.intervalSec * 1000);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) main().catch((e) => { console.error("ERROR:", e?.message ?? e); process.exit(1); });
