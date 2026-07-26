// Shared accessible primitives — Tavora Week 2 product-polish task #4
// (accessibility/keyboard/focus/motion/touch-target hardening). These exist
// specifically to stop the same gaps (missing accessibilityRole/State,
// icon-only buttons with no label, chip-selection with no `selected` state,
// sub-44pt touch targets) from being re-introduced ad hoc on every screen —
// not a visual redesign. Each wraps existing visual conventions (RADIUS,
// SHADOW, theme colors) rather than inventing a new look.

import { Ionicons } from '@expo/vector-icons';
import { ReactNode, useMemo } from 'react';
import {
    StyleSheet,
    Text,
    TextInput,
    TextInputProps,
    TouchableOpacity,
    View,
    ViewStyle,
} from 'react-native';

import { RADIUS, ThemeColors } from '@/constants/theme';
import { LAYOUT } from '@/lib/designTokens';
import { useThemeColors } from '@/lib/theme';

const MIN_TOUCH = LAYOUT.minControlHeight;
const DEFAULT_HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 };

// ─── AccessiblePressable ────────────────────────────────────────────────────
// Generic pressable wrapper for content that isn't a chip/card and isn't
// icon-only (those have their own primitives below) — e.g. a labeled text
// button that doesn't otherwise pull in the app's ad hoc button styling.
// Guarantees role/label/state are always set and a default hitSlop closes
// the gap for any visually-small target, without forcing a taller layout
// than the caller actually wants.

export function AccessiblePressable({
    onPress,
    label,
    hint,
    role = 'button',
    disabled = false,
    busy = false,
    selected,
    style,
    children,
}: {
    onPress?: () => void;
    label: string;
    hint?: string;
    role?: 'button' | 'radio' | 'checkbox' | 'link' | 'menuitem';
    disabled?: boolean;
    busy?: boolean;
    selected?: boolean;
    style?: ViewStyle | ViewStyle[];
    children: ReactNode;
}) {
    return (
        <TouchableOpacity
            onPress={onPress}
            disabled={disabled}
            activeOpacity={0.7}
            hitSlop={DEFAULT_HIT_SLOP}
            accessibilityRole={role}
            accessibilityLabel={label}
            accessibilityHint={hint}
            accessibilityState={{
                disabled,
                busy,
                ...(selected !== undefined ? { selected } : {}),
            }}
            style={style}
        >
            {children}
        </TouchableOpacity>
    );
}

// ─── AccessibleIconButton ───────────────────────────────────────────────────
// For every icon-only control (close, back, copy, share, dismiss...) — the
// single most common gap found in the accessibility audit was an icon with
// no accessible name at all. `label` is required (not optional) specifically
// so a call site can't compile without providing one. Enforces a real
// 44x44 touch target around the icon itself (not just hitSlop) since these
// are usually rendered much smaller (e.g. a 20px close icon) and hitSlop
// alone doesn't help a Switch Control/large-cursor user see where to tap.

export function AccessibleIconButton({
    icon,
    label,
    hint,
    onPress,
    size = 20,
    color,
    disabled = false,
    style,
}: {
    icon: keyof typeof Ionicons.glyphMap;
    label: string;
    hint?: string;
    onPress?: () => void;
    size?: number;
    color?: string;
    disabled?: boolean;
    style?: ViewStyle | ViewStyle[];
}) {
    const C = useThemeColors();
    return (
        <TouchableOpacity
            onPress={onPress}
            disabled={disabled}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityHint={hint}
            accessibilityState={{ disabled }}
            style={[
                {
                    minWidth: MIN_TOUCH,
                    minHeight: MIN_TOUCH,
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: disabled ? 0.4 : 1,
                },
                style,
            ]}
        >
            <Ionicons name={icon} size={size} color={color ?? C.textPrimary} />
        </TouchableOpacity>
    );
}

// ─── FormField ──────────────────────────────────────────────────────────────
// TextInput wrapper that always binds a visible label to accessibilityLabel
// (React Native has no equivalent of HTML's <label for>, so a sighted-only
// Text sibling is invisible to VoiceOver unless explicitly linked) and gives
// error text a live region so a validation failure is actually announced.

