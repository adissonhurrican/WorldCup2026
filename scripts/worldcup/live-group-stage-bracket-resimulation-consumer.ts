import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

type DbConfig = { dbUrl: string; restUrl: string; serviceRoleKey: string; projectRef: string };
type Outcome = "a" | "d" | "b";
type Score = { a: number; b: number };
type Fixture = {
  label: string;
  a: string;
  b: string;
  group: string;
  pa: number;
  pd: number;
  pb: number;
  condA: Score[];
  condD: Score[];
  condB: Score[];
  cA: number[];
  cD: number[];
  cB: number[];
};
type ActualResult = {
  fixture_label: string;
  team_a_code: string;
  team_b_code: string;
  team_a_goals: number;
  team_b_goals: number;
  match_status: string;
  source_payload_hash: string | null;
  api_football_fixture_id: number | null;
};
type StandingRow = { team: string; pts: number; gf: number; ga: number; gd: number };
type GroupOutcome = {
  winners: Record<string, string>;
  runnersUp: Record<string, string>;
  thirdPlaced: Record<string, string>;
  advancingThirds: Record<string, string>;
  advancingThirdGroups: string[];
  thirdPlaceKey: string;
  rankedGroups: Record<string, StandingRow[]>;
  bestThirdRanked: StandingRow[];
};
type AnnexCMappingRow = {
  combination_number: number;
  key: string;
  advancing_third_place_groups: string[];
  third_place_slot_assignments: Record<string, string>;
};
type R32Match = {
  match_number: number;
  home_slot: string;
  away_slot: string;
  home_team: string;
  away_team: string;
  home_group: string;
  away_group: string;
  third_place_slot_key: string | null;
  third_place_source_group: string | null;
};

const rootDir = process.cwd();
const credentialsPath = path.join(rootDir, "supebase.txt");
const tempDir = path.join(rootDir, ".tmp", "worldcup-sql");
const auditDir = path.join(rootDir, "data", "audits");
const docsDir = path.join(rootDir, "docs");
const annexCPath = path.join(rootDir, "data", "external", "fifa", "annex-c-r32-third-place-mapping.json");
const worldCupProjectRef = "ahcfrgxczbgdvrqmbisw";
const DEFAULT_SOURCE_PREDICTION_RUN_ID = "066be1b1-de89-44de-8b7c-c95f4353ad7e"; // PROMOTED live group predictions (dynamic-draw); was 85555853
// Non-destructive override: `--source-run <uuid>` re-runs the IDENTICAL knockout engine on a different
// group-prediction input (default unchanged). Used for the dynamic-draw candidate (066be1b1); 85555853 untouched.
const sourcePredictionRunId = (() => { const i = process.argv.indexOf("--source-run"); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : DEFAULT_SOURCE_PREDICTION_RUN_ID; })();
const isAltSourceRun = sourcePredictionRunId !== DEFAULT_SOURCE_PREDICTION_RUN_ID;
const originalSimulationRunId = "0b7b5619-b4f3-4a77-b3ea-2dd0388ae183";
const simulationModelVersion = "live-group-stage-bracket-resimulation-consumer-v0.1";
const baseSimulationModelVersion = "tournament-monte-carlo-all-groups-v1";
const expectedGroupFixtureCount = 72;
const defaultIterations = 20000;
const defaultSeed = 20260602;
const maxGoals = 8;
const equivalenceTolerance = 0.003;

const groups: Record<string, string[]> = {
  A: ["MEX", "RSA", "KOR", "CZE"],
  B: ["CAN", "BIH", "SUI", "QAT"],
  C: ["BRA", "HAI", "MAR", "SCO"],
  D: ["AUS", "PAR", "TUR", "USA"],
  E: ["CIV", "CUW", "ECU", "GER"],
  F: ["JPN", "NED", "SWE", "TUN"],
  G: ["BEL", "EGY", "IRN", "NZL"],
  H: ["CPV", "ESP", "KSA", "URU"],
  I: ["FRA", "IRQ", "NOR", "SEN"],
  J: ["ALG", "ARG", "AUT", "JOR"],
  K: ["COD", "COL", "POR", "UZB"],
  L: ["CRO", "ENG", "GHA", "PAN"],
};
const teamGroup: Record<string, string> = {};
for (const groupCode of Object.keys(groups)) {
  for (const teamCode of groups[groupCode]) teamGroup[teamCode] = groupCode;
}
const allTeams = Object.values(groups).flat();
const factorials = Array.from({ length: maxGoals + 1 }, (_, i) => {
  let value = 1;
  for (let k = 2; k <= i; k += 1) value *= k;
  return value;
});

let queryCounter = 0;

function parseArgs() {
  const args = process.argv.slice(2);
  const simulationsFlag = args.findIndex((arg) => arg === "--simulations");
  const seedFlag = args.findIndex((arg) => arg === "--seed");
  // OPTIONAL learned-Elo override: read the knockout Elo by an explicit source_provider tag (e.g.
  // 'in-tournament-k60-candidate', the end-of-group K=60 snapshot) instead of the default frozen
  // pre-tournament Elo. Default (no flag) is UNCHANGED. Validated to a safe charset (interpolated into SQL).
  const eloTagFlag = args.findIndex((arg) => arg === "--elo-source-tag");
  const eloSourceTag = eloTagFlag >= 0 ? String(args[eloTagFlag + 1] ?? "") : null;
  if (eloSourceTag !== null && !/^[a-z0-9_-]+$/i.test(eloSourceTag)) {
    throw new Error(`--elo-source-tag must match [a-z0-9_-]+ (got: ${JSON.stringify(eloSourceTag)})`);
  }
  return {
    execute: args.includes("--execute"),
    syntheticLockTest: args.includes("--synthetic-lock-test"),
    syntheticStressTest: args.includes("--synthetic-stress-test"),
    r32ConstructionDryRun: args.includes("--r32-construction-dry-run"),
    fullTournamentKnockoutDryRun: args.includes("--full-tournament-knockout-dry-run"),
    simulations: simulationsFlag >= 0 ? Number(args[simulationsFlag + 1]) : defaultIterations,
    seed: seedFlag >= 0 ? Number(args[seedFlag + 1]) : defaultSeed,
    eloSourceTag,
  };
}

async function readDbConfig(): Promise<DbConfig> {
  // CI-first: use env creds (SUPABASE_DB_URL + SUPABASE_SERVICE_ROLE_KEY) so this works on GitHub Actions where
  // supebase.txt is absent. Fall back to the local supebase.txt file when env is unset (local runs unchanged).
  const envDbUrl = process.env.SUPABASE_DB_URL;
  const envServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (envDbUrl && envServiceRoleKey) {
    const projectRef = envDbUrl.match(/postgres\.([a-z0-9]+):/)?.[1] ?? envDbUrl.match(/\/\/([^.]+)\.supabase\.co/)?.[1] ?? "";
    if (projectRef !== worldCupProjectRef) throw new Error(`Unexpected project ref from SUPABASE_DB_URL: ${projectRef || "unknown"}`);
    return { projectRef, restUrl: `https://${projectRef}.supabase.co/rest/v1`, serviceRoleKey: envServiceRoleKey, dbUrl: envDbUrl };
  }
  const text = await readFile(credentialsPath, "utf8");
  const projectRef = text.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];
  const password = text.match(/supebase password\s*:\s*(\S+)/i)?.[1];
  const restUrl = text.match(/https:\/\/[^\s]+\/rest\/v1\/?/)?.[0]?.replace(/\/$/, "");
  const serviceRoleKey = text.match(/service role secret\s*:\s*(\S+)/i)?.[1];
  if (projectRef !== worldCupProjectRef) throw new Error(`Unexpected project ref: ${projectRef ?? "unknown"}`);
  if (!password || !restUrl || !serviceRoleKey) throw new Error(`Missing Supabase credentials in ${credentialsPath}`);
  return {
    projectRef,
    restUrl,
    serviceRoleKey,
    dbUrl: `postgresql://postgres.${projectRef}:${encodeURIComponent(password)}@aws-1-us-west-1.pooler.supabase.com:5432/postgres`,
  };
}

function stripSqlStrings(sql: string) {
  return sql.replace(/'([^']|'')*'/g, "''");
}

function queryJson<T = any>(config: DbConfig, sql: string): T[] {
  if (/\b(insert|update|delete|drop|alter|truncate|create|grant|revoke)\b/i.test(stripSqlStrings(sql))) {
    throw new Error("read helper refuses mutating SQL");
  }
  mkdirSync(tempDir, { recursive: true });
  queryCounter += 1;
  const sqlPath = path.join(tempDir, `live-resim-${Date.now()}-${queryCounter}.sql`);
  writeFileSync(sqlPath, sql, "utf8");
  const result = process.platform === "win32"
    ? spawnSync(
        "cmd.exe",
        ["/c", "npx.cmd", "supabase", "db", "query", "--db-url", config.dbUrl, "--output", "json", "--file", sqlPath],
        { encoding: "utf8", maxBuffer: 1024 * 1024 * 120 },
      )
    : spawnSync(
        "npx",
        ["supabase", "db", "query", "--db-url", config.dbUrl, "--output", "json", "--file", sqlPath],
        { encoding: "utf8", maxBuffer: 1024 * 1024 * 120 },
      );
  if ((result.status ?? 1) !== 0) {
    throw new Error((result.stderr || result.stdout || "Supabase query failed").slice(0, 1200));
  }
  const parsed = JSON.parse(result.stdout.trim());
  return (Array.isArray(parsed) ? parsed : parsed.rows ?? parsed) as T[];
}

async function restPost(config: DbConfig, table: string, rows: any[], representation = false): Promise<any> {
  const response = await fetch(`${config.restUrl}/${table}`, {
    method: "POST",
    headers: {
      apikey: config.serviceRoleKey,
      authorization: `Bearer ${config.serviceRoleKey}`,
      "content-type": "application/json",
      prefer: representation ? "return=representation" : "return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!response.ok) {
    throw new Error(`${table} insert failed (${response.status}): ${(await response.text()).slice(0, 1000)}`);
  }
  return representation ? response.json() : null;
}

function one<T = any>(config: DbConfig, sql: string): T {
  return queryJson<T>(config, sql)[0];
}

function decimal(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    if (candidate.NaN === true) return null;
    if ("Int" in candidate) return Number(candidate.Int) * Math.pow(10, Number(candidate.Exp ?? 0));
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function num(value: unknown) {
  return decimal(value) ?? 0;
}

function round4(value: number) {
  return Number(value.toFixed(4));
}

function createRng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function poisson(lambda: number, k: number) {
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorials[k];
}

function cumulative(probabilities: number[]) {
  const total = probabilities.reduce((sum, value) => sum + value, 0) || 1;
  let running = 0;
  return probabilities.map((value) => {
    running += value / total;
    return running;
  });
}

function conditionalDistributions(lambdaA: number, lambdaB: number) {
  const winsA: Score[] = [];
  const draws: Score[] = [];
  const winsB: Score[] = [];
  const pA: number[] = [];
  const pD: number[] = [];
  const pB: number[] = [];

  for (let a = 0; a <= maxGoals; a += 1) {
    for (let b = 0; b <= maxGoals; b += 1) {
      const probability = poisson(lambdaA, a) * poisson(lambdaB, b);
      if (a > b) {
        winsA.push({ a, b });
        pA.push(probability);
      } else if (a === b) {
        draws.push({ a, b });
        pD.push(probability);
      } else {
        winsB.push({ a, b });
        pB.push(probability);
      }
    }
  }

  return { winsA, draws, winsB, cA: cumulative(pA), cD: cumulative(pD), cB: cumulative(pB) };
}

function sampleScore(scores: Score[], cumulativeProbabilities: number[], random: number) {
  for (let i = 0; i < cumulativeProbabilities.length; i += 1) {
    if (random <= cumulativeProbabilities[i]) return scores[i];
  }
  return scores[scores.length - 1] ?? { a: 0, b: 0 };
}

function rankWithFallback(rows: StandingRow[], rng: () => number) {
  let fallback = 0;
  const ranked = [...rows]
    .map((standing) => ({ standing, random: rng() }))
    .sort((left, right) => {
      const deterministic =
        right.standing.pts - left.standing.pts ||
        right.standing.gd - left.standing.gd ||
        right.standing.gf - left.standing.gf;
      if (deterministic !== 0) return deterministic;
      fallback += 1;
      return left.random - right.random;
    })
    .map((entry) => entry.standing);
  return { ranked, fallback };
}

function csvEscape(value: unknown) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(filePath: string, rows: Record<string, unknown>[]) {
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  const lines = [headers.join(","), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))];
  writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown) {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
}

function fixtureResultKey(a: string, b: string) {
  return [a, b].sort().join("|");
}

function syntheticActual(teamA: string, teamB: string, goalsA: number, goalsB: number, label: string): ActualResult {
  return {
    fixture_label: label,
    team_a_code: teamA,
    team_b_code: teamB,
    team_a_goals: goalsA,
    team_b_goals: goalsB,
    match_status: "finished",
    source_payload_hash: `synthetic:${label}:${teamA}-${goalsA}-${goalsB}-${teamB}`,
    api_football_fixture_id: null,
  };
}

function actualMapFromRows(rows: ActualResult[]) {
  const map = new Map<string, ActualResult[]>();
  for (const row of rows) {
    const key = fixtureResultKey(row.team_a_code, row.team_b_code);
    map.set(key, [...(map.get(key) ?? []), row]);
  }
  return map;
}

function rowByTeam(rows: any[]) {
  return new Map(rows.map((row) => [row.team_code, row]));
}

function scenarioComparisonRows(
  scenarioName: string,
  affectedGroups: string[],
  scenarioRows: any[],
  baselineRows: any[],
) {
  const baseline = rowByTeam(baselineRows);
  const affectedGroupSet = new Set(affectedGroups);
  return scenarioRows.map((row) => {
    const base = baseline.get(row.team_code);
    return {
      scenario: scenarioName,
      team_code: row.team_code,
      group_code: row.group_code,
      affected_group: affectedGroupSet.has(row.group_code),
      baseline_win_group_probability: base?.win_group_probability ?? null,
      synthetic_win_group_probability: row.win_group_probability,
      win_group_delta: base ? round4(row.win_group_probability - base.win_group_probability) : null,
      baseline_top_2_probability: base?.advance_top_2_probability ?? null,
      synthetic_top_2_probability: row.advance_top_2_probability,
      top_2_delta: base ? round4(row.advance_top_2_probability - base.advance_top_2_probability) : null,
      baseline_best_third_probability: base?.advance_best_third_probability ?? null,
      synthetic_best_third_probability: row.advance_best_third_probability,
      best_third_delta: base ? round4(row.advance_best_third_probability - base.advance_best_third_probability) : null,
      baseline_advance_probability: base?.reach_round_of_32_probability ?? null,
      synthetic_advance_probability: row.reach_round_of_32_probability,
      advance_delta: base ? round4(row.reach_round_of_32_probability - base.reach_round_of_32_probability) : null,
    };
  });
}

function maxAbs(values: Array<number | null | undefined>) {
  const usable = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return usable.length ? round4(Math.max(...usable.map((value) => Math.abs(value)))) : 0;
}

function buildSyntheticVerdict(
  scenarioName: string,
  affectedGroups: string[],
  comparisons: ReturnType<typeof scenarioComparisonRows>,
  sumAdvance: number,
  sumTop2: number,
  sumWinGroup: number,
) {
  const affected = comparisons.filter((row) => affectedGroups.includes(String(row.group_code)));
  const unaffected = comparisons.filter((row) => !affectedGroups.includes(String(row.group_code)));
  const maxUnaffectedWinGroupDelta = maxAbs(unaffected.map((row) => row.win_group_delta));
  const maxUnaffectedTop2Delta = maxAbs(unaffected.map((row) => row.top_2_delta));
  const maxUnaffectedAdvanceDelta = maxAbs(unaffected.map((row) => row.advance_delta));
  const invariantsHold =
    Math.abs(sumAdvance - 32) <= 0.05 && Math.abs(sumTop2 - 24) <= 0.05 && Math.abs(sumWinGroup - 12) <= 0.05;
  return {
    scenario: scenarioName,
    affected_groups: affectedGroups,
    affected_group_rows: affected,
    max_unaffected_win_group_delta: maxUnaffectedWinGroupDelta,
    max_unaffected_top_2_delta: maxUnaffectedTop2Delta,
    max_unaffected_advance_delta: maxUnaffectedAdvanceDelta,
    non_affected_group_internal_probabilities_unchanged: maxUnaffectedWinGroupDelta === 0 && maxUnaffectedTop2Delta === 0,
    non_affected_overall_advance_note:
      maxUnaffectedAdvanceDelta === 0
        ? "overall advancement unchanged outside affected group"
        : "overall advancement moved outside affected group through the legitimate global best-third pool",
    sum_checks: {
      advance: sumAdvance,
      top_2: sumTop2,
      win_group: sumWinGroup,
      hold: invariantsHold,
    },
  };
}

function actualForFixture(fixture: Fixture, actualsByPair: Map<string, ActualResult[]>, errors: string[]) {
  const matches = actualsByPair.get(fixtureResultKey(fixture.a, fixture.b)) ?? [];
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    errors.push(`duplicate finished results for ${fixture.a}-${fixture.b}: ${matches.map((row) => row.fixture_label).join("; ")}`);
    return null;
  }
  const actual = matches[0];
  if (actual.team_a_code === fixture.a && actual.team_b_code === fixture.b) {
    return { score: { a: actual.team_a_goals, b: actual.team_b_goals }, actual };
  }
  if (actual.team_a_code === fixture.b && actual.team_b_code === fixture.a) {
    return { score: { a: actual.team_b_goals, b: actual.team_a_goals }, actual };
  }
  errors.push(`finished result team mismatch for fixture ${fixture.label}`);
  return null;
}

