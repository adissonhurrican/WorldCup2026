alter table if exists public.team_ratings
  add column if not exists fifa_rank integer,
  add column if not exists fifa_points numeric(10,4),
  add column if not exists confidence_score numeric(5,4),
  add column if not exists review_status text not null default 'pending',
  add column if not exists notes text;

comment on column public.team_ratings.fifa_rank is 'Official FIFA ranking position for the team at rating_date, when available.';
comment on column public.team_ratings.fifa_points is 'Official FIFA ranking points for the team at rating_date, when available.';
comment on column public.team_ratings.confidence_score is 'Numeric confidence in the imported team rating record from 0.0000 to 1.0000.';
comment on column public.team_ratings.review_status is 'Human review state for team rating data: pending, reviewed, or rejected.';
comment on column public.team_ratings.notes is 'Research notes about missing values, source limitations, or manual-review needs.';

alter table if exists public.recent_matches
  add column if not exists opponent_name text,
  add column if not exists opponent_fifa_code text,
  add column if not exists is_friendly boolean,
  add column if not exists source_name text,
  add column if not exists source_url text,
  add column if not exists source_type text,
  add column if not exists published_at timestamptz,
  add column if not exists retrieved_at timestamptz,
  add column if not exists confidence_score numeric(5,4),
  add column if not exists review_status text not null default 'pending',
  add column if not exists notes text;

comment on column public.recent_matches.opponent_name is 'Opponent display name from the reviewed recent-match research intake.';
comment on column public.recent_matches.opponent_fifa_code is 'Opponent FIFA code when safely known from the reviewed research intake.';
comment on column public.recent_matches.is_friendly is 'Whether the match was a friendly rather than a competitive fixture.';
comment on column public.recent_matches.source_name is 'Human-readable source name for the imported recent-match record.';
comment on column public.recent_matches.source_url is 'Source URL for the imported recent-match record.';
comment on column public.recent_matches.source_type is 'Source type for recent-match provenance, such as official, federation, AFC, or trusted sports data.';
comment on column public.recent_matches.published_at is 'Publication timestamp from the source when available.';
comment on column public.recent_matches.retrieved_at is 'Timestamp when the source was retrieved during research.';
comment on column public.recent_matches.confidence_score is 'Numeric confidence in the imported recent-match record from 0.0000 to 1.0000.';
comment on column public.recent_matches.review_status is 'Human review state for recent-match data: pending, reviewed, or rejected.';
comment on column public.recent_matches.notes is 'Research notes about score verification, penalties, source limitations, or venue assumptions.';

create index if not exists team_ratings_tournament_team_rating_date_idx
  on public.team_ratings(tournament_code, team_id, rating_date);

create index if not exists recent_matches_tournament_team_match_date_idx
  on public.recent_matches(tournament_code, team_id, match_date);

create index if not exists recent_matches_team_match_date_opponent_name_idx
  on public.recent_matches(team_id, match_date, opponent_name);

do $$
begin
  if to_regclass('public.team_ratings') is not null
    and not exists (select 1 from pg_constraint where conname = 'team_ratings_confidence_score_check')
    and not exists (
      select 1 from public.team_ratings
      where confidence_score is not null
        and (confidence_score < 0 or confidence_score > 1)
    )
  then
    alter table public.team_ratings
      add constraint team_ratings_confidence_score_check
      check (confidence_score is null or (confidence_score >= 0 and confidence_score <= 1));
  end if;
end $$;

do $$
begin
  if to_regclass('public.recent_matches') is not null
    and not exists (select 1 from pg_constraint where conname = 'recent_matches_confidence_score_check')
    and not exists (
      select 1 from public.recent_matches
      where confidence_score is not null
        and (confidence_score < 0 or confidence_score > 1)
    )
  then
    alter table public.recent_matches
      add constraint recent_matches_confidence_score_check
      check (confidence_score is null or (confidence_score >= 0 and confidence_score <= 1));
  end if;
end $$;

do $$
begin
  if to_regclass('public.team_ratings') is not null
    and not exists (select 1 from pg_constraint where conname = 'team_ratings_review_status_check')
    and not exists (
      select 1 from public.team_ratings
      where review_status not in ('pending', 'reviewed', 'rejected')
    )
  then
    alter table public.team_ratings
      add constraint team_ratings_review_status_check
      check (review_status in ('pending', 'reviewed', 'rejected'));
  end if;
end $$;

do $$
begin
  if to_regclass('public.recent_matches') is not null
    and not exists (select 1 from pg_constraint where conname = 'recent_matches_review_status_check')
    and not exists (
      select 1 from public.recent_matches
      where review_status not in ('pending', 'reviewed', 'rejected')
    )
  then
    alter table public.recent_matches
      add constraint recent_matches_review_status_check
      check (review_status in ('pending', 'reviewed', 'rejected'));
  end if;
end $$;

do $$
begin
  if to_regclass('public.team_ratings') is not null
    and not exists (select 1 from pg_constraint where conname = 'team_ratings_fifa_rank_positive_check')
    and not exists (
      select 1 from public.team_ratings
      where fifa_rank is not null and fifa_rank <= 0
    )
  then
    alter table public.team_ratings
      add constraint team_ratings_fifa_rank_positive_check
      check (fifa_rank is null or fifa_rank > 0);
  end if;
end $$;

do $$
begin
  if to_regclass('public.recent_matches') is not null
    and not exists (
      select 1
      from public.recent_matches
      where opponent_name is not null
      group by team_id, match_date, opponent_name
      having count(*) > 1
    )
  then
    create unique index if not exists recent_matches_team_match_date_opponent_name_unique_idx
      on public.recent_matches(team_id, match_date, opponent_name)
      where opponent_name is not null;
  end if;
end $$;
