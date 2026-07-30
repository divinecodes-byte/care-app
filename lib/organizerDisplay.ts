// Shared, privacy-safe organizer display resolution (Week 4 Task #2, Phase 4).
//
// Every screen that shows an organizer's name to a participant must
// distinguish three genuinely different situations, never collapsing them:
//   - a legitimately active organizer can simply have full_name = null
//     (never set it) -- this is NOT the same as a deleted account;
//   - a profile fetch that failed or hasn't completed yet also produces no
//     name -- this is also NOT the same as a deleted account;
//   - delete_current_user_data() explicitly sets account_status='deleted'
//     and deleted_at (in addition to nulling full_name) -- only THIS
//     combination means "deleted."
// Inferring "deleted" from a bare null/undefined name (as an earlier draft
// of this module did) would mislabel a real, active, simply-unnamed
// organizer as gone. Every call site must batch-fetch account_status and
// deleted_at alongside full_name -- both already readable under the
// existing "Users can view connected profiles" RLS policy, no new grant
// needed.

export type OrganizerFallbackKind = 'named' | 'unavailable' | 'deleted';

export type OrganizerDisplayContext = {
    organizerId: string;
    displayName: string;
    fallbackKind: OrganizerFallbackKind;
    accessibilityLabel: string;
};

export type OrganizerProfileForDisplay = {
    full_name: string | null;
    account_status: string | null;
    deleted_at: string | null;
} | null | undefined;

type TranslateFn = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Pure -- no I/O. `profile` is `null`/`undefined` when the join/fetch for
 * this organizer failed or hasn't completed; a real (possibly unnamed)
 * profile row is always an object, never collapsed with the missing case.
 */
export function resolveOrganizerDisplay(organizerId: string, profile: OrganizerProfileForDisplay, t: TranslateFn): OrganizerDisplayContext {
    if (!profile) {
        const label = t('common.organizer');
        return { organizerId, displayName: label, fallbackKind: 'unavailable', accessibilityLabel: label };
    }

    const isDeleted = profile.account_status === 'deleted' || !!profile.deleted_at;
    if (isDeleted) {
        const label = t('activityFeed.formerOrganizer');
        return { organizerId, displayName: label, fallbackKind: 'deleted', accessibilityLabel: label };
    }

    const name = profile.full_name?.trim();
    if (name) {
        return { organizerId, displayName: name, fallbackKind: 'named', accessibilityLabel: name };
    }

    // Active account, genuinely no name on file -- never labeled "deleted."
    const label = t('common.organizer');
    return { organizerId, displayName: label, fallbackKind: 'unavailable', accessibilityLabel: label };
}
