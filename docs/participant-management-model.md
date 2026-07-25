# Tavora participant management model

Week 2 product-polish task #2: multi-participant management, participant
switching, connection organization, and five-participant readiness.
Companion to `docs/onboarding-model.md` (connection/invite basics),
`docs/reminder-state-model.md` (delivery/response semantics), and
`docs/reminder-editing-model.md` (schedule editing) — this document covers
everything about managing *more than one* connection at a time.

## Participant-count rules

**Launch-plan behavior, not an entitlement system.** `MAX_STANDARD_PARTICIPANTS
= 5` (`lib/limits.ts`) is a fixed per-account cap for every standard
account — there are no paid tiers, no RevenueCat integration, and no
enterprise/organization roles in this task. A future task can replace the
hardcoded `5` in both `lib/limits.ts` and `create_invite_code()`
(`supabase/migrations/20260727000000_participant_limit_and_connection_ending.sql`)
with a real per-account entitlement lookup without changing either
function's external contract (the client constant and the server check
must simply stay numerically in sync until that happens).

**Participants never pay, and payment is never implied as currently
required anywhere in this task's UI** — the pre-existing "Tavora Plus"
upsell screen (`app/invite-recipient.tsx`, shown once an organizer is at
the limit) was reworded to describe a *future* update rather than an
active purchase flow, and its disabled "Coming soon" button is unchanged.

## Pending-versus-active counting

The single source of truth for what counts as a slot is
`lib/connectionStateCore.ts`'s `categorizeConnection()` — a pure function
with zero dependencies (importable from both the app and
`scripts/participant-audit/run.ts`), mirrored exactly by
`create_invite_code()`'s own SQL:

| `connections` row | Category | Counts toward the limit? |
|---|---|---|
| `status = 'accepted'` | `active` | Yes |
| `status = 'pending'`, `expires_at` in the future or null | `pending` | Yes |
| `status = 'pending'`, `expires_at` in the past | `expired_pending` | No |
| `status = 'ended'` | `ended` | No |

