// Option D narration scoping — compute WHICH teams' narration inputs actually changed this cycle,
// by diffing the previous committed app-data against the freshly exported one. Pure + fail-open:
// any doubt (missing files, shape surprises, zero detected changes on a material cycle) returns null
// and the caller falls back to --teams ALL (the previous, correctness-maximal behavior).
//
// A team is affected when any input its prose can express changed:
//  1) its GROUP had a fixture result added/changed (rivals' results move the whole group's story), or
//     a knockout fixture involving it gained a result;
//  2) its cross-group best-third entry changed (rank / in_best_8 / points / GD / appeared / dropped);
//  3) its ROUNDED quoted numbers (advance %, win-group %) crossed an integer — keeps prose == the
//     displayed table; sub-rounding resim jitter never triggers a regen (numbers must not flap).

type AppData = any;

export function computeAffectedNarrationTeams(prev: AppData, next: AppData): string[] | null {
  try {
    if (!prev || !next) return null;
    const teamRows: any[] = next.teams ?? [];
    if (teamRows.length !== 48) return null;
    const groupOf: Record<string, string> = {};
    for (const t of teamRows) groupOf[t.code] = t.group;
    const affected = new Set<string>();

    // 1) fixtures whose result appeared/changed
    const fxKey = (f: any) => `${f.home}|${f.away}|${f.kickoff_utc ?? f.kickoff ?? ""}`;
    const resOf = (f: any) => JSON.stringify(f?.result ?? null);
    for (const list of ["fixtures", "knockout_fixtures"] as const) {
      const prevMap = new Map((prev[list] ?? []).map((f: any) => [fxKey(f), resOf(f)]));
      for (const f of next[list] ?? []) {
        const now = resOf(f);
        if (now === "null" || prevMap.get(fxKey(f)) === now) continue;
        if (f.group) { for (const t of teamRows) if (t.group === f.group) affected.add(t.code); }
        else { if (f.home && groupOf[f.home]) affected.add(f.home); if (f.away && groupOf[f.away]) affected.add(f.away); }
      }
    }

    // 2) best-third entries that changed / appeared / dropped
    const sig = (r: any) => `${r.rank}|${r.in_best_8}|${r.points}|${r.goal_difference}|${r.goals_for}`;
    const prevThirds = new Map(((prev.real_standings ?? {}).best_third_race?.ranked ?? []).map((r: any) => [r.code, sig(r)]));
    const nextRanked: any[] = (next.real_standings ?? {}).best_third_race?.ranked ?? [];
    const nextCodes = new Set(nextRanked.map((r: any) => r.code));
    for (const r of nextRanked) if (prevThirds.get(r.code) !== sig(r)) affected.add(r.code);
    for (const code of prevThirds.keys()) if (!nextCodes.has(code)) affected.add(code as string);

    // 3) rounded quoted-number crossings
    const rounded = (d: AppData) => {
      const m = new Map<string, string>();
      for (const g of d.groups ?? []) for (const s of g.standings ?? []) {
        m.set(s.code, `${Math.round((s.advance ?? 0) * 100)}|${Math.round((s.win_group ?? 0) * 100)}`);
      }
      return m;
    };
    const prevNums = rounded(prev), nextNums = rounded(next);
    if (nextNums.size !== 48) return null;
    for (const [code, val] of nextNums) {
      const before = prevNums.get(code);
      if (before === undefined || before !== val) affected.add(code);
    }

    if (affected.size === 0) return null; // material cycle but no detected change — something's off; fail open
    return [...affected].sort();
  } catch {
    return null;
  }
}
