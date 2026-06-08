#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PROJECT_REF = 'ahcfrgxczbgdvrqmbisw';
const ROOT = process.cwd();
const STADIUM_FACTS_PATH = path.join(ROOT, 'data', 'external', 'venues', 'stadium_facts_static_v1.json');
const FIXTURE_CACHE_PATH = path.join(ROOT, 'data', 'external', 'api-football', 'cache', 'fixtures_league1_season2026.json');
const WEATHER_CACHE_DIR = path.join(ROOT, 'data', 'external', 'weather', 'cache');
const OPEN_METEO_BASE_URL = 'https://api.open-meteo.com/v1/forecast';
const WEATHER_CONTEXT_NOTE = 'forecast context only; does not move probabilities';
const WEATHER_FIELDS = [
  'temperature_2m',
  'apparent_temperature',
  'relative_humidity_2m',
  'precipitation_probability',
  'precipitation',
  'wind_speed_10m',
  'wind_direction_10m',
  'weather_code',
];

// Open-Meteo provides 7 days of forecast for free; accuracy degrades with lead time, so we stamp an
// honest confidence from how far ahead of kickoff the forecast was fetched. Re-running closer to
// kickoff (scheduled refresh) lifts the confidence as the forecast firms up.
function confidenceFromLeadHours(h) {
  if (h == null) return 'low';
  if (h <= 48) return 'high';      // ≤2 days out — reliable
  if (h <= 96) return 'medium';    // 2–4 days — firming up
  return 'low';                    // 5–7 days — early, may change
}

