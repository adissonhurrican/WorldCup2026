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

// Step 1 — fetch. Exit 2 just means "no fixtures inside the window" (e.g. >7 days out or all past):
// not a failure — we still rebuild the overlay from whatever cache exists. Only a real crash (1) is logged.
const fetchStatus = spawnSync(node, [path.join(dir, "fetch-venue-weather.mjs"), "--fetch", "--all-imminent", "--window-hours", windowHours], { stdio: "inherit" }).status;
if (fetchStatus !== 0) console.error(`[refresh-weather] fetch exited ${fetchStatus} (likely no eligible fixtures); rebuilding overlay from existing cache.`);

// Step 2 — rebuild + sync the overlay. Its exit code is the wrapper's result.
const overlay = spawnSync(node, [path.join(dir, "build-weather-overlay.mjs"), "--write"], { stdio: "inherit" });
console.log("[refresh-weather] done (fetch -> overlay).");
process.exit(overlay.status ?? 0);
