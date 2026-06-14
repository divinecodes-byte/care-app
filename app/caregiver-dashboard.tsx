import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import {
    ActivityIndicator,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

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

  return Array.from({ length: daysInMonth }, (_, index) => {
    return new Date(year, month, index + 1);
  });
}

function formatDateLabel(date: Date) {
  return date.toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
  });
}

function formatShortDay(date: Date) {
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
  });
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

function getComputedStatus(
  reminder: Reminder,
  dateString: string,
  log?: ReminderLog
): ReminderStatus {
  if (log?.status) {
    return log.status;
  }

  const scheduledFor = buildScheduledDateTime(dateString, reminder.time_of_day);
  const missedAt = new Date(
    scheduledFor.getTime() + reminder.no_response_minutes * 60 * 1000
  );

  if (new Date() > missedAt) {
    return 'missed';
  }

  return 'pending';
}

function buildDayData(
  date: Date,
  reminders: Reminder[],
  logs: ReminderLog[]
): DayData {
  const dateString = getLocalDateString(date);

  const scheduledReminders = reminders.filter((reminder) =>
    shouldShowOnDate(reminder.frequency, date)
  );

  const reminderDisplays = scheduledReminders.map((reminder) => {
    const matchingLog = logs.find(
      (log) =>
        log.reminder_id === reminder.id &&
        log.occurrence_date === dateString
    );

    return {
      id: reminder.id,
      name: reminder.title,
      time: formatTime(reminder.time_of_day),
      status: getComputedStatus(reminder, dateString, matchingLog),
    };
  });

  const scheduledCount = reminderDisplays.length;
  const takenCount = reminderDisplays.filter(
    (reminder) => reminder.status === 'taken'
  ).length;

  const adherence =
    scheduledCount === 0 ? 0 : Math.round((takenCount / scheduledCount) * 100);

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

  const scheduled = pastAndToday.reduce(
    (total, day) => total + day.scheduledCount,
    0
  );

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
    let scheduled = 0;
    let completed = 0;
    let missed = 0;
    let skipped = 0;
    let snoozed = 0;

    monthDates.forEach((date) => {
      const dateString = getLocalDateString(date);
      const todayString = getLocalDateString(new Date());

      if (dateString > todayString) {
        return;
      }

      if (!shouldShowOnDate(reminder.frequency, date)) {
        return;
      }

      scheduled += 1;

      const matchingLog = logs.find(
        (log) =>
          log.reminder_id === reminder.id &&
          log.occurrence_date === dateString
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
      adherence:
        scheduled === 0 ? 0 : Math.round((completed / scheduled) * 100),
    };
  });
}

