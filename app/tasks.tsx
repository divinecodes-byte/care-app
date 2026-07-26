import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AccessibleIconButton, AccessibleSectionHeader, SelectionCard, StatusBadge, StatusTone } from '@/components/AccessiblePrimitives';
import { formatDateStringForDisplay } from '@/components/DatePickerField';
import { EmptyState, ErrorState, ScreenLoadingState } from '@/components/StateViews';
import { RADIUS, SHADOW, ThemeColors } from '@/constants/theme';
import { useTranslation } from '@/lib/i18n/context';
import { fetchTasksForRecipient, fetchTasksWithSummaries, TaskWithSummary } from '@/lib/taskData';
import { TaskDisplayStatus } from '@/lib/taskLifecycle';
import { showAlertOnce } from '@/lib/alertGuard';
import { supabase } from '@/lib/supabase';
import { useThemeColors } from '@/lib/theme';

type Filter = 'all' | 'open' | 'overdue' | 'completed' | 'archived';

const STATUS_TONE: Record<TaskDisplayStatus, StatusTone> = {
    upcoming: 'neutral',
    open: 'neutral',
    overdue: 'warning',
    completed_on_time: 'success',
    completed_late: 'warning',
    skipped: 'error',
};

export default function TasksScreen() {
    const C = useThemeColors();
    const t = useTranslation();
    const styles = useMemo(() => createStyles(C), [C]);
    const { connectionId } = useLocalSearchParams<{ connectionId?: string }>();

    const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
    const [rows, setRows] = useState<TaskWithSummary[]>([]);
    const [viewerIsOrganizer, setViewerIsOrganizer] = useState(false);
    const [participantName, setParticipantName] = useState('');
    const [connectionEnded, setConnectionEnded] = useState(false);
    const [filter, setFilter] = useState<Filter>('all');
    const [respondingTaskId, setRespondingTaskId] = useState<string | null>(null);
    const [analytics, setAnalytics] = useState<Record<string, number | null> | null>(null);
    const [analyticsError, setAnalyticsError] = useState(false);

    const load = useCallback(async () => {
        setStatus('loading');
        try {
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) { setStatus('error'); return; }

            if (connectionId) {
                // Organizer viewing one participant's tasks.
                const { data: connection } = await supabase.from('connections').select('caregiver_id, recipient_id, status').eq('id', connectionId).maybeSingle();
                if (!connection) { setStatus('error'); return; }

                setViewerIsOrganizer(connection.caregiver_id === user.id);
                setConnectionEnded(connection.status !== 'accepted');

                const { data: profile } = await supabase.from('profiles').select('full_name, timezone').eq('id', connection.recipient_id).maybeSingle();
                setParticipantName(profile?.full_name || t('common.participant'));

                const result = await fetchTasksWithSummaries(connectionId, profile?.timezone || 'America/New_York');
                setRows(result);

                // Analytics failing never blocks the task list itself from
                // rendering (Phase 10/14: task data and analytics may fail
                // independently).
                const { data: analyticsRows, error: analyticsErr } = await supabase.rpc('task_analytics_summary', { p_connection_id: connectionId, p_days: 30 });
                if (analyticsErr || !analyticsRows) {
                    setAnalyticsError(true);
                    setAnalytics(null);
                } else {
                    setAnalyticsError(false);
                    setAnalytics(Object.fromEntries((analyticsRows as { metric: string; value: number | null }[]).map((r) => [r.metric, r.value])));
                }
            } else {
                // Participant viewing their own tasks across every organizer.
                const { data: ownProfile } = await supabase.from('profiles').select('timezone').eq('id', user.id).maybeSingle();
                setViewerIsOrganizer(false);
                setConnectionEnded(false);
                const result = await fetchTasksForRecipient(user.id, ownProfile?.timezone || 'America/New_York');
                setRows(result);
            }
            setStatus('ready');
        } catch {
            setStatus('error');
        }
    }, [connectionId, t]);

    useEffect(() => { load(); }, [load]);

    async function respond(task: TaskWithSummary, action: 'completed' | 'skipped') {
        if (!task.summary.actionableDate || respondingTaskId) return;
        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        setRespondingTaskId(task.task.id);
        const { error } = await supabase.rpc('respond_to_task_occurrence', {
            p_task_id: task.task.id,
            p_occurrence_date: task.summary.actionableDate,
            p_status: action,
        });
        setRespondingTaskId(null);
        if (error) {
            showAlertOnce(t('tasksSection.loadFailedTitle'), t('tasksSection.loadFailedText'));
            return;
        }
        load();
    }

    const filtered = rows.filter((r) => {
        if (filter === 'archived') return !r.task.is_active;
        if (!r.task.is_active) return false;
        if (filter === 'all') return true;
        if (filter === 'open') return r.summary.status === 'open' || r.summary.status === 'upcoming';
        if (filter === 'overdue') return r.summary.status === 'overdue';
        if (filter === 'completed') return r.summary.status === 'completed_on_time' || r.summary.status === 'completed_late' || r.summary.status === 'skipped';
        return true;
    });

    const overdue = filtered.filter((r) => r.task.is_active && r.summary.status === 'overdue');
    const openToday = filtered.filter((r) => r.task.is_active && r.summary.status === 'open');
    const upcoming = filtered.filter((r) => r.task.is_active && r.summary.status === 'upcoming');
    const completed = filtered.filter((r) => r.task.is_active && ['completed_on_time', 'completed_late', 'skipped'].includes(r.summary.status));
    const archived = filtered.filter((r) => !r.task.is_active);

    if (status === 'loading') {
        return (
            <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
                <ScreenLoadingState label={t('taskForm.loadingTask')} />
            </SafeAreaView>
        );
    }

    if (status === 'error') {
        return (
            <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
                <ErrorState title={t('tasksSection.loadFailedTitle')} text={t('tasksSection.loadFailedText')} onRetry={load} />
            </SafeAreaView>
        );
    }

    return (
        <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
            <View style={styles.header}>
                <AccessibleIconButton icon="arrow-back" label={t('common.back')} onPress={() => router.back()} />
                <Text style={styles.headerTitle} accessibilityRole="header">
                    {viewerIsOrganizer && participantName ? `${t('tasksSection.heading')} · ${participantName}` : t('tasksSection.heading')}
                </Text>
                {viewerIsOrganizer ? (
                    <AccessibleIconButton icon="add" label={t('tasksSection.createTask')} onPress={() => router.push({ pathname: '/create-task', params: { connectionId } })} />
                ) : (
                    <View style={{ width: 44 }} />
                )}
            </View>

            <ScrollView contentContainerStyle={styles.scrollContent}>
                {viewerIsOrganizer ? (
                    analyticsError ? (
                        <View style={[styles.card, SHADOW.sm]}>
                            <Text style={styles.calmText}>{t('tasksSection.loadFailedText')}</Text>
                        </View>
                    ) : analytics ? (
                        <View style={[styles.card, SHADOW.sm]} accessible accessibilityLabel={
                            `${t('tasksSection.analyticsHeading')}. ${t('tasksSection.analyticsCompletionRate')}: ${analytics.completion_rate != null ? Math.round(analytics.completion_rate * 100) + '%' : '—'}. ${t('tasksSection.analyticsOnTimeRate')}: ${analytics.on_time_rate != null ? Math.round(analytics.on_time_rate * 100) + '%' : '—'}. ${t('tasksSection.analyticsCompleted', { n: analytics.completed ?? 0 })}. ${t('tasksSection.analyticsSkipped', { n: analytics.skipped ?? 0 })}. ${t('tasksSection.analyticsOverdue', { n: analytics.currently_overdue ?? 0 })}.`
                        }>
                            <AccessibleSectionHeader title={t('tasksSection.analyticsHeading')} />
                            <View style={styles.analyticsRow}>
                                <View style={styles.analyticsStat}>
                                    <Text style={styles.analyticsValue}>{analytics.completion_rate != null ? `${Math.round(analytics.completion_rate * 100)}%` : '—'}</Text>
                                    <Text style={styles.analyticsLabel}>{t('tasksSection.analyticsCompletionRate')}</Text>
                                </View>
                                <View style={styles.analyticsStat}>
                                    <Text style={styles.analyticsValue}>{analytics.on_time_rate != null ? `${Math.round(analytics.on_time_rate * 100)}%` : '—'}</Text>
                                    <Text style={styles.analyticsLabel}>{t('tasksSection.analyticsOnTimeRate')}</Text>
                                </View>
                            </View>
                            <Text style={styles.analyticsDetail}>
                                {t('tasksSection.analyticsCompleted', { n: analytics.completed ?? 0 })} · {t('tasksSection.analyticsSkipped', { n: analytics.skipped ?? 0 })} · {t('tasksSection.analyticsOverdue', { n: analytics.currently_overdue ?? 0 })}
                            </Text>
                        </View>
                    ) : null
                ) : null}

                <View style={styles.filterRow}>
                    {(['all', 'open', 'overdue', 'completed', ...(viewerIsOrganizer ? ['archived'] as Filter[] : [])] as Filter[]).map((f) => (
                        <SelectionCard
                            key={f}
                            label={t(`tasksSection.filter${f.charAt(0).toUpperCase()}${f.slice(1)}`)}
                            selected={filter === f}
                            onPress={() => setFilter(f)}
                            compact
                        />
                    ))}
                </View>

                {connectionEnded ? (
                    <View style={[styles.card, SHADOW.sm]}>
                        <Text style={styles.calmText}>{t('tasksSection.connectionEndedText')}</Text>
                    </View>
                ) : null}

                {filtered.length === 0 ? (
                    <EmptyState
                        icon="checkbox-outline"
                        title={filter === 'all' ? t('tasksSection.noTasksTitle') : t('tasksSection.allDoneTitle')}
                        text={filter === 'all' ? t('tasksSection.noTasksText') : t('tasksSection.allDoneText')}
                    />
                ) : (
                    <>
                        {overdue.length > 0 && <TaskSection title={t('tasksSection.overdueSection')} items={overdue} respondingTaskId={respondingTaskId} onRespond={respond} viewerIsOrganizer={viewerIsOrganizer} styles={styles} C={C} t={t} />}
                        {openToday.length > 0 && <TaskSection title={t('tasksSection.openSection')} items={openToday} respondingTaskId={respondingTaskId} onRespond={respond} viewerIsOrganizer={viewerIsOrganizer} styles={styles} C={C} t={t} />}
                        {upcoming.length > 0 && <TaskSection title={t('tasksSection.upcomingSection')} items={upcoming} respondingTaskId={respondingTaskId} onRespond={respond} viewerIsOrganizer={viewerIsOrganizer} styles={styles} C={C} t={t} />}
                        {completed.length > 0 && <TaskSection title={t('tasksSection.completedSection')} items={completed} respondingTaskId={respondingTaskId} onRespond={respond} viewerIsOrganizer={viewerIsOrganizer} styles={styles} C={C} t={t} />}
                        {archived.length > 0 && <TaskSection title={t('tasksSection.archivedSection')} items={archived} respondingTaskId={respondingTaskId} onRespond={respond} viewerIsOrganizer={viewerIsOrganizer} styles={styles} C={C} t={t} />}
                    </>
                )}
            </ScrollView>
        </SafeAreaView>
    );
}

