# Today Hub Model

Week 3 product-expansion task #2. A unified participant "Today" view across
both accountability objects (Timed Reminders, Flexible Tasks), without
merging their tables, statuses, or lifecycle code.

## Source-of-truth decision

No new event table, no unified mutation RPC. `reminders`/`reminder_logs` and
`tasks`/`task_occurrences` remain fully separate; the Today hub is a
**client-side merge** of the exact same data recipient-dashboard.tsx and
`lib/taskData.ts#fetchTasksForRecipient` already fetch via RLS-gated direct
reads — no new read path was needed for a single participant's own small,
bounded "what's due now" set. (Contrast with the organizer/participant
*activity timeline*, which does need a dedicated RPC — see
`docs/activity-feed-model.md` for why pagination and cross-connection
authorization change that calculus.)

## Shared display model

`lib/todayFeedCore.ts` — pure, zero react-native import (only imports
`lib/reminderStatus.ts`, `lib/taskLifecycle.ts`, `lib/zonedTime.ts`, and
`lib/participantTodayContext.ts`, all already pure). Exports `TodayItem`,
`buildTodayItems(reminders, tasks, context)`, and the two priority buckets
`actionableTodayItems()` / `terminalTodayItems()`. `context` is a
`ParticipantTodayContext` (`lib/participantTodayContext.ts`) — see
"Participant-timezone / date-boundary behavior" below; there is no
implicit device-clock fallback anywhere in this module.

`TodayItem.displayStatus` is always the object's *own* status verbatim
(`DisplayReminderStatus` or `TaskDisplayStatus`) — never renamed or
reinterpreted. `sortGroup` is a new, purely presentational concept layered
on top; it does not become a new persisted or authoritative status.

## Today sorting (final order, with reasoning)

1. **Overdue flexible tasks** — the single highest-priority group.
2. **Actionable timed reminders** — pending (including currently-snoozed)
   reminders whose scheduled time has already passed today, sorted by
   scheduled time ascending.
3. **Tasks due today** — open tasks whose effective due date is today
   (every open *recurring* occurrence lands here by construction, since a
   recurring occurrence's implicit due date is its own occurrence date).
4. **Open tasks, not due today** — no-deadline one-time tasks, and
   one-time tasks whose due date is in the future (folded into the same
   bucket rather than a fifth priority level — both are "available, not
   urgent yet").
5. **Upcoming timed reminders** — pending reminders scheduled later today.
6. **Upcoming flexible tasks** — bounded to `TASK_UPCOMING_LOOKAHEAD_DAYS`
   (3 days) so the far future never dominates Today.
7. **Terminal-today** (collapsed secondary section) — reminders/tasks
   resolved (taken/skipped/missed/completed*/skipped) specifically *today*.
   Nothing resolved on a past day appears in Today at all.

Missed reminders are never shown as actionable (they land in group 7, not
group 2). A currently-snoozed reminder shows its live current state
(group 2) — see `docs/activity-feed-model.md` for why snooze is excluded
from the *activity timeline* but still shown here.

## Participant dashboard integration — a deliberate, documented scope decision

`app/recipient-dashboard.tsx`'s existing reminder-card rendering (loading
states, per-card Done/Later/Skip actions, offline banner, multiple
carefully-tuned empty-state branches) is large and already thoroughly
tested. Rather than rewrite it into a single fully-interleaved
item-by-item list — a much higher-risk change — this task integrates at
the **group level**:

- Overdue tasks render as a new block immediately after the header (group 1).
- The existing reminder list renders completely unchanged in its own
  established position and logic (covering groups 2 and 5 as it always
  has — reminders due now and reminders later today already appear
  together, as before).
- Due-today / open tasks render as a new block after the reminder list
  (groups 3-4).
- Upcoming tasks render next (group 6), then a collapsed "Recently
  Completed" block for tasks resolved today (group 7, tasks only —
  reminders already show their own terminal status inline on their
  existing card, which was not restructured).
