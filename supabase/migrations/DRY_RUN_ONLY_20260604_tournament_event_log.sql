-- DIRECT APPLY STATUS: applied directly to project ahcfrgxczbgdvrqmbisw on 2026-06-04
-- using single-statement Supabase CLI `db query --file` executions. This file is not recorded
-- in Supabase migration history because broad `db push` / `migration repair` is intentionally
-- deferred until duplicate local migration version prefixes are normalized.
--
-- Original status: DRY RUN ONLY.
-- Project: ahcfrgxczbgdvrqmbisw
-- Purpose: additive tournament event-log spine for live WC2026 update auditing.
-- Do not broad-push this file until migration history has a deliberate baseline plan.

create table if not exists public.tournament_event_log (
  id uuid primary key default gen_random_uuid(),
  tournament_code text not null default 'WC_2026',
  orchestrator_run_id uuid null,
  event_type text not null,
  source text not null,
  source_url text null,
  source_payload_hash text null,
  event_time timestamptz null,
  ingested_at timestamptz not null default now(),
  affected_fixture_metadata_id uuid null references public.fixture_metadata(id) on delete set null,
  affected_fixture_label text null,
  affected_api_football_fixture_id bigint null,
  affected_team_id uuid null references public.teams(id) on delete set null,
  affected_team_code text null,
  affected_player_id uuid null references public.players(id) on delete set null,
  affected_api_football_player_id bigint null,
  old_value jsonb not null default '{}'::jsonb,
  new_value jsonb not null default '{}'::jsonb,
  confidence text not null,
  gate_decision text not null,
  gate_reason text not null,
  rerun_triggered boolean not null default false,
  triggered_run_id uuid null,
  triggered_run_kind text null,
  source_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint tournament_event_log_confidence_check
    check (confidence in ('verified', 'reported', 'unconfirmed')),
  constraint tournament_event_log_gate_decision_check
    check (gate_decision in ('material', 'context_only')),
  constraint tournament_event_log_trigger_pair_check
    check (
      (rerun_triggered = false and triggered_run_id is null)
      or rerun_triggered = true
    ),
  constraint tournament_event_log_source_not_empty_check
    check (btrim(source) <> ''),
  constraint tournament_event_log_event_type_not_empty_check
    check (btrim(event_type) <> ''),
  constraint tournament_event_log_gate_reason_not_empty_check
    check (btrim(gate_reason) <> '')
);

create index if not exists tournament_event_log_tournament_code_idx
  on public.tournament_event_log(tournament_code);
create index if not exists tournament_event_log_orchestrator_run_id_idx
  on public.tournament_event_log(orchestrator_run_id);
create index if not exists tournament_event_log_event_type_idx
  on public.tournament_event_log(event_type);
create index if not exists tournament_event_log_event_time_idx
  on public.tournament_event_log(event_time);
create index if not exists tournament_event_log_ingested_at_idx
  on public.tournament_event_log(ingested_at);
create index if not exists tournament_event_log_fixture_metadata_idx
  on public.tournament_event_log(affected_fixture_metadata_id);
create index if not exists tournament_event_log_api_fixture_idx
  on public.tournament_event_log(affected_api_football_fixture_id);
create index if not exists tournament_event_log_team_code_idx
  on public.tournament_event_log(affected_team_code);
create index if not exists tournament_event_log_player_id_idx
  on public.tournament_event_log(affected_player_id);
create index if not exists tournament_event_log_gate_decision_idx
  on public.tournament_event_log(gate_decision);
create index if not exists tournament_event_log_rerun_triggered_idx
  on public.tournament_event_log(rerun_triggered);

comment on table public.tournament_event_log is
  'Append-only audit spine for WC2026 live updates. Every data/model change gets one row so probability movement can be traced to its source. Default-deny RLS; no read/write policy is created here.';
comment on column public.tournament_event_log.event_type is
  'Examples: result_verified, lineup_ingested, minutes_ingested, card_suspension_context, group_table_recomputed, prediction_candidate_run, monte_carlo_candidate_run, elo_k60_candidate_update, ai_post_result_narration.';
comment on column public.tournament_event_log.confidence is
  'Source confidence: verified, reported, or unconfirmed.';
comment on column public.tournament_event_log.gate_decision is
  'Materiality gate decision. Only verified result changes are material; lineups/cards/minutes/injuries are context_only.';
comment on column public.tournament_event_log.rerun_triggered is
  'True only when this row directly caused a model rerun under the materiality gate.';
comment on column public.tournament_event_log.triggered_run_id is
  'Candidate prediction, tournament simulation, Elo update, or AI artifact run ID when known.';
comment on column public.tournament_event_log.source_snapshot is
  'Raw/provider payload excerpt, parser version, command metadata, guardrails, and no-odds/no-predictions-endpoint proof.';

alter table if exists public.tournament_event_log enable row level security;

-- Default-deny posture is intentional: no policies are added in this dry-run migration.
