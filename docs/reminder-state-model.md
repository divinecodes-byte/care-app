# Tavora reminder state model

The canonical definition of a reminder occurrence, its response lifecycle,
and the concurrency/authority rules that keep the database, both
dashboards, and server-side delivery in agreement. Companion to
`docs/reminder-analytics-model.md` (denominator/numerator definitions) and
`docs/operations-runbook.md` (delivery pipeline operations).

## Occurrence identity

A reminder **occurrence** is uniquely identified by:

```
(reminder_id, occurrence_date)
```

where `occurrence_date` is a calendar date in the **recipient's own stored
timezone** (`profiles.timezone`) — never the caregiver's timezone, never
the device's local clock, and never a client-supplied value. Every
server-side function that creates or resolves an occurrence
(`respond_to_reminder_occurrence`, `claim_due_recipient_reminder_deliveries`,
`claim_due_recipient_snooze_deliveries`, `sync_missed_reminders_db`)
computes `occurrence_date` the same way:

```sql
(now() at time zone p.timezone)::date
```

This is what makes the identity stable across a mid-day timezone change: a
recipient who travels but is still "today" in their newly-synced timezone
resolves to the same `occurrence_date` they'd have gotten before the
change, so a response already recorded is never duplicated (see
`reminder_logs_reminder_id_occurrence_date_key`, a hard `UNIQUE`
constraint — not just an application-level convention).

### The four related-but-distinct timestamps

| Field | What it means | Set by |
|---|---|---|
| `occurrence_date` | Which calendar day (recipient timezone) this occurrence belongs to | Computed once, at first write, never changed after |
| `scheduled_for` | The absolute moment (`timestamptz`) the *original* alert was due | Computed once, at first write, from the reminder's `time_of_day` on `occurrence_date`; preserved even if the occurrence is later snoozed |
| `snoozed_until` | The absolute moment a snooze re-alert is due | Set only while `status = 'snoozed'`; `null` otherwise (enforced by a `CHECK` constraint) |
| a delivery row's own timestamps (`sent_at`, `created_at`, `updated_at` on `reminder_notification_deliveries`) | When a *push* was claimed/sent — a separate, purely operational concern | The delivery pipeline (see `docs/notification-payload-contract.md`) |

`scheduled_for` on `reminder_logs` always reflects the **original**
occurrence time, even for a row that ends up `missed` via the snooze path
(see "Missed authority" below) — it is never overwritten with a snooze
deadline.

## Response state machine

States: `pending` (no row exists — there is no literal `'pending'`
`reminder_logs` row written by any current code path), `taken`, `skipped`,
`snoozed`, `missed`.

Allowed transitions, determined from the app's existing intended behavior
(action buttons remain visible/tappable for every non-`taken`/`skipped`
state, including `missed` — "late" response was already a supported,
intentional UI affordance before this task, not invented by it):

```
(no row)  -> taken | skipped | snoozed
pending   -> taken | skipped | snoozed          (a literal 'pending' row is only ever seen defensively)
snoozed   -> taken | skipped | snoozed (re-snooze, only after the current snoozed_until has passed)
missed    -> taken | skipped | snoozed          (late response — existing intended behavior)
taken     -> (terminal; identical resubmission is idempotent, anything else is rejected)
skipped   -> (terminal; identical resubmission is idempotent, anything else is rejected)
```

`missed` itself is never a client-submittable status — see "Missed
authority" below.

### The sole write path: `respond_to_reminder_occurrence`

Every recipient-initiated response (`taken`/`skipped`/`snoozed`) goes
through one `SECURITY DEFINER` RPC:

```sql
respond_to_reminder_occurrence(p_reminder_id uuid, p_status text, p_snooze_minutes int default 10)
returns reminder_logs
```