function TaskSection({ title, items, respondingTaskId, onRespond, viewerIsOrganizer, styles, C, t }: {
    title: string;
    items: TaskWithSummary[];
    respondingTaskId: string | null;
    onRespond: (task: TaskWithSummary, action: 'completed' | 'skipped') => void;
    viewerIsOrganizer: boolean;
    styles: ReturnType<typeof createStyles>;
    C: ThemeColors;
    t: (key: string, vars?: Record<string, string | number>) => string;
}) {
    return (
        <View style={styles.sectionBlock}>
            <AccessibleSectionHeader title={title} style={styles.sectionHeaderSpacing} />
            {items.map(({ task, summary, organizerName }) => {
                const statusLabel = t(`taskStatus.${summary.status === 'completed_on_time' ? 'completedOnTime' : summary.status === 'completed_late' ? 'completedLate' : summary.status}`);
                const scheduleContext = task.frequency === 'one_time'
                    ? (task.due_date ? t('tasksSection.dueLabel', { date: formatDateStringForDisplay(task.due_date) }) : t('tasksSection.noDueDate'))
                    : t(`tasksSection.${task.frequency === 'daily' ? 'recurrenceEveryDay' : task.frequency === 'weekdays' ? 'recurrenceWeekdays' : task.frequency === 'weekends' ? 'recurrenceWeekends' : 'recurrenceOneTime'}`);
                const canRespond = !viewerIsOrganizer && task.is_active && !!summary.actionableDate;

                return (
                    <TouchableOpacity
                        key={task.id}
                        style={[styles.card, SHADOW.sm]}
                        onPress={() => router.push({ pathname: '/task-details', params: { taskId: task.id } })}
                        accessibilityRole="button"
                        accessibilityLabel={`${task.title}, ${statusLabel}`}
                        activeOpacity={0.85}
                    >
                        <View style={styles.cardTopRow}>
                            <Text style={styles.cardTitle} numberOfLines={2}>{task.title}</Text>
                            <StatusBadge label={statusLabel} tone={STATUS_TONE[summary.status]} />
                        </View>
                        <Text style={styles.cardSubtitle}>
                            {organizerName ? `${t('tasksSection.organizerLabel', { name: organizerName })} · ` : ''}
                            {scheduleContext}
                            {summary.overdueCount > 1 ? ` · ${t('tasksSection.overdueCountBadge', { n: summary.overdueCount })}` : ''}
                        </Text>
                        {canRespond ? (
                            <View style={styles.cardActionRow}>
                                <TouchableOpacity
                                    style={[styles.smallActionButton, styles.completeSmall]}
                                    onPress={(e) => { e.stopPropagation(); onRespond({ task, summary }, 'completed'); }}
                                    disabled={respondingTaskId === task.id}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('tasksSection.complete')}
                                >
                                    {respondingTaskId === task.id ? <ActivityIndicator color={C.textInverse} size="small" /> : <Text style={styles.completeSmallText}>{t('tasksSection.complete')}</Text>}
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={[styles.smallActionButton, styles.skipSmall]}
                                    onPress={(e) => { e.stopPropagation(); onRespond({ task, summary }, 'skipped'); }}
                                    disabled={respondingTaskId === task.id}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('tasksSection.skip')}
                                >
                                    <Text style={styles.skipSmallText}>{t('tasksSection.skip')}</Text>
                                </TouchableOpacity>
                            </View>
                        ) : null}
                    </TouchableOpacity>
                );
            })}
        </View>
    );
}

