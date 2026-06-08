create table if not exists public.source_events (
  id uuid primary key default gen_random_uuid(),
  source_name text not null,
  source_url text,
  source_type text,
  retrieved_at timestamptz,
  published_at timestamptz,
  payload jsonb not null default '{}'::jsonb,
  confidence_level numeric(5,4),
  created_at timestamptz not null default now()
);

comment on table public.source_events is 'Raw external data and provenance records used by the World Cup prediction module.';
comment on column public.source_events.source_type is 'Type of source, such as official, trusted_news, manual, or model_input.';
comment on column public.source_events.confidence_level is 'Numeric confidence in the source payload, from 0.0000 to 1.0000.';
comment on column public.source_events.payload is 'Raw source payload or compact provenance metadata.';

create index if not exists source_events_source_name_idx on public.source_events(source_name);
create index if not exists source_events_source_type_idx on public.source_events(source_type);
create index if not exists source_events_retrieved_at_idx on public.source_events(retrieved_at);
create unique index if not exists source_events_identity_unique_idx
  on public.source_events (
    source_name,
    coalesce(source_url, ''),
    coalesce(source_type, ''),
    coalesce(published_at, '-infinity'::timestamptz)
  );

alter table if exists public.teams
  add column if not exists source_event_id uuid references public.source_events(id),
  add column if not exists source_name text,
  add column if not exists source_url text;

alter table if exists public.fixtures
  add column if not exists tournament_code text not null default 'WC_2026',
  add column if not exists fifa_match_id text,
  add column if not exists data_status text not null default 'partial',
  add column if not exists source_event_id uuid references public.source_events(id),
  add column if not exists source_name text,
  add column if not exists source_url text;

alter table if exists public.fixtures
  alter column match_date drop not null;

comment on column public.fixtures.tournament_code is 'Tournament identifier, defaulting to WC_2026 for this module.';
comment on column public.fixtures.fifa_match_id is 'Stable external match identifier used for idempotent fixture imports.';
comment on column public.fixtures.data_status is 'Completeness state for fixture data: complete, partial, placeholder, or outdated.';
comment on column public.fixtures.source_event_id is 'References the raw source event that provided or justified this fixture data.';

alter table if exists public.players
  add column if not exists source_status text not null default 'unverified',
  add column if not exists confidence_score numeric(5,4),
  add column if not exists review_status text not null default 'pending',
  add column if not exists source_event_id uuid references public.source_events(id),
  add column if not exists source_name text,
  add column if not exists source_url text;

comment on column public.players.source_status is 'Source trust state for player data: projected, official, trusted_news, unverified, or manual_confirmed.';
comment on column public.players.confidence_score is 'Numeric confidence in the player record from 0.0000 to 1.0000.';
comment on column public.players.review_status is 'Human review state for player data: pending, reviewed, or rejected.';

alter table if exists public.squads
  add column if not exists tournament_code text not null default 'WC_2026',
  add column if not exists squad_type text not null default 'projected',
  add column if not exists version_number integer not null default 1,
  add column if not exists valid_from timestamptz,
  add column if not exists valid_to timestamptz,
  add column if not exists data_status text not null default 'partial',
  add column if not exists source_status text not null default 'unverified',
  add column if not exists confidence_score numeric(5,4),
  add column if not exists review_status text not null default 'pending',
  add column if not exists source_event_id uuid references public.source_events(id);

comment on column public.squads.tournament_code is 'Tournament identifier, defaulting to WC_2026 for this module.';
comment on column public.squads.squad_type is 'Squad publication state: projected, provisional, or final.';
comment on column public.squads.version_number is 'Version number for preserving squad history without overwriting previous records.';
comment on column public.squads.data_status is 'Completeness state for squad data: complete, partial, placeholder, or outdated.';
comment on column public.squads.source_status is 'Source trust state for squad data: projected, official, trusted_news, unverified, or manual_confirmed.';
comment on column public.squads.confidence_score is 'Numeric confidence in the squad record from 0.0000 to 1.0000.';
comment on column public.squads.review_status is 'Human review state for squad data: pending, reviewed, or rejected.';

alter table if exists public.squad_players
  add column if not exists status text not null default 'active',
  add column if not exists replaced_by_player_id uuid references public.players(id),
  add column if not exists status_updated_at timestamptz,
  add column if not exists status_reason text,
  add column if not exists source_event_id uuid references public.source_events(id);

comment on column public.squad_players.status is 'Player squad status: active, injured, doubtful, replaced, or removed.';
comment on column public.squad_players.replaced_by_player_id is 'Replacement player when this squad player has status replaced.';
comment on column public.squad_players.status_reason is 'Short explanation for injury, doubt, replacement, or removal status.';

