import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    AppState,
    AppStateStatus,
    Linking,
    Platform,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { OfflineBanner, SectionErrorState, announceStateChange } from '@/components/StateViews';
import { SettingsSheet } from '@/components/settings-sheet';
import { RADIUS, SHADOW, SPACING, ThemeColors } from '@/constants/theme';
import { clearAccountScopedLocalState } from '@/lib/accountCleanup';
import { ErrorCategory, classifyScreenError } from '@/lib/asyncStateCore';
import { ERROR_CATEGORY_TRANSLATION_KEYS } from '@/lib/errorClassification';
import { useLanguage, useStatusLabel } from '@/lib/i18n/context';
import { useThemeColors } from '@/lib/theme';
import { useRequestGeneration } from '@/lib/useRequestGeneration';
import { supabase } from '@/lib/supabase';
import {
    cancelReminderOccurrenceNotification,
    getNotificationPreviewMode,
    isRecipientServerPushEnabled,
    registerPushToken,
    requestNotificationPermissions,
    scheduleSnoozeNotification,
    syncRecipientReminderNotifications,
} from '@/lib/notifications';
import { syncCurrentUserTimezone } from '@/lib/timezone';
import { isDueOnDate } from '@/lib/frequency';
import { showAlertOnce } from '@/lib/alertGuard';
import { REMINDER_ERROR_TRANSLATION_KEYS } from '@/lib/reminderErrors';
import { respondToReminderOccurrence } from '@/lib/reminderLifecycle';
import { getFirstEligibleDateString, isPastNoResponseWindow } from '@/lib/reminderStatus';

type ReminderStatus = 'pending' | 'taken' | 'snoozed' | 'skipped' | 'missed';

type Reminder = {
    id: string;
    connection_id: string;
    caregiver_id: string;
    recipient_id: string;
    title: string;
    reminder_type: string;
    notes: string | null;
    time_of_day: string;
    frequency: 'daily' | 'weekdays' | 'weekends' | 'custom';
    days_of_week: number[];
    no_response_minutes: number;
    created_at: string;
    today_status?: ReminderStatus;
    snoozed_until?: string | null;
};

const TYPE_ICONS: Record<string, string> = {
    medication:  '💊',
    hydration:   '💧',
    appointment: '📅',
    meal:        '🍽️',
    exercise:    '🏃',
    other:       '•',
};

const TYPE_LABEL_KEYS: Record<string, string> = {
    medication:  'reminderForm.typeMedication',
    hydration:   'reminderForm.typeHydration',
    appointment: 'reminderForm.typeAppointment',
    meal:        'reminderForm.typeMeal',
    exercise:    'reminderForm.typeExercise',
    other:       'reminderForm.typeOther',
};

// ─── Pure helpers (unchanged) ────────────────────────────────────────────────

function getTodayDateString() {
    const today = new Date();
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
}

function formatTime(time: string) {
    const [hourString, minuteString] = time.split(':');
    let hour = Number(hourString);
    const suffix = hour >= 12 ? 'PM' : 'AM';
    if (hour === 0) hour = 12;
    if (hour > 12) hour -= 12;
    return `${hour}:${minuteString} ${suffix}`;
}

