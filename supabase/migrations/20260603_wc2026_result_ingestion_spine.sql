alter table if exists public.match_results
  add column if not exists api_football_fixture_id bigint,
  add column if not exists provider_status text,
  add column if not exists provider_status_short text,
  add column if not exists round_name text,
  add column if not exists group_code text,
  add column if not exists source_payload_hash text,
  add column if not exists last_ingested_at timestamptz;

comment on column public.match_results.api_football_fixture_id is
  'API-Football numeric fixture ID. Added for idempotent WC2026 result ingestion; do not store this value in UUID fixture_id.';
comment on column public.match_results.source_payload_hash is
  'SHA-256 hash of the normalized source fixture payload used for result ingestion.';
comment on column public.match_results.last_ingested_at is
  'Timestamp of the latest result-ingestion loop that touched this row.';

create unique index if not exists match_results_api_football_fixture_unique_idx
  on public.match_results(tournament_code, source_provider, api_football_fixture_id)
  where source_provider = 'api-football' and api_football_fixture_id is not null;

create index if not exists match_results_api_football_fixture_id_idx
  on public.match_results(api_football_fixture_id);
create index if not exists match_results_group_code_idx
  on public.match_results(group_code);
create index if not exists match_results_source_payload_hash_idx
  on public.match_results(source_payload_hash);

create table if not exists public.wc2026_result_ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  tournament_code text not null default 'WC_2026',
  source_provider text not null default 'api-football',
  dry_run boolean not null default true,
  execute boolean not null default false,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  fixtures_checked integer not null default 0,
  finished_fixtures_seen integer not null default 0,
  newly_ingested integer not null default 0,
  would_insert_results integer not null default 0,
  would_update_results integer not null default 0,
  enrichment_attempted integer not null default 0,
  enrichment_present integer not null default 0,
  enrichment_missing integer not null default 0,
  standings_rows_derived integer not null default 0,
  api_requests_used integer not null default 0,
  cache_files_written integer not null default 0,
  source_payload_hash text,
  run_summary jsonb not null default '{}'::jsonb,
  errors jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  constraint wc2026_result_ingestion_runs_provider_check
    check (source_provider = 'api-football')
);

create index if not exists wc2026_result_ingestion_runs_started_at_idx
  on public.wc2026_result_ingestion_runs(started_at);
create index if not exists wc2026_result_ingestion_runs_tournament_code_idx
  on public.wc2026_result_ingestion_runs(tournament_code);

create table if not exists public.wc2026_fixture_enrichment_status (
  id uuid primary key default gen_random_uuid(),
  tournament_code text not null default 'WC_2026',
  source_provider text not null default 'api-football',
  api_football_fixture_id bigint not null,
  fixture_metadata_id uuid references public.fixture_metadata(id) on delete set null,
  match_result_id uuid references public.match_results(id) on delete set null,
  events_status text not null default 'not_attempted',
  lineups_status text not null default 'not_attempted',
  statistics_status text not null default 'not_attempted',
  events_count integer not null default 0,
  lineups_count integer not null default 0,
  statistics_count integer not null default 0,
  missing_reasons jsonb not null default '{}'::jsonb,
  last_attempted_at timestamptz not null default now(),
  source_snapshot jsonb not null default '{}'::jsonb,
  review_status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wc2026_fixture_enrichment_provider_check
    check (source_provider = 'api-football'),
  constraint wc2026_fixture_enrichment_status_check
    check (
      events_status in ('not_attempted', 'present', 'missing', 'partial', 'error')
      and lineups_status in ('not_attempted', 'present', 'missing', 'partial', 'error')
      and statistics_status in ('not_attempted', 'present', 'missing', 'partial', 'error')
    ),
  constraint wc2026_fixture_enrichment_review_check
    check (review_status in ('pending', 'reviewed', 'rejected'))
);

create unique index if not exists wc2026_fixture_enrichment_fixture_unique_idx
  on public.wc2026_fixture_enrichment_status(tournament_code, source_provider, api_football_fixture_id);

create table if not exists public.wc2026_group_standings (
  id uuid primary key default gen_random_uuid(),
  tournament_code text not null default 'WC_2026',
  group_code text not null,
  team_id uuid references public.teams(id) on delete restrict,
  team_code text not null,
  team_name text,
  played integer not null default 0,
  won integer not null default 0,
  drawn integer not null default 0,
  lost integer not null default 0,
  goals_for integer not null default 0,
  goals_against integer not null default 0,
  goal_difference integer not null default 0,
  points integer not null default 0,
  standings_rank integer,
  source text not null default 'derived_from_match_results',
  source_snapshot jsonb not null default '{}'::jsonb,
  recomputed_at timestamptz not null default now(),
  review_status text not null default 'pending',
  constraint wc2026_group_standings_counts_check
    check (
      played >= 0 and won >= 0 and drawn >= 0 and lost >= 0
      and goals_for >= 0 and goals_against >= 0
      and points >= 0
    ),
  constraint wc2026_group_standings_review_check
    check (review_status in ('pending', 'reviewed', 'rejected'))
);

create unique index if not exists wc2026_group_standings_team_unique_idx
  on public.wc2026_group_standings(tournament_code, group_code, team_code);
create index if not exists wc2026_group_standings_group_rank_idx
  on public.wc2026_group_standings(tournament_code, group_code, standings_rank);

comment on table public.wc2026_result_ingestion_runs is
  'Run log for WC2026 result-ingestion spine. This table records fixture/result ingestion only; it does not retrain models, regenerate predictions, or run Monte Carlo.';
comment on table public.wc2026_fixture_enrichment_status is
  'Best-effort enrichment status for API-Football events/lineups/statistics. Missing enrichment never blocks core result ingestion.';
comment on table public.wc2026_group_standings is
  'Derived group standings recomputed from stored WC2026 match_results rows. This is data-layer state only.';

alter table if exists public.wc2026_result_ingestion_runs enable row level security;
alter table if exists public.wc2026_fixture_enrichment_status enable row level security;
alter table if exists public.wc2026_group_standings enable row level security;
