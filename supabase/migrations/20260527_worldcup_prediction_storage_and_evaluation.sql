create table if not exists public.prediction_runs (
  id uuid primary key default gen_random_uuid(),
  tournament_code text not null default 'WC_2026',
  model_version text not null,
  team_strength_model_version text,
  predictor_version text not null,
  run_scope text not null,
  snapshot_date date,
  generated_at timestamptz not null default now(),
  data_status text not null default 'partial',
  review_status text not null default 'pending',
  notes text,
  source_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.match_predictions (
  id uuid primary key default gen_random_uuid(),
  prediction_run_id uuid not null references public.prediction_runs(id) on delete cascade,
  tournament_code text not null default 'WC_2026',
  fixture_id uuid,
  fixture_label text not null,
  team_a_id uuid references public.teams(id) on delete restrict,
  team_b_id uuid references public.teams(id) on delete restrict,
  team_a_code text not null,
  team_b_code text not null,
  team_a_expected_goals numeric(8,5) not null,
  team_b_expected_goals numeric(8,5) not null,
  team_a_win_probability numeric(8,6) not null,
  draw_probability numeric(8,6) not null,
  team_b_win_probability numeric(8,6) not null,
  match_confidence_score numeric(5,4) not null,
  model_version text not null,
  team_strength_snapshot_a_id uuid references public.team_strength_snapshots(id) on delete restrict,
  team_strength_snapshot_b_id uuid references public.team_strength_snapshots(id) on delete restrict,
  lineup_strength_snapshot_a_id uuid,
  lineup_strength_snapshot_b_id uuid,
  scoreline_probabilities jsonb not null default '{}'::jsonb,
  data_quality jsonb not null default '{}'::jsonb,
  reason_codes jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  method_notes jsonb not null default '[]'::jsonb,
  source_snapshot jsonb not null default '{}'::jsonb,
  valid_for_evaluation boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.match_results (
  id uuid primary key default gen_random_uuid(),
  tournament_code text not null default 'WC_2026',
  fixture_id uuid,
  fixture_label text not null,
  team_a_id uuid references public.teams(id) on delete restrict,
  team_b_id uuid references public.teams(id) on delete restrict,
  team_a_code text not null,
  team_b_code text not null,
  team_a_goals integer,
  team_b_goals integer,
  result text,
  match_status text not null default 'scheduled',
  kickoff_at timestamptz,
  finished_at timestamptz,
  source_provider text,
  source_event_id uuid references public.source_events(id) on delete set null,
  source_snapshot jsonb not null default '{}'::jsonb,
  review_status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.prediction_evaluations (
  id uuid primary key default gen_random_uuid(),
  prediction_id uuid not null references public.match_predictions(id) on delete cascade,
  match_result_id uuid not null references public.match_results(id) on delete cascade,
  tournament_code text not null default 'WC_2026',
  model_version text not null,
  predicted_team_a_win_probability numeric(8,6) not null,
  predicted_draw_probability numeric(8,6) not null,
  predicted_team_b_win_probability numeric(8,6) not null,
  predicted_team_a_xg numeric(8,5) not null,
  predicted_team_b_xg numeric(8,5) not null,
  actual_team_a_goals integer not null,
  actual_team_b_goals integer not null,
  actual_result text not null,
  brier_score numeric(10,6),
  log_loss numeric(10,6),
  xg_error_team_a numeric(8,5),
  xg_error_team_b numeric(8,5),
  xg_error_total numeric(8,5),
  predicted_result_label text,
  predicted_result_correct boolean,
  confidence_score numeric(5,4),
  confidence_bucket text,
  calibration_bucket text,
  evaluation_notes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table if exists public.prediction_runs
  add column if not exists tournament_code text not null default 'WC_2026',
  add column if not exists model_version text,
  add column if not exists team_strength_model_version text,
  add column if not exists predictor_version text,
  add column if not exists run_scope text,
  add column if not exists snapshot_date date,
  add column if not exists generated_at timestamptz not null default now(),
  add column if not exists data_status text not null default 'partial',
  add column if not exists review_status text not null default 'pending',
  add column if not exists notes text,
  add column if not exists source_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists created_at timestamptz not null default now();

alter table if exists public.match_predictions
  add column if not exists prediction_run_id uuid,
  add column if not exists tournament_code text not null default 'WC_2026',
  add column if not exists fixture_id uuid,
  add column if not exists fixture_label text,
  add column if not exists team_a_id uuid,
  add column if not exists team_b_id uuid,
  add column if not exists team_a_code text,
  add column if not exists team_b_code text,
  add column if not exists team_a_expected_goals numeric(8,5),
  add column if not exists team_b_expected_goals numeric(8,5),
  add column if not exists team_a_win_probability numeric(8,6),
  add column if not exists draw_probability numeric(8,6),
  add column if not exists team_b_win_probability numeric(8,6),
  add column if not exists match_confidence_score numeric(5,4),
  add column if not exists model_version text,
  add column if not exists team_strength_snapshot_a_id uuid,
  add column if not exists team_strength_snapshot_b_id uuid,
  add column if not exists lineup_strength_snapshot_a_id uuid,
  add column if not exists lineup_strength_snapshot_b_id uuid,
  add column if not exists scoreline_probabilities jsonb not null default '{}'::jsonb,
  add column if not exists data_quality jsonb not null default '{}'::jsonb,
  add column if not exists reason_codes jsonb not null default '[]'::jsonb,
  add column if not exists warnings jsonb not null default '[]'::jsonb,
  add column if not exists method_notes jsonb not null default '[]'::jsonb,
  add column if not exists source_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists valid_for_evaluation boolean not null default true,
  add column if not exists created_at timestamptz not null default now();

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'prediction_runs'
      and column_name = 'model_name'
  ) then
    alter table public.prediction_runs alter column model_name drop not null;
  end if;

  if not exists (select 1 from public.prediction_runs where model_version is null) then
    alter table public.prediction_runs alter column model_version set not null;
  end if;

  if not exists (select 1 from public.prediction_runs where predictor_version is null) then
    alter table public.prediction_runs alter column predictor_version set not null;
  end if;

  if not exists (select 1 from public.prediction_runs where run_scope is null) then
    alter table public.prediction_runs alter column run_scope set not null;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'match_predictions'
      and column_name = 'fixture_id'
  ) then
    alter table public.match_predictions alter column fixture_id drop not null;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'match_predictions'
      and column_name = 'home_win_probability'
  ) then
    alter table public.match_predictions alter column home_win_probability drop not null;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'match_predictions'
      and column_name = 'away_win_probability'
  ) then
    alter table public.match_predictions alter column away_win_probability drop not null;
  end if;

  if not exists (select 1 from public.match_predictions where prediction_run_id is null) then
    alter table public.match_predictions alter column prediction_run_id set not null;
  end if;

  if not exists (select 1 from public.match_predictions where fixture_label is null) then
    alter table public.match_predictions alter column fixture_label set not null;
  end if;

  if not exists (select 1 from public.match_predictions where team_a_code is null) then
    alter table public.match_predictions alter column team_a_code set not null;
  end if;

  if not exists (select 1 from public.match_predictions where team_b_code is null) then
    alter table public.match_predictions alter column team_b_code set not null;
  end if;

  if not exists (select 1 from public.match_predictions where team_a_expected_goals is null) then
    alter table public.match_predictions alter column team_a_expected_goals set not null;
  end if;

  if not exists (select 1 from public.match_predictions where team_b_expected_goals is null) then
    alter table public.match_predictions alter column team_b_expected_goals set not null;
  end if;

  if not exists (select 1 from public.match_predictions where team_a_win_probability is null) then
    alter table public.match_predictions alter column team_a_win_probability set not null;
  end if;

  if not exists (select 1 from public.match_predictions where draw_probability is null) then
    alter table public.match_predictions alter column draw_probability set not null;
  end if;

  if not exists (select 1 from public.match_predictions where team_b_win_probability is null) then
    alter table public.match_predictions alter column team_b_win_probability set not null;
  end if;

  if not exists (select 1 from public.match_predictions where match_confidence_score is null) then
    alter table public.match_predictions alter column match_confidence_score set not null;
  end if;

  if not exists (select 1 from public.match_predictions where model_version is null) then
    alter table public.match_predictions alter column model_version set not null;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'match_predictions_prediction_run_id_storage_fkey'
      and conrelid = 'public.match_predictions'::regclass
  ) then
    alter table public.match_predictions
      add constraint match_predictions_prediction_run_id_storage_fkey
      foreign key (prediction_run_id) references public.prediction_runs(id) on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'match_predictions_team_a_id_storage_fkey'
      and conrelid = 'public.match_predictions'::regclass
  ) then
    alter table public.match_predictions
      add constraint match_predictions_team_a_id_storage_fkey
      foreign key (team_a_id) references public.teams(id) on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'match_predictions_team_b_id_storage_fkey'
      and conrelid = 'public.match_predictions'::regclass
  ) then
    alter table public.match_predictions
      add constraint match_predictions_team_b_id_storage_fkey
      foreign key (team_b_id) references public.teams(id) on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'match_predictions_team_strength_a_storage_fkey'
      and conrelid = 'public.match_predictions'::regclass
  ) then
    alter table public.match_predictions
      add constraint match_predictions_team_strength_a_storage_fkey
      foreign key (team_strength_snapshot_a_id) references public.team_strength_snapshots(id) on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'match_predictions_team_strength_b_storage_fkey'
      and conrelid = 'public.match_predictions'::regclass
  ) then
    alter table public.match_predictions
      add constraint match_predictions_team_strength_b_storage_fkey
      foreign key (team_strength_snapshot_b_id) references public.team_strength_snapshots(id) on delete restrict;
  end if;
