-- Week 4 Task #3, continued: bounded, server-authoritative per-task summary
-- RPCs, replacing lib/taskData.ts's client-side computation entirely
-- (previously: fetch every task_occurrences row bounded by the 60-day
-- TASK_LOOKBACK_DAYS constant, then compute status/overdueCount/
-- actionableDate client-side via lib/taskLifecycle.ts). That approach does
-- not scale once the day-bound is removed: a daily task completed every day
-- for years would require transferring and scanning its complete
-- occurrence history just to determine "nothing is currently unresolved."
--
-- overdue_count is computed via closed-form modular weekday arithmetic
-- (public._weekday_count_in_range / public._task_closed_form_eligible_count
-- below) -- O(segments), never O(days) -- so it is always exact regardless
-- of task age, without ever generating or transferring individual dates.
--
-- actionable_date (the date a quick Complete/Skip tap on a task CARD acts
-- on) uses a small, fixed, bounded backward window (180 days) rather than
-- the closed-form technique, since finding a SPECIFIC date (not just a
-- count) has no closed-form shortcut. If overdue_count > 0 but no
-- unresolved date is found within that bounded window (the rare case of a
-- single very old miss in an otherwise long, clean history),
-- actionable_date is returned null -- the card shows the true count but its
-- quick-action is disabled/redirects to the dedicated, unbounded
-- /overdue-tasks screen (get_participant_overdue_task_occurrences, added
-- next), where the occurrence remains fully reachable and actionable. This
-- is a deliberate, documented bound on the quick-action CONVENIENCE path
-- only -- it never affects the correctness of overdue_count, and never
-- makes an occurrence permanently unreachable.

create or replace function public._weekday_count_in_range(p_from date, p_to date, p_weekday int)
returns bigint
language sql
immutable
set search_path to 'public', 'extensions', 'pg_catalog'
as $$
  select case
    when p_to < p_from then 0::bigint
    when p_from + ((p_weekday - extract(isodow from p_from)::int + 7) % 7) > p_to then 0::bigint
    else (((p_to - (p_from + ((p_weekday - extract(isodow from p_from)::int + 7) % 7))) / 7) + 1)::bigint
  end
$$;

-- Sums the closed-form weekday count across every schedule-version segment
-- that intersects [p_range_start, p_range_end], each using ITS OWN
-- days_of_week/recurrence_end_date -- never the task's current schedule for
-- the whole range. One-time tasks always return 0 (they have no segments;
-- callers branch on frequency separately).
create or replace function public._task_closed_form_eligible_count(p_task_id uuid, p_range_start date, p_range_end date)
returns bigint
language sql
stable
set search_path to 'public', 'extensions', 'pg_catalog'
as $$
  select coalesce(sum(public._weekday_count_in_range(
    greatest(sv.effective_from_local_date, p_range_start),
    least(coalesce(sv.effective_until_local_date, p_range_end), coalesce(sv.recurrence_end_date, p_range_end), p_range_end),
    wd
  )), 0)::bigint
  from public.task_schedule_versions sv
  cross join lateral unnest(sv.days_of_week) as wd
  where sv.task_id = p_task_id
$$;

revoke all on function public._weekday_count_in_range(date, date, int) from public, anon, authenticated;
revoke all on function public._task_closed_form_eligible_count(uuid, date, date) from public, anon, authenticated;

-- ─── One bounded summary row per active task ────────────────────────────────

create or replace function public.get_participant_task_summaries()
returns table(
  task_id uuid, title text, frequency text, is_active boolean, connection_id uuid,
  caregiver_id uuid, organizer_full_name text, organizer_account_status text, organizer_deleted_at timestamptz,
  status text, overdue_count bigint, actionable_date date, upcoming_date date,
  last_resolved_date date, last_resolved_status text
)
language plpgsql
stable
security definer
set search_path to 'public', 'extensions', 'pg_catalog'
as $$
declare
  v_uid uuid := auth.uid();
  v_tz text;
  v_today date;
begin
  if v_uid is null then
    raise exception 'authentication_required';
  end if;

  select timezone into v_tz from public.profiles where id = v_uid;
  v_tz := coalesce(v_tz, 'America/New_York');
  v_today := (now() at time zone v_tz)::date;

  return query
  select
    t.id, t.title, t.frequency, t.is_active, t.connection_id, t.caregiver_id,
    cg.full_name, cg.account_status, cg.deleted_at,
    case
      when t.frequency = 'one_time' then
        coalesce(
          (select o.status from public.task_occurrences o where o.task_id = t.id and o.occurrence_date = t.start_date),
          case
            when t.start_date > v_today then 'upcoming'
            when t.due_date is not null and t.due_date < v_today then 'overdue'
            else 'open'
          end
        )
      else
        case
          when coalesce(oc.overdue_count, 0) > 0 then 'overdue'
          when oc.today_open then 'open'
          when t.start_date > v_today then 'upcoming'
          when lr.last_resolved_status is not null then lr.last_resolved_status
          else 'open'
        end
    end as status,
    case when t.frequency = 'one_time' then 0::bigint else coalesce(oc.overdue_count, 0) end,
    case when t.frequency = 'one_time' then
        (case when t.start_date <= v_today and not exists (select 1 from public.task_occurrences o where o.task_id=t.id and o.occurrence_date=t.start_date) then t.start_date else null end)
      else oc.actionable_date end,
    case when t.start_date > v_today then t.start_date else null end,
    lr.last_resolved_date, lr.last_resolved_status
  from public.tasks t
  left join public.profiles cg on cg.id = t.caregiver_id
  left join lateral (
    select o.occurrence_date as last_resolved_date, o.status as last_resolved_status
    from public.task_occurrences o
    where o.task_id = t.id
    order by o.occurrence_date desc
    limit 1
  ) lr on true
  left join lateral (
    select
      (public._task_closed_form_eligible_count(t.id, t.start_date, v_today - 1)
       - (select count(*) from public.task_occurrences o2 where o2.task_id = t.id and o2.occurrence_date < v_today)
      ) as overdue_count,
      exists (
        select 1 from public._task_eligible_dates(t.id, v_today, v_today) e
        where not exists (select 1 from public.task_occurrences o4 where o4.task_id = t.id and o4.occurrence_date = e.occurrence_date)
      ) as today_open,
      (
        select e.occurrence_date
        from public._task_eligible_dates(t.id, greatest(t.start_date, v_today - 180), v_today - 1) e
        where not exists (select 1 from public.task_occurrences o3 where o3.task_id = t.id and o3.occurrence_date = e.occurrence_date)
        order by e.occurrence_date asc
        limit 1
      ) as actionable_date
    where t.frequency <> 'one_time'
  ) oc on true
  where t.recipient_id = v_uid and t.is_active;
