import { getZonedDateString, zonedDateTimeToUtc } from '@/lib/zonedTime';

// ─── Authoritative participant-timezone context ──────────────────────────
// Pure, zero react-native import (only lib/zonedTime.ts, itself pure —
// built entirely on Intl, no date-arithmetic library). Deliberately does
// NOT import from components/DatePickerField.tsx (which transitively pulls
// in react-native) even though it has an equivalent addDaysToDateString —
// this module must stay importable by plain Node/tsx scripts, matching the
// established convention for every other *Core.ts / *Context.ts pure
// module in this codebase.
//
// This is the single source of truth for "what is today, for this
// participant" across the Today hub and activity feed. profiles.timezone
// is authoritative; the viewing device's own clock/timezone is used ONLY
// to read the current absolute instant (Date.now()), which is the same
// everywhere on Earth and therefore never itself a source of error — the
// bug this module exists to close was never "the device clock is wrong,"
// it was "calendar-date arithmetic was being done using the device's LOCAL
// calendar rather than the participant's." See docs/today-hub-model.md.

export type ParticipantTodayContext = {
    /** The participant's own stored IANA timezone (profiles.timezone) — never the viewing device's. */
    timezone: string;
    /** "YYYY-MM-DD" — today's date AS THE PARTICIPANT WOULD SEE IT, computed from `timezone`. */
    localDateKey: string;
    /** The absolute instant this context was built for (Date.now() at build time, or an injected fixed instant in tests). */
    nowInstant: Date;
};

export function getParticipantTodayContext(now: Date, timezone: string): ParticipantTodayContext {
    return {
        timezone,
        localDateKey: getZonedDateString(now, timezone),
        nowInstant: now,
    };
}

/** "YYYY-MM-DD" that `now` falls on on in `timezone` — a thin, explicitly-named wrapper over getZonedDateString for call-site clarity in Today/activity code. */
export function getParticipantLocalDateKey(now: Date, timezone: string): string {
    return getZonedDateString(now, timezone);
}

function addCalendarDays(dateKey: string, count: number): string {
    const [y, m, d] = dateKey.split('-').map(Number);
    // Pure calendar-date (UTC-anchored) arithmetic -- deliberately never
    // constructs a Date in "local" (device) time, so this is correct
    // regardless of which TZ the host process happens to run under.
    const dt = new Date(Date.UTC(y, m - 1, d + count));
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

export function addParticipantCalendarDays(dateKey: string, count: number): string {
    return addCalendarDays(dateKey, count);
}

/** -1 / 0 / 1, lexicographic ("YYYY-MM-DD" sorts correctly as a plain string). */
export function compareParticipantDateKeys(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The next participant-local midnight (00:00 wall-clock in `timezone`,
 * immediately after `now`), as an absolute UTC instant — safe across DST:
 * built on zonedDateTimeToUtc, which never assumes a fixed-length day and
 * re-derives the real UTC offset for the specific instant in question. Use
 * this to schedule the Today-feed midnight-rollover timer; never
 * `setInterval(24 hours)` (a fixed 24h interval silently drifts across a
 * DST transition, since a "day" is 23 or 25 real hours on the transition
 * date in the affected timezone).
 */
export function getNextParticipantMidnight(now: Date, timezone: string): Date {
    const todayKey = getZonedDateString(now, timezone);
    const tomorrowKey = addCalendarDays(todayKey, 1);
    return zonedDateTimeToUtc(tomorrowKey, '00:00', timezone);
}
