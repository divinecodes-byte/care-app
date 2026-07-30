# Tavora operations runbook

How to tell if Tavora's server-authoritative notification pipeline is
healthy, and what to do when it isn't. This assumes no third-party
alerting vendor (none is set up — see "Alerting policy" below) and no
physical device in hand; every diagnostic here runs against the linked
Supabase project via `supabase db query --linked` or the scripts in this
repo.

## Alerting policy

**Automatic external notifications are NOT active.** There is still no
paid alerting/monitoring vendor wired up (Sentry, Datadog, PagerDuty,
etc.). As of Week 4 Task #1, an internal alert *outbox* exists
(`operational_alerts` / `operational_alert_deliveries`, evaluated every 10
minutes by the `evaluate-ops-health` Edge Function against the same
`public.ops_health_evaluate()` function this runbook's health report uses)
-- but `deliver-ops-alerts` currently only records an honest
`status='unconfigured'` row and logs a line saying so; nothing is actually
sent anywhere. See `docs/operational-alert-model.md` for the full design
and the exact configuration step required to activate real delivery.

Until that's configured, the substitute remains:

- **`scripts/ops-health/run.ts`** — run manually, or on a schedule you set
  up yourself (e.g. a personal cron job, a GitHub Actions scheduled
  workflow, or just checking it once a day) — see "Daily health report"
  below. It exits non-zero on FAIL so it's cheap to wire into any external
  scheduler's failure notification (email-on-failure from a CI cron job is
  the simplest zero-cost option).
- **Supabase's own dashboard** (Database → Cron, Edge Functions → Logs) as
  a manual fallback if this repo's tooling is unavailable.
- **Direct SQL**: `select * from public.operational_alerts where resolved_at is null;`
  shows every currently-open condition the evaluator has detected, even
  though nothing has been externally delivered for it yet.

This is intentionally minimal. Upgrading to a real alerting vendor, or
wiring `deliver-ops-alerts` to a webhook/email destination, is a reasonable
follow-up, not done here per the constraint against adding a paid
dependency without explicit approval.

## Daily health report

```
npx tsx scripts/ops-health/run.ts
```

Requires the `supabase` CLI already logged in and linked to the project
(the same precondition as `scripts/security-audit/run.ts`). Prints one
PASS/WARNING/FAIL line per check and an overall status; exits `1` on FAIL,
`0` otherwise (WARNING still exits `0` — treat it as "look at this today,"
not "the pipeline is down"). Thresholds are tunable via env vars documented
at the top of `scripts/ops-health/run.ts` (e.g. `OPS_STUCK_PENDING_FAIL`)
without editing the script.

It checks, in order: each required cron job exists exactly once, is
active, and ran recently with a successful status; recipient push failure
rate over the last 24h; stuck-pending and retry-exhausted delivery counts;
receipts not yet checked 20+ minutes after send; caregiver push event
counts; inactive push token count (informational); `net._http_response`
and `cron.job_run_details` rows past their retention window **plus a
cleanup-cadence grace period** (see "Retention policy in effect" below --
this is a proxy for "are the cleanup cron jobs actually running," corrected
in Week 4 Task #1 to stop false-positiving on the normal once-daily
sawtooth); and local-vs-remote migration sync.

As of Week 4 Task #1, every one of these checks (except migration sync,
which is CLI-only) is computed by a single SQL function,
`public.ops_health_evaluate()` — this script just calls it and formats the
rows. The `evaluate-ops-health` Edge Function (see "Alerting policy" above)
calls the exact same function, so the terminal report and the automatic
evaluator can never disagree about whether something is healthy.

## What "healthy" looks like

- `send-due-recipient-reminders` and `send-caregiver-push-notifications`:
  last run within the last couple of minutes, status `succeeded`.
- `check-push-receipts`: last run within the last ~20 minutes (it runs
  every 15 min).
- `sync-missed-reminders-db`: last run within the last ~10 minutes.
- `cleanup-pg-net-responses` / `cleanup-cron-job-run-details`: run once
  daily at 03:00 / 03:15 server time — a "no run recorded yet" WARNING is
  normal until their first scheduled firing after deploy, and should clear
  itself the next day.
- Recipient push failure rate under ~10%, zero stuck-pending, zero
  retry-exhausted deliveries at rest.
