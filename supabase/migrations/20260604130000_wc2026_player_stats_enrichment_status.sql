alter table if exists public.wc2026_fixture_enrichment_status
  add column if not exists player_stats_status text not null default 'not_attempted';

alter table if exists public.wc2026_fixture_enrichment_status
  add column if not exists player_stats_count integer not null default 0;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'wc2026_fixture_enrichment_player_stats_status_check'
      and conrelid = 'public.wc2026_fixture_enrichment_status'::regclass
  ) then
    alter table public.wc2026_fixture_enrichment_status
      add constraint wc2026_fixture_enrichment_player_stats_status_check
      check (player_stats_status in ('not_attempted', 'present', 'missing', 'partial', 'error'));
  end if;
end $$;

comment on column public.wc2026_fixture_enrichment_status.player_stats_status is
  'Coverage status for API-Football /fixtures/players enrichment. Context-only; never a model rerun trigger.';

comment on column public.wc2026_fixture_enrichment_status.player_stats_count is
  'Count of parsed per-player stat rows from API-Football /fixtures/players for this fixture. Zero means missing/not available/error depending on player_stats_status.';

comment on table public.wc2026_fixture_enrichment_status is
  'Best-effort enrichment status for API-Football events/lineups/statistics/player stats. Missing enrichment never blocks core result ingestion; non-result enrichment is context-only and never triggers model reruns.';

comment on table public.api_football_fixture_player_stats is
  'Post-match API-Football fixture player statistics for evidence and AI narration context only. No odds or API-Football prediction endpoint data. WC2026 post-match observed rows are never pre-match prediction inputs and must not be routed into player-impact, team-strength, or probability generation.';
