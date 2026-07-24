// ─── Canonical IANA-timezone-aware date/time helpers ─────────────────────────
// Week 1 launch hardening task #8: caregiver-facing screens must compute a
// connected recipient's reminder eligibility/status in the RECIPIENT's own
// stored timezone (profiles.timezone), never the viewing device's — a
// caregiver in a different timezone must see the same Pending/Missed/
// Future status the recipient (and the server) would compute.
//
// Built entirely on Intl.DateTimeFormat with the `timeZone` option, already
// relied on elsewhere in this codebase (lib/timezone.ts,
// lib/timezoneValidation.ts) — no new date-arithmetic library added. Never
// applies a manually-hardcoded UTC offset; every conversion re-derives the
// zone's actual offset from Intl for the specific instant in question, so
// daylight-saving transitions are handled correctly rather than assumed
// constant. Server-side persisted state (reminder_logs, deliveries) remains
// authoritative — these are DISPLAY/live-status computations only, mirrored
// as closely as practical against the server's own `AT TIME ZONE` math
// (see docs/reminder-state-model.md).

function offsetFormatter(timeZone: string): Intl.DateTimeFormat {
    return new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    });
}

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function getZonedParts(date: Date, timeZone: string): ZonedParts {
    const parts = offsetFormatter(timeZone).formatToParts(date);
    const map: Record<string, string> = {};
    for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value;
    return {
        year: Number(map.year),
        month: Number(map.month),
        day: Number(map.day),
        hour: Number(map.hour) === 24 ? 0 : Number(map.hour),
        minute: Number(map.minute),
        second: Number(map.second),
    };
}

/** The UTC offset (in minutes, positive east of UTC) `timeZone` has at the instant `date`. Re-derived per-instant — never a fixed assumption, so DST transitions are handled correctly. */
function getTimeZoneOffsetMinutes(date: Date, timeZone: string): number {
    const p = getZonedParts(date, timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return (asUtc - date.getTime()) / 60000;
}

/** "YYYY-MM-DD" calendar date that `date` falls on in `timeZone`. */
export function getZonedDateString(date: Date, timeZone: string): string {
    const p = getZonedParts(date, timeZone);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** ISO weekday (1=Monday..7=Sunday) that `date` falls on in `timeZone` — matches reminders.days_of_week's stored convention. */
export function getZonedIsoWeekday(date: Date, timeZone: string): number {
    const p = getZonedParts(date, timeZone);
    // Pure calendar-date weekday math: constructing a Date from the
    // extracted Y/M/D at local noon and reading .getDay() is timezone-
    // agnostic once you already have the calendar date — no further zone
    // conversion happens here.
    const jsDay = new Date(p.year, p.month - 1, p.day, 12, 0, 0).getDay();
    return jsDay === 0 ? 7 : jsDay;
}

/**
 * The absolute UTC instant that displays as `dateString` (`"YYYY-MM-DD"`)
 * at wall-clock `timeOfDay` (`"HH:MM"` or `"HH:MM:SS"`) in `timeZone`.
 * Mirrors Postgres's `(occurrence_date::timestamp + time_of_day) at time
 * zone tz` used server-side (claim functions, respond_to_reminder_occurrence,
 * sync_missed_reminders_db) — same inputs, same resulting instant.
 */
export function zonedDateTimeToUtc(dateString: string, timeOfDay: string, timeZone: string): Date {
    const [year, month, day] = dateString.split('-').map(Number);
    const [hour, minute] = timeOfDay.split(':').map(Number);
    const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, 0);

    const offset = getTimeZoneOffsetMinutes(new Date(naiveUtc), timeZone);
    let result = naiveUtc - offset * 60000;

    // One refinement pass: recompute the offset at the corrected instant.
    // Only matters within the rare hour(s) around a DST transition, where
    // the offset at the naive guess can differ from the offset at the
    // true instant; a second pass converges in every practical case.
    const refinedOffset = getTimeZoneOffsetMinutes(new Date(result), timeZone);
    if (refinedOffset !== offset) {
        result = naiveUtc - refinedOffset * 60000;
    }

    return new Date(result);
}

/** "YYYY-MM-DD" for the current instant, in `timeZone`. */
export function getZonedTodayString(timeZone: string): string {
    return getZonedDateString(new Date(), timeZone);
}

/**
 * Whether `now` has reached `scheduledFor` (an absolute instant) plus
 * `noResponseMinutes` — timezone-agnostic once `scheduledFor` is already
 * an absolute instant (comparing two absolute timestamps needs no further
 * zone awareness), exported alongside the zone-aware constructors above
 * since callers build `scheduledFor` via `zonedDateTimeToUtc`.
 */
export function isPastNoResponseWindowAt(scheduledFor: Date, noResponseMinutes: number, now: Date = new Date()): boolean {
    const missedAt = new Date(scheduledFor.getTime() + noResponseMinutes * 60000);
    return now.getTime() >= missedAt.getTime();
}

/** 12-hour "H:MM AM/PM" formatting of a raw "HH:MM[:SS]" wall-clock string — no zone conversion needed since time_of_day is already the intended wall-clock value. */
export function formatWallClockTime(timeOfDay: string): string {
    const [hStr, mStr] = timeOfDay.split(':');
    let h = Number(hStr);
    const suffix = h >= 12 ? 'PM' : 'AM';
    if (h === 0) h = 12;
    else if (h > 12) h -= 12;
    return `${h}:${mStr.padStart(2, '0')} ${suffix}`;
}
