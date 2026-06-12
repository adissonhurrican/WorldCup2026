import { useEffect, useRef, useState } from "react";
import { Flag } from "./ui";
import PredictionBar from "./PredictionBar";
import {
  teamByCode, matchState, scoreOf, favorite, pct,
  dualClock, teamTint, weatherFor, isImminent, weatherEmoji, weatherConfidence, cToF, liveOf, lineupState, eventsOf, statsOf,
} from "../lib/select";

// Shared match card — the SINGLE source of card rendering, used by both the Matches
// tab and the My Team fixtures list, so every card is visually identical and inherits
// the same states. Everything is read straight from the fixture (prediction, dual
// clock, verified final score) plus the display-only live overlay (same `live` map +
// orientation-normalized lookup as the Matches tab). `highlight` (optional) draws a
// subtle accent ring for a featured row (e.g. the next match) — it changes no content.
export default function MatchCard({ data, fx, live, lineups, events, stats, onOpen, highlight = false, predictionBarClassName = "" }) {
  const state = matchState(fx, live);
  const lv = liveOf(fx, live);
  const ls = lineupState(fx, lineups, live);
  const ev = eventsOf(fx, events);
  const st = statsOf(fx, stats);
  const finished = state === "finished";
  const isLive = state === "live";
  const sc = scoreOf(fx);
  const home = teamByCode(data, fx.home) || { code: fx.home };
  const away = teamByCode(data, fx.away) || { code: fx.away };
  const p = fx.probabilities || {};
  const fav = favorite(fx);
  const favName = fav.k === "draw" ? "Draw" : fav.k === "home" ? fx.home : fx.away;
  const dc = dualClock(fx);
  const ht = teamTint(fx.home);
  const at = teamTint(fx.away);
  const wx = weatherFor(data, fx);
  const wxConf = weatherConfidence(wx);
  const showChip = wx && isImminent(fx);

  return (
    <button
      onClick={() => onOpen(fx)}
      className={`card relative w-full overflow-hidden p-0 text-left transition active:scale-[0.99] ${highlight ? "next-match-card" : ""}`}
    >
      {/* two-team color signal: crisp top strip + whisper wash */}
      <span className="absolute inset-x-0 top-0 h-[3px]" style={{ background: `linear-gradient(90deg, ${ht}, ${at})` }} />
      <span className="pointer-events-none absolute inset-0 opacity-[0.05]" style={{ background: `linear-gradient(135deg, ${ht}, ${at})` }} />

      <div className="relative p-4">
        <div className="flex items-start justify-between gap-2 text-[12px] text-ink-2">
          <span className="min-w-0 truncate">{fx.venue || "Venue TBC"}{fx.city ? ` · ${fx.city}` : ""}</span>
          <span className="flex shrink-0 items-start gap-1.5">
            {isLive && (
              <span className="inline-flex items-center gap-1 rounded-full bg-live/10 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-live">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-live" />
                Live{lv && lv.minute != null ? ` ${lv.minute}${lv.extra ? `+${lv.extra}` : ""}'` : ""}
              </span>
            )}
            {showChip ? (
              // weather forecast — a small "Weather forecast" caption above the temp chip; the chip is
              // muted the further out the forecast is (low confidence), per weatherConfidence.
              <span className="flex flex-col items-end gap-0.5 leading-tight">
                <span className="text-[9px] font-semibold uppercase tracking-wide text-ink-3">Weather forecast</span>
                <span title={wxConf ? wxConf.label : "Forecast"} className={`inline-flex items-center gap-1 rounded-full bg-fill/10 px-2 py-0.5 text-[12px] font-semibold text-ink ${wxConf?.muted ? "opacity-60" : ""}`}>
                  {weatherEmoji(wx.condition, wx.code)} {wx.temp_c != null ? `${Math.round(wx.temp_c)}°C/${cToF(wx.temp_c)}°F` : ""}
                </span>
              </span>
            ) : null}
          </span>
        </div>

        <div className="mt-2.5 flex items-center gap-2">
          <span className="flex min-w-0 flex-1 items-center justify-end gap-2">
            <span className="truncate text-[15px] font-semibold">{home.name || fx.home}</span>
            <Flag team={home} size={26} />
          </span>
          <span className={`w-12 shrink-0 text-center text-[16px] font-bold tabular-nums ${isLive ? "text-live" : "text-ink-2"}`}>
            {isLive ? `${lv.home_score ?? 0}–${lv.away_score ?? 0}` : finished ? `${sc.h ?? "-"}–${sc.a ?? "-"}` : "v"}
          </span>
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <Flag team={away} size={26} />
            <span className="truncate text-[15px] font-semibold">{away.name || fx.away}</span>
          </span>
        </div>

        <MatchEventSummary fx={fx} match={ev} />

        {/* live xG — DESCRIPTIVE match stat (what's happening on the pitch), shown only while in play and
            only once the provider posts statistics. Lives in the live-stats area with the score/events,
            deliberately separate from the prediction bar below (the forecast). */}
        {isLive && st && (st.home_xg != null || st.away_xg != null) && (
          // `relative` is load-bearing: the (i) popover anchors to this full-width row (not the tiny
          // icon), so it spans the card's content width and the card's overflow-hidden never clips it.
          <div className="relative mt-2 flex items-center justify-center gap-1.5 text-[11px] text-ink-3">
            <span className="rounded-full bg-fill/10 px-2 py-0.5 font-semibold uppercase tracking-wide text-[9px]">Live xG</span>
            <span className="tabular-nums font-medium text-ink-2">
              {st.home_xg != null ? st.home_xg.toFixed(1) : "—"} – {st.away_xg != null ? st.away_xg.toFixed(1) : "—"}
            </span>
            <XgInfo />
          </div>
        )}

        {/* dual clock / status */}
        <div className={`mt-2 text-center text-[12px] ${isLive ? "font-semibold text-live" : "text-ink-2"}`}>
          {isLive
            ? `In play${lv && lv.minute != null ? ` · ${lv.minute}${lv.extra ? `+${lv.extra}` : ""}'` : ""}`
            : finished
              ? "Full-time"
              : dc.venue && !dc.sameZone
                ? <ScheduledTime dc={dc} city={fx.city || "venue"} />
                : dc.viewer
                  ? <ScheduledTime dc={dc} />
                  : "Time TBC"}
        </div>

        {/* prediction color only; widths remain the stored W/D/L probabilities */}
        <PredictionBar data={data} fx={fx} heightClass="h-1" className={`mt-3 ${predictionBarClassName}`} />
        <div className="mt-1.5 text-center text-[11px] text-ink-3">
          {finished ? (
            <>we predicted <span className="font-semibold text-ink-2">{favName} {pct(fav.v)}</span></>
          ) : (
            <>
              <span className={fav.k === "home" ? "font-semibold text-ink-2" : ""}>{fx.home} {pct(p.home_win)}</span>
              {" · "}
              <span className={fav.k === "draw" ? "font-semibold text-ink-2" : ""}>draw {pct(p.draw)}</span>
              {" · "}
              <span className={fav.k === "away" ? "font-semibold text-ink-2" : ""}>{fx.away} {pct(p.away_win)}</span>
            </>
          )}
        </div>

        {/* lineups: confirmed XI (formations) once stored; otherwise the ~60-min placeholder near kickoff */}
        {ls.has ? (
          <div className="mt-2 flex items-center justify-center gap-1.5 text-[11px] text-ink-3">
            <span className="inline-flex items-center gap-1 rounded-full bg-qualified/10 px-2 py-0.5 font-semibold text-qualified">
              <span className="h-1.5 w-1.5 rounded-full bg-qualified" /> Starting XI
            </span>
            {(ls.lineup?.home_lineup?.formation || ls.lineup?.away_lineup?.formation) && (
              <span className="tabular-nums">
                {ls.lineup?.home_lineup?.formation || "—"} v {ls.lineup?.away_lineup?.formation || "—"}
              </span>
            )}
          </div>
        ) : ls.showPlaceholder ? (
          <div className="mt-2 text-center text-[11px] text-ink-3">Lineups ~60 min before kickoff</div>
        ) : null}
      </div>
    </button>
  );
}

