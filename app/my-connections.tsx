// Participant-facing screen listing every accepted organizer connection
// separately (Week 4 Task #2, Phase 3). Each connection is rendered as its
// own independent card with its own counts, its own "View activity" link
// (reusing the existing connection-scoped Activity feed), and its own "End
// Connection" action (reusing the existing end_connection RPC) -- ending
// one never affects another, and none of this ever merges organizers into
// one combined view. Backed by the single get_my_organizer_connections_summary()
// RPC (auth.uid()-derived server-side; no participant-id route parameter to
// tamper with).
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { OfflineBanner, SectionErrorState, announceStateChange } from '@/components/StateViews';
import { RADIUS, SHADOW, ThemeColors } from '@/constants/theme';
import { ErrorCategory, classifyScreenError } from '@/lib/asyncStateCore';
import { CONNECTION_ERROR_TRANSLATION_KEYS } from '@/lib/connectionErrors';
import { endConnection } from '@/lib/connections';
import { ERROR_CATEGORY_TRANSLATION_KEYS } from '@/lib/errorClassification';
import { useTranslation } from '@/lib/i18n/context';
import { resolveOrganizerDisplay } from '@/lib/organizerDisplay';
import { getRelationshipDefinition } from '@/lib/relationshipCore';
import { useThemeColors } from '@/lib/theme';
import { useRequestGeneration } from '@/lib/useRequestGeneration';
import { supabase } from '@/lib/supabase';
import { showAlertOnce } from '@/lib/alertGuard';

type OrganizerConnectionSummary = {
    connection_id: string;
    status: string;
    accepted_at: string | null;
    organizer_id: string;
    organizer_full_name: string | null;
    organizer_account_status: string | null;
    organizer_deleted_at: string | null;
    relationship_pair: string | null;
    active_reminder_count: number;
    active_task_count: number;
    active_routine_count: number;
};

