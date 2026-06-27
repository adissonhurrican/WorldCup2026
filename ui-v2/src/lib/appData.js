// ============================================================================
// Data loader — the v2 UI reads the published `app-data.json` contract and the
// static display assets that go with it (the self-hosted flags, and an optional
// team-identity overlay). NO database, model, prediction/export logic, or
// client-side API-Football ever runs here. These are plain static reads.
//
// Project: ahcfrgxczbgdvrqmbisw
// ============================================================================

import {
  APP_DATA_REMOTE_URL, APP_DATA_FALLBACK_URL, APP_DATA_AUTHORITATIVE_URL,
  WEATHER_REMOTE_URL, WEATHER_FALLBACK_URL,
  SQUADS_REMOTE_URL, SQUADS_FALLBACK_URL,
} from "../config.js";
import { decodeGithubContentsJson, resolveAppDataSource } from "./appDataResolver.js";

const BASE = import.meta.env.BASE_URL;
const BUNDLED_APP_DATA = `${BASE}app-data.json`;
// CDNs are the fast path. GitHub Contents is the authoritative committed source used to escape the
// both-CDNs-stale-200 case; if that check fails, the loader degrades to the current freshest-CDN behavior.
const APP_DATA_CDNS = [APP_DATA_REMOTE_URL, APP_DATA_FALLBACK_URL].filter(Boolean);
const AUTHORITATIVE_APP_DATA = APP_DATA_AUTHORITATIVE_URL || "";
const APP_DATA_FETCH_TIMEOUT_MS = 8000;

// Cache-bust EVERY fetch (forces the current file from the Netlify/bundled copy; the CDNs largely ignore the
// query string, which is exactly why we compare freshness below rather than trusting one source's 200).
const bust = (u) => `${u}${u.includes("?") ? "&" : "?"}t=${Date.now()}`;

// Keep external app-data fetches bounded so a hung source cannot strand first paint.
function fetchWithTimeout(url, options = {}, timeoutMs = APP_DATA_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(id));
}

async function fetchJsonCandidate(source, url) {
  try {
    const res = await fetchWithTimeout(bust(url), { cache: "no-store" });
    if (!res.ok) throw new Error(`${source} app-data ${res.status}`);
    return { source, ok: true, data: await res.json() };
  } catch (e) {
    return { source, ok: false, error: e };
  }
}

