// ANNEX C R32 THIRD-PLACE ALLOCATION — the single, validated 495-row foundation.
//
// FIFA World Cup 2026 Annex C maps each possible set of EIGHT advancing third-place groups (C(12,8)=495
// combinations) to the eight Round-of-32 "3rd place" slots. This module is the ONE place that loads + resolves
// that table. The single source of data is data/external/fifa/annex-c-r32-third-place-mapping.json (validated in
// docs/annex-c-r32-third-place-mapping-phase-1.md). It RETIRES the hand-entered 1-row stubs that previously lived
// inline in worldcup-regulations-engine.ts / resolve-third-place-allocation.ts / build-round-of-32-preview.ts.
//
// Pure + deterministic (no DB, no RNG, no network). Loader is lazy + cached. Run the unit test:
//   npx tsx scripts/worldcup/annex-c-allocation-core.ts --unit-test

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type GroupCode = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "J" | "K" | "L";

// Fixed bracket geometry: each "3rd place" R32 slot faces a specific group WINNER. The winner-slot label (1X)
// therefore identifies the R32 match. (From the published FIFA 2026 bracket / Annex C slot columns.)
//   1E->M74  1I->M77  1A->M79  1L->M80  1D->M81  1G->M82  1B->M85  1K->M87
export const SLOT_TO_MATCH: Record<string, number> = {
  "1A": 79, "1B": 85, "1D": 81, "1E": 74, "1G": 82, "1I": 77, "1K": 87, "1L": 80,
};
export const MATCH_TO_SLOT: Record<number, string> = Object.fromEntries(
  Object.entries(SLOT_TO_MATCH).map(([slot, m]) => [m, slot]),
);
// The eight R32 matches whose away side is a third-place team, ascending.
export const THIRD_PLACE_MATCH_NUMBERS: number[] = Object.values(SLOT_TO_MATCH).slice().sort((a, b) => a - b);
// Annex C column order (the eight winner slots that face a third), per the JSON metadata.slot_order.
export const SLOT_ORDER: string[] = ["1A", "1B", "1D", "1E", "1G", "1I", "1K", "1L"];

// Each winner-slot's allowed pool of third-place groups (FIFA Annex C / published R32 pairings). Used to validate
// that every resolved assignment is legal for its slot — an independent check on the stored table.
export const SLOT_POOL: Record<string, GroupCode[]> = {
  "1E": ["A", "B", "C", "D", "F"], // M74
  "1I": ["C", "D", "F", "G", "H"], // M77
  "1A": ["C", "E", "F", "H", "I"], // M79
  "1L": ["E", "H", "I", "J", "K"], // M80
  "1D": ["B", "E", "F", "I", "J"], // M81
  "1G": ["A", "E", "H", "I", "J"], // M82
  "1B": ["E", "F", "G", "I", "J"], // M85
  "1K": ["D", "E", "I", "J", "L"], // M87
};

export type AnnexCMappingRow = {
  combination_number: number;
  key: string; // sorted concatenation of the eight advancing groups, e.g. "EFGHIJKL"
  advancing_third_place_groups: string[];
  third_place_slot_assignments: Record<string, string>; // 1A -> group letter
};
export type FixedPairing = { match_number: number; home_slot: string; away_slot: string };
export type AnnexCMapping = {
  metadata: Record<string, unknown> & { slot_order?: string[]; fixed_round_of_32_pairings?: FixedPairing[]; official_source?: { url?: string } };
  mappings: Record<string, AnnexCMappingRow>;
  slotOrder: string[];
};

// Resolve the JSON relative to THIS module (import.meta), NOT process.cwd(), so a caller running from any working
// directory still finds it (CWD-independent — ANNEXC-2 / BOUNDARY-OK-1). scripts/worldcup -> repo root is two up.
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ANNEX_C_PATH = path.resolve(MODULE_DIR, "..", "..", "data", "external", "fifa", "annex-c-r32-third-place-mapping.json");
const EXPECTED_COMBINATIONS = 495;
let _cache: AnnexCMapping | null = null;

/** Load + validate the 495-row Annex C mapping (single source). Lazy + cached for the default path. */
export function loadAnnexCMapping(annexCPath: string = ANNEX_C_PATH): AnnexCMapping {
  const resolved = path.resolve(annexCPath); // normalize so the cache key is stable regardless of cwd / relative form
  if (_cache && resolved === ANNEX_C_PATH) return _cache;
  const parsed = JSON.parse(readFileSync(resolved, "utf8"));
  const mappings = parsed.mappings as Record<string, AnnexCMappingRow>;
  if (!mappings || Object.keys(mappings).length !== EXPECTED_COMBINATIONS) {
    throw new Error(`Annex C mapping count invalid (${mappings ? Object.keys(mappings).length : "missing"}) in ${resolved}; expected ${EXPECTED_COMBINATIONS}.`);
  }
  const result: AnnexCMapping = { metadata: parsed.metadata ?? {}, mappings, slotOrder: (parsed.metadata?.slot_order as string[]) ?? SLOT_ORDER };
  if (resolved === ANNEX_C_PATH) _cache = result;
  return result;
}

