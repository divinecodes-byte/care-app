# Activity Feed Model

Week 3 product-expansion task #2. A single, cross-object (reminder + task),
chronological, cursor-paginated activity timeline — for the organizer
viewing their selected participant, and for the participant viewing their
own history across every organizer.

## Source-of-truth decision: no new event table

`reminder_logs` and `task_occurrences` already are reliable, timestamped
historical-outcome ledgers:

- **`task_occurrences` is fully immutable after insert** — a database
  trigger (`prevent_task_occurrence_mutation`, from Week 3 task #1)
  rejects any `UPDATE` outright. All three of its statuses
  (`completed_on_time`/`completed_late`/`skipped`) are safe to show
  forever.
- **`reminder_logs` has exactly three *terminal* statuses**
  (`taken`/`skipped`/`missed`), confirmed by reading
  `sync_missed_reminders_db()`: its upsert's
  `on conflict ... where status in ('pending', 'snoozed')` guard means
  `missed` can only ever be written fresh, or override a still-open
  `snoozed` row — **never** taken/skipped/missed. Combined with
  `respond_to_reminder_occurrence`'s own `already_answered` guard (which
  rejects any further mutation once taken/skipped is set), all three
  terminal statuses are provably immutable once written.

Since both ledgers already have this property, two new read-only
`SECURITY DEFINER` SQL functions (`UNION ALL` over both tables) are
sufficient. No cron, no background job, no new persisted log — see
`supabase/migrations/20260729000000_activity_feed.sql`'s header comment
for the full reasoning.

## The snooze-event decision

`reminder_logs.status = 'snoozed'` is the **one mutable, non-terminal**
status — a snooze is a live *current-state* transition, not a durable
event: the same row is later overwritten with the eventual
taken/skipped/missed outcome, and the snooze itself is not recoverable
once that happens. **Snooze is therefore excluded from the activity
timeline** (both `get_connection_activity_feed` and
`get_participant_activity_feed` filter to `status in ('taken', 'skipped',
'missed')` only) but remains visible in the participant's Today hub as
live current state — see `docs/today-hub-model.md`.

## Server functions

Both are `SECURITY DEFINER`, `stable`, fixed `search_path`, explicit
grants to `authenticated` only (revoked from `public`/`anon`):

**`get_connection_activity_feed(p_connection_id, p_before_timestamp,
p_before_source, p_before_id, p_limit, p_source_filter)`** — one
connection's activity, usable by either party (organizer viewing their
selected participant, or a participant viewing one specific connection).
Authorization: caller must be the `caregiver_id` or `recipient_id` of
`p_connection_id` — checked server-side on every call, never trusted from
the client. Deliberately does **not** gate on connection status: a
connection the caller explicitly selected (including an ended one) still
returns its history, mirroring `task_analytics_summary`'s existing
precedent.

**`get_participant_activity_feed(p_before_timestamp, p_before_source,
p_before_id, p_limit, p_source_filter)`** — the *calling* participant's own
activity aggregated across every organizer they have ever connected to.
`auth.uid()` is the sole scope; there is no `connection_id` parameter, so
there is nothing for a caller to manipulate into reading another
participant's data.

Both revoke all privileges from `public`/`anon` and grant `execute` to
`authenticated` only; `p_limit` is clamped server-side to `[1, 50]`
regardless of what the client requests.

## Normalized display model

`lib/activityFeedCore.ts` — pure, zero react-native import. `ActivityRow`
(raw RPC row) → `normalizeActivityRow()` → `ActivityEvent` (display-ready,
with a pre-built full-sentence `accessibleSummary` for screen readers).
`activityEventKey()` combines `sourceKind` + `occurrenceId`, so a reminder
and a task can never collide even if their raw UUIDs coincided (verified
in `scripts/activity-audit/run.ts` scenario Z). `mergeActivityPages()`
de-duplicates by that same key as a defense-in-depth guard against a page
ever being re-appended.

## Cursor pagination

Deterministic keyset pagination: `(event_timestamp, source_kind,
source_id)` compared as a row tuple, `ORDER BY event_timestamp DESC,
source_kind DESC, source_id DESC`, `WHERE (...) < (p_before_timestamp,
p_before_source, p_before_id)`. `event_timestamp` is each row's own
`updated_at` — accurate for both ledgers since both are immutable/terminal
once written. Page size defaults to 20 (client `PAGE_SIZE` constant),
clamped server-side to 50. No offset pagination (mutable feeds + offset
pagination would risk skipped/duplicated rows as new events arrive between
pages) — verified duplicate-free and gap-free across pages in scenarios
AA-AE.

## Organizer/participant display context

