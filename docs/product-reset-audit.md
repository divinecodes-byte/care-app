# Tavora Product Reset Audit — Migration Blueprint

Status: **audit complete, no implementation performed**. This document is the authoritative blueprint for repositioning Tavora from an elder-care reminder app to a general person-to-person accountability/coordination platform. It is written so the next work session can start implementing directly from this file without re-deriving product direction, without re-grepping the repo, and without re-litigating what's safe to touch.

Every claim below was verified directly (file read, live `supabase db query --linked`, or targeted grep) — not inferred from memory or from the original migration comments alone.

---

## 1. Executive summary

Tavora's backend and application-layer terminology are **already substantially generalized**. This is not a greenfield repositioning — it's closing a gap between work already done (an `Organizer`/`Participant` vocabulary layer, a `profiles.use_case` field with six values including `coaching`/`team`/`personal`, use-case-aware role labels, a routine-template catalog with only one caregiving-branded pack out of eight) and a handful of remaining surfaces that still default to, or visibly brand around, caregiving.

**What actually makes Tavora look like an elder-care app today**, in order of visibility:
1. Two route/component names: `app/caregiver-dashboard.tsx`, `app/recipient-dashboard.tsx` (internal — not shown to users — but they anchor a large reference graph).
2. The reminder "type" taxonomy (`medication | hydration | appointment | meal | exercise | other`) is the **only** categorization offered for a Timed Reminder, defaults to `medication`, and is enforced by both the client and a database `CHECK` constraint — this is the one place a fitness coach or manager creating a reminder sees inescapably medical-flavored options.
3. The Organizer role card on `choose-role.tsx` always shows a heart icon, regardless of the use case chosen one screen earlier.
4. One of eight built-in routine packs (`daily_care_routine`, "Daily Care Routine") is explicitly `care`-branded and `care`-only-recommended.
5. `app.json`/`package.json` still carry the literal identifiers `slug: "care-app"`, `bundleIdentifier: "com.divinecodesbyte.careapp"`, `"name": "care-app"`.
6. The app-icon generation script (`scripts/generate-tavora-assets.mjs`) draws a heart silhouette as the brand mark.

**What does NOT need to change**: the connection/RLS/authorization model, multi-organizer support, reminder/task/routine lifecycles, occurrence identity, schedule versioning, notification idempotency, timezone handling, account deletion, and the audit/regression infrastructure are all already relationship-agnostic. No caregiving-specific business rule (medical data field, elderly-assumption check constraint, dependent-person logic) exists anywhere in 44 migrations or 8 edge functions. The `caregiver_id`/`recipient_id`/`role IN ('caregiver','recipient')` naming is exactly what the task brief predicted: internal naming debt, not architectural coupling — it is safe to leave alone for this pass.

**The one genuine structural gap**: relationship context currently lives only as a single `profiles.use_case` value, set once at onboarding, shared identically across every connection that organizer has. The new product needs an organizer to plausibly be a "Coach" to one participant and a "Parent" to another. Fixing this requires a real (but small, additive, zero-risk) schema change — a new nullable `connections.relationship_pair` column — not a rename or a copy change. This is detailed in §12.

**Recommended first implementation batch** (§19) touches ~14 files, is entirely additive/reversible, and ships zero DB migrations.

---

## 2. Current architecture relevant to the reset

- **Client**: Expo Router (file-based routes in `app/`), React Native, a single i18n layer (`lib/i18n/locales/en.ts` / `es.ts`) that is the sole source of user-facing strings (confirmed: zero literal UI strings live outside these two files across all screens/components inspected).
- **Backend**: Supabase Postgres. 44 tracked migrations (`supabase/migrations/`) plus a pre-tracked baseline (the `profiles`, `connections`, `reminders`, `reminder_logs` tables predate the tracked history — their `CREATE TABLE` statements are not in the migrations folder; live schema was queried directly to fill this gap, see §6).
- **Authorization model**: `profiles.role` is a two-value enum, `'caregiver' | 'recipient'` (verified live: `profiles_role_check: CHECK (role = ANY (ARRAY['caregiver','recipient']))`). Every RLS policy and RPC keys off this literal value — never off `use_case` or any display label. This is the deepest, most load-bearing internal-naming item in the whole audit.
- **Personalization layer (already exists)**: `profiles.use_case`, nullable, `CHECK (use_case IN ('care','family','coaching','team','personal','other'))` (verified live). Display-only — `docs/onboarding-model.md` and the migration's own comment both state it is never read by any RLS policy or RPC. Drives: onboarding role-card copy (`getRoleLabelKeys`), example reminder-title placeholders (`getExampleReminderTitleKey`), and routine-pack recommendation ordering (`app/routine-library.tsx`).
- **Multi-organizer support**: structurally unlimited on the participant side. The only cap (`MAX_STANDARD_PARTICIPANTS = 5`, `lib/limits.ts:16`) is per-organizer (how many participants one organizer account can invite), enforced in `create_invite_code()`. `docs/multiple-organizer-model.md:30` states explicitly: "There is no participant-side organizer cap." Verified live: the uniqueness constraint on `connections` is a **partial unique index on `(caregiver_id, recipient_id) WHERE status='accepted'`** — scoped to the pair, not the participant.
- **Feature objects**: Reminder (exact-time, `reminders`/`reminder_logs`), Task (flexible/non-time-based, `tasks`/`task_occurrences`/`task_schedule_versions`), Routine (reusable blueprint, `routine_templates`/`routine_instances`/`routine_instance_items`). All three are already fully role-label-agnostic at the schema level in their newer tables (`routine_instances` uses `organizer_id`/`participant_id` natively — see §6).
- **Production data (live, verified)**: 36 `profiles`, 13 `connections`, 29 `reminders`, 2 `tasks`, 0 `routine_instances`, 5 profiles with a non-null `use_case`. Small and almost certainly mostly synthetic/audit accounts, but treated as real production data per the safety requirements — nothing in this plan touches it directly; all proposed schema changes are additive (`ALTER TABLE ... ADD COLUMN`, nullable, no backfill required).

---

## 3. Legacy terminology inventory

Full detail with file:line is in §5–§10. Summary table:

| Term | Where it lives | Contextual (gated by use_case) or Universal (always shown)? |
|---|---|---|
| "Caregiver" / "I'm a Caregiver" | `chooseRole.careOrganizerTitle` (en/es) | Contextual — only shown when `use_case === 'care'` |
| "Loved One" | `chooseRole.careParticipantTitle` (en/es) | Contextual — same gate. **Conflicts with the new spec's own naming** (spec says Caregiver↔"Family Member", not "Loved One" — see §7) |
| "Medication" reminder type | `reminderForm.typeMedication`, `ReminderType` union | **Universal** — one of only 6 always-visible type chips, and the default selection |
| 💊 medication emoji | `recipient-dashboard.tsx:82`, `reminder-alert.tsx:75` | Universal (icon for the above) |
| "loved one" (lowercase, inline) | `participants.emptyText` | Universal — leads the list of example relationships in the zero-participants empty state |
| "Daily Care Routine" pack | `routineCatalog.dailyCareRoutine.*`, `lib/routineCatalog.ts:135-145` | Contextual (`recommendedUseCases: ['care']`) but the pack is still always visible to everyone in the "Tavora Packs" section |
| `caregiver_id` / `recipient_id` | ~10 DB tables, every RLS policy, every RPC | N/A — internal identifier, never rendered |
| `role = 'caregiver' \| 'recipient'` | `profiles.role`, every authorization check | N/A — internal, never rendered |
| Route names `/caregiver-dashboard`, `/recipient-dashboard` | file names, `router.push` targets across ~10 files, `OnboardingRoute` type | N/A — internal path string, never rendered as text, but referenced everywhere |
| `caregiver_notification_events`, `send_pending_caregiver_push_notifications()`, `data.type: 'caregiver_reminder_event'` | notification pipeline (DB table/function + push payload wire value) | N/A internally, but the wire string is a cross-boundary contract (server writes it, `app/_layout.tsx` reads it) |
| "care-app" / "careapp" | `app.json` (`slug`, `bundleIdentifier`), `package.json` (`name`) | N/A — build config, not runtime copy |
| Heart-silhouette app icon | `scripts/generate-tavora-assets.mjs:14-16` | Brand asset, highly visible (App Store icon) |

