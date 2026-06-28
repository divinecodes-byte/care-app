import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
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

import { RADIUS, SHADOW, T, ThemeColors } from '@/constants/theme';
import { useThemeColors } from '@/lib/theme';
import { buildTimeString, parseTimeString, TimePickerField } from '@/components/TimePickerField';
import { DAY_OPTIONS, daysForFrequency, Frequency, frequencyForDays } from '@/lib/frequency';
import { supabase } from '@/lib/supabase';

// ─── Types & constants ────────────────────────────────────────────────────────

type ReminderType = 'medication' | 'hydration' | 'appointment' | 'meal' | 'exercise' | 'other';

const REMINDER_TYPES: ReminderType[] = ['medication', 'hydration', 'appointment', 'meal', 'exercise', 'other'];
const FREQUENCIES:    Frequency[]    = ['daily', 'weekdays', 'weekends', 'custom'];

const TYPE_ICON_NAMES: Record<ReminderType, string> = {
    medication:  'medical-outline',
    hydration:   'water-outline',
    appointment: 'calendar-outline',
    meal:        'restaurant-outline',
    exercise:    'walk-outline',
    other:       'ellipsis-horizontal-outline',
};

const TYPE_LABELS: Record<ReminderType, string> = {
    medication: 'Medication', hydration: 'Hydration', appointment: 'Appointment',
    meal: 'Meal', exercise: 'Exercise', other: 'Other',
};

const FREQUENCY_LABELS: Record<Frequency, string> = {
    daily: 'Every day', weekdays: 'Mon–Fri', weekends: 'Sat–Sun', custom: 'Custom days',
};

const NO_RESPONSE_OPTIONS = [1, 5, 10, 15, 30, 60];

