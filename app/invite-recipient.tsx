import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AccessibilityInfo,
    ActivityIndicator,
    AppState,
    Platform,
    ScrollView,
    Share,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { RADIUS, SHADOW, ThemeColors } from '@/constants/theme';
import { fetchOrganizerConnections } from '@/lib/connections';
import { useTranslation } from '@/lib/i18n/context';
import { MAX_STANDARD_PARTICIPANTS } from '@/lib/limits';
import { logOnboardingEvent } from '@/lib/onboarding';
import { useThemeColors } from '@/lib/theme';
import { supabase } from '@/lib/supabase';
import { showAlertOnce } from '@/lib/alertGuard';

export default function InviteRecipientScreen() {
    const C = useThemeColors();
    const t = useTranslation();
    const styles = useMemo(() => createStyles(C), [C]);
    const HOW_IT_WORKS = [
        t('inviteParticipant.step1'),
        t('inviteParticipant.step2'),
        t('inviteParticipant.step3'),
        t('inviteParticipant.step4'),
    ];
    const [inviteCode, setInviteCode]       = useState('');
    const [loading, setLoading]             = useState(false);
    // null while loading; once resolved, the participant-limit gate uses
    // this. Matches the server's own count exactly (accepted + non-expired
    // pending — see lib/connectionStateCore.ts / create_invite_code()),
    // not just accepted, since an outstanding pending invite already
    // occupies a slot even before it's accepted.
    const [slotsUsed, setSlotsUsed] = useState<number | null>(null);
    // The pending connection row created by *this* screen visit. Regenerating
    // the code while still here updates this same row; it is intentionally
    // never restored from a previous visit — each "Add Participant" action
    // is a fresh invite for a distinct participant, never a reused one.
    const [draftConnectionId, setDraftConnectionId] = useState<string | null>(null);
    const [expiresAt, setExpiresAt] = useState<string | null>(null);
    // null = not yet checked/still pending; a string once the draft
    // connection is found accepted (participant's display name, or '' if
    // the name is unavailable for some reason).
    const [joinedName, setJoinedName] = useState<string | null>(null);
    // Always holds the CURRENT draftConnectionId (regenerating the code
    // creates a new one) — checkDraftAcceptance closes over whatever id was
    // current when IT started, so this ref lets a check for an
    // already-superseded id detect that and bail before committing state
    // for the wrong connection.
    const draftConnectionIdRef = useRef(draftConnectionId);
    useEffect(() => { draftConnectionIdRef.current = draftConnectionId; }, [draftConnectionId]);

    const checkDraftAcceptance = useCallback(async () => {
        if (!draftConnectionId) return;
        const checkingId = draftConnectionId;
        const { data: connectionRow } = await supabase
            .from('connections')
            .select('status, recipient_id')
            .eq('id', checkingId)
            .maybeSingle();

        if (draftConnectionIdRef.current !== checkingId) return;
        if (connectionRow?.status !== 'accepted' || !connectionRow.recipient_id) return;

        const { data: recipientProfile } = await supabase
            .from('profiles')
            .select('full_name')
            .eq('id', connectionRow.recipient_id)
            .maybeSingle();

        if (draftConnectionIdRef.current !== checkingId) return;
        setJoinedName(recipientProfile?.full_name ?? '');
    }, [draftConnectionId]);

    // Re-checks the draft connection's status every time this screen
    // regains focus (e.g. the caregiver backgrounds Tavora while their
    // participant enters the code, then returns) — the success state with
    // the participant's name is shown only once the server confirms
    // acceptance, never guessed client-side.
    useFocusEffect(useCallback(() => { checkDraftAcceptance(); }, [checkDraftAcceptance]));

    // PHASE 11 live refresh: this is the screen a caregiver is most likely
    // to be staring at right after sharing a code, so poll while waiting —
    // bounded to exactly the window where it matters (a code exists and
    // hasn't been accepted yet), never continuous/unconditional, and
    // paused while the app is backgrounded (AppState, not just navigation
    // focus — useFocusEffect alone doesn't fire on OS backgrounding).
    useEffect(() => {
        if (!draftConnectionId || joinedName !== null) return;
        const interval = setInterval(() => {
            if (AppState.currentState === 'active') checkDraftAcceptance();
        }, 8000);
        return () => clearInterval(interval);
    }, [draftConnectionId, joinedName, checkDraftAcceptance]);

    // Check how many participant slots this organizer already occupies, to
    // gate against the standard-account limit — an outstanding pending
    // invite already occupies a slot even before it's accepted, so this
    // must match the server's own accepted+pending count exactly (a
    // client that only counted accepted connections could show the
    // generator right up until the server's authoritative check rejects
    // it — see PHASE 4 in the task, and create_invite_code() itself).
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const { data: { user } } = await supabase.auth.getUser();
            if (!user || cancelled) return;

            const connections = await fetchOrganizerConnections(user.id);
            if (cancelled) return;
            // A failed count fetch leaves slotsUsed at its "unknown" null
            // state rather than confidently showing 0 — the server is the
            // real enforcement point regardless (create_invite_code()
            // re-checks the limit itself), this only affects whether the
            // client shows the lock icon pre-emptively.
            if (connections.ok) setSlotsUsed(connections.slotsUsed);
        })();
        return () => { cancelled = true; };
    }, []);

    const atStandardLimit = slotsUsed !== null && slotsUsed >= MAX_STANDARD_PARTICIPANTS;

    async function createInviteCode() {
        // Without this, a rapid double-tap of the very first "Generate"
        // (before draftConnectionId exists) can fire two concurrent INSERTs
        // -- unlike a regenerate, which updates the same row in place and
        // is naturally idempotent, a fresh invite has no such protection
        // server-side.
        if (loading) return;
        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        setLoading(true);

        const { data: { user }, error: userError } = await supabase.auth.getUser();

        if (userError || !user) {
            setLoading(false);
            showAlertOnce(t('inviteParticipant.notSignedInTitle'), t('inviteParticipant.notSignedInMessage'));
            return;
        }

        // Server-generates a cryptographically secure code and a 7-day
        // expiration — passing draftConnectionId regenerates that same
        // pending row in place (e.g. tapping "Generate New Code" again
        // before sharing); omitting it creates a fresh invite. Each "Add
        // Participant" action is a separate invite for a separate
        // participant, never a reuse of an older pending invite.
        const { data: result, error } = await supabase
            .rpc('create_invite_code', { p_existing_connection_id: draftConnectionId })
            .maybeSingle() as { data: { id: string; invite_code: string; expires_at: string } | null; error: { message: string } | null };

        setLoading(false);

        if (error || !result) {
            // Fails closed with a stable, classifiable message when the
            // server's own authoritative count (re-checked here even
            // though the client already gated on slotsUsed above, since a
            // second device/tab or a stale in-memory count could still
            // race past the client-side gate — the server is the real
            // enforcement point).
            if (error?.message?.includes('participant_limit_reached')) {
                setSlotsUsed(MAX_STANDARD_PARTICIPANTS); // re-gate this screen immediately without a second round trip
                showAlertOnce(
                    t('inviteParticipant.limitReachedTitle'),
                    t('inviteParticipant.limitReachedMessage', { limit: MAX_STANDARD_PARTICIPANTS })
                );
                return;
            }
            showAlertOnce(
                t('inviteParticipant.saveErrorTitle'),
                t('inviteParticipant.saveErrorMessage')
            );
            return;
        }

        setDraftConnectionId(result.id);
        setInviteCode(result.invite_code);
        setExpiresAt(result.expires_at);
        setJoinedName(null); // a regenerated code is a fresh invite -- any prior joined-state no longer applies
        logOnboardingEvent('invite_created');
    }

    async function shareInviteCode() {
        if (!inviteCode) {
            showAlertOnce(t('inviteParticipant.noCodeTitle'), t('inviteParticipant.noCodeMessage'));
            return;
        }

        const result = await Share.share({
            message: t('inviteParticipant.shareMessage', { code: inviteCode }),
        });
        // The native share sheet gives sighted users its own visual
        // confirmation; VoiceOver users get nothing unless we announce it
        // ourselves — 'dismissedAction' (iOS-only) means the sheet was
        // closed without picking a target, so that case is deliberately
        // silent rather than falsely announcing a share that didn't happen.
        if (result.action === Share.sharedAction) {
            AccessibilityInfo.announceForAccessibility?.(t('inviteParticipant.shareSuccessAnnouncement'));
        }
    }

    const hasCode = inviteCode.length > 0;

    if (atStandardLimit) {
        return (
            <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
                <ScrollView
                    contentContainerStyle={styles.content}
                    showsVerticalScrollIndicator={false}
                >
                    {/* Back */}
                    <TouchableOpacity
                        style={styles.backButton}
                        onPress={() => router.back()}
                        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                    >
                        <Ionicons name="chevron-back" size={22} color={C.primary} />
                        <Text style={styles.backText}>{t('inviteParticipant.back')}</Text>
                    </TouchableOpacity>

                    {/* Upgrade placeholder — no real purchase flow yet */}
                    <View style={styles.upgradeIconWrap}>
                        <Ionicons name="sparkles" size={28} color={C.primary} />
                    </View>
                    <Text style={styles.heading}>{t('inviteParticipant.plusTitle')}</Text>
                    <Text style={styles.subheading}>
                        {t('inviteParticipant.plusSubtitle', { limit: MAX_STANDARD_PARTICIPANTS })}
                    </Text>

                    <View style={[styles.upgradeCard, SHADOW.sm]}>
                        <View style={styles.upgradeRow}>
                            <Ionicons name="people-outline" size={18} color={C.primary} />
                            <Text style={styles.upgradeRowText}>{t('inviteParticipant.plusUnlimited')}</Text>
                        </View>
                        <View style={styles.upgradeRow}>
                            <Ionicons name="stats-chart-outline" size={18} color={C.primary} />
                            <Text style={styles.upgradeRowText}>{t('inviteParticipant.plusAnalytics')}</Text>
                        </View>
                        <View style={styles.upgradeRow}>
                            <Ionicons name="notifications-outline" size={18} color={C.primary} />
                            <Text style={styles.upgradeRowText}>{t('inviteParticipant.plusPriority')}</Text>
                        </View>
                    </View>

                    <TouchableOpacity style={[styles.generateButton, styles.generateButtonPrimary, SHADOW.primary]} disabled>
                        <Text style={styles.generateButtonTextPrimary}>{t('inviteParticipant.comingSoon')}</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={styles.doneButton}
                        onPress={() => router.back()}
                        activeOpacity={0.7}
                    >
                        <Text style={styles.doneButtonText}>{t('inviteParticipant.notNow')}</Text>
                    </TouchableOpacity>
                </ScrollView>
            </SafeAreaView>
        );
    }

    return (
        <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
            <ScrollView
                contentContainerStyle={styles.content}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
            >
                {/* Back */}
                <TouchableOpacity
                    style={styles.backButton}
                    onPress={() => router.back()}
                    hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                    accessibilityRole="button"
                    accessibilityLabel={t('inviteParticipant.back')}
                >
                    <Ionicons name="chevron-back" size={22} color={C.primary} />
                    <Text style={styles.backText}>{t('inviteParticipant.back')}</Text>
                </TouchableOpacity>

                {/* Header */}
                <View style={styles.headerIcon}>
                    <Ionicons name="person-add" size={26} color={C.primary} />
                </View>
                <Text style={styles.heading} accessibilityRole="header">{t('inviteParticipant.heading')}</Text>
                <Text style={styles.subheading}>
                    {t('inviteParticipant.subheading')}
                </Text>

                {/* What this code does */}
                <View style={[styles.explainerCard, SHADOW.xs]}>
                    <Ionicons name="information-circle-outline" size={18} color={C.primary} />
                    <View style={styles.explainerTextWrap}>
                        <Text style={styles.explainerTitle}>{t('inviteParticipant.whatThisDoesTitle')}</Text>
                        <Text style={styles.explainerBody}>{t('inviteParticipant.whatThisDoesBody')}</Text>
                    </View>
                </View>

                {/* Code card */}
                <View style={[styles.codeCard, SHADOW.sm, hasCode && styles.codeCardActive]}>
                    <Text style={styles.codeLabel}>{t('inviteParticipant.codeLabel')}</Text>

                    {hasCode ? (
                        <>
                            <Text style={styles.code} accessibilityLabel={inviteCode.split('').join(' ')}>{inviteCode}</Text>
                            {joinedName !== null ? (
                                <View style={[styles.codeReadyBadge, styles.codeJoinedBadge]}>
                                    <Ionicons name="checkmark-circle" size={14} color={C.success} />
                                    <Text style={styles.codeReadyText}>
                                        {joinedName ? t('inviteParticipant.connectedBadge', { name: joinedName }) : t('joinInvite.connectedSubtitleGeneric')}
                                    </Text>
                                </View>
                            ) : (
                                <View style={styles.codeReadyBadge}>
                                    <Ionicons name="time-outline" size={14} color={C.textMuted} />
                                    <Text style={styles.codeWaitingText}>{t('inviteParticipant.waitingBadge')}</Text>
                                </View>
                            )}
                            {expiresAt && (
                                <Text style={styles.expiresText}>
                                    {t('inviteParticipant.expiresOn', { date: new Date(expiresAt).toLocaleDateString() })}
                                </Text>
                            )}
                        </>
                    ) : (
                        <>
                            <View style={styles.codePlaceholderRow}>
                                {Array.from({ length: 6 }).map((_, i) => (
                                    <View key={i} style={styles.codeDash} />
                                ))}
                            </View>
                            <Text style={styles.codeHint}>{t('inviteParticipant.codeHint')}</Text>
                        </>
                    )}
                </View>

                {/* Generate button */}
                <TouchableOpacity
                    style={[
                        styles.generateButton,
                        hasCode ? styles.generateButtonSecondary : [styles.generateButtonPrimary, SHADOW.primary],
                        loading && styles.buttonDisabled,
                    ]}
                    onPress={createInviteCode}
                    disabled={loading}
                    activeOpacity={0.88}
                    accessibilityRole="button"
                    accessibilityLabel={hasCode ? t('inviteParticipant.regenerate') : t('inviteParticipant.generate')}
                    accessibilityState={{ disabled: loading, busy: loading }}
                >
                    {loading ? (
                        <ActivityIndicator color={hasCode ? C.primary : C.textInverse} />
                    ) : (
                        <>
                            <Ionicons
                                name="refresh"
                                size={18}
                                color={hasCode ? C.primary : C.textInverse}
                            />
                            <Text style={hasCode ? styles.generateButtonTextSecondary : styles.generateButtonTextPrimary}>
                                {hasCode ? t('inviteParticipant.regenerate') : t('inviteParticipant.generate')}
                            </Text>
                        </>
                    )}
                </TouchableOpacity>
                {hasCode && <Text style={styles.regenerateHint}>{t('inviteParticipant.regenerateHint')}</Text>}

                {/* Share button — only shown once code exists */}
                {hasCode && (
                    <TouchableOpacity
                        style={[styles.shareButton, SHADOW.primary]}
                        onPress={shareInviteCode}
                        activeOpacity={0.88}
                        accessibilityRole="button"
                        accessibilityLabel={t('inviteParticipant.share')}
                    >
                        <Ionicons name="share-social" size={20} color={C.textInverse} />
                        <Text style={styles.shareButtonText}>{t('inviteParticipant.share')}</Text>
                    </TouchableOpacity>
                )}

                {/* How it works */}
                <View style={[styles.stepsCard, SHADOW.xs]}>
                    <Text style={styles.stepsTitle}>{t('inviteParticipant.howItWorksTitle')}</Text>

                    {HOW_IT_WORKS.map((step, index) => (
                        <View key={index} style={styles.stepRow}>
                            <View style={styles.stepBadge}>
                                <Text style={styles.stepBadgeText}>{index + 1}</Text>
                            </View>
                            <Text style={styles.stepText}>{step}</Text>
                        </View>
                    ))}
                </View>

                {/* Done */}
                <TouchableOpacity
                    style={styles.doneButton}
                    onPress={() => router.push('/caregiver-dashboard')}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel={t('inviteParticipant.done')}
                >
                    <Text style={styles.doneButtonText}>{t('inviteParticipant.done')}</Text>
                </TouchableOpacity>
            </ScrollView>
        </SafeAreaView>
    );
}

