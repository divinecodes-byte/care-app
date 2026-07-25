import { ErrorCategory } from './asyncStateCore';

/** Stable i18n key for each classified UI error category — pass to t(). Never render a raw error.message; always go through classifyScreenError() + this map. */
export const ERROR_CATEGORY_TRANSLATION_KEYS: Record<ErrorCategory, string> = {
    network: 'stateErrors.network',
    session_expired: 'stateErrors.sessionExpired',
    unauthorized: 'stateErrors.unauthorized',
    no_longer_active: 'stateErrors.noLongerActive',
    already_completed: 'stateErrors.alreadyCompleted',
    validation: 'stateErrors.validation',
    rate_limited: 'stateErrors.rateLimited',
    unexpected: 'stateErrors.unexpected',
};
