import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AccessibleIconButton, StatusBadge, StatusTone } from '@/components/AccessiblePrimitives';
import { formatDateStringForDisplay } from '@/components/DatePickerField';
import { ErrorState, ScreenLoadingState } from '@/components/StateViews';
import { RADIUS, SHADOW, ThemeColors } from '@/constants/theme';
import { classifyScreenError } from '@/lib/asyncStateCore';
import { ERROR_CATEGORY_TRANSLATION_KEYS } from '@/lib/errorClassification';
import { useTranslation } from '@/lib/i18n/context';
import { resolveOrganizerDisplay } from '@/lib/organizerDisplay';
import {
    summarizeTask,
    TaskDisplayStatus,
    TaskOccurrenceLike,
    TaskScheduleLike,
} from '@/lib/taskLifecycle';
import { showAlertOnce } from '@/lib/alertGuard';
import { supabase } from '@/lib/supabase';
import { useThemeColors } from '@/lib/theme';
import { getZonedTodayString } from '@/lib/zonedTime';

type TaskRow = TaskScheduleLike & {
    id: string;
    title: string;
    notes: string | null;
    caregiver_id: string;
    recipient_id: string;
};

const STATUS_TONE: Record<TaskDisplayStatus, StatusTone> = {
    upcoming: 'neutral',
    open: 'neutral',
    overdue: 'warning',
    completed_on_time: 'success',
    completed_late: 'warning',
    skipped: 'error',
};