function shouldShowToday(daysOfWeek: number[]) {
    return isDueOnDate(daysOfWeek, new Date());
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function getStatusColors(status: ReminderStatus | undefined, C: ThemeColors) {
    if (status === 'taken')   return { bg: '#DCFCE7', text: '#15803D', accent: C.success };
    if (status === 'missed')  return { bg: '#FEE2E2', text: '#B91C1C', accent: C.error };
    if (status === 'skipped') return { bg: '#FEF3C7', text: '#B45309', accent: '#D97706' };
    if (status === 'snoozed') return { bg: '#DBEAFE', text: '#1D4ED8', accent: C.primary };
    return { bg: C.bgAlt, text: C.textMuted, accent: C.border };
}

function formatDayLabel(locale: string) {
    return new Date().toLocaleDateString(locale, {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
    });
}

function getGreeting(t: (key: string) => string): string {
    const hour = new Date().getHours();
    if (hour < 5)  return t('participantDashboard.goodNight');
    if (hour < 12) return t('participantDashboard.goodMorning');
    if (hour < 17) return t('participantDashboard.goodAfternoon');
    return t('participantDashboard.goodEvening');
}

function getTimeHint(reminder: Reminder, t: (key: string, vars?: Record<string, string | number>) => string): string | null {
    const status = reminder.today_status;

    if (status === 'snoozed' && reminder.snoozed_until) {
        const until = new Date(reminder.snoozed_until);
        if (until.getTime() <= Date.now()) return t('participantDashboard.snoozeEnded');
        const h = until.getHours();
        const m = until.getMinutes();
        const suffix = h >= 12 ? 'PM' : 'AM';
        const displayH = h === 0 ? 12 : h > 12 ? h - 12 : h;
        return t('participantDashboard.until', { time: `${displayH}:${String(m).padStart(2, '0')} ${suffix}` });
    }

    if (status === 'pending') {
        const [rh, rm] = reminder.time_of_day.split(':').map(Number);
        const today = new Date();
        const scheduled = new Date(today.getFullYear(), today.getMonth(), today.getDate(), rh, rm, 0, 0);
        const diffMin = Math.round((scheduled.getTime() - Date.now()) / 60000);

        if (diffMin > 60) {
            const hrs  = Math.floor(diffMin / 60);
            const mins = diffMin % 60;
            return mins > 0
                ? t('participantDashboard.inHoursMinutes', { h: hrs, m: mins })
                : t('participantDashboard.inHours', { h: hrs });
        }
        if (diffMin > 1)  return t('participantDashboard.inMinutes', { n: diffMin });
        if (diffMin >= 0) return t('participantDashboard.now');

        // Past scheduled time but still inside the response window
        const missedAt   = new Date(scheduled.getTime() + reminder.no_response_minutes * 60 * 1000);
        const windowLeft = Math.round((missedAt.getTime() - Date.now()) / 60000);
        if (windowLeft > 0) return t('participantDashboard.minLeft', { n: windowLeft });
    }

    return null;
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function RecipientDashboard() {
    const C = useThemeColors();
    const { t, language } = useLanguage();
    const formatStatus = useStatusLabel();
    const styles = useMemo(() => createStyles(C), [C]);
    const [reminders, setReminders]               = useState<Reminder[]>([]);
    const [loading, setLoading]                   = useState(true);
    const [refreshing, setRefreshing]             = useState(false);
    // Set only when a fetch fails — reminders/hasConnection are left
    // exactly as they were (never cleared), so a background refresh
    // failure never blanks out already-visible, still-valid data. Only
    // rendered as a full-screen ErrorState when there is truly nothing to
    // show yet (first load failed); otherwise shown as a compact
    // SectionErrorState above the still-visible list.
    const [loadError, setLoadError]               = useState<ErrorCategory | null>(null);
    const [savingReminderId, setSavingReminderId] = useState<string | null>(null);
    const [settingsVisible, setSettingsVisible]   = useState(false);
    const [notifDenied, setNotifDenied]           = useState(false);
    // null while unknown; distinguishes "never connected to an organizer"
    // from "connected, nothing due right now" for the empty state below —
    // both used to show the identical "All clear" copy, which stranded a
    // recipient who backed out of join-invite with no way back in.
    const [hasConnection, setHasConnection]       = useState<boolean | null>(null);
    // True when this recipient has no *currently* accepted connection but
    // has at least one past connection row with status 'ended' — distinct
    // from "never connected," which otherwise shows an identical
    // "no connection yet" screen with no acknowledgment that a connection
    // existed and ended (organizer- or participant-initiated).
    const [connectionEnded, setConnectionEnded]   = useState(false);
    // True once the organizer has created at least one active reminder,
    // regardless of whether any is due today — distinguishes "organizer
    // hasn't set anything up yet" from "reminders exist, just none today,"
    // which previously shared the identical "All clear" empty state.
    const [hasAnyReminders, setHasAnyReminders]   = useState(false);
    // Reset on every new load attempt (not just on dismiss) so a banner
    // dismissed while still offline reappears on the very next failed
    // request rather than staying permanently hidden for this session.
    const [offlineDismissed, setOfflineDismissed] = useState(false);
    const appStateRef = useRef<AppStateStatus>(AppState.currentState);
    const pushRegistrationAttemptedRef = useRef(false);
    const hasLoadedOnceRef = useRef(false);
    const { start: startLoad, isCurrent: isLoadCurrent } = useRequestGeneration();

    async function loadReminders() {
        const generation = startLoad();
        // First load (no data on screen yet) shows the full loading card;
        // every subsequent call (focus refetch, pull-to-refresh, AppState
        // foreground) is a "refresh" — existing reminders stay visible the
        // whole time, with only a discreet indicator.
        if (hasLoadedOnceRef.current) setRefreshing(true); else setLoading(true);
        // Captured before clearing, so a load that recovers from a prior
        // error/offline banner can announce that fact to VoiceOver once the
        // banner itself disappears (it has no live region of its own once
        // it's gone — see components/StateViews.tsx's announceStateChange).
        const wasRecoveringFromError = loadError !== null;
        setLoadError(null);
        setOfflineDismissed(false);

        const { data: { user }, error: userError } = await supabase.auth.getUser();

        if (userError || !user) {
            setLoading(false);
            setRefreshing(false);
            router.replace('/signin');
            return;
        }

        // A tombstoned account must never reach reminder data, even if a
        // technically-valid session slipped through (e.g. Auth deletion
        // partially failed upstream but the profile tombstone is already
        // in place). No timezone sync, no push registration, no
        // notification sync — this returns before any of that runs.
        const { data: statusRow } = await supabase
            .from('profiles')
            .select('account_status')
            .eq('id', user.id)
            .maybeSingle();

        if (statusRow?.account_status === 'deleted') {
            setLoading(false);
            setRefreshing(false);
            await clearAccountScopedLocalState().catch(() => {});
            await supabase.auth.signOut().catch(() => {});
            router.replace('/signin');
            return;
        }

        if (!isLoadCurrent(generation)) return; // a newer load has since started

        const { data: connectionRows } = await supabase
            .from('connections')
            .select('status')
            .eq('recipient_id', user.id);
        const hasAccepted = (connectionRows ?? []).some((c) => c.status === 'accepted');
        setHasConnection(hasAccepted);
        setConnectionEnded(!hasAccepted && (connectionRows ?? []).some((c) => c.status === 'ended'));

        // Reconcile this device's timezone every load (not just once) — a
        // recipient who travels needs their stored profiles.timezone to
        // follow their current device, since that's what the server-side
        // delivery/missed-detection functions resolve reminder times
        // against. Cheap no-op when unchanged; fire-and-forget so a slow or
        // unavailable network never blocks the dashboard from rendering.
        // Runs before push (re)registration, matching this device's own
        // current identity being established first.
        syncCurrentUserTimezone().catch(console.warn);

        if (!pushRegistrationAttemptedRef.current) {
            pushRegistrationAttemptedRef.current = true;
            registerPushToken(user.id)
                .then((result) => {
                    if (!result.ok) console.warn('[RecipientDashboard] push registration failed', result);
                })
                .catch(console.warn);
        }

        const { data, error } = await supabase
            .from('reminders')
            .select('id, connection_id, caregiver_id, recipient_id, title, reminder_type, notes, time_of_day, frequency, days_of_week, no_response_minutes, created_at')
            .eq('recipient_id', user.id)
            .eq('is_active', true)
            .order('time_of_day', { ascending: true });

        if (!isLoadCurrent(generation)) return;

        if (error) {
            // Never a raw Postgres string, and never clears an already-
            // visible reminder list — a failed background refresh leaves
            // whatever was last showing intact, with a compact retryable
            // notice instead of replacing the whole screen.
            setLoading(false);
            setRefreshing(false);
            hasLoadedOnceRef.current = true;
            setLoadError(classifyScreenError(error.message));
            return;
        }

        const granted = await requestNotificationPermissions();
        setNotifDenied(!granted);

        // Reconcile this device's scheduled local notifications against
        // current server state on every load — this is what cancels a
        // reminder's stale notification once the caregiver has deleted it
        // and this device has synced. See lib/notifications.ts.
        if (granted) {
            syncRecipientReminderNotifications().catch(console.warn);
        }

        const todayDate = getTodayDateString();
        setHasAnyReminders((data || []).length > 0);

        // Exclude reminders not yet eligible today — a reminder created today
        // after its scheduled time-of-day already passed shouldn't be treated
        // as missed; its first occurrence is tomorrow.
        const todaysReminders = (data || []).filter((r) =>
            shouldShowToday(r.days_of_week) &&
            getFirstEligibleDateString(r.created_at, r.time_of_day) <= todayDate
        );

        if (todaysReminders.length === 0) {
            if (!isLoadCurrent(generation)) return;
            setReminders([]);
            setLoading(false);
            setRefreshing(false);
            hasLoadedOnceRef.current = true;
            if (wasRecoveringFromError) announceStateChange(t('stateViews.backToNormal'));
            return;
        }

        const reminderIds = todaysReminders.map((r) => r.id);

        const { data: logs, error: logsError } = await supabase
            .from('reminder_logs')
            .select('reminder_id, status, snoozed_until')
            .eq('recipient_id', user.id)
            .eq('occurrence_date', todayDate)
            .in('reminder_id', reminderIds);

        if (!isLoadCurrent(generation)) return;

        if (logsError) {
            setLoading(false);
            setRefreshing(false);
            hasLoadedOnceRef.current = true;
            setLoadError(classifyScreenError(logsError.message));
            return;
        }

        const remindersWithStatus = todaysReminders.map((reminder) => {
            const matchingLog  = logs?.find((log) => log.reminder_id === reminder.id);
            const logStatus    = matchingLog?.status as ReminderStatus | undefined;
            const snoozedUntil = (matchingLog as any)?.snoozed_until as string | null | undefined;

            // Keep any terminal status (taken / snoozed / skipped / missed already in DB).
            if (logStatus && logStatus !== 'pending') {
                return { ...reminder, today_status: logStatus, snoozed_until: snoozedUntil ?? null };
            }
            // No log yet, or still pending — check if the response window has expired.
            const today_status: ReminderStatus = isPastNoResponseWindow(
                reminder.time_of_day,
                reminder.no_response_minutes
            )
                ? 'missed'
                : 'pending';
            return { ...reminder, today_status, snoozed_until: null };
        });

        if (!isLoadCurrent(generation)) return;

        setReminders(remindersWithStatus);
        setLoading(false);
        setRefreshing(false);
        hasLoadedOnceRef.current = true;
        if (wasRecoveringFromError) announceStateChange(t('stateViews.backToNormal'));

        // 'missed' above is a client-computed DISPLAY status only — this
        // dashboard no longer writes it to reminder_logs itself. The
        // server cron (sync_missed_reminders_db, every 5 minutes) is now
        // the sole authority that persists a missed transition, atomically
        // and race-safe against a concurrent response
        // (respond_to_reminder_occurrence). The previous client-side write
        // here used a read-then-write check that wasn't atomic with the
        // actual upsert, which could in principle race a genuine response
        // arriving at nearly the same moment; removing it doesn't change
        // what the recipient sees (still computed instantly, same as
        // before), only who is allowed to persist it. See
        // docs/reminder-state-model.md.
    }

    useFocusEffect(useCallback(() => { loadReminders(); }, []));

    // Reconcile local notifications the moment the app comes back to the
    // foreground — this is the path that catches a caregiver deletion that
    // happened while this device was backgrounded, without waiting for the
    // recipient to also re-focus the dashboard screen itself. Single
    // listener for the component's lifetime; never re-subscribed.
    useEffect(() => {
        const subscription = AppState.addEventListener('change', (nextState: AppStateStatus) => {
            if (/inactive|background/.test(appStateRef.current) && nextState === 'active') {
                // Timezone first (e.g. the recipient landed after a flight),
                // then reconcile notifications against current server state.
                syncCurrentUserTimezone()
                    .catch(console.warn)
                    .finally(() => {
                        syncRecipientReminderNotifications().catch(console.warn);
                    });
            }
            appStateRef.current = nextState;
        });
        return () => subscription.remove();
    }, []);

    async function saveReminderAction(reminder: Reminder, status: 'taken' | 'skipped' | 'snoozed') {
        // The action buttons are swapped out for a "saving" box while
        // savingReminderId is set, but that swap only takes effect on the
        // next render -- this synchronous guard is the real protection
        // against a rapid double-tap of the same card queuing two RPCs.
        if (savingReminderId === reminder.id) return;
        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        setSavingReminderId(reminder.id);

        const todayDate = getTodayDateString();

        // The server (respond_to_reminder_occurrence) is the sole author
        // of the persisted log — it validates ownership, reminder.is_active,
        // connection.status, occurrence eligibility, and legal state
        // transitions, and computes occurrence_date/scheduled_for/
        // snoozed_until itself from the recipient's own stored timezone
        // rather than trusting anything the client sends. See
        // lib/reminderLifecycle.ts and docs/reminder-state-model.md.
        const result = await respondToReminderOccurrence(reminder.id, status);

        setSavingReminderId(null);

        if (!result.ok) {
            showAlertOnce(t('participantDashboard.saveErrorTitle'), t(REMINDER_ERROR_TRANSLATION_KEYS[result.kind]));
            return;
        }

        const snoozedUntil = result.log.snoozed_until;

        // A real response now exists for today — cancel only today's
        // occurrence notification. Future occurrences are untouched.
        cancelReminderOccurrenceNotification(reminder.id, todayDate).catch(console.warn);

        // Snoozing gets its own one-shot re-alert at the snooze deadline.
        // Server-authoritative recipients get this from
        // claim_due_recipient_snooze_deliveries() instead (reminder_logs
        // .snoozed_until is the only state that matters there) — scheduling
        // a local one too would risk a duplicate alert.
        if (status === 'snoozed' && snoozedUntil && !(await isRecipientServerPushEnabled())) {
            const mode = await getNotificationPreviewMode();
            scheduleSnoozeNotification(
                { id: reminder.id, title: reminder.title, reminder_type: reminder.reminder_type },
                todayDate,
                snoozedUntil,
                mode
            ).catch(console.warn);
        }

        // Full reconcile as a catch-all — cheap and idempotent, and covers
        // any reminder deletions that landed on this device in the moments
        // around this response.
        syncRecipientReminderNotifications().catch(console.warn);

        setReminders((current) =>
            current.map((r) =>
                r.id === reminder.id ? { ...r, today_status: result.log.status } : r
            )
        );
    }

    return (
        <SafeAreaView style={styles.container}>
            <ScrollView
                contentContainerStyle={styles.content}
                showsVerticalScrollIndicator={false}
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={loadReminders}
                        tintColor={C.primary}
                        colors={[C.primary]}
                    />
                }
            >
                {/* Header */}
                <View style={styles.header}>
                    <View style={styles.headerTextBlock}>
                        <Text style={styles.heading} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.85}>
                            {getGreeting(t)}
                        </Text>
                        <Text style={styles.subheading} numberOfLines={1}>
                            {formatDayLabel(language === 'es' ? 'es-ES' : 'en-US')}
                        </Text>
                    </View>
                    <TouchableOpacity
                        style={styles.alertIconButton}
                        onPress={() => setSettingsVisible(true)}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                        <Ionicons name="settings-outline" size={22} color={C.primary} />
                    </TouchableOpacity>
                </View>

                {/* Today's progress summary */}
                {!loading && reminders.length > 0 && (() => {
                    const done  = reminders.filter((r) => r.today_status === 'taken' || r.today_status === 'skipped').length;
                    const total = reminders.length;
                    const pct   = total === 0 ? 0 : Math.round((done / total) * 100);
                    return (
                        <View style={[styles.progressCard, SHADOW.xs]}>
                            <View style={styles.progressTextRow}>
                                <Text style={styles.progressLabel}>
                                    {done === total
                                        ? t('participantDashboard.allDoneToday')
                                        : t('participantDashboard.doneOfTotalToday', { done, total })}
                                </Text>
                                <Text style={styles.progressPct}>{pct}%</Text>
                            </View>
                            <View style={styles.progressTrack}>
                                <View
                                    style={[
                                        styles.progressFill,
                                        { width: `${pct}%`, backgroundColor: done === total ? C.success : C.primary },
                                    ]}
                                />
                            </View>
                        </View>
                    );
                })()}

                {/* Notification permission denied notice */}
                {notifDenied && !loading && (
                    <View style={styles.notifDeniedBanner}>
                        <Ionicons name="notifications-off-outline" size={16} color="#92400E" />
                        <Text style={styles.notifDeniedText}>
                            {t('participantDashboard.notifDeniedText')}
                        </Text>
                        <TouchableOpacity
                            onPress={() => Linking.openSettings()}
                            accessibilityRole="button"
                            accessibilityLabel={t('participantDashboard.notifDeniedOpenSettings')}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        >
                            <Text style={styles.notifDeniedAction}>{t('participantDashboard.notifDeniedOpenSettings')}</Text>
                        </TouchableOpacity>
                    </View>
                )}

                {/* Loading state — first load only; a background refresh
                    never replaces the already-visible list with this. */}
                {loading && (
                    <View style={[styles.emptyCard, SHADOW.xs]}>
                        <View style={styles.emptyIconWrap}>
                            <ActivityIndicator color={C.primary} size="large" />
                        </View>
                        <Text style={styles.emptyTitle}>{t('participantDashboard.loadingReminders')}</Text>
                        <Text style={styles.emptyText}>{t('participantDashboard.justAMoment')}</Text>
                    </View>
                )}

                {/* Load error — a compact, retryable notice that never
                    replaces or clears an already-visible reminder list
                    (reminders/hasConnection are left untouched on failure). */}
                {!loading && loadError === 'network' && !offlineDismissed && (
                    <OfflineBanner onDismiss={() => setOfflineDismissed(true)} />
                )}
                {!loading && loadError && loadError !== 'network' && (
                    <SectionErrorState
                        text={t(ERROR_CATEGORY_TRANSLATION_KEYS[loadError])}
                        onRetry={loadReminders}
                        retrying={refreshing}
                    />
                )}

                {/* Empty state — a connection existed and has since ended
                    (by either party). Distinct from "never connected" so a
                    recipient isn't left wondering what happened to their
                    organizer with no acknowledgment anything changed. */}
                {!loading && !loadError && reminders.length === 0 && hasConnection === false && connectionEnded && (
                    <View style={[styles.emptyCard, SHADOW.xs]}>
                        <View style={styles.emptyIconWrap}>
                            <Ionicons name="link-outline" size={32} color={C.textMuted} />
                        </View>
                        <Text style={styles.emptyTitle}>{t('participantDashboard.connectionEndedTitle')}</Text>
                        <Text style={styles.emptyText}>
                            {t('participantDashboard.connectionEndedText')}
                        </Text>
                        <TouchableOpacity
                            style={styles.emptyActionButton}
                            onPress={() => router.push('/join-invite')}
                            activeOpacity={0.88}
                            accessibilityRole="button"
                            accessibilityLabel={t('participantDashboard.notConnectedAction')}
                        >
                            <Text style={styles.emptyActionButtonText}>{t('participantDashboard.notConnectedAction')}</Text>
                        </TouchableOpacity>
                    </View>
                )}

                {/* Empty state — not connected to any organizer yet.
                    Suppressed while loadError is set so a failed fetch is
                    never misread as "genuinely not connected." */}
                {!loading && !loadError && reminders.length === 0 && hasConnection === false && !connectionEnded && (
                    <View style={[styles.emptyCard, SHADOW.xs]}>
                        <View style={styles.emptyIconWrap}>
                            <Ionicons name="link-outline" size={32} color={C.primary} />
                        </View>
                        <Text style={styles.emptyTitle}>{t('participantDashboard.notConnectedTitle')}</Text>
                        <Text style={styles.emptyText}>
                            {t('participantDashboard.notConnectedText')}
                        </Text>
                        <TouchableOpacity
                            style={styles.emptyActionButton}
                            onPress={() => router.push('/join-invite')}
                            activeOpacity={0.88}
                            accessibilityRole="button"
                            accessibilityLabel={t('participantDashboard.notConnectedAction')}
                        >
                            <Text style={styles.emptyActionButtonText}>{t('participantDashboard.notConnectedAction')}</Text>
                        </TouchableOpacity>
                    </View>
                )}

                {/* Empty state — connected, organizer hasn't created any
                    reminders at all yet (distinct from "nothing due today"
                    below, which implies reminders exist but aren't
                    scheduled for right now). */}
                {!loading && !loadError && reminders.length === 0 && hasConnection !== false && !hasAnyReminders && (
                    <View style={[styles.emptyCard, SHADOW.xs]}>
                        <View style={styles.emptyIconWrap}>
                            <Text style={styles.emptyEmoji}>🕊️</Text>
                        </View>
                        <Text style={styles.emptyTitle}>{t('participantDashboard.noRemindersSetUpTitle')}</Text>
                        <Text style={styles.emptyText}>
                            {t('participantDashboard.noRemindersSetUpText')}
                        </Text>
                    </View>
                )}

                {/* Empty state — connected, reminders exist, nothing due today */}
                {!loading && !loadError && reminders.length === 0 && hasConnection !== false && hasAnyReminders && (
                    <View style={[styles.emptyCard, SHADOW.xs]}>
                        <View style={styles.emptyIconWrap}>
                            <Text style={styles.emptyEmoji}>🕊️</Text>
                        </View>
                        <Text style={styles.emptyTitle}>{t('participantDashboard.allClearTitle')}</Text>
                        <Text style={styles.emptyText}>
                            {t('participantDashboard.allClearText')}
                        </Text>
                    </View>
                )}

                {/* Reminder cards */}
                {!loading && reminders.map((reminder) => {
                    const isSaving   = savingReminderId === reminder.id;
                    const statusInfo = getStatusColors(reminder.today_status, C);
                    const typeIcon   = TYPE_ICONS[reminder.reminder_type] ?? '•';

                    return (
                        <TouchableOpacity
                            key={reminder.id}
                            style={[styles.reminderCard, SHADOW.sm]}
                            onPress={() => {
                                if (!isSaving) {
                                    router.push({ pathname: '/reminder-alert', params: { reminderId: reminder.id } });
                                }
                            }}
                            activeOpacity={0.95}
                        >
                            {/* Top accent bar — color-coded by status */}
                            <View style={[styles.cardAccentBar, { backgroundColor: statusInfo.accent }]} />

                            {/* Type + time row */}
                            <View style={styles.cardTopRow}>
                                <View style={styles.typePill}>
                                    <Text style={styles.typePillEmoji}>{typeIcon}</Text>
                                    <Text style={styles.typePillText}>
                                        {TYPE_LABEL_KEYS[reminder.reminder_type] ? t(TYPE_LABEL_KEYS[reminder.reminder_type]) : reminder.reminder_type}
                                    </Text>
                                </View>
                                <Text style={styles.timeText}>{formatTime(reminder.time_of_day)}</Text>
                            </View>

                            {/* Title */}
                            <Text style={styles.reminderTitle}>{reminder.title}</Text>

                            {/* Notes */}
                            {reminder.notes ? (
                                <Text style={styles.notes}>{reminder.notes}</Text>
                            ) : (
                                <Text style={styles.notesMuted}>{t('participantDashboard.noNotesFromOrganizer')}</Text>
                            )}

                            {/* Status row */}
                            {(() => {
                                const timeHint = getTimeHint(reminder, t);
                                return (
                                    <View style={styles.statusRow}>
                                        <Text style={styles.statusLabel}>{t('participantDashboard.todaysStatus')}</Text>
                                        <View style={styles.statusRight}>
                                            {timeHint ? (
                                                <Text style={styles.timeHint}>{timeHint}</Text>
                                            ) : null}
                                            <View style={[styles.statusPill, { backgroundColor: statusInfo.bg }]}>
                                                <Text style={[styles.statusPillText, { color: statusInfo.text }]}>
                                                    {formatStatus(reminder.today_status ?? 'pending')}
                                                </Text>
                                            </View>
                                        </View>
                                    </View>
                                );
                            })()}

                            {/* Action buttons */}
                            {isSaving ? (
                                <View style={[styles.savingBox, SHADOW.xs]}>
                                    <ActivityIndicator color={C.primary} />
                                    <Text style={styles.savingText}>{t('participantDashboard.saving')}</Text>
                                </View>
                            ) : reminder.today_status === 'taken' ? (
                                <View style={styles.respondedBox}>
                                    <Ionicons name="checkmark-circle" size={20} color={C.success} />
                                    <Text style={[styles.respondedText, { color: C.success }]}>{t('participantDashboard.markedCompleted')}</Text>
                                </View>
                            ) : reminder.today_status === 'skipped' ? (
                                <View style={styles.respondedBox}>
                                    <Ionicons name="remove-circle-outline" size={20} color={C.textMuted} />
                                    <Text style={[styles.respondedText, { color: C.textMuted }]}>{t('participantDashboard.skippedForToday')}</Text>
                                </View>
                            ) : (
                                <View style={styles.actionArea}>
                                    {/* Primary action — Done */}
                                    <TouchableOpacity
                                        style={[styles.takenButton, SHADOW.sm]}
                                        onPress={() => saveReminderAction(reminder, 'taken')}
                                        activeOpacity={0.88}
                                    >
                                        <Ionicons name="checkmark-circle" size={22} color="#FFFFFF" />
                                        <Text style={styles.takenButtonText}>{t('participantDashboard.done')}</Text>
                                    </TouchableOpacity>

                                    {/* Secondary actions */}
                                    <View style={styles.secondaryButtonRow}>
                                        <TouchableOpacity
                                            style={styles.laterButton}
                                            onPress={() => saveReminderAction(reminder, 'snoozed')}
                                            activeOpacity={0.8}
                                        >
                                            <Ionicons name="time-outline" size={18} color="#92400E" />
                                            <Text style={styles.laterButtonText}>{t('participantDashboard.later')}</Text>
                                        </TouchableOpacity>

                                        <TouchableOpacity
                                            style={styles.skipButton}
                                            onPress={() => saveReminderAction(reminder, 'skipped')}
                                            activeOpacity={0.7}
                                        >
                                            <Text style={styles.skipButtonText}>{t('participantDashboard.skip')}</Text>
                                        </TouchableOpacity>
                                    </View>
                                </View>
                            )}
                        </TouchableOpacity>
                    );
                })}
            </ScrollView>

            <SettingsSheet
                visible={settingsVisible}
                onClose={() => setSettingsVisible(false)}
                onConnectionEnded={loadReminders}
            />
        </SafeAreaView>
    );
}

