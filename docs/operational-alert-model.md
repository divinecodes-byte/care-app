# Operational alert model

**Automatic external notifications are NOT active.** No email provider,
Slack, webhook, or admin/owner push registration exists anywhere in this
project -- confirmed via `supabase secrets list` (only `CRON_SECRET` and
Supabase's own auto-injected keys are present) and a full codebase grep
before writing any of this. This document describes an honest, inert
alert **outbox and evaluator** -- the foundation for real alerting, not
real alerting itself. See "Configuration step to activate real delivery"
below for exactly what's missing.

## Architecture

```
pg_cron (every 10 min) --net.http_post--> evaluate-ops-health (Edge Function)
                                                  |
                                    calls public.record_ops_alert_evaluation()
                                    which wraps public.ops_health_evaluate()
                                    (the SAME function scripts/ops-health/run.ts
                                    calls -- one source of truth, see
                                    docs/audit-infrastructure-model.md)
                                                  |
                                    opens/updates/resolves rows in
                                    public.operational_alerts
                                                  v
                                    deliver-ops-alerts (Edge Function,
                                    same cron tick, right after evaluate)
                                                  |
                                    for each open alert with no delivery
                                    row yet: records ONE status='unconfigured'
                                    row in operational_alert_deliveries and
                                    logs "would alert: X -- no destination
                                    configured". Never re-attempts an
                                    already-recorded open-state.
```

## Schema

- **`operational_alerts`**: `alert_key`, `severity` (`warning`|`critical`),
  `opened_at`, `last_seen_at`, `resolved_at`, `summary` (sanitized -- no
  reminder/task/routine content, no push tokens, no participant names). A
  partial unique index (`idx_operational_alerts_open_key`) enforces **at
  most one open row per `alert_key`** -- a resolved alert can reopen later
  as a brand-new row, preserving history of each open/resolved cycle rather
  than overwriting it.
- **`operational_alert_deliveries`**: one row per delivery attempt for an
  alert's open-state; `status` is `sent`|`unconfigured`|`failed`.

Both tables: RLS enabled, **zero policies granted to `authenticated`/`anon`**
-- service-role and `SECURITY DEFINER` functions bypass RLS regardless, and
there is no product UI reading this table yet, matching
`reminder_notification_deliveries`' existing precedent.

## Alert keys

Mapped from `public.ops_health_evaluate()`'s check names inside
`record_ops_alert_evaluation()`:

| Alert key | Source check(s) |
|---|---|
| `cron_not_running` | any `cron:*` check reporting FAIL |
| `recipient_push_failure_rate` | `recipient_pushes:failure_rate` |
| `task_push_failure_rate` | `task_pushes:failure_rate` |
| `routine_push_failure_rate` | `routine_pushes:failure_rate` |
| `stuck_deliveries` | any of `{recipient,task,routine}_pushes:stuck_pending` |
| `retry_exhausted` | `recipient_pushes:retry_exhausted` |
| `receipt_overdue` | `recipient_pushes:receipt_overdue` |
| `retention_cleanup_failed` | `retention:pg_net_and_cron_logs` |

Only WARNING/FAIL rows open or refresh (`last_seen_at`) an alert. Any
`alert_key` with an open row that did **not** appear as WARNING/FAIL in a
given evaluation pass is resolved (`resolved_at = now()`) automatically.

## Deduplication, cooldown, resolution

- **Dedup**: the partial unique index -- a second `insert` for an
  already-open key is rejected at the database level, not just
  application-level logic.
- **Cooldown / no-spam**: `deliver-ops-alerts` calls
  `public.alerts_needing_initial_delivery()`, which returns only open
  alerts with **zero** delivery rows yet. Once one `unconfigured` (or,
  after a real adapter exists, `sent`) row is recorded for an alert's
  `id`, that exact open-state never generates another delivery attempt --
  not every 10-minute evaluation cycle indefinitely. A new delivery only
  becomes possible after the alert resolves and later reopens (a genuinely
  new row, new `id`).
- **Resolution**: handled entirely by `record_ops_alert_evaluation()`'s
  resolve pass described above -- no separate "resolution notification"
  mechanism exists yet (there's no destination to notify).

## Configuration step to activate real delivery

`deliver-ops-alerts/index.ts` currently does exactly one thing per
undelivered open alert: writes `status='unconfigured'` and logs `would
alert: <key> (<severity>) -- no delivery destination configured`. To
activate real delivery:

1. Choose a destination (a webhook URL, an email-provider API key, etc.) --
   deliberately not chosen here per the hard constraint against adding a
   paid vendor without explicit approval.
2. Add it as a new Supabase secret.
3. Replace the `unconfigured` branch in `deliver-ops-alerts/index.ts` with
   an actual HTTP call to that destination, keeping (or replacing with an
   equivalent) the one-attempt-per-open-state guard intact -- removing it
   would recreate the exact spam problem this design exists to prevent.

Until that happens, `operational_alert_deliveries.status` staying at
`unconfigured` forever is the expected, correct, honest state -- not a bug.

## Scheduling

`cron.schedule('evaluate-ops-health', '*/10 * * * *', ...)` -- every 10
minutes, inside the suggested 5-15 minute range, well clear of the existing
30-second/60-second/5-minute jobs. Matched to what it's actually evaluating
(24h-window failure rates, 20-minute receipt-overdue thresholds, daily
retention) -- there is no value in checking those more often than this. One
cron job triggers both `evaluate-ops-health` and `deliver-ops-alerts` in
sequence (`trigger_evaluate_and_deliver_ops_alerts()`), so delivery always
runs immediately after that same tick's evaluation, never before it on a
cold start. Singleton-checked via `select * from cron.job` before
scheduling, per this project's established convention (`cron.schedule()` on
an existing job name replaces it rather than duplicating it).

## Privacy

Alert summaries come directly from `ops_health_evaluate()`'s `detail`
strings, which are already counts/timestamps/normalized-error-codes only
(the same discipline `scripts/ops-health/run.ts` has followed since Week
1) -- no reminder/task/routine titles or notes, no push tokens, no
participant names ever flow into `operational_alerts.summary`.
