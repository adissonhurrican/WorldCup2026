import { useState } from "react";
import Screen from "../components/Screen";
import { Card, Flag, InfoTip } from "../components/ui";
import { IconChevronRight } from "../components/icons";
import { teamByCode, teamPath } from "../lib/select";

const STAGES = [
  {
    key: "champion",
    label: "Champion",
    title: "Champion",
    info: "The chance this team wins the World Cup. Based on simulating the tournament 20,000 times.",
  },
  {
    key: "final",
    label: "Final",
    title: "Reach Final",
    info: "The chance this team reaches the final.",
  },
  {
    key: "sf",
    label: "SF",
    title: "Reach SF",
    info: "The chance this team reaches the semi-finals (the last 4).",
  },
  {
    key: "qf",
    label: "QF",
    title: "Reach QF",
    info: "The chance this team reaches the quarter-finals (the last 8).",
  },
  {
    key: "r16",
    label: "R16",
    title: "Reach R16",
    info: "The chance this team reaches the Round of 16 (the last 16).",
  },
  {
    key: "r32",
    label: "R32",
    title: "Reach R32",
    info: "The chance this team gets out of their group and into the knockout stage (the last 32).",
  },
];

function groupAdvanceByCode(data) {
  const out = new Map();
  for (const group of data.groups || []) {
    for (const row of group.standings || []) out.set(row.code, row.advance);
  }
  return out;
}

function progressionRows(data) {
  const groupAdvance = groupAdvanceByCode(data);
  return (data.teams || [])
    .map((team) => {
      const path = teamPath(data, team.code) || {};
      const ko = path.knockout || {};
      return {
        team,
        r32: groupAdvance.get(team.code) ?? null,
        r16: ko.reach_round_of_16 ?? null,
        qf: ko.reach_quarterfinal ?? null,
        sf: ko.reach_semifinal ?? null,
        final: ko.reach_final ?? null,
        champion: ko.champion ?? null,
      };
    })
    .sort((a, b) => {
      const c = (b.champion ?? -1) - (a.champion ?? -1);
      if (c) return c;
      const f = (b.final ?? -1) - (a.final ?? -1);
      if (f) return f;
      return a.team.name.localeCompare(b.team.name);
    });
}

function pctFine(x) {
  if (x == null || Number.isNaN(x)) return "-";
  const v = x * 100;
  if (v > 0 && v < 0.1) return "<0.1%";
  if (v < 10) return `${v.toFixed(1).replace(/\.0$/, "")}%`;
  return `${Math.round(v)}%`;
}

function isTopChampion(row, maxChampion) {
  return row.champion != null && maxChampion != null && Math.abs(row.champion - maxChampion) < 0.0000001;
}

export default function PredictionView({ data, rightAction }) {
  const rows = progressionRows(data);
  const maxChampion = rows.length ? rows[0].champion : null;

  return (
    <Screen
      stickyTitle="Prediction"
      rightAction={rightAction}
      header={
        <div className="py-1">
          <h1 className="text-[34px] font-bold tracking-tight">Prediction</h1>
          <p className="mt-1 max-w-2xl text-[14px] leading-relaxed text-ink-2">
            A pre-tournament view of each team's path through the bracket, with the title race front and center.
          </p>
        </div>
      }
    >
      <Methodology />
      <ProgressionTable data={data} rows={rows} maxChampion={maxChampion} />
    </Screen>
  );
}

function Methodology() {
  return (
    <Card className="mt-4 px-5 py-4">
      <div className="flex items-start gap-3">
        <span className="rainbow-line mt-1 h-1.5 w-12 shrink-0 rounded-full" />
        <div className="min-w-0">
          <h2 className="text-[16px] font-bold tracking-tight">How to read this</h2>
          <div className="mt-2 space-y-2 text-[13px] leading-relaxed text-ink-2">
            <p>
              The R32 column uses the same group-stage advancement number shown on each team card and in the
              Groups view. It is the app's single display source for reaching the knockout stage.
            </p>
            <p>
              The deeper rounds come from the tournament simulation path: reach the Round of 16, quarter-finals,
              semi-finals, final, and win the World Cup. These are simulation outputs, not betting odds.
            </p>
            <p>
              Every team's path is shown honestly: even very low-probability outcomes stay visible instead of being rounded away.
              The numbers update after real results are processed and published.
            </p>
          </div>
        </div>
      </div>
    </Card>
  );
}

