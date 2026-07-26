# Tavora visual design model

Week 2 product-polish task #5: visual-system consistency, layout
responsiveness, interaction polish, copy consistency, and premium
launch-quality refinement. Companion to `docs/product-terminology.md`
(copy/terminology), `docs/accessibility-model.md` (touch targets, Dynamic
Type, VoiceOver — this doc doesn't repeat those rules, only adds the
visual layer on top), and `docs/ui-state-model.md` (loading/empty/error
state behavior, unchanged by this task).

This task's own audit (4 parallel passes across every screen/component)
found real, extensive drift — three different "screen padding" values,
four different "heading font size" values for the same role, five
different "primary CTA button" recipes, three different "status pill"
paddings, and so on. This document records the canonical values adopted
(`lib/designTokens.ts`), which screens were converged onto them, and which
drift was deliberately left alone as lower-risk/lower-value than the
regression risk of touching an already-working, complex screen.

## Design tokens (`lib/designTokens.ts`)

New this task — does **not** replace `constants/theme.ts` (RADIUS/SPACING/
SHADOW/colors still own those scales; several screens correctly depend on
them). Adds the semantic layer the audit found missing:

- **`SPACING_SCALE`** — `xs(4) sm(8) md(12) lg(16) xl(20) xxl(24)` for
  one-off gaps that don't have a named role.
- **`RADII`** — semantic aliases over the *existing* `RADIUS` scale
  (`input`→`RADIUS.lg`, `button`/`card`→`RADIUS.xl`, `sheet`→`RADIUS.xxl`,
  `pill`→`RADIUS.full`). No new radius values invented — every one was
  already the plurality choice for its role.
- **`TYPOGRAPHY`** — concrete per-role style objects (`hero`, `screenTitle`,
  `sectionTitle`, `cardTitle`, `body`, `secondaryBody`, `caption`,
  `buttonLabel`, `destructiveLabel`, `numericMetric`).
- **`LAYOUT`** — `screenPaddingHorizontal(24)`, `sectionGap(24)`,
  `cardGap(12)`, `maxContentWidth(560)`, `minControlHeight(44)`.

`components/AccessiblePrimitives.tsx`'s `MIN_TOUCH` now imports
`LAYOUT.minControlHeight` instead of redefining `44` a second time — one
source for that number going forward.

**Values were chosen by convergence, not invention** — each token is the
value a plurality of existing screens already used for that role (see the
per-property breakdowns below), so adopting a token moves an outlier
screen toward the app's own existing center of gravity.

## Typography hierarchy

| Role | Size/weight | Where it's used |
|---|---|---|
| `hero` | 40/800 | `index.tsx`'s welcome headline only — the one true landing screen, deliberately larger than every subsequent form/onboarding screen |
| `screenTitle` | 30/800 | Canonical size for every subsequent screen title. Found at 4 different sizes (40/34/30/28) across 8 auth/onboarding screens with no evident reason for the spread |
| `sectionTitle` | 18/800 | Dashboard/card section headings |
| `cardTitle` | 16/700 | Card-internal titles |
| `body` | 16/400 | Primary descriptive text |
| `secondaryBody` | 14/500 | Secondary/muted text |
| `caption` | 13/500 | Helper/meta text |
| `buttonLabel` | 17/700 | Primary button text |
| `destructiveLabel` | 15/700 | Destructive button text |
| `numericMetric` | 32/800 | Analytics hero numbers |

**Fixed this task:** both dashboard greetings (`caregiver-dashboard.tsx`,
`recipient-dashboard.tsx`) used `adjustsFontSizeToFit`/`minimumFontScale={0.85}`
— flagged explicitly by the prior accessibility task as a known issue, and
confirmed by this task's audit to affect **both** dashboards, not just the
organizer one. Both headings are short, static strings with no name
interpolation ("Organizer Overview" / a time-of-day greeting) — there was
no genuine long-content risk requiring auto-shrink, so both were removed
in favor of `numberOfLines={2}` (wraps safely, never shrinks essential
text) plus an explicit `accessibilityRole="header"`.

