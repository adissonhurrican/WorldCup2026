/* netlify/functions/livescore.mjs — LIVE in-play scores for the match cards (display-only).
 *
 * PROJECT: ahcfrgxczbgdvrqmbisw
 *
 * WHY THIS EXISTS
 *   The static stack (GitHub -> Netlify -> Cloudflare) cannot refresh live-scores.json every ~30s.
 *   This serverless function fetches API-Football's live in-play feed SERVER-SIDE and returns it in
 *   the exact shape the UI's loadLiveScores() reads ({ as_of, matches:[...] }). The UI polls this
 *   endpoint (/.netlify/functions/livescore) instead of the empty static file.
 *
 * THE LOAD-BEARING RULE — EDGE CACHING (do not remove):
 *   The response sets Cache-Control: s-maxage=30 (and Netlify-CDN-Cache-Control), so repeat polls are
 *   served from the EDGE (Cloudflare + Netlify CDN), not from a fresh API-Football call each time.
 *   => API-Football calls track the ~30s cache-miss rate, NOT the number of users. One fetch per ~30s
 *   window serves everyone. Without this, N concurrent users polling 30s would scale 1:1 into the
 *   75k/day quota (1,000 users => quota gone in <40 min). With it: ~1,200-2,880 calls/day total.
 *   A module-scope throttle below is a BONUS (warm-instance) layer; the edge cache is the primary
 *   quota protection because cold starts reset the in-memory layer.
 *
 * GUARDRAILS (mirrors write-live-scores.ts):
 *   - DISPLAY-ONLY. Never a prediction input; writes no DB/result/standing; only /fixtures?live=all.
 *   - The API key (API_FOOTBALL_KEY) is read from process.env and used ONLY in the upstream request
 *     header. It is NEVER included in the response — it stays server-side, never reaches the browser.
 *   - Fail-soft but HONEST: on upstream error/timeout, serve last-known-good (if a warm instance has
 *     it) or an empty as_of-stamped body; never crash the card. The as_of / stale flag let the UI show
 *     "as of HH:MM" rather than implying live data when it is stale.
 */

const LEAGUE = 1;
const SEASON = 2026;
const FETCH_TIMEOUT_MS = 8000;
const THROTTLE_MS = 25_000; // warm-instance: skip the upstream call if we fetched < 25s ago (bonus layer)

/* API-Football fixture.status.short values that mean "currently in play". FT/AET/PEN (finished),
 * NS/TBD/PST/CANC (not started) are intentionally excluded so finished matches drop from the feed. */
const IN_PLAY = new Set(["1H", "HT", "2H", "ET", "BT", "P", "LIVE", "INT", "SUSP"]);

/* API-Football team id -> our FIFA 3-letter code. Embedded (not imported) so the function bundles
 * with zero path/bundler risk. MIRRORS scripts/worldcup/live/api-team-code-map.json — keep in sync if
 * a team's API mapping ever changes (team ids are stable, so drift risk is near-zero). */
const CODE_MAP = {
  "1": "BEL", "2": "FRA", "3": "CRO", "5": "SWE", "6": "BRA", "7": "URU", "8": "COL", "9": "ESP",
  "10": "ENG", "11": "PAN", "12": "JPN", "13": "SEN", "15": "SUI", "16": "MEX", "17": "KOR", "20": "AUS",
  "22": "IRN", "23": "KSA", "25": "GER", "26": "ARG", "27": "POR", "28": "TUN", "31": "MAR", "32": "EGY",
  "770": "CZE", "775": "AUT", "777": "TUR", "1090": "NOR", "1108": "SCO", "1113": "BIH", "1118": "NED",
  "1501": "CIV", "1504": "GHA", "1508": "COD", "1531": "RSA", "1532": "ALG", "1533": "CPV", "1548": "JOR",
  "1567": "IRQ", "1568": "UZB", "1569": "QAT", "2380": "PAR", "2382": "ECU", "2384": "USA", "2386": "HAI",
  "4673": "NZL", "5529": "CAN", "5530": "CUW",
};

