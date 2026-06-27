// Bracket data shaping — assembles the knockout bracket (R32 -> Final) from the EXISTING export
// (data.knockout_fixtures + data.real_standings + data.fixtures). Pure, display-only; no new pipeline.
//
// ONE RULE (no projections, no guessing): a slot shows a REAL team ONLY when that team is MATHEMATICALLY
// CLINCHED into that exact slot — provable regardless of how the remaining group games finish. Otherwise the
// slot renders its POSITION / POOL label ("Winner Group G", "Best 3rd from {pool}", "Winner M74").
//
// Resolution per slot, in priority order:
//   1. side.team present                 -> REAL (the resolver's authoritative fill: complete groups, all-12
//                                           best-thirds, and played knockout results). Left untouched.
//   2. group winner / runner-up slot     -> REAL iff the position is clinched by points (groupPositionClinch),
//                                           else the position label.
//   3. best-third slot                   -> REAL iff a complete-group third is clinched into THIS exact slot
//                                           via the deterministic Annex C table (bestThirdClinchByMatch), else
//                                           the pool label.
//   4. match winner / loser (R16+)       -> REAL only once the source match has a real DECIDED result; else
//                                           the "Winner M.." label. No favourite is ever projected forward.
//
// This replaces the previous greedy/sim "single most likely" projection (which over-locked complete-group
// thirds whose Annex C slot could still shift, and double-placed a team by mixing two disagreeing sources).
// The clinch logic lives in ONE place: ./bracket-clinch.js + the validated FIFA Annex C table.
import { groupPositionClinch, bestThirdClinchByMatch } from "./bracket-clinch.js";

const ROUND_META = [
  { key: "round_of_32", label: "Round of 32", short: "R32", order: 1 },
  { key: "round_of_16", label: "Round of 16", short: "R16", order: 2 },
  { key: "quarter_final", label: "Quarter-finals", short: "QF", order: 3 },
  { key: "semi_final", label: "Semi-finals", short: "SF", order: 4 },
  { key: "third_place", label: "Third-place play-off", short: "3rd", order: 5 },
  { key: "final", label: "Final", short: "Final", order: 6 },
];
const ROUND_BY_KEY = Object.fromEntries(ROUND_META.map((r) => [r.key, r]));
// round_order in the export: 1=R32 2=R16 3=QF 4=SF 5=3rd-place 6=Final (fallback if round_key absent)
const ORDER_TO_KEY = { 1: "round_of_32", 2: "round_of_16", 3: "quarter_final", 4: "semi_final", 5: "third_place", 6: "final" };

function roundKeyOf(fx) {
  if (fx.round_key && ROUND_BY_KEY[fx.round_key]) return fx.round_key;
  if (fx.round_order && ORDER_TO_KEY[fx.round_order]) return ORDER_TO_KEY[fx.round_order];
  const r = String(fx.round || "").toLowerCase();
  if (r.includes("32")) return "round_of_32";
  if (r.includes("16")) return "round_of_16";
  if (r.includes("quarter")) return "quarter_final";
  if (r.includes("semi")) return "semi_final";
  if (r.includes("third")) return "third_place";
  if (r.includes("final")) return "final";
  return "round_of_32";
}

const sideTeamCode = (side) => (side && side.team && side.team.code) || null;
const numOrNull = (v) => (v == null || v === "" ? null : Number(v));

