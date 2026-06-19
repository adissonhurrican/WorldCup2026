import { useState, useRef, useLayoutEffect } from "react";
import Screen from "../components/Screen";
import { Flag } from "../components/ui";
import { teamByCode } from "../lib/select";
import { buildBracket } from "../lib/bracket";

// BRACKET tab — ESPN-style knockout tree (R32 -> Final) with connector lines linking each match to the two that
// feed it. Shows the model's PROJECTED matchups (SHOW_PROJECTIONS=true in lib/bracket.js) together with the "How
// the bracket works" explanation, so a projection never appears without its context. Each projected slot carries a
// "proj" indicator; real teams fill in (and lose the indicator) as groups complete and knockout results advance.
// Mobile: the rounds scroll horizontally. The connectors are an SVG overlay measured from the rendered card
// positions, so they stay correct across the justify-around layout, horizontal scroll, and live re-projections.

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dateText(m) {
  if (m.date_confirmed && m.kickoff_utc) {
    const d = new Date(m.kickoff_utc);
    if (!Number.isNaN(d.getTime())) return `${MON[d.getMonth()]} ${d.getDate()}`;
  }
  return m.round_window_label || "";
}

// Compact a structural slot label to fit a narrow bracket column (used until a slot has a team).
function slotLabel(side) {
  const l = side.label || "TBD";
  return l
    .replace(/^Best 3rd from /, "3rd: ")
    .replace(/^Winner Group /, "Winner ")
    .replace(/^Runner-up Group /, "2nd ")
    .replace(/^Runner-up M/, "Loser M");
}

// One slot row. Three states: REAL team (resolved — flag + bold name, winner ✓ / loser greyed); PROJECTED team
// (model's pick on an undecided slot — flag + muted name + a "proj" tag); or, until a team is known, the position label.
function Slot({ data, side }) {
  const team = side.code ? (teamByCode(data, side.code) || { code: side.code }) : null;
  const grey = side.isLoser;
  const projected = side.projected;
  return (
    <div className={`flex items-center gap-1.5 px-2 py-1 ${grey ? "opacity-50" : ""}`}>
      {team
        ? <Flag team={team} size={18} className={grey ? "grayscale" : ""} />
        : <span className="h-[18px] w-[18px] shrink-0 rounded-full bg-fill/10" />}
      <span className={`min-w-0 flex-1 truncate ${team
        ? `text-[12px] ${side.isWinner ? "font-bold text-ink" : grey ? "font-medium text-ink-3" : projected ? "font-medium text-ink-2" : "font-semibold text-ink-2"}`
        : "text-[11px] font-medium text-ink-3"}`}>
        {team ? (team.name || team.code) : slotLabel(side)}
      </span>
      {projected && <span className="shrink-0 rounded bg-fill/10 px-1 py-px text-[8px] font-semibold uppercase tracking-wide text-ink-3">proj</span>}
      {side.score != null && (
        <span className={`shrink-0 tabular-nums text-[12px] ${side.isWinner ? "font-bold text-ink" : "text-ink-3"}`}>{side.score}</span>
      )}
      {side.isWinner && <span className="shrink-0 text-[10px] font-bold text-qualified">✓</span>}
    </div>
  );
}

