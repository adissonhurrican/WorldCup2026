create table if not exists public.match_performance_metrics (
  id uuid primary key default gen_random_uuid(),
  fixture_id bigint not null,
  team_id uuid not null references public.teams(id) on delete restrict,
  opponent_team_id uuid not null references public.teams(id) on delete restrict,
  xg_for numeric(8,4),
  xg_against numeric(8,4),
  xg_provider text default 'api_football',
  xg_level text,
  xg_availability text not null default 'unavailable',
  shots integer,
  shots_on_target integer,
  shots_inside_box integer,
  possession numeric(5,2),
  corners integer,
  retrieved_at timestamptz not null default now(),
  source_payload_hash text,
  review_status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.match_performance_metrics is
  'Post-match nullable performance enrichment for WC2026 fixtures. Stores xG and shot-quality stats when available; never a prediction dependency.';
comment on column public.match_performance_metrics.fixture_id is
  'Provider fixture id, currently expected to be the API-Football fixture id. Kept as bigint for ingestion idempotency.';
comment on column public.match_performance_metrics.xg_for is
  'Nullable team xG for this team in this fixture. Never imputed.';
comment on column public.match_performance_metrics.xg_against is
  'Nullable team xG conceded/allowed by this team in this fixture. Never imputed.';
comment on column public.match_performance_metrics.xg_provider is
  'Provider of the xG value, for example api_football or sportmonks. Nullable when no xG is available.';
comment on column public.match_performance_metrics.xg_level is
  'Granularity of xG value: team or player. Nullable when xG is unavailable.';
comment on column public.match_performance_metrics.xg_availability is
  'xG availability state: available, unavailable, or partial. Missing xG does not block storing non-xG stats.';
comment on column public.match_performance_metrics.source_payload_hash is
  'Hash of the source payload used for audit/idempotency. Nullable for manually staged rows, but required by ingestion policy when fetched.';
comment on column public.match_performance_metrics.review_status is
  'Human/data review state: pending, reviewed, or rejected.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'match_performance_metrics_xg_level_check'
      and conrelid = 'public.match_performance_metrics'::regclass
  ) then
    alter table public.match_performance_metrics
      add constraint match_performance_metrics_xg_level_check
      check (xg_level is null or xg_level in ('team', 'player'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'match_performance_metrics_xg_availability_check'
      and conrelid = 'public.match_performance_metrics'::regclass
  ) then
    alter table public.match_performance_metrics
      add constraint match_performance_metrics_xg_availability_check
      check (xg_availability in ('available', 'unavailable', 'partial'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'match_performance_metrics_review_status_check'
      and conrelid = 'public.match_performance_metrics'::regclass
  ) then
    alter table public.match_performance_metrics
      add constraint match_performance_metrics_review_status_check
      check (review_status in ('pending', 'reviewed', 'rejected'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'match_performance_metrics_xg_nonnegative_check'
      and conrelid = 'public.match_performance_metrics'::regclass
  ) then
    alter table public.match_performance_metrics
      add constraint match_performance_metrics_xg_nonnegative_check
      check (
        (xg_for is null or xg_for >= 0)
        and (xg_against is null or xg_against >= 0)
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'match_performance_metrics_stats_nonnegative_check'
      and conrelid = 'public.match_performance_metrics'::regclass
  ) then
    alter table public.match_performance_metrics
      add constraint match_performance_metrics_stats_nonnegative_check
      check (
        (shots is null or shots >= 0)
        and (shots_on_target is null or shots_on_target >= 0)
        and (shots_inside_box is null or shots_inside_box >= 0)
        and (corners is null or corners >= 0)
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'match_performance_metrics_possession_range_check'
      and conrelid = 'public.match_performance_metrics'::regclass
  ) then
    alter table public.match_performance_metrics
      add constraint match_performance_metrics_possession_range_check
      check (possession is null or (possession >= 0 and possession <= 100));
  end if;
end $$;

drop index if exists public.match_performance_metrics_fixture_team_provider_uidx;

create unique index if not exists match_performance_metrics_fixture_team_uidx
  on public.match_performance_metrics (fixture_id, team_id);

create index if not exists match_performance_metrics_fixture_id_idx
  on public.match_performance_metrics(fixture_id);

create index if not exists match_performance_metrics_team_id_idx
  on public.match_performance_metrics(team_id);

create index if not exists match_performance_metrics_opponent_team_id_idx
  on public.match_performance_metrics(opponent_team_id);

create index if not exists match_performance_metrics_xg_availability_idx
  on public.match_performance_metrics(xg_availability);

create index if not exists match_performance_metrics_review_status_idx
  on public.match_performance_metrics(review_status);

create index if not exists match_performance_metrics_retrieved_at_idx
  on public.match_performance_metrics(retrieved_at);

alter table public.match_performance_metrics enable row level security;
