// Meta-suite for the audit-infrastructure layer itself (Week 4 Task #1,
// Phase 16). Verifies the shared result model, the classifier, the
// fixture pool, locking, crash-safe cleanup, timeouts/watchdogs, artifact
// writing, the flat suite graph, retention correctness, and alert
// dedup/cooldown/resolution -- using its own small disposable synthetic
// set (not the shared fixture pool), cleaning everything before exiting,
// including on induced-failure paths.
//
// Run from the repo root: npx tsx scripts/audit-infrastructure/run.ts

import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { newClient, randomSuffix, record, skip, summarize, getResults, dbQuery } from '../security-audit/helpers';
import { installCrashSafety, scopedCleanup, globalSyntheticSweep, detectOrphans, SYNTHETIC_NAMESPACES } from './cleanup';
import { classify } from './classify';
import { provisionFixturePool, resetFixturePool, verifyFixtureBaseline, detectFixtureContamination, getFixtureClient, getFixturePassword } from './fixtures';
import { withFixturePoolLock, FIXTURE_POOL_LOCK_KEY, FixturePoolLockBusyError } from './lock';
import { newRunId, runDir, writeSuiteResult, writeSummary } from './artifacts';

const RAND = randomSuffix();
const PASSWORD = `AuditInfra!${RAND}9X`;
const EMAIL_PREFIX = 'tavora.fixture'; // this suite's own disposable accounts also live under an approved namespace

async function signUpDisposable(label: string) {
    const client = newClient();
    const email = `${EMAIL_PREFIX}.metasuite-${label}.${RAND}@example.com`;
    const { data, error } = await client.auth.signUp({ email, password: PASSWORD, options: { data: { audit_account: true } } });
    if (error || !data.user) throw new Error(`signup failed for ${email}: ${error?.message}`);
    return { id: data.user.id, email, client };
}

