-- Week 1 launch hardening task #5: privacy-safe notification previews.
--
-- Audit finding: notification_preferences is caregiver-only (keyed by
-- caregiver_id, gates which caregiver push *event types* fire) and has no
-- row at all for recipients, so it cannot hold a preference every account
-- needs. profiles already holds per-account settings (timezone,
-- server_push_enabled) with RLS scoped to `auth.uid() = id` for both SELECT
-- and UPDATE — the smallest-safe, already-audited home for this preference.
--
-- Default is 'private' for every existing and new row, per product rule:
-- deploying this migration changes no visible behavior until a user
-- explicitly switches to detailed in Settings.

alter table public.profiles
  add column notification_preview_mode text not null default 'private';

alter table public.profiles
  add constraint profiles_notification_preview_mode_check
  check (notification_preview_mode in ('private', 'detailed'));

comment on column public.profiles.notification_preview_mode is
  'Controls how much content Tavora puts in a push notification''s visible title/body. private (default): generic "Tavora reminder"/"Tavora update" text only, no reminder titles or participant names. detailed: may include the reminder title and, for caregiver updates, the connected participant''s display name. Never includes notes, email, or push tokens in either mode. profiles RLS (auth.uid() = id for SELECT/UPDATE) already means a client can only ever read or change their own value.';

-- Account deletion tombstone: reset to the safe default alongside the other
-- fields already cleared here. Every other line in this function is
-- unchanged from the live definition (verified directly against the linked
-- project before writing this migration) — only the new column is added to
-- step 8's SET clause. server_push_enabled is already forced false by this
-- same statement, so a tombstoned profile can never receive a push either
-- way — this is tombstone hygiene, not a functional requirement.
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
      notification_preview_mode = 'private',
      account_status = 'deleted',
      deleted_at = coalesce(deleted_at, now()),
      updated_at = now()
  where id = target_user_id;
end;
$$;

revoke all on function public.delete_current_user_data(uuid) from public, anon, authenticated;
grant execute on function public.delete_current_user_data(uuid) to service_role;

-- Caregiver push sender: read the caregiver's CURRENT preview mode at SEND
-- time, not at event-creation time — a mode change between an event being
-- queued (create_caregiver_notification_event trigger, unchanged by this
-- migration) and actually sent (this function, polled every minute) must
-- always take effect on the copy that's about to go out. The trigger
-- already computes a detailed title/body (participant name + reminder
-- title + status wording) into caregiver_notification_events — that's
-- reused as-is for detailed mode; private mode substitutes a fixed generic
-- pair instead. A caregiver with no readable profile row (should not
-- happen in practice) fails toward private, never toward detailed.
create or replace function public.send_pending_caregiver_push_notifications()
returns integer
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  event_record record;
  request_id bigint;
  sent_count integer := 0;
  push_title text;
  push_body text;
begin
  for event_record in
    select
      e.id as event_id,
      e.title,
      e.body,
      e.event_type,
      e.reminder_id,
      e.reminder_log_id,
      pt.expo_push_token,
      coalesce(p.notification_preview_mode, 'private') as preview_mode
    from public.caregiver_notification_events e
    join public.push_tokens pt
      on pt.user_id = e.caregiver_id
    left join public.profiles p
      on p.id = e.caregiver_id
    where e.status = 'pending'
      and pt.is_active = true
      and pt.expo_push_token is not null
    order by e.created_at asc
    limit 25
  loop
    if event_record.preview_mode = 'detailed' then
      push_title := coalesce(event_record.title, 'Tavora update');
      push_body := coalesce(event_record.body, 'There is a new reminder update.');
    else
      push_title := 'Tavora update';
      push_body := 'There is a new reminder update.';
    end if;

    select net.http_post(
      url := 'https://exp.host/--/api/v2/push/send',
      headers := jsonb_build_object(
        'Content-Type', 'application/json'
      ),
      body := (
        jsonb_build_object(
          'to', event_record.expo_push_token,
          'title', push_title,
          'body', push_body,
          'sound', 'default',
          'priority', 'high',
          'data', jsonb_build_object(
            'type', 'caregiver_reminder_event',
            'eventType', event_record.event_type,
            'reminderId', event_record.reminder_id,
            'reminderLogId', event_record.reminder_log_id
          )
        )
        ||
        case
          when event_record.event_type = 'missed'
          then jsonb_build_object('interruptionLevel', 'time-sensitive')
          else '{}'::jsonb
        end
      )
    )
    into request_id;

    update public.caregiver_notification_events
    set
      status = 'sent',
      sent_at = now(),
      updated_at = now(),
      error_message = null
    where id = event_record.event_id;

    sent_count := sent_count + 1;
  end loop;

  return sent_count;
end;
$$;
