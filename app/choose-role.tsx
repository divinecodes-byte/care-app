import { router } from 'expo-router';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function ChooseRoleScreen() {
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>How will you use Care App?</Text>

        <Text style={styles.subtitle}>
          Choose your role so we can personalize your experience.
        </Text>

        <TouchableOpacity
          style={styles.card}
          onPress={() => router.push('/caregiver-dashboard')}
        >
          <Text style={styles.cardTitle}>I am a caregiver</Text>
          <Text style={styles.cardText}>
            Create reminders and track your loved one’s completion status.
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.card}
          onPress={() => router.push('/recipient-dashboard')}
        >
          <Text style={styles.cardTitle}>I am receiving care</Text>
          <Text style={styles.cardText}>
            View today’s reminders and confirm when tasks are completed.
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8F7F4' },
  content: { flex: 1, paddingHorizontal: 24, justifyContent: 'center' },
  title: {
    fontSize: 34,
    fontWeight: '800',
    color: '#111827',
    lineHeight: 42,
    marginBottom: 14,
  },
  subtitle: {
    fontSize: 17,
    color: '#6B7280',
    lineHeight: 26,
    marginBottom: 34,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 22,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  cardTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#111827',
    marginBottom: 8,
  },
  cardText: {
    fontSize: 15,
    color: '#6B7280',
    lineHeight: 23,
  },
});