- `net._http_response` rows older than 14 days + 26h and `cron.job_run_details`
  rows older than 7 days + 26h: zero (the daily cleanup jobs enforce this).
  The 26-hour grace period is deliberate — see "Retention policy in effect"
  below for why a raw count against the exact retention boundary used to
  false-positive every single day.

## Delivery-latency definition

`notification_delivery_health_summary()` reports
`avg_ticket_latency_seconds` / `p95_ticket_latency_seconds`, computed as
`sent_at - created_at` on `reminder_notification_deliveries` — i.e. the
time from when a delivery row was claimed by the cron tick to when Expo's
push API *accepted the ticket*. **This is server-side processing latency
only.** It says nothing about when a device actually received or displayed
the notification — Expo's ticket API only confirms Expo accepted the
request for delivery, not that Apple/Google's push service delivered it.
Do not represent this metric as "time to phone" in any report or dashboard
built on top of it.

## Diagnostic SQL

Run any of these via `supabase db query --linked "<sql>"`. All read from
tables already covered by existing RLS/grants — none of this requires the
service-role key locally, since the CLI is already authenticated at the
project level.

**Is a specific cron job stuck or failing?**
```sql
select jobid, jobname, schedule, active
from cron.job
where jobname = '<job-name>';

select status, return_message, start_time, end_time
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = '<job-name>')
order by start_time desc
limit 20;
```

**What's actually stuck right now?**
```sql
select id, reminder_id, recipient_id, status, attempt_count, error_code,
       error_message, created_at, updated_at
from public.reminder_notification_deliveries
where status = 'pending' and updated_at < now() - interval '2 minutes'
order by created_at;
```

**What exhausted retries recently, and why?**
```sql
select error_code, count(*), max(updated_at) as most_recent
from public.reminder_notification_deliveries
where status = 'skipped' and attempt_count >= 5
  and updated_at > now() - interval '24 hours'
group by error_code
order by count(*) desc;
```

**Are invalid tokens spiking?**
```sql
select count(*) filter (where is_active = false) as inactive,
       count(*) filter (where is_active = true) as active
from public.push_tokens;
```

**Full health snapshot** (service-role only — run via the CLI, not from
the client app):
```sql
select * from public.notification_delivery_health_summary(24);
select * from public.cron_health_summary();
```

## Failure scenarios and safe responses

### A cron job stops running entirely (no rows in `cron.job_run_details`)
1. Confirm with `select * from cron.job where jobname = '<name>';` — check
   `active`. If `false`, someone/something disabled it:
   `select cron.alter_job(job_id => <jobid>, active => true);`
2. If `active = true` but nothing is firing, this is a Postgres-level
   pg_cron issue (rare, usually a project restart). Re-scheduling the exact
   same job definition is safe — `cron.schedule()` on an existing job name
   replaces it rather than duplicating it, so this cannot create a
   duplicate-send risk.
3. Do **not** manually run the underlying Edge Function repeatedly to
   "catch up" — the claim functions are idempotent per occurrence, so a
   normal resumed cron tick will safely pick up everything still within its
   due window on its own. Manual intervention is not needed to prevent
   missed sends, only to restore the schedule itself.

### Failure rate rises (recipient or caregiver pushes)
1. Check `error_code` distribution (see diagnostic SQL above) — a spike
   concentrated in one code tells you the failure mode:
   - `no_active_push_token` / `device_not_registered` spike: likely an app
     update that changed token registration, or a wave of uninstalls — not
     a pipeline bug. Check `push_tokens` growth rate.
   - `expo_ticket_error` / `expo_batch_error` spike: likely an Expo-side
     outage. Check https://status.expo.dev. No action needed on our side
     beyond waiting — retries will pick delivery back up once Expo recovers,
     up to the existing attempt-count ceiling.
   - `internal_error` spike: check Edge Function logs
     (`supabase functions logs send-due-recipient-reminders`) for an
     unhandled exception — this is the one category that indicates an
     actual bug in this codebase, not an external dependency.
2. Never bulk-update `reminder_notification_deliveries.status` by hand to
   "fix" a spike — see "When NOT to manually edit delivery rows" below.

### Latency rises (p95_ticket_latency_seconds growing)
1. Check `due_in_window` vs `pending` from
   `notification_delivery_health_summary()` — a growing backlog under load
   is a capacity signal, not necessarily a bug.
