create table if not exists public.player_status_events (
  id uuid primary key default gen_random_uuid(),
  tournament_code text not null default 'WC_2026',
  player_id uuid not null references public.players(id) on delete restrict,
  team_id uuid not null references public.teams(id) on delete restrict,
  team_code text not null,
  fixture_metadata_id uuid null references public.fixture_metadata(id) on delete restrict,
  source_provider text not null,
  status_type text not null,
  status_scope text not null,
  severity text not null default 'unknown',
  availability_probability numeric(5,4),
  expected_return_date date,
  status_start_date date,
  status_end_date date,
  source_url text,
  source_snapshot jsonb not null default '{}'::jsonb,
  confidence_score numeric(5,4) not null default 0.5,
  review_status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists public.player_status_events
  add column if not exists team_code text,
  add column if not exists fixture_metadata_id uuid,
  add column if not exists source_provider text,
  add column if not exists status_type text,
  add column if not exists status_scope text,
  add column if not exists severity text not null default 'unknown',
  add column if not exists availability_probability numeric(5,4),
  add column if not exists expected_return_date date,
  add column if not exists status_start_date date,
  add column if not exists status_end_date date,
  add column if not exists source_url text,
  add column if not exists source_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists updated_at timestamptz not null default now();

comment on table public.player_status_events is
  'Append-only player availability/status events for injuries, recovery, doubts, suspensions, and fixture-specific availability. Unreviewed events do not automatically change prediction math.';
comment on column public.player_status_events.fixture_metadata_id is
  'Fixture-specific status must link to public.fixture_metadata(id). API-Football Missing Fixture rows should be fixture-specific availability events, not permanent injuries.';
comment on column public.player_status_events.status_type is
  'Availability status type: injury, recovery, doubtful, unavailable, suspended, returned_to_training, or available.';
comment on column public.player_status_events.status_scope is
  'Scope of the status event: tournament, fixture, date_range, or unknown. Fixture scope requires fixture_metadata_id.';
comment on column public.player_status_events.severity is
  'Severity is a source-backed review signal. Traveling with squad is not automatically available, and injury does not mean unavailable for every match unless the source says so.';
comment on column public.player_status_events.availability_probability is
  'Optional reviewed availability estimate from 0 to 1. AI must not invent this value.';
comment on column public.player_status_events.source_snapshot is
  'Provider payload summary, source notes, retrieved_at, and provenance. Either source_url or a non-empty source_snapshot is required.';
comment on column public.player_status_events.review_status is
  'Review status for status-event trust. Unreviewed status events do not automatically change player-impact, team-strength, or prediction math.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'player_status_events_player_id_fkey'
      and conrelid = 'public.player_status_events'::regclass
  ) then
    alter table public.player_status_events
      add constraint player_status_events_player_id_fkey
      foreign key (player_id) references public.players(id) on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'player_status_events_team_id_fkey'
      and conrelid = 'public.player_status_events'::regclass
  ) then
    alter table public.player_status_events
      add constraint player_status_events_team_id_fkey
      foreign key (team_id) references public.teams(id) on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'player_status_events_fixture_metadata_id_fkey'
      and conrelid = 'public.player_status_events'::regclass
  ) then
    alter table public.player_status_events
      add constraint player_status_events_fixture_metadata_id_fkey
      foreign key (fixture_metadata_id) references public.fixture_metadata(id) on delete restrict;
  end if;

  if not exists (
    select 1 from public.player_status_events
    where player_id is null
  ) then
    alter table public.player_status_events
      alter column player_id set not null;
  end if;

  if not exists (
    select 1 from public.player_status_events
    where team_code is null
  ) then
    alter table public.player_status_events
      alter column team_code set not null;
  end if;

  if not exists (
    select 1 from public.player_status_events
    where source_provider is null
  ) then
    alter table public.player_status_events
      alter column source_provider set not null;
  end if;

  if not exists (
    select 1 from public.player_status_events
    where status_type is null
  ) then
    alter table public.player_status_events
      alter column status_type set not null;
  end if;

  if not exists (
    select 1 from public.player_status_events
    where status_scope is null
  ) then
    alter table public.player_status_events
      alter column status_scope set not null;
  end if;

  alter table public.player_status_events
    alter column confidence_score set default 0.5;

  if not exists (
    select 1 from public.player_status_events
    where confidence_score is null
  ) then
    alter table public.player_status_events
      alter column confidence_score set not null;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'player_status_events_status_type_check'
      and conrelid = 'public.player_status_events'::regclass
  ) then
    alter table public.player_status_events
      add constraint player_status_events_status_type_check
      check (status_type in (
        'injury',
        'recovery',
        'doubtful',
        'unavailable',
        'suspended',
        'returned_to_training',
        'available'
      ));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'player_status_events_status_scope_check'
      and conrelid = 'public.player_status_events'::regclass
  ) then
    alter table public.player_status_events
      add constraint player_status_events_status_scope_check
      check (status_scope in ('tournament', 'fixture', 'date_range', 'unknown'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'player_status_events_severity_check'
      and conrelid = 'public.player_status_events'::regclass
  ) then
    alter table public.player_status_events
      add constraint player_status_events_severity_check
      check (severity in ('low', 'medium', 'high', 'unknown'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'player_status_events_review_status_check'
      and conrelid = 'public.player_status_events'::regclass
  ) then
    alter table public.player_status_events
      add constraint player_status_events_review_status_check
      check (review_status in ('pending', 'reviewed', 'rejected'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'player_status_events_confidence_score_check'
      and conrelid = 'public.player_status_events'::regclass
  ) then
    alter table public.player_status_events
      add constraint player_status_events_confidence_score_check
      check (confidence_score between 0 and 1);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'player_status_events_availability_probability_check'
      and conrelid = 'public.player_status_events'::regclass
  ) then
    alter table public.player_status_events
      add constraint player_status_events_availability_probability_check
      check (availability_probability is null or availability_probability between 0 and 1);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'player_status_events_team_code_not_empty_check'
      and conrelid = 'public.player_status_events'::regclass
  ) then
    alter table public.player_status_events
      add constraint player_status_events_team_code_not_empty_check
      check (btrim(team_code) <> '');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'player_status_events_source_provider_not_empty_check'
      and conrelid = 'public.player_status_events'::regclass
  ) then
    alter table public.player_status_events
      add constraint player_status_events_source_provider_not_empty_check
      check (btrim(source_provider) <> '');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'player_status_events_source_provenance_check'
      and conrelid = 'public.player_status_events'::regclass
  ) then
    alter table public.player_status_events
      add constraint player_status_events_source_provenance_check
      check (
        (source_url is not null and btrim(source_url) <> '')
        or source_snapshot <> '{}'::jsonb
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'player_status_events_fixture_scope_requires_fixture_check'
      and conrelid = 'public.player_status_events'::regclass
  ) then
    alter table public.player_status_events
      add constraint player_status_events_fixture_scope_requires_fixture_check
      check (status_scope <> 'fixture' or fixture_metadata_id is not null);
  end if;
end $$;

create index if not exists player_status_events_tournament_code_idx
  on public.player_status_events(tournament_code);

create index if not exists player_status_events_player_id_idx
  on public.player_status_events(player_id);

create index if not exists player_status_events_team_id_idx
  on public.player_status_events(team_id);

create index if not exists player_status_events_team_code_idx
  on public.player_status_events(team_code);

create index if not exists player_status_events_fixture_metadata_id_idx
  on public.player_status_events(fixture_metadata_id);

create index if not exists player_status_events_status_type_idx
  on public.player_status_events(status_type);

create index if not exists player_status_events_status_scope_idx
  on public.player_status_events(status_scope);

create index if not exists player_status_events_review_status_idx
  on public.player_status_events(review_status);

create index if not exists player_status_events_status_start_date_idx
  on public.player_status_events(status_start_date);

create index if not exists player_status_events_status_end_date_idx
  on public.player_status_events(status_end_date);

create unique index if not exists player_status_events_source_status_unique_idx
  on public.player_status_events(
    tournament_code,
    player_id,
    coalesce(fixture_metadata_id, '00000000-0000-0000-0000-000000000000'::uuid),
    status_type,
    status_scope,
    source_provider,
    coalesce(status_start_date, '0001-01-01'::date)
  );
