# Audit-infrastructure model

Week 4 Task #1's shared layer under `scripts/audit-infrastructure/`, built to
fix five confirmed problems in the pre-existing 12 audit scripts: an
exponential signup blowup from nested suite calls, inconsistent
crash-cleanup safety, rate-limit/gateway-error misclassification outside
one script, zero process/network timeouts, and a false-positive cron
retention warning. See `docs/final-regression-runbook.md`,
`docs/synthetic-fixture-model.md`, and `docs/operational-alert-model.md`
for the pieces that grew large enough to deserve their own document.

## The problem this replaced

A full read-only inventory of all 12 scripts (this session) found a strict
DAG where nearly every script re-invoked several other scripts as "regression
checks" via `execFileSync`. `routine-audit` alone directly invoked all 11
others. Unrolled recursively, a single `routine-audit` run's theoretical
signup volume was ~8,300 real `auth.users` rows; `task-audit` ~2,080;
`activity-audit` ~4,160 -- Supabase's own signup rate limit was the only
thing preventing this from actually completing, which is what produced the
SKIP cascades seen in prior verification runs.

The same inventory found: 9 of 12 scripts scoped cleanup to an in-memory
array of created user IDs populated only *after* each signup succeeded, and
zero scripts installed a `SIGINT`/`SIGTERM`/`uncaughtException`/
`unhandledRejection` handler -- so an interrupt mid-run skipped cleanup
entirely, orphaning whatever had been created so far. The rate-limit/502
SKIP classifier existed only inside `routine-audit/run.ts`'s local
`runSuite()`; every other suite's nested-call failure path recorded a plain
FAIL for the exact same infra noise. No `execFileSync` call anywhere set a
`timeout`, and `err.stderr` was never read at any call site.

## Shared result model

Every suite still calls `record()`/`skip()`/`summarize()` from
`scripts/security-audit/helpers.ts` exactly as before -- **zero breaking
changes** to any of the 12 existing scripts' calling convention. `helpers.ts`
gained one addition, `getResults()`, mirroring `scripts/ops-health/helpers.ts`'s
existing one, so `scripts/audit-infrastructure/artifacts.ts` can pull
structured results without any script changing how it records them.

`scripts/audit-infrastructure/types.ts` defines the structured shapes used
by the orchestrator and artifact writer:

- `AuditResult` -- suite, scenarioId, description, `status: PASS | FAIL | SKIP`,
  category, timing, detail, errorCode.
- `StandaloneVerification` -- a **separate** record type for "this
  previously-SKIPped suite was re-run on its own and passed/failed." It
  never overwrites or mutates the original SKIP entry for the orchestrated
  run; both are kept, both are shown.
- `HealthCheckResult` -- mirrors what `public.ops_health_evaluate()` returns
  (`PASS | WARNING | FAIL`), kept structurally separate from `AuditResult`
  since ops-health is a live-health report, not a pass/fail test suite.

PASS/FAIL/SKIP policy (unchanged from what `routine-audit` already proved
out, now centralized): PASS means the assertion executed and succeeded; FAIL
means it executed and exposed a real defect; SKIP means it did not complete
because of an external/infrastructure condition. Rate limits and gateway
502/503/504 never become PASS. An unexecuted scenario never becomes PASS --
`summarize()`'s totals are always `results.length`, computed only from what
was actually recorded, never a hand-maintained number.

## Centralized infrastructure-error classifier

`scripts/audit-infrastructure/classify.ts` is the one place SKIP-vs-FAIL
classification now lives (extracted and extended from `routine-audit`'s
former local regexes, the only place this logic existed before). Stable
error codes: `AUTH_RATE_LIMIT`, `RATE_LIMIT_429`, `GATEWAY_502`,
`SERVICE_UNAVAILABLE_503`, `GATEWAY_TIMEOUT_504`, `DNS_NETWORK_TIMEOUT`,
`CONNECTION_RESET`, `CHILD_PROCESS_TIMEOUT`,
`PERMISSION_DENIED_OR_INTERRUPTED`, `MISSING_ENV_CONFIG`, `UNKNOWN`.
`classify(err)` returns `{ code, category: 'infrastructure' | 'unknown', retryable, sanitizedMessage }`.
**`UNKNOWN` always stays FAIL-eligible** -- classification never swallows a
genuine SQL/RLS/assertion failure by defaulting it to SKIP. `sanitize()`
redacts JWT-shaped and email-shaped substrings from any message before it's
logged or stored, applied by `artifacts.ts` to every `detail` string.

## Crash-safe cleanup (`scripts/audit-infrastructure/cleanup.ts`)

`process.on('exit', ...)` cannot await async work -- Node does not drain
pending promises once `exit` fires. Nothing in this layer relies on it for
actual cleanup. Instead:

1. **`installCrashSafety(cleanupFn)`** -- registers awaited
   `SIGINT`/`SIGTERM`/`uncaughtException`/`unhandledRejection` handlers.
   Every one of the 9 signup-heavy suites (`security-audit`, `auth-audit`,
   `reminder-audit` both files, `onboarding-audit`, `participant-audit`,
   `task-audit`, `activity-audit`, `routine-audit`, `ui-state-audit`) now
   calls this once near the top of `main()`, wrapping the exact same
   cleanup logic their `finally` block already ran (extracted into a local
   `cleanup()` function, guarded by a `cleaned` flag so it's safe to call
   from either path, or both, without double-deleting). `accessibility-audit`,
   `visual-consistency-audit`, and `ops-health` create zero synthetic
   accounts and don't need it.
