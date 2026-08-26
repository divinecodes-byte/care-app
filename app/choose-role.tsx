import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
    AccessibilityInfo,
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
import { getRoleLabelKeys, isUseCase, logOnboardingEvent, USE_CASE_CARD_KEYS, UseCase } from '@/lib/onboarding';
import { useThemeColors } from '@/lib/theme';
import { supabase } from '@/lib/supabase';
import { showAlertOnce } from '@/lib/alertGuard';

type Role = 'caregiver' | 'recipient';

export default function ChooseRoleScreen() {
    const C = useThemeColors();
    const t = useTranslation();
    const styles = useMemo(() => createStyles(C), [C]);
    const [loadingRole, setLoadingRole] = useState<Role | null>(null);
    const [useCase, setUseCase] = useState<UseCase | null>(null);

    // Only affects which labels are shown (e.g. "Caregiver / Family Member"
    // for the care use case) — never affects authorization, which stays on
    // the role value written below regardless of use_case.
    useEffect(() => {
        (async () => {
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) return;
            const { data } = await supabase
                .from('profiles')
                .select('use_case')
                .eq('id', user.id)
                .maybeSingle();
            if (data?.use_case && isUseCase(data.use_case)) setUseCase(data.use_case);
        })();
    }, []);

    const labels = getRoleLabelKeys(useCase);
    // Matches the icon shown for this same use case one screen earlier on
    // choose-use-case.tsx — a coach/manager/tutor must never see the
    // organizer card default to a heart. 'people' is the neutral fallback
    // for a null use_case (older account / skipped step), matching this
    // screen's own header icon.
    const organizerIconName = useCase ? USE_CASE_CARD_KEYS[useCase].icon : 'people';

    async function handleChooseRole(role: Role) {
        if (loadingRole) return;

        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        setLoadingRole(role);
        AccessibilityInfo.announceForAccessibility?.(
            t(role === 'caregiver' ? labels.organizerTitle : labels.participantTitle)
        );

        const {
            data: { user },
        } = await supabase.auth.getUser();

        if (!user) {
            setLoadingRole(null);
            return;
        }

        const { error } = await supabase
            .from('profiles')
            .update({ role })
            .eq('id', user.id);

        if (error) {
            setLoadingRole(null);
            // guard_profile_role_change() raises this fixed message once a
            // connection already exists — everything else (network, RLS,
            // unexpected) gets the generic retry copy.
            if (error.message?.includes('role_locked')) {
                showAlertOnce(t('chooseRole.roleLockedTitle'), t('chooseRole.roleLockedMessage'));
            } else {
                showAlertOnce(t('chooseRole.savingErrorTitle'), t('chooseRole.savingErrorMessage'));
            }
            return;
        }

        logOnboardingEvent('role_selected');

        if (role === 'caregiver') {
            router.replace('/caregiver-dashboard');
        } else {
            router.replace('/join-invite');
        }
    }

    const isLoading = loadingRole !== null;

    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.content}>
                {/* Header */}
                <View style={styles.header}>
                    <View style={styles.headerIcon}>
                        <Ionicons name="people" size={26} color={C.primary} />
                    </View>
                    <Text style={styles.title} accessibilityRole="header">{t('chooseRole.title')}</Text>
                    <Text style={styles.subtitle}>
                        {t('chooseRole.subtitle')}
                    </Text>
                </View>

                {/* Role cards */}
                <View style={styles.cards}>
                    {/* Caregiver */}
                    <TouchableOpacity
                        style={[
                            styles.card,
                            SHADOW.sm,
                            loadingRole === 'caregiver' && styles.cardActive,
                            isLoading && loadingRole !== 'caregiver' && styles.cardDimmed,
                        ]}
                        onPress={() => handleChooseRole('caregiver')}
                        disabled={isLoading}
                        activeOpacity={0.82}
                        accessibilityRole="button"
                        accessibilityLabel={t(labels.organizerTitle)}
                        accessibilityHint={t(labels.organizerDesc)}
                        accessibilityState={{ selected: loadingRole === 'caregiver', disabled: isLoading }}
                    >
                        <View style={[styles.cardIconWrap, { backgroundColor: C.organizerLight }]}>
                            <Ionicons name={organizerIconName as never} size={26} color={C.organizerColor} />
                        </View>

                        <View style={styles.cardBody}>
                            <Text style={styles.cardTitle}>{t(labels.organizerTitle)}</Text>
                            <Text style={styles.cardText}>
                                {t(labels.organizerDesc)}
                            </Text>
                        </View>

                        <View style={styles.cardTrailing}>
                            {loadingRole === 'caregiver' ? (
                                <ActivityIndicator size="small" color={C.organizerColor} />
                            ) : (
                                <Ionicons name="chevron-forward" size={20} color={C.textMuted} />
                            )}
                        </View>
                    </TouchableOpacity>

                    {/* Recipient */}
                    <TouchableOpacity
                        style={[
                            styles.card,
                            SHADOW.sm,
                            loadingRole === 'recipient' && styles.cardActive,
                            isLoading && loadingRole !== 'recipient' && styles.cardDimmed,
                        ]}
                        onPress={() => handleChooseRole('recipient')}
                        disabled={isLoading}
                        activeOpacity={0.82}
                        accessibilityRole="button"
                        accessibilityLabel={t(labels.participantTitle)}
                        accessibilityHint={t(labels.participantDesc)}
                        accessibilityState={{ selected: loadingRole === 'recipient', disabled: isLoading }}
                    >
                        <View style={[styles.cardIconWrap, { backgroundColor: C.recipientLight }]}>
                            <Ionicons name="person" size={26} color={C.recipientColor} />
                        </View>

                        <View style={styles.cardBody}>
                            <Text style={styles.cardTitle}>{t(labels.participantTitle)}</Text>
                            <Text style={styles.cardText}>
                                {t(labels.participantDesc)}
                            </Text>
                        </View>

                        <View style={styles.cardTrailing}>
                            {loadingRole === 'recipient' ? (
                                <ActivityIndicator size="small" color={C.recipientColor} />
                            ) : (
                                <Ionicons name="chevron-forward" size={20} color={C.textMuted} />
                            )}
                        </View>
                    </TouchableOpacity>
                </View>

                <Text style={styles.hint}>
                    {t('chooseRole.hint')}
                </Text>
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
        paddingHorizontal: 24,
        justifyContent: 'center',
    },

    // ── Header ────────────────────────────────────────────────────────
    header: {
        marginBottom: 36,
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
        fontSize: 34,
        fontWeight: '800',
        color: C.textPrimary,
        lineHeight: 42,
        letterSpacing: -0.8,
        marginBottom: 12,
    },
    subtitle: {
        fontSize: 16,
        color: C.textSecondary,
        lineHeight: 24,
        letterSpacing: -0.1,
    },

    // ── Cards ─────────────────────────────────────────────────────────
    cards: {
        gap: 14,
        marginBottom: 28,
    },
    card: {
        backgroundColor: C.bgSurface,
        borderRadius: RADIUS.xl,
        padding: 20,
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
        width: 52,
        height: 52,
        borderRadius: RADIUS.lg,
        justifyContent: 'center',
        alignItems: 'center',
        marginRight: 16,
        flexShrink: 0,
    },
    cardBody: {
        flex: 1,
    },
    cardTitle: {
        fontSize: 17,
        fontWeight: '700',
        color: C.textPrimary,
        letterSpacing: -0.3,
        marginBottom: 5,
    },
    cardText: {
        fontSize: 14,
        color: C.textSecondary,
        lineHeight: 20,
        letterSpacing: -0.1,
    },
    cardTrailing: {
        marginLeft: 12,
        width: 24,
        alignItems: 'center',
    },

    // ── Footer hint ───────────────────────────────────────────────────
    hint: {
        fontSize: 13,
        color: C.textMuted,
        textAlign: 'center',
        lineHeight: 19,
        paddingHorizontal: 8,
    },
});
