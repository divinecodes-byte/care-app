import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    AppState,
    AppStateStatus,
    Linking,
    Platform,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { StatusBadge, StatusTone } from '@/components/AccessiblePrimitives';
import { formatDateStringForDisplay } from '@/components/DatePickerField';
import { OfflineBanner, SectionErrorState, announceStateChange } from '@/components/StateViews';
import { SettingsSheet } from '@/components/settings-sheet';
import { RADIUS, SHADOW, SPACING, ThemeColors } from '@/constants/theme';
import { clearAccountScopedLocalState } from '@/lib/accountCleanup';
import { ErrorCategory, classifyScreenError } from '@/lib/asyncStateCore';
import { ERROR_CATEGORY_TRANSLATION_KEYS } from '@/lib/errorClassification';
import { useLanguage, useStatusLabel } from '@/lib/i18n/context';
import { useThemeColors } from '@/lib/theme';
import { useRequestGeneration } from '@/lib/useRequestGeneration';
import { supabase } from '@/lib/supabase';
import {
    cancelReminderOccurrenceNotification,
    getNotificationPreviewMode,
    isRecipientServerPushEnabled,
    registerPushToken,
    requestNotificationPermissions,
    scheduleSnoozeNotification,
    syncRecipientReminderNotifications,
} from '@/lib/notifications';
import { isValidIanaTimezone, repairAndRefetchTimezone, syncCurrentUserTimezone } from '@/lib/timezone';
import { resolveOrganizerDisplay } from '@/lib/organizerDisplay';
import { showAlertOnce } from '@/lib/alertGuard';
import { REMINDER_ERROR_TRANSLATION_KEYS } from '@/lib/reminderErrors';
import { respondToReminderOccurrence } from '@/lib/reminderLifecycle';
import { getZonedAnalyticsStartDateString, isoWeekdayOfDateString } from '@/lib/reminderStatus';
import { fetchTasksForRecipient, TaskWithSummary } from '@/lib/taskData';
import { TASK_UPCOMING_LOOKAHEAD_DAYS } from '@/lib/todayFeedCore';
import { getNextParticipantMidnight, getParticipantLocalDateKey } from '@/lib/participantTodayContext';
import { isPastNoResponseWindowAt, zonedDateTimeToUtc } from '@/lib/zonedTime';

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
    today_status?: ReminderStatus;
    snoozed_until?: string | null;
    /** Populated after the fetch below -- which organizer created this reminder (multi-organizer attribution, Week 4 Task #2). */
    organizerName?: string;
};

// Today shows only a small, bounded preview of overdue tasks (newest-overdue
// first) — never a participant's entire overdue lifetime on dashboard mount
// (Week 4 Task #3). The complete, cursor-paginated history is always
// reachable via the "View all overdue" link to app/overdue-tasks.tsx, which
// calls get_participant_overdue_task_occurrences directly — see
// docs/task-overdue-occurrence-model.md.
const OVERDUE_PREVIEW_CAP = 5;

const TYPE_ICONS: Record<string, string> = {
    medication:  '💊',
    hydration:   '💧',
    appointment: '📅',
    meal:        '🍽️',
    exercise:    '🏃',
    other:       '•',
};

const TYPE_LABEL_KEYS: Record<string, string> = {
    medication:  'reminderForm.typeMedication',
    hydration:   'reminderForm.typeHydration',
    appointment: 'reminderForm.typeAppointment',
    meal:        'reminderForm.typeMeal',
    exercise:    'reminderForm.typeExercise',
    other:       'reminderForm.typeOther',
};

// ─── Pure helpers (unchanged) ────────────────────────────────────────────────
// getTodayDateString()/shouldShowToday() (device-local) were removed here —
// every "today" calendar decision now goes through
// lib/participantTodayContext.ts using the participant's own stored
// profiles.timezone. See docs/today-hub-model.md.

