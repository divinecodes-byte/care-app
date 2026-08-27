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

import { RADIUS, SHADOW, ThemeColors } from '@/constants/theme';
import { useTranslation } from '@/lib/i18n/context';
import { useThemeColors } from '@/lib/theme';
import { buildTimeString, TimePickerField } from '@/components/TimePickerField';
import { classifyScreenError } from '@/lib/asyncStateCore';
import { ERROR_CATEGORY_TRANSLATION_KEYS } from '@/lib/errorClassification';
import { DAY_ISO_TO_KEY, DAY_OPTIONS, daysForFrequency, Frequency } from '@/lib/frequency';
import { getExampleReminderTitleKey, isUseCase, logOnboardingEvent, UseCase } from '@/lib/onboarding';
import { assertValidNoResponseMinutes, DEFAULT_NO_RESPONSE_MINUTES, NO_RESPONSE_OPTIONS } from '@/lib/reminderOptions';
import { supabase } from '@/lib/supabase';
import { showAlertOnce } from '@/lib/alertGuard';
import { useFocusOnChange } from '@/lib/useAccessibilityFocus';

type ReminderType = 'general' | 'medication' | 'hydration' | 'appointment' | 'meal' | 'exercise' | 'other';

type ParticipantOption = {
    connectionId: string;
    recipientId: string;
    recipientName: string;
};

// 'general' first -- the neutral, always-appropriate default/leading
// option for any relationship type (see docs/product-reset-audit.md §11
// item F1). The five relationship-specific categories remain unchanged
// and useful; 'other' remains as the existing catch-all.
const REMINDER_TYPES: ReminderType[] = ['general', 'medication', 'hydration', 'appointment', 'meal', 'exercise', 'other'];
const FREQUENCIES:    Frequency[]    = ['daily', 'weekdays', 'weekends', 'custom'];

const TYPE_ICON_NAMES: Record<ReminderType, string> = {
    general:     'checkmark-circle-outline',
    medication:  'medical-outline',
    hydration:   'water-outline',
    appointment: 'calendar-outline',
    meal:        'restaurant-outline',
    exercise:    'walk-outline',
    other:       'ellipsis-horizontal-outline',
};

const TYPE_LABEL_KEYS: Record<ReminderType, string> = {
    general:     'reminderForm.typeGeneral',
    medication:  'reminderForm.typeMedication',
    hydration:   'reminderForm.typeHydration',
    appointment: 'reminderForm.typeAppointment',
    meal:        'reminderForm.typeMeal',
    exercise:    'reminderForm.typeExercise',
    other:       'reminderForm.typeOther',
};

