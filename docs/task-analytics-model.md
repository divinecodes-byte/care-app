# Task Analytics Model

Flexible-task analytics are computed entirely separately from timed-reminder
adherence (`docs/reminder-analytics-model.md`) — no shared query, no shared
denominator, no combined metric anywhere unless explicitly and clearly
labeled as such (none exists today).

## Server function

`public.task_analytics_summary(p_connection_id uuid, p_days int default 30)`
— `SECURITY DEFINER`, callable only by the caregiver or recipient of
`p_connection_id` (raises `not_authorized` otherwise — enforces the same
selected-participant scoping the client already applies). Returns
`(metric text, value numeric)` rows, mirroring
`notification_delivery_health_summary`'s shape.

## Metrics

| metric | meaning |
|---|---|
| `tasks_due` | total eligible occurrences in the window (one-time tasks whose `start_date` falls in range, plus every eligible calendar date for recurring tasks) |
| `completed` | `completed_on_time + completed_late` |
| `completed_on_time` | completed occurrences where the response landed on or before the effective due date |
| `completed_late` | completed occurrences where the response landed after the effective due date |
| `skipped` | explicitly skipped occurrences |
| `currently_overdue` | eligible occurrences with a due date in the past and **no** terminal response yet |
| `completion_rate` | see below |
| `on_time_rate` | see below |

## Denominators (exact)

**`completion_rate`** =
`completed / (completed + skipped + currently_overdue)`.

Only occurrences that have *reached a terminal state or become overdue*
enter the denominator. A no-due-date task that is still open, or any
occurrence that hasn't started yet (`upcoming`), **never** enters this
denominator — it would be meaningless to count "not yet due" against
completion. `null` when the denominator is 0 (no terminal-or-overdue
occurrences exist yet for the window).

**`on_time_rate`** =
`completed_on_time / (completed occurrences that had a due date)`.

A completed occurrence with no due date (a no-due-date one-time task) is
excluded from *both* the numerator and denominator — it was never possible
for it to be "on time" or "late" in the first place, so folding it in
either direction would distort the rate. Recurring occurrences always have
an implicit due date (their own `occurrence_date`), so every recurring
completion always participates in this rate. `null` when the denominator is
0.

## Why these specific rules (worked example)

A daily task started 3 days ago, with `today`, `today-1`, `today-2` days
of week eligible, `today-3` also eligible:

- `today` completed the same day → `completed_on_time`.
- `today-1` completed today (i.e., a day late) → `completed_late`.
- `today-2` skipped → `skipped`.
- `today-3` left unanswered → `currently_overdue`.

`tasks_due = 4`, `completed = 2`, `completion_rate = 2 / (2+1+1) = 0.5`,
`on_time_rate = 1 / 2 = 0.5` (both completions had a due date — their own
occurrence date). Verified exactly this way in
`scripts/task-audit/run.ts` scenarios AE/AF.

## Participant-timezone determination

The window (`p_days` back from "today") and every occurrence date are
computed in the **recipient's** stored `profiles.timezone` — never the
caregiver's viewing device. Consistent with every other date-range
computation in this feature (see `docs/flexible-task-model.md`).

## Scoping rules

- Selected-participant scoping is strict: `task_analytics_summary` takes
  exactly one `connection_id` and only returns that connection's data
  (verified in scenario AC: two participants under one organizer never
  cross-contaminate).
- Ended-connection history is not mixed into an organizer's active-view
  analytics unless the organizer explicitly opens that ended connection's
  task list (the same connection-scoped call still works for historical
  reads — nothing is deleted, see `docs/flexible-task-model.md`).
- Archived-task occurrences that already resolved (completed/skipped)
  before archiving still count in past window calculations (their history
  is real and immutable); a task archived *before* ever becoming eligible
  contributes nothing, since it never had eligible dates to enumerate.

## Client rendering

`app/tasks.tsx` renders `completion_rate`/`on_time_rate` as percentages with
an accessible combined label (screen-reader announces the full sentence,
not just two isolated numbers) — see the `accessibilityLabel` built in that
screen's analytics card. A failure to load analytics never hides or blocks
the task list itself (independent failure modes, matching
`docs/ui-state-model.md`'s partial-failure convention already used for
reminder analytics).
