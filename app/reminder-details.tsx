import { router } from 'expo-router';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

const logs = [
  { day: 'Mon', status: 'Taken', time: '8:04 AM' },
  { day: 'Tue', status: 'Taken', time: '8:02 AM' },
  { day: 'Wed', status: 'Missed', time: 'No response' },
  { day: 'Thu', status: 'Taken', time: '8:06 AM' },
  { day: 'Fri', status: 'Taken', time: '8:11 AM' },
  { day: 'Sat', status: 'Taken', time: '8:01 AM' },
  { day: 'Sun', status: 'Missed', time: 'No response' },
];

export default function ReminderDetailsScreen() {
  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>

        <Text style={styles.heading}>Blood Pressure Medication</Text>
        <Text style={styles.subheading}>8:00 AM daily • 1 pill after breakfast</Text>

        <View style={styles.grid}>
          <View style={styles.metricCard}>
            <Text style={styles.metric}>71%</Text>
            <Text style={styles.metricLabel}>Week adherence</Text>
          </View>

          <View style={styles.metricCard}>
            <Text style={styles.metric}>5/7</Text>
            <Text style={styles.metricLabel}>Taken this week</Text>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Reminder Performance</Text>

          <Text style={styles.rowText}>Missed: 2</Text>
          <Text style={styles.rowText}>Skipped: 0</Text>
          <Text style={styles.rowText}>Average response time: 6 minutes</Text>
          <Text style={styles.rowText}>No-response alert: after 30 minutes</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>This Week’s Log</Text>

          {logs.map((log) => (
            <View key={log.day} style={styles.logRow}>
              <Text style={styles.logDay}>{log.day}</Text>

              <View>
                <Text style={styles.logStatus}>{log.status}</Text>
                <Text style={styles.logTime}>{log.time}</Text>
              </View>
            </View>
          ))}
        </View>

        <TouchableOpacity style={styles.editButton}>
          <Text style={styles.editButtonText}>Edit Reminder</Text>
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
    fontSize: 32,
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
  grid: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16,
  },
  metricCard: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 18,
  },
  metric: {
    fontSize: 34,
    fontWeight: '900',
    color: '#2563EB',
  },
  metricLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: '#6B7280',
    marginTop: 4,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 22,
    padding: 20,
    marginBottom: 16,
  },
  cardTitle: {
    fontSize: 20,
    fontWeight: '900',
    color: '#111827',
    marginBottom: 14,
  },
  rowText: {
    fontSize: 15,
    color: '#4B5563',
    marginBottom: 9,
    fontWeight: '700',
  },
  logRow: {
    flexDirection: 'row',
    gap: 16,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
  },
  logDay: {
    width: 42,
    fontSize: 16,
    fontWeight: '900',
    color: '#111827',
  },
  logStatus: {
    fontSize: 16,
    fontWeight: '900',
    color: '#111827',
  },
  logTime: {
    fontSize: 14,
    color: '#6B7280',
    marginTop: 3,
  },
  editButton: {
    backgroundColor: '#111827',
    paddingVertical: 18,
    borderRadius: 16,
    alignItems: 'center',
  },
  editButtonText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '900',
  },
});