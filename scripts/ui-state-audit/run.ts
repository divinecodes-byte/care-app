// Tavora Week 2 product-polish task #3: comprehensive loading, empty,
// error, retry, and offline-state hardening — automated audit.
//
// Run from the repo root:
//   EXPO_PUBLIC_SUPABASE_URL=... EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=... npx tsx scripts/ui-state-audit/run.ts
//
// Two kinds of scenarios here:
//   - Pure unit tests (A-L) of the shared classification logic in
//     lib/asyncStateCore.ts / lib/authErrors.ts — no network, deterministic.
//   - Integration scenarios (M onward) using disposable synthetic users
//     (tavora.uistateaudit.*@example.com) against the real anon-key client
//     paths, verified/cleaned up via the already-authenticated `supabase`
//     CLI, never touching a real account.
//
// What this script deliberately does NOT attempt to assert (documented in
// docs/ui-state-model.md instead): visual-only behavior that has no
// server-observable side effect — e.g. "the loading card only appears on
// first load, not on refresh," "the offline banner is dismissible," VoiceOver
// announcement timing, skeleton/spinner choice. Those are verified by
// `npx tsc --noEmit` (compiles, and the gating booleans referenced in this
// script's comments do exist) and manual code review, not by this harness —
// there is no headless React Native renderer in this environment.

import { execFileSync } from 'node:child_process';
import {
    dbQuery,
    newClient,
    randomSuffix,
    record,
    summarize,
} from '../security-audit/helpers';
import { installCrashSafety } from '../audit-infrastructure/cleanup';
import { classifyScreenError, isRetryableCategory, ErrorCategory } from '../../lib/asyncStateCore';
import { classifyAuthError, AUTH_ERROR_TRANSLATION_KEYS } from '../../lib/authErrors';
import { ERROR_CATEGORY_TRANSLATION_KEYS } from '../../lib/errorClassification';

const RAND = randomSuffix();
const PASSWORD = `UiStateAudit!${RAND}9X`;
const EMAIL_PREFIX = 'tavora.uistateaudit';


async function signUpTestUser(emailPrefix: string, fullName: string) {
    const client = newClient();
    const email = `${EMAIL_PREFIX}.${emailPrefix}.${RAND}@example.com`;
    const { data, error } = await client.auth.signUp({ email, password: PASSWORD, options: { data: { full_name: fullName, audit_account: true } } });
    if (error || !data.user) throw new Error(`signup failed for ${email}: ${error?.message}`);
    return { id: data.user.id, email, client };
}

async function makeCaregiver(label: string) {
    const cg = await signUpTestUser(`${label}cg`, `UI ${label} Organizer`);
    dbQuery(`update public.profiles set role='caregiver' where id='${cg.id}';`);
    return cg;
}

async function makeRecipient(label: string) {
    const rc = await signUpTestUser(`${label}rc`, `UI ${label} Participant`);
    // Pinned to UTC (matching scripts/reminder-audit/run.ts's own
    // convention) so time_of_day/eligibility windows computed against
    // wall-clock UTC in this script are deterministic regardless of which
    // timezone this process happens to run in.
    dbQuery(`update public.profiles set role='recipient', timezone='UTC' where id='${rc.id}';`);
    return rc;
}

