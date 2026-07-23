-- Fix a bug found while testing delete_current_user_data(): public.connections
-- has no updated_at column (confirmed via information_schema before writing
-- this fix), unlike every other table this function touches. The original
-- UPDATE statement referenced it and raised 42703 on every real invocation,
-- rolling the whole function back (PL/pgSQL functions roll back atomically
-- on an unhandled exception) -- so no partial damage occurred, but no
-- deletion could ever succeed either. This only changes that one statement.

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
  --    to any reminder they were a party to.
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
  --    title/body text as a send-time snapshot -- deleted rather than
  --    retained with embedded PII.
  delete from public.caregiver_notification_events
  where caregiver_id = target_user_id or recipient_id = target_user_id;

  -- 5. Caregiver notification preferences are private settings.
  delete from public.notification_preferences where caregiver_id = target_user_id;

  -- 6. Invitations never accepted carry no shared history.
  delete from public.connections
  where caregiver_id = target_user_id
    and status = 'pending'
    and recipient_id is null;

  -- 7. Everything else this account was ever a party to is permanently
  --    ended, not deleted. connections has no updated_at column (fixed
  --    here -- the prior version of this statement incorrectly set one).
  update public.connections
  set status = 'ended'
  where (caregiver_id = target_user_id or recipient_id = target_user_id)
    and status <> 'ended';

  -- 8. Scrub private profile information; keep the row itself (anonymized
  --    tombstone).
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

revoke all on function public.delete_current_user_data(uuid) from public, anon, authenticated;
grant execute on function public.delete_current_user_data(uuid) to service_role;
