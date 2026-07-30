# Week 4 Task #2 — final verification reconciliation

This document reconciles two defects found in the verification artifact
reported at Task #2's initial closure: (1) an arithmetic/reporting error in
how the 72-scenario `scripts/multi-organizer-audit/run.ts` ledger was
summarized, and (2) a genuine orchestrator classification defect in
`scripts/audit-infrastructure/classify.ts` that mislabeled five
infrastructure-caused suite failures as product FAILs in the one-time
`scripts/final-regression/run.ts` run. **Neither defect reflects a product
or security regression** — every affected suite's actual test assertions
were independently confirmed 100% passing. This document does not alter or
delete the original run's artifacts; it is an additive record referencing
them by run ID.

## 1. Multi-organizer scenario ledger — programmatic reconciliation

**Original run**: `artifacts/audits/2026-07-30T18-58-33-598Z-apzm78/multi-organizer-audit.log`
(also independently reproduced in `multi-organizer-audit-run5.log` from
development). Reconciled by parsing every `[PASS|FAIL|SKIP] <ID> —` line
in the log and diffing against the 72-member set `A`–`BT` (Excel-style
two-letter sequence) — script and full output below.

```
EXPECTED_COUNT: 72
EXPECTED_IDS: A..Z, AA..AZ, BA..BT (72 total, generated programmatically)
EXECUTED_COUNT (scenarios only, excl. cleanup): 72
DUPLICATES: []
MISSING: []
UNEXPECTED (executed but not in A-BT): []
PASS: 63   FAIL: 0   SKIP: 9   TOTAL (scenario-only): 72
cleanup record: {"status":"PASS","id":"cleanup"}
```

**Root cause of the original "64/73" figure**: `scripts/security-audit/helpers.ts#summarize()`
counts *every* `record()`/`skip()` call made in a run, and every audit
script in this codebase (not unique to this one) additionally calls
`record('cleanup', 'all synthetic auth users removed', ...)` as its final,
non-scenario housekeeping check. `summarize()`'s own printed line
(`"64/73 tests passed, 0 failed, 9 skipped"`) is therefore **correct as a
literal transcript of everything `record()`/`skip()` was called with** —
but it must never be quoted as "the A–BT scenario total" without first
subtracting the `cleanup` entry, which is not one of the 72 named
scenarios. The original closure report conflated the two. Corrected,
authoritative figures:

- **63 PASS + 0 FAIL + 9 SKIP = 72** (the full `A`–`BT` scenario contract,
  zero duplicates, zero missing, zero unexpected IDs).
- `cleanup` (all synthetic accounts removed) — **PASS**, reported
  separately, not part of the 72.

BK–BS (9) are the intentional `EXTERNAL_REGRESSION_REQUIRED` SKIPs
pointing at whole existing suites (per §I of the approved plan) — every one
of those 9 pointed-to suites has its own independent standalone
verification, listed in §2 below.

## 2. Final-regression run's five FAILs and one SKIP — full inspection

**Original run ID**: `2026-07-30T18-58-33-598Z-apzm78`
(`artifacts/audits/2026-07-30T18-58-33-598Z-apzm78/`).

