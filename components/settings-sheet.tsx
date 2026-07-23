import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
    ActivityIndicator,
    Dimensions,
    Linking,
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

import { RADIUS, ThemeColors } from '@/constants/theme';
import { useLanguage } from '@/lib/i18n/context';
import { LanguageMode } from '@/lib/i18n/storage';
import { registerPushToken } from '@/lib/notifications';
import { supabase } from '@/lib/supabase';
import { syncCurrentUserTimezone } from '@/lib/timezone';
import { AppearanceMode, useThemeColors, useThemeMode } from '@/lib/theme';

// ─── Constants ────────────────────────────────────────────────────────────────

const SCREEN_HEIGHT = Dimensions.get('window').height;
const SHEET_HEIGHT  = Math.round(SCREEN_HEIGHT * 0.85);

const HELP_URL    = 'https://sites.google.com/view/tavora-help';
const PRIVACY_URL = 'https://sites.google.com/view/tavora-privacy';

const APPEARANCE_OPTIONS: { value: AppearanceMode; labelKey: string; icon: string }[] = [
    { value: 'system', labelKey: 'settings.appearanceSystem', icon: 'phone-portrait-outline' },
    { value: 'light',  labelKey: 'settings.appearanceLight',  icon: 'sunny-outline' },
    { value: 'dark',   labelKey: 'settings.appearanceDark',   icon: 'moon-outline' },
];

