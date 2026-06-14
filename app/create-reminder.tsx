import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useState } from 'react';
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

import { RADIUS, SHADOW, T } from '@/constants/theme';
import { supabase } from '@/lib/supabase';

type ReminderType = 'medication' | 'hydration' | 'appointment' | 'meal' | 'exercise' | 'other';
type Frequency    = 'daily' | 'weekdays' | 'weekends';

const REMINDER_TYPES: ReminderType[] = ['medication', 'hydration', 'appointment', 'meal', 'exercise', 'other'];
const FREQUENCIES:    Frequency[]    = ['daily', 'weekdays', 'weekends'];

const TYPE_ICONS: Record<ReminderType, string> = {
    medication:  '💊',
    hydration:   '💧',
    appointment: '📅',
    meal:        '🍽️',
    exercise:    '🏃',
    other:       '•',
};

const TYPE_LABELS: Record<ReminderType, string> = {
    medication:  'Medication',
    hydration:   'Hydration',
    appointment: 'Appointment',
    meal:        'Meal',
    exercise:    'Exercise',
    other:       'Other',
};

const FREQUENCY_LABELS: Record<Frequency, string> = {
    daily:    'Every day',
    weekdays: 'Mon–Fri',
    weekends: 'Sat–Sun',
};

// ─── Inline time picker ───────────────────────────────────────────────────────

type TimePickerProps = {
    hour: number;        // 1–12
    minute: number;      // 0–59
    meridiem: 'AM' | 'PM';
    onChangeHour: (h: number) => void;
    onChangeMinute: (m: number) => void;
    onChangeMeridiem: (m: 'AM' | 'PM') => void;
};

