// ─── Shared missed-reminder helpers ──────────────────────────────────────────
// Used by recipient-dashboard and reminder-alert.
// caregiver-dashboard and reminder-details have equivalent inline helpers for
// historical dates — do not consolidate those without verifying them first.

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
