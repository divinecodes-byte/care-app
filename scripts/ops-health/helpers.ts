// Shared helpers for the ops-health report. Never prints a secret — every
// query here runs through the already-authenticated `supabase` CLI
// (`supabase db query --linked`), not a raw connection string or key held
// in this script.

import { execFileSync } from 'node:child_process';

const NOISE_LINE = /^(Initialising login role|A new version of Supabase CLI|We recommend updating)/;

export function dbQuery(sql: string, attempt = 1): unknown[] {
    let out: string;
    try {
        out = execFileSync('supabase', ['db', 'query', '--linked', '-o', 'json', sql], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (err) {
        if (attempt < 3) {
            execFileSync('sleep', [String(attempt * 1.5)]);
            return dbQuery(sql, attempt + 1);
        }
        throw err;
    }
    const jsonBlob = out
        .split('\n')
        .filter((line) => !NOISE_LINE.test(line.trim()))
        .join('\n')
        .trim();
    if (!jsonBlob) return [];
    const parsed = JSON.parse(jsonBlob);
    return parsed.rows ?? [];
}

export type Status = 'PASS' | 'WARNING' | 'FAIL';

export type CheckResult = { name: string; status: Status; detail: string };

const results: CheckResult[] = [];

export function check(name: string, status: Status, detail: string): CheckResult {
    const r = { name, status, detail };
    results.push(r);
    return r;
}

export function getResults(): CheckResult[] {
    return results;
}

export function overallStatus(): Status {
    if (results.some((r) => r.status === 'FAIL')) return 'FAIL';
    if (results.some((r) => r.status === 'WARNING')) return 'WARNING';
    return 'PASS';
}

export function num(row: Record<string, unknown> | undefined, key: string): number {
    if (!row) return 0;
    const v = row[key];
    if (v === null || v === undefined) return 0;
    return typeof v === 'number' ? v : Number(v);
}
