import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Platform,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SettingsSheet } from '@/components/settings-sheet';
import { RADIUS, SHADOW, T } from '@/constants/theme';
import { supabase } from '@/lib/supabase';
import {
    requestNotificationPermissions,
    scheduleReminderNotifications,
    scheduleTestNotification,
} from '@/lib/notifications';
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
    frequency: 'daily' | 'weekdays' | 'weekends';
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

// ─── Pure helpers (unchanged) ────────────────────────────────────────────────

function getTodayDateString() {
    const today = new Date();
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
}

function buildScheduledForIso(time: string) {
    const [hourString, minuteString] = time.split(':');
    const scheduled = new Date();
    scheduled.setHours(Number(hourString), Number(minuteString), 0, 0);
    return scheduled.toISOString();
}

function buildSnoozedUntilIso(minutes = 10) {
    const snoozedUntil = new Date();
    snoozedUntil.setMinutes(snoozedUntil.getMinutes() + minutes);
    return snoozedUntil.toISOString();
}

function formatTime(time: string) {
    const [hourString, minuteString] = time.split(':');
    let hour = Number(hourString);
    const suffix = hour >= 12 ? 'PM' : 'AM';
    if (hour === 0) hour = 12;
    if (hour > 12) hour -= 12;
    return `${hour}:${minuteString} ${suffix}`;
}

function formatStatus(status?: ReminderStatus) {
    if (!status || status === 'pending') return 'Pending';
    if (status === 'taken')   return 'Taken';
    if (status === 'snoozed') return 'Snoozed';
    if (status === 'skipped') return 'Skipped';
    if (status === 'missed')  return 'Missed';
    return 'Pending';
}

function shouldShowToday(frequency: Reminder['frequency']) {
    const today = new Date().getDay();
    const isWeekend = today === 0 || today === 6;
    if (frequency === 'daily')    return true;
    if (frequency === 'weekdays') return !isWeekend;
    if (frequency === 'weekends') return isWeekend;
    return true;
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function getStatusColors(status?: ReminderStatus) {
    if (status === 'taken')   return { bg: '#DCFCE7', text: '#15803D', accent: T.success };
    if (status === 'missed')  return { bg: '#FEE2E2', text: '#B91C1C', accent: T.error };
    if (status === 'skipped') return { bg: '#FEF3C7', text: '#B45309', accent: '#D97706' };
    if (status === 'snoozed') return { bg: '#DBEAFE', text: '#1D4ED8', accent: T.primary };
    return { bg: T.bgAlt, text: T.textMuted, accent: T.border };
}

function formatDayLabel() {
    return new Date().toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
    });
}

