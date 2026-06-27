// Bracket data shaping — assembles the knockout bracket (R32 -> Final) from the EXISTING export
// (data.knockout_fixtures + data.groups + data.knockout_paths + data.team_paths). Pure, display-only;
// no new pipeline. Works on PROJECTIONS today and consumes REAL teams/results seamlessly the moment the
// backend bracket resolver fills side.team / a result (the forward-compat hooks already in the export).
//
// Resolution per slot, in priority order:
//   1. side.team present  -> REAL team (resolver filled it)
//   2. R32 group slot     -> projected from the conditioned group standings (winner/runner-up) or the
//                            deterministic Annex C current-best third allocation, falling back to the
//                            old de-duped knockout_paths projection only if the Annex C current-best
//                            input is unavailable
//   3. match_winner/loser -> projected winner/loser of the (already-resolved, lower-numbered) source match
// Winner of a match: real score if decided, else the higher-strength side (champion prob proxy).
// As real knockout results land, decided matches mark winner FULL-COLOR / loser GREY and carry the real
// winner forward; undecided matches stay projected/neutral.
//
// DISPLAY MODE — ESPN-style STRUCTURE-ONLY (current): show each slot's POSITION LABEL ("Winner Group A",
// "Best 3rd from A/B/C/D/F", "Winner M74") and NO projected team / prediction until the slot is mathematically
// REAL — i.e. a group completes (Phase 2 fills side.team) or a knockout result advances a team (Phase 4). Real
// results still light the winner / grey the loser. ALL projection code below (groupFinishers, bestThirdByMatch,
// strengthMap, stronger/weaker) stays BUILT but dormant — flip SHOW_PROJECTIONS to true to restore the projected
// matchups. This is a reversible display toggle, not a removal; the export still carries projections + predictions.
import annexCMapping from "../../../data/external/fifa/annex-c-r32-third-place-mapping.json" with { type: "json" };

const SHOW_PROJECTIONS = false; // structure-only while projected R32 slotting is unsafe

const SLOT_TO_MATCH = {
  "1A": 79,
  "1B": 85,
  "1D": 81,
  "1E": 74,
  "1G": 82,
  "1I": 77,
  "1K": 87,
  "1L": 80,
};

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

// champion probability as a stable head-to-head strength proxy for projecting an undecided match. Cascade with ||
// (NOT ??) so a genuine champion===0 falls through to the next deeper-round signal instead of collapsing to 0 —
// otherwise two no-chance teams are indistinguishable (BRACKETUI-3).
function strengthMap(data) {
  const m = {};
  for (const t of data.team_paths || []) {
    const k = t.knockout || {};
    m[t.code] = k.champion || k.reach_final || k.reach_semifinal || k.reach_quarterfinal || k.reach_round_of_16 || t.advance || 0;
  }
  return m;
}

// projected R32 group-slot teams from the conditioned standings (sorted by win_group desc already).
function groupFinishers(data) {
  const win = {}, ru = {};
  for (const g of data.groups || []) {
    const s = g.standings || [];
    if (s[0]) win[g.group] = s[0].code;
    if (s[1]) ru[g.group] = s[1].code;
  }
  return { win, ru };
}

// Fallback only: the old de-duped best-third per R32 match, lifted from knockout_paths'
// already-allocated projected_opponent. Kept so malformed/missing current-best race data does not blank the bracket.
function greedyBestThirdByMatch(data) {
  const m = {};
  for (const p of data.knockout_paths || []) {
    for (const dest of [p.as_group_winner, p.as_runner_up]) {
      if (dest && dest.opponent_kind === "best_third" && dest.projected_opponent && dest.match_number != null) {
        m[dest.match_number] = { code: dest.projected_opponent.code, real: false, source: "greedy_fallback" };
      }
    }
  }
  return m;
}

function concatThirdGroupKey(groups) {
  return groups.map((g) => String(g).toUpperCase()).sort().join("");
}

function currentBestThirdEntries(data) {
  const race = data?.real_standings?.best_third_race;
  const ranked = Array.isArray(race?.ranked) ? race.ranked : [];
  const qualifyCount = Number.isFinite(Number(race?.qualify_count)) ? Number(race.qualify_count) : 8;
  return ranked
    .filter((r) => r?.code && r?.group && (r.in_best_8 === true || Number(r.rank) <= qualifyCount))
    .sort((a, b) => (Number(a.rank) || 99) - (Number(b.rank) || 99))
    .slice(0, qualifyCount);
}

// Deterministic current-best Annex C allocation for the Bracket tab only.
// Complete-group thirds render as real/determined; incomplete-group thirds still render as projected.
export function bestThirdByMatch(data) {
  const fallback = greedyBestThirdByMatch(data);
  const selected = currentBestThirdEntries(data);
  if (selected.length !== 8) return fallback;

  const byGroup = {};
  for (const entry of selected) byGroup[String(entry.group).toUpperCase()] = entry;

  const key = concatThirdGroupKey(selected.map((entry) => entry.group));
  const row = annexCMapping?.mappings?.[key];
  const assignments = row?.third_place_slot_assignments;
  if (!assignments) return fallback;

  const m = {};
  for (const [slot, groupRaw] of Object.entries(assignments)) {
    const matchNumber = SLOT_TO_MATCH[slot];
    const group = String(groupRaw).toUpperCase();
    const entry = byGroup[group];
    if (!matchNumber || !entry?.code) return fallback;
    m[matchNumber] = {
      code: entry.code,
      real: entry.group_complete === true,
      group,
      source: "annex_c_current_best",
      key,
      combination_number: row.combination_number ?? null,
    };
  }
  return Object.keys(m).length === 8 ? m : fallback;
}

