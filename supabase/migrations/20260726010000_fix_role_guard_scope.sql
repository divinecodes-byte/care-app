-- Fix a regression found while running the onboarding audit: the role-lock
-- trigger added in 20260726000000_onboarding_use_case_and_role_safety.sql
-- fired for EVERY update to profiles.role, including raw SQL run through
-- the privileged `supabase db query --linked` CLI connection (which
-- connects directly as a superuser, not through PostgREST/auth) -- exactly
-- the mechanism every existing test suite's fixture setup already relies
-- on to freely arrange synthetic profiles/connections (see e.g.
-- scripts/auth-audit/run.ts's O/P scenario, which deliberately assigns a
-- role AFTER creating a raw test connection, for test-data-shortcut
-- reasons unrelated to what it's actually testing). That broke
-- auth-audit's existing setup with a hard SQL error.
--
-- The actual security property this trigger exists for is narrower:
-- an ORDINARY, ALREADY-CONNECTED USER must not be able to forge a role
-- change through the app's own client. auth.uid() is only non-null for a
-- request carrying a real Supabase Auth JWT (i.e. a genuine authenticated
-- client call, exactly what choose-role.tsx makes) -- it is null for any
-- direct database connection with no JWT claims set, which covers every
-- CLI/ops/test-fixture path. Scoping the guard to auth.uid() is not null
-- preserves the real protection while no longer touching privileged
-- connections at all.

create or replace function public.guard_profile_role_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if auth.uid() is not null
     and new.role is distinct from old.role
     and old.role is not null then
    if exists (
      select 1 from public.connections
      where caregiver_id = old.id or recipient_id = old.id
    ) then
      raise exception 'role_locked' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

comment on function public.guard_profile_role_change() is
  'Blocks changing an already-set profiles.role once any connection row references this profile (as caregiver_id or recipient_id) -- but only for a genuine authenticated client request (auth.uid() is not null). Privileged connections (migrations, ops scripts, the supabase CLI, service-role Edge Functions) are never subject to this check. First-time role selection (old.role is null) and idempotent re-submission of the same role are always allowed regardless. Raises the fixed message ''role_locked'' so the client can classify it without parsing free text.';
