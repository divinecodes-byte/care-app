import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Animated,
    Platform,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RADIUS, SHADOW, T } from '@/constants/theme';
import { useTranslation, useStatusLabel } from '@/lib/i18n/context';
import {
    cancelAllReminderNotifications,
    cancelReminderOccurrenceNotification,
    isRecipientServerPushEnabled,
    scheduleSnoozeNotification,
    syncRecipientReminderNotifications,
} from '@/lib/notifications';
import { getFirstEligibleDateString, isPastNoResponseWindow } from '@/lib/reminderStatus';
import { supabase } from '@/lib/supabase';

// ─── Types ────────────────────────────────────────────────────────────────────

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
    frequency: string;
    no_response_minutes: number;
    is_active: boolean;
    created_at: string;
};

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function getTodayDateString(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function buildScheduledForIso(time: string): string {
    const [h, m] = time.split(':');
    const d = new Date();
    d.setHours(Number(h), Number(m), 0, 0);
    return d.toISOString();
}

function buildSnoozedUntilIso(minutes = 10): string {
    const d = new Date();
    d.setMinutes(d.getMinutes() + minutes);
    return d.toISOString();
}

function formatTime(time: string): string {
    const [h, m] = time.split(':');
    let hour = Number(h);
    const suffix = hour >= 12 ? 'PM' : 'AM';
    if (hour === 0) hour = 12;
    else if (hour > 12) hour -= 12;
    return `${hour}:${m} ${suffix}`;
}

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

const STATUS_COLORS: Record<ReminderStatus, { bg: string; text: string }> = {
    taken:   { bg: 'rgba(22,163,74,0.25)',  text: '#4ADE80' },
    snoozed: { bg: 'rgba(59,130,246,0.22)', text: '#93C5FD' },
    skipped: { bg: 'rgba(217,119,6,0.22)',  text: '#FCD34D' },
    missed:  { bg: 'rgba(239,68,68,0.22)',  text: '#FCA5A5' },
    pending: { bg: 'rgba(255,255,255,0.1)', text: 'rgba(255,255,255,0.55)' },
};

// ─── Main component ───────────────────────────────────────────────────────────

export default function ReminderAlertScreen() {
    const insets = useSafeAreaInsets();
    const t = useTranslation();
    const statusLabel = useStatusLabel();
    const { reminderId } = useLocalSearchParams<{ reminderId: string }>();

    const [loading, setLoading]         = useState(true);
    const [saving, setSaving]           = useState(false);
    const [error, setError]             = useState<string | null>(null);
    const [inactive, setInactive]       = useState(false);
    const [reminder, setReminder]       = useState<Reminder | null>(null);
    const [todayStatus, setTodayStatus] = useState<ReminderStatus | null>(null);
    const [isOverdue, setIsOverdue]     = useState(false);

    const pulseScale   = useRef(new Animated.Value(1)).current;
    const pulseOpacity = useRef(new Animated.Value(0.35)).current;

    useEffect(() => {
        const animation = Animated.loop(
            Animated.parallel([
                Animated.sequence([
                    Animated.timing(pulseScale,   { toValue: 1.15, duration: 2000, useNativeDriver: true }),
                    Animated.timing(pulseScale,   { toValue: 1,    duration: 2000, useNativeDriver: true }),
                ]),
                Animated.sequence([
                    Animated.timing(pulseOpacity, { toValue: 0.12, duration: 2000, useNativeDriver: true }),
                    Animated.timing(pulseOpacity, { toValue: 0.35, duration: 2000, useNativeDriver: true }),
                ]),
            ])
        );
        animation.start();
        return () => animation.stop();
    }, []);

    useEffect(() => {
        loadReminder();
    }, [reminderId]);

    async function loadReminder() {
        setLoading(true);
        setError(null);
        setInactive(false);

        if (!reminderId) {
            setError(t('reminderAlert.noReminderSpecified'));
            setLoading(false);
            return;
        }

        const { data: { user }, error: userError } = await supabase.auth.getUser();

        if (userError || !user) {
            setError(t('reminderAlert.mustBeSignedIn'));
            setLoading(false);
            return;
        }

        const { data: reminderData, error: reminderError } = await supabase
            .from('reminders')
            .select('id, connection_id, caregiver_id, recipient_id, title, reminder_type, notes, time_of_day, frequency, no_response_minutes, is_active, created_at')
            .eq('id', reminderId)
            .maybeSingle();

        if (reminderError) {
            setError(t('reminderAlert.couldNotLoad'));
            setLoading(false);
            return;
        }

        if (!reminderData) {
            // Reminder was hard to find at all — most likely this device is
            // holding a stale scheduled notification for something already
            // gone. Nothing else will clean this up, so do it here.
            cancelAllReminderNotifications(reminderId).catch(console.warn);
            setError(t('reminderAlert.reminderNotFound'));
            setLoading(false);
            return;
        }

        if (reminderData.recipient_id !== user.id) {
            // Doesn't belong to the signed-in account on this device (e.g. a
            // leftover notification from a prior account on a shared phone).
            // Never allow a response, and clear it so it can't fire again.
            cancelAllReminderNotifications(reminderId).catch(console.warn);
            setError(t('reminderAlert.notYourAccount'));
            setLoading(false);
            return;
        }

        if (!reminderData.is_active) {
            // Caregiver has deleted/deactivated this reminder. Cancel any
            // remaining scheduled occurrences for it on this device — this is
            // the notification-tap path, so the recipient has just proven
            // Tavora is running and can perform the cancellation.
            cancelAllReminderNotifications(reminderId).catch(console.warn);
            setInactive(true);
            setLoading(false);
            return;
        }

        setReminder(reminderData as Reminder);

        const todayDate = getTodayDateString();

        // A reminder created today after today's scheduled time already
        // passed isn't eligible until tomorrow — never treat it as overdue
        // or missed for today.
        const eligibleToday =
            getFirstEligibleDateString(reminderData.created_at, reminderData.time_of_day) <= todayDate;

        // Compute overdue state once so the UI reflects it immediately.
        const overdue = eligibleToday && isPastNoResponseWindow(
            reminderData.time_of_day,
            reminderData.no_response_minutes
        );
        setIsOverdue(overdue);

        const { data: logData } = await supabase
            .from('reminder_logs')
            .select('status')
            .eq('reminder_id', reminderId)
            .eq('occurrence_date', todayDate)
            .maybeSingle();

        const existingStatus = logData?.status as ReminderStatus | undefined;

        if (existingStatus && existingStatus !== 'pending') {
            // Existing terminal status — display as-is, never overwrite.
            setTodayStatus(existingStatus);
        } else if (overdue) {
            // No log yet, or still pending, and the window has passed.
            setTodayStatus('missed');

            // Write the missed row immediately so the caregiver dashboard
            // reflects it without the recipient needing to tap anything.
            // onConflict ensures a pending row is updated, not duplicated.
            const { error: missedErr } = await supabase
                .from('reminder_logs')
                .upsert(
                    {
                        reminder_id:     reminderData.id,
                        connection_id:   reminderData.connection_id,
                        caregiver_id:    reminderData.caregiver_id,
                        recipient_id:    reminderData.recipient_id,
                        occurrence_date: todayDate,
                        scheduled_for:   buildScheduledForIso(reminderData.time_of_day),
                        status:          'missed' as const,
                        completed_at:    null,
                        snoozed_until:   null,
                        updated_at:      new Date().toISOString(),
                    },
                    { onConflict: 'reminder_id,occurrence_date' }
                );

            if (missedErr) {
                console.error('[ReminderAlert] Failed to write missed log:', missedErr.message);
            }
        }

        setLoading(false);
    }

    async function handleAction(status: 'taken' | 'snoozed' | 'skipped') {
        if (!reminder || saving) return;
        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        setSaving(true);

        const todayDate    = getTodayDateString();
        const snoozedUntil = status === 'snoozed' ? buildSnoozedUntilIso(10) : null;

        const logPayload = {
            reminder_id:     reminder.id,
            connection_id:   reminder.connection_id,
            caregiver_id:    reminder.caregiver_id,
            recipient_id:    reminder.recipient_id,
            occurrence_date: todayDate,
            scheduled_for:   buildScheduledForIso(reminder.time_of_day),
            status,
            completed_at:    status === 'taken'   ? new Date().toISOString() : null,
            snoozed_until:   snoozedUntil,
            updated_at:      new Date().toISOString(),
        };

        const { error: saveError } = await supabase
            .from('reminder_logs')
            .upsert(logPayload, { onConflict: 'reminder_id,occurrence_date' });

        setSaving(false);

        if (saveError) {
            Alert.alert(t('reminderAlert.saveErrorTitle'), saveError.message);
            return;
        }

        // A real response now exists for today — cancel only today's
        // occurrence notification. Future occurrences are untouched.
        cancelReminderOccurrenceNotification(reminder.id, todayDate).catch(console.warn);

        // Server-authoritative recipients get their snooze re-alert from
        // claim_due_recipient_snooze_deliveries() instead — scheduling a
        // local one too would risk a duplicate alert.
        if (status === 'snoozed' && snoozedUntil && !(await isRecipientServerPushEnabled())) {
            scheduleSnoozeNotification(
                { id: reminder.id, title: reminder.title, reminder_type: reminder.reminder_type },
                todayDate,
                snoozedUntil,
                reminder.recipient_id
            ).catch(console.warn);
        }

        // Full reconcile as a catch-all, same as the dashboard's response
        // handler — cheap and idempotent.
        syncRecipientReminderNotifications().catch(console.warn);

        router.replace('/recipient-dashboard');
    }

    function handleDismiss() {
        if (router.canGoBack()) {
            router.back();
        } else {
            router.replace('/recipient-dashboard');
        }
    }

    // ── Loading state ──────────────────────────────────────────────────────────

    if (loading) {
        return (
            <View style={[styles.container, { paddingTop: insets.top }]}>
                <Animated.View
                    style={[styles.glowRing, { transform: [{ scale: pulseScale }], opacity: pulseOpacity }]}
                />
                <View style={styles.centeredState}>
                    <ActivityIndicator size="large" color="#93C5FD" />
                    <Text style={styles.loadingText}>{t('reminderAlert.loadingReminder')}</Text>
                </View>
            </View>
        );
    }

    // ── Inactive state ─────────────────────────────────────────────────────────
    // Calm, non-alarming notice — this is expected (the reminder was removed
    // by the caregiver), not an error, so it gets its own tone and icon.

    if (inactive) {
        return (
            <View style={[styles.container, { paddingTop: insets.top }]}>
                <Animated.View
                    style={[styles.glowRing, { transform: [{ scale: pulseScale }], opacity: pulseOpacity }]}
                />
                <View style={styles.centeredState}>
                    <View style={styles.inactiveIconWrap}>
                        <Ionicons name="moon-outline" size={36} color="rgba(255,255,255,0.55)" />
                    </View>
                    <Text style={styles.inactiveTitle}>{t('reminderAlert.noLongerActiveTitle')}</Text>
                    <Text style={styles.inactiveText}>
                        {t('reminderAlert.noLongerActiveText')}
                    </Text>
                    <TouchableOpacity
                        style={styles.errorButton}
                        onPress={() => router.replace('/recipient-dashboard')}
                        activeOpacity={0.8}
                    >
                        <Text style={styles.errorButtonText}>{t('reminderAlert.backToToday')}</Text>
                    </TouchableOpacity>
                </View>
            </View>
        );
    }

    // ── Error state ────────────────────────────────────────────────────────────

    if (error || !reminder) {
        return (
            <View style={[styles.container, { paddingTop: insets.top }]}>
                <Animated.View
                    style={[styles.glowRing, { transform: [{ scale: pulseScale }], opacity: pulseOpacity }]}
                />
                <View style={styles.centeredState}>
                    <View style={styles.errorIconWrap}>
                        <Ionicons name="alert-circle" size={40} color="#F87171" />
                    </View>
                    <Text style={styles.errorTitle}>{t('reminderAlert.unableToLoad')}</Text>
                    <Text style={styles.errorText}>{error ?? t('reminderAlert.unexpectedError')}</Text>
                    <TouchableOpacity
                        style={styles.errorButton}
                        onPress={() => router.replace('/recipient-dashboard')}
                        activeOpacity={0.8}
                    >
                        <Text style={styles.errorButtonText}>{t('reminderAlert.goBack')}</Text>
                    </TouchableOpacity>
                </View>
            </View>
        );
    }

    // ── Alert screen ───────────────────────────────────────────────────────────

    const typeIcon   = TYPE_ICONS[reminder.reminder_type] ?? '•';
    const typeLabel  = TYPE_LABEL_KEYS[reminder.reminder_type] ? t(TYPE_LABEL_KEYS[reminder.reminder_type]) : reminder.reminder_type;
    const statusInfo = todayStatus ? STATUS_COLORS[todayStatus] : null;

    return (
        <View style={[styles.container, { paddingTop: insets.top }]}>
            <Animated.View
                style={[styles.glowRing, { transform: [{ scale: pulseScale }], opacity: pulseOpacity }]}
            />

            {/* Back / dismiss */}
            <View style={styles.headerRow}>
                <TouchableOpacity
                    style={styles.backButton}
                    onPress={handleDismiss}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    activeOpacity={0.7}
                >
                    <Ionicons name="chevron-down" size={22} color="rgba(255,255,255,0.4)" />
                </TouchableOpacity>
            </View>

            {/* Scrollable content area */}
            <ScrollView
                style={styles.scrollArea}
                contentContainerStyle={styles.content}
                showsVerticalScrollIndicator={false}
                bounces={false}
            >
                {/* Badge */}
                <View style={styles.alertBadge}>
                    <Ionicons name="notifications" size={14} color="#93C5FD" />
                    <Text style={styles.alertBadgeText}>{t('reminderAlert.reminderBadge')}</Text>
                </View>

                {/* Time */}
                <Text style={styles.time}>{formatTime(reminder.time_of_day)}</Text>

                {/* Title */}
                <Text style={styles.title}>{reminder.title}</Text>

                {/* Type chip */}
                <View style={styles.typeChip}>
                    <Text style={styles.typeChipEmoji}>{typeIcon}</Text>
                    <Text style={styles.typeChipText}>{typeLabel}</Text>
                </View>

                {/* Notes */}
                {reminder.notes ? (
                    <View style={styles.notesCard}>
                        <Text style={styles.notesLabel}>{t('reminderAlert.notesFromOrganizer')}</Text>
                        <Text style={styles.notesText}>{reminder.notes}</Text>
                    </View>
                ) : null}

                {/* Response window */}
                <Text style={styles.windowText}>
                    {t('reminderAlert.responseWindow', { n: reminder.no_response_minutes })}
                </Text>

                {/* Overdue notice */}
                {isOverdue && (
                    <View style={styles.overdueBanner}>
                        <Ionicons name="time-outline" size={14} color="#FCA5A5" />
                        <Text style={styles.overdueText}>
                            {t('reminderAlert.windowPassed')}
                        </Text>
                    </View>
                )}

                {/* Today's status */}
                {todayStatus && statusInfo ? (
                    <View style={[styles.todayStatusPill, { backgroundColor: statusInfo.bg }]}>
                        <Text style={[styles.todayStatusText, { color: statusInfo.text }]}>
                            {t('reminderAlert.todayStatus', {
                                status: todayStatus === 'taken' ? `${statusLabel('taken')} ✓` : statusLabel(todayStatus),
                            })}
                        </Text>
                    </View>
                ) : null}
            </ScrollView>

            {/* Action buttons — pinned to bottom */}
            <View style={[styles.buttonArea, { paddingBottom: Math.max(insets.bottom + 8, 32) }]}>
                {saving ? (
                    <View style={styles.savingBox}>
                        <ActivityIndicator color="#93C5FD" />
                        <Text style={styles.savingText}>{t('reminderAlert.saving')}</Text>
                    </View>
                ) : todayStatus === 'taken' || todayStatus === 'skipped' ? (
                    <View style={styles.respondedBox}>
                        <Ionicons
                            name={todayStatus === 'taken' ? 'checkmark-circle' : 'remove-circle-outline'}
                            size={28}
                            color={todayStatus === 'taken' ? '#4ADE80' : 'rgba(255,255,255,0.4)'}
                        />
                        <Text style={styles.respondedText}>
                            {todayStatus === 'taken' ? t('reminderAlert.markedCompleted') : t('reminderAlert.skippedForToday')}
                        </Text>
                    </View>
                ) : (
                    <>
                        <TouchableOpacity
                            style={[styles.takenButton, SHADOW.sm]}
                            onPress={() => handleAction('taken')}
                            activeOpacity={0.88}
                        >
                            <Ionicons name="checkmark-circle" size={24} color="#FFFFFF" />
                            <Text style={styles.takenText}>{t('reminderAlert.done')}</Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                            style={styles.laterButton}
                            onPress={() => handleAction('snoozed')}
                            activeOpacity={0.8}
                        >
                            <Ionicons name="time-outline" size={20} color="#93C5FD" />
                            <Text style={styles.laterText}>{t('reminderAlert.remindMeLater')}</Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                            style={styles.skipButton}
                            onPress={() => handleAction('skipped')}
                            activeOpacity={0.6}
                        >
                            <Text style={styles.skipText}>{t('reminderAlert.skipThisReminder')}</Text>
                        </TouchableOpacity>
                    </>
                )}

                <Text style={styles.footerText}>
                    {todayStatus === 'taken' || todayStatus === 'skipped'
                        ? t('reminderAlert.footerResponded')
                        : isOverdue
                        ? t('reminderAlert.footerOverdue')
                        : t('reminderAlert.footerDefault')}
                </Text>
            </View>
        </View>
    );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#0D1B2A',
    },

    // ── Glow ring ──────────────────────────────────────────────────────────────
    glowRing: {
        position: 'absolute',
        width: 360,
        height: 360,
        borderRadius: 180,
        backgroundColor: T.primary,
        left: '50%',
        marginLeft: -180,
        top: '18%',
        marginTop: -180,
    },

    // ── Centered overlay (loading / error) ─────────────────────────────────────
    centeredState: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        paddingHorizontal: 32,
    },
    loadingText: {
        color: 'rgba(255,255,255,0.6)',
        fontSize: 16,
        fontWeight: '600',
    },
    errorIconWrap: {
        width: 72,
        height: 72,
        borderRadius: RADIUS.full,
        backgroundColor: 'rgba(248,113,113,0.15)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    errorTitle: {
        fontSize: 20,
        fontWeight: '700',
        color: '#FFFFFF',
        textAlign: 'center',
    },
    errorText: {
        fontSize: 15,
        color: 'rgba(255,255,255,0.55)',
        textAlign: 'center',
        lineHeight: 22,
    },
    errorButton: {
        marginTop: 8,
        paddingHorizontal: 28,
        paddingVertical: 14,
        backgroundColor: 'rgba(255,255,255,0.1)',
        borderRadius: RADIUS.lg,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.15)',
    },
    inactiveIconWrap: {
        width: 72,
        height: 72,
        borderRadius: RADIUS.full,
        backgroundColor: 'rgba(255,255,255,0.08)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    inactiveTitle: {
        fontSize: 20,
        fontWeight: '700',
        color: '#FFFFFF',
        textAlign: 'center',
    },
    inactiveText: {
        fontSize: 15,
        color: 'rgba(255,255,255,0.55)',
        textAlign: 'center',
        lineHeight: 22,
    },
    errorButtonText: {
        color: '#FFFFFF',
        fontSize: 16,
        fontWeight: '600',
    },

    // ── Header row (back button) ───────────────────────────────────────────────
    headerRow: {
        paddingHorizontal: 20,
        paddingVertical: 8,
        flexDirection: 'row',
        alignItems: 'center',
    },
    backButton: {
        width: 36,
        height: 36,
        borderRadius: RADIUS.full,
        backgroundColor: 'rgba(255,255,255,0.08)',
        justifyContent: 'center',
        alignItems: 'center',
    },

    // ── Scroll content ─────────────────────────────────────────────────────────
    scrollArea: {
        flex: 1,
    },
    content: {
        paddingHorizontal: 28,
        paddingTop: 16,
        paddingBottom: 24,
        alignItems: 'center',
    },

    // ── Alert badge ────────────────────────────────────────────────────────────
    alertBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        backgroundColor: 'rgba(255,255,255,0.1)',
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: RADIUS.full,
        marginBottom: 24,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.15)',
    },
    alertBadgeText: {
        color: '#93C5FD',
        fontSize: 13,
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: 1.2,
    },

    // ── Time ───────────────────────────────────────────────────────────────────
    time: {
        fontSize: 22,
        color: '#93C5FD',
        fontWeight: '700',
        textAlign: 'center',
        marginBottom: 14,
        letterSpacing: 0.5,
    },

    // ── Title ──────────────────────────────────────────────────────────────────
    title: {
        fontSize: 38,
        fontWeight: '800',
        color: '#FFFFFF',
        textAlign: 'center',
        lineHeight: 48,
        letterSpacing: -0.8,
        marginBottom: 20,
    },

    // ── Type chip ──────────────────────────────────────────────────────────────
    typeChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        backgroundColor: 'rgba(255,255,255,0.08)',
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: RADIUS.full,
        marginBottom: 24,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.12)',
    },
    typeChipEmoji: {
        fontSize: 14,
    },
    typeChipText: {
        color: 'rgba(255,255,255,0.75)',
        fontSize: 14,
        fontWeight: '600',
    },

    // ── Notes card ─────────────────────────────────────────────────────────────
    notesCard: {
        width: '100%',
        backgroundColor: 'rgba(255,255,255,0.06)',
        borderRadius: RADIUS.lg,
        padding: 16,
        marginBottom: 20,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
    },
    notesLabel: {
        fontSize: 11,
        color: 'rgba(255,255,255,0.4)',
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: 0.8,
        marginBottom: 6,
    },
    notesText: {
        fontSize: 16,
        color: 'rgba(255,255,255,0.72)',
        lineHeight: 24,
    },

    // ── Response window ────────────────────────────────────────────────────────
    windowText: {
        fontSize: 13,
        color: 'rgba(255,255,255,0.3)',
        textAlign: 'center',
        marginBottom: 16,
    },

    // ── Overdue banner ─────────────────────────────────────────────────────────
    overdueBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        backgroundColor: 'rgba(239,68,68,0.14)',
        borderRadius: RADIUS.md,
        borderWidth: 1,
        borderColor: 'rgba(239,68,68,0.25)',
        paddingHorizontal: 14,
        paddingVertical: 10,
        marginBottom: 12,
    },
    overdueText: {
        fontSize: 13,
        color: '#FCA5A5',
        fontWeight: '600',
        flex: 1,
    },

    // ── Today status pill ──────────────────────────────────────────────────────
    todayStatusPill: {
        paddingHorizontal: 18,
        paddingVertical: 9,
        borderRadius: RADIUS.full,
        marginTop: 4,
    },
    todayStatusText: {
        fontSize: 14,
        fontWeight: '700',
    },

    // ── Saving state ───────────────────────────────────────────────────────────
    savingBox: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        paddingVertical: 24,
    },
    savingText: {
        color: 'rgba(255,255,255,0.6)',
        fontSize: 16,
        fontWeight: '600',
    },

    // ── Button area ────────────────────────────────────────────────────────────
    buttonArea: {
        paddingHorizontal: 24,
        paddingTop: 8,
        gap: 12,
    },
    takenButton: {
        backgroundColor: '#16A34A',
        paddingVertical: 20,
        borderRadius: RADIUS.xl,
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 10,
    },
    takenText: {
        color: '#FFFFFF',
        fontSize: 20,
        fontWeight: '700',
        letterSpacing: -0.3,
    },
    laterButton: {
        paddingVertical: 18,
        borderRadius: RADIUS.xl,
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 8,
        borderWidth: 1.5,
        borderColor: 'rgba(147,197,253,0.35)',
        backgroundColor: 'rgba(255,255,255,0.06)',
    },
    laterText: {
        color: '#93C5FD',
        fontSize: 17,
        fontWeight: '600',
    },
    skipButton: {
        paddingVertical: 14,
        alignItems: 'center',
    },
    skipText: {
        color: 'rgba(255,255,255,0.35)',
        fontSize: 15,
        fontWeight: '500',
    },
    footerText: {
        color: 'rgba(255,255,255,0.3)',
        fontSize: 12,
        textAlign: 'center',
        lineHeight: 18,
        paddingBottom: 4,
    },

    // ── Already-responded state ────────────────────────────────────────────────
    respondedBox: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        paddingVertical: 20,
    },
    respondedText: {
        color: 'rgba(255,255,255,0.7)',
        fontSize: 17,
        fontWeight: '600',
        letterSpacing: -0.2,
    },
});
