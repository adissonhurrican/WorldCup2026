import { useState } from "react";
import { Flag, SegmentedTabs } from "./ui";
import PredictionBar from "./PredictionBar";
import LineupPitchSheet from "./LineupPitchSheet";
import { IconChevronRight } from "./icons";
import {
  teamByCode, dualClock, weatherFor, venueFactsFor, venueProfileFor, isImminent, weatherEmoji, weatherConfidence, cToF, tempCF, pct, favorite, scoreOf, matchState, liveOf, lineupState, eventsOf, VIEWER_TZ,
} from "../lib/select";

// Match detail bottom sheet — two tabs inside the sheet: Info (kickoff, venue, prediction, weather,
// score) and Lineups (the XI, or the ~60-min placeholder). Display only; reads JSON only.
export default function MatchSheet({ data, fx, live, lineups, events, onClose }) {
  const open = !!fx;
  return (
    <div className={`absolute inset-0 z-50 ${open ? "" : "pointer-events-none"}`} aria-hidden={!open}>
      <div
        onClick={onClose}
        className={`absolute inset-0 bg-black/40 transition-opacity duration-300 lg:bg-black/60 lg:backdrop-blur-sm ${open ? "opacity-100" : "opacity-0"}`}
      />
      <div
        role="dialog"
        aria-modal="true"
        className={`absolute inset-x-0 bottom-0 flex max-h-[88%] flex-col rounded-t-[20px] bg-bg shadow-2xl transition-[transform,opacity] duration-300 ease-out lg:inset-x-auto lg:bottom-auto lg:left-1/2 lg:top-1/2 lg:max-h-[86vh] lg:w-[660px] lg:max-w-[92vw] lg:rounded-[20px] lg:ring-1 lg:ring-separator/60 ${
          open
            ? "translate-y-0 lg:-translate-x-1/2 lg:-translate-y-1/2 lg:scale-100 lg:opacity-100"
            : "translate-y-full lg:-translate-x-1/2 lg:-translate-y-1/2 lg:scale-95 lg:opacity-0"
        }`}
      >
        <div className="flex justify-center pt-2.5 lg:hidden">
          <span className="h-1.5 w-9 rounded-full bg-fill/30" />
        </div>
        <div className="flex items-center justify-end px-5 pb-1 pt-1">
          <button onClick={onClose} className="text-[15px] font-medium text-accent active:opacity-50">Done</button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(20px,env(safe-area-inset-bottom))]">
          {fx && <MatchDetail key={fx.knockout ? `ko-${fx.match_number}` : `${fx.home}-${fx.away}-${fx.kickoff_utc || fx.kickoff || ""}`} data={data} fx={fx} live={live} lineups={lineups} events={events} />}
        </div>
      </div>
    </div>
  );
}

