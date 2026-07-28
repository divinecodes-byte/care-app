// Cross-object (reminder + task) activity timeline — Week 3 product-
// expansion task #2. One screen, two modes:
//   - params.connectionId present  -> organizer viewing one selected
//     participant's activity (or a participant viewing one specific
//     connection), via get_connection_activity_feed.
//   - no connectionId param        -> the calling participant's own
//     aggregate activity across every organizer, via
//     get_participant_activity_feed.
// Mirrors app/tasks.tsx's role-adaptive single-screen pattern from Week 3
// task #1.
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AccessibleIconButton, SelectionCard, StatusBadge, StatusTone } from '@/components/AccessiblePrimitives';
import { formatDateStringForDisplay } from '@/components/DatePickerField';
import { EmptyState, ErrorState, OfflineBanner, ScreenLoadingState, SectionErrorState } from '@/components/StateViews';
import { RADIUS, SHADOW, ThemeColors } from '@/constants/theme';
import { ActivityEvent, ActivityRow, activityEventKey, mergeActivityPages, normalizeActivityRows } from '@/lib/activityFeedCore';
import { classifyScreenError } from '@/lib/asyncStateCore';
import { useTranslation } from '@/lib/i18n/context';
import { supabase } from '@/lib/supabase';
import { useThemeColors } from '@/lib/theme';

type SourceFilter = 'all' | 'reminder' | 'task';
type OutcomeFilter = 'all' | 'completed' | 'skipped' | 'missed';
const PAGE_SIZE = 20;

const OUTCOME_TONE: Record<string, StatusTone> = {
    taken: 'success',
    completed_on_time: 'success',
    completed_late: 'warning',
    skipped: 'error',
    missed: 'error',
};

