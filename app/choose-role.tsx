import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useState } from 'react';
import {
    ActivityIndicator,
    Platform,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { RADIUS, SHADOW, T } from '@/constants/theme';
import { supabase } from '@/lib/supabase';

type Role = 'caregiver' | 'recipient';

export default function ChooseRoleScreen() {
    const [loadingRole, setLoadingRole] = useState<Role | null>(null);

    async function handleChooseRole(role: Role) {
        if (loadingRole) return;

        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        setLoadingRole(role);

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
            console.log(error.message);
            setLoadingRole(null);
            return;
        }

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
                        <Ionicons name="people" size={26} color={T.primary} />
                    </View>
                    <Text style={styles.title}>How will you use{'\n'}Tavora?</Text>
                    <Text style={styles.subtitle}>
                        Choose your role so we can personalize your experience.
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
                    >
                        <View style={[styles.cardIconWrap, { backgroundColor: T.caregiverLight }]}>
                            <Ionicons name="heart" size={26} color={T.caregiverColor} />
                        </View>

                        <View style={styles.cardBody}>
                            <Text style={styles.cardTitle}>I am a caregiver</Text>
                            <Text style={styles.cardText}>
                                Create reminders and track your loved one's care activities.
                            </Text>
                        </View>

                        <View style={styles.cardTrailing}>
                            {loadingRole === 'caregiver' ? (
                                <ActivityIndicator size="small" color={T.caregiverColor} />
                            ) : (
                                <Ionicons name="chevron-forward" size={20} color={T.textMuted} />
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
                    >
                        <View style={[styles.cardIconWrap, { backgroundColor: T.recipientLight }]}>
                            <Ionicons name="person" size={26} color={T.recipientColor} />
                        </View>

                        <View style={styles.cardBody}>
                            <Text style={styles.cardTitle}>I am receiving care</Text>
                            <Text style={styles.cardText}>
                                See today's reminders and mark tasks as completed.
                            </Text>
                        </View>

                        <View style={styles.cardTrailing}>
                            {loadingRole === 'recipient' ? (
                                <ActivityIndicator size="small" color={T.recipientColor} />
                            ) : (
                                <Ionicons name="chevron-forward" size={20} color={T.textMuted} />
                            )}
                        </View>
                    </TouchableOpacity>
                </View>

                <Text style={styles.hint}>
                    You can only choose your role once. This helps us set up the right experience for you.
                </Text>
            </View>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: T.bgPage,
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
        backgroundColor: T.primaryLight,
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: 20,
    },
    title: {
        fontSize: 34,
        fontWeight: '800',
        color: T.textPrimary,
        lineHeight: 42,
        letterSpacing: -0.8,
        marginBottom: 12,
    },
    subtitle: {
        fontSize: 16,
        color: T.textSecondary,
        lineHeight: 24,
        letterSpacing: -0.1,
    },

    // ── Cards ─────────────────────────────────────────────────────────
    cards: {
        gap: 14,
        marginBottom: 28,
    },
    card: {
        backgroundColor: T.bgSurface,
        borderRadius: RADIUS.xl,
        padding: 20,
        flexDirection: 'row',
        alignItems: 'center',
        borderWidth: 1.5,
        borderColor: T.border,
    },
    cardActive: {
        borderColor: T.primary,
        backgroundColor: T.primaryLight,
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
        color: T.textPrimary,
        letterSpacing: -0.3,
        marginBottom: 5,
    },
    cardText: {
        fontSize: 14,
        color: T.textSecondary,
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
        color: T.textMuted,
        textAlign: 'center',
        lineHeight: 19,
        paddingHorizontal: 8,
    },
});
