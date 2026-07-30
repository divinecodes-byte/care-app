# Routine Application Model

Week 3 product-expansion task #3. How a routine pack/template actually
becomes real reminders and tasks for one participant — the transactional
`apply_routine_template` operation, its idempotency/concurrency behavior,
and the routine-instance grouping model it produces. See
`docs/routine-template-model.md` for the template schema this consumes,
`docs/routine-notification-contract.md` for the assignment-push behavior,
and `docs/routine-security-model.md` for the full authorization contract.

## No second lifecycle authority

This is the single most important constraint in this whole feature: a
routine instance is **metadata and grouping only**. It never stores a
completion status for its members, never replaces `reminder_logs` or
`task_occurrences`, and never introduces a shared response RPC. Every
reminder/task created by applying a routine is created through the
*exact same* insert path (and is therefore subject to the *exact same*
lifecycle, RLS, analytics, and notification rules) as one created through
`create-reminder.tsx`/`create-task.tsx` directly. `routine_instance_items`
is pure linkage: `{ routine_instance_id, item_kind, reminder_id | task_id,
display_order }`, nothing else.

## One atomic, transactional apply operation

`apply_routine_template(p_connection_id, p_source_template_id,
p_source_template_revision, p_built_in_pack_id, p_built_in_pack_version,
p_title, p_start_date, p_items, p_apply_request_id)` is a single PL/pgSQL
function call. This is what makes "apply a mixed 5-item routine" safe as
*one* client request instead of five independent, individually-fallible
network calls:

- **Atomicity is free.** Postgres functions have no partial commit — an
  unhandled exception anywhere in the function body (an invalid item, a
  constraint violation, anything) aborts every effect of that single call,
  including the `routine_instances` row itself. There is no explicit
  `BEGIN`/`COMMIT`/rollback logic to get wrong; this is simply how
  PL/pgSQL functions already behave, confirmed live in
  `scripts/routine-audit/run.ts` scenarios AC/AD/AE (a 3-item apply with
  one intentionally-invalid item leaves *zero* rows behind — no routine
  instance, no reminder, no task).
- **Every item is independently server-validated regardless of source.**
  Reminder items are validated inline (frequency, 1–7 `days_of_week`,
  required `time_of_day`/`reminder_type`/`no_response_minutes`, title/notes
  length) mirroring the reminders table's own CHECK constraints. Task items
  are validated by delegating to `_create_task_core` (see below) — the
  *exact* same validation `create_task` itself uses.
- **Reusing `create_task`'s validation without weakening its own
  authorization.** `create_task`'s insert logic was extracted into a
  private helper, `_create_task_core(p_connection_id, p_caregiver_id,
  p_recipient_id, ..., p_suppress_notification)`, callable only by
  functions owned by the same role (never granted to `authenticated`
  directly). `create_task` itself still performs 100% of its own
  auth/connection checks before calling the helper — nothing about its
  public authorization changed. `apply_routine_template` validates the
  connection/organizer/participant *once*, then calls the helper once per
  task item. There is no equivalent public `create_reminder` RPC to
  preserve (reminders are created via direct client insert under RLS
  today), so the reminder branch validates and inserts inline instead.

## Idempotency and concurrency

`routine_instances` has a `unique (organizer_id, apply_request_id)`
constraint — this single index is the entire idempotency/concurrency
mechanism:

1. On entry, `apply_routine_template` first looks up an existing instance
   for `(organizer_id, apply_request_id)`. If found, it returns that
   instance's summary immediately (`alreadyExisted: true`) — **before**
   any other validation runs, so a naive client retry after a network
   timeout is always safe (scenario AF).
2. If not found, it inserts the `routine_instances` row with `on conflict
   (organizer_id, apply_request_id) do nothing`. This is the real
   concurrency gate: if two requests with the *same* `apply_request_id`
   race, exactly one wins the insert; the loser sees `not found`, falls
   through to the same "read back the existing instance" path as case 1,
   and creates **no** items at all. Verified live with two truly
   concurrent (`Promise.all`) identical requests — exactly one
   `routine_instances` row exists afterward (scenario AG).
3. Only the winner of that insert proceeds to validate and create items,
   inside the same function call/transaction as the winning insert.

`app/routine-preview.tsx` generates the `apply_request_id` client-side
once per Apply attempt (`lib/routineCore.ts#generateApplyRequestId`, stored
in a ref so a retry of the *same* attempt reuses it) — a fresh Apply tap
(not a retry) always gets a new key, so two genuinely different apply
intents from the same organizer are never collapsed together.

