import { isoWeekdayOfDateString } from '@/lib/reminderStatus';

// ─── Flexible-task lifecycle (pure, zero react-native import) ───────────────
// As of Week 4 Task #3, eligibility/overdue AUTHORITY for every real
// production surface lives server-side (public.task_schedule_versions +
// public._task_eligible_dates, consumed by respond_to_task_occurrence,
// task_analytics_summary, get_participant_task_summaries/
// get_connection_task_summaries, and get_participant_overdue_task_occurrences
// — see docs/task-overdue-occurrence-model.md). The functions below are
// pure, single-flat-schedule, non-schedule-version-aware helpers — safe for
// lightweight single-date hints (isTaskOccurrenceEligible/
// getComputedTaskStatus) and for lib/todayFeedCore.ts's pure composition
// model (enumerateBegunOccurrenceDates/summarizeTask, never invoked by
// production app code, only by scripts/activity-audit/run.ts's own
// synthetic-schedule test scenarios) — but NEVER authoritative for a real
// task whose schedule may have been edited. No production code path calls
// enumerateBegunOccurrenceDates/summarizeTask; if you're about to add one,
// use the server RPCs instead.
//
// Distinct from lib/reminderStatus.ts's DisplayReminderStatus on purpose:
// a task has no exact time, no snooze, and "overdue" is never terminal the
// way "missed" is — a separate type keeps the two lifecycles from being
// accidentally treated as interchangeable anywhere in the client.

export type TaskFrequency = 'one_time' | 'daily' | 'weekdays' | 'weekends' | 'custom';

export type TaskTerminalStatus = 'completed_on_time' | 'completed_late' | 'skipped';
export type TaskDisplayStatus = 'upcoming' | 'open' | 'overdue' | TaskTerminalStatus;

export type TaskScheduleLike = {
    frequency: TaskFrequency;
    days_of_week: number[];
    start_date: string; // "YYYY-MM-DD", participant-local calendar date
    due_date: string | null; // one_time only
    recurrence_end_date: string | null; // recurring only
    is_active: boolean;
};

export type TaskOccurrenceLike = {
    occurrence_date: string;
    status: TaskTerminalStatus;
};

/** Whether `dateString` is a legitimate occurrence date for this task's schedule — identical rule to respond_to_task_occurrence's server-side check, minus the "not in the future" rule (checked separately, since that depends on "today"). */
export function isTaskOccurrenceEligible(task: TaskScheduleLike, dateString: string): boolean {
    if (task.frequency === 'one_time') {
        return dateString === task.start_date;
    }
    if (dateString < task.start_date) return false;
    if (task.recurrence_end_date && dateString > task.recurrence_end_date) return false;
    return task.days_of_week.includes(isoWeekdayOfDateString(dateString));
}

/** The due date in effect for a specific occurrence — null means "no deadline." Recurring tasks always have one (their own occurrence date); one-time tasks may not. */
export function effectiveDueDateForOccurrence(task: TaskScheduleLike, occurrenceDateString: string): string | null {
    return task.frequency === 'one_time' ? task.due_date : occurrenceDateString;
}

/**
 * The display status for one specific occurrence. `occurrence` (a real
 * task_occurrences row) always wins when present — this function never
 * overrides a persisted terminal status.
 */
export function getComputedTaskStatus(
    task: TaskScheduleLike,
    occurrenceDateString: string,
    todayString: string,
    occurrence?: TaskOccurrenceLike
): TaskDisplayStatus {
    if (occurrence?.status) return occurrence.status;
    if (occurrenceDateString > todayString) return 'upcoming';
    const due = effectiveDueDateForOccurrence(task, occurrenceDateString);
    if (due !== null && todayString > due) return 'overdue';
    return 'open';
}

/**
 * Every eligible occurrence date that has already "begun" (start_date <=
 * today) under this ONE flat schedule — bounded only by `task.start_date`
 * itself (a real, task-existence-derived floor, never an arbitrary day
 * constant — see docs/task-overdue-occurrence-model.md for why this
 * function's previous fixed 60-day lookback bound was removed) and never
 * into the future (no eager generation). For a one-time task this is at
 * most a single date.
 *
 * NOT schedule-version-aware — this assumes ONE schedule applied for the
 * task's entire history, which is not authoritative for a task whose
 * frequency/days_of_week has ever changed (see
 * public.task_schedule_versions / public._task_eligible_dates for the real,
 * segment-aware server-side equivalent). Kept only because
 * lib/todayFeedCore.ts#buildTodayItems (exercised directly by
 * scripts/activity-audit/run.ts's own pure-composition test scenarios) is
 * never invoked by production app code — every real production surface
 * (lib/taskData.ts, app/task-details.tsx) calls the server-authoritative
 * get_participant_task_summaries/get_connection_task_summaries RPCs
 * instead, never this function.
 */
