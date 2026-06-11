import { router } from 'expo-router';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function SignupScreen() {
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>Create your account</Text>
        <Text style={styles.subtitle}>We’ll add real authentication later. For now, continue to choose your role.</Text>

        <TouchableOpacity
          style={styles.button}
          onPress={() => router.push('/choose-role')}
        >
          <Text style={styles.buttonText}>Continue</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8F7F4' },
  content: { flex: 1, paddingHorizontal: 24, justifyContent: 'center' },
  title: { fontSize: 34, fontWeight: '800', color: '#111827', marginBottom: 14 },
  subtitle: { fontSize: 17, color: '#6B7280', lineHeight: 26, marginBottom: 34 },
  button: {
    backgroundColor: '#2563EB',
    paddingVertical: 18,
    borderRadius: 16,
    alignItems: 'center',
  },
  buttonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '800' },
});