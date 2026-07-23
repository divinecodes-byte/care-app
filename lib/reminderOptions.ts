// ─── Shared no-response-window options ───────────────────────────────────────
// Single source of truth for create-reminder and edit-reminder — previously
// each screen kept its own copy of this array.
//
// 1 minute was removed from the allowed options: with server-authoritative
// push running on a 30-second cron plus Edge Function + Expo/APNs delivery,
// a 1-minute response window left too little margin for a push to arrive
// with any actionable time left. Existing reminders already stored at 1
// minute are untouched (no destructive rewrite) — they simply fall outside
// this list now, which is what makes them load safely elsewhere (see
// edit-reminder.tsx's fallback-to-default behavior).

export const NO_RESPONSE_OPTIONS = [5, 10, 15, 30, 60] as const;

export const DEFAULT_NO_RESPONSE_MINUTES = 15;

/** True only for one of the current UI-selectable options — not just "a positive integer". */
export function isSelectableNoResponseMinutes(value: unknown): value is number {
    return typeof value === 'number' && NO_RESPONSE_OPTIONS.includes(value as typeof NO_RESPONSE_OPTIONS[number]);
}

/**
 * Defense-in-depth for the save path: never let a reminder write reach
 * Supabase with 0, a negative number, null, NaN, or any value outside the
 * current selectable set — even though today's UI only ever produces one of
 * NO_RESPONSE_OPTIONS via chip selection, this guards against that
 * assumption ever silently breaking.
 */
export function assertValidNoResponseMinutes(value: number): void {
    if (!isSelectableNoResponseMinutes(value)) {
        throw new Error(`Invalid no_response_minutes value: ${value}`);
    }
}
