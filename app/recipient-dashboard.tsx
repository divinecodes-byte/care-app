import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
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
  today_status?: ReminderStatus;
};

function getTodayDateString() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
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
  const minute = minuteString;
  const suffix = hour >= 12 ? 'PM' : 'AM';

  if (hour === 0) hour = 12;
  if (hour > 12) hour -= 12;

  return `${hour}:${minute} ${suffix}`;
}

function formatType(type: string) {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function formatStatus(status?: ReminderStatus) {
  if (!status || status === 'pending') return 'Pending';
  if (status === 'taken') return 'Taken';
  if (status === 'snoozed') return 'Snoozed';
  if (status === 'skipped') return 'Skipped';
  if (status === 'missed') return 'Missed';

  return 'Pending';
}

function shouldShowToday(frequency: Reminder['frequency']) {
  const today = new Date().getDay();
  const isWeekend = today === 0 || today === 6;

  if (frequency === 'daily') return true;
  if (frequency === 'weekdays') return !isWeekend;
  if (frequency === 'weekends') return isWeekend;

  return true;
}

export default function RecipientDashboard() {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingReminderId, setSavingReminderId] = useState<string | null>(null);

  async function loadReminders() {
    setLoading(true);

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      setLoading(false);
      Alert.alert('Not signed in', 'Please sign in again.');
      return;
    }

    const { data, error } = await supabase
      .from('reminders')
      .select(
        'id, connection_id, caregiver_id, recipient_id, title, reminder_type, notes, time_of_day, frequency, no_response_minutes'
      )
      .eq('recipient_id', user.id)
      .eq('is_active', true)
      .order('time_of_day', { ascending: true });

    if (error) {
      setLoading(false);
      Alert.alert('Reminder error', error.message);
      return;
    }

    const todaysReminders = (data || []).filter((reminder) =>
      shouldShowToday(reminder.frequency)
    );

    if (todaysReminders.length === 0) {
      setReminders([]);
      setLoading(false);
      return;
    }

    const todayDate = getTodayDateString();
    const reminderIds = todaysReminders.map((reminder) => reminder.id);

    const { data: logs, error: logsError } = await supabase
      .from('reminder_logs')
      .select('reminder_id, status')
      .eq('recipient_id', user.id)
      .eq('occurrence_date', todayDate)
      .in('reminder_id', reminderIds);

    if (logsError) {
      setLoading(false);
      Alert.alert('Logs error', logsError.message);
      return;
    }

    const remindersWithStatus = todaysReminders.map((reminder) => {
      const matchingLog = logs?.find((log) => log.reminder_id === reminder.id);

      return {
        ...reminder,
        today_status: (matchingLog?.status as ReminderStatus) || 'pending',
      };
    });

    setReminders(remindersWithStatus);
    setLoading(false);
  }

  useFocusEffect(
    useCallback(() => {
      loadReminders();
    }, [])
  );

  async function saveReminderAction(reminder: Reminder, status: ReminderStatus) {
    setSavingReminderId(reminder.id);

    const todayDate = getTodayDateString();

    const logPayload = {
      reminder_id: reminder.id,
      connection_id: reminder.connection_id,
      caregiver_id: reminder.caregiver_id,
      recipient_id: reminder.recipient_id,
      occurrence_date: todayDate,
      scheduled_for: buildScheduledForIso(reminder.time_of_day),
      status,
      completed_at: status === 'taken' ? new Date().toISOString() : null,
      snoozed_until: status === 'snoozed' ? buildSnoozedUntilIso(10) : null,
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from('reminder_logs')
      .upsert(logPayload, {
        onConflict: 'reminder_id,occurrence_date',
      });

    setSavingReminderId(null);

    if (error) {
      Alert.alert('Save error', error.message);
      return;
    }

    setReminders((currentReminders) =>
      currentReminders.map((currentReminder) =>
        currentReminder.id === reminder.id
          ? { ...currentReminder, today_status: status }
          : currentReminder
      )
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <View>
            <Text style={styles.heading}>Today</Text>
            <Text style={styles.subheading}>Your care reminders</Text>
          </View>

          <TouchableOpacity
            style={styles.refreshButton}
            onPress={loadReminders}
          >
            <Text style={styles.refreshButtonText}>Refresh</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          style={styles.alertPreviewButton}
          onPress={() => router.push('/reminder-alert')}
        >
          <Text style={styles.alertPreviewText}>Open Full-Screen Alert</Text>
        </TouchableOpacity>

        {loading && (
          <View style={styles.emptyCard}>
            <ActivityIndicator color="#2563EB" />
            <Text style={styles.emptyTitle}>Loading reminders...</Text>
          </View>
        )}

        {!loading && reminders.length === 0 && (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyEmoji}>🕊️</Text>
            <Text style={styles.emptyTitle}>No reminders for today</Text>
            <Text style={styles.emptyText}>
              When your caregiver creates reminders for your account, they will appear here.
            </Text>
          </View>
        )}

        {!loading &&
          reminders.map((reminder) => {
            const isSaving = savingReminderId === reminder.id;

            return (
              <View key={reminder.id} style={styles.reminderCard}>
                <View style={styles.cardTopRow}>
                  <View style={styles.typePill}>
                    <Text style={styles.typePillText}>
                      {formatType(reminder.reminder_type)}
                    </Text>
                  </View>

                  <Text style={styles.timeText}>
                    {formatTime(reminder.time_of_day)}
                  </Text>
                </View>

                <Text style={styles.reminderTitle}>{reminder.title}</Text>

                {reminder.notes ? (
                  <Text style={styles.notes}>{reminder.notes}</Text>
                ) : (
                  <Text style={styles.notesMuted}>No notes added.</Text>
                )}

                <View style={styles.statusRow}>
                  <Text style={styles.statusLabel}>Today’s status</Text>
                  <View style={styles.statusPill}>
                    <Text style={styles.statusPillText}>
                      {formatStatus(reminder.today_status)}
                    </Text>
                  </View>
                </View>

                <Text style={styles.responseText}>
                  Caregiver alert window: {reminder.no_response_minutes} minutes
                </Text>

                {isSaving ? (
                  <View style={styles.savingBox}>
                    <ActivityIndicator color="#2563EB" />
                    <Text style={styles.savingText}>Saving response...</Text>
                  </View>
                ) : (
                  <View style={styles.buttonRow}>
                    <TouchableOpacity
                      style={styles.takenButton}
                      onPress={() => saveReminderAction(reminder, 'taken')}
                    >
                      <Text style={styles.takenButtonText}>Taken</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={styles.snoozeButton}
                      onPress={() => saveReminderAction(reminder, 'snoozed')}
                    >
                      <Text style={styles.snoozeButtonText}>Later</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={styles.skipButton}
                      onPress={() => saveReminderAction(reminder, 'skipped')}
                    >
                      <Text style={styles.skipButtonText}>Skip</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            );
          })}
      </ScrollView>
    </SafeAreaView>
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
  heading: {
    fontSize: 36,
    fontWeight: '900',
    color: '#111827',
  },
  subheading: {
    fontSize: 16,
    color: '#6B7280',
    marginTop: 4,
  },
  refreshButton: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
  },
  refreshButtonText: {
    color: '#111827',
    fontSize: 14,
    fontWeight: '900',
  },
  alertPreviewButton: {
    backgroundColor: '#111827',
    borderRadius: 18,
    paddingVertical: 16,
    alignItems: 'center',
    marginBottom: 18,
  },
  alertPreviewText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '900',
  },
  emptyCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    padding: 24,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  emptyEmoji: {
    fontSize: 42,
    marginBottom: 12,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '900',
    color: '#111827',
    marginTop: 10,
    marginBottom: 6,
    textAlign: 'center',
  },
  emptyText: {
    fontSize: 15,
    color: '#6B7280',
    lineHeight: 22,
    textAlign: 'center',
    fontWeight: '700',
  },
  reminderCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    padding: 20,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  cardTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  typePill: {
    backgroundColor: '#DBEAFE',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
  },
  typePillText: {
    color: '#1D4ED8',
    fontSize: 13,
    fontWeight: '900',
  },
  timeText: {
    fontSize: 16,
    color: '#111827',
    fontWeight: '900',
  },
  reminderTitle: {
    fontSize: 23,
    fontWeight: '900',
    color: '#111827',
    marginBottom: 8,
  },
  notes: {
    fontSize: 15,
    color: '#4B5563',
    lineHeight: 22,
    fontWeight: '700',
    marginBottom: 12,
  },
  notesMuted: {
    fontSize: 15,
    color: '#9CA3AF',
    lineHeight: 22,
    fontWeight: '700',
    marginBottom: 12,
  },
  statusRow: {
    backgroundColor: '#F9FAFB',
    borderRadius: 14,
    padding: 12,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  statusLabel: {
    fontSize: 14,
    color: '#6B7280',
    fontWeight: '900',
  },
  statusPill: {
    backgroundColor: '#E5E7EB',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  statusPillText: {
    fontSize: 13,
    color: '#111827',
    fontWeight: '900',
  },
  responseText: {
    fontSize: 13,
    color: '#6B7280',
    fontWeight: '800',
    marginBottom: 18,
  },
  savingBox: {
    backgroundColor: '#F9FAFB',
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    gap: 8,
  },
  savingText: {
    fontSize: 14,
    color: '#6B7280',
    fontWeight: '900',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
  },
  takenButton: {
    flex: 1,
    backgroundColor: '#16A34A',
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: 'center',
  },
  takenButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '900',
  },
  snoozeButton: {
    flex: 1,
    backgroundColor: '#F59E0B',
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: 'center',
  },
  snoozeButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '900',
  },
  skipButton: {
    flex: 1,
    backgroundColor: '#F3F4F6',
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: 'center',
  },
  skipButtonText: {
    color: '#374151',
    fontSize: 15,
    fontWeight: '900',
  },
});