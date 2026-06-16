import { loadAnnexCMapping, resolveThirdPlaceAllocation, concatKey } from "./annex-c-allocation-core";

export type GroupCode = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "J" | "K" | "L";
export type ConditionalMatch = "M74" | "M77" | "M79" | "M80" | "M81" | "M82" | "M85" | "M87";
export type FinishSlot = `${1 | 2}${GroupCode}`;
export type ThirdPoolSlot = `3${string}`;

export type RegulationTeamStanding<TTeam extends string = string> = {
  team_code: TTeam;
  group: GroupCode;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  gf: number;
  ga: number;
  gd: number;
  points: number;
  rank: number;
  qualification_status?: string;
};

export type RankedStanding<TTeam extends string = string> = RegulationTeamStanding<TTeam> & {
  unresolved_tiebreaker_needed: boolean;
  unresolved_tiebreaker_reason?: string;
};

export type ThirdPlaceTie<TTeam extends string = string> = {
  rank_range: string;
  crosses_qualification_cutoff: boolean;
  teams: Array<{
    team_code: TTeam;
    group: GroupCode;
    points: number;
    gd: number;
    gf: number;
  }>;
  unresolved_tiebreaker_needed: true;
  missing_tiebreakers: string[];
};

export type ThirdPlaceRankingResult<TTeam extends string = string> = {
  third_place_ranking: Array<RankedStanding<TTeam> & { third_place_rank: number }>;
  selected_third_place_teams: Array<RankedStanding<TTeam> & { third_place_rank: number }>;
  selected_third_place_groups: GroupCode[];
  third_place_cutoff_unresolved: boolean;
  unresolved_third_place_ties: Array<ThirdPlaceTie<TTeam>>;
  unresolved_tiebreaker_needed: boolean;
};

export type RoundOf32Slot = {
  match_number: number;
  label: string;
  side_a_slot: FinishSlot;
  side_b_slot: FinishSlot | ThirdPoolSlot;
  side_b_third_place_pool?: GroupCode[];
  source_status: "fixed_official_slot" | "conditional_official_slot";
};

export type ThirdPlaceAllocationRow = {
  key: string;
  source: {
    provider: "FIFA";
    document: string;
    annex: "Annexe C";
    option: number;
    pdf_page_label: string;
    source_url: string;
    source_note: string;
  };
  assignments: Record<ConditionalMatch, GroupCode>;
};

export const roundOf32Slots: RoundOf32Slot[] = [
  { match_number: 73, label: "2A vs 2B", side_a_slot: "2A", side_b_slot: "2B", source_status: "fixed_official_slot" },
  { match_number: 74, label: "1E vs 3A/B/C/D/F", side_a_slot: "1E", side_b_slot: "3ABCDF", side_b_third_place_pool: ["A", "B", "C", "D", "F"], source_status: "conditional_official_slot" },
  { match_number: 75, label: "1F vs 2C", side_a_slot: "1F", side_b_slot: "2C", source_status: "fixed_official_slot" },
  { match_number: 76, label: "1C vs 2F", side_a_slot: "1C", side_b_slot: "2F", source_status: "fixed_official_slot" },
  { match_number: 77, label: "1I vs 3C/D/F/G/H", side_a_slot: "1I", side_b_slot: "3CDFGH", side_b_third_place_pool: ["C", "D", "F", "G", "H"], source_status: "conditional_official_slot" },
  { match_number: 78, label: "2E vs 2I", side_a_slot: "2E", side_b_slot: "2I", source_status: "fixed_official_slot" },
  { match_number: 79, label: "1A vs 3C/E/F/H/I", side_a_slot: "1A", side_b_slot: "3CEFHI", side_b_third_place_pool: ["C", "E", "F", "H", "I"], source_status: "conditional_official_slot" },
  { match_number: 80, label: "1L vs 3E/H/I/J/K", side_a_slot: "1L", side_b_slot: "3EHIJK", side_b_third_place_pool: ["E", "H", "I", "J", "K"], source_status: "conditional_official_slot" },
  { match_number: 81, label: "1D vs 3B/E/F/I/J", side_a_slot: "1D", side_b_slot: "3BEFIJ", side_b_third_place_pool: ["B", "E", "F", "I", "J"], source_status: "conditional_official_slot" },
  { match_number: 82, label: "1G vs 3A/E/H/I/J", side_a_slot: "1G", side_b_slot: "3AEHIJ", side_b_third_place_pool: ["A", "E", "H", "I", "J"], source_status: "conditional_official_slot" },
  { match_number: 83, label: "2K vs 2L", side_a_slot: "2K", side_b_slot: "2L", source_status: "fixed_official_slot" },
  { match_number: 84, label: "1H vs 2J", side_a_slot: "1H", side_b_slot: "2J", source_status: "fixed_official_slot" },
  { match_number: 85, label: "1B vs 3E/F/G/I/J", side_a_slot: "1B", side_b_slot: "3EFGIJ", side_b_third_place_pool: ["E", "F", "G", "I", "J"], source_status: "conditional_official_slot" },
  { match_number: 86, label: "1J vs 2H", side_a_slot: "1J", side_b_slot: "2H", source_status: "fixed_official_slot" },
  { match_number: 87, label: "1K vs 3D/E/I/J/L", side_a_slot: "1K", side_b_slot: "3DEIJL", side_b_third_place_pool: ["D", "E", "I", "J", "L"], source_status: "conditional_official_slot" },
  { match_number: 88, label: "2D vs 2G", side_a_slot: "2D", side_b_slot: "2G", source_status: "fixed_official_slot" },
];

