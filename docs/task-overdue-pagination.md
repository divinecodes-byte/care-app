# Task overdue pagination

Week 4 launch-hardening task #3. The exact contract for
`get_participant_overdue_task_occurrences()` and the
`app/overdue-tasks.tsx` screen it powers. Companion to
`docs/task-overdue-occurrence-model.md` (the occurrence model) and
`docs/task-schedule-versioning.md` (the eligibility history it reads).

## RPC signature

```sql
get_participant_overdue_task_occurrences(
  p_before_date date default null,
  p_before_task_id uuid default null,
  p_limit int default 20
)
returns table(
  task_id uuid, occurrence_date date, due_date date, overdue_since_date date,
  connection_id uuid, caregiver_id uuid, title text, frequency text,
  organizer_full_name text, organizer_account_status text, organizer_deleted_at timestamptz,
  routine_instance_id uuid, has_more boolean
)
```

`auth.uid()`-derived participant, no caller-supplied ID. `SECURITY DEFINER`,
fixed `search_path`, `revoke all from public, anon` + `grant execute to
authenticated`.

## Cursor contract

Ordering: **`overdue_since_date DESC, task_id DESC`** — newest-overdue
first. Cursor: `(p_before_date, p_before_task_id)`, compared against
`(overdue_since_date, task_id)` via a strict row-value predicate. Exactly
one of the pair being non-null is rejected as `invalid_cursor` (both null =
first page; both non-null = resume). **This pair is sufficient for a fully
stateless resume** — every call is a complete, independent, deterministic
search bounded above by the cursor; there is no server-side session state
to lose or reconstruct. The client derives the next cursor from the
**last returned row's own** `overdue_since_date`/`task_id` — no separate
`next_cursor_*` columns exist, matching `get_participant_activity_feed`'s
already-proven convention.

## Page-limit contract

`p_limit is null` → default `20`. `p_limit < 1` or `p_limit > 50` →
`invalid_page_limit` (rejected outright, **never silently clamped** —
scenarios AC/AD).

## `has_more` is authoritative, never inferred

The function internally fetches `p_limit + 1` candidate rows and returns
exactly `p_limit`, stamping `has_more` (`true` iff the extra row was found)
on every returned row. The client must read this field — **never** infer
"more pages exist" from `rows.length === PAGE_SIZE`, which would falsely
flag an exact-final-page as having more (Correction 7 of the approved
plan).

## Bounded reverse-search algorithm (no arbitrary cutoff)

```
v_min_start := min(start_date) over the participant's own active tasks
v_upper := min(cursor date, today - 1)
loop while v_upper >= v_min_start:
    v_lower := max(v_upper - chunk_width + 1, v_min_start)
    -- one bounded candidate query over [v_lower, v_upper], LIMIT applied inline
    if collected >= p_limit + 1: stop
    v_upper := v_lower - 1        -- next iteration's window is strictly disjoint
    chunk_width := min(chunk_width * 2, 730)   -- geometric growth, capped per-iteration
```

- **Termination is derived from `v_min_start`** — a real, task-existence
  bound — never a hardcoded day/iteration count. `chunk_width`'s 730-day
  ceiling bounds the *cost of one iteration*, not how far back the search
  may go.
- Each iteration's `[v_lower, v_upper]` window is **strictly disjoint**
  from every prior iteration's — no date range is ever regenerated or
  rescanned (verified: `v_upper` for iteration *N+1* is exactly `v_lower -
  1` for iteration *N*).
- Recurring candidates come from `public._task_eligible_dates()` (the
  single shared SQL helper also used by `task_analytics_summary` and the
  summary RPCs — see `docs/task-schedule-versioning.md`), clamped to the
  governing schedule-version segment's own range. One-time candidates
  filter on the task's *current* `due_date` falling in the window.
- `(task_id, occurrence_date)` uniqueness across the whole result is
  structurally guaranteed by the schedule-version overlap-prevention
  trigger (no two segments can ever claim the same date for one task) —
  a defensive `distinct on` in the final `SELECT` is belt-and-suspenders.
- A `SET LOCAL statement_timeout = '5s'` is the **only** defensive guard
  against a genuine implementation bug — it fails the call outright as a
  real RPC error, never silently truncates a page.

## `app/overdue-tasks.tsx`

