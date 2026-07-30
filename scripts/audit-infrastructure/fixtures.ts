// Controlled synthetic fixture pool (Phase 4/5).
//
// Six deterministic identities, provisioned once and reused indefinitely --
// normal cleanup never deletes them (see cleanup.ts's SYNTHETIC_NAMESPACES
// handling of `tavora.fixture.%`). Only scenarios confirmed to be
// identity-independent (see docs/synthetic-fixture-model.md's ledger) are
// wired to use this pool; every fresh-signup-dependent scenario keeps
// creating its own disposable account exactly as before.

import { createClient } from '@supabase/supabase-js';
import { newClient, dbQuery, ANON_KEY, SUPABASE_URL } from '../security-audit/helpers';
import { withFixturePoolLock } from './lock';

export type FixtureRole = 'organizerA' | 'organizerB' | 'participantA' | 'participantB' | 'participantMultiOrg' | 'unauthorizedUser';

const FIXTURE_ROLES: FixtureRole[] = ['organizerA', 'organizerB', 'participantA', 'participantB', 'participantMultiOrg', 'unauthorizedUser'];

// No per-run RAND suffix -- these emails are meant to be stable across runs.
function fixtureEmail(role: FixtureRole): string {
    return `tavora.fixture.${role.toLowerCase()}@example.com`;
}

// Never committed anywhere, never logged -- this is local-only test
// configuration for accounts that hold no real user data.
const FIXTURE_PASSWORD = 'Tavora-Fixture-Pool!9x';

export type FixtureIdentity = { role: FixtureRole; id: string; email: string };
export type FixturePool = Record<FixtureRole, FixtureIdentity>;

function fixtureClientFor(email: string) {
    // A short-lived client signed in as the fixture, for scenarios that need
    // to act *as* that identity (e.g. an RLS check reading its own rows).
    return createClient(SUPABASE_URL, ANON_KEY);
}

/** Idempotent -- signs up any of the 6 identities that don't already exist, reuses the rest. Never destructive. */
export async function provisionFixturePool(): Promise<FixturePool> {
    const pool = {} as FixturePool;
    for (const role of FIXTURE_ROLES) {
        const email = fixtureEmail(role);
        const existing = dbQuery(`select id from auth.users where email = '${email}'`) as { id: string }[];
        if (existing.length > 0) {
            pool[role] = { role, id: existing[0].id, email };
            continue;
        }
        const client = newClient();
        const { data, error } = await client.auth.signUp({
            email,
            password: FIXTURE_PASSWORD,
            options: { data: { audit_account: true, fixture: true, fixture_role: role } },
        });
        if (error || !data.user) throw new Error(`fixture provisioning failed for ${role}: ${error?.message}`);
        const { error: profErr } = await client.from('profiles').upsert({ id: data.user.id, full_name: `Fixture ${role}` }, { onConflict: 'id' });
        if (profErr) throw new Error(`fixture profile upsert failed for ${role}: ${profErr.message}`);
        pool[role] = { role, id: data.user.id, email };
    }
    return pool;
}

function requireProvisioned(): FixturePool {
    const rows = dbQuery(
        `select id, email, raw_user_meta_data->>'fixture_role' as fixture_role from auth.users where email like 'tavora.fixture.%'`
    ) as { id: string; email: string; fixture_role: string | null }[];
    const pool = {} as FixturePool;
    for (const role of FIXTURE_ROLES) {
        const row = rows.find((r) => r.fixture_role === role || r.email === fixtureEmail(role));
        if (!row) throw new Error(`fixture pool not provisioned: missing ${role} -- run provisionFixturePool() or rebuildFixturePool() first`);
        pool[role] = { role, id: row.id, email: row.email };
    }
    return pool;
}

/**
 * Resets the fixture pool's *product data* only (reminders, tasks,
 * routines, connections, invitations, notification deliveries) and
 * re-establishes the baseline relationship graph. Never deletes the
 * auth.users/profiles rows themselves. Runs inside a single
 * advisory-locked SQL script (see lock.ts for why the lock must wrap one
 * dbQuery call, not the whole scenario).
 */
export function resetFixturePool(): void {
    const pool = requireProvisioned();
    const ids = FIXTURE_ROLES.map((r) => `'${pool[r].id}'`).join(',');
    const oA = pool.organizerA.id, oB = pool.organizerB.id;
    const pA = pool.participantA.id, pB = pool.participantB.id, pM = pool.participantMultiOrg.id;

    const sql = `
        delete from public.routine_notification_deliveries where recipient_id in (${ids});
        delete from public.task_notification_deliveries where recipient_id in (${ids});
        delete from public.reminder_notification_deliveries where recipient_id in (${ids});
        delete from public.routine_instance_items where routine_instance_id in (select id from public.routine_instances where organizer_id in (${ids}) or participant_id in (${ids}));
        delete from public.routine_instances where organizer_id in (${ids}) or participant_id in (${ids});
        delete from public.routine_template_items where template_id in (select id from public.routine_templates where owner_id in (${ids}));
        delete from public.routine_templates where owner_id in (${ids});
        delete from public.task_occurrences where task_id in (select id from public.tasks where caregiver_id in (${ids}) or recipient_id in (${ids}));
        delete from public.tasks where caregiver_id in (${ids}) or recipient_id in (${ids});
        delete from public.reminder_logs where reminder_id in (select id from public.reminders where caregiver_id in (${ids}) or recipient_id in (${ids}));
        delete from public.reminders where caregiver_id in (${ids}) or recipient_id in (${ids});
        delete from public.push_tokens where user_id in (${ids});
        delete from public.connections where caregiver_id in (${ids}) or recipient_id in (${ids});
        update public.profiles set server_push_enabled = false where id in (${ids});
        insert into public.connections (caregiver_id, recipient_id, status, accepted_at, invite_code, expires_at)
          values
            ('${oA}', '${pA}', 'accepted', now(), 'FIXTUREAA', now() + interval '365 days'),
            ('${oB}', '${pB}', 'accepted', now(), 'FIXTUREBB', now() + interval '365 days'),
            ('${oA}', '${pM}', 'accepted', now(), 'FIXTUREAM', now() + interval '365 days'),
            ('${oB}', '${pM}', 'accepted', now(), 'FIXTUREBM', now() + interval '365 days');
    `;
    withFixturePoolLock(sql);
}

