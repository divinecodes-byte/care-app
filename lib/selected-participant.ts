import AsyncStorage from '@react-native-async-storage/async-storage';

const SELECTED_PARTICIPANT_KEY = 'tavora.selectedParticipantConnectionId';

export async function getStoredSelectedConnectionId(): Promise<string | null> {
    try {
        return await AsyncStorage.getItem(SELECTED_PARTICIPANT_KEY);
    } catch {
        return null;
    }
}

export async function setStoredSelectedConnectionId(connectionId: string): Promise<void> {
    try {
        await AsyncStorage.setItem(SELECTED_PARTICIPANT_KEY, connectionId);
    } catch {
        // Best-effort persistence — selection still works for this session.
    }
}
