create table if not exists public.player_status_events (
  id uuid primary key default gen_random_uuid(),
  tournament_code text not null default 'WC_2026',
  team_id uuid not null references public.teams(id) on delete restrict,
  player_id uuid references public.players(id) on delete set null,
  affected_squad_id uuid references public.squads(id) on delete set null,
  replaced_by_player_id uuid references public.players(id) on delete set null,
  fixture_id uuid references public.fixtures(id) on delete set null,
  event_type text not null,
  previous_status text,
  new_status text,
  event_date timestamptz not null default now(),
  effective_from timestamptz,
  effective_to timestamptz,
  source_event_id uuid references public.source_events(id) on delete set null,
  confidence_score numeric(5,4),
  source_status text not null default 'unverified',
  review_status text not null default 'pending',
  notes text,
  created_at timestamptz not null default now()
);

comment on table public.player_status_events
is 'Append-only history of World Cup squad/player status changes, injuries, replacements, late call-ups, and reviewable status updates.';

comment on column public.player_status_events.tournament_code
is 'Tournament identifier for the status event, defaulting to WC_2026.';

comment on column public.player_status_events.event_type
is 'Status event type such as selected, called_up, dropped, injured, doubtful, replaced, removed, returned_fit, suspended, or status_update.';

comment on column public.player_status_events.previous_status
is 'Player status before this event, when known.';

comment on column public.player_status_events.new_status
is 'Player status after this event, when known.';

comment on column public.player_status_events.affected_squad_id
is 'Squad version affected by this status event.';

comment on column public.player_status_events.replaced_by_player_id
is 'Replacement player for replacement events, when applicable.';

comment on column public.player_status_events.fixture_id
is 'Fixture associated with this status event when an injury, suspension, or update is match-specific.';

comment on column public.player_status_events.effective_from
is 'Time from which this status event should be considered active for modeling and squad availability.';

comment on column public.player_status_events.effective_to
is 'Time until which this status event should be considered active; NULL means open-ended or unknown.';

comment on column public.player_status_events.source_event_id
is 'Source event that supports this status change.';

comment on column public.player_status_events.confidence_score
is 'Numeric confidence in this event from 0.0000 to 1.0000.';

comment on column public.player_status_events.source_status
is 'Source trust state: projected, official, trusted_news, unverified, or manual_confirmed.';

comment on column public.player_status_events.review_status
is 'Human review state: pending, reviewed, or rejected.';

create index if not exists player_status_events_team_id_idx
  on public.player_status_events(team_id);

create index if not exists player_status_events_player_id_idx
  on public.player_status_events(player_id);

create index if not exists player_status_events_event_type_idx
  on public.player_status_events(event_type);

create index if not exists player_status_events_event_date_idx
  on public.player_status_events(event_date);

create index if not exists player_status_events_tournament_code_idx
  on public.player_status_events(tournament_code);

create index if not exists player_status_events_affected_squad_id_idx
  on public.player_status_events(affected_squad_id);

create index if not exists player_status_events_fixture_id_idx
  on public.player_status_events(fixture_id);

create index if not exists player_status_events_effective_from_idx
  on public.player_status_events(effective_from);

create index if not exists player_status_events_effective_to_idx
  on public.player_status_events(effective_to);

create index if not exists player_status_events_source_event_id_idx
  on public.player_status_events(source_event_id);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'player_status_events_event_type_check'
  ) then
    alter table public.player_status_events
      add constraint player_status_events_event_type_check
      check (
        event_type in (
          'selected',
          'called_up',
          'dropped',
          'injured',
          'doubtful',
          'replaced',
          'removed',
          'returned_fit',
          'suspended',
          'status_update'
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'player_status_events_status_values_check'
  ) then
    alter table public.player_status_events
      add constraint player_status_events_status_values_check
      check (
        (previous_status is null or previous_status in ('active', 'injured', 'doubtful', 'replaced', 'removed', 'suspended'))
        and
        (new_status is null or new_status in ('active', 'injured', 'doubtful', 'replaced', 'removed', 'suspended'))
      );
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'player_status_events_confidence_score_check'
  ) then
    alter table public.player_status_events
      add constraint player_status_events_confidence_score_check
      check (confidence_score is null or (confidence_score >= 0 and confidence_score <= 1));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'player_status_events_source_status_check'
  ) then
    alter table public.player_status_events
      add constraint player_status_events_source_status_check
      check (source_status in ('projected', 'official', 'trusted_news', 'unverified', 'manual_confirmed'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'player_status_events_review_status_check'
  ) then
    alter table public.player_status_events
      add constraint player_status_events_review_status_check
      check (review_status in ('pending', 'reviewed', 'rejected'));
  end if;
end $$;
