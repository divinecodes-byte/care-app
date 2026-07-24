-- Fix a second bug found while running the onboarding audit: the original
-- 20260726000000_onboarding_use_case_and_role_safety.sql migration created
-- onboarding_events with RLS policies but never GRANTed the underlying
-- table privileges to `authenticated` -- RLS policies only restrict which
-- ROWS a role can see/touch; the role still needs the base table-level
-- GRANT before RLS is even evaluated. Every insert/select from an
-- authenticated client was failing with "permission denied for table
-- onboarding_events" (Postgres error 42501).

grant select, insert on public.onboarding_events to authenticated;
