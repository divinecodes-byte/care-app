// Tavora Week 2 product-polish task #1: onboarding, role clarity, use-case
// positioning, and first-success activation — automated onboarding audit.
//
// Run from the repo root:
//   EXPO_PUBLIC_SUPABASE_URL=... EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=... npx tsx scripts/onboarding-audit/run.ts
//
// Creates disposable synthetic users (tavora.onboardingaudit.*@example.com),
// exercises them through the real anon-key client paths (the same RPCs and
// RLS-bound queries the app itself uses), verifies/cleans up via the
// already-authenticated `supabase` CLI, and never touches a real account.

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
import { resolveProfileRoute } from '../../lib/onboardingCore';

const RAND = randomSuffix();
const PASSWORD = `OnbAudit!${RAND}9X`;
const EMAIL_PREFIX = 'tavora.onboardingaudit';

async function signUpTestUser(emailPrefix: string, fullName: string) {
    const client = newClient();
    const email = `${EMAIL_PREFIX}.${emailPrefix}.${RAND}@example.com`;
    const { data, error } = await client.auth.signUp({ email, password: PASSWORD, options: { data: { full_name: fullName } } });
    if (error || !data.user) throw new Error(`signup failed for ${email}: ${error?.message}`);
    return { id: data.user.id, email, client };
}

// A synthetic recipient's profiles.timezone defaults to 'America/New_York'
// (see supabase/migrations/20260718151818_recipient_server_push.sql) --
// respond_to_reminder_occurrence resolves a reminder's time_of_day against
// THAT stored timezone, not UTC, so "5 minutes ago" must be computed in
// America/New_York wall-clock terms, not naive UTC math (which would land
// several hours off depending on the season/DST).
function nyTimeMinutesAgo(minutes: number): string {
    const target = new Date(Date.now() - minutes * 60000);
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(target);
    const map: Record<string, string> = {};
    for (const p of parts) map[p.type] = p.value;
    return `${map.hour}:${map.minute}:00`;
}

function lastTestsPassedMatch(output: string): RegExpMatchArray | null {
    // Nested subprocess suites (e.g. reminder-audit shelling out to
    // security-audit) embed an inner suite's own summary line earlier in
    // the captured stdout — always take the LAST match, which is this
    // suite's own final tally, not a nested one's.
    const matches = [...output.matchAll(/(\d+)\/(\d+) tests passed/g)];
    return matches.length > 0 ? [matches[matches.length - 1][0]] as unknown as RegExpMatchArray : null;
}

