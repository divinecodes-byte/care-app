// Standard loading/empty/error/offline state components — Tavora Week 2
// product-polish task #3. Reusable pieces that reduce inconsistency across
// screens without forcing every screen into one identical layout (each
// component is a small, composable piece; screens choose which to use and
// how to arrange them).

import { Ionicons } from '@expo/vector-icons';
import { useMemo } from 'react';
import {
    AccessibilityInfo,
    ActivityIndicator,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';

import { RADIUS, SHADOW, ThemeColors } from '@/constants/theme';
import { useTranslation } from '@/lib/i18n/context';
import { useThemeColors } from '@/lib/theme';

// ─── ScreenLoadingState ─────────────────────────────────────────────────────
// Full-screen initial-load indicator — use ONLY before the first real data
// arrives, never during a refresh of already-visible data (see
// InlineLoadingState / the refreshing convention documented in
// docs/ui-state-model.md).

export function ScreenLoadingState({ label }: { label: string }) {
    const C = useThemeColors();
    const styles = useMemo(() => createStyles(C), [C]);
    return (
        <View
            style={styles.screenCenter}
            accessibilityRole="progressbar"
            accessibilityLabel={label}
            accessibilityLiveRegion="polite"
        >
            <ActivityIndicator size="large" color={C.primary} />
            <Text style={styles.loadingLabel}>{label}</Text>
        </View>
    );
}

// ─── InlineLoadingState ─────────────────────────────────────────────────────
// A smaller loading indicator for one section of an otherwise-ready
// screen (e.g. analytics still loading while the reminder list already
// shows) — never replaces the whole screen.

export function InlineLoadingState({ label }: { label: string }) {
    const C = useThemeColors();
    const styles = useMemo(() => createStyles(C), [C]);
    return (
        <View
            style={styles.inlineRow}
            accessibilityRole="progressbar"
            accessibilityLabel={label}
            accessibilityLiveRegion="polite"
        >
            <ActivityIndicator size="small" color={C.primary} />
            <Text style={styles.inlineLabel}>{label}</Text>
        </View>
    );
}

// ─── EmptyState ─────────────────────────────────────────────────────────────

export function EmptyState({
    icon = 'file-tray-outline',
    title,
    text,
    actionLabel,
    onAction,
}: {
    icon?: keyof typeof Ionicons.glyphMap;
    title: string;
    text?: string;
    actionLabel?: string;
    onAction?: () => void;
}) {
    const C = useThemeColors();
    const styles = useMemo(() => createStyles(C), [C]);
    return (
        <View style={[styles.stateCard, SHADOW.xs]} accessible accessibilityRole="text">
            <View style={styles.stateIconWrap}>
                <Ionicons name={icon} size={26} color={C.primary} />
            </View>
            <Text style={styles.stateTitle}>{title}</Text>
            {text ? <Text style={styles.stateText}>{text}</Text> : null}
            {actionLabel && onAction ? (
                <TouchableOpacity
                    style={styles.primaryButton}
                    onPress={onAction}
                    activeOpacity={0.88}
                    accessibilityRole="button"
                    accessibilityLabel={actionLabel}
                >
                    <Text style={styles.primaryButtonText}>{actionLabel}</Text>
                </TouchableOpacity>
            ) : null}
        </View>
    );
}

// ─── ErrorState (full section/screen) ──────────────────────────────────────

export function ErrorState({
    title,
    text,
    onRetry,
    retrying = false,
}: {
    title: string;
    text?: string;
    onRetry?: () => void;
    retrying?: boolean;
}) {
    const C = useThemeColors();
    const t = useTranslation();
    const styles = useMemo(() => createStyles(C), [C]);
    return (
        <View
            style={[styles.stateCard, SHADOW.xs]}
            accessible
            accessibilityRole="alert"
            accessibilityLiveRegion="assertive"
        >
            <View style={[styles.stateIconWrap, styles.errorIconWrap]}>
                <Ionicons name="alert-circle-outline" size={26} color={C.error} />
            </View>
            <Text style={styles.stateTitle}>{title}</Text>
            {text ? <Text style={styles.stateText}>{text}</Text> : null}
            {onRetry ? <RetryButton onPress={onRetry} loading={retrying} label={t('stateViews.retry')} /> : null}
        </View>
    );
}

// ─── SectionErrorState (inline/partial-failure) ────────────────────────────
// For "reminders loaded fine, analytics failed" — a compact inline card,
// never a full-screen replacement.

export function SectionErrorState({
    text,
    onRetry,
    retrying = false,
}: {
    text: string;
    onRetry?: () => void;
    retrying?: boolean;
}) {
    const C = useThemeColors();
    const t = useTranslation();
    const styles = useMemo(() => createStyles(C), [C]);
    return (
        <View
            style={[styles.sectionErrorCard]}
            accessible
            accessibilityRole="alert"
            accessibilityLiveRegion="assertive"
        >
            <Ionicons name="alert-circle-outline" size={18} color={C.error} />
            <Text style={styles.sectionErrorText}>{text}</Text>
            {onRetry ? (
                <TouchableOpacity
                    onPress={onRetry}
                    disabled={retrying}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    accessibilityRole="button"
                    accessibilityLabel={t('stateViews.retry')}
                    accessibilityState={{ disabled: retrying, busy: retrying }}
                >
                    {retrying ? (
                        <ActivityIndicator size="small" color={C.error} />
                    ) : (
                        <Text style={styles.sectionErrorRetryText}>{t('stateViews.retry')}</Text>
                    )}
                </TouchableOpacity>
            ) : null}
        </View>
    );
}

// ─── RetryButton ────────────────────────────────────────────────────────────

export function RetryButton({
    onPress,
    loading = false,
    label,
}: {
    onPress: () => void;
    loading?: boolean;
    label: string;
}) {
    const C = useThemeColors();
    const styles = useMemo(() => createStyles(C), [C]);
    return (
        <TouchableOpacity
            style={[styles.retryButton, loading && styles.retryButtonDisabled]}
            onPress={onPress}
            disabled={loading}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ disabled: loading, busy: loading }}
        >
            {loading ? (
                <ActivityIndicator size="small" color={C.primary} />
            ) : (
                <>
                    <Ionicons name="refresh" size={16} color={C.primary} />
                    <Text style={styles.retryButtonText}>{label}</Text>
                </>
            )}
        </TouchableOpacity>
    );
}