const FREQUENCY_LABEL_KEYS: Record<Frequency, string> = {
    daily:    'reminderForm.freqDaily',
    weekdays: 'reminderForm.freqWeekdays',
    weekends: 'reminderForm.freqWeekends',
    custom:   'reminderForm.freqCustom',
};

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function CreateReminderScreen() {
    const C = useThemeColors();
    const t = useTranslation();
    const styles = useMemo(() => createStyles(C), [C]);
    const { connectionId: preselectConnectionId } = useLocalSearchParams<{ connectionId?: string }>();

    function formatResponseMinutes(m: number): string {
        return m < 60 ? t('reminderForm.minutesShort', { n: m }) : t('reminderForm.hoursShort', { n: m / 60 });
    }

    const [participants, setParticipants]           = useState<ParticipantOption[]>([]);
    const [participantsLoading, setParticipantsLoading] = useState(true);
    const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);

    const [title, setTitle]                         = useState('');
    const [reminderType, setReminderType]           = useState<ReminderType>('general');
    const [notes, setNotes]                         = useState('');
    const [timeValue, setTimeValue]                 = useState<Date>(() => {
        const d = new Date();
        d.setHours(8, 0, 0, 0);
        return d;
    });
    const [frequency, setFrequency]                 = useState<Frequency>('daily');
    const [selectedDays, setSelectedDays]           = useState<number[]>([]);
    const [noResponseMinutes, setNoResponseMinutes] = useState(DEFAULT_NO_RESPONSE_MINUTES);
    const [loading, setLoading]                     = useState(false);
    const [focused, setFocused]                     = useState<string | null>(null);
    const [useCase, setUseCase]                     = useState<UseCase | null>(null);
    // Set only after a successful save — replaces the form with an in-page
    // confirmation instead of an Alert + immediate redirect, per the
    // "first reminder created" experience.
    const [savedSummary, setSavedSummary] = useState<{
        title: string;
        timeOfDay: string;
        recipientName: string;
        nextOccurrenceLabel: string;
        reminderId: string;
        connectionId: string;
    } | null>(null);
    const confirmHeadingRef = useFocusOnChange<Text>(savedSummary);

    useEffect(() => {
        (async () => {
            setParticipantsLoading(true);

            const { data: { user } } = await supabase.auth.getUser();
            if (!user) { setParticipantsLoading(false); return; }

            const { data: ownProfile } = await supabase
                .from('profiles')
                .select('use_case')
                .eq('id', user.id)
                .maybeSingle();
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
            const { data: profiles } = await supabase
                .from('profiles')
                .select('id, full_name')
                .in('id', recipientIds);

            const nameById = new Map((profiles ?? []).map((p) => [p.id, p.full_name]));

            const options: ParticipantOption[] = accepted.map((c) => ({
                connectionId:  c.id,
                recipientId:   c.recipient_id as string,
                recipientName: nameById.get(c.recipient_id as string) || t('common.participant'),
            }));

            setParticipants(options);

            // Preselect: the connection passed in from the dashboard if it's
            // still valid, else the only participant, else nothing.
            const preselect = options.find((o) => o.connectionId === preselectConnectionId);
            setSelectedConnectionId(preselect?.connectionId ?? (options.length === 1 ? options[0].connectionId : null));

            setParticipantsLoading(false);
        })();
    }, [preselectConnectionId]);

    function toggleDay(iso: number) {
        setSelectedDays((prev) =>
            prev.includes(iso) ? prev.filter((d) => d !== iso) : [...prev, iso]
        );
    }

    // Display-only label for the confirmation card — walks forward from
    // today (device-local calendar) to the first day matching days_of_week.
    // Never used for actual delivery timing, which stays entirely
    // server-authoritative and recipient-timezone-based (see
    // docs/reminder-state-model.md) — this is purely "what to show the
    // caregiver right after saving," computed the same way the rest of
    // this form already reasons about days locally.
    function nextOccurrenceLabel(daysOfWeek: number[], timeString: string): string {
        const timeLabel = timeValue.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        const today = new Date();
        for (let offset = 0; offset < 7; offset++) {
            const candidate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
            const isoDow = candidate.getDay() === 0 ? 7 : candidate.getDay();
            if (daysOfWeek.includes(isoDow)) {
                const dayLabel = offset === 0
                    ? candidate.toLocaleDateString(undefined, { weekday: 'long' })
                    : candidate.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
                return `${dayLabel} · ${timeLabel}`;
            }
        }
        return timeLabel;
    }

    async function saveReminder() {
        // A plain client-side insert (no idempotency key server-side) --
        // without this, a rapid double-tap before the button's own
        // `disabled={loading}` takes effect on the next render can create
        // two duplicate reminder rows.
        if (loading) return;

        const selected = participants.find((p) => p.connectionId === selectedConnectionId);
        if (!selected) {
            showAlertOnce(t('reminderForm.chooseParticipantTitle'), t('reminderForm.chooseParticipantMessage'));
            return;
        }

        if (!title.trim()) {
            showAlertOnce(t('reminderForm.missingTitleTitle'), t('reminderForm.missingTitleMessage'));
            return;
        }

        if (frequency === 'custom' && selectedDays.length === 0) {
            showAlertOnce(t('reminderForm.selectDayTitle'), t('reminderForm.selectDayMessage'));
            return;
        }

        // Defense-in-depth: the chip UI can only ever set one of
        // NO_RESPONSE_OPTIONS, but never let a 0/negative/NaN/unsupported
        // value reach the database regardless.
        assertValidNoResponseMinutes(noResponseMinutes);

        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        setLoading(true);

        const { data: { user }, error: userError } = await supabase.auth.getUser();

        if (userError || !user) {
            setLoading(false);
            showAlertOnce(t('reminderForm.notSignedInTitle'), t('reminderForm.notSignedInMessage'));
            return;
        }

        const resolvedDays = daysForFrequency(frequency, selectedDays);
        const resolvedTime = buildTimeString(timeValue);

        const { data: inserted, error } = await supabase.from('reminders').insert({
            connection_id:       selected.connectionId,
            caregiver_id:        user.id,
            recipient_id:        selected.recipientId,
            title:               title.trim(),
            reminder_type:       reminderType,
            notes:               notes.trim() || null,
            time_of_day:         resolvedTime,
            frequency,
            days_of_week:        resolvedDays,
            no_response_minutes: noResponseMinutes,
            is_active:           true,
        }).select('id').single();

        setLoading(false);

        if (error || !inserted) {
            // RLS ("Caregivers can create reminders for accepted
            // connections") is the real enforcement point for "this
            // connection ended/was never accepted" — it fails closed with
            // a generic Postgres row-level-security message rather than a
            // typed result, so detect that specific case here for a
            // friendly message instead of surfacing the raw string.
            if (error?.message?.toLowerCase().includes('row-level security')) {
                showAlertOnce(t('reminderForm.connectionEndedTitle'), t('reminderForm.connectionEndedMessage'));
                router.replace('/participants');
                return;
            }
            showAlertOnce(t('reminderForm.errorTitle'), t(ERROR_CATEGORY_TRANSLATION_KEYS[classifyScreenError(error?.message)]));
            return;
        }

        logOnboardingEvent('first_reminder_created');

        setSavedSummary({
            title: title.trim(),
            timeOfDay: resolvedTime,
            recipientName: selected.recipientName,
            nextOccurrenceLabel: nextOccurrenceLabel(resolvedDays, resolvedTime),
            reminderId: inserted.id,
            connectionId: selected.connectionId,
        });
    }

    const inputStyle = (field: string) => [
        styles.input,
        focused === field && styles.inputFocused,
    ];

    if (savedSummary) {
        return (
            <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
                <View style={styles.confirmContent}>
                    <View style={styles.confirmIconWrap}>
                        <Ionicons name="checkmark-circle" size={48} color={C.success} />
                    </View>
                    <Text ref={confirmHeadingRef} style={styles.heading} accessibilityRole="header">{t('firstReminder.confirmTitle')}</Text>
                    <Text style={styles.subheading}>
                        {t('firstReminder.confirmSubtitle', { name: savedSummary.recipientName })}
                    </Text>

                    <View style={[styles.confirmCard, SHADOW.xs]}>
                        <View style={styles.confirmRow}>
                            <Ionicons name="create-outline" size={16} color={C.textMuted} />
                            <Text style={styles.confirmValue} numberOfLines={2}>{savedSummary.title}</Text>
                        </View>
                        <View style={styles.confirmRow}>
                            <Ionicons name="person-outline" size={16} color={C.textMuted} />
                            <Text style={styles.confirmLabel}>{t('firstReminder.confirmParticipantLabel')}</Text>
                            <Text style={styles.confirmValue}>{savedSummary.recipientName}</Text>
                        </View>
                        <View style={styles.confirmRow}>
                            <Ionicons name="time-outline" size={16} color={C.textMuted} />
                            <Text style={styles.confirmLabel}>{t('firstReminder.confirmNextLabel')}</Text>
                            <Text style={styles.confirmValue}>{savedSummary.nextOccurrenceLabel}</Text>
                        </View>
                    </View>

                    <View style={styles.spacer} />

                    <TouchableOpacity
                        style={[styles.button, SHADOW.primary]}
                        onPress={() => router.replace({ pathname: '/reminder-details', params: { reminderId: savedSummary.reminderId, connectionId: savedSummary.connectionId } })}
                        activeOpacity={0.88}
                        accessibilityRole="button"
                        accessibilityLabel={t('firstReminder.viewReminder')}
                    >
                        <Text style={styles.buttonText}>{t('firstReminder.viewReminder')}</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={styles.secondaryButton}
                        onPress={() => router.replace({ pathname: '/caregiver-dashboard', params: { connectionId: savedSummary.connectionId } })}
                        activeOpacity={0.7}
                        accessibilityRole="button"
                        accessibilityLabel={t('firstReminder.backToDashboard')}
                    >
                        <Text style={styles.secondaryButtonText}>{t('firstReminder.backToDashboard')}</Text>
                    </TouchableOpacity>
                </View>
            </SafeAreaView>
        );
    }

    return (
        <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
            <KeyboardAvoidingView
                style={styles.kav}
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            >
                <ScrollView
                    contentContainerStyle={styles.content}
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator={false}
                >
                    {/* Back */}
                    <TouchableOpacity
                        style={styles.backButton}
                        onPress={() => router.back()}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                        <Ionicons name="chevron-back" size={22} color={C.primary} />
                        <Text style={styles.backText}>{t('reminderForm.back')}</Text>
                    </TouchableOpacity>

                    {/* Header */}
                    <Text style={styles.heading}>{t('reminderForm.createHeading')}</Text>
                    <Text style={styles.subheading}>
                        {t('reminderForm.createSubheading')}
                    </Text>

                    {participantsLoading ? (
                        <View style={[styles.sectionCard, SHADOW.xs, styles.loadingCard]}>
                            <ActivityIndicator color={C.primary} />
                            <Text style={styles.loadingText}>{t('reminderForm.loadingParticipants')}</Text>
                        </View>
                    ) : participants.length === 0 ? (
                        <View style={[styles.sectionCard, SHADOW.xs, styles.emptyCard]}>
                            <View style={[styles.sectionIconWrap, { backgroundColor: C.primaryLight }]}>
                                <Ionicons name="person-add-outline" size={20} color={C.primary} />
                            </View>
                            <Text style={styles.emptyTitle}>{t('reminderForm.noParticipantsTitle')}</Text>
                            <Text style={styles.emptyText}>
                                {t('reminderForm.noParticipantsText')}
                            </Text>
                            <TouchableOpacity
                                style={[styles.inviteButton, SHADOW.primary]}
                                onPress={() => router.push('/invite-recipient')}
                                activeOpacity={0.88}
                            >
                                <Ionicons name="person-add" size={16} color={C.textInverse} />
                                <Text style={styles.inviteButtonText}>{t('reminderForm.inviteParticipant')}</Text>
                            </TouchableOpacity>
                        </View>
                    ) : (
                    <>
                    {/* ── Who is this for ─────────────────────────────────── */}
                    <View style={[styles.sectionCard, SHADOW.xs]}>
                        <View style={styles.sectionHeader}>
                            <View style={[styles.sectionIconWrap, { backgroundColor: C.successLight }]}>
                                <Ionicons name="person-outline" size={18} color={C.success} />
                            </View>
                            <Text style={styles.sectionTitle}>{t('reminderForm.whoIsThisFor')}</Text>
                        </View>

                        {participants.length === 1 ? (
                            <View style={styles.singleParticipantRow}>
                                <View style={styles.participantAvatar}>
                                    <Text style={styles.participantAvatarText}>
                                        {participants[0].recipientName.charAt(0).toUpperCase()}
                                    </Text>
                                </View>
                                <Text style={styles.singleParticipantName}>{participants[0].recipientName}</Text>
                            </View>
                        ) : (
                            <View style={styles.participantGrid}>
                                {participants.map((p) => (
                                    <TouchableOpacity
                                        key={p.connectionId}
                                        style={[
                                            styles.participantOption,
                                            selectedConnectionId === p.connectionId && styles.chipActive,
                                        ]}
                                        onPress={() => setSelectedConnectionId(p.connectionId)}
                                        activeOpacity={0.75}
                                        accessibilityRole="radio"
                                        accessibilityLabel={p.recipientName}
                                        accessibilityState={{ selected: selectedConnectionId === p.connectionId }}
                                    >
                                        <View style={styles.participantAvatar}>
                                            <Text style={styles.participantAvatarText}>
                                                {p.recipientName.charAt(0).toUpperCase()}
                                            </Text>
                                        </View>
                                        <Text
                                            style={[
                                                styles.chipText,
                                                selectedConnectionId === p.connectionId && styles.chipTextActive,
                                            ]}
                                        >
                                            {p.recipientName}
                                        </Text>
                                        {selectedConnectionId === p.connectionId ? (
                                            <Ionicons name="checkmark-circle" size={15} color={C.primary} />
                                        ) : null}
                                    </TouchableOpacity>
                                ))}
                            </View>
                        )}
                        <Text style={styles.recipientNote}>
                            {selectedConnectionId
                                ? t('reminderForm.participantWillReceive', {
                                    name: participants.find((p) => p.connectionId === selectedConnectionId)?.recipientName ?? '',
                                })
                                : t('reminderForm.participantWillReceiveGeneric')}
                        </Text>
                    </View>

                    {/* ── Section 1: What ─────────────────────────────────── */}
                    <View style={[styles.sectionCard, SHADOW.xs]}>
                        <View style={styles.sectionHeader}>
                            <View style={[styles.sectionIconWrap, { backgroundColor: C.primaryLight }]}>
                                <Ionicons name="create-outline" size={18} color={C.primary} />
                            </View>
                            <Text style={styles.sectionTitle}>{t('reminderForm.sectionWhat')}</Text>
                        </View>

                        <Text style={styles.label}>{t('reminderForm.nameLabel')}</Text>
                        <TextInput
                            style={inputStyle('title')}
                            placeholder={t('reminderForm.namePlaceholderPrefix') + t(getExampleReminderTitleKey(useCase))}
                            placeholderTextColor={C.textMuted}
                            value={title}
                            onChangeText={setTitle}
                            onFocus={() => setFocused('title')}
                            onBlur={() => setFocused(null)}
                            returnKeyType="next"
                            accessibilityLabel={t('reminderForm.nameLabel')}
                        />

                        <Text style={[styles.label, { marginTop: 18 }]}>{t('reminderForm.typeLabel')}</Text>
                        <View style={styles.typeGrid}>
                            {REMINDER_TYPES.map((type) => (
                                <TouchableOpacity
                                    key={type}
                                    style={[
                                        styles.typeChip,
                                        reminderType === type && styles.typeChipActive,
                                    ]}
                                    onPress={() => setReminderType(type)}
                                    activeOpacity={0.75}
                                    accessibilityRole="radio"
                                    accessibilityLabel={t(TYPE_LABEL_KEYS[type])}
                                    accessibilityState={{ selected: reminderType === type }}
                                >
                                    <Ionicons
                                        name={TYPE_ICON_NAMES[type] as any}
                                        size={15}
                                        color={reminderType === type ? C.primary : C.textMuted}
                                    />
                                    <Text
                                        style={[
                                            styles.typeChipText,
                                            reminderType === type && styles.typeChipTextActive,
                                        ]}
                                    >
                                        {t(TYPE_LABEL_KEYS[type])}
                                    </Text>
                                </TouchableOpacity>
                            ))}
                        </View>
                    </View>

                    {/* ── Section 2: When ─────────────────────────────────── */}
                    <View style={[styles.sectionCard, SHADOW.xs]}>
                        <View style={styles.sectionHeader}>
                            <View style={[styles.sectionIconWrap, { backgroundColor: '#FEF3C7' }]}>
                                <Ionicons name="time-outline" size={18} color="#D97706" />
                            </View>
                            <Text style={styles.sectionTitle}>{t('reminderForm.sectionWhen')}</Text>
                        </View>

                        <Text style={styles.label}>{t('reminderForm.timeOfDayLabel')}</Text>
                        <TimePickerField value={timeValue} onChange={setTimeValue} />
                        <Text style={styles.helperText}>{t('reminderForm.timezoneFollowsParticipant')}</Text>

                        <Text style={[styles.label, { marginTop: 18 }]}>{t('reminderForm.frequencyLabel')}</Text>
                        <View style={styles.frequencyRow}>
                            {FREQUENCIES.map((item) => (
                                <TouchableOpacity
                                    key={item}
                                    style={[
                                        styles.frequencyChip,
                                        frequency === item && styles.chipActive,
                                    ]}
                                    onPress={() => setFrequency(item)}
                                    activeOpacity={0.75}
                                    accessibilityRole="radio"
                                    accessibilityLabel={t(FREQUENCY_LABEL_KEYS[item])}
                                    accessibilityState={{ selected: frequency === item }}
                                >
                                    <Text
                                        style={[
                                            styles.chipText,
                                            frequency === item && styles.chipTextActive,
                                        ]}
                                    >
                                        {t(FREQUENCY_LABEL_KEYS[item])}
                                    </Text>
                                </TouchableOpacity>
                            ))}
                        </View>

                        {frequency === 'custom' && (
                            <View style={styles.dayRow}>
                                {DAY_OPTIONS.map((day) => (
                                    <TouchableOpacity
                                        key={day.iso}
                                        style={[
                                            styles.dayChip,
                                            selectedDays.includes(day.iso) && styles.chipActive,
                                        ]}
                                        onPress={() => toggleDay(day.iso)}
                                        activeOpacity={0.75}
                                        accessibilityRole="checkbox"
                                        accessibilityLabel={t(`reminderForm.day${DAY_ISO_TO_KEY[day.iso]}`)}
                                        accessibilityState={{ checked: selectedDays.includes(day.iso) }}
                                    >
                                        <Text
                                            style={[
                                                styles.chipText,
                                                selectedDays.includes(day.iso) && styles.chipTextActive,
                                            ]}
                                        >
                                            {t(`reminderForm.day${DAY_ISO_TO_KEY[day.iso]}`)}
                                        </Text>
                                    </TouchableOpacity>
                                ))}
                            </View>
                        )}
                    </View>

                    {/* ── Section 3: Alerts ───────────────────────────────── */}
                    <View style={[styles.sectionCard, SHADOW.xs]}>
                        <View style={styles.sectionHeader}>
                            <View style={[styles.sectionIconWrap, { backgroundColor: C.successLight }]}>
                                <Ionicons name="timer-outline" size={18} color={C.success} />
                            </View>
                            <Text style={styles.sectionTitle}>{t('reminderForm.sectionAlerts')}</Text>
                        </View>

                        <Text style={styles.label}>{t('reminderForm.missedAfterLabel')}</Text>
                        <View style={styles.chipGrid}>
                            {[NO_RESPONSE_OPTIONS.slice(0, 3), NO_RESPONSE_OPTIONS.slice(3)].map(
                                (row, ri) => (
                                    <View key={ri} style={styles.chipRow}>
                                        {row.map((opt) => (
                                            <TouchableOpacity
                                                key={opt}
                                                style={[
                                                    styles.noResponseChip,
                                                    noResponseMinutes === opt && styles.chipActive,
                                                ]}
                                                onPress={() => setNoResponseMinutes(opt)}
                                                activeOpacity={0.75}
                                                accessibilityRole="radio"
                                                accessibilityLabel={formatResponseMinutes(opt)}
                                                accessibilityState={{ selected: noResponseMinutes === opt }}
                                            >
                                                <Text
                                                    style={[
                                                        styles.chipText,
                                                        noResponseMinutes === opt && styles.chipTextActive,
                                                    ]}
                                                >
                                                    {formatResponseMinutes(opt)}
                                                </Text>
                                            </TouchableOpacity>
                                        ))}
                                    </View>
                                )
                            )}
                        </View>
                        <Text style={styles.helperText}>
                            {t('reminderForm.missedAfterHelper')}
                        </Text>

                        <Text style={[styles.label, { marginTop: 18 }]}>{t('reminderForm.notesLabel')} <Text style={styles.labelOptional}>({t('reminderForm.notesOptional')})</Text></Text>
                        <TextInput
                            style={[inputStyle('notes'), styles.notesInput]}
                            placeholder={t('reminderForm.notesPlaceholder')}
                            placeholderTextColor={C.textMuted}
                            value={notes}
                            onChangeText={setNotes}
                            onFocus={() => setFocused('notes')}
                            onBlur={() => setFocused(null)}
                            multiline
                            textAlignVertical="top"
                            accessibilityLabel={`${t('reminderForm.notesLabel')} (${t('reminderForm.notesOptional')})`}
                        />
                    </View>

                    {/* Save */}
                    <TouchableOpacity
                        style={[styles.saveButton, SHADOW.primary, loading && styles.saveButtonDisabled]}
                        onPress={saveReminder}
                        disabled={loading}
                        activeOpacity={0.88}
                        accessibilityRole="button"
                        accessibilityLabel={t('reminderForm.saveReminder')}
                        accessibilityState={{ disabled: loading, busy: loading }}
                    >
                        {loading ? (
                            <ActivityIndicator color={C.textInverse} />
                        ) : (
                            <>
                                <Ionicons name="checkmark-circle" size={20} color={C.textInverse} />
                                <Text style={styles.saveButtonText}>{t('reminderForm.saveReminder')}</Text>
                            </>
                        )}
                    </TouchableOpacity>
                    </>
                    )}
                </ScrollView>
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}