async function fetchAuthoritativeAppData(url = AUTHORITATIVE_APP_DATA) {
  if (!url) return { source: "github_contents", ok: false, error: new Error("no authoritative source configured") };
  try {
    const res = await fetchWithTimeout(bust(url), {
      cache: "no-store",
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`github contents app-data ${res.status}`);
    const payload = await res.json();
    return {
      source: "github_contents",
      ok: true,
      data: decodeGithubContentsJson(payload),
      meta: { sha: payload && payload.sha },
    };
  } catch (e) {
    return { source: "github_contents", ok: false, error: e };
  }
}

// Fetch the first source that returns OK JSON; throws the LAST error only if EVERY source fails — which surfaces
// the same <LoadError> screen as before (no new failure mode). Used for the overlays (weather/squads).
async function fetchFirstOkJson(urls) {
  let lastErr = new Error("no data sources configured");
  for (const url of urls) {
    try {
      const res = await fetch(bust(url), { cache: "no-store" });
      if (res.ok) return await res.json();
      lastErr = new Error(`${url} -> ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// Load the published contract. If both CDNs are stale but GitHub Contents has a newer committed file, return
// the authoritative file. If GitHub Contents is unavailable, keep the previous freshest-CDN behavior.
export async function loadAppData() {
  const [cdnCandidates, authoritativeCandidate] = await Promise.all([
    Promise.all(APP_DATA_CDNS.map((u, i) => fetchJsonCandidate(i === 0 ? "jsdelivr" : "raw", u))),
    fetchAuthoritativeAppData(),
  ]);
  try {
    return resolveAppDataSource({ cdnCandidates, authoritativeCandidate }).data;
  } catch {
    // Fall through to bundled last-good.
  }
  const bundledCandidate = await fetchJsonCandidate("bundled", BUNDLED_APP_DATA);
  return resolveAppDataSource({ cdnCandidates, authoritativeCandidate, bundledCandidate }).data;
}

// Optional nickname overlay (public/nicknames.json), keyed by 3-letter code:
//   { "BIH": { "english": "The Dragons", "local": "Zmajevi" }, ... }
// Treated exactly like the flag assets — a display overlay, never a model input.
// Returns {} on any failure so a missing/blank file degrades gracefully.
export async function loadNicknames(url = `${BASE}nicknames.json`) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return {};
    const raw = await res.json();
    const out = {};
    for (const [code, val] of Object.entries(raw)) {
      if (code.startsWith("_")) continue; // skip _note / _format helper keys
      const english = (val && (val.english || val.en)) || "";
      const local = (val && (val.local || val.native)) || "";
      if (english || local) out[code] = { english, local };
    }
    return out;
  } catch (e) {
    return {};
  }
}

// Generic best-effort static JSON read (returns fallback on any failure).
async function loadJsonOr(url, fallback) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return fallback;
    return await res.json();
  } catch (e) {
    return fallback;
  }
}

// Ordered-source variant of loadJsonOr for the build-INDEPENDENT overlays (weather, squads): tries each source
// in order (jsDelivr → raw → Netlify-bundled) and returns the first OK JSON, so a build-skipping data commit
// still serves FRESH. Returns `fallback` only if EVERY source is unreachable. Optional overlay → NEVER throws
// (mirrors loadJsonOr's graceful contract).
async function loadOverlayFromSources(urls, fallback) {
  try {
    return await fetchFirstOkJson(urls.filter(Boolean));
  } catch {
    return fallback;
  }
}

// Static venue facts (altitude / roof / coordinates) — display/context only.
export function loadVenueFacts(url = `${BASE}venue-facts.json`) {
  return loadJsonOr(url, { byVenue: {}, byCity: {} });
}

export function loadVenues(url = `${BASE}venues.json`) {
  return loadJsonOr(url, {});
}

// Per-fixture weather forecast overlay — display only, empty until forecasts are fetched. RAW-first (it self-
// refreshes within its TTL and dodges jsDelivr's purge-lag), then jsDelivr, then the bundled copy.
export function loadWeather() {
  return loadOverlayFromSources([WEATHER_FALLBACK_URL, WEATHER_REMOTE_URL, `${BASE}weather.json`], {});
}

// Country identity colors for the prediction bar glass fill. Display-only; segment widths still come
// from app-data probabilities and this overlay is never a model/prediction input.
export function loadTeamColors(url = `${BASE}wc2026_team_colors.json`) {
  return loadJsonOr(url, { teams: {} });
}

// Live in-play scores — display only, fetched server-side by the livescore Netlify Function (the
// client never calls API-Football or holds the key). The function returns the SAME { as_of, matches }
// shape the old static live-scores.json used, edge-cached ~30s so API calls track the cache window, not
// user count. Returns { as_of, map } keyed by "HOME_AWAY". Empty when nothing is live. Orientation-
// agnostic: each match is also indexed under the reverse key with swapped scores, so a card that lists
// a fixture home/away-reversed vs the live provider still matches with the scores assigned correctly.
export async function loadLiveScores(url = `/.netlify/functions/livescore`) {
  const raw = await loadJsonOr(url, null);
  const map = {};
  const matches = raw && Array.isArray(raw.matches) ? raw.matches : [];
  for (const m of matches) {
    if (!m || !m.home || !m.away) continue;
    map[`${m.home}_${m.away}`] = m;
    const reverseKey = `${m.away}_${m.home}`;
    if (!map[reverseKey]) {
      map[reverseKey] = { ...m, home: m.away, away: m.home, home_score: m.away_score, away_score: m.home_score };
    }
  }
  return { as_of: (raw && raw.as_of) || null, map };
}

// Confirmed XIs — display only, fetched server-side by the lineups Netlify Function (the client never
// calls API-Football or holds the key), edge-cached ~5 min (lineups are quasi-static once posted). Returns
// { as_of, map } keyed by "HOME_AWAY". A fixture is absent until its lineup is posted, so the UI shows the
// placeholder. Orientation-agnostic like loadLiveScores: the function emits the provider's home/away, so we
// also index the reverse key with home_lineup/away_lineup swapped — a card listing a fixture reversed vs the
// provider still gets each side's XI placed correctly.
export async function loadLineups(url = `/.netlify/functions/lineups`) {
  const raw = await loadJsonOr(url, null);
  const map = {};
  const matches = raw && Array.isArray(raw.matches) ? raw.matches : [];
  for (const m of matches) {
    if (!m || !m.home || !m.away) continue;
    map[`${m.home}_${m.away}`] = m;
    const reverseKey = `${m.away}_${m.home}`;
    if (!map[reverseKey]) {
      map[reverseKey] = { ...m, home: m.away, away: m.home, home_lineup: m.away_lineup, away_lineup: m.home_lineup };
    }
  }
  return { as_of: (raw && raw.as_of) || null, map };
}

// Live per-team match stats (xG) — DESCRIPTIVE display only (a live match stat, separate from predictions),
// fetched server-side by the stats Netlify Function (the client never calls API-Football or holds the key),
// edge-cached ~60s (xG moves shot-by-shot, not second-by-second). Returns { as_of, map } keyed by
// "HOME_AWAY". A fixture is absent until the provider posts statistics, and drops when the match finishes.
// Orientation-agnostic like loadLiveScores: the reverse key is indexed with home_xg/away_xg swapped.
export async function loadStats(url = `/.netlify/functions/stats`) {
  const raw = await loadJsonOr(url, null);
  const map = {};
  const matches = raw && Array.isArray(raw.matches) ? raw.matches : [];
  for (const m of matches) {
    if (!m || !m.home || !m.away) continue;
    map[`${m.home}_${m.away}`] = m;
    const reverseKey = `${m.away}_${m.home}`;
    if (!map[reverseKey]) {
      map[reverseKey] = { ...m, home: m.away, away: m.home, home_xg: m.away_xg, away_xg: m.home_xg };
    }
  }
  return { as_of: (raw && raw.as_of) || null, map };
}

// Goal/card timeline events — display only, fetched server-side by the events Netlify Function (the client
// never calls API-Football or holds the key), edge-cached ~30s (near-live). Returns { as_of, map } keyed by
// "HOME_AWAY". Orientation-agnostic like loadLiveScores: the function emits the provider's home/away, so we
// also index the reverse key (each event is team-tagged, so the events array needs no swap). Live-only: a
// fixture drops from the feed when it finishes (the card then shows our verified result).
export async function loadEvents(url = `/.netlify/functions/events`) {
  const raw = await loadJsonOr(url, null);
  const map = {};
  const matches = raw && Array.isArray(raw.matches) ? raw.matches : [];
  for (const m of matches) {
    if (!m || !m.home || !m.away) continue;
    map[`${m.home}_${m.away}`] = m;
    const reverseKey = `${m.away}_${m.home}`;
    if (!map[reverseKey]) map[reverseKey] = { ...m, home: m.away, away: m.home };
  }
  return { as_of: (raw && raw.as_of) || null, map };
}

// Squad rosters — display only, built server-side by build-squads-json.mjs. Returns a map keyed by
// FIFA team code -> array of players { name, position, position_group, number, club, age, status }.
// Per-player status (goals/cards/minutes) is 0 until WC matches play. Returns {} on any failure.
export async function loadSquads() {
  // RAW-first (it self-refreshes within its TTL and dodges jsDelivr's purge-lag), then jsDelivr, then bundled.
  const raw = await loadOverlayFromSources([SQUADS_FALLBACK_URL, SQUADS_REMOTE_URL, `${BASE}squads.json`], null);
  return (raw && raw.teams && typeof raw.teams === "object") ? raw.teams : {};
}

// Load the contract + the static display overlays (nicknames, venue facts, venues, weather, squads,
// team colors). All overlays are read like the flag assets — display only, never model inputs.
export async function loadAll() {
  const [data, nicks, venueFacts, venues, weather, squads, teamColors] = await Promise.all([
    loadAppData(),
    loadNicknames(),
    loadVenueFacts(),
    loadVenues(),
    loadWeather(),
    loadSquads(),
    loadTeamColors(),
  ]);
  for (const t of data.teams || []) {
    if (nicks[t.code]) t.nickname = nicks[t.code];
  }
  data.__venueFacts = venueFacts || { byVenue: {}, byCity: {} };
  data.__venues = venues || {};
  data.__weather = weather || {};
  data.__squads = squads || {};
  data.__teamColors = (teamColors && teamColors.teams) || {};

  // Merge the 32 knockout fixtures (slot-based, no teams yet) into the unified fixtures list so the Matches
  // tab shows + filters them like the group games. group:null marks them knockout (isKnockoutFixture), and
  // knockout:true lets the view pick the slot-label card. teamFixtures excludes them (no home/away) until the
  // post-group resolver fills real teams. The original data.knockout_fixtures stays available too.
  if (Array.isArray(data.knockout_fixtures) && data.knockout_fixtures.length) {
    const ko = data.knockout_fixtures.map((k) => ({ ...k, group: null, knockout: true }));
    data.fixtures = [...(data.fixtures || []), ...ko];
  }
  return data;
}