function MatchDetail({ data, fx, live, lineups, events }) {
  const isKnockout = !fx.group; // knockout fixtures carry group:null (isKnockoutFixture)
  const home = teamByCode(data, fx.home) || (fx.home ? { code: fx.home } : null);
  const away = teamByCode(data, fx.away) || (fx.away ? { code: fx.away } : null);
  const hasTeams = !!(home && away); // knockout slots have no teams until the post-group resolver fills them
  const hasPrediction = !!fx.probabilities; // and no prediction until then
  const state = matchState(fx, live);
  const lv = liveOf(fx, live);
  const finished = state === "finished";
  const isLive = state === "live";
  const sc = scoreOf(fx);
  const dc = dualClock(fx);
  const venueProfile = venueProfileFor(data, fx);
  const timeline = eventsOf(fx, events);
  const p = fx.probabilities || {};
  const fav = hasPrediction ? favorite(fx) : null;
  const hasDrawOutcome = !(isKnockout && Number(p.draw || 0) === 0);
  const [tab, setTab] = useState("Info");
  const [showVenueInfo, setShowVenueInfo] = useState(false);

  return (
    <div className="space-y-4">
      {/* match header (always visible above the tabs): teams (or bracket slots) + score/time + live note */}
      {hasTeams ? (
        <div className="flex items-center justify-center gap-3 pt-1">
          <div className="flex w-24 flex-col items-center gap-1.5">
            <Flag team={home} size={48} />
            <span className="text-center text-[13px] font-semibold leading-tight">{home.name || fx.home}</span>
          </div>
          <div className="text-center">
            <div className={`text-[28px] font-bold tabular-nums ${isLive ? "text-live" : ""}`}>
              {isLive ? `${lv.home_score ?? 0}–${lv.away_score ?? 0}` : finished ? `${sc.h}–${sc.a}` : "vs"}
            </div>
            {isLive ? (
              <div className="inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-live">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-live" />
                Live{lv.minute != null ? ` ${lv.minute}'` : ""}
              </div>
            ) : finished ? (
              <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Full-time</div>
            ) : null}
          </div>
          <div className="flex w-24 flex-col items-center gap-1.5">
            <Flag team={away} size={48} />
            <span className="text-center text-[13px] font-semibold leading-tight">{away.name || fx.away}</span>
          </div>
        </div>
      ) : (
        <KnockoutHeader data={data} fx={fx} />
      )}

      {isLive && (
        <p className="rounded-[12px] bg-live/10 px-3 py-2 text-center text-[12px] font-medium text-live">
          ● Live score from the real-time feed — display only; it doesn’t change our prediction.
        </p>
      )}

      {/* two tabs inside the sheet — same SegmentedTabs control the My Team view uses */}
      <SegmentedTabs tabs={["Info", "Lineups"]} value={tab} onChange={setTab} />

      <div key={tab} className="animate-panel space-y-4">
        {tab === "Info" ? (
          <>
            {/* kickoff — real date/time where the schedule has it, else the real round date-window */}
            <KickoffCard fx={fx} dc={dc} />

            <EventTimeline match={timeline} state={state} />

            {/* venue */}
            <VenueSection fx={fx} profile={venueProfile} open={showVenueInfo} onToggle={() => setShowVenueInfo((v) => !v)} />

            {/* prediction (display only) — real once teams are confirmed, else a clean placeholder */}
            {hasPrediction ? (
              <div className="card p-4">
                <Label>{finished ? "We predicted" : "Our prediction"}</Label>
                <PredictionBar data={data} fx={fx} heightClass="h-1.5" className="mt-2" />
                <div className="mt-2 flex justify-between text-[13px]">
                  <Prob label={fx.home} v={p.home_win} on={fav.k === "home"} />
                  {hasDrawOutcome && <Prob label="Draw" v={p.draw} on={fav.k === "draw"} />}
                  <Prob label={fx.away} v={p.away_win} on={fav.k === "away"} />
                </div>
              </div>
            ) : (
              <PredictionPlaceholder isKnockout={isKnockout} />
            )}

            {/* weather */}
            <WeatherSection data={data} fx={fx} />

            <p className="px-1 pb-2 text-center text-[11px] text-ink-3">
              Predictions are simulation outputs, not betting odds. Weather is forecast context only — it never moves the probabilities.
            </p>
          </>
        ) : (
          <LineupsSection fx={fx} home={home} away={away} lineups={lineups} live={live} isKnockout={isKnockout} hasTeams={hasTeams} />
        )}
      </div>
    </div>
  );
}

// Knockout header — bracket-slot placeholders ("Winner Group E" v "Best 3rd from A/B/C/D/F"), forward-compatible
// to real flags+names once a side's `team` is filled. Mirrors the team-header layout so the sheet looks complete.
function KnockoutHeader({ data, fx }) {
  return (
    <div className="flex items-center justify-center gap-3 pt-1">
      <SlotHead data={data} side={fx.side_a} />
      <div className="text-center">
        <div className="text-[24px] font-bold text-ink-2">vs</div>
        <div className="mt-0.5 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
          {fx.round}{fx.match_number ? ` · M${fx.match_number}` : ""}
        </div>
      </div>
      <SlotHead data={data} side={fx.side_b} />
    </div>
  );
}

function SlotHead({ data, side }) {
  const s = side || {};
  const team = s.team ? (teamByCode(data, s.team.code) || s.team) : null;
  if (team) {
    return (
      <div className="flex w-28 flex-col items-center gap-1.5">
        <Flag team={team} size={48} />
        <span className="text-center text-[13px] font-semibold leading-tight">{team.name || team.code}</span>
      </div>
    );
  }
  return (
    <div className="flex w-28 flex-col items-center gap-1.5">
      <span className="grid h-12 w-12 place-items-center rounded-full bg-fill/10 text-[20px] font-bold text-ink-3" aria-hidden="true">?</span>
      <span className="text-center text-[12px] font-semibold leading-tight text-ink-2">{s.label || "TBD"}</span>
    </div>
  );
}

