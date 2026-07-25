import * as Notifications from 'expo-notifications';
import { router, Stack, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';

import { AuthSessionProvider, useAuthSession } from '@/lib/authSession';
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

// Routes reachable while signed out. Never force-navigated away from by the
// auth-status effect below, regardless of session state.
const PUBLIC_ROUTES = new Set(['/', '/signin', '/signup', '/select-language', '/forgot-password', '/reset-password']);
// The one route a session with no (or no longer valid) role should land on
// — it's the recovery path for `profile_missing`, so it must never itself
// be redirected away from for that status.
const PROFILE_RECOVERY_ROUTE = '/choose-role';

export default function RootLayout() {
    return (
        <LanguageProvider>
            <ThemeProvider>
                <AuthSessionProvider>
                    <RootLayoutNav />
                </AuthSessionProvider>
            </ThemeProvider>
        </LanguageProvider>
    );
}

function RootLayoutNav() {
    const { resolvedScheme } = useThemeMode();
    const { status } = useAuthSession();
    const pathname = usePathname();

    // Dedup guard — the cold-launch path and the live listener can both fire for
    // the same tap on iOS; only route once per notification identifier.
    const handledNotifRef = useRef<string | undefined>(undefined);
    // A notification tapped before auth status has resolved (e.g. a cold
    // launch straight from a killed state) is queued here and replayed once
    // status leaves 'initializing' — this is what "notification deep links
    // wait for auth resolution" means: never navigate into a screen that
    // reads private data before we know whether there's even a valid,
    // active account to read it as.
    const pendingNotificationRef = useRef<Notifications.NotificationResponse | null>(null);
    // Distinct from handledNotifRef (which only dedupes the SAME
    // notification firing twice) — this guards against two DIFFERENT
    // notifications tapped in rapid succession each pushing their own
    // screen onto the stack back-to-back.
    const lastNavAtRef = useRef(0);
    const NOTIF_NAV_DEBOUNCE_MS = 1000;

    function processNotification(response: Notifications.NotificationResponse) {
        const notifId = response.notification.request.identifier;
        if (handledNotifRef.current === notifId) return;
        const now = Date.now();
        if (now - lastNavAtRef.current < NOTIF_NAV_DEBOUNCE_MS) return;
        handledNotifRef.current = notifId;
        lastNavAtRef.current = now;

        // No authorized, active account on this device right now — dropping
        // the deep link (rather than routing and letting the destination
        // screen discover this itself) means a signed-out or just-deleted
        // account can never even briefly land on a screen that starts a
        // private data fetch. The reminderId/connection this notification
        // pointed at is never itself trusted as authorization either way —
        // every destination screen re-fetches its own data under RLS,
        // scoped to whichever account ends up signed in.
        if (status === 'unauthenticated' || status === 'account_deleted' || status === 'profile_missing') {
            return;
        }

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

    function routeNotification(response: Notifications.NotificationResponse) {
        if (status === 'initializing') {
            pendingNotificationRef.current = response;
            return;
        }
        processNotification(response);
    }

    useEffect(() => {
        setupAndroidChannel();

        // Handles foreground, background, and cold-launch taps.
        // expo-notifications 0.32 queues the initial response on iOS so the
        // listener receives it even when the app was fully killed.
        const sub = Notifications.addNotificationResponseReceivedListener(routeNotification);
        return () => sub.remove();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Replay a deep link that arrived before auth status had resolved.
    useEffect(() => {
        if (status === 'initializing') return;
        const pending = pendingNotificationRef.current;
        if (!pending) return;
        pendingNotificationRef.current = null;
        processNotification(pending);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [status]);

    // Global protected-route enforcement. Deliberately narrow: only ever
    // force-navigates *away* from a non-public route when the session is
    // known to be invalid/tombstoned/roleless — it never tries to route a
    // signed-in user *forward* (that stays each entry screen's own job, so
    // this doesn't become a second, competing "where should a logged-in
    // user land" decision-maker).
    useEffect(() => {
        if (status === 'initializing') return;
        if (PUBLIC_ROUTES.has(pathname)) return;

        if (status === 'profile_missing') {
            if (pathname !== PROFILE_RECOVERY_ROUTE) router.replace('/choose-role');
            return;
        }

        if (status === 'unauthenticated' || status === 'account_deleted') {
            router.replace('/signin');
        }
    }, [status, pathname]);

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
