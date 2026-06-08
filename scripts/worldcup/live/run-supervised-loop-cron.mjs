#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ID = "ahcfrgxczbgdvrqmbisw";
const ACTIVATION_UTC = "2026-06-11T19:00:00.000Z";
const LOCK_MAX_AGE_MS = 9 * 60 * 1000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const logDir = path.join(repoRoot, "data", "logs");
const lockPath = path.join(logDir, ".in-tournament-loop-supervised.lock");

function readArgValue(name) {
  const prefix = `${name}=`;
  const direct = process.argv.find((arg) => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const dryRun = process.argv.includes("--dry-run");
const nowArg = readArgValue("--now");
const mode = readArgValue("--mode") ?? "supervised";
if (!["supervised", "unattended"].includes(mode)) {
  throw new Error(`Invalid --mode ${mode}; expected supervised or unattended.`);
}

const now = nowArg ? new Date(nowArg) : new Date();
const activation = new Date(ACTIVATION_UTC);
const runner = process.platform === "win32" ? "npx.cmd" : "npx";
const command = [
  runner,
  "tsx",
  "scripts/worldcup/live/in-tournament-loop-runner.ts",
  "--mode",
  mode,
];

function emit(payload) {
  console.log(JSON.stringify({ project_id: PROJECT_ID, ...payload }, null, 2));
}

if (Number.isNaN(now.getTime())) {
  throw new Error(`Invalid --now value: ${nowArg}`);
}

if (now < activation) {
  emit({
    skipped: true,
    reason: "before_activation",
    activation_utc: ACTIVATION_UTC,
    mode,
    supervised_hold: mode === "supervised",
  });
  process.exit(0);
}

if (dryRun) {
  emit({
    dry_run: true,
    would_run: command.join(" "),
    cwd: repoRoot,
    activation_utc: ACTIVATION_UTC,
    mode,
    supervised_hold: mode === "supervised",
    includes_go_flag: false,
  });
  process.exit(0);
}

mkdirSync(logDir, { recursive: true });

if (existsSync(lockPath)) {
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const lockedAt = new Date(lock.locked_at);
  if (!Number.isNaN(lockedAt.getTime()) && now.getTime() - lockedAt.getTime() < LOCK_MAX_AGE_MS) {
    emit({
      skipped: true,
      reason: "runner_already_locked",
      locked_at: lock.locked_at,
      mode,
    });
    process.exit(0);
  }
}

writeFileSync(
  lockPath,
  JSON.stringify(
    {
      project_id: PROJECT_ID,
      locked_at: now.toISOString(),
      mode,
      command,
    },
    null,
    2,
  ),
);

try {
  const result = process.platform === "win32"
    ? spawnSync("cmd.exe", ["/c", ...command], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    })
    : spawnSync(runner, command.slice(1), {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      shell: false,
    });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(lockPath, { force: true });
}
