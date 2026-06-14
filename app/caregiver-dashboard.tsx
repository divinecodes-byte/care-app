import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
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

import { RADIUS, SHADOW, T } from '@/constants/theme';
import { supabase } from '@/lib/supabase';

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
    adherence: number;
    scheduledCount: number;
    takenCount: number;
    reminders: ReminderDisplay[];
};

type ReminderBreakdownItem = {
    id: string;
    name: string;
    completed: number;
    scheduled: number;
    missed: number;
    skipped: number;
    snoozed: number;
    adherence: number;
};

type ConnectionSummary = {
    id: string;
    status: 'none' | 'pending' | 'accepted';
    inviteCode?: string;
    recipientName?: string;
};

// ─── Pure date helpers (unchanged) ───────────────────────────────────────────

function getLocalDateString(date: Date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getStartOfWeek(date: Date) {
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - start.getDay());
    return start;
}

function addDays(date: Date, amount: number) {
    const next = new Date(date);
    next.setDate(next.getDate() + amount);
    return next;
}

function getMonthDates(date: Date) {
    const year = date.getFullYear();
    const month = date.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    return Array.from({ length: daysInMonth }, (_, index) => new Date(year, month, index + 1));
}

function formatDateLabel(date: Date) {
    return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
}

function formatShortDay(date: Date) {
    return date.toLocaleDateString(undefined, { weekday: 'short' });
}

function formatTime(time: string) {
    const [hourString, minuteString] = time.split(':');
    let hour = Number(hourString);
    const minute = minuteString;
    const suffix = hour >= 12 ? 'PM' : 'AM';
    if (hour === 0) hour = 12;
    if (hour > 12) hour -= 12;
    return `${hour}:${minute} ${suffix}`;
}

function formatStatus(status: ReminderStatus) {
    if (status === 'taken') return 'Taken';
    if (status === 'snoozed') return 'Snoozed';
    if (status === 'skipped') return 'Skipped';
    if (status === 'missed') return 'Missed';
    return 'Pending';
}

function shouldShowOnDate(frequency: Reminder['frequency'], date: Date) {
    const day = date.getDay();
    const isWeekend = day === 0 || day === 6;
    if (frequency === 'daily') return true;
    if (frequency === 'weekdays') return !isWeekend;
    if (frequency === 'weekends') return isWeekend;
    return true;
}

function buildScheduledDateTime(dateString: string, time: string) {
    const [yearString, monthString, dayString] = dateString.split('-');
    const [hourString, minuteString] = time.split(':');
    return new Date(
        Number(yearString),
        Number(monthString) - 1,
        Number(dayString),
        Number(hourString),
        Number(minuteString),
        0,
        0
    );
}

function getComputedStatus(reminder: Reminder, dateString: string, log?: ReminderLog): ReminderStatus {
    if (log?.status) return log.status;
    const scheduledFor = buildScheduledDateTime(dateString, reminder.time_of_day);
    const missedAt = new Date(scheduledFor.getTime() + reminder.no_response_minutes * 60 * 1000);
    if (new Date() > missedAt) return 'missed';
    return 'pending';
}

function buildDayData(date: Date, reminders: Reminder[], logs: ReminderLog[]): DayData {
    const dateString = getLocalDateString(date);
    const scheduledReminders = reminders.filter((r) => shouldShowOnDate(r.frequency, date));
    const reminderDisplays = scheduledReminders.map((reminder) => {
        const matchingLog = logs.find(
            (log) => log.reminder_id === reminder.id && log.occurrence_date === dateString
        );
        return {
            id: reminder.id,
            name: reminder.title,
            time: formatTime(reminder.time_of_day),
            status: getComputedStatus(reminder, dateString, matchingLog),
        };
    });
    const scheduledCount = reminderDisplays.length;
    const takenCount = reminderDisplays.filter((r) => r.status === 'taken').length;
    const adherence = scheduledCount === 0 ? 0 : Math.round((takenCount / scheduledCount) * 100);
    return {
        dateString,
        dateLabel: formatDateLabel(date),
        shortLabel: formatShortDay(date),
        monthDay: date.getDate(),
        adherence,
        scheduledCount,
        takenCount,
        reminders: reminderDisplays,
    };
}

