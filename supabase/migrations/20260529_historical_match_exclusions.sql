create table if not exists public.historical_match_exclusions (
  id uuid primary key default gen_random_uuid(),
  historical_match_id uuid not null references public.historical_matches(id),
  source_provider text not null,
  source_match_id text,
  exclusion_scope text not null,
  reason_code text not null,
  reason_note text,
  reviewed_by text,
  review_status text not null default 'pending',
  source_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'historical_match_exclusions_scope_check'
      and conrelid = 'public.historical_match_exclusions'::regclass
  ) then
    alter table public.historical_match_exclusions
      add constraint historical_match_exclusions_scope_check
      check (exclusion_scope in ('training', 'backtesting', 'model_features', 'all_modeling'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'historical_match_exclusions_reason_code_check'
      and conrelid = 'public.historical_match_exclusions'::regclass
  ) then
    alter table public.historical_match_exclusions
      add constraint historical_match_exclusions_reason_code_check
      check (reason_code in (
        'duplicate_source_row',
        'non_standard_team',
        'club_team_in_national_dataset',
        'b_team',
        'regional_team',
        'manual_review_pending'
      ));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'historical_match_exclusions_review_status_check'
      and conrelid = 'public.historical_match_exclusions'::regclass
  ) then
    alter table public.historical_match_exclusions
      add constraint historical_match_exclusions_review_status_check
      check (review_status in ('pending', 'approved', 'rejected'));
  end if;
end
$$;

create unique index if not exists historical_match_exclusions_match_scope_reason_uidx
  on public.historical_match_exclusions (historical_match_id, exclusion_scope, reason_code);

create index if not exists historical_match_exclusions_match_idx
  on public.historical_match_exclusions (historical_match_id);

create index if not exists historical_match_exclusions_review_status_idx
  on public.historical_match_exclusions (review_status);

create index if not exists historical_match_exclusions_reason_code_idx
  on public.historical_match_exclusions (reason_code);

comment on table public.historical_match_exclusions is
  'Non-destructive exclusion layer for historical match data quality controls. Excluded matches remain in raw historical_matches.';

comment on column public.historical_match_exclusions.exclusion_scope is
  'Scope where this exclusion applies. Feature/example builders may skip rows only when review_status = approved and scope applies.';

comment on column public.historical_match_exclusions.reason_code is
  'Structured reason for excluding a historical match from a modeling scope without deleting the raw source row.';

comment on column public.historical_match_exclusions.source_snapshot is
  'Review evidence and source context for the exclusion decision.';