function formatTime(time: string) {
    const [hourString, minuteString] = time.split(':');
    let hour = Number(hourString);
    const suffix = hour >= 12 ? 'PM' : 'AM';
    if (hour === 0) hour = 12;
    if (hour > 12) hour -= 12;
    return `${hour}:${minuteString} ${suffix}`;
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function getStatusColors(status: ReminderStatus | undefined, C: ThemeColors) {
    if (status === 'taken')   return { bg: '#DCFCE7', text: '#15803D', accent: C.success };
    if (status === 'missed')  return { bg: '#FEE2E2', text: '#B91C1C', accent: C.error };
    if (status === 'skipped') return { bg: '#FEF3C7', text: '#B45309', accent: '#D97706' };
    if (status === 'snoozed') return { bg: '#DBEAFE', text: '#1D4ED8', accent: C.primary };
    return { bg: C.bgAlt, text: C.textMuted, accent: C.border };
}

function formatDayLabel(locale: string) {
    return new Date().toLocaleDateString(locale, {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
    });
}

function getGreeting(t: (key: string) => string): string {
    const hour = new Date().getHours();
    if (hour < 5)  return t('participantDashboard.goodNight');
    if (hour < 12) return t('participantDashboard.goodMorning');
    if (hour < 17) return t('participantDashboard.goodAfternoon');
    return t('participantDashboard.goodEvening');
}

function getTimeHint(reminder: Reminder, t: (key: string, vars?: Record<string, string | number>) => string): string | null {
    const status = reminder.today_status;

    if (status === 'snoozed' && reminder.snoozed_until) {
        const until = new Date(reminder.snoozed_until);
        if (until.getTime() <= Date.now()) return t('participantDashboard.snoozeEnded');
        const h = until.getHours();
        const m = until.getMinutes();
        const suffix = h >= 12 ? 'PM' : 'AM';
        const displayH = h === 0 ? 12 : h > 12 ? h - 12 : h;
        return t('participantDashboard.until', { time: `${displayH}:${String(m).padStart(2, '0')} ${suffix}` });
    }

    if (status === 'pending') {
        const [rh, rm] = reminder.time_of_day.split(':').map(Number);
        const today = new Date();
        const scheduled = new Date(today.getFullYear(), today.getMonth(), today.getDate(), rh, rm, 0, 0);
        const diffMin = Math.round((scheduled.getTime() - Date.now()) / 60000);

        if (diffMin > 60) {
            const hrs  = Math.floor(diffMin / 60);
            const mins = diffMin % 60;
            return mins > 0
                ? t('participantDashboard.inHoursMinutes', { h: hrs, m: mins })
                : t('participantDashboard.inHours', { h: hrs });
        }
        if (diffMin > 1)  return t('participantDashboard.inMinutes', { n: diffMin });
        if (diffMin >= 0) return t('participantDashboard.now');

        // Past scheduled time but still inside the response window
        const missedAt   = new Date(scheduled.getTime() + reminder.no_response_minutes * 60 * 1000);
        const windowLeft = Math.round((missedAt.getTime() - Date.now()) / 60000);
        if (windowLeft > 0) return t('participantDashboard.minLeft', { n: windowLeft });
    }

    return null;
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function RecipientDashboard() {
    const C = useThemeColors();
    const { t, language } = useLanguage();
    const formatStatus = useStatusLabel();
    const styles = useMemo(() => createStyles(C), [C]);
    const [reminders, setReminders]               = useState<Reminder[]>([]);
    const [loading, setLoading]                   = useState(true);
    const [refreshing, setRefreshing]             = useState(false);
    // Set only when a fetch fails — reminders/hasConnection are left
    // exactly as they were (never cleared), so a background refresh
    // failure never blanks out already-visible, still-valid data. Only
    // rendered as a full-screen ErrorState when there is truly nothing to
    // show yet (first load failed); otherwise shown as a compact
    // SectionErrorState above the still-visible list.
    const [loadError, setLoadError]               = useState<ErrorCategory | null>(null);
    const [savingReminderId, setSavingReminderId] = useState<string | null>(null);
    const [settingsVisible, setSettingsVisible]   = useState(false);
    const [notifDenied, setNotifDenied]           = useState(false);
    // null while unknown; distinguishes "never connected to an organizer"
    // from "connected, nothing due right now" for the empty state below —
    // both used to show the identical "All clear" copy, which stranded a
    // recipient who backed out of join-invite with no way back in.
    const [hasConnection, setHasConnection]       = useState<boolean | null>(null);
    // True when this recipient has no *currently* accepted connection but
    // has at least one past connection row with status 'ended' — distinct
    // from "never connected," which otherwise shows an identical
    // "no connection yet" screen with no acknowledgment that a connection
    // existed and ended (organizer- or participant-initiated).
    const [connectionEnded, setConnectionEnded]   = useState(false);
    const [recipientId, setRecipientId]           = useState<string | null>(null);
    // Authoritative for every Today-feed calendar decision (see
    // lib/participantTodayContext.ts) — null until the first successful
    // loadReminders() completes; every classification below must defer
    // rather than fall back to a hardcoded default or the device's own
    // timezone while null.
    const [participantTimezone, setParticipantTimezone] = useState<string | null>(null);
    // True only once loadReminders() has confirmed profiles.timezone is
    // missing/invalid AND the repair-then-refetch attempt
    // (repairAndRefetchTimezone) still couldn't produce a valid value —
    // distinct from "still loading" (participantTimezone null, this false).
    // Drives a compact, retryable notice instead of ever guessing a zone.
    const [timezoneUnavailable, setTimezoneUnavailable] = useState(false);
    // Detects an authenticated-user change between loads (e.g. a session
    // swap without a full remount) so the PREVIOUS user's timezone can
    // never be left standing while the new one's is being resolved.
    const lastAuthUserIdRef = useRef<string | null>(null);
    // True once the organizer has created at least one active reminder,
    // regardless of whether any is due today — distinguishes "organizer
    // hasn't set anything up yet" from "reminders exist, just none today,"
    // which previously shared the identical "All clear" empty state.
    const [hasAnyReminders, setHasAnyReminders]   = useState(false);
    // Reset on every new load attempt (not just on dismiss) so a banner
    // dismissed while still offline reappears on the very next failed
    // request rather than staying permanently hidden for this session.
    const [offlineDismissed, setOfflineDismissed] = useState(false);
    const appStateRef = useRef<AppStateStatus>(AppState.currentState);
    const pushRegistrationAttemptedRef = useRef(false);
    const hasLoadedOnceRef = useRef(false);
    const { start: startLoad, isCurrent: isLoadCurrent } = useRequestGeneration();

    // Flexible tasks — fetched and failable entirely independently of
    // reminders (Phase 5: "partial reminder failure must not hide tasks"
    // and vice versa). Own request-generation guard so a stale response
    // (e.g. after a fast account switch) can never overwrite a newer one.
    const [taskStatus, setTaskStatus]   = useState<'loading' | 'ready' | 'error' | 'unavailable'>('loading');
    const [taskSummaries, setTaskSummaries] = useState<TaskWithSummary[]>([]);
    const { start: startTaskLoad, isCurrent: isTaskLoadCurrent } = useRequestGeneration();
    const lastLoadedDateRef = useRef<string>('');

    // Purely cosmetic — a subtle "From a routine" label on cards whose
    // reminder/task id happens to be a routine_instance_items member.
    // Independent of the reminders/tasks load paths above: a failure here
    // never blocks or hides the underlying reminder/task card, and it
    // re-fetches whenever recipientId changes (including an account
    // switch), so it can never carry a prior account's membership set
    // forward.
    const [routineMemberReminderIds, setRoutineMemberReminderIds] = useState<Set<string>>(new Set());
    const [routineMemberTaskIds, setRoutineMemberTaskIds] = useState<Set<string>>(new Set());

    useEffect(() => {
        if (!recipientId) {
            setRoutineMemberReminderIds(new Set());
            setRoutineMemberTaskIds(new Set());
            return;
        }
        let cancelled = false;
        (async () => {
            const { data: instances } = await supabase.from('routine_instances').select('id').eq('participant_id', recipientId);
            const instanceIds = (instances ?? []).map((row) => row.id);
            if (instanceIds.length === 0) {
                if (!cancelled) { setRoutineMemberReminderIds(new Set()); setRoutineMemberTaskIds(new Set()); }
                return;
            }
            const { data: memberItems } = await supabase
                .from('routine_instance_items')
                .select('item_kind, reminder_id, task_id')
                .in('routine_instance_id', instanceIds);
            if (cancelled) return;
            const reminderIds = new Set<string>();
            const taskIds = new Set<string>();
            for (const item of memberItems ?? []) {
                if (item.item_kind === 'reminder' && item.reminder_id) reminderIds.add(item.reminder_id);
                if (item.item_kind === 'task' && item.task_id) taskIds.add(item.task_id);
            }
            setRoutineMemberReminderIds(reminderIds);
            setRoutineMemberTaskIds(taskIds);
        })();
        return () => { cancelled = true; };
    }, [recipientId]);

    const loadTasks = useCallback(async () => {
        const generation = startTaskLoad();
        setTaskStatus((s) => (s === 'ready' ? s : 'loading'));
        try {
            const { data: { user } } = await supabase.auth.getUser();
            if (!isTaskLoadCurrent(generation)) return;
            if (!user) { setTaskSummaries([]); setTaskStatus('ready'); return; }

            const { data: profile, error: profileError } = await supabase.from('profiles').select('timezone').eq('id', user.id).maybeSingle();
            if (!isTaskLoadCurrent(generation)) return;
            if (profileError) { setTaskStatus('error'); return; }

            // profiles.timezone is authoritative; a missing/invalid value
            // triggers the same repair-then-refetch attempt as the
            // reminders load (repairAndRefetchTimezone) — never a
            // hardcoded default and never this device's own timezone,
            // which would silently reintroduce a device-vs-participant
            // mismatch for exactly the participant who most needs the
            // stored value to be authoritative (their sync hasn't
            // succeeded yet). If it's still unavailable after the repair
            // attempt, tasks are left unclassified rather than guessed.
            let taskTimezone = isValidIanaTimezone(profile?.timezone) ? profile!.timezone : null;
            if (!taskTimezone) {
                taskTimezone = await repairAndRefetchTimezone(user.id);
                if (!isTaskLoadCurrent(generation)) return;
            }
            if (!taskTimezone) {
                setTaskSummaries([]);
                setTaskStatus('unavailable');
                return;
            }

            const rows = await fetchTasksForRecipient(user.id);
            if (!isTaskLoadCurrent(generation)) return;

            setTaskSummaries(rows.filter((r) => r.task.is_active));
            setTaskStatus('ready');
        } catch {
            if (isTaskLoadCurrent(generation)) setTaskStatus('error');
        }
    }, [startTaskLoad, isTaskLoadCurrent]);

    const refreshToday = useCallback(() => {
        loadReminders();
        loadTasks();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loadTasks]);

    async function loadReminders() {
        const generation = startLoad();
        // First load (no data on screen yet) shows the full loading card;
        // every subsequent call (focus refetch, pull-to-refresh, AppState
        // foreground) is a "refresh" — existing reminders stay visible the
        // whole time, with only a discreet indicator.
        if (hasLoadedOnceRef.current) setRefreshing(true); else setLoading(true);
        // Captured before clearing, so a load that recovers from a prior
        // error/offline banner can announce that fact to VoiceOver once the
        // banner itself disappears (it has no live region of its own once
        // it's gone — see components/StateViews.tsx's announceStateChange).
        const wasRecoveringFromError = loadError !== null;
        setLoadError(null);
        setOfflineDismissed(false);

        const { data: { user }, error: userError } = await supabase.auth.getUser();

        if (userError || !user) {
            setLoading(false);
            setRefreshing(false);
            router.replace('/signin');
            return;
        }

        // Never let a previous account's already-resolved timezone (and
        // whatever it classified) stand while a different user's load is
        // in flight — cleared synchronously, before any further await, the
        // moment a user-id change is detected between loads.
        if (lastAuthUserIdRef.current !== null && lastAuthUserIdRef.current !== user.id) {
            setParticipantTimezone(null);
            setTimezoneUnavailable(false);
        }
        lastAuthUserIdRef.current = user.id;

        // A tombstoned account must never reach reminder data, even if a
        // technically-valid session slipped through (e.g. Auth deletion
        // partially failed upstream but the profile tombstone is already
        // in place). No timezone sync, no push registration, no
        // notification sync — this returns before any of that runs.
        //
        // `timezone` is fetched in this same query — profiles.timezone (not
        // this device's own clock, and not a hardcoded default) is the sole
        // authoritative source for every Today-feed calendar decision below
        // (see lib/participantTodayContext.ts and docs/today-hub-model.md).
        // The fire-and-forget syncCurrentUserTimezone() call further below
        // keeps this column following the device over time, but this load
        // always reads whatever is CURRENTLY stored, never assumes the sync
        // already ran.
        const { data: statusRow, error: statusError } = await supabase
            .from('profiles')
            .select('account_status, timezone')
            .eq('id', user.id)
            .maybeSingle();

        if (!isLoadCurrent(generation)) return; // a newer load has since started

        if (statusError) {
            setLoading(false);
            setRefreshing(false);
            hasLoadedOnceRef.current = true;
            setLoadError(classifyScreenError(statusError.message));
            return;
        }

        if (statusRow?.account_status === 'deleted') {
            setLoading(false);
            setRefreshing(false);
            setParticipantTimezone(null);
            setTimezoneUnavailable(false);
            await clearAccountScopedLocalState().catch(() => {});
            await supabase.auth.signOut().catch(() => {});
            router.replace('/signin');
            return;
        }

        setRecipientId(user.id);

        // Missing/invalid triggers the established repair-then-refetch
        // path (repairAndRefetchTimezone — reconciles this device's own
        // resolvable timezone into the profile, a no-op if already fine)
        // and re-reads once. Never falls back to a hardcoded default or
        // the device's own timezone for classification — if it's still
        // unavailable after the attempt, this load stops here, leaving
        // reminders/tasks unclassified rather than guessed (see
        // "unavailable" handling below and docs/today-hub-model.md).
        let timezone = isValidIanaTimezone(statusRow?.timezone) ? statusRow!.timezone : null;
        if (!timezone) {
            timezone = await repairAndRefetchTimezone(user.id);
            if (!isLoadCurrent(generation)) return;
        }

        if (!timezone) {
            setParticipantTimezone(null);
            setTimezoneUnavailable(true);
            setLoading(false);
            setRefreshing(false);
            hasLoadedOnceRef.current = true;
            return;
        }

        setTimezoneUnavailable(false);
        setParticipantTimezone(timezone);

        const { data: connectionRows } = await supabase
            .from('connections')
            .select('id, status, accepted_at')
            .eq('recipient_id', user.id);
        const hasAccepted = (connectionRows ?? []).some((c) => c.status === 'accepted');
        setHasConnection(hasAccepted);
        setConnectionEnded(!hasAccepted && (connectionRows ?? []).some((c) => c.status === 'ended'));
        const acceptedAtByConnection = new Map((connectionRows ?? []).map((c) => [c.id, c.accepted_at as string | null]));

        // Reconcile this device's timezone every load (not just once) — a
        // recipient who travels needs their stored profiles.timezone to
        // follow their current device, since that's what the server-side
        // delivery/missed-detection functions resolve reminder times
        // against. Cheap no-op when unchanged; fire-and-forget so a slow or
        // unavailable network never blocks the dashboard from rendering.
        // Runs before push (re)registration, matching this device's own
        // current identity being established first.
        syncCurrentUserTimezone().catch(console.warn);

        if (!pushRegistrationAttemptedRef.current) {
            pushRegistrationAttemptedRef.current = true;
            registerPushToken(user.id)
                .then((result) => {
                    if (!result.ok) console.warn('[RecipientDashboard] push registration failed', result);
                })
                .catch(console.warn);
        }

        const { data, error } = await supabase
            .from('reminders')
            .select('id, connection_id, caregiver_id, recipient_id, title, reminder_type, notes, time_of_day, frequency, days_of_week, no_response_minutes, created_at')
            .eq('recipient_id', user.id)
            .eq('is_active', true)
            .order('time_of_day', { ascending: true });

        if (!isLoadCurrent(generation)) return;

        if (error) {
            // Never a raw Postgres string, and never clears an already-
            // visible reminder list — a failed background refresh leaves
            // whatever was last showing intact, with a compact retryable
            // notice instead of replacing the whole screen.
            setLoading(false);
            setRefreshing(false);
            hasLoadedOnceRef.current = true;
            setLoadError(classifyScreenError(error.message));
            return;
        }

        const granted = await requestNotificationPermissions();
        setNotifDenied(!granted);

        // Reconcile this device's scheduled local notifications against
        // current server state on every load — this is what cancels a
        // reminder's stale notification once the caregiver has deleted it
        // and this device has synced. See lib/notifications.ts.
        if (granted) {
            syncRecipientReminderNotifications().catch(console.warn);
        }

        // Participant-timezone-authoritative "today" (Phase 6/Today-hub
        // correctness follow-up) — never the device's own local date. See
        // lib/participantTodayContext.ts.
        const todayDate = getParticipantLocalDateKey(new Date(), timezone);
        lastLoadedDateRef.current = todayDate;
        setHasAnyReminders((data || []).length > 0);

        // Exclude reminders not yet eligible today — a reminder created today
        // after its scheduled time-of-day already passed shouldn't be treated
        // as missed; its first occurrence is tomorrow. Both checks now use
        // the participant's own timezone explicitly (isoWeekdayOfDateString/
        // getZonedAnalyticsStartDateString), matching exactly how
        // caregiver-dashboard.tsx already computes this for a caregiver
        // viewing a *different* participant's reminders — the recipient's
        // own view now uses the identical zoned math, not device-local
        // shortcuts.
        const todaysReminders = (data || []).filter((r) =>
            r.days_of_week.includes(isoWeekdayOfDateString(todayDate)) &&
            getZonedAnalyticsStartDateString(acceptedAtByConnection.get(r.connection_id) ?? r.created_at, r.created_at, r.time_of_day, timezone) <= todayDate
        );

        if (todaysReminders.length === 0) {
            if (!isLoadCurrent(generation)) return;
            setReminders([]);
            setLoading(false);
            setRefreshing(false);
            hasLoadedOnceRef.current = true;
            if (wasRecoveringFromError) announceStateChange(t('stateViews.backToNormal'));
            return;
        }

        const reminderIds = todaysReminders.map((r) => r.id);

        // Multi-organizer attribution (Week 4 Task #2): a participant's
        // reminders already aggregate across every accepted connection —
        // batch-fetch each distinct organizer's profile once (never one
        // query per reminder) so the card can show who assigned it,
        // mirroring lib/taskData.ts#fetchTasksForRecipient's identical
        // pattern for tasks.
        const caregiverIds = [...new Set(todaysReminders.map((r) => r.caregiver_id))];
        const { data: organizerProfiles } = caregiverIds.length > 0
            ? await supabase.from('profiles').select('id, full_name, account_status, deleted_at').in('id', caregiverIds)
            : { data: [] as { id: string; full_name: string | null; account_status: string | null; deleted_at: string | null }[] };

        if (!isLoadCurrent(generation)) return;

        const organizerById = new Map((organizerProfiles ?? []).map((p) => [p.id, p]));

        const { data: logs, error: logsError } = await supabase
            .from('reminder_logs')
            .select('reminder_id, status, snoozed_until')
            .eq('recipient_id', user.id)
            .eq('occurrence_date', todayDate)
            .in('reminder_id', reminderIds);

        if (!isLoadCurrent(generation)) return;

        if (logsError) {
            setLoading(false);
            setRefreshing(false);
            hasLoadedOnceRef.current = true;
            setLoadError(classifyScreenError(logsError.message));
            return;
        }

        const remindersWithStatus = todaysReminders.map((reminder) => {
            const matchingLog  = logs?.find((log) => log.reminder_id === reminder.id);
            const logStatus    = matchingLog?.status as ReminderStatus | undefined;
            const snoozedUntil = (matchingLog as any)?.snoozed_until as string | null | undefined;
            // undefined (not null) when the profile row itself wasn't found —
            // resolveOrganizerDisplay() treats that as "unavailable," never
            // as "deleted" (see lib/organizerDisplay.ts).
            const organizerName = resolveOrganizerDisplay(reminder.caregiver_id, organizerById.get(reminder.caregiver_id), t).displayName;

            // Keep any terminal status (taken / snoozed / skipped / missed already in DB).
            if (logStatus && logStatus !== 'pending') {
                return { ...reminder, today_status: logStatus, snoozed_until: snoozedUntil ?? null, organizerName };
            }
            // No log yet, or still pending — check if the response window has
            // expired. The scheduled instant is computed in the
            // PARTICIPANT's own timezone (zonedDateTimeToUtc, the same
            // DST-safe wall-clock -> absolute-instant conversion the server
            // uses) — comparing it to "now" needs no further zone awareness,
            // since both sides are already resolved to real absolute instants.
            const scheduledFor = zonedDateTimeToUtc(todayDate, reminder.time_of_day, timezone);
            const today_status: ReminderStatus = isPastNoResponseWindowAt(scheduledFor, reminder.no_response_minutes)
                ? 'missed'
                : 'pending';
            return { ...reminder, today_status, snoozed_until: null, organizerName };
        });

        if (!isLoadCurrent(generation)) return;

        setReminders(remindersWithStatus);
        setLoading(false);
        setRefreshing(false);
        hasLoadedOnceRef.current = true;
        if (wasRecoveringFromError) announceStateChange(t('stateViews.backToNormal'));

        // 'missed' above is a client-computed DISPLAY status only — this
        // dashboard no longer writes it to reminder_logs itself. The
        // server cron (sync_missed_reminders_db, every 5 minutes) is now
        // the sole authority that persists a missed transition, atomically
        // and race-safe against a concurrent response
        // (respond_to_reminder_occurrence). The previous client-side write
        // here used a read-then-write check that wasn't atomic with the
        // actual upsert, which could in principle race a genuine response
        // arriving at nearly the same moment; removing it doesn't change
        // what the recipient sees (still computed instantly, same as
        // before), only who is allowed to persist it. See
        // docs/reminder-state-model.md.
    }

    useFocusEffect(useCallback(() => { refreshToday(); }, [refreshToday]));

    // Reconcile local notifications the moment the app comes back to the
    // foreground — this is the path that catches a caregiver deletion that
    // happened while this device was backgrounded, without waiting for the
    // recipient to also re-focus the dashboard screen itself. Single
    // listener for the component's lifetime; never re-subscribed.
    useEffect(() => {
        const subscription = AppState.addEventListener('change', (nextState: AppStateStatus) => {
            if (/inactive|background/.test(appStateRef.current) && nextState === 'active') {
                // Timezone first (e.g. the recipient landed after a flight),
                // then reconcile notifications against current server state.
                syncCurrentUserTimezone()
                    .catch(console.warn)
                    .finally(() => {
                        syncRecipientReminderNotifications().catch(console.warn);
                    });
                // Foreground fallback for the scheduled midnight timer below
                // (Phase 4): React Native timers can be throttled/delayed
                // while the app is backgrounded, so this is the backstop —
                // if the PARTICIPANT's own calendar date (never the
                // device's) has changed since the last load, refresh
                // immediately. A no-op the vast majority of the time (same
                // day), so this never becomes aggressive polling.
                if (participantTimezone && lastLoadedDateRef.current && lastLoadedDateRef.current !== getParticipantLocalDateKey(new Date(), participantTimezone)) {
                    refreshToday();
                }
            }
            appStateRef.current = nextState;
        });
        return () => subscription.remove();
    }, [participantTimezone, refreshToday]);

    // Scheduled participant-midnight rollover (Phase 4) — replaces
    // device-midnight/interval-based polling entirely. Recomputes the next
    // participant-local midnight (DST-safe — never assumes a 24-hour day)
    // every time it fires, and whenever `participantTimezone` itself
    // changes (a profile-timezone change, or a fresh value after an
    // account switch) the effect cleanup cancels the stale timer before a
    // new one is scheduled against the new zone.
    useEffect(() => {
        if (!participantTimezone) return;

        let timer: ReturnType<typeof setTimeout> | null = null;
        let cancelled = false;

        function scheduleNext() {
            if (cancelled) return;
            const next = getNextParticipantMidnight(new Date(), participantTimezone!);
            // A small buffer past the boundary avoids firing a hair early
            // due to timer-resolution jitter and landing back in "today".
            const delayMs = Math.max(next.getTime() - Date.now(), 1000) + 2000;
            timer = setTimeout(() => {
                if (cancelled) return;
                refreshToday();
                scheduleNext();
            }, delayMs);
        }

        scheduleNext();
        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        };
    }, [participantTimezone, refreshToday]);

    async function saveReminderAction(reminder: Reminder, status: 'taken' | 'skipped' | 'snoozed') {
        // The action buttons are swapped out for a "saving" box while
        // savingReminderId is set, but that swap only takes effect on the
        // next render -- this synchronous guard is the real protection
        // against a rapid double-tap of the same card queuing two RPCs.
        if (savingReminderId === reminder.id) return;

        // A reminder card is normally only visible/tappable once
        // loadReminders() has resolved a valid timezone, but a stale card
        // can still be on screen if the timezone became unavailable on a
        // later refresh (reminders are left visible, never blanked, on a
        // background-refresh failure — see loadReminders). Never guess a
        // zone to compute today's date in that case; block the action
        // instead.
        if (!participantTimezone) {
            showAlertOnce(t('participantDashboard.saveErrorTitle'), t('participantDashboard.timezoneUnavailableText'));
            return;
        }

        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        setSavingReminderId(reminder.id);

        const todayDate = getParticipantLocalDateKey(new Date(), participantTimezone);

        // The server (respond_to_reminder_occurrence) is the sole author
        // of the persisted log — it validates ownership, reminder.is_active,
        // connection.status, occurrence eligibility, and legal state
        // transitions, and computes occurrence_date/scheduled_for/
        // snoozed_until itself from the recipient's own stored timezone
        // rather than trusting anything the client sends. See
        // lib/reminderLifecycle.ts and docs/reminder-state-model.md.
        const result = await respondToReminderOccurrence(reminder.id, status);

        setSavingReminderId(null);

        if (!result.ok) {
            showAlertOnce(t('participantDashboard.saveErrorTitle'), t(REMINDER_ERROR_TRANSLATION_KEYS[result.kind]));
            return;
        }

        const snoozedUntil = result.log.snoozed_until;

        // A real response now exists for today — cancel only today's
        // occurrence notification. Future occurrences are untouched.
        cancelReminderOccurrenceNotification(reminder.id, todayDate).catch(console.warn);

        // Snoozing gets its own one-shot re-alert at the snooze deadline.
        // Server-authoritative recipients get this from
        // claim_due_recipient_snooze_deliveries() instead (reminder_logs
        // .snoozed_until is the only state that matters there) — scheduling
        // a local one too would risk a duplicate alert.
        if (status === 'snoozed' && snoozedUntil && !(await isRecipientServerPushEnabled())) {
            const mode = await getNotificationPreviewMode();
            scheduleSnoozeNotification(
                { id: reminder.id, title: reminder.title, reminder_type: reminder.reminder_type },
                todayDate,
                snoozedUntil,
                mode
            ).catch(console.warn);
        }

        // Full reconcile as a catch-all — cheap and idempotent, and covers
        // any reminder deletions that landed on this device in the moments
        // around this response.
        syncRecipientReminderNotifications().catch(console.warn);

        setReminders((current) =>
            current.map((r) =>
                r.id === reminder.id ? { ...r, today_status: result.log.status } : r
            )
        );
    }

    // ── Task bucketing (Phase 4 Today hierarchy, task side) ────────────────
    // Operates on the already-computed TaskWithSummary[] from loadTasks
    // (get_participant_task_summaries already ran server-side inside
    // fetchTasksForRecipient — see loadTasks above) — grouping rules mirror
    // lib/todayFeedCore.ts#buildTodayItems exactly (same bucket names,
    // same TASK_UPCOMING_LOOKAHEAD_DAYS bound) without a second redundant
    // summary pass, since the summary is already in hand.
    //
    // Gated on participantTimezone being loaded (Phase 3: "do not briefly
    // classify items using another timezone") — every bucket is empty
    // until then, rather than momentarily computing against any fallback.
    const todayStr = participantTimezone ? getParticipantLocalDateKey(new Date(), participantTimezone) : null;
    const { overdueTasks, overdueTaskCount, dueTodayTasks, openOtherTasks, upcomingTasks, terminalTodayTasks } = useMemo(() => {
        const overdue: TaskWithSummary[] = [];
        const dueToday: TaskWithSummary[] = [];
        const openOther: TaskWithSummary[] = [];
        const upcoming: TaskWithSummary[] = [];
        const terminalToday: TaskWithSummary[] = [];

        if (!todayStr) {
            return { overdueTasks: overdue, overdueTaskCount: 0, dueTodayTasks: dueToday, openOtherTasks: openOther, upcomingTasks: upcoming, terminalTodayTasks: terminalToday };
        }

        for (const entry of taskSummaries) {
            const { task, summary } = entry;
            if (summary.status === 'overdue') {
                overdue.push(entry);
            } else if (summary.status === 'open') {
                const dueDate = task.frequency === 'one_time' ? task.due_date : summary.actionableDate;
                if (dueDate === todayStr) dueToday.push(entry);
                else openOther.push(entry);
            } else if (summary.status === 'upcoming') {
                const [sy, sm, sd] = task.start_date.split('-').map(Number);
                const [ty, tm, td] = todayStr.split('-').map(Number);
                const daysAhead = Math.round((Date.UTC(sy, sm - 1, sd) - Date.UTC(ty, tm - 1, td)) / 86400000);
                if (daysAhead <= TASK_UPCOMING_LOOKAHEAD_DAYS) upcoming.push(entry);
            } else if (summary.lastResolved?.occurrence_date === todayStr) {
                terminalToday.push(entry);
            }
        }

        // Today shows only a small, bounded, newest-overdue-first preview
        // (see OVERDUE_PREVIEW_CAP) — the full count and complete history
        // remain reachable via "View all overdue" regardless of the cap.
        overdue.sort((a, b) => {
            const ad = a.summary.actionableDate ?? '';
            const bd = b.summary.actionableDate ?? '';
            return ad < bd ? 1 : ad > bd ? -1 : a.task.id < b.task.id ? -1 : 1;
        });
        const overdueTaskCount = overdue.length;
        const overduePreview = overdue.slice(0, OVERDUE_PREVIEW_CAP);

        return { overdueTasks: overduePreview, overdueTaskCount, dueTodayTasks: dueToday, openOtherTasks: openOther, upcomingTasks: upcoming, terminalTodayTasks: terminalToday };
    }, [taskSummaries, todayStr]);

    const [respondingTaskId, setRespondingTaskId] = useState<string | null>(null);

    async function respondTaskAction(taskId: string, occurrenceDate: string, action: 'completed' | 'skipped') {
        if (respondingTaskId) return;
        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        setRespondingTaskId(taskId);
        const { error } = await supabase.rpc('respond_to_task_occurrence', { p_task_id: taskId, p_occurrence_date: occurrenceDate, p_status: action });
        setRespondingTaskId(null);
        if (error) {
            showAlertOnce(t('tasksSection.loadFailedTitle'), t('tasksSection.loadFailedText'));
            return;
        }
        loadTasks();
    }

    return (
        <SafeAreaView style={styles.container}>
            <ScrollView
                contentContainerStyle={styles.content}
                showsVerticalScrollIndicator={false}
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={refreshToday}
                        tintColor={C.primary}
                        colors={[C.primary]}
                    />
                }
            >
                {/* Header */}
                <View style={styles.header}>
                    <View style={styles.headerTextBlock}>
                        <Text style={styles.heading} numberOfLines={2} accessibilityRole="header">
                            {getGreeting(t)}
                        </Text>
                        <Text style={styles.subheading} numberOfLines={1}>
                            {formatDayLabel(language === 'es' ? 'es-ES' : 'en-US')}
                        </Text>
                    </View>
                    <TouchableOpacity
                        style={styles.alertIconButton}
                        onPress={() => setSettingsVisible(true)}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        accessibilityRole="button"
                        accessibilityLabel={t('settings.title')}
                    >
                        <Ionicons name="settings-outline" size={22} color={C.primary} />
                    </TouchableOpacity>
                </View>

                {/* Overdue flexible tasks — the single highest-priority
                    Today group (Phase 4): shown before even the reminder
                    progress summary, but styled as clearly-actionable
                    rather than alarmist (no red/urgent color scheme — see
                    docs/today-hub-model.md). */}
                {overdueTasks.length > 0 && (
                    <View style={styles.taskSectionBlock}>
                        <Text style={styles.taskSectionHeading} accessibilityRole="header">{t('tasksSection.overdueSection')}</Text>
                        {overdueTasks.map((entry) => (
                            <TaskTodayCard key={entry.task.id} entry={entry} C={C} t={t} styles={styles} respondingTaskId={respondingTaskId} onRespond={respondTaskAction} isRoutineMember={routineMemberTaskIds.has(entry.task.id)} />
                        ))}
                        <TouchableOpacity
                            style={styles.viewAllOverdueRow}
                            onPress={() => router.push('/overdue-tasks')}
                            accessibilityRole="button"
                            accessibilityLabel={
                                overdueTaskCount > overdueTasks.length
                                    ? t('tasksSection.viewAllOverdueCount', { n: overdueTaskCount })
                                    : t('tasksSection.viewAllOverdue')
                            }
                        >
                            <Text style={styles.viewAllOverdueText}>
                                {overdueTaskCount > overdueTasks.length
                                    ? t('tasksSection.viewAllOverdueCount', { n: overdueTaskCount })
                                    : t('tasksSection.viewAllOverdue')}
                            </Text>
                            <Ionicons name="chevron-forward" size={16} color={C.primary} />
                        </TouchableOpacity>
                    </View>
                )}

                {/* Today's progress summary */}
                {!loading && reminders.length > 0 && (() => {
                    const done  = reminders.filter((r) => r.today_status === 'taken' || r.today_status === 'skipped').length;
                    const total = reminders.length;
                    const pct   = total === 0 ? 0 : Math.round((done / total) * 100);
                    return (
                        <View style={[styles.progressCard, SHADOW.xs]}>
                            <View style={styles.progressTextRow}>
                                <Text style={styles.progressLabel}>
                                    {done === total
                                        ? t('participantDashboard.allDoneToday')
                                        : t('participantDashboard.doneOfTotalToday', { done, total })}
                                </Text>
                                <Text style={styles.progressPct}>{pct}%</Text>
                            </View>
                            <View style={styles.progressTrack}>
                                <View
                                    style={[
                                        styles.progressFill,
                                        { width: `${pct}%`, backgroundColor: done === total ? C.success : C.primary },
                                    ]}
                                />
                            </View>
                        </View>
                    );
                })()}

                {/* Notification permission denied notice */}
                {notifDenied && !loading && (
                    <View style={styles.notifDeniedBanner}>
                        <Ionicons name="notifications-off-outline" size={16} color="#92400E" />
                        <Text style={styles.notifDeniedText}>
                            {t('participantDashboard.notifDeniedText')}
                        </Text>
                        <TouchableOpacity
                            onPress={() => Linking.openSettings()}
                            accessibilityRole="button"
                            accessibilityLabel={t('participantDashboard.notifDeniedOpenSettings')}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        >
                            <Text style={styles.notifDeniedAction}>{t('participantDashboard.notifDeniedOpenSettings')}</Text>
                        </TouchableOpacity>
                    </View>
                )}

                {/* Loading state — first load only; a background refresh
                    never replaces the already-visible list with this. */}
                {loading && (
                    <View style={[styles.emptyCard, SHADOW.xs]}>
                        <View style={styles.emptyIconWrap}>
                            <ActivityIndicator color={C.primary} size="large" />
                        </View>
                        <Text style={styles.emptyTitle}>{t('participantDashboard.loadingReminders')}</Text>
                        <Text style={styles.emptyText}>{t('participantDashboard.justAMoment')}</Text>
                    </View>
                )}

                {/* Load error — a compact, retryable notice that never
                    replaces or clears an already-visible reminder list
                    (reminders/hasConnection are left untouched on failure). */}
                {!loading && loadError === 'network' && !offlineDismissed && (
                    <OfflineBanner onDismiss={() => setOfflineDismissed(true)} />
                )}
                {!loading && loadError && loadError !== 'network' && (
                    <SectionErrorState
                        text={t(ERROR_CATEGORY_TRANSLATION_KEYS[loadError])}
                        onRetry={loadReminders}
                        retrying={refreshing}
                    />
                )}

                {/* Your stored timezone is missing/invalid and the repair
                    attempt (syncCurrentUserTimezone, re-read once) still
                    couldn't produce a valid value — never guessed with a
                    hardcoded or device zone. Reminders/tasks stay
                    unclassified until this resolves. */}
                {!loading && !loadError && timezoneUnavailable && (
                    <SectionErrorState
                        text={t('participantDashboard.timezoneUnavailableText')}
                        onRetry={loadReminders}
                        retrying={refreshing}
                    />
                )}

                {/* Empty state — a connection existed and has since ended
                    (by either party). Distinct from "never connected" so a
                    recipient isn't left wondering what happened to their
                    organizer with no acknowledgment anything changed. */}
                {!loading && !loadError && reminders.length === 0 && hasConnection === false && connectionEnded && (
                    <View style={[styles.emptyCard, SHADOW.xs]}>
                        <View style={styles.emptyIconWrap}>
                            <Ionicons name="link-outline" size={32} color={C.textMuted} />
                        </View>
                        <Text style={styles.emptyTitle}>{t('participantDashboard.connectionEndedTitle')}</Text>
                        <Text style={styles.emptyText}>
                            {t('participantDashboard.connectionEndedText')}
                        </Text>
                        <TouchableOpacity
                            style={[styles.emptyActionButton, SHADOW.primary]}
                            onPress={() => router.push('/join-invite')}
                            activeOpacity={0.88}
                            accessibilityRole="button"
                            accessibilityLabel={t('participantDashboard.notConnectedAction')}
                        >
                            <Text style={styles.emptyActionButtonText}>{t('participantDashboard.notConnectedAction')}</Text>
                        </TouchableOpacity>
                    </View>
                )}

                {/* Empty state — not connected to any organizer yet.
                    Suppressed while loadError is set so a failed fetch is
                    never misread as "genuinely not connected." */}
                {!loading && !loadError && reminders.length === 0 && hasConnection === false && !connectionEnded && (
                    <View style={[styles.emptyCard, SHADOW.xs]}>
                        <View style={styles.emptyIconWrap}>
                            <Ionicons name="link-outline" size={32} color={C.primary} />
                        </View>
                        <Text style={styles.emptyTitle}>{t('participantDashboard.notConnectedTitle')}</Text>
                        <Text style={styles.emptyText}>
                            {t('participantDashboard.notConnectedText')}
                        </Text>
                        <TouchableOpacity
                            style={[styles.emptyActionButton, SHADOW.primary]}
                            onPress={() => router.push('/join-invite')}
                            activeOpacity={0.88}
                            accessibilityRole="button"
                            accessibilityLabel={t('participantDashboard.notConnectedAction')}
                        >
                            <Text style={styles.emptyActionButtonText}>{t('participantDashboard.notConnectedAction')}</Text>
                        </TouchableOpacity>
                    </View>
                )}

                {/* Empty state — connected, organizer hasn't created any
                    reminders at all yet (distinct from "nothing due today"
                    below, which implies reminders exist but aren't
                    scheduled for right now). */}
                {!loading && !loadError && reminders.length === 0 && hasConnection !== false && !hasAnyReminders && (
                    <View style={[styles.emptyCard, SHADOW.xs]}>
                        <View style={styles.emptyIconWrap}>
                            <Text style={styles.emptyEmoji}>🕊️</Text>
                        </View>
                        <Text style={styles.emptyTitle}>{t('participantDashboard.noRemindersSetUpTitle')}</Text>
                        <Text style={styles.emptyText}>
                            {t('participantDashboard.noRemindersSetUpText')}
                        </Text>
                    </View>
                )}

                {/* Empty state — connected, reminders exist, nothing due today */}
                {!loading && !loadError && reminders.length === 0 && hasConnection !== false && hasAnyReminders && (
                    <View style={[styles.emptyCard, SHADOW.xs]}>
                        <View style={styles.emptyIconWrap}>
                            <Text style={styles.emptyEmoji}>🕊️</Text>
                        </View>
                        <Text style={styles.emptyTitle}>{t('participantDashboard.allClearTitle')}</Text>
                        <Text style={styles.emptyText}>
                            {t('participantDashboard.allClearText')}
                        </Text>
                    </View>
                )}

                {/* Reminder cards */}
                {!loading && reminders.map((reminder) => {
                    const isSaving   = savingReminderId === reminder.id;
                    const statusInfo = getStatusColors(reminder.today_status, C);
                    const typeIcon   = TYPE_ICONS[reminder.reminder_type] ?? '•';

                    const cardLabel = `${TYPE_LABEL_KEYS[reminder.reminder_type] ? t(TYPE_LABEL_KEYS[reminder.reminder_type]) : reminder.reminder_type}, ${reminder.title}, ${reminder.organizerName ? `${t('tasksSection.organizerLabel', { name: reminder.organizerName })}, ` : ''}${formatTime(reminder.time_of_day)}, ${formatStatus(reminder.today_status ?? 'pending')}`;

                    return (
                        <TouchableOpacity
                            key={reminder.id}
                            style={[styles.reminderCard, SHADOW.sm]}
                            onPress={() => {
                                if (!isSaving) {
                                    router.push({ pathname: '/reminder-alert', params: { reminderId: reminder.id } });
                                }
                            }}
                            activeOpacity={0.95}
                            accessibilityRole="button"
                            accessibilityLabel={cardLabel}
                        >
                            {/* Top accent bar — color-coded by status */}
                            <View style={[styles.cardAccentBar, { backgroundColor: statusInfo.accent }]} />

                            {/* Type + time row */}
                            <View style={styles.cardTopRow}>
                                <View style={styles.typePill}>
                                    <Text style={styles.typePillEmoji}>{typeIcon}</Text>
                                    <Text style={styles.typePillText}>
                                        {TYPE_LABEL_KEYS[reminder.reminder_type] ? t(TYPE_LABEL_KEYS[reminder.reminder_type]) : reminder.reminder_type}
                                    </Text>
                                </View>
                                <Text style={styles.timeText}>{formatTime(reminder.time_of_day)}</Text>
                            </View>

                            {/* Title */}
                            <Text style={styles.reminderTitle}>{reminder.title}</Text>
                            {/* Organizer attribution (Week 4 Task #2) -- always shown, since a
                                participant may have several organizers and two reminders can
                                otherwise share an identical title. Combined with the existing
                                routine-membership label on one line, matching tasks.tsx's
                                equivalent subtitle pattern. */}
                            <Text style={styles.routineMemberLabel}>
                                {reminder.organizerName ? t('tasksSection.organizerLabel', { name: reminder.organizerName }) : ''}
                                {routineMemberReminderIds.has(reminder.id) ? `${reminder.organizerName ? ' · ' : ''}${t('routineDetails.heading')}` : ''}
                            </Text>

                            {/* Notes */}
                            {reminder.notes ? (
                                <Text style={styles.notes}>{reminder.notes}</Text>
                            ) : (
                                <Text style={styles.notesMuted}>{t('participantDashboard.noNotesFromOrganizer')}</Text>
                            )}

                            {/* Status row */}
                            {(() => {
                                const timeHint = getTimeHint(reminder, t);
                                return (
                                    <View style={styles.statusRow}>
                                        <Text style={styles.statusLabel}>{t('participantDashboard.todaysStatus')}</Text>
                                        <View style={styles.statusRight}>
                                            {timeHint ? (
                                                <Text style={styles.timeHint}>{timeHint}</Text>
                                            ) : null}
                                            <View style={[styles.statusPill, { backgroundColor: statusInfo.bg }]}>
                                                <Text style={[styles.statusPillText, { color: statusInfo.text }]}>
                                                    {formatStatus(reminder.today_status ?? 'pending')}
                                                </Text>
                                            </View>
                                        </View>
                                    </View>
                                );
                            })()}

                            {/* Action buttons */}
                            {isSaving ? (
                                <View
                                    style={[styles.savingBox, SHADOW.xs]}
                                    accessible
                                    accessibilityRole="progressbar"
                                    accessibilityLabel={t('participantDashboard.saving')}
                                    accessibilityLiveRegion="polite"
                                >
                                    <ActivityIndicator color={C.primary} />
                                    <Text style={styles.savingText}>{t('participantDashboard.saving')}</Text>
                                </View>
                            ) : reminder.today_status === 'taken' ? (
                                <View style={styles.respondedBox}>
                                    <Ionicons name="checkmark-circle" size={20} color={C.success} />
                                    <Text style={[styles.respondedText, { color: C.success }]}>{t('participantDashboard.markedCompleted')}</Text>
                                </View>
                            ) : reminder.today_status === 'skipped' ? (
                                <View style={styles.respondedBox}>
                                    <Ionicons name="remove-circle-outline" size={20} color={C.textMuted} />
                                    <Text style={[styles.respondedText, { color: C.textMuted }]}>{t('participantDashboard.skippedForToday')}</Text>
                                </View>
                            ) : (
                                <View style={styles.actionArea}>
                                    {/* Primary action — Done */}
                                    <TouchableOpacity
                                        style={[styles.takenButton, SHADOW.sm]}
                                        onPress={() => saveReminderAction(reminder, 'taken')}
                                        activeOpacity={0.88}
                                        accessibilityRole="button"
                                        accessibilityLabel={t('participantDashboard.done')}
                                    >
                                        <Ionicons name="checkmark-circle" size={22} color="#FFFFFF" />
                                        <Text style={styles.takenButtonText}>{t('participantDashboard.done')}</Text>
                                    </TouchableOpacity>

                                    {/* Secondary actions */}
                                    <View style={styles.secondaryButtonRow}>
                                        <TouchableOpacity
                                            style={styles.laterButton}
                                            onPress={() => saveReminderAction(reminder, 'snoozed')}
                                            activeOpacity={0.8}
                                            accessibilityRole="button"
                                            accessibilityLabel={t('participantDashboard.later')}
                                        >
                                            <Ionicons name="time-outline" size={18} color="#92400E" />
                                            <Text style={styles.laterButtonText}>{t('participantDashboard.later')}</Text>
                                        </TouchableOpacity>

                                        <TouchableOpacity
                                            style={styles.skipButton}
                                            onPress={() => saveReminderAction(reminder, 'skipped')}
                                            activeOpacity={0.7}
                                            accessibilityRole="button"
                                            accessibilityLabel={t('participantDashboard.skip')}
                                        >
                                            <Text style={styles.skipButtonText}>{t('participantDashboard.skip')}</Text>
                                        </TouchableOpacity>
                                    </View>
                                </View>
                            )}
                        </TouchableOpacity>
                    );
                })}

                {/* Flexible tasks — due today / open with no deadline, and a
                    short upcoming lookahead. Overdue tasks render near the
                    top of the screen instead (see below the header) — see
                    docs/today-hub-model.md for the full Today ordering and
                    why reminders and tasks are integrated at the group
                    level (each keeps its own existing, independently-tested
                    card rendering) rather than fully interleaved item-by-
                    item. */}
                {taskStatus === 'error' && (
                    <SectionErrorState text={t('tasksSection.loadFailedText')} onRetry={loadTasks} />
                )}
                {taskStatus === 'unavailable' && (
                    <SectionErrorState text={t('tasksSection.timezoneUnavailableText')} onRetry={loadTasks} />
                )}
                {(dueTodayTasks.length > 0 || openOtherTasks.length > 0) && (
                    <View style={styles.taskSectionBlock}>
                        {dueTodayTasks.map((entry) => (
                            <TaskTodayCard key={entry.task.id} entry={entry} C={C} t={t} styles={styles} respondingTaskId={respondingTaskId} onRespond={respondTaskAction} isRoutineMember={routineMemberTaskIds.has(entry.task.id)} />
                        ))}
                        {openOtherTasks.map((entry) => (
                            <TaskTodayCard key={entry.task.id} entry={entry} C={C} t={t} styles={styles} respondingTaskId={respondingTaskId} onRespond={respondTaskAction} isRoutineMember={routineMemberTaskIds.has(entry.task.id)} />
                        ))}
                    </View>
                )}
                {upcomingTasks.length > 0 && (
                    <View style={styles.taskSectionBlock}>
                        <Text style={styles.taskSectionHeading}>{t('tasksSection.upcomingSection')}</Text>
                        {upcomingTasks.map((entry) => (
                            <TaskTodayCard key={entry.task.id} entry={entry} C={C} t={t} styles={styles} respondingTaskId={respondingTaskId} onRespond={respondTaskAction} isRoutineMember={routineMemberTaskIds.has(entry.task.id)} readOnly />
                        ))}
                    </View>
                )}
                {terminalTodayTasks.length > 0 && (
                    <View style={styles.taskSectionBlock}>
                        <Text style={styles.taskSectionHeading}>{t('tasksSection.completedSection')}</Text>
                        {terminalTodayTasks.map((entry) => (
                            <TaskTodayCard key={entry.task.id} entry={entry} C={C} t={t} styles={styles} respondingTaskId={respondingTaskId} onRespond={respondTaskAction} isRoutineMember={routineMemberTaskIds.has(entry.task.id)} readOnly />
                        ))}
                    </View>
                )}
                {hasConnection ? (
                    <TouchableOpacity
                        style={styles.viewAllTasksRow}
                        onPress={() => router.push('/tasks')}
                        accessibilityRole="button"
                        accessibilityLabel={t('tasksSection.heading')}
                    >
                        <Ionicons name="checkbox-outline" size={16} color={C.primary} />
                        <Text style={styles.viewAllTasksText}>{t('tasksSection.heading')}</Text>
                        <Ionicons name="chevron-forward" size={14} color={C.textMuted} />
                    </TouchableOpacity>
                ) : null}
                {hasConnection && recipientId ? (
                    <TouchableOpacity
                        style={styles.viewAllTasksRow}
                        onPress={() => router.push('/activity')}
                        accessibilityRole="button"
                        accessibilityLabel={t('activityFeed.myActivityHeading')}
                    >
                        <Ionicons name="time-outline" size={16} color={C.primary} />
                        <Text style={styles.viewAllTasksText}>{t('activityFeed.myActivityHeading')}</Text>
                        <Ionicons name="chevron-forward" size={14} color={C.textMuted} />
                    </TouchableOpacity>
                ) : null}
            </ScrollView>

            <SettingsSheet
                visible={settingsVisible}
                onClose={() => setSettingsVisible(false)}
                onConnectionEnded={refreshToday}
            />
        </SafeAreaView>
    );
}

