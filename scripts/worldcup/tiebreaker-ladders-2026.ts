// Verified FIFA World Cup 2026 (Article 13) tiebreaker ladders. Pure, deterministic, NO RNG.
// Spec: docs/advancement-scenario-feature-design.md §1. Unit test: npx tsx tiebreaker-ladders-2026.ts --unit-test
//
// Ladder A (within-group, level on points): H2H pts -> H2H GD -> H2H GF -> overall GD -> overall GF
//   -> fair-play -> FIFA ranking. Multi-way recursion: when a subset separates on H2H, re-apply from the
//   top to the still-tied remainder (recompute H2H among only that smaller set).
// Ladder B (cross-group thirds, best 8 of 12; NO H2H): overall pts -> GD -> GF -> fair-play -> FIFA ranking.
// fairPlay: team -> deduction total (<=0; higher/less-negative ranks higher). fifaRank: team -> rank (lower better, unique).

export type Standing = { team: string; pts: number; gf: number; ga: number; gd: number };
export type GroupMatch = { a: string; b: string; ga: number; gb: number };
export type Aux = { fairPlay: Record<string, number>; fifaRank: Record<string, number> };

const pointsOf = (gf: number, ga: number) => (gf > ga ? 3 : gf === ga ? 1 : 0);

// head-to-head sub-table among ONLY the teams in `block`, using only their mutual matches
function h2hTable(block: string[], matches: GroupMatch[]): Record<string, { pts: number; gd: number; gf: number }> {
  const set = new Set(block);
  const h: Record<string, { pts: number; gd: number; gf: number }> = {};
  for (const t of block) h[t] = { pts: 0, gd: 0, gf: 0 };
  for (const m of matches) {
    if (!set.has(m.a) || !set.has(m.b)) continue; // only mutual matches among the tied subset
    h[m.a].pts += pointsOf(m.ga, m.gb); h[m.a].gd += m.ga - m.gb; h[m.a].gf += m.ga;
    h[m.b].pts += pointsOf(m.gb, m.ga); h[m.b].gd += m.gb - m.ga; h[m.b].gf += m.gb;
  }
  return h;
}

// d–g fallthrough: overall GD -> overall GF -> fair-play -> FIFA ranking (FIFA rank is unique => always resolves; no lots)
function compareDG(x: Standing, y: Standing, aux: Aux): number {
  if (y.gd !== x.gd) return y.gd - x.gd;
  if (y.gf !== x.gf) return y.gf - x.gf;
  const fpx = aux.fairPlay[x.team] ?? 0, fpy = aux.fairPlay[y.team] ?? 0;
  if (fpy !== fpx) return fpy - fpx; // higher (less negative) ranks higher
  return (aux.fifaRank[x.team] ?? 9999) - (aux.fifaRank[y.team] ?? 9999); // lower rank number ranks higher
}

// resolve a block of teams that are LEVEL ON POINTS (recursive H2H per Article 13)
function resolveBlock(block: Standing[], matches: GroupMatch[], aux: Aux): Standing[] {
  if (block.length <= 1) return block;
  const codes = block.map((s) => s.team);
  const h = h2hTable(codes, matches);
  // order by H2H a–c
  const ordered = [...block].sort((x, y) =>
    (h[y.team].pts - h[x.team].pts) || (h[y.team].gd - h[x.team].gd) || (h[y.team].gf - h[x.team].gf));
  // partition into sub-blocks equal on (h2h pts, gd, gf)
  const subs: Standing[][] = [];
  for (const s of ordered) {
    const last = subs[subs.length - 1];
    if (last) { const r = last[0]; if (h[r.team].pts === h[s.team].pts && h[r.team].gd === h[s.team].gd && h[r.team].gf === h[s.team].gf) { last.push(s); continue; } }
    subs.push([s]);
  }
  if (subs.length === 1) {
    // H2H did not separate anyone -> apply d–g to the whole block
    return [...block].sort((x, y) => compareDG(x, y, aux));
  }
  // a subset separated -> for each remaining tied sub-block, RE-APPLY from the top (recompute H2H among that smaller set)
  const out: Standing[] = [];
  for (const sub of subs) out.push(...(sub.length === 1 ? sub : resolveBlock(sub, matches, aux)));
  return out;
}

