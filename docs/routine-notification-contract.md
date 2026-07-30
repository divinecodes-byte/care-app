# Routine Notification Contract

Week 3 product-expansion task #3, Phase 8/22. How applying a routine avoids
flooding a participant with one push per item, and the operational
contract for the resulting single routine-assignment notification.

## The problem

Flexible tasks already send exactly one assignment push per task
(`task_notification_deliveries` has a `unique(task_id)` constraint —
see `docs/flexible-task-model.md`). Applying a routine with several task
items through the *ordinary* `create_task` path would therefore send
several simultaneous pushes for what the participant experiences as one
event ("your organizer set up a new routine for you"). Reminders don't
have this problem at all — they were never "assignment"-notified in the
first place; they're delivered at their own scheduled due time by the
existing server-authoritative reminder pipeline, completely unaffected by
this feature.

## The fix: suppress per-task assignment notifications inside apply, enqueue exactly one routine notification instead

- `_create_task_core` (the shared internal helper behind both `create_task`
  and `apply_routine_template` — see `docs/routine-application-model.md`)
  takes a `p_suppress_notification boolean` parameter. `create_task` always
  passes `false` — **ordinary standalone task creation is completely
  unchanged**, still gets its normal single assignment push (verified live,
  `scripts/routine-audit/run.ts` scenario AR). `apply_routine_template`
  always passes `true` for every task item it creates — no
  `task_notification_deliveries` row is ever inserted for a routine-member
  task (scenario AS: a 2-task routine produces zero rows in that table for
  either task).
- After every item in the routine has been created (reminders inserted
  inline, tasks via the suppressed `_create_task_core` call),
  `apply_routine_template` inserts **exactly one** row into
  `routine_notification_deliveries`, regardless of whether the routine
  contains reminders, tasks, or both (scenario AT: exactly 1 row after a
  mixed apply). The table's `unique(routine_instance_id)` constraint makes
  a second row for the same routine structurally impossible — even a
  retried/duplicated apply call is already caught by the idempotency gate
  in `docs/routine-application-model.md` before this insert is ever
  reached again (scenario AU).

## Delivery pipeline

Mirrors the existing task-assignment pipeline's shape exactly (small,
bounded volume — at most one row per successful apply, ever — so a
per-row round trip is simple and appropriate, unlike the higher-volume
recurring-reminder pipeline's batched approach):

```
pg_cron (every 1 minute, same cadence as send-task-assignment-notifications)
  --net.http_post--> Edge Function: send-routine-assignment-notifications
    1. verify x-cron-secret (reuses the existing recipient_push_cron_secret
       vault entry -- no new secret needed)
    2. service-role client
    3. select pending/failed routine_notification_deliveries
       (status in ('pending','failed'), attempt_count < 5, cooldown 30s)
    4. re-validate live state per row: routine_instances.status = 'active',
       connections.status = 'accepted' with accepted_at set
    5. fetch active push_tokens for the recipient
    6. send via Expo Push API, parse tickets, update status
```

`check-push-receipts` (every 15 minutes) was extended to also check
`routine_notification_deliveries`' sent tickets in the same batched Expo
`getReceipts` call it already makes for reminder and task deliveries — one
more `source` tag (`'routine'`), no new cron.

## Notification content

**Private preview** (`profiles.notification_preview_mode = 'private'`,
the default):

- Title: `"Tavora routine"`
- Body: `"You have a new routine waiting."`

**Detailed preview**: the body may additionally include the routine's own
`title` (a snapshot the organizer chose, e.g. `"Morning Routine"`) — it
**never** includes notes or a list of the routine's individual item
titles, regardless of preview mode. Verified structurally
(`scripts/routine-audit/run.ts` scenarios AV/AW) — the Edge Function's
source contains only `instance.title`, no `.notes` reference, and no
per-item title concatenation of any kind.

**Payload** (`content.data`):

```
{ routineInstanceId, notificationType: 'routine_assignment' }
```

Minimal routing data only — no notes, no emails, no tokens, no item list.
`app/_layout.tsx`'s notification-tap router recognizes
`notificationType === 'routine_assignment'` and navigates to
`/routine-details?routineInstanceId=...`; `routine-details.tsx` always
re-fetches the routine's *current* state fresh on open (status, RLS-scoped
visibility) rather than trusting anything implied by the notification
itself — so a stale tap after the routine was later archived, or after the
connection ended, is handled by that screen's own calm, existing state
model, never a crash or a bypass (scenario AZ).

## Failure isolation

- Push failure (Expo error, no active token, connection ended by the time
  the cron runs, the routine having since been archived) **never rolls
  back the already-created routine** — the routine's reminders/tasks and
  `routine_instances` row are fully committed by the time
  `apply_routine_template` returns; the notification is a completely
  separate, asynchronous, best-effort delivery attempt in a different
  Edge Function invocation entirely (scenario AX). A recipient with zero
  registered push tokens still gets a fully-created, fully-usable routine
  — they simply discover it via their Today hub / Routine Details on next
  refresh instead of via a push (scenario AY).
- `server_push_enabled`/active-token/invalid-token handling all reuse the
  existing infrastructure (`push_tokens.is_active`, the same
  `DeviceNotRegistered` handling already established for reminders/tasks) —
  nothing new was invented here.
- No local recurring notification is scheduled for a routine, ever —
  matching the hard constraint and the existing server-authoritative-only
  delivery model for every push in this app.

## Operational health

`routine_notification_health_summary(p_window_hours)` mirrors
`task_notification_health_summary` exactly: `due_in_window`, `sent`,
`failed_token_absence`, `failed_other`, `pending`, `stuck_pending`.
`scripts/ops-health/run.ts` reports `routine_pushes:failure_rate` and
`routine_pushes:stuck_pending` as their own checks, structurally separate
from `recipient_pushes:*` and `task_pushes:*` — a routine-push failure
never inflates a reminder or task failure rate, and vice versa. Both
`send-task-assignment-notifications` and `send-routine-assignment-
notifications` were also added to `REQUIRED_CRON_JOBS` (the former had
been missing from that list since the flexible-tasks task — fixed
opportunistically here since it's the same list this task extends).
No private routine titles, tokens, or notes ever appear in ops output —
only counts, timestamps, and normalized error codes, matching this
codebase's existing ops-health privacy posture.