end $$;

comment on table public.prediction_runs is
  'One read-only prediction generation run over a fixture, group matrix, or tournament batch.';
comment on column public.prediction_runs.run_scope is
  'Scope of prediction run: single_fixture, group_matrix, or tournament_batch.';
comment on column public.prediction_runs.snapshot_date is
  'Model/input snapshot date used by the predictor.';
comment on column public.prediction_runs.source_snapshot is
  'Audit metadata for predictor inputs, command context, fixture list, and warnings.';

comment on table public.match_predictions is
  'One stored prediction for a fixture/team pair from a prediction run.';
comment on column public.match_predictions.fixture_id is
  'Nullable while fixture metadata is placeholder or not yet mapped to a final source fixture.';
comment on column public.match_predictions.scoreline_probabilities is
  'Normalized Poisson scoreline probability grid from the predictor.';
comment on column public.match_predictions.data_quality is
  'Structured missing-input, confidence, and fixture metadata flags used by the UI and analyst.';
comment on column public.match_predictions.reason_codes is
  'Deterministic reason codes emitted by the predictor; not AI-generated probabilities.';
comment on column public.match_predictions.valid_for_evaluation is
  'False when prediction was generated after result was known or otherwise not valid for evaluation.';
comment on column public.match_predictions.source_snapshot is
  'Input snapshot IDs and model metadata needed to audit and reproduce the prediction.';

