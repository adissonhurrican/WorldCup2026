create table if not exists public.api_football_fixture_events (
  id uuid primary key default gen_random_uuid(),
  fixture_id bigint not null,
  historical_match_id uuid null,
  source_provider text not null default 'api-football',
  source_event_hash text not null,
  event_elapsed integer null,
  event_extra integer null,
  team_id bigint null,
  team_name text null,
  player_id bigint null,
  player_name text null,
  assist_player_id bigint null,
  assist_player_name text null,
  event_type text null,
  event_detail text null,
  comments text null,
  source_snapshot jsonb not null default '{}',
  api_response_hash text not null,
  review_status text not null default 'pending',
  created_at timestamptz default now(),
  constraint api_football_fixture_events_source_provider_check
    check (source_provider = 'api-football'),
  constraint api_football_fixture_events_review_status_check
    check (review_status in ('pending', 'reviewed', 'rejected')),
  constraint api_football_fixture_events_source_unique
    unique (source_provider, fixture_id, source_event_hash)
);

create index if not exists api_football_fixture_events_fixture_id_idx
  on public.api_football_fixture_events(fixture_id);
create index if not exists api_football_fixture_events_historical_match_id_idx
  on public.api_football_fixture_events(historical_match_id);
create index if not exists api_football_fixture_events_team_id_idx
  on public.api_football_fixture_events(team_id);
create index if not exists api_football_fixture_events_player_id_idx
  on public.api_football_fixture_events(player_id);
create index if not exists api_football_fixture_events_event_type_idx
  on public.api_football_fixture_events(event_type);
create index if not exists api_football_fixture_events_review_status_idx
  on public.api_football_fixture_events(review_status);

create table if not exists public.api_football_fixture_lineups (
  id uuid primary key default gen_random_uuid(),
  fixture_id bigint not null,
  historical_match_id uuid null,
  source_provider text not null default 'api-football',
  source_lineup_hash text not null,
  team_id bigint null,
  team_name text null,
  formation text null,
  coach_id bigint null,
  coach_name text null,
  player_id bigint null,
  player_name text null,
  player_number integer null,
  player_position text null,
  grid text null,
  lineup_role text not null,
  source_snapshot jsonb not null default '{}',
  api_response_hash text not null,
  review_status text not null default 'pending',
  created_at timestamptz default now(),
  constraint api_football_fixture_lineups_source_provider_check
    check (source_provider = 'api-football'),
  constraint api_football_fixture_lineups_lineup_role_check
    check (lineup_role in ('startXI', 'substitute', 'coach', 'unknown')),
  constraint api_football_fixture_lineups_review_status_check
    check (review_status in ('pending', 'reviewed', 'rejected')),
  constraint api_football_fixture_lineups_source_unique
    unique (source_provider, fixture_id, source_lineup_hash)
);

create index if not exists api_football_fixture_lineups_fixture_id_idx
  on public.api_football_fixture_lineups(fixture_id);
create index if not exists api_football_fixture_lineups_historical_match_id_idx
  on public.api_football_fixture_lineups(historical_match_id);
create index if not exists api_football_fixture_lineups_team_id_idx
  on public.api_football_fixture_lineups(team_id);
create index if not exists api_football_fixture_lineups_player_id_idx
  on public.api_football_fixture_lineups(player_id);
create index if not exists api_football_fixture_lineups_lineup_role_idx
  on public.api_football_fixture_lineups(lineup_role);
create index if not exists api_football_fixture_lineups_review_status_idx
  on public.api_football_fixture_lineups(review_status);

create table if not exists public.api_football_fixture_statistics (
  id uuid primary key default gen_random_uuid(),
  fixture_id bigint not null,
  historical_match_id uuid null,
  source_provider text not null default 'api-football',
  source_stat_hash text not null,
  team_id bigint null,
  team_name text null,
  stat_type text not null,
  stat_value text null,
  stat_value_numeric numeric null,
  source_snapshot jsonb not null default '{}',
  api_response_hash text not null,
  review_status text not null default 'pending',
  created_at timestamptz default now(),
  constraint api_football_fixture_statistics_source_provider_check
    check (source_provider = 'api-football'),
  constraint api_football_fixture_statistics_review_status_check
    check (review_status in ('pending', 'reviewed', 'rejected')),
  constraint api_football_fixture_statistics_source_unique
    unique (source_provider, fixture_id, source_stat_hash)
);

