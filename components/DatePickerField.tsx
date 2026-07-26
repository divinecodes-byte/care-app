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

// ─── Date-string helpers (participant-local calendar dates, "YYYY-MM-DD") ──
// These operate on plain calendar components (Y/M/D), never on an absolute
// instant — matching how flexible tasks store start_date/due_date/
// recurrence_end_date (date columns, no timezone conversion involved). See
// lib/taskLifecycle.ts for why dates, not timestamps, are the right type
// here.

export function todayDateString(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDaysToDateString(dateString: string, days: number): string {
    const [y, m, d] = dateString.split('-').map(Number);
    const dt = new Date(y, m - 1, d + days);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function addMonthsToDateString(dateString: string, months: number): string {
    const [y, m, d] = dateString.split('-').map(Number);
    const dt = new Date(y, m - 1 + months, d);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

export function formatDateStringForDisplay(dateString: string, locale?: string): string {
    const [y, m, d] = dateString.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── DatePickerField ────────────────────────────────────────────────────────
// Mirrors TimePickerField's button-driven modal spinner pattern (no native
// DateTimePicker, no keyboard) for calendar-date selection.

type Props = {
    value: string | null; // "YYYY-MM-DD"
    onChange: (date: string | null) => void;
    label: string;
    minDate?: string;
    allowClear?: boolean;
    placeholder?: string;
};

export function DatePickerField({ value, onChange, label, minDate, allowClear = false, placeholder }: Props) {
    const t = useTranslation();
    const C = useThemeColors();
    const s = useMemo(() => createStyles(C), [C]);
    const [visible, setVisible] = useState(false);
    const [draft, setDraft] = useState(value ?? todayDateString());
    const insets = useSafeAreaInsets();
    const reduceMotion = useReduceMotion();

    function open() {
        setDraft(value ?? todayDateString());
        setVisible(true);
    }

    function confirm() {
        onChange(draft);
        setVisible(false);
    }

    function clear() {
        onChange(null);
        setVisible(false);
    }

    function cancel() { setVisible(false); }

    function clamp(dateString: string): string {
        return minDate && dateString < minDate ? minDate : dateString;
    }

    const displayText = value ? formatDateStringForDisplay(value) : (placeholder ?? t('datePicker.notSet'));

    return (
        <>
            <TouchableOpacity
                style={s.row}
                onPress={open}
                activeOpacity={0.72}
                accessibilityRole="button"
                accessibilityLabel={`${label}, ${displayText}`}
                accessibilityHint={t('datePicker.tapToChange')}
            >
                <View style={s.rowLeft}>
                    <Ionicons name="calendar-outline" size={18} color={C.primary} />
                    <Text style={s.dateText}>{displayText}</Text>
                </View>
                <View style={s.rowRight}>
                    <Text style={s.tapHint}>{t('datePicker.tapToChange')}</Text>
                    <Ionicons name="chevron-forward" size={15} color={C.textMuted} />
                </View>
            </TouchableOpacity>

            <Modal
                visible={visible}
                animationType={reduceMotion ? 'none' : 'slide'}
                transparent
                statusBarTranslucent
                onRequestClose={cancel}
            >
                <Pressable style={s.backdrop} onPress={cancel} accessibilityRole="button" accessibilityLabel={t('common.cancel')}>
                    <View style={[s.sheet, { paddingBottom: insets.bottom + 20 }]} onStartShouldSetResponder={() => true}>
                        <View style={s.handleRow} importantForAccessibility="no-hide-descendants">
                            <View style={s.handle} />
                        </View>

                        <View style={s.header}>
                            <TouchableOpacity
                                onPress={cancel}
                                hitSlop={{ top: 12, bottom: 12, left: 16, right: 16 }}
                                accessibilityRole="button"
                                accessibilityLabel={t('common.cancel')}
                            >
                                <Text style={s.cancelText}>{t('common.cancel')}</Text>
                            </TouchableOpacity>
                            <Text style={s.headerTitle} accessibilityRole="header">{label}</Text>
                            <TouchableOpacity
                                onPress={confirm}
                                hitSlop={{ top: 12, bottom: 12, left: 16, right: 16 }}
                                accessibilityRole="button"
                                accessibilityLabel={t('common.done')}
                            >
                                <Text style={s.doneText}>{t('common.done')}</Text>
                            </TouchableOpacity>
                        </View>

                        <Text style={s.preview} accessibilityLiveRegion="polite">{formatDateStringForDisplay(draft)}</Text>

                        <View style={s.controlsRow}>
                            <TouchableOpacity
                                style={s.stepBtn}
                                onPress={() => setDraft((d) => clamp(addDaysToDateString(d, -1)))}
                                activeOpacity={0.7}
                                accessibilityRole="button"
                                accessibilityLabel={t('datePicker.previousDay')}
                            >
                                <Ionicons name="chevron-back" size={22} color={C.primary} />
                                <Text style={s.stepLabel}>{t('datePicker.day')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={s.stepBtn}
                                onPress={() => setDraft((d) => clamp(addDaysToDateString(d, 1)))}
                                activeOpacity={0.7}
                                accessibilityRole="button"
                                accessibilityLabel={t('datePicker.nextDay')}
                            >
                                <Text style={s.stepLabel}>{t('datePicker.day')}</Text>
                                <Ionicons name="chevron-forward" size={22} color={C.primary} />
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={s.stepBtn}
                                onPress={() => setDraft((d) => clamp(addMonthsToDateString(d, -1)))}
                                activeOpacity={0.7}
                                accessibilityRole="button"
                                accessibilityLabel={t('datePicker.previousMonth')}
                            >
                                <Ionicons name="play-back" size={18} color={C.textSecondary} />
                                <Text style={s.stepLabelSmall}>{t('datePicker.month')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={s.stepBtn}
                                onPress={() => setDraft((d) => clamp(addMonthsToDateString(d, 1)))}
                                activeOpacity={0.7}
                                accessibilityRole="button"
                                accessibilityLabel={t('datePicker.nextMonth')}
                            >
                                <Text style={s.stepLabelSmall}>{t('datePicker.month')}</Text>
                                <Ionicons name="play-forward" size={18} color={C.textSecondary} />
                            </TouchableOpacity>
                        </View>

                        <View style={s.quickRow}>
                            <TouchableOpacity style={s.quickBtn} onPress={() => setDraft(clamp(todayDateString()))} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel={t('datePicker.today')}>
                                <Text style={s.quickText}>{t('datePicker.today')}</Text>
                            </TouchableOpacity>
                            <View style={s.quickDivider} />
                            <TouchableOpacity style={s.quickBtn} onPress={() => setDraft(clamp(addDaysToDateString(todayDateString(), 1)))} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel={t('datePicker.tomorrow')}>
                                <Text style={s.quickText}>{t('datePicker.tomorrow')}</Text>
                            </TouchableOpacity>
                            <View style={s.quickDivider} />
                            <TouchableOpacity style={s.quickBtn} onPress={() => setDraft(clamp(addDaysToDateString(todayDateString(), 7)))} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel={t('datePicker.inOneWeek')}>
                                <Text style={s.quickText}>{t('datePicker.inOneWeek')}</Text>
                            </TouchableOpacity>
                        </View>

                        {allowClear ? (
                            <TouchableOpacity style={s.clearBtn} onPress={clear} activeOpacity={0.75} accessibilityRole="button" accessibilityLabel={t('datePicker.clearDate')}>
                                <Text style={s.clearText}>{t('datePicker.clearDate')}</Text>
                            </TouchableOpacity>
                        ) : null}
                    </View>
                </Pressable>
            </Modal>
        </>
    );
}

const createStyles = (C: ThemeColors) => StyleSheet.create({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: C.bgAlt,
        borderRadius: RADIUS.lg,
        paddingHorizontal: 14,
        paddingVertical: Platform.OS === 'ios' ? 14 : 12,
        borderWidth: 1.5,
        borderColor: 'transparent',
        minHeight: 44,
    },
    rowLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    rowRight: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    dateText: { fontSize: 16, fontWeight: '700', color: C.textPrimary, letterSpacing: -0.2 },
    tapHint: { fontSize: 12, color: C.textMuted, fontWeight: '500' },

    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
    sheet: { backgroundColor: C.bgSurface, borderTopLeftRadius: RADIUS.xxl, borderTopRightRadius: RADIUS.xxl, paddingHorizontal: 20, paddingTop: 10 },
    handleRow: { alignItems: 'center', paddingVertical: 8 },
    handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: C.border },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8 },
    cancelText: { fontSize: 16, color: C.textSecondary, fontWeight: '600' },
    headerTitle: { fontSize: 16, fontWeight: '800', color: C.textPrimary },
    doneText: { fontSize: 16, color: C.primary, fontWeight: '800' },
    preview: { fontSize: 22, fontWeight: '800', color: C.textPrimary, textAlign: 'center', marginVertical: 18 },
    controlsRow: { flexDirection: 'row', justifyContent: 'space-around', marginBottom: 16 },
    stepBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44, paddingHorizontal: 10, paddingVertical: 8 },
    stepLabel: { fontSize: 14, fontWeight: '700', color: C.primary },
    stepLabelSmall: { fontSize: 12, fontWeight: '600', color: C.textSecondary },
    quickRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: C.bgAlt, borderRadius: RADIUS.lg, marginBottom: 12 },
    quickBtn: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    quickText: { fontSize: 13, fontWeight: '700', color: C.primary },
    quickDivider: { width: 1, height: 24, backgroundColor: C.border },
    clearBtn: { minHeight: 44, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
    clearText: { fontSize: 14, fontWeight: '700', color: C.error },
});
