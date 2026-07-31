# Task overdue occurrence model

Week 4 launch-hardening task #3. Supersedes the prior, deliberately-documented
`TASK_LOOKBACK_DAYS = 60` bound (`docs/flexible-task-model.md`'s original
"Known limitations" section) with a correct, server-authoritative,
cursor-paginated model that has no arbitrary day cutoff anywhere in the
authoritative path. Every claim here is backed by a live, automated test in
`scripts/task-overdue-audit/run.ts` (letter references below).

## Why the 60-day cutoff was incorrect

`task_occurrences` never stores a row for an unresolved occurrence —
"open"/"overdue" are always *computed*, never stored (unchanged by this
task; see `docs/flexible-task-model.md`). That computation used to be
bounded to the trailing 60 days: any eligible unresolved occurrence older
than that silently stopped being enumerable, actionable, or counted, with
no error and no trace. A recurring task ignored for more than 60 days
therefore *undercounted its own history* — the participant could neither
see nor act on the backlog beyond that window, and organizer analytics
requesting a wide date range would silently miss it too. This was
originally a deliberate design choice ("a bound against unbounded backlog
growth"), but it traded correctness for a bound that didn't need to exist:
the real, non-arbitrary bound is a task's own `start_date` (a task cannot
have eligible dates before it existed) combined with genuine pagination —
neither of which requires ever discarding real, unresolved history.

## Authoritative occurrence identity

- **Recurring task**: one occurrence identity per `(task_id,
  occurrence_date)` — a real calendar date, unique via
  `task_occurrences_task_date_unique`.
- **One-time task**: exactly one occurrence identity, `(task_id,
  start_date)` — immutable (`start_date` cannot be edited after creation;
  confirmed structurally, `update_task` has no `p_start_date` parameter).
- A terminal `task_occurrences` row is authoritative and immutable
  (`trg_prevent_task_occurrence_mutation`, unchanged).
- An eligible date with no terminal row is **open** (if it's today) or
  **overdue** (if it's in the past) — never merged into one aggregate
  object; each occurrence is independently representable, always.
- Future eligible dates are **upcoming**, never actionable.
- No-deadline one-time tasks (`due_date is null`) never become overdue —
  they stay `open` indefinitely until resolved or archived (scenario H).
- Archived (`is_active = false`) or connection-ended tasks generate **no**
  actionable occurrences — this is not a new cutoff, it's the same
  `is_active` gate `respond_to_task_occurrence`/`archive_task`/
  `end_connection`/`delete_current_user_data` already used, applied
  consistently to the new overdue-enumeration surfaces (scenarios AH/AI/AJ).

## Occurrence date vs. display/sort date

For **recurring** tasks these are the same value. For **one-time** tasks
they can differ: `occurrence_date` (the fixed identity used to *respond*)
is always `start_date`; `overdue_since_date` (used for *ordering and the
"Overdue since" label*) is the task's **current** `due_date`, since editing
a due date genuinely changes when the task became late. Both are returned
explicitly by `get_participant_overdue_task_occurrences` — the client never
has to infer one from the other (scenario G, and Correction 8 of the
approved plan).

## Recurrence eligibility

Unchanged rules for which dates a schedule covers (`frequency`,
`days_of_week`, `recurrence_end_date`) — see `docs/flexible-task-model.md`.
What's new is *which schedule governs a given historical date* — see
`docs/task-schedule-versioning.md`.

## Participant-local dates, always

Every date computation (today's boundary, eligibility, `overdue_since`
ordering) is anchored to the **recipient's** stored `profiles.timezone`,
resolved server-side from `auth.uid()` — no RPC in the authoritative path
accepts a timezone parameter (confirmed by direct grep across every new/
changed migration, scenarios AO/AP). Phoenix (UTC-7, no DST) and New York
(DST-observing) both verified directly (scenarios AQ/AR) — eligibility is
pure calendar-date arithmetic, never a `timestamptz` conversion, so DST
transitions cannot shift an eligible date.

## Old-occurrence responses

A participant can complete or skip an occurrence of any age — there is no
age check anywhere in `respond_to_task_occurrence` beyond "not in the
future." Completing an old overdue occurrence is always
`completed_late` — this is unchanged, existing behavior (see
`docs/flexible-task-model.md`). Response identity is always
`(task_id, occurrence_date)`; conflicting terminal responses are rejected
(`already_answered`); identical repeat responses are idempotent (scenarios
M/N/O/P).

## Server never trusts the client

`p_status` is the only client-supplied value in `respond_to_task_occurrence`
— on-time-vs-late classification, eligibility, and the stamped schedule
version are all computed server-side from `now()` and the governing
schedule segment, never from anything the client asserts.

## Known limitations (unchanged, carried forward)

- No monthly/custom-interval recurrence (out of scope, unchanged).
- `app/task-details.tsx`'s terminal-history *display* remains a
  client-side `.slice(0, 20)` with no "load more" — a separate, smaller,
  deliberately out-of-scope limitation (browsing *resolved* history, not
  overdue/unresolved enumeration). The underlying fetch is already
  unbounded by `task_id` (cheap, one task's own history), so nothing is
  silently hidden — it's just not yet incrementally paginated.
- None remaining in the overdue-occurrence path itself. (A prior version of
  this document described a bounded-reach `actionable_date` on the
  card-level summary RPCs that searched only ~180 days back and could
  return `null` — or, in one concrete case, the *wrong*, more-recent
  occurrence instead of the true earliest unresolved one — for an older
  miss. This was found to be a real defect, not just a documented
  limitation: every quick Complete/Skip surface (`app/tasks.tsx`,
  `app/task-details.tsx`, `app/recipient-dashboard.tsx`'s Today hub) sends
  `actionable_date` straight to `respond_to_task_occurrence`, so it could
  silently act on a newer occurrence while an older unresolved one stayed
  unrepresented as "the" actionable one. Fixed by
  `public._task_earliest_unresolved_date()` — an O(log days) binary search
  using the same closed-form eligibility count already used for
  `overdue_count`, converging on the exact earliest unresolved date
  regardless of task age (verified live: a 300-day-old task with its only
  unresolved dates at day-250 and day-50 now correctly returns day-250, in
  ~5.6ms). See `docs/task-overdue-pagination.md` for detail.)

## Weekend QA checklist

1. Create a daily task with a start date 6+ months ago; confirm the
   overdue count is exact and the complete history is reachable via "View
   all overdue" (not just the last 60 days).
2. Edit a recurring task's schedule (e.g. daily → weekdays); confirm an
   old unresolved date from *before* the edit is still respondable, and a
   date *after* the edit correctly follows the new rule.
3. Complete an occurrence from many months ago via the dedicated overdue
   screen; confirm it's classified `completed_late` and disappears from
   the list immediately, with the rest of the page unchanged.
4. Archive a task with unresolved overdue occurrences; confirm they no
   longer appear anywhere, and a different organizer's tasks for the same
   participant are unaffected.
5. Confirm a no-deadline one-time task never shows an overdue badge, no
   matter how old.

## Rollback

All six new migrations
(`20260801050000`, `060000`, `070000`, `080000`, `090000`, `100000`) are additive or `create or replace` on
already-existing functions, with exact rollback SQL in each file's own
trailing comment. No existing table, column, or reminder behavior is
altered. `task_schedule_versions` and its triggers/functions can be
dropped independently of the client changes, which revert cleanly via git
revert (the client falls back to calling the removed RPCs, which would
then need reverting together).
