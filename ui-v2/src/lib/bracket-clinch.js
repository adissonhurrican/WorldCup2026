// ============================================================================
// Bracket clinch — the SINGLE deterministic rule for the Bracket tab:
//   a team is placed in an R32 slot ONLY when it is MATHEMATICALLY CLINCHED into
//   that exact slot — provable regardless of how the remaining group games finish.
//   Not clinched -> the slot shows its pool / position label (no projection, no guess).
//
// This replaces the old greedy / sim / "single most likely" projections (which over-locked
// complete-group thirds whose Annex C SLOT could still change, and double-placed teams by
// mixing two disagreeing sources). One source: this file + the validated FIFA Annex C table.
//
// Display-only. Reads real_standings (points/GD/played) + fixtures (remaining games) + the
// Annex C mapping. Does NOT touch the export, standings, Path card, narration, or the
// resolver's authoritative side.team fill (which bracket.js still prefers when present).
// ============================================================================
import annexCMapping from "../../../data/external/fifa/annex-c-r32-third-place-mapping.json" with { type: "json" };

// Winner-slot (1A..1L) -> R32 match number, from the FIFA 2026 bracket structure.
const SLOT_TO_MATCH = { "1A": 79, "1B": 85, "1D": 81, "1E": 74, "1G": 82, "1I": 77, "1K": 87, "1L": 80 };
const OUTCOMES = [[3, 0], [1, 1], [0, 3]]; // home pts, away pts for a remaining game (W / D / L)
const GROUP_SIZE_GAMES = 3; // each team plays 3 group games

const up = (s) => String(s ?? "").toUpperCase();
const thirdOf = (g) => (g.standings || []).find((s) => s.position === 3) || (g.standings || [])[2] || null;

// k-combinations of an array (small inputs only).
function combos(arr, k) {
  if (k === 0) return [[]];
  if (k > arr.length) return [];
  const [h, ...t] = arr;
  return [...combos(t, k - 1).map((c) => [h, ...c]), ...combos(t, k)];
}

// Remaining (not-yet-final) group games per group, as [home, away] pairs.
function remainingGamesByGroup(data) {
  const rem = {};
  for (const f of data?.fixtures || []) {
    if (!f.group || f.knockout) continue;
    const done = f.result && f.result.status === "final" && f.result.home_score != null;
    if (done) continue;
    (rem[up(f.group)] ||= []).push([f.home, f.away]);
  }
  return rem;
}

// GROUP POSITION CLINCH — { GROUP: { winner: code|null, runnerUp: code|null } }.
// A complete group is clinched by definition. An incomplete group's position is clinched only when it is
// locked by POINTS ALONE (provable without any tiebreaker): strictly ahead of every team that could catch it.
export function groupPositionClinch(data) {
  const out = {};
  for (const g of data?.real_standings?.groups || []) {
    const S = g.standings || [];
    if (g.complete) { out[g.group] = { winner: S[0]?.code ?? null, runnerUp: S[1]?.code ?? null }; continue; }
    const maxP = (t) => (t.points ?? 0) + 3 * Math.max(0, GROUP_SIZE_GAMES - (t.played ?? 0));
    const ahead = (t, exclude) => S.every((o) => o.code === t.code || exclude.includes(o.code) || (t.points ?? 0) > maxP(o));
    let winner = null;
    for (const t of S) { if (ahead(t, [])) { winner = t.code; break; } }
    let runnerUp = null;
    if (winner) for (const t of S) { if (t.code !== winner && ahead(t, [winner])) { runnerUp = t.code; break; } }
    out[g.group] = { winner, runnerUp };
  }
  return out;
}