// ─── TaskTodayCard ──────────────────────────────────────────────────────────
// A compact task card for the Today hub — deliberately distinct markup from
// the reminder card above (no exact-time display, Complete/Skip only, never
// Snooze) while sharing the same StatusBadge/theme-token visual language so
// the two feel related, not like two different apps. See
// docs/today-hub-model.md.

const TASK_STATUS_TONE: Record<string, StatusTone> = {
    upcoming: 'neutral',
    open: 'neutral',
    overdue: 'warning',
    completed_on_time: 'success',
    completed_late: 'warning',
    skipped: 'error',
};

function TaskTodayCard({
    entry, C, t, styles, respondingTaskId, onRespond, readOnly = false, isRoutineMember = false,
}: {
    entry: TaskWithSummary;
    C: ThemeColors;
    t: (key: string, vars?: Record<string, string | number>) => string;
    styles: ReturnType<typeof createStyles>;
    respondingTaskId: string | null;
    onRespond: (taskId: string, occurrenceDate: string, action: 'completed' | 'skipped') => void;
    readOnly?: boolean;
    isRoutineMember?: boolean;
}) {
    const { task, summary, organizerProfile } = entry;
    const organizerName = organizerProfile ? resolveOrganizerDisplay(task.caregiver_id, organizerProfile, t).displayName : undefined;
    const statusLabel = t(`taskStatus.${summary.status === 'completed_on_time' ? 'completedOnTime' : summary.status === 'completed_late' ? 'completedLate' : summary.status}`);
    const canRespond = !readOnly && !!summary.actionableDate;
    const isResponding = respondingTaskId === task.id;
    const scheduleContext = task.frequency === 'one_time'
        ? (summary.upcomingDate ? t('tasksSection.startsLabel', { date: formatDateStringForDisplay(summary.upcomingDate) }) : (task.due_date ? t('tasksSection.dueLabel', { date: formatDateStringForDisplay(task.due_date) }) : t('tasksSection.noDueDate')))
        : t(`tasksSection.${task.frequency === 'daily' ? 'recurrenceEveryDay' : task.frequency === 'weekdays' ? 'recurrenceWeekdays' : task.frequency === 'weekends' ? 'recurrenceWeekends' : 'recurrenceOneTime'}`);

    return (
        <TouchableOpacity
            style={[styles.taskCard, SHADOW.sm]}
            onPress={() => router.push({ pathname: '/task-details', params: { taskId: task.id } })}
            accessibilityRole="button"
            accessibilityLabel={`${t('itemTypePicker.flexibleTaskTitle')}, ${task.title}, ${statusLabel}`}
            activeOpacity={0.9}
        >
            <View style={styles.taskCardTopRow}>
                <View style={styles.taskKindPill}>
                    <Ionicons name="checkbox-outline" size={12} color={C.textSecondary} />
                    <Text style={styles.taskKindPillText}>{t('itemTypePicker.flexibleTaskTitle')}</Text>
                </View>
                <StatusBadge label={statusLabel} tone={TASK_STATUS_TONE[summary.status] ?? 'neutral'} />
            </View>
            <Text style={styles.taskCardTitle} numberOfLines={2}>{task.title}</Text>
            <Text style={styles.taskCardSubtitle}>
                {organizerName ? `${t('tasksSection.organizerLabel', { name: organizerName })} · ` : ''}
                {scheduleContext}
                {summary.overdueCount > 1 ? ` · ${t('tasksSection.overdueCountBadge', { n: summary.overdueCount })}` : ''}
                {isRoutineMember ? ` · ${t('routineDetails.heading')}` : ''}
            </Text>
            {canRespond ? (
                <View style={styles.taskCardActionRow}>
                    <TouchableOpacity
                        style={[styles.taskCompleteButton]}
                        onPress={() => onRespond(task.id, summary.actionableDate!, 'completed')}
                        disabled={isResponding}
                        accessibilityRole="button"
                        accessibilityLabel={t('tasksSection.complete')}
                        accessibilityState={{ disabled: isResponding, busy: isResponding }}
                    >
                        {isResponding ? <ActivityIndicator color={C.textInverse} size="small" /> : <Text style={styles.taskCompleteButtonText}>{t('tasksSection.complete')}</Text>}
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={styles.taskSkipButton}
                        onPress={() => onRespond(task.id, summary.actionableDate!, 'skipped')}
                        disabled={isResponding}
                        accessibilityRole="button"
                        accessibilityLabel={t('tasksSection.skip')}
                    >
                        <Text style={styles.taskSkipButtonText}>{t('tasksSection.skip')}</Text>
                    </TouchableOpacity>
                </View>
            ) : null}
        </TouchableOpacity>
    );
}