2. **Orchestrator-owned, second layer** -- `scripts/final-regression/run.ts`
   supervises each suite as a child process; on any abnormal exit it still
   runs its own final `globalSyntheticSweep()` regardless of whether the
   child's own layer-1 handler completed.
3. **Startup orphan detection** -- `detectOrphans()`, run at the start of
   every orchestrated run and by the standalone `cleanup.ts` CLI, catches
   what a `SIGKILL`/OOM/machine-shutdown left behind -- the one case no
   in-process handler can ever observe, since nothing gets a chance to run.

`scopedCleanup(userIds)` deletes exactly a known set of IDs' rows in
FK-safe order (deliveries → occurrences/logs → reminders/tasks → routine
instances/items/templates → connections → profiles → auth.users).
`globalSyntheticSweep({ dryRun, destructive, includeFixtures })` is the
namespace+metadata-gated destructive sweep -- see "Synthetic-cleanup
matching" below and `docs/synthetic-fixture-model.md` for why fixtures need
their own explicit flag. Standalone recovery: `npx tsx
scripts/audit-infrastructure/cleanup.ts --dry-run|--destructive [--include-fixtures]`.

## Synthetic-cleanup matching

`globalSyntheticSweep()` requires **both**: an exact match against an
explicit, inventoried namespace list (`SYNTHETIC_NAMESPACES` in `cleanup.ts`
-- `tavora.fixture.%`, `tavora.secaudit.%`, `tavora.authaudit.%`,
`tavora.reminderaudit.%`, `tavora.tzrace.%`, `tavora.taskaudit.%`,
`tavora.activityaudit.%`, `tavora.routineaudit.%`, `tavora.onboardingaudit.%`,
`tavora.participantaudit.%`, `tavora.uistateaudit.%`, `tavora.multiorgaudit.%`
(Week 4 Task #2), `tavora.metasuite.%`, `tavora.overdueaudit.%` (both added
Week 4 Task #3) -- enumerated from a `grep` of every script's actual email
prefix, not a bare `tavora.%` wildcard), **and**, where available,
`raw_user_meta_data->>'audit_account' = 'true'`. Every signup helper across
all signup-heavy scripts now sets this flag. Legacy accounts
(namespace-matched, no metadata -- created before this flag existed) are
reported separately and still require `--destructive`, never silently
merged into the metadata-confirmed set.

### Meta-suite's own orphan-detection leak (fixed Week 4 Task #3)

`scripts/audit-infrastructure/run.ts`'s own orphan-detection scenario used
to create its disposable synthetic target under `EMAIL_PREFIX =
'tavora.fixture'` — the `tavora.fixture.%` namespace is deliberately
excluded from orphan detection **by default** to protect the six real,
persistent fixture identities (`provisionFixturePool()`), so this
suite's own test target was invisible to the very check it exists to
validate, leaking one disposable account per run. Fixed by moving the
meta-suite's own disposable accounts to their own dedicated namespace,
`tavora.metasuite.%` (registered above), which participates in orphan
detection normally. Verified live: two consecutive full meta-suite runs,
56/56 PASS both times, zero accumulated leftovers after either run, six
real fixture identities unchanged (`fixtures.ts` verify) before and after
both runs. See `docs/task-overdue-qa.md` for the full verification record.

## Live-cron isolation during audits

Two real bypass-insert scenarios write directly into
`reminder_notification_deliveries`, deliberately outside the normal RPC
path, to set up specific edge cases:

- **`reminder-audit/run.ts` scenario T**: deletes its row immediately after
  the assertion that needs it -- the tightest this window can be, since the
  assertion itself must read the row's post-edit state first.
- **`reminder-audit/timezone-and-schedule-race.ts` scenario P**: needs no
  immediate delete at all, because `connA`'s participants (including the
  recipient this scenario uses) are deliberately left at
  `server_push_enabled = false`, which `claim_due_recipient_reminder_deliveries()`
  gates on directly -- the row is never claimable by the real cron
  regardless of how long it survives until end-of-run cleanup.

`timezone-and-schedule-race.ts` scenario M is the one deliberate, real
integration exercise of the live claim path (`server_push_enabled = true`
for one isolated recipient) -- bounded to that one recipient, cleaned up
like everything else at the suite's end. No cron job is ever disabled for
ordinary audits; no sender validation is weakened.

## Fully flat suite graph

Every nested `execFileSync`/`runSuite()` call that used to invoke another
suite has been removed from all 10 scripts that had one -- including the
three zero-signup targets (`accessibility-audit`, `visual-consistency-audit`,
`ops-health`), so the graph can never silently regain fan-out if one of
those currently-static suites later gains signup behavior.
`scripts/final-regression/run.ts` is now the **only** place any complete
suite is invoked from another script -- verified structurally by the
meta-suite's scenario AM, which greps every suite's source for a reference
to any other suite's `run.ts` path.

## Process/network timeouts

`scripts/final-regression/run.ts` supervises each suite via
`child_process.spawn` (never `execFileSync`), with streamed stdout/stderr
into `artifacts/audits/<run-id>/<suite>.log`, a per-suite absolute timeout,
an inactivity watchdog, and full process-group termination
(`detached: true` + `process.kill(-pid, 'SIGTERM')`, escalating to
`SIGKILL`) on either timeout -- not just the immediate child, since a
stalled suite could itself have spawned something. `npx tsx
scripts/audit-infrastructure/status.ts [run-id]` inspects a run in progress
or after interruption by reading artifact files and live process state from
a separate invocation, without waiting on the orchestrator to unblock.

## Environment metadata and artifacts

See `docs/final-regression-runbook.md` for the full artifact-directory
layout and retention policy.
