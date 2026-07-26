-- Week 3 product-expansion task #1: flexible non-time-based tasks.
--
-- ─── Architecture decision (Phase 1/2 audit summary) ────────────────────────
-- Extending `reminders` was rejected. `reminders.time_of_day` and
-- `no_response_minutes` are NOT NULL with product-meaningful defaults, and
-- the whole delivery/missed/snooze pipeline (claim_due_recipient_reminder_
-- deliveries, claim_due_recipient_snooze_deliveries, sync_missed_reminders_db,
-- validate_reminder_deliveries_for_send) is built entirely around an exact
-- wall-clock instant. Reusing that table would force either nullable exact-
-- time columns (weakening a currently-enforced invariant for every existing
-- timed reminder) or fake sentinel times (explicitly forbidden). A flexible
-- task's lifecycle (upcoming/open/overdue/completed_on_time/completed_late)
-- is also a genuinely different state machine from a timed reminder's
-- (pending/taken/snoozed/skipped/missed) — overdue is NOT terminal the way
-- missed is, and there is deliberately no snooze and no midnight-cron
-- "missed" transition. Two dedicated tables (`tasks`, `task_occurrences`)
-- keep both lifecycles independently correct. `connections`, `profiles`,
-- `push_tokens`, RLS conventions, and client UI abstractions are shared.
--
-- ─── Occurrence-materialization strategy (Phase 6) ──────────────────────────
-- Chosen: computed dynamically, persisted only on interaction. This mirrors
-- how `reminders` already works today: a reminder occurrence with no
-- response has NO reminder_logs row at all (status is computed client-side
-- from days_of_week/time_of_day/now) -- the only thing that differs for
-- reminders is a 5-minute cron that later freezes an unanswered occurrence
-- as a terminal 'missed' row. Tasks need no such cron: overdue is never
-- terminal, so it is fine for it to remain a pure computation forever until
-- the participant actually responds. task_occurrences therefore ONLY ever
-- contains a row for a terminal response (completed_on_time / completed_late
-- / skipped) -- never a materialized upcoming/open/overdue row. This
-- directly satisfies "no unbounded eager generation" (there is no
-- generation at all of non-terminal rows) and "flexible tasks do not
-- automatically become Missed at midnight" (there is no cron touching them).

-- ═══ 1. tasks ════════════════════════════════════════════════════════════
--
-- Internal columns keep the existing caregiver_id/recipient_id convention
-- (see docs/product-terminology.md) -- "Organizer"/"Participant"/"Task" are
-- UI-facing words only, never table or column names.

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.connections(id),
  caregiver_id uuid not null references public.profiles(id),
  recipient_id uuid not null references public.profiles(id),

  title text not null,
  notes text,

  -- 'one_time' is a real frequency value (not a separate boolean) so there
  -- is exactly one source of truth for "is this recurring" -- see the
  -- generated column below.
  frequency text not null,
  days_of_week integer[] not null default '{}',
  is_recurring boolean generated always as (frequency <> 'one_time') stored,

  start_date date not null,
  due_date date,
  recurrence_end_date date,

  is_active boolean not null default true,
  schedule_version integer not null default 1,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint tasks_frequency_values_check
    check (frequency in ('one_time', 'daily', 'weekdays', 'weekends', 'custom')),
  constraint tasks_days_of_week_subset_check
    check (days_of_week <@ array[1,2,3,4,5,6,7]),
  constraint tasks_days_of_week_required_when_recurring_check
    check (frequency = 'one_time' or cardinality(days_of_week) >= 1),
  constraint tasks_due_date_one_time_only_check
    check (frequency = 'one_time' or due_date is null),
  constraint tasks_due_date_after_start_check
    check (due_date is null or due_date >= start_date),
  constraint tasks_recurrence_end_recurring_only_check
    check (frequency = 'one_time' or recurrence_end_date is null),
  constraint tasks_recurrence_end_after_start_check
    check (recurrence_end_date is null or recurrence_end_date >= start_date),
  constraint tasks_title_not_blank_check
    check (btrim(title) <> '')
);

comment on table public.tasks is
  'Flexible (non-time-based) task assignments -- the second accountability object alongside reminders. No exact delivery time; see task_occurrences for terminal responses and docs/flexible-task-model.md for the full lifecycle.';
comment on column public.tasks.due_date is
  'One-time tasks only (enforced by tasks_due_date_one_time_only_check). A recurring task has no single due_date -- each occurrence''s implicit deadline is its own occurrence_date (see respond_to_task_occurrence).';