end;
$$;

create or replace function public.get_connection_task_summaries(p_connection_id uuid)
returns table(
  task_id uuid, title text, frequency text, is_active boolean, connection_id uuid,
  status text, overdue_count bigint, actionable_date date, upcoming_date date,
  last_resolved_date date, last_resolved_status text
)
language plpgsql
stable
security definer
set search_path to 'public', 'extensions', 'pg_catalog'
as $$
declare
  v_uid uuid := auth.uid();
  v_connection public.connections%rowtype;
  v_tz text;
  v_today date;
begin
  if v_uid is null then
    raise exception 'authentication_required';
  end if;

  select * into v_connection from public.connections where id = p_connection_id;
  if not found or (v_connection.caregiver_id <> v_uid and v_connection.recipient_id <> v_uid) then
    raise exception 'not_authorized';
  end if;

  select timezone into v_tz from public.profiles where id = v_connection.recipient_id;
  v_tz := coalesce(v_tz, 'America/New_York');
  v_today := (now() at time zone v_tz)::date;

  return query
  select
    t.id, t.title, t.frequency, t.is_active, t.connection_id,
    case
      when t.frequency = 'one_time' then
        coalesce(
          (select o.status from public.task_occurrences o where o.task_id = t.id and o.occurrence_date = t.start_date),
          case
            when t.start_date > v_today then 'upcoming'
            when t.due_date is not null and t.due_date < v_today then 'overdue'
            else 'open'
          end
        )
      else
        case
          when coalesce(oc.overdue_count, 0) > 0 then 'overdue'
          when oc.today_open then 'open'
          when t.start_date > v_today then 'upcoming'
          when lr.last_resolved_status is not null then lr.last_resolved_status
          else 'open'
        end
    end as status,
    case when t.frequency = 'one_time' then 0::bigint else coalesce(oc.overdue_count, 0) end,
    case when t.frequency = 'one_time' then
        (case when t.start_date <= v_today and not exists (select 1 from public.task_occurrences o where o.task_id=t.id and o.occurrence_date=t.start_date) then t.start_date else null end)
      else oc.actionable_date end,
    case when t.start_date > v_today then t.start_date else null end,
    lr.last_resolved_date, lr.last_resolved_status
  from public.tasks t
  left join lateral (
    select o.occurrence_date as last_resolved_date, o.status as last_resolved_status
    from public.task_occurrences o
    where o.task_id = t.id
    order by o.occurrence_date desc
    limit 1
  ) lr on true
  left join lateral (
    select
      (public._task_closed_form_eligible_count(t.id, t.start_date, v_today - 1)
       - (select count(*) from public.task_occurrences o2 where o2.task_id = t.id and o2.occurrence_date < v_today)
      ) as overdue_count,
      exists (
        select 1 from public._task_eligible_dates(t.id, v_today, v_today) e
        where not exists (select 1 from public.task_occurrences o4 where o4.task_id = t.id and o4.occurrence_date = e.occurrence_date)
      ) as today_open,
      (
        select e.occurrence_date
        from public._task_eligible_dates(t.id, greatest(t.start_date, v_today - 180), v_today - 1) e
        where not exists (select 1 from public.task_occurrences o3 where o3.task_id = t.id and o3.occurrence_date = e.occurrence_date)
        order by e.occurrence_date asc
        limit 1
      ) as actionable_date
    where t.frequency <> 'one_time'
  ) oc on true
  where t.connection_id = p_connection_id;
end;
$$;

revoke all on function public.get_participant_task_summaries() from public, anon;
grant execute on function public.get_participant_task_summaries() to authenticated;
revoke all on function public.get_connection_task_summaries(uuid) from public, anon;
grant execute on function public.get_connection_task_summaries(uuid) to authenticated;

-- ═══ Rollback ═════════════════════════════════════════════════════════════
-- drop function if exists public.get_connection_task_summaries(uuid);
-- drop function if exists public.get_participant_task_summaries();
-- drop function if exists public._task_closed_form_eligible_count(uuid, date, date);
-- drop function if exists public._weekday_count_in_range(date, date, int);
