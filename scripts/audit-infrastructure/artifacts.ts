// Artifact directory writer (Phase 10). Every orchestrated run gets
// artifacts/audits/<run-id>/ containing per-suite logs + JSON results, an
// aggregate summary, a cleanup report, and environment metadata. Never
// committed to git (see .gitignore).

import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { sanitize } from './classify';
import type { SuiteOutcome } from './types';

const ARTIFACTS_ROOT = path.join(process.cwd(), 'artifacts', 'audits');

export function runDir(runId: string): string {
    const dir = path.join(ARTIFACTS_ROOT, runId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
}

export function newRunId(): string {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const rand = Math.random().toString(36).slice(2, 8);
    return `${ts}-${rand}`;
}

export function suiteLogPath(runId: string, suite: string): string {
    return path.join(runDir(runId), `${suite}.log`);
}

export function suiteJsonPath(runId: string, suite: string): string {
    return path.join(runDir(runId), `${suite}.json`);
}

/** Appends one line to a suite's log file -- safe to call repeatedly as output streams in; never overwrites. */
export function appendSuiteLog(runId: string, suite: string, line: string): void {
    appendFileSync(suiteLogPath(runId, suite), sanitize(line) + '\n');
}

export function writeSuiteResult(runId: string, outcome: SuiteOutcome): void {
    writeFileSync(suiteJsonPath(runId, outcome.suite), JSON.stringify(sanitizeOutcome(outcome), null, 2));
}

function sanitizeOutcome(outcome: SuiteOutcome): SuiteOutcome {
    return { ...outcome, logPath: path.relative(process.cwd(), outcome.logPath), jsonPath: path.relative(process.cwd(), outcome.jsonPath) };
}

export function writeSummary(runId: string, outcomes: SuiteOutcome[], extra: Record<string, unknown> = {}): void {
    writeFileSync(path.join(runDir(runId), 'summary.json'), JSON.stringify({ runId, generatedAt: new Date().toISOString(), suites: outcomes, ...extra }, null, 2));
}

export function writeCleanupReport(runId: string, report: unknown): void {
    writeFileSync(path.join(runDir(runId), 'cleanup-report.json'), JSON.stringify(report, null, 2));
}

function safeExec(cmd: string, args: string[]): string {
    try {
        return execFileSync(cmd, args, { encoding: 'utf-8', timeout: 10_000 }).trim();
    } catch {
        return 'unavailable';
    }
}

export function writeEnvironmentMetadata(runId: string): void {
    const gitCommit = safeExec('git', ['rev-parse', 'HEAD']);
    const migrationStatus = safeExec('supabase', ['migration', 'list', '--linked']);
    const nodeVersion = process.version;
    let expoVersion = 'unavailable';
    try {
        const pkg = JSON.parse(require('node:fs').readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
        expoVersion = pkg.dependencies?.expo ?? 'unavailable';
    } catch {
        // best-effort only
    }
    writeFileSync(
        path.join(runDir(runId), 'environment.json'),
        JSON.stringify({ runId, gitCommit, migrationStatus: sanitize(migrationStatus), nodeVersion, expoVersion, capturedAt: new Date().toISOString() }, null, 2)
    );
}

/** Synchronous-only -- safe to call from a signal handler or the `exit` event. Never awaits anything. */
export function writeInterruptedMarker(runId: string, suite: string, lastKnownScenario: string | null): void {
    try {
        writeFileSync(
            path.join(runDir(runId), `${suite}.interrupted.json`),
            JSON.stringify({ suite, interruptedAt: new Date().toISOString(), lastKnownScenario }, null, 2)
        );
    } catch {
        // best-effort -- never throw from an interrupt path
    }
}
