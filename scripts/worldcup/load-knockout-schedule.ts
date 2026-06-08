import { readFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { roundOf32Slots } from "./worldcup-regulations-engine";

// LOAD the fixed/published WC2026 KNOCKOUT SCHEDULE (matches 73-104) into a clean, queryable, reusable source.
// Grounding: docs/wc2026-tournament-rules.md (the authoritative project rules doc) Sections 4 (R32) + 6 (R16->Final)
// provide match number, the two FIFA slot labels, and the venue. City + IANA timezone are derived from the grounded
// venue (geographic facts, same approach as the export's VENUE_GEO). Slot pairings are parsed into a structured form
// so the bracket/path-resolver can traverse the tree. R32 (M73-M88) slots are cross-checked against the verified
// roundOf32Slots table. DATES/KICKOFFS are NOT present in any grounded source (the rules doc lists venues, not dates;
// the API-Football cache holds only the 72 group fixtures) -> loaded as NULL and flagged date_confirmed=false. NOT fabricated.
// Target: dedicated public.knockout_schedule (queryable by match_number AND by slot), with kickoff_utc + venue_timezone
// in the SAME shape as group fixtures for dual-clock compatibility. CLI/execSql writes, DRY-RUN first (--execute to write).
// No model/prediction changes. No odds/predictions.

const rootDir = process.cwd();
const credentialsPath = path.join(rootDir, "supebase.txt");
const tempDir = path.join(rootDir, ".tmp", "worldcup-sql");
const worldCupDevProjectRef = "ahcfrgxczbgdvrqmbisw";
const RULES_DOC = "docs/wc2026-tournament-rules.md";
const execute = process.argv.includes("--execute");
let tmp = 0;

// City + IANA timezone for each venue named in the rules doc (geographic facts derived from the grounded venue/city).
const VENUE_GEO: Record<string, { city: string; country: string; tz: string }> = {
  "Los Angeles Stadium": { city: "Los Angeles", country: "United States", tz: "America/Los_Angeles" },
  "Boston Stadium": { city: "Boston", country: "United States", tz: "America/New_York" },
  "Estadio Monterrey": { city: "Monterrey", country: "Mexico", tz: "America/Monterrey" },
  "Houston Stadium": { city: "Houston", country: "United States", tz: "America/Chicago" },
  "New York New Jersey Stadium": { city: "New York/New Jersey", country: "United States", tz: "America/New_York" },
  "Dallas Stadium": { city: "Dallas", country: "United States", tz: "America/Chicago" },
  "Mexico City Stadium": { city: "Mexico City", country: "Mexico", tz: "America/Mexico_City" },
  "Atlanta Stadium": { city: "Atlanta", country: "United States", tz: "America/New_York" },
  "San Francisco Bay Area Stadium": { city: "San Francisco Bay Area", country: "United States", tz: "America/Los_Angeles" },
  "Seattle Stadium": { city: "Seattle", country: "United States", tz: "America/Los_Angeles" },
  "Toronto Stadium": { city: "Toronto", country: "Canada", tz: "America/Toronto" },
  "BC Place Vancouver": { city: "Vancouver", country: "Canada", tz: "America/Vancouver" },
  "Miami Stadium": { city: "Miami", country: "United States", tz: "America/New_York" },
  "Kansas City Stadium": { city: "Kansas City", country: "United States", tz: "America/Chicago" },
  "Philadelphia Stadium": { city: "Philadelphia", country: "United States", tz: "America/New_York" },
};

async function readDbConfig() {
  // CI-first: use the env DB URL (SUPABASE_DB_URL) so this works on GitHub Actions where supebase.txt is absent.
  // Fall back to the local supebase.txt file when env is unset (local runs unchanged).
  const envDbUrl = process.env.SUPABASE_DB_URL;
  if (envDbUrl) {
    const projectRef = envDbUrl.match(/postgres\.([a-z0-9]+):/)?.[1] ?? envDbUrl.match(/\/\/([^.]+)\.supabase\.co/)?.[1] ?? "";
    if (projectRef !== worldCupDevProjectRef) throw new Error(`Unexpected project ref from SUPABASE_DB_URL: ${projectRef || "unknown"}`);
    return { projectRef, dbUrl: envDbUrl };
  }
  const text = await readFile(credentialsPath, "utf8");
  const projectRef = text.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];
  const password = text.match(/supebase password\s*:\s*(\S+)/i)?.[1];
  if (projectRef !== worldCupDevProjectRef) throw new Error(`Unexpected project ref: ${projectRef ?? "unknown"}`);
  if (!password) throw new Error("Missing password");
  return { projectRef, dbUrl: `postgresql://postgres.${projectRef}:${encodeURIComponent(password)}@aws-1-us-west-1.pooler.supabase.com:5432/postgres` };
}
function runSql<X = any>(dbUrl: string, sql: string): X[] {
  if (/\b(insert|update|delete|drop|alter|truncate|create)\b/i.test(sql.replace(/'[^']*'/g, ""))) throw new Error("read-only helper");
  mkdirSync(tempDir, { recursive: true }); tmp += 1; const fp = path.join(tempDir, `ks-${tmp}.sql`); writeFileSync(fp, sql, "utf8");
  const r = spawnSync("cmd.exe", ["/c", "npx.cmd", "supabase", "db", "query", "--db-url", dbUrl, "--output", "json", "--file", fp], { encoding: "utf8", maxBuffer: 2e8 });
  if ((r.status ?? 1) !== 0) throw new Error((r.stderr || r.stdout || "").slice(0, 400));
  const out = r.stdout.trim(); if (!out) return []; const p = JSON.parse(out); return (Array.isArray(p) ? p : p.rows ?? p) as X[];
}
function execSql(dbUrl: string, sql: string): string { // SINGLE statement only (CLI rejects multi-statement files)
  mkdirSync(tempDir, { recursive: true }); tmp += 1; const fp = path.join(tempDir, `ks-ddl-${tmp}.sql`); writeFileSync(fp, sql, "utf8");
  const r = spawnSync("cmd.exe", ["/c", "npx.cmd", "supabase", "db", "query", "--db-url", dbUrl, "--file", fp], { encoding: "utf8", maxBuffer: 2e8 });
  if ((r.status ?? 1) !== 0) throw new Error(`execSql failed: ${(r.stderr || r.stdout || "").slice(0, 400)}`);
  return `${r.stdout ?? ""}`.trim();
}

type Slot =
  | { type: "group_winner"; group: string; label: string }
  | { type: "group_runner_up"; group: string; label: string }
  | { type: "best_third"; pool: string[]; label: string }
  | { type: "match_winner"; match: number; label: string }
  | { type: "match_loser"; match: number; label: string }
  | { type: "unparsed"; label: string };

function parseSlot(raw: string): Slot {
  const label = raw.trim(); let m: RegExpMatchArray | null;
  if ((m = label.match(/^Winner Group ([A-L])$/))) return { type: "group_winner", group: m[1], label };
  if ((m = label.match(/^Runner-up Group ([A-L])$/))) return { type: "group_runner_up", group: m[1], label };
  if ((m = label.match(/^Best 3rd from ([A-L](?:\/[A-L])*)$/))) return { type: "best_third", pool: m[1].split("/"), label };
  if ((m = label.match(/^Winner M(\d+)$/))) return { type: "match_winner", match: Number(m[1]), label };
  if ((m = label.match(/^Runner-up M(\d+)$/))) return { type: "match_loser", match: Number(m[1]), label };
  return { type: "unparsed", label };
}
function roundOf(n: number): string {
  if (n >= 73 && n <= 88) return "round_of_32";
  if (n >= 89 && n <= 96) return "round_of_16";
  if (n >= 97 && n <= 100) return "quarter_final";
  if (n === 101 || n === 102) return "semi_final";
  if (n === 103) return "third_place";
  if (n === 104) return "final";
  return "unknown";
}
function sectionOf(n: number): string { return n <= 88 ? "§4 Round Of 32 Routing" : "§6 R16 Onward And Knockout Rules"; }
const slotToFinishCode = (s: Slot) => s.type === "group_winner" ? `1${s.group}` : s.type === "group_runner_up" ? `2${s.group}` : null;
const sq = (v: string | null) => v === null ? "null" : `'${v.replace(/'/g, "''")}'`;
const jb = (o: unknown) => `$j$${JSON.stringify(o)}$j$::jsonb`; // dollar-quoted jsonb literal

type Row = {
  match_number: number; round: string; slot_a_label: string; slot_b_label: string; slot_a: Slot; slot_b: Slot;
  venue: string | null; city: string | null; country: string | null; venue_timezone: string | null;
  round_window: string | null; match_date: string | null; kickoff_utc: string | null; date_confirmed: boolean; venue_confirmed: boolean; source: string; source_snapshot: any;
};

async function main() {
  const config = await readDbConfig();
  console.log(`PROJECT ID: ${config.projectRef} | load-knockout-schedule | ${execute ? "EXECUTE" : "DRY-RUN"} | source: ${RULES_DOC} | no model/odds`);

  // ---- parse the rules doc: every "| M<n> | <slot A> | <slot B> | <venue> |" row (Sections 4 + 6) ----
  const doc = await readFile(path.join(rootDir, RULES_DOC), "utf8");
  const rowRe = /^\|\s*M(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/gm;
  // dates from the doc's "Knockout Schedule Dates" subsection (single source): round windows + confirmed exact days
  const winRe = /^\|\s*(round_of_32|round_of_16|quarter_final|semi_final|third_place|final)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|/gm;
  const roundWindow: Record<string, string> = {}; let w: RegExpExecArray | null;
  while ((w = winRe.exec(doc))) roundWindow[w[1]] = w[2] === w[3] ? w[2] : `${w[2]} to ${w[3]}`;
  const exRe = /^\|\s*M(\d+)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([0-9TZ:-]*)\s*\|\s*([^|]+?)\s*\|\s*(\w+)\s*\|/gm;
  const exactDate: Record<number, { date: string; kickoff: string | null; venue: string }> = {}; let ex: RegExpExecArray | null;
  while ((ex = exRe.exec(doc))) exactDate[Number(ex[1])] = { date: ex[2], kickoff: ex[3].trim() || null, venue: ex[4].trim() };
  const rows: Row[] = []; const warnings: string[] = []; let m: RegExpExecArray | null;
  while ((m = rowRe.exec(doc))) {
    const n = Number(m[1]); if (n < 73 || n > 104) continue; // only knockout matches
    const slot_a = parseSlot(m[2]); const slot_b = parseSlot(m[3]); const venue = m[4].trim();
    const geo = VENUE_GEO[venue] ?? null;
    if (!geo) warnings.push(`M${n}: venue "${venue}" has no city/timezone mapping`);
    if (slot_a.type === "unparsed") warnings.push(`M${n}: unparsed slot A "${slot_a.label}"`);
    if (slot_b.type === "unparsed") warnings.push(`M${n}: unparsed slot B "${slot_b.label}"`);
    const dexact = exactDate[n]; const rwin = roundWindow[roundOf(n)] ?? null;
    if (dexact && dexact.venue !== venue) warnings.push(`M${n}: exact-date venue "${dexact.venue}" != schedule venue "${venue}"`);
    rows.push({
      match_number: n, round: roundOf(n), slot_a_label: slot_a.label, slot_b_label: slot_b.label, slot_a, slot_b,
      venue, city: geo?.city ?? null, country: geo?.country ?? null, venue_timezone: geo?.tz ?? null,
      round_window: rwin,
      match_date: dexact ? dexact.date : null,     // exact day only where pinned by venue+day; else null (round_window holds the range)
      kickoff_utc: dexact ? dexact.kickoff : null, // only where a confirmed kickoff exists; else null (date-only dual-clock)
      date_confirmed: Boolean(dexact),
      venue_confirmed: Boolean(venue) && Boolean(geo),
      source: `${RULES_DOC} ${sectionOf(n)}${dexact ? " + Knockout Schedule Dates" : ""}`,
      source_snapshot: { venue_grounded: Boolean(geo), date_grounded: Boolean(dexact), date_granularity: dexact ? "exact_day" : "round_window_only", round_window: rwin, date_note: dexact ? "exact day pinned by venue in the official schedule (cross-checked 2026-06-05)" : "round window only; specific day not pinned in a grounded source (not guessed)", section: sectionOf(n) },
    });
  }
  rows.sort((a, b) => a.match_number - b.match_number);

  // ---- structural checks ----
  const nums = rows.map((r) => r.match_number);
  const expectedNums = Array.from({ length: 104 - 73 + 1 }, (_, i) => 73 + i);
  const missing = expectedNums.filter((n) => !nums.includes(n));
  const dupes = nums.filter((n, i) => nums.indexOf(n) !== i);
  if (missing.length) warnings.push(`MISSING matches: ${missing.join(", ")}`);
  if (dupes.length) warnings.push(`DUPLICATE matches: ${[...new Set(dupes)].join(", ")}`);

  // ---- cross-check R32 (M73-M88) slot pairings against the verified roundOf32Slots table ----
  const crossCheck: { match: number; ok: boolean; detail?: string }[] = [];
  for (const r of rows.filter((x) => x.match_number <= 88)) {
    const ref = roundOf32Slots.find((s) => s.match_number === r.match_number);
    if (!ref) { crossCheck.push({ match: r.match_number, ok: false, detail: "no roundOf32Slots entry" }); continue; }
    const aOk = slotToFinishCode(r.slot_a) === ref.side_a_slot;
    let bOk: boolean; let bDetail = "";
    if (r.slot_b.type === "best_third") {
      const refPool = (ref.side_b_third_place_pool ?? []).slice().sort().join("");
      const docPool = r.slot_b.pool.slice().sort().join("");
      bOk = refPool === docPool; bDetail = bOk ? "" : `pool doc[${docPool}] vs ref[${refPool}]`;
    } else { bOk = slotToFinishCode(r.slot_b) === ref.side_b_slot; bDetail = bOk ? "" : `B doc[${slotToFinishCode(r.slot_b)}] vs ref[${ref.side_b_slot}]`; }
    const ok = aOk && bOk;
    crossCheck.push({ match: r.match_number, ok, detail: ok ? undefined : `${aOk ? "" : `A doc[${slotToFinishCode(r.slot_a)}] vs ref[${ref.side_a_slot}] `}${bDetail}`.trim() });
    if (!ok) warnings.push(`M${r.match_number}: R32 cross-check mismatch — ${crossCheck[crossCheck.length - 1].detail}`);
  }
  const crossOk = crossCheck.every((c) => c.ok);

  // ---- DDL (single statement) + upsert (single statement) ----
  const ddl = `create table if not exists public.knockout_schedule (
  match_number integer primary key,
  tournament_code text not null default 'WC_2026',
  round text not null,
  slot_a_label text not null,
  slot_b_label text not null,
  slot_a jsonb not null,
  slot_b jsonb not null,
  venue text,
  city text,
  country text,
  venue_timezone text,
  round_window text,
  match_date date,
  kickoff_utc timestamptz,
  date_confirmed boolean not null default false,
  venue_confirmed boolean not null default false,
  source text not null,
  source_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)`;
  const valueRows = rows.map((r) => `(${r.match_number},'WC_2026',${sq(r.round)},${sq(r.slot_a_label)},${sq(r.slot_b_label)},${jb(r.slot_a)},${jb(r.slot_b)},${sq(r.venue)},${sq(r.city)},${sq(r.country)},${sq(r.venue_timezone)},${sq(r.round_window)},${r.match_date === null ? "null" : sq(r.match_date)},${r.kickoff_utc === null ? "null" : sq(r.kickoff_utc)},${r.date_confirmed},${r.venue_confirmed},${sq(r.source)},${jb(r.source_snapshot)})`).join(",\n  ");
  const upsert = `insert into public.knockout_schedule
  (match_number, tournament_code, round, slot_a_label, slot_b_label, slot_a, slot_b, venue, city, country, venue_timezone, round_window, match_date, kickoff_utc, date_confirmed, venue_confirmed, source, source_snapshot)
values
  ${valueRows}
on conflict (match_number) do update set
  round=excluded.round, slot_a_label=excluded.slot_a_label, slot_b_label=excluded.slot_b_label,
  slot_a=excluded.slot_a, slot_b=excluded.slot_b, venue=excluded.venue, city=excluded.city, country=excluded.country,
  venue_timezone=excluded.venue_timezone, round_window=excluded.round_window, match_date=excluded.match_date, kickoff_utc=excluded.kickoff_utc,
  date_confirmed=excluded.date_confirmed, venue_confirmed=excluded.venue_confirmed, source=excluded.source,
  source_snapshot=excluded.source_snapshot, updated_at=now()`;

  // ---- audit artifact (always; read-only) ----
  const audit = {
    project_id: config.projectRef, generator: "scripts/worldcup/load-knockout-schedule.ts", source: RULES_DOC,
    parsed_matches: rows.length, expected: 32, missing, duplicates: [...new Set(dupes)],
    r32_crosscheck_all_pass: crossOk, r32_crosscheck: crossCheck, round_windows: roundWindow,
    venues_confirmed: rows.filter((r) => r.venue_confirmed).length,
    exact_dates_confirmed: rows.filter((r) => r.date_confirmed).length, exact_date_matches: rows.filter((r) => r.date_confirmed).map((r) => r.match_number),
    round_window_only: rows.filter((r) => !r.date_confirmed).length, round_window_only_matches: rows.filter((r) => !r.date_confirmed).map((r) => r.match_number),
    warnings, rows,
  };
  mkdirSync(path.join(rootDir, "data/audits"), { recursive: true });
  writeFileSync(path.join(rootDir, "data/audits/knockout-schedule-load.json"), JSON.stringify(audit, null, 2), "utf8");

  // ---- readable summary ----
  console.log(`\nparsed ${rows.length}/32 knockout matches (M73-M104) | missing: ${missing.length ? missing.join(",") : "none"} | dupes: ${dupes.length ? [...new Set(dupes)].join(",") : "none"}`);
  console.log(`R32 slot cross-check vs roundOf32Slots: ${crossOk ? "ALL 16 MATCH" : "MISMATCH (see warnings)"}`);
  console.log(`venues grounded+mapped: ${audit.venues_confirmed}/32 | EXACT dates: ${audit.exact_dates_confirmed}/32 (date_confirmed=true) | round-window-only: ${audit.round_window_only}/32 (date_confirmed=false, exact day not guessed)`);
  if (warnings.length) console.log(`warnings:\n  - ${warnings.join("\n  - ")}`);
  console.log(`\nsample rows:`);
  for (const r of rows.filter((x) => [73, 85, 96, 100, 103, 104].includes(x.match_number))) {
    console.log(`  M${r.match_number} ${r.round.padEnd(13)} | ${r.slot_a_label}  vs  ${r.slot_b_label} | ${r.venue ?? "?"} (${r.city ?? "?"}) | ${r.match_date ? "DATE " + r.match_date + (r.kickoff_utc ? " " + r.kickoff_utc : "") : "window " + (r.round_window ?? "?")}`);
  }

  if (!execute) {
    console.log(`\nDRY-RUN — no writes. DDL + 32-row upsert prepared (see below). Re-run with --execute to apply.`);
    console.log(`\n--- DDL ---\n${ddl}\n`);
    console.log(`--- UPSERT (first 220 chars) ---\n${upsert.slice(0, 220)}...\n`);
    console.log(`audit written: data/audits/knockout-schedule-load.json`);
    return;
  }

  if (missing.length || dupes.length || !crossOk) throw new Error(`refusing to execute: structural/cross-check problems — ${warnings.join("; ")}`);
  console.log(`\nEXECUTE — creating table (idempotent) + upserting 32 rows ...`);
  execSql(config.dbUrl, ddl);
  execSql(config.dbUrl, `alter table public.knockout_schedule add column if not exists round_window text`);
  execSql(config.dbUrl, upsert);
  const after = runSql(config.dbUrl, `select count(*) c, count(*) filter (where venue_confirmed) vok, count(*) filter (where date_confirmed) dok from public.knockout_schedule`)[0];
  console.log(`done — knockout_schedule rows: ${(after as any).c} (venue_confirmed: ${(after as any).vok}, date_confirmed: ${(after as any).dok})`);
  console.log(`audit written: data/audits/knockout-schedule-load.json`);
}
main().catch((e) => { console.error("ERROR:", e?.message ?? e); process.exit(1); });
