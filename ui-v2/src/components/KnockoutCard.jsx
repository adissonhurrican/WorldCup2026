import { Flag } from "./ui";
import PredictionBar from "./PredictionBar";
import {
  teamByCode, dualClock, weatherFor, isImminent, weatherEmoji, weatherConfidence, cToF, favorite, pct,
} from "../lib/select";

// Knockout-stage match card (R32 → Final). Full parity with the group MatchCard, but the two "team" positions
// are BRACKET SLOTS ("Winner Group A", "Best 3rd from G/H/J/L", "Winner M74") until the post-group resolver
// fills real teams. DATES are schedule-fixed and KNOWN: exact date/time where the schedule has it (QF onward),
// else the real round date-window (R32/R16 have no per-match date in knockout_schedule yet — a data gap to fill;
// NEVER imply the date depends on results). Forward-compatible: when a side's `team` (and fx.probabilities) are
// filled, the card shows the real flag+name + prediction bar automatically. Weather attaches once the match is
// within the 168h window (empty for now — expected). Clicking opens the same MatchSheet group cards use.
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

export default function KnockoutCard({ data, fx, onOpen }) {
  const wx = weatherFor(data, fx);
  const wxConf = weatherConfidence(wx);
  const showChip = wx && isImminent(fx); // knockouts are weeks out -> empty until they enter the 168h window
  const dc = dualClock(fx);
  const resolved = !!fx.probabilities; // forward-compat: real prediction once teams + probabilities are filled
  const p = fx.probabilities || {};
  const fav = resolved ? favorite(fx) : null;

  return (
    <button
      onClick={() => onOpen && onOpen(fx)}
      className="card relative w-full overflow-hidden p-0 text-left transition active:scale-[0.99]"
    >
      {/* gold bracket strip (no team colours until teams resolve) */}
      <span className="absolute inset-x-0 top-0 h-[3px]" style={{ background: "linear-gradient(90deg, rgba(214,157,46,0.9), rgba(126,82,10,0.55))" }} />

      <div className="relative p-4">
        <div className="flex items-start justify-between gap-2 text-[12px] text-ink-2">
          <span className="min-w-0 truncate">{fx.venue || "Venue TBC"}{fx.city ? ` · ${fx.city}` : ""}</span>
          <span className="flex shrink-0 items-start gap-1.5">
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

        <div className="mt-3 flex items-center gap-2">
          <SlotSide data={data} side={fx.side_a} align="right" />
          <span className="w-8 shrink-0 text-center text-[13px] font-semibold text-ink-3">v</span>
          <SlotSide data={data} side={fx.side_b} align="left" />
        </div>

        {/* date — real where known, else the real round date-window (never tied to results) */}
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

        {/* prediction — real bar once teams are confirmed, else a clean explicit state (no empty/grey bar) */}
        {resolved ? (
          <>
            <PredictionBar data={data} fx={fx} heightClass="h-1" className="mt-3" />
            <div className="mt-1.5 text-center text-[11px] text-ink-3">
              <span className={fav.k === "home" ? "font-semibold text-ink-2" : ""}>{fx.home} {pct(p.home_win)}</span>
              {" · "}
              <span className={fav.k === "draw" ? "font-semibold text-ink-2" : ""}>draw {pct(p.draw)}</span>
              {" · "}
              <span className={fav.k === "away" ? "font-semibold text-ink-2" : ""}>{fx.away} {pct(p.away_win)}</span>
            </div>
          </>
        ) : (
          <div className="mt-3 text-center text-[11px] text-ink-3">Prediction once teams are confirmed</div>
        )}
      </div>
    </button>
  );
}

// One bracket slot. Forward-compatible: real flag+name once `side.team` ({code,name,flag}) is filled by the
// resolver; otherwise the slot label (e.g. "Winner Group E", "Best 3rd from A/B/C/D/F", "Winner M74").
function SlotSide({ data, side, align }) {
  const s = side || {};
  const team = s.team ? (teamByCode(data, s.team.code) || s.team) : null;
  if (team) {
    return (
      <span className={`flex min-w-0 flex-1 items-center gap-2 ${align === "right" ? "justify-end" : ""}`}>
        {align === "right" && <span className="truncate text-[15px] font-semibold">{team.name || team.code}</span>}
        <Flag team={team} size={26} />
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
