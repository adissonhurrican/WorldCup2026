// Frosted-glass nav icon tile — from the ELEVEN — World Cup Predictor Design System.
// One glass material, two states: NEUTRAL (rest, monochrome) and GOLD (hover/active, class-driven
// so touch devices get the "you are here" cue without hover). Used ONLY by the desktop left rail
// (SideNav) and the mobile bottom bar (TabBar). The material/gold CSS variables it reads are scoped
// to those nav containers in index.css (.eleven-nav / .eleven-tabbar) so the menu stays dark in BOTH
// app themes. `icon` accepts a built-in NAV_ICONS key OR a custom SVG inner-node (used to pass the
// app's own Prediction glyph). Lucide path data (ISC). No FIFA/World Cup marks.

// Built-in monochrome line icons (Lucide path data — ISC). 24px grid, rendered at 20px in a 40px tile.
export const NAV_ICONS = {
  jersey: (
    <path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z" />
  ),
  shield: (
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
  ),
  calendar: (
    <>
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <rect width="18" height="18" x="3" y="4" rx="2" />
      <path d="M3 10h18" />
      <path d="M8 14h.01" />
      <path d="M12 14h.01" />
      <path d="M16 14h.01" />
      <path d="M8 18h.01" />
      <path d="M12 18h.01" />
    </>
  ),
  target: (
    <>
      <path d="M12 3v4" />
      <path d="M12 17v4" />
      <path d="M3 12h4" />
      <path d="M17 12h4" />
      <circle cx="12" cy="12" r="1.85" fill="currentColor" />
    </>
  ),
  grid: (
    <>
      <rect width="7" height="7" x="3" y="3" rx="1.4" />
      <rect width="7" height="7" x="14" y="3" rx="1.4" />
      <rect width="7" height="7" x="14" y="14" rx="1.4" />
      <rect width="7" height="7" x="3" y="14" rx="1.4" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16.5v-4.5" />
      <path d="M12 8h.01" />
    </>
  ),
};

function GlyphSVG({ icon, size = 20 }) {
  const node = typeof icon === "string" ? NAV_ICONS[icon] : icon;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {node}
    </svg>
  );
}

let styleInjected = false;
export function injectGlassNavStyles() {
  if (styleInjected || typeof document === "undefined") return;
  styleInjected = true;
  const css = `
  .eleven-tile{
    position:relative; display:grid; place-items:center;
    width:var(--nav-tile,40px); height:var(--nav-tile,40px);
    border-radius:var(--glass-radius-sm,11px);
    color:var(--icon-rest,#C9CDD4);
    background:var(--glass-surface);
    border:1px solid var(--glass-border);
    box-shadow:var(--glass-shadow);
    -webkit-backdrop-filter:blur(var(--glass-blur,14px));
    backdrop-filter:blur(var(--glass-blur,14px));
    transition:transform var(--dur-glass,220ms) var(--ease-glass),
               box-shadow var(--dur-glass,220ms) var(--ease-glass),
               background var(--dur-glass,220ms) var(--ease-glass),
               border-color var(--dur-glass,220ms) var(--ease-glass),
               color var(--dur-glass,220ms) var(--ease-glass);
  }
  /* top-edge catch-light */
  .eleven-tile::before{
    content:""; position:absolute; inset:0;
    border-radius:inherit; pointer-events:none;
    border-top:1px solid var(--glass-border-top);
    -webkit-mask:linear-gradient(180deg,#000 0%,transparent 55%);
            mask:linear-gradient(180deg,#000 0%,transparent 55%);
    opacity:.9;
  }
  /* diagonal sheen */
  .eleven-tile::after{
    content:""; position:absolute; inset:0;
    border-radius:inherit; pointer-events:none;
    background:var(--glass-sheen);
    opacity:.5;
    transition:opacity var(--dur-glass,220ms) var(--ease-glass);
  }
  .eleven-tile svg{ position:relative; z-index:1; }

  /* ===== GOLD treatment — shared by hover AND active =====
     (active is class-driven so touch devices get gold with no hover) */
  .eleven-tile.is-gold,
  .eleven-nav-item:hover .eleven-tile{
    color:var(--gold-200,#F4E4B0);
    background:var(--glass-gold-surface);
    border-color:var(--glass-gold-border);
    box-shadow:var(--glass-gold-shadow);
    transform:var(--glass-lift,translateY(-2px));
  }
  .eleven-tile.is-gold::before,
  .eleven-nav-item:hover .eleven-tile::before{
    border-top-color:var(--glass-gold-border-top);
  }
  .eleven-tile.is-gold::after,
  .eleven-nav-item:hover .eleven-tile::after{ opacity:.85; }

  @media (prefers-reduced-motion: reduce){
    .eleven-tile{ transition:color 120ms linear, background 120ms linear; }
    .eleven-tile.is-gold,
    .eleven-nav-item:hover .eleven-tile{ transform:none; }
  }`;
  const tag = document.createElement("style");
  tag.id = "eleven-glass-nav-icon";
  tag.textContent = css;
  document.head.appendChild(tag);
}

/**
 * GlassNavIcon — a frosted-glass tile wrapping a monochrome line icon.
 * Rest (default) = neutral black-&-white glass. state="gold" forces the
 * champion-gold hover/active treatment (also fires on `.eleven-nav-item:hover`).
 */
export function GlassNavIcon({ icon, size = 20, state = "rest", className = "" }) {
  injectGlassNavStyles();
  const cls = ["eleven-tile", state === "gold" ? "is-gold" : "", className].filter(Boolean).join(" ");
  return (
    <span className={cls}>
      <GlyphSVG icon={icon} size={size} />
    </span>
  );
}
