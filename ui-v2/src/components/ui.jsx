import { useState } from "react";

// Reusable Apple-style UI primitives. Color stays accent-only; everything else neutral.

const HOST_RING = { CAN: "glass-flag--host-can", MEX: "glass-flag--host-mex", USA: "glass-flag--host-usa" };

// Real self-hosted flag (flags/{CODE}.png). Falls back to a neutral monogram on miss/error.
// Host nations get a subtle tinted ring (host context = meaning).
export function Flag({ team, size = 40, className = "" }) {
  const [err, setErr] = useState(false);
  const code = (team && team.code) || "";
  const url = team && team.flag ? `${import.meta.env.BASE_URL}${team.flag}` : null;
  const ring = HOST_RING[code] || "";
  if (!url || err) return <Monogram code={code} size={size} className={className} />;
  return (
    <span className={`glass-flag ${ring} ${className}`} style={{ width: size, height: size }} aria-hidden="true">
      <img
        src={url}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        onError={() => setErr(true)}
        className="glass-flag__img"
      />
    </span>
  );
}

// Soft floating card (defined by fill + soft shadow, no hard border).
export function Card({ className = "", children, ...rest }) {
  return (
    <div className={`card ${className}`} {...rest}>
      {children}
    </div>
  );
}

// Skeleton block — conveys structure for Stage-1 placeholders.
export function Skeleton({ w = "100%", h = 12, className = "", style }) {
  return (
    <span
      className={`block rounded-md bg-fill/10 animate-pulse ${className}`}
      style={{ width: w, height: h, ...style }}
      aria-hidden="true"
    />
  );
}

// Honest "this is placeholder" chip.
export function PlaceholderTag({ className = "" }) {
  return (
    <span
      className={`inline-flex items-center rounded-full bg-fill/10 px-2 py-0.5 text-[11px] font-medium text-ink-2 ${className}`}
    >
      Placeholder
    </span>
  );
}

// Crest/flag stand-in: neutral rounded monogram. Host nations get a subtle tinted ring.
export function Monogram({ code = "", size = 40, host = null, className = "" }) {
  const ring = host === "can" ? "ring-host-can" : host === "mex" ? "ring-host-mex" : host === "usa" ? "ring-host-usa" : "";
  return (
    <span
      className={`inline-grid shrink-0 place-items-center rounded-full bg-fill/10 font-semibold tracking-tight text-ink-2 ${
        host ? `ring-2 ${ring}` : ""
      } ${className}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.3) }}
      aria-hidden="true"
    >
      {code}
    </span>
  );
}

// iOS segmented control as a glass object: a recessed frosted-glass trough (.glass-track) with a
// raised NEUTRAL glass thumb (.glass-thumb) that slides — same rim/sheen/depth language as the
// nav glass, but colorless. Active label stays neutral (text-ink); no tint.
export function SegmentedTabs({ tabs, value, onChange, className = "" }) {
  const i = Math.max(0, tabs.indexOf(value));
  return (
    <div className={`glass-track relative flex rounded-[12px] p-1 ${className}`} role="tablist">
      <span
        className="glass-thumb pointer-events-none absolute bottom-1 left-1 top-1 rounded-[9px] transition-transform duration-300 ease-out"
        style={{ width: `calc((100% - 8px) / ${tabs.length})`, transform: `translateX(${i * 100}%)` }}
      />
      {tabs.map((t) => (
        <button
          key={t}
          role="tab"
          aria-selected={value === t}
          onClick={() => onChange(t)}
          className={`relative z-10 min-h-[36px] flex-1 rounded-[9px] text-[13px] font-medium transition-colors ${
            value === t ? "text-ink" : "text-ink-2"
          }`}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

// One inset-grouped list inside a card: rows with hairlines that inset from the left.
export function List({ children, className = "" }) {
  return <ul className={`card overflow-hidden ${className}`}>{children}</ul>;
}

export function Row({ children, inset = 20, last = false, className = "", ...rest }) {
  return (
    <li className={`relative flex items-center gap-3 px-5 ${className}`} {...rest}>
      {children}
      {!last && <span className="hairline absolute bottom-0 right-0 h-px" style={{ left: inset }} />}
    </li>
  );
}

export function InfoTip({ children, label = "About this number", className = "" }) {
  const [open, setOpen] = useState(false);
  return (
    <span className={`relative inline-flex shrink-0 align-middle ${className}`} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onMouseEnter={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="inline-grid h-5 w-5 place-items-center rounded-full bg-fill/10 text-[11px] font-bold leading-none text-ink-2 ring-1 ring-separator/70 transition hover:bg-fill/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 active:scale-95"
      >
        i
      </button>
      {open && (
        <span
          role="tooltip"
          className="pointer-events-none absolute right-0 top-[calc(100%+0.4rem)] z-50 w-64 max-w-[calc(100vw-2rem)] rounded-[12px] bg-bg/95 px-3 py-2 text-left text-[12px] font-medium leading-snug text-ink-2 shadow-[0_12px_30px_rgba(0,0,0,0.20)] ring-1 ring-separator/70 backdrop-blur-xl"
        >
          {children}
        </span>
      )}
    </span>
  );
}
