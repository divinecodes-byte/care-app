import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo } from 'react';
import { Image, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RADIUS, SHADOW, ThemeColors } from '@/constants/theme';
import { useLanguage } from '@/lib/i18n/context';
import { isUseCase, recipientHasAcceptedConnection, resolveProfileRoute } from '@/lib/onboarding';
import { useThemeColors } from '@/lib/theme';
import { supabase } from '@/lib/supabase';
import { syncCurrentUserTimezone } from '@/lib/timezone';

export default function HomeScreen() {
    const C = useThemeColors();
    const { t, ready, hasChosenLanguage } = useLanguage();
    const styles = useMemo(() => createStyles(C), [C]);
    const insets = useSafeAreaInsets();

    // Gate first-launch users into the language picker before they see the
    // welcome/auth flow. Once a choice (including "system") is persisted,
    // this effect falls through to the normal session check below.
    useEffect(() => {
        if (!ready) return;
        if (!hasChosenLanguage) {
            router.replace('/select-language');
            return;
        }

        supabase.auth.getSession().then(async ({ data: { session } }) => {
            if (!session?.user) return;
            const { data } = await supabase
                .from('profiles')
                .select('role, use_case')
                .eq('id', session.user.id)
                .maybeSingle();
            if (!data) return; // profile_missing is handled by _layout.tsx's global effect

            const role = data.role === 'caregiver' || data.role === 'recipient' ? data.role : null;
            const useCase = isUseCase(data.use_case) ? data.use_case : null;
            const hasConnection = role === 'recipient' ? await recipientHasAcceptedConnection(session.user.id) : false;
            const route = resolveProfileRoute({ role, useCase }, hasConnection);

            if (route === '/recipient-dashboard') {
                // Fire-and-forget — reconciles this device's timezone right
                // after session restoration on cold start, same as the
                // signin flow, before the dashboard even mounts.
                syncCurrentUserTimezone().catch(() => {});
            }
            router.replace(route);
        }).catch((err) => {
            // A signed-in user simply stays on this welcome screen instead
            // of being auto-routed to their dashboard — not ideal, but
            // never a blank/stuck screen, and Sign In is always right here.
            console.warn('[index] session/profile check failed:', err);
        });
    }, [ready, hasChosenLanguage]);

    if (!ready || !hasChosenLanguage) {
        return <View style={[styles.container, { paddingTop: insets.top }]} />;
    }

    function navigate(href: '/signup' | '/signin') {
        if (Platform.OS === 'ios') {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        }
        router.push(href);
    }

    return (
        <View style={[styles.container, { paddingTop: insets.top }]}>
            <StatusBar style="dark" />

            {/* Decorative background blobs */}
            <View style={styles.blobTopRight} />
            <View style={styles.blobBottomLeft} />

            {/* Hero section */}
            <View style={styles.hero}>
                {/* Logo mark */}
                <View style={styles.logoRow}>
                    <Image
                        source={require('@/assets/brand/tavora-mark.png')}
                        style={styles.logoMark}
                        resizeMode="contain"
                    />
                    <Text style={styles.logoText}>Tavora</Text>
                </View>

                <Text style={styles.headline}>
                    {t('welcome.headline')}
                </Text>

                <Text style={styles.subtitle}>
                    {t('welcome.subtitle')}
                </Text>
            </View>

            {/* CTA card — white, anchored to bottom */}
            <View
                style={[
                    styles.ctaCard,
                    SHADOW.md,
                    { paddingBottom: Math.max(insets.bottom + 8, 32) },
                ]}
            >
                <TouchableOpacity
                    style={[styles.primaryButton, SHADOW.primary]}
                    onPress={() => navigate('/signup')}
                    activeOpacity={0.88}
                >
                    <Text style={styles.primaryButtonText}>{t('welcome.getStarted')}</Text>
                </TouchableOpacity>

                <TouchableOpacity
                    style={styles.secondaryButton}
                    onPress={() => navigate('/signin')}
                    activeOpacity={0.7}
                >
                    <Text style={styles.secondaryButtonText}>{t('welcome.haveAccount')}</Text>
                </TouchableOpacity>

                <Text style={styles.termsText}>
                    {t('welcome.terms')}
                </Text>
            </View>
        </View>
    );
}

const createStyles = (C: ThemeColors) => StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: C.bgPage,
    },

    // ── Decorative blobs ──────────────────────────────────────────────
    blobTopRight: {
        position: 'absolute',
        top: -80,
        right: -80,
        width: 260,
        height: 260,
        borderRadius: 130,
        backgroundColor: C.primaryMid,
        opacity: 0.35,
    },
    blobBottomLeft: {
        position: 'absolute',
        bottom: 200,
        left: -50,
        width: 160,
        height: 160,
        borderRadius: 80,
        backgroundColor: C.primaryLight,
        opacity: 0.9,
    },

    // ── Hero ──────────────────────────────────────────────────────────
    hero: {
        flex: 1,
        paddingHorizontal: 28,
        paddingTop: 16,
        justifyContent: 'center',
    },
    logoRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 52,
    },
    logoMark: {
        width: 36,
        height: 36,
        marginRight: 10,
    },
    logoText: {
        fontSize: 20,
        fontWeight: '800',
        color: C.textPrimary,
        letterSpacing: -0.4,
    },
    headline: {
        fontSize: 40,
        fontWeight: '800',
        color: C.textPrimary,
        lineHeight: 50,
        letterSpacing: -1,
        marginBottom: 18,
    },
    subtitle: {
        fontSize: 17,
        color: C.textSecondary,
        lineHeight: 27,
        letterSpacing: -0.2,
    },

    // ── CTA card ──────────────────────────────────────────────────────
    ctaCard: {
        backgroundColor: C.bgSurface,
        borderTopLeftRadius: RADIUS.xxl,
        borderTopRightRadius: RADIUS.xxl,
        paddingHorizontal: 24,
        paddingTop: 32,
    },
    primaryButton: {
        backgroundColor: C.primary,
        paddingVertical: 18,
        borderRadius: RADIUS.xl,
        alignItems: 'center',
        marginBottom: 14,
    },
    primaryButtonText: {
        color: C.textInverse,
        fontSize: 17,
        fontWeight: '700',
        letterSpacing: -0.2,
    },
    secondaryButton: {
        paddingVertical: 16,
        alignItems: 'center',
        marginBottom: 12,
    },
    secondaryButtonText: {
        fontSize: 16,
        fontWeight: '600',
        color: C.primary,
        letterSpacing: -0.1,
    },
    termsText: {
        textAlign: 'center',
        fontSize: 12,
        color: C.textMuted,
        lineHeight: 18,
        paddingBottom: 4,
    },
});
