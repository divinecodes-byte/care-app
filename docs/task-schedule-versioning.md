# Task schedule versioning

Week 4 launch-hardening task #3. `public.task_schedule_versions` — the
minimal history table required to correctly resolve *historical* recurring-
task eligibility after a schedule edit. Companion to
`docs/task-overdue-occurrence-model.md`.

## The bug this fixes

Before this table existed, `tasks.schedule_version` was a bare incrementing
integer with **no stored history of what the schedule *was*** before an
edit. Both `respond_to_task_occurrence` and `task_analytics_summary`
evaluated *any* historical date's eligibility against the **current**
`tasks` row only. Concretely: if an organizer changed a daily task to
weekdays-only today, a genuinely-was-eligible unresolved Saturday from
three weeks ago would be wrongly rejected (`occurrence_ineligible`) if the
participant tried to (late-)respond to it — and, conversely, a date that
was *never* eligible under any schedule that actually existed on that date
could be wrongly accepted if the current schedule happened to cover that
day-of-week. This was a genuine, reproducible correctness defect, not
hypothetical (verified directly before this migration was written).

## Schema

```sql
create table public.task_schedule_versions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  schedule_version int not null,
  frequency text not null check (frequency <> 'one_time'),
  days_of_week integer[] not null check (cardinality(days_of_week) between 1 and 7 and days_of_week <@ array[1,2,3,4,5,6,7]),
  recurrence_end_date date,
  effective_from_local_date date not null,
  effective_until_local_date date,          -- null = currently open
  unique (task_id, schedule_version),
  check (effective_until_local_date is null or effective_until_local_date >= effective_from_local_date)
);
```

**Deliberately scoped to recurring tasks only** (`frequency <> 'one_time'`
check). One-time tasks are excluded entirely:

- A one-time task has exactly one occurrence identity (`start_date`,
  immutable — `update_task` has no `p_start_date` parameter at all, so no
  segment could ever need to represent a `start_date` change).
- `due_date` is deliberately **not versioned** — the *current* due date
  always governs "overdue" for a one-time task (extending a due date
  un-overdues it; this is the least-surprising choice, matching how
  `respond_to_task_occurrence` already treated one-time tasks before this
  migration). Versioning it would add a second, harder-to-reason-about
  history dimension for no correctness benefit, since a one-time task has
  no recurring-eligibility question to answer in the first place.

## Segment boundary rule

The boundary is always the **recipient's participant-local `today`** at
edit time: the old open segment closes at `today - 1`, a new one opens at
`today` — contiguous by construction, never a gap, verified by a dedicated
audit assertion (`scripts/task-overdue-audit/run.ts` scenario AN) rather
than assumed. `update_task` gained a recipient-timezone lookup it didn't
have before (it previously had no date dependency at all) specifically to
compute this boundary correctly.

### Same-day re-edit safety

**Corrected rule** (a first draft of this logic was rejected during
planning for being unsafe): an open segment may be overwritten *in place*
— rather than closed-and-reopened — **only when it has never governed a
persisted response and has never been open across a past day**:

```
if (a task_occurrences row already exists for any date >= this segment's
    effective_from) or (effective_from < today):
    close the segment at today - 1 (or at today, if effective_from was
    already >= today but a same-day response already locked it in)
    open a new segment at today
else:
    -- effective_from >= today AND nothing has ever been recorded against
    -- it -- safe to overwrite in place, no historical meaning to corrupt
    overwrite this segment's rules in place
```

Why the naive "always overwrite if `effective_from >= today`" version was
unsafe: if today's occurrence had *already* been completed/skipped before
a same-day edit, that response's stored `schedule_version` refers to this
exact segment — mutating the segment's rules in place after the fact would
silently change what that already-recorded response's schedule version
*means*, corrupting its historical meaning. The corrected rule detects
this (`v_has_recorded_occurrence`) and closes-and-reopens instead, so a
completed occurrence's segment reference is permanently frozen the moment
anything has been recorded against it. Verified directly: create a task
today → complete today's occurrence → edit the schedule later the same
day → confirm the completed occurrence still resolves to its original,
unchanged segment, and the new rule only applies starting tomorrow.

## Database-enforced integrity (not just RPC convention)

- **No overlapping ranges**: a `BEFORE INSERT OR UPDATE` trigger
  (`prevent_task_schedule_version_overlap`) rejects any new/changed segment
  whose `daterange` intersects another segment for the same task. Uses
  Postgres's built-in `daterange`/`&&` — no extension required.
- **Immutable once closed**: a `BEFORE UPDATE` trigger
  (`prevent_task_schedule_version_history_mutation`) rejects any `UPDATE`
  where `OLD.effective_until_local_date is not null`. **Deliberately
  UPDATE-only, not DELETE** — matching `task_occurrences`'s own equivalent
  trigger (`trg_prevent_task_occurrence_mutation`) exactly. An earlier
  version of this trigger blocked DELETE too, which (a) is stricter than
  the actual intent ("content is immutable" does not mean "the row can
  never be removed as part of normal lifecycle") and (b) broke ordinary
  test/administrative cleanup, since Postgres fires a child table's own
  row-level triggers even for a cascade-driven delete from its parent
  `tasks` row. Caught and fixed via live audit testing before this
  document was written.
- **At most one open segment per task**: partial unique index on
  `task_id where effective_until_local_date is null`.
- **Valid weekday domain**: `CHECK` constraint mirrors the existing
  `create_task`/`update_task` runtime validation, for defense in depth.

## Shared eligibility helpers (single source of truth)

```sql
_task_eligible_dates(p_task_id, p_range_start, p_range_end)
  returns table(occurrence_date date, schedule_version int)

_task_occurrence_schedule_version(p_task_id, p_date)
  returns int   -- literally delegates to _task_eligible_dates(task_id, date, date)
```

Every range-based caller (`task_analytics_summary`, the summary RPCs,
`get_participant_overdue_task_occurrences`) calls
`_task_eligible_dates()`. `respond_to_task_occurrence`'s single-date check
calls `_task_occurrence_schedule_version()`, which is a thin wrapper
around the *same* function — there is no second, independently-maintained
eligibility implementation anywhere server-side. Internal helpers only,
granted to nobody beyond their owning role (never `authenticated`) — a
grant-scope error here was caught and fixed via direct live grant
verification before this document was written, matching this codebase's
established "internal helpers are never directly client-callable"
convention.

## Backfill and its honest limitation

One open segment per existing recurring task, `effective_from = start_date`
— this **exactly reproduces the pre-migration (schedule-blind) behavior**
for tasks that already existed, which is a strict non-regression, **not**
a reconstruction of real historical edits. Pre-migration edit history is
genuinely unrecoverable — the old rules were never stored anywhere. (In
practice this backfill was a no-op: production had zero `tasks`/
`task_occurrences` rows at migration time, confirmed via direct query
before writing the migration.)

## `task_occurrences` integrity

A `task_occurrences` row's stamped `schedule_version` must resolve to a
retained segment. A **plain foreign key is not compatible** here (a
one-time task's occurrence has a `schedule_version` with no corresponding
segment row at all, by design) — a `CONSTRAINT TRIGGER`
(`check_task_occurrence_schedule_version`) enforces the equivalent
integrity check, scoped to recurring tasks only, immediately validated
(safe given zero pre-existing rows).

## Rollback

`20260801050000`, `20260801060000`, and `20260801100000` each carry exact
rollback SQL in their own trailing comments — restoring `_create_task_core`/
`update_task`/`respond_to_task_occurrence`/`task_analytics_summary`'s prior
bodies and dropping the new table/triggers/functions.