function getRangeAdherence(days: DayData[]) {
    const todayString = getLocalDateString(new Date());
    const pastAndToday = days.filter((day) => day.dateString <= todayString);
    const scheduled = pastAndToday.reduce((total, day) => total + day.scheduledCount, 0);
    const taken = pastAndToday.reduce((total, day) => total + day.takenCount, 0);
    if (scheduled === 0) return 0;
    return Math.round((taken / scheduled) * 100);
}

function buildReminderBreakdown(
    reminders: Reminder[],
    logs: ReminderLog[],
    monthDates: Date[]
): ReminderBreakdownItem[] {
    return reminders.map((reminder) => {
        let scheduled = 0, completed = 0, missed = 0, skipped = 0, snoozed = 0;
        monthDates.forEach((date) => {
            const dateString = getLocalDateString(date);
            const todayString = getLocalDateString(new Date());
            if (dateString > todayString) return;
            if (!shouldShowOnDate(reminder.frequency, date)) return;
            scheduled += 1;
            const matchingLog = logs.find(
                (log) => log.reminder_id === reminder.id && log.occurrence_date === dateString
            );
            const status = getComputedStatus(reminder, dateString, matchingLog);
            if (status === 'taken') completed += 1;
            if (status === 'missed') missed += 1;
            if (status === 'skipped') skipped += 1;
            if (status === 'snoozed') snoozed += 1;
        });
        return {
            id: reminder.id,
            name: reminder.title,
            completed,
            scheduled,
            missed,
            skipped,
            snoozed,
            adherence: scheduled === 0 ? 0 : Math.round((completed / scheduled) * 100),
        };
    });
}

// ─── UI helpers ──────────────────────────────────────────────────────────────

