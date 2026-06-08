-- ============================================================================
-- DESIGN ARTIFACT ONLY. Superseded by applied migration
-- supabase/migrations/20260601020000_historical_matches_canonical_v2_1.sql
-- Do not apply this file. It is retained for provenance/reference.
-- ============================================================================
-- DRY_RUN_ONLY — historical_matches_canonical_v2_1
-- ============================================================================
-- STATUS: DRY-RUN DESIGN ONLY. DO NOT EXECUTE.
-- This file is a planning artifact for review. It is intentionally named
-- DRY_RUN_ONLY_* (not a timestamped migration) so the Supabase CLI will not pick
-- it up as an applmigration. It is ADDITIVE (new table only), creates NO rows,
-- and touches NO existing table. v1.3 remains sealed.
--
-- Materialization is BLOCKED until the 19-item manual-review queue is resolved
-- (14 >30h duplicate pairs + 5 +-2-day score-conflict candidates). See
-- docs/source-aware-v2.1-manual-review-queue.md and
-- docs/source-aware-v2.1-canonical-ddl-dry-run.md.
-- ============================================================================

-- create extension if not exists pgcrypto;  -- for gen_random_uuid(), if not present

create table if not exists public.historical_matches_canonical_v2_1 (
  id                          uuid primary key default gen_random_uuid(),

  -- canonical identity of the fixture (order-insensitive key + explicit home/away)
  canonical_match_key         text not null unique,        -- e.g. '<low_id>|<high_id>|<canonical_date>'
  canonical_match_date        timestamptz not null,
  canonical_team_a_identity_id uuid,                        -- -> national_team_identity_map.id (home/first)
  canonical_team_b_identity_id uuid,                        -- -> national_team_identity_map.id (away/second)
  canonical_team_a_name       text not null,
  canonical_team_b_name       text not null,
  canonical_team_a_score      integer,
  canonical_team_b_score      integer,

  -- competition
  competition                 text,                         -- raw label of the canonical source row
  competition_family          text,                         -- normalized: Friendlies~Friendly, WC-Qual *~FIFA WC qual, ...

  -- provenance / dedup
  source_priority             text not null,                -- api_football_primary | martj_primary
  canonical_source_provider   text not null,                -- api-football | martj | manual_review
  canonical_historical_match_id uuid not null,              -- -> historical_matches.id of the chosen primary row
  duplicate_group_id          text,                         -- non-null when part of a cross-source duplicate group
  source_evidence             jsonb not null default '[]'::jsonb,

  -- senior-scope + review
  senior_scope_class          text not null,                -- senior_a_team_safe | likely_senior_a_team | chan_or_local_squad | ...
  exclusion_status            text not null default 'included', -- included | excluded | evidence_only
  exclusion_reason            text,
  review_status               text not null default 'approved',  -- approved | manual_review_needed | excluded
  source_hash                 text,

  -- temporal holdout / train-test (baked in so backtests cannot leak via forgotten query filters)
  first_trainable_date        date,
  backtest_split              text not null,                -- train_pre_2025 | holdout_2025_2026 | excluded | manual_review
  holdout_group               text,                         -- e.g. 'h_2025q1', for grouped CV; nullable
  is_training_candidate       boolean not null default false,
  is_holdout_candidate        boolean not null default false,
  leakage_boundary_date       date,                         -- features for this row may only use data strictly before this
  leakage_policy_version      text default 'v2.1-temporal-holdout-2025',

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  -- ---- constraints ----
  constraint hmc_v21_distinct_teams        check (canonical_team_a_name <> canonical_team_b_name),
  constraint hmc_v21_distinct_team_ids     check (canonical_team_a_identity_id is distinct from canonical_team_b_identity_id),
  constraint hmc_v21_scores_nonneg         check ((canonical_team_a_score is null or canonical_team_a_score >= 0)
                                                 and (canonical_team_b_score is null or canonical_team_b_score >= 0)),
  constraint hmc_v21_review_status_chk      check (review_status in ('approved','manual_review_needed','excluded')),
  constraint hmc_v21_exclusion_status_chk   check (exclusion_status in ('included','excluded','evidence_only')),
  constraint hmc_v21_source_provider_chk    check (canonical_source_provider in ('api-football','martj','manual_review')),
  constraint hmc_v21_source_priority_chk    check (source_priority in ('api_football_primary','martj_primary','manual_review')),
  constraint hmc_v21_backtest_split_chk     check (backtest_split in ('train_pre_2025','holdout_2025_2026','excluded','manual_review')),
  constraint hmc_v21_source_evidence_is_array check (jsonb_typeof(source_evidence) = 'array')
);

-- ---- indexes ----
create index if not exists hmc_v21_date_idx          on public.historical_matches_canonical_v2_1 (canonical_match_date);
create index if not exists hmc_v21_team_a_idx        on public.historical_matches_canonical_v2_1 (canonical_team_a_identity_id);
create index if not exists hmc_v21_team_b_idx        on public.historical_matches_canonical_v2_1 (canonical_team_b_identity_id);
create index if not exists hmc_v21_source_idx        on public.historical_matches_canonical_v2_1 (canonical_source_provider);
create index if not exists hmc_v21_review_idx        on public.historical_matches_canonical_v2_1 (review_status);
create index if not exists hmc_v21_competition_idx   on public.historical_matches_canonical_v2_1 (competition_family);
create index if not exists hmc_v21_dupgroup_idx      on public.historical_matches_canonical_v2_1 (duplicate_group_id);
create index if not exists hmc_v21_backtest_split_idx on public.historical_matches_canonical_v2_1 (backtest_split);
create index if not exists hmc_v21_holdout_group_idx on public.historical_matches_canonical_v2_1 (holdout_group);
create index if not exists hmc_v21_evidence_gin_idx  on public.historical_matches_canonical_v2_1 using gin (source_evidence);

-- ---- RLS: default-deny (matches the project's Phase-0 posture; service_role/postgres bypass) ----
alter table public.historical_matches_canonical_v2_1 enable row level security;
-- No permissive policies are created -> anon/authenticated are denied by default.
-- (Backend access uses service_role / the postgres pooler role, which bypasses RLS.)

comment on table public.historical_matches_canonical_v2_1 is
  'DRY-RUN DESIGN. Source-aware canonical merge of api-football + MartJ historical matches for the v2.1 rebuild. Derived layer; historical_matches remains the immutable raw store and v1.3 stays sealed. Materialization blocked until the 19-item manual-review queue is resolved.';

-- ============================================================================
-- source_evidence[] element shape (documented; enforced in app/build layer):
-- {
--   "historical_match_id": uuid,
--   "source_provider":     "api-football" | "martj_international_results",
--   "source_match_id":     text,            -- API fixture id (api-football) or row hash (martj)
--   "original_team_a":     text,
--   "original_team_b":     text,
--   "original_match_date": timestamptz,
--   "original_score":      "a-b",
--   "competition":         text,
--   "venue":               text | null,     -- api-football only; martj lacks venue
--   "round":               text | null,     -- api-football only; martj lacks round
--   "orientation":         "same" | "reversed",
--   "evidence_role":       "canonical" | "secondary" | "excluded_scope" | "manual_review",
--   "source_hash":         text
-- }
-- ============================================================================
-- DO NOT EXECUTE. Materialization (INSERT ... SELECT) is a separate, later,
-- explicitly-approved step that runs only after the 19-item review queue is cleared.
