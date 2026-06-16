// THIN deterministic team-path resolver. NOT an engine — no reasoning, no model, no RNG. It is a LOOKUP:
// (group, finishing position) -> R32 destination (match number + venue + date-or-window + opponent slot), read from the
// authoritative public.knockout_schedule (whose R32 slots cross-checked all-16-match against roundOf32Slots).
// Opponent NAME is DELEGATED: the caller passes the group simulation's PROJECTED finishers (argmax of stored finish
// probabilities); this module never recomputes finishers. The real opponent (post-group-stage bracket resolver) is left
// as real_opponent:null — a hook to fill later. Dates: exact where date_confirmed, otherwise the round window (never guessed).

import path from "node:path";
import { fileURLToPath } from "node:url";

export type SlotJson = { type: string; group?: string; pool?: string[]; match?: number; label: string };
export type KnockoutRow = {
  match_number: number; round: string;
  slot_a_label: string; slot_b_label: string; slot_a: SlotJson; slot_b: SlotJson;
  venue: string | null; city: string | null; venue_timezone: string | null;
  round_window: string | null; match_date: string | null; kickoff_utc: string | null; date_confirmed: boolean;
};
export type Projected = { code: string; name: string } | null;
export type ProjectedFinishers = {
  winner: (group: string) => Projected;
  runnerUp: (group: string) => Projected;
  bestThirdFromPool: (pool: string[]) => Projected;
  thirdOf: (group: string) => { code: string; name: string; weight: number } | null;
};
// Global one-pass best-third allocation: slot match_number -> the single projected third filling it.
export type BestThirdAllocation = Map<number, Projected>;

// REAL finishers (Phase 2): names a concrete R32 opponent ONLY when its slot is mathematically determined —
// winner/runnerUp resolve once THAT group is COMPLETE; thirdForMatch resolves once ALL groups are complete (the
// eight qualifying thirds are known) via the verified Annex C allocation. Returns null until then -> projection shows.
export type RealFinishers = {
  winner: (group: string) => Projected;
  runnerUp: (group: string) => Projected;
  thirdForMatch: (matchNumber: number) => Projected;
};

export type Destination = {
  match_number: number; round: string;
  venue: string | null; city: string | null; venue_timezone: string | null;
  date_confirmed: boolean; match_date: string | null; kickoff_utc: string | null; round_window: string | null;
  opponent_slot: string; opponent_kind: string;
  projected_opponent: Projected;   // from the group sim; narrows as the group stage progresses
  real_opponent: Projected;        // hook: bracket resolver fills the real team after the group stage (null for now)
};

// ----- projected finishers built from the group sim's stored probabilities (delegation, not recomputation) -----
export type SimFinishRow = { code: string; name: string; group: string; p1: number; p2: number; p3: number; bestThird: number };
export function buildProjectedFinishers(rows: SimFinishRow[]): ProjectedFinishers {
  const byGroup: Record<string, SimFinishRow[]> = {};
  for (const r of rows) (byGroup[r.group] ??= []).push(r);
  // projected order within a group = by P(win group) desc (the SAME ordering the app's Groups tab uses), tiebreak P(2nd).
  // Taking positions from one ordering keeps winner / runner-up / third distinct (independent argmaxes could collide).
  const order = (g: string): SimFinishRow[] => (byGroup[g] ?? []).slice().sort((a, b) => (b.p1 - a.p1) || (b.p2 - a.p2));
  const at = (g: string, i: number): Projected => { const o = order(g)[i]; return o ? { code: o.code, name: o.name } : null; };
  return {
    winner: (g) => at(g, 0),
    runnerUp: (g) => at(g, 1),
    bestThirdFromPool: (pool) => {
      // each pool group's projected third (3rd in the projected order), then the one most likely to advance as a best third
      let best: SimFinishRow | null = null;
      for (const g of pool) { const third = order(g)[2]; if (!third) continue; if (!best || third.bestThird > best.bestThird) best = third; }
      return best ? { code: best.code, name: best.name } : null;
    },
    thirdOf: (g) => { const o = order(g)[2]; return o ? { code: o.code, name: o.name, weight: o.bestThird } : null; },
  };
}

