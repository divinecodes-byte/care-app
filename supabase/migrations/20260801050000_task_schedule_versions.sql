-- Week 4 Task #3: recurring-task schedule-edit history.
--
-- Confirmed live before writing this migration: `tasks.schedule_version` is
-- a bare incrementing integer with no history of what the schedule WAS
-- before an edit. respond_to_task_occurrence and task_analytics_summary
-- both evaluate ANY historical date's eligibility against the CURRENT
-- `tasks` row only -- editing days_of_week today can wrongly reject (or
-- wrongly accept) a response to an old date that was (or wasn't) eligible
-- under the schedule that actually governed it. This migration adds the
-- minimal history table needed to fix that, and nothing more: due_date
-- (one-time-only) is deliberately NOT versioned -- a one-time task has a
-- single immutable occurrence identity (start_date) and its CURRENT
-- due_date governs "overdue" (matches respond_to_task_occurrence's existing
-- behavior); start_date itself is immutable after creation (confirmed:
-- update_task's live signature has no p_start_date parameter at all), so no
-- segment ever needs to represent a start_date change.
--
-- Production has zero `tasks`/`task_occurrences` rows as of this writing
-- (confirmed via direct count) -- this is what makes a single-segment
-- backfill and an immediately-validated FK from task_occurrences safe (see
-- 20260801060000). A hypothetical future deployment against a database
-- with real historical mixed-schedule-version occurrence data would need a
-- more sophisticated multi-segment backfill reconstruction; not needed
-- here.

create table public.task_schedule_versions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  schedule_version int not null,
  frequency text not null check (frequency <> 'one_time'),
  days_of_week integer[] not null check (
    cardinality(days_of_week) between 1 and 7
    and days_of_week <@ array[1,2,3,4,5,6,7]
  ),
  recurrence_end_date date,
  effective_from_local_date date not null,
  effective_until_local_date date,
  created_at timestamptz not null default now(),
  unique (task_id, schedule_version),
  check (effective_until_local_date is null or effective_until_local_date >= effective_from_local_date)
);

create index idx_task_schedule_versions_task on public.task_schedule_versions (task_id, effective_from_local_date);

-- At most one open (currently-in-effect) segment per task.
create unique index idx_task_schedule_versions_one_open on public.task_schedule_versions (task_id) where effective_until_local_date is null;

alter table public.task_schedule_versions enable row level security;

create policy "Users can view schedule versions for their tasks"
  on public.task_schedule_versions for select
  using (exists (
    select 1 from public.tasks t
    where t.id = task_schedule_versions.task_id
      and (t.caregiver_id = auth.uid() or t.recipient_id = auth.uid())
  ));

revoke all on public.task_schedule_versions from public, anon;
grant select on public.task_schedule_versions to authenticated;

-- ─── Overlap prevention (no extension needed -- daterange/&& are built in) ──

create or replace function public.prevent_task_schedule_version_overlap()
returns trigger
language plpgsql
set search_path to 'public', 'extensions', 'pg_catalog'
as $$
begin
  if exists (
    select 1 from public.task_schedule_versions v
    where v.task_id = NEW.task_id
      and v.id <> NEW.id
      and daterange(v.effective_from_local_date, coalesce(v.effective_until_local_date, 'infinity'::date), '[]')
          && daterange(NEW.effective_from_local_date, coalesce(NEW.effective_until_local_date, 'infinity'::date), '[]')
  ) then
    raise exception 'overlapping_schedule_version_range';
  end if;
  return NEW;
end;
$$;

create trigger trg_prevent_task_schedule_version_overlap
  before insert or update on public.task_schedule_versions
  for each row execute function public.prevent_task_schedule_version_overlap();

-- ─── Immutability: a closed segment can never be touched again ─────────────

create or replace function public.prevent_task_schedule_version_history_mutation()
returns trigger
language plpgsql
set search_path to 'public', 'extensions', 'pg_catalog'
as $$
begin
  if OLD.effective_until_local_date is not null then
    raise exception 'schedule_version_history_is_immutable';
  end if;
  return NEW;
end;
$$;

create trigger trg_prevent_task_schedule_version_history_mutation
  before update or delete on public.task_schedule_versions
  for each row execute function public.prevent_task_schedule_version_history_mutation();

-- ─── Backfill: one open segment per existing recurring task ────────────────
-- Exactly reproduces today's (schedule-blind) behavior -- a strict
-- non-regression, not a reconstruction of real historical edits (none is
-- possible; that history never existed before this migration). No-op today
-- since there are zero existing tasks, but correct for any future
-- deployment path that applies this migration against real data.

insert into public.task_schedule_versions
  (task_id, schedule_version, frequency, days_of_week, recurrence_end_date, effective_from_local_date, effective_until_local_date)
select id, schedule_version, frequency, days_of_week, recurrence_end_date, start_date, null
from public.tasks
where frequency <> 'one_time';

-- ─── Shared SQL eligibility helpers (single source of truth) ───────────────
-- Every range-based caller (task_analytics_summary, the new task-summary
-- RPCs, the new overdue-pagination RPC) uses this function -- none
-- reimplements the segment-join/weekday predicate independently.

create or replace function public._task_eligible_dates(p_task_id uuid, p_range_start date, p_range_end date)
returns table(occurrence_date date, schedule_version int)
language sql
stable
set search_path to 'public', 'extensions', 'pg_catalog'
as $$
  select gs.d::date, sv.schedule_version
  from public.task_schedule_versions sv
  cross join lateral generate_series(
    greatest(sv.effective_from_local_date, p_range_start),
    least(coalesce(sv.effective_until_local_date, p_range_end), coalesce(sv.recurrence_end_date, p_range_end), p_range_end),
    interval '1 day'
  ) as gs(d)
  where sv.task_id = p_task_id
    and extract(isodow from gs.d)::int = any(sv.days_of_week)
$$;

-- Single-date wrapper -- literally delegates to the range function with
-- range=[date,date], so respond_to_task_occurrence can never drift from the
-- range-based logic used everywhere else.
create or replace function public._task_occurrence_schedule_version(p_task_id uuid, p_date date)
returns int
language sql
stable
set search_path to 'public', 'extensions', 'pg_catalog'
as $$
  select schedule_version from public._task_eligible_dates(p_task_id, p_date, p_date) limit 1
$$;

revoke all on function public._task_eligible_dates(uuid, date, date) from public, anon;
grant execute on function public._task_eligible_dates(uuid, date, date) to authenticated;
revoke all on function public._task_occurrence_schedule_version(uuid, date) from public, anon;
grant execute on function public._task_occurrence_schedule_version(uuid, date) to authenticated;

-- ─── _create_task_core: insert the initial segment ──────────────────────────

create or replace function public._create_task_core(
  p_connection_id uuid, p_caregiver_id uuid, p_recipient_id uuid,
  p_title text, p_notes text, p_frequency text, p_days_of_week integer[],
  p_start_date date, p_due_date date, p_recurrence_end_date date,
  p_suppress_notification boolean
)
returns tasks
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_catalog'
as $$
declare
    v_result public.tasks%rowtype;
begin
    if p_title is null or btrim(p_title) = '' then
        raise exception 'invalid_title';
    end if;

    if p_frequency not in ('one_time', 'daily', 'weekdays', 'weekends', 'custom') then
        raise exception 'invalid_frequency';
    end if;

    if p_frequency <> 'one_time' then
        if p_days_of_week is null or cardinality(p_days_of_week) < 1 or cardinality(p_days_of_week) > 7
           or not (p_days_of_week <@ array[1,2,3,4,5,6,7]) then
            raise exception 'invalid_days_of_week';
        end if;
        if p_due_date is not null then
            raise exception 'recurring_task_cannot_have_due_date';
        end if;
    end if;

    if p_start_date is null then
        raise exception 'invalid_start_date';
    end if;

    if p_due_date is not null and p_due_date < p_start_date then
        raise exception 'due_date_before_start_date';
    end if;

    if p_recurrence_end_date is not null and p_recurrence_end_date < p_start_date then
        raise exception 'recurrence_end_before_start_date';
    end if;

    insert into public.tasks (
        connection_id, caregiver_id, recipient_id, title, notes,
        frequency, days_of_week, start_date, due_date, recurrence_end_date
    ) values (
        p_connection_id, p_caregiver_id, p_recipient_id, btrim(p_title), nullif(btrim(coalesce(p_notes, '')), ''),
        p_frequency, case when p_frequency = 'one_time' then '{}'::integer[] else p_days_of_week end,
        p_start_date, p_due_date, p_recurrence_end_date
    )
    returning * into v_result;

    if v_result.frequency <> 'one_time' then
        insert into public.task_schedule_versions
          (task_id, schedule_version, frequency, days_of_week, recurrence_end_date, effective_from_local_date)
        values
          (v_result.id, v_result.schedule_version, v_result.frequency, v_result.days_of_week, v_result.recurrence_end_date, v_result.start_date);
    end if;

    if not p_suppress_notification then
        insert into public.task_notification_deliveries (task_id, recipient_id)
        values (v_result.id, v_result.recipient_id);
    end if;

    return v_result;
end;
$$;

revoke all on function public._create_task_core(uuid, uuid, uuid, text, text, text, integer[], date, date, date, boolean) from public, anon;

-- ─── update_task: recipient-tz lookup + correct segment maintenance ────────
-- Corrected same-day re-edit rule (see migration header / plan): an open
-- segment may only be overwritten in place when it has NEVER governed a
-- persisted occurrence AND has never been open across a past day -- either
-- condition means it may already have locked in real (persisted) or
-- computed (unresolved-but-eligible) historical meaning that must not be
-- retroactively changed.

create or replace function public.update_task(
  p_task_id uuid, p_title text, p_notes text, p_frequency text,
  p_days_of_week integer[], p_due_date date, p_recurrence_end_date date
)
returns tasks
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_catalog'
as $$
declare
  v_caregiver_id uuid := auth.uid();
  v_task public.tasks%rowtype;
  v_connection public.connections%rowtype;
  v_schedule_changed boolean;
  v_result public.tasks%rowtype;
  v_resolved_days integer[];
  v_tz text;
  v_today date;
  v_open public.task_schedule_versions%rowtype;
  v_has_recorded_occurrence boolean;
begin
  if v_caregiver_id is null then
    raise exception 'authentication_required';
  end if;

  if p_title is null or btrim(p_title) = '' then
    raise exception 'invalid_title';
  end if;

  if p_frequency not in ('one_time', 'daily', 'weekdays', 'weekends', 'custom') then
    raise exception 'invalid_frequency';
  end if;

  select * into v_task from public.tasks where id = p_task_id for update;
  if not found or v_task.caregiver_id <> v_caregiver_id then
    raise exception 'not_authorized';
  end if;

  if not v_task.is_active then
    raise exception 'task_inactive';
  end if;

  if (p_frequency = 'one_time') <> (v_task.frequency = 'one_time') then
    raise exception 'cannot_change_task_type';
  end if;

  if p_frequency <> 'one_time' then
    if p_days_of_week is null or cardinality(p_days_of_week) < 1 or cardinality(p_days_of_week) > 7
       or not (p_days_of_week <@ array[1,2,3,4,5,6,7]) then
      raise exception 'invalid_days_of_week';
    end if;
    if p_due_date is not null then
      raise exception 'recurring_task_cannot_have_due_date';
    end if;
  end if;

  if p_due_date is not null and p_due_date < v_task.start_date then
    raise exception 'due_date_before_start_date';
  end if;

  if p_recurrence_end_date is not null and p_recurrence_end_date < v_task.start_date then
    raise exception 'recurrence_end_before_start_date';
  end if;

  select * into v_connection from public.connections where id = v_task.connection_id for share;
  if not found or v_connection.status <> 'accepted' or v_connection.accepted_at is null then
    raise exception 'connection_inactive';
  end if;

  v_resolved_days := case when p_frequency = 'one_time' then '{}'::integer[] else p_days_of_week end;

  v_schedule_changed :=
    v_task.frequency <> p_frequency
    or coalesce(v_task.due_date, '0001-01-01'::date) <> coalesce(p_due_date, '0001-01-01'::date)
    or coalesce(v_task.recurrence_end_date, '0001-01-01'::date) <> coalesce(p_recurrence_end_date, '0001-01-01'::date)
    or (select array_agg(d order by d) from unnest(v_task.days_of_week) d)
       is distinct from (select array_agg(d order by d) from unnest(v_resolved_days) d);

  update public.tasks
  set title = btrim(p_title),
      notes = nullif(btrim(coalesce(p_notes, '')), ''),
      frequency = p_frequency,
      days_of_week = v_resolved_days,
      due_date = p_due_date,
      recurrence_end_date = p_recurrence_end_date,
      schedule_version = case when v_schedule_changed then schedule_version + 1 else schedule_version end,
      updated_at = now()
  where id = p_task_id
  returning * into v_result;

  -- Recurring schedule maintenance -- only when the recurrence-affecting
  -- fields actually changed, and only for recurring tasks (one-time tasks
  -- never have schedule_version rows; their current due_date always
  -- governs, no versioning needed).
  if v_schedule_changed and v_result.frequency <> 'one_time' then
    select timezone into v_tz from public.profiles where id = v_task.recipient_id;
    v_tz := coalesce(v_tz, 'America/New_York');
    v_today := (now() at time zone v_tz)::date;

    select * into v_open from public.task_schedule_versions
      where task_id = p_task_id and effective_until_local_date is null
      for update;

    if not found then
      -- Defensive: should be structurally impossible (every recurring task
      -- always has exactly one open segment), but never silently skip
      -- history maintenance if it somehow happens.
      insert into public.task_schedule_versions
        (task_id, schedule_version, frequency, days_of_week, recurrence_end_date, effective_from_local_date)
      values
        (p_task_id, v_result.schedule_version, p_frequency, v_resolved_days, p_recurrence_end_date, v_today);
    else
      v_has_recorded_occurrence := exists (
        select 1 from public.task_occurrences
        where task_id = p_task_id and occurrence_date >= v_open.effective_from_local_date
      );

      if v_has_recorded_occurrence or v_open.effective_from_local_date < v_today then
        -- The open segment has either already governed a persisted
        -- response, or has been open across at least one past day
        -- (governing unresolved-but-computed eligibility for those days
        -- too) -- it must never be mutated. Close it and open a fresh one.
        update public.task_schedule_versions
          set effective_until_local_date = v_today - 1
          where id = v_open.id;

        insert into public.task_schedule_versions
          (task_id, schedule_version, frequency, days_of_week, recurrence_end_date, effective_from_local_date)
        values
          (p_task_id, v_result.schedule_version, p_frequency, v_resolved_days, p_recurrence_end_date, v_today);
      else
        -- v_open.effective_from_local_date >= v_today AND nothing has ever
        -- been recorded against it -- safe to overwrite in place, no
        -- persisted or computed-historical meaning exists yet to corrupt.
        update public.task_schedule_versions
          set frequency = p_frequency,
              days_of_week = v_resolved_days,
              recurrence_end_date = p_recurrence_end_date,
              schedule_version = v_result.schedule_version
          where id = v_open.id;
      end if;
    end if;
  end if;

  -- No task_occurrences reconciliation needed here (unchanged from before):
  -- non-terminal occurrences are never materialized, so there is nothing
  -- stale to requeue or delete. Historical task_occurrences rows are never
  -- touched by this function.
  return v_result;
end;
$$;

revoke all on function public.update_task(uuid, text, text, text, integer[], date, date) from public, anon;
grant execute on function public.update_task(uuid, text, text, text, integer[], date, date) to authenticated;

-- ═══ Rollback ═════════════════════════════════════════════════════════════
-- drop trigger trg_prevent_task_schedule_version_history_mutation on public.task_schedule_versions;
-- drop trigger trg_prevent_task_schedule_version_overlap on public.task_schedule_versions;
-- drop function if exists public.prevent_task_schedule_version_history_mutation();
-- drop function if exists public.prevent_task_schedule_version_overlap();
-- drop function if exists public._task_occurrence_schedule_version(uuid, date);
-- drop function if exists public._task_eligible_dates(uuid, date, date);
-- restore _create_task_core/update_task bodies from 20260728000000_flexible_tasks.sql.
-- drop table public.task_schedule_versions;
