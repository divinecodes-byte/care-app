import { isDueOnDate } from '@/lib/frequency';
import { getZonedDateString, isPastNoResponseWindowAt, zonedDateTimeToUtc } from '@/lib/zonedTime';

// ─── Shared missed-reminder helpers ──────────────────────────────────────────
// Used by recipient-dashboard, reminder-alert, caregiver-dashboard, and
// reminder-details — the historical-date eligibility/status helpers below
// were previously duplicated (with a real divergence) across
// caregiver-dashboard.tsx and reminder-details.tsx; consolidated here as of
// the Week 1 task #7 reminder-lifecycle hardening. See
// isReminderEligibleOnDate's comment for the specific bug this fixed.
//
// Every function here computes from the DEVICE's local clock, same as
// before consolidation — this is a client-side *display* computation only.
// The persisted, authoritative status (what actually lands in
// reminder_logs) is always written server-side, in the recipient's own
// stored timezone (respond_to_reminder_occurrence / sync_missed_reminders_db
// — see docs/reminder-state-model.md). A recipient whose device timezone
// drifts from their stored profile timezone can see a display briefly
// disagree with the eventual persisted value; this is a documented,
// accepted residual risk, not something this consolidation attempts to fix.

export type DisplayReminderStatus = 'pending' | 'taken' | 'snoozed' | 'skipped' | 'missed';

/** Minimal shape these helpers need — satisfied structurally by each screen's own richer Reminder type. */
export type ReminderScheduleLike = {
    days_of_week: number[];
    time_of_day: string;
    created_at: string;
    is_active: boolean;
    no_response_minutes: number;
};

export type ReminderLogLike = {
    status: DisplayReminderStatus;
};

/**
 * User-facing label for a reminder status. The internal/DB value stays
 * `taken` — only the displayed word changed from "Taken" to "Completed"
 * now that Tavora covers more than medication reminders.
 */
export function formatReminderStatus(status: DisplayReminderStatus): string {
    const map: Record<DisplayReminderStatus, string> = {
        taken:   'Completed',
        snoozed: 'Snoozed',
        skipped: 'Skipped',
        missed:  'Missed',
        pending: 'Pending',
    };
    return map[status] ?? 'Pending';
}

