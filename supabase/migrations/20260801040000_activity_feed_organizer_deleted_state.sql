-- Week 4 Task #2 (light consistency pass): get_connection_activity_feed()
-- and get_participant_activity_feed() only ever returned cg.full_name as
-- organizer_name -- exactly the null-vs-undefined conflation
-- lib/organizerDisplay.ts's resolveOrganizerDisplay() was written to
-- eliminate. A legitimately active organizer who has simply never set a
-- full_name produces the exact same NULL as a deleted organizer (whose
-- full_name delete_current_user_data() explicitly nulls) -- app/activity.tsx
-- was collapsing both into "A former organizer", mislabeling a real, active,
-- simply-unnamed organizer as gone.
--
-- Fix: return organizer_account_status/organizer_deleted_at alongside
-- organizer_name from both functions, so the client can resolve the same
-- three-way distinction ('named' / 'unavailable' / 'deleted') it already
-- uses for reminders (app/recipient-dashboard.tsx) and tasks
-- (app/task-details.tsx). Adding OUT columns changes the functions' return
-- type, so CREATE OR REPLACE is not permitted here -- both must be dropped
-- and recreated. Bodies are otherwise byte-identical to
-- 20260729000000_activity_feed.sql; only the returns table and the final
-- select list changed. Grants restored to the exact verified pre-migration
-- set (authenticated + postgres only, confirmed via
-- has_function_privilege() against the live database before writing this
-- migration) -- not broadened.

drop function if exists public.get_connection_activity_feed(uuid, timestamptz, text, uuid, int, text);
drop function if exists public.get_participant_activity_feed(timestamptz, text, uuid, int, text);

create function public.get_connection_activity_feed(
  p_connection_id uuid,
  p_before_timestamp timestamptz default null,
  p_before_source text default null,
  p_before_id uuid default null,
  p_limit int default 20,
  p_source_filter text default 'all'
)
returns table (
  source_kind text,
  source_id uuid,
  occurrence_id uuid,
  occurrence_date date,
  event_timestamp timestamptz,
  outcome text,
  title text,
  organizer_name text,
  organizer_account_status text,
  organizer_deleted_at timestamptz,
  participant_name text
)
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
stable
as $$
declare
  v_uid uuid := auth.uid();
  v_conn public.connections%rowtype;
  v_limit int := least(greatest(coalesce(p_limit, 20), 1), 50);
begin
  if v_uid is null then
    raise exception 'authentication_required';
  end if;

  if p_source_filter not in ('all', 'reminder', 'task') then
    raise exception 'invalid_source_filter';
  end if;

  select * into v_conn from public.connections where id = p_connection_id;
  if not found or (v_conn.caregiver_id <> v_uid and v_conn.recipient_id <> v_uid) then
    raise exception 'not_authorized';
  end if;

  return query
  with reminder_events as (
    select
      'reminder'::text as ev_source_kind,
      rl.reminder_id as ev_source_id,
      rl.id as ev_occurrence_id,
      rl.occurrence_date as ev_occurrence_date,
      rl.updated_at as ev_event_timestamp,
      rl.status as ev_outcome,
      r.title as ev_title
    from public.reminder_logs rl
    join public.reminders r on r.id = rl.reminder_id
    where rl.connection_id = p_connection_id
      and rl.status in ('taken', 'skipped', 'missed')
      and p_source_filter in ('all', 'reminder')
  ),
  task_events as (
    select
      'task'::text,
      o.task_id,
      o.id,
      o.occurrence_date,
      o.updated_at,
      o.status,
      t.title
    from public.task_occurrences o
    join public.tasks t on t.id = o.task_id
    where o.connection_id = p_connection_id
      and p_source_filter in ('all', 'task')
  ),
  combined as (
    select * from reminder_events
    union all
    select * from task_events
  )
  select
    c.ev_source_kind, c.ev_source_id, c.ev_occurrence_id, c.ev_occurrence_date,
    c.ev_event_timestamp, c.ev_outcome, c.ev_title,
    cg.full_name, cg.account_status, cg.deleted_at, rc.full_name
  from combined c
  left join public.profiles cg on cg.id = v_conn.caregiver_id
  left join public.profiles rc on rc.id = v_conn.recipient_id
  where p_before_timestamp is null
     or (c.ev_event_timestamp, c.ev_source_kind, c.ev_source_id) < (p_before_timestamp, coalesce(p_before_source, ''), coalesce(p_before_id, '00000000-0000-0000-0000-000000000000'::uuid))
  order by c.ev_event_timestamp desc, c.ev_source_kind desc, c.ev_source_id desc
  limit v_limit;
