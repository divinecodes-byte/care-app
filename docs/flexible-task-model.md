# Flexible Task Model

Week 3 product-expansion task #1. Introduces **Flexible Task** as a second
accountability object alongside the existing **Timed Reminder**, without
changing timed-reminder semantics in any way.

## Reminder vs. Task

| | Timed Reminder | Flexible Task |
|---|---|---|
| Exact clock time | Yes (`time_of_day`) | Never |
| Response window | Yes (`no_response_minutes`) | No such concept |
| Snooze | Yes | Never |
| Unanswered-past-due state | `missed` (terminal, cron-written) | `overdue` (non-terminal, always actionable) |
| Late completion | Not representable | `completed_late` (still valid) |
| Occurrence materialization | Response or missed-cron | Response only — never a cron |

Both share: participant-authoritative timezone, `connections`/`profiles`,
RLS conventions, push-token infrastructure, design tokens, StateViews,
accessibility primitives, and localization. "Task" is the only word used in
generic UI; internal tables/columns keep the existing `caregiver_id`/
`recipient_id` convention (see `docs/product-terminology.md`).

## Architecture decision (Phase 2)

**Option B — dedicated tables** (`tasks`, `task_occurrences`), not an
extension of `reminders`.

Why: `reminders.time_of_day` and `no_response_minutes` are `NOT NULL` with
product-meaningful defaults. Reusing that table for a timeless object would
require either nullable exact-time columns (weakening a currently-enforced
invariant for every existing reminder) or a fake sentinel time — both
explicitly disallowed. The delivery/missed/snooze pipeline
(`claim_due_recipient_reminder_deliveries`, `sync_missed_reminders_db`,
`validate_reminder_deliveries_for_send`) is built entirely around an exact
instant; a task has no instant to compute. A dedicated schema keeps both
lifecycles independently correct, keeps analytics unambiguous, and avoids
any risk to the existing reminder pipeline.

## Schema

`supabase/migrations/20260728000000_flexible_tasks.sql`,
`20260728010000_tasks_connection_and_deletion_lifecycle.sql`.

**`tasks`** — identity + schedule config. `frequency` is
`'one_time' | 'daily' | 'weekdays' | 'weekends' | 'custom'`; `is_recurring`
is a **generated column** (`frequency <> 'one_time'`) — one source of truth,
no cross-field drift possible. `days_of_week` stores the resolved concrete
set (mirrors `reminders`, empty for `one_time`). `start_date` is immutable
after creation. `due_date` is one-time-only (enforced by
`tasks_due_date_one_time_only_check`); a recurring task's implicit deadline
is always its own `occurrence_date` (see below), never a separate column.
`recurrence_end_date` is recurring-only, optional. `schedule_version` bumps
on any future-affecting edit.

**`task_occurrences`** — **only ever contains a row for a terminal
response** (`completed_on_time | completed_late | skipped`). There is no
row for upcoming/open/overdue — those are always computed, never stored
(see "Occurrence strategy" below). Full-row immutability is enforced by a
trigger (`prevent_task_occurrence_mutation`) that rejects *any* `UPDATE` —
stronger than `reminder_logs`' identity-only guard, since no RPC ever needs
to update an existing occurrence row (the idempotent-retry path in
`respond_to_task_occurrence` returns the existing row unchanged). Unique
`(task_id, occurrence_date)` is the structural guarantee against duplicate
occurrences.

**`task_notification_deliveries`** — a separate ledger from
`reminder_notification_deliveries` (see
`docs/task-notification-contract.md`), `unique(task_id)` — structurally at
most one assignment push per task, ever.

RLS: `SELECT` only for `authenticated` (caregiver or recipient of the row).
No `INSERT`/`UPDATE` policy exists and the corresponding table grants are
revoked — every mutation goes through a `SECURITY DEFINER` RPC. This is
**stricter** than `reminders` (which allows a direct RLS-gated client
`INSERT`), chosen deliberately per Phase 4's "server-authoritative task
operations" requirement.

## Occurrence strategy (Phase 6, revised Week 4 Task #3)

**Computed dynamically, persisted only on interaction.** A task occurrence
becomes a real database row *only* when a participant completes or skips
it. Upcoming/open/overdue are pure functions of
`(schedule config, today-in-participant-timezone, whether a terminal row
exists for that date)`. This mirrors how `reminders` already treats
"pending" (no `reminder_logs` row = pending) — the one difference is
reminders eventually freeze an unanswered occurrence as `missed` via a
5-minute cron; **tasks have no such cron at all**, because overdue is never
terminal. This is what makes "flexible tasks do not automatically become
Missed at midnight" true by construction, not by a special case.

**This computation is now entirely server-authoritative, with no arbitrary
day-window bound anywhere in the authoritative path** — see
`docs/task-overdue-occurrence-model.md`, `docs/task-overdue-pagination.md`,
and `docs/task-schedule-versioning.md` for the full model. In short:

- `lib/taskLifecycle.ts#enumerateBegunOccurrenceDates` (client, pure) is
  bounded only by the task's own `start_date` — the old
  `TASK_LOOKBACK_DAYS = 60` constant that previously floored the range at
  `today - 60 days` has been removed entirely. This function is a
  non-authoritative reference implementation only (no production screen
  calls it); every production surface instead calls a server RPC.
- `get_participant_task_summaries()` / `get_connection_task_summaries()`
  return one bounded row per active task, with an exact `overdue_count`
  computed via closed-form modular-arithmetic weekday counting (no
  `generate_series`, no per-day scan — cost is O(schedule segments), not
  O(days), so a five-year-old daily task costs the same as a five-day-old
  one).
