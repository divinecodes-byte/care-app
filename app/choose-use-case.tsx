import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import {
    AccessibilityInfo,
    ActivityIndicator,
    Platform,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { RADIUS, SHADOW, ThemeColors } from '@/constants/theme';
import { useTranslation } from '@/lib/i18n/context';
import { logOnboardingEvent, USE_CASE_CARD_KEYS, USE_CASES, UseCase } from '@/lib/onboarding';
import { useThemeColors } from '@/lib/theme';
import { supabase } from '@/lib/supabase';

export default function ChooseUseCaseScreen() {
    const C = useThemeColors();
    const t = useTranslation();
    const styles = useMemo(() => createStyles(C), [C]);
    const [loadingCase, setLoadingCase] = useState<UseCase | null>(null);

    async function handleChoose(useCase: UseCase) {
        if (loadingCase) return;

        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        setLoadingCase(useCase);
        AccessibilityInfo.announceForAccessibility?.(t(USE_CASE_CARD_KEYS[useCase].title));

        const { data: { user } } = await supabase.auth.getUser();

        if (!user) {
            setLoadingCase(null);
            return;
        }

        // Best-effort: use_case is a display-only signal (see the migration
        // comment on profiles.use_case), so a failure here should never
        // block onboarding — fall through to choose-role regardless.
        await supabase.from('profiles').update({ use_case: useCase }).eq('id', user.id);
        logOnboardingEvent('use_case_selected');

        router.replace('/choose-role');
    }

    const isLoading = loadingCase !== null;

    return (
        <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
            <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
                <View style={styles.header}>
                    <View style={styles.headerIcon}>
                        <Ionicons name="compass" size={26} color={C.primary} />
                    </View>
                    <Text style={styles.title} accessibilityRole="header">{t('useCase.title')}</Text>
                    <Text style={styles.subtitle}>{t('useCase.subtitle')}</Text>
                </View>

                <View style={styles.cards}>
                    {USE_CASES.map((useCase) => {
                        const keys = USE_CASE_CARD_KEYS[useCase];
                        const selected = loadingCase === useCase;
                        const dimmed = isLoading && !selected;
                        return (
                            <TouchableOpacity
                                key={useCase}
                                style={[
                                    styles.card,
                                    SHADOW.sm,
                                    selected && styles.cardActive,
                                    dimmed && styles.cardDimmed,
                                ]}
                                onPress={() => handleChoose(useCase)}
                                disabled={isLoading}
                                activeOpacity={0.82}
                                accessibilityRole="button"
                                accessibilityLabel={t(keys.title)}
                                accessibilityHint={t(keys.desc)}
                                accessibilityState={{ selected, disabled: isLoading }}
                            >
                                <View style={[styles.cardIconWrap, { backgroundColor: C.primaryLight }]}>
                                    <Ionicons name={keys.icon as never} size={24} color={C.primary} />
                                </View>

                                <View style={styles.cardBody}>
                                    <Text style={styles.cardTitle}>{t(keys.title)}</Text>
                                    <Text style={styles.cardText}>{t(keys.desc)}</Text>
                                </View>

                                <View style={styles.cardTrailing}>
                                    {selected ? (
                                        <ActivityIndicator size="small" color={C.primary} />
                                    ) : (
                                        <Ionicons name="chevron-forward" size={20} color={C.textMuted} />
                                    )}
                                </View>
                            </TouchableOpacity>
                        );
                    })}
                </View>

                <Text style={styles.hint}>{t('useCase.continueHint')}</Text>
            </ScrollView>
        </SafeAreaView>
    );
}

const createStyles = (C: ThemeColors) => StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: C.bgPage,
    },
    content: {
        paddingHorizontal: 24,
        paddingTop: 24,
        paddingBottom: 40,
    },

    header: {
        marginBottom: 28,
    },
    headerIcon: {
        width: 52,
        height: 52,
        borderRadius: RADIUS.lg,
        backgroundColor: C.primaryLight,
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: 20,
    },
    title: {
        fontSize: 30,
        fontWeight: '800',
        color: C.textPrimary,
        lineHeight: 38,
        letterSpacing: -0.7,
        marginBottom: 12,
    },
    subtitle: {
        fontSize: 15,
        color: C.textSecondary,
        lineHeight: 22,
        letterSpacing: -0.1,
    },

    cards: {
        gap: 12,
        marginBottom: 24,
    },
    card: {
        backgroundColor: C.bgSurface,
        borderRadius: RADIUS.xl,
        padding: 18,
        flexDirection: 'row',
        alignItems: 'center',
        borderWidth: 1.5,
        borderColor: C.border,
        minHeight: 44,
    },
    cardActive: {
        borderColor: C.primary,
        backgroundColor: C.primaryLight,
    },
    cardDimmed: {
        opacity: 0.45,
    },
    cardIconWrap: {
        width: 46,
        height: 46,
        borderRadius: RADIUS.lg,
        justifyContent: 'center',
        alignItems: 'center',
        marginRight: 14,
        flexShrink: 0,
    },
    cardBody: {
        flex: 1,
    },
    cardTitle: {
        fontSize: 16,
        fontWeight: '700',
        color: C.textPrimary,
        letterSpacing: -0.3,
        marginBottom: 3,
    },
    cardText: {
        fontSize: 13,
        color: C.textSecondary,
        lineHeight: 18,
        letterSpacing: -0.1,
    },
    cardTrailing: {
        marginLeft: 10,
        width: 22,
        alignItems: 'center',
    },

    hint: {
        fontSize: 13,
        color: C.textMuted,
        textAlign: 'center',
        lineHeight: 19,
        paddingHorizontal: 8,
    },
});