const createStyles = (C: ThemeColors) => StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: C.bgPage,
    },
    content: {
        paddingHorizontal: SPACING.screen,
        paddingTop: 8,
        paddingBottom: 48,
    },

    // ── Header ────────────────────────────────────────────────────────
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: SPACING.section,
        paddingTop: 8,
        gap: 12,
    },
    headerTextBlock: { flex: 1 },
    heading: {
        fontSize: 27,
        fontWeight: '800',
        color: C.textPrimary,
        letterSpacing: -0.6,
        lineHeight: 32,
    },
    subheading: {
        fontSize: 14,
        color: C.textMuted,
        marginTop: 2,
        letterSpacing: -0.1,
    },
    alertIconButton: {
        width: 44,
        height: 44,
        borderRadius: RADIUS.lg,
        backgroundColor: C.primaryLight,
        justifyContent: 'center',
        alignItems: 'center',
    },

    // ── Progress summary ───────────────────────────────────────────────
    progressCard: {
        backgroundColor: C.bgSurface,
        borderRadius: RADIUS.lg,
        padding: 16,
        marginBottom: 16,
    },
    progressTextRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 10,
    },
    progressLabel: {
        fontSize: 14,
        fontWeight: '700',
        color: C.textPrimary,
        letterSpacing: -0.1,
    },
    progressPct: {
        fontSize: 14,
        fontWeight: '700',
        color: C.textMuted,
    },
    progressTrack: {
        height: 6,
        borderRadius: RADIUS.full,
        backgroundColor: C.bgAlt,
        overflow: 'hidden',
    },
    progressFill: {
        height: '100%',
        borderRadius: RADIUS.full,
    },

    // ── Empty / loading state ─────────────────────────────────────────
    emptyCard: {
        backgroundColor: C.bgSurface,
        borderRadius: RADIUS.xl,
        padding: 32,
        alignItems: 'center',
        marginTop: 8,
    },
    emptyIconWrap: {
        width: 72,
        height: 72,
        borderRadius: RADIUS.xl,
        backgroundColor: C.bgAlt,
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: 16,
    },
    emptyEmoji: {
        fontSize: 36,
    },
    emptyTitle: {
        fontSize: 20,
        fontWeight: '700',
        color: C.textPrimary,
        letterSpacing: -0.3,
        marginBottom: 8,
        textAlign: 'center',
    },
    emptyText: {
        fontSize: 15,
        color: C.textMuted,
        lineHeight: 22,
        textAlign: 'center',
    },

    // ── Reminder card ─────────────────────────────────────────────────
    reminderCard: {
        backgroundColor: C.bgSurface,
        borderRadius: RADIUS.xl,
        padding: 20,
        marginBottom: 16,
        overflow: 'hidden',
    },
    cardAccentBar: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: 4,
    },
    cardTopRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 14,
        marginTop: 8,
    },
    typePill: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        backgroundColor: C.primaryLight,
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: RADIUS.full,
    },
    typePillEmoji: {
        fontSize: 13,
    },
    typePillText: {
        color: C.primary,
        fontSize: 13,
        fontWeight: '700',
    },
    timeText: {
        fontSize: 17,
        color: C.textPrimary,
        fontWeight: '700',
        letterSpacing: -0.2,
    },
    reminderTitle: {
        fontSize: 26,
        fontWeight: '800',
        color: C.textPrimary,
        letterSpacing: -0.5,
        lineHeight: 32,
        marginBottom: 10,
    },
    notes: {
        fontSize: 16,
        color: C.textSecondary,
        lineHeight: 23,
        marginBottom: 16,
    },
    notesMuted: {
        fontSize: 15,
        color: C.textMuted,
        lineHeight: 22,
        marginBottom: 16,
    },

    // ── Status row ────────────────────────────────────────────────────
    statusRow: {
        backgroundColor: C.bgAlt,
        borderRadius: RADIUS.md,
        paddingVertical: 10,
        paddingHorizontal: 14,
        marginBottom: 16,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    statusLabel: {
        fontSize: 13,
        color: C.textMuted,
        fontWeight: '600',
    },
    statusRight: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    timeHint: {
        fontSize: 12,
        color: C.textMuted,
        fontWeight: '500',
    },
    statusPill: {
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: RADIUS.full,
    },
    statusPillText: {
        fontSize: 13,
        fontWeight: '700',
    },

    // ── Saving state ──────────────────────────────────────────────────
    savingBox: {
        backgroundColor: C.bgAlt,
        borderRadius: RADIUS.lg,
        paddingVertical: 18,
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 10,
    },
    savingText: {
        fontSize: 15,
        color: C.textMuted,
        fontWeight: '600',
    },

    // ── Action buttons ────────────────────────────────────────────────
    actionArea: {
        gap: 10,
    },
    takenButton: {
        backgroundColor: C.success,
        paddingVertical: 18,
        borderRadius: RADIUS.xl,
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 10,
    },
    takenButtonText: {
        color: '#FFFFFF',
        fontSize: 18,
        fontWeight: '700',
        letterSpacing: -0.2,
    },
    secondaryButtonRow: {
        flexDirection: 'row',
        gap: 10,
    },
    laterButton: {
        flex: 1,
        backgroundColor: '#FEF3C7',
        paddingVertical: 15,
        borderRadius: RADIUS.xl,
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 7,
        borderWidth: 1,
        borderColor: '#FDE68A',
    },
    laterButtonText: {
        color: '#92400E',
        fontSize: 16,
        fontWeight: '700',
    },
    skipButton: {
        flex: 1,
        backgroundColor: C.bgAlt,
        paddingVertical: 15,
        borderRadius: RADIUS.xl,
        alignItems: 'center',
        justifyContent: 'center',
    },
    skipButtonText: {
        color: C.textSecondary,
        fontSize: 16,
        fontWeight: '600',
    },

    // ── Notification denied banner ─────────────────────────────────────
    notifDeniedBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        backgroundColor: '#FEF3C7',
        borderRadius: RADIUS.md,
        borderWidth: 1,
        borderColor: '#FDE68A',
        paddingVertical: 12,
        paddingHorizontal: 14,
        marginBottom: 16,
    },
    notifDeniedText: {
        flex: 1,
        fontSize: 13,
        color: '#92400E',
        fontWeight: '500',
        lineHeight: 18,
    },
    notifDeniedAction: {
        fontSize: 13,
        fontWeight: '700',
        color: '#92400E',
        textDecorationLine: 'underline',
    },
    emptyActionButton: {
        backgroundColor: C.primary,
        paddingVertical: 14,
        paddingHorizontal: 24,
        borderRadius: RADIUS.xl,
        marginTop: 16,
        minHeight: 44,
        justifyContent: 'center',
    },
    emptyActionButtonText: {
        color: C.textInverse,
        fontSize: 15,
        fontWeight: '700',
    },

    // ── Already-responded state ───────────────────────────────────────
    respondedBox: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        paddingVertical: 16,
        backgroundColor: C.bgAlt,
        borderRadius: RADIUS.xl,
    },
    respondedText: {
        fontSize: 15,
        fontWeight: '600',
    },
});
