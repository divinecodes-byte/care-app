# Tavora product terminology model

Week 2 product-polish task #5: visual-system consistency, layout
responsiveness, interaction polish, copy consistency, and premium
launch-quality refinement. This document is the canonical terminology
reference — the vocabulary every screen's copy should draw from, and the
record of what was found inconsistent and fixed (or deliberately left as an
accepted, contextual variation) during this task's full copy audit of
`lib/i18n/locales/en.ts` and `es.ts`.

## Generic product vocabulary (always available, use-case-agnostic)

| Concept | Term |
|---|---|
| The person who invites/manages | **Organizer** |
| The person being cared for/coordinated | **Participant** |
| A reminder occurrence | **Reminder** |
| The link between an organizer and a participant | **Connection** |
| A reminder marked done | **Completed** (status noun) / **Done** (button verb — see "Action verb vs. status noun," below) |
| A reminder deferred | **Snoozed** |
| A reminder explicitly declined | **Skipped** |
| A reminder whose window passed with no response | **Missed** |
| A reminder awaiting a response | **Pending** |
| The participant-facing screen listing every connected organizer separately | **Your Organizers** (`app/my-connections.tsx`, `myConnections.title`) |

These five status words (`status.taken/pending/missed/skipped/snoozed` in
both locale files) are the single source of truth for status vocabulary —
`organizerDashboard.chipCompleted/chipMissed/chipSkipped/chipSnoozed/chipPending`
and `settings.notifyMissed/notifySkipped/notifySnoozed/notifyCompleted` all
reuse them verbatim. Confirmed consistent everywhere except the "taken"
concept — see below.

## Task terminology (Week 3 product-expansion task #1)

**Task** is the generic UI word for the second accountability object
(flexible, non-time-based assignments) — see `docs/flexible-task-model.md`
for the full architecture. Internal table/column names still use the
existing `caregiver_id`/`recipient_id` convention; "Task," "Organizer," and
"Participant" never leak into a table, column, or route name, matching the
same rule already established for Reminder/Organizer/Participant above.

Task status words are **deliberately distinct** from reminder status words
— they are never interchangeable, never share a translation key, and a
screen must never mix them:

| Concept | Term |
|---|---|
| A task not yet started | **Upcoming** |
| A task available to complete, before its deadline | **Open** |
| A task whose deadline passed, still completable | **Overdue** (never "Missed" — a task is never permanently lost) |
| A task completed by its deadline | **Completed** |
| A task completed after its deadline | **Completed late** |
| A task explicitly declined | **Skipped** |

