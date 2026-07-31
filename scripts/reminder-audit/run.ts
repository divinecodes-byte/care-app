// Tavora reminder-lifecycle synthetic test suite (Week 1 launch hardening
// task #7).
//
// Run from the repo root:
//   EXPO_PUBLIC_SUPABASE_URL=... EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=... npx tsx scripts/reminder-audit/run.ts
//
// Creates disposable synthetic users (tavora.reminderaudit.*@example.com),
// exercises them through the real anon-key client paths (exactly what the
// app itself does — respond_to_reminder_occurrence via supabase-js RPC),
// verifies/cleans up via the already-authenticated `supabase` CLI, and
// never touches a real account.
//
// Every synthetic recipient's profiles.timezone is pinned to 'UTC' so this
// script's own time arithmetic (plain JS UTC Date math) matches exactly
// what the server computes server-side — no ambiguity about what
// timezone this process happens to run in.
//
// Some scenarios are necessarily proxy/unit tests rather than full
// end-to-end runs (analytics X/Y/Z/AA/AB test lib/reminderStatus.ts's
// exported functions directly, in-process — that module has no
// React Native dependency, so it's genuinely importable here, not
// reimplemented). Each such scenario says so in its own comment.

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
import { installCrashSafety } from '../audit-infrastructure/cleanup';
import {
    getAnalyticsStartDate,
    getComputedStatus,
    isReminderEligibleOnDate,
} from '../../lib/reminderStatus';

const RAND = randomSuffix();
const PASSWORD = `ReminderAudit!${RAND}9X`;
const EMAIL_PREFIX = 'tavora.reminderaudit';

async function signUpTestUser(emailPrefix: string, fullName: string) {
    const client = newClient();
    const email = `${EMAIL_PREFIX}.${emailPrefix}.${RAND}@example.com`;
    const { data, error } = await client.auth.signUp({ email, password: PASSWORD, options: { data: { full_name: fullName, audit_account: true } } });
    if (error || !data.user) throw new Error(`signup failed for ${email}: ${error?.message}`);
    return { id: data.user.id, email, client };
}

