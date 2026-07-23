# Tavora security model

This documents how Tavora's backend actually enforces isolation between
users today — not an aspirational design. Every claim below was verified
directly against the live linked Supabase project and/or the synthetic
attack suite in `scripts/security-audit/`, not assumed. It does not claim
any formal security certification (SOC 2, HIPAA, etc.) — Tavora is not
represented as HIPAA compliant anywhere in this document or the app.

## Trust boundaries

```
┌─────────────────────┐         ┌──────────────────────────────┐
│  Mobile app (client) │  JWT    │  Supabase project             │
│  anon/publishable key│ ──────► │  PostgREST + RLS               │
│  (bundled, not secret)│        │  (every request runs AS the   │
└─────────────────────┘         │   authenticated user — never  │
                                  │   as service_role)             │
                                  └───────────────┬────────────────┘
                                                   │ service_role key
                                                   │ (server-side only)
                        ┌──────────────────────────▼─────────────────────┐
                        │  Edge Functions (Deno, Supabase-managed)        │
                        │  send-due-recipient-reminders, check-push-      │
                        │  receipts, delete-account                       │
                        └──────────────────────────┬─────────────────────┘
                                                   │
                        ┌──────────────────────────▼─────────────────────┐
                        │  pg_cron (runs as `postgres`) → pg_net           │
                        │  → Edge Functions, authenticated via a          │
                        │    Vault-stored shared secret                   │
                        └──────────────────────────────────────────────────┘
```

The client never holds a service-role credential. The only credential in
the mobile bundle is the publishable/anon key (`EXPO_PUBLIC_SUPABASE_
PUBLISHABLE_KEY`), which is meant to be public — it identifies the project,
not a privilege level. All real access control happens at two layers:
**RLS policies** (for anything the client touches directly) and **grants**
(which functions/tables each Postgres role may use at all).

## Authenticated client capabilities

An authenticated user (any signed-in Tavora account) can, directly:
- Read/update their own `profiles` row; read a **connected** counterpart's
  profile only while the connection's `status = 'accepted'`.
- Read `connections`/`reminders`/`reminder_logs` rows where they are
  `caregiver_id` or `recipient_id`.
- Insert a `reminders` row only for a connection they own where the
  `recipient_id` matches that connection's accepted recipient.
- Insert/update a `reminder_logs` row only for a reminder where they are
  the recipient — and, since this audit, only in a way that keeps
  `reminder_id`/`caregiver_id`/`connection_id` consistent with a real
  reminder still assigned to them (previously this was **not** enforced —
  see Known Residual Risks history / backend-security-inventory.md).
- Manage only their own `push_tokens` and (if a caregiver) their own
  `notification_preferences`.
- Call `create_invite_code()` (if their `profiles.role = 'caregiver'`) and
  `accept_invite_code(text)` — the only sanctioned way to write to
  `connections` at all.

An authenticated user **cannot**, under any circumstance verified by the
attack suite: read/write another user's profile, reminders, logs, or push
tokens; read the delivery ledger (`reminder_notification_deliveries`) or
another caregiver's `caregiver_notification_events`; call any
`SECURITY DEFINER` function reserved for `service_role` (grants explicitly
revoked from `anon`/`authenticated`); or connect to themselves / re-use /
outlast an invite code past its 7-day expiration.

## Service-role capabilities

