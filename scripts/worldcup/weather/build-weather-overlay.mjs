#!/usr/bin/env node
// Build the UI weather overlay (ui-v2/public/weather.json) from the local Open-Meteo
// forecast cache. DISPLAY ONLY — prediction_input_allowed:false; never a model input.
// Maps each cached fixture forecast -> the app-data fixture key "HOME_AWAY".
// API-Football home/away can differ from the app/export orientation, so the
// overlay must resolve fixture_id back to the canonical app fixture row before
// writing weather.json.
// Dry-run by default; pass --write to actually write the overlay.
//
//   node scripts/worldcup/weather/build-weather-overlay.mjs            # dry-run
//   node scripts/worldcup/weather/build-weather-overlay.mjs --write    # write overlay
//
// Project: ahcfrgxczbgdvrqmbisw
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const PROJECT_REF = "ahcfrgxczbgdvrqmbisw";
const ROOT = process.cwd();
const WEATHER_CACHE_DIR = path.join(ROOT, "data", "external", "weather", "cache");
const FIXTURE_CACHE = path.join(ROOT, "data", "external", "api-football", "cache", "fixtures_league1_season2026.json");
const TEAM_MAP = path.join(ROOT, "scripts", "worldcup", "live", "api-team-code-map.json");
const APP_DATA = path.join(ROOT, "data", "exports", "app-data.json");
// Sync to every UI location (same pattern as squads/lineups): canonical export + both UIs + the built dist.
const OUT_FILES = [
  path.join(ROOT, "data", "exports", "weather.json"),
  path.join(ROOT, "ui", "weather.json"),
  path.join(ROOT, "ui-v2", "public", "weather.json"),
  path.join(ROOT, "ui-v2", "dist", "weather.json"),
];

const write = process.argv.includes("--write");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

function normIso(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function pairKey(a, b) {
  return [a, b].sort().join("_");
}

function appFixtureIndex() {
  const app = readJson(APP_DATA);
  const fixtures = app.fixtures ?? app.matches ?? [];
  const byPair = new Map();
  for (const fx of fixtures) {
    if (!fx.home || !fx.away) continue;
    const item = {
      key: `${fx.home}_${fx.away}`,
      home: fx.home,
      away: fx.away,
      kickoff: normIso(fx.kickoff_utc ?? fx.kickoff),
      venue: fx.venue ?? null,
    };
    const key = pairKey(fx.home, fx.away);
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(item);
  }
  return byPair;
}

function fixtureIdToAppFixture() {
  const map = readJson(TEAM_MAP);
  const idToCode = Array.isArray(map) ? Object.fromEntries(map) : map;
  const appByPair = appFixtureIndex();
  const payload = readJson(FIXTURE_CACHE);
  const rows = payload?.response?.response ?? payload?.response ?? [];
  const out = new Map();
  const diagnostics = {
    api_fixture_count: rows.length,
    app_pair_count: appByPair.size,
    reversed_order_fixture_ids: [],
    ambiguous_fixture_ids: [],
    missing_app_fixture_ids: [],
  };
  for (const r of rows) {
    const apiHome = idToCode[String(r.teams?.home?.id)];
    const apiAway = idToCode[String(r.teams?.away?.id)];
    const fixtureId = r.fixture?.id;
    if (!fixtureId || !apiHome || !apiAway) continue;

    const candidates = appByPair.get(pairKey(apiHome, apiAway)) ?? [];
    const apiKickoff = normIso(r.fixture?.date);
    const exact = candidates.filter((fx) => !apiKickoff || fx.kickoff === apiKickoff);
    const appFx = exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : null;
    if (!appFx) {
      if (candidates.length > 1 || exact.length > 1) diagnostics.ambiguous_fixture_ids.push(fixtureId);
      else diagnostics.missing_app_fixture_ids.push(fixtureId);
      continue;
    }

    if (appFx.home !== apiHome || appFx.away !== apiAway) {
      diagnostics.reversed_order_fixture_ids.push({
        fixture_id: fixtureId,
        api_key: `${apiHome}_${apiAway}`,
        app_key: appFx.key,
      });
    }
    out.set(fixtureId, {
      key: appFx.key,
      home: appFx.home,
      away: appFx.away,
      api_home: apiHome,
      api_away: apiAway,
    });
  }
  return { map: out, diagnostics };
}

function main() {
  const result = {
    project_ref: PROJECT_REF,
    task: "build_weather_overlay",
    dry_run: !write,
    prediction_input_allowed: false,
    weather_is_display_only: true,
    cache_dir: path.relative(ROOT, WEATHER_CACHE_DIR),
    out_files: OUT_FILES.map((p) => path.relative(ROOT, p)),
    cache_records: 0,
    mapped: 0,
    unmapped: [],
    keys: [],
  };

  const { map: fixtureKeys, diagnostics } = fixtureIdToAppFixture();
  result.fixture_mapping = diagnostics;
  const overlay = {
    _note: "Per-fixture weather forecast overlay (display-only; never a model input). Keyed by HOME_AWAY. Generated from the Open-Meteo cache by build-weather-overlay.mjs.",
  };

  if (existsSync(WEATHER_CACHE_DIR)) {
    const files = readdirSync(WEATHER_CACHE_DIR).filter((f) => f.startsWith("open_meteo_fixture_") && f.endsWith(".json"));
    result.cache_records = files.length;
    // newest record per fixture wins (filenames carry a sortable retrieved-at stamp)
    files.sort();
    for (const f of files) {
      const rec = readJson(path.join(WEATHER_CACHE_DIR, f));
      const appFx = rec.fixture_id != null ? fixtureKeys.get(rec.fixture_id) : null;
      if (!appFx) {
        result.unmapped.push(rec.fixture_id ?? f);
        continue;
      }
      const fc = rec.forecast || {};
      overlay[appFx.key] = {
        temp_c: fc.temperature_2m_c ?? null,
        feels_like_c: fc.apparent_temperature_c ?? null,
        condition: fc.weather_code_label ?? null,
        code: fc.weather_code ?? null,
        precip_chance_pct: fc.precipitation_probability_pct ?? null,
        precip_mm: fc.precipitation_mm ?? null,
        wind_kmh: fc.wind_speed_10m_kmh ?? null,
        humidity_pct: fc.relative_humidity_2m_pct ?? null,
        forecast_for: rec.forecast_for ?? null,
        retrieved_at: rec.retrieved_at ?? null,
        lead_hours: rec.forecast_lead_hours ?? null,
        confidence: rec.confidence ?? "low",
      };
    }
  }

  result.keys = Object.keys(overlay).filter((k) => !k.startsWith("_"));
  result.mapped = result.keys.length;

  if (write) {
    const json = `${JSON.stringify(overlay, null, 2)}\n`;
    result.written = [];
    for (const out of OUT_FILES) {
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, json, "utf8");
      result.written.push(path.relative(ROOT, out));
    }
    result.wrote = true;
  } else {
    result.note = "Dry-run: no file written. Re-run with --write once forecasts have been fetched (fetch-venue-weather.mjs --fetch --all-imminent --window-hours 168).";
  }

  console.log(JSON.stringify(result, null, 2));
}

main();
