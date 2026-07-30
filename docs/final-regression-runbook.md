# Final-regression runbook

`scripts/final-regression/run.ts` is the **one canonical command** for a
full Tavora audit regression -- the only place any complete suite is
invoked from another script (Week 4 Task #1, Phase 8). See
`docs/audit-infrastructure-model.md` for the DAG-flattening background this
replaced.

## Running it

```
npx tsx scripts/final-regression/run.ts
npx tsx scripts/final-regression/run.ts --only security-audit,ops-health
```

Always try a small `--only` subset first when developing/verifying a
change -- do not repeatedly execute the full suite list during iteration.

## Suite order

Static/lint prep is a precondition, not a suite the orchestrator runs
itself (run `npx tsc --noEmit` / `npx expo lint` separately before
invoking this). Suite order:

1. `security-audit` (category: security -- a FAIL here stops the run)
2. `auth-audit`
3. `onboarding-audit`
4. `participant-audit`
5. `reminder-audit`
6. `reminder-audit-tz-race` (`reminder-audit/timezone-and-schedule-race.ts`)
7. `task-audit`
8. `activity-audit`
9. `routine-audit`
10. `ui-state-audit`
11. `accessibility-audit`
12. `visual-consistency-audit`
13. `ops-health`
14. final global-cleanup verification (not a suite -- see below)

No suite depends on another's leftover state -- every suite cleans itself
up (or, for the three fixture-using suites, resets the shared pool before
using it). The order may change if a future suite introduces a genuine
data dependency; it is not currently load-bearing.

## Execution model

Each suite runs via `child_process.spawn('npx', ['tsx', <script>], { detached: true, ... })`
-- never `execFileSync` -- so the orchestrator can supervise it without
blocking:

- stdout/stderr streamed line-by-line into `artifacts/audits/<run-id>/<suite>.log`
  as they're produced.
- an inactivity watchdog (default 10 min of silence) and an absolute
  per-suite timeout (default 20 min for signup-heavy suites, 5 min for the
  three static/read-only ones) run independently.
- on either timeout, the suite's **full process group** is killed
  (`process.kill(-pid, 'SIGTERM')`, escalating to `SIGKILL` after 5s) --
  not just the immediate child, since a stalled suite could itself have
  spawned something.
- a 5-second cooldown follows every signup-heavy suite, to reduce Supabase
  rate-limit pressure between suites.
- partial logs and partial JSON result artifacts are never truncated or
  deleted on timeout.

`npx tsx scripts/audit-infrastructure/status.ts [run-id]` inspects a run in
progress or after interruption -- reads artifact files and live process
state from a separate invocation, so it works even while the orchestrator
is still running or after it was killed. With no run-id, lists recent
runs.

## PASS / FAIL / SKIP / standalone-verified

Four outcomes, never conflated:

- **PASS** -- suite ran, all its own scenarios passed.
- **Genuine FAIL** -- a real product/security/cleanup assertion failed
  (`classify()` determined the failure was NOT infrastructure noise).
- **Infrastructure SKIP** -- classified via `scripts/audit-infrastructure/classify.ts`
  (rate limit, gateway 502/503/504, timeout, etc.) -- not executed to a
  conclusion this run.
- **Standalone-verified** -- a *separate*, explicitly-labeled result from
  re-running a previously-SKIPped suite on its own afterward. It never
  overwrites or replaces the original SKIP record for the orchestrated
  run -- both are kept and both are reported. Run the specific suite
  standalone (e.g. `npx tsx scripts/reminder-audit/run.ts`) and record the
  result yourself; the orchestrator does not do this automatically.

A skipped suite remains **unresolved** until its standalone run passes.
Do not report a run as "fully clean" while any SKIP lacks a standalone
verification.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Every required suite PASS (or SKIP since independently standalone-verified) and cleanup verified zero |
| `1` | A genuine FAIL, or the final destructive-cleanup verification did not reach zero |
| `2` | One or more infrastructure SKIPs remain unresolved (no standalone verification yet) |
| `3` | Orchestrator/configuration failure -- fixture-pool corruption detected pre-flight, a lock never acquired within its bounded wait, or an uncaught orchestrator-level exception |

The orchestrator also stops early (does not proceed to later suites) on a
genuine FAIL in `security-audit` specifically -- a security regression is
treated as a stop-the-line condition, not just one more failed suite.

## Startup safety

Every run begins with:

1. `detectOrphans()` -- a scan for synthetic accounts older than a grace
   period with no corresponding active run, swept immediately if found
   (the only mechanism that can recover from a prior run's `SIGKILL`/OOM/
   machine-shutdown, since nothing else runs in that case).
2. Fixture-pool pre-flight (`provisionFixturePool()` +
   `detectFixtureContamination()`) -- fails loudly with exit code `3`
   rather than letting any suite run against a partially-reset pool.

And ends with a final `globalSyntheticSweep({ destructive: true, includeFixtures: false })`
-- verified to reach zero non-fixture synthetic accounts before the run is
considered complete.

## Artifacts

`artifacts/audits/<run-id>/`:

- `<suite>.log` -- full streamed stdout+stderr, sanitized (emails/JWTs
  redacted via `classify.sanitize()`).
- `<suite>.json` -- structured `SuiteOutcome` (status, exit code, signal,
  scenario counts, timing).
- `summary.json` -- the whole run's aggregate result.
- `cleanup-report.json` -- the startup-orphan-sweep and final-verification
  cleanup reports.
- `environment.json` -- git commit, migration status, Node/Expo versions.

Never committed to git (`/artifacts/` is in `.gitignore`). No retention
job exists for this directory yet -- clean it up manually
(`rm -rf artifacts/audits/<old-run-id>`) once a run's logs are no longer
needed; there is no product-data reason to keep them long-term.

## What NOT to do

- Do not re-add a nested suite invocation to any of the 12 individual
  scripts -- `scripts/audit-infrastructure/run.ts` scenario AM structurally
  verifies the graph stays flat (greps every suite's source for a
  reference to another suite's `run.ts` path) and will fail if this
  regresses.
- Do not run the full, untargeted orchestrator repeatedly during
  development -- use `--only` for iteration, save the full run for actual
  verification checkpoints.
- Do not treat a SKIP as equivalent to a PASS in any report -- always
  either standalone-verify it or report it as unresolved.
