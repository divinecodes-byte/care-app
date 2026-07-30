import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Platform,
    RefreshControl,
    ScrollView,
    Share,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { OfflineBanner, SectionErrorState, announceStateChange } from '@/components/StateViews';
import { RADIUS, SHADOW, ThemeColors } from '@/constants/theme';
import { ErrorCategory } from '@/lib/asyncStateCore';
import { CONNECTION_ERROR_TRANSLATION_KEYS } from '@/lib/connectionErrors';
import { endConnection, fetchOrganizerConnections, ParticipantSummary, PendingInviteSummary } from '@/lib/connections';
import { ERROR_CATEGORY_TRANSLATION_KEYS } from '@/lib/errorClassification';
import { useTranslation } from '@/lib/i18n/context';
import { MAX_STANDARD_PARTICIPANTS } from '@/lib/limits';
import { getRoleLabelKeys, UseCase } from '@/lib/onboarding';
import { setStoredSelectedConnectionId } from '@/lib/selected-participant';
import { useThemeColors } from '@/lib/theme';
import { useRequestGeneration } from '@/lib/useRequestGeneration';
import { supabase } from '@/lib/supabase';
import { showAlertOnce } from '@/lib/alertGuard';

type ReminderCounts = Record<string, number>;

export default function ParticipantsScreen() {
    const C = useThemeColors();
    const t = useTranslation();
    const styles = useMemo(() => createStyles(C), [C]);

    const [loading, setLoading] = useState(true);
    const [errored, setErrored] = useState(false);
    const [errorCategory, setErrorCategory] = useState<ErrorCategory | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [active, setActive] = useState<ParticipantSummary[]>([]);
    const [pending, setPending] = useState<PendingInviteSummary[]>([]);
    const [reminderCounts, setReminderCounts] = useState<ReminderCounts>({});
    const [organizerUseCase, setOrganizerUseCase] = useState<UseCase | null>(null);
    const [busyConnectionId, setBusyConnectionId] = useState<string | null>(null);
    const hasLoadedOnceRef = useRef(false);
    // Mirrors the `errored` state for synchronous reads at the top of
    // load() -- see the comment there for why the state itself can't be
    // used for this.
    const erroredRef = useRef(false);
    const { start: startLoad, isCurrent: isLoadCurrent } = useRequestGeneration();

    const load = useCallback(async (isRefresh: boolean) => {
        const generation = startLoad();
        // Captured before clearing -- lets a load that recovers from a
        // prior error/offline banner announce that fact to VoiceOver once
        // the banner disappears (it has no live region of its own once
        // it's gone). A ref, not the `errored` state, since React state
        // wouldn't reflect this render's own upcoming update in time.
        const wasRecoveringFromError = erroredRef.current;
        let succeeded = true;
        // First load shows the full loading card; a refetch (focus, pull-
        // to-refresh) with data already on screen only shows the discreet
        // RefreshControl spinner — a failed refresh never blanks the list.
        if (isRefresh || hasLoadedOnceRef.current) setRefreshing(true); else setLoading(true);
        setErrored(false);
        setErrorCategory(null);

        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
            setLoading(false);
            setRefreshing(false);
            router.replace('/signin');
            return;
        }

        try {
            const [{ data: profileRow }, connections] = await Promise.all([
                supabase.from('profiles').select('use_case').eq('id', user.id).maybeSingle(),
                fetchOrganizerConnections(user.id),
            ]);

            if (!isLoadCurrent(generation)) return;

            setOrganizerUseCase((profileRow?.use_case as UseCase | null) ?? null);

            if (!connections.ok) {
                // Preserve whatever active/pending was already on screen —
                // never replace real data with an empty list just because
                // this one fetch failed (previously this function silently
                // treated a query error identically to "zero participants").
                setErrored(true);
                setErrorCategory(connections.errorCategory);
                succeeded = false;
                return;
            }

            setActive(connections.active);
            setPending(connections.pending);

            // One batched query for every active connection's reminder
            // count — never a per-participant loop.
            if (connections.active.length > 0) {
                const { data: reminderRows } = await supabase
                    .from('reminders')
                    .select('connection_id')
                    .in('connection_id', connections.active.map((p) => p.connectionId))
                    .eq('is_active', true);
                if (!isLoadCurrent(generation)) return;
                const counts: ReminderCounts = {};
                for (const row of reminderRows ?? []) {
                    counts[row.connection_id] = (counts[row.connection_id] ?? 0) + 1;
                }
                setReminderCounts(counts);
            } else {
                setReminderCounts({});
            }
        } catch {
            if (!isLoadCurrent(generation)) return;
            setErrored(true);
            setErrorCategory(null);
            succeeded = false;
        } finally {
            if (isLoadCurrent(generation)) {
                setLoading(false);
                setRefreshing(false);
                hasLoadedOnceRef.current = true;
                erroredRef.current = !succeeded;
                if (succeeded && wasRecoveringFromError) announceStateChange(t('stateViews.backToNormal'));
            }
        }
    }, [startLoad, isLoadCurrent]);

    useFocusEffect(useCallback(() => { load(false); }, [load]));

    const slotsUsed = active.length + pending.length;
    const atStandardLimit = slotsUsed >= MAX_STANDARD_PARTICIPANTS;
    const roleLabelKeys = getRoleLabelKeys(organizerUseCase);
    const participantRoleLabel = t(roleLabelKeys.participantTitle);

    async function openParticipant(connectionId: string) {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) await setStoredSelectedConnectionId(user.id, connectionId);
        router.push({ pathname: '/caregiver-dashboard', params: { connectionId } });
    }

    function createReminderFor(connectionId: string) {
        router.push({ pathname: '/create-item', params: { connectionId } });
    }

    function assignRoutineFor(connectionId: string) {
        router.push({ pathname: '/routine-library', params: { connectionId } });
    }

    function confirmEndConnection(connectionId: string, name: string) {
        showAlertOnce(
            t('participants.endConnectionConfirmTitle'),
            t('participants.endConnectionConfirmMessage', { name }),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('participants.endConnectionConfirmAction'),
                    style: 'destructive',
                    onPress: () => runEndConnection(connectionId),
                },
            ]
        );
    }

    async function runEndConnection(connectionId: string) {
        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        setBusyConnectionId(connectionId);
        const result = await endConnection(connectionId);
        setBusyConnectionId(null);

        if (!result.ok) {
            showAlertOnce(t('participants.actionErrorTitle'), t(CONNECTION_ERROR_TRANSLATION_KEYS[result.kind]));
            return;
        }
        await load(true);
    }

    function manageParticipant(p: ParticipantSummary) {
        showAlertOnce(
            p.recipientName || participantRoleLabel,
            undefined,
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('participants.endConnectionAction'),
                    style: 'destructive',
                    onPress: () => confirmEndConnection(p.connectionId, p.recipientName || participantRoleLabel),
                },
            ]
        );
    }

    async function shareCode(code: string) {
        const result = await Share.share({ message: t('inviteParticipant.shareMessage', { code }) });
        if (result.action === Share.sharedAction) {
            announceStateChange(t('inviteParticipant.shareSuccessAnnouncement'));
        }
    }

    async function replaceCode(connectionId: string) {
        setBusyConnectionId(connectionId);
        const { error } = await supabase.rpc('create_invite_code', { p_existing_connection_id: connectionId });
        setBusyConnectionId(null);
        if (error) {
            showAlertOnce(t('inviteParticipant.saveErrorTitle'), t('inviteParticipant.saveErrorMessage'));
            return;
        }
        await load(true);
    }

    function confirmRevoke(connectionId: string) {
        showAlertOnce(
            t('participants.revokeConfirmTitle'),
            t('participants.revokeConfirmMessage'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                { text: t('participants.revokeConfirmAction'), style: 'destructive', onPress: () => runEndConnection(connectionId) },
            ]
        );
    }

    return (
        <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
            <View style={styles.header}>
                <TouchableOpacity
                    style={styles.backButton}
                    onPress={() => router.back()}
                    hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                    accessibilityRole="button"
                    accessibilityLabel={t('participants.back')}
                >
                    <Ionicons name="chevron-back" size={22} color={C.primary} />
                    <Text style={styles.backText}>{t('participants.back')}</Text>
                </TouchableOpacity>
                <Text style={styles.heading} accessibilityRole="header">{t('participants.title')}</Text>
                <Text style={styles.countText}>
                    {t('inviteParticipant.participantsOfLimit', { count: slotsUsed, limit: MAX_STANDARD_PARTICIPANTS })}
                </Text>
            </View>

            <ScrollView
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator={false}
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={C.primary} colors={[C.primary]} />}
            >
                {!loading && !errored && active.length > 0 && (
                    // Deliberately limited to counts that are always
                    // accurate with zero extra queries (participant count,
                    // total active reminders — already fetched above).
                    // True daily taken/missed/pending totals across every
                    // participant would need re-deriving each participant's
                    // OWN recipient-timezone-aware status independently
                    // (see docs/reminder-state-model.md) for every
                    // participant at once — deferred rather than risk a
                    // second, subtly-divergent status computation living
                    // alongside caregiver-dashboard.tsx's proven one. See
                    // docs/participant-management-model.md.
                    <View style={[styles.overviewCard, SHADOW.xs]}>
                        <View style={styles.overviewStat}>
                            <Text style={styles.overviewNumber}>{active.length}</Text>
                            <Text style={styles.overviewLabel}>
                                {t('organizerDashboard.allParticipantsActiveCount', { n: active.length, plural: active.length === 1 ? '' : 's' })}
                            </Text>
                        </View>
                        <View style={styles.overviewDivider} />
                        <View style={styles.overviewStat}>
                            <Text style={styles.overviewNumber}>
                                {Object.values(reminderCounts).reduce((sum, n) => sum + n, 0)}
                            </Text>
                            <Text style={styles.overviewLabel}>{t('participants.totalActiveReminders')}</Text>
                        </View>
                    </View>
                )}

                {loading ? (
                    <View style={[styles.stateCard, SHADOW.xs]}>
                        <ActivityIndicator color={C.primary} />
                        <Text style={styles.stateText}>{t('participants.loading')}</Text>
                    </View>
                ) : errored && active.length === 0 && pending.length === 0 ? (
                    // Nothing to preserve — full error card, same as before.
                    <View style={[styles.stateCard, SHADOW.xs]}>
                        <Ionicons name="alert-circle-outline" size={28} color={C.textMuted} />
                        <Text style={styles.stateTitle}>{t('participants.errorTitle')}</Text>
                        <Text style={styles.stateText}>
                            {errorCategory ? t(ERROR_CATEGORY_TRANSLATION_KEYS[errorCategory]) : t('participants.errorText')}
                        </Text>
                        <TouchableOpacity style={styles.retryButton} onPress={() => load(false)} accessibilityRole="button" accessibilityLabel={t('participants.retry')}>
                            <Text style={styles.retryButtonText}>{t('participants.retry')}</Text>
                        </TouchableOpacity>
                    </View>
                ) : active.length === 0 && pending.length === 0 ? (
                    <View style={[styles.stateCard, SHADOW.xs]}>
                        <View style={styles.stateIconWrap}>
                            <Ionicons name="people-outline" size={26} color={C.primary} />
                        </View>
                        <Text style={styles.stateTitle}>{t('participants.emptyTitle')}</Text>
                        <Text style={styles.stateText}>{t('participants.emptyText')}</Text>
                        <TouchableOpacity
                            style={[styles.primaryButton, SHADOW.primary]}
                            onPress={() => router.push('/invite-recipient')}
                            accessibilityRole="button"
                            accessibilityLabel={t('participants.inviteFirst')}
                        >
                            <Text style={styles.primaryButtonText}>{t('participants.inviteFirst')}</Text>
                        </TouchableOpacity>
                    </View>
                ) : (
                    <>
                        {errored && errorCategory === 'network' ? (
                            <OfflineBanner />
                        ) : errored ? (
                            <SectionErrorState
                                text={errorCategory ? t(ERROR_CATEGORY_TRANSLATION_KEYS[errorCategory]) : t('participants.errorText')}
                                onRetry={() => load(false)}
                                retrying={refreshing}
                            />
                        ) : null}
                        {active.length > 0 && (
                            <>
                                <Text style={styles.sectionLabel}>{t('participants.activeSection')}</Text>
                                {active.map((p) => {
                                    const busy = busyConnectionId === p.connectionId;
                                    const count = reminderCounts[p.connectionId] ?? 0;
                                    return (
                                        <View key={p.connectionId} style={[styles.card, SHADOW.xs]}>
                                            <TouchableOpacity
                                                style={styles.cardMain}
                                                onPress={() => openParticipant(p.connectionId)}
                                                activeOpacity={0.75}
                                                accessibilityRole="button"
                                                accessibilityLabel={`${p.recipientName || participantRoleLabel}, ${t('participants.activeReminderCount', { n: count, plural: count === 1 ? '' : 's' })}`}
                                                accessibilityHint={t('participants.openHint')}
                                            >
                                                <View style={styles.avatar}>
                                                    <Text style={styles.avatarText}>{(p.recipientName || '?').charAt(0).toUpperCase()}</Text>
                                                </View>
                                                <View style={styles.cardBody}>
                                                    <Text style={styles.cardName} numberOfLines={1}>{p.recipientName || participantRoleLabel}</Text>
                                                    <Text style={styles.cardMeta} numberOfLines={1}>
                                                        {participantRoleLabel} · {t('participants.activeReminderCount', { n: count, plural: count === 1 ? '' : 's' })}
                                                    </Text>
                                                </View>
                                                <Ionicons name="chevron-forward" size={18} color={C.textMuted} />
                                            </TouchableOpacity>
                                            <View style={styles.cardActions}>
                                                <TouchableOpacity
                                                    style={styles.cardActionButton}
                                                    onPress={() => createReminderFor(p.connectionId)}
                                                    accessibilityRole="button"
                                                    accessibilityLabel={t('participants.createReminderAction')}
                                                >
                                                    <Ionicons name="add-circle-outline" size={16} color={C.primary} />
                                                    <Text style={styles.cardActionText}>{t('participants.createReminderAction')}</Text>
                                                </TouchableOpacity>
                                                <TouchableOpacity
                                                    style={styles.cardActionButton}
                                                    onPress={() => assignRoutineFor(p.connectionId)}
                                                    accessibilityRole="button"
                                                    accessibilityLabel={t('participants.assignRoutineAction')}
                                                >
                                                    <Ionicons name="albums-outline" size={16} color={C.primary} />
                                                    <Text style={styles.cardActionText}>{t('participants.assignRoutineAction')}</Text>
                                                </TouchableOpacity>
                                                <TouchableOpacity
                                                    style={styles.cardActionButton}
                                                    onPress={() => manageParticipant(p)}
                                                    disabled={busy}
                                                    accessibilityRole="button"
                                                    accessibilityLabel={t('participants.manageAction')}
                                                    accessibilityState={{ disabled: busy, busy }}
                                                >
                                                    {busy ? (
                                                        <ActivityIndicator size="small" color={C.textMuted} />
                                                    ) : (
                                                        <>
                                                            <Ionicons name="ellipsis-horizontal-circle-outline" size={16} color={C.textMuted} />
                                                            <Text style={styles.cardActionTextMuted}>{t('participants.manageAction')}</Text>
                                                        </>
                                                    )}
                                                </TouchableOpacity>
                                            </View>
                                        </View>
                                    );
                                })}
                            </>
                        )}

                        {pending.length > 0 && (
                            <>
                                <Text style={styles.sectionLabel}>{t('participants.pendingSection')}</Text>
                                {pending.map((invite) => {
                                    const busy = busyConnectionId === invite.connectionId;
                                    return (
                                        <View key={invite.connectionId} style={[styles.card, SHADOW.xs]}>
                                            <View style={styles.pendingRow}>
                                                <View style={styles.pendingCodeWrap}>
                                                    <Text style={styles.pendingCode}>{invite.inviteCode}</Text>
                                                    <Text style={styles.cardMeta}>
                                                        {invite.expiresAt
                                                            ? t('inviteParticipant.expiresOn', { date: new Date(invite.expiresAt).toLocaleDateString() })
                                                            : t('participants.waitingStatus')}
                                                    </Text>
                                                </View>
                                                <View style={styles.waitingBadge}>
                                                    <Ionicons name="time-outline" size={12} color={C.textMuted} />
                                                    <Text style={styles.waitingBadgeText}>{t('inviteParticipant.waitingBadge')}</Text>
                                                </View>
                                            </View>
                                            <View style={styles.cardActions}>
                                                <TouchableOpacity
                                                    style={styles.cardActionButton}
                                                    onPress={() => shareCode(invite.inviteCode)}
                                                    accessibilityRole="button"
                                                    accessibilityLabel={t('inviteParticipant.share')}
                                                >
                                                    <Ionicons name="share-social-outline" size={16} color={C.primary} />
                                                    <Text style={styles.cardActionText}>{t('inviteParticipant.share')}</Text>
                                                </TouchableOpacity>
                                                <TouchableOpacity
                                                    style={styles.cardActionButton}
                                                    onPress={() => replaceCode(invite.connectionId)}
                                                    disabled={busy}
                                                    accessibilityRole="button"
                                                    accessibilityLabel={t('participants.replaceCodeAction')}
                                                    accessibilityState={{ disabled: busy, busy }}
                                                >
                                                    {busy ? <ActivityIndicator size="small" color={C.textMuted} /> : (
                                                        <>
                                                            <Ionicons name="refresh-outline" size={16} color={C.textMuted} />
                                                            <Text style={styles.cardActionTextMuted}>{t('participants.replaceCodeAction')}</Text>
                                                        </>
                                                    )}
                                                </TouchableOpacity>
                                                <TouchableOpacity
                                                    style={styles.cardActionButton}
                                                    onPress={() => confirmRevoke(invite.connectionId)}
                                                    disabled={busy}
                                                    accessibilityRole="button"
                                                    accessibilityLabel={t('participants.revokeAction')}
                                                    accessibilityState={{ disabled: busy, busy }}
                                                >
                                                    <Ionicons name="close-circle-outline" size={16} color={C.error} />
                                                    <Text style={styles.cardActionTextDanger}>{t('participants.revokeAction')}</Text>
                                                </TouchableOpacity>
                                            </View>
                                        </View>
                                    );
                                })}
                            </>
                        )}

                        <TouchableOpacity
                            style={[styles.addButton, atStandardLimit && styles.addButtonDisabled]}
                            onPress={() => router.push('/invite-recipient')}
                            activeOpacity={0.85}
                            accessibilityRole="button"
                            accessibilityLabel={atStandardLimit ? t('inviteParticipant.limitReachedTitle') : t('participants.addAction')}
                        >
                            <Ionicons name={atStandardLimit ? 'lock-closed-outline' : 'person-add-outline'} size={18} color={atStandardLimit ? C.textMuted : C.primary} />
                            <Text style={[styles.addButtonText, atStandardLimit && styles.addButtonTextDisabled]}>
                                {atStandardLimit ? t('inviteParticipant.limitReachedTitle') : t('participants.addAction')}
                            </Text>
                        </TouchableOpacity>
                    </>
                )}
            </ScrollView>
        </SafeAreaView>
    );
}