// Kickoff card — knockout dates are schedule-fixed and KNOWN (only the teams depend on results). Show the exact
// date/time where the schedule has it (SF/3rd/Final have time; QF has the date), otherwise the real round window.
// Never imply the date is "set after the group stage" — the date is fixed; only the matchup is pending.
function KickoffCard({ fx, dc }) {
  if (fx.kickoff_utc) {
    return (
      <div className="card p-4">
        <Label>Kickoff</Label>
        {dc.venue && !dc.sameZone ? (
          <div className="mt-1 space-y-0.5">
            <Line k={`${fx.city || "Venue"} time`} v={dc.venue} />
            <Line k="Your time" v={`${dc.viewer} (${VIEWER_TZ.split("/").pop().replace(/_/g, " ")})`} />
          </div>
        ) : (
          <div className="mt-1"><Line k="Your time" v={dc.viewer || "TBC"} /></div>
        )}
      </div>
    );
  }
  const dateOnly = fmtKoDateFull(fx.kickoff);
  return (
    <div className="card p-4">
      <Label>Date</Label>
      {dateOnly ? (
        <div className="mt-1 space-y-0.5">
          <Line k="Date" v={dateOnly} />
          <Line k="Kickoff time" v="Confirmed nearer the match" />
        </div>
      ) : fx.round_window_label ? (
        <div className="mt-1">
          <Line k="Date window" v={fx.round_window_label} />
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3">
            The exact date is fixed by the published schedule; the teams are confirmed after the group stage.
          </p>
        </div>
      ) : (
        <div className="mt-1"><Line k="Date" v="TBC" /></div>
      )}
    </div>
  );
}

// Clean prediction placeholder for an unresolved knockout slot — explicit state, never an empty/grey bar.
function PredictionPlaceholder({ isKnockout }) {
  return (
    <div className="card p-4">
      <Label>Our prediction</Label>
      <p className="mt-1 text-[13px] text-ink-2">
        {isKnockout
          ? "Prediction available once the teams are confirmed after the group stage."
          : "Prediction available once the teams are confirmed."}
      </p>
    </div>
  );
}

const _KO_MON = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const _KO_WD = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function fmtKoDateFull(s) {
  if (!s) return null;
  const [y, m, d] = String(s).split("-").map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(dt.getTime())) return null;
  return `${_KO_WD[dt.getUTCDay()]}, ${_KO_MON[m - 1]} ${d}`;
}

function EventTimeline({ match, state }) {
  const items = (match && Array.isArray(match.events) ? match.events : []).slice();
  items.sort((a, b) => (a.minute ?? 999) - (b.minute ?? 999) || (a.extra ?? 0) - (b.extra ?? 0));

  if (!items.length) {
    if (state !== "live") return null;
    return (
      <div className="card p-4">
        <Label>Timeline</Label>
        <p className="mt-1 text-[13px] text-ink-2">No goals or cards yet.</p>
      </div>
    );
  }

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-3">
        <Label>Timeline</Label>
        <span className="text-[11px] font-medium text-ink-3">{items.length} event{items.length === 1 ? "" : "s"}</span>
      </div>
      <ol className="mt-3 space-y-2">
        {items.map((ev, i) => <EventRow key={`${ev.kind}-${ev.team}-${ev.minute}-${ev.extra}-${ev.player?.api_player_id ?? ev.player?.name}-${i}`} ev={ev} />)}
      </ol>
    </div>
  );
}