Why separate from reminder status: "Missed" implies a permanently-lost,
terminal event (matches the reminder pipeline's cron-driven `missed` write).
A task's "Overdue" state is the opposite — always still actionable, never
terminal. Reusing "Missed" for a task would misrepresent that a late
response is still fully valid. Similarly, there is no "Pending" or
"Snoozed" task status — those reminder-specific words describe exact-time
concepts (a response window, a deferred alarm) that don't exist for a task.

`itemTypePicker.*` carries the exact required explanatory copy: "Alerts the
participant at a specific time" (Timed Reminder) and "Can be completed
anytime within its assigned date or deadline" (Flexible Task) — chosen so
neither option reads as the "default"/"other" choice.

## Reminder category (Build Batch 2, product-reset task #2)

The reminder-type picker's section label changed from **"Type"** to
**"Category"** (`reminderForm.typeLabel`) — clearer once a genuinely
neutral option exists alongside the relationship-specific ones. A new
**`general`** category was added (`reminderForm.typeGeneral`, DB value
`'general'`) and is now the first option and the default for a newly
created reminder (`app/create-reminder.tsx`, `app/edit-reminder.tsx`'s
initial/unset state) — the neutral, always-appropriate choice for any
relationship type. `reminders.reminder_type`'s own column `DEFAULT` changed
from `'medication'` to `'general'` in the same migration
(`20260826000000_relationship_context_education_and_general_reminder_type.sql`)
— Build Batch 1 had only fixed the client's initial `useState`, not the
database's own independent default. **Medication, Hydration, Appointment,
Meal, and Exercise remain unchanged, fully valid, selectable
categories** — they were never removed, only no longer the default.
`other` remains the existing catch-all. No existing reminder row was
migrated or touched; this only changes what a *new* row defaults to when
`reminder_type` is omitted.

## Routine terminology (Week 3 product-expansion task #3)

**Routine** is the generic UI word for a reusable accountability blueprint
and its applied result — see `docs/routine-template-model.md` and
`docs/routine-application-model.md` for the full architecture. Same rule as
Task/Organizer/Participant: "Routine," "Template," and "Pack" never appear
in a table, column, or route name beyond the `routine_*` table-name prefix
itself (which, like `tasks`/`reminders`, names the feature directly rather
than obscuring it — the obscured terms are specifically the *role* words
Organizer/Participant, which still resolve to `caregiver_id`/`recipient_id`
inside every routine table exactly as elsewhere).

| Concept | Term |
|---|---|
| A reusable, non-actionable blueprint (personal or built-in) | **Template** |
| A curated, built-in template supplied by Tavora | **Tavora Pack** (never "template" alone when referring to a built-in one, to keep it visually/verbally distinct from a personal template) |
| The result of applying a template/pack to one participant | **Routine** |
| The screen for browsing packs/templates | **Routine Library** |
| The screen for customizing before creating | **Preview Routine** |
| The screen for a single applied routine | **Routine** (heading), never "Routine Instance" — that phrase is internal/architectural only |

**No combined success/adherence percentage is ever shown for a routine** —
reminder adherence and task completion rates remain fully separate,
existing, unmixed metrics (see `docs/routine-application-model.md`'s "no
second lifecycle authority" principle). A routine's own summary only ever
states plain counts ("2 reminders, 3 tasks"), never a blended score.

Routine member items are always visually distinguished as **Reminder** or
**Task** using each object's own existing terminology and status words from
the sections above — a routine never invents a third, unified status
vocabulary for its members.

## Contextual relationship labels

Defined in `lib/onboardingCore.ts`'s `ROLE_LABEL_KEYS_BY_USE_CASE`, resolved
via `getRoleLabelKeys(useCase)` — display-only, never affects authorization
(the underlying `role` column is always `caregiver`/`recipient`; see
`docs/onboarding-model.md`):

| `use_case` | Organizer-side | Participant-side |
|---|---|---|
| `care` | Caregiver | Family Member |
| `coaching` | Coach | Athlete |
| `team` | Manager | Team Member |
| `education` | Organizer | Participant (no bespoke pair — see below) |
| `family` / `personal` / `other` / unset | Organizer | Participant |

**`education` (Build Batch 2)**: added to `profiles_use_case_check`,
`routine_templates_use_case_check`, and the `create_routine_template`/
`update_routine_template` RPC validation via
`supabase/migrations/20260826000000_relationship_context_education_and_general_reminder_type.sql`.
Build Batch 1 had drafted this client-side and then reverted it before
commit after proving live (SQLSTATE 23514) that the database rejected it —
see the git history for that verification. `education` has no bespoke
`ROLE_LABEL_KEYS_BY_USE_CASE` role-card pair (falls through to the neutral
Organizer/Participant labels, same as `family`/`personal`/`other`) — a
Tutor/Student or Mentor/Mentee pairing now exists one level down, in the
per-connection `relationship_pair` model below, not here.

### Per-connection relationship (`connections.relationship_pair`, Build Batch 2)

**Authoritative distinction**: `profiles.use_case` above is a coarse,
pre-connection signal (asked once at signup, before any participant
exists). `connections.relationship_pair` is the finer-grained, per-
connection label — the same organizer can be a Parent to one participant
and a Trainer to another, which `use_case` cannot represent. Nullable,
additive (`supabase/migrations/20260826000000_...sql`), display-only —
never read by RLS or any authorization RPC, exactly like `use_case`. `NULL`
means "relationship unspecified" and is a fully valid, permanent state,
never backfilled from `use_case`.

Defined centrally in `lib/relationshipCore.ts` (`getRelationshipDefinition`/
`getOrganizerLabelKey`/`getParticipantLabelKey`, i18n namespace
`relationshipPair.*`) — the **only** approved source for a per-connection
relationship label, mirroring `getRoleLabelKeys`'s role in the section
above. Never duplicate this map in a screen.

| `relationship_pair` | `use_case` category | Organizer-side | Participant-side |
|---|---|---|---|
| `parent_child` | family | Parent | Child |
| `trainer_client` | coaching | Trainer | Client |
| `coach_athlete` | coaching | Coach | Athlete |
| `caregiver_family_member` | care | Caregiver | Family Member |
| `tutor_student` | education | Tutor | Student |
| `mentor_mentee` | education | Mentor | Mentee |
| `manager_team_member` | team | Manager | Team Member |
| `provider_patient` | care | Provider | Patient |
| `accountability_partner` | personal | Accountability Partner | Partner |
| `family_member_family_member` | family | Family Member | Family Member |
| `other` | other | Organizer | Participant |
| `null` (unspecified) | — | Organizer | Participant |

Captured optionally at invite-creation time (`app/invite-recipient.tsx`,
`create_invite_code`'s `p_relationship_pair`, validated server-side against
this exact list). The participant sees it **before** accepting via the new
`preview_invite_code` RPC (read-only, non-consuming, same information-
disclosure boundary as `accept_invite_code` — requires the exact code) on
`app/join-invite.tsx`'s new confirm screen — the relationship is never
silently hidden. Surfaced on `app/participants.tsx` (organizer's view) and
`app/my-connections.tsx` (participant's view) wherever a connection is
already listed. Post-acceptance editing is deferred (not built this
batch) — see `docs/product-reset-audit.md`'s Build Batch 2 report for the
full rationale and remaining product debt.

**"Loved One" was replaced with "Family Member"** for the `care` use case
(Build Batch 1) — the product's authoritative relationship vocabulary
pairs Caregiver with Family Member, not Caregiver with Loved One. See
`docs/product-reset-audit.md` §7 (item B2) for the full rationale.

`getRoleLabelKeys` is the **only** approved source for a contextual
relationship label. It's consumed correctly by `choose-role.tsx`,
`caregiver-dashboard.tsx`'s participant chips, and `participants.tsx`'s
role-label heading. Two places bypass it and always show the neutral noun
regardless of `use_case` — found by this task's audit, **not fixed**
(changing them means threading `use_case` into two more screens, a real
scope increase for a copy-consistency pass, not a one-line fix):

- `firstReminder.confirmParticipantLabel` ("Participant") on the
  create-reminder confirmation screen.
- `reminderForm.forLabel` ("For") on the edit-reminder banner — a third,
  different word for the same "who is this reminder for" field.

Documented here as a known, accepted gap rather than silently left
unmentioned — see Known Limitations in `docs/visual-design-model.md`.

## Action verb vs. status noun (intentional, not a bug)

The audit flagged four different words for "this reminder was taken":
**"Done"** (dashboard/alert action buttons), **"Completed"** (status
badges/chips), **"Marked as completed"** (post-action toast), and lowercase
**"taken"** (organizer analytics sentences, e.g. "3 of 5 taken"). This is
kept as-is deliberately: a button showing the *verb you're about to
perform* ("Done") and a badge showing the *resulting state* ("Completed")
serving different grammatical roles is a normal, common pattern — forcing
both to read "Completed" would make the button read oddly ("Tap
Completed" is worse than "Tap Done"). The lowercase "taken" in analytics
sentences is likewise a normal mid-sentence verb form, not a separate
concept. **No change made.**

Snooze/Skip have a similar short-button vs. full-sentence pattern that's
also kept: **"Later"**/**"Skip"** (compact dashboard buttons) vs. **"Remind
Me Later"**/**"Skip this reminder"** (full-screen alert, more room for a
complete phrase). Same underlying action, appropriately different verbosity
for the available space — not a defect.

## Fixed inconsistencies (this task)

- **"Join Care Circle"** — the one truly stray phrase in the entire audit:
  a one-off brand phrase ("Care Circle") that appeared nowhere else in the
  app and didn't tie to either the neutral or contextual vocabulary above.
  Changed to **"Connect Your Account"** (EN) / **"Conecta tu cuenta"**
  (ES) — matching the screen's own submit button, which already said
  "Connect Account."
- **"End Connection" vs. "End connection"** — the confirm-dialog button and
  the row-level action label used different capitalization for the
  identical action. Unified to Title Case ("End Connection") in both
  places; Spanish was already consistent ("Terminar conexión") and
  untouched.
- **Auth submit-button capitalization** — "Sign In" and "Create Account"
  were Title Case while "Send reset link" and "Update password" (same
  functional slot: primary CTA at the bottom of an auth form) were sentence
  case. Unified all four to Title Case in English. Spanish equivalents were
  already consistently sentence-case (linguistically correct for Spanish
  UI copy) and were left untouched — this is a language-appropriate
  difference, not an inconsistency to fix.
- **Spanish Focus-mode terminology** — `reminderDetails.timeSensitiveNote`
  said "modo No molestar" (Do Not Disturb, a different, older iOS feature)
  while `notificationPermission.timeSensitiveNote` correctly said "modos de
  enfoque" (Focus modes, matching Apple's actual Spanish terminology).
  Both English sources say "Focus" — the Spanish `reminderDetails` string
  was corrected to match.
- **Day-of-week and time-picker labels were hardcoded English** (a known
  issue carried over from the accessibility task) — "Mon"–"Sun",
  "hour"/"min", "Tap to change", and every increase/decrease/±5-minute
  control label in `TimePickerField.tsx` are now translated
  (`reminderForm.day*`, `.tapToChange`, `.hourUnit`, `.minuteUnit`,
  `.increaseHour`, etc.) via a new `buildFrequencyLabels(t)` helper in
  `lib/frequency.ts` that keeps the underlying pure, zero-import module
  callable with no i18n context (its own non-UI callers, like
  `scripts/reminder-audit/run.ts`, still get the English fallback).

## Internal/technical language — confirmed never user-visible

Every `recipient_id`/`caregiver_id`/`occurrence`/`connection_id`/`RLS`/`uuid`
occurrence in the codebase is a database column name, a TypeScript variable
name, a route name (`/recipient-dashboard`), or a code comment — never
interpolated into a translated string or rendered `<Text>`. Confirmed via a
full-text audit of both locale files (zero matches for any of these tokens
inside a quoted string value) and every screen file. The internal
`caregiver`/`recipient` role vocabulary is fully firewalled from the
user-facing `Organizer`/`Participant`/contextual vocabulary.

## No medical or compliance claims

Confirmed via grep across both locale files, `app.json`, `README.md`, and
`docs/`: no "HIPAA," "medical," "diagnosis," "treatment," or "health
record" language exists anywhere in user-facing or marketing-adjacent copy.
`docs/security-model.md` and `docs/onboarding-model.md` explicitly document
that this is deliberate, not accidental.

## Empty-state tone

Sampled every empty-state title+body pair in the app
(`allClearTitle`/`notConnectedTitle`/`connectionEndedTitle`/
`noRemindersSetUpTitle`/`noParticipantLinked`/`noAnalyticsYet`/
`noCountableHistory`/`noRemindersCreatedYet`/`noHistoryYet`/`emptyTitle`).
No emoji and almost no exclamation marks exist anywhere in either locale
file — the hypothesized "celebratory vs. flat" tone mismatch was not
found; copy is uniformly short-title-plus-one-sentence, plain and
functional. The one outlier for length (not tone) is
`participants.emptyText`, which lists example relationships ("a team
member, a client, a student, a family member..." — reordered in Build
Batch 1 to lead with a neutral example rather than "a loved one," see
`docs/product-reset-audit.md` §7 item B3) and reads noticeably
longer/chattier than
every other empty state — left as-is, since it's doing useful work
(illustrating that Tavora isn't only for eldercare) that a terser version
would lose.

## Multiple labels for "invite a participant" (accepted, contextual)

Five different strings exist for this one underlying action across
different contexts: "Invite Participant" (screen heading/button), "Invite"
(compact header pill), "Add"/"Add participant" (chip/row action),
"Invite your first participant" (empty-state CTA). This is treated as
acceptable contextual variation (a compact header pill legitimately needs
shorter text than a full empty-state CTA) rather than a defect requiring
one single string everywhere — Phase 10's own instruction that "contextual
wording must not obscure the underlying action" is satisfied: every
variant is unambiguously about inviting/adding a participant.

## Known limitation

`common.save` ("Save") is defined in `en.ts`/`es.ts` but referenced by no
screen — both real save actions use the longer, screen-specific "Save
Reminder"/"Save Changes" instead. Left in place rather than removed, since
deleting an i18n key on the mere chance nothing references it is exactly
the kind of speculative cleanup this task's constraints discourage; noted
here so a future pass doesn't re-discover it as a mystery.