/** Canonical sorted-concatenation key, e.g. ["F","E",...] -> "EFGHIJKL". */
export function concatKey(groups: string[]): string {
  return [...groups].map((g) => g.toUpperCase()).sort().join("");
}
/** Comma-joined key (legacy shape used by the regulations engine), e.g. "A,B,C,E,G,J,K,L". */
export function commaKey(groups: string[]): string {
  return [...groups].map((g) => g.toUpperCase()).sort().join(",");
}

export type AnnexCResolution = {
  resolved: boolean;
  key_concat: string;
  key_comma: string;
  combination_number: number | null;
  assignments_by_slot: Record<string, string>;   // "1A" -> group letter
  assignments_by_match: Record<number, string>;   // 74   -> group letter
  source_note: string | null;
  errors: string[];
};

/**
 * PURE resolver: given the validated mapping and the eight advancing third-place groups, return the concrete
 * slot/match assignments. Independently re-checks each assignment (8 unique groups, each within the advancing set
 * and within its winner-slot's FIFA pool) so a corrupt stored row cannot silently pass.
 */
export function resolveThirdPlaceAllocation(mapping: AnnexCMapping, selectedThirdGroups: string[]): AnnexCResolution {
  const errors: string[] = [];
  const groups = [...selectedThirdGroups].map((g) => g.toUpperCase());
  const uniq = new Set(groups);
  if (groups.length !== 8) errors.push(`Expected 8 advancing third-place groups, found ${groups.length}.`);
  if (uniq.size !== groups.length) errors.push("Advancing third-place groups are not unique.");

  const key = concatKey(groups);
  const row = uniq.size === 8 && groups.length === 8 ? mapping.mappings[key] : undefined;
  if (!row) {
    if (errors.length === 0) errors.push(`No Annex C combination for key ${key}.`);
    return { resolved: false, key_concat: key, key_comma: commaKey(groups), combination_number: null, assignments_by_slot: {}, assignments_by_match: {}, source_note: null, errors };
  }

  const bySlot = row.third_place_slot_assignments;
  const byMatch: Record<number, string> = {};
  for (const [slot, g] of Object.entries(bySlot)) {
    const m = SLOT_TO_MATCH[slot];
    if (m == null) { errors.push(`Unknown winner slot ${slot} in combination ${row.combination_number}.`); continue; }
    byMatch[m] = g;
    if (!uniq.has(g)) errors.push(`Slot ${slot} assigns group ${g}, which is not among the advancing thirds.`);
    if (!SLOT_POOL[slot]?.includes(g as GroupCode)) errors.push(`Slot ${slot} assigns group ${g}, outside its FIFA pool ${SLOT_POOL[slot]?.join("/") ?? "?"}.`);
  }
  const assignedGroups = Object.values(bySlot);
  if (assignedGroups.length !== 8) errors.push(`Combination ${row.combination_number} has ${assignedGroups.length} slot assignments, expected 8.`);
  if (new Set(assignedGroups).size !== assignedGroups.length) errors.push(`Combination ${row.combination_number} assigns a group to more than one slot.`);
  for (const g of groups) if (!assignedGroups.includes(g)) errors.push(`Advancing group ${g} is not assigned to any slot.`);

  const note = `FIFA Annex C combination ${row.combination_number} (${key}): ${SLOT_ORDER.map((s) => `${s}=3${bySlot[s]}`).join(", ")}`;
  return {
    resolved: errors.length === 0,
    key_concat: key,
    key_comma: commaKey(groups),
    combination_number: row.combination_number,
    assignments_by_slot: bySlot,
    assignments_by_match: byMatch,
    source_note: note,
    errors,
  };
}

/** Convenience: load the (cached) mapping and resolve in one call. */
export function resolveAnnexCForGroups(selectedThirdGroups: string[], annexCPath?: string): AnnexCResolution {
  return resolveThirdPlaceAllocation(loadAnnexCMapping(annexCPath), selectedThirdGroups);
}

