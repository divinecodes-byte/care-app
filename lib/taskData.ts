import { supabase } from '@/lib/supabase';
import { TaskDisplayStatus, TaskFrequency, TaskOccurrenceLike, TaskTerminalStatus } from '@/lib/taskLifecycle';
import { OrganizerProfileForDisplay } from '@/lib/organizerDisplay';

export type TaskRow = {
    id: string;
    connection_id: string;
    caregiver_id: string;
    recipient_id: string;
    title: string;
    notes: string | null;
    frequency: TaskFrequency;
    days_of_week: number[];
    start_date: string;
    due_date: string | null;
    recurrence_end_date: string | null;
    is_active: boolean;
    created_at: string;
};

export type TaskSummary = {
    status: TaskDisplayStatus;
    overdueCount: number;
    actionableDate: string | null;
    upcomingDate: string | null;
    lastResolved: TaskOccurrenceLike | null;
};

export type TaskWithSummary = {
    task: TaskRow;
    summary: TaskSummary;
    /**
     * Only populated by fetchTasksForRecipient (participant's own
     * multi-organizer view) — the raw profile triple, never a pre-resolved
     * name. The caller resolves display text via
     * lib/organizerDisplay.ts#resolveOrganizerDisplay(), exactly like every
     * other attribution surface fixed in Week 4 Task #2 — a bare name here
     * would silently reintroduce the deleted-vs-merely-unnamed conflation
     * bug that fix eliminated everywhere else.
     */
    organizerProfile?: OrganizerProfileForDisplay;
};

const TASK_COLUMNS = 'id, connection_id, caregiver_id, recipient_id, title, notes, frequency, days_of_week, start_date, due_date, recurrence_end_date, is_active, created_at';

type SummaryRow = {
    task_id: string;
    status: TaskDisplayStatus;
    overdue_count: number;
    actionable_date: string | null;
    upcoming_date: string | null;
    last_resolved_date: string | null;
    last_resolved_status: TaskTerminalStatus | null;
    organizer_full_name?: string | null;
    organizer_account_status?: string | null;
    organizer_deleted_at?: string | null;
};

function toSummary(row: SummaryRow | undefined): TaskSummary {
    if (!row) {
        // No summary row means the task has no bounded-active-task match
        // server-side (shouldn't normally happen for a task the caller
        // already fetched) -- fail safe to a harmless "open, nothing
        // actionable yet known" shape rather than throwing.
        return { status: 'open', overdueCount: 0, actionableDate: null, upcomingDate: null, lastResolved: null };
    }
    return {
        status: row.status,
        overdueCount: row.overdue_count,
        actionableDate: row.actionable_date,
        upcomingDate: row.upcoming_date,
        lastResolved: row.last_resolved_date && row.last_resolved_status
            ? { occurrence_date: row.last_resolved_date, status: row.last_resolved_status }
            : null,
    };
}

/**
 * Organizer view: every task for one connection (active + archived, caller
 * filters) with a bounded, server-computed summary per task — one round
 * trip for tasks, one for summaries (get_connection_task_summaries),
 * never N+1 per task and never a client-side date-range scan (see
 * docs/task-overdue-occurrence-model.md).
 */
export async function fetchTasksWithSummaries(connectionId: string): Promise<TaskWithSummary[]> {
    const [{ data: tasks, error: tasksError }, { data: summaries, error: summaryError }] = await Promise.all([
        supabase
            .from('tasks')
            .select(TASK_COLUMNS)
            .eq('connection_id', connectionId)
            .order('created_at', { ascending: false }),
        supabase.rpc('get_connection_task_summaries', { p_connection_id: connectionId }),
    ]);

    if (tasksError) throw tasksError;
    if (summaryError) throw summaryError;

    const taskRows = (tasks ?? []) as TaskRow[];
    const summaryById = new Map(((summaries ?? []) as SummaryRow[]).map((s) => [s.task_id, s]));
    return taskRows.map((task) => ({ task, summary: toSummary(summaryById.get(task.id)) }));
}

/**
 * Participant view: every task assigned to this recipient across ALL of
 * their organizers/connections (mirrors how recipient-dashboard.tsx already
 * aggregates reminders across multiple accepted connections, rather than
 * scoping to a single one), with a bounded, server-computed summary per
 * task (get_participant_task_summaries) — includes each organizer's raw
 * profile fields so multiple organizers remain correctly distinguishable
 * and correctly attributed (deleted vs. merely-unnamed) in the UI.
 */
export async function fetchTasksForRecipient(recipientId: string): Promise<TaskWithSummary[]> {
    const [{ data: tasks, error: tasksError }, { data: summaries, error: summaryError }] = await Promise.all([
        supabase
            .from('tasks')
            .select(TASK_COLUMNS)
            .eq('recipient_id', recipientId)
            .order('created_at', { ascending: false }),
        supabase.rpc('get_participant_task_summaries'),
    ]);

    if (tasksError) throw tasksError;
    if (summaryError) throw summaryError;

    const taskRows = (tasks ?? []) as TaskRow[];
    const summaryById = new Map(((summaries ?? []) as SummaryRow[]).map((s) => [s.task_id, s]));

    return taskRows.map((task) => {
        const summaryRow = summaryById.get(task.id);
        return {
            task,
            summary: toSummary(summaryRow),
            organizerProfile: summaryRow
                ? { full_name: summaryRow.organizer_full_name ?? null, account_status: summaryRow.organizer_account_status ?? null, deleted_at: summaryRow.organizer_deleted_at ?? null }
                : undefined,
        };
    });
}
