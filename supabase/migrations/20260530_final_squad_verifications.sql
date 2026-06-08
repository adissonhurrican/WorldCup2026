create table if not exists public.final_squad_verifications (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete restrict,
  tournament_code text not null default 'WC_2026',
  squad_source text not null,
  fifa_source_url text,
  federation_source_url text,
  official_squad_count integer not null,
  matched_player_count integer not null,
  missing_player_count integer not null,
  ambiguous_player_count integer not null,
  verification_status text not null default 'pending',
  verified_at timestamptz,
  source_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'final_squad_verifications_status_check'
      and conrelid = 'public.final_squad_verifications'::regclass
  ) then
    alter table public.final_squad_verifications
      add constraint final_squad_verifications_status_check
      check (verification_status in ('pending', 'verified', 'needs_review', 'rejected'));
  end if;
end $$;

create index if not exists final_squad_verifications_team_id_idx
  on public.final_squad_verifications(team_id);

create index if not exists final_squad_verifications_tournament_code_idx
  on public.final_squad_verifications(tournament_code);

create index if not exists final_squad_verifications_verification_status_idx
  on public.final_squad_verifications(verification_status);

create unique index if not exists final_squad_verifications_team_tournament_unique_idx
  on public.final_squad_verifications(team_id, tournament_code);

comment on table public.final_squad_verifications is
  'Official final squad verification records. This table stores source-backed verification summaries without deleting provisional player history.';

comment on column public.final_squad_verifications.squad_source is
  'Primary official source used for this verification: fifa_global, federation, or fifa_global_then_federation.';

comment on column public.final_squad_verifications.source_snapshot is
  'Official source metadata, parsed official player names, matching summary, guardrails, and workflow version.';
