import { useState } from "react";
import { Flag } from "./ui";
import { IconSearch, IconCheck } from "./icons";
import { teamsByName, nicknameLine } from "../lib/select";

// Bottom sheet team switcher — the real 48 teams (flag + name + group), searchable.
// Lives inside the app column (absolute, not fixed) so it stays within the phone frame.
export default function TeamSheet({ data, open, current, onPick, onClose }) {
  const [q, setQ] = useState("");
  const all = teamsByName(data);
  const query = q.trim().toLowerCase();
  const teams = query
    ? all.filter(
        (t) =>
          t.name.toLowerCase().includes(query) ||
          t.code.toLowerCase().includes(query) ||
          (t.group || "").toLowerCase() === query
      )
    : all;

  return (
    <div className={`absolute inset-0 z-50 ${open ? "" : "pointer-events-none"}`} aria-hidden={!open}>
      <div
        onClick={onClose}
        className={`absolute inset-0 bg-black/40 transition-opacity duration-300 lg:bg-black/60 lg:backdrop-blur-sm ${open ? "opacity-100" : "opacity-0"}`}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Choose a team"
        className={`absolute inset-x-0 bottom-0 flex max-h-[84%] flex-col rounded-t-[20px] bg-surface shadow-2xl transition-[transform,opacity] duration-300 ease-out lg:inset-x-auto lg:bottom-auto lg:left-1/2 lg:top-1/2 lg:max-h-[80vh] lg:w-[520px] lg:max-w-[92vw] lg:rounded-[20px] lg:ring-1 lg:ring-separator/60 ${
          open
            ? "translate-y-0 lg:-translate-x-1/2 lg:-translate-y-1/2 lg:scale-100 lg:opacity-100"
            : "translate-y-full lg:-translate-x-1/2 lg:-translate-y-1/2 lg:scale-95 lg:opacity-0"
        }`}
      >
        <div className="flex justify-center pt-2.5 lg:hidden">
          <span className="h-1.5 w-9 rounded-full bg-fill/30" />
        </div>

        <div className="flex items-center justify-between px-5 pb-3 pt-2">
          <h2 className="text-[17px] font-bold tracking-tight">Choose a team</h2>
          <button onClick={onClose} className="text-[15px] font-medium text-accent active:opacity-50">
            Done
          </button>
        </div>

        <div className="px-4 pb-2">
          <div className="flex items-center gap-2 rounded-[11px] bg-fill/10 px-3 py-2 text-ink-2">
            <IconSearch className="h-[18px] w-[18px]" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search 48 teams"
              className="min-w-0 flex-1 bg-transparent text-[16px] text-ink placeholder:text-ink-3 focus:outline-none"
            />
          </div>
        </div>

        <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
          {teams.map((t, idx) => {
            const active = t.code === current;
            return (
              <li key={t.code} className="relative">
                <button
                  onClick={() => onPick(t)}
                  className="flex w-full items-center gap-3 px-5 py-2.5 text-left active:bg-fill/10"
                >
                  <Flag team={t} size={36} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[16px] font-medium">{t.name}</span>
                    <span className="block truncate text-[13px] text-ink-2">{nicknameLine(t)}</span>
                  </span>
                  {active && <IconCheck className="h-5 w-5 shrink-0 text-accent" />}
                </button>
                {idx < teams.length - 1 && <span className="hairline absolute bottom-0 left-[64px] right-0 h-px" />}
              </li>
            );
          })}
          {teams.length === 0 && <li className="px-5 py-8 text-center text-[15px] text-ink-2">No teams match “{q}”.</li>}
        </ul>
      </div>
    </div>
  );
}
