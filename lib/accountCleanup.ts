import AsyncStorage from '@react-native-async-storage/async-storage';

import { cancelAllTavoraNotifications, deactivateCurrentUserPushTokens } from '@/lib/notifications';
import { clearStoredSelectedConnectionId } from '@/lib/selected-participant';
import { supabase } from '@/lib/supabase';

// ─── Central local cleanup for logout and account switching ─────────────────
//
// Single place that knows every piece of Tavora-specific local device state
// tied to a signed-in account, so nothing gets scattered across screens (or
// forgotten) as more local state is added over time. Used by both a normal
// sign-out (components/settings-sheet.tsx) and account deletion
// (app/delete-account.tsx) — the two are the same local cleanup, deletion
// just also destroys the server-side account first.
//
// Deliberately does NOT clear device-level preferences that exist
// independently of any account — theme (tavora.appearanceMode) and language
// (tavora.languageMode) are choices about this device, not this account, and
// should survive so a fresh signup/signin on the same device (by the same or
// a different person) doesn't lose them or re-run the first-launch language
// gate.
const ACCOUNT_SCOPED_KEYS = [
    'tavora.legacyLocalReminderNotificationsCleanedUp.v1', // notification migration flag
] as const;

/**
 * Clears every account-scoped AsyncStorage key. Safe to call on its own
 * (e.g. defensively right after detecting an account-switch) or as part of
 * the full logout() sequence below.
 *
 * The selected-participant cache (lib/selected-participant.ts) is keyed by
 * userId, not a fixed key, so it's cleared here by looking up whichever
 * account is still signed in at the moment this runs (logout() calls this
 * BEFORE signOut(), while that lookup is still possible) — a failed lookup
 * (e.g. already signed out, or offline) is harmless: a stale per-user key
 * left behind is never read by a different account regardless, since each
 * account only ever reads its own key.
 */
export async function clearAccountScopedLocalState(): Promise<void> {
    await AsyncStorage.multiRemove([...ACCOUNT_SCOPED_KEYS]).catch((err) =>
        console.warn('[accountCleanup] AsyncStorage clear failed:', err)
    );
    try {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) await clearStoredSelectedConnectionId(user.id);
    } catch (err) {
        console.warn('[accountCleanup] selected-participant clear failed:', err);
    }
}

export type LogoutResult = { tokenCleanupOk: boolean };

/**
 * The single logout sequence used everywhere a session ends. Order is
 * deliberate and safety-critical:
 *
 * 1. Deactivate this device's push token(s) for the CURRENT user, while a
 *    valid session still exists — push_tokens RLS requires
 *    user_id = auth.uid(), so this is only possible before signOut()
 *    clears the session. This is what stops the outgoing account from
 *    receiving pushes on this device once someone else signs in.
 * 2. Cancel any locally-scheduled Tavora notifications (legacy path only —
 *    server-authoritative recipients have nothing scheduled locally).
 * 3. Clear account-scoped local state (selected participant, migration
 *    flags) — never device-level preferences.
 * 4. Sign out of Supabase last, once every step that needed a live session
 *    has already run.
 *
 * Every step is independently best-effort: a failure at step 1 (e.g. the
 * device is offline) does not stop steps 2-4 from completing, so a network
 * failure can never trap a user in an account they're trying to leave. See
 * docs/auth-session-model.md for how a failed token deactivation gets
 * reconciled later (the next successful push-token registration from any
 * account on this device reassigns the token away regardless, via
 * register_push_token's ON CONFLICT reassignment).
 */
export async function logout(): Promise<LogoutResult> {
    const tokenCleanupOk = await deactivateCurrentUserPushTokens().catch(() => false);
    await cancelAllTavoraNotifications().catch((err) => console.warn('[accountCleanup] notification cancel failed:', err));
    await clearAccountScopedLocalState();
    await supabase.auth.signOut().catch((err) => console.warn('[accountCleanup] signOut failed:', err));
    return { tokenCleanupOk };
}

/**
 * Runs after a successful account deletion (delete-account Edge Function
 * already returned success, and server-side cleanup — including hard-
 * deleting every push_tokens row for this user — has already happened).
 * Reuses the exact same local sequence as a normal logout: by this point
 * there's nothing left server-side for step 1 to touch, so it's a
 * harmless no-op rather than redundant special-casing.
 */
export async function performLocalAccountCleanup(): Promise<void> {
    await logout();
}
