import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { AccessibleSectionHeader, StatusBadge, StatusTone } from '@/components/AccessiblePrimitives';
import { formatDateStringForDisplay } from '@/components/DatePickerField';
import { SectionErrorState } from '@/components/StateViews';
import { RADIUS, SHADOW, ThemeColors } from '@/constants/theme';
import { ActivityEvent, ActivityRow, normalizeActivityRows } from '@/lib/activityFeedCore';
import { useTranslation } from '@/lib/i18n/context';
import { supabase } from '@/lib/supabase';
import { useThemeColors } from '@/lib/theme';

// Organizer dashboard's recent-activity preview (Phase 9) — deliberately a
// SEPARATE fetch/failure domain from reminder and task analytics (an
// activity-load failure is a section-level error only, never blocks or
// hides analytics/reminders/tasks around it). Never replaces analytics —
// see docs/activity-feed-security.md's activity-vs-analytics contract.

const PREVIEW_COUNT = 3;

const OUTCOME_TONE: Record<string, StatusTone> = {
    taken: 'success',
    completed_on_time: 'success',
    completed_late: 'warning',
    skipped: 'error',
    missed: 'error',
};

export function ActivityPreviewCard({ connectionId }: { connectionId: string | null }) {
    const C = useThemeColors();
    const t = useTranslation();
    const styles = useMemo(() => createStyles(C), [C]);
    const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
    const [events, setEvents] = useState<ActivityEvent[]>([]);

    const labels = useMemo(() => ({
        reminderTaken: t('activityFeed.outcomeTaken'),
        reminderSkipped: t('activityFeed.outcomeSkipped'),
        reminderMissed: t('activityFeed.outcomeMissed'),
        taskCompletedOnTime: t('activityFeed.outcomeCompletedOnTime'),
        taskCompletedLate: t('activityFeed.outcomeCompletedLate'),
        taskSkipped: t('activityFeed.outcomeTaskSkipped'),
        unknownOrganizer: t('activityFeed.formerOrganizer'),
        summaryTemplate: (vars: { title: string; outcome: string; date: string; organizer: string }) => t('activityFeed.accessibleSummary', vars),
    }), [t]);

    useEffect(() => {
        let cancelled = false;
        if (!connectionId) { setStatus('ready'); setEvents([]); return; }

        setStatus('loading');
        supabase.rpc('get_connection_activity_feed', {
            p_connection_id: connectionId,
            p_before_timestamp: null,
            p_before_source: null,
            p_before_id: null,
            p_limit: PREVIEW_COUNT,
            p_source_filter: 'all',
        }).then(({ data, error }) => {
            if (cancelled) return;
            if (error) { setStatus('error'); return; }
            setEvents(normalizeActivityRows((data ?? []) as ActivityRow[], labels));
            setStatus('ready');
        });

        return () => { cancelled = true; };
    }, [connectionId, labels]);

    if (!connectionId) return null;

    return (
        <View style={[styles.card, SHADOW.sm]}>
            <View style={styles.headerRow}>
                <AccessibleSectionHeader title={t('activityFeed.recentActivityHeading')} />
            </View>

            {status === 'loading' ? (
                <ActivityIndicator color={C.primary} style={{ marginVertical: 12 }} />
            ) : status === 'error' ? (
                <SectionErrorState text={t('activityFeed.loadFailedText')} />
            ) : events.length === 0 ? (
                <Text style={styles.emptyText}>{t('activityFeed.noHistoryText')}</Text>
            ) : (
                events.map((event) => {
                    const outcomeLabel = event.sourceKind === 'reminder'
                        ? (event.outcome === 'taken' ? t('activityFeed.outcomeTaken') : event.outcome === 'skipped' ? t('activityFeed.outcomeSkipped') : t('activityFeed.outcomeMissed'))
                        : (event.outcome === 'completed_on_time' ? t('activityFeed.outcomeCompletedOnTime') : event.outcome === 'completed_late' ? t('activityFeed.outcomeCompletedLate') : t('activityFeed.outcomeTaskSkipped'));
                    return (
                        <View key={`${event.sourceKind}:${event.occurrenceId}`} style={styles.row} accessible accessibilityLabel={event.accessibleSummary}>
                            <Ionicons name={event.sourceKind === 'reminder' ? 'time-outline' : 'checkbox-outline'} size={14} color={C.textMuted} />
                            <Text style={styles.rowTitle} numberOfLines={1}>{event.title}</Text>
                            <Text style={styles.rowDate}>{formatDateStringForDisplay(event.occurrenceDate)}</Text>
                            <StatusBadge label={outcomeLabel} tone={OUTCOME_TONE[event.outcome] ?? 'neutral'} />
                        </View>
                    );
                })
            )}

            <TouchableOpacity
                style={styles.viewAllRow}
                onPress={() => router.push({ pathname: '/activity', params: { connectionId } })}
                accessibilityRole="button"
                accessibilityLabel={t('activityFeed.viewAllActivity')}
            >
                <Text style={styles.viewAllText}>{t('activityFeed.viewAllActivity')}</Text>
                <Ionicons name="chevron-forward" size={16} color={C.textMuted} />
            </TouchableOpacity>
        </View>
    );
}

const createStyles = (C: ThemeColors) => StyleSheet.create({
    card: { backgroundColor: C.bgSurface, borderRadius: RADIUS.xl, padding: 18, marginTop: 16 },
    headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
    emptyText: { fontSize: 13, color: C.textSecondary, marginBottom: 8 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderTopWidth: 1, borderTopColor: C.border },
    rowTitle: { flex: 1, fontSize: 13, fontWeight: '600', color: C.textPrimary },
    rowDate: { fontSize: 12, color: C.textMuted },
    viewAllRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44, marginTop: 8 },
    viewAllText: { fontSize: 14, fontWeight: '700', color: C.primary },
});
