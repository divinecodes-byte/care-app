// Onboarding helpers used by app code. Re-exports the pure use-case/role-
// label/resume-route logic from lib/onboardingCore.ts (kept free of any
// react-native/supabase import so it stays importable from plain Node/tsx
// test scripts — see that file's header comment) and adds the two
// functions that genuinely need a live Supabase client.

import { supabase } from './supabase';

export * from './onboardingCore';
import { OnboardingEventType } from './onboardingCore';

/**
 * Best-effort, fire-and-forget funnel logging. Never awaited by callers and
 * never throws — an onboarding event is an operational signal, not
 * something any user-facing flow should wait on or fail over. Only ever
 * writes { user_id, event_type }; never pass reminder titles, names,
 * emails, tokens, or notes into this.
 */
export function logOnboardingEvent(eventType: OnboardingEventType): void {
    supabase.auth.getUser()
        .then(({ data: { user } }) => {
            if (!user) return;
            return supabase.from('onboarding_events').insert({ user_id: user.id, event_type: eventType });
        })
        .catch(() => {});
}

/** Whether a recipient has at least one accepted connection — the signal that distinguishes "role chosen but never joined an invite" from "onboarding complete" for recipients, since role alone is not a complete proxy for a recipient. */
export async function recipientHasAcceptedConnection(userId: string): Promise<boolean> {
    const { count } = await supabase
        .from('connections')
        .select('id', { count: 'exact', head: true })
        .eq('recipient_id', userId)
        .eq('status', 'accepted');
    return (count ?? 0) > 0;
}
