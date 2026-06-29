import { Flag } from "./ui";
import PredictionBar from "./PredictionBar";
import { MatchEventSummary, XgInfo } from "./MatchCard";
import {
  teamByCode, dualClock, weatherFor, isImminent, weatherEmoji, weatherConfidence, cToF, favorite, pct,
  matchState, liveOf, scoreOf, eventsOf, lineupState, statsOf, knockoutNarrationFor,
} from "../lib/select";

// Knockout-stage match card (R32 → Final). Full parity with the group MatchCard: the two "team" positions are
// BRACKET SLOTS ("Winner Group A", "Best 3rd from G/H/J/L", "Winner M74") until the post-group resolver fills real
// teams, then they show real flags + names, the prediction, and — once the match plays — the SCORE inline:
//   live   → the live score + minute (text-live), goal/card events
//   final  → the final score, with the loser dimmed and an "X advance" line (penalty-aware: "· 4–3 pens")
//   upcoming → the prediction + the schedule date (no result)
// The live/score helpers (matchState/liveOf/scoreOf/eventsOf) key off home/away + the normalized result that
// loadAll's realKnockoutFixture() fills in, so this is the SAME code path the group MatchCard uses. DATES are
// schedule-fixed and KNOWN (only the teams depend on results — never imply the date does). Clicking opens the
// same MatchSheet group cards use.
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function fmtDateOnly(s) {
  if (!s) return null;
  const [y, m, d] = String(s).split("-").map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(dt.getTime())) return null;
  return `${WD[dt.getUTCDay()]} ${MON[m - 1]} ${d}`;
}

