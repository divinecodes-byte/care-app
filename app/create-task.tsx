import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
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

import { AccessibleIconButton, SelectionCard } from '@/components/AccessiblePrimitives';
import { DatePickerField, formatDateStringForDisplay, todayDateString } from '@/components/DatePickerField';
import { RADIUS, ThemeColors } from '@/constants/theme';
import { classifyScreenError } from '@/lib/asyncStateCore';
import { ERROR_CATEGORY_TRANSLATION_KEYS } from '@/lib/errorClassification';
import { DAY_ISO_TO_KEY, DAY_OPTIONS, daysForFrequency } from '@/lib/frequency';
import { useTranslation } from '@/lib/i18n/context';
import { getExampleReminderTitleKey, isUseCase, logOnboardingEvent, UseCase } from '@/lib/onboarding';
import { showAlertOnce } from '@/lib/alertGuard';
import { supabase } from '@/lib/supabase';
import { useThemeColors } from '@/lib/theme';
import { useFocusOnChange } from '@/lib/useAccessibilityFocus';

type TaskFrequency = 'one_time' | 'daily' | 'weekdays' | 'weekends' | 'custom';

type ParticipantOption = {
    connectionId: string;
    recipientId: string;
    recipientName: string;
};

const FREQUENCY_LABEL_KEYS: Record<TaskFrequency, string> = {
    one_time: 'taskForm.scheduleOneTime',
    daily: 'taskForm.scheduleDaily',
    weekdays: 'taskForm.scheduleWeekdays',
    weekends: 'taskForm.scheduleWeekends',
    custom: 'taskForm.scheduleCustom',
};
const FREQUENCIES: TaskFrequency[] = ['one_time', 'daily', 'weekdays', 'weekends', 'custom'];

