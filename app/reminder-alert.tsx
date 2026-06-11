import { router } from 'expo-router';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function ReminderAlertScreen() {
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <View style={styles.alertBadge}>
          <Text style={styles.alertBadgeText}>Reminder</Text>
        </View>

        <Text style={styles.time}>8:00 AM</Text>

        <Text style={styles.title}>Take Blood Pressure Medication</Text>

        <Text style={styles.notes}>1 pill after breakfast</Text>

        <View style={styles.buttonGroup}>
          <TouchableOpacity
            style={styles.takenButton}
            onPress={() => router.push('/recipient-dashboard')}
          >
            <Text style={styles.takenText}>Taken</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.laterButton}
            onPress={() => router.push('/recipient-dashboard')}
          >
            <Text style={styles.laterText}>Remind Me Later</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.skipButton}
            onPress={() => router.push('/recipient-dashboard')}
          >
            <Text style={styles.skipText}>Skip</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.footerText}>
          Your caregiver will be updated with your response.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#111827',
  },
  content: {
    flex: 1,
    paddingHorizontal: 24,
    justifyContent: 'center',
  },
  alertBadge: {
    alignSelf: 'center',
    backgroundColor: '#1F2937',
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 999,
    marginBottom: 28,
  },
  alertBadgeText: {
    color: '#D1D5DB',
    fontSize: 14,
    fontWeight: '900',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  time: {
    fontSize: 22,
    color: '#93C5FD',
    fontWeight: '900',
    textAlign: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 38,
    fontWeight: '900',
    color: '#FFFFFF',
    textAlign: 'center',
    lineHeight: 46,
    marginBottom: 16,
  },
  notes: {
    fontSize: 19,
    color: '#D1D5DB',
    textAlign: 'center',
    lineHeight: 28,
    marginBottom: 50,
  },
  buttonGroup: {
    gap: 14,
  },
  takenButton: {
    backgroundColor: '#16A34A',
    paddingVertical: 20,
    borderRadius: 18,
    alignItems: 'center',
  },
  takenText: {
    color: '#FFFFFF',
    fontSize: 19,
    fontWeight: '900',
  },
  laterButton: {
    backgroundColor: '#2563EB',
    paddingVertical: 20,
    borderRadius: 18,
    alignItems: 'center',
  },
  laterText: {
    color: '#FFFFFF',
    fontSize: 19,
    fontWeight: '900',
  },
  skipButton: {
    backgroundColor: '#374151',
    paddingVertical: 20,
    borderRadius: 18,
    alignItems: 'center',
  },
  skipText: {
    color: '#FFFFFF',
    fontSize: 19,
    fontWeight: '900',
  },
  footerText: {
    color: '#9CA3AF',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 21,
    marginTop: 28,
  },
});