function runSimulation(fixtures: Fixture[], actualsByPair: Map<string, ActualResult[]>, simulations: number, seed: number, errors: string[]) {
  const rng = createRng(seed);
  const finish: Record<string, [number, number, number, number]> = {};
  const advanceTop2: Record<string, number> = {};
  const advanceThird: Record<string, number> = {};
  const pointsDistribution: Record<string, Record<number, number>> = {};
  const goalDifferenceDistribution: Record<string, Record<number, number>> = {};
  const fixtureStates = fixtures.map((fixture) => ({ fixture, actual: actualForFixture(fixture, actualsByPair, errors) }));
  const actualLockedFixtures = fixtureStates.filter((entry) => entry.actual).length;
  const sampledFixtures = fixtureStates.length - actualLockedFixtures;

  for (const team of allTeams) {
    finish[team] = [0, 0, 0, 0];
    advanceTop2[team] = 0;
    advanceThird[team] = 0;
    pointsDistribution[team] = {};
    goalDifferenceDistribution[team] = {};
  }

  let drawCount = 0;
  let tiebreakerFallbackCount = 0;
  let iterationsWithFallback = 0;

  for (let iteration = 0; iteration < simulations; iteration += 1) {
    let iterationFallbackCount = 0;
    const table: Record<string, StandingRow> = {};
    for (const team of allTeams) table[team] = { team, pts: 0, gf: 0, ga: 0, gd: 0 };

    for (const fixtureState of fixtureStates) {
      const fixture = fixtureState.fixture;
      let score: Score;
      if (fixtureState.actual) {
        // Keep the random stream aligned with the all-sampled baseline. A sampled fixture
        // always consumes one outcome draw and one conditional-scoreline draw.
        rng();
        rng();
        score = fixtureState.actual.score;
      } else {
        const outcomeRandom = rng();
        let outcome: Outcome;
        if (outcomeRandom < fixture.pa) {
          outcome = "a";
          score = sampleScore(fixture.condA, fixture.cA, rng());
        } else if (outcomeRandom < fixture.pa + fixture.pd) {
          outcome = "d";
          score = sampleScore(fixture.condD, fixture.cD, rng());
        } else {
          outcome = "b";
          score = sampleScore(fixture.condB, fixture.cB, rng());
        }
        if (outcome === "d") drawCount += 1;
      }

      const teamA = table[fixture.a];
      const teamB = table[fixture.b];
      teamA.gf += score.a;
      teamA.ga += score.b;
      teamB.gf += score.b;
      teamB.ga += score.a;
      teamA.gd = teamA.gf - teamA.ga;
      teamB.gd = teamB.gf - teamB.ga;
      if (score.a > score.b) teamA.pts += 3;
      else if (score.a < score.b) teamB.pts += 3;
      else {
        teamA.pts += 1;
        teamB.pts += 1;
      }
    }

    const thirdPlacedTeams: StandingRow[] = [];
    for (const groupCode of Object.keys(groups)) {
      const { ranked, fallback } = rankWithFallback(
        groups[groupCode].map((team) => table[team]),
        rng,
      );
      tiebreakerFallbackCount += fallback;
      iterationFallbackCount += fallback;
      ranked.forEach((standing, index) => {
        finish[standing.team][index] += 1;
        if (index < 2) advanceTop2[standing.team] += 1;
        pointsDistribution[standing.team][standing.pts] = (pointsDistribution[standing.team][standing.pts] ?? 0) + 1;
        goalDifferenceDistribution[standing.team][standing.gd] =
          (goalDifferenceDistribution[standing.team][standing.gd] ?? 0) + 1;
      });
      thirdPlacedTeams.push(ranked[2]);
    }

    const { ranked: rankedThirds, fallback } = rankWithFallback(thirdPlacedTeams, rng);
    tiebreakerFallbackCount += fallback;
    iterationFallbackCount += fallback;
    for (let index = 0; index < 8; index += 1) advanceThird[rankedThirds[index].team] += 1;
    if (iterationFallbackCount > 0) iterationsWithFallback += 1;
  }

  const rows = allTeams.map((team) => {
    const finishes = finish[team];
    const finish1 = finishes[0] / simulations;
    const finish2 = finishes[1] / simulations;
    const finish3 = finishes[2] / simulations;
    const finish4 = finishes[3] / simulations;
    const top2 = advanceTop2[team] / simulations;
    const bestThird = advanceThird[team] / simulations;
    const advance = top2 + bestThird;
    return {
      team_code: team,
      group_code: teamGroup[team],
      finish_1st_probability: round4(finish1),
      finish_2nd_probability: round4(finish2),
      finish_3rd_probability: round4(finish3),
      finish_4th_probability: round4(finish4),
      win_group_probability: round4(finish1),
      advance_top_2_probability: round4(top2),
      advance_best_third_probability: round4(bestThird),
      reach_round_of_32_probability: round4(advance),
      eliminated_group_stage_probability: round4(1 - advance),
    };
  });

  const sampledFixtureCount = sampledFixtures * simulations;
  return {
    rows,
    actualLockedFixtures,
    sampledFixtures,
    simulatedDrawRate: sampledFixtureCount > 0 ? round4(drawCount / sampledFixtureCount) : 0,
    tiebreakerFallbackCount,
    tiebreakerFallbackRate: round4(iterationsWithFallback / simulations),
    fixtureStates,
  };
}

const r32FixedPairings = [
  { match_number: 73, home_slot: "Runner-up Group A", away_slot: "Runner-up Group B" },
  { match_number: 74, home_slot: "Winner Group E", away_slot: "3rd Group A/B/C/D/F" },
  { match_number: 75, home_slot: "Winner Group F", away_slot: "Runner-up Group C" },
  { match_number: 76, home_slot: "Winner Group C", away_slot: "Runner-up Group F" },
  { match_number: 77, home_slot: "Winner Group I", away_slot: "3rd Group C/D/F/G/H" },
  { match_number: 78, home_slot: "Runner-up Group E", away_slot: "Runner-up Group I" },
  { match_number: 79, home_slot: "Winner Group A", away_slot: "3rd Group C/E/F/H/I" },
  { match_number: 80, home_slot: "Winner Group L", away_slot: "3rd Group E/H/I/J/K" },
  { match_number: 81, home_slot: "Winner Group D", away_slot: "3rd Group B/E/F/I/J" },
  { match_number: 82, home_slot: "Winner Group G", away_slot: "3rd Group A/E/H/I/J" },
  { match_number: 83, home_slot: "Runner-up Group K", away_slot: "Runner-up Group L" },
  { match_number: 84, home_slot: "Winner Group H", away_slot: "Runner-up Group J" },
  { match_number: 85, home_slot: "Winner Group B", away_slot: "3rd Group E/F/G/I/J" },
  { match_number: 86, home_slot: "Winner Group J", away_slot: "Runner-up Group H" },
  { match_number: 87, home_slot: "Winner Group K", away_slot: "3rd Group D/E/I/J/L" },
  { match_number: 88, home_slot: "Runner-up Group D", away_slot: "Runner-up Group G" },
];

const fixedBracketTree = {
  round_of_16: [
    { match_number: 89, home_slot: "Winner Match 74", away_slot: "Winner Match 77" },
    { match_number: 90, home_slot: "Winner Match 73", away_slot: "Winner Match 75" },
    { match_number: 91, home_slot: "Winner Match 76", away_slot: "Winner Match 78" },
    { match_number: 92, home_slot: "Winner Match 79", away_slot: "Winner Match 80" },
    { match_number: 93, home_slot: "Winner Match 83", away_slot: "Winner Match 84" },
    { match_number: 94, home_slot: "Winner Match 81", away_slot: "Winner Match 82" },
    { match_number: 95, home_slot: "Winner Match 86", away_slot: "Winner Match 88" },
    { match_number: 96, home_slot: "Winner Match 85", away_slot: "Winner Match 87" },
  ],
  quarterfinals: [
    { match_number: 97, home_slot: "Winner Match 89", away_slot: "Winner Match 90" },
    { match_number: 98, home_slot: "Winner Match 93", away_slot: "Winner Match 94" },
    { match_number: 99, home_slot: "Winner Match 91", away_slot: "Winner Match 92" },
    { match_number: 100, home_slot: "Winner Match 95", away_slot: "Winner Match 96" },
  ],
  semifinals: [
    { match_number: 101, home_slot: "Winner Match 97", away_slot: "Winner Match 98" },
    { match_number: 102, home_slot: "Winner Match 99", away_slot: "Winner Match 100" },
  ],
  third_place: [{ match_number: 103, home_slot: "Loser Match 101", away_slot: "Loser Match 102" }],
  final: [{ match_number: 104, home_slot: "Winner Match 101", away_slot: "Winner Match 102" }],
};

function loadAnnexC() {
  const parsed = JSON.parse(readFileSync(annexCPath, "utf8"));
  const mappings = parsed.mappings as Record<string, AnnexCMappingRow>;
  const slotOrder = parsed.metadata?.slot_order as string[];
  if (!mappings || Object.keys(mappings).length !== 495) throw new Error(`Annex C mapping count invalid in ${annexCPath}`);
  return { metadata: parsed.metadata, mappings, slotOrder };
}

function sampleSingleGroupOutcomeWithRng(fixtures: Fixture[], rng: () => number): GroupOutcome {
  const table: Record<string, StandingRow> = {};
  for (const team of allTeams) table[team] = { team, pts: 0, gf: 0, ga: 0, gd: 0 };

  for (const fixture of fixtures) {
    const outcomeRandom = rng();
    let score: Score;
    if (outcomeRandom < fixture.pa) {
      score = sampleScore(fixture.condA, fixture.cA, rng());
    } else if (outcomeRandom < fixture.pa + fixture.pd) {
      score = sampleScore(fixture.condD, fixture.cD, rng());
    } else {
      score = sampleScore(fixture.condB, fixture.cB, rng());
    }
    const teamA = table[fixture.a];
    const teamB = table[fixture.b];
    teamA.gf += score.a;
    teamA.ga += score.b;
    teamB.gf += score.b;
    teamB.ga += score.a;
    teamA.gd = teamA.gf - teamA.ga;
    teamB.gd = teamB.gf - teamB.ga;
    if (score.a > score.b) teamA.pts += 3;
    else if (score.a < score.b) teamB.pts += 3;
    else {
      teamA.pts += 1;
      teamB.pts += 1;
    }
  }

  const winners: Record<string, string> = {};
  const runnersUp: Record<string, string> = {};
  const thirdPlaced: Record<string, string> = {};
  const rankedGroups: Record<string, StandingRow[]> = {};
  const thirdPlacedRows: StandingRow[] = [];
  for (const groupCode of Object.keys(groups)) {
    const { ranked } = rankWithFallback(
      groups[groupCode].map((team) => table[team]),
      rng,
    );
    rankedGroups[groupCode] = ranked;
    winners[groupCode] = ranked[0].team;
    runnersUp[groupCode] = ranked[1].team;
    thirdPlaced[groupCode] = ranked[2].team;
    thirdPlacedRows.push(ranked[2]);
  }
  const { ranked: bestThirdRanked } = rankWithFallback(thirdPlacedRows, rng);
  const advancingThirdRows = bestThirdRanked.slice(0, 8);
  const advancingThirds: Record<string, string> = {};
  for (const standing of advancingThirdRows) advancingThirds[teamGroup[standing.team]] = standing.team;
  const advancingThirdGroups = Object.keys(advancingThirds).sort();
  return {
    winners,
    runnersUp,
    thirdPlaced,
    advancingThirds,
    advancingThirdGroups,
    thirdPlaceKey: advancingThirdGroups.join(""),
    rankedGroups,
    bestThirdRanked,
  };
}

function sampleSingleGroupOutcome(fixtures: Fixture[], seed: number): GroupOutcome {
  return sampleSingleGroupOutcomeWithRng(fixtures, createRng(seed));
}

function winnerGroupFromSlot(slot: string) {
  return slot.match(/^Winner Group ([A-L])$/)?.[1] ?? null;
}

function runnerGroupFromSlot(slot: string) {
  return slot.match(/^Runner-up Group ([A-L])$/)?.[1] ?? null;
}