function EventRow({ ev }) {
  const isGoal = ev.kind === "goal";
  const icon = eventIcon(ev);
  const name = eventTitle(ev);
  const detail = eventDetail(ev);
  return (
    <li className="flex items-start gap-3 rounded-[12px] bg-fill/[0.06] px-3 py-2.5">
      <span className="w-10 shrink-0 pt-0.5 text-right text-[12px] font-bold tabular-nums text-ink-2">{ev.display_minute || "—"}</span>
      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[15px] ${isGoal ? "bg-qualified/10" : "bg-fill/10"}`} aria-hidden="true">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold text-ink">{name}</span>
        <span className="mt-0.5 block truncate text-[11px] text-ink-3">
          {[ev.team, detail].filter(Boolean).join(" · ")}
        </span>
      </span>
    </li>
  );
}

function eventIcon(ev) {
  if (ev.kind === "goal") return "⚽";
  if (ev.kind === "substitution") return "🔄";
  if (ev.card === "second_yellow") return "🟨🟥";
  if (ev.card === "red") return "🟥";
  return "🟨";
}

function eventTitle(ev) {
  if (ev.kind === "substitution") {
    const off = ev.player_off?.name || "Player off";
    const on = ev.player_on?.name || "Player on";
    return `${off} → ${on}`;
  }
  return ev.player?.name || "Unknown player";
}

function eventDetail(ev) {
  if (ev.kind === "goal") {
    const bits = [];
    if (ev.penalty) bits.push("Penalty");
    if (ev.own_goal) bits.push("Own goal");
    if (ev.assist?.name) bits.push(`Assist: ${ev.assist.name}`);
    return bits.join(" · ");
  }
  if (ev.kind === "substitution") return "Substitution";
  if (ev.card === "second_yellow") return "Second yellow";
  if (ev.card === "red") return "Red card";
  return "Yellow card";
}

function venueLocation(profile, fx) {
  return [
    (profile && profile.city) || fx.city,
    (profile && profile.state_province) || fx.state,
    (profile && profile.country) || fx.country,
  ].filter(Boolean).join(", ") || "—";
}

function venueTitle(profile, fx) {
  return (profile && profile.real_venue_name) || fx.venue || "Venue TBC";
}

function tidbitBody(tidbits) {
  return String(tidbits || "").replace(/^Did you know\?\s*/i, "").trim();
}

function VenueSection({ fx, profile, open, onToggle }) {
  const title = venueTitle(profile, fx);
  const location = venueLocation(profile, fx);

  if (!profile) {
    return (
      <div className="card p-4">
        <Label>Venue</Label>
        <div className="mt-1 text-[15px] font-semibold">{title}</div>
        <div className="text-[13px] text-ink-2">{location}</div>
      </div>
    );
  }

  return (
    <div className="card overflow-hidden p-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-4 text-left active:bg-fill/10"
      >
        <span className="min-w-0 flex-1">
          <Label>Venue</Label>
          <span className="mt-1 block text-[15px] font-semibold leading-tight text-ink">{title}</span>
          <span className="mt-0.5 block text-[13px] text-ink-2">{location}</span>
        </span>
        <IconChevronRight className={`h-5 w-5 shrink-0 text-ink-3 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && <VenueProfileCard profile={profile} />}
    </div>
  );
}

function VenueProfileCard({ profile }) {
  const location = venueLocation(profile, {});
  const tidbit = tidbitBody(profile.tidbits);
  return (
    <div className="border-t border-separator/50 px-4 pb-4 pt-3">
      <p className="text-[13px] font-medium text-ink">{location}</p>
      {profile.population && <p className="mt-1 text-[12px] text-ink-3">{profile.population}</p>}
      {profile.character && <p className="mt-2 text-[13px] leading-relaxed text-ink-2">{profile.character}</p>}

      {profile.clubs && <VenueText label="Clubs">{profile.clubs}</VenueText>}
      {profile.football_history && <VenueText label="Football history">{profile.football_history}</VenueText>}

      <div className="mt-3 rounded-[12px] bg-fill/[0.06] p-3">
        <Label>Stadium</Label>
        <div className="mt-2 space-y-2 text-[13px]">
          {profile.capacity_wc && <VenueFact k="Capacity" v={profile.capacity_wc} />}
          {profile.built && <VenueFact k="Built" v={profile.built} />}
        </div>
        {profile.stadium_fact && <p className="mt-2 text-[13px] leading-relaxed text-ink-2">{profile.stadium_fact}</p>}
      </div>

      {tidbit && (
        <div className="mt-3 rounded-[12px] border border-accent/20 bg-accent/10 px-3 py-2.5">
          <div className="text-[11px] font-bold uppercase tracking-wide text-accent">Did you know?</div>
          <p className="mt-1 text-[13px] leading-relaxed text-ink">{tidbit}</p>
        </div>
      )}
    </div>
  );
}

