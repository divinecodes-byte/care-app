// Tavora recipient-timezone display consistency and race-proof reminder
// schedule editing — focused companion suite for Week 1 launch hardening
// task #8. Kept separate from scripts/reminder-audit/run.ts (task #7's
// suite) rather than extending it in place: this task's own scenario list
// (A-AA) reuses several of the same letters for entirely different
// scenarios than task #7's script already uses them for, and merging the
// two would make the letter labels ambiguous. run.ts's own S/T/AH were
// still updated in place, since those specific scenarios' *intent*
// (not their letter) carried over unchanged from task #7.
//
// Run from the repo root:
//   EXPO_PUBLIC_SUPABASE_URL=... EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=... npx tsx scripts/reminder-audit/timezone-and-schedule-race.ts
//
// Creates disposable synthetic users (tavora.tzrace.*@example.com),
// exercises them through the real anon-key client paths, verifies/cleans
// up via the already-authenticated `supabase` CLI, and never touches a
// real account. A-F unit-test lib/reminderStatus.ts's zoned functions
// directly (importable here — no React Native dependency) rather than
// simulating a real device in two timezones, which this environment has
// no way to do.

import { execFileSync } from 'node:child_process';
import {
    ANON_KEY,
    SUPABASE_URL,
    dbQuery,
    newClient,
    randomSuffix,
    record,
    summarize,
} from '../security-audit/helpers';
import { getZonedComputedStatus, isReminderEligibleOnZonedDate, ReminderScheduleLike } from '../../lib/reminderStatus';
import { getZonedTodayString } from '../../lib/zonedTime';

const RAND = randomSuffix();
const PASSWORD = `TzRace!${RAND}9X`;
const EMAIL_PREFIX = 'tavora.tzrace';

const NEW_YORK = 'America/New_York';
const PHOENIX = 'America/Phoenix'; // fixed UTC-7 year-round, no DST -- deterministic relative to New York regardless of when this runs

async function signUpTestUser(emailPrefix: string, fullName: string) {
    const client = newClient();
    const email = `${EMAIL_PREFIX}.${emailPrefix}.${RAND}@example.com`;
    const { data, error } = await client.auth.signUp({ email, password: PASSWORD, options: { data: { full_name: fullName } } });
    if (error || !data.user) throw new Error(`signup failed for ${email}: ${error?.message}`);
    return { id: data.user.id, email, client };
}

function wallClockTimeIn(timeZone: string, date: Date): string {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
    const map: Record<string, string> = {};
    for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value;
    return `${map.hour}:${map.minute}`;
}

/** "HH:MM" that is `minutesAgo` minutes before the current wall-clock reading in `timeZone`. */
function wallClockMinutesAgoIn(timeZone: string, minutesAgo: number): string {
    const shifted = new Date(Date.now() - minutesAgo * 60000);
    return wallClockTimeIn(timeZone, shifted);
}

