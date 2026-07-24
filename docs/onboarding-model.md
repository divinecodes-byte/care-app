# Tavora onboarding model

Week 2 product-polish task #1: onboarding, role clarity, use-case
positioning, and first-success activation. Companion to
`docs/reminder-state-model.md` (delivery/response semantics) and
`docs/reminder-editing-model.md` (schedule editing) — this document covers
everything from first launch through the first completed
organizer→participant→response loop.

## Use-case values

`profiles.use_case text` (nullable, `CHECK` constrained), added by
`supabase/migrations/20260726000000_onboarding_use_case_and_role_safety.sql`:

| Stored value | Question option |
|---|---|
| `care` | Care for someone |
| `family` | Manage family routines |
| `coaching` | Coach or train someone |
| `team` | Manage a team |
| `personal` | Personal accountability |
| `other` | Something else |

**Display-only, never authorization.** `use_case` selects onboarding copy,
example reminder titles, and context-aware role labels — nothing else. No
RLS policy, RPC, or authorization check anywhere reads this column. It is
never used to route data into a separate backend system per use case (there
is exactly one `reminders`/`connections`/`reminder_logs` schema, unchanged
by this task).

**Nullable, no default.** An older account, or a user who never completes
the use-case question, has `use_case = null`. Every place that reads it
(`lib/onboarding.ts`'s `getRoleLabelKeys`, `getExampleReminderTitleKey`)
falls back to the neutral `other`-equivalent copy — nothing ever crashes or
shows a blank string on a null value, and nothing server-side ever
auto-writes a value to fill the gap.

**Editable anytime.** Settings → "How you use Tavora" lets a user change
this at will (`components/settings-sheet.tsx`), with an explicit note that
it only affects examples, never account behavior.

## Role mapping

The backend authorization model is unchanged from Week 1 — `profiles.role`
is still exactly `'caregiver' | 'recipient' | null`, and every RLS policy
and RPC (`create_invite_code`, `accept_invite_code`,
`update_reminder_schedule`, `respond_to_reminder_occurrence`, etc.) keys off
those two literal values, never off `use_case` or a display label.

**Context-aware display labels** (`lib/onboarding.ts`'s
`getRoleLabelKeys`), shown on `app/choose-role.tsx` based on the use case
picked one screen earlier:

| use_case | Organizer label | Participant label |
|---|---|---|
| `care` | Caregiver | Loved One |
| `coaching` | Coach | Athlete |
| `team` | Manager | Team Member |
| `family` / `personal` / `other` / unset | Organizer | Participant |

These are `t()` string lookups only — swapping them never touches what gets
written to `profiles.role`. `app/choose-role.tsx` still writes literally
`'caregiver'` or `'recipient'` regardless of which label was shown.

### Role-selection safety

- **Idempotent**: resubmitting the same already-set role is always a
  silent no-op success (verified: scenario G, and H's third assertion).
- **Anti-forgery**: `guard_profile_role_change()` (`BEFORE UPDATE` trigger
  on `profiles`) blocks changing an *already-set, different* role once any
  `connections` row references that profile as either `caregiver_id` or
  `recipient_id` — raises the fixed message `role_locked`, which
  `choose-role.tsx` classifies into a translated alert
  (`chooseRole.roleLockedTitle`/`Message`) rather than a raw Postgres
  error. Verified directly: scenario H (both directions — caregiver and
  recipient side each independently blocked once connected).
- The very first role write (`role` was `null`) is always allowed
  regardless of connection state — this only guards *reassignment* of an
  established role, not initial selection.
- This is a data-integrity trigger, not an RLS change — the existing
  `auth.uid() = id` own-row UPDATE policy on `profiles` is completely
  unchanged; the trigger fires on top of it.

## Route sequence

### New organizer (care use case)

```
index → select-language → index → signup → choose-use-case → choose-role
  → caregiver-dashboard (shows an invite-first empty state)
  → invite-recipient → (participant accepts, in the background)
  → caregiver-dashboard (connection card now shows the participant's name)
  → create-reminder → (in-page "You're all set" confirmation)
  → caregiver-dashboard / reminder-details
```

### New participant (care use case)

```
index → select-language → index → signup → choose-use-case → choose-role
  → join-invite → (enters code) → "You're connected!" confirmation
  → notification-permission → recipient-dashboard
  → (reminder arrives) → reminder-alert → response recorded
  → (first time only) "You're all set" message → recipient-dashboard
```

Both sequences add exactly two screens to the Week 1 flow
(`choose-use-case`, and `notification-permission` for participants only) —
no new navigation framework, no multi-step wizard component. Progress is
shown by what's naturally already on screen (the empty-state copy on each
dashboard, the connection card's own state), not a separate progress bar.

## Onboarding state / resume rules

There is **no new "onboarding step" column**. Onboarding progress is
always freshly *derived* from existing signals — `profiles.role`,
`profiles.use_case`, and whether a `connections` row exists — via a single
function, `lib/onboarding.ts`'s `resolveProfileRoute()`, called identically
by both `app/index.tsx` (cold launch) and `app/signin.tsx` (explicit
sign-in), so the two can never disagree about where a user should land.

```
resolveProfileRoute(profile, recipientHasConnection):
  role is null       → use_case set ? '/choose-role' : '/choose-use-case'
  role = 'caregiver' → '/caregiver-dashboard'   (always, regardless of use_case)
  role = 'recipient' → connected ? '/recipient-dashboard' : '/join-invite'
```

**Why a derived function instead of a stored step**: it's inherently safe
against repeated/duplicate steps (re-visiting `choose-use-case` and
resubmitting the same value is a no-op; re-running `create_invite_code`
just regenerates the same pending row; `accept_invite_code` is already
idempotent server-side) and can never drift out of sync with the real data
it's supposed to reflect.

**Two real gaps this closes** (found in this task's Phase 1 audit, not
present before):

1. A user signed in with `role = null` (killed mid-`choose-role`) used to
   land on the plain marketing Welcome screen on relaunch — silently
   stranded unless they knew to tap "I already have an account." Now
   `index.tsx` runs the same `resolveProfileRoute` logic `signin.tsx`
   already used, so cold launch resumes correctly too.
2. A recipient with `role = 'recipient'` but **no accepted connection**
   (backed out of, or never completed, `join-invite`) used to be routed
   straight to `recipient-dashboard`, which had no way back into
   `join-invite` anywhere in the app — a genuine dead end. Now:
   `resolveProfileRoute` sends them to `/join-invite` until a connection
   actually exists, and `recipient-dashboard.tsx`'s own empty state (see
   below) also offers a direct way back in, so even a stale in-memory
   dashboard session isn't stranded.

**Never blocks an already-onboarded user.** `resolveProfileRoute` never
routes a user with `role` already set back through `choose-use-case` or
`choose-role`, regardless of `use_case` — an existing/legacy account with
`use_case = null` always lands straight on its dashboard (verified:
scenario F).

**Repeated taps / duplicate navigation events**: every mutating action in
the new/changed screens is either naturally idempotent (role/use_case
UPDATEs) or already guarded by an in-flight loading flag that disables the
control while a request is outstanding (`choose-use-case.tsx`,
`choose-role.tsx`, `join-invite.tsx`, `invite-recipient.tsx`) — the same
pattern already established for every Week 1 mutating screen.

## Completion definition

There is no explicit "onboarding complete" boolean column. Completion is
implicit in reaching a stable state under `resolveProfileRoute`: an
organizer is "done with setup" the moment they have a role (a dashboard is
always reachable, connected or not); a participant is "fully onboarded"
once they have an accepted connection. The **first full activation loop**
(sign up → connect → create/receive first reminder → respond → organizer
sees it) is tracked only as a funnel signal via `onboarding_events`
(`onboarding_completed`, logged once, the first time a recipient records
any response — see below), never as a gate on using the app.

## Connection flow

**Organizer side** (`app/invite-recipient.tsx`): a "What this code does"
explainer now precedes the code card; the code card shows an explicit
expiration date (`create_invite_code`'s existing `expires_at`, previously
fetched but never displayed) and a live waiting/joined badge — the
participant's name only appears in that badge *after* the connection's
`status` is independently confirmed `'accepted'` via `useFocusEffect`
(re-checked every time the caregiver returns to this screen), never
guessed client-side. "Done" remains reachable even with no code ever
generated (unchanged from Week 1 — an organizer can look around the
dashboard before inviting anyone).

**Participant side** (`app/join-invite.tsx`): unchanged validation
(`accept_invite_code`'s `not_found | already_accepted | expired | self`
vocabulary, all still translated — the one remaining raw-error-string
alert path found in the Phase 1 audit is now also translated). On success,
the caregiver's name is looked up *only after* the RPC already returned
`'accepted'` (RLS's "Users can view connected profiles" policy only grants
that read once truly connected, so this can never leak who a code belonged
to before it was used) and shown on a dedicated "You're connected!"
confirmation screen before continuing — closing the audit's "recipient
lands on a possibly-empty dashboard with zero confirmation" finding. A
`joinInvite.needCodeHint` line was added under the trust note for a
recipient who doesn't have a code yet, and — the actual fix for the dead
end above — `recipient-dashboard.tsx`'s "not connected" empty state now
links directly back to `/join-invite`, which previously had **no** reachable
entry point anywhere except the one-time post-role-selection redirect.

## Notification permission flow

`app/notification-permission.tsx` (new) is shown exactly once, between a
recipient's connection confirmation and their dashboard — **before** the
native OS prompt ever fires, closing the audit's "OS prompt fires with zero
in-app priming, and can fire from two call sites in the same load" finding.

- "Continue" calls the existing `requestNotificationPermissions()` (never a
  new permission code path) and always proceeds to the dashboard
  regardless of the OS result — a denial is never treated as an error.
- "Not now" skips straight to the dashboard without ever calling the OS
  API — a genuinely deferred decision, not a hidden request.
- Mentions Time Sensitive alerts without overpromising:
  *"Time Sensitive alerts may appear during supported Focus modes."*
  (matches the existing, more detailed note already on
  `reminder-details.tsx`; this is the short first-run version).
- **Never re-shown / never nags**: this screen is only reachable once, from
  `join-invite.tsx`'s own success state — it isn't part of any screen a
  user could navigate back into, and existing/already-onboarded recipients
  never pass through it again on subsequent sign-ins.
- The dashboard's existing calm persistent banner (`notifDeniedText`) now
  also has a working **Open Settings** button (`Linking.openSettings()`) —
  previously text-only.
- Organizer onboarding does **not** get a blocking version of this screen —
  per the task's own softer requirement for organizers, the existing
  silent `registerPushToken()` call on first dashboard load is unchanged.
- Notification preview preferences (`notification_preview_mode`) are
  completely untouched by this task.

## First-reminder experience

For a connected organizer with zero reminders, the "Today" card's hint
text is now backed by a real, strong primary button — **"Create your first
reminder"** — instead of a static, non-interactive line (Phase 1 audit
finding: the only actual action was the header's generic "+" button, not
obviously connected to the empty-state copy next to it).