Participant-only, structurally cloned from `app/activity.tsx`'s
already-proven pagination pattern: `requestIdRef` stale-response guard,
`hasMore` state, a `loadingMore`/`loadMoreError` footer,
`ScreenLoadingState`/`ErrorState`/`OfflineBanner`/`EmptyState`,
`classifyScreenError` for offline detection. Reached from
`app/recipient-dashboard.tsx`'s bounded Today preview via "View all
overdue."

- Each card's **Complete/Skip** acts on that row's own `occurrence_date`
  (never `overdue_since_date`) — the exact occurrence the user is looking
  at, not whatever a card-level summary elsewhere considers "the"
  actionable date.
- On a successful response, only that one row is removed from the current
  page in place — no full refetch, cursor/page state otherwise untouched.
- Organizer attribution resolves via `lib/organizerDisplay.ts#resolveOrganizerDisplay()`
  from the raw `organizer_full_name`/`organizer_account_status`/
  `organizer_deleted_at` triple — never a pre-collapsed name (matches
  every other attribution surface fixed in Week 4 Task #2).
- A "Routine" pill renders when `routine_instance_id` is present, reusing
  the existing `routineDetails.heading` label.

## Today-hub bounded preview

`app/recipient-dashboard.tsx`'s overdue task bucket is capped at
`OVERDUE_PREVIEW_CAP = 5` (newest-overdue first, matching the pagination
RPC's own ordering), with a "View all overdue" link shown whenever any
overdue task exists — even at exactly the cap, since one task card can
hide many unresolved *occurrences* only the dedicated screen surfaces.
Today never loads an unbounded overdue lifetime on mount.

## Performance verification

`EXPLAIN ANALYZE` against synthetic multi-year, multi-task data (Phase 18
verification) confirms each iteration's candidate query only ever touches
its own disjoint chunk window, never the full task history. Live timing
(scenario AX): a 300-day-old daily task's complete overdue history pages
in well under a second in practice.

## `actionable_date` — exact, not approximate (post-launch correction)

`get_participant_task_summaries()`/`get_connection_task_summaries()`
(the card-level summary RPCs, `docs/task-overdue-occurrence-model.md`)
each return one `actionable_date` per task — the date a quick
Complete/Skip tap on a task **card** (`app/tasks.tsx`, `app/task-details.tsx`,
`app/recipient-dashboard.tsx`'s Today hub — all three send this value
directly to `respond_to_task_occurrence`) acts on. This must always be the
task's true *earliest* unresolved eligible occurrence, regardless of age —
never a newer occurrence substituted for convenience.

The original implementation searched a fixed `[today-180, today-1]`
window for the earliest unresolved date. This was documented as
"occasionally returns `null` for a genuinely ancient lone miss" — true,
but incomplete: if a task had an unresolved occurrence *older* than 180
days **and** a separate unresolved occurrence *within* the last 180 days,
the query silently returned the newer, in-window date — not `null`, a
wrong answer. A quick action would then complete/skip the wrong
occurrence while the genuinely older one remained unresolved and
unrepresented as "the" actionable date. `overdue_count` was never
affected (it's computed separately via the exact closed-form count) —
only which specific date a quick action targeted.

**Fixed in `20260801110000_exact_actionable_date.sql`** via
`public._task_earliest_unresolved_date(task_id, range_start, range_end)`:
a binary search over `eligible_count(range_start, d) -
resolved_count(range_start, d)`, which is non-decreasing in `d` (each day
either adds one unresolved occurrence, adds one resolved occurrence that
cancels out, or adds nothing) — so "the smallest `d` where this difference
is positive" converges in `O(log days)` iterations, each a single
closed-form call (`_task_closed_form_eligible_count`, already used for
`overdue_count`) plus one indexed range count against `task_occurrences`.
A task's age no longer matters: a 3-year-old task costs about the same as
a 3-day-old one (~11 iterations vs. ~2). The exact date is always
returned when `overdue_count > 0`; `null` only when it's genuinely 0 —
never an approximation, never a silently-wrong date.

Verified live before and after the fix, using a synthetic 300-day-old
daily task with unresolved occurrences deliberately placed at day-250 and
day-50 (everything else resolved): the old window-bounded query returned
day-50 (wrong); `_task_earliest_unresolved_date` correctly returns
day-250, in 5.6ms (`EXPLAIN ANALYZE`, live). See
`scripts/task-overdue-audit/run.ts` scenarios BP–BU for the permanent
regression coverage.
