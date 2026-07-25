// Pure UI-state taxonomy and error classification shared by every screen.
// Zero imports (no supabase, no react-native) so it stays importable from
// plain Node/tsx test scripts — see lib/onboardingCore.ts's header comment
// for why that matters (scripts/ui-state-audit/run.ts imports this
// directly).

/**
 * The nine screen-level states every data-driven screen in Tavora should
 * be describable by. Distinct from a component's own local `loading`
 * booleans — this is the vocabulary screens use to decide WHICH state
 * component to render (see components/StateViews.tsx).
 *
 *  - idle:               nothing requested yet (e.g. before a modal opens)
 *  - loading:             first load, no data yet -- ScreenLoadingState
 *  - refreshing:          data already on screen, re-fetching in the
 *                         background (pull-to-refresh, focus, poll) --
 *                         existing data stays visible with a discreet
 *                         indicator, never replaced by a blank/loading view
 *  - ready:               fetch succeeded, data is non-empty
 *  - empty:               fetch succeeded, genuinely zero items -- distinct
 *                         from loading/error (never flash empty before a
 *                         real answer arrives)
 *  - offline:             the request failed for a connectivity reason,
 *                         not a server rejection -- existing data (if any)
 *                         stays visible with an OfflineBanner
 *  - recoverable_error:    the request failed for a server/unexpected
 *                         reason where retrying might help -- ErrorState
 *                         with a Retry action
 *  - not_found:            the specific requested object no longer exists
 *                         or is no longer active (deleted reminder, ended
 *                         connection, expired invite, anonymized
 *                         participant) -- a calm, specific message, never
 *                         a generic error, and never retryable (retrying
 *                         the same id can't fix "this no longer exists")
 *  - unauthorized:         the session expired or the user isn't allowed
 *                         to view this -- routes to sign-in, never shown
 *                         as a retry-in-place error
 */
export type ScreenStatus =
    | 'idle'
    | 'loading'
    | 'refreshing'
    | 'ready'
    | 'empty'
    | 'offline'
    | 'recoverable_error'
    | 'not_found'
    | 'unauthorized';

/**
 * User-facing error categories — the vocabulary every Alert/inline error
 * in the app should be expressed in, never a raw Postgres/RLS/Edge
 * Function message. See lib/errorClassification.ts for the i18n key
 * mapping (that file adds no new dependency-bearing imports either, but
 * lives separately so this file can stay pure/dependency-free forever).
 */
export type ErrorCategory =
    | 'network'
    | 'session_expired'
    | 'unauthorized'
    | 'no_longer_active'
    | 'already_completed'
    | 'validation'
    | 'rate_limited'
    | 'unexpected';

const NETWORK_PATTERN = /network|fetch|timed?\s*out|timeout|offline|internet|connection reset|ECONNRESET|ENOTFOUND/i;
const RATE_LIMIT_PATTERN = /rate limit/i;
const SESSION_EXPIRED_PATTERN = /jwt expired|session.*expired|invalid.*refresh.*token|refresh_token_not_found|invalid jwt/i;
const UNAUTHORIZED_PATTERN = /row-level security|permission denied|not_authorized|not authorized/i;
const VALIDATION_PATTERN = /invalid_input|invalid_|constraint|check constraint/i;
const ALREADY_COMPLETED_PATTERN = /already_answered|already_accepted|already_completed/i;
const NO_LONGER_ACTIVE_PATTERN = /reminder_inactive|connection_inactive|not_eligible|expired|ended|not_found|reminder_not_found|connection_not_found/i;

/**
 * Classifies a raw error message (from Supabase-js, a fetch() rejection,
 * or an Edge Function response body) into one of the 8 user-facing
 * categories. Order matters -- more specific patterns are checked before
 * general ones (e.g. rate-limit before network, since a 429 message may
 * also mention "request" in a way that could otherwise look generic).
 *
 * This never returns anything that could leak a table/column name, a
 * UUID, or a stack trace -- callers pass the category through
 * ERROR_CATEGORY_TRANSLATION_KEYS to get user-facing copy, never the raw
 * message itself.
 */
export function classifyScreenError(rawMessage: string | null | undefined): ErrorCategory {
    const message = rawMessage ?? '';
    if (!message) return 'unexpected';
    if (RATE_LIMIT_PATTERN.test(message)) return 'rate_limited';
    if (SESSION_EXPIRED_PATTERN.test(message)) return 'session_expired';
    if (NETWORK_PATTERN.test(message)) return 'network';
    if (ALREADY_COMPLETED_PATTERN.test(message)) return 'already_completed';
    if (NO_LONGER_ACTIVE_PATTERN.test(message)) return 'no_longer_active';
    if (UNAUTHORIZED_PATTERN.test(message)) return 'unauthorized';
    if (VALIDATION_PATTERN.test(message)) return 'validation';
    return 'unexpected';
}

/** Whether a classified category should ever be shown with a Retry action. "not_found"-equivalent (no_longer_active) and already_completed are deliberately excluded -- retrying can't un-delete a reminder or un-complete a response. */
export function isRetryableCategory(category: ErrorCategory): boolean {
    return category === 'network' || category === 'unexpected' || category === 'rate_limited';
}