`create-reminder.tsx`'s title field now has a use-case-aware example
placeholder (`onboardingExamples.*` — "e.g. Morning medication" for
`care`, "e.g. Finish today's workout" for `coaching`, etc.) — **a
placeholder only**, never a pre-filled value, and never auto-created
without the organizer's own save action. A "{{name}} will receive this
reminder" line sits under the participant picker.

After saving, the form is replaced (not just an `Alert`) by an in-page
confirmation showing the title, participant, and a computed "next
occurrence" label (device-local display only — computed the same
best-effort way the rest of this form already reasons about days; it never
touches the server-authoritative delivery timing documented in
`docs/reminder-state-model.md`/`docs/reminder-editing-model.md`), with
**View reminder** (→ `reminder-details`) and **Back to dashboard** actions.

## First-response experience

`reminder-alert.tsx`'s three action buttons (Done / Remind Me Later / Skip)
now carry `accessibilityHint`s explaining each action in plain language,
without changing their underlying `taken | snoozed | skipped` statuses or
any lifecycle semantics from `docs/reminder-state-model.md`.

After a successful response, the screen shows a brief **recorded**
confirmation ("Got it — your organizer can now see this update") before
returning to the dashboard, instead of navigating away instantly. If — and
only if — this is the recipient's genuinely first-ever response (zero
prior `reminder_logs` rows for their `recipient_id`, checked immediately
before the response is recorded), a one-time, deliberately low-key line is
also shown: *"You're all set. Tavora will keep your reminders and progress
in one place."* Never shown again after that first time, and phrased to
avoid celebratory language that would read oddly for a medical routine.

