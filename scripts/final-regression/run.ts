// Canonical final-regression orchestrator (Week 4 Task #1, Phase 8).
//
// The ONLY place any complete audit suite is invoked from another script.
// Every suite below runs its own scenarios only -- the DAG-flattening pass
// removed every nested "regression check" that used to call out to other
// suites (see docs/audit-infrastructure-model.md for the full before/after).
// This orchestrator runs each suite exactly once, sequentially, supervised
// via async `spawn` (never `execFileSync`) so a stalled suite can be
// detected and terminated without blocking this process, with streamed
// logs, an absolute timeout, an inactivity watchdog, and a cooldown
// between signup-heavy suites to reduce Supabase rate-limit pressure.
//
// Usage:
//   npx tsx scripts/final-regression/run.ts
//   npx tsx scripts/final-regression/run.ts --only security-audit,ops-health
//
// Exit codes (docs/final-regression-runbook.md):
//   0 -- every required suite PASS, cleanup verified zero
//   1 -- a genuine FAIL, or a destructive-cleanup failure
//   2 -- one or more infrastructure SKIPs remain unresolved
//   3 -- orchestrator/configuration failure (fixture-pool corruption, etc.)

import { spawn } from 'node:child_process';
import path from 'node:path';
import { classify } from '../audit-infrastructure/classify';
import { newRunId, runDir, appendSuiteLog, writeSuiteResult, writeSummary, writeCleanupReport, writeEnvironmentMetadata } from '../audit-infrastructure/artifacts';
import { detectOrphans, globalSyntheticSweep, installCrashSafety } from '../audit-infrastructure/cleanup';
import { detectFixtureContamination, provisionFixturePool } from '../audit-infrastructure/fixtures';
import { EXIT_OK, EXIT_GENUINE_FAILURE, EXIT_UNRESOLVED_SKIP, EXIT_ORCHESTRATOR_FAILURE, SuiteOutcome } from '../audit-infrastructure/types';

type SuiteCategory = 'security' | 'signup-heavy' | 'static';

type SuiteConfig = {
    suite: string;
    script: string;
    category: SuiteCategory;
    absoluteTimeoutMs: number;
    inactivityTimeoutMs: number;
};

const DEFAULT_ABSOLUTE_TIMEOUT_MS = 20 * 60 * 1000; // 20 min
const DEFAULT_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
const COOLDOWN_AFTER_SIGNUP_HEAVY_MS = 5 * 1000;

