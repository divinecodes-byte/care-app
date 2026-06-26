import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { supabase } from '@/lib/supabase';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReminderForScheduling = {
    id: string;
    title: string;
    time_of_day: string;        // "HH:MM" 24-hour
    frequency: 'daily' | 'weekdays' | 'weekends';
};

// ─── Constants ────────────────────────────────────────────────────────────────

// expo-notifications weekday numbering: 1 = Sunday, 2 = Monday … 7 = Saturday
const WEEKDAY_NUMS = [2, 3, 4, 5, 6]; // Mon–Fri
const WEEKEND_NUMS = [1, 7];           // Sun, Sat

const CHANNEL_ID = 'care-reminders';

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
 * Cancel all scheduled notifications, then schedule fresh ones for the
 * supplied reminders. Safe to call on every dashboard focus — idempotent.
 *
 * Frequency mapping:
 *   daily    → DAILY trigger (every day at time_of_day)
 *   weekdays → WEEKLY trigger × 5 (Mon-Fri at time_of_day)
 *   weekends → WEEKLY trigger × 2 (Sat-Sun at time_of_day)
 */
export async function scheduleReminderNotifications(
    reminders: ReminderForScheduling[]
): Promise<void> {
    // Cancel previous schedule so re-loading the dashboard never duplicates
    await Notifications.cancelAllScheduledNotificationsAsync();

    for (const reminder of reminders) {
        const [h, m] = reminder.time_of_day.split(':').map(Number);

        const content: Notifications.NotificationContentInput = {
            title: reminder.title,
            body:  'Time to respond to this care reminder.',
            data:  { reminderId: reminder.id },
            sound: 'default',
        };

        if (reminder.frequency === 'daily') {
            await Notifications.scheduleNotificationAsync({
                identifier: `care-${reminder.id}`,
                content,
                trigger: {
                    type:   Notifications.SchedulableTriggerInputTypes.DAILY,
                    hour:   h,
                    minute: m,
                },
            });
        } else {
            const days = reminder.frequency === 'weekdays' ? WEEKDAY_NUMS : WEEKEND_NUMS;
            for (const weekday of days) {
                await Notifications.scheduleNotificationAsync({
                    identifier: `care-${reminder.id}-wd-${weekday}`,
                    content,
                    trigger: {
                        type:    Notifications.SchedulableTriggerInputTypes.WEEKLY,
                        weekday,
                        hour:    h,
                        minute:  m,
                    },
                });
            }
        }
    }
}

export async function cancelAllReminderNotifications(): Promise<void> {
    await Notifications.cancelAllScheduledNotificationsAsync();
}

/**
 * Cancel any locally-scheduled notification(s) for a reminder once the
 * recipient has actually responded to it (taken / skipped / snoozed).
 *
 * There is no per-occurrence identifier to cancel: `scheduleReminderNotifications`
 * schedules one recurring DAILY/WEEKLY trigger per reminder (identifier
 * `care-${reminderId}[-wd-N]`), not a fresh one-shot notification per calendar
 * day. Cancelling it here removes today's still-pending fire, and the next
 * `scheduleReminderNotifications` call (recipient-dashboard reschedules on
 * every focus) recreates the recurring trigger for the reminder's future
 * occurrences — so this never permanently silences a daily/weekly reminder.
 */
export async function cancelReminderLocalNotifications(reminderId: string): Promise<void> {
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();

    const toCancel = scheduled.filter((n) => {
        const data = n.content.data as { reminderId?: string } | undefined;
        return data?.reminderId === reminderId || n.identifier.startsWith(`care-${reminderId}`);
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
