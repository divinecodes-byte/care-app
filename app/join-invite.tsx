import { router } from 'expo-router';
import { useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { supabase } from '@/lib/supabase';

export default function JoinInviteScreen() {
  const [inviteCode, setInviteCode] = useState('');
  const [loading, setLoading] = useState(false);

  async function joinInvite() {
    const normalizedCode = inviteCode.trim().toUpperCase();

    if (!normalizedCode) {
      Alert.alert('Missing code', 'Please enter your invite code.');
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

    const { data, error } = await supabase
      .from('connections')
      .update({
        recipient_id: user.id,
        status: 'accepted',
        accepted_at: new Date().toISOString(),
      })
      .eq('invite_code', normalizedCode)
      .eq('status', 'pending')
      .is('recipient_id', null)
      .select()
      .maybeSingle();

    setLoading(false);

    if (error) {
      Alert.alert('Invite error', error.message);
      return;
    }

    if (!data) {
      Alert.alert('Invalid code', 'This invite code does not exist or was already used.');
      return;
    }

    router.push('/recipient-dashboard');
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>

        <Text style={styles.heading}>Join Care Circle</Text>

        <Text style={styles.subheading}>
          Enter the invite code your caregiver shared with you.
        </Text>

        <View style={styles.card}>
          <Text style={styles.label}>Invite Code</Text>

          <TextInput
            style={styles.input}
            placeholder="ABC123"
            placeholderTextColor="#9CA3AF"
            autoCapitalize="characters"
            maxLength={6}
            value={inviteCode}
            onChangeText={setInviteCode}
          />

          <Text style={styles.helperText}>
            The code should be 6 characters.
          </Text>
        </View>

        <TouchableOpacity
          style={styles.button}
          onPress={joinInvite}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.buttonText}>Connect Account</Text>
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8F7F4' },
  content: { flex: 1, padding: 24, justifyContent: 'center' },
  backText: {
    fontSize: 16,
    fontWeight: '800',
    color: '#2563EB',
    marginBottom: 28,
  },
  heading: {
    fontSize: 36,
    fontWeight: '900',
    color: '#111827',
    marginBottom: 10,
  },
  subheading: {
    fontSize: 16,
    color: '#6B7280',
    lineHeight: 24,
    marginBottom: 30,
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
    marginBottom: 8,
  },
  input: {
    backgroundColor: '#F9FAFB',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 18,
    fontSize: 24,
    fontWeight: '900',
    letterSpacing: 4,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    color: '#111827',
    textAlign: 'center',
  },
  helperText: {
    fontSize: 13,
    color: '#6B7280',
    fontWeight: '700',
    marginTop: 10,
    textAlign: 'center',
  },
  button: {
    backgroundColor: '#2563EB',
    paddingVertical: 18,
    borderRadius: 16,
    alignItems: 'center',
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '900',
  },
});