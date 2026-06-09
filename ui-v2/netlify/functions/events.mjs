/* netlify/functions/events.mjs — LIVE goal/card/substitution timeline for the match detail (display-only).
 *
 * PROJECT: ahcfrgxczbgdvrqmbisw
 *
 * WHY THIS EXISTS
 *   The static stack cannot refresh events.json as goals/cards/subs happen. This serverless function
 *   fetches API-Football's per-fixture events SERVER-SIDE for in-play matches and returns the EXACT shape
 *   the UI's loadEvents() reads ({ as_of, matches:[...] }, each match { home, away, fixture_id, events,
 *   goals, cards, substitutions }). The UI polls this endpoint instead of the empty static file.
 *   Mirrors livescore.mjs; the event transform mirrors export-events.mjs.
 *
 * READ-THROUGH PROXY (load-bearing): writes NOTHING — no DB, no events.json. Pure fetch -> transform ->
 *   response, exactly like livescore.mjs.
 *
 * EDGE CACHING (do not remove): s-maxage=30 — events DO change during a match (a goal can happen any
 *   second), so this is near-live like livescore (NOT the 5-min lineups cache). Calls track the ~30s
 *   cache-miss rate, not user count.
 *
 * LIVE-ONLY (honest limit): like livescore, only IN-PLAY fixtures are fetched, so the detailed timeline
 *   shows DURING a match; once it finishes the fixture drops from the feed and the card shows our verified
 *   result/score from the export. Player names come straight from the provider feed (no DB id resolution).
 *
 * GUARDRAILS (mirror livescore.mjs): DISPLAY-ONLY; key from process.env used ONLY in the upstream header
 *   (never returned to the browser); fail-soft + honest.
 */

const LEAGUE = 1;
const SEASON = 2026;
const FETCH_TIMEOUT_MS = 8000;
const THROTTLE_MS = 25_000;  // warm-instance bonus (edge cache is primary), mirrors livescore
const EDGE_SECONDS = 30;     // near-live, like livescore

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

// --- event transform (mirrors export-events.mjs) ---
function minuteLabel(m, e) { if (m == null) return ""; return e != null && e > 0 ? `${m}+${e}'` : `${m}'`; }
function eventKind(type, detail) {
  const t = String(type || "").toLowerCase();
  const d = String(detail || "").toLowerCase();
  if (t === "goal") { if (d.includes("missed penalty")) return null; return "goal"; }
  if (t === "card") return "card";
  if (t === "subst" || t === "substitution") return "substitution";
  return null; // Var and others ignored
}
function cardType(detail) {
  const d = String(detail || "").toLowerCase();
  if (d.includes("second")) return "second_yellow";
  if (d.includes("red")) return "red";
  return "yellow";
}
function person(p) {
  if (!p || (p.id == null && !p.name)) return null;
  return { name: p.name || "Unknown player", api_player_id: p.id ?? null, resolved: false };
}
function transformEvent(ev) {
  const kind = eventKind(ev?.type, ev?.detail);
  if (!kind) return null;
  const minute = typeof ev?.time?.elapsed === "number" ? ev.time.elapsed : null;
  const extra = typeof ev?.time?.extra === "number" ? ev.time.extra : null;
  const base = {
    kind, minute, extra,
    display_minute: minuteLabel(minute, extra),
    team: CODE_MAP[String(ev?.team?.id)] || null,
    team_name: ev?.team?.name ?? null,
    player: person(ev?.player) || { name: "Unknown player", api_player_id: null, resolved: false },
    detail: ev?.detail ?? null,
    comments: ev?.comments ?? null,
  };
  if (kind === "goal") {
    const d = String(ev?.detail || "");
    return { ...base, penalty: /penalty/i.test(d) && !/missed/i.test(d), own_goal: /own goal/i.test(d), assist: person(ev?.assist) };
  }
  if (kind === "substitution") {
    // API `subst`: event.player = going OFF, event.assist = coming ON.
    return { ...base, player_off: base.player, player_on: person(ev?.assist) };
  }
  return { ...base, card: cardType(ev?.detail) };
}
const KIND_ORDER = { goal: 0, card: 1, substitution: 2 };
function eventSort(a, b) {
  return (a.minute ?? 999) - (b.minute ?? 999)
    || (a.extra ?? 0) - (b.extra ?? 0)
    || ((KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9));
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
      try { const j = await apiGet(`fixtures/events?fixture=${fx.id}`, key); return { fx, response: j?.response || [] }; }
      catch { return { fx, response: [] }; }
    }));

    const matches = [];
    for (const { fx, response } of results) {
      const home = CODE_MAP[fx.homeId];
      const away = CODE_MAP[fx.awayId];
      if (!home || !away) continue;
      const events = response.map(transformEvent).filter(Boolean).sort(eventSort);
      matches.push({
        home, away, fixture_id: fx.id, events,
        goals: events.filter((e) => e.kind === "goal"),
        cards: events.filter((e) => e.kind === "card"),
        substitutions: events.filter((e) => e.kind === "substitution"),
      });
    }

    const payload = {
      as_of: new Date().toISOString(),
      source: "API-Football /fixtures/events (server-side, in-play) — display-only; never a prediction input",
      note: "Live goal/card/substitution timeline for in-play matches; a fixture drops from the feed when it finishes (the card then shows our verified result).",
      matches,
    };
    warm = { payload, fetchedAtMs: Date.now() };
    return jsonResponse(payload);
  } catch (e) {
    const message = String(e?.message || e);
    if (warm?.payload) return jsonResponse({ ...warm.payload, stale: true, error: message }, { edgeSeconds: 15 });
    return jsonResponse({ as_of: null, matches: [], stale: true, error: message }, { edgeSeconds: 15 });
  }
}
