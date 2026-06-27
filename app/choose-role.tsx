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

import { RADIUS, SHADOW, T, ThemeColors } from '@/constants/theme';
import { useThemeColors } from '@/lib/theme';
import { supabase } from '@/lib/supabase';

type Role = 'caregiver' | 'recipient';

export default function ChooseRoleScreen() {
    const C = useThemeColors();
    const styles = useMemo(() => createStyles(C), [C]);
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
                        <Ionicons name="people" size={26} color={C.primary} />
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
                        <View style={[styles.cardIconWrap, { backgroundColor: C.caregiverLight }]}>
                            <Ionicons name="heart" size={26} color={C.caregiverColor} />
                        </View>

                        <View style={styles.cardBody}>
                            <Text style={styles.cardTitle}>I'm an Organizer</Text>
                            <Text style={styles.cardText}>
                                Create reminders and track a participant's progress.
                            </Text>
                        </View>

                        <View style={styles.cardTrailing}>
                            {loadingRole === 'caregiver' ? (
                                <ActivityIndicator size="small" color={C.caregiverColor} />
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
                    >
                        <View style={[styles.cardIconWrap, { backgroundColor: C.recipientLight }]}>
                            <Ionicons name="person" size={26} color={C.recipientColor} />
                        </View>

                        <View style={styles.cardBody}>
                            <Text style={styles.cardTitle}>I'm a Participant</Text>
                            <Text style={styles.cardText}>
                                See today's reminders and mark tasks as completed.
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
                    You can only choose your role once. This helps us set up the right experience for you.
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
