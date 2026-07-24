# Tavora reminder editing model

Week 1 launch hardening task #8: how a reminder edit reaches the database,
what it's allowed to change immediately versus going forward only, and how
the delivery pipeline stays race-safe against an edit landing mid-flight.
Companion to `docs/reminder-state-model.md` (occurrence identity, response
lifecycle) and `docs/notification-payload-contract.md` (what the Edge
Function actually sends).

## Recipient-timezone display authority

**The bug this task fixes**: `caregiver-dashboard.tsx` and
`reminder-details.tsx` computed a connected recipient's Pending/Missed/
Future status using `new Date()` — the **caregiver's own device clock**.
A caregiver in a different timezone than their recipient could see an
incorrect status: a reminder already answered-or-not-yet-due in the
recipient's real timezone could display as "missed" or "pending" wrongly
on the caregiver's screen, purely because the two devices' clocks disagree
about what time it currently is where the recipient actually is.

**The fix**: both screens now fetch the connected recipient's
`profiles.timezone` once per load (falling back to the caregiver's own
device timezone only if that fetch genuinely fails — never silently
trusting the caregiver's zone when the real value is available) and pass
it through to a new set of timezone-aware helpers:

| Concern | Device-clock version (recipient's own screens) | Zoned version (caregiver-facing screens) |
|---|---|---|
| "What's today's date?" | `getTodayDateString()` / `getLocalDateString(new Date())` | `getZonedTodayString(recipientTimeZone)` |
| "Is a reminder eligible on this date?" | `isReminderEligibleOnDate(...)` | `isReminderEligibleOnZonedDate(reminder, dateString, recipientTimeZone, ...)` |
| "What's the display status?" | `getComputedStatus(...)` | `getZonedComputedStatus(reminder, dateString, todayString, recipientTimeZone, log)` |
| ISO weekday of a date | (Date object's own `.getDay()`) | `isoWeekdayOfDateString(dateString)` (pure calendar math, needs no timezone at all once you already have Y-M-D) |

Both families live in `lib/reminderStatus.ts`; the zoned family is built
on `lib/zonedTime.ts`, which implements zone-aware date/time math using
only `Intl.DateTimeFormat` with the `timeZone` option (already relied on
elsewhere in this codebase — `lib/timezone.ts`, `lib/timezoneValidation.ts`
— so no new date-arithmetic library was added). It never applies a
hardcoded UTC offset; every conversion re-derives the zone's actual offset
from `Intl` for the specific instant in question (with one refinement
pass), so daylight-saving transitions are handled correctly rather than
assumed constant.

**Recipient-facing screens are unchanged** — `recipient-dashboard.tsx` and
`reminder-alert.tsx` continue to compute from the device's own clock. This
is intentional, not an oversight: the recipient viewing their own
reminders IS the device in question, and the task's own scope explicitly
sanctions this ("recipient device/current profile timezone, which should
normally match").

**Historical timestamps are never reinterpreted.** A `reminder_logs`
row's `occurrence_date`/`scheduled_for` are set once, at first write, and
never recomputed from a later timezone value — verified directly
(scenario G in `scripts/reminder-audit/timezone-and-schedule-race.ts`):
changing a recipient's `profiles.timezone` after a response is already
logged leaves that log's `occurrence_date`, `scheduled_for`, and `status`
byte-for-byte unchanged.

**Compact context label**: `reminder-details.tsx` shows a small
`"8:00 AM in participant's timezone"` caption under a reminder's
time/frequency line, but *only* when the recipient's resolved timezone
differs from the caregiver's own device timezone — never a raw IANA
identifier, never shown when the two already match (avoiding clutter on
the common case). Not added to the caregiver dashboard's compact
day/month grid cards — that would clutter every card for no added
clarity; the detail screen is where a caregiver would actually want this
context.

## Schedule-affecting versus non-schedule edits

| Field | Classification |
|---|---|
| `title` | Non-schedule |
| `notes` | Non-schedule |
| `reminder_type` | Non-schedule |
| `time_of_day` | Schedule-affecting |
| `days_of_week` | Schedule-affecting |
| `no_response_minutes` | Schedule-affecting |
| `is_active` (activation/deactivation) | Its own, separate, already-authoritative concern — see "Why deactivation stays a separate simple toggle" below |

Non-schedule edits update the reminder row (so the new title/notes show
immediately everywhere) but never touch `reminders.schedule_version` and
never touch `reminder_notification_deliveries` — verified directly
(scenario P): a title-only edit leaves a pending delivery's
`schedule_version` and `scheduled_for` completely untouched.

Schedule-affecting edits are detected **server-side**, by comparing the
submitted values against the reminder's live, current row at edit time
(not a client-side snapshot taken when the edit screen loaded) — this is
strictly more correct than the prior (task #7) client-side comparison,
since it can't go stale if something else changed the reminder between
load and save. `days_of_week` is compared as a normalized (order-
independent) set, so re-submitting the same days in a different array
order is correctly treated as no change.

### Why deactivation stays a separate, simple toggle

`is_active` is **not** routed through `update_reminder_schedule` and does
not bump `schedule_version`. This is deliberate: unlike a schedule value
(which needs a version to distinguish "the delivery pipeline's snapshot"
from "the current truth"), `is_active = false` is already immediately and
unambiguously authoritative the moment it's read — every claim function
and the final-send guard already check it directly, live, with no
staleness window a version number would need to close. Adding version
tracking to it would be complexity with no corresponding safety gain.
`edit-reminder.tsx`'s `deactivate()` remains its own direct, simple
`UPDATE reminders SET is_active = false`.

## Schedule revision mechanism

`reminders.schedule_version integer not null default 1` — incremented by
exactly one, only when `update_reminder_schedule` detects an actual
change to `time_of_day`, `days_of_week`, or `no_response_minutes`.

`reminder_notification_deliveries.schedule_version integer not null
default 1` — copied from the reminder's schedule_version at the moment a
delivery is **claimed** (`claim_due_recipient_reminder_deliveries` /
`claim_due_recipient_snooze_deliveries`). This is the delivery's own
snapshot of "which schedule was I claimed under."

**Only meaningful for `delivery_type = 'reminder'`.** A snooze delivery's
`scheduled_for` (the recipient's own `snoozed_until` commitment) is
independent of the reminder's general schedule — editing `time_of_day`
doesn't invalidate a snooze the recipient already agreed to. The
final-send guard never gates a snooze delivery on `schedule_version` for
this reason (see "Final-send validation" below).

## The edit transaction: `update_reminder_schedule`

```sql
update_reminder_schedule(
  p_reminder_id uuid, p_title text, p_reminder_type text, p_notes text,
  p_time_of_day time, p_frequency text, p_days_of_week int[],
  p_no_response_minutes int
) returns reminders
```

`SECURITY DEFINER`, `authenticated`-only. Validates: session exists;
input shapes (title non-blank, reminder_type/frequency in their allowed
sets, days_of_week 1-7 unique-eligible entries, no_response_minutes
1-120); caller owns the reminder as its `caregiver_id` (row-locked `for
update`); the reminder is currently active; the connection is `accepted`
(row-locked `for share`). Then, in the **same transaction**:

1. Updates the reminder row, bumping `schedule_version` only if a
   schedule-affecting field actually changed.
2. If it did change: computes today's occurrence (in the recipient's
   timezone) under the **new** schedule, and reconciles any existing
   `delivery_type = 'reminder'` row for today:
   - No existing row → nothing to reconcile (the next claim tick creates
     one fresh, correctly, under the new schedule).
   - Existing row, `status` in (`pending`, `failed`), today still eligible
     under the new schedule → **updated in place**: new `scheduled_for`,
     new `schedule_version`, `status` reset to `pending`, `attempt_count`
     reset to 0, error fields cleared. Never a second row — the
     `UNIQUE(reminder_id, occurrence_date, delivery_type)` constraint is
     untouched and never at risk.
   - Existing row, same states, today **no longer** eligible under the
     new schedule (e.g. the day was removed) → deleted. Nothing valid to
     send today; leaving it would waste retry attempts on a claim that
     can never succeed.
   - Existing row, `status = 'sent'` or `'skipped'` → **never touched**.
     An already-sent occurrence stays terminal; a caregiver-visible retry-
     exhausted row isn't silently revived by an unrelated edit.

Idempotent for identical repeated edits (submitting the same values twice
in a row is a no-op the second time — `schedule_version` only increments
on an actual value change, and the reconciliation branch simply does
nothing when there's no schedule-affecting difference to reconcile).

`edit-reminder.tsx` calls this RPC exclusively — there is no longer a
separate client-side "did the schedule change" check or a second RPC call
for delivery cleanup (superseding task #7's
`clear_stale_reminder_deliveries`, which is dropped).

## Current-day edit rules (chosen, documented behavior)

**A. Edit before old due time, new time later today.** Nothing was
claimed yet (claiming only happens once `now() >= scheduled_for`), so
there's nothing to reconcile — the next claim tick picks up the new time
naturally. Verified: scenario H.

**B. Edit before old due time, new time earlier but already passed.**
Chosen behavior: the corrected time takes effect **immediately** — if a
delivery was already claimed, it's requeued to `pending` at the new
(already-past) `scheduled_for`, and the very next cron tick sends it. This
is deliberate, not a bug: if a caregiver corrects "it should have been
8am, not 9am" and it's now 8:30am with no response yet, the recipient
*should* be notified — the corrected schedule is the truth from the
moment it's saved. Verified: scenario J.

**C. Edit after old push already marked sent.** The `sent` delivery row
is never touched by reconciliation — no second send for the same
occurrence, regardless of what the edit changes. Future occurrences use
the new schedule normally. Verified: scenario K.

**D. Edit `days_of_week` so today becomes ineligible.** Any pending/failed
delivery claim for today is deleted; `sync_missed_reminders_db` naturally
stops considering today due (it reads the reminder's *current*
`days_of_week` at evaluation time, not a snapshot), so no missed row for
today ever appears under the old schedule. Verified: scenarios L and V.

**E. Edit `days_of_week` so today becomes newly eligible.** Chosen
behavior: **today begins immediately**, not "starting tomorrow." No
special-casing was needed to achieve this — it falls out naturally from
the claim function's own design: `claim_due_recipient_reminder_deliveries`
always evaluates eligibility against the reminder's *current* row, so the
very next cron tick (≤30 seconds later) claims and sends for today the
moment the edit makes it eligible and the current time is inside the
window. Chosen as the least-surprising option: a caregiver adding "today"
to the schedule almost certainly means today, not tomorrow. Verified:
scenario M.

**F. Change `no_response_minutes`.** Before an occurrence resolves: the
new value applies immediately to the still-unresolved occurrence — the
missed-sync threshold is always evaluated against the reminder's *current*
`no_response_minutes`, never a value captured earlier. After an occurrence
already has a terminal response: never retroactively rewritten — the
historical log's `status`/`completed_at` are untouched by any later edit,
of this field or any other. Verified: scenarios N and O.

## Delivery-ledger reconciliation

The `UNIQUE(reminder_id, occurrence_date, delivery_type)` constraint is
unchanged and unweakened — reconciliation works *with* it, not around it,
by updating the existing row in place rather than ever attempting a second
insert for the same key. Verified directly: scenario T confirms a second
insert attempt for the same key is still rejected after a reconciliation
has already happened; scenario U confirms the constraint itself still
exists.

No client can manipulate `reminder_notification_deliveries` directly —
it has no `authenticated`-facing RLS policy at all (unchanged from task
#7); every reconciliation happens inside `update_reminder_schedule`,
itself `SECURITY DEFINER` and reachable only through the caregiver-owned
edit path.

## Final-send validation

`send-due-recipient-reminders` no longer performs its live revalidation as
several separate per-row lookups — a single batched call to
`validate_reminder_deliveries_for_send(delivery_ids uuid[])`
(`SECURITY DEFINER`, `service_role`-only) gives every claimed delivery one
internally-consistent, immediately-before-send snapshot, computed natively
in Postgres (reusing the exact same `AT TIME ZONE` math the claim
functions use, rather than a parallel implementation in Deno/JS that could
disagree at a DST boundary or some other edge case). For each delivery it
checks, in order, and returns the first failing code:

| Condition | `skip_code` |
|---|---|
| Reminder or delivery row missing | `reminder_not_found` |
| `reminder.is_active = false` | `reminder_inactive` |
| `reminder.recipient_id` no longer matches the delivery's `recipient_id` | `reminder_reassigned` |
| Connection not `accepted` | `connection_inactive` |
| Occurrence already answered (`reminder_logs.status` not `pending`, or for a snooze, no longer `snoozed`) | `occurrence_answered` |
| `delivery.schedule_version <> reminder.schedule_version` (reminder-type only) | `stale_schedule` |
| Recomputed `scheduled_for` (current `time_of_day` + current recipient timezone) doesn't match the delivery's stored value (reminder-type only) | `stale_schedule` |
| Today's ISO weekday no longer in `reminder.days_of_week` (reminder-type only) | `occurrence_ineligible` |

The `scheduled_for` recomputation is defense-in-depth *beyond* the
`schedule_version` check: a recipient timezone sync (not a schedule edit,
so it never touches `schedule_version`) between claim and send could also
make a claimed `scheduled_for` stale, and this check catches that case
too. None of these checks ever log a reminder title, push token, or user
name — only UUIDs and the fixed code vocabulary above.

Every one of these failure modes fails **closed** — a lookup or
validation failure is always treated as "do not send," never "send
anyway." A batch-level failure of the validator call itself (network/DB
error) is treated as a *retry*, not a skip — the whole batch is retried
next tick, never silently marked answered/inactive/stale.

## Concurrency guarantees

- **Edit vs. claim/send, sequenced within one transaction**: the schedule
  update and delivery reconciliation happen atomically — there is no
  window where the reminder reflects the new schedule but the delivery
  row still reflects the old one, or vice versa, from any other
  transaction's point of view (Postgres's normal transaction isolation).
- **Edit vs. a concurrent send tick that already read pre-edit state**:
  closed by `validate_reminder_deliveries_for_send`'s independent
  immediately-before-send check — even if a send tick claimed/queued a
  message body before an edit committed, the version/scheduled_for/
  eligibility check runs again, fresh, right before the Expo API call.
- **No duplicate notifications**: guaranteed by the unchanged unique
  constraint plus in-place reconciliation (never a second row) plus the
  final-send guard (never sends a row that fails validation).
- **A valid notification at the new time is never permanently blocked**:
  reconciliation always resets `status` to `pending` and `attempt_count`
  to 0 when a row is still eligible, so a corrected schedule is never
  stuck behind an old row's exhausted retry count.

## Known residual risks

See `docs/reminder-state-model.md`'s "Known residual risks" section —
the recipient's-own-device-clock risk (intentional, out of scope) and the
sub-second concurrency window between an edit transaction committing and
a different in-flight claim/send tick (closed for all practical purposes
by the final-send guard) are both documented there rather than duplicated
here.
