# Routine Template Model

Week 3 product-expansion task #3: reusable accountability blueprints —
curated Tavora Packs and an organizer's own personal templates — that can
be previewed, customized, and applied transactionally to a participant.
See `docs/routine-application-model.md` for how a template/pack actually
becomes real reminders and tasks, `docs/routine-notification-contract.md`
for the assignment-push behavior, and `docs/routine-security-model.md` for
the full authorization contract.

## Template vs. routine instance vs. built-in pack

These three concepts are deliberately kept distinct and are never merged:

- **Template** (`routine_templates` / `routine_template_items`): a
  reusable, participant-less, non-actionable blueprint. Has no completion
  state. Editing a template never alters anything previously created from
  it — see "Template/instance isolation" below.
- **Built-in Tavora Pack**: a curated, versioned, localized blueprint
  supplied by Tavora. **Not stored server-side at all** — see "Storage
  decision" below. Can be copied into a personal template (Phase 11) but
  cannot itself be edited; only the copy can be.
- **Routine instance** (`routine_instances` / `routine_instance_items`): a
  snapshot produced when a pack/template is *applied* to one participant.
  Pure metadata and grouping — it links to the real reminders/tasks that
  were created, and never becomes a second lifecycle authority. See
  `docs/routine-application-model.md`.

## Storage decision: built-in packs are a client catalog, not a table

`lib/routineCatalog.ts` is a plain, versioned TypeScript array
(`BUILT_IN_ROUTINE_PACKS`), zero react-native import, zero network/database
dependency. Reasoning:

- The full spec's hard constraints rule out a public marketplace/user
  submissions, so there is no need for server-side moderation, ratings, or
  dynamic catalog management — a static, code-reviewed, versioned array is
  the smallest correct architecture.
- **The server never trusts a pack's identity for authorization.**
  `apply_routine_template`'s `p_built_in_pack_id`/`p_built_in_pack_version`
  parameters are pure descriptive metadata stored on the resulting
  `routine_instances` row for display/debugging — every reminder/task
  field in the accompanying `p_items` payload is independently
  re-validated server-side regardless of what pack it claims to come from
  (see `routine-audit` scenario testing built-in-pack-metadata bypass
  resistance).
- Works fully offline (`scripts/routine-audit/run.ts` scenario BV): no
  query, no loading state, no cache invalidation needed for the catalog
  itself.
- A pack's `version` field lets a future content revision ship without
  ever mutating a `routine_instances` row already created from an earlier
  version — `source_version` is snapshotted at apply time.

Each pack item references **localized i18n keys**
(`routineCatalog.<pack>.<item>`), never hardcoded display text — see
`lib/i18n/locales/en.ts` / `es.ts`'s `routineCatalog` section. Both locale
files were verified complete for every pack/item key
(`scripts/routine-audit/run.ts` scenarios C/D).

## Personal templates: stored in Supabase, RLS-private, RPC-mutated

`routine_templates` / `routine_template_items` sync across an organizer's
own devices (a real Supabase table, not local-only storage) and are
private through **RLS SELECT-only** policies scoped to `owner_id =
auth.uid()`. All four mutation surfaces
(`create_routine_template`/`update_routine_template`/
`duplicate_routine_template`/`archive_routine_template`/
`restore_routine_template`/`delete_routine_template`) are SECURITY DEFINER
RPCs — there is **no INSERT/UPDATE/DELETE grant to `authenticated`** on
either table, so every mutation is forced through a named, auditable
operation (`scripts/routine-audit/run.ts` scenario BZ confirms a direct
client `insert`/`update` is rejected).

## Schema

```
routine_templates
  id, owner_id (-> profiles, cascade), title, description, use_case,
  status ('active'|'archived'), revision, created_at, updated_at

routine_template_items
  id, template_id (-> routine_templates, cascade), item_kind ('reminder'|'task'),
  display_order, title, notes, enabled_by_default,
  frequency, days_of_week, start_offset_days, due_offset_days,
  reminder_type, time_of_day, no_response_minutes,
  created_at, updated_at
```

