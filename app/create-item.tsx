// Week 3 product-expansion task #1: the entry point presented before every
// reminder/task creation, per the requirement that Timed Reminder and
// Flexible Task each get a brief explanation up front. Deliberately a thin
// router — it owns no reminder or task creation logic itself, so the
// existing create-reminder.tsx flow (and its own regression coverage)
// remains completely untouched.
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AccessibleIconButton } from '@/components/AccessiblePrimitives';
import { RADIUS, SHADOW, ThemeColors } from '@/constants/theme';
import { useTranslation } from '@/lib/i18n/context';
import { useThemeColors } from '@/lib/theme';

export default function CreateItemScreen() {
    const C = useThemeColors();
    const t = useTranslation();
    const styles = useMemo(() => createStyles(C), [C]);
    const { connectionId } = useLocalSearchParams<{ connectionId?: string }>();

    return (
        <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
            <View style={styles.header}>
                <AccessibleIconButton icon="close" label={t('common.close')} onPress={() => router.back()} />
            </View>

            <View style={styles.content}>
                <Text style={styles.heading} accessibilityRole="header">{t('itemTypePicker.heading')}</Text>
                <Text style={styles.subheading}>{t('itemTypePicker.subheading')}</Text>

                <TouchableOpacity
                    style={[styles.card, SHADOW.sm]}
                    activeOpacity={0.85}
                    accessibilityRole="button"
                    accessibilityLabel={t('itemTypePicker.timedReminderTitle')}
                    accessibilityHint={t('itemTypePicker.timedReminderDesc')}
                    onPress={() => router.replace({ pathname: '/create-reminder', params: { connectionId } })}
                >
                    <View style={[styles.iconWrap, { backgroundColor: C.primaryLight }]}>
                        <Ionicons name="time-outline" size={24} color={C.primary} />
                    </View>
                    <View style={styles.cardText}>
                        <Text style={styles.cardTitle}>{t('itemTypePicker.timedReminderTitle')}</Text>
                        <Text style={styles.cardDesc}>{t('itemTypePicker.timedReminderDesc')}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color={C.textMuted} />
                </TouchableOpacity>

                <TouchableOpacity
                    style={[styles.card, SHADOW.sm]}
                    activeOpacity={0.85}
                    accessibilityRole="button"
                    accessibilityLabel={t('itemTypePicker.flexibleTaskTitle')}
                    accessibilityHint={t('itemTypePicker.flexibleTaskDesc')}
                    onPress={() => router.replace({ pathname: '/create-task', params: { connectionId } })}
                >
                    <View style={[styles.iconWrap, { backgroundColor: C.successLight }]}>
                        <Ionicons name="checkbox-outline" size={24} color={C.success} />
                    </View>
                    <View style={styles.cardText}>
                        <Text style={styles.cardTitle}>{t('itemTypePicker.flexibleTaskTitle')}</Text>
                        <Text style={styles.cardDesc}>{t('itemTypePicker.flexibleTaskDesc')}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color={C.textMuted} />
                </TouchableOpacity>
            </View>
        </SafeAreaView>
    );
}

const createStyles = (C: ThemeColors) => StyleSheet.create({
    container: { flex: 1, backgroundColor: C.bgPage },
    header: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 16, paddingTop: 4 },
    content: { flex: 1, paddingHorizontal: 24, paddingTop: 12 },
    heading: { fontSize: 24, fontWeight: '800', color: C.textPrimary, letterSpacing: -0.4, marginBottom: 8 },
    subheading: { fontSize: 15, color: C.textSecondary, marginBottom: 28, lineHeight: 21 },
    card: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        backgroundColor: C.bgSurface,
        borderRadius: RADIUS.xl,
        padding: 18,
        marginBottom: 16,
        minHeight: 44,
    },
    iconWrap: { width: 48, height: 48, borderRadius: RADIUS.lg, alignItems: 'center', justifyContent: 'center' },
    cardText: { flex: 1 },
    cardTitle: { fontSize: 16, fontWeight: '800', color: C.textPrimary, marginBottom: 4 },
    cardDesc: { fontSize: 13, color: C.textSecondary, lineHeight: 18 },
});
