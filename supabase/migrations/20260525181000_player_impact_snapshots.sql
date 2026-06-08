create table if not exists public.player_impact_snapshots (
  id uuid primary key default gen_random_uuid(),
  tournament_code text not null default 'WC_2026',
  player_id uuid not null references public.players(id) on delete restrict,
  team_id uuid not null references public.teams(id) on delete restrict,
  squad_id uuid references public.squads(id) on delete set null,
  snapshot_date date not null,
  model_version text not null default 'player-impact-v0.1',
  position text,
  club text,
  squad_type_used text,
  squad_version_used integer,
  role_category text not null,
  starter_probability numeric(5,4),
  availability_status text not null,
  availability_score numeric(5,4),
  club_level_score numeric(5,4),
  league_strength_score numeric(5,4),
  national_team_role_score numeric(5,4),
  position_importance_score numeric(5,4),
  recent_minutes_score numeric(5,4),
  attacking_score numeric(5,4),
  defensive_score numeric(5,4),
  goalkeeper_score numeric(5,4),
  form_score numeric(5,4),
  final_player_impact_score numeric(6,5),
  confidence_score numeric(5,4),
  data_status text not null default 'partial',
  source_event_id uuid references public.source_events(id) on delete set null,
  source_snapshot jsonb not null default '{}'::jsonb,
  feature_snapshot jsonb not null default '{}'::jsonb,
  review_status text not null default 'pending',
  created_at timestamptz not null default now()
);

comment on table public.player_impact_snapshots is 'Deterministic player-level impact snapshots consumed by later team and matchup models.';
comment on column public.player_impact_snapshots.tournament_code is 'Tournament context for this player impact snapshot.';
comment on column public.player_impact_snapshots.squad_id is 'Squad version used as the player universe for this snapshot.';
comment on column public.player_impact_snapshots.snapshot_date is 'Date this player impact snapshot represents.';
comment on column public.player_impact_snapshots.model_version is 'Deterministic player impact aggregation version.';
comment on column public.player_impact_snapshots.squad_type_used is 'Squad type used for the source player universe, such as final or projected.';
comment on column public.player_impact_snapshots.squad_version_used is 'Squad version number used for the source player universe.';
comment on column public.player_impact_snapshots.role_category is 'Manual-reviewed role category: key_starter, starter, rotation, bench, backup, or unknown.';
comment on column public.player_impact_snapshots.starter_probability is 'Manual-reviewed probability that the player starts, from 0.0000 to 1.0000.';
comment on column public.player_impact_snapshots.availability_status is 'Availability state: active, doubtful, injured, suspended, replaced, or removed.';
comment on column public.player_impact_snapshots.availability_score is 'Numeric availability score from 0.0000 to 1.0000.';
comment on column public.player_impact_snapshots.final_player_impact_score is 'Weighted deterministic v0.1 player impact score from 0.00000 to 1.00000.';
comment on column public.player_impact_snapshots.confidence_score is 'Confidence in the player impact snapshot from 0.0000 to 1.0000.';
comment on column public.player_impact_snapshots.data_status is 'Completeness state for player impact data: complete, partial, placeholder, or outdated.';
comment on column public.player_impact_snapshots.source_snapshot is 'Source/provenance summary and warnings used to create this player impact snapshot.';
comment on column public.player_impact_snapshots.feature_snapshot is 'Raw feature values, assumptions, and formula weights used to calculate final_player_impact_score.';
comment on column public.player_impact_snapshots.review_status is 'Human review state for the player impact snapshot: pending, reviewed, or rejected.';

create unique index if not exists player_impact_snapshots_identity_unique_idx
  on public.player_impact_snapshots(player_id, tournament_code, snapshot_date, model_version);

create index if not exists player_impact_snapshots_tournament_code_idx
  on public.player_impact_snapshots(tournament_code);

create index if not exists player_impact_snapshots_team_id_idx
  on public.player_impact_snapshots(team_id);

create index if not exists player_impact_snapshots_player_id_idx
  on public.player_impact_snapshots(player_id);

create index if not exists player_impact_snapshots_snapshot_date_idx
  on public.player_impact_snapshots(snapshot_date);

create index if not exists player_impact_snapshots_model_version_idx
  on public.player_impact_snapshots(model_version);

create index if not exists player_impact_snapshots_team_snapshot_date_idx
  on public.player_impact_snapshots(team_id, snapshot_date);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'player_impact_snapshots_score_bounds_check'
  ) then
    alter table public.player_impact_snapshots
      add constraint player_impact_snapshots_score_bounds_check
      check (
        (starter_probability is null or (starter_probability >= 0 and starter_probability <= 1))
        and (availability_score is null or (availability_score >= 0 and availability_score <= 1))
        and (club_level_score is null or (club_level_score >= 0 and club_level_score <= 1))
        and (league_strength_score is null or (league_strength_score >= 0 and league_strength_score <= 1))
        and (national_team_role_score is null or (national_team_role_score >= 0 and national_team_role_score <= 1))
        and (position_importance_score is null or (position_importance_score >= 0 and position_importance_score <= 1))
        and (recent_minutes_score is null or (recent_minutes_score >= 0 and recent_minutes_score <= 1))
        and (attacking_score is null or (attacking_score >= 0 and attacking_score <= 1))
        and (defensive_score is null or (defensive_score >= 0 and defensive_score <= 1))
        and (goalkeeper_score is null or (goalkeeper_score >= 0 and goalkeeper_score <= 1))
        and (form_score is null or (form_score >= 0 and form_score <= 1))
        and (confidence_score is null or (confidence_score >= 0 and confidence_score <= 1))
        and (final_player_impact_score is null or (final_player_impact_score >= 0 and final_player_impact_score <= 1))
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'player_impact_snapshots_role_category_check'
  ) then
    alter table public.player_impact_snapshots
      add constraint player_impact_snapshots_role_category_check
      check (role_category in ('key_starter', 'starter', 'rotation', 'bench', 'backup', 'unknown'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'player_impact_snapshots_availability_status_check'
  ) then
    alter table public.player_impact_snapshots
      add constraint player_impact_snapshots_availability_status_check
      check (availability_status in ('active', 'doubtful', 'injured', 'suspended', 'replaced', 'removed'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'player_impact_snapshots_data_status_check'
  ) then
    alter table public.player_impact_snapshots
      add constraint player_impact_snapshots_data_status_check
      check (data_status in ('complete', 'partial', 'placeholder', 'outdated'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'player_impact_snapshots_review_status_check'
  ) then
    alter table public.player_impact_snapshots
      add constraint player_impact_snapshots_review_status_check
      check (review_status in ('pending', 'reviewed', 'rejected'));
  end if;
end $$;
