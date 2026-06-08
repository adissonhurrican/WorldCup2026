create table if not exists public.team_rating_snapshots (
  id uuid primary key default gen_random_uuid(),
  tournament_code text not null default 'WC_2026',
  team_id uuid not null references public.teams(id) on delete restrict,
  team_code text not null,
  rating_source text not null,
  rating_type text not null,
  rating_value numeric(12,4),
  rank_value integer,
  rating_date date not null,
  source_provider text not null,
  source_url text,
  source_snapshot jsonb not null default '{}'::jsonb,
  confidence_score numeric(5,4) not null default 0.8,
  review_status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.team_rating_snapshots is
  'Date-stamped FIFA and Elo-style team rating snapshots used as supporting model inputs, not direct match predictions.';
comment on column public.team_rating_snapshots.rating_source is
  'Rating source family, such as fifa, world_football_elo, or manual_review.';
comment on column public.team_rating_snapshots.rating_type is
  'Specific rating type. FIFA rank, FIFA points, Elo rating, and Elo rank are separate signals and must not be mixed.';
comment on column public.team_rating_snapshots.rating_value is
  'Numeric rating value such as FIFA points or Elo rating. Ranking position belongs in rank_value.';
comment on column public.team_rating_snapshots.rank_value is
  'Ranking position when the rating type is rank-based, such as fifa_rank or elo_rank.';
comment on column public.team_rating_snapshots.rating_date is
  'Date the rating applies to. Ratings are immutable date-stamped snapshots.';
comment on column public.team_rating_snapshots.source_url is
  'Source URL for rating provenance when available. Do not use unsourced hardcoded values.';
comment on column public.team_rating_snapshots.source_snapshot is
  'Source payload, retrieval metadata, provenance notes, and audit context for the rating snapshot.';
comment on column public.team_rating_snapshots.confidence_score is
  'Source and review confidence from 0 to 1. Ratings are supporting inputs and should not override player or lineup data.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'team_rating_snapshots_rating_source_check'
      and conrelid = 'public.team_rating_snapshots'::regclass
  ) then
    alter table public.team_rating_snapshots
      add constraint team_rating_snapshots_rating_source_check
      check (rating_source in ('fifa', 'world_football_elo', 'manual_review'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'team_rating_snapshots_rating_type_check'
      and conrelid = 'public.team_rating_snapshots'::regclass
  ) then
    alter table public.team_rating_snapshots
      add constraint team_rating_snapshots_rating_type_check
      check (rating_type in ('fifa_rank', 'fifa_points', 'elo_rating', 'elo_rank'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'team_rating_snapshots_review_status_check'
      and conrelid = 'public.team_rating_snapshots'::regclass
  ) then
    alter table public.team_rating_snapshots
      add constraint team_rating_snapshots_review_status_check
      check (review_status in ('pending', 'reviewed', 'rejected'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'team_rating_snapshots_confidence_score_check'
      and conrelid = 'public.team_rating_snapshots'::regclass
  ) then
    alter table public.team_rating_snapshots
      add constraint team_rating_snapshots_confidence_score_check
      check (confidence_score between 0 and 1);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'team_rating_snapshots_rating_value_check'
      and conrelid = 'public.team_rating_snapshots'::regclass
  ) then
    alter table public.team_rating_snapshots
      add constraint team_rating_snapshots_rating_value_check
      check (rating_value is null or rating_value >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'team_rating_snapshots_rank_value_check'
      and conrelid = 'public.team_rating_snapshots'::regclass
  ) then
    alter table public.team_rating_snapshots
      add constraint team_rating_snapshots_rank_value_check
      check (rank_value is null or rank_value > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'team_rating_snapshots_provenance_check'
      and conrelid = 'public.team_rating_snapshots'::regclass
  ) then
    alter table public.team_rating_snapshots
      add constraint team_rating_snapshots_provenance_check
      check (
        (source_url is not null and btrim(source_url) <> '')
        or source_snapshot <> '{}'::jsonb
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'team_rating_snapshots_team_code_not_empty_check'
      and conrelid = 'public.team_rating_snapshots'::regclass
  ) then
    alter table public.team_rating_snapshots
      add constraint team_rating_snapshots_team_code_not_empty_check
      check (btrim(team_code) <> '');
  end if;
end $$;

create unique index if not exists team_rating_snapshots_unique_idx
  on public.team_rating_snapshots(tournament_code, team_id, rating_source, rating_type, rating_date);

create index if not exists team_rating_snapshots_tournament_code_idx
  on public.team_rating_snapshots(tournament_code);

create index if not exists team_rating_snapshots_team_id_idx
  on public.team_rating_snapshots(team_id);

create index if not exists team_rating_snapshots_team_code_idx
  on public.team_rating_snapshots(team_code);

create index if not exists team_rating_snapshots_rating_source_idx
  on public.team_rating_snapshots(rating_source);

create index if not exists team_rating_snapshots_rating_type_idx
  on public.team_rating_snapshots(rating_type);

create index if not exists team_rating_snapshots_rating_date_idx
  on public.team_rating_snapshots(rating_date);

create index if not exists team_rating_snapshots_review_status_idx
  on public.team_rating_snapshots(review_status);