function getTimeHint(reminder: Reminder): string | null {
    const status = reminder.today_status;

    if (status === 'snoozed' && reminder.snoozed_until) {
        const until = new Date(reminder.snoozed_until);
        if (until.getTime() <= Date.now()) return 'Snooze ended';
        const h = until.getHours();
        const m = until.getMinutes();
        const suffix = h >= 12 ? 'PM' : 'AM';
        const displayH = h === 0 ? 12 : h > 12 ? h - 12 : h;
        return `Until ${displayH}:${String(m).padStart(2, '0')} ${suffix}`;
    }

    if (status === 'pending') {
        const [rh, rm] = reminder.time_of_day.split(':').map(Number);
        const today = new Date();
        const scheduled = new Date(today.getFullYear(), today.getMonth(), today.getDate(), rh, rm, 0, 0);
        const diffMin = Math.round((scheduled.getTime() - Date.now()) / 60000);

        if (diffMin > 60) {
            const hrs  = Math.floor(diffMin / 60);
            const mins = diffMin % 60;
            return mins > 0 ? `in ${hrs}h ${mins}m` : `in ${hrs}h`;
        }
        if (diffMin > 1)  return `in ${diffMin} min`;
        if (diffMin >= 0) return 'now';

        // Past scheduled time but still inside the response window
        const missedAt   = new Date(scheduled.getTime() + reminder.no_response_minutes * 60 * 1000);
        const windowLeft = Math.round((missedAt.getTime() - Date.now()) / 60000);
        if (windowLeft > 0) return `${windowLeft} min left`;
    }

    return null;
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function RecipientDashboard() {
    const [reminders, setReminders]               = useState<Reminder[]>([]);
    const [loading, setLoading]                   = useState(true);
    const [savingReminderId, setSavingReminderId] = useState<string | null>(null);
    const [settingsVisible, setSettingsVisible]   = useState(false);
    const [notifDenied, setNotifDenied]           = useState(false);

    async function loadReminders() {
        setLoading(true);

        const { data: { user }, error: userError } = await supabase.auth.getUser();

        if (userError || !user) {
            setLoading(false);
            router.replace('/signin');
            return;
        }

        const { data, error } = await supabase
            .from('reminders')
            .select('id, connection_id, caregiver_id, recipient_id, title, reminder_type, notes, time_of_day, frequency, no_response_minutes, created_at')
            .eq('recipient_id', user.id)
            .eq('is_active', true)
            .order('time_of_day', { ascending: true });

        if (error) {
            setLoading(false);
            Alert.alert('Reminder error', error.message);
            return;
        }

        // Schedule local notifications for ALL active reminders (not just today's).
        // cancelAll + reschedule on every focus keeps the schedule in sync with any
        // reminder edits the caregiver may have made.
        const granted = await requestNotificationPermissions();
        setNotifDenied(!granted);
        if (granted) {
            scheduleReminderNotifications(data || []).catch(console.warn);
        }

        const todayDate = getTodayDateString();

        // Exclude reminders not yet eligible today — a reminder created today
        // after its scheduled time-of-day already passed shouldn't be treated
        // as missed; its first occurrence is tomorrow.
        const todaysReminders = (data || []).filter((r) =>
            shouldShowToday(r.frequency) &&
            getFirstEligibleDateString(r.created_at, r.time_of_day) <= todayDate
        );

        if (todaysReminders.length === 0) {
            setReminders([]);
            setLoading(false);
            return;
        }

        const reminderIds = todaysReminders.map((r) => r.id);

        const { data: logs, error: logsError } = await supabase
            .from('reminder_logs')
            .select('reminder_id, status, snoozed_until')
            .eq('recipient_id', user.id)
            .eq('occurrence_date', todayDate)
            .in('reminder_id', reminderIds);

        if (logsError) {
            setLoading(false);
            Alert.alert('Logs error', logsError.message);
            return;
        }

        const now = new Date();

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

        setReminders(remindersWithStatus);
        setLoading(false);

        // Write missed logs to the DB so the caregiver dashboard reflects them.
        // Fire-and-forget: the recipient UI already shows the correct computed
        // status without waiting for the DB write.
        // Upsert on (reminder_id, occurrence_date) — never creates duplicates.
        const missedToSync = remindersWithStatus.filter((r) => {
            if (r.today_status !== 'missed') return false;
            const existing = logs?.find((l) => l.reminder_id === r.id);
            // Only upsert when there is no log yet or the existing row is still pending.
            return !existing || existing.status === 'pending';
        });

        if (missedToSync.length > 0) {
            const nowIso = now.toISOString();
            supabase
                .from('reminder_logs')
                .upsert(
                    missedToSync.map((r) => ({
                        reminder_id:     r.id,
                        connection_id:   r.connection_id,
                        caregiver_id:    r.caregiver_id,
                        recipient_id:    r.recipient_id,
                        occurrence_date: todayDate,
                        scheduled_for:   buildScheduledForIso(r.time_of_day),
                        status:          'missed' as const,
                        completed_at:    null,
                        snoozed_until:   null,
                        updated_at:      nowIso,
                    })),
                    { onConflict: 'reminder_id,occurrence_date' }
                )
                .then(({ error: syncErr }) => {
                    if (syncErr) console.error('[RecipientDashboard] Missed log sync failed:', syncErr.message);
                });
        }
    }

    useFocusEffect(useCallback(() => { loadReminders(); }, []));

    async function saveReminderAction(reminder: Reminder, status: ReminderStatus) {
        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        setSavingReminderId(reminder.id);

        const todayDate = getTodayDateString();

        const logPayload = {
            reminder_id:     reminder.id,
            connection_id:   reminder.connection_id,
            caregiver_id:    reminder.caregiver_id,
            recipient_id:    reminder.recipient_id,
            occurrence_date: todayDate,
            scheduled_for:   buildScheduledForIso(reminder.time_of_day),
            status,
            completed_at:    status === 'taken' ? new Date().toISOString() : null,
            snoozed_until:   status === 'snoozed' ? buildSnoozedUntilIso(10) : null,
            updated_at:      new Date().toISOString(),
        };

        const { error } = await supabase
            .from('reminder_logs')
            .upsert(logPayload, { onConflict: 'reminder_id,occurrence_date' });

        setSavingReminderId(null);

        if (error) {
            Alert.alert('Save error', error.message);
            return;
        }

        setReminders((current) =>
            current.map((r) =>
                r.id === reminder.id ? { ...r, today_status: status } : r
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
                        refreshing={loading}
                        onRefresh={loadReminders}
                        tintColor={T.primary}
                        colors={[T.primary]}
                    />
                }
            >
                {/* Header */}
                <View style={styles.header}>
                    <View style={{ flex: 1 }}>
                        <Text style={styles.heading}>Today</Text>
                        <Text style={styles.subheading}>{formatDayLabel()}</Text>
                    </View>
                    <TouchableOpacity
                        style={styles.alertIconButton}
                        onPress={() => setSettingsVisible(true)}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                        <Ionicons name="settings-outline" size={22} color={T.primary} />
                    </TouchableOpacity>
                </View>

                {/* Notification permission denied notice */}
                {notifDenied && !loading && (
                    <View style={styles.notifDeniedBanner}>
                        <Ionicons name="notifications-off-outline" size={16} color="#92400E" />
                        <Text style={styles.notifDeniedText}>
                            Notifications are off. Enable them in Settings to receive reminder alerts.
                        </Text>
                    </View>
                )}

                {/* Loading state */}
                {loading && (
                    <View style={[styles.emptyCard, SHADOW.xs]}>
                        <View style={styles.emptyIconWrap}>
                            <ActivityIndicator color={T.primary} size="large" />
                        </View>
                        <Text style={styles.emptyTitle}>Loading your reminders…</Text>
                        <Text style={styles.emptyText}>Just a moment.</Text>
                    </View>
                )}

                {/* Empty state */}
                {!loading && reminders.length === 0 && (
                    <View style={[styles.emptyCard, SHADOW.xs]}>
                        <View style={styles.emptyIconWrap}>
                            <Text style={styles.emptyEmoji}>🕊️</Text>
                        </View>
                        <Text style={styles.emptyTitle}>All clear for today</Text>
                        <Text style={styles.emptyText}>
                            No reminders are scheduled right now. Your caregiver will send them when needed.
                        </Text>
                    </View>
                )}

                {/* Reminder cards */}
                {!loading && reminders.map((reminder) => {
                    const isSaving   = savingReminderId === reminder.id;
                    const statusInfo = getStatusColors(reminder.today_status);
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
                                        {reminder.reminder_type.charAt(0).toUpperCase() + reminder.reminder_type.slice(1)}
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
                                <Text style={styles.notesMuted}>No notes from caregiver.</Text>
                            )}

                            {/* Status row */}
                            {(() => {
                                const timeHint = getTimeHint(reminder);
                                return (
                                    <View style={styles.statusRow}>
                                        <Text style={styles.statusLabel}>Today's status</Text>
                                        <View style={styles.statusRight}>
                                            {timeHint ? (
                                                <Text style={styles.timeHint}>{timeHint}</Text>
                                            ) : null}
                                            <View style={[styles.statusPill, { backgroundColor: statusInfo.bg }]}>
                                                <Text style={[styles.statusPillText, { color: statusInfo.text }]}>
                                                    {formatStatus(reminder.today_status)}
                                                </Text>
                                            </View>
                                        </View>
                                    </View>
                                );
                            })()}

                            {/* Action buttons */}
                            {isSaving ? (
                                <View style={[styles.savingBox, SHADOW.xs]}>
                                    <ActivityIndicator color={T.primary} />
                                    <Text style={styles.savingText}>Saving…</Text>
                                </View>
                            ) : reminder.today_status === 'taken' ? (
                                <View style={styles.respondedBox}>
                                    <Ionicons name="checkmark-circle" size={20} color={T.success} />
                                    <Text style={[styles.respondedText, { color: T.success }]}>Marked as taken</Text>
                                </View>
                            ) : reminder.today_status === 'skipped' ? (
                                <View style={styles.respondedBox}>
                                    <Ionicons name="remove-circle-outline" size={20} color={T.textMuted} />
                                    <Text style={[styles.respondedText, { color: T.textMuted }]}>Skipped for today</Text>
                                </View>
                            ) : (
                                <View style={styles.actionArea}>
                                    {/* Primary action — Taken */}
                                    <TouchableOpacity
                                        style={[styles.takenButton, SHADOW.sm]}
                                        onPress={() => saveReminderAction(reminder, 'taken')}
                                        activeOpacity={0.88}
                                    >
                                        <Ionicons name="checkmark-circle" size={22} color="#FFFFFF" />
                                        <Text style={styles.takenButtonText}>Taken</Text>
                                    </TouchableOpacity>

                                    {/* Secondary actions */}
                                    <View style={styles.secondaryButtonRow}>
                                        <TouchableOpacity
                                            style={styles.laterButton}
                                            onPress={() => saveReminderAction(reminder, 'snoozed')}
                                            activeOpacity={0.8}
                                        >
                                            <Ionicons name="time-outline" size={18} color="#92400E" />
                                            <Text style={styles.laterButtonText}>Later</Text>
                                        </TouchableOpacity>

                                        <TouchableOpacity
                                            style={styles.skipButton}
                                            onPress={() => saveReminderAction(reminder, 'skipped')}
                                            activeOpacity={0.7}
                                        >
                                            <Text style={styles.skipButtonText}>Skip</Text>
                                        </TouchableOpacity>
                                    </View>
                                </View>
                            )}
                        </TouchableOpacity>
                    );
                })}

                {/* ── Dev helper: test notification ── */}
                {__DEV__ && !loading && reminders.length > 0 && (
                    <TouchableOpacity
                        style={styles.testNotifButton}
                        activeOpacity={0.7}
                        onPress={async () => {
                            await scheduleTestNotification(reminders[0]);
                            Alert.alert(
                                'Test notification scheduled',
                                `Fires in 10 seconds for "${reminders[0].title}". Background the app to see it.`
                            );
                        }}
                    >
                        <Ionicons name="notifications-outline" size={15} color={T.textMuted} />
                        <Text style={styles.testNotifText}>Test Notification (Dev)</Text>
                    </TouchableOpacity>
                )}
            </ScrollView>

            <SettingsSheet
                visible={settingsVisible}
                onClose={() => setSettingsVisible(false)}
            />
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: T.bgPage,
    },
    content: {
        paddingHorizontal: 20,
        paddingTop: 8,
        paddingBottom: 48,
    },

    // ── Header ────────────────────────────────────────────────────────
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 24,
        paddingTop: 8,
    },
    heading: {
        fontSize: 34,
        fontWeight: '800',
        color: T.textPrimary,
        letterSpacing: -0.8,
    },
    subheading: {
        fontSize: 14,
        color: T.textMuted,
        marginTop: 2,
        letterSpacing: -0.1,
    },
    alertIconButton: {
        width: 44,
        height: 44,
        borderRadius: RADIUS.lg,
        backgroundColor: T.primaryLight,
        justifyContent: 'center',
        alignItems: 'center',
    },

    // ── Empty / loading state ─────────────────────────────────────────
    emptyCard: {
        backgroundColor: T.bgSurface,
        borderRadius: RADIUS.xl,
        padding: 32,
        alignItems: 'center',
        marginTop: 8,
    },
    emptyIconWrap: {
        width: 72,
        height: 72,
        borderRadius: RADIUS.xl,
        backgroundColor: T.bgAlt,
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
        color: T.textPrimary,
        letterSpacing: -0.3,
        marginBottom: 8,
        textAlign: 'center',
    },
    emptyText: {
        fontSize: 15,
        color: T.textMuted,
        lineHeight: 22,
        textAlign: 'center',
    },

    // ── Reminder card ─────────────────────────────────────────────────
    reminderCard: {
        backgroundColor: T.bgSurface,
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
        backgroundColor: T.primaryLight,
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: RADIUS.full,
    },
    typePillEmoji: {
        fontSize: 13,
    },
    typePillText: {
        color: T.primary,
        fontSize: 13,
        fontWeight: '700',
    },
    timeText: {
        fontSize: 17,
        color: T.textPrimary,
        fontWeight: '700',
        letterSpacing: -0.2,
    },
    reminderTitle: {
        fontSize: 26,
        fontWeight: '800',
        color: T.textPrimary,
        letterSpacing: -0.5,
        lineHeight: 32,
        marginBottom: 10,
    },
    notes: {
        fontSize: 16,
        color: T.textSecondary,
        lineHeight: 23,
        marginBottom: 16,
    },
    notesMuted: {
        fontSize: 15,
        color: T.textMuted,
        lineHeight: 22,
        marginBottom: 16,
    },

    // ── Status row ────────────────────────────────────────────────────
    statusRow: {
        backgroundColor: T.bgAlt,
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
        color: T.textMuted,
        fontWeight: '600',
    },
    statusRight: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    timeHint: {
        fontSize: 12,
        color: T.textMuted,
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
        backgroundColor: T.bgAlt,
        borderRadius: RADIUS.lg,
        paddingVertical: 18,
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 10,
    },
    savingText: {
        fontSize: 15,
        color: T.textMuted,
        fontWeight: '600',
    },

    // ── Action buttons ────────────────────────────────────────────────
    actionArea: {
        gap: 10,
    },
    takenButton: {
        backgroundColor: T.success,
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
        backgroundColor: T.bgAlt,
        paddingVertical: 15,
        borderRadius: RADIUS.xl,
        alignItems: 'center',
        justifyContent: 'center',
    },
    skipButtonText: {
        color: T.textSecondary,
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

    // ── Already-responded state ───────────────────────────────────────
    respondedBox: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        paddingVertical: 16,
        backgroundColor: T.bgAlt,
        borderRadius: RADIUS.xl,
    },
    respondedText: {
        fontSize: 15,
        fontWeight: '600',
    },

    // ── Dev test notification button ───────────────────────────────────
    testNotifButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        marginTop: 8,
        paddingVertical: 14,
        borderRadius: RADIUS.md,
        borderWidth: 1,
        borderColor: T.border,
        borderStyle: 'dashed',
    },
    testNotifText: {
        fontSize: 13,
        color: T.textMuted,
        fontWeight: '500',
    },
});
