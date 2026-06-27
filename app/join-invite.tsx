import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    KeyboardAvoidingView,
    Platform,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { RADIUS, SHADOW, T, ThemeColors } from '@/constants/theme';
import { useThemeColors } from '@/lib/theme';
import { supabase } from '@/lib/supabase';

export default function JoinInviteScreen() {
    const C = useThemeColors();
    const styles = useMemo(() => createStyles(C), [C]);
    const [inviteCode, setInviteCode] = useState('');
    const [loading, setLoading]       = useState(false);
    const [focused, setFocused]       = useState(false);

    async function joinInvite() {
        const normalizedCode = inviteCode.trim().toUpperCase();

        if (!normalizedCode) {
            Alert.alert('Missing code', 'Please enter your invite code.');
            return;
        }

        if (normalizedCode.length < 6) {
            Alert.alert('Invalid code', 'The code should be 6 characters.');
            return;
        }

        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        setLoading(true);

        const { data: { user }, error: userError } = await supabase.auth.getUser();

        if (userError || !user) {
            setLoading(false);
            Alert.alert('Not signed in', 'Please sign in again.');
            return;
        }

        const { data, error } = await supabase
            .from('connections')
            .update({
                recipient_id: user.id,
                status:       'accepted',
                accepted_at:  new Date().toISOString(),
            })
            .eq('invite_code', normalizedCode)
            .eq('status', 'pending')
            .is('recipient_id', null)
            .select()
            .maybeSingle();

        setLoading(false);

        if (error) {
            Alert.alert('Invite error', error.message);
            return;
        }

        if (!data) {
            Alert.alert('Invalid code', 'This invite code does not exist or was already used.');
            return;
        }

        router.replace('/recipient-dashboard');
    }

    return (
        <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
            <KeyboardAvoidingView
                style={styles.kav}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}
            >
                <ScrollView
                    contentContainerStyle={styles.scroll}
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator={false}
                >
                    {/* Back */}
                    <TouchableOpacity
                        style={styles.backButton}
                        onPress={() => router.back()}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                        <Ionicons name="chevron-back" size={22} color={C.primary} />
                        <Text style={styles.backText}>Back</Text>
                    </TouchableOpacity>

                    {/* Header */}
                    <View style={styles.headerIcon}>
                        <Ionicons name="link" size={26} color={C.success} />
                    </View>
                    <Text style={styles.heading}>Join Care Circle</Text>
                    <Text style={styles.subheading}>
                        Enter the invite code your organizer shared with you to link accounts.
                    </Text>

                    {/* Code input card */}
                    <View style={[styles.inputCard, SHADOW.xs]}>
                        <Text style={styles.label}>Invite Code</Text>

                        <TextInput
                            style={[styles.input, focused && styles.inputFocused]}
                            placeholder="ABC123"
                            placeholderTextColor={C.textMuted}
                            autoCapitalize="characters"
                            autoCorrect={false}
                            maxLength={6}
                            value={inviteCode}
                            onChangeText={setInviteCode}
                            onFocus={() => setFocused(true)}
                            onBlur={() => setFocused(false)}
                            returnKeyType="done"
                            onSubmitEditing={joinInvite}
                        />

                        <Text style={styles.helperText}>
                            6 characters · letters and numbers · not case-sensitive
                        </Text>
                    </View>

                    {/* Trust note */}
                    <View style={styles.trustNote}>
                        <Ionicons name="shield-checkmark-outline" size={16} color={C.success} />
                        <Text style={styles.trustText}>
                            This code was given to you by your organizer. It's safe to enter.
                        </Text>
                    </View>

                    {/* Spacer */}
                    <View style={styles.spacer} />

                    {/* Connect button */}
                    <TouchableOpacity
                        style={[styles.button, SHADOW.primary, loading && styles.buttonDisabled]}
                        onPress={joinInvite}
                        disabled={loading}
                        activeOpacity={0.88}
                    >
                        {loading ? (
                            <ActivityIndicator color={C.textInverse} />
                        ) : (
                            <>
                                <Text style={styles.buttonText}>Connect Account</Text>
                                <Ionicons name="arrow-forward" size={20} color={C.textInverse} />
                            </>
                        )}
                    </TouchableOpacity>
                </ScrollView>
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}

const createStyles = (C: ThemeColors) => StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: C.bgPage,
    },
    kav: {
        flex: 1,
    },
    scroll: {
        flexGrow: 1,
        paddingHorizontal: 24,
        paddingTop: 12,
        paddingBottom: 32,
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
        color: C.primary,
        marginLeft: 2,
    },

    // ── Header ────────────────────────────────────────────────────────
    headerIcon: {
        width: 52,
        height: 52,
        borderRadius: RADIUS.lg,
        backgroundColor: C.successLight,
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: 18,
    },
    heading: {
        fontSize: 30,
        fontWeight: '800',
        color: C.textPrimary,
        letterSpacing: -0.6,
        marginBottom: 10,
    },
    subheading: {
        fontSize: 15,
        color: C.textSecondary,
        lineHeight: 22,
        letterSpacing: -0.1,
        marginBottom: 28,
    },

    // ── Input card ────────────────────────────────────────────────────
    inputCard: {
        backgroundColor: C.bgSurface,
        borderRadius: RADIUS.xl,
        padding: 20,
        marginBottom: 14,
    },
    label: {
        fontSize: 13,
        fontWeight: '700',
        color: C.textPrimary,
        marginBottom: 12,
        letterSpacing: 0.1,
    },
    input: {
        backgroundColor: C.bgAlt,
        borderRadius: RADIUS.lg,
        paddingHorizontal: 20,
        paddingVertical: Platform.OS === 'ios' ? 18 : 15,
        fontSize: 30,
        fontWeight: '800',
        letterSpacing: 10,
        borderWidth: 2,
        borderColor: 'transparent',
        color: C.textPrimary,
        textAlign: 'center',
        fontVariant: ['tabular-nums'],
    },
    inputFocused: {
        backgroundColor: C.bgSurface,
        borderColor: C.borderFocus,
    },
    helperText: {
        fontSize: 12,
        color: C.textMuted,
        textAlign: 'center',
        marginTop: 10,
        lineHeight: 18,
    },

    // ── Trust note ────────────────────────────────────────────────────
    trustNote: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
        backgroundColor: C.successLight,
        borderRadius: RADIUS.lg,
        padding: 14,
        borderWidth: 1,
        borderColor: '#A7F3D0',
    },
    trustText: {
        flex: 1,
        fontSize: 13,
        color: '#065F46',
        lineHeight: 19,
        fontWeight: '500',
    },

    // ── CTA ───────────────────────────────────────────────────────────
    spacer: {
        flex: 1,
        minHeight: 32,
    },
    button: {
        backgroundColor: C.primary,
        paddingVertical: 18,
        borderRadius: RADIUS.xl,
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 10,
        marginTop: 24,
    },
    buttonDisabled: {
        opacity: 0.65,
    },
    buttonText: {
        color: C.textInverse,
        fontSize: 17,
        fontWeight: '700',
        letterSpacing: -0.2,
    },
});
