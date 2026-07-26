# Task Notification Contract

A flexible task gets **exactly one** server-authoritative push notification:
the initial assignment ping. There is no exact-time alarm, no snooze
notification, no recurring local notification, and no repeated nag while a
task remains overdue. This is a structural guarantee, not a policy choice —
see "Why exactly one" below.

## Ledger: `task_notification_deliveries`

A dedicated table, separate from `reminder_notification_deliveries`
(see `docs/notification-payload-contract.md` for the reminder side).
Columns: `id, task_id, recipient_id, status ('pending'|'sent'|'failed'),
error_code, error_message, attempt_count, expo_ticket_id, sent_at,
receipt_checked_at, created_at, updated_at`.

**`unique(task_id)`** — the structural guarantee. There is no code path
that can insert a second row for the same task; "no repeated push merely
because a task remains overdue" is enforced by the schema itself, not by an
application-level check that could have a bug.

## Why exactly one (not forced into the reminder ledger)

`reminder_notification_deliveries` is shaped for a recurring, re-claimable
delivery (`occurrence_date`, `delivery_type ('reminder'|'snooze')`,
`schedule_version`-based requeue-in-place). A task assignment is a single
one-shot event per task, with no occurrence date and nothing to requeue —
forcing it into that shape would mean fake values with no real meaning.
Per Phase 13's explicit instruction, a smaller, separate ledger was built
instead.

## Creation → send flow

1. `create_task()` inserts the task row and, in the same transaction,
   inserts exactly one `task_notification_deliveries` row
   (`status='pending'`). A push failure later can never roll back task
   creation — the two are decoupled by construction, since the delivery row
   insert happens synchronously at creation time but the actual send is
   fully asynchronous.
2. `send-task-assignment-notifications` (Edge Function, `pg_cron` every
   minute — `* * * * *`, chosen because assignment isn't exact-time-critical
   the way a reminder delivery is) selects `pending`/`failed` rows
   (`attempt_count < 5`, cooldown `30s`), re-validates each task's
   `is_active` and connection `status='accepted'` live (a task archived or a
   connection ended between creation and send is marked `failed` with
   `error_code='task_inactive'`/`'connection_inactive'` — never sent),
   fetches the recipient's active `push_tokens`, and sends via Expo.
3. `check-push-receipts` (existing Edge Function, extended this task) now
   also checks `task_notification_deliveries`' sent tickets in the same
   batched Expo `getReceipts` call used for reminders — one Expo API round
   trip covers both ledgers. `DeviceNotRegistered` deactivates the token
   exactly as it already does for reminders.

## Payload

**Private mode** (default):
- title: `"Tavora task"`
- body: `"You have a new task waiting."`

**Detailed mode** (recipient opted in via
`profiles.notification_preview_mode='detailed'`):
- body includes the task's own title: `"{title}" — You have a new task
  waiting.`

`content.data`: `{ taskId, notificationType: 'task_assignment' }` — no
`taskOccurrenceId` (nothing has been materialized yet at assignment time),
no notes, no participant/organizer names. The ledger table itself has no
`notes`/`title` column at all (verified in
`scripts/task-audit/run.ts` scenario AJ) — there is nothing to leak even by
accident, since the send function fetches the title fresh from `tasks` only
for the detailed-mode body, never persists it into the delivery row.

## Routing

`app/_layout.tsx`'s notification-response listener checks
`data.notificationType === 'task_assignment'` and routes to
`/task-details?taskId=...`. That screen re-validates authorization
(`recipient_id === auth.uid()`) and current task state (`is_active`,
connection `status`) before showing any action — a stale notification tap
for an already-archived task or an ended connection lands on a calm,
non-actionable state, never a crash or an authorization bypass.

## Failure classification

`error_code` vocabulary: `no_active_push_token | device_not_registered |
expo_ticket_error | expo_batch_error | task_inactive | connection_inactive |
internal_error`. A recipient with `server_push_enabled=false` or no active
token is classified `no_active_push_token` — the same "expected pre-launch,
not a defect" bucket used by the reminder pipeline's
`recipient_pushes:no_recipient_token` ops-health check (see below).

## Operational monitoring

`task_notification_health_summary(p_window_hours)` — kept **structurally
separate** from `notification_delivery_health_summary` (timed reminders),
so the two metrics can never blend into one misleading combined number.
Wired into `scripts/ops-health/run.ts` as `task_pushes:failure_rate` and
`task_pushes:stuck_pending`, using the same minimum-sample-size guard
established for the reminder metric (a denominator of 0-4 never produces a
misleading 100%-style alarm).

## Idempotency & account safety

- Idempotent by construction (`unique(task_id)`).
- Invalid/`DeviceNotRegistered` tokens are deactivated through the existing
  `push_tokens.is_active` mechanism — no task-specific token handling was
  added, so account-switching safety (one active token reassigned per
  device) is inherited unchanged from the existing reminder pipeline.
- A push failure of any kind is recorded on the delivery row only — it
  never touches the task row itself.
