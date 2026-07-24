import { supabase } from '@/lib/supabase';

// ─── Central recipient-response write path ───────────────────────────────────
// The only place in the client that submits a Taken/Skipped/Snoozed
// response — wraps the respond_to_reminder_occurrence RPC (SECURITY
// DEFINER; see the Week 1 task #7 migration), which validates ownership,
// reminder.is_active, connection.status, occurrence eligibility, and legal
// state transitions server-side, and serializes concurrent callers with a
// row lock. Nothing in the client performs a direct reminder_logs
// insert/update anymore — RLS no longer permits one.

export type RecipientResponseStatus = 'taken' | 'skipped' | 'snoozed';

export type ReminderLogRow = {
    id: string;
    reminder_id: string;
    connection_id: string;
    caregiver_id: string;
    recipient_id: string;
    occurrence_date: string;
    scheduled_for: string;
    status: 'pending' | 'taken' | 'snoozed' | 'skipped' | 'missed';
    completed_at: string | null;
    snoozed_until: string | null;
    created_at: string;
    updated_at: string;
};

/**
 * Stable, translatable error kinds for every way
 * respond_to_reminder_occurrence can fail — never surface the raw
 * Postgres exception text to a user (see lib/reminderErrors.ts for the
 * translated messages).
 */
export type ReminderLifecycleErrorKind =
    | 'already_answered'
    | 'reminder_inactive'
    | 'connection_inactive'
    | 'not_eligible'
    | 'not_authorized'
    | 'invalid_input'
    | 'network'
    | 'unexpected';

function classifyRpcError(message: string | undefined): ReminderLifecycleErrorKind {
    const m = (message ?? '').toLowerCase();
    if (m.includes('already_answered')) return 'already_answered';
    if (m.includes('reminder_inactive')) return 'reminder_inactive';
    if (m.includes('connection_inactive')) return 'connection_inactive';
    if (m.includes('not_eligible_today') || m.includes('not_eligible_yet')) return 'not_eligible';
    if (m.includes('not_authorized') || m.includes('reminder_not_found') || m.includes('authentication_required') || m.includes('profile_not_found')) return 'not_authorized';
    if (m.includes('network request failed') || m.includes('fetch failed') || m.includes('failed to fetch') || m.includes('timed out') || m.includes('timeout')) return 'network';
    return 'unexpected';
}

export type RespondResult =
    | { ok: true; log: ReminderLogRow }
    | { ok: false; kind: ReminderLifecycleErrorKind };

/**
 * Submit a recipient response (Taken/Skipped/Snoozed) for the given
 * reminder's current occurrence. occurrence_date is never supplied by the
 * caller — the server computes it from the recipient's own stored
 * timezone, which is what keeps this consistent with the server-side
 * delivery pipeline's occurrence identity (see
 * docs/reminder-state-model.md).
 */
export async function respondToReminderOccurrence(
    reminderId: string,
    status: RecipientResponseStatus,
    snoozeMinutes = 10
): Promise<RespondResult> {
    try {
        const { data, error } = await supabase.rpc('respond_to_reminder_occurrence', {
            p_reminder_id: reminderId,
            p_status: status,
            p_snooze_minutes: snoozeMinutes,
        });

        if (error) {
            console.warn('[reminderLifecycle] respond_to_reminder_occurrence failed:', error.message);
            return { ok: false, kind: classifyRpcError(error.message) };
        }

        return { ok: true, log: data as ReminderLogRow };
    } catch (err) {
        console.warn('[reminderLifecycle] respond_to_reminder_occurrence threw:', err);
        return { ok: false, kind: classifyRpcError(err instanceof Error ? err.message : String(err)) };
    }
}

// ─── Central reminder-edit write path ─────────────────────────────────────────
// The only place in the client that edits a reminder's title/schedule —
// wraps the update_reminder_schedule RPC (SECURITY DEFINER; see the Week 1
// task #8 migration), which updates the reminder and, in the SAME
// transaction, reconciles today's still-unsent delivery row in place
// (never a separate best-effort call, and never a delete-then-reclaim —
// see docs/reminder-editing-model.md). Supersedes the prior task's
// two-step update()-then-clear_stale_reminder_deliveries() flow.

export type ReminderRow = {
    id: string;
    connection_id: string;
    caregiver_id: string;
    recipient_id: string;
    title: string;
    reminder_type: string;
    notes: string | null;
    time_of_day: string;
    frequency: string;
    days_of_week: number[];
    no_response_minutes: number;
    is_active: boolean;
    schedule_version: number;
    created_at: string;
    updated_at: string;
};

export type UpdateReminderScheduleInput = {
    reminderId: string;
    title: string;
    reminderType: string;
    notes: string | null;
    timeOfDay: string;
    frequency: string;
    daysOfWeek: number[];
    noResponseMinutes: number;
};

export type UpdateScheduleResult =
    | { ok: true; reminder: ReminderRow }
    | { ok: false; kind: ReminderLifecycleErrorKind };

function classifyUpdateScheduleError(message: string | undefined): ReminderLifecycleErrorKind {
    const m = (message ?? '').toLowerCase();
    if (m.includes('reminder_inactive')) return 'reminder_inactive';
    if (m.includes('connection_inactive')) return 'connection_inactive';
    if (m.includes('not_authorized') || m.includes('authentication_required')) return 'not_authorized';
    if (m.includes('invalid_title') || m.includes('invalid_reminder_type') || m.includes('invalid_frequency') || m.includes('invalid_days_of_week') || m.includes('invalid_no_response_minutes')) return 'invalid_input';
    if (m.includes('network request failed') || m.includes('fetch failed') || m.includes('failed to fetch') || m.includes('timed out') || m.includes('timeout')) return 'network';
    return 'unexpected';
}

export async function updateReminderSchedule(input: UpdateReminderScheduleInput): Promise<UpdateScheduleResult> {
    try {
        const { data, error } = await supabase.rpc('update_reminder_schedule', {
            p_reminder_id: input.reminderId,
            p_title: input.title,
            p_reminder_type: input.reminderType,
            p_notes: input.notes,
            p_time_of_day: input.timeOfDay,
            p_frequency: input.frequency,
            p_days_of_week: input.daysOfWeek,
            p_no_response_minutes: input.noResponseMinutes,
        });

        if (error) {
            console.warn('[reminderLifecycle] update_reminder_schedule failed:', error.message);
            return { ok: false, kind: classifyUpdateScheduleError(error.message) };
        }

        return { ok: true, reminder: data as ReminderRow };
    } catch (err) {
        console.warn('[reminderLifecycle] update_reminder_schedule threw:', err);
        return { ok: false, kind: classifyUpdateScheduleError(err instanceof Error ? err.message : String(err)) };
    }
}
