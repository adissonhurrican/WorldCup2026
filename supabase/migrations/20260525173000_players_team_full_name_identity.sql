create unique index if not exists players_team_full_name_unique_idx
  on public.players(team_id, full_name);

comment on index public.players_team_full_name_unique_idx
is 'Prevents duplicate player identity rows per national team for projected and imported squad data.';