export default function CreateTaskScreen() {
    const C = useThemeColors();
    const t = useTranslation();
    const styles = useMemo(() => createStyles(C), [C]);
    const { connectionId: preselectConnectionId } = useLocalSearchParams<{ connectionId?: string }>();

    const [participants, setParticipants] = useState<ParticipantOption[]>([]);
    const [participantsLoading, setParticipantsLoading] = useState(true);
    const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);

    const [title, setTitle] = useState('');
    const [notes, setNotes] = useState('');
    const [frequency, setFrequency] = useState<TaskFrequency>('one_time');
    const [selectedDays, setSelectedDays] = useState<number[]>([]);
    const [startDate, setStartDate] = useState(todayDateString());
    const [dueDate, setDueDate] = useState<string | null>(null);
    const [recurrenceEndDate, setRecurrenceEndDate] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [useCase, setUseCase] = useState<UseCase | null>(null);
    const [savedSummary, setSavedSummary] = useState<{
        title: string;
        recipientName: string;
        scheduleLabel: string;
    } | null>(null);
    const confirmHeadingRef = useFocusOnChange<Text>(savedSummary);

    useEffect(() => {
        (async () => {
            setParticipantsLoading(true);
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) { setParticipantsLoading(false); return; }

            const { data: ownProfile } = await supabase.from('profiles').select('use_case').eq('id', user.id).maybeSingle();
            if (ownProfile?.use_case && isUseCase(ownProfile.use_case)) setUseCase(ownProfile.use_case);

            const { data: connections } = await supabase
                .from('connections')
                .select('id, recipient_id')
                .eq('caregiver_id', user.id)
                .eq('status', 'accepted')
                .not('recipient_id', 'is', null);

            const accepted = connections ?? [];
            if (accepted.length === 0) {
                setParticipants([]);
                setParticipantsLoading(false);
                return;
            }

            const recipientIds = accepted.map((c) => c.recipient_id as string);
            const { data: profiles } = await supabase.from('profiles').select('id, full_name').in('id', recipientIds);
            const nameById = new Map((profiles ?? []).map((p) => [p.id, p.full_name]));

            const options: ParticipantOption[] = accepted.map((c) => ({
                connectionId: c.id,
                recipientId: c.recipient_id as string,
                recipientName: nameById.get(c.recipient_id as string) || t('common.participant'),
            }));

            setParticipants(options);
            const preselect = options.find((o) => o.connectionId === preselectConnectionId);
            setSelectedConnectionId(preselect?.connectionId ?? (options.length === 1 ? options[0].connectionId : null));
            setParticipantsLoading(false);
        })();
    }, [preselectConnectionId]);

    function toggleDay(iso: number) {
        setSelectedDays((prev) => (prev.includes(iso) ? prev.filter((d) => d !== iso) : [...prev, iso]));
    }

    function scheduleLabelFor(freq: TaskFrequency): string {
        if (freq === 'one_time') return formatDateStringForDisplay(startDate);
        return t(FREQUENCY_LABEL_KEYS[freq]);
    }

    async function saveTask() {
        if (loading) return;

        const selected = participants.find((p) => p.connectionId === selectedConnectionId);
        if (!selected) {
            showAlertOnce(t('taskForm.chooseParticipantTitle'), t('taskForm.chooseParticipantMessage'));
            return;
        }
        if (!title.trim()) {
            showAlertOnce(t('taskForm.missingTitleTitle'), t('taskForm.missingTitleMessage'));
            return;
        }
        if (frequency === 'custom' && selectedDays.length === 0) {
            showAlertOnce(t('taskForm.selectDayTitle'), t('taskForm.selectDayMessage'));
            return;
        }
        if (frequency === 'one_time' && dueDate && dueDate < startDate) {
            showAlertOnce(t('taskForm.dueBeforeStartTitle'), t('taskForm.dueBeforeStartMessage'));
            return;
        }
        if (frequency !== 'one_time' && recurrenceEndDate && recurrenceEndDate < startDate) {
            showAlertOnce(t('taskForm.recurrenceEndBeforeStartTitle'), t('taskForm.recurrenceEndBeforeStartMessage'));
            return;
        }

        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        setLoading(true);

        const { data: { user }, error: userError } = await supabase.auth.getUser();
        if (userError || !user) {
            setLoading(false);
            showAlertOnce(t('taskForm.notSignedInTitle'), t('taskForm.notSignedInMessage'));
            return;
        }

        const resolvedDays = frequency === 'one_time' || frequency === 'custom' ? selectedDays : daysForFrequency(frequency as any, selectedDays);

        const { data, error } = await supabase.rpc('create_task', {
            p_connection_id: selected.connectionId,
            p_title: title.trim(),
            p_notes: notes.trim() || null,
            p_frequency: frequency,
            p_days_of_week: frequency === 'one_time' ? [] : resolvedDays,
            p_start_date: startDate,
            p_due_date: frequency === 'one_time' ? dueDate : null,
            p_recurrence_end_date: frequency === 'one_time' ? null : recurrenceEndDate,
        });

        setLoading(false);

        if (error || !data) {
            if (error?.message === 'connection_inactive') {
                showAlertOnce(t('taskForm.connectionEndedTitle'), t('taskForm.connectionEndedMessage'));
                router.replace('/participants');
                return;
            }
            showAlertOnce(t('taskForm.errorTitle'), t(ERROR_CATEGORY_TRANSLATION_KEYS[classifyScreenError(error?.message)]));
            return;
        }

        logOnboardingEvent('first_reminder_created');

        setSavedSummary({
            title: title.trim(),
            recipientName: selected.recipientName,
            scheduleLabel: scheduleLabelFor(frequency),
        });
    }

    if (savedSummary) {
        return (
            <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
                <View style={styles.confirmContent}>
                    <View style={styles.confirmIconWrap}>
                        <Ionicons name="checkmark-circle" size={48} color={C.success} />
                    </View>
                    <Text ref={confirmHeadingRef as any} style={styles.confirmHeading} accessibilityRole="header">
                        {t('taskForm.savedTitle')}
                    </Text>
                    <Text style={styles.confirmSubtitle}>{t('taskForm.savedMessage', { name: savedSummary.recipientName })}</Text>
                    <View style={styles.confirmCard}>
                        <Text style={styles.confirmTaskTitle}>{savedSummary.title}</Text>
                        <Text style={styles.confirmScheduleLine}>{savedSummary.scheduleLabel}</Text>
                    </View>
                    <TouchableOpacity
                        style={styles.primaryButton}
                        onPress={() => router.replace('/caregiver-dashboard')}
                        accessibilityRole="button"
                        accessibilityLabel={t('taskForm.backToDashboard')}
                    >
                        <Text style={styles.primaryButtonText}>{t('taskForm.backToDashboard')}</Text>
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
                    <Text style={styles.headerTitle} accessibilityRole="header">{t('taskForm.createHeading')}</Text>
                    <View style={{ width: 44 }} />
                </View>
                <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
                    <Text style={styles.subheading}>{t('taskForm.createSubheading')}</Text>

                    {participantsLoading ? (
                        <ActivityIndicator color={C.primary} style={{ marginVertical: 20 }} />
                    ) : participants.length === 0 ? (
                        <Text style={styles.emptyParticipants}>{t('reminderForm.noParticipantsText')}</Text>
                    ) : (
                        <>
                            <Text style={styles.sectionLabel}>{t('taskForm.whoIsThisFor')}</Text>
                            <View style={styles.chipRow}>
                                {participants.map((p) => (
                                    <SelectionCard
                                        key={p.connectionId}
                                        label={p.recipientName}
                                        selected={selectedConnectionId === p.connectionId}
                                        onPress={() => setSelectedConnectionId(p.connectionId)}
                                    />
                                ))}
                            </View>
                        </>
                    )}

                    <Text style={styles.sectionLabel}>{t('taskForm.sectionWhat')}</Text>
                    <Text style={styles.fieldLabel}>{t('taskForm.nameLabel')}</Text>
                    <TextInput
                        style={styles.textInput}
                        value={title}
                        onChangeText={setTitle}
                        placeholder={useCase ? t(getExampleReminderTitleKey(useCase)) : t('taskForm.namePlaceholder')}
                        placeholderTextColor={C.textMuted}
                        accessibilityLabel={t('taskForm.nameLabel')}
                    />
                    <Text style={styles.fieldLabel}>{t('taskForm.notesLabel')} ({t('taskForm.notesOptional')})</Text>
                    <TextInput
                        style={[styles.textInput, styles.notesInput]}
                        value={notes}
                        onChangeText={setNotes}
                        placeholder={t('taskForm.notesPlaceholder')}
                        placeholderTextColor={C.textMuted}
                        multiline
                        accessibilityLabel={t('taskForm.notesLabel')}
                    />

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

                    <Text style={styles.fieldLabel}>{t('taskForm.startDateLabel')}</Text>
                    <DatePickerField value={startDate} onChange={(d) => setStartDate(d ?? todayDateString())} label={t('taskForm.startDateLabel')} />

                    {frequency === 'one_time' ? (
                        <>
                            <Text style={styles.fieldLabel}>{t('taskForm.dueDateLabel')} ({t('taskForm.dueDateOptional')})</Text>
                            <DatePickerField
                                value={dueDate}
                                onChange={setDueDate}
                                label={t('taskForm.dueDateLabel')}
                                minDate={startDate}
                                allowClear
                                placeholder={t('datePicker.notSet')}
                            />
                        </>
                    ) : (
                        <>
                            <Text style={styles.fieldLabel}>{t('taskForm.recurrenceEndDateLabel')} ({t('taskForm.recurrenceEndDateOptional')})</Text>
                            <DatePickerField
                                value={recurrenceEndDate}
                                onChange={setRecurrenceEndDate}
                                label={t('taskForm.recurrenceEndDateLabel')}
                                minDate={startDate}
                                allowClear
                                placeholder={t('datePicker.notSet')}
                            />
                        </>
                    )}

                    {participants.find((p) => p.connectionId === selectedConnectionId) ? (
                        <Text style={styles.participantWillReceive}>
                            {t('taskForm.participantWillReceive', { name: participants.find((p) => p.connectionId === selectedConnectionId)!.recipientName })}
                        </Text>
                    ) : null}

                    <TouchableOpacity
                        style={[styles.primaryButton, loading && styles.primaryButtonDisabled]}
                        onPress={saveTask}
                        disabled={loading}
                        accessibilityRole="button"
                        accessibilityLabel={t('taskForm.saveTask')}
                        accessibilityState={{ disabled: loading, busy: loading }}
                    >
                        {loading ? <ActivityIndicator color={C.textInverse} /> : <Text style={styles.primaryButtonText}>{t('taskForm.saveTask')}</Text>}
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
    subheading: { fontSize: 14, color: C.textSecondary, marginBottom: 20, lineHeight: 20 },
    sectionLabel: { fontSize: 13, fontWeight: '800', color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 20, marginBottom: 10 },
    fieldLabel: { fontSize: 14, fontWeight: '700', color: C.textPrimary, marginBottom: 8, marginTop: 14 },
    textInput: {
        backgroundColor: C.bgAlt,
        borderRadius: RADIUS.lg,
        paddingHorizontal: 14,
        paddingVertical: 12,
        fontSize: 16,
        color: C.textPrimary,
        minHeight: 44,
    },
    notesInput: { minHeight: 80, textAlignVertical: 'top' },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    dayRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
    dayChip: { minWidth: 44, minHeight: 44, paddingHorizontal: 12, borderRadius: RADIUS.lg, backgroundColor: C.bgSurface, borderWidth: 1.5, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
    dayChipSelected: { borderColor: C.primary, backgroundColor: C.primaryLight },
    dayChipText: { fontSize: 13, fontWeight: '700', color: C.textSecondary },
    dayChipTextSelected: { color: C.primary },
    participantWillReceive: { fontSize: 13, color: C.textSecondary, marginTop: 18, textAlign: 'center' },
    emptyParticipants: { fontSize: 14, color: C.textSecondary, marginVertical: 12 },
    primaryButton: { backgroundColor: C.primary, borderRadius: RADIUS.xl, minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingVertical: 16, marginTop: 28 },
    primaryButtonDisabled: { opacity: 0.7 },
    primaryButtonText: { color: C.textInverse, fontSize: 16, fontWeight: '800' },

    confirmContent: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
    confirmIconWrap: { marginBottom: 16 },
    confirmHeading: { fontSize: 22, fontWeight: '800', color: C.textPrimary, marginBottom: 8, textAlign: 'center' },
    confirmSubtitle: { fontSize: 15, color: C.textSecondary, textAlign: 'center', marginBottom: 24 },
    confirmCard: { backgroundColor: C.bgSurface, borderRadius: RADIUS.xl, padding: 20, width: '100%', marginBottom: 24 },
    confirmTaskTitle: { fontSize: 17, fontWeight: '800', color: C.textPrimary, marginBottom: 6 },
    confirmScheduleLine: { fontSize: 14, color: C.textSecondary },
});
