-- 20260609_player_bio_columns.sql
-- Player-card feature, Phase 1 (data layer). ADDITIVE-ONLY.
--   Adds 5 nullable bio columns to players. No existing column is modified or dropped.
--   date_of_birth already existed (backfilled by backfill-player-bios.mjs, not added here).
--   photo is a DERIVED URL (https://media.api-sports.io/football/players/{api_id}.png) — no column.
-- Safe: adding nullable columns with no default is a metadata-only change (no table rewrite, no lock contention).
-- Verified: protected-column checksum byte-identical before/after; api_football_player_id (1247 mapped) untouched.
ALTER TABLE players
  ADD COLUMN IF NOT EXISTS nationality   text,
  ADD COLUMN IF NOT EXISTS height_cm     integer,
  ADD COLUMN IF NOT EXISTS weight_kg     integer,
  ADD COLUMN IF NOT EXISTS birth_place   text,
  ADD COLUMN IF NOT EXISTS birth_country text;