// RETIRED: the hand-entered 1-row Annex C stub (only key "A,B,C,E,G,J,K,L" = combination 396) used to live here.
// It is replaced by the full, validated 495-row table in annex-c-allocation-core.ts (the single source, read from
// data/external/fifa/annex-c-r32-third-place-mapping.json). The old row is preserved exactly as combination 396.
// canApplyAnnexC / resolveAnnexCAllocation below now delegate to that core, so ALL 495 combinations resolve.

function compareCoreCriteria<TTeam extends string>(a: RegulationTeamStanding<TTeam>, b: RegulationTeamStanding<TTeam>) {
  return b.points - a.points || b.gd - a.gd || b.gf - a.gf;
}

function sameCoreCriteria<TTeam extends string>(a: RegulationTeamStanding<TTeam>, b: RegulationTeamStanding<TTeam>) {
  return a.points === b.points && a.gd === b.gd && a.gf === b.gf;
}

function findCoreCriteriaTies<TTeam extends string>(
  rankedTeams: Array<RegulationTeamStanding<TTeam>>,
  cutoffRank?: number,
): Array<ThirdPlaceTie<TTeam>> {
  const ties: Array<ThirdPlaceTie<TTeam>> = [];
  let index = 0;

  while (index < rankedTeams.length) {
    const tiedTeams = [rankedTeams[index]];
    let nextIndex = index + 1;
    while (nextIndex < rankedTeams.length && sameCoreCriteria(rankedTeams[index], rankedTeams[nextIndex])) {
      tiedTeams.push(rankedTeams[nextIndex]);
      nextIndex += 1;
    }

    if (tiedTeams.length > 1) {
      const startRank = index + 1;
      const endRank = nextIndex;
      ties.push({
        rank_range: startRank === endRank ? `${startRank}` : `${startRank}-${endRank}`,
        crosses_qualification_cutoff: cutoffRank ? startRank <= cutoffRank && endRank > cutoffRank : false,
        teams: tiedTeams.map((standing) => ({
          team_code: standing.team_code,
          group: standing.group,
          points: standing.points,
          gd: standing.gd,
          gf: standing.gf,
        })),
        unresolved_tiebreaker_needed: true,
        missing_tiebreakers: ["head_to_head_or_fair_play_if_applicable", "drawing_of_lots_or_other_fifa_defined_step"],
      });
    }

    index = nextIndex;
  }

  return ties;
}