comment on column public.tasks.start_date is
  'Immutable after creation (not editable via update_task) -- for a one-time task this is the single occurrence''s calendar date; for a recurring task this is the first eligible date.';

create index idx_tasks_connection on public.tasks (connection_id);
create index idx_tasks_recipient_active on public.tasks (recipient_id) where is_active;
create index idx_tasks_caregiver_active on public.tasks (caregiver_id) where is_active;

alter table public.tasks enable row level security;

create policy "Users can view tasks for their connection"
  on public.tasks for select
  using (auth.uid() = caregiver_id or auth.uid() = recipient_id);

-- Deliberately no INSERT/UPDATE policy and no direct grant to `authenticated`
-- below -- every mutation goes through create_task/update_task/archive_task
-- (SECURITY DEFINER, runs as table owner regardless of the caller's own
-- grants). This is a stricter posture than the legacy `reminders` table
-- (which allows a direct RLS-gated client INSERT/UPDATE) and was chosen
-- deliberately per Phase 4's explicit "server-authoritative task operations"
-- requirement.
revoke all on public.tasks from authenticated, anon;
grant select on public.tasks to authenticated;
grant all on public.tasks to service_role;

create or replace function public.prevent_task_identity_change()
returns trigger
language plpgsql
as $$
begin
  if new.connection_id <> old.connection_id
     or new.caregiver_id <> old.caregiver_id
     or new.recipient_id <> old.recipient_id
     or new.start_date <> old.start_date then
    raise exception 'tasks identity fields (connection_id/caregiver_id/recipient_id/start_date) are immutable after insert';
  end if;
  return new;
end;
$$;

create trigger trg_prevent_task_identity_change
  before update on public.tasks
  for each row execute function public.prevent_task_identity_change();

-- ═══ 2. task_occurrences ═════════════════════════════════════════════════
--
-- Only ever contains a row for a TERMINAL response. Non-terminal states
-- (upcoming/open/overdue) are computed, never stored -- see the migration
-- header comment and lib/taskLifecycle.ts.

create table public.task_occurrences (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  connection_id uuid not null references public.connections(id),
  caregiver_id uuid not null references public.profiles(id),
  recipient_id uuid not null references public.profiles(id),

  occurrence_date date not null,
  due_date date,

  status text not null,
  completed_at timestamptz,
  skipped_at timestamptz,

  schedule_version integer not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint task_occurrences_status_values_check
    check (status in ('completed_on_time', 'completed_late', 'skipped')),
  constraint task_occurrences_completed_at_matches_status_check
    check ((status in ('completed_on_time', 'completed_late')) = (completed_at is not null)),
  constraint task_occurrences_skipped_at_matches_status_check
    check ((status = 'skipped') = (skipped_at is not null)),
  constraint task_occurrences_task_date_unique
    unique (task_id, occurrence_date)
);

comment on table public.task_occurrences is
  'Immutable historical record of a completed/skipped task occurrence. Never contains a row for an upcoming/open/overdue occurrence -- those are computed dynamically (see docs/flexible-task-model.md). The unique (task_id, occurrence_date) constraint is what prevents duplicate occurrence creation.';

create index idx_task_occurrences_task on public.task_occurrences (task_id);
create index idx_task_occurrences_recipient on public.task_occurrences (recipient_id);
create index idx_task_occurrences_connection on public.task_occurrences (connection_id);

alter table public.task_occurrences enable row level security;

create policy "Users can view task occurrences for their connection"
  on public.task_occurrences for select
  using (auth.uid() = caregiver_id or auth.uid() = recipient_id);

revoke all on public.task_occurrences from authenticated, anon;
grant select on public.task_occurrences to authenticated;
grant all on public.task_occurrences to service_role;

-- Full-row immutability (stronger than reminder_logs' identity-only guard):
-- a task_occurrences row is never updated by any RPC once inserted (the
-- idempotent-retry path in respond_to_task_occurrence returns the existing
-- row unchanged rather than touching it), so any UPDATE at all is unexpected.
create or replace function public.prevent_task_occurrence_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'task_occurrences rows are immutable after insert';
  return new;
end;
$$;

create trigger trg_prevent_task_occurrence_mutation
  before update on public.task_occurrences
  for each row execute function public.prevent_task_occurrence_mutation();

-- ═══ 3. task_notification_deliveries ═════════════════════════════════════
--
-- A dedicated, separate ledger rather than extending
-- reminder_notification_deliveries -- that table's schema (occurrence_date,
-- delivery_type in ('reminder','snooze'), schedule_version-based requeue-in-
-- place logic) is built entirely around a recurring, re-claimable delivery.
-- A task assignment notification is a single one-shot event per task (the
-- `unique (task_id)` constraint below is what makes "no repeated push
-- merely because a task remains overdue" structurally impossible, not just
-- a policy choice) -- forcing it into the reminder ledger's shape would mean
-- fake occurrence_date/delivery_type values with no real meaning.

