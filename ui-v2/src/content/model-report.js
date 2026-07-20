// WC2026 final model report — STATIC verified numbers, frozen after the Final (19 July 2026).
// Every figure was computed against predictions locked BEFORE the games they score: the pre-tournament
// simulation + per-match predictions (frozen 4 June), the post-group K=60 knockout engine, and the AI
// co-predictor's stored picks. Display only — nothing here recomputes. Project: ahcfrgxczbgdvrqmbisw

export const REPORT = {
  final: {
    headline: "Spain are World Cup champions",
    scoreline: "Spain 1–0 Argentina",
    when: "Final · 19 July 2026 · New York/New Jersey",
    extras: "England finished third (6–4 over France). Kylian Mbappé took the Golden Boot with 10 goals.",
  },

  // The easy version — the four numbers a visitor should leave with.
  headlineTiles: [
    { value: "#1", label: "Our top pick won it", detail: "We rated Spain the most likely champion before a ball was kicked — at 21.9% across 20,000 simulated tournaments. They lifted the trophy." },
    { value: "81%", label: "Knockout matches called right", detail: "Our favourite won 26 of the 32 knockout ties — including a perfect run through the quarter-finals, semi-finals and the Final." },
    { value: "61%", label: "Group games called right", detail: "44 of 72 group games across win / draw / win — random guessing gets 33%." },
    { value: "4/4", label: "The final four, named in advance", detail: "The four semi-finalists were exactly our simulation's four most likely — and our top two, Spain and Argentina, met in the Final." },
  ],

  engines: {
    math: {
      title: "The math engine",
      body: "Elo ratings re-learned from every result (K=60), a draw-aware match model, and 20,000 full-tournament simulations priced every game and the whole bracket. It called the Final at 51–49 for Spain — its narrowest knockout call of the tournament, and correct.",
    },
    ai: {
      title: "The AI co-predictor",
      body: "From the round of 16, an AI read the sourced national press stories, the form and the head-to-heads, and published its own call beside the math — free to disagree. It went 12 of 16, and its boldest moment beat the math: Norway over Brazil, exact 2–1 scoreline.",
    },
  },

  sim: {
    note: "20,000 tournament simulations, frozen 4 June — a week before kickoff.",
    top: [
      { rank: 1, team: "Spain", champ: "21.9%", sf: "44.5%", finish: "Champions", medal: true },
      { rank: 2, team: "Argentina", champ: "19.9%", sf: "42.2%", finish: "Runners-up", medal: true },
      { rank: 3, team: "France", champ: "17.9%", sf: "41.4%", finish: "Fourth" },
      { rank: 4, team: "England", champ: "6.7%", sf: "24.1%", finish: "Third", medal: true },
      { rank: 5, team: "Brazil", champ: "4.8%", sf: "21.0%", finish: "Out in R16 (to Norway)" },
      { rank: 6, team: "Colombia", champ: "4.5%", sf: "—", finish: "Out in R16 (to Switzerland, pens)" },
    ],
    groupFacts: [
      { v: "9/12", l: "predicted group winners won their group (the misses: USA, Germany and Colombia beat our Türkiye, Ecuador and Portugal picks)" },
      { v: "18/24", l: "predicted top-two teams finished top two — and two of the six misses (Paraguay, Ecuador) still advanced as best thirds" },
      { v: "4/4", l: "actual semi-finalists were the sim's four highest-rated teams to reach the semis" },
    ],
  },

  groups: {
    stats: [
      { v: "44/72", l: "three-way favourite won (61% — random is 33%)" },
      { v: "0.613", l: "Brier score vs 0.667 for uniform guessing (lower is better)" },
      { v: "1.041", l: "log-loss vs 1.099 uniform (lower is better)" },
      { v: "20", l: "draws (28% of games) — like nearly all football models, the draw was never the modal pick" },
    ],
    calibration: [
      { priced: "~38%", games: 22, won: "45%", read: "fair" },
      { priced: "~45%", games: 38, won: "68%", read: "underconfident — favourites beat their price" },
      { priced: "~55%", games: 10, won: "70%", read: "underconfident" },
      { priced: "~62%", games: 2, won: "50%", read: "too few games to judge" },
    ],
    lesson: "The honest lesson for 2030: mid-priced favourites won far more often than the model believed. A sharper group-stage prior is free accuracy.",
  },

  knockout: {
    perRound: [
      { round: "Round of 32", rec: "13/16" },
      { round: "Round of 16", rec: "6/8" },
      { round: "Quarter-finals", rec: "4/4" },
      { round: "Semi-finals", rec: "2/2" },
      { round: "Third-place play-off", rec: "0/1" },
      { round: "Final", rec: "1/1" },
    ],
    brier: "0.150",
    upsets: [
      { tie: "Paraguay over Germany", round: "R32", fav: "GER 65%", result: "1–1, 4–3 pens", kind: "shootout" },
      { tie: "Morocco over Netherlands", round: "R32", fav: "NED 67%", result: "1–1, 3–2 pens", kind: "shootout" },
      { tie: "Egypt over Australia", round: "R32", fav: "AUS 58%", result: "1–1, 4–2 pens", kind: "shootout" },
      { tie: "Norway over Brazil", round: "R16", fav: "BRA 61%", result: "2–1", kind: "open play" },
      { tie: "Switzerland over Colombia", round: "R16", fav: "COL 63%", result: "0–0, 4–3 pens", kind: "shootout" },
      { tie: "England over France", round: "3rd place", fav: "FRA 64%", result: "6–4", kind: "open play" },
    ],
    upsetNote: "Four of the six upsets were penalty shootouts — level ties the model had priced as close, decided by what is effectively a coin flip. In open play the favourite lost just twice in 32 ties.",
  },

  ai: {
    record: [
      { v: "12/16", l: "the AI's own picks that won (the math went 13/16 on the same ties)" },
      { v: "3", l: "times it disagreed with the math — the math won two, the AI won one" },
      { v: "1", l: "exact scoreline called — and it was the big one" },
    ],
    divergences: [
      { tie: "Brazil v Norway (R16)", model: "BRA 61%", ai: "Norway — “a narrow lean, likely 2-1”", result: "Norway 2–1", verdict: "AI right — exact scoreline", aiWon: true },
      { tie: "Mexico v England (R16)", model: "ENG 67%", ai: "Mexico — “a narrow lean, likely 1-0”", result: "England 3–2", verdict: "Math right", aiWon: false },
      { tie: "Spain v Argentina (Final)", model: "ESP 51%", ai: "Argentina — “a coin-flip lean, 2-1”", result: "Spain 1–0", verdict: "Math right", aiWon: false },
    ],
    note: "The Norway call was the point of the whole design: the AI weighed Haaland's scoring streak, Norway's never-lost-to-Brazil history and Paquetá's absence against the rating gap, disagreed with the math — and named the exact score of the math's only open-play miss before the final weekend.",
  },

  benchmarks: {
    internal: [
      { model: "Our model (draw-aware + K=60 updating)", groups: "44/72", ko: "26/32", brier: "0.150", extra: "full probabilities, calibration + a 20,000-run simulation", ours: true },
      { model: "Frozen pre-tournament world Elo", groups: "44/72", ko: "24/32", brier: "0.151", extra: "match odds only, never updates" },
      { model: "FIFA-ranking favourite", groups: "43/72", ko: "26/32", brier: "—", extra: "picks only — no odds, no simulation" },
    ],
    internalNote: "In a tournament this favourite-friendly, raw pick accuracy barely separates ranking systems. The K=60 in-tournament re-rating changed the pick on exactly two knockout ties versus frozen Elo — Mexico over the Ecuador pick, Belgium over the Senegal pick — and won both.",
    publicField: [
      { who: "Our simulation (20k runs, 4 Jun)", spain: "21.9%", top4: "ESP · ARG · FRA · ENG", aged: "4/4 — and #1/#2 were the Final", ours: true },
      { who: "Opta supercomputer (25k runs, 1 Jun)", spain: "16.1%", top4: "ESP · FRA · ENG · ARG", aged: "4/4" },
      { who: "Silver Bulletin “PELE” (100k runs)*", spain: "co-favourite", top4: "ESP · ARG · ENG · FRA", aged: "4/4, exact order*" },
      { who: "KU Leuven DTAI — ESPN's model (5 Jun)", spain: "#1 pick", top4: "ESP · ARG · FRA · ENG", aged: "4/4" },
      { who: "Goldman Sachs (Elo, 29 May)", spain: "26%", top4: "ESP · FRA · ARG · BRA", aged: "3/4 — England underrated" },
      { who: "Univ. of Liverpool (12 Jun)", spain: "26.1%", top4: "predicted an England–Spain final", aged: "right champion, wrong finalist" },
      { who: "BBC pundit panel (10 Jun)", spain: "1 of 17 votes", top4: "majority pick: France", aged: "consensus wrong" },
      { who: "Al Jazeera's 9-LLM panel (14 Jul)", spain: "0 votes", top4: "France 5 · Argentina 4", aged: "all wrong" },
    ],
    publicNote: "Every serious quantitative model made Spain the favourite; the separation was in the probabilities and the shape of the top four. Ours sat between Opta and Goldman on Spain, and was one of the few whose top four was exactly the real final four — which Goldman and both pundit majorities missed. *PELE's figures come from the author's post-final recap.",
  },

  ops: [
    { v: "104/104", l: "matches captured with verified result, final xG, player ratings and a full event timeline" },
    { v: "64", l: "AI match stories published (32 previews + 32 post-match), every one validated before it shipped" },
    { v: "156", l: "automatic site updates by the live pipeline, from kickoff to the Final" },
    { v: "51–49", l: "the model's call on the Final itself — its closest knockout call, and correct" },
  ],

  method: "Pre-tournament claims are scored against the simulation and per-match predictions frozen 4 June 2026. Knockout claims use the post-group K=60 per-tie probabilities published before each tie. Shootout wins count as wins. Baselines: uniform three-way guessing (Brier 0.667, log-loss 1.099) and random favourites (33% groups, 50% knockouts). Simulation outputs, not betting odds.",
};
