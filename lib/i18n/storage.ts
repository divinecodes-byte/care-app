import AsyncStorage from '@react-native-async-storage/async-storage';

export type LanguageMode = 'system' | 'en' | 'es';
export type SupportedLanguage = 'en' | 'es';

export const LANGUAGE_MODE_KEY = 'tavora.languageMode';

export async function getStoredLanguageMode(): Promise<LanguageMode | null> {
    try {
        const value = await AsyncStorage.getItem(LANGUAGE_MODE_KEY);
        if (value === 'system' || value === 'en' || value === 'es') return value;
        return null;
    } catch {
        return null;
    }
}

export async function setStoredLanguageMode(mode: LanguageMode): Promise<void> {
    try {
        await AsyncStorage.setItem(LANGUAGE_MODE_KEY, mode);
    } catch {
        // Best-effort — in-memory state still updates for this session even
        // if persistence fails (e.g. storage full).
    }
}

/**
 * Resolves "system" to a supported language using the JS engine's Intl data
 * (Hermes ships with Intl support) rather than a native module — avoids
 * adding a new native dependency this close to a TestFlight build.
 */
export function resolveSystemLanguage(): SupportedLanguage {
    try {
        const locale = Intl.DateTimeFormat().resolvedOptions().locale || '';
        if (locale.toLowerCase().startsWith('es')) return 'es';
    } catch {
        // Intl unavailable for some reason — fall back to English.
    }
    return 'en';
}
