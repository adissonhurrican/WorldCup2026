// REAL FIFA-2026 standings core. Pure & deterministic, NO RNG. REUSES the canonical Article-13 ladder
// (rankGroup = Ladder A within-group; rankThirdPlace = Ladder B cross-group best-third) from tiebreaker-ladders-2026
// — it does NOT reimplement any tiebreaker. One source for: per-team aggregation (P/W/D/L/GF/GA/GD/Pts), full-ladder
// within-group ranking, cross-group best-third resolution, and the three-band advance_state used by the export/UI.
// Consumers: ingest deriveStandings (writer), export/build-app-data (export block), build-real-standings (standalone).
// The aggregation mirrors deriveStandings' arithmetic; the RANKING delegates entirely to rankGroup/rankThirdPlace, so
// the stored/displayed table agrees with the conditional engine (which uses the very same ladder).

import { rankGroup, rankThirdPlace, type Standing, type GroupMatch, type Aux } from "./tiebreaker-ladders-2026";

export type ResultInput = { a: string; b: string; ga: number; gb: number };
export type TeamInfo = { code: string; name: string | null; group: string };
export type Agg = { code: string; name: string | null; group: string; played: number; won: number; drawn: number; lost: number; gf: number; ga: number; gd: number; pts: number };

export type AdvanceState = "qualified" | "best_third_in" | "best_third_out" | "eliminated" | "scheduled";
export type Band = "green" | "amber" | "gray" | null;

export type StandingTeam = {
  position: number | null; code: string; name: string | null;
  played: number; won: number; drawn: number; lost: number;
  goals_for: number; goals_against: number; goal_difference: number; points: number;
  advance_state: AdvanceState; band: Band; decided: boolean;
};
export type GroupStanding = { group: string; complete: boolean; games_played: number; standings: StandingTeam[] };
export type ThirdEntry = { code: string; group: string; points: number; goal_difference: number; goals_for: number; rank: number; in_best_8: boolean; group_complete: boolean };
export type RealStandings = {
  label: string; source_label: string; status: "not_started" | "in_progress" | "complete";
  results_counted: number; groups_complete: number;
  groups: GroupStanding[];
  best_third_race: { decided: boolean; qualify_count: number; note: string; ranked: ThirdEntry[] };
};

const TEAM_GROUP_GAMES = 3; // each team plays 3 group games (4-team round robin)

// ---- AGGREGATION (P/W/D/L/GF/GA/GD/Pts) — the deriveStandings arithmetic, shared ----
export function aggregateStandings(teams: TeamInfo[], results: ResultInput[]): Map<string, Agg> {
  const table = new Map<string, Agg>();
  for (const t of teams) table.set(t.code, { code: t.code, name: t.name, group: t.group, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, gd: 0, pts: 0 });
  for (const r of results) {
    const a = table.get(r.a), b = table.get(r.b); if (!a || !b) continue;
    a.played++; b.played++; a.gf += r.ga; a.ga += r.gb; b.gf += r.gb; b.ga += r.ga;
    if (r.ga > r.gb) { a.won++; a.pts += 3; b.lost++; }
    else if (r.ga < r.gb) { b.won++; b.pts += 3; a.lost++; }
    else { a.drawn++; b.drawn++; a.pts++; b.pts++; }
  }
  for (const row of table.values()) row.gd = row.gf - row.ga;
  return table;
}

// mutual matches among a group's teams (needed for Ladder A head-to-head)
export function groupMatchesOf(members: Set<string>, results: ResultInput[]): GroupMatch[] {
  return results.filter((r) => members.has(r.a) && members.has(r.b)).map((r) => ({ a: r.a, b: r.b, ga: r.ga, gb: r.gb }));
}

// FULL-LADDER within-group order (REUSES rankGroup — Ladder A). Returns codes best -> worst.
export function rankGroupFull(groupRows: Agg[], results: ResultInput[], aux: Aux): string[] {
  const members = new Set(groupRows.map((r) => r.code));
  const standings: Standing[] = groupRows.map((r) => ({ team: r.code, pts: r.pts, gf: r.gf, ga: r.ga, gd: r.gd }));
  return rankGroup(standings, groupMatchesOf(members, results), aux).map((s) => s.team);
}

export function groupKeysOf(teams: TeamInfo[]): string[] {
  return [...new Set(teams.map((t) => t.group))].filter(Boolean).sort();
}

