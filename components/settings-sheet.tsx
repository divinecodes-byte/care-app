import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Modal,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RADIUS, T } from '@/constants/theme';
import { supabase } from '@/lib/supabase';

type Props = {
    visible: boolean;
    onClose: () => void;
};

type ProfileData = {
    fullName: string;
    email: string;
    role: string;
    connectionStatus: string;
};

export function SettingsSheet({ visible, onClose }: Props) {
    const insets = useSafeAreaInsets();
    const [loading, setLoading]     = useState(true);
    const [signingOut, setSigningOut] = useState(false);
    const [profile, setProfile]     = useState<ProfileData>({
        fullName: '',
        email: '',
        role: '',
        connectionStatus: '',
    });

    useEffect(() => {
        if (visible) fetchProfile();
    }, [visible]);

    async function fetchProfile() {
        setLoading(true);
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) { setLoading(false); return; }

        const { data } = await supabase
            .from('profiles')
            .select('full_name, role')
            .eq('id', user.id)
            .maybeSingle();

        const role = data?.role ?? '';

        let connectionStatus = 'No connection';
        if (role === 'caregiver') {
            const { data: conn } = await supabase
                .from('connections')
                .select('status')
                .eq('caregiver_id', user.id)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();
            if (conn?.status === 'accepted') connectionStatus = 'Connected';
            else if (conn?.status === 'pending') connectionStatus = 'Pending — awaiting acceptance';
        } else if (role === 'recipient') {
            const { data: conn } = await supabase
                .from('connections')
                .select('status')
                .eq('recipient_id', user.id)
                .eq('status', 'accepted')
                .limit(1)
                .maybeSingle();
            connectionStatus = conn ? 'Connected' : 'Not connected';
        }

        setProfile({
            fullName:         data?.full_name ?? 'Unknown',
            email:            user.email ?? '',
            role,
            connectionStatus,
        });
        setLoading(false);
    }

    async function handleSignOut() {
        setSigningOut(true);
        await supabase.auth.signOut();
        setSigningOut(false);
        onClose();
        router.replace('/signin');
    }

    const roleLabel =
        profile.role === 'caregiver' ? 'Caregiver'
        : profile.role === 'recipient' ? 'Recipient'
        : profile.role;

    return (
        <Modal
            visible={visible}
            animationType="slide"
            transparent
            onRequestClose={onClose}
        >
            {/* Outer Pressable = dim backdrop — dismisses on tap */}
            <Pressable
                style={styles.backdrop}
                onPress={onClose}
            >
                {/* Inner Pressable = sheet — consumes taps to prevent dismiss */}
                <Pressable style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}>
                    {/* Drag handle */}
                    <View style={styles.handle} />

                    {/* Header */}
                    <View style={styles.header}>
                        <Text style={styles.title}>Settings</Text>
                        <TouchableOpacity
                            style={styles.closeBtn}
                            onPress={onClose}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        >
                            <Ionicons name="close" size={20} color={T.textMuted} />
                        </TouchableOpacity>
                    </View>

                    {loading ? (
                        <View style={styles.loadingBox}>
                            <ActivityIndicator color={T.primary} />
                            <Text style={styles.loadingText}>Loading profile…</Text>
                        </View>
                    ) : (
                        <ScrollView
                            showsVerticalScrollIndicator={false}
                            contentContainerStyle={styles.scrollContent}
                        >
                            {/* Profile section */}
                            <SectionLabel text="Profile" />
                            <InfoCard>
                                <InfoRow
                                    icon="person-outline"
                                    label="Name"
                                    value={profile.fullName}
                                />
                                <Divider />
                                <InfoRow
                                    icon="mail-outline"
                                    label="Email"
                                    value={profile.email}
                                />
                                <Divider />
                                <InfoRow
                                    icon="shield-checkmark-outline"
                                    label="Role"
                                    value={roleLabel}
                                    valueStyle={
                                        profile.role === 'caregiver'
                                            ? styles.caregiverBadge
                                            : styles.recipientBadge
                                    }
                                />
                                <Divider />
                                <InfoRow
                                    icon="link-outline"
                                    label="Connection"
                                    value={profile.connectionStatus}
                                />
                            </InfoCard>

                            {/* Preferences section */}
                            <SectionLabel text="Preferences" />
                            <InfoCard>
                                <PlaceholderRow
                                    icon="notifications-outline"
                                    label="Notifications"
                                />
                                <Divider />
                                <PlaceholderRow
                                    icon="alarm-outline"
                                    label="Snooze duration"
                                />
                            </InfoCard>

                            {/* Support section */}
                            <SectionLabel text="Support" />
                            <InfoCard>
                                <PlaceholderRow
                                    icon="help-circle-outline"
                                    label="Help & FAQ"
                                />
                                <Divider />
                                <PlaceholderRow
                                    icon="lock-closed-outline"
                                    label="Privacy policy"
                                />
                            </InfoCard>

                            {/* Sign out */}
                            <TouchableOpacity
                                style={styles.signOutBtn}
                                onPress={handleSignOut}
                                disabled={signingOut}
                                activeOpacity={0.82}
                            >
                                {signingOut ? (
                                    <ActivityIndicator color={T.error} />
                                ) : (
                                    <>
                                        <Ionicons name="log-out-outline" size={20} color={T.error} />
                                        <Text style={styles.signOutText}>Sign Out</Text>
                                    </>
                                )}
                            </TouchableOpacity>
                        </ScrollView>
                    )}
                </Pressable>
            </Pressable>
        </Modal>
    );
}

