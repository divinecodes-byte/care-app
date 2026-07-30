// PostgreSQL advisory-lock wrapper for the fixture pool.
//
// IMPORTANT scoping note (discovered during implementation via a real
// failure, not assumed in the plan): every SQL call in this codebase goes
// through `supabase db query --linked`, which spawns a brand-new database
// session per invocation. An initial implementation used a SESSION-level
// advisory lock (pg_advisory_lock/pg_advisory_unlock) acquired and released
// within one such call -- but if anything between acquire and the explicit
// unlock throws (e.g. a real bug in the wrapped SQL), the unlock statement
// is never reached, and depending on how the CLI's underlying connection
// is pooled, that session-scoped lock can outlive the failed call and
// block every subsequent attempt indefinitely (confirmed empirically: a
// genuine reset-SQL failure left the lock "held" for the rest of that
// process's life, causing every retry within the 60s bounded wait to see
// it as busy and eventually throw FixturePoolLockBusyError even though no
// other process was actually contending for it).
//
// Fixed by switching to a TRANSACTION-scoped advisory lock
// (pg_try_advisory_xact_lock), wrapped in an explicit BEGIN/COMMIT.
// PostgreSQL guarantees a transaction-scoped advisory lock is released at
// COMMIT *or* ROLLBACK, unconditionally -- there is no code path (a bug in
// the wrapped SQL, a network drop, a killed process) that can leak it
// without also ending the transaction, which auto-releases it. No explicit
// unlock statement is needed or present.
//
// This is still fully cross-process and cross-machine/CI-runner safe: the
// lock lives in the linked Postgres instance itself, not on any one host.

import { dbQuery } from '../security-audit/helpers';

// Arbitrary, fixed, documented key identifying "the Tavora fixture pool"
// lock. Any bigint works as long as it's stable and not reused for an
// unrelated purpose elsewhere in this project (grepped: not used anywhere
// else in supabase/migrations or scripts/).
export const FIXTURE_POOL_LOCK_KEY = 872341001;

export class FixturePoolLockBusyError extends Error {
    constructor() {
        super('fixture_pool_lock_busy');
        this.name = 'FixturePoolLockBusyError';
    }
}

/**
 * Runs `sql` inside one transaction that holds the fixture-pool
 * transaction-scoped advisory lock for that transaction's duration.
 * Guaranteed to release on COMMIT or ROLLBACK regardless of whether `sql`
 * succeeds. Retries the *acquire* with a bounded wait if another process
 * currently holds it; never blocks indefinitely.
 */
export function withFixturePoolLock<T = unknown>(sql: string, opts: { maxWaitMs?: number; pollMs?: number } = {}): T[] {
    const maxWaitMs = opts.maxWaitMs ?? 60_000;
    const pollMs = opts.pollMs ?? 2_000;
    const deadline = Date.now() + maxWaitMs;
    const wrapped = `
        begin;
        do $$
        declare
          v_locked boolean;
        begin
          select pg_try_advisory_xact_lock(${FIXTURE_POOL_LOCK_KEY}) into v_locked;
          if not v_locked then
            raise exception 'fixture_pool_lock_busy';
          end if;
        end $$;
        ${sql}
        commit;
    `;
    for (;;) {
        try {
            return dbQuery(wrapped) as T[];
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (!/fixture_pool_lock_busy/.test(message)) throw err;
            if (Date.now() >= deadline) throw new FixturePoolLockBusyError();
            const waitMs = Math.min(pollMs, deadline - Date.now());
            execSleepMs(waitMs);
        }
    }
}

function execSleepMs(ms: number) {
    // Deliberately synchronous (matches dbQuery's own retry-backoff style in
    // helpers.ts) -- these scripts are simple sequential CLI tools, not
    // long-running servers, so blocking the event loop briefly here is fine
    // and keeps the retry loop trivially easy to reason about.
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    execFileSync('sleep', [String(Math.max(ms, 0) / 1000)]);
}
