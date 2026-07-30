# Multiple-organizer security model

Week 4 launch-hardening task #2's security proof: connection isolation,
private-template privacy, and account-deletion/connection-ending isolation
across multiple simultaneous organizer connections for one participant.
Companion to `docs/multiple-organizer-model.md` (the product model) and
`docs/routine-security-model.md` (the pre-existing per-routine RLS
contract, unchanged by this task except where explicitly noted). Every
claim here is backed by a live, automated test in
`scripts/multi-organizer-audit/run.ts` (letter references below).

## RLS is inherently multi-organizer-safe

Confirmed via direct schema introspection, not assumption: every object
table's RLS predicate is `auth.uid() = caregiver_id OR auth.uid() =
recipient_id` (or `organizer_id`/`participant_id` for routine tables) —
there is no single-organizer assumption anywhere in these policies. A
participant with N accepted connections simply has N matching rows across
N distinct `connection_id`s; nothing about RLS needed to change for this
task.

## Cross-organizer isolation (verified live, two organizers sharing one participant)

Using the persistent fixture pool's `organizerA`/`organizerB`/
`participantMultiOrg` (already connected to both organizers by
`resetFixturePool()`'s own baseline):

- OrganizerA cannot read OrganizerB's reminder for the shared participant
  (scenario H), cannot mutate it (I), cannot read their task (M), cannot
  read their routine instance (O), cannot read their private routine
  template (V), cannot apply it (W), and cannot read their
  `reminder_logs` row (Y).
- Each organizer's own connection-scoped read never includes the other
  organizer's rows despite sharing the same `recipient_id` (T).
- Notification-delivery rows always resolve back to exactly the intended
  connection via their reminder/task join (U).
- `get_my_organizer_connections_summary()` keeps each organizer's
  `active_reminder_count`/`active_task_count`/`active_routine_count` fully
  independent even though both connections share a recipient (X).
- Two organizers sharing the *identical* `full_name` remain fully isolated
  by ID — authorization is never name-based (BB).

## Private-template privacy

`routine_templates` RLS has exactly one SELECT policy: `owner_id =
auth.uid()` (confirmed via direct `pg_policies` introspection, scenario
AJ) — there is no branch that grants visibility via a shared participant.
OrganizerB cannot read OrganizerA's private template (V) and cannot apply
it to their own connection — `apply_routine_template` re-checks ownership
and returns `template_not_found` (deliberately not a distinguishable
"forbidden" code, so template existence isn't leaked to a non-owner) (W).

## Connection-ending isolation (multi-organizer, disposable-account proof)

Two independent organizers, one shared participant, each with their own
reminder + task:

- Ending organizer1's connection deactivates only organizer1's reminder +
  task for the shared participant (AL).
- Organizer2's connection status and reminder/task `is_active` are
  completely unaffected (AM).
- The participant's own `get_my_organizer_connections_summary()`
  correctly reflects organizer1 as no longer accepted while organizer2's
  row remains fully accurate (AN).
- The participant's Activity feed still includes the ended connection's
  **past** activity — history isolation, never deletion (AO).
- Ending every connection but one leaves the remaining connection fully
  functional end to end — create, respond, no cross-contamination (BG).

## Account-deletion isolation, including routines (§J)

Two independent organizers apply a routine each to one shared participant;
one organizer's account is then deleted (`delete_current_user_data`):

- The deleted organizer's `routine_instances.status` flips to `'archived'`
  (never deleted) (AP).
- The other organizer's `routine_instances.status` remains `'active'`,
  completely unaffected (AQ).
- The other organizer's routine member reminders/tasks remain
  `is_active = true` (AR).
- The deleted organizer's pending/failed `routine_notification_deliveries`
  are cleaned up; the other organizer's are untouched (AS).
- The deleted organizer's `routine_instances.title`/`source_version`
  snapshot is byte-identical before and after deletion — even though the
  source template itself was hard-deleted in the same operation (AT).
- The deleted organizer's private `routine_templates` are hard-deleted
  (AU); the shared participant's own account and the other organizer's
  connection are entirely unaffected (AV).
- **Reverse direction**: deleting the shared *participant's* account
  correctly archives **both** organizers' routine instances (AW), while an
  unrelated participant's own reminder is completely unaffected — a direct
  blast-radius control (AX).
- An organizer whose sole connection was already ended can still have
  their account deleted cleanly, no crash (BH).

See `docs/routine-security-model.md`'s "Week 4 Task #2 fix" for the exact
`delete_current_user_data()` SQL and the pre-existing gap it closed.

## Invitation and duplicate-connection rules

- A participant accepting invites from two independent organizers creates
  two independent accepted connections — no participant-side cap exists
  anywhere in the invite/accept path (scenarios A/B, re-verified live at a
  third organizer in BE/BF).
- A second, fresh invite between an *already-accepted* pair is rejected
  `already_accepted`, and `connections_unique_accepted_pair` guarantees no
  duplicate row is ever created for that identical pair (C).
- `create_invite_code`'s `p_existing_connection_id` path only ever
  regenerates a still-**pending** invite's code (matches
  `participants.tsx`'s real "Replace code" action) — it structurally
  cannot touch an already-accepted connection, and regenerating one
  pending invite never disturbs the same organizer's separate, already-
  accepted connection to another participant (BC).
- The per-organizer 5-participant cap (`docs/participant-management-model.md`)
  is enforced correctly regardless of how many *other* organizers those
  participants also have — it is scoped strictly to `caregiver_id =
  auth.uid()` (BD).
- An organizer cannot accept their own invite code, even one already
  managing multiple connections (`self` rejection, re-verified in a
  multi-organizer context, AY).

## Structural guards (never rely on convention alone)

- **No stale-attribution surface**: `reminders`/`tasks` have no column of
  their own for an organizer's name (AG).
- **No combined-analytics entrypoint**: `task_analytics_summary` requires
  an explicit `p_connection_id` with no default (AI); there is no
  reminder-analytics RPC at all.
- **No private data in notification payloads**: the private-mode push
  title/body are fixed generic constants; the send function never
  references an `organizer_name`/`caregiver_name` field (Z).
- **Zero-orphan check**: no active reminder in this audit's own synthetic
  data ever references a non-accepted connection (BI).

## Hard constraints (never introduced by this task)

No participant organizer-count limit. No team/workspace/enterprise
abstraction. No shared templates. No RLS policy weakened — every existing
policy predicate is unchanged; only two new functions
(`get_my_organizer_connections_summary`, and the `delete_current_user_data`/
activity-feed functions' *additive* return columns) were added. No
client-side-only security — every isolation guarantee above is enforced by
RLS or a `SECURITY DEFINER` function's own re-checked authorization, never
by the client simply choosing not to ask for another organizer's data. No
organizer email, push token, or raw internal ID exposed beyond what
"Users can view connected profiles" already permitted. No device-timezone
authority. No shared-history deletion — every account-deletion path
archives or tombstones, never hard-deletes participant-facing history.
