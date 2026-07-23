-- Week 1 launch hardening: secure in-app account deletion.

-- ─── 1. Allow profiles to outlive auth.users (anonymized tombstone) ─────────
--
-- Every table in this schema cascades profiles -> auth.users, and reminders/
-- reminder_logs/etc cascade from profiles via BOTH caregiver_id and
-- recipient_id. Deleting auth.users the normal way would cascade-delete
-- profiles, which would cascade-delete every shared reminder/reminder_log a
-- surviving counterpart still depends on -- destroying their data even
-- though their own account is untouched. Dropping this one FK lets a
-- profiles row survive (scrubbed) after its auth.users row is removed, so
-- shared history stays valid and readable for the surviving party instead
-- of vanishing. New profile rows are unaffected: they're only ever created
-- through the signup flow, which is already enforced by RLS
-- (auth.uid() = id on insert), not by this FK.
alter table public.profiles drop constraint profiles_id_fkey;

-- ─── 2. Tombstone fields ─────────────────────────────────────────────────────
alter table public.profiles
  add column deleted_at timestamptz,
  add column account_status text not null default 'active';

alter table public.profiles
  add constraint profiles_account_status_check
  check (account_status in ('active', 'deleted'));

comment on column public.profiles.deleted_at is
  'Set once by delete_current_user_data() when this account is permanently deleted. The auth.users row backing this profile no longer exists once this is set -- the row survives only as an anonymized tombstone for shared reminder/reminder_log history a surviving counterpart still owns.';
comment on column public.profiles.account_status is
  'active | deleted. deleted means the auth identity has been removed and this row is a scrubbed tombstone -- see deleted_at.';

-- ─── 3. connections.status gains a terminal value ───────────────────────────
-- 'ended' is used instead of deleting the connections row on account
-- deletion, specifically to avoid connections' own CASCADE deleting
-- reminders/reminder_logs the surviving party still needs. A
-- connections_status_check already existed (pending, accepted only) --
-- replaced with a version that also allows 'ended'. Verified before writing
-- this migration that no other status value is currently in use.
alter table public.connections drop constraint connections_status_check;
alter table public.connections
  add constraint connections_status_check
  check (status in ('pending', 'accepted', 'ended'));