const createStyles = (C: ThemeColors) => StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: C.bgPage,
    },
    content: {
        paddingHorizontal: 24,
        paddingTop: 12,
        paddingBottom: 40,
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

    // ── Header ────────────────────────────────────────────────────────
    headerIcon: {
        width: 52,
        height: 52,
        borderRadius: RADIUS.lg,
        backgroundColor: C.primaryLight,
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

    // ── Upgrade placeholder ───────────────────────────────────────────
    upgradeIconWrap: {
        width: 52,
        height: 52,
        borderRadius: RADIUS.lg,
        backgroundColor: C.primaryLight,
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: 18,
    },
    upgradeCard: {
        backgroundColor: C.bgSurface,
        borderRadius: RADIUS.xl,
        padding: 20,
        marginBottom: 20,
        gap: 14,
    },
    upgradeRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    upgradeRowText: {
        fontSize: 15,
        color: C.textPrimary,
        fontWeight: '600',
    },

    // ── Explainer card ───────────────────────────────────────────────
    explainerCard: {
        backgroundColor: C.bgSurface,
        borderRadius: RADIUS.lg,
        padding: 16,
        marginBottom: 14,
        flexDirection: 'row',
        gap: 10,
    },
    explainerTextWrap: {
        flex: 1,
    },
    explainerTitle: {
        fontSize: 13,
        fontWeight: '700',
        color: C.textPrimary,
        marginBottom: 4,
    },
    explainerBody: {
        fontSize: 12,
        color: C.textSecondary,
        lineHeight: 18,
    },

    // ── Code card ─────────────────────────────────────────────────────
    codeCard: {
        backgroundColor: C.bgSurface,
        borderRadius: RADIUS.xl,
        padding: 28,
        alignItems: 'center',
        marginBottom: 14,
        borderWidth: 2,
        borderColor: C.border,
        borderStyle: 'dashed',
    },
    codeCardActive: {
        borderStyle: 'solid',
        borderColor: C.primary,
        backgroundColor: C.primaryLight,
    },
    codeLabel: {
        fontSize: 11,
        fontWeight: '700',
        color: C.textMuted,
        textTransform: 'uppercase',
        letterSpacing: 1,
        marginBottom: 16,
    },
    code: {
        fontSize: 42,
        fontWeight: '800',
        color: C.primary,
        letterSpacing: 8,
        marginBottom: 12,
        fontVariant: ['tabular-nums'],
    },
    codeReadyBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
    },
    codeReadyText: {
        fontSize: 13,
        color: C.success,
        fontWeight: '600',
    },
    codeJoinedBadge: {
        marginBottom: 4,
    },
    codeWaitingText: {
        fontSize: 13,
        color: C.textMuted,
        fontWeight: '600',
    },
    expiresText: {
        fontSize: 12,
        color: C.textMuted,
        marginTop: 10,
    },
    regenerateHint: {
        fontSize: 12,
        color: C.textMuted,
        textAlign: 'center',
        lineHeight: 17,
        marginTop: -4,
        marginBottom: 16,
        paddingHorizontal: 8,
    },
    codePlaceholderRow: {
        flexDirection: 'row',
        gap: 8,
        marginBottom: 16,
    },
    codeDash: {
        width: 28,
        height: 4,
        borderRadius: RADIUS.full,
        backgroundColor: C.border,
    },
    codeHint: {
        fontSize: 13,
        color: C.textMuted,
        textAlign: 'center',
    },

    // ── Buttons ───────────────────────────────────────────────────────
    generateButton: {
        paddingVertical: 16,
        borderRadius: RADIUS.xl,
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 8,
        marginBottom: 12,
    },
    generateButtonPrimary: {
        backgroundColor: C.primary,
    },
    generateButtonSecondary: {
        backgroundColor: C.bgSurface,
        borderWidth: 1.5,
        borderColor: C.border,
    },
    generateButtonTextPrimary: {
        color: C.textInverse,
        fontSize: 16,
        fontWeight: '700',
        letterSpacing: -0.1,
    },
    generateButtonTextSecondary: {
        color: C.primary,
        fontSize: 15,
        fontWeight: '600',
    },
    shareButton: {
        backgroundColor: C.primary,
        paddingVertical: 18,
        borderRadius: RADIUS.xl,
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 10,
        marginBottom: 24,
    },
    shareButtonText: {
        color: C.textInverse,
        fontSize: 17,
        fontWeight: '700',
        letterSpacing: -0.2,
    },
    buttonDisabled: {
        opacity: 0.65,
    },
    doneButton: {
        paddingVertical: 16,
        alignItems: 'center',
    },
    doneButtonText: {
        fontSize: 15,
        color: C.textMuted,
        fontWeight: '600',
    },

    // ── Steps card ────────────────────────────────────────────────────
    stepsCard: {
        backgroundColor: C.bgSurface,
        borderRadius: RADIUS.xl,
        padding: 20,
        marginBottom: 20,
    },
    stepsTitle: {
        fontSize: 16,
        fontWeight: '700',
        color: C.textPrimary,
        letterSpacing: -0.2,
        marginBottom: 18,
    },
    stepRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 14,
        marginBottom: 14,
    },
    stepBadge: {
        width: 26,
        height: 26,
        borderRadius: RADIUS.full,
        backgroundColor: C.primary,
        justifyContent: 'center',
        alignItems: 'center',
        flexShrink: 0,
        marginTop: 1,
    },
    stepBadgeText: {
        color: C.textInverse,
        fontSize: 12,
        fontWeight: '800',
    },
    stepText: {
        flex: 1,
        fontSize: 14,
        color: C.textSecondary,
        lineHeight: 21,
        letterSpacing: -0.1,
    },
});
