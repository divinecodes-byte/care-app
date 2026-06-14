import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RADIUS, SHADOW, T } from '@/constants/theme';

export default function HomeScreen() {
    const insets = useSafeAreaInsets();

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
                    <View style={styles.logoIconWrap}>
                        <Ionicons name="heart" size={20} color={T.textInverse} />
                    </View>
                    <Text style={styles.logoText}>Care App</Text>
                </View>

                <Text style={styles.headline}>
                    Care together,{'\n'}from anywhere.
                </Text>

                <Text style={styles.subtitle}>
                    Simple reminders and daily check-ins to keep your loved ones safe and cared for.
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
                    <Text style={styles.primaryButtonText}>Get Started</Text>
                </TouchableOpacity>

                <TouchableOpacity
                    style={styles.secondaryButton}
                    onPress={() => navigate('/signin')}
                    activeOpacity={0.7}
                >
                    <Text style={styles.secondaryButtonText}>I already have an account</Text>
                </TouchableOpacity>

                <Text style={styles.termsText}>
                    By continuing, you agree to our Terms of Use and Privacy Policy.
                </Text>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: T.bgPage,
    },

    // ── Decorative blobs ──────────────────────────────────────────────
    blobTopRight: {
        position: 'absolute',
        top: -80,
        right: -80,
        width: 260,
        height: 260,
        borderRadius: 130,
        backgroundColor: T.primaryMid,
        opacity: 0.35,
    },
    blobBottomLeft: {
        position: 'absolute',
        bottom: 200,
        left: -50,
        width: 160,
        height: 160,
        borderRadius: 80,
        backgroundColor: T.primaryLight,
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
    logoIconWrap: {
        width: 42,
        height: 42,
        borderRadius: RADIUS.md,
        backgroundColor: T.primary,
        justifyContent: 'center',
        alignItems: 'center',
        marginRight: 10,
    },
    logoText: {
        fontSize: 20,
        fontWeight: '800',
        color: T.textPrimary,
        letterSpacing: -0.4,
    },
    headline: {
        fontSize: 40,
        fontWeight: '800',
        color: T.textPrimary,
        lineHeight: 50,
        letterSpacing: -1,
        marginBottom: 18,
    },
    subtitle: {
        fontSize: 17,
        color: T.textSecondary,
        lineHeight: 27,
        letterSpacing: -0.2,
    },

    // ── CTA card ──────────────────────────────────────────────────────
    ctaCard: {
        backgroundColor: T.bgSurface,
        borderTopLeftRadius: RADIUS.xxl,
        borderTopRightRadius: RADIUS.xxl,
        paddingHorizontal: 24,
        paddingTop: 32,
    },
    primaryButton: {
        backgroundColor: T.primary,
        paddingVertical: 18,
        borderRadius: RADIUS.xl,
        alignItems: 'center',
        marginBottom: 14,
    },
    primaryButtonText: {
        color: T.textInverse,
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
        color: T.primary,
        letterSpacing: -0.1,
    },
    termsText: {
        textAlign: 'center',
        fontSize: 12,
        color: T.textMuted,
        lineHeight: 18,
        paddingBottom: 4,
    },
});