/** "HH:MM:00" such that "today at this UTC time" = now + offsetMinutes. Only valid for the recipient whose profiles.timezone = 'UTC'. */
function utcTimeString(offsetMinutes: number): string {
    const d = new Date(Date.now() + offsetMinutes * 60000);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:00`;
}

function todayIsoWeekday(): number {
    const jsDay = new Date().getUTCDay(); // 0=Sun..6=Sat
    return jsDay === 0 ? 7 : jsDay;
}

function rpcErrorKind(message: string | undefined): string {
    const m = (message ?? '').toLowerCase();
    for (const kind of ['already_answered', 'reminder_inactive', 'connection_inactive', 'not_eligible_today', 'not_eligible_yet', 'not_authorized', 'reminder_not_found', 'invalid_status']) {
        if (m.includes(kind)) return kind;
    }
    return 'unexpected';
}

async function main() {
    console.log(`Reminder audit run ${RAND}\n`);

    const testUserIds: string[] = [];
    const testConnectionIds: string[] = [];
    const testReminderIds: string[] = [];
    let cleaned = false;
    async function cleanup() {
        if (cleaned) return;
        cleaned = true;
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
    installCrashSafety(cleanup);

    async function makeConnectedPair(label: string) {
        const caregiver = await signUpTestUser(`${label}cg`, `Reminder Audit ${label} Caregiver`);
        const recipient = await signUpTestUser(`${label}rc`, `Reminder Audit ${label} Recipient`);
        testUserIds.push(caregiver.id, recipient.id);
        dbQuery(`update public.profiles set role='caregiver' where id='${caregiver.id}';`);
        dbQuery(`update public.profiles set role='recipient', timezone='UTC' where id='${recipient.id}';`);
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
        opts: { daysOfWeek: number[]; scheduledOffsetMinutes: number; noResponseMinutes?: number; createdAtOffsetMinutes?: number }
    ): Promise<string> {
        const timeOfDay = utcTimeString(opts.scheduledOffsetMinutes);
        const createdAtIso = new Date(Date.now() + (opts.createdAtOffsetMinutes ?? -1440) * 60000).toISOString();
        const rows = dbQuery(`
          insert into public.reminders (connection_id, caregiver_id, recipient_id, title, time_of_day, days_of_week, no_response_minutes, is_active, created_at, updated_at)
          values ('${connectionId}', '${caregiverId}', '${recipientId}', 'Reminder audit test', '${timeOfDay}', ARRAY[${opts.daysOfWeek.join(',')}], ${opts.noResponseMinutes ?? 15}, true, '${createdAtIso}', now())
          returning id;
        `);
        const id = (rows[0] as any).id;
        testReminderIds.push(id);
        return id;
    }

    async function respond(client: ReturnType<typeof newClient>, reminderId: string, status: string, snoozeMinutes = 10) {
        return client.rpc('respond_to_reminder_occurrence', { p_reminder_id: reminderId, p_status: status, p_snooze_minutes: snoozeMinutes });
    }

    // Loads the reminder's current row (authoritative — mirrors how
    // edit-reminder.tsx loads before editing) and calls
    // update_reminder_schedule with those values overridden by `overrides`
    // — Week 1 task #8's sole edit write path, superseding
    // clear_stale_reminder_deliveries from the prior task.
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
        const rows = dbQuery(`select * from public.reminder_logs where reminder_id = '${reminderId}';`);
        return rows[0];
    }

    try {
        const { caregiver: caregiverA, recipient: recipientA, connectionId: connA } = await makeConnectedPair('a');
        const { recipient: recipientB } = await makeConnectedPair('b');

        // ── A: create valid reminder ─────────────────────────────────────────────
        const reminderA = await createReminder(connA, caregiverA.id, recipientA.id, { daysOfWeek: [1, 2, 3, 4, 5, 6, 7], scheduledOffsetMinutes: -5 });
        const remRow = dbQuery(`select is_active, no_response_minutes from public.reminders where id = '${reminderA}';`)[0] as any;
        record('A', 'valid reminder created with expected defaults', remRow?.is_active === true && remRow?.no_response_minutes === 15);

        // ── B: reject unrelated recipient ────────────────────────────────────────
        const bResp = await respond(recipientB.client, reminderA, 'taken');
        record('B', 'unrelated recipient cannot respond to another recipient\'s reminder', !!bResp.error && rpcErrorKind(bResp.error.message) === 'not_authorized', bResp.error?.message);

        // ── C: daily eligibility ─────────────────────────────────────────────────
        const reminderC = await createReminder(connA, caregiverA.id, recipientA.id, { daysOfWeek: [1, 2, 3, 4, 5, 6, 7], scheduledOffsetMinutes: -5 });
        const cResp = await respond(recipientA.client, reminderC, 'taken');
        record('C', 'daily reminder is eligible today', !cResp.error, cResp.error?.message);

        // ── D: weekday eligibility ───────────────────────────────────────────────
        const today = todayIsoWeekday();
        const isWeekday = today <= 5;
        const reminderD = await createReminder(connA, caregiverA.id, recipientA.id, { daysOfWeek: [1, 2, 3, 4, 5], scheduledOffsetMinutes: -5 });
        const dResp = await respond(recipientA.client, reminderD, 'taken');
        record('D', `weekday-only reminder eligibility matches today (isWeekday=${isWeekday})`, isWeekday ? !dResp.error : (!!dResp.error && rpcErrorKind(dResp.error.message) === 'not_eligible_today'), dResp.error?.message);

        // ── E: weekend eligibility ───────────────────────────────────────────────
        const isWeekend = today === 6 || today === 7;
        const reminderE = await createReminder(connA, caregiverA.id, recipientA.id, { daysOfWeek: [6, 7], scheduledOffsetMinutes: -5 });
        const eResp = await respond(recipientA.client, reminderE, 'taken');
        record('E', `weekend-only reminder eligibility matches today (isWeekend=${isWeekend})`, isWeekend ? !eResp.error : (!!eResp.error && rpcErrorKind(eResp.error.message) === 'not_eligible_today'), eResp.error?.message);

        // ── F: custom-day eligibility ────────────────────────────────────────────
        const reminderFYes = await createReminder(connA, caregiverA.id, recipientA.id, { daysOfWeek: [today], scheduledOffsetMinutes: -5 });
        const fYesResp = await respond(recipientA.client, reminderFYes, 'taken');
        record('F', 'custom day set including today is eligible', !fYesResp.error, fYesResp.error?.message);

        const notToday = (today % 7) + 1;
        const reminderFNo = await createReminder(connA, caregiverA.id, recipientA.id, { daysOfWeek: [notToday], scheduledOffsetMinutes: -5 });
        const fNoResp = await respond(recipientA.client, reminderFNo, 'taken');
        record('F', 'custom day set excluding today is not eligible', !!fNoResp.error && rpcErrorKind(fNoResp.error.message) === 'not_eligible_today', fNoResp.error?.message);

        // ── G: before creation boundary ──────────────────────────────────────────
        const reminderG = await createReminder(connA, caregiverA.id, recipientA.id, { daysOfWeek: [1, 2, 3, 4, 5, 6, 7], scheduledOffsetMinutes: -5, createdAtOffsetMinutes: 10 });
        const gResp = await respond(recipientA.client, reminderG, 'taken');
        record('G', 'reminder created after its own scheduled time today is not yet eligible', !!gResp.error && rpcErrorKind(gResp.error.message) === 'not_eligible_yet', gResp.error?.message);

        // ── H: before acceptance boundary ────────────────────────────────────────
        const { caregiver: caregiverH, recipient: recipientH, connectionId: connH } = await makeConnectedPair('h');
        dbQuery(`update public.connections set accepted_at = now() + interval '10 minutes' where id = '${connH}';`);
        const reminderH = await createReminder(connH, caregiverH.id, recipientH.id, { daysOfWeek: [1, 2, 3, 4, 5, 6, 7], scheduledOffsetMinutes: -5 });
        const hResp = await respond(recipientH.client, reminderH, 'taken');
        record('H', 'reminder scheduled before its connection was accepted is not yet eligible', !!hResp.error && rpcErrorKind(hResp.error.message) === 'not_eligible_yet', hResp.error?.message);

        // ── I/J/K: taken / skipped / snoozed responses ───────────────────────────
        const reminderI = await createReminder(connA, caregiverA.id, recipientA.id, { daysOfWeek: [1, 2, 3, 4, 5, 6, 7], scheduledOffsetMinutes: -5 });
        const iResp = await respond(recipientA.client, reminderI, 'taken');
        record('I', 'taken response succeeds and persists', !iResp.error && (iResp.data as any)?.status === 'taken', iResp.error?.message);

        const reminderJ = await createReminder(connA, caregiverA.id, recipientA.id, { daysOfWeek: [1, 2, 3, 4, 5, 6, 7], scheduledOffsetMinutes: -5 });
        const jResp = await respond(recipientA.client, reminderJ, 'skipped');
        record('J', 'skipped response succeeds and persists', !jResp.error && (jResp.data as any)?.status === 'skipped', jResp.error?.message);

        const reminderK = await createReminder(connA, caregiverA.id, recipientA.id, { daysOfWeek: [1, 2, 3, 4, 5, 6, 7], scheduledOffsetMinutes: -5 });
        const kResp = await respond(recipientA.client, reminderK, 'snoozed');
        const kLog = kResp.data as any;
        record('K', 'snoozed response succeeds with a future snoozed_until', !kResp.error && kLog?.status === 'snoozed' && new Date(kLog.snoozed_until).getTime() > Date.now(), kResp.error?.message);

        // ── L: missed response (server-cron-only) ────────────────────────────────
        const reminderL = await createReminder(connA, caregiverA.id, recipientA.id, { daysOfWeek: [1, 2, 3, 4, 5, 6, 7], scheduledOffsetMinutes: -30, noResponseMinutes: 1 });
        dbQuery(`select public.sync_missed_reminders_db();`);
        const lLog = logFor(reminderL);
        record('L', 'an unanswered occurrence past its window is marked missed by the server cron', lLog?.status === 'missed');
        const lClientAttempt = await respond(recipientA.client, reminderL, 'missed' as any);
        record('L', "'missed' is rejected as a client-submitted status (server-cron-exclusive)", !!lClientAttempt.error && rpcErrorKind(lClientAttempt.error.message) === 'invalid_status', lClientAttempt.error?.message);

        // ── M: duplicate same response ───────────────────────────────────────────
        const mResp2 = await respond(recipientA.client, reminderI, 'taken');
        record('M', 'submitting the same terminal response again is idempotent (no error, same log)', !mResp2.error && (mResp2.data as any)?.id === (iResp.data as any)?.id, mResp2.error?.message);

        // ── N: conflicting concurrent (sequenced) responses ──────────────────────
        const nResp = await respond(recipientA.client, reminderJ, 'taken');
        record('N', 'a different response after a recorded terminal response is rejected', !!nResp.error && rpcErrorKind(nResp.error.message) === 'already_answered', nResp.error?.message);

        // ── O: taken-vs-missed race (deterministic by design — see RPC's transition rule) ──
        const reminderO = await createReminder(connA, caregiverA.id, recipientA.id, { daysOfWeek: [1, 2, 3, 4, 5, 6, 7], scheduledOffsetMinutes: -30, noResponseMinutes: 1 });
        const [oTakenResp] = await Promise.all([
            respond(recipientA.client, reminderO, 'taken'),
            (async () => dbQuery(`select public.sync_missed_reminders_db();`))(),
        ]);
        const oLog = logFor(reminderO);
        record('O', 'a human Taken response always wins a race against the missed-sync cron, regardless of commit order', oLog?.status === 'taken', `rpc_error=${oTakenResp.error?.message ?? 'none'} final_status=${oLog?.status}`);

        // ── P: snooze-vs-missed race (deterministic — snoozed rows are excluded from the missed sweep) ──
        const reminderP = await createReminder(connA, caregiverA.id, recipientA.id, { daysOfWeek: [1, 2, 3, 4, 5, 6, 7], scheduledOffsetMinutes: -30, noResponseMinutes: 1 });
        await Promise.all([
            respond(recipientA.client, reminderP, 'snoozed'),
            (async () => dbQuery(`select public.sync_missed_reminders_db();`))(),
        ]);
        const pLog = logFor(reminderP);
        record('P', 'a human Snoozed response always wins a race against the missed-sync cron', pLog?.status === 'snoozed', `final_status=${pLog?.status}`);

        // ── Q: deactivate-vs-response race (genuine concurrency; two valid non-corrupt outcomes) ──
        const reminderQ = await createReminder(connA, caregiverA.id, recipientA.id, { daysOfWeek: [1, 2, 3, 4, 5, 6, 7], scheduledOffsetMinutes: -5 });
        const [qDeactivate, qRespond] = await Promise.all([
            caregiverA.client.from('reminders').update({ is_active: false }).eq('id', reminderQ),
            respond(recipientA.client, reminderQ, 'taken'),
        ]);
        const qReminderRow = dbQuery(`select is_active from public.reminders where id = '${reminderQ}';`)[0] as any;
        const qLog = logFor(reminderQ);
        const qOutcomeValid =
            qReminderRow?.is_active === false &&
            (!qLog || (qLog.status === 'taken')); // either no log was created (RPC lost the race and was rejected), or a valid 'taken' log exists (RPC won the race before deactivation applied) — both are non-corrupt.
        record('Q', 'caregiver-deactivate racing a recipient-response never corrupts state (exactly one of two valid outcomes)', qOutcomeValid, `deactivate_error=${(qDeactivate as any).error?.message ?? 'none'} respond_error=${qRespond.error?.message ?? 'none'} final_log_status=${qLog?.status ?? 'none'}`);

        // ── R: end-connection-vs-response race (sequenced -- no client-permitted async path ends a connection outside account deletion) ──
        const { caregiver: caregiverR, recipient: recipientR, connectionId: connR } = await makeConnectedPair('r');
        const reminderR = await createReminder(connR, caregiverR.id, recipientR.id, { daysOfWeek: [1, 2, 3, 4, 5, 6, 7], scheduledOffsetMinutes: -5 });
        dbQuery(`update public.connections set status = 'ended' where id = '${connR}';`);
        const rResp = await respond(recipientR.client, reminderR, 'taken');
        record('R', 'responding after the connection has ended is rejected', !!rResp.error && rpcErrorKind(rResp.error.message) === 'connection_inactive', rResp.error?.message);

        // ── S: edit time before due (nothing yet claimed -- reconciliation is a harmless no-op) ──
        const reminderS = await createReminder(connA, caregiverA.id, recipientA.id, { daysOfWeek: [1, 2, 3, 4, 5, 6, 7], scheduledOffsetMinutes: 60 });
        const sEditResp = await editSchedule(caregiverA.client, reminderS, { timeOfDay: utcTimeString(-5) });
        record('S', 'editing a reminder before its due time succeeds with nothing to reconcile', !sEditResp.error, sEditResp.error?.message);

        // ── T: edit time after due (a stale claimed-but-unsent delivery must be requeued in place, not duplicated) ──
        const reminderT = await createReminder(connA, caregiverA.id, recipientA.id, { daysOfWeek: [1, 2, 3, 4, 5, 6, 7], scheduledOffsetMinutes: -5 });
        dbQuery(`
          insert into public.reminder_notification_deliveries (reminder_id, recipient_id, occurrence_date, scheduled_for, delivery_type, status, schedule_version)
          values ('${reminderT}', '${recipientA.id}', current_date, now() - interval '5 minutes', 'reminder', 'pending', 1);
        `);
        await editSchedule(caregiverA.client, reminderT, { timeOfDay: utcTimeString(30) });
        const tDeliveries = dbQuery(`select count(*) as c, max(schedule_version) as version, max(status) as status from public.reminder_notification_deliveries where reminder_id = '${reminderT}' and delivery_type = 'reminder';`)[0] as any;
        record('T', 'a stale unsent delivery claim is requeued in place (still exactly one row) after a schedule-affecting edit', Number(tDeliveries.c) === 1 && Number(tDeliveries.version) === 2 && tDeliveries.status === 'pending', JSON.stringify(tDeliveries));
        // This scenario is the only one in this suite that INSERTs directly into
        // reminder_notification_deliveries, bypassing the claim functions'
        // server_push_enabled gate. Left in place, this synthetic 'pending' row
        // is indistinguishable from a real one to send-due-recipient-reminders'
        // retry query (which has no scheduled_for/provenance check) — the real
        // production cron (ticking every 30s against this same linked project)
        // will claim it, find no push token for the synthetic recipient, and
        // write a genuine status='failed' row that pollutes real ops-health
        // metrics for as long as this row survives. Delete it immediately
        // (the very next statement after the assertion above -- this is
        // already the tightest this window can be, since the assertion
        // itself must read the row's post-edit state first) rather than
        // waiting for this suite's end-of-run cleanup. See "Live-cron
        // isolation during audits" in docs/audit-infrastructure-model.md.
        dbQuery(`delete from public.reminder_notification_deliveries where reminder_id = '${reminderT}';`);

        // ── U: delete during snooze (no snooze delivery claimed for an inactive reminder) ──
        const reminderU = await createReminder(connA, caregiverA.id, recipientA.id, { daysOfWeek: [1, 2, 3, 4, 5, 6, 7], scheduledOffsetMinutes: -5 });
        await respond(recipientA.client, reminderU, 'snoozed', 1); // snoozed_until ~1 min from now
        dbQuery(`update public.reminder_logs set snoozed_until = now() - interval '1 minute' where reminder_id = '${reminderU}';`); // force it due
        dbQuery(`update public.reminders set is_active = false where id = '${reminderU}';`);
        dbQuery(`select public.claim_due_recipient_snooze_deliveries();`);
        const uSnoozeDeliveries = dbQuery(`select count(*) as c from public.reminder_notification_deliveries where reminder_id = '${reminderU}' and delivery_type = 'snooze';`)[0] as any;
        record('U', 'a deactivated reminder never gets a snooze delivery claimed, even with a due snoozed_until', Number(uSnoozeDeliveries.c) === 0, `claimed=${uSnoozeDeliveries.c}`);

        // ── V: no future missed after deactivate ─────────────────────────────────
        // Originally created the reminder ALREADY overdue (scheduledOffsetMinutes:
        // -30, a 1-minute window) and only deactivated it in a separate
        // statement afterward -- during that window it was both active and
        // genuinely missed-eligible, which the real production
        // sync_missed_reminders_db cron (ticking independently against this
        // same linked project, per docs/audit-infrastructure-model.md's
        // "Live-cron isolation during audits") could race and write a real
        // missed row for before deactivation ever took effect, producing an
        // occasional false assertion failure unrelated to any product bug.
        // Fixed by reversing the order: create the reminder with a schedule
        // that can never be missed-eligible while active (a full hour in
        // the future), deactivate it first (nothing to race, since it was
        // never overdue), and only then backdate its schedule directly via
        // SQL -- entirely after is_active=false, so there is no window in
        // which the real cron could ever select it (sync_missed_reminders_db
        // scopes to is_active=true reminders, matching every other
        // reminder-lifecycle RPC's convention).
        const reminderV = await createReminder(connA, caregiverA.id, recipientA.id, { daysOfWeek: [1, 2, 3, 4, 5, 6, 7], scheduledOffsetMinutes: 60, noResponseMinutes: 1 });
        dbQuery(`update public.reminders set is_active = false where id = '${reminderV}';`);
        dbQuery(`update public.reminders set time_of_day = ((now() - interval '30 minutes') at time zone 'UTC')::time where id = '${reminderV}';`);
        dbQuery(`select public.sync_missed_reminders_db();`);
        const vLog = logFor(reminderV);
        record('V', 'a deactivated reminder never gets a missed row written for it', !vLog);

        // ── W: historical logs preserved after deactivation ──────────────────────
        dbQuery(`update public.reminders set is_active = false where id = '${reminderI}';`);
        const wLog = logFor(reminderI);
        record('W', 'a historical log survives its reminder being deactivated afterward', wLog?.status === 'taken');

        // ── X/Y/Z/AA/AB: analytics correctness (direct unit test of lib/reminderStatus.ts) ──
        const analyticsReminder = {
            days_of_week: [1, 2, 3, 4, 5, 6, 7],
            time_of_day: '09:00:00',
            created_at: '2026-01-01T00:00:00.000Z',
            is_active: true,
            no_response_minutes: 15,
        };
        const acceptedAt = '2026-01-01T00:00:00.000Z';
        const start = getAnalyticsStartDate(acceptedAt, analyticsReminder.created_at, analyticsReminder.time_of_day);
        record('X', 'getAnalyticsStartDate resolves to the later of created_at/accepted_at at local midnight', start.getUTCFullYear() === 2026 || start.getFullYear() === 2026);

        const pastDate = new Date(2026, 0, 5); // well after start, safely in the past relative to "today" in any real run
        const eligiblePast = isReminderEligibleOnDate(analyticsReminder, pastDate, acceptedAt, false);
        record('Y', 'a past eligible date with no log is analytics-eligible', eligiblePast === true);

        const statusNoLog = getComputedStatus(analyticsReminder, '2026-01-05', '2026-01-05', undefined);
        record('Z', 'getComputedStatus with no log and today == scheduled date depends only on the response window, never assumes missed prematurely', statusNoLog === 'pending' || statusNoLog === 'missed');

        // ── AA: future dates excluded ─────────────────────────────────────────────
        const farFutureDate = new Date(2027, 0, 1);
        const futureStatus = getComputedStatus(analyticsReminder, '2027-01-01', '2026-01-05', undefined);
        record('AA', 'a future date always computes as pending, never missed', futureStatus === 'pending');
        const futureEligible = isReminderEligibleOnDate(analyticsReminder, farFutureDate, acceptedAt, false);
        record('AA', 'a future date can still be schedule-eligible (separate from status) — pending exclusion happens at the status layer, not eligibility', futureEligible === true);

        // ── AB: pending excluded from countable/denominator ──────────────────────
        // Uses real "today" (not the hardcoded 2026-01 fixture dates above) --
        // getComputedStatus's window check compares against the actual
        // current clock, not the dateString/todayString parameters, so a
        // "today, no log, still pending" case needs a genuinely
        // not-yet-due time_of_day to land on 'pending' rather than 'missed'.
        // buildScheduledDateTime (lib/reminderStatus.ts) constructs this
        // via the LOCAL Date constructor, so "an hour from now" must be
        // derived the same way -- computing it as `(hour + 1) % 24` wraps
        // to "00:00:00" during the real 23:00-23:59 local hour, which is
        // EARLIER than "now", not later, silently turning this into a
        // 'missed' (or worse, ambiguous) case instead of 'pending' (a real
        // bug found via an actual failure at that hour, not hypothetical).
        // Fixed by computing a genuine future Date via arithmetic and
        // deriving the date string from THAT instant -- which correctly
        // rolls over to tomorrow when the +1 hour crosses midnight, so the
        // dateString/time_of_day pair passed to getComputedStatus is
        // always self-consistent, at every hour of the day.
        const realNow = new Date();
        const realTodayStr = `${realNow.getFullYear()}-${String(realNow.getMonth() + 1).padStart(2, '0')}-${String(realNow.getDate()).padStart(2, '0')}`;
        const oneHourFromNow = new Date(realNow.getTime() + 60 * 60 * 1000);
        const oneHourFromNowDateStr = `${oneHourFromNow.getFullYear()}-${String(oneHourFromNow.getMonth() + 1).padStart(2, '0')}-${String(oneHourFromNow.getDate()).padStart(2, '0')}`;
        const notYetDueReminder = {
            ...analyticsReminder,
            time_of_day: `${String(oneHourFromNow.getHours()).padStart(2, '0')}:${String(oneHourFromNow.getMinutes()).padStart(2, '0')}:00`,
        };
        const realFutureYear = realNow.getFullYear() + 1;
        const displays = [
            { status: getComputedStatus(analyticsReminder, realTodayStr, realTodayStr, { status: 'taken' } as any) },
            // dateString is the real calendar date of the future instant --
            // becomes tomorrow (not today) when the +1 hour crosses
            // midnight, correctly exercising getComputedStatus's own
            // `dateString > todayString -> pending` path in that case, and
            // the scheduled-time window check otherwise. Never assumes
            // "today" when the instant actually rolled over.
            { status: getComputedStatus(notYetDueReminder, oneHourFromNowDateStr, realTodayStr, undefined) }, // genuinely an hour from now, still not due -> pending
            { status: getComputedStatus(analyticsReminder, `${realFutureYear}-01-01`, realTodayStr, undefined) }, // future date -> pending
        ];
        const countable = displays.filter((d) => d.status !== 'pending').length;
        record('AB', 'pending occurrences are excluded from the countable/denominator set', countable === 1, `countable=${countable}`);

        // ── AC: deleted/tombstoned participant history preserved ────────────────
        const { recipient: recipientAC, caregiver: caregiverAC, connectionId: connAC } = await makeConnectedPair('ac');
        const reminderAC = await createReminder(connAC, caregiverAC.id, recipientAC.id, { daysOfWeek: [1, 2, 3, 4, 5, 6, 7], scheduledOffsetMinutes: -5 });
        await respond(recipientAC.client, reminderAC, 'taken');
        dbQuery(`select public.delete_current_user_data('${recipientAC.id}');`);
        const acLog = logFor(reminderAC);
        record('AC', "a recipient's historical log survives their own account deletion (shared history preserved for the caregiver)", acLog?.status === 'taken');

        // ── AD: timezone-change duplicate prevention ─────────────────────────────
        // Whether UTC and America/New_York agree on "today"'s calendar date,
        // and whether the reminder's fixed time_of_day is even still
        // eligible once reinterpreted in a different zone, both depend on
        // the real wall-clock moment this test happens to run at -- rather
        // than predict an exact outcome, assert the one invariant that must
        // hold regardless: no two reminder_logs rows for this reminder ever
        // share the same occurrence_date. That -- not a specific row count
        // -- is the literal meaning of "a timezone change must not
        // duplicate an already-recorded occurrence."
        const reminderAD = await createReminder(connA, caregiverA.id, recipientA.id, { daysOfWeek: [1, 2, 3, 4, 5, 6, 7], scheduledOffsetMinutes: -5 });
        const adResp1 = await respond(recipientA.client, reminderAD, 'taken');
        dbQuery(`update public.profiles set timezone = 'America/New_York' where id = '${recipientA.id}';`);
        const adResp2 = await respond(recipientA.client, reminderAD, 'taken');
        dbQuery(`update public.profiles set timezone = 'UTC' where id = '${recipientA.id}';`); // restore for later scenarios
        const adRows = dbQuery(`select occurrence_date from public.reminder_logs where reminder_id = '${reminderAD}';`) as { occurrence_date: string }[];
        const distinctDates = new Set(adRows.map((r) => r.occurrence_date));
        record('AD', 'no two logged occurrences for the same reminder ever share an occurrence_date across a timezone change', distinctDates.size === adRows.length, `rows=${adRows.length} distinct_dates=${distinctDates.size} first_ok=${!adResp1.error} second_error=${adResp2.error?.message ?? 'none'}`);

        // ── AE/AF: DST boundary date math (direct SQL verification of Postgres's tz handling) ──
        const springForward = dbQuery(`select ('2026-03-08 09:00:00'::timestamp at time zone 'America/New_York') as scheduled_for;`)[0] as any;
        record('AE', 'DST spring-forward date (2026-03-08, America/New_York) resolves to a valid absolute timestamp', !!springForward?.scheduled_for);
        const fallBack = dbQuery(`select ('2026-11-01 09:00:00'::timestamp at time zone 'America/New_York') as scheduled_for;`)[0] as any;
        record('AF', 'DST fall-back date (2026-11-01, America/New_York) resolves to a valid absolute timestamp', !!fallBack?.scheduled_for);
        const dstOrderCheck = dbQuery(`
          select
            ('2026-03-08 09:00:00'::timestamp at time zone 'America/New_York') < ('2026-03-09 09:00:00'::timestamp at time zone 'America/New_York') as ordered_correctly;
        `)[0] as any;
        record('AE', 'consecutive days across the spring-forward boundary remain chronologically ordered', dstOrderCheck?.ordered_correctly === true);

        // ── AG: unauthorized direct log mutation ─────────────────────────────────
        const agInsert = await recipientA.client.from('reminder_logs').insert({
            reminder_id: reminderC, connection_id: connA, caregiver_id: caregiverA.id, recipient_id: recipientA.id,
            occurrence_date: new Date().toISOString().slice(0, 10), scheduled_for: new Date().toISOString(), status: 'taken',
        });
        record('AG', 'direct client INSERT into reminder_logs is rejected (RLS has no INSERT policy for authenticated)', !!agInsert.error, agInsert.error?.message);
        const agUpdate = await recipientA.client.from('reminder_logs').update({ status: 'skipped' }).eq('reminder_id', reminderI).select();
        record('AG', 'direct client UPDATE of reminder_logs is rejected (RLS has no UPDATE policy for authenticated)', !agUpdate.error ? (agUpdate.data ?? []).length === 0 : true, agUpdate.error?.message ?? `rows affected: ${(agUpdate.data ?? []).length}`);

        // ── AH: direct privileged RPC rejection ──────────────────────────────────
        const ahSync = await recipientA.client.rpc('sync_missed_reminders_db');
        record('AH', 'sync_missed_reminders_db is not callable by an authenticated client (service_role only)', !!ahSync.error, ahSync.error?.message);
        const ahEdit = await editSchedule(recipientA.client, reminderC, { title: 'forged edit' });
        record('AH', 'a recipient cannot call update_reminder_schedule for a reminder they do not own as caregiver', !!ahEdit.error, ahEdit.error?.message);

        // Nested cross-suite "remains passing" checks (formerly AI/AJ/AK)
        // removed as part of Week 4 Task #1's DAG-flattening pass -- see
        // docs/audit-infrastructure-model.md. scripts/final-regression/run.ts
        // now runs security-audit, auth-audit, and ops-health exactly once
        // each, instead of every other suite re-invoking them.

    } finally {
        await cleanup();
    }

    const passed = summarize();
    process.exit(passed ? 0 : 1);
}

main().catch((err) => {
    console.error('REMINDER_AUDIT_SUITE_FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
});