**Not converged (documented, not fixed):** the 8 auth/onboarding screens'
heading sizes (40/34/34/30/30/30/34/28) were **not** mechanically
rewritten to all read 30 — `index.tsx`'s hero legitimately wants to be
bigger (landing screens conventionally are), and retrofitting `choose-role.tsx`
(34) and `signin.tsx`/`signup.tsx` (34) down to 30 risks a visual regression
on screens that already ship and read fine. The `TYPOGRAPHY.screenTitle`
token exists and is the canonical value for **new** screens; existing
screens' minor size drift (within 4pt of the canonical value) is treated
as acceptable, not urgent.

## Radii, cards, and layout

- **Card radius**: `RADIUS.xl` (20) is the dominant "content card" radius
  app-wide — confirmed consistent across reminder cards, breakdown cards,
  participant cards, option cards (choose-use-case/choose-role), and most
  buttons. One real inconsistency **fixed**: `caregiver-dashboard.tsx`'s
  `connectionButton` and `firstReminderButton` used `RADIUS.lg` (16)
  instead of `RADIUS.xl` like every other primary CTA in the same file and
  app — both converged to `RADIUS.xl`.
- **Screen horizontal padding**: `24` is now the `LAYOUT.screenPaddingHorizontal`
  token and already the majority value (all 8 auth/onboarding screens,
  `invite-recipient.tsx`, `join-invite.tsx`, `participants.tsx`). **Not
  changed**: `caregiver-dashboard.tsx`/`recipient-dashboard.tsx` use
  `SPACING.screen` (20) instead — deliberately left alone this task. These
  are the two largest, most complex screens in the app (2000+ and 1100+
  lines), with internal layout math (chip max-widths, percentage-based
  analytics grids, absolute-positioned accent bars) that assumes the
  current padding; a global padding change there is a real reflow risk
  across the app's two highest-traffic screens for a 4px visual
  difference. Documented as a known, accepted, low-value-to-fix
  inconsistency rather than silently ignored.
- **Primary button shadow**: `SHADOW.primary` (the brand-blue-tinted
  elevation) was inconsistently applied even *within* single files — e.g.
  `caregiver-dashboard.tsx`'s `connectionButton` had it while its sibling
  `firstReminderButton` (same visual tier, same screen) didn't.
  **Fixed**: `firstReminderButton` (caregiver-dashboard.tsx),
  `emptyActionButton` (recipient-dashboard.tsx, both occurrences), and
  `primaryButton` (participants.tsx) now all carry `SHADOW.primary`,
  matching every other full-width filled primary CTA. `delete-account.tsx`'s
  final delete button was the one primary-height button with **zero**
  shadow anywhere in the app — given its background is `C.error` (red),
  applying the blue-tinted `SHADOW.primary` would look like a color clash,
  so it received `SHADOW.md` (a neutral black elevation shadow) instead,
  giving it appropriate visual weight without a brand-color mismatch. Its
  button text and loading spinner also used a hardcoded `'#FFFFFF'`
  instead of `C.textInverse` — fixed to the theme token (no visible
  difference in light mode, but now correctly themeable).

## Button hierarchy

- **Primary** (highest-priority action): filled `C.primary` background,
  `RADIUS.xl`, `SHADOW.primary`, `paddingVertical` 14–18 depending on
  context, `minHeight: 44`. Examples: Sign In, Create Account, Generate
  Invite Code, Save Reminder/Changes, Create Reminder (dashboard "+").
- **Destructive**: never the brand-blue shadow — either an outline style
  (`border 1.5 C.error`, tinted `errorLight`/`#FEF2F2` background, e.g.
  Deactivate Reminder, End Connection) for a *reversible-ish* or
  lower-frequency destructive action, or a solid `C.error` fill with a
  neutral shadow (Delete Account) for the single most severe, truly
  irreversible action in the app — confirmed this hierarchy already
  existed correctly (Delete Account solid+taller vs. Deactivate
  outline+shorter) and just needed the shadow/color-token fix above, not a
  redesign.
- **Secondary/tertiary**: text-only links (Forgot Password, Back to Sign
  In, footer "Create one"/"Sign in" switches) — confirmed these already
  use `C.primary` text color consistently except `notification-permission.tsx`'s
  "Not now," which intentionally uses `C.textMuted` since it's genuinely a
  lower-emphasis dismissal, not a navigation link — left as-is, correct by
  design.