export default function TaskDetailsScreen() {
    const C = useThemeColors();
    const t = useTranslation();
    const styles = useMemo(() => createStyles(C), [C]);
    const { taskId } = useLocalSearchParams<{ taskId?: string }>();

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [task, setTask] = useState<TaskRow | null>(null);
    const [occurrences, setOccurrences] = useState<TaskOccurrenceLike[]>([]);
    const [participantName, setParticipantName] = useState('');
    const [organizerName, setOrganizerName] = useState('');
    const [viewerIsOrganizer, setViewerIsOrganizer] = useState(false);
    const [connectionEnded, setConnectionEnded] = useState(false);
    const [today, setToday] = useState('');
    const [responding, setResponding] = useState(false);
    const [justResponded, setJustResponded] = useState<'completed' | 'skipped' | null>(null);

    const load = useCallback(async () => {
        setError(null);
        if (!taskId) { setError(t('taskDetails.taskNotFound')); setLoading(false); return; }

        const { data: { user } } = await supabase.auth.getUser();
        if (!user) { setError(t('taskDetails.somethingWrong')); setLoading(false); return; }

        const { data: taskRow, error: taskError } = await supabase.from('tasks').select('*').eq('id', taskId).maybeSingle();
        if (taskError || !taskRow) {
            setError(t('taskDetails.taskNotFound'));
            setLoading(false);
            return;
        }

        const row = taskRow as TaskRow;
        setTask(row);
        setViewerIsOrganizer(row.caregiver_id === user.id);

        const { data: connection } = await supabase.from('connections').select('status').eq('id', (taskRow as any).connection_id).maybeSingle();
        setConnectionEnded(!connection || connection.status !== 'accepted');

        const [{ data: recipientProfile }, { data: organizerProfile }] = await Promise.all([
            supabase.from('profiles').select('full_name, timezone').eq('id', row.recipient_id).maybeSingle(),
            supabase.from('profiles').select('full_name, account_status, deleted_at').eq('id', row.caregiver_id).maybeSingle(),
        ]);
        setParticipantName(recipientProfile?.full_name || t('common.participant'));
        setOrganizerName(resolveOrganizerDisplay(row.caregiver_id, organizerProfile, t).displayName);
        setToday(getZonedTodayString(recipientProfile?.timezone || 'America/New_York'));

        const { data: occRows } = await supabase
            .from('task_occurrences')
            .select('occurrence_date, status, completed_at, skipped_at')
            .eq('task_id', taskId)
            .order('occurrence_date', { ascending: false });
        setOccurrences((occRows ?? []) as any);

        setLoading(false);
    }, [taskId, t]);

    useEffect(() => { load(); }, [load]);

    const summary = task ? summarizeTask(task, occurrences, today || getZonedTodayString('America/New_York')) : null;

    async function respond(status: 'completed' | 'skipped') {
        if (!task || !summary?.actionableDate || responding) return;
        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        setResponding(true);
        const { error: respondError } = await supabase.rpc('respond_to_task_occurrence', {
            p_task_id: task.id,
            p_occurrence_date: summary.actionableDate,
            p_status: status,
        });
        setResponding(false);
        if (respondError) {
            showAlertOnce(t('taskDetails.somethingWrong'), t(ERROR_CATEGORY_TRANSLATION_KEYS[classifyScreenError(respondError.message)]));
            return;
        }
        setJustResponded(status);
        load();
    }

    if (loading) {
        return (
            <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
                <ScreenLoadingState label={t('taskDetails.loadingTask')} />
            </SafeAreaView>
        );
    }

    if (error || !task || !summary) {
        return (
            <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
                <View style={styles.centerContent}>
                    <ErrorState title={t('taskDetails.somethingWrong')} text={error ?? undefined} />
                    <TouchableOpacity onPress={() => router.back()} style={{ marginTop: 16 }} accessibilityRole="button" accessibilityLabel={t('taskDetails.goBack')}>
                        <Text style={styles.linkText}>{t('taskDetails.goBack')}</Text>
                    </TouchableOpacity>
                </View>
            </SafeAreaView>
        );
    }

    const statusLabel = t(`taskStatus.${summary.status === 'completed_on_time' ? 'completedOnTime' : summary.status === 'completed_late' ? 'completedLate' : summary.status}`);
    const canRespond = !viewerIsOrganizer && !connectionEnded && task.is_active && !!summary.actionableDate;

    return (
        <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
            <View style={styles.header}>
                <AccessibleIconButton icon="arrow-back" label={t('taskDetails.goBack')} onPress={() => router.back()} />
                <Text style={styles.headerTitle} accessibilityRole="header">
                    {t('taskDetails.navTitle')}{!task.is_active ? t('taskDetails.archivedSuffix') : ''}
                </Text>
                {viewerIsOrganizer ? (
                    <AccessibleIconButton icon="create-outline" label={t('taskDetails.edit')} onPress={() => router.push({ pathname: '/edit-task', params: { taskId: task.id } })} />
                ) : (
                    <View style={{ width: 44 }} />
                )}
            </View>

            <ScrollView contentContainerStyle={styles.scrollContent}>
                <View style={[styles.card, SHADOW.sm]}>
                    <Text style={styles.title}>{task.title}</Text>
                    {task.notes ? <Text style={styles.notes}>{task.notes}</Text> : null}
                    <StatusBadge label={statusLabel} tone={STATUS_TONE[summary.status]} style={{ marginTop: 10 }} />
                </View>

                <View style={[styles.card, SHADOW.sm]}>
                    <MetaRow label={viewerIsOrganizer ? t('taskDetails.participantLabel') : t('taskDetails.organizerLabel')} value={viewerIsOrganizer ? participantName : organizerName} />
                    <MetaRow label={t('taskDetails.startDateLabel')} value={formatDateStringForDisplay(task.start_date)} />
                    {task.frequency === 'one_time' ? (
                        <MetaRow label={t('taskDetails.dueDateLabel')} value={task.due_date ? formatDateStringForDisplay(task.due_date) : t('tasksSection.noDueDate')} />
                    ) : (
                        <MetaRow label={t('taskDetails.recurrenceLabel')} value={t(`tasksSection.${task.frequency === 'daily' ? 'recurrenceEveryDay' : task.frequency === 'weekdays' ? 'recurrenceWeekdays' : task.frequency === 'weekends' ? 'recurrenceWeekends' : 'recurrenceOneTime'}`)} />
                    )}
                    {summary.overdueCount > 1 ? (
                        <MetaRow label={t('taskDetails.statusLabel')} value={t('tasksSection.overdueCountBadge', { n: summary.overdueCount })} />
                    ) : null}
                </View>

                {connectionEnded ? (
                    <View style={[styles.card, SHADOW.sm]} accessible accessibilityRole="text">
                        <Text style={styles.calmStateText}>{t('tasksSection.connectionEndedText')}</Text>
                    </View>
                ) : !task.is_active ? (
                    <View style={[styles.card, SHADOW.sm]} accessible accessibilityRole="text">
                        <Text style={styles.calmStateText}>{t('tasksSection.taskUnavailableText')}</Text>
                    </View>
                ) : canRespond ? (
                    justResponded ? (
                        <View style={[styles.card, SHADOW.sm]} accessible accessibilityRole="alert" accessibilityLiveRegion="polite">
                            <Ionicons name="checkmark-circle" size={22} color={C.success} />
                            <Text style={styles.confirmedText}>
                                {justResponded === 'completed' ? t('tasksSection.markedComplete') : t('tasksSection.markedSkipped')}
                            </Text>
                        </View>
                    ) : (
                        <View style={styles.actionRow}>
                            <TouchableOpacity
                                style={[styles.actionButton, styles.completeButton]}
                                onPress={() => respond('completed')}
                                disabled={responding}
                                accessibilityRole="button"
                                accessibilityLabel={t('tasksSection.complete')}
                                accessibilityState={{ disabled: responding, busy: responding }}
                            >
                                {responding ? <ActivityIndicator color={C.textInverse} /> : <Text style={styles.completeButtonText}>{t('tasksSection.complete')}</Text>}
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={[styles.actionButton, styles.skipButton]}
                                onPress={() => respond('skipped')}
                                disabled={responding}
                                accessibilityRole="button"
                                accessibilityLabel={t('tasksSection.skip')}
                                accessibilityState={{ disabled: responding, busy: responding }}
                            >
                                <Text style={styles.skipButtonText}>{t('tasksSection.skip')}</Text>
                            </TouchableOpacity>
                        </View>
                    )
                ) : null}

                {occurrences.length > 0 ? (
                    <View style={[styles.card, SHADOW.sm]}>
                        <Text style={styles.historyHeading} accessibilityRole="header">{t('taskDetails.historyHeading')}</Text>
                        {occurrences.slice(0, 20).map((o) => (
                            <View key={o.occurrence_date} style={styles.historyRow}>
                                <Text style={styles.historyDate}>{formatDateStringForDisplay(o.occurrence_date)}</Text>
                                <StatusBadge
                                    label={t(`taskStatus.${o.status === 'completed_on_time' ? 'completedOnTime' : o.status === 'completed_late' ? 'completedLate' : 'skipped'}`)}
                                    tone={STATUS_TONE[o.status]}
                                />
                            </View>
                        ))}
                    </View>
                ) : (
                    <Text style={styles.noHistoryText}>{t('taskDetails.noHistoryYet')}</Text>
                )}
            </ScrollView>
        </SafeAreaView>
    );
}

