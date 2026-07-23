# Tavora reminder analytics model

The single shared definition of adherence/analytics numbers across the
caregiver dashboard's daily/monthly views and the reminder-detail screen's
week/month stats. Before this task, this logic was implemented twice
(`caregiver-dashboard.tsx` and `reminder-details.tsx`) with a real
divergence between the copies — see "History" below. Both screens now call
the same functions from `lib/reminderStatus.ts`.

## Eligible occurrence denominator

An occurrence counts toward analytics for a given calendar date only if
**all** of the following hold:

1. **Scheduled that day**: `date`'s ISO weekday is in `reminder.days_of_week`.
2. **On or after the analytics start boundary**:
   ```
   start = max(reminder.created_at, connection.accepted_at)
   ```
   bumped to the next calendar day if that moment fell after that day's
   own scheduled `time_of_day` (a reminder/connection that only became
   eligible after today's scheduled window already passed is not
   backfilled as missed for today — its first real occurrence is
   tomorrow). This is `getAnalyticsStartDate()` in `lib/reminderStatus.ts`,
   and the same boundary `respond_to_reminder_occurrence` enforces
   server-side for response eligibility — one definition, two call sites.
3. **Not in the future**: analytics only ever look at `date <= today`
   (today's own not-yet-resolved occurrence is excluded from
   week/month totals it would otherwise skew).
4. **Active, or has a real historical log**: an active reminder is
   eligible on every date satisfying 1-3. An *inactive* (deactivated)
   reminder is eligible on a given date **only if a real `reminder_logs`
   row already exists for that date** — never based on comparing the date
   to the reminder's `updated_at`/deactivation timestamp. This is
   `isReminderEligibleOnDate()`'s `hasLogOnDate` parameter.

### History: the bug this consolidation fixed

Before this task, `reminder-details.tsx` had its own copy of this function
that excluded any date *after* the reminder's `updated_at` timestamp for
an inactive reminder — instead of checking for a real log. This was wrong
two ways: it could **hide** a genuine log that happened to land on the
same day as (but before) deactivation, and — more importantly — it could
still let `getComputedStatus` display a *computed* (non-logged) `missed`
status for the deactivation day itself, directly contradicting the
documented intended rule (stated in `caregiver-dashboard.tsx`'s own
comment, which had the correct implementation): a deactivated reminder
must never surface a virtual/computed status, not even on the day it was
deactivated — only a real log ever shows. Fixed by consolidating both
screens onto the `hasLogOnDate`-based rule.

## Status computation

For an eligible occurrence: `getComputedStatus(reminder, dateString,
todayString, log)`:
- A real log exists → its `status`, always (a persisted result is never
  second-guessed by a client-side recomputation).
- No log, date is in the future → `pending`.
- No log, date is today or past, still inside `time_of_day +
  no_response_minutes` → `pending`.
- No log, that window has passed → `missed` (**display-only** — see
  `docs/reminder-state-model.md`'s "Missed-detection authority"; this
  function never writes anything).

## Numerator / denominator by metric

| Metric | Denominator | Numerator |
|---|---|---|
| **Adherence %** (caregiver dashboard day view, reminder-details week/month) | "countable" occurrences — eligible occurrences whose computed/logged status is *not* `pending` (i.e., already resolved one way or another: taken, skipped, snoozed, or missed) | occurrences with status `taken` |
| **Missed count** | — | eligible occurrences with status `missed` |
| **Skipped count** | — | eligible occurrences with status `skipped` |
| **Snoozed count** | — | eligible occurrences with status `snoozed` (an unresolved snooze still in its window counts as `pending`, not `snoozed`, until/unless the snooze deadline itself passes and the server marks it `missed`, or the recipient resolves it) |
| **Pending count** | — | eligible occurrences with status `pending` |

