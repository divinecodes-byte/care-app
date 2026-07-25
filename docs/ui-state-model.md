# Tavora UI-state model

Week 2 product-polish task #3: comprehensive loading, empty, error, retry,
and offline-state hardening. Companion to `docs/onboarding-model.md`,
`docs/participant-management-model.md`, and `docs/reminder-editing-model.md`
— this document covers everything about how every screen behaves while
data is loading, refreshing, empty, failing, offline, or stale.

## State taxonomy

Every data-driven screen is describable by `ScreenStatus`
(`lib/asyncStateCore.ts`, zero imports so it stays importable from
`scripts/ui-state-audit/run.ts`):

| Status | Meaning |
|---|---|
| `idle` | Nothing requested yet (e.g. before a modal opens) |
| `loading` | First load, no data yet — full-screen `ScreenLoadingState` |
| `refreshing` | Data already on screen, re-fetching in the background — existing data stays visible, only a discreet indicator |
| `ready` | Fetch succeeded, data is non-empty |
| `empty` | Fetch succeeded, genuinely zero items |
| `offline` | The request failed for a connectivity reason — existing data (if any) stays visible with an `OfflineBanner` |
| `recoverable_error` | The request failed for a server/unexpected reason where retrying might help — `ErrorState`/`SectionErrorState` with a Retry action |
| `not_found` | The specific requested object no longer exists or is no longer active — a calm, specific message, never retryable |
| `unauthorized` | The session expired or the user isn't allowed to view this — routes to sign-in |

Screens don't necessarily hold this exact union as one state variable —
most compose it from a handful of booleans/refs (`loading`, `refreshing`,
`loadError: ErrorCategory | null`, `hasLoadedOnceRef`) — but every screen's
render logic is expressible in these terms, and that's the vocabulary used
throughout this document and the audit script.

## Error classification

Every user-facing error goes through one of two classifiers, never a raw
Supabase/Postgres/Edge-Function string:

- **`classifyScreenError(rawMessage)`** (`lib/asyncStateCore.ts`) — general
  screen-level failures (fetches, RPCs not specific to auth). Returns an
  `ErrorCategory`: `network | session_expired | unauthorized |
  no_longer_active | already_completed | validation | rate_limited |
  unexpected`. Mapped to i18n copy via
  `ERROR_CATEGORY_TRANSLATION_KEYS` (`lib/errorClassification.ts`).
- **`classifyAuthError(error)`** (`lib/authErrors.ts`) — sign-up/sign-in/
  password-reset/session errors specifically. Returns an `AuthErrorKind`
  with its own translation map, `AUTH_ERROR_TRANSLATION_KEYS`.

Both check rate-limiting *before* the network pattern (a 429 message often
also matches generic network wording) — this exists specifically because
of this session's own repeated encounters with Supabase's auth rate limits
during automated testing, and now shows a stable "Too many attempts.
Please wait a few minutes and try again." instead of a generic or raw
error, on signup, sign-in, password reset, and invite-code acceptance.

`isRetryableCategory(category)` is `true` only for `network`,
`unexpected`, and `rate_limited` — `no_longer_active` and
`already_completed` are deliberately excluded from ever showing a Retry
button, since retrying can't un-delete a reminder or un-complete a
response.

## Shared components (`components/StateViews.tsx`)

`ScreenLoadingState`, `InlineLoadingState`, `EmptyState`, `ErrorState`,
`SectionErrorState`, `RetryButton`, `OfflineBanner`, and
`announceStateChange()`. All theme-aware (`useThemeColors()`), all with
`accessibilityRole`/`accessibilityLabel`, live regions on anything that can
appear without a screen transition (`SectionErrorState`:
`accessibilityLiveRegion="assertive"`; `OfflineBanner`:
`"polite"`), 44pt touch targets, EN/ES via the existing `t()` system, and
respect Reduce Motion (no custom animation added by any of them).

**`SectionErrorState` vs a full `ErrorState`/`EmptyState`:** the former is
a small inline banner with a Retry button, rendered *above* still-valid
content — used for partial failure (e.g. reminders loaded but analytics
failed). The latter replaces the whole screen — used only when there is
truly nothing else to show.

