# Tavora auth/session model

How Tavora establishes, maintains, and ends a session; what's cleared on
logout versus preserved across accounts on the same device; and what to do
when something in this area breaks. Companion to `docs/security-model.md`
(RLS/RPC trust boundaries) — this document is about session lifecycle, not
row-level authorization, though the two meet at a few points noted below.

## Auth-state lifecycle

`lib/authSession.tsx` is the one place in the app that subscribes to
Supabase's `onAuthStateChange`. Every other screen that needs to know "am I
signed in, and as whom" reads from `useAuthSession()` rather than
independently polling `supabase.auth.getUser()`/`getSession()` — this is
what prevents duplicate, potentially-inconsistent listeners across screens.
(Individual screens still call `auth.getUser()` before their own data
fetches, as defense-in-depth alongside RLS — that's unrelated to and
doesn't conflict with the central listener; it's just each screen
confirming it still has a session immediately before trusting a query
result.)

States (`AuthStatus`):

| Status | Meaning | UI implication |
|---|---|---|
| `initializing` | Session restoration + first profile fetch in flight | Never render a dashboard; the root layout defers all route enforcement until this resolves |
| `authenticated` | Valid session, active (`account_status = 'active'`) profile loaded | Normal app use |
| `unauthenticated` | No session — fresh install, explicit sign-out, or an unrecoverable auth error | Route to `/signin` |
| `profile_missing` | Valid session, no `profiles` row | Route to `/choose-role` (the recovery path) |
| `account_deleted` | Valid session, but `profiles.account_status = 'deleted'` | Show the neutral "This Tavora account is no longer active." message; a background logout starts immediately |
| `recoverable_error` | Profile fetch failed for a reason classified as transient (network) | Existing session is *not* torn down — see "Offline limitations" below |

`profile_missing` is expected to be rare going forward: a database trigger
(`handle_new_user`, added in the Week 1 task #6 migration) creates the
`profiles` row in the same transaction as the `auth.users` insert, so a new
signup can no longer produce an account with no profile at all. The status
still exists for defense-in-depth and to describe the one-time backfill
performed for a pre-trigger orphaned account found live at audit time.

The controller re-runs the profile check on `SIGNED_IN`, `INITIAL_SESSION`,
`TOKEN_REFRESHED`, and `USER_UPDATED` — not just once at login. Since a
token refresh happens automatically roughly hourly while the app is in use,
this is also what catches an account being tombstoned *during* a long-lived
session, not only at the next explicit sign-in.

## Protected-route behavior

`app/_layout.tsx` enforces route access narrowly and on purpose: it only
ever navigates a user *away* from a non-public route when status is known
to be invalid (`unauthenticated`, `account_deleted`) or roleless
(`profile_missing`). It never tries to route a signed-in user *forward* —
that stays each entry screen's own job (`index.tsx` on cold start,
`signin.tsx`/`signup.tsx` after an explicit action), so there is only ever
one place deciding "kick this user out," and no second, competing decision
about "where should a logged-in user land."

Public routes, never force-navigated away from: `/`, `/signin`, `/signup`,
`/select-language`, `/forgot-password`, `/reset-password`.

**Notification deep links** are queued, not dropped, if they arrive while
`status === 'initializing'` (e.g. a cold launch straight from a killed
state, tapped from a notification) — replayed once status resolves. Once
resolved, a tap is dropped entirely (never routed) if status is
`unauthenticated`, `account_deleted`, or `profile_missing` — there is no
authorized, active account on the device to show anything to. This is
belt-and-suspenders: even if a deep link *were* routed anyway, the
destination screen (`reminder-alert.tsx`) always re-fetches its own data
from Supabase before rendering, under RLS scoped to whichever account is
actually signed in — a `reminderId` route param is never itself trusted as
authorization. Both the client-side queuing/dropping and the RLS backstop
were verified: the RLS half directly (scenarios O/P in
`scripts/auth-audit/run.ts`), the client-side half by code review (a Node
test script has no React Native runtime to exercise `app/_layout.tsx`'s
actual navigation calls in).

