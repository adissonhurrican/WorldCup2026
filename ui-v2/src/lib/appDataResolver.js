// Pure app-data source selection helpers. Kept browser/runtime neutral so the
// stale-CDN cases can be tested directly without booting the whole SPA.

// Recency of a published app-data copy — used to pick the freshest among the CDN / authoritative / bundled sources.
// PRIMARY signal: meta.generated_at, the publish timestamp, which advances on EVERY publish (group AND knockout).
// So a stuck-stale CDN (old generated_at) is always out-ranked by the authoritative HEAD or a fresher CDN.
// (The legacy results_counted key below counts GROUP-only results, so it is pinned at a constant — e.g. 72012 —
// through the ENTIRE knockout phase, which is why a stale CDN went undetected after the groups: the both-CDNs-stale
// override was mathematically dead. generated_at restores it.) Falls back to the results key for any pre-stamp export.
export function appDataFreshness(d) {
  const ms = generatedAtMs(d && d.meta && d.meta.generated_at);
  if (Number.isFinite(ms)) return ms;
  const rs = (d && d.real_standings) || {};
  return (Number(rs.results_counted) || 0) * 1000 + (Number(rs.groups_complete) || 0);
}

// Parse meta.generated_at to epoch ms WITHOUT the engine's lenient Date.parse. The stamp is a Postgres timestamptz
// ("2026-06-28 04:02:38.120117+00": space separator, microseconds, "+00" offset) which Safari/Firefox do NOT
// reliably accept (the spec only mandates strict ISO 8601) — they'd return NaN and silently disable this override.
// Parsing the components by regex makes it correct in every browser. Tolerates ISO ("…T…Z") too. NaN if unparseable.
function generatedAtMs(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(String(s || "").trim());
  if (!m) { const t = Date.parse(String(s || "")); return Number.isFinite(t) ? t : NaN; }
  const [, Y, Mo, D, H, Mi, S, frac, off] = m;
  let ms = Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +S, frac ? Math.round(Number("0." + frac) * 1000) : 0);
  if (off && off !== "Z") {
    const sign = off[0] === "-" ? 1 : -1;             // subtract the zone offset to reach UTC
    const dg = off.slice(1).replace(":", "");
    ms += sign * (Number(dg.slice(0, 2)) * 60 + Number(dg.slice(2, 4) || 0)) * 60000;
  }
  return ms;
}

export function decodeGithubContentsJson(payload) {
  if (!payload || payload.encoding !== "base64" || !payload.content) {
    throw new Error("invalid GitHub contents payload");
  }
  const compact = String(payload.content).replace(/\n/g, "");
  const binary = atob(compact);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  const text = new TextDecoder("utf-8").decode(bytes);
  return JSON.parse(text);
}

function bestFreshest(candidates) {
  const ok = (candidates || []).filter((c) => c && c.ok && c.data);
  if (!ok.length) return null;
  return ok.reduce((best, c) => (appDataFreshness(c.data) > appDataFreshness(best.data) ? c : best));
}

export function resolveAppDataSource({ cdnCandidates = [], authoritativeCandidate = null, bundledCandidate = null } = {}) {
  const bestCdn = bestFreshest(cdnCandidates);
  const auth = authoritativeCandidate && authoritativeCandidate.ok && authoritativeCandidate.data
    ? authoritativeCandidate
    : null;

  if (auth && (!bestCdn || appDataFreshness(auth.data) > appDataFreshness(bestCdn.data))) {
    return { ...auth, reason: bestCdn ? "authoritative_newer_than_cdns" : "authoritative_only" };
  }
  if (bestCdn) {
    return { ...bestCdn, reason: auth ? "cdn_current_or_fresher" : "authoritative_unavailable" };
  }
  if (auth) {
    return { ...auth, reason: "authoritative_only" };
  }
  if (bundledCandidate && bundledCandidate.ok && bundledCandidate.data) {
    return { ...bundledCandidate, reason: "bundled_fallback" };
  }
  throw new Error("all app-data sources unreachable");
}
