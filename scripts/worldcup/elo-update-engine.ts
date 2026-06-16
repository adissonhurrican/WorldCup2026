// In-tournament Elo-update engine (K=60) — PHASE 1: pure function + unit test only. NO DB, NO wiring.
//
// Confirmed eloratings.net method (verified 12/12 exact against authentic 2014 per-match changes,
// see docs/eloratings-authentic-verification-2014-groupFB.md):
//   R' = R + K · G · (S − E)
//   K = 60 (eloratings World Cup weight; FIXED, no re-tuning)
//   S = 1 win / 0.5 draw / 0 loss (from the actual 90/120-min scoreline; shootouts count as draws)
//   E = 1 / (1 + 10^((elo_opp − elo_team) / 400))   [neutral — no host/home bonus]
//   G = eloratings goal-difference index: 1 if |GD| ≤ 1, 1.5 if |GD| = 2, (11 + |GD|)/8 if |GD| ≥ 3
//
// Pure + deterministic. Phases 2/3 import expectedScore / gdIndex / eloDelta / applyMatch.
// Run the unit test:  npx tsx scripts/worldcup/elo-update-engine.ts --unit-test

import path from "node:path";
import { fileURLToPath } from "node:url";

export const WORLD_CUP_K = 60;

export function gdIndex(goalDifference: number): number {
  const gd = Math.abs(goalDifference);
  if (gd <= 1) return 1;
  if (gd === 2) return 1.5;
  return (11 + gd) / 8;
}

/** Neutral expected score for `team` vs `opp` (no home/host advantage). */
export function expectedScore(eloTeam: number, eloOpp: number): number {
  return 1 / (1 + Math.pow(10, (eloOpp - eloTeam) / 400));
}

/**
 * Single-match KNOCKOUT advance probability for `team` vs `opp`, neutral (no home/host bonus). A knockout has no
 * draw — a level tie is settled in extra time / penalties, which always yields a winner — so the neutral Elo
 * expectancy IS P(team advances): 1/(1+10^((eloOpp-eloTeam)/400)). This is the SAME validated approach the live
 * bracket simulation uses (eloWinProbability in the resim consumer). Equal Elo -> 0.5; stronger -> >0.5; the two
 * sides sum to exactly 1 (the ET/penalty path is subsumed — it is not split naively, it follows the Elo curve).
 */
export function knockoutWinProbability(eloTeam: number, eloOpp: number): number {
  return expectedScore(eloTeam, eloOpp);
}

/** Result score from a scoreline, from `team`'s perspective. Shootout = level scoreline = draw (0.5). */
export function resultScore(goalsTeam: number, goalsOpp: number): number {
  return goalsTeam > goalsOpp ? 1 : goalsTeam === goalsOpp ? 0.5 : 0;
}

/** Elo change for `team` after one match. K fixed at 60. Zero-sum: opp change is the negative. */
export function eloDelta(eloTeam: number, eloOpp: number, goalsTeam: number, goalsOpp: number, K = WORLD_CUP_K): number {
  const S = resultScore(goalsTeam, goalsOpp);
  const E = expectedScore(eloTeam, eloOpp);
  const G = gdIndex(goalsTeam - goalsOpp);
  return K * G * (S - E);
}

/** Apply one match to a ratings map (returns a NEW map; never mutates input). Pure. */
export function applyMatch(
  ratings: Readonly<Record<string, number>>,
  teamA: string,
  teamB: string,
  goalsA: number,
  goalsB: number,
  K = WORLD_CUP_K,
): Record<string, number> {
  const d = eloDelta(ratings[teamA], ratings[teamB], goalsA, goalsB, K);
  return { ...ratings, [teamA]: ratings[teamA] + d, [teamB]: ratings[teamB] - d };
}

