// THIN deterministic team-path resolver. NOT an engine — no reasoning, no model, no RNG. It is a LOOKUP:
// (group, finishing position) -> R32 destination (match number + venue + date-or-window + opponent slot), read from the
// authoritative public.knockout_schedule (whose R32 slots cross-checked all-16-match against roundOf32Slots).
// Opponent NAME is DELEGATED: the caller passes the group simulation's PROJECTED finishers (argmax of stored finish
// probabilities); this module never recomputes finishers. The real opponent (post-group-stage bracket resolver) is left
// as real_opponent:null — a hook to fill later. Dates: exact where date_confirmed, otherwise the round window (never guessed).

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

function opponentProjection(slot: SlotJson, pf: ProjectedFinishers): { kind: string; projected: Projected } {
  if (slot.type === "group_winner" && slot.group) return { kind: "group_winner", projected: pf.winner(slot.group) };
  if (slot.type === "group_runner_up" && slot.group) return { kind: "group_runner_up", projected: pf.runnerUp(slot.group) };
  if (slot.type === "best_third" && slot.pool) return { kind: "best_third", projected: pf.bestThirdFromPool(slot.pool) };
  return { kind: slot.type, projected: null }; // match_winner/loser never appear as an R32 opponent
}
function destination(row: KnockoutRow, oppSlot: SlotJson, pf: ProjectedFinishers, btAlloc?: BestThirdAllocation): Destination {
  // best-third opponent comes from the GLOBAL de-duped allocation (keyed by this row's match number) so
  // no team is named in two slots; winner/runner-up opponents stay per-group via pf (unchanged).
  const opp = (oppSlot.type === "best_third" && btAlloc?.has(row.match_number))
    ? { kind: "best_third", projected: btAlloc.get(row.match_number) ?? null }
    : opponentProjection(oppSlot, pf);
  return {
    match_number: row.match_number, round: row.round,
    venue: row.venue, city: row.city, venue_timezone: row.venue_timezone,
    date_confirmed: row.date_confirmed, match_date: row.match_date, kickoff_utc: row.kickoff_utc, round_window: row.round_window,
    opponent_slot: oppSlot.label, opponent_kind: opp.kind,
    projected_opponent: opp.projected, real_opponent: null,
  };
}

export type BestThirdPath = {
  conditional: true; advances_as_best_third_required: true; eligible_slot_count: number; note: string; eligible_slots: Destination[];
};
export type TeamPath = { as_group_winner: Destination | null; as_runner_up: Destination | null; as_best_third: BestThirdPath };

/** Resolve a group's R32 destinations for finishing 1st / 2nd / 3rd. r32rows = the 16 round_of_32 knockout_schedule rows. */
export function resolveTeamPath(group: string, r32rows: KnockoutRow[], pf: ProjectedFinishers, btAlloc?: BestThirdAllocation): TeamPath {
  const asPos = (posType: "group_winner" | "group_runner_up"): Destination | null => {
    for (const row of r32rows) {
      if (row.slot_a.type === posType && row.slot_a.group === group) return destination(row, row.slot_b, pf, btAlloc);
      if (row.slot_b.type === posType && row.slot_b.group === group) return destination(row, row.slot_a, pf, btAlloc);
    }
    return null;
  };
  const eligible: Destination[] = [];
  for (const row of r32rows) {
    if (row.slot_a.type === "best_third" && row.slot_a.pool?.includes(group)) eligible.push(destination(row, row.slot_b, pf, btAlloc));
    else if (row.slot_b.type === "best_third" && row.slot_b.pool?.includes(group)) eligible.push(destination(row, row.slot_a, pf, btAlloc));
  }
  eligible.sort((a, b) => a.match_number - b.match_number);
  const as_best_third: BestThirdPath = {
    conditional: true, advances_as_best_third_required: true, eligible_slot_count: eligible.length,
    note: `Only if ${group}'s third-placed team is among the eight best thirds. Opponents are PROJECTED — the exact slot (1 of ${eligible.length}) is set by the Annex C combination once all groups finish.`,
    eligible_slots: eligible,
  };
  return { as_group_winner: asPos("group_winner"), as_runner_up: asPos("group_runner_up"), as_best_third };
}
