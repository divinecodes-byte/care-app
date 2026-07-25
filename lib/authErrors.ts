// Shared classification for every auth/session-adjacent error surfaced to a
// user. Never renders raw Supabase/Postgres error text — every caller maps
// the returned kind to a translated, stable message via
// AUTH_ERROR_TRANSLATION_KEYS. Detailed original messages should still go to
// console.warn/console.error for development debugging, just never to an
// Alert or on-screen Text a user can see.

export type AuthErrorKind =
    | 'invalid_credentials'
    | 'email_in_use'
    | 'weak_password'
    | 'network'
    | 'expired_session'
    | 'account_deleted'
    | 'rate_limited'
    | 'unexpected';

const NETWORK_PATTERNS = [
    'network request failed',
    'fetch failed',
    'failed to fetch',
    'network error',
    'timed out',
    'timeout',
    'no internet',
    'offline',
];

const RATE_LIMIT_PATTERNS = [
    'rate limit',
    'too many requests',
    'over_request_rate_limit',
    'over_email_send_rate_limit',
];

const CREDENTIAL_PATTERNS = [
    'invalid login credentials',
    'invalid email or password',
    'email not confirmed',
];

const EMAIL_IN_USE_PATTERNS = [
    'user already registered',
    'already registered',
    'already exists',
    'email address is already',
];

const WEAK_PASSWORD_PATTERNS = [
    'password should be at least',
    'password is too short',
    'weak password',
];

const EXPIRED_SESSION_PATTERNS = [
    'jwt expired',
    'refresh_token_not_found',
    'invalid refresh token',
    'refresh token not found',
    'session_not_found',
    'session from session_id claim in jwt does not exist',
    'user_not_found',
    'invalid jwt',
    'jwt is expired',
];

function messageOf(error: unknown): string {
    if (!error) return '';
    if (typeof error === 'string') return error.toLowerCase();
    const anyErr = error as { message?: unknown };
    return typeof anyErr.message === 'string' ? anyErr.message.toLowerCase() : '';
}

function statusOf(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const anyErr = error as { status?: unknown; code?: unknown };
    if (typeof anyErr.status === 'number') return anyErr.status;
    // supabase-js sometimes surfaces a numeric-looking string code instead.
    if (typeof anyErr.code === 'string' && /^\d+$/.test(anyErr.code)) return Number(anyErr.code);
    return undefined;
}

/**
 * Classifies any error thrown or returned by a Supabase auth/DB call into a
 * small, stable set of kinds a UI can act on consistently — never returns
 * or requires the original error text.
 */
export function classifyAuthError(error: unknown): AuthErrorKind {
    if (!error) return 'unexpected';
    const message = messageOf(error);
    const status = statusOf(error);

    if (RATE_LIMIT_PATTERNS.some((p) => message.includes(p)) || status === 429) return 'rate_limited';
    if (NETWORK_PATTERNS.some((p) => message.includes(p))) return 'network';
    if (EMAIL_IN_USE_PATTERNS.some((p) => message.includes(p))) return 'email_in_use';
    if (WEAK_PASSWORD_PATTERNS.some((p) => message.includes(p))) return 'weak_password';
    if (CREDENTIAL_PATTERNS.some((p) => message.includes(p))) return 'invalid_credentials';
    if (EXPIRED_SESSION_PATTERNS.some((p) => message.includes(p)) || status === 401) return 'expired_session';

    return 'unexpected';
}

/** Stable i18n key for each classified error kind — pass to t(). */
export const AUTH_ERROR_TRANSLATION_KEYS: Record<AuthErrorKind, string> = {
    rate_limited: 'authErrors.rateLimited',
    invalid_credentials: 'authErrors.invalidCredentials',
    email_in_use: 'authErrors.emailInUse',
    weak_password: 'authErrors.weakPassword',
    network: 'authErrors.network',
    expired_session: 'authErrors.expiredSession',
    account_deleted: 'authErrors.accountDeleted',
    unexpected: 'authErrors.unexpected',
};