**No completion or notification-delivery data is ever stored here** — a
template item has no status, no delivery ledger row, nothing that could
make it a second source of truth.

### Kind-specific field validation (defense in depth, not just a CHECK constraint)

`routine_template_items_kind_fields_check` enforces at the database level:

- A **reminder** item always has `time_of_day`, `reminder_type`, and
  `no_response_minutes` set, `frequency` in `('daily','weekdays','weekends',
  'custom')` with 1–7 valid `days_of_week`, and **never** a `due_offset_days`
  (reminders have no due-date concept at all).
- A **task** item never has `time_of_day`/`reminder_type`/
  `no_response_minutes` (no fake times, no snooze configuration — tasks
  don't have one). `frequency` may additionally be `'one_time'`, in which
  case `days_of_week` must be empty and `due_offset_days` (if present) must
  be `>= start_offset_days`; a recurring task item requires 1–7 valid
  `days_of_week` and forbids `due_offset_days` (matching the `tasks` table's
  own "recurring task cannot have a due date" invariant).

The RPC layer (`_insert_routine_template_item`, shared by
`create_routine_template`/`update_routine_template`/
`duplicate_routine_template`) re-validates every one of these rules
*before* the insert, raising a stable, friendly exception
(`invalid_frequency`, `reminder_requires_time_of_day`,
`task_cannot_have_time_of_day`, `due_offset_before_start_offset`,
`invalid_days_of_week`, …) rather than ever surfacing a raw Postgres
constraint-violation message — verified in `scripts/routine-audit/run.ts`
scenarios Q/R/S/T. `apply_routine_template` performs the identical
reminder-field validation independently for apply-time items (a follow-up
fix — see migration `20260730010000` — after `AN`'s live test revealed the
apply path's reminder branch had originally skipped this check, unlike its
task branch which already delegated to the fully-validating
`_create_task_core`).

Other invariants:

- `display_order` is unique per template (`routine_template_items_
  display_order_unique`) — deterministic ordering, enforced, not just
  convention.
- Ownership is immutable: no RPC accepts or trusts a client-supplied
  `owner_id`; every mutation re-derives it from `auth.uid()` and checks it
  against the existing row.
- Title ≤ 200 chars, description/notes ≤ 2000 chars, item count 1–20 per
  template (`invalid_item_count`) — the same bounds `apply_routine_template`
  enforces for the actual applied routine (see
  `docs/routine-application-model.md`).

## Relative date semantics

Template items store **offsets**, not absolute dates, so the same template
is reusable across any future apply — `start_offset_days` (days after
whatever start date the organizer eventually picks) and, for a one-time
task item only, `due_offset_days` (days after that same start date,
`>= start_offset_days`).

**Task items** resolve their offset into an absolute `start_date`/`due_date`
entirely client-side (`lib/routineCore.ts#resolveTemplateItemToApplyItem`,
pure calendar-date-string arithmetic — a `date` has no time zone component,
so this is unambiguous regardless of where the organizer's device is) and
send the already-concrete date to `apply_routine_template`, which only
validates it — exactly like `create_task`/`create-reminder.tsx` already
work.

**Reminder items are different, and were a real bug until migration
`20260731000000`.** Reminders have no start-date *column* at all — a
reminder's eligibility is governed entirely by `days_of_week` plus
`created_at` (the same mechanism `claim_due_recipient_reminder_deliveries`/
`sync_missed_reminders_db`/`respond_to_reminder_occurrence` already use —
see `docs/routine-application-model.md`'s "Reminder start offsets" section
for the full mechanism). The *original* implementation of this feature
accepted and stored a reminder item's `start_offset_days` (the schema, the
RPC validation, and the template-loading code all handled it) but the
apply-time resolver silently dropped it — a reminder created from a
template with e.g. `start_offset_days: 3` became active immediately instead
of three days later. This was a genuine "silently accepted and ignored
configuration" defect, not a documented simplification, and has been fixed:
`start_offset_days` is now threaded through as a raw integer to
`apply_routine_template`, which authoritatively converts it into the
reminder's `created_at` instant using the **participant's** stored
timezone (never the organizer's device, never the client). See
`docs/routine-application-model.md` for the full mechanism, DST
verification, and the documented 0–90-day safe range.

## Participant timezone authority

Applying a routine snapshots the participant's own `profiles.timezone` onto
`routine_instances.participant_timezone_snapshot` at apply time (for
debugging/display only — it is never re-derived or trusted as an
authoritative clock afterward). `apply_routine_template` rejects the whole
request with `participant_timezone_unavailable` if the participant's stored
timezone fails `_is_valid_iana_timezone` (the same Postgres
`AT TIME ZONE`-construction validation pattern already used elsewhere) —
never a hardcoded fallback, never the organizer's own device timezone. See
`docs/today-hub-model.md` for the broader participant-timezone-authority
contract this fits into.

## Template versus active-item isolation (Phase 14)

**Deliberately no two-way binding, in either direction:**

- Editing a personal template (`update_routine_template`) deletes and
  re-inserts its `routine_template_items` rows — it never touches any
  `routine_instance_items`/`reminders`/`tasks` row, because those link to
  concrete reminder/task IDs, never to template item rows at all.
  Verified live: `scripts/routine-audit/run.ts` scenario BE applies a
  routine, then changes the source template's item titles, then confirms
  the already-created reminder's title is untouched.
- Editing an active routine's member reminder/task (e.g.
  `update_reminder_schedule`) never touches the source template — verified
  live in scenario BF.
- Deleting a personal template (`delete_routine_template`, a deliberate
  hard delete — see below) never deletes or orphans any routine instance or
  its history — `routine_instances.source_template_id` uses `ON DELETE SET
  NULL`, confirmed live in scenario BG.

## Archive vs. hard delete (a deliberate choice)

- **Archive/restore** (`archive_routine_template`/`restore_routine_
  template`): idempotent status flip (`active` ⇄ `archived`). An archived
  template cannot be applied — `apply_routine_template` checks
  `v_template.status = 'active'` and raises `template_archived` otherwise
  (scenario L).
- **Hard delete** (`delete_routine_template`): templates carry **no shared
  participant history** (unlike reminders/tasks, which are never
  hard-deleted specifically because they carry a shared response ledger) —
  a template is purely the organizer's own reusable configuration, so
  removing it outright is safe and simpler than a soft-delete + retention
  policy. This is fully documented here per the spec's own instruction, and
  is safe *because* `routine_instances`/`routine_instance_items` never
  reference template item rows for anything beyond an optional descriptive
  `source_template_id` (`ON DELETE SET NULL`).

## Stale-revision protection

`routine_templates.revision` increments on every `update_routine_template`
call. `apply_routine_template` accepts an optional
`p_source_template_revision`; if supplied and it no longer matches the
template's current revision, the apply is rejected with
`template_revision_changed` rather than silently applying a payload the
organizer built against a since-changed template (scenario BU) — this is
what `app/routine-preview.tsx` passes through from the revision it loaded
the template at.

## Known limitations

- No reminder-side recurrence-end-date offset exists in the template
  schema (tasks already support `recurrence_end_date` via the existing
  `create_task`/`_create_task_core` path, but routine template items don't
  yet expose a way to set one for a recurring task member — every
  routine-created recurring task currently has `recurrence_end_date = null`,
  i.e. runs indefinitely, matching a freshly-created standalone recurring
  task's default).
- A reminder item's `start_offset_days` is authoritative as of migration
  `20260731000000` (see "Relative date semantics" above and
  `docs/routine-application-model.md`) — this is no longer a limitation,
  noted here only so a future reader doesn't need to check migration
  history to confirm it.
- None of the 8 launch built-in packs currently define a nonzero reminder
  `start_offset_days` (every pack reminder starts immediately) — the field
  exists on `BuiltInPackItem`'s reminder variant and flows through the
  identical code path a personal template uses, but no shipped pack
  exercises a nonzero value yet.
- `routine-preview.tsx` shows the calculated reminder start date as a
  read-only label when the offset is nonzero; there is no interactive
  control to *edit* a reminder's start offset in the preview screen (tasks
  have the same gap for their own start offset — this is symmetric, not a
  reminder-specific shortfall).
