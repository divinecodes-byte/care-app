import { supabase } from '@/lib/supabase';
import { isValidIanaTimezone } from '@/lib/timezoneValidation';

export { isValidIanaTimezone } from '@/lib/timezoneValidation';

// ─── Timezone synchronization ────────────────────────────────────────────────
//
// profiles.timezone is the server's sole source of truth for when a
// recipient's reminders are due (see claim_due_recipient_reminder_deliveries,
// claim_due_recipient_snooze_deliveries, sync_missed_reminders_db — all
// resolve occurrence dates/times against this column). It must reflect the
// recipient's OWN current device, and it must stay current if they travel —
// a one-time capture at first launch goes stale the moment they change
// timezone. This module is the single place that reconciles it.

export type TimezoneSyncResult =
    | { status: 'unchanged'; timezone: string }
    | { status: 'updated'; from: string | null; to: string }
    | { status: 'unavailable' }
    | { status: 'failed'; reason: string };

/**
 * Resolves this device's current IANA timezone and reconciles it with the
 * signed-in user's stored profiles.timezone — writing only when the two
 * actually differ, so repeated calls (dashboard load, AppState foreground,
 * before notification/push sync) never produce redundant writes.
 *
 * Safe to call frequently and from multiple lifecycle points: every path
 * either no-ops or does exactly one read + at most one write, and every
 * failure mode (signed out, device can't resolve a timezone, network
 * unavailable) fails open — it never blocks app usage and never overwrites
 * a previously-valid stored timezone with something worse (UTC, empty,
 * undefined). If the device can't currently resolve a valid timezone, the
 * last known-good stored value is simply left alone.
 */
export async function syncCurrentUserTimezone(): Promise<TimezoneSyncResult> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { status: 'unavailable' };

    let deviceTimezone: string | undefined;
    try {
        deviceTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
        deviceTimezone = undefined;
    }

    if (!isValidIanaTimezone(deviceTimezone)) {
        if (__DEV__) {
            console.warn('[syncCurrentUserTimezone] Device did not resolve a usable IANA timezone; leaving stored value untouched.');
        }
        return { status: 'unavailable' };
    }

    const { data: profile, error: fetchError } = await supabase
        .from('profiles')
        .select('timezone')
        .eq('id', user.id)
        .maybeSingle();

    if (fetchError) {
        if (__DEV__) console.warn('[syncCurrentUserTimezone] Failed to fetch stored timezone:', fetchError.message);
        return { status: 'failed', reason: fetchError.message };
    }

    const storedTimezone = profile?.timezone ?? null;
    if (storedTimezone === deviceTimezone) {
        return { status: 'unchanged', timezone: deviceTimezone };
    }

    const { error: updateError } = await supabase
        .from('profiles')
        .update({ timezone: deviceTimezone, updated_at: new Date().toISOString() })
        .eq('id', user.id);

    if (updateError) {
        if (__DEV__) console.warn('[syncCurrentUserTimezone] Failed to update timezone:', updateError.message);
        return { status: 'failed', reason: updateError.message };
    }

    return { status: 'updated', from: storedTimezone, to: deviceTimezone };
}

/**
 * Repair path for a missing/invalid stored `profiles.timezone`: reconciles
 * this device's own resolvable IANA timezone into the given user's profile
 * (via syncCurrentUserTimezone, a no-op if the device can't resolve one
 * either) and re-reads the stored value once. Returns the freshly-valid
 * value, or null if it's still missing/invalid after the attempt — callers
 * must treat null as "unavailable," never substitute a hardcoded or
 * device-local guess for authoritative reminder/task classification.
 */
export async function repairAndRefetchTimezone(userId: string): Promise<string | null> {
    await syncCurrentUserTimezone().catch(() => null);

    const { data } = await supabase
        .from('profiles')
        .select('timezone')
        .eq('id', userId)
        .maybeSingle();

    return isValidIanaTimezone(data?.timezone) ? data!.timezone : null;
}