function TimePicker({ hour, minute, meridiem, onChangeHour, onChangeMinute, onChangeMeridiem }: TimePickerProps) {
    const [open, setOpen] = useState(false);

    const displayLabel = `${hour}:${String(minute).padStart(2, '0')} ${meridiem}`;

    function adjustHour(delta: number) {
        onChangeHour(((hour - 1 + delta + 12) % 12) + 1);
    }

    function adjustMinute(delta: number) {
        onChangeMinute((minute + delta + 60) % 60);
    }

    return (
        <View>
            {/* Tappable display row */}
            <TouchableOpacity
                style={[styles.timeButton, open && styles.timeButtonOpen]}
                onPress={() => setOpen((v) => !v)}
                activeOpacity={0.8}
            >
                <Ionicons name="time-outline" size={20} color={T.primary} />
                <Text style={styles.timeButtonText}>{displayLabel}</Text>
                <Ionicons
                    name={open ? 'chevron-up' : 'chevron-down'}
                    size={16}
                    color={T.textMuted}
                />
            </TouchableOpacity>

            {/* Expanded picker */}
            {open && (
                <View style={styles.pickerPanel}>
                    {/* Hour column */}
                    <View style={styles.pickerColumn}>
                        <TouchableOpacity style={styles.pickerArrow} onPress={() => adjustHour(1)} activeOpacity={0.7}>
                            <Ionicons name="chevron-up" size={24} color={T.primary} />
                        </TouchableOpacity>
                        <Text style={styles.pickerValue}>{String(hour).padStart(2, '0')}</Text>
                        <TouchableOpacity style={styles.pickerArrow} onPress={() => adjustHour(-1)} activeOpacity={0.7}>
                            <Ionicons name="chevron-down" size={24} color={T.primary} />
                        </TouchableOpacity>
                        <Text style={styles.pickerUnit}>hr</Text>
                    </View>

                    <Text style={styles.pickerColon}>:</Text>

                    {/* Minute column */}
                    <View style={styles.pickerColumn}>
                        <TouchableOpacity style={styles.pickerArrow} onPress={() => adjustMinute(5)} activeOpacity={0.7}>
                            <Ionicons name="chevron-up" size={24} color={T.primary} />
                        </TouchableOpacity>
                        <Text style={styles.pickerValue}>{String(minute).padStart(2, '0')}</Text>
                        <TouchableOpacity style={styles.pickerArrow} onPress={() => adjustMinute(-5)} activeOpacity={0.7}>
                            <Ionicons name="chevron-down" size={24} color={T.primary} />
                        </TouchableOpacity>
                        <Text style={styles.pickerUnit}>min</Text>
                    </View>

                    {/* AM / PM toggle */}
                    <View style={styles.meridiemWrap}>
                        {(['AM', 'PM'] as const).map((m) => (
                            <TouchableOpacity
                                key={m}
                                style={[styles.meridiemBtn, meridiem === m && styles.meridiemBtnActive]}
                                onPress={() => onChangeMeridiem(m)}
                                activeOpacity={0.75}
                            >
                                <Text style={[styles.meridiemText, meridiem === m && styles.meridiemTextActive]}>
                                    {m}
                                </Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                </View>
            )}
        </View>
    );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildTimeString(hour: number, minute: number, meridiem: 'AM' | 'PM'): string {
    let h = hour;
    if (meridiem === 'AM' && h === 12) h = 0;
    if (meridiem === 'PM' && h !== 12) h += 12;
    return `${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function CreateReminderScreen() {
    const [title, setTitle]                         = useState('');
    const [reminderType, setReminderType]           = useState<ReminderType>('medication');
    const [notes, setNotes]                         = useState('');
    const [pickerHour, setPickerHour]               = useState(8);
    const [pickerMinute, setPickerMinute]           = useState(0);
    const [pickerMeridiem, setPickerMeridiem]       = useState<'AM' | 'PM'>('AM');
    const [frequency, setFrequency]                 = useState<Frequency>('daily');
    const [noResponseMinutes, setNoResponseMinutes] = useState('30');
    const [loading, setLoading]                     = useState(false);
    const [focused, setFocused]                     = useState<string | null>(null);

    async function saveReminder() {
        const timeOfDay        = buildTimeString(pickerHour, pickerMinute, pickerMeridiem);
        const noResponseNumber = Number(noResponseMinutes);

        if (!title.trim()) {
            Alert.alert('Missing title', 'Please enter a reminder name.');
            return;
        }
        if (!noResponseNumber || noResponseNumber < 1) {
            Alert.alert('Invalid window', 'Enter a number of minutes greater than 0.');
            return;
        }

        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        setLoading(true);

        const { data: { user }, error: userError } = await supabase.auth.getUser();

        if (userError || !user) {
            setLoading(false);
            Alert.alert('Not signed in', 'Please sign in again.');
            return;
        }

        const { data: connection, error: connectionError } = await supabase
            .from('connections')
            .select('id, recipient_id')
            .eq('caregiver_id', user.id)
            .eq('status', 'accepted')
            .not('recipient_id', 'is', null)
            .limit(1)
            .maybeSingle();

        if (connectionError) {
            setLoading(false);
            Alert.alert('Connection error', connectionError.message);
            return;
        }

        if (!connection?.recipient_id) {
            setLoading(false);
            Alert.alert(
                'No connected recipient',
                'Invite a loved one and have them accept the code before creating reminders.'
            );
            return;
        }

        const { error } = await supabase.from('reminders').insert({
            connection_id:       connection.id,
            caregiver_id:        user.id,
            recipient_id:        connection.recipient_id,
            title:               title.trim(),
            reminder_type:       reminderType,
            notes:               notes.trim() || null,
            time_of_day:         timeOfDay,
            frequency,
            no_response_minutes: noResponseNumber,
            is_active:           true,
        });

        setLoading(false);

        if (error) {
            Alert.alert('Reminder error', error.message);
            return;
        }

        Alert.alert('Reminder saved', 'This reminder is now linked to your loved one.');
        router.replace('/caregiver-dashboard');
    }

    const inputStyle = (field: string) => [
        styles.input,
        focused === field && styles.inputFocused,
    ];

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
                        <Ionicons name="chevron-back" size={22} color={T.primary} />
                        <Text style={styles.backText}>Back</Text>
                    </TouchableOpacity>

                    {/* Header */}
                    <Text style={styles.heading}>Create Reminder</Text>
                    <Text style={styles.subheading}>
                        Add a care task your loved one needs to complete.
                    </Text>

                    {/* ── Section 1: What ─────────────────────────────────── */}
                    <View style={[styles.sectionCard, SHADOW.xs]}>
                        <View style={styles.sectionHeader}>
                            <View style={[styles.sectionIconWrap, { backgroundColor: T.primaryLight }]}>
                                <Ionicons name="create-outline" size={18} color={T.primary} />
                            </View>
                            <Text style={styles.sectionTitle}>What</Text>
                        </View>

                        <Text style={styles.label}>Reminder name</Text>
                        <TextInput
                            style={inputStyle('title')}
                            placeholder="e.g. Blood pressure medication"
                            placeholderTextColor={T.textMuted}
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
                                        reminderType === type && styles.typeChipActive,
                                    ]}
                                    onPress={() => setReminderType(type)}
                                    activeOpacity={0.75}
                                >
                                    <Text style={styles.typeChipEmoji}>{TYPE_ICONS[type]}</Text>
                                    <Text
                                        style={[
                                            styles.typeChipText,
                                            reminderType === type && styles.typeChipTextActive,
                                        ]}
                                    >
                                        {TYPE_LABELS[type]}
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
                            <Text style={styles.sectionTitle}>When</Text>
                        </View>

                        <Text style={styles.label}>Time of day</Text>
                        <TimePicker
                            hour={pickerHour}
                            minute={pickerMinute}
                            meridiem={pickerMeridiem}
                            onChangeHour={setPickerHour}
                            onChangeMinute={setPickerMinute}
                            onChangeMeridiem={setPickerMeridiem}
                        />

                        <Text style={[styles.label, { marginTop: 18 }]}>Frequency</Text>
                        <View style={styles.frequencyRow}>
                            {FREQUENCIES.map((item) => (
                                <TouchableOpacity
                                    key={item}
                                    style={[
                                        styles.frequencyChip,
                                        frequency === item && styles.typeChipActive,
                                    ]}
                                    onPress={() => setFrequency(item)}
                                    activeOpacity={0.75}
                                >
                                    <Text
                                        style={[
                                            styles.typeChipText,
                                            frequency === item && styles.typeChipTextActive,
                                        ]}
                                    >
                                        {FREQUENCY_LABELS[item]}
                                    </Text>
                                </TouchableOpacity>
                            ))}
                        </View>
                    </View>

                    {/* ── Section 3: Response & Notes ─────────────────────── */}
                    <View style={[styles.sectionCard, SHADOW.xs]}>
                        <View style={styles.sectionHeader}>
                            <View style={[styles.sectionIconWrap, { backgroundColor: T.successLight }]}>
                                <Ionicons name="settings-outline" size={18} color={T.success} />
                            </View>
                            <Text style={styles.sectionTitle}>Settings</Text>
                        </View>

                        <Text style={styles.label}>Alert if no response after</Text>
                        <View style={styles.minutesRow}>
                            <TextInput
                                style={[inputStyle('minutes'), styles.minutesInput]}
                                placeholder="30"
                                placeholderTextColor={T.textMuted}
                                keyboardType="number-pad"
                                value={noResponseMinutes}
                                onChangeText={setNoResponseMinutes}
                                onFocus={() => setFocused('minutes')}
                                onBlur={() => setFocused(null)}
                                returnKeyType="done"
                            />
                            <View style={styles.minutesSuffix}>
                                <Text style={styles.minutesSuffixText}>minutes</Text>
                            </View>
                        </View>
                        <Text style={styles.helperText}>
                            Reminder is marked as missed if no response arrives within this window.
                        </Text>

                        <Text style={[styles.label, { marginTop: 18 }]}>Notes <Text style={styles.labelOptional}>(optional)</Text></Text>
                        <TextInput
                            style={[inputStyle('notes'), styles.notesInput]}
                            placeholder="e.g. Take with food and a full glass of water."
                            placeholderTextColor={T.textMuted}
                            value={notes}
                            onChangeText={setNotes}
                            onFocus={() => setFocused('notes')}
                            onBlur={() => setFocused(null)}
                            multiline
                            textAlignVertical="top"
                        />
                    </View>

                    {/* Save */}
                    <TouchableOpacity
                        style={[styles.saveButton, SHADOW.primary, loading && styles.saveButtonDisabled]}
                        onPress={saveReminder}
                        disabled={loading}
                        activeOpacity={0.88}
                    >
                        {loading ? (
                            <ActivityIndicator color={T.textInverse} />
                        ) : (
                            <>
                                <Ionicons name="checkmark-circle" size={20} color={T.textInverse} />
                                <Text style={styles.saveButtonText}>Save Reminder</Text>
                            </>
                        )}
                    </TouchableOpacity>
                </ScrollView>
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: T.bgPage },
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
        color: T.primary,
        marginLeft: 2,
    },

    // ── Header ────────────────────────────────────────────────────────
    heading: {
        fontSize: 30,
        fontWeight: '800',
        color: T.textPrimary,
        letterSpacing: -0.6,
        marginBottom: 8,
    },
    subheading: {
        fontSize: 15,
        color: T.textSecondary,
        lineHeight: 22,
        letterSpacing: -0.1,
        marginBottom: 24,
    },

    // ── Section cards ─────────────────────────────────────────────────
    sectionCard: {
        backgroundColor: T.bgSurface,
        borderRadius: RADIUS.xl,
        padding: 18,
        marginBottom: 14,
        borderWidth: 1,
        borderColor: T.border,
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
        color: T.textPrimary,
        letterSpacing: -0.2,
    },

    // ── Form fields ───────────────────────────────────────────────────
    label: {
        fontSize: 13,
        fontWeight: '700',
        color: T.textPrimary,
        marginBottom: 8,
        letterSpacing: 0.1,
    },
    labelOptional: {
        fontWeight: '500',
        color: T.textMuted,
    },
    input: {
        backgroundColor: T.bgAlt,
        borderRadius: RADIUS.lg,
        paddingHorizontal: 14,
        paddingVertical: Platform.OS === 'ios' ? 14 : 12,
        fontSize: 16,
        borderWidth: 1.5,
        borderColor: 'transparent',
        color: T.textPrimary,
        fontWeight: '500',
    },
    inputFocused: {
        backgroundColor: T.bgSurface,
        borderColor: T.borderFocus,
    },
    notesInput: {
        minHeight: 88,
        textAlignVertical: 'top',
        paddingTop: 14,
    },
    helperText: {
        fontSize: 12,
        color: T.textMuted,
        marginTop: 6,
        lineHeight: 17,
    },

    // ── Time picker ───────────────────────────────────────────────────
    timeButton: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        backgroundColor: T.bgAlt,
        borderRadius: RADIUS.lg,
        paddingHorizontal: 14,
        paddingVertical: Platform.OS === 'ios' ? 14 : 12,
        borderWidth: 1.5,
        borderColor: 'transparent',
    },
    timeButtonOpen: {
        backgroundColor: T.bgSurface,
        borderColor: T.borderFocus,
        borderBottomLeftRadius: 0,
        borderBottomRightRadius: 0,
    },
    timeButtonText: {
        flex: 1,
        fontSize: 17,
        fontWeight: '700',
        color: T.textPrimary,
        letterSpacing: -0.2,
    },
    pickerPanel: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        backgroundColor: T.bgSurface,
        borderWidth: 1.5,
        borderTopWidth: 0,
        borderColor: T.borderFocus,
        borderBottomLeftRadius: RADIUS.lg,
        borderBottomRightRadius: RADIUS.lg,
        paddingVertical: 16,
        paddingHorizontal: 12,
    },
    pickerColumn: {
        alignItems: 'center',
        gap: 4,
        minWidth: 64,
    },
    pickerArrow: {
        padding: 6,
    },
    pickerValue: {
        fontSize: 32,
        fontWeight: '800',
        color: T.textPrimary,
        letterSpacing: -1,
        lineHeight: 40,
    },
    pickerUnit: {
        fontSize: 11,
        fontWeight: '600',
        color: T.textMuted,
        letterSpacing: 0.4,
        textTransform: 'uppercase',
        marginTop: 2,
    },
    pickerColon: {
        fontSize: 28,
        fontWeight: '800',
        color: T.textPrimary,
        marginBottom: 18,
        alignSelf: 'center',
    },
    meridiemWrap: {
        borderRadius: RADIUS.lg,
        overflow: 'hidden',
        borderWidth: 1.5,
        borderColor: T.border,
        marginLeft: 8,
    },
    meridiemBtn: {
        paddingVertical: 14,
        paddingHorizontal: 18,
        backgroundColor: T.bgAlt,
    },
    meridiemBtnActive: {
        backgroundColor: T.primary,
    },
    meridiemText: {
        fontSize: 15,
        fontWeight: '700',
        color: T.textMuted,
    },
    meridiemTextActive: {
        color: T.textInverse,
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
        backgroundColor: T.bgAlt,
        paddingVertical: 10,
        paddingHorizontal: 13,
        borderRadius: RADIUS.lg,
        borderWidth: 1.5,
        borderColor: 'transparent',
    },
    typeChipActive: {
        backgroundColor: T.primaryLight,
        borderColor: T.primary,
    },
    typeChipEmoji: { fontSize: 14 },
    typeChipText: {
        color: T.textSecondary,
        fontSize: 13,
        fontWeight: '600',
    },
    typeChipTextActive: {
        color: T.primary,
        fontWeight: '700',
    },

    // ── Frequency chips ───────────────────────────────────────────────
    frequencyRow: { flexDirection: 'row', gap: 8 },
    frequencyChip: {
        flex: 1,
        backgroundColor: T.bgAlt,
        paddingVertical: 12,
        borderRadius: RADIUS.lg,
        alignItems: 'center',
        borderWidth: 1.5,
        borderColor: 'transparent',
    },

    // ── Minutes input row ─────────────────────────────────────────────
    minutesRow: {
        flexDirection: 'row',
        gap: 10,
        alignItems: 'center',
    },
    minutesInput: {
        width: 90,
        textAlign: 'center',
    },
    minutesSuffix: {
        flex: 1,
        height: Platform.OS === 'ios' ? 50 : 46,
        backgroundColor: T.bgAlt,
        borderRadius: RADIUS.lg,
        justifyContent: 'center',
        paddingHorizontal: 14,
    },
    minutesSuffixText: {
        fontSize: 15,
        color: T.textMuted,
        fontWeight: '500',
    },

    // ── Save button ───────────────────────────────────────────────────
    saveButton: {
        backgroundColor: T.primary,
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
        color: T.textInverse,
        fontSize: 17,
        fontWeight: '700',
        letterSpacing: -0.2,
    },
});