// ---------------------------------------------------------------------------------------------------------------
// Unit test (no DB, no network): structural sweep of all 495 rows + doc spot-checks + a synthetic full-chain
// (complete group tables -> best thirds -> Annex C -> concrete M73-M88 -> 32 unique teams) over several combos.
//   npx tsx scripts/worldcup/annex-c-allocation-core.ts --unit-test
// ---------------------------------------------------------------------------------------------------------------
const GROUP_TEAMS: Record<GroupCode, string[]> = {
  A: ["MEX", "RSA", "KOR", "CZE"], B: ["CAN", "BIH", "SUI", "QAT"], C: ["BRA", "HAI", "MAR", "SCO"],
  D: ["AUS", "PAR", "TUR", "USA"], E: ["CIV", "CUW", "ECU", "GER"], F: ["JPN", "NED", "SWE", "TUN"],
  G: ["BEL", "EGY", "IRN", "NZL"], H: ["CPV", "ESP", "KSA", "URU"], I: ["FRA", "IRQ", "NOR", "SEN"],
  J: ["ALG", "ARG", "AUT", "JOR"], K: ["COD", "COL", "POR", "UZB"], L: ["CRO", "ENG", "GHA", "PAN"],
};
const ALL_GROUPS = Object.keys(GROUP_TEAMS) as GroupCode[];

const DOC_SPOT_CHECKS: Array<{ combo: number; key: string; bySlot: Record<string, string> }> = [
  { combo: 1, key: "EFGHIJKL", bySlot: { "1A": "E", "1B": "J", "1D": "I", "1E": "F", "1G": "H", "1I": "G", "1K": "L", "1L": "K" } },
  { combo: 89, key: "BCEHIJKL", bySlot: { "1A": "E", "1B": "J", "1D": "B", "1E": "C", "1G": "I", "1I": "H", "1K": "L", "1L": "K" } },
  { combo: 410, key: "ABCEFHKL", bySlot: { "1A": "H", "1B": "E", "1D": "B", "1E": "C", "1G": "A", "1I": "F", "1K": "L", "1L": "K" } },
  { combo: 495, key: "ABCDEFGH", bySlot: { "1A": "H", "1B": "G", "1D": "B", "1E": "C", "1G": "A", "1I": "F", "1K": "D", "1L": "E" } },
];

function buildR32FromAllocation(advancingGroups: GroupCode[], res: AnnexCResolution, pairings: FixedPairing[]) {
  // synthetic, deterministic finishers: position 0/1/2 in each group's team list = winner/runner-up/third.
  const winner = (g: string) => GROUP_TEAMS[g as GroupCode][0];
  const runner = (g: string) => GROUP_TEAMS[g as GroupCode][1];
  const third = (g: string) => GROUP_TEAMS[g as GroupCode][2];
  const teams: string[] = [];
  let thirdSlots = 0;
  const localErrors: string[] = [];
  for (const p of pairings) {
    // guard the slot regexes (no `!` non-null assertions): a malformed slot reports a clean localError instead of
    // throwing an opaque TypeError (ANNEXC-4).
    const hw = /^Winner Group ([A-L])$/.exec(p.home_slot)?.[1];
    const hr = /^Runner-up Group ([A-L])$/.exec(p.home_slot)?.[1];
    if (!hw && !hr) { localErrors.push(`malformed home_slot "${p.home_slot}" at M${p.match_number}`); continue; }
    teams.push(hw ? winner(hw) : runner(hr as string));
    if (p.away_slot.startsWith("3rd Group ")) {
      const g = res.assignments_by_match[p.match_number];
      if (!g) { localErrors.push(`no third assignment for M${p.match_number}`); continue; }
      thirdSlots += 1;
      teams.push(third(g));
    } else {
      const w = /^Winner Group ([A-L])$/.exec(p.away_slot)?.[1];
      const r = /^Runner-up Group ([A-L])$/.exec(p.away_slot)?.[1];
      if (!w && !r) { localErrors.push(`malformed away_slot "${p.away_slot}" at M${p.match_number}`); continue; }
      teams.push(w ? winner(w) : runner(r as string));
    }
  }
  return { teams, thirdSlots, localErrors };
}

