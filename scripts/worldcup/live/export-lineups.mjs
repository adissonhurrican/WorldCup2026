/* export-lineups.mjs — LINEUPS EXPORT (DB -> lineups.json -> all UI locations).
 *
 * PROJECT: ahcfrgxczbgdvrqmbisw
 *
 * WHAT IT DOES
 *   Reads the stored XIs from api_football_fixture_lineups (written server-side by fetch-match-lineups.mjs),
 *   joins them to fixture_metadata (WC_2026) to recover OUR fixture orientation, and writes a static
 *   lineups.json keyed exactly like live-scores.json (a `matches` array the UI maps to "HOME_AWAY").
 *   Synced to every UI location. The match card / detail read this file ONLY — no DB, no API, no key.
 *
 * ORIENTATION DISCIPLINE (same as live-scores.json)
 *   Each stored lineup carries API-Football's numeric team_id. We resolve team_id -> FIFA code via the
 *   numeric api-team-code-map.json (alias-immune; USA/CPV safe) and place each side under OUR home/away
 *   from fixture_metadata — never trusting the provider's home/away. A fixture with no stored XI is simply
 *   omitted, so the UI shows the "~60 min before kickoff" placeholder until the lineup exists.
 *
 * RUN
 *   node scripts/worldcup/live/export-lineups.mjs            # rebuild lineups.json from the DB
 *   node scripts/worldcup/live/export-lineups.mjs --dry-run  # build + print, write nothing
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ID = "ahcfrgxczbgdvrqmbisw";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.cwd();
const OUT_MAIN = "data/exports/lineups.json";
const UI_OUTS = ["ui/lineups.json", "ui-v2/public/lineups.json", "ui-v2/dist/lineups.json"];

function readSupabaseConfig() {
  const text = readFileSync(path.join(ROOT, "supebase.txt"), "utf8");
  const projectRef = text.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];
  const restUrl = text.match(/https:\/\/[^\s]+\/rest\/v1\/?/)?.[0]?.replace(/\/$/, "");
  const serviceRoleKey = text.match(/service role secret\s*:\s*(\S+)/i)?.[1];
  if (projectRef !== PROJECT_ID) throw new Error(`Unexpected Supabase project ref: ${projectRef ?? "unknown"}`);
  if (!restUrl || !serviceRoleKey) throw new Error("Missing Supabase REST URL or service-role key in supebase.txt");
  return { restUrl, serviceRoleKey };
}
async function sbGet(config, table, search) {
  const res = await fetch(`${config.restUrl}/${table}${search}`, {
    headers: { apikey: config.serviceRoleKey, authorization: `Bearer ${config.serviceRoleKey}`, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Supabase ${table} ${res.status}: ${await res.text()}`);
  return res.json();
}
function loadTeamCodeMap() {
  const raw = JSON.parse(readFileSync(path.join(__dirname, "api-team-code-map.json"), "utf8"));
  const map = {};
  for (const [k, v] of Object.entries(raw)) if (/^\d+$/.test(k)) map[k] = v;
  return map;
}

// build one side's lineup object from its rows
function sideLineup(rows) {
  const startXI = rows.filter((r) => r.lineup_role === "startXI");
  const subs = rows.filter((r) => r.lineup_role === "substitute");
  const any = rows[0] ?? {};
  const order = (a, b) => (gridKey(a.grid) - gridKey(b.grid)) || ((a.player_number ?? 99) - (b.player_number ?? 99));
  const toP = (r) => ({ name: r.player_name, number: r.player_number, pos: r.player_position, grid: r.grid, player_id: r.player_id });
  return {
    formation: any.formation ?? null,
    coach: any.coach_name ?? null,
    startXI: startXI.sort(order).map(toP),
    substitutes: subs.sort((a, b) => (a.player_number ?? 99) - (b.player_number ?? 99)).map(toP),
  };
}
// "row:col" grid -> sortable number (nulls last)
function gridKey(grid) {
  if (!grid || typeof grid !== "string") return 9999;
  const [r, c] = grid.split(":").map((x) => Number(x));
  return (Number.isFinite(r) ? r : 99) * 100 + (Number.isFinite(c) ? c : 99);
}

export async function exportLineups({ dryRun = false } = {}) {
  const config = readSupabaseConfig();
  const teamCodeMap = loadTeamCodeMap();

  // WC fixture orientation: external_fixture_id -> { home, away }
  const fm = await sbGet(config, "fixture_metadata",
    "?select=external_fixture_id,team_a_code,team_b_code&tournament_code=eq.WC_2026&external_fixture_id=not.is.null");
  const orient = new Map();   // numeric fixture id -> {home, away}
  for (const f of fm) { const id = Number(f.external_fixture_id); if (Number.isFinite(id)) orient.set(id, { home: f.team_a_code, away: f.team_b_code }); }
  const wcIds = [...orient.keys()];
  if (!wcIds.length) return writeOut({ matches: [] }, dryRun);

  // stored lineup rows for WC fixtures only
  const rows = await sbGet(config, "api_football_fixture_lineups",
    `?select=fixture_id,team_id,team_name,formation,coach_name,coach_id,player_id,player_name,player_number,player_position,grid,lineup_role&source_provider=eq.api-football&fixture_id=in.(${wcIds.join(",")})`);

  // group rows by fixture, then by team_id
  const byFx = new Map();
  for (const r of rows) {
    const fxMap = byFx.get(r.fixture_id) ?? new Map();
    const arr = fxMap.get(r.team_id) ?? []; arr.push(r); fxMap.set(r.team_id, arr); byFx.set(r.fixture_id, fxMap);
  }

  const matches = [];
  const unmapped = [];
  for (const [fixtureId, teamMap] of byFx.entries()) {
    const o = orient.get(fixtureId); if (!o) continue;
    let homeSide = null, awaySide = null;
    for (const [teamId, teamRows] of teamMap.entries()) {
      const fifa = teamCodeMap[String(teamId)] ?? null;
      if (!fifa) { unmapped.push({ fixture_id: fixtureId, api_team_id: teamId }); continue; }
      const side = sideLineup(teamRows);
      if (fifa === o.home) homeSide = side; else if (fifa === o.away) awaySide = side;
    }
    if (!homeSide && !awaySide) continue;   // nothing usable -> omit (UI placeholder)
    matches.push({ home: o.home, away: o.away, fixture_id: fixtureId, home_lineup: homeSide, away_lineup: awaySide });
  }
  matches.sort((a, b) => a.fixture_id - b.fixture_id);
  return writeOut({ matches, unmapped }, dryRun);
}

function writeOut({ matches, unmapped = [] }, dryRun) {
  const payload = {
    as_of: new Date().toISOString(),
    source: "API-Football /fixtures/lineups (server-side, DB-backed) — display-only; never a prediction input",
    note: "Confirmed XIs publish ~60 min before kickoff; a fixture is absent here until its lineup is stored (UI shows the placeholder).",
    matches,
  };
  const json = JSON.stringify(payload, null, 2) + "\n";
  const written = [];
  if (!dryRun) {
    for (const rel of [OUT_MAIN, ...UI_OUTS]) {
      const fp = path.join(ROOT, rel);
      mkdirSync(path.dirname(fp), { recursive: true });
      writeFileSync(fp, json, "utf8");
      written.push(rel);
    }
  }
  return { matches: matches.length, unmapped, written: dryRun ? ["(dry-run, not written)"] : written, payload: dryRun ? payload : undefined };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  exportLineups({ dryRun })
    .then((r) => console.log(JSON.stringify({ project_id: PROJECT_ID, ...r }, null, 2)))
    .catch((e) => { console.error("ERROR:", e?.message ?? e); process.exit(1); });
}
