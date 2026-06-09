/* netlify/functions/lineups.mjs — LIVE confirmed XIs for the match detail (display-only).
 *
 * PROJECT: ahcfrgxczbgdvrqmbisw
 *
 * WHY THIS EXISTS
 *   The static stack (GitHub -> Netlify -> Cloudflare) cannot refresh lineups.json when an XI is posted
 *   (~60 min before kickoff). This serverless function fetches API-Football's lineups SERVER-SIDE and
 *   returns the EXACT shape the UI's loadLineups() reads ({ as_of, matches:[...] }, each match
 *   { home, away, fixture_id, home_lineup, away_lineup }). The UI polls this endpoint instead of the
 *   empty static file. Mirrors livescore.mjs.
 *
 * READ-THROUGH PROXY (load-bearing): this writes NOTHING — no DB, no squads.json, no lineups.json. It is
 *   a pure server-side fetch -> transform -> response, exactly like livescore.mjs. (The squad-card stats
 *   path stays the live loop's single business; this function never touches it.)
 *
 * EDGE CACHING (do not remove): Cache-Control s-maxage=300 — lineups are QUASI-STATIC once posted (they
 *   don't tick like the live score), so a 5-min edge cache is plenty and decouples API-Football calls from
 *   user count (calls track the ~5-min cache-miss rate, not concurrent users). Netlify-CDN-Cache-Control
 *   controls Netlify's edge independently. A module-scope warm throttle is a BONUS layer.
 *
 * GUARDRAILS (mirror livescore.mjs): DISPLAY-ONLY; the API key is read from process.env and used ONLY in
 *   the upstream header (NEVER returned to the browser); fail-soft + honest (last-known-good or an empty
 *   as_of-stamped body on error; never crash the tab).
 */

const LEAGUE = 1;
const SEASON = 2026;
const FETCH_TIMEOUT_MS = 8000;
const THROTTLE_MS = 120_000;             // warm-instance bonus (the edge cache is the primary protection)
const IMMINENT_MS = 90 * 60 * 1000;      // lineups post ~1h pre-match -> fetch within 90 min of kickoff
const EDGE_SECONDS = 300;                // 5 min — lineups don't change like the score

/* status.short values that mean "currently in play" (same set as livescore.mjs). */
const IN_PLAY = new Set(["1H", "HT", "2H", "ET", "BT", "P", "LIVE", "INT", "SUSP"]);

/* API-Football team id -> our FIFA 3-letter code. Embedded (mirrors livescore.mjs / api-team-code-map.json). */
const CODE_MAP = {
  "1": "BEL", "2": "FRA", "3": "CRO", "5": "SWE", "6": "BRA", "7": "URU", "8": "COL", "9": "ESP",
  "10": "ENG", "11": "PAN", "12": "JPN", "13": "SEN", "15": "SUI", "16": "MEX", "17": "KOR", "20": "AUS",
  "22": "IRN", "23": "KSA", "25": "GER", "26": "ARG", "27": "POR", "28": "TUN", "31": "MAR", "32": "EGY",
  "770": "CZE", "775": "AUT", "777": "TUR", "1090": "NOR", "1108": "SCO", "1113": "BIH", "1118": "NED",
  "1501": "CIV", "1504": "GHA", "1508": "COD", "1531": "RSA", "1532": "ALG", "1533": "CPV", "1548": "JOR",
  "1567": "IRQ", "1568": "UZB", "1569": "QAT", "2380": "PAR", "2382": "ECU", "2384": "USA", "2386": "HAI",
  "4673": "NZL", "5529": "CAN", "5530": "CUW",
};

let warm = null; // { payload, fetchedAtMs } — warm-instance bonus cache

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
    headers: { "x-apisports-key": key, accept: "application/json" }, // key used SERVER-SIDE only
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`api_football_http_${r.status}`);
  return r.json();
}

