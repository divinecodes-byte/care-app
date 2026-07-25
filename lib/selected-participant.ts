import AsyncStorage from '@react-native-async-storage/async-storage';

// Account-scoped by userId (see docs/participant-management-model.md) --
// previously a single global key shared by every account that ever signed
// in on this device. Not a security issue on its own (loadDashboardData()
// always re-validates a stored id against the currently signed-in
// caregiver's own connections before using it), but it violated
// lib/accountCleanup.ts's own documented contract that this value is
// "cleared on logout and account switching," and meant a stale id could
// sit in storage under a key that no longer corresponds to any single
// account. Keying by userId makes each account's selection genuinely
// independent, so a switch never even has a chance to read a stale value.
const KEY_PREFIX = 'tavora.selectedParticipantConnectionId.';

function keyFor(userId: string): string {
    return `${KEY_PREFIX}${userId}`;
}

export async function getStoredSelectedConnectionId(userId: string): Promise<string | null> {
    try {
        return await AsyncStorage.getItem(keyFor(userId));
    } catch {
        return null;
    }
}

export async function setStoredSelectedConnectionId(userId: string, connectionId: string): Promise<void> {
    try {
        await AsyncStorage.setItem(keyFor(userId), connectionId);
    } catch {
        // Best-effort persistence — selection still works for this session.
    }
}

export async function clearStoredSelectedConnectionId(userId: string): Promise<void> {
    try {
        await AsyncStorage.removeItem(keyFor(userId));
    } catch {
        // Best-effort — a leftover key is harmless (see header comment).
    }
}
