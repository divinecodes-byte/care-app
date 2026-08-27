import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
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
import { useTranslation } from '@/lib/i18n/context';
import { logOnboardingEvent } from '@/lib/onboarding';
import { getOrganizerLabelKey, getRelationshipDefinition } from '@/lib/relationshipCore';
import { useThemeColors } from '@/lib/theme';
import { supabase } from '@/lib/supabase';
import { showAlertOnce } from '@/lib/alertGuard';
import { classifyScreenError } from '@/lib/asyncStateCore';
import { ERROR_CATEGORY_TRANSLATION_KEYS } from '@/lib/errorClassification';
import { useRequestGeneration } from '@/lib/useRequestGeneration';
import { useFocusOnChange } from '@/lib/useAccessibilityFocus';

type InvitePreview = {
    organizerName: string | null;
    relationshipPair: string | null;
};

export default function JoinInviteScreen() {
    const C = useThemeColors();
    const t = useTranslation();
    const styles = useMemo(() => createStyles(C), [C]);
    const [inviteCode, setInviteCode] = useState('');
    const [loading, setLoading]       = useState(false);
    const [focused, setFocused]       = useState(false);
    // Set after a successful, non-consuming preview_invite_code call —
    // shows the organizer name and proposed relationship BEFORE the
    // participant commits to accepting (the relationship must never be
    // silently hidden). Accepting/declining from this screen never guesses
    // anything client-side; preview_invite_code requires the exact code
    // and never mutates the row, so nothing here weakens the original
    // "can't learn who a code belongs to without it" guarantee.
    const [preview, setPreview] = useState<InvitePreview | null>(null);
    // Set only after a real 'accepted' result from accept_invite_code.
    const [connectedName, setConnectedName] = useState<string | null>(null);
    const { start: startLoad, isCurrent: isLoadCurrent } = useRequestGeneration();
    const connectedHeadingRef = useFocusOnChange<Text>(connectedName !== null);
    const previewHeadingRef = useFocusOnChange<Text>(preview !== null);

    function normalizedCodeOrAlert(): string | null {
        const normalizedCode = inviteCode.trim().toUpperCase();
        if (!normalizedCode) {
            showAlertOnce(t('joinInvite.missingCodeTitle'), t('joinInvite.missingCodeMessage'));
            return null;
        }
        if (normalizedCode.length < 6) {
            showAlertOnce(t('joinInvite.invalidCodeTitle'), t('joinInvite.invalidCodeLength'));
            return null;
        }
        return normalizedCode;
    }

    async function previewInvite() {
        // Guards both the button (already disabled via `disabled={loading}`)
        // and the keyboard "Done" submit path (TextInput's onSubmitEditing
        // isn't gated by that prop) against a rapid double-fire.
        if (loading) return;

        const normalizedCode = normalizedCodeOrAlert();
        if (!normalizedCode) return;

        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        const generation = startLoad();
        setLoading(true);

        const { data: { user }, error: userError } = await supabase.auth.getUser();
        if (!isLoadCurrent(generation)) return;

        if (userError || !user) {
            setLoading(false);
            showAlertOnce(t('joinInvite.notSignedInTitle'), t('joinInvite.notSignedInMessage'));
            return;
        }

        // Read-only, non-consuming — requires the exact code (same search
        // space accept_invite_code has always required), never mutates
        // connections. See preview_invite_code() in
        // supabase/migrations/20260826000000_relationship_context_education_and_general_reminder_type.sql.
        const { data: result, error: previewError } = await supabase
            .rpc('preview_invite_code', { p_code: normalizedCode })
            .maybeSingle() as { data: { status: string; organizer_full_name: string | null; relationship_pair: string | null } | null; error: { message: string } | null };

        if (!isLoadCurrent(generation)) return;
        setLoading(false);

        if (previewError || !result) {
            showAlertOnce(t('joinInvite.errorTitle'), t(ERROR_CATEGORY_TRANSLATION_KEYS[classifyScreenError(previewError?.message)]));
            return;
        }

        if (result.status === 'not_found') {
            showAlertOnce(t('joinInvite.invalidCodeTitle'), t('joinInvite.invalidCodeNotFound'));
            return;
        }
        if (result.status === 'already_accepted') {
            showAlertOnce(t('joinInvite.alreadyUsedTitle'), t('joinInvite.alreadyUsedMessage'));
            return;
        }
        if (result.status === 'expired') {
            showAlertOnce(t('joinInvite.invalidCodeTitle'), t('joinInvite.expiredCodeMessage'));
            return;
        }
        if (result.status === 'self') {
            showAlertOnce(t('joinInvite.invalidCodeTitle'), t('joinInvite.selfConnectMessage'));
            return;
        }

        setPreview({ organizerName: result.organizer_full_name, relationshipPair: result.relationship_pair });
    }

    function declinePreview() {
        setPreview(null);
        setInviteCode('');
    }

    async function confirmAccept() {
        if (loading || !preview) return;
        const normalizedCode = inviteCode.trim().toUpperCase();

        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        const generation = startLoad();
        setLoading(true);

        // Validates and accepts atomically, server-side — self-connection,
        // expiration, and a concurrent acceptance race are all enforced
        // inside the function itself, not by a raw client UPDATE. A code
        // can still race between preview and accept (e.g. it expires, or
        // someone else accepts it first) -- every one of preview's status
        // outcomes is re-checked here too, not assumed still true.
        const { data: result, error: acceptError } = await supabase
            .rpc('accept_invite_code', { p_code: normalizedCode });

        if (!isLoadCurrent(generation)) return;
        setLoading(false);

        if (acceptError) {
            showAlertOnce(t('joinInvite.errorTitle'), t(ERROR_CATEGORY_TRANSLATION_KEYS[classifyScreenError(acceptError.message)]));
            return;
        }

        if (result === 'not_found') {
            setPreview(null);
            showAlertOnce(t('joinInvite.invalidCodeTitle'), t('joinInvite.invalidCodeNotFound'));
            return;
        }
        if (result === 'already_accepted') {
            setPreview(null);
            showAlertOnce(t('joinInvite.alreadyUsedTitle'), t('joinInvite.alreadyUsedMessage'));
            return;
        }
        if (result === 'expired') {
            setPreview(null);
            showAlertOnce(t('joinInvite.invalidCodeTitle'), t('joinInvite.expiredCodeMessage'));
            return;
        }
        if (result === 'self') {
            setPreview(null);
            showAlertOnce(t('joinInvite.invalidCodeTitle'), t('joinInvite.selfConnectMessage'));
            return;
        }

        logOnboardingEvent('invite_accepted');
        // The organizer name shown here is the exact same one already
        // confirmed by preview_invite_code for this exact code -- no
        // redundant re-fetch needed (accepting can't change who the
        // invite belonged to).
        setConnectedName(preview.organizerName ?? '');
    }

    if (connectedName !== null) {
        return (
            <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
                <View style={styles.connectedContent}>
                    <View style={styles.connectedIconWrap}>
                        <Ionicons name="checkmark-circle" size={48} color={C.success} />
                    </View>
                    <Text ref={connectedHeadingRef} style={styles.heading} accessibilityRole="header">
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

    if (preview !== null) {
        const relationshipDef = getRelationshipDefinition(preview.relationshipPair);
        const organizerLabel = t(getOrganizerLabelKey(preview.relationshipPair));
        return (
            <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
                <View style={styles.connectedContent}>
                    <View style={styles.connectedIconWrap}>
                        <Ionicons name="person-circle-outline" size={48} color={C.primary} />
                    </View>
                    <Text ref={previewHeadingRef} style={styles.heading} accessibilityRole="header">
                        {t('joinInvite.previewTitle')}
                    </Text>
                    <Text style={styles.subheading}>
                        {preview.organizerName
                            ? t('joinInvite.previewSubtitle', { name: preview.organizerName })
                            : t('joinInvite.connectedSubtitleGeneric')}
                    </Text>

                    <View style={[styles.relationshipCard, SHADOW.xs]}>
                        <Ionicons name={(relationshipDef?.icon ?? 'people') as keyof typeof Ionicons.glyphMap} size={20} color={C.primary} />
                        <View style={styles.relationshipCardTextWrap}>
                            <Text style={styles.relationshipCardTitle}>
                                {relationshipDef ? t(relationshipDef.titleKey) : t('joinInvite.relationshipUnspecified')}
                            </Text>
                            <Text style={styles.relationshipCardBody}>
                                {t('joinInvite.previewRoleLine', { organizerLabel })}
                            </Text>
                        </View>
                    </View>

                    <View style={styles.spacer} />

                    <TouchableOpacity
                        style={[styles.button, SHADOW.primary, loading && styles.buttonDisabled]}
                        onPress={confirmAccept}
                        disabled={loading}
                        activeOpacity={0.88}
                        accessibilityRole="button"
                        accessibilityLabel={t('joinInvite.acceptButton')}
                        accessibilityState={{ disabled: loading, busy: loading }}
                    >
                        {loading ? (
                            <ActivityIndicator color={C.textInverse} />
                        ) : (
                            <>
                                <Text style={styles.buttonText}>{t('joinInvite.acceptButton')}</Text>
                                <Ionicons name="checkmark" size={20} color={C.textInverse} />
                            </>
                        )}
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={styles.declineButton}
                        onPress={declinePreview}
                        disabled={loading}
                        activeOpacity={0.7}
                        accessibilityRole="button"
                        accessibilityLabel={t('joinInvite.declineButton')}
                    >
                        <Text style={styles.declineButtonText}>{t('joinInvite.declineButton')}</Text>
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
                        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
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
                            onSubmitEditing={previewInvite}
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
                        onPress={previewInvite}
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

    // ── Relationship preview card ────────────────────────────────────
    relationshipCard: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        backgroundColor: C.bgSurface,
        borderRadius: RADIUS.lg,
        padding: 16,
        width: '100%',
        marginTop: 4,
    },
    relationshipCardTextWrap: {
        flex: 1,
    },
    relationshipCardTitle: {
        fontSize: 15,
        fontWeight: '700',
        color: C.textPrimary,
        marginBottom: 3,
    },
    relationshipCardBody: {
        fontSize: 13,
        color: C.textSecondary,
        lineHeight: 18,
    },
    declineButton: {
        paddingVertical: 14,
        alignItems: 'center',
    },
    declineButtonText: {
        fontSize: 15,
        color: C.textMuted,
        fontWeight: '600',
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
