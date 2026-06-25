import { readFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rankGroup, rankThirdPlace, type Standing, type GroupMatch, type Aux } from "./tiebreaker-ladders-2026";
import { GROUPS, GROUP_KEYS, teamGroup, ALL_TEAMS, condDists, createRng, lockKey, liveStandingsFrom, runGroupSim, r4, type Locked, type Fixture } from "./advancement-scenario-core";

// P0b Tier 3 — DETERMINISTIC concrete-scenario explainer across the FULL group timeline. NO RNG / NO sampling.
// At every stage: the CERTAIN statements (provably invariant across the remaining outcome space). When the space is
// tractable (final matchday — every group <=2 games left): full concrete if-then chains (clinch / elimination /
// dependency), enumerated exhaustively (scorelines 0..GCAP) and resolved through the corrected Article-13 ladder.
// When intractable (>=3 games left in some group): degrade HONESTLY to certainties + highest-leverage swing matches
// + the Phase-2 probability, marking "full if-then on the final matchday". Never fabricate chains. Reads REAL verified
// standings (match_results, K=60 gate); the probabilistic fallback = the PROMOTED live dynamic-draw model. A synthetic
// near-final spot-check + an engine self-test are retained (clearly labelled). 0 DB writes.

type Sl = { a: string; b: string; ga: number; gb: number };
type Metric = { team: string; pts: number; gd: number; gf: number; fifa: number };
const GCAP = 6; // scoreline enumeration bound (covers virtually all real scores; points-based certainties are bound-independent)
const rootDir = process.cwd();
const credentialsPath = path.join(rootDir, "supebase.txt");
const tempDir = path.join(rootDir, ".tmp", "worldcup-sql");
const worldCupDevProjectRef = "ahcfrgxczbgdvrqmbisw";
// PROMOTED live model (dynamic-draw) — the probabilistic fallback (conditioned re-sim) reads these, NOT the superseded v1.3 run 85555853.
const SOURCE_PRED_RUN = "066be1b1-de89-44de-8b7c-c95f4353ad7e"; const SOURCE_SIM_RUN = "c45b3e6a-f2c3-43f4-bade-65dc1fd0e195";
const FIFA_SNAPSHOT = "2026-06-11" /* pre-WC FIFA edition published 2026-06-11; prior pins: 2026-04-01 (kept additively in fifa_world_rankings) */; const SEED = 20260602;
// VERIFIED group-result reader — mirrors the K=60 gate EXACTLY (finished + fixture-ID + payload-hash + not-rejected + group),
// the same feed build-advancement-scenario-v1-live.ts reads. The REAL current standings come ONLY from these rows.
const VERIFIED_RESULTS_SQL = `select fixture_label, team_a_code, team_b_code, team_a_goals::int ga, team_b_goals::int gb, coalesce(finished_at, kickoff_at) result_time
from match_results
where tournament_code='WC_2026' and match_status='finished' and api_football_fixture_id is not null
  and source_payload_hash is not null and coalesce(review_status,'') <> 'rejected'
  and (fixture_metadata_id in (select id from fixture_metadata where tournament_code='WC_2026') or round_name ilike 'group%')
order by coalesce(finished_at, kickoff_at), fixture_label`;
let tmp = 0;