function formatResponseMinutes(m: number): string {
    return m < 60 ? `${m} min` : `${m / 60} hr`;
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function EditReminderScreen() {
    const C = useThemeColors();
    const styles = useMemo(() => createStyles(C), [C]);
    const { reminderId } = useLocalSearchParams<{ reminderId: string }>();

    const [pageLoading,  setPageLoading]  = useState(true);
    const [saving,       setSaving]       = useState(false);
    const [deactivating, setDeactivating] = useState(false);
    const [error,        setError]        = useState<string | null>(null);
    const [focused,      setFocused]      = useState<string | null>(null);

    // Form state
    const [title,             setTitle]             = useState('');
    const [reminderType,      setReminderType]      = useState<ReminderType>('medication');
    const [notes,             setNotes]             = useState('');
    const [timeValue,         setTimeValue]         = useState<Date>(() => {
        const d = new Date();
        d.setHours(8, 0, 0, 0);
        return d;
    });
    const [frequency,         setFrequency]         = useState<Frequency>('daily');
    const [selectedDays,      setSelectedDays]      = useState<number[]>([]);
    const [noResponseMinutes, setNoResponseMinutes] = useState(15);
    const [participantName,   setParticipantName]   = useState<string | null>(null);
    const [connectionId,      setConnectionId]      = useState<string | null>(null);

    function toggleDay(iso: number) {
        setSelectedDays((prev) =>
            prev.includes(iso) ? prev.filter((d) => d !== iso) : [...prev, iso]
        );
    }

    useEffect(() => {
        if (!reminderId) {
            setError('No reminder selected. Go back and try again.');
            setPageLoading(false);
            return;
        }
        loadReminder();
    }, [reminderId]);

    async function loadReminder() {
        setPageLoading(true);
        setError(null);

        const { data: { user } } = await supabase.auth.getUser();
        if (!user) { setError('Not authenticated.'); setPageLoading(false); return; }

        const { data: rem, error: remErr } = await supabase
            .from('reminders')
            .select('id, connection_id, caregiver_id, recipient_id, title, reminder_type, notes, time_of_day, frequency, days_of_week, no_response_minutes')
            .eq('id', reminderId)
            .eq('caregiver_id', user.id)
            .eq('is_active', true)
            .maybeSingle();

        if (remErr || !rem) {
            setError('Reminder not found or you do not have permission to edit it.');
            setPageLoading(false);
            return;
        }

        const { data: recipientProfile } = await supabase
            .from('profiles')
            .select('full_name')
            .eq('id', rem.recipient_id)
            .maybeSingle();
        setParticipantName(recipientProfile?.full_name || 'Participant');
        setConnectionId(rem.connection_id);

        setTitle(rem.title);
        setReminderType(rem.reminder_type as ReminderType);
        setNotes(rem.notes || '');
        setTimeValue(parseTimeString(rem.time_of_day));
        // days_of_week is the source of truth — derive which preset (if any)
        // it matches rather than trusting the stored frequency text.
        setFrequency(frequencyForDays(rem.days_of_week));
        setSelectedDays(rem.days_of_week);
        setNoResponseMinutes(
            NO_RESPONSE_OPTIONS.includes(rem.no_response_minutes) ? rem.no_response_minutes : 15
        );
        setPageLoading(false);
    }

    async function saveChanges() {
        if (!title.trim()) {
            Alert.alert('Missing title', 'Please enter a reminder name.');
            return;
        }

        if (frequency === 'custom' && selectedDays.length === 0) {
            Alert.alert('Select at least one day', 'Choose at least one day for a custom schedule.');
            return;
        }

        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        setSaving(true);

        const { error: updateError } = await supabase
            .from('reminders')
            .update({
                title:               title.trim(),
                reminder_type:       reminderType,
                notes:               notes.trim() || null,
                time_of_day:         buildTimeString(timeValue),
                frequency,
                days_of_week:        daysForFrequency(frequency, selectedDays),
                no_response_minutes: noResponseMinutes,
                updated_at:          new Date().toISOString(),
            })
            .eq('id', reminderId);

        setSaving(false);

        if (updateError) {
            Alert.alert('Error saving', updateError.message);
            return;
        }

        router.replace(
            connectionId
                ? { pathname: '/caregiver-dashboard', params: { connectionId } }
                : '/caregiver-dashboard'
        );
    }

    function confirmDeactivate() {
        Alert.alert(
            'Deactivate Reminder?',
            'Deactivating keeps past history but stops future reminders. This cannot be undone from the app.',
            [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Deactivate', style: 'destructive', onPress: deactivate },
            ]
        );
    }

    async function deactivate() {
        setDeactivating(true);

        const { error: updateError } = await supabase
            .from('reminders')
            .update({ is_active: false, updated_at: new Date().toISOString() })
            .eq('id', reminderId);

        setDeactivating(false);

        if (updateError) {
            Alert.alert('Error', updateError.message);
            return;
        }

        router.replace(
            connectionId
                ? { pathname: '/caregiver-dashboard', params: { connectionId } }
                : '/caregiver-dashboard'
        );
    }

    const inputStyle = (field: string) => [
        styles.input,
        focused === field && styles.inputFocused,
    ];

    // ── Render ────────────────────────────────────────────────────────────────

    return (
        <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
            <KeyboardAvoidingView
                style={styles.kav}
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            >
                {pageLoading ? (
                    <View style={styles.centered}>
                        <ActivityIndicator color={C.primary} size="large" />
                        <Text style={styles.loadingText}>Loading reminder…</Text>
                    </View>
                ) : error ? (
                    <View style={styles.centered}>
                        <View style={styles.errorIconWrap}>
                            <Ionicons name="alert-circle-outline" size={32} color={C.textMuted} />
                        </View>
                        <Text style={styles.errorTitle}>Can't load reminder</Text>
                        <Text style={styles.errorText}>{error}</Text>
                        <TouchableOpacity style={styles.errorBack} onPress={() => router.back()}>
                            <Text style={styles.errorBackText}>Go back</Text>
                        </TouchableOpacity>
                    </View>
                ) : (
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
                            <Text style={styles.backText}>Back</Text>
                        </TouchableOpacity>

                        {/* Header */}
                        <Text style={styles.heading}>Edit Reminder</Text>
                        <Text style={styles.subheading}>
                            Changes apply to future reminders. Past logs are preserved.
                        </Text>

                        {/* ── Participant (read-only for MVP) ─────────────── */}
                        {participantName && (
                            <View style={styles.participantBanner}>
                                <View style={styles.participantAvatar}>
                                    <Text style={styles.participantAvatarText}>
                                        {participantName.charAt(0).toUpperCase()}
                                    </Text>
                                </View>
                                <View>
                                    <Text style={styles.participantBannerLabel}>For</Text>
                                    <Text style={styles.participantBannerName}>{participantName}</Text>
                                </View>
                            </View>
                        )}

                        {/* ── Section 1: What ─────────────────────────────── */}
                        <View style={[styles.sectionCard, SHADOW.xs]}>
                            <View style={styles.sectionHeader}>
                                <View style={[styles.sectionIconWrap, { backgroundColor: C.primaryLight }]}>
                                    <Ionicons name="create-outline" size={18} color={C.primary} />
                                </View>
                                <Text style={styles.sectionTitle}>What</Text>
                            </View>

                            <Text style={styles.label}>Reminder name</Text>
                            <TextInput
                                style={inputStyle('title')}
                                placeholder="e.g. Morning check-in"
                                placeholderTextColor={C.textMuted}
                                value={title}
                                onChangeText={setTitle}
                                onFocus={() => setFocused('title')}
                                onBlur={() => setFocused(null)}
                                returnKeyType="next"
                            />

                            <Text style={[styles.label, { marginTop: 18 }]}>Type</Text>
                            <View style={styles.typeGrid}>
                                {REMINDER_TYPES.map((type) => (
                                    <TouchableOpacity
                                        key={type}
                                        style={[
                                            styles.typeChip,
                                            reminderType === type && styles.chipActive,
                                        ]}
                                        onPress={() => setReminderType(type)}
                                        activeOpacity={0.75}
                                    >
                                        <Ionicons
                                            name={TYPE_ICON_NAMES[type] as any}
                                            size={15}
                                            color={reminderType === type ? C.primary : C.textMuted}
                                        />
                                        <Text
                                            style={[
                                                styles.chipText,
                                                reminderType === type && styles.chipTextActive,
                                            ]}
                                        >
                                            {TYPE_LABELS[type]}
                                        </Text>
                                    </TouchableOpacity>
                                ))}
                            </View>
                        </View>

                        {/* ── Section 2: When ─────────────────────────────── */}
                        <View style={[styles.sectionCard, SHADOW.xs]}>
                            <View style={styles.sectionHeader}>
                                <View style={[styles.sectionIconWrap, { backgroundColor: '#FEF3C7' }]}>
                                    <Ionicons name="time-outline" size={18} color="#D97706" />
                                </View>
                                <Text style={styles.sectionTitle}>When</Text>
                            </View>

                            <Text style={styles.label}>Time of day</Text>
                            <TimePickerField value={timeValue} onChange={setTimeValue} />

                            <Text style={[styles.label, { marginTop: 18 }]}>Frequency</Text>
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
                                    >
                                        <Text
                                            style={[
                                                styles.chipText,
                                                frequency === item && styles.chipTextActive,
                                            ]}
                                        >
                                            {FREQUENCY_LABELS[item]}
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
                                        >
                                            <Text
                                                style={[
                                                    styles.chipText,
                                                    selectedDays.includes(day.iso) && styles.chipTextActive,
                                                ]}
                                            >
                                                {day.short}
                                            </Text>
                                        </TouchableOpacity>
                                    ))}
                                </View>
                            )}
                        </View>

                        {/* ── Section 3: Alerts ───────────────────────────── */}
                        <View style={[styles.sectionCard, SHADOW.xs]}>
                            <View style={styles.sectionHeader}>
                                <View style={[styles.sectionIconWrap, { backgroundColor: C.successLight }]}>
                                    <Ionicons name="timer-outline" size={18} color={C.success} />
                                </View>
                                <Text style={styles.sectionTitle}>Alerts</Text>
                            </View>

                            <Text style={styles.label}>Mark as missed after</Text>
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
                                Reminder is marked as missed if no response arrives within this window.
                            </Text>

                            <Text style={[styles.label, { marginTop: 18 }]}>
                                Notes <Text style={styles.labelOptional}>(optional)</Text>
                            </Text>
                            <TextInput
                                style={[inputStyle('notes'), styles.notesInput]}
                                placeholder="e.g. Take with food and a full glass of water."
                                placeholderTextColor={C.textMuted}
                                value={notes}
                                onChangeText={setNotes}
                                onFocus={() => setFocused('notes')}
                                onBlur={() => setFocused(null)}
                                multiline
                                textAlignVertical="top"
                            />
                        </View>

                        {/* ── Save button ──────────────────────────────────── */}
                        <TouchableOpacity
                            style={[
                                styles.saveButton,
                                SHADOW.primary,
                                (saving || deactivating) && styles.buttonDisabled,
                            ]}
                            onPress={saveChanges}
                            disabled={saving || deactivating}
                            activeOpacity={0.88}
                        >
                            {saving ? (
                                <ActivityIndicator color={C.textInverse} />
                            ) : (
                                <>
                                    <Ionicons name="checkmark-circle" size={20} color={C.textInverse} />
                                    <Text style={styles.saveButtonText}>Save Changes</Text>
                                </>
                            )}
                        </TouchableOpacity>

                        {/* ── Deactivate button ────────────────────────────── */}
                        <View style={styles.deactivateSection}>
                            <View style={styles.deactivateDivider} />
                            <Text style={styles.deactivateHint}>
                                Deactivating keeps past history but stops future reminders.
                            </Text>
                            <TouchableOpacity
                                style={[
                                    styles.deactivateButton,
                                    (saving || deactivating) && styles.buttonDisabled,
                                ]}
                                onPress={confirmDeactivate}
                                disabled={saving || deactivating}
                                activeOpacity={0.75}
                            >
                                {deactivating ? (
                                    <ActivityIndicator color={C.error} size="small" />
                                ) : (
                                    <>
                                        <Ionicons name="archive-outline" size={17} color={C.error} />
                                        <Text style={styles.deactivateButtonText}>Deactivate Reminder</Text>
                                    </>
                                )}
                            </TouchableOpacity>
                        </View>
                    </ScrollView>
                )}
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const createStyles = (C: ThemeColors) => StyleSheet.create({
    container: { flex: 1, backgroundColor: C.bgPage },
    kav:       { flex: 1 },
    content: {
        paddingHorizontal: 20,
        paddingTop: 12,
        paddingBottom: 48,
    },

    // ── Loading / error states ────────────────────────────────────────────────
    centered: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
        gap: 12,
    },
    loadingText: { fontSize: 14, color: C.textMuted, fontWeight: '600', marginTop: 8 },
    errorIconWrap: {
        width: 60,
        height: 60,
        borderRadius: RADIUS.lg,
        backgroundColor: C.bgAlt,
        alignItems: 'center',
        justifyContent: 'center',
    },
    errorTitle: { fontSize: 17, fontWeight: '700', color: C.textPrimary, textAlign: 'center' },
    errorText:  { fontSize: 14, color: C.textMuted, textAlign: 'center', lineHeight: 20 },
    errorBack: {
        marginTop: 8,
        paddingHorizontal: 24,
        paddingVertical: 12,
        backgroundColor: C.primary,
        borderRadius: RADIUS.lg,
    },
    errorBackText: { color: C.textInverse, fontSize: 15, fontWeight: '700' },

    // ── Navigation ────────────────────────────────────────────────────────────
    backButton: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 24,
        alignSelf: 'flex-start',
    },
    backText: { fontSize: 16, fontWeight: '600', color: C.primary, marginLeft: 2 },

    // ── Header ────────────────────────────────────────────────────────────────
    heading: {
        fontSize: 30,
        fontWeight: '800',
        color: C.textPrimary,
        letterSpacing: -0.6,
        marginBottom: 8,
    },
    subheading: {
        fontSize: 15,
        color: C.textSecondary,
        lineHeight: 22,
        letterSpacing: -0.1,
        marginBottom: 24,
    },

    // ── Participant banner ───────────────────────────────────────────────────
    participantBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        backgroundColor: C.bgAlt,
        borderRadius: RADIUS.lg,
        paddingVertical: 10,
        paddingHorizontal: 14,
        marginBottom: 14,
    },
    participantAvatar: {
        width: 32,
        height: 32,
        borderRadius: RADIUS.full,
        backgroundColor: C.primaryLight,
        alignItems: 'center',
        justifyContent: 'center',
    },
    participantAvatarText: {
        fontSize: 14,
        fontWeight: '700',
        color: C.primary,
    },
    participantBannerLabel: {
        fontSize: 11,
        fontWeight: '600',
        color: C.textMuted,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
    },
    participantBannerName: {
        fontSize: 15,
        fontWeight: '700',
        color: C.textPrimary,
    },

    // ── Section cards ─────────────────────────────────────────────────────────
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

    // ── Form fields ───────────────────────────────────────────────────────────
    label: {
        fontSize: 13,
        fontWeight: '700',
        color: C.textPrimary,
        marginBottom: 8,
        letterSpacing: 0.1,
    },
    labelOptional: { fontWeight: '500', color: C.textMuted },
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
    inputFocused: { backgroundColor: C.bgSurface, borderColor: C.borderFocus },
    notesInput: { minHeight: 88, textAlignVertical: 'top', paddingTop: 14 },
    helperText: { fontSize: 12, color: C.textMuted, marginTop: 6, lineHeight: 17 },

    // ── Type chip grid ────────────────────────────────────────────────────────
    typeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
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

    // ── Shared chip styles ────────────────────────────────────────────────────
    chipActive: { backgroundColor: C.primaryLight, borderColor: C.primary },
    chipText:   { color: C.textSecondary, fontSize: 13, fontWeight: '600' },
    chipTextActive: { color: C.primary, fontWeight: '700' },

    // ── Frequency chips ───────────────────────────────────────────────────────
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

    // ── Custom day chips ────────────────────────────────────────────────────────
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

    // ── No-response chip grid ─────────────────────────────────────────────────
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

    // ── Save button ───────────────────────────────────────────────────────────
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
    buttonDisabled: { opacity: 0.55 },
    saveButtonText: {
        color: C.textInverse,
        fontSize: 17,
        fontWeight: '700',
        letterSpacing: -0.2,
    },

    // ── Deactivate section ────────────────────────────────────────────────────
    deactivateSection: { marginTop: 24, alignItems: 'center' },
    deactivateDivider: {
        width: '100%',
        height: 1,
        backgroundColor: C.border,
        marginBottom: 20,
    },
    deactivateHint: {
        fontSize: 13,
        color: C.textMuted,
        textAlign: 'center',
        lineHeight: 18,
        marginBottom: 14,
        paddingHorizontal: 16,
    },
    deactivateButton: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingVertical: 14,
        paddingHorizontal: 24,
        borderRadius: RADIUS.xl,
        borderWidth: 1.5,
        borderColor: C.error,
        backgroundColor: '#FEF2F2',
    },
    deactivateButtonText: {
        color: C.error,
        fontSize: 15,
        fontWeight: '700',
        letterSpacing: -0.1,
    },
});
