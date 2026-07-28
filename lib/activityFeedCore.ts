// ─── Cross-object activity timeline — pure, shared display model ─────────
// Zero react-native import. Normalizes the raw rows returned by the
// get_connection_activity_feed / get_participant_activity_feed SQL
// functions (supabase/migrations/20260729000000_activity_feed.sql) into a
// stable client-facing shape. The server is the sole source of truth for
// WHICH events exist and their order; this module only shapes them for
// display — it invents nothing and never re-derives an outcome.

export type SourceKind = 'reminder' | 'task';

export type ReminderOutcome = 'taken' | 'skipped' | 'missed';
export type TaskOutcome = 'completed_on_time' | 'completed_late' | 'skipped';

export type ActivityRow = {
    source_kind: SourceKind;
    source_id: string;
    occurrence_id: string;
    occurrence_date: string;
    event_timestamp: string;
    outcome: string;
    title: string;
    organizer_name: string | null;
    participant_name?: string | null;
};

export type ActivityEvent = {
    eventKind: 'reminder_response' | 'task_response';
    sourceKind: SourceKind;
    sourceId: string;
    occurrenceId: string;
    occurrenceDate: string;
    eventTimestamp: string;
    title: string;
    outcome: ReminderOutcome | TaskOutcome;
    organizerName: string | null;
    participantName: string | null;
    /** Pre-built full sentence for screen readers — never just a number/status fragment read in isolation. */
    accessibleSummary: string;
    cursor: { eventTimestamp: string; sourceKind: SourceKind; sourceId: string };
};

/** Stable, collision-proof key for FlatList — a reminder and a task can never share this key even if their raw UUIDs coincided. */
export function activityEventKey(event: ActivityEvent): string {
    return `${event.sourceKind}:${event.occurrenceId}`;
}

type Labels = {
    reminderTaken: string;
    reminderSkipped: string;
    reminderMissed: string;
    taskCompletedOnTime: string;
    taskCompletedLate: string;
    taskSkipped: string;
    /** e.g. "{{title}} — {{outcome}} on {{date}}, for {{organizer}}" */
    summaryTemplate: (vars: { title: string; outcome: string; date: string; organizer: string }) => string;
    unknownOrganizer: string;
};

function outcomeLabel(row: ActivityRow, labels: Labels): string {
    if (row.source_kind === 'reminder') {
        return row.outcome === 'taken' ? labels.reminderTaken
            : row.outcome === 'skipped' ? labels.reminderSkipped
            : labels.reminderMissed;
    }
    return row.outcome === 'completed_on_time' ? labels.taskCompletedOnTime
        : row.outcome === 'completed_late' ? labels.taskCompletedLate
        : labels.taskSkipped;
}

/** Normalizes one raw RPC row into a display-ready ActivityEvent. Pure — the caller supplies already-localized label strings. */
export function normalizeActivityRow(row: ActivityRow, labels: Labels): ActivityEvent {
    const outcomeText = outcomeLabel(row, labels);
    return {
        eventKind: row.source_kind === 'reminder' ? 'reminder_response' : 'task_response',
        sourceKind: row.source_kind,
        sourceId: row.source_id,
        occurrenceId: row.occurrence_id,
        occurrenceDate: row.occurrence_date,
        eventTimestamp: row.event_timestamp,
        title: row.title,
        outcome: row.outcome as ReminderOutcome | TaskOutcome,
        organizerName: row.organizer_name,
        participantName: row.participant_name ?? null,
        accessibleSummary: labels.summaryTemplate({
            title: row.title,
            outcome: outcomeText,
            date: row.occurrence_date,
            organizer: row.organizer_name ?? labels.unknownOrganizer,
        }),
        cursor: { eventTimestamp: row.event_timestamp, sourceKind: row.source_kind, sourceId: row.source_id },
    };
}

export function normalizeActivityRows(rows: ActivityRow[], labels: Labels): ActivityEvent[] {
    return rows.map((r) => normalizeActivityRow(r, labels));
}

/**
 * De-duplicates events across pages by (sourceKind, occurrenceId) — a
 * defensive guard for scenario AC (no duplicates between pages): even if a
 * page were ever re-requested with a stale cursor, appending through this
 * never produces a visible duplicate.
 */
export function mergeActivityPages(existing: ActivityEvent[], nextPage: ActivityEvent[]): ActivityEvent[] {
    const seen = new Set(existing.map(activityEventKey));
    const merged = [...existing];
    for (const event of nextPage) {
        const key = activityEventKey(event);
        if (!seen.has(key)) {
            seen.add(key);
            merged.push(event);
        }
    }
    return merged;
}
