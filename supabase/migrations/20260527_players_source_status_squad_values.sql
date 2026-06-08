do $$
begin
  if to_regclass('public.players') is not null then
    if exists (
      select 1
      from pg_constraint
      where conname = 'players_source_status_check'
        and conrelid = 'public.players'::regclass
    ) then
      alter table public.players
        drop constraint players_source_status_check;
    end if;

    if not exists (
      select 1
      from public.players
      where source_status not in (
        'projected',
        'official',
        'trusted_news',
        'unverified',
        'manual_confirmed',
        'api_discovered_provisional',
        'official_final_squad',
        'manual_reviewed_squad'
      )
    ) then
      alter table public.players
        add constraint players_source_status_check
        check (source_status in (
          'projected',
          'official',
          'trusted_news',
          'unverified',
          'manual_confirmed',
          'api_discovered_provisional',
          'official_final_squad',
          'manual_reviewed_squad'
        ));
    else
      raise notice 'players_source_status_check not recreated because public.players contains unsupported source_status values';
    end if;
  end if;
end $$;

comment on column public.players.source_status is
'Source trust state for player data. Existing values remain valid. api_discovered_provisional = discovered from provider squad endpoint, not official final roster. official_final_squad = verified against official federation/FIFA final squad source. manual_reviewed_squad = reviewed internally but not necessarily final. projected = model/manual placeholder, lower trust.';
