import { router } from 'expo-router';
import {
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function CreateReminderScreen() {
  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>

        <Text style={styles.heading}>Create Reminder</Text>

        <Text style={styles.subheading}>
          Set a task remotely and decide when you should be alerted if it is not confirmed.
        </Text>

        <View style={styles.formGroup}>
          <Text style={styles.label}>Reminder Name</Text>
          <TextInput
            style={styles.input}
            placeholder="Blood Pressure Medication"
            placeholderTextColor="#9CA3AF"
          />
        </View>

        <View style={styles.formGroup}>
          <Text style={styles.label}>Reminder Type</Text>

          <View style={styles.typeRow}>
            <TouchableOpacity style={styles.activeTypeButton}>
              <Text style={styles.activeTypeText}>Medication</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.typeButton}>
              <Text style={styles.typeText}>Appointment</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.typeRow}>
            <TouchableOpacity style={styles.typeButton}>
              <Text style={styles.typeText}>Wellness</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.typeButton}>
              <Text style={styles.typeText}>Task</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.formGroup}>
          <Text style={styles.label}>Dosage or Notes</Text>
          <TextInput
            style={styles.input}
            placeholder="1 pill after breakfast"
            placeholderTextColor="#9CA3AF"
          />
        </View>

        <View style={styles.formGroup}>
          <Text style={styles.label}>Time</Text>
          <TextInput
            style={styles.input}
            placeholder="8:00 AM"
            placeholderTextColor="#9CA3AF"
          />
        </View>

        <View style={styles.formGroup}>
          <Text style={styles.label}>Frequency</Text>
          <TextInput
            style={styles.input}
            placeholder="Daily"
            placeholderTextColor="#9CA3AF"
          />
        </View>

        <View style={styles.formGroup}>
          <Text style={styles.label}>Notify Me If No Response After</Text>
          <TextInput
            style={styles.input}
            placeholder="30 minutes"
            placeholderTextColor="#9CA3AF"
          />
        </View>

        <View style={styles.previewCard}>
          <Text style={styles.previewTitle}>Reminder Preview</Text>
          <Text style={styles.previewMain}>Blood Pressure Medication</Text>
          <Text style={styles.previewSub}>8:00 AM daily • 1 pill after breakfast</Text>
          <Text style={styles.previewAlert}>Caregiver alerted if not confirmed after 30 minutes.</Text>
        </View>

        <TouchableOpacity
          style={styles.saveButton}
          onPress={() => router.push('/caregiver-dashboard')}
        >
          <Text style={styles.saveButtonText}>Save Reminder</Text>
        </TouchableOpacity>
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
    marginBottom: 28,
  },
  formGroup: {
    marginBottom: 20,
  },
  label: {
    fontSize: 15,
    fontWeight: '900',
    color: '#374151',
    marginBottom: 9,
  },
  input: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 17,
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    color: '#111827',
  },
  typeRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 10,
  },
  typeButton: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderRadius: 15,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  activeTypeButton: {
    flex: 1,
    backgroundColor: '#2563EB',
    borderRadius: 15,
    paddingVertical: 14,
    alignItems: 'center',
  },
  typeText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#4B5563',
  },
  activeTypeText: {
    fontSize: 14,
    fontWeight: '900',
    color: '#FFFFFF',
  },
  previewCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 20,
    marginTop: 8,
    marginBottom: 18,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  previewTitle: {
    fontSize: 14,
    fontWeight: '900',
    color: '#6B7280',
    marginBottom: 10,
  },
  previewMain: {
    fontSize: 20,
    fontWeight: '900',
    color: '#111827',
    marginBottom: 6,
  },
  previewSub: {
    fontSize: 15,
    color: '#6B7280',
    marginBottom: 10,
  },
  previewAlert: {
    fontSize: 14,
    color: '#DC2626',
    lineHeight: 20,
    fontWeight: '700',
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