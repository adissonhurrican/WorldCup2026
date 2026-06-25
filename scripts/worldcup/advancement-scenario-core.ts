// Shared core for advancement-scenario-v1 (Phase 1 pre-tournament AND Phase 2 live-conditioned).
// Conditioned group-stage Monte Carlo: locked fixtures use the verified actual scoreline (and burn 2 rng to keep
// the sampling stream byte-aligned with the all-sampled baseline); unplayed fixtures sampled from v1.3; ranked with
// the corrected 2026 Article-13 ladder (tiebreaker-ladders-2026.ts) — within-group H2H-first + cross-group third
// place + FIFA ranking final decider, NO lots/RNG in ranking. 60 dummy rng/iter after ranking preserve alignment
// with cfdc88ca's stream so locked!={} runs are a clean conditional overlay (non-affected groups' win-group/top-2
// stay byte-identical; overall-advance/best-third legitimately move via the global third-place pool).

import { rankGroup, rankThirdPlace, type Standing, type GroupMatch, type Aux } from "./tiebreaker-ladders-2026";

export const GROUPS: Record<string, string[]> = {
  A: ["MEX", "RSA", "KOR", "CZE"], B: ["CAN", "BIH", "SUI", "QAT"], C: ["BRA", "HAI", "MAR", "SCO"], D: ["AUS", "PAR", "TUR", "USA"],
  E: ["CIV", "CUW", "ECU", "GER"], F: ["JPN", "NED", "SWE", "TUN"], G: ["BEL", "EGY", "IRN", "NZL"], H: ["CPV", "ESP", "KSA", "URU"],
  I: ["FRA", "IRQ", "NOR", "SEN"], J: ["ALG", "ARG", "AUT", "JOR"], K: ["COD", "COL", "POR", "UZB"], L: ["CRO", "ENG", "GHA", "PAN"],
};
export const GROUP_KEYS = Object.keys(GROUPS);
export const ALL_TEAMS = Object.values(GROUPS).flat();
export const teamGroup: Record<string, string> = {}; for (const g of GROUP_KEYS) for (const c of GROUPS[g]) teamGroup[c] = g;
const maxGoals = 8;

export type Outcome = "a" | "d" | "b"; export type Score = { a: number; b: number };
export type Fixture = { label: string; a: string; b: string; group: string; pa: number; pd: number; pb: number; condA: Score[]; condD: Score[]; condB: Score[]; cA: number[]; cD: number[]; cB: number[] };
// locked: keyed by order-independent pair key -> goals per team code (orientation handled by team code, like the consumer)
export type Locked = Record<string, Record<string, number>>;
export const lockKey = (a: string, b: string) => [a, b].sort().join("|");

export const r4 = (v: number) => Number(v.toFixed(4));
export const pct = (a: number, b: number) => (b > 0 ? r4(a / b) : 0);
export const modalKey = (h: Record<number, number>) => { let bk = 0, bv = -1; for (const k of Object.keys(h)) if (h[+k] > bv) { bv = h[+k]; bk = +k; } return bk; };
export const median = (h: Record<number, number>) => { const ks = Object.keys(h).map(Number).sort((a, b) => a - b); const tot = ks.reduce((s, k) => s + h[k], 0); let c = 0; for (const k of ks) { c += h[k]; if (c >= tot / 2) return k; } return ks[ks.length - 1] ?? 0; };
export function createRng(seed: number) { let s = seed >>> 0; return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 2 ** 32; }; }
const facts = Array.from({ length: maxGoals + 1 }, (_, i) => { let f = 1; for (let k = 2; k <= i; k++) f *= k; return f; });
const pois = (l: number, k: number) => (Math.exp(-l) * Math.pow(l, k)) / facts[k];
export function condDists(la: number, lb: number) {
  const A: Score[] = [], D: Score[] = [], B: Score[] = []; const pA: number[] = [], pD: number[] = [], pB: number[] = [];
  for (let a = 0; a <= maxGoals; a++) for (let b = 0; b <= maxGoals; b++) { const p = pois(la, a) * pois(lb, b); if (a > b) { A.push({ a, b }); pA.push(p); } else if (a === b) { D.push({ a, b }); pD.push(p); } else { B.push({ a, b }); pB.push(p); } }
  const cum = (arr: number[]) => { const tot = arr.reduce((s, v) => s + v, 0) || 1; let c = 0; return arr.map((v) => (c += v / tot)); };
  return { A, D, B, cA: cum(pA), cD: cum(pD), cB: cum(pB) };
}
function sampleFrom(scores: Score[], cum: number[], r: number): Score { for (let i = 0; i < cum.length; i++) if (r <= cum[i]) return scores[i]; return scores[scores.length - 1] ?? { a: 0, b: 0 }; }
// smallest metric value g where point-mass P(advance|metric==g)>=0.5 AND stays >=0.5 for higher well-sampled buckets
export function pmCross(q: Record<number, number>, o: Record<number, number>, minSample = 25): number | null {
  const keys = Array.from(new Set([...Object.keys(q), ...Object.keys(o)].map(Number))).sort((a, b) => a - b);
  for (let i = 0; i < keys.length; i++) {
    const g = keys[i], qq = q[g] ?? 0, oo = o[g] ?? 0; if (qq + oo < minSample) continue;
    if (qq / (qq + oo) < 0.5) continue;
    let ok = true;
    for (let j = i + 1; j < keys.length; j++) { const g2 = keys[j], q2 = q[g2] ?? 0, o2 = o[g2] ?? 0; if (q2 + o2 < minSample) continue; if (q2 / (q2 + o2) < 0.5) { ok = false; break; } }
    if (ok) return g;
  }
  return null;
}