export type FixtureBaselineReport = { ok: boolean; problems: string[] };

/** Re-reads and asserts every expected baseline fact. Never assumes -- always re-verifies live state. */
export function verifyFixtureBaseline(): FixtureBaselineReport {
    const pool = requireProvisioned();
    const problems: string[] = [];
    const oA = pool.organizerA.id, oB = pool.organizerB.id;
    const pA = pool.participantA.id, pB = pool.participantB.id, pM = pool.participantMultiOrg.id, unauth = pool.unauthorizedUser.id;

    const conns = dbQuery(
        `select caregiver_id, recipient_id, status from public.connections where caregiver_id in ('${oA}','${oB}') or recipient_id in ('${pA}','${pB}','${pM}')`
    ) as { caregiver_id: string; recipient_id: string; status: string }[];
    const hasAccepted = (cg: string, rc: string) => conns.some((c) => c.caregiver_id === cg && c.recipient_id === rc && c.status === 'accepted');

    if (!hasAccepted(oA, pA)) problems.push('organizerA<->participantA is not accepted');
    if (!hasAccepted(oB, pB)) problems.push('organizerB<->participantB is not accepted');
    if (!hasAccepted(oA, pM)) problems.push('organizerA<->participantMultiOrg is not accepted');
    if (!hasAccepted(oB, pM)) problems.push('organizerB<->participantMultiOrg is not accepted');

    const unauthConns = conns.filter((c) => c.caregiver_id === unauth || c.recipient_id === unauth);
    if (unauthConns.length > 0) problems.push('unauthorizedUser has a connection (must have none)');

    const pushFlags = dbQuery(
        `select id, server_push_enabled from public.profiles where id in (${FIXTURE_ROLES.map((r) => `'${pool[r].id}'`).join(',')})`
    ) as { id: string; server_push_enabled: boolean }[];
    if (pushFlags.some((p) => p.server_push_enabled)) problems.push('at least one fixture has server_push_enabled=true (must be false)');

    const tokens = dbQuery(
        `select count(*) as c from public.push_tokens where user_id in (${FIXTURE_ROLES.map((r) => `'${pool[r].id}'`).join(',')})`
    ) as { c: number }[];
    if (Number(tokens[0]?.c ?? 0) > 0) problems.push('at least one fixture has a push_tokens row (must have none)');

    return { ok: problems.length === 0, problems };
}

/** Pre-flight gate every fixture-using scenario must call before proceeding. Fails loudly rather than running against unknown state. */
export function detectFixtureContamination(): void {
    const report = verifyFixtureBaseline();
    if (!report.ok) {
        throw new Error(
            `Fixture pool is contaminated: ${report.problems.join('; ')}. Do not proceed. Run: npx tsx scripts/audit-infrastructure/fixtures.ts rebuild --confirm`
        );
    }
}

/** Full teardown + re-provision. Never automatic -- only ever run by a human after detectFixtureContamination() reports a problem. */
export async function rebuildFixturePool(opts: { confirm: boolean }): Promise<FixturePool> {
    if (!opts.confirm) throw new Error('rebuildFixturePool requires { confirm: true } -- this deletes and recreates every fixture identity.');
    const rows = dbQuery(`select id from auth.users where email like 'tavora.fixture.%'`) as { id: string }[];
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
        const { scopedCleanup } = await import('./cleanup');
        scopedCleanup(ids);
    }
    return provisionFixturePool();
}

export function getFixtureClient(role: FixtureRole) {
    return fixtureClientFor(fixtureEmail(role));
}

export function getFixturePassword(): string {
    return FIXTURE_PASSWORD;
}

if (require.main === module) {
    const cmd = process.argv[2];
    (async () => {
        if (cmd === 'provision') {
            const pool = await provisionFixturePool();
            console.log(JSON.stringify(pool, null, 2));
        } else if (cmd === 'reset') {
            resetFixturePool();
            console.log('fixture pool reset.');
        } else if (cmd === 'verify') {
            console.log(JSON.stringify(verifyFixtureBaseline(), null, 2));
        } else if (cmd === 'rebuild') {
            const confirm = process.argv.includes('--confirm');
            const pool = await rebuildFixturePool({ confirm });
            console.log(JSON.stringify(pool, null, 2));
        } else {
            console.log('Usage: npx tsx scripts/audit-infrastructure/fixtures.ts <provision|reset|verify|rebuild [--confirm]>');
            process.exit(1);
        }
    })().catch((err) => {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
    });
}