export default function KnockoutCard({ data, fx, live, lineups, events, stats, onOpen, cardRef = null }) {
  const state = matchState(fx, live);
  const lv = liveOf(fx, live);
  const ev = eventsOf(fx, events);
  const ls = lineupState(fx, lineups, live); // confirmed XI / ~60-min placeholder (same as the group card)
  const st = statsOf(fx, stats);             // live xG (same descriptive in-play stat as the group card)
  const isLive = state === "live";
  const finished = state === "finished";
  const sc = scoreOf(fx);
  const wx = weatherFor(data, fx);
  const wxConf = weatherConfidence(wx);
  const showChip = wx && isImminent(fx); // knockouts are weeks out -> empty until they enter the 168h window
  const dc = dualClock(fx);
  const resolved = !!fx.probabilities; // real prediction once teams + probabilities are filled
  const p = fx.probabilities || {};
  const fav = resolved ? favorite(fx) : null;
  // advancer (knockout-specific): who goes through — penalty-aware (the normalized result carries winner_code + pens).
  const r = fx.result || {};
  const winnerCode = finished ? (r.winner_code ?? null) : null;
  const winnerName = winnerCode ? ((teamByCode(data, winnerCode) || {}).name || winnerCode) : null;
  const pensHome = r.pens_home, pensAway = r.pens_away;
  const wentToPens = finished && pensHome != null && pensAway != null;
  const aCode = fx.side_a?.team?.code ?? null;
  const bCode = fx.side_b?.team?.code ?? null;
  // knockout matchup story (display only) — the AI preview/story for this tie, matched by fixture_label. Only once
  // both teams are real (an unresolved slot has no narration). A light teaser here; the full text lives in the sheet.
  const story = aCode && bCode ? knockoutNarrationFor(data, fx, finished) : null;

  return (
    <button
      ref={cardRef}
      onClick={() => onOpen && onOpen(fx)}
      className="card relative w-full overflow-hidden p-0 text-left transition active:scale-[0.99]"
    >
      {/* gold bracket strip (no team colours until teams resolve) */}
      <span className="absolute inset-x-0 top-0 h-[3px]" style={{ background: "linear-gradient(90deg, rgba(214,157,46,0.9), rgba(126,82,10,0.55))" }} />

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
              <span className="flex flex-col items-end gap-0.5 leading-tight">
                <span className="text-[9px] font-semibold uppercase tracking-wide text-ink-3">Weather forecast</span>
                <span title={wxConf ? wxConf.label : "Forecast"} className={`inline-flex items-center gap-1 rounded-full bg-fill/10 px-2 py-0.5 text-[12px] font-semibold text-ink ${wxConf?.muted ? "opacity-60" : ""}`}>
                  {weatherEmoji(wx.condition, wx.code)} {wx.temp_c != null ? `${Math.round(wx.temp_c)}°C/${cToF(wx.temp_c)}°F` : ""}
                </span>
              </span>
            ) : (
              <span className="rounded-full bg-fill/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ink-3">
                {fx.round}{fx.match_number ? ` · M${fx.match_number}` : ""}
              </span>
            )}
          </span>
        </div>

        {/* teams + score (slots until resolved). Live → live score; final → final score with the loser dimmed. */}
        <div className="mt-3 flex items-center gap-2">
          <SlotSide data={data} side={fx.side_a} align="right" lose={finished && winnerCode != null && winnerCode !== aCode} />
          <span className={`w-12 shrink-0 text-center text-[16px] font-bold tabular-nums ${isLive ? "text-live" : "text-ink-2"}`}>
            {isLive ? `${lv.home_score ?? 0}–${lv.away_score ?? 0}` : finished ? `${sc.h ?? "-"}–${sc.a ?? "-"}` : "v"}
          </span>
          <SlotSide data={data} side={fx.side_b} align="left" lose={finished && winnerCode != null && winnerCode !== bCode} />
        </div>

        {/* goal/card events (live or final) — same summary the group card uses */}
        <MatchEventSummary fx={fx} match={ev} />

        {/* live xG — DESCRIPTIVE in-play stat, IDENTICAL to the group MatchCard: shown only while live and only
            once the provider posts statistics (st keys off home/away, which the resolved knockout fixture carries). */}
        {isLive && st && (st.home_xg != null || st.away_xg != null) && (
          <div className="relative mt-2 flex items-center justify-center gap-1.5 text-[11px] text-ink-3">
            <span className="rounded-full bg-fill/10 px-2 py-0.5 font-semibold uppercase tracking-wide text-[9px]">Live xG</span>
            <span className="tabular-nums font-medium text-ink-2">
              {st.home_xg != null ? st.home_xg.toFixed(1) : "—"} – {st.away_xg != null ? st.away_xg.toFixed(1) : "—"}
            </span>
            <XgInfo />
          </div>
        )}

        {/* status / advancer for live + finished; upcoming shows the schedule date below instead */}
        {(isLive || finished) && (
          <div className={`mt-2 text-center text-[12px] ${isLive ? "font-semibold text-live" : "text-ink-2"}`}>
            {isLive
              ? `In play${lv && lv.minute != null ? ` · ${lv.minute}${lv.extra ? `+${lv.extra}` : ""}'` : ""}`
              : winnerName
                ? <><span className="font-semibold text-ink">{winnerName}</span> advance{wentToPens ? ` · ${pensHome}–${pensAway} pens` : ""}</>
                : "Full-time"}
          </div>
        )}

        {/* date — only before kickoff (live/finished show the status line above). Never tied to results. */}
        {!isLive && !finished && (
          <div className="mt-3 text-center text-[12px] text-ink-2">
            {fx.kickoff_utc ? (
              <>{fmtDateOnly(fx.kickoff) || ""}{dc.viewer ? ` · ${dc.viewer} your time` : ""}</>
            ) : fx.kickoff ? (
              fmtDateOnly(fx.kickoff)
            ) : fx.round_window_label ? (
              fx.round_window_label
            ) : (
              "Date TBC"
            )}
          </div>
        )}

        {/* prediction — real bar once teams are confirmed (no "draw" for knockouts); else a clean explicit state */}
        {resolved ? (
          <>
            <PredictionBar data={data} fx={fx} heightClass="h-1" className="mt-3" />
            <div className="mt-1.5 text-center text-[11px] text-ink-3">
              {finished ? (
                <>we predicted <span className="font-semibold text-ink-2">{fav.k === "home" ? fx.home : fav.k === "away" ? fx.away : "Draw"} {pct(fav.v)}</span></>
              ) : (
                <>
                  <span className={fav.k === "home" ? "font-semibold text-ink-2" : ""}>{fx.home} {pct(p.home_win)}</span>
                  {" · "}
                  <span className={fav.k === "away" ? "font-semibold text-ink-2" : ""}>{fx.away} {pct(p.away_win)}</span>
                </>
              )}
            </div>
          </>
        ) : (
          <div className="mt-3 text-center text-[11px] text-ink-3">Prediction once teams are confirmed</div>
        )}

        {/* lineups: confirmed XI once stored, else the ~60-min placeholder — same as the group card. Only once
            BOTH knockout teams are real (an unresolved slot has no teams, so no lineup line until then). */}
        {aCode && bCode && (
          ls.has ? (
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
          ) : null
        )}

        {/* knockout narration teaser — the hook line only; tap the card for the full preview/story (MatchSheet → KnockoutStory) */}
        {story && story.headline && (
          <div className="mt-3 border-t border-separator/50 pt-2.5">
            <span className="inline-flex items-center gap-1 rounded-full bg-bubble/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-bubble">
              ✦ {story.kind === "post_result_change" ? "The story" : "Match preview"}
            </span>
            <p
              className="mt-1.5 text-[12px] leading-snug text-ink-2"
              style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}
            >
              {story.headline}
            </p>
          </div>
        )}
      </div>
    </button>
  );
}

// One bracket slot. Forward-compatible: real flag+name once `side.team` ({code,name,flag}) is filled by the
// resolver; otherwise the slot label (e.g. "Winner Group E", "Best 3rd from A/B/C/D/F", "Winner M74"). On a
// finished knockout the eliminated side is dimmed (`lose`) so the advancer reads clearly.
function SlotSide({ data, side, align, lose = false }) {
  const s = side || {};
  const team = s.team ? (teamByCode(data, s.team.code) || s.team) : null;
  if (team) {
    return (
      <span className={`flex min-w-0 flex-1 items-center gap-2 ${align === "right" ? "justify-end" : ""} ${lose ? "opacity-45" : ""}`}>
        {align === "right" && <span className="truncate text-[15px] font-semibold">{team.name || team.code}</span>}
        <Flag team={team} size={26} className={lose ? "grayscale" : ""} />
        {align === "left" && <span className="truncate text-[15px] font-semibold">{team.name || team.code}</span>}
      </span>
    );
  }
  return (
    <span className={`min-w-0 flex-1 text-[13px] font-medium leading-snug text-ink ${align === "right" ? "text-right" : "text-left"}`}>
      {s.label || "TBD"}
    </span>
  );
}
