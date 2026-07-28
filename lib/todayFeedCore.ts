import {
    DisplayReminderStatus,
    getZonedComputedStatus,
    isReminderEligibleOnZonedDate,
    ReminderScheduleLike,
} from '@/lib/reminderStatus';
import {
    summarizeTask,
    TaskOccurrenceLike,
    TaskScheduleLike,
    TaskDisplayStatus,
} from '@/lib/taskLifecycle';
import { zonedDateTimeToUtc } from '@/lib/zonedTime';
import { ParticipantTodayContext } from '@/lib/participantTodayContext';

// ─── Participant Today hub — pure, shared display model ──────────────────
// Zero react-native import (only lib/reminderStatus + lib/taskLifecycle,
// both pure) — importable directly by scripts/activity-audit/run.ts, same
// convention as every other *Core.ts module in this codebase.
//
// Deliberately does NOT rename/reinterpret either object's own statuses —
// DisplayReminderStatus and TaskDisplayStatus are carried through verbatim
// on each TodayItem; only the *sort group* is a new, purely presentational
// concept layered on top.

export type SourceKind = 'reminder' | 'task';

export type TodaySortGroup =
    | 'overdue_task'
    | 'reminder_actionable'
    | 'task_due_today'
    | 'task_open_no_deadline'
    | 'reminder_upcoming'
    | 'task_upcoming'
    | 'terminal_today';

/** How many days ahead an upcoming (not-yet-started) task is still worth showing on Today — prevents the far future from dominating the list. */
export const TASK_UPCOMING_LOOKAHEAD_DAYS = 3;

export type TodayAction = 'complete' | 'snooze' | 'skip';

export type TodayItem = {
    itemKind: SourceKind;
    itemId: string;
    /** Unique across BOTH kinds — `reminder:<id>:<date>` / `task:<id>:<date>` — never collides even if a reminder and a task share a raw UUID prefix by coincidence. */
    occurrenceKey: string;
    connectionId: string;
    organizerName?: string;
    title: string;
    occurrenceDate: string;
    scheduledTime?: string; // reminders only, "HH:MM"
    dueDate?: string | null; // tasks only
    displayStatus: DisplayReminderStatus | TaskDisplayStatus;
    isActionable: boolean;
    availableActions: TodayAction[];
    sortGroup: TodaySortGroup;
    sortValue: string;
    deepLink: { pathname: string; params: Record<string, string> };
};

export type TodayReminderInput = {
    id: string;
    connectionId: string;
    connectionAcceptedAt: string;
    organizerName?: string;
    title: string;
    schedule: ReminderScheduleLike;
    /** Today's log row, if one already exists (taken/skipped/missed/snoozed). */
    todayLog?: { status: DisplayReminderStatus; snoozedUntil?: string | null };
};

export type TodayTaskInput = {
    id: string;
    connectionId: string;
    organizerName?: string;
    title: string;
    schedule: TaskScheduleLike;
    /** Recent occurrences for this task (bounded lookback, matches lib/taskLifecycle.ts) — used to compute its current summary. */
    occurrences: TaskOccurrenceLike[];
};

function reminderActions(status: DisplayReminderStatus): TodayAction[] {
    if (status === 'pending' || status === 'snoozed') return ['complete', 'snooze', 'skip'];
    return [];
}

function taskActions(status: TaskDisplayStatus): TodayAction[] {
    if (status === 'open' || status === 'overdue') return ['complete', 'skip'];
    return [];
}

function reminderToTodayItem(input: TodayReminderInput, context: ParticipantTodayContext): TodayItem | null {
    const todayString = context.localDateKey;

    // Zoned throughout — no Date object is ever constructed from a
    // template-string or from device-local Y/M/D accessors here. Eligibility
    // and status are both computed purely from date STRINGS plus the
    // participant's explicit IANA timezone, exactly mirroring the
    // server-authoritative math in respond_to_reminder_occurrence /
    // sync_missed_reminders_db (see docs/reminder-state-model.md).
    if (!isReminderEligibleOnZonedDate(input.schedule, todayString, context.timezone, input.connectionAcceptedAt, !!input.todayLog)) {
        return null;
    }

    const status = getZonedComputedStatus(input.schedule, todayString, todayString, context.timezone, input.todayLog, context.nowInstant);
    const isTerminal = status === 'taken' || status === 'skipped' || status === 'missed';

    let sortGroup: TodaySortGroup;
    if (isTerminal) sortGroup = 'terminal_today';
    else {
        // 'pending' whose scheduled time has already passed today (still
        // inside its response window, or currently 'snoozed') is urgently
        // actionable; a 'pending' reminder later today is merely upcoming.
        // The scheduled instant is computed via zonedDateTimeToUtc (the
        // same DST-safe wall-clock -> absolute-instant conversion used
        // server-side) using the PARTICIPANT's timezone -- comparing it to
        // `context.nowInstant` is then safe regardless of device timezone,
        // since an absolute instant comparison needs no zone at all once
        // both sides are already resolved to real instants.
        const scheduledToday = zonedDateTimeToUtc(todayString, input.schedule.time_of_day, context.timezone);
        const hasStarted = status === 'snoozed' || context.nowInstant >= scheduledToday;
        sortGroup = hasStarted ? 'reminder_actionable' : 'reminder_upcoming';
    }

    return {
        itemKind: 'reminder',
        itemId: input.id,
        occurrenceKey: `reminder:${input.id}:${todayString}`,
        connectionId: input.connectionId,
        organizerName: input.organizerName,
        title: input.title,
        occurrenceDate: todayString,
        scheduledTime: input.schedule.time_of_day,
        displayStatus: status,
        isActionable: reminderActions(status).length > 0,
        availableActions: reminderActions(status),
        sortGroup,
        sortValue: isTerminal ? input.title : input.schedule.time_of_day,
        deepLink: { pathname: '/reminder-details', params: { reminderId: input.id, connectionId: input.connectionId } },
    };
}

