import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

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
