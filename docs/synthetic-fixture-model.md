# Synthetic fixture model

Week 4 Task #1's controlled fixture pool (`scripts/audit-infrastructure/fixtures.ts`),
built to cut real Supabase signup volume for the specific, narrow class of
scenario that's genuinely identity-independent, without touching anything
that actually needs a fresh account.

## Scope decision (confirmed with the user before implementation)

Only scenarios **proven not to depend on fresh Auth state** were migrated.
Everything else -- signup/duplicate-email checks, account-deletion/tombstone
tests, onboarding-flow (fresh-profile) tests, participant-limit-exactly-5
tests, and account-switching tests -- stays on disposable per-run accounts,
unchanged, even where a couple looked structurally reusable.

### Migrated (exact ledger -- keep this current if the wiring changes)

| Suite | Scenario(s) | What changed | Why safe |
|---|---|---|---|
| `participant-audit` | N ("an unrelated user cannot end a connection they are not party to") | `signUpTestUser('outsider', ...)` → fixture `unauthorizedUser`, signed in via `getFixtureClient` | Only needs "any identity not party to connM" |
| `routine-audit` | H, I, CA (unrelated-organizer read/mutate/RLS checks) | `makeConnectedPair('hi')` (2 signups, only the caregiver half ever used) → fixture `organizerB` | Only needs "any unrelated organizer identity"; H/I/CA all reuse the same `cgH` variable |
| `task-audit` | H (reject unrelated organizer), J/AQ (unrelated-participant read isolation) | `makeConnectedPair('h2')` and `makeConnectedPair('j')` (4 signups total) → fixtures `organizerB` and `participantB` | Same reasoning; AQ reuses J's client for free |

### Investigated and deliberately NOT migrated

`security-audit`'s scenarios B, C, I (cross-profile/cross-reminder RLS
checks) were in the original adoption plan but turned out, on reading the
actual code, to reuse `caregiverA`/`recipientA`/`caregiverB` -- the exact
same three accounts that ~10 *other* scenarios in the same file (D, E, F, G,
H, J, K, L, M, N, T) depend on via one shared real invite-accept setup
block. Swapping just B/C/I to fixtures would save zero signups (those three
accounts must still be created for everything else in the file) while
adding real risk from restructuring shared setup in a large, heavily-tested
file. Left disposable, unchanged. This is exactly the kind of investigation
this task asked for -- verify before adopting, don't force a swap that looks
like progress but isn't.

## The pool

Six deterministic identities under `tavora.fixture.<role>@example.com`
(`FixtureRole` in `fixtures.ts`): `organizerA`, `organizerB`, `participantA`,
`participantB`, `participantMultiOrg`, `unauthorizedUser`. No per-run random
suffix -- these are meant to persist and be reset, not recreated. Local-only
password (`FIXTURE_PASSWORD` in `fixtures.ts`), never logged.

- **`provisionFixturePool()`** -- idempotent. Looks up each identity by
  email; signs up only the ones that don't exist yet (with
  `audit_account: true` and `fixture: true` in `user_metadata`, plus
  `fixture_role` for reverse lookup). Never destructive, never re-creates
  an existing identity.
- **`resetFixturePool()`** -- deletes only the fixtures' *product data*
  (reminders, tasks, routines, connections, invitations, notification
  deliveries) and re-establishes the baseline relationship graph:
  organizerA↔participantA accepted, organizerB↔participantB accepted,
  participantMultiOrg accepted to both organizers, unauthorizedUser
  connected to no one. **Never deletes the `auth.users`/`profiles` rows.**
- **`verifyFixtureBaseline()`** / **`detectFixtureContamination()`** --
  re-reads and asserts every expected relationship, `server_push_enabled = false`
  on all six, zero `push_tokens` rows for any of the six. Every
  fixture-using scenario calls `detectFixtureContamination()` before
  proceeding -- if it fails, the suite does not run against unknown state;
  it fails loudly and points at `rebuildFixturePool`.
- **`rebuildFixturePool({ confirm: true })`** -- full teardown + re-provision,
  for a corrupted identity. Never automatic; only ever run by a human:
  `npx tsx scripts/audit-infrastructure/fixtures.ts rebuild --confirm`.

## Why the pool is never deleted by normal cleanup

The entire point of the pool is reducing signup volume by *persisting*
across runs -- recreating it every run would defeat that. `globalSyntheticSweep()`
(`cleanup.ts`) excludes the `tavora.fixture.%` namespace **unless the caller
passes both `--destructive` and `--include-fixtures`** -- two independent
flags, not one, so an accidentally-destructive sweep still can't touch the
pool by itself.

## Locking: PostgreSQL transaction-scoped advisory lock

`scripts/audit-infrastructure/lock.ts`. An initial implementation used a
**session-scoped** advisory lock (`pg_advisory_lock`/`pg_advisory_unlock`)
acquired and released within one `supabase db query --linked` call --
discovered live, via a real failure, to be unsafe: when the wrapped SQL
threw a genuine error (a real bug, a bad column reference) before reaching
the explicit unlock statement, the session-scoped lock could outlive that
failed call and block every subsequent attempt, regardless of whether
anything else was actually contending for it. Fixed by switching to
**`pg_try_advisory_xact_lock`**, wrapped in an explicit `begin; ... commit;`
-- PostgreSQL guarantees a transaction-scoped advisory lock releases at
`COMMIT` *or* `ROLLBACK`, unconditionally. No explicit unlock statement
exists or is needed; there is no code path that can leak it.

This is deliberately **not** a local lockfile: a file only ever protects
concurrent runs on one host, which this project cannot guarantee (audits
may run from a laptop or CI). The advisory lock lives in the linked
Postgres instance itself, making it cross-process **and**
cross-machine/CI-runner safe by construction, with no new table. Lock key:
`FIXTURE_POOL_LOCK_KEY = 872341001` (arbitrary, fixed, documented, grepped
to confirm no collision with any other use in this project).

Acquire contention: non-blocking `pg_try_advisory_xact_lock`, retried with a
bounded wait (default 60s, 2s poll interval) from the Node side; a
still-busy lock after the deadline throws `FixturePoolLockBusyError` rather
than hanging indefinitely.

## Fixture reset safety

`resetFixturePool()` operates only on the six fixtures' exact known
`auth.users.id` values (looked up once via `requireProvisioned()`, never
re-derived from an email pattern at reset time), in the same
deterministic FK-safe delete order used elsewhere in this codebase. After
reset, `verifyFixtureBaseline()` is available to re-confirm every invariant
before a suite proceeds.

## What actually changed live (bugs found only by running this)

Two real bugs surfaced only once this was exercised against the live
project, not from code review:
1. `routine_instances` uses `organizer_id`/`participant_id`, not
   `caregiver_id`/`recipient_id` (unlike `reminders`/`tasks`/`connections`,
   which do use caregiver/recipient). `routine_instance_items`' FK column
   is `routine_instance_id`, not `instance_id`. Both `fixtures.ts` and
   `cleanup.ts` initially had this wrong; fixed after a live column-does-not-exist
   error surfaced it.
2. The session-vs-transaction advisory-lock issue above.
