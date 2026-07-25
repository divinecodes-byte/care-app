// ─── Plan limits ──────────────────────────────────────────────────────────────
// Standard accounts (the only account type that exists today -- no
// payments, no entitlements) cap how many participants one organizer can
// manage at once. This is launch-plan behavior, not an entitlement system:
// a future task can replace this fixed constant with a real per-account
// entitlement lookup without changing the screens that read it. The
// authoritative enforcement lives server-side in create_invite_code()
// (supabase/migrations/20260727000000_participant_limit_and_connection_ending.sql)
// -- this constant must be kept in sync with the value hardcoded there, and
// exists client-side only so the UI can show remaining-slots copy and
// gate the "Add participant" action before round-tripping to the server.
//
// Counts accepted connections + non-expired pending invitations. Never
// counts expired invitations or ended connections. Participants
// (recipients) are never subject to this limit or any payment.

export const MAX_STANDARD_PARTICIPANTS = 5;
