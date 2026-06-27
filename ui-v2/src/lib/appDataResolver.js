// Pure app-data source selection helpers. Kept browser/runtime neutral so the
// stale-CDN cases can be tested directly without booting the whole SPA.

export function appDataFreshness(d) {
  const rs = (d && d.real_standings) || {};
  return (Number(rs.results_counted) || 0) * 1000 + (Number(rs.groups_complete) || 0);
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