- `get_participant_overdue_task_occurrences()` is a cursor-paginated RPC
  returning the complete, exact overdue history, one bounded page at a
  time — a participant's full backlog is never fetched in one response,
  and no unresolved occurrence disappears merely for being old.
- `task_analytics_summary`'s caller-supplied `p_days` window (default 30)
  is unrelated and untouched by this change — see
  `docs/task-analytics-model.md`.

## Lifecycle states

One-time: `upcoming → open → overdue` (if `due_date` passed) `→
completed_on_time | completed_late | skipped`. A one-time task with no
`due_date` goes `upcoming → open →` (stays `open` forever until resolved or
archived — never overdue).

Recurring: each eligible date is independently `open`/`overdue` (implicit
due date = its own date) until it gets its own terminal row. Two occurrences
of the same task never share state — completing today's occurrence never
touches yesterday's still-overdue one. **Completing a past/overdue
occurrence today is always classified `completed_late`** — "on time" for a
recurring occurrence is only possible by responding to *that day's*
occurrence on that same calendar day. This is intentional, not a bug: "late"
for a daily task means exactly "I didn't do it that day."

Archived (`is_active = false`): no new occurrences become actionable
(`respond_to_task_occurrence` raises `task_inactive`); all historical
`task_occurrences` rows remain exactly as they were.

## Recurrence model (Phase 6)

Launch-supported: one time, daily, weekdays, weekends, and selected weekdays
(`custom`, an arbitrary `days_of_week` subset — a single selected day
covers the spec's "weekly" case without inventing a redundant enum value).
`days_of_week`/`isTaskOccurrenceEligible` reuse the exact same day-of-week
semantics as reminders (`extract(isodow ...)`, 1=Monday..7=Sunday). Because
eligibility is pure calendar-date arithmetic (`date` columns, never a
`timestamptz` conversion), **daylight-saving transitions cannot shift an
eligible date** — there is no wall-clock-to-instant conversion in the
eligibility path to be DST-sensitive in the first place (verified directly
in `scripts/task-audit/run.ts` scenario AB against the 2026-03-08 US
spring-forward date).

## Participant-timezone authority

`respond_to_task_occurrence` computes "today" as
`(now() at time zone profiles.timezone)::date` for the **recipient**,
exactly like `respond_to_reminder_occurrence`. All date-range/eligibility
math, both client (`lib/taskLifecycle.ts`, `lib/zonedTime.ts`) and server,
is anchored to the recipient's stored timezone — never the viewing device's
clock for a caregiver looking at someone else's tasks.

## On-time vs. late (authoritative, server-computed)

`respond_to_task_occurrence` never trusts a client-supplied timestamp or
classification. It computes `v_today` fresh from `now()` at response time,
compares it to the occurrence's effective due date
(`task.due_date` for one-time, `occurrence_date` itself for recurring), and
stores `completed_on_time` or `completed_late` accordingly. A `null`
effective due date always yields `completed_on_time` (there was no deadline
to miss).

## Edit/version behavior (Phase 8)

`update_task` never touches `task_occurrences` — there is nothing to
reconcile, since non-terminal occurrences were never materialized in the
first place (a real simplification versus `update_reminder_schedule`, which
must requeue-in-place a claimed-but-unsent delivery row). `schedule_version`
bumps only when a future-affecting field changes (frequency/days/due
date/recurrence end date); title/notes edits don't bump it.
`start_date` and the recurring/one-time type itself are immutable after
creation — archiving and recreating covers that rare case, keeping
validation bounded.

## Archive / connection-ending / account deletion

- **Archive** (`archive_task`): idempotent, sets `is_active = false`. No
  historical row is touched.
- **Ending a connection** (`end_connection`, updated in this task): now
  deactivates `tasks` tied to that connection exactly like it already
  deactivates `reminders` — found and fixed during Phase 18/19 planning
  (the original function only handled reminders).
- **Account deletion** (`delete_current_user_data`, updated in this task):
  same treatment — deactivates the account's tasks, deletes any
  pending/failed `task_notification_deliveries`, and otherwise follows the
  existing anonymization model unchanged (profile scrubbed, connections
  ended, history preserved).

## Known limitations

- No monthly/custom-interval recurrence (explicitly out of scope).
- No local notification fallback if `server_push_enabled` is off — matches
  reminders' existing server-authoritative-only design for recipient push.
- The prior 60-day overdue-occurrence lookback limitation was removed in
  Week 4 Task #3 — see `docs/task-overdue-occurrence-model.md`. The
  card-level summary RPCs' `actionable_date` quick-tap field originally
  used a fixed 180-day backward window as a bounded-search shortcut; this
  was found to occasionally target the *wrong* (more recent) occurrence
  rather than the true earliest unresolved one, and was replaced with an
  exact O(log days) binary search (`_task_earliest_unresolved_date`) — see
  `docs/task-overdue-occurrence-model.md`. No arbitrary day bound remains
  anywhere in the overdue-occurrence path.

## Weekend QA checklist

1. Create a one-time task with a due date; complete it after the due date
   passes — confirm `completed_late`.
2. Create a daily task; skip today, then complete it the next day — confirm
   yesterday's occurrence stays `skipped` and today's is independently
   `open`/actionable.
3. Archive a task with an unresolved overdue occurrence — confirm the
   participant can no longer act on it, and its history (if any) is intact
   in Task Details.
4. End a connection with an active recurring task — confirm no further
   occurrences become actionable, and past history remains visible to the
   organizer.
5. Confirm the assignment push arrives once per task, never repeats while
   overdue.

## Rollback

Both migrations are purely additive (new tables/functions, or `create or
replace function` on `end_connection`/`delete_current_user_data`, restoring
their bodies to the pre-task versions in the migrations named in each
file's own rollback comment). No existing table, column, or reminder
behavior is altered.
