import { Ionicons } from '@expo/vector-icons';
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
import { useTranslation } from '@/lib/i18n/context';
import { logOnboardingEvent } from '@/lib/onboarding';
import { useThemeColors } from '@/lib/theme';
import { supabase } from '@/lib/supabase';

export default function JoinInviteScreen() {
    const C = useThemeColors();
    const t = useTranslation();
    const styles = useMemo(() => createStyles(C), [C]);
    const [inviteCode, setInviteCode] = useState('');
    const [loading, setLoading]       = useState(false);
    const [focused, setFocused]       = useState(false);
    // Set only after a real 'accepted' result — the connected-caregiver's
    // name is looked up AFTER server validation succeeds (never guessed or
    // fetched pre-emptively from the raw code), per the task's own
    // requirement not to reveal who a code belongs to before acceptance.
    const [connectedName, setConnectedName] = useState<string | null>(null);

    async function joinInvite() {
        const normalizedCode = inviteCode.trim().toUpperCase();

        if (!normalizedCode) {
            Alert.alert(t('joinInvite.missingCodeTitle'), t('joinInvite.missingCodeMessage'));
            return;
        }

        if (normalizedCode.length < 6) {
            Alert.alert(t('joinInvite.invalidCodeTitle'), t('joinInvite.invalidCodeLength'));
            return;
        }

        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        setLoading(true);

        const { data: { user }, error: userError } = await supabase.auth.getUser();

        if (userError || !user) {
            setLoading(false);
            Alert.alert(t('joinInvite.notSignedInTitle'), t('joinInvite.notSignedInMessage'));
            return;
        }

        // Validates and accepts atomically, server-side — self-connection,
        // expiration, and a concurrent acceptance race are all enforced
        // inside the function itself, not by a raw client UPDATE. Returns a
        // status string only (no row data), so a guessed code can't be used
        // to learn anything about who owns it.
        const { data: result, error: acceptError } = await supabase
            .rpc('accept_invite_code', { p_code: normalizedCode });

        setLoading(false);

        if (acceptError) {
            // Never surface a raw Supabase error string here — every other
            // failure branch in this screen uses translated copy, and a
            // network/unexpected failure should read the same way.
            Alert.alert(t('joinInvite.errorTitle'), t('authErrors.unexpected'));
            return;
        }

        if (result === 'not_found') {
            Alert.alert(t('joinInvite.invalidCodeTitle'), t('joinInvite.invalidCodeNotFound'));
            return;
        }

        if (result === 'already_accepted') {
            Alert.alert(
                t('joinInvite.alreadyUsedTitle'),
                t('joinInvite.alreadyUsedMessage')
            );
            return;
        }

        if (result === 'expired') {
            Alert.alert(t('joinInvite.invalidCodeTitle'), t('joinInvite.expiredCodeMessage'));
            return;
        }

        if (result === 'self') {
            Alert.alert(t('joinInvite.invalidCodeTitle'), t('joinInvite.selfConnectMessage'));
            return;
        }

        logOnboardingEvent('invite_accepted');

        // Look up the connected caregiver's display name only now, after
        // server-side acceptance already succeeded — RLS ("Users can view
        // connected profiles") only grants this read once the connection
        // is genuinely accepted, so this can never leak who a code
        // belonged to before it was used.
        const { data: connectionRow } = await supabase
            .from('connections')
            .select('caregiver_id')
            .eq('recipient_id', user.id)
            .eq('status', 'accepted')
            .order('accepted_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (connectionRow?.caregiver_id) {
            const { data: caregiverProfile } = await supabase
                .from('profiles')
                .select('full_name')
                .eq('id', connectionRow.caregiver_id)
                .maybeSingle();
            setConnectedName(caregiverProfile?.full_name ?? null);
        } else {
            setConnectedName('');
        }
    }

    if (connectedName !== null) {
        return (
            <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
                <View style={styles.connectedContent}>
                    <View style={styles.connectedIconWrap}>
                        <Ionicons name="checkmark-circle" size={48} color={C.success} />
                    </View>
                    <Text style={styles.heading} accessibilityRole="header">
                        {t('joinInvite.connectedTitle')}
                    </Text>
                    <Text style={styles.subheading}>
                        {connectedName
                            ? t('joinInvite.connectedSubtitle', { name: connectedName })
                            : t('joinInvite.connectedSubtitleGeneric')}
                    </Text>

                    <View style={styles.spacer} />

                    <TouchableOpacity
                        style={[styles.button, SHADOW.primary]}
                        onPress={() => router.replace('/notification-permission')}
                        activeOpacity={0.88}
                        accessibilityRole="button"
                        accessibilityLabel={t('joinInvite.continueButton')}
                    >
                        <Text style={styles.buttonText}>{t('joinInvite.continueButton')}</Text>
                        <Ionicons name="arrow-forward" size={20} color={C.textInverse} />
                    </TouchableOpacity>
                </View>
            </SafeAreaView>
        );
    }

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
                    {/* Back */}
                    <TouchableOpacity
                        style={styles.backButton}
                        onPress={() => router.back()}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        accessibilityRole="button"
                        accessibilityLabel={t('joinInvite.back')}
                    >
                        <Ionicons name="chevron-back" size={22} color={C.primary} />
                        <Text style={styles.backText}>{t('joinInvite.back')}</Text>
                    </TouchableOpacity>

                    {/* Header */}
                    <View style={styles.headerIcon}>
                        <Ionicons name="link" size={26} color={C.success} />
                    </View>
                    <Text style={styles.heading} accessibilityRole="header">{t('joinInvite.heading')}</Text>
                    <Text style={styles.subheading}>
                        {t('joinInvite.subheading')}
                    </Text>

                    {/* Code input card */}
                    <View style={[styles.inputCard, SHADOW.xs]}>
                        <Text style={styles.label}>{t('joinInvite.codeLabel')}</Text>

                        <TextInput
                            style={[styles.input, focused && styles.inputFocused]}
                            placeholder={t('joinInvite.codePlaceholder')}
                            placeholderTextColor={C.textMuted}
                            autoCapitalize="characters"
                            autoCorrect={false}
                            maxLength={6}
                            value={inviteCode}
                            onChangeText={setInviteCode}
                            onFocus={() => setFocused(true)}
                            onBlur={() => setFocused(false)}
                            returnKeyType="done"
                            onSubmitEditing={joinInvite}
                            accessibilityLabel={t('joinInvite.codeLabel')}
                            accessibilityHint={t('joinInvite.codeHelper')}
                        />

                        <Text style={styles.helperText}>
                            {t('joinInvite.codeHelper')}
                        </Text>
                    </View>

                    {/* Trust note */}
                    <View style={styles.trustNote}>
                        <Ionicons name="shield-checkmark-outline" size={16} color={C.success} />
                        <Text style={styles.trustText}>
                            {t('joinInvite.trustNote')}
                        </Text>
                    </View>

                    <Text style={styles.needCodeHint}>{t('joinInvite.needCodeHint')}</Text>

                    {/* Spacer */}
                    <View style={styles.spacer} />

                    {/* Connect button */}
                    <TouchableOpacity
                        style={[styles.button, SHADOW.primary, loading && styles.buttonDisabled]}
                        onPress={joinInvite}
                        disabled={loading}
                        activeOpacity={0.88}
                        accessibilityRole="button"
                        accessibilityLabel={t('joinInvite.submit')}
                        accessibilityState={{ disabled: loading, busy: loading }}
                    >
                        {loading ? (
                            <ActivityIndicator color={C.textInverse} />
                        ) : (
                            <>
                                <Text style={styles.buttonText}>{t('joinInvite.submit')}</Text>
                                <Ionicons name="arrow-forward" size={20} color={C.textInverse} />
                            </>
                        )}
                    </TouchableOpacity>

                    {/* Already have an account on a new phone? */}
                    <TouchableOpacity
                        style={styles.signInLink}
                        onPress={() => router.push('/signin')}
                        activeOpacity={0.7}
                    >
                        <Text style={styles.signInLinkText}>
                            {t('joinInvite.signInPrompt')} <Text style={styles.signInLinkTextBold}>{t('joinInvite.signInAction')}</Text> {t('joinInvite.signInSuffix')}
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

    // ── Navigation ────────────────────────────────────────────────────
    backButton: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 28,
        alignSelf: 'flex-start',
    },
    backText: {
        fontSize: 16,
        fontWeight: '600',
        color: C.primary,
        marginLeft: 2,
    },

    // ── Connected confirmation ───────────────────────────────────────
    connectedContent: {
        flex: 1,
        paddingHorizontal: 28,
        paddingTop: 32,
        paddingBottom: 24,
    },
    connectedIconWrap: {
        marginBottom: 20,
    },
    needCodeHint: {
        fontSize: 12,
        color: C.textMuted,
        textAlign: 'center',
        lineHeight: 18,
        marginTop: 14,
        paddingHorizontal: 8,
    },

    // ── Header ────────────────────────────────────────────────────────
    headerIcon: {
        width: 52,
        height: 52,
        borderRadius: RADIUS.lg,
        backgroundColor: C.successLight,
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: 18,
    },
    heading: {
        fontSize: 30,
        fontWeight: '800',
        color: C.textPrimary,
        letterSpacing: -0.6,
        marginBottom: 10,
    },
    subheading: {
        fontSize: 15,
        color: C.textSecondary,
        lineHeight: 22,
        letterSpacing: -0.1,
        marginBottom: 28,
    },

    // ── Input card ────────────────────────────────────────────────────
    inputCard: {
        backgroundColor: C.bgSurface,
        borderRadius: RADIUS.xl,
        padding: 20,
        marginBottom: 14,
    },
    label: {
        fontSize: 13,
        fontWeight: '700',
        color: C.textPrimary,
        marginBottom: 12,
        letterSpacing: 0.1,
    },
    input: {
        backgroundColor: C.bgAlt,
        borderRadius: RADIUS.lg,
        paddingHorizontal: 20,
        paddingVertical: Platform.OS === 'ios' ? 18 : 15,
        fontSize: 30,
        fontWeight: '800',
        letterSpacing: 10,
        borderWidth: 2,
        borderColor: 'transparent',
        color: C.textPrimary,
        textAlign: 'center',
        fontVariant: ['tabular-nums'],
    },
    inputFocused: {
        backgroundColor: C.bgSurface,
        borderColor: C.borderFocus,
    },
    helperText: {
        fontSize: 12,
        color: C.textMuted,
        textAlign: 'center',
        marginTop: 10,
        lineHeight: 18,
    },

    // ── Trust note ────────────────────────────────────────────────────
    trustNote: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
        backgroundColor: C.successLight,
        borderRadius: RADIUS.lg,
        padding: 14,
        borderWidth: 1,
        borderColor: '#A7F3D0',
    },
    trustText: {
        flex: 1,
        fontSize: 13,
        color: '#065F46',
        lineHeight: 19,
        fontWeight: '500',
    },

    // ── CTA ───────────────────────────────────────────────────────────
    spacer: {
        flex: 1,
        minHeight: 32,
    },
    button: {
        backgroundColor: C.primary,
        paddingVertical: 18,
        borderRadius: RADIUS.xl,
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 10,
        marginTop: 24,
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

    // ── Sign-in link ──────────────────────────────────────────────────
    signInLink: {
        marginTop: 18,
        paddingVertical: 8,
        alignItems: 'center',
    },
    signInLinkText: {
        fontSize: 13,
        color: C.textMuted,
        textAlign: 'center',
    },
    signInLinkTextBold: {
        color: C.primary,
        fontWeight: '700',
    },
});