export function FormField({
    label,
    hint,
    error,
    required = false,
    inputStyle,
    containerStyle,
    ...inputProps
}: {
    label: string;
    hint?: string;
    error?: string | null;
    required?: boolean;
    inputStyle?: TextInputProps['style'];
    containerStyle?: ViewStyle | ViewStyle[];
} & Omit<TextInputProps, 'style' | 'accessibilityLabel'>) {
    const C = useThemeColors();
    const styles = useMemo(() => createStyles(C), [C]);
    return (
        <View style={[styles.fieldGroup, containerStyle]}>
            <Text style={styles.fieldLabel} nativeID={undefined}>
                {label}
                {required ? <Text style={styles.fieldRequired}> *</Text> : null}
            </Text>
            <TextInput
                style={[styles.fieldInput, error ? styles.fieldInputError : null, inputStyle]}
                placeholderTextColor={C.textMuted}
                accessibilityLabel={label}
                accessibilityHint={hint}
                {...inputProps}
            />
            {error ? (
                <Text style={styles.fieldError} accessibilityRole="alert" accessibilityLiveRegion="assertive">
                    {error}
                </Text>
            ) : null}
        </View>
    );
}

// ─── SelectionCard ──────────────────────────────────────────────────────────
// The single-select chip/card pattern repeated (with no accessibility state
// at all) across reminder forms, appearance/language pickers, and use-case/
// role pickers. `selected` drives both a visible checkmark (never
// color-only) and accessibilityState.selected. Renders its own default chip
// chrome, but accepts a style override so it can slot into an existing
// chip's exact visual footprint rather than forcing a new look everywhere.

export function SelectionCard({
    label,
    hint,
    selected,
    onPress,
    disabled = false,
    icon,
    compact = false,
    style,
}: {
    label: string;
    hint?: string;
    selected: boolean;
    onPress?: () => void;
    disabled?: boolean;
    icon?: keyof typeof Ionicons.glyphMap;
    compact?: boolean;
    style?: ViewStyle | ViewStyle[];
}) {
    const C = useThemeColors();
    const styles = useMemo(() => createStyles(C), [C]);
    return (
        <TouchableOpacity
            onPress={onPress}
            disabled={disabled}
            activeOpacity={0.75}
            accessibilityRole="radio"
            accessibilityLabel={label}
            accessibilityHint={hint}
            accessibilityState={{ selected, disabled }}
            style={[
                styles.selectionCard,
                compact ? styles.selectionCardCompact : null,
                selected ? styles.selectionCardSelected : null,
                disabled ? styles.selectionCardDisabled : null,
                style,
            ]}
        >
            {icon ? (
                <Ionicons
                    name={icon}
                    size={16}
                    color={selected ? C.primary : C.textSecondary}
                    style={styles.selectionCardIcon}
                />
            ) : null}
            <Text style={[styles.selectionCardText, selected ? styles.selectionCardTextSelected : null]}>
                {label}
            </Text>
            {selected ? (
                <Ionicons name="checkmark-circle" size={16} color={C.primary} style={styles.selectionCardCheck} />
            ) : null}
        </TouchableOpacity>
    );
}

// ─── StatusBadge ────────────────────────────────────────────────────────────
// Taken/Snoozed/Skipped/Missed/Pending (and adherence-percentage bands) must
// never rely on color alone — this always renders an icon+label together
// and exposes ONE combined accessibilityLabel ("82 percent, good adherence")
// instead of leaving VoiceOver to read a number and a color-coded background
// as unrelated stops.

export type StatusTone = 'success' | 'warning' | 'error' | 'neutral';

const TONE_ICON: Record<StatusTone, keyof typeof Ionicons.glyphMap> = {
    success: 'checkmark-circle',
    warning: 'time-outline',
    error: 'close-circle',
    neutral: 'ellipse-outline',
};