/* one API /fixtures/lineups team object -> our side-lineup shape (matches export-lineups.sideLineup). */
function sideFromApi(obj) {
  const toP = (p) => ({
    name: p?.player?.name ?? null,
    number: p?.player?.number ?? null,
    pos: p?.player?.pos ?? null,
    grid: p?.player?.grid ?? null,
    player_id: p?.player?.id ?? null,
  });
  return {
    formation: obj?.formation ?? null,
    coach: obj?.coach?.name ?? null,
    startXI: (obj?.startXI ?? []).map(toP),
    substitutes: (obj?.substitutes ?? []).map(toP),
  };
}

export default async function handler() {
  const key = process.env.API_FOOTBALL_KEY;

  if (warm && Date.now() - warm.fetchedAtMs < THROTTLE_MS) return jsonResponse(warm.payload);
  if (!key) return jsonResponse({ as_of: null, matches: [], stale: true, error: "server_not_configured" });

  try {
    const today = new Date().toISOString().slice(0, 10); // UTC date
    // live=all catches in-play fixtures regardless of date; date=today catches imminent (pre-match) XIs.
    const [liveJson, dayJson] = await Promise.all([
      apiGet(`fixtures?live=all&league=${LEAGUE}&season=${SEASON}`, key),
      apiGet(`fixtures?date=${today}&league=${LEAGUE}&season=${SEASON}`, key),
    ]);

    const now = Date.now();
    const byId = new Map(); // fixture id -> { id, homeId, awayId }
    for (const f of [...(liveJson?.response || []), ...(dayJson?.response || [])]) {
      if ((f?.league?.id ?? null) !== LEAGUE) continue;
      const id = f?.fixture?.id;
      if (!id || byId.has(id)) continue;
      const short = f?.fixture?.status?.short ?? "";
      const ts = (f?.fixture?.timestamp ?? 0) * 1000;
      const live = IN_PLAY.has(short);
      const imminent = short === "NS" && ts - now <= IMMINENT_MS && ts - now > -3 * 60 * 60 * 1000;
      if (!live && !imminent) continue;
      byId.set(id, { id, homeId: String(f?.teams?.home?.id), awayId: String(f?.teams?.away?.id) });
    }

    const fixtures = [...byId.values()];
    const results = await Promise.all(fixtures.map(async (fx) => {
      try { const j = await apiGet(`fixtures/lineups?fixture=${fx.id}`, key); return { fx, response: j?.response || [] }; }
      catch { return { fx, response: [] }; } // one fixture's failure never sinks the rest
    }));

    const matches = [];
    for (const { fx, response } of results) {
      const home = CODE_MAP[fx.homeId];
      const away = CODE_MAP[fx.awayId];
      if (!home || !away || !response.length) continue;
      let home_lineup = null, away_lineup = null;
      for (const obj of response) {
        const tid = String(obj?.team?.id);
        if (tid === fx.homeId) home_lineup = sideFromApi(obj);
        else if (tid === fx.awayId) away_lineup = sideFromApi(obj);
      }
      if (!home_lineup && !away_lineup) continue; // nothing usable -> omit (UI shows the placeholder)
      matches.push({ home, away, fixture_id: fx.id, home_lineup, away_lineup });
    }

    const payload = {
      as_of: new Date().toISOString(),
      source: "API-Football /fixtures/lineups (server-side) — display-only; never a prediction input",
      note: "Confirmed XIs publish ~60 min before kickoff; a fixture is absent until its lineup is posted (the UI shows the placeholder).",
      matches,
    };
    warm = { payload, fetchedAtMs: Date.now() };
    return jsonResponse(payload);
  } catch (e) {
    const message = String(e?.message || e);
    if (warm?.payload) return jsonResponse({ ...warm.payload, stale: true, error: message }, { edgeSeconds: 60 });
    return jsonResponse({ as_of: null, matches: [], stale: true, error: message }, { edgeSeconds: 60 });
  }
}
