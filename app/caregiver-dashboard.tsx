import { router } from 'expo-router';
import { useState } from 'react';
import {
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

type ReminderStatus = 'Taken' | 'Missed' | 'Skipped' | 'Pending';

type ReminderLog = {
    name: string;
    time: string;
    status: ReminderStatus;
};

type DayData = {
    day: string;
    date: string;
    monthDay: number;
    adherence: number;
    reminders: ReminderLog[];
};

const weeklyData: DayData[] = [
    {
        day: 'Mon',
        date: 'June 10',
        monthDay: 10,
        adherence: 100,
        reminders: [
            { name: 'Blood Pressure Medication', time: '8:00 AM', status: 'Taken' },
            { name: 'Vitamin D', time: '6:00 PM', status: 'Taken' },
        ],
    },
    {
        day: 'Tue',
        date: 'June 11',
        monthDay: 11,
        adherence: 100,
        reminders: [
            { name: 'Blood Pressure Medication', time: '8:00 AM', status: 'Taken' },
            { name: 'Vitamin D', time: '6:00 PM', status: 'Taken' },
        ],
    },
    {
        day: 'Wed',
        date: 'June 12',
        monthDay: 12,
        adherence: 50,
        reminders: [
            { name: 'Blood Pressure Medication', time: '8:00 AM', status: 'Taken' },
            { name: 'Vitamin D', time: '6:00 PM', status: 'Missed' },
        ],
    },
    {
        day: 'Thu',
        date: 'June 13',
        monthDay: 13,
        adherence: 100,
        reminders: [
            { name: 'Blood Pressure Medication', time: '8:00 AM', status: 'Taken' },
            { name: 'Vitamin D', time: '6:00 PM', status: 'Taken' },
        ],
    },
    {
        day: 'Fri',
        date: 'June 14',
        monthDay: 14,
        adherence: 75,
        reminders: [
            { name: 'Blood Pressure Medication', time: '8:00 AM', status: 'Taken' },
            { name: 'Morning Walk', time: '10:00 AM', status: 'Taken' },
            { name: 'Vitamin D', time: '6:00 PM', status: 'Skipped' },
            { name: 'Evening Medication', time: '9:00 PM', status: 'Taken' },
        ],
    },
    {
        day: 'Sat',
        date: 'June 15',
        monthDay: 15,
        adherence: 100,
        reminders: [
            { name: 'Blood Pressure Medication', time: '8:00 AM', status: 'Taken' },
            { name: 'Vitamin D', time: '6:00 PM', status: 'Taken' },
        ],
    },
    {
        day: 'Sun',
        date: 'June 16',
        monthDay: 16,
        adherence: 50,
        reminders: [
            { name: 'Blood Pressure Medication', time: '8:00 AM', status: 'Missed' },
            { name: 'Vitamin D', time: '6:00 PM', status: 'Taken' },
        ],
    },
];

const monthData: DayData[] = Array.from({ length: 30 }, (_, index) => {
    const dayNumber = index + 1;

    const adherencePattern =
        dayNumber % 9 === 0 ? 50 : dayNumber % 6 === 0 ? 67 : dayNumber % 4 === 0 ? 75 : 100;

    const vitaminStatus: ReminderStatus =
        adherencePattern === 50 ? 'Missed' : adherencePattern === 75 ? 'Skipped' : 'Taken';

    return {
        day: `${dayNumber}`,
        date: `June ${dayNumber}`,
        monthDay: dayNumber,
        adherence: adherencePattern,
        reminders: [
            {
                name: 'Blood Pressure Medication',
                time: '8:00 AM',
                status: adherencePattern === 50 ? 'Missed' : 'Taken',
            },
            {
                name: 'Vitamin D',
                time: '6:00 PM',
                status: vitaminStatus,
            },
            {
                name: 'Evening Medication',
                time: '9:00 PM',
                status: dayNumber % 7 === 0 ? 'Skipped' : 'Taken',
            },
        ],
    };
});

const todayData: DayData = {
    day: 'Today',
    date: 'June 16',
    monthDay: 16,
    adherence: 50,
    reminders: [
        { name: 'Blood Pressure Medication', time: '8:00 AM', status: 'Missed' },
        { name: 'Vitamin D', time: '6:00 PM', status: 'Taken' },
        { name: 'Evening Medication', time: '9:00 PM', status: 'Pending' },
    ],
};

const reminderBreakdown = [
    {
        name: 'Blood Pressure Medication',
        completed: 26,
        scheduled: 30,
        missed: 4,
        skipped: 0,
        adherence: 87,
    },
    {
        name: 'Vitamin D',
        completed: 22,
        scheduled: 30,
        missed: 5,
        skipped: 3,
        adherence: 73,
    },
    {
        name: 'Evening Medication',
        completed: 25,
        scheduled: 30,
        missed: 1,
        skipped: 4,
        adherence: 83,
    },
];

export default function CaregiverDashboard() {
    const [selectedRange, setSelectedRange] = useState<'Today' | 'Week' | 'Month'>('Week');
    const [selectedWeekIndex, setSelectedWeekIndex] = useState(0);
    const [selectedMonthIndex, setSelectedMonthIndex] = useState(15);

    const selectedDay =
        selectedRange === 'Today'
            ? todayData
            : selectedRange === 'Week'
                ? weeklyData[selectedWeekIndex]
                : monthData[selectedMonthIndex];

    const rangeAdherence =
        selectedRange === 'Today'
            ? todayData.adherence
            : selectedRange === 'Week'
                ? Math.round(
                    weeklyData.reduce((total, day) => total + day.adherence, 0) / weeklyData.length
                )
                : Math.round(
                    monthData.reduce((total, day) => total + day.adherence, 0) / monthData.length
                );

    const getStatusStyle = (status: ReminderStatus) => {
        if (status === 'Taken') return styles.takenPill;
        if (status === 'Missed') return styles.missedPill;
        if (status === 'Skipped') return styles.skippedPill;
        return styles.pendingPill;
    };

    const getHeatmapStyle = (adherence: number) => {
        if (adherence === 100) return styles.heatmapHigh;
        if (adherence >= 75) return styles.heatmapMedium;
        if (adherence >= 50) return styles.heatmapLow;
        return styles.heatmapMissed;
    };

    return (
        <SafeAreaView style={styles.container}>
            <ScrollView contentContainerStyle={styles.content}>
                <View style={styles.header}>
                    <View>
                        <Text style={styles.heading}>Care Overview</Text>
                        <Text style={styles.subheading}>Mom’s care activity</Text>
                    </View>

                    <View style={styles.headerActions}>
                        <TouchableOpacity
                            style={styles.inviteButton}
                            onPress={() => router.push('/invite-recipient')}
                        >
                            <Text style={styles.inviteButtonText}>Invite</Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                            style={styles.createButton}
                            onPress={() => router.push('/create-reminder')}
                        >
                            <Text style={styles.createButtonText}>+</Text>
                        </TouchableOpacity>
                    </View>
                </View>

                <View style={styles.tabContainer}>
                    {['Today', 'Week', 'Month'].map((range) => (
                        <TouchableOpacity
                            key={range}
                            style={[styles.tab, selectedRange === range && styles.activeTab]}
                            onPress={() => setSelectedRange(range as 'Today' | 'Week' | 'Month')}
                        >
                            <Text
                                style={[
                                    styles.tabText,
                                    selectedRange === range && styles.activeTabText,
                                ]}
                            >
                                {range}
                            </Text>
                        </TouchableOpacity>
                    ))}
                </View>

                <View style={styles.card}>
                    <Text style={styles.cardLabel}>{selectedRange} Adherence</Text>
                    <Text style={styles.bigMetric}>{rangeAdherence}%</Text>
                    <Text style={styles.helperText}>
                        Calculated from exact reminders scheduled and completed.
                    </Text>
                </View>

                {selectedRange === 'Today' && (
                    <View style={styles.card}>
                        <Text style={styles.cardTitle}>Today’s Reminders</Text>
                        <Text style={styles.helperText}>Every task scheduled for today.</Text>

                        {todayData.reminders.map((reminder) => (
                            <ReminderRow
                                key={`${reminder.name}-${reminder.time}`}
                                reminder={reminder}
                                getStatusStyle={getStatusStyle}
                            />
                        ))}
                    </View>
                )}

                {selectedRange === 'Week' && (
                    <View style={styles.card}>
                        <Text style={styles.cardTitle}>Weekly Activity</Text>
                        <Text style={styles.helperText}>Tap a day to see exact reminders.</Text>

                        <View style={styles.chart}>
                            {weeklyData.map((day, index) => (
                                <TouchableOpacity
                                    key={day.day}
                                    style={styles.barWrapper}
                                    onPress={() => setSelectedWeekIndex(index)}
                                >
                                    <View style={styles.barTrack}>
                                        <View
                                            style={[
                                                styles.bar,
                                                { height: `${day.adherence}%` },
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
                                        {day.day}
                                    </Text>
                                </TouchableOpacity>
                            ))}
                        </View>
                    </View>
                )}

                {selectedRange === 'Month' && (
                    <View style={styles.card}>
                        <Text style={styles.cardTitle}>Monthly Heatmap</Text>
                        <Text style={styles.helperText}>
                            Tap any day to see which reminders were taken, missed, or skipped.
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
                                    key={day.monthDay}
                                    style={[
                                        styles.heatmapDay,
                                        getHeatmapStyle(day.adherence),
                                        selectedMonthIndex === index && styles.selectedHeatmapDay,
                                    ]}
                                    onPress={() => setSelectedMonthIndex(index)}
                                >
                                    <Text style={styles.heatmapText}>{day.monthDay}</Text>
                                </TouchableOpacity>
                            ))}
                        </View>
                    </View>
                )}

                {selectedRange !== 'Today' && (
                    <View style={styles.card}>
                        <Text style={styles.cardTitle}>{selectedDay.date}</Text>
                        <Text style={styles.helperText}>
                            {selectedDay.adherence}% completed that day
                        </Text>

                        {selectedDay.reminders.map((reminder) => (
                            <ReminderRow
                                key={`${reminder.name}-${reminder.time}`}
                                reminder={reminder}
                                getStatusStyle={getStatusStyle}
                            />
                        ))}
                    </View>
                )}

                <View style={styles.card}>
                    <Text style={styles.cardTitle}>Reminder Breakdown</Text>

                    {reminderBreakdown.map((reminder) => (
                        <TouchableOpacity
                            key={reminder.name}
                            style={styles.breakdownCard}
                            onPress={() => router.push('/reminder-details')}
                        >
                            <View style={styles.breakdownHeader}>
                                <Text style={styles.breakdownName}>{reminder.name}</Text>
                                <Text style={styles.breakdownMetric}>{reminder.adherence}%</Text>
                            </View>

                            <Text style={styles.breakdownText}>
                                {reminder.completed}/{reminder.scheduled} taken this month
                            </Text>

                            <Text style={styles.breakdownText}>
                                {reminder.missed} missed • {reminder.skipped} skipped
                            </Text>

                            <Text style={styles.viewDetailsText}>View details →</Text>
                        </TouchableOpacity>
                    ))}
                </View>
            </ScrollView>
        </SafeAreaView>
    );
}

