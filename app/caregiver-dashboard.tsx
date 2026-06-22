import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import {
    ActivityIndicator,
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
import { registerCaregiverPushToken } from '@/lib/notifications';
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
    frequency: 'daily' | 'weekdays' | 'weekends';
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
};

type ReminderDisplay = {
    id: string;
    name: string;
    time: string;
    status: ReminderStatus;
};

type DayData = {
    dateString: string;
    dateLabel: string;
    shortLabel: string;
    monthDay: number;
    scheduledCount: number;
    eligibleCount: number;
    countableCount: number;
    takenCount: number;
    pendingCount: number;
    missedCount: number;
    skippedCount: number;
    snoozedCount: number;
    adherence: number;
    hasData: boolean;
    isFuture: boolean;
    reminders: ReminderDisplay[];
};

type ReminderBreakdownItem = {
    id: string;
    name: string;
    time_of_day: string;
    frequency: 'daily' | 'weekdays' | 'weekends';
    completed: number;
    scheduled: number;
    missed: number;
    skipped: number;
    snoozed: number;
    pending: number;
    adherence: number;
    isActive: boolean;
};

type ConnectionSummary = {
    id: string;
    status: 'none' | 'pending' | 'accepted';
    inviteCode?: string;
    recipientName?: string;
    acceptedAt?: string;
};

type RangeStats = { adherence: number | null; countable: number; taken: number };

// ─── Pure date helpers ────────────────────────────────────────────────────────

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

function formatDateLabel(date: Date): string {
    return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
}

function formatShortDay(date: Date): string {
    return date.toLocaleDateString(undefined, { weekday: 'short' });
}

function formatTime(time: string): string {
    const [hStr, mStr] = time.split(':');
    let h = Number(hStr);
    const suffix = h >= 12 ? 'PM' : 'AM';
    if (h === 0) h = 12;
    else if (h > 12) h -= 12;
    return `${h}:${mStr} ${suffix}`;
}

function formatStatus(status: ReminderStatus): string {
    const map: Record<ReminderStatus, string> = {
        taken: 'Taken', snoozed: 'Snoozed', skipped: 'Skipped', missed: 'Missed', pending: 'Pending',
    };
    return map[status] ?? 'Pending';
}

function formatFrequency(freq: Reminder['frequency']): string {
    if (freq === 'daily') return 'Every day';
    if (freq === 'weekdays') return 'Weekdays';
    if (freq === 'weekends') return 'Weekends';
    return freq;
}

function shouldShowOnDate(frequency: Reminder['frequency'], date: Date): boolean {
    const day = date.getDay();
    const isWeekend = day === 0 || day === 6;
    if (frequency === 'daily') return true;
    if (frequency === 'weekdays') return !isWeekend;
    if (frequency === 'weekends') return isWeekend;
    return true;
}

function buildScheduledDateTime(dateString: string, timeOfDay: string): Date {
    const [yr, mo, dy] = dateString.split('-').map(Number);
    const [hr, mn] = timeOfDay.split(':').map(Number);
    return new Date(yr, mo - 1, dy, hr, mn, 0, 0);
}

// ─── Analytics helpers ────────────────────────────────────────────────────────

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

