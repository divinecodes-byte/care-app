import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import {
    ActivityIndicator,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { RADIUS, SHADOW, T } from '@/constants/theme';
import { formatFrequency as formatFrequencyDays, isDueOnDate } from '@/lib/frequency';
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
    frequency: 'daily' | 'weekdays' | 'weekends' | 'custom';
    days_of_week: number[];
    no_response_minutes: number;
    created_at: string;
    is_active: boolean;
    updated_at: string;
};

type ReminderLog = {
    reminder_id: string;
    occurrence_date: string;
    status: ReminderStatus;
    completed_at: string | null;
    snoozed_until: string | null;
    scheduled_for: string | null;
};

type DetailStats = {
    weekAdherence: number | null;
    monthAdherence: number | null;
    taken: number;
    missed: number;
    skipped: number;
    snoozed: number;
    pending: number;
    avgResponseMinutes: number | null;
};

type HistoryEntry = {
    dateString: string;
    dateLabel: string;
    status: ReminderStatus;
};

// ─── Pure helpers (same logic as caregiver-dashboard) ────────────────────────

function getLocalDateString(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function getStartOfWeek(date: Date): Date {
    const s = new Date(date);
    s.setHours(0, 0, 0, 0);
    s.setDate(s.getDate() - s.getDay());
    return s;
}

function addDays(date: Date, n: number): Date {
    const next = new Date(date);
    next.setDate(next.getDate() + n);
    return next;
}

function getMonthDates(date: Date): Date[] {
    const year = date.getFullYear();
    const month = date.getMonth();
    const days = new Date(year, month + 1, 0).getDate();
    return Array.from({ length: days }, (_, i) => new Date(year, month, i + 1));
}

function formatTime(time: string): string {
    const [hStr, mStr] = time.split(':');
    let h = Number(hStr);
    const suffix = h >= 12 ? 'PM' : 'AM';
    if (h === 0) h = 12;
    else if (h > 12) h -= 12;
    return `${h}:${mStr} ${suffix}`;
}

function formatFrequency(freq: Reminder['frequency'], daysOfWeek: number[]): string {
    return formatFrequencyDays(freq, daysOfWeek);
}

function formatDateLabel(date: Date): string {
    return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function getAnalyticsStartDate(
    connectionAcceptedAt: string,
    reminderCreatedAt: string,
    timeOfDay: string
): Date {
    const connDate = new Date(connectionAcceptedAt);
    const remDate  = new Date(reminderCreatedAt);
    const later    = connDate > remDate ? connDate : remDate;

    // If the reminder/connection only became eligible after today's
    // scheduled window had already passed, the first occurrence is the
    // next calendar day — today must never be backfilled as missed.
    const [h, m] = timeOfDay.split(':').map(Number);
    const scheduledOnLaterDate = new Date(
        later.getFullYear(), later.getMonth(), later.getDate(), h, m, 0, 0
    );
    const laterDateStart = new Date(later.getFullYear(), later.getMonth(), later.getDate(), 0, 0, 0, 0);
    return later > scheduledOnLaterDate ? addDays(laterDateStart, 1) : laterDateStart;
}

function shouldShowOnDate(daysOfWeek: number[], date: Date): boolean {
    return isDueOnDate(daysOfWeek, date);
}

function isReminderEligibleOnDate(
    reminder: Reminder,
    date: Date,
    connectionAcceptedAt: string
): boolean {
    if (!shouldShowOnDate(reminder.days_of_week, date)) return false;
    const start     = getAnalyticsStartDate(connectionAcceptedAt, reminder.created_at, reminder.time_of_day);
    const dateStart = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
    if (dateStart < start) return false;

    // Soft-deleted reminders keep their past logs/history, but aren't
    // eligible for any date after they were deactivated.
    if (!reminder.is_active) {
        const deactivatedAt = new Date(reminder.updated_at);
        const deactivatedDateStart = new Date(
            deactivatedAt.getFullYear(), deactivatedAt.getMonth(), deactivatedAt.getDate(), 0, 0, 0, 0
        );
        if (dateStart > deactivatedDateStart) return false;
    }

    return true;
}

function buildScheduledDateTime(dateString: string, timeOfDay: string): Date {
    const [yr, mo, dy] = dateString.split('-').map(Number);
    const [hr, mn]     = timeOfDay.split(':').map(Number);
    return new Date(yr, mo - 1, dy, hr, mn, 0, 0);
}

function getComputedStatus(
    reminder: Reminder,
    dateString: string,
    todayString: string,
    log?: ReminderLog
): ReminderStatus {
    if (log?.status) return log.status;
    if (dateString > todayString) return 'pending';
    const scheduledFor = buildScheduledDateTime(dateString, reminder.time_of_day);
    const missedAt     = new Date(scheduledFor.getTime() + reminder.no_response_minutes * 60 * 1000);
    if (new Date() < missedAt) return 'pending';
    return 'missed';
}

function getAdherenceColor(pct: number | null): string {
    if (pct === null) return T.textMuted;
    if (pct >= 80) return T.success;
    if (pct >= 50) return '#D97706';
    return T.error;
}

// ─── Data builder ─────────────────────────────────────────────────────────────

function buildDetailData(
    reminder: Reminder,
    logs: ReminderLog[],
    weekDates: Date[],
    monthDates: Date[],
    connectionAcceptedAt: string
): { stats: DetailStats; history: HistoryEntry[] } {
    const todayString = getLocalDateString(new Date());

    let weekTaken = 0, weekCountable = 0;
    let monthTaken = 0, monthCountable = 0;
    let taken = 0, missed = 0, skipped = 0, snoozed = 0, pending = 0;
    const history: HistoryEntry[] = [];
    const responseTimes: number[] = [];

    monthDates.forEach((date) => {
        const dateString = getLocalDateString(date);
        if (dateString > todayString) return;
        if (!isReminderEligibleOnDate(reminder, date, connectionAcceptedAt)) return;

        const log    = logs.find((l) => l.occurrence_date === dateString);
        const status = getComputedStatus(reminder, dateString, todayString, log);

        if (status === 'pending') {
            pending += 1;
        } else {
            monthCountable += 1;
            if (status === 'taken')   { monthTaken += 1; taken  += 1; }
            if (status === 'missed')  missed  += 1;
            if (status === 'skipped') skipped += 1;
            if (status === 'snoozed') snoozed += 1;
        }

        if (status === 'taken' && log?.completed_at && log?.scheduled_for) {
            const diff = Math.round(
                (new Date(log.completed_at).getTime() - new Date(log.scheduled_for).getTime()) / 60000
            );
            if (diff >= 0 && diff < 1440) responseTimes.push(diff);
        }

        history.push({
            dateString,
            dateLabel: formatDateLabel(date),
            status,
        });
    });

    weekDates.forEach((date) => {
        const dateString = getLocalDateString(date);
        if (dateString > todayString) return;
        if (!isReminderEligibleOnDate(reminder, date, connectionAcceptedAt)) return;
        const log    = logs.find((l) => l.occurrence_date === dateString);
        const status = getComputedStatus(reminder, dateString, todayString, log);
        if (status === 'pending') return;
        weekCountable += 1;
        if (status === 'taken') weekTaken += 1;
    });

    history.sort((a, b) => b.dateString.localeCompare(a.dateString));

    return {
        stats: {
            weekAdherence:   weekCountable  === 0 ? null : Math.round((weekTaken  / weekCountable)  * 100),
            monthAdherence:  monthCountable === 0 ? null : Math.round((monthTaken / monthCountable) * 100),
            taken,
            missed,
            skipped,
            snoozed,
            pending,
            avgResponseMinutes:
                responseTimes.length >= 2
                    ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length)
                    : null,
        },
        history,
    };
}

// ─── Status helpers ───────────────────────────────────────────────────────────

function statusColor(s: ReminderStatus): string {
    if (s === 'taken')   return '#15803D';
    if (s === 'missed')  return '#B91C1C';
    if (s === 'skipped') return '#B45309';
    if (s === 'snoozed') return '#1D4ED8';
    return T.textMuted;
}

function statusBg(s: ReminderStatus): string {
    if (s === 'taken')   return '#DCFCE7';
    if (s === 'missed')  return '#FEE2E2';
    if (s === 'skipped') return '#FEF3C7';
    if (s === 'snoozed') return '#DBEAFE';
    return T.bgAlt;
}

function statusLabel(s: ReminderStatus): string {
    const map: Record<ReminderStatus, string> = {
        taken: 'Taken', missed: 'Missed', skipped: 'Skipped', snoozed: 'Snoozed', pending: 'Pending',
    };
    return map[s];
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function ReminderDetailsScreen() {
    const { reminderId } = useLocalSearchParams<{ reminderId: string }>();

    const [loading,             setLoading]             = useState(true);
    const [reminder,            setReminder]            = useState<Reminder | null>(null);
    const [stats,               setStats]               = useState<DetailStats | null>(null);
    const [history,             setHistory]             = useState<HistoryEntry[]>([]);
    const [analyticsStartLabel, setAnalyticsStartLabel] = useState('');
    const [error,               setError]               = useState<string | null>(null);

    useEffect(() => {
        if (!reminderId) {
            setError('No reminder selected. Go back and tap "Details" on a reminder card.');
            setLoading(false);
            return;
        }
        loadData();
    }, [reminderId]);

    async function loadData() {
        setLoading(true);
        setError(null);

        const { data: { user } } = await supabase.auth.getUser();
        if (!user) { setError('Not authenticated.'); setLoading(false); return; }

        const { data: rem, error: remErr } = await supabase
            .from('reminders')
            .select(
                'id, connection_id, caregiver_id, recipient_id, title, reminder_type, notes, time_of_day, frequency, days_of_week, no_response_minutes, created_at, is_active, updated_at'
            )
            .eq('id', reminderId)
            .maybeSingle();

        if (remErr || !rem) {
            setError('Reminder not found.');
            setLoading(false);
            return;
        }

        const { data: conn, error: connErr } = await supabase
            .from('connections')
            .select('accepted_at, created_at')
            .eq('id', rem.connection_id)
            .maybeSingle();

        if (connErr || !conn) {
            setError('Connection not found.');
            setLoading(false);
            return;
        }

        const acceptedAt = conn.accepted_at || conn.created_at || new Date().toISOString();

        const today      = new Date();
        const weekStart  = getStartOfWeek(today);
        const weekDates  = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
        const monthDates = getMonthDates(today);

        const { data: logsData } = await supabase
            .from('reminder_logs')
            .select('reminder_id, occurrence_date, status, completed_at, snoozed_until, scheduled_for')
            .eq('reminder_id', reminderId)
            .gte('occurrence_date', getLocalDateString(monthDates[0]))
            .lte('occurrence_date', getLocalDateString(monthDates[monthDates.length - 1]));

        const logs         = (logsData || []) as ReminderLog[];
        const reminderData = rem as Reminder;

        const startDate = getAnalyticsStartDate(acceptedAt, reminderData.created_at, reminderData.time_of_day);
        setAnalyticsStartLabel(
            startDate.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
        );

        const { stats: computed, history: hist } = buildDetailData(
            reminderData,
            logs,
            weekDates,
            monthDates,
            acceptedAt
        );

        setReminder(reminderData);
        setStats(computed);
        setHistory(hist);
        setLoading(false);
    }

    // ── Render ────────────────────────────────────────────────────────────────

    return (
        <SafeAreaView style={styles.container}>
            {/* Nav bar */}
            <View style={styles.navBar}>
                <TouchableOpacity
                    style={styles.backBtn}
                    onPress={() => router.back()}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                    <Ionicons name="chevron-back" size={20} color={T.primary} />
                    <Text style={styles.backText}>Dashboard</Text>
                </TouchableOpacity>
                <Text style={styles.navTitle}>Reminder Details</Text>
                {reminderId && (!reminder || reminder.is_active) ? (
                    <TouchableOpacity
                        style={styles.editNavBtn}
                        onPress={() =>
                            router.push({ pathname: '/edit-reminder', params: { reminderId } })
                        }
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                        <Ionicons name="pencil-outline" size={16} color={T.primary} />
                        <Text style={styles.editNavText}>Edit</Text>
                    </TouchableOpacity>
                ) : (
                    <View style={styles.navSpacer} />
                )}
            </View>

            {loading ? (
                <View style={styles.centered}>
                    <ActivityIndicator color={T.primary} size="large" />
                    <Text style={styles.loadingText}>Loading reminder…</Text>
                </View>
            ) : error ? (
                <View style={styles.centered}>
                    <View style={styles.errorIconWrap}>
                        <Ionicons name="alert-circle-outline" size={32} color={T.textMuted} />
                    </View>
                    <Text style={styles.errorTitle}>Something went wrong</Text>
                    <Text style={styles.errorText}>{error}</Text>
                    <TouchableOpacity style={styles.errorBack} onPress={() => router.back()}>
                        <Text style={styles.errorBackText}>Go back</Text>
                    </TouchableOpacity>
                </View>
            ) : reminder && stats ? (
                <ScrollView
                    contentContainerStyle={styles.content}
                    showsVerticalScrollIndicator={false}
                >
                    {/* ── Reminder info ── */}
                    <View style={[styles.card, SHADOW.xs]}>
                        <View style={styles.typePill}>
                            <Text style={styles.typePillText}>
                                {reminder.reminder_type}{!reminder.is_active ? ' · Deleted' : ''}
                            </Text>
                        </View>
                        <Text style={styles.reminderTitle}>{reminder.title}</Text>
                        <Text style={styles.reminderMeta}>
                            {reminder.is_active
                                ? `${formatTime(reminder.time_of_day)} · ${formatFrequency(reminder.frequency, reminder.days_of_week)}`
                                : 'No longer scheduled — showing historical data'}
                        </Text>

                        {reminder.notes ? (
                            <View style={styles.infoRow}>
                                <Ionicons name="document-text-outline" size={15} color={T.textMuted} style={styles.infoIcon} />
                                <Text style={styles.infoText}>{reminder.notes}</Text>
                            </View>
                        ) : null}

                        <View style={styles.infoRow}>
                            <Ionicons name="notifications-outline" size={15} color={T.textMuted} style={styles.infoIcon} />
                            <Text style={styles.infoText}>
                                Alert after {reminder.no_response_minutes} min with no response
                            </Text>
                        </View>

                        <View style={styles.infoRow}>
                            <Ionicons name="calendar-outline" size={14} color={T.textMuted} style={styles.infoIcon} />
                            <Text style={styles.infoText}>
                                Analytics start: {analyticsStartLabel}
                            </Text>
                        </View>
                    </View>

                    {/* ── Edit button / historical notice ── */}
                    {reminder.is_active ? (
                        <TouchableOpacity
                            style={[styles.editButton, SHADOW.xs]}
                            onPress={() =>
                                router.push({ pathname: '/edit-reminder', params: { reminderId } })
                            }
                            activeOpacity={0.8}
                        >
                            <Ionicons name="pencil-outline" size={18} color={T.primary} />
                            <Text style={styles.editButtonText}>Edit Reminder</Text>
                            <Ionicons name="chevron-forward" size={16} color={T.primary} style={styles.editButtonChevron} />
                        </TouchableOpacity>
                    ) : (
                        <View style={styles.historicalNotice}>
                            <Ionicons name="time-outline" size={16} color={T.textMuted} />
                            <Text style={styles.historicalNoticeText}>
                                Viewing historical data for a deleted reminder.
                            </Text>
                        </View>
                    )}

                    {/* ── Adherence grid ── */}
                    <View style={styles.adherenceGrid}>
                        {[
                            { label: 'This week',  pct: stats.weekAdherence },
                            { label: 'This month', pct: stats.monthAdherence },
                        ].map(({ label, pct }) => {
                            const color = getAdherenceColor(pct);
                            return (
                                <View key={label} style={[styles.adherenceCell, SHADOW.xs]}>
                                    <Text style={styles.adherenceCellLabel}>{label}</Text>
                                    <Text style={[styles.adherenceCellPct, { color }]}>
                                        {pct !== null ? `${pct}%` : '—'}
                                    </Text>
                                    {pct !== null && (
                                        <View style={styles.adherenceBarTrack}>
                                            <View
                                                style={[
                                                    styles.adherenceBarFill,
                                                    { width: `${pct}%`, backgroundColor: color },
                                                ]}
                                            />
                                        </View>
                                    )}
                                    {pct === null && (
                                        <Text style={styles.adherenceNoData}>No data yet</Text>
                                    )}
                                </View>
                            );
                        })}
                    </View>

                    {/* ── Month counts ── */}
                    <View style={[styles.card, SHADOW.xs]}>
                        <Text style={styles.sectionTitle}>Month-to-date</Text>

                        <View style={styles.countGrid}>
                            {[
                                { label: 'Taken',   value: stats.taken,   color: '#15803D', bg: '#DCFCE7' },
                                { label: 'Missed',  value: stats.missed,  color: '#B91C1C', bg: '#FEE2E2' },
                                { label: 'Skipped', value: stats.skipped, color: '#B45309', bg: '#FEF3C7' },
                                { label: 'Snoozed', value: stats.snoozed, color: '#1D4ED8', bg: '#DBEAFE' },
                                { label: 'Pending', value: stats.pending, color: T.textSecondary, bg: T.bgAlt },
                            ].map(({ label, value, color, bg }) => (
                                <View key={label} style={[styles.countChip, { backgroundColor: bg }]}>
                                    <Text style={[styles.countChipNum, { color }]}>{value}</Text>
                                    <Text style={[styles.countChipLabel, { color }]}>{label}</Text>
                                </View>
                            ))}
                        </View>

                        {stats.avgResponseMinutes !== null && (
                            <View style={styles.avgRow}>
                                <Ionicons name="timer-outline" size={15} color={T.textMuted} />
                                <Text style={styles.avgText}>
                                    Avg response time: {stats.avgResponseMinutes} min
                                </Text>
                            </View>
                        )}
                    </View>

                    {/* ── History ── */}
                    <View style={[styles.card, SHADOW.xs]}>
                        <Text style={styles.sectionTitle}>Recent History</Text>
                        <Text style={styles.sectionSub}>
                            Month-to-date · before {analyticsStartLabel} not counted
                        </Text>

                        {history.length === 0 ? (
                            <View style={styles.emptyHistory}>
                                <Ionicons name="hourglass-outline" size={28} color={T.textMuted} />
                                <Text style={styles.emptyHistoryTitle}>No history yet</Text>
                                <Text style={styles.emptyHistoryText}>
                                    This reminder is too new or hasn't had any eligible occurrences this month. History will appear here as days pass.
                                </Text>
                            </View>
                        ) : (
                            history.map((entry) => (
                                <View key={entry.dateString} style={styles.historyRow}>
                                    <Text style={styles.historyDate}>{entry.dateLabel}</Text>
                                    <View
                                        style={[
                                            styles.historyBadge,
                                            { backgroundColor: statusBg(entry.status) },
                                        ]}
                                    >
                                        <Text
                                            style={[
                                                styles.historyBadgeText,
                                                { color: statusColor(entry.status) },
                                            ]}
                                        >
                                            {statusLabel(entry.status)}
                                        </Text>
                                    </View>
                                </View>
                            ))
                        )}
                    </View>
                </ScrollView>
            ) : null}
        </SafeAreaView>
    );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: T.bgPage },
    content:   { padding: 20, paddingBottom: 48 },

    // ── Nav bar ───────────────────────────────────────────────────────────────
    navBar: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: T.border,
        backgroundColor: T.bgSurface,
    },
    backBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        width: 100,
    },
    backText: { fontSize: 15, color: T.primary, fontWeight: '600' },
    navTitle: {
        fontSize: 16,
        fontWeight: '700',
        color: T.textPrimary,
        letterSpacing: -0.2,
    },
    navSpacer: { width: 100 },

    // ── States ────────────────────────────────────────────────────────────────
    centered: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
        gap: 12,
    },
    loadingText: { fontSize: 14, color: T.textMuted, fontWeight: '600', marginTop: 8 },
    errorIconWrap: {
        width: 60,
        height: 60,
        borderRadius: RADIUS.lg,
        backgroundColor: T.bgAlt,
        alignItems: 'center',
        justifyContent: 'center',
    },
    errorTitle: { fontSize: 17, fontWeight: '700', color: T.textPrimary, textAlign: 'center' },
    errorText:  { fontSize: 14, color: T.textMuted, textAlign: 'center', lineHeight: 20 },
    errorBack: {
        marginTop: 8,
        paddingHorizontal: 24,
        paddingVertical: 12,
        backgroundColor: T.primary,
        borderRadius: RADIUS.lg,
    },
    errorBackText: { color: T.textInverse, fontSize: 15, fontWeight: '700' },

    // ── Generic card ──────────────────────────────────────────────────────────
    card: {
        backgroundColor: T.bgSurface,
        borderRadius: RADIUS.xl,
        padding: 20,
        marginBottom: 14,
    },

    // ── Reminder info ─────────────────────────────────────────────────────────
    typePill: {
        alignSelf: 'flex-start',
        backgroundColor: T.primaryLight,
        borderRadius: RADIUS.full,
        paddingHorizontal: 12,
        paddingVertical: 4,
        marginBottom: 12,
    },
    typePillText: {
        fontSize: 12,
        fontWeight: '700',
        color: T.primary,
        textTransform: 'capitalize',
        letterSpacing: 0.3,
    },
    reminderTitle: {
        fontSize: 26,
        fontWeight: '800',
        color: T.textPrimary,
        letterSpacing: -0.6,
        marginBottom: 6,
    },
    reminderMeta: {
        fontSize: 15,
        color: T.textSecondary,
        fontWeight: '500',
        marginBottom: 16,
    },
    infoRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
        marginBottom: 8,
    },
    infoIcon: { marginTop: 1 },
    infoText: {
        fontSize: 14,
        color: T.textSecondary,
        lineHeight: 20,
        flex: 1,
    },

    // ── Adherence grid ────────────────────────────────────────────────────────
    adherenceGrid: {
        flexDirection: 'row',
        gap: 10,
        marginBottom: 14,
    },
    adherenceCell: {
        flex: 1,
        backgroundColor: T.bgSurface,
        borderRadius: RADIUS.xl,
        padding: 16,
    },
    adherenceCellLabel: {
        fontSize: 12,
        fontWeight: '600',
        color: T.textMuted,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        marginBottom: 6,
    },
    adherenceCellPct: {
        fontSize: 34,
        fontWeight: '800',
        letterSpacing: -1,
        lineHeight: 40,
    },
    adherenceBarTrack: {
        height: 4,
        backgroundColor: T.bgAlt,
        borderRadius: RADIUS.full,
        marginTop: 10,
        overflow: 'hidden',
    },
    adherenceBarFill: { height: '100%', borderRadius: RADIUS.full },
    adherenceNoData: {
        fontSize: 12,
        color: T.textMuted,
        marginTop: 6,
        fontWeight: '500',
    },

    // ── Month counts ──────────────────────────────────────────────────────────
    sectionTitle: {
        fontSize: 17,
        fontWeight: '700',
        color: T.textPrimary,
        letterSpacing: -0.2,
        marginBottom: 4,
    },
    sectionSub: {
        fontSize: 13,
        color: T.textMuted,
        fontWeight: '500',
        marginBottom: 14,
    },
    countGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        marginBottom: 4,
    },
    countChip: {
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: RADIUS.md,
        alignItems: 'center',
        minWidth: 64,
    },
    countChipNum: {
        fontSize: 22,
        fontWeight: '800',
        letterSpacing: -0.5,
    },
    countChipLabel: {
        fontSize: 11,
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: 0.3,
        marginTop: 2,
    },
    avgRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginTop: 14,
        paddingTop: 14,
        borderTopWidth: 1,
        borderTopColor: T.bgAlt,
    },
    avgText: { fontSize: 14, color: T.textSecondary, fontWeight: '500' },

    // ── History ───────────────────────────────────────────────────────────────
    emptyHistory: {
        alignItems: 'center',
        paddingVertical: 24,
        gap: 8,
    },
    emptyHistoryTitle: {
        fontSize: 16,
        fontWeight: '700',
        color: T.textPrimary,
    },
    emptyHistoryText: {
        fontSize: 14,
        color: T.textMuted,
        lineHeight: 20,
        textAlign: 'center',
    },
    historyRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 12,
        borderTopWidth: 1,
        borderTopColor: T.bgAlt,
        gap: 10,
    },
    historyDate: {
        flex: 1,
        fontSize: 14,
        fontWeight: '600',
        color: T.textPrimary,
    },
    historyBadge: {
        paddingHorizontal: 11,
        paddingVertical: 5,
        borderRadius: RADIUS.full,
    },
    historyBadgeText: { fontSize: 12, fontWeight: '700' },

    // ── Nav edit button ───────────────────────────────────────────────────────
    editNavBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        width: 100,
        justifyContent: 'flex-end',
    },
    editNavText: { fontSize: 15, color: T.primary, fontWeight: '600' },

    // ── Inline edit button ────────────────────────────────────────────────────
    editButton: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: T.primaryLight,
        borderRadius: RADIUS.xl,
        paddingVertical: 14,
        paddingHorizontal: 18,
        marginBottom: 14,
        borderWidth: 1,
        borderColor: T.primaryMid,
    },
    editButtonText: {
        flex: 1,
        fontSize: 15,
        fontWeight: '700',
        color: T.primary,
        marginLeft: 10,
        letterSpacing: -0.2,
    },
    editButtonChevron: { marginLeft: 4 },

    // ── Historical notice (inactive reminder) ───────────────────────────────────
    historicalNotice: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: T.bgAlt,
        borderRadius: RADIUS.xl,
        paddingVertical: 14,
        paddingHorizontal: 18,
        marginBottom: 14,
    },
    historicalNoticeText: {
        flex: 1,
        fontSize: 14,
        fontWeight: '500',
        color: T.textMuted,
        letterSpacing: -0.1,
    },
});
