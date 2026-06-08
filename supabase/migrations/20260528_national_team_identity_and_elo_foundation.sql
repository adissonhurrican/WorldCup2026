create table if not exists public.national_team_identity_map (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references public.teams(id) on delete set null,
  canonical_name text not null,
  fifa_code text,
  api_football_team_id text,
  api_football_name text,
  elo_name text,
  country_name text,
  aliases jsonb not null default '[]'::jsonb,
  is_world_cup_2026_team boolean not null default false,
  is_active_national_team boolean not null default true,
  source_provider text not null default 'manual_mapping',
  source_snapshot jsonb not null default '{}'::jsonb,
  confidence_score numeric not null default 0.80,
  review_status text not null default 'pending',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

comment on table public.national_team_identity_map is
  'Bridge table for mapping national-team identities across internal teams, API-Football, FIFA codes, Elo names, and aliases.';
comment on column public.national_team_identity_map.team_id is
  'Optional link to public.teams when the identity is a World Cup or internally tracked team.';
comment on column public.national_team_identity_map.api_football_team_id is
  'API-Football team identifier stored as text for provider consistency.';
comment on column public.national_team_identity_map.elo_name is
  'Team name as represented by the historical Elo source.';
comment on column public.national_team_identity_map.aliases is
  'Array of alternate provider names, historical names, transliterations, or spelling variants.';
comment on column public.national_team_identity_map.source_snapshot is
  'Mapping provenance, source evidence, confidence notes, and review context.';

create table if not exists public.team_elo_history (
  id uuid primary key default gen_random_uuid(),
  identity_map_id uuid references public.national_team_identity_map(id) on delete set null,
  team_id uuid references public.teams(id) on delete set null,
  elo_name text not null,
  rating_date date not null,
  elo_rating integer not null,
  elo_rank integer,
  source_provider text not null,
  source_url text,
  source_snapshot jsonb not null default '{}'::jsonb,
  confidence_score numeric not null default 0.80,
  review_status text not null default 'pending',
  created_at timestamptz not null default now()
);

comment on table public.team_elo_history is
  'Historical national-team Elo rating timeline by team/date for pre-match model features.';
comment on column public.team_elo_history.rating_date is
  'Date the Elo rating applies to. Match feature joins must use the latest rating_date strictly before match_date.';
comment on column public.team_elo_history.elo_rating is
  'Historical Elo rating. Current Elo must never be used for old matches.';
comment on column public.team_elo_history.source_snapshot is
  'Source payload, retrieval metadata, and leakage-guard provenance for the Elo row.';

create table if not exists public.historical_match_import_batches (
  id uuid primary key default gen_random_uuid(),
  source_provider text not null,
  scope text not null,
  date_start date,
  date_end date,
  teams_requested jsonb not null default '[]'::jsonb,
  request_count integer,
  raw_rows_seen integer,
  prepared_rows integer,
  inserted_rows integer,
  skipped_existing integer,
  warning_count integer,
  error_count integer,
  source_snapshot jsonb not null default '{}'::jsonb,
  review_status text not null default 'pending',
  created_at timestamptz not null default now()
);

comment on table public.historical_match_import_batches is
  'Import provenance for large historical match/result ingestion batches by source and scope.';
comment on column public.historical_match_import_batches.source_snapshot is
  'Request metadata, source coverage notes, warnings, errors, hashes, and other audit context for an import batch.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'national_team_identity_map_canonical_name_not_empty_check'
      and conrelid = 'public.national_team_identity_map'::regclass
  ) then
    alter table public.national_team_identity_map
      add constraint national_team_identity_map_canonical_name_not_empty_check
      check (btrim(canonical_name) <> '');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'national_team_identity_map_fifa_code_length_check'
      and conrelid = 'public.national_team_identity_map'::regclass
  ) then
    alter table public.national_team_identity_map
      add constraint national_team_identity_map_fifa_code_length_check
      check (fifa_code is null or char_length(fifa_code) <= 5);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'national_team_identity_map_confidence_score_check'
      and conrelid = 'public.national_team_identity_map'::regclass
  ) then
    alter table public.national_team_identity_map
      add constraint national_team_identity_map_confidence_score_check
      check (confidence_score between 0 and 1);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'national_team_identity_map_review_status_check'
      and conrelid = 'public.national_team_identity_map'::regclass
  ) then
    alter table public.national_team_identity_map
      add constraint national_team_identity_map_review_status_check
      check (review_status in ('pending', 'reviewed', 'rejected'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'national_team_identity_map_source_provider_not_empty_check'
      and conrelid = 'public.national_team_identity_map'::regclass
  ) then
    alter table public.national_team_identity_map
      add constraint national_team_identity_map_source_provider_not_empty_check
      check (btrim(source_provider) <> '');
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'team_elo_history_elo_name_not_empty_check'
      and conrelid = 'public.team_elo_history'::regclass
  ) then
    alter table public.team_elo_history
      add constraint team_elo_history_elo_name_not_empty_check
      check (btrim(elo_name) <> '');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'team_elo_history_elo_rating_positive_check'
      and conrelid = 'public.team_elo_history'::regclass
  ) then
    alter table public.team_elo_history
      add constraint team_elo_history_elo_rating_positive_check
      check (elo_rating > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'team_elo_history_elo_rank_positive_check'
      and conrelid = 'public.team_elo_history'::regclass
  ) then
    alter table public.team_elo_history
      add constraint team_elo_history_elo_rank_positive_check
      check (elo_rank is null or elo_rank > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'team_elo_history_confidence_score_check'
      and conrelid = 'public.team_elo_history'::regclass
  ) then
    alter table public.team_elo_history
      add constraint team_elo_history_confidence_score_check
      check (confidence_score between 0 and 1);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'team_elo_history_review_status_check'
      and conrelid = 'public.team_elo_history'::regclass
  ) then
    alter table public.team_elo_history
      add constraint team_elo_history_review_status_check
      check (review_status in ('pending', 'reviewed', 'rejected'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'team_elo_history_source_provider_not_empty_check'
      and conrelid = 'public.team_elo_history'::regclass
  ) then
    alter table public.team_elo_history
      add constraint team_elo_history_source_provider_not_empty_check
      check (btrim(source_provider) <> '');
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'historical_match_import_batches_source_provider_not_empty_check'
      and conrelid = 'public.historical_match_import_batches'::regclass
  ) then
    alter table public.historical_match_import_batches
      add constraint historical_match_import_batches_source_provider_not_empty_check
      check (btrim(source_provider) <> '');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'historical_match_import_batches_scope_not_empty_check'
      and conrelid = 'public.historical_match_import_batches'::regclass
  ) then
    alter table public.historical_match_import_batches
      add constraint historical_match_import_batches_scope_not_empty_check
      check (btrim(scope) <> '');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'historical_match_import_batches_request_count_check'
      and conrelid = 'public.historical_match_import_batches'::regclass
  ) then
    alter table public.historical_match_import_batches
      add constraint historical_match_import_batches_request_count_check
      check (request_count is null or request_count >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'historical_match_import_batches_row_counts_check'
      and conrelid = 'public.historical_match_import_batches'::regclass
  ) then
    alter table public.historical_match_import_batches
      add constraint historical_match_import_batches_row_counts_check
      check (
        (raw_rows_seen is null or raw_rows_seen >= 0)
        and (prepared_rows is null or prepared_rows >= 0)
        and (inserted_rows is null or inserted_rows >= 0)
        and (skipped_existing is null or skipped_existing >= 0)
        and (warning_count is null or warning_count >= 0)
        and (error_count is null or error_count >= 0)
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'historical_match_import_batches_review_status_check'
      and conrelid = 'public.historical_match_import_batches'::regclass
  ) then
    alter table public.historical_match_import_batches
      add constraint historical_match_import_batches_review_status_check
      check (review_status in ('pending', 'reviewed', 'rejected'));
  end if;
