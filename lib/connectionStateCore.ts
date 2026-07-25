// Pure connection-state model shared by every organizer/participant-facing
// screen and by scripts/participant-audit/run.ts. Zero imports (no
// supabase, no react-native) so it stays importable from a plain Node/tsx
// script — see lib/onboardingCore.ts's header comment for why that matters.
//
// This is the single place that decides what a `connections` row (status +
// expires_at) MEANS for display/counting purposes. Every screen and the
// server-side create_invite_code() limit check must agree on this
// classification, or the client's "N of 5" indicator can drift from what
// the server actually enforces.

export type RawConnectionStatus = 'pending' | 'accepted' | 'ended';

export type ConnectionCategory =
    | 'active'          // status = 'accepted'
    | 'pending'         // status = 'pending', not yet expired
    | 'expired_pending' // status = 'pending', expires_at has passed
    | 'ended';          // status = 'ended' (explicit end_connection(), OR a side
                         // effect of either party deleting their account --
                         // both produce the identical calm "ended" treatment,
                         // so a deleted counterpart is never exposed as if
                         // still a normal active user).

export type MinimalConnection = {
    status: RawConnectionStatus;
    expires_at: string | null;
};

/**
 * The single source of truth for turning a raw (status, expires_at) pair
 * into a display/counting category. Mirrors create_invite_code()'s own
 * SQL exactly (supabase/migrations/20260727000000_participant_limit_and_connection_ending.sql)
 * -- keep the two in sync if either changes.
 */
export function categorizeConnection(conn: MinimalConnection, now: Date = new Date()): ConnectionCategory {
    if (conn.status === 'ended') return 'ended';
    if (conn.status === 'accepted') return 'active';
    // status === 'pending'
    if (conn.expires_at && new Date(conn.expires_at) < now) return 'expired_pending';
    return 'pending';
}

/** Whether this category occupies one of the organizer's participant slots -- matches create_invite_code()'s count exactly: accepted + non-expired pending, never expired pending or ended. */
export function countsTowardParticipantLimit(category: ConnectionCategory): boolean {
    return category === 'active' || category === 'pending';
}