export function rankGroupTeams<TTeam extends string>(
  groupTable: Array<RegulationTeamStanding<TTeam>>,
): {
  ranked_teams: Array<RankedStanding<TTeam>>;
  unresolved_ties: Array<ThirdPlaceTie<TTeam>>;
  unresolved_tiebreaker_needed: boolean;
} {
  const sorted = [...groupTable]
    .map((team, originalIndex) => ({ team, originalIndex }))
    .sort((a, b) => compareCoreCriteria(a.team, b.team) || a.originalIndex - b.originalIndex)
    .map(({ team }, index) => ({ ...team, rank: index + 1 }));
  const unresolvedTies = findCoreCriteriaTies(sorted);
  const unresolvedTeamCodes = new Set(unresolvedTies.flatMap((tie) => tie.teams.map((team) => team.team_code)));

  return {
    ranked_teams: sorted.map((team) => ({
      ...team,
      unresolved_tiebreaker_needed: unresolvedTeamCodes.has(team.team_code),
      unresolved_tiebreaker_reason: unresolvedTeamCodes.has(team.team_code)
        ? "Tie unresolved after points, goal difference, and goals for; deeper FIFA tiebreaker data is required."
        : undefined,
    })),
    unresolved_ties: unresolvedTies,
    unresolved_tiebreaker_needed: unresolvedTies.length > 0,
  };
}

export function rankThirdPlaceTeams<TTeam extends string>(
  thirdPlaceTeams: Array<RegulationTeamStanding<TTeam>>,
): ThirdPlaceRankingResult<TTeam> {
  const sorted = [...thirdPlaceTeams]
    .map((team, originalIndex) => ({ team, originalIndex }))
    .sort((a, b) => compareCoreCriteria(a.team, b.team) || a.originalIndex - b.originalIndex)
    .map(({ team }, index) => ({ ...team, rank: team.rank, third_place_rank: index + 1 }));
  const unresolvedThirdPlaceTies = findCoreCriteriaTies(sorted, 8);
  const unresolvedTeamCodes = new Set(unresolvedThirdPlaceTies.flatMap((tie) => tie.teams.map((team) => team.team_code)));
  const thirdPlaceCutoffUnresolved = unresolvedThirdPlaceTies.some((tie) => tie.crosses_qualification_cutoff);
  const thirdPlaceRanking = sorted.map((team) => ({
    ...team,
    unresolved_tiebreaker_needed: unresolvedTeamCodes.has(team.team_code),
    unresolved_tiebreaker_reason: unresolvedTeamCodes.has(team.team_code)
      ? "Tie unresolved after points, goal difference, and goals for; fair-play/deeper FIFA tiebreaker data is required."
      : undefined,
  }));

  return {
    third_place_ranking: thirdPlaceRanking,
    selected_third_place_teams: thirdPlaceCutoffUnresolved ? [] : thirdPlaceRanking.slice(0, 8),
    selected_third_place_groups: thirdPlaceCutoffUnresolved
      ? []
      : thirdPlaceRanking.slice(0, 8).map((standing) => standing.group).sort((a, b) => a.localeCompare(b)),
    third_place_cutoff_unresolved: thirdPlaceCutoffUnresolved,
    unresolved_third_place_ties: unresolvedThirdPlaceTies,
    unresolved_tiebreaker_needed: unresolvedThirdPlaceTies.length > 0,
  };
}

export function lookupKeyForGroups(groups: GroupCode[]) {
  return [...groups].sort((a, b) => a.localeCompare(b)).join(",");
}

