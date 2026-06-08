-- ============================================================================
-- 20260601020000_historical_matches_canonical_v2_1
-- ============================================================================
-- Source-aware canonical merge layer for the v2.1 rebuild (api-football + MartJ).
-- ADDITIVE: creates one new table + indexes + RLS. Creates NO rows. Does NOT
-- modify/drop/alter any existing table. historical_matches stays the immutable
-- raw store; v1.3 remains sealed. Materialization (INSERT ... SELECT) is a
-- separate, later, explicitly-approved step.
-- Design + review: docs/source-aware-v2.1-canonical-ddl-execution.md,
--   docs/source-aware-v2.1-canonical-ddl-dry-run.md,
--   docs/source-aware-v2.1-manual-review-queue.md
-- Executed one statement at a time (the project CLI rejects multi-statement files).
-- ============================================================================

create table if not exists public.historical_matches_canonical_v2_1 (
  id                            uuid primary key default gen_random_uuid(),
  canonical_match_key           text not null unique,
  canonical_match_date          timestamptz not null,
  canonical_team_a_identity_id  uuid,
  canonical_team_b_identity_id  uuid,
  canonical_team_a_name         text not null,
  canonical_team_b_name         text not null,
  canonical_team_a_score        integer,
  canonical_team_b_score        integer,
  competition                   text,
  competition_family            text,
  source_priority               text not null,
  canonical_source_provider     text not null,
  canonical_historical_match_id uuid not null,
  duplicate_group_id            text,
  source_evidence               jsonb not null default '[]'::jsonb,
  senior_scope_class            text not null,
  exclusion_status              text not null default 'included',
  exclusion_reason              text,
  review_status                 text not null default 'approved',
  source_hash                   text,
  first_trainable_date          date,
  backtest_split                text not null,
  holdout_group                 text,
  is_training_candidate         boolean not null default false,
  is_holdout_candidate          boolean not null default false,
  leakage_boundary_date         date,
  leakage_policy_version        text default 'v2.1-temporal-holdout-2025',
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  constraint hmc_v21_distinct_teams         check (canonical_team_a_name <> canonical_team_b_name),
  constraint hmc_v21_distinct_team_ids      check (canonical_team_a_identity_id is distinct from canonical_team_b_identity_id),
  constraint hmc_v21_scores_nonneg          check ((canonical_team_a_score is null or canonical_team_a_score >= 0) and (canonical_team_b_score is null or canonical_team_b_score >= 0)),
  constraint hmc_v21_review_status_chk       check (review_status in ('approved','manual_review_needed','excluded')),
  constraint hmc_v21_exclusion_status_chk    check (exclusion_status in ('included','excluded','evidence_only')),
  constraint hmc_v21_source_provider_chk     check (canonical_source_provider in ('api-football','martj','manual_review')),
  constraint hmc_v21_source_priority_chk     check (source_priority in ('api_football_primary','martj_primary','manual_review')),
  constraint hmc_v21_backtest_split_chk      check (backtest_split in ('train_pre_2025','holdout_2025_2026','excluded','manual_review')),
  constraint hmc_v21_source_evidence_is_array check (jsonb_typeof(source_evidence) = 'array')
);

create index if not exists hmc_v21_date_idx           on public.historical_matches_canonical_v2_1 (canonical_match_date);
create index if not exists hmc_v21_team_a_idx         on public.historical_matches_canonical_v2_1 (canonical_team_a_identity_id);
create index if not exists hmc_v21_team_b_idx         on public.historical_matches_canonical_v2_1 (canonical_team_b_identity_id);
create index if not exists hmc_v21_source_idx         on public.historical_matches_canonical_v2_1 (canonical_source_provider);
create index if not exists hmc_v21_review_idx         on public.historical_matches_canonical_v2_1 (review_status);
create index if not exists hmc_v21_competition_idx    on public.historical_matches_canonical_v2_1 (competition_family);
create index if not exists hmc_v21_dupgroup_idx       on public.historical_matches_canonical_v2_1 (duplicate_group_id);
create index if not exists hmc_v21_backtest_split_idx on public.historical_matches_canonical_v2_1 (backtest_split);
create index if not exists hmc_v21_holdout_group_idx  on public.historical_matches_canonical_v2_1 (holdout_group);
create index if not exists hmc_v21_evidence_gin_idx   on public.historical_matches_canonical_v2_1 using gin (source_evidence);

alter table public.historical_matches_canonical_v2_1 enable row level security;

comment on table public.historical_matches_canonical_v2_1 is 'Source-aware canonical merge of api-football + MartJ historical matches for the v2.1 rebuild. Derived layer; historical_matches remains the immutable raw store and v1.3 stays sealed. Created empty 2026-06-01; materialization is a separate approved step.';