end $$;

create index if not exists national_team_identity_map_team_id_idx
  on public.national_team_identity_map(team_id);
create index if not exists national_team_identity_map_fifa_code_idx
  on public.national_team_identity_map(fifa_code);
create index if not exists national_team_identity_map_api_football_team_id_idx
  on public.national_team_identity_map(api_football_team_id);
create index if not exists national_team_identity_map_elo_name_idx
  on public.national_team_identity_map(elo_name);
create index if not exists national_team_identity_map_canonical_name_idx
  on public.national_team_identity_map(canonical_name);
create index if not exists national_team_identity_map_is_world_cup_2026_team_idx
  on public.national_team_identity_map(is_world_cup_2026_team);
create index if not exists national_team_identity_map_review_status_idx
  on public.national_team_identity_map(review_status);

create unique index if not exists national_team_identity_map_api_football_team_id_unique_idx
  on public.national_team_identity_map(api_football_team_id)
  where api_football_team_id is not null;

create unique index if not exists national_team_identity_map_wc2026_fifa_code_unique_idx
  on public.national_team_identity_map(fifa_code)
  where fifa_code is not null and is_world_cup_2026_team = true;

create unique index if not exists national_team_identity_map_canonical_name_unique_idx
  on public.national_team_identity_map(canonical_name);

create index if not exists team_elo_history_identity_map_id_idx
  on public.team_elo_history(identity_map_id);
create index if not exists team_elo_history_team_id_idx
  on public.team_elo_history(team_id);
create index if not exists team_elo_history_elo_name_idx
  on public.team_elo_history(elo_name);
create index if not exists team_elo_history_rating_date_idx
  on public.team_elo_history(rating_date);
create index if not exists team_elo_history_source_provider_idx
  on public.team_elo_history(source_provider);
create index if not exists team_elo_history_review_status_idx
  on public.team_elo_history(review_status);

create unique index if not exists team_elo_history_source_elo_name_date_unique_idx
  on public.team_elo_history(source_provider, elo_name, rating_date);

create index if not exists historical_match_import_batches_source_provider_idx
  on public.historical_match_import_batches(source_provider);
create index if not exists historical_match_import_batches_scope_idx
  on public.historical_match_import_batches(scope);
create index if not exists historical_match_import_batches_created_at_idx
  on public.historical_match_import_batches(created_at);
create index if not exists historical_match_import_batches_review_status_idx
  on public.historical_match_import_batches(review_status);
