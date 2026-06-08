create table if not exists public.tournament_simulation_runs (
  id uuid primary key default gen_random_uuid(),
  prediction_run_id uuid not null,
  simulation_model_version text not null,
  scope text not null,
  simulation_count integer not null,
  random_seed text null,
  source_prediction_run_id uuid null,
  source_match_prediction_count integer null,
  candidate_run boolean not null default true,
  not_global_current_best boolean not null default true,
  tiebreaker_fallback_count integer not null default 0,
  tiebreaker_fallback_rate numeric not null default 0,
  poisson_goal_model_used boolean not null default true,
  poisson_goal_model_note text null,
  run_status text not null default 'candidate',
  source_snapshot jsonb not null default '{}',
  created_at timestamptz not null default now(),
  constraint tournament_simulation_runs_prediction_run_id_fkey
    foreign key (prediction_run_id) references public.prediction_runs(id),
  constraint tournament_simulation_runs_source_prediction_run_id_fkey
    foreign key (source_prediction_run_id) references public.prediction_runs(id),
  constraint tournament_simulation_runs_simulation_count_positive
    check (simulation_count > 0),
  constraint tournament_simulation_runs_tiebreaker_fallback_count_nonnegative
    check (tiebreaker_fallback_count >= 0),
  constraint tournament_simulation_runs_tiebreaker_fallback_rate_valid
    check (tiebreaker_fallback_rate >= 0 and tiebreaker_fallback_rate <= 1),
  constraint tournament_simulation_runs_run_status_check
    check (run_status in ('candidate', 'approved', 'current', 'archived', 'rejected'))
);

create index if not exists tournament_simulation_runs_prediction_run_id_idx
  on public.tournament_simulation_runs(prediction_run_id);

create index if not exists tournament_simulation_runs_scope_idx
  on public.tournament_simulation_runs(scope);

create index if not exists tournament_simulation_runs_simulation_model_version_idx
  on public.tournament_simulation_runs(simulation_model_version);

create index if not exists tournament_simulation_runs_run_status_idx
  on public.tournament_simulation_runs(run_status);

create index if not exists tournament_simulation_runs_created_at_idx
  on public.tournament_simulation_runs(created_at);

comment on table public.tournament_simulation_runs is
  'Monte Carlo result runs derived from stored match_predictions. AI may explain results but must not invent probabilities. Candidate runs are not global current-best unless promoted. No odds or API-Football predictions endpoint involved.';

comment on column public.tournament_simulation_runs.prediction_run_id is
  'Stored prediction_run used as the probability input for this simulation.';

comment on column public.tournament_simulation_runs.source_snapshot is
  'Source-backed metadata including input prediction run context, final-squad status, simulator command, warnings, and guardrails.';

