# Task overdue QA and audit reference

Week 4 launch-hardening task #3's verification record. Companion to
`docs/task-overdue-occurrence-model.md`, `docs/task-overdue-pagination.md`,
and `docs/task-schedule-versioning.md`.

## `scripts/task-overdue-audit/run.ts`

67 named scenarios (`A` through `BO`), following the established audit
conventions from `scripts/multi-organizer-audit/run.ts`: `record`/`skip`/
`summarize`/`getResults`, `installCrashSafety`, a self-check that
regex-counts every literal `record('ID', ...)`/`skip('ID', ...)` call in
its own source and compares it to what actually ran (a missing or
duplicated scenario ID is itself a detected failure, never a silent
assumption), and disposable-vs-fixture-pool account usage split by whether
a scenario mutates the connection graph.

| Range | Coverage |
|---|---|
| A-J | Recurrence-type/occurrence-boundary correctness (60+/300+ day completeness, weekday/weekend/selected-day generation, one-time single-occurrence, no-deadline never-overdue, today-vs-yesterday separation, future exclusion) |
| K-S | Terminal exclusion, response authority (completed-late, skip, idempotency, conflict rejection, ineligible-date rejection, unrelated-participant/organizer-as-participant denial) |
| T-V | Multi-organizer attribution (identical titles remain distinct, correct real-name attribution, deleted-organizer fallback via `resolveOrganizerDisplay` directly — not via pagination, since a deleted organizer's tasks are always deactivated and therefore never appear there) |
| W-AD | Cursor pagination contract (bounded first/second page, no duplicates/gaps across pages, stable tie-break ordering, cursor-tampering rejection, page-limit enforcement at >50/0/negative) |
| AE-AG | Client-side pagination robustness — verified via static source inspection of `app/overdue-tasks.tsx` (request-generation stale-guard, concurrent-load-more dedup, error-path cursor preservation), matching the established pattern for client behaviors an SQL-only audit can't directly exercise |
| AH-AJ | Archive/connection-ending cutoffs, cross-connection isolation |
| AK-AN | Schedule-version correctness (old rule preserved after a future-only edit, new rule applies only from its effective date, no overlapping/gapped segments) |
| AO-AR | Timezone authority (no RPC accepts a timezone parameter, Phoenix UTC-7-no-DST, New York DST spring-forward boundary) |
| AS-AU | Activity/analytics (old overdue response appears in Activity, wide analytics windows include schedule-version-correct old occurrences, organizer analytics isolation) |
| AV-AY | Notification non-flood (pagination is read-only, delivery ledger structurally can't repeat), performance proxy (timing), no N+1 organizer lookup |
| AZ | Structural audit assertion: `TASK_LOOKBACK_DAYS` absent from every authoritative path (Phase 14's explicit requirement) |
| BA-BI | Meta-suite orphan-leak fix verification (namespace fix confirmed, scoped cleanup, dry-run detection, destructive sweep excludes fixtures, interrupted-run recovery, fixture baseline restored, no bare `tavora.%` wildcard anywhere) |
| BJ-BN | `EXTERNAL_REGRESSION_REQUIRED` SKIP pointers to task-audit/activity-audit/ui-state-audit/accessibility-audit/visual-consistency-audit — never invoked recursively, verified standalone separately |
| BO | Direct `ops_health_evaluate()` call |

**BG is also an `EXTERNAL_REGRESSION_REQUIRED` SKIP**, not a live scenario:
this script must never recursively invoke `scripts/audit-infrastructure/run.ts`
(only `scripts/final-regression/run.ts` may invoke a complete suite) — "two
consecutive meta-suite runs leave zero disposable users" is verified by
actually running that suite twice, standalone, as its own dedicated
verification step (see below), not from inside this script.

## Result summary (development run)

Run 1 surfaced three genuine bugs, all fixed and re-verified clean:

1. **Scenario V's test design was flawed**, not the product: a deleted
   organizer's tasks are always deactivated by `delete_current_user_data`
   (matching the AH archive-cutoff rule exactly), so they can never appear
   via either new RPC (both correctly filter `is_active = true`). Fixed to
   test `resolveOrganizerDisplay()` directly against the real post-deletion
   `profiles` row instead — the same technique already proven in
   `scripts/multi-organizer-audit/run.ts` scenario AB.
2. **Scenario AZ false-positive**: `lib/taskLifecycle.ts`'s own updated
   docstring explanation mentioned the literal old constant name
   `TASK_LOOKBACK_DAYS` in prose while explaining why it was removed —
   correctly caught by the structural grep. Reworded to describe the
   history without repeating the literal identifier.
3. **A real bug in the immutability trigger**: `trg_prevent_task_schedule_version_history_mutation`
   was declared `BEFORE UPDATE OR DELETE`, which correctly blocks
   retroactively editing closed history but incorrectly also blocked
   *deleting* a closed segment row — including via a normal cascading
   delete of its parent `tasks` row (Postgres fires a child table's own
   triggers even for FK-cascade-driven deletes) and via ordinary test
   cleanup. Fixed to `BEFORE UPDATE` only, matching `task_occurrences`'s
   own equivalent trigger's established, deliberate precedent exactly
   (`20260801100000_fix_schedule_version_immutability_scope.sql`).

Run 2 (after all three fixes): **63/69 recorded results, 0 FAIL, 6 SKIP**
(BG + BJ-BN, all standalone-verified — see below). `cleanup` confirmed 0
remaining synthetic accounts. Every scenario A-BO plus `cleanup` accounted
for exactly once (self-check confirmed; `AK` legitimately records twice —
two related sub-assertions under one scenario, the same established
multi-`record()`-per-id pattern used throughout every other audit script
in this codebase).

## Standalone verification of BJ-BN (and BG)

Each pointed-to suite was re-run standalone after this task's changes,
since several of them (`task-audit`, `activity-audit`) touch code this
task modified directly:

| Suite | Result |
|---|---|
| `scripts/audit-infrastructure/run.ts` (BG) | Run twice consecutively: 56/56 passed both times, 0 FAIL, `cleanup` confirmed 0 remaining both times — proves the orphan-leak fix works and does not regress across repeated runs |
| `task-audit` | See final report |
| `activity-audit` | See final report |
| `ui-state-audit` | See final report |
| `accessibility-audit` | See final report |
| `visual-consistency-audit` | See final report |

## Weekend QA checklist (physical device)

1. As a participant, let a daily task accumulate several weeks of
   unresolved history; confirm Today shows a bounded preview (5 items)
   with a "View all overdue" link, and the dedicated screen shows the
   complete history with working pagination.
2. Complete/skip several old overdue occurrences from the dedicated
   screen; confirm each one disappears immediately and the rest of the
   list stays stable (no reshuffle, no duplicate).
3. As an organizer, edit a recurring task's schedule (e.g. daily →
   weekdays); confirm the participant's old unresolved dates under the
   previous schedule remain correctly respondable, and new dates follow
   the new rule.
4. Archive a task with unresolved overdue occurrences; confirm they
   disappear from the participant's overdue list entirely, and any other
   task (including from a different organizer) is unaffected.
5. VoiceOver pass over "View all overdue" and the dedicated screen's
   cards, loading-more state, and empty state.
6. Confirm long task titles and Spanish text expansion don't break the
   overdue card layout; confirm dark mode and Reduce Motion behave
   correctly.

## Rollback procedure

See each new migration's own trailing rollback comment
(`20260801050000` through `20260801100000`). Client changes
(`lib/taskLifecycle.ts`, `lib/taskData.ts`, `app/overdue-tasks.tsx`, the
attribution/summary rewiring in `app/tasks.tsx`/`app/task-details.tsx`/
`app/recipient-dashboard.tsx`) revert cleanly via git revert. The
meta-suite namespace fix (`scripts/audit-infrastructure/run.ts` +
`cleanup.ts`) is independent and can be reverted separately without
affecting anything else in this task.