create table public.task_notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id),

  status text not null default 'pending',
  error_code text,
  error_message text,
  attempt_count integer not null default 0,

  expo_ticket_id text,
  sent_at timestamptz,
  receipt_checked_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint task_notification_deliveries_status_values_check
    check (status in ('pending', 'sent', 'failed')),
  constraint task_notification_deliveries_error_code_values_check
    check (error_code is null or error_code in (
      'no_active_push_token', 'device_not_registered', 'expo_ticket_error',
      'expo_batch_error', 'task_inactive', 'connection_inactive', 'internal_error'
    )),
  constraint task_notification_deliveries_task_unique unique (task_id)
);

comment on table public.task_notification_deliveries is
  'One row per task, ever -- the unique(task_id) constraint is the structural guarantee of "exactly one assignment notification, never a repeat nag." Separate from reminder_notification_deliveries; see docs/task-notification-contract.md.';

create index idx_task_notification_deliveries_retryable
  on public.task_notification_deliveries (status, attempt_count, updated_at)
  where status in ('pending', 'failed');

alter table public.task_notification_deliveries enable row level security;
-- No client-facing policies at all (stricter than reminder_notification_
-- deliveries, which also grants no client policies) -- service_role only.
revoke all on public.task_notification_deliveries from authenticated, anon;
grant all on public.task_notification_deliveries to service_role;

-- ═══ 4. create_task ══════════════════════════════════════════════════════

create or replace function public.create_task(
  p_connection_id uuid,
  p_title text,
  p_notes text,
  p_frequency text,
  p_days_of_week integer[],
  p_start_date date,
  p_due_date date,
  p_recurrence_end_date date
)
returns public.tasks
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_caregiver_id uuid := auth.uid();
  v_connection public.connections%rowtype;
  v_profile public.profiles%rowtype;
  v_result public.tasks%rowtype;
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

  select * into v_profile from public.profiles where id = v_caregiver_id;
  if not found or v_profile.account_status <> 'active' then
    raise exception 'not_authorized';
  end if;

  select * into v_connection from public.connections where id = p_connection_id for share;
  if not found or v_connection.caregiver_id <> v_caregiver_id or v_connection.status <> 'accepted' or v_connection.accepted_at is null then
    raise exception 'connection_inactive';
  end if;

  insert into public.tasks (
    connection_id, caregiver_id, recipient_id, title, notes,
    frequency, days_of_week, start_date, due_date, recurrence_end_date
  ) values (
    p_connection_id, v_caregiver_id, v_connection.recipient_id, btrim(p_title), nullif(btrim(coalesce(p_notes, '')), ''),
    p_frequency, case when p_frequency = 'one_time' then '{}'::integer[] else p_days_of_week end,
    p_start_date, p_due_date, p_recurrence_end_date
  )
  returning * into v_result;

  -- Exactly one assignment-notification row, ever (see table comment).
  insert into public.task_notification_deliveries (task_id, recipient_id)
  values (v_result.id, v_result.recipient_id);

  return v_result;
end;
$$;

comment on function public.create_task(uuid, text, text, text, integer[], date, date, date) is
  'Organizer-only. Creates a task for an accepted connection they own and enqueues exactly one assignment-notification row. Raises connection_inactive for any non-accepted/foreign connection (RLS-equivalent fail-closed behavior, mirroring reminders'' INSERT policy).';

revoke all on function public.create_task(uuid, text, text, text, integer[], date, date, date) from public, anon;
grant execute on function public.create_task(uuid, text, text, text, integer[], date, date, date) to authenticated;

-- ═══ 5. update_task ══════════════════════════════════════════════════════
--
-- start_date is deliberately not a parameter (immutable, see tasks table
-- comment). frequency's recurring/one_time-ness (is_recurring) cannot be
-- flipped after creation -- organizer archives and creates a new task
-- instead; this bounds validation complexity and matches "do not build a
-- complex project-management system."

