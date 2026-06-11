/* wc2026-loop-pinger — Cloudflare Worker cron -> GitHub workflow_dispatch.
 *
 * PROJECT: ahcfrgxczbgdvrqmbisw
 *
 * WHY: GitHub's `schedule:` cron for live-loop.yml is best-effort and was observed firing 1.7-5h
 * apart (opener night needed manual `gh workflow run` after full-time). Cloudflare cron triggers
 * fire reliably; this Worker is a dumb alarm clock for the door that already exists.
 *
 * PURELY ADDITIVE + SAFE BY DESIGN: it only calls the dispatch API for the EXISTING workflow —
 * no loop code, functions, DB, or data. Over-firing is harmless (the workflow's concurrency
 * group + the runner's 9-min lock + the materiality gate make a colliding tick a clean no-op).
 * If this Worker dies, the system degrades to the throttled GitHub cron — never worse.
 *
 * SECRET: GITHUB_PAT — fine-grained PAT, repository access WorldCup2026 ONLY, permission
 * Actions: Read+write ONLY, expiry set past the tournament. Set via `wrangler secret put
 * GITHUB_PAT` (locally: .dev.vars, gitignored). NEVER in this file.
 */

const DISPATCH_URL =
  "https://api.github.com/repos/adissonhurrican/WorldCup2026/actions/workflows/live-loop.yml/dispatches";

// The loop self-guards outside the tournament, but don't burn dispatches after the final.
const TOURNAMENT_END_UTC = "2026-07-20T23:59:59Z";

async function dispatchLoop(env) {
  const r = await fetch(DISPATCH_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_PAT}`,
      accept: "application/vnd.github+json",
      "user-agent": "wc2026-loop-pinger", // GitHub API requires a User-Agent
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  const detail = r.status === 204 ? "OK" : (await r.text()).slice(0, 300);
  console.log(r.status === 204 ? "dispatched live-loop.yml OK (204)" : `dispatch FAILED ${r.status} ${detail}`);
  return { status: r.status, detail };
}

export default {
  async scheduled(event, env, ctx) {
    if (new Date(event.scheduledTime ?? Date.now()).toISOString() > TOURNAMENT_END_UTC) {
      console.log("past tournament end — not dispatching");
      return;
    }
    await dispatchLoop(env);
  },

};
