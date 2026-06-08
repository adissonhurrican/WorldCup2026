/** @type {import('tailwindcss').Config} */
// Apple-clean base + WC2026 color as SEMANTIC ACCENT only.
// Surfaces/text are theme-aware CSS vars (see src/index.css) so dark mode is a class flip.
// Fixed-meaning colors (host nations, state greens/ambers) are tuned per mode via vars too.
export default {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: "rgb(var(--c-bg) / <alpha-value>)",
        surface: "rgb(var(--c-surface) / <alpha-value>)",
        "surface-2": "rgb(var(--c-surface-2) / <alpha-value>)",
        ink: "rgb(var(--c-text) / <alpha-value>)",
        "ink-2": "rgb(var(--c-text-2) / <alpha-value>)",
        "ink-3": "rgb(var(--c-text-3) / <alpha-value>)",
        separator: "rgb(var(--c-separator) / <alpha-value>)",
        fill: "rgb(var(--c-fill) / <alpha-value>)",
        // semantic state (finish bands)
        qualified: "rgb(var(--c-qualified) / <alpha-value>)",
        bubble: "rgb(var(--c-bubble) / <alpha-value>)",
        // host nations
        "host-can": "#E24B4A",
        "host-mex": "#1D9E75",
        "host-usa": "#378ADD",
        // app tint (selection / hero)
        accent: "rgb(var(--c-accent) / <alpha-value>)",
        // active navigation tint — Vancouver host-city color (theme-tuned via --c-nav)
        nav: "rgb(var(--c-nav) / <alpha-value>)",
        // live in-play indicator (display-only feed)
        live: "#E5484D",
      },
      borderRadius: { card: "18px" },
      boxShadow: {
        card: "var(--shadow-card)",
        tab: "0 -0.5px 0 rgb(var(--c-separator) / 0.6)",
      },
      fontFamily: {
        sans: [
          "-apple-system", "BlinkMacSystemFont", '"SF Pro Display"', '"SF Pro Text"',
          '"Segoe UI"', "Roboto", "system-ui", "sans-serif",
        ],
      },
      keyframes: {
        panelIn: { "0%": { opacity: "0", transform: "translateY(6px)" }, "100%": { opacity: "1", transform: "none" } },
        sheetIn: { "0%": { transform: "translateY(100%)" }, "100%": { transform: "translateY(0)" } },
      },
      animation: { panel: "panelIn .28s cubic-bezier(.4,0,.2,1)" },
    },
  },
  plugins: [],
};