**`announceStateChange(message)`** wraps
`AccessibilityInfo.announceForAccessibility` for the one case a live
region can't cover: a transition *back to normal* after an error/offline
banner disappears (the banner had a live region while it was visible; once
it unmounts there's nothing left to announce its own resolution). Wired
into `recipient-dashboard.tsx`, `caregiver-dashboard.tsx`, and
`participants.tsx` — each captures whether the *previous* attempt had
failed (via a ref, since React state from the same render can't be read
synchronously) and announces `stateViews.backToNormal` only when a
subsequent load actually recovers.

## First-load vs. refresh

Every hardened screen (`recipient-dashboard.tsx`, `caregiver-dashboard.tsx`,
`participants.tsx`) distinguishes a true first load (`hasLoadedOnceRef`
false — no data yet, full-screen loading card) from every subsequent
re-fetch (focus refire, pull-to-refresh, `AppState` foreground, a
participant switch) via the same ref, set `true` once the first attempt
completes (success *or* failure — a failed first load still means "we've
tried," so a subsequent retry shows a compact error/retry state, not
another full-screen loading card indistinguishable from the first).

`caregiver-dashboard.tsx` has two such refs: `hasLoadedParticipantsOnceRef`
(gates the connection-card spinner) and `hasLoadedReminderDataOnceRef`
(gates the analytics-loading placeholder). The second one is deliberately
*reset to false* inside `selectParticipant()` — switching to a different
participant intentionally shows the full loading card again, since a
different person's data is about to replace what's on screen and that
should be obvious, not silently swapped in mid-view. A plain refetch of
the *same* participant never resets it.

## Partial failure

The dashboard's explicit example from this task: reminders load fine but
analytics/logs fail → show the reminders, show a `SectionErrorState`
("Analytics unavailable") with its own Retry, never replace or blank the
whole dashboard. Implemented via three independent error states in
`caregiver-dashboard.tsx` (`connectionsError`, `reminderDataError`,
`analyticsOnlyError`) — a reminders-fetch failure and a logs-fetch failure
are tracked and rendered separately, and neither one clears the other's
still-valid data.

## Offline behavior

**Deliberate decision: no `NetInfo`/`expo-network`/proactive listener.**
Every literal requirement in this task's offline section is satisfiable by
*reactive* classification — treating a failed request as offline based on
its error message (`classifyScreenError` → `'network'`) — without a new
native dependency or a prebuild/rebuild cost. If a future task needs
proactive detection (e.g. disabling a button before the user even taps it
while offline, rather than after a failed attempt), that's a deliberate,
separate addition, not an oversight here.

- A failed request classified as `network` shows an `OfflineBanner`
  instead of a `SectionErrorState`/full `ErrorState` — existing data stays
  on screen underneath it. Wired into `recipient-dashboard.tsx`,
  `caregiver-dashboard.tsx`, and `participants.tsx`.
- The banner is dismissible where a local `offlineDismissed` state exists
  (recipient/caregiver dashboards); dismissing only hides it for the
  current screen instance and it reappears on the very next failed
  request — it's reset to `false` at the start of every fresh load
  attempt, so a dismissal can never mask a still-genuinely-offline state
  indefinitely.
- Actions never falsely appear successful offline — every mutating action
  goes through the same server round-trip as online; a network failure
  there is classified and shown the same way as any other failed mutation
  (see Retry/idempotency below), never silently treated as success.
- Sign-out remains locally effective offline (`supabase.auth.signOut()`'s
  local session/token clearing happens regardless of whether the network
  call to invalidate server-side succeeds — pre-existing behavior, not
  changed by this task).
- **Not built, by explicit constraint:** a full offline-sync/write queue.
  An action attempted offline simply fails with the `network` category and
  a Retry, rather than being queued for later replay. This is a known,
  intentional limitation — see below.

## Retry & idempotency

Audited across all nine listed mutating actions
(`invite creation, invite acceptance, reminder creation/editing/response,
connection ending, preview preference changes, account deletion, password
reset`). Two real double-submission gaps were found and fixed this task:

- **Invite creation** (`app/invite-recipient.tsx`) — the very first
  "Generate" call (before a draft connection exists) was a plain INSERT
  with no synchronous re-entrancy guard; a rapid double-tap before
  `disabled={loading}` took effect on the next render could create two
  pending invites, each consuming a participant slot. Fixed with an
  `if (loading) return;` guard at the top of `createInviteCode()`, matching
  the pattern already used in `join-invite.tsx`.
- **Reminder creation** (`app/create-reminder.tsx`) — same class of gap
  (`supabase.from('reminders').insert(...)` has no server-side idempotency
  key); fixed the same way in `saveReminder()`.
- **Reminder response from the dashboard** (`app/recipient-dashboard.tsx`'s
  `saveReminderAction`) — the action buttons were swapped for a "saving"
  box while in flight, but that swap only takes effect on the next render;
  added a synchronous `if (savingReminderId === reminder.id) return;` guard
  (the full-screen alert screen, `reminder-alert.tsx`, already had this).

Everything else audited was already safe, mostly because the server side
is genuinely idempotent, not just client-debounced:

- **Invite acceptance**, **reminder editing**, **reminder response**
  (RPC), **connection ending**, and **preview-preference updates** all
  route through either an atomic conditional `UPDATE` or a `SECURITY
  DEFINER` function with row locks that explicitly tolerate a repeat call
  (`respond_to_reminder_occurrence` returns the existing row for a
  duplicate identical response; `end_connection` is a no-op if the
  connection is already `'ended'`). A retry after a lost network response
  is safe in every one of these cases — verified directly in
  `scripts/ui-state-audit/run.ts` (scenarios Q, R, S), not just by reading
  the SQL.
- **Account deletion** and **password reset** were already properly
  guarded client-side (`stage`/`canSubmit`) and idempotent server-side.

**Known, accepted limitation:** account deletion's retry flow
re-authenticates with `signInWithPassword` before invoking the delete
function. If a prior attempt actually succeeded server-side but the client
only saw a network error, a retry's re-auth legitimately fails (the
account no longer exists) and shows the same "wrong password" copy as an
actual wrong password. This is **not fixed**, deliberately: Supabase
returns identical wording for "wrong password" and "no such account" specifically
to prevent account enumeration, and distinguishing the two here would
require weakening that. The ambiguous copy is the correct trade-off.