2. Check Edge Function logs for repeated cold starts or timeouts.
3. If sustained, this is a scale conversation (batch size, Expo rate
   limits), not a same-day fix — document and monitor rather than
   improvising a schema change under pressure.

### Stuck rows accumulate (`stuck_pending` growing over multiple ticks)
1. This means a claim happened but the tick that claimed it crashed before
   updating status. Check Edge Function logs around the claim time for a
   `fatal_error` log line (the top-level handler in
   `send-due-recipient-reminders/index.ts` logs this on any uncaught
   exception).
2. The next successful tick's retry-eligible query
   (`status in ('pending','failed') and attempt_count < 5 and
   updated_at < now() - interval '30 seconds'`) will pick these back up
   automatically — no manual SQL needed in the common case.
3. If a row is stuck for hours despite cron running normally, inspect it
   individually before touching it (see below) — don't bulk-reset.

### Invalid-token spike
1. Confirm it's real device churn and not a bug: sample a few affected
   `push_tokens` rows and check `updated_at` / associated `profiles` —
   are these long-inactive accounts, or a cluster from the same short time
   window (which would suggest an app-side regression instead)?
2. No manual remediation needed — `is_active = false` is the correct,
   final state for a token Expo/Apple/Google reports as gone. Do not
   re-activate a token flagged `device_not_registered` without the device
   re-registering it through the normal app flow.

### Account deletion fails
1. Check `supabase functions logs delete-account` for the specific error.
2. Do not attempt a manual `auth.admin.deleteUser` + hand-written cleanup
   as a substitute — the Edge Function and
   `public.delete_current_user_data()` encode the exact
   anonymize-in-place/tombstone rules (see `docs/security-model.md` and the
   account-deletion migration) and a manual delete risks violating one of
   them (e.g. leaving a stale push token active, or not deactivating a
   shared reminder).
