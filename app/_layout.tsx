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
    // Track the last routed notification ID so we never navigate twice for the
    // same tap (the cold-launch check and the live listener can both fire).
    const handledNotifRef = useRef<string | undefined>(undefined);

    function routeToReminder(response: Notifications.NotificationResponse) {
        const notifId    = response.notification.request.identifier;
        const reminderId = response.notification.request.content.data?.reminderId as string | undefined;
        if (!reminderId) return;
        if (handledNotifRef.current === notifId) return; // already handled
        handledNotifRef.current = notifId;
        router.push({ pathname: '/reminder-alert', params: { reminderId } });
    }

    useEffect(() => {
        setupAndroidChannel();

        // Handles foreground, background, and cold-launch taps.
        // expo-notifications 0.32 queues the initial response on iOS so the
        // listener receives it even when the app was fully killed.
        const sub = Notifications.addNotificationResponseReceivedListener(routeToReminder);
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