function MatchBox({ data, m, boxRef }) {
  return (
    <div ref={boxRef} className="w-[150px] shrink-0 overflow-hidden rounded-[10px] bg-fill/[0.06] ring-1 ring-separator/30">
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

// The horizontally-scrolling tree + the SVG connector overlay. Connectors are measured from the live DOM so they
// track the justify-around centring exactly; recomputed on resize and whenever the projection data changes.
function BracketTree({ data, rounds }) {
  const containerRef = useRef(null);
  const boxRefs = useRef(new Map());
  const [conn, setConn] = useState({ d: "", w: 0, h: 0 });

  useLayoutEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const measure = () => {
      const cr = c.getBoundingClientRect();
      const pos = (n) => {
        const el = boxRefs.current.get(n);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left - cr.left, right: r.right - cr.left, midY: r.top - cr.top + r.height / 2 };
      };
      const segs = [];
      for (const round of rounds) for (const m of round.matches) {
        const feeders = m.feeders || [];
        if (!feeders.length) continue;                 // R32 has no incoming connectors
        const cons = pos(m.match_number);
        const fs = feeders.map(pos).filter(Boolean);
        if (!cons || !fs.length) continue;
        const midX = (Math.max(...fs.map((f) => f.right)) + cons.left) / 2;
        const ys = [...fs.map((f) => f.midY), cons.midY];
        const r1 = (x) => Math.round(x * 10) / 10;
        segs.push(`M${r1(midX)} ${r1(Math.min(...ys))}V${r1(Math.max(...ys))}`); // vertical bus through the gap
        for (const f of fs) segs.push(`M${r1(f.right)} ${r1(f.midY)}H${r1(midX)}`); // stub out of each feeder
        segs.push(`M${r1(cons.left)} ${r1(cons.midY)}H${r1(midX)}`);                // stub into the consumer
      }
      setConn({ d: segs.join(""), w: Math.round(cr.width), h: Math.round(cr.height) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(c);
    return () => ro.disconnect();
  }, [rounds, data]);

  return (
    <div ref={containerRef} className="relative flex items-stretch gap-7" style={{ minWidth: "min-content" }}>
      <svg className="pointer-events-none absolute left-0 top-0 z-0 text-ink-3/45" width={conn.w} height={conn.h} aria-hidden="true">
        <path d={conn.d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
      {rounds.map((r) => (
        <div key={r.key} className="relative z-10 flex shrink-0 flex-col">
          <div className="mb-2 text-center text-[11px] font-bold uppercase tracking-wide text-ink-2">{r.short}</div>
          <div className="flex flex-1 flex-col justify-around">
            {r.matches.map((m) => (
              <MatchBox
                key={m.match_number}
                data={data}
                m={m}
                boxRef={(el) => { if (el) boxRefs.current.set(m.match_number, el); else boxRefs.current.delete(m.match_number); }}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// "How the bracket works" — approved copy (verbatim). First sentence of each paragraph is emphasised for scanning;
// the wording is unchanged. Collapsible so it is available but not overwhelming; a short framing line stays visible
// above it so the projections are never shown without their context.
const HOW_PARAS = [
  ["It's a projection, not a result.", "No knockout matches have been played yet, so every team you see in a slot is our model's best guess at who will end up there. It is based on the group games played so far plus 20,000 simulations of how the rest of the tournament could unfold."],
  ["It updates after every match.", "Each result feeds back into the model, so the bracket recalculates continuously. A team that looks safe today can slip tomorrow, and a team on the bubble can climb in. If you check back after a match, expect things to have shifted. That is the model staying current, not flip flopping."],
  ["We show the single most likely bracket.", "For each slot we place the team most likely to fill it, but most likely is not certain. Your team might be, say, 64 percent to advance across many different paths yet still not appear in this one snapshot. That is why we also show each team's overall chance to advance. That percentage is the fuller picture, and the bracket is one likely version of events."],
  ["The third place spots are the trickiest, and they compare teams across groups.", "Eight of the twelve third placed teams qualify, so four groups miss out. To decide which eight, the model ranks every group's third placed team against the others and slots the qualifiers in following FIFA's official chart. Because that comparison spans all the groups, a third placed team can move in or out as other groups play, and the exact lineup only locks once every group has finished."],
  ["It becomes real as groups finish.", "The moment a group is decided, its actual winner and runner up lock into the bracket with no more guessing. By the time the group stage ends, the projections are replaced entirely by the real teams, and from the Round of 32 onward, real results carry teams forward."],
];

function HowItWorks() {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2 overflow-hidden rounded-[12px] bg-fill/[0.06] ring-1 ring-separator/30">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left active:opacity-60"
      >
        <span className="text-[13px] font-semibold text-ink">How the bracket works</span>
        <svg viewBox="0 0 24 24" width="16" height="16" className={`shrink-0 text-ink-3 transition-transform ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="space-y-2.5 px-3 pb-3.5 pt-0.5 text-[12.5px] leading-relaxed text-ink-2">
          {HOW_PARAS.map(([lead, rest], i) => (
            <p key={i}><span className="font-semibold text-ink">{lead}</span> {rest}</p>
          ))}
        </div>
      )}
    </div>
  );
}

// Order each round's matches by the BRACKET TOPOLOGY (breadth-first from the Final, each match's two feeders in
// order), NOT by match number — so every match sits directly between the two that feed it and the connector lines
// never cross. Fail-soft: any topology mismatch (partial data, missing feeders) returns the input unchanged, so the
// bracket still renders (just in match order) rather than breaking.
function orderRoundsForTree(rounds) {
  if (rounds.length < 2) return rounds;
  const finalRound = rounds[rounds.length - 1];
  if (finalRound.matches.length !== 1) return rounds;
  const byNum = new Map();
  for (const r of rounds) for (const m of r.matches) byNum.set(m.match_number, m);
  const orderByKey = { [finalRound.key]: [finalRound.matches[0].match_number] };
  let level = orderByKey[finalRound.key];
  for (let i = rounds.length - 2; i >= 0; i--) {
    const next = [];
    for (const mn of level) { const m = byNum.get(mn); for (const f of (m?.feeders || [])) next.push(f); }
    if (next.length !== rounds[i].matches.length) return rounds; // topology doesn't line up -> leave as-is
    orderByKey[rounds[i].key] = next;
    level = next;
  }
  return rounds.map((r) => {
    const ord = orderByKey[r.key];
    if (!ord) return r;
    const pos = new Map(ord.map((mn, idx) => [mn, idx]));
    return { ...r, matches: [...r.matches].sort((a, b) => (pos.get(a.match_number) ?? 99) - (pos.get(b.match_number) ?? 99)) };
  });
}

export default function BracketView({ data, rightAction }) {
  const { rounds } = buildBracket(data);
  const header = <h1 className="py-1 text-[34px] font-bold tracking-tight">Bracket</h1>;

  if (!rounds.length) {
    return (
      <Screen stickyTitle="Bracket" rightAction={rightAction} header={header}>
        <p className="mt-6 text-center text-[14px] text-ink-2">The knockout bracket appears once the schedule is published.</p>
      </Screen>
    );
  }

  // The tree (R32 -> Final) scrolls horizontally; the third-place play-off shows as a standalone box below.
  const treeRounds = orderRoundsForTree(rounds.filter((r) => r.key !== "third_place"));
  const third = rounds.find((r) => r.key === "third_place");

  return (
    <Screen stickyTitle="Bracket" rightAction={rightAction} header={header}>
      {/* Always-visible framing so projections never read as settled results, + the full explanation one tap away. */}
      <p className="px-1 text-[12.5px] leading-snug text-ink-2">
        Projected matchups, not results: our model's best guess at the knockout draw. It updates after every match,
        and real teams replace the projections as groups finish.
      </p>
      <HowItWorks />

      <div className="mt-3 -mx-4 overflow-x-auto px-4 pb-2">
        <BracketTree data={data} rounds={treeRounds} />
      </div>

      {third && (
        <div className="mt-5">
          <div className="mb-2 px-1 text-[11px] font-bold uppercase tracking-wide text-ink-2">Third-place play-off</div>
          {third.matches.map((m) => <MatchBox key={m.match_number} data={data} m={m} />)}
        </div>
      )}

      <p className="mt-5 text-center text-[12px] text-ink-3">
        Projected from our simulation. Updates after every match; real teams replace projections as groups finish.
      </p>
    </Screen>
  );
}
