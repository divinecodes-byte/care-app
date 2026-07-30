// Shared result/type model for the audit-infrastructure layer. Existing
// suites keep calling record()/skip()/summarize() from
// scripts/security-audit/helpers.ts exactly as before -- nothing here
// changes their calling convention. This file defines the *structured*
// shape that scripts/audit-infrastructure/artifacts.ts serializes to JSON,
// and that scripts/final-regression/run.ts aggregates across suites.

export type AuditStatus = 'PASS' | 'FAIL' | 'SKIP';

export type AuditCategory = 'product' | 'security' | 'infrastructure' | 'regression' | 'cleanup';

export type AuditResult = {
    suite: string;
    scenarioId: string;
    description: string;
    status: AuditStatus;
    category: AuditCategory;
    durationMs?: number;
    detail?: string;
    errorCode?: string;
    startedAt?: string;
    finishedAt?: string;
};

// A standalone re-verification of a suite that was SKIPped inside an
// orchestrated run. This is always recorded separately -- it never
// overwrites the original SKIP entry for that run (see docs/final-regression-runbook.md).
export type StandaloneVerification = {
    suite: string;
    originalRunId: string;
    verifiedAt: string;
    result: 'PASS' | 'FAIL';
    detail?: string;
};

export type HealthStatus = 'PASS' | 'WARNING' | 'FAIL';

// Mirrors the row shape returned by the SQL function public.ops_health_evaluate(),
// which is the single source of truth both scripts/ops-health/run.ts and the
// evaluate-ops-health Edge Function consume -- see docs/audit-infrastructure-model.md.
export type HealthCheckResult = {
    checkName: string;
    status: HealthStatus;
    detail: string;
    numericValue: number | null;
};

export type SuiteOutcome = {
    suite: string;
    status: AuditStatus | 'ERROR';
    exitCode: number | null;
    signal: string | null;
    scenarioCounts: { pass: number; fail: number; skip: number };
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    logPath: string;
    jsonPath: string;
};

// scripts/final-regression/run.ts exit-code policy (docs/final-regression-runbook.md):
//   0 -- every required suite PASS (or SKIP since independently standalone-verified) and cleanup verified zero
//   1 -- a genuine FAIL, or a destructive-cleanup failure
//   2 -- one or more infrastructure SKIPs remain unresolved
//   3 -- orchestrator/configuration failure (fixture-pool corruption, lock never acquired, etc.)
export const EXIT_OK = 0;
export const EXIT_GENUINE_FAILURE = 1;
export const EXIT_UNRESOLVED_SKIP = 2;
export const EXIT_ORCHESTRATOR_FAILURE = 3;