function isReminderEligibleOnDate(
    reminder: Reminder,
    date: Date,
    connectionAcceptedAt: string
): boolean {
    if (!shouldShowOnDate(reminder.frequency, date)) return false;
    const start     = getAnalyticsStartDate(connectionAcceptedAt, reminder.created_at, reminder.time_of_day);
    const dateStart = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
    if (dateStart < start) return false;

    // Soft-deleted reminders keep their past logs/history, but stop being
    // eligible for any date after they were deactivated (no future/missed
    // occurrences once deleted).
    if (!reminder.is_active) {
        const deactivatedAt = new Date(reminder.updated_at);
        const deactivatedDateStart = new Date(
            deactivatedAt.getFullYear(), deactivatedAt.getMonth(), deactivatedAt.getDate(), 0, 0, 0, 0
        );
        if (dateStart > deactivatedDateStart) return false;
    }

    return true;
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

function buildDayData(
    date: Date,
    reminders: Reminder[],
    logs: ReminderLog[],
    connectionAcceptedAt: string
): DayData {
    const dateString  = getLocalDateString(date);
    const todayString = getLocalDateString(new Date());
    const isFuture    = dateString > todayString;

    const scheduledReminders = reminders.filter((r) => shouldShowOnDate(r.frequency, date));
    const eligibleReminders  = scheduledReminders.filter((r) =>
        isReminderEligibleOnDate(r, date, connectionAcceptedAt)
    );

    const reminderDisplays: ReminderDisplay[] = eligibleReminders.map((reminder) => {
        const log = logs.find(
            (l) => l.reminder_id === reminder.id && l.occurrence_date === dateString
        );
        return {
            id:     reminder.id,
            name:   reminder.title,
            time:   formatTime(reminder.time_of_day),
            status: getComputedStatus(reminder, dateString, todayString, log),
        };
    });

    const takenCount    = reminderDisplays.filter((r) => r.status === 'taken').length;
    const pendingCount  = reminderDisplays.filter((r) => r.status === 'pending').length;
    const missedCount   = reminderDisplays.filter((r) => r.status === 'missed').length;
    const skippedCount  = reminderDisplays.filter((r) => r.status === 'skipped').length;
    const snoozedCount  = reminderDisplays.filter((r) => r.status === 'snoozed').length;
    const countableCount = reminderDisplays.filter((r) => r.status !== 'pending').length;
    const adherence     = countableCount === 0 ? 0 : Math.round((takenCount / countableCount) * 100);

    return {
        dateString,
        dateLabel:     formatDateLabel(date),
        shortLabel:    formatShortDay(date),
        monthDay:      date.getDate(),
        scheduledCount: scheduledReminders.length,
        eligibleCount:  eligibleReminders.length,
        countableCount,
        takenCount,
        pendingCount,
        missedCount,
        skippedCount,
        snoozedCount,
        adherence,
        hasData: eligibleReminders.length > 0,
        isFuture,
        reminders: reminderDisplays,
    };
}

function getRangeStats(days: DayData[]): RangeStats {
    const todayString = getLocalDateString(new Date());
    const past        = days.filter((d) => d.dateString <= todayString);
    const countable   = past.reduce((s, d) => s + d.countableCount, 0);
    const taken       = past.reduce((s, d) => s + d.takenCount, 0);
    return {
        adherence: countable === 0 ? null : Math.round((taken / countable) * 100),
        countable,
        taken,
    };
}

function buildReminderBreakdown(
    reminders: Reminder[],
    logs: ReminderLog[],
    monthDates: Date[],
    connectionAcceptedAt: string
): ReminderBreakdownItem[] {
    const todayString = getLocalDateString(new Date());
    return reminders.map((reminder) => {
        let scheduled = 0, completed = 0, missed = 0, skipped = 0, snoozed = 0, pending = 0;
        monthDates.forEach((date) => {
            const dateString = getLocalDateString(date);
            if (dateString > todayString) return;
            if (!isReminderEligibleOnDate(reminder, date, connectionAcceptedAt)) return;
            const log    = logs.find((l) => l.reminder_id === reminder.id && l.occurrence_date === dateString);
            const status = getComputedStatus(reminder, dateString, todayString, log);
            if (status === 'pending') { pending += 1; return; }
            scheduled += 1;
            if (status === 'taken')   completed += 1;
            if (status === 'missed')  missed    += 1;
            if (status === 'skipped') skipped   += 1;
            if (status === 'snoozed') snoozed   += 1;
        });
        return {
            id: reminder.id,
            name: reminder.title,
            time_of_day: reminder.time_of_day,
            frequency: reminder.frequency,
            completed,
            scheduled,
            missed,
            skipped,
            snoozed,
            pending,
            adherence: scheduled === 0 ? 0 : Math.round((completed / scheduled) * 100),
            isActive: reminder.is_active,
        };
    });
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function getAdherenceColor(pct: number | null): string {
    if (pct === null) return T.textMuted;
    if (pct >= 80) return T.success;
    if (pct >= 50) return '#D97706';
    return T.error;
}

function getStatusPillStyle(status: ReminderStatus) {
    if (status === 'taken')   return styles.takenPill;
    if (status === 'missed')  return styles.missedPill;
    if (status === 'skipped') return styles.skippedPill;
    if (status === 'snoozed') return styles.snoozedPill;
    return styles.pendingPill;
}

function getStatusTextStyle(status: ReminderStatus) {
    if (status === 'taken')   return styles.takenText;
    if (status === 'missed')  return styles.missedText;
    if (status === 'skipped') return styles.skippedText;
    if (status === 'snoozed') return styles.snoozedText;
    return styles.pendingText;
}

function getHeatmapStyle(day: DayData) {
    const todayString = getLocalDateString(new Date());
    if (day.dateString > todayString) return styles.heatmapFuture;
    if (!day.hasData) return styles.heatmapNoData;
    if (day.countableCount === 0 && day.pendingCount > 0) return styles.heatmapPending;
    if (day.countableCount === 0) return styles.heatmapEmpty;
    if (day.adherence === 100) return styles.heatmapHigh;
    if (day.adherence >= 75)   return styles.heatmapMedium;
    if (day.adherence >= 50)   return styles.heatmapLow;
    return styles.heatmapMissed;
}

function getBarColor(day: DayData): string {
    if (!day.hasData || day.isFuture) return T.border;
    if (day.countableCount === 0)     return T.primaryMid;
    return getAdherenceColor(day.adherence);
}

function getBarHeight(day: DayData): string {
    if (!day.hasData || day.isFuture) return '8%';
    if (day.countableCount === 0)     return '10%';
    return `${Math.max(day.adherence, 6)}%`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ReminderRow({ reminder }: { reminder: ReminderDisplay }) {
    return (
        <View style={styles.reminderRow}>
            <View style={[styles.reminderStatusBar, getStatusPillStyle(reminder.status)]} />
            <View style={styles.reminderTextBlock}>
                <Text style={styles.reminderName}>{reminder.name}</Text>
                <Text style={styles.reminderTime}>{reminder.time}</Text>
            </View>
            <View style={[styles.statusPill, getStatusPillStyle(reminder.status)]}>
                <Text style={[styles.statusText, getStatusTextStyle(reminder.status)]}>
                    {formatStatus(reminder.status)}
                </Text>
            </View>
        </View>
    );
}

function MetricTile({ count, label, color, bg }: { count: number; label: string; color: string; bg: string }) {
    return (
        <View style={[styles.metricTile, { backgroundColor: bg }]}>
            <Text style={[styles.metricTileCount, { color }]}>{count}</Text>
            <Text style={[styles.metricTileLabel, { color }]}>{label}</Text>
        </View>
    );
}

function BreakdownCard({ item }: { item: ReminderBreakdownItem }) {
    const hasCountable   = item.scheduled > 0;
    const adherenceColor = hasCountable ? getAdherenceColor(item.adherence) : T.textMuted;

    const chips = [
        item.completed > 0 ? { label: `${item.completed} Taken`,   bg: '#DCFCE7', color: '#15803D' } : null,
        item.missed    > 0 ? { label: `${item.missed} Missed`,     bg: '#FEE2E2', color: '#B91C1C' } : null,
        item.skipped   > 0 ? { label: `${item.skipped} Skipped`,   bg: '#FEF3C7', color: '#B45309' } : null,
        item.snoozed   > 0 ? { label: `${item.snoozed} Snoozed`,   bg: '#DBEAFE', color: '#1D4ED8' } : null,
        item.pending   > 0 ? { label: `${item.pending} Pending`,   bg: T.bgAlt,   color: T.textMuted } : null,
    ].filter(Boolean) as { label: string; bg: string; color: string }[];

    let summaryText: string;
    if (!hasCountable && item.pending === 0) {
        summaryText = 'No countable history yet';
    } else if (!hasCountable) {
        summaryText = `${item.pending} pending — no past data yet`;
    } else if (item.adherence === 100) {
        summaryText = `${item.completed} of ${item.scheduled} taken`;
    } else if (item.missed > 0 && item.pending > 0) {
        summaryText = `${item.missed} missed · ${item.pending} pending`;
    } else if (item.missed > 0) {
        summaryText = `${item.missed} missed this month`;
    } else if (item.pending > 0) {
        summaryText = `${item.pending} pending today`;
    } else {
        summaryText = `${item.completed} of ${item.scheduled} taken`;
    }

    return (
        <TouchableOpacity
            style={[styles.bcCard, SHADOW.xs]}
            onPress={() =>
                router.push({ pathname: '/reminder-details', params: { reminderId: item.id } })
            }
            activeOpacity={0.75}
        >
            <View style={styles.bcHeader}>
                <View style={{ flex: 1 }}>
                    <View style={styles.bcNameRow}>
                        <Text style={styles.bcName} numberOfLines={1}>{item.name}</Text>
                        {!item.isActive && (
                            <View style={styles.bcDeletedPill}>
                                <Text style={styles.bcDeletedText}>Deleted</Text>
                            </View>
                        )}
                    </View>
                    <Text style={styles.bcMeta}>
                        {item.isActive
                            ? `${formatTime(item.time_of_day)} · ${formatFrequency(item.frequency)}`
                            : 'No longer scheduled'}
                    </Text>
                </View>
                <View style={styles.bcAdherenceBlock}>
                    <Text style={[styles.bcAdherencePct, { color: adherenceColor }]}>
                        {hasCountable ? `${item.adherence}%` : '—'}
                    </Text>
                    <Text style={styles.bcAdherenceLabel}>adherence</Text>
                </View>
            </View>

            {hasCountable && (
                <>
                    <View style={styles.bcProgressTrack}>
                        <View
                            style={[
                                styles.bcProgressFill,
                                { width: `${item.adherence}%`, backgroundColor: adherenceColor },
                            ]}
                        />
                    </View>
                    <Text style={styles.bcCountLine}>
                        {item.completed} of {item.scheduled} countable scheduled
                    </Text>
                </>
            )}

            {chips.length > 0 && (
                <View style={styles.bcChips}>
                    {chips.map((chip) => (
                        <View key={chip.label} style={[styles.bcChip, { backgroundColor: chip.bg }]}>
                            <Text style={[styles.bcChipText, { color: chip.color }]}>{chip.label}</Text>
                        </View>
                    ))}
                </View>
            )}

            <View style={styles.bcFooter}>
                <Text style={styles.bcSummary}>{summaryText}</Text>
                <View style={styles.bcCta}>
                    <Text style={styles.bcCtaText}>Details</Text>
                    <Ionicons name="chevron-forward" size={13} color={T.primary} />
                </View>
            </View>
        </TouchableOpacity>
    );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function CaregiverDashboard() {
    const [selectedRange, setSelectedRange]         = useState<'Today' | 'Week' | 'Month'>('Today');
    const [selectedWeekIndex, setSelectedWeekIndex] = useState(new Date().getDay());
    const [selectedMonthIndex, setSelectedMonthIndex] = useState(new Date().getDate() - 1);

    const [connectionLoading, setConnectionLoading] = useState(true);
    const [dashboardLoading, setDashboardLoading]   = useState(true);

    const pushRegistrationAttemptedRef = useRef(false);

    const [connectionSummary, setConnectionSummary] = useState<ConnectionSummary>({ id: '', status: 'none' });
    const [todayData, setTodayData]                 = useState<DayData | null>(null);
    const [weeklyData, setWeeklyData]               = useState<DayData[]>([]);
    const [monthData, setMonthData]                 = useState<DayData[]>([]);
    const [reminderBreakdown, setReminderBreakdown] = useState<ReminderBreakdownItem[]>([]);
    const [settingsVisible, setSettingsVisible]     = useState(false);

    async function loadDashboardData() {
        setConnectionLoading(true);
        setDashboardLoading(true);

        const { data: { user }, error: userError } = await supabase.auth.getUser();

        if (userError || !user) {
            setConnectionLoading(false);
            setDashboardLoading(false);
            router.replace('/signin');
            return;
        }

        if (!pushRegistrationAttemptedRef.current) {
            pushRegistrationAttemptedRef.current = true;
            registerCaregiverPushToken(user.id)
                .then((result) => {
                    if (!result.ok) {
                        console.warn('[caregiver-dashboard] push registration failed', result);
                    }
                })
                .catch((err) => console.warn('[caregiver-dashboard] push registration error:', err));
        }

        const { data: connections, error: connectionError } = await supabase
            .from('connections')
            .select('id, invite_code, status, recipient_id, created_at, accepted_at')
            .eq('caregiver_id', user.id)
            .order('created_at', { ascending: false })
            .limit(10);

        if (connectionError) {
            console.log(connectionError.message);
            setConnectionLoading(false);
            setDashboardLoading(false);
            return;
        }

        const acceptedConnection = connections?.find(
            (c) => c.status === 'accepted' && c.recipient_id
        );

        if (!acceptedConnection) {
            const pendingConnection = connections?.find((c) => c.status === 'pending');
            setConnectionSummary(
                pendingConnection
                    ? { id: pendingConnection.id, status: 'pending', inviteCode: pendingConnection.invite_code }
                    : { id: '', status: 'none' }
            );
            setTodayData(null);
            setWeeklyData([]);
            setMonthData([]);
            setReminderBreakdown([]);
            setConnectionLoading(false);
            setDashboardLoading(false);
            return;
        }

        const { data: recipientProfile, error: profileError } = await supabase
            .from('profiles')
            .select('full_name')
            .eq('id', acceptedConnection.recipient_id)
            .maybeSingle();

        if (profileError) console.log(profileError.message);

        // Fallback: if accepted_at is null, use created_at
        const acceptedAt: string =
            acceptedConnection.accepted_at ||
            acceptedConnection.created_at  ||
            new Date().toISOString();

        setConnectionSummary({
            id: acceptedConnection.id,
            status: 'accepted',
            inviteCode: acceptedConnection.invite_code,
            recipientName: recipientProfile?.full_name || 'Loved one',
            acceptedAt,
        });

        setConnectionLoading(false);

        const { data: remindersData, error: remindersError } = await supabase
            .from('reminders')
            .select(
                'id, connection_id, caregiver_id, recipient_id, title, reminder_type, notes, time_of_day, frequency, no_response_minutes, created_at, is_active, updated_at'
            )
            .eq('caregiver_id', user.id)
            .eq('connection_id', acceptedConnection.id)
            .order('time_of_day', { ascending: true });

        if (remindersError) {
            console.log(remindersError.message);
            setDashboardLoading(false);
            return;
        }

        const reminders  = (remindersData || []) as Reminder[];
        const today      = new Date();
        const weekStart  = getStartOfWeek(today);
        const weekDates  = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
        const monthDates = getMonthDates(today);

        const earliestDate = weekDates[0] < monthDates[0] ? weekDates[0] : monthDates[0];
        const latestDate   =
            weekDates[6] > monthDates[monthDates.length - 1]
                ? weekDates[6]
                : monthDates[monthDates.length - 1];

        let logs: ReminderLog[] = [];

        if (reminders.length > 0) {
            const reminderIds = reminders.map((r) => r.id);
            const { data: logsData, error: logsError } = await supabase
                .from('reminder_logs')
                .select('reminder_id, occurrence_date, status, completed_at, snoozed_until')
                .eq('caregiver_id', user.id)
                .gte('occurrence_date', getLocalDateString(earliestDate))
                .lte('occurrence_date', getLocalDateString(latestDate))
                .in('reminder_id', reminderIds);

            if (logsError) console.log(logsError.message);
            else logs = (logsData || []) as ReminderLog[];
        }

        const todayDayData = buildDayData(today, reminders, logs, acceptedAt);
        const weekDayData  = weekDates.map((d) => buildDayData(d, reminders, logs, acceptedAt));
        const monthDayData = monthDates.map((d) => buildDayData(d, reminders, logs, acceptedAt));

        setSelectedWeekIndex(today.getDay());
        setSelectedMonthIndex(today.getDate() - 1);
        setTodayData(todayDayData);
        setWeeklyData(weekDayData);
        setMonthData(monthDayData);
        setReminderBreakdown(buildReminderBreakdown(reminders, logs, monthDates, acceptedAt));
        setDashboardLoading(false);
    }

    useFocusEffect(useCallback(() => { loadDashboardData(); }, []));

    function handleCreateReminder() {
        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        if (connectionSummary.status !== 'accepted') {
            router.push('/invite-recipient');
            return;
        }
        router.push('/create-reminder');
    }

    // ── Connection card ─────────────────────────────────────────────────────

    function ConnectionCard() {
        if (connectionLoading) {
            return (
                <View style={[styles.connectionCard, SHADOW.xs]}>
                    <View style={styles.connectionCardInner}>
                        <View style={[styles.connectionIconWrap, { backgroundColor: T.bgAlt }]}>
                            <ActivityIndicator size="small" color={T.textMuted} />
                        </View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.connectionLabel}>Care Connection</Text>
                            <Text style={styles.connectionTitle}>Checking connection…</Text>
                        </View>
                    </View>
                </View>
            );
        }

        if (connectionSummary.status === 'none') {
            return (
                <View style={[styles.connectionCard, SHADOW.xs]}>
                    <View style={styles.connectionCardInner}>
                        <View style={[styles.connectionIconWrap, { backgroundColor: T.bgAlt }]}>
                            <Ionicons name="link-outline" size={22} color={T.textMuted} />
                        </View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.connectionLabel}>Care Connection</Text>
                            <Text style={styles.connectionTitle}>No loved one linked</Text>
                            <Text style={styles.connectionText}>
                                Send an invite so they can receive reminders.
                            </Text>
                        </View>
                    </View>
                    <TouchableOpacity
                        style={[styles.connectionButton, SHADOW.primary]}
                        onPress={() => router.push('/invite-recipient')}
                        activeOpacity={0.88}
                    >
                        <Text style={styles.connectionButtonText}>Invite Loved One</Text>
                    </TouchableOpacity>
                </View>
            );
        }

        if (connectionSummary.status === 'pending') {
            return (
                <View style={[styles.connectionCard, styles.connectionCardPending, SHADOW.xs]}>
                    <View style={styles.connectionCardInner}>
                        <View style={[styles.connectionIconWrap, { backgroundColor: '#FEF3C7' }]}>
                            <Ionicons name="time-outline" size={22} color="#D97706" />
                        </View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.connectionLabel}>Care Connection</Text>
                            <Text style={styles.connectionTitle}>Waiting for acceptance</Text>
                            <Text style={styles.connectionText}>
                                Share this code with your loved one:
                            </Text>
                        </View>
                    </View>
                    <View style={styles.inviteCodePill}>
                        <Text style={styles.inviteCodeText}>{connectionSummary.inviteCode}</Text>
                    </View>
                    <TouchableOpacity
                        style={styles.connectionButtonOutline}
                        onPress={() => router.push('/invite-recipient')}
                        activeOpacity={0.75}
                    >
                        <Text style={styles.connectionButtonOutlineText}>View Full Invite</Text>
                    </TouchableOpacity>
                </View>
            );
        }

        return (
            <View style={[styles.connectionCard, styles.connectionCardAccepted, SHADOW.xs]}>
                <View style={styles.connectionCardInner}>
                    <View style={[styles.connectionIconWrap, { backgroundColor: T.successLight }]}>
                        <Ionicons name="checkmark-circle" size={22} color={T.success} />
                    </View>
                    <View style={{ flex: 1 }}>
                        <Text style={styles.connectionLabel}>Care Connection</Text>
                        <Text style={styles.connectionTitle}>{connectionSummary.recipientName}</Text>
                        <Text style={styles.connectionText}>Connected · reminders are active.</Text>
                    </View>
                </View>
            </View>
        );
    }

    // ── Analytics section ───────────────────────────────────────────────────

    function renderAnalytics() {
        if (connectionSummary.status !== 'accepted') {
            return (
                <View style={[styles.card, SHADOW.xs]}>
                    <View style={styles.emptyState}>
                        <View style={styles.emptyIconWrap}>
                            <Ionicons name="bar-chart-outline" size={28} color={T.textMuted} />
                        </View>
                        <Text style={styles.emptyTitle}>No analytics yet</Text>
                        <Text style={styles.emptyText}>
                            Link a loved one first. Analytics appear once they start responding to reminders.
                        </Text>
                    </View>
                </View>
            );
        }

        if (dashboardLoading) {
            return (
                <View style={[styles.card, SHADOW.xs]}>
                    <View style={styles.loadingState}>
                        <ActivityIndicator color={T.primary} />
                        <Text style={styles.loadingText}>Loading care activity…</Text>
                    </View>
                </View>
            );
        }

        const rangeStats: RangeStats =
            selectedRange === 'Today' && todayData ? getRangeStats([todayData])
            : selectedRange === 'Week'             ? getRangeStats(weeklyData)
            :                                        getRangeStats(monthData);

        const selectedDay: DayData | undefined =
            selectedRange === 'Week'  ? weeklyData[selectedWeekIndex]
            : selectedRange === 'Month' ? monthData[selectedMonthIndex]
            : undefined;

        // First-day-of-month offset for heatmap alignment
        const monthOffset = monthData.length > 0
            ? new Date(monthData[0].dateString + 'T12:00:00').getDay()
            : 0;

        const adherenceColor = getAdherenceColor(rangeStats.adherence);

        return (
            <>
                {/* Range tabs */}
                <View style={[styles.tabContainer, SHADOW.xs]}>
                    {(['Today', 'Week', 'Month'] as const).map((range) => (
                        <TouchableOpacity
                            key={range}
                            style={[styles.tab, selectedRange === range && styles.activeTab]}
                            onPress={() => setSelectedRange(range)}
                            activeOpacity={0.75}
                        >
                            <Text style={[styles.tabText, selectedRange === range && styles.activeTabText]}>
                                {range}
                            </Text>
                        </TouchableOpacity>
                    ))}
                </View>

                {/* Adherence metric */}
                <View style={[styles.card, SHADOW.xs]}>
                    <Text style={styles.cardLabel}>{selectedRange} Adherence</Text>

                    {rangeStats.adherence !== null ? (
                        <>
                            <Text style={[styles.bigMetric, { color: adherenceColor }]}>
                                {rangeStats.adherence}%
                            </Text>
                            <View style={styles.adherenceBarTrack}>
                                <View
                                    style={[
                                        styles.adherenceBarFill,
                                        { width: `${rangeStats.adherence}%`, backgroundColor: adherenceColor },
                                    ]}
                                />
                            </View>
                            <Text style={styles.helperText}>
                                {rangeStats.taken} taken of {rangeStats.countable} countable reminder
                                {rangeStats.countable !== 1 ? 's' : ''}
                            </Text>
                        </>
                    ) : (
                        <>
                            <Text style={[styles.bigMetric, { color: T.textMuted }]}>—</Text>
                            <Text style={styles.helperText}>
                                {reminderBreakdown.length === 0
                                    ? 'No reminders created yet. Tap + to add one.'
                                    : 'No countable data yet — adherence appears once reminders pass their response window.'}
                            </Text>
                        </>
                    )}
                </View>

                {/* ── Today view ── */}
                {selectedRange === 'Today' && (
                    <View style={[styles.card, SHADOW.xs]}>
                        <Text style={styles.cardTitle}>Today's Reminders</Text>

                        {reminderBreakdown.length === 0 ? (
                            <>
                                <Text style={[styles.helperText, { marginBottom: 12 }]}>
                                    No reminders have been created yet.
                                </Text>
                                <View style={styles.inlineEmpty}>
                                    <Ionicons name="add-circle-outline" size={20} color={T.textMuted} />
                                    <Text style={styles.inlineEmptyText}>
                                        Tap + above to create the first reminder.
                                    </Text>
                                </View>
                            </>
                        ) : !todayData || todayData.eligibleCount === 0 ? (
                            <View style={styles.inlineEmpty}>
                                <Ionicons name="calendar-outline" size={20} color={T.textMuted} />
                                <Text style={styles.inlineEmptyText}>
                                    {todayData && todayData.scheduledCount > 0
                                        ? 'Reminders exist but are not active yet — analytics start from the day they were created.'
                                        : 'No reminders scheduled for today.'}
                                </Text>
                            </View>
                        ) : (
                            <>
                                <Text style={[styles.helperText, { marginBottom: 12 }]}>
                                    {todayData.eligibleCount} reminder
                                    {todayData.eligibleCount !== 1 ? 's' : ''} scheduled today
                                </Text>

                                {/* Stats row */}
                                <View style={styles.metricRow}>
                                    <MetricTile
                                        count={todayData.takenCount}
                                        label="Taken"
                                        color="#15803D"
                                        bg="#DCFCE7"
                                    />
                                    <MetricTile
                                        count={todayData.pendingCount}
                                        label="Pending"
                                        color={T.textSecondary}
                                        bg={T.bgAlt}
                                    />
                                    <MetricTile
                                        count={todayData.missedCount}
                                        label="Missed"
                                        color="#B91C1C"
                                        bg="#FEE2E2"
                                    />
                                    <MetricTile
                                        count={todayData.skippedCount + todayData.snoozedCount}
                                        label="Skipped"
                                        color="#B45309"
                                        bg="#FEF3C7"
                                    />
                                </View>

                                {todayData.reminders.map((reminder) => (
                                    <ReminderRow key={reminder.id} reminder={reminder} />
                                ))}
                            </>
                        )}
                    </View>
                )}

                {/* ── Week view ── */}
                {selectedRange === 'Week' && (
                    <View style={[styles.card, SHADOW.xs]}>
                        <Text style={styles.cardTitle}>Weekly Activity</Text>
                        <Text style={styles.helperText}>
                            Tap a day to see details. Gray bars = no data yet.
                        </Text>

                        <View style={styles.chart}>
                            {weeklyData.map((day, index) => (
                                <TouchableOpacity
                                    key={day.dateString}
                                    style={styles.barWrapper}
                                    onPress={() => setSelectedWeekIndex(index)}
                                    activeOpacity={0.7}
                                >
                                    <View style={styles.barTrack}>
                                        <View
                                            style={[
                                                styles.bar,
                                                {
                                                    height: getBarHeight(day) as any,
                                                    backgroundColor:
                                                        selectedWeekIndex === index && day.hasData
                                                            ? T.primaryDark
                                                            : getBarColor(day),
                                                },
                                            ]}
                                        />
                                    </View>
                                    <Text
                                        style={[
                                            styles.dayLabel,
                                            selectedWeekIndex === index && styles.selectedDayLabel,
                                        ]}
                                    >
                                        {day.shortLabel.charAt(0)}
                                    </Text>
                                </TouchableOpacity>
                            ))}
                        </View>
                    </View>
                )}

                {/* ── Month heatmap ── */}
                {selectedRange === 'Month' && (
                    <View style={[styles.card, SHADOW.xs]}>
                        <Text style={styles.cardTitle}>Monthly Heatmap</Text>
                        <Text style={styles.helperText}>Tap any day to see reminder details.</Text>

                        <View style={styles.weekLabels}>
                            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((label, i) => (
                                <Text key={`wl-${i}`} style={styles.weekLabel}>{label}</Text>
                            ))}
                        </View>

                        <View style={styles.heatmapGrid}>
                            {Array.from({ length: monthOffset }, (_, i) => (
                                <View key={`offset-${i}`} style={[styles.heatmapDay, styles.heatmapOffset]} />
                            ))}
                            {monthData.map((day, index) => (
                                <TouchableOpacity
                                    key={day.dateString}
                                    style={[
                                        styles.heatmapDay,
                                        getHeatmapStyle(day),
                                        selectedMonthIndex === index && styles.selectedHeatmapDay,
                                    ]}
                                    onPress={() => setSelectedMonthIndex(index)}
                                    activeOpacity={0.75}
                                >
                                    <Text style={styles.heatmapText}>{day.monthDay}</Text>
                                </TouchableOpacity>
                            ))}
                        </View>

                        <View style={styles.legendRow}>
                            {[
                                { style: styles.heatmapNoData,  label: 'No data' },
                                { style: styles.heatmapHigh,    label: '100%' },
                                { style: styles.heatmapMedium,  label: '75%+' },
                                { style: styles.heatmapLow,     label: '50%+' },
                                { style: styles.heatmapMissed,  label: '<50%' },
                                { style: styles.heatmapPending, label: 'Pending' },
                            ].map(({ style, label }) => (
                                <View key={label} style={styles.legendItem}>
                                    <View style={[styles.legendSwatch, style]} />
                                    <Text style={styles.legendLabel}>{label}</Text>
                                </View>
                            ))}
                        </View>
                    </View>
                )}

                {/* ── Selected day detail (Week / Month) ── */}
                {selectedRange !== 'Today' && selectedDay && (
                    <View style={[styles.card, SHADOW.xs]}>
                        <Text style={styles.cardTitle}>{selectedDay.dateLabel}</Text>

                        {selectedDay.isFuture ? (
                            <View style={styles.inlineEmpty}>
                                <Ionicons name="time-outline" size={20} color={T.textMuted} />
                                <Text style={styles.inlineEmptyText}>Future date — no data yet.</Text>
                            </View>
                        ) : !selectedDay.hasData ? (
                            <View style={styles.inlineEmpty}>
                                <Ionicons name="information-circle-outline" size={20} color={T.textMuted} />
                                <Text style={styles.inlineEmptyText}>
                                    No data — reminders had not started yet on this day. Analytics begin from the date each reminder was created.
                                </Text>
                            </View>
                        ) : selectedDay.eligibleCount === 0 ? (
                            <View style={styles.inlineEmpty}>
                                <Ionicons name="calendar-outline" size={20} color={T.textMuted} />
                                <Text style={styles.inlineEmptyText}>No reminders scheduled.</Text>
                            </View>
                        ) : (
                            <>
                                <Text style={styles.helperText}>
                                    {selectedDay.takenCount}/{selectedDay.eligibleCount} taken
                                    {selectedDay.pendingCount > 0
                                        ? ` · ${selectedDay.pendingCount} pending`
                                        : ''}
                                    {selectedDay.countableCount > 0
                                        ? ` · ${selectedDay.adherence}% adherence`
                                        : ''}
                                </Text>
                                {selectedDay.reminders.map((r) => (
                                    <ReminderRow key={r.id} reminder={r} />
                                ))}
                            </>
                        )}
                    </View>
                )}

                {/* ── Reminder breakdown ── */}
                <View style={styles.bdSection}>
                    <Text style={styles.bdSectionTitle}>Reminder Breakdown</Text>
                    <Text style={styles.bdSectionSub}>
                        Month-to-date · days before each reminder was created are excluded
                    </Text>
                </View>

                {reminderBreakdown.length === 0 ? (
                    <View style={[styles.card, SHADOW.xs]}>
                        <View style={styles.inlineEmpty}>
                            <Ionicons name="list-outline" size={20} color={T.textMuted} />
                            <Text style={styles.inlineEmptyText}>
                                No reminders created yet. Tap + to add one.
                            </Text>
                        </View>
                    </View>
                ) : (
                    reminderBreakdown.map((item) => (
                        <BreakdownCard key={item.id} item={item} />
                    ))
                )}
            </>
        );
    }

    // ── Render ──────────────────────────────────────────────────────────────

    const isRefreshing = connectionLoading || dashboardLoading;

    return (
        <SafeAreaView style={styles.container}>
            <ScrollView
                contentContainerStyle={styles.content}
                showsVerticalScrollIndicator={false}
                refreshControl={
                    <RefreshControl
                        refreshing={isRefreshing}
                        onRefresh={loadDashboardData}
                        tintColor={T.primary}
                        colors={[T.primary]}
                    />
                }
            >
                <View style={styles.header}>
                    <View style={styles.headerTextBlock}>
                        <Text style={styles.heading}>Care Overview</Text>
                        <Text style={styles.subheading}>
                            {!connectionLoading && connectionSummary.status === 'accepted' && connectionSummary.recipientName
                                ? `Tracking ${connectionSummary.recipientName}'s care`
                                : 'Loved one care activity'}
                        </Text>
                    </View>

                    <View style={styles.headerActions}>
                        <TouchableOpacity
                            style={styles.iconButton}
                            onPress={() => setSettingsVisible(true)}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        >
                            <Ionicons name="settings-outline" size={20} color={T.textSecondary} />
                        </TouchableOpacity>

                        <TouchableOpacity
                            style={styles.inviteButton}
                            onPress={() => router.push('/invite-recipient')}
                            activeOpacity={0.75}
                        >
                            <Ionicons name="person-add-outline" size={16} color={T.textSecondary} />
                            <Text style={styles.inviteButtonText}>Invite</Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                            style={[styles.createButton, SHADOW.primary]}
                            onPress={handleCreateReminder}
                            activeOpacity={0.88}
                        >
                            <Ionicons name="add" size={26} color={T.textInverse} />
                        </TouchableOpacity>
                    </View>
                </View>

                <ConnectionCard />

                {renderAnalytics()}
            </ScrollView>

            <SettingsSheet
                visible={settingsVisible}
                onClose={() => setSettingsVisible(false)}
            />
        </SafeAreaView>
    );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: T.bgPage },
    content:   { padding: 20, paddingBottom: 48 },

    // ── Header ──────────────────────────────────────────────────────────────
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 20,
        gap: 12,
    },
    headerTextBlock: { flex: 1 },
    heading: {
        fontSize: 30,
        fontWeight: '800',
        color: T.textPrimary,
        letterSpacing: -0.6,
    },
    subheading: {
        fontSize: 15,
        color: T.textSecondary,
        marginTop: 3,
        letterSpacing: -0.1,
    },
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    iconButton: {
        width: 40,
        height: 40,
        borderRadius: RADIUS.lg,
        backgroundColor: T.bgSurface,
        borderWidth: 1.5,
        borderColor: T.border,
        alignItems: 'center',
        justifyContent: 'center',
    },
    inviteButton: {
        height: 44,
        paddingHorizontal: 14,
        borderRadius: RADIUS.lg,
        backgroundColor: T.bgSurface,
        borderWidth: 1.5,
        borderColor: T.border,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: 6,
    },
    inviteButtonText: { color: T.textSecondary, fontSize: 14, fontWeight: '600' },
    createButton: {
        width: 44,
        height: 44,
        borderRadius: RADIUS.lg,
        backgroundColor: T.primary,
        alignItems: 'center',
        justifyContent: 'center',
    },

    // ── Connection card ──────────────────────────────────────────────────────
    connectionCard: {
        backgroundColor: T.bgSurface,
        borderRadius: RADIUS.xl,
        padding: 16,
        marginBottom: 16,
        borderWidth: 1.5,
        borderColor: T.border,
    },
    connectionCardPending:  { backgroundColor: '#FFFBEB', borderColor: '#FDE68A' },
    connectionCardAccepted: { backgroundColor: T.successLight, borderColor: '#A7F3D0' },
    connectionCardInner: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 14,
        marginBottom: 4,
    },
    connectionIconWrap: {
        width: 44,
        height: 44,
        borderRadius: RADIUS.md,
        justifyContent: 'center',
        alignItems: 'center',
        flexShrink: 0,
    },
    connectionLabel: {
        fontSize: 11,
        fontWeight: '700',
        color: T.textMuted,
        textTransform: 'uppercase',
        letterSpacing: 0.8,
        marginBottom: 4,
    },
    connectionTitle: {
        fontSize: 17,
        fontWeight: '700',
        color: T.textPrimary,
        letterSpacing: -0.3,
        marginBottom: 4,
    },
    connectionText: { fontSize: 14, color: T.textSecondary, lineHeight: 20 },
    connectionButton: {
        backgroundColor: T.primary,
        paddingVertical: 14,
        borderRadius: RADIUS.lg,
        alignItems: 'center',
        marginTop: 14,
    },
    connectionButtonText: {
        color: T.textInverse,
        fontSize: 15,
        fontWeight: '700',
        letterSpacing: -0.1,
    },
    connectionButtonOutline: {
        paddingVertical: 12,
        borderRadius: RADIUS.lg,
        alignItems: 'center',
        marginTop: 12,
        borderWidth: 1.5,
        borderColor: '#FDE68A',
    },
    connectionButtonOutlineText: { color: '#D97706', fontSize: 14, fontWeight: '700' },
    inviteCodePill: {
        backgroundColor: '#FEF3C7',
        borderRadius: RADIUS.md,
        paddingVertical: 10,
        paddingHorizontal: 16,
        alignItems: 'center',
        marginTop: 12,
        borderWidth: 1,
        borderColor: '#FDE68A',
    },
    inviteCodeText: {
        fontSize: 22,
        fontWeight: '800',
        color: '#92400E',
        letterSpacing: 4,
    },

    // ── Tabs ─────────────────────────────────────────────────────────────────
    tabContainer: {
        flexDirection: 'row',
        backgroundColor: T.bgSurface,
        borderRadius: RADIUS.lg,
        padding: 4,
        marginBottom: 14,
    },
    tab: {
        flex: 1,
        paddingVertical: 11,
        borderRadius: RADIUS.md,
        alignItems: 'center',
    },
    activeTab: { backgroundColor: T.primary },
    tabText: {
        fontSize: 14,
        fontWeight: '600',
        color: T.textMuted,
        letterSpacing: -0.1,
    },
    activeTabText: { color: T.textInverse, fontWeight: '700' },

    // ── Generic card ──────────────────────────────────────────────────────────
    card: {
        backgroundColor: T.bgSurface,
        borderRadius: RADIUS.xl,
        padding: 20,
        marginBottom: 14,
    },
    cardLabel: {
        fontSize: 13,
        color: T.textMuted,
        fontWeight: '600',
        textTransform: 'uppercase',
        letterSpacing: 0.6,
        marginBottom: 6,
    },
    cardTitle: {
        fontSize: 18,
        fontWeight: '700',
        color: T.textPrimary,
        letterSpacing: -0.3,
        marginBottom: 6,
    },

    // ── Adherence metric ──────────────────────────────────────────────────────
    bigMetric: {
        fontSize: 52,
        fontWeight: '800',
        letterSpacing: -2,
        lineHeight: 60,
    },
    adherenceBarTrack: {
        height: 6,
        backgroundColor: T.bgAlt,
        borderRadius: RADIUS.full,
        marginTop: 10,
        marginBottom: 12,
        overflow: 'hidden',
    },
    adherenceBarFill: { height: '100%', borderRadius: RADIUS.full },
    helperText: {
        fontSize: 14,
        color: T.textMuted,
        lineHeight: 20,
        letterSpacing: -0.1,
    },

    // ── Today metric tiles ────────────────────────────────────────────────────
    metricRow: {
        flexDirection: 'row',
        gap: 8,
        marginBottom: 16,
    },
    metricTile: {
        flex: 1,
        alignItems: 'center',
        paddingVertical: 10,
        borderRadius: RADIUS.md,
    },
    metricTileCount: {
        fontSize: 22,
        fontWeight: '800',
        letterSpacing: -0.5,
    },
    metricTileLabel: {
        fontSize: 10,
        fontWeight: '700',
        letterSpacing: 0.3,
        marginTop: 2,
        textTransform: 'uppercase',
    },

    // ── Loading / empty states ────────────────────────────────────────────────
    loadingState: { alignItems: 'center', paddingVertical: 24, gap: 12 },
    loadingText:  { fontSize: 14, color: T.textMuted, fontWeight: '600' },
    emptyState:   { alignItems: 'center', paddingVertical: 20, gap: 8 },
    emptyIconWrap: {
        width: 52,
        height: 52,
        borderRadius: RADIUS.lg,
        backgroundColor: T.bgAlt,
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: 4,
    },
    emptyTitle: {
        fontSize: 16,
        fontWeight: '700',
        color: T.textPrimary,
        letterSpacing: -0.2,
    },
    emptyText: {
        fontSize: 14,
        color: T.textMuted,
        lineHeight: 20,
        textAlign: 'center',
        paddingHorizontal: 12,
    },
    inlineEmpty: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginTop: 12,
        padding: 14,
        backgroundColor: T.bgAlt,
        borderRadius: RADIUS.md,
    },
    inlineEmptyText: {
        fontSize: 14,
        color: T.textMuted,
        fontWeight: '500',
        flex: 1,
    },

    // ── Bar chart ─────────────────────────────────────────────────────────────
    chart: {
        height: 160,
        flexDirection: 'row',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        marginTop: 20,
    },
    barWrapper: { alignItems: 'center', flex: 1 },
    barTrack: {
        height: 110,
        width: 20,
        backgroundColor: T.bgAlt,
        borderRadius: RADIUS.full,
        justifyContent: 'flex-end',
        overflow: 'hidden',
    },
    bar: { width: '100%', borderRadius: RADIUS.full },
    dayLabel: { marginTop: 8, fontSize: 12, color: T.textMuted, fontWeight: '600' },
    selectedDayLabel: { color: T.primary, fontWeight: '700' },

    // ── Heatmap ───────────────────────────────────────────────────────────────
    weekLabels: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginTop: 18,
        marginBottom: 8,
    },
    weekLabel: {
        width: 38,
        textAlign: 'center',
        fontSize: 12,
        fontWeight: '700',
        color: T.textMuted,
    },
    heatmapGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    heatmapDay: {
        width: 38,
        height: 38,
        borderRadius: RADIUS.sm,
        alignItems: 'center',
        justifyContent: 'center',
    },
    heatmapOffset:  { backgroundColor: 'transparent' },
    selectedHeatmapDay: { borderWidth: 2, borderColor: T.textPrimary },
    heatmapHigh:    { backgroundColor: '#BBF7D0' },
    heatmapMedium:  { backgroundColor: '#FEF3C7' },
    heatmapLow:     { backgroundColor: '#FED7AA' },
    heatmapMissed:  { backgroundColor: '#FECACA' },
    heatmapFuture:  { backgroundColor: T.bgAlt },
    heatmapEmpty:   { backgroundColor: T.border },
    heatmapNoData:  { backgroundColor: '#CBD5E1' },
    heatmapPending: { backgroundColor: '#DBEAFE' },
    heatmapText: { fontSize: 12, fontWeight: '700', color: T.textPrimary },
    legendRow: {
        flexDirection: 'row',
        justifyContent: 'center',
        flexWrap: 'wrap',
        gap: 12,
        marginTop: 16,
    },
    legendItem:  { flexDirection: 'row', alignItems: 'center', gap: 5 },
    legendSwatch: { width: 12, height: 12, borderRadius: 3 },
    legendLabel: { fontSize: 11, color: T.textMuted, fontWeight: '600' },

    // ── Reminder row ──────────────────────────────────────────────────────────
    reminderRow: {
        paddingVertical: 14,
        borderTopWidth: 1,
        borderTopColor: T.bgAlt,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    reminderStatusBar: { width: 3, height: 36, borderRadius: RADIUS.full, flexShrink: 0 },
    reminderTextBlock: { flex: 1 },
    reminderName: {
        fontSize: 15,
        fontWeight: '700',
        color: T.textPrimary,
        letterSpacing: -0.2,
    },
    reminderTime: { fontSize: 13, color: T.textMuted, marginTop: 2 },
    statusPill: {
        paddingHorizontal: 11,
        paddingVertical: 6,
        borderRadius: RADIUS.full,
    },
    statusText:   { fontSize: 12, fontWeight: '700' },
    takenPill:    { backgroundColor: '#DCFCE7' },
    missedPill:   { backgroundColor: '#FEE2E2' },
    skippedPill:  { backgroundColor: '#FEF3C7' },
    snoozedPill:  { backgroundColor: '#DBEAFE' },
    pendingPill:  { backgroundColor: T.bgAlt },
    takenText:    { color: '#15803D' },
    missedText:   { color: '#B91C1C' },
    skippedText:  { color: '#B45309' },
    snoozedText:  { color: '#1D4ED8' },
    pendingText:  { color: T.textMuted },

    // ── Breakdown section header ──────────────────────────────────────────────
    bdSection: { marginBottom: 10, marginTop: 4 },
    bdSectionTitle: {
        fontSize: 20,
        fontWeight: '700',
        color: T.textPrimary,
        letterSpacing: -0.3,
        marginBottom: 3,
    },
    bdSectionSub: { fontSize: 13, color: T.textMuted, fontWeight: '500' },

    // ── Breakdown cards (bc*) ─────────────────────────────────────────────────
    bcCard: {
        backgroundColor: T.bgSurface,
        borderRadius: RADIUS.xl,
        padding: 18,
        marginBottom: 10,
        borderWidth: 1,
        borderColor: T.border,
    },
    bcHeader: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        marginBottom: 12,
        gap: 12,
    },
    bcNameRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginBottom: 3,
    },
    bcName: {
        fontSize: 16,
        fontWeight: '700',
        color: T.textPrimary,
        letterSpacing: -0.3,
        flexShrink: 1,
    },
    bcDeletedPill: {
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: RADIUS.full,
        backgroundColor: T.bgAlt,
    },
    bcDeletedText: {
        fontSize: 11,
        fontWeight: '700',
        color: T.textMuted,
    },
    bcMeta: { fontSize: 13, color: T.textMuted, fontWeight: '500' },
    bcAdherenceBlock: { alignItems: 'flex-end', flexShrink: 0 },
    bcAdherencePct: { fontSize: 24, fontWeight: '800', letterSpacing: -0.8, lineHeight: 28 },
    bcAdherenceLabel: {
        fontSize: 10,
        fontWeight: '600',
        color: T.textMuted,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        marginTop: 2,
    },
    bcProgressTrack: {
        height: 5,
        backgroundColor: T.bgAlt,
        borderRadius: RADIUS.full,
        marginBottom: 6,
        overflow: 'hidden',
    },
    bcProgressFill: { height: '100%', borderRadius: RADIUS.full },
    bcCountLine: { fontSize: 12, color: T.textMuted, fontWeight: '500', marginBottom: 12 },
    bcChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 },
    bcChip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: RADIUS.full },
    bcChipText: { fontSize: 12, fontWeight: '700' },
    bcFooter: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        borderTopWidth: 1,
        borderTopColor: T.bgAlt,
        paddingTop: 10,
    },
    bcSummary: { fontSize: 13, color: T.textSecondary, fontWeight: '500', flex: 1 },
    bcCta: { flexDirection: 'row', alignItems: 'center', gap: 2 },
    bcCtaText: { fontSize: 13, color: T.primary, fontWeight: '700' },
});
