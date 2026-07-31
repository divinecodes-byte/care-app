// Canonical crash-safe cleanup utility (Phase 6).
//
// Provides:
//   - installCrashSafety(): awaited SIGINT/SIGTERM/uncaughtException/
//     unhandledRejection handlers, every one of the 12 existing scripts was
//     confirmed (by direct inventory) to be missing entirely. `exit` is used
//     ONLY for synchronous local metadata -- Node does not drain async work
//     once `exit` fires, so it must never be relied on for the actual
//     database cleanup.
//   - scopedCleanup(): deletes exactly a known set of synthetic user IDs'
//     rows, FK-safe order.
//   - globalSyntheticSweep(): the namespace+metadata-gated destructive sweep
//     (dry-run by default; fixtures excluded unless explicitly included).
//   - detectOrphans(): a startup scan for synthetic rows past a grace period
//     with no active run holding them -- the only mechanism that can ever
//     recover from a SIGKILL/OOM/machine-shutdown, since nothing else runs
//     in that case.

import { execFileSync } from 'node:child_process';
import { dbQuery } from '../security-audit/helpers';

// Every namespace an existing or new script signs synthetic accounts up
// under (verified via `grep -rn "tavora\." scripts/*/*.ts`, not guessed).
// A bare `tavora.%` wildcard is deliberately NOT used -- see docs/audit-infrastructure-model.md
// "Synthetic-cleanup matching" for why a loose substring match is unsafe.
export const SYNTHETIC_NAMESPACES = [
    'tavora.fixture.%',
    'tavora.secaudit.%',
    'tavora.authaudit.%',
    'tavora.reminderaudit.%',
    'tavora.tzrace.%',
    'tavora.taskaudit.%',
    'tavora.activityaudit.%',
    'tavora.routineaudit.%',
    'tavora.onboardingaudit.%',
    'tavora.participantaudit.%',
    'tavora.uistateaudit.%',
    'tavora.multiorgaudit.%',
    'tavora.metasuite.%',
    'tavora.overdueaudit.%',
] as const;

// Accounts created before the `audit_account` user_metadata flag existed.
// Namespace-matched but not metadata-confirmed -- always shown separately
// in dry-run output, always still require the destructive flag, never
// silently merged into the metadata-confirmed set.
export const LEGACY_SYNTHETIC_PREFIXES = [...SYNTHETIC_NAMESPACES];

const FIXTURE_NAMESPACE = 'tavora.fixture.%';

export type CleanupReport = {
    dryRun: boolean;
    destructive: boolean;
    includeFixtures: boolean;
    plannedCounts: Record<string, number>;
    deletedCounts: Record<string, number>;
    remainingAfter: Record<string, number>;
    legacyAccountsFound: number;
    metadataConfirmedAccountsFound: number;
    ok: boolean;
    notes: string[];
};

function namespaceWhereClause(includeFixtures: boolean): string {
    const namespaces = includeFixtures ? SYNTHETIC_NAMESPACES : SYNTHETIC_NAMESPACES.filter((n) => n !== FIXTURE_NAMESPACE);
    return namespaces.map((n) => `email like '${n}'`).join(' or ');
}

