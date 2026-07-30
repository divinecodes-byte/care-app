// Centralized infrastructure-error classifier.
//
// Before this file existed, the only place that distinguished "Supabase
// rate-limited us" from "the product/test actually broke" was a pair of
// regexes local to scripts/routine-audit/run.ts's runSuite(). Every other
// suite's nested-call failure handler recorded a plain FAIL for the exact
// same rate-limit/gateway noise. This file is the one place that
// classification now lives, importable by any script.
//
// Policy (docs/audit-infrastructure-model.md has the full writeup):
//   - Known infrastructure signatures (rate limit, 429/502/503/504, DNS/
//     network timeout, connection reset, child-process timeout, permission
//     denial/interrupted command, missing env config) classify as
//     'infrastructure' -> the caller should SKIP, never FAIL, never PASS.
//   - Anything NOT matched stays 'unknown' -> the caller must FAIL (or leave
//     unresolved) -- classification never swallows a genuine SQL/RLS/
//     assertion failure by defaulting it to SKIP.

export type InfraErrorCode =
    | 'AUTH_RATE_LIMIT'
    | 'RATE_LIMIT_429'
    | 'GATEWAY_502'
    | 'SERVICE_UNAVAILABLE_503'
    | 'GATEWAY_TIMEOUT_504'
    | 'DNS_NETWORK_TIMEOUT'
    | 'CONNECTION_RESET'
    | 'CHILD_PROCESS_TIMEOUT'
    | 'PERMISSION_DENIED_OR_INTERRUPTED'
    | 'MISSING_ENV_CONFIG'
    | 'UNKNOWN';

export type Classification = {
    code: InfraErrorCode;
    category: 'infrastructure' | 'unknown';
    retryable: boolean;
    sanitizedMessage: string;
};

// Order matters -- more specific patterns are checked before generic ones
// (e.g. "429" must not get caught by a looser "rate limit" match first if a
// message happens to contain both).
const RULES: { code: InfraErrorCode; retryable: boolean; test: RegExp }[] = [
    { code: 'AUTH_RATE_LIMIT', retryable: true, test: /request rate limit reached|signup.*rate limit|auth rate limit/i },
    { code: 'RATE_LIMIT_429', retryable: true, test: /\b429\b|too many requests/i },
    { code: 'GATEWAY_502', retryable: true, test: /\b502\b|bad gateway/i },
    { code: 'SERVICE_UNAVAILABLE_503', retryable: true, test: /\b503\b|service unavailable|upstream connect error|connection timeout/i },
    { code: 'GATEWAY_TIMEOUT_504', retryable: true, test: /\b504\b|gateway timeout/i },
    { code: 'DNS_NETWORK_TIMEOUT', retryable: true, test: /enotfound|eai_again|etimedout|network timeout|fetch failed/i },
    { code: 'CONNECTION_RESET', retryable: true, test: /econnreset|econnrefused|socket hang up/i },
    { code: 'CHILD_PROCESS_TIMEOUT', retryable: false, test: /child process timed out|etimedout.*spawn|killed.*timeout/i },
    { code: 'PERMISSION_DENIED_OR_INTERRUPTED', retryable: false, test: /permission denied|eacces|operation not permitted|user (denied|rejected|aborted)/i },
    { code: 'MISSING_ENV_CONFIG', retryable: false, test: /missing required env var|is not defined|undefined.*env/i },
];

// Redacts anything JWT-shaped, a bare UUID, or an @example.com-style
// synthetic email before a message is logged/stored -- belt-and-suspenders
// on top of every script already avoiding secrets in its own log lines.
const JWT_SHAPED = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const EMAIL_SHAPED = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

export function sanitize(message: string): string {
    return message.replace(JWT_SHAPED, '[redacted-jwt]').replace(EMAIL_SHAPED, '[redacted-email]');
}

export function classify(err: unknown): Classification {
    const raw = err instanceof Error ? err.message : String(err);
    const message = raw.slice(0, 500);
    for (const rule of RULES) {
        if (rule.test.test(message)) {
            return { code: rule.code, category: 'infrastructure', retryable: rule.retryable, sanitizedMessage: sanitize(message) };
        }
    }
    // Deliberately NOT classified as infrastructure -- an unrecognized error
    // must stay FAIL-eligible. This is the guard against silently turning a
    // real assertion/SQL/RLS failure into a SKIP.
    return { code: 'UNKNOWN', category: 'unknown', retryable: false, sanitizedMessage: sanitize(message) };
}