## Not-found / stale-object states

| Scenario | Where | Message |
|---|---|---|
| Reminder deleted | `edit-reminder.tsx` | "Reminder not found or you don't have permission." (no Retry) |
| Reminder deactivated | `reminder-details.tsx`, `reminder-alert.tsx` | Historical/inactive notice, not an error |
| Connection ended (organizer side) | `caregiver-dashboard.tsx` | Falls back through selection priority; a route-param participant that's gone shows `organizerDashboard.participantNoLongerAvailableTitle` once (new this task) |
| Connection ended (participant side) | `recipient-dashboard.tsx` | Dedicated `connectionEndedTitle`/`connectionEndedText` empty state (new this task — previously fell through to the identical "never connected" screen) |
| Invite expired | `join-invite.tsx` | "This invite code has expired. Ask your organizer for a new one." |
| Invite already accepted | `join-invite.tsx` | Distinct "already used" copy, never collapsed with "expired" |
| Participant no longer available (creating a reminder) | `create-reminder.tsx` | RLS failure detected and shown as `connectionEndedTitle`/`connectionEndedMessage`, redirects to Participants |
| Notification tap → deleted reminder | `reminder-alert.tsx` | "Reminder not found." + cancels any leftover local notification |
| Notification tap → already answered | `reminder-alert.tsx` | Reads the existing terminal status and shows a "responded" box instead of action buttons; a stale in-flight response attempt is rejected server-side as `already_answered` |

No raw UUID, table/column name, or Postgres/RLS message is ever shown —
confirmed by both the retry/not-found audit and
`scripts/ui-state-audit/run.ts`'s pure classification tests.

## Empty states

**Organizer**, all in `caregiver-dashboard.tsx`/`participants.tsx`/
`invite-recipient.tsx`: no participants at all; pending-invite-only;
active participant with zero reminders; reminders exist but zero logged
responses yet (distinct copy from "zero reminders"); no analytics for the
selected period; five-participant limit reached (three separate surfaces:
the invite screen, the Participants screen's disabled Add button, and the
dashboard's participant-selector lock icon).

**Participant**, all in `recipient-dashboard.tsx`: no organizer connected
(never invited); connected but organizer has created zero reminders yet
(new this task — previously identical to "nothing due today"); reminders
exist but none due today; notifications disabled; connection ended (new
this task — previously identical to "never connected").

**Not built:** a participant-facing history/analytics screen. "No history
yet" was in this task's required list, but no such screen exists anywhere
in the app for participants (only the organizer's Week/Month breakdown) —
building one is a new feature, not a state-hardening fix, and is out of
scope per this task's own constraints (no full dashboard redesign). Noted
here as a known gap for a future task, not silently skipped.

## Loading & navigation races

Every screen that re-fetches on a changing selection uses either the
formalized `lib/useRequestGeneration.ts` hook (`start()`/`isCurrent()`) or
the older equivalent `loadGenerationRef` pattern it was extracted from.
Coverage as of this task: `caregiver-dashboard.tsx`,
`recipient-dashboard.tsx`, `participants.tsx`, `reminder-alert.tsx`,
`join-invite.tsx`, `components/settings-sheet.tsx`'s `fetchProfile`, and
`invite-recipient.tsx`'s three independent fetches (the latter two via a
lighter-weight cancellation ref, since neither re-fetches on a changing
selection the way the others do).

Fixed this task:

- **`reminder-alert.tsx`** — load and submit had no protection at all;
  added generation guards on the load path and an `isMountedRef` check
  after the response RPC so a background/navigate-away mid-submit doesn't
  set state on an unmounted screen (the server had already recorded the
  response either way).
- **`join-invite.tsx`** — added `if (loading) return;` (the button's
  `disabled` prop doesn't cover the `TextInput`'s `onSubmitEditing`), plus
  a generation guard on the load path, plus proper error classification
  (was a hardcoded `authErrors.unexpected` for every RPC failure — see
  Error normalization below).
- **`components/settings-sheet.tsx`** — the sheet is a persistent `Modal`,
  not unmounted on close, so the real race was close-then-quickly-reopen;
  added a generation guard so a stale `fetchProfile()` from the first open
  can't overwrite state from a newer one.
- **`invite-recipient.tsx`** — added a `cancelled` flag on the
  mount-only slots-used effect, and a ref-based check in
  `checkDraftAcceptance()` so a check for an already-superseded
  `draftConnectionId` (regenerating the code mid-check) can't commit state
  for the wrong connection.
- **`app/index.tsx`** — the initial session/profile check had no
  `.catch()`; an unhandled rejection there silently failed to auto-route a
  signed-in user to their dashboard. Now logs a warning and leaves the
  user on the welcome screen (Sign In is still right there) rather than
  failing invisibly.
- **`app/_layout.tsx`** — added a 1-second debounce between processed
  notification taps (distinct from the existing per-notification-id dedup,
  which only catches the *same* notification firing twice) so two
  different notifications tapped in rapid succession can't each push their
  own screen back-to-back.

**Known, accepted limitation:** `lib/authSession.tsx`'s `passwordRecovery`
flag (set on the `PASSWORD_RECOVERY` auth event) is read nowhere outside
that file. It's currently harmless only because `/reset-password` is
listed in `_layout.tsx`'s `PUBLIC_ROUTES`, so the global auth-redirect
effect never touches that route regardless of status — but the flag's own
documented purpose ("consumers must not auto-route this into a dashboard")
isn't actually enforced by any consumer. Left as-is this task (wiring a
real consumer is a session-architecture change, not a state-hardening
one) — flagged here for a future pass.

