import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Linking from 'expo-linking';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
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
import { useThemeColors } from '@/lib/theme';
import { supabase } from '@/lib/supabase';

// This screen is reachable only two ways: the tavora://reset-password deep
// link from a password-recovery email (the intended path), or direct
// in-app navigation. The recovery tokens/code Supabase's email link
// carries always arrive as part of the raw URL (either a #fragment for the
// implicit flow or a ?code= param for PKCE) — expo-router's own route
// params don't reliably surface a URL fragment, so this screen reads the
// raw URL itself via expo-linking rather than useLocalSearchParams().
// detectSessionInUrl is false on the Supabase client (see lib/supabase.ts,
// this is a native app, not a browser), so nothing handles this
// automatically; both token shapes are parsed and exchanged for a session
// explicitly below.
type Stage = 'resolving' | 'invalid' | 'form' | 'submitting' | 'success';

function parseResetParams(url: string): { accessToken?: string; refreshToken?: string; code?: string; error?: string } {
    const result: { accessToken?: string; refreshToken?: string; code?: string; error?: string } = {};

    const hashIndex = url.indexOf('#');
    if (hashIndex !== -1) {
        const fragment = url.slice(hashIndex + 1);
        const params = new URLSearchParams(fragment);
        result.accessToken = params.get('access_token') ?? undefined;
        result.refreshToken = params.get('refresh_token') ?? undefined;
        const fragmentError = params.get('error_description') ?? params.get('error');
        if (fragmentError) result.error = fragmentError;
    }

    const queryIndex = url.indexOf('?');
    if (queryIndex !== -1) {
        const queryEnd = hashIndex !== -1 ? hashIndex : url.length;
        const query = url.slice(queryIndex + 1, queryEnd);
        const params = new URLSearchParams(query);
        const code = params.get('code');
        if (code) result.code = code;
        const queryError = params.get('error_description') ?? params.get('error');
        if (queryError) result.error = queryError;
    }

    return result;
}

