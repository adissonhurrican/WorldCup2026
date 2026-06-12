import { useState } from "react";
import Screen from "../components/Screen";
import { Card, Flag, SegmentedTabs } from "../components/ui";
// NOTE: group_narration ("✦ AI summary") is PARKED — removed from the UI pending a decision.
// The groupNarrationFor() selector remains in select.js (unused here) so re-enabling is a one-line revert.
import { teamByCode, groupCardRows, BAND_TEXT, bestThirdRace, scenarioFor, phase, pct } from "../lib/select";
import { IconChevronRight } from "../components/icons";

// The ranked third-place list with "what you need" surfacing. Each row expands on tap to show:
// (a) the team's REAL margin to the qualification cut (computed from the same ranked entries the
// row displays — pts, then GD, mirroring the narration's cut-off comparison), (b) the scenario
// engine's ready-made "needs" sentence + thresholds (carried through app-data.scenarios.
// third_place_race — recomputed every material cycle; null-graceful when absent). A divider marks
// the top-8 cut once both sides exist, and teams LEVEL with the team across the cut (same pts+GD)
// get a "level" badge — the flat list never hid a tie again. Display-only; no recompute.
function cutMargin(ranked, qualify, idx) {
  const me = ranked[idx];
  const cmp = idx < qualify ? ranked[qualify] : ranked[qualify - 1]; // IN -> first OUT; OUT -> last IN
  if (!me || !cmp) return null;
  const dp = (me.points ?? 0) - (cmp.points ?? 0);
  const dg = (me.goal_difference ?? 0) - (cmp.goal_difference ?? 0);
  const vs = cmp.code;
  if (dp > 0) return `${dp} pt${dp === 1 ? "" : "s"} clear of the cut (vs ${vs})`;
  if (dp < 0) return `${Math.abs(dp)} pt${Math.abs(dp) === 1 ? "" : "s"} behind the cut (vs ${vs})`;
  if (dg > 0) return `level on points with ${vs}, ahead on goal difference (+${dg})`;
  if (dg < 0) return `level on points with ${vs}, behind on goal difference (${dg})`;
  return `level with ${vs} on points and goal difference — tiebreakers decide`;
}
function ThirdPlaceList({ data, race }) {
  const [openCode, setOpenCode] = useState(null);
  const ranked = race.ranked;
  const qualify = race.qualify;
  return (
    <ul className="space-y-1.5">
      {ranked.map((t, i) => {
        const code = t.code || t.team_code;
        const tm = teamByCode(data, code) || { code };
        const isIn = i < qualify;
        const open = openCode === code;
        const tpr = (scenarioFor(data, code) || {}).third_place_race || {};
        const margin = ranked.length > qualify ? cutMargin(ranked, qualify, i) : null;
        // level-at-the-cut badge: same pts + GD as the team on the other side of the line
        const cmp = ranked.length > qualify ? (i < qualify ? ranked[qualify] : ranked[qualify - 1]) : null;
        const level = cmp && (t.points ?? 0) === (cmp.points ?? 0) && (t.goal_difference ?? 0) === (cmp.goal_difference ?? 0);
        return (
          <li key={code}>
            {i === qualify && (
              <div className="mb-1.5 flex items-center gap-2">
                <span className="h-px flex-1 bg-separator/60" />
                <span className="text-[10px] font-bold uppercase tracking-wide text-ink-3">top {qualify} advance</span>
                <span className="h-px flex-1 bg-separator/60" />
              </div>
            )}
            <button onClick={() => setOpenCode(open ? null : code)} aria-expanded={open} className="flex w-full items-center gap-2.5 text-left text-[13px] active:opacity-70">
              <span className={`w-4 text-center font-bold tabular-nums ${isIn ? "text-qualified" : "text-ink-3"}`}>{i + 1}</span>
              <Flag team={tm} size={20} />
              <span className="min-w-0 flex-1 truncate">{tm.name || code}</span>
              {level && <span className="rounded-full bg-bubble/10 px-1.5 py-0.5 text-[10px] font-semibold text-bubble">level</span>}
              {t.points != null && <span className="tabular-nums text-ink-2">{t.points} pts</span>}
              <span className={`text-[11px] font-bold ${isIn ? "text-qualified" : "text-ink-3"}`}>{isIn ? "IN" : "OUT"}</span>
              <IconChevronRight className={`h-3.5 w-3.5 shrink-0 text-ink-3 transition-transform ${open ? "rotate-90" : ""}`} />
            </button>
            {open && (
              <div className="ml-[26px] mt-1.5 space-y-1 rounded-[10px] bg-fill/[0.06] px-3 py-2">
                <p className="text-[12px] text-ink-2">
                  <span className="font-semibold">GD {t.goal_difference > 0 ? `+${t.goal_difference}` : t.goal_difference} · GF {t.goals_for}</span>
                  {margin ? <> — {margin}</> : <> — no cut-off comparison yet (the race is still filling in)</>}
                </p>
                {tpr.needs && <p className="text-[12px] leading-relaxed text-ink-2">{tpr.needs}</p>}
                {tpr.thresholds && (tpr.thresholds.min_points != null || tpr.thresholds.min_overall_gd != null) && (
                  <p className="text-[11px] text-ink-3">
                    Typical bar as a third: {tpr.thresholds.min_points != null ? `≥ ${tpr.thresholds.min_points} pts` : ""}
                    {tpr.thresholds.min_overall_gd != null ? `${tpr.thresholds.min_points != null ? ", " : ""}GD ≥ ${tpr.thresholds.min_overall_gd}` : ""}
                    {tpr.thresholds.min_goals_for != null ? `, GF ≥ ${tpr.thresholds.min_goals_for}` : ""}
                  </p>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export default function GroupsView({ data, onSelectTeam, rightAction }) {
  const letters = (data.groups || []).map((g) => g.group).sort();
  const ph = phase(data);
  const [layer, setLayer] = useState(ph === "live" ? "Live" : "Predicted");

  return (
    <Screen stickyTitle="Groups" rightAction={rightAction} header={<h1 className="py-1 text-[34px] font-bold tracking-tight">Groups</h1>}>
      <ThirdPlaceStrip data={data} />

      {/* Predicted / Live toggle (drives all 12 cards) — shared glass SegmentedTabs */}
      <SegmentedTabs tabs={["Predicted", "Live"]} value={layer} onChange={setLayer} className="mt-4 lg:max-w-[360px]" />

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        {letters.map((L) => (
          <GroupCard key={L} data={data} letter={L} layer={layer.toLowerCase()} onSelectTeam={onSelectTeam} />
        ))}
      </div>

      <p className="mt-6 text-center text-[12px] text-ink-3">
        Predicted = simulation order &amp; to-advance %. Live = verified results (positions, points, GD), once games are played.
      </p>
    </Screen>
  );
}

// Cross-group layer: the best-third race across all 12 groups (surfaced from best_third_race).
function ThirdPlaceStrip({ data }) {
  const r = bestThirdRace(data);
  const [open, setOpen] = useState(false);
  const summary =
    r.phase === "pre"
      ? `${r.qualify} of ${r.totalThirds} third-placed teams advance`
      : `${r.qualify} of ${r.totalThirds} advance · ${r.locked} locked · ${r.contested} contested`;

  return (
    <Card className="mt-2 overflow-hidden">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-3 px-5 py-3.5 text-left active:bg-fill/10">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-bubble/10 text-bubble">
          <span className="text-[15px] font-bold">3rd</span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-semibold">Best-third race</span>
          <span className="block truncate text-[12px] text-ink-2">{summary}</span>
        </span>
        <IconChevronRight className={`h-5 w-5 shrink-0 text-ink-3 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="border-t border-separator/50 px-5 py-3">
          {r.phase === "pre" || r.ranked.length === 0 ? (
            <p className="text-[13px] text-ink-2">{r.note || "The third-place race begins once group games are played; the eight best thirds advance."}</p>
          ) : (
            <>
              {/* provisional context while the race is filling in — N computed from the real per-team
                  played data (round complete = all 4 of a group's teams have played >= 1). */}
              {r.roundCompleteGroups < 12 && !r.decided && (
                <p className="mb-2 text-[12px] text-ink-3">
                  The third-place race fills in as groups play their matches. Only {r.roundCompleteGroups} of 12 groups
                  {r.roundCompleteGroups === 1 ? " has" : " have"} completed a round so far, so these standings are provisional.
                </p>
              )}
              <ThirdPlaceList data={data} race={r} />
            </>
          )}
        </div>
      )}
    </Card>
  );
}

function GroupCard({ data, letter, layer, onSelectTeam }) {
  const t = groupCardRows(data, letter, layer);
  const live = t.mode === "live";
  const notStarted = live && !t.started;
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between px-5 pb-1 pt-4">
        <h3 className="text-[15px] font-bold tracking-tight">Group {letter}</h3>
        <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-3">
          {notStarted ? "Not started" : live ? "Pld · GD · Pts" : "to advance"}
        </span>
      </div>
      {/* group_narration "✦ AI summary" PARKED — intentionally not rendered (see import note). */}
      <ul className="pb-1.5">
        {t.rows.map((r, i) => {
          const tm = teamByCode(data, r.code) || { code: r.code };
          return (
            <li key={r.code} className="relative">
              <button onClick={() => onSelectTeam(r.code)} className="flex w-full items-center gap-2.5 px-5 py-[7px] text-left active:bg-fill/10">
                <span className={`w-3.5 text-center text-[13px] font-bold tabular-nums ${BAND_TEXT[r.band] || "text-ink-3"}`}>{r.pos}</span>
                <Flag team={tm} size={22} />
                <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{r.name}</span>
                {live ? (
                  <span className="flex items-center text-[12px] tabular-nums text-ink-2">
                    <span className="w-6 text-center">{r.played}</span>
                    <span className="w-7 text-center text-ink">{r.gd > 0 ? `+${r.gd}` : r.gd}</span>
                    <span className="w-7 text-center font-bold text-ink">{r.pts}</span>
                  </span>
                ) : (
                  <span className="text-[13px] font-semibold tabular-nums text-ink-2">{pct(r.advance)}</span>
                )}
              </button>
              {i < t.rows.length - 1 && <span className="hairline absolute bottom-0 left-[56px] right-0 h-px" />}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
