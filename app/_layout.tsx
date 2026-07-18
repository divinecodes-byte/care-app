import * as Notifications from 'expo-notifications';
import { router, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';

import { LanguageProvider } from '@/lib/i18n/context';
import { cancelAllReminderNotifications, isReminderCurrentlyActive, setupAndroidChannel } from '@/lib/notifications';
import { ThemeProvider, useThemeMode } from '@/lib/theme';

const SUPPRESSED_RESULT: Notifications.NotificationBehavior = {
    shouldShowBanner: false,
    shouldShowList:   false,
    shouldPlaySound:  false,
    shouldSetBadge:   false,
};

const SHOWN_RESULT: Notifications.NotificationBehavior = {
    shouldShowBanner: true,
    shouldShowList:   true,
    shouldPlaySound:  true,
    shouldSetBadge:   false,
};

// Show the notification banner even when the app is in the foreground.
// The recipient still has to tap it (or tap the card) to open the alert screen.
//
// A locally-scheduled reminder notification can go stale between the moment
// it was scheduled and the moment it fires, if the caregiver deletes the
// reminder in between and this device hasn't synced yet. Since the app is
// open right now, there's time for one live check before deciding whether to
// surface it — this is the one place that can catch that narrow window.
// Caregiver push notifications (server-sent, no reminderId/notificationType)
// are untouched and always shown.
Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
        const data = (notification.request.content.data ?? {}) as Record<string, unknown>;
        const reminderId = data.reminderId as string | undefined;
        const notificationType = data.notificationType as string | undefined;

        const isTavoraReminderNotification =
            typeof reminderId === 'string' &&
            (notificationType === 'reminder' || notificationType === 'snooze');

        if (!isTavoraReminderNotification) return SHOWN_RESULT;

        const stillActive = await isReminderCurrentlyActive(reminderId);
        if (stillActive) return SHOWN_RESULT;

        // Confirmed gone — suppress this firing and clear anything else
        // still scheduled for it so it can't surface again later.
        cancelAllReminderNotifications(reminderId).catch(() => {});
        return SUPPRESSED_RESULT;
    },
});

export default function RootLayout() {
    return (
        <LanguageProvider>
            <ThemeProvider>
                <RootLayoutNav />
            </ThemeProvider>
        </LanguageProvider>
    );
}

function RootLayoutNav() {
    const { resolvedScheme } = useThemeMode();

    // Dedup guard — the cold-launch path and the live listener can both fire for
    // the same tap on iOS; only route once per notification identifier.
    const handledNotifRef = useRef<string | undefined>(undefined);

    function routeNotification(response: Notifications.NotificationResponse) {
        const notifId = response.notification.request.identifier;
        if (handledNotifRef.current === notifId) return;
        handledNotifRef.current = notifId;

        const data = (response.notification.request.content.data ?? {}) as Record<string, unknown>;
        const reminderId = data.reminderId as string | undefined;

        if (data.type === 'caregiver_reminder_event') {
            // Caregiver push notifications never open the recipient's full-screen
            // reminder alert (and its Taken/Snooze/Skip actions) — for now they
            // just take the caregiver to their dashboard.
            router.push('/caregiver-dashboard');
            return;
        }

        // Recipient local reminder notification — open the full-screen alert.
        if (reminderId) {
            router.push({ pathname: '/reminder-alert', params: { reminderId } });
        }
    }

    useEffect(() => {
        setupAndroidChannel();

        // Handles foreground, background, and cold-launch taps.
        // expo-notifications 0.32 queues the initial response on iOS so the
        // listener receives it even when the app was fully killed.
        const sub = Notifications.addNotificationResponseReceivedListener(routeNotification);
        return () => sub.remove();
    }, []);

    return (
        <>
            <StatusBar style={resolvedScheme === 'dark' ? 'light' : 'dark'} />
            <Stack
                screenOptions={{
                    headerShown:    false,
                    gestureEnabled: false,
                }}
            />
        </>
    );
}
