import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { AccessibleSectionHeader } from '@/components/AccessiblePrimitives';
import { SectionErrorState } from '@/components/StateViews';
import { RADIUS, SHADOW, ThemeColors } from '@/constants/theme';
import { useTranslation } from '@/lib/i18n/context';
import { fetchTasksForRecipient, fetchTasksWithSummaries } from '@/lib/taskData';
import { useThemeColors } from '@/lib/theme';

// Deliberately fetches and fails independently of the reminders section on
// whichever dashboard embeds it (Phase 10's "task data and reminder data
// may fail independently") — a task-fetch error never blocks or hides the
// reminder content around it.
//
// Two modes: pass `connectionId` for the organizer's per-participant view,
// or `recipientId` for the participant's own aggregate view across every
// organizer (mirrors how recipient-dashboard.tsx already aggregates
// reminders across multiple accepted connections rather than one).

type Props = {
    connectionId?: string | null;
    recipientId?: string | null;
    recipientTimeZone: string;
    canCreate: boolean;
};

export function TasksSummaryCard({ connectionId, recipientId, recipientTimeZone, canCreate }: Props) {
    const C = useThemeColors();
    const t = useTranslation();
    const styles = useMemo(() => createStyles(C), [C]);

    const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
    const [counts, setCounts] = useState({ open: 0, overdue: 0, upcoming: 0 });

    useEffect(() => {
        let cancelled = false;
        if (!connectionId && !recipientId) { setStatus('ready'); setCounts({ open: 0, overdue: 0, upcoming: 0 }); return; }

        setStatus('loading');
        const fetchPromise = connectionId
            ? fetchTasksWithSummaries(connectionId, recipientTimeZone)
            : fetchTasksForRecipient(recipientId!, recipientTimeZone);

        fetchPromise
            .then((rows) => {
                if (cancelled) return;
                const active = rows.filter((r) => r.task.is_active);
                setCounts({
                    open: active.filter((r) => r.summary.status === 'open').length,
                    overdue: active.filter((r) => r.summary.status === 'overdue').length,
                    upcoming: active.filter((r) => r.summary.status === 'upcoming').length,
                });
                setStatus('ready');
            })
            .catch(() => { if (!cancelled) setStatus('error'); });

        return () => { cancelled = true; };
    }, [connectionId, recipientId, recipientTimeZone]);

    if (!connectionId && !recipientId) return null;

    return (
        <View style={[styles.card, SHADOW.sm]}>
            <View style={styles.headerRow}>
                <AccessibleSectionHeader title={t('tasksSection.heading')} />
                {canCreate ? (
                    <TouchableOpacity
                        onPress={() => router.push({ pathname: '/create-task', params: { connectionId } })}
                        accessibilityRole="button"
                        accessibilityLabel={t('tasksSection.createTask')}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                        <Ionicons name="add-circle" size={26} color={C.primary} />
                    </TouchableOpacity>
                ) : null}
            </View>

            {status === 'loading' ? (
                <ActivityIndicator color={C.primary} style={{ marginVertical: 12 }} />
            ) : status === 'error' ? (
                <SectionErrorState text={t('tasksSection.loadFailedText')} />
            ) : (
                <>
                    <View style={styles.countsRow}>
                        <CountPill label={t('tasksSection.overdueCount', { n: counts.overdue })} tone={counts.overdue > 0 ? 'warning' : 'neutral'} />
                        <CountPill label={t('tasksSection.openCount', { n: counts.open })} tone="neutral" />
                        <CountPill label={t('tasksSection.upcomingCount', { n: counts.upcoming })} tone="neutral" />
                    </View>
                    <TouchableOpacity
                        style={styles.viewAllRow}
                        onPress={() => router.push({ pathname: '/tasks', params: connectionId ? { connectionId } : {} })}
                        accessibilityRole="button"
                        accessibilityLabel={t('tasksSection.heading')}
                    >
                        <Text style={styles.viewAllText}>{t('tasksSection.heading')}</Text>
                        <Ionicons name="chevron-forward" size={16} color={C.textMuted} />
                    </TouchableOpacity>
                </>
            )}
        </View>
    );
}

function CountPill({ label, tone }: { label: string; tone: 'warning' | 'neutral' }) {
    const C = useThemeColors();
    return (
        <View style={{
            paddingHorizontal: 10,
            paddingVertical: 6,
            borderRadius: RADIUS.full,
            backgroundColor: tone === 'warning' ? '#FEF3C7' : C.bgAlt,
        }}>
            <Text style={{ fontSize: 12, fontWeight: '700', color: tone === 'warning' ? '#D97706' : C.textSecondary }}>{label}</Text>
        </View>
    );
}

const createStyles = (C: ThemeColors) => StyleSheet.create({
    card: { backgroundColor: C.bgSurface, borderRadius: RADIUS.xl, padding: 18, marginTop: 16 },
    headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
    countsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
    viewAllRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 },
    viewAllText: { fontSize: 14, fontWeight: '700', color: C.primary },
});