`adherence = countable === 0 ? null-or-0 (screen-specific) :
round(taken / countable * 100)`. A day/period with zero countable
occurrences never divides by zero — both screens special-case it (the
caregiver dashboard's day view returns `0`; range/period aggregates return
`null` to distinguish "no data" from "0% adherence," which the UI renders
as a neutral/empty state rather than a red 0%). This distinction is
deliberate and preserved as-is by this task, not changed.

**Snoozed and skipped are excluded from the adherence numerator** — only
`taken` counts as "done." This was the existing, unchanged intended
behavior confirmed by both screens agreeing on it before this task; not a
decision made in this task.

## Boundaries

- **Reminder-created boundary**: no occurrence before `reminder.created_at`
  (adjusted for same-day-after-scheduled-time, see above) ever counts,
  anywhere — not in eligibility, not in the response RPC, not in the
  delivery claim functions. One shared definition
  (`getAnalyticsStartDate`), three enforcement points (client analytics,
  `respond_to_reminder_occurrence`, the two delivery-claim SQL functions —
  the SQL side computes the equivalent boundary inline as `greatest(r.created_at,
  c.accepted_at)` rather than calling the TS helper, since it's a
  different runtime, but the definition is identical).
- **Connection-accepted boundary**: same treatment, using
  `connection.accepted_at`.
- **Future-date exclusion**: enforced at two independent layers —
  `getComputedStatus` never returns anything but `pending` for a future
  date, and every screen's own date-iteration loop skips
  `dateString > todayString` before even calling into the shared helpers.
- **Timezone**: analytics boundaries and status computation run on the
  *client's device clock* (see `docs/reminder-state-model.md`'s residual
  risk section) — the *persisted* data being aggregated
  (`reminder_logs.status`) is always timezone-correct (computed
  server-side in the recipient's stored timezone), so the numbers
  themselves are correct; only the client's own "is today's occurrence
  inside its response window yet" instant-display judgment can be
  briefly off if device and profile timezone disagree.
- **Reminders that change schedule mid-period**: `days_of_week`/
  `time_of_day` changes apply going forward only — a month's analytics
  necessarily mix pre-edit and post-edit occurrences, each evaluated
  against whatever `days_of_week`/`time_of_day` is *currently* stored
  (there is no historical snapshot of past schedule values). This means a
  reminder edited mid-month to add a new day retroactively treats earlier
  dates matching the *new* schedule as eligible too, if they're on/after
  the analytics start boundary — this is accepted current behavior
  (`reminders` has no versioned schedule history), not a bug this task
  introduces or fixes.
- **Reminders with zero eligible occurrences**: `hasData: eligibleReminders.length
  > 0` on the caregiver dashboard's day view distinguishes "no reminders
  were even scheduled" from "reminders were scheduled but none have
  resolved yet" — the former shows an empty state, the latter shows 0
  countable / null adherence.

## Caregiver vs. recipient view agreement

Both dashboards read `reminder_logs` directly (never a client-computed
value) for anything already resolved, and both use the identical
`getComputedStatus`/`isReminderEligibleOnDate` functions for anything not
yet resolved — as of this task's consolidation, there is exactly one
implementation, imported by both, not two independently-maintained copies.
Where the two dashboards intentionally differ is scope, not definition:
the caregiver dashboard aggregates across all of a recipient's reminders
for a given day/month; the recipient's own dashboard shows only today's
per-reminder status (no historical adherence aggregation is currently
shown to recipients at all — this is a UI-scope difference, not a
data-definition disagreement).

## Deleted-account history

A tombstoned participant's historical `reminder_logs` rows are preserved
unchanged (`delete_current_user_data()` never touches `reminder_logs`) —
the surviving party's analytics continue to reflect real historical
adherence. The deleted party's `profiles.full_name` is scrubbed, so any
caregiver-facing display naming a deleted recipient should already be
using the existing "Deleted account" neutral-label convention established
in the account-deletion task, not a raw joined `full_name` that may now be
null.