function parseArgs(argv) {
  const parsed = {
    dryRun: true,
    fetch: false,
    fixtureIds: [],
    allImminent: false,
    windowHours: 168, // 7 days — Open-Meteo's free forecast horizon (was 72h)
    now: new Date(),
    probeApiShape: false,
    writeProbeCache: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--fetch') {
      parsed.fetch = true;
      parsed.dryRun = false;
    } else if (arg === '--dry-run') {
      parsed.dryRun = true;
      parsed.fetch = false;
    } else if (arg === '--probe-api-shape') parsed.probeApiShape = true;
    else if (arg === '--write-probe-cache') parsed.writeProbeCache = true;
    else if (arg === '--all-imminent') parsed.allImminent = true;
    else if (arg === '--fixture-id') parsed.fixtureIds.push(Number(argv[++i]));
    else if (arg === '--fixture-ids') {
      parsed.fixtureIds.push(...String(argv[++i]).split(',').map((value) => Number(value.trim())).filter(Boolean));
    } else if (arg === '--window-hours') parsed.windowHours = Number(argv[++i]);
    else if (arg === '--now') parsed.now = new Date(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (Number.isNaN(parsed.windowHours) || parsed.windowHours <= 0) {
    throw new Error('--window-hours must be a positive number');
  }
  if (Number.isNaN(parsed.now.getTime())) {
    throw new Error('--now must be a valid ISO timestamp');
  }
  return parsed;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/worldcup/weather/fetch-venue-weather.mjs --dry-run --fixture-id 1489369',
    '  node scripts/worldcup/weather/fetch-venue-weather.mjs --probe-api-shape',
    '  node scripts/worldcup/weather/fetch-venue-weather.mjs --fetch --all-imminent --window-hours 168',
    '',
    'Defaults:',
    '  --dry-run is default and performs no forecast fetches/caches.',
    '  --fetch is required to call Open-Meteo for actual fixture forecasts and write local cache files.',
    '  --probe-api-shape performs one non-fixture Open-Meteo shape probe and does not write cache unless --write-probe-cache is also set.',
    '',
    'Guardrails:',
    '  Weather is AI narration context only; never a prediction input.',
    '  The script refuses fixture forecast fetches outside the imminent window.',
  ].join('\n');
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function isoCompact(value) {
  return value.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function loadStadiumFacts() {
  const artifact = readJson(STADIUM_FACTS_PATH);
  const venueByFixtureName = new Map();
  for (const venue of artifact.venues ?? []) {
    if (venue.latitude == null || venue.longitude == null) {
      throw new Error(`Missing coordinates for venue ${venue.fixture_venue_name}`);
    }
    venueByFixtureName.set(venue.fixture_venue_name, venue);
  }
  return { artifact, venueByFixtureName };
}

function loadFixtures() {
  const payload = readJson(FIXTURE_CACHE_PATH);
  const fixtures = payload?.response?.response ?? payload?.response ?? [];
  if (!Array.isArray(fixtures)) throw new Error('Fixture cache shape is not an array');
  return fixtures.map((row) => ({
    fixture_id: row.fixture?.id,
    kickoff_utc: row.fixture?.date,
    kickoff: new Date(row.fixture?.date),
    round: row.league?.round ?? null,
    home_team: row.teams?.home?.name ?? null,
    away_team: row.teams?.away?.name ?? null,
    api_football_venue: {
      id: row.fixture?.venue?.id ?? null,
      name: row.fixture?.venue?.name ?? null,
      city: row.fixture?.venue?.city ?? null,
    },
    raw: row,
  }));
}

function selectFixtures(fixtures, args) {
  if (args.fixtureIds.length > 0) {
    const wanted = new Set(args.fixtureIds);
    return fixtures.filter((fixture) => wanted.has(fixture.fixture_id));
  }
  if (args.allImminent) return fixtures;
  return [fixtures[0]];
}

function decorateFixture(fixture, venue, now, windowHours) {
  const hours_until_kickoff = (fixture.kickoff.getTime() - now.getTime()) / (60 * 60 * 1000);
  const within_imminent_window = hours_until_kickoff >= 0 && hours_until_kickoff <= windowHours;
  const window_status = within_imminent_window
    ? 'eligible_for_fetch'
    : hours_until_kickoff < 0
      ? 'kickoff_in_past'
      : 'outside_imminent_window';

  return {
    fixture_id: fixture.fixture_id,
    kickoff_utc: fixture.kickoff_utc,
    hours_until_kickoff: Number(hours_until_kickoff.toFixed(2)),
    within_imminent_window,
    window_status,
    round: fixture.round,
    home_team: fixture.home_team,
    away_team: fixture.away_team,
    venue,
  };
}

function buildForecastUrl(venue, fixtureDate) {
  const date = fixtureDate.toISOString().slice(0, 10);
  const url = new URL(OPEN_METEO_BASE_URL);
  url.searchParams.set('latitude', String(venue.latitude));
  url.searchParams.set('longitude', String(venue.longitude));
  url.searchParams.set('hourly', WEATHER_FIELDS.join(','));
  url.searchParams.set('timezone', 'UTC');
  url.searchParams.set('start_date', date);
  url.searchParams.set('end_date', date);
  url.searchParams.set('wind_speed_unit', 'kmh');
  url.searchParams.set('temperature_unit', 'celsius');
  url.searchParams.set('precipitation_unit', 'mm');
  return url;
}

function weatherCodeLabel(code) {
  const labels = new Map([
    [0, 'clear sky'],
    [1, 'mainly clear'],
    [2, 'partly cloudy'],
    [3, 'overcast'],
    [45, 'fog'],
    [48, 'depositing rime fog'],
    [51, 'light drizzle'],
    [53, 'moderate drizzle'],
    [55, 'dense drizzle'],
    [61, 'slight rain'],
    [63, 'moderate rain'],
    [65, 'heavy rain'],
    [80, 'slight rain showers'],
    [81, 'moderate rain showers'],
    [82, 'violent rain showers'],
    [95, 'thunderstorm'],
    [96, 'thunderstorm with slight hail'],
    [99, 'thunderstorm with heavy hail'],
  ]);
  return labels.get(Number(code)) ?? 'unknown weather code';
}

function nearestHourlyIndex(times, targetDate) {
  if (!Array.isArray(times) || times.length === 0) return -1;
  const target = targetDate.getTime();
  let bestIndex = -1;
  let bestDelta = Infinity;
  for (let i = 0; i < times.length; i += 1) {
    const time = new Date(`${times[i]}Z`).getTime();
    const delta = Math.abs(time - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function extractHourlyForecast(response, targetDate) {
  const hourly = response.hourly ?? {};
  const idx = nearestHourlyIndex(hourly.time, targetDate);
  if (idx < 0) throw new Error('Open-Meteo response did not include hourly time values');
  const rawCode = hourly.weather_code?.[idx] ?? null;
  return {
    forecast_hour_utc: `${hourly.time[idx]}:00Z`,
    temperature_2m_c: hourly.temperature_2m?.[idx] ?? null,
    apparent_temperature_c: hourly.apparent_temperature?.[idx] ?? null,
    relative_humidity_2m_pct: hourly.relative_humidity_2m?.[idx] ?? null,
    precipitation_probability_pct: hourly.precipitation_probability?.[idx] ?? null,
    precipitation_mm: hourly.precipitation?.[idx] ?? null,
    wind_speed_10m_kmh: hourly.wind_speed_10m?.[idx] ?? null,
    wind_direction_10m_deg: hourly.wind_direction_10m?.[idx] ?? null,
    weather_code: rawCode,
    weather_code_label: rawCode == null ? 'unknown' : weatherCodeLabel(rawCode),
  };
}

function summarizeForecast(forecast) {
  const parts = [];
  if (forecast.temperature_2m_c != null) parts.push(`${Math.round(forecast.temperature_2m_c)}C`);
  if (forecast.apparent_temperature_c != null) parts.push(`feels ${Math.round(forecast.apparent_temperature_c)}C`);
  if (forecast.relative_humidity_2m_pct != null) parts.push(`${Math.round(forecast.relative_humidity_2m_pct)}% humidity`);
  if (forecast.precipitation_probability_pct != null) parts.push(`${Math.round(forecast.precipitation_probability_pct)}% precipitation chance`);
  if (forecast.wind_speed_10m_kmh != null) parts.push(`${Math.round(forecast.wind_speed_10m_kmh)} km/h wind`);
  if (forecast.weather_code_label && forecast.weather_code_label !== 'unknown') parts.push(forecast.weather_code_label);
  return parts.length
    ? `Forecast suggests ${parts.join(', ')}. This is narration context only and does not move probabilities.`
    : 'Forecast data is incomplete. Treat weather as unknown narration context only.';
}

function buildWeatherCacheRecord({ fixture, venue, url, response, retrievedAt, probe = false }) {
  const forecast_for = probe ? retrievedAt.toISOString() : fixture.kickoff_utc;
  const forecast = extractHourlyForecast(response, new Date(forecast_for));
  const lead_hours = probe ? null : (new Date(fixture.kickoff_utc).getTime() - retrievedAt.getTime()) / 3.6e6;
  const confidence = confidenceFromLeadHours(lead_hours);
  const source_payload_hash = sha256(JSON.stringify(response));
  const source_id = probe
    ? `open_meteo:probe:${venue.venue_key}:${isoCompact(retrievedAt)}`
    : `open_meteo:fixture:${fixture.fixture_id}:${isoCompact(retrievedAt)}`;

  return {
    provider: 'open_meteo',
    project_ref: PROJECT_REF,
    fixture_id: probe ? null : fixture.fixture_id,
    probe,
    forecast_for,
    retrieved_at: retrievedAt.toISOString(),
    forecast_lead_hours: lead_hours == null ? null : Number(lead_hours.toFixed(1)),
    confidence,
    context_note: WEATHER_CONTEXT_NOTE,
    prediction_input_allowed: false,
    source_id,
    source_url: url.toString(),
    source_payload_hash,
    venue: {
      venue_key: venue.venue_key,
      venue_name: venue.venue_name,
      fixture_venue_name: venue.fixture_venue_name,
      host_market: venue.host_market,
      latitude: venue.latitude,
      longitude: venue.longitude,
      altitude_m: venue.altitude_m,
      roof: venue.roof,
      roof_operation: venue.roof_operation,
      venue_context_note: venue.context_note,
      prediction_input_allowed: venue.prediction_input_allowed,
    },
    forecast,
    units: response.hourly_units ?? {},
    ai_weather_context: {
      status: 'forecast_available',
      provider: 'open_meteo',
      source_id,
      source_url: url.toString(),
      retrieved_at: retrievedAt.toISOString(),
      forecast_for,
      forecast_lead_hours: lead_hours == null ? null : Number(lead_hours.toFixed(1)),
      confidence,
      summary: summarizeForecast(forecast),
      fields: forecast,
      context_note: WEATHER_CONTEXT_NOTE,
      prediction_input_allowed: false,
    },
  };
}

function cachePathFor(record) {
  const base = record.probe
    ? `open_meteo_probe_${record.venue.venue_key}_${isoCompact(new Date(record.retrieved_at))}.json`
    : `open_meteo_fixture_${record.fixture_id}_${isoCompact(new Date(record.retrieved_at))}.json`;
  return path.join(WEATHER_CACHE_DIR, base);
}

async function fetchForecast(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'world-cup-prediction-weather-context/1.0' },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function runProbe(venueByFixtureName, writeProbeCache) {
  const venue = venueByFixtureName.get('Estadio Azteca') ?? [...venueByFixtureName.values()][0];
  const retrievedAt = new Date();
  const url = new URL(OPEN_METEO_BASE_URL);
  url.searchParams.set('latitude', String(venue.latitude));
  url.searchParams.set('longitude', String(venue.longitude));
  url.searchParams.set('hourly', WEATHER_FIELDS.join(','));
  url.searchParams.set('timezone', 'UTC');
  url.searchParams.set('forecast_days', '1');
  url.searchParams.set('wind_speed_unit', 'kmh');
  url.searchParams.set('temperature_unit', 'celsius');
  url.searchParams.set('precipitation_unit', 'mm');
  const response = await fetchForecast(url);
  const record = buildWeatherCacheRecord({
    fixture: null,
    venue,
    url,
    response,
    retrievedAt,
    probe: true,
  });

  let written = null;
  if (writeProbeCache) {
    mkdirSync(WEATHER_CACHE_DIR, { recursive: true });
    written = cachePathFor(record);
    writeFileSync(written, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  }

  return {
    probe_api_shape: 'ok',
    provider: 'open_meteo',
    probe_venue: venue.fixture_venue_name,
    fields_requested: WEATHER_FIELDS,
    parsed_forecast_fields: Object.keys(record.forecast),
    ai_weather_context_keys: Object.keys(record.ai_weather_context),
    cache_written: Boolean(written),
    cache_file: written ? path.relative(ROOT, written) : null,
    context_note: WEATHER_CONTEXT_NOTE,
    prediction_input_allowed: false,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const { venueByFixtureName } = loadStadiumFacts();
  const fixtures = loadFixtures();
  const selected = selectFixtures(fixtures, args);
  const missingSelections = args.fixtureIds.filter((id) => !selected.some((fixture) => fixture.fixture_id === id));
  if (missingSelections.length > 0) {
    throw new Error(`Fixture IDs not found in cache: ${missingSelections.join(', ')}`);
  }

  const fixturePlan = selected.map((fixture) => {
    const venue = venueByFixtureName.get(fixture.api_football_venue.name);
    if (!venue) throw new Error(`No venue context found for ${fixture.api_football_venue.name}`);
    return decorateFixture(fixture, venue, args.now, args.windowHours);
  });

  const imminentPlan = fixturePlan.filter((item) => item.within_imminent_window);
  const outsideWindow = fixturePlan.filter((item) => !item.within_imminent_window);
  const result = {
    project_ref: PROJECT_REF,
    dry_run: args.dryRun,
    fetch_requested: args.fetch,
    task: 'fetch_venue_weather',
    source_files: {
      stadium_facts: path.relative(ROOT, STADIUM_FACTS_PATH),
      fixture_cache: path.relative(ROOT, FIXTURE_CACHE_PATH),
    },
    weather_cache_dir: path.relative(ROOT, WEATHER_CACHE_DIR),
    context_policy: {
      context_note: WEATHER_CONTEXT_NOTE,
      prediction_input_allowed: false,
      weather_is_narration_context_only: true,
      weather_never_moves_probabilities: true,
      no_model_or_prediction_wiring: true,
    },
    imminent_window_hours: args.windowHours,
    now: args.now.toISOString(),
    selected_fixture_count: fixturePlan.length,
    eligible_fixture_count: imminentPlan.length,
    outside_window_fixture_count: outsideWindow.length,
    fixtures: fixturePlan.map((item) => ({
      fixture_id: item.fixture_id,
      kickoff_utc: item.kickoff_utc,
      hours_until_kickoff: item.hours_until_kickoff,
      window_status: item.window_status,
      teams: `${item.home_team} vs ${item.away_team}`,
      venue_name: item.venue.fixture_venue_name,
      latitude: item.venue.latitude,
      longitude: item.venue.longitude,
      altitude_m: item.venue.altitude_m,
      context_note: WEATHER_CONTEXT_NOTE,
      prediction_input_allowed: false,
    })),
    cache_files_written: [],
    api_requests_made: 0,
    live_weather_fetches_for_wc_fixtures: 0,
    warnings: [],
    db_writes: 0,
    prediction_model_changes: 0,
    odds_used: false,
  };

  if (args.probeApiShape) {
    result.probe = await runProbe(venueByFixtureName, args.writeProbeCache);
    result.api_requests_made += 1;
    if (result.probe.cache_file) result.cache_files_written.push(result.probe.cache_file);
  }

  if (args.dryRun) {
    result.warnings.push('Dry-run mode: no fixture forecasts fetched and no fixture weather cache files written.');
    if (outsideWindow.length > 0) {
      result.warnings.push(`${outsideWindow.length} selected fixture(s) are outside the ${args.windowHours}h imminent forecast window.`);
    }
    result.matchday_trigger = 'Run with --fetch --all-imminent --window-hours 168 (7-day window) — opener fixtures become eligible ~June 4-5, 2026; then repeat daily (more often near kickoff) so confidence rises as the forecast firms up.';
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!args.fetch) {
    throw new Error('Internal guard: non-dry-run requires --fetch');
  }
  if (imminentPlan.length === 0) {
    result.warnings.push('No selected fixtures are inside the imminent forecast window; refusing to fetch fixture forecasts.');
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 2;
    return;
  }

  mkdirSync(WEATHER_CACHE_DIR, { recursive: true });
  for (const item of imminentPlan) {
    const fixture = fixtures.find((row) => row.fixture_id === item.fixture_id);
    const url = buildForecastUrl(item.venue, fixture.kickoff);
    const response = await fetchForecast(url);
    result.api_requests_made += 1;
    result.live_weather_fetches_for_wc_fixtures += 1;
    const record = buildWeatherCacheRecord({
      fixture,
      venue: item.venue,
      url,
      response,
      retrievedAt: new Date(),
      probe: false,
    });
    const filePath = cachePathFor(record);
    writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    result.cache_files_written.push(path.relative(ROOT, filePath));
  }

  if (outsideWindow.length > 0) {
    result.warnings.push(`${outsideWindow.length} selected fixture(s) were refused because they are outside the ${args.windowHours}h imminent forecast window.`);
  }
  result.matchday_trigger = 'Run with --fetch --all-imminent --window-hours 168 (7-day window) — opener fixtures become eligible ~June 4-5, 2026; then repeat daily (more often near kickoff) so confidence rises as the forecast firms up.';
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1].replaceAll('\\', '/')}` || process.argv[1]?.endsWith('fetch-venue-weather.mjs')) {
  main().catch((error) => {
    console.error(JSON.stringify({
      project_ref: PROJECT_REF,
      error: error.message,
      db_writes: 0,
      prediction_model_changes: 0,
      odds_used: false,
    }, null, 2));
    process.exit(1);
  });
}
