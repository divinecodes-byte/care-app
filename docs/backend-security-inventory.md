# Tavora backend security inventory

Live snapshot of the linked Supabase project (`ofpzbifonihfutghbjbw`) and this
repository, taken during the Week 1 launch-hardening security audit. No
secret values, JWTs, keys, tokens, passwords, reminder content, or real user
data appear below — only structure (names, types, grants, policy text).

Regenerate this by re-running the queries in each section directly against
the linked project (`supabase db query --linked -o json "<query>"`) — every
finding here was produced that way, not assumed from memory.

## 1–2. Tables, views

All 8 public-schema objects are base tables; **no views or materialized
views exist**.

| Table | Purpose |
|---|---|
| `profiles` | 1:1 with an Auth identity while active; survives as an anonymized tombstone after account deletion (`account_status='deleted'`) |
| `connections` | Caregiver↔recipient relationships, invite codes |
| `reminders` | Recurring reminder definitions (caregiver-authored) |
| `reminder_logs` | Per-occurrence response history (taken/skipped/snoozed/missed) |
| `push_tokens` | Expo push tokens, one active row per device |
| `reminder_notification_deliveries` | Idempotency ledger for server-sent recipient pushes |
| `caregiver_notification_events` | Outbound caregiver push queue/send-log |
| `notification_preferences` | Per-caregiver notification opt-in flags |

## 3. RLS status

All 8 tables have RLS **enabled** (`relrowsecurity = true`), none forced
(`relforcerowsecurity = false`, the normal/expected setting — forcing would
also restrict the table owner). Verified directly, not assumed.

## 4. RLS policies (post-audit state)

| Table | Policy | Cmd | Role | Check |
|---|---|---|---|---|
| profiles | Users can create their own profile | INSERT | authenticated | `auth.uid() = id` |
| profiles | Users can view their own profile | SELECT | authenticated | `auth.uid() = id` |
| profiles | Users can view connected profiles | SELECT | authenticated | own row, or counterpart in an **accepted** connection |
| profiles | Users can update their own profile | UPDATE | authenticated | `auth.uid() = id` |
| connections | Users can view their related connections | SELECT | authenticated | `caregiver_id = auth.uid() OR recipient_id = auth.uid()` |
| connections | *(no INSERT/UPDATE/DELETE policies)* | — | — | all mutation goes through `create_invite_code()` / `accept_invite_code()`, both `SECURITY DEFINER` |
| reminders | Caregivers can create reminders for accepted connections | INSERT | authenticated | caregiver owns an accepted connection matching `recipient_id`/`connection_id` |
| reminders | Users can view reminders for their connection | SELECT | authenticated | `caregiver_id = auth.uid() OR recipient_id = auth.uid()` |
| reminders | Caregivers can update their own reminders | UPDATE | authenticated | caregiver owns the row **and** the new `recipient_id`/`connection_id` still matches a real accepted connection of theirs (hardened this audit — see finding SEC-2) |
| reminder_logs | Recipients can create logs for their reminders | INSERT | authenticated | recipient owns a reminder matching `reminder_id`/`connection_id`/`caregiver_id` |
| reminder_logs | Users can view logs for their connection | SELECT | authenticated | `caregiver_id = auth.uid() OR recipient_id = auth.uid()` |
| reminder_logs | Recipients can update their own logs | UPDATE | authenticated | recipient owns the row **and** `reminder_id`/`connection_id`/`caregiver_id` still match a real reminder of theirs (hardened this audit — see finding SEC-3) |
| push_tokens | Users can insert/view/update own push tokens | ALL | authenticated | `user_id = auth.uid()` |
| notification_preferences | Users can insert/view/update own prefs | ALL | authenticated | `caregiver_id = auth.uid()` |
| caregiver_notification_events | Caregivers can view own notification events | SELECT | public¹ | `caregiver_id = auth.uid()` |
| reminder_notification_deliveries | *(none)* | — | — | default-deny for anon/authenticated; only `service_role` and `SECURITY DEFINER` functions touch this table |