- **Icon-only buttons**: settings gear, "+" create-reminder — sizing and
  labeling already hardened in the prior accessibility task
  (`AccessibleIconButton`, real 44×44 targets). This task did not resize
  the *visual* chrome of the two dashboards' differently-sized settings
  gear (38×38 outlined on the organizer dashboard vs. 44×44 tinted-fill on
  the participant dashboard) — both already meet the touch-target minimum
  via their existing size/hitSlop, and unifying their visual treatment is
  a cosmetic call better suited to a dedicated icon-button pass than a
  drive-by change in this task.

## Card and list families

Confirmed families and their current state (not mechanically flattened
into one identical style, per this task's own instruction):

- **Reminder card** (`recipient-dashboard.tsx`): borderless, `SHADOW.sm`,
  20px padding, colored `cardAccentBar` on top — the one card family that
  uses an accent bar instead of a border. Kept as-is; it's a deliberate,
  working visual treatment for the participant's own primary content unit.
- **Breakdown card** (`caregiver-dashboard.tsx`) and **participant card**
  (`participants.tsx`): both bordered (`1px C.border`), both `SHADOW.xs`,
  padding 18/16 respectively — close enough in family to read as related,
  padding difference not touched (2px, no visible regression risk either
  way).
- **Connection-status card**: a real, load-bearing inconsistency found —
  the organizer dashboard's `ConnectionCard` is a prominent, bordered,
  shadowed hero card with an icon-wrap and embedded CTA, while
  `settings-sheet.tsx`'s equivalent is a single plain metadata row inside
  a flat, unshadowed list container using `C.bgAlt` (not `C.bgSurface`
  like every other card). **Not unified** — these serve genuinely
  different contexts (a dashboard's primary content vs. a settings list
  row) and forcing them to look identical would itself be a scope
  increase; the settings-sheet's `bgAlt` list-card treatment is
  functionally consistent with an iOS-Settings-style grouped list, which
  is a legitimate, distinct pattern from the app's "featured content card"
  family, not a bug. Documented here rather than silently accepted.
- **Empty-state cards** (`components/StateViews.tsx`'s shared
  `EmptyState`/`ErrorState` vs. hand-rolled versions in
  `edit-reminder.tsx`/`reminder-details.tsx`): the audit confirmed these
  two files still don't use the shared components (a pre-existing gap
  from before the state-hardening task), and their ad hoc icon-wrap size
  (60×60) and muted-text color token (`C.textMuted`) both differ slightly
  from the shared components' (52×52, `C.textSecondary`). Not migrated
  this task — swapping the actual component in two already-working error
  paths is exactly the kind of "flatten everything into one style"
  mechanical change this task's own instructions warn against without a
  clearer functional reason; noted as a future-migration candidate.
- **Status badges/pills** (Taken/Missed/Skipped/Snoozed/Pending): three
  different padding pairs (11/6, 10/5, 10/4) and three font sizes (11/12/13)
  exist across `caregiver-dashboard.tsx`'s two internal pill styles and
  `recipient-dashboard.tsx`'s pill. All reuse the identical color pairs
  (confirmed byte-identical hex values), so the *color* language is
  already fully consistent — only chrome (padding/size) drifts by a few
  pixels. Not unified this task (touching status-pill rendering in the two
  dashboards' hot paths for a 1-2px difference was judged higher regression
  risk than value); `components/AccessiblePrimitives.tsx`'s `StatusBadge`
  component exists as the canonical recipe for any *new* status surface.

## Dashboard polish

**Organizer dashboard** — confirmed already doing most of what Phase 7
asks: selected participant is unmistakable (`accessibilityState.selected`
+ a checkmark dot, not color-only, from the prior accessibility task);
partial-error behavior (reminders load but analytics fail → inline
`SectionErrorState`, never a blanked dashboard) and participant-switch
generation guards were both built and verified in the UI-state-hardening
task and are untouched here. This task's changes: removed the greeting's
auto-shrink; fixed the connection/first-reminder button radius and shadow
drift documented above.