create table if not exists public.tournament_simulation_team_results (
  id uuid primary key default gen_random_uuid(),
  simulation_run_id uuid not null references public.tournament_simulation_runs(id) on delete cascade,
  team_id uuid null,
  team_code text not null,
  team_name text not null,
  group_code text null,
  finish_1st_probability numeric null,
  finish_2nd_probability numeric null,
  finish_3rd_probability numeric null,
  finish_4th_probability numeric null,
  win_group_probability numeric null,
  advance_top_2_probability numeric null,
  reach_round_of_32_probability numeric null,
  reach_round_of_16_probability numeric null,
  reach_quarterfinal_probability numeric null,
  reach_semifinal_probability numeric null,
  reach_final_probability numeric null,
  champion_probability numeric null,
  points_distribution jsonb not null default '{}',
  goal_difference_distribution jsonb not null default '{}',
  source_snapshot jsonb not null default '{}',
  created_at timestamptz not null default now(),
  constraint tournament_simulation_team_results_team_id_fkey
    foreign key (team_id) references public.teams(id),
  constraint tournament_simulation_team_results_probability_checks
    check (
      (finish_1st_probability is null or (finish_1st_probability >= 0 and finish_1st_probability <= 1))
      and (finish_2nd_probability is null or (finish_2nd_probability >= 0 and finish_2nd_probability <= 1))
      and (finish_3rd_probability is null or (finish_3rd_probability >= 0 and finish_3rd_probability <= 1))
      and (finish_4th_probability is null or (finish_4th_probability >= 0 and finish_4th_probability <= 1))
      and (win_group_probability is null or (win_group_probability >= 0 and win_group_probability <= 1))
      and (advance_top_2_probability is null or (advance_top_2_probability >= 0 and advance_top_2_probability <= 1))
      and (reach_round_of_32_probability is null or (reach_round_of_32_probability >= 0 and reach_round_of_32_probability <= 1))
      and (reach_round_of_16_probability is null or (reach_round_of_16_probability >= 0 and reach_round_of_16_probability <= 1))
      and (reach_quarterfinal_probability is null or (reach_quarterfinal_probability >= 0 and reach_quarterfinal_probability <= 1))
      and (reach_semifinal_probability is null or (reach_semifinal_probability >= 0 and reach_semifinal_probability <= 1))
      and (reach_final_probability is null or (reach_final_probability >= 0 and reach_final_probability <= 1))
      and (champion_probability is null or (champion_probability >= 0 and champion_probability <= 1))
    ),
  constraint tournament_simulation_team_results_unique_team
    unique (simulation_run_id, team_code)
);

create index if not exists tournament_simulation_team_results_simulation_run_id_idx
  on public.tournament_simulation_team_results(simulation_run_id);

create index if not exists tournament_simulation_team_results_team_code_idx
  on public.tournament_simulation_team_results(team_code);

create index if not exists tournament_simulation_team_results_group_code_idx
  on public.tournament_simulation_team_results(group_code);

comment on table public.tournament_simulation_team_results is
  'Team-level Monte Carlo probabilities derived from stored match_predictions. These are simulation outputs, not AI-invented probabilities.';

comment on column public.tournament_simulation_team_results.source_snapshot is
  'Team-specific simulation metadata, including final-squad status, source prediction run context, and any limitations.';

create table if not exists public.tournament_simulation_fixture_scorelines (
  id uuid primary key default gen_random_uuid(),
  simulation_run_id uuid not null references public.tournament_simulation_runs(id) on delete cascade,
  fixture_id uuid null,
  fifa_match_id text null,
  fixture_label text not null,
  team_a_code text null,
  team_b_code text null,
  scoreline text not null,
  probability numeric not null,
  source_snapshot jsonb not null default '{}',
  created_at timestamptz not null default now(),
  constraint tournament_simulation_fixture_scorelines_fixture_id_fkey
    foreign key (fixture_id) references public.fixture_metadata(id),
  constraint tournament_simulation_fixture_scorelines_probability_check
    check (probability >= 0 and probability <= 1),
  constraint tournament_simulation_fixture_scorelines_unique_scoreline
    unique (simulation_run_id, fixture_label, scoreline)
);

create index if not exists tournament_simulation_fixture_scorelines_simulation_run_id_idx
  on public.tournament_simulation_fixture_scorelines(simulation_run_id);

create index if not exists tournament_simulation_fixture_scorelines_fixture_id_idx
  on public.tournament_simulation_fixture_scorelines(fixture_id);

create index if not exists tournament_simulation_fixture_scorelines_fifa_match_id_idx
  on public.tournament_simulation_fixture_scorelines(fifa_match_id);

create index if not exists tournament_simulation_fixture_scorelines_fixture_label_idx
  on public.tournament_simulation_fixture_scorelines(fixture_label);

comment on table public.tournament_simulation_fixture_scorelines is
  'Fixture scoreline probabilities from Monte Carlo/Poisson simulation outputs derived from stored match_predictions. No odds or API-Football predictions endpoint involved.';

comment on column public.tournament_simulation_fixture_scorelines.source_snapshot is
  'Fixture-level simulation metadata including Poisson goal model parameters, fitted probabilities, input xG, and approximation warnings.';
