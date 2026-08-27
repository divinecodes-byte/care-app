// Per-connection relationship-context model (Week 4 product-reset Build
// Batch 2). Deliberately mirrors lib/onboardingCore.ts's own shape and
// header-comment reasoning exactly (zero runtime imports -- only a
// type-only import of UseCase, erased at compile time -- so this stays
// importable from plain Node/tsx test scripts, e.g. scripts/*-audit/run.ts,
// the same way onboardingCore.ts already is).
//
// Authoritative distinction (see docs/product-reset-audit.md §12-§13 and
// the Build Batch 2 brief): profiles.use_case is a coarse, PRE-connection
// onboarding signal -- asked once at signup, before any participant
// exists, so it cannot be connection-scoped by construction. It continues
// to drive onboarding example copy and routine-pack recommendations,
// completely unchanged by this file. connections.relationship_pair is the
// finer-grained, PER-CONNECTION label this module resolves -- one
// organizer can be a Parent to one participant and a Trainer to another,
// which a single profile-level field could never represent. Never read by
// RLS or any authorization RPC; display-only, exactly like use_case.
//
// NULL/unrecognized input must always resolve to the generic
// Organizer/Participant fallback -- never an error, never a blank string.

import type { UseCase } from './onboardingCore';

export type RelationshipPair =
    | 'parent_child'
    | 'trainer_client'
    | 'coach_athlete'
    | 'caregiver_family_member'
    | 'tutor_student'
    | 'mentor_mentee'
    | 'manager_team_member'
    | 'provider_patient'
    | 'accountability_partner'
    | 'family_member_family_member'
    | 'other';

/** Exact server-side vocabulary (connections_relationship_pair_check, create_invite_code) -- the client must never send a value outside this list. */
export const RELATIONSHIP_PAIRS: RelationshipPair[] = [
    'parent_child',
    'trainer_client',
    'coach_athlete',
    'caregiver_family_member',
    'tutor_student',
    'mentor_mentee',
    'manager_team_member',
    'provider_patient',
    'accountability_partner',
    'family_member_family_member',
    'other',
];

export function isRelationshipPair(value: unknown): value is RelationshipPair {
    return typeof value === 'string' && (RELATIONSHIP_PAIRS as string[]).includes(value);
}

export type RelationshipDefinition = {
    useCase: UseCase;
    /** i18n key -- short noun, e.g. "Trainer" (distinct from lib/onboardingCore.ts's chooseRole.*OrganizerTitle full-sentence cards, which serve the account-level role-selection screen, not a per-connection relationship picker). */
    organizerLabelKey: string;
    participantLabelKey: string;
    /** i18n key for the relationship-picker card shown at invite-creation time. */
    titleKey: string;
    descriptionKey: string;
    /** Ionicons glyph name. */
    icon: string;
};

