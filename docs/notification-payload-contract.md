# Tavora notification payload contract

What Tavora is allowed to put in a push notification's visible banner
(title/body) and in its `content.data` (routing payload), for every
notification type it sends. This is the enforceable contract behind the
`notification_preview_mode` privacy setting — every notification-producing
path (`send-due-recipient-reminders`, the caregiver push PL/pgSQL sender,
and the legacy local-scheduling path in `lib/notifications.ts`) must match
this table exactly. Examples below use placeholder values only — no real
UUIDs, names, or reminder content.

## Preview modes

- **private** (default for every account, new and existing): the banner
  never contains a reminder title, a person's name, or any other detail
  about what the reminder is or who it's about.
- **detailed** (opt-in, Settings → Notification Previews): the banner may
  contain a reminder title and, for caregiver updates, the connected
  participant's display name.

Both modes are equally minimal in `content.data` — the routing payload
never grows just because the banner is allowed to show more. A lock screen
that's covered (Show Previews off, or the phone locked) hides the banner
text regardless of mode; **detailed mode is not itself private on a locked
device** — it deliberately puts more content where the OS chooses to show
it.

---

## Recipient reminder (original occurrence)

Sent by `send-due-recipient-reminders`, or by the legacy local-scheduling
path in `lib/notifications.ts` for any recipient not yet migrated to
server-authoritative push.

| | Private (default) | Detailed |
|---|---|---|
| Title | `Tavora reminder` | The reminder's own title (e.g. `Evening walk`), or `Reminder` if the title is empty/null |
| Body | `You have a reminder waiting.` | `Time to respond to this reminder.` |

**Permitted `content.data` keys (both modes):**
```json
{
  "reminderId": "<uuid>",
  "occurrenceDate": "2026-01-15",
  "scheduledFor": "2026-01-15T21:00:00.000Z",
  "notificationType": "reminder"
}
```

**Prohibited in `content.data`, either mode:** reminder title, notes,
recipient name, caregiver name, email, connection details, push tokens,
`recipientId` (unused by any client code — dropped in this task's audit),
`reminderType` (unused by any client code — dropped in this task's audit).

The notification tap flow (`app/_layout.tsx` → `app/reminder-alert.tsx`)
only ever uses `reminderId` from the payload to fetch the current reminder
state fresh from Supabase before rendering anything — nothing else in
`content.data` is read by any screen.

---

## Recipient reminder (snoozed re-alert)

Sent by the same claim/send pipeline as above (`delivery_type = 'snooze'`),
or the legacy local path's `scheduleSnoozeNotification`.

| | Private (default) | Detailed |
|---|---|---|
| Title | `Tavora reminder` | The reminder's own title, or `Reminder` if empty/null |
| Body | `Your snoozed reminder is ready.` | `Snoozed reminder — time to respond.` |

**`content.data`:** identical shape to the original occurrence, with
`"notificationType": "snooze"`.

---

## Caregiver status update

Sent by `public.send_pending_caregiver_push_notifications()` (pg_cron,
every minute), for a recipient's missed/skipped/snoozed/taken response —
gated first by the caregiver's own `notification_preferences`
(`notify_missed`/`notify_skipped`/`notify_snoozed`/`notify_taken`; unrelated
to preview mode, controls whether an event is sent at all), then by
`notification_preview_mode` for content only.

| | Private (default) | Detailed |
|---|---|---|
| Title | `Tavora update` | `{participant name} {missed/skipped/snoozed/completed} a reminder` |
| Body | `There is a new reminder update.` | `{participant name} {missed/skipped/snoozed/completed} "{reminder title}".` |

**Permitted `content.data` keys (both modes):**
```json
{
  "type": "caregiver_reminder_event",
  "eventType": "missed",
  "reminderId": "<uuid>",
  "reminderLogId": "<uuid>"
}
```
`type` and `reminderId` are read by `app/_layout.tsx`'s tap router (routes
to the caregiver dashboard, not a detail screen — caregiver push never
opens a recipient's full-screen alert). `eventType`/`reminderLogId` are
carried for potential future routing use and contain no identifying detail
by themselves (a status word and a log-row id).

**Prohibited in `content.data`, either mode:** participant name, reminder
title, notes, email, push tokens.

The detailed-mode title/body strings are computed once, at write time, by
the `create_caregiver_notification_event()` trigger (unchanged by this
task) and stored in `caregiver_notification_events.title`/`.body`. The
sender function reads the caregiver's *current* `notification_preview_mode`
at send time and only uses those stored strings when the live value is
`detailed` — a mode change between an event being queued and actually sent
always takes effect on the copy that goes out.

---

## Failure and fallback behavior

- **Preference unreadable** (network/DB error, or the row can't be
  fetched): resolves to `private`. Never resolves to `detailed` on any
  error path — see `getPreviewMode()` in `send-due-recipient-reminders`,
  `getNotificationPreviewMode()` in `lib/notifications.ts`, and the
  `coalesce(p.notification_preview_mode, 'private')` join in the caregiver
  push sender.
- **No preference row**: cannot happen for an existing account —
  `profiles.notification_preview_mode` is `not null default 'private'`, so
  every profile row always has an explicit value. The fallback code above
  exists for the case where the *profile row itself* can't be joined
  (e.g. a race with account deletion), not a missing column value.
- **Empty/null reminder title in detailed mode**: falls back to the neutral
  string `Reminder` — never displays a raw empty string or a database null.

## What never appears in a push payload, in either mode

Email addresses, free-text notes, full Expo push tokens, any
diagnosis/medical-condition language generated by Tavora, or account
identifiers beyond the minimal routing UUIDs listed above.
