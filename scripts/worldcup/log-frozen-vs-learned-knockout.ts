import { readFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

// POST-HOC EVAL LOG (not a gate): when the loop promotes the LEARNED end-of-group Elo knockout candidate, record BOTH
// the frozen and the learned knockout/champion odds, keyed by run id, so prediction_evaluations can later score
// (Brier/accuracy) whether learned actually beat frozen once knockout games are played. Read-only on the DB; writes one
// JSON artifact. No model changes, no odds. Project: ahcfrgxczbgdvrqmbisw.
//   node scripts/worldcup/log-frozen-vs-learned-knockout.ts --learned-run <id> --frozen-run <id> [--as-of N] [--execute]

const rootDir = process.cwd();
const PROJECT = "ahcfrgxczbgdvrqmbisw";
const credentialsPath = path.join(rootDir, "supebase.txt");
const tempDir = path.join(rootDir, ".tmp", "worldcup-sql");
const OUT = "data/exports/frozen-vs-learned-knockout-eval.json";
let tmp = 0;

const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] ?? null : null; };
const has = (f: string) => process.argv.includes(f);
const num = (v: any) => (v == null ? 0 : typeof v === "object" && "Int" in v ? Number(v.Int) * Math.pow(10, Number(v.Exp ?? 0)) : Number(v));

async function dbUrl() {
  const text = await readFile(credentialsPath, "utf8");
  const ref = text.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];
  const pw = text.match(/supebase password\s*:\s*(\S+)/i)?.[1];
  if (ref !== PROJECT) throw new Error(`Unexpected project ref: ${ref}`);
  if (!pw) throw new Error("no password");
  return `postgresql://postgres.${ref}:${encodeURIComponent(pw)}@aws-1-us-west-1.pooler.supabase.com:5432/postgres`;
}
function q<X = any>(url: string, sql: string): X[] {
  if (/\b(insert|update|delete|drop|alter|truncate|create)\b/i.test(sql.replace(/'[^']*'/g, ""))) throw new Error("read-only helper");
  mkdirSync(tempDir, { recursive: true }); tmp++;
  const fp = path.join(tempDir, `fvl-${tmp}.sql`); writeFileSync(fp, sql, "utf8");
  const r = spawnSync("cmd.exe", ["/c", "npx.cmd", "supabase", "db", "query", "--db-url", url, "--output", "json", "--file", fp], { encoding: "utf8", maxBuffer: 2e8 });
  if ((r.status ?? 1) !== 0) throw new Error((r.stderr || r.stdout || "").slice(0, 400));
  const o = r.stdout.trim(); if (!o) return []; const p = JSON.parse(o); return (Array.isArray(p) ? p : p.rows ?? p) as X[];
}
const safeId = (s: string | null) => (s && /^[0-9a-f-]{8,}$/i.test(s) ? s : null);

async function main() {
  const learnedRun = safeId(arg("--learned-run"));
  const frozenRun = safeId(arg("--frozen-run"));
  const asOf = arg("--as-of");
  if (!learnedRun || !frozenRun) throw new Error("require --learned-run <uuid> --frozen-run <uuid>");
  const url = await dbUrl();
  const rows = (id: string) => q(url, `select team_code, champion_probability::float8 ch, reach_final_probability::float8 fin, reach_semifinal_probability::float8 sf
    from tournament_simulation_team_results where simulation_run_id='${id}'`);
  const frozen: Record<string, any> = {}; for (const r of rows(frozenRun)) frozen[r.team_code] = r;
  const learned: Record<string, any> = {}; for (const r of rows(learnedRun)) learned[r.team_code] = r;
  const codes = [...new Set([...Object.keys(frozen), ...Object.keys(learned)])].sort();
  const teams = codes.map((c) => ({
    code: c,
    frozen_champion: num(frozen[c]?.ch), learned_champion: num(learned[c]?.ch),
    delta_champion: Number((num(learned[c]?.ch) - num(frozen[c]?.ch)).toFixed(4)),
    frozen_reach_final: num(frozen[c]?.fin), learned_reach_final: num(learned[c]?.fin),
    frozen_reach_sf: num(frozen[c]?.sf), learned_reach_sf: num(learned[c]?.sf),
  })).sort((a, b) => Math.abs(b.delta_champion) - Math.abs(a.delta_champion));
  const doc = {
    project_id: PROJECT,
    task: "frozen_vs_learned_knockout_posthoc_eval_log",
    note: "Post-hoc evaluation evidence (NOT a pre-promotion gate). After knockout games are played, feed both runs into prediction_evaluations (Brier/accuracy) to measure whether the learned end-of-group Elo candidate beat the frozen baseline. Promotion itself is gated only on the integrity sanity check.",
    learned_run_id: learnedRun, frozen_run_id: frozenRun,
    as_of_result_count: asOf != null ? Number(asOf) : null,
    biggest_movers: teams.slice(0, 8).map((t) => `${t.code}: champ ${(t.frozen_champion * 100).toFixed(1)}% -> ${(t.learned_champion * 100).toFixed(1)}% (${t.delta_champion >= 0 ? "+" : ""}${(t.delta_champion * 100).toFixed(1)}pp)`),
    teams,
  };
  if (has("--execute")) {
    mkdirSync(path.join(rootDir, "data/exports"), { recursive: true });
    writeFileSync(path.join(rootDir, OUT), JSON.stringify(doc, null, 2) + "\n", "utf8");
  }
  console.log(JSON.stringify({ wrote: has("--execute") ? OUT : "(dry-run; pass --execute to write)", learned_run_id: learnedRun, frozen_run_id: frozenRun, team_count: teams.length, biggest_movers: doc.biggest_movers }, null, 2));
}
main().catch((e) => { console.error("ERROR:", e?.message ?? e); process.exit(1); });
