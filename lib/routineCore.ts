// ─── Routine template / apply core (pure, zero react-native import) ───────
// Week 3 product-expansion task #3. Shared by routine-library.tsx,
// routine-preview.tsx, routine-details.tsx, and scripts/routine-audit/run.ts
// (a plain Node/tsx script — this module must never import anything that
// transitively pulls in react-native, matching the established convention
// for every other lib/*Core.ts module in this codebase).
//
// This module owns exactly two things: (1) resolving a template/pack
// item's *relative* schedule (start_offset_days / due_offset_days) into a
// *concrete* schedule against an organizer-chosen start date, and (2)
// client-side validation mirroring the server's authoritative checks in
// apply_routine_template / create_routine_template (migration
// 20260730000000) — a defense-in-depth / better-UX layer, never the
// source of truth. The server independently re-validates every field
// regardless of what the client sends.

import { addParticipantCalendarDays } from '@/lib/participantTodayContext';

export const MAX_ROUTINE_ITEMS = 20;
export const MAX_ROUTINE_TITLE_LENGTH = 200;
export const MAX_ROUTINE_NOTES_LENGTH = 2000;
/**
 * Documented safe range for a reminder item's start_offset_days (see
 * migration 20260731000000 and docs/routine-template-model.md) — a
 * routine's reminder cannot be configured to start more than three months
 * out. Negative offsets are never valid (there is no supported concept of
 * a reminder starting before the routine's own chosen start date). Task
 * start-offset handling has no equivalent bound and is unaffected.
 */
export const MAX_REMINDER_START_OFFSET_DAYS = 90;

export type ReminderType = 'medication' | 'hydration' | 'appointment' | 'meal' | 'exercise' | 'other';
export type RoutineFrequency = 'daily' | 'weekdays' | 'weekends' | 'custom';
export type TaskFrequency = 'one_time' | RoutineFrequency;

export type RoutineTemplateItem =
    | {
          itemKind: 'reminder';
          title: string;
          notes: string | null;
          enabledByDefault: boolean;
          reminderType: ReminderType;
          timeOfDay: string; // 'HH:MM'
          frequency: RoutineFrequency;
          daysOfWeek: number[];
          noResponseMinutes: number;
          startOffsetDays: number;
      }
    | {
          itemKind: 'task';
          title: string;
          notes: string | null;
          enabledByDefault: boolean;
          frequency: TaskFrequency;
          daysOfWeek: number[];
          startOffsetDays: number;
          dueOffsetDays: number | null;
      };

export type ApplyReminderItem = {
    itemKind: 'reminder';
    sourceItemKey: string;
    title: string;
    notes: string | null;
    reminderType: ReminderType;
    timeOfDay: string;
    frequency: RoutineFrequency;
    daysOfWeek: number[];
    noResponseMinutes: number;
    /** Integer calendar-day offset from the routine's chosen start date — see MAX_REMINDER_START_OFFSET_DAYS. Sent to the server, which authoritatively computes the resulting instant via participant-local zoned arithmetic (never the client, never a device clock). */
    startOffsetDays: number;
    /** Display-only: the calendar date this offset resolves to, for the preview screen to show — pure calendar-date arithmetic, always exactly what the server independently computes from the same startOffsetDays. */
    startDate: string;
};

export type ApplyTaskItem = {
    itemKind: 'task';
    sourceItemKey: string;
    title: string;
    notes: string | null;
    frequency: TaskFrequency;
    daysOfWeek: number[];
    startDate: string; // 'YYYY-MM-DD'
    dueDate: string | null;
    recurrenceEndDate: string | null;
};

export type ApplyItem = ApplyReminderItem | ApplyTaskItem;

/**
 * Resolves one template/pack item's relative offsets into a concrete,
 * server-ready apply item. Reminders have no start_date column at all
 * (see docs/routine-template-model.md) — their eligibility is governed
 * entirely by days_of_week plus `created_at` (the same mechanism
 * claim_due_recipient_reminder_deliveries/sync_missed_reminders_db/
 * respond_to_reminder_occurrence already use). A nonzero startOffsetDays
 * is threaded straight through to the server as a raw integer —
 * apply_routine_template is what authoritatively turns it into the
 * reminder's created_at instant, using the *participant's* stored
 * timezone (never computed here, never a device clock). The `startDate`
 * field below is display-only, pure calendar-date arithmetic identical to
 * what the server independently derives from the same offset — safe to
 * show in the preview screen because the two can never disagree.
 */