## Request payload and limits

```
apply_routine_template(
  p_connection_id uuid,          -- must be an accepted connection the caller organizes
  p_source_template_id uuid,     -- exactly one of these two source fields is set
  p_source_template_revision int,-- optional stale-revision guard (see routine-template-model.md)
  p_built_in_pack_id text,
  p_built_in_pack_version text,
  p_title text,                  -- <= 200 chars
  p_start_date date,
  p_items jsonb,                 -- 1-20 already-resolved, concrete items
  p_apply_request_id text        -- client-generated idempotency key
)
```

Each item in `p_items` is not a template reference — it is already a
concrete, resolved payload. **Task** items have their offset turned into an
absolute date by `lib/routineCore.ts` client-side (pure calendar-date-
string arithmetic). **Reminder** items instead carry their offset as a raw
integer, resolved into an actual instant server-side — see "Reminder start
offsets" below for why these two are deliberately different:

```
reminder: { item_kind:'reminder', title, notes, reminder_type,
            time_of_day:'HH:MM', frequency, days_of_week:[1..7],
            no_response_minutes, start_offset_days }
task:     { item_kind:'task', title, notes, frequency,
            days_of_week:[1..7] (omit/[] for one_time),
            start_date:'YYYY-MM-DD', due_date, recurrence_end_date }
```

Only *enabled* items (per the preview screen's toggles) are included —
disabled items are simply omitted from the array, so nothing is ever
created and then hidden.

Limits, all enforced server-side regardless of what the client sends:

- 1–20 items per apply (`invalid_item_count`) — chosen as a reasonable
  launch maximum; a routine with more items than that almost certainly
  belongs as several smaller routines.
- Title ≤ 200 chars, notes ≤ 2000 chars per item (`invalid_item_title`/
  `invalid_item_notes`).
- `p_items` is a bounded jsonb array, not an unbounded blob — the 20-item
  cap combined with the per-field length caps keeps the payload size
  bounded regardless of what a client attempts to send.

## Reminder start offsets

Fixed as a correctness closure after the original implementation accepted
and stored a reminder template item's `start_offset_days` but silently
dropped it at apply time (a reminder started immediately regardless of its
configured offset) — see `docs/routine-template-model.md`'s "Relative date
semantics" for the full history. This is now authoritative, using only
existing, unmodified reminder-lifecycle mechanisms:

**Why reminders needed a different mechanism than tasks.** Tasks have a
real `start_date` *column* — an absolute calendar date is simply written
there. Reminders have no such column at all: a reminder's eligibility is
governed entirely by `days_of_week` plus `created_at`, via the same
`greatest(r.created_at, c.accepted_at)` gate already present, unmodified,
in `claim_due_recipient_reminder_deliveries`, `sync_missed_reminders_db`,
and `respond_to_reminder_occurrence`. That gate is exactly the lever a
start offset needs — no new column, no new eligibility branch, and
critically, no change to any of those three functions.

**The computation** (entirely inside `apply_routine_template`, server-side):

```sql
v_target_date := p_start_date + v_start_offset;                          -- pure date arithmetic, zero DST exposure
v_reminder_instant := (v_target_date::timestamp) at time zone v_participant.timezone;  -- participant-local midnight -> UTC instant
insert into public.reminders (..., created_at, updated_at)
values (..., v_reminder_instant, v_reminder_instant);
```

- `p_start_date + v_start_offset` is `date + integer` arithmetic. A
  Postgres `date` has no time-zone component at all, so this step cannot
  be affected by DST in any way — offsetting by 4 calendar days always
  produces "4 days later," full stop, regardless of what wall-clock
  transitions happen to fall in between.
- `(v_target_date::timestamp) at time zone v_participant.timezone`
  converts that calendar date's local midnight into a concrete instant
  using the **participant's own stored timezone** (never the organizer's
  device, never a hardcoded zone) — the identical `at time zone` pattern
  `claim_due_recipient_reminder_deliveries`'s own `scheduled_for`
  computation already uses. Postgres's `AT TIME ZONE` conversion is
  DST-aware by construction, so the resulting instant always lands on the
  intended calendar date when re-interpreted back in that same zone —
  verified directly against both 2026 US DST transitions (spring-forward
  `2026-03-08`, fall-back `2026-11-01`) and a non-DST zone
  (`America/Phoenix`).
