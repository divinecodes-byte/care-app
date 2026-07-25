# Tavora accessibility model

Week 2 product-polish task #4: full accessibility, keyboard, focus-management,
motion, touch-target, and interaction-quality hardening. Companion to
`docs/ui-state-model.md` (loading/empty/error semantics),
`docs/participant-management-model.md`, and `docs/onboarding-model.md` — this
document covers everything about how Tavora behaves with VoiceOver, Dynamic
Type, keyboard navigation, Reduce Motion, and limited-dexterity input.

## Accessibility baseline

Every interactive control in the app is expected to meet:

- **Touch target ≈44×44pt.** Enforced structurally in new shared components
  (`AccessibleIconButton`, `SelectionCard`, `FormField` in
  `components/AccessiblePrimitives.tsx`, all built on a `MIN_TOUCH = 44`
  constant) and via generous `hitSlop` (10–12pt/side) on existing compact
  controls (dashboard header icon buttons, back buttons) where growing the
  visual chrome itself would be a redesign this task explicitly avoids.
- **Dynamic Type support everywhere.** No `allowFontScaling={false}` exists
  anywhere in the app (confirmed by `scripts/accessibility-audit/run.ts`
  scenario C, which greps all 22 audited screens/components) — the one
  pre-existing `adjustsFontSizeToFit` use (the organizer dashboard's greeting,
  `caregiver-dashboard.tsx`) was left as-is (out of this task's scope to
  redesign) but noted as a known tension in Known Limitations below.
- **No color-only status.** Every status surface pairs color with either an
  icon or a text label — `StatusBadge` (new) formalizes this pattern; the two
  places that were previously purely visual (the weekly bar chart and month
  heatmap in `caregiver-dashboard.tsx`) now carry a full textual
  `accessibilityLabel` per cell (see Analytics accessibility below).
- **Icon-only controls have explicit labels.** `AccessibleIconButton` makes
  the `label` prop non-optional at the type level — a call site literally
  cannot compile without one. Every pre-existing icon-only button found
  unlabeled by the Phase 1 audit (dashboard settings gear ×2, dashboard "+"
  create button, `reminder-alert.tsx`'s dismiss chevron, the settings sheet's
  close button) now has one.
- **Selected/disabled/busy/expanded state is exposed structurally**, not just
  visually — see VoiceOver semantics below for the exact coverage.

## Shared accessible components (`components/AccessiblePrimitives.tsx`)

New this task, deliberately small (no heavy component-system rewrite — most
existing screens keep their own chip/card markup with accessibility props
added directly, per the "don't replace every component unnecessarily"
constraint):