export function resolveTemplateItemToApplyItem(
    item: RoutineTemplateItem,
    routineStartDate: string,
    sourceItemKey: string
): ApplyItem {
    if (item.itemKind === 'reminder') {
        return {
            itemKind: 'reminder',
            sourceItemKey,
            title: item.title,
            notes: item.notes,
            reminderType: item.reminderType,
            timeOfDay: item.timeOfDay,
            frequency: item.frequency,
            daysOfWeek: item.daysOfWeek,
            noResponseMinutes: item.noResponseMinutes,
            startOffsetDays: item.startOffsetDays,
            startDate: addParticipantCalendarDays(routineStartDate, item.startOffsetDays),
        };
    }
    const startDate = addParticipantCalendarDays(routineStartDate, item.startOffsetDays);
    const dueDate = item.frequency === 'one_time' && item.dueOffsetDays !== null
        ? addParticipantCalendarDays(routineStartDate, item.dueOffsetDays)
        : null;
    return {
        itemKind: 'task',
        sourceItemKey,
        title: item.title,
        notes: item.notes,
        frequency: item.frequency,
        daysOfWeek: item.frequency === 'one_time' ? [] : item.daysOfWeek,
        startDate,
        dueDate,
        recurrenceEndDate: null,
    };
}

export type ValidationResult = { ok: true } | { ok: false; error: string };

const VALID_DAYS = [1, 2, 3, 4, 5, 6, 7];

function isValidDaysOfWeek(days: number[]): boolean {
    return days.length >= 1 && days.length <= 7 && days.every((d) => VALID_DAYS.includes(d)) && new Set(days).size === days.length;
}

/**
 * Client-side pre-check mirroring apply_routine_template's authoritative
 * validation — used to disable/guard the Apply button synchronously and
 * give an immediate, friendly error before ever reaching the network.
 * Never trust this alone: the server independently re-validates every
 * field regardless of what passed here.
 */
export function validateApplyItems(items: ApplyItem[]): ValidationResult {
    if (items.length < 1) return { ok: false, error: 'no_enabled_items' };
    if (items.length > MAX_ROUTINE_ITEMS) return { ok: false, error: 'too_many_items' };

    for (const item of items) {
        const title = item.title.trim();
        if (title.length === 0 || title.length > MAX_ROUTINE_TITLE_LENGTH) {
            return { ok: false, error: 'invalid_item_title' };
        }
        if (item.notes !== null && item.notes.length > MAX_ROUTINE_NOTES_LENGTH) {
            return { ok: false, error: 'invalid_item_notes' };
        }

        if (item.itemKind === 'reminder') {
            if (!/^\d{2}:\d{2}$/.test(item.timeOfDay)) return { ok: false, error: 'reminder_requires_time_of_day' };
            if (!isValidDaysOfWeek(item.daysOfWeek)) return { ok: false, error: 'invalid_days_of_week' };
            if (item.noResponseMinutes < 1 || item.noResponseMinutes > 120) return { ok: false, error: 'invalid_no_response_minutes' };
            if (!Number.isInteger(item.startOffsetDays) || item.startOffsetDays < 0 || item.startOffsetDays > MAX_REMINDER_START_OFFSET_DAYS) {
                return { ok: false, error: 'invalid_start_offset' };
            }
        } else {
            if (item.frequency === 'one_time') {
                if (item.daysOfWeek.length !== 0) return { ok: false, error: 'one_time_task_cannot_have_days_of_week' };
                if (!item.dueDate) return { ok: false, error: 'invalid_due_date' };
                if (item.dueDate < item.startDate) return { ok: false, error: 'due_date_before_start_date' };
            } else {
                if (!isValidDaysOfWeek(item.daysOfWeek)) return { ok: false, error: 'invalid_days_of_week' };
                if (item.dueDate !== null) return { ok: false, error: 'recurring_task_cannot_have_due_date' };
            }
        }
    }

    return { ok: true };
}

/**
 * Builds a client-generated idempotency key for one Apply attempt. Reused
 * verbatim across an automatic retry of the *same* attempt (e.g. a network
 * timeout where the client isn't sure the first request landed) so
 * apply_routine_template's (organizer_id, apply_request_id) uniqueness
 * makes a retried request return the already-created routine instead of
 * creating a duplicate. A fresh Apply tap (not a retry) must generate a
 * new key. No crypto.randomUUID dependency — kept engine-portable (Hermes)
 * with a manual generator.
 */
/** Whole-day difference (b - a) between two 'YYYY-MM-DD' calendar dates, computed as pure calendar-date arithmetic (no timezone/instant involved, matching how task start_date/due_date are already stored). */
export function dateStringDiffDays(a: string, b: string): number {
    const [ay, am, ad] = a.split('-').map(Number);
    const [by, bm, bd] = b.split('-').map(Number);
    return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

export function generateApplyRequestId(): string {
    const rand = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
    return `apply-${Date.now()}-${rand}`;
}

export type TemplateItemDraft = RoutineTemplateItem & { sourceItemKey: string };

/** Total reminder/task counts for a routine summary — never a combined success rate. */
export function summarizeItemCounts(items: { itemKind: 'reminder' | 'task' }[]): { reminderCount: number; taskCount: number } {
    let reminderCount = 0;
    let taskCount = 0;
    for (const item of items) {
        if (item.itemKind === 'reminder') reminderCount++;
        else taskCount++;
    }
    return { reminderCount, taskCount };
}
