import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { isDueOnDate } from '@/lib/frequency';
import { supabase } from '@/lib/supabase';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReminderForScheduling = {
    id: string;
    title: string;
    reminder_type: string;
    time_of_day: string;        // "HH:MM" 24-hour
    days_of_week: number[];     // ISO weekday numbers, 1 = Monday ... 7 = Sunday
};

type OccurrenceNotificationData = {
    reminderId: string;
    recipientId: string;
    occurrenceDate: string;     // "YYYY-MM-DD"
    scheduledFor: string;       // ISO timestamp
    reminderType: string;
    title: string;
    notificationType: 'reminder' | 'snooze';
};

// ─── Constants ────────────────────────────────────────────────────────────────

const CHANNEL_ID = 'care-reminders';

// How far ahead one-shot occurrence notifications are pre-scheduled. Kept
// modest because iOS caps an app at ~64 pending local notifications — a
// larger window with several reminders could silently exceed that cap.
const ROLLING_WINDOW_DAYS = 14;

function occurrenceIdentifier(reminderId: string, occurrenceDate: string): string {
    return `care-${reminderId}-${occurrenceDate}`;
}

function getLocalDateString(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * True for any notification Tavora itself scheduled locally (identified by
 * its identifier prefix and its content.data shape) — never matches a
 * caregiver push notification or anything scheduled by another app feature.
 * Both signals are checked so a partial match (e.g. identifier reused by
 * mistake, or data present without the prefix) never gets treated as ours.
 */
function isTavoraNotification(
    n: Notifications.NotificationRequest
): n is Notifications.NotificationRequest & { content: { data: OccurrenceNotificationData } } {
    const data = n.content.data as Partial<OccurrenceNotificationData> | undefined;
    return (
        typeof n.identifier === 'string' &&
        n.identifier.startsWith('care-') &&
        typeof data?.reminderId === 'string' &&
        (data?.notificationType === 'reminder' || data?.notificationType === 'snooze')
    );
}

// ─── Android channel ──────────────────────────────────────────────────────────

export async function setupAndroidChannel(): Promise<void> {
    if (Platform.OS !== 'android') return;
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
        name: 'Reminders',
        importance: Notifications.AndroidImportance.HIGH,
        sound: 'default',
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#4361EE',
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
        enableVibrate: true,
    });
}

// ─── Permissions ──────────────────────────────────────────────────────────────

/**
 * Request notification permission on first call.
 * Returns true if granted. Does NOT re-prompt if previously denied.
 */
export async function requestNotificationPermissions(): Promise<boolean> {
    const { status: existing } = await Notifications.getPermissionsAsync();
    if (existing === 'granted') return true;
    if (existing === 'denied')  return false; // system won't show the prompt again
    const { status } = await Notifications.requestPermissionsAsync();
    return status === 'granted';
}

// ─── Schedule / cancel ────────────────────────────────────────────────────────

/**
 * Cancel every Tavora-scheduled notification on this device, then schedule
 * fresh one-shot occurrence notifications for the supplied reminders across
 * a rolling window (see ROLLING_WINDOW_DAYS). Not exported for direct use —
 * call syncRecipientReminderNotifications() instead, which supplies
 * `reminders`/`recipientId` from a fresh Supabase fetch every time.
 *
 * Each notification represents exactly one reminder occurrence on exactly
 * one date — never a recurring DAILY/WEEKLY trigger — so cancelling one
 * occurrence (cancelReminderOccurrenceNotification) can never silence a
 * future one. days_of_week (ISO 1=Mon...7=Sun) is the source of truth for
 * which dates get scheduled; reminder_logs decides which already-answered
 * dates are skipped.
 *
 * Safe to call on every dashboard focus / pull-to-refresh — idempotent
 * because the entire valid window is rebuilt from current reminder state
 * every time, so it never produces duplicates.
 */