// ─── OfflineBanner ──────────────────────────────────────────────────────────
// Shown when the most recent request failed for a connectivity reason —
// existing valid screen data stays visible underneath. Dismiss just hides
// it for this screen instance; it reappears on the next failed request,
// so dismissing never hides a genuinely-still-offline state permanently.

export function OfflineBanner({ onDismiss }: { onDismiss?: () => void }) {
    const C = useThemeColors();
    const t = useTranslation();
    const styles = useMemo(() => createStyles(C), [C]);
    return (
        <View
            style={styles.offlineBanner}
            accessible
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            accessibilityLabel={t('stateViews.offlineBannerText')}
        >
            <Ionicons name="cloud-offline-outline" size={16} color={C.textSecondary} />
            <Text style={styles.offlineBannerText}>{t('stateViews.offlineBannerText')}</Text>
            {onDismiss ? (
                <TouchableOpacity
                    onPress={onDismiss}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    accessibilityRole="button"
                    accessibilityLabel={t('stateViews.dismiss')}
                >
                    <Ionicons name="close" size={16} color={C.textMuted} />
                </TouchableOpacity>
            ) : null}
        </View>
    );
}

// Announces a state transition to VoiceOver users without needing a live
// region on a component that isn't otherwise visible (e.g. right after a
// retry succeeds and the screen returns to normal). Best-effort/no-op if
// unsupported.
export function announceStateChange(message: string): void {
    AccessibilityInfo.announceForAccessibility?.(message);
}

const createStyles = (C: ThemeColors) => StyleSheet.create({
    screenCenter: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 32,
        paddingVertical: 60,
    },
    loadingLabel: {
        marginTop: 14,
        fontSize: 15,
        color: C.textSecondary,
        fontWeight: '500',
        textAlign: 'center',
    },

    inlineRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 16,
        justifyContent: 'center',
    },
    inlineLabel: {
        fontSize: 14,
        color: C.textSecondary,
        fontWeight: '500',
    },

    stateCard: {
        backgroundColor: C.bgSurface,
        borderRadius: RADIUS.xl,
        padding: 28,
        alignItems: 'center',
    },
    stateIconWrap: {
        width: 52,
        height: 52,
        borderRadius: RADIUS.lg,
        backgroundColor: C.primaryLight,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 14,
    },
    errorIconWrap: {
        backgroundColor: C.errorLight,
    },
    stateTitle: {
        fontSize: 17,
        fontWeight: '700',
        color: C.textPrimary,
        textAlign: 'center',
        marginBottom: 6,
    },
    stateText: {
        fontSize: 14,
        color: C.textSecondary,
        textAlign: 'center',
        lineHeight: 20,
    },
    primaryButton: {
        marginTop: 18,
        backgroundColor: C.primary,
        paddingVertical: 14,
        paddingHorizontal: 24,
        borderRadius: RADIUS.xl,
        minHeight: 44,
        justifyContent: 'center',
    },
    primaryButtonText: {
        color: C.textInverse,
        fontSize: 15,
        fontWeight: '700',
    },

    sectionErrorCard: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        backgroundColor: C.errorLight,
        borderRadius: RADIUS.md,
        paddingVertical: 12,
        paddingHorizontal: 14,
        marginVertical: 8,
    },
    sectionErrorText: {
        flex: 1,
        fontSize: 13,
        color: C.error,
        fontWeight: '500',
    },
    sectionErrorRetryText: {
        fontSize: 13,
        fontWeight: '700',
        color: C.error,
        textDecorationLine: 'underline',
    },

    retryButton: {
        marginTop: 16,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        paddingVertical: 12,
        paddingHorizontal: 20,
        borderRadius: RADIUS.lg,
        borderWidth: 1.5,
        borderColor: C.border,
        minHeight: 44,
    },
    retryButtonDisabled: {
        opacity: 0.65,
    },
    retryButtonText: {
        fontSize: 14,
        fontWeight: '700',
        color: C.primary,
    },

    offlineBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: C.bgAlt,
        borderRadius: RADIUS.md,
        paddingVertical: 10,
        paddingHorizontal: 14,
        marginBottom: 12,
        borderWidth: 1,
        borderColor: C.border,
    },
    offlineBannerText: {
        flex: 1,
        fontSize: 13,
        color: C.textSecondary,
        fontWeight: '500',
    },
});
