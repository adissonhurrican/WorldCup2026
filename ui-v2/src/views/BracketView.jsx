import { useState } from "react";
import Screen from "../components/Screen";
import { Flag, SegmentedTabs } from "../components/ui";
import { teamByCode } from "../lib/select";
import { buildBracket } from "../lib/bracket";

// BRACKET tab — schematic knockout bracket R32 -> Final, assembled by buildBracket() from the existing
// export (knockout_fixtures + groups + knockout_paths + team_paths). Mobile-first round-by-round view:
// a round selector (SegmentedTabs) + a vertical list of matchup boxes. Display-only; additive.
// Color states: decided -> winner FULL-COLOR, loser GREY; undecided -> neutral "projected".

function dateText(m) {
  if (m.date_confirmed && m.kickoff_utc) {
    const d = new Date(m.kickoff_utc);
    if (!Number.isNaN(d.getTime())) {
      const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      return `${MON[d.getMonth()]} ${d.getDate()}`;
    }
  }
  return m.round_window_label || "";
}

// One team row inside a matchup box. Winner = full colour + bold; loser = greyed (desaturated flag +
// dim text); undecided = neutral. Falls back to the slot label ("Winner M74") when no team is known yet.
function TeamRow({ data, side }) {
  const team = side.code ? (teamByCode(data, side.code) || { code: side.code }) : null;
  const name = team ? (team.name || team.code) : (side.label || "TBD");
  const grey = side.isLoser;
  return (
    <div className={`flex items-center gap-2 ${grey ? "opacity-55" : ""}`}>
      {team
        ? <Flag team={team} size={22} className={grey ? "grayscale" : ""} />
        : <span className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full bg-fill/10 text-[10px] font-bold text-ink-3">?</span>}
      <span className={`min-w-0 flex-1 truncate text-[14px] ${side.isWinner ? "font-bold text-ink" : grey ? "font-medium text-ink-3" : "font-medium text-ink-2"}`}>
        {name}
        {team && side.projected && <span className="ml-1.5 align-middle text-[10px] font-normal text-ink-3">proj</span>}
      </span>
      {side.score != null && (
        <span className={`shrink-0 tabular-nums text-[14px] ${side.isWinner ? "font-bold text-ink" : grey ? "text-ink-3" : "text-ink-2"}`}>{side.score}</span>
      )}
      {side.isWinner && <span className="shrink-0 text-[11px] font-bold text-qualified">✓</span>}
    </div>
  );
}

function MatchupBox({ data, m }) {
  return (
    <div className="rounded-[12px] bg-fill/[0.08] p-3 ring-1 ring-separator/30">
      <div className="mb-2 flex items-center justify-between text-[11px] text-ink-3">
        <span className="font-semibold uppercase tracking-wide">Match {m.match_number}</span>
        <span className="truncate pl-2">{dateText(m)}{m.city ? ` · ${m.city}` : ""}</span>
      </div>
      <div className="space-y-1.5">
        <TeamRow data={data} side={m.a} />
        <span className="block h-px bg-separator/40" />
        <TeamRow data={data} side={m.b} />
      </div>
    </div>
  );
}

export default function BracketView({ data, rightAction }) {
  const { rounds, hasAnyResult } = buildBracket(data);
  // default to the earliest round that still has an undecided match (advances as the tournament plays out)
  const firstLive = rounds.find((r) => r.matches.some((m) => !m.decided)) || rounds[rounds.length - 1] || null;
  const [sel, setSel] = useState(firstLive ? firstLive.short : "R32");

  const header = <h1 className="py-1 text-[34px] font-bold tracking-tight">Bracket</h1>;
  if (!rounds.length) {
    return (
      <Screen stickyTitle="Bracket" rightAction={rightAction} header={header}>
        <p className="mt-6 text-center text-[14px] text-ink-2">The knockout bracket appears once the schedule is published.</p>
      </Screen>
    );
  }
  const active = rounds.find((r) => r.short === sel) || rounds[0];
  const roundDecided = active.matches.every((m) => m.decided);

  return (
    <Screen stickyTitle="Bracket" rightAction={rightAction} header={header}>
      <SegmentedTabs tabs={rounds.map((r) => r.short)} value={active.short} onChange={setSel} className="mt-1" />

      <div className="mt-3 flex items-center justify-between px-1">
        <span className="text-[13px] font-semibold text-ink">{active.label}</span>
        {!roundDecided && (
          <span className="rounded-full bg-fill/10 px-2 py-0.5 text-[11px] font-medium text-ink-3">projected</span>
        )}
      </div>
      {!roundDecided && (
        <p className="mt-1 px-1 text-[11px] leading-snug text-ink-3">
          Teams are projected from the group-stage simulation until matches are played. Winners light up and carry
          forward; losers grey out — the exact opponents firm up as results come in.
        </p>
      )}

      <div className="mt-3 space-y-3 md:grid md:grid-cols-2 md:gap-3 md:space-y-0 xl:grid-cols-3">
        {active.matches.map((m) => <MatchupBox key={m.match_number} data={data} m={m} />)}
      </div>

      <p className="mt-6 text-center text-[12px] text-ink-3">
        Knockout bracket from our simulation — display only. {hasAnyResult ? "Results fill in as matches finish." : "Fills with real teams once the group stage ends."}
      </p>
    </Screen>
  );
}
