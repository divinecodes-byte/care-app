// Complete, cursor-paginated overdue-task-occurrence history — Week 4
// launch-hardening task #3. Participant-only. Powers "View all overdue"
// from app/recipient-dashboard.tsx's bounded Today preview.
//
// Structurally cloned from app/activity.tsx's already-proven pagination
// pattern (request-generation stale-response guard, hasMore, loading-more
// footer, offline/error states) — the one deliberate difference is that
// `has_more` here is returned explicitly by the RPC itself
// (get_participant_overdue_task_occurrences), never inferred from
// `rows.length === PAGE_SIZE` (an exact final page would otherwise falsely
// signal a next page). See docs/task-overdue-pagination.md for the full
// cursor contract.

import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AccessibleIconButton, StatusBadge } from '@/components/AccessiblePrimitives';
import { formatDateStringForDisplay } from '@/components/DatePickerField';
import { EmptyState, ErrorState, OfflineBanner, SectionErrorState, ScreenLoadingState } from '@/components/StateViews';
import { RADIUS, SHADOW, ThemeColors } from '@/constants/theme';
import { classifyScreenError } from '@/lib/asyncStateCore';
import { ERROR_CATEGORY_TRANSLATION_KEYS } from '@/lib/errorClassification';
import { useTranslation } from '@/lib/i18n/context';
import { resolveOrganizerDisplay } from '@/lib/organizerDisplay';
import { supabase } from '@/lib/supabase';
import { useThemeColors } from '@/lib/theme';
import { showAlertOnce } from '@/lib/alertGuard';

const PAGE_SIZE = 20;

type OverdueRow = {
    task_id: string;
    occurrence_date: string;
    due_date: string | null;
    overdue_since_date: string;
    connection_id: string;
    caregiver_id: string;
    title: string;
    frequency: string;
    organizer_full_name: string | null;
    organizer_account_status: string | null;
    organizer_deleted_at: string | null;
    routine_instance_id: string | null;
    has_more: boolean;
};

type Cursor = { overdueSinceDate: string; taskId: string };

