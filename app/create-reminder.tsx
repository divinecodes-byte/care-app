import { router } from 'expo-router';
import { useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { supabase } from '@/lib/supabase';

type ReminderType = 'medication' | 'hydration' | 'appointment' | 'meal' | 'exercise' | 'other';
type Frequency = 'daily' | 'weekdays' | 'weekends';

const reminderTypes: ReminderType[] = [
  'medication',
  'hydration',
  'appointment',
  'meal',
  'exercise',
  'other',
];

const frequencies: Frequency[] = ['daily', 'weekdays', 'weekends'];

function normalizeTimeInput(input: string) {
  const cleaned = input.trim().toUpperCase().replace(/\s+/g, '');
  const match = cleaned.match(/^(\d{1,2}):(\d{2})(AM|PM)?$/);

  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3];

  if (minute < 0 || minute > 59) return null;

  if (meridiem) {
    if (hour < 1 || hour > 12) return null;

    if (meridiem === 'AM' && hour === 12) hour = 0;
    if (meridiem === 'PM' && hour !== 12) hour += 12;
  } else {
    if (hour < 0 || hour > 23) return null;
  }

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
}

function formatLabel(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export default function CreateReminderScreen() {
  const [title, setTitle] = useState('');
  const [reminderType, setReminderType] = useState<ReminderType>('medication');
  const [notes, setNotes] = useState('');
  const [timeOfDay, setTimeOfDay] = useState('8:00 AM');
  const [frequency, setFrequency] = useState<Frequency>('daily');
  const [noResponseMinutes, setNoResponseMinutes] = useState('30');
  const [loading, setLoading] = useState(false);

  async function saveReminder() {
    const normalizedTime = normalizeTimeInput(timeOfDay);
    const noResponseNumber = Number(noResponseMinutes);

    if (!title.trim()) {
      Alert.alert('Missing title', 'Please enter a reminder name.');
      return;
    }

    if (!normalizedTime) {
      Alert.alert('Invalid time', 'Use a time like 8:00 AM or 14:30.');
      return;
    }

    if (!noResponseNumber || noResponseNumber < 1) {
      Alert.alert('Invalid response window', 'Enter a number of minutes greater than 0.');
      return;
    }

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

    const { data: connection, error: connectionError } = await supabase
      .from('connections')
      .select('id, recipient_id')
      .eq('caregiver_id', user.id)
      .eq('status', 'accepted')
      .not('recipient_id', 'is', null)
      .limit(1)
      .maybeSingle();

    if (connectionError) {
      setLoading(false);
      Alert.alert('Connection error', connectionError.message);
      return;
    }

    if (!connection?.recipient_id) {
      setLoading(false);
      Alert.alert(
        'No connected recipient',
        'Invite a loved one and have them accept the code before creating reminders.'
      );
      return;
    }

    const { error } = await supabase.from('reminders').insert({
      connection_id: connection.id,
      caregiver_id: user.id,
      recipient_id: connection.recipient_id,
      title: title.trim(),
      reminder_type: reminderType,
      notes: notes.trim() || null,
      time_of_day: normalizedTime,
      frequency,
      no_response_minutes: noResponseNumber,
      is_active: true,
    });

    setLoading(false);

    if (error) {
      Alert.alert('Reminder error', error.message);
      return;
    }

    Alert.alert('Reminder saved', 'This reminder is now linked to your loved one.');
    router.push('/caregiver-dashboard');
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>

        <Text style={styles.heading}>Create Reminder</Text>

        <Text style={styles.subheading}>
          Add a care task your loved one needs to complete.
        </Text>

        <View style={styles.card}>
          <Text style={styles.label}>Reminder Name</Text>
          <TextInput
            style={styles.input}
            placeholder="Blood pressure medication"
            placeholderTextColor="#9CA3AF"
            value={title}
            onChangeText={setTitle}
          />

          <Text style={styles.label}>Type</Text>
          <View style={styles.buttonGrid}>
            {reminderTypes.map((type) => (
              <TouchableOpacity
                key={type}
                style={[
                  styles.optionButton,
                  reminderType === type && styles.optionButtonActive,
                ]}
                onPress={() => setReminderType(type)}
              >
                <Text
                  style={[
                    styles.optionText,
                    reminderType === type && styles.optionTextActive,
                  ]}
                >
                  {formatLabel(type)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.label}>Time</Text>
          <TextInput
            style={styles.input}
            placeholder="8:00 AM"
            placeholderTextColor="#9CA3AF"
            value={timeOfDay}
            onChangeText={setTimeOfDay}
          />

          <Text style={styles.helperText}>
            Use 8:00 AM, 2:30 PM, or 14:30.
          </Text>

          <Text style={styles.label}>Frequency</Text>
          <View style={styles.buttonRow}>
            {frequencies.map((item) => (
              <TouchableOpacity
                key={item}
                style={[
                  styles.frequencyButton,
                  frequency === item && styles.optionButtonActive,
                ]}
                onPress={() => setFrequency(item)}
              >
                <Text
                  style={[
                    styles.optionText,
                    frequency === item && styles.optionTextActive,
                  ]}
                >
                  {formatLabel(item)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.label}>No-response alert window</Text>
          <TextInput
            style={styles.input}
            placeholder="30"
            placeholderTextColor="#9CA3AF"
            keyboardType="number-pad"
            value={noResponseMinutes}
            onChangeText={setNoResponseMinutes}
          />

          <Text style={styles.helperText}>
            If they do not respond after this many minutes, the caregiver should be notified later.
          </Text>

          <Text style={styles.label}>Notes</Text>
          <TextInput
            style={[styles.input, styles.notesInput]}
            placeholder="Take with food."
            placeholderTextColor="#9CA3AF"
            value={notes}
            onChangeText={setNotes}
            multiline
          />
        </View>

        <TouchableOpacity
          style={styles.saveButton}
          onPress={saveReminder}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.saveButtonText}>Save Reminder</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8F7F4' },
  content: { padding: 24, paddingBottom: 40 },
  backText: {
    fontSize: 16,
    fontWeight: '800',
    color: '#2563EB',
    marginBottom: 22,
  },
  heading: {
    fontSize: 34,
    fontWeight: '900',
    color: '#111827',
    marginBottom: 8,
  },
  subheading: {
    fontSize: 16,
    color: '#6B7280',
    lineHeight: 24,
    marginBottom: 24,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    padding: 20,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    marginBottom: 18,
  },
  label: {
    fontSize: 15,
    fontWeight: '900',
    color: '#374151',
    marginBottom: 8,
    marginTop: 14,
  },
  input: {
    backgroundColor: '#F9FAFB',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 16,
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    color: '#111827',
    fontWeight: '700',
  },
  notesInput: {
    minHeight: 95,
    textAlignVertical: 'top',
  },
  helperText: {
    fontSize: 13,
    color: '#6B7280',
    fontWeight: '700',
    marginTop: 8,
  },
  buttonGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
  },
  optionButton: {
    backgroundColor: '#F3F4F6',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 14,
  },
  frequencyButton: {
    flex: 1,
    backgroundColor: '#F3F4F6',
    paddingVertical: 12,
    borderRadius: 14,
    alignItems: 'center',
  },
  optionButtonActive: {
    backgroundColor: '#2563EB',
  },
  optionText: {
    color: '#374151',
    fontSize: 14,
    fontWeight: '900',
  },
  optionTextActive: {
    color: '#FFFFFF',
  },
  saveButton: {
    backgroundColor: '#2563EB',
    paddingVertical: 18,
    borderRadius: 16,
    alignItems: 'center',
  },
  saveButtonText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '900',
  },
});