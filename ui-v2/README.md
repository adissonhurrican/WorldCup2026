# WC2026 Prediction UI — v2

Project: `ahcfrgxczbgdvrqmbisw`

A from-scratch React + Vite + Tailwind rebuild of the prediction front-end. **Stage 2 — the real `app-data.json` contract is wired into the Stage 1 Apple-clean shell.** The old flat-stack `ui/` is kept intact as reference.

## Run

```bash
cd ui-v2
npm install
npm run dev      # http://localhost:5173  (mobile-reachable on your LAN)
npm run build    # production build -> dist/
npm run preview  # serve the build
```

Mobile-first — view it in a phone-width window (or DevTools device mode) for the intended native feel.

## Stage 2 scope (done) — real data wired

- **My Team header:** real self-hosted flag + name + nickname line (`{english} · {local} · Group X` from `nicknames.json`; blank codes like SCO → just the group) + host-nation ring; tap → 48-team switcher sheet.
- **Hero:** the team's `advance` % + **phase-aware finish line** — pre-tournament "predicted finish · Nth" (band-colored), live "now · Nth" from `real_standings.position` with ▲/▼ vs predicted. Rainbow hairline kept.
- **AI summary directly under the hero, before the tabs** — the `narration` block (matched by team name), grounded + model-labeled, empty-guard preserved; bubble/3rd teams also get the conditional engine (`scenarios.routes`, in-their-hands, best-third race).
- **Tabs:** Overview (reach grid from `team_paths.knockout`) · Standing (three-band `real_standings` table, focal row, full P/W/D/L/GF/GA/GD/Pts, best-third IN/OUT, graceful not-started) · Path (`knockout_paths` 1st/2nd/3rd-conditional with venue, opponent, date/window) · Squad (coach + formation from `tactical_context`; graceful note that players/FIFA-rank aren't in the export yet).
- **Matches:** real fixtures grouped by your local date, each a tappable **two-color card** with the **dual clock** (venue-local + your time from `venue_timezone`), venue, prediction, a **weather chip** (imminent + forecast only), and a **LIVE badge + in-play score** while a match is live (from the polled `live-scores.json`, shown distinctly from the pre-match prediction — never blended, never a model input). Tap → match sheet with kickoff, venue, prediction, live banner, and a **weather section**.
- **Groups — three layers:** a cross-group **best-third race strip** (from `best_third_race`, tap to expand), a **Predicted / Live toggle** over all 12 cards, and the 12 group cards (tap a team → its My Team view).
- Light **and** dark mode; pre-tournament renders gracefully everywhere.

## Design language

Apple-clean base — neutral white/dark surfaces, generous whitespace, system font stack, big confident numbers, soft 18px-radius cards defined by fill + soft shadow (no hard borders), inset-grouped lists (hairlines that inset from the left). **WC2026 color is a semantic accent only** (~90% neutral):

- Finish states — green `#1D9E75` (qualified 1st/2nd) / amber `#EF9F27` (bubble 3rd) / neutral-gray (out 4th), shown on the position number.
- Host nations — Canada red `#E24B4A`, Mexico green `#1D9E75`, USA blue `#378ADD` (subtle ring).
- The "We Are 26" rainbow — a single thin line under the hero, never a wash.
- App tint (`accent`) on the active tab / selection.

Color tokens live as theme-aware CSS variables in `src/index.css`; Tailwind maps them in `tailwind.config.js`.

## Architecture — reads `app-data.json` + static display assets only

The v2 UI reads the published **`app-data.json`** contract plus a few **static display assets**, and nothing else — **no DB, no model, no prediction/export logic, no client-side API-Football**. `src/lib/appData.js` (`loadAll`) does the reads; `src/lib/select.js` surfaces existing blocks (no recompute). Static assets, all display-only:

- `public/flags/{CODE}.png` — crests (referenced by the contract).
- `public/nicknames.json` — team identity overlay (english/local), merged onto teams.
- `public/venue-facts.json` — altitude / roof / capacity / coordinates (from `stadium_facts_static_v1.json`; `prediction_input_allowed:false`).
- `public/venues.json` — verified host-city / venue profiles keyed by `venue_id`; used by the tappable venue card in match details. Display-only; never a model input.
- `public/weather.json` — per-fixture forecast overlay, keyed `HOME_AWAY`. **Empty until forecasts exist.** Build it with `node scripts/worldcup/weather/build-weather-overlay.mjs --write` after `fetch-venue-weather.mjs --fetch --all-imminent` runs inside the 72h window. Weather is forecast context only — never a model input.
- `public/live-scores.json` — in-play scores overlay, keyed `HOME_AWAY`, polled ~every 30s. **Written server-side** by `scripts/worldcup/live/write-live-scores.ts` (the client never calls API-Football). During match windows run: `npx tsx scripts/worldcup/live/write-live-scores.ts --watch --interval 30 --out ui-v2/public/live-scores.json`. Display-only; shown only while a match is live; never a prediction input.

Contract top-level keys (unchanged): `meta, teams, groups, fixtures, team_paths, scenarios, narration, tactical_context, real_standings, knockout_paths`.

## Structure

```
ui-v2/
  index.html               # theme-before-paint, viewport-fit=cover
  src/
    main.jsx  App.jsx       # shell: theme + nav + switcher state
    index.css               # design tokens (CSS vars) + card/rainbow primitives
    components/
      TabBar.jsx Screen.jsx TeamSheet.jsx ThemeToggle.jsx ui.jsx icons.jsx
    views/
      MyTeamView.jsx MatchesView.jsx GroupsView.jsx
    lib/
      appData.js            # Stage-2 loader (unused in Stage 1)
      placeholders.js       # Stage-1 placeholder strings
  public/app-data.json      # read-only copy of the contract (for Stage 2)
```
