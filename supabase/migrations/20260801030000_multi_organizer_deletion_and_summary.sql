-- Week 4 Task #2: multiple-organizer participant support closure.
--
-- 1. delete_current_user_data() never touched routine_templates /
--    routine_instances / routine_instance_items / routine_notification_deliveries
--    at all -- confirmed by reading the live function this session. It
--    correctly deactivated routine-created reminders/tasks (they share the
--    same reminders/tasks tables, already covered by the existing steps),
--    but a deleted organizer's private routine_templates were never
--    cleaned up, a deleted organizer's/participant's routine_instances
--    never had their status flipped to 'archived', and pending/failed
--    routine_notification_deliveries were never cleaned up. This function
--    clearly pre-dates the routine-templates feature (Week 3 Task #3) and
--    was never updated for it.
--
--    Policy (matches the existing, already-documented template-privacy
--    model -- confirmed via direct schema introspection this session):
--      - routine_templates are hard-deleted when their owner's account is
--        deleted -- they are private, never shared, and carry no
--        participant-facing history (the existing delete_routine_template()
--        RPC already does a plain owner-authorized hard delete for the
--        same reason). routine_template_items cascade automatically via
--        their existing ON DELETE CASCADE FK.
--      - routine_instances are ARCHIVED, never deleted -- they are shared,
--        participant-facing history. Their own title/source_version/
--        participant_timezone_snapshot columns are independent snapshots
--        of the template at apply-time, so archiving (not deleting) them
--        preserves that history regardless of what happens to the source
--        template. routine_instances.source_template_id already has
--        ON DELETE SET NULL, so hard-deleting the template above safely
--        nulls that reference on any instance without touching the
--        instance's own snapshot columns.
--      - routine_notification_deliveries pending/failed rows are cleaned
--        up the same way the existing reminder/task delivery steps
--        already do, scoped through routine_instances the same way those
--        are scoped through reminders/tasks.
--
-- 2. connections has no index on (recipient_id, status) -- every other
--    participant-scoped table (reminders, tasks, task_occurrences,
--    reminder_logs) already has one; add the equivalent now that a
--    dedicated multi-connection screen queries this shape routinely.
--
-- 3. get_my_organizer_connections_summary() -- one grouped, participant-
--    authorized query for app/my-connections.tsx, instead of three
--    separate client-side batched queries. auth.uid() is resolved
--    server-side (never a parameter), so there is no participant-id route
--    parameter to tamper with. Grant pattern copied exactly from the
--    already-existing get_participant_activity_feed().

create or replace function public.delete_current_user_data(target_user_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_catalog'
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

  -- 1c. Routine instances: archived (not deleted) -- shared,
  --     participant-facing history. Member reminders/tasks are already
  --     covered by steps 1/1b above (they share those same tables).
  update public.routine_instances
  set status = 'archived', archived_at = now(), updated_at = now()
  where (organizer_id = target_user_id or participant_id = target_user_id)
    and status = 'active';

  -- 1d. This organizer's own private routine templates -- never shared,
  --     no participant-facing history, matches delete_routine_template()'s
  --     existing hard-delete policy. Cascades to routine_template_items
  --     via existing FK. Never touches another organizer's templates
  --     (scoped strictly to owner_id = target_user_id).
  delete from public.routine_templates where owner_id = target_user_id;

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

  -- 3c. Same for pending/failed routine-assignment notifications, scoped
  --     through routine_instances the same way 3/3b are scoped through
  --     reminders/tasks.
  delete from public.routine_notification_deliveries d
  using public.routine_instances ri
  where d.routine_instance_id = ri.id
    and d.status in ('pending', 'failed')
    and (
      d.recipient_id = target_user_id
      or ri.organizer_id = target_user_id
      or ri.participant_id = target_user_id
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

-- Verified before writing this migration: only service_role (+ owner
-- postgres) had EXECUTE; no anon/authenticated grant existed. Restoring
-- the exact same grantee set, not a broadened one.
revoke all on function public.delete_current_user_data(uuid) from public, anon, authenticated;
grant execute on function public.delete_current_user_data(uuid) to service_role;

create index idx_connections_recipient_status on public.connections(recipient_id, status);

create or replace function public.get_my_organizer_connections_summary()
returns table(
    connection_id uuid,
    status text,
    accepted_at timestamptz,
    organizer_id uuid,
    organizer_full_name text,
    organizer_account_status text,
    organizer_deleted_at timestamptz,
    active_reminder_count bigint,
    active_task_count bigint,
    active_routine_count bigint
)
language sql
stable
security definer
set search_path to 'public', 'extensions', 'pg_catalog'
as $$
    select
        c.id,
        c.status,
        c.accepted_at,
        p.id,
        p.full_name,
        p.account_status,
        p.deleted_at,
        coalesce(r.cnt, 0),
        coalesce(t.cnt, 0),
        coalesce(ri.cnt, 0)
    from public.connections c
    join public.profiles p on p.id = c.caregiver_id
    left join lateral (
        select count(*) as cnt from public.reminders where connection_id = c.id and is_active
    ) r on true
    left join lateral (
        select count(*) as cnt from public.tasks where connection_id = c.id and is_active
    ) t on true
    left join lateral (
        select count(*) as cnt from public.routine_instances where connection_id = c.id and status = 'active'
    ) ri on true
    where c.recipient_id = auth.uid()
    order by (c.status = 'accepted') desc, c.accepted_at desc nulls last, c.created_at desc;
$$;

revoke all on function public.get_my_organizer_connections_summary() from public, anon;
grant execute on function public.get_my_organizer_connections_summary() to authenticated;