// GLOBAL GREEDY DE-DUP (Option C): the naive per-pool argmax names the single strongest third in EVERY
// pool that contains its group, so one team (e.g. the runaway-best third) is projected into many
// mutually-exclusive slots. A best third fills exactly ONE R32 slot, so allocate once across all eight
// best-third slots: rank every (group-third, slot) candidate by the third's advance-as-third weight and
// assign greedily — a third, once placed, can't fill another slot; a slot, once filled, is taken. Each
// slot then shows a DISTINCT projected opponent. Approximates the real Annex C allocation without needing
// the 495-row table or the final qualifiers (which aren't known until the group stage ends).
export function buildBestThirdAllocation(r32rows: KnockoutRow[], pf: ProjectedFinishers): BestThirdAllocation {
  type Cand = { group: string; match: number; code: string; name: string; weight: number };
  const slots: { match: number; pool: string[] }[] = [];
  for (const row of r32rows) {
    if (row.slot_a.type === "best_third" && row.slot_a.pool) slots.push({ match: row.match_number, pool: row.slot_a.pool });
    if (row.slot_b.type === "best_third" && row.slot_b.pool) slots.push({ match: row.match_number, pool: row.slot_b.pool });
  }
  const cands: Cand[] = [];
  for (const s of slots) {
    for (const g of s.pool) {
      const t = pf.thirdOf(g);
      if (t) cands.push({ group: g, match: s.match, code: t.code, name: t.name, weight: t.weight });
    }
  }
  // strongest third first; deterministic ties by lowest match number, then group letter
  cands.sort((a, b) => (b.weight - a.weight) || (a.match - b.match) || a.group.localeCompare(b.group));
  const alloc: BestThirdAllocation = new Map();
  const usedGroup = new Set<string>();
  for (const c of cands) {
    if (alloc.has(c.match) || usedGroup.has(c.group)) continue;
    alloc.set(c.match, { code: c.code, name: c.name });
    usedGroup.add(c.group);
  }
  // graceful: any slot left unfilled (all its pool groups already taken — won't happen with 12 groups/8
  // slots) falls back to the per-pool argmax so the slot is never blank.
  for (const s of slots) if (!alloc.has(s.match)) alloc.set(s.match, pf.bestThirdFromPool(s.pool));
  return alloc;
}

// Structural view of the REAL-standings resolver output this module consumes (it does NOT import standings-core;
// the caller passes the resolver's output + the Annex C resolve fn, so this stays a pure, decoupled lookup).
export type RealStandingsLike = {
  groups: Array<{ group: string; complete: boolean; standings: Array<{ code: string }> }>;
  best_third_race: { decided: boolean; ranked: Array<{ group: string; in_best_8: boolean }> };
};
export type ThirdAllocationResult = { resolved: boolean; assignments_by_match: Record<number, string> };

// Build a RealFinishers from the resolver's final standings (CONSUMED read-only) + an injected Annex C resolver.
// winner/runnerUp name a team only for a COMPLETE group; thirds are allocated ONLY once the best-third race is
// decided (all groups complete -> the eight qualifiers known), then routed to R32 matches by the Annex C combination.
export function buildRealFinishers(
  real: RealStandingsLike,
  resolveThirds: (advancingGroups: string[]) => ThirdAllocationResult,
  nameOf: (code: string) => string,
): RealFinishers {
  const byGroup = new Map(real.groups.map((g) => [g.group, g]));
  const teamOf = (code?: string | null): Projected => (code ? { code, name: nameOf(code) } : null);
  const winner = (g: string): Projected => { const gg = byGroup.get(g); return gg?.complete ? teamOf(gg.standings[0]?.code) : null; };
  const runnerUp = (g: string): Projected => { const gg = byGroup.get(g); return gg?.complete ? teamOf(gg.standings[1]?.code) : null; };
  const thirdByMatch: Record<number, Projected> = {};
  if (real.best_third_race.decided) {
    const advancing = real.best_third_race.ranked.filter((t) => t.in_best_8);
    const alloc = advancing.length === 8 ? resolveThirds(advancing.map((t) => t.group)) : null;
    if (alloc?.resolved) {
      for (const [m, grp] of Object.entries(alloc.assignments_by_match)) thirdByMatch[Number(m)] = teamOf(byGroup.get(grp)?.standings[2]?.code);
    }
  }
  return { winner, runnerUp, thirdForMatch: (m) => thirdByMatch[m] ?? null };
}

