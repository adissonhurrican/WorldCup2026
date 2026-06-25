// ============================================================================
// Single source of truth for product identity, SEO copy, and footer links.
// Imported by the runtime app (footer) AND injected into index.html at build/dev
// time by the transformIndexHtml hook in vite.config.js — so the static <head>
// tags and the runtime UI never drift apart. Pure constants only (no DOM/browser
// APIs) so it is safe to import from vite.config.js.
//
// Project: ahcfrgxczbgdvrqmbisw  (display/metadata only — no model/prediction/data)
// ============================================================================

// Final product name. Set ONCE here and it propagates everywhere (page title, Open
// Graph, About, How-it-works, footer brand line) via SITE_TITLE/OG_SITE_NAME/DISPLAY_NAME.
// (This is the PRODUCT/app name; the operating company below stays "MOST AI Labs".)
export const SITE_NAME = "Football Match Master";

// Company / contact (used in the footer and as the parked-name fallback).
export const COMPANY = "MOST AI Labs";
export const COMPANY_URL = "https://mostailabs.com";
export const CONTACT_EMAIL = "info@mostailabs.com";
export const SECURITY_LABEL = "XXL IT Services";
export const SECURITY_URL = "https://xxlservices.com";

// Canonical base URL — the product domain (used for the canonical link + og:url only).
// Keep robots.txt / sitemap.xml (in /public) in sync with this host when it changes.
export const SITE_URL = "https://footballmatchmaster.com";

// app-data.json is served BUILD-INDEPENDENTLY from GitHub raw — the in-tournament loop pushes the file to
// the repo on every refresh, so the SPA reads fresh data WITHOUT a Netlify rebuild. This is what lets data
// commits skip the Netlify build (see netlify.toml `ignore`), removing the build-usage freeze. The loader
// cache-busts every fetch (raw has a ~5-min CDN cache) and falls back to the Netlify-BUNDLED copy if raw
// fails/throttles (never-worse-than-today). Set to "" to disable and use the bundled copy only.
export const APP_DATA_REMOTE_URL =
  "https://raw.githubusercontent.com/adissonhurrican/WorldCup2026/main/ui-v2/public/app-data.json";

// Absolute Open Graph / Twitter share image (1200×630 PNG in /public → served at the domain root).
// Social scrapers REQUIRE an absolute URL, so it is built from SITE_URL — which also keeps it
// consistent with og:url and updates automatically if the domain ever changes.
export const OG_IMAGE = `${SITE_URL}/og-image.png`;

// Accurate framing — a STATISTICAL MODEL makes the predictions; AI only explains them.
// Never phrase this as "AI predicts the matches".
export const SITE_DESCRIPTION =
  "Match predictions powered by a statistical model, explained by AI — 2026 World Cup scores, lineups & analysis.";

// Short brand tagline (the nav subtitle + the in-app share-sheet text). Kept here so the
// share copy stays in sync with the product voice.
export const TAGLINE = "World Cup 2026 predictions, updated live";

// Derived metadata. When the product name is parked we use a clean, name-free title
// and fall back to the company name for og:site_name.
export const SITE_TITLE = SITE_NAME
  ? `${SITE_NAME} — 2026 World Cup predictions`
  : "2026 World Cup predictions";
export const OG_SITE_NAME = SITE_NAME || COMPANY;
