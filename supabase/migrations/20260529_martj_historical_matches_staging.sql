-- MartJ international_results staging table.
-- DDL only: no rows are imported by this migration.
-- This table is staging-only; do not use rows for production modeling until reviewed/promoted.

create table if not exists public.historical_matches_martj_staging (
  id uuid primary key default gen_random_uuid(),
  source_provider text not null default 'martj_international_results',
  source_file_sha256 text not null,
  source_row_hash text not null,
  source_row_number integer not null,
  match_date date not null,
  home_team_name text not null,
  away_team_name text not null,
  home_goals integer not null,
  away_goals integer not null,
  tournament text,
  city text,
  country text,
  neutral_site boolean,
  normalized_home_team text not null,
  normalized_away_team text not null,
  normalized_match_key text not null,
  api_football_overlap_status text not null default 'unchecked',
  identity_mapping_status text not null default 'unchecked',
  modeling_status text not null default 'staging_only',
  review_status text not null default 'pending',
  source_snapshot jsonb not null default '{}'::jsonb,
  import_batch_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint historical_matches_martj_staging_source_provider_check
    check (source_provider = 'martj_international_results'),
  constraint historical_matches_martj_staging_source_file_sha256_check
    check (source_file_sha256 ~ '^[a-f0-9]{64}$'),
  constraint historical_matches_martj_staging_source_row_hash_check
    check (source_row_hash ~ '^[a-f0-9]{64}$'),
  constraint historical_matches_martj_staging_source_row_number_check
    check (source_row_number > 0),
  constraint historical_matches_martj_staging_scores_check
    check (home_goals >= 0 and away_goals >= 0),
  constraint historical_matches_martj_staging_overlap_status_check
    check (api_football_overlap_status in ('unchecked', 'matched', 'likely_new', 'conflict', 'manual_review')),
  constraint historical_matches_martj_staging_identity_status_check
    check (identity_mapping_status in ('unchecked', 'both_mapped', 'one_side_mapped', 'unmapped', 'non_standard_review')),
  constraint historical_matches_martj_staging_modeling_status_check
    check (modeling_status in ('staging_only', 'candidate_for_promotion', 'excluded_from_modeling', 'promoted')),
  constraint historical_matches_martj_staging_review_status_check
    check (review_status in ('pending', 'approved', 'rejected', 'needs_review'))
);

create unique index if not exists historical_matches_martj_staging_provider_row_hash_uidx
  on public.historical_matches_martj_staging (source_provider, source_row_hash);

create unique index if not exists historical_matches_martj_staging_provider_row_file_uidx
  on public.historical_matches_martj_staging (source_provider, source_row_number, source_file_sha256);

create index if not exists historical_matches_martj_staging_normalized_match_key_idx
  on public.historical_matches_martj_staging (normalized_match_key);

create index if not exists historical_matches_martj_staging_match_date_idx
  on public.historical_matches_martj_staging (match_date);

create index if not exists historical_matches_martj_staging_overlap_status_idx
  on public.historical_matches_martj_staging (api_football_overlap_status);

create index if not exists historical_matches_martj_staging_identity_status_idx
  on public.historical_matches_martj_staging (identity_mapping_status);

create index if not exists historical_matches_martj_staging_modeling_status_idx
  on public.historical_matches_martj_staging (modeling_status);

create index if not exists historical_matches_martj_staging_review_status_idx
  on public.historical_matches_martj_staging (review_status);

comment on table public.historical_matches_martj_staging is
  'Staging-only MartJ international_results rows. No production model use until rows are reviewed and promoted.';

comment on column public.historical_matches_martj_staging.source_file_sha256 is
  'SHA-256 of the local MartJ results.csv file used for this staging row. Required for source traceability.';

comment on column public.historical_matches_martj_staging.source_row_hash is
  'SHA-256 of the source row payload. Used to deduplicate MartJ staging rows.';

comment on column public.historical_matches_martj_staging.normalized_match_key is
  'Normalized date/home/away/score key used for overlap and conflict comparison against API-Football historical_matches.';

comment on column public.historical_matches_martj_staging.api_football_overlap_status is
  'Overlap review status against API-Football historical_matches: unchecked, matched, likely_new, conflict, or manual_review.';

comment on column public.historical_matches_martj_staging.identity_mapping_status is
  'Identity-map review status: unchecked, both_mapped, one_side_mapped, unmapped, or non_standard_review.';

comment on column public.historical_matches_martj_staging.modeling_status is
  'Modeling promotion state. Default staging_only; not eligible for production modeling until explicitly reviewed.';

comment on column public.historical_matches_martj_staging.source_snapshot is
  'Source metadata including file hash, source URL, license, selected scope, raw row, and audit context.';

comment on column public.historical_matches_martj_staging.match_date is
  'First safe scope is 2018-01-01 through 2026-05-28. Rows after 2026-05-28 should not be staged for first safe scope unless explicitly approved later.';
