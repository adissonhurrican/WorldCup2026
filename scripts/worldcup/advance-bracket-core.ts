// PHASE 4 — deterministic knockout advancement engine. Pure + deterministic (no DB, no RNG, no Elo). Two parts:
//   1. resolveKnockoutWinner(): the ACTUAL winner of one knockout match, PENALTY-AWARE — decisive 90/ET goals win;
//      else the shootout score; else the provider's explicit winner flag; else UNRESOLVED (null). It NEVER infers a
//      winner from strength/Elo on a level score (the latent bug the bracket review flagged).
//   2. advanceBracket(): walk matches M73->M104 ascending and push each decided result's winner/loser into the
//      downstream slots the bracket structure feeds (match_winner -> winner, match_loser -> loser). The third-place
//      match (M103) is fed by the two SF LOSERS — handled generically by the match_loser slot type, no special case.
//
// Consumes the verified bracket structure (knockout_schedule slot feeder chains, carried on each side as
// source_match) + the result feed; writes the advancing teams into R16+ side.team. It does NOT touch the resolver,
// the Annex C core (Phase 1), Phase-2 real_opponent, or Phase-3 predictions — they are upstream inputs.
//   npx tsx scripts/worldcup/advance-bracket-core.ts --advance-test

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Projected } from "./knockout-path-core";

export type AdvSide = { type: string | null; source_match: number | null; team: Projected };
export type AdvFixture = { match_number: number; side_a: AdvSide; side_b: AdvSide };
export type MatchResult = { winner: string; loser: string; a_score: number; b_score: number; pens_a: number | null; pens_b: number | null };
export type ResultResolver = (matchNumber: number, aCode: string, bCode: string) => MatchResult | null;

// Raw per-match signals (already team-code aware). penHome/penAway + provHome/provAway are in PROVIDER orientation
// (provider home/away); a/b/ga/gb are in the stored (team_a, team_b) orientation. winner booleans are the provider's.
export type KnockoutRowSignals = {
  a: string; b: string;
  ga: number | null; gb: number | null;
  penHome: number | null; penAway: number | null;
  homeWinner: boolean; awayWinner: boolean;
  provHome: string | null; provAway: string | null;
};

/**
 * The ACTUAL winner of one knockout match, oriented to (a, b). PENALTY-AWARE, and NEVER strength/Elo-inferred:
 *   - decisive after 90/ET (ga != gb) -> higher score wins;
 *   - level after ET -> the shootout score (penHome/penAway, mapped to a/b) decides;
 *   - level + no usable shootout -> the provider's explicit winner flag decides;
 *   - level + no signal at all -> null (UNRESOLVED — advance no one; do NOT guess).
 */
export function resolveKnockoutWinner(s: KnockoutRowSignals): MatchResult | null {
  if (s.ga == null || s.gb == null) return null; // not played
  // map the shootout score from provider orientation to (a, b)
  let pens_a: number | null = null, pens_b: number | null = null;
  if (s.penHome != null && s.penAway != null) {
    if (s.provHome === s.a) { pens_a = s.penHome; pens_b = s.penAway; }
    else if (s.provHome === s.b) { pens_a = s.penAway; pens_b = s.penHome; }
  }
  const base = { a_score: s.ga, b_score: s.gb, pens_a, pens_b };
  if (s.ga > s.gb) return { winner: s.a, loser: s.b, ...base };
  if (s.gb > s.ga) return { winner: s.b, loser: s.a, ...base };
  // level after extra time -> penalty shootout
  if (pens_a != null && pens_b != null && pens_a !== pens_b) {
    return pens_a > pens_b ? { winner: s.a, loser: s.b, ...base } : { winner: s.b, loser: s.a, ...base };
  }
  // level + provider's explicit winner flag (exactly one side flagged)
  if (s.homeWinner !== s.awayWinner) {
    const provWinner = s.homeWinner ? s.provHome : s.provAway;
    if (provWinner === s.a) return { winner: s.a, loser: s.b, ...base };
    if (provWinner === s.b) return { winner: s.b, loser: s.a, ...base };
  }
  return null; // UNRESOLVED — never advance the Elo/strength favourite on a level score
}

/**
 * Walk the bracket ascending; each match with two concrete teams AND a decided result pushes its winner/loser into
 * the downstream slots it feeds. Ascending order guarantees every feeder is resolved before the match that consumes
 * it (feeders are always lower-numbered). MUTATES R16+ side.team. Returns the per-match results it placed.
 */
