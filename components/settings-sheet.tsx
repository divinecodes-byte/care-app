import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Dimensions,
    Modal,
    Pressable,
    ScrollView,
    StyleSheet,
    Switch,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RADIUS, T } from '@/constants/theme';
import { registerCaregiverPushToken } from '@/lib/notifications';
import { supabase } from '@/lib/supabase';

// ─── Constants ────────────────────────────────────────────────────────────────

const SCREEN_HEIGHT = Dimensions.get('window').height;
const SHEET_HEIGHT  = Math.round(SCREEN_HEIGHT * 0.85);

// ─── Types ────────────────────────────────────────────────────────────────────

type Props = { visible: boolean; onClose: () => void };

type ProfileData = {
    fullName:         string;
    email:            string;
    role:             string;
    connectionStatus: string;
    connectionOk:     boolean;
};

type NotifPrefs = {
    notify_missed:  boolean;
    notify_skipped: boolean;
    notify_snoozed: boolean;
    notify_taken:   boolean;
};

// ─── Component ────────────────────────────────────────────────────────────────

export function SettingsSheet({ visible, onClose }: Props) {
    const insets = useSafeAreaInsets();

    const [loading,    setLoading]    = useState(true);
    const [signingOut, setSigningOut] = useState(false);
    const [profile,    setProfile]    = useState<ProfileData>({
        fullName: '', email: '', role: '', connectionStatus: '', connectionOk: false,
    });

    // Caregiver notification prefs
    const [userId,       setUserId]       = useState<string | null>(null);
    const [notifPrefs,   setNotifPrefs]   = useState<NotifPrefs | null>(null);
    const [pushTokenMsg, setPushTokenMsg] = useState<string | null>(null);

    useEffect(() => {
        if (visible) fetchProfile();
    }, [visible]);

    async function fetchProfile() {
        setLoading(true);
        setPushTokenMsg(null);

        const { data: { user } } = await supabase.auth.getUser();
        if (!user) { setLoading(false); return; }

        const { data: profileRow } = await supabase
            .from('profiles')
            .select('full_name, role')
            .eq('id', user.id)
            .maybeSingle();

        const role = profileRow?.role ?? '';
        let connectionStatus = 'No connection';
        let connectionOk     = false;

        if (role === 'caregiver') {
            const { data: accepted } = await supabase
                .from('connections')
                .select('recipient_id')
                .eq('caregiver_id', user.id)
                .eq('status', 'accepted')
                .not('recipient_id', 'is', null)
                .limit(1)
                .maybeSingle();

            if (accepted?.recipient_id) {
                const { data: recipientProfile } = await supabase
                    .from('profiles')
                    .select('full_name')
                    .eq('id', accepted.recipient_id)
                    .maybeSingle();
                connectionStatus = `Connected to ${recipientProfile?.full_name ?? 'Loved One'}`;
                connectionOk     = true;
            } else {
                const { data: pending } = await supabase
                    .from('connections')
                    .select('id')
                    .eq('caregiver_id', user.id)
                    .eq('status', 'pending')
                    .limit(1)
                    .maybeSingle();
                connectionStatus = pending
                    ? 'Pending — awaiting acceptance'
                    : 'No loved one connected';
            }

            setUserId(user.id);
            // Load notification prefs (awaited — content waits for prefs before showing)
            await loadNotifPrefs(user.id);
            // Register push token in background — don't block the sheet from opening
            registerCaregiverPushToken(user.id).then(result => {
                if (!result.ok) setPushTokenMsg(result.message);
            });

        } else if (role === 'recipient') {
            const { data: conn } = await supabase
                .from('connections')
                .select('caregiver_id')
                .eq('recipient_id', user.id)
                .eq('status', 'accepted')
                .limit(1)
                .maybeSingle();

            if (conn?.caregiver_id) {
                const { data: caregiverProfile } = await supabase
                    .from('profiles')
                    .select('full_name')
                    .eq('id', conn.caregiver_id)
                    .maybeSingle();
                connectionStatus = `Connected to ${caregiverProfile?.full_name ?? 'Caregiver'}`;
                connectionOk     = true;
            } else {
                connectionStatus = 'No caregiver connected';
            }
        }

        setProfile({
            fullName:         profileRow?.full_name ?? 'Unknown',
            email:            user.email ?? '',
            role,
            connectionStatus,
            connectionOk,
        });
        setLoading(false);
    }

    async function loadNotifPrefs(uid: string) {
        console.log('[NotifPrefs] loading for caregiver_id:', uid);

        const { data, error } = await supabase
            .from('notification_preferences')
            .select('notify_missed, notify_skipped, notify_snoozed, notify_taken')
            .eq('caregiver_id', uid)
            .maybeSingle();

        if (error) {
            console.error('[NotifPrefs] fetch error:', error.message);
        }

        console.log('[NotifPrefs] fetched row:', data);

        if (data) {
            setNotifPrefs({
                notify_missed:  data.notify_missed,
                notify_skipped: data.notify_skipped,
                notify_snoozed: data.notify_snoozed,
                notify_taken:   data.notify_taken,
            });
        } else {
            const defaults: NotifPrefs = {
                notify_missed:  true,
                notify_skipped: true,
                notify_snoozed: false,
                notify_taken:   false,
            };
            const { error: insertError } = await supabase
                .from('notification_preferences')
                .insert({ caregiver_id: uid, ...defaults });
            if (insertError) {
                console.error('[NotifPrefs] insert error:', insertError.message);
            }
            setNotifPrefs(defaults);
        }
    }

    async function updateNotifPref(key: keyof NotifPrefs, value: boolean) {
        if (!userId) return;

        // Optimistic update
        const previous = notifPrefs;
        setNotifPrefs(prev => prev ? { ...prev, [key]: value } : prev);

        const { error } = await supabase
            .from('notification_preferences')
            .update({ [key]: value, updated_at: new Date().toISOString() })
            .eq('caregiver_id', userId);

        if (error) {
            console.error('[NotifPrefs] update error:', error.message);
            // Revert optimistic change
            setNotifPrefs(previous);
        }
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

    // ── Render ────────────────────────────────────────────────────────────────

    return (
        <Modal
            visible={visible}
            animationType="slide"
            transparent
            onRequestClose={onClose}
        >
            {/*
             * Outer View carries the dim background and is NOT a touchable,
             * so it never interferes with ScrollView's responder negotiation.
             *
             * Inside it, a Pressable sibling fills the area *above* the sheet
             * (flex:1). Tapping there closes the modal. The sheet itself is a
             * plain View — no Pressable wrapper — so ScrollView can freely
             * steal the touch responder for scrolling.
             */}
            <View style={styles.backdrop}>
                <Pressable style={styles.backdropTap} onPress={onClose} />
                <View style={[styles.sheet, { height: SHEET_HEIGHT }]}>
                    {/* Decorative handle */}
                    <View style={styles.handleRow}>
                        <View style={styles.handle} />
                    </View>

                    {/* Header */}
                    <View style={styles.header}>
                        <Text style={styles.title}>Settings</Text>
                        <TouchableOpacity
                            style={styles.closeBtn}
                            onPress={onClose}
                            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                        >
                            <Ionicons name="close" size={18} color={T.textSecondary} />
                        </TouchableOpacity>
                    </View>

                    {/* Content */}
                    {loading ? (
                        <View style={styles.loadingBox}>
                            <ActivityIndicator color={T.primary} />
                            <Text style={styles.loadingText}>Loading profile…</Text>
                        </View>
                    ) : (
                        <ScrollView
                            style={styles.scroll}
                            contentContainerStyle={[
                                styles.scrollContent,
                                { paddingBottom: insets.bottom + 28 },
                            ]}
                            showsVerticalScrollIndicator={false}
                            bounces
                        >
                            {/* ── Profile ────────────────────────────────────── */}
                            <SectionLabel text="Profile" />
                            <Card>
                                <Row
                                    icon="person-outline"
                                    label="Name"
                                    value={profile.fullName}
                                />
                                <Sep />
                                <Row
                                    icon="mail-outline"
                                    label="Email"
                                    value={profile.email}
                                />
                                <Sep />
                                <Row
                                    icon="shield-checkmark-outline"
                                    label="Role"
                                    value={roleLabel}
                                    valueStyle={
                                        profile.role === 'caregiver'
                                            ? styles.valCaregiver
                                            : styles.valRecipient
                                    }
                                />
                                <Sep />
                                <Row
                                    icon="link-outline"
                                    label="Connection"
                                    value={profile.connectionStatus}
                                    valueStyle={profile.connectionOk ? styles.valConnected : undefined}
                                />
                            </Card>

                            {/* ── Notifications (caregiver) / Preferences (recipient) ── */}
                            {profile.role === 'caregiver' ? (
                                <>
                                    <SectionLabel text="Notifications" />
                                    <Card>
                                        <ToggleRow
                                            icon="alert-circle-outline"
                                            label="Missed reminders"
                                            value={notifPrefs?.notify_missed ?? true}
                                            onChange={v => updateNotifPref('notify_missed', v)}
                                        />
                                        <Sep />
                                        <ToggleRow
                                            icon="ban-outline"
                                            label="Skipped reminders"
                                            value={notifPrefs?.notify_skipped ?? true}
                                            onChange={v => updateNotifPref('notify_skipped', v)}
                                        />
                                        <Sep />
                                        <ToggleRow
                                            icon="time-outline"
                                            label="Snoozed reminders"
                                            value={notifPrefs?.notify_snoozed ?? false}
                                            onChange={v => updateNotifPref('notify_snoozed', v)}
                                        />
                                        <Sep />
                                        <ToggleRow
                                            icon="checkmark-circle-outline"
                                            label="Completed reminders"
                                            value={notifPrefs?.notify_taken ?? false}
                                            onChange={v => updateNotifPref('notify_taken', v)}
                                        />
                                        {pushTokenMsg ? (
                                            <>
                                                <Sep />
                                                <View style={styles.pushBanner}>
                                                    <Ionicons
                                                        name="information-circle-outline"
                                                        size={14}
                                                        color={T.textMuted}
                                                        style={styles.pushBannerIcon}
                                                    />
                                                    <Text style={styles.pushBannerText}>{pushTokenMsg}</Text>
                                                </View>
                                            </>
                                        ) : null}
                                    </Card>
                                </>
                            ) : (
                                <>
                                    <SectionLabel text="Preferences" />
                                    <Card>
                                        <PlaceholderRow icon="notifications-outline" label="Notifications" />
                                        <Sep />
                                        <PlaceholderRow icon="alarm-outline"         label="Snooze duration" />
                                    </Card>
                                </>
                            )}

                            {/* ── Support ────────────────────────────────────── */}
                            <SectionLabel text="Support" />
                            <Card>
                                <PlaceholderRow icon="help-circle-outline" label="Help & FAQ" />
                                <Sep />
                                <PlaceholderRow icon="lock-closed-outline"  label="Privacy policy" />
                            </Card>

                            {/* ── Sign out ───────────────────────────────────── */}
                            <TouchableOpacity
                                style={[styles.signOutBtn, signingOut && styles.signOutDisabled]}
                                onPress={handleSignOut}
                                disabled={signingOut}
                                activeOpacity={0.8}
                            >
                                {signingOut ? (
                                    <ActivityIndicator color={T.error} />
                                ) : (
                                    <>
                                        <Ionicons name="log-out-outline" size={18} color={T.error} />
                                        <Text style={styles.signOutText}>Sign Out</Text>
                                    </>
                                )}
                            </TouchableOpacity>
                        </ScrollView>
                    )}
                </View>
            </View>
        </Modal>
    );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionLabel({ text }: { text: string }) {
    return <Text style={styles.sectionLabel}>{text}</Text>;
}

function Card({ children }: { children: React.ReactNode }) {
    return <View style={styles.card}>{children}</View>;
}

function Row({
    icon,
    label,
    value,
    valueStyle,
}: { icon: string; label: string; value: string; valueStyle?: object }) {
    return (
        <View style={styles.row}>
            <Ionicons name={icon as any} size={17} color={T.textMuted} style={styles.rowIcon} />
            <View style={styles.rowBody}>
                <Text style={styles.rowLabel}>{label}</Text>
                <Text style={[styles.rowValue, valueStyle]} numberOfLines={3}>{value}</Text>
            </View>
        </View>
    );
}

function ToggleRow({
    icon,
    label,
    value,
    onChange,
}: { icon: string; label: string; value: boolean; onChange: (v: boolean) => void }) {
    return (
        <View style={styles.toggleRow}>
            <Ionicons name={icon as any} size={17} color={T.textMuted} style={styles.rowIcon} />
            <Text style={styles.toggleLabel}>{label}</Text>
            <Switch
                value={value}
                onValueChange={onChange}
                trackColor={{ false: T.border, true: T.primaryMid }}
                thumbColor={value ? T.primary : T.bgSurface}
                ios_backgroundColor={T.border}
            />
        </View>
    );
}

function PlaceholderRow({ icon, label }: { icon: string; label: string }) {
    return (
        <View style={styles.row}>
            <Ionicons name={icon as any} size={17} color={T.textMuted} style={styles.rowIcon} />
            <View style={styles.rowBody}>
                <Text style={styles.rowLabel}>{label}</Text>
                <Text style={styles.rowComingSoon}>Coming soon</Text>
            </View>
        </View>
    );
}

function Sep() {
    return <View style={styles.sep} />;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({

    // ── Layout ────────────────────────────────────────────────────────────────
    backdrop: {
        flex:            1,
        backgroundColor: 'rgba(0,0,0,0.45)',
        // column layout: backdropTap (flex:1) fills space above sheet; sheet sits below
    },
    backdropTap: {
        flex: 1,
    },
    sheet: {
        backgroundColor:      T.bgSurface,
        borderTopLeftRadius:  RADIUS.xxl,
        borderTopRightRadius: RADIUS.xxl,
        shadowColor:          '#000',
        shadowOffset:         { width: 0, height: -2 },
        shadowOpacity:        0.07,
        shadowRadius:         12,
        elevation:            10,
    },

    // ── Handle ────────────────────────────────────────────────────────────────
    handleRow: {
        alignItems:    'center',
        paddingTop:    12,
        paddingBottom: 6,
    },
    handle: {
        width:           40,
        height:          4,
        backgroundColor: T.border,
        borderRadius:    RADIUS.full,
    },

    // ── Header ────────────────────────────────────────────────────────────────
    header: {
        flexDirection:     'row',
        alignItems:        'center',
        justifyContent:    'space-between',
        paddingHorizontal: 20,
        paddingTop:        4,
        paddingBottom:     14,
    },
    title: {
        fontSize:      19,
        fontWeight:    '800',
        color:         T.textPrimary,
        letterSpacing: -0.4,
    },
    closeBtn: {
        width:           28,
        height:          28,
        borderRadius:    RADIUS.full,
        backgroundColor: T.bgAlt,
        alignItems:      'center',
        justifyContent:  'center',
    },

    // ── Loading ───────────────────────────────────────────────────────────────
    loadingBox: {
        flex:            1,
        alignItems:      'center',
        justifyContent:  'center',
        gap:             12,
    },
    loadingText: {
        fontSize:   14,
        color:      T.textMuted,
        fontWeight: '600',
    },

    // ── Scroll ────────────────────────────────────────────────────────────────
    scroll: {
        flex: 1,
    },
    scrollContent: {
        paddingHorizontal: 20,
    },

    // ── Section label ─────────────────────────────────────────────────────────
    sectionLabel: {
        fontSize:      11,
        fontWeight:    '700',
        color:         T.textMuted,
        textTransform: 'uppercase',
        letterSpacing: 0.8,
        marginTop:     20,
        marginBottom:  8,
    },

    // ── Card ──────────────────────────────────────────────────────────────────
    card: {
        backgroundColor: T.bgAlt,
        borderRadius:    RADIUS.xl,
        overflow:        'hidden',
    },

    // ── Row ───────────────────────────────────────────────────────────────────
    row: {
        flexDirection:     'row',
        alignItems:        'flex-start',
        paddingVertical:   12,
        paddingHorizontal: 16,
        gap:               12,
    },
    rowIcon: {
        marginTop: 1,
    },
    rowBody: {
        flex: 1,
    },
    rowLabel: {
        fontSize:     11,
        fontWeight:   '600',
        color:        T.textMuted,
        marginBottom: 2,
    },
    rowValue: {
        fontSize:   15,
        fontWeight: '500',
        color:      T.textPrimary,
        lineHeight: 20,
    },
    rowComingSoon: {
        fontSize:  13,
        color:     T.textMuted,
        fontStyle: 'italic',
    },

    // ── Toggle row ────────────────────────────────────────────────────────────
    toggleRow: {
        flexDirection:     'row',
        alignItems:        'center',
        paddingVertical:   11,
        paddingHorizontal: 16,
        gap:               12,
    },
    toggleLabel: {
        flex:       1,
        fontSize:   15,
        fontWeight: '500',
        color:      T.textPrimary,
    },

    // ── Push token banner ─────────────────────────────────────────────────────
    pushBanner: {
        flexDirection:     'row',
        alignItems:        'flex-start',
        paddingVertical:   10,
        paddingHorizontal: 16,
        gap:               7,
    },
    pushBannerIcon: {
        marginTop: 1,
    },
    pushBannerText: {
        flex:       1,
        fontSize:   12,
        color:      T.textMuted,
        lineHeight: 17,
    },

    // Value variants
    valCaregiver: { color: T.primary,  fontWeight: '700' },
    valRecipient: { color: T.success,  fontWeight: '700' },
    valConnected: { color: T.success,  fontWeight: '600' },

    // ── Separator ─────────────────────────────────────────────────────────────
    sep: {
        height:          1,
        backgroundColor: T.border,
        marginLeft:      45,
    },

    // ── Sign out ──────────────────────────────────────────────────────────────
    signOutBtn: {
        flexDirection:   'row',
        alignItems:      'center',
        justifyContent:  'center',
        gap:             8,
        marginTop:       20,
        paddingVertical: 14,
        borderRadius:    RADIUS.xl,
        backgroundColor: '#FEF2F2',
        borderWidth:     1.5,
        borderColor:     '#FECACA',
    },
    signOutDisabled: {
        opacity: 0.55,
    },
    signOutText: {
        fontSize:   15,
        fontWeight: '700',
        color:      T.error,
    },
});
