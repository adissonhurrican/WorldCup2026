// FIFA fair-play (team conduct) points from ingested card events — feeds aux.fairPlay so the
// Article-13 ladders apply criterion (d) fair play BEFORE the FIFA-ranking fallback (previously
// fed {} = inert, which would have skipped it on an exact pts+GD+GF tie).
//
// FIFA 2026 scale, ONE deduction per player per match (the highest applicable):
//   yellow -1 | second yellow / indirect red -3 | direct red -4 | yellow then direct red -5
//
// Scope: ONLY cards from VERIFIED finished WC2026 fixtures (join match_results) — stray/synthetic
// event rows from other fixtures never count. Pure compute; callers fetch rows with their own DB
// access (SQL via FAIRPLAY_CARD_SQL, or PostgREST + an in-memory finished-fixture filter).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type CardEventRow = {
  fixture_id: number | string;
  team_id: number | string;
  player_id?: number | string | null;
  player_name?: string | null;
  event_detail?: string | null;
};

// Card rows joined to verified finished results — the SQL-based callers run this verbatim.
export const FAIRPLAY_CARD_SQL = `
  select e.fixture_id, e.team_id, e.player_id, e.player_name, e.event_detail
  from api_football_fixture_events e
  join match_results r on r.api_football_fixture_id = e.fixture_id and r.match_status = 'finished'
  where lower(e.event_type) = 'card' and coalesce(e.review_status, '') <> 'rejected'`;

// api team id -> FIFA code, from the committed 48-team map (same file the live functions embed).
export function loadTeamCodeByApiId(): Record<string, string> {
  const mapPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "live", "api-team-code-map.json");
  const raw = JSON.parse(readFileSync(mapPath, "utf8")) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (/^\d+$/.test(k) && typeof v === "string" && v) out[k] = v;
  return out;
}

export function computeFairPlayPoints(rows: CardEventRow[], teamCodeByApiId: Record<string, string>): Record<string, number> {
  // per (team, fixture, player): collect what they were shown, then apply the single highest deduction
  type Flags = { code: string; yellows: number; secondYellow: boolean; directRed: boolean };
  const byPlayerMatch = new Map<string, Flags>();
  for (const r of rows ?? []) {
    const code = teamCodeByApiId[String(r.team_id)];
    if (!code) continue; // not one of the 48 (or unmapped) — never guess
    const player = r.player_id != null ? `id:${r.player_id}` : `name:${(r.player_name ?? "unknown").toLowerCase()}`;
    const key = `${code}|${r.fixture_id}|${player}`;
    const f = byPlayerMatch.get(key) ?? { code, yellows: 0, secondYellow: false, directRed: false };
    const d = String(r.event_detail ?? "").toLowerCase();
    if (d.includes("second")) f.secondYellow = true;       // explicit "Second Yellow card"
    else if (d.includes("yellow")) f.yellows += 1;          // plain yellow (two of these = second yellow)
    else if (d.includes("red")) f.directRed = true;         // straight red
    byPlayerMatch.set(key, f);
  }
  const out: Record<string, number> = {};
  for (const f of byPlayerMatch.values()) {
    const twoYellows = f.secondYellow || f.yellows >= 2;
    let deduction = 0;
    if (f.yellows >= 1 && f.directRed) deduction = -5;      // yellow + direct red
    else if (twoYellows) deduction = -3;                    // indirect red
    else if (f.directRed) deduction = -4;                   // straight red
    else if (f.yellows === 1) deduction = -1;               // single yellow
    if (deduction !== 0) out[f.code] = (out[f.code] ?? 0) + deduction;
  }
  return out;
}
