import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const PROJECT = "ahcfrgxczbgdvrqmbisw";
const ROOT = process.cwd();
const APP_DATA = path.join(ROOT, "data", "exports", "app-data.json");
const API_TEAMS_CACHE = path.join(ROOT, "data", "external", "api-football", "cache", "teams_wc2026_league.json");
const FLAG_DIR = path.join(ROOT, "ui", "flags");
const MANIFEST = path.join(ROOT, "data", "exports", "team-flags.json");

const args = new Set(process.argv.slice(2));
const execute = args.has("--execute");
const force = args.has("--force");

function normName(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function extFor(url, contentType) {
  const fromUrl = String(new URL(url).pathname).match(/\.(png|svg|jpg|jpeg|webp)$/i)?.[1]?.toLowerCase();
  if (fromUrl) return fromUrl === "jpeg" ? "jpg" : fromUrl;
  if (/svg/i.test(contentType)) return "svg";
  if (/webp/i.test(contentType)) return "webp";
  if (/jpe?g/i.test(contentType)) return "jpg";
  return "png";
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function downloadFlag(item) {
  const response = await fetch(item.source_logo_url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^image\//i.test(contentType)) throw new Error(`unexpected content-type ${contentType || "unknown"}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const ext = extFor(item.source_logo_url, contentType);
  const asset = `flags/${item.code}.${ext}`;
  const target = path.join(FLAG_DIR, `${item.code}.${ext}`);
  await writeFile(target, bytes);
  return { asset, bytes: bytes.length, content_type: contentType };
}

async function main() {
  console.log(`PROJECT ID: ${PROJECT} | fetch-team-flags ${execute ? "EXECUTE" : "DRY-RUN"}`);
  const app = await readJson(APP_DATA);
  const teams = app.teams ?? [];
  const api = await readJson(API_TEAMS_CACHE);
  const apiTeams = (api.response ?? []).map((row) => row.team).filter(Boolean);

  const byName = new Map();
  const byCode = new Map();
  for (const team of apiTeams) {
    byName.set(normName(team.name), team);
    if (team.code) {
      const list = byCode.get(team.code) ?? [];
      list.push(team);
      byCode.set(team.code, list);
    }
  }

  const items = teams.map((team) => {
    const byExactName = byName.get(normName(team.name));
    const byExactCode = (byCode.get(team.code) ?? []).find((candidate) => normName(candidate.name) === normName(team.name))
      ?? (byCode.get(team.code) ?? [])[0];
    const apiTeam = byExactName ?? byExactCode ?? null;
    return {
      code: team.code,
      name: team.name,
      group: team.group,
      api_team_id: apiTeam?.id ?? null,
      api_team_name: apiTeam?.name ?? null,
      api_team_code: apiTeam?.code ?? null,
      source_logo_url: apiTeam?.logo ?? null,
      asset: null,
      status: apiTeam?.logo ? "matched" : "missing_source",
    };
  });

  const missing = items.filter((item) => !item.source_logo_url);
  if (!execute) {
    console.log(JSON.stringify({
      project_id: PROJECT,
      mode: "dry_run",
      source: "data/external/api-football/cache/teams_wc2026_league.json",
      matched: items.length - missing.length,
      missing: missing.map((item) => ({ code: item.code, name: item.name })),
      would_write_assets_to: "ui/flags/{CODE}.png",
      would_write_manifest: "data/exports/team-flags.json",
      sample: items.slice(0, 8),
    }, null, 2));
    return;
  }

  await mkdir(FLAG_DIR, { recursive: true });
  await mkdir(path.dirname(MANIFEST), { recursive: true });

  const results = [];
  for (const item of items) {
    if (!item.source_logo_url) {
      results.push({ ...item, status: "missing_source" });
      continue;
    }

    const expectedPng = path.join(FLAG_DIR, `${item.code}.png`);
    if (!force && existsSync(expectedPng)) {
      results.push({ ...item, asset: `flags/${item.code}.png`, status: "exists" });
      continue;
    }

    try {
      const saved = await downloadFlag(item);
      results.push({ ...item, ...saved, status: "fetched" });
    } catch (error) {
      results.push({ ...item, status: "fetch_failed", error: error?.message ?? String(error) });
    }
  }

  const manifest = {
    project_id: PROJECT,
    generated_at: new Date().toISOString(),
    source: {
      provider: "API-Football",
      endpoint_cache: "data/external/api-football/cache/teams_wc2026_league.json",
      display_runtime: "self-hosted only; app-data contains relative ui/ asset paths, never API-Football URLs",
    },
    flags: results,
  };
  await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  const ok = results.filter((item) => item.asset).length;
  const failed = results.filter((item) => !item.asset);
  console.log(JSON.stringify({
    project_id: PROJECT,
    mode: "execute",
    flags_with_assets: ok,
    failed: failed.map((item) => ({ code: item.code, name: item.name, status: item.status, error: item.error ?? null })),
    wrote_manifest: "data/exports/team-flags.json",
    wrote_assets_dir: "ui/flags",
  }, null, 2));
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error("ERROR:", error?.message ?? error);
  process.exit(1);
});
