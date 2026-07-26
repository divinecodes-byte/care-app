import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import {
    Modal,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RADIUS, ThemeColors } from '@/constants/theme';
import { useTranslation } from '@/lib/i18n/context';
import { useReduceMotion } from '@/lib/useReduceMotion';
import { useThemeColors } from '@/lib/theme';

// ─── Shared helpers (exported for screens) ────────────────────────────────────

export function format12Hour(date: Date): string {
    let h = date.getHours();
    const m = date.getMinutes();
    const meridiem = h < 12 ? 'AM' : 'PM';
    if (h === 0) h = 12;
    else if (h > 12) h -= 12;
    return `${h}:${String(m).padStart(2, '0')} ${meridiem}`;
}

/** Converts a Date to `HH:MM:00` for Supabase `time_of_day`. */
export function buildTimeString(date: Date): string {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:00`;
}

/** Parses a `HH:MM:SS` string from Supabase into a Date. */
export function parseTimeString(timeOfDay: string): Date {
    const [hStr, mStr] = timeOfDay.split(':');
    const d = new Date();
    d.setHours(Number(hStr), Number(mStr), 0, 0);
    return d;
}

// ─── TimePickerField ──────────────────────────────────────────────────────────

type Props = {
    value:    Date;
    onChange: (date: Date) => void;
};

/**
 * Compact tappable row + button-driven modal picker.
 *
 * No ScrollView, no native DateTimePicker, no TextInput.
 * The keyboard never appears. Every interaction is a TouchableOpacity tap.
 * State is plain numbers (draftHour 1–12, draftMinute 0–59, draftMeridiem).
 * Done converts those back to a 24-hour Date before calling onChange.
 */
export function TimePickerField({ value, onChange }: Props) {
    const t = useTranslation();
    const C = useThemeColors();
    const s = useMemo(() => createStyles(C), [C]);
    const [visible,       setVisible]       = useState(false);
    const [draftHour,     setDraftHour]     = useState(12);
    const [draftMinute,   setDraftMinute]   = useState(0);
    const [draftMeridiem, setDraftMeridiem] = useState<'AM' | 'PM'>('AM');
    const insets = useSafeAreaInsets();
    const reduceMotion = useReduceMotion();

    // ── Open ──────────────────────────────────────────────────────────────────

    function open() {
        let h = value.getHours();
        const m = value.getMinutes();
        const mer: 'AM' | 'PM' = h < 12 ? 'AM' : 'PM';
        if (h === 0)     h = 12;
        else if (h > 12) h -= 12;
        setDraftHour(h);
        setDraftMinute(m);
        setDraftMeridiem(mer);
        setVisible(true);
    }

    // ── Confirm ───────────────────────────────────────────────────────────────

    function confirm() {
        let h = draftHour;
        if (draftMeridiem === 'AM' && h === 12) h = 0;
        if (draftMeridiem === 'PM' && h !== 12) h += 12;
        const d = new Date();
        d.setHours(h, draftMinute, 0, 0);
        onChange(d);
        setVisible(false);
    }

    function cancel() { setVisible(false); }

    // ── Hour / minute controls ────────────────────────────────────────────────

    // 12 → 1 → 2 → … → 12 (wraps)
    function incHour() { setDraftHour(h => (h % 12) + 1); }
    function decHour() { setDraftHour(h => ((h - 2 + 12) % 12) + 1); }

    // Wraps 0–59 in both directions
    function incMinute(by = 1) { setDraftMinute(m => (m + by + 60) % 60); }
    function decMinute(by = 1) { setDraftMinute(m => (m - by + 60) % 60); }

    // Live preview label shown inside the modal
    const preview = `${draftHour}:${String(draftMinute).padStart(2, '0')} ${draftMeridiem}`;

    // ── Render ────────────────────────────────────────────────────────────────

    return (
        <>
            {/* ── Compact form row ──────────────────────────────────────── */}
            <TouchableOpacity
                style={s.row}
                onPress={open}
                activeOpacity={0.72}
                accessibilityRole="button"
                accessibilityLabel={`${t('reminderForm.timeOfDayLabel')}, ${format12Hour(value)}`}
                accessibilityHint={t('reminderForm.tapToChange')}
            >
                <View style={s.rowLeft}>
                    <Ionicons name="time-outline" size={18} color={C.primary} />
                    <Text style={s.timeText}>{format12Hour(value)}</Text>
                </View>
                <View style={s.rowRight}>
                    <Text style={s.tapHint}>{t('reminderForm.tapToChange')}</Text>
                    <Ionicons name="chevron-forward" size={15} color={C.textMuted} />
                </View>
            </TouchableOpacity>

            {/* ── Bottom-sheet modal ────────────────────────────────────── */}
            <Modal
                visible={visible}
                animationType={reduceMotion ? 'none' : 'slide'}
                transparent
                statusBarTranslucent
                onRequestClose={cancel}
            >
                <Pressable style={s.backdrop} onPress={cancel} accessibilityRole="button" accessibilityLabel={t('common.cancel')}>
                    {/* Stop taps inside the sheet from dismissing the modal */}
                    <View
                        style={[s.sheet, { paddingBottom: insets.bottom + 20 }]}
                        onStartShouldSetResponder={() => true}
                    >
                        {/* Handle bar — purely decorative, no drag gesture attached */}
                        <View style={s.handleRow} importantForAccessibility="no-hide-descendants">
                            <View style={s.handle} />
                        </View>

                        {/* Cancel / title / Done */}
                        <View style={s.header}>
                            <TouchableOpacity
                                onPress={cancel}
                                hitSlop={{ top: 12, bottom: 12, left: 16, right: 16 }}
                                accessibilityRole="button"
                                accessibilityLabel={t('common.cancel')}
                            >
                                <Text style={s.cancelText}>{t('common.cancel')}</Text>
                            </TouchableOpacity>
                            <Text style={s.headerTitle} accessibilityRole="header">{t('reminderForm.timeOfDayLabel')}</Text>
                            <TouchableOpacity
                                onPress={confirm}
                                hitSlop={{ top: 12, bottom: 12, left: 16, right: 16 }}
                                accessibilityRole="button"
                                accessibilityLabel={t('common.done')}
                            >
                                <Text style={s.doneText}>{t('common.done')}</Text>
                            </TouchableOpacity>
                        </View>

                        {/* Large live-preview of the current draft */}
                        <Text style={s.preview} accessibilityLiveRegion="polite">{preview}</Text>

                        {/* ── Spinner controls ─────────────────────────── */}
                        <View style={s.controlsRow}>

                            {/* Hour spinner */}
                            <View style={s.spinnerCol}>
                                <TouchableOpacity
                                    style={s.arrowBtn}
                                    onPress={incHour}
                                    activeOpacity={0.6}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('reminderForm.increaseHour')}
                                >
                                    <Ionicons name="chevron-up" size={28} color={C.primary} />
                                </TouchableOpacity>
                                <Text style={s.spinnerValue}>{String(draftHour)}</Text>
                                <TouchableOpacity
                                    style={s.arrowBtn}
                                    onPress={decHour}
                                    activeOpacity={0.6}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('reminderForm.decreaseHour')}
                                >
                                    <Ionicons name="chevron-down" size={28} color={C.primary} />
                                </TouchableOpacity>
                                <Text style={s.spinnerLabel}>{t('reminderForm.hourUnit')}</Text>
                            </View>

                            {/* Colon — aligned to the value row via paddingBottom */}
                            <Text style={s.colon}>:</Text>

                            {/* Minute spinner */}
                            <View style={s.spinnerCol}>
                                <TouchableOpacity
                                    style={s.arrowBtn}
                                    onPress={() => incMinute(1)}
                                    activeOpacity={0.6}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('reminderForm.increaseMinutes')}
                                >
                                    <Ionicons name="chevron-up" size={28} color={C.primary} />
                                </TouchableOpacity>
                                <Text style={s.spinnerValue}>{String(draftMinute).padStart(2, '0')}</Text>
                                <TouchableOpacity
                                    style={s.arrowBtn}
                                    onPress={() => decMinute(1)}
                                    activeOpacity={0.6}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('reminderForm.decreaseMinutes')}
                                >
                                    <Ionicons name="chevron-down" size={28} color={C.primary} />
                                </TouchableOpacity>
                                <Text style={s.spinnerLabel}>{t('reminderForm.minuteUnit')}</Text>
                            </View>

                            {/* AM / PM chips */}
                            <View style={s.meridiemCol}>
                                <TouchableOpacity
                                    style={[s.meridiemBtn, draftMeridiem === 'AM' && s.meridiemBtnActive]}
                                    onPress={() => setDraftMeridiem('AM')}
                                    activeOpacity={0.7}
                                    accessibilityRole="radio"
                                    accessibilityLabel="AM"
                                    accessibilityState={{ selected: draftMeridiem === 'AM' }}
                                >
                                    <Text style={[s.meridiemText, draftMeridiem === 'AM' && s.meridiemTextActive]}>
                                        AM
                                    </Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={[s.meridiemBtn, draftMeridiem === 'PM' && s.meridiemBtnActive]}
                                    onPress={() => setDraftMeridiem('PM')}
                                    activeOpacity={0.7}
                                    accessibilityRole="radio"
                                    accessibilityLabel="PM"
                                    accessibilityState={{ selected: draftMeridiem === 'PM' }}
                                >
                                    <Text style={[s.meridiemText, draftMeridiem === 'PM' && s.meridiemTextActive]}>
                                        PM
                                    </Text>
                                </TouchableOpacity>
                            </View>
                        </View>

                        {/* ── Quick ±5 min row ──────────────────────────── */}
                        <View style={s.quickRow}>
                            <TouchableOpacity
                                style={s.quickBtn}
                                onPress={() => decMinute(5)}
                                activeOpacity={0.7}
                                accessibilityRole="button"
                                accessibilityLabel={t('reminderForm.subtractFiveMinutes')}
                            >
                                <Text style={s.quickText}>{t('reminderForm.minusFiveMin')}</Text>
                            </TouchableOpacity>
                            <View style={s.quickDivider} />
                            <TouchableOpacity
                                style={s.quickBtn}
                                onPress={() => incMinute(5)}
                                activeOpacity={0.7}
                                accessibilityRole="button"
                                accessibilityLabel={t('reminderForm.addFiveMinutes')}
                            >
                                <Text style={s.quickText}>{t('reminderForm.plusFiveMin')}</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                </Pressable>
            </Modal>
        </>
    );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
// Theme-aware (previously hardcoded to light-mode colors with a comment
// claiming that was intentional — but every other bottom sheet in the app
// (settings-sheet.tsx) already adapts to dark mode, so this was a real
// inconsistency, not a deliberate exception).

const createStyles = (C: ThemeColors) => StyleSheet.create({

    // ── Compact form row ──────────────────────────────────────────────────────
    row: {
        flexDirection:     'row',
        alignItems:        'center',
        justifyContent:    'space-between',
        backgroundColor:   C.bgAlt,
        borderRadius:      RADIUS.lg,
        paddingHorizontal: 14,
        paddingVertical:   Platform.OS === 'ios' ? 14 : 12,
        borderWidth:       1.5,
        borderColor:       'transparent',
    },
    rowLeft:  { flexDirection: 'row', alignItems: 'center', gap: 10 },
    rowRight: { flexDirection: 'row', alignItems: 'center', gap: 4  },
    timeText: {
        fontSize:      17,
        fontWeight:    '700',
        color:         C.textPrimary,
        letterSpacing: -0.2,
    },
    tapHint: { fontSize: 12, color: C.textMuted, fontWeight: '500' },

    // ── Modal ─────────────────────────────────────────────────────────────────
    backdrop: {
        flex:            1,
        backgroundColor: 'rgba(0,0,0,0.42)',
        justifyContent:  'flex-end',
    },
    sheet: {
        backgroundColor:      C.bgSurface,
        borderTopLeftRadius:  RADIUS.xxl,
        borderTopRightRadius: RADIUS.xxl,
        paddingTop:           8,
        shadowColor:          '#000',
        shadowOffset:         { width: 0, height: -3 },
        shadowOpacity:        0.10,
        shadowRadius:         16,
        elevation:            14,
    },
    handleRow: { alignItems: 'center', paddingTop: 4, paddingBottom: 8 },
    handle: {
        width:           36,
        height:          4,
        borderRadius:    RADIUS.full,
        backgroundColor: C.border,
    },
    header: {
        flexDirection:     'row',
        alignItems:        'center',
        justifyContent:    'space-between',
        paddingHorizontal: 20,
        paddingVertical:   10,
        borderBottomWidth: 1,
        borderBottomColor: C.border,
    },
    headerTitle: {
        fontSize:      16,
        fontWeight:    '700',
        color:         C.textPrimary,
        letterSpacing: -0.2,
    },
    cancelText: { fontSize: 16, fontWeight: '500', color: C.textMuted  },
    doneText:   { fontSize: 16, fontWeight: '700', color: C.primary    },

    // ── Live preview ──────────────────────────────────────────────────────────
    preview: {
        textAlign:     'center',
        fontSize:      44,
        fontWeight:    '800',
        color:         C.textPrimary,
        letterSpacing: -1.5,
        marginTop:     24,
        marginBottom:  24,
    },

    // ── Spinner section ───────────────────────────────────────────────────────
    controlsRow: {
        flexDirection:     'row',
        alignItems:        'center',
        justifyContent:    'center',
        paddingHorizontal: 20,
        gap:               8,
    },
    spinnerCol: {
        alignItems: 'center',
        width:      96,
    },
    arrowBtn: {
        width:          64,
        height:         52,
        alignItems:     'center',
        justifyContent: 'center',
        borderRadius:   RADIUS.lg,
        backgroundColor: C.bgAlt,
    },
    spinnerValue: {
        fontSize:      42,
        fontWeight:    '800',
        color:         C.textPrimary,
        letterSpacing: -1.5,
        textAlign:     'center',
        minWidth:      72,
        paddingVertical: 6,
    },
    spinnerLabel: {
        fontSize:   11,
        fontWeight: '600',
        color:      C.textMuted,
        textTransform: 'uppercase',
        letterSpacing:  0.6,
        marginTop:  4,
    },
    colon: {
        fontSize:     42,
        fontWeight:   '800',
        color:        C.textPrimary,
        // Push down to align with the spinnerValue (sits between two arrowBtns)
        // arrowBtn height = 52, so colon centre needs to clear 52 + labelRow
        marginBottom: 28,
        paddingHorizontal: 4,
    },

    // ── AM / PM ───────────────────────────────────────────────────────────────
    meridiemCol: {
        gap:         10,
        marginLeft:  12,
        // Vertically centre the two chips with the up+value+down stack
        marginBottom: 24,
        justifyContent: 'center',
    },
    meridiemBtn: {
        paddingVertical:   14,
        paddingHorizontal: 18,
        borderRadius:      RADIUS.lg,
        backgroundColor:   C.bgAlt,
        alignItems:        'center',
        minWidth:          62,
    },
    meridiemBtnActive: {
        backgroundColor: C.primary,
    },
    meridiemText: {
        fontSize:   15,
        fontWeight: '700',
        color:      C.textSecondary,
    },
    meridiemTextActive: {
        color: C.textInverse,
    },

    // ── Quick ±5 min row ──────────────────────────────────────────────────────
    quickRow: {
        flexDirection:     'row',
        alignItems:        'center',
        justifyContent:    'center',
        marginTop:         20,
        marginHorizontal:  20,
        backgroundColor:   C.bgAlt,
        borderRadius:      RADIUS.lg,
        overflow:          'hidden',
    },
    quickBtn: {
        flex:           1,
        paddingVertical: 14,
        alignItems:     'center',
    },
    quickDivider: {
        width:           1,
        height:          20,
        backgroundColor: C.border,
        alignSelf:       'center',
    },
    quickText: {
        fontSize:   15,
        fontWeight: '700',
        color:      C.primary,
    },
});