async function scheduleReminderNotifications(
    reminders: ReminderForScheduling[],
    recipientId: string
): Promise<void> {
    // Cancel only Tavora's own scheduled notifications — never anything else
    // this app or another feature may have scheduled — then rebuild the
    // entire rolling window from current reminder state. This is what makes
    // the reschedule idempotent and stale-notification-safe: a reminder that
    // was deleted, deactivated, transferred to another recipient, or has
    // become ineligible simply won't be in `reminders` and so never gets
    // rescheduled, and its previously-scheduled notification is gone.
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    await Promise.all(
        scheduled
            .filter(isTavoraNotification)
            .map((n) => Notifications.cancelScheduledNotificationAsync(n.identifier))
    );

    if (reminders.length === 0) return;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const windowDates: Date[] = Array.from({ length: ROLLING_WINDOW_DAYS }, (_, i) => {
        const d = new Date(todayStart);
        d.setDate(d.getDate() + i);
        return d;
    });
    const windowStartString = getLocalDateString(windowDates[0]);
    const windowEndString   = getLocalDateString(windowDates[windowDates.length - 1]);

    const reminderIds = reminders.map((r) => r.id);

    const { data: logsData } = await supabase
        .from('reminder_logs')
        .select('reminder_id, occurrence_date, status, snoozed_until')
        .in('reminder_id', reminderIds)
        .gte('occurrence_date', windowStartString)
        .lte('occurrence_date', windowEndString);

    const logsByKey = new Map(
        (logsData || []).map((l) => [`${l.reminder_id}|${l.occurrence_date}`, l])
    );

    const now = new Date();

    for (const reminder of reminders) {
        const [h, m] = reminder.time_of_day.split(':').map(Number);

        for (const date of windowDates) {
            if (!isDueOnDate(reminder.days_of_week, date)) continue;

            const occurrenceDate = getLocalDateString(date);
            const log = logsByKey.get(`${reminder.id}|${occurrenceDate}`);

            if (log?.status && log.status !== 'pending') {
                // Already answered. A still-pending snooze gets its own
                // re-alert at snoozed_until; every other terminal status
                // (taken/skipped/missed, or an expired snooze) gets nothing.
                if (log.status === 'snoozed' && log.snoozed_until) {
                    await scheduleSnoozeNotification(reminder, occurrenceDate, log.snoozed_until, recipientId);
                }
                continue;
            }

            const scheduledFor = new Date(date);
            scheduledFor.setHours(h, m, 0, 0);
            if (scheduledFor.getTime() <= now.getTime()) continue; // already passed today

            const data: OccurrenceNotificationData = {
                reminderId:   reminder.id,
                recipientId,
                occurrenceDate,
                scheduledFor: scheduledFor.toISOString(),
                reminderType: reminder.reminder_type,
                title:        reminder.title,
                notificationType: 'reminder',
            };

            await Notifications.scheduleNotificationAsync({
                identifier: occurrenceIdentifier(reminder.id, occurrenceDate),
                content: {
                    title: reminder.title,
                    body:  'Time to respond to this reminder.',
                    data,
                    sound: 'default',
                    // Urgent, time-bound care event — eligible to break through
                    // Focus modes without requiring Critical Alert entitlement.
                    interruptionLevel: 'timeSensitive',
                },
                trigger: {
                    type: Notifications.SchedulableTriggerInputTypes.DATE,
                    date: scheduledFor,
                },
            });
        }
    }
}

/**
 * Schedule a one-shot re-alert for a snoozed occurrence, firing at
 * snoozedUntilIso. Does nothing if that time has already passed.
 */
export async function scheduleSnoozeNotification(
    reminder: { id: string; title: string; reminder_type: string },
    occurrenceDate: string,
    snoozedUntilIso: string,
    recipientId: string
): Promise<void> {
    const fireDate = new Date(snoozedUntilIso);
    if (fireDate.getTime() <= Date.now()) return;

    const data: OccurrenceNotificationData = {
        reminderId:   reminder.id,
        recipientId,
        occurrenceDate,
        scheduledFor: fireDate.toISOString(),
        reminderType: reminder.reminder_type,
        title:        reminder.title,
        notificationType: 'snooze',
    };

    await Notifications.scheduleNotificationAsync({
        identifier: `${occurrenceIdentifier(reminder.id, occurrenceDate)}-snooze`,
        content: {
            title: reminder.title,
            body:  'Snoozed reminder — time to respond.',
            data,
            sound: 'default',
            // Same urgency as the original occurrence it's re-alerting for.
            interruptionLevel: 'timeSensitive',
        },
        trigger: {
            type: Notifications.SchedulableTriggerInputTypes.DATE,
            date: fireDate,
        },
    });
}