export function advanceBracket(fixtures: AdvFixture[], resolveResult: ResultResolver, nameOf: (code: string) => string): { resultsByMatch: Map<number, MatchResult> } {
  const resultsByMatch = new Map<number, MatchResult>();
  const ordered = [...fixtures].sort((a, b) => a.match_number - b.match_number);
  for (const f of ordered) {
    const aCode = f.side_a.team?.code ?? null;
    const bCode = f.side_b.team?.code ?? null;
    if (!aCode || !bCode) continue;                       // matchup not concrete yet -> nothing to advance
    const res = resolveResult(f.match_number, aCode, bCode);
    if (!res) continue;                                   // not played / unresolved -> advance no one
    resultsByMatch.set(f.match_number, res);
    for (const d of fixtures) {
      for (const side of [d.side_a, d.side_b]) {
        if (side.source_match !== f.match_number) continue;
        if (side.type === "match_winner") side.team = { code: res.winner, name: nameOf(res.winner) };
        else if (side.type === "match_loser") side.team = { code: res.loser, name: nameOf(res.loser) };
      }
    }
  }
  return { resultsByMatch };
}

// Build a by-team-pair ResultResolver from already-resolved knockout results. Single-elimination => a given
// pair meets at most once, so the sorted team-pair is a safe key. Hardens the lookup the production export
// previously did inline (which silently ignored match_number) with: (1) DUPLICATE-pair detection
// (exactly-one-result — a repeated pair is a data error; keep the first, flag the rest) and (2) an optional
// match_number CROSS-CHECK (expectedMatchByPair): if a result's pair is tied to a different match number than
// the consumer asks for, it is flagged in mismatches[] — surfaced loudly, never silently mis-routed. Scores
// are re-oriented from the stored (row.a,row.b) orientation to the consumer's (aCode,bCode).
export type ResolvedKnockoutRow = { a: string; b: string; res: MatchResult };
export function pairKey(x: string, y: string): string { return [x, y].slice().sort().join("|"); }
export function buildPairResultResolver(
  rows: ResolvedKnockoutRow[],
  expectedMatchByPair?: Map<string, number>,
): { resolver: ResultResolver; duplicates: string[]; mismatches: string[] } {
  const byPair = new Map<string, ResolvedKnockoutRow>();
  const duplicates: string[] = [];
  for (const row of rows) {
    const k = pairKey(row.a, row.b);
    if (byPair.has(k)) { duplicates.push(k); continue; }   // exactly-one-result: keep first, flag the rest
    byPair.set(k, row);
  }
  const mismatches: string[] = [];
  const resolver: ResultResolver = (matchNumber, aCode, bCode) => {
    const k = pairKey(aCode, bCode);
    const row = byPair.get(k);
    if (!row) return null;
    const expected = expectedMatchByPair?.get(k);
    if (expected != null && expected !== matchNumber) mismatches.push(`pair ${k}: result tied to M${expected} but consumed at M${matchNumber}`);
    const flip = row.a !== aCode; // orient the stored (row.a,row.b) result to this fixture's (aCode,bCode)
    const r = row.res;
    return {
      winner: r.winner, loser: r.loser,
      a_score: flip ? r.b_score : r.a_score, b_score: flip ? r.a_score : r.b_score,
      pens_a: flip ? r.pens_b : r.pens_a, pens_b: flip ? r.pens_a : r.pens_b,
    };
  };
  return { resolver, duplicates, mismatches };
}