end;
$$;

comment on function public.get_connection_activity_feed(uuid, timestamptz, text, uuid, int, text) is
  'Read-only, cursor-paginated, cross-object (reminder + task) activity for one connection. Caller must be the caregiver or recipient of p_connection_id. Never returns notes, tokens, or emails -- title + normalized outcome + timestamp only. No connection-status gate: history remains available after a connection ends, per docs/activity-feed-model.md. organizer_account_status/organizer_deleted_at let the client distinguish a deleted organizer from an active one who simply has no full_name set.';

revoke all on function public.get_connection_activity_feed(uuid, timestamptz, text, uuid, int, text) from public, anon, authenticated;
grant execute on function public.get_connection_activity_feed(uuid, timestamptz, text, uuid, int, text) to authenticated;

create function public.get_participant_activity_feed(
  p_before_timestamp timestamptz default null,
  p_before_source text default null,
  p_before_id uuid default null,
  p_limit int default 20,
  p_source_filter text default 'all'
)
returns table (
  source_kind text,
  source_id uuid,
  occurrence_id uuid,
  occurrence_date date,
  event_timestamp timestamptz,
  outcome text,
  title text,
  organizer_name text,
  organizer_account_status text,
  organizer_deleted_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
stable
as $$
declare
  v_uid uuid := auth.uid();
  v_limit int := least(greatest(coalesce(p_limit, 20), 1), 50);
begin
  if v_uid is null then
    raise exception 'authentication_required';
  end if;

  if p_source_filter not in ('all', 'reminder', 'task') then
    raise exception 'invalid_source_filter';
  end if;

  return query
  with reminder_events as (
    select
      'reminder'::text as ev_source_kind,
      rl.reminder_id as ev_source_id,
      rl.id as ev_occurrence_id,
      rl.occurrence_date as ev_occurrence_date,
      rl.updated_at as ev_event_timestamp,
      rl.status as ev_outcome,
      r.title as ev_title,
      rl.caregiver_id as ev_caregiver_id
    from public.reminder_logs rl
    join public.reminders r on r.id = rl.reminder_id
    where rl.recipient_id = v_uid
      and rl.status in ('taken', 'skipped', 'missed')
      and p_source_filter in ('all', 'reminder')
  ),
  task_events as (
    select
      'task'::text,
      o.task_id,
      o.id,
      o.occurrence_date,
      o.updated_at,
      o.status,
      t.title,
      o.caregiver_id
    from public.task_occurrences o
    join public.tasks t on t.id = o.task_id
    where o.recipient_id = v_uid
      and p_source_filter in ('all', 'task')
  ),
  combined as (
    select * from reminder_events
    union all
    select * from task_events
  )
  select
    c.ev_source_kind, c.ev_source_id, c.ev_occurrence_id, c.ev_occurrence_date,
    c.ev_event_timestamp, c.ev_outcome, c.ev_title, cg.full_name, cg.account_status, cg.deleted_at
  from combined c
  left join public.profiles cg on cg.id = c.ev_caregiver_id
  where p_before_timestamp is null
     or (c.ev_event_timestamp, c.ev_source_kind, c.ev_source_id) < (p_before_timestamp, coalesce(p_before_source, ''), coalesce(p_before_id, '00000000-0000-0000-0000-000000000000'::uuid))
  order by c.ev_event_timestamp desc, c.ev_source_kind desc, c.ev_source_id desc
  limit v_limit;
end;
$$;

comment on function public.get_participant_activity_feed(timestamptz, text, uuid, int, text) is
  'Read-only, cursor-paginated activity for the CALLING participant across every organizer they have ever connected to. auth.uid() is the sole scope -- no connection_id parameter exists, so there is nothing for a caller to manipulate into reading another participant''s data. Never returns notes, tokens, or emails. organizer_account_status/organizer_deleted_at let the client distinguish a deleted organizer from an active one who simply has no full_name set.';

revoke all on function public.get_participant_activity_feed(timestamptz, text, uuid, int, text) from public, anon, authenticated;
grant execute on function public.get_participant_activity_feed(timestamptz, text, uuid, int, text) to authenticated;

-- ═══ Rollback ═════════════════════════════════════════════════════════════
-- Restores the prior (pre-this-migration) 5/6-column-return versions
-- exactly as defined in 20260729000000_activity_feed.sql.
