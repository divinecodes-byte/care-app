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

// ─── Pass/fail reporting ─────────────────────────────────────────────────────

export type TestResult = { id: string; name: string; pass: boolean; detail?: string };
const results: TestResult[] = [];

export function record(id: string, name: string, pass: boolean, detail?: string) {
    results.push({ id, name, pass, detail });
    const status = pass ? 'PASS' : 'FAIL';
    console.log(`[${status}] ${id} — ${name}${detail ? `  (${detail})` : ''}`);
}

export function summarize(): boolean {
    const failed = results.filter((r) => !r.pass);
    console.log('\n──────────────────────────────────────────');
    console.log(`${results.length - failed.length}/${results.length} tests passed`);
    if (failed.length > 0) {
        console.log('\nFAILED:');
        for (const f of failed) console.log(`  - ${f.id}: ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
    }
    console.log('──────────────────────────────────────────');
    return failed.length === 0;
}

export async function signUpTestUser(emailPrefix: string, rand: string, password: string, fullName: string) {
    const client = newClient();
    const email = `tavora.secaudit.${emailPrefix}.${rand}@example.com`;
    const { data, error } = await client.auth.signUp({ email, password });
    if (error || !data.user) throw new Error(`signup failed for ${email}: ${error?.message}`);
    const { error: profErr } = await client.from('profiles').insert({ id: data.user.id, full_name: fullName });
    if (profErr) throw new Error(`profile insert failed for ${email}: ${profErr.message}`);
    return { id: data.user.id, email, client };
}
