import { useState } from "react";
import Screen from "../components/Screen";
import MatchCard from "../components/MatchCard";
import { IconChevronDown, IconCheck } from "../components/icons";
import { fixturesByDay, cityOptions, matchState } from "../lib/select";

export default function MatchesView({ data, live, lineups, events, onOpenMatch, rightAction }) {
  const [city, setCity] = useState(null); // null = All cities (default, unchanged behavior)
  const cities = cityOptions(data);
  const total = (data.fixtures || []).length;
  const days = fixturesByDay(data, city); // city narrows; the existing day grouping/sort still applies
  const liveCount = (data.fixtures || []).filter((f) => matchState(f, live) === "live").length;

  return (
    <Screen stickyTitle="Matches" rightAction={rightAction} header={<h1 className="py-1 text-[34px] font-bold tracking-tight">Matches</h1>}>
      {liveCount > 0 && (
        <div className="mt-1 flex items-center gap-2 text-[13px] font-semibold text-live">
          <span className="h-2 w-2 animate-pulse rounded-full bg-live" />
          {liveCount} match{liveCount > 1 ? "es" : ""} live now
        </div>
      )}

      {/* host-city filter — an iOS-style dropdown menu; reuses the per-fixture city mapping. "All cities" default. */}
      <CityDropdown cities={cities} total={total} value={city} onChange={setCity} />

      {days.length === 0 && (
        <p className="mt-6 text-center text-[14px] text-ink-2">
          {city ? `No fixtures in ${city}.` : "No fixtures in the export."}
        </p>
      )}
      {days.map((d) => (
        <section key={d.key}>
          <p className="px-1 pb-2 pt-5 text-[13px] font-semibold uppercase tracking-wide text-ink-2">{d.label}</p>
          <div className="space-y-3 md:grid md:grid-cols-2 md:gap-3 md:space-y-0 xl:grid-cols-3">
            {d.items.map((fx, i) => (
              <MatchCard key={`${fx.home}-${fx.away}-${i}`} data={data} fx={fx} live={live} lineups={lineups} events={events} onOpen={onOpenMatch} />
            ))}
          </div>
        </section>
      ))}
      <p className="mt-6 text-center text-[12px] text-ink-3">
        Our predictions and verified results — both from the export. Live in-play scores are a separate feed, shown only while a match is in play and never feed the model.
      </p>
    </Screen>
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
    <div className="relative z-30 mt-3">
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
            className="animate-panel absolute left-0 top-[calc(100%+6px)] z-50 max-h-[58vh] w-[min(20rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain rounded-[14px] bg-surface p-1 shadow-2xl ring-1 ring-separator/60"
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
