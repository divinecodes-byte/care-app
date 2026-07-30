// Tavora daily operational health report.
//
// Run from the repo root: npx tsx scripts/ops-health/run.ts
// Requires the `supabase` CLI already authenticated and linked — every
// query runs through it (service_role/postgres-level access), never a raw
// key embedded in this script. Prints no secret values, tokens, names,
// emails, reminder titles, or notes — counts, timestamps, and normalized
// error codes only.
//
// Thresholds are documented constants below, overridable via env vars for
// local tuning without editing the script.

import { execFileSync } from 'node:child_process';
import { dbQuery, check, getResults, overallStatus, num, Status } from './helpers';

// ─── Configurable thresholds ──────────────────────────────────────────────
const CRON_STALE_WARN_MULTIPLIER = Number(process.env.OPS_CRON_WARN_MULTIPLIER ?? 4); // "late" if last run > N x its own schedule interval
const CRON_STALE_FAIL_MULTIPLIER = Number(process.env.OPS_CRON_FAIL_MULTIPLIER ?? 10);
const STUCK_PENDING_WARN = Number(process.env.OPS_STUCK_PENDING_WARN ?? 1);
const STUCK_PENDING_FAIL = Number(process.env.OPS_STUCK_PENDING_FAIL ?? 10);
const RETRY_EXHAUSTED_WARN = Number(process.env.OPS_RETRY_EXHAUSTED_WARN ?? 1);
const RETRY_EXHAUSTED_FAIL = Number(process.env.OPS_RETRY_EXHAUSTED_FAIL ?? 10);
const FAILURE_RATE_WARN = Number(process.env.OPS_FAILURE_RATE_WARN ?? 0.1); // 10%
const FAILURE_RATE_FAIL = Number(process.env.OPS_FAILURE_RATE_FAIL ?? 0.3); // 30%
// Below this many deliveries in the window, a percentage is statistically
// meaningless (a single failure among 1-2 due reads as "100% FAIL"). Below
// the floor, fall back to an absolute count so a lone pre-launch/test-noise
// failure can't page anyone, while a genuine cluster still can.
const FAILURE_RATE_MIN_SAMPLE = Number(process.env.OPS_FAILURE_RATE_MIN_SAMPLE ?? 5);
const FAILURE_RATE_MIN_SAMPLE_ABS_WARN = Number(process.env.OPS_FAILURE_RATE_MIN_SAMPLE_ABS_WARN ?? 3);
const OLD_PG_NET_ROWS_WARN = Number(process.env.OPS_OLD_PG_NET_WARN ?? 500); // rows older than retention window still present

// Expected cadence in seconds, used only to judge "is the last run stale" —
// intervals like '30 seconds' / '*/5 * * * *' aren't worth a full cron
// parser for this purpose.
const REQUIRED_CRON_JOBS: { name: string; cadenceSeconds: number }[] = [
    { name: 'send-due-recipient-reminders', cadenceSeconds: 30 },
    { name: 'check-push-receipts', cadenceSeconds: 15 * 60 },
    { name: 'sync-missed-reminders-db', cadenceSeconds: 5 * 60 },
    { name: 'send-caregiver-push-notifications', cadenceSeconds: 60 },
    { name: 'send-task-assignment-notifications', cadenceSeconds: 60 },
    { name: 'send-routine-assignment-notifications', cadenceSeconds: 60 },
    { name: 'cleanup-pg-net-responses', cadenceSeconds: 24 * 60 * 60 },
    { name: 'cleanup-cron-job-run-details', cadenceSeconds: 24 * 60 * 60 },
];

type CronRow = {
    jobname: string;
    schedule: string;
    active: boolean;
    last_run_at: string | null;
    last_status: string | null;
    recent_failure_count: number;
};

