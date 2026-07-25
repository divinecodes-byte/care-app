import * as Haptics from 'expo-haptics';
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
import { clearAccountScopedLocalState } from '@/lib/accountCleanup';
import { AUTH_ERROR_TRANSLATION_KEYS, classifyAuthError } from '@/lib/authErrors';
import { useAuthSession } from '@/lib/authSession';
import { useTranslation } from '@/lib/i18n/context';
import { isUseCase, recipientHasAcceptedConnection, resolveProfileRoute } from '@/lib/onboarding';
import { useThemeColors } from '@/lib/theme';
import { supabase } from '@/lib/supabase';
import { syncCurrentUserTimezone } from '@/lib/timezone';
import { showAlertOnce } from '@/lib/alertGuard';

export default function SigninScreen() {
    const C = useThemeColors();
    const t = useTranslation();
    const styles = useMemo(() => createStyles(C), [C]);
    const { deauthReason, clearDeauthReason } = useAuthSession();
    const [email, setEmail]       = useState('');
    const [password, setPassword] = useState('');
    const [loading, setLoading]   = useState(false);
    const [focused, setFocused]   = useState<string | null>(null);
    const passwordRef = useRef<TextInput>(null);

    // A one-time neutral banner for a session that ended because the
    // account was tombstoned or the session was no longer valid — read
    // once, then cleared, so it never reappears on a later, unrelated
    // visit to this screen.
    const banner = deauthReason === 'account_deleted'
        ? t('authErrors.accountDeleted')
        : deauthReason === 'expired_session'
        ? t('authErrors.expiredSession')
        : null;

    useEffect(() => {
        return () => clearDeauthReason();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    async function handleSignin() {
        if (!email || !password) {
            showAlertOnce(t('signin.missingInfoTitle'), t('signin.missingInfoMessage'));
            return;
        }

        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        setLoading(true);
        clearDeauthReason();

        const { data, error } = await supabase.auth.signInWithPassword({
            email: email.trim(),
            password,
        });

        if (error) {
            setLoading(false);
            console.warn('[signin] signInWithPassword failed:', error.message);
            const kind = classifyAuthError(error);
            showAlertOnce(t('signin.failedTitle'), t(AUTH_ERROR_TRANSLATION_KEYS[kind]));
            return;
        }

        const userId = data.user?.id;

        if (!userId) {
            setLoading(false);
            showAlertOnce(t('signin.issueTitle'), t('signin.issueMessage'));
            return;
        }

        // maybeSingle(), not single() — a signed-in user with no profiles
        // row yet (e.g. a legacy pre-trigger account, see the auth-
        // hardening migration) must land on the recovery path below, not
        // hit a raw "no rows" error and get stuck on this screen forever.
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('role, account_status, use_case')
            .eq('id', userId)
            .maybeSingle();

        setLoading(false);

        if (profileError) {
            console.warn('[signin] profile fetch failed:', profileError.message);
            const kind = classifyAuthError(profileError);
            showAlertOnce(t('signin.profileErrorTitle'), t(AUTH_ERROR_TRANSLATION_KEYS[kind]));
            return;
        }

        if (profile?.account_status === 'deleted') {
            // A tombstoned account can still hold a technically-valid
            // session for a moment (e.g. Auth deletion partially failed
            // upstream) — never let it proceed past this point. The
            // central auth controller will also independently catch and
            // sign this out; this is the immediate, synchronous check on
            // the explicit sign-in action itself.
            await clearAccountScopedLocalState().catch(() => {});
            await supabase.auth.signOut().catch(() => {});
            showAlertOnce(t('signin.failedTitle'), t('authErrors.accountDeleted'));
            return;
        }

        const role = profile?.role === 'caregiver' || profile?.role === 'recipient' ? profile.role : null;
        const useCase = isUseCase(profile?.use_case) ? profile.use_case : null;
        const hasConnection = role === 'recipient' ? await recipientHasAcceptedConnection(userId) : false;
        const route = resolveProfileRoute({ role, useCase }, hasConnection);

        if (route === '/recipient-dashboard') {
            // Fire-and-forget — the recipient's own device is the only
            // source of truth for their timezone, reconciled here right
            // after login rather than waiting for the dashboard to mount.
            syncCurrentUserTimezone().catch(() => {});
        }
        router.replace(route);
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
                    <Text style={styles.heading}>{t('signin.heading')}</Text>
                    <Text style={styles.subheading}>
                        {t('signin.subheading')}
                    </Text>

                    {banner ? (
                        <View style={styles.banner}>
                            <Text style={styles.bannerText}>{banner}</Text>
                        </View>
                    ) : null}

                    {/* Form */}
                    <View style={styles.form}>
                        <View style={styles.formGroup}>
                            <Text style={styles.label}>{t('signin.emailLabel')}</Text>
                            <TextInput
                                style={inputStyle('email')}
                                placeholder={t('signin.emailPlaceholder')}
                                placeholderTextColor={C.textMuted}
                                keyboardType="email-address"
                                autoCapitalize="none"
                                autoCorrect={false}
                                textContentType="username"
                                autoComplete="email"
                                value={email}
                                onChangeText={setEmail}
                                onFocus={() => setFocused('email')}
                                onBlur={() => setFocused(null)}
                                returnKeyType="next"
                                onSubmitEditing={() => passwordRef.current?.focus()}
                                accessibilityLabel={t('signin.emailLabel')}
                            />
                        </View>

                        <View style={styles.formGroup}>
                            <Text style={styles.label}>{t('signin.passwordLabel')}</Text>
                            <TextInput
                                ref={passwordRef}
                                style={inputStyle('password')}
                                placeholder={t('signin.passwordPlaceholder')}
                                placeholderTextColor={C.textMuted}
                                secureTextEntry
                                autoCapitalize="none"
                                autoCorrect={false}
                                textContentType="password"
                                autoComplete="current-password"
                                value={password}
                                onChangeText={setPassword}
                                onFocus={() => setFocused('password')}
                                onBlur={() => setFocused(null)}
                                returnKeyType="done"
                                onSubmitEditing={handleSignin}
                                accessibilityLabel={t('signin.passwordLabel')}
                            />
                        </View>

                        <TouchableOpacity
                            style={styles.forgotPasswordLink}
                            onPress={() => router.push('/forgot-password')}
                            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                            accessibilityRole="button"
                            accessibilityLabel={t('signin.forgotPassword')}
                        >
                            <Text style={styles.forgotPasswordText}>{t('signin.forgotPassword')}</Text>
                        </TouchableOpacity>
                    </View>

                    {/* Spacer */}
                    <View style={styles.spacer} />

                    {/* CTA */}
                    <TouchableOpacity
                        style={[styles.button, SHADOW.primary, loading && styles.buttonDisabled]}
                        onPress={handleSignin}
                        disabled={loading}
                        activeOpacity={0.88}
                        accessibilityRole="button"
                        accessibilityLabel={t('signin.submit')}
                        accessibilityState={{ disabled: loading, busy: loading }}
                    >
                        {loading ? (
                            <ActivityIndicator color={C.textInverse} />
                        ) : (
                            <Text style={styles.buttonText}>{t('signin.submit')}</Text>
                        )}
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={styles.footerLink}
                        onPress={() => router.push('/signup')}
                        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                        accessibilityRole="button"
                        accessibilityLabel={`${t('signin.noAccount')} ${t('signin.noAccountAction')}`}
                    >
                        <Text style={styles.footerText}>
                            {t('signin.noAccount')}{' '}
                            <Text style={styles.footerTextBold}>{t('signin.noAccountAction')}</Text>
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
    forgotPasswordLink: {
        alignSelf: 'flex-end',
        paddingVertical: 4,
    },
    forgotPasswordText: {
        fontSize: 14,
        fontWeight: '600',
        color: C.primary,
    },
    banner: {
        backgroundColor: C.bgAlt,
        borderRadius: RADIUS.lg,
        paddingHorizontal: 14,
        paddingVertical: 12,
        marginBottom: 20,
        borderWidth: 1,
        borderColor: C.border,
    },
    bannerText: {
        fontSize: 14,
        color: C.textSecondary,
        lineHeight: 20,
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
        minHeight: 32,
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
