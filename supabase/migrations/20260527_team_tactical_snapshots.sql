create table if not exists public.team_tactical_snapshots (
  id uuid primary key default gen_random_uuid(),
  tournament_code text not null default 'WC_2026',
  team_id uuid not null references public.teams(id) on delete restrict,
  team_code text not null,
  model_version text not null default 'tactical-profile-v0.1',
  snapshot_date date not null,
  matches_used integer not null default 0,
  fixture_ids jsonb not null default '[]'::jsonb,
  primary_formation text,
  secondary_formation text,
  formation_counts jsonb not null default '{}'::jsonb,
  formation_flexibility_score numeric(5,4),
  avg_possession numeric(6,3),
  avg_shots_for numeric(6,3),
  avg_shots_against numeric(6,3),
  avg_shots_on_target_for numeric(6,3),
  avg_shots_on_target_against numeric(6,3),
  avg_corners_for numeric(6,3),
  avg_corners_against numeric(6,3),
  avg_fouls_for numeric(6,3),
  avg_fouls_against numeric(6,3),
  avg_yellow_cards numeric(6,3),
  avg_red_cards numeric(6,3),
  attack_profile_score numeric(5,4),
  defensive_profile_score numeric(5,4),
  set_piece_proxy_score numeric(5,4),
  discipline_profile_score numeric(5,4),
  tempo_pressing_proxy_score numeric(5,4),
  transition_proxy_score numeric(5,4),
  confidence_score numeric(5,4) not null default 0.5,
  missing_fields jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  source_snapshot jsonb not null default '{}'::jsonb,
  review_status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.team_tactical_snapshots is
  'Source-backed national-team tactical profile snapshots built from lineups, team statistics, and events. Supporting model inputs only, not direct match predictions.';
comment on column public.team_tactical_snapshots.model_version is
  'Tactical model version. tactical-profile-v0.1 uses source-backed API-Football lineups/statistics/events only.';
comment on column public.team_tactical_snapshots.fixture_ids is
  'Provider or internal fixture identifiers used to calculate this tactical snapshot, stored for auditability.';
comment on column public.team_tactical_snapshots.formation_counts is
  'Observed formation counts from source-backed lineup rows.';
comment on column public.team_tactical_snapshots.transition_proxy_score is
  'Nullable until event taxonomy is reviewed. Transition/counterattack features are blocked for automatic use in v0.1.';
comment on column public.team_tactical_snapshots.source_snapshot is
  'Source payload summary, fixture IDs, provider metadata, field coverage, warnings, and provenance.';
comment on column public.team_tactical_snapshots.confidence_score is
  'Confidence in tactical profile coverage from 0 to 1. Tactical confidence should be shown separately from match confidence.';
comment on column public.team_tactical_snapshots.warnings is
  'Warnings about missing fields, unsupported tactical claims, provider gaps, or taxonomy limitations.';
comment on column public.team_tactical_snapshots.attack_profile_score is
  'Source-backed attack profile proxy. AI must not invent tactical claims beyond these source-backed fields.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'team_tactical_snapshots_confidence_score_check'
      and conrelid = 'public.team_tactical_snapshots'::regclass
  ) then
    alter table public.team_tactical_snapshots
      add constraint team_tactical_snapshots_confidence_score_check
      check (confidence_score between 0 and 1);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'team_tactical_snapshots_score_fields_check'
      and conrelid = 'public.team_tactical_snapshots'::regclass
  ) then
    alter table public.team_tactical_snapshots
      add constraint team_tactical_snapshots_score_fields_check
      check (
        (formation_flexibility_score is null or formation_flexibility_score between 0 and 1)
        and (attack_profile_score is null or attack_profile_score between 0 and 1)
        and (defensive_profile_score is null or defensive_profile_score between 0 and 1)
        and (set_piece_proxy_score is null or set_piece_proxy_score between 0 and 1)
        and (discipline_profile_score is null or discipline_profile_score between 0 and 1)
        and (tempo_pressing_proxy_score is null or tempo_pressing_proxy_score between 0 and 1)
        and (transition_proxy_score is null or transition_proxy_score between 0 and 1)
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'team_tactical_snapshots_matches_used_check'
      and conrelid = 'public.team_tactical_snapshots'::regclass
  ) then
    alter table public.team_tactical_snapshots
      add constraint team_tactical_snapshots_matches_used_check
      check (matches_used >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'team_tactical_snapshots_average_fields_check'
      and conrelid = 'public.team_tactical_snapshots'::regclass
  ) then
    alter table public.team_tactical_snapshots
      add constraint team_tactical_snapshots_average_fields_check
      check (
        (avg_possession is null or avg_possession >= 0)
        and (avg_shots_for is null or avg_shots_for >= 0)
        and (avg_shots_against is null or avg_shots_against >= 0)
        and (avg_shots_on_target_for is null or avg_shots_on_target_for >= 0)
        and (avg_shots_on_target_against is null or avg_shots_on_target_against >= 0)
        and (avg_corners_for is null or avg_corners_for >= 0)
        and (avg_corners_against is null or avg_corners_against >= 0)
        and (avg_fouls_for is null or avg_fouls_for >= 0)
        and (avg_fouls_against is null or avg_fouls_against >= 0)
        and (avg_yellow_cards is null or avg_yellow_cards >= 0)
        and (avg_red_cards is null or avg_red_cards >= 0)
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'team_tactical_snapshots_review_status_check'
      and conrelid = 'public.team_tactical_snapshots'::regclass
  ) then
    alter table public.team_tactical_snapshots
      add constraint team_tactical_snapshots_review_status_check
      check (review_status in ('pending', 'reviewed', 'rejected'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'team_tactical_snapshots_team_code_not_empty_check'
      and conrelid = 'public.team_tactical_snapshots'::regclass
  ) then
    alter table public.team_tactical_snapshots
      add constraint team_tactical_snapshots_team_code_not_empty_check
      check (btrim(team_code) <> '');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'team_tactical_snapshots_model_version_not_empty_check'
      and conrelid = 'public.team_tactical_snapshots'::regclass
  ) then
    alter table public.team_tactical_snapshots
      add constraint team_tactical_snapshots_model_version_not_empty_check
      check (btrim(model_version) <> '');
  end if;
end $$;

create unique index if not exists team_tactical_snapshots_unique_idx
  on public.team_tactical_snapshots(tournament_code, team_id, model_version, snapshot_date);

create index if not exists team_tactical_snapshots_tournament_code_idx
  on public.team_tactical_snapshots(tournament_code);

create index if not exists team_tactical_snapshots_team_id_idx
  on public.team_tactical_snapshots(team_id);

create index if not exists team_tactical_snapshots_team_code_idx
  on public.team_tactical_snapshots(team_code);

create index if not exists team_tactical_snapshots_model_version_idx
  on public.team_tactical_snapshots(model_version);

create index if not exists team_tactical_snapshots_snapshot_date_idx
  on public.team_tactical_snapshots(snapshot_date);

create index if not exists team_tactical_snapshots_review_status_idx
  on public.team_tactical_snapshots(review_status);

create index if not exists team_tactical_snapshots_confidence_score_idx
  on public.team_tactical_snapshots(confidence_score);
