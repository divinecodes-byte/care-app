import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
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

import { AccessibleIconButton, SelectionCard } from '@/components/AccessiblePrimitives';
import { DatePickerField, formatDateStringForDisplay } from '@/components/DatePickerField';
import { ScreenLoadingState } from '@/components/StateViews';
import { RADIUS, ThemeColors } from '@/constants/theme';
import { classifyScreenError } from '@/lib/asyncStateCore';
import { ERROR_CATEGORY_TRANSLATION_KEYS } from '@/lib/errorClassification';
import { DAY_ISO_TO_KEY, DAY_OPTIONS, daysForFrequency } from '@/lib/frequency';
import { useTranslation } from '@/lib/i18n/context';
import { showAlertOnce } from '@/lib/alertGuard';
import { supabase } from '@/lib/supabase';
import { useThemeColors } from '@/lib/theme';

type TaskFrequency = 'one_time' | 'daily' | 'weekdays' | 'weekends' | 'custom';

const FREQUENCY_LABEL_KEYS: Record<TaskFrequency, string> = {
    one_time: 'taskForm.scheduleOneTime',
    daily: 'taskForm.scheduleDaily',
    weekdays: 'taskForm.scheduleWeekdays',
    weekends: 'taskForm.scheduleWeekends',
    custom: 'taskForm.scheduleCustom',
};
const FREQUENCIES: TaskFrequency[] = ['daily', 'weekdays', 'weekends', 'custom'];

type TaskRow = {
    id: string;
    title: string;
    notes: string | null;
    frequency: TaskFrequency;
    days_of_week: number[];
    start_date: string;
    due_date: string | null;
    recurrence_end_date: string | null;
    is_active: boolean;
    recipient_id: string;
};

