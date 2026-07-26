import { supabase } from '@/lib/supabase';
import {
    summarizeTask,
    TaskFrequency,
    TaskOccurrenceLike,
    TaskScheduleLike,
    TASK_LOOKBACK_DAYS,
} from '@/lib/taskLifecycle';
import { getZonedTodayString } from '@/lib/zonedTime';
import { addDaysToDateString, todayDateString } from '@/components/DatePickerField';

export type TaskRow = TaskScheduleLike & {
    id: string;
    connection_id: string;
    caregiver_id: string;
    recipient_id: string;
    title: string;
    notes: string | null;
    frequency: TaskFrequency;
    created_at: string;
};

export type TaskWithSummary = {
    task: TaskRow;
    summary: ReturnType<typeof summarizeTask>;
    /** Only populated by fetchTasksForRecipient (participant's own multi-organizer view). */
    organizerName?: string;
};

const TASK_COLUMNS = 'id, connection_id, caregiver_id, recipient_id, title, notes, frequency, days_of_week, start_date, due_date, recurrence_end_date, is_active, created_at';

async function summarizeRows(taskRows: TaskRow[], recipientTimeZone: string): Promise<TaskWithSummary[]> {
    if (taskRows.length === 0) return [];
    const today = getZonedTodayString(recipientTimeZone || 'America/New_York');
    const windowStart = addDaysToDateString(today, -TASK_LOOKBACK_DAYS);

    const { data: occRows, error: occError } = await supabase
        .from('task_occurrences')
        .select('task_id, occurrence_date, status')
        .in('task_id', taskRows.map((t) => t.id))
        .gte('occurrence_date', windowStart);

    if (occError) throw occError;

    const occByTask = new Map<string, TaskOccurrenceLike[]>();
    for (const row of (occRows ?? []) as { task_id: string; occurrence_date: string; status: TaskOccurrenceLike['status'] }[]) {
        const list = occByTask.get(row.task_id) ?? [];
        list.push({ occurrence_date: row.occurrence_date, status: row.status });
        occByTask.set(row.task_id, list);
    }

    return taskRows.map((task) => ({
        task,
        summary: summarizeTask(task, occByTask.get(task.id) ?? [], today),
    }));
}

/**
 * Organizer view: every task for one connection (active + archived, caller
 * filters) plus enough occurrence history (bounded to TASK_LOOKBACK_DAYS,
 * matching lib/taskLifecycle.ts's own bound) to compute an accurate summary
 * for each — one round trip for tasks, one for occurrences, never N+1 per
 * task.
 */
export async function fetchTasksWithSummaries(connectionId: string, recipientTimeZone: string): Promise<TaskWithSummary[]> {
    const { data: tasks, error: tasksError } = await supabase
        .from('tasks')
        .select(TASK_COLUMNS)
        .eq('connection_id', connectionId)
        .order('created_at', { ascending: false });

    if (tasksError) throw tasksError;
    return summarizeRows((tasks ?? []) as TaskRow[], recipientTimeZone);
}

/**
 * Participant view: every task assigned to this recipient across ALL of
 * their organizers/connections (mirrors how recipient-dashboard.tsx already
 * aggregates reminders across multiple accepted connections, rather than
 * scoping to a single one) — includes each organizer's name so multiple
 * organizers remain distinguishable in the UI.
 */
export async function fetchTasksForRecipient(recipientId: string, recipientTimeZone: string): Promise<TaskWithSummary[]> {
    const { data: tasks, error: tasksError } = await supabase
        .from('tasks')
        .select(TASK_COLUMNS)
        .eq('recipient_id', recipientId)
        .order('created_at', { ascending: false });

    if (tasksError) throw tasksError;
    const taskRows = (tasks ?? []) as TaskRow[];
    const summarized = await summarizeRows(taskRows, recipientTimeZone);

    const caregiverIds = [...new Set(taskRows.map((t) => t.caregiver_id))];
    if (caregiverIds.length === 0) return summarized;

    const { data: organizers } = await supabase.from('profiles').select('id, full_name').in('id', caregiverIds);
    const nameById = new Map((organizers ?? []).map((p) => [p.id, p.full_name]));

    return summarized.map((row) => ({ ...row, organizerName: nameById.get(row.task.caregiver_id) ?? undefined }));
}

export { todayDateString };
