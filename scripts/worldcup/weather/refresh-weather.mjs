#!/usr/bin/env node
// refresh-weather.mjs — one-shot weather refresh for cron / GitHub Actions.
// Step 1: fetch the 7-day (168h) Open-Meteo forecast for every fixture inside the window.
// Step 2: rebuild the UI overlay weather.json (synced to data/exports + both UIs + dist).
// Confidence is stamped from lead time and rises as kickoff nears across repeated runs.
// DISPLAY-ONLY — never a model/prediction input; no DB writes, no API key (Open-Meteo non-commercial).
// Project: ahcfrgxczbgdvrqmbisw
//
//   node scripts/worldcup/weather/refresh-weather.mjs                 # fetch (7d) + rebuild overlay
//   node scripts/worldcup/weather/refresh-weather.mjs --window-hours 168
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const node = process.execPath;
const argv = process.argv.slice(2);
const wIdx = argv.indexOf("--window-hours");
const windowHours = wIdx >= 0 ? argv[wIdx + 1] : "168";

// Step 1 — fetch fresh forecasts into the cache. fetch-venue-weather.mjs exit codes:
//   0  = fetched real forecasts (cache populated)                  -> rebuild + write the overlay
//   2  = 0 eligible fixtures inside the window (legitimate no-op)   -> leave the existing weather.json UNTOUCHED, exit 0
//   else (1 / killed-by-signal -> null) = the fetch CRASHED         -> ABORT: do NOT rebuild, do NOT overwrite the
//        existing overlay, and exit NON-ZERO so the workflow shows RED. (A missing input or network error must surface
//        as a real failure, never be buried in a green run.)
// PRINCIPLE: only write weather.json when the fetch actually SUCCEEDED with data. NEVER overwrite good data with empty
// as a side effect of a failure — leave the last-good overlay in place.
const fetchStatus = spawnSync(node, [path.join(dir, "fetch-venue-weather.mjs"), "--fetch", "--all-imminent", "--window-hours", windowHours], { stdio: "inherit" }).status;

if (fetchStatus === 2) {
  console.log("[refresh-weather] fetch reported 0 eligible fixtures in the window — leaving the existing weather.json untouched (legitimate no-op).");
  process.exit(0);
}
if (fetchStatus !== 0) {
  console.error(`[refresh-weather] fetch FAILED (exit ${fetchStatus === null ? "killed-by-signal" : fetchStatus}) — ABORTING. Overlay NOT rebuilt; existing weather.json left intact. Failing the run (non-zero) so it surfaces as RED, not a silent green.`);
  process.exit(fetchStatus || 1);
}

// Step 2 — fetch SUCCEEDED with real data -> rebuild + sync the overlay from the freshly-populated cache.
const overlay = spawnSync(node, [path.join(dir, "build-weather-overlay.mjs"), "--write"], { stdio: "inherit" });
console.log("[refresh-weather] done (fetch -> overlay).");
process.exit(overlay.status ?? 0);