function ProgressionTable({ data, rows, maxChampion }) {
  const [methodOpen, setMethodOpen] = useState(false);

  return (
    <Card className="mt-4 overflow-hidden">
      <div className="flex flex-col gap-2 px-5 pb-3 pt-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-[16px] font-bold tracking-tight">Pre-tournament progression</h2>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-2">
            Based on 20,000 simulations of the tournament, using a model trained on 7,871 real international matches.
          </p>
          <p className="mt-0.5 text-[12px] text-ink-3">Sorted by champion probability. Swipe horizontally on mobile.</p>
        </div>
        <span className="self-start rounded-full bg-qualified/10 px-2.5 py-1 text-[11px] font-bold text-qualified sm:self-auto">
          Champion focus
        </span>
      </div>

      <div className="border-t border-separator/50">
        <button
          type="button"
          onClick={() => setMethodOpen((v) => !v)}
          aria-expanded={methodOpen}
          className="flex w-full items-center gap-3 px-5 py-3 text-left active:bg-fill/10"
        >
          <IconChevronRight className={`h-5 w-5 shrink-0 text-ink-3 transition-transform ${methodOpen ? "rotate-90" : ""}`} />
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-bold">How these numbers are calculated</span>
            <span className="block text-[12px] text-ink-2">Elo ratings, Monte Carlo simulation, and FIFA Article 13 tiebreakers.</span>
          </span>
        </button>
        {methodOpen && (
          <div className="space-y-2 border-t border-separator/50 px-5 pb-4 pt-3 text-[13px] leading-relaxed text-ink-2">
            <p>
              We simulate the tournament 20,000 times and count how often each team reaches each stage. For example,
              if a team reaches the quarter-finals in 4,000 simulations, its quarter-final number is 20%.
            </p>
            <p>
              Match estimates start from an Elo-style team rating system built on 7,871 real international matches.
              Then the app runs 20,000 possible versions of the tournament, applying the official group and knockout
              rules each time, to estimate each team's chances of advancing.
            </p>
            <p>
              These are pre-tournament estimates. They will shift after real results are processed, and they are
              forecasts rather than certainties or betting odds.
            </p>
          </div>
        )}
      </div>

      <div className="max-h-[68vh] overflow-auto overscroll-contain lg:max-h-[70vh]">
        <table className="w-full min-w-[690px] border-collapse text-left sm:min-w-[760px]">
          <thead>
            <tr className="border-y border-separator/60 bg-surface-2/95 text-[11px] font-bold uppercase tracking-wide text-ink-3">
              <th className="sticky left-0 top-0 z-30 w-[150px] bg-surface-2/95 px-3 py-3 backdrop-blur-xl sm:w-[210px] sm:px-5">Team</th>
              {STAGES.map((stage) => (
                <th
                  key={stage.key}
                  className={`sticky top-0 z-20 bg-surface-2/95 px-3 py-3 text-right backdrop-blur-xl ${
                    stage.key === "champion" ? "text-qualified" : ""
                  }`}
                >
                  <span className="inline-flex items-center justify-end gap-1">
                    <span>{stage.label}</span>
                    <InfoTip label={`${stage.title} explanation`}>
                      {stage.info}
                    </InfoTip>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const top = isTopChampion(row, maxChampion);
              return (
                <tr key={row.team.code} className="border-b border-separator/50 last:border-b-0">
                  <td className="sticky left-0 z-10 bg-surface-2/95 px-3 py-2.5 backdrop-blur-xl sm:px-5 sm:py-3">
                    <div className="flex items-center gap-2 sm:gap-2.5">
                      <span className="w-4 text-right text-[11px] font-bold tabular-nums text-ink-3 sm:w-5 sm:text-[12px]">{i + 1}</span>
                      <Flag team={teamByCode(data, row.team.code) || row.team} size={22} />
                      <div className="min-w-0">
                        <div className="truncate text-[11px] font-semibold leading-tight text-ink sm:text-[13px]">{row.team.name}</div>
                        <div className="text-[9px] font-bold leading-tight text-ink-3 sm:text-[11px]">{row.team.code}</div>
                      </div>
                    </div>
                  </td>
                  {STAGES.map((stage) => (
                    <td
                      key={stage.key}
                      className={`px-3 py-3 text-right text-[13px] font-semibold tabular-nums ${
                        stage.key === "champion"
                          ? top
                            ? "bg-qualified/[0.12] text-qualified"
                            : "bg-qualified/[0.04] text-ink"
                          : "text-ink-2"
                      }`}
                    >
                      {stage.key === "champion" && top ? (
                        <span className="inline-flex rounded-full bg-qualified/10 px-2 py-0.5">{pctFine(row[stage.key])}</span>
                      ) : (
                        pctFine(row[stage.key])
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