const createStyles = (C: ThemeColors) => StyleSheet.create({
    container: { flex: 1, backgroundColor: C.bgPage },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingTop: 4 },
    headerTitle: { fontSize: 17, fontWeight: '800', color: C.textPrimary },
    scrollContent: { paddingHorizontal: 20, paddingBottom: 60 },
    filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginVertical: 16 },
    card: { backgroundColor: C.bgSurface, borderRadius: RADIUS.xl, padding: 16, marginBottom: 12 },
    calmText: { fontSize: 14, color: C.textSecondary, textAlign: 'center' },
    analyticsRow: { flexDirection: 'row', gap: 24, marginTop: 12, marginBottom: 8 },
    analyticsStat: { alignItems: 'flex-start' },
    analyticsValue: { fontSize: 22, fontWeight: '800', color: C.textPrimary },
    analyticsLabel: { fontSize: 12, color: C.textSecondary, fontWeight: '600', marginTop: 2 },
    analyticsDetail: { fontSize: 12, color: C.textMuted, marginTop: 4 },
    sectionBlock: { marginBottom: 8 },
    sectionHeaderSpacing: { marginBottom: 10, marginTop: 4 },
    cardTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 },
    cardTitle: { flex: 1, fontSize: 15, fontWeight: '700', color: C.textPrimary },
    cardSubtitle: { fontSize: 13, color: C.textSecondary, marginTop: 6 },
    cardActionRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
    smallActionButton: { flex: 1, minHeight: 40, borderRadius: RADIUS.lg, alignItems: 'center', justifyContent: 'center' },
    completeSmall: { backgroundColor: C.primary },
    completeSmallText: { color: C.textInverse, fontSize: 13, fontWeight: '700' },
    skipSmall: { backgroundColor: C.bgAlt, borderWidth: 1.5, borderColor: C.border },
    skipSmallText: { color: C.textSecondary, fontSize: 13, fontWeight: '700' },
});
