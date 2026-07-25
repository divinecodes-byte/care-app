// Supabase-backed connection/participant fetch helpers. Built on top of the
// pure classification logic in lib/connectionStateCore.ts so every screen
// that lists an organizer's participants/invites agrees on what counts as
// active/pending/expired/ended.

import { supabase } from './supabase';
import { categorizeConnection } from './connectionStateCore';
import { isUseCase, UseCase } from './onboardingCore';

export type ParticipantSummary = {
    connectionId: string;
    recipientId: string;
    recipientName: string;
    useCase: UseCase | null;
    acceptedAt: string | null;
};

export type PendingInviteSummary = {
    connectionId: string;
    inviteCode: string;
    expiresAt: string | null;
};

export type OrganizerConnections = {
    active: ParticipantSummary[];
    pending: PendingInviteSummary[];
    /** Matches the server's create_invite_code() count exactly: active.length + pending.length (non-expired only, expired/ended already excluded). Use this for any "N of 5" display. */
    slotsUsed: number;
};

/**
 * One round-trip for the connections list, one batched round-trip for
 * participant profiles (never N+1) — the same pattern already proven in
 * caregiver-dashboard.tsx/create-reminder.tsx/settings-sheet.tsx, factored
 * out here so new screens (participants.tsx, invite-recipient.tsx's limit
 * check) don't each re-implement it slightly differently.
 */
export async function fetchOrganizerConnections(caregiverId: string): Promise<OrganizerConnections> {
    const { data: rows } = await supabase
        .from('connections')
        .select('id, recipient_id, status, expires_at, accepted_at, invite_code')
        .eq('caregiver_id', caregiverId);

    const all = rows ?? [];
    const now = new Date();

    const activeRows = all.filter((r) => categorizeConnection(r, now) === 'active' && r.recipient_id);
    const pendingRows = all.filter((r) => categorizeConnection(r, now) === 'pending');

    const recipientIds = activeRows.map((r) => r.recipient_id as string);
    let profileMap = new Map<string, { full_name: string | null; use_case: string | null }>();
    if (recipientIds.length > 0) {
        const { data: profiles } = await supabase
            .from('profiles')
            .select('id, full_name, use_case')
            .in('id', recipientIds);
        profileMap = new Map((profiles ?? []).map((p) => [p.id, p]));
    }

    const active: ParticipantSummary[] = activeRows.map((r) => {
        const profile = profileMap.get(r.recipient_id as string);
        return {
            connectionId: r.id,
            recipientId: r.recipient_id as string,
            recipientName: profile?.full_name ?? '',
            useCase: isUseCase(profile?.use_case) ? profile!.use_case as UseCase : null,
            acceptedAt: r.accepted_at,
        };
    });

    const pending: PendingInviteSummary[] = pendingRows.map((r) => ({
        connectionId: r.id,
        inviteCode: r.invite_code,
        expiresAt: r.expires_at,
    }));

    return { active, pending, slotsUsed: active.length + pending.length };
}

export type EndConnectionErrorKind = 'not_authorized' | 'not_found' | 'network' | 'unexpected';

export type EndConnectionResult =
    | { ok: true }
    | { ok: false; kind: EndConnectionErrorKind };

function classifyEndConnectionError(message: string): EndConnectionErrorKind {
    if (message.includes('not_authorized')) return 'not_authorized';
    if (message.includes('connection_not_found')) return 'not_found';
    if (/network|fetch/i.test(message)) return 'network';
    return 'unexpected';
}

/**
 * Ends one connection — callable by either party. Idempotent server-side
 * (see end_connection() in
 * supabase/migrations/20260727000000_participant_limit_and_connection_ending.sql):
 * ending an already-ended connection is a harmless success, not an error.
 */
export async function endConnection(connectionId: string): Promise<EndConnectionResult> {
    try {
        const { error } = await supabase.rpc('end_connection', { p_connection_id: connectionId });
        if (error) return { ok: false, kind: classifyEndConnectionError(error.message) };
        return { ok: true };
    } catch (err) {
        return { ok: false, kind: classifyEndConnectionError(err instanceof Error ? err.message : String(err)) };
    }
}