It validates, in order:
1. A session exists (`auth.uid()` is not null).
2. `p_status` is one of `taken`/`skipped`/`snoozed` (never `pending` or `missed`).
3. The reminder exists and belongs to the calling recipient (`reminder.recipient_id = auth.uid()`) — a client can never respond to someone else's reminder, and can never influence which row this resolves to via any client-supplied id beyond `p_reminder_id` itself.
4. The reminder is active (`is_active = true`).
5. The connection is `accepted` (not ended, not pending).
6. Today (in the recipient's timezone) is a scheduled day (`days_of_week`).
7. The occurrence's `scheduled_for` is not before `greatest(reminder.created_at, connection.accepted_at)` — the analytics-eligibility boundary (see `docs/reminder-analytics-model.md`) doubles as the response-eligibility boundary.
8. `now()` has actually reached `scheduled_for` (no responding to a future occurrence).

Then, holding a row lock (`for update`) on any existing log for this
occurrence:
- No row → insert fresh with the requested status.
- Existing row, same status requested → idempotent no-op (`taken`/`skipped`), or idempotent no-op for `snoozed` **only if the current snooze hasn't expired yet** (a double-tap on Snooze doesn't re-extend the deadline; a fresh Snooze tap after the previous one expired does).
- Existing row is `taken`/`skipped` and a *different* status is requested → rejected (`already_answered`).
- Otherwise (existing is `pending`/`missed`/an-expired-`snoozed`) → update to the new status. This is what makes late `taken`/`skipped` after `missed` work.

**What a client cannot do**, all enforced server-side, not just by
convention: respond to another recipient's reminder; change which
reminder/occurrence a log belongs to after it's created (see "Immutability"
below); forge eligibility for an occurrence that hasn't started yet or
existed before creation/acceptance; overwrite a `taken`/`skipped` row with
a conflicting status; respond after the connection has ended; respond to a
deactivated reminder.

### Immutability

A database trigger (`prevent_reminder_log_identity_change`) rejects any
`UPDATE` — from any caller, at any privilege level, including a future
`SECURITY DEFINER` function that might be added later — that changes
`reminder_id`, `occurrence_date`, `connection_id`, `caregiver_id`, or
`recipient_id` on an existing `reminder_logs` row. This is defense-in-depth
beyond the RPC's own logic, not a substitute for it.

Direct client `INSERT`/`UPDATE` on `reminder_logs` is not possible at all —
RLS has no policy granting either to `authenticated` (only `SELECT`
remains). `respond_to_reminder_occurrence` and `sync_missed_reminders_db`
are `SECURITY DEFINER`, so they bypass RLS entirely; nothing else can
write to this table.

## Concurrency rules

- **Row locking**: `respond_to_reminder_occurrence` takes `for share`
  locks on the `reminders` and `connections` rows it reads, and a
  `for update` lock on any existing `reminder_logs` row for the
  occurrence. This serializes it against a concurrent deactivation,
  connection-ending, or a second response/missed-sync for the same
  occurrence — whichever transaction acquires its lock first is fully
  visible to the other before it proceeds, eliminating the
  read-then-write race the original client-side `.upsert()` had.
- **First valid terminal action wins.** Two simultaneous different
  terminal responses: whichever commits first wins; the second sees the
  first's result and is rejected with `already_answered`.
- **Duplicate submissions are idempotent.** A double-tap or network retry
  of the exact same action never errors and never creates a second row.
- **A human response always wins over the missed-sync cron, regardless of
  which one's transaction happens to commit first** — not just "usually."
  This is a deterministic property of the transition rules, not a timing
  coincidence: `sync_missed_reminders_db`'s conflict guard only fires
  `WHERE status IN ('pending', 'snoozed')`, so if a human response commits
  first, the cron's update simply doesn't match. If the cron commits
  first (row becomes `missed`), the human response's own transition rule
  explicitly allows `missed -> taken/skipped/snoozed` as a late response —
  so the human response still succeeds afterward either way. Verified
  directly (not just reasoned about) in `scripts/reminder-audit/run.ts`
  scenarios O and P.
- **Caregiver-deactivate vs. recipient-response** (scenario Q) is a
  genuine two-actor race without a single deterministic winner — the `for
  share` lock guarantees no corruption (never a log row with an
  inconsistent connection/reminder state, never a crash), but which one
  "wins" depends on real timing. Both possible outcomes are valid: either
  the reminder ends up inactive with no log (the response was correctly
  rejected), or the reminder ends up inactive with a valid `taken` log
  (the response committed first, then the deactivation applied). The test
  suite asserts the invariant, not a specific winner.
- **Connection-ending vs. recipient-response** (scenario R) has no
  client-permitted path to end a connection outside account deletion, so
  this is verified as a sequenced (not literally concurrent) case — end
  the connection, then attempt a response, confirm rejection.

