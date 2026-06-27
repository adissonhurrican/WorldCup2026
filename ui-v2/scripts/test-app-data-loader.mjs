import assert from "node:assert/strict";
import {
  appDataFreshness,
  decodeGithubContentsJson,
  resolveAppDataSource,
} from "../src/lib/appDataResolver.js";

const data = (results, groups = 0, label = String(results)) => ({
  label,
  real_standings: { results_counted: results, groups_complete: groups },
});

const ok = (source, d) => ({ source, ok: true, data: d });
const fail = (source, message = "failed") => ({ source, ok: false, error: new Error(message) });
const choose = (args) => resolveAppDataSource(args);

function assertChoice(name, choice, source, results, reason = null) {
  assert.equal(choice.source, source, `${name}: source`);
  assert.equal(choice.data.real_standings.results_counted, results, `${name}: results_counted`);
  if (reason) assert.equal(choice.reason, reason, `${name}: reason`);
}

// Freshness scoring: results_counted is primary, groups_complete breaks ties.
assert.equal(appDataFreshness(data(64, 8)), 64008);
assert.equal(appDataFreshness(data(64, 7)) > appDataFreshness(data(63, 12)), true);

// THE FIX: both CDNs stale-200, authoritative committed copy is newer.
assertChoice(
  "both CDNs stale + authoritative fresh",
  choose({
    cdnCandidates: [ok("jsdelivr", data(63, 7)), ok("raw", data(63, 7))],
    authoritativeCandidate: ok("github_contents", data(64, 8)),
  }),
  "github_contents",
  64,
  "authoritative_newer_than_cdns",
);

// Existing working case: one CDN stale, one fresh. CDN stays the selected fast path when current.
assertChoice(
  "jsDelivr stale + raw fresh",
  choose({
    cdnCandidates: [ok("jsdelivr", data(63, 7)), ok("raw", data(64, 8))],
    authoritativeCandidate: ok("github_contents", data(64, 8)),
  }),
  "raw",
  64,
  "cdn_current_or_fresher",
);

assertChoice(
  "raw stale + jsDelivr fresh",
  choose({
    cdnCandidates: [ok("jsdelivr", data(64, 8)), ok("raw", data(63, 7))],
    authoritativeCandidate: ok("github_contents", data(64, 8)),
  }),
  "jsdelivr",
  64,
  "cdn_current_or_fresher",
);

// Happy path: both CDNs fresh. Do not depend on authoritative data for the selected payload.
assertChoice(
  "both CDNs fresh",
  choose({
    cdnCandidates: [ok("jsdelivr", data(64, 8)), ok("raw", data(64, 8))],
    authoritativeCandidate: ok("github_contents", data(64, 8)),
  }),
  "jsdelivr",
  64,
  "cdn_current_or_fresher",
);

// Authoritative source unreachable: degrade to previous freshest-CDN behavior.
assertChoice(
  "authoritative unreachable",
  choose({
    cdnCandidates: [ok("jsdelivr", data(63, 7)), ok("raw", data(64, 8))],
    authoritativeCandidate: fail("github_contents"),
  }),
  "raw",
  64,
  "authoritative_unavailable",
);

// CDNs both down, authoritative available: still serve current data.
assertChoice(
  "CDNs down + authoritative available",
  choose({
    cdnCandidates: [fail("jsdelivr"), fail("raw")],
    authoritativeCandidate: ok("github_contents", data(64, 8)),
  }),
  "github_contents",
  64,
  "authoritative_only",
);

// Every external source unavailable: use the bundled last-good copy.
assertChoice(
  "all external unavailable + bundle",
  choose({
    cdnCandidates: [fail("jsdelivr"), fail("raw")],
    authoritativeCandidate: fail("github_contents"),
    bundledCandidate: ok("bundled", data(62, 7)),
  }),
  "bundled",
  62,
  "bundled_fallback",
);

// Malformed JSON is represented as a failed candidate and must not crash selection.
assertChoice(
  "malformed CDN ignored",
  choose({
    cdnCandidates: [fail("jsdelivr", "bad json"), ok("raw", data(64, 8))],
    authoritativeCandidate: ok("github_contents", data(64, 8)),
  }),
  "raw",
  64,
  "cdn_current_or_fresher",
);

// If everything is malformed/unreachable and no bundle exists, surface the load error.
assert.throws(
  () => choose({
    cdnCandidates: [fail("jsdelivr", "bad json"), fail("raw", "bad json")],
    authoritativeCandidate: fail("github_contents", "bad json"),
  }),
  /all app-data sources unreachable/,
);

// GitHub Contents decoding must handle the base64+UTF-8 shape used by the authoritative source.
const body = JSON.stringify({ name: "Curacao / Curacao", real_standings: { results_counted: 64, groups_complete: 8 } });
const encoded = Buffer.from(body, "utf8").toString("base64").replace(/(.{20})/g, "$1\n");
assert.deepEqual(decodeGithubContentsJson({ encoding: "base64", content: encoded }), JSON.parse(body));

console.log("app-data loader resolver tests passed");