- The former `TasksSummaryCard` (added in Week 3 task #1) was **removed**
  from this screen — it would now duplicate tasks already shown directly
  in the unified list. A "View Tasks" and a "My Activity" link remain at
  the bottom for the full `/tasks` and `/activity` screens.

This is an honest, bounded trade-off: true single-list interleaving of
every individual reminder against every individual task was not
implemented, in favor of zero regression risk to the reminder screen's
existing, working behavior. Documented here rather than silently narrowed.

## Actions (object-specific, unchanged)

- **Timed Reminder**: Complete/Taken, Snooze, Skip, Open details — via the
  existing `respondToReminderOccurrence`/`saveReminderAction` path.
- **Flexible Task**: Complete, Skip, Open details — via
  `respond_to_task_occurrence`. No Snooze exists for tasks.
- No organizer proxy-completion was added for either object.

## Participant-timezone / date-boundary behavior

**`profiles.timezone` is authoritative for every Today-feed calendar
decision — the device's own timezone is never authoritative, for either
role.** This was tightened in a dedicated correctness follow-up after the
original implementation used the recipient's own device clock for their
own Today view (reasoning at the time: "the recipient's own device is
expected to match their synced profile timezone"). That assumption does
not hold during the real windows the product spec calls out — travel,
manual device-clock changes, a still-in-flight `syncCurrentUserTimezone()`
call, or a temporarily-unreachable sync — and per Tavora's established
rule, the *stored* value is what's authoritative, not "whatever the device
currently reads." The gap is closed as follows:

- **`lib/participantTodayContext.ts`** (new, pure) is the single source of
  truth for "what is today, for this participant": `ParticipantTodayContext
  { timezone, localDateKey, nowInstant }`, built via
  `getParticipantTodayContext(now, timezone)`. `getNextParticipantMidnight`,
  `addParticipantCalendarDays`, and `getParticipantLocalDateKey` round out
  the module. None of it reads `process.env.TZ`, the device's resolved
  timezone, or any implicit clock beyond the `now: Date` parameter it's
  given — verified host-machine-independent in
  `scripts/activity-audit/run.ts` (scenarios TZ-A through TZ-S), including
  a check that mutating `process.env.TZ` mid-test changes nothing.
- **`lib/todayFeedCore.ts`** takes an explicit `ParticipantTodayContext`
  (not a bare date string) and uses only the *zoned* reminder-status
  helpers (`isReminderEligibleOnZonedDate`, `getZonedComputedStatus` —
  the same functions `caregiver-dashboard.tsx` already used for a
  caregiver's cross-timezone view of a *different* participant). Task
  classification (`summarizeTask`) was already pure calendar-date
  arithmetic with no clock dependency of its own — it only ever needed a
  correctly-sourced date string, which it now always gets.
  `getZonedComputedStatus` gained an optional 6th `now: Date` parameter
  (defaults to the real current instant for every pre-existing caller,
  unchanged) so its response-window check is fully deterministic when an
  explicit instant is supplied.
- **`app/recipient-dashboard.tsx`** fetches `profiles.timezone` in the
  same query as `account_status` on every load and validates it
  (`isValidIanaTimezone`). There is **no hardcoded fallback** (an earlier
  version of this fix used `'America/New_York'` — closed in the timezone-
  authority-closure follow-up below) and **never** a fallback to
  `Intl.DateTimeFormat().resolvedOptions().timeZone` (the device's own
  zone). `loadTasks()` performs the identical fetch/validate/repair
  sequence independently for its own timezone-dependent classification,
  matching this screen's existing "reminders and tasks fail independently"
  design (Phase 5).
- **Not yet loaded**: `participantTimezone` starts `null`; the task
  bucketing `useMemo` and reminder classification both defer (return empty/
  do nothing) rather than momentarily computing against any fallback —
  there is no flash of device-timezone-classified content before the real
  value arrives (scenario TZ-S).
- **Midnight rollover** (Phase 4) no longer polls: a `useEffect` keyed on
  `participantTimezone` computes `getNextParticipantMidnight(now, tz)` and
  schedules a single `setTimeout` for that instant (+ a small buffer),
  calling `refreshToday()` and rescheduling itself on each fire. This is
  DST-safe by construction — `getNextParticipantMidnight` recomputes the
  boundary fresh each call via the same DST-aware wall-clock-to-instant
  conversion the server uses (`zonedDateTimeToUtc`), never assumes a fixed
  24-hour day, and is cancelled/rescheduled whenever `participantTimezone`
  itself changes (a profile-timezone change, or a fresh value after an
  account switch) and on unmount. The existing `AppState` foreground
  handler remains as a backstop (RN timers can be throttled while
  backgrounded), now also comparing participant-zoned dates rather than
  device-local ones.
- **DST**: task boundaries are pure calendar-date (`date` type) arithmetic
  end to end — there is no wall-clock-to-instant conversion in task
  eligibility at all, so DST transitions cannot shift an eligible task
  date. Reminder scheduling/midnight-timer math *does* involve a
  wall-clock-to-instant conversion and is verified DST-safe directly:
  scenario TZ-H confirms the 2026-03-08 US spring-forward day is exactly
  23 hours, TZ-I confirms the 2026-11-01 fall-back day is exactly 25
  hours, and TZ-J confirms a non-DST zone (`America/Phoenix`) is always
  exactly 24 hours.
- **Activity display timezone**: see `docs/activity-feed-model.md` — the
  activity screens only ever render the timezone-unambiguous
  `occurrence_date` (a plain calendar date), never a raw timestamp, so
  there is no viewer-timezone-dependent display surface to get wrong.
- **Host-machine-independent tests**: every timezone scenario in
  `scripts/activity-audit/run.ts` uses a literal, hand-verified UTC
  instant and an explicit IANA zone string — none of them read the test
  runner's own `process.env.TZ` or system clock, so results are identical
  regardless of where or when the suite runs.

## Final missing-timezone policy (timezone-authority closure)

A follow-up to the correctness fix above: that fix's own implementation
still contained two fallback violations — a hardcoded `'America/New_York'`
string in `app/recipient-dashboard.tsx`, and a pre-existing last-resort
`Intl.DateTimeFormat().resolvedOptions().timeZone` (device) fallback in
`app/caregiver-dashboard.tsx` (previously documented as an accepted,
narrower known limitation below — now closed). Both dashboards use the
same four-state model for `profiles.timezone`, and **no state ever
substitutes a hardcoded or device-resolved zone for authoritative
classification**:

1. **Loading** — the timezone hasn't been read yet this load.
   Timezone-dependent sections (Today status, task classification,
   heatmap/adherence stats) stay in their existing loading state.
2. **Missing or invalid** — `profiles.timezone` failed
   `isValidIanaTimezone`. On the *participant's own* dashboard
   (`recipient-dashboard.tsx`), this triggers the established repair path
   (`repairAndRefetchTimezone`, `lib/timezone.ts`): reconcile this
   device's own resolvable timezone into the profile
   (`syncCurrentUserTimezone` — a no-op if the device can't resolve one
   either) and re-read once. On the *organizer's* dashboard
   (`caregiver-dashboard.tsx`), there is no equivalent repair action — an
   organizer's client cannot force a different person's device to resync
   — so a missing/invalid value there goes straight to the unavailable
   state below.
3. **Query failure** — the `profiles` read itself errored (network/DB).
   Routed to the screen's existing recoverable `SectionErrorState` with
   Retry (`loadError` on the recipient side, `reminderDataError`-style
   handling on the caregiver side) — never silently treated as "missing."
4. **Still unavailable after repair** — `timezoneUnavailable` /
   `recipientTimeZoneUnavailable` is set, `participantTimezone` /
   `recipientTimeZone` stays `null`, and a compact retryable notice
   (`participantDashboard.timezoneUnavailableText` /
   `tasksSection.timezoneUnavailableText` /
   `organizerDashboard.recipientTimezoneUnavailableText`) replaces the
   classified content. Nothing computes a pending/missed/upcoming status,
   a heatmap cell, or a Today bucket against a guessed zone in this state.
   `saveReminderAction` and `TasksSummaryCard` are both gated on a
   non-null timezone for the same reason.

**Account and participant isolation**: `recipient-dashboard.tsx` compares
the freshly-authenticated user's id against `lastAuthUserIdRef` on every
`loadReminders()` call and clears `participantTimezone`/
`timezoneUnavailable` synchronously, before any further fetch, the moment
they differ — a full sign-out always unmounts the dashboard anyway (the
app uses a `Stack`, not a persistent `Tabs` navigator, so `router.replace
('/signin')` tears the screen down and its midnight-timer effect cleans up
via React's normal unmount path), but this guard also covers an
in-place session change without a remount. `caregiver-dashboard.tsx`'s
`selectParticipant()` clears `recipientTimeZone`/
`recipientTimeZoneUnavailable` synchronously, before `loadReminderData` is
even called for the new participant — the existing `loadGenerationRef`
staleness guard still discards a late-arriving stale write, but the old
participant's zone is never left standing in the interim waiting for that
guard to matter. Neither dashboard's timezone state persists across an
account switch or participant switch by construction — it is always
freshly resolved (or explicitly cleared) on every relevant transition,
never carried over from a `useState` default.

## Routine labels (Week 3 product-expansion task #3)

Individual reminders/tasks created by applying a routine
(`docs/routine-application-model.md`) remain fully independent, individually
actionable items in Today — a routine never collapses its members into one
action or one combined status. `app/recipient-dashboard.tsx` fetches a
lightweight membership set (`routine_instance_items` scoped to the current
`recipientId`, keyed on the same `recipientId` state used everywhere else
for account-switch isolation, so it can never carry a prior account's
membership set forward) and renders a subtle, purely cosmetic label
("Routine") on a reminder/task card whose id happens to be a member — never
a second card, never altered sorting, never a different action surface.
This fetch is independent of the reminders/tasks load paths themselves: a
failure to resolve routine membership never blocks or hides the underlying
card, it just omits the label.

## Organizer attribution (Week 4 launch-hardening task #2)

A participant's Today hub already aggregated reminders/tasks across every
accepted organizer connection before this task (see "Participant dashboard
integration" above) — the one gap was that reminder cards themselves never
displayed *which* organizer a reminder came from (tasks already did, via
`lib/taskData.ts#fetchTasksForRecipient`). `app/recipient-dashboard.tsx`
now batch-fetches `id, full_name, account_status, deleted_at` for every
distinct `caregiver_id` among the loaded reminders (one query, not N+1,
mirroring the tasks fetch's own shape) and resolves each card's organizer
label through `lib/organizerDisplay.ts#resolveOrganizerDisplay()` — the
shared three-way resolver (`named` / `unavailable` / `deleted`) that
replaces the null-vs-undefined-inference bug class documented in
`docs/multiple-organizer-model.md`. The label renders on the same line as
any routine-membership label above, exactly like `TaskTodayCard`'s existing
organizer+schedule+routine subtitle, and is included in the card's
`accessibilityLabel`.

## Overdue task preview cap (Week 4 Task #3)

`app/recipient-dashboard.tsx`'s overdue task block (group 1) shows at most
`OVERDUE_PREVIEW_CAP = 5` items, newest-overdue first, followed by a "View
all overdue" link to the dedicated, cursor-paginated `/overdue-tasks`
screen whenever any overdue task exists — including exactly at the cap,
since one task card can hide many unresolved *occurrences* that only the
dedicated screen enumerates individually. Today itself never fetches a
participant's unbounded overdue history on mount; it reads the same
bounded `overdue_count`/`overdueTasks` summary the task-list screens use
(see `docs/task-overdue-occurrence-model.md`). This replaces the previous
behavior where the 60-day lookback bound implicitly (and silently) capped
what Today could ever show.

## Known limitations

- Reminders and tasks are integrated at the group level, not fully
  interleaved item-by-item (see above).
- Upcoming tasks are bounded to a 3-day lookahead; a task starting further
  out never appears on Today (by design).
- The overdue task block itself is capped at 5 preview items (see above) —
  a deliberate UX bound, not a data limitation; the true count and full
  history are always available via "View all overdue."
- "Open, due later" one-time tasks share a bucket with "no deadline" tasks
  rather than getting a distinct priority tier.
- `profiles.timezone` is `NOT NULL` at the schema level, so a genuinely
  "missing" value can only ever be an invalid non-null string in practice
  (verified in scenario TZC-D) — `isValidIanaTimezone` treats every such
  case identically to a true absence, so this is a data-layer detail, not
  a gap in the client-side handling.

## Weekend QA checklist

1. Create an overdue task and an actionable reminder for the same
   participant — confirm the task block appears above the reminder list.
2. Snooze a reminder — confirm it still shows in the actionable area with
   its next time, and does not appear in the terminal/completed section.
3. Complete a task exactly at its due date vs. a day late — confirm
   "Completed" vs. "Completed late" render distinctly.
4. Leave the app open across midnight (or force-quit and reopen after
   midnight) — confirm Today reflects the new day without a manual
   pull-to-refresh.
5. Confirm a task starting 5+ days out does not appear on Today.

## Rollback

No schema changes are specific to the Today hub itself (it is a pure
client read/merge). Reverting `app/recipient-dashboard.tsx` to its
pre-task state and deleting `lib/todayFeedCore.ts` fully removes this
feature with zero data-model impact.