## Missed-detection authority

**Server-only**, as of this task. `sync_missed_reminders_db()` (`pg_cron`,
every 5 minutes) is the sole function that ever persists a `missed`
`reminder_logs` row. It was previously also written by two client
call sites (`recipient-dashboard.tsx`, `reminder-alert.tsx`) via a
read-then-write check that was not atomic with the actual write — removed
in this task. The client still *computes* a `missed` display status
instantly (same `lib/reminderStatus.ts` helpers as before), it just no
longer persists it — the eventual server-authoritative write happens
within 5 minutes and is what dashboards ultimately agree on.

`sync_missed_reminders_db()` covers two independent branches, unioned into
one idempotent upsert:
- **Original occurrences**: due (`scheduled_for + no_response_minutes` has
  passed) and not currently `snoozed` (explicitly excluded — see below).
- **Snoozed occurrences**: `snoozed_until + no_response_minutes` (the same
  per-reminder grace period, reused rather than adding a new field) has
  passed with no further response. This branch did not exist before this
  task — an unanswered snooze previously stayed `snoozed` forever with no
  transition to `missed` at all.

The exclusion of `snoozed` rows from the *original* branch is not
cosmetic: without it, the same `(reminder_id, occurrence_date)` key could
appear twice in one `INSERT`'s source rows once the snoozed branch existed
too, which Postgres rejects outright (`ON CONFLICT DO UPDATE command
cannot affect row a second time`).

`ON CONFLICT (reminder_id, occurrence_date) DO UPDATE ... WHERE status IN
('pending', 'snoozed')` is what guarantees a `taken`/`skipped`/`missed` row
is never touched by this function again.

## Snooze semantics

- Exactly one pending snooze deadline at a time — re-snoozing before the
  current one expires is idempotent (returns the existing row unchanged);
  re-snoozing after it expires legitimately sets a new deadline.
- The original occurrence never re-sends after a snooze — the delivery
  claim functions are keyed by `(reminder_id, occurrence_date,
  delivery_type)`, and `delivery_type = 'snooze'` is a distinct row from
  `delivery_type = 'reminder'`.
- No snooze delivery is ever claimed for a deactivated reminder or an
  ended connection — `claim_due_recipient_snooze_deliveries()` filters
  `reminder.is_active = true` and `connection.status = 'accepted'` exactly
  like the original-occurrence claim function.
- **Analytics treatment**: a `snoozed` occurrence that's still pending
  response counts as non-taken, non-eligible-for-adherence-numerator, same
  as `pending` — see `docs/reminder-analytics-model.md`. Once it resolves
  (`taken`/`skipped`/`missed`), it's counted under that resolved status,
  same as any other occurrence.

## Editing semantics

See **`docs/reminder-editing-model.md`** for the full detail (schedule
revision mechanism, current-day edit rules A-F, delivery-ledger
reconciliation) — Week 1 task #8 replaced the original two-step
client-orchestrated edit flow (`reminders` `UPDATE` followed by a separate
best-effort `clear_stale_reminder_deliveries()` call) with one atomic
`update_reminder_schedule()` RPC. Summary:

- Title/notes/type changes: affect current display and future
  notification content immediately; never touch `reminder_logs`, never
  bump `reminders.schedule_version`, never touch any delivery row.
- `time_of_day`/`days_of_week`/`no_response_minutes` changes: affect
  future/current-unresolved occurrences only, and atomically bump
  `reminders.schedule_version` + reconcile today's still-unsent delivery
  row (if any) **in place** — never a delete-then-reclaim, so the
  `UNIQUE(reminder_id, occurrence_date, delivery_type)` constraint is
  never at risk of blocking the corrected send. Historical `reminder_logs`
  rows are never rewritten by any edit — there is no code path that
  updates a resolved log's `scheduled_for` or any other field after the
  fact (the identity-immutability trigger also blocks that specific case,
  though the real protection is simply that no function ever attempts it).

## Deactivation and deletion semantics

- Deactivating a reminder (`is_active = false`) immediately excludes it
  from all three server authorities: `claim_due_recipient_reminder_deliveries`,
  `claim_due_recipient_snooze_deliveries`, and both branches of
  `sync_missed_reminders_db`. No future delivery, no future missed row —
  verified directly in scenarios U and V.