/** "YYYY-MM-DD" in local time */
export function getTodayDateString(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** ISO timestamp placing today's date at the given "HH:MM" local time */
export function buildScheduledForIso(timeOfDay: string): string {
    const [h, m] = timeOfDay.split(':').map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d.toISOString();
}

/** ISO timestamp N minutes from now */
export function buildSnoozedUntilIso(minutes = 10): string {
    const d = new Date();
    d.setMinutes(d.getMinutes() + minutes);
    return d.toISOString();
}

/**
 * The first calendar date ("YYYY-MM-DD", local time) a reminder is eligible
 * to fire, given when it was created and its daily time-of-day.
 *
 * A reminder created today after today's time-of-day has already passed
 * (e.g. created at 8:30 PM for an 8:00 AM reminder) is not eligible until
 * tomorrow — today must never be treated as missed in that case.
 */
export function getFirstEligibleDateString(createdAt: string, timeOfDay: string): string {
    const created = new Date(createdAt);
    const [h, m]  = timeOfDay.split(':').map(Number);
    const scheduledOnCreatedDate = new Date(
        created.getFullYear(), created.getMonth(), created.getDate(), h, m, 0, 0
    );

    const firstEligible = created > scheduledOnCreatedDate
        ? new Date(created.getFullYear(), created.getMonth(), created.getDate() + 1, 0, 0, 0, 0)
        : new Date(created.getFullYear(), created.getMonth(), created.getDate(), 0, 0, 0, 0);

    return `${firstEligible.getFullYear()}-${String(firstEligible.getMonth() + 1).padStart(2, '0')}-${String(firstEligible.getDate()).padStart(2, '0')}`;
}

/**
 * Returns true when the scheduled time + no-response window has already
 * expired for today's occurrence, using the current local clock.
 *
 * Only meaningful for today — use getComputedStatus below for historical
 * date calculations.
 */
export function isPastNoResponseWindow(
    timeOfDay: string,
    noResponseMinutes: number
): boolean {
    const [h, m] = timeOfDay.split(':').map(Number);
    const today = new Date();
    const scheduled = new Date(
        today.getFullYear(), today.getMonth(), today.getDate(), h, m, 0, 0
    );
    const missedAt = new Date(scheduled.getTime() + noResponseMinutes * 60 * 1000);
    return Date.now() >= missedAt.getTime();
}

/**
 * The calendar date (local time) a reminder/connection pairing first
 * becomes analytics-eligible — the later of the reminder's creation and
 * the connection's acceptance, bumped to the next day if that moment fell
 * after that day's own scheduled time (mirrors getFirstEligibleDateString's
 * same-day-cutoff rule, generalized to accept either boundary).
 */
export function getAnalyticsStartDate(
    connectionAcceptedAt: string,
    reminderCreatedAt: string,
    timeOfDay: string
): Date {
    const connDate = new Date(connectionAcceptedAt);
    const remDate  = new Date(reminderCreatedAt);
    const later    = connDate > remDate ? connDate : remDate;

    const [h, m] = timeOfDay.split(':').map(Number);
    const scheduledOnLaterDate = new Date(
        later.getFullYear(), later.getMonth(), later.getDate(), h, m, 0, 0
    );
    const laterDateStart = new Date(later.getFullYear(), later.getMonth(), later.getDate(), 0, 0, 0, 0);
    return later > scheduledOnLaterDate ? addDaysLocal(laterDateStart, 1) : laterDateStart;
}

function addDaysLocal(date: Date, days: number): Date {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
}

/**
 * Whether a reminder counts toward analytics/history display on a given
 * calendar date — combines the day-of-week schedule, the analytics start
 * boundary (max(created_at, accepted_at)), and inactive-reminder handling.
 *
 * For an inactive (soft-deleted) reminder, eligibility is decided by
 * `hasLogOnDate` — whether a real reminder_logs row already exists for
 * that date — never by comparing the date against the reminder's
 * `updated_at`/deactivation timestamp. This is the fix for a real
 * divergence found during the Week 1 task #7 audit: an earlier
 * `updated_at`-based version (previously only in reminder-details.tsx)
 * could both hide a genuine same-day log recorded shortly before
 * deactivation, and — more importantly — could still show a *computed*
 * missed/pending status for the deactivation day itself when no log
 * existed, contradicting the documented intended rule that a deactivated
 * reminder must never surface any virtual (non-logged) status, not even
 * on the day it was deactivated. The `hasLogOnDate` rule (already correct
 * in caregiver-dashboard.tsx) satisfies both: a real historical log always
 * still shows regardless of when it landed relative to deactivation, and
 * an inactive reminder with no log on a given date is never eligible.
 */
export function isReminderEligibleOnDate(
    reminder: ReminderScheduleLike,
    date: Date,
    connectionAcceptedAt: string,
    hasLogOnDate: boolean
): boolean {
    if (!isDueOnDate(reminder.days_of_week, date)) return false;

    const start     = getAnalyticsStartDate(connectionAcceptedAt, reminder.created_at, reminder.time_of_day);
    const dateStart = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
    if (dateStart < start) return false;

    if (!reminder.is_active) return hasLogOnDate;

    return true;
}

/** Local midnight-anchored Date for a "YYYY-MM-DD" + "HH:MM" pair. */
export function buildScheduledDateTime(dateString: string, timeOfDay: string): Date {
    const [yr, mo, dy] = dateString.split('-').map(Number);
    const [hr, mn]     = timeOfDay.split(':').map(Number);
    return new Date(yr, mo - 1, dy, hr, mn, 0, 0);
}

/**
 * The status to display for a given reminder occurrence: the persisted log
 * status if one exists, otherwise a computed value — 'pending' for a
 * future date or one still inside its response window, 'missed' once the
 * window has passed with no log. Never itself writes anything; see this
 * file's header comment on the client/server split.
 */
export function getComputedStatus(
    reminder: ReminderScheduleLike,
    dateString: string,
    todayString: string,
    log?: ReminderLogLike
): DisplayReminderStatus {
    if (log?.status) return log.status;
    if (dateString > todayString) return 'pending';
    const scheduledFor = buildScheduledDateTime(dateString, reminder.time_of_day);
    const missedAt = new Date(scheduledFor.getTime() + reminder.no_response_minutes * 60 * 1000);
    if (new Date() < missedAt) return 'pending';
    return 'missed';
}

// ─── Recipient-timezone-aware variants (caregiver-facing screens) ───────────
// Everything below mirrors the device-clock functions above exactly in
// shape and intent, but interprets "today"/"now"/day-of-week in an
// explicitly supplied IANA timezone (the connected recipient's stored
// profiles.timezone) instead of the viewing device's clock — built on
// lib/zonedTime.ts. This is what fixes the confirmed bug where a caregiver
// in a different timezone than their recipient could see an incorrect
// Pending/Missed/Future status. Recipient-facing screens (the recipient
// viewing their own reminders) intentionally keep using the device-clock
// functions above — the recipient's own device is expected to match their
// synced profile timezone (see docs/reminder-state-model.md).

/** ISO weekday (1=Monday..7=Sunday) of a "YYYY-MM-DD" calendar date — a pure calendar computation, the same regardless of timezone once you already have the date string. */
export function isoWeekdayOfDateString(dateString: string): number {
    const [y, m, d] = dateString.split('-').map(Number);
    const jsDay = new Date(y, m - 1, d, 12, 0, 0).getDay();
    return jsDay === 0 ? 7 : jsDay;
}

/** Zoned equivalent of getAnalyticsStartDate — returns a "YYYY-MM-DD" boundary date instead of a Date object (unambiguous once timezone is involved). */
export function getZonedAnalyticsStartDateString(
    connectionAcceptedAt: string,
    reminderCreatedAt: string,
    timeOfDay: string,
    timeZone: string
): string {
    const connDate = new Date(connectionAcceptedAt);
    const remDate = new Date(reminderCreatedAt);
    const later = connDate > remDate ? connDate : remDate;

    const laterDateString = getZonedDateString(later, timeZone);
    const scheduledOnLaterDate = zonedDateTimeToUtc(laterDateString, timeOfDay, timeZone);

    if (later > scheduledOnLaterDate) {
        const [y, m, d] = laterDateString.split('-').map(Number);
        const next = new Date(y, m - 1, d + 1);
        return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
    }
    return laterDateString;
}

/** Zoned equivalent of isReminderEligibleOnDate — takes a "YYYY-MM-DD" string rather than a Date, and the recipient's timeZone explicitly. */
export function isReminderEligibleOnZonedDate(
    reminder: ReminderScheduleLike,
    dateString: string,
    timeZone: string,
    connectionAcceptedAt: string,
    hasLogOnDate: boolean
): boolean {
    if (!reminder.days_of_week.includes(isoWeekdayOfDateString(dateString))) return false;

    const start = getZonedAnalyticsStartDateString(connectionAcceptedAt, reminder.created_at, reminder.time_of_day, timeZone);
    if (dateString < start) return false;

    if (!reminder.is_active) return hasLogOnDate;

    return true;
}

/**
 * Zoned equivalent of getComputedStatus — the response-window check compares
 * against the actual current instant, same as the device-clock version, but
 * the scheduled instant is computed in the recipient's timezone rather than
 * the device's. `now` is optional and defaults to the real current instant
 * (`isPastNoResponseWindowAt`'s own default) for every existing caller —
 * pass it explicitly (e.g. from a ParticipantTodayContext, or a fixed
 * instant in a test) to make this function's result fully deterministic
 * rather than silently reading the real clock underneath.
 */
export function getZonedComputedStatus(
    reminder: ReminderScheduleLike,
    dateString: string,
    todayString: string,
    timeZone: string,
    log?: ReminderLogLike,
    now?: Date
): DisplayReminderStatus {
    if (log?.status) return log.status;
    if (dateString > todayString) return 'pending';
    const scheduledFor = zonedDateTimeToUtc(dateString, reminder.time_of_day, timeZone);
    if (!isPastNoResponseWindowAt(scheduledFor, reminder.no_response_minutes, now)) return 'pending';
    return 'missed';
}
