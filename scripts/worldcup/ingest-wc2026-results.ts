import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rankGroup, type Standing, type GroupMatch, type Aux } from "./tiebreaker-ladders-2026";

type SupabaseConfig = {
  restUrl: string;
  serviceRoleKey: string;
  projectRef: string;
};

type ApiResult = {
  endpoint: string;
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
  response: any[];
  errors: unknown;
  response_hash: string;
  from_cache?: boolean;
};

type TeamRow = {
  id: string;
  fifa_code: string;
  name: string;
  group_name: string | null;
};

type FixtureMetadataRow = {
  id: string;
  fixture_label: string;
  group_code: string | null;
  team_a_id: string | null;
  team_b_id: string | null;
  team_a_code: string;
  team_b_code: string;
  external_fixture_id: string;
  kickoff_at: string | null;
  status: string;
};

type MatchResultRow = {
  id: string;
  fixture_metadata_id: string | null;
  fixture_label: string;
  team_a_code: string;
  team_b_code: string;
  team_a_goals: number | null;
  team_b_goals: number | null;
  match_status: string;
  review_status: string;
  api_football_fixture_id?: number | null;
  source_snapshot?: Record<string, unknown>;
};

type ApiFootballPlayerIdentityRow = {
  internal_player_id: string;
  api_player_id: number | null;
  api_team_id: number | null;
  matched_from: string | null;
  match_confidence: unknown;
  review_status: string | null;
};

type DetailStatus = "not_attempted" | "present" | "missing" | "partial" | "error";

type EnrichmentKey = "events" | "lineups" | "statistics" | "player_stats";

type EnrichmentStatusRow = {
  api_football_fixture_id: number;
  fixture_metadata_id: string | null;
  match_result_id: string | null;
  events_status: DetailStatus;
  lineups_status: DetailStatus;
  statistics_status: DetailStatus;
  player_stats_status?: DetailStatus;
  events_count: number;
  lineups_count: number;
  statistics_count: number;
  player_stats_count?: number;
  missing_reasons?: Record<string, unknown>;
  source_snapshot?: Record<string, unknown>;
  review_status?: string | null;
};

type PreparedResult = {
  tournament_code: "WC_2026";
  fixture_metadata_id: string | null;
  fixture_label: string;
  team_a_id: string | null;
  team_b_id: string | null;
  team_a_code: string;
  team_b_code: string;
  team_a_goals: number;
  team_b_goals: number;
  result: "team_a_win" | "draw" | "team_b_win";
  match_status: "finished";
  kickoff_at: string | null;
  finished_at: string | null;
  source_provider: "api-football";
  source_snapshot: Record<string, unknown>;
  review_status: "pending";
  api_football_fixture_id: number;
  provider_status: string | null;
  provider_status_short: string | null;
  round_name: string | null;
  group_code: string | null;
  source_payload_hash: string;
  last_ingested_at: string;
};

type StandingRow = {
  tournament_code: "WC_2026";
  group_code: string;
  team_id: string | null;
  team_code: string;
  team_name: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goals_for: number;
  goals_against: number;
  goal_difference: number;
  points: number;
  standings_rank: number;
  source: "derived_from_match_results";
  source_snapshot: Record<string, unknown>;
  review_status: "pending";
};

const rootDir = process.cwd();
const credentialsPath = path.join(rootDir, "supebase.txt");
const apiFootballBaseUrl = "https://v3.football.api-sports.io";
const worldCupProjectRef = "ahcfrgxczbgdvrqmbisw";
const tournamentCode = "WC_2026";
const apiFootballLeagueId = 1;
const apiFootballSeason = 2026;
const finalStatusShortCodes = new Set(["FT", "AET", "PEN"]);
const forbiddenEndpoints = ["/predictions", "/odds", "/odds/live"];
const resultIngestionScope = "wc2026-result-ingestion-spine";
const resultIngestionCacheDir = path.join(rootDir, "data", "external", "api-football", "cache", "result_ingestion");

const enrichmentEndpointSpecs: Array<{
  key: EnrichmentKey;
  endpoint: string;
  statusField: keyof EnrichmentStatusRow;
  countField: keyof EnrichmentStatusRow;
}> = [
  { key: "events", endpoint: "/fixtures/events", statusField: "events_status", countField: "events_count" },
  { key: "lineups", endpoint: "/fixtures/lineups", statusField: "lineups_status", countField: "lineups_count" },
  { key: "statistics", endpoint: "/fixtures/statistics", statusField: "statistics_status", countField: "statistics_count" },
  { key: "player_stats", endpoint: "/fixtures/players", statusField: "player_stats_status", countField: "player_stats_count" },
];

let apiRequestsUsed = 0;
let cacheFilesWritten = 0;
let lastRequestAt = 0;

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    execute: args.includes("--execute"),
    dryRun: !args.includes("--execute"),
    includeEnrichment: !args.includes("--skip-enrichment"),
    writeCache: args.includes("--write-cache") || args.includes("--execute"),
    throttleMs: Number(args.find((arg) => arg.startsWith("--throttle-ms="))?.split("=")[1] ?? 450),
    probeFixtureId: toInt(args.find((arg) => arg.startsWith("--probe-fixture-id="))?.split("=")[1]),
  };
}

function loadEnvFile() {
  for (const filename of [".env.local", ".env", ".env.example"]) {
    const filePath = path.join(rootDir, filename);
    if (!existsSync(filePath)) continue;
    const text = readFileSync(filePath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key]) continue;
      const value = rawValue.trim().replace(/^["']|["']$/g, "");
      if (value) process.env[key] = value;
    }
  }
}

function getApiKey() {
  loadEnvFile();
  const key = process.env.API_FOOTBALL_KEY?.trim();
  if (!key) throw new Error("API_FOOTBALL_KEY is required. It is never logged or written to artifacts.");
  return key;
}

async function readSupabaseConfig(): Promise<SupabaseConfig> {
  const text = await readFile(credentialsPath, "utf8");
  const restUrl = text.match(/https:\/\/[^\s]+\/rest\/v1\/?/)?.[0]?.replace(/\/$/, "");
  const projectRef = restUrl?.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1] ?? "";
  const serviceRoleKey = text.match(/service role secret\s*:\s*(\S+)/i)?.[1];

  if (projectRef !== worldCupProjectRef) throw new Error(`Unexpected Supabase project ref: ${projectRef || "unknown"}`);
  if (!restUrl || !serviceRoleKey) throw new Error(`Could not read Supabase REST config from ${credentialsPath}`);
  return { restUrl, serviceRoleKey, projectRef };
}