export default function CaregiverDashboard() {
  const [selectedRange, setSelectedRange] = useState<'Today' | 'Week' | 'Month'>(
    'Today'
  );

  const [selectedWeekIndex, setSelectedWeekIndex] = useState(new Date().getDay());
  const [selectedMonthIndex, setSelectedMonthIndex] = useState(
    new Date().getDate() - 1
  );

  const [connectionLoading, setConnectionLoading] = useState(true);
  const [dashboardLoading, setDashboardLoading] = useState(true);

  const [connectionSummary, setConnectionSummary] =
    useState<ConnectionSummary>({
      id: '',
      status: 'none',
    });

  const [todayData, setTodayData] = useState<DayData | null>(null);
  const [weeklyData, setWeeklyData] = useState<DayData[]>([]);
  const [monthData, setMonthData] = useState<DayData[]>([]);
  const [reminderBreakdown, setReminderBreakdown] = useState<
    ReminderBreakdownItem[]
  >([]);

  const selectedDay =
    selectedRange === 'Today'
      ? todayData
      : selectedRange === 'Week'
      ? weeklyData[selectedWeekIndex]
      : monthData[selectedMonthIndex];

  const rangeAdherence =
    selectedRange === 'Today'
      ? todayData?.adherence || 0
      : selectedRange === 'Week'
      ? getRangeAdherence(weeklyData)
      : getRangeAdherence(monthData);

  async function loadDashboardData() {
    setConnectionLoading(true);
    setDashboardLoading(true);

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

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
      (connection) => connection.status === 'accepted' && connection.recipient_id
    );

    if (!acceptedConnection) {
      const pendingConnection = connections?.find(
        (connection) => connection.status === 'pending'
      );

      if (pendingConnection) {
        setConnectionSummary({
          id: pendingConnection.id,
          status: 'pending',
          inviteCode: pendingConnection.invite_code,
        });
      } else {
        setConnectionSummary({
          id: '',
          status: 'none',
        });
      }

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

    if (profileError) {
      console.log(profileError.message);
    }

    setConnectionSummary({
      id: acceptedConnection.id,
      status: 'accepted',
      inviteCode: acceptedConnection.invite_code,
      recipientName: recipientProfile?.full_name || 'Loved one',
    });

    setConnectionLoading(false);

    const { data: remindersData, error: remindersError } = await supabase
      .from('reminders')
      .select(
        'id, connection_id, caregiver_id, recipient_id, title, reminder_type, notes, time_of_day, frequency, no_response_minutes'
      )
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

    const today = new Date();
    const todayString = getLocalDateString(today);

    const weekStart = getStartOfWeek(today);
    const weekDates = Array.from({ length: 7 }, (_, index) =>
      addDays(weekStart, index)
    );

    const monthDates = getMonthDates(today);

    const earliestDate = weekDates[0] < monthDates[0] ? weekDates[0] : monthDates[0];
    const latestDate =
      weekDates[6] > monthDates[monthDates.length - 1]
        ? weekDates[6]
        : monthDates[monthDates.length - 1];

    let logs: ReminderLog[] = [];

    if (reminders.length > 0) {
      const reminderIds = reminders.map((reminder) => reminder.id);

      const { data: logsData, error: logsError } = await supabase
        .from('reminder_logs')
        .select(
          'reminder_id, occurrence_date, status, completed_at, snoozed_until'
        )
        .eq('caregiver_id', user.id)
        .gte('occurrence_date', getLocalDateString(earliestDate))
        .lte('occurrence_date', getLocalDateString(latestDate))
        .in('reminder_id', reminderIds);

      if (logsError) {
        console.log(logsError.message);
      } else {
        logs = (logsData || []) as ReminderLog[];
      }
    }

    const todayDayData = buildDayData(today, reminders, logs);
    const weekDayData = weekDates.map((date) =>
      buildDayData(date, reminders, logs)
    );
    const monthDayData = monthDates.map((date) =>
      buildDayData(date, reminders, logs)
    );

    setSelectedWeekIndex(today.getDay());
    setSelectedMonthIndex(today.getDate() - 1);
    setTodayData(todayDayData);
    setWeeklyData(weekDayData);
    setMonthData(monthDayData);
    setReminderBreakdown(buildReminderBreakdown(reminders, logs, monthDates));

    setDashboardLoading(false);
  }

  useFocusEffect(
    useCallback(() => {
      loadDashboardData();
    }, [])
  );

  function handleCreateReminder() {
    if (connectionSummary.status !== 'accepted') {
      router.push('/invite-recipient');
      return;
    }

    router.push('/create-reminder');
  }

  function ConnectionCard() {
    if (connectionLoading) {
      return (
        <View style={styles.connectionCard}>
          <Text style={styles.connectionLabel}>Care Connection</Text>
          <Text style={styles.connectionTitle}>Checking connection...</Text>
          <Text style={styles.connectionText}>Loading linked loved one status.</Text>
        </View>
      );
    }

    if (connectionSummary.status === 'none') {
      return (
        <View style={styles.connectionCard}>
          <Text style={styles.connectionLabel}>Care Connection</Text>
          <Text style={styles.connectionTitle}>No loved one connected</Text>
          <Text style={styles.connectionText}>
            Invite your loved one before creating reminders.
          </Text>

          <TouchableOpacity
            style={styles.connectionButton}
            onPress={() => router.push('/invite-recipient')}
          >
            <Text style={styles.connectionButtonText}>Invite Loved One</Text>
          </TouchableOpacity>
        </View>
      );
    }

    if (connectionSummary.status === 'pending') {
      return (
        <View style={styles.connectionCardPending}>
          <Text style={styles.connectionLabel}>Care Connection</Text>
          <Text style={styles.connectionTitle}>Waiting for loved one</Text>
          <Text style={styles.connectionText}>Invite code: {connectionSummary.inviteCode}</Text>
          <Text style={styles.connectionSubtext}>
            Once they enter this code, reminders can be assigned to them.
          </Text>

          <TouchableOpacity
            style={styles.connectionButton}
            onPress={() => router.push('/invite-recipient')}
          >
            <Text style={styles.connectionButtonText}>View Invite Code</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return (
      <View style={styles.connectionCardAccepted}>
        <Text style={styles.connectionLabel}>Care Connection</Text>
        <Text style={styles.connectionTitle}>
          Connected to {connectionSummary.recipientName}
        </Text>
        <Text style={styles.connectionText}>
          Status: Active. You can now create reminders and track completion activity.
        </Text>
      </View>
    );
  }

  function getStatusPillStyle(status: ReminderStatus) {
    if (status === 'taken') return styles.takenPill;
    if (status === 'missed') return styles.missedPill;
    if (status === 'skipped') return styles.skippedPill;
    if (status === 'snoozed') return styles.snoozedPill;
    return styles.pendingPill;
  }

  function getHeatmapStyle(day: DayData) {
    const todayString = getLocalDateString(new Date());

    if (day.dateString > todayString) return styles.heatmapFuture;
    if (day.scheduledCount === 0) return styles.heatmapEmpty;
    if (day.adherence === 100) return styles.heatmapHigh;
    if (day.adherence >= 75) return styles.heatmapMedium;
    if (day.adherence >= 50) return styles.heatmapLow;
    return styles.heatmapMissed;
  }

  function renderAnalytics() {
    if (connectionSummary.status !== 'accepted') {
      return (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>No analytics yet</Text>
          <Text style={styles.helperText}>
            Connect a loved one first. After they accept your invite, reminder activity will appear here.
          </Text>
        </View>
      );
    }

    if (dashboardLoading) {
      return (
        <View style={styles.card}>
          <ActivityIndicator color="#2563EB" />
          <Text style={styles.loadingText}>Loading care activity...</Text>
        </View>
      );
    }

    if (!todayData) {
      return (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>No data yet</Text>
          <Text style={styles.helperText}>
            Create a reminder to start tracking care activity.
          </Text>
        </View>
      );
    }

    return (
      <>
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
            Calculated from real reminder logs and scheduled reminders.
          </Text>
        </View>

        {selectedRange === 'Today' && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Today’s Reminders</Text>
            <Text style={styles.helperText}>Every task scheduled for today.</Text>

            {todayData.reminders.length === 0 ? (
              <Text style={styles.emptyTextInline}>No reminders scheduled today.</Text>
            ) : (
              todayData.reminders.map((reminder) => (
                <ReminderRow
                  key={reminder.id}
                  reminder={reminder}
                  getStatusPillStyle={getStatusPillStyle}
                />
              ))
            )}
          </View>
        )}

        {selectedRange === 'Week' && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Weekly Activity</Text>
            <Text style={styles.helperText}>Tap a day to see exact reminders.</Text>

            <View style={styles.chart}>
              {weeklyData.map((day, index) => (
                <TouchableOpacity
                  key={day.dateString}
                  style={styles.barWrapper}
                  onPress={() => setSelectedWeekIndex(index)}
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
                    {day.shortLabel}
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
              Tap any day to see which reminders were taken, missed, skipped, snoozed, or pending.
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
                >
                  <Text style={styles.heatmapText}>{day.monthDay}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        {selectedRange !== 'Today' && selectedDay && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{selectedDay.dateLabel}</Text>
            <Text style={styles.helperText}>
              {selectedDay.scheduledCount === 0
                ? 'No reminders scheduled for this day.'
                : `${selectedDay.takenCount}/${selectedDay.scheduledCount} taken • ${selectedDay.adherence}% adherence`}
            </Text>

            {selectedDay.reminders.map((reminder) => (
              <ReminderRow
                key={reminder.id}
                reminder={reminder}
                getStatusPillStyle={getStatusPillStyle}
              />
            ))}
          </View>
        )}

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Reminder Breakdown</Text>

          {reminderBreakdown.length === 0 ? (
            <Text style={styles.emptyTextInline}>
              No reminders created yet. Tap + to create the first one.
            </Text>
          ) : (
            reminderBreakdown.map((reminder) => (
              <TouchableOpacity
                key={reminder.id}
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
                  {reminder.missed} missed • {reminder.skipped} skipped • {reminder.snoozed} snoozed
                </Text>

                <Text style={styles.viewDetailsText}>View details →</Text>
              </TouchableOpacity>
            ))
          )}
        </View>
      </>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <View style={styles.headerTextBlock}>
            <Text style={styles.heading}>Care Overview</Text>
            <Text style={styles.subheading}>Loved one care activity</Text>
          </View>

          <View style={styles.headerActions}>
            <TouchableOpacity
              style={styles.inviteButton}
              onPress={() => router.push('/invite-recipient')}
            >
              <Text style={styles.inviteButtonText}>Invite</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.createButton} onPress={handleCreateReminder}>
              <Text style={styles.createButtonText}>+</Text>
            </TouchableOpacity>
          </View>
        </View>

        <ConnectionCard />

        <TouchableOpacity style={styles.refreshCard} onPress={loadDashboardData}>
          <Text style={styles.refreshText}>Refresh dashboard</Text>
        </TouchableOpacity>

        {renderAnalytics()}
      </ScrollView>
    </SafeAreaView>
  );
}

function ReminderRow({
  reminder,
  getStatusPillStyle,
}: {
  reminder: ReminderDisplay;
  getStatusPillStyle: (status: ReminderStatus) => object;
}) {
  return (
    <View style={styles.reminderRow}>
      <View style={styles.reminderTextBlock}>
        <Text style={styles.reminderName}>{reminder.name}</Text>
        <Text style={styles.reminderTime}>{reminder.time}</Text>
      </View>

      <View style={[styles.statusPill, getStatusPillStyle(reminder.status)]}>
        <Text style={styles.statusText}>{formatStatus(reminder.status)}</Text>
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
    marginBottom: 18,
    gap: 14,
  },
  headerTextBlock: {
    flex: 1,
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
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  inviteButton: {
    height: 48,
    paddingHorizontal: 16,
    borderRadius: 16,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  inviteButtonText: {
    color: '#111827',
    fontSize: 14,
    fontWeight: '900',
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
  connectionCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 22,
    padding: 18,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  connectionCardPending: {
    backgroundColor: '#FFFBEB',
    borderRadius: 22,
    padding: 18,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#FDE68A',
  },
  connectionCardAccepted: {
    backgroundColor: '#ECFDF5',
    borderRadius: 22,
    padding: 18,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#A7F3D0',
  },
  connectionLabel: {
    fontSize: 13,
    fontWeight: '900',
    color: '#6B7280',
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  connectionTitle: {
    fontSize: 20,
    fontWeight: '900',
    color: '#111827',
    marginBottom: 6,
  },
  connectionText: {
    fontSize: 15,
    color: '#4B5563',
    fontWeight: '700',
    lineHeight: 22,
  },
  connectionSubtext: {
    fontSize: 13,
    color: '#6B7280',
    fontWeight: '700',
    lineHeight: 20,
    marginTop: 6,
  },
  connectionButton: {
    backgroundColor: '#2563EB',
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: 'center',
    marginTop: 14,
  },
  connectionButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '900',
  },
  refreshCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  refreshText: {
    color: '#2563EB',
    fontSize: 15,
    fontWeight: '900',
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
  loadingText: {
    marginTop: 10,
    textAlign: 'center',
    fontSize: 14,
    color: '#6B7280',
    fontWeight: '800',
  },
  emptyTextInline: {
    fontSize: 15,
    color: '#6B7280',
    fontWeight: '700',
    lineHeight: 22,
    marginTop: 10,
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
  heatmapFuture: {
    backgroundColor: '#F3F4F6',
  },
  heatmapEmpty: {
    backgroundColor: '#E5E7EB',
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
    gap: 12,
  },
  reminderTextBlock: {
    flex: 1,
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
  snoozedPill: {
    backgroundColor: '#DBEAFE',
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
    color: '#2563EB',
    fontWeight: '900',
    marginTop: 10,
  },
});