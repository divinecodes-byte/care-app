// Pure onboarding logic: the use-case model, context-aware role labels,
// contextual example copy, and the onboarding resume-route resolver.
//
// Deliberately has ZERO imports (no supabase, no react-native) so it can be
// imported directly by plain Node/tsx test scripts (see
// scripts/onboarding-audit/run.ts) the same way lib/reminderStatus.ts and
// lib/zonedTime.ts already are — esbuild/tsx cannot parse react-native's
// own source (Flow-style syntax), so anything transitively importing
// './supabase' is unsafe to import from a plain Node script. lib/onboarding.ts
// re-exports everything here and adds the supabase-dependent functions
// (logOnboardingEvent, recipientHasAcceptedConnection) on top — app code
// should keep importing from '@/lib/onboarding' as usual.
//
// use_case is a display-only signal (see the migration comment on
// profiles.use_case) — nothing here ever affects authorization. Every
// function that reads a use case accepts `null` (unset / older account)
// and falls back to neutral copy, per the task's "default safely" rule.

export type UseCase = 'care' | 'family' | 'coaching' | 'team' | 'personal' | 'other';

export const USE_CASES: UseCase[] = ['care', 'family', 'coaching', 'team', 'personal', 'other'];

export function isUseCase(value: unknown): value is UseCase {
    return typeof value === 'string' && (USE_CASES as string[]).includes(value);
}

export type OnboardingEventType =
    | 'onboarding_started'
    | 'use_case_selected'
    | 'role_selected'
    | 'invite_created'
    | 'invite_accepted'
    | 'first_reminder_created'
    | 'first_response_recorded'
    | 'onboarding_completed';

// ─── Context-aware role labels ─────────────────────────────────────────────
// Authorization always stays on the underlying caregiver/recipient role
// value — these are display labels only, chosen by use_case, with a
// neutral Organizer/Participant fallback for family/personal/other/unset.

type RoleLabelKeys = {
    organizerTitle: string;
    organizerDesc: string;
    participantTitle: string;
    participantDesc: string;
};

const ROLE_LABEL_KEYS_BY_USE_CASE: Record<UseCase, RoleLabelKeys> = {
    care: {
        organizerTitle: 'chooseRole.careOrganizerTitle',
        organizerDesc: 'chooseRole.careOrganizerDesc',
        participantTitle: 'chooseRole.careParticipantTitle',
        participantDesc: 'chooseRole.careParticipantDesc',
    },
    coaching: {
        organizerTitle: 'chooseRole.coachingOrganizerTitle',
        organizerDesc: 'chooseRole.coachingOrganizerDesc',
        participantTitle: 'chooseRole.coachingParticipantTitle',
        participantDesc: 'chooseRole.coachingParticipantDesc',
    },
    team: {
        organizerTitle: 'chooseRole.teamOrganizerTitle',
        organizerDesc: 'chooseRole.teamOrganizerDesc',
        participantTitle: 'chooseRole.teamParticipantTitle',
        participantDesc: 'chooseRole.teamParticipantDesc',
    },
    family: {
        organizerTitle: 'chooseRole.organizerTitle',
        organizerDesc: 'chooseRole.organizerDesc',
        participantTitle: 'chooseRole.participantTitle',
        participantDesc: 'chooseRole.participantDesc',
    },
    personal: {
        organizerTitle: 'chooseRole.organizerTitle',
        organizerDesc: 'chooseRole.organizerDesc',
        participantTitle: 'chooseRole.participantTitle',
        participantDesc: 'chooseRole.participantDesc',
    },
    other: {
        organizerTitle: 'chooseRole.organizerTitle',
        organizerDesc: 'chooseRole.organizerDesc',
        participantTitle: 'chooseRole.participantTitle',
        participantDesc: 'chooseRole.participantDesc',
    },
};

/** Returns the i18n keys (not the resolved strings) for the role cards, chosen by use case. Pass through t() at the call site. */
export function getRoleLabelKeys(useCase: UseCase | null): RoleLabelKeys {
    return ROLE_LABEL_KEYS_BY_USE_CASE[useCase ?? 'other'];
}

// ─── Contextual example copy ────────────────────────────────────────────────

const EXAMPLE_TITLE_KEY_BY_USE_CASE: Record<UseCase, string> = {
    care: 'onboardingExamples.care',
    family: 'onboardingExamples.family',
    coaching: 'onboardingExamples.coaching',
    team: 'onboardingExamples.team',
    personal: 'onboardingExamples.personal',
    other: 'onboardingExamples.personal',
};

/** i18n key for a single use-case-aware example reminder title (e.g. as create-reminder's placeholder). Never auto-fills the field — examples only. */
export function getExampleReminderTitleKey(useCase: UseCase | null): string {
    return EXAMPLE_TITLE_KEY_BY_USE_CASE[useCase ?? 'other'];
}

// ─── Use-case card copy (Phase 2 selection screen + Settings editor) ───────

export const USE_CASE_CARD_KEYS: Record<UseCase, { title: string; desc: string; icon: string }> = {
    care: { title: 'useCase.careTitle', desc: 'useCase.careDesc', icon: 'heart' },
    family: { title: 'useCase.familyTitle', desc: 'useCase.familyDesc', icon: 'home' },
    coaching: { title: 'useCase.coachingTitle', desc: 'useCase.coachingDesc', icon: 'fitness' },
    team: { title: 'useCase.teamTitle', desc: 'useCase.teamDesc', icon: 'briefcase' },
    personal: { title: 'useCase.personalTitle', desc: 'useCase.personalDesc', icon: 'checkmark-circle' },
    other: { title: 'useCase.otherTitle', desc: 'useCase.otherDesc', icon: 'ellipsis-horizontal-circle' },
};

// ─── Resume-logic ───────────────────────────────────────────────────────────

export type Role = 'caregiver' | 'recipient';

export type OnboardingRoute =
    | '/choose-use-case'
    | '/choose-role'
    | '/join-invite'
    | '/caregiver-dashboard'
    | '/recipient-dashboard';

/**
 * The single source of truth for "where should a signed-in user with a
 * profile row land right now" — used identically by index.tsx (cold
 * launch) and signin.tsx (explicit sign-in) so the two never disagree.
 *
 * Deliberately never gates an already-onboarded user (role already set) on
 * use_case — an existing/legacy account with no use_case must always land
 * straight on its dashboard, never be sent back through onboarding. Only a
 * user who has NOT yet picked a role (still mid first-run onboarding) is
 * routed through choose-use-case/choose-role, and even then resumes at
 * choose-role directly if use_case was already answered on a prior attempt
 * (never re-asks a completed step).
 */
export function resolveProfileRoute(
    profile: { role: Role | null; useCase: UseCase | null },
    recipientHasConnection: boolean
): OnboardingRoute {
    if (!profile.role) {
        return profile.useCase ? '/choose-role' : '/choose-use-case';
    }
    if (profile.role === 'caregiver') return '/caregiver-dashboard';
    return recipientHasConnection ? '/recipient-dashboard' : '/join-invite';
}