alter table if exists public.team_ratings
  add column if not exists tournament_code text not null default 'WC_2026',
  add column if not exists data_status text not null default 'partial',
  add column if not exists source_event_id uuid references public.source_events(id);

comment on column public.team_ratings.tournament_code is 'Tournament identifier for ratings used by a specific prediction context.';
comment on column public.team_ratings.data_status is 'Completeness state for rating data: complete, partial, placeholder, or outdated.';

alter table if exists public.recent_matches
  add column if not exists tournament_code text not null default 'WC_2026',
  add column if not exists data_status text not null default 'partial',
  add column if not exists source_event_id uuid references public.source_events(id);

comment on column public.recent_matches.tournament_code is 'Tournament prediction context that this recent-match input supports.';
comment on column public.recent_matches.data_status is 'Completeness state for recent-match data: complete, partial, placeholder, or outdated.';

alter table if exists public.player_metrics
  add column if not exists source_event_id uuid references public.source_events(id);

alter table if exists public.prediction_runs
  add column if not exists tournament_code text not null default 'WC_2026',
  add column if not exists algorithm_name text,
  add column if not exists algorithm_version text,
  add column if not exists input_data_version text,
  add column if not exists feature_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists source_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists source_event_id uuid references public.source_events(id);

comment on column public.prediction_runs.tournament_code is 'Tournament identifier for this prediction run.';
comment on column public.prediction_runs.algorithm_name is 'Deterministic prediction algorithm name, separate from any later AI explanation layer.';
comment on column public.prediction_runs.algorithm_version is 'Version of the deterministic prediction algorithm.';
comment on column public.prediction_runs.input_data_version is 'Version label for the structured inputs used by the run.';
comment on column public.prediction_runs.feature_snapshot is 'Structured model features used to calculate probabilities for this run.';
comment on column public.prediction_runs.source_snapshot is 'Source/provenance summary for the inputs used by this run.';

alter table if exists public.match_predictions
  add column if not exists tournament_code text not null default 'WC_2026',
  add column if not exists source_event_id uuid references public.source_events(id);

comment on column public.match_predictions.tournament_code is 'Tournament identifier for this calculated match prediction.';

create unique index if not exists fixtures_fifa_match_id_unique_idx
  on public.fixtures(fifa_match_id)
  where fifa_match_id is not null;

create index if not exists fixtures_tournament_code_idx on public.fixtures(tournament_code);
create index if not exists fixtures_tournament_match_date_idx on public.fixtures(tournament_code, match_date);
create index if not exists fixtures_source_event_id_idx on public.fixtures(source_event_id);

create index if not exists teams_source_event_id_idx on public.teams(source_event_id);

create index if not exists players_source_event_id_idx on public.players(source_event_id);
create index if not exists players_source_status_idx on public.players(source_status);
create index if not exists players_review_status_idx on public.players(review_status);

create index if not exists squads_tournament_team_idx on public.squads(tournament_code, team_id);
create index if not exists squads_version_lookup_idx on public.squads(team_id, tournament_code, squad_type, version_number);
create index if not exists squads_source_event_id_idx on public.squads(source_event_id);
create index if not exists squads_source_status_idx on public.squads(source_status);
create index if not exists squads_review_status_idx on public.squads(review_status);

create index if not exists squad_players_status_idx on public.squad_players(status);
create index if not exists squad_players_replaced_by_player_id_idx on public.squad_players(replaced_by_player_id);
create index if not exists squad_players_source_event_id_idx on public.squad_players(source_event_id);

create index if not exists team_ratings_tournament_team_idx on public.team_ratings(tournament_code, team_id);
create index if not exists team_ratings_tournament_rating_date_idx on public.team_ratings(tournament_code, rating_date);
create index if not exists team_ratings_source_event_id_idx on public.team_ratings(source_event_id);

create index if not exists recent_matches_tournament_team_idx on public.recent_matches(tournament_code, team_id);
create index if not exists recent_matches_tournament_match_date_idx on public.recent_matches(tournament_code, match_date);
create index if not exists recent_matches_source_event_id_idx on public.recent_matches(source_event_id);

create index if not exists player_metrics_source_event_id_idx on public.player_metrics(source_event_id);

create index if not exists prediction_runs_tournament_fixture_idx on public.prediction_runs(tournament_code, fixture_id);
create index if not exists prediction_runs_source_event_id_idx on public.prediction_runs(source_event_id);

create index if not exists match_predictions_tournament_fixture_idx on public.match_predictions(tournament_code, fixture_id);
create index if not exists match_predictions_source_event_id_idx on public.match_predictions(source_event_id);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'source_events_confidence_level_check'
  ) and not exists (
    select 1 from public.source_events
    where confidence_level is not null and (confidence_level < 0 or confidence_level > 1)
  ) then
    alter table public.source_events
      add constraint source_events_confidence_level_check
      check (confidence_level is null or (confidence_level >= 0 and confidence_level <= 1));
  end if;
