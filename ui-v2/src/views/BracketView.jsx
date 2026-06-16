import Screen from "../components/Screen";
import { Flag } from "../components/ui";
import { teamByCode } from "../lib/select";
import { buildBracket } from "../lib/bracket";

// BRACKET tab — ESPN-style STRUCTURE skeleton (R32 -> Final), assembled by buildBracket() from the export.
// Display-only + structure-only: each slot shows its qualifying POSITION LABEL ("Winner Group A",
// "3rd: A/B/C/D/F", "Winner M74") and fills with the REAL team as each group completes (Phase 2) /
// knockout result advances (Phase 4). No projected teams / predictions are shown (see SHOW_PROJECTIONS in
// lib/bracket.js — all projection code stays built, just not displayed). Mobile: the rounds scroll horizontally.

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dateText(m) {
  if (m.date_confirmed && m.kickoff_utc) {
    const d = new Date(m.kickoff_utc);
    if (!Number.isNaN(d.getTime())) return `${MON[d.getMonth()]} ${d.getDate()}`;
  }
  return m.round_window_label || "";
}

// Compact a structural slot label to fit a narrow bracket column. Real teams render their name instead.
function slotLabel(side) {
  const l = side.label || "TBD";
  return l
    .replace(/^Best 3rd from /, "3rd: ")
    .replace(/^Winner Group /, "Winner ")
    .replace(/^Runner-up Group /, "2nd ")
    .replace(/^Winner M/, "Winner M")
    .replace(/^Runner-up M/, "Loser M"); // SF "Runner-up M101/M102" feeds the 3rd-place match
}

// One slot row: a REAL team (flag + name, winner bold + ✓, loser greyed) OR — until the slot is determined —
// the muted structural position label. No "proj" tag, no win%.
function Slot({ data, side }) {
  const team = side.real && side.code ? (teamByCode(data, side.code) || { code: side.code }) : null;
  const grey = side.isLoser;
  return (
    <div className={`flex items-center gap-1.5 px-2 py-1 ${grey ? "opacity-50" : ""}`}>
      {team
        ? <Flag team={team} size={18} className={grey ? "grayscale" : ""} />
        : <span className="h-[18px] w-[18px] shrink-0 rounded-full bg-fill/10" />}
      <span className={`min-w-0 flex-1 truncate ${team
        ? `text-[12px] ${side.isWinner ? "font-bold text-ink" : grey ? "font-medium text-ink-3" : "font-semibold text-ink-2"}`
        : "text-[11px] font-medium text-ink-3"}`}>
        {team ? (team.name || team.code) : slotLabel(side)}
      </span>
      {side.score != null && (
        <span className={`shrink-0 tabular-nums text-[12px] ${side.isWinner ? "font-bold text-ink" : "text-ink-3"}`}>{side.score}</span>
      )}
      {side.isWinner && <span className="shrink-0 text-[10px] font-bold text-qualified">✓</span>}
    </div>
  );
}

function MatchBox({ data, m }) {
  return (
    <div className="w-[150px] shrink-0 overflow-hidden rounded-[10px] bg-fill/[0.06] ring-1 ring-separator/30">
      <div className="flex items-center justify-between px-2 pt-1 text-[9px] uppercase tracking-wide text-ink-3">
        <span className="font-semibold">M{m.match_number}</span>
        <span className="truncate pl-1">{dateText(m)}</span>
      </div>
      <Slot data={data} side={m.a} />
      <span className="mx-2 block h-px bg-separator/40" />
      <Slot data={data} side={m.b} />
    </div>
  );
}

export default function BracketView({ data, rightAction }) {
  const { rounds, hasAnyResult } = buildBracket(data);
  const header = <h1 className="py-1 text-[34px] font-bold tracking-tight">Bracket</h1>;

  if (!rounds.length) {
    return (
      <Screen stickyTitle="Bracket" rightAction={rightAction} header={header}>
        <p className="mt-6 text-center text-[14px] text-ink-2">The knockout bracket appears once the schedule is published.</p>
      </Screen>
    );
  }

  // The tree (R32 -> Final) scrolls horizontally; the third-place play-off shows as a standalone box below.
  const treeRounds = rounds.filter((r) => r.key !== "third_place");
  const third = rounds.find((r) => r.key === "third_place");

  return (
    <Screen stickyTitle="Bracket" rightAction={rightAction} header={header}>
      <p className="px-1 text-[12.5px] leading-snug text-ink-2">
        The knockout structure. Each slot shows the qualifying position — “Winner Group A”, “2nd B”, “3rd: A/B/C/D/F”,
        “Winner M74” — and fills with the real team as each group finishes. Swipe across for later rounds.
      </p>

      {/* ESPN-style tree: round columns side-by-side; later rounds centre between their feeders (justify-around).
          Horizontal scroll on mobile (bleeds to the screen edges). */}
      <div className="mt-3 -mx-4 overflow-x-auto px-4 pb-2">
        <div className="flex items-stretch gap-2.5" style={{ minWidth: "min-content" }}>
          {treeRounds.map((r) => (
            <div key={r.key} className="flex shrink-0 flex-col">
              <div className="mb-2 text-center text-[11px] font-bold uppercase tracking-wide text-ink-2">{r.short}</div>
              <div className="flex flex-1 flex-col justify-around">
                {r.matches.map((m) => <MatchBox key={m.match_number} data={data} m={m} />)}
              </div>
            </div>
          ))}
        </div>
      </div>

      {third && (
        <div className="mt-5">
          <div className="mb-2 px-1 text-[11px] font-bold uppercase tracking-wide text-ink-2">Third-place play-off</div>
          {third.matches.map((m) => <MatchBox key={m.match_number} data={data} m={m} />)}
        </div>
      )}

      <p className="mt-5 text-center text-[12px] text-ink-3">
        Structure only — real teams fill in as groups finish{hasAnyResult ? "; winners light up as results come in." : "."}
      </p>
    </Screen>
  );
}