// (i) explainer for the live xG row. Mirrors the shared InfoTip look/behavior (tap-first toggle,
// stopPropagation so a tap never opens the match sheet) but renders a span[role=button] because the
// whole card is already a <button> (nested buttons are invalid HTML). Dismisses on tap-away via a
// document listener. The popover opens ABOVE the row so the card's overflow-hidden never clips it.
function XgInfo() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [open]);
  const toggle = (e) => { e.stopPropagation(); e.preventDefault(); setOpen((v) => !v); };
  return (
    // NOT `relative`: the popover positions against the xG row (the nearest positioned ancestor),
    // spanning the card's content width — a fixed-width box anchored to the icon clips at the card edge.
    <span ref={ref} className="inline-flex shrink-0 align-middle">
      <span
        role="button"
        tabIndex={0}
        aria-label="What is xG?"
        aria-expanded={open}
        onClick={toggle}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") toggle(e); }}
        className="inline-grid h-5 w-5 cursor-pointer place-items-center rounded-full bg-fill/10 text-[11px] font-bold leading-none text-ink-2 ring-1 ring-separator/70 transition hover:bg-fill/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 active:scale-95"
      >
        i
      </span>
      {open && (
        <span
          role="tooltip"
          className="pointer-events-none absolute inset-x-0 bottom-[calc(100%+0.4rem)] z-50 rounded-[12px] bg-bg/95 px-3 py-2 text-left text-[12px] font-medium normal-case leading-snug tracking-normal text-ink-2 shadow-[0_12px_30px_rgba(0,0,0,0.20)] ring-1 ring-separator/70 backdrop-blur-xl"
        >
          Expected Goals (xG) measures the quality of scoring chances. Each shot is rated by how likely it was
          to score (distance, angle, and more). Higher xG means better chances created — a team can “win the
          xG” even if the score doesn’t show it yet.
        </span>
      )}
    </span>
  );
}