- Historical logs are never deleted when a reminder is deactivated —
  verified in scenario W.
- A deactivated reminder cannot be silently reactivated through an
  ordinary edit — `edit-reminder.tsx` never exposes an `is_active` toggle
  in its save path; reactivation (if ever added) would need its own
  explicit, deliberate feature.
- Ending a connection (currently only reachable via account deletion) is
  always accompanied, in the same transaction, by deactivating every
  reminder either party was involved in — see
  `delete_current_user_data()`. `respond_to_reminder_occurrence` and the
  invite RPCs (`create_invite_code`/`accept_invite_code`) additionally
  check `connection.status = 'accepted'` and `profiles.account_status =
  'active'` directly, so this holds even if that invariant were ever
  broken by a future code path.
- A deleted/tombstoned recipient's historical logs are preserved for the
  surviving caregiver — verified in scenario AC (unchanged from the
  account-deletion task; re-verified here in the reminder-lifecycle
  context).

## Known residual risks

- **Recipient's own device clock vs. stored profile timezone**: the
  recipient's own dashboard/alert screens (`recipient-dashboard.tsx`,
  `reminder-alert.tsx`) still compute their own instant display status
  from *their device's* local clock, not a fetched `profiles.timezone`
  round trip — intentional, per Week 1 task #8's own scope ("recipient
  device/current profile timezone, which should normally match"). A
  recipient whose device timezone has drifted from their stored profile
  timezone (traveled, hasn't synced) can briefly see a display that
  disagrees with the eventual server-authoritative value. **This is now
  the only remaining instance of this risk** — caregiver-facing screens
  (`caregiver-dashboard.tsx`, `reminder-details.tsx`) were fixed in task
  #8 to compute in the connected recipient's own stored timezone via
  `lib/zonedTime.ts`/the zoned variants in `lib/reminderStatus.ts`, never
  the viewing caregiver's device clock. See
  `docs/reminder-editing-model.md`'s "Recipient-timezone display
  authority" section for the full before/after.
- **Caregiver-deactivate vs. recipient-response** has no single
  deterministic winner (see "Concurrency rules" above) — by design, not a
  gap, but worth knowing when debugging a report of "I marked it taken
  but it shows inactive."
- **`update_reminder_schedule`'s reconciliation has a narrow timing gap**:
  a delivery claimed in the few seconds between an edit committing and a
  *different, still-in-flight* claim/send tick reading pre-edit state
  could in principle still process against a value that's about to be
  corrected — closed for the common case by the transaction combining the
  edit and reconciliation, and further closed by
  `validate_reminder_deliveries_for_send`'s independent
  immediately-before-send re-check (schedule_version and recomputed
  `scheduled_for`, both compared fresh at send time — see
  `docs/reminder-editing-model.md`). The remaining window is bounded to
  sub-second execution time of a single Postgres transaction, not the
  ~30-second cron-tick window the prior (task #7) design had.

## Operational recovery steps

- **A recipient reports a response "didn't save"**: check
  `select * from public.reminder_logs where reminder_id = '<uuid>' order by updated_at desc;`
  — if a row exists with the expected status, it saved; the likely cause
  is a stale client cache, not a lost write (the RPC either fully commits
  or raises a specific, logged error — there is no partial-write state).
- **A reminder shows different statuses on two screens**: confirm both
  are reading the same `reminder_logs` row (`select * from
  reminder_logs where reminder_id = '<uuid>' and occurrence_date =
  '<date>';`) rather than a client-computed display value — if the
  persisted row is consistent, this is the documented client-clock
  residual risk above, not a data bug.
- **Suspected missed-detection gap**: confirm `sync-missed-reminders-db`
  is still active and running via `scripts/ops-health/run.ts`, then
  manually run `select public.sync_missed_reminders_db();` via the CLI to
  force an immediate catch-up pass — always safe, always idempotent.
- **Never manually `UPDATE reminder_logs`** to fix a perceived bad state —
  the identity-immutability trigger will reject an identity-field change
  outright, and any status change should go through
  `respond_to_reminder_occurrence` (as the recipient) so the same
  eligibility/transition rules apply; a raw admin update bypasses the
  transition guarantees documented above.