function MetaRow({ label, value }: { label: string; value: string }) {
    return (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 }}>
            <Text style={{ fontSize: 13, fontWeight: '700', opacity: 0.65 }}>{label}</Text>
            <Text style={{ fontSize: 13, fontWeight: '600' }}>{value}</Text>
        </View>
    );
}

const createStyles = (C: ThemeColors) => StyleSheet.create({
    container: { flex: 1, backgroundColor: C.bgPage },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingTop: 4 },
    headerTitle: { fontSize: 16, fontWeight: '800', color: C.textPrimary, flex: 1, textAlign: 'center' },
    scrollContent: { paddingHorizontal: 20, paddingBottom: 60 },
    card: { backgroundColor: C.bgSurface, borderRadius: RADIUS.xl, padding: 18, marginTop: 16 },
    title: { fontSize: 19, fontWeight: '800', color: C.textPrimary, marginBottom: 6 },
    notes: { fontSize: 14, color: C.textSecondary, lineHeight: 20 },
    calmStateText: { fontSize: 14, color: C.textSecondary, textAlign: 'center' },
    confirmedText: { fontSize: 15, fontWeight: '700', color: C.textPrimary, marginTop: 8, textAlign: 'center' },
    actionRow: { flexDirection: 'row', gap: 12, marginTop: 16 },
    actionButton: { flex: 1, minHeight: 44, borderRadius: RADIUS.xl, alignItems: 'center', justifyContent: 'center', paddingVertical: 14 },
    completeButton: { backgroundColor: C.primary },
    completeButtonText: { color: C.textInverse, fontSize: 15, fontWeight: '800' },
    skipButton: { backgroundColor: C.bgSurface, borderWidth: 1.5, borderColor: C.border },
    skipButtonText: { color: C.textSecondary, fontSize: 15, fontWeight: '700' },
    historyHeading: { fontSize: 15, fontWeight: '800', color: C.textPrimary, marginBottom: 10 },
    historyRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, borderTopWidth: 1, borderTopColor: C.border },
    historyDate: { fontSize: 13, color: C.textSecondary, fontWeight: '600' },
    noHistoryText: { fontSize: 13, color: C.textMuted, textAlign: 'center', marginTop: 20 },
    centerContent: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
    linkText: { fontSize: 15, color: C.primary, fontWeight: '700' },
});