// Dependency order per docs/final-regression-runbook.md -- may change if a
// future suite introduces a genuine fixture/data dependency, but today none
// of these suites depend on another's leftover state (every suite cleans
// itself up).
const SUITES: SuiteConfig[] = [
    { suite: 'security-audit', script: 'scripts/security-audit/run.ts', category: 'security', absoluteTimeoutMs: DEFAULT_ABSOLUTE_TIMEOUT_MS, inactivityTimeoutMs: DEFAULT_INACTIVITY_TIMEOUT_MS },
    { suite: 'auth-audit', script: 'scripts/auth-audit/run.ts', category: 'signup-heavy', absoluteTimeoutMs: DEFAULT_ABSOLUTE_TIMEOUT_MS, inactivityTimeoutMs: DEFAULT_INACTIVITY_TIMEOUT_MS },
    { suite: 'onboarding-audit', script: 'scripts/onboarding-audit/run.ts', category: 'signup-heavy', absoluteTimeoutMs: DEFAULT_ABSOLUTE_TIMEOUT_MS, inactivityTimeoutMs: DEFAULT_INACTIVITY_TIMEOUT_MS },
    { suite: 'participant-audit', script: 'scripts/participant-audit/run.ts', category: 'signup-heavy', absoluteTimeoutMs: DEFAULT_ABSOLUTE_TIMEOUT_MS, inactivityTimeoutMs: DEFAULT_INACTIVITY_TIMEOUT_MS },
    { suite: 'reminder-audit', script: 'scripts/reminder-audit/run.ts', category: 'signup-heavy', absoluteTimeoutMs: DEFAULT_ABSOLUTE_TIMEOUT_MS, inactivityTimeoutMs: DEFAULT_INACTIVITY_TIMEOUT_MS },
    { suite: 'reminder-audit-tz-race', script: 'scripts/reminder-audit/timezone-and-schedule-race.ts', category: 'signup-heavy', absoluteTimeoutMs: DEFAULT_ABSOLUTE_TIMEOUT_MS, inactivityTimeoutMs: DEFAULT_INACTIVITY_TIMEOUT_MS },
    { suite: 'task-audit', script: 'scripts/task-audit/run.ts', category: 'signup-heavy', absoluteTimeoutMs: DEFAULT_ABSOLUTE_TIMEOUT_MS, inactivityTimeoutMs: DEFAULT_INACTIVITY_TIMEOUT_MS },
    { suite: 'activity-audit', script: 'scripts/activity-audit/run.ts', category: 'signup-heavy', absoluteTimeoutMs: DEFAULT_ABSOLUTE_TIMEOUT_MS, inactivityTimeoutMs: DEFAULT_INACTIVITY_TIMEOUT_MS },
    { suite: 'routine-audit', script: 'scripts/routine-audit/run.ts', category: 'signup-heavy', absoluteTimeoutMs: DEFAULT_ABSOLUTE_TIMEOUT_MS, inactivityTimeoutMs: DEFAULT_INACTIVITY_TIMEOUT_MS },
    { suite: 'multi-organizer-audit', script: 'scripts/multi-organizer-audit/run.ts', category: 'signup-heavy', absoluteTimeoutMs: DEFAULT_ABSOLUTE_TIMEOUT_MS, inactivityTimeoutMs: DEFAULT_INACTIVITY_TIMEOUT_MS },
    { suite: 'ui-state-audit', script: 'scripts/ui-state-audit/run.ts', category: 'signup-heavy', absoluteTimeoutMs: DEFAULT_ABSOLUTE_TIMEOUT_MS, inactivityTimeoutMs: DEFAULT_INACTIVITY_TIMEOUT_MS },
    { suite: 'accessibility-audit', script: 'scripts/accessibility-audit/run.ts', category: 'static', absoluteTimeoutMs: 5 * 60 * 1000, inactivityTimeoutMs: 3 * 60 * 1000 },
    { suite: 'visual-consistency-audit', script: 'scripts/visual-consistency-audit/run.ts', category: 'static', absoluteTimeoutMs: 5 * 60 * 1000, inactivityTimeoutMs: 3 * 60 * 1000 },
    { suite: 'ops-health', script: 'scripts/ops-health/run.ts', category: 'static', absoluteTimeoutMs: 5 * 60 * 1000, inactivityTimeoutMs: 3 * 60 * 1000 },
];

function parseOnlyFlag(): Set<string> | null {
    const arg = process.argv.find((a) => a.startsWith('--only'));
    if (!arg) return null;
    const value = arg.includes('=') ? arg.split('=')[1] : process.argv[process.argv.indexOf(arg) + 1];
    if (!value) return null;
    return new Set(value.split(',').map((s) => s.trim()).filter(Boolean));
}

