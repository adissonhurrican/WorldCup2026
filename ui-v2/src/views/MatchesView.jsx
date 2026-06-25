import { useState } from "react";
import Screen from "../components/Screen";
import MatchCard from "../components/MatchCard";
import KnockoutCard from "../components/KnockoutCard";
import { IconChevronDown, IconCheck } from "../components/icons";
import { fixturesByDay, cityOptions, dateOptions, dayKeyOf, matchState } from "../lib/select";

export default function MatchesView({ data, live, lineups, events, stats, onOpenMatch, rightAction }) {
  const [city, setCity] = useState(null); // null = All cities (default, unchanged behavior)
  const [day, setDay] = useState(null); // null = All dates; else a dayKeyOf key from dateOptions
  const cities = cityOptions(data);
  const dates = dateOptions(data);
  const total = (data.fixtures || []).length;
  const days = fixturesByDay(data, city, day); // city + date compose; the existing day grouping/sort still applies
  const liveCount = (data.fixtures || []).filter((f) => matchState(f, live) === "live").length;
  // day-keys that currently have a match in play -> the chip shows the live pulse dot
  const liveDayKeys = new Set((data.fixtures || []).filter((f) => matchState(f, live) === "live").map((f) => dayKeyOf(f)).filter(Boolean));

  return (
    <Screen stickyTitle="Matches" rightAction={rightAction} header={<h1 className="py-1 text-[34px] font-bold tracking-tight">Matches</h1>}>
      {liveCount > 0 && (
        <div className="mt-1 flex items-center gap-2 text-[13px] font-semibold text-live">
          <span className="h-2 w-2 animate-pulse rounded-full bg-live" />
          {liveCount} match{liveCount > 1 ? "es" : ""} live now
        </div>
      )}

      {/* sibling filters: host-city dropdown + the date dropdown (Apple-style month grid; only match
          days are bold/tappable). Both are pills on one row and compose over the same fixture list. */}
      <div className="relative mt-3 flex items-center gap-2">
        <CityDropdown cities={cities} total={total} value={city} onChange={setCity} />
        <DateDropdown dates={dates} value={day} onChange={setDay} liveDayKeys={liveDayKeys} />
      </div>

      {days.length === 0 && (
        <p className="mt-6 text-center text-[14px] text-ink-2">
          {city ? `No fixtures in ${city}.` : "No fixtures in the export."}
        </p>
      )}
      {days.map((d) => (
        <section key={d.key}>
          <p className="px-1 pb-2 pt-5 text-[13px] font-semibold uppercase tracking-wide text-ink-2">
            {d.label}
            {day != null && <span className="font-medium normal-case text-ink-3"> · {d.items.length} match{d.items.length === 1 ? "" : "es"}</span>}
          </p>
          <div className="space-y-3 md:grid md:grid-cols-2 md:gap-3 md:space-y-0 xl:grid-cols-3">
            {d.items.map((fx, i) =>
              fx.knockout ? (
                <KnockoutCard key={`ko-${fx.match_number}`} data={data} fx={fx} onOpen={onOpenMatch} />
              ) : (
                <MatchCard key={`${fx.home}-${fx.away}-${i}`} data={data} fx={fx} live={live} lineups={lineups} events={events} stats={stats} onOpen={onOpenMatch} />
              ),
            )}
          </div>
        </section>
      ))}
      <p className="mt-6 text-center text-[12px] text-ink-3">
        Our predictions and verified results — both from the export. Live in-play scores are a separate feed, shown only while a match is in play and never feed the model.
      </p>
    </Screen>
  );
}

