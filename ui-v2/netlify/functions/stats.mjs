/* netlify/functions/stats.mjs — LIVE per-team match stats (xG) for the match card (display-only).
 *
 * PROJECT: ahcfrgxczbgdvrqmbisw
 *
 * WHY THIS EXISTS
 *   API-Football publishes live team statistics (incl. expected goals) per fixture. This serverless
 *   function fetches /fixtures/statistics SERVER-SIDE for in-play matches and returns a tiny
 *   { as_of, matches:[{ home, away, fixture_id, home_xg, away_xg }] } payload the UI's loadStats()
 *   reads. xG is DESCRIPTIVE — a live match stat, separate from predictions; it never feeds the model.
 *   Mirrors events.mjs (same live=all gate, same guardrails); ADDITIVE — livescore/events/lineups untouched.
 *
 * READ-THROUGH PROXY (load-bearing): writes NOTHING — no DB, no JSON files. Pure fetch -> transform ->
 *   response, exactly like livescore.mjs / events.mjs.
 *
 * EDGE CACHING (do not remove): s-maxage=60 — xG moves shot-by-shot, not second-by-second; 60s is
 *   plenty and keeps upstream calls on the cache-miss rate, not user count.
 *
 * LIVE-ONLY (honest limit): only IN-PLAY fixtures are fetched; when a match finishes the fixture drops
 *   from the feed and the xG row disappears with the live state (the card then shows our verified result).
 *
 * GUARDRAILS (mirror livescore.mjs): DISPLAY-ONLY; key from process.env used ONLY in the upstream header
 *   (never returned to the browser); fail-soft + honest (empty matches on error; never crash the tab).
 */

const LEAGUE = 1;
const SEASON = 2026;
const FETCH_TIMEOUT_MS = 8000;
const THROTTLE_MS = 45_000;  // warm-instance bonus (edge cache is primary)
const EDGE_SECONDS = 60;     // xG is shot-granular; 60s freshness is plenty

const IN_PLAY = new Set(["1H", "HT", "2H", "ET", "BT", "P", "LIVE", "INT", "SUSP"]);

const CODE_MAP = {
  "1": "BEL", "2": "FRA", "3": "CRO", "5": "SWE", "6": "BRA", "7": "URU", "8": "COL", "9": "ESP",
  "10": "ENG", "11": "PAN", "12": "JPN", "13": "SEN", "15": "SUI", "16": "MEX", "17": "KOR", "20": "AUS",
  "22": "IRN", "23": "KSA", "25": "GER", "26": "ARG", "27": "POR", "28": "TUN", "31": "MAR", "32": "EGY",
  "770": "CZE", "775": "AUT", "777": "TUR", "1090": "NOR", "1108": "SCO", "1113": "BIH", "1118": "NED",
  "1501": "CIV", "1504": "GHA", "1508": "COD", "1531": "RSA", "1532": "ALG", "1533": "CPV", "1548": "JOR",
  "1567": "IRQ", "1568": "UZB", "1569": "QAT", "2380": "PAR", "2382": "ECU", "2384": "USA", "2386": "HAI",
  "4673": "NZL", "5529": "CAN", "5530": "CUW",
};

let warm = null;

function jsonResponse(body, { status = 200, edgeSeconds = EDGE_SECONDS } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${edgeSeconds}, s-maxage=${edgeSeconds}, stale-while-revalidate=${edgeSeconds}`,
      "netlify-cdn-cache-control": `public, s-maxage=${edgeSeconds}, stale-while-revalidate=${edgeSeconds}`,
    },
  });
}

async function apiGet(pathq, key) {
  const r = await fetch(`https://v3.football.api-sports.io/${pathq}`, {
    headers: { "x-apisports-key": key, accept: "application/json" }, // key SERVER-SIDE only
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`api_football_http_${r.status}`);
  return r.json();
}

/* One team's statistics block -> numeric xG (null when absent/unparseable; never NaN). */
function xgFrom(statBlock) {
  for (const s of statBlock?.statistics || []) {
    const t = String(s?.type || "").toLowerCase().replace(/\s+/g, "_");
    if (t === "expected_goals") {
      const v = Number(s?.value);
      return Number.isFinite(v) ? v : null;
    }
  }
  return null;
}

export default async function handler() {
  const key = process.env.API_FOOTBALL_KEY;

  if (warm && Date.now() - warm.fetchedAtMs < THROTTLE_MS) return jsonResponse(warm.payload);
  if (!key) return jsonResponse({ as_of: null, matches: [], stale: true, error: "server_not_configured" });

  try {
    const liveJson = await apiGet(`fixtures?live=all&league=${LEAGUE}&season=${SEASON}`, key);
    const live = [];
    for (const f of liveJson?.response || []) {
      if ((f?.league?.id ?? null) !== LEAGUE) continue;
      const short = f?.fixture?.status?.short ?? "";
      if (!IN_PLAY.has(short)) continue;
      const id = f?.fixture?.id; if (!id) continue;
      live.push({ id, homeId: String(f?.teams?.home?.id), awayId: String(f?.teams?.away?.id) });
    }

    const results = await Promise.all(live.map(async (fx) => {
      try { const j = await apiGet(`fixtures/statistics?fixture=${fx.id}`, key); return { fx, response: j?.response || [] }; }
      catch { return { fx, response: [] }; } // one fixture's failure never sinks the rest
    }));

    const matches = [];
    for (const { fx, response } of results) {
      const home = CODE_MAP[fx.homeId];
      const away = CODE_MAP[fx.awayId];
      if (!home || !away) continue;
      let home_xg = null, away_xg = null;
      for (const block of response) {
        const tid = String(block?.team?.id);
        if (tid === fx.homeId) home_xg = xgFrom(block);
        else if (tid === fx.awayId) away_xg = xgFrom(block);
      }
      if (home_xg == null && away_xg == null) continue; // nothing usable -> omit (UI shows nothing)
      matches.push({ home, away, fixture_id: fx.id, home_xg, away_xg });
    }

    const payload = {
      as_of: new Date().toISOString(),
      source: "API-Football /fixtures/statistics (server-side, in-play) — display-only; never a prediction input",
      note: "Live expected-goals (xG) per team for in-play matches; a fixture is absent until the provider posts statistics and drops when it finishes.",
      matches,
    };
    warm = { payload, fetchedAtMs: Date.now() };
    return jsonResponse(payload);
  } catch (e) {
    const message = String(e?.message || e);
    if (warm?.payload) return jsonResponse({ ...warm.payload, stale: true, error: message }, { edgeSeconds: 30 });
    return jsonResponse({ as_of: null, matches: [], stale: true, error: message }, { edgeSeconds: 30 });
  }
}