function ScheduledTime({ dc, city = null }) {
  const showVenue = !!(city && dc.venue);
  const show24 = !!(dc.viewer24 || dc.venue24);

  return (
    <span className="inline-flex max-w-full flex-col items-center justify-center gap-0.5 leading-tight">
      <span className="inline-flex max-w-full flex-wrap items-center justify-center gap-x-1.5">
        {showVenue && <span className="whitespace-nowrap">{dc.venue} {city}</span>}
        {showVenue && dc.viewer && <span className="text-ink-3">·</span>}
        {dc.viewer && <span className="whitespace-nowrap">{dc.viewer} your time</span>}
      </span>
      {show24 && (
        <span className="inline-flex max-w-full flex-wrap items-center justify-center gap-x-1.5 text-[11px] text-ink-3">
          {showVenue && dc.venue24 && <span className="whitespace-nowrap">{dc.venue24} {city}</span>}
          {showVenue && dc.venue24 && dc.viewer24 && <span>·</span>}
          {dc.viewer24 && <span className="whitespace-nowrap">{dc.viewer24} your time</span>}
          {dc.dateDiffers && dc.viewerDate?.label && (
            <span className="rounded-full bg-fill/10 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-ink-3">
              {dc.viewerDate.label} your date
            </span>
          )}
        </span>
      )}
    </span>
  );
}

function MatchEventSummary({ fx, match }) {
  const items = (match && Array.isArray(match.events) ? match.events : []).slice().sort(eventSort);
  if (!items.length) return null;
  const homeItems = items.filter((ev) => ev.team === fx.home);
  const awayItems = items.filter((ev) => ev.team === fx.away);
  return (
    <div className="mt-2 grid grid-cols-[minmax(0,1fr)_3rem_minmax(0,1fr)] gap-2">
      <TeamEventList items={homeItems} align="right" />
      <span aria-hidden="true" />
      <TeamEventList items={awayItems} align="left" />
    </div>
  );
}

function TeamEventList({ items, align }) {
  if (!items.length) return <span aria-hidden="true" />;
  return (
    <ol className={`min-w-0 space-y-1 ${align === "right" ? "text-right" : "text-left"}`}>
      {items.map((ev, i) => <CompactEvent key={`${ev.kind}-${ev.minute}-${ev.extra}-${ev.player?.api_player_id ?? ev.player?.name}-${i}`} ev={ev} align={align} />)}
    </ol>
  );
}

function CompactEvent({ ev, align }) {
  const meta = eventMeta(ev);
  const minute = ev.display_minute || "—";
  const marker = (
    <span className="shrink-0 text-[11px] font-semibold tabular-nums text-ink-3">
      {meta.icon} {minute}
    </span>
  );
  const label = <span className="min-w-0 truncate text-[11px] font-medium text-ink-2">{meta.label}</span>;
  return (
    <li className={`flex min-w-0 items-center gap-1.5 ${align === "right" ? "justify-end" : "justify-start"}`}>
      {align === "right" ? <>{label}{marker}</> : <>{marker}{label}</>}
    </li>
  );
}

function eventSort(a, b) {
  return (a.minute ?? 999) - (b.minute ?? 999) || (a.extra ?? 0) - (b.extra ?? 0);
}

function eventMeta(ev) {
  if (ev.kind === "goal") return { icon: "⚽", label: ev.player?.name || "Unknown player" };
  if (ev.kind === "substitution") {
    const off = ev.player_off?.name || "Player off";
    const on = ev.player_on?.name || "Player on";
    return { icon: "🔄", label: `${off} → ${on}` };
  }
  if (ev.card === "second_yellow") return { icon: "🟨🟥", label: ev.player?.name || "Unknown player" };
  if (ev.card === "red") return { icon: "🟥", label: ev.player?.name || "Unknown player" };
  return { icon: "🟨", label: ev.player?.name || "Unknown player" };
}
