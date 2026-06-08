import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { SITE_TITLE, SITE_DESCRIPTION, SITE_URL, OG_SITE_NAME } from "./src/config.js";

// Inject SEO copy from src/config.js into index.html at build AND dev time, so the static
// <head> (read by crawlers/social scrapers that don't run JS) stays in sync with the single
// source of truth. Tokens in index.html use __NAME__ (not %NAME%, which Vite's HTML asset
// parser would decodeURI and reject inside href attributes). Runs `pre` to resolve before that parse.
function htmlSeo() {
  const map = {
    __SITE_TITLE__: SITE_TITLE,
    __SITE_DESCRIPTION__: SITE_DESCRIPTION,
    __SITE_URL__: SITE_URL,
    __OG_SITE_NAME__: OG_SITE_NAME,
  };
  return {
    name: "html-seo",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return html.replace(/__SITE_TITLE__|__SITE_DESCRIPTION__|__SITE_URL__|__OG_SITE_NAME__/g, (m) => map[m] ?? m);
      },
    },
  };
}

// Relative base so the built app can be served from any path. Dev server is mobile-reachable (host:true).
export default defineConfig({
  base: "./",
  plugins: [react(), htmlSeo()],
  server: { port: 5173, host: true },
});