end $$;

do $$
begin
  if to_regclass('public.fixtures') is not null
    and not exists (select 1 from pg_constraint where conname = 'fixtures_data_status_check')
    and not exists (
      select 1 from public.fixtures
      where data_status not in ('complete', 'partial', 'placeholder', 'outdated')
    )
  then
    alter table public.fixtures
      add constraint fixtures_data_status_check
      check (data_status in ('complete', 'partial', 'placeholder', 'outdated'));
  end if;
end $$;

do $$
begin
  if to_regclass('public.players') is not null
    and not exists (select 1 from pg_constraint where conname = 'players_source_status_check')
    and not exists (
      select 1 from public.players
      where source_status not in ('projected', 'official', 'trusted_news', 'unverified', 'manual_confirmed')
    )
  then
    alter table public.players
      add constraint players_source_status_check
      check (source_status in ('projected', 'official', 'trusted_news', 'unverified', 'manual_confirmed'));
  end if;

  if to_regclass('public.players') is not null
    and not exists (select 1 from pg_constraint where conname = 'players_review_status_check')
    and not exists (
      select 1 from public.players
      where review_status not in ('pending', 'reviewed', 'rejected')
    )
  then
    alter table public.players
      add constraint players_review_status_check
      check (review_status in ('pending', 'reviewed', 'rejected'));
  end if;
end $$;

do $$
begin
  if to_regclass('public.squads') is not null
    and not exists (select 1 from pg_constraint where conname = 'squads_squad_type_check')
    and not exists (
      select 1 from public.squads
      where squad_type not in ('projected', 'provisional', 'final')
    )
  then
    alter table public.squads
      add constraint squads_squad_type_check
      check (squad_type in ('projected', 'provisional', 'final'));
  end if;

  if to_regclass('public.squads') is not null
    and not exists (select 1 from pg_constraint where conname = 'squads_data_status_check')
    and not exists (
      select 1 from public.squads
      where data_status not in ('complete', 'partial', 'placeholder', 'outdated')
    )
  then
    alter table public.squads
      add constraint squads_data_status_check
      check (data_status in ('complete', 'partial', 'placeholder', 'outdated'));
  end if;

  if to_regclass('public.squads') is not null
    and not exists (select 1 from pg_constraint where conname = 'squads_source_status_check')
    and not exists (
      select 1 from public.squads
      where source_status not in ('projected', 'official', 'trusted_news', 'unverified', 'manual_confirmed')
    )
  then
    alter table public.squads
      add constraint squads_source_status_check
      check (source_status in ('projected', 'official', 'trusted_news', 'unverified', 'manual_confirmed'));
  end if;

  if to_regclass('public.squads') is not null
    and not exists (select 1 from pg_constraint where conname = 'squads_review_status_check')
    and not exists (
      select 1 from public.squads
      where review_status not in ('pending', 'reviewed', 'rejected')
    )
  then
    alter table public.squads
      add constraint squads_review_status_check
      check (review_status in ('pending', 'reviewed', 'rejected'));
  end if;
end $$;

do $$
begin
  if to_regclass('public.squad_players') is not null
    and not exists (select 1 from pg_constraint where conname = 'squad_players_status_check')
    and not exists (
      select 1 from public.squad_players
      where status not in ('active', 'injured', 'doubtful', 'replaced', 'removed')
    )
  then
    alter table public.squad_players
      add constraint squad_players_status_check
      check (status in ('active', 'injured', 'doubtful', 'replaced', 'removed'));
  end if;
end $$;

do $$
begin
  if to_regclass('public.team_ratings') is not null
    and not exists (select 1 from pg_constraint where conname = 'team_ratings_data_status_check')
    and not exists (
      select 1 from public.team_ratings
      where data_status not in ('complete', 'partial', 'placeholder', 'outdated')
    )
  then
    alter table public.team_ratings
      add constraint team_ratings_data_status_check
      check (data_status in ('complete', 'partial', 'placeholder', 'outdated'));
  end if;

  if to_regclass('public.recent_matches') is not null
    and not exists (select 1 from pg_constraint where conname = 'recent_matches_data_status_check')
    and not exists (
      select 1 from public.recent_matches
      where data_status not in ('complete', 'partial', 'placeholder', 'outdated')
    )
  then
    alter table public.recent_matches
      add constraint recent_matches_data_status_check
      check (data_status in ('complete', 'partial', 'placeholder', 'outdated'));
  end if;
end $$;
