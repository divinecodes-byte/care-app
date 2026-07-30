# Routine Security Model

Week 3 product-expansion task #3. The full authorization contract for
routine templates and routine instances — every claim here is backed by a
live, automated test in `scripts/routine-audit/run.ts` (letter references
below).

## Ownership and role requirements

- Only accounts with `profiles.role = 'caregiver'` may own or apply
  templates. `create_routine_template`/`apply_routine_template` both check
  `v_profile.role is distinct from 'caregiver'` and raise
  `organizer_role_required` otherwise — a participant account is rejected
  outright (scenario F).
- Every mutation RPC re-checks `profiles.account_status = 'active'` for the
  caller — a tombstoned/deleted account cannot create, edit, duplicate,
  archive, restore, delete, or apply a template (mirrors the same guard
  already used by `create_task`/reminder mutation paths elsewhere).
- Ownership is immutable and never client-supplied: every RPC derives the
  owner/organizer from `auth.uid()`, never from a request parameter — there
  is no `p_owner_id` anywhere in the template or apply RPC signatures.

## Direct table access: RLS + grants

All four new tables (`routine_templates`, `routine_template_items`,
`routine_instances`, `routine_instance_items`) have:

- RLS **enabled**.
- Exactly one **SELECT** policy each, scoped to the owning/participating
  account:
  - Templates: `owner_id = auth.uid()`.
  - Template items: joined through `routine_templates.owner_id =
    auth.uid()`.
  - Instances: `organizer_id = auth.uid() OR participant_id = auth.uid()`.
  - Instance items: joined through the parent instance's same organizer/
    participant check.
- **Zero INSERT/UPDATE/DELETE grant to `authenticated`** — confirmed live,
  a direct client `insert` against either `routine_templates` or
  `routine_instances` is rejected outright with a permission-denied error
  (scenario BZ). Every mutation is forced through a SECURITY DEFINER RPC.

`routine_notification_deliveries` has **no client-facing policy at all**
(matches `reminder_notification_deliveries`' existing precedent) —
service-role/SECURITY DEFINER functions bypass RLS regardless, and there is
no UI need to read this table directly.

## Cross-account isolation (verified live)

- Organizer A cannot read Organizer B's templates (`H`) or template items
  (`CA`) — RLS filters to an empty/`null` result, never an error that would
  leak existence.
- Organizer A cannot mutate Organizer B's template by ID —
  `update_routine_template`/`archive_routine_template`/etc. all re-fetch
  the row and check `owner_id = auth.uid()`, raising `not_authorized`
  otherwise (`I`).
- Organizer A cannot apply Organizer B's template — `apply_routine_template`
  re-checks `v_template.owner_id <> v_organizer_id` (`template_not_found`,
  deliberately not a distinct "forbidden" code, so template existence isn't
  leaked to a non-owner).
- Organizer A cannot apply a routine against Organizer B's connection —
  `v_connection.caregiver_id <> v_organizer_id` fails with
  `connection_inactive` (`X`), the same code used for a genuinely-inactive
  connection, so a caller can't distinguish "not your connection" from
  "connection isn't accepted" — no information leak either way.
- An unrelated participant cannot read a routine instance assigned to
  someone else (`BC`); an unrelated organizer cannot read another
  connection's routine instance (`BD`).
- A participant may read only their own privacy-safe applied routine
  instance (`BB`) — never another organizer's private template catalog
  (RLS on `routine_templates` has no participant-visibility branch at all).
- Two organizers each applying their own routine to their own participants
  never cross-contaminate — verified with concurrent applies to two
  entirely separate connections (`BP`/`BR`).

## Immutable linkage

- Template ownership cannot be reassigned — no RPC accepts a new
  `owner_id` for an existing template.
- Routine member links cannot be reassigned — `routine_instance_items` has
  no update RPC at all; `reminder_id`/`task_id` are set once at creation
  and partial-unique-indexed so a given reminder/task can never become a
  member of a second routine instance either.

## Input validation and abuse resistance

- Ended connection rejects apply (`W`); pending (not-yet-accepted)
  connection rejects apply (`V`).
- Invalid/missing participant timezone rejects apply with
  `participant_timezone_unavailable` (`AJ`) — never a hardcoded or
  device-timezone fallback (see `docs/today-hub-model.md`'s broader
  timezone-authority contract, which this reuses via
  `_is_valid_iana_timezone`).
- Oversized item payload (title > 200 chars) is rejected (`AI`); more than
  20 items is rejected (`AH`).
- A mixed payload with one malformed item rolls back the *entire* apply —
  no partial reminders, no partial tasks, no orphaned routine instance
  (`AC`/`AD`/`AE`).
- Duplicate `apply_request_id` never duplicates items (`AF`); concurrent
  identical apply requests create exactly one routine (`AG`); concurrent
  *different* apply requests (different connections/organizers) remain
  fully independent (`BP`).
- Built-in pack metadata (`p_built_in_pack_id`/`p_built_in_pack_version`)
  cannot be used to bypass item-level validation — every field in every
  item is independently checked regardless of source (see
  `docs/routine-template-model.md`'s "Storage decision" section).

## SECURITY DEFINER discipline

Every new function (`create_routine_template`, `update_routine_template`,
`duplicate_routine_template`, `archive_routine_template`,
`restore_routine_template`, `delete_routine_template`,
`apply_routine_template`, `archive_routine_instance`, plus the internal
helpers `_is_valid_iana_timezone`, `_create_task_core`,
`_insert_routine_template_item`, `_routine_template_summary`,
`_routine_instance_summary`) is declared `security definer` with a fixed
`set search_path = public, extensions, pg_catalog`. Every function —
**including internal helpers** — has an explicit `revoke all ... from
public, anon` (Postgres grants `EXECUTE` to `PUBLIC` by default on function
creation, so this is not optional): only the eight public-facing RPCs are
then granted `execute` to `authenticated`; the four internal helpers are
granted to nobody beyond their owning role, callable only from within
another function owned by that same role.

## Account deletion and connection ending

- **Connection ending** (`end_connection`, unchanged): deactivates every
  `reminders`/`tasks` row for that connection, including any created by a
  routine — a routine's member items stop future activity through the
  *existing* mechanism, no new logic needed (`BN`). No new routine can be
  applied against an ended connection (`connection_inactive`, same as
  above).
- **Organizer account deletion**: `delete-account` tombstones the
  `profiles` row (`account_status = 'deleted'`, fields anonymized) — it
  does **not** hard-delete the row. Since `routine_instances.organizer_id`
  references `profiles(id) on delete cascade`, this matters: cascade only
  fires on an actual row deletion, which tombstoning never triggers, so a
  routine instance's grouping/history survives organizer account deletion
  exactly like reminder/task history already does (`BO`).
- **Participant account deletion**: identical reasoning — tombstoning, not
  deletion, so `routine_instances.participant_id`'s cascade never fires
  either. No future activity occurs (the underlying reminders/tasks are
  already deactivated by the existing deletion flow), and no private
  profile data is newly exposed by a routine instance beyond what the
  existing reminder/task tombstone behavior already handles.

## No weakening of existing policies

This feature added four new tables and nine new functions; it did not
modify any existing RLS policy, grant, or SECURITY DEFINER function's
authorization logic other than the deliberate, additive `create_task` →
`_create_task_core` extraction (which preserves 100% of `create_task`'s
own pre-existing checks — see `docs/routine-application-model.md`).
`scripts/security-audit/run.ts` (24/24) and `scripts/auth-audit/run.ts`
(37/37) both remain fully passing, confirmed via
`scripts/routine-audit/run.ts` scenarios CB/CC.