function taskToTodayItem(input: TodayTaskInput, context: ParticipantTodayContext): TodayItem | null {
    const todayString = context.localDateKey;
    // summarizeTask is already pure calendar-date arithmetic with no clock
    // read of its own (see lib/taskLifecycle.ts) -- it only needs a
    // correctly participant-zoned `todayString`, which context.localDateKey
    // already is.
    const summary = summarizeTask(input.schedule, input.occurrences, todayString);

    if (summary.status === 'upcoming') {
        const daysAhead = dateDiffDays(todayString, input.schedule.start_date);
        if (daysAhead > TASK_UPCOMING_LOOKAHEAD_DAYS) return null; // far-future tasks never dominate Today
        return {
            itemKind: 'task',
            itemId: input.id,
            occurrenceKey: `task:${input.id}:${input.schedule.start_date}`,
            connectionId: input.connectionId,
            organizerName: input.organizerName,
            title: input.title,
            occurrenceDate: input.schedule.start_date,
            dueDate: input.schedule.frequency === 'one_time' ? input.schedule.due_date : input.schedule.start_date,
            displayStatus: summary.status,
            isActionable: false,
            availableActions: [],
            sortGroup: 'task_upcoming',
            sortValue: input.schedule.start_date,
            deepLink: { pathname: '/task-details', params: { taskId: input.id } },
        };
    }

    // Only surface a task on Today if it has a currently-actionable occurrence
    // (open/overdue) or resolved TODAY specifically (terminal_today) — a task
    // resolved on some earlier day has nothing to contribute to today's view.
    const relevantDate = summary.actionableDate ?? (summary.lastResolved?.occurrence_date === todayString ? todayString : null);
    if (!relevantDate) return null;

    const status = summary.actionableDate ? summary.status : summary.lastResolved!.status;
    const isTerminal = status === 'completed_on_time' || status === 'completed_late' || status === 'skipped';
    const dueDate = input.schedule.frequency === 'one_time' ? input.schedule.due_date : relevantDate;

    let sortGroup: TodaySortGroup;
    if (isTerminal) sortGroup = 'terminal_today';
    else if (status === 'overdue') sortGroup = 'overdue_task';
    else if (dueDate === todayString) sortGroup = 'task_due_today';
    else sortGroup = 'task_open_no_deadline';

    return {
        itemKind: 'task',
        itemId: input.id,
        occurrenceKey: `task:${input.id}:${relevantDate}`,
        connectionId: input.connectionId,
        organizerName: input.organizerName,
        title: input.title,
        occurrenceDate: relevantDate,
        dueDate,
        displayStatus: status,
        isActionable: taskActions(status as TaskDisplayStatus).length > 0,
        availableActions: taskActions(status as TaskDisplayStatus),
        sortGroup,
        sortValue: isTerminal ? input.title : (dueDate ?? input.title),
        deepLink: { pathname: '/task-details', params: { taskId: input.id } },
    };
}

function dateDiffDays(fromDateString: string, toDateString: string): number {
    const [fy, fm, fd] = fromDateString.split('-').map(Number);
    const [ty, tm, td] = toDateString.split('-').map(Number);
    const fromUtc = Date.UTC(fy, fm - 1, fd);
    const toUtc = Date.UTC(ty, tm - 1, td);
    return Math.round((toUtc - fromUtc) / 86400000);
}

const GROUP_ORDER: TodaySortGroup[] = [
    'overdue_task',
    'reminder_actionable',
    'task_due_today',
    'task_open_no_deadline',
    'reminder_upcoming',
    'task_upcoming',
    'terminal_today',
];

/**
 * Builds the full, sorted participant Today hierarchy from raw reminder and
 * task inputs. Fully pure and deterministic: every calendar-date and
 * absolute-instant input is explicit via `context` (built from
 * lib/participantTodayContext.ts) — there is no hidden `new Date()` or
 * device-timezone read anywhere in this module. The participant's stored
 * `profiles.timezone` (never the caller's own device timezone) must be the
 * source of `context.timezone`. See docs/today-hub-model.md.
 */
export function buildTodayItems(reminders: TodayReminderInput[], tasks: TodayTaskInput[], context: ParticipantTodayContext): TodayItem[] {
    const items: TodayItem[] = [];
    for (const r of reminders) {
        const item = reminderToTodayItem(r, context);
        if (item) items.push(item);
    }
    for (const t of tasks) {
        const item = taskToTodayItem(t, context);
        if (item) items.push(item);
    }

    return items.sort((a, b) => {
        const groupDiff = GROUP_ORDER.indexOf(a.sortGroup) - GROUP_ORDER.indexOf(b.sortGroup);
        if (groupDiff !== 0) return groupDiff;
        if (a.sortValue !== b.sortValue) return a.sortValue < b.sortValue ? -1 : 1;
        return a.occurrenceKey < b.occurrenceKey ? -1 : a.occurrenceKey > b.occurrenceKey ? 1 : 0;
    });
}

/** Actionable items only (groups 1-6) — what the primary Today list renders. */
export function actionableTodayItems(items: TodayItem[]): TodayItem[] {
    return items.filter((i) => i.sortGroup !== 'terminal_today');
}

/** Terminal-today items only (group 7) — the collapsed secondary section. */
export function terminalTodayItems(items: TodayItem[]): TodayItem[] {
    return items.filter((i) => i.sortGroup === 'terminal_today');
}