function main() {
    console.log('Tavora Operational Health\n');

    // ── Cron: existence, active flag, staleness, recent failures ────────────
    const cronRows = dbQuery('select * from public.cron_health_summary();') as CronRow[];
    const allJobsRaw = dbQuery('select jobname, count(*) as c from cron.job group by jobname;') as { jobname: string; c: number }[];
    const jobCounts = new Map(allJobsRaw.map((r) => [r.jobname, Number(r.c)]));

    for (const required of REQUIRED_CRON_JOBS) {
        const count = jobCounts.get(required.name) ?? 0;
        if (count === 0) {
            check(`cron:${required.name}`, 'FAIL', 'job does not exist');
            continue;
        }
        if (count > 1) {
            check(`cron:${required.name}`, 'FAIL', `scheduled ${count} times — must exist exactly once`);
            continue;
        }

        const row = cronRows.find((r) => r.jobname === required.name);
        if (!row) {
            check(`cron:${required.name}`, 'FAIL', 'job exists but has no run history yet');
            continue;
        }
        if (!row.active) {
            check(`cron:${required.name}`, 'FAIL', 'job is disabled (active=false)');
            continue;
        }
        if (!row.last_run_at) {
            check(`cron:${required.name}`, 'WARNING', 'no run recorded yet (new job or retention already pruned its own history)');
            continue;
        }

        const ageSeconds = (Date.now() - new Date(row.last_run_at).getTime()) / 1000;
        const warnAt = required.cadenceSeconds * CRON_STALE_WARN_MULTIPLIER;
        const failAt = required.cadenceSeconds * CRON_STALE_FAIL_MULTIPLIER;

        if (ageSeconds > failAt) {
            check(`cron:${required.name}`, 'FAIL', `last run ${Math.round(ageSeconds)}s ago (expected every ~${required.cadenceSeconds}s)`);
        } else if (ageSeconds > warnAt || row.last_status !== 'succeeded') {
            check(`cron:${required.name}`, 'WARNING', `last run ${Math.round(ageSeconds)}s ago, status=${row.last_status}`);
        } else if (row.recent_failure_count > 0) {
            check(`cron:${required.name}`, 'WARNING', `${row.recent_failure_count} failure(s) in last 20 runs`);
        } else {
            check(`cron:${required.name}`, 'PASS', `last run ${Math.round(ageSeconds)}s ago, succeeded`);
        }
    }

    // ── Recipient push delivery health ───────────────────────────────────────
    const deliveryMetricsRows = dbQuery('select * from public.notification_delivery_health_summary(24);') as { metric: string; value: number | null }[];
    const deliveryMetricsRecord = Object.fromEntries(deliveryMetricsRows.map((r) => [r.metric, r.value]));

    const sent = num(deliveryMetricsRecord, 'sent');
    const failed = num(deliveryMetricsRecord, 'failed');
    const failedTokenAbsence = num(deliveryMetricsRecord, 'failed_token_absence');
    const failedOther = num(deliveryMetricsRecord, 'failed_other');
    const dueInWindow = num(deliveryMetricsRecord, 'due_in_window');

    // failedOther (pipeline errors) drives the alarm-worthy rate.
    // failedTokenAbsence (no recipient device registered yet) is expected
    // during pre-launch rollout and is reported separately, never folded
    // into this threshold on its own.
    if (dueInWindow < FAILURE_RATE_MIN_SAMPLE) {
        if (failedOther >= FAILURE_RATE_MIN_SAMPLE_ABS_WARN) {
            check('recipient_pushes:failure_rate', 'WARNING', `${failedOther} genuine failure(s) of ${dueInWindow} due in last 24h — sample too small for a rate, but the raw count crosses ${FAILURE_RATE_MIN_SAMPLE_ABS_WARN}`);
        } else {
            check('recipient_pushes:failure_rate', 'PASS', `${dueInWindow} due in last 24h (sent=${sent}, failed=${failed}, of which ${failedTokenAbsence} no-token) — sample below ${FAILURE_RATE_MIN_SAMPLE}, rate not computed`);
        }
    } else {
        const failureRate = failedOther / dueInWindow;
        if (failureRate >= FAILURE_RATE_FAIL) {
            check('recipient_pushes:failure_rate', 'FAIL', `${(failureRate * 100).toFixed(1)}% genuine-failure of ${dueInWindow} due in last 24h (excludes ${failedTokenAbsence} no-token)`);
        } else if (failureRate >= FAILURE_RATE_WARN) {
            check('recipient_pushes:failure_rate', 'WARNING', `${(failureRate * 100).toFixed(1)}% genuine-failure of ${dueInWindow} due in last 24h (excludes ${failedTokenAbsence} no-token)`);
        } else {
            check('recipient_pushes:failure_rate', 'PASS', `${(failureRate * 100).toFixed(1)}% genuine-failure of ${dueInWindow} due in last 24h (sent=${sent}, failed=${failed}, of which ${failedTokenAbsence} no-token)`);
        }
    }

    // Informational only — never alarms on its own. Distinguishes "no real
    // recipient device has registered a push token yet" (expected pre-
    // launch state) from an actual pipeline defect.
    check('recipient_pushes:no_recipient_token', 'PASS', `${failedTokenAbsence} delivery attempt(s) in last 24h had no active recipient push token (expected pre-launch — server_push_enabled is not yet on for any real recipient, and no real recipient device has registered a token)`);

    const stuckPending = num(deliveryMetricsRecord, 'stuck_pending');
    if (stuckPending >= STUCK_PENDING_FAIL) {
        check('recipient_pushes:stuck_pending', 'FAIL', `${stuckPending} delivery row(s) pending > 2 minutes`);
    } else if (stuckPending >= STUCK_PENDING_WARN) {
        check('recipient_pushes:stuck_pending', 'WARNING', `${stuckPending} delivery row(s) pending > 2 minutes`);
    } else {
        check('recipient_pushes:stuck_pending', 'PASS', 'no stuck pending deliveries');
    }

    const retryExhausted = num(deliveryMetricsRecord, 'retry_exhausted');
    if (retryExhausted >= RETRY_EXHAUSTED_FAIL) {
        check('recipient_pushes:retry_exhausted', 'FAIL', `${retryExhausted} deliveries exhausted all retries in last 24h`);
    } else if (retryExhausted >= RETRY_EXHAUSTED_WARN) {
        check('recipient_pushes:retry_exhausted', 'WARNING', `${retryExhausted} deliveries exhausted all retries in last 24h`);
    } else {
        check('recipient_pushes:retry_exhausted', 'PASS', 'no retry-exhausted deliveries');
    }

    const receiptOverdue = num(deliveryMetricsRecord, 'receipt_overdue');
    check('recipient_pushes:receipt_overdue', receiptOverdue > 5 ? 'WARNING' : 'PASS', `${receiptOverdue} sent deliveries with no receipt check after 20 minutes`);

    // ── Task-assignment push health (kept structurally separate from the
    // timed-reminder metrics above — Week 3 flexible-tasks task #1,
    // Phase 13) ─────────────────────────────────────────────────────────────
    const taskMetricsRows = dbQuery('select * from public.task_notification_health_summary(24);') as { metric: string; value: number | null }[];
    const taskMetricsRecord = Object.fromEntries(taskMetricsRows.map((r) => [r.metric, r.value]));
    const taskDue = num(taskMetricsRecord, 'due_in_window');
    const taskSent = num(taskMetricsRecord, 'sent');
    const taskFailedOther = num(taskMetricsRecord, 'failed_other');
    const taskFailedTokenAbsence = num(taskMetricsRecord, 'failed_token_absence');

    if (taskDue < FAILURE_RATE_MIN_SAMPLE) {
        if (taskFailedOther >= FAILURE_RATE_MIN_SAMPLE_ABS_WARN) {
            check('task_pushes:failure_rate', 'WARNING', `${taskFailedOther} genuine failure(s) of ${taskDue} due in last 24h — sample too small for a rate`);
        } else {
            check('task_pushes:failure_rate', 'PASS', `${taskDue} due in last 24h (sent=${taskSent}, of which ${taskFailedTokenAbsence} no-token) — sample below ${FAILURE_RATE_MIN_SAMPLE}, rate not computed`);
        }
    } else {
        const taskFailureRate = taskFailedOther / taskDue;
        const taskStatus: Status = taskFailureRate >= FAILURE_RATE_FAIL ? 'FAIL' : taskFailureRate >= FAILURE_RATE_WARN ? 'WARNING' : 'PASS';
        check('task_pushes:failure_rate', taskStatus, `${(taskFailureRate * 100).toFixed(1)}% genuine-failure of ${taskDue} due in last 24h (sent=${taskSent}, excludes ${taskFailedTokenAbsence} no-token)`);
    }

    const taskStuckPending = num(taskMetricsRecord, 'stuck_pending');
    check('task_pushes:stuck_pending', taskStuckPending >= STUCK_PENDING_FAIL ? 'FAIL' : taskStuckPending >= STUCK_PENDING_WARN ? 'WARNING' : 'PASS', `${taskStuckPending} task-assignment delivery row(s) pending > 5 minutes`);

    // ── Routine-assignment push health (kept structurally separate from
    // both metrics above — Week 3 routine-templates task #3, Phase 22 —
    // routine notifications are never counted toward reminder or task
    // failure rates, and vice versa) ─────────────────────────────────────
    const routineMetricsRows = dbQuery('select * from public.routine_notification_health_summary(24);') as { metric: string; value: number | null }[];
    const routineMetricsRecord = Object.fromEntries(routineMetricsRows.map((r) => [r.metric, r.value]));
    const routineDue = num(routineMetricsRecord, 'due_in_window');
    const routineSent = num(routineMetricsRecord, 'sent');
    const routineFailedOther = num(routineMetricsRecord, 'failed_other');
    const routineFailedTokenAbsence = num(routineMetricsRecord, 'failed_token_absence');

    if (routineDue < FAILURE_RATE_MIN_SAMPLE) {
        if (routineFailedOther >= FAILURE_RATE_MIN_SAMPLE_ABS_WARN) {
            check('routine_pushes:failure_rate', 'WARNING', `${routineFailedOther} genuine failure(s) of ${routineDue} due in last 24h — sample too small for a rate`);
        } else {
            check('routine_pushes:failure_rate', 'PASS', `${routineDue} due in last 24h (sent=${routineSent}, of which ${routineFailedTokenAbsence} no-token) — sample below ${FAILURE_RATE_MIN_SAMPLE}, rate not computed`);
        }
    } else {
        const routineFailureRate = routineFailedOther / routineDue;
        const routineStatus: Status = routineFailureRate >= FAILURE_RATE_FAIL ? 'FAIL' : routineFailureRate >= FAILURE_RATE_WARN ? 'WARNING' : 'PASS';
        check('routine_pushes:failure_rate', routineStatus, `${(routineFailureRate * 100).toFixed(1)}% genuine-failure of ${routineDue} due in last 24h (sent=${routineSent}, excludes ${routineFailedTokenAbsence} no-token)`);
    }

    const routineStuckPending = num(routineMetricsRecord, 'stuck_pending');
    check('routine_pushes:stuck_pending', routineStuckPending >= STUCK_PENDING_FAIL ? 'FAIL' : routineStuckPending >= STUCK_PENDING_WARN ? 'WARNING' : 'PASS', `${routineStuckPending} routine-assignment delivery row(s) pending > 5 minutes`);

    // ── Caregiver push health (uses caregiver_notification_events directly —
    // no dedicated health function exists for it; the table is small and a
    // direct query is simpler than adding a second SECURITY DEFINER view for
    // a single count) ──────────────────────────────────────────────────────
    const caregiverRows = dbQuery(`
      select status, count(*) as c
      from public.caregiver_notification_events
      where created_at >= now() - interval '24 hours'
      group by status;
    `) as { status: string; c: number }[];
    const caregiverSent = caregiverRows.find((r) => r.status === 'sent')?.c ?? 0;
    const caregiverPending = caregiverRows.find((r) => r.status === 'pending')?.c ?? 0;
    const caregiverTotal = caregiverRows.reduce((sum, r) => sum + Number(r.c), 0);
    check(
        'caregiver_pushes',
        caregiverPending > 20 ? 'WARNING' : 'PASS',
        `${caregiverTotal} event(s) in last 24h (sent=${caregiverSent}, pending=${caregiverPending})`
    );

    // ── Invalid/inactive tokens ───────────────────────────────────────────────
    const inactiveTokens = num(deliveryMetricsRecord, 'inactive_push_tokens');
    check('push_tokens:inactive', 'PASS', `${inactiveTokens} inactive token(s) on file (expected to grow over time — informational)`);

    // ── pg_net / job_run_details retention ───────────────────────────────────
    const retentionRows = dbQuery(`
      select
        (select count(*) from net._http_response where created < now() - interval '14 days') as old_http_response,
        (select count(*) from cron.job_run_details where start_time < now() - interval '7 days') as old_job_run_details;
    `) as { old_http_response: number; old_job_run_details: number }[];
    const oldHttp = num(retentionRows[0], 'old_http_response');
    const oldJobRun = num(retentionRows[0], 'old_job_run_details');
    if (oldHttp > OLD_PG_NET_ROWS_WARN || oldJobRun > OLD_PG_NET_ROWS_WARN) {
        check('retention:pg_net_and_cron_logs', 'WARNING', `${oldHttp} old net._http_response, ${oldJobRun} old cron.job_run_details rows past retention — cleanup jobs may not be running`);
    } else {
        check('retention:pg_net_and_cron_logs', 'PASS', `${oldHttp} old net._http_response, ${oldJobRun} old cron.job_run_details rows (retention keeping up)`);
    }

    // ── Migration sync ───────────────────────────────────────────────────────
    try {
        const out = execFileSync('supabase', ['migration', 'list', '--linked'], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const lines = out.split('\n').filter((l: string) => /^\s*\d{14}\s*\|/.test(l));
        const mismatched = lines.filter((l: string) => {
            const parts = l.split('|').map((p: string) => p.trim());
            return parts[0] !== parts[1];
        });
        check('migrations', mismatched.length === 0 ? 'PASS' : 'FAIL', mismatched.length === 0 ? 'local and remote in sync' : `${mismatched.length} migration(s) out of sync`);
    } catch (err) {
        check('migrations', 'WARNING', `could not verify: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ── Print summary ─────────────────────────────────────────────────────────
    console.log('Checks:');
    for (const r of getResults()) {
        console.log(`  [${r.status}] ${r.name} — ${r.detail}`);
    }

    const overall = overallStatus();
    console.log(`\nOverall status: ${overall}`);
    process.exit(overall === 'FAIL' ? 1 : 0);
}

main();
