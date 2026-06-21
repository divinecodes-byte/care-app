import * as Notifications from 'expo-notifications';
import { router, Stack } from 'expo-router';
import { useEffect, useRef } from 'react';

import { setupAndroidChannel } from '@/lib/notifications';

// Show the notification banner even when the app is in the foreground.
// The recipient still has to tap it (or tap the card) to open the alert screen.
Notifications.setNotificationHandler({
    handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList:   true,
        shouldPlaySound:  true,
        shouldSetBadge:   false,
    }),
});

export default function RootLayout() {
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
        <Stack
            screenOptions={{
                headerShown:    false,
                gestureEnabled: false,
            }}
        />
    );
}
