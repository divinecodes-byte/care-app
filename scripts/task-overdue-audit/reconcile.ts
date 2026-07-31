// One-off reconciliation tool (not part of the audit suite itself). Parses
// run.ts's own source for every literal record()/skip() id, actually runs
// the suite as a child process, parses its real stdout, and diffs the two
// -- no hand-counting, no inference. Prints a full ledger.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const SUITE_PATH = 'scripts/task-overdue-audit/run.ts';
const source = readFileSync(path.join(process.cwd(), SUITE_PATH), 'utf-8');

type Occ = { id: string; kind: 'record' | 'skip'; line: number };

function findOccurrences(src: string): Occ[] {
    const out: Occ[] = [];
    const lines = src.split('\n');
    lines.forEach((lineText, idx) => {
        for (const m of lineText.matchAll(/\brecord\('([^']+)',/g)) out.push({ id: m[1], kind: 'record', line: idx + 1 });
        for (const m of lineText.matchAll(/\bskip\('([^']+)',/g)) out.push({ id: m[1], kind: 'skip', line: idx + 1 });
    });
    return out;
}

const expectedOcc = findOccurrences(source);
const expectedScenarioOcc = expectedOcc.filter((o) => o.id !== 'cleanup');
const expectedCleanupOcc = expectedOcc.filter((o) => o.id === 'cleanup');

const expectedScenarioIds = new Set(expectedScenarioOcc.map((o) => o.id));
const expectedDupCounts = new Map<string, number>();
for (const o of expectedScenarioOcc) expectedDupCounts.set(o.id, (expectedDupCounts.get(o.id) ?? 0) + 1);
const expectedDuplicateIds = [...expectedDupCounts.entries()].filter(([, c]) => c > 1);

console.log(`Expected scenario IDs parsed from ${SUITE_PATH} source: ${expectedScenarioIds.size} unique (${expectedScenarioOcc.length} literal record()/skip() statements, cleanup excluded)`);
console.log([...expectedScenarioIds].sort().join(', '));
console.log(`\nExpected duplicate IDs (appear >1x as literal calls in source):`);
if (expectedDuplicateIds.length === 0) console.log('  (none)');
for (const [id, count] of expectedDuplicateIds) {
    const lines = expectedScenarioOcc.filter((o) => o.id === id).map((o) => o.line);
    console.log(`  ${id}: ${count}x at lines ${lines.join(', ')}`);
}
console.log(`\nExpected cleanup literal occurrences: ${expectedCleanupOcc.length} (lines ${expectedCleanupOcc.map((o) => o.line).join(', ')})`);

// ── Actually run the suite and capture real stdout ──────────────────────
console.log(`\nRunning ${SUITE_PATH} for real (this will create/clean up synthetic data)...\n`);
const result = spawnSync('npx', ['tsx', SUITE_PATH], { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
const stdout = result.stdout ?? '';
const stderr = result.stderr ?? '';
console.log('--- raw suite stdout follows (for audit trail) ---');
console.log(stdout);
if (stderr.trim()) {
    console.log('--- raw suite stderr follows ---');
    console.log(stderr);
}
console.log(`--- suite exit code: ${result.status} ---\n`);

type ExecOcc = { id: string; status: 'PASS' | 'FAIL' | 'SKIP'; desc: string };
const execOcc: ExecOcc[] = [];
for (const lineText of stdout.split('\n')) {
    const m = lineText.match(/^\[(PASS|FAIL|SKIP)\] (\S+) — (.+)$/);
    if (m) execOcc.push({ id: m[2], status: m[1] as ExecOcc['status'], desc: m[3] });
}

const execScenarioOcc = execOcc.filter((o) => o.id !== 'cleanup');
const execCleanupOcc = execOcc.filter((o) => o.id === 'cleanup');

const executedScenarioIds = new Set(execScenarioOcc.map((o) => o.id));
const execDupCounts = new Map<string, number>();
for (const o of execScenarioOcc) execDupCounts.set(o.id, (execDupCounts.get(o.id) ?? 0) + 1);
const executedDuplicateIds = [...execDupCounts.entries()].filter(([, c]) => c > 1);

const missingIds = [...expectedScenarioIds].filter((id) => !executedScenarioIds.has(id));
const unexpectedIds = [...executedScenarioIds].filter((id) => !expectedScenarioIds.has(id));

const passOcc = execScenarioOcc.filter((o) => o.status === 'PASS');
const failOcc = execScenarioOcc.filter((o) => o.status === 'FAIL');
const skipOcc = execScenarioOcc.filter((o) => o.status === 'SKIP');

console.log('══════════════════════════════════════════════════════════════');
console.log('RECONCILIATION');
console.log('══════════════════════════════════════════════════════════════');
console.log(`Executed scenario occurrences (excl. cleanup): ${execScenarioOcc.length}, unique IDs: ${executedScenarioIds.size}`);
console.log(`\nExecuted duplicate IDs (same ID recorded >1x this run):`);
if (executedDuplicateIds.length === 0) console.log('  (none)');
for (const [id, count] of executedDuplicateIds) console.log(`  ${id}: ${count}x`);

console.log(`\nMissing IDs (expected in source, never executed this run): ${missingIds.length}`);
if (missingIds.length) console.log('  ' + missingIds.sort().join(', '));

console.log(`\nUnexpected IDs (executed but not found as a literal id in source): ${unexpectedIds.length}`);
if (unexpectedIds.length) console.log('  ' + unexpectedIds.sort().join(', '));

console.log(`\nPASS IDs (${passOcc.length}):`);
console.log('  ' + passOcc.map((o) => o.id).join(', '));

console.log(`\nFAIL IDs (${failOcc.length}):`);
if (failOcc.length === 0) console.log('  (none)');
for (const o of failOcc) console.log(`  ${o.id}: ${o.desc}`);

console.log(`\nSKIP IDs with reasons (${skipOcc.length}):`);
for (const o of skipOcc) console.log(`  ${o.id}: ${o.desc}`);

console.log(`\nScenario-only totals: ${passOcc.length} PASS / ${failOcc.length} FAIL / ${skipOcc.length} SKIP = ${execScenarioOcc.length} total occurrences (${executedScenarioIds.size} unique IDs)`);

console.log(`\nCleanup (reported separately, not part of scenario totals):`);
for (const o of execCleanupOcc) console.log(`  [${o.status}] cleanup — ${o.desc}`);
if (execCleanupOcc.length === 0) console.log('  (cleanup never ran / not found in output)');

console.log('══════════════════════════════════════════════════════════════');
process.exit(result.status === 0 && failOcc.length === 0 ? 0 : 1);
