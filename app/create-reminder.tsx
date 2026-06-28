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
import { buildTimeString, TimePickerField } from '@/components/TimePickerField';
import { DAY_OPTIONS, daysForFrequency, Frequency } from '@/lib/frequency';
import { supabase } from '@/lib/supabase';

type ReminderType = 'medication' | 'hydration' | 'appointment' | 'meal' | 'exercise' | 'other';

type ParticipantOption = {
    connectionId: string;
    recipientId: string;
    recipientName: string;
};

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
    custom:   'Custom days',
};

const NO_RESPONSE_OPTIONS = [1, 5, 10, 15, 30, 60];

function formatResponseMinutes(m: number): string {
    return m < 60 ? `${m} min` : `${m / 60} hr`;
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function CreateReminderScreen() {
    const C = useThemeColors();
    const styles = useMemo(() => createStyles(C), [C]);
    const { connectionId: preselectConnectionId } = useLocalSearchParams<{ connectionId?: string }>();

    const [participants, setParticipants]           = useState<ParticipantOption[]>([]);
    const [participantsLoading, setParticipantsLoading] = useState(true);
    const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);

    const [title, setTitle]                         = useState('');
    const [reminderType, setReminderType]           = useState<ReminderType>('medication');
    const [notes, setNotes]                         = useState('');
    const [timeValue, setTimeValue]                 = useState<Date>(() => {
        const d = new Date();
        d.setHours(8, 0, 0, 0);
        return d;
    });
    const [frequency, setFrequency]                 = useState<Frequency>('daily');
    const [selectedDays, setSelectedDays]           = useState<number[]>([]);
    const [noResponseMinutes, setNoResponseMinutes] = useState(15);
    const [loading, setLoading]                     = useState(false);
    const [focused, setFocused]                     = useState<string | null>(null);

    useEffect(() => {
        (async () => {
            setParticipantsLoading(true);

            const { data: { user } } = await supabase.auth.getUser();
            if (!user) { setParticipantsLoading(false); return; }

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
                recipientName: nameById.get(c.recipient_id as string) || 'Participant',
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

    async function saveReminder() {
        const selected = participants.find((p) => p.connectionId === selectedConnectionId);
        if (!selected) {
            Alert.alert('Choose a participant', 'Select who this reminder is for before saving.');
            return;
        }

        if (!title.trim()) {
            Alert.alert('Missing title', 'Please enter a reminder name.');
            return;
        }

        if (frequency === 'custom' && selectedDays.length === 0) {
            Alert.alert('Select at least one day', 'Choose at least one day for a custom schedule.');
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

        const { error } = await supabase.from('reminders').insert({
            connection_id:       selected.connectionId,
            caregiver_id:        user.id,
            recipient_id:        selected.recipientId,
            title:               title.trim(),
            reminder_type:       reminderType,
            notes:               notes.trim() || null,
            time_of_day:         buildTimeString(timeValue),
            frequency,
            days_of_week:        daysForFrequency(frequency, selectedDays),
            no_response_minutes: noResponseMinutes,
            is_active:           true,
        });

        setLoading(false);

        if (error) {
            Alert.alert('Reminder error', error.message);
            return;
        }

        Alert.alert('Reminder saved', `This reminder is now linked to ${selected.recipientName}.`);
        router.replace({ pathname: '/caregiver-dashboard', params: { connectionId: selected.connectionId } });
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
                        <Ionicons name="chevron-back" size={22} color={C.primary} />
                        <Text style={styles.backText}>Back</Text>
                    </TouchableOpacity>

                    {/* Header */}
                    <Text style={styles.heading}>Create Reminder</Text>
                    <Text style={styles.subheading}>
                        Add a task your participant needs to complete.
                    </Text>

                    {participantsLoading ? (
                        <View style={[styles.sectionCard, SHADOW.xs, styles.loadingCard]}>
                            <ActivityIndicator color={C.primary} />
                            <Text style={styles.loadingText}>Loading participants…</Text>
                        </View>
                    ) : participants.length === 0 ? (
                        <View style={[styles.sectionCard, SHADOW.xs, styles.emptyCard]}>
                            <View style={[styles.sectionIconWrap, { backgroundColor: C.primaryLight }]}>
                                <Ionicons name="person-add-outline" size={20} color={C.primary} />
                            </View>
                            <Text style={styles.emptyTitle}>No participants yet</Text>
                            <Text style={styles.emptyText}>
                                Invite a participant and have them accept the code before you can create reminders.
                            </Text>
                            <TouchableOpacity
                                style={[styles.inviteButton, SHADOW.primary]}
                                onPress={() => router.push('/invite-recipient')}
                                activeOpacity={0.88}
                            >
                                <Ionicons name="person-add" size={16} color={C.textInverse} />
                                <Text style={styles.inviteButtonText}>Invite Participant</Text>
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
                            <Text style={styles.sectionTitle}>Who is this for?</Text>
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
                                    </TouchableOpacity>
                                ))}
                            </View>
                        )}
                    </View>

                    {/* ── Section 1: What ─────────────────────────────────── */}
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
                                        reminderType === type && styles.typeChipActive,
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

                    {/* ── Section 3: Alerts ───────────────────────────────── */}
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

                        <Text style={[styles.label, { marginTop: 18 }]}>Notes <Text style={styles.labelOptional}>(optional)</Text></Text>
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

                    {/* Save */}
                    <TouchableOpacity
                        style={[styles.saveButton, SHADOW.primary, loading && styles.saveButtonDisabled]}
                        onPress={saveReminder}
                        disabled={loading}
                        activeOpacity={0.88}
                    >
                        {loading ? (
                            <ActivityIndicator color={C.textInverse} />
                        ) : (
                            <>
                                <Ionicons name="checkmark-circle" size={20} color={C.textInverse} />
                                <Text style={styles.saveButtonText}>Save Reminder</Text>
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

    // ── Header ────────────────────────────────────────────────────────
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
});