async function supabaseRequest<T>(
  config: SupabaseConfig,
  table: string,
  init: RequestInit & { search?: string; allowFailure?: boolean } = {},
): Promise<T> {
  const response = await fetch(`${config.restUrl}/${table}${init.search ?? ""}`, {
    ...init,
    headers: {
      apikey: config.serviceRoleKey,
      authorization: `Bearer ${config.serviceRoleKey}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const text = await response.text();
  if (!response.ok && !init.allowFailure) {
    throw new Error(`Supabase ${table} request failed (${response.status}): ${text}`);
  }
  if (!text.trim()) return undefined as T;
  return JSON.parse(text) as T;
}

async function countRows(config: SupabaseConfig, table: string) {
  const response = await fetch(`${config.restUrl}/${table}?select=id`, {
    method: "HEAD",
    headers: {
      apikey: config.serviceRoleKey,
      authorization: `Bearer ${config.serviceRoleKey}`,
      prefer: "count=exact",
    },
  });
  if (!response.ok) return null;
  const range = response.headers.get("content-range") ?? "";
  const total = range.split("/")[1];
  return total && total !== "*" ? Number(total) : null;
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function toInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const normalized = value.replace("%", "").trim();
    if (/^-?\d+(\.\d+)?$/.test(normalized)) return Number(normalized);
  }
  return null;
}

function toBool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return null;
}

function hasErrors(errors: unknown) {
  if (!errors) return false;
  if (Array.isArray(errors)) return errors.length > 0;
  if (typeof errors === "object") return Object.keys(errors as Record<string, unknown>).length > 0;
  return Boolean(errors);
}

async function throttle(ms: number) {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < ms) await new Promise((resolve) => setTimeout(resolve, ms - elapsed));
  lastRequestAt = Date.now();
}

async function apiFootballFetch(
  endpoint: string,
  params: Record<string, string | number>,
  apiKey: string,
  throttleMs: number,
): Promise<ApiResult> {
  if (forbiddenEndpoints.some((forbidden) => endpoint.startsWith(forbidden))) {
    throw new Error(`Forbidden API-Football endpoint requested: ${endpoint}`);
  }

  await throttle(throttleMs);
  apiRequestsUsed += 1;
  const url = new URL(`${apiFootballBaseUrl}${endpoint}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetch(url, { headers: { "x-apisports-key": apiKey } });
  const body = await response.json().catch(() => ({}));
  const rows = Array.isArray(body.response) ? body.response : [];
  const errors = body.errors ?? null;
  return {
    endpoint,
    ok: response.ok && !hasErrors(errors),
    status: response.status,
    body,
    response: rows,
    errors,
    response_hash: sha256(body),
  };
}

function cachePayload(endpoint: string, params: Record<string, string | number>, body: unknown, responseHash: string) {
  mkdirSync(resultIngestionCacheDir, { recursive: true });
  const safeEndpoint = endpoint.replace(/^\//, "").replace(/\//g, "_");
  const paramsHash = sha256(params).slice(0, 16);
  const filePath = path.join(resultIngestionCacheDir, `${safeEndpoint}_${paramsHash}_${responseHash.slice(0, 16)}.json`);
  if (!existsSync(filePath)) {
    writeFileSync(filePath, JSON.stringify({ endpoint, params, retrieved_at: new Date().toISOString(), response_hash: responseHash, body }, null, 2), "utf8");
    cacheFilesWritten += 1;
  }
  return filePath;
}

function sameParams(a: unknown, b: Record<string, string | number>) {
  if (!a || typeof a !== "object") return false;
  const record = a as Record<string, unknown>;
  return Object.entries(b).every(([key, value]) => String(record[key]) === String(value));
}

function cachedApiResult(endpoint: string, params: Record<string, string | number>): ApiResult | null {
  if (!existsSync(resultIngestionCacheDir)) return null;
  const safeEndpoint = endpoint.replace(/^\//, "").replace(/\//g, "_");
  const candidates: Array<{ mtimeMs: number; result: ApiResult }> = [];
  for (const name of readdirSync(resultIngestionCacheDir)) {
    if (!name.startsWith(`${safeEndpoint}_`) || !name.endsWith(".json")) continue;
    const filePath = path.join(resultIngestionCacheDir, name);
    try {
      const doc = JSON.parse(readFileSync(filePath, "utf8"));
      if (doc?.endpoint !== endpoint || !sameParams(doc?.params, params)) continue;
      const body = doc?.body && typeof doc.body === "object" ? doc.body as Record<string, unknown> : {};
      const errors = (body as any)?.errors ?? null;
      const response = Array.isArray((body as any)?.response) ? (body as any).response : [];
      candidates.push({
        mtimeMs: statSync(filePath).mtimeMs,
        result: {
          endpoint,
          ok: !hasErrors(errors),
          status: 200,
          body,
          response,
          errors,
          response_hash: asText(doc?.response_hash) ?? sha256(body),
          from_cache: true,
        },
      });
    } catch {
      continue;
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.result ?? null;
}

function teamCodesFromFixture(row: any) {
  return {
    home_code: row?.teams?.home?.code ?? null,
    away_code: row?.teams?.away?.code ?? null,
    home_name: row?.teams?.home?.name ?? null,
    away_name: row?.teams?.away?.name ?? null,
  };
}

function apiScore(row: any) {
  return {
    home: toInt(row?.goals?.home ?? row?.score?.fulltime?.home),
    away: toInt(row?.goals?.away ?? row?.score?.fulltime?.away),
  };
}

function fixtureStatus(row: any) {
  return {
    long: asText(row?.fixture?.status?.long),
    short: asText(row?.fixture?.status?.short),
    elapsed: toInt(row?.fixture?.status?.elapsed),
  };
}

function normalizeProviderCode(apiCode: string | null, apiTeamId: number | null) {
  const byApiCode: Record<string, string> = {
    SPA: "ESP",
    JAP: "JPN",
    SWI: "SUI",
    IRA: "IRN",
    SAU: "KSA",
    MOR: "MAR",
    NET: "NED",
    IVO: "CIV",
    CON: "COD",
    SOU: "RSA",
    CAP: "CPV",
    ZEA: "NZL",
    BOS: "BIH",
  };
  if (apiTeamId === 20) return "AUS";
  if (apiTeamId === 775) return "AUT";
  if (apiTeamId === 22) return "IRN";
  if (apiTeamId === 1567) return "IRQ";
  if (apiTeamId === 11) return "PAN";
  if (apiTeamId === 16) return "MEX";
  if (apiTeamId === 1548) return "JOR";
  if (apiTeamId === 1569) return "QAT";
  if (apiTeamId === 5530) return "CUW";
  return apiCode ? byApiCode[apiCode] ?? apiCode : null;
}

function resultLabel(teamAGoals: number, teamBGoals: number): PreparedResult["result"] {
  if (teamAGoals > teamBGoals) return "team_a_win";
  if (teamAGoals < teamBGoals) return "team_b_win";
  return "draw";
}

function prepareResult(
  fixture: any,
  metadata: FixtureMetadataRow | null,
  teamsByCode: Map<string, TeamRow>,
  retrievedAt: string,
  sourceHash: string,
  allowUnmappedProviderTeams = false,
): PreparedResult | null {
  const fixtureId = toInt(fixture?.fixture?.id);
  const status = fixtureStatus(fixture);
  const score = apiScore(fixture);
  if (!fixtureId || !status.short || !finalStatusShortCodes.has(status.short)) return null;
  if (score.home === null || score.away === null) return null;

  const homeApiId = toInt(fixture?.teams?.home?.id);
  const awayApiId = toInt(fixture?.teams?.away?.id);
  const homeCode = normalizeProviderCode(asText(fixture?.teams?.home?.code), homeApiId)
    ?? (allowUnmappedProviderTeams && homeApiId !== null ? `API_${homeApiId}` : null);
  const awayCode = normalizeProviderCode(asText(fixture?.teams?.away?.code), awayApiId)
    ?? (allowUnmappedProviderTeams && awayApiId !== null ? `API_${awayApiId}` : null);
  const teamACode = metadata?.team_a_code ?? homeCode;
  const teamBCode = metadata?.team_b_code ?? awayCode;
  if (!teamACode || !teamBCode || !homeCode || !awayCode) return null;

  const scoreByCode = new Map([
    [homeCode, score.home],
    [awayCode, score.away],
  ]);
  const teamAGoals = scoreByCode.get(teamACode);
  const teamBGoals = scoreByCode.get(teamBCode);
  if (teamAGoals === undefined || teamBGoals === undefined) return null;

  const fixtureLabel = metadata?.fixture_label ?? `${teamACode} vs ${teamBCode}`;
  const teamA = teamsByCode.get(teamACode);
  const teamB = teamsByCode.get(teamBCode);
  const sourceSnapshot = {
    source_provider: "api-football",
    api_football_fixture_id: fixtureId,
    retrieved_at: retrievedAt,
    response_hash: sourceHash,
    provider_fixture: {
      date: fixture?.fixture?.date ?? null,
      status,
      league: fixture?.league ?? null,
      teams: fixture?.teams ?? null,
      goals: fixture?.goals ?? null,
      score: fixture?.score ?? null,
    },
    mapping: {
      fixture_metadata_id: metadata?.id ?? null,
      fixture_label: fixtureLabel,
      provider_home_code: homeCode,
      provider_away_code: awayCode,
      probe_unmapped_provider_team_codes: allowUnmappedProviderTeams && !metadata,
      internal_team_a_code: teamACode,
      internal_team_b_code: teamBCode,
    },
    guardrails: {
      no_api_football_predictions_endpoint: true,
      no_odds: true,
      no_model_retraining: true,
      no_monte_carlo: true,
    },
  };

  return {
    tournament_code: tournamentCode,
    fixture_metadata_id: metadata?.id ?? null,
    fixture_label: fixtureLabel,
    team_a_id: metadata?.team_a_id ?? teamA?.id ?? null,
    team_b_id: metadata?.team_b_id ?? teamB?.id ?? null,
    team_a_code: teamACode,
    team_b_code: teamBCode,
    team_a_goals: teamAGoals,
    team_b_goals: teamBGoals,
    result: resultLabel(teamAGoals, teamBGoals),
    match_status: "finished",
    kickoff_at: fixture?.fixture?.date ?? metadata?.kickoff_at ?? null,
    finished_at: fixture?.fixture?.date ?? null,
    source_provider: "api-football",
    source_snapshot: sourceSnapshot,
    review_status: "pending",
    api_football_fixture_id: fixtureId,
    provider_status: status.long,
    provider_status_short: status.short,
    round_name: asText(fixture?.league?.round),
    group_code: metadata?.group_code ?? null,
    source_payload_hash: sourceHash,
    last_ingested_at: retrievedAt,
  };
}

function sameStoredResult(existing: MatchResultRow | undefined, prepared: PreparedResult) {
  return Boolean(existing)
    && existing?.team_a_goals === prepared.team_a_goals
    && existing?.team_b_goals === prepared.team_b_goals
    && existing?.match_status === prepared.match_status;
}

function makeDetailSnapshot(fixtureId: number, endpoint: string, rowType: string, row: unknown, index: number, responseHash: string) {
  return {
    fixture_id: fixtureId,
    endpoint,
    row_type: rowType,
    row_index: index,
    raw: row,
    import_scope: "wc2026-result-ingestion-spine",
    api_response_hash: responseHash,
    no_odds: true,
    no_api_football_predictions_endpoint: true,
  };
}

function buildEventRows(fixtureId: number, result: ApiResult) {
  return result.response.map((event, index) => ({
    fixture_id: fixtureId,
    source_provider: "api-football",
    source_event_hash: sha256(["event", fixtureId, event, index]),
    event_elapsed: toInt(event?.time?.elapsed),
    event_extra: toInt(event?.time?.extra),
    team_id: toInt(event?.team?.id),
    team_name: asText(event?.team?.name),
    player_id: toInt(event?.player?.id),
    player_name: asText(event?.player?.name),
    assist_player_id: toInt(event?.assist?.id),
    assist_player_name: asText(event?.assist?.name),
    event_type: asText(event?.type),
    event_detail: asText(event?.detail),
    comments: asText(event?.comments),
    source_snapshot: makeDetailSnapshot(fixtureId, result.endpoint, "event", event, index, result.response_hash),
    api_response_hash: result.response_hash,
    review_status: "pending",
  }));
}

function buildLineupRows(fixtureId: number, result: ApiResult) {
  const rows: Record<string, unknown>[] = [];
  for (const [teamIndex, lineup] of result.response.entries()) {
    const teamId = toInt(lineup?.team?.id);
    const teamName = asText(lineup?.team?.name);
    const formation = asText(lineup?.formation);
    const coach = lineup?.coach;
    rows.push({
      fixture_id: fixtureId,
      source_provider: "api-football",
      source_lineup_hash: sha256(["coach", fixtureId, lineup, teamIndex]),
      team_id: teamId,
      team_name: teamName,
      formation,
      coach_id: toInt(coach?.id),
      coach_name: asText(coach?.name),
      lineup_role: "coach",
      source_snapshot: makeDetailSnapshot(fixtureId, result.endpoint, "coach", lineup, teamIndex, result.response_hash),
      api_response_hash: result.response_hash,
      review_status: "pending",
    });

    for (const role of ["startXI", "substitutes"] as const) {
      const list = Array.isArray(lineup?.[role]) ? lineup[role] : [];
      for (const [playerIndex, wrapper] of list.entries()) {
        const player = wrapper?.player ?? wrapper;
        rows.push({
          fixture_id: fixtureId,
          source_provider: "api-football",
          source_lineup_hash: sha256([role, fixtureId, teamId, player, playerIndex]),
          team_id: teamId,
          team_name: teamName,
          formation,
          player_id: toInt(player?.id),
          player_name: asText(player?.name),
          player_number: toInt(player?.number),
          player_position: asText(player?.pos),
          grid: asText(player?.grid),
          lineup_role: role === "startXI" ? "startXI" : "substitute",
          source_snapshot: makeDetailSnapshot(fixtureId, result.endpoint, role, wrapper, playerIndex, result.response_hash),
          api_response_hash: result.response_hash,
          review_status: "pending",
        });
      }
    }
  }
  return rows;
}

function buildStatisticRows(fixtureId: number, result: ApiResult) {
  const rows: Record<string, unknown>[] = [];
  for (const teamRow of result.response) {
    const teamId = toInt(teamRow?.team?.id);
    const teamName = asText(teamRow?.team?.name);
    const stats = Array.isArray(teamRow?.statistics) ? teamRow.statistics : [];
    for (const [index, stat] of stats.entries()) {
      const rawValue = stat?.value;
      rows.push({
        fixture_id: fixtureId,
        source_provider: "api-football",
        source_stat_hash: sha256(["stat", fixtureId, teamId, stat, index]),
        team_id: teamId,
        team_name: teamName,
        stat_type: asText(stat?.type) ?? "unknown",
        stat_value: asText(rawValue),
        stat_value_numeric: toNumber(rawValue),
        source_snapshot: makeDetailSnapshot(fixtureId, result.endpoint, "statistic", stat, index, result.response_hash),
        api_response_hash: result.response_hash,
        review_status: "pending",
      });
    }
  }
  return rows;
}

function playerStatsSourceSnapshot(
  fixtureId: number,
  result: ApiResult,
  teamRow: any,
  playerRow: any,
  stat: any,
  index: number,
  identity: ApiFootballPlayerIdentityRow | undefined,
) {
  return {
    ...makeDetailSnapshot(fixtureId, result.endpoint, "player_stat", { team: teamRow?.team, player: playerRow?.player, stat }, index, result.response_hash),
    identity_mapping: {
      source: "api_football_player_identity_map",
      internal_player_id: identity?.internal_player_id ?? null,
      api_player_id: toInt(playerRow?.player?.id),
      api_team_id: identity?.api_team_id ?? null,
      matched_from: identity?.matched_from ?? null,
      match_confidence: identity?.match_confidence ?? null,
      review_status: identity?.review_status ?? null,
      mapped: Boolean(identity),
    },
    materiality: {
      gate_decision: "context_only",
      rerun_triggered: false,
      prediction_input_allowed: false,
      reason: "post-match observed player statistics are AI-narration/evidence context only; only verified results trigger model reruns",
      never_feed: ["player_impact_snapshots", "team_strength_snapshots", "prediction_runs", "match_predictions"],
    },
  };
}

function buildPlayerStatRows(fixtureId: number, result: ApiResult, playerIdentityByApiId: Map<number, ApiFootballPlayerIdentityRow>) {
  const rows: Record<string, unknown>[] = [];
  for (const [teamIndex, teamRow] of result.response.entries()) {
    const teamId = toInt(teamRow?.team?.id);
    const teamName = asText(teamRow?.team?.name);
    const players = Array.isArray(teamRow?.players) ? teamRow.players : [];
    for (const [playerIndex, playerRow] of players.entries()) {
      const apiPlayerId = toInt(playerRow?.player?.id);
      const identity = apiPlayerId === null ? undefined : playerIdentityByApiId.get(apiPlayerId);
      const stats = Array.isArray(playerRow?.statistics) ? playerRow.statistics : [];
      for (const [statIndex, stat] of stats.entries()) {
        rows.push({
          fixture_id: fixtureId,
          source_provider: "api-football",
          source_player_stat_hash: sha256(["player_stat", fixtureId, teamId, apiPlayerId, stat, teamIndex, playerIndex, statIndex]),
          team_id: teamId,
          team_name: teamName,
          player_id: apiPlayerId,
          player_name: asText(playerRow?.player?.name),
          position: asText(stat?.games?.position),
          rating: toNumber(stat?.games?.rating),
          captain: toBool(stat?.games?.captain),
          substitute: toBool(stat?.games?.substitute),
          minutes: toInt(stat?.games?.minutes),
          number: toInt(stat?.games?.number),
          offsides: toInt(stat?.offsides),
          shots_total: toInt(stat?.shots?.total),
          shots_on: toInt(stat?.shots?.on),
          goals_total: toInt(stat?.goals?.total),
          goals_conceded: toInt(stat?.goals?.conceded),
          assists: toInt(stat?.goals?.assists),
          saves: toInt(stat?.goals?.saves),
          passes_total: toInt(stat?.passes?.total),
          passes_key: toInt(stat?.passes?.key),
          passes_accuracy: asText(stat?.passes?.accuracy),
          tackles_total: toInt(stat?.tackles?.total),
          tackles_blocks: toInt(stat?.tackles?.blocks),
          tackles_interceptions: toInt(stat?.tackles?.interceptions),
          duels_total: toInt(stat?.duels?.total),
          duels_won: toInt(stat?.duels?.won),
          dribbles_attempts: toInt(stat?.dribbles?.attempts),
          dribbles_success: toInt(stat?.dribbles?.success),
          fouls_drawn: toInt(stat?.fouls?.drawn),
          fouls_committed: toInt(stat?.fouls?.committed),
          cards_yellow: toInt(stat?.cards?.yellow),
          cards_red: toInt(stat?.cards?.red),
          penalty_won: toInt(stat?.penalty?.won),
          penalty_committed: toInt(stat?.penalty?.commited ?? stat?.penalty?.committed),
          penalty_scored: toInt(stat?.penalty?.scored),
          penalty_missed: toInt(stat?.penalty?.missed),
          penalty_saved: toInt(stat?.penalty?.saved),
          source_snapshot: playerStatsSourceSnapshot(fixtureId, result, teamRow, playerRow, stat, statIndex, identity),
          api_response_hash: result.response_hash,
          review_status: "pending",
        });
      }
    }
  }
  return rows;
}

function detailStatus(result: ApiResult): DetailStatus {
  if (!result.ok) return "error";
  return result.response.length > 0 ? "present" : "missing";
}

function playerStatsStatus(result: ApiResult, parsedRows: number): DetailStatus {
  if (!result.ok) return "error";
  if (parsedRows > 0) return "present";
  return result.response.length > 0 ? "partial" : "missing";
}

function trustedResultIngestionStatus(row: EnrichmentStatusRow | undefined) {
  return row?.source_snapshot?.import_scope === resultIngestionScope;
}

function statusForEndpoint(row: EnrichmentStatusRow | undefined, key: EnrichmentKey): DetailStatus {
  if (!row) return "not_attempted";
  if (key === "events") return row.events_status ?? "not_attempted";
  if (key === "lineups") return row.lineups_status ?? "not_attempted";
  if (key === "statistics") return row.statistics_status ?? "not_attempted";
  return row.player_stats_status ?? "not_attempted";
}

function countForEndpoint(row: EnrichmentStatusRow | undefined, key: EnrichmentKey): number {
  if (!row) return 0;
  if (key === "events") return Number(row.events_count ?? 0);
  if (key === "lineups") return Number(row.lineups_count ?? 0);
  if (key === "statistics") return Number(row.statistics_count ?? 0);
  return Number(row.player_stats_count ?? 0);
}

function endpointAlreadyComplete(row: EnrichmentStatusRow | undefined, key: EnrichmentKey) {
  return trustedResultIngestionStatus(row) && statusForEndpoint(row, key) === "present";
}

function cachedEndpointIsPresent(key: EnrichmentKey, result: ApiResult, playerRowsForPlayerStats = 0) {
  if (key === "player_stats") return playerStatsStatus(result, playerRowsForPlayerStats) === "present";
  return detailStatus(result) === "present";
}

export function planEnrichmentEndpointsForTest(statusRow: EnrichmentStatusRow | undefined) {
  return enrichmentEndpointSpecs.map((spec) => ({
    key: spec.key,
    fetch: !endpointAlreadyComplete(statusRow, spec.key),
    reason: endpointAlreadyComplete(statusRow, spec.key)
      ? "trusted_result_ingestion_status_present"
      : `status_${trustedResultIngestionStatus(statusRow) ? statusForEndpoint(statusRow, spec.key) : "untrusted_or_absent"}`,
  }));
}

function detailMissingReason(result: ApiResult) {
  const status = detailStatus(result);
  if (status === "present") return null;
  if (status === "error") return { status, http_status: result.status, errors: result.errors };
  return {
    status,
    reason: "endpoint_returned_no_rows",
  };
}

function playerStatsMissingReason(result: ApiResult, parsedRows: number) {
  const status = playerStatsStatus(result, parsedRows);
  if (status === "present") return null;
  if (status === "error") return { status, http_status: result.status, errors: result.errors };
  return {
    status,
    reason: status === "partial" ? "endpoint_returned_team_payload_but_no_player_stat_rows" : "endpoint_returned_no_rows",
  };
}

function buildEnrichmentStatusRow(
  result: PreparedResult,
  existingResult: MatchResultRow | undefined,
  detail: { events: ApiResult; lineups: ApiResult; statistics: ApiResult; playerStats: ApiResult },
  counts: { events: number; lineups: number; statistics: number; playerStats: number },
) {
  const missingReasons = {
    events: detailMissingReason(detail.events),
    lineups: detailMissingReason(detail.lineups),
    statistics: detailMissingReason(detail.statistics),
    player_stats: playerStatsMissingReason(detail.playerStats, counts.playerStats),
  };
  return {
    tournament_code: tournamentCode,
    source_provider: "api-football",
    api_football_fixture_id: result.api_football_fixture_id,
    fixture_metadata_id: result.fixture_metadata_id,
    match_result_id: existingResult?.id ?? null,
    events_status: detailStatus(detail.events),
    lineups_status: detailStatus(detail.lineups),
    statistics_status: detailStatus(detail.statistics),
    player_stats_status: playerStatsStatus(detail.playerStats, counts.playerStats),
    events_count: counts.events,
    lineups_count: counts.lineups,
    statistics_count: counts.statistics,
    player_stats_count: counts.playerStats,
    missing_reasons: Object.fromEntries(Object.entries(missingReasons).filter(([, value]) => value !== null)),
    last_attempted_at: new Date().toISOString(),
    source_snapshot: {
      import_scope: "wc2026-result-ingestion-spine",
      api_football_fixture_id: result.api_football_fixture_id,
      fixture_label: result.fixture_label,
      endpoints: {
        events: detail.events.endpoint,
        lineups: detail.lineups.endpoint,
        statistics: detail.statistics.endpoint,
        player_stats: detail.playerStats.endpoint,
      },
      response_hashes: {
        events: detail.events.response_hash,
        lineups: detail.lineups.response_hash,
        statistics: detail.statistics.response_hash,
        player_stats: detail.playerStats.response_hash,
      },
      materiality: {
        gate_decision: "context_only",
        rerun_triggered: false,
        prediction_input_allowed: false,
        reason: "enrichment endpoints are context-only; only verified match_results trigger model reruns",
      },
      no_odds: true,
      no_api_football_predictions_endpoint: true,
    },
    review_status: "pending",
    updated_at: new Date().toISOString(),
  };
}

function buildMergedEnrichmentStatusRow(
  result: PreparedResult,
  existingResult: MatchResultRow | undefined,
  existingStatus: EnrichmentStatusRow | undefined,
  details: Partial<Record<EnrichmentKey, ApiResult>>,
  counts: Partial<Record<EnrichmentKey, number>>,
) {
  const now = new Date().toISOString();
  const endpointByKey = Object.fromEntries(enrichmentEndpointSpecs.map((spec) => [spec.key, spec.endpoint]));
  const priorMissingReasons = trustedResultIngestionStatus(existingStatus) && existingStatus?.missing_reasons
    ? existingStatus.missing_reasons
    : {};
  const missingReasons: Record<string, unknown> = { ...priorMissingReasons };

  for (const spec of enrichmentEndpointSpecs) {
    const detail = details[spec.key];
    if (!detail) continue;
    if (spec.key === "player_stats") {
      const reason = playerStatsMissingReason(detail, counts.player_stats ?? 0);
      if (reason) missingReasons.player_stats = reason;
      else delete missingReasons.player_stats;
    } else {
      const reason = detailMissingReason(detail);
      if (reason) missingReasons[spec.key] = reason;
      else delete missingReasons[spec.key];
    }
  }

  const priorSnapshot = trustedResultIngestionStatus(existingStatus) && existingStatus?.source_snapshot
    ? existingStatus.source_snapshot as Record<string, any>
    : {};
  const responseHashes = { ...(priorSnapshot.response_hashes ?? {}) };
  const cache_sources = { ...(priorSnapshot.cache_sources ?? {}) };
  for (const spec of enrichmentEndpointSpecs) {
    const detail = details[spec.key];
    if (!detail) continue;
    responseHashes[spec.key] = detail.response_hash;
    cache_sources[spec.key] = detail.from_cache ? "raw_payload_cache" : "api_fetch";
  }

  return {
    tournament_code: tournamentCode,
    source_provider: "api-football",
    api_football_fixture_id: result.api_football_fixture_id,
    fixture_metadata_id: result.fixture_metadata_id,
    match_result_id: existingResult?.id ?? existingStatus?.match_result_id ?? null,
    events_status: details.events ? detailStatus(details.events) : statusForEndpoint(existingStatus, "events"),
    lineups_status: details.lineups ? detailStatus(details.lineups) : statusForEndpoint(existingStatus, "lineups"),
    statistics_status: details.statistics ? detailStatus(details.statistics) : statusForEndpoint(existingStatus, "statistics"),
    player_stats_status: details.player_stats ? playerStatsStatus(details.player_stats, counts.player_stats ?? 0) : statusForEndpoint(existingStatus, "player_stats"),
    events_count: details.events ? counts.events ?? 0 : countForEndpoint(existingStatus, "events"),
    lineups_count: details.lineups ? counts.lineups ?? 0 : countForEndpoint(existingStatus, "lineups"),
    statistics_count: details.statistics ? counts.statistics ?? 0 : countForEndpoint(existingStatus, "statistics"),
    player_stats_count: details.player_stats ? counts.player_stats ?? 0 : countForEndpoint(existingStatus, "player_stats"),
    missing_reasons: missingReasons,
    last_attempted_at: now,
    source_snapshot: {
      ...priorSnapshot,
      import_scope: resultIngestionScope,
      api_football_fixture_id: result.api_football_fixture_id,
      fixture_label: result.fixture_label,
      endpoints: endpointByKey,
      response_hashes: responseHashes,
      cache_sources,
      materiality: {
        gate_decision: "context_only",
        rerun_triggered: false,
        prediction_input_allowed: false,
        reason: "enrichment endpoints are context-only; only verified match_results trigger model reruns",
      },
      no_odds: true,
      no_api_football_predictions_endpoint: true,
    },
    review_status: "pending",
    updated_at: now,
  };
}

function deriveStandings(teams: TeamRow[], fixtureMetadata: FixtureMetadataRow[], results: PreparedResult[], aux: Aux): StandingRow[] {
  const teamsByCode = new Map(teams.map((team) => [team.fifa_code, team]));
  const groupByCode = new Map<string, string>();
  for (const team of teams) if (team.group_name) groupByCode.set(team.fifa_code, team.group_name);
  for (const fixture of fixtureMetadata) {
    if (fixture.group_code) {
      groupByCode.set(fixture.team_a_code, fixture.group_code);
      groupByCode.set(fixture.team_b_code, fixture.group_code);
    }
  }

  const table = new Map<string, StandingRow>();
  for (const team of teams) {
    const groupCode = groupByCode.get(team.fifa_code) ?? "unknown";
    table.set(team.fifa_code, {
      tournament_code: tournamentCode,
      group_code: groupCode,
      team_id: team.id,
      team_code: team.fifa_code,
      team_name: team.name,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      goals_for: 0,
      goals_against: 0,
      goal_difference: 0,
      points: 0,
      standings_rank: 0,
      source: "derived_from_match_results",
      source_snapshot: { source: "match_results_plus_current_ingestion_plan" },
      review_status: "pending",
    });
  }

  for (const result of results) {
    const a = table.get(result.team_a_code);
    const b = table.get(result.team_b_code);
    if (!a || !b) continue;
    a.played += 1; b.played += 1;
    a.goals_for += result.team_a_goals; a.goals_against += result.team_b_goals;
    b.goals_for += result.team_b_goals; b.goals_against += result.team_a_goals;
    if (result.team_a_goals > result.team_b_goals) {
      a.won += 1; a.points += 3; b.lost += 1;
    } else if (result.team_a_goals < result.team_b_goals) {
      b.won += 1; b.points += 3; a.lost += 1;
    } else {
      a.drawn += 1; b.drawn += 1; a.points += 1; b.points += 1;
    }
  }

  for (const row of table.values()) row.goal_difference = row.goals_for - row.goals_against;
  const grouped = new Map<string, StandingRow[]>();
  for (const row of table.values()) {
    const rows = grouped.get(row.group_code) ?? [];
    rows.push(row);
    grouped.set(row.group_code, rows);
  }
  // RANK with the FULL FIFA-2026 Article-13 ladder (REUSED rankGroup): points -> head-to-head (pts/GD/GF among the
  // tied teams) -> overall GD -> overall GF -> fair-play -> FIFA ranking. This is the SAME ladder the conditional
  // engine uses and self-tests, so the stored table agrees with the engine — replacing the old simplified
  // pts -> GD -> GF -> alphabetical tiebreak (which mis-ordered head-to-head ties).
  for (const rows of grouped.values()) {
    const members = new Set(rows.map((r) => r.team_code));
    const standings: Standing[] = rows.map((r) => ({ team: r.team_code, pts: r.points, gf: r.goals_for, ga: r.goals_against, gd: r.goal_difference }));
    const matches: GroupMatch[] = results
      .filter((res) => members.has(res.team_a_code) && members.has(res.team_b_code))
      .map((res) => ({ a: res.team_a_code, b: res.team_b_code, ga: res.team_a_goals, gb: res.team_b_goals }));
    const order = new Map(rankGroup(standings, matches, aux).map((s, i) => [s.team, i + 1] as const));
    rows.forEach((row) => { row.standings_rank = order.get(row.team_code) ?? row.standings_rank; });
  }
  return [...table.values()].sort((a, b) => a.group_code.localeCompare(b.group_code) || a.standings_rank - b.standings_rank);
}

async function upsertRows(config: SupabaseConfig, table: string, rows: unknown[], onConflict: string) {
  if (rows.length === 0) return [];
  return supabaseRequest(config, table, {
    method: "POST",
    search: `?on_conflict=${encodeURIComponent(onConflict)}`,
    headers: { prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(rows),
  });
}

async function main() {
  const args = parseArgs();
  const startedAt = new Date().toISOString();
  const apiKey = getApiKey();
  const config = await readSupabaseConfig();
  const warnings: string[] = [];
  const errors: string[] = [];
  if (args.execute && args.probeFixtureId !== null) {
    throw new Error("--probe-fixture-id is dry-run-only; refusing execute against a non-WC2026 probe fixture.");
  }
  if (args.probeFixtureId !== null) {
    warnings.push(`dry-run probe fixture ${args.probeFixtureId} requested; production WC2026 league fetch is bypassed and execute is blocked`);
  }

  const protectedTables = [
    "players",
    "squads",
    "squad_players",
    "final_squad_verifications",
    "player_impact_snapshots",
    "team_strength_snapshots",
    "prediction_runs",
    "match_predictions",
    "model_candidates",
  ];
  const beforeCounts = Object.fromEntries(await Promise.all(protectedTables.map(async (table) => [table, await countRows(config, table)])));
  const resultCountBefore = await countRows(config, "match_results");

  const [teams, fixtureMetadata, existingResults, playerIdentityRows, existingEnrichmentStatuses] = await Promise.all([
    supabaseRequest<TeamRow[]>(config, "teams", { search: "?select=id,fifa_code,name,group_name&order=fifa_code.asc" }),
    supabaseRequest<FixtureMetadataRow[]>(config, "fixture_metadata", {
      search: "?select=id,fixture_label,group_code,team_a_id,team_b_id,team_a_code,team_b_code,external_fixture_id,kickoff_at,status&tournament_code=eq.WC_2026&source_provider=eq.api-football",
    }),
    supabaseRequest<MatchResultRow[]>(config, "match_results", {
      search: "?select=id,fixture_metadata_id,fixture_label,team_a_code,team_b_code,team_a_goals,team_b_goals,match_status,review_status,api_football_fixture_id,source_snapshot&tournament_code=eq.WC_2026",
    }),
    supabaseRequest<ApiFootballPlayerIdentityRow[]>(config, "api_football_player_identity_map", {
      search: "?select=internal_player_id,api_player_id,api_team_id,matched_from,match_confidence,review_status&tournament_code=eq.WC_2026&api_provider=eq.api-football&review_status=neq.rejected",
    }),
    supabaseRequest<EnrichmentStatusRow[]>(config, "wc2026_fixture_enrichment_status", {
      search: "?select=api_football_fixture_id,fixture_metadata_id,match_result_id,events_status,lineups_status,statistics_status,player_stats_status,events_count,lineups_count,statistics_count,player_stats_count,missing_reasons,source_snapshot,review_status&tournament_code=eq.WC_2026&source_provider=eq.api-football&review_status=neq.rejected",
    }),
  ]);

  const teamsByCode = new Map(teams.map((team) => [team.fifa_code, team]));
  const metadataByExternalId = new Map(fixtureMetadata.map((row) => [row.external_fixture_id, row]));
  const resultByMetadataId = new Map(existingResults.filter((row) => row.fixture_metadata_id).map((row) => [row.fixture_metadata_id as string, row]));
  const enrichmentStatusByApiFixtureId = new Map(
    existingEnrichmentStatuses.map((row) => [Number(row.api_football_fixture_id), row] as const),
  );
  const playerIdentityByApiId = new Map(
    playerIdentityRows
      .filter((row) => row.api_player_id !== null)
      .map((row) => [Number(row.api_player_id), row] as const),
  );

  const fixtureParams = args.probeFixtureId !== null
    ? { id: args.probeFixtureId }
    : { league: apiFootballLeagueId, season: apiFootballSeason };
  const fixtureFetch = await apiFootballFetch(
    "/fixtures",
    fixtureParams,
    apiKey,
    args.throttleMs,
  );
  if (!fixtureFetch.ok) errors.push(`Fixture fetch failed: ${JSON.stringify(fixtureFetch.errors)}`);
  if (args.writeCache) cachePayload("/fixtures", fixtureParams, fixtureFetch.body, fixtureFetch.response_hash);

  const retrievedAt = new Date().toISOString();
  const allFixtures = fixtureFetch.response;
  const finishedFixtures = allFixtures.filter((fixture) => {
    const status = fixtureStatus(fixture);
    return Boolean(status.short && finalStatusShortCodes.has(status.short));
  });

  const preparedResults = finishedFixtures
    .map((fixture) => {
      const fixtureId = toInt(fixture?.fixture?.id);
      const metadata = fixtureId ? metadataByExternalId.get(String(fixtureId)) ?? null : null;
      const payloadHash = sha256(fixture);
      return prepareResult(fixture, metadata, teamsByCode, retrievedAt, payloadHash, args.probeFixtureId !== null);
    })
    .filter((row): row is PreparedResult => Boolean(row));

  const wouldInsert = preparedResults.filter((row) => !row.fixture_metadata_id || !resultByMetadataId.has(row.fixture_metadata_id)).length;
  const wouldUpdate = preparedResults.filter((row) => {
    const existing = row.fixture_metadata_id ? resultByMetadataId.get(row.fixture_metadata_id) : undefined;
    return Boolean(existing) && !sameStoredResult(existing, row);
  }).length;
  const unchanged = preparedResults.length - wouldInsert - wouldUpdate;

  const enrichmentSummaries: Record<string, unknown>[] = [];
  const eventRows: Record<string, unknown>[] = [];
  const lineupRows: Record<string, unknown>[] = [];
  const statisticRows: Record<string, unknown>[] = [];
  const playerStatRows: Record<string, unknown>[] = [];
  const enrichmentStatusRows: Record<string, unknown>[] = [];
  let enrichmentFixturesSkippedFully = 0;
  let enrichmentEndpointApiFetches = 0;
  let enrichmentEndpointCacheHits = 0;
  let enrichmentEndpointStatusSkips = 0;

  if (args.includeEnrichment) {
    for (const result of preparedResults) {
      const fixtureId = result.api_football_fixture_id;
      const existingStatus = enrichmentStatusByApiFixtureId.get(fixtureId);
      const trustedStatus = trustedResultIngestionStatus(existingStatus);
      const detailByKey: Partial<Record<EnrichmentKey, ApiResult>> = {};
      const endpointSources: Record<EnrichmentKey, string> = {
        events: "not_planned",
        lineups: "not_planned",
        statistics: "not_planned",
        player_stats: "not_planned",
      };
      const specsToFetch: typeof enrichmentEndpointSpecs = [];

      for (const spec of enrichmentEndpointSpecs) {
        if (endpointAlreadyComplete(existingStatus, spec.key)) {
          endpointSources[spec.key] = "status_present_skip";
          enrichmentEndpointStatusSkips += 1;
          continue;
        }

        const cached = cachedApiResult(spec.endpoint, { fixture: fixtureId });
        if (cached) {
          const parsedPlayerRows = spec.key === "player_stats"
            ? buildPlayerStatRows(fixtureId, cached, playerIdentityByApiId)
            : [];
          if (cachedEndpointIsPresent(spec.key, cached, parsedPlayerRows.length)) {
            detailByKey[spec.key] = cached;
            endpointSources[spec.key] = "raw_payload_cache_present";
            enrichmentEndpointCacheHits += 1;
            continue;
          }
        }

        specsToFetch.push(spec);
        endpointSources[spec.key] = trustedStatus
          ? `api_fetch_after_${statusForEndpoint(existingStatus, spec.key)}`
          : "api_fetch_no_trusted_result_ingestion_status";
      }

      const fetchedDetails = await Promise.all(specsToFetch.map(async (spec) => ({
        key: spec.key,
        detail: await apiFootballFetch(spec.endpoint, { fixture: fixtureId }, apiKey, args.throttleMs),
      })));
      enrichmentEndpointApiFetches += fetchedDetails.length;
      for (const { key, detail } of fetchedDetails) detailByKey[key] = detail;

      if (args.writeCache) {
        for (const detail of Object.values(detailByKey).filter((row): row is ApiResult => Boolean(row && !row.from_cache))) {
          cachePayload(detail.endpoint, { fixture: fixtureId }, detail.body, detail.response_hash);
        }
      }

      const events = detailByKey.events;
      const lineups = detailByKey.lineups;
      const statistics = detailByKey.statistics;
      const playerStats = detailByKey.player_stats;
      const fixtureEventRows = events ? buildEventRows(fixtureId, events) : [];
      const fixtureLineupRows = lineups ? buildLineupRows(fixtureId, lineups) : [];
      const fixtureStatisticRows = statistics ? buildStatisticRows(fixtureId, statistics) : [];
      const fixturePlayerStatRows = playerStats ? buildPlayerStatRows(fixtureId, playerStats, playerIdentityByApiId) : [];
      eventRows.push(...fixtureEventRows);
      lineupRows.push(...fixtureLineupRows);
      statisticRows.push(...fixtureStatisticRows);
      playerStatRows.push(...fixturePlayerStatRows);
      const existingResult = result.fixture_metadata_id ? resultByMetadataId.get(result.fixture_metadata_id) : undefined;
      if (Object.keys(detailByKey).length > 0) {
        enrichmentStatusRows.push(buildMergedEnrichmentStatusRow(result, existingResult, existingStatus, detailByKey, {
          events: events?.response.length ?? 0,
          lineups: lineups?.response.length ?? 0,
          statistics: statistics?.response.length ?? 0,
          player_stats: fixturePlayerStatRows.length,
        }));
      } else {
        enrichmentFixturesSkippedFully += 1;
      }

      const endpointSummary = Object.fromEntries(enrichmentEndpointSpecs.map((spec) => {
        const detail = detailByKey[spec.key];
        const parsedCount = spec.key === "player_stats" ? fixturePlayerStatRows.length : detail?.response.length ?? countForEndpoint(existingStatus, spec.key);
        const status = detail
          ? (spec.key === "player_stats" ? playerStatsStatus(detail, fixturePlayerStatRows.length) : detailStatus(detail))
          : statusForEndpoint(existingStatus, spec.key);
        return [spec.key, {
          status,
          source: endpointSources[spec.key],
          count: detail ? parsedCount : countForEndpoint(existingStatus, spec.key),
        }];
      }));
      enrichmentSummaries.push({
        api_football_fixture_id: fixtureId,
        trusted_existing_status: trustedStatus,
        endpoint_sources: endpointSources,
        endpoint_statuses: endpointSummary,
        api_endpoint_fetches: fetchedDetails.length,
        raw_cache_hits: Object.values(endpointSources).filter((value) => value === "raw_payload_cache_present").length,
        status_skip_count: Object.values(endpointSources).filter((value) => value === "status_present_skip").length,
        events: (endpointSummary as any).events.status,
        lineups: (endpointSummary as any).lineups.status,
        statistics: (endpointSummary as any).statistics.status,
        player_stats: (endpointSummary as any).player_stats.status,
        events_count: (endpointSummary as any).events.count,
        lineups_count: (endpointSummary as any).lineups.count,
        statistics_count: (endpointSummary as any).statistics.count,
        player_stats_count: (endpointSummary as any).player_stats.count,
        player_stats_api_team_rows: playerStats?.response.length ?? null,
        player_stats_mapped_internal_players: fixturePlayerStatRows.filter((row) => Boolean((row.source_snapshot as any)?.identity_mapping?.mapped)).length,
        errors: Object.values(detailByKey).filter((detail): detail is ApiResult => Boolean(detail && !detail.ok)).map((detail) => ({ endpoint: detail.endpoint, status: detail.status, errors: detail.errors })),
      });
    }
  }

  // FIFA ranking snapshot for the Article-13 final tiebreaker (fair-play inert pre-tournament -> {}). Mirrors the
  // conditional engine's aux so the stored standings rank agrees with the engine. Graceful: missing -> {} (stable order).
  const standingsFifaRank: Record<string, number> = {};
  try {
    const frRows = await supabaseRequest<{ team_code: string; fifa_rank: number }[]>(config, "fifa_world_rankings", { search: "?select=team_code,fifa_rank&ranking_snapshot_date=eq.2026-04-01" });
    for (const r of frRows) standingsFifaRank[r.team_code] = Number(r.fifa_rank);
  } catch (e) { warnings.push(`fifa_world_rankings load failed; standings ranked without the FIFA tiebreaker: ${(e as Error)?.message ?? e}`); }
  const standingsAux: Aux = { fairPlay: {}, fifaRank: standingsFifaRank };
  const standingsRows = deriveStandings(teams, fixtureMetadata, preparedResults, standingsAux);

  if (args.execute) {
    if (errors.length) throw new Error(`Execute blocked because fetch errors exist: ${errors.join("; ")}`);
    const upsertedMatchResults = await upsertRows(config, "match_results", preparedResults, "tournament_code,source_provider,api_football_fixture_id") as MatchResultRow[];
    const matchResultByApiFixtureId = new Map(
      [...existingResults, ...upsertedMatchResults]
        .filter((row) => row.api_football_fixture_id !== null && row.api_football_fixture_id !== undefined)
        .map((row) => [Number(row.api_football_fixture_id), row] as const),
    );
    const enrichmentStatusRowsForWrite = enrichmentStatusRows.map((row) => ({
      ...row,
      match_result_id: row.match_result_id ?? matchResultByApiFixtureId.get(Number(row.api_football_fixture_id))?.id ?? null,
    }));
    await upsertRows(config, "api_football_fixture_events", eventRows, "source_provider,fixture_id,source_event_hash");
    await upsertRows(config, "api_football_fixture_lineups", lineupRows, "source_provider,fixture_id,source_lineup_hash");
    await upsertRows(config, "api_football_fixture_statistics", statisticRows, "source_provider,fixture_id,source_stat_hash");
    await upsertRows(config, "api_football_fixture_player_stats", playerStatRows, "source_provider,fixture_id,source_player_stat_hash");
    await upsertRows(config, "wc2026_fixture_enrichment_status", enrichmentStatusRowsForWrite, "tournament_code,source_provider,api_football_fixture_id");
    await upsertRows(config, "wc2026_group_standings", standingsRows, "tournament_code,group_code,team_code");
    await supabaseRequest(config, "wc2026_result_ingestion_runs", {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({
        tournament_code: tournamentCode,
        dry_run: false,
        execute: true,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        fixtures_checked: allFixtures.length,
        finished_fixtures_seen: preparedResults.length,
        newly_ingested: wouldInsert + wouldUpdate,
        would_insert_results: wouldInsert,
        would_update_results: wouldUpdate,
        enrichment_attempted: enrichmentSummaries.filter((row) => Number((row as any).api_endpoint_fetches ?? 0) > 0 || Number((row as any).raw_cache_hits ?? 0) > 0).length,
        enrichment_present: enrichmentSummaries.filter((row) => JSON.stringify(row).includes("present")).length,
        enrichment_missing: enrichmentSummaries.filter((row) => JSON.stringify(row).includes("missing")).length,
        enrichment_fixtures_skipped_fully: enrichmentFixturesSkippedFully,
        enrichment_endpoint_api_fetches: enrichmentEndpointApiFetches,
        enrichment_endpoint_cache_hits: enrichmentEndpointCacheHits,
        enrichment_endpoint_status_skips: enrichmentEndpointStatusSkips,
        standings_rows_derived: standingsRows.length,
        api_requests_used: apiRequestsUsed,
        cache_files_written: cacheFilesWritten,
        source_payload_hash: fixtureFetch.response_hash,
        run_summary: { unchanged, enrichment_summaries: enrichmentSummaries, context_only_player_stats_rows: playerStatRows.length },
        errors,
        warnings,
      }),
    });
  }

  const afterCounts = Object.fromEntries(await Promise.all(protectedTables.map(async (table) => [table, await countRows(config, table)])));
  const resultCountAfter = await countRows(config, "match_results");
  const protectedDeltas = Object.fromEntries(protectedTables.map((table) => [table, (afterCounts[table] ?? 0) - (beforeCounts[table] ?? 0)]));

  const output = {
    project_id: worldCupProjectRef,
    dry_run: args.dryRun,
    execute: args.execute,
    task: "ingest_wc2026_results",
    fixtures_checked: allFixtures.length,
    finished_fixtures_seen: preparedResults.length,
    result_count_before: resultCountBefore,
    result_count_after: resultCountAfter,
    would_insert_results: wouldInsert,
    would_update_results: wouldUpdate,
    unchanged_existing_results: unchanged,
    enrichment_considered_finished_fixtures: args.includeEnrichment ? preparedResults.length : 0,
    enrichment_attempted_for_fixtures: enrichmentSummaries.filter((row) => Number((row as any).api_endpoint_fetches ?? 0) > 0 || Number((row as any).raw_cache_hits ?? 0) > 0).length,
    enrichment_fixtures_skipped_fully: enrichmentFixturesSkippedFully,
    enrichment_endpoint_api_fetches: enrichmentEndpointApiFetches,
    enrichment_endpoint_cache_hits: enrichmentEndpointCacheHits,
    enrichment_endpoint_status_skips: enrichmentEndpointStatusSkips,
    enrichment_endpoint_fetch_budget_note: "After the base /fixtures call, per-fixture detail calls are now endpoint-level: only newly/incompletely enriched endpoints fetch from API.",
    enrichment_rows_planned: {
      events: eventRows.length,
      lineups: lineupRows.length,
      statistics: statisticRows.length,
      player_stats: playerStatRows.length,
      enrichment_status: enrichmentStatusRows.length,
    },
    enrichment_summary_sample: enrichmentSummaries.slice(0, 3),
    player_stats_sample: playerStatRows.slice(0, 3).map((row) => ({
      fixture_id: row.fixture_id,
      team_name: row.team_name,
      player_id: row.player_id,
      player_name: row.player_name,
      position: row.position,
      rating: row.rating,
      minutes: row.minutes,
      shots_total: row.shots_total,
      passes_total: row.passes_total,
      tackles_total: row.tackles_total,
      cards_yellow: row.cards_yellow,
      mapped_internal_player_id: (row.source_snapshot as any)?.identity_mapping?.internal_player_id ?? null,
      prediction_input_allowed: (row.source_snapshot as any)?.materiality?.prediction_input_allowed ?? null,
    })),
    enrichment_tolerance_confirmed: true,
    player_stats_context_only: {
      endpoint: "/fixtures/players",
      target_table: "api_football_fixture_player_stats",
      materiality_gate: "context_only",
      rerun_triggered: false,
      prediction_input_allowed: false,
      does_not_feed: ["player_impact_snapshots", "team_strength_snapshots", "prediction_runs", "match_predictions"],
      identity_map_rows_available: playerIdentityRows.length,
    },
    standings_rows_derived: standingsRows.length,
    api_requests_used: apiRequestsUsed,
    cache_files_written: cacheFilesWritten,
    protected_row_count_deltas: protectedDeltas,
    current_best_changed: false,
    model_retraining: false,
    monte_carlo_writes: 0,
    odds_used: false,
    api_football_predictions_endpoint_used: false,
    fixture_sample: allFixtures.slice(0, 5).map((fixture) => ({
      api_football_fixture_id: fixture?.fixture?.id,
      date: fixture?.fixture?.date,
      round: fixture?.league?.round,
      status: fixture?.fixture?.status,
      teams: teamCodesFromFixture(fixture),
    })),
    finished_fixture_sample: preparedResults.slice(0, 5).map((row) => ({
      api_football_fixture_id: row.api_football_fixture_id,
      fixture_label: row.fixture_label,
      score: `${row.team_a_goals}-${row.team_b_goals}`,
      result: row.result,
      would_write: args.execute,
    })),
    warnings,
    errors,
  };

  console.log(JSON.stringify(output, null, 2));
  if (errors.length) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