const RELATIONSHIP_DEFINITIONS: Record<RelationshipPair, RelationshipDefinition> = {
    parent_child: {
        useCase: 'family',
        organizerLabelKey: 'relationshipPair.parentChild.organizerLabel',
        participantLabelKey: 'relationshipPair.parentChild.participantLabel',
        titleKey: 'relationshipPair.parentChild.title',
        descriptionKey: 'relationshipPair.parentChild.description',
        icon: 'home',
    },
    trainer_client: {
        useCase: 'coaching',
        organizerLabelKey: 'relationshipPair.trainerClient.organizerLabel',
        participantLabelKey: 'relationshipPair.trainerClient.participantLabel',
        titleKey: 'relationshipPair.trainerClient.title',
        descriptionKey: 'relationshipPair.trainerClient.description',
        icon: 'barbell',
    },
    coach_athlete: {
        useCase: 'coaching',
        organizerLabelKey: 'relationshipPair.coachAthlete.organizerLabel',
        participantLabelKey: 'relationshipPair.coachAthlete.participantLabel',
        titleKey: 'relationshipPair.coachAthlete.title',
        descriptionKey: 'relationshipPair.coachAthlete.description',
        icon: 'medal',
    },
    caregiver_family_member: {
        useCase: 'care',
        organizerLabelKey: 'relationshipPair.caregiverFamilyMember.organizerLabel',
        participantLabelKey: 'relationshipPair.caregiverFamilyMember.participantLabel',
        titleKey: 'relationshipPair.caregiverFamilyMember.title',
        descriptionKey: 'relationshipPair.caregiverFamilyMember.description',
        icon: 'heart',
    },
    tutor_student: {
        useCase: 'education',
        organizerLabelKey: 'relationshipPair.tutorStudent.organizerLabel',
        participantLabelKey: 'relationshipPair.tutorStudent.participantLabel',
        titleKey: 'relationshipPair.tutorStudent.title',
        descriptionKey: 'relationshipPair.tutorStudent.description',
        icon: 'school',
    },
    mentor_mentee: {
        useCase: 'education',
        organizerLabelKey: 'relationshipPair.mentorMentee.organizerLabel',
        participantLabelKey: 'relationshipPair.mentorMentee.participantLabel',
        titleKey: 'relationshipPair.mentorMentee.title',
        descriptionKey: 'relationshipPair.mentorMentee.description',
        icon: 'compass',
    },
    manager_team_member: {
        useCase: 'team',
        organizerLabelKey: 'relationshipPair.managerTeamMember.organizerLabel',
        participantLabelKey: 'relationshipPair.managerTeamMember.participantLabel',
        titleKey: 'relationshipPair.managerTeamMember.title',
        descriptionKey: 'relationshipPair.managerTeamMember.description',
        icon: 'briefcase',
    },
    provider_patient: {
        useCase: 'care',
        organizerLabelKey: 'relationshipPair.providerPatient.organizerLabel',
        participantLabelKey: 'relationshipPair.providerPatient.participantLabel',
        titleKey: 'relationshipPair.providerPatient.title',
        descriptionKey: 'relationshipPair.providerPatient.description',
        icon: 'medkit',
    },
    accountability_partner: {
        useCase: 'personal',
        organizerLabelKey: 'relationshipPair.accountabilityPartner.organizerLabel',
        participantLabelKey: 'relationshipPair.accountabilityPartner.participantLabel',
        titleKey: 'relationshipPair.accountabilityPartner.title',
        descriptionKey: 'relationshipPair.accountabilityPartner.description',
        icon: 'checkmark-circle',
    },
    family_member_family_member: {
        useCase: 'family',
        organizerLabelKey: 'relationshipPair.familyMemberFamilyMember.organizerLabel',
        participantLabelKey: 'relationshipPair.familyMemberFamilyMember.participantLabel',
        titleKey: 'relationshipPair.familyMemberFamilyMember.title',
        descriptionKey: 'relationshipPair.familyMemberFamilyMember.description',
        icon: 'people',
    },
    other: {
        useCase: 'other',
        organizerLabelKey: 'common.organizer',
        participantLabelKey: 'common.participant',
        titleKey: 'relationshipPair.other.title',
        descriptionKey: 'relationshipPair.other.description',
        icon: 'ellipsis-horizontal-circle',
    },
};

/** Full definition for a relationship pair, or null for null/unrecognized input -- callers fall back to generic Organizer/Participant copy in that case. */
export function getRelationshipDefinition(pair: string | null | undefined): RelationshipDefinition | null {
    if (pair && isRelationshipPair(pair)) return RELATIONSHIP_DEFINITIONS[pair];
    return null;
}

/** i18n key for the organizer-side noun (e.g. "Trainer") -- 'common.organizer' for null/unrecognized. */
export function getOrganizerLabelKey(pair: string | null | undefined): string {
    return getRelationshipDefinition(pair)?.organizerLabelKey ?? 'common.organizer';
}

/** i18n key for the participant-side noun (e.g. "Client") -- 'common.participant' for null/unrecognized. */
export function getParticipantLabelKey(pair: string | null | undefined): string {
    return getRelationshipDefinition(pair)?.participantLabelKey ?? 'common.participant';
}