`service_role` is used exclusively inside Edge Functions
(`send-due-recipient-reminders`, `check-push-receipts`, `delete-account`)
and bypasses RLS by Postgres/PostgREST design. The service-role key exists
only as a Supabase-managed Edge Function secret
(`SUPABASE_SERVICE_ROLE_KEY`, auto-injected by the platform) — never in the
mobile app, never in a committed `.env` file (verified: `.env` is
git-ignored and has never appeared in this repo's git history), never
hardcoded in any migration.

## Edge Function authentication model

| Function | Model |
|---|---|
| `send-due-recipient-reminders`, `check-push-receipts` | `verify_jwt: false` at the platform gate (deliberate — these are never called by a user JWT); the function itself independently requires `x-cron-secret` to equal `Deno.env.get('CRON_SECRET')`, or returns 401 |
| `delete-account` | `verify_jwt: true` at the platform gate **and** independently calls `auth.getUser()` to resolve the caller — never trusts a client-supplied user ID (there is no request body at all) — **and** rejects a JWT whose `iat` claim is older than 15 minutes, enforcing "recent authentication" server-side rather than only trusting the client's own reauthentication step |

## Cron authentication model

Every `pg_cron` job runs as the `postgres` role (confirmed via
`cron.job.username`) and calls a thin SQL wrapper function
(`trigger_send_due_recipient_reminders()`, `trigger_check_push_receipts()`)
that reads a shared secret from `vault.decrypted_secrets` and passes it as
`x-cron-secret` via `net.http_post`. The secret never appears in the
function source itself (queryable via `pg_proc` by a DB admin — Vault
avoids that), and the two `trigger_*` functions plus every other privileged
`SECURITY DEFINER` function are `REVOKE`d from `anon`/`authenticated`.

## Connection authorization model

A connection only ever transitions `pending → accepted → ended` (never
back). It's created and accepted exclusively through
`create_invite_code()`/`accept_invite_code()` — both `SECURITY DEFINER`,
both enforce their invariants (caregiver-only creation, self-connection
rejection, expiration, atomic single-winner acceptance under concurrency)
inside the function, not just via RLS. No client-facing INSERT/UPDATE
policy exists on `connections` at all as of this audit. `ended` connections
are excluded from every RLS check that requires `status = 'accepted'`
(the connected-profiles policy, the reminder-creation policy, the
reminder-update policy) — verified directly (scenario S in the attack
suite).

## Reminder ownership model

A `reminders` row's `caregiver_id`/`recipient_id`/`connection_id` are
pinned by RLS at both INSERT and UPDATE time to a real, currently-accepted
connection the caregiver owns — the UPDATE policy was tightened this audit
specifically because it previously let a caregiver silently reassign one of
their own reminders to an unrelated recipient (scenario J). `reminder_logs`
rows are similarly pinned at UPDATE time to still match a real reminder
still assigned to the updating recipient (scenario L).

## Notification-delivery model

`reminder_notification_deliveries` has **zero** client-facing RLS policies
— not even a caregiver/recipient SELECT — the ledger is written and read
exclusively by `service_role` (inside `send-due-recipient-reminders`) and
by the two `SECURITY DEFINER` claim functions (which are themselves
`service_role`-only). A due occurrence is claimed idempotently
(`INSERT ... ON CONFLICT DO NOTHING` on `(reminder_id, occurrence_date,
delivery_type)`), re-validated against live reminder/connection/log state
immediately before sending, and only ever sent to `push_tokens` rows owned
by the correct `recipient_id`.

## Account deletion model

`delete-account` resolves the target exclusively from the caller's own JWT.
`delete_current_user_data(uuid)` (service-role-only) then: deactivates
every reminder the account was a party to either side; deletes push tokens,
pending/failed delivery rows, caregiver notification events, and
notification preferences outright; ends (not deletes) every connection the
account was a party to; and scrubs the `profiles` row (`full_name = null`,
`account_status = 'deleted'`, `deleted_at` set) while **keeping the row** —
`profiles.id` no longer has a foreign key to `auth.users(id)` (deliberately
dropped), so the tombstone can outlive the Auth identity without cascading
away a surviving counterpart's shared `reminders`/`reminder_logs`. Only
after that succeeds does the function call the Auth Admin API to delete the
user. Every step is idempotent, so a retry after a partial failure (DB
cleanup succeeded, Auth deletion failed) is safe.

## Known residual risks

- **`net._http_response` has no retention/pruning job** — grows
  unboundedly (747 rows at audit time). Not a data-exposure risk (
  `service_role`-only table, bodies are push-ticket JSON with no PII beyond
  a UUID), but worth a scheduled cleanup job eventually.
- **Notification content on the lock screen**: recipient push titles
  include the caregiver-authored reminder title (e.g. a medication name);
  caregiver push bodies include the recipient's name and reminder title.
  This is a deliberate, reviewed product tradeoff (the core value of the
  app depends on the recipient seeing what to do without unlocking their
  phone) — flagged here as a known characteristic for the future
  privacy-settings task to potentially make configurable, not silently
  changed in this audit.
- **`caregiver_notification_events`/`create_caregiver_notification_event()`
  and Supabase's own `rls_auto_enable()`** still show `EXECUTE` granted to
  `anon`/`authenticated` by Postgres's default — confirmed harmless (both
  are trigger/event-trigger functions Postgres refuses to execute outside
  trigger context regardless of grants), but not formally revoked, since
  revoking EXECUTE from a trigger function has no practical effect and
  touching Supabase-managed platform infrastructure (`rls_auto_enable`) is
  out of this project's control anyway.