No matches anywhere in the repo (migrations, locale files, docs, `app.json`, README) for: "Care Circle" (already removed — see the visual-consistency-audit regression guard, §9), "elder", "elderly", "senior", "senior care", "dependent", "HIPAA", "diagnosis", "medical record", or any structured medical-data field (dosage, prescriber, condition, allergy).

---

## 4. Legacy feature inventory

| Feature | Status |
|---|---|
| Caregiving-only screens | **None exist.** Every screen already serves organizer/participant generically; "caregiver-dashboard.tsx" and "recipient-dashboard.tsx" are role-adaptive dashboards, not caregiving-exclusive UIs — only their file/route names are stale. |
| Caregiving-only onboarding | Partially — `choose-use-case.tsx`/`choose-role.tsx` already present 6 generic-to-specific paths; the gap is breadth (no `education` category, no fine-grained relationship pairs) and one icon bug (§7). |
| Caregiving-only empty states | One: `participants.emptyText` leads with "loved one" (§7). |
| Caregiving-only dashboard descriptions | None found — dashboard copy is already generic Organizer/Participant framing. |
| Caregiving-only notification copy | None in actual push payloads (verified across all 3 push-producing edge functions). One internal wire-value (`caregiver_reminder_event`) and one DB table/function pair are caregiver-branded but never rendered to a user. |
| Caregiving-only illustrations/icons | Two: the `choose-role.tsx` heart icon (§7), and the app-icon heart silhouette (§7). |
| Caregiving-only templates presented as default | One of eight routine packs (`daily_care_routine`); the other seven are already universal or coaching/work/education-appropriate as written. |
| Routes/screens that exist solely for elder-care positioning | **None.** Every route (`invite-recipient.tsx`, `join-invite.tsx`, `my-connections.tsx`, `overdue-tasks.tsx`, etc.) is structurally generic; only 3 filenames are stale (§8). |
| Dead screens/components/routes | One dead cluster: 9 unused `create-expo-app` boilerplate files in `components/` (§5, DELETE list). No dead routes, no dead flags. |

---

## 5. DELETE list

| # | File(s) | Current state | Why delete | Dependencies/risk |
|---|---|---|---|---|
| A1 | `components/external-link.tsx`, `components/haptic-tab.tsx`, `components/hello-wave.tsx`, `components/parallax-scroll-view.tsx`, `components/themed-text.tsx`, `components/themed-view.tsx`, `components/ui/collapsible.tsx`, `components/ui/icon-symbol.tsx`, `components/ui/icon-symbol.ios.tsx` | Inert `create-expo-app` template scaffolding. Confirmed via cross-reference grep: these 9 files only import each other; zero imports from any real `app/`, `lib/`, or other `components/` file. | Not caregiver-related — pure dead code carried over from project scaffolding, unrelated to the product reset but flagged by the requested dead-code sweep. Safe to remove as a clean-up pass alongside the reset. | Zero — deleting all 9 together leaves no dangling import (verified the only cross-references are within this same cluster). Not urgent; can ride along with any batch or be skipped entirely without blocking the reset. |

No other DELETE candidates were found. No caregiving-only screen, component, or route exists to remove — every screen in `app/` already serves the generic Organizer/Participant model structurally.

---

## 6. Legacy naming inventory — full backend detail (supports §7–§10)

Verified live against the linked Supabase project (not reconstructed from migration text alone):

**Tables** (13 created within tracked migrations; 4 predate tracked history and were queried live): `profiles`, `connections`, `reminders`, `reminder_logs`, `reminder_notification_deliveries`, `onboarding_events`, `tasks`, `task_occurrences`, `task_notification_deliveries`, `task_schedule_versions`, `routine_templates`, `routine_template_items`, `routine_instances`, `routine_instance_items`, `routine_notification_deliveries`, `operational_alerts`, `operational_alert_deliveries`, `caregiver_notification_events`.

**`profiles` full column list** (live):
```
id uuid, full_name text, role text, created_at timestamptz, updated_at timestamptz,
timezone text not null default 'America/New_York',
server_push_enabled boolean not null default false,
deleted_at timestamptz,
account_status text not null default 'active',
notification_preview_mode text not null default 'private',
use_case text
```
Check constraints (live):
```
profiles_role_check:                     CHECK (role = ANY (ARRAY['caregiver','recipient']))
profiles_use_case_check:                 CHECK (use_case = ANY (ARRAY['care','family','coaching','team','personal','other']))
profiles_account_status_check:           CHECK (account_status = ANY (ARRAY['active','deleted']))
profiles_notification_preview_mode_check:CHECK (notification_preview_mode = ANY (ARRAY['private','detailed']))
profiles_timezone_not_blank_check:       CHECK (btrim(timezone) <> '')
```

**`connections`**: `caregiver_id`, `recipient_id`, `status ('pending'|'accepted'|'ended')`, `invite_code`, `expires_at`, `updated_at`, plus:
- `connections_no_self_connection_check: CHECK (recipient_id IS NULL OR recipient_id <> caregiver_id)` — **structurally forbids self-connections**. This is directly relevant to the new "Personal Accountability → Self" use case — see the blocking ambiguity flagged in §17.
- `connections_unique_accepted_pair`: partial unique index on `(caregiver_id, recipient_id) WHERE status='accepted'`.

**`caregiver_notification_events`** (live columns): `id, caregiver_id, recipient_id, connection_id, reminder_id, reminder_log_id, event_type, title, body, status, sent_at, error_message, created_at, updated_at`. Populated by a trigger (`create_caregiver_notification_event`, live but not present in tracked migration text — it predates tracked history) and drained by `send_pending_caregiver_push_notifications()` (`20260723213500_notification_preview_privacy.sql:114`). The push payload it produces sets `content.data.type = 'caregiver_reminder_event'` (line 169) — the one wire-protocol string in the whole notification pipeline that says "caregiver," read by `app/_layout.tsx`'s tap-router.

**`reminders_reminder_type_check`** (live): `CHECK (reminder_type = ANY (ARRAY['medication','hydration','appointment','meal','exercise','other']))`. Also enforced identically in RPC validation (`create_reminder`, `update_reminder_schedule`) and in `routine_template_items_kind_fields_check`'s reminder branch — meaning this 6-value taxonomy is checked in at least 3 independent places (table constraint, RPC input validation, routine-item constraint), all of which would need to move together.