type Path = "win" | "runner_up" | "best_third" | "third_out" | "fourth";
type Joint = Record<Path, Record<number, Record<number, number>>>;
type QO = { pts: Record<number, number>; gd: Record<number, number>; gf: Record<number, number> };
export type SimResult = {
  N: number; finish: Record<string, [number, number, number, number]>; advTop2: Record<string, number>; advThird: Record<string, number>;
  jointByPath: Record<string, Joint>; q3: Record<string, QO>; o3: Record<string, QO>; compTally: Record<string, Record<string, number>>;
  supply8: Record<string, number>; thirdTeamCount: Record<string, Record<string, number>>; groupThirdSum: Record<string, { pts: number; gd: number; gf: number; n: number }>;
  cutoffPts: Record<number, number>; cutoffGd: Record<number, number>; cutoffGf: Record<number, number>;
};

/** Conditioned group-stage Monte Carlo. locked={} reproduces the pre-tournament run (cfdc88ca) exactly. */
export function runGroupSim(fixtures: Fixture[], aux: Aux, opts: { seed: number; N: number; locked?: Locked }): SimResult {
  const { seed, N } = opts; const locked = opts.locked ?? {};
  const rng = createRng(seed);
  const finish: SimResult["finish"] = {}; const advTop2: Record<string, number> = {}; const advThird: Record<string, number> = {};
  const jointByPath: Record<string, Joint> = {}; const q3: Record<string, QO> = {}; const o3: Record<string, QO> = {}; const compTally: Record<string, Record<string, number>> = {};
  const supply8: Record<string, number> = {}; const thirdTeamCount: Record<string, Record<string, number>> = {}; const groupThirdSum: SimResult["groupThirdSum"] = {};
  const cutoffPts: Record<number, number> = {}; const cutoffGd: Record<number, number> = {}; const cutoffGf: Record<number, number> = {};
  const emptyJoint = (): Joint => ({ win: {}, runner_up: {}, best_third: {}, third_out: {}, fourth: {} });
  for (const t of ALL_TEAMS) { finish[t] = [0, 0, 0, 0]; advTop2[t] = 0; advThird[t] = 0; jointByPath[t] = emptyJoint(); q3[t] = { pts: {}, gd: {}, gf: {} }; o3[t] = { pts: {}, gd: {}, gf: {} }; compTally[t] = {}; }
  for (const g of GROUP_KEYS) { supply8[g] = 0; thirdTeamCount[g] = {}; groupThirdSum[g] = { pts: 0, gd: 0, gf: 0, n: 0 }; }

  for (let it = 0; it < N; it++) {
    const tbl: Record<string, Standing> = {}; const ownW: Record<string, number> = {};
    for (const t of ALL_TEAMS) { tbl[t] = { team: t, pts: 0, gf: 0, ga: 0, gd: 0 }; ownW[t] = 0; }
    const gMatches: Record<string, GroupMatch[]> = {}; for (const g of GROUP_KEYS) gMatches[g] = [];
    for (const f of fixtures) {
      let sc: Score; const lk = locked[lockKey(f.a, f.b)];
      if (lk) { rng(); rng(); sc = { a: lk[f.a] ?? 0, b: lk[f.b] ?? 0 }; } // LOCKED: burn 2 (align stream), use actual oriented to (a,b)
      else { const r = rng(); if (r < f.pa) sc = sampleFrom(f.condA, f.cA, rng()); else if (r < f.pa + f.pd) sc = sampleFrom(f.condD, f.cD, rng()); else sc = sampleFrom(f.condB, f.cB, rng()); }
      const A = tbl[f.a], B = tbl[f.b];
      A.gf += sc.a; A.ga += sc.b; B.gf += sc.b; B.ga += sc.a; A.gd = A.gf - A.ga; B.gd = B.gf - B.ga;
      if (sc.a > sc.b) { A.pts += 3; ownW[f.a]++; } else if (sc.a < sc.b) { B.pts += 3; ownW[f.b]++; } else { A.pts += 1; B.pts += 1; }
      gMatches[f.group].push({ a: f.a, b: f.b, ga: sc.a, gb: sc.b });
    }
    const rankedByGroup: Record<string, Standing[]> = {}; const thirds: Standing[] = [];
    for (const g of GROUP_KEYS) {
      const ranked = rankGroup(GROUPS[g].map((t) => tbl[t]), gMatches[g], aux);
      rankedByGroup[g] = ranked;
      ranked.forEach((s, i) => { finish[s.team][i]++; if (i < 2) advTop2[s.team]++; });
      thirds.push(ranked[2]);
      const t3 = ranked[2]; thirdTeamCount[g][t3.team] = (thirdTeamCount[g][t3.team] ?? 0) + 1; const gs = groupThirdSum[g]; gs.pts += t3.pts; gs.gd += t3.gd; gs.gf += t3.gf; gs.n++;
    }
    const thirdsRanked = rankThirdPlace(thirds, aux);
    const best8 = new Set<string>(); for (let i = 0; i < 8; i++) { best8.add(thirdsRanked[i].team); advThird[thirdsRanked[i].team]++; }
    const rankOfThird: Record<string, number> = {}; thirdsRanked.forEach((s, i) => (rankOfThird[s.team] = i));
    const cut = thirdsRanked[7]; cutoffPts[cut.pts] = (cutoffPts[cut.pts] ?? 0) + 1; cutoffGd[cut.gd] = (cutoffGd[cut.gd] ?? 0) + 1; cutoffGf[cut.gf] = (cutoffGf[cut.gf] ?? 0) + 1;
    const grpOf7 = teamGroup[thirdsRanked[7].team]; const grpOf8 = teamGroup[thirdsRanked[8].team];
    for (const g of GROUP_KEYS) {
      rankedByGroup[g].forEach((s, i) => {
        const t = s.team; let p: Path;
        if (i === 0) p = "win"; else if (i === 1) p = "runner_up"; else if (i === 3) p = "fourth"; else p = best8.has(t) ? "best_third" : "third_out";
        const jb = jointByPath[t][p]; (jb[s.pts] ??= {})[ownW[t]] = (jb[s.pts][ownW[t]] ?? 0) + 1;
        if (i === 2) {
          const dst = best8.has(t) ? q3[t] : o3[t];
          dst.pts[s.pts] = (dst.pts[s.pts] ?? 0) + 1; dst.gd[s.gd] = (dst.gd[s.gd] ?? 0) + 1; dst.gf[s.gf] = (dst.gf[s.gf] ?? 0) + 1;
          if (best8.has(t)) supply8[g]++;
          const rT = rankOfThird[t];
          if (rT >= 5 && rT <= 10) { const rivalG = rT < 8 ? grpOf8 : grpOf7; if (rivalG !== g) compTally[t][rivalG] = (compTally[t][rivalG] ?? 0) + 1; }
        }
      });
    }
    for (let d = 0; d < 60; d++) rng(); // RNG alignment with cfdc88ca's lots stream (4/group x12 + 12 thirds)
  }
  return { N, finish, advTop2, advThird, jointByPath, q3, o3, compTally, supply8, thirdTeamCount, groupThirdSum, cutoffPts, cutoffGd, cutoffGf };
}

