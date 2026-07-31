import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    AppState,
    Platform,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { OfflineBanner, SectionErrorState, announceStateChange } from '@/components/StateViews';
import { SettingsSheet } from '@/components/settings-sheet';
import { TasksSummaryCard } from '@/components/TasksSummaryCard';
import { ActivityPreviewCard } from '@/components/ActivityPreviewCard';
import { RADIUS, SHADOW, SPACING, ThemeColors } from '@/constants/theme';
import { clearAccountScopedLocalState } from '@/lib/accountCleanup';
import { showAlertOnce } from '@/lib/alertGuard';
import { classifyScreenError, ErrorCategory } from '@/lib/asyncStateCore';
import { categorizeConnection } from '@/lib/connectionStateCore';
import { ERROR_CATEGORY_TRANSLATION_KEYS } from '@/lib/errorClassification';
import { buildFrequencyLabels, formatFrequency as formatFrequencyDays } from '@/lib/frequency';
import { useStatusLabel, useTranslation } from '@/lib/i18n/context';
import { MAX_STANDARD_PARTICIPANTS } from '@/lib/limits';
import { registerPushToken } from '@/lib/notifications';
import { getRoleLabelKeys, isUseCase, UseCase } from '@/lib/onboarding';
import { getZonedComputedStatus, isoWeekdayOfDateString, isReminderEligibleOnZonedDate } from '@/lib/reminderStatus';
import { getStoredSelectedConnectionId, setStoredSelectedConnectionId } from '@/lib/selected-participant';
import { supabase } from '@/lib/supabase';
import { useThemeColors } from '@/lib/theme';
import { isValidIanaTimezone } from '@/lib/timezone';
import { getZonedTodayString } from '@/lib/zonedTime';

// ─── Types ────────────────────────────────────────────────────────────────────

type ReminderStatus = 'pending' | 'taken' | 'snoozed' | 'skipped' | 'missed';

type Reminder = {
    id: string;
    connection_id: string;
    caregiver_id: string;
    recipient_id: string;
    title: string;
    reminder_type: string;
    notes: string | null;
    time_of_day: string;
    frequency: 'daily' | 'weekdays' | 'weekends' | 'custom';
    days_of_week: number[];
    no_response_minutes: number;
    created_at: string;
    is_active: boolean;
    updated_at: string;
};

type ReminderLog = {
    reminder_id: string;
    occurrence_date: string;
    status: ReminderStatus;
    completed_at: string | null;
    snoozed_until: string | null;
};

type ReminderDisplay = {
    id: string;
    name: string;
    time: string;
    status: ReminderStatus;
    isActive: boolean;
};

type DayData = {
    dateString: string;
    dateLabel: string;
    shortLabel: string;
    monthDay: number;
    scheduledCount: number;
    eligibleCount: number;
    countableCount: number;
    takenCount: number;
    pendingCount: number;
    missedCount: number;
    skippedCount: number;
    snoozedCount: number;
    adherence: number;
    hasData: boolean;
    isFuture: boolean;
    reminders: ReminderDisplay[];
};

type ReminderBreakdownItem = {
    id: string;
    name: string;
    time_of_day: string;
    frequency: 'daily' | 'weekdays' | 'weekends' | 'custom';
    days_of_week: number[];
    completed: number;
    scheduled: number;
    missed: number;
    skipped: number;
    snoozed: number;
    pending: number;
    adherence: number;
    isActive: boolean;
};

type ConnectionSummary = {
    id: string;
    status: 'none' | 'pending' | 'accepted';
    inviteCode?: string;
    recipientName?: string;
    acceptedAt?: string;
    recipientId?: string;
};

type RangeStats = { adherence: number | null; countable: number; taken: number };

const RANGE_LABEL_KEYS: Record<'Today' | 'Week' | 'Month', string> = {
    Today: 'organizerDashboard.rangeToday',
    Week:  'organizerDashboard.rangeWeek',
    Month: 'organizerDashboard.rangeMonth',
};

// ─── Pure date helpers ────────────────────────────────────────────────────────

