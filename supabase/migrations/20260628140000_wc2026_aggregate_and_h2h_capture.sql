-- WC2026 aggregate + H2H capture tables (API-Football). Additive, idempotent (IF NOT EXISTS).
-- ALL rows are CONTEXT-ONLY (AI narration/evidence) — never a prediction/model input (materiality default).
-- Security: RLS ENABLED with NO policies => default-deny => server-only (service_role bypasses RLS),
-- matching the repo's server-only convention. Project: ahcfrgxczbgdvrqmbisw.

-- ---------- tournament leaderboards (top scorers / assists / yellow / red) ----------
create table if not exists public.wc2026_player_leaderboards (
  id uuid primary key default gen_random_uuid(),
  leaderboard_type text not null check (leaderboard_type in ('top_scorers','top_assists','top_yellow_cards','top_red_cards')),
  rank integer,
  player_id bigint,
  player_name text,
  team_id bigint,
  team_name text,
  value integer,
  goals integer,
  assists integer,
  yellow integer,
  red integer,
  appearances integer,
  minutes integer,
  league_id integer not null default 1,
  season integer not null default 2026,
  source_provider text not null default 'api-football',
  materiality text not null default 'context_only',
  source_snapshot jsonb,
  retrieved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint wc2026_player_leaderboards_unique unique (leaderboard_type, league_id, season, player_id)
);
alter table public.wc2026_player_leaderboards enable row level security;
comment on table public.wc2026_player_leaderboards is 'WC2026 tournament leaderboards (API-Football /players/top*). CONTEXT-ONLY: AI narration/evidence, never a model input. RLS server-only (no policies).';

-- ---------- injuries / availability ----------
create table if not exists public.wc2026_injuries (
  id uuid primary key default gen_random_uuid(),
  player_id bigint,
  player_name text,
  team_id bigint,
  team_name text,
  fixture_id bigint,
  injury_type text,
  reason text,
  injury_date timestamptz,
  league_id integer not null default 1,
  season integer not null default 2026,
  source_provider text not null default 'api-football',
  materiality text not null default 'context_only',
  source_snapshot jsonb,
  retrieved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint wc2026_injuries_unique unique (player_id, fixture_id, reason)
);
alter table public.wc2026_injuries enable row level security;
comment on table public.wc2026_injuries is 'WC2026 injuries/availability (API-Football /injuries). CONTEXT-ONLY: AI narration only, never a model input. RLS server-only (no policies).';

-- ---------- per-team tournament statistics (form / streaks / clean sheets) ----------
create table if not exists public.wc2026_team_statistics (
  id uuid primary key default gen_random_uuid(),
  team_id bigint not null,
  team_name text,
  league_id integer not null default 1,
  season integer not null default 2026,
  form text,
  played integer,
  wins integer,
  draws integer,
  loses integer,
  goals_for integer,
  goals_against integer,
  clean_sheets integer,
  failed_to_score integer,
  streak_wins integer,
  streak_draws integer,
  streak_loses integer,
  biggest_win_home text,
  biggest_win_away text,
  source_provider text not null default 'api-football',
  materiality text not null default 'context_only',
  source_snapshot jsonb,
  retrieved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint wc2026_team_statistics_unique unique (team_id, league_id, season)
);
alter table public.wc2026_team_statistics enable row level security;
comment on table public.wc2026_team_statistics is 'WC2026 per-team tournament stats (API-Football /teams/statistics): form, streaks, clean sheets. CONTEXT-ONLY. RLS server-only (no policies).';

-- ---------- head-to-head history per knockout pairing ----------
create table if not exists public.wc2026_head_to_head (
  id uuid primary key default gen_random_uuid(),
  pairing_key text not null,
  team_a_id bigint,
  team_a_name text,
  team_b_id bigint,
  team_b_name text,
  knockout_round text,
  knockout_match_number integer,
  fixture_id bigint,
  meeting_date timestamptz,
  league_name text,
  home_team_id bigint,
  home_team_name text,
  away_team_id bigint,
  away_team_name text,
  home_goals integer,
  away_goals integer,
  winner_team_id bigint,
  source_provider text not null default 'api-football',
  materiality text not null default 'context_only',
  source_snapshot jsonb,
  retrieved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint wc2026_head_to_head_unique unique (pairing_key, fixture_id)
);
alter table public.wc2026_head_to_head enable row level security;
comment on table public.wc2026_head_to_head is 'WC2026 knockout-pairing head-to-head history (API-Football /fixtures/headtohead). CONTEXT-ONLY. RLS server-only (no policies).';
