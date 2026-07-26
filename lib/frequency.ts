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

/**
 * Maps an ISO weekday number to the `reminderForm.day*` i18n key suffix
 * (e.g. `t('reminderForm.day' + DAY_ISO_TO_KEY[1])` = `t('reminderForm.dayMon')`)
 * — kept here (not inline at call sites) so there is exactly one place
 * mapping ISO days to translatable identifiers. `DAY_OPTIONS.short` above
 * stays as the English fallback/default used by this pure module's own
 * callers (e.g. scripts/reminder-audit/run.ts, which has no i18n context)
 * and by `formatFrequency()` below when no localized `dayLabels` are
 * supplied.
 */
export const DAY_ISO_TO_KEY: Record<number, string> = {
    1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 7: 'Sun',
};

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

/**
 * Builds the `labels` argument `formatFrequency()` expects, from any `t()`
 * function (works with the real `useTranslation()` hook's return value at
 * any UI call site — this helper itself has no React/i18n import, so it
 * stays safe for `lib/frequency.ts` to keep exporting with zero
 * dependencies for its own non-UI callers).
 */
export function buildFrequencyLabels(t: (key: string) => string) {
    return {
        everyDay: t('reminderForm.summaryEveryDay'),
        weekdays: t('reminderForm.summaryWeekdays'),
        weekends: t('reminderForm.summaryWeekends'),
        dayShort: {
            1: t('reminderForm.dayMon'),
            2: t('reminderForm.dayTue'),
            3: t('reminderForm.dayWed'),
            4: t('reminderForm.dayThu'),
            5: t('reminderForm.dayFri'),
            6: t('reminderForm.daySat'),
            7: t('reminderForm.daySun'),
        },
    };
}

/**
 * Human-readable frequency label, e.g. "Every day" or "Mon, Wed, Fri" for
 * custom. `labels` is optional so this stays callable with no i18n context
 * (e.g. scripts/reminder-audit/run.ts, a plain Node script) — UI call sites
 * should always pass the current locale's labels; the English fallback
 * below exists only for that non-UI, non-localized caller.
 */
export function formatFrequency(
    frequency: Frequency,
    daysOfWeek: number[],
    labels?: { everyDay: string; weekdays: string; weekends: string; dayShort: Record<number, string> }
): string {
    if (frequency === 'daily')    return labels?.everyDay ?? 'Every day';
    if (frequency === 'weekdays') return labels?.weekdays ?? 'Weekdays';
    if (frequency === 'weekends') return labels?.weekends ?? 'Weekends';
    const dayShort = labels?.dayShort ?? DAY_SHORT;
    return [...daysOfWeek]
        .sort((a, b) => a - b)
        .map((d) => dayShort[d])
        .filter(Boolean)
        .join(', ');
}
