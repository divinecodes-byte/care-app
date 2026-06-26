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
    occurrenceDate: string;     // "YYYY-MM-DD"
    scheduledFor: string;       // ISO timestamp
    reminderType: string;
    title: string;
    isSnooze?: boolean;
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

// ─── Android channel ──────────────────────────────────────────────────────────

export async function setupAndroidChannel(): Promise<void> {
    if (Platform.OS !== 'android') return;
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
        name: 'Care Reminders',
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
 * Cancel every scheduled notification, then schedule fresh one-shot
 * occurrence notifications for the supplied reminders across a rolling
 * window (see ROLLING_WINDOW_DAYS).
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
export async function scheduleReminderNotifications(
    reminders: ReminderForScheduling[]
): Promise<void> {
    await Notifications.cancelAllScheduledNotificationsAsync();

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
                    await scheduleSnoozeNotification(reminder, occurrenceDate, log.snoozed_until);
                }
                continue;
            }

            const scheduledFor = new Date(date);
            scheduledFor.setHours(h, m, 0, 0);
            if (scheduledFor.getTime() <= now.getTime()) continue; // already passed today

            const data: OccurrenceNotificationData = {
                reminderId:   reminder.id,
                occurrenceDate,
                scheduledFor: scheduledFor.toISOString(),
                reminderType: reminder.reminder_type,
                title:        reminder.title,
            };

            await Notifications.scheduleNotificationAsync({
                identifier: occurrenceIdentifier(reminder.id, occurrenceDate),
                content: {
                    title: reminder.title,
                    body:  'Time to respond to this care reminder.',
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
    snoozedUntilIso: string
): Promise<void> {
    const fireDate = new Date(snoozedUntilIso);
    if (fireDate.getTime() <= Date.now()) return;

    const data: OccurrenceNotificationData = {
        reminderId:   reminder.id,
        occurrenceDate,
        scheduledFor: fireDate.toISOString(),
        reminderType: reminder.reminder_type,
        title:        reminder.title,
        isSnooze:     true,
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

// ─── Push token registration ──────────────────────────────────────────────────

export type PushTokenResult =
    | { ok: true }
    | { ok: false; reason: 'no-permission' | 'project_id_missing' | 'expo-go' | 'error'; message: string };

/**
 * Request permission, fetch the Expo push token, and upsert it into push_tokens.
 * Safe to call on every caregiver dashboard focus — idempotent via upsert.
 * Handles Expo Go gracefully: returns ok:false with a clear message instead of crashing.
 */
export async function registerCaregiverPushToken(caregiverId: string): Promise<PushTokenResult> {
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
            message: 'Enable notifications in Settings to receive caregiver alerts.',
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
                user_id:         caregiverId,
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
            .eq('user_id', caregiverId)
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

// ─── Dev helper ───────────────────────────────────────────────────────────────

/**
 * Schedule a one-shot test notification 10 seconds from now.
 * Passes the real reminderId so it opens the genuine alert screen.
 * Remove call sites before shipping to production.
 */
export async function scheduleTestNotification(reminder: ReminderForScheduling): Promise<void> {
    await Notifications.scheduleNotificationAsync({
        identifier: `care-test-${reminder.id}-${Date.now()}`,
        content: {
            title: `[Test] ${reminder.title}`,
            body:  'This is a test care reminder notification.',
            data:  { reminderId: reminder.id },
            sound: 'default',
        },
        trigger: {
            type:    Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
            seconds: 10,
        },
    });
}
