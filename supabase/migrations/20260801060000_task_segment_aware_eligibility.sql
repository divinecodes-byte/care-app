-- Week 4 Task #3, continued: segment-aware eligibility in
-- respond_to_task_occurrence and task_analytics_summary, both now routed
-- through the single shared source of truth (_task_eligible_dates /
-- _task_occurrence_schedule_version, added in 20260801050000) instead of
-- each independently reading the live `tasks` row for historical dates.
--
-- Also fixes a grant-scope error caught during direct live verification of
-- the prior migration: _task_eligible_dates/_task_occurrence_schedule_version
-- were granted to `authenticated`, but per this codebase's established
-- convention (see docs/routine-security-model.md's "SECURITY DEFINER
-- discipline" -- internal helpers are granted to nobody beyond their owning
-- role; only the public-facing RPCs that call them are granted to
-- `authenticated`) these are internal helpers only, never called directly
-- by client code. Revoking here rather than editing the already-applied
-- prior migration file in place.

revoke execute on function public._task_eligible_dates(uuid, date, date) from authenticated;
revoke execute on function public._task_occurrence_schedule_version(uuid, date) from authenticated;

-- ─── task_occurrences.schedule_version integrity ────────────────────────────
-- A plain FK isn't compatible here: one-time tasks never have a
-- task_schedule_versions row (their current due_date always governs, no
-- versioning needed -- see 20260801050000), so a task_occurrences row for a
-- one-time task always carries a schedule_version with no corresponding
-- segment to reference. A trigger-based constraint, scoped to recurring
-- tasks only, is the correct equivalent-integrity-check alternative.
-- Confirmed via direct query before writing this migration that
-- public.task_occurrences currently has zero rows in production, so this
-- constraint (like the FK it replaces) is safe to add with immediate
-- validation, not NOT VALID.

create or replace function public.check_task_occurrence_schedule_version()
returns trigger
language plpgsql
set search_path to 'public', 'extensions', 'pg_catalog'
as $$
declare
  v_frequency text;
begin
  select frequency into v_frequency from public.tasks where id = NEW.task_id;
  if v_frequency <> 'one_time' then
    if not exists (
      select 1 from public.task_schedule_versions
      where task_id = NEW.task_id and schedule_version = NEW.schedule_version
    ) then
      raise exception 'task_occurrence_schedule_version_not_found';
    end if;
  end if;
  return NEW;
end;
$$;

create constraint trigger trg_check_task_occurrence_schedule_version
  after insert on public.task_occurrences
  for each row execute function public.check_task_occurrence_schedule_version();

-- ─── task_analytics_summary: segment-aware recurring branch ────────────────
-- One-time branch and the caller-supplied p_days window are byte-for-byte
-- unchanged.

create or replace function public.task_analytics_summary(p_connection_id uuid, p_days integer default 30)
returns table(metric text, value numeric)
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
  v_window_start date;
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
  v_window_start := v_today - greatest(p_days, 1);

  return query
  with eligible_dates as (
    -- One-time tasks: a single row on their own start_date, if within window.
    select t.id as task_id, t.due_date, t.start_date as occurrence_date, t.schedule_version
    from public.tasks t
    where t.connection_id = p_connection_id
      and t.frequency = 'one_time'
      and t.start_date >= v_window_start and t.start_date <= v_today
    union all
    -- Recurring tasks: every eligible calendar date in the window, resolved
    -- against whichever schedule-version segment actually governed each
    -- date -- never blindly the task's CURRENT frequency/days_of_week.
    select t.id as task_id, e.occurrence_date as due_date, e.occurrence_date, e.schedule_version
    from public.tasks t
    cross join lateral public._task_eligible_dates(t.id, greatest(t.start_date, v_window_start), v_today) e
    where t.connection_id = p_connection_id
      and t.frequency <> 'one_time'
  ),
  merged as (
    select e.task_id, e.occurrence_date::date as occurrence_date, e.due_date, o.status
    from eligible_dates e
    left join public.task_occurrences o
      on o.task_id = e.task_id and o.occurrence_date = e.occurrence_date
  )
  select 'tasks_due'::text, count(*)::numeric from merged
  union all
  select 'completed', count(*) from merged where status in ('completed_on_time', 'completed_late')
  union all
  select 'completed_on_time', count(*) from merged where status = 'completed_on_time'
  union all
  select 'completed_late', count(*) from merged where status = 'completed_late'
  union all
  select 'skipped', count(*) from merged where status = 'skipped'
  union all
  select 'currently_overdue', count(*) from merged
    where status is null and due_date is not null and due_date < v_today
  union all
  select 'completion_rate',
    case when count(*) filter (where status is not null or (due_date is not null and due_date < v_today)) = 0 then null
    else round(
      count(*) filter (where status in ('completed_on_time', 'completed_late'))::numeric
      / count(*) filter (where status is not null or (due_date is not null and due_date < v_today))::numeric,
      4)
    end
  from merged
  union all
  select 'on_time_rate',
    case when count(*) filter (where status in ('completed_on_time', 'completed_late') and due_date is not null) = 0 then null
    else round(
      count(*) filter (where status = 'completed_on_time')::numeric
      / count(*) filter (where status in ('completed_on_time', 'completed_late') and due_date is not null)::numeric,
      4)
    end
  from merged;