function ReminderRow({
    reminder,
    getStatusStyle,
}: {
    reminder: ReminderLog;
    getStatusStyle: (status: ReminderStatus) => object;
}) {
    return (
        <View style={styles.reminderRow}>
            <View>
                <Text style={styles.reminderName}>{reminder.name}</Text>
                <Text style={styles.reminderTime}>{reminder.time}</Text>
            </View>

            <View style={[styles.statusPill, getStatusStyle(reminder.status)]}>
                <Text style={styles.statusText}>{reminder.status}</Text>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#F8F7F4',
    },
    content: {
        padding: 24,
        paddingBottom: 40,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 24,
    },
    heading: {
        fontSize: 32,
        fontWeight: '900',
        color: '#111827',
    },
    subheading: {
        fontSize: 16,
        color: '#6B7280',
        marginTop: 4,
    },
    createButton: {
        width: 48,
        height: 48,
        borderRadius: 16,
        backgroundColor: '#2563EB',
        alignItems: 'center',
        justifyContent: 'center',
    },
    createButtonText: {
        color: '#FFFFFF',
        fontSize: 30,
        fontWeight: '700',
        marginTop: -2,
    },
    tabContainer: {
        flexDirection: 'row',
        backgroundColor: '#FFFFFF',
        borderRadius: 16,
        padding: 4,
        marginBottom: 16,
    },
    tab: {
        flex: 1,
        paddingVertical: 12,
        borderRadius: 12,
        alignItems: 'center',
    },
    activeTab: {
        backgroundColor: '#2563EB',
    },
    tabText: {
        fontSize: 14,
        fontWeight: '800',
        color: '#6B7280',
    },
    activeTabText: {
        color: '#FFFFFF',
    },
    card: {
        backgroundColor: '#FFFFFF',
        borderRadius: 22,
        padding: 20,
        marginBottom: 16,
    },
    cardLabel: {
        fontSize: 15,
        color: '#6B7280',
        fontWeight: '700',
        marginBottom: 8,
    },
    cardTitle: {
        fontSize: 20,
        fontWeight: '900',
        color: '#111827',
        marginBottom: 8,
    },
    bigMetric: {
        fontSize: 52,
        fontWeight: '900',
        color: '#2563EB',
    },
    helperText: {
        fontSize: 14,
        color: '#6B7280',
        lineHeight: 21,
    },
    chart: {
        height: 180,
        flexDirection: 'row',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        marginTop: 24,
    },
    barWrapper: {
        alignItems: 'center',
        flex: 1,
    },
    barTrack: {
        height: 130,
        width: 22,
        backgroundColor: '#E5E7EB',
        borderRadius: 999,
        justifyContent: 'flex-end',
        overflow: 'hidden',
    },
    bar: {
        width: '100%',
        backgroundColor: '#93C5FD',
        borderRadius: 999,
    },
    selectedBar: {
        backgroundColor: '#2563EB',
    },
    dayLabel: {
        marginTop: 10,
        fontSize: 13,
        color: '#6B7280',
        fontWeight: '700',
    },
    selectedDayLabel: {
        color: '#2563EB',
    },
    weekLabels: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginTop: 20,
        marginBottom: 10,
    },
    weekLabel: {
        width: 38,
        textAlign: 'center',
        fontSize: 13,
        fontWeight: '800',
        color: '#6B7280',
    },
    heatmapGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    heatmapDay: {
        width: 38,
        height: 38,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
    },
    selectedHeatmapDay: {
        borderWidth: 2,
        borderColor: '#111827',
    },
    heatmapHigh: {
        backgroundColor: '#BBF7D0',
    },
    heatmapMedium: {
        backgroundColor: '#FEF3C7',
    },
    heatmapLow: {
        backgroundColor: '#FED7AA',
    },
    heatmapMissed: {
        backgroundColor: '#FECACA',
    },
    heatmapText: {
        fontSize: 13,
        fontWeight: '900',
        color: '#111827',
    },
    reminderRow: {
        paddingVertical: 14,
        borderTopWidth: 1,
        borderTopColor: '#F3F4F6',
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    reminderName: {
        fontSize: 16,
        fontWeight: '800',
        color: '#111827',
    },
    reminderTime: {
        fontSize: 14,
        color: '#6B7280',
        marginTop: 3,
    },
    statusPill: {
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 999,
    },
    takenPill: {
        backgroundColor: '#DCFCE7',
    },
    missedPill: {
        backgroundColor: '#FEE2E2',
    },
    skippedPill: {
        backgroundColor: '#FEF3C7',
    },
    pendingPill: {
        backgroundColor: '#E5E7EB',
    },
    statusText: {
        fontSize: 13,
        fontWeight: '900',
        color: '#111827',
    },
    breakdownCard: {
        borderTopWidth: 1,
        borderTopColor: '#F3F4F6',
        paddingTop: 14,
        marginTop: 14,
    },
    breakdownHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    breakdownName: {
        fontSize: 16,
        fontWeight: '900',
        color: '#111827',
        flex: 1,
        paddingRight: 12,
    },
    breakdownMetric: {
        fontSize: 22,
        fontWeight: '900',
        color: '#2563EB',
    },
    breakdownText: {
        fontSize: 14,
        color: '#6B7280',
        marginTop: 5,
    },
    viewDetailsText: {
        fontSize: 14,
        fontWeight: '900',
        color: '#2563EB',
        marginTop: 10,
    },
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    inviteButton: {
        backgroundColor: '#FFFFFF',
        paddingHorizontal: 14,
        height: 48,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: '#D1D5DB',
    },
    inviteButtonText: {
        color: '#111827',
        fontSize: 14,
        fontWeight: '900',
    },
});