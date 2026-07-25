import { EndConnectionErrorKind } from '@/lib/connections';

/** Stable i18n key for each classified end-connection error kind — pass to t(). */
export const CONNECTION_ERROR_TRANSLATION_KEYS: Record<EndConnectionErrorKind, string> = {
    not_authorized: 'connectionErrors.notAuthorized',
    not_found: 'connectionErrors.notFound',
    network: 'connectionErrors.network',
    unexpected: 'connectionErrors.unexpected',
};
