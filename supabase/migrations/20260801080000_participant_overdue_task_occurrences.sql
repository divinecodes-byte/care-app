-- Week 4 Task #3, continued: get_participant_overdue_task_occurrences --
-- bounded, cursor-paginated, complete overdue-occurrence history with no
-- arbitrary day cutoff. Powers the new app/overdue-tasks.tsx screen.
--
-- Termination is derived purely from v_min_start (the minimum start_date
-- across the participant's own active tasks) -- a real, task-existence
-- bound, never a hardcoded day count. Each loop iteration searches a
-- strictly disjoint date window, geometrically growing (capped at 730 days
-- per iteration for per-iteration cost, not total search depth) backward
-- from the cursor. A `statement_timeout` is the only defensive guard
-- against a genuine implementation bug -- it fails the call outright
-- (a real RPC error), never silently returns a truncated/incomplete page.
--
-- Ordering/cursor is over `overdue_since_date` (the date that actually
-- determines when something became actionable-and-late), not
-- `occurrence_date` (the immutable response-authorization identity) --
-- these are the same value for recurring tasks but can differ for one-time
-- tasks, whose CURRENT due_date governs display/sort while `start_date`
-- remains the fixed occurrence identity used to respond.

create or replace function public.get_participant_overdue_task_occurrences(
  p_before_date date default null,
  p_before_task_id uuid default null,
  p_limit int default 20
)
returns table(
  task_id uuid,
  occurrence_date date,
  due_date date,
  overdue_since_date date,
  connection_id uuid,
  caregiver_id uuid,
  title text,
  frequency text,
  organizer_full_name text,
  organizer_account_status text,
  organizer_deleted_at timestamptz,
  routine_instance_id uuid,
  has_more boolean
)
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_catalog'
as $$
declare
  v_uid uuid := auth.uid();
  v_tz text;
  v_today date;
  v_limit int;
  v_min_start date;
  v_upper date;
  v_lower date;
  v_chunk int := 90;
  v_collected int;
begin
  if v_uid is null then
    raise exception 'authentication_required';
  end if;

  if (p_before_date is null) <> (p_before_task_id is null) then
    raise exception 'invalid_cursor';
  end if;

  if p_limit is null then
    v_limit := 20;
  elsif p_limit < 1 or p_limit > 50 then
    raise exception 'invalid_page_limit';
  else
    v_limit := p_limit;
  end if;

  select timezone into v_tz from public.profiles where id = v_uid;
  v_tz := coalesce(v_tz, 'America/New_York');
  v_today := (now() at time zone v_tz)::date;

  select min(start_date) into v_min_start
  from public.tasks
  where recipient_id = v_uid and is_active;

  if v_min_start is null then
    return;
  end if;

  -- Defensive guard for implementation bugs only -- a genuine runaway case
  -- errors out loudly rather than returning a silently-incomplete page.
  set local statement_timeout = '5s';

  v_upper := least(coalesce(p_before_date, v_today - 1), v_today - 1);

  create temp table _overdue_page (
    task_id uuid, occurrence_date date, due_date date, overdue_since_date date,
    connection_id uuid, caregiver_id uuid, title text, frequency text, routine_instance_id uuid
  ) on commit drop;

  while v_upper >= v_min_start loop
    v_lower := greatest(v_upper - v_chunk + 1, v_min_start);

    select count(*) into v_collected from _overdue_page;

    insert into _overdue_page
    select cand.task_id, cand.occurrence_date, cand.due_date, cand.overdue_since_date,
           t.connection_id, t.caregiver_id, t.title, t.frequency, rii.routine_instance_id
    from (
      -- Recurring: every date in [v_lower, v_upper] eligible under its own
      -- governing schedule-version segment (via the shared helper --
      -- never a bespoke generate_series here).
      select t2.id as task_id, e.occurrence_date, e.occurrence_date as due_date, e.occurrence_date as overdue_since_date
      from public.tasks t2
      cross join lateral public._task_eligible_dates(t2.id, v_lower, v_upper) e
      where t2.recipient_id = v_uid and t2.is_active and t2.frequency <> 'one_time'
      union all
      -- One-time: single occurrence identity is start_date; overdue_since
      -- is the CURRENT due_date, which is what the window bounds here.
      select t3.id, t3.start_date, t3.due_date, t3.due_date
      from public.tasks t3
      where t3.recipient_id = v_uid and t3.is_active and t3.frequency = 'one_time'
        and t3.due_date is not null
        and t3.due_date between v_lower and v_upper
        and t3.due_date < v_today
    ) cand
    join public.tasks t on t.id = cand.task_id
    left join public.task_occurrences o
      on o.task_id = cand.task_id and o.occurrence_date = cand.occurrence_date
    left join lateral (
      select routine_instance_id from public.routine_instance_items
      where item_kind = 'task' and task_id = cand.task_id
      limit 1
    ) rii on true
    where o.id is null
      and (
        p_before_date is null
        or (cand.overdue_since_date, cand.task_id) < (p_before_date, p_before_task_id)
      )
    order by cand.overdue_since_date desc, cand.task_id desc
    limit (v_limit + 1 - v_collected);

    exit when (select count(*) from _overdue_page) >= v_limit + 1;

    v_upper := v_lower - 1;
    v_chunk := least(v_chunk * 2, 730);
  end loop;

  return query
  select distinct on (p.overdue_since_date, p.task_id)
    p.task_id, p.occurrence_date, p.due_date, p.overdue_since_date,
    p.connection_id, p.caregiver_id, p.title, p.frequency,
    cg.full_name, cg.account_status, cg.deleted_at,
    p.routine_instance_id,
    (select count(*) from _overdue_page) > v_limit as has_more
  from _overdue_page p
  left join public.profiles cg on cg.id = p.caregiver_id
  order by p.overdue_since_date desc, p.task_id desc
  limit v_limit;
end;
$$;

revoke all on function public.get_participant_overdue_task_occurrences(date, uuid, int) from public, anon;
grant execute on function public.get_participant_overdue_task_occurrences(date, uuid, int) to authenticated;

-- ═══ Rollback ═════════════════════════════════════════════════════════════
-- drop function if exists public.get_participant_overdue_task_occurrences(date, uuid, int);
