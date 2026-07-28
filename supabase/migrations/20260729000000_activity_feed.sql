-- Week 3 product-expansion task #2: unified Today hub + cross-object
-- activity timeline for timed reminders and flexible tasks.
--
-- ─── Architecture decision (Phase 1/2 audit summary) ────────────────────────
-- No new event table. reminder_logs and task_occurrences already ARE
-- reliable, timestamped historical-outcome ledgers:
--   - task_occurrences is fully immutable after insert (trigger-enforced,
--     see 20260728000000_flexible_tasks.sql) -- every one of its 3 statuses
--     (completed_on_time/completed_late/skipped) is safe to show forever.
--   - reminder_logs has exactly 3 TERMINAL statuses (taken/skipped/missed).
--     Confirmed by reading sync_missed_reminders_db(): its upsert's
--     "on conflict ... where status in ('pending','snoozed')" guard means
--     'missed' can only ever be written fresh or override a still-open
--     'snoozed' row -- it can NEVER overwrite taken/skipped/missed. Combined
--     with respond_to_reminder_occurrence's own "already_answered" guard
--     (which blocks any further mutation once taken/skipped is set), all
--     three terminal statuses are provably immutable once written.
--   - 'snoozed' is reminder_logs' ONE mutable, non-terminal status -- a
--     snooze is a live *current-state* transition, not a durable event (the
--     same row is later overwritten with the eventual taken/skipped/missed
--     outcome). This is why snooze is excluded from the activity timeline
--     below but still shown in the participant's Today hub (current state
--     only) -- see docs/activity-feed-model.md.
-- Since both ledgers already have this property, a read-only UNION ALL
-- (via two new SECURITY DEFINER functions) is sufficient. No cron, no
-- background job, no new persisted log.
--
-- Today (a single participant's own small, bounded "what's due now" set)
-- needs no RPC at all -- it is a pure client-side merge of the exact same
-- RLS-gated direct reads recipient-dashboard.tsx and lib/taskData.ts
-- already perform (see lib/todayFeedCore.ts). A dedicated RPC is reserved
-- for the two cases that actually need it: cross-object CURSOR PAGINATION
-- over potentially long history, and strict SERVER-SIDE connection-
-- authorization for the organizer's timeline.

-- ═══ 1. Supporting indexes (justified: both new functions filter by
-- connection_id/recipient_id and order by updated_at) ════════════════════

create index idx_reminder_logs_connection_updated
  on public.reminder_logs (connection_id, updated_at desc);
create index idx_reminder_logs_recipient_updated
  on public.reminder_logs (recipient_id, updated_at desc);
create index idx_task_occurrences_connection_updated
  on public.task_occurrences (connection_id, updated_at desc);
create index idx_task_occurrences_recipient_updated
  on public.task_occurrences (recipient_id, updated_at desc);

-- ═══ 2. get_connection_activity_feed ═══════════════════════════════════
--
-- One connection's chronological, cross-object activity — usable by either
-- party of that connection (the organizer viewing their selected
-- participant, or the participant viewing one specific connection).
-- Deliberately does NOT gate on connection status: a connection the caller
-- explicitly selected (including an ended one) still returns its history,
-- mirroring task_analytics_summary's existing precedent -- past
-- participation entitles you to your own history regardless of current
-- connection state.

create or replace function public.get_connection_activity_feed(
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
    cg.full_name, rc.full_name
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
  'Read-only, cursor-paginated, cross-object (reminder + task) activity for one connection. Caller must be the caregiver or recipient of p_connection_id. Never returns notes, tokens, or emails -- title + normalized outcome + timestamp only. No connection-status gate: history remains available after a connection ends, per docs/activity-feed-model.md.';

revoke all on function public.get_connection_activity_feed(uuid, timestamptz, text, uuid, int, text) from public, anon;
grant execute on function public.get_connection_activity_feed(uuid, timestamptz, text, uuid, int, text) to authenticated;

-- ═══ 3. get_participant_activity_feed ═══════════════════════════════════
--
-- The participant's own activity, aggregated across every organizer they
-- have ever been connected to (mirrors how recipient-dashboard.tsx and
-- lib/taskData.ts#fetchTasksForRecipient already aggregate reminders/tasks
-- across all of a recipient's connections rather than one at a time).

create or replace function public.get_participant_activity_feed(
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
  organizer_name text
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
    c.ev_event_timestamp, c.ev_outcome, c.ev_title, cg.full_name
  from combined c
  left join public.profiles cg on cg.id = c.ev_caregiver_id
  where p_before_timestamp is null
     or (c.ev_event_timestamp, c.ev_source_kind, c.ev_source_id) < (p_before_timestamp, coalesce(p_before_source, ''), coalesce(p_before_id, '00000000-0000-0000-0000-000000000000'::uuid))
  order by c.ev_event_timestamp desc, c.ev_source_kind desc, c.ev_source_id desc
  limit v_limit;
end;
$$;

comment on function public.get_participant_activity_feed(timestamptz, text, uuid, int, text) is
  'Read-only, cursor-paginated activity for the CALLING participant across every organizer they have ever connected to. auth.uid() is the sole scope -- no connection_id parameter exists, so there is nothing for a caller to manipulate into reading another participant''s data. Never returns notes, tokens, or emails.';

revoke all on function public.get_participant_activity_feed(timestamptz, text, uuid, int, text) from public, anon;
grant execute on function public.get_participant_activity_feed(timestamptz, text, uuid, int, text) to authenticated;

-- ═══ Rollback ═════════════════════════════════════════════════════════════
-- drop function if exists public.get_participant_activity_feed(timestamptz, text, uuid, int, text);
-- drop function if exists public.get_connection_activity_feed(uuid, timestamptz, text, uuid, int, text);
-- drop index if exists public.idx_task_occurrences_recipient_updated;
-- drop index if exists public.idx_task_occurrences_connection_updated;
-- drop index if exists public.idx_reminder_logs_recipient_updated;
-- drop index if exists public.idx_reminder_logs_connection_updated;
-- Fully additive -- no existing table, column, RLS policy, or reminder/task
-- lifecycle function is altered by this migration.