function VenueFact({ k, v }) {
  return (
    <div>
      <span className="block text-[12px] text-ink-3">{k}</span>
      <span className="block font-medium leading-snug text-ink">{v}</span>
    </div>
  );
}

function VenueText({ label, children }) {
  return (
    <div className="mt-3">
      <Label>{label}</Label>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{children}</p>
    </div>
  );
}

// Confirmed starting XIs (+ bench), read from the static lineups.json overlay. Orientation is already
// normalized server-side (home_lineup -> fx.home). Display only — never a model input.
function LineupsSection({ fx, home, away, lineups, live, isKnockout, hasTeams }) {
  // Knockout slot with no teams yet: explicit, graceful placeholder (no empty XI columns / blank flags).
  if (isKnockout && !hasTeams) {
    return (
      <div className="card p-4">
        <Label>Lineups</Label>
        <p className="mt-1 text-[13px] text-ink-2">
          Teams are confirmed after the group stage; lineups follow ~60 min before kickoff.
        </p>
      </div>
    );
  }
  const ls = lineupState(fx, lineups, live);
  if (!ls.has) {
    // On the dedicated Lineups tab we always render a card (never blank): the persistent
    // "~60 min" placeholder pre-match, or a graceful past-tense note for a finished match
    // whose XI was never stored.
    return (
      <div className="card p-4">
        <Label>Lineups</Label>
        <p className="mt-1 text-[13px] text-ink-2">
          {ls.showPlaceholder
            ? "Lineups available ~60 min before kickoff."
            : "No confirmed lineup was published for this match."}
        </p>
      </div>
    );
  }
  const lu = ls.lineup || {};
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between">
        <Label>Lineups</Label>
        {/* "View on pitch" — opens the visual lineup popup (both XIs positioned on the pitch). */}
        <ViewOnPitchButton fx={fx} lineup={lu} homeTeam={home} awayTeam={away} />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-4">
        <TeamLineup team={home} side={lu.home_lineup} />
        <TeamLineup team={away} side={lu.away_lineup} />
      </div>
      <p className="mt-3 text-[11px] text-ink-3">Confirmed XIs from the official team sheet — display only; they don’t change the prediction.</p>
    </div>
  );
}