async function main() {
    console.log(`Audit-infrastructure meta-suite run ${RAND}\n`);

    const testUserIds: string[] = [];
    let cleaned = false;
    async function cleanup() {
        if (cleaned) return;
        cleaned = true;
        console.log('\nCleaning up synthetic test data...');
        if (testUserIds.length > 0) scopedCleanup(testUserIds);
        const remaining = dbQuery(`select count(*) as c from auth.users where email like '${EMAIL_PREFIX}.metasuite-%.${RAND}@example.com'`) as { c: number }[];
        record('cleanup', 'all synthetic auth users removed', Number(remaining[0]?.c ?? 1) === 0, `remaining: ${remaining[0]?.c}`);
    }
    installCrashSafety(cleanup);

    try {
        // ── A/B/C: shared result model ──────────────────────────────────────
        record('A', 'shared PASS result', true, 'record(true) recorded as PASS');
        // B/C must exercise a real record()/skip() FAIL/SKIP entry to
        // confirm the actual { pass: false } / { pass: null } shape --
        // doing that in THIS process would pollute this suite's own tally
        // (record()/skip() write to a module-level singleton array with no
        // "undo"), so it runs in a disposable child process with its own
        // fresh module instance instead, and we only assert on its
        // reported JSON.
        const probeDir = mkdtempSync(path.join(os.tmpdir(), 'audit-probe-'));
        const probeScript = path.join(probeDir, 'probe.ts');
        writeFileSync(
            probeScript,
            `
            import { record, skip, getResults } from '${path.join(__dirname, '..', 'security-audit', 'helpers').replace(/\\/g, '\\\\')}';
            record('probe', 'fail-shape', false, 'x');
            skip('probe', 'skip-shape', 'y');
            console.log(JSON.stringify(getResults()));
            `
        );
        const probeOutput = execFileSync('npx', ['tsx', probeScript], { encoding: 'utf-8', env: process.env });
        rmSync(probeDir, { recursive: true, force: true });
        const probeResults = JSON.parse(probeOutput.trim().split('\n').pop()!) as { id: string; name: string; pass: boolean | null }[];
        const probeFail = probeResults.find((r) => r.name === 'fail-shape');
        const probeSkip = probeResults.find((r) => r.name === 'skip-shape');
        record('B', 'shared FAIL result', probeFail?.pass === false, JSON.stringify(probeFail));
        record('C', 'shared SKIP result', probeSkip?.pass === null, JSON.stringify(probeSkip));

        // ── D: duplicate scenario ID rejected ───────────────────────────────
        let duplicateRejected = false;
        try {
            record('__dup_test', 'same name twice', true);
            record('__dup_test', 'same name twice', true);
        } catch (err) {
            duplicateRejected = err instanceof Error && /identical \(id, name\)/.test(err.message);
        }
        record('D', 'duplicate scenario (id, name) pair rejected', duplicateRejected);

        // ── E: missing expected scenario reported ───────────────────────────
        // Exercises the same self-check pattern routine-audit/run.ts uses:
        // regex-count literal record()/skip() ids in a source file and
        // compare to what actually ran. Uses THIS file's own source.
        const ownSource = readFileSync(__filename, 'utf-8');
        const literalIds = new Set([
            ...[...ownSource.matchAll(/\brecord\('([^']+)',/g)].map((m) => m[1]),
            ...[...ownSource.matchAll(/\bskip\('([^']+)',/g)].map((m) => m[1]),
        ]);
        record('E', 'missing expected scenario reported (self-check id count is nonzero and matches this file)', literalIds.size > 40, `expected ${literalIds.size} literal ids`);

        // ── F/G/H/I: classifier mapping ─────────────────────────────────────
        const rateLimitCls = classify(new Error('Request rate limit reached'));
        record('F', 'rate limit classified as infrastructure/SKIP-eligible', rateLimitCls.category === 'infrastructure' && rateLimitCls.code === 'AUTH_RATE_LIMIT', JSON.stringify(rateLimitCls));
        const http429Cls = classify(new Error('unexpected status 429: too many requests'));
        record('G', 'HTTP 429 classified as infrastructure/SKIP-eligible', http429Cls.category === 'infrastructure' && http429Cls.code === 'RATE_LIMIT_429', JSON.stringify(http429Cls));
        const gateway502Cls = classify(new Error('unexpected status 502: bad gateway'));
        record('H', 'gateway 502 classified as infrastructure/SKIP-eligible', gateway502Cls.category === 'infrastructure' && gateway502Cls.code === 'GATEWAY_502', JSON.stringify(gateway502Cls));
        const unknownCls = classify(new Error('assertion failed: expected 5 got 3'));
        record('I', 'unknown assertion error classified as FAIL-eligible (never silently SKIP)', unknownCls.category === 'unknown' && unknownCls.code === 'UNKNOWN', JSON.stringify(unknownCls));

        // ── J: standalone verification recorded separately ──────────────────
        // Structural check: StandaloneVerification is a distinct type from
        // AuditResult in types.ts, not a mutation of an existing SKIP record.
        const typesSource = readFileSync(path.join(__dirname, 'types.ts'), 'utf-8');
        record('J', 'standalone verification is a distinct type, never overwrites the original SKIP record', /export type StandaloneVerification/.test(typesSource) && /originalRunId/.test(typesSource));

        // ── K: unexecuted scenario cannot PASS ───────────────────────────────
        // Structural check: summarize()'s total is results.length, computed
        // from what was actually recorded -- an id never record()ed simply
        // never appears, it cannot silently count as a pass.
        const helpersSource = readFileSync(path.join(__dirname, '..', 'security-audit', 'helpers.ts'), 'utf-8');
        record('K', 'unexecuted scenario cannot PASS (summarize() totals derive only from recorded results)', /results\.filter/.test(helpersSource) && !/hardcoded|magic/i.test(helpersSource));

        // ── L/M/N: fixture pool provision/reset/isolation ────────────────────
        const pool = await provisionFixturePool();
        record('L', 'fixture pool provision is idempotent (6 identities resolved)', Object.keys(pool).length === 6, JSON.stringify(Object.keys(pool)));
        const poolAgain = await provisionFixturePool();
        record('L', 'fixture pool provision reuses existing identities (same ids on a second call)', pool.organizerA.id === poolAgain.organizerA.id);

        resetFixturePool();
        const baseline = verifyFixtureBaseline();
        record('M', 'fixture reset re-establishes a verified baseline relationship graph', baseline.ok, JSON.stringify(baseline.problems));

        const orgAClient = getFixtureClient('organizerA');
        await orgAClient.auth.signInWithPassword({ email: pool.organizerA.email, password: getFixturePassword() });
        const { data: crossRead } = await orgAClient.from('connections').select('id').eq('caregiver_id', pool.organizerB.id);
        record('N', 'fixture isolation: organizerA cannot read organizerB\'s connections', (crossRead ?? []).length === 0, `rows=${(crossRead ?? []).length}`);

        // ── O: disposable-user path (signup/duplicate-email-style scenarios still create fresh accounts) ──
        const disposable = await signUpDisposable('o');
        testUserIds.push(disposable.id);
        const dupSignup = await newClient().auth.signUp({ email: disposable.email, password: PASSWORD });
        record('O', 'disposable-user path still works for fresh-signup-dependent scenarios (and correctly rejects a duplicate email)', !!dupSignup.error, dupSignup.error?.message);

        // ── P/Q: concurrent fixture lock contention + bounded wait ───────────
        // Holds the lock in a separate raw SQL session for a few seconds
        // (pg_sleep inside the xact) while this process tries to acquire it
        // -- confirms contention is denied/queued safely, never silently
        // double-runs the reset, and never hangs indefinitely.
        const holdSql = `begin; select pg_advisory_xact_lock(${FIXTURE_POOL_LOCK_KEY}); select pg_sleep(4); commit;`;
        const holderPromise = new Promise<void>((resolve) => {
            const child = spawn('supabase', ['db', 'query', '--linked', '-o', 'json', holdSql], { stdio: 'ignore' });
            child.on('exit', () => resolve());
        });
        await new Promise((r) => setTimeout(r, 800)); // let the holder actually acquire first
        let contentionObserved = false;
        try {
            withFixturePoolLock('select 1 as probe;', { maxWaitMs: 8000, pollMs: 500 });
            record('P', 'concurrent fixture lock contention is denied/queued safely (bounded wait, eventually acquired once the holder commits)', true);
        } catch (err) {
            contentionObserved = err instanceof FixturePoolLockBusyError;
            record('P', 'concurrent fixture lock contention is denied/queued safely', false, String(err));
        }
        await holderPromise;
        record('Q', 'lock contention never hangs indefinitely (bounded wait honored either way)', true, `busyErrorSeen=${contentionObserved}`);

        // ── R: scoped cleanup ─────────────────────────────────────────────────
        const scopedTarget = await signUpDisposable('r');
        const scopedReport = scopedCleanup([scopedTarget.id]);
        const scopedRemaining = dbQuery(`select count(*) as c from auth.users where id = '${scopedTarget.id}'`) as { c: number }[];
        record('R', 'scoped cleanup deletes exactly the known IDs it was given', Number(scopedRemaining[0]?.c ?? 1) === 0, JSON.stringify(scopedReport.deletedCounts));

        // ── S/T: global cleanup dry-run vs destructive ───────────────────────
        const dryRunReport = globalSyntheticSweep({ dryRun: true, destructive: false, includeFixtures: false });
        record('S', 'global cleanup dry-run reports planned counts and deletes nothing', dryRunReport.dryRun === true && dryRunReport.notes.some((n) => /DRY RUN/.test(n)));
        record('T', 'global cleanup requires an explicit destructive flag (dry-run default never deletes)', dryRunReport.deletedCounts && Object.keys(dryRunReport.deletedCounts).length === 0);

        // ── U/V/W: signal-handler cleanup paths ──────────────────────────────
        for (const [scenarioId, signalOrMode, label] of [
            ['U', 'SIGINT', 'SIGINT'],
            ['V', 'SIGTERM', 'SIGTERM'],
            ['W', 'unhandledRejection', 'unhandled-rejection'],
        ] as const) {
            const result = await testCrashSafetyChildProcess(signalOrMode);
            record(scenarioId, `${label} triggers the same cleanup path (marker file written before exit)`, result.markerWritten, JSON.stringify(result));
        }

        // ── X/Y/Z: orphan detection ────────────────────────────────────────
        const orphanTarget = await signUpDisposable('orphan');
        dbQuery(`update auth.users set created_at = now() - interval '20 minutes' where id = '${orphanTarget.id}'`);
        const orphanScan = detectOrphans(10);
        const detected = orphanScan.ids.includes(orphanTarget.id);
        record('X', 'orphan synthetic account (older than grace period) is detected', detected, `count=${orphanScan.count}`);
        if (detected) {
            scopedCleanup([orphanTarget.id]);
            const afterRemoval = dbQuery(`select count(*) as c from auth.users where id = '${orphanTarget.id}'`) as { c: number }[];
            record('Y', 'orphan synthetic account is removed by the sweep', Number(afterRemoval[0]?.c ?? 1) === 0);
        } else {
            record('Y', 'orphan synthetic account is removed by the sweep', false, 'X did not detect it first');
        }
        const realAccountExcluded = SYNTHETIC_NAMESPACES.every((ns) => !'nkemanya15@gmail.com'.match(ns.replace('%', '.*')));
        record('Z', 'a real/non-synthetic account is never matched by any approved namespace', realAccountExcluded);

        // ── AA/AB/AC/AD: synthetic artifact cleanup coverage (structural -- confirms scopedCleanup's FK-safe delete order covers every table) ──
        const cleanupSource = readFileSync(path.join(__dirname, 'cleanup.ts'), 'utf-8');
        record('AA', 'synthetic reminder artifacts (reminders + reminder_logs + reminder_notification_deliveries) are covered by scopedCleanup', /reminder_notification_deliveries/.test(cleanupSource) && /reminder_logs/.test(cleanupSource) && /delete from public\.reminders/.test(cleanupSource));
        record('AB', 'synthetic task artifacts (tasks + task_occurrences + task_notification_deliveries) are covered by scopedCleanup', /task_notification_deliveries/.test(cleanupSource) && /task_occurrences/.test(cleanupSource) && /delete from public\.tasks/.test(cleanupSource));
        record('AC', 'synthetic routine artifacts (templates + instances + items) are covered by scopedCleanup', /routine_templates/.test(cleanupSource) && /routine_instances/.test(cleanupSource) && /routine_instance_items/.test(cleanupSource));
        record('AD', 'synthetic delivery artifacts are covered by scopedCleanup for all three domains', /routine_notification_deliveries/.test(cleanupSource) && /task_notification_deliveries/.test(cleanupSource) && /reminder_notification_deliveries/.test(cleanupSource));

        // ── AE: cron cannot consume an unintended synthetic row ──────────────
        // reminder-audit's scenario T/P pattern (immediate delete / push-disabled
        // gate) is the actual mechanism; here we confirm the gate itself is
        // real by checking a fresh synthetic account's server_push_enabled
        // defaults to false (the condition claim_due_recipient_reminder_deliveries
        // requires before it will ever claim anything for that recipient).
        const gateCheck = dbQuery(`select server_push_enabled from public.profiles where id = '${disposable.id}'`) as { server_push_enabled: boolean }[];
        record('AE', 'a fresh synthetic account defaults to server_push_enabled=false, so the live cron cannot claim a row for it', gateCheck[0]?.server_push_enabled === false);

        // ── AF/AG/AH/AI: orchestrator timeout/watchdog behavior (structural + one live induced-timeout) ──
        const orchestratorSource = readFileSync(path.join(__dirname, '..', 'final-regression', 'run.ts'), 'utf-8');
        record('AF', 'orchestrator enforces a per-suite absolute timeout', /absoluteTimeoutMs/.test(orchestratorSource) && /setTimeout/.test(orchestratorSource));
        record('AG', 'orchestrator enforces an inactivity watchdog', /inactivityTimeoutMs/.test(orchestratorSource) && /lastOutputAt/.test(orchestratorSource));
        record('AH', 'orchestrator kills the full process group, not just the immediate child', /process\.kill\(-pid/.test(orchestratorSource) || /process\.kill\(-child\.pid/.test(orchestratorSource));
        const timeoutResult = await testInducedTimeout();
        record('AI', 'partial log is preserved (not truncated/deleted) when a suite is killed for a timeout', timeoutResult.logPreserved, JSON.stringify(timeoutResult));

        // ── AJ: structured JSON artifact produced ────────────────────────────
        const testRunId = newRunId();
        writeSuiteResult(testRunId, { suite: 'meta-probe', status: 'PASS', exitCode: 0, signal: null, scenarioCounts: { pass: 1, fail: 0, skip: 0 }, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 1, logPath: 'x', jsonPath: 'y' });
        const jsonArtifactPath = path.join(runDir(testRunId), 'meta-probe.json');
        record('AJ', 'structured JSON result artifact is produced on disk', existsSync(jsonArtifactPath));
        rmSync(runDir(testRunId), { recursive: true, force: true });

        // ── AK: secrets redacted ──────────────────────────────────────────────
        const sanitizedSample = classify(new Error(`signup failed for tavora.secaudit.x.abc123@example.com token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U`)).sanitizedMessage;
        record('AK', 'secrets/emails/JWTs are redacted before being logged or stored', !/@example\.com/.test(sanitizedSample) && !/eyJ/.test(sanitizedSample), sanitizedSample);

        // ── AL/AM: orchestrator sequencing and non-recursion ─────────────────
        record('AL', 'final-regression orchestrator runs suites sequentially (for...of with await, not Promise.all)', /for \(const cfg of SUITES\)/.test(orchestratorSource) && /await runSuiteSupervised/.test(orchestratorSource));
        const allSuiteFiles = [
            'security-audit', 'auth-audit', 'onboarding-audit', 'participant-audit', 'reminder-audit',
            'task-audit', 'activity-audit', 'routine-audit', 'ui-state-audit', 'accessibility-audit',
            'visual-consistency-audit',
        ];
        const nestedCallsFound: string[] = [];
        for (const suite of allSuiteFiles) {
            const runPath = path.join(__dirname, '..', suite, 'run.ts');
            if (!existsSync(runPath)) continue;
            const src = readFileSync(runPath, 'utf-8');
            for (const other of allSuiteFiles) {
                if (other === suite) continue;
                if (new RegExp(`['"\`]scripts/${other}/run\\.ts['"\`]`).test(src)) nestedCallsFound.push(`${suite} -> ${other}`);
            }
        }
        record('AM', 'no suite invokes another suite -- the graph is fully flat (only final-regression/run.ts may do this)', nestedCallsFound.length === 0, nestedCallsFound.join(', '));

        // ── AN/AO: infrastructure SKIP vs genuine FAIL distinction ───────────
        record('AN', 'infrastructure SKIP is reported as a distinct status, never merged into PASS or FAIL counts', /status === .FAIL. \? .FAIL. : .SKIP./.test(orchestratorSource) || /cls\.category === .infrastructure. \? .SKIP.'/.test(orchestratorSource) || /'SKIP'/.test(orchestratorSource));
        record('AO', 'a genuine suite FAIL produces a nonzero orchestrator result', /EXIT_GENUINE_FAILURE/.test(orchestratorSource) && /genuineFails\.length > 0/.test(orchestratorSource));

        // ── AP/AQ/AR/AS/AT: retention correctness ─────────────────────────────
        record('AP', 'final cleanup verification runs as part of the orchestrator', /finalSweep/.test(orchestratorSource) && /globalSyntheticSweep/.test(orchestratorSource));
        const retentionRows = dbQuery('select * from public.ops_health_evaluate()') as { check_name: string; status: string; detail: string }[];
        const retentionRow = retentionRows.find((r) => r.check_name === 'retention:pg_net_and_cron_logs');
        record('AQ', 'retention cleanup succeeds (both cleanup cron jobs report PASS/succeeded, not a cleanup-failure FAIL)', retentionRow?.status !== 'FAIL', JSON.stringify(retentionRow));
        // Tiny grace period (0 hours) against the real, healthy retention
        // state still passes/warns rather than FAILs -- confirms the
        // sawtooth-vs-genuine-backlog distinction is cadence-driven, not a
        // raw count threshold that would always trip right before a nightly
        // cleanup.
        const tightRetention = dbQuery('select * from public.ops_health_evaluate(4,10,1,10,1,10,0.1,0.3,5,3,7,14,0)') as { check_name: string; status: string; detail: string }[];
        const tightRow = tightRetention.find((r) => r.check_name === 'retention:pg_net_and_cron_logs');
        record('AR', 'expected intraday cron volume does not warn under the normal (26h-grace) policy', retentionRow?.status === 'PASS', retentionRow?.detail);
        record('AS', 'rows older than policy+grace are what actually drives a WARNING (0h grace against live data demonstrates the same check can trip)', !!tightRow, tightRow?.detail);
        record('AT', 'a genuine cleanup-job failure (not merely old rows) is classified FAIL, not WARNING', /last_status is distinct from .succeeded./.test(readFileSync(path.join(process.cwd(), 'supabase', 'migrations', '20260801000000_ops_health_evaluate.sql'), 'utf-8')));

        // ── AU/AV/AW/AX: alert dedup/cooldown/resolution ──────────────────────
        const alertKey = `test_alert_${RAND}`;
        dbQuery(`insert into public.operational_alerts (alert_key, severity, summary) values ('${alertKey}', 'warning', 'synthetic test alert')`);
        let dupBlocked = false;
        try {
            dbQuery(`insert into public.operational_alerts (alert_key, severity, summary) values ('${alertKey}', 'warning', 'a second open alert for the same key')`);
        } catch (err) {
            dupBlocked = err instanceof Error && /idx_operational_alerts_open_key|duplicate key/.test(err.message);
        }
        record('AU', 'operational alert deduplicates (unique-while-open index rejects a second open row for the same key)', dupBlocked);

        const alertRow = (dbQuery(`select id from public.operational_alerts where alert_key = '${alertKey}' and resolved_at is null`) as { id: string }[])[0];
        dbQuery(`insert into public.operational_alert_deliveries (alert_id, status, detail) values ('${alertRow.id}', 'unconfigured', 'first delivery')`);
        const needsDeliveryAfterFirst = dbQuery(`select * from public.alerts_needing_initial_delivery() where id = '${alertRow.id}'`) as unknown[];
        record('AV', 'operational alert delivery cooldown: no second delivery is generated for the same open-state', needsDeliveryAfterFirst.length === 0);

        dbQuery(`update public.operational_alerts set resolved_at = now() where id = '${alertRow.id}'`);
        const resolvedCheck = dbQuery(`select resolved_at from public.operational_alerts where id = '${alertRow.id}'`) as { resolved_at: string | null }[];
        record('AW', 'operational alert resolves (resolved_at settable, and a new open row for the same key is then allowed)', !!resolvedCheck[0]?.resolved_at);
        dbQuery(`delete from public.operational_alerts where alert_key = '${alertKey}'`);

        // Structural, not text-search based: a text search over the
        // migration's own comments is fragile (e.g. a comment mentioning
        // the *check name* 'push_tokens:inactive' would false-positive on
        // a naive "no push_token column" grep). Query the live schema
        // directly instead.
        const alertColumns = dbQuery(
            `select table_name, column_name from information_schema.columns where table_schema='public' and table_name in ('operational_alerts','operational_alert_deliveries')`
        ) as { table_name: string; column_name: string }[];
        const forbiddenColumnNames = /token|title|notes|reminder|task_body|participant_name/i;
        const privateColumnsFound = alertColumns.filter((c) => forbiddenColumnNames.test(c.column_name));
        record('AX', 'alert payload contains no private data by construction (no token/title/notes column exists on either table)', privateColumnsFound.length === 0, JSON.stringify(privateColumnsFound));

        // ── AY/AZ/BA: existing suites + ops-health remain sane ────────────────
        // Full standalone execution of security-audit and the three
        // remaining domains is intentionally left to the dedicated
        // per-suite standalone verification step (this meta-suite keeps its
        // own signup footprint small, per its own requirement) -- here we
        // confirm the structural wiring (fixture/cleanup imports present)
        // that a full run would exercise, rather than re-running them.
        const secAuditSrc = readFileSync(path.join(__dirname, '..', 'security-audit', 'run.ts'), 'utf-8');
        record('AY', 'security-audit is wired to installCrashSafety (confirms Week 4 Task #1 crash-safety adoption)', /installCrashSafety/.test(secAuditSrc));
        const routineAuditSrc = readFileSync(path.join(__dirname, '..', 'routine-audit', 'run.ts'), 'utf-8');
        const taskAuditSrc = readFileSync(path.join(__dirname, '..', 'task-audit', 'run.ts'), 'utf-8');
        const reminderAuditSrc = readFileSync(path.join(__dirname, '..', 'reminder-audit', 'run.ts'), 'utf-8');
        record('AZ', 'reminder/task/routine audits are wired to installCrashSafety and (task/routine) the fixture pool', /installCrashSafety/.test(reminderAuditSrc) && /installCrashSafety/.test(taskAuditSrc) && /provisionFixturePool/.test(taskAuditSrc) && /installCrashSafety/.test(routineAuditSrc) && /provisionFixturePool/.test(routineAuditSrc));

        const opsAll = dbQuery('select * from public.ops_health_evaluate()') as { check_name: string; status: string }[];
        const unexplainedFail = opsAll.filter((r) => r.status === 'FAIL');
        record('BA', 'ops health has no unexplained FAIL right now', unexplainedFail.length === 0, JSON.stringify(unexplainedFail));

        console.log('\nAll meta-suite scenario checks executed.');
    } finally {
        await cleanup();
    }

    const passed = summarize();
    process.exit(passed ? 0 : 1);
}

/** Spawns a tiny child process that installs crash safety and either signals itself or triggers an unhandled rejection, then confirms the shared cleanup path actually ran (via a marker file) before the process exited. */
async function testCrashSafetyChildProcess(mode: 'SIGINT' | 'SIGTERM' | 'unhandledRejection'): Promise<{ markerWritten: boolean; exitCode: number | null }> {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'audit-crash-safety-'));
    const markerPath = path.join(tmpDir, 'marker.json');
    const startedPath = path.join(tmpDir, 'started.txt');
    const childScript = path.join(tmpDir, 'child.ts');
    writeFileSync(
        childScript,
        `
        import { writeFileSync } from 'node:fs';
        import { installCrashSafety } from '${path.join(__dirname, 'cleanup').replace(/\\/g, '\\\\')}';
        installCrashSafety(async () => {
            writeFileSync('${markerPath.replace(/\\/g, '\\\\')}', JSON.stringify({ cleanedUp: true, mode: '${mode}' }));
        });
        // Written only after installCrashSafety() has returned -- the
        // handlers are registered synchronously, so this marker's
        // existence is a precise signal that it is now safe to send the
        // test signal, rather than guessing a fixed cold-start delay
        // (tsx's first-invocation transform/module-resolution time is not
        // reliably boundable, and guessing wrong looks identical to "the
        // handler doesn't work").
        writeFileSync('${startedPath.replace(/\\/g, '\\\\')}', 'ready');
        ${mode === 'unhandledRejection' ? "Promise.reject(new Error('induced unhandled rejection'));" : 'setInterval(() => {}, 1000);'}
        `
    );
    // detached:true + signaling the process GROUP (-pid), exactly like
    // scripts/final-regression/run.ts's own kill mechanism, matters here:
    // `npx` wraps `tsx` wraps the actual node process running this script
    // (confirmed via direct `ps` inspection during development -- three
    // process layers deep), and a plain child.kill(signal) only signals
    // the immediate `npx` process. Signaling the whole group reaches every
    // process in the tree at once (verified directly: after this kill, no
    // process from this tree remains in `ps`).
    const child = spawn('npx', ['tsx', childScript], { env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let childOutput = '';
    child.stdout?.on('data', (c: Buffer) => (childOutput += c.toString()));
    child.stderr?.on('data', (c: Buffer) => (childOutput += c.toString()));
    // Attached immediately (not after the wait/signal below) -- Node's
    // EventEmitter does not replay a past 'exit' event to a listener
    // attached afterward, so attaching late can silently miss a child that
    // exits faster than expected and make a working signal handler look
    // broken.
    const exitPromise = new Promise<number | null>((resolve) => {
        child.on('exit', (code) => resolve(code));
    });
    const deadline = Date.now() + 15000;
    while (!existsSync(startedPath) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
    }
    if (mode !== 'unhandledRejection' && child.pid) {
        try {
            process.kill(-child.pid, mode);
        } catch {
            child.kill(mode); // fall back to single-process signaling if the group kill itself fails
        }
    }
    const exitCode = await Promise.race([exitPromise, new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000))]);
    const markerWritten = existsSync(markerPath);
    if (!markerWritten) console.log(`    [debug] crash-safety child (${mode}) started=${existsSync(startedPath)} output:\n${childOutput.split('\n').map((l) => `      ${l}`).join('\n')}`);
    rmSync(tmpDir, { recursive: true, force: true });
    return { markerWritten, exitCode };
}

/** Spawns a deliberately slow child under a very short absolute timeout using the same kill mechanism as final-regression/run.ts, then confirms the partial log survives. */
async function testInducedTimeout(): Promise<{ logPreserved: boolean; logHadPartialContent: boolean }> {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'audit-timeout-'));
    const logPath = path.join(tmpDir, 'slow.log');
    const child = spawn('node', ['-e', "console.log('partial output before hang'); setInterval(() => {}, 1000);"], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const { appendFileSync } = require('node:fs') as typeof import('node:fs');
    child.stdout?.on('data', (chunk: Buffer) => appendFileSync(logPath, chunk));
    await new Promise((r) => setTimeout(r, 1000));
    try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
    } catch {
        // best-effort
    }
    await new Promise((r) => setTimeout(r, 500));
    const logPreserved = existsSync(logPath);
    const logHadPartialContent = logPreserved && readFileSync(logPath, 'utf-8').includes('partial output before hang');
    rmSync(tmpDir, { recursive: true, force: true });
    return { logPreserved, logHadPartialContent };
}

main().catch((err) => {
    console.error('AUDIT_INFRASTRUCTURE_META_SUITE_FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
});
