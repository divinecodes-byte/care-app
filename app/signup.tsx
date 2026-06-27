import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
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

import { RADIUS, SHADOW, T, ThemeColors } from '@/constants/theme';
import { useThemeColors } from '@/lib/theme';
import { supabase } from '@/lib/supabase';

export default function SignupScreen() {
    const C = useThemeColors();
    const styles = useMemo(() => createStyles(C), [C]);
    const [fullName, setFullName] = useState('');
    const [email, setEmail]       = useState('');
    const [password, setPassword] = useState('');
    const [loading, setLoading]   = useState(false);
    const [focused, setFocused]   = useState<string | null>(null);

    async function handleSignup() {
        if (!fullName || !email || !password) {
            Alert.alert('Missing info', 'Please fill out your name, email, and password.');
            return;
        }

        if (password.length < 6) {
            Alert.alert('Password too short', 'Password must be at least 6 characters.');
            return;
        }

        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        setLoading(true);

        const { data, error } = await supabase.auth.signUp({
            email: email.trim(),
            password,
        });

        if (error) {
            setLoading(false);
            Alert.alert('Signup failed', error.message);
            return;
        }

        const userId = data.user?.id;

        if (!userId) {
            setLoading(false);
            Alert.alert('Signup issue', 'Account created, but no user ID was returned.');
            return;
        }

        const { error: profileError } = await supabase.from('profiles').insert({
            id: userId,
            full_name: fullName.trim(),
        });

        setLoading(false);

        if (profileError) {
            Alert.alert('Profile error', profileError.message);
            return;
        }

        router.replace('/choose-role');
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
                    {/* Header */}
                    <Text style={styles.heading}>Create your account</Text>
                    <Text style={styles.subheading}>
                        Start sharing reminders and tracking progress together.
                    </Text>

                    {/* Form */}
                    <View style={styles.form}>
                        <View style={styles.formGroup}>
                            <Text style={styles.label}>Full Name</Text>
                            <TextInput
                                style={inputStyle('name')}
                                placeholder="Jane Smith"
                                placeholderTextColor={C.textMuted}
                                value={fullName}
                                onChangeText={setFullName}
                                onFocus={() => setFocused('name')}
                                onBlur={() => setFocused(null)}
                                returnKeyType="next"
                                autoCorrect={false}
                            />
                        </View>

                        <View style={styles.formGroup}>
                            <Text style={styles.label}>Email</Text>
                            <TextInput
                                style={inputStyle('email')}
                                placeholder="you@example.com"
                                placeholderTextColor={C.textMuted}
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
                                placeholder="At least 6 characters"
                                placeholderTextColor={C.textMuted}
                                secureTextEntry
                                value={password}
                                onChangeText={setPassword}
                                onFocus={() => setFocused('password')}
                                onBlur={() => setFocused(null)}
                                returnKeyType="done"
                                onSubmitEditing={handleSignup}
                            />
                        </View>
                    </View>

                    {/* Spacer */}
                    <View style={styles.spacer} />

                    {/* CTA */}
                    <TouchableOpacity
                        style={[styles.button, SHADOW.primary, loading && styles.buttonDisabled]}
                        onPress={handleSignup}
                        disabled={loading}
                        activeOpacity={0.88}
                    >
                        {loading ? (
                            <ActivityIndicator color={C.textInverse} />
                        ) : (
                            <Text style={styles.buttonText}>Create Account</Text>
                        )}
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={styles.footerLink}
                        onPress={() => router.push('/signin')}
                    >
                        <Text style={styles.footerText}>
                            Already have an account?{' '}
                            <Text style={styles.footerTextBold}>Sign in</Text>
                        </Text>
                    </TouchableOpacity>
                </ScrollView>
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}

const createStyles = (C: ThemeColors) => StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: C.bgPage,
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


    // ── Header ────────────────────────────────────────────────────────
    heading: {
        fontSize: 34,
        fontWeight: '800',
        color: C.textPrimary,
        letterSpacing: -0.8,
        marginBottom: 10,
    },
    subheading: {
        fontSize: 16,
        color: C.textSecondary,
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
        color: C.textPrimary,
        marginBottom: 8,
        letterSpacing: 0.1,
    },
    input: {
        backgroundColor: C.bgSurface,
        borderRadius: RADIUS.lg,
        paddingHorizontal: 16,
        paddingVertical: Platform.OS === 'ios' ? 16 : 14,
        fontSize: 16,
        borderWidth: 1.5,
        borderColor: C.border,
        color: C.textPrimary,
        ...SHADOW.xs,
    },
    inputFocused: {
        borderColor: C.borderFocus,
        borderWidth: 1.5,
    },

    // ── Actions ───────────────────────────────────────────────────────
    spacer: {
        flex: 1,
        minHeight: 24,
    },
    button: {
        backgroundColor: C.primary,
        paddingVertical: 18,
        borderRadius: RADIUS.xl,
        alignItems: 'center',
        marginBottom: 18,
    },
    buttonDisabled: {
        opacity: 0.65,
    },
    buttonText: {
        color: C.textInverse,
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
        color: C.textSecondary,
        textAlign: 'center',
    },
    footerTextBold: {
        color: C.primary,
        fontWeight: '700',
    },
});