## Refresh behavior

Pull-to-refresh (`RefreshControl`), focus refetch (`useFocusEffect`), and
bounded `AppState`-gated polling (participant-invite acceptance polling in
`invite-recipient.tsx`; the pending-invite-count poll in
`caregiver-dashboard.tsx`) are the only three refresh triggers in the app —
confirmed via a full `setInterval`/`setTimeout` grep, both existing polls
already clean up correctly (`clearInterval` in their effect's cleanup) and
already gate on `AppState.currentState === 'active'` so they don't run
while backgrounded. No duplicate-fetch bursts were found from overlapping
triggers (each fetch path is guarded by its own generation ref regardless
of which trigger started it). A failed refresh preserves whatever was
already on screen everywhere (see First-load vs. refresh above); the
selected participant is never reset by a refresh, only by an explicit
switch.

## Accessibility

Every state component in `StateViews.tsx` has `accessibilityRole`, a
descriptive `accessibilityLabel`, and a live region on transient content.
Retry buttons have explicit labels (never a bare icon). The offline
banner's dismiss control is a real button with its own label
(`stateViews.dismiss`), not a swipe-only gesture. `announceStateChange` (see
above) covers the one transition a live region can't: recovery *after* an
error/offline banner disappears. Polling (invite-acceptance, pending-invite
count) never triggers a screen-reader announcement itself — only an actual
state change (e.g. the invite finally being accepted) does, since polling
only updates state when something actually changed.

## Weekend QA checklist

Manual spot-checks a physical-device tester should still do (this task's
automated coverage is server/data-model-level; visual-only behavior has no
server-observable side effect to assert against in a Node script):

- [ ] First app open after install shows the loading card, not a flash of
      an empty state, on both dashboards.
- [ ] Airplane-mode a device with existing reminders visible, pull to
      refresh — data stays on screen, `OfflineBanner` appears, dismiss it,
      confirm it reappears on the next failed pull.
- [ ] Turn network back on, pull to refresh again — banner disappears,
      VoiceOver announces "Back online" (enable VoiceOver first).
- [ ] Switch participants rapidly on the organizer dashboard — no data
      flashes under the wrong participant's name.
- [ ] From two devices, end a connection from the participant side while
      the organizer is mid-way through creating a reminder for them — the
      organizer sees the "connection ended" message, not a raw error.
- [ ] Tap a real push notification for a reminder deleted moments earlier
      from the other device — "Reminder not found," no crash.
- [ ] Double-tap Generate on Invite Participant as fast as possible —
      exactly one invite code is produced.
- [ ] Trigger Supabase's real rate limit (repeated failed sign-ins) — see
      "Too many attempts" copy, not a raw 429 or generic error.

## Rollback

Every change in this task is additive/defensive (new components, new
classification, new guards) — no reminder-lifecycle semantics, analytics
definitions, or RLS policies were changed. Reverting is a plain `git
revert` of this task's commits; there is no migration to roll back (no
schema changes were required for this task).
