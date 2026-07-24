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

import { RADIUS, SHADOW, ThemeColors } from '@/constants/theme';
import { AUTH_ERROR_TRANSLATION_KEYS, classifyAuthError } from '@/lib/authErrors';
import { useTranslation } from '@/lib/i18n/context';
import { logOnboardingEvent } from '@/lib/onboarding';
import { useThemeColors } from '@/lib/theme';
import { supabase } from '@/lib/supabase';

export default function SignupScreen() {
    const C = useThemeColors();
    const t = useTranslation();
    const styles = useMemo(() => createStyles(C), [C]);
    const [fullName, setFullName] = useState('');
    const [email, setEmail]       = useState('');
    const [password, setPassword] = useState('');
    const [loading, setLoading]   = useState(false);
    const [focused, setFocused]   = useState<string | null>(null);

    async function handleSignup() {
        if (!fullName || !email || !password) {
            Alert.alert(t('signup.missingInfoTitle'), t('signup.missingInfoMessage'));
            return;
        }

        if (password.length < 6) {
            Alert.alert(t('signup.passwordShortTitle'), t('signup.passwordShortMessage'));
            return;
        }

        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        setLoading(true);

        // full_name travels in the signup call itself (raw_user_meta_data)
        // rather than a separate .insert() afterward — a server-side
        // trigger (handle_new_user, see the auth-hardening migration)
        // creates the profiles row atomically with the auth.users row in
        // the same transaction, so there is no window where an account can
        // exist in Auth but have no usable profile.
        const { data, error } = await supabase.auth.signUp({
            email: email.trim(),
            password,
            options: { data: { full_name: fullName.trim() } },
        });

        setLoading(false);

        if (error) {
            console.warn('[signup] signUp failed:', error.message);
            const kind = classifyAuthError(error);
            Alert.alert(t('signup.failedTitle'), t(AUTH_ERROR_TRANSLATION_KEYS[kind]));
            return;
        }

        if (!data.user?.id) {
            Alert.alert(t('signup.issueTitle'), t('signup.issueMessage'));
            return;
        }

        logOnboardingEvent('onboarding_started');
        router.replace('/choose-use-case');
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
                    <Text style={styles.heading}>{t('signup.heading')}</Text>
                    <Text style={styles.subheading}>
                        {t('signup.subheading')}
                    </Text>

                    {/* Form */}
                    <View style={styles.form}>
                        <View style={styles.formGroup}>
                            <Text style={styles.label}>{t('signup.fullNameLabel')}</Text>
                            <TextInput
                                style={inputStyle('name')}
                                placeholder={t('signup.fullNamePlaceholder')}
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
                            <Text style={styles.label}>{t('signup.emailLabel')}</Text>
                            <TextInput
                                style={inputStyle('email')}
                                placeholder={t('signup.emailPlaceholder')}
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
                            <Text style={styles.label}>{t('signup.passwordLabel')}</Text>
                            <TextInput
                                style={inputStyle('password')}
                                placeholder={t('signup.passwordPlaceholder')}
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
                            <Text style={styles.buttonText}>{t('signup.submit')}</Text>
                        )}
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={styles.footerLink}
                        onPress={() => router.push('/signin')}
                    >
                        <Text style={styles.footerText}>
                            {t('signup.haveAccount')}{' '}
                            <Text style={styles.footerTextBold}>{t('signup.haveAccountAction')}</Text>
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