**Nothing else found**: no medical-data columns (dosage, prescriber, diagnosis, condition, allergy — grepped, zero hits), no elderly/dependent-person check constraint, no caregiving-only RLS predicate anywhere in 44 migrations.

---

## 7. REWRITE NOW list

User-facing or behavioral content that actively makes Tavora look/behave like a caregiver-only product, fixable by copy/behavior change alone (no DB migration required).

| # | File:line | Current behavior | Why it conflicts | Required replacement | Risk |
|---|---|---|---|---|---|
| B1 | `app/choose-role.tsx:129-130` | Organizer role card renders `<Ionicons name="heart" .../>` on `C.caregiverLight`/`C.caregiverColor` background **for every use case** — a coach, manager, or tutor sees a heart icon under "I'm a Coach"/"I'm a Manager". | Directly contradicts the already-correct per-use-case iconography on the immediately-preceding `choose-use-case.tsx` screen (`heart`/`home`/`fitness`/`briefcase`/`checkmark-circle`/`ellipsis-horizontal-circle`). | Read `useCase` (already available in this screen's params) and select the matching icon from the same map `choose-use-case.tsx` uses (import/reuse `USE_CASE_CARD_KEYS[useCase].icon`), or fall back to a neutral icon (`people`) when `useCase` is null. Pair with C4 (theme token rename). | Low — pure client change, one screen, no data dependency. |
| B2 | `lib/i18n/locales/en.ts` / `es.ts`: `chooseRole.careParticipantTitle` = "I'm a Loved One" / `careParticipantDesc` | Shown when `use_case === 'care'`. | The new product's own authoritative relationship list specifies **Caregiver / Family Member**, not Caregiver / Loved One. "Loved One" is itself caregiving-flavored language the new spec has moved away from. | Change EN value to "I'm a Family Member" (ES: "Soy un Familiar" or equivalent), update `careParticipantDesc` accordingly. This also aligns the string with the new `relationship_pair = 'caregiver_family_member'` label proposed in §12. | Low — copy-only, one key pair, both locales. |
| B3 | `lib/i18n/locales/en.ts` / `es.ts`: `participants.emptyText` | "Invite someone to get started — they can be a loved one, an athlete, a team member, or anyone else you want to help stay on track." Universal empty state, not use-case gated. | Leads with "loved one" as the first example in a list every organizer sees before they have any participants — sets an implicit default framing. | Reorder to lead with a neutral example, e.g. "...they can be a team member, a client, a student, a family member, or anyone else you want to help stay on track." (Keep the inclusive-list pattern — `docs/product-terminology.md` already documented this string as deliberately illustrative; just reorder/broaden, don't shorten.) | Low — copy-only. |
| B4 | `lib/routineCatalog.ts:135-145` + `en.ts`/`es.ts` `routineCatalog.dailyCareRoutine.*` | Pack id `daily_care_routine`, title "Daily Care Routine", description "A generic daily structure for care and accountability...", item "Complete daily care activities", `recommendedUseCases: ['care']` only. | The only one of 8 packs explicitly branded around "care" as an identity rather than as one of several relationship contexts; its restrictive `recommendedUseCases` also means it never surfaces as "Recommended" for any non-care use case even though its actual content (a check-in + activities + notes-to-share loop) is universal. | Rename pack id (e.g. `daily_checkin_routine`), retitle "Daily Check-In Routine", broaden `recommendedUseCases` to `['care','family','personal']` (matching `morning_routine`/`evening_routine`'s existing pattern), generalize the "care activities"/"notes to share with organizer" item copy to "Complete daily activities"/"Note anything to share with your organizer." | Low — pure catalog/i18n change. Confirm `routineCatalog.ts`'s versioning field (if any) doesn't require a matching migration; templates are applied by copying values into `tasks`/`reminders` at apply-time, not referenced by id afterward, so renaming the catalog entry has zero effect on already-applied routines. |
| B5 | `app/create-reminder.tsx:84`, `app/edit-reminder.tsx:93` | `useState<ReminderType>('medication')` — every new/edited reminder defaults to the "Medication" type chip. | Defaulting every organizer, regardless of use case, into a medical category is the most visible "this is a medication app" signal in the create flow. | Change the default to `'other'` (already a valid, always-present value — zero DB/constraint change needed). Optionally make the default use-case-aware later (§12), but changing away from `'medication'` alone is a complete, safe fix today. | Low — one-line default change per file, no constraint change (the value stays within the existing allowed set). |
| B6 | `scripts/generate-tavora-assets.mjs:14-16` (`HEART_PATH`) | App-icon generator draws a heart silhouette as Tavora's brand mark — this shape ends up as the literal App Store/Play Store icon. | The single most visible, most externally-facing caregiving signal in the entire repo — it's the icon a user sees before opening the app at all. | Requires a real design decision (new mark), not a code-only fix — flag for design input. Once a new mark is chosen, regenerate via the same script's existing pipeline (`npx node scripts/generate-tavora-assets.mjs` presumably — confirm invocation before running). | **Higher — this changes the shipped app icon**, which has App Store review and user-recognition implications. Do not do this as a silent/automatic step; treat as an explicit, separately-approved design task, not part of the mechanical first batch. |

---

## 8. RENAME NOW list

Safe application-layer (client-only, or client+one-time-coordinated) terminology changes. None of these touch a database table/column name or require a data migration.

| # | Current | Rename to | Reference sweep required | Risk |
|---|---|---|---|---|
| C1 | `app/caregiver-dashboard.tsx`, component `CaregiverDashboard` | `app/organizer-dashboard.tsx`, component `OrganizerDashboard` | Route target `'/caregiver-dashboard'` appears in: `choose-role.tsx`, `create-task.tsx:209`, `create-reminder.tsx:326`, `edit-reminder.tsx:236-237,269-270`, `edit-task.tsx:173`, `invite-recipient.tsx:408`, `participants.tsx:147`, `app/_layout.tsx:150-154` (push-tap router), `lib/onboardingCore.ts`'s `OnboardingRoute` type + `resolveProfileRoute()`, `app/index.tsx`, `app/signin.tsx`. Test references: `scripts/onboarding-audit/run.ts` (asserts route, lines 161/234), `scripts/accessibility-audit/run.ts` (asserts filename). | Medium — mechanical but wide (≈14 files). Expo Router will 404 any stale hardcoded path if one reference is missed; grep for the literal string `'/caregiver-dashboard'` after the rename to confirm zero remain. |
| C2 | `app/recipient-dashboard.tsx`, component `RecipientDashboard` | `app/participant-dashboard.tsx`, component `ParticipantDashboard` | Same shape as C1: `lib/onboardingCore.ts`'s `OnboardingRoute` type + `resolveProfileRoute()`, `app/index.tsx`, `app/signin.tsx`, `app/join-invite.tsx`, any other `router.replace('/recipient-dashboard')` call site. | Medium — same class of risk as C1; do in the same batch/commit so the two dashboards never disagree mid-migration. |
| C3 | `app/invite-recipient.tsx`, component `InviteRecipientScreen` | `app/invite-participant.tsx`, component `InviteParticipantScreen` | The file's own i18n keys already say `inviteParticipant.*` — this rename **closes an existing mismatch**, it doesn't create one. Reference sweep: `caregiver-dashboard.tsx` (soon `organizer-dashboard.tsx`)'s invite button, `participants.tsx`'s invite entry point, any `router.push('/invite-recipient')` call. | Low — smallest and cleanest of the three route renames; do first as a template for C1/C2. |
| C4 | `constants/theme.tsx` (or wherever defined) tokens `C.caregiverLight` / `C.caregiverColor` | `C.organizerLight` / `C.organizerColor` | Consumed at `choose-role.tsx:129-130` (paired with fix B1). | Low — theme-token rename, single consumer found. |
| C5 | Internal TS identifiers: `components/settings-sheet.tsx` `styles.valCaregiver`/`styles.valRecipient` (also the style object keys at line ~1108), `app/join-invite.tsx` `caregiverProfile` variable, `app/caregiver-dashboard.tsx` `caregiverIdRef` | `styles.valOrganizer`/`styles.valParticipant`, `organizerProfile`, `organizerIdRef` | Purely local — no cross-file references beyond their own file (verified: these are local `const`/`useRef`/style-object names, not exported). | Very low — mechanical find/replace within each file individually. Batch with §10 (internal application-layer names) rather than doing separately. |
| C6 | `lib/onboarding.ts`: exported function `recipientHasAcceptedConnection(userId)` | `participantHasAcceptedConnection(userId)` | One call site: `app/index.tsx` / `app/signin.tsx` (wherever `resolveProfileRoute`'s `recipientHasConnection` argument is computed — confirm exact call site before renaming). The function body's own `.eq('recipient_id', userId)` DB call **stays unchanged** (column name is KEEP TEMPORARILY, §9) — only the TS function name changes. | Low — single exported symbol, one known call site. |
| C7 | Notification wire value `data.type: 'caregiver_reminder_event'` (`supabase/migrations/20260723213500_notification_preview_privacy.sql:169`, read by `app/_layout.tsx:150`) | `organizer_reminder_event` | This is the one "RENAME NOW" item that is **not** purely client-side — it's produced by a live DB function and consumed by the shipped app. Requires: (a) a new migration updating `send_pending_caregiver_push_notifications()`'s literal string, (b) `app/_layout.tsx`'s listener updated in the same app release. **Transition safety**: because a push notification enqueued under the old function version could still be in Expo's delivery queue when a new app build rolls out (or vice versa — an old app build still installed when the new function ships), `app/_layout.tsx`'s listener should accept **both** `'caregiver_reminder_event'` and `'organizer_reminder_event'` for at least one release cycle before the old value is ever removed from the check. | Medium — the only rename in this list with a real (if narrow, if bounded) coordinated-rollout requirement. Schedule with backend/notification-aware review, not as a blind mechanical edit. |

---

## 9. KEEP TEMPORARILY list

Semantics are already generic (the two-role connection model applies identically to every relationship type); renaming now would mean touching live Postgres table/column/function names across every RLS policy, RPC, edge function, and audit script that references them — real deployment risk for zero behavioral gain in this pass.

| # | Item | Where | Why keep for now |
|---|---|---|---|
| D1 | `caregiver_id` / `recipient_id` columns | `connections`, `reminders`, `reminder_logs`, `reminder_notification_deliveries`, `tasks`, `task_occurrences`, `task_notification_deliveries`, `caregiver_notification_events`, plus every RLS policy and RPC parameter that reads them (`create_reminder`, `create_task`/`_create_task_core`, `respond_to_reminder_occurrence`, `respond_to_task_occurrence`, activity-feed RPCs, ops-health RPCs — dozens of call sites) | A column rename requires a coordinated migration touching every one of these simultaneously (Postgres doesn't let you rename a column referenced by dependent views/functions without updating them in the same transaction window), plus every `supabase-js` `.eq('caregiver_id', ...)` call across ~20 client/script files, plus every scripts/*-audit fixture helper. This is exactly the "actual architectural coupling vs. cosmetic naming" distinction the brief draws — these ARE just naming (verified: no business rule anywhere assumes the caregiver_id side is literally family, or the recipient_id side is elderly/dependent), so the risk-to-value ratio of renaming now is bad. Revisit as a dedicated, isolated migration project once the higher-value application-layer work is shipped. |
| D2 | `profiles.role` values `'caregiver' \| 'recipient'` | `profiles_role_check`, every RLS policy, every RPC authorization check, `lib/onboardingCore.ts`'s `Role` type | Same reasoning as D1, and inseparable from it — you cannot rename the columns without also confronting this enum (or vice versa). Batch together in a future dedicated pass. |
| D3 | `caregiver_notification_events` table, `send_pending_caregiver_push_notifications()` function, `create_caregiver_notification_event()` trigger | notification pipeline (§6) | Same DB-rename risk class as D1. Note: the **wire-value string** this function produces (`data.type`) is separately addressed as C7 (RENAME NOW) — the string is cheap/coordinated to change independent of the table/function names themselves. |
| D4 | RPC/function names with `recipient`/`caregiver` in them: `claim_due_recipient_reminder_deliveries`, `claim_due_recipient_snooze_deliveries`, `sync_missed_reminders_db`'s internal recipient-scoped queries, etc. | reminder-delivery pipeline migrations | Same reasoning — Postgres function renames require coordinated `DROP`/`CREATE` plus updating every caller (cron jobs, edge functions, other RPCs). |
| D5 | `Role` type union `'caregiver' \| 'recipient'` | `lib/onboardingCore.ts:122` | Its own comment already states this intentionally mirrors the DB values — must move together with D2, not independently. |
| D6 | Fixture-role shorthand (`cg`/`rc` variable prefixes, `role: 'caregiver'` setup lines) across all `scripts/*-audit/run.ts` | test/audit infrastructure | Explicitly out of scope per the task brief ("internal naming debt... not architectural coupling") — and structurally must track D1/D2 exactly, since these scripts assert against the live schema. |
| D7 | `lib/notifications.ts`: `CHANNEL_ID = 'care-reminders'` (Android notification channel id), local-notification identifier prefix `'care-${reminderId}...'` | client notification scheduling | Purely internal, zero user visibility (the channel's *display name*, which IS user-visible in Android system settings, is already the generic "Reminders" — confirmed). The one reason this isn't RENAME NOW despite being pure client code: Android notification channels are keyed by their id on-device; changing the id makes Android silently create a **new** channel with default settings, discarding any per-channel customization (e.g. a user who muted it) a real device may already have. Low value, non-zero minor UX regression risk — defer, don't bundle into a "just rename it" pass. |

---

## 10. KEEP list

Fully compatible with the new product; no action needed.

- **Multi-organizer connection architecture** (`connections` table, RLS, `docs/multiple-organizer-model.md`) — already unlimited on the participant side, already isolated per-connection, already exactly what "many relationships, many organizers" requires.
- **`app/create-item.tsx`** — a thin, already-generic Reminder-vs-Task router; confirmed live (called from `caregiver-dashboard.tsx:973` and `participants.tsx:151`), not dead code.
- **All push-notification title/body copy** for reminders, tasks, and routines (`"Tavora reminder"`/`"Tavora task"`/`"Tavora routine"` + generic bodies, verified across all 3 producing edge functions) — zero caregiving language, needs no change.
- **6 of 8 built-in routine packs**: `morning_routine`, `evening_routine`, `family_chores`, `workout_accountability`, `study_routine`, `workday_checkin` — content is already universal or already correctly relationship-specific (workout/study/workday packs map directly onto coaching/education/work contexts as written).
- **`dental_routine` pack** — health-hygiene-adjacent but not eldercare-exclusive; its own description already disclaims medical/treatment framing. No forced change; optionally broaden `recommendedUseCases` later, not required.
- **`choose-use-case.tsx`** screen and the `USE_CASE_CARD_KEYS` pattern — this is the already-correct reference implementation for use-case-driven UI (per-use-case icons, i18n-keyed, gracefully null-safe). The §12 data-model extension plugs into this pattern rather than replacing it.
- **`components/settings-sheet.tsx`'s "How you use Tavora" editor structure** — already iterates the `USE_CASES` constant generically; will automatically pick up new values once the underlying list is extended (§12), no screen rewrite needed.
- **`scripts/visual-consistency-audit/run.ts`'s terminology-guard scenarios** (e.g. scenario N: asserts "Join Care Circle" is gone from both locales; scenario confirming `common.organizer`/`common.participant` values) — these already enforce the desired end state. Extend with new scenarios as new strings are added; don't replace.
- **Account deletion, RLS policies, push-delivery idempotency, occurrence identity, task schedule versioning, timezone handling, ops-health infrastructure, audit/regression suites as a whole** — confirmed via all 5 research passes: zero caregiving-specific business logic exists anywhere in this protected list. This is the single most important confirmation in this audit: the "protected functionality" list in the task brief is safe exactly because nothing in it was found to assume caregiving.

---

## 11. STRUCTURAL REFACTOR list

Implementation genuinely encodes a caregiving-era (or now-too-narrow) assumption that copy/renaming cannot fix alone.

| # | Item | Current implementation | Why copy/rename can't fix it | Required refactor | Risk |
|---|---|---|---|---|---|
| F1 | Reminder "type" taxonomy | `ReminderType = 'medication'\|'hydration'\|'appointment'\|'meal'\|'exercise'\|'other'` is duplicated verbatim across `app/create-reminder.tsx`, `app/edit-reminder.tsx`, `app/reminder-alert.tsx`, `app/reminder-details.tsx`, `app/recipient-dashboard.tsx` (icon maps), **and** enforced by a live DB `CHECK` constraint (`reminders_reminder_type_check`) plus identical validation inside the `create_reminder`/`update_reminder_schedule` RPCs and `routine_template_items_kind_fields_check`. | The client cannot simply add a `'workout'` or `'checklist'` type chip — the database will reject any reminder saved with a `reminder_type` value outside the current 6, at the table level and inside 2+ RPC bodies independently. This is a genuine client+DB coupling, not a naming issue. | Two-part fix: (1) **additive** migration widening `reminders_reminder_type_check` and the two RPC validations and the routine-item constraint to accept new generic values (e.g. add `'workout'`, `'session'`, `'checklist'`, `'deadline'` — keep all 6 existing values, remove none, so no existing row or in-flight client is ever invalidated); (2) consolidate the currently-duplicated client type arrays into one shared module (follow the existing `lib/reminderOptions.ts` pattern, which already solved this exact duplication problem for the no-response-window options — confirmed that file is the right template to copy, not something to extend). | Medium — DB constraint change is additive/reversible (zero data-loss risk, since we're only ever adding allowed values), but touches 4+ SQL locations and 5 client files; needs careful "keep old values working" verification via the existing `reminder-audit` suite before/after. |
| F2 | Relationship context is per-organizer, not per-connection | `getRoleLabelKeys()` reads a single `use_case` off the **organizer's own profile row** and applies that label uniformly to every connection that organizer has (`docs/participant-management-model.md:94-98` confirms: the relationship label shown on a participant chip is "read from the organizer's own onboarding use_case" — not from anything connection-specific). | An organizer who genuinely coaches one participant and parents another (both real, both explicitly in-scope relationship types per the new product spec) cannot be represented — the current data model has exactly one relationship-context slot per organizer account, full stop. This is a data-model gap, not a display bug; no amount of renaming `use_case`'s values fixes "one value, shared across every connection." | Add a new nullable `connections.relationship_pair` column (§12) that overrides the profile-level default per-connection when set, with full backward-compatible fallback to today's `use_case`-driven label when null. Purely additive; does not remove or restructure `profiles.use_case` (which correctly stays as the pre-connection onboarding signal — see §12's reasoning for why `use_case` must remain profile-level even after this fix). | Low-medium — one new nullable column, one new CHECK constraint, one RLS-transparent read (RLS on `connections` already covers it), label-resolution logic gets one more optional input with a safe fallback. No existing data affected (column starts entirely null). |

---

## 12. New onboarding architecture

**Current flow** (`docs/onboarding-model.md`, verified unchanged): `select-language → signup → choose-use-case → choose-role → (organizer: dashboard) / (participant: join-invite → notification-permission → dashboard)`. This flow shape is already correct and should not change structurally.

**What changes**:

1. **`choose-use-case.tsx`** gains one more card: `education` (Tutor/Student, Mentor/Mentee), joining the existing `care`/`family`/`coaching`/`team`/`personal`/`other`. `USE_CASE_CARD_KEYS` gets one new entry (`education: { title, desc, icon: 'school' }` or similar). This is the only change to this screen — its existing generic-iteration structure needs no rewrite (confirmed §10).

2. **`choose-role.tsx`** fix: read the per-use-case icon (B1) instead of the hardcoded heart. No structural change otherwise — it still writes literal `role: 'caregiver'|'recipient'` (D2, unchanged) regardless of which label was shown, exactly as today.

3. **New, optional third onboarding micro-step for organizers**: after choosing `use_case`, before (or as part of) generating the first invite (`invite-recipient.tsx`/soon `invite-participant.tsx`), prompt for the specific `relationship_pair` for **that connection** (e.g., if `use_case === 'coaching'`, ask "Are you a Coach or a Trainer for this person?"). This is deliberately scoped to invite-creation time, not account-creation time, because it's a per-connection property (§12's data model, F2's fix). If skipped, `relationship_pair` stays null and the connection falls back to the existing `use_case`-driven generic label — **zero regression for any existing flow that ignores this entirely**.

4. **Settings → "How you use Tavora"** (`settings-sheet.tsx`) gains the new `education` use_case option automatically (already iterates the shared constant). A second, new "Relationship" row per-connection could be added to `participants.tsx`'s per-row management (allowing the organizer to set/change `relationship_pair` after the fact) — recommended but not required for the first batch; document as a fast-follow.

**Explicitly unchanged**: `resolveProfileRoute()`'s resume logic, the two-screens-added-to-Week-1-flow shape, the idempotent/no-onboarding-step-column design, `onboarding_events` telemetry.

---

## 13. Proposed relationship/use-case data model

### Design goals (from the task brief)
- Support many relationship types without forking the reminder/task/routine/connection architecture.
- No separate databases or task models by demographic.
- Additive, zero-risk to existing production data.
- Must not be per-organizer-only (see F2) — an organizer needs different relationship context per connection.

### Two-tier model

**Tier 1 — Category, stays on `profiles.use_case`** (unchanged column, one additive new value):
```sql
-- Additive only. No existing value removed or renamed.
alter table public.profiles drop constraint profiles_use_case_check;
alter table public.profiles add constraint profiles_use_case_check
  check (use_case in ('care', 'family', 'coaching', 'team', 'personal', 'other', 'education'));
```
Stays profile-level deliberately: it's asked once, at signup, **before any connection exists** — there is no connection to attach it to yet. It continues to drive onboarding example copy and routine-pack recommendation ordering exactly as today. Existing rows are entirely unaffected (this widens the allowed set; nothing is renamed or removed).

Category → new spec's grouping (documentation mapping only, no stored-value change):
| Stored `use_case` value | New spec category |
|---|---|
| `care` | Health & Care |
| `coaching` | Fitness & Coaching |
| `team` | Work |
| `family` | Family |
| `personal` | Personal Accountability |
| `education` (new) | Education |
| `other` | (uncategorized escape hatch) |

**Tier 2 — Relationship pair, new nullable column on `connections`** (the fix for F2):
```sql
-- New, nullable, additive. Every existing row gets NULL — zero backfill needed.
alter table public.connections add column relationship_pair text;
alter table public.connections add constraint connections_relationship_pair_check
  check (relationship_pair is null or relationship_pair in (
    'caregiver_family_member', 'provider_patient',        -- Health & Care
    'trainer_client', 'coach_athlete',                     -- Fitness & Coaching
    'parent_child', 'family_member_family_member',         -- Family
    'tutor_student', 'mentor_mentee',                      -- Education
    'manager_team_member',                                 -- Work
    'accountability_partner', 'self'                       -- Personal Accountability
  ));
```
Display-only, exactly like `use_case` — never read by RLS or any authorization RPC. Set (optionally) at invite-creation time (§11's onboarding addition), editable later per-connection (fast-follow in `participants.tsx`). `getRoleLabelKeys`-equivalent resolution order becomes: **`relationship_pair` (if set on this specific connection) → `use_case`-driven default (today's behavior, unchanged) → neutral Organizer/Participant fallback (today's behavior, unchanged)**. This is a pure superset of the current logic — no existing call site breaks, no existing label changes unless a connection explicitly opts into a `relationship_pair`.

Label mapping (new i18n key group, `relationshipPair.*`, mirroring the existing `chooseRole.care*`/`coaching*`/`team*` pattern exactly):
| `relationship_pair` | Organizer label | Participant label | Note |
|---|---|---|---|
| `caregiver_family_member` | Caregiver | Family Member | Replaces "Loved One" (see B2 — the `care`-use-case default should also change to this) |
| `provider_patient` | Provider | Patient | New |
| `trainer_client` | Trainer | Client | New |
| `coach_athlete` | Coach | Athlete | Already exists today under `coaching` use_case — reuse `chooseRole.coaching*` keys directly, no new string needed |
| `parent_child` | Parent | Child | New |
| `family_member_family_member` | Family Member | Family Member | New — symmetric; needs slightly different card copy (no "who's who" framing since both sides read identically) |
| `tutor_student` | Tutor | Student | New |
| `mentor_mentee` | Mentor | Mentee | New |
| `manager_team_member` | Manager | Team Member | Already exists today under `team` use_case — reuse `chooseRole.team*` keys directly |
| `accountability_partner` | Accountability Partner | Accountability Partner | New — symmetric |
| `self` | — | — | **Not resolvable today — see §17 blocking ambiguity.** `connections_no_self_connection_check` structurally forbids `caregiver_id = recipient_id`. Do not implement this pair value until the ambiguity is resolved; omit it from the CHECK constraint's allowed set in the first migration, add it later once a decision is made. |

### Why not just widen `use_case` itself to the 10 specific pairs?
Considered and rejected: `use_case` also drives routine-pack recommendation filtering (`recommendedUseCases` arrays), which is deliberately coarse — a `trainer_client` and a `coach_athlete` connection both want the same `workout_accountability` pack recommended. Ten fine-grained values would force either a combinatorial `recommendedUseCases` explosion across all 8 packs, or silent under-recommendation for whichever specific pair wasn't explicitly listed. Keeping category (coarse, drives recommendations) and pair (fine, drives display labels only) as two separate concerns avoids both problems and matches the existing architecture's own separation (use_case already does exactly one job — display copy selection — cleanly).

---

## 14. Screen-by-screen transformation map

| Screen | Action | Batch |
|---|---|---|
| `app/choose-use-case.tsx` | Add `education` card | 2 |
| `app/choose-role.tsx` | Fix hardcoded heart icon (B1); rename internal file NOT required (filename is fine) | 1, 2 |
| `app/caregiver-dashboard.tsx` | Rename file+component → `organizer-dashboard.tsx`/`OrganizerDashboard` (C1) | 10 |
| `app/recipient-dashboard.tsx` | Rename file+component → `participant-dashboard.tsx`/`ParticipantDashboard` (C2) | 10 |
| `app/invite-recipient.tsx` | Rename file+component → `invite-participant.tsx`/`InviteParticipantScreen` (C3); optionally add per-connection relationship prompt (§12) | 6, 10 |
| `app/create-reminder.tsx` | Change default type away from `medication` (B5, batch 5); later, once F1 ships, adopt the new shared type module | 5, 11 |
| `app/edit-reminder.tsx` | Same as above; also de-duplicate `ReminderType`/`TYPE_ICON_NAMES`/`TYPE_LABEL_KEYS` into the new shared module | 5, 11 |
| `app/reminder-alert.tsx`, `app/reminder-details.tsx`, `app/recipient-dashboard.tsx` (icon maps only) | Adopt new shared type module once F1 ships; no change needed before then | 11 |
| `app/participants.tsx` | Reorder `emptyText` example list (B3, batch 1); later, per-connection `relationship_pair` editor row (fast-follow, not first batch) | 1 |
| `app/routine-library.tsx` | No code change — automatically benefits once `daily_care_routine` pack is rebranded (B4) and `education` use_case exists | 1, 7 |
| `components/settings-sheet.tsx` | No structural change; automatically picks up `education` (batch 2) and any internal-naming cleanup (C5, batch 10) | 2, 10 |
| All other screens (`activity.tsx`, `tasks.tsx`, `task-details.tsx`, `overdue-tasks.tsx`, `routine-details.tsx`, `routine-preview.tsx`, `my-connections.tsx`, `join-invite.tsx`, `notification-permission.tsx`, `create-item.tsx`, `create-task.tsx`, `edit-task.tsx`, auth screens) | **No change required** — confirmed already generic; only internal `caregiver_id`/`recipient_id` field references remain, unaffected by any batch in this plan except the route-name reference sweep (batch 10) where they call `router.push`/`replace` to a renamed route | 10 (reference sweep only) |

---

## 15. Notification transformation map

| Surface | Current | Change needed |
|---|---|---|
| `send-due-recipient-reminders` (reminder push) | `"Tavora reminder"` / generic body | None — already clean |
| `send-task-assignment-notifications` | `"Tavora task"` / generic body | None — already clean |
| `send-routine-assignment-notifications` | `"Tavora routine"` / echoes `instance.title` in detailed mode | None directly, but depends on B4 (routine pack rebrand) so a "Daily Care Routine"-titled push never appears by default |
| `send_pending_caregiver_push_notifications()` (organizer status-update push) | Payload `data.type = 'caregiver_reminder_event'` | RENAME NOW (C7) — coordinated client+DB change, dual-accept transition period required |
| `lib/notifications.ts` Android channel | id `'care-reminders'`, display name already `"Reminders"` | KEEP TEMPORARILY (D7) — no user-visible change, defer id rename |
| `app/_layout.tsx` push-tap router | Switches on `data.type === 'caregiver_reminder_event'` | Update alongside C7, with dual-accept fallback |
| `app/reminder-alert.tsx` in-app copy | Already fully `t('reminderAlert.*')`-keyed, already says "organizer" not "caregiver" everywhere checked | None |

No push notification, in either private or detailed preview mode, currently contains "caregiver," "Loved One," or any eldercare-specific language on any lock screen. This directly answers audit question 11 (§18): **no leak found**.

---

## 16. Template/routine transformation map

| Pack id | Action | New `recommendedUseCases` |
|---|---|---|
| `morning_routine` | Keep as-is | `['care','family','personal']` (unchanged) |
| `evening_routine` | Keep as-is | `['care','family','personal']` (unchanged) |
| `family_chores` | Keep as-is | `['family']` (unchanged) |
| `workout_accountability` | Keep as-is | `['coaching','personal']` (unchanged) |
| `study_routine` | Keep as-is; consider also recommending for new `education` category | `['coaching','personal','family','education']` (add `education`) |
| `dental_routine` | Keep as-is | `['care','family','personal']` (unchanged) |
| `daily_care_routine` | **Rewrite** (B4): rename id/title/description/item copy, broaden use cases | `['care','family','personal']` (unchanged set, just no longer the only thing driving the pack's identity) |
| `workday_checkin` | Keep as-is; consider also recommending for `education` (mentor/mentee check-ins fit this shape too) | `['team','coaching','personal','education']` (add `education`) |
| *(new, optional, not required for first batch)* `mentorship_checkin` or reuse `workday_checkin`/`study_routine` for mentor/mentee | Not required — existing packs already cover this content shape adequately per the "don't add unrelated features" constraint | — |

No new pack is strictly required to ship the repositioning — the existing 8 (7 unchanged + 1 rewritten) already cover every new relationship category's plausible daily-structure needs. Do not build category-specific pack forks (e.g. a separate "Coach Pack" vs "Trainer Pack") — `recommendedUseCases` filtering already achieves the desired personalization without content duplication.

---

## 17. Backend compatibility analysis

Confirmed safe, no risky changes required for the first batch:
- **Zero migrations required for batches 1–10** (terminology, onboarding, navigation, dashboards, create flows, connection flows, templates, notifications-copy, settings, internal names) — every item in those batches is a client/i18n/asset change or a pure application-layer rename.
- **Batch 11 (backend)** is limited to exactly two additive changes, both zero-data-risk:
  1. `profiles_use_case_check` widened to add `'education'` (§13, Tier 1).
  2. New nullable `connections.relationship_pair` column + its own `CHECK` constraint (§13, Tier 2), **excluding** the `'self'` value pending resolution of the blocking ambiguity below.
- Both are `ALTER TABLE ... ADD/DROP CONSTRAINT` and `ALTER TABLE ... ADD COLUMN` — no `UPDATE`, no backfill, no risk to the 36 live `profiles` / 13 live `connections` rows. Existing rows simply get `NULL` for the new column and keep their current (still-valid) `use_case` value.
- **No RLS policy needs to change** — both new/widened fields are display-only, exactly matching `use_case`'s existing, already-audited pattern of being invisible to every RLS predicate and RPC authorization check.
- **F1 (reminder-type taxonomy widening)** is deliberately placed in a later, separate structural-refactor pass (not the first implementation batch) since it touches a live, already-used-by-production-data `CHECK` constraint plus 2 RPC bodies plus a routine-item constraint — more surface than batch 11's two additions, and no part of the immediate repositioning story depends on it shipping first (the default-type fix, B5, ships independently and captures most of the user-visible benefit at near-zero risk).

---

## 18. Regression risks

| Risk | Mitigation |
|---|---|
| Route rename (C1/C2/C3) misses a hardcoded path string, causing a 404 | Grep for the literal old path string (`'/caregiver-dashboard'`, `'/recipient-dashboard'`, `'/invite-recipient'`) after each rename; zero remaining hits is the pass criterion. Run `scripts/onboarding-audit/run.ts` and `scripts/accessibility-audit/run.ts` (both assert on these routes/filenames today) after the rename — they will fail loudly on any missed reference, which is exactly their value here. |
| `caregiver_reminder_event` → `organizer_reminder_event` rename (C7) drops a notification mid-flight during rollout | Dual-accept both string values in `app/_layout.tsx` for at least one release before removing the old check. |
| Reordering `participants.emptyText` (B3) or rebranding `daily_care_routine` (B4) breaks an existing i18n-consistency audit assertion | `scripts/visual-consistency-audit/run.ts` already checks locale-file consistency structurally (key parity between en/es, no literal DB-field leakage) rather than pinning exact English wording for these two strings — confirmed no scenario asserts the literal current text of either key, so no test update is required, but re-run the suite after the change as a smoke check. |
| Widening `profiles_use_case_check` / adding `connections.relationship_pair` breaks a script that enumerates the old value set exhaustively | `lib/onboardingCore.ts`'s `USE_CASES` array and `isUseCase()` type guard are the single source of truth consumed everywhere (confirmed: no other file independently hardcodes the 6-value list) — updating that one array is sufficient; TypeScript's exhaustiveness checking on `ROLE_LABEL_KEYS_BY_USE_CASE`/`EXAMPLE_TITLE_KEY_BY_USE_CASE`/`USE_CASE_CARD_KEYS` (all typed `Record<UseCase, ...>`) will hard-fail the build if any of the three maps forgets to add the new `education` entry — this is a built-in regression guard, not something to add. |
| `ReminderType` widening (F1, later batch) ships a client value the not-yet-migrated DB constraint rejects | Sequence strictly: ship the DB migration (additive, backward-compatible) first, verify via `task-audit`/`reminder-audit` against the live linked project, only then ship the client change that offers the new values in the UI. Never the reverse order. |
| App-icon change (B6) | Treat as an explicit, separately-scheduled design task — do not fold into any mechanical batch; App Store/Play Store review and user re-recognition are real costs outside code-review scope. |
| `use_case`/`relationship_pair` additive migrations touch a table with live production rows | Both changes are additive-only (new allowed value, new nullable column) — verified zero existing rows are invalidated by either change (§17). Standard `supabase db push --linked` after confirming zero violating rows first (the same verification pattern already used for the `tasks_recurrence_end_recurring_only_check` fix earlier in this project). |

---

## 19. Ordered implementation plan

Per the brief's required order, with batch contents drawn from the classification above:

1. **Product terminology and copy** — B2 (Loved One → Family Member), B3 (participants.emptyText reorder), B5 (reminder-type default away from medication). Zero screens added/removed, zero navigation change, i18n + 2 one-line defaults only.
2. **Onboarding/use-case model** — add `education` to `USE_CASE_CARD_KEYS`/`onboardingExamples`/`ROLE_LABEL_KEYS_BY_USE_CASE` (`lib/onboardingCore.ts`), corresponding `useCase.education*` i18n keys, B1 (choose-role icon fix, depends on the use-case icon map already existing).
3. **Navigation/information architecture** — no changes required this pass (confirmed: no route needs adding/removing structurally); route *renames* are deliberately deferred to batch 10 to avoid touching navigation twice.
4. **Dashboard/Today/Activity presentation** — no changes required (confirmed already generic).
5. **Create flows** — B5 (reminder default type; already listed batch 1, cross-referenced here since it's also a create-flow change).
6. **Connection flows** — optional per-connection `relationship_pair` prompt in the invite flow (§12 item 3) — **only after** batch 11 ships the backend column; sequence this batch's UI-only prep (if any) before batch 11, but the functional prompt itself lands after.
7. **Templates/routines** — B4 (daily_care_routine rebrand), `recommendedUseCases` additions for `study_routine`/`workday_checkin` (§16).
8. **Notifications** — C7 (wire-value rename, coordinated client+DB, dual-accept transition).
9. **Settings/profile** — no code change required; automatically inherits batches 1–2's new constants.
10. **Internal application-layer names** — C1/C2/C3 (three route/component renames + full reference sweep), C4 (theme tokens), C5 (local variable/style renames), C6 (`recipientHasAcceptedConnection` rename).
11. **Backend/database structural changes** — the two additive migrations from §13/§17 (`use_case` widening, `connections.relationship_pair` column), each verified against zero-violating-rows before push, each confirmed via `task-audit`/`onboarding-audit`/`routine-audit` afterward. F1 (reminder-type taxonomy widening) is its own later, separate structural project — not bundled into this batch.
12. **Tests/audits/docs cleanup** — update `scripts/onboarding-audit/run.ts` and `scripts/accessibility-audit/run.ts`'s route-string assertions (batch 10 dependency), add new `visual-consistency-audit` scenarios asserting the new `education`/`relationship_pair` copy is present and consistent, update `docs/product-terminology.md` (add the `education` use case + `relationship_pair` table), `docs/onboarding-model.md` (add the new onboarding step), `docs/multiple-organizer-model.md`/`docs/participant-management-model.md` (note the per-connection relationship-label capability), `docs/reminder-analytics-model.md` (update its "caregiver-dashboard.tsx" file reference once renamed).

---

## Exact files expected to change in the first implementation batch (batches 1–2 only)

Scoped deliberately narrow — copy/onboarding-model only, zero navigation risk, zero backend migration, fully reversible via `git revert`:

1. `lib/i18n/locales/en.ts` — `chooseRole.careParticipantTitle`/`careParticipantDesc` (B2), `participants.emptyText` (B3), new `useCase.educationTitle`/`educationDesc` + `chooseRole.education*`(if a bespoke pair is added later, not required for batch 1-2) + `onboardingExamples.education` keys (batch 2).
2. `lib/i18n/locales/es.ts` — mirror of the above.
3. `lib/onboardingCore.ts` — add `'education'` to `UseCase`/`USE_CASES`; add corresponding entries to `USE_CASE_CARD_KEYS`, `EXAMPLE_TITLE_KEY_BY_USE_CASE` (TypeScript's `Record<UseCase, ...>` typing will fail the build if any map is left incomplete — this is the built-in safety net, not optional follow-up).
4. `app/choose-role.tsx` — B1 fix: read the use-case icon instead of the hardcoded `heart`/`caregiverLight`/`caregiverColor` (pairs with C4's token rename, which can ride in the same commit since it's a 2-line theme-file change with one consumer).
5. `constants/theme.tsx` (confirm exact file via `grep -rn caregiverLight constants/ lib/` before editing) — C4 token rename.
6. `app/create-reminder.tsx` — B5: default `ReminderType` state → `'other'`.
7. `app/edit-reminder.tsx` — same as above, only where it affects the *default* shown for a still-unset value (edit screen normally loads an existing value; confirm behavior before changing — do not change the load-existing-value path, only any code path that currently falls back to `'medication'` when a value is genuinely absent).
8. `lib/routineCatalog.ts` — B4: `daily_care_routine` → `daily_checkin_routine` id/keys, broadened `recommendedUseCases`.
9. `docs/product-terminology.md` — update the `use_case`/`chooseRole` reference tables to reflect the `education` addition and the `careParticipantTitle` copy change (keep this doc, per its own stated purpose, in sync in the same commit rather than letting it drift).

Everything else in this document (route renames, the `relationship_pair` migration, the reminder-type structural refactor, the app-icon redesign, notification wire-value rename) is scoped to later batches per §19 and should not be started until batch 1–2 is verified (tsc clean, lint clean, `onboarding-audit`/`visual-consistency-audit` green) — consistent with this audit's instruction to stop after producing the blueprint.

---

## Final report

**Files inspected**: ~180 (29 `app/*.tsx` screens read in full or targeted; 16 `components/*` files; ~20 `lib/*.ts` modules including both full i18n locale files; all 44 `supabase/migrations/*.sql`; all 8 `supabase/functions/*` edge functions + shared helpers; all 16 `scripts/*-audit` suites; all 38 `docs/*.md` files; `app.json`, `package.json`, `README.md`; plus live schema/constraint/row-count queries against the linked Supabase project for every claim where migration-file archaeology alone would have been reconstructive rather than authoritative).

**Legacy references found**: ~34 distinct classified items (several representing multi-file batches — e.g. the DELETE entry covers 9 files, the `caregiver_id`/`recipient_id` KEEP-TEMPORARILY entry covers ~10 tables and dozens of call sites). Zero matches anywhere for "Care Circle," "elder(ly)," "senior," "patient" (outside the new, intentional `provider_patient` relationship pair), "dependent," "HIPAA," or any structured medical-data field.

**A/B/C/D/E/F counts**:
- A (DELETE): 1 (9 files)
- B (REWRITE NOW): 6
- C (RENAME NOW): 7
- D (KEEP TEMPORARILY): 7
- E (KEEP): 10 (system-level groupings)
- F (NEEDS STRUCTURAL REFACTOR): 2

**Existing tests/checks consulted** (read, not executed as part of this audit — no code was changed): `scripts/visual-consistency-audit/run.ts` (confirmed already enforces the desired terminology end-state), `scripts/onboarding-audit/run.ts` and `scripts/accessibility-audit/run.ts` (confirmed they assert on the `/caregiver-dashboard` route/filename structurally, flagging them as required updates in batch 12), all other audit suites confirmed to contain zero caregiving-copy-specific assertions. `npx tsc --noEmit` / `npx expo lint` were **not** run this session since zero code was changed — nothing to validate yet; both are the first two checks to run once batch 1 lands.

**Blocking ambiguity discovered**: the new product spec's "Personal Accountability → Self" relationship pair has no architectural home today. `connections.connections_no_self_connection_check` structurally forbids a profile from connecting to itself (`recipient_id <> caregiver_id`), and there is no other mechanism (a connection-less reminder/task) anywhere in the schema. Two genuinely different products are possible under the label "Self" — (a) true single-user self-tracking with no second account, which is a real new feature requiring either relaxing that constraint or a parallel no-connection-required object type, or (b) "Self" is shorthand for "personal use with a trusted accountability partner," which is already fully supported today via the existing `accountability_partner` pair and needs no new capability at all. **Recommendation**: ship interpretation (b) in the first relationship-pair batch (§13 already excludes `'self'` from the initial CHECK constraint for exactly this reason) and treat true self-only mode as an explicit, separate product decision — do not silently build a workaround for it.

**Recommended first implementation batch**: §19's "batches 1–2" list — 9 files, i18n + 2 default-value fixes + 1 icon fix + 1 template rebrand + 1 doc update, zero navigation changes, zero database migrations, fully reversible.