export default function ActivityScreen() {
    const C = useThemeColors();
    const t = useTranslation();
    const styles = useMemo(() => createStyles(C), [C]);
    const { connectionId } = useLocalSearchParams<{ connectionId?: string }>();
    const isConnectionScoped = !!connectionId;

    const [events, setEvents] = useState<ActivityEvent[]>([]);
    const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
    const [loadingMore, setLoadingMore] = useState(false);
    const [loadMoreError, setLoadMoreError] = useState(false);
    const [hasMore, setHasMore] = useState(true);
    const [offline, setOffline] = useState(false);
    const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
    const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>('all');
    const [participantName, setParticipantName] = useState('');
    const [connectionEnded, setConnectionEnded] = useState(false);

    // Guards a filter change or refresh from having an in-flight page
    // request land after a newer one — the classic "stale response
    // overwrites current view" bug, here specifically for pagination.
    const requestIdRef = useRef(0);

    const labels = useMemo(() => ({
        reminderTaken: t('activityFeed.outcomeTaken'),
        reminderSkipped: t('activityFeed.outcomeSkipped'),
        reminderMissed: t('activityFeed.outcomeMissed'),
        taskCompletedOnTime: t('activityFeed.outcomeCompletedOnTime'),
        taskCompletedLate: t('activityFeed.outcomeCompletedLate'),
        taskSkipped: t('activityFeed.outcomeTaskSkipped'),
        unknownOrganizer: t('activityFeed.formerOrganizer'),
        summaryTemplate: (vars: { title: string; outcome: string; date: string; organizer: string }) =>
            t('activityFeed.accessibleSummary', vars),
    }), [t]);

    function matchesOutcomeFilter(event: ActivityEvent, filter: OutcomeFilter): boolean {
        if (filter === 'all') return true;
        if (filter === 'completed') return event.outcome === 'taken' || event.outcome === 'completed_on_time' || event.outcome === 'completed_late';
        if (filter === 'skipped') return event.outcome === 'skipped';
        if (filter === 'missed') return event.outcome === 'missed';
        return true;
    }

    const fetchPage = useCallback(async (before: ActivityEvent['cursor'] | null): Promise<{ rows: ActivityRow[]; error?: string }> => {
        const rpcArgs = isConnectionScoped
            ? {
                p_connection_id: connectionId,
                p_before_timestamp: before?.eventTimestamp ?? null,
                p_before_source: before?.sourceKind ?? null,
                p_before_id: before?.sourceId ?? null,
                p_limit: PAGE_SIZE,
                p_source_filter: sourceFilter,
            }
            : {
                p_before_timestamp: before?.eventTimestamp ?? null,
                p_before_source: before?.sourceKind ?? null,
                p_before_id: before?.sourceId ?? null,
                p_limit: PAGE_SIZE,
                p_source_filter: sourceFilter,
            };
        const fnName = isConnectionScoped ? 'get_connection_activity_feed' : 'get_participant_activity_feed';
        const { data, error } = await supabase.rpc(fnName, rpcArgs as any);
        if (error) return { rows: [], error: error.message };
        return { rows: (data ?? []) as ActivityRow[] };
    }, [connectionId, isConnectionScoped, sourceFilter]);

    const loadFirstPage = useCallback(async () => {
        const requestId = ++requestIdRef.current;
        setStatus('loading');
        setLoadMoreError(false);

        if (isConnectionScoped) {
            const { data: connection } = await supabase.from('connections').select('caregiver_id, recipient_id, status').eq('id', connectionId).maybeSingle();
            if (requestIdRef.current !== requestId) return;
            if (!connection) { setStatus('error'); return; }
            setConnectionEnded(connection.status !== 'accepted');
            const { data: { user } } = await supabase.auth.getUser();
            const otherId = connection.caregiver_id === user?.id ? connection.recipient_id : connection.caregiver_id;
            const { data: profile } = await supabase.from('profiles').select('full_name').eq('id', otherId).maybeSingle();
            if (requestIdRef.current !== requestId) return;
            setParticipantName(profile?.full_name || t('activityFeed.formerParticipant'));
        }

        const { rows, error } = await fetchPage(null);
        if (requestIdRef.current !== requestId) return;

        if (error) {
            setOffline(classifyScreenError(error) === 'network');
            setStatus('error');
            return;
        }
        const normalized = normalizeActivityRows(rows, labels).filter((e) => matchesOutcomeFilter(e, outcomeFilter));
        setEvents(normalized);
        setHasMore(rows.length === PAGE_SIZE);
        setOffline(false);
        setStatus('ready');
    }, [connectionId, isConnectionScoped, fetchPage, labels, outcomeFilter, t]);

    useEffect(() => { loadFirstPage(); }, [loadFirstPage]);

    async function loadMore() {
        if (loadingMore || !hasMore || events.length === 0) return;
        const requestId = requestIdRef.current;
        setLoadingMore(true);
        setLoadMoreError(false);
        const lastEvent = events[events.length - 1];
        const { rows, error } = await fetchPage(lastEvent.cursor);
        if (requestIdRef.current !== requestId) { setLoadingMore(false); return; }

        setLoadingMore(false);
        if (error) { setLoadMoreError(true); return; }

        const normalized = normalizeActivityRows(rows, labels).filter((e) => matchesOutcomeFilter(e, outcomeFilter));
        setEvents((current) => mergeActivityPages(current, normalized));
        setHasMore(rows.length === PAGE_SIZE);
    }

    const heading = isConnectionScoped
        ? (participantName ? `${t('activityFeed.organizerHeading')} · ${participantName}` : t('activityFeed.organizerHeading'))
        : t('activityFeed.myActivityHeading');

    if (status === 'loading') {
        return (
            <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
                <ScreenLoadingState label={t('activityFeed.loadingActivity')} />
            </SafeAreaView>
        );
    }

    if (status === 'error') {
        return (
            <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
                {offline ? (
                    <View style={{ padding: 20 }}>
                        <OfflineBanner />
                        <ErrorState title={t('activityFeed.loadFailedTitle')} text={t('activityFeed.offlineText')} onRetry={loadFirstPage} />
                    </View>
                ) : (
                    <ErrorState title={t('activityFeed.loadFailedTitle')} text={t('activityFeed.loadFailedText')} onRetry={loadFirstPage} />
                )}
            </SafeAreaView>
        );
    }

    const filteredEvents = events;

    return (
        <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
            <View style={styles.header}>
                <AccessibleIconButton icon="arrow-back" label={t('common.back')} onPress={() => router.back()} />
                <Text style={styles.headerTitle} accessibilityRole="header" numberOfLines={1}>{heading}</Text>
                <View style={{ width: 44 }} />
            </View>

            <View style={styles.filterRow}>
                {(['all', 'reminder', 'task'] as SourceFilter[]).map((f) => (
                    <SelectionCard
                        key={f}
                        label={t(`activityFeed.filter${f === 'all' ? 'All' : f === 'reminder' ? 'Reminders' : 'Tasks'}`)}
                        selected={sourceFilter === f}
                        onPress={() => setSourceFilter(f)}
                        compact
                    />
                ))}
                {(['completed', 'skipped', 'missed'] as OutcomeFilter[]).map((f) => (
                    <SelectionCard
                        key={f}
                        label={t(`activityFeed.filter${f.charAt(0).toUpperCase()}${f.slice(1)}`)}
                        selected={outcomeFilter === f}
                        onPress={() => setOutcomeFilter((current) => (current === f ? 'all' : f))}
                        compact
                    />
                ))}
            </View>

            {connectionEnded ? (
                <View style={styles.noticeBar}>
                    <Text style={styles.noticeText}>{t('activityFeed.connectionEndedNotice')}</Text>
                </View>
            ) : null}

            {filteredEvents.length === 0 ? (
                <EmptyState
                    icon="time-outline"
                    title={sourceFilter !== 'all' || outcomeFilter !== 'all' ? t('activityFeed.noMatchingFilterTitle') : t('activityFeed.noHistoryTitle')}
                    text={sourceFilter !== 'all' || outcomeFilter !== 'all' ? t('activityFeed.noMatchingFilterText') : t('activityFeed.noHistoryText')}
                />
            ) : (
                <FlatList
                    data={filteredEvents}
                    keyExtractor={activityEventKey}
                    renderItem={({ item }) => <ActivityEventCard event={item} C={C} t={t} styles={styles} showOrganizer={!isConnectionScoped} />}
                    onEndReachedThreshold={0.4}
                    onEndReached={loadMore}
                    contentContainerStyle={styles.listContent}
                    ListFooterComponent={
                        loadingMore ? (
                            <View style={styles.loadMoreRow} accessibilityLiveRegion="polite" accessibilityRole="progressbar" accessibilityLabel={t('activityFeed.loadingMore')}>
                                <ActivityIndicator color={C.primary} size="small" />
                                <Text style={styles.loadMoreText}>{t('activityFeed.loadingMore')}</Text>
                            </View>
                        ) : loadMoreError ? (
                            <View style={styles.loadMoreRow}>
                                <SectionErrorState text={t('activityFeed.loadMoreFailedText')} onRetry={loadMore} />
                            </View>
                        ) : null
                    }
                />
            )}
        </SafeAreaView>
    );
}