export default function OverdueTasksScreen() {
    const C = useThemeColors();
    const t = useTranslation();
    const styles = useMemo(() => createStyles(C), [C]);

    const [rows, setRows] = useState<OverdueRow[]>([]);
    const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
    const [loadingMore, setLoadingMore] = useState(false);
    const [loadMoreError, setLoadMoreError] = useState(false);
    const [hasMore, setHasMore] = useState(false);
    const [offline, setOffline] = useState(false);
    const [respondingKey, setRespondingKey] = useState<string | null>(null);

    // Guards a refresh/load-more from having a stale in-flight page request
    // land after a newer one -- same convention as app/activity.tsx.
    const requestIdRef = useRef(0);

    const rowKey = (r: { task_id: string; occurrence_date: string }) => `${r.task_id}:${r.occurrence_date}`;

    const fetchPage = useCallback(async (before: Cursor | null): Promise<{ rows: OverdueRow[]; error?: string }> => {
        const { data, error } = await supabase.rpc('get_participant_overdue_task_occurrences', {
            p_before_date: before?.overdueSinceDate ?? null,
            p_before_task_id: before?.taskId ?? null,
            p_limit: PAGE_SIZE,
        });
        if (error) return { rows: [], error: error.message };
        return { rows: (data ?? []) as OverdueRow[] };
    }, []);

    const loadFirstPage = useCallback(async () => {
        const requestId = ++requestIdRef.current;
        setStatus('loading');
        setLoadMoreError(false);

        const { rows: pageRows, error } = await fetchPage(null);
        if (requestIdRef.current !== requestId) return;

        if (error) {
            setOffline(classifyScreenError(error) === 'network');
            setStatus('error');
            return;
        }
        setRows(pageRows);
        setHasMore(pageRows.length > 0 && pageRows[pageRows.length - 1].has_more);
        setOffline(false);
        setStatus('ready');
    }, [fetchPage]);

    useEffect(() => { loadFirstPage(); }, [loadFirstPage]);

    async function loadMore() {
        if (loadingMore || !hasMore || rows.length === 0) return;
        const requestId = requestIdRef.current;
        setLoadingMore(true);
        setLoadMoreError(false);
        const last = rows[rows.length - 1];
        const { rows: pageRows, error } = await fetchPage({ overdueSinceDate: last.overdue_since_date, taskId: last.task_id });
        if (requestIdRef.current !== requestId) { setLoadingMore(false); return; }

        setLoadingMore(false);
        if (error) { setLoadMoreError(true); return; }

        setRows((current) => {
            const seen = new Set(current.map(rowKey));
            const merged = [...current];
            for (const r of pageRows) {
                const key = rowKey(r);
                if (!seen.has(key)) { seen.add(key); merged.push(r); }
            }
            return merged;
        });
        setHasMore(pageRows.length > 0 && pageRows[pageRows.length - 1].has_more);
    }

    async function respond(row: OverdueRow, action: 'completed' | 'skipped') {
        const key = rowKey(row);
        if (respondingKey) return;
        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        setRespondingKey(key);
        // Acts on this exact row's own occurrence_date -- never
        // overdue_since_date (the display/sort date, which can differ for
        // one-time tasks) -- see docs/task-overdue-pagination.md.
        const { error } = await supabase.rpc('respond_to_task_occurrence', {
            p_task_id: row.task_id,
            p_occurrence_date: row.occurrence_date,
            p_status: action,
        });
        setRespondingKey(null);
        if (error) {
            showAlertOnce(t('taskDetails.somethingWrong'), t(ERROR_CATEGORY_TRANSLATION_KEYS[classifyScreenError(error.message)]));
            return;
        }
        // Only this exact occurrence disappears -- the rest of the current
        // page, and the next page's cursor, remain completely stable.
        setRows((current) => current.filter((r) => rowKey(r) !== key));
    }

    if (status === 'loading') {
        return (
            <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
                <ScreenLoadingState label={t('tasksSection.overdueScreenHeading')} />
            </SafeAreaView>
        );
    }

    if (status === 'error') {
        return (
            <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
                {offline ? (
                    <View style={{ padding: 20 }}>
                        <OfflineBanner />
                        <ErrorState title={t('tasksSection.loadFailedTitle')} text={t('tasksSection.overdueLoadFailedText')} onRetry={loadFirstPage} />
                    </View>
                ) : (
                    <ErrorState title={t('tasksSection.loadFailedTitle')} text={t('tasksSection.overdueLoadFailedText')} onRetry={loadFirstPage} />
                )}
            </SafeAreaView>
        );
    }

    return (
        <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
            <View style={styles.header}>
                <AccessibleIconButton icon="arrow-back" label={t('common.back')} onPress={() => router.back()} />
                <Text style={styles.headerTitle} accessibilityRole="header" numberOfLines={1}>{t('tasksSection.overdueScreenHeading')}</Text>
                <View style={{ width: 44 }} />
            </View>

            {rows.length === 0 ? (
                <EmptyState icon="checkmark-circle-outline" title={t('tasksSection.overdueEmptyTitle')} text={t('tasksSection.overdueEmptyText')} />
            ) : (
                <FlatList
                    data={rows}
                    keyExtractor={rowKey}
                    renderItem={({ item }) => (
                        <OverdueTaskCard
                            row={item}
                            C={C}
                            t={t}
                            styles={styles}
                            responding={respondingKey === rowKey(item)}
                            disabled={respondingKey !== null}
                            onRespond={(action) => respond(item, action)}
                        />
                    )}
                    onEndReachedThreshold={0.4}
                    onEndReached={loadMore}
                    contentContainerStyle={styles.listContent}
                    ListFooterComponent={
                        loadingMore ? (
                            <View style={styles.loadMoreRow} accessibilityLiveRegion="polite" accessibilityRole="progressbar" accessibilityLabel={t('tasksSection.overdueLoadingMore')}>
                                <ActivityIndicator color={C.primary} size="small" />
                                <Text style={styles.loadMoreText}>{t('tasksSection.overdueLoadingMore')}</Text>
                            </View>
                        ) : loadMoreError ? (
                            <View style={styles.loadMoreRow}>
                                <SectionErrorState text={t('tasksSection.overdueLoadFailedText')} onRetry={loadMore} />
                            </View>
                        ) : null
                    }
                />
            )}
        </SafeAreaView>
    );
}

