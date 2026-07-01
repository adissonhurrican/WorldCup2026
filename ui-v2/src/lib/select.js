// Pure read selectors over the app-data.json contract. NOTHING here recomputes a
// probability, standing, or path — every value is surfaced straight from an existing
// export block (groups, team_paths, scenarios, narration, tactical_context,
// real_standings, knockout_paths). No DB / model / API access.

export const BASE = import.meta.env.BASE_URL;

// ---- format helpers ----
export const pct = (x, d = 0) =>
  x == null || Number.isNaN(x) ? "—" : (x * 100).toFixed(d).replace(/\.0$/, "") + "%";
export const FIN_NUM = { "1st": 1, "2nd": 2, "3rd": 3, "4th": 4 };
export function ordinal(n) {
  if (n == null) return "—";
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ---- lookups ----
export function flagUrl(team) {
  return team && team.flag ? BASE + team.flag : null;
}
export function teamsByName(data) {
  return [...(data.teams || [])].sort((a, b) => a.name.localeCompare(b.name));
}
export function teamByCode(data, code) {
  return (data.teams || []).find((t) => t.code === code) || null;
}
export function teamPath(data, code) {
  return (data.team_paths || []).find((p) => p.code === code) || null;
}
export function scenarioFor(data, code) {
  return (data.scenarios || []).find((s) => s.code === code) || null;
}
export function tacticalFor(data, code) {
  return (data.tactical_context || []).find((t) => t.code === code) || null;
}
export function knockoutFor(data, code) {
  return (data.knockout_paths || []).find((k) => k.code === code) || null;
}
function predictedStandingsRows(group) {
  return (group ? group.standings : [])
    .map((row, sourceIndex) => ({ row, sourceIndex }))
    .sort((a, b) => (b.row.advance ?? -Infinity) - (a.row.advance ?? -Infinity) || a.sourceIndex - b.sourceIndex)
    .map((x) => x.row);
}
export function predictedGroup(data, code) {
  for (const g of data.groups || []) {
    const standings = predictedStandingsRows(g);
    const idx = standings.findIndex((x) => x.code === code);
    if (idx !== -1) return { group: g.group, row: standings[idx], standings, rank: idx + 1 };
  }
  return null;
}
export function realGroup(data, letter) {
  const gs = (data.real_standings || {}).groups || [];
  return gs.find((g) => g.group === letter) || null;
}

// ---- phase ----
// Pre-tournament until the real table has any verified results.
export function phase(data) {
  const rs = data.real_standings || {};
  if (rs.status && rs.status !== "not_started") return "live";
  if ((rs.results_counted || 0) > 0) return "live";
  return "pre";
}

// ---- finish-state band (color carries meaning) ----
export function bandOf(pos) {
  if (pos == null) return "none";
  if (pos <= 2) return "qualified";
  if (pos === 3) return "bubble";
  return "out";
}
export const BAND_TEXT = { qualified: "text-qualified", bubble: "text-bubble", out: "text-ink-3", none: "text-ink-3" };

// ---- nickname overlay (separate names file, merged at load; graceful when blank) ----
export function nicknameLine(team) {
  const g = team && team.group ? `Group ${team.group}` : "";
  const nk = team && team.nickname;
  const en = nk && (nk.english || nk.en);
  const loc = nk && (nk.local || nk.native);
  const parts = [];
  if (en) parts.push(en);
  if (loc && loc !== en) parts.push(loc);
  if (g) parts.push(g);
  return parts.join(" · ") || "—";
}

// ---- hero (phase-aware finish line) ----
export function heroFor(data, code) {
  const pg = predictedGroup(data, code);
  const advance = pg ? pg.row.advance : (teamPath(data, code) || {}).advance;
  const predictedNum = pg ? pg.rank : null;
  const predicted = predictedNum != null ? ordinal(predictedNum) : null;
  const ph = phase(data);
  let now = null;
  let movement = null; // 'up' | 'down' | null  (vs predicted)
  if (ph === "live" && pg) {
    const rg = realGroup(data, pg.group);
    const rrow = rg && (rg.standings || []).find((r) => r.code === code);
    now = rrow ? rrow.position : null;
    if (now != null && predictedNum != null && now !== predictedNum) movement = now < predictedNum ? "up" : "down";
  }
  return { advance, predicted, predictedNum, phase: ph, now, movement, group: pg && pg.group };
}

// ---- overview reach stats (straight from team_paths.knockout) ----
export function reachStats(data, code) {
  const kp = (teamPath(data, code) || {}).knockout || {};
  return [
    { label: "Reach R16", v: kp.reach_round_of_16 },
    { label: "Quarter-final", v: kp.reach_quarterfinal },
    { label: "Semi-final", v: kp.reach_semifinal },
    { label: "Final", v: kp.reach_final },
    { label: "Win it all", v: kp.champion },
  ];
}

// ---- knockout-phase hero (My Team) ----
// Once the group stage is COMPLETE, the "chance to reach the knockouts" headline is spent (it is 100% for everyone
// through, and meaningless otherwise). This computes what to show instead, from LIVE data only: the per-tie K=60
// prediction on the team's current knockout fixture. It deliberately does NOT use team_paths[].knockout.reach_* —
// those are the pre-tournament simulation values and never re-condition on real results (an eliminated team still
// shows a non-zero "reach R16"). In single-elimination, P(reach the next round) = P(win this tie), so the familiar
// "chance to reach the [next round]" framing reads straight off the live tie prediction. Returns a mode object, or
// null during the group phase (the caller keeps the group-stage hero unchanged).
const KO_NEXT_ROUND = {
  "Round of 32": "the Round of 16",
  "Round of 16": "the Quarter-finals",
  "Quarter-finals": "the Semi-finals",
  "Semi-finals": "the Final",
};
export function knockoutPhase(data) {
  const rs = data.real_standings || {};
  return rs.status === "complete" || (rs.results_counted || 0) >= 72;
}
// Finished-tie advancer verb, round-aware (ONE source for KnockoutCard + MatchCard + MatchSheet so the three
// surfaces can never disagree): "advance" is only right when there IS a next round (R32..SF). The Final crowns the
// champions and the third-place play-off awards third — mirrors the hero's medal framing (champion / third).
export function koAdvancerVerb(round) {
  if (round === "Final") return "are World Cup champions";
  if (round === "Third-place play-off") return "finish third";
  return "advance";
}
export function knockoutHeroFor(data, code, live = null) {
  if (!knockoutPhase(data)) return null; // group phase -> legacy hero is correct, leave it
  const fixtures = teamRealKnockoutFixtures(data, code);
  // Never reached a knockout tie -> eliminated in the group stage.
  if (!fixtures.length) {
    const pg = predictedGroup(data, code);
    const rg = pg?.group ? realGroup(data, pg.group) : null;
    const row = rg && (rg.standings || []).find((r) => r.code === code);
    return { mode: "out_group", position: row?.position ?? null, group: pg?.group ?? null };
  }
  // The team's next not-yet-decided tie (live or scheduled), if any -> live per-tie win probability.
  // (nextMatchIndex only ever returns a live/scheduled fixture, never a finished one.)
  const ni = nextMatchIndex(fixtures, live);
  const upcoming = ni !== -1 ? fixtures[ni] : null;
  if (upcoming) {
    const isHome = upcoming.home === code;
    const p = upcoming.probabilities || {};
    const winPct = isHome ? (p.home_win ?? null) : (p.away_win ?? null);
    const oppCode = isHome ? upcoming.away : upcoming.home;
    return {
      mode: "advance",
      winPct,
      currentRound: upcoming.round,
      nextRound: KO_NEXT_ROUND[upcoming.round] ?? null, // null at the Final / third-place -> "win it all" / "finish third"
      oppCode,
      oppName: (teamByCode(data, oppCode) || {}).name || oppCode,
      fx: upcoming,
    };
  }
  // No live/scheduled tie remains -> the tournament is over for this team; their outcome is their LAST (deepest)
  // tie. Read it off the last chronological fixture, NOT a reverse-find of the latest loss: the Third-place
  // play-off sits AFTER the Semi-final loss, so a Semi-final loser who then WINS the bronze game must be judged by
  // that final game (finished 3rd), not the earlier SF loss. The Final is likewise the deepest tie for both finalists.
  const last = fixtures[fixtures.length - 1];
  const winner = resultWinnerCode(last);
  const wonLast = winner === code;
  const lostLast = !!winner && winner !== code;
  const round = last.round;
  if (round === "Final") {
    if (wonLast) return { mode: "champion" };
    if (lostLast) return { mode: "runner_up" };
  } else if (round === "Third-place play-off") {
    if (wonLast) return { mode: "third" };
    if (lostLast) return { mode: "fourth" };
  } else if (lostLast) {
    return { mode: "out_knockout", round };
  } else if (wonLast) {
    // Won their last tie but the next round's opponent is not resolved yet.
    return { mode: "through", currentRound: round, nextRound: KO_NEXT_ROUND[round] ?? null };
  }
  // Defensive: a finished tie with no resolvable winner (malformed/transient feed). Never fall back to the spent
  // group-stage hero — show a neutral terminal instead.
  return { mode: "out_knockout", round };
}

// ---- narration: prefer the explicit target key the export now carries (team_code / group); fall back to
// matching the team name in the headline for older exports that didn't key the entries. ----
const NARR_ALIAS = { USA: "United States" };
const narrNorm = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export function narrationFor(data, code) {
  const t = teamByCode(data, code);
  if (!t) return null;
  const list = data.narration || [];
  const scen = list.filter((n) => n && n.content_type === "scenario_narration");
  const pool = scen.length ? scen : list;
  // explicit key first (robust)
  const keyed = pool.find((n) => n && n.team_code === code);
  if (keyed) return keyed;
  // fallback: match the team name inside the headline
  const names = [t.name, NARR_ALIAS[code]].map(narrNorm).filter(Boolean);
  if (!names.length) return null;
  return pool.find((n) => { const h = narrNorm(n && n.headline); return h && names.some((x) => h.includes(x)); }) || null;
}

// ---- knockout narration (per-tie matchup story): pre_match_storyline (preview) + post_result_change (post-match),
// keyed by fixture_label "A vs B". Match EITHER orientation so it is robust to bracket-vs-result ordering. When the
// tie is finished, prefer the post-match story; otherwise the preview. Returns { kind, headline, body } or null. ----
export function knockoutNarrationFor(data, fx, finished) {
  if (!fx || !fx.home || !fx.away) return null;
  const list = data.narration || [];
  const labels = [`${fx.home} vs ${fx.away}`, `${fx.away} vs ${fx.home}`];
  const find = (ct) => list.find((n) => n && n.content_type === ct && labels.includes(n.fixture_label)) || null;
  const post = find("post_result_change"), pre = find("pre_match_storyline");
  const chosen = finished ? (post || pre) : (pre || post);
  return chosen ? { kind: chosen.content_type, headline: chosen.headline, body: chosen.body } : null;
}

// ---- group narration (one comparative "story of the group" per group) ----
// Prefer the explicit `group` key; fall back to "Group X" appearing in the headline/body.
export function groupNarrationFor(data, letter) {
  if (!letter) return null;
  const list = (data.narration || []).filter((n) => n && n.content_type === "group_narration");
  if (!list.length) return null;
  const keyed = list.find((n) => n.group === letter);
  if (keyed) return keyed;
  const needle = `group ${String(letter).toLowerCase()}`;
  return list.find((n) => { const h = narrNorm(n.headline) + " " + narrNorm(n.body); return h.includes(needle); }) || null;
}

// ---- normalized group rows for a group card / standing table ----
// Returns { phase, complete, note, rows:[{pos,code,name,played,won,drawn,lost,gf,ga,gd,pts,band,predNum}] }
export function groupTable(data, letter, focalCode) {
  const ph = phase(data);
  const predicted = (data.groups || []).find((g) => g.group === letter);
  const predRows = predictedStandingsRows(predicted);
  const predOrder = predRows.map((s) => s.code);
  const predFinish = {};
  predRows.forEach((s, i) => { predFinish[s.code] = i + 1; });

  if (ph === "pre") {
    // Real table is all-zero pre-tournament; show predicted seeding order with predicted bands.
    const rows = predRows.map((s, i) => ({
      pos: i + 1,
      code: s.code,
      name: (teamByCode(data, s.code) || {}).name || s.code,
      played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, gd: 0, pts: 0,
      advance: s.advance,
      band: bandOf(i + 1),
      predNum: predFinish[s.code],
      focal: s.code === focalCode,
    }));
    return { phase: ph, complete: false, note: "Not started — group games begin Jun 11; the table fills from verified results.", rows };
  }

  const rg = realGroup(data, letter);
  const std = (rg ? rg.standings : []).slice();
  std.sort((a, b) => (a.position ?? 99) - (b.position ?? 99) || predOrder.indexOf(a.code) - predOrder.indexOf(b.code));
  const rows = std.map((r, i) => {
    const pos = r.position ?? i + 1;
    return {
      pos,
      code: r.code,
      name: r.name || (teamByCode(data, r.code) || {}).name || r.code,
      played: r.played, won: r.won, drawn: r.drawn, lost: r.lost,
      gf: r.goals_for, ga: r.goals_against, gd: r.goal_difference, pts: r.points,
      band: r.band ? r.band : bandOf(pos),
      predNum: predFinish[r.code],
      focal: r.code === focalCode,
      advance_state: r.advance_state,
    };
  });
  return { phase: ph, complete: !!(rg && rg.complete), note: null, rows };
}

// ---- Groups view rows for a chosen layer ('predicted' | 'live') ----
export function groupCardRows(data, letter, mode) {
  const ph = phase(data);
  const predicted = (data.groups || []).find((g) => g.group === letter);
  const predRows = predictedStandingsRows(predicted);
  if (mode === "predicted") {
    return {
      mode: "predicted",
      started: true,
      rows: predRows.map((s, i) => ({
        pos: i + 1,
        code: s.code,
        name: (teamByCode(data, s.code) || {}).name || s.code,
        advance: s.advance,
        band: bandOf(i + 1),
      })),
    };
  }
  // live layer
  const rg = realGroup(data, letter);
  const started = ph === "live" && rg && ((rg.games_played || 0) > 0 || (rg.standings || []).some((r) => r.position != null));
  const std = (rg ? rg.standings : []).slice();
  if (started) std.sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
  else std.sort((a, b) => predRows.findIndex((p) => p.code === a.code) - predRows.findIndex((p) => p.code === b.code));
  return {
    mode: "live",
    started,
    rows: std.map((r, i) => ({
      pos: r.position ?? i + 1,
      code: r.code,
      name: r.name || (teamByCode(data, r.code) || {}).name || r.code,
      played: r.played,
      gd: r.goal_difference,
      pts: r.points,
      band: started ? bandOf(r.position ?? i + 1) : bandOf(i + 1),
    })),
  };
}

// ---- best-third race marker for a 3rd-placed team ----
export function bestThirdInfo(data, code) {
  const race = (data.real_standings || {}).best_third_race;
  if (!race) return null;
  const ranked = race.ranked || [];
  const idx = ranked.findIndex((r) => (r.code || r.team_code) === code);
  if (idx === -1) return { decided: race.decided, qualifyCount: race.qualify_count, note: race.note, in: null };
  return { decided: race.decided, qualifyCount: race.qualify_count, rank: idx + 1, in: idx < (race.qualify_count || 8), note: race.note };
}

// ---- fixtures grouped by viewer-local date, with match state ----
// `live` (optional) is the keyed map from loadLiveScores — display-only in-play scores.
export function matchState(fx, live = null) {
  const lv = live && live[`${fx.home}_${fx.away}`];
  if (lv && lv.status === "live") return "live";
  const r = fx.result;
  if (r && (r.home_score ?? r.home) != null && (r.away_score ?? r.away) != null) return "finished";
  return "scheduled";
}
export function liveOf(fx, live) {
  return (live && live[`${fx.home}_${fx.away}`]) || null;
}
function resultWinnerCode(fx) {
  const r = fx?.result || {};
  const explicit = r.winner_code ?? r.winner ?? null;
  if (explicit) return explicit;
  const h = Number(r.home_score ?? r.home);
  const a = Number(r.away_score ?? r.away);
  if (Number.isFinite(h) && Number.isFinite(a) && h !== a) return h > a ? fx.home : fx.away;
  const ph = Number(r.pens_home ?? r.pens_a);
  const pa = Number(r.pens_away ?? r.pens_b);
  if (Number.isFinite(ph) && Number.isFinite(pa) && ph !== pa) return ph > pa ? fx.home : fx.away;
  return null;
}
export function nextRealKnockoutFixture(data, code, live = null, now = Date.now()) {
  const fixtures = teamRealKnockoutFixtures(data, code);
  const liveFx = fixtures.find((fx) => matchState(fx, live) === "live");
  if (liveFx) return liveFx;
  const upcoming = fixtures.find((fx) => matchState(fx, live) === "scheduled" && kickoffMs(fx) >= now)
    || fixtures.find((fx) => matchState(fx, live) === "scheduled");
  if (upcoming) return upcoming;
  const latestFinished = fixtures.slice().reverse().find((fx) => matchState(fx, live) === "finished");
  if (!latestFinished) return null;
  return resultWinnerCode(latestFinished) === code ? latestFinished : null;
}
function roundName(fx) {
  const raw = fx?.round || fx?.round_key || "";
  if (raw) return String(raw).replace(/_/g, " ");
  return "the knockout stage";
}
export function teamTournamentEndState(data, code) {
  // A team is "done" only once their LAST (deepest) knockout tie is finished. Judge by that last fixture, NOT a
  // reverse-find of the latest loss: the Third-place play-off comes after the Semi-final loss, so a bronze winner
  // would otherwise read as "Eliminated in the Semi-finals" (and a Final loser as "Eliminated in the Final"). This
  // mirrors knockoutHeroFor so the hero headline and this end card never disagree.
  const koFixtures = teamRealKnockoutFixtures(data, code);
  const last = koFixtures.length ? koFixtures[koFixtures.length - 1] : null;
  if (last && matchState(last) === "finished") {
    const winner = resultWinnerCode(last);
    const wonLast = winner === code;
    const lostLast = !!winner && winner !== code;
    const round = last.round;
    if (round === "Final") {
      if (wonLast) return null; // champions are celebrated in the hero, not an "eliminated" end card
      if (lostLast) return { kind: "knockout", title: "Tournament complete", body: "Runners-up — reached the Final." };
    } else if (round === "Third-place play-off") {
      if (wonLast) return { kind: "knockout", title: "Tournament complete", body: "Finished third — won the third-place play-off." };
      if (lostLast) return { kind: "knockout", title: "Tournament complete", body: "Finished fourth in the World Cup." };
    } else if (lostLast) {
      return { kind: "knockout", title: "Tournament complete", body: `Eliminated in ${roundName(last)}.` };
    }
    // wonLast in R32..SF (awaiting the next round) or an unresolved winner -> not terminal; fall through.
  }
  const pg = predictedGroup(data, code);
  const rg = pg?.group ? realGroup(data, pg.group) : null;
  const row = rg && (rg.standings || []).find((r) => r.code === code);
  const state = String(row?.advance_state || "").toLowerCase();
  const eliminated = state === "eliminated" || state === "best_third_out" || row?.band === "gray";
  if (rg?.complete && row && eliminated) {
    return {
      kind: "group",
      title: "Group stage complete",
      body: `Finished ${ordinal(row.position)} in Group ${rg.group} and did not advance.`,
    };
  }
  return null;
}

// ---- confirmed lineups (display only) keyed by HOME_AWAY; null until the XI is stored ----
// `lineups` is the keyed map from loadLineups. Orientation already normalized server-side
// (home_lineup belongs to fx.home, away_lineup to fx.away), so no re-mapping here.
export function lineupOf(fx, lineups) {
  return (fx && lineups && lineups[`${fx.home}_${fx.away}`]) || null;
}

// Goal/card timeline events, keyed by HOME_AWAY in the same exported fixture orientation.
export function eventsOf(fx, events) {
  return (fx && events && events[`${fx.home}_${fx.away}`]) || null;
}

// Live per-team xG (descriptive match stat — separate from predictions), keyed by HOME_AWAY.
// Null until the provider posts statistics; orientation already normalized in loadStats.
export function statsOf(fx, stats) {
  return (fx && stats && stats[`${fx.home}_${fx.away}`]) || null;
}

// Card/sheet display state: do we have an XI yet? The "~60 min before kickoff" placeholder is
// PERSISTENT — shown for any not-yet-finished match with no XI, at ANY distance from kickoff
// (mirrors the always-visible Weather "nearer kickoff" placeholder), so a fan always sees that
// confirmed lineups are a coming feature. Once the XI is stored (~T-60) `has` flips to the XI.
// Finished matches with no stored XI show nothing (the placeholder would be in the past).
export function lineupState(fx, lineups, live = null) {
  const lu = lineupOf(fx, lineups);
  const hasHome = !!(lu && lu.home_lineup && (lu.home_lineup.startXI || []).length);
  const hasAway = !!(lu && lu.away_lineup && (lu.away_lineup.startXI || []).length);
  const has = hasHome || hasAway;
  const state = matchState(fx, live);
  return { lineup: lu, has, hasHome, hasAway, showPlaceholder: !has && state !== "finished" };
}
// Match Day date format: "Mon Jun 29" (viewer-local weekday + month + day) from the kickoff field. One shared
// helper so the Match Day day-headers and the My Team fixture cards render the date identically. null if undated.
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fixtureDayLabel(fx) {
  const iso = fx && (fx.kickoff_utc || fx.kickoff);
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return `${WD[d.getDay()]} ${MON[d.getMonth()]} ${d.getDate()}`;
}

// VIEWER-LOCAL day-bucket key for a fixture — THE single keying used by fixturesByDay, dateOptions
// and the DateStrip chips, so the calendar can never drift from the list's buckets. null = undated.
export function dayKeyOf(fx) {
  const iso = fx && (fx.kickoff_utc || fx.kickoff);
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Match-day options for the Matches-tab DateStrip (the cityOptions pattern, keyed by dayKeyOf):
// one entry per VIEWER-LOCAL day that has at least one dated fixture (group or knockout) — rest
// days simply don't exist here. [{ key, label, count }], chronological. Undated knockout slot
// cards are excluded (they stay in their round sections under "All").
export function dateOptions(data) {
  const m = new Map();
  for (const fx of data.fixtures || []) {
    const key = dayKeyOf(fx);
    if (!key) continue;
    const e = m.get(key) || { key, label: fixtureDayLabel(fx) || key, count: 0 };
    e.count += 1;
    m.set(key, e);
  }
  return [...m.values()].sort((a, b) => a.key.localeCompare(b.key));
}

// `cityFilter` (optional) narrows to fixtures at that host city, reusing the venue feature's
// per-fixture `city` field (the same mapping the venue card uses) — null/"" = all cities (unchanged).
// `dateFilter` (optional) narrows to one viewer-local match day (a dayKeyOf key from dateOptions);
// it COMPOSES with cityFilter (both are predicates over the same list). With a dateFilter set,
// DATED knockout fixtures matching that day are included (in their round section) and undated
// slot-rounds are excluded; with no dateFilter, knockout behavior is unchanged.
export function fixturesByDay(data, cityFilter = null, dateFilter = null) {
  const days = new Map();
  for (const fx of data.fixtures || []) {
    if (cityFilter && fx.city !== cityFilter) continue;
    // Knockout fixtures (slot-based, no teams) group by ROUND, in one section each, keyed 'zzN' so they
    // sort AFTER every group-stage day. Label carries the round + its date window (e.g. "Round of 32 · Jun 28 – Jul 3").
    if (isKnockoutFixture(fx)) {
      if (dateFilter && dayKeyOf(fx) !== dateFilter) continue;
      const key = `zz${fx.round_order || 9}`;
      const label = fx.round_window_label ? `${fx.round} · ${fx.round_window_label}` : (fx.round || "Knockouts");
      if (!days.has(key)) days.set(key, { key, label, items: [] });
      days.get(key).items.push(fx);
      continue;
    }
    const key = dayKeyOf(fx) ?? "zzzz";
    if (dateFilter && key !== dateFilter) continue;
    const label = fixtureDayLabel(fx) || "Date TBC";
    if (!days.has(key)) days.set(key, { key, label, items: [] });
    days.get(key).items.push(fx);
  }
  return [...days.values()]
    .map((day) => ({
      ...day,
      // group days sort by kickoff; knockout rounds sort by match number (R32/R16 have no exact kickoff)
      items: day.items.slice().sort((a, b) => (a.knockout && b.knockout ? a.match_number - b.match_number : kickoffMs(a) - kickoffMs(b))),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

// Host-city options for the Matches-tab filter: distinct `fx.city` with a match count + country,
// alphabetical. Pure read over the existing fixture→city mapping; never rebuilt. 16 host cities.
export function cityOptions(data) {
  const m = new Map();
  for (const fx of data.fixtures || []) {
    const c = fx.city;
    if (!c) continue;
    const e = m.get(c) || { city: c, count: 0, country: fx.country || null };
    e.count += 1;
    m.set(c, e);
  }
  return [...m.values()].sort((a, b) => a.city.localeCompare(b.city));
}
export function localTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(d);
}

// ---- one team's real fixtures, chronological (kickoff asc; undated sink to the end) ----
// Pure filter+sort over data.fixtures — surfaces only the matches that exist in the
// export (group games now; knockout fixtures appear automatically once they're added).
function kickoffMs(fx) {
  const iso = fx.kickoff_utc || fx.kickoff;
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isNaN(t) ? Infinity : t;
}
export function teamFixtures(data, code) {
  return (data.fixtures || [])
    .filter((f) => f.home === code || f.away === code)
    .slice()
    .sort((a, b) => kickoffMs(a) - kickoffMs(b));
}

function sideTeamCode(side) {
  return side?.team?.code || null;
}
function knockoutResultAsHomeAway(result) {
  if (!result) return null;
  return {
    ...result,
    home_score: result.home_score ?? result.home ?? result.a ?? null,
    away_score: result.away_score ?? result.away ?? result.b ?? null,
    winner_code: result.winner_code ?? result.winner ?? null,
    pens_home: result.pens_home ?? result.pens_a ?? null,
    pens_away: result.pens_away ?? result.pens_b ?? null,
  };
}
export function realKnockoutFixture(fx) {
  const home = sideTeamCode(fx?.side_a);
  const away = sideTeamCode(fx?.side_b);
  if (!home || !away) return null;
  const pred = fx.prediction || {};
  const probabilities = fx.probabilities || (
    pred.team_a_win_probability != null || pred.team_b_win_probability != null
      ? {
          home_win: pred.team_a_win_probability ?? null,
          draw: 0,
          away_win: pred.team_b_win_probability ?? null,
        }
      : null
  );
  return {
    ...fx,
    group: null,
    knockout: true,
    both_real_knockout: true,
    home,
    away,
    probabilities,
    result: knockoutResultAsHomeAway(fx.result),
  };
}
export function teamRealKnockoutFixtures(data, code) {
  return (data.knockout_fixtures || [])
    .map(realKnockoutFixture)
    .filter((fx) => fx && (fx.home === code || fx.away === code))
    .sort((a, b) => kickoffMs(a) - kickoffMs(b) || (a.match_number || 0) - (b.match_number || 0));
}
// ---- a team's CURRENT knockout-tie story (My Team): pick the tie the team is actually in right now — the live or
// next upcoming one, else (champion / knocked out / awaiting the next round) their latest tie — and return that
// matchup's narration via knockoutNarrationFor. Returns { story, fx, finished } or null. Null when the team has no
// resolved knockout fixture yet (still in groups, or eliminated in groups), so callers fall back to the spent
// group-stage scenario story. Display only — reuses the published pre_match_storyline / post_result_change rows. ----
export function teamCurrentKnockoutNarration(data, code, live = null) {
  const fixtures = teamRealKnockoutFixtures(data, code);
  if (!fixtures.length) return null;
  const ni = nextMatchIndex(fixtures, live);
  const fx = ni !== -1 ? fixtures[ni] : fixtures[fixtures.length - 1];
  const finished = matchState(fx, live) === "finished";
  const story = knockoutNarrationFor(data, fx, finished);
  return story ? { story, fx, finished } : null;
}
// Index of the "next" match in a chronological list: a live one wins, else the soonest
// not-yet-played fixture. Returns -1 when nothing is upcoming (eliminated / tournament over).
export function nextMatchIndex(fixtures, live = null, now = Date.now()) {
  const liveIdx = fixtures.findIndex((f) => matchState(f, live) === "live");
  if (liveIdx !== -1) return liveIdx;
  let idx = fixtures.findIndex((f) => matchState(f, live) === "scheduled" && kickoffMs(f) >= now);
  if (idx === -1) idx = fixtures.findIndex((f) => matchState(f, live) === "scheduled");
  return idx;
}
// Group games always carry a group letter; knockout fixtures are slot-based (no group).
export function isKnockoutFixture(fx) {
  return !!fx && !fx.group;
}
export function scoreOf(fx) {
  const r = fx.result || {};
  const h = r.home_score ?? r.home;
  const a = r.away_score ?? r.away;
  return { h: h ?? null, a: a ?? null };
}
// favorite label from probabilities (display only)
export function favorite(fx) {
  const p = fx.probabilities || {};
  const arr = [
    { k: "home", v: p.home_win ?? 0 },
    { k: "draw", v: p.draw ?? 0 },
    { k: "away", v: p.away_win ?? 0 },
  ].sort((a, b) => b.v - a.v);
  return arr[0];
}

// ---- dual clock: one kickoff_utc -> venue-local + viewer-local (formatted at display) ----
let VIEWER_TZ = "UTC";
try { VIEWER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch (e) { /* keep UTC */ }
export { VIEWER_TZ };
function fmtTZ(iso, tz, opts) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return new Intl.DateTimeFormat("en-US", Object.assign({}, opts, tz ? { timeZone: tz } : {})).format(d);
  } catch (e) {
    return null;
  }
}
function datePartsTZ(iso, tz) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz || undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(d);
    const byType = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    if (!byType.year || !byType.month || !byType.day) return null;
    return {
      key: `${byType.year}-${byType.month}-${byType.day}`,
      label: new Intl.DateTimeFormat("en-US", {
        timeZone: tz || undefined,
        month: "short",
        day: "numeric",
      }).format(d),
    };
  } catch (e) {
    return null;
  }
}
export function dualClock(fx) {
  const iso = fx.kickoff_utc || fx.kickoff;
  if (!iso) return { venue: null, viewer: null, sameZone: true };
  const tz = fx.venue_timezone || null;
  const tOpt12 = { hour: "numeric", minute: "2-digit", hour12: true };
  const tOpt24 = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  const viewer = fmtTZ(iso, VIEWER_TZ, tOpt12);
  const viewer24 = fmtTZ(iso, VIEWER_TZ, tOpt24);
  const sameZone = !tz || tz === VIEWER_TZ;
  const venue = tz ? fmtTZ(iso, tz, tOpt12) : null;
  const venue24 = tz ? fmtTZ(iso, tz, tOpt24) : null;
  const venueDate = tz ? datePartsTZ(iso, tz) : null;
  const viewerDate = datePartsTZ(iso, VIEWER_TZ);
  const dateDiffers = !!(venueDate && viewerDate && venueDate.key !== viewerDate.key);
  return {
    venue,
    venue24,
    viewer,
    viewer24,
    sameZone,
    city: fx.city || null,
    venueDate,
    viewerDate,
    dateDiffers,
  };
}

// ---- venue facts (static; altitude/roof) keyed by venue name then city ----
export function venueFactsFor(data, fx) {
  const vf = data.__venueFacts || {};
  if (!fx) return null;
  return (vf.byVenue && fx.venue && vf.byVenue[fx.venue]) || (vf.byCity && fx.city && vf.byCity[fx.city]) || null;
}

// ---- verified host-city / venue profiles (static; display only) ----
const venueProfileNorm = (s) => String(s || "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

function venueProfileList(data) {
  const raw = (data && data.__venues) || {};
  if (Array.isArray(raw)) return raw;
  if (raw.profiles && Array.isArray(raw.profiles)) return raw.profiles;
  return Object.values(raw).filter((v) => v && typeof v === "object" && v.venue_id);
}

function venueProfileAliases(profile) {
  return [
    profile.venue_id,
    profile.fifa_venue_name,
    profile.real_venue_name,
    profile.real_venue_name && profile.real_venue_name.replace(/\([^)]*\)/g, ""),
    profile.city,
  ].map(venueProfileNorm).filter(Boolean);
}

export function venueProfileFor(data, fx) {
  if (!data || !fx) return null;
  const values = [fx.venue, fx.city].map(venueProfileNorm).filter(Boolean);
  if (!values.length) return null;
  for (const profile of venueProfileList(data)) {
    const aliases = venueProfileAliases(profile);
    for (const value of values) {
      for (const alias of aliases) {
        if (value === alias || alias.includes(value) || value.includes(alias)) return profile;
      }
    }
  }
  return null;
}

// ---- weather forecast (display only) keyed by HOME_AWAY; null until fetched ----
export function fixtureKey(fx) {
  return `${fx.home}_${fx.away}`;
}
export function weatherFor(data, fx) {
  const w = data.__weather || {};
  // Knockout fixtures are bracket slots (no resolved teams until the bracket fills), so their forecast is keyed
  // by match number (M{n}); group fixtures stay keyed by HOME_AWAY. Mirrors the overlay's dual-keying.
  if (fx && fx.match_number != null && (fx.knockout || fx.round_key)) return w[`M${fx.match_number}`] || null;
  return w[fixtureKey(fx)] || null;
}
export function hoursUntil(fx, now = Date.now()) {
  const iso = fx.kickoff_utc || fx.kickoff;
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return Infinity;
  return (t - now) / 3.6e6;
}
// Imminent = within the fetcher's 7-day (168h) forecast window (and not in the past).
export function isImminent(fx, windowHours = 168, now = Date.now()) {
  const h = hoursUntil(fx, now);
  return h >= -3 && h <= windowHours;
}

// Temperature display: data is Celsius; show both C and F (host countries use °F). Display only.
export const cToF = (c) => (c == null || Number.isNaN(c) ? null : Math.round(c * 9 / 5 + 32));
export function tempCF(c) {
  if (c == null || Number.isNaN(c)) return "—";
  return `${Math.round(c)}°C / ${cToF(c)}°F`;
}

// Honest forecast-confidence label derived from the overlay's `confidence` (stamped server-side from
// the fetch lead time: high ≤2d, medium 2–4d, low/early 5–7d). The UI uses this so a 7-day-out forecast
// is never shown as certain; as kickoff nears and the fetch re-runs, confidence rises and the label updates.
export function weatherConfidence(wx) {
  if (!wx || !wx.confidence) return null;
  const c = String(wx.confidence).toLowerCase();
  if (c === "high") return { level: "high", label: "Forecast", muted: false };
  if (c === "medium") return { level: "medium", label: "Forecast firming up", muted: false };
  return { level: "low", label: "Early forecast — may change", muted: true };
}
export function weatherEmoji(condition = "", code = null) {
  const c = String(condition).toLowerCase();
  const n = code == null ? null : Number(code);
  if (n != null) {
    if (n === 0 || n === 1) return "☀️";
    if (n === 2) return "⛅";
    if (n === 3) return "☁️";
    if (n === 45 || n === 48) return "🌫️";
    if (n >= 51 && n <= 67) return "🌧️";
    if (n >= 71 && n <= 77) return "🌨️";
    if (n >= 80 && n <= 82) return "🌧️";
    if (n >= 95) return "⛈️";
  }
  if (/thunder|storm/.test(c)) return "⛈️";
  if (/snow/.test(c)) return "🌨️";
  if (/rain|drizzle|shower/.test(c)) return "🌧️";
  if (/fog|mist/.test(c)) return "🌫️";
  if (/overcast|cloud/.test(c)) return "☁️";
  if (/clear|sun/.test(c)) return "☀️";
  return "🌡️";
}

// ---- deterministic team tint (for the two-color match card only; host overrides) ----
const HOST_TINT = { CAN: "#E24B4A", MEX: "#1D9E75", USA: "#378ADD" };
const TINT_WHEEL = ["#E24B4A", "#EF9F27", "#1D9E75", "#16BFC4", "#378ADD", "#7C5CD6", "#E63D8C", "#C7892F"];
export function teamTint(code) {
  if (HOST_TINT[code]) return HOST_TINT[code];
  let h = 0;
  for (let i = 0; i < (code || "").length; i++) h = (h * 31 + code.charCodeAt(i)) >>> 0;
  return TINT_WHEEL[h % TINT_WHEEL.length];
}

// ---- squad roster (display only; from squads.json overlay, merged at load as data.__squads) ----
// Returns position-grouped rows for a team: [{ key, label, players:[...] }]. Empty array when absent.
const SQUAD_GROUPS = [
  { key: "GK", label: "Goalkeepers" },
  { key: "DEF", label: "Defenders" },
  { key: "MID", label: "Midfielders" },
  { key: "FWD", label: "Forwards" },
];
export function squadFor(data, code) {
  const list = (data.__squads || {})[code];
  return Array.isArray(list) ? list : null;
}
export function squadGroups(data, code) {
  const list = squadFor(data, code);
  if (!list || !list.length) return [];
  const out = SQUAD_GROUPS.map((g) => ({ ...g, players: list.filter((p) => (p.position_group || "") === g.key) }));
  const grouped = out.filter((g) => g.players.length);
  // any players with an unknown/blank group fall into a trailing "Squad" bucket so none are dropped
  const ungrouped = list.filter((p) => !["GK", "DEF", "MID", "FWD"].includes(p.position_group || ""));
  if (ungrouped.length) grouped.push({ key: "OTHER", label: "Squad", players: ungrouped });
  return grouped;
}

// ---- cross-group best-third race summary (surface best_third_race; never recompute) ----
// roundCompleteGroups: how many of the 12 groups have COMPLETED a round (every team played >= 1) —
// computed from the same real_standings per-team `played` field the race gate uses. Drives the
// "fills in as groups play" provisional note while the ranked list is still partial.
export function bestThirdRace(data) {
  const race = (data.real_standings || {}).best_third_race || {};
  const ph = phase(data);
  const qualify = race.qualify_count ?? 8;
  const ranked = race.ranked || [];
  const locked = ranked.filter((r) => r.decided || r.locked || r.status === "qualified").length;
  const contested = Math.max(0, ranked.length - locked);
  const realGroups = (data.real_standings || {}).groups || [];
  const roundCompleteGroups = realGroups.filter(
    (g) => (g.standings || []).length === 4 && g.standings.every((s) => (s.played ?? 0) >= 1),
  ).length;
  return {
    phase: ph,
    decided: !!race.decided,
    qualify,
    totalThirds: 12,
    note: race.note || null,
    ranked,
    locked,
    contested,
    roundCompleteGroups,
  };
}