create or replace function public.update_task(
  p_task_id uuid,
  p_title text,
  p_notes text,
  p_frequency text,
  p_days_of_week integer[],
  p_due_date date,
  p_recurrence_end_date date
)
returns public.tasks
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_caregiver_id uuid := auth.uid();
  v_task public.tasks%rowtype;
  v_connection public.connections%rowtype;
  v_schedule_changed boolean;
  v_result public.tasks%rowtype;
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

  v_schedule_changed :=
    v_task.frequency <> p_frequency
    or coalesce(v_task.due_date, '0001-01-01'::date) <> coalesce(p_due_date, '0001-01-01'::date)
    or coalesce(v_task.recurrence_end_date, '0001-01-01'::date) <> coalesce(p_recurrence_end_date, '0001-01-01'::date)
    or (select array_agg(d order by d) from unnest(v_task.days_of_week) d)
       is distinct from (select array_agg(d order by d) from unnest(p_days_of_week) d);

  update public.tasks
  set title = btrim(p_title),
      notes = nullif(btrim(coalesce(p_notes, '')), ''),
      frequency = p_frequency,
      days_of_week = case when p_frequency = 'one_time' then '{}'::integer[] else p_days_of_week end,
      due_date = p_due_date,
      recurrence_end_date = p_recurrence_end_date,
      schedule_version = case when v_schedule_changed then schedule_version + 1 else schedule_version end,
      updated_at = now()
  where id = p_task_id
  returning * into v_result;

  -- No delivery-row reconciliation is needed here (unlike update_reminder_
  -- schedule): non-terminal task occurrences are never materialized, so
  -- there is nothing stale to requeue or delete. Historical task_occurrences
  -- rows are never touched by this function.
  return v_result;
end;
$$;

revoke all on function public.update_task(uuid, text, text, text, integer[], date, date) from public, anon;
grant execute on function public.update_task(uuid, text, text, text, integer[], date, date) to authenticated;

-- ═══ 6. archive_task ═════════════════════════════════════════════════════

create or replace function public.archive_task(p_task_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_task public.tasks%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication_required';
  end if;

  select * into v_task from public.tasks where id = p_task_id for update;
  if not found or v_task.caregiver_id <> auth.uid() then
    raise exception 'not_authorized';
  end if;

  -- Idempotent, mirroring end_connection: archiving an already-archived
  -- task is a harmless no-op success.
  if not v_task.is_active then
    return;
  end if;

  update public.tasks set is_active = false, updated_at = now() where id = p_task_id;

  -- Historical task_occurrences are never touched. A still-pending
  -- assignment notification is left as-is; send-task-assignment-
  -- notifications re-validates task.is_active immediately before sending
  -- and will mark it failed/task_inactive rather than send it.
end;
$$;

revoke all on function public.archive_task(uuid) from public, anon;
grant execute on function public.archive_task(uuid) to authenticated;

-- ═══ 7. respond_to_task_occurrence ═══════════════════════════════════════

create or replace function public.respond_to_task_occurrence(
  p_task_id uuid,
  p_occurrence_date date,
  p_status text
)
returns public.task_occurrences
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
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
  else
    if p_occurrence_date < v_task.start_date
       or (v_task.recurrence_end_date is not null and p_occurrence_date > v_task.recurrence_end_date)
       or not (extract(isodow from p_occurrence_date)::int = any(v_task.days_of_week)) then
      raise exception 'occurrence_ineligible';
    end if;
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
    p_occurrence_date, v_effective_due_date, v_stored_status, v_completed_at, v_skipped_at, v_task.schedule_version
  )
  returning * into v_result;

  return v_result;
end;
$$;

comment on function public.respond_to_task_occurrence(uuid, date, text) is
  'Participant-only. Server-authoritative completion time and on-time/late classification -- the client never sends either. Idempotent on a repeated identical response; a conflicting terminal response (e.g. completed after already skipped) raises already_answered.';

revoke all on function public.respond_to_task_occurrence(uuid, date, text) from public, anon;
grant execute on function public.respond_to_task_occurrence(uuid, date, text) to authenticated;

-- ═══ 8. task_analytics_summary ═══════════════════════════════════════════
--
-- Mirrors notification_delivery_health_summary's (metric, value) shape.
-- Eligible dates are enumerated via generate_series bounded to p_days back
-- from today (participant-local) -- never an unbounded scan, and never
-- touches dates before task.start_date.

create or replace function public.task_analytics_summary(p_connection_id uuid, p_days int default 30)
returns table (metric text, value numeric)
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
stable
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
    -- Recurring tasks: every eligible calendar date in [max(start_date, window_start), min(today, recurrence_end_date)].
    select t.id as task_id, gs.d as due_date, gs.d as occurrence_date, t.schedule_version
    from public.tasks t
    cross join lateral generate_series(
      greatest(t.start_date, v_window_start),
      least(v_today, coalesce(t.recurrence_end_date, v_today)),
      interval '1 day'
    ) as gs(d)
    where t.connection_id = p_connection_id
      and t.frequency <> 'one_time'
      and extract(isodow from gs.d)::int = any(t.days_of_week)
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

