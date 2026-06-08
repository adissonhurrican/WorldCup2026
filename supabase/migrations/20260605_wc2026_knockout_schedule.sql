-- WC2026 knockout schedule (matches 73-104): R32, R16, QF, SF, third-place, Final.
-- A clean, queryable source grounded in docs/wc2026-tournament-rules.md (Sections 4 + 6):
--   match number, round, the two FIFA slot labels (+ structured slot_a/slot_b jsonb for tree traversal),
--   venue/city/country/venue_timezone (dual-clock shape, same as group fixtures), and kickoff_utc/match_date.
-- Loaded/maintained by scripts/worldcup/load-knockout-schedule.ts (idempotent upsert on match_number).
-- Dates/kickoffs are flagged date_confirmed=false until an official knockout date source is ingested (not fabricated).
-- Queryable by match_number (PK) and by slot (slot_a/slot_b jsonb: type/group/pool/match).
create table if not exists public.knockout_schedule (
  match_number integer primary key,
  tournament_code text not null default 'WC_2026',
  round text not null,                 -- round_of_32 | round_of_16 | quarter_final | semi_final | third_place | final
  slot_a_label text not null,          -- e.g. 'Winner Group B', 'Best 3rd from E/F/G/I/J', 'Winner M85', 'Runner-up M101'
  slot_b_label text not null,
  slot_a jsonb not null,               -- {type:group_winner|group_runner_up|best_third|match_winner|match_loser, group|pool|match, label}
  slot_b jsonb not null,
  venue text,
  city text,
  country text,
  venue_timezone text,                 -- IANA tz for the venue-local clock (dual-clock compatible with group fixtures)
  round_window text,                   -- round date window (e.g. '2026-06-28 to 2026-07-03') when the exact day is not pinned
  match_date date,
  kickoff_utc timestamptz,             -- absolute kickoff moment (null until an official date source lands)
  date_confirmed boolean not null default false,
  venue_confirmed boolean not null default false,
  source text not null,
  source_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
