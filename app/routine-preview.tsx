import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    KeyboardAvoidingView,
    Platform,
    ScrollView,
    StyleSheet,
    Switch,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { StatusBadge } from '@/components/AccessiblePrimitives';
import { buildTimeString, parseTimeString, TimePickerField } from '@/components/TimePickerField';
import { addDaysToDateString, DatePickerField, formatDateStringForDisplay, todayDateString } from '@/components/DatePickerField';
import { ScreenLoadingState, SectionErrorState } from '@/components/StateViews';
import { RADIUS, SHADOW, ThemeColors } from '@/constants/theme';
import { DAY_ISO_TO_KEY, DAY_OPTIONS } from '@/lib/frequency';
import { useTranslation } from '@/lib/i18n/context';
import { showAlertOnce } from '@/lib/alertGuard';
import { NO_RESPONSE_OPTIONS } from '@/lib/reminderOptions';
import { expandBuiltInPackItem, getBuiltInPack } from '@/lib/routineCatalog';
import {
    ApplyItem,
    dateStringDiffDays,
    generateApplyRequestId,
    resolveTemplateItemToApplyItem,
    RoutineTemplateItem,
    summarizeItemCounts,
    TemplateItemDraft,
    validateApplyItems,
} from '@/lib/routineCore';
import { supabase } from '@/lib/supabase';
import { isValidIanaTimezone } from '@/lib/timezone';
import { useThemeColors } from '@/lib/theme';

type DraftItem = TemplateItemDraft & { enabled: boolean };
type ParticipantOption = { connectionId: string; recipientId: string; recipientName: string };

const ROUTINE_ERROR_MESSAGE_KEYS: Record<string, string> = {
    organizer_role_required: 'routinePreview.applyErrorTitle',
    connection_inactive: 'routinePreview.connectionEndedText',
    participant_timezone_unavailable: 'routinePreview.timezoneUnavailableText',
    template_archived: 'routinePreview.applyErrorTitle',
    template_revision_changed: 'routinePreview.applyErrorTitle',
    template_not_found: 'routinePreview.applyErrorTitle',
    invalid_item_count: 'routinePreview.applyErrorTitle',
    not_authorized: 'routinePreview.applyErrorTitle',
};

function dbItemToDraft(row: any): DraftItem {
    return {
        sourceItemKey: row.id,
        itemKind: row.item_kind,
        title: row.title,
        notes: row.notes,
        enabledByDefault: row.enabled_by_default,
        enabled: row.enabled_by_default,
        frequency: row.frequency,
        daysOfWeek: row.days_of_week ?? [],
        startOffsetDays: row.start_offset_days ?? 0,
        ...(row.item_kind === 'reminder'
            ? { reminderType: row.reminder_type, timeOfDay: (row.time_of_day as string).slice(0, 5), noResponseMinutes: row.no_response_minutes }
            : { dueOffsetDays: row.due_offset_days }),
    } as DraftItem;
}

function draftToTemplatePayload(item: DraftItem) {
    return {
        item_kind: item.itemKind,
        title: item.title,
        notes: item.notes,
        enabled_by_default: item.enabled,
        frequency: item.frequency,
        days_of_week: item.daysOfWeek,
        start_offset_days: item.startOffsetDays,
        due_offset_days: item.itemKind === 'task' ? item.dueOffsetDays : null,
        reminder_type: item.itemKind === 'reminder' ? item.reminderType : null,
        time_of_day: item.itemKind === 'reminder' ? item.timeOfDay : null,
        no_response_minutes: item.itemKind === 'reminder' ? item.noResponseMinutes : null,
    };
}

