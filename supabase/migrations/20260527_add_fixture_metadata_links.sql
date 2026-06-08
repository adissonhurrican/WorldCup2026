alter table if exists public.match_predictions
  add column if not exists fixture_metadata_id uuid;

alter table if exists public.match_results
  add column if not exists fixture_metadata_id uuid;

comment on column public.match_predictions.fixture_id is
  'Existing internal fixture UUID linked to public.fixtures(id). Do not store API-Football numeric fixture IDs here.';
comment on column public.match_predictions.fixture_metadata_id is
  'Provider-backed fixture metadata UUID linked to public.fixture_metadata(id). API-Football numeric IDs remain in fixture_metadata.external_fixture_id.';
comment on column public.match_results.fixture_id is
  'Existing internal fixture UUID linked to public.fixtures(id). Do not store API-Football numeric fixture IDs here.';
comment on column public.match_results.fixture_metadata_id is
  'Provider-backed fixture metadata UUID linked to public.fixture_metadata(id). API-Football numeric IDs remain in fixture_metadata.external_fixture_id.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'match_predictions_fixture_metadata_id_fkey'
      and conrelid = 'public.match_predictions'::regclass
  ) then
    alter table public.match_predictions
      add constraint match_predictions_fixture_metadata_id_fkey
      foreign key (fixture_metadata_id) references public.fixture_metadata(id) on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'match_results_fixture_metadata_id_fkey'
      and conrelid = 'public.match_results'::regclass
  ) then
    alter table public.match_results
      add constraint match_results_fixture_metadata_id_fkey
      foreign key (fixture_metadata_id) references public.fixture_metadata(id) on delete restrict;
  end if;
end $$;

create index if not exists match_predictions_fixture_metadata_id_idx
  on public.match_predictions(fixture_metadata_id);

create index if not exists match_results_fixture_metadata_id_idx
  on public.match_results(fixture_metadata_id);
