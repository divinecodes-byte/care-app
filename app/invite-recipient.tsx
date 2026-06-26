import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Platform,
    ScrollView,
    Share,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { RADIUS, SHADOW, T } from '@/constants/theme';
import { supabase } from '@/lib/supabase';

function generateInviteCode() {
    const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return code;
}

const HOW_IT_WORKS = [
    'Your loved one opens Tavora on their phone.',
    'They choose "I am receiving care" as their role.',
    'They enter this 6-character invite code.',
    'Their reminders and responses become linked to your dashboard.',
];

export default function InviteRecipientScreen() {
    const [inviteCode, setInviteCode] = useState('');
    const [loading, setLoading]       = useState(false);

    // Restore any existing pending invite so the user sees their code immediately
    // and we never create duplicate pending connection rows.
    useEffect(() => {
        (async () => {
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) return;
            const { data } = await supabase
                .from('connections')
                .select('invite_code')
                .eq('caregiver_id', user.id)
                .eq('status', 'pending')
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();
            if (data?.invite_code) setInviteCode(data.invite_code);
        })();
    }, []);

    async function createInviteCode() {
        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        setLoading(true);

        const { data: { user }, error: userError } = await supabase.auth.getUser();

        if (userError || !user) {
            setLoading(false);
            Alert.alert('Not signed in', 'Please sign in again.');
            return;
        }

        const code = generateInviteCode();

        // Reuse an existing pending row (update its code) rather than inserting a
        // new one. This prevents orphaned pending connections from accumulating.
        const { data: existing } = await supabase
            .from('connections')
            .select('id')
            .eq('caregiver_id', user.id)
            .eq('status', 'pending')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        const { error } = existing?.id
            ? await supabase
                  .from('connections')
                  .update({ invite_code: code })
                  .eq('id', existing.id)
            : await supabase.from('connections').insert({
                  caregiver_id: user.id,
                  invite_code:  code,
                  status:       'pending',
              });

        setLoading(false);

        if (error) {
            Alert.alert(
                'Could not save invite code',
                'Please try again. If the problem continues, check your connection.'
            );
            return;
        }

        setInviteCode(code);
    }

    async function shareInviteCode() {
        if (!inviteCode) {
            Alert.alert('No invite code', 'Generate an invite code first.');
            return;
        }

        await Share.share({
            message: `Use this invite code to connect with me on Tavora: ${inviteCode}`,
        });
    }

    const hasCode = inviteCode.length > 0;

    return (
        <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
            <ScrollView
                contentContainerStyle={styles.content}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
            >
                {/* Back */}
                <TouchableOpacity
                    style={styles.backButton}
                    onPress={() => router.back()}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                    <Ionicons name="chevron-back" size={22} color={T.primary} />
                    <Text style={styles.backText}>Back</Text>
                </TouchableOpacity>

                {/* Header */}
                <View style={styles.headerIcon}>
                    <Ionicons name="person-add" size={26} color={T.primary} />
                </View>
                <Text style={styles.heading}>Invite Loved One</Text>
                <Text style={styles.subheading}>
                    Generate a code and share it so their account links to your dashboard.
                </Text>

                {/* Code card */}
                <View style={[styles.codeCard, SHADOW.sm, hasCode && styles.codeCardActive]}>
                    <Text style={styles.codeLabel}>Invite Code</Text>

                    {hasCode ? (
                        <>
                            <Text style={styles.code}>{inviteCode}</Text>
                            <View style={styles.codeReadyBadge}>
                                <Ionicons name="checkmark-circle" size={14} color={T.success} />
                                <Text style={styles.codeReadyText}>Ready to share</Text>
                            </View>
                        </>
                    ) : (
                        <>
                            <View style={styles.codePlaceholderRow}>
                                {Array.from({ length: 6 }).map((_, i) => (
                                    <View key={i} style={styles.codeDash} />
                                ))}
                            </View>
                            <Text style={styles.codeHint}>Tap "Generate" below to create a code.</Text>
                        </>
                    )}
                </View>

                {/* Generate button */}
                <TouchableOpacity
                    style={[
                        styles.generateButton,
                        hasCode ? styles.generateButtonSecondary : [styles.generateButtonPrimary, SHADOW.primary],
                        loading && styles.buttonDisabled,
                    ]}
                    onPress={createInviteCode}
                    disabled={loading}
                    activeOpacity={0.88}
                >
                    {loading ? (
                        <ActivityIndicator color={hasCode ? T.primary : T.textInverse} />
                    ) : (
                        <>
                            <Ionicons
                                name="refresh"
                                size={18}
                                color={hasCode ? T.primary : T.textInverse}
                            />
                            <Text style={hasCode ? styles.generateButtonTextSecondary : styles.generateButtonTextPrimary}>
                                {hasCode ? 'Generate New Code' : 'Generate Invite Code'}
                            </Text>
                        </>
                    )}
                </TouchableOpacity>

                {/* Share button — only shown once code exists */}
                {hasCode && (
                    <TouchableOpacity
                        style={[styles.shareButton, SHADOW.primary]}
                        onPress={shareInviteCode}
                        activeOpacity={0.88}
                    >
                        <Ionicons name="share-social" size={20} color={T.textInverse} />
                        <Text style={styles.shareButtonText}>Share Code</Text>
                    </TouchableOpacity>
                )}

                {/* How it works */}
                <View style={[styles.stepsCard, SHADOW.xs]}>
                    <Text style={styles.stepsTitle}>How it works</Text>

                    {HOW_IT_WORKS.map((step, index) => (
                        <View key={index} style={styles.stepRow}>
                            <View style={styles.stepBadge}>
                                <Text style={styles.stepBadgeText}>{index + 1}</Text>
                            </View>
                            <Text style={styles.stepText}>{step}</Text>
                        </View>
                    ))}
                </View>

                {/* Done */}
                <TouchableOpacity
                    style={styles.doneButton}
                    onPress={() => router.push('/caregiver-dashboard')}
                    activeOpacity={0.7}
                >
                    <Text style={styles.doneButtonText}>Done — go to dashboard</Text>
                </TouchableOpacity>
            </ScrollView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: T.bgPage,
    },
    content: {
        paddingHorizontal: 24,
        paddingTop: 12,
        paddingBottom: 40,
    },

    // ── Navigation ────────────────────────────────────────────────────
    backButton: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 28,
        alignSelf: 'flex-start',
    },
    backText: {
        fontSize: 16,
        fontWeight: '600',
        color: T.primary,
        marginLeft: 2,
    },

    // ── Header ────────────────────────────────────────────────────────
    headerIcon: {
        width: 52,
        height: 52,
        borderRadius: RADIUS.lg,
        backgroundColor: T.primaryLight,
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: 18,
    },
    heading: {
        fontSize: 30,
        fontWeight: '800',
        color: T.textPrimary,
        letterSpacing: -0.6,
        marginBottom: 10,
    },
    subheading: {
        fontSize: 15,
        color: T.textSecondary,
        lineHeight: 22,
        letterSpacing: -0.1,
        marginBottom: 28,
    },

    // ── Code card ─────────────────────────────────────────────────────
    codeCard: {
        backgroundColor: T.bgSurface,
        borderRadius: RADIUS.xl,
        padding: 28,
        alignItems: 'center',
        marginBottom: 14,
        borderWidth: 2,
        borderColor: T.border,
        borderStyle: 'dashed',
    },
    codeCardActive: {
        borderStyle: 'solid',
        borderColor: T.primary,
        backgroundColor: T.primaryLight,
    },
    codeLabel: {
        fontSize: 11,
        fontWeight: '700',
        color: T.textMuted,
        textTransform: 'uppercase',
        letterSpacing: 1,
        marginBottom: 16,
    },
    code: {
        fontSize: 42,
        fontWeight: '800',
        color: T.primary,
        letterSpacing: 8,
        marginBottom: 12,
        fontVariant: ['tabular-nums'],
    },
    codeReadyBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
    },
    codeReadyText: {
        fontSize: 13,
        color: T.success,
        fontWeight: '600',
    },
    codePlaceholderRow: {
        flexDirection: 'row',
        gap: 8,
        marginBottom: 16,
    },
    codeDash: {
        width: 28,
        height: 4,
        borderRadius: RADIUS.full,
        backgroundColor: T.border,
    },
    codeHint: {
        fontSize: 13,
        color: T.textMuted,
        textAlign: 'center',
    },

    // ── Buttons ───────────────────────────────────────────────────────
    generateButton: {
        paddingVertical: 16,
        borderRadius: RADIUS.xl,
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 8,
        marginBottom: 12,
    },
    generateButtonPrimary: {
        backgroundColor: T.primary,
    },
    generateButtonSecondary: {
        backgroundColor: T.bgSurface,
        borderWidth: 1.5,
        borderColor: T.border,
    },
    generateButtonTextPrimary: {
        color: T.textInverse,
        fontSize: 16,
        fontWeight: '700',
        letterSpacing: -0.1,
    },
    generateButtonTextSecondary: {
        color: T.primary,
        fontSize: 15,
        fontWeight: '600',
    },
    shareButton: {
        backgroundColor: T.primary,
        paddingVertical: 18,
        borderRadius: RADIUS.xl,
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 10,
        marginBottom: 24,
    },
    shareButtonText: {
        color: T.textInverse,
        fontSize: 17,
        fontWeight: '700',
        letterSpacing: -0.2,
    },
    buttonDisabled: {
        opacity: 0.65,
    },
    doneButton: {
        paddingVertical: 16,
        alignItems: 'center',
    },
    doneButtonText: {
        fontSize: 15,
        color: T.textMuted,
        fontWeight: '600',
    },

    // ── Steps card ────────────────────────────────────────────────────
    stepsCard: {
        backgroundColor: T.bgSurface,
        borderRadius: RADIUS.xl,
        padding: 20,
        marginBottom: 20,
    },
    stepsTitle: {
        fontSize: 16,
        fontWeight: '700',
        color: T.textPrimary,
        letterSpacing: -0.2,
        marginBottom: 18,
    },
    stepRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 14,
        marginBottom: 14,
    },
    stepBadge: {
        width: 26,
        height: 26,
        borderRadius: RADIUS.full,
        backgroundColor: T.primary,
        justifyContent: 'center',
        alignItems: 'center',
        flexShrink: 0,
        marginTop: 1,
    },
    stepBadgeText: {
        color: T.textInverse,
        fontSize: 12,
        fontWeight: '800',
    },
    stepText: {
        flex: 1,
        fontSize: 14,
        color: T.textSecondary,
        lineHeight: 21,
        letterSpacing: -0.1,
    },
});