function runUnitTest(): boolean {
  let pass = true;
  const ok = (cond: boolean, label: string) => { if (!cond) pass = false; console.log(`  [${cond ? "OK" : "XX"}] ${label}`); };
  const mapping = loadAnnexCMapping();
  const keys = Object.keys(mapping.mappings);
  const pairings = (mapping.metadata.fixed_round_of_32_pairings as FixedPairing[]) ?? [];

  console.log("=== Annex C allocation core — unit test (no DB) ===");
  console.log(`loaded ${keys.length} combinations from ${ANNEX_C_PATH}`);

  // 1) structural validity of the artifact
  ok(keys.length === 495, "exactly 495 combinations (C(12,8))");
  ok(keys.every((k) => k.length === 8 && k === [...k].sort().join("")), "every key is 8 sorted group letters");
  const combos = keys.map((k) => mapping.mappings[k].combination_number).sort((a, b) => a - b);
  ok(combos[0] === 1 && combos[494] === 495 && new Set(combos).size === 495, "combination_number is 1..495 unique");
  ok(pairings.length === 16, `fixed R32 pairings present (${pairings.length}=16)`);

  // 2) resolve EVERY combination -> each must be valid (8 unique in-pool groups, byMatch covers the 8 third matches)
  let resolvedAll = 0; const failed: string[] = [];
  for (const k of keys) {
    const groups = mapping.mappings[k].advancing_third_place_groups as GroupCode[];
    const res = resolveThirdPlaceAllocation(mapping, groups);
    const byMatchKeys = Object.keys(res.assignments_by_match).map(Number).sort((a, b) => a - b);
    const goodMatches = byMatchKeys.length === 8 && byMatchKeys.join(",") === THIRD_PLACE_MATCH_NUMBERS.join(",");
    const assignedGroups = Object.values(res.assignments_by_slot);
    const goodGroups = new Set(assignedGroups).size === 8 && assignedGroups.every((g) => groups.includes(g as GroupCode));
    if (res.resolved && goodMatches && goodGroups) resolvedAll += 1;
    else if (failed.length < 5) failed.push(`${k}: resolved=${res.resolved} matches=${goodMatches} groups=${goodGroups} err=${res.errors[0] ?? ""}`);
  }
  ok(resolvedAll === 495, `all 495 combinations resolve validly (in-pool, 8 unique groups, 8 third-matches)${failed.length ? " — sample fails: " + failed.join(" | ") : ""}`);

  // 3) doc spot-checks: exact slot assignments match FIFA Annex C published rows
  for (const sc of DOC_SPOT_CHECKS) {
    const groups = [...sc.key] as GroupCode[];
    const res = resolveThirdPlaceAllocation(mapping, groups);
    const matchExact = SLOT_ORDER.every((s) => res.assignments_by_slot[s] === sc.bySlot[s]) && res.combination_number === sc.combo;
    ok(matchExact, `spot-check combo ${sc.combo} (${sc.key}) matches FIFA Annex C row exactly`);
  }

  // 4) FULL CHAIN over several DIFFERENT advancing-third sets: standings -> Annex C -> concrete M73-M88 -> 32 unique
  const chainSets: GroupCode[][] = [
    ["E", "F", "G", "H", "I", "J", "K", "L"], // combo 1
    ["A", "B", "C", "D", "E", "F", "G", "H"], // combo 495
    ["B", "C", "E", "H", "I", "J", "K", "L"], // combo 89
    ["A", "B", "C", "E", "G", "J", "K", "L"], // the OLD 1-row stub's only key
    ["A", "C", "D", "F", "H", "I", "J", "K"], // an arbitrary mixed set
  ];
  for (const set of chainSets) {
    const res = resolveThirdPlaceAllocation(mapping, set);
    const { teams, thirdSlots, localErrors } = buildR32FromAllocation(set, res, pairings);
    const unique = new Set(teams);
    const inPool = Object.entries(res.assignments_by_match).every(([m, g]) => SLOT_POOL[MATCH_TO_SLOT[Number(m)]]?.includes(g as GroupCode));
    const allAdvancing = Object.values(res.assignments_by_match).slice().sort().join("") === [...set].sort().join("");
    ok(
      res.resolved && teams.length === 32 && unique.size === 32 && thirdSlots === 8 && inPool && allAdvancing && localErrors.length === 0,
      `chain ${concatKey(set)} (combo ${res.combination_number}): 32 slots / ${unique.size} unique / 8 thirds / in-pool=${inPool} / thirds==advancing=${allAdvancing}`,
    );
  }

  // 5) negative cases: bad inputs do NOT resolve (and never throw)
  ok(!resolveThirdPlaceAllocation(mapping, ["A", "B", "C"]).resolved, "rejects <8 groups");
  ok(!resolveThirdPlaceAllocation(mapping, ["A", "A", "B", "C", "D", "E", "F", "G"]).resolved, "rejects duplicate groups");
  ok(ALL_GROUPS.length === 12, "12 groups defined for synthetic chains");

  return pass;
}

// entrypoint guard: only self-run when invoked DIRECTLY (never when imported by build-app-data / knockout-path-core /
// the regulations engine / the resim consumer, where a stray --unit-test would otherwise hijack the import).
const isMainAnnexC = !!process.argv[1] && (fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) || process.argv[1].endsWith("annex-c-allocation-core.ts"));
if (isMainAnnexC && process.argv.includes("--unit-test")) {
  const okAll = runUnitTest();
  console.log("\nANNEX C CORE:", okAll ? "PASS — 495-row table is the single validated source for R32 third-place slotting." : "FAIL");
  process.exit(okAll ? 0 : 1);
}
