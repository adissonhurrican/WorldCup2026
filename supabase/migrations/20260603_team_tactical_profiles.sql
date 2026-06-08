create table if not exists public.team_tactical_profiles (
  id uuid primary key default gen_random_uuid(),
  tournament_code text not null default 'WC_2026',
  team_id uuid not null references public.teams(id) on delete restrict,
  team_code text not null,
  base_snapshot_id uuid null references public.team_tactical_snapshots(id) on delete set null,
  profile_version text not null default 'editorial-tactical-profile-v0.1',
  formation_primary text not null default 'unknown',
  formation_alternatives text[] not null default '{}'::text[],
  pressing_intensity text not null default 'unknown',
  build_up_style text not null default 'unknown',
  defensive_block_depth text not null default 'unknown',
  set_piece_strength text not null default 'unknown',
  transition_style text not null default 'unknown',
  attacking_width text not null default 'unknown',
  manager_tactical_notes text not null default '',
  key_tactical_risks text[] not null default '{}'::text[],
  source_urls jsonb not null default '[]'::jsonb,
  source_notes jsonb not null default '{}'::jsonb,
  review_status text not null default 'draft',
  reviewed_by text null,
  last_reviewed_at timestamptz null,
  confidence_score numeric(5,4) not null default 0.5,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.team_tactical_profiles is
  'Human-authored/editorial national-team tactical profiles for AI analysis. Separate from numeric API-derived team_tactical_snapshots.';
comment on column public.team_tactical_profiles.base_snapshot_id is
  'Optional link to a numeric team_tactical_snapshots row when qualitative fields are informed by a source-backed snapshot.';
comment on column public.team_tactical_profiles.source_urls is
  'JSON array of source objects with title, url, date, provider, and source_type for every supported qualitative claim.';
comment on column public.team_tactical_profiles.source_notes is
  'Per-field source mapping, caveats, and unknown-field reasons. Unsourced tactical claims must remain unknown.';
comment on column public.team_tactical_profiles.review_status is
  'Editorial workflow state: draft, needs_review, approved, stale, or rejected.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'team_tactical_profiles_team_code_not_empty_check'
      and conrelid = 'public.team_tactical_profiles'::regclass
  ) then
    alter table public.team_tactical_profiles
      add constraint team_tactical_profiles_team_code_not_empty_check
      check (btrim(team_code) <> '');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'team_tactical_profiles_profile_version_not_empty_check'
      and conrelid = 'public.team_tactical_profiles'::regclass
  ) then
    alter table public.team_tactical_profiles
      add constraint team_tactical_profiles_profile_version_not_empty_check
      check (btrim(profile_version) <> '');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'team_tactical_profiles_pressing_intensity_check'
      and conrelid = 'public.team_tactical_profiles'::regclass
  ) then
    alter table public.team_tactical_profiles
      add constraint team_tactical_profiles_pressing_intensity_check
      check (pressing_intensity in ('low', 'medium', 'high', 'variable', 'unknown'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'team_tactical_profiles_build_up_style_check'
      and conrelid = 'public.team_tactical_profiles'::regclass
  ) then
    alter table public.team_tactical_profiles
      add constraint team_tactical_profiles_build_up_style_check
      check (build_up_style in ('possession_oriented', 'direct', 'transition_oriented', 'balanced', 'mixed', 'unknown'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'team_tactical_profiles_defensive_block_depth_check'
      and conrelid = 'public.team_tactical_profiles'::regclass
  ) then
    alter table public.team_tactical_profiles
      add constraint team_tactical_profiles_defensive_block_depth_check
      check (defensive_block_depth in ('low', 'mid', 'high', 'variable', 'unknown'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'team_tactical_profiles_set_piece_strength_check'
      and conrelid = 'public.team_tactical_profiles'::regclass
  ) then
    alter table public.team_tactical_profiles
      add constraint team_tactical_profiles_set_piece_strength_check
      check (set_piece_strength in ('low', 'medium', 'high', 'variable', 'unknown'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'team_tactical_profiles_transition_style_check'
      and conrelid = 'public.team_tactical_profiles'::regclass
  ) then
    alter table public.team_tactical_profiles
      add constraint team_tactical_profiles_transition_style_check
      check (transition_style in ('direct_counter', 'controlled', 'mixed', 'unknown'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'team_tactical_profiles_attacking_width_check'
      and conrelid = 'public.team_tactical_profiles'::regclass
  ) then
    alter table public.team_tactical_profiles
      add constraint team_tactical_profiles_attacking_width_check
      check (attacking_width in ('narrow', 'balanced', 'wide', 'variable', 'unknown'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'team_tactical_profiles_review_status_check'
      and conrelid = 'public.team_tactical_profiles'::regclass
  ) then
    alter table public.team_tactical_profiles
      add constraint team_tactical_profiles_review_status_check
      check (review_status in ('draft', 'needs_review', 'approved', 'stale', 'rejected'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'team_tactical_profiles_confidence_score_check'
      and conrelid = 'public.team_tactical_profiles'::regclass
  ) then
    alter table public.team_tactical_profiles
      add constraint team_tactical_profiles_confidence_score_check
      check (confidence_score between 0 and 1);
  end if;
end $$;

create unique index if not exists team_tactical_profiles_unique_idx
  on public.team_tactical_profiles(tournament_code, team_id, profile_version);

create index if not exists team_tactical_profiles_tournament_code_idx
  on public.team_tactical_profiles(tournament_code);

create index if not exists team_tactical_profiles_team_id_idx
  on public.team_tactical_profiles(team_id);

create index if not exists team_tactical_profiles_team_code_idx
  on public.team_tactical_profiles(team_code);

create index if not exists team_tactical_profiles_profile_version_idx
  on public.team_tactical_profiles(profile_version);

create index if not exists team_tactical_profiles_review_status_idx
  on public.team_tactical_profiles(review_status);

create index if not exists team_tactical_profiles_confidence_score_idx
  on public.team_tactical_profiles(confidence_score);

alter table public.team_tactical_profiles enable row level security;