export function enumerateBegunOccurrenceDates(task: TaskScheduleLike, todayString: string): string[] {
    if (task.frequency === 'one_time') {
        return task.start_date <= todayString ? [task.start_date] : [];
    }

    const rangeStart = task.start_date;
    const rangeEndCandidates = [todayString, task.recurrence_end_date].filter((d): d is string => !!d);
    const rangeEnd = rangeEndCandidates.reduce((min, d) => (d < min ? d : min));

    if (rangeStart > rangeEnd) return [];

    const dates: string[] = [];
    let cursor = rangeStart;
    while (cursor <= rangeEnd) {
        if (task.days_of_week.includes(isoWeekdayOfDateString(cursor))) dates.push(cursor);
        cursor = addDaysToDateString(cursor, 1);
    }
    return dates;
}

function addDaysToDateString(dateString: string, days: number): string {
    const [y, m, d] = dateString.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + days));
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

export type TaskSummary = {
    /** The single headline status a task card shows. */
    status: TaskDisplayStatus;
    /** Count of distinct unresolved-and-overdue occurrence dates (recurring tasks can have more than one). */
    overdueCount: number;
    /** The earliest unresolved eligible date <= today — the date a Complete/Skip tap on the card acts on. Null if nothing is currently actionable (e.g. a fully-resolved one-time task, or a still-upcoming task). */
    actionableDate: string | null;
    /** For status='upcoming', the date it becomes open. */
    upcomingDate: string | null;
    /** Most recent terminal occurrence, if any (for "recently completed" display). */
    lastResolved: TaskOccurrenceLike | null;
};

/**
 * One task-level summary from its schedule + its known occurrences.
 * `occurrences` need only include rows relevant to this task (already
 * filtered by task_id by the caller) — this function does the date
 * matching itself.
 *
 * Non-authoritative (see module header) — matches the shape returned by
 * get_participant_task_summaries()/get_connection_task_summaries(), which
 * is what every real production surface uses instead of calling this.
 */
export function summarizeTask(
    task: TaskScheduleLike,
    occurrences: TaskOccurrenceLike[],
    todayString: string
): TaskSummary {
    const byDate = new Map(occurrences.map((o) => [o.occurrence_date, o]));
    const lastResolved = occurrences.length > 0
        ? [...occurrences].sort((a, b) => (a.occurrence_date < b.occurrence_date ? 1 : -1))[0]
        : null;

    if (task.frequency === 'one_time') {
        const occ = byDate.get(task.start_date);
        const status = getComputedTaskStatus(task, task.start_date, todayString, occ);
        return {
            status,
            overdueCount: status === 'overdue' ? 1 : 0,
            actionableDate: status === 'open' || status === 'overdue' ? task.start_date : null,
            upcomingDate: status === 'upcoming' ? task.start_date : null,
            lastResolved,
        };
    }

    const begunDates = enumerateBegunOccurrenceDates(task, todayString);
    const unresolved = begunDates.filter((d) => !byDate.has(d));
    const overdueDates = unresolved.filter((d) => todayString > d);
    const openDates = unresolved.filter((d) => todayString <= d);

    let status: TaskDisplayStatus;
    if (overdueDates.length > 0) status = 'overdue';
    else if (openDates.length > 0) status = 'open';
    else if (task.start_date > todayString) status = 'upcoming';
    else if (lastResolved) status = lastResolved.status;
    else status = 'open'; // recurrence window fully elapsed with nothing eligible and nothing resolved (edge case)

    const actionableDate = overdueDates[0] ?? openDates[0] ?? null;

    return {
        status,
        overdueCount: overdueDates.length,
        actionableDate,
        upcomingDate: status === 'upcoming' ? task.start_date : null,
        lastResolved,
    };
}