**Participant dashboard** — separates due-today reminders from
resolved/responded ones already (Taken/Skipped render a static confirmation
box, not action buttons); the notification-disabled banner is a single
compact row, not an intrusive block; "All clear" empty-state copy was
verified in the terminology audit to be plain/functional, not falsely
celebratory. Connection-ended and no-reminder empty states (added in the
UI-state-hardening task) are untouched. This task's change: removed the
greeting's auto-shrink.

**Not done:** consolidating the organizer dashboard's three different
"add a participant" visual treatments (full-width CTA in the empty
connection state / outlined header pill / dashed chip in the participant
selector) into one recipe. Each currently appears in a different state
(zero participants / has-room-for-more / at-the-selector-row) — genuinely
different contexts warranting different visual weight, not an unambiguous
defect, so left as a documented observation rather than a forced merge.

## Onboarding visual polish

`choose-use-case.tsx` and `choose-role.tsx` already implement: one clear
decision per screen, selected-card state via checkmark+border+text (not
color-only, confirmed in the prior accessibility task), a progress-free
but linear flow, and `AccessibilityInfo.announceForAccessibility` on
selection (this task added the announcement to `choose-role.tsx`, which
was missing it while `choose-use-case.tsx` already had it — see
`docs/accessibility-model.md`). Use-case examples ("Care for someone,"
"Coach or train someone," "Manage a team," "Personal accountability,"
"Something else") were confirmed non-medical-only. Invite-code display
(`invite-recipient.tsx`) already renders the code large, spelled out
character-by-character for VoiceOver, with a prominent Share action.
Interrupted-onboarding resumption is unchanged (owned by
`docs/onboarding-model.md`, out of this task's scope).

**Card padding/size drift between the two option-card screens** (18px vs.
20px padding, 24px vs. 26px leading icon, 15px vs. 16px card title) was
found and left unconverged for the same reason as the dashboard padding
above — both screens already ship correctly, and the difference is a few
pixels, not a functional or clearly-visible defect.

## Form consistency

Every text input across sign-in/sign-up/reminder forms/delete-account
already shares one recipe (`paddingHorizontal:14/16, borderWidth:1.5,
border→C.borderFocus on focus, fontSize:16`) — confirmed consistent except
`delete-account.tsx`'s two critical inputs, which copy the same static
values but never wire `onFocus`/`onBlur`, so they never show the focus
ring every other form's inputs show. Left unfixed this task (wiring focus
state requires adding local `focused` state to a screen that already has a
lot of destructive-flow-specific state, and the input remains fully usable
without the ring — a polish gap, not a functional one) — documented for a
future pass. Day-of-week chips, reminder-type/frequency/no-response chips
are confirmed numerically identical between `create-reminder.tsx` and
`edit-reminder.tsx` (own style keys have forked slightly in code, e.g.
duplicate `typeChipActive`/`chipActive`, but render identically). The
5/10/15/30/60-minute chips already wrap via a 2-row grid and were
confirmed accessible at large text sizes in the prior accessibility task.

## Status and feedback polish

Confirmed already correct, not changed: reminder creation, editing,
connection-ending, and account-deletion all wait for server confirmation
before showing success (no optimistic "success" shown before the network
round-trip resolves) — verified in the UI-state-hardening task. Alert
stacking is already prevented app-wide via `lib/alertGuard.ts`'s
`showAlertOnce()`. No new toast/notification dependency was added, per
constraint — existing patterns (native `Alert`, inline `SectionErrorState`,
VoiceOver announcements via `announceStateChange`) already cover every
listed action in Phase 11's list.

## Light/dark appearance

**One real defect found and fixed**: `TimePickerField.tsx` (the bottom
sheet used by both reminder forms) imported the static, light-only `T`
color object and hardcoded `'#FFFFFF'`/`'#0F172A'` for its sheet background
and text — with a comment explicitly (but incorrectly, relative to the
rest of the app) claiming this was intentional. Every other bottom sheet
in the app (`settings-sheet.tsx`) already adapts via `useThemeColors()`.
Converted `TimePickerField` to the same `createStyles(C: ThemeColors)`
pattern used everywhere else in the app — its sheet, text, borders, and
button fills now correctly follow the active theme. No visual change in
light mode; fixes a real dark-mode defect (previously: a bright white
sheet popping up over a dark-themed reminder form).