// The possible final THIRD-PLACE POINTS of an incomplete group (3rd-highest points over every remaining W/D/L).
// Points are tiebreaker-independent, so this needs no scorelines.
function openGroupThirdPoints(g, remGames) {
  const rem = remGames || [];
  const base = {};
  for (const s of g.standings || []) base[s.code] = s.points ?? 0;
  const set = new Set();
  const total = 3 ** rem.length;
  for (let mask = 0; mask < total; mask++) {
    const p = { ...base };
    let m = mask;
    for (let i = 0; i < rem.length; i++) {
      const o = OUTCOMES[m % 3]; m = (m / 3) | 0;
      if (p[rem[i][0]] != null) p[rem[i][0]] += o[0];
      if (p[rem[i][1]] != null) p[rem[i][1]] += o[1];
    }
    set.add(Object.values(p).sort((a, b) => b - a)[2]);
  }
  return [...set];
}

// BEST-THIRD CLINCH — { matchNumber: { code, group, real:true } } for thirds clinched into their exact slot.
// A complete-group third clinches iff, across EVERY reachable set of 8 qualifying thirds (enumerated from the
// locked thirds + every possible final third-points of the incomplete groups, with open-group boundary ties
// branched both ways), (a) its group is always among the 8 AND (b) the Annex C table assigns it the SAME slot.
// Only complete-group thirds can clinch (an incomplete group's third isn't even known yet).
export function bestThirdClinchByMatch(data) {
  const groups = data?.real_standings?.groups || [];
  if (groups.length < 12) return {}; // structure not ready -> all pools (safe)
  const rem = remainingGamesByGroup(data);

  const completeThirds = groups.filter((g) => g.complete).map((g) => {
    const t = thirdOf(g);
    return { group: up(g.group), code: t?.code ?? null, pts: t?.points ?? 0, gd: t?.goal_difference ?? 0, gf: t?.goals_for ?? 0, open: false };
  });
  const openOpts = groups.filter((g) => !g.complete).map((g) => ({ group: up(g.group), pts: openGroupThirdPoints(g, rem[up(g.group)]) }));

  // Enumerate every reachable set of 8 qualifying groups (by their third's points; open-group third points vary).
  const reachable = new Set();
  const rec = (i, assign) => {
    if (i === openOpts.length) {
      const thirds = [...completeThirds, ...openOpts.map((o, x) => ({ group: o.group, pts: assign[x], gd: null, open: true }))];
      const pcut = thirds.map((t) => t.pts).sort((a, b) => b - a)[7]; // 8th-best points = the qualifying cut
      const above = thirds.filter((t) => t.pts > pcut);                // strictly above the cut -> definitely in
      const boundary = thirds.filter((t) => t.pts === pcut);           // at the cut -> tiebreak decides who fills the rest
      const need = 8 - above.length;
      const cb = boundary.filter((t) => !t.open).sort((a, b) => b.gd - a.gd || b.gf - a.gf); // complete: fixed FIFA tiebreak order
      const ob = boundary.filter((t) => t.open);                              // open: GD unknown -> flexible
      for (let k = 0; k <= Math.min(cb.length, need); k++) {
        const fromOpen = need - k;
        if (fromOpen < 0 || fromOpen > ob.length) continue;
        for (const oc of combos(ob, fromOpen)) {
          reachable.add([...above, ...cb.slice(0, k), ...oc].map((t) => t.group).sort().join(""));
        }
      }
      return;
    }
    for (const p of openOpts[i].pts) { assign.push(p); rec(i + 1, assign); assign.pop(); }
  };
  rec(0, []);
  const sets = [...reachable];
  if (!sets.length) return {};

  const out = {};
  for (const t of completeThirds) {
    if (!t.code) continue;
    if (!sets.every((k) => k.includes(t.group))) continue; // could miss the cut in some scenario -> not clinched
    const slotMatches = new Set();
    for (const k of sets) {
      const assign = annexCMapping?.mappings?.[k]?.third_place_slot_assignments;
      if (!assign) { slotMatches.add(null); continue; }
      const slot = Object.keys(assign).find((s) => up(assign[s]) === t.group);
      slotMatches.add(slot ? SLOT_TO_MATCH[slot] : null);
    }
    if (slotMatches.size === 1) {
      const mn = [...slotMatches][0];
      if (mn != null) out[mn] = { code: t.code, group: t.group, real: true };
    }
  }
  return out;
}
