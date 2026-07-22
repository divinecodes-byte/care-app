-- Fix a pre-existing gap discovered while testing send-due-recipient-reminders:
-- service_role had REFERENCES/TRIGGER/TRUNCATE on every public table (from
-- some schema-wide default) but was missing SELECT/INSERT/UPDATE/DELETE —
-- the standard baseline every Supabase project's service_role should have.
-- This affected every table, not just the new one; it was never noticed
-- because nothing before this migration queried tables directly as
-- service_role via PostgREST — the caregiver push pipeline only ever used
-- SECURITY DEFINER SQL functions, which run as the function owner and are
-- unaffected by this gap regardless.
--
-- service_role already bypasses RLS by Postgres/PostgREST design (it's the
-- dedicated elevated role for that purpose) — granting it normal table
-- privileges does not touch or weaken any RLS policy for anon/authenticated.

grant select, insert, update, delete on all tables in schema public to service_role;
grant usage on all sequences in schema public to service_role;

-- So any future table created by this role also gets the same baseline
-- automatically, instead of silently repeating this gap.
alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public
  grant usage on sequences to service_role;