comment on table public.match_results is
  'Official or reviewed final result for a fixture.';
comment on column public.match_results.result is
  'Normalized result: team_a_win, draw, or team_b_win.';
comment on column public.match_results.match_status is
  'Fixture status: scheduled, live, finished, abandoned, or postponed.';
comment on column public.match_results.source_snapshot is
  'Source context for the score/result, including provider, endpoint, response hash, and review metadata.';

comment on table public.prediction_evaluations is
  'Deterministic evaluation of one stored match prediction against one match result.';
comment on column public.prediction_evaluations.brier_score is
  'Three-class Brier score using team_a_win, draw, and team_b_win probabilities.';
comment on column public.prediction_evaluations.log_loss is
  'Negative log probability assigned to the actual outcome with epsilon floor.';
comment on column public.prediction_evaluations.calibration_bucket is
  'Bucket for predicted probability of the predicted result class.';
comment on column public.prediction_evaluations.evaluation_notes is
  'Structured evaluation notes, warnings, and data-quality context.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'prediction_runs_run_scope_check'
      and conrelid = 'public.prediction_runs'::regclass
  ) then
    alter table public.prediction_runs
      add constraint prediction_runs_run_scope_check
      check (run_scope in ('single_fixture', 'group_matrix', 'tournament_batch'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'prediction_runs_data_status_check'
      and conrelid = 'public.prediction_runs'::regclass
  ) then
    alter table public.prediction_runs
      add constraint prediction_runs_data_status_check
      check (data_status in ('complete', 'partial', 'placeholder', 'outdated'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'prediction_runs_review_status_check'
      and conrelid = 'public.prediction_runs'::regclass
  ) then
    alter table public.prediction_runs
      add constraint prediction_runs_review_status_check
      check (review_status in ('pending', 'reviewed', 'rejected'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'match_predictions_probability_range_check'
      and conrelid = 'public.match_predictions'::regclass
  ) then
    alter table public.match_predictions
      add constraint match_predictions_probability_range_check
      check (
        team_a_win_probability between 0 and 1
        and draw_probability between 0 and 1
        and team_b_win_probability between 0 and 1
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'match_predictions_probability_sum_check'
      and conrelid = 'public.match_predictions'::regclass
  ) then
    alter table public.match_predictions
      add constraint match_predictions_probability_sum_check
      check (abs((team_a_win_probability + draw_probability + team_b_win_probability) - 1.0) <= 0.0005);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'match_predictions_expected_goals_check'
      and conrelid = 'public.match_predictions'::regclass
  ) then
    alter table public.match_predictions
      add constraint match_predictions_expected_goals_check
      check (team_a_expected_goals >= 0 and team_b_expected_goals >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'match_predictions_confidence_check'
      and conrelid = 'public.match_predictions'::regclass
  ) then
    alter table public.match_predictions
      add constraint match_predictions_confidence_check
      check (match_confidence_score between 0 and 1);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'match_predictions_distinct_teams_check'
      and conrelid = 'public.match_predictions'::regclass
  ) then
    alter table public.match_predictions
      add constraint match_predictions_distinct_teams_check
      check (
        team_a_code <> team_b_code
        and (team_a_id is null or team_b_id is null or team_a_id <> team_b_id)
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'match_results_result_check'
      and conrelid = 'public.match_results'::regclass
  ) then
    alter table public.match_results
      add constraint match_results_result_check
      check (result is null or result in ('team_a_win', 'draw', 'team_b_win'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'match_results_match_status_check'
      and conrelid = 'public.match_results'::regclass
  ) then
    alter table public.match_results
      add constraint match_results_match_status_check
      check (match_status in ('scheduled', 'live', 'finished', 'abandoned', 'postponed'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'match_results_review_status_check'
      and conrelid = 'public.match_results'::regclass
  ) then
    alter table public.match_results
      add constraint match_results_review_status_check
      check (review_status in ('pending', 'reviewed', 'rejected'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'match_results_goals_check'
      and conrelid = 'public.match_results'::regclass
  ) then
    alter table public.match_results
      add constraint match_results_goals_check
      check (
        (team_a_goals is null or team_a_goals >= 0)
        and (team_b_goals is null or team_b_goals >= 0)
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'match_results_distinct_teams_check'
      and conrelid = 'public.match_results'::regclass
  ) then
    alter table public.match_results
      add constraint match_results_distinct_teams_check
      check (
        team_a_code <> team_b_code
        and (team_a_id is null or team_b_id is null or team_a_id <> team_b_id)
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'prediction_evaluations_probability_range_check'
      and conrelid = 'public.prediction_evaluations'::regclass
  ) then
    alter table public.prediction_evaluations
      add constraint prediction_evaluations_probability_range_check
      check (
        predicted_team_a_win_probability between 0 and 1
        and predicted_draw_probability between 0 and 1
        and predicted_team_b_win_probability between 0 and 1
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'prediction_evaluations_probability_sum_check'
      and conrelid = 'public.prediction_evaluations'::regclass
  ) then
    alter table public.prediction_evaluations
      add constraint prediction_evaluations_probability_sum_check
      check (abs((predicted_team_a_win_probability + predicted_draw_probability + predicted_team_b_win_probability) - 1.0) <= 0.0005);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'prediction_evaluations_xg_check'
      and conrelid = 'public.prediction_evaluations'::regclass
  ) then
    alter table public.prediction_evaluations
      add constraint prediction_evaluations_xg_check
      check (predicted_team_a_xg >= 0 and predicted_team_b_xg >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'prediction_evaluations_actual_goals_check'
      and conrelid = 'public.prediction_evaluations'::regclass
  ) then
    alter table public.prediction_evaluations
      add constraint prediction_evaluations_actual_goals_check
      check (actual_team_a_goals >= 0 and actual_team_b_goals >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'prediction_evaluations_actual_result_check'
      and conrelid = 'public.prediction_evaluations'::regclass
  ) then
    alter table public.prediction_evaluations
      add constraint prediction_evaluations_actual_result_check
      check (actual_result in ('team_a_win', 'draw', 'team_b_win'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'prediction_evaluations_predicted_result_check'
      and conrelid = 'public.prediction_evaluations'::regclass
  ) then
    alter table public.prediction_evaluations
      add constraint prediction_evaluations_predicted_result_check
      check (predicted_result_label is null or predicted_result_label in ('team_a_win', 'draw', 'team_b_win'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'prediction_evaluations_confidence_check'
      and conrelid = 'public.prediction_evaluations'::regclass
  ) then
    alter table public.prediction_evaluations
      add constraint prediction_evaluations_confidence_check
      check (confidence_score is null or confidence_score between 0 and 1);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'prediction_evaluations_metric_nonnegative_check'
      and conrelid = 'public.prediction_evaluations'::regclass
  ) then
    alter table public.prediction_evaluations
      add constraint prediction_evaluations_metric_nonnegative_check
      check (
        (brier_score is null or brier_score >= 0)
        and (log_loss is null or log_loss >= 0)
        and (xg_error_team_a is null or xg_error_team_a >= 0)
        and (xg_error_team_b is null or xg_error_team_b >= 0)
        and (xg_error_total is null or xg_error_total >= 0)
      );
  end if;
end $$;

create index if not exists prediction_runs_tournament_code_idx
  on public.prediction_runs(tournament_code);
create index if not exists prediction_runs_model_version_idx
  on public.prediction_runs(model_version);
create index if not exists prediction_runs_predictor_version_idx
  on public.prediction_runs(predictor_version);
create index if not exists prediction_runs_generated_at_idx
  on public.prediction_runs(generated_at);
create index if not exists prediction_runs_run_scope_idx
  on public.prediction_runs(run_scope);

create index if not exists match_predictions_prediction_run_id_idx
  on public.match_predictions(prediction_run_id);
create index if not exists match_predictions_tournament_code_idx
  on public.match_predictions(tournament_code);
create index if not exists match_predictions_fixture_label_idx
  on public.match_predictions(fixture_label);
create index if not exists match_predictions_model_version_idx
  on public.match_predictions(model_version);
create index if not exists match_predictions_created_at_idx
  on public.match_predictions(created_at);
create index if not exists match_predictions_team_codes_idx
  on public.match_predictions(team_a_code, team_b_code);
create unique index if not exists match_predictions_run_fixture_team_codes_unique_idx
  on public.match_predictions(prediction_run_id, fixture_label, team_a_code, team_b_code);

create index if not exists match_results_tournament_code_idx
  on public.match_results(tournament_code);
create index if not exists match_results_fixture_label_idx
  on public.match_results(fixture_label);
create index if not exists match_results_match_status_idx
  on public.match_results(match_status);
create index if not exists match_results_kickoff_at_idx
  on public.match_results(kickoff_at);
create index if not exists match_results_source_event_id_idx
  on public.match_results(source_event_id);

create index if not exists prediction_evaluations_prediction_id_idx
  on public.prediction_evaluations(prediction_id);
create index if not exists prediction_evaluations_match_result_id_idx
  on public.prediction_evaluations(match_result_id);
create index if not exists prediction_evaluations_model_version_idx
  on public.prediction_evaluations(model_version);
create index if not exists prediction_evaluations_confidence_bucket_idx
  on public.prediction_evaluations(confidence_bucket);
create index if not exists prediction_evaluations_calibration_bucket_idx
  on public.prediction_evaluations(calibration_bucket);
create unique index if not exists prediction_evaluations_prediction_result_unique_idx
  on public.prediction_evaluations(prediction_id, match_result_id);