function getLocalDateString(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function getStartOfWeek(date: Date): Date {
    const s = new Date(date);
    s.setHours(0, 0, 0, 0);
    s.setDate(s.getDate() - s.getDay());
    return s;
}

function addDays(date: Date, n: number): Date {
    const next = new Date(date);
    next.setDate(next.getDate() + n);
    return next;
}

function getMonthDates(date: Date): Date[] {
    const year = date.getFullYear();
    const month = date.getMonth();
    const days = new Date(year, month + 1, 0).getDate();
    return Array.from({ length: days }, (_, i) => new Date(year, month, i + 1));
}

function formatDateLabel(date: Date): string {
    return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
}

function formatShortDay(date: Date): string {
    return date.toLocaleDateString(undefined, { weekday: 'short' });
}

function formatTime(time: string): string {
    const [hStr, mStr] = time.split(':');
    let h = Number(hStr);
    const suffix = h >= 12 ? 'PM' : 'AM';
    if (h === 0) h = 12;
    else if (h > 12) h -= 12;
    return `${h}:${mStr} ${suffix}`;
}

// ─── Analytics helpers ────────────────────────────────────────────────────────
// Recipient-timezone-aware eligibility/status functions
// (isReminderEligibleOnZonedDate / getZonedComputedStatus /
// isoWeekdayOfDateString / getZonedTodayString) live in
// lib/reminderStatus.ts / lib/zonedTime.ts — see those files' header
// comments. Week 1 task #8: this screen previously used the CAREGIVER's
// own device clock to decide a connected recipient's reminder status,
// which could disagree with the recipient's (and the server's) view in a
// different timezone.

function buildDayData(
    date: Date,
    reminders: Reminder[],
    logs: ReminderLog[],
    connectionAcceptedAt: string,
    recipientTimeZone: string
): DayData {
    // The calendar date itself is derived in the RECIPIENT's timezone, not
    // the caregiver device's — see lib/reminderStatus.ts's zoned-variant
    // header comment. `date` is still device-local for iteration purposes
    // (constructing "each day of this month" is timezone-agnostic
    // calendar-day arithmetic), but every *interpretation* of it (which
    // weekday, whether it's today/future, whether the response window has
    // passed) goes through the zoned helpers below.
    const dateString  = getLocalDateString(date);
    const todayString = getZonedTodayString(recipientTimeZone);
    const isFuture    = dateString > todayString;

    const scheduledReminders = reminders.filter((r) => r.days_of_week.includes(isoWeekdayOfDateString(dateString)));
    const eligibleReminders  = scheduledReminders.filter((r) => {
        const hasLogOnDate = logs.some(
            (l) => l.reminder_id === r.id && l.occurrence_date === dateString
        );
        return isReminderEligibleOnZonedDate(r, dateString, recipientTimeZone, connectionAcceptedAt, hasLogOnDate);
    });

    const reminderDisplays: ReminderDisplay[] = eligibleReminders.map((reminder) => {
        const log = logs.find(
            (l) => l.reminder_id === reminder.id && l.occurrence_date === dateString
        );
        return {
            id:       reminder.id,
            name:     reminder.title,
            time:     formatTime(reminder.time_of_day),
            status:   getZonedComputedStatus(reminder, dateString, todayString, recipientTimeZone, log),
            isActive: reminder.is_active,
        };
    });

    const takenCount    = reminderDisplays.filter((r) => r.status === 'taken').length;
    const pendingCount  = reminderDisplays.filter((r) => r.status === 'pending').length;
    const missedCount   = reminderDisplays.filter((r) => r.status === 'missed').length;
    const skippedCount  = reminderDisplays.filter((r) => r.status === 'skipped').length;
    const snoozedCount  = reminderDisplays.filter((r) => r.status === 'snoozed').length;
    const countableCount = reminderDisplays.filter((r) => r.status !== 'pending').length;
    const adherence     = countableCount === 0 ? 0 : Math.round((takenCount / countableCount) * 100);

    return {
        dateString,
        dateLabel:     formatDateLabel(date),
        shortLabel:    formatShortDay(date),
        monthDay:      date.getDate(),
        scheduledCount: scheduledReminders.length,
        eligibleCount:  eligibleReminders.length,
        countableCount,
        takenCount,
        pendingCount,
        missedCount,
        skippedCount,
        snoozedCount,
        adherence,
        hasData: eligibleReminders.length > 0,
        isFuture,
        reminders: reminderDisplays,
    };
}

function getRangeStats(days: DayData[], recipientTimeZone: string): RangeStats {
    const todayString = getZonedTodayString(recipientTimeZone);
    const past        = days.filter((d) => d.dateString <= todayString);
    const countable   = past.reduce((s, d) => s + d.countableCount, 0);
    const taken       = past.reduce((s, d) => s + d.takenCount, 0);
    return {
        adherence: countable === 0 ? null : Math.round((taken / countable) * 100),
        countable,
        taken,
    };
}

function buildReminderBreakdown(
    reminders: Reminder[],
    logs: ReminderLog[],
    monthDates: Date[],
    connectionAcceptedAt: string,
    recipientTimeZone: string
): ReminderBreakdownItem[] {
    const todayString = getZonedTodayString(recipientTimeZone);
    // Deleted/inactive reminders keep contributing their past logs to
    // analytics (via isReminderEligibleOnZonedDate below), but must not
    // appear as cards in the active reminder breakdown.
    return reminders.filter((reminder) => reminder.is_active).map((reminder) => {
        let scheduled = 0, completed = 0, missed = 0, skipped = 0, snoozed = 0, pending = 0;
        monthDates.forEach((date) => {
            const dateString = getLocalDateString(date);
            if (dateString > todayString) return;
            const log = logs.find((l) => l.reminder_id === reminder.id && l.occurrence_date === dateString);
            if (!isReminderEligibleOnZonedDate(reminder, dateString, recipientTimeZone, connectionAcceptedAt, !!log)) return;
            const status = getZonedComputedStatus(reminder, dateString, todayString, recipientTimeZone, log);
            if (status === 'pending') { pending += 1; return; }
            scheduled += 1;
            if (status === 'taken')   completed += 1;
            if (status === 'missed')  missed    += 1;
            if (status === 'skipped') skipped   += 1;
            if (status === 'snoozed') snoozed   += 1;
        });
        return {
            id: reminder.id,
            name: reminder.title,
            time_of_day: reminder.time_of_day,
            frequency: reminder.frequency,
            days_of_week: reminder.days_of_week,
            completed,
            scheduled,
            missed,
            skipped,
            snoozed,
            pending,
            adherence: scheduled === 0 ? 0 : Math.round((completed / scheduled) * 100),
            isActive: reminder.is_active,
        };
    });
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function CaregiverDashboard() {
    const C = useThemeColors();
    const t = useTranslation();
    const formatStatus = useStatusLabel();
    const styles = useMemo(() => createStyles(C), [C]);

    function getAdherenceColor(pct: number | null): string {
        if (pct === null) return C.textMuted;
        if (pct >= 80) return C.success;
        if (pct >= 50) return '#D97706';
        return C.error;
    }

    function getStatusPillStyle(status: ReminderStatus) {
        if (status === 'taken')   return styles.takenPill;
        if (status === 'missed')  return styles.missedPill;
        if (status === 'skipped') return styles.skippedPill;
        if (status === 'snoozed') return styles.snoozedPill;
        return styles.pendingPill;
    }

    function getStatusTextStyle(status: ReminderStatus) {
        if (status === 'taken')   return styles.takenText;
        if (status === 'missed')  return styles.missedText;
        if (status === 'skipped') return styles.skippedText;
        if (status === 'snoozed') return styles.snoozedText;
        return styles.pendingText;
    }

    function getHeatmapStyle(day: DayData) {
        // Defensive only — renderAnalytics() never reaches the heatmap
        // JSX that calls this without a confirmed-valid recipientTimeZone.
        if (!recipientTimeZone) return styles.heatmapNoData;
        const todayString = getZonedTodayString(recipientTimeZone);
        if (day.dateString > todayString) return styles.heatmapFuture;
        if (!day.hasData) return styles.heatmapNoData;
        if (day.countableCount === 0 && day.pendingCount > 0) return styles.heatmapPending;
        if (day.countableCount === 0) return styles.heatmapEmpty;
        if (day.adherence === 100) return styles.heatmapHigh;
        if (day.adherence >= 75)   return styles.heatmapMedium;
        if (day.adherence >= 50)   return styles.heatmapLow;
        return styles.heatmapMissed;
    }

    function getBarColor(day: DayData): string {
        if (!day.hasData || day.isFuture) return C.border;
        if (day.countableCount === 0)     return C.primaryMid;
        return getAdherenceColor(day.adherence);
    }

    function getBarHeight(day: DayData): string {
        if (!day.hasData || day.isFuture) return '8%';
        if (day.countableCount === 0)     return '10%';
        return `${Math.max(day.adherence, 6)}%`;
    }

    // The bar chart and month heatmap otherwise communicate a day's status
    // purely through bar height/background color — this is the textual
    // equivalent VoiceOver needs (PHASE 12), read once per cell rather than
    // requiring a user to separately open the day-detail card just to know
    // what happened that day.
    function dayAccessibilitySummary(day: DayData): string {
        if (day.isFuture) return `${day.dateLabel}, upcoming`;
        if (!day.hasData) return `${day.dateLabel}, no reminders scheduled`;
        if (day.countableCount === 0 && day.pendingCount > 0) return `${day.dateLabel}, ${day.pendingCount} pending, no results yet`;
        if (day.countableCount === 0) return `${day.dateLabel}, no data`;
        return `${day.dateLabel}, ${day.adherence}% adherence, ${day.takenCount} taken, ${day.missedCount} missed, ${day.skippedCount} skipped, ${day.snoozedCount} snoozed, ${day.pendingCount} pending`;
    }

    function ReminderRow({ reminder }: { reminder: ReminderDisplay }) {
        return (
            <View style={[styles.reminderRow, !reminder.isActive && styles.reminderRowInactive]}>
                <View style={[styles.reminderStatusBar, getStatusPillStyle(reminder.status)]} />
                <View style={styles.reminderTextBlock}>
                    <View style={styles.reminderNameRow}>
                        <Text style={styles.reminderName}>{reminder.name}</Text>
                        {!reminder.isActive && (
                            <View style={styles.inactiveTag}>
                                <Text style={styles.inactiveTagText}>{t('organizerDashboard.deleted')}</Text>
                            </View>
                        )}
                    </View>
                    <Text style={styles.reminderTime}>{reminder.time}</Text>
                </View>
                <View style={[styles.statusPill, getStatusPillStyle(reminder.status)]}>
                    <Text style={[styles.statusText, getStatusTextStyle(reminder.status)]}>
                        {formatStatus(reminder.status)}
                    </Text>
                </View>
            </View>
        );
    }

    function MetricTile({ count, label, color, bg }: { count: number; label: string; color: string; bg: string }) {
        return (
            <View style={[styles.metricTile, { backgroundColor: bg }]}>
                <Text style={[styles.metricTileCount, { color }]}>{count}</Text>
                <Text style={[styles.metricTileLabel, { color }]}>{label}</Text>
            </View>
        );
    }

    function BreakdownCard({ item }: { item: ReminderBreakdownItem }) {
        const hasCountable   = item.scheduled > 0;
        const adherenceColor = hasCountable ? getAdherenceColor(item.adherence) : C.textMuted;

        const chips = [
            item.completed > 0 ? { label: t('organizerDashboard.chipCompleted', { n: item.completed }), bg: '#DCFCE7', color: '#15803D' } : null,
            item.missed    > 0 ? { label: t('organizerDashboard.chipMissed', { n: item.missed }),     bg: '#FEE2E2', color: '#B91C1C' } : null,
            item.skipped   > 0 ? { label: t('organizerDashboard.chipSkipped', { n: item.skipped }),   bg: '#FEF3C7', color: '#B45309' } : null,
            item.snoozed   > 0 ? { label: t('organizerDashboard.chipSnoozed', { n: item.snoozed }),   bg: '#DBEAFE', color: '#1D4ED8' } : null,
            item.pending   > 0 ? { label: t('organizerDashboard.chipPending', { n: item.pending }),   bg: C.bgAlt,   color: C.textMuted } : null,
        ].filter(Boolean) as { label: string; bg: string; color: string }[];

        let summaryText: string;
        if (!hasCountable && item.pending === 0) {
            summaryText = t('organizerDashboard.noCountableHistory');
        } else if (!hasCountable) {
            summaryText = t('organizerDashboard.pendingNoPastData', { n: item.pending });
        } else if (item.adherence === 100) {
            summaryText = t('organizerDashboard.takenOfScheduled', { completed: item.completed, scheduled: item.scheduled });
        } else if (item.missed > 0 && item.pending > 0) {
            summaryText = t('organizerDashboard.missedAndPending', { missed: item.missed, pending: item.pending });
        } else if (item.missed > 0) {
            summaryText = t('organizerDashboard.missedThisMonth', { n: item.missed });
        } else if (item.pending > 0) {
            summaryText = t('organizerDashboard.pendingToday', { n: item.pending });
        } else {
            summaryText = t('organizerDashboard.takenOfScheduled', { completed: item.completed, scheduled: item.scheduled });
        }

        const cardLabel = `${item.name}${!item.isActive ? `, ${t('organizerDashboard.deleted')}` : ''}, ${hasCountable ? `${item.adherence}% ${t('organizerDashboard.adherence')}` : t('organizerDashboard.adherence')}, ${summaryText}`;

        return (
            <TouchableOpacity
                style={[styles.bcCard, SHADOW.xs]}
                onPress={() =>
                    router.push({ pathname: '/reminder-details', params: { reminderId: item.id } })
                }
                activeOpacity={0.75}
                accessibilityRole="button"
                accessibilityLabel={cardLabel}
                accessibilityHint={t('organizerDashboard.details')}
            >
                <View style={styles.bcHeader}>
                    <View style={{ flex: 1 }}>
                        <View style={styles.bcNameRow}>
                            <Text style={styles.bcName} numberOfLines={1}>{item.name}</Text>
                            {!item.isActive && (
                                <View style={styles.bcDeletedPill}>
                                    <Text style={styles.bcDeletedText}>{t('organizerDashboard.deleted')}</Text>
                                </View>
                            )}
                        </View>
                        <Text style={styles.bcMeta}>
                            {item.isActive
                                ? `${formatTime(item.time_of_day)} · ${formatFrequencyDays(item.frequency, item.days_of_week, buildFrequencyLabels(t))}`
                                : t('organizerDashboard.noLongerScheduled')}
                        </Text>
                    </View>
                    <View style={styles.bcAdherenceBlock}>
                        <Text style={[styles.bcAdherencePct, { color: adherenceColor }]}>
                            {hasCountable ? `${item.adherence}%` : '—'}
                        </Text>
                        <Text style={styles.bcAdherenceLabel}>{t('organizerDashboard.adherence')}</Text>
                    </View>
                </View>

                {hasCountable && (
                    <>
                        <View style={styles.bcProgressTrack}>
                            <View
                                style={[
                                    styles.bcProgressFill,
                                    { width: `${item.adherence}%`, backgroundColor: adherenceColor },
                                ]}
                            />
                        </View>
                        <Text style={styles.bcCountLine}>
                            {t('organizerDashboard.countableScheduled', { completed: item.completed, scheduled: item.scheduled })}
                        </Text>
                    </>
                )}

                {chips.length > 0 && (
                    <View style={styles.bcChips}>
                        {chips.map((chip) => (
                            <View key={chip.label} style={[styles.bcChip, { backgroundColor: chip.bg }]}>
                                <Text style={[styles.bcChipText, { color: chip.color }]}>{chip.label}</Text>
                            </View>
                        ))}
                    </View>
                )}

                <View style={styles.bcFooter}>
                    <Text style={styles.bcSummary}>{summaryText}</Text>
                    <View style={styles.bcCta}>
                        <Text style={styles.bcCtaText}>{t('organizerDashboard.details')}</Text>
                        <Ionicons name="chevron-forward" size={13} color={C.primary} />
                    </View>
                </View>
            </TouchableOpacity>
        );
    }

    const [selectedRange, setSelectedRange]         = useState<'Today' | 'Week' | 'Month'>('Today');
    const [selectedWeekIndex, setSelectedWeekIndex] = useState(new Date().getDay());
    const [selectedMonthIndex, setSelectedMonthIndex] = useState(new Date().getDate() - 1);

    const [connectionLoading, setConnectionLoading] = useState(true);
    const [dashboardLoading, setDashboardLoading]   = useState(true);
    // Set on a genuine fetch failure (connections, reminders, or logs) —
    // rendered as a compact, retryable SectionErrorState that never
    // replaces the rest of the dashboard (PHASE 4: "if reminders load but
    // analytics fail, show reminders, show an analytics error with retry,
    // don't replace the entire dashboard"). Cleared at the start of every
    // load attempt.
    const [connectionsError, setConnectionsError] = useState<ErrorCategory | null>(null);
    const [reminderDataError, setReminderDataError] = useState<ErrorCategory | null>(null);
    // True only when reminders themselves loaded but the logs (analytics/
    // history) query failed — today's reminders still render normally,
    // just with a narrower "analytics unavailable" notice near the
    // breakdown/history sections instead of losing the whole screen.
    const [analyticsOnlyError, setAnalyticsOnlyError] = useState(false);
    // Reset on every fresh loadDashboardData() call so a dismissed banner
    // reappears on the next failed request rather than staying hidden for
    // the rest of the session while still genuinely offline.
    const [offlineDismissed, setOfflineDismissed] = useState(false);
    const hasLoadedParticipantsOnceRef = useRef(false);
    // Distinct from hasLoadedParticipantsOnceRef: this one is deliberately
    // reset to false in selectParticipant() so switching to a different
    // participant still shows the full loading card (a different person's
    // data is about to replace what's on screen — this should be obvious,
    // not silently swapped in). A plain refetch of the SAME participant
    // (focus refire, pull-to-refresh) never resets it, so that case keeps
    // the existing analytics visible with only the discreet RefreshControl
    // spinner, per PHASE 4 ("preserve currently valid data during a
    // background refresh").
    const hasLoadedReminderDataOnceRef = useRef(false);
    // Set by loadDashboardData() right before it calls loadReminderData(),
    // only when recovering from a prior error -- lets loadReminderData()
    // announce "back online" to VoiceOver at its own success point without
    // reading connectionsError/reminderDataError React state, which
    // wouldn't yet reflect this render's in-flight updates.
    const pendingRecoveryAnnounceRef = useRef(false);

    const pushRegistrationAttemptedRef = useRef(false);

    // connectionSummary always reflects the *currently selected* participant
    // (status 'none'/'pending' only apply when there are zero accepted ones).
    const [connectionSummary, setConnectionSummary] = useState<ConnectionSummary>({ id: '', status: 'none' });
    // All accepted participants for the horizontal selector — MVP shows one
    // participant's data at a time (the selected one), never mixed.
    const [participants, setParticipants]           = useState<ConnectionSummary[]>([]);
    // Non-expired pending invitations that don't already have a dedicated
    // "none accepted yet" screen to appear on (i.e. surfaced even once
    // there's >=1 accepted participant) — see the fetch comment above.
    const [pendingInviteCount, setPendingInviteCount] = useState(0);
    // This organizer's own onboarding use_case — display-only, used to
    // pick a short relationship label ("Loved One", "Athlete", ...) for
    // the participant chips. null = unset/older account, falls back to
    // the neutral "Participant" label via getRoleLabelKeys.
    const [organizerUseCase, setOrganizerUseCase] = useState<UseCase | null>(null);
    const [todayData, setTodayData]                 = useState<DayData | null>(null);
    const [weeklyData, setWeeklyData]               = useState<DayData[]>([]);
    const [monthData, setMonthData]                 = useState<DayData[]>([]);
    const [reminderBreakdown, setReminderBreakdown] = useState<ReminderBreakdownItem[]>([]);
    const [hasAnyReminders, setHasAnyReminders]     = useState(false);
    const [settingsVisible, setSettingsVisible]     = useState(false);
    // The connected recipient's OWN stored timezone — set by
    // loadReminderData, read by getHeatmapStyle and the adherence-stats
    // getRangeStats calls below. Null until a valid value has actually
    // been read — never this caregiver's own device timezone, and never a
    // hardcoded default. There is no repair path the organizer's client
    // can trigger for a different person's stored profile (only that
    // participant's own device can resync it via syncCurrentUserTimezone);
    // see recipientTimeZoneUnavailable below for what happens when it
    // can't be read.
    const [recipientTimeZone, setRecipientTimeZone] = useState<string | null>(null);
    // True once loadReminderData has confirmed the selected participant's
    // stored timezone is missing/invalid/unreadable — distinct from "still
    // loading" (recipientTimeZone null, this false). Drives a compact,
    // retryable notice instead of ever computing analytics against a
    // guessed zone.
    const [recipientTimeZoneUnavailable, setRecipientTimeZoneUnavailable] = useState(false);

    // Caregiver/Organizer id, cached for re-fetching reminder data on participant switch.
    const caregiverIdRef = useRef<string | null>(null);

    // Mirrors connectionSummary.id but readable from the stable focus-effect
    // closure below, which must not go stale across renders.
    const selectedConnectionIdRef = useRef<string>('');

    // Incremented on every loadReminderData() call — a slow in-flight
    // request (e.g. Participant A's fetch, still pending when the
    // caregiver switches to Participant B) checks this before writing any
    // state; if a newer call has since started, the stale one silently
    // discards its result instead of overwriting B's screen with A's
    // data. See PHASE 8 in docs/participant-management-model.md.
    const loadGenerationRef = useRef(0);

    const { connectionId: routeConnectionId } = useLocalSearchParams<{ connectionId?: string }>();

    async function loadReminderData(connectionId: string, acceptedAt: string) {
        const myGeneration = ++loadGenerationRef.current;
        setDashboardLoading(true);
        const caregiverId = caregiverIdRef.current;
        if (!caregiverId) { setDashboardLoading(false); return; }

        // Every pending/missed/future computation below runs in the
        // connected RECIPIENT's own stored timezone, never this
        // caregiver's device clock and never a hardcoded default — a
        // caregiver viewing a recipient in a different timezone must see
        // the same status the recipient (and the server) would compute.
        // There is no repair path the organizer's client can trigger for a
        // participant's own profile (only that participant's own device
        // can resync it), so a missing/invalid/unreadable value here is
        // left unavailable rather than guessed — see
        // recipientTimeZoneUnavailable below.
        const { data: connectionRow } = await supabase
            .from('connections')
            .select('recipient_id')
            .eq('id', connectionId)
            .maybeSingle();

        let recipientTz: string | null = null;
        if (connectionRow?.recipient_id) {
            const { data: recipientProfile } = await supabase
                .from('profiles')
                .select('timezone')
                .eq('id', connectionRow.recipient_id)
                .maybeSingle();
            if (loadGenerationRef.current !== myGeneration) return;
            recipientTz = isValidIanaTimezone(recipientProfile?.timezone) ? recipientProfile!.timezone : null;
        }
        // A newer switch has since started — abandon this stale in-flight
        // load entirely rather than writing even the timezone for a
        // participant that's no longer selected.
        if (loadGenerationRef.current !== myGeneration) return;
        setRecipientTimeZone(recipientTz);
        setRecipientTimeZoneUnavailable(!recipientTz);

        if (!recipientTz) {
            setDashboardLoading(false);
            hasLoadedReminderDataOnceRef.current = true;
            return;
        }

        const { data: remindersData, error: remindersError } = await supabase
            .from('reminders')
            .select(
                'id, connection_id, caregiver_id, recipient_id, title, reminder_type, notes, time_of_day, frequency, days_of_week, no_response_minutes, created_at, is_active, updated_at'
            )
            .eq('caregiver_id', caregiverId)
            .eq('connection_id', connectionId)
            .order('time_of_day', { ascending: true });

        if (loadGenerationRef.current !== myGeneration) return;

        if (remindersError) {
            console.error('[caregiver-dashboard] reminders fetch failed:', remindersError.message);
            setDashboardLoading(false);
            setReminderDataError(classifyScreenError(remindersError.message));
            hasLoadedReminderDataOnceRef.current = true;
            pendingRecoveryAnnounceRef.current = false;
            return;
        }

        setReminderDataError(null);
        const reminders  = (remindersData || []) as Reminder[];
        setHasAnyReminders(reminders.length > 0);
        const today      = new Date();
        const weekStart  = getStartOfWeek(today);
        const weekDates  = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
        const monthDates = getMonthDates(today);

        const earliestDate = weekDates[0] < monthDates[0] ? weekDates[0] : monthDates[0];
        const latestDate   =
            weekDates[6] > monthDates[monthDates.length - 1]
                ? weekDates[6]
                : monthDates[monthDates.length - 1];

        let logs: ReminderLog[] = [];

        if (reminders.length > 0) {
            const reminderIds = reminders.map((r) => r.id);
            const { data: logsData, error: logsError } = await supabase
                .from('reminder_logs')
                .select('reminder_id, occurrence_date, status, completed_at, snoozed_until')
                .eq('caregiver_id', caregiverId)
                .gte('occurrence_date', getLocalDateString(earliestDate))
                .lte('occurrence_date', getLocalDateString(latestDate))
                .in('reminder_id', reminderIds);

            if (logsError) {
                console.error('[caregiver-dashboard] logs fetch failed:', logsError.message);
                setAnalyticsOnlyError(true);
            } else {
                logs = (logsData || []) as ReminderLog[];
                setAnalyticsOnlyError(false);
            }
        } else {
            setAnalyticsOnlyError(false);
        }

        // Final check before committing this batch of analytics state —
        // the most consequential point, since this is what would otherwise
        // visibly flash Participant A's breakdown under Participant B's
        // name if A's request happened to resolve last.
        if (loadGenerationRef.current !== myGeneration) return;

        const todayDayData = buildDayData(today, reminders, logs, acceptedAt, recipientTz);
        const weekDayData  = weekDates.map((d) => buildDayData(d, reminders, logs, acceptedAt, recipientTz));
        const monthDayData = monthDates.map((d) => buildDayData(d, reminders, logs, acceptedAt, recipientTz));

        setSelectedWeekIndex(today.getDay());
        setSelectedMonthIndex(today.getDate() - 1);
        setTodayData(todayDayData);
        setWeeklyData(weekDayData);
        setMonthData(monthDayData);
        setReminderBreakdown(buildReminderBreakdown(reminders, logs, monthDates, acceptedAt, recipientTz));
        setDashboardLoading(false);
        hasLoadedReminderDataOnceRef.current = true;
        if (pendingRecoveryAnnounceRef.current) {
            pendingRecoveryAnnounceRef.current = false;
            announceStateChange(t('stateViews.backToNormal'));
        }
    }

    function selectParticipant(p: ConnectionSummary) {
        if (p.id === selectedConnectionIdRef.current) return;
        selectedConnectionIdRef.current = p.id;
        setConnectionSummary(p);
        // A different participant's data is about to load — show the full
        // loading card rather than leaving the previous participant's
        // analytics on screen under the new participant's name. The old
        // participant's timezone is cleared here, synchronously, rather
        // than left in place until the new fetch resolves (relying only on
        // loadGenerationRef to discard a stale write would still let the
        // OLD participant's zone classify the screen for however long the
        // new fetch takes).
        hasLoadedReminderDataOnceRef.current = false;
        setRecipientTimeZone(null);
        setRecipientTimeZoneUnavailable(false);
        if (caregiverIdRef.current) setStoredSelectedConnectionId(caregiverIdRef.current, p.id);
        loadReminderData(p.id, p.acceptedAt ?? new Date().toISOString());
    }

    async function loadDashboardData() {
        // Captured before this attempt clears them -- lets a load that
        // recovers from a prior error/offline banner announce that fact to
        // VoiceOver once the banner disappears (it has no live region of
        // its own once it's gone).
        const wasRecoveringFromError = connectionsError !== null || reminderDataError !== null;
        setConnectionLoading(true);
        setDashboardLoading(true);
        setOfflineDismissed(false);

        const { data: { user }, error: userError } = await supabase.auth.getUser();

        if (userError || !user) {
            setConnectionLoading(false);
            setDashboardLoading(false);
            router.replace('/signin');
            return;
        }

        // A tombstoned account must never reach connection/reminder data,
        // even if a technically-valid session slipped through (e.g. Auth
        // deletion partially failed upstream but the profile tombstone is
        // already in place). use_case rides along on the same round trip
        // (display-only — see docs/onboarding-model.md — used here just to
        // pick a short relationship label like "Loved One" for the
        // participant chips below).
        const { data: statusRow } = await supabase
            .from('profiles')
            .select('account_status, use_case')
            .eq('id', user.id)
            .maybeSingle();
        if (isUseCase(statusRow?.use_case)) setOrganizerUseCase(statusRow.use_case);

        if (statusRow?.account_status === 'deleted') {
            setConnectionLoading(false);
            setDashboardLoading(false);
            await clearAccountScopedLocalState().catch(() => {});
            await supabase.auth.signOut().catch(() => {});
            router.replace('/signin');
            return;
        }

        caregiverIdRef.current = user.id;

        if (!pushRegistrationAttemptedRef.current) {
            pushRegistrationAttemptedRef.current = true;
            registerPushToken(user.id)
                .then((result) => {
                    if (!result.ok) {
                        console.warn('[caregiver-dashboard] push registration failed', result);
                    }
                })
                .catch((err) => console.warn('[caregiver-dashboard] push registration error:', err));
        }

        const { data: connections, error: connectionError } = await supabase
            .from('connections')
            .select('id, invite_code, status, recipient_id, created_at, accepted_at, expires_at')
            .eq('caregiver_id', user.id)
            .order('created_at', { ascending: false })
            .limit(50);

        if (connectionError) {
            // Never clears participants/connectionSummary — a failed
            // background refresh leaves whatever was last showing intact
            // (see the SectionErrorState rendered near the participant
            // selector below).
            console.error('[caregiver-dashboard] connections fetch failed:', connectionError.message);
            setConnectionLoading(false);
            setDashboardLoading(false);
            setConnectionsError(classifyScreenError(connectionError.message));
            return;
        }

        setConnectionsError(null);
        hasLoadedParticipantsOnceRef.current = true;

        const acceptedConnections = (connections ?? []).filter(
            (c) => c.status === 'accepted' && c.recipient_id
        );
        // Non-expired pending invitations — counted the same way the
        // server does (see lib/connectionStateCore.ts), so this indicator
        // can never disagree with what create_invite_code() will actually
        // allow. Surfaced even when there are already accepted
        // participants — previously a caregiver with >=1 accepted
        // connection had no way to see a separate outstanding pending
        // invite anywhere on this screen.
        const pendingConnections = (connections ?? []).filter(
            (c) => categorizeConnection(c) === 'pending'
        );
        setPendingInviteCount(pendingConnections.length);

        if (acceptedConnections.length === 0) {
            const pendingConnection = pendingConnections[0];
            setParticipants([]);
            setConnectionSummary(
                pendingConnection
                    ? { id: pendingConnection.id, status: 'pending', inviteCode: pendingConnection.invite_code }
                    : { id: '', status: 'none' }
            );
            setTodayData(null);
            setWeeklyData([]);
            setMonthData([]);
            setReminderBreakdown([]);
            setHasAnyReminders(false);
            setConnectionLoading(false);
            setDashboardLoading(false);
            hasLoadedReminderDataOnceRef.current = true;
            return;
        }

        const recipientIds = acceptedConnections.map((c) => c.recipient_id as string);
        const { data: recipientProfiles, error: profileError } = await supabase
            .from('profiles')
            .select('id, full_name')
            .in('id', recipientIds);

        if (profileError) console.error('[caregiver-dashboard] profiles fetch failed:', profileError.message);

        const nameById = new Map((recipientProfiles ?? []).map((p) => [p.id, p.full_name]));

        const nextParticipants: ConnectionSummary[] = acceptedConnections.map((c) => ({
            id: c.id,
            status: 'accepted',
            recipientId: c.recipient_id as string,
            recipientName: nameById.get(c.recipient_id as string) || t('common.participant'),
            acceptedAt: c.accepted_at || c.created_at || new Date().toISOString(),
        }));

        setParticipants(nextParticipants);

        // Selection priority: an explicit route param (e.g. returning from
        // Create/Edit Reminder), then whatever is currently selected in this
        // session (e.g. pull-to-refresh), then the last selection restored
        // from device storage (e.g. app restart), then the first participant.
        const byParam     = routeConnectionId
            ? nextParticipants.find((p) => p.id === routeConnectionId)
            : undefined;
        // The caller (e.g. Create/Edit Reminder) pointed at a specific
        // participant that no longer exists among the accepted ones by the
        // time this screen finished loading -- their connection ended in
        // the gap between navigating away and back. Silently substituting a
        // different participant here would misattribute whatever loads
        // next to the wrong name, so say so once instead.
        if (routeConnectionId && !byParam) {
            showAlertOnce(t('organizerDashboard.participantNoLongerAvailableTitle'), t('organizerDashboard.participantNoLongerAvailableMessage'));
        }
        const byInMemory  = byParam
            ? undefined
            : nextParticipants.find((p) => p.id === selectedConnectionIdRef.current);
        let selected = byParam ?? byInMemory;

        if (!selected) {
            const storedId = await getStoredSelectedConnectionId(user.id);
            selected = nextParticipants.find((p) => p.id === storedId);
        }

        if (!selected) selected = nextParticipants[0];

        selectedConnectionIdRef.current = selected.id;
        setConnectionSummary(selected);
        setConnectionLoading(false);
        setStoredSelectedConnectionId(user.id, selected.id);

        pendingRecoveryAnnounceRef.current = wasRecoveringFromError;
        await loadReminderData(selected.id, selected.acceptedAt ?? new Date().toISOString());
    }

    useFocusEffect(useCallback(() => { loadDashboardData(); }, [routeConnectionId]));

    // Tracks screen focus AND app-foreground state for the poll below,
    // without re-subscribing it on every change — see that effect's own
    // comment. useFocusEffect's blur only fires on navigating away, never
    // on the OS backgrounding the whole app, so AppState is tracked
    // separately (otherwise the interval would keep firing network
    // requests while backgrounded).
    const isFocusedRef = useRef(true);
    const isAppActiveRef = useRef(true);
    useFocusEffect(useCallback(() => {
        isFocusedRef.current = true;
        return () => { isFocusedRef.current = false; };
    }, []));
    useEffect(() => {
        const sub = AppState.addEventListener('change', (state) => {
            isAppActiveRef.current = state === 'active';
        });
        return () => sub.remove();
    }, []);

    // Live-ish connection refresh (PHASE 11): no Supabase Realtime
    // subscription exists anywhere in this codebase yet (confirmed by
    // audit), so introducing one here — the first anywhere — would be a
    // materially riskier change than a bounded, self-limiting poll. This
    // interval only EXISTS while there is a genuine pending invitation to
    // wait on (never continuous/unconditional background polling), only
    // does work while this screen is focused AND the app is foregrounded,
    // and stops itself the moment pendingInviteCount returns to 0 (e.g.
    // the invite was accepted, or expired) since that recomputes and
    // re-runs this effect with a fresh dependency. See
    // docs/participant-management-model.md.
    useEffect(() => {
        if (pendingInviteCount === 0) return;
        const interval = setInterval(() => {
            if (isFocusedRef.current && isAppActiveRef.current) loadDashboardData();
        }, 20000);
        return () => clearInterval(interval);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pendingInviteCount]);

    function handleCreateReminder() {
        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        if (connectionSummary.status !== 'accepted') {
            router.push('/invite-recipient');
            return;
        }
        router.push({ pathname: '/create-item', params: { connectionId: connectionSummary.id } });
    }

    // ── Connection card ─────────────────────────────────────────────────────

    function ConnectionCard() {
        if (connectionLoading && !hasLoadedParticipantsOnceRef.current) {
            return (
                <View style={[styles.connectionCard, SHADOW.xs]}>
                    <View style={styles.connectionCardInner}>
                        <View style={[styles.connectionIconWrap, { backgroundColor: C.bgAlt }]}>
                            <ActivityIndicator size="small" color={C.textMuted} />
                        </View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.connectionLabel}>{t('organizerDashboard.connectionLabel')}</Text>
                            <Text style={styles.connectionTitle}>{t('organizerDashboard.checkingConnection')}</Text>
                        </View>
                    </View>
                </View>
            );
        }

        if (connectionSummary.status === 'none') {
            return (
                <View style={[styles.connectionCard, SHADOW.xs]}>
                    <View style={styles.connectionCardInner}>
                        <View style={[styles.connectionIconWrap, { backgroundColor: C.bgAlt }]}>
                            <Ionicons name="link-outline" size={22} color={C.textMuted} />
                        </View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.connectionLabel}>{t('organizerDashboard.connectionLabel')}</Text>
                            <Text style={styles.connectionTitle}>{t('organizerDashboard.noParticipantLinked')}</Text>
                            <Text style={styles.connectionText}>
                                {t('organizerDashboard.sendInviteHint')}
                            </Text>
                        </View>
                    </View>
                    <TouchableOpacity
                        style={[styles.connectionButton, SHADOW.primary]}
                        onPress={() => router.push('/invite-recipient')}
                        activeOpacity={0.88}
                    >
                        <Text style={styles.connectionButtonText}>{t('organizerDashboard.invite')}</Text>
                    </TouchableOpacity>
                </View>
            );
        }

        if (connectionSummary.status === 'pending') {
            return (
                <View style={[styles.connectionCard, styles.connectionCardPending, SHADOW.xs]}>
                    <View style={styles.connectionCardInner}>
                        <View style={[styles.connectionIconWrap, { backgroundColor: '#FEF3C7' }]}>
                            <Ionicons name="time-outline" size={22} color="#D97706" />
                        </View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.connectionLabel}>{t('organizerDashboard.connectionLabel')}</Text>
                            <Text style={styles.connectionTitle}>{t('organizerDashboard.waitingForAcceptance')}</Text>
                            <Text style={styles.connectionText}>
                                {t('organizerDashboard.shareCodeHint')}
                            </Text>
                        </View>
                    </View>
                    <View style={styles.inviteCodePill}>
                        <Text style={styles.inviteCodeText}>{connectionSummary.inviteCode}</Text>
                    </View>
                    <TouchableOpacity
                        style={styles.connectionButtonOutline}
                        onPress={() => router.push('/invite-recipient')}
                        activeOpacity={0.75}
                    >
                        <Text style={styles.connectionButtonOutlineText}>{t('organizerDashboard.viewFullInvite')}</Text>
                    </TouchableOpacity>
                </View>
            );
        }

        // Accepted — the participant selector below replaces this card.
        return null;
    }

    // ── Participant selector ────────────────────────────────────────────────
    // Horizontal chips for every accepted participant, plus an Add chip.
    // Selecting a chip filters the whole dashboard (today/progress/analytics/
    // breakdown) to that participant — never mixed across participants.

    function ParticipantSelector() {
        if (participants.length === 0) return null;

        const slotsUsed = participants.length + pendingInviteCount;
        const atStandardLimit = slotsUsed >= MAX_STANDARD_PARTICIPANTS;
        const roleLabelKeys = getRoleLabelKeys(organizerUseCase);
        const participantRoleLabel = t(roleLabelKeys.participantTitle);

        return (
            <View>
                <View style={styles.participantSelectorHeader}>
                    <Text style={styles.participantSelectorCount}>
                        {t('inviteParticipant.participantsOfLimit', { count: participants.length, limit: MAX_STANDARD_PARTICIPANTS })}
                    </Text>
                    <TouchableOpacity
                        onPress={() => router.push('/participants')}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        accessibilityRole="button"
                        accessibilityLabel={t('organizerDashboard.manageParticipants')}
                    >
                        <Text style={styles.participantSelectorManageLink}>{t('organizerDashboard.manageParticipants')}</Text>
                    </TouchableOpacity>
                </View>

                {pendingInviteCount > 0 && (
                    <TouchableOpacity
                        style={styles.pendingInviteBanner}
                        onPress={() => router.push('/participants')}
                        activeOpacity={0.8}
                        accessibilityRole="button"
                        accessibilityLabel={t('organizerDashboard.pendingInvitesBanner', { count: pendingInviteCount, plural: pendingInviteCount === 1 ? '' : 's' })}
                    >
                        <Ionicons name="time-outline" size={16} color={C.primary} />
                        <Text style={styles.pendingInviteBannerText}>
                            {t('organizerDashboard.pendingInvitesBanner', { count: pendingInviteCount, plural: pendingInviteCount === 1 ? '' : 's' })}
                        </Text>
                        <Ionicons name="chevron-forward" size={16} color={C.primary} />
                    </TouchableOpacity>
                )}

                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={styles.participantSelector}
                    contentContainerStyle={styles.participantSelectorContent}
                    accessibilityRole="tablist"
                >
                {participants.map((p) => {
                    const selected = p.id === connectionSummary.id;
                    return (
                        <TouchableOpacity
                            key={p.id}
                            style={[styles.participantChip, selected && styles.participantChipActive]}
                            onPress={() => selectParticipant(p)}
                            activeOpacity={0.8}
                            accessibilityRole="tab"
                            accessibilityState={{ selected }}
                            accessibilityLabel={`${p.recipientName || t('common.participant')}, ${participantRoleLabel}`}
                            accessibilityHint={selected ? undefined : t('organizerDashboard.switchToParticipantHint')}
                        >
                            <View style={[styles.participantAvatar, selected && styles.participantAvatarActive]}>
                                <Text style={[styles.participantAvatarText, selected && styles.participantAvatarTextActive]}>
                                    {(p.recipientName || '?').charAt(0).toUpperCase()}
                                </Text>
                                {selected && (
                                    <View style={styles.participantSelectedDot}>
                                        <Ionicons name="checkmark" size={10} color={C.textInverse} />
                                    </View>
                                )}
                            </View>
                            <Text
                                style={[styles.participantChipText, selected && styles.participantChipTextActive]}
                                numberOfLines={1}
                            >
                                {p.recipientName}
                            </Text>
                        </TouchableOpacity>
                    );
                })}

                <TouchableOpacity
                    style={styles.addParticipantChip}
                    onPress={() => router.push('/invite-recipient')}
                    activeOpacity={0.8}
                    accessibilityRole="button"
                    accessibilityLabel={t('organizerDashboard.add')}
                    accessibilityHint={atStandardLimit ? t('inviteParticipant.limitReachedTitle') : undefined}
                >
                    <Ionicons
                        name={atStandardLimit ? 'lock-closed-outline' : 'add'}
                        size={18}
                        color={C.primary}
                    />
                    <Text style={styles.addParticipantChipText}>{t('organizerDashboard.add')}</Text>
                </TouchableOpacity>
                </ScrollView>
            </View>
        );
    }

    // ── Analytics section ───────────────────────────────────────────────────

    function renderAnalytics() {
        if (connectionSummary.status !== 'accepted') {
            return (
                <View style={[styles.card, SHADOW.xs]}>
                    <View style={styles.emptyState}>
                        <View style={styles.emptyIconWrap}>
                            <Ionicons name="bar-chart-outline" size={28} color={C.textMuted} />
                        </View>
                        <Text style={styles.emptyTitle}>{t('organizerDashboard.noAnalyticsYet')}</Text>
                        <Text style={styles.emptyText}>
                            {connectionSummary.status === 'pending'
                                ? t('organizerDashboard.analyticsWaitingPending')
                                : t('organizerDashboard.analyticsWaitingNone')}
                        </Text>
                    </View>
                </View>
            );
        }

        if (dashboardLoading && !hasLoadedReminderDataOnceRef.current) {
            return (
                <View style={[styles.card, SHADOW.xs]}>
                    <View style={styles.loadingState}>
                        <ActivityIndicator color={C.primary} />
                        <Text style={styles.loadingText}>{t('organizerDashboard.loadingReminders')}</Text>
                    </View>
                </View>
            );
        }

        // The participant's own stored timezone couldn't be read even
        // after loadReminderData ran — never compute pending/missed/future
        // status against a guessed zone. Nothing below this point may run
        // without a confirmed-valid recipientTimeZone.
        if (recipientTimeZoneUnavailable || !recipientTimeZone) {
            return (
                <SectionErrorState
                    text={t('organizerDashboard.recipientTimezoneUnavailableText')}
                    onRetry={() => loadReminderData(connectionSummary.id, connectionSummary.acceptedAt ?? new Date().toISOString())}
                    retrying={dashboardLoading}
                />
            );
        }

        const rangeStats: RangeStats =
            selectedRange === 'Today' && todayData ? getRangeStats([todayData], recipientTimeZone)
            : selectedRange === 'Week'             ? getRangeStats(weeklyData, recipientTimeZone)
            :                                        getRangeStats(monthData, recipientTimeZone);

        const selectedDay: DayData | undefined =
            selectedRange === 'Week'  ? weeklyData[selectedWeekIndex]
            : selectedRange === 'Month' ? monthData[selectedMonthIndex]
            : undefined;

        // First-day-of-month offset for heatmap alignment
        const monthOffset = monthData.length > 0
            ? new Date(monthData[0].dateString + 'T12:00:00').getDay()
            : 0;

        const adherenceColor = getAdherenceColor(rangeStats.adherence);

        return (
            <>
                {/* Range tabs */}
                <View style={[styles.tabContainer, SHADOW.xs]} accessibilityRole="tablist">
                    {(['Today', 'Week', 'Month'] as const).map((range) => (
                        <TouchableOpacity
                            key={range}
                            style={[styles.tab, selectedRange === range && styles.activeTab]}
                            onPress={() => setSelectedRange(range)}
                            activeOpacity={0.75}
                            accessibilityRole="tab"
                            accessibilityLabel={t(RANGE_LABEL_KEYS[range])}
                            accessibilityState={{ selected: selectedRange === range }}
                        >
                            <Text style={[styles.tabText, selectedRange === range && styles.activeTabText]}>
                                {t(RANGE_LABEL_KEYS[range])}
                            </Text>
                        </TouchableOpacity>
                    ))}
                </View>

                {/* Adherence metric */}
                <View style={[styles.card, SHADOW.xs]}>
                    <Text style={styles.cardLabel}>
                        {t('organizerDashboard.adherenceLabel', { range: t(RANGE_LABEL_KEYS[selectedRange]) })}
                    </Text>

                    {rangeStats.adherence !== null ? (
                        <>
                            <Text style={[styles.bigMetric, { color: adherenceColor }]}>
                                {rangeStats.adherence}%
                            </Text>
                            <View style={styles.adherenceBarTrack}>
                                <View
                                    style={[
                                        styles.adherenceBarFill,
                                        { width: `${rangeStats.adherence}%`, backgroundColor: adherenceColor },
                                    ]}
                                />
                            </View>
                            <Text style={styles.helperText}>
                                {t('organizerDashboard.takenOfCountable', {
                                    taken: rangeStats.taken,
                                    countable: rangeStats.countable,
                                    plural: rangeStats.countable !== 1 ? 's' : '',
                                })}
                            </Text>
                        </>
                    ) : (
                        <>
                            <Text style={[styles.bigMetric, { color: C.textMuted }]}>—</Text>
                            <Text style={styles.helperText}>
                                {!hasAnyReminders
                                    ? t('organizerDashboard.noRemindersTapAdd')
                                    : t('organizerDashboard.noCountableDataYet')}
                            </Text>
                        </>
                    )}
                </View>

                {/* ── Today view ── */}
                {selectedRange === 'Today' && (
                    <View style={[styles.card, SHADOW.xs]}>
                        <Text style={styles.cardTitle}>{t('organizerDashboard.todaysReminders')}</Text>

                        {!hasAnyReminders ? (
                            <>
                                <Text style={[styles.helperText, { marginBottom: 12 }]}>
                                    {t('organizerDashboard.noRemindersCreatedYet')}
                                </Text>
                                {connectionSummary.status === 'accepted' ? (
                                    <TouchableOpacity
                                        style={[styles.firstReminderButton, SHADOW.primary]}
                                        onPress={handleCreateReminder}
                                        activeOpacity={0.88}
                                        accessibilityRole="button"
                                        accessibilityLabel={t('firstReminder.emptyCtaTitle')}
                                        accessibilityHint={
                                            connectionSummary.recipientName
                                                ? t('firstReminder.emptyCtaSubtitle', { name: connectionSummary.recipientName })
                                                : t('firstReminder.emptyCtaSubtitleGeneric')
                                        }
                                    >
                                        <Ionicons name="add-circle" size={20} color={C.textInverse} />
                                        <Text style={styles.firstReminderButtonText}>
                                            {t('firstReminder.emptyCtaTitle')}
                                        </Text>
                                    </TouchableOpacity>
                                ) : (
                                    <View style={styles.inlineEmpty}>
                                        <Ionicons name="add-circle-outline" size={20} color={C.textMuted} />
                                        <Text style={styles.inlineEmptyText}>
                                            {t('organizerDashboard.createFirstReminder')}
                                        </Text>
                                    </View>
                                )}
                            </>
                        ) : !todayData || todayData.eligibleCount === 0 ? (
                            <View style={styles.inlineEmpty}>
                                <Ionicons name="calendar-outline" size={20} color={C.textMuted} />
                                <Text style={styles.inlineEmptyText}>
                                    {todayData && todayData.scheduledCount > 0 && reminderBreakdown.length > 0
                                        ? t('organizerDashboard.notStartedYet')
                                        : reminderBreakdown.length === 0
                                        ? t('organizerDashboard.noActiveRemindersToday')
                                        : t('organizerDashboard.nothingScheduledToday')}
                                </Text>
                            </View>
                        ) : (
                            <>
                                <Text style={[styles.helperText, { marginBottom: 12 }]}>
                                    {t('organizerDashboard.reminderCountToday', {
                                        n: todayData.eligibleCount,
                                        plural: todayData.eligibleCount !== 1 ? 's' : '',
                                    })}
                                </Text>

                                {/* Stats row */}
                                <View style={styles.metricRow}>
                                    <MetricTile
                                        count={todayData.takenCount}
                                        label={formatStatus('taken')}
                                        color="#15803D"
                                        bg="#DCFCE7"
                                    />
                                    <MetricTile
                                        count={todayData.pendingCount}
                                        label={formatStatus('pending')}
                                        color={C.textSecondary}
                                        bg={C.bgAlt}
                                    />
                                    <MetricTile
                                        count={todayData.missedCount}
                                        label={formatStatus('missed')}
                                        color="#B91C1C"
                                        bg="#FEE2E2"
                                    />
                                    <MetricTile
                                        count={todayData.skippedCount + todayData.snoozedCount}
                                        label={formatStatus('skipped')}
                                        color="#B45309"
                                        bg="#FEF3C7"
                                    />
                                </View>

                                {todayData.reminders.map((reminder) => (
                                    <ReminderRow key={reminder.id} reminder={reminder} />
                                ))}
                            </>
                        )}
                    </View>
                )}

                {/* ── Week view ── */}
                {selectedRange === 'Week' && (
                    <View style={[styles.card, SHADOW.xs]}>
                        <Text style={styles.cardTitle}>{t('organizerDashboard.weeklyActivity')}</Text>
                        <Text style={styles.helperText}>
                            {t('organizerDashboard.tapDayHint')}
                        </Text>

                        <View style={styles.chart} accessibilityRole="tablist">
                            {weeklyData.map((day, index) => (
                                <TouchableOpacity
                                    key={day.dateString}
                                    style={styles.barWrapper}
                                    onPress={() => setSelectedWeekIndex(index)}
                                    activeOpacity={0.7}
                                    accessibilityRole="tab"
                                    accessibilityLabel={dayAccessibilitySummary(day)}
                                    accessibilityState={{ selected: selectedWeekIndex === index }}
                                >
                                    <View style={styles.barTrack}>
                                        <View
                                            style={[
                                                styles.bar,
                                                {
                                                    height: getBarHeight(day) as any,
                                                    backgroundColor:
                                                        selectedWeekIndex === index && day.hasData
                                                            ? C.primaryDark
                                                            : getBarColor(day),
                                                },
                                            ]}
                                        />
                                    </View>
                                    <Text
                                        style={[
                                            styles.dayLabel,
                                            selectedWeekIndex === index && styles.selectedDayLabel,
                                        ]}
                                    >
                                        {day.shortLabel.charAt(0)}
                                    </Text>
                                </TouchableOpacity>
                            ))}
                        </View>
                    </View>
                )}

                {/* ── Month heatmap ── */}
                {selectedRange === 'Month' && (
                    <View style={[styles.card, SHADOW.xs]}>
                        <Text style={styles.cardTitle}>{t('organizerDashboard.monthlyHeatmap')}</Text>
                        <Text style={styles.helperText}>{t('organizerDashboard.tapDayDetailsHint')}</Text>

                        <View style={styles.weekLabels}>
                            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((label, i) => (
                                <Text key={`wl-${i}`} style={styles.weekLabel}>{label}</Text>
                            ))}
                        </View>

                        <View style={styles.heatmapGrid}>
                            {Array.from({ length: monthOffset }, (_, i) => (
                                <View key={`offset-${i}`} style={[styles.heatmapDay, styles.heatmapOffset]} />
                            ))}
                            {monthData.map((day, index) => (
                                <TouchableOpacity
                                    key={day.dateString}
                                    style={[
                                        styles.heatmapDay,
                                        getHeatmapStyle(day),
                                        selectedMonthIndex === index && styles.selectedHeatmapDay,
                                    ]}
                                    onPress={() => setSelectedMonthIndex(index)}
                                    activeOpacity={0.75}
                                    hitSlop={{ top: 3, bottom: 3, left: 3, right: 3 }}
                                    accessibilityRole="button"
                                    accessibilityLabel={dayAccessibilitySummary(day)}
                                    accessibilityState={{ selected: selectedMonthIndex === index }}
                                >
                                    <Text style={styles.heatmapText}>{day.monthDay}</Text>
                                </TouchableOpacity>
                            ))}
                        </View>

                        <View style={styles.legendRow}>
                            {[
                                { style: styles.heatmapNoData,  label: t('organizerDashboard.legendNoData') },
                                { style: styles.heatmapHigh,    label: '100%' },
                                { style: styles.heatmapMedium,  label: '75%+' },
                                { style: styles.heatmapLow,     label: '50%+' },
                                { style: styles.heatmapMissed,  label: '<50%' },
                                { style: styles.heatmapPending, label: t('organizerDashboard.legendPending') },
                            ].map(({ style, label }) => (
                                <View key={label} style={styles.legendItem}>
                                    <View style={[styles.legendSwatch, style]} />
                                    <Text style={styles.legendLabel}>{label}</Text>
                                </View>
                            ))}
                        </View>
                    </View>
                )}

                {/* ── Selected day detail (Week / Month) ── */}
                {selectedRange !== 'Today' && selectedDay && (
                    <View style={[styles.card, SHADOW.xs]}>
                        <Text style={styles.cardTitle}>{selectedDay.dateLabel}</Text>

                        {selectedDay.isFuture ? (
                            <View style={styles.inlineEmpty}>
                                <Ionicons name="time-outline" size={20} color={C.textMuted} />
                                <Text style={styles.inlineEmptyText}>{t('organizerDashboard.futureNoData')}</Text>
                            </View>
                        ) : !selectedDay.hasData ? (
                            <View style={styles.inlineEmpty}>
                                <Ionicons name="information-circle-outline" size={20} color={C.textMuted} />
                                <Text style={styles.inlineEmptyText}>
                                    {t('organizerDashboard.noDataNotStarted')}
                                </Text>
                            </View>
                        ) : selectedDay.eligibleCount === 0 ? (
                            <View style={styles.inlineEmpty}>
                                <Ionicons name="calendar-outline" size={20} color={C.textMuted} />
                                <Text style={styles.inlineEmptyText}>{t('organizerDashboard.noRemindersScheduled')}</Text>
                            </View>
                        ) : (
                            <>
                                <Text style={styles.helperText}>
                                    {t('organizerDashboard.takenSlashEligible', { taken: selectedDay.takenCount, eligible: selectedDay.eligibleCount })}
                                    {selectedDay.pendingCount > 0
                                        ? t('organizerDashboard.pendingSuffix', { n: selectedDay.pendingCount })
                                        : ''}
                                    {selectedDay.countableCount > 0
                                        ? t('organizerDashboard.adherenceSuffix', { n: selectedDay.adherence })
                                        : ''}
                                </Text>
                                {selectedDay.reminders.map((r) => (
                                    <ReminderRow key={r.id} reminder={r} />
                                ))}
                            </>
                        )}
                    </View>
                )}

                {/* ── Reminder breakdown ── */}
                <View style={styles.bdSection}>
                    <Text style={styles.bdSectionTitle}>{t('organizerDashboard.reminderBreakdown')}</Text>
                    <Text style={styles.bdSectionSub}>
                        {t('organizerDashboard.breakdownSub')}
                    </Text>
                </View>

                {reminderBreakdown.length === 0 ? (
                    <View style={[styles.card, SHADOW.xs]}>
                        <View style={styles.inlineEmpty}>
                            <Ionicons name="list-outline" size={20} color={C.textMuted} />
                            <Text style={styles.inlineEmptyText}>
                                {hasAnyReminders
                                    ? t('organizerDashboard.noActiveAllInactive')
                                    : t('organizerDashboard.noRemindersTapAdd')}
                            </Text>
                        </View>
                    </View>
                ) : (
                    reminderBreakdown.map((item) => (
                        <BreakdownCard key={item.id} item={item} />
                    ))
                )}
            </>
        );
    }

    // ── Render ──────────────────────────────────────────────────────────────

    const isRefreshing = connectionLoading || dashboardLoading;

    return (
        <SafeAreaView style={styles.container}>
            <ScrollView
                contentContainerStyle={styles.content}
                showsVerticalScrollIndicator={false}
                refreshControl={
                    <RefreshControl
                        refreshing={isRefreshing}
                        onRefresh={loadDashboardData}
                        tintColor={C.primary}
                        colors={[C.primary]}
                    />
                }
            >
                <View style={styles.header}>
                    <View style={styles.headerRow}>
                        <Text
                            style={styles.heading}
                            numberOfLines={2}
                            accessibilityRole="header"
                        >
                            {t('organizerDashboard.heading')}
                        </Text>

                        <View style={styles.headerActionsRow}>
                            <TouchableOpacity
                                style={styles.iconButton}
                                onPress={() => router.push({ pathname: '/routine-library', params: connectionSummary.status === 'accepted' ? { connectionId: connectionSummary.id } : {} })}
                                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                accessibilityRole="button"
                                accessibilityLabel={t('routineLibrary.heading')}
                            >
                                <Ionicons name="albums-outline" size={19} color={C.textSecondary} />
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={styles.iconButton}
                                onPress={() => setSettingsVisible(true)}
                                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                accessibilityRole="button"
                                accessibilityLabel={t('settings.title')}
                            >
                                <Ionicons name="settings-outline" size={19} color={C.textSecondary} />
                            </TouchableOpacity>
                        </View>
                    </View>

                    <View style={styles.headerSubRow}>
                        <Text style={styles.subheading} numberOfLines={2}>
                            {!connectionLoading && connectionSummary.status === 'accepted' && connectionSummary.recipientName
                                ? t('organizerDashboard.trackingProgress', { name: connectionSummary.recipientName })
                                : t('organizerDashboard.participantActivity')}
                        </Text>

                        <View style={styles.headerSubActions}>
                            <TouchableOpacity
                                style={styles.inviteButton}
                                onPress={() => router.push('/invite-recipient')}
                                activeOpacity={0.75}
                                hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                                accessibilityRole="button"
                                accessibilityLabel={t('organizerDashboard.invite')}
                            >
                                <Ionicons name="person-add-outline" size={14} color={C.textSecondary} />
                                <Text style={styles.inviteButtonText} numberOfLines={1}>
                                    {t('organizerDashboard.inviteShort')}
                                </Text>
                            </TouchableOpacity>

                            <TouchableOpacity
                                style={[styles.createButton, SHADOW.primary]}
                                onPress={handleCreateReminder}
                                activeOpacity={0.88}
                                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                accessibilityRole="button"
                                accessibilityLabel={t('participants.createReminderAction')}
                            >
                                <Ionicons name="add" size={22} color={C.textInverse} />
                            </TouchableOpacity>
                        </View>
                    </View>
                </View>

                {(connectionsError === 'network' || reminderDataError === 'network') && !offlineDismissed && (
                    <OfflineBanner onDismiss={() => setOfflineDismissed(true)} />
                )}

                {connectionsError && connectionsError !== 'network' && (
                    <SectionErrorState
                        text={t(ERROR_CATEGORY_TRANSLATION_KEYS[connectionsError])}
                        onRetry={loadDashboardData}
                        retrying={connectionLoading}
                    />
                )}

                <ConnectionCard />
                <ParticipantSelector />

                {reminderDataError && reminderDataError !== 'network' ? (
                    <SectionErrorState
                        text={t(ERROR_CATEGORY_TRANSLATION_KEYS[reminderDataError])}
                        onRetry={() => loadReminderData(connectionSummary.id, connectionSummary.acceptedAt ?? new Date().toISOString())}
                        retrying={dashboardLoading}
                    />
                ) : (
                    // Either no reminder-data error at all, or the error is
                    // 'network' — in the latter case the OfflineBanner
                    // above already communicates it, and any previously
                    // loaded analytics stays visible underneath rather
                    // than being replaced by an error card.
                    <>
                        {analyticsOnlyError && (
                            <SectionErrorState
                                text={t('organizerDashboard.analyticsUnavailable')}
                                onRetry={() => loadReminderData(connectionSummary.id, connectionSummary.acceptedAt ?? new Date().toISOString())}
                                retrying={dashboardLoading}
                            />
                        )}
                        {renderAnalytics()}
                    </>
                )}
                {connectionSummary.status === 'accepted' && recipientTimeZone && (
                    <TasksSummaryCard connectionId={connectionSummary.id} canCreate />
                )}
                {connectionSummary.status === 'accepted' && (
                    <ActivityPreviewCard connectionId={connectionSummary.id} />
                )}
            </ScrollView>

            <SettingsSheet
                visible={settingsVisible}
                onClose={() => setSettingsVisible(false)}
            />
        </SafeAreaView>
    );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const createStyles = (C: ThemeColors) => StyleSheet.create({
    container: { flex: 1, backgroundColor: C.bgPage },
    content:   { padding: SPACING.screen, paddingBottom: 48 },

    // ── Header ──────────────────────────────────────────────────────────────
    // Two-row layout keeps the title from being squeezed by action buttons:
    // row 1 is title + settings, row 2 is subtitle + invite/add actions.
    header: {
        marginBottom: SPACING.section,
        gap: SPACING.header,
    },
    headerRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 12,
    },
    headerActionsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    heading: {
        flex: 1,
        fontSize: 23,
        fontWeight: '800',
        color: C.textPrimary,
        letterSpacing: -0.4,
        lineHeight: 28,
    },
    headerSubRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 10,
    },
    subheading: {
        flex: 1,
        fontSize: 14,
        color: C.textSecondary,
        letterSpacing: -0.1,
        lineHeight: 19,
    },
    headerSubActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
    },
    iconButton: {
        width: 38,
        height: 38,
        borderRadius: RADIUS.lg,
        backgroundColor: C.bgSurface,
        borderWidth: 1.5,
        borderColor: C.border,
        alignItems: 'center',
        justifyContent: 'center',
    },
    inviteButton: {
        height: 38,
        paddingHorizontal: 12,
        borderRadius: RADIUS.lg,
        backgroundColor: C.bgSurface,
        borderWidth: 1.5,
        borderColor: C.border,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: 5,
    },
    inviteButtonText: { color: C.textSecondary, fontSize: 13, fontWeight: '600' },
    createButton: {
        width: 38,
        height: 38,
        borderRadius: RADIUS.lg,
        backgroundColor: C.primary,
        alignItems: 'center',
        justifyContent: 'center',
    },

    // ── Connection card ──────────────────────────────────────────────────────
    connectionCard: {
        backgroundColor: C.bgSurface,
        borderRadius: RADIUS.xl,
        padding: 16,
        marginBottom: 16,
        borderWidth: 1.5,
        borderColor: C.border,
    },
    connectionCardPending:  { backgroundColor: '#FFFBEB', borderColor: '#FDE68A' },
    connectionCardAccepted: { backgroundColor: C.successLight, borderColor: '#A7F3D0' },

    // ── Participant selector ──────────────────────────────────────────────────
    participantSelectorHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 10,
    },
    participantSelectorCount: {
        fontSize: 13,
        fontWeight: '600',
        color: C.textMuted,
    },
    participantSelectorManageLink: {
        fontSize: 13,
        fontWeight: '700',
        color: C.primary,
    },
    pendingInviteBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: C.primaryLight,
        borderRadius: RADIUS.md,
        paddingVertical: 10,
        paddingHorizontal: 14,
        marginBottom: 12,
    },
    pendingInviteBannerText: {
        flex: 1,
        fontSize: 13,
        fontWeight: '600',
        color: C.primary,
    },
    participantSelector: {
        marginBottom: 16,
    },
    participantSelectorContent: {
        flexDirection: 'row',
        gap: 10,
        paddingRight: 4,
    },
    participantChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: C.bgSurface,
        borderRadius: RADIUS.full,
        paddingVertical: 8,
        paddingHorizontal: 14,
        borderWidth: 1.5,
        borderColor: C.border,
        maxWidth: 180,
        minHeight: 44,
    },
    participantChipActive: {
        backgroundColor: C.primaryLight,
        borderColor: C.primary,
    },
    participantAvatar: {
        width: 24,
        height: 24,
        borderRadius: RADIUS.full,
        backgroundColor: C.bgAlt,
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
    },
    participantSelectedDot: {
        position: 'absolute',
        bottom: -3,
        right: -3,
        width: 12,
        height: 12,
        borderRadius: RADIUS.full,
        backgroundColor: C.success,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1.5,
        borderColor: C.bgSurface,
    },
    participantAvatarActive: {
        backgroundColor: C.primary,
    },
    participantAvatarText: {
        fontSize: 12,
        fontWeight: '700',
        color: C.textMuted,
    },
    participantAvatarTextActive: {
        color: C.textInverse,
    },
    participantChipText: {
        fontSize: 14,
        fontWeight: '600',
        color: C.textSecondary,
        flexShrink: 1,
    },
    participantChipTextActive: {
        color: C.primary,
        fontWeight: '700',
    },
    addParticipantChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingVertical: 8,
        paddingHorizontal: 14,
        borderRadius: RADIUS.full,
        borderWidth: 1.5,
        borderColor: C.border,
        borderStyle: 'dashed',
    },
    addParticipantChipText: {
        fontSize: 14,
        fontWeight: '600',
        color: C.primary,
    },
    connectionCardInner: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 14,
        marginBottom: 4,
    },
    connectionIconWrap: {
        width: 44,
        height: 44,
        borderRadius: RADIUS.md,
        justifyContent: 'center',
        alignItems: 'center',
        flexShrink: 0,
    },
    connectionLabel: {
        fontSize: 11,
        fontWeight: '700',
        color: C.textMuted,
        textTransform: 'uppercase',
        letterSpacing: 0.8,
        marginBottom: 4,
    },
    connectionTitle: {
        fontSize: 17,
        fontWeight: '700',
        color: C.textPrimary,
        letterSpacing: -0.3,
        marginBottom: 4,
    },
    connectionText: { fontSize: 14, color: C.textSecondary, lineHeight: 20 },
    connectionButton: {
        backgroundColor: C.primary,
        paddingVertical: 14,
        borderRadius: RADIUS.xl,
        alignItems: 'center',
        marginTop: 14,
    },
    connectionButtonText: {
        color: C.textInverse,
        fontSize: 15,
        fontWeight: '700',
        letterSpacing: -0.1,
    },
    connectionButtonOutline: {
        paddingVertical: 12,
        borderRadius: RADIUS.lg,
        alignItems: 'center',
        marginTop: 12,
        borderWidth: 1.5,
        borderColor: '#FDE68A',
    },
    connectionButtonOutlineText: { color: '#D97706', fontSize: 14, fontWeight: '700' },
    inviteCodePill: {
        backgroundColor: '#FEF3C7',
        borderRadius: RADIUS.md,
        paddingVertical: 10,
        paddingHorizontal: 16,
        alignItems: 'center',
        marginTop: 12,
        borderWidth: 1,
        borderColor: '#FDE68A',
    },
    inviteCodeText: {
        fontSize: 22,
        fontWeight: '800',
        color: '#92400E',
        letterSpacing: 4,
    },

    // ── Tabs ─────────────────────────────────────────────────────────────────
    tabContainer: {
        flexDirection: 'row',
        backgroundColor: C.bgSurface,
        borderRadius: RADIUS.lg,
        padding: 4,
        marginBottom: 14,
    },
    tab: {
        flex: 1,
        paddingVertical: 11,
        borderRadius: RADIUS.md,
        alignItems: 'center',
    },
    activeTab: { backgroundColor: C.primary },
    tabText: {
        fontSize: 14,
        fontWeight: '600',
        color: C.textMuted,
        letterSpacing: -0.1,
    },
    activeTabText: { color: C.textInverse, fontWeight: '700' },

    // ── Generic card ──────────────────────────────────────────────────────────
    card: {
        backgroundColor: C.bgSurface,
        borderRadius: RADIUS.xl,
        padding: 20,
        marginBottom: 14,
    },
    cardLabel: {
        fontSize: 13,
        color: C.textMuted,
        fontWeight: '600',
        textTransform: 'uppercase',
        letterSpacing: 0.6,
        marginBottom: 6,
    },
    cardTitle: {
        fontSize: 18,
        fontWeight: '700',
        color: C.textPrimary,
        letterSpacing: -0.3,
        marginBottom: 6,
    },

    // ── Adherence metric ──────────────────────────────────────────────────────
    bigMetric: {
        fontSize: 52,
        fontWeight: '800',
        letterSpacing: -2,
        lineHeight: 60,
    },
    adherenceBarTrack: {
        height: 6,
        backgroundColor: C.bgAlt,
        borderRadius: RADIUS.full,
        marginTop: 10,
        marginBottom: 12,
        overflow: 'hidden',
    },
    adherenceBarFill: { height: '100%', borderRadius: RADIUS.full },
    helperText: {
        fontSize: 14,
        color: C.textMuted,
        lineHeight: 20,
        letterSpacing: -0.1,
    },

    // ── Today metric tiles ────────────────────────────────────────────────────
    metricRow: {
        flexDirection: 'row',
        gap: 8,
        marginBottom: 16,
    },
    metricTile: {
        flex: 1,
        alignItems: 'center',
        paddingVertical: 10,
        borderRadius: RADIUS.md,
    },
    metricTileCount: {
        fontSize: 22,
        fontWeight: '800',
        letterSpacing: -0.5,
    },
    metricTileLabel: {
        fontSize: 10,
        fontWeight: '700',
        letterSpacing: 0.3,
        marginTop: 2,
        textTransform: 'uppercase',
    },

    // ── Loading / empty states ────────────────────────────────────────────────
    loadingState: { alignItems: 'center', paddingVertical: 24, gap: 12 },
    loadingText:  { fontSize: 14, color: C.textMuted, fontWeight: '600' },
    emptyState:   { alignItems: 'center', paddingVertical: 20, gap: 8 },
    emptyIconWrap: {
        width: 52,
        height: 52,
        borderRadius: RADIUS.lg,
        backgroundColor: C.bgAlt,
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: 4,
    },
    emptyTitle: {
        fontSize: 16,
        fontWeight: '700',
        color: C.textPrimary,
        letterSpacing: -0.2,
    },
    emptyText: {
        fontSize: 14,
        color: C.textMuted,
        lineHeight: 20,
        textAlign: 'center',
        paddingHorizontal: 12,
    },
    inlineEmpty: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginTop: 12,
        padding: 14,
        backgroundColor: C.bgAlt,
        borderRadius: RADIUS.md,
    },
    inlineEmptyText: {
        fontSize: 14,
        color: C.textMuted,
        fontWeight: '500',
        flex: 1,
    },
    firstReminderButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        backgroundColor: C.primary,
        borderRadius: RADIUS.xl,
        paddingVertical: 14,
        marginTop: 4,
        minHeight: 44,
    },
    firstReminderButtonText: {
        color: C.textInverse,
        fontSize: 15,
        fontWeight: '700',
    },

    // ── Bar chart ─────────────────────────────────────────────────────────────
    chart: {
        height: 160,
        flexDirection: 'row',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        marginTop: 20,
    },
    barWrapper: { alignItems: 'center', flex: 1 },
    barTrack: {
        height: 110,
        width: 20,
        backgroundColor: C.bgAlt,
        borderRadius: RADIUS.full,
        justifyContent: 'flex-end',
        overflow: 'hidden',
    },
    bar: { width: '100%', borderRadius: RADIUS.full },
    dayLabel: { marginTop: 8, fontSize: 12, color: C.textMuted, fontWeight: '600' },
    selectedDayLabel: { color: C.primary, fontWeight: '700' },

    // ── Heatmap ───────────────────────────────────────────────────────────────
    weekLabels: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginTop: 18,
        marginBottom: 8,
    },
    weekLabel: {
        width: 38,
        textAlign: 'center',
        fontSize: 12,
        fontWeight: '700',
        color: C.textMuted,
    },
    heatmapGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    heatmapDay: {
        width: 38,
        height: 38,
        borderRadius: RADIUS.sm,
        alignItems: 'center',
        justifyContent: 'center',
    },
    heatmapOffset:  { backgroundColor: 'transparent' },
    selectedHeatmapDay: { borderWidth: 2, borderColor: C.textPrimary },
    heatmapHigh:    { backgroundColor: '#BBF7D0' },
    heatmapMedium:  { backgroundColor: '#FEF3C7' },
    heatmapLow:     { backgroundColor: '#FED7AA' },
    heatmapMissed:  { backgroundColor: '#FECACA' },
    heatmapFuture:  { backgroundColor: C.bgAlt },
    heatmapEmpty:   { backgroundColor: C.border },
    heatmapNoData:  { backgroundColor: '#CBD5E1' },
    heatmapPending: { backgroundColor: '#DBEAFE' },
    heatmapText: { fontSize: 12, fontWeight: '700', color: C.textPrimary },
    legendRow: {
        flexDirection: 'row',
        justifyContent: 'center',
        flexWrap: 'wrap',
        gap: 12,
        marginTop: 16,
    },
    legendItem:  { flexDirection: 'row', alignItems: 'center', gap: 5 },
    legendSwatch: { width: 12, height: 12, borderRadius: 3 },
    legendLabel: { fontSize: 11, color: C.textMuted, fontWeight: '600' },

    // ── Reminder row ──────────────────────────────────────────────────────────
    reminderRow: {
        paddingVertical: 14,
        borderTopWidth: 1,
        borderTopColor: C.bgAlt,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    reminderRowInactive: { opacity: 0.6 },
    reminderStatusBar: { width: 3, height: 36, borderRadius: RADIUS.full, flexShrink: 0 },
    reminderTextBlock: { flex: 1 },
    reminderNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    reminderName: {
        fontSize: 15,
        fontWeight: '700',
        color: C.textPrimary,
        letterSpacing: -0.2,
    },
    reminderTime: { fontSize: 13, color: C.textMuted, marginTop: 2 },
    inactiveTag: {
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderRadius: RADIUS.full,
        backgroundColor: C.bgAlt,
    },
    inactiveTagText: {
        fontSize: 10,
        fontWeight: '700',
        color: C.textMuted,
        textTransform: 'uppercase',
        letterSpacing: 0.4,
    },
    statusPill: {
        paddingHorizontal: 11,
        paddingVertical: 6,
        borderRadius: RADIUS.full,
    },
    statusText:   { fontSize: 12, fontWeight: '700' },
    takenPill:    { backgroundColor: '#DCFCE7' },
    missedPill:   { backgroundColor: '#FEE2E2' },
    skippedPill:  { backgroundColor: '#FEF3C7' },
    snoozedPill:  { backgroundColor: '#DBEAFE' },
    pendingPill:  { backgroundColor: C.bgAlt },
    takenText:    { color: '#15803D' },
    missedText:   { color: '#B91C1C' },
    skippedText:  { color: '#B45309' },
    snoozedText:  { color: '#1D4ED8' },
    pendingText:  { color: C.textMuted },

    // ── Breakdown section header ──────────────────────────────────────────────
    bdSection: { marginBottom: 10, marginTop: 4 },
    bdSectionTitle: {
        fontSize: 20,
        fontWeight: '700',
        color: C.textPrimary,
        letterSpacing: -0.3,
        marginBottom: 3,
    },
    bdSectionSub: { fontSize: 13, color: C.textMuted, fontWeight: '500' },

    // ── Breakdown cards (bc*) ─────────────────────────────────────────────────
    bcCard: {
        backgroundColor: C.bgSurface,
        borderRadius: RADIUS.xl,
        padding: 18,
        marginBottom: 10,
        borderWidth: 1,
        borderColor: C.border,
    },
    bcHeader: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        marginBottom: 12,
        gap: 12,
    },
    bcNameRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginBottom: 3,
    },
    bcName: {
        fontSize: 16,
        fontWeight: '700',
        color: C.textPrimary,
        letterSpacing: -0.3,
        flexShrink: 1,
    },
    bcDeletedPill: {
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: RADIUS.full,
        backgroundColor: C.bgAlt,
    },
    bcDeletedText: {
        fontSize: 11,
        fontWeight: '700',
        color: C.textMuted,
    },
    bcMeta: { fontSize: 13, color: C.textMuted, fontWeight: '500' },
    bcAdherenceBlock: { alignItems: 'flex-end', flexShrink: 0 },
    bcAdherencePct: { fontSize: 24, fontWeight: '800', letterSpacing: -0.8, lineHeight: 28 },
    bcAdherenceLabel: {
        fontSize: 10,
        fontWeight: '600',
        color: C.textMuted,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        marginTop: 2,
    },
    bcProgressTrack: {
        height: 5,
        backgroundColor: C.bgAlt,
        borderRadius: RADIUS.full,
        marginBottom: 6,
        overflow: 'hidden',
    },
    bcProgressFill: { height: '100%', borderRadius: RADIUS.full },
    bcCountLine: { fontSize: 12, color: C.textMuted, fontWeight: '500', marginBottom: 12 },
    bcChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 },
    bcChip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: RADIUS.full },
    bcChipText: { fontSize: 12, fontWeight: '700' },
    bcFooter: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        borderTopWidth: 1,
        borderTopColor: C.bgAlt,
        paddingTop: 10,
    },
    bcSummary: { fontSize: 13, color: C.textSecondary, fontWeight: '500', flex: 1 },
    bcCta: { flexDirection: 'row', alignItems: 'center', gap: 2 },
    bcCtaText: { fontSize: 13, color: C.primary, fontWeight: '700' },
});
