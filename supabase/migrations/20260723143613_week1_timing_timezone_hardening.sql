-- Week 1 launch hardening: reminder timing and timezone reliability.
--
-- Two smallest-safe data-integrity constraints, chosen specifically to be
-- compatible with 100% of existing production rows (verified before writing
-- this migration: no_response_minutes currently ranges 1-15 across existing
-- reminders, and every profiles.timezone value is already a valid non-empty
-- string) — neither requires NOT VALID or any data rewrite to deploy.
--
-- The application-level "no_response_minutes must be >= 5 for new/edited
-- reminders" rule is enforced in the client (create-reminder.tsx,
-- edit-reminder.tsx, lib/reminderOptions.ts), not here — a CHECK constraint
-- can't distinguish a legacy grandfathered row from a new one, so the DB's
-- job is only the permanent floor every row must satisfy (never 0,
-- negative, or null-equivalent), which every existing row — including
-- legacy 1-minute reminders — already satisfies.

alter table public.reminders
  add constraint reminders_no_response_minutes_check
  check (no_response_minutes >= 1);

-- Deliberately not a static allowlist of every IANA zone name — Intl's own
-- validation (see lib/timezone.ts) is the source of truth for "is this a
-- real timezone," and stays correct as the tz database evolves. This
-- constraint only guarantees the column can never become empty,
-- whitespace-only, or null (NOT NULL already covers null).
alter table public.profiles
  add constraint profiles_timezone_not_blank_check
  check (btrim(timezone) <> '');
