// Hard test for the bracket CLINCH rule: a team is placed in an R32 slot ONLY when mathematically clinched into
// that exact slot (provable regardless of remaining group results); otherwise the slot shows its pool/position
// label. Verifies: the 3 currently-clinched thirds, the pools that must stay pools, complete-group reality,
// incomplete-group labels, NO double-placement, and the synthetic all-12-complete + clinched-incomplete cases.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildBracket } from "../src/lib/bracket.js";
import { groupPositionClinch, bestThirdClinchByMatch } from "../src/lib/bracket-clinch.js";

const data = JSON.parse(readFileSync(new URL("../public/app-data.json", import.meta.url), "utf8"));
const clone = (v) => JSON.parse(JSON.stringify(v));
const find = (rounds, n) => { for (const r of rounds) { const m = r.matches.find((x) => x.match_number === n); if (m) return m; } throw new Error("missing match " + n); };
const bm = (d, n) => find(buildBracket(d).rounds, n);

// ---- best-third clinch (current data): B->M81, D->M74, F->M77 clinched; the rest are pools ----
const third = bestThirdClinchByMatch(data);
assert.equal(third[81]?.code, "BIH", "Bosnia (Group B third) clinched into USA's slot M81");
assert.equal(third[74]?.code, "PAR", "Paraguay (Group D third) clinched into Germany's slot M74");
assert.equal(third[77]?.code, "SWE", "Sweden (Group F third) clinched into France's slot M77");
for (const m of [79, 80, 82, 85, 87]) assert.equal(third[m], undefined, `M${m} best-third is NOT clinched (must stay a pool)`);
assert.equal(Object.keys(third).length, 3, "exactly 3 best-thirds clinched right now");

// ---- rendered bracket: clinched -> real; not clinched -> pool label (null code) ----
const m81 = bm(data, 81);
assert.equal(m81.a.code, "USA"); assert.equal(m81.a.real, true, "USA real (Group D winner)");
assert.equal(m81.b.code, "BIH"); assert.equal(m81.b.real, true, "M81 Bosnia real (clinched), not a projection");
assert.equal(bm(data, 74).b.code, "PAR", "M74 shows Paraguay (clinched)");
const m79 = bm(data, 79);
assert.equal(m79.a.code, "MEX"); assert.equal(m79.a.real, true);
assert.equal(m79.b.code, null, "M79 best-third stays a POOL (Ecuador's Annex C slot can still change)");
assert.equal(bm(data, 85).b.code, null, "M85 best-third stays a pool (Algeria's group incomplete)");

// ---- complete groups -> real winners/runners-up; incomplete groups -> labels ----
const m73 = bm(data, 73);
assert.equal(m73.a.real, true); assert.equal(m73.b.real, true, "M73 both real (Groups A/B complete)");
assert.equal(bm(data, 80).a.code, null, "M80 'Winner Group L' is a label (Group L incomplete)");
assert.equal(bm(data, 86).a.code, null, "M86 'Winner Group J' is a label (Group J incomplete, Argentina catchable)");
assert.equal(bm(data, 86).b.code, "CPV", "M86 'Runner-up H' = Cape Verde, real (Group H complete)");

// ---- NO team appears in two R32 slots (the Croatia double is fixed) ----
const r32 = buildBracket(data).rounds.flatMap((r) => r.matches).filter((m) => m.match_number >= 73 && m.match_number <= 88);
const placed = [];
for (const m of r32) for (const s of [m.a, m.b]) if (s.code) placed.push(s.code);
const dups = placed.filter((v, i) => placed.indexOf(v) !== i);
assert.equal(dups.length, 0, "no team placed in two R32 slots; duplicates: " + [...new Set(dups)].join(","));

// ---- R16+ are all labels until a real knockout result lands (no projection) ----
const m89 = bm(data, 89);
assert.equal(m89.a.code, null, "M89 (R16) is a label until M74/M77 are played");

// ---- group position clinch primitive ----
const gc = groupPositionClinch(data);
assert.equal(gc.A.winner, "MEX"); assert.equal(gc.A.runnerUp, "RSA", "complete group clinched final");
assert.equal(gc.G.winner, null, "Group G winner not clinched (EGY can be caught)");
assert.equal(gc.J.winner, null, "Group J winner not clinched (Argentina can be tied)");

// ---- SYNTHETIC: a clinched-but-incomplete group winner shows REAL (matches the Argentina-style case) ----
const cw = clone(data);
const gJ = cw.real_standings.groups.find((g) => g.group === "J"); // ARG 6, AUT 3, ALG 3, JOR 0, each played 2
// give ARG an insurmountable lead: bump to 9 pts (played 3 -> done from ARG's view) while others can't reach 9
gJ.standings.find((s) => s.code === "ARG").points = 9;
gJ.standings.find((s) => s.code === "ARG").played = 3;
assert.equal(groupPositionClinch(cw).J.winner, "ARG", "Argentina clinched as Group J winner shows real even before the group finishes");

// ---- SYNTHETIC: ALL 12 groups complete -> every best-third is clinched (real-all-12 path) ----
const all = clone(data);
all.real_standings.groups_complete = 12;
for (const g of all.real_standings.groups) g.complete = true;
for (const f of all.fixtures) if (f.group && !f.knockout) f.result = { ...(f.result || {}), status: "final", home_score: f.result?.home_score ?? 0, away_score: f.result?.away_score ?? 0 };
assert.equal(Object.keys(bestThirdClinchByMatch(all)).length, 8, "all 12 complete -> all 8 best-thirds clinch");
assert.equal(bestThirdClinchByMatch(all)[81]?.code, "BIH", "all-complete still sends Bosnia to USA/M81");

console.log("bracket clinch tests passed");
