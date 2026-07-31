-- Week 4 Task #3, continued: fixes a real bug caught during live audit
-- testing. trg_prevent_task_schedule_version_history_mutation was declared
-- `BEFORE UPDATE OR DELETE`, which (correctly) blocks retroactively editing
-- a closed segment's rules in place, but also (incorrectly) blocked
-- deleting a closed segment row at all -- including via a normal cascading
-- delete of its parent `tasks` row (Postgres fires a child table's own
-- row-level triggers even when the delete is cascade-driven by an FK), and
-- via direct test-cleanup deletes. This matches neither the intent
-- ("history is immutable" means its CONTENT never changes, not that the
-- row can never be removed as part of normal lifecycle/cleanup) nor the
-- established precedent: task_occurrences' own equivalent trigger
-- (trg_prevent_task_occurrence_mutation) is UPDATE-only, deliberately
-- allowing DELETE. Fixed to match that exact precedent.

drop trigger trg_prevent_task_schedule_version_history_mutation on public.task_schedule_versions;

create trigger trg_prevent_task_schedule_version_history_mutation
  before update on public.task_schedule_versions
  for each row execute function public.prevent_task_schedule_version_history_mutation();

-- ═══ Rollback ═════════════════════════════════════════════════════════════
-- drop trigger trg_prevent_task_schedule_version_history_mutation on public.task_schedule_versions;
-- create trigger trg_prevent_task_schedule_version_history_mutation before update or delete on public.task_schedule_versions for each row execute function public.prevent_task_schedule_version_history_mutation();
