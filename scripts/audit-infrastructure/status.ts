// Inspect an orchestrated run in progress or after interruption, without
// waiting for the orchestrator itself to unblock (Phase 9). Reads only
// files and process state from a separate invocation -- never talks to the
// orchestrator process directly.
//
// Usage: npx tsx scripts/audit-infrastructure/status.ts [run-id]
// With no run-id, lists the most recent runs under artifacts/audits/.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ARTIFACTS_ROOT = path.join(process.cwd(), 'artifacts', 'audits');

function listRuns(): string[] {
    if (!existsSync(ARTIFACTS_ROOT)) return [];
    return readdirSync(ARTIFACTS_ROOT)
        .filter((name) => statSync(path.join(ARTIFACTS_ROOT, name)).isDirectory())
        .sort()
        .reverse();
}

function tail(filePath: string, lines: number): string {
    if (!existsSync(filePath)) return '(no log yet)';
    const content = readFileSync(filePath, 'utf-8');
    return content.split('\n').slice(-lines).join('\n');
}

/** Any live `tsx` process running one of this repo's audit scripts -- not scoped to a single PID, since the orchestrator/suite processes are separate from this inspection process by design (Phase 9's "inspect without waiting on the orchestrator to unblock"). */
function liveAuditProcesses(): string {
    try {
        const all = execFileSync('ps', ['-axo', 'pid,ppid,etime,stat,command'], { encoding: 'utf-8' });
        const lines = all.split('\n');
        const header = lines[0];
        const matches = lines.filter((l) => /tsx\s+scripts\//.test(l));
        return matches.length > 0 ? [header, ...matches].join('\n') : '(none found -- no orchestrator or suite process currently running)';
    } catch {
        return '(ps unavailable)';
    }
}

function main() {
    const runId = process.argv[2];
    if (!runId) {
        const runs = listRuns();
        if (runs.length === 0) {
            console.log('No runs found under artifacts/audits/.');
            return;
        }
        console.log('Recent runs (newest first):');
        for (const r of runs.slice(0, 10)) console.log(`  ${r}`);
        console.log('\nRun again with a run-id to inspect it: npx tsx scripts/audit-infrastructure/status.ts <run-id>');
        return;
    }

    const dir = path.join(ARTIFACTS_ROOT, runId);
    if (!existsSync(dir)) {
        console.error(`No such run: ${runId}`);
        process.exit(1);
    }

    const summaryPath = path.join(dir, 'summary.json');
    if (existsSync(summaryPath)) {
        const summary = JSON.parse(readFileSync(summaryPath, 'utf-8'));
        console.log(`Run ${runId} -- summary.json present (${summary.interrupted ? 'INTERRUPTED' : 'complete'}):`);
        console.log(JSON.stringify(summary, null, 2));
        return;
    }

    console.log(`Run ${runId} -- no summary.json yet (still in progress or crashed before writing one).\n`);

    const files = readdirSync(dir);
    const suiteJsonFiles = files.filter((f) => f.endsWith('.json') && f !== 'environment.json' && f !== 'cleanup-report.json');
    const logFiles = files.filter((f) => f.endsWith('.log'));

    console.log('Suites with a recorded outcome so far:');
    for (const f of suiteJsonFiles) {
        const data = JSON.parse(readFileSync(path.join(dir, f), 'utf-8'));
        console.log(`  ${data.suite}: ${data.status} (exit ${data.exitCode}) -- ${data.scenarioCounts?.pass ?? '?'} pass / ${data.scenarioCounts?.fail ?? '?'} fail / ${data.scenarioCounts?.skip ?? '?'} skip`);
    }

    const inProgress = logFiles
        .map((f) => f.replace(/\.log$/, ''))
        .filter((suite) => !suiteJsonFiles.some((f) => f.startsWith(suite)));
    if (inProgress.length > 0) {
        console.log('\nSuite(s) with a log but no recorded outcome yet (likely still running or killed mid-run):');
        for (const suite of inProgress) {
            const logPath = path.join(dir, `${suite}.log`);
            const stat = statSync(logPath);
            const ageSeconds = Math.round((Date.now() - stat.mtimeMs) / 1000);
            console.log(`  ${suite} -- log last updated ${ageSeconds}s ago`);
            console.log('  Last 20 lines:');
            console.log(tail(logPath, 20).split('\n').map((l) => `    ${l}`).join('\n'));
        }
    }

    console.log('\nLive audit-related `tsx` processes on this machine:');
    console.log(liveAuditProcesses());
}

main();
