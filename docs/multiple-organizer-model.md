# Multiple-organizer participant model

Week 4 launch-hardening task #2: complete multiple-organizer participant
support, organizer attribution, connection isolation, and cross-organizer
privacy verification. Companion to `docs/participant-management-model.md`
(Phase 10's original decision to support this at all),
`docs/multiple-organizer-security.md` (the RLS/isolation/deletion proof),
and `docs/multiple-organizer-qa.md` (the audit-script reference). Every
claim here is backed by a live, automated test in
`scripts/multi-organizer-audit/run.ts` (letter references below).

## The authoritative rule

A participant ("Loved One"/etc.) can have any number of simultaneously
accepted organizer ("Care Partner") connections. Each connection is an
**independent authorization and lifecycle boundary**:

- Every reminder/task/routine belongs to exactly one `connection_id`.
- Each organizer manages only their own connection's objects — never
  another organizer's, even for the same shared participant.
- The participant's own views (Today, Activity, My Connections) aggregate
  across every accepted organizer with correct, never-merged, never-hidden
  attribution.
- Ending or deleting one connection/account must never affect another.
- Private templates are never participant- or other-organizer-visible.
- Analytics are always connection-specific; there is no "combined" view.
- Activity may aggregate across connections but must always retain
  per-event organizer attribution.

There is **no participant-side organizer cap**, **no team/workspace
abstraction**, and **no merging of organizer accounts** anywhere in this
model — those were explicit non-goals (see
`docs/multiple-organizer-security.md`'s "Hard constraints").

## What was already correct (found by direct audit, not assumed)

A full read-only investigation confirmed most of the product was already
multi-organizer-safe before this task, because RLS was never written with
a single-organizer assumption in the first place:

- Every object table's RLS policy reads `auth.uid() = caregiver_id OR
  auth.uid() = recipient_id` (or `organizer_id`/`participant_id`) — a
  participant with N organizers simply has N matching rows across N
  connections.
- `connections_unique_accepted_pair` is a *partial* unique index on
  `(caregiver_id, recipient_id) WHERE status='accepted'` — unlimited
  distinct organizers per participant, one accepted row per distinct pair
  (scenario B).
- `create_invite_code`'s 5-participant cap is scoped to `caregiver_id =
  auth.uid()` — an organizer's own cap, never a participant-side one
  (scenario BD).
- `end_connection` mutates only the one `connection_id` it's given.
- Tasks and Activity were already fully multi-organizer-aware, including
  attribution (`lib/taskData.ts#fetchTasksForRecipient`,
  `get_participant_activity_feed`).
- `components/settings-sheet.tsx` already batch-fetches every accepted
  organizer connection and names each one in its End-connection picker.

## The gaps this task closed

1. **Reminders had no organizer attribution client-side.**
   `app/recipient-dashboard.tsx` aggregated reminders correctly but never
   rendered an owning organizer's name — see "Organizer attribution" below.
2. **`delete_current_user_data()` never touched routine data** — see
   `docs/routine-security-model.md`'s "Week 4 Task #2 fix".
3. **No index on `connections(recipient_id, status)`** — added
   (`idx_connections_recipient_status`), matching every other
   participant-scoped table.
4. **No dedicated participant connections screen** — `app/my-connections.tsx`,
   see below.
5. **No shared "organizer display" helper** — `lib/organizerDisplay.ts`,
   see below. Building it surfaced the identical conflation bug already
   living in the Activity feed (`get_connection_activity_feed`/
   `get_participant_activity_feed` only ever returned `full_name`) — fixed
   in the same pass; see `docs/activity-feed-model.md`.
6. **No automated multi-organizer audit existed** —
   `scripts/multi-organizer-audit/run.ts`, see `docs/multiple-organizer-qa.md`.

## Organizer attribution: the three-way resolution rule

`lib/organizerDisplay.ts#resolveOrganizerDisplay(organizerId, profile, t)`
is the single shared resolver used by reminders
(`app/recipient-dashboard.tsx`), tasks (`app/task-details.tsx`), Activity
(`lib/activityFeedCore.ts`), and the new connections screen
(`app/my-connections.tsx`). It distinguishes three genuinely different
situations that an earlier, rejected draft of this module collapsed into
one:

| Situation | `full_name` | `account_status`/`deleted_at` | `fallbackKind` | Display |
|---|---|---|---|---|
| Named, active organizer | set | active, null | `named` | The real name |
| Active organizer, never set a name | `null` | active, null | `unavailable` | Generic "Organizer" label |
| Profile fetch failed/hasn't loaded | n/a (no row) | n/a | `unavailable` | Generic "Organizer" label |
| Deleted organizer | `null` (scrubbed) | `'deleted'` / set | `deleted` | "A former organizer" |

The critical rule: **"deleted" is only ever inferred from the explicit
`account_status`/`deleted_at` fields, never from a bare null/undefined
name.** A legitimately active organizer can simply never have set a
`full_name` — that must never read as "gone." Every call site batch-fetches
at minimum `id, full_name, account_status, deleted_at` (all already
readable under the existing "Users can view connected profiles" RLS policy
— no new grant needed). Verified directly: scenario AA (unnamed-but-active
resolves to `unavailable`, never `deleted`) and scenario AB (a genuinely
deleted organizer resolves to `deleted`).

**Attribution-failure isolation** (scenario AZ): if one organizer's profile
fetch fails while fetching several, only that one item's label falls back
to `unavailable` — a correctly-loaded second organizer's name is
completely unaffected, and the underlying reminder/task/routine object list
itself is never withheld or reassigned (scenario BA) — only the *display*
degrades, never *availability* or *authorization*.

**Attribution never authorizes anything** (scenario BB): every object
lookup authorizes by object ID + connection ID + `auth.uid()` + active-
connection state only. Organizer/participant display names are
presentation-layer data fetched *after* authorization succeeds. Verified
directly by giving two organizers the identical `full_name` and confirming
RLS still keeps their objects fully isolated by ID.

## `app/my-connections.tsx` ("Your Organizers")

Participant-only screen listing every accepted organizer connection as its
own independent card — reachable from Settings ("Manage Organizer
Connections", shown whenever the participant has ≥1 accepted connection;
`components/settings-sheet.tsx`'s existing lightweight End-connection
picker is left fully intact alongside it).

- Backed by one new RPC, `get_my_organizer_connections_summary()`
  (`SECURITY DEFINER`, `STABLE`, `auth.uid()`-derived — no participant-id
  route parameter exists to tamper with), which returns each connection's
  status, `accepted_at`, the organizer's display fields, and independent
  `active_reminder_count`/`active_task_count`/`active_routine_count` via
  three `LEFT JOIN LATERAL` counts — one grouped query, not N+1 (query plan
  confirmed via direct `EXPLAIN` during implementation). Grants
  (`authenticated` only, `revoke ... from public, anon`) copied exactly
  from the already-existing `get_participant_activity_feed`.
- "View activity" reuses the **already-built** `get_connection_activity_feed`
  RPC via `router.push({ pathname: '/activity', params: { connectionId } })`
  — that RPC's own authorization (`recipient_id = auth.uid()`) already
  permits the participant themselves, zero new backend work.
- "End Connection" reuses the existing `end_connection` RPC (the same one
  `settings-sheet.tsx` calls), with a confirmation naming the specific
  resolved organizer.
- Refreshing after an action always re-calls the summary RPC — never
  locally patches/removes a row, so there is no stale-count risk.
- Never hides a connection for having zero active objects (scenario AH) —
  presence in the list is independent of the count columns.

## Aggregation surfaces and their isolation guarantees

| Surface | Aggregates across organizers? | Retains per-organizer attribution? | Verified |
|---|---|---|---|
| Today hub (`recipient-dashboard.tsx`) | Yes | Yes (this task's fix) | scenario P |
| Participant Activity (`get_participant_activity_feed`) | Yes | Yes | scenario Q |
| Connection-scoped Activity (`get_connection_activity_feed`) | No — exactly one connection | N/A | scenario R |
| `get_my_organizer_connections_summary` | Yes (one row per connection) | Yes — independent counts per row | scenario X |
| Organizer's own `task_analytics_summary` | No — one `p_connection_id` required | N/A | scenario S, AI |
| Organizer's own reminder/task read (dashboard) | No — scoped by `connection_id` | N/A | scenario T |

**No merged/combined analytics entrypoint exists anywhere** — verified
structurally, not just by convention: `task_analytics_summary` requires an
explicit `p_connection_id` with no default (scenario AI), and there is no
equivalent reminder RPC at all (reminder "analytics" is computed
client-side from an already connection-scoped read).

## No stale attribution, structurally

`reminders` and `tasks` have no column of their own that stores an
organizer's name (scenario AG) — attribution is always freshly resolved
from `profiles` at read time, never snapshotted anywhere that could go
stale. (Routines are the one deliberate exception, and only for their own
title/schedule: `routine_instances.title`/`source_version` are intentional
apply-time snapshots, independent of the source template's later edits or
deletion — see `docs/routine-security-model.md`.)

## Hard constraints respected

No participant organizer-count limit was introduced. No team/workspace
entity was introduced. No shared templates were introduced (private
templates remain strictly `owner_id`-scoped). No RLS policy was weakened.
No existing reminder/task/routine lifecycle semantics changed. No
organizer name appears in a private push notification preview (scenario
Z). No device-timezone authority was introduced (routine apply already
required a valid participant-side IANA timezone; unchanged). No
enterprise/payment concepts were introduced.