export function StatusBadge({
    label,
    tone,
    accessibleDescription,
    style,
}: {
    label: string;
    tone: StatusTone;
    /** Full spoken meaning, e.g. "Taken, completed on time" — falls back to `label` alone. */
    accessibleDescription?: string;
    style?: ViewStyle | ViewStyle[];
}) {
    const C = useThemeColors();
    const styles = useMemo(() => createStyles(C), [C]);
    const toneColor = tone === 'success' ? C.success : tone === 'error' ? C.error : tone === 'warning' ? '#D97706' : C.textMuted;
    const toneBg = tone === 'success' ? C.successLight : tone === 'error' ? C.errorLight : tone === 'warning' ? '#FEF3C7' : C.bgAlt;
    return (
        <View
            style={[styles.statusBadge, { backgroundColor: toneBg }, style]}
            accessible
            accessibilityRole="text"
            accessibilityLabel={accessibleDescription ?? label}
        >
            <Ionicons name={TONE_ICON[tone]} size={13} color={toneColor} />
            <Text style={[styles.statusBadgeText, { color: toneColor }]}>{label}</Text>
        </View>
    );
}

// ─── AccessibleSectionHeader ────────────────────────────────────────────────
// Marks a section title as a real heading for VoiceOver's rotor/headings
// navigation — plain <Text> has no heading semantics in React Native.

export function AccessibleSectionHeader({
    title,
    style,
}: {
    title: string;
    style?: ViewStyle | ViewStyle[] | TextInputProps['style'];
}) {
    const C = useThemeColors();
    const styles = useMemo(() => createStyles(C), [C]);
    return (
        <Text style={[styles.sectionHeader, style as any]} accessibilityRole="header">
            {title}
        </Text>
    );
}

// ─── AccessibleModalHeader ──────────────────────────────────────────────────
// Standard modal/sheet header: a real heading (announced on open) plus a
// labeled, properly-sized close button — never an icon-only control with no
// accessible name, and never gesture-only with no button alternative.

export function AccessibleModalHeader({
    title,
    onClose,
    closeLabel,
}: {
    title: string;
    onClose: () => void;
    closeLabel: string;
}) {
    const C = useThemeColors();
    const styles = useMemo(() => createStyles(C), [C]);
    return (
        <View style={styles.modalHeaderRow}>
            <Text style={styles.modalHeaderTitle} accessibilityRole="header">
                {title}
            </Text>
            <AccessibleIconButton icon="close" label={closeLabel} onPress={onClose} color={C.textMuted} />
        </View>
    );
}

const createStyles = (C: ThemeColors) => StyleSheet.create({
    fieldGroup: { marginBottom: 18 },
    fieldLabel: { fontSize: 14, fontWeight: '700', color: C.textPrimary, marginBottom: 8 },
    fieldRequired: { color: C.error },
    fieldInput: {
        backgroundColor: C.bgSurface,
        borderRadius: RADIUS.lg,
        paddingHorizontal: 16,
        paddingVertical: 14,
        minHeight: MIN_TOUCH,
        fontSize: 16,
        borderWidth: 1.5,
        borderColor: C.border,
        color: C.textPrimary,
    },
    fieldInputError: { borderColor: C.error },
    fieldError: { marginTop: 6, fontSize: 13, color: C.error, fontWeight: '600' },

    selectionCard: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minHeight: MIN_TOUCH,
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: RADIUS.lg,
        borderWidth: 1.5,
        borderColor: C.border,
        backgroundColor: C.bgSurface,
    },
    selectionCardCompact: {
        minHeight: 40,
        paddingVertical: 8,
    },
    selectionCardSelected: {
        borderColor: C.primary,
        backgroundColor: C.primaryLight,
    },
    selectionCardDisabled: {
        opacity: 0.45,
    },
    selectionCardIcon: { marginRight: 2 },
    selectionCardText: { fontSize: 14, fontWeight: '600', color: C.textSecondary },
    selectionCardTextSelected: { color: C.primary, fontWeight: '700' },
    selectionCardCheck: { marginLeft: 2 },

    statusBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: RADIUS.full,
        alignSelf: 'flex-start',
    },
    statusBadgeText: { fontSize: 12, fontWeight: '700' },

    sectionHeader: { fontSize: 18, fontWeight: '800', color: C.textPrimary, letterSpacing: -0.3 },

    modalHeaderRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 4,
    },
    modalHeaderTitle: { fontSize: 18, fontWeight: '800', color: C.textPrimary },
});
