import AsyncStorage from '@react-native-async-storage/async-storage';

import { cancelAllTavoraNotifications } from '@/lib/notifications';
import { supabase } from '@/lib/supabase';

// ─── Central local cleanup for account deletion ──────────────────────────────
//
// Single place that knows every piece of Tavora-specific local device state
// tied to a signed-in account, so nothing gets scattered across screens (or
// forgotten) as more local state is added over time.
//
// Deliberately does NOT clear device-level preferences that exist
// independently of any account — theme (tavora.appearanceMode) and language
// (tavora.languageMode) are choices about this device, not this account, and
// should survive so a fresh signup/signin on the same device doesn't lose
// them or re-run the first-launch language gate.
const ACCOUNT_SCOPED_KEYS = [
    'tavora.legacyLocalReminderNotificationsCleanedUp.v1', // notification migration flag
    'tavora.selectedParticipantConnectionId',              // caregiver's selected-recipient cache
] as const;

/**
 * Runs after a successful account deletion (delete-account Edge Function
 * returned success): cancels every local Tavora notification, clears every
 * account-scoped AsyncStorage key, and clears the Supabase session — in
 * that order, so nothing local can still reference an account that no
 * longer exists by the time this resolves. Safe to call even if some step
 * fails partway (each step is independent and best-effort beyond the first
 * notification-cancellation, which failing should not block session/state
 * cleanup from still happening).
 */
export async function performLocalAccountCleanup(): Promise<void> {
    await cancelAllTavoraNotifications().catch((err) => console.warn('[accountCleanup] notification cancel failed:', err));
    await AsyncStorage.multiRemove([...ACCOUNT_SCOPED_KEYS]).catch((err) => console.warn('[accountCleanup] AsyncStorage clear failed:', err));
    await supabase.auth.signOut().catch((err) => console.warn('[accountCleanup] signOut failed:', err));
}