end;
$$;

revoke all on function public.task_analytics_summary(uuid, integer) from public, anon;
grant execute on function public.task_analytics_summary(uuid, integer) to authenticated;

-- ─── respond_to_task_occurrence: segment-aware recurring eligibility ───────

create or replace function public.respond_to_task_occurrence(p_task_id uuid, p_occurrence_date date, p_status text)
returns task_occurrences
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_catalog'
as $$
declare
  v_recipient_id uuid := auth.uid();
  v_tz text;
  v_task public.tasks%rowtype;
  v_connection public.connections%rowtype;
  v_today date;
  v_existing public.task_occurrences%rowtype;
  v_effective_due_date date;
  v_stored_status text;
  v_completed_at timestamptz;
  v_skipped_at timestamptz;
  v_existing_matches boolean;
  v_result public.task_occurrences%rowtype;
  v_seg_version int;
  v_stamped_version int;
begin
  if v_recipient_id is null then
    raise exception 'authentication_required';
  end if;

  if p_status not in ('completed', 'skipped') then
    raise exception 'invalid_status';
  end if;

  select timezone into v_tz from public.profiles where id = v_recipient_id;
  if v_tz is null then
    raise exception 'profile_not_found';
  end if;

  select * into v_task from public.tasks where id = p_task_id for share;
  if not found then
    raise exception 'task_not_found';
  end if;

  if v_task.recipient_id <> v_recipient_id then
    raise exception 'not_authorized';
  end if;

  if not v_task.is_active then
    raise exception 'task_inactive';
  end if;

  select * into v_connection from public.connections where id = v_task.connection_id for share;
  if not found or v_connection.status <> 'accepted' or v_connection.accepted_at is null then
    raise exception 'connection_inactive';
  end if;

  v_today := (now() at time zone v_tz)::date;

  if p_occurrence_date > v_today then
    raise exception 'occurrence_not_yet_eligible';
  end if;

  if v_task.frequency = 'one_time' then
    if p_occurrence_date <> v_task.start_date then
      raise exception 'occurrence_ineligible';
    end if;
    v_stamped_version := v_task.schedule_version;
  else
    -- Resolved against whichever schedule-version segment actually
    -- governed p_occurrence_date -- never the task's CURRENT
    -- frequency/days_of_week. A date only eligible under a schedule that
    -- was later changed still resolves correctly; a date never eligible
    -- under any schedule that ever existed is correctly rejected even if
    -- the CURRENT schedule happens to include that day-of-week.
    v_seg_version := public._task_occurrence_schedule_version(v_task.id, p_occurrence_date);
    if v_seg_version is null then
      raise exception 'occurrence_ineligible';
    end if;
    v_stamped_version := v_seg_version;
  end if;

  v_effective_due_date := case when v_task.frequency = 'one_time' then v_task.due_date else p_occurrence_date end;

  if p_status = 'completed' then
    v_stored_status := case
      when v_effective_due_date is null or v_today <= v_effective_due_date then 'completed_on_time'
      else 'completed_late'
    end;
    v_completed_at := now();
    v_skipped_at := null;
  else
    v_stored_status := 'skipped';
    v_completed_at := null;
    v_skipped_at := now();
  end if;

  select * into v_existing
  from public.task_occurrences
  where task_id = p_task_id and occurrence_date = p_occurrence_date
  for update;

  if found then
    v_existing_matches :=
      (p_status = 'completed' and v_existing.status in ('completed_on_time', 'completed_late'))
      or (p_status = 'skipped' and v_existing.status = 'skipped');

    if v_existing_matches then
      return v_existing;
    end if;

    raise exception 'already_answered';
  end if;

  insert into public.task_occurrences (
    task_id, connection_id, caregiver_id, recipient_id,
    occurrence_date, due_date, status, completed_at, skipped_at, schedule_version
  ) values (
    p_task_id, v_task.connection_id, v_task.caregiver_id, v_recipient_id,
    p_occurrence_date, v_effective_due_date, v_stored_status, v_completed_at, v_skipped_at, v_stamped_version
  )
  returning * into v_result;

  return v_result;
end;
$$;

revoke all on function public.respond_to_task_occurrence(uuid, date, text) from public, anon;
grant execute on function public.respond_to_task_occurrence(uuid, date, text) to authenticated;

-- ═══ Rollback ═════════════════════════════════════════════════════════════
-- drop trigger trg_check_task_occurrence_schedule_version on public.task_occurrences;
-- drop function if exists public.check_task_occurrence_schedule_version();
-- restore task_analytics_summary/respond_to_task_occurrence bodies from
-- 20260728000000_flexible_tasks.sql.
-- grant execute on function public._task_eligible_dates(uuid, date, date) to authenticated;
-- grant execute on function public._task_occurrence_schedule_version(uuid, date) to authenticated;