export function canApplyAnnexC(selectedThirdPlaceGroups: GroupCode[], options: { thirdPlaceCutoffUnresolved?: boolean } = {}) {
  const errors: string[] = [];
  const lookupKey = lookupKeyForGroups(selectedThirdPlaceGroups);

  // Presence is now decided by the validated 495-row table (single source), keyed by sorted concatenation.
  let allocationRowPresent = false;
  try {
    allocationRowPresent = Boolean(loadAnnexCMapping().mappings[concatKey(selectedThirdPlaceGroups)]);
  } catch (error) {
    errors.push(`Annex C mapping load failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (options.thirdPlaceCutoffUnresolved) errors.push("Third-place qualification cutoff is unresolved; Annexe C cannot be applied.");
  if (selectedThirdPlaceGroups.length !== 8) errors.push(`Expected 8 selected third-place groups, found ${selectedThirdPlaceGroups.length}.`);
  if (new Set(selectedThirdPlaceGroups).size !== selectedThirdPlaceGroups.length) errors.push("Selected third-place groups are not unique.");
  if (!allocationRowPresent) errors.push(`No verified FIFA Annexe C allocation row exists for key ${lookupKey}.`);

  return {
    can_apply: errors.length === 0,
    lookup_key: lookupKey,
    allocation_row_present: allocationRowPresent,
    errors,
  };
}

export function resolveAnnexCAllocation(selectedThirdPlaceGroups: GroupCode[], options: { thirdPlaceCutoffUnresolved?: boolean } = {}) {
  const canApply = canApplyAnnexC(selectedThirdPlaceGroups, options);
  const errors = [...canApply.errors];

  // Resolve from the validated 495-row core (single source). Map its match-keyed result (74 -> group) back to
  // the engine's ConditionalMatch keys (M74 -> group) so this function's return shape is unchanged.
  const core = canApply.allocation_row_present
    ? resolveThirdPlaceAllocation(loadAnnexCMapping(), selectedThirdPlaceGroups)
    : null;

  if (!core || core.combination_number == null) {
    return {
      resolved: false,
      lookup_key: canApply.lookup_key,
      source: null,
      assignments: {},
      validation: {
        ...canApply,
        assigned_groups_count_valid: false,
        assigned_groups_unique: false,
        every_selected_group_assigned_once: false,
        every_assignment_in_selected_groups: false,
        every_assignment_allowed_by_slot_pool: false,
      },
      errors,
    };
  }

  const allocation = {
    assignments: Object.fromEntries(
      Object.entries(core.assignments_by_match).map(([m, group]) => [`M${m}`, group]),
    ) as Record<ConditionalMatch, GroupCode>,
    source: {
      provider: "FIFA" as const,
      document: "Regulations for the FIFA World Cup 26",
      annex: "Annexe C" as const,
      option: core.combination_number,
      pdf_page_label: "94",
      source_url: (loadAnnexCMapping().metadata.official_source?.url as string) ?? "https://digitalhub.fifa.com/m/636f5c9c6f29771f/original/FWC2026_regulations_EN.pdf",
      source_note: core.source_note ?? "",
    },
  };
  for (const e of core.errors) if (!errors.includes(e)) errors.push(e); // defensive (empty for the validated table)

  const selectedSet = new Set(selectedThirdPlaceGroups);
  const assignedEntries = Object.entries(allocation.assignments) as Array<[ConditionalMatch, GroupCode]>;
  const assignedGroups = assignedEntries.map(([, group]) => group);

  if (assignedEntries.length !== 8) errors.push(`Expected 8 conditional assignments, found ${assignedEntries.length}.`);
  if (new Set(assignedGroups).size !== assignedGroups.length) errors.push("Assigned third-place groups are not unique.");
  for (const [match, group] of assignedEntries) {
    const slot = roundOf32Slots.find((candidate) => candidate.match_number === Number(match.slice(1)));
    if (!selectedSet.has(group)) errors.push(`${match} assignment ${group} is not among selected third-place groups.`);
    if (!slot?.side_b_third_place_pool?.includes(group)) {
      errors.push(`${match} assignment ${group} is not allowed by pool ${slot?.side_b_third_place_pool?.join("/") ?? "unknown"}.`);
    }
  }
  for (const group of selectedThirdPlaceGroups) {
    if (!assignedGroups.includes(group)) errors.push(`Selected third-place group ${group} is not assigned.`);
  }

  return {
    resolved: errors.length === 0,
    lookup_key: canApply.lookup_key,
    source: allocation.source,
    assignments: errors.length === 0 ? allocation.assignments : {},
    validation: {
      ...canApply,
      assigned_groups_count_valid: assignedEntries.length === 8,
      assigned_groups_unique: new Set(assignedGroups).size === assignedGroups.length,
      every_selected_group_assigned_once: selectedThirdPlaceGroups.every((group) => assignedGroups.includes(group)) && selectedThirdPlaceGroups.length === new Set(assignedGroups).size,
      every_assignment_in_selected_groups: assignedGroups.every((group) => selectedSet.has(group)),
      every_assignment_allowed_by_slot_pool: assignedEntries.every(([match, group]) => {
        const slot = roundOf32Slots.find((candidate) => candidate.match_number === Number(match.slice(1)));
        return Boolean(slot?.side_b_third_place_pool?.includes(group));
      }),
    },
    errors,
  };
}

export function buildRoundOf32Preview<TTeam extends string>(
  groupTables: Record<GroupCode, Array<RankedStanding<TTeam>>>,
  thirdPlaceResult: ThirdPlaceRankingResult<TTeam>,
) {
  const annexC = resolveAnnexCAllocation(thirdPlaceResult.selected_third_place_groups, {
    thirdPlaceCutoffUnresolved: thirdPlaceResult.third_place_cutoff_unresolved,
  });
  const thirdPlaceByGroup = new Map(thirdPlaceResult.selected_third_place_teams.map((standing) => [standing.group, standing]));
  const candidateThirdPlaceTeams = thirdPlaceResult.third_place_cutoff_unresolved
    ? thirdPlaceResult.third_place_ranking
    : thirdPlaceResult.selected_third_place_teams;
  const fixedSlotsResolved = [];
  const conditionalSlots = [];
  const roundOf32Preview = [];
  const unresolvedThirdPlaceAssignments = [];

  for (const slot of roundOf32Slots) {
    const sideA = teamForSlot(slot.side_a_slot, groupTables);
    const base = {
      match_number: slot.match_number,
      slot_label: slot.label,
      side_a_slot: slot.side_a_slot,
      side_a_team: sideA?.team_code ?? null,
      source_status: slot.source_status,
    };

    if (!slot.side_b_third_place_pool) {
      const sideB = teamForSlot(slot.side_b_slot as FinishSlot, groupTables);
      const row = { ...base, side_b_slot: slot.side_b_slot, side_b_team: sideB?.team_code ?? null, resolved: Boolean(sideA && sideB), resolution_source: "fixed_official_slot" };
      fixedSlotsResolved.push(row);
      roundOf32Preview.push(row);
      continue;
    }

    if (annexC.resolved) {
      const match = `M${slot.match_number}` as ConditionalMatch;
      const thirdGroup = annexC.assignments[match] as GroupCode;
      const sideB = thirdPlaceByGroup.get(thirdGroup);
      const row = {
        ...base,
        side_b_slot: `3${thirdGroup}`,
        side_b_team: sideB?.team_code ?? null,
        third_place_group: thirdGroup,
        third_place_rank: sideB?.third_place_rank ?? null,
        third_place_pool: slot.side_b_third_place_pool,
        resolved: Boolean(sideA && sideB),
        resolution_source: "fifa_annexe_c",
        allocation_option: annexC.source?.option ?? null,
      };
      conditionalSlots.push(row);
      roundOf32Preview.push(row);
      continue;
    }

    const candidateThirds = candidateThirdPlaceTeams
      .filter((standing) => slot.side_b_third_place_pool!.includes(standing.group))
      .map((standing) => ({
        team_code: standing.team_code,
        group: standing.group,
        third_place_rank: standing.third_place_rank,
        points: standing.points,
        gd: standing.gd,
        gf: standing.gf,
        unresolved_tiebreaker_needed: standing.unresolved_tiebreaker_needed,
      }));
    const row = {
      ...base,
      side_b_slot: slot.side_b_slot,
      third_place_pool: slot.side_b_third_place_pool,
      candidate_third_place_teams_from_projection: candidateThirds,
      side_b_team: thirdPlaceResult.third_place_cutoff_unresolved
        ? "requires fair-play/deeper FIFA tiebreaker data before third-place qualifiers can be selected"
        : "requires official third-place allocation table",
      resolved: false,
    };
    conditionalSlots.push(row);
    roundOf32Preview.push(row);
    unresolvedThirdPlaceAssignments.push({
      match_number: slot.match_number,
      slot_label: slot.label,
      required_assignment: `${slot.side_b_slot} -> one team from pool ${slot.side_b_third_place_pool.join("/")}`,
      projected_candidate_teams: candidateThirds,
      status: thirdPlaceResult.third_place_cutoff_unresolved
        ? "third-place qualification cutoff unresolved; fair-play/deeper FIFA tiebreaker data required"
        : "requires official third-place allocation table",
    });
  }

  return {
    annex_c_applied: annexC.resolved,
    annex_c: annexC,
    third_place_cutoff_unresolved: thirdPlaceResult.third_place_cutoff_unresolved,
    allocation_lookup_key: annexC.lookup_key,
    fixed_slots_resolved: fixedSlotsResolved,
    conditional_slots: conditionalSlots,
    round_of_32_preview: roundOf32Preview,
    unresolved_third_place_assignments: unresolvedThirdPlaceAssignments,
  };
}

function teamForSlot<TTeam extends string>(slot: FinishSlot, groupTables: Record<GroupCode, Array<RankedStanding<TTeam>>>) {
  const finish = Number(slot[0]);
  const group = slot[1] as GroupCode;
  return groupTables[group]?.[finish - 1];
}