function opponentProjection(slot: SlotJson, pf: ProjectedFinishers): { kind: string; projected: Projected } {
  if (slot.type === "group_winner" && slot.group) return { kind: "group_winner", projected: pf.winner(slot.group) };
  if (slot.type === "group_runner_up" && slot.group) return { kind: "group_runner_up", projected: pf.runnerUp(slot.group) };
  if (slot.type === "best_third" && slot.pool) return { kind: "best_third", projected: pf.bestThirdFromPool(slot.pool) };
  return { kind: slot.type, projected: null }; // match_winner/loser never appear as an R32 opponent
}
function destination(row: KnockoutRow, oppSlot: SlotJson, pf: ProjectedFinishers, btAlloc?: BestThirdAllocation, real?: RealFinishers): Destination {
  // best-third opponent comes from the GLOBAL de-duped allocation (keyed by this row's match number) so
  // no team is named in two slots; winner/runner-up opponents stay per-group via pf (unchanged).
  const opp = (oppSlot.type === "best_third" && btAlloc?.has(row.match_number))
    ? { kind: "best_third", projected: btAlloc.get(row.match_number) ?? null }
    : opponentProjection(oppSlot, pf);
  // REAL opponent (Phase 2): named only when the opponent slot is mathematically determined (feeder group
  // complete / eight best thirds known). Null until then -> consumers fall back to projected_opponent. The
  // greedy projection above is UNTOUCHED. match_winner/loser never appear as an R32 opponent.
  const real_opponent: Projected = !real ? null
    : oppSlot.type === "group_winner" && oppSlot.group ? real.winner(oppSlot.group)
    : oppSlot.type === "group_runner_up" && oppSlot.group ? real.runnerUp(oppSlot.group)
    : oppSlot.type === "best_third" ? real.thirdForMatch(row.match_number)
    : null;
  return {
    match_number: row.match_number, round: row.round,
    venue: row.venue, city: row.city, venue_timezone: row.venue_timezone,
    date_confirmed: row.date_confirmed, match_date: row.match_date, kickoff_utc: row.kickoff_utc, round_window: row.round_window,
    opponent_slot: oppSlot.label, opponent_kind: opp.kind,
    projected_opponent: opp.projected, real_opponent,
  };
}

export type BestThirdPath = {
  conditional: true; advances_as_best_third_required: true; eligible_slot_count: number; note: string; eligible_slots: Destination[];
};
export type TeamPath = { as_group_winner: Destination | null; as_runner_up: Destination | null; as_best_third: BestThirdPath };

/** Resolve a group's R32 destinations for finishing 1st / 2nd / 3rd. r32rows = the 16 round_of_32 knockout_schedule rows. */
export function resolveTeamPath(group: string, r32rows: KnockoutRow[], pf: ProjectedFinishers, btAlloc?: BestThirdAllocation, real?: RealFinishers): TeamPath {
  const asPos = (posType: "group_winner" | "group_runner_up"): Destination | null => {
    for (const row of r32rows) {
      if (row.slot_a.type === posType && row.slot_a.group === group) return destination(row, row.slot_b, pf, btAlloc, real);
      if (row.slot_b.type === posType && row.slot_b.group === group) return destination(row, row.slot_a, pf, btAlloc, real);
    }
    return null;
  };
  const eligible: Destination[] = [];
  for (const row of r32rows) {
    if (row.slot_a.type === "best_third" && row.slot_a.pool?.includes(group)) eligible.push(destination(row, row.slot_b, pf, btAlloc, real));
    else if (row.slot_b.type === "best_third" && row.slot_b.pool?.includes(group)) eligible.push(destination(row, row.slot_a, pf, btAlloc, real));
  }
  eligible.sort((a, b) => a.match_number - b.match_number);
  const as_best_third: BestThirdPath = {
    conditional: true, advances_as_best_third_required: true, eligible_slot_count: eligible.length,
    note: `Only if ${group}'s third-placed team is among the eight best thirds. Opponents are PROJECTED — the exact slot (1 of ${eligible.length}) is set by the Annex C combination once all groups finish.`,
    eligible_slots: eligible,
  };
  return { as_group_winner: asPos("group_winner"), as_runner_up: asPos("group_runner_up"), as_best_third };
}