/**
 * Cancel only the one-shot notification(s) for a specific reminder
 * occurrence (original + its snooze re-alert, if any) — e.g. right after
 * the recipient marks Taken/Skipped/Snoozed for today. Matches by
 * content.data, never by identifier prefix, so it can never reach into a
 * different date's occurrence for the same reminder.
 */
export async function cancelReminderOccurrenceNotification(
    reminderId: string,
    occurrenceDate: string
): Promise<void> {
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();

    const toCancel = scheduled.filter((n) => {
        const data = n.content.data as Partial<OccurrenceNotificationData> | undefined;
        return data?.reminderId === reminderId && data?.occurrenceDate === occurrenceDate;
    });

    await Promise.all(
        toCancel.map((n) => Notifications.cancelScheduledNotificationAsync(n.identifier))
    );
}

/**
 * Cancel every scheduled occurrence (current + future) for one reminder.
 * Only for a full reminder delete/deactivate or a full resync — never call
 * this for a single Taken/Skipped/Snoozed response, which must only ever
 * touch today's occurrence via cancelReminderOccurrenceNotification.
 */
export async function cancelAllReminderNotifications(reminderId: string): Promise<void> {
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();

    const toCancel = scheduled.filter((n) => {
        const data = n.content.data as Partial<OccurrenceNotificationData> | undefined;
        return data?.reminderId === reminderId;
    });

    await Promise.all(
        toCancel.map((n) => Notifications.cancelScheduledNotificationAsync(n.identifier))
    );
}

// ─── Cross-device deletion sync ────────────────────────────────────────────────

const LEGACY_CLEANUP_DONE_KEY = 'tavora.legacyLocalReminderNotificationsCleanedUp.v1';

/**
 * One-time cleanup for recipients migrating onto server-authoritative push:
 * cancels any Tavora-identified local notifications left over from the old
 * local-scheduling path, then never touches anything again (server push
 * doesn't need this device to have scheduled anything). Gated by an
 * AsyncStorage flag so it runs exactly once per install, not on every sync.
 */
async function runLegacyNotificationCleanupOnce(): Promise<void> {
    const alreadyCleaned = await AsyncStorage.getItem(LEGACY_CLEANUP_DONE_KEY);
    if (alreadyCleaned) return;

    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    await Promise.all(
        scheduled
            .filter(isTavoraNotification)
            .map((n) => Notifications.cancelScheduledNotificationAsync(n.identifier))
    );

    await AsyncStorage.setItem(LEGACY_CLEANUP_DONE_KEY, '1');
}

/**
 * Whether the signed-in recipient has been migrated to server-authoritative
 * reminder push (profiles.server_push_enabled). Always re-checked live —
 * never cached for the session — so a mid-session flag flip can never leave
 * the client and server pipelines disagreeing about who owns delivery.
 * Defaults to false (the proven legacy local-scheduling path) on any fetch
 * failure or when signed out.
 */
export async function isRecipientServerPushEnabled(): Promise<boolean> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return false;

    const { data, error } = await supabase
        .from('profiles')
        .select('server_push_enabled')
        .eq('id', user.id)
        .maybeSingle();

    if (error || !data) return false;
    return !!data.server_push_enabled;
}

/**
 * The single source of truth for reconciling this device's local
 * notification state against the recipient's current server-side state.
 *
 * Branches once on profiles.server_push_enabled:
 *  - true  → server-authoritative. This device must never pre-schedule a
 *    recurring reminder or snooze; the only remaining local-notification
 *    responsibility is the one-time legacy cleanup above.
 *  - false → unchanged legacy behavior: re-fetches the recipient's active
 *    reminders and rebuilds the entire local notification schedule via
 *    scheduleReminderNotifications, which cancels every Tavora-scheduled
 *    notification first, so anything for a reminder that was deleted,
 *    deactivated, transferred to another recipient, no longer eligible, or
 *    already answered simply never gets rescheduled.
 *
 * Safe to call as often as needed in either branch; never produces
 * duplicates. On the legacy path, this can only cancel notifications
 * already sitting in *this* device's local notification store — see the
 * audit report for the platform limitation this implies when the caregiver
 * deletes a reminder while the recipient's device is offline or Tavora
 * isn't running. That limitation does not apply once server_push_enabled
 * is true.
 */
