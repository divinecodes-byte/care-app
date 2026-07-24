import { ReminderLifecycleErrorKind } from '@/lib/reminderLifecycle';

/** Stable i18n key for each classified reminder-lifecycle error kind — pass to t(). */
export const REMINDER_ERROR_TRANSLATION_KEYS: Record<ReminderLifecycleErrorKind, string> = {
    already_answered: 'reminderErrors.alreadyAnswered',
    reminder_inactive: 'reminderErrors.reminderInactive',
    connection_inactive: 'reminderErrors.connectionInactive',
    not_eligible: 'reminderErrors.notEligible',
    not_authorized: 'reminderErrors.notAuthorized',
    invalid_input: 'reminderErrors.invalidInput',
    network: 'reminderErrors.network',
    unexpected: 'reminderErrors.unexpected',
};
