// ─── Plan limits ──────────────────────────────────────────────────────────────
// Free plan caps how many participants one organizer can connect to. Tavora
// Plus (not implemented yet — no payment SDK, no real purchase flow) will
// raise or remove this cap. Keep this as the single source of truth so the
// limit can be wired to a real entitlement check later without touching the
// screens that read it.

export const MAX_FREE_PARTICIPANTS = 3;
