// ─── Reminder frequency / days_of_week helpers ───────────────────────────────
// days_of_week is the source of truth for reminder eligibility. ISO weekday
// numbers: 1 = Monday ... 7 = Sunday. `frequency` is kept for preset
// selection/display only — every eligibility check must go through
// isDueOnDate() against days_of_week, never branch on frequency directly.

export type Frequency = 'daily' | 'weekdays' | 'weekends' | 'custom';

export const PRESET_DAYS: Record<'daily' | 'weekdays' | 'weekends', number[]> = {
    daily:    [1, 2, 3, 4, 5, 6, 7],
    weekdays: [1, 2, 3, 4, 5],
    weekends: [6, 7],
};

export const DAY_OPTIONS: { iso: number; short: string }[] = [
    { iso: 1, short: 'Mon' },
    { iso: 2, short: 'Tue' },
    { iso: 3, short: 'Wed' },
    { iso: 4, short: 'Thu' },
    { iso: 5, short: 'Fri' },
    { iso: 6, short: 'Sat' },
    { iso: 7, short: 'Sun' },
];

const DAY_SHORT: Record<number, string> = Object.fromEntries(
    DAY_OPTIONS.map((d) => [d.iso, d.short])
);

/** Convert a JS Date to ISO weekday number (1 = Monday ... 7 = Sunday). */
export function getIsoWeekday(date: Date): number {
    const jsDay = date.getDay(); // 0 = Sunday ... 6 = Saturday
    return jsDay === 0 ? 7 : jsDay;
}

/** True when `date`'s ISO weekday is included in days_of_week. */
export function isDueOnDate(daysOfWeek: number[], date: Date): boolean {
    return daysOfWeek.includes(getIsoWeekday(date));
}

/** Days array implied by a preset frequency, or the supplied custom days for 'custom'. */
export function daysForFrequency(frequency: Frequency, customDays: number[] = []): number[] {
    if (frequency === 'custom') return [...customDays].sort((a, b) => a - b);
    return PRESET_DAYS[frequency];
}

/** Which frequency a days_of_week array represents — detects exact preset matches, else 'custom'. */
export function frequencyForDays(daysOfWeek: number[]): Frequency {
    const sorted = [...daysOfWeek].sort((a, b) => a - b);
    for (const preset of ['daily', 'weekdays', 'weekends'] as const) {
        const presetSorted = PRESET_DAYS[preset];
        if (sorted.length === presetSorted.length && sorted.every((d, i) => d === presetSorted[i])) {
            return preset;
        }
    }
    return 'custom';
}

/** Human-readable frequency label, e.g. "Every day" or "Mon, Wed, Fri" for custom. */
export function formatFrequency(frequency: Frequency, daysOfWeek: number[]): string {
    if (frequency === 'daily')    return 'Every day';
    if (frequency === 'weekdays') return 'Weekdays';
    if (frequency === 'weekends') return 'Weekends';
    return [...daysOfWeek]
        .sort((a, b) => a - b)
        .map((d) => DAY_SHORT[d])
        .filter(Boolean)
        .join(', ');
}