An **ended** connection is the single calm outcome for two different real
situations: a deliberate `end_connection()` call, or a side effect of
either party deleting their account (`delete_current_user_data()` already
sets every one of a deleting account's connections to `'ended'`) — a
deleted counterpart is therefore never exposed as if still a normal active
participant; their connection simply reads as ended, the same as any other
ended connection.

## Selected-participant persistence

`lib/selected-participant.ts` stores the currently-viewed participant's
`connection_id` in AsyncStorage, **keyed by `userId`**
(`tavora.selectedParticipantConnectionId.<userId>`) — this task's fix for
a real gap found in Phase 1's audit: the key used to be a single global
string shared by every account that ever signed in on the device. Not
previously exploitable (a stale id was always re-validated against the
current user's own connections before use — see below), but it violated
`lib/accountCleanup.ts`'s own documented cleanup contract. Now each
account's selection is genuinely independent, and
`clearAccountScopedLocalState()` (called by `logout()`, account deletion,
and every account-status-tombstone check that previously bypassed it —
`caregiver-dashboard.tsx`, `recipient-dashboard.tsx`, `signin.tsx`) looks
up the currently-signed-in user and clears their specific key before
`signOut()` runs.

**Resolution priority**, unchanged from before this task
(`caregiver-dashboard.tsx`'s `loadDashboardData()`):

```
1. An explicit route param (e.g. returning from Create/Edit Reminder,
   or tapping a card on the Participants screen)
2. Whatever is already selected in this session (in-memory ref)
3. The value restored from AsyncStorage (app restart)
4. The first participant in the freshly-fetched list
```

Every candidate from steps 1–3 is **re-validated against the caregiver's
own freshly-fetched accepted connections** before being used — a stale,
foreign, or ended-connection id simply fails to match and falls through to
the next tier, ultimately the first real participant. This is what makes
"invalid stored selection falls back safely" true without any special-case
code (verified: `scripts/participant-audit/run.ts` scenario R).

## Switching behavior

`app/caregiver-dashboard.tsx`'s horizontal `ParticipantSelector`:

- Shows every accepted participant as a chip (name + avatar-initial), the
  selected chip marked by both a background/border color change **and** a
  non-color checkmark badge on the avatar (never color-only — see
  Accessibility below).
- A short relationship label (e.g. "Loved One", "Athlete", "Team Member")
  is read from the organizer's own onboarding `use_case`
  (`getRoleLabelKeys` — display-only, see `docs/onboarding-model.md`) and
  used in each chip's accessibility label, plus shown per-row on the
  Participants screen.
- Tapping a chip calls `selectParticipant()`, which updates the in-memory
  ref + AsyncStorage synchronously, then calls `loadReminderData()` for
  the new connection — the previous participant's analytics never persist
  on screen past that point (see the stale-response guard below).
- A `[header count] N of 5 participants — Manage` row above the chips
  links to the full `app/participants.tsx` screen.

**Atomic refresh / no stale flash (Phase 8).** `loadReminderData()` now
carries a request-generation counter (`loadGenerationRef`, incremented on
every call). Every `setState` call after an `await` boundary is preceded
by a check that the generation is still current; if a newer switch has
started, the stale in-flight call silently discards its result instead of
writing anything — so a slow response from Participant A can never
overwrite Participant B's screen with A's data, even momentarily.
`dashboardLoading` stays `true` for the whole window (an explicit loading
state, not a flash of stale content) until the *current* generation's load
finishes.

## Five-participant enforcement

Authoritative and server-side, in `create_invite_code()`:

1. `SELECT ... FROM profiles WHERE id = auth.uid() FOR UPDATE` — locks the
   caller's own profile row, serializing concurrent calls from the *same*
   caregiver (the same pattern `update_reminder_schedule()` already used
   for an equivalent reason — see `docs/reminder-editing-model.md`).
2. Regenerating an existing pending invite (`p_existing_connection_id` set)
   never re-checks the limit — that row already occupies a counted slot.
3. A genuinely new invite counts `accepted + non-expired pending` and
   raises the fixed exception `participant_limit_reached` at exactly 5.

Because the count-then-insert sequence is serialized per-caregiver by the
row lock, **concurrent invite creation cannot exceed five** — verified
directly by firing three concurrent `create_invite_code()` calls at 4/5
occupied and confirming exactly one succeeds
(`scripts/participant-audit/run.ts` scenario G).

**Client-side mirror**: `lib/connections.ts`'s `fetchOrganizerConnections()`
computes `slotsUsed` using the identical `categorizeConnection()` logic, so
the UI's "N of 5" indicators and the "Add participant" lock icon can never
disagree with what the server will actually allow. `invite-recipient.tsx`
still fails closed if a race lets a stale client-side count through: the
server's `participant_limit_reached` error is caught and shown as a
friendly, stable message (`inviteParticipant.limitReachedTitle`/
`limitReachedMessage`), never a raw Postgres string.

**Legacy/over-limit accounts**: nothing in this task deletes or forcibly
ends any existing connection to bring an already-over-5 account down to
the limit — the check only ever blocks *new* invite creation going
forward, per the task's own explicit requirement.

## Connection ending

`end_connection(p_connection_id)` — did not exist before this task
(previously `'ended'` was reachable only as a side effect of full account
deletion). Callable by either party:

- `SELECT ... FOR UPDATE` + a membership check
  (`caregiver_id = auth.uid() OR recipient_id = auth.uid()`) — an
  unrelated third party gets `not_authorized`.
- **Idempotent**: ending an already-`'ended'` connection is a silent
  success, not an error (a double-tap, a retry, or two devices ending the
  same connection all resolve identically).
- Sets `status = 'ended'`, then deactivates (`is_active = false`) every
  reminder tied to that connection. This is the actual mechanism that
  stops future deliveries: both claim functions
  (`claim_due_recipient_reminder_deliveries()`/
  `claim_due_recipient_snooze_deliveries()`) already require
  `r.is_active = true AND c.status = 'accepted'`, and
  `validate_reminder_deliveries_for_send()` already fails closed with
  `reminder_inactive`/`connection_inactive` for anything already claimed
  but not yet sent (see `docs/reminder-editing-model.md`) — no new
  mutation of `reminder_notification_deliveries` was needed or added.
- `reminder_logs` (historical responses) is **never** touched — identical
  to the existing account-deletion path.
- **Cannot be undone through ordinary client writes**: `connections` has
  no client-facing UPDATE policy at all (every mutation goes through
  `SECURITY DEFINER` functions) — reconnecting requires an entirely new
  `create_invite_code()`/`accept_invite_code()` cycle.

**Client-side reachability**: organizers end a connection from
`app/participants.tsx` ("Manage" → "End connection", with an explicit
confirmation dialog naming the participant); participants end their own
from Settings ("End connection" — if they have more than one accepted
organizer, a picker names each one before confirming). Both call the same
`lib/connections.ts#endConnection()` helper.

**Selected-participant safety on ending**: since `end_connection()` flips
the row's status, the next `loadDashboardData()` (triggered by the
Participants screen's own reload after the action, or the dashboard's next
focus) naturally excludes it from `acceptedConnections`, and the existing
selection-fallback chain picks the next valid participant — no
special-cased "what if the selected one just ended" branch was needed.

## Reminder-creation scoping

`create-reminder.tsx`'s participant pre-selection is unchanged from
before this task (an explicit route `connectionId` param, set correctly by
every entry point — the dashboard's "+" button, and now also
`participants.tsx`'s per-row "Create reminder" action) — explicit
selection was always required with 2+ participants and no valid
pre-selection.

**Server-side enforcement (already existed, unchanged by this task)**: the
`reminders` INSERT/UPDATE RLS policies already require
`caregiver_id = auth.uid()`, an **accepted** connection row matching
`connection_id`/`caregiver_id`/`recipient_id`, and an active account — so
a reminder can never be created against a stale, ended, or
never-accepted connection, with or without a client-side check. This
task's only change here is **client-side error friendliness**: a raw
RLS-violation string is now caught and shown as
`reminderForm.connectionEndedTitle`/`connectionEndedMessage`, with a
redirect to the Participants screen, instead of a raw Postgres message.

## Analytics isolation

Every reminder/analytics query in `caregiver-dashboard.tsx`,
`create-reminder.tsx`, `edit-reminder.tsx`, and `reminder-details.tsx` is
filtered by a specific `connection_id` — confirmed unchanged from Phase 1's
audit and re-verified directly by `scripts/participant-audit/run.ts`
scenarios H/I/J/Y (two participants' reminder/log sets never overlap, and
scoped queries for one never return the other's rows). **No combined
totals are ever silently computed** — the only place multiple
participants' data is shown together is the new, deliberately narrow
"N active participants / total active reminders" summary on
`app/participants.tsx` (see below), which is explicitly labeled and uses
only counts that require zero extra queries.

**Stale in-flight response protection**: see "Switching behavior" above —
the same `loadGenerationRef` guard that prevents a stale flash during a
switch is exactly what Phase 8 asks for ("a slower response from
Participant A must not overwrite Participant B's screen").

Analytics *definitions* (adherence %, countable denominator, missed
authority, etc.) are completely unchanged from Week 1 — see
`docs/reminder-analytics-model.md`.

## Multiple-organizer behavior (Phase 10 decision)

**Chosen: Option A — multiple organizers are allowed and supported.**

The schema already structurally allows it (the only accepted-pair
uniqueness constraint is `(caregiver_id, recipient_id)`, not `recipient_id`
alone), and most of the codebase already handled it correctly before this
task (`recipient-dashboard.tsx` merges reminders from every accepted
organizer with no per-organizer filter; `lib/onboarding.ts`'s
`recipientHasAcceptedConnection()` uses a `count`, not a single-row fetch).
Choosing Option B (restrict to one) would have meant *removing* already-
working, already-secure capability for no stated product reason — this
task instead fixed the one real gap and made the existing behavior
understandable:

- **Fixed**: `components/settings-sheet.tsx`'s recipient branch used to
  fetch `.limit(1).maybeSingle()` with no ordering — a second organizer
  was silently invisible. Now fetches every accepted organizer, batches
  their names, and shows `settings.connectedToOne`/`connectedToManyOrganizers`
  (mirroring the caregiver side's existing singular/plural pattern).
- **Each reminder is already organizer-attributed** at the data level
  (`reminders.caregiver_id`) — `scripts/participant-audit/run.ts` scenario
  W confirms a participant with two organizers sees reminders from both,
  each correctly attributed, with no merge/conflict.
- **Ending one connection never affects another** — `end_connection()`
  only ever touches the one row it's given and reminders scoped to that
  one `connection_id` (scenario X).
- **Push/reminder authorization stays connection-specific** — nothing
  about this task changed the RLS predicates or claim-function
  eligibility checks, which were already keyed by `connection_id`, never
  by recipient alone.
- **Organizer identity exposure**: a participant can see each connected
  organizer's name (needed to make sense of "who sent this") via the same
  "Users can view connected profiles" RLS policy already used everywhere
  else — never broader than the existing connected-profile visibility
  rule.

The participant-facing dashboard itself (`recipient-dashboard.tsx`) is
intentionally left without a per-organizer filter/selector in this task —
its existing flat merged list already reads correctly with multiple
organizers (each reminder shows its own title/time regardless of source),
and adding a full switcher there was judged unnecessary UI complexity for
the participant side specifically (participants are not expected to
manage multiple relationships the way organizers are).

## Live refresh behavior

No Supabase Realtime subscription exists anywhere in this codebase
(confirmed by Phase 1's audit) — introducing one for the first time in
this task would have been a materially riskier change than the chosen
alternative: a **bounded, self-limiting poll**.

- **`app/invite-recipient.tsx`**: polls every 8 seconds *only* while a
  draft invite code exists and hasn't been accepted yet
  (`draftConnectionId && joinedName === null`) — the interval doesn't
  exist at all once either condition becomes false. Paused while the app
  is backgrounded (`AppState.currentState !== 'active'` skips the tick).
- **`app/caregiver-dashboard.tsx`**: polls every 20 seconds *only* while
  `pendingInviteCount > 0` (covers both "waiting on my very first invite"
  and "have accepted participants plus a separate outstanding invite").
  Also gated on screen focus (a ref updated by its own `useFocusEffect`)
  and app-foreground state (`AppState`) — `useFocusEffect`'s blur only
  fires on navigating away, not on OS backgrounding, so `AppState` is
  tracked separately to make sure the interval genuinely stops doing work
  when backgrounded, not just when the user navigates elsewhere.
- Both intervals are cleaned up via their `useEffect` return function on
  every dependency change and on unmount — no leaked timers.
- **Connections/participant lists refresh promptly** the normal way too:
  every screen already reloads on `useFocusEffect` (screen focus) and pull-
  to-refresh, so returning to the dashboard or the Participants screen
  after an invite is accepted or a connection ends always shows the
  current state immediately, poll or not.

## Empty, loading, and error states

| Screen | State | Behavior |
|---|---|---|
| Organizer dashboard | No participants | Existing "no participant linked" connection card + invite CTA (unchanged) |
| Organizer dashboard | ≥1 accepted **and** a separate pending invite | New: compact banner ("N pending invitation(s) waiting") linking to Participants — previously completely invisible once ≥1 accepted connection existed |
| Organizer dashboard | Five-participant limit reached | Add-chip shows a lock icon; tapping still opens the (now server-count-accurate) upsell screen |
| Participants screen | Loading | Explicit spinner + text |
| Participants screen | Failed to load | Retry button, no raw error text |
| Participants screen | No participants at all | Explanation + "Invite your first participant" CTA |
| Participants screen | Has participants | Active section, Pending section (each with its own actions), lightweight overview, Add button (locked at 5) |
| Create-reminder | Connection ended during creation | Friendly alert + redirect to Participants, instead of a raw RLS error string |
| Participant (Settings) | No organizer connection | Existing `noOrganizerConnected` (unchanged) |
| Participant (Settings) | Multiple organizers | Fixed: `connectedToManyOrganizers`, each name available via the new End-connection picker |
| Participant (Settings) | Ending a connection | Explicit confirmation dialog naming the organizer, translated error handling |

All new/changed copy exists in both English and Spanish
(`lib/i18n/locales/{en,es}.ts`).

## Accessibility

- Every participant chip: `accessibilityRole="tab"`,
  `accessibilityState={{ selected }}`, a label combining the name and
  relationship term, and a hint on non-selected chips explaining what
  tapping does. Selected state is marked by a checkmark badge, never color
  alone.
- The chip row itself: `accessibilityRole="tablist"`.
- Every new button/row on `app/participants.tsx` and the End-connection
  flows: explicit `accessibilityRole="button"`, `accessibilityLabel`, and
  `accessibilityState={{ disabled, busy }}` while an action is in flight.
- Minimum 44pt touch targets on every new/changed tappable control
  (chips, action-row buttons, the Manage/Add links).
- Confirmation dialogs use the platform's native `Alert.alert`, which is
  inherently VoiceOver-accessible without extra work.
- Dynamic Type: all new text uses the existing themed `Text` styling with
  no fixed-height containers that would clip a scaled-up name or label.

## Residual risks

- **Full daily taken/missed/pending aggregation across all participants
  was deliberately deferred** (Phase 9 explicitly allows this). Accurately
  replicating each participant's own recipient-timezone-aware status
  computation (`docs/reminder-state-model.md`) for every participant at
  once would mean either duplicating `caregiver-dashboard.tsx`'s proven
  per-connection logic across N connections (risking subtle divergence
  bugs between the aggregate and the per-participant view) or querying
  through it N times per screen load (inefficient at 5 participants, worse
  at any future higher limit). The lightweight overview shown instead
  (`app/participants.tsx`) uses only counts that are always accurate with
  zero extra queries: participant count and total active reminders.
- **The invite-waiting poll intervals (8s/20s) are a deliberate choice
  over Realtime** — genuinely live (sub-second) updates were judged not
  worth introducing the first Realtime subscription in this codebase for.
  A caregiver could in principle wait up to ~20 seconds after an
  acceptance before the dashboard's background poll picks it up (though
  returning to the screen or pulling to refresh is always immediate).
- **Legacy/over-limit accounts** (if any exist from testing before this
  task) are left as-is — the limit only blocks new invites going forward,
  never removes existing connections.
- **The Participants screen's per-participant "recent completion summary"**
  called out as optional in the task spec was not implemented beyond the
  active-reminder count, for the same "avoid a second status-computation
  path" reasoning as the all-participants overview above.

## Weekend QA checklist

1. As an organizer, invite and accept 5 real/synthetic participants;
   confirm the 6th invite attempt is blocked with the friendly limit
   message, on a real device.
2. Switch rapidly between 3+ participants on a physical device; confirm
   no stale participant's name/data ever flashes under another's.
3. Generate an invite, background the app, accept it from a second
   device, foreground the first device, and confirm the dashboard/
   invite-recipient screen picks up the acceptance within the documented
   poll window (or immediately on manual refresh).
4. End a connection as the organizer; confirm the participant's device
   shows a calm "not connected" state after their next refresh, and that
   no further reminders arrive for them.
5. End a connection as the participant (Settings); confirm the organizer's
   Participants screen no longer lists them, and their other participants
   (if any) are unaffected.
6. Connect one participant to two different organizers; confirm both
   organizers' reminders appear correctly attributed on the participant's
   dashboard, and ending one organizer's connection doesn't affect the
   other.
7. VoiceOver pass over the participant switcher, the Participants screen,
   and both End-connection confirmation flows.
8. Confirm Settings correctly shows "Connected to N organizers" (not just
   one) for a participant with multiple accepted organizers.

## Rollback procedure

The new migration
(`20260727000000_participant_limit_and_connection_ending.sql`) only adds
new function versions (`create_invite_code`, `accept_invite_code`,
`end_connection`) — reverting it means restoring the prior
`create_invite_code`/`accept_invite_code` bodies from
`20260724001500_block_deleted_account_writes.sql` and dropping
`end_connection` (any connection already ended via it stays ended — that
column value is not itself part of this migration). Client changes revert
cleanly via git revert; the account-scoped AsyncStorage key change is
backward-compatible (an old global-key value is simply never read again,
not corrupted).