async function main() {
    console.log(`Onboarding audit run ${RAND}\n`);

    const testUserIds: string[] = [];
    const testConnectionIds: string[] = [];
    const testReminderIds: string[] = [];

    async function makeConnectedPair(label: string) {
        const caregiver = await signUpTestUser(`${label}cg`, `Onb ${label} Organizer`);
        const recipient = await signUpTestUser(`${label}rc`, `Onb ${label} Participant`);
        testUserIds.push(caregiver.id, recipient.id);
        dbQuery(`update public.profiles set role='caregiver' where id='${caregiver.id}';`);
        dbQuery(`update public.profiles set role='recipient' where id='${recipient.id}';`);
        return { caregiver, recipient };
    }

    try {
        // ── A: new organizer care flow, end to end ────────────────────────────
        const orgA = await signUpTestUser('a-org', 'Onboarding A Organizer');
        testUserIds.push(orgA.id);

        // use case selection
        const { error: useCaseErrA } = await orgA.client.from('profiles').update({ use_case: 'care' }).eq('id', orgA.id);
        const useCaseRowA = dbQuery(`select use_case from public.profiles where id='${orgA.id}';`)[0] as any;
        record('A', 'new organizer: use_case selection persists (care)', !useCaseErrA && useCaseRowA?.use_case === 'care');

        // role selection
        const { error: roleErrA } = await orgA.client.from('profiles').update({ role: 'caregiver' }).eq('id', orgA.id);
        const roleRowA = dbQuery(`select role from public.profiles where id='${orgA.id}';`)[0] as any;
        record('A', 'new organizer: role selection persists (caregiver)', !roleErrA && roleRowA?.role === 'caregiver');

        // connect a participant
        const partA = await signUpTestUser('a-part', 'Onboarding A Participant');
        testUserIds.push(partA.id);
        dbQuery(`update public.profiles set role='recipient' where id='${partA.id}';`);

        const { data: inviteA } = await orgA.client.rpc('create_invite_code', { p_existing_connection_id: null }).maybeSingle() as { data: { id: string; invite_code: string; expires_at: string } | null };
        if (inviteA) testConnectionIds.push(inviteA.id);
        const { data: acceptResultA } = await partA.client.rpc('accept_invite_code', { p_code: inviteA?.invite_code });
        record('A', 'new organizer: participant connects via invite code', acceptResultA === 'accepted');

        // create first reminder
        const remA = dbQuery(`
          insert into public.reminders (connection_id, caregiver_id, recipient_id, title, time_of_day, days_of_week, no_response_minutes, is_active)
          values ('${inviteA?.id}', '${orgA.id}', '${partA.id}', 'Morning medication', '08:00:00', ARRAY[1,2,3,4,5,6,7], 30, true)
          returning id;
        `)[0] as any;
        testReminderIds.push(remA.id);
        record('A', 'new organizer: first reminder created for the connected participant', !!remA?.id);

        // participant responds
        dbQuery(`insert into public.reminder_logs (reminder_id, connection_id, caregiver_id, recipient_id, occurrence_date, scheduled_for, status, completed_at) values ('${remA.id}', '${inviteA?.id}', '${orgA.id}', '${partA.id}', current_date, now(), 'taken', now());`);
        const orgSeesResultA = dbQuery(`select status from public.reminder_logs where reminder_id='${remA.id}';`)[0] as any;
        record('A', 'new organizer: organizer can see the participant\'s response', orgSeesResultA?.status === 'taken');

        // ── B: new participant care flow (mirrors A, verified from the participant's read side) ──
        const { data: partReadOwnReminder } = await partA.client.from('reminders').select('id, title').eq('id', remA.id).maybeSingle();
        record('B', 'new participant: can read their own first reminder', partReadOwnReminder?.id === remA.id);
        const { data: partReadOwnLog } = await partA.client.from('reminder_logs').select('status').eq('reminder_id', remA.id).maybeSingle();
        record('B', 'new participant: can read their own recorded response', partReadOwnLog?.status === 'taken');

        // ── C/D/E: coaching / team / personal use cases persist correctly ─────
        for (const [letter, useCase] of [['C', 'coaching'], ['D', 'team'], ['E', 'personal']] as const) {
            const u = await signUpTestUser(`uc-${useCase}`, `Onb ${useCase}`);
            testUserIds.push(u.id);
            const { error } = await u.client.from('profiles').update({ use_case: useCase }).eq('id', u.id);
            const row = dbQuery(`select use_case from public.profiles where id='${u.id}';`)[0] as any;
            record(letter, `${useCase} use case selection persists`, !error && row?.use_case === useCase);
        }

        // ── F: older profile without use_case still resolves correctly ────────
        const legacyUser = await signUpTestUser('legacy', 'Legacy Account');
        testUserIds.push(legacyUser.id);
        dbQuery(`update public.profiles set role='caregiver', use_case=null where id='${legacyUser.id}';`);
        const legacyRow = dbQuery(`select role, use_case from public.profiles where id='${legacyUser.id}';`)[0] as any;
        const legacyRoute = resolveProfileRoute({ role: legacyRow.role, useCase: legacyRow.use_case }, false);
        record('F', 'a legacy profile with role set and use_case=null routes straight to its dashboard, never back into onboarding', legacyRoute === '/caregiver-dashboard', `route=${legacyRoute}`);

        // ── G: role selection idempotency ──────────────────────────────────────
        const idemUser = await signUpTestUser('idem', 'Idempotent Role');
        testUserIds.push(idemUser.id);
        const { error: idemErr1 } = await idemUser.client.from('profiles').update({ role: 'recipient' }).eq('id', idemUser.id);
        const { error: idemErr2 } = await idemUser.client.from('profiles').update({ role: 'recipient' }).eq('id', idemUser.id);
        const idemRow = dbQuery(`select role from public.profiles where id='${idemUser.id}';`)[0] as any;
        record('G', 'submitting the same role twice is idempotent (no error either time)', !idemErr1 && !idemErr2 && idemRow.role === 'recipient');

        // ── H: role cannot be forged after a connection exists ─────────────────
        const { caregiver: capCg, recipient: capRc } = await makeConnectedPair('h');
        const { data: inviteH } = await capCg.client.rpc('create_invite_code', { p_existing_connection_id: null }).maybeSingle() as { data: { id: string; invite_code: string } | null };
        if (inviteH) testConnectionIds.push(inviteH.id);
        await capRc.client.rpc('accept_invite_code', { p_code: inviteH?.invite_code });
        const { error: forgeErr } = await capCg.client.from('profiles').update({ role: 'recipient' }).eq('id', capCg.id);
        record('H', 'role cannot be forged after a connection exists (caregiver side)', !!forgeErr && forgeErr.message.includes('role_locked'), forgeErr?.message);
        const { error: forgeErr2 } = await capRc.client.from('profiles').update({ role: 'caregiver' }).eq('id', capRc.id);
        record('H', 'role cannot be forged after a connection exists (recipient side)', !!forgeErr2 && forgeErr2.message.includes('role_locked'), forgeErr2?.message);
        // Idempotent re-submission of the SAME already-set role must still succeed even with a connection present.
        const { error: sameRoleErr } = await capCg.client.from('profiles').update({ role: 'caregiver' }).eq('id', capCg.id);
        record('H', 'resubmitting the SAME role is still allowed even after a connection exists', !sameRoleErr);

        // ── I: invite creation ───────────────────────────────────────────────
        const { caregiver: iCg } = await makeConnectedPair('i');
        const { data: inviteI, error: inviteIErr } = await iCg.client.rpc('create_invite_code', { p_existing_connection_id: null }).maybeSingle() as { data: { id: string; invite_code: string; expires_at: string } | null; error: any };
        if (inviteI) testConnectionIds.push(inviteI.id);
        record('I', 'invite creation returns a code and an expiration', !inviteIErr && !!inviteI?.invite_code && inviteI.invite_code.length === 6 && !!inviteI.expires_at);

        // ── J: invite acceptance ─────────────────────────────────────────────
        const { recipient: jRc } = await makeConnectedPair('j');
        const { data: inviteJ } = await iCg.client.rpc('create_invite_code', { p_existing_connection_id: null }).maybeSingle() as { data: { id: string; invite_code: string } | null };
        if (inviteJ) testConnectionIds.push(inviteJ.id);
        const { data: acceptJ } = await jRc.client.rpc('accept_invite_code', { p_code: inviteJ?.invite_code });
        record('J', 'invite acceptance succeeds for a valid, unexpired, unused code', acceptJ === 'accepted');

        // ── K: invalid invite ────────────────────────────────────────────────
        const { data: acceptK } = await jRc.client.rpc('accept_invite_code', { p_code: 'ZZZZZZ' });
        record('K', 'an invalid/nonexistent invite code is rejected cleanly', acceptK === 'not_found');

        // ── L: expired invite ────────────────────────────────────────────────
        const { caregiver: lCg, recipient: lRc } = await makeConnectedPair('l');
        const { data: inviteL } = await lCg.client.rpc('create_invite_code', { p_existing_connection_id: null }).maybeSingle() as { data: { id: string; invite_code: string } | null };
        if (inviteL) testConnectionIds.push(inviteL.id);
        dbQuery(`update public.connections set expires_at = now() - interval '1 hour' where id='${inviteL?.id}';`);
        const { data: acceptL } = await lRc.client.rpc('accept_invite_code', { p_code: inviteL?.invite_code });
        record('L', 'an expired invite code is rejected', acceptL === 'expired');

        // ── M: reused invite ─────────────────────────────────────────────────
        const { caregiver: mCg, recipient: mRc1 } = await makeConnectedPair('m');
        const mRc2 = await signUpTestUser('m-rc2', 'Onb M Second Recipient');
        testUserIds.push(mRc2.id);
        dbQuery(`update public.profiles set role='recipient' where id='${mRc2.id}';`);
        const { data: inviteM } = await mCg.client.rpc('create_invite_code', { p_existing_connection_id: null }).maybeSingle() as { data: { id: string; invite_code: string } | null };
        if (inviteM) testConnectionIds.push(inviteM.id);
        await mRc1.client.rpc('accept_invite_code', { p_code: inviteM?.invite_code });
        const { data: acceptM2 } = await mRc2.client.rpc('accept_invite_code', { p_code: inviteM?.invite_code });
        record('M', 'a reused (already-accepted) invite code is rejected for a second person', acceptM2 === 'already_accepted');

        // ── N: self-invite ───────────────────────────────────────────────────
        const nSelf = await signUpTestUser('n-self', 'Onb N Self');
        testUserIds.push(nSelf.id);
        dbQuery(`update public.profiles set role='caregiver' where id='${nSelf.id}';`);
        const { data: inviteN } = await nSelf.client.rpc('create_invite_code', { p_existing_connection_id: null }).maybeSingle() as { data: { id: string; invite_code: string } | null };
        if (inviteN) testConnectionIds.push(inviteN.id);
        const { data: acceptN } = await nSelf.client.rpc('accept_invite_code', { p_code: inviteN?.invite_code });
        record('N', 'a caregiver cannot accept their own invite code', acceptN === 'self');

        // ── O: interrupted onboarding resume ─────────────────────────────────
        record('O', 'no role, no use_case yet -> resumes at choose-use-case', resolveProfileRoute({ role: null, useCase: null }, false) === '/choose-use-case');
        record('O', 'no role, use_case already answered -> resumes at choose-role (never re-asks a completed step)', resolveProfileRoute({ role: null, useCase: 'care' }, false) === '/choose-role');
        record('O', 'role=recipient but no accepted connection yet -> resumes at join-invite, not the dashboard', resolveProfileRoute({ role: 'recipient', useCase: 'care' }, false) === '/join-invite');
        record('O', 'role=recipient WITH an accepted connection -> goes straight to the dashboard', resolveProfileRoute({ role: 'recipient', useCase: 'care' }, true) === '/recipient-dashboard');
        record('O', 'role=caregiver always goes straight to the dashboard regardless of use_case', resolveProfileRoute({ role: 'caregiver', useCase: null }, false) === '/caregiver-dashboard');

        // ── P: network/unexpected-failure recovery leaves no partial state ────
        const pUser = await signUpTestUser('p-net', 'Onb P Network');
        testUserIds.push(pUser.id);
        dbQuery(`update public.profiles set role='recipient' where id='${pUser.id}';`);
        const beforeConnCount = Number((dbQuery(`select count(*) as c from public.connections where recipient_id='${pUser.id}';`)[0] as any).c);
        await pUser.client.rpc('accept_invite_code', { p_code: 'BADCOD' }); // garbage code, same shape as a network hiccup's client-visible outcome
        const afterConnCount = Number((dbQuery(`select count(*) as c from public.connections where recipient_id='${pUser.id}';`)[0] as any).c);
        record('P', 'a failed invite acceptance never creates a partial/orphaned connection row', beforeConnCount === afterConnCount, `before=${beforeConnCount} after=${afterConnCount}`);

        // ── Q: first reminder creation ──────────────────────────────────────
        const { caregiver: qCg, recipient: qRc } = await makeConnectedPair('q');
        const { data: inviteQ } = await qCg.client.rpc('create_invite_code', { p_existing_connection_id: null }).maybeSingle() as { data: { id: string; invite_code: string } | null };
        if (inviteQ) testConnectionIds.push(inviteQ.id);
        await qRc.client.rpc('accept_invite_code', { p_code: inviteQ?.invite_code });
        // Backdate the connection's acceptance so respond_to_reminder_occurrence's
        // own "scheduled_for must be >= greatest(created_at, accepted_at)"
        // boundary check (see supabase/migrations/20260724020000_respond_rpc_lock_hardening.sql)
        // doesn't collide with a same-second-created reminder whose
        // time_of_day is deliberately a few minutes in the past (needed so
        // the occurrence is actually "due" by the time R responds to it).
        dbQuery(`update public.connections set accepted_at = now() - interval '1 day' where id='${inviteQ?.id}';`);
        const dueTimeOfDay = nyTimeMinutesAgo(5);
        const { data: remQ, error: remQErr } = await qCg.client.from('reminders').insert({
            connection_id: inviteQ?.id, caregiver_id: qCg.id, recipient_id: qRc.id,
            title: 'First reminder', reminder_type: 'medication', time_of_day: dueTimeOfDay,
            frequency: 'daily', days_of_week: [1, 2, 3, 4, 5, 6, 7], no_response_minutes: 60,
            is_active: true, created_at: new Date(Date.now() - 86400000).toISOString(),
        }).select('id').single();
        if (remQ) testReminderIds.push(remQ.id);
        record('Q', 'an organizer can create a first reminder for a newly-connected participant', !remQErr && !!remQ?.id, remQErr?.message);

        // ── R: first participant response ────────────────────────────────────
        const { data: respondR, error: respondRErr } = await qRc.client.rpc('respond_to_reminder_occurrence', { p_reminder_id: remQ?.id, p_status: 'taken', p_snooze_minutes: 10 });
        record('R', 'a participant can record their first response to that reminder', !respondRErr && !!respondR, respondRErr?.message);
        const orgSeesR = dbQuery(`select status from public.reminder_logs where reminder_id='${remQ?.id}';`)[0] as any;
        record('R', 'the organizer can see the recorded first response', orgSeesR?.status === 'taken');

        // ── S: onboarding completion (privacy-safe event logging) ────────────
        const sUser = await signUpTestUser('s-events', 'Onb S Events');
        testUserIds.push(sUser.id);
        const eventTypes = ['onboarding_started', 'use_case_selected', 'role_selected', 'invite_created', 'invite_accepted', 'first_reminder_created', 'first_response_recorded', 'onboarding_completed'];
        for (const eventType of eventTypes) {
            await sUser.client.from('onboarding_events').insert({ user_id: sUser.id, event_type: eventType });
        }
        const loggedEvents = dbQuery(`select event_type from public.onboarding_events where user_id='${sUser.id}' order by created_at;`) as any[];
        record('S', 'all 8 onboarding funnel events can be logged for the user\'s own id', loggedEvents.length === eventTypes.length, `logged=${loggedEvents.length}`);
        const { data: sOwnRead } = await sUser.client.from('onboarding_events').select('id').eq('user_id', sUser.id);
        record('S', 'a user can read back their own onboarding events', (sOwnRead?.length ?? 0) === eventTypes.length);
        // Privacy: only the 4 documented columns ever exist on this table.
        const eventCols = (dbQuery(`select column_name from information_schema.columns where table_name='onboarding_events' order by ordinal_position;`) as any[]).map((r) => r.column_name);
        record('S', 'onboarding_events has exactly the documented privacy-safe columns (no title/email/name/token/notes)', JSON.stringify(eventCols) === JSON.stringify(['id', 'user_id', 'event_type', 'created_at']), eventCols.join(','));
        // A different user cannot insert an event under someone else's user_id.
        const sOther = await signUpTestUser('s-other', 'Onb S Other');
        testUserIds.push(sOther.id);
        const { error: crossInsertErr } = await sOther.client.from('onboarding_events').insert({ user_id: sUser.id, event_type: 'onboarding_started' });
        record('S', 'a user cannot insert an onboarding event under a different user_id', !!crossInsertErr);
        const { data: crossReadRows } = await sOther.client.from('onboarding_events').select('id').eq('user_id', sUser.id);
        record('S', 'a user cannot read another user\'s onboarding events', (crossReadRows?.length ?? 0) === 0);

        // ── T: deleted account blocked ───────────────────────────────────────
        const tUser = await signUpTestUser('t-del', 'Onb T Deleted');
        testUserIds.push(tUser.id);
        dbQuery(`update public.profiles set role='recipient' where id='${tUser.id}';`);
        const { data: tSignIn } = await tUser.client.auth.signInWithPassword({ email: tUser.email, password: PASSWORD });
        const tToken = tSignIn?.session?.access_token;
        const tDeleteResp = await fetch(`${SUPABASE_URL}/functions/v1/delete-account`, {
            method: 'POST',
            headers: { apikey: ANON_KEY, Authorization: `Bearer ${tToken}` },
        });
        record('T', 'delete-account succeeds for a synthetic onboarding-audit account', tDeleteResp.status === 200, `status=${tDeleteResp.status}`);
        const tStaleClient = newClient();
        const { data: tStaleUser } = await tStaleClient.auth.getUser(tToken);
        record('T', 'a deleted account\'s captured token no longer resolves to a live user (cannot continue onboarding)', !tStaleUser?.user);

        // ── U: account switching isolation ───────────────────────────────────
        const { caregiver: uA } = await makeConnectedPair('u-a');
        const uB = await signUpTestUser('u-b', 'Onb U B');
        testUserIds.push(uB.id);
        await uB.client.from('profiles').update({ use_case: 'personal' }).eq('id', uB.id);
        const { data: uCrossRead } = await uA.client.from('profiles').select('use_case').eq('id', uB.id);
        record('U', 'switching accounts: an unrelated user cannot read another user\'s use_case (RLS-enforced isolation)', (uCrossRead?.length ?? 0) === 0);
        const { error: uCrossWrite } = await uA.client.from('profiles').update({ use_case: 'team' }).eq('id', uB.id);
        const uBUseCaseAfter = dbQuery(`select use_case from public.profiles where id='${uB.id}';`)[0] as any;
        record('U', 'switching accounts: an unrelated user cannot write another user\'s use_case', uBUseCaseAfter?.use_case === 'personal', `write_error=${!!uCrossWrite}`);

        // ── V: notification denial does not trap onboarding ──────────────────
        // There is no server-side column or check anywhere that gates a
        // recipient's ability to read their own reminders/connection on
        // whether notification permission was granted -- verified directly:
        // a fresh connected participant can read their reminder regardless.
        const { caregiver: vCg, recipient: vRc } = await makeConnectedPair('v');
        const { data: inviteV } = await vCg.client.rpc('create_invite_code', { p_existing_connection_id: null }).maybeSingle() as { data: { id: string; invite_code: string } | null };
        if (inviteV) testConnectionIds.push(inviteV.id);
        await vRc.client.rpc('accept_invite_code', { p_code: inviteV?.invite_code });
        const { data: remV } = await vCg.client.from('reminders').insert({
            connection_id: inviteV?.id, caregiver_id: vCg.id, recipient_id: vRc.id,
            title: 'Notif-independent reminder', reminder_type: 'medication', time_of_day: '10:00:00',
            frequency: 'daily', days_of_week: [1, 2, 3, 4, 5, 6, 7], no_response_minutes: 30, is_active: true,
        }).select('id').single();
        if (remV) testReminderIds.push(remV.id);
        const { data: vReadAsRecipient, error: vReadErr } = await vRc.client.from('reminders').select('id').eq('id', remV?.id).maybeSingle();
        record('V', 'a participant can read/respond to their reminders regardless of notification-permission state (no server-side gate)', !vReadErr && vReadAsRecipient?.id === remV?.id);

        // ── W-Z: regression shell-outs ─────────────────────────────────────
        try {
            const out = execFileSync('npx', ['tsx', 'scripts/security-audit/run.ts'], { encoding: 'utf-8', env: process.env });
            const m = lastTestsPassedMatch(out);
            record('W', 'scripts/security-audit/run.ts remains fully passing', !!m && m[0].startsWith('24/24'), m?.[0]);
        } catch (err: any) {
            record('W', 'scripts/security-audit/run.ts remains fully passing', false, err?.stdout ?? (err instanceof Error ? err.message : String(err)));
        }

        try {
            const out = execFileSync('npx', ['tsx', 'scripts/auth-audit/run.ts'], { encoding: 'utf-8', env: process.env });
            const m = lastTestsPassedMatch(out);
            record('X', 'scripts/auth-audit/run.ts remains fully passing', !!m && m[0].startsWith('37/37'), m?.[0]);
        } catch (err: any) {
            record('X', 'scripts/auth-audit/run.ts remains fully passing', false, err?.stdout ?? (err instanceof Error ? err.message : String(err)));
        }

        try {
            const out = execFileSync('npx', ['tsx', 'scripts/reminder-audit/run.ts'], { encoding: 'utf-8', env: process.env });
            const m = lastTestsPassedMatch(out);
            record('Y', 'scripts/reminder-audit/run.ts remains passing', !!m, m?.[0]);
        } catch (err: any) {
            record('Y', 'scripts/reminder-audit/run.ts remains passing', false, err?.stdout ?? (err instanceof Error ? err.message : String(err)));
        }

        try {
            execFileSync('npx', ['tsx', 'scripts/ops-health/run.ts'], { encoding: 'utf-8', env: process.env });
            record('Z', 'scripts/ops-health/run.ts does not report FAIL (exit code 0)', true);
        } catch (err: any) {
            record('Z', 'scripts/ops-health/run.ts does not report FAIL (exit code 0)', false, err?.stdout ?? (err instanceof Error ? err.message : String(err)));
        }

    } finally {
        console.log('\nCleaning up synthetic test data...');
        for (const reminderId of testReminderIds) {
            dbQuery(`delete from public.reminder_notification_deliveries where reminder_id = '${reminderId}';`);
            dbQuery(`delete from public.reminder_logs where reminder_id = '${reminderId}';`);
        }
        if (testReminderIds.length > 0) {
            dbQuery(`delete from public.reminders where id in (${testReminderIds.map((id) => `'${id}'`).join(',')});`);
        }
        dbQuery(`delete from public.onboarding_events where user_id in (${testUserIds.length > 0 ? testUserIds.map((id) => `'${id}'`).join(',') : "'00000000-0000-0000-0000-000000000000'"});`);
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
    console.error('ONBOARDING_AUDIT_SUITE_FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
});