/** Ladder A — rank a 4-team group. matches = the group's 6 fixtures (with scores). */
export function rankGroup(teams: Standing[], matches: GroupMatch[], aux: Aux): Standing[] {
  // partition by overall points (desc), resolve each tied block
  const byPts = [...teams].sort((a, b) => b.pts - a.pts);
  const blocks: Standing[][] = [];
  for (const s of byPts) { const last = blocks[blocks.length - 1]; if (last && last[0].pts === s.pts) last.push(s); else blocks.push([s]); }
  return blocks.flatMap((blk) => resolveBlock(blk, matches, aux));
}

/** Ladder B — rank the 12 third-placed teams (NO head-to-head). */
export function rankThirdPlace(thirds: Standing[], aux: Aux): Standing[] {
  return [...thirds].sort((x, y) =>
    (y.pts - x.pts) || (y.gd - x.gd) || (y.gf - x.gf) ||
    ((aux.fairPlay[y.team] ?? 0) - (aux.fairPlay[x.team] ?? 0)) ||
    ((aux.fifaRank[x.team] ?? 9999) - (aux.fifaRank[y.team] ?? 9999)));
}

// ---------------------------------------------------------------------------------------------------
// Unit tests — constructed scenarios with known-correct Article 13 answers
function st(team: string, pts: number, gf: number, ga: number): Standing { return { team, pts, gf, ga, gd: gf - ga }; }
function runUnitTests(): boolean {
  const cases: { name: string; got: string[]; want: string[]; note: string }[] = [];
  // shared FIFA ranks (lower=better); fair-play inert (0) everywhere pre-tournament
  const fr = { A: 10, B: 5, C: 30, D: 40, X: 99 };
  const aux: Aux = { fairPlay: {}, fifaRank: fr };

  // CASE 1 — 2-way tie resolved at HEAD-TO-HEAD (A beat B head-to-head; B has BETTER overall GD).
  // Correct 2026: H2H first -> A above B (even though B's overall GD is better). The OLD engine (overall-GD-first) would WRONGLY put B first.
  {
    const teams = [st("A", 6, 4, 3), st("B", 6, 6, 3)]; // A overall GD +1, B overall GD +3
    const matches: GroupMatch[] = [{ a: "A", b: "B", ga: 2, gb: 1 }]; // A beat B 2-1 (H2H)
    const r = rankGroup(teams, matches, aux).map((s) => s.team);
    cases.push({ name: "2-way @ H2H (A bt B; B better overall GD)", got: r, want: ["A", "B"], note: "H2H-first beats overall-GD-first" });
  }
  // CASE 2 — 2-way resolved at OVERALL GD (they drew head-to-head, so H2H is equal -> overall GD decides; A has better GD).
  {
    const teams = [st("A", 5, 5, 2), st("B", 5, 3, 3)]; // drew each other; A overall GD +3 > B 0
    const matches: GroupMatch[] = [{ a: "A", b: "B", ga: 1, gb: 1 }];
    const r = rankGroup(teams, matches, aux).map((s) => s.team);
    cases.push({ name: "2-way @ overall GD (drew H2H)", got: r, want: ["A", "B"], note: "H2H equal -> overall GD" });
  }
  // CASE 3 — 2-way resolved at FIFA RANKING (drew H2H, equal overall GD AND GF, fair-play 0 -> FIFA rank; B rank 5 < A rank 10 -> B first).
  {
    const teams = [st("A", 5, 4, 4), st("B", 4 + 1, 4, 4)]; // identical overall pts/gd/gf
    teams[1].pts = 5;
    const matches: GroupMatch[] = [{ a: "A", b: "B", ga: 1, gb: 1 }];
    const r = rankGroup(teams, matches, aux).map((s) => s.team);
    cases.push({ name: "2-way @ FIFA ranking (all equal)", got: r, want: ["B", "A"], note: "FIFA rank replaces lots; B(5)<A(10)" });
  }
  // CASE 4 — 3-way tie requiring RECURSION. Trio A,B,C tied on points. Trio results: A 2-1 B, B 1-0 C, C 1-0 A.
  //   H2H(trio): pts A=3 B=3 C=3; GD A=0 B=0 C=0; GF A=2 B=2 C=1 -> C separates (bottom, GF). A,B remain tied on trio H2H.
  //   RE-APPLY to {A,B}: their match A 2-1 B -> A wins H2H -> A above B. A,B have IDENTICAL overall pts/GD/GF, and B has BETTER FIFA rank,
  //   so a NON-recursive engine would wrongly give B>A via FIFA rank. Correct recursive answer: A, B, C.
  {
    const teams = [st("A", 7, 5, 3), st("B", 7, 5, 3), st("C", 7, 4, 5), st("X", 0, 1, 4)];
    // A,B identical overall (5-3); C 7pts too (won vs X 3-1? ensure pts). Construct matches:
    const matches: GroupMatch[] = [
      { a: "A", b: "B", ga: 2, gb: 1 }, // A 2-1 B
      { a: "B", b: "C", ga: 1, gb: 0 }, // B 1-0 C
      { a: "C", b: "A", ga: 1, gb: 0 }, // C 1-0 A
      { a: "A", b: "X", ga: 3, gb: 2 }, // A vs X (gives A overall 5-3? A: 2+0+3=5 gf, 1+1+2=4 ga) -> adjust below
      { a: "B", b: "X", ga: 4, gb: 2 },
      { a: "C", b: "X", ga: 3, gb: 1 },
    ];
    // recompute overall from matches to keep the case internally consistent
    const tbl: Record<string, Standing> = {}; for (const t of ["A", "B", "C", "X"]) tbl[t] = st(t, 0, 0, 0);
    for (const m of matches) { tbl[m.a].gf += m.ga; tbl[m.a].ga += m.gb; tbl[m.b].gf += m.gb; tbl[m.b].ga += m.ga; tbl[m.a].pts += pointsOf(m.ga, m.gb); tbl[m.b].pts += pointsOf(m.gb, m.ga); }
    for (const t of Object.values(tbl)) t.gd = t.gf - t.ga;
    const frC = { A: 10, B: 5, C: 30, X: 99 }; // B better FIFA rank than A -> would beat A if non-recursive
    const r = rankGroup(Object.values(tbl), matches, { fairPlay: {}, fifaRank: frC });
    const order = r.map((s) => s.team);
    // expected: A then B (recursive {A,B} H2H: A beat B) then C separated at H2H GF, then X last.
    cases.push({ name: "3-way recursion (subset C separates; {A,B} re-applied -> A bt B)", got: order, want: ["A", "B", "C", "X"], note: "recursion decides A>B via direct match despite B's better FIFA rank + identical overall" });
  }
  // CASE 5 — cross-group third-place (Ladder B, NO H2H): pts then GD then FIFA; teams from different groups.
  {
    const thirds = [st("P", 3, 4, 4), st("Q", 3, 5, 4), st("R", 4, 2, 2), st("S", 3, 4, 4)];
    const frT = { P: 8, Q: 20, R: 50, S: 3 } as Record<string, number>;
    const r = rankThirdPlace(thirds, { fairPlay: {}, fifaRank: frT }).map((s) => s.team);
    // R (4 pts) first; then Q (3pts, GD+1) ; then P & S (3pts GD0 GF4) tie -> FIFA: S(3)<P(8) -> S, P
    cases.push({ name: "third-place ladder B (pts/GD/FIFA, no H2H)", got: r, want: ["R", "Q", "S", "P"], note: "P/S tie at GD+GF -> FIFA rank" });
  }

  console.log("=== Tiebreaker ladder unit tests (FIFA 2026 Article 13) ===");
  let allPass = true;
  for (const c of cases) {
    const pass = JSON.stringify(c.got) === JSON.stringify(c.want);
    if (!pass) allPass = false;
    console.log(`  [${pass ? "PASS" : "FAIL"}] ${c.name}\n        got ${JSON.stringify(c.got)} want ${JSON.stringify(c.want)}  (${c.note})`);
  }
  console.log(`\nALL UNIT TESTS PASS: ${allPass}`);
  return allPass;
}

if (process.argv.includes("--unit-test")) process.exit(runUnitTests() ? 0 : 1);