export default function RoutinePreviewScreen() {
    const C = useThemeColors();
    const t = useTranslation();
    const styles = useMemo(() => createStyles(C), [C]);
    const { builtInPackId, templateId, connectionId: preselectConnectionId } = useLocalSearchParams<{
        builtInPackId?: string; templateId?: string; connectionId?: string;
    }>();

    const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
    const [routineTitle, setRoutineTitle] = useState('');
    const [sourceTemplateId, setSourceTemplateId] = useState<string | null>(null);
    const [sourceTemplateRevision, setSourceTemplateRevision] = useState<number | null>(null);
    const [sourceBuiltInPackId, setSourceBuiltInPackId] = useState<string | null>(null);
    const [sourceBuiltInPackVersion, setSourceBuiltInPackVersion] = useState<string | null>(null);
    const [items, setItems] = useState<DraftItem[]>([]);
    const [startDate, setStartDate] = useState(todayDateString());

    const [participants, setParticipants] = useState<ParticipantOption[]>([]);
    const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
    const [connectionEnded, setConnectionEnded] = useState(false);
    const [participantTimezone, setParticipantTimezone] = useState<string | null>(null);
    const [timezoneUnavailable, setTimezoneUnavailable] = useState(false);

    const [hasEdited, setHasEdited] = useState(false);
    const [applying, setApplying] = useState(false);
    const [applyError, setApplyError] = useState<string | null>(null);
    const [savingTemplate, setSavingTemplate] = useState(false);
    const applyRequestIdRef = useRef<string>(generateApplyRequestId());

    useEffect(() => {
        (async () => {
            setStatus('loading');

            if (builtInPackId) {
                const pack = getBuiltInPack(builtInPackId);
                if (!pack) { setStatus('error'); return; }
                setRoutineTitle(t(pack.titleKey));
                setSourceBuiltInPackId(pack.packId);
                setSourceBuiltInPackVersion(pack.version);
                setItems(pack.items.map((raw) => {
                    const draft = expandBuiltInPackItem(raw, t);
                    return { ...draft, enabled: draft.enabledByDefault };
                }));
            } else if (templateId) {
                const { data: template, error: templateError } = await supabase
                    .from('routine_templates')
                    .select('id, title, revision, status')
                    .eq('id', templateId)
                    .maybeSingle();
                if (templateError || !template) { setStatus('error'); return; }
                const { data: itemRows, error: itemsError } = await supabase
                    .from('routine_template_items')
                    .select('id, item_kind, display_order, title, notes, enabled_by_default, frequency, days_of_week, start_offset_days, due_offset_days, reminder_type, time_of_day, no_response_minutes')
                    .eq('template_id', templateId)
                    .order('display_order', { ascending: true });
                if (itemsError) { setStatus('error'); return; }
                setRoutineTitle(template.title);
                setSourceTemplateId(template.id);
                setSourceTemplateRevision(template.revision);
                setItems((itemRows ?? []).map(dbItemToDraft));
            } else {
                setStatus('error');
                return;
            }

            const { data: { user } } = await supabase.auth.getUser();
            if (!user) { setStatus('error'); return; }

            const { data: connections } = await supabase
                .from('connections')
                .select('id, recipient_id, status')
                .eq('caregiver_id', user.id)
                .eq('status', 'accepted')
                .not('recipient_id', 'is', null);

            const accepted = connections ?? [];
            const recipientIds = accepted.map((c) => c.recipient_id as string);
            const { data: profiles } = recipientIds.length > 0
                ? await supabase.from('profiles').select('id, full_name').in('id', recipientIds)
                : { data: [] as { id: string; full_name: string | null }[] };
            const nameById = new Map((profiles ?? []).map((p) => [p.id, p.full_name]));

            const options: ParticipantOption[] = accepted.map((c) => ({
                connectionId: c.id,
                recipientId: c.recipient_id as string,
                recipientName: nameById.get(c.recipient_id as string) || t('common.participant'),
            }));
            setParticipants(options);

            const preselect = options.find((o) => o.connectionId === preselectConnectionId);
            setSelectedConnectionId(preselect?.connectionId ?? (options.length === 1 ? options[0].connectionId : null));

            setStatus('ready');
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [builtInPackId, templateId]);

    // Re-validate the selected connection + participant timezone every time
    // the selection changes — never carries a stale prior selection's
    // state forward.
    useEffect(() => {
        setConnectionEnded(false);
        setParticipantTimezone(null);
        setTimezoneUnavailable(false);
        if (!selectedConnectionId) return;
        (async () => {
            const { data: connection } = await supabase.from('connections').select('status, recipient_id').eq('id', selectedConnectionId).maybeSingle();
            if (!connection || connection.status !== 'accepted') { setConnectionEnded(true); return; }
            const { data: profile } = await supabase.from('profiles').select('timezone').eq('id', connection.recipient_id).maybeSingle();
            if (isValidIanaTimezone(profile?.timezone)) {
                setParticipantTimezone(profile!.timezone);
            } else {
                setTimezoneUnavailable(true);
            }
        })();
    }, [selectedConnectionId]);

    function updateItem(index: number, patch: Partial<DraftItem>) {
        setHasEdited(true);
        setItems((prev) => prev.map((it, i) => (i === index ? ({ ...it, ...patch } as DraftItem) : it)));
    }

    function toggleItemDay(index: number, iso: number) {
        setItems((prev) => prev.map((it, i) => {
            if (i !== index) return it;
            const days = it.daysOfWeek.includes(iso) ? it.daysOfWeek.filter((d) => d !== iso) : [...it.daysOfWeek, iso];
            return { ...it, daysOfWeek: days };
        }));
        setHasEdited(true);
    }

    const enabledItems = items.filter((i) => i.enabled);
    const { reminderCount, taskCount } = summarizeItemCounts(enabledItems);
    const selectedParticipant = participants.find((p) => p.connectionId === selectedConnectionId);

    function handleBack() {
        if (hasEdited) {
            Alert.alert(
                t('routinePreview.discardChangesTitle'),
                t('routinePreview.discardChangesText'),
                [
                    { text: t('routinePreview.discardChangesCancel'), style: 'cancel' },
                    { text: t('routinePreview.discardChangesConfirm'), style: 'destructive', onPress: () => router.back() },
                ]
            );
        } else {
            router.back();
        }
    }

    async function handleSaveAsTemplate() {
        if (savingTemplate) return;
        setSavingTemplate(true);
        const payload = items.map(draftToTemplatePayload);
        const { error } = await supabase.rpc('create_routine_template', {
            p_title: routineTitle,
            p_description: null,
            p_use_case: null,
            p_items: payload,
        });
        setSavingTemplate(false);
        if (error) {
            showAlertOnce(t('routinePreview.applyErrorTitle'), error.message);
            return;
        }
        showAlertOnce(t('routineLibrary.myTemplatesSection'), t('routinePreview.savedAsTemplateSuccess'));
    }

    async function handleApply() {
        if (applying) return;
        if (!selectedConnectionId || connectionEnded) return;
        if (timezoneUnavailable || !participantTimezone) return;
        if (enabledItems.length === 0) {
            setApplyError('no_enabled_items');
            return;
        }

        const applyItems: ApplyItem[] = enabledItems.map((item) =>
            resolveTemplateItemToApplyItem(item as RoutineTemplateItem, startDate, item.sourceItemKey)
        );
        const validation = validateApplyItems(applyItems);
        if (!validation.ok) {
            setApplyError(validation.error);
            return;
        }

        setApplying(true);
        setApplyError(null);

        const { data, error } = await supabase.rpc('apply_routine_template', {
            p_connection_id: selectedConnectionId,
            p_source_template_id: sourceTemplateId,
            p_source_template_revision: sourceTemplateRevision,
            p_built_in_pack_id: sourceBuiltInPackId,
            p_built_in_pack_version: sourceBuiltInPackVersion,
            p_title: routineTitle,
            p_start_date: startDate,
            p_items: applyItems.map((item) => item.itemKind === 'reminder'
                ? {
                      item_kind: 'reminder', source_item_key: item.sourceItemKey, title: item.title, notes: item.notes,
                      reminder_type: item.reminderType, time_of_day: item.timeOfDay, frequency: item.frequency,
                      days_of_week: item.daysOfWeek, no_response_minutes: item.noResponseMinutes,
                      start_offset_days: item.startOffsetDays,
                  }
                : {
                      item_kind: 'task', source_item_key: item.sourceItemKey, title: item.title, notes: item.notes,
                      frequency: item.frequency, days_of_week: item.daysOfWeek,
                      start_date: item.startDate, due_date: item.dueDate, recurrence_end_date: item.recurrenceEndDate,
                  }),
            p_apply_request_id: applyRequestIdRef.current,
        });

        setApplying(false);

        if (error) {
            setApplyError(error.message);
            return;
        }

        router.replace({ pathname: '/routine-details', params: { routineInstanceId: (data as any).routineInstanceId } });
    }

    if (status === 'loading') {
        return <ScreenLoadingState label={t('routinePreview.heading')} />;
    }
    if (status === 'error') {
        return (
            <SafeAreaView style={styles.container}>
                <SectionErrorState text={t('routineDetails.loadFailedTitle')} onRetry={() => router.back()} />
            </SafeAreaView>
        );
    }

    return (
        <SafeAreaView style={styles.container}>
            <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
                <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                    <View style={styles.header}>
                        <TouchableOpacity onPress={handleBack} accessibilityRole="button" accessibilityLabel={t('common.back')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                            <Ionicons name="chevron-back" size={24} color={C.primary} />
                        </TouchableOpacity>
                        <Text style={styles.heading} accessibilityRole="header">{t('routinePreview.heading')}</Text>
                        <View style={{ width: 24 }} />
                    </View>

                    <TextInput
                        style={styles.titleInput}
                        value={routineTitle}
                        onChangeText={(v) => { setRoutineTitle(v); setHasEdited(true); }}
                        accessibilityLabel={t('routinePreview.heading')}
                        maxLength={200}
                    />

                    {/* Participant selection */}
                    <Text style={styles.fieldLabel}>{t('routinePreview.selectParticipant')}</Text>
                    <View style={styles.chipRow}>
                        {participants.map((p) => (
                            <TouchableOpacity
                                key={p.connectionId}
                                style={[styles.chip, selectedConnectionId === p.connectionId && styles.chipActive]}
                                onPress={() => setSelectedConnectionId(p.connectionId)}
                                accessibilityRole="radio"
                                accessibilityState={{ selected: selectedConnectionId === p.connectionId }}
                                accessibilityLabel={p.recipientName}
                            >
                                <Text style={[styles.chipText, selectedConnectionId === p.connectionId && styles.chipTextActive]}>{p.recipientName}</Text>
                            </TouchableOpacity>
                        ))}
                    </View>

                    {connectionEnded && (
                        <SectionErrorState text={t('routinePreview.connectionEndedText')} />
                    )}
                    {!connectionEnded && timezoneUnavailable && (
                        <SectionErrorState text={t('routinePreview.timezoneUnavailableText')} />
                    )}
                    {!connectionEnded && participantTimezone && (
                        <Text style={styles.timezoneNote}>
                            {t('routinePreview.participantTimezoneNote', { participant: selectedParticipant?.recipientName ?? '', timezone: participantTimezone })}
                        </Text>
                    )}

                    <Text style={styles.fieldLabel}>{t('routinePreview.startDate')}</Text>
                    <DatePickerField
                        value={startDate}
                        onChange={(v) => { if (v) { setStartDate(v); setHasEdited(true); } }}
                        label={t('routinePreview.startDate')}
                        minDate={todayDateString()}
                    />

                    {items.map((item, index) => (
                        <View key={item.sourceItemKey} style={[styles.itemCard, SHADOW.xs, !item.enabled && styles.itemCardDisabled]}>
                            <View style={styles.itemHeaderRow}>
                                <StatusBadge
                                    label={item.itemKind === 'reminder' ? t('routinePreview.reminderSectionLabel') : t('routinePreview.taskSectionLabel')}
                                    tone="neutral"
                                />
                                <Switch
                                    value={item.enabled}
                                    onValueChange={(v) => updateItem(index, { enabled: v })}
                                    accessibilityRole="switch"
                                    accessibilityLabel={t('routinePreview.enabledToggleLabel')}
                                    accessibilityState={{ checked: item.enabled }}
                                />
                            </View>

                            <TextInput
                                style={styles.itemTitleInput}
                                value={item.title}
                                onChangeText={(v) => updateItem(index, { title: v })}
                                maxLength={200}
                                editable={item.enabled}
                                accessibilityLabel={item.itemKind === 'reminder' ? t('routinePreview.reminderSectionLabel') : t('routinePreview.taskSectionLabel')}
                            />
                            <TextInput
                                style={styles.itemNotesInput}
                                value={item.notes ?? ''}
                                onChangeText={(v) => updateItem(index, { notes: v || null })}
                                maxLength={2000}
                                editable={item.enabled}
                                multiline
                                placeholder={t('common.optional')}
                                placeholderTextColor={C.textMuted}
                            />

                            {item.itemKind === 'reminder' && item.enabled && (
                                <>
                                    {item.startOffsetDays > 0 && (
                                        <Text style={styles.timezoneNote}>
                                            {t('routinePreview.reminderStartsOn', { date: formatDateStringForDisplay(addDaysToDateString(startDate, item.startOffsetDays)) })}
                                        </Text>
                                    )}
                                    <TimePickerField
                                        value={parseTimeString(`${item.timeOfDay}:00`)}
                                        onChange={(d) => updateItem(index, { timeOfDay: buildTimeString(d).slice(0, 5) })}
                                    />
                                    <View style={styles.chipRow}>
                                        {DAY_OPTIONS.map((day) => (
                                            <TouchableOpacity
                                                key={day.iso}
                                                style={[styles.dayChip, item.daysOfWeek.includes(day.iso) && styles.chipActive]}
                                                onPress={() => toggleItemDay(index, day.iso)}
                                                accessibilityRole="checkbox"
                                                accessibilityLabel={t(`reminderForm.day${DAY_ISO_TO_KEY[day.iso]}`)}
                                                accessibilityState={{ checked: item.daysOfWeek.includes(day.iso) }}
                                            >
                                                <Text style={[styles.chipText, item.daysOfWeek.includes(day.iso) && styles.chipTextActive]}>
                                                    {t(`reminderForm.day${DAY_ISO_TO_KEY[day.iso]}`)}
                                                </Text>
                                            </TouchableOpacity>
                                        ))}
                                    </View>
                                    <View style={styles.chipRow}>
                                        {NO_RESPONSE_OPTIONS.map((n) => (
                                            <TouchableOpacity
                                                key={n}
                                                style={[styles.chip, item.noResponseMinutes === n && styles.chipActive]}
                                                onPress={() => updateItem(index, { noResponseMinutes: n })}
                                                accessibilityRole="radio"
                                                accessibilityState={{ selected: item.noResponseMinutes === n }}
                                                accessibilityLabel={`${n} min`}
                                            >
                                                <Text style={[styles.chipText, item.noResponseMinutes === n && styles.chipTextActive]}>{n}m</Text>
                                            </TouchableOpacity>
                                        ))}
                                    </View>
                                </>
                            )}

                            {item.itemKind === 'task' && item.enabled && (
                                <View style={styles.chipRow}>
                                    {(['daily', 'weekdays', 'weekends', 'custom', 'one_time'] as const).map((freq) => (
                                        <TouchableOpacity
                                            key={freq}
                                            style={[styles.chip, item.frequency === freq && styles.chipActive]}
                                            onPress={() => updateItem(index, { frequency: freq, daysOfWeek: freq === 'one_time' ? [] : item.daysOfWeek.length ? item.daysOfWeek : [1, 2, 3, 4, 5, 6, 7] })}
                                            accessibilityRole="radio"
                                            accessibilityState={{ selected: item.frequency === freq }}
                                            accessibilityLabel={freq}
                                        >
                                            <Text style={[styles.chipText, item.frequency === freq && styles.chipTextActive]}>{freq}</Text>
                                        </TouchableOpacity>
                                    ))}
                                </View>
                            )}
                            {item.itemKind === 'task' && item.enabled && item.frequency !== 'one_time' && (
                                <View style={styles.chipRow}>
                                    {DAY_OPTIONS.map((day) => (
                                        <TouchableOpacity
                                            key={day.iso}
                                            style={[styles.dayChip, item.daysOfWeek.includes(day.iso) && styles.chipActive]}
                                            onPress={() => toggleItemDay(index, day.iso)}
                                            accessibilityRole="checkbox"
                                            accessibilityLabel={t(`reminderForm.day${DAY_ISO_TO_KEY[day.iso]}`)}
                                            accessibilityState={{ checked: item.daysOfWeek.includes(day.iso) }}
                                        >
                                            <Text style={[styles.chipText, item.daysOfWeek.includes(day.iso) && styles.chipTextActive]}>
                                                {t(`reminderForm.day${DAY_ISO_TO_KEY[day.iso]}`)}
                                            </Text>
                                        </TouchableOpacity>
                                    ))}
                                </View>
                            )}
                            {item.itemKind === 'task' && item.enabled && item.frequency === 'one_time' && (
                                <DatePickerField
                                    value={item.dueOffsetDays !== null ? addDaysToDateString(startDate, item.dueOffsetDays) : startDate}
                                    onChange={(picked) => {
                                        if (!picked) return;
                                        const offset = Math.max(0, dateStringDiffDays(startDate, picked));
                                        updateItem(index, { dueOffsetDays: offset });
                                    }}
                                    label={t('routinePreview.taskSectionLabel')}
                                    minDate={startDate}
                                />
                            )}
                        </View>
                    ))}

                    <View style={[styles.summaryCard, SHADOW.xs]}>
                        <Text style={styles.summaryTitle}>{t('routinePreview.summaryTitle')}</Text>
                        <Text style={styles.summaryLine}>{t('routinePreview.summaryReminders', { n: reminderCount, plural: reminderCount === 1 ? '' : 's' })}</Text>
                        <Text style={styles.summaryLine}>{t('routinePreview.summaryTasks', { n: taskCount, plural: taskCount === 1 ? '' : 's' })}</Text>
                        <Text style={styles.summaryLine}>{selectedParticipant?.recipientName ?? '—'}</Text>
                        <Text style={styles.summaryLine}>{formatDateStringForDisplay(startDate)}</Text>
                    </View>

                    {applyError && (
                        <SectionErrorState text={t(ROUTINE_ERROR_MESSAGE_KEYS[applyError] ?? 'routinePreview.applyErrorTitle')} />
                    )}

                    <TouchableOpacity
                        style={styles.secondaryButton}
                        onPress={handleSaveAsTemplate}
                        disabled={savingTemplate}
                        accessibilityRole="button"
                        accessibilityLabel={t('routinePreview.savedAsTemplateAction')}
                    >
                        <Text style={styles.secondaryButtonText}>{t('routinePreview.savedAsTemplateAction')}</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={[styles.applyButton, SHADOW.primary, (applying || !selectedConnectionId || connectionEnded || timezoneUnavailable || enabledItems.length === 0) && styles.applyButtonDisabled]}
                        onPress={handleApply}
                        disabled={applying || !selectedConnectionId || connectionEnded || timezoneUnavailable || enabledItems.length === 0}
                        accessibilityRole="button"
                        accessibilityLabel={applying ? t('routinePreview.applyingButton') : t('routinePreview.applyButton')}
                        accessibilityState={{ disabled: applying || !selectedConnectionId || connectionEnded || timezoneUnavailable || enabledItems.length === 0 }}
                    >
                        {applying ? <ActivityIndicator color={C.textInverse} /> : <Text style={styles.applyButtonText}>{t('routinePreview.applyButton')}</Text>}
                    </TouchableOpacity>
                </ScrollView>
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}

function createStyles(C: ThemeColors) {
    return StyleSheet.create({
        container: { flex: 1, backgroundColor: C.bgPage },
        content: { padding: 20, paddingBottom: 60 },
        header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
        heading: { fontSize: 20, fontWeight: '700', color: C.textPrimary },
        titleInput: { fontSize: 18, fontWeight: '700', color: C.textPrimary, backgroundColor: C.bgAlt, borderRadius: RADIUS.md, padding: 12, marginBottom: 16, minHeight: 44 },
        fieldLabel: { fontSize: 13, fontWeight: '600', color: C.textSecondary, marginTop: 12, marginBottom: 6 },
        chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
        chip: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: RADIUS.full, backgroundColor: C.bgAlt, minHeight: 44, justifyContent: 'center' },
        dayChip: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: RADIUS.full, backgroundColor: C.bgAlt, minHeight: 44, justifyContent: 'center' },
        chipActive: { backgroundColor: C.primary },
        chipText: { fontSize: 13, fontWeight: '600', color: C.textSecondary },
        chipTextActive: { color: C.textInverse },
        timezoneNote: { fontSize: 12, color: C.textMuted, marginBottom: 8 },
        itemCard: { backgroundColor: C.bgSurface, borderRadius: RADIUS.md, padding: 14, marginTop: 14 },
        itemCardDisabled: { opacity: 0.55 },
        itemHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
        itemTitleInput: { fontSize: 15, fontWeight: '600', color: C.textPrimary, backgroundColor: C.bgAlt, borderRadius: RADIUS.sm, padding: 10, marginBottom: 8, minHeight: 44 },
        itemNotesInput: { fontSize: 13, color: C.textSecondary, backgroundColor: C.bgAlt, borderRadius: RADIUS.sm, padding: 10, marginBottom: 8, minHeight: 44 },
        summaryCard: { backgroundColor: C.bgSurface, borderRadius: RADIUS.md, padding: 16, marginTop: 20 },
        summaryTitle: { fontSize: 15, fontWeight: '700', color: C.textPrimary, marginBottom: 8 },
        summaryLine: { fontSize: 13, color: C.textSecondary, marginTop: 2 },
        secondaryButton: { marginTop: 20, paddingVertical: 14, alignItems: 'center', borderRadius: RADIUS.md, backgroundColor: C.bgAlt, minHeight: 44 },
        secondaryButtonText: { fontSize: 15, fontWeight: '600', color: C.primary },
        applyButton: { marginTop: 12, paddingVertical: 16, alignItems: 'center', borderRadius: RADIUS.md, backgroundColor: C.primary, minHeight: 44 },
        applyButtonDisabled: { opacity: 0.5 },
        applyButtonText: { fontSize: 16, fontWeight: '700', color: C.textInverse },
    });
}
