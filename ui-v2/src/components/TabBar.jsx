import { GlassNavIcon } from "./GlassNavIcon";

// Mobile bottom tab bar, rebuilt in the ELEVEN glass language: an ALWAYS-DARK night-glass bar whose
// four tabs are frosted icon tiles, monochrome at rest and champion-gold on the active tab (class-driven,
// so touch gets the "you are here" cue). Same glass material/tokens as the desktop left rail. Overlays the
// content (absolute, bottom), safe-area aware. Prediction keeps the app's own glyph, adapted to the tile.

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

const TABS = [
  { id: "team", label: "My Team", icon: "jersey" },
  { id: "matches", label: "Matches", icon: "calendar" },
  { id: "prediction", label: "Prediction", icon: predictionGlyph },
  { id: "groups", label: "Groups", icon: "grid" },
];

export default function TabBar({ view, onChange }) {
  return (
    <nav
      className="eleven-tabbar absolute inset-x-0 bottom-0 z-30 lg:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="flex">
        {TABS.map(({ id, label, icon }) => {
          const active = view === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onChange(id)}
              aria-current={active ? "page" : undefined}
              className={`eleven-tab flex min-h-[56px] flex-1 flex-col items-center justify-center gap-[5px] pb-1 pt-1.5${active ? " is-active" : ""}`}
            >
              <GlassNavIcon icon={icon} state={active ? "gold" : "rest"} />
              <span className="text-[10px] font-medium tracking-tight">{label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
