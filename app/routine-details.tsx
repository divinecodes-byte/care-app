import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AccessibleSectionHeader, StatusBadge } from '@/components/AccessiblePrimitives';
import { formatDateStringForDisplay } from '@/components/DatePickerField';
import { ErrorState, ScreenLoadingState } from '@/components/StateViews';
import { RADIUS, SHADOW, ThemeColors } from '@/constants/theme';
import { useTranslation } from '@/lib/i18n/context';
import { showAlertOnce } from '@/lib/alertGuard';
import { supabase } from '@/lib/supabase';
import { useThemeColors } from '@/lib/theme';

type RoutineInstanceRow = {
    id: string;
    title: string;
    status: 'active' | 'archived';
    organizer_id: string;
    participant_id: string;
    connection_id: string;
    source_template_id: string | null;
    built_in_pack_id: string | null;
    created_at: string;
};

type MemberReminder = { itemId: string; reminderId: string; title: string; timeOfDay: string; isActive: boolean };
type MemberTask = { itemId: string; taskId: string; title: string; isActive: boolean };

export default function RoutineDetailsScreen() {
    const C = useThemeColors();
    const t = useTranslation();
    const styles = useMemo(() => createStyles(C), [C]);
    const { routineInstanceId } = useLocalSearchParams<{ routineInstanceId: string }>();

    const [status, setStatus] = useState<'loading' | 'ready' | 'error' | 'unauthorized'>('loading');
    const [instance, setInstance] = useState<RoutineInstanceRow | null>(null);
    const [isOrganizer, setIsOrganizer] = useState(false);
    const [organizerName, setOrganizerName] = useState('');
    const [participantName, setParticipantName] = useState('');
    const [connectionEnded, setConnectionEnded] = useState(false);
    const [sourceTemplateDeleted, setSourceTemplateDeleted] = useState(false);
    const [reminders, setReminders] = useState<MemberReminder[]>([]);
    const [tasks, setTasks] = useState<MemberTask[]>([]);
    const [archiving, setArchiving] = useState(false);
    const [duplicating, setDuplicating] = useState(false);

    const load = useCallback(async () => {
        if (!routineInstanceId) { setStatus('error'); return; }
        setStatus('loading');

        const { data: { user } } = await supabase.auth.getUser();
        if (!user) { setStatus('unauthorized'); return; }

        const { data: row, error } = await supabase
            .from('routine_instances')
            .select('id, title, status, organizer_id, participant_id, connection_id, source_template_id, built_in_pack_id, created_at')
            .eq('id', routineInstanceId)
            .maybeSingle();

        if (error) { setStatus('error'); return; }
        if (!row) { setStatus('unauthorized'); return; }

        setInstance(row);
        const organizer = row.organizer_id === user.id;
        setIsOrganizer(organizer);

        const { data: connection } = await supabase.from('connections').select('status').eq('id', row.connection_id).maybeSingle();
        setConnectionEnded(!connection || connection.status !== 'accepted');

        const [{ data: organizerProfile }, { data: participantProfile }] = await Promise.all([
            supabase.from('profiles').select('full_name').eq('id', row.organizer_id).maybeSingle(),
            supabase.from('profiles').select('full_name').eq('id', row.participant_id).maybeSingle(),
        ]);
        setOrganizerName(organizerProfile?.full_name || t('activityFeed.formerOrganizer'));
        setParticipantName(participantProfile?.full_name || t('activityFeed.formerParticipant'));

        if (row.source_template_id) {
            const { data: template } = await supabase.from('routine_templates').select('id').eq('id', row.source_template_id).maybeSingle();
            setSourceTemplateDeleted(!template);
        } else {
            setSourceTemplateDeleted(false);
        }

        const { data: memberItems } = await supabase
            .from('routine_instance_items')
            .select('id, item_kind, reminder_id, task_id, display_order')
            .eq('routine_instance_id', routineInstanceId)
            .order('display_order', { ascending: true });

        const reminderIds = (memberItems ?? []).filter((i) => i.item_kind === 'reminder').map((i) => i.reminder_id as string);
        const taskIds = (memberItems ?? []).filter((i) => i.item_kind === 'task').map((i) => i.task_id as string);

        const [{ data: reminderRows }, { data: taskRows }] = await Promise.all([
            reminderIds.length > 0
                ? supabase.from('reminders').select('id, title, time_of_day, is_active').in('id', reminderIds)
                : Promise.resolve({ data: [] as any[] }),
            taskIds.length > 0
                ? supabase.from('tasks').select('id, title, is_active').in('id', taskIds)
                : Promise.resolve({ data: [] as any[] }),
        ]);

        const reminderById = new Map((reminderRows ?? []).map((r: any) => [r.id, r]));
        const taskById = new Map((taskRows ?? []).map((r: any) => [r.id, r]));

        setReminders(
            (memberItems ?? [])
                .filter((i) => i.item_kind === 'reminder' && reminderById.has(i.reminder_id))
                .map((i) => {
                    const r = reminderById.get(i.reminder_id);
                    return { itemId: i.id, reminderId: r.id, title: r.title, timeOfDay: (r.time_of_day as string).slice(0, 5), isActive: r.is_active };
                })
        );
        setTasks(
            (memberItems ?? [])
                .filter((i) => i.item_kind === 'task' && taskById.has(i.task_id))
                .map((i) => {
                    const tk = taskById.get(i.task_id);
                    return { itemId: i.id, taskId: tk.id, title: tk.title, isActive: tk.is_active };
                })
        );

        setStatus('ready');
    }, [routineInstanceId, t]);

    useEffect(() => { load(); }, [load]);

    function confirmArchive() {
        Alert.alert(
            t('routineDetails.archiveConfirmTitle'),
            t('routineDetails.archiveConfirmText'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                { text: t('routineDetails.archiveConfirmButton'), style: 'destructive', onPress: doArchive },
            ]
        );
    }

    async function doArchive() {
        if (archiving || !instance) return;
        setArchiving(true);
        const { error } = await supabase.rpc('archive_routine_instance', { p_routine_instance_id: instance.id });
        setArchiving(false);
        if (error) {
            showAlertOnce(t('routineDetails.loadFailedTitle'), error.message);
            return;
        }
        load();
    }

    async function doDuplicateAsTemplate() {
        if (duplicating || !instance) return;
        setDuplicating(true);

        const reminderIds = reminders.map((r) => r.reminderId);
        const taskIds = tasks.map((tk) => tk.taskId);
        const [{ data: reminderRows }, { data: taskRows }] = await Promise.all([
            reminderIds.length > 0
                ? supabase.from('reminders').select('title, notes, reminder_type, time_of_day, frequency, days_of_week, no_response_minutes').in('id', reminderIds)
                : Promise.resolve({ data: [] as any[] }),
            taskIds.length > 0
                ? supabase.from('tasks').select('title, notes, frequency, days_of_week').in('id', taskIds)
                : Promise.resolve({ data: [] as any[] }),
        ]);

        const items = [
            ...(reminderRows ?? []).map((r: any) => ({
                item_kind: 'reminder', title: r.title, notes: r.notes, enabled_by_default: true,
                frequency: r.frequency, days_of_week: r.days_of_week, start_offset_days: 0, due_offset_days: null,
                reminder_type: r.reminder_type, time_of_day: (r.time_of_day as string).slice(0, 5), no_response_minutes: r.no_response_minutes,
            })),
            ...(taskRows ?? []).map((tk: any) => ({
                item_kind: 'task', title: tk.title, notes: tk.notes, enabled_by_default: true,
                frequency: tk.frequency, days_of_week: tk.days_of_week, start_offset_days: 0, due_offset_days: null,
                reminder_type: null, time_of_day: null, no_response_minutes: null,
            })),
        ];

        const { error } = await supabase.rpc('create_routine_template', {
            p_title: instance.title,
            p_description: null,
            p_use_case: null,
            p_items: items,
        });
        setDuplicating(false);
        if (error) {
            showAlertOnce(t('routineDetails.loadFailedTitle'), error.message);
            return;
        }
        showAlertOnce(t('routineLibrary.myTemplatesSection'), t('routinePreview.savedAsTemplateSuccess'));
    }

    if (status === 'loading') return <ScreenLoadingState label={t('routineDetails.heading')} />;
    if (status === 'unauthorized') {
        return (
            <SafeAreaView style={styles.container}>
                <ErrorState title={t('routineDetails.unauthorizedTitle')} text={t('routineDetails.unauthorizedText')} />
            </SafeAreaView>
        );
    }
    if (status === 'error' || !instance) {
        return (
            <SafeAreaView style={styles.container}>
                <ErrorState title={t('routineDetails.loadFailedTitle')} onRetry={load} />
            </SafeAreaView>
        );
    }

    return (
        <SafeAreaView style={styles.container}>
            <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
                <View style={styles.header}>
                    <TouchableOpacity onPress={() => router.back()} accessibilityRole="button" accessibilityLabel={t('common.back')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                        <Ionicons name="chevron-back" size={24} color={C.primary} />
                    </TouchableOpacity>
                    <Text style={styles.heading} numberOfLines={1} accessibilityRole="header">{instance.title}</Text>
                    <View style={{ width: 24 }} />
                </View>

                <View style={styles.metaRow}>
                    <StatusBadge label={instance.status === 'active' ? t('routineDetails.activeStatus') : t('routineDetails.archivedStatus')} tone={instance.status === 'active' ? 'success' : 'neutral'} />
                </View>

                <Text style={styles.metaLine}>{t('routineDetails.appliedOn', { date: formatDateStringForDisplay(instance.created_at.slice(0, 10)) })}</Text>
                {isOrganizer
                    ? <Text style={styles.metaLine}>{t('routineDetails.participantLabel', { name: participantName })}</Text>
                    : <Text style={styles.metaLine}>{t('routineDetails.organizerLabel', { name: organizerName })}</Text>}
                {instance.built_in_pack_id && <Text style={styles.metaLine}>{t('routineDetails.sourceBuiltInLabel', { title: instance.title })}</Text>}

                {instance.status === 'archived' && (
                    <View style={styles.noticeCard}>
                        <Text style={styles.noticeText}>{t('routineDetails.archivedNotice')}</Text>
                    </View>
                )}
                {connectionEnded && instance.status === 'active' && (
                    <View style={styles.noticeCard}>
                        <Text style={styles.noticeText}>{t('routineDetails.connectionEndedNotice')}</Text>
                    </View>
                )}
                {sourceTemplateDeleted && (
                    <View style={styles.noticeCard}>
                        <Text style={styles.noticeText}>{t('routineDetails.sourceTemplateDeletedNotice')}</Text>
                    </View>
                )}

                {reminders.length > 0 && (
                    <View style={styles.section}>
                        <AccessibleSectionHeader title={t('routineDetails.remindersSection')} />
                        {reminders.map((r) => (
                            <TouchableOpacity
                                key={r.itemId}
                                style={[styles.itemRow, SHADOW.xs]}
                                onPress={() => router.push({ pathname: '/reminder-details', params: { reminderId: r.reminderId } })}
                                accessibilityRole="button"
                                accessibilityLabel={`${r.title}. ${t('routineDetails.viewDetails')}`}
                            >
                                <Text style={styles.itemTitle} numberOfLines={1}>{r.title}</Text>
                                <Text style={styles.itemMeta}>{r.timeOfDay}</Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                )}

                {tasks.length > 0 && (
                    <View style={styles.section}>
                        <AccessibleSectionHeader title={t('routineDetails.tasksSection')} />
                        {tasks.map((tk) => (
                            <TouchableOpacity
                                key={tk.itemId}
                                style={[styles.itemRow, SHADOW.xs]}
                                onPress={() => router.push({ pathname: '/task-details', params: { taskId: tk.taskId } })}
                                accessibilityRole="button"
                                accessibilityLabel={`${tk.title}. ${t('routineDetails.viewDetails')}`}
                            >
                                <Text style={styles.itemTitle} numberOfLines={1}>{tk.title}</Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                )}

                {reminders.length === 0 && tasks.length === 0 && (
                    <Text style={styles.emptyText}>{t('routineDetails.noItemsTitle')}</Text>
                )}

                {isOrganizer && (
                    <>
                        <TouchableOpacity
                            style={styles.secondaryButton}
                            onPress={doDuplicateAsTemplate}
                            disabled={duplicating}
                            accessibilityRole="button"
                            accessibilityLabel={t('routineDetails.duplicateAsTemplateAction')}
                        >
                            {duplicating ? <ActivityIndicator color={C.primary} /> : <Text style={styles.secondaryButtonText}>{t('routineDetails.duplicateAsTemplateAction')}</Text>}
                        </TouchableOpacity>

                        {instance.status === 'active' && (
                            <TouchableOpacity
                                style={styles.archiveButton}
                                onPress={confirmArchive}
                                disabled={archiving}
                                accessibilityRole="button"
                                accessibilityLabel={t('routineDetails.archiveAction')}
                            >
                                {archiving ? <ActivityIndicator color={C.error} /> : <Text style={styles.archiveButtonText}>{t('routineDetails.archiveAction')}</Text>}
                            </TouchableOpacity>
                        )}
                    </>
                )}
            </ScrollView>
        </SafeAreaView>
    );
}

function createStyles(C: ThemeColors) {
    return StyleSheet.create({
        container: { flex: 1, backgroundColor: C.bgPage },
        content: { padding: 20, paddingBottom: 48 },
        header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
        heading: { fontSize: 20, fontWeight: '700', color: C.textPrimary, flex: 1, textAlign: 'center' },
        metaRow: { flexDirection: 'row', marginBottom: 8 },
        metaLine: { fontSize: 13, color: C.textSecondary, marginTop: 2 },
        noticeCard: { backgroundColor: C.bgAlt, borderRadius: RADIUS.md, padding: 12, marginTop: 12 },
        noticeText: { fontSize: 13, color: C.textSecondary },
        section: { marginTop: 20 },
        itemRow: { backgroundColor: C.bgSurface, borderRadius: RADIUS.md, padding: 14, marginTop: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 },
        itemTitle: { fontSize: 15, fontWeight: '600', color: C.textPrimary, flexShrink: 1 },
        itemMeta: { fontSize: 13, color: C.textMuted },
        emptyText: { fontSize: 14, color: C.textMuted, marginTop: 20, textAlign: 'center' },
        secondaryButton: { marginTop: 24, paddingVertical: 14, alignItems: 'center', borderRadius: RADIUS.md, backgroundColor: C.bgAlt, minHeight: 44 },
        secondaryButtonText: { fontSize: 15, fontWeight: '600', color: C.primary },
        archiveButton: { marginTop: 12, paddingVertical: 14, alignItems: 'center', borderRadius: RADIUS.md, backgroundColor: C.errorLight, minHeight: 44 },
        archiveButtonText: { fontSize: 15, fontWeight: '700', color: C.error },
    });
}