export default function EditTaskScreen() {
    const C = useThemeColors();
    const t = useTranslation();
    const styles = useMemo(() => createStyles(C), [C]);
    const { taskId } = useLocalSearchParams<{ taskId?: string }>();

    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [task, setTask] = useState<TaskRow | null>(null);
    const [recipientName, setRecipientName] = useState('');

    const [title, setTitle] = useState('');
    const [notes, setNotes] = useState('');
    const [frequency, setFrequency] = useState<TaskFrequency>('daily');
    const [selectedDays, setSelectedDays] = useState<number[]>([]);
    const [dueDate, setDueDate] = useState<string | null>(null);
    const [recurrenceEndDate, setRecurrenceEndDate] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        (async () => {
            if (!taskId) { setLoadError(t('taskForm.notFoundOrNoPermission')); setLoading(false); return; }
            const { data, error } = await supabase.from('tasks').select('*').eq('id', taskId).maybeSingle();
            if (error || !data) {
                setLoadError(t('taskForm.notFoundOrNoPermission'));
                setLoading(false);
                return;
            }
            const row = data as TaskRow;
            setTask(row);
            setTitle(row.title);
            setNotes(row.notes ?? '');
            if (row.frequency !== 'one_time') {
                setFrequency(row.frequency);
                setSelectedDays(row.days_of_week);
            }
            setDueDate(row.due_date);
            setRecurrenceEndDate(row.recurrence_end_date);

            const { data: profile } = await supabase.from('profiles').select('full_name').eq('id', row.recipient_id).maybeSingle();
            setRecipientName(profile?.full_name || t('common.participant'));
            setLoading(false);
        })();
    }, [taskId]);

    function toggleDay(iso: number) {
        setSelectedDays((prev) => (prev.includes(iso) ? prev.filter((d) => d !== iso) : [...prev, iso]));
    }

    async function saveChanges() {
        if (!task || saving) return;

        if (!title.trim()) {
            showAlertOnce(t('taskForm.missingTitleTitle'), t('taskForm.missingTitleMessage'));
            return;
        }
        if (task.frequency !== 'one_time' && frequency === 'custom' && selectedDays.length === 0) {
            showAlertOnce(t('taskForm.selectDayTitle'), t('taskForm.selectDayMessage'));
            return;
        }
        if (task.frequency === 'one_time' && dueDate && dueDate < task.start_date) {
            showAlertOnce(t('taskForm.dueBeforeStartTitle'), t('taskForm.dueBeforeStartMessage'));
            return;
        }
        if (task.frequency !== 'one_time' && recurrenceEndDate && recurrenceEndDate < task.start_date) {
            showAlertOnce(t('taskForm.recurrenceEndBeforeStartTitle'), t('taskForm.recurrenceEndBeforeStartMessage'));
            return;
        }

        setSaving(true);
        const effectiveFrequency = task.frequency === 'one_time' ? 'one_time' : frequency;
        const resolvedDays = effectiveFrequency === 'one_time'
            ? []
            : effectiveFrequency === 'custom'
                ? selectedDays
                : daysForFrequency(effectiveFrequency as any, selectedDays);

        const { data, error } = await supabase.rpc('update_task', {
            p_task_id: task.id,
            p_title: title.trim(),
            p_notes: notes.trim() || null,
            p_frequency: effectiveFrequency,
            p_days_of_week: resolvedDays,
            p_due_date: task.frequency === 'one_time' ? dueDate : null,
            p_recurrence_end_date: task.frequency === 'one_time' ? null : recurrenceEndDate,
        });

        setSaving(false);

        if (error || !data) {
            if (error?.message === 'connection_inactive') {
                showAlertOnce(t('taskForm.connectionEndedTitle'), t('taskForm.connectionEndedMessage'));
                router.replace('/participants');
                return;
            }
            showAlertOnce(t('taskForm.errorTitle'), t(ERROR_CATEGORY_TRANSLATION_KEYS[classifyScreenError(error?.message)]));
            return;
        }

        router.back();
    }

    function confirmArchive() {
        if (!task) return;
        Alert.alert(t('taskForm.archiveConfirmTitle'), t('taskForm.archiveConfirmMessage'), [
            { text: t('taskForm.cancel'), style: 'cancel' },
            { text: t('taskForm.archive'), style: 'destructive', onPress: doArchive },
        ]);
    }

    async function doArchive() {
        if (!task) return;
        setSaving(true);
        const { error } = await supabase.rpc('archive_task', { p_task_id: task.id });
        setSaving(false);
        if (error) {
            showAlertOnce(t('taskForm.errorTitle'), t(ERROR_CATEGORY_TRANSLATION_KEYS[classifyScreenError(error.message)]));
            return;
        }
        router.replace('/caregiver-dashboard');
    }

    if (loading) {
        return (
            <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
                <ScreenLoadingState label={t('taskForm.loadingTask')} />
            </SafeAreaView>
        );
    }

    if (loadError || !task) {
        return (
            <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
                <View style={styles.centerContent}>
                    <Text style={styles.errorText}>{loadError}</Text>
                    <TouchableOpacity onPress={() => router.back()} accessibilityRole="button" accessibilityLabel={t('taskForm.goBack')}>
                        <Text style={styles.linkText}>{t('taskForm.goBack')}</Text>
                    </TouchableOpacity>
                </View>
            </SafeAreaView>
        );
    }

    return (
        <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
            <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
                <View style={styles.header}>
                    <AccessibleIconButton icon="arrow-back" label={t('taskForm.back')} onPress={() => router.back()} />
                    <Text style={styles.headerTitle} accessibilityRole="header">{t('taskForm.editHeading')}</Text>
                    <View style={{ width: 44 }} />
                </View>
                <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
                    <Text style={styles.subheading}>{t('taskForm.editSubheading')}</Text>
                    <Text style={styles.forLine}>{t('taskForm.forLabel')}: {recipientName}</Text>

                    <Text style={styles.fieldLabel}>{t('taskForm.nameLabel')}</Text>
                    <TextInput
                        style={styles.textInput}
                        value={title}
                        onChangeText={setTitle}
                        accessibilityLabel={t('taskForm.nameLabel')}
                    />
                    <Text style={styles.fieldLabel}>{t('taskForm.notesLabel')} ({t('taskForm.notesOptional')})</Text>
                    <TextInput
                        style={[styles.textInput, styles.notesInput]}
                        value={notes}
                        onChangeText={setNotes}
                        multiline
                        accessibilityLabel={t('taskForm.notesLabel')}
                    />

                    {task.frequency === 'one_time' ? (
                        <>
                            <Text style={styles.fieldLabel}>{t('taskForm.startDateLabel')}</Text>
                            <Text style={styles.immutableValue}>{formatDateStringForDisplay(task.start_date)}</Text>
                            <Text style={styles.fieldLabel}>{t('taskForm.dueDateLabel')} ({t('taskForm.dueDateOptional')})</Text>
                            <DatePickerField
                                value={dueDate}
                                onChange={setDueDate}
                                label={t('taskForm.dueDateLabel')}
                                minDate={task.start_date}
                                allowClear
                            />
                        </>
                    ) : (
                        <>
                            <Text style={styles.sectionLabel}>{t('taskForm.sectionSchedule')}</Text>
                            <View style={styles.chipRow}>
                                {FREQUENCIES.map((f) => (
                                    <SelectionCard
                                        key={f}
                                        label={t(FREQUENCY_LABEL_KEYS[f])}
                                        selected={frequency === f}
                                        onPress={() => setFrequency(f)}
                                    />
                                ))}
                            </View>
                            {frequency === 'custom' ? (
                                <View style={styles.dayRow}>
                                    {DAY_OPTIONS.map((day) => (
                                        <TouchableOpacity
                                            key={day.iso}
                                            style={[styles.dayChip, selectedDays.includes(day.iso) && styles.dayChipSelected]}
                                            onPress={() => toggleDay(day.iso)}
                                            accessibilityRole="checkbox"
                                            accessibilityLabel={t(`reminderForm.day${DAY_ISO_TO_KEY[day.iso]}`)}
                                            accessibilityState={{ checked: selectedDays.includes(day.iso) }}
                                        >
                                            <Text style={[styles.dayChipText, selectedDays.includes(day.iso) && styles.dayChipTextSelected]}>
                                                {t(`reminderForm.day${DAY_ISO_TO_KEY[day.iso]}`)}
                                            </Text>
                                        </TouchableOpacity>
                                    ))}
                                </View>
                            ) : null}
                            <Text style={styles.fieldLabel}>{t('taskForm.recurrenceEndDateLabel')} ({t('taskForm.recurrenceEndDateOptional')})</Text>
                            <DatePickerField
                                value={recurrenceEndDate}
                                onChange={setRecurrenceEndDate}
                                label={t('taskForm.recurrenceEndDateLabel')}
                                minDate={task.start_date}
                                allowClear
                            />
                        </>
                    )}

                    <TouchableOpacity
                        style={[styles.primaryButton, saving && styles.primaryButtonDisabled]}
                        onPress={saveChanges}
                        disabled={saving}
                        accessibilityRole="button"
                        accessibilityLabel={t('taskForm.saveChanges')}
                        accessibilityState={{ disabled: saving, busy: saving }}
                    >
                        {saving ? <ActivityIndicator color={C.textInverse} /> : <Text style={styles.primaryButtonText}>{t('taskForm.saveChanges')}</Text>}
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={styles.archiveButton}
                        onPress={confirmArchive}
                        disabled={saving}
                        accessibilityRole="button"
                        accessibilityLabel={t('taskForm.archiveTask')}
                    >
                        <Ionicons name="archive-outline" size={16} color={C.error} />
                        <Text style={styles.archiveButtonText}>{t('taskForm.archiveTask')}</Text>
                    </TouchableOpacity>
                </ScrollView>
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}