// ---------------------------------------------------------------------------------------------------------------
// Unit test (no DB): full R32->Final synthetic chain incl. penalties + third-place(SF losers) + partial.
//   npx tsx scripts/worldcup/advance-bracket-core.ts --advance-test
// ---------------------------------------------------------------------------------------------------------------
// Feeder chains verbatim from knockout_schedule (the structure the bracket UI verified 24/24).
const FEEDERS: Record<number, [[ "w" | "l", number], [ "w" | "l", number]]> = {
  89: [["w", 74], ["w", 77]], 90: [["w", 73], ["w", 75]], 91: [["w", 76], ["w", 78]], 92: [["w", 79], ["w", 80]],
  93: [["w", 83], ["w", 84]], 94: [["w", 81], ["w", 82]], 95: [["w", 86], ["w", 88]], 96: [["w", 85], ["w", 87]],
  97: [["w", 89], ["w", 90]], 98: [["w", 93], ["w", 94]], 99: [["w", 91], ["w", 92]], 100: [["w", 95], ["w", 96]],
  101: [["w", 97], ["w", 98]], 102: [["w", 99], ["w", 100]],
  103: [["l", 101], ["l", 102]], // third place = the two SF LOSERS
  104: [["w", 101], ["w", 102]],
};
function buildSyntheticBracket(): AdvFixture[] {
  const fx: AdvFixture[] = [];
  // R32 (M73-M88): two concrete teams each, codes `${m}A` / `${m}B`
  for (let m = 73; m <= 88; m++) {
    fx.push({
      match_number: m,
      side_a: { type: "group_winner", source_match: null, team: { code: `${m}A`, name: `${m}A` } },
      side_b: { type: "group_runner_up", source_match: null, team: { code: `${m}B`, name: `${m}B` } },
    });
  }
  // R16+ (M89-M104): slots fed by lower matches, team null until advanced
  for (const [mn, [sa, sb]] of Object.entries(FEEDERS)) {
    fx.push({ match_number: Number(mn),
      side_a: { type: sa[0] === "w" ? "match_winner" : "match_loser", source_match: sa[1], team: null },
      side_b: { type: sb[0] === "w" ? "match_winner" : "match_loser", source_match: sb[1], team: null } });
  }
  return fx.sort((a, b) => a.match_number - b.match_number);
}
function runUnitTest(): boolean {
  let pass = true;
  const ok = (cond: boolean, label: string) => { if (!cond) pass = false; console.log(`  [${cond ? "OK" : "XX"}] ${label}`); };
  console.log("=== advance-bracket-core — unit test (no DB) ===");

  // 1) resolveKnockoutWinner: decisive / penalty / winner-flag / unresolved
  const dec = resolveKnockoutWinner({ a: "X", b: "Y", ga: 2, gb: 1, penHome: null, penAway: null, homeWinner: false, awayWinner: false, provHome: "X", provAway: "Y" });
  ok(dec?.winner === "X" && dec?.loser === "Y", "decisive 2-1 -> X wins");
  const pen = resolveKnockoutWinner({ a: "X", b: "Y", ga: 1, gb: 1, penHome: 2, penAway: 4, homeWinner: false, awayWinner: true, provHome: "X", provAway: "Y" });
  ok(pen?.winner === "Y" && pen?.pens_a === 2 && pen?.pens_b === 4, "level 1-1, pens 2-4 -> Y wins on penalties (NOT a strength guess)");
  const penFlip = resolveKnockoutWinner({ a: "X", b: "Y", ga: 0, gb: 0, penHome: 5, penAway: 4, homeWinner: true, awayWinner: false, provHome: "Y", provAway: "X" });
  ok(penFlip?.winner === "Y" && penFlip?.pens_a === 4 && penFlip?.pens_b === 5, "provider-orientation flip: provHome=Y, pens 5-4 -> Y wins, oriented to a=X/b=Y");
  const flag = resolveKnockoutWinner({ a: "X", b: "Y", ga: 2, gb: 2, penHome: null, penAway: null, homeWinner: true, awayWinner: false, provHome: "X", provAway: "Y" });
  ok(flag?.winner === "X", "level 2-2, no pens, provider winner flag -> X wins");
  const unresolved = resolveKnockoutWinner({ a: "X", b: "Y", ga: 1, gb: 1, penHome: null, penAway: null, homeWinner: false, awayWinner: false, provHome: "X", provAway: "Y" });
  ok(unresolved === null, "level 1-1 + NO signal -> null (advance no one; never Elo)");
  const unplayed = resolveKnockoutWinner({ a: "X", b: "Y", ga: null, gb: null, penHome: null, penAway: null, homeWinner: false, awayWinner: false, provHome: "X", provAway: "Y" });
  ok(unplayed === null, "unplayed -> null");

  // 2) FULL chain: every R32 decided (M{m}A wins each) + one penalty (M74 -> 74B on pens) -> walk to Final + 3rd
  const fx = buildSyntheticBracket();
  const winners: Record<number, string> = {};
  const resolver: ResultResolver = (mn, a, b) => {
    if (mn === 74) return { winner: b, loser: a, a_score: 1, b_score: 1, pens_a: 3, pens_b: 5 }; // 74B advances on pens
    // everyone else: side_a wins decisively
    return { winner: a, loser: b, a_score: 2, b_score: 0, pens_a: null, pens_b: null };
  };
  const { resultsByMatch } = advanceBracket(fx, resolver, (c) => c);
  const byNum = new Map(fx.map((f) => [f.match_number, f]));
  // R32 winners all placed into R16
  ok(byNum.get(89)!.side_a.team?.code === "74B", "M74 penalty winner (74B) carried into M89 side_a (NOT 74A)");
  ok(byNum.get(89)!.side_b.team?.code === "77A", "M77 winner (77A) carried into M89 side_b");
  // walk all the way to the Final
  const finalA = byNum.get(104)!.side_a.team?.code, finalB = byNum.get(104)!.side_b.team?.code;
  ok(!!finalA && !!finalB, `Final (M104) has two concrete teams (${finalA} vs ${finalB})`);
  // third place = the two SF LOSERS
  const sf1 = resultsByMatch.get(101)!, sf2 = resultsByMatch.get(102)!;
  ok(byNum.get(103)!.side_a.team?.code === sf1.loser && byNum.get(103)!.side_b.team?.code === sf2.loser, `M103 third-place = SF losers (${sf1.loser}, ${sf2.loser})`);
  ok(byNum.get(104)!.side_a.team?.code === sf1.winner && byNum.get(104)!.side_b.team?.code === sf2.winner, "M104 final = SF winners");
  // every knockout match produced a result + every R16+ slot filled (full bracket decided)
  ok(resultsByMatch.size === 32, `all 32 knockout matches resolved (got ${resultsByMatch.size})`);
  const r16plusFilled = fx.filter((f) => f.match_number >= 89).every((f) => f.side_a.team && f.side_b.team);
  ok(r16plusFilled, "all R16+ slots filled when the full bracket is decided");

  // 3) PARTIAL: only M73 + M75 decided -> only M90 (fed by w73,w75) fills; M89 (needs M74,M77) stays null
  const fx2 = buildSyntheticBracket();
  const partial: ResultResolver = (mn, a, b) => (mn === 73 || mn === 75) ? { winner: a, loser: b, a_score: 1, b_score: 0, pens_a: null, pens_b: null } : null;
  advanceBracket(fx2, partial, (c) => c);
  const b2 = new Map(fx2.map((f) => [f.match_number, f]));
  ok(b2.get(90)!.side_a.team?.code === "73A" && b2.get(90)!.side_b.team?.code === "75A", "partial: M90 fills from M73+M75 winners");
  ok(b2.get(89)!.side_a.team === null && b2.get(89)!.side_b.team === null, "partial: M89 stays null (its feeders M74/M77 undecided)");
  ok(b2.get(97)!.side_a.team === null, "partial: M97 (QF) stays null (M89 not resolved)");

  // 4) by-pair PRODUCTION resolver (the one build-app-data actually uses): orientation flip + duplicate-pair
  //    (exactly-one-result) + match_number cross-check. (P4-3/INT-4 — the prod path differs from the by-mn test above.)
  const r74 = resolveKnockoutWinner({ a: "ALPHA", b: "BETA", ga: 1, gb: 1, penHome: 5, penAway: 3, homeWinner: true, awayWinner: false, provHome: "ALPHA", provAway: "BETA" })!;
  const { resolver: pr, duplicates: dups, mismatches: mm } = buildPairResultResolver(
    [{ a: "ALPHA", b: "BETA", res: r74 }, { a: "GAMMA", b: "DELTA", res: resolveKnockoutWinner({ a: "GAMMA", b: "DELTA", ga: 2, gb: 0, penHome: null, penAway: null, homeWinner: false, awayWinner: false, provHome: "GAMMA", provAway: "DELTA" })! }, { a: "ALPHA", b: "BETA", res: r74 }],
    new Map([[pairKey("ALPHA", "BETA"), 74]]),
  );
  ok(pr(74, "ALPHA", "BETA")?.winner === "ALPHA" && pr(74, "ALPHA", "BETA")?.pens_a === 5, "by-pair: resolves ALPHA vs BETA in stored orientation (pens 5-3)");
  const flipped = pr(74, "BETA", "ALPHA");
  ok(flipped?.winner === "ALPHA" && flipped?.a_score === 1 && flipped?.pens_a === 3 && flipped?.pens_b === 5, "by-pair: re-orients scores/pens when the fixture asks (BETA,ALPHA)");
  ok(pr(99, "NOPE", "ZILCH") === null, "by-pair: unknown pair -> null (no advance)");
  ok(dups.length === 1 && dups[0] === pairKey("ALPHA", "BETA"), "by-pair: duplicate pair flagged (exactly-one-result)");
  ok(mm.length === 0, "by-pair: no mismatch when the pair is consumed at its expected match number");
  ok(pr(999, "ALPHA", "BETA") != null && mm.length === 1, "by-pair: match_number cross-check flags a pair consumed at the wrong match");

  return pass;
}
// entrypoint guard: only self-run when invoked DIRECTLY (never when imported by build-app-data).
const isMainAdvance = !!process.argv[1] && (fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) || process.argv[1].endsWith("advance-bracket-core.ts"));
if (isMainAdvance && process.argv.includes("--advance-test")) {
  const okAll = runUnitTest();
  console.log("\nADVANCE-BRACKET CORE:", okAll ? "PASS — penalty-aware winner; deterministic R32->Final walk; 3rd place = SF losers; partial safe." : "FAIL");
  process.exit(okAll ? 0 : 1);
}
