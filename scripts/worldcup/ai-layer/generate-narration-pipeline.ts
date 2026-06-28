import { readFile } from "node:fs/promises";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateAndRepairAiOutput } from "./validate-and-repair";

// AI NARRATION PRODUCTION PIPELINE — context (LIVE runs) -> Gemini (system-prompt v0.9) -> validate-and-repair -> store.
// INTEGRATION ONLY: reuses system-prompt.md (v0.9), validate-and-repair.ts, and the Gemini fetch mechanism from the
// bake-off. AI EXPLAINS, NEVER INVENTS — validate-and-repair gates storage; only valid output is stored (validated=true).
// No internal IDs in prose. No odds/predictions/betting. Gemini = production model. CLI/execSql writes the narration
// table; MCP/CLI read-only for run data. No model/prediction changes. Does NOT touch the export job / UI / player-stats.
//
// Modes: --ensure-table | (dry-run default: generate+validate, NO write) | --execute (store validated) |
//        --teams CAN,ESP,... | --post-result "<HOME vs AWAY>" (loop step-6 hook) | --gate-demo

const rootDir = process.cwd();
const PROJECT = "ahcfrgxczbgdvrqmbisw";
const credentialsPath = path.join(rootDir, "supebase.txt");
const tempDir = path.join(rootDir, ".tmp", "worldcup-sql");
const SYSTEM_PROMPT_PATH = path.join(rootDir, "scripts/worldcup/ai-layer/system-prompt.md");
const PROMPT_VERSION = "ai-copredictor-system-prompt-v0.9";
const DEFAULT_TEAMS = ["CAN", "ESP", "BRA", "ENG", "GHA"];
let tmp = 0;

// MOCK crisp conditional row (final-matchday demo) — used ONLY with --preview --mock-crisp to show the crisp shape
// before real verified results exist. Mirrors the engine's bubble output (Canada arc) for team_conditional_scenarios.
const MOCK_CRISP = (code: string) => ({
  team_code: code, mode: "concrete_chains", own_group_unplayed: 2, max_group_unplayed: 2, own_fixture_label: `${code} vs SUI`,
  certain_statements: [{ statement: `${code} is GUARANTEED at least 3rd (cannot finish 4th) — at least in the best-third race.`, type: "guaranteed_at_least_third" }],
  concrete_chains: [
    { condition: `${code} beats SUI`, outcome: "CLINCH", detail: `${code} finishes 1st/2nd and advances in every such completion.` },
    { condition: `${code} draws SUI`, outcome: "CLINCH", detail: `${code} finishes 3rd and advances in every such completion.` },
    { condition: `${code} loses to SUI by 1-2`, outcome: "CLINCH", detail: `${code} finishes 3rd and advances in every such completion.` },
    { condition: `${code} loses to SUI by exactly 3`, outcome: "DEPENDS", detail: `${code} finishes 3rd — decided by goals scored at this margin against an otherwise-settled field.` },
    { condition: `${code} loses to SUI by 4+`, outcome: "ELIMINATED", detail: `${code} finishes 3rd and does not advance in any such completion.`, bubble_dependencies: [{ group: "G", overtakes_can_if: "its third reaches >= 4 pts / GD 1" }, { group: "I", overtakes_can_if: "its third reaches >= 3 pts / GD 0" }], eliminated_if: "watch Groups A, C, D, E, G, I, J, K, L" },
  ],
  swing_matches: [], full_if_then_available: "true",
});

