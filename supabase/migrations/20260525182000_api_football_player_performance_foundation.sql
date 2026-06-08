create table if not exists public.api_football_player_identity_map (
  id uuid primary key default gen_random_uuid(),
  tournament_code text not null default 'WC_2026',
  internal_player_id uuid not null references public.players(id) on delete restrict,
  team_id uuid not null references public.teams(id) on delete restrict,
  api_provider text not null default 'api-football',
  api_player_id bigint not null,
  api_player_name text not null,
  api_team_id bigint,
  api_team_name text,
  matched_from text not null,
  match_confidence numeric(5,4),
  normalized_internal_name text,
  normalized_api_name text,
  source_snapshot jsonb not null default '{}'::jsonb,
  review_status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.api_football_player_identity_map
  is 'Maps internal World Cup player records to API-Football player identifiers.';
comment on column public.api_football_player_identity_map.tournament_code
  is 'Tournament context for this identity mapping.';
comment on column public.api_football_player_identity_map.internal_player_id
  is 'Internal player record matched to the external API-Football player id.';
comment on column public.api_football_player_identity_map.api_provider
  is 'External provider name; defaults to api-football.';
comment on column public.api_football_player_identity_map.api_player_id
  is 'API-Football player identifier.';
comment on column public.api_football_player_identity_map.api_team_id
  is 'API-Football team identifier used when the player identity was discovered.';
comment on column public.api_football_player_identity_map.matched_from
  is 'Discovery source for the identity match: squad, lineup, event, fixture_player_stats, manual_review, or mixed.';
comment on column public.api_football_player_identity_map.match_confidence
  is 'Confidence in the internal-to-provider identity match, from 0.0000 to 1.0000.';
comment on column public.api_football_player_identity_map.source_snapshot
  is 'Provider response summary, matching evidence, warnings, and review notes used for this identity map.';
comment on column public.api_football_player_identity_map.review_status
  is 'Human review state for the identity match: pending, reviewed, or rejected.';
comment on column public.api_football_player_identity_map.updated_at
  is 'Last time this identity mapping record was refreshed by an import process.';

create unique index if not exists api_football_player_identity_map_internal_provider_unique_idx
  on public.api_football_player_identity_map(internal_player_id, api_provider);

create unique index if not exists api_football_player_identity_map_api_provider_unique_idx
  on public.api_football_player_identity_map(api_player_id, api_provider);

create index if not exists api_football_player_identity_map_tournament_code_idx
  on public.api_football_player_identity_map(tournament_code);

create index if not exists api_football_player_identity_map_team_id_idx
  on public.api_football_player_identity_map(team_id);

create index if not exists api_football_player_identity_map_api_team_id_idx
  on public.api_football_player_identity_map(api_team_id);

create index if not exists api_football_player_identity_map_matched_from_idx
  on public.api_football_player_identity_map(matched_from);

create index if not exists api_football_player_identity_map_review_status_idx
  on public.api_football_player_identity_map(review_status);

create table if not exists public.player_performance_records (
  id uuid primary key default gen_random_uuid(),
  tournament_code text not null default 'WC_2026',
  internal_player_id uuid not null references public.players(id) on delete restrict,
  api_player_id bigint not null,
  team_id uuid not null references public.teams(id) on delete restrict,
  source_provider text not null default 'api-football',
  source_competition_type text not null,
  season integer not null,
  league_id bigint,
  league_name text,
  league_country text,
  source_team_id bigint,
  source_team_name text,
  expected_current_club boolean,
  identity_warning text,
  appearances integer,
  starts integer,
  minutes integer,
  position text,
  goals integer,
  assists integer,
  yellow_cards integer,
  red_cards integer,
  shots_total integer,
  shots_on_target integer,
  saves integer,
  goals_conceded integer,
  clean_sheets integer,
  raw_stat_sections jsonb not null default '{}'::jsonb,
  source_snapshot jsonb not null default '{}'::jsonb,
  confidence_score numeric(5,4),
  review_status text not null default 'pending',
  data_status text not null default 'partial',
  retrieved_at timestamptz not null default now(),
  api_response_hash text,
  created_at timestamptz not null default now()
);

comment on table public.player_performance_records
  is 'Row-level API-Football club/source competition player performance records preserved before model aggregation.';
comment on column public.player_performance_records.tournament_code
  is 'Tournament context for this player performance research record.';
comment on column public.player_performance_records.internal_player_id
  is 'Internal player record represented by this provider performance row.';
comment on column public.player_performance_records.api_player_id
  is 'API-Football player identifier for this row.';
comment on column public.player_performance_records.team_id
  is 'Internal national team context for the player, not necessarily the club team in the source row.';
comment on column public.player_performance_records.source_provider
  is 'Provider that supplied the row-level performance data.';
comment on column public.player_performance_records.source_competition_type
  is 'Classified source row type: club_competition, club_international_competition, club_friendly, national_team_friendly, national_team_competition, or unclear.';
comment on column public.player_performance_records.season
  is 'Provider season value for the row, such as 2025.';
comment on column public.player_performance_records.source_team_id
  is 'Provider team id for the club or team attached to this stat row.';
comment on column public.player_performance_records.expected_current_club
  is 'Whether this row team matches the reviewed current club at import time, when known.';
comment on column public.player_performance_records.identity_warning
  is 'Stored identity or context warning, such as multiple clubs in one season or unexpected club.';
comment on column public.player_performance_records.raw_stat_sections
  is 'Compact raw provider stat sections used to preserve fields not yet normalized.';
comment on column public.player_performance_records.source_snapshot
  is 'Provider URLs, request context, classification evidence, warnings, and provenance for this row.';
comment on column public.player_performance_records.confidence_score
  is 'Confidence in this source row after context classification, from 0.0000 to 1.0000.';
comment on column public.player_performance_records.review_status
  is 'Human review state for this performance row: pending, reviewed, or rejected.';
comment on column public.player_performance_records.data_status
  is 'Completeness state for this performance row: complete, partial, placeholder, or outdated.';
comment on column public.player_performance_records.retrieved_at
  is 'Time the provider row was retrieved.';
comment on column public.player_performance_records.api_response_hash
  is 'Optional hash of the normalized provider response used to detect repeated unchanged imports.';

create unique index if not exists player_performance_records_provider_player_season_league_team_type_unique_idx
  on public.player_performance_records(
    source_provider,
    api_player_id,
    season,
    league_id,
    source_team_id,
    source_competition_type
  );

create index if not exists player_performance_records_tournament_code_idx
  on public.player_performance_records(tournament_code);

create index if not exists player_performance_records_internal_player_id_idx
  on public.player_performance_records(internal_player_id);

create index if not exists player_performance_records_api_player_id_idx
  on public.player_performance_records(api_player_id);

create index if not exists player_performance_records_team_id_idx
  on public.player_performance_records(team_id);

create index if not exists player_performance_records_source_competition_type_idx
  on public.player_performance_records(source_competition_type);

create index if not exists player_performance_records_season_idx
  on public.player_performance_records(season);

create index if not exists player_performance_records_league_id_idx
  on public.player_performance_records(league_id);

create index if not exists player_performance_records_source_team_id_idx
  on public.player_performance_records(source_team_id);

create index if not exists player_performance_records_retrieved_at_idx
  on public.player_performance_records(retrieved_at);

create table if not exists public.national_team_usage_records (
  id uuid primary key default gen_random_uuid(),
  tournament_code text not null default 'WC_2026',
  internal_player_id uuid not null references public.players(id) on delete restrict,
  api_player_id bigint not null,
  national_team_id uuid not null references public.teams(id) on delete restrict,
  api_team_id bigint,
  api_team_name text,
  source_provider text not null default 'api-football',
  competition_type text not null,
  season integer not null,
  league_id bigint,
  league_name text,
  appearances integer,
  starts integer,
  minutes integer,
  goals integer,
  assists integer,
  yellow_cards integer,
  red_cards integer,
  shots_total integer,
  shots_on_target integer,
  raw_stat_sections jsonb not null default '{}'::jsonb,
  source_snapshot jsonb not null default '{}'::jsonb,
  confidence_score numeric(5,4),
  review_status text not null default 'pending',
  data_status text not null default 'partial',
  retrieved_at timestamptz not null default now(),
  api_response_hash text,
  created_at timestamptz not null default now()
);

comment on table public.national_team_usage_records
  is 'Row-level API-Football national-team usage records stored separately from club performance rows.';
comment on column public.national_team_usage_records.tournament_code
  is 'Tournament context for this national-team usage record.';
comment on column public.national_team_usage_records.internal_player_id
  is 'Internal player record represented by this national-team usage row.';
comment on column public.national_team_usage_records.api_player_id
  is 'API-Football player identifier for this row.';
comment on column public.national_team_usage_records.national_team_id
  is 'Internal national team associated with the usage row.';
comment on column public.national_team_usage_records.api_team_id
  is 'API-Football national team id attached to this usage row.';
comment on column public.national_team_usage_records.source_provider
  is 'Provider that supplied the national-team usage row.';
comment on column public.national_team_usage_records.competition_type
  is 'National-team competition classification: national_team_friendly, national_team_competition, world_cup, qualifier, nations_league, or other.';
comment on column public.national_team_usage_records.season
  is 'Provider season value for the row, such as 2025.';
comment on column public.national_team_usage_records.raw_stat_sections
  is 'Compact raw provider stat sections used to preserve fields not yet normalized.';
comment on column public.national_team_usage_records.source_snapshot
  is 'Provider URLs, request context, classification evidence, warnings, and provenance for this row.';
comment on column public.national_team_usage_records.confidence_score
  is 'Confidence in this national-team usage row after context classification, from 0.0000 to 1.0000.';
comment on column public.national_team_usage_records.review_status
  is 'Human review state for this usage row: pending, reviewed, or rejected.';
comment on column public.national_team_usage_records.data_status
  is 'Completeness state for this usage row: complete, partial, placeholder, or outdated.';
comment on column public.national_team_usage_records.retrieved_at
  is 'Time the provider row was retrieved.';
comment on column public.national_team_usage_records.api_response_hash
  is 'Optional hash of the normalized provider response used to detect repeated unchanged imports.';

create unique index if not exists national_team_usage_records_provider_player_season_league_team_type_unique_idx
  on public.national_team_usage_records(
    source_provider,
    api_player_id,
    season,
    league_id,
    api_team_id,
    competition_type
  );

create index if not exists national_team_usage_records_tournament_code_idx
  on public.national_team_usage_records(tournament_code);

create index if not exists national_team_usage_records_internal_player_id_idx
  on public.national_team_usage_records(internal_player_id);

create index if not exists national_team_usage_records_api_player_id_idx
  on public.national_team_usage_records(api_player_id);

create index if not exists national_team_usage_records_national_team_id_idx
  on public.national_team_usage_records(national_team_id);

create index if not exists national_team_usage_records_api_team_id_idx
  on public.national_team_usage_records(api_team_id);

create index if not exists national_team_usage_records_competition_type_idx
  on public.national_team_usage_records(competition_type);

create index if not exists national_team_usage_records_season_idx
  on public.national_team_usage_records(season);

create index if not exists national_team_usage_records_league_id_idx
  on public.national_team_usage_records(league_id);

create index if not exists national_team_usage_records_retrieved_at_idx
  on public.national_team_usage_records(retrieved_at);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'api_football_player_identity_map_match_confidence_check'
      and conrelid = 'public.api_football_player_identity_map'::regclass
  ) then
    alter table public.api_football_player_identity_map
      add constraint api_football_player_identity_map_match_confidence_check
      check (match_confidence is null or (match_confidence >= 0 and match_confidence <= 1));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'api_football_player_identity_map_matched_from_check'
      and conrelid = 'public.api_football_player_identity_map'::regclass
  ) then
    alter table public.api_football_player_identity_map
      add constraint api_football_player_identity_map_matched_from_check
      check (matched_from in ('squad', 'lineup', 'event', 'fixture_player_stats', 'manual_review', 'mixed'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'api_football_player_identity_map_review_status_check'
      and conrelid = 'public.api_football_player_identity_map'::regclass
  ) then
    alter table public.api_football_player_identity_map
      add constraint api_football_player_identity_map_review_status_check
      check (review_status in ('pending', 'reviewed', 'rejected'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'player_performance_records_confidence_score_check'
      and conrelid = 'public.player_performance_records'::regclass
  ) then
    alter table public.player_performance_records
      add constraint player_performance_records_confidence_score_check
      check (confidence_score is null or (confidence_score >= 0 and confidence_score <= 1));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'player_performance_records_review_status_check'
      and conrelid = 'public.player_performance_records'::regclass
  ) then
    alter table public.player_performance_records
      add constraint player_performance_records_review_status_check
      check (review_status in ('pending', 'reviewed', 'rejected'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'player_performance_records_data_status_check'
      and conrelid = 'public.player_performance_records'::regclass
  ) then
    alter table public.player_performance_records
      add constraint player_performance_records_data_status_check
      check (data_status in ('complete', 'partial', 'placeholder', 'outdated'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'player_performance_records_source_competition_type_check'
      and conrelid = 'public.player_performance_records'::regclass
  ) then
    alter table public.player_performance_records
      add constraint player_performance_records_source_competition_type_check
      check (
        source_competition_type in (
          'club_competition',
          'club_international_competition',
          'club_friendly',
          'national_team_friendly',
          'national_team_competition',
          'unclear'
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'player_performance_records_nonnegative_stats_check'
      and conrelid = 'public.player_performance_records'::regclass
  ) then
    alter table public.player_performance_records
      add constraint player_performance_records_nonnegative_stats_check
      check (
        (appearances is null or appearances >= 0)
        and (starts is null or starts >= 0)
        and (minutes is null or minutes >= 0)
        and (goals is null or goals >= 0)
        and (assists is null or assists >= 0)
        and (yellow_cards is null or yellow_cards >= 0)
        and (red_cards is null or red_cards >= 0)
        and (shots_total is null or shots_total >= 0)
        and (shots_on_target is null or shots_on_target >= 0)
        and (saves is null or saves >= 0)
        and (goals_conceded is null or goals_conceded >= 0)
        and (clean_sheets is null or clean_sheets >= 0)
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'national_team_usage_records_confidence_score_check'
      and conrelid = 'public.national_team_usage_records'::regclass
  ) then
    alter table public.national_team_usage_records
      add constraint national_team_usage_records_confidence_score_check
      check (confidence_score is null or (confidence_score >= 0 and confidence_score <= 1));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'national_team_usage_records_review_status_check'
      and conrelid = 'public.national_team_usage_records'::regclass
  ) then
    alter table public.national_team_usage_records
      add constraint national_team_usage_records_review_status_check
      check (review_status in ('pending', 'reviewed', 'rejected'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'national_team_usage_records_data_status_check'
      and conrelid = 'public.national_team_usage_records'::regclass
  ) then
    alter table public.national_team_usage_records
      add constraint national_team_usage_records_data_status_check
      check (data_status in ('complete', 'partial', 'placeholder', 'outdated'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'national_team_usage_records_competition_type_check'
      and conrelid = 'public.national_team_usage_records'::regclass
  ) then
    alter table public.national_team_usage_records
      add constraint national_team_usage_records_competition_type_check
      check (
        competition_type in (
          'national_team_friendly',
          'national_team_competition',
          'world_cup',
          'qualifier',
          'nations_league',
          'other'
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'national_team_usage_records_nonnegative_stats_check'
      and conrelid = 'public.national_team_usage_records'::regclass
  ) then
    alter table public.national_team_usage_records
      add constraint national_team_usage_records_nonnegative_stats_check
      check (
        (appearances is null or appearances >= 0)
        and (starts is null or starts >= 0)
        and (minutes is null or minutes >= 0)
        and (goals is null or goals >= 0)
        and (assists is null or assists >= 0)
        and (yellow_cards is null or yellow_cards >= 0)
        and (red_cards is null or red_cards >= 0)
        and (shots_total is null or shots_total >= 0)
        and (shots_on_target is null or shots_on_target >= 0)
      );
  end if;
end $$;