export default function MyConnectionsScreen() {
    const C = useThemeColors();
    const t = useTranslation();
    const styles = useMemo(() => createStyles(C), [C]);

    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [errored, setErrored] = useState(false);
    const [errorCategory, setErrorCategory] = useState<ErrorCategory | null>(null);
    const [connections, setConnections] = useState<OrganizerConnectionSummary[]>([]);
    const [busyConnectionId, setBusyConnectionId] = useState<string | null>(null);
    const hasLoadedOnceRef = useRef(false);
    const erroredRef = useRef(false);
    const { start: startLoad, isCurrent: isLoadCurrent } = useRequestGeneration();

    const load = useCallback(async (isRefresh: boolean) => {
        const generation = startLoad();
        const wasRecoveringFromError = erroredRef.current;
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

        const { data, error } = await supabase.rpc('get_my_organizer_connections_summary');
        if (!isLoadCurrent(generation)) return;

        if (error) {
            setErrored(true);
            setErrorCategory(classifyScreenError(error.message));
        } else {
            // Only currently-accepted connections are actionable here --
            // an ended connection's history remains fully visible in
            // Activity, but this screen manages live connections only.
            const rows = ((data ?? []) as OrganizerConnectionSummary[]).filter((r) => r.status === 'accepted');
            setConnections(rows);
            if (wasRecoveringFromError) announceStateChange(t('stateViews.backToNormal'));
        }

        setLoading(false);
        setRefreshing(false);
        hasLoadedOnceRef.current = true;
        erroredRef.current = !!error;
    }, [startLoad, isLoadCurrent, t]);

    useFocusEffect(useCallback(() => { load(false); }, [load]));

    function openActivity(connectionId: string) {
        router.push({ pathname: '/activity', params: { connectionId } });
    }

    async function runEndConnection(connectionId: string) {
        setBusyConnectionId(connectionId);
        const result = await endConnection(connectionId);
        setBusyConnectionId(null);

        if (!result.ok) {
            showAlertOnce(t('participants.actionErrorTitle'), t(CONNECTION_ERROR_TRANSLATION_KEYS[result.kind]));
            return;
        }
        // Re-fetch from the single source of truth rather than locally
        // patching/removing the row -- never risk a stale count.
        await load(true);
    }

    function confirmEndConnection(connectionId: string, name: string) {
        showAlertOnce(
            t('participants.endConnectionConfirmTitle'),
            t('participants.endConnectionConfirmMessage', { name }),
            [
                { text: t('common.cancel'), style: 'cancel' },
                { text: t('participants.endConnectionConfirmAction'), style: 'destructive', onPress: () => runEndConnection(connectionId) },
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
                    accessibilityLabel={t('myConnections.back')}
                >
                    <Ionicons name="chevron-back" size={22} color={C.primary} />
                    <Text style={styles.backText}>{t('myConnections.back')}</Text>
                </TouchableOpacity>
                <Text style={styles.heading} accessibilityRole="header">{t('myConnections.title')}</Text>
            </View>

            <ScrollView
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator={false}
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={C.primary} colors={[C.primary]} />}
            >
                {loading ? (
                    <View style={[styles.stateCard, SHADOW.xs]}>
                        <ActivityIndicator color={C.primary} />
                        <Text style={styles.stateText}>{t('myConnections.loading')}</Text>
                    </View>
                ) : errored && connections.length === 0 ? (
                    <View style={[styles.stateCard, SHADOW.xs]}>
                        <Ionicons name="alert-circle-outline" size={28} color={C.textMuted} />
                        <Text style={styles.stateTitle}>{t('myConnections.errorTitle')}</Text>
                        <Text style={styles.stateText}>
                            {errorCategory ? t(ERROR_CATEGORY_TRANSLATION_KEYS[errorCategory]) : t('participants.errorText')}
                        </Text>
                        <TouchableOpacity style={styles.retryButton} onPress={() => load(false)} accessibilityRole="button" accessibilityLabel={t('myConnections.retry')}>
                            <Text style={styles.retryButtonText}>{t('myConnections.retry')}</Text>
                        </TouchableOpacity>
                    </View>
                ) : connections.length === 0 ? (
                    <View style={[styles.stateCard, SHADOW.xs]}>
                        <View style={styles.stateIconWrap}>
                            <Ionicons name="people-outline" size={26} color={C.primary} />
                        </View>
                        <Text style={styles.stateTitle}>{t('myConnections.emptyTitle')}</Text>
                        <Text style={styles.stateText}>{t('myConnections.emptyText')}</Text>
                    </View>
                ) : (
                    <>
                        {errored ? (
                            errorCategory === 'network' ? (
                                <OfflineBanner />
                            ) : (
                                <SectionErrorState
                                    text={errorCategory ? t(ERROR_CATEGORY_TRANSLATION_KEYS[errorCategory]) : t('participants.errorText')}
                                    onRetry={() => load(false)}
                                    retrying={refreshing}
                                />
                            )
                        ) : null}
                        {connections.map((conn) => {
                            const busy = busyConnectionId === conn.connection_id;
                            const organizer = resolveOrganizerDisplay(conn.organizer_id, {
                                full_name: conn.organizer_full_name,
                                account_status: conn.organizer_account_status,
                                deleted_at: conn.organizer_deleted_at,
                            }, t);
                            const reminderN = conn.active_reminder_count;
                            const taskN = conn.active_task_count;
                            const routineN = conn.active_routine_count;
                            // relationship_pair is the truth about THIS
                            // connection; a NULL value must fall back to the
                            // neutral 'common.organizer' noun, never any
                            // profile-level use_case default -- the same
                            // participant could plausibly be a different
                            // relationship to a different organizer, and
                            // no organizer profile signal is authoritative
                            // for what THIS specific connection is.
                            const relDef = getRelationshipDefinition(conn.relationship_pair);
                            return (
                                <View key={conn.connection_id} style={[styles.card, SHADOW.xs]}>
                                    <View style={styles.cardMain}>
                                        <View style={styles.avatar}>
                                            <Text style={styles.avatarText}>{organizer.displayName.charAt(0).toUpperCase()}</Text>
                                        </View>
                                        <View style={styles.cardBody}>
                                            <Text style={styles.cardName} numberOfLines={1}>{organizer.displayName}</Text>
                                            <Text style={styles.cardMeta} numberOfLines={1}>
                                                {relDef ? t(relDef.organizerLabelKey) : t('common.organizer')}
                                            </Text>
                                            {conn.accepted_at ? (
                                                <Text style={styles.cardMeta} numberOfLines={1}>
                                                    {t('myConnections.connectedSince', { date: new Date(conn.accepted_at).toLocaleDateString() })}
                                                </Text>
                                            ) : null}
                                            <Text style={styles.cardCounts} numberOfLines={1}>
                                                {t('myConnections.reminderCount', { n: reminderN, plural: reminderN === 1 ? '' : 's' })}
                                                {' · '}
                                                {t('myConnections.taskCount', { n: taskN, plural: taskN === 1 ? '' : 's' })}
                                                {' · '}
                                                {t('myConnections.routineCount', { n: routineN, plural: routineN === 1 ? '' : 's' })}
                                            </Text>
                                        </View>
                                    </View>
                                    <View style={styles.cardActions}>
                                        <TouchableOpacity
                                            style={styles.cardActionButton}
                                            onPress={() => openActivity(conn.connection_id)}
                                            accessibilityRole="button"
                                            accessibilityLabel={t('myConnections.openActivityAction')}
                                            accessibilityHint={t('myConnections.openActivityHint')}
                                        >
                                            <Ionicons name="time-outline" size={16} color={C.primary} />
                                            <Text style={styles.cardActionText}>{t('myConnections.openActivityAction')}</Text>
                                        </TouchableOpacity>
                                        <TouchableOpacity
                                            style={styles.cardActionButton}
                                            onPress={() => confirmEndConnection(conn.connection_id, organizer.displayName)}
                                            disabled={busy}
                                            accessibilityRole="button"
                                            accessibilityLabel={t('participants.endConnectionAction')}
                                            accessibilityHint={t('myConnections.endConnectionHint')}
                                            accessibilityState={{ disabled: busy, busy }}
                                        >
                                            {busy ? (
                                                <ActivityIndicator size="small" color={C.textMuted} />
                                            ) : (
                                                <>
                                                    <Ionicons name="close-circle-outline" size={16} color={C.error} />
                                                    <Text style={styles.cardActionTextDanger}>{t('participants.endConnectionAction')}</Text>
                                                </>
                                            )}
                                        </TouchableOpacity>
                                    </View>
                                </View>
                            );
                        })}
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
    heading: { fontSize: 28, fontWeight: '800', color: C.textPrimary, letterSpacing: -0.6 },

    scrollContent: { paddingHorizontal: 24, paddingBottom: 40 },

    stateCard: { backgroundColor: C.bgSurface, borderRadius: RADIUS.xl, padding: 28, alignItems: 'center', marginTop: 12 },
    stateIconWrap: { width: 52, height: 52, borderRadius: RADIUS.lg, backgroundColor: C.primaryLight, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
    stateTitle: { fontSize: 17, fontWeight: '700', color: C.textPrimary, marginBottom: 6, textAlign: 'center' },
    stateText: { fontSize: 14, color: C.textSecondary, textAlign: 'center', lineHeight: 20, marginTop: 8 },
    retryButton: { marginTop: 16, paddingVertical: 10, paddingHorizontal: 20, borderRadius: RADIUS.lg, backgroundColor: C.bgAlt, minHeight: 44, justifyContent: 'center' },
    retryButtonText: { fontSize: 14, fontWeight: '700', color: C.textPrimary },

    card: { backgroundColor: C.bgSurface, borderRadius: RADIUS.xl, marginBottom: 12, borderWidth: 1, borderColor: C.border, overflow: 'hidden' },
    cardMain: { flexDirection: 'row', alignItems: 'center', padding: 16, gap: 12, minHeight: 44 },
    avatar: { width: 44, height: 44, borderRadius: RADIUS.full, backgroundColor: C.primaryLight, alignItems: 'center', justifyContent: 'center' },
    avatarText: { fontSize: 17, fontWeight: '700', color: C.primary },
    cardBody: { flex: 1 },
    cardName: { fontSize: 16, fontWeight: '700', color: C.textPrimary, marginBottom: 3 },
    cardMeta: { fontSize: 13, color: C.textMuted, marginBottom: 3 },
    cardCounts: { fontSize: 13, color: C.textMuted },
    cardActions: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: C.border },
    cardActionButton: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, minHeight: 44 },
    cardActionText: { fontSize: 13, fontWeight: '700', color: C.primary },
    cardActionTextDanger: { fontSize: 13, fontWeight: '700', color: C.error },
});
