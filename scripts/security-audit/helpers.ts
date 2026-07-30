// Shared helpers for the security-audit test suite. Never reads or prints a
// secret value — the anon/publishable key is the only credential used
// directly by this script (the same key already bundled into the mobile
// app, so using it here matches what a real client/attacker can do).
// Verification/setup that genuinely needs elevated access shells out to the
// already-authenticated `supabase` CLI (`supabase db query --linked`)
// rather than embedding a service-role key in this script at all.

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';

export const SUPABASE_URL = requireEnv('EXPO_PUBLIC_SUPABASE_URL');
export const ANON_KEY = requireEnv('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY');

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required env var ${name}`);
    return value;
}

export function newClient(): SupabaseClient {
    return createClient(SUPABASE_URL, ANON_KEY);
}

export function randomSuffix(): string {
    return Math.random().toString(36).slice(2, 10);
}

/**
 * Runs a read-only-by-convention SQL statement via the authenticated
 * `supabase` CLI and returns the parsed rows. Used only for test
 * setup/verification/cleanup of synthetic data this script itself created —
 * never as part of an "attack" being tested (those go through the anon key
 * exactly like a real client would).
 */
const NOISE_LINE = /^(Initialising login role|A new version of Supabase CLI|We recommend updating)/;

export function dbQuery(sql: string, attempt = 1): unknown[] {
    let out: string;
    try {
        out = execFileSync('supabase', ['db', 'query', '--linked', '-o', 'json', sql], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (err) {
        // Transient gateway hiccups (e.g. Cloudflare 524) happen occasionally
        // against the linked project's connection pooler — retry a couple of
        // times before giving up, since this is infra flakiness, not a bug.
        if (attempt < 3) {
            const waitMs = attempt * 1500;
            execFileSync('sleep', [String(waitMs / 1000)]);
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

// ─── Pass/fail/skip reporting ────────────────────────────────────────────────
// `pass: null` means skipped — a scenario this script deliberately decided
// not to execute (see `skip()` below), always reported explicitly rather
// than silently shrinking the total. Existing scripts that only ever call
// `record()` are unaffected: their results never contain a `null`, so
// `summarize()`'s output format is byte-for-byte identical to before
// whenever no scenario was skipped.

export type TestResult = { id: string; name: string; pass: boolean | null; detail?: string };
const results: TestResult[] = [];

/**
 * Each scenario id must be recorded at most once per run. A script that
 * legitimately asserts several related facts under one conceptual scenario
 * (an established, common pattern across these audit scripts — e.g.
 * multiple `record('A', ...)` calls for different facts about the same
 * scenario "A") is fine and expected; this only guards against the same
 * id being pushed into two genuinely different code paths that could both
 * fire in a single run (which would silently inflate/deflate summarize()'s
 * totals) by making a within-run collision loud instead of silent. Since
 * every existing script's ids are simply whatever string was passed, this
 * check never rejects the many-calls-one-id pattern already in wide use —
 * it only ever fires with a duplicate `id, name` pair, which no existing
 * script has ever produced within one run.
 */
function assertNotAlreadyRecordedWithSameName(id: string, name: string) {
    const clash = results.find((r) => r.id === id && r.name === name);
    if (clash) {
        throw new Error(`record()/skip() called twice with the identical (id, name) pair "${id}: ${name}" in the same run — this would silently double-count in summarize()'s totals.`);
    }
}

export function record(id: string, name: string, pass: boolean, detail?: string) {
    assertNotAlreadyRecordedWithSameName(id, name);
    results.push({ id, name, pass, detail });
    const status = pass ? 'PASS' : 'FAIL';
    console.log(`[${status}] ${id} — ${name}${detail ? `  (${detail})` : ''}`);
}

/**
 * Explicitly marks a scenario as skipped — never silently absent from the
 * total, and never counted as a pass. Use when a scenario is deliberately
 * not executed this run (e.g. a precondition genuinely can't be
 * constructed), not as a substitute for a real assertion.
 */
export function skip(id: string, name: string, detail?: string) {
    assertNotAlreadyRecordedWithSameName(id, name);
    results.push({ id, name, pass: null, detail });
    console.log(`[SKIP] ${id} — ${name}${detail ? `  (${detail})` : ''}`);
}

/** Read-only snapshot of every result recorded so far this run -- used by scripts/audit-infrastructure/artifacts.ts to serialize structured JSON without any script changing its calling convention. */
export function getResults(): TestResult[] {
    return [...results];
}

export function summarize(): boolean {
    const failed = results.filter((r) => r.pass === false);
    const skipped = results.filter((r) => r.pass === null);
    const passed = results.filter((r) => r.pass === true);
    console.log('\n──────────────────────────────────────────');
    console.log(
        skipped.length > 0
            ? `${passed.length}/${results.length} tests passed, ${failed.length} failed, ${skipped.length} skipped`
            : `${passed.length}/${results.length} tests passed`
    );
    if (failed.length > 0) {
        console.log('\nFAILED:');
        for (const f of failed) console.log(`  - ${f.id}: ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
    }
    if (skipped.length > 0) {
        console.log('\nSKIPPED:');
        for (const s of skipped) console.log(`  - ${s.id}: ${s.name}${s.detail ? ` (${s.detail})` : ''}`);
    }
    console.log('──────────────────────────────────────────');
    return failed.length === 0;
}

export async function signUpTestUser(emailPrefix: string, rand: string, password: string, fullName: string) {
    const client = newClient();
    const email = `tavora.secaudit.${emailPrefix}.${rand}@example.com`;
    // `audit_account: true` lets scripts/audit-infrastructure/cleanup.ts's
    // globalSyntheticSweep() confirm an account is synthetic via metadata,
    // not just a namespace guess -- see docs/audit-infrastructure-model.md.
    const { data, error } = await client.auth.signUp({ email, password, options: { data: { audit_account: true } } });
    if (error || !data.user) throw new Error(`signup failed for ${email}: ${error?.message}`);
    // The handle_new_user trigger (Week 1 task #6) already created a bare
    // profiles row atomically with the auth.users insert above — upsert
    // rather than insert so this helper works the same whether that row
    // already exists (sets full_name on it) or, in principle, doesn't.
    const { error: profErr } = await client.from('profiles').upsert({ id: data.user.id, full_name: fullName }, { onConflict: 'id' });
    if (profErr) throw new Error(`profile upsert failed for ${email}: ${profErr.message}`);
    return { id: data.user.id, email, client };
}
