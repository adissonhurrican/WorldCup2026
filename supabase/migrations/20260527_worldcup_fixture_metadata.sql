create table if not exists public.fixture_metadata (
  id uuid primary key default gen_random_uuid(),
  tournament_code text not null default 'WC_2026',
  fixture_label text not null,
  group_code text,
  team_a_id uuid references public.teams(id) on delete restrict,
  team_b_id uuid references public.teams(id) on delete restrict,
  team_a_code text not null,
  team_b_code text not null,
  source_provider text not null,
  external_fixture_id text not null,
  external_league_id text,
  external_season text,
  kickoff_at timestamptz,
  venue_name text,
  city text,
  country text,
  status text not null default 'unknown',
  source_snapshot jsonb not null default '{}'::jsonb,
  review_status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.fixture_metadata is
  'Internal UUID-based fixture metadata and external provider fixture mapping for World Cup prediction workflows.';
comment on column public.fixture_metadata.id is
  'Internal UUID fixture identity. This is the value future internal fixture references should use.';
comment on column public.fixture_metadata.external_fixture_id is
  'External provider fixture identifier stored as text. API-Football fixture IDs are numeric externally but must not be stored directly in UUID fields.';
comment on column public.fixture_metadata.source_provider is
  'External data provider for this fixture mapping, such as api-football.';
comment on column public.fixture_metadata.source_snapshot is
  'Provider payload/provenance, mapping audit data, retrieved timestamp, and response hash where available.';
comment on column public.fixture_metadata.fixture_label is
  'Internal fixture label normalized to the model/prediction orientation, for example CAN vs BIH.';
comment on column public.fixture_metadata.team_a_code is
  'Internal team A code. Provider home/away order may differ and should be preserved in source_snapshot.';
comment on column public.fixture_metadata.team_b_code is
  'Internal team B code. Provider home/away order may differ and should be preserved in source_snapshot.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'fixture_metadata_distinct_team_codes_check'
      and conrelid = 'public.fixture_metadata'::regclass
  ) then
    alter table public.fixture_metadata
      add constraint fixture_metadata_distinct_team_codes_check
      check (team_a_code <> team_b_code);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'fixture_metadata_review_status_check'
      and conrelid = 'public.fixture_metadata'::regclass
  ) then
    alter table public.fixture_metadata
      add constraint fixture_metadata_review_status_check
      check (review_status in ('pending', 'reviewed', 'rejected'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'fixture_metadata_status_check'
      and conrelid = 'public.fixture_metadata'::regclass
  ) then
    alter table public.fixture_metadata
      add constraint fixture_metadata_status_check
      check (status in ('scheduled', 'live', 'finished', 'postponed', 'abandoned', 'unknown'));
  end if;
end $$;

create unique index if not exists fixture_metadata_provider_external_unique_idx
  on public.fixture_metadata(tournament_code, source_provider, external_fixture_id);

create unique index if not exists fixture_metadata_fixture_label_team_codes_unique_idx
  on public.fixture_metadata(tournament_code, fixture_label, team_a_code, team_b_code);

create index if not exists fixture_metadata_tournament_code_idx
  on public.fixture_metadata(tournament_code);

create index if not exists fixture_metadata_fixture_label_idx
  on public.fixture_metadata(fixture_label);

create index if not exists fixture_metadata_provider_external_idx
  on public.fixture_metadata(source_provider, external_fixture_id);

create index if not exists fixture_metadata_team_codes_idx
  on public.fixture_metadata(team_a_code, team_b_code);

create index if not exists fixture_metadata_kickoff_at_idx
  on public.fixture_metadata(kickoff_at);

create index if not exists fixture_metadata_status_idx
  on public.fixture_metadata(status);

create index if not exists fixture_metadata_review_status_idx
  on public.fixture_metadata(review_status);