## Empty-state rules

Every empty state added or fixed by this task has exactly one primary
action and no dead end:

| Screen | State | Action |
|---|---|---|
| Organizer dashboard | No reminders, connected | **Create your first reminder** button (was text-only) |
| Recipient dashboard | Not connected (new/critical fix) | **Enter invite code** → `/join-invite` |
| Recipient dashboard | Connected, nothing due | "All clear for today" (unchanged, correctly scoped now — see below) |
| Recipient dashboard | Notifications disabled | Persistent banner + **Open Settings** (was text-only) |

The recipient dashboard previously showed the *identical* "All clear"
empty state to a never-connected recipient and a fully-connected one with
nothing due — the two are now distinguished by a live `connections` check
(`hasConnection`, queried alongside the reminders load), closing that
audit finding without touching the reminders query itself.

## Accessibility requirements applied

Every new/changed onboarding control (use-case cards, role cards,
notification-permission buttons, invite/join buttons and inputs,
first-reminder confirmation actions, first-response buttons, Settings
use-case rows) carries:

- `accessibilityRole="button"` (or `"radio"` for the Settings use-case
  rows, reusing the existing `SelectRow` component) and an explicit
  `accessibilityLabel`.
- An `accessibilityHint` wherever the visible label alone doesn't fully
  convey the action (role-card descriptions, response-button explanations,
  the notification-permission screen).