- **`MAX_FREE_PARTICIPANTS` (the free-tier connection limit) is enforced
  client-side only** — a modified client could call `create_invite_code()`
  past the intended limit. This is a monetization/business-logic gap, not
  a cross-user data-access vulnerability, and enforcing tier limits is
  payment-adjacent — deliberately out of scope for this security task
  (hard constraint: do not modify payments).
- **Alert-style error messages** (`Alert.alert(title, error.message)`,
  used throughout the app) can surface raw Postgres/PostgREST error text to
  the user who triggered the error. This is the user seeing detail about
  *their own* failed request, not a cross-user leak, but is unpolished —
  left as-is per this task's "don't redesign the entire UI" scope.

## Incident response basics

1. **Suspected credential leak (service-role key, cron secret, Vault
   secret)**: rotate immediately (see below), check Supabase project audit
   logs / Edge Function logs for the affected window, check
   `reminder_notification_deliveries`/`caregiver_notification_events` for
   anomalous send volume.
2. **Suspected RLS bypass or cross-user data access**: re-run
   `scripts/security-audit/run.ts` against the live project immediately —
   it exercises the exact attack surface this document describes end to
   end and will fail loudly (non-zero exit, explicit FAIL lines) if
   isolation has regressed.
3. **Suspected malicious account**: their Auth user can be disabled/deleted
   via the Supabase dashboard Auth panel independent of the in-app deletion
   flow; `delete_current_user_data()` can also be invoked directly via
   `supabase db query --linked` by a project admin as an emergency manual
   path (service-role/postgres access only — not client-reachable).

## Rotating secrets

- **`CRON_SECRET`** (Edge Function secret) and **`recipient_push_cron_
  secret`** (Vault secret, must match): generate a new value server-side
  (`select encode(gen_random_bytes(32), 'hex');` via `supabase db query`,
  never generated or transmitted through a less-trusted channel), update
  both:
  ```sql
  select vault.update_secret(
    (select id from vault.secrets where name = 'recipient_push_cron_secret'),
    '<new value>'
  );
  ```
  ```bash
  supabase secrets set CRON_SECRET=<same new value>
  ```
  Both must be updated together — a mismatch makes the recipient-push
  pipeline silently stop (fails closed, not open: the functions reject the
  now-wrong secret).
- **Service-role key**: rotated only via the Supabase dashboard (Project
  Settings → API) — this project never stores it outside the
  platform-managed Edge Function secret, so rotating it there is sufficient;
  no code change needed since functions read it via
  `Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')`, always the current value.

## Disabling server push quickly

Set `profiles.server_push_enabled = false` for all recipients (`update
public.profiles set server_push_enabled = false;`) — every claim function's
`WHERE` clause requires this flag, so this immediately and completely stops
all future recipient push sends without touching cron jobs, Edge Functions,
or reminder data. To fully halt the pipeline instead: `select
cron.unschedule('send-due-recipient-reminders');` (and `'check-push-
receipts'` if desired) — reversible with `cron.schedule(...)` using the same
definitions in the relevant migration file.

## Disabling account deletion quickly

`supabase functions delete delete-account` removes the endpoint entirely
(the Settings UI will show a network error on attempted use, not a false
success — worth pairing with a client-side flag/remote-config check if this
is ever needed for longer than a brief incident window, not implemented
here since it hasn't been needed). No database rollback is required — the
underlying `delete_current_user_data()` function and schema changes are
inert without the endpoint calling them.