const createStyles = (C: ThemeColors) => StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: C.bgPage,
    },
    content: {
        paddingHorizontal: SPACING.screen,
        paddingTop: 8,
        paddingBottom: 48,
    },

    // ── Header ────────────────────────────────────────────────────────
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: SPACING.section,
        paddingTop: 8,
        gap: 12,
    },
    headerTextBlock: { flex: 1 },
    heading: {
        fontSize: 27,
        fontWeight: '800',
        color: C.textPrimary,
        letterSpacing: -0.6,
        lineHeight: 32,
    },
    subheading: {
        fontSize: 14,
        color: C.textMuted,
        marginTop: 2,
        letterSpacing: -0.1,
    },
    alertIconButton: {
        width: 44,
        height: 44,
        borderRadius: RADIUS.lg,
        backgroundColor: C.primaryLight,
        justifyContent: 'center',
        alignItems: 'center',
    },

    // ── Progress summary ───────────────────────────────────────────────
    progressCard: {
        backgroundColor: C.bgSurface,
        borderRadius: RADIUS.lg,
        padding: 16,
        marginBottom: 16,
    },
    progressTextRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 10,
    },
    progressLabel: {
        fontSize: 14,
        fontWeight: '700',
        color: C.textPrimary,
        letterSpacing: -0.1,
    },
    progressPct: {
        fontSize: 14,
        fontWeight: '700',
        color: C.textMuted,
    },
    progressTrack: {
        height: 6,
        borderRadius: RADIUS.full,
        backgroundColor: C.bgAlt,
        overflow: 'hidden',
    },
    progressFill: {
        height: '100%',
        borderRadius: RADIUS.full,
    },

    // ── Empty / loading state ─────────────────────────────────────────
    emptyCard: {
        backgroundColor: C.bgSurface,
        borderRadius: RADIUS.xl,
        padding: 32,
        alignItems: 'center',
        marginTop: 8,
    },
    emptyIconWrap: {
        width: 72,
        height: 72,
        borderRadius: RADIUS.xl,
        backgroundColor: C.bgAlt,
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: 16,
    },
    emptyEmoji: {
        fontSize: 36,
    },
    emptyTitle: {
        fontSize: 20,
        fontWeight: '700',
        color: C.textPrimary,
        letterSpacing: -0.3,
        marginBottom: 8,
        textAlign: 'center',
    },
    emptyText: {
        fontSize: 15,
        color: C.textMuted,
        lineHeight: 22,
        textAlign: 'center',
    },

    // ── Reminder card ─────────────────────────────────────────────────
    reminderCard: {
        backgroundColor: C.bgSurface,
        borderRadius: RADIUS.xl,
        padding: 20,
        marginBottom: 16,
        overflow: 'hidden',
    },
    cardAccentBar: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: 4,
    },
    cardTopRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 14,
        marginTop: 8,
    },
    typePill: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        backgroundColor: C.primaryLight,
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: RADIUS.full,
    },
    typePillEmoji: {
        fontSize: 13,
    },
    typePillText: {
        color: C.primary,
        fontSize: 13,
        fontWeight: '700',
    },
    timeText: {
        fontSize: 17,
        color: C.textPrimary,
        fontWeight: '700',
        letterSpacing: -0.2,
    },
    reminderTitle: {
        fontSize: 26,
        fontWeight: '800',
        color: C.textPrimary,
        letterSpacing: -0.5,
        lineHeight: 32,
        marginBottom: 10,
    },
    routineMemberLabel: {
        fontSize: 12,
        fontWeight: '600',
        color: C.textMuted,
        marginTop: -6,
        marginBottom: 8,
    },
    notes: {
        fontSize: 16,
        color: C.textSecondary,
        lineHeight: 23,
        marginBottom: 16,
    },
    notesMuted: {
        fontSize: 15,
        color: C.textMuted,
        lineHeight: 22,
        marginBottom: 16,
    },

    // ── Status row ────────────────────────────────────────────────────
    statusRow: {
        backgroundColor: C.bgAlt,
        borderRadius: RADIUS.md,
        paddingVertical: 10,
        paddingHorizontal: 14,
        marginBottom: 16,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    statusLabel: {
        fontSize: 13,
        color: C.textMuted,
        fontWeight: '600',
    },
    statusRight: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    timeHint: {
        fontSize: 12,
        color: C.textMuted,
        fontWeight: '500',
    },
    statusPill: {
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: RADIUS.full,
    },
    statusPillText: {
        fontSize: 13,
        fontWeight: '700',
    },

    // ── Saving state ──────────────────────────────────────────────────
    savingBox: {
        backgroundColor: C.bgAlt,
        borderRadius: RADIUS.lg,
        paddingVertical: 18,
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 10,
    },
    savingText: {
        fontSize: 15,
        color: C.textMuted,
        fontWeight: '600',
    },

    // ── Action buttons ────────────────────────────────────────────────
    actionArea: {
        gap: 10,
    },
    takenButton: {
        backgroundColor: C.success,
        paddingVertical: 18,
        borderRadius: RADIUS.xl,
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 10,
    },
    takenButtonText: {
        color: '#FFFFFF',
        fontSize: 18,
        fontWeight: '700',
        letterSpacing: -0.2,
    },
    secondaryButtonRow: {
        flexDirection: 'row',
        gap: 10,
    },
    laterButton: {
        flex: 1,
        backgroundColor: '#FEF3C7',
        paddingVertical: 15,
        borderRadius: RADIUS.xl,
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 7,
        borderWidth: 1,
        borderColor: '#FDE68A',
    },
    laterButtonText: {
        color: '#92400E',
        fontSize: 16,
        fontWeight: '700',
    },
    skipButton: {
        flex: 1,
        backgroundColor: C.bgAlt,
        paddingVertical: 15,
        borderRadius: RADIUS.xl,
        alignItems: 'center',
        justifyContent: 'center',
    },
    skipButtonText: {
        color: C.textSecondary,
        fontSize: 16,
        fontWeight: '600',
    },

    // ── Notification denied banner ─────────────────────────────────────
    notifDeniedBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        backgroundColor: '#FEF3C7',
        borderRadius: RADIUS.md,
        borderWidth: 1,
        borderColor: '#FDE68A',
        paddingVertical: 12,
        paddingHorizontal: 14,
        marginBottom: 16,
    },
    notifDeniedText: {
        flex: 1,
        fontSize: 13,
        color: '#92400E',
        fontWeight: '500',
        lineHeight: 18,
    },
    notifDeniedAction: {
        fontSize: 13,
        fontWeight: '700',
        color: '#92400E',
        textDecorationLine: 'underline',
    },
    emptyActionButton: {
        backgroundColor: C.primary,
        paddingVertical: 14,
        paddingHorizontal: 24,
        borderRadius: RADIUS.xl,
        marginTop: 16,
        minHeight: 44,
        justifyContent: 'center',
    },
    emptyActionButtonText: {
        color: C.textInverse,
        fontSize: 15,
        fontWeight: '700',
    },

    // ── Already-responded state ───────────────────────────────────────
    respondedBox: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        paddingVertical: 16,
        backgroundColor: C.bgAlt,
        borderRadius: RADIUS.xl,
    },
    respondedText: {
        fontSize: 15,
        fontWeight: '600',
    },

    // ── Flexible tasks (Today hub integration) ─────────────────────────────
    taskSectionBlock: { marginBottom: 8 },
    taskSectionHeading: { fontSize: 15, fontWeight: '800', color: C.textPrimary, marginBottom: 10, marginTop: 4 },
    viewAllOverdueRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 10, minHeight: 44 },
    viewAllOverdueText: { fontSize: 14, fontWeight: '700', color: C.primary },
    taskCard: { backgroundColor: C.bgSurface, borderRadius: RADIUS.xl, padding: 16, marginBottom: 12 },
    taskCardTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
    taskKindPill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: RADIUS.full, backgroundColor: C.bgAlt },
    taskKindPillText: { fontSize: 11, fontWeight: '700', color: C.textSecondary },
    taskCardTitle: { fontSize: 15, fontWeight: '700', color: C.textPrimary, marginBottom: 4 },
    taskCardSubtitle: { fontSize: 13, color: C.textSecondary },
    taskCardActionRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
    taskCompleteButton: { flex: 1, minHeight: 44, borderRadius: RADIUS.lg, alignItems: 'center', justifyContent: 'center', backgroundColor: C.primary },
    taskCompleteButtonText: { color: C.textInverse, fontSize: 14, fontWeight: '700' },
    taskSkipButton: { flex: 1, minHeight: 44, borderRadius: RADIUS.lg, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bgAlt, borderWidth: 1.5, borderColor: C.border },
    taskSkipButtonText: { color: C.textSecondary, fontSize: 14, fontWeight: '700' },
    viewAllTasksRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 44, marginTop: 4, marginBottom: 12 },
    viewAllTasksText: { fontSize: 14, fontWeight: '700', color: C.primary },
});