3. If the Edge Function itself is erroring (not a specific user's data),
   check it hasn't lost its service-role credential or that
   `delete_current_user_data()`'s signature hasn't drifted from what the
   function calls.

### Invite acceptance fails
1. Check `accept_invite_code`'s error via the client error toast first —
   the RPC returns specific reasons (expired, already used, not found).
2. Confirm the invite row exists and check its `expires_at`/`used_at` via
   `select * from public.connections where invite_code = '<code>';` — do
   not hand-edit this row to force acceptance; if a real user is stuck,
   have them generate a fresh invite through the app instead.

### `net._http_response` (or `cron.job_run_details`) growth returns
1. Confirm the cleanup jobs are still active and running:
   `select * from cron.job where jobname like 'cleanup-%';` and check
   their `cron.job_run_details` history.
2. If they're running but the table is still growing, check whether
   `cleanup_pg_net_responses()` / `cleanup_cron_job_run_details()` still
   have `EXECUTE` granted only to `service_role` and the cron trigger
   function still calls them correctly — a silent grant/ownership drift
   would let the function exist but never actually run under cron's
   context.
3. Manually invoking `select public.cleanup_pg_net_responses();` /
   `select public.cleanup_cron_job_run_details();` once via the CLI is
   safe or the linked project to clear an immediate backlog — both are
   idempotent, conservative (7/14-day windows), and touch only pg_net/
   pg_cron's own log tables, never application data.

### A deploy breaks the pipeline
1. Roll back the specific Edge Function to its previous version:
   `supabase functions deploy <name>` from the last-known-good commit
   (`git checkout <sha> -- supabase/functions/<name> && supabase functions
   deploy <name>`), then restore the working tree
   (`git checkout HEAD -- supabase/functions/<name>`).
2. For a migration-level regression, do not `db reset` against the linked
   project — write a new forward migration that undoes the specific
   change. This project has real user data; destructive resets are never
   appropriate against the linked project.
3. After any rollback, run `scripts/ops-health/run.ts` and
   `scripts/security-audit/run.ts` before considering the incident closed.

## Avoiding duplicate sends during recovery

The idempotency guarantee lives in the unique constraint on
`reminder_notification_deliveries (reminder_id, occurrence_date,
delivery_type)` plus the `ON CONFLICT DO NOTHING` claim functions — this
holds regardless of how many times a cron tick runs, how many ticks
overlap, or how long the pipeline was down. Recovering from an outage by
simply letting cron resume normally is always safe: the claim functions
can only ever insert one `pending` row per occurrence, so a backlog of
missed ticks cannot produce duplicate sends when it catches up. The only
way to cause a duplicate is to manually insert or reset a delivery row
that bypasses this constraint — which is exactly why manual editing is
discouraged below.

## When NOT to manually edit delivery rows

Do not directly `UPDATE public.reminder_notification_deliveries` (status,
attempt_count, error fields) to "fix" a stuck or failed row, except as a
last resort after the automated retry path has been confirmed exhausted
and you've read the specific row's `error_code`/`error_message` first.
Reasons:

- Resetting `status` back to `pending` on a row that was actually sent
  (but, say, failed to update afterward) risks a real duplicate push if
  the underlying send did succeed — check `expo_ticket_id` is null before
  ever doing this.
- Resetting `attempt_count` to 0 defeats the retry-exhaustion ceiling and
  can cause a genuinely undeliverable row (e.g. a permanently invalid
  token) to loop indefinitely.
- The claim/retry functions already handle every legitimate recovery path
  automatically (stuck rows, transient failures, crashed ticks) — a row
  that's still broken after that means something about the underlying data
  (reminder state, token state) needs fixing, not the delivery row itself.

If you must intervene, prefer setting `status = 'skipped'` with a clear
`error_message` explaining the manual intervention, over deleting the row
or resetting it to `pending`.

## Retention policy in effect

- `net._http_response`: rows with `status_code = 200` older than 7 days,
  and all rows regardless of status older than 14 days, deleted daily at
  03:00 by `cleanup-pg-net-responses` (`public.cleanup_pg_net_responses()`).
- `cron.job_run_details`: rows older than 7 days deleted daily at 03:15 by
  `cleanup-cron-job-run-details` (`public.cleanup_cron_job_run_details()`).
- `reminder_notification_deliveries`, `caregiver_notification_events`,
  `reminder_logs`: **no automated deletion**. These are shared user
  history covered by the account-deletion anonymization rules, not
  operational logs — see `docs/security-model.md`. Do not add a retention
  job for these without an explicit, separate product decision.

### Root cause of the retention false-positive (Week 4 Task #1)

The `retention:pg_net_and_cron_logs` health check used to flag WARNING
essentially every day, even though the two cleanup jobs above were
confirmed running successfully every single day with zero errors
(verified directly against `cron.job_run_details`'s own run history).
Root cause was arithmetic, not a real cleanup failure: `cron.job_run_details`
receives roughly **7,584 new rows per day**, dominated by the 30-second
`send-due-recipient-reminders` job (~2,877/day) plus three 1-minute jobs
(~1,440/day each). Since cleanup only runs once daily, a natural sawtooth
of up to a full day's volume sits past the *raw* 7-day retention boundary
in the hours before each nightly run — that's expected, not a backlog.

Fixed in `public.ops_health_evaluate()` (used by both
`scripts/ops-health/run.ts` and the `evaluate-ops-health` Edge Function —
see "Alerting policy" above) by checking rows older than *retention + a
26-hour grace period* (one full daily cycle plus buffer) instead of the
raw boundary, and by additionally checking the cleanup jobs' own
last-run-succeeded status directly (via `cron_health_summary()`) —
distinguishing "rows are old because cleanup genuinely hasn't run/failed"
(FAIL) from "rows are old because we're mid-cycle, right on schedule"
(PASS) from "a real multi-day backlog is accumulating despite cleanup
apparently succeeding" (WARNING). A raw row count is deliberately no
longer the primary signal.

## Rollback procedure (this task's changes as a whole)

If this observability/retention work needs to be fully reverted:
1. `select cron.unschedule('cleanup-pg-net-responses');` and
   `select cron.unschedule('cleanup-cron-job-run-details');` to stop the
   new retention jobs.
2. The new functions (`notification_delivery_health_summary`,
   `cron_health_summary`, `cleanup_pg_net_responses`,
   `cleanup_cron_job_run_details`) and the `receipt_checked_at` /
   `error_code` columns are additive — leaving them in place is harmless
   even if unused; there's no need to drop them to fully "undo" the
   feature's effect.
3. The `send-due-recipient-reminders` / `check-push-receipts` Edge
   Function changes (error normalization, token redaction, receipt-check
   tracking, crash isolation) are the only behavior-affecting part of this
   task — reverting them means redeploying the prior commit's version of
   those two functions (see "A deploy breaks the pipeline" above).
