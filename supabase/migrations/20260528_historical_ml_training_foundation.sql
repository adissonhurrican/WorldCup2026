create table if not exists public.historical_matches (
  id uuid primary key default gen_random_uuid(),
  source_provider text not null,
  source_match_id text not null,
  league_id text,
  league_name text,
  season integer,
  match_date timestamptz not null,
  home_team_name text not null,
  away_team_name text not null,
  home_team_api_id text,
  away_team_api_id text,
  home_team_id uuid references public.teams(id) on delete set null,
  away_team_id uuid references public.teams(id) on delete set null,
  home_goals integer,
  away_goals integer,
  status text not null,
  fixture_type text,
  round text,
  venue_name text,
  venue_city text,
  country text,
  neutral_site boolean,
  result text,
  source_snapshot jsonb not null default '{}'::jsonb,
  api_response_hash text,
  review_status text not null default 'pending',
  created_at timestamptz not null default now()
);

comment on table public.historical_matches is
  'Raw historical international fixtures and results for ML training data staging.';
comment on column public.historical_matches.source_snapshot is
  'Raw source payload and provenance metadata. API-Football predictions and odds must not be stored here.';
comment on column public.historical_matches.neutral_site is
  'Neutral-site signal when source-backed; may remain null when unavailable or unreliable.';
comment on column public.historical_matches.result is
  'Result from the home-team perspective: home_win, draw, away_win, or unknown.';

create table if not exists public.historical_team_match_features (
  id uuid primary key default gen_random_uuid(),
  historical_match_id uuid not null references public.historical_matches(id) on delete cascade,
  team_side text not null,
  team_name text not null,
  opponent_name text not null,
  team_id uuid references public.teams(id) on delete set null,
  opponent_team_id uuid references public.teams(id) on delete set null,
  is_home boolean not null,
  is_neutral boolean,
  match_date timestamptz not null,
  elo_before numeric,
  elo_rank_before integer,
  form_5_points numeric,
  form_10_points numeric,
  gf_last_5 numeric,
  ga_last_5 numeric,
  gd_last_5 numeric,
  gf_last_10 numeric,
  ga_last_10 numeric,
  gd_last_10 numeric,
  days_since_last_match integer,
  competition_weight numeric,
  feature_snapshot jsonb not null default '{}'::jsonb,
  feature_version text not null default 'historical-team-features-v0.1',
  review_status text not null default 'pending',
  created_at timestamptz not null default now()
);

comment on table public.historical_team_match_features is
  'One pre-match feature row per team per historical match. Features must be available before match kickoff.';
comment on column public.historical_team_match_features.feature_snapshot is
  'Feature provenance, source dates, source gaps, and leakage-check context.';
comment on column public.historical_team_match_features.feature_version is
  'Versioned feature generation logic for reproducible ML training datasets.';

create table if not exists public.training_match_examples (
  id uuid primary key default gen_random_uuid(),
  historical_match_id uuid not null references public.historical_matches(id) on delete cascade,
  example_version text not null default 'training-match-example-v0.1',
  match_date timestamptz not null,
  team_a_name text not null,
  team_b_name text not null,
  team_a_id uuid references public.teams(id) on delete set null,
  team_b_id uuid references public.teams(id) on delete set null,
  elo_diff numeric,
  form_5_diff numeric,
  form_10_diff numeric,
  gf_last_10_diff numeric,
  ga_last_10_diff numeric,
  neutral_site boolean,
  competition_weight numeric,
  target_team_a_goals integer,
  target_team_b_goals integer,
  target_result text not null,
  feature_snapshot jsonb not null default '{}'::jsonb,
  leakage_check_passed boolean not null default false,
  review_status text not null default 'pending',
  created_at timestamptz not null default now()
);

comment on table public.training_match_examples is
  'Model-ready historical match examples with pre-match features and known post-match targets.';
comment on column public.training_match_examples.feature_snapshot is
  'Feature provenance and leakage-check evidence. Do not include post-match inputs except target labels.';
comment on column public.training_match_examples.leakage_check_passed is
  'True only after confirming all features were available before match_date.';