// Build the full bracket: { rounds: [{ key,label,short,order, matches:[...] }], hasAnyResult }.
export function buildBracket(data) {
  const fixtures = (data.knockout_fixtures || []).slice().sort((a, b) => (a.match_number || 0) - (b.match_number || 0));
  if (!fixtures.length) return { rounds: [], hasAnyResult: false };

  const groupClinch = groupPositionClinch(data);          // { GROUP: { winner, runnerUp } } — clinched codes only
  const thirdClinch = bestThirdClinchByMatch(data);       // { matchNumber: { code, group, real:true } } — clinched thirds only

  // resolved winner/loser per match — REAL results only (no projection), filled in match-number order so every
  // source match is known when a later round references it.
  const winnerByMatch = {}, loserByMatch = {};

  const resolveSlot = (side) => {
    const real = sideTeamCode(side);
    if (real) return { code: real, real: true };          // 1. authoritative resolver fill
    const t = side?.type;
    if (t === "group_winner" && side.group) { const c = groupClinch[side.group]?.winner ?? null; return { code: c, real: c != null }; }
    if (t === "group_runner_up" && side.group) { const c = groupClinch[side.group]?.runnerUp ?? null; return { code: c, real: c != null }; }
    if (t === "best_third") return { code: null, real: false }; // filled per-match below from thirdClinch
    if (t === "match_winner" && side.source_match != null) { const c = winnerByMatch[side.source_match] ?? null; return { code: c, real: c != null }; }
    if (t === "match_loser" && side.source_match != null) { const c = loserByMatch[side.source_match] ?? null; return { code: c, real: c != null }; }
    return { code: null, real: false };
  };

  const matchesByRound = {};
  for (const fx of fixtures) {
    const key = roundKeyOf(fx);
    const aSlot = fx.side_a || {}, bSlot = fx.side_b || {};
    const a = resolveSlot(aSlot), b = resolveSlot(bSlot);
    // best-third slots: a real team only when CLINCHED into this exact slot; otherwise the pool label renders.
    if (aSlot.type === "best_third" && !a.code) { const th = thirdClinch[fx.match_number]; if (th?.code) { a.code = th.code; a.real = true; } }
    if (bSlot.type === "best_third" && !b.code) { const th = thirdClinch[fx.match_number]; if (th?.code) { b.code = th.code; b.real = true; } }

    // real result? (the export's result = { a, b, winner, pens_a, pens_b }; a/b are the scores)
    const aScore = numOrNull(fx.result?.a);
    const bScore = numOrNull(fx.result?.b);
    const played = aScore != null && bScore != null;
    // a knockout can't truly draw: a level scoreline is settled by penalties. Read an explicit winner signal
    // (winner code, or penalty scores) so we never advance a favourite when the real shootout went the other way.
    const winSig = fx.result?.winner ?? fx.result?.winner_code ?? null;
    const pensA = numOrNull(fx.result?.pens_a), pensB = numOrNull(fx.result?.pens_b);

    let decided = false, winnerCode = null, loserCode = null;
    if (played && aScore !== bScore) {
      decided = true;
      winnerCode = aScore > bScore ? a.code : b.code;
      loserCode = aScore > bScore ? b.code : a.code;
    } else if (played) {
      // level scoreline: settle ONLY by a winner signal matching one of the two sides, else by penalties. Never
      // default to side A on a winner code that matches neither side. No projection fallback.
      const sigWinner = winSig === a.code ? a.code : winSig === b.code ? b.code : null;
      const penWinner = (pensA != null && pensB != null && pensA !== pensB) ? (pensA > pensB ? a.code : b.code) : null;
      const w = sigWinner ?? penWinner;
      if (w != null) { decided = true; winnerCode = w; loserCode = w === a.code ? b.code : a.code; }
    }
    // Undecided -> winner/loser stay null, so downstream rounds render the "Winner M.." label (no projection).
    winnerByMatch[fx.match_number] = winnerCode;
    loserByMatch[fx.match_number] = loserCode;

    const mkSide = (slot, resolved, score) => ({
      code: resolved.code,
      label: slot.label ?? null,
      real: resolved.real,                       // true once a team is clinched / resolved into the slot
      score,
      isWinner: decided && resolved.code != null && resolved.code === winnerCode,
      isLoser: decided && resolved.code != null && resolved.code === loserCode,
    });

    (matchesByRound[key] ??= []).push({
      match_number: fx.match_number,
      round_key: key,
      round_window_label: fx.round_window_label ?? null,
      kickoff_utc: fx.kickoff_utc ?? null,
      date_confirmed: fx.date_confirmed === true,
      venue: fx.venue ?? null,
      city: fx.city ?? null,
      decided,
      a: mkSide(aSlot, a, aScore),
      b: mkSide(bSlot, b, bScore),
      feeders: [aSlot.source_match ?? null, bSlot.source_match ?? null].filter((x) => x != null),
    });
  }

  const rounds = ROUND_META
    .filter((r) => matchesByRound[r.key]?.length)
    .map((r) => ({ ...r, matches: matchesByRound[r.key].sort((a, b) => a.match_number - b.match_number) }));
  const hasAnyResult = rounds.some((r) => r.matches.some((m) => m.decided));
  return { rounds, hasAnyResult };
}
