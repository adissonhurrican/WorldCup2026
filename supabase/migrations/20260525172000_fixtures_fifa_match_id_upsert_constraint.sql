create unique index if not exists fixtures_fifa_match_id_upsert_unique_idx
  on public.fixtures(fifa_match_id);

comment on index public.fixtures_fifa_match_id_upsert_unique_idx
is 'Supports idempotent Group B fixture imports with PostgREST on_conflict=fifa_match_id; nullable fifa_match_id values remain allowed.';