function getAdherenceColor(pct: number) {
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
    if (day.scheduledCount === 0) return styles.heatmapEmpty;
    if (day.adherence === 100) return styles.heatmapHigh;
    if (day.adherence >= 75)  return styles.heatmapMedium;
    if (day.adherence >= 50)  return styles.heatmapLow;
    return styles.heatmapMissed;
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function CaregiverDashboard() {
    const [selectedRange, setSelectedRange] = useState<'Today' | 'Week' | 'Month'>('Today');
    const [selectedWeekIndex, setSelectedWeekIndex]   = useState(new Date().getDay());
    const [selectedMonthIndex, setSelectedMonthIndex] = useState(new Date().getDate() - 1);

    const [connectionLoading, setConnectionLoading] = useState(true);
    const [dashboardLoading, setDashboardLoading]   = useState(true);

    const [connectionSummary, setConnectionSummary] = useState<ConnectionSummary>({ id: '', status: 'none' });
    const [todayData, setTodayData]           = useState<DayData | null>(null);
    const [weeklyData, setWeeklyData]         = useState<DayData[]>([]);
    const [monthData, setMonthData]           = useState<DayData[]>([]);
    const [reminderBreakdown, setReminderBreakdown] = useState<ReminderBreakdownItem[]>([]);

    const selectedDay =
        selectedRange === 'Today' ? todayData
        : selectedRange === 'Week' ? weeklyData[selectedWeekIndex]
        : monthData[selectedMonthIndex];

    const rangeAdherence =
        selectedRange === 'Today' ? (todayData?.adherence || 0)
        : selectedRange === 'Week' ? getRangeAdherence(weeklyData)
        : getRangeAdherence(monthData);

    async function loadDashboardData() {
        setConnectionLoading(true);
        setDashboardLoading(true);

        const { data: { user }, error: userError } = await supabase.auth.getUser();

        if (userError || !user) {
            setConnectionSummary({ id: '', status: 'none' });
            setConnectionLoading(false);
            setDashboardLoading(false);
            return;
        }

        const { data: connections, error: connectionError } = await supabase
            .from('connections')
            .select('id, invite_code, status, recipient_id, created_at')
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

        setConnectionSummary({
            id: acceptedConnection.id,
            status: 'accepted',
            inviteCode: acceptedConnection.invite_code,
            recipientName: recipientProfile?.full_name || 'Loved one',
        });

        setConnectionLoading(false);

        const { data: remindersData, error: remindersError } = await supabase
            .from('reminders')
            .select('id, connection_id, caregiver_id, recipient_id, title, reminder_type, notes, time_of_day, frequency, no_response_minutes')
            .eq('caregiver_id', user.id)
            .eq('connection_id', acceptedConnection.id)
            .eq('is_active', true)
            .order('time_of_day', { ascending: true });

        if (remindersError) {
            console.log(remindersError.message);
            setDashboardLoading(false);
            return;
        }

        const reminders = (remindersData || []) as Reminder[];
        const today     = new Date();
        const weekStart = getStartOfWeek(today);
        const weekDates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
        const monthDates = getMonthDates(today);

        const earliestDate = weekDates[0] < monthDates[0] ? weekDates[0] : monthDates[0];
        const latestDate   = weekDates[6] > monthDates[monthDates.length - 1] ? weekDates[6] : monthDates[monthDates.length - 1];

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

        const todayDayData  = buildDayData(today, reminders, logs);
        const weekDayData   = weekDates.map((d) => buildDayData(d, reminders, logs));
        const monthDayData  = monthDates.map((d) => buildDayData(d, reminders, logs));

        setSelectedWeekIndex(today.getDay());
        setSelectedMonthIndex(today.getDate() - 1);
        setTodayData(todayDayData);
        setWeeklyData(weekDayData);
        setMonthData(monthDayData);
        setReminderBreakdown(buildReminderBreakdown(reminders, logs, monthDates));
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

    // ── Connection status card ──────────────────────────────────────────────

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
                        <Text style={styles.connectionTitle}>
                            {connectionSummary.recipientName}
                        </Text>
                        <Text style={styles.connectionText}>
                            Connected · reminders are active.
                        </Text>
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

        if (!todayData) {
            return (
                <View style={[styles.card, SHADOW.xs]}>
                    <View style={styles.emptyState}>
                        <View style={styles.emptyIconWrap}>
                            <Ionicons name="add-circle-outline" size={28} color={T.textMuted} />
                        </View>
                        <Text style={styles.emptyTitle}>No reminders yet</Text>
                        <Text style={styles.emptyText}>
                            Tap the + button above to create the first reminder.
                        </Text>
                    </View>
                </View>
            );
        }

        const adherenceColor = getAdherenceColor(rangeAdherence);

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
                    <Text style={[styles.bigMetric, { color: adherenceColor }]}>
                        {rangeAdherence}%
                    </Text>
                    <View style={styles.adherenceBarTrack}>
                        <View
                            style={[
                                styles.adherenceBarFill,
                                { width: `${rangeAdherence}%`, backgroundColor: adherenceColor },
                            ]}
                        />
                    </View>
                    <Text style={styles.helperText}>
                        Calculated from real reminder logs and scheduled reminders.
                    </Text>
                </View>

                {/* Today's reminders */}
                {selectedRange === 'Today' && (
                    <View style={[styles.card, SHADOW.xs]}>
                        <Text style={styles.cardTitle}>Today's Reminders</Text>
                        <Text style={styles.helperText}>Every task scheduled for today.</Text>

                        {todayData.reminders.length === 0 ? (
                            <View style={styles.inlineEmpty}>
                                <Ionicons name="calendar-outline" size={20} color={T.textMuted} />
                                <Text style={styles.inlineEmptyText}>No reminders scheduled today.</Text>
                            </View>
                        ) : (
                            todayData.reminders.map((reminder) => (
                                <ReminderRow key={reminder.id} reminder={reminder} />
                            ))
                        )}
                    </View>
                )}

                {/* Weekly bar chart */}
                {selectedRange === 'Week' && (
                    <View style={[styles.card, SHADOW.xs]}>
                        <Text style={styles.cardTitle}>Weekly Activity</Text>
                        <Text style={styles.helperText}>Tap a day to see exact reminders.</Text>

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
                                                { height: `${day.scheduledCount === 0 ? 4 : Math.max(day.adherence, 6)}%` },
                                                selectedWeekIndex === index && styles.selectedBar,
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

                {/* Monthly heatmap */}
                {selectedRange === 'Month' && (
                    <View style={[styles.card, SHADOW.xs]}>
                        <Text style={styles.cardTitle}>Monthly Heatmap</Text>
                        <Text style={styles.helperText}>
                            Tap any day to see reminder details.
                        </Text>

                        <View style={styles.weekLabels}>
                            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((label, index) => (
                                <Text key={`${label}-${index}`} style={styles.weekLabel}>
                                    {label}
                                </Text>
                            ))}
                        </View>

                        <View style={styles.heatmapGrid}>
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

                        {/* Heatmap legend */}
                        <View style={styles.legendRow}>
                            {[
                                { style: styles.heatmapHigh,   label: '100%' },
                                { style: styles.heatmapMedium, label: '75%+' },
                                { style: styles.heatmapLow,    label: '50%+' },
                                { style: styles.heatmapMissed, label: '<50%' },
                            ].map(({ style, label }) => (
                                <View key={label} style={styles.legendItem}>
                                    <View style={[styles.legendSwatch, style]} />
                                    <Text style={styles.legendLabel}>{label}</Text>
                                </View>
                            ))}
                        </View>
                    </View>
                )}

                {/* Selected day detail */}
                {selectedRange !== 'Today' && selectedDay && (
                    <View style={[styles.card, SHADOW.xs]}>
                        <Text style={styles.cardTitle}>{selectedDay.dateLabel}</Text>
                        <Text style={styles.helperText}>
                            {selectedDay.scheduledCount === 0
                                ? 'No reminders scheduled.'
                                : `${selectedDay.takenCount}/${selectedDay.scheduledCount} taken · ${selectedDay.adherence}% adherence`}
                        </Text>

                        {selectedDay.reminders.length === 0 ? (
                            <View style={styles.inlineEmpty}>
                                <Ionicons name="calendar-outline" size={20} color={T.textMuted} />
                                <Text style={styles.inlineEmptyText}>Nothing scheduled.</Text>
                            </View>
                        ) : (
                            selectedDay.reminders.map((reminder) => (
                                <ReminderRow key={reminder.id} reminder={reminder} />
                            ))
                        )}
                    </View>
                )}

                {/* Reminder breakdown */}
                <View style={[styles.card, SHADOW.xs]}>
                    <Text style={styles.cardTitle}>Reminder Breakdown</Text>
                    <Text style={styles.helperText}>Month-to-date per reminder.</Text>

                    {reminderBreakdown.length === 0 ? (
                        <View style={styles.inlineEmpty}>
                            <Ionicons name="list-outline" size={20} color={T.textMuted} />
                            <Text style={styles.inlineEmptyText}>
                                No reminders created yet. Tap + to add one.
                            </Text>
                        </View>
                    ) : (
                        reminderBreakdown.map((reminder) => (
                            <TouchableOpacity
                                key={reminder.id}
                                style={styles.breakdownCard}
                                onPress={() => router.push('/reminder-details')}
                                activeOpacity={0.75}
                            >
                                <View style={styles.breakdownHeader}>
                                    <Text style={styles.breakdownName}>{reminder.name}</Text>
                                    <Text
                                        style={[
                                            styles.breakdownMetric,
                                            { color: getAdherenceColor(reminder.adherence) },
                                        ]}
                                    >
                                        {reminder.adherence}%
                                    </Text>
                                </View>

                                <View style={styles.progressBarTrack}>
                                    <View
                                        style={[
                                            styles.progressBarFill,
                                            {
                                                width: `${reminder.adherence}%`,
                                                backgroundColor: getAdherenceColor(reminder.adherence),
                                            },
                                        ]}
                                    />
                                </View>

                                <Text style={styles.breakdownText}>
                                    {reminder.completed}/{reminder.scheduled} taken this month
                                </Text>
                                <Text style={styles.breakdownSubText}>
                                    {reminder.missed} missed · {reminder.skipped} skipped · {reminder.snoozed} snoozed
                                </Text>

                                <View style={styles.viewDetailsRow}>
                                    <Text style={styles.viewDetailsText}>View details</Text>
                                    <Ionicons name="chevron-forward" size={14} color={T.primary} />
                                </View>
                            </TouchableOpacity>
                        ))
                    )}
                </View>
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
                {/* Header */}
                <View style={styles.header}>
                    <View style={styles.headerTextBlock}>
                        <Text style={styles.heading}>Care Overview</Text>
                        <Text style={styles.subheading}>Loved one care activity</Text>
                    </View>

                    <View style={styles.headerActions}>
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
        </SafeAreaView>
    );
}

// ─── Reminder row ─────────────────────────────────────────────────────────────

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

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: T.bgPage,
    },
    content: {
        padding: 20,
        paddingBottom: 48,
    },

    // ── Header ──────────────────────────────────────────────────────────────
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 20,
        gap: 12,
    },
    headerTextBlock: {
        flex: 1,
    },
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
    inviteButtonText: {
        color: T.textSecondary,
        fontSize: 14,
        fontWeight: '600',
    },
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
    connectionCardPending: {
        backgroundColor: '#FFFBEB',
        borderColor: '#FDE68A',
    },
    connectionCardAccepted: {
        backgroundColor: T.successLight,
        borderColor: '#A7F3D0',
    },
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
    connectionText: {
        fontSize: 14,
        color: T.textSecondary,
        lineHeight: 20,
    },
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
    connectionButtonOutlineText: {
        color: '#D97706',
        fontSize: 14,
        fontWeight: '700',
    },
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
    activeTab: {
        backgroundColor: T.primary,
    },
    tabText: {
        fontSize: 14,
        fontWeight: '600',
        color: T.textMuted,
        letterSpacing: -0.1,
    },
    activeTabText: {
        color: T.textInverse,
        fontWeight: '700',
    },

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
    adherenceBarFill: {
        height: '100%',
        borderRadius: RADIUS.full,
    },
    helperText: {
        fontSize: 14,
        color: T.textMuted,
        lineHeight: 20,
        letterSpacing: -0.1,
    },

    // ── Loading / empty states ────────────────────────────────────────────────
    loadingState: {
        alignItems: 'center',
        paddingVertical: 24,
        gap: 12,
    },
    loadingText: {
        fontSize: 14,
        color: T.textMuted,
        fontWeight: '600',
    },
    emptyState: {
        alignItems: 'center',
        paddingVertical: 20,
        gap: 8,
    },
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
        marginTop: 16,
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
    barWrapper: {
        alignItems: 'center',
        flex: 1,
    },
    barTrack: {
        height: 110,
        width: 20,
        backgroundColor: T.bgAlt,
        borderRadius: RADIUS.full,
        justifyContent: 'flex-end',
        overflow: 'hidden',
    },
    bar: {
        width: '100%',
        backgroundColor: T.primaryMid,
        borderRadius: RADIUS.full,
    },
    selectedBar: {
        backgroundColor: T.primary,
    },
    dayLabel: {
        marginTop: 8,
        fontSize: 12,
        color: T.textMuted,
        fontWeight: '600',
    },
    selectedDayLabel: {
        color: T.primary,
        fontWeight: '700',
    },

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
    heatmapGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6,
    },
    heatmapDay: {
        width: 38,
        height: 38,
        borderRadius: RADIUS.sm,
        alignItems: 'center',
        justifyContent: 'center',
    },
    selectedHeatmapDay: {
        borderWidth: 2,
        borderColor: T.textPrimary,
    },
    heatmapHigh:   { backgroundColor: '#BBF7D0' },
    heatmapMedium: { backgroundColor: '#FEF3C7' },
    heatmapLow:    { backgroundColor: '#FED7AA' },
    heatmapMissed: { backgroundColor: '#FECACA' },
    heatmapFuture: { backgroundColor: T.bgAlt },
    heatmapEmpty:  { backgroundColor: T.border },
    heatmapText: {
        fontSize: 12,
        fontWeight: '700',
        color: T.textPrimary,
    },
    legendRow: {
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 16,
        marginTop: 16,
    },
    legendItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
    },
    legendSwatch: {
        width: 12,
        height: 12,
        borderRadius: 3,
    },
    legendLabel: {
        fontSize: 11,
        color: T.textMuted,
        fontWeight: '600',
    },

    // ── Reminder row ──────────────────────────────────────────────────────────
    reminderRow: {
        paddingVertical: 14,
        borderTopWidth: 1,
        borderTopColor: T.bgAlt,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    reminderStatusBar: {
        width: 3,
        height: 36,
        borderRadius: RADIUS.full,
        flexShrink: 0,
    },
    reminderTextBlock: {
        flex: 1,
    },
    reminderName: {
        fontSize: 15,
        fontWeight: '700',
        color: T.textPrimary,
        letterSpacing: -0.2,
    },
    reminderTime: {
        fontSize: 13,
        color: T.textMuted,
        marginTop: 2,
    },
    statusPill: {
        paddingHorizontal: 11,
        paddingVertical: 6,
        borderRadius: RADIUS.full,
    },
    statusText: {
        fontSize: 12,
        fontWeight: '700',
    },
    takenPill:   { backgroundColor: '#DCFCE7' },
    missedPill:  { backgroundColor: '#FEE2E2' },
    skippedPill: { backgroundColor: '#FEF3C7' },
    snoozedPill: { backgroundColor: '#DBEAFE' },
    pendingPill: { backgroundColor: T.bgAlt },
    takenText:   { color: '#15803D' },
    missedText:  { color: '#B91C1C' },
    skippedText: { color: '#B45309' },
    snoozedText: { color: '#1D4ED8' },
    pendingText: { color: T.textMuted },

    // ── Breakdown cards ───────────────────────────────────────────────────────
    breakdownCard: {
        borderTopWidth: 1,
        borderTopColor: T.bgAlt,
        paddingTop: 16,
        marginTop: 14,
    },
    breakdownHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 10,
    },
    breakdownName: {
        fontSize: 15,
        fontWeight: '700',
        color: T.textPrimary,
        flex: 1,
        paddingRight: 12,
        letterSpacing: -0.2,
    },
    breakdownMetric: {
        fontSize: 20,
        fontWeight: '800',
        letterSpacing: -0.5,
    },
    progressBarTrack: {
        height: 5,
        backgroundColor: T.bgAlt,
        borderRadius: RADIUS.full,
        marginBottom: 10,
        overflow: 'hidden',
    },
    progressBarFill: {
        height: '100%',
        borderRadius: RADIUS.full,
    },
    breakdownText: {
        fontSize: 13,
        color: T.textSecondary,
        fontWeight: '500',
        marginTop: 2,
    },
    breakdownSubText: {
        fontSize: 12,
        color: T.textMuted,
        marginTop: 3,
    },
    viewDetailsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
        marginTop: 10,
    },
    viewDetailsText: {
        fontSize: 13,
        color: T.primary,
        fontWeight: '700',
    },
});
