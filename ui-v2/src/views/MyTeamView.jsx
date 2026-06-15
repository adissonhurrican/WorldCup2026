import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import goldTexture from "../assets/player-card-gold.jpg";
import Screen from "../components/Screen";
import MatchCard from "../components/MatchCard";
import { Card, Flag, InfoTip, SegmentedTabs } from "../components/ui";
import { IconChevronDown } from "../components/icons";
import {
  teamByCode, nicknameLine, heroFor, reachStats, narrationFor, scenarioFor,
  tacticalFor, knockoutFor, groupTable, bestThirdInfo, bandOf, BAND_TEXT, pct, ordinal,
  teamFixtures, nextMatchIndex, isKnockoutFixture, matchState, squadGroups, fixtureDayLabel,
} from "../lib/select";

const TABS = ["Overview", "Standing", "Path", "Squad"];
const UPDATE_TIMING_NOTE = "Numbers update within about 15 minutes after a match finishes. Refresh to see the latest.";
// Visible card variant of the same promise (keep the ~15-min figure in sync with UPDATE_TIMING_NOTE).
const CARD_TIMING_NOTE = "Numbers and AI analysis update within about 15 minutes after each match finishes, as the model recalculates with the verified result.";

const NUMBER_INFO = {
  advance: `The chance this team reaches the knockout stage, based on 20,000 tournament simulations. ${UPDATE_TIMING_NOTE}`,
  predictedFinish: "Before the group games, this is the team's projected finishing position in the group, from the simulations.",
  currentFinish: "This is the team's current position in the group table, from real results so far — it updates as matches finish.",
  winGroup: "The chance they finish 1st in the group.",
  runnerUp: "The chance they finish 2nd in the group.",
  bestThird: "The chance they finish 3rd and still qualify as one of the best third-placed teams.",
  ifThird: "If they finish 3rd, this is their chance of still qualifying. It depends on how the other groups finish.",
};

function routeInfoCopy(route = "") {
  const r = route.toLowerCase();
  if (r.includes("win") || r.includes("1st") || r.includes("first")) return NUMBER_INFO.winGroup;
  if (r.includes("runner") || r.includes("2nd") || r.includes("second")) return NUMBER_INFO.runnerUp;
  if (r.includes("third")) return NUMBER_INFO.bestThird;
  return NUMBER_INFO.advance;
}

export default function MyTeamView({ data, code, tab, onTab, live, lineups, events, stats, onOpenMatch, onOpenSwitcher, rightAction }) {
  const team = teamByCode(data, code) || { code, name: code, group: "?" };
  return (
    <Screen stickyTitle={team.name} rightAction={rightAction} header={<TeamHeader team={team} onOpenSwitcher={onOpenSwitcher} />}>
      <SegmentedTabs tabs={TABS} value={tab} onChange={onTab} className="mt-1 lg:max-w-[460px]" />
      <div key={tab} className="animate-panel mt-4">
        {tab === "Overview" && (
          <div className="space-y-4 lg:mx-auto lg:max-w-[960px]">
            <Hero data={data} code={code} />
            <AboveTabs data={data} code={code} />
            <FixturesSection data={data} code={code} live={live} lineups={lineups} events={events} stats={stats} onOpen={onOpenMatch} onTab={onTab} />
            <OverviewPanel data={data} code={code} />
          </div>
        )}
        {tab === "Standing" && <div className="lg:mx-auto lg:max-w-[680px]"><StandingPanel data={data} code={code} team={team} /></div>}
        {tab === "Path" && <div className="lg:mx-auto lg:max-w-[880px]"><PathPanel data={data} code={code} /></div>}
        {tab === "Squad" && <div className="lg:mx-auto lg:max-w-[900px]"><SquadPanel data={data} code={code} /></div>}
      </div>
    </Screen>
  );
}

function TeamHeader({ team, onOpenSwitcher }) {
  return (
    <button onClick={onOpenSwitcher} aria-haspopup="dialog" className="mb-1 mt-1 flex w-full items-center gap-3.5 text-left active:opacity-60">
      <Flag team={team} size={56} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1">
          <span className="truncate text-[26px] font-bold leading-tight tracking-tight">{team.name}</span>
          <IconChevronDown className="h-5 w-5 shrink-0 text-ink-3" />
        </span>
        <span className="block truncate text-[15px] text-ink-2">{nicknameLine(team)}</span>
      </span>
    </button>
  );
}