function ActivityEventCard({ event, C, t, styles, showOrganizer }: {
    event: ActivityEvent;
    C: ThemeColors;
    t: (key: string, vars?: Record<string, string | number>) => string;
    styles: ReturnType<typeof createStyles>;
    showOrganizer: boolean;
}) {
    const outcomeLabel = event.sourceKind === 'reminder'
        ? (event.outcome === 'taken' ? t('activityFeed.outcomeTaken') : event.outcome === 'skipped' ? t('activityFeed.outcomeSkipped') : t('activityFeed.outcomeMissed'))
        : (event.outcome === 'completed_on_time' ? t('activityFeed.outcomeCompletedOnTime') : event.outcome === 'completed_late' ? t('activityFeed.outcomeCompletedLate') : t('activityFeed.outcomeTaskSkipped'));

    return (
        <View style={[styles.card, SHADOW.sm]} accessible accessibilityLabel={event.accessibleSummary}>
            <View style={styles.cardTopRow}>
                <View style={styles.kindPill}>
                    <Ionicons name={event.sourceKind === 'reminder' ? 'time-outline' : 'checkbox-outline'} size={12} color={C.textSecondary} />
                    <Text style={styles.kindPillText}>{event.sourceKind === 'reminder' ? t('activityFeed.reminderLabel') : t('activityFeed.taskLabel')}</Text>
                </View>
                <StatusBadge label={outcomeLabel} tone={OUTCOME_TONE[event.outcome] ?? 'neutral'} />
            </View>
            <Text style={styles.cardTitle} numberOfLines={2}>{event.title}</Text>
            <Text style={styles.cardSubtitle}>
                {formatDateStringForDisplay(event.occurrenceDate)}
                {showOrganizer && event.organizerName !== undefined ? ` · ${t('activityFeed.organizerPrefix', { name: event.organizerName ?? t('activityFeed.formerOrganizer') })}` : ''}
            </Text>
        </View>
    );
}

const createStyles = (C: ThemeColors) => StyleSheet.create({
    container: { flex: 1, backgroundColor: C.bgPage },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingTop: 4 },
    headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '800', color: C.textPrimary },
    filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 20, marginVertical: 14 },
    noticeBar: { marginHorizontal: 20, marginBottom: 10, padding: 12, borderRadius: RADIUS.lg, backgroundColor: C.bgAlt },
    noticeText: { fontSize: 13, color: C.textSecondary, textAlign: 'center' },
    listContent: { paddingHorizontal: 20, paddingBottom: 40 },
    card: { backgroundColor: C.bgSurface, borderRadius: RADIUS.xl, padding: 16, marginBottom: 12 },
    cardTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
    kindPill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: RADIUS.full, backgroundColor: C.bgAlt },
    kindPillText: { fontSize: 11, fontWeight: '700', color: C.textSecondary },
    cardTitle: { fontSize: 15, fontWeight: '700', color: C.textPrimary, marginBottom: 4 },
    cardSubtitle: { fontSize: 13, color: C.textSecondary },
    loadMoreRow: { paddingVertical: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
    loadMoreText: { fontSize: 13, color: C.textSecondary, fontWeight: '600' },
});