// Match calendar — a classic Apple-style MONTH GRID (weekday header row + week rows). Dates are
// BOLD only when games are played that day (from dateOptions — the same viewer-local buckets the
// list uses); rest days render thin/dimmed and are not tappable. Today wears the accent circle;
// the selected match day gets the filled circle (and taps again to reset). ‹ › pages between the
// tournament months (June/July 2026 — derived from the data, not hardcoded). A day with a match in
// play carries the live pulse dot. Pure display control: selecting a day passes a dayKeyOf key
// into fixturesByDay (composes with the city filter).
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"];
function localTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
// The dropdown shell around the calendar — the CityDropdown pattern verbatim: a pill trigger
// ("All dates" or the picked day + its match count + chevron) opens a floating panel holding the
// month grid; tap-away closes; picking a day (or "Show all dates") closes it too.
function DateDropdown({ dates, value, onChange, liveDayKeys }) {
  const [open, setOpen] = useState(false);
  const selectedOpt = value ? dates.find((d) => d.key === value) : null;
  const pick = (v) => { onChange(v); setOpen(false); };

  return (
    // NOT `relative`: the floating panel anchors to the filter ROW (the nearest positioned
    // ancestor), so the month grid spans the content width instead of clipping at the pill.
    <div className="z-30">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-full bg-fill/10 py-2 pl-3.5 pr-2.5 text-[14px] font-semibold text-ink active:opacity-70"
      >
        <span>{selectedOpt ? selectedOpt.label : "All dates"}</span>
        {selectedOpt && <span className="text-[13px] font-medium tabular-nums text-ink-3">{selectedOpt.count}</span>}
        <IconChevronDown className={`h-4 w-4 text-ink-3 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <>
          {/* tap-away backdrop (transparent) */}
          <button aria-hidden="true" tabIndex={-1} onClick={() => setOpen(false)} className="fixed inset-0 z-40 cursor-default" />
          <div className="animate-panel absolute inset-x-0 top-[calc(100%+6px)] z-50 max-w-[24rem] rounded-[14px] bg-surface p-3 shadow-2xl ring-1 ring-separator/60">
            <MatchCalendar dates={dates} value={value} onChange={pick} liveDayKeys={liveDayKeys} />
          </div>
        </>
      )}
    </div>
  );
}

function MatchCalendar({ dates, value, onChange, liveDayKeys }) {
  const todayKey = localTodayKey();
  const byKey = new Map(dates.map((d) => [d.key, d]));
  // months that contain at least one match day, in order (e.g. ["2026-06", "2026-07"])
  const months = [...new Set(dates.map((d) => d.key.slice(0, 7)))].sort();
  const startMonth = months.includes(todayKey.slice(0, 7)) ? todayKey.slice(0, 7) : months[0];
  const [month, setMonth] = useState(startMonth);
  if (!dates.length) return null;

  const mi = months.indexOf(month);
  const [yy, mm] = month.split("-").map(Number);
  const first = new Date(yy, mm - 1, 1);
  const daysInMonth = new Date(yy, mm, 0).getDate();
  // leading blanks so day 1 lands under its weekday (Sunday-first, Apple-style)
  const cells = [...Array(first.getDay()).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];

  return (
    <div>
      <div className="flex items-center justify-between">
        <button
          onClick={() => mi > 0 && setMonth(months[mi - 1])}
          disabled={mi <= 0}
          aria-label="Previous month"
          className={`grid h-8 w-8 place-items-center rounded-full text-[18px] ${mi > 0 ? "text-ink active:bg-fill/10" : "text-ink-3/40"}`}
        >
          ‹
        </button>
        <span className="text-[15px] font-semibold">{MONTH_NAMES[mm - 1]} {yy}</span>
        <button
          onClick={() => mi < months.length - 1 && setMonth(months[mi + 1])}
          disabled={mi >= months.length - 1}
          aria-label="Next month"
          className={`grid h-8 w-8 place-items-center rounded-full text-[18px] ${mi < months.length - 1 ? "text-ink active:bg-fill/10" : "text-ink-3/40"}`}
        >
          ›
        </button>
      </div>
      <div className="mt-1 grid grid-cols-7 text-center">
        {WEEKDAY_INITIALS.map((w, i) => (
          <span key={i} className="py-1 text-[11px] font-semibold text-ink-3">{w}</span>
        ))}
        {cells.map((day, i) => {
          if (day == null) return <span key={`b${i}`} />;
          const key = `${month}-${String(day).padStart(2, "0")}`;
          const match = byKey.get(key);
          const selected = value === key;
          const isToday = key === todayKey;
          const isLive = liveDayKeys?.has(key);
          if (!match) {
            // no games this day: thin + dimmed, not tappable (the "only bold when games are played" rule)
            return (
              <span key={key} className={`relative mx-auto grid h-9 w-9 place-items-center text-[14px] font-light text-ink-3/60 ${isToday ? "rounded-full ring-1 ring-bubble/50" : ""}`}>
                {day}
              </span>
            );
          }
          return (
            <button
              key={key}
              onClick={() => onChange(selected ? null : key)}
              aria-pressed={selected}
              className={`relative mx-auto grid h-9 w-9 place-items-center rounded-full text-[15px] font-bold tabular-nums transition active:scale-90 ${
                selected ? "bg-ink text-bg" : isToday ? "bg-bubble/15 text-ink ring-1 ring-bubble/60" : "text-ink"
              }`}
            >
              {day}
              {isLive && <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-live" />}
            </button>
          );
        })}
      </div>
      {value != null && (
        <button onClick={() => onChange(null)} className="mt-1 w-full text-center text-[12px] font-semibold text-accent active:opacity-60">
          Show all dates
        </button>
      )}
    </div>
  );
}

// iOS-style dropdown menu: a pill trigger (current selection + count + chevron) opens a floating
// rounded panel listing "All cities" + the 16 host cities, each with its match count and a checkmark
// on the selected one. Tap-away closes. Pure display control over the existing fixture→city mapping.
function CityDropdown({ cities, total, value, onChange }) {
  const [open, setOpen] = useState(false);
  const currentCount = value ? (cities.find((c) => c.city === value)?.count ?? 0) : total;
  const pick = (v) => { onChange(v); setOpen(false); };

  return (
    <div className="relative z-30">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-full bg-fill/10 py-2 pl-3.5 pr-2.5 text-[14px] font-semibold text-ink active:opacity-70"
      >
        <span>{value || "All cities"}</span>
        <span className="text-[13px] font-medium tabular-nums text-ink-3">{currentCount}</span>
        <IconChevronDown className={`h-4 w-4 text-ink-3 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <>
          {/* tap-away backdrop (transparent) */}
          <button aria-hidden="true" tabIndex={-1} onClick={() => setOpen(false)} className="fixed inset-0 z-40 cursor-default" />
          {/* floating menu */}
          <div
            role="listbox"
            className="animate-panel absolute left-0 top-[calc(100%+6px)] z-50 max-h-[58vh] w-[min(20rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain rounded-[14px] bg-surface px-1 pb-[calc(0.25rem_+_env(safe-area-inset-bottom))] pt-1 shadow-2xl ring-1 ring-separator/60 supports-[height:100dvh]:max-h-[calc(58dvh_-_env(safe-area-inset-bottom))] [-webkit-overflow-scrolling:touch]"
          >
            <CityRow label="All cities" count={total} selected={value == null} onClick={() => pick(null)} />
            <span className="mx-3 my-1 block h-px bg-separator/50" />
            {cities.map((c) => (
              <CityRow key={c.city} label={c.city} count={c.count} selected={value === c.city} onClick={() => pick(c.city)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function CityRow({ label, count, selected, onClick }) {
  return (
    <button
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-left text-[15px] transition-colors active:bg-fill/10"
    >
      <span className={`min-w-0 flex-1 truncate ${selected ? "font-semibold text-ink" : "text-ink"}`}>{label}</span>
      <span className="shrink-0 tabular-nums text-[13px] text-ink-3">{count}</span>
      <IconCheck className={`h-4 w-4 shrink-0 text-accent ${selected ? "opacity-100" : "opacity-0"}`} />
    </button>
  );
}
