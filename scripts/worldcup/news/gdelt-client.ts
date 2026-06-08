import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

// Rate-limited, reliable GDELT DOC 2.0 client. GDELT enforces "one request every 5 seconds" and applies a lingering
// IP penalty (HTTP 429 + body "Please limit requests to one every 5 seconds") when bursted. This client makes GDELT
// reliable by: (1) a CROSS-RUN persistent throttle (a timestamp file under data/external/news/cache so back-to-back
// script invocations cannot burst); (2) exponential backoff on 429 / transient errors (20s -> 40s -> 60s -> 90s);
// (3) single-flight only — never call GDELT concurrently. Discovery-only; the caller applies denylists and stores
// metadata/links only (no article bodies).

const CACHE_DIR = path.join(process.cwd(), "data/external/news/cache");
const THROTTLE_FILE = path.join(CACHE_DIR, ".gdelt-throttle.json");
const UA = "Mozilla/5.0 (compatible; WC2026-NewsCoverage/1.0; gdelt-rate-limited-client; read-only metadata)";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readLastMs(): number { try { return JSON.parse(readFileSync(THROTTLE_FILE, "utf8")).last_ms || 0; } catch { return 0; } }
function writeLastMs(ms: number): void { try { mkdirSync(CACHE_DIR, { recursive: true }); writeFileSync(THROTTLE_FILE, JSON.stringify({ last_ms: ms, iso: new Date(ms).toISOString() })); } catch { /* throttle file best-effort */ } }

export type GdeltResult = { ok: boolean; status: number; articles: any[]; error: string | null; attempts: number; total_wait_ms: number; rate_limited_hits: number; query: string };

export async function gdeltArtList(
  query: string,
  opts: { timespan?: string; maxrecords?: number; minIntervalMs?: number; maxRetries?: number; timeoutMs?: number; baseBackoffMs?: number } = {},
): Promise<GdeltResult> {
  const { timespan = "14d", maxrecords = 25, minIntervalMs = 6000, maxRetries = 4, timeoutMs = 30000, baseBackoffMs = 20000 } = opts;
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=ArtList&format=json&timespan=${timespan}&maxrecords=${maxrecords}`;
  let totalWait = 0, attempts = 0, rateHits = 0, backoff = baseBackoffMs;
  for (;;) {
    // (1) persistent cross-run throttle: never fire within minIntervalMs of the last GDELT call from ANY run
    const sinceLast = Date.now() - readLastMs();
    if (sinceLast < minIntervalMs) { const w = minIntervalMs - sinceLast; await sleep(w); totalWait += w; }
    attempts++;
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
    let status = 0, text = "", err: string | null = null;
    try { const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: ac.signal }); status = r.status; text = await r.text(); }
    catch (e: any) { err = e?.name === "AbortError" ? "timeout" : (e?.message || "fetch_error").slice(0, 60); }
    finally { clearTimeout(t); writeLastMs(Date.now()); }

    const rateLimited = status === 429 || /limit requests/i.test(text);
    if (!err && !rateLimited && status >= 200 && status < 300) {
      try { return { ok: true, status, articles: JSON.parse(text).articles || [], error: null, attempts, total_wait_ms: totalWait, rate_limited_hits: rateHits, query }; }
      catch { return { ok: false, status, articles: [], error: "parse_error", attempts, total_wait_ms: totalWait, rate_limited_hits: rateHits, query }; }
    }
    if (rateLimited) rateHits++;
    if (attempts > maxRetries) return { ok: false, status: rateLimited ? 429 : status, articles: [], error: rateLimited ? "rate_limited" : (err || `http_${status}`), attempts, total_wait_ms: totalWait, rate_limited_hits: rateHits, query };
    // (2) exponential backoff (longer than the 5s rule — a tripped penalty needs real cooldown)
    await sleep(backoff); totalWait += backoff; backoff = Math.min(backoff * 2, 90000);
  }
}

// CLI smoke test: prove reliability on a few teams (sequential, throttled). Usage: tsx gdelt-client.ts --test
if (process.argv.includes("--test")) {
  (async () => {
    const teams: [string, string][] = [["CAN", '("Canada Soccer" OR "Canada national team") "World Cup"'], ["USA", '("USMNT" OR "US Soccer") "World Cup"'], ["MEX", '("Seleccion Mexicana" OR "El Tri") "World Cup"']];
    console.log("PROJECT ID: ahcfrgxczbgdvrqmbisw | gdelt-client smoke test (rate-limited, cross-run throttle)");
    for (const [team, query] of teams) {
      const r = await gdeltArtList(query);
      console.log(`  ${team}: ok=${r.ok} status=${r.status} articles=${r.articles.length} attempts=${r.attempts} rate_limited_hits=${r.rate_limited_hits} waited=${Math.round(r.total_wait_ms / 1000)}s${r.error ? " err=" + r.error : ""}`);
    }
  })().catch((e) => { console.error("ERROR:", e?.message ?? e); process.exit(1); });
}