**Deleted/deletion-pending accounts and writes**: client-side dashboard
checks are one layer (both dashboards now check `account_status` on every
load, before registering a push token or syncing anything), but the
authoritative layer is the database: `create_invite_code()`,
`accept_invite_code()`, and the `reminders` INSERT/UPDATE RLS policies all
now require `profiles.account_status = 'active'` for the calling user, not
just `role`. This closed a real gap — `role` is left untouched by account
deletion (it isn't private data), so a tombstoned account whose session
somehow survived deletion could otherwise still have created an invite
code.

## Account-scoped versus device-scoped storage

`lib/accountCleanup.ts` is the single source of truth for which local
AsyncStorage keys belong to an *account* (cleared on logout/deletion) versus
which belong to the *device* (survive across accounts):

- Account-scoped (cleared): the caregiver's selected-participant/connection
  id, the legacy local-notification-cleanup migration flag.
- Device-scoped (preserved): appearance/theme mode, language mode. These
  are choices about this device, not this account — clearing them on every
  sign-out would re-run the first-launch language gate for someone who
  simply signed out and back in, or switched accounts on a shared device.

Any new local storage key added in the future should be added to exactly
one category in `lib/accountCleanup.ts`'s `ACCOUNT_SCOPED_KEYS` list (if
account-specific) or left alone (if device-specific) — there's no third
option and no separate list to keep in sync.

## Logout sequence