// HIGH-LEVEL: the real-standings block with three-band advance_state + graceful status.
// REUSES rankGroup (within-group) and rankThirdPlace (cross-group best-third); no tiebreaker logic lives here.
export function buildRealStandings(teams: TeamInfo[], results: ResultInput[], aux: Aux): RealStandings {
  const agg = aggregateStandings(teams, results);
  const groupKeys = groupKeysOf(teams);
  const resultsCounted = results.length;
  const groups: GroupStanding[] = [];
  const thirdRows: Agg[] = [];
  let groupsComplete = 0;

  for (const g of groupKeys) {
    const rows = [...agg.values()].filter((r) => r.group === g);
    const ordered = rankGroupFull(rows, results, aux).map((c) => agg.get(c)!);
    const gamesPlayed = ordered.reduce((s, r) => s + r.played, 0) / 2;
    const complete = ordered.length >= 4 && ordered.every((r) => r.played >= TEAM_GROUP_GAMES);
    if (complete) groupsComplete++;
    // PER-TEAM gate (first-material-run lesson, refined): a group contributes its third-placer to the
    // cross-group race only once THAT TEAM has actually played. Gating on the group alone wasn't enough:
    // after the opener (MEX-RSA), Czechia sat "3rd, IN" off zero games — occupying the slot purely via
    // the ladder's all-equal fallback (FIFA ranking), not via any result involving them. A team appears
    // with an IN/OUT verdict only when its third-place standing reflects its own results. Unplayed
    // thirds are simply absent ("provisional from results so far"), NOT substituted with the predicted 3rd.
    if (ordered[2] && ordered[2].played > 0) thirdRows.push(ordered[2]); // current 3rd place (full-ladder)
    const started = gamesPlayed > 0;
    const standings: StandingTeam[] = ordered.map((r, i) => {
      let advance_state: AdvanceState = "scheduled"; let band: Band = null; let decided = false;
      if (started) {
        if (i <= 1) { advance_state = "qualified"; band = "green"; decided = complete; }
        else if (i === 3) { advance_state = "eliminated"; band = "gray"; decided = complete; }
        else { advance_state = "best_third_out"; band = "amber"; decided = false; } // refined by the cross-group cut below
      }
      return { position: started ? i + 1 : null, code: r.code, name: r.name, played: r.played, won: r.won, drawn: r.drawn, lost: r.lost, goals_for: r.gf, goals_against: r.ga, goal_difference: r.gd, points: r.pts, advance_state, band, decided };
    });
    groups.push({ group: g, complete, games_played: gamesPlayed, standings });
  }

  const allComplete = groupKeys.length > 0 && groupsComplete === groupKeys.length;
  // cross-group best-third (Ladder B, NO H2H) — REUSES rankThirdPlace. Empty until the first result lands (graceful).
  const ranked: ThirdEntry[] = [];
  if (resultsCounted > 0) {
    const orderedThirds = rankThirdPlace(thirdRows.map((r) => ({ team: r.code, pts: r.pts, gf: r.gf, ga: r.ga, gd: r.gd })), aux);
    orderedThirds.forEach((s, i) => {
      const a = agg.get(s.team)!; const grp = groups.find((gg) => gg.group === a.group)!;
      ranked.push({ code: s.team, group: a.group, points: s.pts, goal_difference: s.gd, goals_for: s.gf, rank: i + 1, in_best_8: i < 8, group_complete: grp.complete });
    });
    // refine 3rd-placed teams' advance_state with the cross-group cut. The cut is FINAL only once every group is done.
    const rankByCode = new Map(ranked.map((t) => [t.code, t.rank]));
    for (const grp of groups) {
      const third = grp.standings.find((t) => t.position === 3); if (!third) continue;
      const r = rankByCode.get(third.code) ?? 99;
      third.advance_state = r <= 8 ? "best_third_in" : "best_third_out"; third.band = "amber"; third.decided = allComplete;
    }
  }

  const status: RealStandings["status"] = resultsCounted === 0 ? "not_started" : allComplete ? "complete" : "in_progress";
  const note = resultsCounted === 0
    ? "Not started — group games begin 2026-06-11; the table fills from verified results as matches finish."
    : allComplete
      ? "All 12 groups complete — the eight best third-placed teams are final."
      : "Best-third race not yet decided — it is final only once all 12 groups finish; the order below is provisional from results so far.";
  return {
    label: "Real group table computed from verified match results using the FIFA 2026 Article 13 tiebreakers — distinct from the predicted/projected probabilities table.",
    source_label: "our verified results + the 2026 advancement rules",
    status, results_counted: resultsCounted, groups_complete: groupsComplete, groups,
    best_third_race: { decided: allComplete, qualify_count: 8, note, ranked },
  };
}
