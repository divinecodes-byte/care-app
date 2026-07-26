-- Flexible-tasks follow-up (found during task-audit planning, Phase 18/19):
-- end_connection() and delete_current_user_data() were written before tasks
-- existed and only ever deactivated `reminders`. Both must also deactivate
-- `tasks` for exactly the same reason they deactivate reminders -- "ending a
-- connection stops future task assignments and notifications but preserves
-- history" and "deleting an account follows Tavora's existing anonymization
-- model" both apply equally to the second accountability object. Historical
-- task_occurrences rows are never touched by either function, mirroring how
-- reminder_logs is never touched.

create or replace function public.end_connection(p_connection_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_conn public.connections%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_conn from public.connections where id = p_connection_id for update;

  if not found then
    raise exception 'connection_not_found';
  end if;

  if v_conn.caregiver_id <> auth.uid() and v_conn.recipient_id <> auth.uid() then
    raise exception 'not_authorized';
  end if;

  if v_conn.status = 'ended' then
    return;
  end if;

  update public.connections set status = 'ended' where id = p_connection_id;

  update public.reminders
  set is_active = false, updated_at = now()
  where connection_id = p_connection_id and is_active = true;

  -- Flexible tasks: same treatment as reminders above. respond_to_task_
  -- occurrence and the assignment-notification send path both already fail
  -- closed on task_inactive/connection_inactive, so no further mutation of
  -- task_occurrences/task_notification_deliveries is needed here.
  update public.tasks
  set is_active = false, updated_at = now()
  where connection_id = p_connection_id and is_active = true;
end;
$$;

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

  -- 1b. Same for flexible tasks.
  update public.tasks
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

  -- 3b. Same for pending/failed task-assignment notifications.
  delete from public.task_notification_deliveries d
  using public.tasks tk
  where d.task_id = tk.id
    and d.status in ('pending', 'failed')
    and (
      d.recipient_id = target_user_id
      or tk.caregiver_id = target_user_id
      or tk.recipient_id = target_user_id
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
  --    ended, not deleted.
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

-- ═══ Rollback ═════════════════════════════════════════════════════════════
-- Re-apply the prior function bodies from
-- supabase/migrations/20260727000000_participant_limit_and_connection_ending.sql
-- (end_connection) and 20260723163121_secure_account_deletion.sql /
-- 20260723174640_fix_delete_current_user_data_connections_updated_at.sql
-- (delete_current_user_data) to remove the tasks-related statements added
-- here. No table/column change is made by this migration.
