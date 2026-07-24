-- Tavora Week 2 product-polish task #1: onboarding, role clarity, use-case
-- positioning, and first-success activation.
--
-- 1. profiles.use_case -- a self-reported onboarding signal used only to
--    select onboarding/example copy client-side. Never used for
--    authorization (that stays entirely on the existing caregiver/
--    recipient `role` column). Nullable: an older account or a user who
--    skips the question simply has no value, and app code must treat that
--    as a neutral default rather than requiring a migration backfill.
-- 2. A BEFORE UPDATE trigger on profiles that blocks a role reassignment
--    once the profile has any connection (as either caregiver_id or
--    recipient_id), closing the audit finding that choose-role.tsx's own
--    "you can only choose your role once" copy was not actually enforced
--    anywhere server-side. Idempotent (re-submitting the same role is
--    always a no-op, never blocked) and does not touch the existing
--    profiles RLS policies (auth.uid() = id UPDATE stays exactly as-is --
--    this is a data-integrity trigger, not an authorization change).
-- 3. onboarding_events -- a minimal, privacy-safe, insert-your-own-row-only
--    funnel table for the events listed in the task spec. No reminder
--    titles, emails, names, push tokens, notes, or health details are ever
--    stored -- event_type + user_id + timestamp only.

alter table public.profiles
  add column use_case text
  check (use_case in ('care', 'family', 'coaching', 'team', 'personal', 'other'));

comment on column public.profiles.use_case is
  'Self-reported onboarding use case, chosen once during onboarding and editable later in Settings. Used only to select onboarding/example copy client-side -- never used for authorization or stored as free-form text. NULL means unset (older account, or the user has not been through the new onboarding flow yet); app code must default safely (neutral copy), never auto-write a value server-side.';

-- ─── Role-change guard ────────────────────────────────────────────────────

create or replace function public.guard_profile_role_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  -- Only a genuine reassignment of an already-set role is restricted --
  -- the very first role write (old.role is null) is always allowed, and
  -- re-submitting the same value again (idempotent choose-role retry,
  -- double-tap, etc.) never trips this check since new.role is not
  -- distinct from old.role in that case.
  if new.role is distinct from old.role and old.role is not null then
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
  'Blocks changing an already-set profiles.role once any connection row references this profile (as caregiver_id or recipient_id). First-time role selection (old.role is null) and idempotent re-submission of the same role are always allowed. Raises the fixed message ''role_locked'' so the client can classify it without parsing free text.';

drop trigger if exists guard_profile_role_change_trigger on public.profiles;
create trigger guard_profile_role_change_trigger
before update on public.profiles
for each row
execute function public.guard_profile_role_change();

-- ─── Onboarding funnel events ─────────────────────────────────────────────

create table public.onboarding_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null check (event_type in (
    'onboarding_started',
    'use_case_selected',
    'role_selected',
    'invite_created',
    'invite_accepted',
    'first_reminder_created',
    'first_response_recorded',
    'onboarding_completed'
  )),
  created_at timestamptz not null default now()
);

comment on table public.onboarding_events is
  'Minimal, privacy-safe internal onboarding-funnel tracking. Columns are strictly limited to id/user_id/event_type/created_at -- no reminder titles, emails, names, push tokens, notes, or health details are ever stored here, and none should ever be added. Operational use only (funnel drop-off analysis), not a general analytics platform. Retention: prune rows older than 180 days (see docs/onboarding-model.md for the documented manual/future cleanup procedure -- no cron is created for this in this task).';

create index idx_onboarding_events_user_id on public.onboarding_events (user_id, created_at);

alter table public.onboarding_events enable row level security;

create policy "onboarding_events_insert_own" on public.onboarding_events
  for insert to authenticated
  with check (auth.uid() = user_id);

create policy "onboarding_events_select_own" on public.onboarding_events
  for select to authenticated
  using (auth.uid() = user_id);

revoke all on public.onboarding_events from anon;