const createStyles = (C: ThemeColors) => StyleSheet.create({
    container: { flex: 1, backgroundColor: C.bgPage },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingTop: 4 },
    headerTitle: { fontSize: 17, fontWeight: '800', color: C.textPrimary },
    scrollContent: { paddingHorizontal: 24, paddingBottom: 60 },
    subheading: { fontSize: 14, color: C.textSecondary, marginBottom: 6, lineHeight: 20 },
    forLine: { fontSize: 13, color: C.textMuted, marginBottom: 16, fontWeight: '600' },
    sectionLabel: { fontSize: 13, fontWeight: '800', color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 20, marginBottom: 10 },
    fieldLabel: { fontSize: 14, fontWeight: '700', color: C.textPrimary, marginBottom: 8, marginTop: 14 },
    immutableValue: { fontSize: 15, color: C.textSecondary, marginBottom: 4 },
    textInput: { backgroundColor: C.bgAlt, borderRadius: RADIUS.lg, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, color: C.textPrimary, minHeight: 44 },
    notesInput: { minHeight: 80, textAlignVertical: 'top' },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    dayRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
    dayChip: { minWidth: 44, minHeight: 44, paddingHorizontal: 12, borderRadius: RADIUS.lg, backgroundColor: C.bgSurface, borderWidth: 1.5, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
    dayChipSelected: { borderColor: C.primary, backgroundColor: C.primaryLight },
    dayChipText: { fontSize: 13, fontWeight: '700', color: C.textSecondary },
    dayChipTextSelected: { color: C.primary },
    primaryButton: { backgroundColor: C.primary, borderRadius: RADIUS.xl, minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingVertical: 16, marginTop: 28 },
    primaryButtonDisabled: { opacity: 0.7 },
    primaryButtonText: { color: C.textInverse, fontSize: 16, fontWeight: '800' },
    archiveButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 44, marginTop: 18 },
    archiveButtonText: { color: C.error, fontSize: 14, fontWeight: '700' },
    centerContent: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
    errorText: { fontSize: 15, color: C.textSecondary, textAlign: 'center', marginBottom: 16 },
    linkText: { fontSize: 15, color: C.primary, fontWeight: '700' },
});
