-- ============================================================================
-- 20260602010000_v2_1_feature_example_tables
-- ============================================================================
-- Source-aware v2.1 feature + training-example layer, built from
-- historical_matches_canonical_v2_1. ADDITIVE: two new parallel tables + RLS +
-- indexes. Creates NO rows (a separate build script populates them). Does NOT
-- modify/drop/alter historical_team_match_features / training_match_examples or
-- any v1.3 artifact. v1.3 remains sealed.
--
-- Design decisions (locked):
--   * Elo source = existing EXTERNAL team_elo_history (same source as v1.3);
--     only the example set changes. Point-in-time join: rating_date < match_date (strict).
--   * neutral_site is DROPPED entirely (user decision): v1.3's is_neutral was 100% NULL,
--     so dropping it keeps v2.1 behaviourally identical to v1.3 on neutrality and avoids
--     introducing a neutral-related change into the v2.1-vs-v1.3 comparison.
--   * team_*_identity_id holds national_team_identity_map.id (the Elo/dedup key), not teams.id.
-- Executed one statement at a time (the project CLI rejects multi-statement files).
-- ============================================================================

create table if not exists public.historical_team_match_features_v2_1 (
  id                     uuid primary key default gen_random_uuid(),
  canonical_match_id     uuid not null,
  historical_match_id    uuid not null,
  team_side              text not null,
  team_name              text not null,
  opponent_name          text not null,
  team_identity_id       uuid,
  opponent_identity_id   uuid,
  is_home                boolean not null,
  match_date             timestamptz not null,
  elo_before             numeric,
  elo_rank_before        integer,
  form_5_points          numeric,
  form_10_points         numeric,
  gf_last_5              numeric,
  ga_last_5              numeric,
  gd_last_5              numeric,
  gf_last_10             numeric,
  ga_last_10             numeric,
  gd_last_10             numeric,
  days_since_last_match  integer,
  competition_weight     numeric,
  source_priority        text,
  backtest_split         text,
  elo_complete           boolean not null default false,
  feature_snapshot       jsonb not null default '{}'::jsonb,
  feature_version        text not null,
  review_status          text not null default 'pending',
  created_at             timestamptz not null default now(),
  constraint htmf_v21_team_side_chk check (team_side in ('home','away'))
);

create table if not exists public.training_match_examples_v2_1 (
  id                        uuid primary key default gen_random_uuid(),
  canonical_match_id        uuid not null unique,
  historical_match_id       uuid not null,
  example_version           text not null,
  match_date                timestamptz not null,
  team_a_name               text not null,
  team_b_name               text not null,
  team_a_identity_id        uuid,
  team_b_identity_id        uuid,
  elo_diff                  numeric,
  form_5_diff               numeric,
  form_10_diff              numeric,
  gf_last_10_diff           numeric,
  ga_last_10_diff           numeric,
  competition_weight        numeric,
  target_team_a_goals       integer,
  target_team_b_goals       integer,
  target_result             text not null,
  source_priority           text,
  canonical_source_provider text,
  source_evidence_count     integer,
  backtest_split            text,
  holdout_group             text,
  elo_complete              boolean not null default false,
  form_only_no_elo          boolean not null default false,
  missing_elo_reason        text,
  leakage_policy_version    text,
  feature_snapshot          jsonb not null default '{}'::jsonb,
  leakage_check_passed      boolean not null,
  review_status             text not null default 'pending',
  created_at                timestamptz not null default now(),
  constraint tme_v21_target_result_chk check (target_result in ('team_a_win','draw','team_b_win'))
);

create index if not exists htmf_v21_canonical_idx on public.historical_team_match_features_v2_1 (canonical_match_id);
create index if not exists htmf_v21_version_idx   on public.historical_team_match_features_v2_1 (feature_version);
create index if not exists htmf_v21_split_idx     on public.historical_team_match_features_v2_1 (backtest_split);
create index if not exists htmf_v21_identity_idx  on public.historical_team_match_features_v2_1 (team_identity_id);

create index if not exists tme_v21_version_idx    on public.training_match_examples_v2_1 (example_version);
create index if not exists tme_v21_split_idx      on public.training_match_examples_v2_1 (backtest_split);
create index if not exists tme_v21_holdout_idx    on public.training_match_examples_v2_1 (holdout_group);
create index if not exists tme_v21_result_idx     on public.training_match_examples_v2_1 (target_result);

alter table public.historical_team_match_features_v2_1 enable row level security;
alter table public.training_match_examples_v2_1 enable row level security;

comment on table public.historical_team_match_features_v2_1 is 'Source-aware v2.1 per-team-side features built from historical_matches_canonical_v2_1 (external Elo, point-in-time, neutral_site dropped). Derived layer; v1.3 historical_team_match_features unchanged and sealed.';
comment on table public.training_match_examples_v2_1 is 'Source-aware v2.1 training/holdout examples (one per canonical fixture; team_a=home). Reuses external team_elo_history; neutral_site dropped to match v1.3 behaviour. v1.3 training_match_examples unchanged and sealed.';