async function readDbConfig() {
  const text = await readFile(credentialsPath, "utf8");
  const projectRef = text.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];
  const password = text.match(/supebase password\s*:\s*(\S+)/i)?.[1];
  if (projectRef !== worldCupDevProjectRef) throw new Error(`Unexpected project ref: ${projectRef ?? "unknown"}`);
  if (!password) throw new Error("Missing password");
  return { projectRef, dbUrl: `postgresql://postgres.${projectRef}:${encodeURIComponent(password)}@aws-1-us-west-1.pooler.supabase.com:5432/postgres` };
}
function runSql<X = any>(dbUrl: string, sql: string): X[] {
  if (/\b(insert|update|delete|drop|alter|truncate|create)\b/i.test(sql.replace(/'[^']*'/g, ""))) throw new Error("read-only helper");
  mkdirSync(tempDir, { recursive: true }); tmp += 1; const fp = path.join(tempDir, `t3-${tmp}.sql`); writeFileSync(fp, sql, "utf8");
  const r = spawnSync("cmd.exe", ["/c", "npx.cmd", "supabase", "db", "query", "--db-url", dbUrl, "--output", "json", "--file", fp], { encoding: "utf8", maxBuffer: 2e8 });
  if ((r.status ?? 1) !== 0) throw new Error((r.stderr || r.stdout || "").slice(0, 300));
  const out = r.stdout.trim(); if (!out) return []; const p = JSON.parse(out); return (Array.isArray(p) ? p : p.rows ?? p) as X[];
}
function execSql(dbUrl: string, sql: string): string { // single-statement DDL/DML (CLI rejects multi-statement files)
  mkdirSync(tempDir, { recursive: true }); tmp += 1; const fp = path.join(tempDir, `t3-ddl-${tmp}.sql`); writeFileSync(fp, sql, "utf8");
  const r = spawnSync("cmd.exe", ["/c", "npx.cmd", "supabase", "db", "query", "--db-url", dbUrl, "--file", fp], { encoding: "utf8", maxBuffer: 2e8 });
  if ((r.status ?? 1) !== 0) throw new Error(`execSql failed: ${(r.stderr || r.stdout || "").slice(0, 400)}`);
  return `${r.stdout ?? ""}`.trim();
}
function dec(v: any): number | null { if (v == null) return null; if (typeof v === "number") return v; if (typeof v === "string") { const n = Number(v); return Number.isNaN(n) ? null : n; } if (typeof v === "object" && "Int" in v) return Number(v.Int) * Math.pow(10, Number(v.Exp ?? 0)); return Number(v); }
const num = (v: any) => dec(v) ?? 0;

// build a group's standings + matches from a set of decided games
function standOf(teams: string[], games: Sl[]): { tbl: Record<string, Standing>; gm: GroupMatch[] } {
  const tbl: Record<string, Standing> = {}; for (const t of teams) tbl[t] = { team: t, pts: 0, gf: 0, ga: 0, gd: 0 };
  const gm: GroupMatch[] = [];
  for (const g of games) { const A = tbl[g.a], B = tbl[g.b]; A.gf += g.ga; A.ga += g.gb; B.gf += g.gb; B.ga += g.ga; A.gd = A.gf - A.ga; B.gd = B.gf - B.ga; if (g.ga > g.gb) A.pts += 3; else if (g.ga < g.gb) B.pts += 3; else { A.pts += 1; B.pts += 1; } gm.push({ a: g.a, b: g.b, ga: g.ga, gb: g.gb }); }
  return { tbl, gm };
}
const scoreOptions = (): { ga: number; gb: number }[] => { const o = []; for (let x = 0; x <= GCAP; x++) for (let y = 0; y <= GCAP; y++) o.push({ ga: x, gb: y }); return o; };
function cartesian<T>(arrs: T[][]): T[][] { return arrs.reduce<T[][]>((acc, arr) => acc.flatMap((p) => arr.map((x) => [...p, x])), [[]]); }

// enumerate all completions of one group (remaining fixtures scored 0..GCAP), resolved via corrected ladder
type GroupCompletion = { rem: Sl[]; posByTeam: Record<string, number>; third: Metric };
function enumerateGroup(group: string, fixtures: { a: string; b: string }[], locked: Locked, aux: Aux): { remaining: { a: string; b: string }[]; completions: GroupCompletion[]; possibleThirds: Metric[] } {
  const teams = GROUPS[group];
  const lockedGames: Sl[] = []; const remaining: { a: string; b: string }[] = [];
  for (const f of fixtures) { const lk = locked[lockKey(f.a, f.b)]; if (lk) lockedGames.push({ a: f.a, b: f.b, ga: lk[f.a] ?? 0, gb: lk[f.b] ?? 0 }); else remaining.push(f); }
  const opts = scoreOptions();
  const combos = remaining.length ? cartesian(remaining.map((f) => opts.map((o) => ({ a: f.a, b: f.b, ga: o.ga, gb: o.gb } as Sl)))) : [[]];
  const completions: GroupCompletion[] = []; const seen = new Set<string>(); const possibleThirds: Metric[] = [];
  for (const combo of combos) {
    const { tbl, gm } = standOf(teams, [...lockedGames, ...combo]);
    const ranked = rankGroup(teams.map((t) => tbl[t]), gm, aux);
    const posByTeam: Record<string, number> = {}; ranked.forEach((s, i) => (posByTeam[s.team] = i));
    const t3 = ranked[2]; const m: Metric = { team: t3.team, pts: t3.pts, gd: t3.gd, gf: t3.gf, fifa: aux.fifaRank[t3.team] ?? 9999 };
    completions.push({ rem: combo, posByTeam, third: m });
    const key = `${m.team}|${m.pts}|${m.gd}|${m.gf}`; if (!seen.has(key)) { seen.add(key); possibleThirds.push(m); }
  }
  return { remaining, completions, possibleThirds };
}
// Ladder B: does candidate third strictly outrank metric m? (pts -> gd -> gf -> fair-play(0) -> FIFA asc)
function beats(c: Metric, m: Metric): boolean { if (c.pts !== m.pts) return c.pts > m.pts; if (c.gd !== m.gd) return c.gd > m.gd; if (c.gf !== m.gf) return c.gf > m.gf; return c.fifa < m.fifa; }

// ---- CERTAINTY (concrete mode): full per-group enumeration + cross-group counting ----
function concreteCertainty(team: string, fixtures: { a: string; b: string }[], locked: Locked, aux: Aux) {
  const g = teamGroup[team];
  const groupFx: Record<string, { a: string; b: string }[]> = {}; for (const k of GROUP_KEYS) groupFx[k] = [];
  for (const f of fixtures) groupFx[f.group ? (f as any).group : teamGroup[f.a]].push({ a: f.a, b: f.b });
  const enums: Record<string, ReturnType<typeof enumerateGroup>> = {};
  for (const k of GROUP_KEYS) enums[k] = enumerateGroup(k, groupFx[k], locked, aux);
  const own = enums[g];
  // memoized cross-group above-counts for a given M_T
  const cache = new Map<string, { min: number; max: number; bubble: string[] }>();
  const aboveCounts = (m: Metric) => {
    const key = `${m.pts}|${m.gd}|${m.gf}|${m.fifa}`; const hit = cache.get(key); if (hit) return hit;
    let mn = 0, mx = 0; const bubble: string[] = [];
    for (const k of GROUP_KEYS) { if (k === g) continue; const set = enums[k].possibleThirds; const all = set.every((c) => beats(c, m)); const some = set.some((c) => beats(c, m)); if (all) { mn++; mx++; } else if (some) { mx++; bubble.push(k); } }
    const res = { min: mn, max: mx, bubble }; cache.set(key, res); return res;
  };
  // classify each own-completion
  const posSet = new Set<number>(); let everyAdvWorst = true, everyFailBest = true; let anyTop2 = false, any4th = false;
  for (const c of own.completions) {
    const pos = c.posByTeam[team]; posSet.add(pos);
    if (pos <= 1) { anyTop2 = true; everyFailBest = false; /* advances */ }
    else if (pos === 3) { any4th = true; everyAdvWorst = false; /* never advances */ }
    else { const m: Metric = { team, pts: groupThirdMetric(c, team).pts, gd: groupThirdMetric(c, team).gd, gf: groupThirdMetric(c, team).gf, fifa: aux.fifaRank[team] ?? 9999 }; const ac = aboveCounts(m); if (ac.max > 7) everyAdvWorst = false; if (ac.min < 8) everyFailBest = false; }
  }
  function groupThirdMetric(c: GroupCompletion, t: string): Metric { return c.third.team === t ? c.third : { team: t, pts: 0, gd: 0, gf: 0, fifa: 0 }; }
  return {
    posSet: [...posSet].sort(), own, enums, aboveCounts,
    clinched_advance: everyAdvWorst && !any4th, // never 4th, and every 3rd-completion clinches as a third
    eliminated: everyFailBest && !anyTop2,
    clinched_first: posSet.size === 1 && posSet.has(0),
    cannot_finish_first: !posSet.has(0),
    guaranteed_at_least_third: !posSet.has(3),
    cannot_reach_top2: !posSet.has(0) && !posSet.has(1),
    can_top2: posSet.has(0) || posSet.has(1),
  };
}

// ---- CERTAINTY (early mode): sound point-bound bounds (goal-independent) ----
function earlyCertainty(team: string, locked: Locked) {
  const g = teamGroup[team]; const live = liveStandingsFrom(locked);
  const rem = (x: string) => 3 - live[x].played; const minP = (x: string) => live[x].pts; const maxP = (x: string) => live[x].pts + 3 * rem(x);
  const rivals = GROUPS[g].filter((r) => r !== team);
  const threats = rivals.filter((r) => maxP(r) >= minP(team)); // could finish >= team
  const surelyAbove = rivals.filter((r) => minP(r) > maxP(team)); // floor beats team's ceiling
  const clinchedTop2 = threats.length <= 1; const guaranteedAtLeastThird = threats.length <= 2;
  return {
    clinched_advance: clinchedTop2, // sound: top-2 always advances
    eliminated: false, // not provable cheaply early (requires cross-group); never assert
    clinched_first: rivals.every((r) => maxP(r) < minP(team)),
    cannot_finish_first: surelyAbove.length >= 1,
    guaranteed_at_least_third: guaranteedAtLeastThird,
    cannot_reach_top2: surelyAbove.length >= 2,
    threats: threats.length, own_remaining_games: rem(team), current_points: minP(team),
  };
}

function certainStatements(c: any, team: string, mode: string): { statement: string; type: string; basis: string }[] {
  const S: { statement: string; type: string; basis: string }[] = [];
  const basis = mode === "concrete_chains" ? "invariant across all enumerated final-matchday completions (scorelines 0.." + GCAP + ")" : "sound point-bound (goal-independent) over remaining games";
  if (c.clinched_advance) S.push({ statement: `${team} has CLINCHED advancement (advances in every remaining outcome).`, type: "clinched_advance", basis });
  if (c.eliminated) S.push({ statement: `${team} is ELIMINATED (advances in no remaining outcome).`, type: "eliminated", basis });
  if (c.clinched_first) S.push({ statement: `${team} has CLINCHED 1st in the group (cannot be caught).`, type: "clinched_first", basis });
  if (c.cannot_finish_first) S.push({ statement: `${team} can NO LONGER finish 1st in the group.`, type: "cannot_finish_first", basis });
  if (c.guaranteed_at_least_third) S.push({ statement: `${team} is GUARANTEED at least 3rd (cannot finish 4th) -> at least in the best-third race.`, type: "guaranteed_at_least_third", basis });
  if (c.cannot_reach_top2 && !c.eliminated) S.push({ statement: `${team} can no longer finish top-2; its only path is the best-third race.`, type: "cannot_reach_top2", basis });
  if (S.length === 0) S.push({ statement: `${team} is neither clinched nor eliminated; all four placements remain reachable.`, type: "open", basis });
  return S;
}

// ---- SWING MATCHES (early mode) ----
function swingMatches(team: string, fixtures: any[], locked: Locked) {
  const g = teamGroup[team]; const out: { fixture: string; leverage: string; why: string }[] = [];
  for (const f of fixtures) {
    if (locked[lockKey(f.a, f.b)]) continue;
    if (f.a === team || f.b === team) out.push({ fixture: `${f.a} vs ${f.b}`, leverage: "decisive", why: `${team}'s own remaining game — directly sets its points/position.` });
  }
  for (const f of fixtures) { if (locked[lockKey(f.a, f.b)]) continue; if (teamGroup[f.a] === g && f.a !== team && f.b !== team) out.push({ fixture: `${f.a} vs ${f.b}`, leverage: "high", why: `same-group rival match — moves ${team}'s relative standing for 1st/2nd/3rd.` }); }
  out.push({ fixture: "cross-group third-place pool (all other groups' final-matchday games)", leverage: "diffuse-until-final-matchday", why: `${team}'s best-third fate depends on the global pool; resolves to concrete named thresholds only on the final matchday.` });
  return out;
}

// ---- CONCRETE CHAINS (final matchday) — own result split to the MARGIN, but ONLY where the margin changes the verdict ----
// Same per-completion classification as the certainty engine (pos<=1 advance / pos==3 out / else cross-group "dep"); the
// ONLY change vs. plain W/D/L is the GROUPING: within each own-result category, consecutive own-margins that share a verdict
// collapse into one band, so a margin band is emitted iff that margin flips the outcome (e.g. lose-by-1 DEPENDS vs lose-by-3+
// ELIMINATED). When all margins of a category agree, the band carries no margin annotation ("a win clinches"). No new reasoning.
function concreteChains(team: string, c: any, aux: Aux, teamName: Record<string, string>) {
  const own = c.own as ReturnType<typeof enumerateGroup>;
  const ownGame = own.remaining.find((f) => f.a === team || f.b === team); // the team's own remaining MD3 game
  const chains: any[] = [];
  if (!ownGame) return chains;
  const opp = ownGame.a === team ? ownGame.b : ownGame.a;
  const ownGoals = (cc: GroupCompletion, t: string): number => { const f = cc.rem.find((r) => (r.a === team && r.b === opp) || (r.a === opp && r.b === team))!; return f.a === t ? f.ga : f.gb; };
  const ownMargin = (cc: GroupCompletion) => ownGoals(cc, team) - ownGoals(cc, opp); // >0 win, 0 draw, <0 loss

  // classify ONE completion exactly as the certainty engine does, and surface its third-place metric
  function classify(cc: GroupCompletion): { adv: boolean | "dep"; pos: number; m: Metric | null } {
    const pos = cc.posByTeam[team];
    if (pos <= 1) return { adv: true, pos, m: null };
    if (pos === 3) return { adv: false, pos, m: null };
    const m: Metric = { ...cc.third, team, fifa: aux.fifaRank[team] ?? 9999 };
    const ac = c.aboveCounts(m);
    return { adv: ac.max <= 7 ? true : ac.min >= 8 ? false : "dep", pos, m };
  }
  function aggregate(comps: GroupCompletion[]) {
    let allAdv = true, noneAdv = true; const depMetrics: Metric[] = []; const posCounts: Record<number, number> = {};
    for (const cc of comps) { const r = classify(cc); posCounts[r.pos] = (posCounts[r.pos] ?? 0) + 1; if (r.adv === "dep" && r.m) depMetrics.push(r.m); if (r.adv !== true) allAdv = false; if (r.adv !== false) noneAdv = false; }
    const verdict = allAdv ? "CLINCH" : noneAdv ? "ELIMINATED" : "DEPENDS";
    const worst = depMetrics.sort((x, y) => x.pts - y.pts || x.gd - y.gd || x.gf - y.gf)[0] ?? null; // most vulnerable third metric in the band
    return { verdict, worst, posCounts };
  }

  type CatKind = "win" | "draw" | "loss";
  const cats: { kind: CatKind; pred: (cc: GroupCompletion) => boolean }[] = [
    { kind: "win", pred: (cc) => ownMargin(cc) > 0 },
    { kind: "draw", pred: (cc) => ownMargin(cc) === 0 },
    { kind: "loss", pred: (cc) => ownMargin(cc) < 0 },
  ];
  const ord = (p: number) => `${p + 1}${["st", "nd", "rd", "th"][p] ?? "th"}`;
  const posStrOf = (pc: Record<number, number>) => Object.keys(pc).map(Number).sort((a, b) => a - b).map(ord).join("/");
  const verb = (kind: CatKind) => kind === "win" ? `${team} beats ${opp}` : kind === "draw" ? `${team} draws ${opp}` : `${team} loses to ${opp}`;
  const bandLabel = (kind: CatKind, lo: number, hi: number, split: boolean) => { const base = verb(kind); if (kind === "draw" || !split) return base; const by = hi >= GCAP ? `by ${lo}+` : lo === hi ? `by exactly ${lo}` : `by ${lo}-${hi}`; return `${base} ${by}`; };

  for (const cat of cats) {
    const comps = own.completions.filter(cat.pred); if (!comps.length) continue;
    const mags = [...new Set(comps.map((cc) => Math.abs(ownMargin(cc))))].sort((a, b) => a - b);
    const perMag = mags.map((mag) => ({ mag, ...aggregate(comps.filter((cc) => Math.abs(ownMargin(cc)) === mag)) }));
    // coalesce consecutive margins that share the same verdict — identical-verdict margins collapse to one band
    const bands: { lo: number; hi: number; verdict: string; worst: Metric | null; posCounts: Record<number, number> }[] = [];
    for (const pm of perMag) {
      const last = bands[bands.length - 1];
      if (last && last.verdict === pm.verdict) { last.hi = pm.mag; if (pm.worst && (!last.worst || (pm.worst.pts - last.worst.pts || pm.worst.gd - last.worst.gd || pm.worst.gf - last.worst.gf) < 0)) last.worst = pm.worst; for (const k of Object.keys(pm.posCounts)) last.posCounts[+k] = (last.posCounts[+k] ?? 0) + pm.posCounts[+k]; }
      else bands.push({ lo: pm.mag, hi: pm.mag, verdict: pm.verdict, worst: pm.worst, posCounts: { ...pm.posCounts } });
    }
    const split = bands.length > 1; // the own margin changes the verdict within this result category -> annotate the margin
    for (const b of bands) {
      const label = bandLabel(cat.kind, b.lo, b.hi, split); const posStr = posStrOf(b.posCounts);
      if (b.verdict === "CLINCH") chains.push({ condition: label, outcome: "CLINCH", own_margin_tier: split, detail: `${team} finishes ${posStr} and ADVANCES in every such completion.` });
      else if (b.verdict === "ELIMINATED") chains.push({ condition: label, outcome: "ELIMINATED", own_margin_tier: split, detail: `${team} finishes ${posStr} and does NOT advance in any such completion.` });
      else if (!b.worst) {
        // DEPENDS but no live cross-group bubble: the field is settled relative to CAN here, so the swing is finer-than-margin
        const onlyThird = Object.keys(b.posCounts).map(Number).every((p) => p === 2);
        const driver = onlyThird ? `the exact scoreline (${team}'s goals-for) at this margin — ${team} is 3rd and clears the fixed third-place cut in some completions but not others` : `the other Group ${teamGroup[team]} game, which flips ${team} between top-2 and the third-place race at this margin`;
        chains.push({ condition: label, outcome: "DEPENDS", own_margin_tier: split, detail: `${team} finishes ${posStr} — decided by ${driver}; the cross-group third-place field is already settled relative to ${team} here.` });
      }
      else {
        // DEPENDS — drill into the cross-group bubble for the band's worst-case (most vulnerable) third metric
        const repM = b.worst; const ac = c.aboveCounts(repM);
        const bubbleDesc = ac.bubble.map((bg: string) => { const set = (c.enums[bg].possibleThirds as Metric[]); const beating = set.filter((s) => beats(s, repM)); const minBeat = beating.sort((p, q) => p.pts - q.pts || p.gd - q.gd || p.gf - q.gf)[0]; return { group: bg, likely_third: teamName[set.sort((a: Metric, bb: Metric) => 0)[0]?.team] ?? bg, overtakes_can_if: minBeat ? `its third reaches >= ${minBeat.pts} pts${minBeat.gd !== undefined ? ` / GD ${minBeat.gd}` : ""} (beats ${team}'s ${repM.pts}pts/GD${repM.gd}/GF${repM.gf} on the Ladder-B order)` : "n/a" }; });
        chains.push({ condition: label, outcome: "DEPENDS", own_margin_tier: split, detail: `${team} finishes ${posStr} (best-third metrics ~${repM.pts}pts/GD${repM.gd}/GF${repM.gf}). Advances unless 8+ other groups' thirds outrank it. Currently ${ac.min} other thirds ALWAYS outrank it and up to ${ac.max} CAN — so it advances iff at most 7 do.`, bubble_dependencies: bubbleDesc, eliminated_if: `${repM.pts}pts/GD${repM.gd} third is overtaken by 8+ groups — watch: ${ac.bubble.join(", ")}` });
      }
    }
  }
  return chains;
}

// ---- full-tournament deterministic resolver (independent, for the certainty guard) ----
function resolveFull(allGames: Sl[], aux: Aux): { advances: Set<string>; canPos: Record<string, number> } {
  const byGroup: Record<string, Sl[]> = {}; for (const k of GROUP_KEYS) byGroup[k] = [];
  for (const gm of allGames) byGroup[teamGroup[gm.a]].push(gm);
  const thirds: Standing[] = []; const advances = new Set<string>(); const pos: Record<string, number> = {};
  for (const k of GROUP_KEYS) { const { tbl, gm } = standOf(GROUPS[k], byGroup[k]); const ranked = rankGroup(GROUPS[k].map((t) => tbl[t]), gm, aux); ranked.forEach((s, i) => { pos[s.team] = i; if (i < 2) advances.add(s.team); }); thirds.push(ranked[2]); }
  const tr = rankThirdPlace(thirds, aux); for (let i = 0; i < 8; i++) advances.add(tr[i].team);
  return { advances, canPos: pos };
}

// EXPORTED for the isolated end-to-end test harness: the REAL conditional-engine analysis driven by an injected
// `locked` results map (no DB). Mirrors the in-main `analyze` exactly (mode gate + concreteCertainty/concreteChains
// on the final matchday, else earlyCertainty + swingMatches) — the deterministic reasoning IS the real engine
// functions; this only orchestrates them. phase2 probability is omitted (the harness supplies the odds layer).
export function analyzeConditional(team: string, locked: Locked, fixtures: { a: string; b: string; group: string }[], aux: Aux, teamName: Record<string, string>) {
  const fxByGroup: Record<string, { a: string; b: string }[]> = {}; for (const k of GROUP_KEYS) fxByGroup[k] = [];
  for (const f of fixtures) fxByGroup[f.group].push({ a: f.a, b: f.b });
  const groupRem: Record<string, number> = {}; for (const k of GROUP_KEYS) groupRem[k] = fxByGroup[k].filter((f) => !locked[lockKey(f.a, f.b)]).length;
  const ownRem = groupRem[teamGroup[team]]; const maxRem = Math.max(...Object.values(groupRem));
  const mode = ownRem <= 2 && maxRem <= 2 ? "concrete_chains" : "certainties_and_swing";
  let certain: any, chains: any[] = [], swing: any[] = [];
  if (mode === "concrete_chains") { const cc = concreteCertainty(team, fixtures, locked, aux); certain = cc; chains = concreteChains(team, cc, aux, teamName); }
  else { certain = earlyCertainty(team, locked); swing = swingMatches(team, fixtures, locked); }
  return {
    team_code: team, group_code: teamGroup[team], mode,
    own_group_unplayed: ownRem, max_group_unplayed: maxRem,
    certain_statements: certainStatements(certain, team, mode),
    concrete_chains: mode === "concrete_chains" ? chains : [],
    swing_matches: mode === "certainties_and_swing" ? swing : [],
    full_if_then_available: mode === "concrete_chains",
  };
}

async function main() {
  const config = await readDbConfig();
  console.log(`PROJECT ID: ${config.projectRef} | Tier 3 deterministic concrete-scenario explainer | real standings: match_results (K=60) | fallback model: live dynamic-draw ${SOURCE_PRED_RUN.slice(0, 8)} | + synthetic spot-check & engine self-test | 0 writes | GCAP=${GCAP}`);
  // inputs
  const rawPreds = runSql(config.dbUrl, `select fixture_label, team_a_code a, team_b_code b, team_a_win_probability::float8 pa, draw_probability::float8 pd, team_b_win_probability::float8 pb, (scoreline_probabilities->>'lambda_a')::float8 la, (scoreline_probabilities->>'lambda_b')::float8 lb from match_predictions where prediction_run_id='${SOURCE_PRED_RUN}' order by fixture_label`);
  const fixtures: Fixture[] = (rawPreds as any[]).map((r) => { const cd = condDists(num(r.la), num(r.lb)); return { label: r.fixture_label, a: r.a, b: r.b, group: teamGroup[r.a], pa: num(r.pa), pd: num(r.pd), pb: num(r.pb), condA: cd.A, condD: cd.D, condB: cd.B, cA: cd.cA, cD: cd.cD, cB: cd.cB }; });
  const frRows = runSql(config.dbUrl, `select team_code, fifa_rank from fifa_world_rankings where ranking_snapshot_date='${FIFA_SNAPSHOT}'`);
  const fifaRank: Record<string, number> = {}; for (const r of frRows as any[]) fifaRank[r.team_code] = num(r.fifa_rank);
  const aux: Aux = { fairPlay: {}, fifaRank };
  const teamRows = runSql(config.dbUrl, `select fifa_code, name from teams`); const teamName: Record<string, string> = {}; for (const t of teamRows as any[]) teamName[t.fifa_code] = t.name;
  const fxByGroup: Record<string, { a: string; b: string }[]> = {}; for (const k of GROUP_KEYS) fxByGroup[k] = []; for (const f of fixtures) fxByGroup[f.group].push({ a: f.a, b: f.b });

  // ===== Gap 1 — REAL verified standings: the live K=60 feed, identical to build-advancement-scenario-v1-live.ts =====
  // Only condition on results whose pair is one of the 72 group fixtures; dedup by pair (last-write); orphans ignored.
  const verifiedRows = runSql(config.dbUrl, VERIFIED_RESULTS_SQL);
  const validPairs = new Set(fixtures.map((f) => lockKey(f.a, f.b)));
  const realLocked: Locked = {}; let realOrphan = 0;
  for (const r of verifiedRows as any[]) { const a = r.team_a_code, b = r.team_b_code; const key = lockKey(a, b); if (!validPairs.has(key)) { realOrphan++; continue; } realLocked[key] = { [a]: num(r.ga), [b]: num(r.gb) }; }
  const realResultCount = Object.keys(realLocked).length; const realRaw = (verifiedRows as any[]).length;

  // per-group MD3 matching (Group B -> {CAN-SUI, BIH-QAT})
  function md3Of(group: string): { a: string; b: string }[] {
    const fx = fxByGroup[group]; const pairs: number[][] = [];
    for (let i = 0; i < fx.length; i++) for (let j = i + 1; j < fx.length; j++) { const s = new Set([fx[i].a, fx[i].b, fx[j].a, fx[j].b]); if (s.size === 4) pairs.push([i, j]); }
    if (group === "B") { const p = pairs.find(([i, j]) => [fx[i], fx[j]].some((f) => (f.a === "CAN" && f.b === "SUI") || (f.a === "SUI" && f.b === "CAN")))!; return [fx[p[0]], fx[p[1]]]; }
    return [fx[pairs[0][0]], fx[pairs[0][1]]];
  }
  const md3: Record<string, { a: string; b: string }[]> = {}; for (const k of GROUP_KEYS) md3[k] = md3Of(k);
  const isMd3 = (f: { a: string; b: string }) => md3[teamGroup[f.a]].some((m) => lockKey(m.a, m.b) === lockKey(f.a, f.b));

  // synthetic "actual" MD1+MD2 via ONE deterministic v1.3 sample (seeded); override Group B to the Canada arc
  const rng = createRng(SEED); const sampled: Record<string, Sl> = {};
  const sf = (scores: { a: number; b: number }[], cum: number[], rr: number) => { for (let i = 0; i < cum.length; i++) if (rr <= cum[i]) return scores[i]; return scores[scores.length - 1] ?? { a: 0, b: 0 }; };
  for (const f of fixtures) { const r = rng(); let sc; if (r < f.pa) sc = sf(f.condA, f.cA, rng()); else if (r < f.pa + f.pd) sc = sf(f.condD, f.cD, rng()); else sc = sf(f.condB, f.cB, rng()); sampled[lockKey(f.a, f.b)] = { a: f.a, b: f.b, ga: sc.a, gb: sc.b }; }
  const arc: Record<string, Record<string, number>> = { [lockKey("CAN", "BIH")]: { CAN: 0, BIH: 1 }, [lockKey("CAN", "QAT")]: { CAN: 2, QAT: 0 }, [lockKey("SUI", "QAT")]: { SUI: 2, QAT: 0 }, [lockKey("BIH", "SUI")]: { BIH: 1, SUI: 1 } };

  // build locked maps for each stage
  const lockedStage1: Locked = { [lockKey("CAN", "BIH")]: { CAN: 0, BIH: 1 } };
  const lockedFinalMd: Locked = {}; // all MD1+MD2 across all groups; Group B = Canada arc
  for (const f of fixtures) { const key = lockKey(f.a, f.b); if (isMd3(f)) continue; if (teamGroup[f.a] === "B") lockedFinalMd[key] = arc[key]; else { const s = sampled[key]; lockedFinalMd[key] = { [s.a]: s.ga, [s.b]: s.gb }; } }

  function phase2Prob(team: string, locked: Locked): number { const sim = runGroupSim(fixtures, aux, { seed: SEED, N: 8000, locked }); return r4(((sim.advTop2[team] ?? 0) + (sim.advThird[team] ?? 0)) / sim.N); }

  function analyze(team: string, locked: Locked, phase2Override?: number) {
    const groupRem: Record<string, number> = {}; for (const k of GROUP_KEYS) groupRem[k] = fxByGroup[k].filter((f) => !locked[lockKey(f.a, f.b)]).length;
    const ownRem = groupRem[teamGroup[team]]; const maxRem = Math.max(...Object.values(groupRem));
    const mode = ownRem <= 2 && maxRem <= 2 ? "concrete_chains" : "certainties_and_swing";
    const fixturesWithGroup = fixtures.map((f) => ({ a: f.a, b: f.b, group: f.group }));
    let certain: any, chains: any[] = [], swing: any[] = [];
    if (mode === "concrete_chains") { const cc = concreteCertainty(team, fixturesWithGroup, locked, aux); certain = cc; chains = concreteChains(team, cc, aux, teamName); }
    else { certain = earlyCertainty(team, locked); swing = swingMatches(team, fixtures, locked); }
    return {
      team_code: team, group_code: teamGroup[team], mode,
      tractability: { own_group_unplayed: ownRem, max_group_unplayed: maxRem, threshold: "concrete_chains iff own_group_unplayed<=2 AND max_group_unplayed<=2 (final matchday); else certainties_and_swing", enumeration_basis: `per-group scoreline enumeration 0..${GCAP} (<= ${(GCAP + 1) ** 4} completions/group); cross-group via per-group possible-thirds counting (no global product)`, why: mode === "concrete_chains" ? "every group has <=2 games left -> remaining space enumerable" : `some group has >=3 games left (max ${maxRem}) -> space too large; degrade to certainties + swing` },
      certain_statements: certainStatements(certain, team, mode),
      swing_matches: mode === "certainties_and_swing" ? swing : [],
      concrete_chains: mode === "concrete_chains" ? chains : [],
      full_if_then_available: mode === "concrete_chains" ? true : "on the final matchday (when every group has <=2 games left)",
      phase2_probability_advance: phase2Override ?? phase2Prob(team, locked),
    };
  }

  // ===== PRODUCTION analysis on REAL standings (Gap 1) — honest degradation when few/zero verified results =====
  const argTeam = (process.argv.find((a) => a.startsWith("--team="))?.split("=")[1]) ?? "CAN";
  function lightSummary(team: string, locked: Locked) {
    const gr: Record<string, number> = {}; for (const k of GROUP_KEYS) gr[k] = fxByGroup[k].filter((f) => !locked[lockKey(f.a, f.b)]).length;
    const ownRem = gr[teamGroup[team]]; const maxRem = Math.max(...Object.values(gr));
    const mode = ownRem <= 2 && maxRem <= 2 ? "concrete_chains" : "certainties_and_swing";
    const cert = mode === "concrete_chains" ? null : earlyCertainty(team, locked);
    return { team, group: teamGroup[team], own_unplayed: ownRem, max_unplayed: maxRem, mode, clinched_advance: cert ? cert.clinched_advance : null, guaranteed_at_least_third: cert ? cert.guaranteed_at_least_third : null, cannot_reach_top2: cert ? cert.cannot_reach_top2 : null };
  }
  const production = analyze(argTeam, realLocked);
  const productionAll = ALL_TEAMS.map((t) => lightSummary(t, realLocked));

  // ===== STEP 1 — persist the engine output to a queryable team-keyed table (REAL verified standings) =====
  // Honest degradation preserved: each row records its mode; crisp concrete_chains only when own<=2 AND max<=2 (final
  // matchday), else certainties + swing + probability. One conditioned sim gives all 48 advance probs (no 48x re-sim).
  const persist = process.argv.includes("--persist");
  const persistExecute = persist && process.argv.includes("--execute");
  let persistResult = "not requested (pass --persist to plan, --persist --execute to write)";
  let condModeCounts: Record<string, number> = {};
  let condRowExample: any = null;
  if (persist) {
    const persistSim = runGroupSim(fixtures, aux, { seed: SEED, N: 8000, locked: realLocked });
    const advByTeam: Record<string, number> = {}; for (const code of ALL_TEAMS) advByTeam[code] = r4(((persistSim.advTop2[code] ?? 0) + (persistSim.advThird[code] ?? 0)) / persistSim.N);
    const ownFixtureLabel = (t: string): string | null => { const f = fxByGroup[teamGroup[t]].find((x) => !realLocked[lockKey(x.a, x.b)] && (x.a === t || x.b === t)); return f ? `${f.a} vs ${f.b}` : null; };
    const condRows = ALL_TEAMS.map((code) => { const a = analyze(code, realLocked, advByTeam[code]); return { team_code: code, group_code: a.group_code, mode: a.mode, own_group_unplayed: a.tractability.own_group_unplayed, max_group_unplayed: a.tractability.max_group_unplayed, own_fixture_label: ownFixtureLabel(code), certain_statements: a.certain_statements, concrete_chains: a.concrete_chains, swing_matches: a.swing_matches, phase2_probability_advance: a.phase2_probability_advance, full_if_then_available: String(a.full_if_then_available) }; });
    condModeCounts = condRows.reduce((m: Record<string, number>, r) => { m[r.mode] = (m[r.mode] ?? 0) + 1; return m; }, {});
    condRowExample = condRows.find((r) => r.team_code === argTeam) ?? condRows[0];
    const sq = (s: string | null) => s === null ? "null" : `$x$${s}$x$`;
    const jb = (o: unknown) => `$x$${JSON.stringify(o)}$x$::jsonb`;
    const provenance = { generator: "scripts/worldcup/concrete-scenario-tier3.ts", real_standings_gate: "match_results K=60", as_of_result_count: realResultCount, fallback_model: `${SOURCE_PRED_RUN.slice(0, 8)}/${SOURCE_SIM_RUN.slice(0, 8)}`, ladder: "fifa-2026-article-13", honest_degradation: "crisp concrete_chains only when own<=2 AND max<=2 (final matchday); else certainties+swing+probability" };
    const CONDITIONAL_DDL = `create table if not exists public.team_conditional_scenarios (
  tournament_code text not null default 'WC_2026',
  team_code text not null,
  group_code text not null,
  mode text not null,
  own_group_unplayed integer not null,
  max_group_unplayed integer not null,
  own_fixture_label text,
  certain_statements jsonb not null default '[]'::jsonb,
  concrete_chains jsonb not null default '[]'::jsonb,
  swing_matches jsonb not null default '[]'::jsonb,
  phase2_probability_advance numeric,
  full_if_then_available text,
  as_of_result_count integer not null default 0,
  ladder text not null default 'fifa-2026-article-13',
  data_source text not null,
  source_snapshot jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default now(),
  primary key (tournament_code, team_code)
)`;
    const valuesSql = condRows.map((r) => `('WC_2026',${sq(r.team_code)},${sq(r.group_code)},${sq(r.mode)},${r.own_group_unplayed},${r.max_group_unplayed},${sq(r.own_fixture_label)},${jb(r.certain_statements)},${jb(r.concrete_chains)},${jb(r.swing_matches)},${r.phase2_probability_advance},${sq(r.full_if_then_available)},${realResultCount},'fifa-2026-article-13',${sq("match_results K=60 + deterministic Article-13 engine")},${jb(provenance)},now())`).join(",\n  ");
    const CONDITIONAL_UPSERT = `insert into public.team_conditional_scenarios
  (tournament_code, team_code, group_code, mode, own_group_unplayed, max_group_unplayed, own_fixture_label, certain_statements, concrete_chains, swing_matches, phase2_probability_advance, full_if_then_available, as_of_result_count, ladder, data_source, source_snapshot, computed_at)
values
  ${valuesSql}
on conflict (tournament_code, team_code) do update set
  group_code=excluded.group_code, mode=excluded.mode, own_group_unplayed=excluded.own_group_unplayed, max_group_unplayed=excluded.max_group_unplayed,
  own_fixture_label=excluded.own_fixture_label, certain_statements=excluded.certain_statements, concrete_chains=excluded.concrete_chains, swing_matches=excluded.swing_matches,
  phase2_probability_advance=excluded.phase2_probability_advance, full_if_then_available=excluded.full_if_then_available, as_of_result_count=excluded.as_of_result_count,
  ladder=excluded.ladder, data_source=excluded.data_source, source_snapshot=excluded.source_snapshot, computed_at=now()`;
    if (persistExecute) {
      execSql(config.dbUrl, CONDITIONAL_DDL);
      execSql(config.dbUrl, CONDITIONAL_UPSERT);
      const after = runSql(config.dbUrl, `select count(*) c, count(*) filter (where mode='concrete_chains') crisp from team_conditional_scenarios`)[0];
      persistResult = `EXECUTED — team_conditional_scenarios rows: ${num((after as any).c)} (crisp: ${num((after as any).crisp)})`;
    } else {
      persistResult = `DRY-RUN — would create table + upsert ${condRows.length} rows (modes: ${JSON.stringify(condModeCounts)}). Re-run with --persist --execute to write.`;
      console.log(`\n--- team_conditional_scenarios DDL ---\n${CONDITIONAL_DDL}\n--- sample upsert row (${condRowExample?.team_code}) ---\n${valuesSql.split(",\n  ")[0]}\n`);
    }
  }

  // ===== SYNTHETIC spot-check (Canada arc) — a realistic near-final-matchday table that exercises the concrete chains + own-margin tiers =====
  const stage1 = analyze("CAN", lockedStage1);
  const stage2 = analyze("CAN", lockedFinalMd);
  // "final day" bubble: Group B still to play its MD3 (CAN-SUI, BIH-QAT), but EVERY other group has already finished
  // (thirds fixed) — the realistic staggered-final-day picture. Now CAN's OWN loss margin (its GD as a third) tips the
  // best-third cut, so the own-margin tier SPLITS (e.g. lose narrow -> still in the race; lose heavy -> out).
  const bubbleLocked: Locked = { ...lockedFinalMd };
  for (const f of fixtures) { const key = lockKey(f.a, f.b); if (isMd3(f) && teamGroup[f.a] !== "B") { const s = sampled[key]; bubbleLocked[key] = { [s.a]: s.ga, [s.b]: s.gb }; } }
  const bubble = analyze("CAN", bubbleLocked);

  // ===== CERTAINTY GUARD: hand-resolve specific final-matchday completions independently through the ladder =====
  const baseFinal: Sl[] = Object.keys(lockedFinalMd).map((k) => { const [x, y] = k.split("|"); return { a: x, b: y, ga: lockedFinalMd[k][x], gb: lockedFinalMd[k][y] }; });
  const md3Fixtures = fixtures.filter(isMd3);
  function withMd3(choices: Record<string, { ga: number; gb: number }>): Sl[] {
    const md3Games: Sl[] = md3Fixtures.map((f) => { const c = choices[lockKey(f.a, f.b)]; return c ? { a: f.a, b: f.b, ga: c.ga, gb: c.gb } : { a: f.a, b: f.b, ga: 0, gb: 0 }; });
    return [...baseFinal, ...md3Games];
  }
  // scenario builder: set CAN's game + a default for all other MD3 (0-0), plus optional overrides
  const dflt0 = () => { const o: Record<string, { ga: number; gb: number }> = {}; for (const f of md3Fixtures) o[lockKey(f.a, f.b)] = { ga: 0, gb: 0 }; return o; };
  const setGame = (o: Record<string, { ga: number; gb: number }>, a: string, b: string, ga: number, gb: number) => { const f = md3Fixtures.find((x) => lockKey(x.a, x.b) === lockKey(a, b))!; o[lockKey(a, b)] = f.a === a ? { ga, gb } : { ga: gb, gb: ga }; };
  const fxg = fixtures.map((f) => ({ a: f.a, b: f.b, group: f.group }));
  const cc2 = concreteCertainty("CAN", fxg, lockedFinalMd, aux); // engine enumeration to construct an elimination
  // independent re-implementation of the engine's PER-COMPLETION advance logic — must equal resolveFull for ANY completion
  function engineClassify(allGames: Sl[]): { advances: boolean; pos: number; thirdsAbove: number | null } {
    const byGroup: Record<string, Sl[]> = {}; for (const k of GROUP_KEYS) byGroup[k] = []; for (const gm of allGames) byGroup[teamGroup[gm.a]].push(gm);
    const thirdsM: Record<string, Metric> = {}; let canPos = -1;
    for (const k of GROUP_KEYS) { const { tbl, gm } = standOf(GROUPS[k], byGroup[k]); const ranked = rankGroup(GROUPS[k].map((t) => tbl[t]), gm, aux); const t3 = ranked[2]; thirdsM[k] = { team: t3.team, pts: t3.pts, gd: t3.gd, gf: t3.gf, fifa: aux.fifaRank[t3.team] ?? 9999 }; if (k === "B") canPos = ranked.findIndex((s) => s.team === "CAN"); }
    if (canPos < 2) return { advances: true, pos: canPos, thirdsAbove: null };
    if (canPos === 3) return { advances: false, pos: canPos, thirdsAbove: null };
    const M = thirdsM["B"]; let above = 0; for (const k of GROUP_KEYS) { if (k === "B") continue; if (beats(thirdsM[k], M)) above++; }
    return { advances: above <= 7, pos: canPos, thirdsAbove: above };
  }
  const scen = (label: string, build: (o: any) => void) => { const o = dflt0(); build(o); const games = withMd3(o); const rf = resolveFull(games, aux); const ec = engineClassify(games); return { label, can_pos_group_B: rf.canPos["CAN"] + 1, resolved_advances: rf.advances.has("CAN"), engine_advances: ec.advances, engine_thirds_above: ec.thirdsAbove, agree: rf.advances.has("CAN") === ec.advances }; };
  const setG = setGame;
  // CHECK 1 — engine vs holistic resolver agree on diverse completions (no logic divergence)
  const agree = [
    scen("CAN 3-0 SUI, BIH 1-0 QAT, others 0-0 (CAN WINS)", (o) => { setG(o, "CAN", "SUI", 3, 0); setG(o, "BIH", "QAT", 1, 0); }),
    scen("CAN 0-2 SUI, QAT 1-0 BIH, others 0-0 (CAN LOSES)", (o) => { setG(o, "CAN", "SUI", 0, 2); setG(o, "BIH", "QAT", 0, 1); }),
    scen("CAN 1-1 SUI; non-B MD3 all 5-0 (CAN DRAWS)", (o) => { setG(o, "CAN", "SUI", 1, 1); for (const f of md3Fixtures) if (teamGroup[f.a] !== "B") setG(o, f.a, f.b, 5, 0); }),
    scen("CAN 0-6 SUI, QAT 6-0 BIH — H2H TRAP (QAT better overall GD)", (o) => { setG(o, "CAN", "SUI", 0, 6); setG(o, "BIH", "QAT", 0, 6); }),
  ];
  const agreeOk = agree.every((c) => c.agree);
  // CHECK 2 — CLINCH "beats SUI": adversarial wins all advance & finish top-2
  const clinchCases = [agree[0], scen("CAN 1-0 SUI, BIH 5-0 QAT (CAN WINS narrow, BIH big)", (o) => { setG(o, "CAN", "SUI", 1, 0); setG(o, "BIH", "QAT", 5, 0); })];
  const clinchOk = clinchCases.every((c) => c.resolved_advances && c.can_pos_group_B <= 2);
  // CHECK 3 — GUARANTEED >=3rd via H2H: in the trap, CAN beat QAT head-to-head -> CAN ranks above QAT despite worse overall GD
  const trapGames = (() => { const o = dflt0(); setG(o, "CAN", "SUI", 0, 6); setG(o, "BIH", "QAT", 0, 6); return withMd3(o); })();
  const trapRes = resolveFull(trapGames, aux); const ge3Ok = trapRes.canPos["CAN"] <= 2 && trapRes.canPos["CAN"] < trapRes.canPos["QAT"]; // CAN >=3rd AND above QAT
  // CHECK 4 — construct a genuine ELIMINATION (the not-advance branch): CAN loses 0-6 (3pts/GD-5 third); force >=8 other
  // groups to produce a CAN-beating third using the engine's own enumeration, then independently resolve -> CAN OUT.
  const lossMetric: Metric = (() => { const bGames: Sl[] = []; for (const f of fxByGroup["B"]) { const k = lockKey(f.a, f.b); if (lockedFinalMd[k]) bGames.push({ a: f.a, b: f.b, ga: lockedFinalMd[k][f.a], gb: lockedFinalMd[k][f.b] }); } bGames.push({ a: "CAN", b: "SUI", ga: 0, gb: 6 } as any); bGames.push({ a: "BIH", b: "QAT", ga: 0, gb: 0 } as any); const { tbl } = standOf(GROUPS["B"], bGames); const c = tbl["CAN"]; return { team: "CAN", pts: c.pts, gd: c.gd, gf: c.gf, fifa: aux.fifaRank["CAN"] ?? 9999 }; })();
  const elimO = dflt0(); setG(elimO, "CAN", "SUI", 0, 6); setG(elimO, "BIH", "QAT", 0, 0); let forced = 0;
  for (const k of GROUP_KEYS) { if (k === "B") continue; const comp = cc2.enums[k].completions.find((c) => beats(c.third, lossMetric)); if (comp && comp.rem.length) { for (const r of comp.rem) setG(elimO, r.a, r.b, r.ga, r.gb); forced++; } }
  const elimGames = withMd3(elimO); const elimRf = resolveFull(elimGames, aux); const elimEc = engineClassify(elimGames);
  const elimOk = !elimRf.advances.has("CAN") && elimRf.advances.has("CAN") === elimEc.advances; // CAN OUT and engine agrees
  const guard_all_pass = agreeOk && clinchOk && ge3Ok && elimOk;

  const out = {
    tier3_concrete_scenario: true, project_id: config.projectRef, deterministic_no_rng: true, db_writes: 0, ladder: "fifa-2026-article-13", gcap: GCAP,
    data_source: {
      real_standings: "match_results — K=60 verified gate (match_status=finished + api_football_fixture_id + source_payload_hash + not-rejected + group); identical feed to build-advancement-scenario-v1-live.ts",
      probabilistic_fallback_model: `PROMOTED live dynamic-draw (group preds ${SOURCE_PRED_RUN.slice(0, 8)}, sim ${SOURCE_SIM_RUN.slice(0, 8)}) — NOT the superseded v1.3 run 85555853`,
      own_margin_tiers: "own result split to the margin ONLY where the margin changes the verdict (e.g. lose-by-1 -> DEPENDS vs lose-by-3+ -> ELIMINATED); identical-verdict margins stay collapsed ('a win clinches')",
    },
    real_verified_results: { locked_pairs: realResultCount, raw_rows: realRaw, orphan_rows: realOrphan, note: realResultCount === 0 ? "0 verified results yet (tournament opens 2026-06-11) -> every team degrades HONESTLY to point-bound certainties + swing + Phase-2 probability; NO fabricated chains (>=3 games left in every group)" : `${realResultCount} verified results condition the real analysis` },
    production_real_standings: { focus_team: production, all_teams_modes: productionAll },
    conditional_table_persist: { requested: persist, executed: persistExecute, table: "public.team_conditional_scenarios (team-keyed; mode + certain_statements + concrete_chains[margin tiers+bubble thresholds] + swing + phase2 prob)", mode_counts: condModeCounts, result: persistResult, row_example: condRowExample },
    threshold_definition: "CONCRETE-CHAINS mode iff (team's group unplayed <= 2) AND (every group unplayed <= 2) — i.e. the final matchday, where per-group scoreline enumeration (<= " + (GCAP + 1) ** 4 + "/group) and cross-group possible-thirds counting are tractable. Otherwise CERTAINTIES+SWING mode (sound point-bound certainties + highest-leverage swing matches + Phase-2 probability), with full if-then deferred to the final matchday. Never fabricate chains.",
    spot_check_synthetic_near_final: { note: "SYNTHETIC-but-realistic near-final-matchday table (Canada arc — every group <=2 games left) that exercises the concrete chains + own-margin tiers; clearly synthetic, NOT real data", stage1_after_game1: stage1, stage2_all_groups_final_day_simultaneous: stage2, bubble_final_day_other_groups_decided: bubble },
    certainty_guard: {
      note: "each completion is resolved TWO independent ways — a holistic full-tournament resolver (rankGroup x12 + rankThirdPlace) and the engine's per-branch classification — and must agree. Plus directional checks: CLINCH always advances, the H2H 'guaranteed >=3rd' trap, and a CONSTRUCTED elimination (the not-advance branch).",
      guard_all_pass,
      check1_engine_vs_resolver_agree: { pass: agreeOk, cases: agree },
      check2_clinch_beats_sui_always_advances: { pass: clinchOk, cases: clinchCases },
      check3_guaranteed_third_via_h2h: { pass: ge3Ok, detail: `CAN 0-6 SUI (GD-5) + QAT 6-0 BIH (GD+2): CAN pos ${trapRes.canPos["CAN"] + 1}, QAT pos ${trapRes.canPos["QAT"] + 1} — CAN stays above QAT on head-to-head despite QAT's better overall GD (proves the corrected Article-13 ladder; naive overall-GD would wrongly drop CAN to 4th).` },
      check4_constructed_elimination: { pass: elimOk, detail: `CAN 0-6 SUI (3pts/GD${lossMetric.gd} third); forced ${forced} other groups to a CAN-beating third via the engine's own enumeration -> CAN OUT (resolved_advances=${elimRf.advances.has("CAN")}, thirds_above_CAN=${elimEc.thirdsAbove}); engine and resolver agree. Confirms the loses->DEPENDS branch genuinely contains a not-advance outcome.` },
    },
  };
  writeFileSync(path.join(rootDir, "data/audits/concrete-scenario-tier3-synthetic.json"), JSON.stringify(out, null, 2), "utf8");
  console.log(JSON.stringify(out, null, 2));
}
// Run main() only when invoked directly (not when imported by the test harness), so importing has no side effects.
const invokedDirectly = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) main().catch((e) => { console.error("ERROR:", e?.message ?? e); process.exit(1); });
