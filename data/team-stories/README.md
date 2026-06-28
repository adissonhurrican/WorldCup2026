# Team-story RAG files — authoring guide

Curated, **sourced** national-story context that grounds the AI's knockout narration in real reporting (the "meaning" the data can't carry). Design: `docs/ai-team-story-rag-design.md`. v0.8 prompt + worked sample: `docs/ai-team-story-rag-v0.8-draft.md`.

**Ships dark.** The pipeline loads `data/team-stories/{FIFA_CODE}.json`; a missing/invalid/unreviewed file → no story → narration runs exactly as today. So you can start filling files now, before the build lands, with zero risk.

---

## File naming
- One file per team: `{FIFA_CODE}.json` — 3-letter uppercase, e.g. `ESP.json`, `MAR.json`, `BRA.json`.
- Underscore-prefixed files (`_TEMPLATE.json`, `_outlet-allowlist.json`, `README.md`, `*.example.json`) are **meta** — the loader never reads them.

## How to author one
1. Copy `_TEMPLATE.json` → `{CODE}.json` and **delete the `_guidance` field**.
2. Research with the per-team prompt (in the project's RAG research doc). For every point, name the outlet + date, or write nothing.
3. Fill the fields (see field map below). Keep `review_status: "pending"` while drafting.
4. After an editorial check, set `review_status: "reviewed"` — **only `reviewed` files ship**.

## The golden rules (the file is the guardrail)
1. **No source = not in the file.** Every claim block & quote carries `source_tier` + `verification` + at least one `sources[]` entry (`outlet`, `url`, `date`, `lang`).
2. **Mood in words, never numbers.** Say "widely expected", not "70% of fans expect…". A bare number the AI echoes will fail the output validator and kill the whole narration.
3. **Quotes:** verbatim, ≤20 words; the AI uses at most 2. Each needs `speaker_name`, `speaker_role`, `outlet`, `url`, `date`. Non-English high-impact quotes keep `quote_original` + `lang`.
4. **Tiers:** `official` + `fact_grade` (FIFA / confederation / national federation) may be stated as fact. `discovery` + `attributed_context_only` (press) may ONLY be narrated as attributed reporting ("per Marca", "reports suggest"). Never tag press coverage as `official`.
5. **Confirmed availability does NOT go here.** A confirmed squad/withdrawal/injury is an official fact → it belongs in the news channel (handled by the pipeline), not this file. Only **reported/unconfirmed** availability goes in `local_availability_reporting` with `confirmed: false`.
6. **`gaps[]`** lists points you found no credible source for, so the AI leaves them alone (never fills them from training knowledge).
7. **Outlets must be on the allowlist** (`_outlet-allowlist.json`). Anything else uses `"other"` and requires a reviewer note.
8. **No odds / betting / predictions** sources, ever.

## Cadence
Refresh **per round, for advancing teams only, ahead of their matches** (R32 → R16 → QF → SF → Final). Stamp `last_updated` + `round` each time. Eliminated teams are not re-researched.

## Field map (research section → JSON field)
| Research section | JSON field |
|---|---|
| National Expectations | `national_expectations` |
| National Mood / Pressure | `national_mood` |
| Dominant Local Storylines | `dominant_storylines[]` |
| Manager Situation | `manager_situation` |
| Notable Quotes | `attributed_quotes[]` |
| Historical / Emotional Context | `historical_context` |
| Availability — *confirmed* | → news channel (not this file) |
| Availability — *reported* | `local_availability_reporting[]` (`confirmed: false`) |
| Source Quality Notes | `source_data_snapshot[]` |
| Gaps | `gaps[]` |
| "Source: outlet, date" lines | each block's `sources[]` |

A fully worked example (illustrative, placeholder URLs): `ESP.example.json`.