// Matches scripts/reminder-audit/run.ts's own helper -- a reminder must be
// both backdated (created before today, so "first eligible date" isn't
// pushed to tomorrow) and scheduled in the past relative to now (in UTC,
// since time_of_day has no timezone component) to be answerable the
// moment it's created, without waiting on a real clock.
function utcTimeString(offsetMinutes: number): string {
    const d = new Date(Date.now() + offsetMinutes * 60000);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:00`;
}

async function connect(caregiver: { client: ReturnType<typeof newClient> }, recipient: { client: ReturnType<typeof newClient> }): Promise<string> {
    const { data: invite } = await caregiver.client
        .rpc('create_invite_code', { p_existing_connection_id: null })
        .maybeSingle() as { data: { id: string; invite_code: string } | null };
    if (!invite) throw new Error('create_invite_code returned no row');
    const { data: result } = await recipient.client.rpc('accept_invite_code', { p_code: invite.invite_code });
    if (result !== 'accepted') throw new Error(`accept_invite_code did not accept: ${result}`);
    return invite.id;
}

async function main() {
    console.log(`UI-state audit run ${RAND}\n`);

    // ── A-I: classifyScreenError pattern coverage (pure, no network) ────────
    record('A', "classifyScreenError: a network-ish message classifies as 'network'",
        classifyScreenError('TypeError: Network request failed') === 'network');
    record('B', "classifyScreenError: a JWT-expired message classifies as 'session_expired'",
        classifyScreenError('JWT expired') === 'session_expired');
    record('C', "classifyScreenError: an RLS-denial message classifies as 'unauthorized'",
        classifyScreenError('new row violates row-level security policy') === 'unauthorized');
    record('D', "classifyScreenError: an 'ended'/'expired' message classifies as 'no_longer_active'",
        classifyScreenError('connection_inactive') === 'no_longer_active' &&
        classifyScreenError('invite code expired') === 'no_longer_active');
    record('E', "classifyScreenError: an 'already_answered' message classifies as 'already_completed'",
        classifyScreenError('already_answered') === 'already_completed');
    record('F', "classifyScreenError: a constraint-violation message classifies as 'validation'",
        classifyScreenError('violates check constraint') === 'validation');
    record('G', "classifyScreenError: a rate-limit message classifies as 'rate_limited', checked before network",
        classifyScreenError('rate limit exceeded, please slow down') === 'rate_limited');
    record('H', "classifyScreenError: an empty/unrecognized message classifies as 'unexpected', never throws",
        classifyScreenError('') === 'unexpected' && classifyScreenError(null) === 'unexpected' && classifyScreenError('some totally novel string') === 'unexpected');
    record('I', 'isRetryableCategory: only network/unexpected/rate_limited are retryable -- not_found-equivalent and already_completed are not',
        isRetryableCategory('network') && isRetryableCategory('unexpected') && isRetryableCategory('rate_limited') &&
        !isRetryableCategory('no_longer_active') && !isRetryableCategory('already_completed') && !isRetryableCategory('unauthorized') && !isRetryableCategory('session_expired') && !isRetryableCategory('validation'));

    // ── J-K: classifyAuthError coverage (pure, no network) ───────────────────
    record('J', "classifyAuthError: a Supabase rate-limit error (or bare 429 status) classifies as 'rate_limited'",
        classifyAuthError({ message: 'email rate limit exceeded' }) === 'rate_limited' &&
        classifyAuthError({ message: 'over_request_rate_limit' }) === 'rate_limited' &&
        classifyAuthError({ status: 429, message: 'Too Many Requests' }) === 'rate_limited');
    record('K', "classifyAuthError: rate-limit is checked before network, even if the message also mentions 'request'",
        classifyAuthError({ message: 'over_request_rate_limit: too many requests' }) === 'rate_limited');

    // ── L: translation-key coverage (pure) ───────────────────────────────────
    const allErrorCategories: ErrorCategory[] = ['network', 'session_expired', 'unauthorized', 'no_longer_active', 'already_completed', 'validation', 'rate_limited', 'unexpected'];
    const missingScreenKeys = allErrorCategories.filter((c) => !ERROR_CATEGORY_TRANSLATION_KEYS[c]);
    record('L', 'every ErrorCategory has a mapped stateErrors.* translation key (none silently falls through to undefined)',
        missingScreenKeys.length === 0, missingScreenKeys.join(',') || undefined);
    const missingAuthKeys = (['rate_limited', 'invalid_credentials', 'email_in_use', 'weak_password', 'network', 'expired_session', 'account_deleted', 'unexpected'] as const)
        .filter((k) => !AUTH_ERROR_TRANSLATION_KEYS[k]);
    record('L', 'every AuthErrorKind has a mapped authErrors.* translation key',
        missingAuthKeys.length === 0, missingAuthKeys.join(',') || undefined);

    // ── Integration scenarios ────────────────────────────────────────────────
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
        if (testReminderIds.length > 0) {
            dbQuery(`delete from public.reminders where id in (${testReminderIds.map((id) => `'${id}'`).join(',')});`);
        }
        if (testConnectionIds.length > 0) {
            dbQuery(`delete from public.connections where id in (${testConnectionIds.map((id) => `'${id}'`).join(',')});`);
        }
        if (testUserIds.length > 0) {
            const idList = testUserIds.map((id) => `'${id}'`).join(',');
            dbQuery(`delete from public.reminder_notification_deliveries where reminder_id in (select id from public.reminders where caregiver_id in (${idList}) or recipient_id in (${idList}));`);
            dbQuery(`delete from public.reminder_logs where caregiver_id in (${idList}) or recipient_id in (${idList});`);
            dbQuery(`delete from public.reminders where caregiver_id in (${idList}) or recipient_id in (${idList});`);
            dbQuery(`delete from public.connections where caregiver_id in (${idList}) or recipient_id in (${idList});`);
            dbQuery(`delete from public.onboarding_events where user_id in (${idList});`);
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

    try {
        // ── M: connection-ended is distinguishable from never-connected ─────
        const orgM = await makeCaregiver('m');
        const rcM  = await makeRecipient('m');
        testUserIds.push(orgM.id, rcM.id);
        const connM = await connect(orgM, rcM);
        testConnectionIds.push(connM);

        const { error: endMErr } = await rcM.client.rpc('end_connection', { p_connection_id: connM });
        const rcMRows = dbQuery(`select status from public.connections where recipient_id='${rcM.id}';`) as any[];
        const hasAcceptedM = rcMRows.some((r) => r.status === 'accepted');
        const connectionEndedM = !hasAcceptedM && rcMRows.some((r) => r.status === 'ended');
        record('M', 'a participant who ends their own connection sees status=ended (drives the "connection ended" empty state, not "never connected")',
            !endMErr && !hasAcceptedM && connectionEndedM, endMErr?.message);

        // ── N: a brand-new recipient (never connected) is NOT misclassified as "connection ended" ──
        const rcN = await makeRecipient('n');
        testUserIds.push(rcN.id);
        const rcNRows = dbQuery(`select status from public.connections where recipient_id='${rcN.id}';`) as any[];
        const connectionEndedN = !rcNRows.some((r) => r.status === 'accepted') && rcNRows.some((r) => r.status === 'ended');
        record('N', 'a recipient with zero connection rows ever is never misclassified as "connection ended"',
            rcNRows.length === 0 && !connectionEndedN);

        // ── O: a deleted/nonexistent reminder id resolves to null, not a thrown error ──
        const orgO = await makeCaregiver('o');
        const rcO  = await makeRecipient('o');
        testUserIds.push(orgO.id, rcO.id);
        const connO = await connect(orgO, rcO);
        testConnectionIds.push(connO);
        const remO = dbQuery(`insert into public.reminders (connection_id, caregiver_id, recipient_id, title, time_of_day, days_of_week, no_response_minutes, is_active) values ('${connO}', '${orgO.id}', '${rcO.id}', 'To delete', '08:00:00', ARRAY[1,2,3,4,5,6,7], 30, true) returning id;`)[0] as any;
        dbQuery(`delete from public.reminders where id='${remO.id}';`);
        const { data: goneRem, error: goneErr } = await orgO.client.from('reminders').select('id').eq('id', remO.id).maybeSingle();
        record('O', 'fetching a deleted reminder by id resolves to null with no error (never a thrown exception the UI must catch specially)',
            !goneErr && goneRem === null, goneErr?.message);

        // ── P: an expired invite code is rejected with a classifiable 'expired' result ──
        const orgP = await makeCaregiver('p');
        testUserIds.push(orgP.id);
        const { data: inviteP } = await orgP.client.rpc('create_invite_code', { p_existing_connection_id: null }).maybeSingle() as { data: { id: string; invite_code: string } | null };
        if (inviteP) testConnectionIds.push(inviteP.id);
        dbQuery(`update public.connections set expires_at = now() - interval '1 hour' where id='${inviteP?.id}';`);
        const rcP = await makeRecipient('p');
        testUserIds.push(rcP.id);
        const { data: expiredResult } = await rcP.client.rpc('accept_invite_code', { p_code: inviteP?.invite_code });
        record('P', "accepting an expired invite code returns 'expired' (drives the 'This invitation has expired' state, never a raw error)",
            expiredResult === 'expired');

        // ── Q: accepting the same invite code twice is idempotent, not a duplicate connection ──
        const orgQ = await makeCaregiver('q');
        const rcQ  = await makeRecipient('q');
        testUserIds.push(orgQ.id, rcQ.id);
        const { data: inviteQ } = await orgQ.client.rpc('create_invite_code', { p_existing_connection_id: null }).maybeSingle() as { data: { id: string; invite_code: string } | null };
        if (inviteQ) testConnectionIds.push(inviteQ.id);
        const { data: firstAccept } = await rcQ.client.rpc('accept_invite_code', { p_code: inviteQ?.invite_code });
        const { data: secondAccept } = await rcQ.client.rpc('accept_invite_code', { p_code: inviteQ?.invite_code });
        const qConnCount = Number((dbQuery(`select count(*) as c from public.connections where caregiver_id='${orgQ.id}';`)[0] as any).c);
        record('Q', "re-submitting the same invite-code acceptance (e.g. a retry after a network blip) is safe -- no duplicate connection row, second call reports 'already_accepted'",
            firstAccept === 'accepted' && secondAccept === 'already_accepted' && qConnCount === 1,
            `first=${firstAccept} second=${secondAccept} count=${qConnCount}`);

        // ── R: responding to the same reminder occurrence twice is idempotent ──
        const orgR = await makeCaregiver('r');
        const rcR  = await makeRecipient('r');
        testUserIds.push(orgR.id, rcR.id);
        const connR = await connect(orgR, rcR);
        testConnectionIds.push(connR);
        // respond_to_reminder_occurrence requires scheduled_for >=
        // greatest(reminder.created_at, connection.accepted_at) -- connect()
        // above just accepted this invite "now", which would otherwise make
        // any today-scheduled-in-the-past reminder look like it was
        // scheduled before the connection existed. Backdate both to a
        // consistent "yesterday" baseline, matching
        // scripts/reminder-audit/run.ts's own convention.
        dbQuery(`update public.connections set accepted_at = now() - interval '1 day' where id='${connR}';`);
        const rTimeOfDay = utcTimeString(-30);
        const rCreatedAt = new Date(Date.now() - 1440 * 60000).toISOString();
        const remR = dbQuery(`insert into public.reminders (connection_id, caregiver_id, recipient_id, title, time_of_day, days_of_week, no_response_minutes, is_active, created_at, updated_at) values ('${connR}', '${orgR.id}', '${rcR.id}', 'R reminder', '${rTimeOfDay}', ARRAY[1,2,3,4,5,6,7], 30, true, '${rCreatedAt}', now()) returning id;`)[0] as any;
        testReminderIds.push(remR.id);
        const firstResp = await rcR.client.rpc('respond_to_reminder_occurrence', { p_reminder_id: remR.id, p_status: 'taken', p_snooze_minutes: null });
        const secondResp = await rcR.client.rpc('respond_to_reminder_occurrence', { p_reminder_id: remR.id, p_status: 'taken', p_snooze_minutes: null });
        const rLogCount = Number((dbQuery(`select count(*) as c from public.reminder_logs where reminder_id='${remR.id}';`)[0] as any).c);
        record('R', 'double-submitting the same Taken response (e.g. a double-tap or a retry after a slow network) never creates a second log row',
            !firstResp.error && rLogCount === 1, `secondError=${secondResp.error?.message} logCount=${rLogCount}`);
        if (secondResp.error) {
            const secondKind = classifyScreenError(secondResp.error.message);
            record('R', "the second (redundant) response's error, if any, classifies as 'already_completed' -- never shown as a raw failure",
                secondKind === 'already_completed', secondResp.error.message);
        }

        // ── S: ending an already-ended connection is safe, not a crash ──────
        const orgS = await makeCaregiver('s');
        const rcS  = await makeRecipient('s');
        testUserIds.push(orgS.id, rcS.id);
        const connS = await connect(orgS, rcS);
        testConnectionIds.push(connS);
        const { error: endS1 } = await orgS.client.rpc('end_connection', { p_connection_id: connS });
        const { error: endS2 } = await orgS.client.rpc('end_connection', { p_connection_id: connS });
        record('S', 'ending an already-ended connection a second time (e.g. a retry after the first response was lost) never crashes -- either succeeds again or fails with a classifiable error',
            !endS1, endS1?.message);
        if (endS2) {
            record('S', "the redundant second end_connection's error classifies as something other than 'unexpected' (a specific, translatable reason)",
                classifyScreenError(endS2.message) !== 'unexpected' || classifyScreenError(endS2.message) === 'no_longer_active', endS2.message);
        }

        // ── T: creating a reminder against an ended connection is rejected (participant no longer available) ──
        const orgT = await makeCaregiver('t');
        const rcT  = await makeRecipient('t');
        testUserIds.push(orgT.id, rcT.id);
        const connT = await connect(orgT, rcT);
        testConnectionIds.push(connT);
        await orgT.client.rpc('end_connection', { p_connection_id: connT });
        const { error: insertTErr } = await orgT.client.from('reminders').insert({
            connection_id: connT, caregiver_id: orgT.id, recipient_id: rcT.id, title: 'Should be rejected',
            time_of_day: '08:00:00', frequency: 'daily', days_of_week: [1, 2, 3, 4, 5, 6, 7], no_response_minutes: 30, is_active: true,
        });
        record('T', 'creating a reminder for a participant whose connection has ended is rejected server-side (RLS), classifiable as unauthorized rather than silently succeeding',
            !!insertTErr && classifyScreenError(insertTErr.message) === 'unauthorized', insertTErr?.message);

        // ── U: "organizer set up nothing yet" is distinguishable from "reminders exist, none due today" ──
        const orgU = await makeCaregiver('u');
        const rcU  = await makeRecipient('u');
        testUserIds.push(orgU.id, rcU.id);
        const connU = await connect(orgU, rcU);
        testConnectionIds.push(connU);
        // A reminder that exists but is scheduled for a day of the week that
        // isn't today -- still counts toward "has any reminders at all",
        // distinct from a participant with zero rows.
        const notTodayDow = ((new Date().getDay() + 3) % 7) || 7; // any ISO day != today
        const remU = dbQuery(`insert into public.reminders (connection_id, caregiver_id, recipient_id, title, time_of_day, days_of_week, no_response_minutes, is_active) values ('${connU}', '${orgU.id}', '${rcU.id}', 'Not today', '08:00:00', ARRAY[${notTodayDow}], 30, true) returning id;`)[0] as any;
        testReminderIds.push(remU.id);
        const { data: allRemindersU } = await rcU.client.from('reminders').select('id').eq('recipient_id', rcU.id).eq('is_active', true);
        record('U', 'a participant whose organizer has created a reminder (even one not due today) has hasAnyReminders=true -- never collapsed into the same "organizer hasn\'t set up anything" empty state as a genuinely-untouched participant',
            (allRemindersU ?? []).length === 1);

        // Nested cross-suite "remains passing" checks (formerly V-AA)
        // removed as part of Week 4 Task #1's DAG-flattening pass -- see
        // docs/audit-infrastructure-model.md.

    } finally {
        await cleanup();
    }

    const passed = summarize();
    process.exit(passed ? 0 : 1);
}

main().catch((err) => {
    console.error('UI_STATE_AUDIT_SUITE_FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
});
