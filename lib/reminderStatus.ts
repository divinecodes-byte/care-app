// ─── Shared missed-reminder helpers ──────────────────────────────────────────
// Used by recipient-dashboard and reminder-alert.
// caregiver-dashboard and reminder-details have equivalent inline helpers for
// historical dates — do not consolidate those without verifying them first.

export type DisplayReminderStatus = 'pending' | 'taken' | 'snoozed' | 'skipped' | 'missed';

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
 * Only meaningful for today — use caregiver-dashboard's getComputedStatus
 * for historical date calculations.
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
