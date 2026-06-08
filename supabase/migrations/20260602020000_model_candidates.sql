-- ============================================================================
-- 20260602020000_model_candidates
-- ============================================================================
-- Additive candidate-model registry for v2.1 promotion-REVIEW candidates.
-- This table can NEVER hold a current-best model (hard CHECK current_best=false).
-- Storing rows here does NOT touch prediction_runs / match_predictions / current-best /
-- model_training_runs / v1.3. Fully additive and reversible. RLS default-deny.
-- ============================================================================

create table if not exists public.model_candidates (
  id                        uuid primary key default gen_random_uuid(),
  model_version             text not null unique,
  model_name                text not null,
  candidate_role            text not null,
  algorithm                 text not null,
  feature_list              jsonb not null default '[]'::jsonb,
  parameters                jsonb not null default '{}'::jsonb,
  coefficients              jsonb,
  draw_calibration          jsonb,
  training_dataset_version  text not null,
  train_split               text not null,
  validation_split          text not null,
  validation_metrics        jsonb not null default '{}'::jsonb,
  gate_result               text not null,
  rolling_validation        jsonb,
  caveats                   jsonb not null default '[]'::jsonb,
  source_dataset_version    jsonb not null default '{}'::jsonb,
  current_best              boolean not null default false,
  candidate_run             boolean not null default true,
  not_global_current_best   boolean not null default true,
  status                    text not null default 'candidate_for_promotion_review',
  created_at                timestamptz not null default now(),
  constraint mc_never_current_best check (current_best = false)
);

create index if not exists model_candidates_role_idx on public.model_candidates (candidate_role);

alter table public.model_candidates enable row level security;

comment on table public.model_candidates is 'v2.1 promotion-REVIEW candidate models (D logit primary, C gap x competition fallback). Hard CHECK current_best=false: this registry can never hold a current-best. Additive; does not affect prediction_runs/match_predictions/current-best/v1.3.';
