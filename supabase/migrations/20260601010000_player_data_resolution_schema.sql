-- Migration: player data resolution schema (Phase 5)
-- Backward-compatible additive migration: new tables + nullable columns only. 0 rows changed.
-- New tables get RLS enabled + default-deny (consistent with 20260601000000_enable_rls_default_deny.sql).
-- Reversible while empty: DROP the new tables / columns.

-- New table: player_career_facts
create table if not exists public.player_career_facts (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players(id),
  fact_type text not null check (fact_type in ('caps_approximation','captaincy','career_role_tier','tournament_squad_member','honor','club_history','active_seasons')),
  fact_value jsonb,
  source_url text,
  source_provider text,
  confidence_score numeric,
  retrieved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists player_career_facts_player_fact_idx on public.player_career_facts (player_id, fact_type);
alter table public.player_career_facts enable row level security;

-- New table: player_tournament_history
create table if not exists public.player_tournament_history (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players(id),
  tournament_code text not null,
  season integer,
  role text,
  captain_in_tournament boolean not null default false,
  source_url text,
  source_provider text,
  retrieved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists player_tournament_history_player_idx on public.player_tournament_history (player_id);
create index if not exists player_tournament_history_tournament_idx on public.player_tournament_history (tournament_code, season);
alter table public.player_tournament_history enable row level security;

-- New table: team_coaches
create table if not exists public.team_coaches (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id),
  api_coach_id integer,
  name text,
  nationality text,
  age integer,
  career_history jsonb,
  source_url text,
  source_provider text,
  retrieved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists team_coaches_team_idx on public.team_coaches (team_id);
alter table public.team_coaches enable row level security;

-- New columns on players (nullable, indexed)
alter table public.players add column if not exists api_football_player_id integer;
alter table public.players add column if not exists wc2026_status text check (wc2026_status in ('confirmed','surplus_provisional','missing','unknown'));
create index if not exists players_api_football_player_id_idx on public.players (api_football_player_id);

-- New columns on player_impact_snapshots (nullable; semantics for v0.8 cleaned signal)
alter table public.player_impact_snapshots add column if not exists recent_national_usage_score numeric;
alter table public.player_impact_snapshots add column if not exists established_role_score numeric;
alter table public.player_impact_snapshots add column if not exists ability_score numeric;