function resolveR32Slot(slot: string, outcome: GroupOutcome, mapping: AnnexCMappingRow, errors: string[]) {
  const winnerGroup = winnerGroupFromSlot(slot);
  if (winnerGroup) return { team: outcome.winners[winnerGroup], group: winnerGroup, thirdPlaceSlotKey: null, thirdPlaceSourceGroup: null };
  const runnerGroup = runnerGroupFromSlot(slot);
  if (runnerGroup)
    return { team: outcome.runnersUp[runnerGroup], group: runnerGroup, thirdPlaceSlotKey: null, thirdPlaceSourceGroup: null };
  if (slot.startsWith("3rd Group ")) {
    errors.push(`Cannot resolve third-place slot without winner context: ${slot}`);
    return { team: "", group: "", thirdPlaceSlotKey: null, thirdPlaceSourceGroup: null };
  }
  errors.push(`Unsupported R32 slot: ${slot}`);
  return { team: "", group: "", thirdPlaceSlotKey: null, thirdPlaceSourceGroup: null };
}

function buildR32Bracket(outcome: GroupOutcome, annexC: ReturnType<typeof loadAnnexC>, errors: string[]) {
  const mapping = annexC.mappings[outcome.thirdPlaceKey];
  if (!mapping) {
    errors.push(`No Annex C mapping for third-place key ${outcome.thirdPlaceKey}`);
    return { mapping: null, matches: [] as R32Match[] };
  }

  const matches = r32FixedPairings.map((pairing) => {
    const home = resolveR32Slot(pairing.home_slot, outcome, mapping, errors);
    let away: ReturnType<typeof resolveR32Slot>;
    let thirdPlaceSlotKey: string | null = null;
    let thirdPlaceSourceGroup: string | null = null;
    if (pairing.away_slot.startsWith("3rd Group ")) {
      const homeWinnerGroup = winnerGroupFromSlot(pairing.home_slot);
      thirdPlaceSlotKey = homeWinnerGroup ? `1${homeWinnerGroup}` : null;
      thirdPlaceSourceGroup = thirdPlaceSlotKey ? mapping.third_place_slot_assignments[thirdPlaceSlotKey] : null;
      if (!thirdPlaceSourceGroup) {
        errors.push(`Missing Annex C slot ${thirdPlaceSlotKey ?? "unknown"} for match ${pairing.match_number}`);
        away = { team: "", group: "", thirdPlaceSlotKey, thirdPlaceSourceGroup };
      } else {
        away = {
          team: outcome.advancingThirds[thirdPlaceSourceGroup],
          group: thirdPlaceSourceGroup,
          thirdPlaceSlotKey,
          thirdPlaceSourceGroup,
        };
      }
    } else {
      away = resolveR32Slot(pairing.away_slot, outcome, mapping, errors);
    }
    return {
      match_number: pairing.match_number,
      home_slot: pairing.home_slot,
      away_slot: pairing.away_slot,
      home_team: home.team,
      away_team: away.team,
      home_group: home.group,
      away_group: away.group,
      third_place_slot_key: thirdPlaceSlotKey,
      third_place_source_group: thirdPlaceSourceGroup,
    };
  });
  return { mapping, matches };
}

function teamPathFromR32Match(matchNumber: number) {
  const pathMatches = [matchNumber];
  let current = matchNumber;
  const treeRows = [
    ...fixedBracketTree.round_of_16,
    ...fixedBracketTree.quarterfinals,
    ...fixedBracketTree.semifinals,
    ...fixedBracketTree.final,
  ];
  while (current !== 104) {
    const next = treeRows.find((row) => row.home_slot === `Winner Match ${current}` || row.away_slot === `Winner Match ${current}`);
    if (!next) break;
    pathMatches.push(next.match_number);
    current = next.match_number;
  }
  return pathMatches;
}

function validateR32Bracket(outcome: GroupOutcome, matches: R32Match[]) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const teams = matches.flatMap((match) => [match.home_team, match.away_team]).filter(Boolean);
  const uniqueTeams = new Set(teams);
  if (matches.length !== 16) errors.push(`R32 match count ${matches.length} != 16`);
  if (teams.length !== 32) errors.push(`R32 team placements ${teams.length} != 32`);
  if (uniqueTeams.size !== 32) errors.push(`R32 distinct teams ${uniqueTeams.size} != 32`);
  const expectedTeams = new Set([
    ...Object.values(outcome.winners),
    ...Object.values(outcome.runnersUp),
    ...Object.values(outcome.advancingThirds),
  ]);
  const missing = [...expectedTeams].filter((team) => !uniqueTeams.has(team));
  const extra = [...uniqueTeams].filter((team) => !expectedTeams.has(team));
  if (missing.length > 0) errors.push(`qualifying teams missing from R32: ${missing.join(",")}`);
  if (extra.length > 0) errors.push(`non-qualifying teams placed in R32: ${extra.join(",")}`);
  const thirdMatches = matches.filter((match) => match.third_place_slot_key);
  if (thirdMatches.length !== 8) errors.push(`third-place R32 slots ${thirdMatches.length} != 8`);
  for (const match of thirdMatches) {
    if (!match.third_place_source_group || outcome.advancingThirds[match.third_place_source_group] !== match.away_team) {
      errors.push(`third-place slot mismatch in match ${match.match_number}`);
    }
  }

  const paths: Record<string, number[]> = {};
  for (const match of matches) {
    paths[match.home_team] = teamPathFromR32Match(match.match_number);
    paths[match.away_team] = teamPathFromR32Match(match.match_number);
    if (match.home_group === match.away_group) errors.push(`same-group teams meet in R32 match ${match.match_number}`);
  }
  const earlySameGroupMeetings: { group: string; team_a: string; team_b: string; earliest_common_match: number }[] = [];
  for (const groupCode of Object.keys(groups)) {
    const groupQualifiers = groups[groupCode].filter((team) => paths[team]);
    for (let i = 0; i < groupQualifiers.length; i += 1) {
      for (let j = i + 1; j < groupQualifiers.length; j += 1) {
        const a = groupQualifiers[i];
        const b = groupQualifiers[j];
        const common = paths[a].find((matchNumber) => paths[b].includes(matchNumber));
        if (common && common < 97) earlySameGroupMeetings.push({ group: groupCode, team_a: a, team_b: b, earliest_common_match: common });
      }
    }
  }
  if (earlySameGroupMeetings.length > 0) {
    errors.push(
      `same-group teams can meet before QF: ${earlySameGroupMeetings
        .map((row) => `${row.group}:${row.team_a}-${row.team_b}@${row.earliest_common_match}`)
        .join("; ")}`,
    );
  }
  return {
    well_formed: errors.length === 0,
    match_count: matches.length,
    placed_team_count: teams.length,
    distinct_team_count: uniqueTeams.size,
    third_place_slot_count: thirdMatches.length,
    same_group_earliest_meeting_check: earlySameGroupMeetings.length === 0,
    early_same_group_meetings: earlySameGroupMeetings,
    errors,
    warnings,
  };
}

function eloWinProbability(teamA: string, teamB: string, eloRatings: Record<string, number>, errors: string[]) {
  const eloA = eloRatings[teamA];
  const eloB = eloRatings[teamB];
  if (!Number.isFinite(eloA) || !Number.isFinite(eloB)) {
    errors.push(`missing Elo rating for knockout pairing ${teamA}-${teamB}`);
    return 0.5;
  }
  return 1 / (1 + Math.pow(10, (eloB - eloA) / 400));
}

function simulateKnockoutMatch(
  homeTeam: string,
  awayTeam: string,
  eloRatings: Record<string, number>,
  rng: () => number,
  errors: string[],
) {
  const pHome = eloWinProbability(homeTeam, awayTeam, eloRatings, errors);
  return rng() < pHome ? { winner: homeTeam, loser: awayTeam, p_home_win: pHome } : { winner: awayTeam, loser: homeTeam, p_home_win: pHome };
}

function winnerMatchNumber(slot: string) {
  return Number(slot.match(/^Winner Match (\d+)$/)?.[1] ?? NaN);
}

function loserMatchNumber(slot: string) {
  return Number(slot.match(/^Loser Match (\d+)$/)?.[1] ?? NaN);
}

function simulateFullTournament(
  fixtures: Fixture[],
  annexC: ReturnType<typeof loadAnnexC>,
  eloRatings: Record<string, number>,
  simulations: number,
  seed: number,
  errors: string[],
) {
  const rng = createRng(seed);
  const counts: Record<
    string,
    {
      r32: number;
      r16: number;
      qf: number;
      sf: number;
      final: number;
      champion: number;
      third_place_match: number;
      third_place_winner: number;
    }
  > = {};
  for (const team of allTeams) {
    counts[team] = {
      r32: 0,
      r16: 0,
      qf: 0,
      sf: 0,
      final: 0,
      champion: 0,
      third_place_match: 0,
      third_place_winner: 0,
    };
  }

  let malformedBracketIterations = 0;
  const annexCKeyCounts: Record<string, number> = {};

  for (let iteration = 0; iteration < simulations; iteration += 1) {
    const outcome = sampleSingleGroupOutcomeWithRng(fixtures, rng);
    annexCKeyCounts[outcome.thirdPlaceKey] = (annexCKeyCounts[outcome.thirdPlaceKey] ?? 0) + 1;
    const localErrors: string[] = [];
    const bracket = buildR32Bracket(outcome, annexC, localErrors);
    const validation = validateR32Bracket(outcome, bracket.matches);
    if (!validation.well_formed || localErrors.length > 0) {
      malformedBracketIterations += 1;
      if (malformedBracketIterations <= 5) {
        errors.push(`malformed bracket iteration ${iteration}: ${[...validation.errors, ...localErrors].join("; ")}`);
      }
      continue;
    }

    const winners: Record<number, string> = {};
    const losers: Record<number, string> = {};
    for (const match of bracket.matches) {
      counts[match.home_team].r32 += 1;
      counts[match.away_team].r32 += 1;
      const result = simulateKnockoutMatch(match.home_team, match.away_team, eloRatings, rng, errors);
      winners[match.match_number] = result.winner;
      losers[match.match_number] = result.loser;
      counts[result.winner].r16 += 1;
    }

    for (const match of fixedBracketTree.round_of_16) {
      const home = winners[winnerMatchNumber(match.home_slot)];
      const away = winners[winnerMatchNumber(match.away_slot)];
      const result = simulateKnockoutMatch(home, away, eloRatings, rng, errors);
      winners[match.match_number] = result.winner;
      losers[match.match_number] = result.loser;
      counts[result.winner].qf += 1;
    }

    for (const match of fixedBracketTree.quarterfinals) {
      const home = winners[winnerMatchNumber(match.home_slot)];
      const away = winners[winnerMatchNumber(match.away_slot)];
      const result = simulateKnockoutMatch(home, away, eloRatings, rng, errors);
      winners[match.match_number] = result.winner;
      losers[match.match_number] = result.loser;
      counts[result.winner].sf += 1;
    }

    for (const match of fixedBracketTree.semifinals) {
      const home = winners[winnerMatchNumber(match.home_slot)];
      const away = winners[winnerMatchNumber(match.away_slot)];
      const result = simulateKnockoutMatch(home, away, eloRatings, rng, errors);
      winners[match.match_number] = result.winner;
      losers[match.match_number] = result.loser;
      counts[result.winner].final += 1;
      counts[result.loser].third_place_match += 1;
    }

    for (const match of fixedBracketTree.third_place) {
      const home = losers[loserMatchNumber(match.home_slot)];
      const away = losers[loserMatchNumber(match.away_slot)];
      const result = simulateKnockoutMatch(home, away, eloRatings, rng, errors);
      winners[match.match_number] = result.winner;
      losers[match.match_number] = result.loser;
      counts[result.winner].third_place_winner += 1;
    }

    for (const match of fixedBracketTree.final) {
      const home = winners[winnerMatchNumber(match.home_slot)];
      const away = winners[winnerMatchNumber(match.away_slot)];
      const result = simulateKnockoutMatch(home, away, eloRatings, rng, errors);
      winners[match.match_number] = result.winner;
      losers[match.match_number] = result.loser;
      counts[result.winner].champion += 1;
    }
  }

  const round = (value: number) => Number(value.toFixed(6));
  const rows = allTeams
    .map((team) => ({
      team_code: team,
      group_code: teamGroup[team],
      elo_rating: eloRatings[team] ?? null,
      reach_r32_probability: round(counts[team].r32 / simulations),
      reach_r16_probability: round(counts[team].r16 / simulations),
      reach_qf_probability: round(counts[team].qf / simulations),
      reach_sf_probability: round(counts[team].sf / simulations),
      reach_final_probability: round(counts[team].final / simulations),
      champion_probability: round(counts[team].champion / simulations),
      third_place_match_probability: round(counts[team].third_place_match / simulations),
      finish_third_probability: round(counts[team].third_place_winner / simulations),
    }))
    .sort((left, right) => right.champion_probability - left.champion_probability || right.reach_final_probability - left.reach_final_probability);

  return {
    rows,
    malformedBracketIterations,
    annexCKeyCounts,
    rawCounts: counts,
  };
}

function roundSum(rows: { [key: string]: unknown }[], key: string) {
  return Number(rows.reduce((sum, row) => sum + Number(row[key] ?? 0), 0).toFixed(6));
}

function bracketPathForSeed(matchNumber: number) {
  const path = teamPathFromR32Match(matchNumber);
  const semifinal = path.find((entry) => entry === 101 || entry === 102) ?? null;
  return { r32_match: matchNumber, path, semifinal };
}

