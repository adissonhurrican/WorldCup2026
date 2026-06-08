create table public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  fifa_code text not null unique,
  confederation text,
  group_name text,
  created_at timestamptz not null default now()
);

create table public.fixtures (
  id uuid primary key default gen_random_uuid(),
  home_team_id uuid not null references public.teams(id) on delete restrict,
  away_team_id uuid not null references public.teams(id) on delete restrict,
  match_date date not null,
  kickoff_at timestamptz,
  stage text not null,
  venue text,
  city text,
  status text not null default 'scheduled',
  home_score integer,
  away_score integer,
  created_at timestamptz not null default now(),
  constraint fixtures_distinct_teams check (home_team_id <> away_team_id)
);

create table public.players (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  full_name text not null,
  position text,
  date_of_birth date,
  club text,
  created_at timestamptz not null default now()
);

create table public.squads (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  tournament text not null,
  announced_at timestamptz,
  created_at timestamptz not null default now(),
  constraint squads_team_tournament_unique unique (team_id, tournament)
);

create table public.squad_players (
  id uuid primary key default gen_random_uuid(),
  squad_id uuid not null references public.squads(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  shirt_number integer,
  role text,
  created_at timestamptz not null default now(),
  constraint squad_players_squad_player_unique unique (squad_id, player_id)
);

create table public.team_ratings (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  rating_date date not null,
  elo_rating numeric(8, 2),
  attack_rating numeric(8, 4),
  defense_rating numeric(8, 4),
  form_rating numeric(8, 4),
  source text,
  created_at timestamptz not null default now(),
  constraint team_ratings_team_date_unique unique (team_id, rating_date)
);

create table public.recent_matches (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  opponent_team_id uuid references public.teams(id) on delete set null,
  fixture_id uuid references public.fixtures(id) on delete set null,
  match_date date not null,
  venue_type text,
  goals_for integer not null,
  goals_against integer not null,
  result text not null,
  competition text,
  created_at timestamptz not null default now()
);

create table public.player_metrics (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players(id) on delete cascade,
  fixture_id uuid references public.fixtures(id) on delete set null,
  metric_date date not null,
  minutes_played integer,
  goals numeric(8, 2),
  assists numeric(8, 2),
  expected_goals numeric(8, 4),
  expected_assists numeric(8, 4),
  rating numeric(8, 4),
  created_at timestamptz not null default now()
);

create table public.prediction_runs (
  id uuid primary key default gen_random_uuid(),
  fixture_id uuid references public.fixtures(id) on delete cascade,
  model_name text not null,
  model_version text,
  run_at timestamptz not null default now(),
  input_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.match_predictions (
  id uuid primary key default gen_random_uuid(),
  prediction_run_id uuid not null references public.prediction_runs(id) on delete cascade,
  fixture_id uuid not null references public.fixtures(id) on delete cascade,
  predicted_winner_team_id uuid references public.teams(id) on delete set null,
  home_win_probability numeric(8, 6) not null,
  draw_probability numeric(8, 6) not null,
  away_win_probability numeric(8, 6) not null,
  predicted_home_score numeric(6, 3),
  predicted_away_score numeric(6, 3),
  confidence numeric(8, 6),
  explanation jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint match_predictions_probability_bounds check (
    home_win_probability >= 0
    and home_win_probability <= 1
    and draw_probability >= 0
    and draw_probability <= 1
    and away_win_probability >= 0
    and away_win_probability <= 1
  )
);

create index teams_fifa_code_idx on public.teams(fifa_code);

create index fixtures_home_team_id_idx on public.fixtures(home_team_id);
create index fixtures_away_team_id_idx on public.fixtures(away_team_id);
create index fixtures_match_date_idx on public.fixtures(match_date);

create index players_team_id_idx on public.players(team_id);

create index squads_team_id_idx on public.squads(team_id);

create index squad_players_squad_id_idx on public.squad_players(squad_id);
create index squad_players_player_id_idx on public.squad_players(player_id);

create index team_ratings_team_id_idx on public.team_ratings(team_id);
create index team_ratings_rating_date_idx on public.team_ratings(rating_date);
create index team_ratings_team_id_rating_date_idx on public.team_ratings(team_id, rating_date);

create index recent_matches_team_id_idx on public.recent_matches(team_id);
create index recent_matches_opponent_team_id_idx on public.recent_matches(opponent_team_id);
create index recent_matches_fixture_id_idx on public.recent_matches(fixture_id);
create index recent_matches_match_date_idx on public.recent_matches(match_date);

create index player_metrics_player_id_idx on public.player_metrics(player_id);
create index player_metrics_fixture_id_idx on public.player_metrics(fixture_id);
create index player_metrics_metric_date_idx on public.player_metrics(metric_date);

create index prediction_runs_fixture_id_idx on public.prediction_runs(fixture_id);

create index match_predictions_prediction_run_id_idx on public.match_predictions(prediction_run_id);
create index match_predictions_fixture_id_idx on public.match_predictions(fixture_id);
create index match_predictions_predicted_winner_team_id_idx on public.match_predictions(predicted_winner_team_id);
