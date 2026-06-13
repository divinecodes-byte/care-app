import { router } from 'expo-router';
import { useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    ScrollView,
    Share,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { supabase } from '@/lib/supabase';

function generateInviteCode() {
  const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';

  for (let i = 0; i < 6; i++) {
    code += characters.charAt(Math.floor(Math.random() * characters.length));
  }

  return code;
}

export default function InviteRecipientScreen() {
  const [inviteCode, setInviteCode] = useState('');
  const [loading, setLoading] = useState(false);

  async function createInviteCode() {
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

    const code = generateInviteCode();

    const { error } = await supabase.from('connections').insert({
      caregiver_id: user.id,
      invite_code: code,
      status: 'pending',
    });

    setLoading(false);

    if (error) {
      Alert.alert('Invite error', error.message);
      return;
    }

    setInviteCode(code);
  }

  async function shareInviteCode() {
    if (!inviteCode) {
      Alert.alert('No invite code', 'Generate an invite code first.');
      return;
    }

    await Share.share({
      message: `Use this invite code to connect with me on Care App: ${inviteCode}`,
    });
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>

        <Text style={styles.heading}>Invite Loved One</Text>

        <Text style={styles.subheading}>
          Generate a code and share it with your loved one so their account can connect to your caregiver dashboard.
        </Text>

        <View style={styles.codeCard}>
          <Text style={styles.codeLabel}>Invite Code</Text>

          <Text style={styles.code}>
            {inviteCode || '------'}
          </Text>

          <Text style={styles.codeHint}>
            {inviteCode
              ? 'This code is ready to share.'
              : 'No code generated yet.'}
          </Text>
        </View>

        <TouchableOpacity
          style={styles.generateButton}
          onPress={createInviteCode}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.generateButtonText}>
              Generate Invite Code
            </Text>
          )}
        </TouchableOpacity>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>How it works</Text>
          <Text style={styles.step}>1. Your loved one opens the app.</Text>
          <Text style={styles.step}>2. They choose “I am receiving care.”</Text>
          <Text style={styles.step}>3. They enter this invite code.</Text>
          <Text style={styles.step}>4. Their reminders and completion status become linked to you.</Text>
        </View>

        <TouchableOpacity
          style={styles.shareButton}
          onPress={shareInviteCode}
        >
          <Text style={styles.shareButtonText}>Share Code</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.doneButton}
          onPress={() => router.push('/caregiver-dashboard')}
        >
          <Text style={styles.doneButtonText}>Done</Text>
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
    marginBottom: 28,
  },
  codeCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    padding: 26,
    alignItems: 'center',
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  codeLabel: {
    fontSize: 14,
    fontWeight: '900',
    color: '#6B7280',
    marginBottom: 10,
    textTransform: 'uppercase',
  },
  code: {
    fontSize: 44,
    fontWeight: '900',
    color: '#2563EB',
    letterSpacing: 4,
    marginBottom: 10,
  },
  codeHint: {
    fontSize: 14,
    color: '#6B7280',
    fontWeight: '700',
    textAlign: 'center',
  },
  generateButton: {
    backgroundColor: '#2563EB',
    paddingVertical: 18,
    borderRadius: 16,
    alignItems: 'center',
    marginBottom: 16,
  },
  generateButtonText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '900',
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 22,
    padding: 20,
    marginBottom: 18,
  },
  cardTitle: {
    fontSize: 20,
    fontWeight: '900',
    color: '#111827',
    marginBottom: 14,
  },
  step: {
    fontSize: 15,
    color: '#4B5563',
    lineHeight: 23,
    marginBottom: 8,
    fontWeight: '700',
  },
  shareButton: {
    backgroundColor: '#111827',
    paddingVertical: 18,
    borderRadius: 16,
    alignItems: 'center',
    marginBottom: 12,
  },
  shareButtonText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '900',
  },
  doneButton: {
    backgroundColor: '#FFFFFF',
    paddingVertical: 18,
    borderRadius: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#D1D5DB',
  },
  doneButtonText: {
    color: '#111827',
    fontSize: 17,
    fontWeight: '900',
  },
});