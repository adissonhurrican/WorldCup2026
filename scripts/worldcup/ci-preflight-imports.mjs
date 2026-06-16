#!/usr/bin/env node
/* CI PREFLIGHT — fail RED if a tracked importer references a LOCAL module that is absent from the checkout.
 *
 * This is the guard for the "importers-without-modules" landmine: a partial commit that ships a modified importer
 * (e.g. build-app-data.ts / App.jsx) WITHOUT the new module it imports (e.g. annex-c-allocation-core.ts) would, on a
 * clean CI/Netlify checkout, crash at module-load — silently freezing the export or breaking the whole site build.
 *
 * Pure + static: reads each entry file, extracts its relative imports, and asserts each resolves to a real file on
 * disk. No execution, no DB, no network. Exits non-zero (RED) on the first unresolved import.
 *
 *   node scripts/worldcup/ci-preflight-imports.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."); // scripts/worldcup -> repo root

// The knockout/bracket/K=60 import graph entry points (tracked importers of the new cores + the feature UI).
const ENTRIES = [
  "scripts/worldcup/export/build-app-data.ts",
  "scripts/worldcup/knockout-path-core.ts",
  "scripts/worldcup/advance-bracket-core.ts",
  "scripts/worldcup/live-group-stage-bracket-resimulation-consumer.ts",
  "scripts/worldcup/worldcup-regulations-engine.ts",
  "scripts/worldcup/elo-update-group-stage-wiring.ts",
  "scripts/worldcup/elo-update-engine.ts",
  "ui-v2/src/App.jsx",
  "ui-v2/src/views/BracketView.jsx",
  "ui-v2/src/lib/bracket.js",
];
const EXT_CANDIDATES = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", "/index.ts", "/index.js", "/index.jsx"];
// static (non-relative) imports + non-module asset imports we don't resolve here (node:*, npm pkgs, css/json/png).
const SKIP = /^(node:|[a-z@])/i;
const ASSET = /\.(css|json|png|jpg|jpeg|svg|webp)$/i;

const importRe = /(?:import|export)\s+(?:[^"'`]*?\sfrom\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

let failures = 0, checked = 0;
for (const entry of ENTRIES) {
  const abs = path.join(ROOT, entry);
  if (!existsSync(abs)) { console.error(`MISSING ENTRY: ${entry}`); failures++; continue; }
  const src = readFileSync(abs, "utf8");
  const dir = path.dirname(abs);
  let m;
  while ((m = importRe.exec(src)) !== null) {
    const spec = m[1] ?? m[2];
    if (!spec || SKIP.test(spec) || ASSET.test(spec)) continue;
    checked++;
    const base = path.resolve(dir, spec);
    const ok = EXT_CANDIDATES.some((ext) => existsSync(base + ext));
    if (!ok) { console.error(`UNRESOLVED IMPORT in ${entry}: "${spec}" -> ${path.relative(ROOT, base)}(.ts/.js/...) NOT FOUND`); failures++; }
  }
}

if (failures) { console.error(`\nCI PREFLIGHT FAILED: ${failures} unresolved import(s) / missing entr(ies). A partial commit shipped importers without their modules.`); process.exit(1); }
console.log(`CI PREFLIGHT OK: ${ENTRIES.length} entry files, ${checked} local imports all resolve.`);
