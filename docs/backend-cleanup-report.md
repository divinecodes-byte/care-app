# Backend cleanup report — Week 1 security audit

Every removal below was verified unused (no cron job, trigger, client code,
or current Edge Function referenced it) before being removed. Nothing was
deleted on assumption.

## Removed

### Edge Function: `sync-missed-reminders`

Orphaned Deno Edge Function (`verify_jwt: false`, deployed but never called)
found during a prior session's audit and re-verified here before deletion.
Downloaded its actual source before removing it (not previously in this
repo) to confirm what it did: a Deno reimplementation of missed-reminder
detection, later superseded by the pure-SQL `sync_missed_reminders_db()`
(which is the one actually wired to `pg_cron` and — since a later session —
correctly uses `profiles.timezone` per-recipient instead of this function's
`APP_TIMEZONE` environment fallback, defaulting to `'UTC'` if unset).

Confirmed before removal:
- No `cron.job` row calls it (only `sync_missed_reminders_db()`, a
  different, currently-used SQL function, is scheduled).
- No database trigger references it.
- No client code (`grep -r "sync-missed-reminders"` across `app/`, `lib/`,
  and all `.sql` migrations) references it.
- No current Edge Function imports or calls it.

Additional reason to remove rather than merely leave dormant: it read the
project-wide `CRON_SECRET` value and would have accepted the **same**
secret currently used to authorize the legitimate `send-due-recipient-
reminders`/`check-push-receipts` functions (Supabase secrets are
project-wide, not per-function), meaning anyone with that legitimate secret
could still have triggered it — and it would have written **timezone-
incorrect** `reminder_logs` rows (UTC or a stale `APP_TIMEZONE`) that
directly conflict with the correct, currently-active
`sync_missed_reminders_db()`. Removed via `supabase functions delete`.

### Project secrets: `APP_TIMEZONE`, `SERVICE_ROLE_KEY`

Both created the same day as `sync-missed-reminders` (2026-06-15) and used
by nothing else — confirmed via `grep -rn "APP_TIMEZONE\|SERVICE_ROLE_KEY"
supabase/functions/` returning zero matches outside the now-deleted
function's downloaded source. Removed via `supabase secrets unset`.

**Correction to an earlier session's finding:** that session's own report
described `CRON_SECRET` as "stale" and said it would "mint a fresh secret."
Re-checked directly this pass: it did not mint a new *name*, it **overwrote
the existing `CRON_SECRET` value** with a freshly generated one — so the
current `CRON_SECRET` is not stale at all, it is the live secret
`send-due-recipient-reminders` and `check-push-receipts` authenticate with
today. **Not removed.** (This is exactly the kind of thing this audit's
"verify, don't assume" instruction exists for.)

### Database function: `check_invite_code(text)`

Superseded by `accept_invite_code(text)`, which validates and accepts
atomically (closing the check-then-act gap the two-call pattern left open,
even though that gap was already benign in practice — see
docs/security-model.md). Confirmed its only call site
(`app/join-invite.tsx`) was updated to call `accept_invite_code` instead
before dropping the function, in the same migration.

### RLS policy: "Authenticated users can view pending invite codes"

Not infrastructure in the traditional sense, but a genuine removal worth
recording here: this policy let **any signed-in user** `SELECT` every
outstanding pending invite system-wide (`invite_code`, `caregiver_id`,
`created_at`) — full enumeration, not just weak brute-force resistance.
Confirmed unused by grepping every `.from('connections')` call site in the
app; each one already scoped its own query by `caregiver_id`/`recipient_id`/
`id`. Dropped in the same migration that introduced the two invite RPCs.

### Client-side `Math.random()` invite-code generation

`invite-recipient.tsx`'s `generateInviteCode()` used `Math.random()` — not
cryptographically secure. Replaced entirely by moving generation server-side
into `create_invite_code()`, which uses `pgcrypto`'s `gen_random_bytes`.
This also removed the need to add a new client-side crypto dependency
(`expo-crypto` or similar) — nothing added to `package.json`.

## Retained (verified in active use, despite resembling something removable)

- **`CRON_SECRET`** — see correction above.
- No further retained-but-suspicious items were found.
  `create_caregiver_notification_event()`
  and `rls_auto_enable()` both still show `EXECUTE` granted to `anon`/
  `authenticated` (Postgres's default), but both are trigger/event-trigger
  functions that Postgres itself refuses to execute outside trigger context
  (confirmed empirically) — retained as-is, not a real exposure, and
  `rls_auto_enable` is Supabase platform infrastructure this project didn't
  create and shouldn't modify.
- **`net._http_response` row growth** — no retention/pruning job exists;
  747 rows at audit time. Not a security hole (service-role-only table,
  bodies contain only push-ticket JSON, no PII beyond a UUID), so not
  touched destructively in this task, but flagged as an operational
  follow-up in docs/security-model.md rather than silently ignored.

## Not removed because usage was uncertain

None — every item flagged by the prior audit was resolved one way or the
other (removed or confirmed active) rather than left in an "uncertain"
bucket. If a future audit finds something genuinely ambiguous, document it
here rather than guessing.