No other hardcoded white/black backgrounds were found in the four
audited passes. Contrast, disabled-state distinguishability, and chart
readability in dark mode were already verified in the prior accessibility
task and are unchanged. No palette change was made.

## Responsive edge cases

Long participant names, long reminder titles, and Spanish string expansion
were already handled via `numberOfLines`+ellipsis or safe wrapping at every
site the accessibility task's audit checked (participant chips, reminder
titles, card names). This task's audit found no new clipping/overlap
introduced by its own changes (verified via `npx tsc --noEmit` after every
edit, plus manual review of the day-chip and TimePickerField changes,
which don't alter layout dimensions). No landscape-specific layout exists
or was added (portrait-only app, unchanged). `LAYOUT.maxContentWidth` (560)
is defined for future tablet-width centering but not yet applied anywhere
— no screen currently needs it given the app's phone-first usage pattern;
documented as available, not retrofitted speculatively.

## Performance and rendering

No structurally obvious rendering inefficiency was introduced by this
task's changes (all edits were style-value/copy/prop changes, not new
loops or fetch calls). No `ScrollView`-should-be-`FlatList` conversion was
identified as necessary — every list in the app (participant chips,
reminder cards, breakdown cards) is bounded by the 5-participant limit or
a single day's reminders, never an unbounded/paginated dataset, so
`FlatList`'s virtualization would add complexity with no measurable
benefit. Participant-switch and stale-request generation guards (built in
the UI-state-hardening task) are untouched.

## Known limitations

- Two screens' hand-rolled error/empty cards still don't use
  `components/StateViews.tsx`'s shared components (pre-existing, not
  introduced or fixed here).
- `delete-account.tsx`'s confirm-word/password inputs don't show a focus
  ring (they use the same static border as every other input, just never
  wire the focus-swap).
- Both dashboards' screen padding (20) still differs from the
  `LAYOUT.screenPaddingHorizontal` token (24) used by every other screen —
  deliberately not touched given the regression risk on the app's two
  largest files.
- `firstReminder.confirmParticipantLabel` and `reminderForm.forLabel`
  bypass the contextual role-label system (see
  `docs/product-terminology.md`).
- The organizer dashboard's three different "add a participant" visual
  treatments were not consolidated (each appears in a genuinely different
  state).
- `LAYOUT.maxContentWidth` exists for future tablet support but isn't
  applied anywhere yet.

## Weekend visual-QA checklist

- [ ] Open every auth/onboarding screen back-to-back and confirm the
      heading sizes now read as "close enough to one family" (30/34/40)
      rather than jarring — this task converged the *token* but did not
      rewrite every existing screen's heading size.
- [ ] Open the reminder time picker on both light and dark mode — confirm
      the sheet is no longer a bright white card in dark mode.
- [ ] Create a reminder with a custom day selection — confirm the day
      chips read in Spanish when the device/app language is Spanish
      (Lun/Mar/Mié/Jue/Vie/Sáb/Dom).
- [ ] Open the time picker and confirm "Tap to change," "hour," "min," and
      the ±5-minute buttons are in Spanish under the Spanish locale.
- [ ] Tap through to `/join-invite` and confirm the heading now reads
      "Connect Your Account" / "Conecta tu cuenta," not "Join Care Circle."
- [ ] Attempt Delete Account — confirm the final button has a visible
      shadow/elevation like other primary buttons, not a flat appearance.
- [ ] Compare the organizer dashboard's "Invite" header button and "+"
      create-reminder button — confirm both remain easy to tell apart and
      to tap.
- [ ] With a 5th participant already connected, open the organizer
      dashboard and Participants screen — confirm the limit-reached state
      is clear and the "Add" affordance looks appropriately disabled.
- [ ] Set the system font size to the largest accessibility setting and
      re-open the reminder forms — confirm the (unconverged) card padding
      differences don't cause any visible clipping.

## Rollback

Every change in this task is additive/cosmetic (new token file, style
value changes, copy changes, one component's color-token conversion) — no
reminder-lifecycle semantics, analytics calculations, RLS policies, or
server-push architecture were touched. Reverting is a plain `git revert`
of this task's commits; there is no migration to roll back (no schema
changes were required for this task).