comment on function public.task_analytics_summary(uuid, int) is
  'Read-only. Denominators: completion_rate = completed / (completed + skipped + currently_overdue) -- future/upcoming and no-due-date-still-open occurrences never enter it. on_time_rate = completed_on_time / completed occurrences that had a due date (recurring occurrences always have one; no-due-date one-time completions are excluded). See docs/task-analytics-model.md.';

revoke all on function public.task_analytics_summary(uuid, int) from public, anon;
grant execute on function public.task_analytics_summary(uuid, int) to authenticated;

-- ═══ 9. Assignment-notification cron wiring ══════════════════════════════
--
-- Reuses the existing CRON_SECRET Edge Function secret and the existing
-- recipient_push_cron_secret vault entry -- no new secret is minted. Every-
-- minute cadence (not 30s): assignment is not exact-time-critical the way a
-- timed reminder is, and matches the existing send-caregiver-push-
-- notifications job's cadence/syntax (pg_cron's seconds-based schedule
-- syntax only accepts 1-59; 60 must be expressed as standard '* * * * *').

create or replace function public.trigger_send_task_assignment_notifications()
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  secret text;
begin
  select decrypted_secret into secret
  from vault.decrypted_secrets
  where name = 'recipient_push_cron_secret';

  if secret is null then
    raise warning 'recipient_push_cron_secret not set in vault; skipping send-task-assignment-notifications invocation';
    return;
  end if;

  perform net.http_post(
    url := 'https://ofpzbifonihfutghbjbw.supabase.co/functions/v1/send-task-assignment-notifications',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
end;
$$;

select cron.schedule('send-task-assignment-notifications', '* * * * *',
  $$select public.trigger_send_task_assignment_notifications();$$);

revoke all on function public.trigger_send_task_assignment_notifications() from public, anon, authenticated;
grant execute on function public.trigger_send_task_assignment_notifications() to service_role;

-- ═══ 10. Ops-health: task delivery metrics (distinct from reminder metrics) ═

create or replace function public.task_notification_health_summary(p_window_hours int default 24)
returns table (metric text, value numeric)
language sql
security definer
set search_path = public, extensions, pg_catalog
stable
as $$
  with window_deliveries as (
    select * from public.task_notification_deliveries
    where created_at >= now() - make_interval(hours => greatest(p_window_hours, 1))
  )
  select 'due_in_window'::text, count(*)::numeric from window_deliveries
  union all
  select 'sent', count(*) from window_deliveries where status = 'sent'
  union all
  select 'failed_token_absence', count(*) from window_deliveries
    where status = 'failed' and error_code in ('no_active_push_token', 'device_not_registered')
  union all
  select 'failed_other', count(*) from window_deliveries
    where status = 'failed' and (error_code is null or error_code not in ('no_active_push_token', 'device_not_registered'))
  union all
  select 'pending', count(*) from window_deliveries where status = 'pending'
  union all
  select 'stuck_pending', count(*) from public.task_notification_deliveries
    where status = 'pending' and updated_at < now() - interval '5 minutes';
$$;

comment on function public.task_notification_health_summary(int) is
  'Read-only operational summary of task-assignment push delivery, kept structurally separate from notification_delivery_health_summary (timed reminders) so the two never blend into one misleading combined metric. service_role/postgres only.';

revoke all on function public.task_notification_health_summary(int) from public, anon, authenticated;
grant execute on function public.task_notification_health_summary(int) to service_role;

-- ═══ Rollback ═════════════════════════════════════════════════════════════
-- select cron.unschedule('send-task-assignment-notifications');
-- drop function if exists public.task_notification_health_summary(int);
-- drop function if exists public.trigger_send_task_assignment_notifications();
-- drop function if exists public.task_analytics_summary(uuid, int);
-- drop function if exists public.respond_to_task_occurrence(uuid, date, text);
-- drop function if exists public.archive_task(uuid);
-- drop function if exists public.update_task(uuid, text, text, text, integer[], date, date);
-- drop function if exists public.create_task(uuid, text, text, text, integer[], date, date, date);
-- drop table if exists public.task_notification_deliveries;
-- drop table if exists public.task_occurrences;
-- drop table if exists public.tasks;
-- No existing table/column is altered or dropped by this migration -- the
-- rollback above is fully additive-reversal, with zero risk to reminders,
-- connections, profiles, or any other existing data.