-- ─── 4. delete_current_user_data(): the one deletion procedure ─────────────
--
-- Called only by the delete-account Edge Function (service role). Never
-- callable by anon/authenticated -- see the REVOKE/GRANT below. Idempotent:
-- every statement is a no-op the second time it runs against an
-- already-scrubbed account, which is what makes retry-after-partial-failure
-- safe (see the Edge Function).
create or replace function public.delete_current_user_data(target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
begin
  if target_user_id is null then
    raise exception 'target_user_id is required';
  end if;

  -- 1. Stop every reminder this account is involved in, either side.
  update public.reminders
  set is_active = false, updated_at = now()
  where (caregiver_id = target_user_id or recipient_id = target_user_id)
    and is_active = true;

  -- 2. No future push has anything to send to. Delete outright -- a device
  --    token has no historical value once the account is gone.
  delete from public.push_tokens where user_id = target_user_id;

  -- 3. Pending/retryable delivery rows tied either to this user directly or
  --    to any reminder they were a party to (covers both "I am the
  --    recipient a push was queued for" and "I am the caregiver whose
  --    reminder a push was queued for, for a still-active recipient").
  --    Never leaves a row that could still be claimed/retried.
  delete from public.reminder_notification_deliveries d
  using public.reminders r
  where d.reminder_id = r.id
    and d.status in ('pending', 'failed')
    and (
      d.recipient_id = target_user_id
      or r.caregiver_id = target_user_id
      or r.recipient_id = target_user_id
    );

  -- 4. Caregiver notification events embed the recipient's name in their
  --    title/body text as a snapshot at send-time (see
  --    create_caregiver_notification_event()) -- that can't be safely
  --    scrubbed with a text-parsing rule, so per the documented retention
  --    policy these are deleted rather than retained with embedded PII.
  delete from public.caregiver_notification_events
  where caregiver_id = target_user_id or recipient_id = target_user_id;

  -- 5. Caregiver notification preferences are private settings, not shared
  --    history -- delete outright.
  delete from public.notification_preferences where caregiver_id = target_user_id;

  -- 6. Invitations never accepted carry no shared history -- delete them.
  delete from public.connections
  where caregiver_id = target_user_id
    and status = 'pending'
    and recipient_id is null;

  -- 7. Everything else this account was ever a party to (accepted, or still
  --    pending against a real counterpart) is permanently ended, not
  --    deleted -- deleting the row would cascade away the surviving
  --    party's reminders/reminder_logs via connections' own FK.
  update public.connections
  set status = 'ended', updated_at = now()
  where (caregiver_id = target_user_id or recipient_id = target_user_id)
    and status <> 'ended';

  -- 8. Scrub private profile information; keep the row itself (anonymized
  --    tombstone) so reminders/reminder_logs a surviving counterpart still
  --    owns remain valid rows instead of orphaning or cascading away.
  --    reminder_logs/reminders themselves carry no name/email/push-token --
  --    only UUIDs, timestamps, and reminder-task content (title/notes,
  --    which describe the care task itself, not this person) -- so once
  --    this row no longer has a name, nothing personally identifying about
  --    the deleted user remains anywhere reachable from shared history.
  update public.profiles
  set full_name = null,
      timezone = 'America/New_York',
      server_push_enabled = false,
      account_status = 'deleted',
      deleted_at = coalesce(deleted_at, now()),
      updated_at = now()
  where id = target_user_id;
end;
$$;

comment on function public.delete_current_user_data(uuid) is
  'Deletes/anonymizes every row owned by target_user_id ahead of removing their Supabase Auth identity. Called exclusively by the delete-account Edge Function with the JWT-derived caller id -- never a client-supplied value. Idempotent.';

-- Only the service role (used exclusively inside the delete-account Edge
-- Function) may call this -- an authenticated user must never be able to
-- invoke deletion of an arbitrary target_user_id directly via RPC.
revoke all on function public.delete_current_user_data(uuid) from public, anon, authenticated;
grant execute on function public.delete_current_user_data(uuid) to service_role;

-- ─── 5. Pre-existing gap found during this task's security audit ───────────
--
-- Every SECURITY DEFINER function from the prior server-push migration was
-- left at Postgres's default EXECUTE-granted-to-PUBLIC, meaning any
-- anon/authenticated API caller could invoke
-- claim_due_recipient_reminder_deliveries()/
-- claim_due_recipient_snooze_deliveries() directly via RPC and read back
-- other recipients' pending delivery rows (reminder_id, recipient_id,
-- occurrence_date, scheduled_for), or trigger the cron wrapper functions on
-- demand. All pg_cron jobs in this project run as `postgres` (confirmed via
-- cron.job.username before writing this), which is unaffected by these
-- REVOKEs, so this does not change cron behavior. None of these are meant
-- to be called by anything except pg_cron/service-role -- locking them down
-- here since discovering and leaving a live data-exposure gap during a
-- security-focused task would be negligent.
revoke all on function public.claim_due_recipient_reminder_deliveries() from public, anon, authenticated;
revoke all on function public.claim_due_recipient_snooze_deliveries() from public, anon, authenticated;
revoke all on function public.sync_missed_reminders_db() from public, anon, authenticated;
revoke all on function public.send_pending_caregiver_push_notifications() from public, anon, authenticated;
revoke all on function public.trigger_send_due_recipient_reminders() from public, anon, authenticated;
revoke all on function public.trigger_check_push_receipts() from public, anon, authenticated;

grant execute on function public.claim_due_recipient_reminder_deliveries() to service_role;
grant execute on function public.claim_due_recipient_snooze_deliveries() to service_role;
grant execute on function public.sync_missed_reminders_db() to service_role;
grant execute on function public.send_pending_caregiver_push_notifications() to service_role;
grant execute on function public.trigger_send_due_recipient_reminders() to service_role;
grant execute on function public.trigger_check_push_receipts() to service_role;
