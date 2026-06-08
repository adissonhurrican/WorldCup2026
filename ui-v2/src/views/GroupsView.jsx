import { useState } from "react";
import Screen from "../components/Screen";
import { Card, Flag, SegmentedTabs } from "../components/ui";
// NOTE: group_narration ("✦ AI summary") is PARKED — removed from the UI pending a decision.
// The groupNarrationFor() selector remains in select.js (unused here) so re-enabling is a one-line revert.
import { teamByCode, groupCardRows, BAND_TEXT, bestThirdRace, phase, pct } from "../lib/select";
import { IconChevronRight } from "../components/icons";

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
            <ul className="space-y-1.5">
              {r.ranked.map((t, i) => {
                const tm = teamByCode(data, t.code || t.team_code) || { code: t.code };
                const isIn = i < r.qualify;
                return (
                  <li key={i} className="flex items-center gap-2.5 text-[13px]">
                    <span className={`w-4 text-center font-bold tabular-nums ${isIn ? "text-qualified" : "text-ink-3"}`}>{i + 1}</span>
                    <Flag team={tm} size={20} />
                    <span className="min-w-0 flex-1 truncate">{tm.name || t.code}</span>
                    {t.points != null && <span className="tabular-nums text-ink-2">{t.points} pts</span>}
                    <span className={`text-[11px] font-bold ${isIn ? "text-qualified" : "text-ink-3"}`}>{isIn ? "IN" : "OUT"}</span>
                  </li>
                );
              })}
            </ul>
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