create index if not exists api_football_fixture_statistics_fixture_id_idx
  on public.api_football_fixture_statistics(fixture_id);
create index if not exists api_football_fixture_statistics_historical_match_id_idx
  on public.api_football_fixture_statistics(historical_match_id);
create index if not exists api_football_fixture_statistics_team_id_idx
  on public.api_football_fixture_statistics(team_id);
create index if not exists api_football_fixture_statistics_stat_type_idx
  on public.api_football_fixture_statistics(stat_type);
create index if not exists api_football_fixture_statistics_review_status_idx
  on public.api_football_fixture_statistics(review_status);

create table if not exists public.api_football_fixture_player_stats (
  id uuid primary key default gen_random_uuid(),
  fixture_id bigint not null,
  historical_match_id uuid null,
  source_provider text not null default 'api-football',
  source_player_stat_hash text not null,
  team_id bigint null,
  team_name text null,
  player_id bigint null,
  player_name text null,
  position text null,
  rating numeric null,
  captain boolean null,
  substitute boolean null,
  minutes integer null,
  number integer null,
  offsides integer null,
  shots_total integer null,
  shots_on integer null,
  goals_total integer null,
  goals_conceded integer null,
  assists integer null,
  saves integer null,
  passes_total integer null,
  passes_key integer null,
  passes_accuracy text null,
  tackles_total integer null,
  tackles_blocks integer null,
  tackles_interceptions integer null,
  duels_total integer null,
  duels_won integer null,
  dribbles_attempts integer null,
  dribbles_success integer null,
  fouls_drawn integer null,
  fouls_committed integer null,
  cards_yellow integer null,
  cards_red integer null,
  penalty_won integer null,
  penalty_committed integer null,
  penalty_scored integer null,
  penalty_missed integer null,
  penalty_saved integer null,
  source_snapshot jsonb not null default '{}',
  api_response_hash text not null,
  review_status text not null default 'pending',
  created_at timestamptz default now(),
  constraint api_football_fixture_player_stats_source_provider_check
    check (source_provider = 'api-football'),
  constraint api_football_fixture_player_stats_review_status_check
    check (review_status in ('pending', 'reviewed', 'rejected')),
  constraint api_football_fixture_player_stats_source_unique
    unique (source_provider, fixture_id, source_player_stat_hash)
);

create index if not exists api_football_fixture_player_stats_fixture_id_idx
  on public.api_football_fixture_player_stats(fixture_id);
create index if not exists api_football_fixture_player_stats_historical_match_id_idx
  on public.api_football_fixture_player_stats(historical_match_id);
create index if not exists api_football_fixture_player_stats_team_id_idx
  on public.api_football_fixture_player_stats(team_id);
create index if not exists api_football_fixture_player_stats_player_id_idx
  on public.api_football_fixture_player_stats(player_id);
create index if not exists api_football_fixture_player_stats_review_status_idx
  on public.api_football_fixture_player_stats(review_status);

comment on table public.api_football_fixture_events is
  'Source-backed API-Football fixture event rows. No odds or API-Football prediction endpoint data. Not model inputs until explicitly promoted or used by later feature scripts.';
comment on table public.api_football_fixture_lineups is
  'Source-backed API-Football fixture lineup rows. No odds or API-Football prediction endpoint data. Not model inputs until explicitly promoted or used by later feature scripts.';
comment on table public.api_football_fixture_statistics is
  'Source-backed API-Football fixture team statistics rows. No odds or API-Football prediction endpoint data. Not model inputs until explicitly promoted or used by later feature scripts.';
comment on table public.api_football_fixture_player_stats is
  'Source-backed API-Football fixture player statistics rows. No odds or API-Football prediction endpoint data. Not model inputs until explicitly promoted or used by later feature scripts.';

comment on column public.api_football_fixture_events.source_snapshot is
  'Raw/source API-Football event payload and import metadata.';
comment on column public.api_football_fixture_lineups.source_snapshot is
  'Raw/source API-Football lineup payload and import metadata.';
comment on column public.api_football_fixture_statistics.source_snapshot is
  'Raw/source API-Football statistics payload and import metadata.';
comment on column public.api_football_fixture_player_stats.source_snapshot is
  'Raw/source API-Football player statistics payload and import metadata.';