/* PURE transform — maps API-Football live fixtures to the UI's code-keyed entries (home/away = our
 * FIFA codes, provider order). Keeps only WC (league 1) in-play matches; drops unmapped teams. The UI
 * (loadLiveScores) is orientation-agnostic — it also indexes the reverse key with swapped scores — so
 * provider order is safe regardless of how a card lists home/away. Same field set as write-live-scores.ts. */
function liveFixturesToMatches(apiFixtures) {
  const matches = [];
  for (const f of apiFixtures || []) {
    if ((f?.league?.id ?? null) !== LEAGUE) continue;
    const short = f?.fixture?.status?.short ?? "";
    if (!IN_PLAY.has(short)) continue;
    const home = CODE_MAP[String(f?.teams?.home?.id)];
    const away = CODE_MAP[String(f?.teams?.away?.id)];
    if (!home || !away) continue; // unmapped team — skip rather than guess
    matches.push({
      api_fixture_id: f?.fixture?.id ?? null,
      home,
      away,
      status: "live",
      minute: typeof f?.fixture?.status?.elapsed === "number" ? f.fixture.status.elapsed : null,
      // added/stoppage time (e.g. elapsed=90, extra=6 -> the card shows "90+6'"); null when not in stoppage
      extra: typeof f?.fixture?.status?.extra === "number" && f.fixture.status.extra > 0 ? f.fixture.status.extra : null,
      home_score: f?.goals?.home ?? 0,
      away_score: f?.goals?.away ?? 0,
    });
  }
  return matches;
}

// Warm-instance bonus cache (NOT the primary quota protection — the edge cache is).
let warm = null; // { payload, fetchedAtMs }

function jsonResponse(body, { status = 200, edgeSeconds = 30 } = {}) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    // EDGE CACHING (load-bearing). s-maxage => Cloudflare/shared caches; stale-while-revalidate smooths
    // the refresh; Netlify-CDN-Cache-Control controls Netlify's own edge independently of the browser.
    "cache-control": `public, max-age=${edgeSeconds}, s-maxage=${edgeSeconds}, stale-while-revalidate=${edgeSeconds}`,
    "netlify-cdn-cache-control": `public, s-maxage=${edgeSeconds}, stale-while-revalidate=${edgeSeconds}`,
  };
  return new Response(JSON.stringify(body), { status, headers });
}

export default async function handler() {
  const key = process.env.API_FOOTBALL_KEY;

  // Bonus warm-instance throttle: if this instance fetched < THROTTLE_MS ago, reuse it (no API call).
  if (warm && Date.now() - warm.fetchedAtMs < THROTTLE_MS) {
    return jsonResponse(warm.payload);
  }

  if (!key) {
    // Misconfiguration — fail soft and honest (never crash the card), but don't imply live data.
    return jsonResponse({ as_of: null, matches: [], stale: true, error: "server_not_configured" });
  }

  try {
    const url = `https://v3.football.api-sports.io/fixtures?live=all&league=${LEAGUE}&season=${SEASON}`;
    const r = await fetch(url, {
      headers: { "x-apisports-key": key, accept: "application/json" }, // key used SERVER-SIDE only
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`api_football_http_${r.status}`);
    const j = await r.json();
    const matches = liveFixturesToMatches(j?.response || []);
    const payload = {
      as_of: new Date().toISOString(),
      source: "API-Football livescore (in-play) — display-only; never a prediction input",
      note: "Cleared when a match finishes; the UI then shows our verified result from the export.",
      matches,
    };
    warm = { payload, fetchedAtMs: Date.now() };
    return jsonResponse(payload);
  } catch (e) {
    // Fail-soft but HONEST: serve last-known-good (keeping ITS original as_of) marked stale, else empty.
    const message = String(e?.message || e);
    if (warm?.payload) {
      return jsonResponse({ ...warm.payload, stale: true, error: message }, { edgeSeconds: 15 });
    }
    return jsonResponse({ as_of: null, matches: [], stale: true, error: message }, { edgeSeconds: 15 });
  }
}