// Finish-state chip (green/amber/neutral by position).
function BandChip({ pos, label }) {
  const band = bandOf(pos);
  const tone = band === "qualified" ? "bg-qualified/10 text-qualified" : band === "bubble" ? "bg-bubble/10 text-bubble" : "bg-fill/10 text-ink-2";
  const dot = band === "qualified" ? "bg-qualified" : band === "bubble" ? "bg-bubble" : "bg-ink-3";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] font-semibold ${tone}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

function Hero({ data, code }) {
  const h = heroFor(data, code);
  const n = h.advance == null ? null : Math.round(h.advance * 100);
  const live = h.phase === "live";
  const pos = live ? h.now : h.predictedNum;
  const finishLabel = live ? (h.now != null ? ordinal(h.now) : "—") : h.predicted || "—";
  const historicalMatchCount = data.meta?.historical_match_count ?? 7871;
  const simulationCount = data.meta?.simulation_count ?? 20000;
  const contextLine = live
    ? `Live estimate from ${historicalMatchCount.toLocaleString()} historical matches and ${simulationCount.toLocaleString()} tournament simulations.`
    : `Pre-tournament estimate from ${historicalMatchCount.toLocaleString()} historical matches and ${simulationCount.toLocaleString()} tournament simulations. Updates as real results come in.`;
  return (
    <Card className="px-5 pb-6 pt-7 text-center">
      <div className="font-bold leading-none tracking-[-0.03em] tabular-nums text-ink">
        <span className="text-[64px]">{n == null ? "—" : n}</span>
        {n != null && <span className="align-top text-[34px] text-ink-2">%</span>}
      </div>
      <div className="mt-2.5 inline-flex items-center justify-center gap-1.5 text-[14px] font-medium text-ink-2">
        <span>chance to reach the knockouts</span>
        <InfoTip label="About advance chance">{NUMBER_INFO.advance}</InfoTip>
      </div>
      <p className="mx-auto mt-2 max-w-[18rem] text-[12px] leading-snug text-ink-3">{contextLine}</p>
      <p className="mx-auto mt-1.5 max-w-[18rem] text-[11px] leading-snug text-ink-3">{UPDATE_TIMING_NOTE}</p>
      <div className="rainbow-line mx-auto mt-5 h-[3px] w-28 rounded-full" />
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2 text-[13px] text-ink-2">
        <span>{live ? "now" : "predicted finish"}</span>
        <BandChip pos={pos} label={finishLabel} />
        <InfoTip label={live ? "About current position" : "About predicted finish"}>
          {live ? NUMBER_INFO.currentFinish : NUMBER_INFO.predictedFinish}
        </InfoTip>
      </div>
      {live && h.movement && (
        <div className="mt-2 text-[12px] text-ink-2">
          <span className={h.movement === "up" ? "text-qualified" : "text-bubble"}>
            {h.movement === "up" ? "▲" : "▼"} {h.movement === "up" ? "up" : "down"} from predicted {ordinal(h.predictedNum)}
          </span>
        </div>
      )}
    </Card>
  );
}

function PanelHead({ title, sub }) {
  return (
    <div>
      <h3 className="text-[17px] font-bold tracking-tight">{title}</h3>
      {sub && <p className="mt-1 text-[13px] text-ink-2">{sub}</p>}
    </div>
  );
}

// ---------- ABOVE TABS: AI summary (story) + conditional routes for bubble teams ----------
// Paired with the hero number — the number, then the "why", before the tabs.
function AboveTabs({ data, code }) {
  const narr = narrationFor(data, code);
  const scen = scenarioFor(data, code);
  const hero = heroFor(data, code);
  const isBubble = (hero.predicted === "3rd") || (scen && scen.third_place_race && scen.third_place_race.in_race);
  if (!narr && !(scen && isBubble)) return null;
  return (
    <div className="space-y-4">
      {narr && (
        <Card className="border-l-[3px] border-l-bubble/60 p-5">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-bubble/10 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-bubble">
              ✦ AI summary
            </span>
            <span className="text-[12px] italic text-ink-2">the story behind the numbers</span>
          </div>
          <h4 className="text-[16px] font-bold leading-snug tracking-tight">{narr.headline}</h4>
          <p className="mt-2 text-[14px] leading-relaxed text-ink-2">{narr.body}</p>
          <p className="mt-3 text-[12px] text-ink-3">
            AI summary of {data.meta?.model_label || "the simulation model"}’s output — it explains the numbers above, it doesn’t add data. {CARD_TIMING_NOTE}
          </p>
        </Card>
      )}
      {scen && isBubble && <RoutesCard scen={scen} />}
    </div>
  );
}

