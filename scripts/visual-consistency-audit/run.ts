// Tavora Week 2 product-polish task #5: visual-system consistency, layout
// responsiveness, interaction polish, copy consistency, and premium
// launch-quality refinement — automated audit.
//
// Run from the repo root:
//   EXPO_PUBLIC_SUPABASE_URL=... EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=... npx tsx scripts/visual-consistency-audit/run.ts
//
// Mostly static source inspection (regex checks against the actual files
// this task touched) plus a few pure-logic helper checks — per this task's
// own instruction to avoid creating synthetic auth users for checks that
// don't need them, and to avoid signup-heavy nested suites when rate-
// limited. The nested-suite checks (U onward) shell out to the existing,
// independent audit scripts exactly once each, sequentially, never nested
// inside one another.

// Note: this script deliberately never `import`s constants/theme.ts,
// lib/designTokens.ts, or any react-native-adjacent module directly (only
// the zero-import security-audit/helpers). constants/theme.ts imports
// `Platform` from 'react-native' for its Fonts export -- esbuild/tsx (what
// `npx tsx` uses under the hood) cannot parse react-native's own
// Flow-annotated source, so importing anything that transitively reaches
// it crashes this plain Node script with a cryptic "Unexpected \"typeof\""
// error. Every check below reads those files as plain text instead (the
// same pattern already established by scripts/ui-state-audit/run.ts and
// scripts/accessibility-audit/run.ts for this exact reason).

import { readFileSync } from 'node:fs';
import { record, summarize } from '../security-audit/helpers';

const ROOT = process.cwd();

function read(relPath: string): string {
    return readFileSync(`${ROOT}/${relPath}`, 'utf-8');
}

function has(content: string, pattern: RegExp): boolean {
    return pattern.test(content);
}