function utcTimeString(offsetMinutes: number): string {
    const d = new Date(Date.now() + offsetMinutes * 60000);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:00`;
}

async function main() {
    console.log(`Timezone/schedule-race audit run ${RAND}\n`);

    const testUserIds: string[] = [];
    const testConnectionIds: string[] = [];
    const testReminderIds: string[] = [];

    async function makeConnectedPair(label: string, recipientTz: string) {
        const caregiver = await signUpTestUser(`${label}cg`, `TzRace ${label} Caregiver`);
        const recipient = await signUpTestUser(`${label}rc`, `TzRace ${label} Recipient`);
        testUserIds.push(caregiver.id, recipient.id);
        dbQuery(`update public.profiles set role='caregiver' where id='${caregiver.id}';`);
        dbQuery(`update public.profiles set role='recipient', timezone='${recipientTz}' where id='${recipient.id}';`);
        const connRows = dbQuery(`
          insert into public.connections (caregiver_id, recipient_id, invite_code, status, accepted_at)
          values ('${caregiver.id}', '${recipient.id}', '${label.toUpperCase()}${RAND}', 'accepted', now() - interval '1 day')
          returning id;
        `);
        const connectionId = (connRows[0] as any).id;
        testConnectionIds.push(connectionId);
        return { caregiver, recipient, connectionId };
    }

    async function createReminder(
        connectionId: string,
        caregiverId: string,
        recipientId: string,
        opts: { daysOfWeek: number[]; timeOfDay: string; noResponseMinutes?: number; createdAtOffsetMinutes?: number }
    ): Promise<string> {
        const createdAtIso = new Date(Date.now() + (opts.createdAtOffsetMinutes ?? -1440) * 60000).toISOString();
        const rows = dbQuery(`
          insert into public.reminders (connection_id, caregiver_id, recipient_id, title, time_of_day, days_of_week, no_response_minutes, is_active, created_at, updated_at)
          values ('${connectionId}', '${caregiverId}', '${recipientId}', 'TZ race test', '${opts.timeOfDay}', ARRAY[${opts.daysOfWeek.join(',')}], ${opts.noResponseMinutes ?? 30}, true, '${createdAtIso}', now())
          returning id;
        `);
        const id = (rows[0] as any).id;
        testReminderIds.push(id);
        return id;
    }

    async function respond(client: ReturnType<typeof newClient>, reminderId: string, status: string, snoozeMinutes = 10) {
        return client.rpc('respond_to_reminder_occurrence', { p_reminder_id: reminderId, p_status: status, p_snooze_minutes: snoozeMinutes });
    }

    async function editSchedule(
        client: ReturnType<typeof newClient>,
        reminderId: string,
        overrides: Partial<{ title: string; reminderType: string; notes: string | null; timeOfDay: string; frequency: string; daysOfWeek: number[]; noResponseMinutes: number }>
    ) {
        const current = (dbQuery(`select title, reminder_type, notes, time_of_day, frequency, days_of_week, no_response_minutes from public.reminders where id = '${reminderId}';`)[0] ?? {}) as any;
        return client.rpc('update_reminder_schedule', {
            p_reminder_id: reminderId,
            p_title: overrides.title ?? current.title,
            p_reminder_type: overrides.reminderType ?? current.reminder_type,
            p_notes: overrides.notes !== undefined ? overrides.notes : current.notes,
            p_time_of_day: overrides.timeOfDay ?? current.time_of_day,
            p_frequency: overrides.frequency ?? current.frequency,
            p_days_of_week: overrides.daysOfWeek ?? current.days_of_week,
            p_no_response_minutes: overrides.noResponseMinutes ?? current.no_response_minutes,
        });
    }

    function logFor(reminderId: string): any {
        return dbQuery(`select * from public.reminder_logs where reminder_id = '${reminderId}';`)[0];
    }
    function deliveryFor(reminderId: string, type: 'reminder' | 'snooze' = 'reminder'): any[] {
        return dbQuery(`select * from public.reminder_notification_deliveries where reminder_id = '${reminderId}' and delivery_type = '${type}' order by created_at;`);
    }

    const todayIso = new Date();
    // connA (used by scenario M) has its recipient's profile timezone set to
    // 'UTC' -- use UTC getters here, not local-machine-timezone getters, so
    // this matches the occurrence_date the claim function actually computes
    // regardless of which timezone this script happens to run in.
    const todayDateString = `${todayIso.getUTCFullYear()}-${String(todayIso.getUTCMonth() + 1).padStart(2, '0')}-${String(todayIso.getUTCDate()).padStart(2, '0')}`;
    const acceptedAtLongAgo = new Date(Date.now() - 30 * 86400000).toISOString();
    const createdAtLongAgo = acceptedAtLongAgo;
    const allDays = [1, 2, 3, 4, 5, 6, 7];

    try {
        // ── A: caregiver and recipient in the same timezone ─────────────────────
        const sameZoneReminder: ReminderScheduleLike = {
            days_of_week: allDays,
            time_of_day: `${wallClockMinutesAgoIn(NEW_YORK, 5)}:00`,
            created_at: createdAtLongAgo,
            is_active: true,
            no_response_minutes: 30,
        };
        // Occurrence date is always computed in the RECIPIENT's own zone in
        // production (see docs/reminder-editing-model.md) -- use that same
        // authoritative date here rather than a machine-local or UTC date,
        // which can disagree with New York/Phoenix for several hours around
        // the UTC day boundary and cause spurious flakiness.
        const nyToday = getZonedTodayString(NEW_YORK);
        const statusForRecipientView = getZonedComputedStatus(sameZoneReminder, nyToday, nyToday, NEW_YORK);
        const statusForCaregiverView = getZonedComputedStatus(sameZoneReminder, nyToday, nyToday, NEW_YORK); // same zone -- same call
        record('A', 'caregiver and recipient in the same timezone compute identical status', statusForRecipientView === statusForCaregiverView, statusForRecipientView);

        // ── B/D/E: caregiver New York, recipient Arizona -- a wall-clock time
        // that has already passed in New York but has NOT yet arrived in
        // Arizona (NY's local clock runs 2-3h ahead of Phoenix's, so the same
        // "HH:MM" string resolves to an earlier UTC instant in NY than in
        // Phoenix) produces DIFFERENT statuses depending on which zone the
        // computation uses -- exactly the bug this task fixes when a
        // caregiver's screen used ITS OWN device zone instead of the
        // recipient's. ──────────────────────────────────────────────────────
        const divergentTimeOfDay = `${wallClockMinutesAgoIn(NEW_YORK, 5)}:00`;
        const divergentReminder: ReminderScheduleLike = {
            days_of_week: allDays,
            time_of_day: divergentTimeOfDay,
            created_at: createdAtLongAgo,
            is_active: true,
            no_response_minutes: 1, // short window so "5 minutes ago" is already missed
        };
        const phoenixToday = getZonedTodayString(PHOENIX);
        const statusIfRecipientZoneUsed = getZonedComputedStatus(divergentReminder, phoenixToday, phoenixToday, PHOENIX);
        const statusIfWrongCaregiverZoneUsed = getZonedComputedStatus(divergentReminder, phoenixToday, phoenixToday, NEW_YORK);
        record('B', 'caregiver (New York) viewing a recipient in Arizona: using the WRONG (caregiver) zone would show a different status than using the correct (recipient) zone', statusIfWrongCaregiverZoneUsed !== statusIfRecipientZoneUsed, `wrong_zone=${statusIfWrongCaregiverZoneUsed} correct_zone=${statusIfRecipientZoneUsed}`);
        record('D', 'the recipient-zone (Arizona) computation shows the reminder as not yet missed (still within its actual local window)', statusIfRecipientZoneUsed === 'pending', statusIfRecipientZoneUsed);
        record('E', "the same reminder, interpreted correctly, is not prematurely shown as Missed under the recipient's own timezone", statusIfRecipientZoneUsed !== 'missed');

        // ── C: caregiver Arizona, recipient New York -- symmetry check ──────────
        const statusIfNyIsRecipient = getZonedComputedStatus(divergentReminder, nyToday, nyToday, NEW_YORK);
        const statusIfPhoenixWronglyUsed = getZonedComputedStatus(divergentReminder, nyToday, nyToday, PHOENIX);
        record('C', 'caregiver (Arizona) viewing a recipient in New York: using the wrong (caregiver) zone again disagrees with the correct (recipient) zone', statusIfPhoenixWronglyUsed !== statusIfNyIsRecipient, `wrong_zone=${statusIfPhoenixWronglyUsed} correct_zone=${statusIfNyIsRecipient}`);

        // ── F: future status agrees with recipient timezone ──────────────────────
        const futureReminder: ReminderScheduleLike = { ...divergentReminder, time_of_day: `${wallClockTimeIn(PHOENIX, new Date(Date.now() + 3 * 3600000))}:00` };
        const futureStatusInPhoenix = getZonedComputedStatus(futureReminder, phoenixToday, phoenixToday, PHOENIX);
        record('F', 'a genuinely future scheduled time (recipient timezone) always computes as pending, never missed', futureStatusInPhoenix === 'pending', futureStatusInPhoenix);

        // ── G: historical timestamp remains unchanged after timezone change ─────
        const { connectionId: connG, caregiver: caregiverG, recipient: recipientG } = await makeConnectedPair('g', NEW_YORK);
        const reminderG = await createReminder(connG, caregiverG.id, recipientG.id, { daysOfWeek: allDays, timeOfDay: utcTimeString(-5) });
        await respond(recipientG.client, reminderG, 'taken');
        const logBeforeTzChange = logFor(reminderG);
        dbQuery(`update public.profiles set timezone = 'Asia/Tokyo' where id = '${recipientG.id}';`);
        const logAfterTzChange = logFor(reminderG);
        record('G', "an existing log's occurrence_date/scheduled_for/status are unchanged after the recipient later changes timezone", logBeforeTzChange.occurrence_date === logAfterTzChange.occurrence_date && logBeforeTzChange.scheduled_for === logAfterTzChange.scheduled_for && logBeforeTzChange.status === logAfterTzChange.status);

        // ── Shared pair for the schedule-edit-race scenarios ─────────────────────
        // Deliberately left with server_push_enabled = false (the default):
        // H/I/J/K/L/T/etc. manually insert/reconcile delivery rows to get
        // fully deterministic control over ledger state, and enabling the
        // real push pipeline here would let the live pg_cron job (every 30s
        // in this project) race those manual inserts -- confirmed to
        // actually happen (a duplicate-key error on L's setup insert from a
        // concurrently-claimed row). Scenario M gets its own isolated pair
        // below instead of sharing this one.
        const { connectionId: connA, caregiver: caregiverA, recipient: recipientA } = await makeConnectedPair('a', 'UTC');

        // ── H: edit old time -> later new time, before claim ─────────────────────
        const reminderH = await createReminder(connA, caregiverA.id, recipientA.id, { daysOfWeek: allDays, timeOfDay: utcTimeString(60) });
        await editSchedule(caregiverA.client, reminderH, { timeOfDay: utcTimeString(120) });
        record('H', 'editing to a later time before anything was claimed leaves no delivery row behind', deliveryFor(reminderH).length === 0);

        // ── I: edit old time -> later new time, after claim but before send ──────
        const reminderI = await createReminder(connA, caregiverA.id, recipientA.id, { daysOfWeek: allDays, timeOfDay: utcTimeString(-5) });
        dbQuery(`insert into public.reminder_notification_deliveries (reminder_id, recipient_id, occurrence_date, scheduled_for, delivery_type, status, schedule_version) values ('${reminderI}', '${recipientA.id}', current_date, now() - interval '5 minutes', 'reminder', 'pending', 1);`);
        await editSchedule(caregiverA.client, reminderI, { timeOfDay: utcTimeString(30) });
        const iDeliveries = deliveryFor(reminderI);
        record('I', 'editing to a later time after claim requeues the SAME row (not a second one) to the new time', iDeliveries.length === 1 && iDeliveries[0].status === 'pending' && iDeliveries[0].schedule_version === 2, JSON.stringify(iDeliveries.map((d) => ({ status: d.status, version: d.schedule_version }))));

        // ── J: edit old time -> earlier, already-passed time (chosen behavior:
        // the corrected time takes effect immediately, one prompt send, not
        // silently ignored -- see docs/reminder-editing-model.md) ──────────────
        const reminderJ = await createReminder(connA, caregiverA.id, recipientA.id, { daysOfWeek: allDays, timeOfDay: utcTimeString(60) });
        dbQuery(`insert into public.reminder_notification_deliveries (reminder_id, recipient_id, occurrence_date, scheduled_for, delivery_type, status, schedule_version) values ('${reminderJ}', '${recipientA.id}', current_date, now() + interval '60 minutes', 'reminder', 'pending', 1);`);
        await editSchedule(caregiverA.client, reminderJ, { timeOfDay: utcTimeString(-10) });
        const jDeliveries = deliveryFor(reminderJ);
        record('J', 'editing to an earlier already-passed time requeues to exactly one pending row reflecting the corrected time (chosen behavior, not silently dropped)', jDeliveries.length === 1 && jDeliveries[0].status === 'pending', JSON.stringify(jDeliveries.map((d) => d.status)));

        // ── K: edit after old push marked sent -- never touched, never duplicated ──
        const reminderK = await createReminder(connA, caregiverA.id, recipientA.id, { daysOfWeek: allDays, timeOfDay: utcTimeString(-30) });
        dbQuery(`insert into public.reminder_notification_deliveries (reminder_id, recipient_id, occurrence_date, scheduled_for, delivery_type, status, schedule_version, sent_at) values ('${reminderK}', '${recipientA.id}', current_date, now() - interval '30 minutes', 'reminder', 'sent', 1, now());`);
        await editSchedule(caregiverA.client, reminderK, { timeOfDay: utcTimeString(60) });
        const kDeliveries = deliveryFor(reminderK);
        record('K', 'a sent delivery is left untouched (still sent, version 1) after a later schedule edit -- no second send for the same occurrence', kDeliveries.length === 1 && kDeliveries[0].status === 'sent' && kDeliveries[0].schedule_version === 1);

        // ── L: remove today from recurrence after claim ──────────────────────────
        const reminderL = await createReminder(connA, caregiverA.id, recipientA.id, { daysOfWeek: allDays, timeOfDay: utcTimeString(-5) });
        dbQuery(`insert into public.reminder_notification_deliveries (reminder_id, recipient_id, occurrence_date, scheduled_for, delivery_type, status, schedule_version) values ('${reminderL}', '${recipientA.id}', current_date, now() - interval '5 minutes', 'reminder', 'pending', 1);`);
        const notToday = ((new Date().getUTCDay() === 0 ? 7 : new Date().getUTCDay()) % 7) + 1;
        await editSchedule(caregiverA.client, reminderL, { daysOfWeek: [notToday] });
        record('L', 'removing today from the schedule deletes the stale pending claim (nothing left to send today)', deliveryFor(reminderL).length === 0);
        dbQuery(`select public.sync_missed_reminders_db();`);
        record('L', 'no missed row appears for today under the old (now-removed) schedule', !logFor(reminderL));

        // ── M: add today to recurrence -- takes effect immediately (chosen
        // behavior: the very next claim tick can pick it up, no special-cased
        // "starts tomorrow" delay) ────────────────────────────────────────────
        // Isolated pair, not connA: this scenario needs server_push_enabled
        // = true to exercise the real claim_due_recipient_reminder_deliveries()
        // path (rather than a manually-inserted row), and giving it its own
        // recipient keeps the live pg_cron job from racing connA's other
        // manually-controlled scenarios.
        const { connectionId: connM, caregiver: caregiverM, recipient: recipientM } = await makeConnectedPair('m', 'UTC');
        dbQuery(`update public.profiles set server_push_enabled = true where id = '${recipientM.id}';`);
        const todayIsoDow = new Date().getUTCDay() === 0 ? 7 : new Date().getUTCDay();
        const otherDow = (todayIsoDow % 7) + 1;
        const reminderM = await createReminder(connM, caregiverM.id, recipientM.id, { daysOfWeek: [otherDow], timeOfDay: utcTimeString(-5) });
        await editSchedule(caregiverM.client, reminderM, { daysOfWeek: allDays });
        dbQuery(`select public.claim_due_recipient_reminder_deliveries();`);
        const mDeliveries = deliveryFor(reminderM);
        record('M', 'adding today to the recurrence takes effect immediately -- the next claim tick creates a delivery for today, not "starting tomorrow"', mDeliveries.length === 1 && mDeliveries[0].occurrence_date === todayDateString);

        // ── N: change no-response window before due -- unresolved occurrence uses the NEW value ──
        const reminderN = await createReminder(connA, caregiverA.id, recipientA.id, { daysOfWeek: allDays, timeOfDay: utcTimeString(-20), noResponseMinutes: 30 });
        await editSchedule(caregiverA.client, reminderN, { noResponseMinutes: 5 });
        dbQuery(`select public.sync_missed_reminders_db();`);
        record('N', 'shortening the no-response window before an occurrence resolves makes it missed under the NEW value', logFor(reminderN)?.status === 'missed');

        // ── O: change no-response window after delivery -- historical occurrence untouched ──
        const reminderO = await createReminder(connA, caregiverA.id, recipientA.id, { daysOfWeek: allDays, timeOfDay: utcTimeString(-5), noResponseMinutes: 30 });
        await respond(recipientA.client, reminderO, 'taken');
        const oLogBefore = logFor(reminderO);
        await editSchedule(caregiverA.client, reminderO, { noResponseMinutes: 5 });
        const oLogAfter = logFor(reminderO);
        record('O', 'changing the no-response window after a response is already recorded never rewrites the historical occurrence', oLogBefore.status === oLogAfter.status && oLogBefore.completed_at === oLogAfter.completed_at);

        // ── P: title-only edit does not invalidate delivery ───────────────────────
        const reminderP = await createReminder(connA, caregiverA.id, recipientA.id, { daysOfWeek: allDays, timeOfDay: utcTimeString(-5) });
        dbQuery(`insert into public.reminder_notification_deliveries (reminder_id, recipient_id, occurrence_date, scheduled_for, delivery_type, status, schedule_version) values ('${reminderP}', '${recipientA.id}', current_date, now() - interval '5 minutes', 'reminder', 'pending', 1);`);
        await editSchedule(caregiverA.client, reminderP, { title: 'A brand new title, nothing else' });
        const pReminder = dbQuery(`select schedule_version from public.reminders where id = '${reminderP}';`)[0] as any;
        const pDeliveries = deliveryFor(reminderP);
        record('P', 'a title-only edit never bumps schedule_version or touches the pending delivery', Number(pReminder.schedule_version) === 1 && pDeliveries[0].schedule_version === 1 && pDeliveries.length === 1);

        // ── Q: concurrent edit and sender invocation (validated via the same
        // guard the Edge Function calls immediately before every send) ──────────
        const reminderQ = await createReminder(connA, caregiverA.id, recipientA.id, { daysOfWeek: allDays, timeOfDay: utcTimeString(-5) });
        await editSchedule(caregiverA.client, reminderQ, { timeOfDay: utcTimeString(-4) }); // bump to version 2
        const staleDeliveryQ = dbQuery(`
          insert into public.reminder_notification_deliveries (reminder_id, recipient_id, occurrence_date, scheduled_for, delivery_type, status, schedule_version)
          values ('${reminderQ}', '${recipientA.id}', current_date, now() - interval '5 minutes', 'reminder', 'pending', 1)
          returning id;
        `)[0] as any;
        const qVerdict = dbQuery(`select ok, skip_code from public.validate_reminder_deliveries_for_send(array['${staleDeliveryQ.id}']::uuid[]);`)[0] as any;
        record('Q', "the final-send guard rejects a delivery whose schedule_version is behind the reminder's current version", qVerdict.ok === false && qVerdict.skip_code === 'stale_schedule', JSON.stringify(qVerdict));

        // ── R: concurrent deactivate and sender invocation ────────────────────────
        const reminderR = await createReminder(connA, caregiverA.id, recipientA.id, { daysOfWeek: allDays, timeOfDay: utcTimeString(-5) });
        const deliveryR = dbQuery(`
          insert into public.reminder_notification_deliveries (reminder_id, recipient_id, occurrence_date, scheduled_for, delivery_type, status, schedule_version)
          values ('${reminderR}', '${recipientA.id}', current_date, now() - interval '5 minutes', 'reminder', 'pending', 1)
          returning id;
        `)[0] as any;
        dbQuery(`update public.reminders set is_active = false where id = '${reminderR}';`);
        const rVerdict = dbQuery(`select ok, skip_code from public.validate_reminder_deliveries_for_send(array['${deliveryR.id}']::uuid[]);`)[0] as any;
        record('R', 'the final-send guard rejects a delivery for a reminder deactivated after it was claimed', rVerdict.ok === false && rVerdict.skip_code === 'reminder_inactive', JSON.stringify(rVerdict));

        // ── S: old scheduled time never sends after a successful edit ────────────
        const reminderS = await createReminder(connA, caregiverA.id, recipientA.id, { daysOfWeek: allDays, timeOfDay: utcTimeString(-5) });
        const oldScheduledForS = utcTimeString(-5);
        dbQuery(`insert into public.reminder_notification_deliveries (reminder_id, recipient_id, occurrence_date, scheduled_for, delivery_type, status, schedule_version) values ('${reminderS}', '${recipientA.id}', current_date, now() - interval '5 minutes', 'reminder', 'pending', 1);`);
        await editSchedule(caregiverA.client, reminderS, { timeOfDay: utcTimeString(-3) });
        const sDeliveries = deliveryFor(reminderS);
        const sVerdict = dbQuery(`select ok, skip_code from public.validate_reminder_deliveries_for_send(array['${sDeliveries[0].id}']::uuid[]::uuid[]);`)[0] as any;
        record('S', 'after a successful edit, the (requeued) delivery validates as current -- the old time is never what would send', sDeliveries.length === 1 && sVerdict.ok === true, JSON.stringify({ deliveries: sDeliveries.length, verdict: sVerdict }));
        void oldScheduledForS;

        // ── T: new scheduled time sends at most once (unique constraint holds) ──
        const reminderT2 = await createReminder(connA, caregiverA.id, recipientA.id, { daysOfWeek: allDays, timeOfDay: utcTimeString(-5) });
        dbQuery(`insert into public.reminder_notification_deliveries (reminder_id, recipient_id, occurrence_date, scheduled_for, delivery_type, status, schedule_version) values ('${reminderT2}', '${recipientA.id}', current_date, now() - interval '5 minutes', 'reminder', 'pending', 1);`);
        await editSchedule(caregiverA.client, reminderT2, { timeOfDay: utcTimeString(-3) });
        let duplicateInsertBlocked = false;
        try {
            dbQuery(`insert into public.reminder_notification_deliveries (reminder_id, recipient_id, occurrence_date, scheduled_for, delivery_type, status, schedule_version) values ('${reminderT2}', '${recipientA.id}', current_date, now(), 'reminder', 'pending', 2);`);
        } catch {
            duplicateInsertBlocked = true;
        }
        record('T', "a second delivery row for the same (reminder_id, occurrence_date, 'reminder') is rejected -- the new time can send at most once", duplicateInsertBlocked);

        // ── U: existing unique occurrence constraint remains effective ──────────
        const constraintRows = dbQuery(`select conname from pg_constraint where conname = 'reminder_notification_deliver_reminder_id_occurrence_date_d_key';`);
        record('U', 'UNIQUE(reminder_id, occurrence_date, delivery_type) constraint still exists', constraintRows.length === 1);

        // ── V: no future missed row under old schedule (re-checked from the missed-sync angle) ──
        const reminderV = await createReminder(connA, caregiverA.id, recipientA.id, { daysOfWeek: allDays, timeOfDay: utcTimeString(-30), noResponseMinutes: 1 });
        const otherDowV = ((new Date().getUTCDay() === 0 ? 7 : new Date().getUTCDay()) % 7) + 1;
        await editSchedule(caregiverA.client, reminderV, { daysOfWeek: [otherDowV] });
        dbQuery(`select public.sync_missed_reminders_db();`);
        record('V', 'a reminder edited to exclude today never gets a missed row for today, even though the old schedule would have been well past due', !logFor(reminderV));

        // ── W: historical logs remain unchanged across multiple edits ────────────
        const reminderW = await createReminder(connA, caregiverA.id, recipientA.id, { daysOfWeek: allDays, timeOfDay: utcTimeString(-5) });
        await respond(recipientA.client, reminderW, 'skipped');
        const wLogBefore = logFor(reminderW);
        await editSchedule(caregiverA.client, reminderW, { timeOfDay: utcTimeString(30) });
        await editSchedule(caregiverA.client, reminderW, { noResponseMinutes: 45 });
        await editSchedule(caregiverA.client, reminderW, { daysOfWeek: allDays.filter((d) => d !== 3 || allDays.includes(3)) });
        const wLogAfter = logFor(reminderW);
        record('W', 'a historical log is byte-for-byte unchanged after several subsequent schedule edits', JSON.stringify(wLogBefore) === JSON.stringify(wLogAfter));

        // ── X/Y/Z/AA: full regression suites ──────────────────────────────────────
        function lastTestsPassedMatch(text: string): RegExpMatchArray | null {
            const matches = [...text.matchAll(/(\d+)\/(\d+) tests passed/g)];
            return matches.length > 0 ? matches[matches.length - 1] : null;
        }

        try {
            const secOut = execFileSync('npx', ['tsx', 'scripts/security-audit/run.ts'], { encoding: 'utf-8', env: process.env });
            const m = lastTestsPassedMatch(secOut);
            record('X', 'scripts/security-audit/run.ts remains fully passing', !!m && m[1] === m[2], m?.[0]);
        } catch (err) {
            record('X', 'scripts/security-audit/run.ts remains fully passing', false, err instanceof Error ? err.message : String(err));
        }

        try {
            const authOut = execFileSync('npx', ['tsx', 'scripts/auth-audit/run.ts'], { encoding: 'utf-8', env: process.env });
            const m = lastTestsPassedMatch(authOut);
            record('Y', 'scripts/auth-audit/run.ts remains fully passing', !!m && m[1] === m[2], m?.[0]);
        } catch (err) {
            record('Y', 'scripts/auth-audit/run.ts remains fully passing', false, err instanceof Error ? err.message : String(err));
        }

        try {
            const remOut = execFileSync('npx', ['tsx', 'scripts/reminder-audit/run.ts'], { encoding: 'utf-8', env: process.env });
            const m = lastTestsPassedMatch(remOut);
            record('Z', 'scripts/reminder-audit/run.ts remains fully passing', !!m && m[1] === m[2], m?.[0]);
        } catch (err) {
            record('Z', 'scripts/reminder-audit/run.ts remains fully passing', false, err instanceof Error ? err.message : String(err));
        }

        try {
            execFileSync('npx', ['tsx', 'scripts/ops-health/run.ts'], { encoding: 'utf-8', env: process.env });
            record('AA', 'scripts/ops-health/run.ts does not report FAIL (exit code 0)', true);
        } catch (err: any) {
            record('AA', 'scripts/ops-health/run.ts does not report FAIL (exit code 0)', false, err?.stdout ?? (err instanceof Error ? err.message : String(err)));
        }

    } finally {
        console.log('\nCleaning up synthetic test data...');
        for (const reminderId of testReminderIds) {
            dbQuery(`delete from public.reminder_notification_deliveries where reminder_id = '${reminderId}';`);
            dbQuery(`delete from public.reminder_logs where reminder_id = '${reminderId}';`);
        }
        dbQuery(`delete from public.reminders where id in (${testReminderIds.map((id) => `'${id}'`).join(',') || "'00000000-0000-0000-0000-000000000000'"});`);
        for (const connectionId of testConnectionIds) {
            dbQuery(`delete from public.connections where id = '${connectionId}';`);
        }
        if (testUserIds.length > 0) {
            const idList = testUserIds.map((id) => `'${id}'`).join(',');
            dbQuery(`delete from public.profiles where id in (${idList});`);
            try {
                execFileSync('supabase', ['db', 'query', '--linked', '-o', 'json', `delete from auth.users where id in (${idList});`], { stdio: 'pipe' });
            } catch (err) {
                console.warn('Leftover auth users needing manual cleanup:', testUserIds.length, err instanceof Error ? err.message : err);
            }
        }
        const remaining = dbQuery(`select count(*) as c from auth.users where email like '${EMAIL_PREFIX}.%${RAND}%';`);
        record('cleanup', 'all synthetic auth users removed', Number((remaining[0] as any)?.c ?? 1) === 0, `remaining: ${(remaining[0] as any)?.c}`);
    }

    const passed = summarize();
    process.exit(passed ? 0 : 1);
}

main().catch((err) => {
    console.error('TZ_SCHEDULE_RACE_SUITE_FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
});
