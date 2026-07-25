import { useEffect, useRef } from 'react';
import { AccessibilityInfo, findNodeHandle, Text, View } from 'react-native';

/**
 * Moves VoiceOver focus to the returned ref's element whenever `trigger`
 * changes to a truthy/new value — e.g. a heading right after a screen
 * transitions to a success/error state, or right after a modal opens.
 * Deliberately narrow: only fires on an explicit trigger change, never on
 * every render, so background polling or an unrelated re-render can't
 * unexpectedly steal focus away from whatever the user is doing.
 */
export function useFocusOnChange<T extends View | Text = any>(trigger: unknown) {
    const ref = useRef<T>(null);

    useEffect(() => {
        if (!trigger) return;
        const tag = ref.current ? findNodeHandle(ref.current) : null;
        if (tag) AccessibilityInfo.setAccessibilityFocus(tag);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [trigger]);

    return ref;
}