// ---------- OVERVIEW: the "how far they could go" reach grid ----------
function OverviewPanel({ data, code }) {
  const stats = reachStats(data, code);
  return (
    <Card className="p-5">
      <PanelHead title="How far they could go" sub="Simulation chances to reach each stage." />
      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-4 lg:grid-cols-3">
        {stats.map((s) => (
          <div key={s.label}>
            <div className="text-[13px] text-ink-2">{s.label}</div>
            <div className="mt-0.5 text-[24px] font-bold tabular-nums tracking-tight">{pct(s.v)}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ---------- OVERVIEW: this team's fixtures (reuses the Matches-tab card verbatim) ----------
// Lists every real fixture for the team, chronological, next match highlighted. Each row IS
// the shared MatchCard, so it inherits all states (prediction → live score → final result)
// and the same tap-through detail. Reads app-data.json + the live overlay only; never
// fabricates knockout fixtures — they appear here automatically once they exist in the export.
function FixturesSection({ data, code, live, lineups, events, stats, onOpen, onTab }) {
  const fixtures = teamFixtures(data, code);
  if (!fixtures.length) return null;

  const nextIdx = nextMatchIndex(fixtures, live);
  const hasKnockoutFx = fixtures.some(isKnockoutFixture);
  const hasUpcoming = fixtures.some((f) => matchState(f, live) !== "finished");
  // Subtle pointer to the projected route — only when it's clean: a route exists, no real
  // knockout fixtures are listed yet, and the team still has matches to play.
  const showKoPointer = !!knockoutFor(data, code) && !hasKnockoutFx && hasUpcoming && !!onTab;

  return (
    <section>
      <div className="mb-3 flex items-center justify-between px-1">
        <h3 className="text-[17px] font-bold tracking-tight">Matches</h3>
        {showKoPointer && (
          <button onClick={() => onTab("Path")} className="text-[13px] font-medium text-accent active:opacity-50">
            Knockout path →
          </button>
        )}
      </div>
      {/* Fixtures are stacked chronologically in My Team so the team's path reads top-to-bottom. */}
      <div className="space-y-3 pt-1 lg:mx-auto lg:w-[60%]">
        {fixtures.map((fx, i) => {
          const isNext = i === nextIdx;
          const isLive = matchState(fx, live) === "live";
          const dayLabel = fixtureDayLabel(fx);
          return (
            <div key={`${fx.home}-${fx.away}-${i}`}>
              {isNext && (
                <div className={`mb-1.5 flex items-center gap-1.5 px-1 text-[11px] font-bold uppercase tracking-wide ${isLive ? "text-live" : "text-accent"}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${isLive ? "animate-pulse bg-live" : "bg-accent"}`} />
                  {isLive ? "Live now" : "Next match"}
                </div>
              )}
              {/* Match date — same "Mon Jun 29" format as the Match Day day-headers (My Team has no day grouping). */}
              {dayLabel && <div className="mb-1 px-1 text-[12px] font-semibold text-ink-2">{dayLabel}</div>}
              <MatchCard
                data={data}
                fx={fx}
                live={live}
                lineups={lineups}
                events={events}
                stats={stats}
                onOpen={onOpen}
                highlight={isNext}
                predictionBarClassName="lg:mx-auto lg:w-3/4"
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}

function RoutesCard({ scen }) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <PanelHead title="Ways to advance" />
        <span
          className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${
            scen.in_their_hands ? "bg-qualified/10 text-qualified" : "bg-fill/10 text-ink-2"
          }`}
        >
          {scen.in_their_hands ? "In their hands" : "Needs help"}
        </span>
      </div>
      <ul className="mt-3 space-y-3">
        {(scen.routes || []).map((r) => (
          <li key={r.route}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[14px] font-medium">{r.route}</span>
              <span className="inline-flex shrink-0 items-center gap-1.5 text-[14px] font-bold tabular-nums">
                <span>{pct(r.chance)}</span>
                <InfoTip label={`About ${r.route}`}>{routeInfoCopy(r.route)}</InfoTip>
              </span>
            </div>
            {r.own_form && <p className="mt-0.5 text-[12px] text-ink-2">{r.own_form}</p>}
            {r.depends_on_other_groups && r.depends_on_other_groups.length > 0 && (
              <p className="mt-0.5 text-[12px] text-ink-3">depends on groups {r.depends_on_other_groups.join(", ")}</p>
            )}
          </li>
        ))}
      </ul>
      {scen.third_place_race && scen.third_place_race.in_race && (
        <p className="mt-3 border-t border-separator/50 pt-3 text-[12px] text-ink-2">
          <span className="inline-flex items-center gap-1.5">
            <span>Best-third race: {pct(scen.third_place_race.advances_if_third)} to advance if third</span>
            <InfoTip label="About best-third race">{NUMBER_INFO.ifThird}</InfoTip>
          </span>
          {scen.third_place_race.watch_groups?.length ? ` · watch groups ${scen.third_place_race.watch_groups.join(", ")}` : ""}
        </p>
      )}
    </Card>
  );
}

// ---------- STANDING: real_standings group table (phase-aware, three-band) ----------
function StandingPanel({ data, code, team }) {
  const t = groupTable(data, team.group, code);
  const bt = bestThirdInfo(data, code);
  return (
    <Card className="overflow-hidden p-0">
      <div className="px-5 pb-3 pt-4">
        <div className="flex items-center justify-between">
          <PanelHead title={`Group ${team.group}`} />
          <span className="rounded-full bg-fill/10 px-2.5 py-1 text-[11px] font-semibold text-ink-2">
            {t.phase === "live" ? "Live table" : "Predicted order"}
          </span>
        </div>
        {t.note && <p className="mt-2 text-[12px] text-ink-3">{t.note}</p>}
      </div>

      {/* column header */}
      <div className="flex items-center gap-2 px-3 pb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-3">
        <span className="w-4 text-center">#</span>
        <span className="w-[22px]" />
        <span className="w-9">Team</span>
        <span className="ml-auto flex items-center">
          {["Pl", "W", "D", "L", "GF", "GA", "GD", "Pts"].map((c) => (
            <span key={c} className={`w-[24px] text-center ${c === "Pts" ? "font-bold text-ink-2" : ""}`}>{c}</span>
          ))}
        </span>
      </div>

      <ul>
        {t.rows.map((r, i) => {
          const tm = teamByCode(data, r.code) || { code: r.code };
          const showBT = r.pos === 3 && t.phase === "live" && bt && r.focal && bt.in != null;
          return (
            <li
              key={r.code}
              className={`relative flex h-[46px] items-center gap-2 px-3 ${r.focal ? "bg-accent/[0.06]" : ""}`}
            >
              <span className={`w-4 text-center text-[13px] font-bold tabular-nums ${BAND_TEXT[r.band] || "text-ink-3"}`}>{r.pos}</span>
              <Flag team={tm} size={22} />
              <span className={`w-9 text-[13px] ${r.focal ? "font-bold" : "font-semibold"}`}>{r.code}</span>
              {showBT && (
                <span className={`text-[10px] font-bold ${bt.in ? "text-qualified" : "text-ink-3"}`}>{bt.in ? "IN" : "OUT"}</span>
              )}
              <span className="ml-auto flex items-center text-[11px] tabular-nums text-ink-2">
                {[r.played, r.won, r.drawn, r.lost, r.gf, r.ga].map((v, k) => (
                  <span key={k} className="w-[24px] text-center">{v}</span>
                ))}
                <span className="w-[24px] text-center text-ink">{r.gd > 0 ? `+${r.gd}` : r.gd}</span>
                <span className="w-[24px] text-center font-bold text-ink">{r.pts}</span>
              </span>
              {i < t.rows.length - 1 && <span className="hairline absolute bottom-0 left-[58px] right-0 h-px" />}
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 pb-4 pt-3 text-[11px] text-ink-2">
        <Legend tone="bg-qualified" label="Qualify (1st/2nd)" />
        <Legend tone="bg-bubble" label="3rd — best-third race" />
        <Legend tone="bg-ink-3" label="Out (4th)" />
      </div>
    </Card>
  );
}

function Legend({ tone, label }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${tone}`} />
      {label}
    </span>
  );
}

// ---------- PATH: knockout_paths per finish position ----------
function fmtWindow(w) {
  if (!w) return "";
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const m = String(w).match(/(\d{4})-(\d{2})-(\d{2})\s*to\s*(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(w);
  const a = `${MON[+m[2] - 1]} ${+m[3]}`;
  const b = `${MON[+m[5] - 1]} ${+m[6]}`;
  return `${a} – ${b}`;
}
function dateText(slot) {
  if (slot.date_confirmed && (slot.match_date || slot.kickoff_utc)) {
    const d = new Date(slot.kickoff_utc || slot.match_date);
    if (!Number.isNaN(d.getTime())) {
      const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      return `${MON[d.getMonth()]} ${d.getDate()}`;
    }
  }
  return fmtWindow(slot.round_window);
}

function SlotBlock({ data, slot, conditional }) {
  const opp = slot.projected_opponent;
  const oppTeam = opp ? teamByCode(data, opp.code) : null;
  return (
    <div className="rounded-[12px] bg-fill/[0.06] p-3.5">
      <div className="flex items-center justify-between text-[12px] text-ink-2">
        <span className="font-semibold uppercase tracking-wide">Round of 32{slot.match_number ? ` · Match ${slot.match_number}` : ""}</span>
        <span>{dateText(slot)}</span>
      </div>
      <div className="mt-1.5 text-[15px] font-semibold">vs {slot.opponent_slot}</div>
      {opp && (
        <div className="mt-1.5 flex items-center gap-2 text-[13px] text-ink-2">
          <span className="text-ink-3">{conditional ? "likely" : "projected"}:</span>
          {oppTeam && <Flag team={oppTeam} size={18} />}
          <span className="font-medium text-ink">{opp.name}</span>
        </div>
      )}
      {(slot.venue || slot.city) && (
        <div className="mt-1 text-[12px] text-ink-3">{[slot.venue, slot.city].filter(Boolean).join(" · ")}</div>
      )}
    </div>
  );
}

function PathRoute({ data, finishLabel, pos, slot }) {
  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center gap-2">
        <BandChip pos={pos} label={`Finish ${finishLabel}`} />
      </div>
      <SlotBlock data={data} slot={slot} />
    </Card>
  );
}

function PathPanel({ data, code }) {
  const kp = knockoutFor(data, code);
  if (!kp) {
    return (
      <Card className="p-5">
        <PanelHead title="Path to the final" sub="No knockout route is available for this team yet." />
      </Card>
    );
  }
  const bt = kp.as_best_third;
  return (
    <div className="space-y-4 lg:grid lg:grid-cols-2 lg:items-start lg:gap-4 lg:space-y-0">
      <p className="px-1 text-[13px] text-ink-2 lg:col-span-2">
        Round-of-32 route by where {kp.group ? `Group ${kp.group}` : "the group"} is finished. Dates are the round window until fixtures are confirmed.
      </p>
      {kp.as_group_winner && <PathRoute data={data} finishLabel="1st" pos={1} slot={kp.as_group_winner} />}
      {kp.as_runner_up && <PathRoute data={data} finishLabel="2nd" pos={2} slot={kp.as_runner_up} />}
      {bt && (
        <Card className="p-5">
          <div className="mb-3 flex items-center gap-2">
            <BandChip pos={3} label="Finish 3rd" />
            <span className="rounded-full bg-fill/10 px-2 py-0.5 text-[11px] font-semibold text-ink-2">conditional</span>
          </div>
          {bt.note && <p className="mb-3 text-[13px] leading-relaxed text-ink-2">{bt.note}</p>}
          <div className="space-y-3">
            {(bt.eligible_slots || []).map((s, i) => (
              <div key={i}>
                {bt.eligible_slots.length > 1 && (
                  <div className="mb-1 text-[12px] font-semibold text-ink-3">
                    If you advance — slot {i + 1} of {bt.eligible_slot_count || bt.eligible_slots.length}
                  </div>
                )}
                <SlotBlock data={data} slot={s} conditional />
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

// ---------- SQUAD: tactical_context (coach + formation); players/rank not in export yet ----------
function SquadPanel({ data, code }) {
  const tac = tacticalFor(data, code);
  return (
    <div className="space-y-4">
      <Card className="p-5">
        <PanelHead title="Setup" />
        <div className="mt-4 space-y-3">
          <Field label="Coach" value={tac && tac.coach ? tac.coach : "—"} />
          <Field
            label="Formation"
            value={
              tac && tac.formation_primary ? (
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="rounded-md bg-fill/10 px-2 py-0.5 text-[13px] font-semibold">{tac.formation_primary}</span>
                  {(tac.reported_range || []).map((f) => (
                    <span key={f} className="rounded-md bg-fill/[0.06] px-2 py-0.5 text-[12px] text-ink-2">{f}</span>
                  ))}
                </span>
              ) : (
                "—"
              )
            }
          />
        </div>
        {tac && tac.source_label && <p className="mt-4 text-[12px] text-ink-3">{tac.source_label} · context only — does not change the probabilities.</p>}
      </Card>

      <RosterCard data={data} code={code} />
    </div>
  );
}

// Real 26-player roster from squads.json (data.__squads), grouped GK/DEF/MID/FWD and rendered as a
// proper aligned TABLE. A single CSS-grid template (SQUAD_COLS) drives the column header AND every
// player row, so the columns line up exactly. The stat columns (Min/G/A/Cards) are ALWAYS present:
// they show "–" until a player has appeared, then fill IN PLACE as matches are played — so the table
// reads as complete pre-tournament rather than as an empty list. Reads squads.json only; no model data.
// Numerics (No/Age/Min/G/A/Cards) are right-aligned; Player/Club left-aligned. Missing fields show "–".
const SQUAD_COLS = "grid grid-cols-[1.5rem_minmax(0,1fr)_1.6rem_2.1rem_1rem_1rem_2.8rem] items-center gap-x-2";

function RosterCard({ data, code }) {
  const [selected, setSelected] = useState(null);
  const groups = squadGroups(data, code);
  if (!groups.length) {
    return (
      <Card className="p-5">
        <PanelHead title="Squad" sub="The roster for this team isn’t in the current export yet — it’ll appear here once published." />
      </Card>
    );
  }
  const total = groups.reduce((n, g) => n + g.players.length, 0);
  return (
    <Card className="overflow-hidden p-0">
      <div className="px-4 pb-2 pt-4">
        <PanelHead title="Squad" sub={`${total} players`} />
      </div>
      {/* column header — same grid template as the rows, so headers sit exactly over their columns */}
      <div className={`${SQUAD_COLS} border-y border-separator/50 bg-fill/[0.03] px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-3`}>
        <span className="text-right">No</span>
        <span>Player</span>
        <span className="text-right">Age</span>
        <span className="text-right">Min</span>
        <span className="text-right">G</span>
        <span className="text-right">A</span>
        <span className="text-right">Cards</span>
      </div>
      {groups.map((g) => (
        <div key={g.key}>
          {/* position-group section divider */}
          <div className="bg-fill/[0.06] px-4 py-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
            {g.label} · {g.players.length}
          </div>
          {g.players.map((p, i) => (
            <PlayerRow key={`${p.name}-${i}`} p={p} last={i === g.players.length - 1} onOpen={() => setSelected(p)} />
          ))}
        </div>
      ))}
      <p className="px-4 pb-4 pt-3 text-[11px] text-ink-3">
        Squad from the official team data — display only. Min/G/A/Cards show “–” until a player appears, then fill in as matches are played; availability flags (e.g. doubtful) show by the name when known. Tap a player for their profile.
      </p>
      {selected && <PlayerDetailCard p={selected} onClose={() => setSelected(null)} />}
    </Card>
  );
}

// One player row — uses the shared grid template so its cells line up under the header.
// `appeared` (minutes > 0) gates the stat cells: dashes before a player plays, real numbers after.
function PlayerRow({ p, last, onOpen }) {
  const s = p.status || {};
  const appeared = (s.minutes ?? 0) > 0;
  const D = "–";
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`View ${p.name} profile`}
      className={`${SQUAD_COLS} relative w-full px-4 py-2 text-left transition-colors hover:bg-fill/[0.05] active:bg-fill/[0.09] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40`}
    >
      <span className="text-right text-[13px] font-bold tabular-nums text-ink-3">{p.number ?? D}</span>
      <span className="block min-w-0">
        <span className="block truncate text-[14px] font-medium leading-tight">{p.name}</span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
          {p.availability && <AvailabilityChip a={p.availability} />}
          {p.club && <span className="truncate text-[12px] leading-tight text-ink-2">{p.club}</span>}
        </span>
      </span>
      <span className="text-right text-[12px] tabular-nums text-ink-2">{p.age ?? D}</span>
      <span className="text-right text-[12px] tabular-nums text-ink-2">{appeared ? `${s.minutes}′` : D}</span>
      <span className="text-right text-[12px] font-semibold tabular-nums text-ink">{appeared ? (s.goals ?? 0) : D}</span>
      <span className="text-right text-[12px] tabular-nums text-ink-2">{appeared ? (s.assists ?? 0) : D}</span>
      <CardsCell s={s} appeared={appeared} dash={D} />
      {!last && <span className="hairline absolute bottom-0 left-4 right-0 h-px" />}
    </button>
  );
}

// Cards column: dash until the player appears, "0" when they've played with no cards, else compact
// yellow/red counts (right-aligned to keep the column tidy).
function CardsCell({ s, appeared, dash }) {
  const y = s.yellow ?? 0, r = s.red ?? 0;
  let content;
  if (!appeared) content = <span className="text-ink-3">{dash}</span>;
  else if (!y && !r) content = <span className="text-ink-3">0</span>;
  else content = (
    <span className="flex items-center justify-end gap-1">
      {y > 0 && <span title="yellow cards">🟨{y}</span>}
      {r > 0 && <span title="red cards">🟥{r}</span>}
    </span>
  );
  return <span className="text-right text-[11px] tabular-nums">{content}</span>;
}

// Availability / injury chip — shown only when a player has a non-"available" flag in squads.json
// (from player_status_events). Pending (unreviewed) seeds render muted; confirmed render amber. The
// tooltip carries severity + whether it's confirmed. Available players (no flag) stay clean (no chip).
function AvailabilityChip({ a }) {
  if (!a || !a.status || a.status === "available") return null;
  const label = { out: "Out", doubtful: "Doubtful", suspended: "Suspended" }[a.status] || "Doubtful";
  const pending = a.review_status === "pending";
  // Color signals severity of the signal: RED (live token) = confirmed/vetted injury, suspension or out;
  // AMBER (bubble token) = pending/unconfirmed. Both use existing semantic tokens (dark-mode safe).
  const tone = pending ? "bg-bubble/15 text-bubble" : "bg-live/15 text-live";
  const title = `${label}${a.severity ? ` (${a.severity})` : ""}${a.expected_return ? ` · back ${a.expected_return}` : ""}${pending ? " — pending review (unconfirmed)" : " — confirmed"}`;
  return (
    <span title={title} className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${tone}`}>
      <span className="h-1 w-1 rounded-full bg-current opacity-70" />
      {label}
    </span>
  );
}

// ---------- Player detail card (Phase 2) — tap a PlayerRow -> photo + bio + live WC stats. ----------
// Renders ENTIRELY from the squads.json player object already in scope: photo (derived URL) + dob / nationality /
// height_cm / weight_kg / birth_place / birth_country (from the bio backfill) + existing name/position/number/
// club/age/status/availability. Show-only-when-present: any null bio field is omitted (never blank/—). WC stats
// show "–" until the player appears (same rule as the squad table). NO career caps (data is unreliable).
// Reuses the app's GOLD treatment (.next-match-card ring/glow + --glass-gold-surface). Portaled to <body> so it
// overlays the whole screen regardless of mount depth; Esc / backdrop / Done all close. Additive — the squad table
// is untouched (the row is just tappable now).
const PLAYER_MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatDob(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  return m ? `${parseInt(m[3], 10)} ${PLAYER_MON[parseInt(m[2], 10) - 1]} ${m[1]}` : null;
}

function PlayerAvatar({ photo, name }) {
  const [broken, setBroken] = useState(false);
  const initials = (name || "").split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
  const ring = { boxShadow: "0 0 0 3px rgba(255,255,255,0.92), 0 6px 16px rgba(74,52,8,0.40)" };
  if (!photo || broken) {
    return <div style={ring} className="flex h-24 w-24 items-center justify-center rounded-full bg-fill/15 text-[26px] font-bold text-ink-2">{initials || "?"}</div>;
  }
  return <img src={photo} alt={name} onError={() => setBroken(true)} style={ring} className="h-24 w-24 rounded-full bg-fill/10 object-cover" />;
}

function PlayerStat({ label, value }) {
  return (
    <div className="flex flex-col items-center rounded-xl bg-fill/[0.05] py-2">
      <span className="text-[16px] font-bold tabular-nums text-ink">{value}</span>
      <span className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-3">{label}</span>
    </div>
  );
}

function PlayerBioRow({ label, value }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-separator/40 pb-2.5">
      <span className="shrink-0 text-[12px] font-semibold uppercase tracking-wide text-ink-3">{label}</span>
      <span className="text-right text-[14px] font-medium text-ink">{value}</span>
    </div>
  );
}

function PlayerDetailCard({ p, onClose }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    setShown(true);
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  const s = p.status || {};
  const appeared = (s.minutes ?? 0) > 0;
  const D = "–";
  const dob = formatDob(p.dob);
  const birthplace = [p.birth_place, p.birth_country].filter(Boolean).join(", ");
  const born = [p.age != null ? `${p.age}` : null, dob ? `born ${dob}` : null, birthplace || null].filter(Boolean).join(" · ");
  const physical = [p.height_cm ? `${p.height_cm}cm` : null, p.weight_kg ? `${p.weight_kg}kg` : null].filter(Boolean).join(" · ");
  const y = s.yellow ?? 0, r = s.red ?? 0;
  const cards = !appeared ? D : (!y && !r ? "0" : [y ? `🟨${y}` : null, r ? `🟥${r}` : null].filter(Boolean).join(" "));

  return createPortal(
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={`${p.name} profile`}>
      <div onClick={onClose} className={`absolute inset-0 bg-black/40 transition-opacity duration-200 lg:bg-black/60 lg:backdrop-blur-sm ${shown ? "opacity-100" : "opacity-0"}`} />
      <div className={`next-match-card absolute inset-x-0 bottom-0 flex max-h-[88%] flex-col overflow-hidden rounded-t-[20px] bg-surface shadow-2xl transition-opacity duration-200 lg:inset-x-auto lg:bottom-auto lg:left-1/2 lg:top-1/2 lg:max-h-[86vh] lg:w-[420px] lg:max-w-[92vw] lg:-translate-x-1/2 lg:-translate-y-1/2 lg:rounded-[22px] ${shown ? "opacity-100" : "opacity-0"}`}>
        <div className="flex justify-center pt-2.5 lg:hidden"><span className="h-1.5 w-9 rounded-full bg-fill/30" /></div>
        <div className="flex items-center justify-end px-4 pb-1 pt-1">
          <button onClick={onClose} className="text-[15px] font-medium text-accent active:opacity-50">Done</button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[max(20px,env(safe-area-inset-bottom))]">
          {/* GOLD header — real gold-foil texture (always bright), so header text is FIXED-DARK in both themes. */}
          <div className="flex flex-col items-center px-5 pb-5 pt-2" style={{ backgroundImage: `url(${goldTexture})`, backgroundSize: "cover", backgroundPosition: "center" }}>
            <PlayerAvatar photo={p.photo} name={p.name} />
            <div className="mt-3 flex items-center justify-center gap-2">
              {p.number != null && <span className="text-[13px] font-bold tabular-nums text-[#6e5214]">#{p.number}</span>}
              <h2 className="text-center text-[20px] font-bold leading-tight text-[#3a2906] [text-shadow:0_1px_0_rgba(255,248,220,0.55)]">{p.name}</h2>
            </div>
            {p.position && <div className="mt-0.5 text-[13px] font-semibold text-[#6e5214]">{p.position}</div>}
            {p.availability && <div className="mt-2"><AvailabilityChip a={p.availability} /></div>}
          </div>
          {/* BIO — show only when present */}
          {(born || p.nationality || p.club || physical) && (
            <div className="space-y-2.5 px-5 pt-4">
              {born && <PlayerBioRow label="Age" value={born} />}
              {p.nationality && <PlayerBioRow label="Nationality" value={p.nationality} />}
              {p.club && <PlayerBioRow label="Club" value={p.club} />}
              {physical && <PlayerBioRow label="Physical" value={physical} />}
            </div>
          )}
          {/* THIS TOURNAMENT — fills as matches are played */}
          <div className="px-5 pb-5 pt-5">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">This tournament</div>
            <div className="grid grid-cols-4 gap-2">
              <PlayerStat label="Min" value={appeared ? `${s.minutes}′` : D} />
              <PlayerStat label="Goals" value={appeared ? (s.goals ?? 0) : D} />
              <PlayerStat label="Assists" value={appeared ? (s.assists ?? 0) : D} />
              <PlayerStat label="Cards" value={cards} />
            </div>
            <p className="mt-3 text-[11px] text-ink-3">Match stats show “–” until this player appears, then fill in as matches are played.</p>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

function Field({ label, value }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-[13px] text-ink-2">{label}</span>
      <span className="text-right text-[14px] font-medium">{value}</span>
    </div>
  );
}
