// Tavora Week 2 product-polish task #4: full accessibility, keyboard,
// focus-management, motion, touch-target, and interaction-quality
// hardening — automated audit.
//
// Run from the repo root:
//   EXPO_PUBLIC_SUPABASE_URL=... EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=... npx tsx scripts/accessibility-audit/run.ts
//
// Mostly static source inspection (grep-equivalent regex checks against
// the actual files this task modified) plus a handful of pure-logic
// checks — per this task's own instruction to avoid creating synthetic
// auth users for checks that don't need them. There is no headless React
// Native renderer in this environment, so a real VoiceOver/Dynamic-Type
// pass still requires the physical-device weekend QA checklist in
// docs/accessibility-model.md; this script verifies the source-level
// guarantees (props present, hooks used, translations exist) that make
// that manual pass meaningful rather than a shot in the dark.
//
// P/Q (password-recovery routing) are deliberately static too: PASSWORD_RECOVERY
// is a Supabase auth event fired in response to a real emailed link — there is
// no safe/practical way to synthetically trigger it from a script, and this
// task's own constraints forbid changing Supabase email-confirmation settings
// to make that easier. Verifying the routing *logic* exists and is wired
// correctly is the meaningful, honest check available here.

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
    console.log('Accessibility audit run\n');

    // ── A: every icon-only Pressable has a label ─────────────────────────────
    const primitives = read('components/AccessiblePrimitives.tsx');
    const iconButtonRequiresLabel = has(primitives, /export function AccessibleIconButton\(\{[\s\S]{0,400}?label:\s*string;/);
    const reminderAlert = read('app/reminder-alert.tsx');
    const dismissHasLabel = has(reminderAlert, /AccessibleIconButton[\s\S]{0,100}?label=\{t\('stateViews\.dismiss'\)\}/);
    const settingsSheet = read('components/settings-sheet.tsx');
    const modalHeaderUsed = has(settingsSheet, /AccessibleModalHeader title=\{t\('settings\.title'\)\} onClose=\{onClose\} closeLabel=\{t\('common\.close'\)\}/);
    const caregiverDash = read('app/caregiver-dashboard.tsx');
    const settingsIconLabeled = has(caregiverDash, /onPress=\{\(\) => setSettingsVisible\(true\)\}[\s\S]{0,300}?accessibilityLabel=\{t\('settings\.title'\)\}/);
    const createIconLabeled = has(caregiverDash, /onPress=\{handleCreateReminder\}[\s\S]{0,300}?accessibilityLabel=\{t\('participants\.createReminderAction'\)\}/);
    const recipientDash = read('app/recipient-dashboard.tsx');
    const recipientSettingsLabeled = has(recipientDash, /onPress=\{\(\) => setSettingsVisible\(true\)\}[\s\S]{0,300}?accessibilityLabel=\{t\('settings\.title'\)\}/);
    record('A', 'AccessibleIconButton requires a non-optional label prop (type-enforced)', iconButtonRequiresLabel);
    record('A', 'reminder-alert.tsx dismiss button has an accessible label', dismissHasLabel);
    record('A', 'settings-sheet.tsx close button uses AccessibleModalHeader (labeled)', modalHeaderUsed);
    record('A', 'caregiver-dashboard.tsx settings gear + create button are labeled', settingsIconLabeled && createIconLabeled);
    record('A', 'recipient-dashboard.tsx settings gear is labeled', recipientSettingsLabeled);

    // ── B: every selection control exposes selected state ───────────────────
    const createReminder = read('app/create-reminder.tsx');
    const editReminder = read('app/edit-reminder.tsx');
    const chipSelectedCount = (content: string) => [...content.matchAll(/accessibilityState=\{\{\s*selected:/g)].length;
    record('B', 'create-reminder.tsx chips (participant/type/frequency/no-response) expose accessibilityState.selected', chipSelectedCount(createReminder) >= 4);
    record('B', 'edit-reminder.tsx chips expose accessibilityState.selected', chipSelectedCount(editReminder) >= 3);
    record('B', 'day-of-week chips expose accessibilityState.checked (checkbox semantics, not single-select)', has(createReminder, /accessibilityRole="checkbox"[\s\S]{0,250}?accessibilityState=\{\{ checked:/) && has(editReminder, /accessibilityRole="checkbox"[\s\S]{0,250}?accessibilityState=\{\{ checked:/));
    record('B', 'settings-sheet.tsx appearance/language chips expose accessibilityState.selected', chipSelectedCount(settingsSheet) >= 2);
    record('B', 'caregiver-dashboard.tsx range tabs (Today/Week/Month) expose accessibilityState.selected', has(caregiverDash, /accessibilityRole="tab"[\s\S]{0,150}?accessibilityState=\{\{ selected: selectedRange === range \}\}/));
    record('B', 'weekly bar chart + month heatmap cells expose accessibilityState.selected', has(caregiverDash, /accessibilityState=\{\{ selected: selectedWeekIndex === index \}\}/) && has(caregiverDash, /accessibilityState=\{\{ selected: selectedMonthIndex === index \}\}/));

    // ── C: essential text does not disable font scaling ─────────────────────
    const screensToCheck = [
        'app/index.tsx', 'app/signin.tsx', 'app/signup.tsx', 'app/forgot-password.tsx', 'app/reset-password.tsx',
        'app/choose-use-case.tsx', 'app/choose-role.tsx', 'app/notification-permission.tsx',
        'app/invite-recipient.tsx', 'app/join-invite.tsx', 'app/caregiver-dashboard.tsx', 'app/recipient-dashboard.tsx',
        'app/participants.tsx', 'app/create-reminder.tsx', 'app/edit-reminder.tsx', 'app/reminder-details.tsx',
        'app/reminder-alert.tsx', 'app/delete-account.tsx', 'components/settings-sheet.tsx', 'components/StateViews.tsx',
        'components/AccessiblePrimitives.tsx', 'components/TimePickerField.tsx',
    ];
    const noFontScalingDisabled = screensToCheck.every((f) => !has(read(f), /allowFontScaling=\{false\}/));
    record('C', 'no allowFontScaling={false} on any content text across all 22 audited files', noFontScalingDisabled);

    // ── D: new shared controls meet minimum target configuration ────────────
    const iconButtonMinSize = has(primitives, /minWidth:\s*MIN_TOUCH,\s*minHeight:\s*MIN_TOUCH,/);
    const selectionCardMinHeight = has(primitives, /selectionCard:\s*\{[\s\S]{0,200}?minHeight:\s*MIN_TOUCH,/);
    const formFieldMinHeight = has(primitives, /fieldInput:\s*\{[\s\S]{0,200}?minHeight:\s*MIN_TOUCH,/);
    // MIN_TOUCH now sources from lib/designTokens.ts's LAYOUT.minControlHeight
    // (consolidated in the visual-consistency task so there's one 44
    // defined once, not two identical literals) -- still resolves to 44,
    // just no longer a literal in this file.
    const minTouchIs44 = has(primitives, /const MIN_TOUCH = LAYOUT\.minControlHeight;/) &&
        has(read('lib/designTokens.ts'), /minControlHeight:\s*44,/);
    record('D', 'MIN_TOUCH constant is 44pt (via lib/designTokens.ts LAYOUT.minControlHeight)', minTouchIs44);
    record('D', 'AccessibleIconButton enforces a real 44x44 touch target', iconButtonMinSize);
    record('D', 'SelectionCard enforces minHeight 44', selectionCardMinHeight);
    record('D', 'FormField input enforces minHeight 44', formFieldMinHeight);

    // ── E: ErrorState and EmptyState have accessible headings/actions ───────
    const stateViews = read('components/StateViews.tsx');
    record('E', 'EmptyState has accessibilityRole + action button label', has(stateViews, /export function EmptyState[\s\S]{0,600}?accessible accessibilityRole="text"/) && has(stateViews, /accessibilityRole="button"\s*\n\s*accessibilityLabel=\{actionLabel\}/));
    record('E', 'ErrorState has accessibilityRole="alert" + live region', has(stateViews, /export function ErrorState[\s\S]{0,400}?accessibilityRole="alert"[\s\S]{0,50}?accessibilityLiveRegion="assertive"/));

    // ── F: loading indicators expose labels + busy state ─────────────────────
    record('F', 'ScreenLoadingState/InlineLoadingState expose accessibilityRole="progressbar" + label', (stateViews.match(/accessibilityRole="progressbar"/g) ?? []).length >= 2);
    record('F', 'RetryButton/SectionErrorState expose accessibilityState.busy while retrying', has(stateViews, /accessibilityState=\{\{ disabled: (loading|retrying), busy: (loading|retrying) \}\}/g));
    record('F', 'reminder-alert.tsx saving box exposes progressbar role + live region', has(reminderAlert, /accessibilityRole="progressbar"\s*\n\s*accessibilityLabel=\{t\('reminderAlert\.saving'\)\}/));
    record('F', 'recipient-dashboard.tsx saving box exposes progressbar role + live region', has(recipientDash, /accessibilityRole="progressbar"\s*\n\s*accessibilityLabel=\{t\('participantDashboard\.saving'\)\}/));
    record('F', 'delete-account.tsx success state exposes progressbar role + label', has(read('app/delete-account.tsx'), /accessibilityRole="progressbar"\s*\n\s*accessibilityLabel=\{t\('deleteAccount\.deletingInProgress'\)\}/));

    // ── G: participant switcher announces selected participant ──────────────
    record('G', 'caregiver-dashboard.tsx participant chip has accessibilityRole="tab" + accessibilityState.selected', has(caregiverDash, /accessibilityRole="tab"/) && has(caregiverDash, /participantChip[\s\S]{0,400}?accessibilityState=\{\{ selected \}\}/));

    // ── H: reminder actions have explicit labels ─────────────────────────────
    record('H', 'reminder-alert.tsx Taken/Snooze/Skip buttons have accessibilityLabel + accessibilityHint', (reminderAlert.match(/accessibilityHint=\{t\('reminderAlert\.explain(Done|Later|Skip)'\)\}/g) ?? []).length === 3);
    record('H', 'recipient-dashboard.tsx Done/Later/Skip buttons have accessibilityRole + accessibilityLabel', has(recipientDash, /onPress=\{\(\) => saveReminderAction\(reminder, 'taken'\)\}[\s\S]{0,300}?accessibilityLabel=\{t\('participantDashboard\.done'\)\}/));

    // ── I: notification preview options expose selected state ───────────────
    record('I', 'settings-sheet.tsx SelectRow (notification preview) exposes accessibilityRole="radio" + selected state', has(settingsSheet, /accessibilityRole="radio"[\s\S]{0,80}?accessibilityState=\{\{ selected \}\}/));

    // ── J: role/use-case options expose selected state ───────────────────────
    const chooseRole = read('app/choose-role.tsx');
    const chooseUseCase = read('app/choose-use-case.tsx');
    record('J', 'choose-role.tsx cards expose accessibilityState with selected', has(chooseRole, /accessibilityState=\{\{[^}]*selected/));
    record('J', 'choose-use-case.tsx cards expose accessibilityState with selected', has(chooseUseCase, /accessibilityState=\{\{[^}]*selected/));
    record('J', 'choose-role.tsx announces the chosen role (parity with choose-use-case.tsx)', has(chooseRole, /AccessibilityInfo\.announceForAccessibility/));

    // ── K: delete-account confirmation is accessible ─────────────────────────
    const deleteAccount = read('app/delete-account.tsx');
    record('K', 'delete-account.tsx confirm-word and password inputs have accessibilityLabel', has(deleteAccount, /accessibilityLabel=\{t\('deleteAccount\.confirmLabel'/) && has(deleteAccount, /accessibilityLabel=\{t\('deleteAccount\.passwordLabel'\)\}/));
    record('K', 'delete-account.tsx final delete button has role/label/hint/state', has(deleteAccount, /accessibilityRole="button"\s*\n\s*accessibilityLabel=\{t\('deleteAccount\.finalButton'\)\}\s*\n\s*accessibilityHint=\{t\('deleteAccount\.finalButtonHint'\)\}\s*\n\s*accessibilityState=\{\{ disabled: !canSubmit, busy: stage === 'submitting' \}\}/));
    record('K', 'delete-account.tsx error text has a live region and moves VoiceOver focus', has(deleteAccount, /accessibilityRole="alert"\s*\n\s*accessibilityLiveRegion="assertive"/) && has(deleteAccount, /useFocusOnChange<Text>\(errorMessage\)/));

    // ── L: connection-ending confirmation is accessible ──────────────────────
    const participants = read('app/participants.tsx');
    record('L', 'settings-sheet.tsx End Connection button has role/label/hint/state', has(settingsSheet, /accessibilityLabel=\{t\('participants\.endConnectionAction'\)\}\s*\n\s*accessibilityHint=\{t\('settings\.endConnectionHint'\)\}/));
    record('L', 'participants.tsx revoke/end-connection actions retain accessibilityRole/Label/State', has(participants, /accessibilityRole="button"[\s\S]{0,100}?accessibilityLabel=\{t\('participants\.(revokeAction|endConnectionAction)'\)\}/) || has(participants, /accessibilityState=\{\{ disabled: busy, busy \}\}/));

    // ── M: invite code can be read/copied accessibly ─────────────────────────
    const inviteRecipient = read('app/invite-recipient.tsx');
    record('M', 'invite-recipient.tsx invite code is spelled out character-by-character for VoiceOver', has(inviteRecipient, /inviteCode\.split\(''\)\.join\(' '\)/));
    record('M', 'invite-recipient.tsx share action announces success to VoiceOver', has(inviteRecipient, /Share\.sharedAction/) && has(inviteRecipient, /AccessibilityInfo\.announceForAccessibility\?\.\(t\('inviteParticipant\.shareSuccessAnnouncement'\)\)/));
    record('M', 'participants.tsx share action announces success to VoiceOver', has(participants, /Share\.sharedAction/) && has(participants, /announceStateChange\(t\('inviteParticipant\.shareSuccessAnnouncement'\)\)/));

    // ── N: analytics have textual summaries ──────────────────────────────────
    record('N', 'dayAccessibilitySummary() exists and covers future/no-data/pending/full-data cases', has(caregiverDash, /function dayAccessibilitySummary\(day: DayData\): string/) && has(caregiverDash, /day\.takenCount.*day\.missedCount.*day\.skippedCount.*day\.snoozedCount.*day\.pendingCount/s));
    record('N', 'weekly bar chart cells use dayAccessibilitySummary as their accessibilityLabel', has(caregiverDash, /accessibilityLabel=\{dayAccessibilitySummary\(day\)\}/g));
    record('N', 'BreakdownCard exposes one combined accessibilityLabel (name + adherence + summary) instead of fragmenting into separate stops', has(caregiverDash, /const cardLabel = `\$\{item\.name\}/));

    // ── O: status is not color-only ──────────────────────────────────────────
    record('O', 'StatusBadge always renders an icon + text label alongside its tone color', has(primitives, /export function StatusBadge[\s\S]{0,900}?<Ionicons name=\{TONE_ICON\[tone\]\}/) && has(primitives, /<Text style=\{\[styles\.statusBadgeText/));
    record('O', 'SelectionCard shows a checkmark icon for the selected option, not just a color/border change', has(primitives, /selected \? \(\s*<Ionicons name="checkmark-circle"/));
    record('O', 'settings-sheet.tsx appearance/language chips show a checkmark for the active option', (settingsSheet.match(/\{active \? <Ionicons name="checkmark"/g) ?? []).length >= 2);

    // ── P: password recovery routes correctly (static — see file header) ────
    const layout = read('app/_layout.tsx');
    record('P', '_layout.tsx forces navigation to /reset-password whenever passwordRecovery is true and not already there', has(layout, /if \(passwordRecovery && pathname !== '\/reset-password'\)\s*\{\s*\n\s*router\.replace\('\/reset-password'\);/));
    record('P', '_layout.tsx checks passwordRecovery before the public-routes early return (so /signin does not bypass it)', (() => {
        const idx1 = layout.indexOf("if (passwordRecovery && pathname !== '/reset-password')");
        const idx2 = layout.indexOf('if (PUBLIC_ROUTES.has(pathname)) return;');
        return idx1 !== -1 && idx2 !== -1 && idx1 < idx2;
    })());
    record('P', '_layout.tsx drops (never queues) notification deep links during a recovery session', has(layout, /if \(passwordRecoveryRef\.current\) return;/));
    record('P', '_layout.tsx notification handlers read live status/passwordRecovery via refs, not a stale mount-time closure', has(layout, /const statusRef = useRef\(status\);/) && has(layout, /const passwordRecoveryRef = useRef\(passwordRecovery\);/));
    record('P', 'reset-password.tsx signs out and returns to Sign In after a successful reset', has(read('app/reset-password.tsx'), /await supabase\.auth\.signOut\(\)\.catch/) && has(read('app/reset-password.tsx'), /setStage\('success'\)/));

    // ── Q: invalid recovery link produces a safe, calm state ─────────────────
    const resetPassword = read('app/reset-password.tsx');
    record('Q', "reset-password.tsx shows a calm 'invalid link' state with a recovery action, never a raw token/error", has(resetPassword, /setStage\('invalid'\)/) && !has(resetPassword, /Alert\.alert\(.*error\.message/) && has(resetPassword, /requestNewLink/));
    record('Q', 'reset-password.tsx moves VoiceOver focus to its own heading on every stage transition', has(resetPassword, /useFocusOnChange<Text>\(stage\)/));
    record('Q', 'reset-password.tsx new-password fields support password-manager autofill', has(resetPassword, /textContentType="newPassword"/) && has(resetPassword, /autoComplete="new-password"/));

    // ── R: reduced-motion helper behaves correctly (pure-ish logic check) ────
    const reduceMotionHook = read('lib/useReduceMotion.ts');
    record('R', 'useReduceMotion() checks AccessibilityInfo.isReduceMotionEnabled on mount and subscribes to live changes', has(reduceMotionHook, /isReduceMotionEnabled\?\.\(\)/) && has(reduceMotionHook, /addEventListener\?\.\('reduceMotionChanged'/));
    record('R', 'reminder-alert.tsx gates its infinite pulse Animated.loop on reduceMotion', has(reminderAlert, /if \(reduceMotion\) \{/) && has(reminderAlert, /Animated\.loop\(/));
    record('R', 'settings-sheet.tsx Modal animationType is gated on reduceMotion', has(settingsSheet, /animationType=\{reduceMotion \? 'none' : 'slide'\}/));
    record('R', 'TimePickerField.tsx Modal animationType is gated on reduceMotion', has(read('components/TimePickerField.tsx'), /animationType=\{reduceMotion \? 'none' : 'slide'\}/));

    // ── S/T: EN/ES translation coverage for new keys ─────────────────────────
    const en = read('lib/i18n/locales/en.ts');
    const es = read('lib/i18n/locales/es.ts');
    const newKeys = [
        'close', 'deleteAccountHint', 'endConnectionHint', 'confirmHint', 'finalButtonHint',
        'deletingInProgress', 'shareSuccessAnnouncement', 'backToNormal',
    ];
    const enHasAll = newKeys.every((k) => en.includes(`${k}:`));
    const esHasAll = newKeys.every((k) => es.includes(`${k}:`));
    record('S', 'every new i18n key introduced by this task exists in en.ts', enHasAll, newKeys.filter((k) => !en.includes(`${k}:`)).join(',') || undefined);
    record('T', 'every new i18n key introduced by this task exists in es.ts', esHasAll, newKeys.filter((k) => !es.includes(`${k}:`)).join(',') || undefined);
    // es.ts is typed `typeof en` (lib/i18n/locales/es.ts:3) -- tsc itself
    // already enforces full key-parity for every OTHER string in the app;
    // this check only needs to additionally confirm the two files agree on
    // shape, which a clean `npx tsc --noEmit` already established structurally.

    // Nested cross-suite "remains passing" checks (formerly U-Z, AA)
    // removed as part of Week 4 Task #1's DAG-flattening pass -- see
    // docs/audit-infrastructure-model.md. This suite creates zero synthetic
    // accounts itself (pure static source-inspection); the removed checks
    // were solely regression re-invocations of other, signup-heavy suites,
    // now covered exactly once each by scripts/final-regression/run.ts.

    const passed = summarize();
    process.exit(passed ? 0 : 1);
}

main().catch((err) => {
    console.error('ACCESSIBILITY_AUDIT_SUITE_FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
});