export async function syncRecipientReminderNotifications(): Promise<void> {
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) return; // signed out — nothing to reconcile

    const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('server_push_enabled')
        .eq('id', user.id)
        .maybeSingle();

    if (profileError) {
        console.warn('[syncRecipientReminderNotifications] Failed to fetch profile:', profileError.message);
        return;
    }

    if (profile?.server_push_enabled) {
        await runLegacyNotificationCleanupOnce();
        return;
    }

    const { data: reminders, error } = await supabase
        .from('reminders')
        .select('id, title, reminder_type, time_of_day, days_of_week')
        .eq('recipient_id', user.id)
        .eq('is_active', true);

    if (error) {
        // Transient fetch failure — leave the existing local schedule as-is
        // rather than risk cancelling valid notifications on bad data.
        console.warn('[syncRecipientReminderNotifications] Failed to fetch reminders:', error.message);
        return;
    }

    await scheduleReminderNotifications(reminders ?? [], user.id);
}

/**
 * Lightweight liveness check for a single reminder, used where re-running
 * the full sync would be overkill (foreground notification handler,
 * notification-tap screen). Fails OPEN on a network error — a flaky
 * connection must never suppress a legitimate care reminder.
 */
export async function isReminderCurrentlyActive(reminderId: string): Promise<boolean> {
    const { data, error } = await supabase
        .from('reminders')
        .select('is_active')
        .eq('id', reminderId)
        .maybeSingle();

    if (error) return true;
    return !!data?.is_active;
}

// ─── Push token registration ──────────────────────────────────────────────────

export type PushTokenResult =
    | { ok: true }
    | { ok: false; reason: 'no-permission' | 'project_id_missing' | 'expo-go' | 'error'; message: string };

/**
 * Request permission, fetch the Expo push token, and upsert it into
 * push_tokens for the given user — caregiver or recipient, the table and
 * its RLS are role-agnostic (scoped only to user_id = auth.uid()).
 * Safe to call on every dashboard focus — idempotent via upsert.
 * Handles Expo Go gracefully: returns ok:false with a clear message instead of crashing.
 */
export async function registerPushToken(userId: string): Promise<PushTokenResult> {
    const { status: existing } = await Notifications.getPermissionsAsync();
    let finalStatus = existing;
    if (existing !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
    }
    if (finalStatus !== 'granted') {
        return {
            ok: false,
            reason: 'no-permission',
            message: 'Enable notifications in Settings to receive reminder alerts.',
        };
    }

    const projectId: string | undefined =
        Constants.easConfig?.projectId ??
        (Constants.expoConfig?.extra as any)?.eas?.projectId;

    if (!projectId) {
        return {
            ok: false,
            reason: 'project_id_missing',
            message: 'Push notifications need a development build project ID. Preferences are saved.',
        };
    }

    try {
        const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });

        await supabase.from('push_tokens').upsert(
            {
                user_id:         userId,
                expo_push_token: token,
                platform:        Platform.OS,
                is_active:       true,
                updated_at:      new Date().toISOString(),
            },
            { onConflict: 'expo_push_token' }
        );

        // A user can re-register from a new device/install and end up with
        // multiple tokens. Only the one we just upserted should stay active.
        await supabase
            .from('push_tokens')
            .update({ is_active: false })
            .eq('user_id', userId)
            .neq('expo_push_token', token);

        return { ok: true };
    } catch (err: any) {
        const msg = String(err?.message ?? '').toLowerCase();
        const isExpoGoError =
            msg.includes('expo go') ||
            msg.includes('development build') ||
            msg.includes('project id') ||
            msg.includes('standalone') ||
            msg.includes('must be a standalone');
        return {
            ok: false,
            reason: isExpoGoError ? 'expo-go' : 'error',
            message: isExpoGoError
                ? 'Push alerts require a development build. Preferences are saved and will activate when you upgrade.'
                : 'Could not register for push notifications. Preferences are saved.',
        };
    }
}