// ─── Local sub-components ─────────────────────────────────────────────────────

function SectionLabel({ text }: { text: string }) {
    return <Text style={styles.sectionLabel}>{text}</Text>;
}

function InfoCard({ children }: { children: React.ReactNode }) {
    return <View style={styles.infoCard}>{children}</View>;
}

function InfoRow({
    icon,
    label,
    value,
    valueStyle,
}: {
    icon: string;
    label: string;
    value: string;
    valueStyle?: object;
}) {
    return (
        <View style={styles.row}>
            <Ionicons name={icon as any} size={18} color={T.textMuted} style={styles.rowIcon} />
            <Text style={styles.rowLabel}>{label}</Text>
            <Text style={[styles.rowValue, valueStyle]} numberOfLines={1}>
                {value}
            </Text>
        </View>
    );
}

function PlaceholderRow({ icon, label }: { icon: string; label: string }) {
    return (
        <View style={styles.row}>
            <Ionicons name={icon as any} size={18} color={T.textMuted} style={styles.rowIcon} />
            <Text style={styles.rowLabel}>{label}</Text>
            <Text style={styles.comingSoon}>Coming soon</Text>
        </View>
    );
}

function Divider() {
    return <View style={styles.divider} />;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
    backdrop: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.45)',
        justifyContent: 'flex-end',
    },
    sheet: {
        backgroundColor: T.bgSurface,
        borderTopLeftRadius: RADIUS.xxl,
        borderTopRightRadius: RADIUS.xxl,
        paddingHorizontal: 20,
        paddingTop: 12,
        maxHeight: '88%',
    },
    handle: {
        width: 40,
        height: 4,
        backgroundColor: T.border,
        borderRadius: RADIUS.full,
        alignSelf: 'center',
        marginBottom: 16,
    },

    // ── Sheet header ───────────────────────────────────────────────────
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 20,
    },
    title: {
        fontSize: 20,
        fontWeight: '800',
        color: T.textPrimary,
        letterSpacing: -0.4,
    },
    closeBtn: {
        width: 32,
        height: 32,
        borderRadius: RADIUS.full,
        backgroundColor: T.bgAlt,
        justifyContent: 'center',
        alignItems: 'center',
    },

    // ── Loading ───────────────────────────────────────────────────────
    loadingBox: {
        paddingVertical: 40,
        alignItems: 'center',
        gap: 12,
    },
    loadingText: {
        fontSize: 14,
        color: T.textMuted,
        fontWeight: '600',
    },

    scrollContent: {
        paddingBottom: 8,
    },

    // ── Sections ──────────────────────────────────────────────────────
    sectionLabel: {
        fontSize: 11,
        fontWeight: '700',
        color: T.textMuted,
        textTransform: 'uppercase',
        letterSpacing: 0.8,
        marginBottom: 8,
        marginTop: 20,
    },
    infoCard: {
        backgroundColor: T.bgAlt,
        borderRadius: RADIUS.xl,
        overflow: 'hidden',
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 13,
        paddingHorizontal: 16,
        gap: 12,
    },
    rowIcon: {
        width: 20,
    },
    rowLabel: {
        flex: 1,
        fontSize: 15,
        color: T.textPrimary,
        fontWeight: '500',
    },
    rowValue: {
        fontSize: 14,
        color: T.textSecondary,
        fontWeight: '600',
        flexShrink: 1,
    },
    caregiverBadge: {
        color: T.primary,
    },
    recipientBadge: {
        color: T.success,
    },
    comingSoon: {
        fontSize: 12,
        color: T.textMuted,
        fontWeight: '600',
        fontStyle: 'italic',
    },
    divider: {
        height: 1,
        backgroundColor: T.border,
        marginLeft: 48,
    },

    // ── Sign out ──────────────────────────────────────────────────────
    signOutBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        marginTop: 24,
        paddingVertical: 16,
        borderRadius: RADIUS.xl,
        backgroundColor: T.errorLight,
        borderWidth: 1.5,
        borderColor: '#FECACA',
    },
    signOutText: {
        fontSize: 16,
        fontWeight: '700',
        color: T.error,
        letterSpacing: -0.1,
    },
});
