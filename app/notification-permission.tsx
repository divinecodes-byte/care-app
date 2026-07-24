import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import {
    ActivityIndicator,
    Platform,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { RADIUS, SHADOW, ThemeColors } from '@/constants/theme';
import { useTranslation } from '@/lib/i18n/context';
import { requestNotificationPermissions } from '@/lib/notifications';
import { useThemeColors } from '@/lib/theme';

// Shown once, right after a recipient's first successful invite acceptance
// (join-invite.tsx), BEFORE the OS permission dialog ever fires — see
// docs/onboarding-model.md. "Continue" is the only path that triggers the
// native prompt; "Not now" moves on without asking, and this screen is
// never shown again for this device/session (it isn't part of the normal
// navigation stack the user could return to), so there is no repeated
// nagging after a denial.
export default function NotificationPermissionScreen() {
    const C = useThemeColors();
    const t = useTranslation();
    const styles = useMemo(() => createStyles(C), [C]);
    const [requesting, setRequesting] = useState(false);

    function continueToDashboard() {
        router.replace('/recipient-dashboard');
    }

    async function handleContinue() {
        if (requesting) return;
        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        setRequesting(true);
        // Never blocks forward progress regardless of the OS result (grant,
        // deny, or a lookup failure) — the dashboard's own persistent banner
        // is what tells the user their notifications are off, not this
        // screen retrying or getting stuck.
        await requestNotificationPermissions().catch(() => false);
        setRequesting(false);
        continueToDashboard();
    }

    return (
        <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
            <View style={styles.content}>
                <View style={styles.headerIcon}>
                    <Ionicons name="notifications" size={28} color={C.primary} />
                </View>

                <Text style={styles.title} accessibilityRole="header">{t('notificationPermission.title')}</Text>
                <Text style={styles.body}>{t('notificationPermission.body')}</Text>

                <View style={styles.noteRow}>
                    <Ionicons name="moon-outline" size={16} color={C.textMuted} />
                    <Text style={styles.noteText}>{t('notificationPermission.timeSensitiveNote')}</Text>
                </View>

                <View style={styles.spacer} />

                <TouchableOpacity
                    style={[styles.primaryButton, SHADOW.primary, requesting && styles.buttonDisabled]}
                    onPress={handleContinue}
                    disabled={requesting}
                    activeOpacity={0.88}
                    accessibilityRole="button"
                    accessibilityLabel={t('notificationPermission.continueButton')}
                    accessibilityState={{ disabled: requesting, busy: requesting }}
                >
                    {requesting ? (
                        <ActivityIndicator color={C.textInverse} />
                    ) : (
                        <Text style={styles.primaryButtonText}>{t('notificationPermission.continueButton')}</Text>
                    )}
                </TouchableOpacity>

                <TouchableOpacity
                    style={styles.secondaryButton}
                    onPress={continueToDashboard}
                    disabled={requesting}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel={t('notificationPermission.notNowButton')}
                >
                    <Text style={styles.secondaryButtonText}>{t('notificationPermission.notNowButton')}</Text>
                </TouchableOpacity>
            </View>
        </SafeAreaView>
    );
}

const createStyles = (C: ThemeColors) => StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: C.bgPage,
    },
    content: {
        flex: 1,
        paddingHorizontal: 28,
        paddingTop: 32,
        paddingBottom: 24,
    },
    headerIcon: {
        width: 56,
        height: 56,
        borderRadius: RADIUS.lg,
        backgroundColor: C.primaryLight,
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: 24,
    },
    title: {
        fontSize: 28,
        fontWeight: '800',
        color: C.textPrimary,
        lineHeight: 36,
        letterSpacing: -0.6,
        marginBottom: 14,
    },
    body: {
        fontSize: 16,
        color: C.textSecondary,
        lineHeight: 24,
        letterSpacing: -0.1,
        marginBottom: 20,
    },
    noteRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
    },
    noteText: {
        flex: 1,
        fontSize: 13,
        color: C.textMuted,
        lineHeight: 19,
    },
    spacer: {
        flex: 1,
        minHeight: 24,
    },
    primaryButton: {
        backgroundColor: C.primary,
        paddingVertical: 18,
        borderRadius: RADIUS.xl,
        alignItems: 'center',
        marginBottom: 12,
        minHeight: 44,
        justifyContent: 'center',
    },
    primaryButtonText: {
        color: C.textInverse,
        fontSize: 17,
        fontWeight: '700',
        letterSpacing: -0.2,
    },
    buttonDisabled: {
        opacity: 0.65,
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