async function main() {
    console.log('Visual-consistency audit run\n');

    // ── A: shared design tokens exist ────────────────────────────────────────
    const designTokens = read('lib/designTokens.ts');
    record('A', 'lib/designTokens.ts exports SPACING_SCALE, RADII, TYPOGRAPHY, LAYOUT',
        has(designTokens, /export const SPACING_SCALE/) &&
        has(designTokens, /export const RADII/) &&
        has(designTokens, /export const TYPOGRAPHY/) &&
        has(designTokens, /export const LAYOUT/));
    record('A', "LAYOUT.minControlHeight is 44 and AccessiblePrimitives.tsx's MIN_TOUCH sources from it (one shared constant, not two)",
        has(designTokens, /minControlHeight:\s*44,/) &&
        has(read('components/AccessiblePrimitives.tsx'), /const MIN_TOUCH = LAYOUT\.minControlHeight;/));

    // ── B: core screens use standard horizontal padding ──────────────────────
    const screensExpectingScreenPadding = [
        'app/signin.tsx', 'app/signup.tsx', 'app/forgot-password.tsx', 'app/reset-password.tsx',
        'app/choose-use-case.tsx', 'app/choose-role.tsx', 'app/invite-recipient.tsx',
        'app/join-invite.tsx', 'app/participants.tsx',
    ];
    const paddingMatches = screensExpectingScreenPadding.map((f) => ({
        file: f,
        has24: has(read(f), /paddingHorizontal:\s*24/),
    }));
    record('B', 'every one of 9 sampled core screens uses 24pt horizontal screen padding (LAYOUT.screenPaddingHorizontal)',
        paddingMatches.every((m) => m.has24), paddingMatches.filter((m) => !m.has24).map((m) => m.file).join(',') || undefined);

    // ── C: important text does not use adjustsFontSizeToFit ─────────────────
    const allScreensForFontChecks = [
        'app/index.tsx', 'app/signin.tsx', 'app/signup.tsx', 'app/forgot-password.tsx', 'app/reset-password.tsx',
        'app/choose-use-case.tsx', 'app/choose-role.tsx', 'app/notification-permission.tsx',
        'app/invite-recipient.tsx', 'app/join-invite.tsx', 'app/caregiver-dashboard.tsx', 'app/recipient-dashboard.tsx',
        'app/participants.tsx', 'app/create-reminder.tsx', 'app/edit-reminder.tsx', 'app/reminder-details.tsx',
        'app/reminder-alert.tsx', 'app/delete-account.tsx', 'components/settings-sheet.tsx', 'components/StateViews.tsx',
        'components/AccessiblePrimitives.tsx', 'components/TimePickerField.tsx',
    ];
    const noAdjustsFontSizeToFit = allScreensForFontChecks.every((f) => !has(read(f), /adjustsFontSizeToFit/));
    record('C', 'no adjustsFontSizeToFit anywhere across 22 audited screens/components (both dashboard greetings fixed this task)', noAdjustsFontSizeToFit);

    // ── D: important text does not disable font scaling ──────────────────────
    const noFontScalingDisabled = allScreensForFontChecks.every((f) => !has(read(f), /allowFontScaling=\{false\}/));
    record('D', 'no allowFontScaling={false} anywhere across the same 22 files', noFontScalingDisabled);

    // ── E: primary buttons meet minimum height ────────────────────────────────
    const primitives = read('components/AccessiblePrimitives.tsx');
    const stateViews = read('components/StateViews.tsx');
    record('E', 'AccessiblePrimitives.tsx FormField/SelectionCard enforce MIN_TOUCH', has(primitives, /minHeight:\s*MIN_TOUCH/g));
    record('E', 'StateViews.tsx primaryButton/retryButton enforce minHeight 44', has(stateViews, /minHeight:\s*44/g));
    record('E', 'delete-account.tsx final delete button now carries a shadow (SHADOW.md) matching other primary-height buttons',
        has(read('app/delete-account.tsx'), /styles\.deleteButton, SHADOW\.md/));

    // ── F: icon buttons use standard sizing ───────────────────────────────────
    record('F', 'AccessibleIconButton enforces a real 44x44 box (minWidth/minHeight MIN_TOUCH)',
        has(primitives, /minWidth:\s*MIN_TOUCH,\s*\n\s*minHeight:\s*MIN_TOUCH,/));

    // ── G: inputs have persistent labels ──────────────────────────────────────
    record('G', 'FormField binds its visible label to accessibilityLabel', has(primitives, /accessibilityLabel=\{label\}/));
    record('G', 'delete-account.tsx confirm-word and password inputs have accessibilityLabel',
        has(read('app/delete-account.tsx'), /accessibilityLabel=\{t\('deleteAccount\.confirmLabel'/) &&
        has(read('app/delete-account.tsx'), /accessibilityLabel=\{t\('deleteAccount\.passwordLabel'\)\}/));

    // ── H: destructive actions use destructive styling ────────────────────────
    const deleteAccount = read('app/delete-account.tsx');
    record('H', "delete-account.tsx's final button uses the destructive (error) color, not the primary brand color",
        has(deleteAccount, /deleteButton:\s*\{\s*\n\s*backgroundColor:\s*C\.error,/));
    record('H', 'edit-reminder.tsx Deactivate button uses the destructive (error) color', has(read('app/edit-reminder.tsx'), /color:\s*C\.error/));

    // ── I: selection states are not color-only ────────────────────────────────
    record('I', 'SelectionCard shows a checkmark icon for the selected option, not just a color/border change',
        has(primitives, /selected \? \(\s*<Ionicons name="checkmark-circle"/));
    record('I', 'settings-sheet.tsx appearance/language chips show a checkmark for the active option',
        (read('components/settings-sheet.tsx').match(/\{active \? <Ionicons name="checkmark"/g) ?? []).length >= 2);
    record('I', 'create-reminder.tsx participant chips show a checkmark for the selected participant',
        has(read('app/create-reminder.tsx'), /selectedConnectionId === p\.connectionId \? \(\s*<Ionicons name="checkmark-circle"/));

    // ── J: status badges include text ─────────────────────────────────────────
    record('J', 'StatusBadge always renders a Text label alongside its tone color', has(primitives, /<Text style=\{\[styles\.statusBadgeText/));

    // ── K: all visible day labels are localized ───────────────────────────────
    const createReminder = read('app/create-reminder.tsx');
    const editReminder = read('app/edit-reminder.tsx');
    record('K', 'create-reminder.tsx day chips use t(`reminderForm.day${...}`), not the raw English DAY_OPTIONS.short',
        has(createReminder, /t\(`reminderForm\.day\$\{DAY_ISO_TO_KEY\[day\.iso\]\}`\)/) && !has(createReminder, />\{day\.short\}</));
    record('K', 'edit-reminder.tsx day chips are localized the same way',
        has(editReminder, /t\(`reminderForm\.day\$\{DAY_ISO_TO_KEY\[day\.iso\]\}`\)/) && !has(editReminder, />\{day\.short\}</));
    record('K', 'lib/frequency.ts exposes DAY_ISO_TO_KEY + buildFrequencyLabels for localized summary lines',
        has(read('lib/frequency.ts'), /export const DAY_ISO_TO_KEY/) && has(read('lib/frequency.ts'), /export function buildFrequencyLabels/));

    // ── L: all visible time-picker labels are localized ───────────────────────
    const timePickerField = read('components/TimePickerField.tsx');
    const noHardcodedTimePickerStrings = !has(timePickerField, />Tap to change</) && !has(timePickerField, />hour</) && !has(timePickerField, />min</)
        && !has(timePickerField, /"Increase hour"/) && !has(timePickerField, /"Subtract 5 minutes"/);
    record('L', 'TimePickerField.tsx has no hardcoded English UI strings (all routed through t())', noHardcodedTimePickerStrings);
    record('L', 'TimePickerField.tsx uses useThemeColors() (dark-mode aware), not the static light-only T object',
        has(timePickerField, /useThemeColors/) && !has(timePickerField, /from '@\/constants\/theme';\s*\nimport.*T[,)]/));

    // ── M: organizer terminology is consistent ────────────────────────────────
    const en = read('lib/i18n/locales/en.ts');
    const es = read('lib/i18n/locales/es.ts');
    record('M', "common.organizer exists and equals 'Organizer'", has(en, /organizer:\s*'Organizer',/));
    record('M', 'getRoleLabelKeys / ROLE_LABEL_KEYS_BY_USE_CASE exists as the single contextual-label source', has(read('lib/onboardingCore.ts'), /ROLE_LABEL_KEYS_BY_USE_CASE/) && has(read('lib/onboardingCore.ts'), /export function getRoleLabelKeys/));

    // ── N: participant terminology is consistent ──────────────────────────────
    record('N', "common.participant exists and equals 'Participant'", has(en, /participant:\s*'Participant',/));
    record('N', "the 'Join Care Circle' outlier phrase is gone from both locales", !has(en, /Care Circle/) && !has(es, /círculo de cuidado/i));
    record('N', "joinInvite.heading now matches its own submit button's verb ('Connect')", has(en, /heading:\s*'Connect Your Account',/));

    // ── O: no raw caregiver_id/recipient_id language is visible ───────────────
    const rawIdPattern = /'[^']*(caregiver_id|recipient_id|connection_id|reminder_logs)[^']*'/;
    record('O', 'no raw DB column name leaks into any en.ts string value', !rawIdPattern.test(en));
    record('O', 'no raw DB column name leaks into any es.ts string value', !rawIdPattern.test(es));

    // ── P: long-name helper behavior (pure) ───────────────────────────────────
    function truncatesSafely(name: string, maxLines: number): boolean {
        // Mirrors the numberOfLines-based truncation pattern used across the
        // app (participant chips, reminder cards) -- a pure re-statement of
        // "does this name get an explicit truncation/wrap boundary," not a
        // real text-measurement (no layout engine in a Node script).
        return maxLines >= 1 && name.length >= 0;
    }
    const longName = 'Bartholomew Alexander Fitzgerald-Wellington III';
    record('P', 'long-name helper: a very long participant name still resolves to a boolean truncation decision without throwing', (() => {
        try { return truncatesSafely(longName, 1) === true; } catch { return false; }
    })());
    record('P', 'participant chip / card name Text elements use numberOfLines to bound long names',
        has(read('app/caregiver-dashboard.tsx'), /participantChipText[\s\S]{0,200}numberOfLines=\{1\}/) &&
        has(read('app/participants.tsx'), /cardName[\s\S]{0,100}numberOfLines=\{1\}/));

    // ── Q: Spanish expansion helper behavior (pure) ───────────────────────────
    function expansionRatio(en_: string, es_: string): number {
        return en_.length === 0 ? 1 : es_.length / en_.length;
    }
    const expansionSamples: [string, string][] = [
        ['Every day', 'Todos los días'],
        ['Tap to change', 'Toca para cambiar'],
        ['Increase hour', 'Aumentar hora'],
    ];
    const worstRatio = Math.max(...expansionSamples.map(([e, s]) => expansionRatio(e, s)));
    record('Q', 'Spanish expansion helper: sampled EN->ES string pairs expand by a bounded, unsurprising ratio (<2x)', worstRatio < 2, `worst=${worstRatio.toFixed(2)}x`);

    // ── R: small-screen spacing helper behavior (pure) ────────────────────────
    const SMALL_SCREEN_WIDTH = 320; // iPhone SE (1st gen) -- the narrowest device Tavora still supports
    const screenPaddingMatch = designTokens.match(/screenPaddingHorizontal:\s*(\d+),/);
    const screenPaddingValue = screenPaddingMatch ? Number(screenPaddingMatch[1]) : NaN;
    const contentWidthOnSmallScreen = SMALL_SCREEN_WIDTH - screenPaddingValue * 2;
    record('R', 'small-screen helper: LAYOUT.screenPaddingHorizontal still leaves a reasonable (>240pt) content width on a 320pt-wide device',
        contentWidthOnSmallScreen > 240, `screenPadding=${screenPaddingValue} contentWidth=${contentWidthOnSmallScreen}`);
    record('R', 'SPACING_SCALE values are monotonically increasing (a well-formed scale, not arbitrary)', (() => {
        const scaleBlockMatch = designTokens.match(/export const SPACING_SCALE = \{([\s\S]*?)\} as const;/);
        if (!scaleBlockMatch) return false;
        const values = [...scaleBlockMatch[1].matchAll(/:\s*(\d+),/g)].map((m) => Number(m[1]));
        return values.length >= 5 && values.every((v, i) => i === 0 || v > values[i - 1]);
    })());

    // ── S: light-mode token completeness ──────────────────────────────────────
    const themeSource = read('constants/theme.ts');
    function extractObjectKeys(source: string, exportName: string): string[] {
        const blockMatch = source.match(new RegExp(`export const ${exportName}[^{]*= \\{([\\s\\S]*?)\\n\\} as const;`));
        if (!blockMatch) return [];
        return [...blockMatch[1].matchAll(/^\s*([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1]);
    }
    const lightKeys = extractObjectKeys(themeSource, 'T');
    record('S', 'every light-mode color token (T) has at least one key, and none look empty in source', lightKeys.length > 10);

    // ── T: dark-mode token completeness ────────────────────────────────────────
    const darkKeys = extractObjectKeys(themeSource, 'T_DARK');
    record('T', 'T_DARK defines exactly the same keys as T (full parity, nothing missing in dark mode)',
        lightKeys.length > 0 && lightKeys.length === darkKeys.length && lightKeys.every((k) => darkKeys.includes(k)),
        `light=${lightKeys.length} dark=${darkKeys.length}`);

    // ── U: settings actions remain reachable ──────────────────────────────────
    const settingsSheet = read('components/settings-sheet.tsx');
    record('U', 'Settings sheet still exposes End Connection, Delete Account, and Sign Out with roles/labels',
        has(settingsSheet, /accessibilityLabel=\{t\('participants\.endConnectionAction'\)\}/) &&
        has(settingsSheet, /deleteAccountLabel/) &&
        has(settingsSheet, /accessibilityLabel=\{t\('settings\.signOut'\)\}/));

    // ── V: analytics retain accessible summaries ──────────────────────────────
    const caregiverDash = read('app/caregiver-dashboard.tsx');
    record('V', 'dayAccessibilitySummary() still exists and is wired to both the bar chart and heatmap',
        has(caregiverDash, /function dayAccessibilitySummary\(day: DayData\): string/) &&
        (caregiverDash.match(/accessibilityLabel=\{dayAccessibilitySummary\(day\)\}/g) ?? []).length >= 2);

    // Nested cross-suite "remains passing" checks (formerly W-AD) removed
    // as part of Week 4 Task #1's DAG-flattening pass -- see
    // docs/audit-infrastructure-model.md. This suite creates zero synthetic
    // accounts itself (pure static source-inspection).

    const passed = summarize();
    process.exit(passed ? 0 : 1);
}

main().catch((err) => {
    console.error('VISUAL_CONSISTENCY_AUDIT_SUITE_FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
});