/** current standings derived from the LOCKED (verified) results only — drives current_standing / groups standings live. */
export function liveStandingsFrom(locked: Locked): Record<string, { pts: number; gf: number; ga: number; gd: number; played: number }> {
  const st: Record<string, { pts: number; gf: number; ga: number; gd: number; played: number }> = {};
  for (const t of ALL_TEAMS) st[t] = { pts: 0, gf: 0, ga: 0, gd: 0, played: 0 };
  for (const key of Object.keys(locked)) {
    const [x, y] = key.split("|"); const gx = locked[key][x] ?? 0, gy = locked[key][y] ?? 0;
    st[x].gf += gx; st[x].ga += gy; st[y].gf += gy; st[y].ga += gx; st[x].played++; st[y].played++;
    if (gx > gy) st[x].pts += 3; else if (gx < gy) st[y].pts += 3; else { st[x].pts += 1; st[y].pts += 1; }
  }
  for (const t of ALL_TEAMS) st[t].gd = st[t].gf - st[t].ga;
  return st;
}

type ThirdRecord = {
  team: string;
  group: string;
  pts: number;
  gd: number;
  gf: number;
  fair_play: number;
  fifa_rank: number | null;
};

const LOCKED_RECORD_SCORE_CAP = 6;
const LOCKED_RECORD_MAX_GROUP_COMPLETIONS = 150000;
const scoreOptionsForLockedRecord = () => {
  const scores: Score[] = [];
  for (let a = 0; a <= LOCKED_RECORD_SCORE_CAP; a++) {
    for (let b = 0; b <= LOCKED_RECORD_SCORE_CAP; b++) scores.push({ a, b });
  }
  return scores;
};

