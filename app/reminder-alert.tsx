import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Animated, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RADIUS, SHADOW, T } from '@/constants/theme';

export default function ReminderAlertScreen() {
    const insets = useSafeAreaInsets();

    // Pulsing glow animation
    const pulseScale   = useRef(new Animated.Value(1)).current;
    const pulseOpacity = useRef(new Animated.Value(0.45)).current;

    useEffect(() => {
        const animation = Animated.loop(
            Animated.parallel([
                Animated.sequence([
                    Animated.timing(pulseScale,   { toValue: 1.18, duration: 1800, useNativeDriver: true }),
                    Animated.timing(pulseScale,   { toValue: 1,    duration: 1800, useNativeDriver: true }),
                ]),
                Animated.sequence([
                    Animated.timing(pulseOpacity, { toValue: 0.15, duration: 1800, useNativeDriver: true }),
                    Animated.timing(pulseOpacity, { toValue: 0.45, duration: 1800, useNativeDriver: true }),
                ]),
            ])
        );
        animation.start();
        return () => animation.stop();
    }, []);

    function handleAction(destination: '/recipient-dashboard') {
        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        router.push(destination);
    }

    return (
        <View style={[styles.container, { paddingTop: insets.top }]}>
            {/* Pulsing glow ring — positioned behind content */}
            <Animated.View
                style={[
                    styles.glowRing,
                    { transform: [{ scale: pulseScale }], opacity: pulseOpacity },
                ]}
            />

            {/* Content */}
            <View style={styles.content}>
                {/* Badge */}
                <View style={styles.alertBadge}>
                    <Ionicons name="notifications" size={14} color="#93C5FD" />
                    <Text style={styles.alertBadgeText}>Reminder</Text>
                </View>

                {/* Time */}
                <Text style={styles.time}>8:00 AM</Text>

                {/* Title */}
                <Text style={styles.title}>Take Blood Pressure{'\n'}Medication</Text>

                {/* Notes */}
                <Text style={styles.notes}>1 pill after breakfast</Text>
            </View>

            {/* Buttons — pinned near bottom */}
            <View style={[styles.buttonArea, { paddingBottom: Math.max(insets.bottom + 8, 32) }]}>
                {/* Primary — Taken */}
                <TouchableOpacity
                    style={[styles.takenButton, SHADOW.sm]}
                    onPress={() => handleAction('/recipient-dashboard')}
                    activeOpacity={0.88}
                >
                    <Ionicons name="checkmark-circle" size={24} color="#FFFFFF" />
                    <Text style={styles.takenText}>Taken</Text>
                </TouchableOpacity>

                {/* Secondary — Later */}
                <TouchableOpacity
                    style={styles.laterButton}
                    onPress={() => handleAction('/recipient-dashboard')}
                    activeOpacity={0.8}
                >
                    <Ionicons name="time-outline" size={20} color="#93C5FD" />
                    <Text style={styles.laterText}>Remind Me Later</Text>
                </TouchableOpacity>

                {/* Tertiary — Skip */}
                <TouchableOpacity
                    style={styles.skipButton}
                    onPress={() => handleAction('/recipient-dashboard')}
                    activeOpacity={0.6}
                >
                    <Text style={styles.skipText}>Skip this reminder</Text>
                </TouchableOpacity>

                <Text style={styles.footerText}>
                    Your caregiver will be updated with your response.
                </Text>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#0D1B2A',
    },

    // ── Glow ring ─────────────────────────────────────────────────────
    glowRing: {
        position: 'absolute',
        width: 360,
        height: 360,
        borderRadius: 180,
        backgroundColor: T.primary,
        left: '50%',
        marginLeft: -180,
        top: '18%',
        marginTop: -180,
    },

    // ── Content ───────────────────────────────────────────────────────
    content: {
        flex: 1,
        paddingHorizontal: 28,
        justifyContent: 'center',
        alignItems: 'center',
    },
    alertBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        backgroundColor: 'rgba(255,255,255,0.1)',
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: RADIUS.full,
        marginBottom: 28,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.15)',
    },
    alertBadgeText: {
        color: '#93C5FD',
        fontSize: 13,
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: 1.2,
    },
    time: {
        fontSize: 20,
        color: '#93C5FD',
        fontWeight: '700',
        textAlign: 'center',
        marginBottom: 18,
        letterSpacing: 0.5,
    },
    title: {
        fontSize: 38,
        fontWeight: '800',
        color: '#FFFFFF',
        textAlign: 'center',
        lineHeight: 48,
        letterSpacing: -0.8,
        marginBottom: 18,
    },
    notes: {
        fontSize: 18,
        color: 'rgba(255,255,255,0.6)',
        textAlign: 'center',
        lineHeight: 26,
    },

    // ── Button area ───────────────────────────────────────────────────
    buttonArea: {
        paddingHorizontal: 24,
        paddingTop: 8,
        gap: 12,
    },
    takenButton: {
        backgroundColor: '#16A34A',
        paddingVertical: 20,
        borderRadius: RADIUS.xl,
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 10,
    },
    takenText: {
        color: '#FFFFFF',
        fontSize: 20,
        fontWeight: '700',
        letterSpacing: -0.3,
    },
    laterButton: {
        paddingVertical: 18,
        borderRadius: RADIUS.xl,
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 8,
        borderWidth: 1.5,
        borderColor: 'rgba(147,197,253,0.35)',
        backgroundColor: 'rgba(255,255,255,0.06)',
    },
    laterText: {
        color: '#93C5FD',
        fontSize: 17,
        fontWeight: '600',
    },
    skipButton: {
        paddingVertical: 14,
        alignItems: 'center',
    },
    skipText: {
        color: 'rgba(255,255,255,0.35)',
        fontSize: 15,
        fontWeight: '500',
    },
    footerText: {
        color: 'rgba(255,255,255,0.3)',
        fontSize: 12,
        textAlign: 'center',
        lineHeight: 18,
        paddingBottom: 4,
    },
});