function arg(name: string): string | null { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] ?? null : null; }
const has = (f: string) => process.argv.includes(f);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function loadApiKey(): Promise<string> {
  if (process.env.GOOGLE_AI_API_KEY) return process.env.GOOGLE_AI_API_KEY;
  for (const f of [".env", ".env.local", ".env.example"]) {
    const p = path.join(rootDir, f);
    if (existsSync(p)) { const m = readFileSync(p, "utf8").match(/^\s*GOOGLE_AI_API_KEY\s*=\s*(\S+)/m); if (m) return m[1].replace(/^["']|["']$/g, ""); }
  }
  throw new Error("GOOGLE_AI_API_KEY not found (env or .env*)");
}
async function dbUrl() {
  // CI-first: use the env DB URL (SUPABASE_DB_URL) so this works on GitHub Actions where supebase.txt is absent.
  // Fall back to the local supebase.txt file when env is unset (local runs unchanged).
  const envDbUrl = process.env.SUPABASE_DB_URL;
  if (envDbUrl) {
    const envRef = envDbUrl.match(/postgres\.([a-z0-9]+):/)?.[1] ?? envDbUrl.match(/\/\/([^.]+)\.supabase\.co/)?.[1] ?? "";
    if (envRef !== PROJECT) throw new Error(`Unexpected project ref from SUPABASE_DB_URL: ${envRef || "unknown"}`);
    return envDbUrl;
  }
  const text = await readFile(credentialsPath, "utf8");
  const ref = text.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];
  const pw = text.match(/supebase password\s*:\s*(\S+)/i)?.[1];
  if (ref !== PROJECT) throw new Error(`Unexpected project ref: ${ref}`);
  if (!pw) throw new Error("no password");
  return `postgresql://postgres.${ref}:${encodeURIComponent(pw)}@aws-1-us-west-1.pooler.supabase.com:5432/postgres`;
}
function q<X = any>(url: string, sql: string): X[] {
  if (/\b(insert|update|delete|drop|alter|truncate|create)\b/i.test(sql.replace(/'[^']*'/g, ""))) throw new Error("read helper refuses mutating SQL");
  mkdirSync(tempDir, { recursive: true }); tmp++;
  const fp = path.join(tempDir, `narr-r-${tmp}.sql`); writeFileSync(fp, sql, "utf8");
  const r = process.platform === "win32"
    ? spawnSync("cmd.exe", ["/c", "npx.cmd", "supabase", "db", "query", "--db-url", url, "--output", "json", "--file", fp], { encoding: "utf8", maxBuffer: 2e8 })
    : spawnSync("npx", ["supabase", "db", "query", "--db-url", url, "--output", "json", "--file", fp], { encoding: "utf8", maxBuffer: 2e8 });
  if ((r.status ?? 1) !== 0) throw new Error((r.stderr || r.stdout || "").slice(0, 400));
  const o = r.stdout.trim(); return o ? (() => { const p = JSON.parse(o); return Array.isArray(p) ? p : p.rows ?? p; })() : [];
}
function execSql(url: string, sql: string): string {
  mkdirSync(tempDir, { recursive: true }); tmp++;
  const fp = path.join(tempDir, `narr-w-${tmp}.sql`); writeFileSync(fp, sql, "utf8");
  const r = process.platform === "win32"
    ? spawnSync("cmd.exe", ["/c", "npx.cmd", "supabase", "db", "query", "--db-url", url, "--file", fp], { encoding: "utf8", maxBuffer: 2e8 })
    : spawnSync("npx", ["supabase", "db", "query", "--db-url", url, "--file", fp], { encoding: "utf8", maxBuffer: 2e8 });
  if ((r.status ?? 1) !== 0) throw new Error(`execSql failed: ${(r.stderr || r.stdout || "").slice(0, 400)}`);
  return `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
}
function dec(v: any): number | null { if (v == null) return null; if (typeof v === "number") return v; if (typeof v === "string") { const n = Number(v); return Number.isNaN(n) ? null : n; } if (typeof v === "object" && "Int" in v) return Number(v.Int) * Math.pow(10, Number(v.Exp ?? 0)); const n = Number(v); return Number.isNaN(n) ? null : n; }
const num = (v: any) => dec(v) ?? 0;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const ordinal = (n: number) => { const s = ["th", "st", "nd", "rd"], v = n % 100; return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`; };

// ---- READ the real best-third resolver OUTPUT (standings-core -> buildRealStandings -> real_standings).
// We read the export block (the resolver's stored output) — NO recompute, NO reimplementation of the ladder.
// Graceful: if the export/block is absent, return null and the pipeline falls back to probabilistic + conditional only.
function loadRealStandings(): any | null {
  try {
    for (const rel of ["data/exports/app-data.json", "ui/app-data.json"]) {
      const fp = path.join(rootDir, rel);
      if (existsSync(fp)) { const j = JSON.parse(readFileSync(fp, "utf8")); if (j && j.real_standings) return j.real_standings; }
    }
  } catch { /* graceful — no real table available */ }
  return null;
}

// Completed results per group, from the SAME export the real table comes from. Feeds the partial-group
// narration state ("Mexico beat South Africa in the opener") for teams still awaiting their own game.
// Graceful: absent/odd file -> {} -> no group_so_far context, never fabricated.
function loadGroupResultsSoFar(): Record<string, { label: string; home: string; away: string; score: string }[]> {
  try {
    for (const rel of ["data/exports/app-data.json", "ui/app-data.json"]) {
      const fp = path.join(rootDir, rel);
      if (!existsSync(fp)) continue;
      const j = JSON.parse(readFileSync(fp, "utf8"));
      const out: Record<string, { label: string; home: string; away: string; score: string }[]> = {};
      for (const f of j.fixtures ?? []) {
        const r = f?.result;
        if (!f?.group || !r || r.home_score == null || r.away_score == null) continue;
        (out[f.group] ??= []).push({ label: `${f.home} ${r.home_score}-${r.away_score} ${f.away}`, home: f.home, away: f.away, score: `${r.home_score}-${r.away_score}` });
      }
      return out;
    }
  } catch { /* graceful */ }
  return {};
}

// SINGLE SOURCE OF TRUTH: resolve the live runs from the SAME pointer file the export reads first
// (data/exports/live-runs-pointer.json), so the narration describes exactly the run the app ships.
// Falls back to null -> the DB lifecycle markers (the export's own fallback), keeping both in lockstep.
function readLivePointer(): { gsim: string; ko: string } | null {
  try {
    const fp = path.join(rootDir, "data/exports/live-runs-pointer.json");
    if (!existsSync(fp)) return null;
    const doc = JSON.parse(readFileSync(fp, "utf8"));
    const runs = doc.runs ?? doc.live_pointer ?? doc;
    if (runs?.group_sim && runs?.knockout_sim) return { gsim: String(runs.group_sim), ko: String(runs.knockout_sim) };
  } catch { /* graceful — fall back to DB lifecycle markers */ }
  return null;
}

// Derive the team's REAL group table + its cross-group best-third rank/margin from the resolver output.
// All values are surfaced verbatim from real_standings (positions, P/W/D/L/GF/GA/GD/Pts) and best_third_race.ranked
// (the team's rank, in_best_8, and margin to the 8th/9th cut line). No recompute. Pre-tournament -> started:false.
export function realContextForTeam(real: any | null, code: string, group: string, groupResultsSoFar?: Record<string, any[]>) {
  if (!real || real.status === "not_started" || (real.results_counted ?? 0) === 0) {
    return { started: false, status: real?.status ?? "unknown" };
  }
  const grp = (real.groups ?? []).find((g: any) => g.group === group);
  const groupGames = grp?.games_played ?? 0;
  const resultsSoFar = (groupResultsSoFar?.[group] ?? []).map((r: any) => r.label ?? r);
  // PER-TEAM gate (mirrors the display's third-place-race gate in standings-core): a team has a
  // CURRENT standing only once IT has played. Before that, its row sits in a FIFA-seeded fallback
  // order (e.g. QAT above BIH in an unplayed Group B) with position:null — and handing that table
  // to the model as "real standings" invites a fabricated current position (the system prompt says
  // to state the CURRENT standing whenever a table is supplied). started:false -> sim framing.
  // NEVER substitute predicted standings as current.
  // PARTIAL-GROUP refinement: when the team is unplayed but SOME group games HAVE finished, supply
  // awaiting_opener (what happened so far) so the prose can acknowledge the group's real events
  // WITHOUT claiming a standing for this team — "group hasn't started" would be false now.
  const meRow = (grp?.standings ?? []).find((r: any) => r.code === code);
  if (!meRow || (meRow.played ?? 0) === 0) {
    const base = { started: false, status: real.status, team_played: 0 };
    if (groupGames > 0) {
      return {
        ...base,
        awaiting_opener: {
          group_games_played: groupGames,
          results_so_far: resultsSoFar,
          note: "This team has NOT played yet, but the group HAS begun — acknowledge the results so far; never claim a current position for this team and never say the group has not started.",
        },
      };
    }
    return base;
  }
  // The team HAS played: surface the asymmetry of the group (who still hasn't played / round state)
  // so the prose can present its position as PROVISIONAL while rivals have games in hand.
  const playedCounts = (grp?.standings ?? []).map((r: any) => r.played ?? 0);
  const roundComplete = playedCounts.length > 0 && Math.min(...playedCounts) === Math.max(...playedCounts);
  const rivalsYetToPlay = (grp?.standings ?? []).filter((r: any) => r.code !== code && (r.played ?? 0) < (meRow.played ?? 0)).map((r: any) => r.code);
  const groupProgress = {
    round_complete: roundComplete,
    group_games_played: groupGames,
    rivals_yet_to_play: rivalsYetToPlay,
    results_so_far: resultsSoFar,
    note: roundComplete
      ? "Every team in the group has played the same number of games — the table is a settled after-round picture."
      : "The group round is INCOMPLETE — the named rivals still have games in hand; present this team's position as provisional (the table will move when they play), and frame any rival's chances as 'heading into their game', never as a settled standing.",
  };
  const groupTable = (grp?.standings ?? []).map((r: any) => ({
    team_code: r.code, rank: r.position, points: r.points, played: r.played, won: r.won, drawn: r.drawn, lost: r.lost,
    goals_for: r.goals_for, goals_against: r.goals_against, goal_difference: r.goal_difference,
  }));
  const position = groupTable.find((r: any) => r.team_code === code)?.rank ?? null;

  const race = real.best_third_race ?? {};
  const ranked: any[] = race.ranked ?? [];
  const qualify = race.qualify_count ?? 8;
  const me = ranked.find((t) => t.code === code) || null; // present only if the team is CURRENTLY 3rd in its group
  let bestThird: any = null;
  if (me) {
    const sorted = [...ranked].sort((a, b) => a.rank - b.rank);
    const cmp = me.in_best_8 ? sorted[qualify] : sorted[qualify - 1]; // IN -> first OUT (9th); OUT -> last IN (8th)
    let margin: any = null, marginTxt = "with no cut-off comparison available";
    if (cmp) {
      const dp = me.points - cmp.points, dg = me.goal_difference - cmp.goal_difference;
      margin = { points: dp, goal_difference: dg, vs_rank: cmp.rank, vs_team: cmp.code };
      if (dp > 0) marginTxt = `${dp} point${dp === 1 ? "" : "s"} clear of the cut-off`;
      else if (dp < 0) marginTxt = `${Math.abs(dp)} point${Math.abs(dp) === 1 ? "" : "s"} behind the cut-off`;
      else if (dg > 0) marginTxt = `level on points with the cut-off but ahead on goal difference (by ${dg})`;
      else if (dg < 0) marginTxt = `level on points with the cut-off and behind on goal difference (by ${Math.abs(dg)})`;
      else marginTxt = "level with the cut-off on points and goal difference";
    }
    const side = me.in_best_8 ? "inside the top eight that advance" : "outside the top eight that advance";
    bestThird = {
      rank: me.rank, of: ranked.length, in_best_8: me.in_best_8, qualify_count: qualify,
      points: me.points, goal_difference: me.goal_difference, goals_for: me.goals_for,
      margin, decided: race.decided === true,
      summary: `Currently the ${ordinal(me.rank)}-best of ${ranked.length} third-placed teams — ${side}, ${marginTxt}.`,
      provisional_note: race.decided === true ? "Best-third places are final." : "Best-third order is provisional until all 12 groups finish.",
    };
  }
  return { started: true, status: real.status, decided: race.decided === true, position, groupTable, bestThird, group_progress: groupProgress };
}

// MOCK resolved best-third standing (for --preview --mock-real before real verified results exist): the team sits 3rd,
// 6th-best third of 12, inside the cut by 2 points. Mirrors the realContextForTeam shape so the slot wiring is exercised.
const MOCK_REAL = (code: string, group: string) => ({
  started: true, status: "in_progress", decided: false, position: 3,
  groupTable: [
    { team_code: "AAA", rank: 1, points: 7, played: 3, won: 2, drawn: 1, lost: 0, goals_for: 6, goals_against: 2, goal_difference: 4 },
    { team_code: "BBB", rank: 2, points: 4, played: 3, won: 1, drawn: 1, lost: 1, goals_for: 4, goals_against: 3, goal_difference: 1 },
    { team_code: code, rank: 3, points: 4, played: 3, won: 1, drawn: 1, lost: 1, goals_for: 3, goals_against: 3, goal_difference: 0 },
    { team_code: "DDD", rank: 4, points: 1, played: 3, won: 0, drawn: 1, lost: 2, goals_for: 1, goals_against: 6, goal_difference: -5 },
  ],
  bestThird: {
    rank: 6, of: 12, in_best_8: true, qualify_count: 8, points: 4, goal_difference: 0, goals_for: 3,
    margin: { points: 2, goal_difference: 1, vs_rank: 9, vs_team: "ZZZ" }, decided: false,
    summary: "Currently the 6th-best of 12 third-placed teams — inside the top eight that advance, 2 points clear of the cut-off.",
    provisional_note: "Best-third order is provisional until all 12 groups finish.",
  },
});

// ---- Gemini call mechanism (reused identically from tactical-launch-readiness-gemini-test.ts) ----
async function timedFetch(u: string, init: any, ms: number) { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); try { return await fetch(u, { ...init, signal: c.signal }); } finally { clearTimeout(t); } }
export async function chooseGeminiModel(apiKey: string): Promise<string> {
  try {
    const res = await timedFetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`, {}, 20000);
    const j: any = await res.json().catch(() => ({}));
    const names = Array.isArray(j?.models) ? j.models.map((m: any) => String(m.name).replace(/^models\//, "")) : [];
    return names.find((id: string) => /^gemini-3\.5-flash$/i.test(id)) || names.find((id: string) => /gemini.*3\.5.*flash/i.test(id)) || "gemini-3.5-flash";
  } catch { return "gemini-3.5-flash"; }
}
// Per-run Gemini token accounting (VISIBILITY ONLY — never changes the request/prompt/output). Accumulates
// promptTokenCount / cachedContentTokenCount / candidatesTokenCount across the run so the implicit-cache hit
// rate is visible in the loop logs. cachedContentTokenCount reflects implicit cache hits (on by default for
// Gemini 2.5+/3.x): a high cached/prompt ratio on calls 2..N of a burst = the repeated 7.75k-token system
// prompt is being discounted automatically at the cached rate.
export const geminiTokenStats = { calls: 0, promptTokens: 0, cachedTokens: 0, outputTokens: 0 };
export async function callGemini(apiKey: string, model: string, systemPrompt: string, userMsg: string): Promise<string> {
  const res = await timedFetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: systemPrompt }] }, contents: [{ role: "user", parts: [{ text: userMsg }] }], generationConfig: { temperature: 0.1, maxOutputTokens: 1800, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } } }),
  }, 60000);
  const j: any = await res.json().catch(async () => ({ raw: await res.text().catch(() => "") }));
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${JSON.stringify(j).slice(0, 400)}`);
  // VISIBILITY ONLY (reads the response usage block; does NOT touch the call, prompt, or output).
  const um: any = j.usageMetadata ?? {};
  const promptTok = Number(um.promptTokenCount ?? 0), cachedTok = Number(um.cachedContentTokenCount ?? 0), outTok = Number(um.candidatesTokenCount ?? 0);
  geminiTokenStats.calls++; geminiTokenStats.promptTokens += promptTok; geminiTokenStats.cachedTokens += cachedTok; geminiTokenStats.outputTokens += outTok;
  console.error(`  narration cache: ${cachedTok}/${promptTok} prompt tokens cached (${promptTok ? Math.round((cachedTok / promptTok) * 100) : 0}%) | output ${outTok}`);
  return (j.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("\n").trim();
}

// ---- PART B: group context — the focal team's 3 same-group rivals, read from the SAME conditioned advancement
// doc (NO recompute; same single source of truth as the focal numbers). Ordered by advance_total (the chance-to-
// reach-knockouts race). Calibrated to the REAL gap so the AI can place the team honestly (tight reads tight,
// clear reads clear) and name the closest rival(s). Rival `advance` values are numbers under scenario_data, so
// validate-and-repair treats any rival % the AI states as grounded; an invented rival figure is rejected.
export function buildGroupContext(scenAll: any, nameByCode: Record<string, string>, code: string, group: string) {
  if (!scenAll || !group || group === "?") return null;
  const NARROW = 0.06, CLEAR = 0.12;
  const rows = Object.keys(scenAll)
    .filter((c) => scenAll[c]?.group_code === group)
    .map((c) => ({ team_code: c, team_name: nameByCode[c] ?? c, advance: num(scenAll[c]?.probabilities?.advance_total) }))
    .sort((a, b) => b.advance - a.advance)
    .map((r, i) => ({ ...r, position: i + 1, display_advance: pct(r.advance) }));
  const idx = rows.findIndex((r) => r.team_code === code);
  if (idx < 0 || rows.length < 2) return null;
  const focal = rows[idx];
  const above = idx > 0 ? rows[idx - 1] : null;
  const below = idx < rows.length - 1 ? rows[idx + 1] : null;
  const gAbove = above ? +(above.advance - focal.advance).toFixed(3) : null;
  const gBelow = below ? +(focal.advance - below.advance).toFixed(3) : null;
  const nm = (x: any) => (x ? x.team_name : "");
  // rivals genuinely close to the focal team (within NARROW), by name — the ones to mention as "right behind / neck and neck"
  const close_rivals = rows.filter((r) => r.team_code !== code && Math.abs(r.advance - focal.advance) <= NARROW)
    .map((r) => ({ team_code: r.team_code, team_name: r.team_name, advance: r.advance, display_advance: r.display_advance, position: r.position }));
  let shape: string, guidance: string;
  if (focal.position === 1) {
    if (gBelow != null && gBelow <= NARROW) { shape = "leading_tight"; guidance = `Top of the group, but only just — ${nm(below)} are right on their heels. Convey a genuinely tight race at the top and name the close rival(s); do NOT call it comfortable.`; }
    else if (gBelow != null && gBelow >= CLEAR) { shape = "leading_clear"; guidance = `Comfortably clear at the top — say so plainly; the rest are well off the pace. Do NOT manufacture a race. ${nm(below)} are nearest, but with daylight.`; }
    else { shape = "leading_slim"; guidance = `Narrowly ahead at the top, ${nm(below)} the closest challenger — a slender lead, not a runaway.`; }
  } else if (focal.position === rows.length) {
    if (gAbove != null && gAbove <= NARROW) { shape = "bottom_in_touch"; guidance = `Bottom of the group but still in touch — ${nm(above)} are only just ahead and catchable. Scrapping, not out of it.`; }
    else if (gAbove != null && gAbove >= CLEAR) { shape = "bottom_adrift"; guidance = `Up against it at the foot of the group, real ground to make up on ${nm(above)}. Dignified, never mocking.`; }
    else { shape = "bottom_chasing"; guidance = `Chasing from the back of the group; ${nm(above)} are the team to catch.`; }
  } else {
    const closeAbove = gAbove != null && gAbove <= NARROW, closeBelow = gBelow != null && gBelow <= NARROW;
    if (closeAbove && closeBelow) { shape = "tight_cluster"; guidance = `In the thick of a tight cluster — ${nm(above)} just ahead, ${nm(below)} just behind. Convey a congested race; name both.`; }
    else if (closeAbove) { shape = "chasing_close"; guidance = `Right in the mix, ${nm(above)} just ahead and very catchable — a live race for the spot.`; }
    else if (closeBelow) { shape = "holding_off"; guidance = `Holding their place but ${nm(below)} are pressing from behind — convey that pressure.`; }
    else { shape = "mid"; guidance = `Mid-table in the group${above ? ", " + nm(above) + " ahead" : ""}${below ? ", " + nm(below) + " behind" : ""}; neither a dead heat nor adrift.`; }
  }
  return {
    group_code: group, order_by: "advance_total (chance to reach the knockouts)", focal_position: focal.position,
    teams: rows,
    nearest_rival_above: above ? { team_code: above.team_code, team_name: above.team_name, advance: above.advance, display_advance: above.display_advance, gap: gAbove } : null,
    nearest_rival_below: below ? { team_code: below.team_code, team_name: below.team_name, advance: below.advance, display_advance: below.display_advance, gap: gBelow } : null,
    close_rivals, shape, guidance,
    note: "Place the focal team in this group race in 1-2 sentences, naming the closest rival(s) by team name. The advance numbers here are grounded — any rival % stated must be one of these; keep raw numbers light.",
  };
}

// ---- TEAM STORY (curated national-context RAG) — optional, source-grounded, SHIPS DARK ----
// Loads data/team-stories/{CODE}.json and gates it before it reaches the model. GRACEFUL by design: a missing,
// invalid, unreviewed, or malformed file -> null -> contextual_inputs.team_story stays null and narration is
// UNCHANGED from today. Hard gates (drop the whole story): not an object; review_status != 'reviewed'; a percentage
// in any text field (the output validator rejects ungrounded percentages — keep mood in WORDS); an internal-ID/UUID
// pattern in text. Outlet allowlist (data/team-stories/_outlet-allowlist.json) is enforced at curation/CI time, not here.
const TEAM_STORIES_DIR = path.join(rootDir, "data", "team-stories");
const STORY_PCT = /\d\s*%|\bper\s?cent\b|\bpercent\b/i;
const STORY_INTERNAL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|monte[-_ ]?carlo|\bv\d+\.\d+\b|current_best|tournament_simulation|team_tactical_|player-impact-|team-strength-/i;
const STORY_SKIP_KEYS = new Set(["url", "designed_for", "_guidance"]);
function collectStoryText(v: any, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) collectStoryText(x, out);
  else if (v && typeof v === "object") for (const k of Object.keys(v)) { if (STORY_SKIP_KEYS.has(k)) continue; collectStoryText(v[k], out); }
  return out;
}
export function validateTeamStory(story: any, code: string): any | null {
  if (!story || typeof story !== "object" || Array.isArray(story)) return null;
  if (story.review_status !== "reviewed") { console.error(`[team_story] ${code}: review_status='${story.review_status ?? "missing"}' (not 'reviewed') -> skipped`); return null; }
  if (story.team_code && String(story.team_code).toUpperCase() !== code) console.error(`[team_story] ${code}: file team_code='${story.team_code}' != filename -> using filename code`);
  if (story.designed_for && story.designed_for !== PROMPT_VERSION) console.error(`[team_story] ${code}: designed_for='${story.designed_for}' != ${PROMPT_VERSION} (proceeding; re-check rules)`);
  const texts = collectStoryText(story);
  const badPct = texts.find((t) => STORY_PCT.test(t));
  if (badPct) { console.error(`[team_story] ${code}: a text field contains a percentage ("${badPct.slice(0, 60)}") — mood must be in WORDS -> skipped`); return null; }
  const badId = texts.find((t) => STORY_INTERNAL.test(t));
  if (badId) { console.error(`[team_story] ${code}: a text field contains an internal identifier ("${badId.slice(0, 60)}") -> skipped`); return null; }
  const { _guidance, ...clean } = story;
  return clean;
}
export function loadTeamStory(code: string): any | null {
  const fp = path.join(TEAM_STORIES_DIR, `${code}.json`);
  if (!existsSync(fp)) return null;
  let parsed: any;
  try { parsed = JSON.parse(readFileSync(fp, "utf8")); }
  catch (e: any) { console.error(`[team_story] ${code}: JSON parse failed (${String(e?.message ?? e).slice(0, 80)}) -> skipped`); return null; }
  return validateTeamStory(parsed, code);
}

// ---- build the structured scenario_narration input (ID-FREE; plain source labels only) ----
export function buildScenarioInput(teamCode: string, teamName: string, group: string, scen: any, ko: any, cond?: any, realCtx?: any, groupCtx?: any, teamStory?: any) {
  const pr = scen?.probabilities ?? {};
  const advance = num(pr.advance_total), winG = num(pr.win_group), runnerUp = num(pr.runner_up), topTwo = +(winG + runnerUp).toFixed(4), third = num(pr.third_place_advance);
  const tpd = scen?.third_place_dependency ?? {};
  const lockedRecord = tpd.locked_record_third_place ?? null;
  const probabilities = [
    { entity_type: "team", team_code: teamCode, metric: "advance", value: advance, display_value: pct(advance), rank_or_context: "overall chance to reach the Round of 32" },
    { entity_type: "team", team_code: teamCode, metric: "top_two", value: topTwo, display_value: pct(topTwo), rank_or_context: "finish top two of the group (own results)" },
    { entity_type: "team", team_code: teamCode, metric: "win", value: winG, display_value: pct(winG), rank_or_context: "win the group" },
    { entity_type: "team", team_code: teamCode, metric: "runner_up", value: runnerUp, display_value: pct(runnerUp), rank_or_context: "finish runner-up" },
    { entity_type: "team", team_code: teamCode, metric: "third_place_advance", value: third, display_value: pct(third), rank_or_context: "advance as one of the best third-placed teams" },
  ];
  const paths = (scen?.what_they_need ?? []).map((w: any, i: number) => {
    const routeLockedRecord = w.locked_record_requirement ?? (w.condition_label === "Advance as best third" ? lockedRecord : null);
    const cannotPassGroups = routeLockedRecord
      ? [...(routeLockedRecord.already_settled_cannot_beat_groups ?? []), ...(routeLockedRecord.cannot_beat_groups ?? [])]
      : [];
    return {
      path_id: `route_${i + 1}`, summary: String(w.condition_label ?? ""),
      must_happen: [String(routeLockedRecord?.statement ?? w.own_results_needed ?? "")],
      helpful_results: [],
      risk_notes: routeLockedRecord
        ? [
          routeLockedRecord.status === "already_safe" ? "This finished third is mathematically safe on the locked-record comparison." : "",
          (routeLockedRecord.can_beat_groups ?? []).length ? `Watch groups that can still pass this record: ${(routeLockedRecord.can_beat_groups ?? []).join(", ")}` : "",
          cannotPassGroups.length ? `Groups that cannot pass this record: ${cannotPassGroups.join(", ")}` : "",
        ].filter(Boolean)
        : ((w.depends_on_groups ?? []).length ? [`This route depends on results in other groups: ${(w.depends_on_groups ?? []).join(", ")}`] : []),
      probability_refs: [{ metric: w.condition_label?.toLowerCase().includes("win") ? "win" : w.condition_label?.toLowerCase().includes("runner") ? "runner_up" : "third_place_advance", value: num(w.scenario_weight) }],
    };
  });
  // ---- AUGMENT with the deterministic conditional engine (team_conditional_scenarios) when supplied ----
  // Crisp margin tiers + cross-group bubble thresholds when the engine row is final-matchday ('concrete_chains');
  // sound point-bound certainties in any mode; otherwise the probabilistic routes above carry the narration (no fabrication).
  const asArr = (v: any) => Array.isArray(v) ? v : (typeof v === "string" ? (() => { try { return JSON.parse(v); } catch { return []; } })() : []);
  let deterministic_mode = "none";
  let certain_statements: string[] = [];
  if (cond) {
    deterministic_mode = String(cond.mode ?? "none");
    certain_statements = asArr(cond.certain_statements).map((s: any) => typeof s === "string" ? s : String(s?.statement ?? "")).filter(Boolean);
    if (deterministic_mode === "concrete_chains") {
      asArr(cond.concrete_chains).forEach((ch: any, i: number) => {
        const bubble = asArr(ch.bubble_dependencies).map((b: any) => `${b.group}'s third-placed team overtakes if ${b.overtakes_can_if}`);
        paths.push({
          path_id: `crisp_${i + 1}`,
          summary: `${ch.condition} -> ${ch.outcome}`,
          must_happen: ch.outcome === "CLINCH" ? [String(ch.detail ?? ch.condition)] : [],
          helpful_results: ch.outcome === "CLINCH" ? [`A result of "${ch.condition}" clinches it regardless of other groups.`] : [],
          risk_notes: [
            ...(ch.outcome === "DEPENDS" || ch.outcome === "ELIMINATED" ? [String(ch.detail ?? "")] : []),
            ...bubble,
            ...(ch.eliminated_if ? [String(ch.eliminated_if)] : []),
          ].filter(Boolean),
          probability_refs: [],
        });
      });
    }
  }
  // ---- AUGMENT (third layer) with the REAL best-third resolver output (real_standings) when supplied ----
  // Probabilistic = the odds; conditional engine = what they need; THIS = where they stand NOW. All complementary.
  // Fills the AI's standings slot (the team's real group table) + a best_third_standing fact in scenario_data.
  // Graceful: not started / absent -> empty standings + an explicit unknown; never fabricated.
  const realStarted = realCtx?.started === true;
  const standingsBlock = realStarted && (realCtx.groupTable?.length ?? 0) > 0
    ? { standings_source_id: "the-real-group-table", groups: [{ group_code: group, rows: realCtx.groupTable }] }
    : { standings_source_id: null, groups: [] as any[] };
  const realTableStatus = realStarted ? (realCtx.status ?? "in_progress") : "not_started";
  const bestThirdStanding = (realStarted && realCtx.bestThird) ? { source_id: "the-real-best-third-race", ...realCtx.bestThird } : null;
  const awaitingOpener = !realStarted && realCtx?.awaiting_opener ? realCtx.awaiting_opener : null;
  const groupProgress = realStarted && realCtx?.group_progress ? realCtx.group_progress : null;
  const realUnknowns = realStarted
    ? (realCtx.bestThird ? [] : ["This team is not currently third in its group, so it is not in the best-third race right now."])
    : (awaitingOpener
      ? [`This team has not played yet, but its group HAS begun (${awaitingOpener.results_so_far.join("; ") || "results pending"}) — acknowledge those results; do not claim a current position for this team and do not say the group has not started.`]
      : ["No real group standings yet — group games have not started, so the best-third race has not begun."]);

  return {
    request_id: `scenario-${teamCode}`,
    content_type: "scenario_narration", language: "en",
    generated_for: { tournament_code: "WC2026", team_codes: [teamCode], fixture_ids: [], date: null },
    output_requirements: { schema_version: "ai_analysis_v1", length_target_words: { min: 100, max: 200 }, tone: "warm, plain-spoken, light earned sporting drama (no hype/clichés), grounded, non-betting", must_return_json_only: true },
    source_runs: [{ source_run_id: "group-stage-simulation", run_type: "group_simulation", scope: "group stage", review_status: "live", current_best: false, notes: "the group-stage tournament simulation" }],
    probabilities,
    scenario_data: {
      scenario_source_id: "the-2026-advancement-rules",
      team_code: teamCode,
      scenario_type: "what_team_needs",
      group_context: groupCtx ?? null,
      deterministic_rules_source_id: "the-2026-advancement-rules",
      paths,
      certain_statements,
      deterministic_mode,
      locked_record_third_place: lockedRecord,
      deterministic_engine: deterministic_mode === "concrete_chains"
        ? "Final-matchday crisp margin tiers + cross-group thresholds supplied by the deterministic 2026 qualification scenario engine. Translate these as-is; do not invent."
        : (lockedRecord ? "Finished-third locked-record mode is available. Translate its exact statement as-is; do not replace it with generic other-groups caveats." : "Crisp final-matchday chains not available yet (earlier round) - use the probabilistic routes plus the sound point-bound certainties."),
      real_table_status: realTableStatus,
      awaiting_opener: awaitingOpener,
      group_progress: groupProgress,
      best_third_standing: bestThirdStanding,
      real_standing_note: bestThirdStanding
        ? "Where the team stands NOW in the cross-group third-place race, from the real verified table. State this current rank and margin as deterministic fact; it complements (does not replace) the probabilities and the what-they-need routes."
        : (realStarted ? "Real table has results, but this team is not currently third - its position is in the standings block." : "No real standings yet (pre-tournament)."),
      tiebreaker_notes: [{ rule: "Group ranking uses the 2026 rules: points, then head-to-head, then goal difference, then goals scored, then fair play, then FIFA ranking", source_id: "the-2026-advancement-rules" }],
      unknowns: [...realUnknowns],
    },
    fixtures: [], standings: standingsBlock,
    team_context: [{ team_code: teamCode, team_name: teamName, team_strength: { source_id: null, score: null, confidence: "unknown", caveat: "context only" }, player_impact: { source_id: null, summary: null, confidence: "unknown", caveat: null }, tactical_profile: { source_id: null, base_snapshot_id: null, review_status: "unknown", confidence: "unknown", usable_fields: { formation_primary: "unknown", pressing_intensity: "unknown", build_up_style: "unknown", defensive_block_depth: "unknown", set_piece_strength: "unknown", transition_style: "unknown", attacking_width: "unknown" }, source_urls: [], caveat: "no signal" } }],
    contextual_inputs: { venue: [], weather: [], news_and_injuries: [], team_story: teamStory ?? null },
    forbidden_sources_confirmed_absent: { odds: true, api_football_predictions_endpoint: true, raw_uncurated_web: true },
    known_unknowns: ["No lineups, injuries, or live results supplied (pre-tournament)"],
    _meta_in_their_hands: topTwo >= third,
    // _third_race surfaces BOTH probabilities the prose must keep distinct: the JOINT third_place_advance (in `probabilities`,
    // ~P(finish third AND advance), naturally small for a top-two team) vs the CONDITIONAL passes_cutoff_in_pct =
    // P(advance | finish third) = how SAFE the back-door actually is. Verbatim from the engine's third_place_dependency
    // (no number changed) so the model can call a high-passes_cutoff route SAFE rather than "slim".
    _third_race: {
      in_race: tpd.is_in_third_race === true,
      watch_groups: tpd.competing_third_groups ?? [],
      passes_cutoff_in_pct: tpd.passes_cutoff_in_pct ?? null,
      conditional_advance_display: tpd.passes_cutoff_in_pct != null ? pct(num(tpd.passes_cutoff_in_pct)) : null,
      needs: tpd.needs ? String(tpd.needs).replace(/\s*\(most often \)/g, "") : null,  // defensive: drop a stale empty "(most often )" fragment (the engine fix in advancement-scenario-core omits it going forward)
      locked_record: lockedRecord,
      route_safety_note: "passes_cutoff_in_pct = P(advance GIVEN they finish third) = the SAFETY of the back-door route; distinct from probabilities.third_place_advance which is the JOINT P(finish third AND advance). A HIGH passes_cutoff_in_pct means the route is SAFE/reliable, NOT slim.",
    },
  };
}

export const USER_MSG = (input: any, max: number) => [
  "Return one complete valid JSON object only. No markdown, no code fences.",
  "Write this team's group-stage advancement story for FANS — warm, human, and strictly faithful to the supplied numbers.",
  "VOICE: Warm and plain-spoken, like a knowledgeable friend talking a fan through it — NOT a clinical report. Allow light, EARNED sporting drama that fits the team's real situation, but NO hype and NO clichés ('destiny', 'dreamland', 'mission', 'write-off'). Calibrate the drama to where they ACTUALLY stand: a favourite reads calm and assured; a team on the bubble reads tense; a side that has clinched reads quietly proud; an eliminated side reads dignified, never mocking. Lead with what it MEANS in human terms before any number.",
  "NUMBERS: Keep the headline advancement chance as a real figure wrapped in human phrasing ('a 74% chance', 'around three-in-four') — but translate MOST secondary figures (top-two, third-place) into words ('more likely than not', 'roughly a coin flip'). Fewer raw numbers in the prose; the exact percentages live in the app's visuals. Say 'reach the knockouts' (you may clarify 'the Round of 32' once).",
  "ACCURACY OVER ACCESSIBILITY — calibrate the words to the supplied 'advance' value and NEVER overstate: below ~35% = an outside chance / uphill; ~35-50% = a real chance, roughly a coin flip; ~50-65% = more likely than not / in a decent position; ~65-80% = well placed / a strong chance; above ~80% = a very strong position / expected to go through. A figure near a boundary takes the more cautious wording. A 44% chance is 'about a coin flip', never 'very likely'.",
  "GROUP CONTEXT (add ONE or TWO sentences): Using scenario_data.group_context, place this team within its group — are they clear at the top, in a tight cluster, chasing, or scrapping at the bottom — and NAME the closest rival(s) by team name (see nearest_rival_above / nearest_rival_below / close_rivals). Follow group_context.shape and group_context.guidance, and calibrate to the REAL gap: a NARROW gap → convey a tight race and name who's close ('Germany right on their heels'); a CLEAR gap → say they're comfortably ahead / well off the pace and do NOT manufacture a race that isn't there. Keep it light — 'right behind', 'neck and neck', 'well clear' — one comparative figure is fine if it adds punch ('Germany right on their heels at 77%').",
  "NATIONAL STORY (optional, at most 1-2 sentences — ONLY when contextual_inputs.team_story is present and not null): weave in at most ONE storyline OR one short attributed quote (<=20 words) from team_story that genuinely fits this team's situation. A 'official'+fact_grade item may be stated as fact; a 'discovery'+attributed_context_only item MUST be attributed ('per Marca', 'Spanish coverage suggests', 'the manager told AS'). Mood is in WORDS, never a number. Reported availability (confirmed:false) is hedged ('reports suggest'), never stated as fact and never moves a chance. Honour team_story.gaps and any absent/'unknown' field — do NOT fill them from outside knowledge. Never let the story contradict or soften the numbers. If team_story is null, write NOTHING about national mood — do not infer it.",
  "Ground EVERY percentage you state in the SUPPLIED input — the 'probabilities' array for this team AND scenario_data.group_context for any rival figure. Do NOT invent, combine, or derive any new percentage, including a rival's. If a rival number isn't in group_context, describe the gap in words instead.",
  "Cover, in plain language: the team's chance to reach the knockouts, whether their main route is finishing top two (their own results) or leaning on the best-third back door, and what they need.",
  "BEST-THIRD ROUTE — TWO DIFFERENT PROBABILITIES, NEVER CONFLATE THEM. probabilities.third_place_advance is a JOINT chance (the team BOTH finishes third AND that third is good enough); it is naturally small whenever the team usually finishes top two, and it is NOT a measure of how safe the back-door is. The SAFETY of the back-door is _third_race.passes_cutoff_in_pct = P(advance GIVEN they finish third), stated in plain words in _third_race.needs ('Finishing 3rd, X advances in ~N% of cases'). Characterise the route from THAT, not from the joint figure. RULE: when _third_race.passes_cutoff_in_pct is high (>= ~0.85) the back-door is RELIABLE/SAFE — say 'even if they slip to third they'd almost certainly still go through' or call it a dependable safety net, and NEVER call it 'slim', 'a long shot', 'a slim back-door', or 'out of their hands'. Reserve slim / outside / at-the-mercy-of-other-groups wording ONLY for a LOW passes_cutoff route. Keep the likelihood of NEEDING the route (a fallback they may rarely need) SEPARATE from its safety — e.g. 'They'll most likely go through in the top two, but even if they finish third they'd advance in nearly every case.' You may give the conditional figure once via _third_race.conditional_advance_display; never present the joint third_place_advance as if it were the route's safety.",
  "LOCKED-RECORD THIRD-PLACE MODE: If _third_race.locked_record is supplied, use its statement as the exact requirement. For status already_safe, say mathematically safe/already through; for status conditional, state the exact no-more-than requirement and watch groups. Do NOT replace it with generic 'depends on other groups' wording.",
  "If the input supplies a real group table (standings) and scenario_data.best_third_standing, state the team's CURRENT standing — its real group position and, when present, its best-third rank and margin to the cut-off (e.g. 'currently the 6th-best third, two points above the cut') — kept plain and accurate, as facts that COMPLEMENT the chances. If no real standings are supplied AND scenario_data.awaiting_opener is absent, say the group games have not started — but keep it warm; never invent a standing.",
  "PARTIAL GROUP — TEAM HAS PLAYED (scenario_data.group_progress present with round_complete=false): acknowledge the team's result and provisional position, AND name the rivals_yet_to_play as still to play — make clear the table will move once they do. NEVER present this provisional standing as settled, and frame any rival's chance as 'heading into their opener/next game', never as a settled position.",
  "AWAITING OPENER (scenario_data.awaiting_opener present — this team has NOT played, but some group games HAVE finished): say the team is awaiting its opening game AND briefly acknowledge what has already happened using results_so_far (e.g. 'Mexico opened with a 2-0 win over South Africa'). Do NOT say the group has not started, and do NOT claim any current position, points, or rank for THIS team — it has none yet.",
  "ROUND COMPLETE (scenario_data.group_progress.round_complete=true): every team has played the same number of games — describe the table as the genuine after-round picture (positions, points), still noting the group is not finished until all three rounds are played.",
  "Plain language, non-betting. No model names, run IDs, table names, version tags, or internal jargon. Real people only as on-pitch facts.",
  "Required JSON fields: content_type, headline, body, probability_references, source_trace, context_caveats, unknowns, validation_notes.",
  `Keep the body within ${max} words.`,
  `Structured input:\n${JSON.stringify(input)}`,
].join("\n\n");

// ============ KNOCKOUT NARRATION (content types pre_match_storyline + post_result_change) ============
// Fixture-scoped consumer of contextual_inputs.team_story + the knockout per-tie data. ENGINES COMPUTE, AI EXPLAINS:
// the per-tie K=60 win prob is read VERBATIM from the published app-data export (build-app-data knockout_fixtures[].prediction
// — the single source of truth, already carries resolved teams + elo_source + basis); the AI explains it, never invents one.
// Context tables (wc2026_*) are keyed by API-Football team_id -> map via live/api-team-code-map.json. Graceful: a missing
// input is omitted (no team_story -> skip the national bits; xG not matured -> the post-match waits).
function loadKnockoutFixtures(): any[] {
  for (const rel of ["data/exports/app-data.json", "ui/app-data.json"]) {
    try { const j = JSON.parse(readFileSync(path.join(rootDir, rel), "utf8")); if (Array.isArray(j?.knockout_fixtures)) return j.knockout_fixtures; } catch { /* try next */ }
  }
  return [];
}
let _apiIdByCode: Record<string, number> | null = null;
function apiIdByCode(): Record<string, number> {
  if (_apiIdByCode) return _apiIdByCode;
  const m: Record<string, number> = {};
  try {
    const raw = JSON.parse(readFileSync(path.join(rootDir, "scripts/worldcup/live/api-team-code-map.json"), "utf8"));
    for (const [id, code] of Object.entries(raw)) { if (id.startsWith("_")) continue; m[String(code)] = Number(id); }
  } catch { /* empty map -> context joins yield null, narration stays graceful */ }
  return (_apiIdByCode = m);
}
function idToCodeMap(): Record<number, string> { const m: Record<number, string> = {}; for (const [code, id] of Object.entries(apiIdByCode())) m[id] = code; return m; }
function teamFormByCode(url: string, codes: string[]): Record<string, any> {
  const ids = codes.map((c) => apiIdByCode()[c]).filter(Boolean);
  if (!ids.length) return {};
  const i2c = idToCodeMap(), out: Record<string, any> = {};
  try {
    const rows = q(url, `select team_id, played, wins, draws, loses, goals_for, goals_against, clean_sheets, failed_to_score, streak_wins, streak_draws, streak_loses from wc2026_team_statistics where team_id in (${ids.join(",")})`);
    for (const r of rows as any[]) { const c = i2c[Number(r.team_id)]; if (c) out[c] = { played: Number(r.played), wins: Number(r.wins), draws: Number(r.draws), loses: Number(r.loses), goals_for: Number(r.goals_for), goals_against: Number(r.goals_against), clean_sheets: Number(r.clean_sheets), failed_to_score: Number(r.failed_to_score), streak: { wins: Number(r.streak_wins), draws: Number(r.streak_draws), loses: Number(r.streak_loses) } }; }
  } catch { /* table absent -> empty */ }
  return out;
}
function h2hForPair(url: string, aCode: string, bCode: string): any {
  const idA = apiIdByCode()[aCode], idB = apiIdByCode()[bCode];
  if (!idA || !idB) return { meetings: 0 };
  const pk = [idA, idB].sort((x, y) => x - y).join("-");
  try {
    const rows = q(url, `select home_team_name, away_team_name, home_goals, away_goals, winner_team_id, to_char(meeting_date,'YYYY') yr, league_name from wc2026_head_to_head where pairing_key='${pk}' order by meeting_date desc nulls last`);
    if (!rows.length) return { meetings: 0 };
    let aWins = 0, bWins = 0, draws = 0;
    for (const r of rows as any[]) { if (r.winner_team_id == null) draws++; else if (Number(r.winner_team_id) === idA) aWins++; else if (Number(r.winner_team_id) === idB) bWins++; }
    const last: any = rows[0];
    return { meetings: rows.length, [aCode]: aWins, [bCode]: bWins, draws, last_meeting: { year: last.yr, home: last.home_team_name, away: last.away_team_name, score: `${last.home_goals}-${last.away_goals}`, competition: last.league_name } };
  } catch { return { meetings: 0 }; }
}
function topScorersForTeams(url: string, codes: string[]): any[] {
  const ids = codes.map((c) => apiIdByCode()[c]).filter(Boolean);
  if (!ids.length) return [];
  const i2c = idToCodeMap();
  try {
    const rows = q(url, `select player_name, team_id, goals, assists, rank from wc2026_player_leaderboards where leaderboard_type='top_scorers' and team_id in (${ids.join(",")}) order by goals desc nulls last limit 6`);
    return (rows as any[]).map((r) => ({ player: r.player_name, team_code: i2c[Number(r.team_id)] ?? null, goals: Number(r.goals), assists: r.assists != null ? Number(r.assists) : null, board_rank: r.rank != null ? Number(r.rank) : null }));
  } catch { return []; }
}
export function buildKnockoutPreMatchInput(url: string, kf: any) {
  const aCode = kf.side_a?.team?.code, bCode = kf.side_b?.team?.code;
  const aName = kf.side_a?.team?.name ?? aCode, bName = kf.side_b?.team?.name ?? bCode;
  const pred = kf.prediction ?? {};
  const pA = pred.team_a_win_probability != null ? num(pred.team_a_win_probability) : null;
  const pB = pred.team_b_win_probability != null ? num(pred.team_b_win_probability) : null;
  const form = teamFormByCode(url, [aCode, bCode]);
  const h2h = h2hForPair(url, aCode, bCode);
  const danger = topScorersForTeams(url, [aCode, bCode]);
  const storyA = loadTeamStory(aCode), storyB = loadTeamStory(bCode);
  return {
    request_id: `ko-pre-${aCode}-${bCode}`,
    content_type: "pre_match_storyline", language: "en",
    generated_for: { tournament_code: "WC2026", team_codes: [aCode, bCode], fixture_ids: [], date: kf.kickoff ?? null },
    output_requirements: { schema_version: "ai_analysis_v1", length_target_words: { min: 120, max: 230 }, tone: "warm, plain-spoken, knockout stakes, light EARNED drama, grounded, non-betting", must_return_json_only: true },
    source_runs: [{ source_run_id: "knockout-elo-prediction", run_type: "knockout_prediction", scope: "knockout", review_status: "live", current_best: false, notes: pred.elo_source === "post_group_k60" ? "the knockout model, updated on group-stage form" : "the pre-tournament knockout model" }],
    fixture: { round: kf.round ?? null, label: `${aCode} vs ${bCode}`, kickoff: kf.kickoff ?? null, venue: kf.venue ?? null, city: kf.city ?? null, single_elimination: true },
    probabilities: [
      pA != null ? { entity_type: "team", team_code: aCode, metric: "win_tie", value: pA, display_value: pct(pA), rank_or_context: `${aName} win this knockout tie (single match; extra time / penalties subsumed)` } : null,
      pB != null ? { entity_type: "team", team_code: bCode, metric: "win_tie", value: pB, display_value: pct(pB), rank_or_context: `${bName} win this knockout tie` } : null,
    ].filter(Boolean),
    scenario_data: {
      matchup_source_id: "the-knockout-model",
      prediction_basis: pred.basis ?? null,
      prediction_note: "The win probability is the model's neutral single-match figure (extra time / penalties subsumed). Explain it; never invent a different number.",
      form: { [aCode]: form[aCode] ?? null, [bCode]: form[bCode] ?? null },
      head_to_head: h2h,
      danger_men: danger,
      stakes: "Knockout: one match decides it.",
      unknowns: [
        ...(storyA ? [] : [`No national-story file for ${aCode} — do not describe ${aName}'s national mood.`]),
        ...(storyB ? [] : [`No national-story file for ${bCode} — do not describe ${bName}'s national mood.`]),
        ...((form[aCode] || form[bCode]) ? [] : ["No aggregate team form supplied."]),
        ...((h2h?.meetings ?? 0) > 0 ? [] : ["No prior head-to-head meetings supplied."]),
      ],
    },
    team_context: [{ team_code: aCode, team_name: aName }, { team_code: bCode, team_name: bName }],
    contextual_inputs: { venue: [], weather: [], news_and_injuries: [], team_story: { [aCode]: storyA ?? null, [bCode]: storyB ?? null } },
    forbidden_sources_confirmed_absent: { odds: true, api_football_predictions_endpoint: true, raw_uncurated_web: true },
    known_unknowns: ["No live lineups or in-play data supplied (pre-match)."],
  };
}
export function buildKnockoutPostMatchInput(url: string, fixtureLabel: string): any {
  const mm = (fixtureLabel || "").match(/([A-Za-z]{3})\s*vs\s*([A-Za-z]{3})/);
  if (!mm) return { error: `bad fixture label '${fixtureLabel}' (expected 'AAA vs BBB')` };
  const aCode = mm[1].toUpperCase(), bCode = mm[2].toUpperCase();
  const mr: any = q(url, `select api_football_fixture_id fid, team_a_code a, team_b_code b, team_a_goals::int ga, team_b_goals::int gb, round_name,
      (source_snapshot->'provider_fixture'->'score'->'penalty'->>'home') ph, (source_snapshot->'provider_fixture'->'score'->'penalty'->>'away') pa
    from match_results where tournament_code='WC_2026' and match_status='finished' and api_football_fixture_id is not null and fixture_metadata_id is null
      and ((team_a_code='${aCode}' and team_b_code='${bCode}') or (team_a_code='${bCode}' and team_b_code='${aCode}'))
    order by updated_at desc limit 1`)[0];
  if (!mr) return { error: `no finished knockout result for ${aCode} vs ${bCode}` };
  const fid = Number(mr.fid);
  const enr: any = q(url, `select statistics_status from wc2026_fixture_enrichment_status where api_football_fixture_id=${fid}`)[0];
  const xgRows = q(url, `select team_id, stat_value_numeric v from api_football_fixture_statistics where fixture_id=${fid} and stat_type='expected_goals'`);
  if (enr?.statistics_status !== "present" || (xgRows as any[]).length < 2) return { not_matured: true, fixture: `${aCode} vs ${bCode}`, fixture_id: fid, statistics_status: enr?.statistics_status ?? "unknown", xg_rows: (xgRows as any[]).length };
  const i2c = idToCodeMap();
  const xgByCode: Record<string, number> = {}; for (const r of xgRows as any[]) { const c = i2c[Number(r.team_id)]; if (c) xgByCode[c] = num(r.v); }
  const goals = (q(url, `select team_id, player_name, event_elapsed, event_extra, assist_player_name from api_football_fixture_events where fixture_id=${fid} and event_type='Goal' order by event_elapsed nulls last, event_extra nulls last`) as any[])
    .map((g) => ({ team_code: i2c[Number(g.team_id)] ?? null, scorer: g.player_name, minute: g.event_elapsed, assist: g.assist_player_name ?? null }));
  const top_performers = (q(url, `select player_name, team_id, rating, passes_key, goals_total, assists from api_football_fixture_player_stats where fixture_id=${fid} and rating is not null order by rating desc limit 4`) as any[])
    .map((p) => ({ player: p.player_name, team_code: i2c[Number(p.team_id)] ?? null, rating: num(p.rating), key_passes: p.passes_key != null ? Number(p.passes_key) : null, goals: p.goals_total != null ? Number(p.goals_total) : null, assists: p.assists != null ? Number(p.assists) : null }));
  const aIsHome = mr.a === aCode;
  const aGoals = aIsHome ? Number(mr.ga) : Number(mr.gb), bGoals = aIsHome ? Number(mr.gb) : Number(mr.ga);
  const pens = (mr.ph != null && mr.pa != null) ? { [aCode]: aIsHome ? Number(mr.ph) : Number(mr.pa), [bCode]: aIsHome ? Number(mr.pa) : Number(mr.ph) } : null;
  const winnerCode = aGoals > bGoals ? aCode : bGoals > aGoals ? bCode : (pens ? (pens[aCode] > pens[bCode] ? aCode : bCode) : null);
  const rn = String(mr.round_name ?? "").toLowerCase();
  const nextRound = rn.includes("32") ? "the Round of 16" : rn.includes("16") ? "the quarter-finals" : rn.includes("quarter") ? "the semi-finals" : rn.includes("semi") ? "the final" : null;
  const winnerStory = winnerCode ? loadTeamStory(winnerCode) : null;
  return {
    request_id: `ko-post-${aCode}-${bCode}`,
    content_type: "post_result_change", language: "en",
    generated_for: { tournament_code: "WC2026", team_codes: [aCode, bCode], fixture_ids: [String(fid)], date: null },
    output_requirements: { schema_version: "ai_analysis_v1", length_target_words: { min: 150, max: 290 }, tone: "warm, plain-spoken, the story of the completed tie, grounded, non-betting", must_return_json_only: true },
    source_runs: [{ source_run_id: "knockout-result", run_type: "result", scope: "knockout", review_status: "live", current_best: false, notes: "the verified match result and matured match data" }],
    fixture: { label: `${aCode} vs ${bCode}`, round: mr.round_name ?? null },
    result: { [aCode]: aGoals, [bCode]: bGoals, winner_code: winnerCode, penalties: pens, decided_on_penalties: pens != null && aGoals === bGoals },
    probabilities: [],
    scenario_data: {
      result_source_id: "the-verified-result",
      goal_timeline: goals,
      team_xg: xgByCode,
      xg_note: "Matured (final) expected goals per team. Compare the scoreline to the xG — did the result match the performance? State the xG as supplied; never invent a figure.",
      top_performers,
      advancement: { winner_code: winnerCode, advances_to: nextRound, opponent_note: "Name the round only; the next opponent may be undetermined — gesture at 'the winner of the other tie', NEVER an undetermined team." },
      national_payoff_for: winnerCode,
      unknowns: [...(winnerStory || !winnerCode ? [] : [`No national-story file for the winner ${winnerCode}.`])],
    },
    team_context: [{ team_code: aCode, team_name: aCode }, { team_code: bCode, team_name: bCode }],
    contextual_inputs: { venue: [], weather: [], news_and_injuries: [], team_story: winnerCode ? { [winnerCode]: winnerStory ?? null } : null },
    forbidden_sources_confirmed_absent: { odds: true, api_football_predictions_endpoint: true, raw_uncurated_web: true },
    known_unknowns: [],
  };
}
export const USER_MSG_KNOCKOUT_PRE = (input: any, max: number) => [
  "Return one complete valid JSON object only. No markdown, no code fences.",
  "Write a KNOCKOUT MATCH PREVIEW for FANS — warm, plain-spoken, ~6-8 sentences, with the genuine stakes of a single-elimination tie.",
  "OPEN WITH THE HOOK: the one compelling angle of this matchup, GROUNDED in the supplied data — the prediction (favourite vs underdog), the form, the head-to-head, the danger men, or a team_story national narrative. Lead with meaning, not a number. Do NOT invent an angle from outside knowledge (player backstories, transfer histories, personal ties) unless it appears in the supplied input.",
  "THE PREDICTION + WHY: state the model's favourite and the win chance using the SUPPLIED figure (probabilities[].display_value), then explain WHY in plain terms — the rating gap and group-stage form behind it. The number is the model's; explain it, NEVER invent a different one. Do not state any percentage not in the supplied probabilities.",
  "FORM + MOMENTUM: use scenario_data.form (wins/draws, clean sheets, streaks) to say how each side arrives — in words ('unbeaten through the group', 'three clean sheets'), not a stat dump.",
  "DANGER MEN: from scenario_data.danger_men, name who carries the goal threat (the tournament's scorers); you may cite a player's goal tally as a supplied fact. Only players supplied there.",
  "HEAD-TO-HEAD: from scenario_data.head_to_head, give the history plainly IF meetings exist ('they last met in 2018, a 2-0'); if no meetings are supplied, say nothing about H2H.",
  "NATIONAL STAKES (both teams): from contextual_inputs.team_story (an object keyed by team_code), convey what each nation expects or fears — in WORDS, sourced. official+fact_grade may be stated as fact; discovery+attributed_context_only MUST be attributed ('per Marca', 'Spanish coverage suggests'), at most one short quote of <=20 words per team. If a team has no team_story, say nothing about that nation's mood. Honour gaps; a thin story means restraint; never let the story override the numbers.",
  "WHAT TO WATCH: close with the key battle, grounded in what both have shown.",
  "Mood in words, never invented numbers. No odds, no betting, no model jargon, no run IDs, no table names, no version tags. Real people only as on-pitch facts. This is the PREVIEW — do NOT predict the next round's opponent.",
  "Required JSON fields: content_type, headline, body, probability_references, source_trace, context_caveats, unknowns, validation_notes.",
  `Keep the body within ${max} words.`,
  `Structured input:\n${JSON.stringify(input)}`,
].join("\n\n");
export const USER_MSG_KNOCKOUT_POST = (input: any, max: number) => [
  "Return one complete valid JSON object only. No markdown, no code fences.",
  "Write the STORY OF A COMPLETED KNOCKOUT MATCH for FANS — warm, plain-spoken, ~5-7 sentences. The match is over; tell what happened and what it means.",
  "THE RESULT + HOW: state the final score as fact and how it unfolded — the scorers and key moments from scenario_data.goal_timeline (with minutes) and the turning points. If decided on penalties, say so.",
  "THE xG STORY (the differentiator): use scenario_data.team_xg to compare the scoreline to the performance — did the result match the play? e.g. 'won 2-1, but the expected goals were a near-even 1.8 to 1.4 — closer than the scoreline suggests', OR 'the xG confirmed the dominance'. State the xG exactly as supplied; never invent a figure. This xG is matured (final), not in-play.",
  "THE STANDOUT: from scenario_data.top_performers (match ratings), name the best performer and what they did (a goal, key passes).",
  "WHAT IT MEANS: who advances, and to which round (scenario_data.advancement.advances_to). Gesture at the next stage HONESTLY — name the round; if the next opponent is undetermined, say 'the winner of the other tie' and NEVER name an undetermined team.",
  "THE NATIONAL PAYOFF: tie the result to the WINNER's national story from contextual_inputs.team_story (keyed by the winner's code) — the run continues, a milestone reached — in WORDS, sourced (official=fact, discovery=attributed). Skip if no team_story for the winner.",
  "Mood in words, never invented numbers. The only percentages allowed are those supplied. No odds, no betting, no model jargon, no run IDs, no table names, no version tags. Real people only as on-pitch facts.",
  "Required JSON fields: content_type, headline, body, probability_references, source_trace, context_caveats, unknowns, validation_notes.",
  `Keep the body within ${max} words.`,
  `Structured input:\n${JSON.stringify(input)}`,
].join("\n\n");
async function runKnockoutNarration(url: string, mode: "pre" | "post", fixtureArg: string | null, execute: boolean) {
  const apiKey = await loadApiKey();
  const systemPrompt = readFileSync(SYSTEM_PROMPT_PATH, "utf8");
  const model = await chooseGeminiModel(apiKey);
  if (execute) ensureTable(url);
  let targets: Array<{ label: string; input: any; max: number; content_type: string }> = [];
  if (mode === "post") {
    if (!fixtureArg) { console.log(JSON.stringify({ error: "--post-result requires \"HOME vs AWAY\"" })); return; }
    const input = buildKnockoutPostMatchInput(url, fixtureArg);
    if (input?.error) { console.log(JSON.stringify({ post_match: fixtureArg, ...input }, null, 2)); return; }
    if (input?.not_matured) { console.log(JSON.stringify({ post_match: fixtureArg, status: "waiting_for_mature_xg", ...input }, null, 2)); return; }
    targets = [{ label: input.fixture.label, input, max: 285, content_type: "post_result_change" }];
  } else {
    const determined = loadKnockoutFixtures().filter((k) => k?.side_a?.team?.code && k?.side_b?.team?.code && !k?.result);
    const chosen = fixtureArg ? determined.filter((k) => `${k.side_a.team.code} vs ${k.side_b.team.code}`.toUpperCase() === fixtureArg.toUpperCase()) : determined;
    targets = chosen.map((k) => { const input = buildKnockoutPreMatchInput(url, k); return { label: input.fixture.label, input, max: 225, content_type: "pre_match_storyline" }; });
  }
  console.log(`Knockout narration | mode=${mode} | model: ${model} | ${execute ? "EXECUTE (store validated)" : "DRY-RUN (no write)"} | targets: ${targets.length}\n`);
  const results: any[] = [];
  for (const t of targets) {
    let raw = "", vr: any = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const um = (mode === "post" ? USER_MSG_KNOCKOUT_POST : USER_MSG_KNOCKOUT_PRE)(t.input, attempt >= 2 ? t.max - 30 : t.max);
      try { raw = await callGemini(apiKey, model, systemPrompt, um); }
      catch (e: any) { if (attempt < 3) { await sleep(2000 * attempt); continue; } raw = ""; break; }
      vr = validateAndRepairAiOutput(raw, t.input);
      if (vr.valid) break;
      if (attempt < 3) await sleep(800);
    }
    if (!raw || !vr || !vr.valid) { results.push({ fixture: t.label, status: raw ? "rejected_not_stored" : "generation_failed", rejections: vr?.rejections ?? ["no_validation"] }); await sleep(600); continue; }
    const out: any = vr.cleaned_output;
    const rec = { scope: "fixture", team: null as string | null, fixture: t.label, content_type: t.content_type, headline: String(out.headline), body: bodyOf(out) };
    if (execute) storeNarration(url, rec);
    results.push({ fixture: t.label, status: execute ? "stored(validated)" : "valid(dry-run)", repaired: vr.repaired, words: vr.metrics.body_word_count, headline: rec.headline, body: rec.body });
    await sleep(700);
  }
  console.log(JSON.stringify({ project_id: PROJECT, mode, executed: execute, summary: results.map((r) => ({ fixture: r.fixture, status: r.status, words: r.words, repaired: r.repaired })) }, null, 2));
  if (!execute) for (const r of results) if (r.body) console.log(`\n=== ${r.fixture} (${mode === "post" ? "post-match" : "pre-match"}) ===\nHEADLINE: ${r.headline}\n${r.body}`);
}

function ensureTable(url: string) {
  execSql(url, `create table if not exists public.ai_narrations (
    id uuid primary key default gen_random_uuid(),
    tournament_code text not null default 'WC_2026',
    scope text not null,
    team_code text null,
    fixture_label text null,
    group_code text null,
    content_type text not null,
    headline text not null,
    body text not null,
    source_label text not null,
    model_label text not null default 'AI narrator',
    validated boolean not null default false,
    validation_notes jsonb not null default '[]'::jsonb,
    prompt_version text not null,
    generated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    constraint ai_narr_scope_chk check (scope in ('team','fixture'))
  )`);
  // Self-healing unique index. CREATE UNIQUE INDEX IF NOT EXISTS matches by NAME only — it CANNOT repair an index
  // left in a drifted (legacy 4-expression) shape, which makes storeNarration's 5-expression ON CONFLICT fail with
  // 42P10 forever on that DB. Read the REAL definition (pg_indexes.indexdef) and rebuild ONLY if it's missing or the
  // wrong shape; no-op on the healthy path. A 4-expr -> 5-expr rebuild is safe (5-expr is more permissive, so rows
  // unique under the old index stay unique). Uses q()/execSql() -> the platform-safe spawn (npx on Linux CI).
  const idxDef = (q(url, `select indexdef from pg_indexes where schemaname='public' and tablename='ai_narrations' and indexname='ai_narrations_unique_target'`)[0]?.indexdef ?? "").toLowerCase();
  const idxShapeOk = idxDef.includes("coalesce(team_code") && idxDef.includes("coalesce(fixture_label") && idxDef.includes("coalesce(group_code");
  if (idxShapeOk) {
    console.log("[ensureTable] ai_narrations_unique_target present with correct 5-expression shape (no-op).");
  } else {
    console.log(idxDef
      ? "[ensureTable] ai_narrations_unique_target is the WRONG (drifted) shape -> dropping and rebuilding as 5-expression."
      : "[ensureTable] ai_narrations_unique_target missing -> creating 5-expression index.");
    execSql(url, `drop index if exists public.ai_narrations_unique_target`);
    execSql(url, `create unique index ai_narrations_unique_target on public.ai_narrations (tournament_code, content_type, coalesce(team_code,''), coalesce(fixture_label,''), coalesce(group_code,''))`);
  }
  execSql(url, `alter table public.ai_narrations enable row level security`);
  execSql(url, `comment on table public.ai_narrations is 'Validated AI narration consumed by the app-data export. Stored only after validate-and-repair passes (validated=true). No odds/predictions; AI explains, never invents.'`);
}

function storeNarration(url: string, r: { scope: string; team: string | null; fixture: string | null; content_type: string; headline: string; body: string }) {
  const j = (s: string) => `$x$${s}$x$`;
  execSql(url, `insert into public.ai_narrations (scope, team_code, fixture_label, content_type, headline, body, source_label, validated, validation_notes, prompt_version)
    values (${j(r.scope)}, ${r.team ? j(r.team) : "null"}, ${r.fixture ? j(r.fixture) : "null"}, ${j(r.content_type)}, ${j(r.headline)}, ${j(r.body)}, ${j("our World Cup simulation model")}, true, $x$[]$x$::jsonb, ${j(PROMPT_VERSION)})
    on conflict (tournament_code, content_type, coalesce(team_code,''), coalesce(fixture_label,''), coalesce(group_code,''))
    do update set headline=excluded.headline, body=excluded.body, validated=true, prompt_version=excluded.prompt_version, generated_at=now()`);
}

export function bodyOf(o: any): string { for (const k of ["body", "summary", "narrative", "analysis"]) if (typeof o?.[k] === "string") return o[k]; return ""; }

async function gateDemo() {
  // prove the gate REJECTS a fabricated/unsupported claim (a percentage not in the supplied input)
  const input = { content_type: "scenario_narration", output_requirements: { length_target_words: { max: 180 } }, probabilities: [{ metric: "advance", value: 0.73 }] };
  const fabricated = JSON.stringify({ content_type: "scenario_narration", headline: "Canada are nailed on", body: "Canada are 99% certain to reach the final and will definitely win the group; sources say the model guarantees it.", probability_references: [], source_trace: {}, context_caveats: [], unknowns: [], validation_notes: [] });
  const vr = validateAndRepairAiOutput(fabricated, input);
  console.log(JSON.stringify({ gate_demo: true, valid: vr.valid, rejections: vr.rejections, note: vr.valid ? "UNEXPECTED — should have rejected" : "REJECTED (fabricated 99% not in supplied probabilities -> NOT stored)" }, null, 2));
}

async function main() {
  console.log(`PROJECT ID: ${PROJECT} | AI narration pipeline (reuse: system-prompt ${PROMPT_VERSION} + validate-and-repair + Gemini)`);
  if (has("--gate-demo")) { await gateDemo(); return; }
  const url = await dbUrl();
  if (has("--ensure-table")) { ensureTable(url); console.log("ai_narrations ensured (idempotent)."); return; }

  // KNOCKOUT NARRATION modes (fixture-scoped): --post-result "X vs Y" (post_result_change) | --knockout-pre [--fixture "X vs Y"]
  // (pre_match_storyline; no --fixture => all determined ties). Default dry-run; --execute stores validated. Ships dark until
  // the loop firing hooks are wired (in-tournament-loop-runner) after these verify on real games.
  const postFixture = arg("--post-result");
  if (postFixture) { await runKnockoutNarration(url, "post", postFixture, has("--execute")); return; }
  if (has("--knockout-pre")) { await runKnockoutNarration(url, "pre", arg("--fixture"), has("--execute")); return; }

  const teams = (arg("--teams")?.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)) ?? DEFAULT_TEAMS;
  const execute = has("--execute");

  // ---- resolve LIVE runs + pull context (read-only) ----
  // Prefer the live-runs pointer file (the export's primary source of truth); fall back to DB lifecycle markers
  // so narration and export always resolve the SAME run.
  const live = readLivePointer() ?? q(url, `select
      (select id::text from tournament_simulation_runs where scope='all-groups-group-stage' and source_snapshot->>'lifecycle'='live_current' limit 1) gsim,
      (select id::text from tournament_simulation_runs where scope='full-tournament-knockout' and source_snapshot->>'lifecycle'='live_current' limit 1) ko`)[0];
  const scenRow = q(url, `select document->'teams' teams from tournament_advancement_scenarios where simulation_run_id='${live.gsim}' and phase in ('live','pre_tournament') order by as_of_result_count desc, created_at desc limit 1`)[0];
  const scen = scenRow?.teams ?? {};
  // STEP 2 — deterministic conditional engine output (crisp tiers + bubble thresholds + certainties). Graceful: if the
  // table is absent (not yet persisted), fall back to probabilistic-only — no crisp augmentation, no fabrication.
  let condByCode: Record<string, any> = {};
  try {
    const condRows = q(url, `select team_code, mode, own_group_unplayed, max_group_unplayed, own_fixture_label, certain_statements, concrete_chains, swing_matches, full_if_then_available from team_conditional_scenarios where tournament_code='WC_2026'`);
    for (const r of condRows as any[]) condByCode[r.team_code] = r;
  } catch { condByCode = {}; }
  // STEP 3 — REAL best-third resolver output (real_standings from the export). Graceful: absent -> null -> no augmentation.
  const real = loadRealStandings();
  const groupResultsSoFar = loadGroupResultsSoFar();
  const teamList = (teams.length === 1 && teams[0] === "ALL") ? Object.keys(scen as any).sort() : teams;
  const koRows = q(url, `select team_code, reach_round_of_16_probability::float8 r16, champion_probability::float8 ch from tournament_simulation_team_results where simulation_run_id='${live.ko}'`);
  const koByCode: Record<string, any> = {}; for (const r of koRows) koByCode[r.team_code] = r;
  const names = q(url, `select fifa_code, name from teams`);
  const nameByCode: Record<string, string> = {}; for (const n of names) nameByCode[n.fifa_code] = n.name;

  // ---- verification preview (no Gemini/write unless --call): show the scenario_data the AI would receive ----
  if (has("--preview")) {
    const code = (arg("--preview") ?? "CAN").toUpperCase();
    const s = (scen as any)[code] ?? { group_code: "?", probabilities: {}, what_they_need: [], third_place_dependency: {} };
    const cond = has("--mock-crisp") ? MOCK_CRISP(code) : condByCode[code];
    const realCtx = has("--mock-real") ? MOCK_REAL(code, s.group_code ?? "?") : realContextForTeam(real, code, s.group_code ?? "?", groupResultsSoFar);
    const groupCtx = buildGroupContext(scen, nameByCode, code, s.group_code ?? "?");
    const input = buildScenarioInput(code, nameByCode[code] ?? code, s.group_code ?? "?", s, koByCode[code], cond, realCtx, groupCtx, loadTeamStory(code));
    const sd: any = (input as any).scenario_data;
    console.log(JSON.stringify({
      preview: code,
      source: has("--mock-crisp") ? "MOCK crisp final-matchday demo" : "real team_conditional_scenarios row",
      real_source: has("--mock-real") ? "MOCK resolved best-third demo" : (real ? `real_standings (status=${real.status})` : "real_standings absent"),
      deterministic_mode: sd.deterministic_mode, certain_statements: sd.certain_statements, paths: sd.paths,
      probabilities: (input as any).probabilities,
      group_context: sd.group_context,
      real_table_status: sd.real_table_status, best_third_standing: sd.best_third_standing,
      standings: (input as any).standings,
    }, null, 2));
    if (has("--call")) {
      try {
        const apiKey = await loadApiKey(); const systemPrompt = readFileSync(SYSTEM_PROMPT_PATH, "utf8"); const model = await chooseGeminiModel(apiKey);
        const raw = await callGemini(apiKey, model, systemPrompt, USER_MSG(input, 200));
        const vr = validateAndRepairAiOutput(raw, input); const out: any = vr.cleaned_output;
        console.log(JSON.stringify({ ai_call: true, model, validator_valid: vr.valid, rejections: vr.rejections, headline: out?.headline, body: bodyOf(out) }, null, 2));
      } catch (e: any) { console.log(JSON.stringify({ ai_call: false, note: "Gemini call skipped/failed (API key or network)", error: String(e?.message ?? e) }, null, 2)); }
    }
    return;
  }

  const apiKey = await loadApiKey();
  const systemPrompt = readFileSync(SYSTEM_PROMPT_PATH, "utf8");
  const model = await chooseGeminiModel(apiKey);
  console.log(`Gemini model: ${model} | mode: ${execute ? "EXECUTE (store validated)" : "DRY-RUN (generate+validate, no write)"} | teams: ${teamList.length}\n`);
  if (execute) ensureTable(url);

  const results: any[] = [];
  let i = 0;
  for (const code of teamList) {
    i++;
    const s = (scen as any)[code]; if (!s) { results.push({ team: code, status: "no_scenario_data" }); continue; }
    const groupCtx = buildGroupContext(scen, nameByCode, code, s.group_code);
    const input = buildScenarioInput(code, nameByCode[code] ?? code, s.group_code, s, koByCode[code], condByCode[code], realContextForTeam(real, code, s.group_code, groupResultsSoFar), groupCtx, loadTeamStory(code));
    let raw = "", vr: any = null, attempts = 0, genErr = "";
    for (attempts = 1; attempts <= 3; attempts++) {
      try { raw = await callGemini(apiKey, model, systemPrompt, USER_MSG(input, attempts >= 2 ? 175 : 195)); }
      catch (e: any) { genErr = String(e?.message).slice(0, 160); raw = ""; if (attempts < 3) { await sleep(2000 * attempts); continue; } break; } // backoff on generation error (e.g. rate limit)
      vr = validateAndRepairAiOutput(raw, input);
      if (vr.valid) break;
      if (attempts < 3) await sleep(800); // brief backoff before regenerate on validation failure
    }
    if (!raw) { results.push({ team: code, status: "generation_failed", error: genErr }); await sleep(700); continue; }
    if (!vr || !vr.valid) { results.push({ team: code, status: "rejected_not_stored", rejections: vr?.rejections ?? ["no_validation"], attempts }); await sleep(700); continue; }
    const out: any = vr.cleaned_output;
    const rec = { scope: "team", team: code, fixture: null, content_type: "scenario_narration", headline: String(out.headline), body: bodyOf(out) };
    if (execute) storeNarration(url, rec);
    results.push({ team: code, status: execute ? "stored(validated)" : "valid(dry-run)", repaired: vr.repaired, body_words: vr.metrics.body_word_count, headline: rec.headline, body: rec.body });
    if (i % 10 === 0) console.error(`  ...${i}/${teamList.length} processed`);
    await sleep(700); // throttle across all calls to stay under rate limits
  }

  const cacheHitPct = geminiTokenStats.promptTokens ? Math.round((geminiTokenStats.cachedTokens / geminiTokenStats.promptTokens) * 100) : 0;
  console.error(`\nGEMINI TOKEN USAGE (this run): ${geminiTokenStats.calls} call(s) | input ${geminiTokenStats.promptTokens} tok (cached ${geminiTokenStats.cachedTokens} = ${cacheHitPct}% implicit-cache hit) | output ${geminiTokenStats.outputTokens} tok`);
  console.log(JSON.stringify({ project_id: PROJECT, executed: execute, model, gemini_token_usage: { ...geminiTokenStats, implicit_cache_hit_pct: cacheHitPct }, summary: results.map((r) => ({ team: r.team, status: r.status, words: r.body_words, repaired: r.repaired })), guardrails: { ai_explains_never_invents: true, validate_and_repair_gated: true, only_validated_stored: true, no_internal_ids_in_prose: true, no_odds_or_predictions: true } }, null, 2));
  const can = results.find((r) => r.team === "CAN");
  if (can) console.log("\n=== CANADA scenario narration (traceable to the live runs) ===\n" + JSON.stringify(can, null, 2));
  // Dry-runs exist to VERIFY prose (no DB write) — print it, so partial-group/coherence checks can read the output.
  if (!execute) for (const r of results) console.log(`\n=== ${r.team} dry-run prose ===\nHEADLINE: ${r.headline}\n${r.body}`);
}
// Run main() only when invoked directly (not when imported by the test harness), so importing has no side effects.
const invokedDirectly = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) main().catch((e) => { console.error("ERROR:", e?.message ?? e); process.exit(1); });
