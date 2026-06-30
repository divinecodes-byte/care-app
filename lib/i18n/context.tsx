import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from 'react';

import { es } from './locales/es';
import { en } from './locales/en';
import {
    getStoredLanguageMode,
    LanguageMode,
    resolveSystemLanguage,
    setStoredLanguageMode,
    SupportedLanguage,
} from './storage';

type Dictionary = typeof en;

const dictionaries: Record<SupportedLanguage, Dictionary> = { en, es };

function lookup(dict: Dictionary, key: string): unknown {
    return key.split('.').reduce<unknown>((node, part) => {
        if (node && typeof node === 'object') return (node as Record<string, unknown>)[part];
        return undefined;
    }, dict);
}

type LanguageContextValue = {
    /** The stored preference — 'system' until the user picks a fixed language. */
    languageMode: LanguageMode;
    /** The actual language being rendered right now. */
    language: SupportedLanguage;
    /** True once a language choice (including "system") has been made and persisted. */
    hasChosenLanguage: boolean;
    /** True once the AsyncStorage read on mount has finished. */
    ready: boolean;
    setLanguageMode: (mode: LanguageMode) => Promise<void>;
    t: (key: string, vars?: Record<string, string | number>) => string;
};

const LanguageContext = createContext<LanguageContextValue | undefined>(undefined);

export function LanguageProvider({ children }: { children: ReactNode }) {
    const [languageMode, setLanguageModeState] = useState<LanguageMode>('system');
    const [hasChosenLanguage, setHasChosenLanguage] = useState(false);
    const [ready, setReady] = useState(false);

    useEffect(() => {
        (async () => {
            const stored = await getStoredLanguageMode();
            if (stored) {
                setLanguageModeState(stored);
                setHasChosenLanguage(true);
            }
            setReady(true);
        })();
    }, []);

    const language = useMemo<SupportedLanguage>(() => {
        return languageMode === 'system' ? resolveSystemLanguage() : languageMode;
    }, [languageMode]);

    async function setLanguageMode(mode: LanguageMode) {
        setLanguageModeState(mode);
        setHasChosenLanguage(true);
        await setStoredLanguageMode(mode);
    }

    const t = useMemo(() => {
        const dict = dictionaries[language] ?? dictionaries.en;
        return (key: string, vars?: Record<string, string | number>): string => {
            let value = lookup(dict, key);
            if (typeof value !== 'string') value = lookup(dictionaries.en, key);
            const result = typeof value === 'string' ? value : key;
            if (!vars) return result;
            return Object.entries(vars).reduce(
                (str, [name, val]) => str.replace(new RegExp(`{{${name}}}`, 'g'), String(val)),
                result
            );
        };
    }, [language]);

    const value = useMemo(
        () => ({ languageMode, language, hasChosenLanguage, ready, setLanguageMode, t }),
        [languageMode, language, hasChosenLanguage, ready, t]
    );

    return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
    const ctx = useContext(LanguageContext);
    if (!ctx) throw new Error('useLanguage must be used within a LanguageProvider');
    return ctx;
}

export function useTranslation(): LanguageContextValue['t'] {
    return useLanguage().t;
}

/** Localized display label for a reminder status — the DB/code value stays untranslated. */
export function useStatusLabel(): (status: 'pending' | 'taken' | 'snoozed' | 'skipped' | 'missed') => string {
    const t = useTranslation();
    return (status) => t(`status.${status}`);
}