Every event carries `organizer_name` (the connection's caregiver's
`full_name`) plus, as of
`20260801040000_activity_feed_organizer_deleted_state.sql` (Week 4
launch-hardening task #2), `organizer_account_status`/`organizer_deleted_at`.
Both `get_connection_activity_feed` and `get_participant_activity_feed`
originally returned only `organizer_name`, and a `null` value there is
genuinely ambiguous — it means either "this organizer was deleted" **or**
"this organizer is active and simply never set a `full_name`." The two
functions' return type changed (an added OUT column, not just a body edit)
so they had to be `DROP`ped and recreated rather than `CREATE OR REPLACE`d;
grants were re-verified identical afterward (`authenticated` + `postgres`
only). `lib/activityFeedCore.ts#normalizeActivityRow()` now resolves the
correct label from these explicit fields — `formerOrganizer` only when
`organizer_account_status = 'deleted'` or `organizer_deleted_at` is set,
`unavailableOrganizer` for a merely-unnamed active organizer — mirroring
`lib/organizerDisplay.ts#resolveOrganizerDisplay()`'s identical rule for
reminders/tasks. See `docs/multiple-organizer-model.md` for the full
three-way resolution contract. The participant's own aggregate feed
additionally distinguishes multiple organizers per event (verified scenario
N), since a participant may see events from more than one organizer
interleaved by time, and Week 4 Task #2's audit re-confirms this never
merges or cross-attributes across organizers
(`scripts/multi-organizer-audit/run.ts` scenario Q).

## Activity display timezone (correctness follow-up)

Confirmed, not changed: neither `get_connection_activity_feed` nor
`get_participant_activity_feed` accepts a timezone parameter, and neither
needs one. `event_timestamp` (each row's `updated_at`) is used exclusively
as an opaque cursor-ordering value — it is never formatted or displayed
anywhere in the UI. The only date ever rendered is `occurrence_date`, a
plain calendar date (`date` column, no time component) — which is
timezone-*unambiguous* by construction: "2026-07-27" reads the same
regardless of the viewer's timezone, since there is no wall-clock instant
being converted. `app/activity.tsx` and `components/ActivityPreviewCard.tsx`
were audited directly (`scripts/activity-audit/run.ts` scenario TZ-R) to
confirm they only ever call `formatDateStringForDisplay(event.occurrenceDate)`
and never format `event.eventTimestamp` or call a bare
`toLocaleDateString()`/`toLocaleTimeString()` (both of which would
implicitly use the *viewing device's* timezone). Because of this, "which
timezone displays an activity event" was never actually a live bug surface
— cursor stability across a display-timezone change (scenario TZ-Q) is
structurally guaranteed by the same fact: there is no timezone input to
the pagination functions at all, so there is nothing for a changed display
preference to feed into.

## Ended-connection history policy

Explicitly available, by design: `get_connection_activity_feed` performs
no connection-status check beyond authorization. Once a caller has
legitimately selected a connection (accepted or ended), their own
historical activity for it remains visible — the same policy already
established for `task_analytics_summary` and reminder/task history
screens. Ending a connection stops *future* activity, never erases past
activity.

## Tombstone / deleted-account behavior

`profiles.full_name` is scrubbed to `null` on account deletion (existing
anonymization model, unchanged), alongside `account_status = 'deleted'` and
`deleted_at`. The activity functions return `full_name` plus those two
explicit state fields; the client resolves `activityFeed.formerOrganizer`
only when the explicit deleted-state fields say so (never inferred from a
bare `null` name — see "Organizer/participant display context" above) and
`activityFeed.formerParticipant` the same way for the connection-scoped
view's participant side. Never the old name, email, or a raw ID.

## Refresh strategy

No polling. The Activity screen loads its first page on mount; pull-based
navigation (opening the screen, or the dashboard's bounded reminder/task
refresh triggers) is the only way it re-fetches — consistent with this
codebase's conservative, non-aggressive refresh philosophy elsewhere.

## Unaffected by the Week 4 Task #3 overdue-history rework

`get_connection_activity_feed`/`get_participant_activity_feed` read
`task_occurrences` directly (terminal rows only) and have zero dependency
on the removed `TASK_LOOKBACK_DAYS` bound or on `task_schedule_versions` —
a task occurrence's activity entry is unaffected by which schedule version
happened to govern its eligibility. Old overdue occurrences resolved via
the new `/overdue-tasks` screen appear in Activity exactly like any other
response, with no special-casing required (verified directly:
`scripts/task-overdue-audit/run.ts` scenario AS).

## Activity vs. analytics contract

See `docs/activity-feed-security.md` for the full, explicit contract —
short version: activity is chronological individual outcomes; analytics
(`task_analytics_summary`, the existing reminder-adherence queries) are
separate aggregate denominators. Activity pagination, filters, and
event count never feed into or alter any analytics calculation, and no
combined "success rate" spanning both objects was invented.

## Known limitations

- No "reminder created"/"task assigned"/"connection accepted" management
  events were added — only authoritative response *outcomes* are shown,
  per the instruction to only include management events if they add clear
  value with trustworthy timestamps; none were judged to clear that bar
  for this initial version.
- Filtering is server-side for source kind (`reminder`/`task`) but
  outcome filtering (completed/skipped/missed) is applied client-side
  after normalization, for simplicity — acceptable at current data volumes,
  documented as a candidate for server-side filtering if history grows
  very large.

## Weekend QA checklist

1. As an organizer, open the selected participant's activity — confirm
   both a reminder outcome and a task outcome appear, newest first.
2. Scroll to trigger a second page — confirm no duplicate or skipped
   events.
3. As a participant with two organizers, open "My Activity" — confirm
   both organizers' events appear, each correctly attributed.
4. End a connection, then reopen that connection's activity — confirm
   history is still visible.
5. Delete a test account that has activity history with a still-active
   counterpart — confirm the counterpart sees a calm generic label, not a
   raw ID or the old name.

## Rollback

`supabase/migrations/20260729000000_activity_feed.sql` is fully additive
(two new functions, four new indexes) — its own rollback section documents
the exact `DROP FUNCTION`/`DROP INDEX` statements. No existing table,
column, RLS policy, or reminder/task lifecycle function is altered.