- `accessibilityState={{ selected, disabled, busy }}` on selectable/loading
  controls, so a selected card or an in-flight save is never communicated
  by color/opacity alone.
- A minimum 44pt touch target (`minHeight: 44` / existing `hitSlop`
  patterns) on every new tappable control.
- All new copy runs through the existing `t()` system (Dynamic
  Type/contrast/theme handling is already centralized there and in
  `useThemeColors()` — untouched by this task).
- `join-invite.tsx`'s code input and submit button remain reachable above
  the keyboard (unchanged `KeyboardAvoidingView` + `keyboardShouldPersistTaps="handled"`,
  already correct from Week 1).

## Residual risks

- The "next occurrence" label on the first-reminder confirmation is a
  device-local display computation, not the recipient-timezone-authoritative
  value — for an organizer and recipient in very different timezones, this
  label could show a different day/time than what the recipient actually
  receives (the reminder itself still fires correctly; only this one
  confirmation caption could look slightly off). Not a new class of risk —
  it's the same device-vs-recipient-timezone display risk already
  documented in `docs/reminder-state-model.md`, now also present on this
  one additional caption.
- `use_case` has no historical audit trail — changing it in Settings
  overwrites the prior value with no log. Acceptable since it's
  purely a display preference, not user-generated content or a security
  boundary.
- The organizer's "waiting for participant" badge on `invite-recipient.tsx`
  is re-checked only on screen focus, not via a live subscription — an
  organizer who stays on that exact screen without backgrounding/returning
  won't see the badge flip to "joined" until they navigate away and back
  (or reach the dashboard, whose own connection card already polls on its
  own focus cycle).
- `onboarding_events` has no automated retention job yet (see below) —
  documented as a manual/future step, not implemented in this task per its
  own "if this would materially complicate the task, document the
  recommended events" allowance being read narrowly (the table itself was
  simple enough to implement; the cleanup cron was not required and is
  left as a documented follow-up).

### onboarding_events retention

No cron job was created in this task. Recommended procedure for a future
task: a `service_role`-only scheduled `delete from public.onboarding_events
where created_at < now() - interval '180 days'`, mirroring the existing
`cleanup-pg-net-responses`/`cleanup-cron-job-run-details` pattern already
running in this project (see `scripts/ops-health/run.ts`).

## Weekend QA checklist

1. Fresh install → language picker → Welcome → Get Started → signup →
   use-case card → role card → confirm the correct dashboard.
2. Kill the app immediately after choosing a role but before connecting;
   relaunch; confirm it resumes at the correct step (join-invite for a
   recipient, straight to dashboard for an organizer) rather than the
   Welcome screen.
3. On a real device, verify the notification-permission education screen
   appears before the native iOS prompt, and that denying it still lands
   cleanly on the dashboard with the calm banner + working Open Settings.
4. Generate a real invite code, accept it on a second physical device,
   confirm the organizer's badge and the participant's "You're connected!"
   screen both show the correct name.
5. Create a first reminder from a device in one timezone with the
   participant's device in another; confirm the actual push arrives at the
   recipient-correct time even if the confirmation caption's "next
   occurrence" label looks device-local.
6. Respond to a first reminder on the participant device; confirm the
   one-time "You're all set" message appears exactly once, and never again
   on a second response.
7. In Settings, change "How you use Tavora" and confirm example copy
   elsewhere (e.g. a fresh create-reminder placeholder) updates
   accordingly, with no effect on role or any existing reminder.
8. VoiceOver pass over choose-use-case, choose-role, notification-permission,
   and the reminder-alert action buttons.

## Rollback procedure

Revert the client changes via git revert (all additive UI/copy, no removed
capability). For the database: `profiles.use_case` and
`guard_profile_role_change_trigger` can be dropped without affecting any
other table; `onboarding_events` can be dropped entirely (it's write-mostly
telemetry, not user-facing data) — none of these are referenced by any
other migration or RPC, so no cascading changes are needed.
