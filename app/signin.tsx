import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    KeyboardAvoidingView,
    Platform,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { RADIUS, SHADOW, T } from '@/constants/theme';
import { supabase } from '@/lib/supabase';

export default function SigninScreen() {
    const [email, setEmail]       = useState('');
    const [password, setPassword] = useState('');
    const [loading, setLoading]   = useState(false);
    const [focused, setFocused]   = useState<string | null>(null);

    async function handleSignin() {
        if (!email || !password) {
            Alert.alert('Missing info', 'Please enter your email and password.');
            return;
        }

        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        setLoading(true);

        const { data, error } = await supabase.auth.signInWithPassword({
            email: email.trim(),
            password,
        });

        if (error) {
            setLoading(false);
            Alert.alert('Signin failed', error.message);
            return;
        }

        const userId = data.user?.id;

        if (!userId) {
            setLoading(false);
            Alert.alert('Signin issue', 'No user account was returned.');
            return;
        }

        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('role')
            .eq('id', userId)
            .single();

        setLoading(false);

        if (profileError) {
            Alert.alert('Profile error', profileError.message);
            return;
        }

        if (profile?.role === 'caregiver') {
            router.push('/caregiver-dashboard');
            return;
        }

        if (profile?.role === 'recipient') {
            router.push('/recipient-dashboard');
            return;
        }

        router.push('/choose-role');
    }

    const inputStyle = (field: string) => [
        styles.input,
        focused === field && styles.inputFocused,
    ];

    return (
        <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
            <KeyboardAvoidingView
                style={styles.kav}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}
            >
                <ScrollView
                    contentContainerStyle={styles.scroll}
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator={false}
                >
                    {/* Back button */}
                    <TouchableOpacity
                        style={styles.backButton}
                        onPress={() => router.back()}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                        <Ionicons name="chevron-back" size={22} color={T.primary} />
                        <Text style={styles.backText}>Back</Text>
                    </TouchableOpacity>

                    {/* Header */}
                    <Text style={styles.heading}>Welcome back</Text>
                    <Text style={styles.subheading}>
                        Sign in to view reminders, care activity, and completion updates.
                    </Text>

                    {/* Form */}
                    <View style={styles.form}>
                        <View style={styles.formGroup}>
                            <Text style={styles.label}>Email</Text>
                            <TextInput
                                style={inputStyle('email')}
                                placeholder="you@example.com"
                                placeholderTextColor={T.textMuted}
                                keyboardType="email-address"
                                autoCapitalize="none"
                                autoCorrect={false}
                                value={email}
                                onChangeText={setEmail}
                                onFocus={() => setFocused('email')}
                                onBlur={() => setFocused(null)}
                                returnKeyType="next"
                            />
                        </View>

                        <View style={styles.formGroup}>
                            <Text style={styles.label}>Password</Text>
                            <TextInput
                                style={inputStyle('password')}
                                placeholder="Enter your password"
                                placeholderTextColor={T.textMuted}
                                secureTextEntry
                                value={password}
                                onChangeText={setPassword}
                                onFocus={() => setFocused('password')}
                                onBlur={() => setFocused(null)}
                                returnKeyType="done"
                                onSubmitEditing={handleSignin}
                            />
                        </View>
                    </View>

                    {/* Spacer */}
                    <View style={styles.spacer} />

                    {/* CTA */}
                    <TouchableOpacity
                        style={[styles.button, SHADOW.primary, loading && styles.buttonDisabled]}
                        onPress={handleSignin}
                        disabled={loading}
                        activeOpacity={0.88}
                    >
                        {loading ? (
                            <ActivityIndicator color={T.textInverse} />
                        ) : (
                            <Text style={styles.buttonText}>Sign In</Text>
                        )}
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={styles.footerLink}
                        onPress={() => router.push('/signup')}
                    >
                        <Text style={styles.footerText}>
                            Need an account?{' '}
                            <Text style={styles.footerTextBold}>Create one</Text>
                        </Text>
                    </TouchableOpacity>
                </ScrollView>
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: T.bgPage,
    },
    kav: {
        flex: 1,
    },
    scroll: {
        flexGrow: 1,
        paddingHorizontal: 24,
        paddingTop: 12,
        paddingBottom: 32,
    },

    // ── Navigation ────────────────────────────────────────────────────
    backButton: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 32,
        alignSelf: 'flex-start',
    },
    backText: {
        fontSize: 16,
        fontWeight: '600',
        color: T.primary,
        marginLeft: 2,
    },

    // ── Header ────────────────────────────────────────────────────────
    heading: {
        fontSize: 34,
        fontWeight: '800',
        color: T.textPrimary,
        letterSpacing: -0.8,
        marginBottom: 10,
    },
    subheading: {
        fontSize: 16,
        color: T.textSecondary,
        lineHeight: 24,
        letterSpacing: -0.1,
        marginBottom: 36,
    },

    // ── Form ──────────────────────────────────────────────────────────
    form: {
        gap: 4,
    },
    formGroup: {
        marginBottom: 18,
    },
    label: {
        fontSize: 14,
        fontWeight: '700',
        color: T.textPrimary,
        marginBottom: 8,
        letterSpacing: 0.1,
    },
    input: {
        backgroundColor: T.bgSurface,
        borderRadius: RADIUS.lg,
        paddingHorizontal: 16,
        paddingVertical: Platform.OS === 'ios' ? 16 : 14,
        fontSize: 16,
        borderWidth: 1.5,
        borderColor: T.border,
        color: T.textPrimary,
        ...SHADOW.xs,
    },
    inputFocused: {
        borderColor: T.borderFocus,
        borderWidth: 1.5,
    },

    // ── Actions ───────────────────────────────────────────────────────
    spacer: {
        flex: 1,
        minHeight: 32,
    },
    button: {
        backgroundColor: T.primary,
        paddingVertical: 18,
        borderRadius: RADIUS.xl,
        alignItems: 'center',
        marginBottom: 18,
    },
    buttonDisabled: {
        opacity: 0.65,
    },
    buttonText: {
        color: T.textInverse,
        fontSize: 17,
        fontWeight: '700',
        letterSpacing: -0.2,
    },
    footerLink: {
        paddingVertical: 8,
        alignItems: 'center',
    },
    footerText: {
        fontSize: 15,
        color: T.textSecondary,
        textAlign: 'center',
    },
    footerTextBold: {
        color: T.primary,
        fontWeight: '700',
    },
});