| Component | Purpose |
|---|---|
| `AccessiblePressable` | Generic labeled-button wrapper with a default hitSlop and full role/state props, for one-off buttons that don't already have their own established style. |
| `AccessibleIconButton` | Icon-only button — `label` is a required prop. Enforces a real 44×44 box around the icon (not just hitSlop), since these are typically small glyphs. |
| `FormField` | TextInput + visible label, with the label also bound to `accessibilityLabel` (React Native has no equivalent of HTML's `<label for>` — an adjacent sighted-only `<Text>` is otherwise invisible to VoiceOver). Optional error text gets `accessibilityRole="alert"` + a live region. |
| `SelectionCard` | The single-select chip/card pattern (`accessibilityRole="radio"`, `accessibilityState.selected`, plus a checkmark icon so selection is never color-only). |
| `StatusBadge` | Status pill combining an icon, a text label, and one combined `accessibilityLabel` (e.g. "82 percent, good adherence") instead of leaving VoiceOver to read a number and a color separately. |
| `AccessibleSectionHeader` | Plain `<Text accessibilityRole="header">` wrapper — RN's rotor/headings navigation has nothing to latch onto without this. |
| `AccessibleModalHeader` | Standard modal/sheet header: a real heading + a labeled close button. Used by `settings-sheet.tsx`. |

Existing screens that already had their own working chip/card/status markup
(reminder forms, dashboards, settings) were **not** migrated onto these new
components wholesale — the missing `accessibilityRole`/`accessibilityState`
props were added directly to the existing `TouchableOpacity` elements
instead, since swapping the underlying component would have risked visual
regressions for no accessibility benefit. The new components exist for
future/new call sites and the handful of places (icon buttons, delete-account
inputs, the settings-sheet header) where using them was a clean drop-in.

## Dynamic Type and large text

- No fixed `height` on any text-containing control was introduced or left
  in the files this task touched; all use `minHeight` (or no explicit
  height at all), so text can grow.
- Reminder titles/notes/participant names generally have no `numberOfLines`
  cap (verified unbounded across `recipient-dashboard.tsx`,
  `reminder-details.tsx`) — the one place a 2-line cap already existed
  (`create-reminder.tsx`'s confirmation-screen title preview) was left as-is
  (pre-existing, low-severity, not part of this task's new work).
- Chips/day-selectors keep their compact visual sizing but now have a real
  ≥44pt tap target via `minHeight`/hitSlop, so they remain tappable even
  though the *visible* chip stays small at very large font scales.
- Charts (the weekly bar chart and month heatmap) intentionally keep fixed
  visual dimensions — per this task's own Phase 4 allowance ("graphs may
  retain fixed visual dimensions") — because every value they represent now
  has a full textual equivalent via `accessibilityLabel` (see below), so no
  information is lost at any font size, even though the chart's own pixel
  layout doesn't reflow.

## VoiceOver semantics

- **Dashboard sections have real headings.** `accessibilityRole="header"`
  added to nav titles and section headings across `reminder-details.tsx`,
  `delete-account.tsx`, `forgot-password.tsx`, `reset-password.tsx`,
  `TimePickerField.tsx`'s modal title, and `AccessibleModalHeader`.
- **The participant switcher already announced selection correctly**
  (`accessibilityRole="tab"` + `accessibilityState.selected` was present
  before this task) — confirmed, not changed. The organizer dashboard's
  **range tabs** (Today/Week/Month) did not have this and now do
  (`accessibilityRole="tab"` + `accessibilityState.selected`).
- **Analytics charts have textual summaries** — see the dedicated section
  below.
- **Status badges announce label and meaning together.** `StatusBadge`
  produces one combined `accessibilityLabel`; the organizer dashboard's
  `BreakdownCard` (a dense, multi-element card — name, adherence %, chips,
  summary sentence, "Details" link) now exposes one combined
  `accessibilityLabel` covering all of that instead of fragmenting into
  6+ separate VoiceOver stops.
- **Taken/Snooze/Skip have clear labels.** The recipient dashboard's inline
  action buttons and the full-screen `reminder-alert.tsx` actions all have
  explicit `accessibilityLabel`; the full-screen version already had
  `accessibilityHint` (kept), the dashboard's inline versions gained
  `accessibilityRole`/`accessibilityLabel` (they only had visible text
  before).
- **Invite codes are spelled out character-by-character**
  (`inviteCode.split('').join(' ')` — was already correct in
  `invite-recipient.tsx`, confirmed via the audit rather than newly added).
- **Copy/Share actions confirm success accessibly.** Neither screen had a
  copy-to-clipboard action (only Share); `Share.share()`'s result is now
  checked and a VoiceOver announcement fires on `Share.sharedAction` in both
  `invite-recipient.tsx` and `participants.tsx` — previously silent for
  VoiceOver users regardless of outcome.
- **Notification-preview and role/use-case cards already exposed selected
  state correctly** (`settings-sheet.tsx`'s `SelectRow`, `choose-role.tsx`,
  `choose-use-case.tsx`) — confirmed, not changed. `choose-role.tsx` was
  missing the announcement `choose-use-case.tsx` already had on selection;
  added for parity.
- **Destructive actions announce consequences.** `accessibilityHint` added
  to: settings sheet's End Connection and Delete Account rows,
  `edit-reminder.tsx`'s Deactivate button, `delete-account.tsx`'s final
  delete button (all previously missing a hint despite being destructive).
- **Loading/error states announce once, not repeatedly during polling.**
  The two live polls in the app (`invite-recipient.tsx`'s acceptance check,
  `caregiver-dashboard.tsx`'s pending-invite count) only trigger a state
  update — and therefore only a potential announcement — when something
  actually changed; polling itself never re-announces unchanged state.

## Keyboard and form behavior

- **Fixed a real functional bug, not just an accessibility one:** `signin.tsx`
  and `signup.tsx`'s password fields were missing `autoCapitalize="none"`.
  Without it, RN defaults to `"sentences"` — which actually alters the typed
  password's first character casing, not just its display. Both now set
  `autoCapitalize="none"` and `autoCorrect={false}` explicitly, matching what
  `reset-password.tsx` already did correctly.
- **Password-manager/autofill support added** (`textContentType` +
  `autoComplete`) to every password/email field across sign-in, sign-up,
  forgot-password, reset-password, and delete-account — none of these had it
  before, so iOS's "Suggest Strong Password" / autofill affordances were
  silently unavailable.
- **Focus chaining wired**: sign-in's email field now moves focus to the
  password field on submit (previously `returnKeyType="next"` was set but
  nothing handled it); sign-up chains name → email → password → submit;
  reset-password chains new-password → confirm-password → submit.
- **`accessibilityLabel` added to every TextInput found missing one**
  (RN never auto-associates an adjacent sighted-only `<Text>` label with an
  input) — notes fields in both reminder forms, delete-account's two
  critical inputs, forgot-password's email field.
- **Keyboard obstruction**: `delete-account.tsx`'s `KeyboardAvoidingView`
  had `behavior={undefined}` on Android (no keyboard-avoiding behavior at
  all, meaning the keyboard could cover the Delete button) — changed to
  `'height'`, matching every other form screen's Android behavior.
- No custom keyboards were built, per the hard constraint.

## Focus management

`lib/useAccessibilityFocus.ts`'s `useFocusOnChange(trigger)` hook was added
specifically to formalize this: it moves VoiceOver focus to the element its
ref is attached to whenever `trigger` changes to a new truthy value, and
never fires on an unrelated re-render (so background polling can't
unexpectedly steal focus). Wired into:

- `create-reminder.tsx` — confirmation heading, on successful save.
- `delete-account.tsx` — the error message, on a failed deletion attempt.
- `reset-password.tsx` — its own heading, on every stage transition
  (resolving → form/invalid/success).
- `forgot-password.tsx` — the "check your email" confirmation heading.
- `join-invite.tsx` — the "Connected!" heading, on successful acceptance.

**Deliberately not wired everywhere Phase 7 lists** — participant switching,
opening/closing the settings sheet, and reminder-response success on the
inline dashboard cards were judged lower-value for an explicit programmatic
focus move (the participant switcher's own chip already carries the
selection state VoiceOver needs via `accessibilityState.selected`, and
forcing focus away from a card the user just tapped Done/Skip on would be
more disorienting than helpful mid-list). This is a deliberate scope
decision, not an oversight — see Known Limitations.

## Password-recovery session flow (closes the prior task's open risk)

This was the one specific residual risk carried over from the previous
hardening task: `lib/authSession.tsx`'s `passwordRecovery` flag existed but
was never consumed by any navigation logic.

**Fixed in `app/_layout.tsx`:**

- The global protected-route effect now checks `passwordRecovery` **before**
  its public-routes early return, and force-navigates to `/reset-password`
  whenever a recovery session exists and the user isn't already there —
  regardless of what `status` otherwise reads (a recovery session is
  perfectly "authenticated" from `loadProfile()`'s point of view, which is
  exactly why this needed its own explicit check). This closes the gap where
  a recovery session landing while some *other* screen was already open
  (not via a fresh cold-launch deep link) previously left a dashboard fully
  browsable.
- A real, independent bug was found and fixed while wiring this in:
  `processNotification`/`routeNotification` are registered once via an
  empty-deps `useEffect` (so the native listener subscription survives
  without being torn down every render), which means they closed over
  `status`/`passwordRecovery` from the component's *very first* render
  forever — a live (non-cold-launch) notification tap would always see a
  frozen `status === 'initializing'`. Fixed with `statusRef`/
  `passwordRecoveryRef`, kept in sync via their own effects, read inside the
  notification handlers instead of the stale closed-over values. Without
  this fix, the new `passwordRecovery` notification-drop check below would
  have been silently inert.
- Notification deep links are now **dropped** (not deferred) during a
  recovery session — a recovery session is scoped to exactly one action, and
  since a completed reset immediately signs out, there's no later moment
  where replaying a dropped notification would make sense either.
- `reset-password.tsx` already correctly: signs out and returns to Sign In
  after a successful reset; shows a calm "invalid link" state (never a raw
  Supabase token/error string) for an expired/invalid/malformed link; guards
  against handling the same URL twice (`resolvedRef`). These were confirmed,
  not changed.
- VoiceOver focus now lands on `reset-password.tsx`'s own heading on every
  stage transition (see Focus management above).
- No repeated-recovery-event navigation loop is possible: the redirect only
  fires when `pathname !== '/reset-password'`, so once there, it's a no-op
  on every subsequent render regardless of how many more `PASSWORD_RECOVERY`
  events arrive.
- No Supabase email-confirmation settings were changed, per the hard
  constraint.

## Color, contrast, and non-color status

No hard contrast defects were found in the existing light/dark palettes
(`constants/theme.ts`'s `T`/`T_DARK`) — this task did not need a targeted
color adjustment. Non-color-status work:

- `StatusBadge` (new) formalizes icon+text+color for any future status
  surface.
- The two genuinely color-only surfaces found (`caregiver-dashboard.tsx`'s
  weekly bar chart and month heatmap) now carry full textual
  `accessibilityLabel`s per cell — see Analytics accessibility.
- Every existing status pill audited (reminder status badges, adherence
  percentage, breakdown chips) already paired color with a text label —
  confirmed, not changed.
- Selected state across every chip/card (reminder forms, appearance/language
  pickers, use-case/role cards) now shows a checkmark icon in addition to
  the existing border/background color change — never color-only.

## Reduce Motion

`lib/useReduceMotion.ts` — a small hook wrapping
`AccessibilityInfo.isReduceMotionEnabled()`, live-updated via the
`reduceMotionChanged` event listener (a user can toggle the OS setting while
Tavora is already running). Applied to the only animation surfaces found in
the entire audited codebase:

- `reminder-alert.tsx`'s infinite pulsing glow ring (`Animated.loop`, the
  single actual "rapid pulsing" pattern Reduce Motion exists to suppress) —
  now frozen at a static mid-cycle scale/opacity when Reduce Motion is on,
  preserving the same visual composition without the movement.
- `settings-sheet.tsx`'s and `TimePickerField.tsx`'s `Modal`
  `animationType` — `'slide'` normally, `'none'` under Reduce Motion.

No other `Animated.*` usage exists anywhere in the app (confirmed by all
three Phase 1 audit agents independently) — there was nothing else to gate.
No new decorative animation was added, per the hard constraint.

## Haptics

Audited, not changed: `expo-haptics` is already used across 17 screens,
consistently on primary submit/destructive actions only (never on ordinary
taps, never during polling) — this already matches Phase 11's guidance
exactly. No new haptic dependency was needed or added.

## Analytics accessibility

The organizer dashboard's weekly bar chart and month heatmap
(`caregiver-dashboard.tsx`) were the one place in the whole app where a
visual encoded real data with **no textual equivalent at all** — bar
height/color and heatmap cell color were the only representation of a day's
adherence.

Added `dayAccessibilitySummary(day: DayData): string`, producing one full
sentence per cell (e.g. "Monday, July 21, 82% adherence, 3 taken, 1 missed,
0 skipped, 0 snoozed, 1 pending") covering every state a day can be in
(future/no-data/pending-only/full data) — wired as the `accessibilityLabel`
on every bar and every heatmap cell. The aggregate `MetricTile` counts
(Taken/Pending/Missed/Skipped) and the `BreakdownCard`'s per-reminder summary
already existed as plain text — confirmed, not changed. No analytics
calculation or semantic was touched, per the hard constraint — this is
presentation-layer only.

## Modals, sheets, and alerts

- **Settings sheet**: now uses `AccessibleModalHeader` (real heading +
  labeled close button, replacing an icon-only, unlabeled 28×28 close
  button). The decorative handle (there is no drag-to-dismiss gesture
  anywhere in this component — confirmed by the audit; dismissal is the
  backdrop tap, the close button, or the Android back button via
  `onRequestClose`) is now explicitly marked
  `importantForAccessibility="no-hide-descendants"` so it can't appear as an
  inert, unlabeled focusable stop. The backdrop tap-to-dismiss `Pressable`
  gained a role/label. `Modal` `animationType` is Reduce-Motion-aware.
  Existing drag/scroll/close behavior is otherwise untouched, per the hard
  constraint.
- **Confirmation dialogs** (End Connection, Delete Account navigation, Sign
  Out) are native `Alert`s or navigations gated behind an explicit
  destructive-styled button — all now carry `accessibilityHint`s explaining
  the consequence before the user commits.
- **`TimePickerField.tsx`**'s bottom sheet (used by both reminder forms) —
  every control (Cancel/Done, hour/minute increment/decrement, AM/PM,
  ±5-minute quick buttons) gained `accessibilityRole`/`accessibilityLabel`;
  it had none before. Its handle is likewise marked decorative. Its `Modal`
  animation is Reduce-Motion-aware.
- Sign Out and Delete Account remain reachable at large text sizes — neither
  row has a fixed height that could clip.

## Known limitations

- **`caregiver-dashboard.tsx`'s greeting text still uses
  `adjustsFontSizeToFit`/`minimumFontScale={0.85}`** — this actively shrinks
  text to fit a 2-line box rather than fully honoring the user's chosen
  Dynamic Type scale. Pre-existing, not introduced by this task; left as-is
  since fixing it properly means redesigning that header's layout, which is
  out of scope ("no broad visual redesign").
- **Day-of-week abbreviations ("Mon", "Tue", …) and `TimePickerField`'s
  "hour"/"min"/"Tap to change" labels are hardcoded English**, never
  localized even in the Spanish build. This is a pre-existing i18n gap, not
  something this accessibility task's scope covers (it's a translation-
  coverage gap, not an accessibility-semantics one) — flagged here rather
  than silently left undocumented.
- **Focus management is not wired at every single transition Phase 7 lists**
  — see the Focus management section above for the specific, deliberate
  scope decision (participant switching, settings-sheet open/close, and
  inline dashboard-card reminder-response success do not get a forced
  `setAccessibilityFocus` call).
- **`AccessibleModalHeader` does not itself move focus to the modal title on
  open** — RN's `Modal` gives VoiceOver some default behavior here on both
  platforms already; an explicit `setAccessibilityFocus` call was judged
  lower-value than the fixes above given the scope already covered, and is
  a reasonable next increment rather than a regression.
- **No physical-device testing was performed** (not required by this task) —
  every fix here is verified by static source inspection
  (`scripts/accessibility-audit/run.ts`) and `npx tsc --noEmit`, not by
  running VoiceOver/Dynamic Type on a real device. The weekend QA checklist
  below is what closes that gap.

## Weekend physical-QA checklist

- [ ] Turn on VoiceOver, swipe through the organizer dashboard — confirm the
      settings gear, invite button, and "+" create button each announce a
      real name (not "button" with no label).
- [ ] With VoiceOver on, switch participants on the organizer dashboard —
      confirm the newly-selected chip announces "selected."
- [ ] Turn on VoiceOver, open the weekly bar chart and month heatmap —
      confirm each day announces a full sentence (date, adherence, counts),
      not just a bare number/letter.
- [ ] With VoiceOver on, attempt Delete Account — confirm the confirm-word
      field, password field, and final button are all clearly labeled, and
      that a wrong-password error is actually announced.
- [ ] Enable Reduce Motion in Settings, open a reminder alert notification —
      confirm the glow ring is static, not pulsing. Open the settings sheet
      and the time picker — confirm they appear without a slide animation.
- [ ] Set the system font size to the largest accessibility setting
      (Settings → Accessibility → Display & Text Size → Larger Text) and
      open every form screen (sign-up, create reminder, delete account) —
      confirm no button/input clips or becomes untappable.
- [ ] Trigger a password-reset email, tap the link while NOT signed in —
      confirm it goes straight to the new-password form. Then, while
      signed in and on the dashboard, trigger a recovery link for the same
      account and confirm the app is forced to `/reset-password` rather than
      staying on the dashboard.
- [ ] Use an external keyboard (or Bluetooth keyboard on iOS) on sign-in —
      confirm Tab/Return moves from email to password to submit in order.
- [ ] Test password autofill (iOS: tap the password field, look for the
      "passwords" suggestion bar) on sign-in, sign-up, and reset-password.

## Rollback

Every change in this task is additive/defensive (new hooks, new components,
new accessibility props, one real bug fix in `_layout.tsx`'s notification
closures) — no reminder-lifecycle semantics, analytics calculations, RLS
policies, or Supabase auth/email settings were changed. Reverting is a plain
`git revert` of this task's commits; there is no migration to roll back (no
schema changes were required for this task).
