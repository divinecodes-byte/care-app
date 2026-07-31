-- Week 4 Task #3 correction. Fixes a real defect in
-- get_participant_task_summaries/get_connection_task_summaries's
-- actionable_date column (20260801070000_task_summary_rpcs.sql).
--
-- THE BUG: the previous implementation searched only
-- [greatest(start_date, today-180), today-1] for the earliest unresolved
-- eligible date. This was documented as "returns null for a genuinely
-- ancient lone miss" -- but that description was incomplete and, in one
-- concrete case, wrong: if a task has an unresolved occurrence OLDER than
-- 180 days AND a separate unresolved occurrence WITHIN the last 180 days,
-- the query silently returned the newer (in-window) date as
-- actionable_date -- not null, not an error, a wrong answer. Every
-- production quick-action surface (app/tasks.tsx, app/task-details.tsx,
-- app/recipient-dashboard.tsx's Today hub) sends this value directly to
-- respond_to_task_occurrence's p_occurrence_date on a Complete/Skip tap --
-- so a quick action could complete/skip a NEWER occurrence while a
-- genuinely older unresolved one remained unrepresented as "the"
-- actionable occurrence. overdue_count itself was never affected (it's
-- computed separately via the exact closed-form count) -- only which
-- specific date a quick action targeted.
--
-- THE FIX: _task_earliest_unresolved_date() below finds the EXACT
-- earliest unresolved eligible date via binary search, using the same
-- closed-form eligible-count helper (_task_closed_form_eligible_count,
-- schedule-segment-based, O(1) per call) already used for overdue_count,
-- compared against an indexed count of real terminal task_occurrences
-- rows over the same sub-range. eligible_count(start_date, d) -
-- resolved_count(start_date, d) is non-decreasing in d (each day either
-- adds one unresolved occurrence, one resolved occurrence that cancels
-- out, or nothing), so "the smallest d where this difference is > 0" is a
-- classic monotonic-threshold binary search: O(log(days)) iterations,
-- each O(1) (closed-form call + one indexed range count) -- never an
-- O(days) scan, and never an arbitrary day cutoff. A three-year-old task
-- costs about the same as a three-day-old one (roughly log2(1095) ~= 11
-- iterations vs log2(3) ~= 2). No approximation, no null-when-it-actually-
-- exists case: the exact date is always returned when overdue_count > 0,
-- and null only when overdue_count is genuinely 0.
--
-- This directly implements the plan's "acceptable solution A": exact
-- actionable occurrence from the bounded server summary using schedule
-- segments (_task_closed_form_eligible_count) and data-derived search
-- termination (binary search converges on real data, never a hardcoded
-- day count).

create or replace function public._task_earliest_unresolved_date(p_task_id uuid, p_range_start date, p_range_end date)
returns date
language plpgsql
stable
set search_path to 'public', 'extensions', 'pg_catalog'
as $$
declare
  v_lo date := p_range_start;
  v_hi date := p_range_end;
  v_mid date;
  v_eligible bigint;
  v_resolved bigint;
begin
  if p_range_end < p_range_start then
    return null;
  end if;

  -- Fast path: if the whole range is fully resolved (the common case for
  -- a well-maintained task), skip the binary search entirely.
  v_eligible := public._task_closed_form_eligible_count(p_task_id, p_range_start, p_range_end);
  if v_eligible = 0 then
    return null;
  end if;
  select count(*) into v_resolved from public.task_occurrences
    where task_id = p_task_id and occurrence_date between p_range_start and p_range_end;
  if v_eligible <= v_resolved then
    return null;
  end if;

  -- Binary search for the smallest d in [p_range_start, p_range_end]
  -- where eligible_count(p_range_start, d) > resolved_count(p_range_start, d)
  -- -- i.e. the first date by which an unresolved eligible occurrence has
  -- appeared. Both counts are always computed over the identical
  -- [p_range_start, v_mid] window each iteration, which is what makes the
  -- difference monotonic and the search valid.
  while v_lo < v_hi loop
    v_mid := v_lo + ((v_hi - v_lo) / 2);
    v_eligible := public._task_closed_form_eligible_count(p_task_id, p_range_start, v_mid);
    select count(*) into v_resolved from public.task_occurrences
      where task_id = p_task_id and occurrence_date between p_range_start and v_mid;
    if v_eligible > v_resolved then
      v_hi := v_mid;
    else
      v_lo := v_mid + 1;
    end if;
  end loop;

  return v_lo;
end;
$$;

revoke all on function public._task_earliest_unresolved_date(uuid, date, date) from public, anon, authenticated;

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
      public._task_earliest_unresolved_date(t.id, t.start_date, v_today - 1) as actionable_date
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
      public._task_earliest_unresolved_date(t.id, t.start_date, v_today - 1) as actionable_date
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
-- Restore 20260801070000_task_summary_rpcs.sql's original bodies for
-- get_participant_task_summaries/get_connection_task_summaries (180-day
-- bounded window), then:
-- drop function if exists public._task_earliest_unresolved_date(uuid, date, date);
