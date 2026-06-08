// Join verified match_results onto exported fixture cards — the SINGLE source for the
// "final score" the My Team / Matches cards read after a game is played.
//
// Identity & orientation (the two things that have to be right):
//   1. Identity — which result belongs to which fixture: primary key is the API-Football
//      fixture id (match_results.api_football_fixture_id == fixture_metadata.external_fixture_id).
//      Fallback is the UNORDERED team-code pair — the same code-based key the real_standings
//      pipeline already uses (build-app-data.ts) — so a result still attaches if a fixture
//      carries no external id, or if the two id columns ever drift.
//   2. Orientation — goals are mapped BY TEAM CODE into the fixture's exported (home, away)
//      orientation, exactly like ingestion (prepareResult) and the live-score overlay. A
//      result row stored in the opposite orientation (the few reversed fixtures, e.g. the
//      api-feed has team_a=QAT/team_b=SUI while the card is home=SUI/away=QAT) therefore
//      attaches UN-SWAPPED: SUI 2–1 QAT, never 1–2.
//
// Never fabricates: returns null unless a matched row carries goals for BOTH of this
// fixture's two codes. Unplayed fixtures => null => the card shows prediction + kickoff only.
// No model/prediction logic here — this only surfaces a verified, K-gated score.

export type VResult = { a: string; b: string; ga: number; gb: number; afid?: string | null };

export type FixtureResult = { home_score: number; away_score: number; status: "final" };

export type ResultLookup = { byId: Map<string, VResult>; byPair: Map<string, VResult> };

const pairKey = (x: string, y: string) => [x, y].slice().sort().join("|");

// Build the lookup once from the K-gated verified rows. First verified row wins per id/pair
// (group pairs are unique; the standings pipeline dedups identically).
export function buildResultLookup(rows: VResult[]): ResultLookup {
  const byId = new Map<string, VResult>();
  const byPair = new Map<string, VResult>();
  for (const r of rows) {
    if (r.afid != null && String(r.afid) !== "") {
      const k = String(r.afid);
      if (!byId.has(k)) byId.set(k, r);
    }
    const pk = pairKey(r.a, r.b);
    if (!byPair.has(pk)) byPair.set(pk, r);
  }
  return { byId, byPair };
}

// Resolve a single fixture's final score in its (home, away) orientation, or null when unplayed.
export function resultForFixture(
  home: string,
  away: string,
  extid: string | null | undefined,
  lk: ResultLookup,
): FixtureResult | null {
  let r: VResult | undefined;
  if (extid != null && String(extid) !== "") r = lk.byId.get(String(extid)); // primary: API-Football id
  if (!r) r = lk.byPair.get(pairKey(home, away)); // fallback: unordered team-code pair
  if (!r) return null;
  // map goals by team code -> orientation-safe regardless of how the row was stored
  const goalFor = (code: string) => (r!.a === code ? r!.ga : r!.b === code ? r!.gb : null);
  const hs = goalFor(home);
  const as = goalFor(away);
  if (hs == null || as == null) return null; // codes don't match this fixture -> never fabricate
  return { home_score: hs, away_score: as, status: "final" };
}