function ViewOnPitchButton({ fx, lineup, homeTeam, awayTeam }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 rounded-full bg-fill/10 px-2.5 py-1 text-[12px] font-semibold text-accent transition active:scale-95"
      >
        View on pitch
      </button>
      {open && <LineupPitchSheet fx={fx} lineup={lineup} homeTeam={homeTeam} awayTeam={awayTeam} onClose={() => setOpen(false)} />}
    </>
  );
}
function TeamLineup({ team, side }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        <Flag team={team} size={18} />
        <span className="truncate text-[13px] font-semibold">{team.code}</span>
        {side?.formation && <span className="ml-auto shrink-0 rounded-md bg-fill/10 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums">{side.formation}</span>}
      </div>
      {side?.coach && <div className="mt-0.5 truncate text-[11px] text-ink-3">{side.coach}</div>}
      {side ? (
        <>
          <ol className="mt-2 space-y-1">
            {(side.startXI || []).map((p, i) => (
              <li key={`${p.player_id ?? p.name}-${i}`} className="flex items-baseline gap-1.5 text-[12px]">
                <span className="w-4 shrink-0 text-right tabular-nums text-ink-3">{p.number ?? ""}</span>
                <span className="truncate text-ink">{p.name}</span>
              </li>
            ))}
          </ol>
          {(side.substitutes || []).length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] font-medium text-accent active:opacity-50">Bench ({side.substitutes.length})</summary>
              <ol className="mt-1 space-y-1">
                {side.substitutes.map((p, i) => (
                  <li key={`${p.player_id ?? p.name}-${i}`} className="flex items-baseline gap-1.5 text-[12px] text-ink-2">
                    <span className="w-4 shrink-0 text-right tabular-nums text-ink-3">{p.number ?? ""}</span>
                    <span className="truncate">{p.name}</span>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </>
      ) : (
        <p className="mt-2 text-[11px] text-ink-3">XI not posted yet.</p>
      )}
    </div>
  );
}

function WeatherSection({ data, fx }) {
  const wx = weatherFor(data, fx);
  const vf = venueFactsFor(data, fx);
  const imminent = isImminent(fx);
  const conf = weatherConfidence(wx);
  const roofDisplay = roofLabel(vf);

  return (
    <div className={`card p-4 ${conf?.muted ? "opacity-90" : ""}`}>
      <div className="flex items-center justify-between">
        <Label>Weather</Label>
        {wx && <span className="text-[22px] leading-none">{weatherEmoji(wx.condition, wx.code)}</span>}
      </div>

      {wx ? (
        <>
          <div className="mt-1 text-[26px] font-bold tabular-nums">
            {wx.temp_c != null ? (
              <>{Math.round(wx.temp_c)}°C <span className="text-[15px] font-semibold text-ink-3">/ {cToF(wx.temp_c)}°F</span></>
            ) : "—"}
            {wx.condition ? <span className="ml-2 text-[14px] font-medium text-ink-2">{wx.condition}</span> : null}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
            {wx.feels_like_c != null && <Line k="Feels like" v={tempCF(wx.feels_like_c)} />}
            {wx.precip_chance_pct != null && <Line k="Rain chance" v={`${Math.round(wx.precip_chance_pct)}%`} />}
            {wx.wind_kmh != null && <Line k="Wind" v={`${Math.round(wx.wind_kmh)} km/h`} />}
            {wx.humidity_pct != null && <Line k="Humidity" v={`${Math.round(wx.humidity_pct)}%`} />}
          </div>
          {/* honest confidence — a 7-day-out forecast is flagged "early"; the chip firms up as kickoff nears */}
          {conf && (
            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-ink-3">
              <span className={`h-1.5 w-1.5 rounded-full ${conf.level === "high" ? "bg-qualified" : conf.level === "medium" ? "bg-bubble" : "bg-ink-3"}`} />
              <span>{conf.label}{wx.forecast_for ? " · kickoff hour (venue local)" : ""}</span>
            </div>
          )}
        </>
      ) : (
        <p className="mt-1 text-[13px] text-ink-2">
          {imminent ? "Forecast loading for kickoff." : "Forecast available nearer kickoff (within ~7 days)."}
        </p>
      )}

      {/* static venue facts (available now) */}
      {vf && (
        <div className="mt-3 border-t border-separator/50 pt-3">
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
            {vf.altitude_m != null && <Line k="Altitude" v={`${vf.altitude_m} m`} />}
            {roofDisplay && <Line k="Roof" v={roofDisplay} />}
            {vf.capacity != null && <Line k="Capacity" v={vf.capacity.toLocaleString()} />}
            {vf.weather_impact_level && <Line k="Weather impact" v={vf.weather_impact_level} />}
          </div>
          {vf.context_note && <p className="mt-2 text-[11px] text-ink-3">{vf.context_note}</p>}
        </div>
      )}
    </div>
  );
}

const ROOF_LABELS = {
  open: "Open-air",
  closed: "Closed",
  retractable: "Retractable",
  "fixed-canopy": "Fixed canopy",
};

const ROOF_OPERATION_LABELS = {
  open: "set open",
  closed: "set closed",
  retractable: "retractable",
  unknown: "",
  not_applicable: "",
};

function enumLabel(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function roofLabel(vf) {
  if (!vf || !vf.roof) return "";
  const roof = ROOF_LABELS[vf.roof] || enumLabel(vf.roof);
  const operation = ROOF_OPERATION_LABELS[vf.roof_operation] ?? enumLabel(vf.roof_operation);
  return [roof, operation].filter(Boolean).join(" · ");
}

function Label({ children }) {
  return <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">{children}</div>;
}
function Line({ k, v }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-ink-2">{k}</span>
      <span className="text-right font-medium text-ink">{v}</span>
    </div>
  );
}
function Prob({ label, v, on }) {
  return (
    <span className={on ? "font-bold text-ink" : "text-ink-2"}>
      {label} {pct(v)}
    </span>
  );
}
