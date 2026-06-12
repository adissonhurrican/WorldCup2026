// Pitch positioning for the visual lineup — pure math, no React, no fetches.
//
// API-Football's lineup `grid` is "row:col": row = the line counted from the goalkeeper (1) outward
// toward the attack; col = the slot within that line, 1..lineSize (col 1 = the team's left flank).
// Verified against the WC2026 opener: MEX 4-1-4-1 = rows sized 1-4-1-4-1 (maxRow 5),
// RSA 5-3-2 = rows sized 1-5-3-2 (maxRow 4) — so row depth MUST normalize by the team's own
// maxRow (formations have different line counts), and a line's spread MUST normalize by that
// line's size (lone strikers/pivots auto-center).
//
// Coordinates are HALF-pitch percentages: x 0..100 across the width (from the team's own left),
// y 0 = the halfway line, 100 = the team's own goal line. The renderer maps a half onto the full
// pitch (home = bottom half as-is; away = top half rotated 180°), so this file stays orientation-free.

const GK_Y = 88;          // goalkeeper: near the goal line but clear of the pitch edge + the half chip
const DEEPEST_Y = 68;     // first outfield line (the defense) — keep ≥10 full-% from the GK so a centre
                          // back never covers the keeper's name chip (tokens are ~52px tall incl. label)
const HIGHEST_Y = 17;     // last outfield line (the strikers)
// Horizontal inset: tokens are ~56px wide, so a full-bleed 0..100 line puts flank players half off
// the image (a back five spans 10..90 -> the widest tokens clip). Squeeze every line into 8..92.
const X_INSET = 8;

export function parseGrid(grid) {
  const m = /^(\d+):(\d+)$/.exec(String(grid || ""));
  if (!m) return null;
  return { row: Number(m[1]), col: Number(m[2]) };
}

// startXI (the function/export lineup shape: [{ name, number, pos, grid, player_id }]) ->
// [{ ...player, x, y }] for every player with a usable grid. Players with grid:null (subs are
// always null; a malformed starter row would be too) are simply omitted — the caller decides
// whether to fall back to a text list.
export function sidePositions(startXI) {
  const players = (startXI || []).map((p) => ({ p, g: parseGrid(p?.grid) })).filter((e) => e.g);
  if (!players.length) return [];

  const maxRow = Math.max(...players.map((e) => e.g.row));
  const lineSize = new Map(); // row -> players in that line
  for (const e of players) lineSize.set(e.g.row, (lineSize.get(e.g.row) || 0) + 1);

  return players.map(({ p, g }) => {
    const size = lineSize.get(g.row) || 1;
    const x = X_INSET + ((g.col - 0.5) / size) * (100 - 2 * X_INSET);
    let y;
    if (g.row === 1) y = GK_Y;
    else if (maxRow <= 2) y = (DEEPEST_Y + HIGHEST_Y) / 2; // degenerate: one outfield line -> center it
    else y = DEEPEST_Y - ((g.row - 2) / (maxRow - 2)) * (DEEPEST_Y - HIGHEST_Y);
    return { ...p, x, y };
  });
}

// Half-pitch -> full portrait-pitch percentages. Home defends the BOTTOM goal (attacks upward,
// reads naturally under the card); away is the same math rotated 180° onto the top half.
export function toFullPitch(pos, side /* "home" | "away" */) {
  if (side === "away") return { ...pos, x: 100 - pos.x, y: 50 - pos.y / 2 };
  return { ...pos, x: pos.x, y: 50 + pos.y / 2 };
}
