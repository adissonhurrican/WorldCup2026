create table if not exists public.fifa_world_rankings (
  id uuid primary key default gen_random_uuid(),
  tournament_code text not null default 'WC2026',
  ranking_snapshot_date date not null,
  ranking_schedule_id text not null,
  team_id uuid null references public.teams(id) on delete restrict,
  team_code text not null,
  team_name text not null,
  fifa_country_code text not null,
  fifa_team_name text not null,
  fifa_rank integer not null,
  ranking_points numeric(10,2) not null,
  confederation text null,
  source_provider text not null default 'FIFA',
  source_url text not null,
  source_payload_hash text not null,
  source_cache_path text not null,
  retrieved_at timestamptz not null default now(),
  review_status text not null default 'pending',
  created_at timestamptz not null default now(),
  constraint fifa_world_rankings_rank_positive_check check (fifa_rank > 0),
  constraint fifa_world_rankings_points_nonnegative_check check (ranking_points >= 0),
  constraint fifa_world_rankings_team_code_not_empty_check check (btrim(team_code) <> ''),
  constraint fifa_world_rankings_fifa_country_code_not_empty_check check (btrim(fifa_country_code) <> ''),
  constraint fifa_world_rankings_review_status_check check (review_status in ('pending', 'approved', 'stale', 'rejected')),
  constraint fifa_world_rankings_snapshot_team_unique unique (ranking_snapshot_date, team_code)
);

alter table public.fifa_world_rankings enable row level security;

create index if not exists fifa_world_rankings_snapshot_date_idx
  on public.fifa_world_rankings(ranking_snapshot_date);

create index if not exists fifa_world_rankings_team_code_idx
  on public.fifa_world_rankings(team_code);

create index if not exists fifa_world_rankings_fifa_rank_idx
  on public.fifa_world_rankings(ranking_snapshot_date, fifa_rank);
