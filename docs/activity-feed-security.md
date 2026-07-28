# Activity Feed Security & Analytics Contract

Week 3 product-expansion task #2.

## Authorization model

| Caller | Function | Authorization check |
|---|---|---|
| Organizer viewing their selected participant | `get_connection_activity_feed(p_connection_id, ...)` | `auth.uid()` must equal the connection's `caregiver_id` or `recipient_id`, checked server-side against the actual `connections` row for `p_connection_id` — never inferred from client-supplied data. Raises `not_authorized` otherwise. |
| Participant viewing one specific connection | `get_connection_activity_feed(p_connection_id, ...)` | Identical check — a participant is also a valid party to the connection. |
| Participant viewing their own aggregate history | `get_participant_activity_feed(...)` | No `connection_id` parameter exists at all — every row is scoped to `recipient_id = auth.uid()` / `rl.recipient_id = auth.uid()` inside the function body. There is nothing for a caller to pass that would read another participant's data. |

Both functions are `SECURITY DEFINER` with `SET search_path = public,
extensions, pg_catalog` (fixed, non-empty — prevents search-path
hijacking), and both explicitly `REVOKE ALL ... FROM public, anon` before
`GRANT EXECUTE ... TO authenticated`.

Verified directly (`scripts/activity-audit/run.ts`):
- **X** — an unrelated organizer calling `get_connection_activity_feed`
  for a connection they don't belong to → `not_authorized`.
- **Y** — an unrelated participant, same result.
- **V** — a second organizer's client cannot read a different
  organizer's connection activity by any parameter combination.
- **AY** — a forged/arbitrary cursor (`p_before_timestamp`,
  `p_before_source`, `p_before_id`) passed by an unrelated caller still
  resolves to `not_authorized` — the authorization check runs *before*
  any cursor logic is evaluated, so cursor values can never be used to
  bypass it.
- **AP** — direct table `SELECT` continues to be governed by the existing
  RLS policies on `reminder_logs`/`task_occurrences` (unchanged by this
  task) — the new functions are an additional read path, not a
  replacement, and grant no new direct-table access.

## What is never returned

- Reminder or task **notes** — neither function selects a `notes` column
  from either source table (verified by reading the migration source
  directly in scenario AX; the functions physically cannot leak a value
  they never `SELECT`).
- **Push tokens** — not referenced by either function at all.
- **Emails** — not referenced; only `profiles.full_name` is joined in.
- **Raw internal status/database terminology** — outcome values
  (`taken`/`skipped`/`missed`/`completed_on_time`/`completed_late`) are
  the same normalized vocabulary already used elsewhere in the app, mapped
  to localized display labels client-side; never a raw Postgres error or
  internal code string reaches the UI.
- A tombstoned counterpart's prior name — `profiles.full_name` is already
  scrubbed to `null` on deletion (existing anonymization model); the
  functions simply return whatever is currently there, so a deleted
  organizer's or participant's row surfaces as `null`, rendered by the
  client as a calm generic label (verified scenario AW).

## RLS and existing mutation paths

No existing RLS policy on `reminders`, `reminder_logs`, `tasks`,
`task_occurrences`, `connections`, or `profiles` was modified, relaxed, or
bypassed by this task. `respond_to_reminder_occurrence`,
`update_reminder_schedule`, `create_task`, `update_task`, `archive_task`,
and `respond_to_task_occurrence` are all completely unchanged — the
activity functions are read-only and additive.

## Activity vs. analytics — the explicit contract

**Activity** (`get_connection_activity_feed` /
`get_participant_activity_feed`):
- Chronological, individual, authoritative *outcomes*.
- Cursor-paginated, bounded per page (max 50 rows).
- Answers "what happened, in order" — an operational/recent-history view.

**Analytics** (`task_analytics_summary`, existing reminder-adherence
queries):
- Aggregate calculations over a fixed time window.
- Answers "what fraction of eligible occurrences resolved a given way" —
  denominators, rates, percentages.

**These never cross-contaminate**:
- Activity event counts (e.g., "20 events on this page") are never used
  as an analytics denominator anywhere in this codebase.
- Task and reminder metrics remain fully separate — no combined
  "success rate" spanning both objects exists or was added.
- Activity's pagination, page size, or applied filters have zero effect
  on `task_analytics_summary`'s output — verified directly in scenarios
  AZ/BA (analytics queried before and after several activity-feed
  requests, including a filtered one, with identical results both times).
- A `completed_late` task outcome remains distinguishable from a
  `taken` reminder outcome in both the activity feed and analytics — the
  raw status strings are carried through unchanged end to end, never
  collapsed into one generic "done" concept.
- Editing a reminder's or task's title changes what a *future* activity
  read displays (the functions join `title` fresh each call, by design —
  see `docs/flexible-task-model.md`'s existing precedent for tasks), but
  never rewrites a historical outcome's identity: the row's
  `occurrence_id`, `outcome`, and `event_timestamp` are permanently fixed
  at the moment they were written, regardless of any later edit.

## Query performance

Both functions run a two-branch `UNION ALL` (`reminder_logs`/
`reminder_events`, `task_occurrences`/`task_events`) filtered by
`connection_id` or `recipient_id` and ordered by `updated_at`. Four new
indexes support exactly this access pattern:
`idx_reminder_logs_connection_updated`,
`idx_reminder_logs_recipient_updated`,
`idx_task_occurrences_connection_updated`,
`idx_task_occurrences_recipient_updated` (all `(scope_column,
updated_at DESC)`). No other index was added — no other query pattern is
introduced by this task. Expected volume per call is bounded by
`p_limit` (≤ 50 rows returned), and the underlying per-connection/per-
participant row counts are small at this project's current (pre-launch)
scale. No cron, no new delivery-health metric, and no background job were
added — Phase 20 explicitly asked that none be introduced merely to build
a timeline that can already be derived safely from existing tables.
