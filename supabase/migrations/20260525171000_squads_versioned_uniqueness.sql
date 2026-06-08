do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'squads_team_tournament_unique'
      and conrelid = 'public.squads'::regclass
  ) then
    alter table public.squads
      drop constraint squads_team_tournament_unique;
  end if;
end $$;

create unique index if not exists squads_team_tournament_type_version_unique_idx
  on public.squads(team_id, tournament_code, squad_type, version_number);

comment on index public.squads_team_tournament_type_version_unique_idx
is 'Ensures squad versions are unique per team, tournament, squad type, and version number while preserving squad history.';