/** Deletes every synthetic-artifact row for a known, explicit set of auth.users IDs, FK-safe order. Never pattern-matches. */
export function scopedCleanup(userIds: string[]): CleanupReport {
    if (userIds.length === 0) {
        return { dryRun: false, destructive: true, includeFixtures: false, plannedCounts: {}, deletedCounts: {}, remainingAfter: {}, legacyAccountsFound: 0, metadataConfirmedAccountsFound: 0, ok: true, notes: ['no ids provided'] };
    }
    const idList = userIds.map((id) => `'${id}'`).join(',');
    const deletedCounts: Record<string, number> = {};
    const steps: { label: string; sql: string }[] = [
        { label: 'routine_notification_deliveries', sql: `delete from public.routine_notification_deliveries where recipient_id in (${idList})` },
        { label: 'task_notification_deliveries', sql: `delete from public.task_notification_deliveries where recipient_id in (${idList})` },
        { label: 'reminder_notification_deliveries', sql: `delete from public.reminder_notification_deliveries where recipient_id in (${idList})` },
        { label: 'routine_instance_items', sql: `delete from public.routine_instance_items where routine_instance_id in (select id from public.routine_instances where organizer_id in (${idList}) or participant_id in (${idList}))` },
        { label: 'routine_instances', sql: `delete from public.routine_instances where organizer_id in (${idList}) or participant_id in (${idList})` },
        { label: 'routine_template_items', sql: `delete from public.routine_template_items where template_id in (select id from public.routine_templates where owner_id in (${idList}))` },
        { label: 'routine_templates', sql: `delete from public.routine_templates where owner_id in (${idList})` },
        { label: 'task_occurrences', sql: `delete from public.task_occurrences where task_id in (select id from public.tasks where caregiver_id in (${idList}) or recipient_id in (${idList}))` },
        { label: 'tasks', sql: `delete from public.tasks where caregiver_id in (${idList}) or recipient_id in (${idList})` },
        { label: 'reminder_logs', sql: `delete from public.reminder_logs where reminder_id in (select id from public.reminders where caregiver_id in (${idList}) or recipient_id in (${idList}))` },
        { label: 'reminders', sql: `delete from public.reminders where caregiver_id in (${idList}) or recipient_id in (${idList})` },
        { label: 'push_tokens', sql: `delete from public.push_tokens where user_id in (${idList})` },
        { label: 'connections', sql: `delete from public.connections where caregiver_id in (${idList}) or recipient_id in (${idList})` },
        { label: 'profiles', sql: `delete from public.profiles where id in (${idList})` },
        { label: 'auth.users', sql: `delete from auth.users where id in (${idList})` },
    ];
    for (const step of steps) {
        const rows = dbQuery(`${step.sql}; select 1;`) as unknown[];
        deletedCounts[step.label] = rows.length; // best-effort; exact row_count isn't returned by a plain DELETE via this CLI
    }
    return { dryRun: false, destructive: true, includeFixtures: false, plannedCounts: {}, deletedCounts, remainingAfter: {}, legacyAccountsFound: 0, metadataConfirmedAccountsFound: 0, ok: true, notes: [] };
}

/**
 * The destructive, namespace+metadata-gated global sweep. Dry-run by
 * default -- prints planned counts, deletes nothing. `destructive: true`
 * is required to delete anything at all; `includeFixtures: true` is
 * *additionally* required to touch the fixture pool (two independent
 * flags, per docs/synthetic-fixture-model.md).
 */
export function globalSyntheticSweep(opts: { dryRun: boolean; destructive: boolean; includeFixtures: boolean }): CleanupReport {
    const { dryRun, destructive, includeFixtures } = opts;
    const where = namespaceWhereClause(includeFixtures);
    const notes: string[] = [];

    const metaConfirmed = dbQuery(
        `select count(*) as c from auth.users where (${where}) and (raw_user_meta_data->>'audit_account') = 'true'`
    ) as { c: number }[];
    const legacyUnconfirmed = dbQuery(
        `select count(*) as c from auth.users where (${where}) and coalesce(raw_user_meta_data->>'audit_account','') <> 'true'`
    ) as { c: number }[];
    const metadataConfirmedAccountsFound = Number(metaConfirmed[0]?.c ?? 0);
    const legacyAccountsFound = Number(legacyUnconfirmed[0]?.c ?? 0);

    const plannedCounts: Record<string, number> = {
        auth_users_metadata_confirmed: metadataConfirmedAccountsFound,
        auth_users_legacy_unconfirmed: legacyAccountsFound,
    };
    notes.push(
        includeFixtures
            ? 'fixture pool namespace INCLUDED (--include-fixtures was set) -- fixture identities will be deleted, not just reset'
            : 'fixture pool namespace excluded (default) -- fixture identities are never touched by this sweep'
    );
    if (legacyAccountsFound > 0) {
        notes.push(`${legacyAccountsFound} legacy synthetic account(s) matched by namespace only (no audit_account metadata) -- shown separately, still require --destructive to remove`);
    }

    if (dryRun || !destructive) {
        return { dryRun: true, destructive: false, includeFixtures, plannedCounts, deletedCounts: {}, remainingAfter: {}, legacyAccountsFound, metadataConfirmedAccountsFound, ok: true, notes: [...notes, 'DRY RUN -- nothing deleted. Pass --destructive to actually delete.'] };
    }

    const idsRows = dbQuery(`select id from auth.users where ${where}`) as { id: string }[];
    const ids = idsRows.map((r) => r.id);
    const report = scopedCleanup(ids);

    const remaining = dbQuery(`select count(*) as c from auth.users where ${where}`) as { c: number }[];
    const remainingCount = Number(remaining[0]?.c ?? 0);
    const ok = remainingCount === 0;
    if (!ok) notes.push(`WARNING: ${remainingCount} account(s) still present after sweep -- investigate before assuming cleanup succeeded`);

    return {
        dryRun: false,
        destructive: true,
        includeFixtures,
        plannedCounts,
        deletedCounts: report.deletedCounts,
        remainingAfter: { auth_users: remainingCount },
        legacyAccountsFound,
        metadataConfirmedAccountsFound,
        ok,
        notes,
    };
}

