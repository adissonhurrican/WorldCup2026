import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildBracket, bestThirdByMatch } from "../src/lib/bracket.js";

const data = JSON.parse(readFileSync(new URL("../public/app-data.json", import.meta.url), "utf8"));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function match(rounds, matchNumber) {
  for (const round of rounds) {
    const found = round.matches.find((m) => m.match_number === matchNumber);
    if (found) return found;
  }
  throw new Error(`missing match ${matchNumber}`);
}

function builtMatch(sourceData, matchNumber) {
  return match(buildBracket(sourceData).rounds, matchNumber);
}

const beforePaths = JSON.stringify(data.knockout_paths);
const current = bestThirdByMatch(data);

assert.equal(current[81]?.code, "BIH", "Annex C current-best sends Group B third to M81/USA");
assert.equal(current[81]?.real, true, "Bosnia is determined because Group B is complete");
assert.equal(current[74]?.code, "PAR", "Annex C current-best sends Group D third to M74/Germany, not Bosnia");
assert.equal(current[85]?.code, "ALG", "Annex C current-best sends Group J third to M85/Switzerland");
assert.equal(current[85]?.real, false, "Algeria remains projected because Group J is incomplete");

const m81 = builtMatch(data, 81);
assert.equal(m81.a.code, "USA", "M81 side A remains USA");
assert.equal(m81.a.real, true, "USA remains a real group winner");
assert.equal(m81.b.code, "BIH", "M81 side B displays Bosnia");
assert.equal(m81.b.real, true, "M81 Bosnia displays as determined, not projected");
assert.equal(m81.b.projected, false, "M81 Bosnia has no projected badge");

const m74 = builtMatch(data, 74);
assert.equal(m74.a.code, "GER", "M74 side A remains Germany");
assert.equal(m74.b.code, "PAR", "M74 side B is no longer the greedy Bosnia artifact");
assert.equal(m74.b.real, true, "M74 Paraguay displays as determined because Group D is complete");

const m85 = builtMatch(data, 85);
assert.equal(m85.a.code, "SUI", "M85 side A remains Switzerland");
assert.equal(m85.b.code, "ALG", "M85 side B displays the current Group J third");
assert.equal(m85.b.real, false, "M85 Algeria remains projected");
assert.equal(m85.b.projected, true, "M85 Algeria carries the projected badge");

const fixedM73 = builtMatch(data, 73);
assert.equal(fixedM73.a.code, "RSA", "Fixed runner-up slot M73 side A unchanged");
assert.equal(fixedM73.b.code, "CAN", "Fixed runner-up slot M73 side B unchanged");

assert.equal(JSON.stringify(data.knockout_paths), beforePaths, "buildBracket does not mutate knockout_paths");
const usaPath = data.knockout_paths.find((p) => p.code === "USA");
assert.equal(usaPath?.as_group_winner?.projected_opponent?.code, "ALG", "Path-card source remains byte-for-byte old projection");

const jComplete = clone(data);
for (const entry of jComplete.real_standings.best_third_race.ranked) {
  if (entry.group === "J") entry.group_complete = true;
}
const m85JComplete = builtMatch(jComplete, 85);
assert.equal(m85JComplete.b.code, "ALG", "Synthetic Group J complete keeps the same Annex C slot");
assert.equal(m85JComplete.b.real, true, "Synthetic Group J complete removes projected badge");
assert.equal(m85JComplete.b.projected, false, "Synthetic complete third is not projected");

const allComplete = clone(data);
allComplete.real_standings.status = "complete";
allComplete.real_standings.groups_complete = 12;
allComplete.real_standings.best_third_race.decided = true;
for (const entry of allComplete.real_standings.best_third_race.ranked) entry.group_complete = true;
const allCompleteM81 = builtMatch(allComplete, 81);
const allCompleteM85 = builtMatch(allComplete, 85);
assert.equal(allCompleteM81.b.code, "BIH", "All-12 complete path still sends Bosnia to USA");
assert.equal(allCompleteM81.b.real, true, "All-12 complete Bosnia is real");
assert.equal(allCompleteM85.b.code, "ALG", "All-12 complete deterministic allocation converges on same mapping");
assert.equal(allCompleteM85.b.real, true, "All-12 complete projected thirds become real when groups are complete");

const malformed = clone(data);
malformed.real_standings.best_third_race.ranked = malformed.real_standings.best_third_race.ranked.slice(0, 7);
const fallbackM81 = builtMatch(malformed, 81);
const fallbackM74 = builtMatch(malformed, 74);
assert.equal(fallbackM81.b.code, "ALG", "Malformed current-best race falls back to previous greedy M81 projection");
assert.equal(fallbackM74.b.code, "BIH", "Malformed current-best race falls back to previous greedy M74 projection");

console.log("bracket Annex C current-best allocation tests passed");
