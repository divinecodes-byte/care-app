import AsyncStorage from '@react-native-async-storage/async-storage';
import {
    createContext,
    ReactNode,
    useContext,
    useEffect,
    useMemo,
    useState,
} from 'react';
import { Appearance, ColorSchemeName } from 'react-native';

import { T, T_DARK, ThemeColors } from '@/constants/theme';

export type AppearanceMode = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'tavora.appearanceMode';

type ThemeContextValue = {
    mode: AppearanceMode;
    resolvedScheme: 'light' | 'dark';
    colors: ThemeColors;
    setMode: (mode: AppearanceMode) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
    const [mode, setModeState] = useState<AppearanceMode>('system');
    const [systemScheme, setSystemScheme] = useState<ColorSchemeName>(
        Appearance.getColorScheme()
    );

    useEffect(() => {
        AsyncStorage.getItem(STORAGE_KEY).then((stored) => {
            if (stored === 'light' || stored === 'dark' || stored === 'system') {
                setModeState(stored);
            }
        });
    }, []);

    useEffect(() => {
        const sub = Appearance.addChangeListener(({ colorScheme }) => setSystemScheme(colorScheme));
        return () => sub.remove();
    }, []);

    function setMode(next: AppearanceMode) {
        setModeState(next);
        AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {});
    }

    const resolvedScheme: 'light' | 'dark' =
        mode === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : mode;

    const colors = resolvedScheme === 'dark' ? T_DARK : T;

    const value = useMemo(
        () => ({ mode, resolvedScheme, colors, setMode }),
        [mode, resolvedScheme, colors]
    );

    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

function useThemeContext(): ThemeContextValue {
    const ctx = useContext(ThemeContext);
    if (!ctx) throw new Error('Theme hooks must be used within ThemeProvider');
    return ctx;
}

/** Resolved color palette (light or dark) for the current appearance mode. */
export function useThemeColors(): ThemeColors {
    return useThemeContext().colors;
}

/** Appearance mode state — 'system' | 'light' | 'dark' — plus setter and resolved scheme. */
export function useThemeMode() {
    const { mode, resolvedScheme, setMode } = useThemeContext();
    return { mode, resolvedScheme, setMode };
}
