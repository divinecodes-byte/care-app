import { router } from 'expo-router';
import {
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function JoinInviteScreen() {
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>

        <Text style={styles.heading}>Join Your Caregiver</Text>

        <Text style={styles.subheading}>
          Enter the invite code your caregiver gave you to connect your account.
        </Text>

        <View style={styles.card}>
          <Text style={styles.label}>Invite Code</Text>

          <TextInput
            style={styles.input}
            placeholder="A7F9K2"
            placeholderTextColor="#9CA3AF"
            autoCapitalize="characters"
            maxLength={6}
          />

          <Text style={styles.helperText}>
            This links your reminders and completion status to your caregiver.
          </Text>
        </View>

        <TouchableOpacity
          style={styles.connectButton}
          onPress={() => router.push('/recipient-dashboard')}
        >
          <Text style={styles.connectButtonText}>Connect Account</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8F7F4',
  },
  content: {
    flex: 1,
    padding: 24,
    justifyContent: 'center',
  },
  backText: {
    fontSize: 16,
    fontWeight: '800',
    color: '#2563EB',
    marginBottom: 28,
  },
  heading: {
    fontSize: 34,
    fontWeight: '900',
    color: '#111827',
    marginBottom: 10,
  },
  subheading: {
    fontSize: 16,
    color: '#6B7280',
    lineHeight: 24,
    marginBottom: 28,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 22,
    padding: 20,
    marginBottom: 18,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  label: {
    fontSize: 15,
    fontWeight: '900',
    color: '#374151',
    marginBottom: 10,
  },
  input: {
    backgroundColor: '#F9FAFB',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 18,
    fontSize: 28,
    fontWeight: '900',
    letterSpacing: 4,
    textAlign: 'center',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    color: '#111827',
    marginBottom: 14,
  },
  helperText: {
    fontSize: 14,
    color: '#6B7280',
    lineHeight: 21,
  },
  connectButton: {
    backgroundColor: '#2563EB',
    paddingVertical: 18,
    borderRadius: 16,
    alignItems: 'center',
  },
  connectButtonText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '900',
  },
});