/** Supervises one suite as a detached process group -- streamed logs, absolute timeout, inactivity watchdog, full process-group termination. Never uses execFileSync. */
function runSuiteSupervised(runId: string, cfg: SuiteConfig): Promise<SuiteOutcome> {
    return new Promise((resolve) => {
        const startedAt = new Date().toISOString();
        const startedAtMs = Date.now();
        let lastOutputAt = Date.now();
        let settled = false;
        let killedReason: 'absolute_timeout' | 'inactivity_timeout' | null = null;

        const child = spawn('npx', ['tsx', cfg.script], {
            cwd: process.cwd(),
            env: process.env,
            detached: true, // own process group -- lets us kill the whole tree, not just the immediate child
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        const onLine = (chunk: Buffer) => {
            lastOutputAt = Date.now();
            appendSuiteLog(runId, cfg.suite, chunk.toString('utf-8').replace(/\n$/, ''));
        };
        child.stdout?.on('data', onLine);
        child.stderr?.on('data', onLine);

        const inactivityInterval = setInterval(() => {
            if (settled) return;
            if (Date.now() - lastOutputAt > cfg.inactivityTimeoutMs) {
                killedReason = 'inactivity_timeout';
                killProcessGroup(child.pid);
            }
        }, 5000);

        const absoluteTimer = setTimeout(() => {
            if (settled) return;
            killedReason = 'absolute_timeout';
            killProcessGroup(child.pid);
        }, cfg.absoluteTimeoutMs);

        child.on('exit', (code, signal) => {
            settled = true;
            clearInterval(inactivityInterval);
            clearTimeout(absoluteTimer);

            const durationMs = Date.now() - startedAtMs;
            const finishedAt = new Date().toISOString();
            const logPath = path.join(runDir(runId), `${cfg.suite}.log`);
            const jsonPath = path.join(runDir(runId), `${cfg.suite}.json`);

            let status: SuiteOutcome['status'] = code === 0 ? 'PASS' : 'FAIL';
            let scenarioCounts = { pass: 0, fail: 0, skip: 0 };
            try {
                const { readFileSync } = require('node:fs') as typeof import('node:fs');
                const fullLog = readFileSync(logPath, 'utf-8');
                const summaryMatch = fullLog.match(/(\d+)\/(\d+) tests passed(?:, (\d+) failed, (\d+) skipped)?/);
                if (summaryMatch) {
                    const total = Number(summaryMatch[2]);
                    const passed = Number(summaryMatch[1]);
                    const failed = summaryMatch[3] ? Number(summaryMatch[3]) : Math.max(total - passed, 0);
                    const skipped = summaryMatch[4] ? Number(summaryMatch[4]) : 0;
                    scenarioCounts = { pass: passed, fail: failed, skip: skipped };
                }
                if (killedReason) {
                    const cls = classify(new Error(`child_process_${killedReason}`));
                    status = 'SKIP';
                    appendSuiteLog(runId, cfg.suite, `\n[orchestrator] suite terminated: ${killedReason} (classified ${cls.code}, category=${cls.category})`);
                } else if (code !== 0 && signal) {
                    status = 'SKIP'; // killed by something else (e.g. an external signal) -- not attributable as a product FAIL
                } else if (code !== 0) {
                    // Distinguish infra noise from a genuine failure using the same
                    // classifier every suite's own nested-call handling used to use
                    // locally -- now centralized.
                    const cls = classify(new Error(fullLog.slice(-2000)));
                    status = cls.category === 'infrastructure' ? 'SKIP' : 'FAIL';
                }
            } catch {
                // best-effort parsing only
            }

            const outcome: SuiteOutcome = {
                suite: cfg.suite,
                status,
                exitCode: code,
                signal,
                scenarioCounts,
                startedAt,
                finishedAt,
                durationMs,
                logPath,
                jsonPath,
            };
            writeSuiteResult(runId, outcome);
            resolve(outcome);
        });
    });
}

function killProcessGroup(pid: number | undefined) {
    if (!pid) return;
    try {
        process.kill(-pid, 'SIGTERM');
    } catch {
        // already gone
    }
    const killTimer = setTimeout(() => {
        try {
            process.kill(-pid, 'SIGKILL');
        } catch {
            // already gone
        }
    }, 5000);
    (killTimer as unknown as NodeJS.Timeout).unref?.();
}

async function main() {
    const runId = newRunId();
    const only = parseOnlyFlag();
    console.log(`Final regression run ${runId}${only ? ` (--only ${[...only].join(',')})` : ''}\n`);

    writeEnvironmentMetadata(runId);

    // Layer 3 (docs/audit-infrastructure-model.md#crash-safety): startup
    // orphan detection catches whatever a SIGKILL/OOM/machine-shutdown left
    // behind that no in-process handler could ever have observed.
    const orphans = detectOrphans();
    if (orphans.count > 0) {
        console.log(`Startup orphan scan: ${orphans.count} synthetic account(s) older than the grace period found -- sweeping before proceeding.`);
        const sweepReport = globalSyntheticSweep({ dryRun: false, destructive: true, includeFixtures: false });
        writeCleanupReport(runId, { phase: 'startup-orphan-sweep', ...sweepReport });
        if (!sweepReport.ok) {
            console.error('Startup orphan sweep did not reach zero -- stopping rather than running suites against unknown synthetic state.');
            process.exit(EXIT_ORCHESTRATOR_FAILURE);
        }
    }

    // Fixture pool pre-flight -- fail loudly rather than let a suite run
    // against a partially-reset pool (docs/synthetic-fixture-model.md).
    try {
        await provisionFixturePool();
        detectFixtureContamination();
    } catch (err) {
        console.error('Fixture pool pre-flight failed:', err instanceof Error ? err.message : err);
        process.exit(EXIT_ORCHESTRATOR_FAILURE);
    }

    const outcomes: SuiteOutcome[] = [];
    let stoppedEarly = false;

    installCrashSafety(async () => {
        writeSummary(runId, outcomes, { interrupted: true });
    });

    for (const cfg of SUITES) {
        if (only && !only.has(cfg.suite)) continue;

        console.log(`\n── ${cfg.suite} ──────────────────────────────────────────`);
        const outcome = await runSuiteSupervised(runId, cfg);
        outcomes.push(outcome);
        console.log(`  ${outcome.status} (exit ${outcome.exitCode}${outcome.signal ? `, signal ${outcome.signal}` : ''}) in ${(outcome.durationMs / 1000).toFixed(1)}s -- ${outcome.scenarioCounts.pass} pass / ${outcome.scenarioCounts.fail} fail / ${outcome.scenarioCounts.skip} skip`);

        if (outcome.status === 'FAIL' && cfg.category === 'security') {
            console.error(`\nStopping: a genuine FAIL in a security-category suite (${cfg.suite}) -- not continuing to later suites.`);
            stoppedEarly = true;
            break;
        }
        if (cfg.category === 'signup-heavy') {
            await new Promise((r) => setTimeout(r, COOLDOWN_AFTER_SIGNUP_HEAVY_MS));
        }
    }

    // Final global-cleanup verification (last orchestrator step per
    // docs/final-regression-runbook.md's suite order).
    const finalSweep = globalSyntheticSweep({ dryRun: false, destructive: true, includeFixtures: false });
    writeCleanupReport(runId, { phase: 'final-verification', ...finalSweep });
    if (!finalSweep.ok) {
        console.error('\nFinal cleanup verification did not reach zero synthetic accounts.');
    }

    const genuineFails = outcomes.filter((o) => o.status === 'FAIL');
    const unresolvedSkips = outcomes.filter((o) => o.status === 'SKIP');

    writeSummary(runId, outcomes, {
        stoppedEarly,
        genuineFailCount: genuineFails.length,
        unresolvedSkipCount: unresolvedSkips.length,
        cleanupOk: finalSweep.ok,
    });

    console.log(`\n──────────────────────────────────────────`);
    console.log(`${outcomes.filter((o) => o.status === 'PASS').length}/${outcomes.length} suites PASS, ${genuineFails.length} FAIL, ${unresolvedSkips.length} unresolved SKIP`);
    if (genuineFails.length > 0) console.log('FAILED:', genuineFails.map((o) => o.suite).join(', '));
    if (unresolvedSkips.length > 0) console.log('SKIPPED (run standalone to independently verify):', unresolvedSkips.map((o) => o.suite).join(', '));
    console.log(`Artifacts: artifacts/audits/${runId}/`);
    console.log(`──────────────────────────────────────────`);

    if (!finalSweep.ok || genuineFails.length > 0) process.exit(EXIT_GENUINE_FAILURE);
    if (unresolvedSkips.length > 0) process.exit(EXIT_UNRESOLVED_SKIP);
    process.exit(EXIT_OK);
}

main().catch((err) => {
    console.error('FINAL_REGRESSION_ORCHESTRATOR_FAILED:', err instanceof Error ? err.message : err);
    process.exit(EXIT_ORCHESTRATOR_FAILURE);
});
