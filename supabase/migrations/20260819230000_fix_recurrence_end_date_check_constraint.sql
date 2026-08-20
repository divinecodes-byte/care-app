-- BLOCKER fix: build-5 physical QA -- brand-new recurring task creation
-- fails at Save with a generic client error.
--
-- ROOT CAUSE: `tasks_recurrence_end_recurring_only_check`
-- (20260728000000_flexible_tasks.sql) is inverted. As shipped:
--   check (frequency = 'one_time' or recurrence_end_date is null)
-- This literally requires recurrence_end_date to be NULL whenever
-- frequency <> 'one_time' -- i.e. it forbids a recurrence end date on every
-- RECURRING task (the one case the field exists for) and silently permits
-- one on a one-time task (which should never have one). It appears to be a
-- copy/paste of the due_date sibling constraint
-- (tasks_due_date_one_time_only_check, correctly "due_date is one-time-
-- only") without flipping the polarity for a field that is recurring-only.
--
-- Confirmed live via disposable synthetic organizer/participant
-- (anon-key RPC call, exactly as the real client calls it):
--   create_task(p_frequency := 'daily', p_start_date := '2026-08-13',
--               p_recurrence_end_date := '2026-08-15', ...)
--   -> 23514 "new row for relation \"tasks\" violates check constraint
--      \"tasks_recurrence_end_recurring_only_check\""
-- Reproduced identically for weekdays/weekends/custom with a recurrence end
-- date set; daily/weekdays/weekends/custom WITHOUT a recurrence end date,
-- and one_time (which never sends one), all succeeded. Confirmed zero
-- existing `tasks` rows violate the corrected polarity (no recurring task
-- has ever successfully carried a non-null recurrence_end_date, since this
-- bug has been live since the field's introduction), so the corrected
-- constraint is safe to add with immediate validation.
--
-- This is a schema-level defect, not something introduced by the Task #3
-- schedule-version migrations (20260801050000-20260801110000) -- creation
-- never reaches task_schedule_versions or its triggers; it fails at the
-- `tasks` INSERT itself, inside _create_task_core, before that point.
-- update_task shares the exact same constraint and was equally affected
-- for any edit that sets a recurring task's recurrence_end_date; this
-- migration fixes both call sites since neither needs its own code change.

alter table public.tasks
  drop constraint tasks_recurrence_end_recurring_only_check;

alter table public.tasks
  add constraint tasks_recurrence_end_recurring_only_check
    check (frequency <> 'one_time' or recurrence_end_date is null);

-- ═══ Rollback ═════════════════════════════════════════════════════════════
-- alter table public.tasks drop constraint tasks_recurrence_end_recurring_only_check;
-- alter table public.tasks add constraint tasks_recurrence_end_recurring_only_check check (frequency = 'one_time' or recurrence_end_date is null);
