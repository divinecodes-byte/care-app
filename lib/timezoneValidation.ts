// ─── Pure IANA timezone validation ───────────────────────────────────────────
// Deliberately dependency-free (no Supabase/React Native imports) so it can
// be unit-tested directly under plain Node, and so syncCurrentUserTimezone
// (lib/timezone.ts) stays free of duplicating this check.

/**
 * True only for a non-empty, non-whitespace string that Intl actually
 * accepts as a timezone identifier. Deliberately does not maintain a static
 * list of every IANA name — Intl's own validation is the source of truth
 * and stays correct as the tz database evolves.
 */
export function isValidIanaTimezone(candidate: string | null | undefined): candidate is string {
    if (!candidate || !candidate.trim()) return false;
    try {
        // Throws a RangeError for an unrecognized zone name; never actually
        // reads the resolved options, just uses construction as validation.
        new Intl.DateTimeFormat(undefined, { timeZone: candidate });
        return true;
    } catch {
        return false;
    }
}