¹ Role scoping harmless (`auth.uid()` is null for anon regardless) but not
tightened this pass since it wasn't part of the confirmed-exploitable finding
set — candidate for a future pass.

## 5. Foreign keys and cascade behavior

Every FK in `public` is `ON DELETE CASCADE` **except** `profiles.id`, whose
FK to `auth.users(id)` was deliberately **dropped** during the account-
deletion task so a profile can survive as a tombstone after its Auth
identity is removed (otherwise deleting one party's Auth user would cascade
delete `reminders`/`reminder_logs` a surviving counterpart still needs).
Full list: `connections.caregiver_id/recipient_id`, `reminders.connection_id
/caregiver_id/recipient_id`, `reminder_logs.reminder_id/connection_id/
caregiver_id/recipient_id`, `push_tokens.user_id`, `notification_preferences
.caregiver_id`, `caregiver_notification_events.*`, `reminder_notification_
deliveries.reminder_id/recipient_id` → all CASCADE → `profiles(id)`.

## 6–11. Database functions

| Function | Lang | SECURITY DEFINER | search_path | Owner |
|---|---|---|---|---|
| `check_invite_code` | — | — | — | **removed this audit**, superseded by `accept_invite_code` |
| `create_invite_code(uuid)` | plpgsql | yes | `public, extensions, pg_catalog` | postgres |
| `accept_invite_code(text)` | plpgsql | yes | `public, extensions, pg_catalog` | postgres |
| `claim_due_recipient_reminder_deliveries()` | sql | yes | `public, extensions, pg_catalog` | postgres |
| `claim_due_recipient_snooze_deliveries()` | sql | yes | `public, extensions, pg_catalog` | postgres |
| `sync_missed_reminders_db()` | plpgsql | yes | `public, extensions, pg_catalog` | postgres |
| `send_pending_caregiver_push_notifications()` | plpgsql | yes | `public, extensions, pg_catalog` | postgres |
| `trigger_send_due_recipient_reminders()` | plpgsql | yes | `public, extensions, pg_catalog` | postgres |
| `trigger_check_push_receipts()` | plpgsql | yes | `public, extensions, pg_catalog` | postgres |
| `delete_current_user_data(uuid)` | plpgsql | yes | `public, extensions, pg_catalog` | postgres |
| `create_caregiver_notification_event()` | plpgsql | yes | `public, extensions, pg_catalog` | postgres — trigger function, cannot be invoked directly (confirmed: `select public.create_caregiver_notification_event()` raises `0A000: trigger functions can only be called as triggers` regardless of grants) |
| `rls_auto_enable()` | plpgsql | yes | `pg_catalog` | postgres — Supabase-managed event-trigger function (`ensure_rls`, auto-enables RLS on new tables), same "cannot be called directly" protection as above; not created or modified by this project |

Every `SECURITY DEFINER` function has an explicit `search_path` set (no
function relies on the caller's search_path — the classic SECURITY DEFINER
injection vector). All schema-qualify their table references.

## 12. EXECUTE grants (final state)

| Function | anon | authenticated | service_role |
|---|---|---|---|
| `create_invite_code`, `accept_invite_code` | no | **yes** (legitimately client-facing) | yes |
| `check_invite_code` | — | — | removed |
| `claim_due_recipient_reminder_deliveries`, `claim_due_recipient_snooze_deliveries`, `sync_missed_reminders_db`, `send_pending_caregiver_push_notifications`, `trigger_send_due_recipient_reminders`, `trigger_check_push_receipts`, `delete_current_user_data` | no | no | yes |
| `create_caregiver_notification_event`, `rls_auto_enable` | yes | yes | yes — harmless, see §6-11 (trigger/event-trigger functions, not directly callable regardless of grant) |

Verification query:
```sql
select p.proname,
  has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
  has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' order by p.proname;
```

## 13–14. Edge Functions

| Function | verify_jwt | Auth model |
|---|---|---|
| `send-due-recipient-reminders` | false | `x-cron-secret` header checked against `CRON_SECRET` |
| `check-push-receipts` | false | same |
| `delete-account` | **true** (platform gateway) + independently calls `auth.getUser()` and enforces a 15-minute JWT-freshness window | real user JWT only |
| `sync-missed-reminders` | — | **removed this audit** — orphaned, see backend-cleanup-report.md |