// ---------------------------------------------------------------------------------------------------------------
// Unit test (no DB): real_opponent population from synthetic FINAL standings via the real Annex C core (dynamic
// import, so normal imports stay decoupled). Proves full completion fills the right teams (winners/runners +
// Annex C thirds, 32 unique) and partial completion leaves undetermined slots null.
//   npx tsx scripts/worldcup/knockout-path-core.ts --path-test
// (distinct flag: the dynamically-imported annex-c-allocation-core has its own --unit-test self-run.)
// ---------------------------------------------------------------------------------------------------------------
const TEST_GROUPS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];
function syntheticR32Rows(): KnockoutRow[] {
  const W = (g: string): SlotJson => ({ type: "group_winner", group: g, label: `Winner ${g}` });
  const R = (g: string): SlotJson => ({ type: "group_runner_up", group: g, label: `Runner-up ${g}` });
  const T = (pool: string[]): SlotJson => ({ type: "best_third", pool, label: `3rd ${pool.join("/")}` });
  const row = (n: number, a: SlotJson, b: SlotJson): KnockoutRow => ({
    match_number: n, round: "round_of_32", slot_a_label: a.label, slot_b_label: b.label, slot_a: a, slot_b: b,
    venue: null, city: null, venue_timezone: null, round_window: null, match_date: null, kickoff_utc: null, date_confirmed: false,
  });
  return [
    row(73, R("A"), R("B")), row(74, W("E"), T(["A", "B", "C", "D", "F"])), row(75, W("F"), R("C")), row(76, W("C"), R("F")),
    row(77, W("I"), T(["C", "D", "F", "G", "H"])), row(78, R("E"), R("I")), row(79, W("A"), T(["C", "E", "F", "H", "I"])),
    row(80, W("L"), T(["E", "H", "I", "J", "K"])), row(81, W("D"), T(["B", "E", "F", "I", "J"])), row(82, W("G"), T(["A", "E", "H", "I", "J"])),
    row(83, R("K"), R("L")), row(84, W("H"), R("J")), row(85, W("B"), T(["E", "F", "G", "I", "J"])), row(86, W("J"), R("H")),
    row(87, W("K"), T(["D", "E", "I", "J", "L"])), row(88, R("D"), R("G")),
  ];
}
function syntheticStandings(advancingThirds: string[], incomplete: string[] = [], decided = true): RealStandingsLike {
  const inc = new Set(incomplete);
  const adv = new Set(advancingThirds);
  return {
    groups: TEST_GROUPS.map((g) => ({ group: g, complete: !inc.has(g), standings: [1, 2, 3, 4].map((i) => ({ code: `${g}${i}` })) })),
    best_third_race: { decided, ranked: TEST_GROUPS.map((g) => ({ group: g, in_best_8: adv.has(g) })) },
  };
}
async function runUnitTest(): Promise<boolean> {
  let pass = true;
  const ok = (cond: boolean, label: string) => { if (!cond) pass = false; console.log(`  [${cond ? "OK" : "XX"}] ${label}`); };
  console.log("=== knockout-path-core real_opponent — unit test (no DB) ===");
  const { resolveThirdPlaceAllocation, loadAnnexCMapping } = await import("./annex-c-allocation-core");
  const mapping = loadAnnexCMapping();
  const resolveThirds = (groups: string[]) => { const a = resolveThirdPlaceAllocation(mapping, groups); return { resolved: a.resolved, assignments_by_match: a.assignments_by_match }; };
  const rows = syntheticR32Rows();
  // minimal projected finishers (so resolveTeamPath also fills projected_opponent) — not the focus here
  const simRows: SimFinishRow[] = TEST_GROUPS.flatMap((g) => [1, 2, 3, 4].map((i) => ({ code: `${g}${i}`, name: `${g}${i}`, group: g, p1: i === 1 ? 0.7 : 0.1, p2: i === 2 ? 0.6 : 0.1, p3: i === 3 ? 0.6 : 0.1, bestThird: i === 3 ? 0.5 : 0 })));
  const pf = buildProjectedFinishers(simRows);
  const btAlloc = buildBestThirdAllocation(rows, pf);

  // ---- FULL completion: all groups done, eight thirds known ----
  const advancing = ["A", "B", "C", "E", "G", "J", "K", "L"]; // combo 396
  const rf = buildRealFinishers(syntheticStandings(advancing), resolveThirds, (c) => c);
  const annex = resolveThirds(advancing);
  // reconstruct the 32 R32 team slots from RealFinishers (the same surface koSide uses for knockout_fixtures)
  const sideReal = (slot: SlotJson, m: number): Projected =>
    slot.type === "group_winner" && slot.group ? rf.winner(slot.group)
    : slot.type === "group_runner_up" && slot.group ? rf.runnerUp(slot.group)
    : slot.type === "best_third" ? rf.thirdForMatch(m) : null;
  const teams: string[] = [];
  for (const r of rows) { for (const s of [r.slot_a, r.slot_b]) { const t = sideReal(s, r.match_number); if (t) teams.push(t.code); } }
  ok(teams.length === 32 && new Set(teams).size === 32, `full: 32 real R32 teams, all unique (got ${teams.length}/${new Set(teams).size})`);
  // expected real set = 12 winners (g1) + 12 runners (g2) + 8 advancing thirds (g3)
  const expected = new Set([...TEST_GROUPS.map((g) => `${g}1`), ...TEST_GROUPS.map((g) => `${g}2`), ...advancing.map((g) => `${g}3`)]);
  ok(teams.length === expected.size && teams.every((t) => expected.has(t)), "full: the 32 are exactly winners + runners + the 8 advancing thirds");
  // each best-third slot routed per Annex C: M{n} third == `${assignedGroup}3`
  let thirdsOk = true;
  for (const r of rows) for (const s of [r.slot_a, r.slot_b]) if (s.type === "best_third") { const g = annex.assignments_by_match[r.match_number]; if (rf.thirdForMatch(r.match_number)?.code !== `${g}3`) thirdsOk = false; }
  ok(thirdsOk, "full: every best-third slot's real team matches the Annex C combination assignment");
  // resolveTeamPath threading: group A is runner-up in M73 (vs runner-up B) and winner in M79 (vs a third)
  const pathA = resolveTeamPath("A", rows, pf, btAlloc, rf);
  ok(pathA.as_runner_up?.real_opponent?.code === "B2", `full: A's runner-up path real_opponent = B2 (got ${pathA.as_runner_up?.real_opponent?.code})`);
  ok(pathA.as_group_winner?.real_opponent?.code === `${annex.assignments_by_match[79]}3`, `full: A's winner path real_opponent = M79 Annex C third (got ${pathA.as_group_winner?.real_opponent?.code})`);

  // ---- PARTIAL completion: groups B and I not complete, thirds not yet decided ----
  const rfP = buildRealFinishers(syntheticStandings(advancing, ["B", "I"], false), resolveThirds, (c) => c);
  ok(rfP.winner("B") === null && rfP.runnerUp("B") === null, "partial: incomplete group B winner/runner-up stay null");
  ok(rfP.winner("A")?.code === "A1", "partial: complete group A winner still resolves (A1)");
  ok(rfP.thirdForMatch(74) === null, "partial: thirds undecided -> all best-third slots null");
  const pathAp = resolveTeamPath("A", rows, pf, btAlloc, rfP);
  ok(pathAp.as_runner_up?.real_opponent === null, "partial: A runner-up opponent (B, incomplete) real_opponent null");
  ok(pathAp.as_group_winner?.real_opponent === null, "partial: A winner opponent (a third, undecided) real_opponent null");
  // an all-complete-feeders match still resolves under partial: M78 = runner-up E vs runner-up I; I incomplete -> E side resolves, I side null
  const pathE = resolveTeamPath("E", rows, pf, btAlloc, rfP);
  ok(pathE.as_runner_up?.real_opponent === null, "partial: E runner-up opponent (I, incomplete) null");

  // ---- no RealFinishers passed -> real_opponent stays null (byte-identical to pre-Phase-2) ----
  const pathNone = resolveTeamPath("A", rows, pf, btAlloc);
  ok(pathNone.as_runner_up?.real_opponent === null && pathNone.as_group_winner?.real_opponent === null, "no real arg: real_opponent null (back-compat)");
  return pass;
}
// entrypoint guard: only self-run when invoked DIRECTLY (never when imported by build-app-data).
const isMainPath = !!process.argv[1] && (fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) || process.argv[1].endsWith("knockout-path-core.ts"));
if (isMainPath && process.argv.includes("--path-test")) {
  runUnitTest().then((okAll) => {
    console.log("\nKNOCKOUT-PATH real_opponent:", okAll ? "PASS — real teams fill when determined; null until then; resolver consumed read-only." : "FAIL");
    process.exit(okAll ? 0 : 1);
  });
}
