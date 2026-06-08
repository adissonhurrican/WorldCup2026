create table if not exists public.team_strength_snapshots (
  id uuid primary key default gen_random_uuid(),
  tournament_code text not null default 'WC_2026',
  team_id uuid not null references public.teams(id) on delete restrict,
  snapshot_date date not null,
  data_status text not null default 'partial',
  fifa_rank integer,
  fifa_points numeric(10,4),
  elo_rating numeric(10,4),
  fifa_rank_score numeric(8,6),
  elo_score numeric(8,6),
  recent_form_score numeric(8,6),
  squad_strength_score numeric(8,6),
  injury_penalty numeric(8,6),
  availability_score numeric(8,6),
  context_adjustment numeric(8,6),
  final_team_strength numeric(8,6),
  confidence_score numeric(5,4),
  source_event_id uuid references public.source_events(id) on delete set null,
  source_snapshot jsonb not null default '{}'::jsonb,
  feature_snapshot jsonb not null default '{}'::jsonb,
  model_version text not null default 'team-strength-v0.1',
  review_status text not null default 'pending',
  created_at timestamptz not null default now()
);

comment on table public.team_strength_snapshots is 'Model-ready team-level feature snapshots consumed by future deterministic Monte Carlo simulations.';
comment on column public.team_strength_snapshots.tournament_code is 'Tournament context for this team strength snapshot.';
comment on column public.team_strength_snapshots.snapshot_date is 'Date this deterministic feature snapshot represents.';
comment on column public.team_strength_snapshots.data_status is 'Completeness state for snapshot inputs: complete, partial, placeholder, or outdated.';
comment on column public.team_strength_snapshots.fifa_rank_score is 'Normalized FIFA rank score in the 0 to 1 range; lower FIFA rank produces a higher score.';
comment on column public.team_strength_snapshots.elo_score is 'Normalized Elo score in the 0 to 1 range; v0.1 uses neutral 0.50 when Elo is missing.';
comment on column public.team_strength_snapshots.recent_form_score is 'Recent form points divided by the maximum 30 points from the latest 10 matches.';
comment on column public.team_strength_snapshots.squad_strength_score is 'Coarse v0.1 squad completeness score, not a player-quality model.';
comment on column public.team_strength_snapshots.injury_penalty is 'Penalty derived from player status events such as injuries or suspensions.';
comment on column public.team_strength_snapshots.availability_score is 'Coarse v0.1 player availability score derived from squad status.';
comment on column public.team_strength_snapshots.context_adjustment is 'Reserved for later match-context adjustments; v0.1 stores 0.00.';
comment on column public.team_strength_snapshots.final_team_strength is 'Weighted deterministic aggregate score used by future simulation layers.';
comment on column public.team_strength_snapshots.confidence_score is 'Numeric confidence in the snapshot from 0.0000 to 1.0000.';
comment on column public.team_strength_snapshots.source_event_id is 'Optional source event representing the snapshot build provenance.';
comment on column public.team_strength_snapshots.source_snapshot is 'Source/provenance summary for the inputs used to build the snapshot, including warnings.';
comment on column public.team_strength_snapshots.feature_snapshot is 'Raw feature values and formula weights used to calculate final_team_strength.';
comment on column public.team_strength_snapshots.model_version is 'Deterministic feature aggregation version, separate from future prediction or explanation layers.';
comment on column public.team_strength_snapshots.review_status is 'Human review state for the generated snapshot: pending, reviewed, or rejected.';

create index if not exists team_strength_snapshots_tournament_code_idx
  on public.team_strength_snapshots(tournament_code);

create index if not exists team_strength_snapshots_team_id_idx
  on public.team_strength_snapshots(team_id);

create index if not exists team_strength_snapshots_snapshot_date_idx
  on public.team_strength_snapshots(snapshot_date);

create index if not exists team_strength_snapshots_team_snapshot_date_idx
  on public.team_strength_snapshots(team_id, snapshot_date);

create unique index if not exists team_strength_snapshots_team_tournament_date_model_unique_idx
  on public.team_strength_snapshots(team_id, tournament_code, snapshot_date, model_version);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'team_strength_snapshots_confidence_score_check'
  ) then
    alter table public.team_strength_snapshots
      add constraint team_strength_snapshots_confidence_score_check
      check (confidence_score is null or (confidence_score >= 0 and confidence_score <= 1));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'team_strength_snapshots_review_status_check'
  ) then
    alter table public.team_strength_snapshots
      add constraint team_strength_snapshots_review_status_check
      check (review_status in ('pending', 'reviewed', 'rejected'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'team_strength_snapshots_data_status_check'
  ) then
    alter table public.team_strength_snapshots
      add constraint team_strength_snapshots_data_status_check
      check (data_status in ('complete', 'partial', 'placeholder', 'outdated'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'team_strength_snapshots_fifa_rank_positive_check'
  ) then
    alter table public.team_strength_snapshots
      add constraint team_strength_snapshots_fifa_rank_positive_check
      check (fifa_rank is null or fifa_rank > 0);
  end if;
end $$;
