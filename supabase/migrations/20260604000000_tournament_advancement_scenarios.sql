-- Additive advancement-scenario-v1 store. Append-only, candidate-tagged, RLS default-deny (no policy).
create table if not exists public.tournament_advancement_scenarios (
  id uuid primary key default gen_random_uuid(),
  simulation_run_id uuid not null references public.tournament_simulation_runs(id) on delete cascade,
  scenario_model_version text not null default 'advancement-scenario-v1',
  tournament_code text not null,
  phase text not null default 'pre_tournament' check (phase in ('pre_tournament','live')),
  as_of_result_count integer not null default 0,
  source_prediction_run_id uuid null references public.prediction_runs(id),
  fifa_ranking_snapshot_date date null,
  tiebreaker_ladder_version text not null default 'fifa-2026-article-13-v1',
  team_count integer not null,
  sum_advance_total numeric null,
  document jsonb not null,
  candidate_run boolean not null default true,
  not_global_current_best boolean not null default true,
  run_status text not null default 'candidate' check (run_status in ('candidate','approved','current','archived','rejected')),
  source_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint tas_unique_snapshot unique (simulation_run_id, scenario_model_version, phase, as_of_result_count),
  constraint tas_never_current_best check (not_global_current_best = true)
);
create index if not exists tas_simulation_run_id_idx on public.tournament_advancement_scenarios (simulation_run_id);
create index if not exists tas_team_phase_idx on public.tournament_advancement_scenarios (phase, as_of_result_count);
alter table public.tournament_advancement_scenarios enable row level security;
comment on table public.tournament_advancement_scenarios is 'advancement-scenario-v1 documents derived from a stored tournament_simulation_runs row (corrected Article-13 ladder). Append-only via UNIQUE(run,version,phase,as_of_result_count); candidate-tagged; never current-best; RLS default-deny (no policy). Additive; does not modify existing tables.';