// ----------------------------------------------------------------------------------------------------
// Unit test: authenticated 2014 Group F + B per-match changes (eloratings.net via international-football.net).
// Each case = real day-before pre-match ratings + the authentic per-match change of the home/first team.
// (Source: docs/eloratings-authentic-verification-2014-groupFB.md, the 12/12 exact verification.)
type Case = { match: string; preHome: number; preAway: number; gh: number; ga: number; authChange: number };
const AUTH_2014: Case[] = [
  { match: "Spain 1-5 Netherlands",          preHome: 2109, preAway: 1986, gh: 1, ga: 5, authChange: -75 },
  { match: "Chile 3-1 Australia",            preHome: 1920, preAway: 1709, gh: 3, ga: 1, authChange: 21 },
  { match: "Argentina 2-1 Bosnia",           preHome: 2019, preAway: 1788, gh: 2, ga: 1, authChange: 13 },
  { match: "Iran 0-0 Nigeria",               preHome: 1713, preAway: 1729, gh: 0, ga: 0, authChange: 1 },
  { match: "Australia 2-3 Netherlands",      preHome: 1688, preAway: 2061, gh: 2, ga: 3, authChange: -6 },
  { match: "Spain 0-2 Chile",                preHome: 2034, preAway: 1941, gh: 0, ga: 2, authChange: -57 },
  { match: "Argentina 1-0 Iran",             preHome: 2032, preAway: 1714, gh: 1, ga: 0, authChange: 8 },
  { match: "Nigeria 1-0 Bosnia",             preHome: 1728, preAway: 1775, gh: 1, ga: 0, authChange: 34 },
  { match: "Australia 0-3 Spain",            preHome: 1682, preAway: 1977, gh: 0, ga: 3, authChange: -16 },
  { match: "Netherlands 2-0 Chile",          preHome: 2067, preAway: 1998, gh: 2, ga: 0, authChange: 36 },
  { match: "Nigeria 2-3 Argentina",          preHome: 1762, preAway: 2040, gh: 2, ga: 3, authChange: -10 },
  { match: "Bosnia 3-1 Iran",                preHome: 1741, preAway: 1706, gh: 3, ga: 1, authChange: 40 },
];

function runUnitTest(): boolean {
  console.log("=== Elo-update engine unit test vs AUTHENTIC eloratings.net 2014 Group F/B changes (K=60) ===");
  console.log("match                          GD  G      preH  preA  S    E        computed  round  authentic  delta");
  let allZero = true;
  for (const c of AUTH_2014) {
    const gd = Math.abs(c.gh - c.ga), G = gdIndex(gd), E = expectedScore(c.preHome, c.preAway), S = resultScore(c.gh, c.ga);
    const computed = eloDelta(c.preHome, c.preAway, c.gh, c.ga);
    const rounded = Math.round(computed);
    const delta = rounded - c.authChange;
    if (delta !== 0) allZero = false;
    const sign = (n: number) => (n >= 0 ? "+" : "") + n;
    console.log(
      "  " + c.match.padEnd(30) + String(gd).padEnd(4) + String(G).padEnd(7) + String(c.preHome).padEnd(6) +
      String(c.preAway).padEnd(6) + S.toFixed(1) + "  " + E.toFixed(4) + "  " + sign(Number(computed.toFixed(2))).padEnd(9) +
      sign(rounded).padEnd(7) + sign(c.authChange).padEnd(11) + delta,
    );
  }
  console.log("\nall deltas zero (engine reproduces authentic changes exactly):", allZero, "(" + AUTH_2014.length + "/" + AUTH_2014.length + ")");
  // symmetry + sanity invariants
  const symOk = AUTH_2014.every((c) => { const m = applyMatch({ H: c.preHome, A: c.preAway }, "H", "A", c.gh, c.ga); return Math.abs((m.H - c.preHome) + (m.A - c.preAway)) < 1e-9; });
  console.log("zero-sum (winner +x / loser -x) holds:", symOk);
  console.log("gd index: GD1=" + gdIndex(1) + " GD2=" + gdIndex(2) + " GD3=" + gdIndex(3) + " GD4=" + gdIndex(4) + " GD6=" + gdIndex(6));
  // knockout single-match advance probability (Phase 3): neutral, equal=0.5, sides sum to 1, stronger favored
  const koEqual = Math.abs(knockoutWinProbability(1800, 1800) - 0.5) < 1e-12;
  const koSum = Math.abs((knockoutWinProbability(1900, 1750) + knockoutWinProbability(1750, 1900)) - 1) < 1e-12;
  const koStronger = knockoutWinProbability(1900, 1750) > 0.5 && knockoutWinProbability(1750, 1900) < 0.5;
  const koMatchesExpected = Math.abs(knockoutWinProbability(1850, 1790) - expectedScore(1850, 1790)) < 1e-12;
  console.log("knockout win prob: equal=0.5", koEqual, "| sums-to-1", koSum, "| stronger-favored", koStronger, "| +100 Elo edge =", knockoutWinProbability(1900, 1800).toFixed(4));
  return allZero && symOk && koEqual && koSum && koStronger && koMatchesExpected;
}

// entrypoint guard: only self-run when invoked DIRECTLY (never when imported by the wiring/build-app-data, where a
// stray --unit-test in the parent's argv would otherwise hijack the import and exit the process).
const isMainEngine = !!process.argv[1] && (fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) || process.argv[1].endsWith("elo-update-engine.ts"));
if (isMainEngine && process.argv.includes("--unit-test")) {
  const ok = runUnitTest();
  console.log("\nPHASE 1 RESULT:", ok ? "PASS — engine confirmed; no DB writes; no wiring." : "FAIL");
  process.exit(ok ? 0 : 1);
}
