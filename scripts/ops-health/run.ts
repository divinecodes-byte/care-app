// Tavora daily operational health report.
//
// Run from the repo root: npx tsx scripts/ops-health/run.ts
// Requires the `supabase` CLI already authenticated and linked — every
// query runs through it (service_role/postgres-level access), never a raw
// key embedded in this script. Prints no secret values, tokens, names,
// emails, reminder titles, or notes — counts, timestamps, and normalized
// error codes only.
//
// All threshold/WARN-vs-FAIL decision logic now lives in the SQL function
// public.ops_health_evaluate() (see supabase/migrations/20260801000000_ops_health_evaluate.sql)
// -- this script just calls it and formats the rows for the terminal. The
// evaluate-ops-health Edge Function calls the exact same SQL function, so
// the CLI report and the automatic alert evaluator can never drift apart
// (Week 4 Task #1, Phase E).
//
// Thresholds are configurable via env vars, passed through as function
// arguments rather than duplicated as separate TS constants.

import { execFileSync } from 'node:child_process';
import { dbQuery, check, getResults, overallStatus } from './helpers';

const args = {
    cronStaleWarnMultiplier: Number(process.env.OPS_CRON_WARN_MULTIPLIER ?? 4),
    cronStaleFailMultiplier: Number(process.env.OPS_CRON_FAIL_MULTIPLIER ?? 10),
    stuckPendingWarn: Number(process.env.OPS_STUCK_PENDING_WARN ?? 1),
    stuckPendingFail: Number(process.env.OPS_STUCK_PENDING_FAIL ?? 10),
    retryExhaustedWarn: Number(process.env.OPS_RETRY_EXHAUSTED_WARN ?? 1),
    retryExhaustedFail: Number(process.env.OPS_RETRY_EXHAUSTED_FAIL ?? 10),
    failureRateWarn: Number(process.env.OPS_FAILURE_RATE_WARN ?? 0.1),
    failureRateFail: Number(process.env.OPS_FAILURE_RATE_FAIL ?? 0.3),
    failureRateMinSample: Number(process.env.OPS_FAILURE_RATE_MIN_SAMPLE ?? 5),
    failureRateMinSampleAbsWarn: Number(process.env.OPS_FAILURE_RATE_MIN_SAMPLE_ABS_WARN ?? 3),
    jobRunDetailsRetentionDays: Number(process.env.OPS_JOB_RUN_RETENTION_DAYS ?? 7),
    httpResponseRetentionDays: Number(process.env.OPS_HTTP_RESPONSE_RETENTION_DAYS ?? 14),
    cleanupGraceHours: Number(process.env.OPS_CLEANUP_GRACE_HOURS ?? 26),
};

type EvalRow = { check_name: string; status: 'PASS' | 'WARNING' | 'FAIL'; detail: string; numeric_value: string | null };

function main() {
    console.log('Tavora Operational Health\n');

    const sql = `select * from public.ops_health_evaluate(
        ${args.cronStaleWarnMultiplier}, ${args.cronStaleFailMultiplier},
        ${args.stuckPendingWarn}, ${args.stuckPendingFail},
        ${args.retryExhaustedWarn}, ${args.retryExhaustedFail},
        ${args.failureRateWarn}, ${args.failureRateFail},
        ${args.failureRateMinSample}, ${args.failureRateMinSampleAbsWarn},
        ${args.jobRunDetailsRetentionDays}, ${args.httpResponseRetentionDays}, ${args.cleanupGraceHours}
    );`;
    const rows = dbQuery(sql) as EvalRow[];
    for (const r of rows) {
        check(r.check_name, r.status, r.detail);
    }

    // ── Migration sync (CLI-only signal, not expressible as a SQL check) ────
    try {
        const out = execFileSync('supabase', ['migration', 'list', '--linked'], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 30_000,
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
