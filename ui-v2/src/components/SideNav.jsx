import { GlassNavIcon } from "./GlassNavIcon";
import { PAGES, PAGE_ORDER } from "../content/pages";
import { SITE_NAME, COMPANY } from "../config";

// Desktop-only primary navigation (≥1024px), rebuilt in the ELEVEN glass language: an ALWAYS-DARK
// night-glass rail with frosted icon tiles that lift to champion-gold on hover and on the active item.
// Icon tiles + gold material come from the ELEVEN design system (GlassNavIcon); jersey/calendar/grid/info
// are the package built-ins, and Prediction keeps the app's OWN glyph adapted to the glass tile. The dark
// chrome is intentional in both app themes (decision: always-dark menu). Bottom TabBar owns mobile.

// The app's own Prediction icon (bars + trend line), adapted to the glass tile (inner SVG nodes only).
const predictionGlyph = (
  <>
    <path d="M4 19.5h16" />
    <path d="M7 16v-5" />
    <path d="M12 16V7" />
    <path d="M17 16v-8" />
    <path d="M5.5 9.5 10 6l4 2 4.5-5" />
    <path d="M18.5 3v4.5H14" />
  </>
);

// Knockout bracket glyph: two arms merging into a node, then a line out to the champion (inner SVG nodes).
const bracketGlyph = (
  <>
    <path d="M6 5v5a2 2 0 0 0 2 2h3" />
    <path d="M6 19v-5a2 2 0 0 1 2-2h3" />
    <path d="M11 12h7" />
  </>
);

// Trophy glyph — the post-tournament Results home (cup + stem + base, stroke style like the others).
const trophyGlyph = (
  <>
    <path d="M8 4h8v4a4 4 0 0 1-8 0V4z" />
    <path d="M8 5H5v1a3 3 0 0 0 3 3" />
    <path d="M16 5h3v1a3 3 0 0 1-3 3" />
    <path d="M12 12v4" />
    <path d="M9 19h6" />
  </>
);

const PRIMARY = [
  { id: "home", label: "Results", icon: trophyGlyph },
  { id: "team", label: "My Team", icon: "jersey" },
  { id: "matches", label: "Matches", icon: "calendar" },
  { id: "prediction", label: "Prediction", icon: predictionGlyph },
  { id: "groups", label: "Groups", icon: "grid" },
  { id: "bracket", label: "Bracket", icon: bracketGlyph },
];

// "How it works" is promoted into the iconned group (per the design); the rest stay as text links.
const TEXT_LINKS = PAGE_ORDER.filter((k) => k !== "how");

export default function SideNav({ view, onChange, secondary, onSecondary }) {
  const howActive = secondary === "how";
  return (
    <nav className="eleven-nav relative hidden w-[264px] shrink-0 flex-col px-4 py-7 lg:relative lg:z-10 lg:flex" aria-label="Primary">
      <div className="relative z-10 flex flex-1 flex-col">
      {/* wordmark — the "We Are 26" rainbow as the single signature accent */}
      <div className="px-2 pb-7">
        <span className="rainbow-line block h-1 w-11 rounded-full" />
        <h1 className="eleven-brandtitle mt-3 text-[20px] font-bold leading-tight tracking-tight">{SITE_NAME || COMPANY}</h1>
        <p className="eleven-brandsub mt-0.5 text-[12px]">World Cup 2026 — every match predicted, now scored</p>
      </div>

      <div className="flex flex-col gap-0.5">
        {PRIMARY.map(({ id, label, icon }) => {
          const active = view === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onChange(id)}
              aria-current={active ? "page" : undefined}
              className={`eleven-nav-item${active ? " is-active" : ""}`}
            >
              <GlassNavIcon icon={icon} state={active ? "gold" : "rest"} />
              <span>{label}</span>
            </button>
          );
        })}
        {/* Model report — the post-tournament results deep-dive (same glass-icon treatment, secondary route) */}
        <button
          type="button"
          onClick={() => onSecondary("report")}
          aria-current={secondary === "report" ? "page" : undefined}
          className={`eleven-nav-item${secondary === "report" ? " is-active" : ""}`}
        >
          <GlassNavIcon icon={predictionGlyph} state={secondary === "report" ? "gold" : "rest"} />
          <span>Model report</span>
        </button>
        {/* How it works — same glass-icon treatment, but routes to the info page */}
        <button
          type="button"
          onClick={() => onSecondary("how")}
          aria-current={howActive ? "page" : undefined}
          className={`eleven-nav-item${howActive ? " is-active" : ""}`}
        >
          <GlassNavIcon icon="info" state={howActive ? "gold" : "rest"} />
          <span>{PAGES.how.navLabel}</span>
        </button>
      </div>

      {/* secondary text links (About / Privacy / Terms) — quieter, below the iconned group */}
      <div className="mt-auto pt-8">
        <div className="eleven-divline mb-2 h-px" />
        <div className="flex flex-col">
          {TEXT_LINKS.map((k) => {
            const active = secondary === k;
            return (
              <button
                key={k}
                type="button"
                onClick={() => onSecondary(k)}
                aria-current={active ? "page" : undefined}
                className={`eleven-textlink${active ? " is-active" : ""} rounded-[8px] px-3 py-1.5 text-left text-[13px] transition-colors`}
              >
                {PAGES[k].navLabel}
              </button>
            );
          })}
        </div>
        <p className="eleven-footnote px-3 pt-4 text-[11px] leading-relaxed">
          Simulation outputs, not betting odds.
        </p>
      </div>
      </div>
      {/* decorative gold dragon, small emblem in the bottom-right corner (~10% bigger than match-card flags) */}
      <img
        src={`${import.meta.env.BASE_URL}dragon.png`}
        alt=""
        aria-hidden="true"
        className="pointer-events-none absolute bottom-3 right-3 z-0 w-[29px] select-none opacity-90"
      />
    </nav>
  );
}