- Setting `created_at` (and `updated_at`, kept equal to it so a
  future-dated row never has `updated_at < created_at`) to this instant is
  **sufficient on its own** to make the offset authoritative everywhere a
  reminder's eligibility is already checked: no push is claimed, no
  response is accepted, and no missed-detection fires before the target
  date, because all three of those functions already compare against
  `created_at` and none of them needed to change.

**Validation**: `start_offset_days` must be a non-negative integer, capped
at **90 days** (`MAX_REMINDER_START_OFFSET_DAYS` in `lib/routineCore.ts`,
mirrored server-side) — a negative offset is rejected outright
(`invalid_start_offset`; there is no supported concept of a reminder
starting before the routine's own chosen start date), and both bounds are
enforced independently in `_insert_routine_template_item` (template save
time) and `apply_routine_template` (apply time), never trusting the
client-side check in `lib/routineCore.ts#validateApplyItems` alone.

**Preview accuracy**: `app/routine-preview.tsx` computes the same display
date via pure calendar-date arithmetic
(`addDaysToDateString(startDate, offset)`) purely for the "Starts {date}"
label — this can never disagree with what the server independently
computes, because both derive from the identical deterministic
`start_date + offset` operation; only the *conversion of that date into an
instant* involves a time zone, and that step happens exclusively
server-side, never duplicated client-side.

**Task start offsets are completely unaffected** by any of this — they
still resolve to an absolute `start_date` client-side and are validated by
`_create_task_core` exactly as before this fix.

## Validation order and stable errors

Every failure mode raises a stable, lowercase-snake-case exception (never
a raw Postgres constraint-violation string), in this order:
`authentication_required` → `invalid_apply_request_id` → `invalid_title` →
`invalid_start_date` → `invalid_source` → `invalid_item_count` → (idempotent
replay short-circuit) → `not_authorized`/`organizer_role_required` →
`connection_inactive` → `participant_timezone_unavailable` →
`template_not_found`/`template_archived`/`template_revision_changed` →
per-item validation during the create loop. The client (`app/
routine-preview.tsx`) maps a handful of the most actionable codes to
friendly copy and falls back to a generic error otherwise.

## Routine-instance schema

```
routine_instances
  id, organizer_id (-> profiles), participant_id (-> profiles),
  connection_id (-> connections), title,
  source_template_id (-> routine_templates, ON DELETE SET NULL) | built_in_pack_id,
  source_version, participant_timezone_snapshot, start_date,
  status ('active'|'archived'), apply_request_id,
  created_at, archived_at, updated_at
  unique (organizer_id, apply_request_id)

routine_instance_items
  id, routine_instance_id, source_item_key, item_kind,
  reminder_id | task_id, display_order, created_at
  unique (reminder_id) where reminder_id is not null
  unique (task_id) where task_id is not null
```

`source_template_id`/`built_in_pack_id` used to be constrained so exactly
one was non-null at *all times* — a real bug (found by
`scripts/routine-audit/run.ts` scenario BG, fixed in migration
`20260730020000`) since `ON DELETE SET NULL` firing for a personal-template
instance made the row become `(null, null)`, which the original constraint
rejected. The corrected constraint only forbids *both* being set
simultaneously — "neither set" is the expected, harmless state once a
source template is deleted; the `title` snapshot plus `source_version`
keep the instance understandable regardless.

Each `reminder_id`/`task_id` can belong to **at most one** routine instance
ever — enforced by partial unique indexes, not just application
convention. Member links are never reassigned; there is no RPC that
updates a `routine_instance_items` row's `reminder_id`/`task_id` after
creation.

## Ended connections, archived instances, no duplicate creation

- A pending (not-yet-accepted) or ended connection rejects apply with
  `connection_inactive` (scenarios V/W) — matches `create_task`'s existing
  connection-status check exactly.
- An organizer can never apply against a connection they don't organize
  (`X`) — `v_connection.caregiver_id <> v_organizer_id` fails the same
  check.
- No duplicate `routine_instances` row is ever produced by repeated
  identical requests, in sequence or concurrently — see "Idempotency and
  concurrency" above.

## Query-plan notes

Every read this feature performs is either a primary-key lookup or an
indexed equality/range scan: `idx_routine_instances_connection`
`(connection_id, status)`, `idx_routine_instances_participant`
`(participant_id, status)`, `idx_routine_instances_organizer`
`(organizer_id, status)`, and `idx_routine_instance_items_instance`
`(routine_instance_id, display_order)` cover the Routine Library, Routine
Details, and apply-time reads without a sequential scan at any realistic
per-organizer/per-participant data volume.
