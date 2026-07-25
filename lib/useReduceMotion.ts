import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * Tracks the OS-level Reduce Motion setting live (not just at mount) —
 * a user can toggle it in Settings while Tavora is already running, and
 * any nonessential looping/decorative animation should react immediately,
 * not just on the next cold launch.
 */
export function useReduceMotion(): boolean {
    const [reduceMotion, setReduceMotion] = useState(false);

    useEffect(() => {
        let mounted = true;
        AccessibilityInfo.isReduceMotionEnabled?.().then((enabled) => {
            if (mounted) setReduceMotion(enabled);
        });
        const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', (enabled: boolean) => {
            setReduceMotion(enabled);
        });
        return () => {
            mounted = false;
            sub?.remove?.();
        };
    }, []);

    return reduceMotion;
}