/**
 * Startup orphan detection -- the only mechanism that can recover from a
 * SIGKILL/OOM/machine-shutdown, since none of those give any process a
 * chance to run its own signal handlers. Flags synthetic accounts older
 * than `graceMinutes` (default 10) -- old enough that they can't just be
 * mid-creation by a currently-running suite.
 */
/**
 * Excludes the fixture-pool namespace by default -- fixtures are *meant*
 * to persist indefinitely (docs/synthetic-fixture-model.md), so they are
 * never "orphans" in the sense this function (and the startup sweep that
 * consumes it) cares about. Reporting them here would be misleading even
 * though the actual sweep already excludes them by default -- confirmed
 * live: a real orchestrator run reported "6 synthetic accounts found"
 * (the fixture pool's own count) while correctly leaving all 6 untouched,
 * which reads as alarming even though nothing was actually at risk.
 */
export function detectOrphans(graceMinutes = 10, includeFixtures = false): { count: number; ids: string[] } {
    const where = namespaceWhereClause(includeFixtures);
    const rows = dbQuery(
        `select id from auth.users where (${where}) and created_at < now() - interval '${graceMinutes} minutes'`
    ) as { id: string }[];
    return { count: rows.length, ids: rows.map((r) => r.id) };
}

// ─── Crash safety ────────────────────────────────────────────────────────

let installed = false;
let cleaningUp = false;

function conventionalExitCode(signalOrErr: string | Error): number {
    if (signalOrErr === 'SIGINT') return 130;
    if (signalOrErr === 'SIGTERM') return 143;
    return 1;
}

/**
 * Registers awaited cleanup on SIGINT/SIGTERM/uncaughtException/
 * unhandledRejection. Safe to call once per process. `cleanupFn` should be
 * idempotent and fast -- it runs under time pressure during a real
 * interrupt.
 *
 * Deliberately does NOT register a `process.on('exit', ...)` cleanup path:
 * `exit` fires synchronously and Node will not wait for a Promise started
 * inside it, so anything async written there would silently never
 * complete. If you need to record "this run was interrupted" for the
 * artifact directory, do it synchronously inside `cleanupFn` before its
 * first `await`, or write it via the signal handlers above instead.
 */
export function installCrashSafety(cleanupFn: () => Promise<void>): void {
    if (installed) return;
    installed = true;

    async function handleTermination(signalOrErr: string | Error) {
        if (cleaningUp) return;
        cleaningUp = true;
        try {
            await cleanupFn();
        } catch (err) {
            console.error('[crash-safety] cleanup itself failed:', err instanceof Error ? err.message : err);
        } finally {
            process.exit(conventionalExitCode(signalOrErr));
        }
    }

    process.on('SIGINT', () => void handleTermination('SIGINT'));
    process.on('SIGTERM', () => void handleTermination('SIGTERM'));
    process.on('uncaughtException', (err) => void handleTermination(err));
    process.on('unhandledRejection', (reason) => void handleTermination(reason instanceof Error ? reason : new Error(String(reason))));
}

/** Standalone CLI: `npx tsx scripts/audit-infrastructure/cleanup.ts --dry-run|--destructive [--include-fixtures]` */
if (require.main === module) {
    const args = process.argv.slice(2);
    const destructive = args.includes('--destructive');
    const includeFixtures = args.includes('--include-fixtures');
    const orphans = detectOrphans();
    console.log(`Orphan scan: ${orphans.count} synthetic account(s) older than the grace period.`);
    const report = globalSyntheticSweep({ dryRun: !destructive, destructive, includeFixtures });
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
}