create table if not exists public.model_training_runs (
  id uuid primary key default gen_random_uuid(),
  model_name text not null,
  model_version text not null,
  training_dataset_version text not null,
  train_start_date date,
  train_end_date date,
  test_start_date date,
  test_end_date date,
  algorithm text not null,
  parameters jsonb not null default '{}'::jsonb,
  feature_list jsonb not null default '[]'::jsonb,
  source_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.model_training_runs is
  'Metadata for ML training and backtest runs. Current deterministic prediction runs remain separate.';
comment on column public.model_training_runs.source_snapshot is
  'Training data sources, cutoffs, feature versions, guardrails, and no-odds/no-API-predictions provenance.';

create table if not exists public.model_backtest_results (
  id uuid primary key default gen_random_uuid(),
  training_run_id uuid not null references public.model_training_runs(id) on delete cascade,
  test_match_count integer not null default 0,
  brier_score numeric,
  log_loss numeric,
  accuracy numeric,
  calibration_summary jsonb not null default '{}'::jsonb,
  metrics_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.model_backtest_results is
  'Aggregate evaluation metrics for a model training run over a date-based test split.';
comment on column public.model_backtest_results.calibration_summary is
  'Calibration curve buckets and related summary diagnostics.';

create table if not exists public.model_predictions_backtest (
  id uuid primary key default gen_random_uuid(),
  training_run_id uuid not null references public.model_training_runs(id) on delete cascade,
  historical_match_id uuid not null references public.historical_matches(id) on delete cascade,
  predicted_team_a_win numeric not null,
  predicted_draw numeric not null,
  predicted_team_b_win numeric not null,
  actual_result text not null,
  prediction_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.model_predictions_backtest is
  'Per-match backtest predictions, actual outcomes, and prediction provenance.';
comment on column public.model_predictions_backtest.prediction_snapshot is
  'Per-match feature inputs, model output, and audit details for backtest reproducibility.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'historical_matches_source_provider_not_empty_check'
      and conrelid = 'public.historical_matches'::regclass
  ) then
    alter table public.historical_matches
      add constraint historical_matches_source_provider_not_empty_check
      check (btrim(source_provider) <> '');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'historical_matches_source_match_id_not_empty_check'
      and conrelid = 'public.historical_matches'::regclass
  ) then
    alter table public.historical_matches
      add constraint historical_matches_source_match_id_not_empty_check
      check (btrim(source_match_id) <> '');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'historical_matches_home_team_name_not_empty_check'
      and conrelid = 'public.historical_matches'::regclass
  ) then
    alter table public.historical_matches
      add constraint historical_matches_home_team_name_not_empty_check
      check (btrim(home_team_name) <> '');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'historical_matches_away_team_name_not_empty_check'
      and conrelid = 'public.historical_matches'::regclass
  ) then
    alter table public.historical_matches
      add constraint historical_matches_away_team_name_not_empty_check
      check (btrim(away_team_name) <> '');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'historical_matches_result_check'
      and conrelid = 'public.historical_matches'::regclass
  ) then
    alter table public.historical_matches
      add constraint historical_matches_result_check
      check (result is null or result in ('home_win', 'draw', 'away_win', 'unknown'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'historical_matches_review_status_check'
      and conrelid = 'public.historical_matches'::regclass
  ) then
    alter table public.historical_matches
      add constraint historical_matches_review_status_check
      check (review_status in ('pending', 'reviewed', 'rejected'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'historical_matches_goals_non_negative_check'
      and conrelid = 'public.historical_matches'::regclass
  ) then
    alter table public.historical_matches
      add constraint historical_matches_goals_non_negative_check
      check (
        (home_goals is null or home_goals >= 0)
        and (away_goals is null or away_goals >= 0)
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'historical_team_match_features_team_side_check'
      and conrelid = 'public.historical_team_match_features'::regclass
  ) then
    alter table public.historical_team_match_features
      add constraint historical_team_match_features_team_side_check
      check (team_side in ('home', 'away'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'historical_team_match_features_review_status_check'
      and conrelid = 'public.historical_team_match_features'::regclass
  ) then
    alter table public.historical_team_match_features
      add constraint historical_team_match_features_review_status_check
      check (review_status in ('pending', 'reviewed', 'rejected'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'historical_team_match_features_days_since_last_match_check'
      and conrelid = 'public.historical_team_match_features'::regclass
  ) then
    alter table public.historical_team_match_features
      add constraint historical_team_match_features_days_since_last_match_check
      check (days_since_last_match is null or days_since_last_match >= 0);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'training_match_examples_target_result_check'
      and conrelid = 'public.training_match_examples'::regclass
  ) then
    alter table public.training_match_examples
      add constraint training_match_examples_target_result_check
      check (target_result in ('team_a_win', 'draw', 'team_b_win'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'training_match_examples_goals_non_negative_check'
      and conrelid = 'public.training_match_examples'::regclass
  ) then
    alter table public.training_match_examples
      add constraint training_match_examples_goals_non_negative_check
      check (
        (target_team_a_goals is null or target_team_a_goals >= 0)
        and (target_team_b_goals is null or target_team_b_goals >= 0)
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'training_match_examples_review_status_check'
      and conrelid = 'public.training_match_examples'::regclass
  ) then
    alter table public.training_match_examples
      add constraint training_match_examples_review_status_check
      check (review_status in ('pending', 'reviewed', 'rejected'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'model_training_runs_names_not_empty_check'
      and conrelid = 'public.model_training_runs'::regclass
  ) then
    alter table public.model_training_runs
      add constraint model_training_runs_names_not_empty_check
      check (
        btrim(model_name) <> ''
        and btrim(model_version) <> ''
        and btrim(training_dataset_version) <> ''
        and btrim(algorithm) <> ''
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'model_backtest_results_test_match_count_check'
      and conrelid = 'public.model_backtest_results'::regclass
  ) then
    alter table public.model_backtest_results
      add constraint model_backtest_results_test_match_count_check
      check (test_match_count >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'model_backtest_results_metrics_check'
      and conrelid = 'public.model_backtest_results'::regclass
  ) then
    alter table public.model_backtest_results
      add constraint model_backtest_results_metrics_check
      check (
        (brier_score is null or brier_score >= 0)
        and (log_loss is null or log_loss >= 0)
        and (accuracy is null or (accuracy >= 0 and accuracy <= 1))
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'model_predictions_backtest_probabilities_check'
      and conrelid = 'public.model_predictions_backtest'::regclass
  ) then
    alter table public.model_predictions_backtest
      add constraint model_predictions_backtest_probabilities_check
      check (
        predicted_team_a_win between 0 and 1
        and predicted_draw between 0 and 1
        and predicted_team_b_win between 0 and 1
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'model_predictions_backtest_actual_result_check'
      and conrelid = 'public.model_predictions_backtest'::regclass
  ) then
    alter table public.model_predictions_backtest
      add constraint model_predictions_backtest_actual_result_check
      check (actual_result in ('team_a_win', 'draw', 'team_b_win'));
  end if;
end $$;

create unique index if not exists historical_matches_source_provider_match_id_unique_idx
  on public.historical_matches(source_provider, source_match_id);

create index if not exists historical_matches_source_provider_source_match_id_idx
  on public.historical_matches(source_provider, source_match_id);
create index if not exists historical_matches_match_date_idx
  on public.historical_matches(match_date);
create index if not exists historical_matches_home_team_id_idx
  on public.historical_matches(home_team_id);
create index if not exists historical_matches_away_team_id_idx
  on public.historical_matches(away_team_id);
create index if not exists historical_matches_home_team_api_id_idx
  on public.historical_matches(home_team_api_id);
create index if not exists historical_matches_away_team_api_id_idx
  on public.historical_matches(away_team_api_id);
create index if not exists historical_matches_league_id_idx
  on public.historical_matches(league_id);
create index if not exists historical_matches_season_idx
  on public.historical_matches(season);
create index if not exists historical_matches_status_idx
  on public.historical_matches(status);
create index if not exists historical_matches_result_idx
  on public.historical_matches(result);

create unique index if not exists historical_team_match_features_match_side_version_unique_idx
  on public.historical_team_match_features(historical_match_id, team_side, feature_version);

create index if not exists historical_team_match_features_historical_match_id_idx
  on public.historical_team_match_features(historical_match_id);
create index if not exists historical_team_match_features_team_id_idx
  on public.historical_team_match_features(team_id);
create index if not exists historical_team_match_features_opponent_team_id_idx
  on public.historical_team_match_features(opponent_team_id);
create index if not exists historical_team_match_features_match_date_idx
  on public.historical_team_match_features(match_date);
create index if not exists historical_team_match_features_feature_version_idx
  on public.historical_team_match_features(feature_version);
create index if not exists historical_team_match_features_review_status_idx
  on public.historical_team_match_features(review_status);

create unique index if not exists training_match_examples_match_version_unique_idx
  on public.training_match_examples(historical_match_id, example_version);

create index if not exists training_match_examples_historical_match_id_idx
  on public.training_match_examples(historical_match_id);
create index if not exists training_match_examples_example_version_idx
  on public.training_match_examples(example_version);
create index if not exists training_match_examples_match_date_idx
  on public.training_match_examples(match_date);
create index if not exists training_match_examples_target_result_idx
  on public.training_match_examples(target_result);
create index if not exists training_match_examples_leakage_check_passed_idx
  on public.training_match_examples(leakage_check_passed);

create index if not exists model_training_runs_model_name_idx
  on public.model_training_runs(model_name);
create index if not exists model_training_runs_model_version_idx
  on public.model_training_runs(model_version);
create index if not exists model_training_runs_training_dataset_version_idx
  on public.model_training_runs(training_dataset_version);
create index if not exists model_training_runs_algorithm_idx
  on public.model_training_runs(algorithm);
create index if not exists model_training_runs_created_at_idx
  on public.model_training_runs(created_at);

create index if not exists model_backtest_results_training_run_id_idx
  on public.model_backtest_results(training_run_id);
create index if not exists model_backtest_results_created_at_idx
  on public.model_backtest_results(created_at);

create unique index if not exists model_predictions_backtest_run_match_unique_idx
  on public.model_predictions_backtest(training_run_id, historical_match_id);

create index if not exists model_predictions_backtest_training_run_id_idx
  on public.model_predictions_backtest(training_run_id);
create index if not exists model_predictions_backtest_historical_match_id_idx
  on public.model_predictions_backtest(historical_match_id);
create index if not exists model_predictions_backtest_actual_result_idx
  on public.model_predictions_backtest(actual_result);
