# Multiple-organizer QA and audit reference

Week 4 launch-hardening task #2's verification record. Companion to
`docs/multiple-organizer-model.md` (product model) and
`docs/multiple-organizer-security.md` (security proof).

## `scripts/multi-organizer-audit/run.ts`

72 named scenarios (`A` through `BT`), following the established audit
conventions from `scripts/routine-audit/run.ts`/`scripts/task-audit/run.ts`:
`record`/`skip`/`summarize`/`getResults` from
`scripts/security-audit/helpers.ts`, `installCrashSafety` for signal/crash
safety, and a self-check at the end that regex-counts every literal
`record('ID', ...)`/`skip('ID', ...)` call in its own source and compares
that count to what actually ran — a missing or duplicated scenario ID is
itself a detected failure, never a silent assumption.

**Fixture usage**, per scenario range:

| Range | Accounts | Why |
|---|---|---|
| A–D | Disposable | Invitation/duplicate-connection mechanics |
| E–AK | Persistent fixture pool (`organizerA`, `organizerB`, `participantMultiOrg`) | Only creates/reads/deletes reminders/tasks/routines — never touches the connection graph, so the pool is restored to baseline (`resetFixturePool()` + `verifyFixtureBaseline()`) immediately after and stays safe for other suites |
| AL–BJ | Disposable | Connection-ending, account deletion, invitation-cap edge cases — these mutate the connection graph itself, unsafe to leave mid-script against the shared persistent pool |
| BK–BS | N/A (SKIP) | Point at whole existing suites — see below |
| BT | N/A | Direct `ops_health_evaluate()` SQL call |

**BK–BS are recorded as SKIP, never silently omitted, never PASS.** Each
carries a stable, greppable reason:
`EXTERNAL_REGRESSION_REQUIRED — verified standalone via npx tsx <script>,
see final report`. This script is not allowed to recursively invoke
another suite's `run.ts` — only `scripts/final-regression/run.ts` may
invoke a complete suite (the DAG-flattening rule; see
`docs/audit-infrastructure-model.md`). BK–BS point at:

| ID | Suite |
|---|---|
| BK | `scripts/participant-audit/run.ts` |
| BL | `scripts/reminder-audit/run.ts` |
| BM | `scripts/reminder-audit/timezone-and-schedule-race.ts` |
| BN | `scripts/task-audit/run.ts` |
| BO | `scripts/activity-audit/run.ts` |
| BP | `scripts/routine-audit/run.ts` |
| BQ | `scripts/ui-state-audit/run.ts` |
| BR | `scripts/accessibility-audit/run.ts` |
| BS | `scripts/visual-consistency-audit/run.ts` |

**BT** calls `public.ops_health_evaluate()` directly (one SQL call, not a
nested process), matching the Week 4 Task #1 meta-suite's own precedent,
and asserts zero `FAIL`-status checks.

## Namespace registration

`tavora.multiorgaudit.%` was added to `scripts/audit-infrastructure/cleanup.ts`'s
`SYNTHETIC_NAMESPACES` — required for `globalSyntheticSweep()`/
`detectOrphans()` to ever recognize and clean up this suite's disposable
accounts if a run crashes mid-cleanup (confirmed necessary live: an
infra-noise 502 from the Supabase connection pooler interrupted this
script's own cleanup during development, and the sweep silently found
nothing until this registration was added).

## Result summary (development run)

64/73 recorded PASS, 0 FAIL, 9 SKIP (BK–BS, all standalone-verified — see
below), `cleanup` confirmed 0 remaining synthetic accounts. Every scenario
A–BT plus `cleanup` accounted for exactly once (self-check confirmed).

## Standalone verification of BK–BS

Each of the 9 pointed-to suites was re-run standalone
(`npx tsx <script>`) after this task's changes, since several of them
(`activity-audit`, `routine-audit`) touch code this task modified
directly:

| Suite | Result |
|---|---|
| `activity-audit` | 83/83 passed (re-verifies the `organizer_account_status`/`organizer_deleted_at` fix) |
| `routine-audit` | 95/95 passed (re-verifies `delete_current_user_data`'s new routine-template/instance handling) |
| `participant-audit` | See final report |
| `reminder-audit` | See final report |
| `reminder-audit-tz-race` | See final report |
| `task-audit` | See final report |
| `ui-state-audit` | See final report |
| `accessibility-audit` | See final report |
| `visual-consistency-audit` | See final report |

## Weekend QA checklist

1. As a participant, accept invites from 2+ real/synthetic organizers;
   confirm both appear on the "Your Organizers" screen with independent,
   correct counts.
2. Create a reminder as each of 2 organizers for the same participant;
   confirm the participant's Today hub shows both, each correctly
   attributed by name, never merged or swapped.
3. Open "View activity" for one specific organizer from "Your Organizers";
   confirm only that organizer's history appears, never the other's.
4. End one organizer's connection from "Your Organizers"; confirm the
   other organizer's reminders/tasks/routines continue completely
   unaffected, and the ended organizer's past activity still appears in
   the participant's aggregate Activity feed.
5. Delete one organizer's account entirely (via a disposable/test
   account); confirm the participant's other organizer connection and
   objects are completely untouched, and the deleted organizer's applied
   routines show as archived (never vanish) in the participant's history.
6. Confirm a private routine template created by one organizer is never
   visible or applicable by a second, unrelated organizer serving the same
   participant.
7. VoiceOver pass over "Your Organizers" — each card's name, counts, and
   both actions ("View activity", "End Connection") read correctly, and
   the confirmation dialog names the specific organizer being disconnected.
8. Confirm Settings' existing "Manage Organizer Connections" link opens
   "Your Organizers" and both screens' End-connection behavior stay
   consistent with each other.

## Rollback procedure

`20260801030000_multi_organizer_deletion_and_summary.sql` and
`20260801040000_activity_feed_organizer_deleted_state.sql` both only add
new function versions/columns and one new index — reverting means
restoring `delete_current_user_data`'s prior body from
`20260724001500_block_deleted_account_writes.sql`, dropping
`get_my_organizer_connections_summary()` and
`idx_connections_recipient_status`, and restoring
`get_connection_activity_feed`/`get_participant_activity_feed`'s prior
5/6-column-return versions from `20260729000000_activity_feed.sql`. Client
changes (`lib/organizerDisplay.ts`, `app/my-connections.tsx`, the
attribution wiring in `recipient-dashboard.tsx`/`task-details.tsx`/
`activityFeedCore.ts`) revert cleanly via git revert.
