import { useCallback, useRef } from 'react';

/**
 * Formalizes the stale-request-guard pattern already proven in
 * caregiver-dashboard.tsx (its own `loadGenerationRef`) so any screen that
 * re-fetches on a changing selection (participant switch, reminder id,
 * connection id) can protect itself the same way, without re-inventing
 * the ref/counter every time.
 *
 * Usage:
 *   const { start, isCurrent } = useRequestGeneration();
 *   async function load(id: string) {
 *     const gen = start();
 *     const data = await fetchThing(id);
 *     if (!isCurrent(gen)) return; // a newer load() call has since started -- discard
 *     setState(data);
 *   }
 */
export function useRequestGeneration() {
    const ref = useRef(0);

    const start = useCallback((): number => {
        ref.current += 1;
        return ref.current;
    }, []);

    const isCurrent = useCallback((generation: number): boolean => ref.current === generation, []);

    return { start, isCurrent };
}