`lib/accountCleanup.ts`'s `logout()` is the one sequence used both by a
normal sign-out (`components/settings-sheet.tsx`) and by account deletion
(`app/delete-account.tsx`, via `performLocalAccountCleanup()`, which is
just `logout()` under a name that matches its call site's intent). Order is
deliberate:

1. **Deactivate this device's push token(s)** for the current user, via the
   `deactivate_own_push_tokens` RPC — while a valid session still exists.
   This must run before step 4; `push_tokens` RLS requires
   `user_id = auth.uid()`, so there is no authorized way to do this once the
   session is gone.
2. **Cancel locally-scheduled notifications** (the legacy path only —
   server-authoritative recipients have nothing scheduled locally to
   cancel).
3. **Clear account-scoped local state** (see above).
4. **Sign out of Supabase** — last, once every step needing a live session
   has already run.

Every step is independently best-effort: a failure at step 1 (offline
device) does not stop steps 2–4, so a network failure during logout can
never trap a user in the account they're trying to leave. See "Push-token
lifecycle" below for how a failed step 1 gets reconciled later.

## Push-token lifecycle

**The core fix in this task**: `push_tokens.expo_push_token` is `UNIQUE`
(one row per physical device), and its RLS UPDATE policy requires
`user_id = auth.uid()` against the row's *current* owner. When a second
Tavora account signs into a device previously used by a different account,
a plain client-side `INSERT ... ON CONFLICT (expo_push_token) DO UPDATE`
must update a row it doesn't yet own — RLS correctly rejects that, which
meant the second account's push registration failed **every single time**
on that device, permanently, with no path to recovery. This was confirmed
live before the fix (not just reasoned about).

Fixed with a `SECURITY DEFINER` RPC, `register_push_token(token, platform)`,
that resolves the owner from `auth.uid()` (the caller's own JWT, never a
client-supplied id — a client cannot register a token as anyone but
themselves) and can therefore reassign a conflicting row regardless of who
currently owns it. `lib/notifications.ts`'s `registerPushToken()` calls
this RPC instead of a raw upsert.

Lifecycle summary:

- **Register** (dashboard mount, idempotent): `register_push_token` upserts
  this device's token under the caller, and deactivates any *other* token
  previously active for that same account (Tavora's push model is one
  active device per account at a time — this was already true before this
  task, just reconfirmed here).
- **Logout**: `deactivate_own_push_tokens` deactivates every active token
  for the outgoing account, before the session ends.
- **Account switch**: logging out of A deactivates A's token(s); signing
  into B and registering reassigns the *same device row* to B via the
  `register_push_token` RPC's `ON CONFLICT` reassignment — no failed
  registration loop.
- **Account deletion**: `delete_current_user_data()` hard-deletes every
  `push_tokens` row for the account server-side — `logout()`'s step 1
  becomes a harmless no-op by the time it runs (nothing left to
  deactivate).
- **Failed cleanup reconciliation**: if step 1 of `logout()` fails (device
  offline at the moment of sign-out), the stale token is not immediately
  fixed — but the *next* successful `register_push_token` call from any
  account on that device (including the same account signing back in)
  reassigns/refreshes it regardless, since the RPC always sets the caller
  as the current owner. The bounded residual risk is a device that's
  offline at logout and never has anyone register a token on it again;
  such a token eventually self-heals anyway once it goes stale enough for
  Expo to report `DeviceNotRegistered`, at which point the existing
  delivery pipeline already deactivates it (see
  `docs/operations-runbook.md`).

## Deleted-account handling

`profiles.account_status = 'deleted'` (with `deleted_at` set) is treated as
authoritative everywhere a session could otherwise be used, independent of
whether the underlying Auth user record actually finished being deleted —
this matters because `delete-account`'s own design already anticipates
`auth.admin.deleteUser` failing after the database cleanup succeeds (see
`supabase/functions/delete-account/index.ts`'s comments), leaving a
tombstoned profile with a technically-still-valid Auth session for a
window. Checked at:

- `lib/authSession.tsx` — the central controller, on every profile
  (re-)fetch; automatically starts `logout()` in the background.
- `signin.tsx` — synchronously, on the explicit sign-in action itself
  (doesn't wait for the central controller's next tick).
- Both dashboards — on every load, before any timezone sync, push
  registration, or notification sync runs.
- `create_invite_code()` / `accept_invite_code()` / the `reminders`
  INSERT/UPDATE RLS policies — server-side, so this holds regardless of
  which (or whether any) client-side check ran first.

The user-visible message is always the neutral, translated
`authErrors.accountDeleted` string ("This Tavora account is no longer
active.") — never a raw database error, never any detail about *why* or
*what* was deleted.

## Account-switching guarantees

- **Server-side (directly tested, `scripts/auth-audit/run.ts` I/J/K/L)**:
  RLS scopes every query to `auth.uid()`, so account B's session can never
  successfully read account A's rows regardless of any local cache state.
  Push-token ownership transfers cleanly between accounts on the same
  device (the core fix above). Signing back into a previous account
  reloads its profile fresh from the server.
- **Client-side (code-reviewed, not runtime-tested — no RN environment in
  this task's verification)**: `logout()` clears every account-scoped
  AsyncStorage key before a new sign-in can occur, so there's no local
  cache for a stale value to survive in even transiently.

## Password-reset / email-confirmation findings

- **Email confirmation is currently disabled** on this Supabase project —
  verified directly (a synthetic signup returns `email_confirmed_at` set
  immediately and a session immediately, with no confirmation email sent).
  This is documented, not changed, per this task's explicit instruction.
  Support/App-Store implication: an account can be created and used with a
  typo'd or someone-else's email address with no verification step: not
  itself an authorization risk (Tavora's authorization model doesn't
  depend on verified email), but relevant if a future feature ever sends
  account-recovery or connection-invite content by email, and relevant to
  App Review's expectations around account creation flows.
- **Password reset did not exist before this task.** Implemented as the
  smallest production-ready flow using Supabase's built-in email recovery
  (no custom email infrastructure):
  `app/forgot-password.tsx` calls `resetPasswordForEmail`, always showing
  the same neutral confirmation regardless of whether the email is
  registered (avoids account enumeration). `app/reset-password.tsx` is the
  `tavora://reset-password` deep-link landing screen — it reads the raw
  incoming URL itself (via `expo-linking`, since `detectSessionInUrl` is
  `false` on this native client and expo-router's own route params don't
  reliably carry a URL's `#fragment`), handling both the implicit-flow
  token shape (`#access_token=...&refresh_token=...`) and the PKCE shape
  (`?code=...`) defensively, since this project's exact GoTrue redirect
  behavior wasn't independently confirmable without receiving a real
  email. On a successful password update, the recovery session is
  explicitly signed out and the user is returned to `/signin` — a recovery
  session is treated as single-purpose (set a new password), never as a
  general-purpose signed-in session that continues into the dashboard.

## Offline limitations

This task does not implement an offline-first data layer (explicitly out
of scope). What it does guarantee:

- A network failure while fetching the profile after a session is
  restored resolves to `recoverable_error`, **not** `unauthenticated` — a
  valid session is never torn down just because one request failed to
  reach the server. Only an error classified as an actual invalid/expired
  session (`classifyAuthError` → `expired_session`) triggers a sign-out.
- `classifyAuthError` (`lib/authErrors.ts`) is the single place this
  distinction is made, from the error's message content — reused by the
  central controller, `signin.tsx`, `signup.tsx`, and
  `reset-password.tsx`, so "was this actually an auth failure or just the
  network" is answered consistently everywhere instead of ad hoc per
  screen.
- `logout()`'s steps are independently best-effort specifically so that
  "sign out" always works locally even when offline — see "Logout
  sequence" above.
- Residual limitation: a `recoverable_error` state has no dedicated retry
  UI in this task (no spinner-with-"Retry"-button screen) — screens that
  already do their own data fetch (dashboards) have their own existing
  error handling for that fetch failing, which is unaffected by this task.
  A future task could add a shared retry affordance keyed off this status
  if it turns out to matter in practice.

## Known residual risks

- `profiles.role` is left unset (`null`) by account tombstoning
  deliberately (it isn't private data) — this was audited and confirmed to
  have no RLS/authorization dependency anywhere, but it does mean `role`
  alone is never sufficient to distinguish "mid-onboarding" from
  "previously active, now deleted" without also checking
  `account_status`.
- The push-token offline-reconciliation story (above) has a narrow,
  bounded residual gap: a device that goes offline exactly at logout and
  is never used to register a token again (by any account) keeps a stale
  active-looking token until Expo eventually reports it undeliverable.
  Judged acceptable given how narrow the window is and that the existing
  delivery pipeline already self-heals it.
- `recoverable_error` has no dedicated UI (see "Offline limitations").

## Recovery procedures

- **A user reports being "stuck" after signup**: check
  `select id, full_name, role, account_status from public.profiles where id = '<uuid>'`
  — if genuinely missing (should not happen post-trigger, but the
  `handle_new_user` trigger and `on_auth_user_created` on `auth.users` are
  worth confirming still exist:
  `select tgname, tgenabled from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal;`),
  insert a bare `(id, full_name)` row — the same shape the trigger itself
  writes — and have them sign in again to reach `/choose-role` normally.
- **A user reports not receiving pushes after switching devices/accounts**:
  check `select user_id, is_active, updated_at from public.push_tokens where user_id = '<uuid>'`
  — if empty or all inactive, have them reopen the app (any dashboard
  mount re-registers). If a *different* account's token still shows
  active for what should be this device, that's the bounded offline-logout
  gap above — it self-corrects the next time either account registers a
  token on that device.
- **A user insists their deleted account is still accessible**: confirm
  `account_status`/`deleted_at` on `profiles`, and confirm the `auth.users`
  row is actually gone (`delete-account`'s known failure mode is the
  database cleanup succeeding while the Auth deletion step itself fails —
  see `docs/operations-runbook.md`'s "Account deletion fails" section). If
  the Auth row still exists, re-invoking `delete-account` for that user is
  safe and idempotent.
- **Rollback**: this task's Edge Function changes are none (no Edge
  Functions were modified, only `supabase/functions/*` was read for
  context) — reverting is purely a matter of rolling back the two new
  migrations' schema/function changes if ever needed, and reverting the
  touched app files to their prior committed versions. The `profiles`
  columns and RPCs added here are additive; leaving them in place unused
  is harmless even if the surrounding app code were reverted.
