/* build-squads-json.mjs — SQUAD ROSTER EXPORT (DB -> squads.json -> all UI locations).
 * PROJECT: ahcfrgxczbgdvrqmbisw
 *
 * WHAT IT DOES
 *   Reads the confirmed WC2026 rosters from `players` (wc2026_status='confirmed', 26/team) and writes a
 *   static squads.json keyed by FIFA team code -> array of players, each with:
 *     name, position, position_group (GK/DEF/MID/FWD), number, club, age,
 *     status: { goals, assists, yellow, red, minutes }   <- per-player match status
 *   The status block is WIRED-BUT-EMPTY today: it is aggregated from api_football_fixture_player_stats
 *   for WC fixtures only (joined by numeric api_player_id via api_football_player_identity_map / the
 *   players.api_football_player_id column). No WC matches have been played, so every value is 0 now and
 *   fills in automatically once the post-match pull stores stats — the SAME table the lineup pipeline writes.
 *
 *   DISPLAY-ONLY. Coach + formation are NOT here (the Squad card already shows those from tactical_context
 *   in app-data.json). Missing fields are emitted as null so the UI can omit them gracefully (never "null"/padded).
 *
 * RUN
 *   node scripts/worldcup/export/build-squads-json.mjs            # build + sync
 *   node scripts/worldcup/export/build-squads-json.mjs --dry-run  # build + print summary, write nothing
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ID = "ahcfrgxczbgdvrqmbisw";
const ROOT = process.cwd();
const OUT_MAIN = "data/exports/squads.json";
const UI_OUTS = ["ui/squads.json", "ui-v2/public/squads.json", "ui-v2/dist/squads.json"];

const POS_GROUP = { Goalkeeper: "GK", Defender: "DEF", Midfielder: "MID", Attacker: "FWD", Forward: "FWD" };
const GROUP_ORDER = { GK: 0, DEF: 1, MID: 2, FWD: 3, "": 4 };

// player_status_events.status_type (+ legacy new_status) -> a small display vocabulary for the squad chip.
// Anything that isn't a clear "available" maps to a fitness/availability flag; "available" => no chip.
function availabilityStatus(ev) {
  const t = String(ev.status_type || "").toLowerCase();
  const ns = String(ev.new_status || "").toLowerCase();
  if (t === "available" || ns === "available" || ns === "fit") return "available";
  if (t === "suspended" || ns === "suspended") return "suspended";
  if (t === "injury" || t === "unavailable" || ns === "out" || ns === "injured" || ns === "unavailable") return "out";
  // recovery / doubtful / returned_to_training / anything else non-available -> a soft "doubtful" flag
  return "doubtful";
}

function readSupabaseConfig() {
  // CI-first: use env creds (SUPABASE_DB_URL for the project ref + SUPABASE_SERVICE_ROLE_KEY) so this works on
  // GitHub Actions where supebase.txt is absent. Fall back to the local supebase.txt file when env is unset.
  const envDbUrl = process.env.SUPABASE_DB_URL;
  const envServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (envDbUrl && envServiceRoleKey) {
    const envRef = envDbUrl.match(/postgres\.([a-z0-9]+):/)?.[1] ?? envDbUrl.match(/\/\/([^.]+)\.supabase\.co/)?.[1] ?? "";
    if (envRef !== PROJECT_ID) throw new Error(`Unexpected project ref from SUPABASE_DB_URL: ${envRef || "unknown"}`);
    return { restUrl: `https://${envRef}.supabase.co/rest/v1`, serviceRoleKey: envServiceRoleKey };
  }
  const t = readFileSync(path.join(ROOT, "supebase.txt"), "utf8");
  const ref = t.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];
  const restUrl = t.match(/https:\/\/[^\s]+\/rest\/v1\/?/)?.[0]?.replace(/\/$/, "");
  const serviceRoleKey = t.match(/service role secret\s*:\s*(\S+)/i)?.[1];
  if (ref !== PROJECT_ID) throw new Error(`Unexpected project ref: ${ref}`);
  if (!restUrl || !serviceRoleKey) throw new Error("Missing Supabase REST/service-role in supebase.txt");
  return { restUrl, serviceRoleKey };
}
async function sbPaged(config, table, search) {
  const out = []; const size = 1000;
  for (let from = 0; ; from += size) {
    const r = await fetch(`${config.restUrl}/${table}${search}`, { headers: { apikey: config.serviceRoleKey, authorization: `Bearer ${config.serviceRoleKey}`, range: `${from}-${from + size - 1}` } });
    if (!r.ok) throw new Error(`Supabase ${table} ${r.status}: ${await r.text()}`);
    const page = await r.json(); out.push(...page); if (page.length < size) break;
  }
  return out;
}
async function sbGet(config, table, search) {
  const r = await fetch(`${config.restUrl}/${table}${search}`, { headers: { apikey: config.serviceRoleKey, authorization: `Bearer ${config.serviceRoleKey}`, accept: "application/json" } });
  if (!r.ok) throw new Error(`Supabase ${table} ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function buildSquadsJson({ dryRun = false } = {}) {
  const config = readSupabaseConfig();
  const teams = await sbGet(config, "teams", "?select=id,fifa_code,name");
  const codeByTeamId = new Map(teams.map((t) => [t.id, t.fifa_code]));
  const players = await sbPaged(config, "players",
    "?select=id,team_id,full_name,position,shirt_number,club,age,api_football_player_id,date_of_birth,nationality,height_cm,weight_kg,birth_place,birth_country&wc2026_status=eq.confirmed");

  // wired-but-empty per-player status: aggregate api_football_fixture_player_stats for WC fixtures only
  const fm = await sbGet(config, "fixture_metadata", "?select=external_fixture_id&tournament_code=eq.WC_2026&external_fixture_id=not.is.null");
  const wcIds = fm.map((f) => Number(f.external_fixture_id)).filter(Number.isFinite);
  const statusByApiId = new Map();
  if (wcIds.length) {
    const stats = await sbPaged(config, "api_football_fixture_player_stats",
      `?select=player_id,goals_total,assists,cards_yellow,cards_red,minutes&fixture_id=in.(${wcIds.join(",")})`);
    for (const s of stats) {
      const k = Number(s.player_id);
      const cur = statusByApiId.get(k) ?? { goals: 0, assists: 0, yellow: 0, red: 0, minutes: 0 };
      cur.goals += s.goals_total ?? 0; cur.assists += s.assists ?? 0; cur.yellow += s.cards_yellow ?? 0;
      cur.red += s.cards_red ?? 0; cur.minutes += s.minutes ?? 0;
      statusByApiId.set(k, cur);
    }
  }

  // availability / injuries: latest tournament-scope, non-rejected event per player.
  // player_status_events.player_id is the INTERNAL players.id (uuid FK) — a direct, alias-safe join
  // (it's our canonical id, never a name), so no api-id mapping is needed here. Pending seeds ARE
  // surfaced (the only data today is 2 vetted CAN seeds) but carry review_status so the UI can flag them.
  const availByPlayerId = new Map();
  const events = await sbPaged(config, "player_status_events",
    "?select=player_id,status_type,new_status,status_scope,severity,expected_return_date,review_status,created_at" +
    "&tournament_code=eq.WC_2026&status_scope=eq.tournament&review_status=neq.rejected&order=player_id.asc,created_at.desc");
  for (const ev of events) {
    if (availByPlayerId.has(ev.player_id)) continue;   // first per player = latest (created_at desc)
    const status = availabilityStatus(ev);
    if (status === "available") { availByPlayerId.set(ev.player_id, null); continue; } // seen but no concern
    availByPlayerId.set(ev.player_id, {
      status,
      severity: ev.severity && ev.severity !== "unknown" ? ev.severity : null,
      expected_return: ev.expected_return_date ?? null,
      review_status: ev.review_status ?? null,
    });
  }

  const byCode = {};
  for (const p of players) {
    const code = codeByTeamId.get(p.team_id); if (!code) continue;
    const group = POS_GROUP[p.position] ?? "";
    const aid = p.api_football_player_id != null ? Number(p.api_football_player_id) : null;
    const status = (aid != null && statusByApiId.get(aid)) || { goals: 0, assists: 0, yellow: 0, red: 0, minutes: 0 };
    const availability = availByPlayerId.get(p.id) || null;   // only present (and non-null) when a concern exists
    (byCode[code] ??= []).push({
      name: p.full_name,
      position: p.position ?? null,
      position_group: group || null,
      number: p.shirt_number ?? null,
      club: p.club ?? null,
      age: p.age ?? null,
      status,
      ...(availability ? { availability } : {}),
      // --- player-card bio (Phase 1, ADDITIVE). Appended AFTER the existing keys so the current squad
      // card's fields stay byte-identical; the current UI ignores these. photo is a DERIVED URL; the rest
      // come from backfill-player-bios.mjs (null where not yet backfilled — Canada first). ---
      api_player_id: aid,
      photo: aid != null ? `https://media.api-sports.io/football/players/${aid}.png` : null,
      dob: p.date_of_birth ?? null,
      nationality: p.nationality ?? null,
      height_cm: p.height_cm ?? null,
      weight_kg: p.weight_kg ?? null,
      birth_place: p.birth_place ?? null,
      birth_country: p.birth_country ?? null,
    });
  }
  // sort each squad: GK,DEF,MID,FWD then number (nulls last) then name
  for (const code of Object.keys(byCode)) {
    byCode[code].sort((a, b) =>
      (GROUP_ORDER[a.position_group ?? ""] - GROUP_ORDER[b.position_group ?? ""]) ||
      ((a.number ?? 999) - (b.number ?? 999)) ||
      a.name.localeCompare(b.name));
  }

  const codes = Object.keys(byCode).sort();
  const withAvailability = Object.values(byCode).flat().filter((p) => p.availability).length;
  const coverage = {
    teams: codes.length,
    players: players.length,
    with_number: players.filter((p) => p.shirt_number != null).length,
    with_club: players.filter((p) => p.club != null).length,
    with_age: players.filter((p) => p.age != null).length,
    with_availability_flag: withAvailability,
    with_nationality: players.filter((p) => p.nationality != null).length,
    with_dob: players.filter((p) => p.date_of_birth != null).length,
    with_photo: players.filter((p) => p.api_football_player_id != null).length,
  };
  const payload = {
    generated_at: new Date().toISOString(),
    source: "WC2026 confirmed squads from the DB (players + API-Football squad fields + player_status_events). Display-only; never a model/prediction input.",
    note: "Per-player status (goals/assists/cards/minutes) fills from api_football_fixture_player_stats as WC matches are played; 0 until then. availability (out/doubtful/suspended) comes from player_status_events (latest tournament-scope, non-rejected) and carries review_status — pending seeds are shown but flagged. Missing club/age/number are null (the UI omits them). Player-card bio (api_player_id, photo[derived URL], dob, nationality, height_cm, weight_kg, birth_place, birth_country) is ADDITIVE and only populated where backfilled (Canada first); the current squad card ignores these keys.",
    coverage,
    teams: byCode,
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
  return { coverage, teams: codes.length, written: dryRun ? ["(dry-run, not written)"] : written, sample: byCode[codes[0]]?.slice(0, 2) };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  buildSquadsJson({ dryRun })
    .then((r) => console.log(JSON.stringify({ project_id: PROJECT_ID, ...r }, null, 2)))
    .catch((e) => { console.error("ERROR:", e?.message ?? e); process.exit(1); });
}