function recordText(record: { pts: number; gd: number; gf: number }) {
  return `${record.pts} pts / GD ${record.gd > 0 ? `+${record.gd}` : record.gd} / GF ${record.gf}`;
}

function groupList(groups: string[]) {
  if (groups.length === 0) return "none";
  return groups.join("/");
}

function thirdRecordFromStanding(standing: Standing, group: string, aux: Aux): ThirdRecord {
  return {
    team: standing.team,
    group,
    pts: standing.pts,
    gd: standing.gd,
    gf: standing.gf,
    fair_play: aux.fairPlay[standing.team] ?? 0,
    fifa_rank: aux.fifaRank[standing.team] ?? null,
  };
}

function thirdRecordBeats(candidate: ThirdRecord, lockedRecord: ThirdRecord, aux: Aux) {
  if (candidate.team === lockedRecord.team) return false;
  const ranked = rankThirdPlace(
    [
      { team: candidate.team, pts: candidate.pts, gd: candidate.gd, gf: candidate.gf, ga: 0 },
      { team: lockedRecord.team, pts: lockedRecord.pts, gd: lockedRecord.gd, gf: lockedRecord.gf, ga: 0 },
    ],
    aux,
  );
  return ranked[0]?.team === candidate.team;
}

function enumeratePossibleThirdRecords(group: string, fixtures: Fixture[], locked: Locked, aux: Aux) {
  const groupFixtures = fixtures.filter((fixture) => fixture.group === group);
  const lockedGames: Array<{ a: string; b: string; score: Score }> = [];
  const remainingGames: Array<{ a: string; b: string }> = [];
  for (const fixture of groupFixtures) {
    const score = locked[lockKey(fixture.a, fixture.b)];
    if (score) lockedGames.push({ a: fixture.a, b: fixture.b, score: { a: score[fixture.a] ?? 0, b: score[fixture.b] ?? 0 } });
    else remainingGames.push({ a: fixture.a, b: fixture.b });
  }

  const scoreOptions = scoreOptionsForLockedRecord();
  const completionCount = Math.pow(scoreOptions.length, remainingGames.length);
  if (completionCount > LOCKED_RECORD_MAX_GROUP_COMPLETIONS) {
    return {
      enumerable: false as const,
      group,
      remaining_games: remainingGames.map((game) => `${game.a} vs ${game.b}`),
      possible_thirds: [] as ThirdRecord[],
      completion_count: completionCount,
    };
  }

  const possibleThirds: ThirdRecord[] = [];
  const seen = new Set<string>();
  const finalize = (extraGames: Array<{ a: string; b: string; score: Score }>) => {
    const standings: Record<string, Standing> = {};
    for (const team of GROUPS[group]) standings[team] = { team, pts: 0, gf: 0, ga: 0, gd: 0 };
    const matches: GroupMatch[] = [];
    for (const game of [...lockedGames, ...extraGames]) {
      const A = standings[game.a];
      const B = standings[game.b];
      A.gf += game.score.a; A.ga += game.score.b;
      B.gf += game.score.b; B.ga += game.score.a;
      A.gd = A.gf - A.ga; B.gd = B.gf - B.ga;
      if (game.score.a > game.score.b) A.pts += 3;
      else if (game.score.a < game.score.b) B.pts += 3;
      else { A.pts += 1; B.pts += 1; }
      matches.push({ a: game.a, b: game.b, ga: game.score.a, gb: game.score.b });
    }
    const third = rankGroup(GROUPS[group].map((team) => standings[team]), matches, aux)[2];
    const record = thirdRecordFromStanding(third, group, aux);
    const key = `${record.team}|${record.pts}|${record.gd}|${record.gf}|${record.fair_play}|${record.fifa_rank ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      possibleThirds.push(record);
    }
  };
  const visit = (index: number, picked: Array<{ a: string; b: string; score: Score }>) => {
    if (index >= remainingGames.length) {
      finalize(picked);
      return;
    }
    const game = remainingGames[index];
    for (const score of scoreOptions) visit(index + 1, [...picked, { a: game.a, b: game.b, score }]);
  };
  visit(0, []);

  return {
    enumerable: true as const,
    group,
    remaining_games: remainingGames.map((game) => `${game.a} vs ${game.b}`),
    possible_thirds: possibleThirds,
    completion_count: completionCount,
  };
}

function buildLockedRecordThirdPlaceMode(
  team: string,
  groupsBlock: Record<string, any>,
  fixtures: Fixture[] | undefined,
  locked: Locked,
  aux: Aux,
  teamName: Record<string, string>,
) {
  if (!fixtures) return null;
  const group = teamGroup[team];
  if (groupsBlock[group]?.fixtures_finished !== 6) return null;

  const ownEnum = enumeratePossibleThirdRecords(group, fixtures, locked, aux);
  if (!ownEnum.enumerable || ownEnum.possible_thirds.length !== 1 || ownEnum.possible_thirds[0].team !== team) return null;
  const lockedRecord = ownEnum.possible_thirds[0];
  const groupsAlreadyAbove: string[] = [];
  const groupsAlreadyNotAbove: string[] = [];
  const groupsMustBeat: string[] = [];
  const groupsCanBeat: string[] = [];
  const groupsCannotBeat: string[] = [];
  const groupDetails: Array<{
    group: string;
    status: "already_beats" | "already_cannot_beat" | "must_beat" | "can_beat" | "cannot_beat";
    remaining_games: string[];
    possible_third_count: number;
  }> = [];

  for (const otherGroup of GROUP_KEYS.filter((candidate) => candidate !== group)) {
    const result = enumeratePossibleThirdRecords(otherGroup, fixtures, locked, aux);
    if (!result.enumerable) return null;
    const beatFlags = result.possible_thirds.map((record) => thirdRecordBeats(record, lockedRecord, aux));
    const complete = result.remaining_games.length === 0;
    const allBeat = beatFlags.length > 0 && beatFlags.every(Boolean);
    const someBeat = beatFlags.some(Boolean);
    if (complete && allBeat) {
      groupsAlreadyAbove.push(otherGroup);
      groupDetails.push({ group: otherGroup, status: "already_beats", remaining_games: [], possible_third_count: result.possible_thirds.length });
    } else if (complete) {
      groupsAlreadyNotAbove.push(otherGroup);
      groupDetails.push({ group: otherGroup, status: "already_cannot_beat", remaining_games: [], possible_third_count: result.possible_thirds.length });
    } else if (allBeat) {
      groupsMustBeat.push(otherGroup);
      groupDetails.push({ group: otherGroup, status: "must_beat", remaining_games: result.remaining_games, possible_third_count: result.possible_thirds.length });
    } else if (someBeat) {
      groupsCanBeat.push(otherGroup);
      groupDetails.push({ group: otherGroup, status: "can_beat", remaining_games: result.remaining_games, possible_third_count: result.possible_thirds.length });
    } else {
      groupsCannotBeat.push(otherGroup);
      groupDetails.push({ group: otherGroup, status: "cannot_beat", remaining_games: result.remaining_games, possible_third_count: result.possible_thirds.length });
    }
  }

  const minOtherAbove = groupsAlreadyAbove.length + groupsMustBeat.length;
  const maxOtherAbove = minOtherAbove + groupsCanBeat.length;
  const maxAllowedOtherAbove = 7;
  const remainingBeatAllowance = maxAllowedOtherAbove - minOtherAbove;
  const status = maxOtherAbove <= maxAllowedOtherAbove
    ? "already_safe"
    : minOtherAbove > maxAllowedOtherAbove
      ? "eliminated"
      : "conditional";
  const name = teamName[team] ?? team;
  const lockedText = recordText(lockedRecord);
  const statement = status === "already_safe"
    ? `${name} are mathematically safe as a locked third-place team: at most ${maxOtherAbove} other third-place records can beat their ${lockedText}, and eight third-place teams qualify.`
    : status === "eliminated"
      ? `${name} are mathematically out of the best-third places: at least ${minOtherAbove} other third-place records beat their locked ${lockedText}, and only eight third-place teams qualify.`
      : `${name} qualify iff no more than ${remainingBeatAllowance} of the ${groupsCanBeat.length} remaining group thirds that can still pass them beat their locked ${lockedText}. Watch Groups ${groupList(groupsCanBeat)}.`;

  return {
    mode: "locked_record",
    status,
    team_code: team,
    team_name: name,
    group,
    locked_record: { pts: lockedRecord.pts, gd: lockedRecord.gd, gf: lockedRecord.gf, fair_play: lockedRecord.fair_play, fifa_rank: lockedRecord.fifa_rank, text: lockedText },
    cutoff_rank: 8,
    max_allowed_other_thirds_above: maxAllowedOtherAbove,
    min_other_thirds_above: minOtherAbove,
    max_other_thirds_above: maxOtherAbove,
    remaining_beat_allowance: remainingBeatAllowance,
    already_beating_groups: groupsAlreadyAbove,
    already_settled_cannot_beat_groups: groupsAlreadyNotAbove,
    must_beat_groups: groupsMustBeat,
    can_beat_groups: groupsCanBeat,
    cannot_beat_groups: groupsCannotBeat,
    watch_groups: status === "conditional" ? groupsCanBeat : [],
    statement,
    tiebreaker_path: ["points", "overall_gd", "overall_gf", "fair_play", "fifa_ranking"],
    enumeration: {
      scoreline_cap: LOCKED_RECORD_SCORE_CAP,
      completion_cap_per_group: LOCKED_RECORD_MAX_GROUP_COMPLETIONS,
      complete: true,
      group_details: groupDetails,
    },
  };
}

export type BuildOpts = {
  sim: SimResult; aux: Aux; fifaRank: Record<string, number>; teamName: Record<string, string>; locked: Locked;
  fixtures?: Fixture[];
  phase: "pre_tournament" | "live"; resultCount: number; sourceSimRun: string; sourcePredRun: string; fifaSnapshot: string;
  ladderVersion: string; schemaVersion: string; seed: number;
  storedOverlay?: Record<string, { p1: number; p2: number; p3: number; p4: number; wg: number; t2: number; adv: number; bestThird: number; eliminated: number }>; // Phase 1 verbatim probs
};

/** Build the advancement-scenario-v1 document from a (possibly conditioned) sim. Returns {document, verification}. */
export function buildDocument(opts: BuildOpts) {
  const { sim, fifaRank, teamName, locked, phase, resultCount, storedOverlay } = opts;
  const N = sim.N; const live = liveStandingsFrom(locked);
  const lockedKeys = new Set(Object.keys(locked));
  const cutLinePts = median(sim.cutoffPts), cutLineGd = median(sim.cutoffGd), cutLineGf = median(sim.cutoffGf);

  // groups block — current standings from locked results; fixtures_finished per group
  const finishedByGroup: Record<string, number> = {}; for (const g of GROUP_KEYS) finishedByGroup[g] = 0;
  for (const key of lockedKeys) finishedByGroup[teamGroup[key.split("|")[0]]]++;
  const groupsBlock: Record<string, any> = {};
  for (const g of GROUP_KEYS) {
    const standings = GROUPS[g].map((t) => ({ team: t, played: live[t].played, pts: live[t].pts, gd: live[t].gd, gf: live[t].gf, fifa_rank: fifaRank[t] ?? null, fair_play: 0 }))
      .sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || (a.fifa_rank ?? 999) - (b.fifa_rank ?? 999));
    groupsBlock[g] = { fixtures_total: 6, fixtures_finished: finishedByGroup[g], standings };
  }

  // third_place_race (document-level)
  const raceContenders = GROUP_KEYS.map((g) => {
    const modalThird = Object.keys(sim.thirdTeamCount[g]).sort((a, b) => sim.thirdTeamCount[g][b] - sim.thirdTeamCount[g][a])[0];
    const gs = sim.groupThirdSum[g];
    return { group: g, team: modalThird, team_name: teamName[modalThird] ?? modalThird, pts: 0, gd: 0, gf: 0, expected_pts_if_third: r4(gs.pts / (gs.n || 1)), expected_gd_if_third: r4(gs.gd / (gs.n || 1)), expected_gf_if_third: r4(gs.gf / (gs.n || 1)), fair_play: 0, fifa_rank: fifaRank[modalThird] ?? null, advance_prob: pct(sim.supply8[g], N) };
  }).sort((a, b) => b.advance_prob - a.advance_prob);
  const groupRaceRank: Record<string, number> = {}; raceContenders.forEach((c, i) => (groupRaceRank[c.group] = i + 1));
  const thirdPlaceRace = { cutoff_rank: 8, ladder: ["points", "overall_gd", "overall_gf", "fair_play", "fifa_ranking"], cutoff_line_typical: { pts: cutLinePts, gd: cutLineGd, gf: cutLineGf, note: "median pts/gd/gf of the 8th-placed (last-qualifying) third across the conditioned simulation" }, ranked_contenders: raceContenders, metrics_note: "pts/gd/gf are current standing; expected_*_if_third are the GROUP's mean third-place metrics across the conditioned sim; advance_prob is P(this group's third lands in the best 8).", annex_c_note: "the 8 advancing third groups form the Annex C key -> R32 slots (data/external/fifa/annex-c-r32-third-place-mapping.json)" };

  function ownNeed(label: string, jointH: Record<number, Record<number, number>>, currentPts: number, played: number): string {
    const formatRecord = (wins: number, points: number): string => {
      const draws = points - 3 * wins;
      const losses = 3 - wins - draws;
      return `${wins}W ${draws}D ${losses}L`;
    };
    const ptsH: Record<number, number> = {}; for (const p of Object.keys(jointH)) ptsH[+p] = Object.values(jointH[+p]).reduce((s, v) => s + v, 0);
    const tot = Object.values(ptsH).reduce((s, v) => s + v, 0); if (tot === 0) return `${label}: not reachable from results so far`;
    const mp = modalKey(ptsH);
    const ks = Object.keys(ptsH).map(Number).sort((a, b) => a - b); let lo = ks[0] ?? 0; let c = 0; for (const k of ks) { c += ptsH[k]; if (c >= tot * 0.05) { lo = k; break; } }
    const mw = jointH[mp] && Object.keys(jointH[mp]).length ? modalKey(jointH[mp]) : Math.max(0, Math.ceil((mp - 3) / 2));
    let s = `${label}: typically ${mp} pts (${formatRecord(mw, mp)})`;
    if (lo < mp) s += `; as low as ${lo} pts in our simulations`;
    if (played > 0 && played < 3) s += `; from ${currentPts} pts now, ~${Math.max(0, mp - currentPts)} more from the last ${3 - played}`;
    return s;
  }

  const teamsBlock: Record<string, any> = {};
  let maxPlaceErr = 0, maxAdvErr = 0, maxElimErr = 0, maxBtErr = 0, maxWtnErr = 0, sumAdvance = 0, sumTop2 = 0, sumWin = 0, maxDrift = 0;
  const drifters: string[] = [];
  for (const t of ALL_TEAMS) {
    const g = teamGroup[t]; const f = sim.finish[t];
    const simP = { win_group: r4(f[0] / N), runner_up: r4(f[1] / N), finish_third: r4(f[2] / N), finish_fourth: r4(f[3] / N), third_place_advance: r4(sim.advThird[t] / N), advance_total: r4((sim.advTop2[t] + sim.advThird[t]) / N), eliminated: r4(1 - (sim.advTop2[t] + sim.advThird[t]) / N) };
    let probabilities = simP;
    if (storedOverlay) { // Phase 1: use verbatim stored probs, assert sim reproduces them
      const s = storedOverlay[t];
      const d = Math.max(Math.abs(simP.win_group - s.wg), Math.abs(simP.runner_up - s.p2), Math.abs(simP.finish_third - s.p3), Math.abs(simP.finish_fourth - s.p4), Math.abs(simP.third_place_advance - s.bestThird), Math.abs(simP.advance_total - s.adv));
      maxDrift = Math.max(maxDrift, d); if (d > 0.0005) drifters.push(`${t}:${d.toFixed(4)}`);
      probabilities = { win_group: s.wg, runner_up: s.p2, finish_third: s.p3, finish_fourth: s.p4, third_place_advance: s.bestThird, advance_total: s.adv, eliminated: s.eliminated };
    }
    const curPts = live[t].pts, played = live[t].played;
    const what_they_need: any[] = [];
    const TBP = ["points", "head_to_head", "overall_gd", "overall_gf", "fair_play", "fifa_ranking"];
    if (probabilities.win_group > 0) what_they_need.push({ condition_label: "Win the group", own_results_needed: ownNeed("Win group", sim.jointByPath[t].win, curPts, played), scenario_weight: probabilities.win_group, depends_on_groups: [], tiebreaker_path: TBP });
    if (probabilities.runner_up > 0) what_they_need.push({ condition_label: "Finish runner-up", own_results_needed: ownNeed("Runner-up", sim.jointByPath[t].runner_up, curPts, played), scenario_weight: probabilities.runner_up, depends_on_groups: [], tiebreaker_path: TBP });
    const compGroups = Object.keys(sim.compTally[t]).sort((a, b) => sim.compTally[t][b] - sim.compTally[t][a]);
    const topComp = compGroups.slice(0, 5);
    const passesCutoffPct = pct(sim.advThird[t], sim.finish[t][2]);
    const gdThr = pmCross(sim.q3[t].gd, sim.o3[t].gd), ptsThr = pmCross(sim.q3[t].pts, sim.o3[t].pts), gfThr = pmCross(sim.q3[t].gf, sim.o3[t].gf);
    const inRace = probabilities.finish_third > 0.005;
    const lockedRecordThirdPlace = buildLockedRecordThirdPlaceMode(t, groupsBlock, opts.fixtures, locked, opts.aux, teamName);
    if (probabilities.third_place_advance > 0) what_they_need.push({
      condition_label: "Advance as best third",
      own_results_needed: lockedRecordThirdPlace ? `Locked record: ${lockedRecordThirdPlace.locked_record.text}` : ownNeed("Best third", sim.jointByPath[t].best_third, curPts, played),
      scenario_weight: probabilities.third_place_advance,
      depends_on_groups: lockedRecordThirdPlace ? lockedRecordThirdPlace.watch_groups : topComp,
      third_place_thresholds: { min_points: ptsThr ?? cutLinePts, min_overall_gd: gdThr ?? cutLineGd, min_goals_for: gfThr ?? cutLineGf, beats_rival_if: `${t} overall GD > rival GD, else GF, else fair-play, else FIFA rank (rank ${fifaRank[t] ?? "?"})`, basis: "per-team monotone-validated point-mass crossover over this team's 3rd-place sims; global last-qualifying line: third_place_race.cutoff_line_typical" },
      ...(lockedRecordThirdPlace ? { locked_record_requirement: lockedRecordThirdPlace } : {}),
    });
    const third_place_dependency = {
      is_in_third_race: inRace, competing_third_groups: lockedRecordThirdPlace ? lockedRecordThirdPlace.watch_groups : topComp,
      competing_groups_note: lockedRecordThirdPlace
        ? "locked-record mode: groups whose possible third-place records can still pass this finished third; settled cannot-beat groups are listed separately"
        : "groups most often supplying the marginal third on the other side of the rank-8 line from this team; narrows as results land",
      all_other_groups: GROUP_KEYS.filter((x) => x !== g), cutoff_rank: 8, group_third_race_rank: groupRaceRank[g] ?? null,
      current_third_metrics: { pts: curPts, gd: live[t].gd, gf: live[t].gf, fair_play: 0, fifa_rank: fifaRank[t] ?? null },
      passes_cutoff_in_pct: passesCutoffPct,
      needs: lockedRecordThirdPlace
        ? lockedRecordThirdPlace.statement
        : inRace
        ? `Finishing 3rd, ${t} advances in ~${(passesCutoffPct * 100).toFixed(0)}% of cases; more likely than not once overall GD >= ${gdThr ?? cutLineGd} (with >= ${ptsThr ?? cutLinePts} pts). Global last-qualifying third ~${cutLinePts} pts / GD ${cutLineGd} / GF ${cutLineGf}; final slot decided by GD, GF, fair play, FIFA rank (#${fifaRank[t] ?? "?"}) vs other groups' thirds${topComp.length ? ` (most often ${topComp.join("/")})` : ""}.`
        : `${t} ${played >= 3 ? "did not finish 3rd" : "effectively never finishes 3rd"}; not a third-place-race contender.`,
      locked_record_third_place: lockedRecordThirdPlace,
    };
    const groupDone = finishedByGroup[g] >= 6;
    const tiebreaker_state = { currently_separated_by: groupDone ? "group complete" : null, tied_with: [], decisive_level_if_tied: "fifa_ranking" };
    teamsBlock[t] = { team_code: t, group_code: g, current_standing: { position: played > 0 ? groupsBlock[g].standings.findIndex((x: any) => x.team === t) + 1 : null, pts: curPts, gd: live[t].gd, gf: live[t].gf, played }, probabilities, what_they_need, third_place_dependency, tiebreaker_state };
    // verification accumulators
    const p = probabilities;
    maxPlaceErr = Math.max(maxPlaceErr, Math.abs(p.win_group + p.runner_up + p.finish_third + p.finish_fourth - 1));
    maxAdvErr = Math.max(maxAdvErr, Math.abs(p.advance_total - (p.win_group + p.runner_up + p.third_place_advance)));
    maxElimErr = Math.max(maxElimErr, Math.abs(p.advance_total + p.eliminated - 1));
    if (p.third_place_advance > p.finish_third + 0.0002) maxBtErr = Math.max(maxBtErr, p.third_place_advance - p.finish_third);
    const wtn = what_they_need.reduce((acc: number, w: any) => acc + (w.scenario_weight ?? 0), 0);
    maxWtnErr = Math.max(maxWtnErr, Math.abs(wtn - p.advance_total));
    sumAdvance += p.advance_total; sumTop2 += p.win_group + p.runner_up; sumWin += p.win_group;
  }

  const document = {
    schema: opts.schemaVersion, tournament_code: "WC_2026", phase,
    generated_from: { source_sim_run_id: opts.sourceSimRun, source_prediction_run_id: opts.sourcePredRun, tiebreaker_ladder_version: opts.ladderVersion, fifa_ranking_snapshot_date: opts.fifaSnapshot, fair_play_state: "inert_pre_tournament", simulation_count: N, random_seed: opts.seed, as_of_result_count: resultCount },
    caveats: [
      phase === "live" ? "live: conditioned on verified results-so-far; locked games are facts, unplayed sampled from v1.3" : "pre-tournament fair-play inert; ties resolve at FIFA ranking",
      "candidate sim, not current-best", "conditioned re-sim with corrected Article-13 ladder (no lots); win-group/top-2 are group-local, overall-advance/best-third move via the global best-8 third pool", "no odds / no API-Football predictions",
    ],
    groups: groupsBlock, teams: teamsBlock, third_place_race: thirdPlaceRace,
  };
  const verification = {
    team_count: Object.keys(teamsBlock).length, max_placement_sum_err: r4(maxPlaceErr), max_advance_total_decomp_err: r4(maxAdvErr), max_eliminated_err: r4(maxElimErr),
    best_third_le_third_violation: r4(maxBtErr), max_scenario_weight_vs_advance_err: r4(maxWtnErr),
    sum_advance_total: r4(sumAdvance), sum_top2: r4(sumTop2), sum_win_group: r4(sumWin), sum_third_race_advance_prob: r4(raceContenders.reduce((s, c) => s + c.advance_prob, 0)),
    stored_overlay_max_drift: storedOverlay ? r4(maxDrift) : null, stored_overlay_drifters: drifters,
  };
  return { document, verification, raceContenders };
}