const sideTeamCode = (side) => (side && side.team && side.team.code) || null;
const numOrNull = (v) => (v == null || v === "" ? null : Number(v));

// Build the full bracket: { rounds: [{ key,label,short,order, matches:[...] }], hasAnyResult }.
export function buildBracket(data) {
  const fixtures = (data.knockout_fixtures || []).slice().sort((a, b) => (a.match_number || 0) - (b.match_number || 0));
  if (!fixtures.length) return { rounds: [], hasAnyResult: false };

  const strength = strengthMap(data);
  const { win, ru } = groupFinishers(data);
  const bt = bestThirdByMatch(data);
  const stronger = (x, y) => (x == null ? y : y == null ? x : (strength[x] ?? 0) >= (strength[y] ?? 0) ? x : y);
  const weaker = (x, y) => (stronger(x, y) === x ? y : x);

  // resolved winner/loser per match (real if decided, else projected) — filled in match-number order so
  // every source match is already known when a later round references it.
  const winnerByMatch = {}, loserByMatch = {};

  const resolveSlot = (side) => {
    const real = sideTeamCode(side);
    if (real) return { code: real, real: true };              // REAL team (Phase 2 group-complete / Phase 4 advancement)
    if (!SHOW_PROJECTIONS) return { code: null, real: false }; // STRUCTURE-ONLY: no projected team -> the slot LABEL renders
    const t = side?.type;
    if (t === "group_winner" && side.group) return { code: win[side.group] ?? null, real: false };
    if (t === "group_runner_up" && side.group) return { code: ru[side.group] ?? null, real: false };
    if (t === "best_third") return { code: null, real: false }; // filled per-match below (needs match_number)
    if (t === "match_winner" && side.source_match != null) return { code: winnerByMatch[side.source_match] ?? null, real: false };
    if (t === "match_loser" && side.source_match != null) return { code: loserByMatch[side.source_match] ?? null, real: false };
    return { code: null, real: false };
  };

  const matchesByRound = {};
  for (const fx of fixtures) {
    const key = roundKeyOf(fx);
    const meta = ROUND_BY_KEY[key];
    const aSlot = fx.side_a || {}, bSlot = fx.side_b || {};
    const a = resolveSlot(aSlot), b = resolveSlot(bSlot);
    // best-third slots resolve by deterministic Annex C current-best assignment, projection only unless the
    // assigned third's group is complete. Fallback is the previous greedy projection if current-best cannot resolve.
    if (SHOW_PROJECTIONS && aSlot.type === "best_third" && !a.code) {
      const third = bt[fx.match_number];
      if (third?.code) { a.code = third.code; a.real = third.real === true; }
    }
    if (SHOW_PROJECTIONS && bSlot.type === "best_third" && !b.code) {
      const third = bt[fx.match_number];
      if (third?.code) { b.code = third.code; b.real = third.real === true; }
    }

    // real result? (the export's result = { a, b, winner, pens_a, pens_b }; a/b are the scores)
    const aScore = numOrNull(fx.result?.a);
    const bScore = numOrNull(fx.result?.b);
    const played = aScore != null && bScore != null;
    // a knockout can't truly draw: a level scoreline is settled by penalties. Read an explicit winner
    // signal (winner code, or penalty scores) so we never silently advance the strength favourite when
    // the real shootout went the other way.
    const winSig = fx.result?.winner ?? fx.result?.winner_code ?? null;
    const pensA = numOrNull(fx.result?.pens_a), pensB = numOrNull(fx.result?.pens_b);

    let decided = false, winnerCode = null, loserCode = null;
    if (played && aScore !== bScore) {
      decided = true;
      winnerCode = aScore > bScore ? a.code : b.code;
      loserCode = aScore > bScore ? b.code : a.code;
    } else if (played) {
      // level scoreline: settle ONLY by a winner signal that MATCHES one of the two sides, else by penalties. If
      // neither yields a valid side, leave UNDECIDED (NEVER default to side A on a winner code that matches neither
      // side — BRACKET-1 / INT-3). The projection fallback below is OFF in structure-only mode.
      const sigWinner = winSig === a.code ? a.code : winSig === b.code ? b.code : null;
      const penWinner = (pensA != null && pensB != null && pensA !== pensB) ? (pensA > pensB ? a.code : b.code) : null;
      const w = sigWinner ?? penWinner;
      if (w != null) { decided = true; winnerCode = w; loserCode = w === a.code ? b.code : a.code; }
      else if (SHOW_PROJECTIONS) { winnerCode = stronger(a.code, b.code); loserCode = weaker(a.code, b.code); }
    } else if (SHOW_PROJECTIONS) {
      // not played: project the favourite forward so the bracket still fills, but DON'T mark a winner/loser.
      winnerCode = stronger(a.code, b.code);
      loserCode = weaker(a.code, b.code);
    }
    // structure-only + undecided -> winnerCode/loserCode stay null, so downstream rounds render the slot LABEL
    // ("Winner M74") rather than a projected team; real results (Phase 4) fill side.team and decide normally.
    winnerByMatch[fx.match_number] = winnerCode;
    loserByMatch[fx.match_number] = loserCode;

    const mkSide = (slot, resolved, score) => ({
      code: resolved.code,
      label: slot.label ?? null,
      real: resolved.real,                       // true once the resolver filled a real team
      score: score,
      projected: SHOW_PROJECTIONS && !resolved.real && resolved.code != null && !decided, // dormant in structure-only
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