const LANGUAGE_OPTIONS: { value: LanguageMode; labelKey: string; icon: string }[] = [
    { value: 'system', labelKey: 'settings.languageSystem',  icon: 'phone-portrait-outline' },
    { value: 'en',     labelKey: 'settings.languageEnglish', icon: 'globe-outline' },
    { value: 'es',     labelKey: 'settings.languageSpanish', icon: 'globe-outline' },
];

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
    const C = useThemeColors();
    const styles = useMemo(() => createStyles(C), [C]);
    const { mode: appearanceMode, setMode: setAppearanceMode } = useThemeMode();
    const { languageMode, setLanguageMode, t } = useLanguage();

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
        let connectionStatus = t('settings.noConnection');
        let connectionOk     = false;

        if (role === 'caregiver') {
            const { data: accepted } = await supabase
                .from('connections')
                .select('recipient_id')
                .eq('caregiver_id', user.id)
                .eq('status', 'accepted')
                .not('recipient_id', 'is', null);

            const acceptedRecipientIds = (accepted ?? [])
                .map((c) => c.recipient_id)
                .filter((id): id is string => !!id);

            if (acceptedRecipientIds.length > 0) {
                const { data: recipientProfiles } = await supabase
                    .from('profiles')
                    .select('full_name')
                    .in('id', acceptedRecipientIds);

                const names = (recipientProfiles ?? []).map((p) => p.full_name).filter(Boolean);
                connectionStatus =
                    names.length === 1
                        ? t('settings.connectedToOne', { name: names[0] })
                        : t('settings.connectedToMany', { count: names.length });
                connectionOk = true;
            } else {
                const { data: pending } = await supabase
                    .from('connections')
                    .select('id')
                    .eq('caregiver_id', user.id)
                    .eq('status', 'pending')
                    .limit(1)
                    .maybeSingle();
                connectionStatus = pending
                    ? t('settings.pendingConnection')
                    : t('settings.noParticipantConnected');
            }

            setUserId(user.id);
            // Load notification prefs (awaited — content waits for prefs before showing)
            await loadNotifPrefs(user.id);
            // Register push token in background — don't block the sheet from opening
            registerPushToken(user.id).then(result => {
                if (!result.ok) setPushTokenMsg(result.message);
            });

        } else if (role === 'recipient') {
            // Idempotent — safe alongside recipient-dashboard's own
            // registration on mount, and covers a recipient who opens
            // settings before the dashboard has had a chance to.
            syncCurrentUserTimezone().catch(() => {});
            registerPushToken(user.id).catch(() => {});

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
                connectionStatus = t('settings.connectedToOne', {
                    name: caregiverProfile?.full_name ?? t('settings.organizerRole'),
                });
                connectionOk     = true;
            } else {
                connectionStatus = t('settings.noOrganizerConnected');
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
        const { data, error } = await supabase
            .from('notification_preferences')
            .select('notify_missed, notify_skipped, notify_snoozed, notify_taken')
            .eq('caregiver_id', uid)
            .maybeSingle();

        if (error) {
            console.warn('[settings] notification prefs fetch failed:', error.message);
        }

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
        profile.role === 'caregiver' ? t('settings.organizerRole')
        : profile.role === 'recipient' ? t('settings.participantRole')
        : profile.role;

    function getInitials(name: string): string {
        const parts = name.split(' ').filter(Boolean);
        if (parts.length === 0) return '?';
        return parts.slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('');
    }

    // ── Sub-components (closures — need the live C/styles above) ─────────────

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
                <Ionicons name={icon as any} size={17} color={C.textMuted} style={styles.rowIcon} />
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
                <Ionicons name={icon as any} size={17} color={C.textMuted} style={styles.rowIcon} />
                <Text style={styles.toggleLabel}>{label}</Text>
                <Switch
                    value={value}
                    onValueChange={onChange}
                    trackColor={{ false: C.border, true: C.primaryMid }}
                    thumbColor={value ? C.primary : C.bgSurface}
                    ios_backgroundColor={C.border}
                />
            </View>
        );
    }

    function LinkRow({
        icon,
        label,
        caption,
        onPress,
    }: { icon: string; label: string; caption: string; onPress: () => void }) {
        return (
            <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.6}>
                <Ionicons name={icon as any} size={17} color={C.textMuted} style={styles.rowIcon} />
                <View style={styles.rowBody}>
                    <Text style={styles.rowLabel}>{label}</Text>
                    <Text style={styles.rowCaption}>{caption}</Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={C.textMuted} />
            </TouchableOpacity>
        );
    }

    function Sep() {
        return <View style={styles.sep} />;
    }

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
                        <Text style={styles.title}>{t('settings.title')}</Text>
                        <TouchableOpacity
                            style={styles.closeBtn}
                            onPress={onClose}
                            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                        >
                            <Ionicons name="close" size={18} color={C.textSecondary} />
                        </TouchableOpacity>
                    </View>

                    {/* Content */}
                    {loading ? (
                        <View style={styles.loadingBox}>
                            <ActivityIndicator color={C.primary} />
                            <Text style={styles.loadingText}>{t('settings.loadingProfile')}</Text>
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
                            {/* ── Profile hero ───────────────────────────────── */}
                            <View style={styles.profileHero}>
                                <View style={[
                                    styles.avatarCircle,
                                    { backgroundColor: profile.role === 'caregiver' ? C.primary : C.success },
                                ]}>
                                    <Text style={styles.avatarInitials}>{getInitials(profile.fullName)}</Text>
                                </View>
                                <Text style={styles.avatarName}>{profile.fullName}</Text>
                                <View style={[
                                    styles.avatarRolePill,
                                    { backgroundColor: profile.role === 'caregiver' ? C.primaryLight : C.successLight },
                                ]}>
                                    <Text style={[
                                        styles.avatarRoleText,
                                        { color: profile.role === 'caregiver' ? C.primary : C.success },
                                    ]}>
                                        {roleLabel}
                                    </Text>
                                </View>
                            </View>

                            {/* ── Profile ────────────────────────────────────── */}
                            <SectionLabel text={t('settings.sectionProfile')} />
                            <Card>
                                <Row
                                    icon="person-outline"
                                    label={t('settings.nameLabel')}
                                    value={profile.fullName}
                                />
                                <Sep />
                                <Row
                                    icon="mail-outline"
                                    label={t('settings.emailLabel')}
                                    value={profile.email}
                                />
                                <Sep />
                                <Row
                                    icon="shield-checkmark-outline"
                                    label={t('settings.roleLabel')}
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
                                    label={t('settings.connectionLabel')}
                                    value={profile.connectionStatus}
                                    valueStyle={profile.connectionOk ? styles.valConnected : undefined}
                                />
                            </Card>

                            {/* ── Notifications (caregiver) ── */}
                            {profile.role === 'caregiver' ? (
                                <>
                                    <SectionLabel text={t('settings.sectionNotifications')} />
                                    <Card>
                                        <ToggleRow
                                            icon="alert-circle-outline"
                                            label={t('settings.notifyMissed')}
                                            value={notifPrefs?.notify_missed ?? true}
                                            onChange={v => updateNotifPref('notify_missed', v)}
                                        />
                                        <Sep />
                                        <ToggleRow
                                            icon="ban-outline"
                                            label={t('settings.notifySkipped')}
                                            value={notifPrefs?.notify_skipped ?? true}
                                            onChange={v => updateNotifPref('notify_skipped', v)}
                                        />
                                        <Sep />
                                        <ToggleRow
                                            icon="time-outline"
                                            label={t('settings.notifySnoozed')}
                                            value={notifPrefs?.notify_snoozed ?? false}
                                            onChange={v => updateNotifPref('notify_snoozed', v)}
                                        />
                                        <Sep />
                                        <ToggleRow
                                            icon="checkmark-circle-outline"
                                            label={t('settings.notifyCompleted')}
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
                                                        color={C.textMuted}
                                                        style={styles.pushBannerIcon}
                                                    />
                                                    <Text style={styles.pushBannerText}>{pushTokenMsg}</Text>
                                                </View>
                                            </>
                                        ) : null}
                                    </Card>
                                </>
                            ) : null}

                            {/* ── Appearance ─────────────────────────────────── */}
                            <SectionLabel text={t('settings.sectionAppearance')} />
                            <Card>
                                <View style={styles.appearanceRow}>
                                    {APPEARANCE_OPTIONS.map((option) => {
                                        const active = appearanceMode === option.value;
                                        return (
                                            <TouchableOpacity
                                                key={option.value}
                                                style={[styles.appearanceChip, active && styles.appearanceChipActive]}
                                                onPress={() => setAppearanceMode(option.value)}
                                                activeOpacity={0.75}
                                            >
                                                <Ionicons
                                                    name={option.icon as any}
                                                    size={16}
                                                    color={active ? C.primary : C.textMuted}
                                                />
                                                <Text style={[styles.appearanceChipText, active && styles.appearanceChipTextActive]}>
                                                    {t(option.labelKey)}
                                                </Text>
                                            </TouchableOpacity>
                                        );
                                    })}
                                </View>
                            </Card>

                            {/* ── Language ───────────────────────────────────── */}
                            <SectionLabel text={t('settings.sectionLanguage')} />
                            <Card>
                                <View style={styles.appearanceRow}>
                                    {LANGUAGE_OPTIONS.map((option) => {
                                        const active = languageMode === option.value;
                                        return (
                                            <TouchableOpacity
                                                key={option.value}
                                                style={[styles.appearanceChip, active && styles.appearanceChipActive]}
                                                onPress={() => setLanguageMode(option.value)}
                                                activeOpacity={0.75}
                                            >
                                                <Ionicons
                                                    name={option.icon as any}
                                                    size={16}
                                                    color={active ? C.primary : C.textMuted}
                                                />
                                                <Text style={[styles.appearanceChipText, active && styles.appearanceChipTextActive]}>
                                                    {t(option.labelKey)}
                                                </Text>
                                            </TouchableOpacity>
                                        );
                                    })}
                                </View>
                            </Card>

                            {/* ── Support ────────────────────────────────────── */}
                            <SectionLabel text={t('settings.sectionSupport')} />
                            <Card>
                                <LinkRow
                                    icon="help-circle-outline"
                                    label={t('settings.helpLabel')}
                                    caption={t('settings.helpCaption')}
                                    onPress={() => Linking.openURL(HELP_URL)}
                                />
                                <Sep />
                                <LinkRow
                                    icon="lock-closed-outline"
                                    label={t('settings.privacyLabel')}
                                    caption={t('settings.privacyCaption')}
                                    onPress={() => Linking.openURL(PRIVACY_URL)}
                                />
                            </Card>

                            {/* ── Account ────────────────────────────────────── */}
                            <SectionLabel text={t('settings.sectionAccount')} />
                            <Card>
                                <LinkRow
                                    icon="trash-outline"
                                    label={t('settings.deleteAccountLabel')}
                                    caption={t('settings.deleteAccountCaption')}
                                    onPress={() => {
                                        onClose();
                                        router.push('/delete-account');
                                    }}
                                />
                            </Card>

                            {/* ── Sign out ───────────────────────────────────── */}
                            <TouchableOpacity
                                style={[styles.signOutBtn, signingOut && styles.signOutDisabled]}
                                onPress={handleSignOut}
                                disabled={signingOut}
                                activeOpacity={0.8}
                            >
                                {signingOut ? (
                                    <ActivityIndicator color={C.error} />
                                ) : (
                                    <>
                                        <Ionicons name="log-out-outline" size={18} color={C.error} />
                                        <Text style={styles.signOutText}>{t('settings.signOut')}</Text>
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

// ─── Styles ───────────────────────────────────────────────────────────────────

const createStyles = (C: ThemeColors) => StyleSheet.create({

    // ── Profile hero ─────────────────────────────────────────────────────────
    profileHero: {
        alignItems:    'center',
        paddingTop:    8,
        paddingBottom: 4,
    },
    avatarCircle: {
        width:           64,
        height:          64,
        borderRadius:    RADIUS.full,
        justifyContent:  'center',
        alignItems:      'center',
        marginBottom:    10,
    },
    avatarInitials: {
        fontSize:      24,
        fontWeight:    '700',
        color:         '#FFFFFF',
        letterSpacing: 0.5,
    },
    avatarName: {
        fontSize:      18,
        fontWeight:    '700',
        color:         C.textPrimary,
        letterSpacing: -0.3,
        marginBottom:  6,
        textAlign:     'center',
    },
    avatarRolePill: {
        paddingHorizontal: 12,
        paddingVertical:   4,
        borderRadius:      RADIUS.full,
    },
    avatarRoleText: {
        fontSize:   12,
        fontWeight: '700',
        letterSpacing: 0.3,
    },

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
        backgroundColor:      C.bgSurface,
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
        backgroundColor: C.border,
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
        color:         C.textPrimary,
        letterSpacing: -0.4,
    },
    closeBtn: {
        width:           28,
        height:          28,
        borderRadius:    RADIUS.full,
        backgroundColor: C.bgAlt,
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
        color:      C.textMuted,
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
        color:         C.textMuted,
        textTransform: 'uppercase',
        letterSpacing: 0.8,
        marginTop:     20,
        marginBottom:  8,
    },

    // ── Card ──────────────────────────────────────────────────────────────────
    card: {
        backgroundColor: C.bgAlt,
        borderRadius:    RADIUS.xl,
        overflow:        'hidden',
    },

    // ── Appearance ────────────────────────────────────────────────────────────
    appearanceRow: {
        flexDirection: 'row',
        padding:       6,
        gap:           6,
    },
    appearanceChip: {
        flex:              1,
        flexDirection:     'row',
        alignItems:        'center',
        justifyContent:    'center',
        gap:               6,
        paddingVertical:   10,
        borderRadius:      RADIUS.lg,
    },
    appearanceChipActive: {
        backgroundColor: C.bgSurface,
    },
    appearanceChipText: {
        fontSize:   13,
        fontWeight: '600',
        color:      C.textMuted,
    },
    appearanceChipTextActive: {
        color:      C.primary,
        fontWeight: '700',
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
        color:        C.textMuted,
        marginBottom: 2,
    },
    rowValue: {
        fontSize:   15,
        fontWeight: '500',
        color:      C.textPrimary,
        lineHeight: 20,
    },
    rowCaption: {
        fontSize: 13,
        color:    C.textMuted,
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
        color:      C.textPrimary,
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
        color:      C.textMuted,
        lineHeight: 17,
    },

    // Value variants
    valCaregiver: { color: C.primary,  fontWeight: '700' },
    valRecipient: { color: C.success,  fontWeight: '700' },
    valConnected: { color: C.success,  fontWeight: '600' },

    // ── Separator ─────────────────────────────────────────────────────────────
    sep: {
        height:          1,
        backgroundColor: C.border,
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
        backgroundColor: C.errorLight,
        borderWidth:     1.5,
        borderColor:     C.error,
    },
    signOutDisabled: {
        opacity: 0.55,
    },
    signOutText: {
        fontSize:   15,
        fontWeight: '700',
        color:      C.error,
    },
});