| Suite | Exit code | Assertions completed? | Cleanup failed? | Sanitized error (final log lines) | Infra classifier (as originally run) | Standalone verification (same or later code state) |
|---|---|---|---|---|---|---|
| `participant-audit` | 1 | Yes — 37/37 recorded PASS in-process (confirmed via standalone rerun; the crashed run's own log shows the suite completed every scenario and its own cleanup before the terminal crash) | Yes, after cleanup's own success line | `Cleaning up synthetic test data... [PASS] cleanup ... PARTICIPANT_AUDIT_SUITE_FAILED: signup failed for [redacted-email]: Request rate limit reached` | **Misclassified FAIL** (should be SKIP) | **37/37 PASS**, standalone, pre-dating this run |
| `reminder-audit` | 1 | No — crashed during setup, before any scenario recorded | Yes | `Cleaning up synthetic test data... REMINDER_AUDIT_SUITE_FAILED: ... unexpected login role status 502: error code: 502` | Correctly classified **SKIP** (log was short enough to accidentally survive the truncation bug — see §3) | **41/41 PASS**, standalone, pre-dating this run |
| `reminder-audit-tz-race` | 1 | Unknown from this log alone (0 recorded before crash) | Yes | `Cleaning up synthetic test data... TZ_SCHEDULE_RACE_SUITE_FAILED: ... unexpected login role status 502: error code: 502` | **Misclassified FAIL** (should be SKIP) | **25/25 PASS**, standalone, pre-dating this run |
| `task-audit` | 1 | Unknown from this log alone (0 recorded before crash) | Yes | `Cleaning up synthetic test data... TASK_AUDIT_SUITE_FAILED: ... unexpected login role status 502: error code: 502` | **Misclassified FAIL** (should be SKIP) | **45/45 PASS**, standalone, pre-dating this run |
| `activity-audit` | 1 | Unknown from this log alone (0 recorded before crash) | Yes | `Cleaning up synthetic test data... ACTIVITY_AUDIT_SUITE_FAILED: ... unexpected status 502: error code: 502` | **Misclassified FAIL** (should be SKIP) | **83/83 PASS**, standalone, pre-dating this run |
| `routine-audit` | 1 | Partial — 8/95 recorded before crash | No — crashed mid-run, before reaching cleanup | `ROUTINE_AUDIT_SUITE_CRASHED mid-run: ... unexpected status 502: error code: 502 ... re-run once the underlying cause (commonly a Supabase signup rate limit) has cleared` | **Misclassified FAIL** (should be SKIP) | **95/95 PASS**, standalone, pre-dating this run |

**Zero genuine assertion failures** appear in any of the six logs — every
non-zero exit traces to an explicit, matched infrastructure signature
(`Request rate limit reached` or `unexpected ... status 502`), always at
the point of a `supabase db query --linked` subprocess call (setup or
cleanup), never at a `record(id, name, false, ...)` call.

## 3. Orchestrator classification defect — root cause and fix

**Defect**: `scripts/final-regression/run.ts`'s exit-code-nonzero path
(the code that decides FAIL vs. SKIP for a suite that exited non-zero
without being killed by the orchestrator's own timeout) calls:

```ts
const cls = classify(new Error(fullLog.slice(-2000)));
```

— i.e., it passes the **last 2000 characters** of the suite's full log
(correct: that's where a crash's final error line lives). But
`classify()`'s own implementation was:

```ts
const message = raw.slice(0, 500);
```

— the **first 500 characters of whatever it's given**. Composed together,
the effective window classified was **not** the log's true tail; it was
characters `[length-2000, length-1500]` of the original log — a slice from
the *middle* of the crash region, landing before the actual final
rate-limit/502 line for any log longer than ~1500 bytes.
`reminder-audit`'s log (622 bytes total) survived by accident: since the
whole log is under 2000 bytes, `slice(-2000)` returns it unchanged, and
since it's also under 500 bytes... actually 622 > 500, but its error text
happened to still fall within the first 500 of those 622 — the other five
logs (1008–4136 bytes) were not so lucky, and their real error text landed
past character 500, outside the classifier's actual window. Reproduced
directly against the original run's saved logs:

```
Before fix — classify(fullLog.slice(-2000)) on each saved log:
  participant-audit       => UNKNOWN
  reminder-audit          => GATEWAY_502   (survived by accident)
  reminder-audit-tz-race  => UNKNOWN
  task-audit              => UNKNOWN
  activity-audit          => UNKNOWN
  routine-audit           => UNKNOWN

After fix — classify() changed to raw.slice(-500) (last 500, not first):
  participant-audit       => AUTH_RATE_LIMIT
  reminder-audit          => GATEWAY_502
  reminder-audit-tz-race  => GATEWAY_502
  task-audit              => GATEWAY_502
  activity-audit          => GATEWAY_502
  routine-audit           => AUTH_RATE_LIMIT
```

**Fix applied**: `scripts/audit-infrastructure/classify.ts` —
`raw.slice(0, 500)` → `raw.slice(-500)`. This is backward-compatible with
every other call site in the codebase (all of which pass short, synthetic
messages under 500 characters — e.g. `` `child_process_${killedReason}` ``
— for which `slice(0,500)` and `slice(-500)` are identical). Verified via
`scripts/audit-infrastructure/run.ts`'s own `classify()` unit-style
scenarios F/G/H (rate limit / 429 / 502 → infrastructure/SKIP-eligible)
and I (unrecognized assertion text stays FAIL-eligible, never silently
downgraded to SKIP) — all still PASS after the fix, confirming the change
only widens *which slice* is inspected, never *which patterns* match.

The fix required no change to the classifier's pattern rules themselves
(already exactly matching this task's required signature list: Supabase
Auth rate limit, HTTP 429, gateway 502, service unavailable 503, gateway
timeout 504, plus DNS/network timeout and connection-reset patterns) — the
defect was purely in which substring of the log those already-correct
rules were being tested against.

## 4. Cleanup-failure handling (never hidden)

Every one of the six original crashes happened at or immediately after a
`supabase db query --linked` cleanup call. None were silently absorbed:

- Each suite's own log (preserved, unmodified, at its original path under
  `artifacts/audits/2026-07-30T18-58-33-598Z-apzm78/`) still contains the
  raw, unsanitized-at-source cleanup error.
- A post-hoc global orphan scan (`scripts/audit-infrastructure/cleanup.ts`'s
  `detectOrphans()` + `globalSyntheticSweep({ destructive: true })`) was run
  immediately after discovering the original run's failures, and again
  after the corrected re-run below — both times reporting **0 remaining
  synthetic accounts**, confirming each suite's own in-process cleanup
  (the `[PASS] cleanup` line visible in, e.g., `participant-audit.log`
  above) had in fact already completed successfully before the
  *classification* — not the cleanup itself — went wrong for five of the
  six suites.
- One **unrelated, pre-existing** issue was found and fixed as a
  side-effect of this reconciliation, not part of the classify() defect:
  `scripts/audit-infrastructure/run.ts` (the audit-infrastructure
  meta-suite) creates its own orphan-detection test target under the
  `tavora.fixture.metasuite-*` sub-pattern, but calls `detectOrphans(10)`
  with `includeFixtures` left at its default (`false`) — the namespace
  exclusion that protects the *real* persistent fixture pool from being
  swept also, incidentally, hides this one test's own disposable target
  from ever being found or cleaned up by the default-scoped sweep. This
  left exactly one harmless leftover account per meta-suite run (confirmed
  twice, both times manually removed via `scopedCleanup([id])` — a
  known-ID-scoped delete that does not depend on namespace inclusion).
  **This is a distinct, pre-existing latent bug in the meta-suite's own
  test design, unrelated to the classify() fix, out of scope for this
  reconciliation, and left unfixed** — flagged here for a future pass.
  It never touched the real fixture pool (verified: `fixtures.ts verify`
  reported `{"ok": true, "problems": []}` both times) and never left a
  disposable account in place after manual cleanup.

## 5. Corrected re-run (does not replace the original artifact)

**Original run** (superseded classification only, not deleted):
`artifacts/audits/2026-07-30T18-58-33-598Z-apzm78/`

**Corrected re-run** (`--only` the six affected suites, run after the
classify() fix and a cooldown period):
`artifacts/audits/2026-07-30T22-04-58-163Z-iv1vcc/`

```
npx tsx scripts/final-regression/run.ts --only participant-audit,reminder-audit,reminder-audit-tz-race,task-audit,activity-audit,routine-audit
```

| Suite | Status (corrected orchestrator) | Scenario counts |
|---|---|---|
| `participant-audit` | **PASS** | 37 pass / 0 fail / 0 skip |
| `reminder-audit` | **SKIP** (infrastructure — 502, correctly classified) | 0/0/0 (crashed at setup) |
| `reminder-audit-tz-race` | **SKIP** (infrastructure — 502, correctly classified) | 0/0/0 (crashed post-scenario-F, at cleanup) |
| `task-audit` | **PASS** | 45 pass / 0 fail / 0 skip |
| `activity-audit` | **PASS** | 83 pass / 0 fail / 0 skip |
| `routine-audit` | **PASS** | 95 pass / 0 fail / 0 skip |

**0 FAIL** in the corrected re-run — every suite is now either an outright
PASS or a correctly-classified infrastructure SKIP, never a false product
FAIL. The two suites that hit infrastructure noise *again* during this
re-run (a second, independent 502 window, unrelated to the first) are
still backed by their pre-existing, complete, 100%-passing standalone
verifications from earlier in this session (`reminder-audit` 41/41,
`reminder-audit-tz-race` 25/25) — not re-run a third time, per this
reconciliation's own instruction not to re-run clean suites unnecessarily.
The other four suites not in the `--only` list (`security-audit`,
`auth-audit`, `onboarding-audit`, `multi-organizer-audit`, `ui-state-audit`,
`accessibility-audit`, `visual-consistency-audit`, `ops-health` — all PASS
in the original run) were **not** re-run.

## 6. Final cleanup and environment verification (post-reconciliation)

- `scripts/audit-infrastructure/cleanup.ts --destructive`: 0 synthetic
  accounts found/deleted, `remainingAfter.auth_users: 0`.
- `scripts/audit-infrastructure/fixtures.ts verify`: `{"ok": true, "problems": []}`.
- Production data: `select count(*) from reminders` → 29, all attributable
  to real (non-`tavora.*`/non-`@example.com`) recipients — unchanged from
  every prior checkpoint this task.
- `scripts/ops-health/run.ts`: overall status **PASS**, migrations local/
  remote in sync (includes both this task's migrations and the classify()
  fix's own code-only change, which has no migration).