const createStyles = (C: ThemeColors) => StyleSheet.create({
    container: { flex: 1, backgroundColor: C.bgPage },
    header: { paddingHorizontal: 24, paddingTop: 8, paddingBottom: 16 },
    backButton: { flexDirection: 'row', alignItems: 'center', marginBottom: 16, alignSelf: 'flex-start' },
    backText: { fontSize: 16, fontWeight: '600', color: C.primary, marginLeft: 2 },
    heading: { fontSize: 28, fontWeight: '800', color: C.textPrimary, letterSpacing: -0.6, marginBottom: 6 },
    countText: { fontSize: 14, color: C.textMuted, fontWeight: '600' },

    scrollContent: { paddingHorizontal: 24, paddingBottom: 40 },

    stateCard: { backgroundColor: C.bgSurface, borderRadius: RADIUS.xl, padding: 28, alignItems: 'center', marginTop: 12 },
    stateIconWrap: { width: 52, height: 52, borderRadius: RADIUS.lg, backgroundColor: C.primaryLight, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
    stateTitle: { fontSize: 17, fontWeight: '700', color: C.textPrimary, marginBottom: 6, textAlign: 'center' },
    stateText: { fontSize: 14, color: C.textSecondary, textAlign: 'center', lineHeight: 20, marginTop: 8 },
    retryButton: { marginTop: 16, paddingVertical: 10, paddingHorizontal: 20, borderRadius: RADIUS.lg, backgroundColor: C.bgAlt, minHeight: 44, justifyContent: 'center' },
    retryButtonText: { fontSize: 14, fontWeight: '700', color: C.textPrimary },
    primaryButton: { marginTop: 18, backgroundColor: C.primary, paddingVertical: 14, paddingHorizontal: 24, borderRadius: RADIUS.xl, minHeight: 44, justifyContent: 'center' },
    primaryButtonText: { color: C.textInverse, fontSize: 15, fontWeight: '700' },

    overviewCard: { flexDirection: 'row', backgroundColor: C.bgSurface, borderRadius: RADIUS.xl, padding: 18, marginTop: 12, alignItems: 'center' },
    overviewStat: { flex: 1, alignItems: 'center' },
    overviewNumber: { fontSize: 24, fontWeight: '800', color: C.textPrimary, marginBottom: 2 },
    overviewLabel: { fontSize: 12, color: C.textMuted, fontWeight: '600', textAlign: 'center' },
    overviewDivider: { width: 1, height: 32, backgroundColor: C.border },

    sectionLabel: { fontSize: 12, fontWeight: '700', color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 20, marginBottom: 10 },

    card: { backgroundColor: C.bgSurface, borderRadius: RADIUS.xl, marginBottom: 12, borderWidth: 1, borderColor: C.border, overflow: 'hidden' },
    cardMain: { flexDirection: 'row', alignItems: 'center', padding: 16, gap: 12, minHeight: 44 },
    avatar: { width: 44, height: 44, borderRadius: RADIUS.full, backgroundColor: C.primaryLight, alignItems: 'center', justifyContent: 'center' },
    avatarText: { fontSize: 17, fontWeight: '700', color: C.primary },
    cardBody: { flex: 1 },
    cardName: { fontSize: 16, fontWeight: '700', color: C.textPrimary, marginBottom: 3 },
    cardMeta: { fontSize: 13, color: C.textMuted },
    cardActions: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: C.border },
    cardActionButton: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, minHeight: 44 },
    cardActionText: { fontSize: 13, fontWeight: '700', color: C.primary },
    cardActionTextMuted: { fontSize: 13, fontWeight: '600', color: C.textMuted },
    cardActionTextDanger: { fontSize: 13, fontWeight: '700', color: C.error },

    pendingRow: { flexDirection: 'row', alignItems: 'center', padding: 16, gap: 12 },
    pendingCodeWrap: { flex: 1 },
    pendingCode: { fontSize: 20, fontWeight: '800', letterSpacing: 3, color: C.textPrimary, fontVariant: ['tabular-nums'], marginBottom: 4 },
    waitingBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: C.bgAlt, borderRadius: RADIUS.full, paddingVertical: 5, paddingHorizontal: 10 },
    waitingBadgeText: { fontSize: 11, fontWeight: '600', color: C.textMuted },

    addButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderWidth: 1.5, borderColor: C.primary, borderRadius: RADIUS.xl, paddingVertical: 14, marginTop: 8, minHeight: 44 },
    addButtonDisabled: { borderColor: C.border },
    addButtonText: { fontSize: 15, fontWeight: '700', color: C.primary },
    addButtonTextDisabled: { color: C.textMuted },
});