## 15. pg_cron jobs

| Job | Schedule | Calls | Role |
|---|---|---|---|
| `send-due-recipient-reminders` | every 30s | `trigger_send_due_recipient_reminders()` | postgres |
| `check-push-receipts` | `*/15 * * * *` | `trigger_check_push_receipts()` | postgres |
| `send-caregiver-push-notifications` | `* * * * *` | `send_pending_caregiver_push_notifications()` | postgres |
| `sync-missed-reminders-db` | `*/5 * * * *` | `sync_missed_reminders_db()` | postgres |

One job per responsibility confirmed; no duplicates. All run as `postgres`
(confirmed via `cron.job.username`), so none of this audit's `REVOKE ...
FROM anon, authenticated` changes affect cron execution.

## 16. pg_net callers

Only the four `trigger_*`/cron-wrapper functions above call `net.http_post`
(to the two recipient-push Edge Functions), plus
`send_pending_caregiver_push_notifications()` (directly to Expo's push API,
no Edge Function in that path). `net._http_response` retention: **no
automatic pruning configured** — 747 rows at audit time, growing ~2-3/minute
from the 30s+1min+15min cadences combined. Flagged as a residual risk in
docs/security-model.md; not fixed in this task (no destructive/production
data touched without a deliberate decision, and this is an operational
housekeeping item, not a security hole).

## 17–18. Vault / project secrets

Vault: exactly one secret, `recipient_push_cron_secret` (used by the two
`trigger_*` wrapper functions to authenticate their `net.http_post` calls).

Project secrets (names only): `CRON_SECRET` (actively used by
`send-due-recipient-reminders`/`check-push-receipts` — confirmed via direct
grep of this repo's function source, **not** the stale value implied by an
earlier audit's phrasing; it was overwritten with a fresh value when those
functions were built), plus the platform-auto-injected
`SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY`/
`SUPABASE_DB_URL`/`SUPABASE_JWKS`/`SUPABASE_PUBLISHABLE_KEYS`/
`SUPABASE_SECRET_KEYS` (never modified by this project). `APP_TIMEZONE` and
`SERVICE_ROLE_KEY` (custom, distinct from the platform-injected
`SUPABASE_SERVICE_ROLE_KEY`) **removed this audit** — see
backend-cleanup-report.md.

## 19–20. Triggers

One real table trigger: `trg_create_caregiver_notification_event` (AFTER
INSERT OR UPDATE on `reminder_logs`, calls `create_caregiver_notification_event()`).
One Supabase-managed event trigger relevant to this project's own objects:
`ensure_rls` (`rls_auto_enable()`, auto-enables RLS on newly created public
tables — confirmed empirically with a throwaway probe table). The other
event triggers (`pgrst_ddl_watch`, `issue_pg_cron_access`, etc.) are
Supabase platform infrastructure owned by `supabase_admin`, unrelated to
this app.

## 21. Push-token registration paths

Single path: `lib/notifications.ts`'s `registerPushToken(userId)`, called
from `recipient-dashboard.tsx`, `caregiver-dashboard.tsx`, and
`settings-sheet.tsx` (both roles). Upserts on `expo_push_token` (globally
`UNIQUE`), which means a physical token is only ever active for one
`user_id` row at a time — verified no duplicate-token rows exist across
different users. RLS scopes insert/select/update to `user_id = auth.uid()`.

## 22. Invite-code generation and validation paths

Post-audit: **entirely server-side.** `create_invite_code(uuid)` generates
(pgcrypto `gen_random_bytes`, 32-character ambiguity-free alphabet, 7-day
expiration) and `accept_invite_code(text)` validates+accepts atomically
(self-connection, expiration, and a concurrent-acceptance race are all
enforced inside the function). The client (`invite-recipient.tsx`,
`join-invite.tsx`) only ever calls these two RPCs — no direct
INSERT/UPDATE on `connections` remains reachable from a client. See
backend-cleanup-report.md finding SEC-1/SEC-4 for what this replaced.