async function main() {
  const args = parseArgs();
  if (args.execute && !args.fullTournamentKnockoutDryRun) {
    throw new Error("Execute is only enabled for the approved full-tournament knockout candidate persistence path.");
  }

  const config = await readDbConfig();
  const errors: string[] = [];
  const warnings: string[] = [];

  const protectedCountsBefore = one<Record<string, number>>(config, `
    select
      (select count(*) from prediction_runs) prediction_runs,
      (select count(*) from match_predictions) match_predictions,
      (select count(*) from model_candidates) model_candidates,
      (select count(*) from tournament_simulation_runs) tournament_simulation_runs,
      (select count(*) from tournament_simulation_team_results) tournament_simulation_team_results,
      (select count(*) from tournament_simulation_fixture_scorelines) tournament_simulation_fixture_scorelines
  `);

  const fixtureMetadataCount = one<{ count: number }>(config, `
    select count(*)::int
    from fixture_metadata
    where tournament_code = 'WC_2026'
      and source_provider = 'api-football'
  `)?.count ?? null;

  const standingsRows = one<{ count: number }>(config, `
    select count(*)::int
    from wc2026_group_standings
  `)?.count ?? null;

  const duplicateResults = queryJson<{ result_pair: string; count: number }>(config, `
    select least(team_a_code, team_b_code) || '|' || greatest(team_a_code, team_b_code) result_pair, count(*)::int
    from match_results
    where tournament_code = 'WC_2026'
      and match_status = 'finished'
    group by 1
    having count(*) > 1
  `);

  const actualResults = queryJson<ActualResult>(config, `
    select fixture_label, team_a_code, team_b_code, team_a_goals::int, team_b_goals::int,
      match_status, source_payload_hash, api_football_fixture_id
    from match_results
    where tournament_code = 'WC_2026'
      and match_status = 'finished'
    order by fixture_label
  `);

  const actualsByPair = new Map<string, ActualResult[]>();
  for (const actual of actualResults) {
    if (actual.team_a_goals === null || actual.team_b_goals === null) {
      errors.push(`finished result ${actual.fixture_label} has null score`);
      continue;
    }
    const key = fixtureResultKey(actual.team_a_code, actual.team_b_code);
    actualsByPair.set(key, [...(actualsByPair.get(key) ?? []), actual]);
  }

  const rawPredictionRows = queryJson<any>(config, `
    select fixture_label, team_a_code a, team_b_code b,
      team_a_win_probability::float8 pa,
      draw_probability::float8 pd,
      team_b_win_probability::float8 pb,
      (scoreline_probabilities->>'lambda_a')::float8 la,
      (scoreline_probabilities->>'lambda_b')::float8 lb
    from match_predictions
    where prediction_run_id = '${sourcePredictionRunId}'
    order by fixture_label
  `);

  if (rawPredictionRows.length !== expectedGroupFixtureCount) {
    errors.push(`expected ${expectedGroupFixtureCount} source fixture probabilities, found ${rawPredictionRows.length}`);
  }

  const fixtures: Fixture[] = rawPredictionRows.map((row) => {
    const pa = num(row.pa);
    const pd = num(row.pd);
    const pb = num(row.pb);
    const probabilitySum = pa + pd + pb;
    if (Math.abs(probabilitySum - 1) > 0.005) {
      errors.push(`probability sum for ${row.fixture_label} is ${probabilitySum.toFixed(6)}`);
    }
    if (!teamGroup[row.a] || teamGroup[row.a] !== teamGroup[row.b]) {
      errors.push(`fixture ${row.fixture_label} does not map to one known group: ${row.a}-${row.b}`);
    }
    if (row.la === null || row.lb === null) {
      errors.push(`fixture ${row.fixture_label} missing scoreline lambda input`);
    }
    const distributions = conditionalDistributions(num(row.la), num(row.lb));
    return {
      label: row.fixture_label,
      a: row.a,
      b: row.b,
      group: teamGroup[row.a],
      pa,
      pd,
      pb,
      condA: distributions.winsA,
      condD: distributions.draws,
      condB: distributions.winsB,
      cA: distributions.cA,
      cD: distributions.cD,
      cB: distributions.cB,
    };
  });

  if (args.r32ConstructionDryRun) {
    const annexC = loadAnnexC();
    const exampleSeeds = [args.seed, args.seed + 101, args.seed + 202, args.seed + 303];
    const examples = exampleSeeds.map((seed, index) => {
      const localErrors: string[] = [];
      const outcome = sampleSingleGroupOutcome(fixtures, seed);
      const bracket = buildR32Bracket(outcome, annexC, localErrors);
      const validation = validateR32Bracket(outcome, bracket.matches);
      return {
        example_number: index + 1,
        seed,
        third_place_key: outcome.thirdPlaceKey,
        annex_c_combination_number: bracket.mapping?.combination_number ?? null,
        advancing_third_groups: outcome.advancingThirdGroups,
        winners: outcome.winners,
        runners_up: outcome.runnersUp,
        advancing_thirds: outcome.advancingThirds,
        annex_c_slot_assignments: bracket.mapping?.third_place_slot_assignments ?? null,
        r32_matches: bracket.matches,
        validation: {
          ...validation,
          constructor_errors: localErrors,
          well_formed: validation.well_formed && localErrors.length === 0,
        },
      };
    });

    const allExampleRows = examples.flatMap((example) =>
      example.r32_matches.map((match) => ({
        example_number: example.example_number,
        seed: example.seed,
        third_place_key: example.third_place_key,
        annex_c_combination_number: example.annex_c_combination_number,
        match_number: match.match_number,
        home_slot: match.home_slot,
        home_team: match.home_team,
        home_group: match.home_group,
        away_slot: match.away_slot,
        away_team: match.away_team,
        away_group: match.away_group,
        third_place_slot_key: match.third_place_slot_key,
        third_place_source_group: match.third_place_source_group,
      })),
    );
    const allValid = examples.every((example) => example.validation.well_formed);
    if (!allValid) errors.push("one or more R32 construction examples failed validation");

    const protectedCountsAfter = one<Record<string, number>>(config, `
      select
        (select count(*) from prediction_runs) prediction_runs,
        (select count(*) from match_predictions) match_predictions,
        (select count(*) from model_candidates) model_candidates,
        (select count(*) from tournament_simulation_runs) tournament_simulation_runs,
        (select count(*) from tournament_simulation_team_results) tournament_simulation_team_results,
        (select count(*) from tournament_simulation_fixture_scorelines) tournament_simulation_fixture_scorelines
    `);

    const examplesPath = path.join(auditDir, "r32-bracket-construction-phase-2-examples.json");
    const bracketCsvPath = path.join(auditDir, "r32-bracket-construction-phase-2-brackets.csv");
    const summaryPath = path.join(auditDir, "r32-bracket-construction-phase-2-summary.json");
    const reportPath = path.join(docsDir, "r32-bracket-construction-phase-2-dry-run.md");
    writeFileSync(examplesPath, `${JSON.stringify(examples, null, 2)}\n`, "utf8");
    writeCsv(bracketCsvPath, allExampleRows);
    const summary = {
      dry_run: true,
      execute: false,
      task: "r32_bracket_construction_phase_2_dry_run",
      source_prediction_run_id: sourcePredictionRunId,
      annex_c_lookup_path: "data/external/fifa/annex-c-r32-third-place-mapping.json",
      annex_c_combination_count: Object.keys(annexC.mappings).length,
      slot_keys_read_as_stored: annexC.slotOrder,
      examples_checked: examples.length,
      example_keys: examples.map((example) => ({
        example_number: example.example_number,
        seed: example.seed,
        third_place_key: example.third_place_key,
        combination_number: example.annex_c_combination_number,
        well_formed: example.validation.well_formed,
      })),
      fixed_r32_pairings: r32FixedPairings,
      fixed_bracket_tree: fixedBracketTree,
      validation: {
        all_examples_well_formed: allValid,
        every_example_has_32_distinct_teams: examples.every((example) => example.validation.distinct_team_count === 32),
        every_example_has_16_matchups: examples.every((example) => example.validation.match_count === 16),
        every_example_has_8_third_place_slots: examples.every((example) => example.validation.third_place_slot_count === 8),
        same_group_earliest_meeting_qf_or_later: examples.every(
          (example) => example.validation.same_group_earliest_meeting_check,
        ),
      },
      protected_counts: {
        before: protectedCountsBefore,
        after: protectedCountsAfter,
        unchanged: JSON.stringify(protectedCountsBefore) === JSON.stringify(protectedCountsAfter),
      },
      db_writes: 0,
      prediction_writes: 0,
      match_prediction_writes: 0,
      model_writes: 0,
      monte_carlo_writes: 0,
      current_best_changed: false,
      odds_used: false,
      api_football_predictions_endpoint_used: false,
      output_files_written: [
        "docs/r32-bracket-construction-phase-2-dry-run.md",
        "data/audits/r32-bracket-construction-phase-2-examples.json",
        "data/audits/r32-bracket-construction-phase-2-brackets.csv",
        "data/audits/r32-bracket-construction-phase-2-summary.json",
        "scripts/worldcup/live-group-stage-bracket-resimulation-consumer.ts",
      ],
      recommendation: allValid && errors.length === 0 ? "approve_phase_3_knockout_simulation_dry_run" : "fix_r32_construction_validation_errors",
      errors,
      warnings,
    };
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

    const exampleSections = examples
      .map((example) => {
        const rows = example.r32_matches
          .map(
            (match) =>
              `| ${match.match_number} | ${match.home_slot} | ${match.home_team} | ${match.away_slot} | ${match.away_team} | ${match.third_place_slot_key ?? ""} | ${match.third_place_source_group ?? ""} |`,
          )
          .join("\n");
        return `### Example ${example.example_number}\n\nSeed: \`${example.seed}\`\n\nThird-place key: \`${example.third_place_key}\` / Annex C combination \`${example.annex_c_combination_number}\`\n\nAdvancing thirds: ${Object.entries(
          example.advancing_thirds,
        )
          .map(([groupCode, team]) => `${groupCode}:${team}`)
          .join(", ")}\n\nValidation: \`${example.validation.well_formed ? "pass" : "fail"}\`\n\n| Match | Home slot | Home team | Away slot | Away team | Annex C slot | Third source group |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows}`;
      })
      .join("\n\n");

    const treeRows = [
      ...fixedBracketTree.round_of_16.map((row) => ({ round: "R16", ...row })),
      ...fixedBracketTree.quarterfinals.map((row) => ({ round: "QF", ...row })),
      ...fixedBracketTree.semifinals.map((row) => ({ round: "SF", ...row })),
      ...fixedBracketTree.third_place.map((row) => ({ round: "Third place", ...row })),
      ...fixedBracketTree.final.map((row) => ({ round: "Final", ...row })),
    ]
      .map((row) => `| ${row.round} | ${row.match_number} | ${row.home_slot} | ${row.away_slot} |`)
      .join("\n");

    const report = `# R32 Bracket Construction Phase 2 Dry-Run

## Executive Summary

Phase 2 built the Round of 32 constructor from the verified Annex C lookup and validated four deterministic sampled group outcomes. This is bracket construction only: no knockout match simulation, no Monte Carlo aggregation, no database writes, no prediction writes, no odds, and no API-Football predictions endpoint.

## Inputs

- Annex C lookup: \`data/external/fifa/annex-c-r32-third-place-mapping.json\`
- Source prediction run for sampled group-outcome examples: \`${sourcePredictionRunId}\`
- Group fixtures expected/found: ${expectedGroupFixtureCount}/${fixtures.length}
- Slot keys read as stored: \`${annexC.slotOrder.join(", ")}\`

## Fixed Bracket Tree

| Round | Match | Home slot | Away slot |
| --- | --- | --- | --- |
${treeRows}

## Validation Summary

| Check | Result |
| --- | --- |
| Annex C combinations available | ${Object.keys(annexC.mappings).length} |
| Examples checked | ${examples.length} |
| Every example has 16 R32 matchups | ${summary.validation.every_example_has_16_matchups} |
| Every example has 32 distinct teams | ${summary.validation.every_example_has_32_distinct_teams} |
| Every example has eight third-place slots | ${summary.validation.every_example_has_8_third_place_slots} |
| Same-group teams cannot meet before QF | ${summary.validation.same_group_earliest_meeting_qf_or_later} |
| Protected counts unchanged | ${summary.protected_counts.unchanged} |

## Example Brackets

${exampleSections}

## Guardrails

- Dry-run only.
- Synthetic or sampled group outcomes were used in memory only.
- No tournament_simulation_runs rows inserted.
- No tournament_simulation_team_results rows inserted.
- No match_predictions or prediction_runs changed.
- No model/current-best change.
- No odds or API-Football predictions endpoint.

## Recommendation

\`${summary.recommendation}\`
`;
    writeFileSync(reportPath, report, "utf8");
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (args.fullTournamentKnockoutDryRun) {
    if (args.simulations < 10000) errors.push(`Phase 3 requires N>=10000; received ${args.simulations}`);
    const annexC = loadAnnexC();
    const teamRows = queryJson<{ fifa_code: string; name: string; id: string }>(config, `
      select fifa_code, name, id::text
      from teams
      where fifa_code = any(array[${allTeams.map((team) => `'${team}'`).join(",")}])
      order by fifa_code
    `);
    const teamNames = Object.fromEntries(teamRows.map((team) => [team.fifa_code, team.name]));
    const teamIds = Object.fromEntries(teamRows.map((team) => [team.fifa_code, team.id]));
    const eloRows = queryJson<{ fifa_code: string; elo_rating: number }>(config, `
      with wc as (
        select fifa_code, lower(name) nm
        from teams
        where fifa_code = any(array[${allTeams.map((team) => `'${team}'`).join(",")}])
      ),
      idm as (
        select w.fifa_code,
          (
            select m.id
            from national_team_identity_map m
            where m.fifa_code = w.fifa_code
              or lower(m.canonical_name) = w.nm
              or lower(m.elo_name) = w.nm
              or exists (
                select 1
                from jsonb_array_elements_text(case when jsonb_typeof(m.aliases) = 'array' then m.aliases else '[]'::jsonb end) a
                where lower(a) = w.nm
              )
            order by (m.fifa_code = w.fifa_code) desc nulls last
            limit 1
          ) identity_map_id
        from wc w
      )
      select i.fifa_code,
        (
          select e.elo_rating::float8
          from team_elo_history e
          where e.identity_map_id = i.identity_map_id
            ${args.eloSourceTag
              ? `and e.source_provider = '${args.eloSourceTag}'`
              : `and e.rating_date < date '2026-06-11'`}
          order by e.rating_date desc
          limit 1
        ) elo_rating
      from idm i
      order by i.fifa_code
    `);
    // --elo-source-tag set -> read the LEARNED end-of-group snapshot by tag (date filter relaxed; learned rows are
    // dated >= 2026-06-11). No tag -> UNCHANGED: latest frozen pre-tournament Elo (rating_date < 2026-06-11).
    const eloRatings: Record<string, number> = {};
    for (const row of eloRows) eloRatings[row.fifa_code] = num(row.elo_rating);
    const missingElo = allTeams.filter((team) => !Number.isFinite(eloRatings[team]));
    if (missingElo.length > 0) errors.push(`missing Elo ratings for: ${missingElo.join(",")}`);

    const fullTournament = simulateFullTournament(fixtures, annexC, eloRatings, args.simulations, args.seed, errors);
    const rows = fullTournament.rows.map((row) => ({
      ...row,
      team_name: teamNames[row.team_code] ?? row.team_code,
      team_id: teamIds[row.team_code] ?? null,
    }));
    const sumChecks = {
      reach_r32: roundSum(rows, "reach_r32_probability"),
      reach_r16: roundSum(rows, "reach_r16_probability"),
      reach_qf: roundSum(rows, "reach_qf_probability"),
      reach_sf: roundSum(rows, "reach_sf_probability"),
      reach_final: roundSum(rows, "reach_final_probability"),
      champion: roundSum(rows, "champion_probability"),
    };
    const sumCheckPass =
      Math.abs(sumChecks.reach_r32 - 32) <= 0.01 &&
      Math.abs(sumChecks.reach_r16 - 16) <= 0.01 &&
      Math.abs(sumChecks.reach_qf - 8) <= 0.01 &&
      Math.abs(sumChecks.reach_sf - 4) <= 0.01 &&
      Math.abs(sumChecks.reach_final - 2) <= 0.01 &&
      Math.abs(sumChecks.champion - 1) <= 0.01;
    if (!sumCheckPass) errors.push(`full-tournament probability sums failed: ${JSON.stringify(sumChecks)}`);

    const topChampion = rows[0];
    const championMagnitudeFlag =
      Number(topChampion?.champion_probability ?? 0) < 0.06
        ? "top_champion_probability_below_6_percent_compounding_underconfidence"
        : "top_champion_probability_at_or_above_6_percent";
    const strongestByElo = ["ESP", "ARG", "FRA", "ENG", "BRA"];
    const titleRanks = new Map(rows.map((row, index) => [row.team_code, index + 1]));
    const strongestTeamTitleRanks = strongestByElo.map((team) => ({
      team_code: team,
      elo_rating: eloRatings[team],
      title_rank: titleRanks.get(team) ?? null,
      champion_probability: rows.find((row) => row.team_code === team)?.champion_probability ?? null,
    }));
    const strongestAllTopTen = strongestTeamTitleRanks.every((row) => Number(row.title_rank ?? 99) <= 10);
    if (!strongestAllTopTen) warnings.push("one or more strongest-by-Elo teams is outside the top 10 title odds");

    const seedSeparation = {
      esp_as_group_g_winner: bracketPathForSeed(82),
      arg_as_group_j_winner: bracketPathForSeed(86),
      opposite_semifinal_halves: bracketPathForSeed(82).semifinal !== bracketPathForSeed(86).semifinal,
      note: "Structural check assumes Spain wins Group G and Argentina wins Group J.",
    };
    if (!seedSeparation.opposite_semifinal_halves) errors.push("Spain/Argentina top-seed structural semifinal separation failed");

    // When reading a learned Elo tag, the run is a DISTINCT candidate (separate model_version + dedup key) so it never
    // collides with the frozen-Elo run; re-running on the same learned Elo is idempotent (reuses the same row).
    const eloTagSuffix = args.eloSourceTag ? `-elo-${args.eloSourceTag}` : "";
    const fullKnockoutModelVersion = (isAltSourceRun ? "tournament-monte-carlo-full-knockout-dynamic-draw-candidate" : "tournament-monte-carlo-full-knockout-v1") + eloTagSuffix;
    const fullKnockoutScope = "full-tournament-knockout";
    const twoPhaseModelNote =
      "Group-stage matches use v1.3 softened model (temperature 1.5, draw floor 0.25). Knockout matches use neutral Elo head-to-head P = 1/(1+10^((elo_b-elo_a)/400)), no draw, no temperature softening. The two tournament phases intentionally use different per-match probability models - groups softened, knockouts sharp - because knockouts have no draw outcome. This is by design, not an inconsistency.";
    const dryRunCandidateRunKey = sha256({
      model_version: "full-tournament-knockout-v0.1-dry-run",
      source_prediction_run_id: sourcePredictionRunId,
      elo_source_tag: args.eloSourceTag ?? null,
      annex_c_lookup_path: "data/external/fifa/annex-c-r32-third-place-mapping.json",
      simulations: args.simulations,
      seed: args.seed,
      sumChecks,
      topChampion: topChampion?.team_code,
    }).slice(0, 32);
    let newCandidateSimRunId: string | null = null;
    let insertedSimulationRuns = 0;
    let insertedTeamResults = 0;
    let idempotentExistingRun = false;

    if (args.execute) {
      if (errors.length > 0) throw new Error(`Aborting execute: ${errors.join("; ")}`);
      const existingRuns = queryJson<{ id: string; team_result_count: number }>(config, `
        select r.id::text,
          (select count(*)::int from tournament_simulation_team_results tr where tr.simulation_run_id = r.id) team_result_count
        from tournament_simulation_runs r
        where r.simulation_model_version = '${fullKnockoutModelVersion}'
          and r.scope = '${fullKnockoutScope}'
          and r.source_snapshot->>'dry_run_candidate_run_key' = '${dryRunCandidateRunKey}'
        order by r.created_at desc
        limit 1
      `);
      if (existingRuns.length > 0) {
        newCandidateSimRunId = existingRuns[0].id;
        insertedSimulationRuns = 0;
        insertedTeamResults = 0;
        idempotentExistingRun = true;
        if (Number(existingRuns[0].team_result_count) !== 48) {
          errors.push(`existing full-knockout run ${newCandidateSimRunId} has ${existingRuns[0].team_result_count} team rows, expected 48`);
        }
      } else {
        const runRows = await restPost(
          config,
          "tournament_simulation_runs",
          [
            {
              prediction_run_id: sourcePredictionRunId,
              simulation_model_version: fullKnockoutModelVersion,
              scope: fullKnockoutScope,
              simulation_count: args.simulations,
              random_seed: String(args.seed),
              source_prediction_run_id: sourcePredictionRunId,
              source_match_prediction_count: expectedGroupFixtureCount,
              candidate_run: true,
              not_global_current_best: true,
              tiebreaker_fallback_count: 0,
              tiebreaker_fallback_rate: 0,
              poisson_goal_model_used: true,
              poisson_goal_model_note:
                "Group-stage scorelines use the existing conditional Poisson sampling from stored v1.3 W/D/L probabilities. Knockout matches are W/L only and do not use Poisson scorelines.",
              run_status: "candidate",
              source_snapshot: {
                dry_run_candidate_run_key: dryRunCandidateRunKey,
                model_family: "full-tournament-knockout",
                model_version_note: "Distinct from tournament-monte-carlo-all-groups-v1 group-stage-only run 0b7b5619-b4f3-4a77-b3ea-2dd0388ae183.",
                scope: "group-stage + R32 + R16 + QF + SF + final + third-place playoff",
                source_prediction_run_id: sourcePredictionRunId,
                annex_c_lookup_path: "data/external/fifa/annex-c-r32-third-place-mapping.json",
                annex_c_combination_count: Object.keys(annexC.mappings).length,
                group_stage_model: {
                  source: "stored v1.3 uncapped Elo-implied group probabilities",
                  temperature: 1.5,
                  draw_floor: 0.25,
                  sealed: true,
                },
                knockout_model: {
                  method: "direct_neutral_elo_win_probability",
                  formula: "P(team_a beats team_b) = 1 / (1 + 10^((elo_b - elo_a) / 400))",
                  draw_handling: "no draw outcome; no group W/D/L draw-mass redistribution",
                  temperature_softening: false,
                },
                two_phase_probability_model_note: twoPhaseModelNote,
                sum_checks: { ...sumChecks, pass: sumCheckPass },
                top_champion: {
                  team_code: topChampion?.team_code ?? null,
                  champion_probability: topChampion?.champion_probability ?? null,
                  magnitude_flag: championMagnitudeFlag,
                },
                strongest_team_title_ranks: strongestTeamTitleRanks,
                seed_separation_check: seedSeparation,
                malformed_bracket_iterations: fullTournament.malformedBracketIterations,
                annex_c_distinct_keys_sampled: Object.keys(fullTournament.annexCKeyCounts).length,
                candidate_run: true,
                not_global_current_best: true,
                current_best_changed: false,
                odds_used: false,
                api_football_predictions_endpoint_used: false,
              },
            },
          ],
          true,
        );
        newCandidateSimRunId = runRows[0].id;
        insertedSimulationRuns = 1;
        const teamResultRows = rows.map((row) => ({
          simulation_run_id: newCandidateSimRunId,
          team_id: row.team_id,
          team_code: row.team_code,
          team_name: row.team_name,
          group_code: row.group_code,
          finish_1st_probability: null,
          finish_2nd_probability: null,
          finish_3rd_probability: null,
          finish_4th_probability: null,
          win_group_probability: null,
          advance_top_2_probability: null,
          reach_round_of_32_probability: row.reach_r32_probability,
          reach_round_of_16_probability: row.reach_r16_probability,
          reach_quarterfinal_probability: row.reach_qf_probability,
          reach_semifinal_probability: row.reach_sf_probability,
          reach_final_probability: row.reach_final_probability,
          champion_probability: row.champion_probability,
          source_snapshot: {
            dry_run_candidate_run_key: dryRunCandidateRunKey,
            simulation_model_version: fullKnockoutModelVersion,
            source_prediction_run_id: sourcePredictionRunId,
            elo_rating: row.elo_rating,
            third_place_match_probability: row.third_place_match_probability,
            third_place_winner_probability: row.finish_third_probability,
            two_phase_probability_model_note: twoPhaseModelNote,
            candidate_run: true,
            not_global_current_best: true,
          },
        }));
        const insertedRows = await restPost(config, "tournament_simulation_team_results", teamResultRows, true);
        insertedTeamResults = insertedRows.length;
      }
    }

    const protectedCountsAfter = one<Record<string, number>>(config, `
      select
        (select count(*) from prediction_runs) prediction_runs,
        (select count(*) from match_predictions) match_predictions,
        (select count(*) from model_candidates) model_candidates,
        (select count(*) from tournament_simulation_runs) tournament_simulation_runs,
        (select count(*) from tournament_simulation_team_results) tournament_simulation_team_results,
        (select count(*) from tournament_simulation_fixture_scorelines) tournament_simulation_fixture_scorelines
    `);

    const phase3ModeLabel = args.execute ? "Execution" : "Dry-Run";
    const probabilitiesRelPath = args.execute
      ? "data/audits/full-tournament-knockout-phase-3-team-results-inserted.csv"
      : "data/audits/full-tournament-knockout-phase-3-probabilities.csv";
    const summaryRelPath = args.execute
      ? "data/audits/full-tournament-knockout-phase-3-execution-summary.json"
      : "data/audits/full-tournament-knockout-phase-3-summary.json";
    const reportRelPath = args.execute
      ? "docs/full-tournament-knockout-phase-3-execution.md"
      : "docs/full-tournament-knockout-phase-3-dry-run.md";
    const probabilitiesPath = path.join(rootDir, probabilitiesRelPath);
    const summaryPath = path.join(rootDir, summaryRelPath);
    const reportPath = path.join(rootDir, reportRelPath);
    const topRows = rows.slice(0, 12);
    writeCsv(
      probabilitiesPath,
      rows.map((row) => ({
        team_code: row.team_code,
        team_name: row.team_name,
        group_code: row.group_code,
        elo_rating: row.elo_rating,
        reach_r32_probability: row.reach_r32_probability,
        reach_r16_probability: row.reach_r16_probability,
        reach_qf_probability: row.reach_qf_probability,
        reach_sf_probability: row.reach_sf_probability,
        reach_final_probability: row.reach_final_probability,
        champion_probability: row.champion_probability,
        third_place_match_probability: row.third_place_match_probability,
        finish_third_probability: row.finish_third_probability,
      })),
    );

    const summary = {
      dry_run: !args.execute,
      execute: args.execute,
      task: args.execute
        ? "execute_full_tournament_knockout_simulation_phase_3_candidate"
        : "full_tournament_knockout_simulation_phase_3_dry_run",
      target_project_ref: worldCupProjectRef,
      source_prediction_run_id: sourcePredictionRunId,
      annex_c_lookup_path: "data/external/fifa/annex-c-r32-third-place-mapping.json",
      simulation_model_version: fullKnockoutModelVersion,
      scope: fullKnockoutScope,
      simulation_iterations: args.simulations,
      seed: args.seed,
      knockout_probability_method: {
        method: "direct_neutral_elo_win_probability",
        formula: "P(team_a beats team_b) = 1 / (1 + 10^((elo_b - elo_a) / 400))",
        draw_handling: "knockouts are W/L only; no group W/D/L draw mass redistribution used",
        elo_source: args.eloSourceTag
          ? `team_elo_history latest WHERE source_provider='${args.eloSourceTag}' (LEARNED end-of-group K=60 snapshot; date filter relaxed)`
          : "team_elo_history latest rating_date < 2026-06-11 (FROZEN pre-tournament snapshot; default, unchanged)",
        elo_source_tag: args.eloSourceTag ?? null,
      },
      dry_run_candidate_run_key: dryRunCandidateRunKey,
      new_candidate_sim_run_id: newCandidateSimRunId,
      new_candidate_sim_run_id_note: args.execute
        ? "Persisted candidate run id."
        : "Dry-run only. A real tournament_simulation_runs.id is created only after execute approval.",
      idempotent_existing_run: idempotentExistingRun,
      inserted_simulation_runs: insertedSimulationRuns,
      inserted_team_results: insertedTeamResults,
      would_insert_simulation_run: !args.execute,
      would_insert_team_results: args.execute ? 0 : 48,
      two_phase_probability_model_note: twoPhaseModelNote,
      full_tournament_probabilities_csv: probabilitiesRelPath,
      sum_checks: {
        ...sumChecks,
        pass: sumCheckPass,
      },
      top_champion: {
        team_code: topChampion?.team_code ?? null,
        champion_probability: topChampion?.champion_probability ?? null,
        flag: championMagnitudeFlag,
      },
      strongest_team_title_ranks: strongestTeamTitleRanks,
      strongest_elo_teams_all_top_10_title_odds: strongestAllTopTen,
      top_12_title_odds: topRows.map((row) => ({
        team_code: row.team_code,
        elo_rating: row.elo_rating,
        champion_probability: row.champion_probability,
        reach_final_probability: row.reach_final_probability,
      })),
      seed_separation_check: seedSeparation,
      malformed_bracket_iterations: fullTournament.malformedBracketIterations,
      annex_c_distinct_keys_sampled: Object.keys(fullTournament.annexCKeyCounts).length,
      protected_counts: {
        before: protectedCountsBefore,
        after: protectedCountsAfter,
        unchanged_except_expected_full_knockout_inserts:
          protectedCountsAfter.prediction_runs === protectedCountsBefore.prediction_runs &&
          protectedCountsAfter.match_predictions === protectedCountsBefore.match_predictions &&
          protectedCountsAfter.model_candidates === protectedCountsBefore.model_candidates &&
          protectedCountsAfter.tournament_simulation_fixture_scorelines === protectedCountsBefore.tournament_simulation_fixture_scorelines &&
          protectedCountsAfter.tournament_simulation_runs === protectedCountsBefore.tournament_simulation_runs + insertedSimulationRuns &&
          protectedCountsAfter.tournament_simulation_team_results === protectedCountsBefore.tournament_simulation_team_results + insertedTeamResults,
      },
      db_writes: insertedSimulationRuns + insertedTeamResults,
      tournament_simulation_runs_written: insertedSimulationRuns,
      tournament_simulation_team_results_written: insertedTeamResults,
      prediction_writes: 0,
      match_prediction_writes: 0,
      model_writes: 0,
      monte_carlo_writes: 0,
      current_best_changed: false,
      odds_used: false,
      api_football_predictions_endpoint_used: false,
      output_files_written: [
        reportRelPath,
        probabilitiesRelPath,
        summaryRelPath,
        "scripts/worldcup/live-group-stage-bracket-resimulation-consumer.ts",
      ],
      recommendation: args.execute
        ? "full_tournament_knockout_candidate_persisted"
        : errors.length === 0
          ? "approve_phase_3_execute_candidate_sim_run"
          : "fix_full_tournament_dry_run_errors",
      errors,
      warnings,
    };
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

    const topTable = topRows
      .map(
        (row, index) =>
          `| ${index + 1} | ${row.team_code} | ${row.elo_rating} | ${row.reach_r32_probability} | ${row.reach_r16_probability} | ${row.reach_qf_probability} | ${row.reach_sf_probability} | ${row.reach_final_probability} | ${row.champion_probability} |`,
      )
      .join("\n");
    const strongestTable = strongestTeamTitleRanks
      .map((row) => `| ${row.team_code} | ${row.elo_rating} | ${row.title_rank} | ${row.champion_probability} |`)
      .join("\n");
    const report = `# Full-Tournament Knockout Simulation Phase 3 ${phase3ModeLabel}

## Executive Summary

Phase 3 extended the validated group-stage Monte Carlo through the full knockout bracket. Each iteration samples the group stage, constructs the Round of 32 through the verified Annex C lookup, and simulates R32, R16, quarterfinals, semifinals, the third-place playoff, and final.

Mode: \`${phase3ModeLabel}\`

Persisted candidate run id: \`${newCandidateSimRunId ?? "not persisted"}\`

Database rows written: \`${insertedSimulationRuns + insertedTeamResults}\` (${insertedSimulationRuns} simulation run, ${insertedTeamResults} team-result rows)

Current-best changed: \`false\`

## Inputs

- Target project ref: \`${worldCupProjectRef}\`
- Source prediction run: \`${sourcePredictionRunId}\`
- Annex C lookup: \`data/external/fifa/annex-c-r32-third-place-mapping.json\`
- Simulation iterations: ${args.simulations}
- Seed: ${args.seed}

## Knockout Probability Method

Knockouts are W/L only. This run does not redistribute group-stage draw mass. For every knockout pairing, it uses direct neutral Elo:

\`P(team_a beats team_b) = 1 / (1 + 10^((elo_b - elo_a) / 400))\`

The Elo source is \`team_elo_history\`, latest \`rating_date < 2026-06-11\`, the same point-in-time Elo snapshot used by the v1.3 group model.

Two-phase model note: ${twoPhaseModelNote}

## Probability Sums

| Sum | Expected | Actual |
| --- | ---: | ---: |
| Reach R32 | 32 | ${sumChecks.reach_r32} |
| Reach R16 | 16 | ${sumChecks.reach_r16} |
| Reach QF | 8 | ${sumChecks.reach_qf} |
| Reach SF | 4 | ${sumChecks.reach_sf} |
| Reach final | 2 | ${sumChecks.reach_final} |
| Champion | 1 | ${sumChecks.champion} |

Pass: \`${sumCheckPass}\`

## Top Title Odds

| Rank | Team | Elo | R32 | R16 | QF | SF | Final | Champion |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${topTable}

Top champion: \`${topChampion?.team_code ?? "n/a"}\` at \`${topChampion?.champion_probability ?? "n/a"}\`.

Champion magnitude flag: \`${championMagnitudeFlag}\`

## Strongest Elo Teams

| Team | Elo | Title rank | Champion probability |
| --- | ---: | ---: | ---: |
${strongestTable}

All strongest-by-Elo teams in top 10 title odds: \`${strongestAllTopTen}\`

## Top-Seed Separation

Assuming Spain wins Group G and Argentina wins Group J:

- Spain as W-G path: \`${seedSeparation.esp_as_group_g_winner.path.join(" -> ")}\`
- Argentina as W-J path: \`${seedSeparation.arg_as_group_j_winner.path.join(" -> ")}\`
- Opposite semifinal halves: \`${seedSeparation.opposite_semifinal_halves}\`

## Persistence

Model version: \`${fullKnockoutModelVersion}\`

Scope: \`${fullKnockoutScope}\`

Candidate run: \`true\`

Not global current-best: \`true\`

Dry-run candidate key: \`${dryRunCandidateRunKey}\`

Existing group-stage-only run \`0b7b5619-b4f3-4a77-b3ea-2dd0388ae183\` was not overwritten.

## Guardrails

- DB writes limited to the new candidate simulation run and its 48 team-result rows when execute mode is used.
- No prediction or match_prediction writes.
- No model/current-best change.
- No odds endpoint.
- No API-Football predictions endpoint.
- v1.3 group probabilities remain sealed.

Recommendation: \`${summary.recommendation}\`
`;
    writeFileSync(reportPath, report, "utf8");
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const originalRows = queryJson<any>(config, `
    select team_code,
      win_group_probability::float8 win_group_probability,
      advance_top_2_probability::float8 advance_top_2_probability,
      reach_round_of_32_probability::float8 reach_round_of_32_probability,
      finish_1st_probability::float8 finish_1st_probability,
      finish_2nd_probability::float8 finish_2nd_probability,
      finish_3rd_probability::float8 finish_3rd_probability,
      finish_4th_probability::float8 finish_4th_probability
    from tournament_simulation_team_results
    where simulation_run_id = '${originalSimulationRunId}'
    order by team_code
  `);

  if (originalRows.length !== 48) {
    errors.push(`expected 48 original simulation team rows, found ${originalRows.length}`);
  }

  const simulation = runSimulation(fixtures, actualsByPair, args.simulations, args.seed, errors);

  const originalByTeam = new Map(originalRows.map((row) => [row.team_code, row]));
  const comparisonRows = simulation.rows
    .map((row) => {
      const original = originalByTeam.get(row.team_code);
      const originalAdvance = original ? num(original.reach_round_of_32_probability) : null;
      const originalTop2 = original ? num(original.advance_top_2_probability) : null;
      const originalWinGroup = original ? num(original.win_group_probability) : null;
      const advanceDelta = originalAdvance === null ? null : round4(row.reach_round_of_32_probability - originalAdvance);
      return {
        team_code: row.team_code,
        group_code: row.group_code,
        dry_run_advance_probability: row.reach_round_of_32_probability,
        original_advance_probability: originalAdvance,
        advance_delta: advanceDelta,
        dry_run_top_2_probability: row.advance_top_2_probability,
        original_top_2_probability: originalTop2,
        top_2_delta: originalTop2 === null ? null : round4(row.advance_top_2_probability - originalTop2),
        dry_run_win_group_probability: row.win_group_probability,
        original_win_group_probability: originalWinGroup,
        win_group_delta: originalWinGroup === null ? null : round4(row.win_group_probability - originalWinGroup),
      };
    })
    .sort((left, right) => Math.abs(Number(right.advance_delta ?? 0)) - Math.abs(Number(left.advance_delta ?? 0)));

  const deltas = comparisonRows.map((row) => Math.abs(Number(row.advance_delta ?? 0)));
  const maxAdvanceDelta = deltas.length ? round4(Math.max(...deltas)) : null;
  const avgAdvanceDelta = deltas.length ? round4(deltas.reduce((sum, value) => sum + value, 0) / deltas.length) : null;
  const equivalencePassed =
    actualResults.length === 0 &&
    maxAdvanceDelta !== null &&
    maxAdvanceDelta <= equivalenceTolerance &&
    errors.length === 0;

  const sumAdvance = round4(simulation.rows.reduce((sum, row) => sum + row.reach_round_of_32_probability, 0));
  const sumTop2 = round4(simulation.rows.reduce((sum, row) => sum + row.advance_top_2_probability, 0));
  const sumBestThird = round4(simulation.rows.reduce((sum, row) => sum + row.advance_best_third_probability, 0));
  if (Math.abs(sumAdvance - 32) > 0.05) errors.push(`sum advance ${sumAdvance} is not approximately 32`);
  if (duplicateResults.length > 0) errors.push(`duplicate finished result pairs found: ${duplicateResults.length}`);

  const resultStateHash = sha256(
    actualResults.map((row) => ({
      fixture_label: row.fixture_label,
      team_a_code: row.team_a_code,
      team_b_code: row.team_b_code,
      team_a_goals: row.team_a_goals,
      team_b_goals: row.team_b_goals,
      source_payload_hash: row.source_payload_hash,
    })),
  );

  mkdirSync(auditDir, { recursive: true });
  mkdirSync(docsDir, { recursive: true });

  const outputCsvRows = simulation.rows.map((row) => ({
    team_code: row.team_code,
    group_code: row.group_code,
    win_group_probability: row.win_group_probability,
    advance_top_2_probability: row.advance_top_2_probability,
    advance_best_third_probability: row.advance_best_third_probability,
    reach_round_of_32_probability: row.reach_round_of_32_probability,
    eliminated_group_stage_probability: row.eliminated_group_stage_probability,
    actual_locked_fixtures: simulation.actualLockedFixtures,
    sampled_fixtures: simulation.sampledFixtures,
  }));

  const preTournamentOutputPath = path.join(auditDir, "live-bracket-resimulation-pre-tournament-output.csv");
  const comparisonPath = path.join(auditDir, "live-bracket-resimulation-original-run-comparison.csv");
  const summaryPath = path.join(auditDir, "live-bracket-resimulation-consumer-summary.json");
  const reportPath = path.join(docsDir, "live-group-stage-bracket-resimulation-consumer-dry-run.md");

  writeCsv(preTournamentOutputPath, outputCsvRows);
  writeCsv(comparisonPath, comparisonRows);

  const protectedCountsAfter = one<Record<string, number>>(config, `
    select
      (select count(*) from prediction_runs) prediction_runs,
      (select count(*) from match_predictions) match_predictions,
      (select count(*) from model_candidates) model_candidates,
      (select count(*) from tournament_simulation_runs) tournament_simulation_runs,
      (select count(*) from tournament_simulation_team_results) tournament_simulation_team_results,
      (select count(*) from tournament_simulation_fixture_scorelines) tournament_simulation_fixture_scorelines
  `);

  const protectedUnchanged = JSON.stringify(protectedCountsBefore) === JSON.stringify(protectedCountsAfter);
  if (!protectedUnchanged) errors.push("protected simulation/prediction counts changed during dry-run");

  const summary = {
    dry_run: true,
    execute: false,
    task: "live_group_stage_bracket_resimulation_consumer_dry_run",
    target_project_ref: config.projectRef,
    group_fixtures_expected: expectedGroupFixtureCount,
    fixture_metadata_group_fixtures_found: fixtureMetadataCount,
    finished_fixtures_found: actualResults.length,
    unfinished_fixtures_found: expectedGroupFixtureCount - actualResults.length,
    actual_result_source_table: "match_results",
    standings_source_table: "wc2026_group_standings",
    standings_rows_found: standingsRows,
    duplicate_finished_result_pairs: duplicateResults.length,
    sampled_fixtures: simulation.sampledFixtures,
    actual_locked_fixtures: simulation.actualLockedFixtures,
    source_prediction_run_id: sourcePredictionRunId,
    original_simulation_run_compared: originalSimulationRunId,
    simulation_iterations: args.simulations,
    seed: args.seed,
    result_state_hash: resultStateHash,
    pre_tournament_equivalence_test_passed: equivalencePassed,
    max_advance_probability_delta_vs_original: maxAdvanceDelta,
    avg_advance_probability_delta_vs_original: avgAdvanceDelta,
    largest_deltas: comparisonRows.slice(0, 8),
    probability_sums: {
      advance: sumAdvance,
      top_2: sumTop2,
      best_third: sumBestThird,
      simulated_draw_rate_sampled_only: simulation.simulatedDrawRate,
      tiebreaker_fallback_rate_iterations: simulation.tiebreakerFallbackRate,
    },
    future_execute_design: {
      would_insert_simulation_run: true,
      would_insert_team_results: 48,
      would_insert_scoreline_rows: 0,
      run_metadata: {
        candidate_run: true,
        not_global_current_best: true,
        result_state_hash: resultStateHash,
        finished_fixture_count: actualResults.length,
        sampled_fixture_count: simulation.sampledFixtures,
        source_prediction_run_id: sourcePredictionRunId,
        source_result_table: "match_results",
        simulation_count: args.simulations,
        seed: args.seed,
        scope: "all-groups-group-stage",
        knockouts: false,
      },
    },
    output_files_written: [
      "docs/live-group-stage-bracket-resimulation-consumer-dry-run.md",
      "data/audits/live-bracket-resimulation-pre-tournament-output.csv",
      "data/audits/live-bracket-resimulation-original-run-comparison.csv",
      "data/audits/live-bracket-resimulation-consumer-summary.json",
      "scripts/worldcup/live-group-stage-bracket-resimulation-consumer.ts",
      "docs/worldcup-project-index.md",
    ],
    protected_counts: { before: protectedCountsBefore, after: protectedCountsAfter, unchanged: protectedUnchanged },
    db_writes: 0,
    prediction_writes: 0,
    match_prediction_writes: 0,
    model_writes: 0,
    monte_carlo_writes: 0,
    current_best_changed: false,
    odds_used: false,
    api_football_predictions_endpoint_used: false,
    recommendation:
      equivalencePassed && errors.length === 0
        ? "approve_future_execute_after_first_finished_fixture_or_keep_as_dry_run_until_tournament_start"
        : "review_equivalence_or_input_errors_before_execute",
    errors,
    warnings,
  };

  if (args.syntheticLockTest) {
    const scenarios = [
      {
        name: "scenario_1_mexico_3_0_south_africa",
        title: "Scenario 1 - Mexico 3-0 South Africa",
        affectedGroups: ["A"],
        syntheticResults: [syntheticActual("MEX", "RSA", 3, 0, "synthetic-group-a-mex-rsa-3-0")],
      },
      {
        name: "scenario_2_south_africa_2_0_mexico",
        title: "Scenario 2 - South Africa 2-0 Mexico",
        affectedGroups: ["A"],
        syntheticResults: [syntheticActual("RSA", "MEX", 2, 0, "synthetic-group-a-rsa-mex-2-0")],
      },
      {
        name: "scenario_3_full_group_b_locked",
        title: "Scenario 3 - Full Group B Locked",
        affectedGroups: ["B"],
        syntheticResults: [
          syntheticActual("CAN", "BIH", 2, 1, "synthetic-group-b-can-bih-2-1"),
          syntheticActual("SUI", "QAT", 2, 0, "synthetic-group-b-sui-qat-2-0"),
          syntheticActual("SUI", "BIH", 1, 0, "synthetic-group-b-sui-bih-1-0"),
          syntheticActual("CAN", "QAT", 2, 0, "synthetic-group-b-can-qat-2-0"),
          syntheticActual("SUI", "CAN", 2, 1, "synthetic-group-b-sui-can-2-1"),
          syntheticActual("BIH", "QAT", 1, 0, "synthetic-group-b-bih-qat-1-0"),
        ],
      },
    ];

    const allSyntheticComparisonRows: Record<string, unknown>[] = [];
    const scenarioSummaries: any[] = [];
    const baselineByTeam = rowByTeam(simulation.rows);

    for (const scenario of scenarios) {
      const scenarioErrors: string[] = [];
      const scenarioSimulation = runSimulation(
        fixtures,
        actualMapFromRows(scenario.syntheticResults),
        args.simulations,
        args.seed,
        scenarioErrors,
      );
      if (scenarioErrors.length > 0) warnings.push(`${scenario.name} errors: ${scenarioErrors.join("; ")}`);

      const scenarioRows = scenarioComparisonRows(scenario.name, scenario.affectedGroups, scenarioSimulation.rows, simulation.rows);
      allSyntheticComparisonRows.push(...scenarioRows);
      const scenarioSumAdvance = round4(
        scenarioSimulation.rows.reduce((sum, row) => sum + row.reach_round_of_32_probability, 0),
      );
      const scenarioSumTop2 = round4(
        scenarioSimulation.rows.reduce((sum, row) => sum + row.advance_top_2_probability, 0),
      );
      const scenarioSumWinGroup = round4(
        scenarioSimulation.rows.reduce((sum, row) => sum + row.win_group_probability, 0),
      );
      const scenarioVerdict = buildSyntheticVerdict(
        scenario.name,
        scenario.affectedGroups,
        scenarioRows,
        scenarioSumAdvance,
        scenarioSumTop2,
        scenarioSumWinGroup,
      );
      scenarioSummaries.push({
        ...scenarioVerdict,
        title: scenario.title,
        synthetic_results: scenario.syntheticResults.map((row) => ({
          team_a_code: row.team_a_code,
          team_b_code: row.team_b_code,
          team_a_goals: row.team_a_goals,
          team_b_goals: row.team_b_goals,
        })),
        actual_locked_fixtures: scenarioSimulation.actualLockedFixtures,
        sampled_fixtures: scenarioSimulation.sampledFixtures,
      });
    }

    const scenario1 = scenarioSummaries.find((scenario) => scenario.scenario === "scenario_1_mexico_3_0_south_africa");
    const scenario2 = scenarioSummaries.find((scenario) => scenario.scenario === "scenario_2_south_africa_2_0_mexico");
    const scenario3 = scenarioSummaries.find((scenario) => scenario.scenario === "scenario_3_full_group_b_locked");
    const s1Rows = rowByTeam(scenario1?.affected_group_rows ?? []);
    const s2Rows = rowByTeam(scenario2?.affected_group_rows ?? []);
    const s3Rows = rowByTeam(scenario3?.affected_group_rows ?? []);
    const scenario1MexDelta = Number(s1Rows.get("MEX")?.advance_delta ?? 0);
    const scenario1RsaDelta = Number(s1Rows.get("RSA")?.advance_delta ?? 0);
    const scenario2MexDelta = Number(s2Rows.get("MEX")?.advance_delta ?? 0);
    const scenario2RsaDelta = Number(s2Rows.get("RSA")?.advance_delta ?? 0);
    const scenario1MexRsaMovement = round4(Math.abs(scenario1MexDelta) + Math.abs(scenario1RsaDelta));
    const scenario2MexRsaMovement = round4(Math.abs(scenario2MexDelta) + Math.abs(scenario2RsaDelta));
    const directionChecks = {
      scenario_1_mex_advance_rises: scenario1MexDelta > 0,
      scenario_1_rsa_advance_falls: scenario1RsaDelta < 0,
      scenario_2_rsa_advance_rises: scenario2RsaDelta > 0,
      scenario_2_mex_advance_falls: scenario2MexDelta < 0,
      scenario_2_upset_moves_mex_rsa_more_than_scenario_1:
        scenario2MexRsaMovement > scenario1MexRsaMovement,
      scenario_3_sui_can_near_certain_advance:
        Number(s3Rows.get("SUI")?.synthetic_advance_probability ?? 0) >= 0.995 &&
        Number(s3Rows.get("CAN")?.synthetic_advance_probability ?? 0) >= 0.995,
      scenario_3_group_b_locked_top2_order:
        Number(s3Rows.get("SUI")?.synthetic_top_2_probability ?? 0) >= 0.999 &&
        Number(s3Rows.get("CAN")?.synthetic_top_2_probability ?? 0) >= 0.999,
    };
    const syntheticVerdict =
      Object.values(directionChecks).every(Boolean) &&
      scenarioSummaries.every((scenario) => scenario.sum_checks.hold) &&
      scenarioSummaries.every((scenario) => scenario.non_affected_group_internal_probabilities_unchanged)
        ? "pass_lock_logic_direction_internal_isolation_and_invariants"
        : "review_synthetic_lock_test_results";

    const syntheticCsvPath = path.join(auditDir, "live-bracket-resimulation-synthetic-lock-test.csv");
    const syntheticSummaryPath = path.join(auditDir, "live-bracket-resimulation-synthetic-lock-test-summary.json");
    const syntheticReportPath = path.join(docsDir, "live-bracket-resimulation-synthetic-lock-test.md");
    writeCsv(syntheticCsvPath, allSyntheticComparisonRows);

    const syntheticSummary = {
      dry_run: true,
      execute: false,
      task: "live_group_stage_bracket_resimulation_synthetic_lock_test",
      synthetic_results_persisted: false,
      db_writes: 0,
      source_prediction_run_id: sourcePredictionRunId,
      original_simulation_run_compared: originalSimulationRunId,
      simulations: args.simulations,
      seed: args.seed,
      direction_checks: directionChecks,
      scenario_movement: {
        scenario_1_mex_rsa_abs_advance_movement: scenario1MexRsaMovement,
        scenario_2_mex_rsa_abs_advance_movement: scenario2MexRsaMovement,
      },
      scenarios: scenarioSummaries,
      verdict: syntheticVerdict,
      caveat:
        "Non-affected groups have unchanged win-group/top-two probabilities. Overall advancement can move through the legitimate global best-third pool when an affected group's third-place profile changes.",
      output_files_written: [
        "docs/live-bracket-resimulation-synthetic-lock-test.md",
        "data/audits/live-bracket-resimulation-synthetic-lock-test.csv",
        "data/audits/live-bracket-resimulation-synthetic-lock-test-summary.json",
      ],
      errors: [],
      warnings: [],
    };
    writeFileSync(syntheticSummaryPath, `${JSON.stringify(syntheticSummary, null, 2)}\n`, "utf8");

    const markdownTable = (rows: any[]) =>
      [
        "| Team | Baseline advance | Synthetic advance | Advance delta | Baseline top-2 | Synthetic top-2 | Top-2 delta | Baseline best-third | Synthetic best-third | Best-third delta |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
        ...rows.map(
          (row) =>
            `| ${row.team_code} | ${row.baseline_advance_probability} | ${row.synthetic_advance_probability} | ${row.advance_delta} | ${row.baseline_top_2_probability} | ${row.synthetic_top_2_probability} | ${row.top_2_delta} | ${row.baseline_best_third_probability} | ${row.synthetic_best_third_probability} | ${row.best_third_delta} |`,
        ),
      ].join("\n");

    const syntheticReport = `# Live Bracket Re-Simulation Synthetic Lock Test

## Executive Summary

Synthetic finished results were injected in memory only and never persisted. The consumer locked those synthetic scores, sampled the remaining fixtures from stored v1.3 probabilities, and preserved tournament invariants.

Verdict: \`${syntheticVerdict}\`

Important rule note: non-affected groups should have unchanged win-group and top-two probabilities. Their overall advancement probability may move slightly because the best-eight-third-place pool is global across all 12 groups.

## Scenario 1 - Mexico 3-0 South Africa

${markdownTable(scenario1?.affected_group_rows ?? [])}

- MEX advance rises: ${directionChecks.scenario_1_mex_advance_rises}
- RSA advance falls: ${directionChecks.scenario_1_rsa_advance_falls}
- Non-affected win-group max delta: ${scenario1?.max_unaffected_win_group_delta}
- Non-affected top-two max delta: ${scenario1?.max_unaffected_top_2_delta}
- Non-affected overall-advance max delta: ${scenario1?.max_unaffected_advance_delta}
- Sum checks: advance ${scenario1?.sum_checks.advance}, top-two ${scenario1?.sum_checks.top_2}, win-group ${scenario1?.sum_checks.win_group}

## Scenario 2 - South Africa 2-0 Mexico

${markdownTable(scenario2?.affected_group_rows ?? [])}

- RSA advance rises: ${directionChecks.scenario_2_rsa_advance_rises}
- MEX advance falls: ${directionChecks.scenario_2_mex_advance_falls}
- MEX/RSA movement vs scenario 1: ${scenario2MexRsaMovement} vs ${scenario1MexRsaMovement}
- Non-affected win-group max delta: ${scenario2?.max_unaffected_win_group_delta}
- Non-affected top-two max delta: ${scenario2?.max_unaffected_top_2_delta}
- Non-affected overall-advance max delta: ${scenario2?.max_unaffected_advance_delta}
- Sum checks: advance ${scenario2?.sum_checks.advance}, top-two ${scenario2?.sum_checks.top_2}, win-group ${scenario2?.sum_checks.win_group}

## Scenario 3 - Full Group B Locked

Locked scores:

- CAN 2-1 BIH
- SUI 2-0 QAT
- SUI 1-0 BIH
- CAN 2-0 QAT
- SUI 2-1 CAN
- BIH 1-0 QAT

${markdownTable(scenario3?.affected_group_rows ?? [])}

- SUI and CAN near-certain advance: ${directionChecks.scenario_3_sui_can_near_certain_advance}
- SUI/CAN top-two locked near 1: ${directionChecks.scenario_3_group_b_locked_top2_order}
- Non-affected win-group max delta: ${scenario3?.max_unaffected_win_group_delta}
- Non-affected top-two max delta: ${scenario3?.max_unaffected_top_2_delta}
- Non-affected overall-advance max delta: ${scenario3?.max_unaffected_advance_delta}
- Sum checks: advance ${scenario3?.sum_checks.advance}, top-two ${scenario3?.sum_checks.top_2}, win-group ${scenario3?.sum_checks.win_group}

## Guardrails

- DB writes: 0
- Synthetic results persisted: false
- \`match_results\` inserts: 0
- \`tournament_simulation_runs\` inserts: 0
- Prediction/model/current-best changes: 0
- Odds used: false
- API-Football predictions endpoint used: false
`;
    writeFileSync(syntheticReportPath, syntheticReport, "utf8");
    (summary as any).synthetic_lock_test = syntheticSummary;
    summary.output_files_written.push(
      "docs/live-bracket-resimulation-synthetic-lock-test.md",
      "data/audits/live-bracket-resimulation-synthetic-lock-test.csv",
      "data/audits/live-bracket-resimulation-synthetic-lock-test-summary.json",
    );
  }

  if (args.syntheticStressTest) {
    const stressScenarios = [
      {
        name: "scenario_a_draws",
        title: "Scenario A - Draws",
        affectedGroups: ["E", "I"],
        syntheticResults: [
          syntheticActual("GER", "ECU", 1, 1, "synthetic-group-e-ger-ecu-1-1"),
          syntheticActual("FRA", "NOR", 0, 0, "synthetic-group-i-fra-nor-0-0"),
        ],
        notes: "Two draws in separate groups test draw scoring and modest table movement.",
      },
      {
        name: "scenario_b_group_g_upset_cascade",
        title: "Scenario B - Group G Upset Cascade",
        affectedGroups: ["G"],
        syntheticResults: [
          syntheticActual("KSA", "ESP", 2, 1, "synthetic-group-g-ksa-esp-2-1"),
          syntheticActual("CPV", "ESP", 2, 0, "synthetic-group-g-cpv-esp-2-0"),
          syntheticActual("KSA", "URU", 1, 0, "synthetic-group-g-ksa-uru-1-0"),
          syntheticActual("KSA", "CPV", 1, 1, "synthetic-group-g-ksa-cpv-1-1"),
          syntheticActual("URU", "ESP", 1, 1, "synthetic-group-g-uru-esp-1-1"),
          syntheticActual("CPV", "URU", 0, 0, "synthetic-group-g-cpv-uru-0-0"),
        ],
        notes: "KSA wins Group G, CPV finishes second, URU is third on two points, and ESP is fourth.",
      },
      {
        name: "scenario_c_qat_two_heavy_losses",
        title: "Scenario C - QAT Two Heavy Losses",
        affectedGroups: ["B"],
        syntheticResults: [
          syntheticActual("SUI", "QAT", 5, 0, "synthetic-group-b-sui-qat-5-0"),
          syntheticActual("CAN", "QAT", 5, 0, "synthetic-group-b-can-qat-5-0"),
        ],
        notes:
          "Two heavy losses make QAT nearly eliminated, but the format can still leave residual best-third life if QAT wins the remaining sampled fixture.",
      },
      {
        name: "scenario_d_mixed_matchday",
        title: "Scenario D - Mixed Realistic Matchday",
        affectedGroups: ["A", "D", "H", "K"],
        syntheticResults: [
          syntheticActual("MEX", "RSA", 2, 0, "synthetic-group-a-mex-rsa-2-0"),
          syntheticActual("KOR", "CZE", 1, 1, "synthetic-group-a-kor-cze-1-1"),
          syntheticActual("MEX", "KOR", 1, 1, "synthetic-group-a-mex-kor-1-1"),
          syntheticActual("BRA", "HAI", 2, 1, "synthetic-group-d-bra-hai-2-1"),
          syntheticActual("MAR", "SCO", 1, 0, "synthetic-group-d-mar-sco-1-0"),
          syntheticActual("BRA", "MAR", 1, 1, "synthetic-group-d-bra-mar-1-1"),
          syntheticActual("BEL", "NZL", 2, 0, "synthetic-group-h-bel-nzl-2-0"),
          syntheticActual("EGY", "IRN", 1, 1, "synthetic-group-h-egy-irn-1-1"),
          syntheticActual("BEL", "EGY", 1, 0, "synthetic-group-h-bel-egy-1-0"),
          syntheticActual("COL", "COD", 2, 0, "synthetic-group-k-col-cod-2-0"),
          syntheticActual("POR", "UZB", 1, 1, "synthetic-group-k-por-uzb-1-1"),
          syntheticActual("POR", "COD", 2, 0, "synthetic-group-k-por-cod-2-0"),
        ],
        notes: "Twelve fixtures across four groups approximate a real partial tournament state.",
      },
    ];

    const stressComparisonRows: Record<string, unknown>[] = [];
    const stressScenarioSummaries: any[] = [];

    for (const scenario of stressScenarios) {
      const scenarioErrors: string[] = [];
      const scenarioSimulation = runSimulation(
        fixtures,
        actualMapFromRows(scenario.syntheticResults),
        args.simulations,
        args.seed,
        scenarioErrors,
      );
      if (scenarioErrors.length > 0) warnings.push(`${scenario.name} errors: ${scenarioErrors.join("; ")}`);
      const scenarioRows = scenarioComparisonRows(scenario.name, scenario.affectedGroups, scenarioSimulation.rows, simulation.rows);
      stressComparisonRows.push(...scenarioRows);

      const scenarioSumAdvance = round4(
        scenarioSimulation.rows.reduce((sumValue, row) => sumValue + row.reach_round_of_32_probability, 0),
      );
      const scenarioSumTop2 = round4(
        scenarioSimulation.rows.reduce((sumValue, row) => sumValue + row.advance_top_2_probability, 0),
      );
      const scenarioSumWinGroup = round4(
        scenarioSimulation.rows.reduce((sumValue, row) => sumValue + row.win_group_probability, 0),
      );
      const scenarioVerdict = buildSyntheticVerdict(
        scenario.name,
        scenario.affectedGroups,
        scenarioRows,
        scenarioSumAdvance,
        scenarioSumTop2,
        scenarioSumWinGroup,
      );
      const biggestBestThirdShifts = [...scenarioRows]
        .sort((left, right) => Math.abs(Number(right.best_third_delta ?? 0)) - Math.abs(Number(left.best_third_delta ?? 0)))
        .slice(0, 12);
      const outsideAffectedBestThirdShifts = biggestBestThirdShifts.filter((row) => !scenario.affectedGroups.includes(String(row.group_code)));
      stressScenarioSummaries.push({
        ...scenarioVerdict,
        title: scenario.title,
        notes: scenario.notes,
        synthetic_results: scenario.syntheticResults.map((row) => ({
          team_a_code: row.team_a_code,
          team_b_code: row.team_b_code,
          team_a_goals: row.team_a_goals,
          team_b_goals: row.team_b_goals,
        })),
        actual_locked_fixtures: scenarioSimulation.actualLockedFixtures,
        sampled_fixtures: scenarioSimulation.sampledFixtures,
        biggest_best_third_shifts: biggestBestThirdShifts,
        outside_affected_best_third_shifts: outsideAffectedBestThirdShifts,
      });
    }

    const getScenario = (name: string) => stressScenarioSummaries.find((scenario) => scenario.scenario === name);
    const scenarioA = getScenario("scenario_a_draws");
    const scenarioB = getScenario("scenario_b_group_g_upset_cascade");
    const scenarioC = getScenario("scenario_c_qat_two_heavy_losses");
    const scenarioD = getScenario("scenario_d_mixed_matchday");
    const aRows = rowByTeam(scenarioA?.affected_group_rows ?? []);
    const bRows = rowByTeam(scenarioB?.affected_group_rows ?? []);
    const cRows = rowByTeam(scenarioC?.affected_group_rows ?? []);
    const dRows = rowByTeam(scenarioD?.affected_group_rows ?? []);

    const scenarioADrawDeltas = ["GER", "ECU", "FRA", "NOR"].map((team) => Number(aRows.get(team)?.advance_delta ?? 0));
    const scenarioChecks = {
      scenario_a_draws_have_modest_movement: maxAbs(scenarioADrawDeltas) < 0.2,
      scenario_a_invariants_hold: Boolean(scenarioA?.sum_checks.hold),
      scenario_b_esp_collapses: Number(bRows.get("ESP")?.synthetic_advance_probability ?? 1) <= 0.05,
      scenario_b_ksa_wins_group_near_certain: Number(bRows.get("KSA")?.synthetic_win_group_probability ?? 0) >= 0.999,
      scenario_b_cpv_qualifies_near_certain: Number(bRows.get("CPV")?.synthetic_advance_probability ?? 0) >= 0.999,
      scenario_b_third_pool_re_resolves: (scenarioB?.outside_affected_best_third_shifts?.length ?? 0) > 0,
      scenario_c_qat_near_eliminated: Number(cRows.get("QAT")?.synthetic_advance_probability ?? 1) <= 0.05,
      scenario_c_qat_residual_is_best_third_only:
        Number(cRows.get("QAT")?.synthetic_top_2_probability ?? 1) <= 0.001 &&
        Number(cRows.get("QAT")?.synthetic_best_third_probability ?? 1) <= 0.05,
      scenario_d_invariants_hold: Boolean(scenarioD?.sum_checks.hold),
      scenario_d_group_local_win_top2_isolation:
        Boolean(scenarioD?.non_affected_group_internal_probabilities_unchanged),
    };

    const stressVerdict =
      Object.values(scenarioChecks).every(Boolean) &&
      stressScenarioSummaries.every((scenario) => scenario.sum_checks.hold) &&
      stressScenarioSummaries.every((scenario) => scenario.non_affected_group_internal_probabilities_unchanged)
        ? "pass_stress_lock_logic_draws_upsets_elimination_third_pool_and_invariants"
        : "review_stress_lock_test_results";

    const stressCsvPath = path.join(auditDir, "live-bracket-resimulation-synthetic-stress-test.csv");
    const stressSummaryPath = path.join(auditDir, "live-bracket-resimulation-synthetic-stress-test-summary.json");
    const stressReportPath = path.join(docsDir, "live-bracket-resimulation-synthetic-stress-test.md");
    writeCsv(stressCsvPath, stressComparisonRows);

    const stressSummary = {
      dry_run: true,
      execute: false,
      task: "live_group_stage_bracket_resimulation_synthetic_stress_test",
      synthetic_results_persisted: false,
      db_writes: 0,
      source_prediction_run_id: sourcePredictionRunId,
      original_simulation_run_compared: originalSimulationRunId,
      simulations: args.simulations,
      seed: args.seed,
      scenario_checks: scenarioChecks,
      scenarios: stressScenarioSummaries,
      verdict: stressVerdict,
      caveat:
        "Win-group and top-two probabilities are group-local. Overall advancement and best-third probabilities legitimately move across groups through the global best-eight-third-place pool.",
      output_files_written: [
        "docs/live-bracket-resimulation-synthetic-stress-test.md",
        "data/audits/live-bracket-resimulation-synthetic-stress-test.csv",
        "data/audits/live-bracket-resimulation-synthetic-stress-test-summary.json",
      ],
      errors: [],
      warnings:
        scenarioChecks.scenario_c_qat_near_eliminated
          ? []
          : [
              "QAT two-loss scenario did not reach near-zero advancement; this can be legitimate in the 2026 format if a final sampled win can still produce a best-third path.",
            ],
    };
    writeFileSync(stressSummaryPath, `${JSON.stringify(stressSummary, null, 2)}\n`, "utf8");

    const markdownTable = (rows: any[]) =>
      [
        "| Team | Baseline advance | Synthetic advance | Advance delta | Baseline top-2 | Synthetic top-2 | Top-2 delta | Baseline best-third | Synthetic best-third | Best-third delta |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
        ...rows.map(
          (row) =>
            `| ${row.team_code} | ${row.baseline_advance_probability} | ${row.synthetic_advance_probability} | ${row.advance_delta} | ${row.baseline_top_2_probability} | ${row.synthetic_top_2_probability} | ${row.top_2_delta} | ${row.baseline_best_third_probability} | ${row.synthetic_best_third_probability} | ${row.best_third_delta} |`,
        ),
      ].join("\n");
    const bestThirdTable = (rows: any[]) =>
      [
        "| Team | Group | Baseline best-third | Synthetic best-third | Delta | Baseline advance | Synthetic advance |",
        "|---|---|---:|---:|---:|---:|---:|",
        ...rows.map(
          (row) =>
            `| ${row.team_code} | ${row.group_code} | ${row.baseline_best_third_probability} | ${row.synthetic_best_third_probability} | ${row.best_third_delta} | ${row.baseline_advance_probability} | ${row.synthetic_advance_probability} |`,
        ),
      ].join("\n");

    const stressReport = `# Live Bracket Re-Simulation Synthetic Stress Test

## Executive Summary

Synthetic finished results were injected in memory only and never persisted. This second stress run tested draws, a full-group upset cascade, an early-elimination-like state, and a realistic mixed matchday.

Verdict: \`${stressVerdict}\`

The key isolation finding holds: non-affected groups have unchanged win-group and top-two probabilities. Overall advancement and best-third probabilities can move outside affected groups through the legitimate global best-eight-third-place pool.

## Scenario A - Draws

Locked scores: GER 1-1 ECU, FRA 0-0 NOR.

${markdownTable(scenarioA?.affected_group_rows ?? [])}

- Draw movement modest: ${scenarioChecks.scenario_a_draws_have_modest_movement}
- Sum checks: advance ${scenarioA?.sum_checks.advance}, top-two ${scenarioA?.sum_checks.top_2}, win-group ${scenarioA?.sum_checks.win_group}

## Scenario B - Group G Upset Cascade

Locked scores: KSA 2-1 ESP, CPV 2-0 ESP, KSA 1-0 URU, KSA 1-1 CPV, URU 1-1 ESP, CPV 0-0 URU.

${markdownTable(scenarioB?.affected_group_rows ?? [])}

Third-place pool movement:

${bestThirdTable(scenarioB?.biggest_best_third_shifts ?? [])}

- ESP collapses toward elimination: ${scenarioChecks.scenario_b_esp_collapses}
- KSA wins group near-certain: ${scenarioChecks.scenario_b_ksa_wins_group_near_certain}
- CPV qualifies near-certain: ${scenarioChecks.scenario_b_cpv_qualifies_near_certain}
- Third-place pool re-resolves outside Group G: ${scenarioChecks.scenario_b_third_pool_re_resolves}
- Sum checks: advance ${scenarioB?.sum_checks.advance}, top-two ${scenarioB?.sum_checks.top_2}, win-group ${scenarioB?.sum_checks.win_group}

## Scenario C - QAT Two Heavy Losses

Locked scores: SUI 5-0 QAT, CAN 5-0 QAT.

${markdownTable(scenarioC?.affected_group_rows ?? [])}

- QAT near eliminated: ${scenarioChecks.scenario_c_qat_near_eliminated}
- QAT residual, if any, is best-third only: ${scenarioChecks.scenario_c_qat_residual_is_best_third_only}
- Note: two losses are not strictly mathematical elimination in the 2026 format, because a final sampled win can still leave a third-place path.
- Sum checks: advance ${scenarioC?.sum_checks.advance}, top-two ${scenarioC?.sum_checks.top_2}, win-group ${scenarioC?.sum_checks.win_group}

## Scenario D - Mixed Realistic Matchday

Locked scores: MEX 2-0 RSA, KOR 1-1 CZE, MEX 1-1 KOR, BRA 2-1 HAI, MAR 1-0 SCO, BRA 1-1 MAR, BEL 2-0 NZL, EGY 1-1 IRN, BEL 1-0 EGY, COL 2-0 COD, POR 1-1 UZB, POR 2-0 COD.

${markdownTable(scenarioD?.affected_group_rows ?? [])}

Third-place pool movement:

${bestThirdTable(scenarioD?.biggest_best_third_shifts ?? [])}

- Group-local win/top-two isolation: ${scenarioChecks.scenario_d_group_local_win_top2_isolation}
- Sum checks: advance ${scenarioD?.sum_checks.advance}, top-two ${scenarioD?.sum_checks.top_2}, win-group ${scenarioD?.sum_checks.win_group}

## Guardrails

- DB writes: 0
- Synthetic results persisted: false
- \`match_results\` inserts: 0
- \`tournament_simulation_runs\` inserts: 0
- Prediction/model/current-best changes: 0
- Odds used: false
- API-Football predictions endpoint used: false
`;
    writeFileSync(stressReportPath, stressReport, "utf8");
    (summary as any).synthetic_stress_test = stressSummary;
    summary.output_files_written.push(
      "docs/live-bracket-resimulation-synthetic-stress-test.md",
      "data/audits/live-bracket-resimulation-synthetic-stress-test.csv",
      "data/audits/live-bracket-resimulation-synthetic-stress-test-summary.json",
    );
  }

  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  const report = `# Live Group-Stage Bracket Re-Simulation Consumer Dry-Run

## Executive Summary

Built a dry-run-only consumer for the result-ingestion spine. It reads finished WC2026 group fixtures from \`match_results\`, locks actual scores when present, samples all unfinished group fixtures from stored v1.3 uncapped Elo-implied probabilities, and reruns the same all-groups group-stage Monte Carlo rules used by the stored run \`${originalSimulationRunId}\`.

Current spine state is pre-tournament: ${actualResults.length} finished fixtures and ${simulation.sampledFixtures} sampled fixtures. The dry-run used ${args.simulations.toLocaleString()} iterations with seed ${args.seed}.

## Source State

| Item | Value |
|---|---:|
| Target project ref | \`${config.projectRef}\` |
| Expected group fixtures | ${expectedGroupFixtureCount} |
| Fixture metadata rows found | ${fixtureMetadataCount ?? "unknown"} |
| Finished results found | ${actualResults.length} |
| Unfinished fixtures | ${expectedGroupFixtureCount - actualResults.length} |
| Result source table | \`match_results\` |
| Standings source table | \`wc2026_group_standings\` |
| Standings rows found | ${standingsRows ?? "unknown"} |
| Duplicate finished result pairs | ${duplicateResults.length} |
| Result state hash | \`${resultStateHash}\` |

## Stored Probability Inputs

| Item | Value |
|---|---:|
| Source prediction run | \`${sourcePredictionRunId}\` |
| Fixture probabilities found | ${rawPredictionRows.length} |
| Probability model | v1.3 uncapped Elo-implied group matrix candidate |
| Odds used | false |
| API-Football predictions endpoint used | false |

## Pre-Tournament Equivalence Test

| Metric | Value |
|---|---:|
| Original simulation run compared | \`${originalSimulationRunId}\` |
| Actual locked fixtures | ${simulation.actualLockedFixtures} |
| Sampled fixtures | ${simulation.sampledFixtures} |
| Max advance probability delta | ${maxAdvanceDelta ?? "n/a"} |
| Average advance probability delta | ${avgAdvanceDelta ?? "n/a"} |
| Equivalence tolerance | ${equivalenceTolerance} |
| Passed | ${equivalencePassed ? "yes" : "no"} |

Largest deltas are written to \`data/audits/live-bracket-resimulation-original-run-comparison.csv\`.

## Live-State Logic

For each group fixture:

- finished in \`match_results\`: lock the actual score and mark \`fixture_state=actual_locked\`
- unfinished: sample scoreline/result from stored \`match_predictions\` W/D/L probabilities and scoreline lambdas
- group ranking: points, goal difference, goals for, drawing-of-lots random fallback
- advancement: top two in each group plus the best eight third-place teams

This consumer changes advancement probabilities only because tournament state changes. It does not retrain the model, regenerate fixture probabilities, run knockouts, or promote current-best state.

## Future Persistence Design

Future execute, after explicit approval, should insert a new candidate-only simulation run and 48 team-result rows:

- \`candidate_run=true\`
- \`not_global_current_best=true\`
- \`result_state_hash=${resultStateHash}\`
- \`finished_fixture_count=${actualResults.length}\`
- \`sampled_fixture_count=${simulation.sampledFixtures}\`
- \`source_prediction_run_id=${sourcePredictionRunId}\`
- \`source_result_table=match_results\`
- \`simulation_count=${args.simulations}\`
- \`seed=${args.seed}\`
- scope: group-stage only, no knockouts

The original simulation run is never overwritten.

## Guardrails

| Table / Area | Before | After |
|---|---:|---:|
| prediction_runs | ${protectedCountsBefore.prediction_runs} | ${protectedCountsAfter.prediction_runs} |
| match_predictions | ${protectedCountsBefore.match_predictions} | ${protectedCountsAfter.match_predictions} |
| model_candidates | ${protectedCountsBefore.model_candidates} | ${protectedCountsAfter.model_candidates} |
| tournament_simulation_runs | ${protectedCountsBefore.tournament_simulation_runs} | ${protectedCountsAfter.tournament_simulation_runs} |
| tournament_simulation_team_results | ${protectedCountsBefore.tournament_simulation_team_results} | ${protectedCountsAfter.tournament_simulation_team_results} |
| tournament_simulation_fixture_scorelines | ${protectedCountsBefore.tournament_simulation_fixture_scorelines} | ${protectedCountsAfter.tournament_simulation_fixture_scorelines} |

- DB writes: 0
- Prediction writes: 0
- Monte Carlo DB writes: 0
- Current-best changed: false
- Odds used: false
- API-Football predictions endpoint used: false
- Live API calls: 0

## Artifacts

- \`scripts/worldcup/live-group-stage-bracket-resimulation-consumer.ts\`
- \`data/audits/live-bracket-resimulation-pre-tournament-output.csv\`
- \`data/audits/live-bracket-resimulation-original-run-comparison.csv\`
- \`data/audits/live-bracket-resimulation-consumer-summary.json\`
- \`docs/worldcup-project-index.md\`

## Recommendation

${summary.recommendation}
`;
  writeFileSync(reportPath, report, "utf8");

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        dry_run: true,
        execute: false,
        task: "live_group_stage_bracket_resimulation_consumer_dry_run",
        errors: [String(error?.message ?? error)],
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