export default function ResetPasswordScreen() {
    const C = useThemeColors();
    const t = useTranslation();
    const styles = useMemo(() => createStyles(C), [C]);

    const [stage, setStage] = useState<Stage>('resolving');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const resolvedRef = useRef(false);

    useEffect(() => {
        async function handleUrl(url: string | null) {
            if (resolvedRef.current) return;
            if (!url) {
                setStage('invalid');
                return;
            }

            const parsed = parseResetParams(url);
            if (parsed.error) {
                resolvedRef.current = true;
                setStage('invalid');
                return;
            }

            if (parsed.accessToken && parsed.refreshToken) {
                resolvedRef.current = true;
                const { error } = await supabase.auth.setSession({
                    access_token: parsed.accessToken,
                    refresh_token: parsed.refreshToken,
                });
                setStage(error ? 'invalid' : 'form');
                return;
            }

            if (parsed.code) {
                resolvedRef.current = true;
                const { error } = await supabase.auth.exchangeCodeForSession(parsed.code);
                setStage(error ? 'invalid' : 'form');
                return;
            }

            // No recovery params at all — this screen was opened some other
            // way, not from a real recovery link.
            setStage('invalid');
        }

        Linking.getInitialURL().then(handleUrl);
        const sub = Linking.addEventListener('url', ({ url }) => handleUrl(url));
        return () => sub.remove();
    }, []);

    const passwordsValid = password.length >= 6 && password === confirmPassword;

    async function handleSubmit() {
        if (!passwordsValid) return;

        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        setErrorMessage(null);
        setStage('submitting');

        const { error } = await supabase.auth.updateUser({ password });

        if (error) {
            console.warn('[reset-password] updateUser failed:', error.message);
            const kind = classifyAuthError(error);
            setErrorMessage(t(AUTH_ERROR_TRANSLATION_KEYS[kind]));
            setStage('form');
            return;
        }

        // Deliberately end this recovery session rather than continuing
        // into the app with it — a password-recovery session is meant for
        // exactly one action (setting a new password), not as a general
        // signed-in session. Returning the user to a normal signin screen
        // is what "successful reset returns the user to a safe login
        // state" means here.
        await supabase.auth.signOut().catch(() => {});
        setStage('success');
    }

    if (stage === 'resolving') {
        return (
            <SafeAreaView style={styles.container}>
                <View style={styles.centered}>
                    <ActivityIndicator color={C.primary} size="large" />
                </View>
            </SafeAreaView>
        );
    }

    if (stage === 'invalid') {
        return (
            <SafeAreaView style={styles.container}>
                <View style={styles.centered}>
                    <Ionicons name="alert-circle-outline" size={32} color={C.error} style={{ marginBottom: 14 }} />
                    <Text style={styles.invalidText}>{t('resetPassword.invalidLink')}</Text>
                    <TouchableOpacity style={styles.secondaryButton} onPress={() => router.replace('/forgot-password')}>
                        <Text style={styles.secondaryButtonText}>{t('resetPassword.requestNewLink')}</Text>
                    </TouchableOpacity>
                </View>
            </SafeAreaView>
        );
    }

    if (stage === 'success') {
        return (
            <SafeAreaView style={styles.container}>
                <View style={styles.centered}>
                    <Ionicons name="checkmark-circle-outline" size={36} color={C.success} style={{ marginBottom: 14 }} />
                    <Text style={styles.invalidText}>{t('resetPassword.successMessage')}</Text>
                    <TouchableOpacity style={styles.secondaryButton} onPress={() => router.replace('/signin')}>
                        <Text style={styles.secondaryButtonText}>{t('forgotPassword.backToSignin')}</Text>
                    </TouchableOpacity>
                </View>
            </SafeAreaView>
        );
    }

    return (
        <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
            <KeyboardAvoidingView style={styles.kav} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
                <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
                    <Text style={styles.heading}>{t('resetPassword.heading')}</Text>
                    <Text style={styles.subheading}>{t('resetPassword.subheading')}</Text>

                    <View style={styles.formGroup}>
                        <Text style={styles.label}>{t('resetPassword.newPasswordLabel')}</Text>
                        <TextInput
                            style={styles.input}
                            secureTextEntry
                            value={password}
                            onChangeText={setPassword}
                            placeholder={t('signup.passwordPlaceholder')}
                            placeholderTextColor={C.textMuted}
                            autoCapitalize="none"
                            autoCorrect={false}
                        />
                    </View>

                    <View style={styles.formGroup}>
                        <Text style={styles.label}>{t('resetPassword.confirmPasswordLabel')}</Text>
                        <TextInput
                            style={styles.input}
                            secureTextEntry
                            value={confirmPassword}
                            onChangeText={setConfirmPassword}
                            placeholder={t('signup.passwordPlaceholder')}
                            placeholderTextColor={C.textMuted}
                            autoCapitalize="none"
                            autoCorrect={false}
                            onSubmitEditing={handleSubmit}
                            returnKeyType="done"
                        />
                    </View>

                    {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}

                    <TouchableOpacity
                        style={[styles.button, SHADOW.primary, (!passwordsValid || stage === 'submitting') && styles.buttonDisabled]}
                        onPress={handleSubmit}
                        disabled={!passwordsValid || stage === 'submitting'}
                        activeOpacity={0.88}
                    >
                        {stage === 'submitting' ? (
                            <ActivityIndicator color={C.textInverse} />
                        ) : (
                            <Text style={styles.buttonText}>{t('resetPassword.submit')}</Text>
                        )}
                    </TouchableOpacity>
                </ScrollView>
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}

const createStyles = (C: ThemeColors) => StyleSheet.create({
    container: { flex: 1, backgroundColor: C.bgPage },
    kav: { flex: 1 },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
    scroll: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 40, paddingBottom: 32 },
    heading: { fontSize: 30, fontWeight: '800', color: C.textPrimary, letterSpacing: -0.6, marginBottom: 10 },
    subheading: { fontSize: 16, color: C.textSecondary, lineHeight: 24, marginBottom: 28 },
    formGroup: { marginBottom: 18 },
    label: { fontSize: 14, fontWeight: '700', color: C.textPrimary, marginBottom: 8 },
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
    button: { backgroundColor: C.primary, paddingVertical: 18, borderRadius: RADIUS.xl, alignItems: 'center', marginTop: 8 },
    buttonDisabled: { opacity: 0.5 },
    buttonText: { color: C.textInverse, fontSize: 17, fontWeight: '700' },
    errorText: { fontSize: 13, color: C.error, fontWeight: '600', marginBottom: 12 },
    invalidText: { fontSize: 16, color: C.textSecondary, textAlign: 'center', lineHeight: 23, marginBottom: 20 },
    secondaryButton: { paddingVertical: 12, paddingHorizontal: 20 },
    secondaryButtonText: { fontSize: 15, fontWeight: '700', color: C.primary },
});