const createStyles = (C: ThemeColors) => StyleSheet.create({
    container: { flex: 1, backgroundColor: C.bgPage },
    kav:       { flex: 1 },
    content: {
        paddingHorizontal: 20,
        paddingTop: 12,
        paddingBottom: 40,
    },

    // ── Navigation ────────────────────────────────────────────────────
    backButton: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 24,
        alignSelf: 'flex-start',
    },
    backText: {
        fontSize: 16,
        fontWeight: '600',
        color: C.primary,
        marginLeft: 2,
    },

    recipientNote: {
        fontSize: 12,
        color: C.textMuted,
        marginTop: 12,
    },

    // ── Header ────────────────────────────────────────────────────────
    heading: {
        fontSize: 26,
        fontWeight: '800',
        color: C.textPrimary,
        letterSpacing: -0.5,
        marginBottom: 8,
    },
    subheading: {
        fontSize: 15,
        color: C.textSecondary,
        lineHeight: 22,
        letterSpacing: -0.1,
        marginBottom: 24,
    },

    // ── Section cards ─────────────────────────────────────────────────
    sectionCard: {
        backgroundColor: C.bgSurface,
        borderRadius: RADIUS.xl,
        padding: 18,
        marginBottom: 14,
        borderWidth: 1,
        borderColor: C.border,
    },
    sectionHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        marginBottom: 18,
    },
    sectionIconWrap: {
        width: 34,
        height: 34,
        borderRadius: RADIUS.md,
        justifyContent: 'center',
        alignItems: 'center',
    },
    sectionTitle: {
        fontSize: 16,
        fontWeight: '700',
        color: C.textPrimary,
        letterSpacing: -0.2,
    },

    // ── Form fields ───────────────────────────────────────────────────
    label: {
        fontSize: 13,
        fontWeight: '700',
        color: C.textPrimary,
        marginBottom: 8,
        letterSpacing: 0.1,
    },
    labelOptional: {
        fontWeight: '500',
        color: C.textMuted,
    },
    input: {
        backgroundColor: C.bgAlt,
        borderRadius: RADIUS.lg,
        paddingHorizontal: 14,
        paddingVertical: Platform.OS === 'ios' ? 14 : 12,
        fontSize: 16,
        borderWidth: 1.5,
        borderColor: 'transparent',
        color: C.textPrimary,
        fontWeight: '500',
    },
    inputFocused: {
        backgroundColor: C.bgSurface,
        borderColor: C.borderFocus,
    },
    notesInput: {
        minHeight: 88,
        textAlignVertical: 'top',
        paddingTop: 14,
    },
    helperText: {
        fontSize: 12,
        color: C.textMuted,
        marginTop: 6,
        lineHeight: 17,
    },

    // ── Type chip grid ────────────────────────────────────────────────
    typeGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    typeChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        backgroundColor: C.bgAlt,
        paddingVertical: 10,
        paddingHorizontal: 13,
        borderRadius: RADIUS.lg,
        borderWidth: 1.5,
        borderColor: 'transparent',
    },

    // ── Shared chip styles ────────────────────────────────────────────
    chipActive: {
        backgroundColor: C.primaryLight,
        borderColor: C.primary,
    },
    chipText: {
        color: C.textSecondary,
        fontSize: 13,
        fontWeight: '600',
    },
    chipTextActive: {
        color: C.primary,
        fontWeight: '700',
    },
    typeChipText: {
        color: C.textSecondary,
        fontSize: 13,
        fontWeight: '600',
    },
    typeChipActive: {
        backgroundColor: C.primaryLight,
        borderColor: C.primary,
    },
    typeChipTextActive: {
        color: C.primary,
        fontWeight: '700',
    },

    // ── Frequency chips ───────────────────────────────────────────────
    frequencyRow: { flexDirection: 'row', gap: 8 },
    frequencyChip: {
        flex: 1,
        backgroundColor: C.bgAlt,
        paddingVertical: 12,
        borderRadius: RADIUS.lg,
        alignItems: 'center',
        borderWidth: 1.5,
        borderColor: 'transparent',
    },

    // ── Custom day chips ──────────────────────────────────────────────
    dayRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        marginTop: 10,
    },
    dayChip: {
        minWidth: 52,
        paddingVertical: 10,
        paddingHorizontal: 12,
        backgroundColor: C.bgAlt,
        borderRadius: RADIUS.lg,
        alignItems: 'center',
        borderWidth: 1.5,
        borderColor: 'transparent',
    },

    // ── No-response chip grid ─────────────────────────────────────────
    chipGrid: { gap: 8 },
    chipRow:  { flexDirection: 'row', gap: 8 },
    noResponseChip: {
        flex: 1,
        backgroundColor: C.bgAlt,
        paddingVertical: 12,
        borderRadius: RADIUS.lg,
        alignItems: 'center',
        borderWidth: 1.5,
        borderColor: 'transparent',
    },

    // ── Who is this for ─────────────────────────────────────────────────
    singleParticipantRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    singleParticipantName: {
        fontSize: 16,
        fontWeight: '700',
        color: C.textPrimary,
    },
    participantGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    participantOption: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: C.bgAlt,
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderRadius: RADIUS.lg,
        borderWidth: 1.5,
        borderColor: 'transparent',
    },
    participantAvatar: {
        width: 28,
        height: 28,
        borderRadius: RADIUS.full,
        backgroundColor: C.primaryLight,
        alignItems: 'center',
        justifyContent: 'center',
    },
    participantAvatarText: {
        fontSize: 13,
        fontWeight: '700',
        color: C.primary,
    },

    // ── Loading / empty participants state ──────────────────────────────
    loadingCard: {
        alignItems: 'center',
        gap: 10,
        paddingVertical: 28,
    },
    loadingText: {
        fontSize: 14,
        color: C.textMuted,
        fontWeight: '600',
    },
    emptyCard: {
        alignItems: 'center',
        gap: 6,
        paddingVertical: 28,
    },
    emptyTitle: {
        fontSize: 17,
        fontWeight: '700',
        color: C.textPrimary,
        marginTop: 8,
    },
    emptyText: {
        fontSize: 14,
        color: C.textSecondary,
        textAlign: 'center',
        lineHeight: 20,
        marginBottom: 12,
        paddingHorizontal: 8,
    },
    inviteButton: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: C.primary,
        paddingVertical: 12,
        paddingHorizontal: 20,
        borderRadius: RADIUS.lg,
    },
    inviteButtonText: {
        color: C.textInverse,
        fontSize: 15,
        fontWeight: '700',
    },

    // ── Save button ───────────────────────────────────────────────────
    saveButton: {
        backgroundColor: C.primary,
        paddingVertical: 18,
        borderRadius: RADIUS.xl,
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 10,
        marginTop: 6,
    },
    saveButtonDisabled: { opacity: 0.65 },
    saveButtonText: {
        color: C.textInverse,
        fontSize: 17,
        fontWeight: '700',
        letterSpacing: -0.2,
    },

    // ── First-reminder confirmation ─────────────────────────────────────
    confirmContent: {
        flex: 1,
        paddingHorizontal: 28,
        paddingTop: 40,
        paddingBottom: 24,
    },
    confirmIconWrap: {
        marginBottom: 20,
    },
    confirmCard: {
        backgroundColor: C.bgSurface,
        borderRadius: RADIUS.xl,
        padding: 18,
        marginTop: 8,
        gap: 14,
    },
    confirmRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    confirmLabel: {
        fontSize: 13,
        color: C.textMuted,
        fontWeight: '600',
        minWidth: 76,
    },
    confirmValue: {
        flex: 1,
        fontSize: 15,
        color: C.textPrimary,
        fontWeight: '600',
    },
    spacer: {
        flex: 1,
        minHeight: 24,
    },
    button: {
        backgroundColor: C.primary,
        paddingVertical: 18,
        borderRadius: RADIUS.xl,
        alignItems: 'center',
        marginBottom: 12,
        minHeight: 44,
        justifyContent: 'center',
    },
    buttonText: {
        color: C.textInverse,
        fontSize: 17,
        fontWeight: '700',
        letterSpacing: -0.2,
    },
    secondaryButton: {
        paddingVertical: 14,
        alignItems: 'center',
        minHeight: 44,
        justifyContent: 'center',
    },
    secondaryButtonText: {
        fontSize: 15,
        fontWeight: '600',
        color: C.textMuted,
    },
});