function OverdueTaskCard({ row, C, t, styles, responding, disabled, onRespond }: {
    row: OverdueRow;
    C: ThemeColors;
    t: (key: string, vars?: Record<string, string | number>) => string;
    styles: ReturnType<typeof createStyles>;
    responding: boolean;
    disabled: boolean;
    onRespond: (action: 'completed' | 'skipped') => void;
}) {
    const organizer = resolveOrganizerDisplay(row.caregiver_id, {
        full_name: row.organizer_full_name,
        account_status: row.organizer_account_status,
        deleted_at: row.organizer_deleted_at,
    }, t);

    const accessibleLabel = `${row.title}, ${t('tasksSection.overdueSinceLabel', { date: formatDateStringForDisplay(row.overdue_since_date) })}, ${t('tasksSection.organizerLabel', { name: organizer.displayName })}${row.routine_instance_id ? `, ${t('routineDetails.heading')}` : ''}`;

    return (
        <View style={[styles.card, SHADOW.sm]} accessible accessibilityLabel={accessibleLabel}>
            <View style={styles.cardTopRow}>
                <Text style={styles.cardTitle} numberOfLines={2}>{row.title}</Text>
                <StatusBadge label={t('tasksSection.filterOverdue')} tone="warning" />
            </View>
            <Text style={styles.cardSubtitle}>
                {t('tasksSection.overdueSinceLabel', { date: formatDateStringForDisplay(row.overdue_since_date) })}
                {' · '}
                {t('tasksSection.organizerLabel', { name: organizer.displayName })}
                {row.routine_instance_id ? ` · ${t('routineDetails.heading')}` : ''}
            </Text>
            <View style={styles.cardActionRow}>
                <TouchableOpacity
                    style={[styles.smallActionButton, styles.completeSmall]}
                    onPress={() => onRespond('completed')}
                    disabled={disabled}
                    accessibilityRole="button"
                    accessibilityLabel={t('tasksSection.complete')}
                    accessibilityState={{ disabled, busy: responding }}
                >
                    {responding ? <ActivityIndicator color={C.textInverse} size="small" /> : <Text style={styles.completeSmallText}>{t('tasksSection.complete')}</Text>}
                </TouchableOpacity>
                <TouchableOpacity
                    style={[styles.smallActionButton, styles.skipSmall]}
                    onPress={() => onRespond('skipped')}
                    disabled={disabled}
                    accessibilityRole="button"
                    accessibilityLabel={t('tasksSection.skip')}
                    accessibilityState={{ disabled, busy: false }}
                >
                    <Text style={styles.skipSmallText}>{t('tasksSection.skip')}</Text>
                </TouchableOpacity>
            </View>
        </View>
    );
}

const createStyles = (C: ThemeColors) => StyleSheet.create({
    container: { flex: 1, backgroundColor: C.bgPage },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingTop: 4 },
    headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '800', color: C.textPrimary },
    listContent: { paddingHorizontal: 20, paddingBottom: 40 },
    card: { backgroundColor: C.bgSurface, borderRadius: RADIUS.xl, padding: 16, marginBottom: 12 },
    cardTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 },
    cardTitle: { flex: 1, fontSize: 15, fontWeight: '700', color: C.textPrimary },
    cardSubtitle: { fontSize: 13, color: C.textSecondary, marginBottom: 12 },
    cardActionRow: { flexDirection: 'row', gap: 10 },
    smallActionButton: { flex: 1, minHeight: 44, borderRadius: RADIUS.lg, alignItems: 'center', justifyContent: 'center', paddingVertical: 10 },
    completeSmall: { backgroundColor: C.primary },
    completeSmallText: { color: C.textInverse, fontSize: 14, fontWeight: '700' },
    skipSmall: { backgroundColor: C.bgSurface, borderWidth: 1.5, borderColor: C.border },
    skipSmallText: { color: C.textSecondary, fontSize: 14, fontWeight: '700' },
    loadMoreRow: { paddingVertical: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
    loadMoreText: { fontSize: 13, color: C.textSecondary, fontWeight: '600' },
});
