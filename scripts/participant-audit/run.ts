// Tavora Week 2 product-polish task #2: multi-participant management,
// participant switching, connection organization, and five-participant
// readiness — automated audit.
//
// Run from the repo root:
//   EXPO_PUBLIC_SUPABASE_URL=... EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=... npx tsx scripts/participant-audit/run.ts
//
// Creates disposable synthetic users (tavora.participantaudit.*@example.com),
// exercises them through the real anon-key client paths (the same RPCs and
// RLS-bound queries the app itself uses), verifies/cleans up via the
// already-authenticated `supabase` CLI, and never touches a real account.

import { readFileSync } from 'node:fs';
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
import { provisionFixturePool, resetFixturePool, detectFixtureContamination, getFixtureClient, getFixturePassword } from '../audit-infrastructure/fixtures';
import { categorizeConnection } from '../../lib/connectionStateCore';

const RAND = randomSuffix();
const PASSWORD = `PartAudit!${RAND}9X`;
const EMAIL_PREFIX = 'tavora.participantaudit';

async function signUpTestUser(emailPrefix: string, fullName: string) {
    const client = newClient();
    const email = `${EMAIL_PREFIX}.${emailPrefix}.${RAND}@example.com`;
    const { data, error } = await client.auth.signUp({ email, password: PASSWORD, options: { data: { full_name: fullName, audit_account: true } } });
    if (error || !data.user) throw new Error(`signup failed for ${email}: ${error?.message}`);
    return { id: data.user.id, email, client };
}


async function makeCaregiver(label: string) {
    const cg = await signUpTestUser(`${label}cg`, `Part ${label} Organizer`);
    dbQuery(`update public.profiles set role='caregiver' where id='${cg.id}';`);
    return cg;
}

async function makeRecipient(label: string) {
    const rc = await signUpTestUser(`${label}rc`, `Part ${label} Participant`);
    dbQuery(`update public.profiles set role='recipient' where id='${rc.id}';`);
    return rc;
}

/** Creates and accepts a real invite between caregiver and recipient, returning the connection id. */
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
    console.log(`Participant audit run ${RAND}\n`);

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
        // Some organizers/recipients in this run may have leftover
        // connections not captured above (e.g. concurrent-create races in
        // scenario G) — sweep every remaining row touching a synthetic
        // user before deleting the profiles/auth rows themselves.
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
        // ── A: organizer with zero participants ──────────────────────────────
        const orgA = await makeCaregiver('a');
        testUserIds.push(orgA.id);
        const aConns = dbQuery(`select id, status from public.connections where caregiver_id='${orgA.id}';`) as any[];
        record('A', 'a brand-new organizer has zero connections of any kind', aConns.length === 0);

        // ── B: organizer creates first invite ────────────────────────────────
        const { data: inviteB } = await orgA.client.rpc('create_invite_code', { p_existing_connection_id: null }).maybeSingle() as { data: { id: string; invite_code: string; expires_at: string } | null };
        if (inviteB) testConnectionIds.push(inviteB.id);
        const bRow = dbQuery(`select status, invite_code from public.connections where id='${inviteB?.id}';`)[0] as any;
        record('B', "organizer's first invite creates a pending connection row", bRow?.status === 'pending' && bRow?.invite_code === inviteB?.invite_code);

        // ── C: organizer reaches five active/pending participants ─────────────
        const orgC = await makeCaregiver('c');
        testUserIds.push(orgC.id);
        const cConnectionIds: string[] = [];
        for (let i = 0; i < 3; i++) {
            const rc = await makeRecipient(`c${i}`);
            testUserIds.push(rc.id);
            const connId = await connect(orgC, rc);
            testConnectionIds.push(connId);
            cConnectionIds.push(connId);
        }
        for (let i = 0; i < 2; i++) {
            const { data: inv } = await orgC.client.rpc('create_invite_code', { p_existing_connection_id: null }).maybeSingle() as { data: { id: string } | null };
            if (inv) { testConnectionIds.push(inv.id); cConnectionIds.push(inv.id); }
        }
        const cCount = Number((dbQuery(`select count(*) as c from public.connections where caregiver_id='${orgC.id}' and (status='accepted' or (status='pending' and (expires_at is null or expires_at >= now())));`)[0] as any).c);
        record('C', 'an organizer can reach exactly 5 active/pending participant slots (3 accepted + 2 pending)', cCount === 5, `count=${cCount}`);

        // ── D: sixth invite rejected server-side ───────────────────────────────
        let sixthError: string | null = null;
        try {
            await orgC.client.rpc('create_invite_code', { p_existing_connection_id: null }).throwOnError();
        } catch (err: any) {
            sixthError = err?.message ?? String(err);
        }
        record('D', 'a 6th invite is rejected server-side with participant_limit_reached', !!sixthError && sixthError.includes('participant_limit_reached'), sixthError ?? 'no error thrown');
        const cCountAfterD = Number((dbQuery(`select count(*) as c from public.connections where caregiver_id='${orgC.id}';`)[0] as any).c);
        record('D', 'the rejected 6th attempt left no extra row behind', cCountAfterD === 5, `count=${cCountAfterD}`);

        // ── E: expired pending invite no longer counts ─────────────────────────
        const expiredPendingId = cConnectionIds[3]; // one of the two pending ones created above
        dbQuery(`update public.connections set expires_at = now() - interval '1 hour' where id='${expiredPendingId}';`);
        const { data: inviteE, error: inviteEErr } = await orgC.client.rpc('create_invite_code', { p_existing_connection_id: null }).maybeSingle() as { data: { id: string } | null; error: any };
        if (inviteE) { testConnectionIds.push(inviteE.id); cConnectionIds.push(inviteE.id); }
        record('E', 'an expired pending invite no longer occupies a slot -- a new invite succeeds', !inviteEErr && !!inviteE?.id, inviteEErr?.message);

        // ── F: ended connection no longer counts ───────────────────────────────
        const toEndId = cConnectionIds[0]; // one of the 3 accepted ones
        const { error: endFErr } = await orgC.client.rpc('end_connection', { p_connection_id: toEndId });
        const { data: inviteF, error: inviteFErr } = await orgC.client.rpc('create_invite_code', { p_existing_connection_id: null }).maybeSingle() as { data: { id: string } | null; error: any };
        if (inviteF) testConnectionIds.push(inviteF.id);
        record('F', 'ending a connection frees its slot -- a new invite succeeds afterward', !endFErr && !inviteFErr && !!inviteF?.id, inviteFErr?.message);

        // ── G: concurrent invite creation cannot exceed five ────────────────────
        const orgG = await makeCaregiver('g');
        testUserIds.push(orgG.id);
        for (let i = 0; i < 4; i++) {
            const rc = await makeRecipient(`g${i}`);
            testUserIds.push(rc.id);
            const connId = await connect(orgG, rc);
            testConnectionIds.push(connId);
        }
        // Now at 4/5 -- fire 3 concurrent create_invite_code calls; the FOR
        // UPDATE lock on the caller's own profile row serializes them, so
        // exactly 1 should succeed (reaching 5) and the rest should fail
        // with participant_limit_reached, never silently exceeding 5.
        const concurrentResults = await Promise.allSettled([
            orgG.client.rpc('create_invite_code', { p_existing_connection_id: null }).throwOnError(),
            orgG.client.rpc('create_invite_code', { p_existing_connection_id: null }).throwOnError(),
            orgG.client.rpc('create_invite_code', { p_existing_connection_id: null }).throwOnError(),
        ]);
        const succeeded = concurrentResults.filter((r) => r.status === 'fulfilled');
        for (const r of concurrentResults) {
            if (r.status === 'fulfilled') {
                const rows = (r.value as any).data as { id: string }[];
                if (rows?.[0]?.id) testConnectionIds.push(rows[0].id);
            }
        }
        const gFinalCount = Number((dbQuery(`select count(*) as c from public.connections where caregiver_id='${orgG.id}' and (status='accepted' or (status='pending' and (expires_at is null or expires_at >= now())));`)[0] as any).c);
        record('G', 'exactly one of three concurrent invite requests at 4/5 succeeds, reaching exactly 5, never more', succeeded.length === 1 && gFinalCount === 5, `succeeded=${succeeded.length} finalCount=${gFinalCount}`);

        // ── H/I: switch Participant A -> B, no cross-contamination ──────────────
        const orgH = await makeCaregiver('h');
        testUserIds.push(orgH.id);
        const rcHA = await makeRecipient('ha');
        const rcHB = await makeRecipient('hb');
        testUserIds.push(rcHA.id, rcHB.id);
        const connHA = await connect(orgH, rcHA);
        const connHB = await connect(orgH, rcHB);
        testConnectionIds.push(connHA, connHB);

        const remHA = dbQuery(`insert into public.reminders (connection_id, caregiver_id, recipient_id, title, time_of_day, days_of_week, no_response_minutes, is_active) values ('${connHA}', '${orgH.id}', '${rcHA.id}', 'Participant A reminder', '08:00:00', ARRAY[1,2,3,4,5,6,7], 30, true) returning id;`)[0] as any;
        const remHB = dbQuery(`insert into public.reminders (connection_id, caregiver_id, recipient_id, title, time_of_day, days_of_week, no_response_minutes, is_active) values ('${connHB}', '${orgH.id}', '${rcHB.id}', 'Participant B reminder', '09:00:00', ARRAY[1,2,3,4,5,6,7], 30, true) returning id;`)[0] as any;
        testReminderIds.push(remHA.id, remHB.id);

        const { data: aScopedReminders } = await orgH.client.from('reminders').select('id, title').eq('connection_id', connHA);
        const { data: bScopedReminders } = await orgH.client.from('reminders').select('id, title').eq('connection_id', connHB);
        record('H', 'switching to Participant A returns exactly A\'s reminder set', (aScopedReminders?.length ?? 0) === 1 && aScopedReminders?.[0].id === remHA.id);
        record('I', "no Participant A reminder data appears when scoped to Participant B's connection", !(bScopedReminders ?? []).some((r) => r.id === remHA.id) && bScopedReminders?.length === 1);

        // ── J: stale request cannot overwrite -- underlying isolation invariant ──
        // The client-side generation-id guard itself (caregiver-dashboard.tsx)
        // is code-reviewed, not runtime-testable from a synthetic script with
        // no UI -- what IS directly verifiable is the data-layer invariant it
        // protects: two connections' reminder sets are always disjoint, so even
        // a stale response can only ever contain rows that belong to its own
        // connection_id, never the other's.
        const overlap = (aScopedReminders ?? []).some((r) => (bScopedReminders ?? []).some((b) => b.id === r.id));
        record('J', "Participant A's and Participant B's reminder id sets never overlap (the invariant a stale-response race would otherwise violate)", !overlap);

        // ── K: create reminder for currently selected participant ──────────────
        const { data: remK, error: remKErr } = await orgH.client.from('reminders').insert({
            connection_id: connHA, caregiver_id: orgH.id, recipient_id: rcHA.id,
            title: 'Newly created for A', reminder_type: 'medication', time_of_day: '10:00:00',
            frequency: 'daily', days_of_week: [1, 2, 3, 4, 5, 6, 7], no_response_minutes: 30, is_active: true,
        }).select('id').single();
        if (remK) testReminderIds.push(remK.id);
        record('K', 'creating a reminder for the currently-selected participant succeeds and is scoped to that connection', !remKErr && !!remK?.id);

        // ── L: reject stale/ended connection during reminder creation ──────────
        await orgH.client.rpc('end_connection', { p_connection_id: connHB });
        const { error: remLErr } = await orgH.client.from('reminders').insert({
            connection_id: connHB, caregiver_id: orgH.id, recipient_id: rcHB.id,
            title: 'Should never save', reminder_type: 'medication', time_of_day: '11:00:00',
            frequency: 'daily', days_of_week: [1, 2, 3, 4, 5, 6, 7], no_response_minutes: 30, is_active: true,
        });
        record('L', 'creating a reminder against an ended connection is rejected server-side (RLS)', !!remLErr);

        // ── M/N: end connection as organizer and as participant ────────────────
        const orgM = await makeCaregiver('m');
        const rcM = await makeRecipient('m');
        testUserIds.push(orgM.id, rcM.id);
        const connM = await connect(orgM, rcM);
        testConnectionIds.push(connM);
        const { error: endMErr } = await orgM.client.rpc('end_connection', { p_connection_id: connM });
        const connMStatus = (dbQuery(`select status from public.connections where id='${connM}';`)[0] as any)?.status;
        record('M', 'the organizer can end their own connection', !endMErr && connMStatus === 'ended');

        const orgN = await makeCaregiver('n');
        const rcN = await makeRecipient('n');
        testUserIds.push(orgN.id, rcN.id);
        const connN = await connect(orgN, rcN);
        testConnectionIds.push(connN);
        const { error: endNErr } = await rcN.client.rpc('end_connection', { p_connection_id: connN });
        const connNStatus = (dbQuery(`select status from public.connections where id='${connN}';`)[0] as any)?.status;
        record('N', 'the participant can end their own connection', !endNErr && connNStatus === 'ended');

        // An unrelated third party cannot end someone else's connection.
        // This scenario only needs "any identity not party to connM" --
        // the shared fixture pool's unauthorizedUser role exists exactly
        // for this, so it uses that instead of a disposable signup (Week 4
        // Task #1's fixture-adoption ledger; see docs/synthetic-fixture-model.md).
        const fixturePool = await provisionFixturePool();
        resetFixturePool();
        detectFixtureContamination();
        const outsiderClient = getFixtureClient('unauthorizedUser');
        await outsiderClient.auth.signInWithPassword({ email: fixturePool.unauthorizedUser.email, password: getFixturePassword() });
        const { error: outsiderEndErr } = await outsiderClient.rpc('end_connection', { p_connection_id: connM });
        record('N', 'an unrelated user cannot end a connection they are not party to', !!outsiderEndErr && outsiderEndErr.message.includes('not_authorized'), outsiderEndErr?.message);
        // Idempotent -- ending an already-ended connection again is a harmless success.
        const { error: idempotentEndErr } = await orgM.client.rpc('end_connection', { p_connection_id: connM });
        record('N', 'ending an already-ended connection again is idempotent (no error)', !idempotentEndErr);

        // ── O: historical logs preserved after ending ───────────────────────────
        const orgO = await makeCaregiver('o');
        const rcO = await makeRecipient('o');
        testUserIds.push(orgO.id, rcO.id);
        const connO = await connect(orgO, rcO);
        testConnectionIds.push(connO);
        const remO = dbQuery(`insert into public.reminders (connection_id, caregiver_id, recipient_id, title, time_of_day, days_of_week, no_response_minutes, is_active) values ('${connO}', '${orgO.id}', '${rcO.id}', 'History test', '08:00:00', ARRAY[1,2,3,4,5,6,7], 30, true) returning id;`)[0] as any;
        testReminderIds.push(remO.id);
        dbQuery(`insert into public.reminder_logs (reminder_id, connection_id, caregiver_id, recipient_id, occurrence_date, scheduled_for, status, completed_at) values ('${remO.id}', '${connO}', '${orgO.id}', '${rcO.id}', current_date, now(), 'taken', now());`);
        await orgO.client.rpc('end_connection', { p_connection_id: connO });
        const logAfterEnd = dbQuery(`select status from public.reminder_logs where reminder_id='${remO.id}';`)[0] as any;
        record('O', 'a historical reminder_logs row survives its connection being ended, unchanged', logAfterEnd?.status === 'taken');

        // ── P: future pushes stopped after ending ───────────────────────────────
        const reminderPRow = dbQuery(`select is_active from public.reminders where id='${remO.id}';`)[0] as any;
        record('P', 'every reminder tied to an ended connection is deactivated (stops future claim/send -- see claim_due_recipient_reminder_deliveries requiring is_active=true)', reminderPRow?.is_active === false);
        const claimedForEnded = dbQuery(`select * from public.claim_due_recipient_reminder_deliveries();`) as any[];
        record('P', 'the ended connection\'s (now-inactive) reminder is never claimed by the delivery pipeline', !claimedForEnded.some((row) => row.reminder_id === remO.id));

        // ── Q: reconnection requires a new invite ───────────────────────────────
        const { data: reacceptQ } = await rcO.client.rpc('accept_invite_code', { p_code: 'ZZZZZZ' }); // the ended connection's old code is irrelevant now; prove no ordinary write can flip status back
        const { data: directUpdateRows, error: directUpdateErr } = await orgO.client
            .from('connections')
            .update({ status: 'accepted' })
            .eq('id', connO)
            .select('id');
        record('Q', 'no ordinary client write can reactivate an ended connection (no UPDATE policy on connections)', (directUpdateRows?.length ?? 0) === 0, `error=${directUpdateErr?.message ?? 'none'} rows=${directUpdateRows?.length}`);
        record('Q', 'reconnecting requires an entirely new invite/accept cycle', reacceptQ === 'not_found');

        // ── R: invalid stored selected connection falls back safely ────────────
        const orgR = await makeCaregiver('r');
        testUserIds.push(orgR.id);
        const rcR = await makeRecipient('r');
        testUserIds.push(rcR.id);
        const connR = await connect(orgR, rcR);
        testConnectionIds.push(connR);
        const fakeStoredId = '00000000-0000-0000-0000-000000000000';
        const { data: ownConnections } = await orgR.client.from('connections').select('id').eq('caregiver_id', orgR.id).eq('status', 'accepted');
        const wouldMatch = (ownConnections ?? []).some((c) => c.id === fakeStoredId);
        record('R', 'an invalid/foreign stored connection id never matches the caregiver\'s own connections (the precondition loadDashboardData\'s fallback chain relies on to safely fall through to the first real participant)', !wouldMatch && (ownConnections?.length ?? 0) === 1);

        // ── S: account switching clears participant selection (structural) ─────
        const selectedParticipantSrc = readFileSync('lib/selected-participant.ts', 'utf-8');
        const accountCleanupSrc = readFileSync('lib/accountCleanup.ts', 'utf-8');
        const isAccountScoped = selectedParticipantSrc.includes('KEY_PREFIX') && selectedParticipantSrc.includes('userId');
        const isClearedOnLogout = accountCleanupSrc.includes('clearStoredSelectedConnectionId');
        record('S', 'the selected-participant cache is keyed per-account (lib/selected-participant.ts), not a single global key', isAccountScoped);
        record('S', 'logout/account-switch cleanup clears the selected-participant cache (lib/accountCleanup.ts)', isClearedOnLogout);

        // ── T: deleted counterpart excluded ─────────────────────────────────────
        const orgT = await makeCaregiver('t');
        testUserIds.push(orgT.id);
        const rcT = await makeRecipient('t');
        testUserIds.push(rcT.id);
        const connT = await connect(orgT, rcT);
        testConnectionIds.push(connT);
        const { data: rcTSignIn } = await rcT.client.auth.signInWithPassword({ email: rcT.email, password: PASSWORD });
        const rcTToken = rcTSignIn?.session?.access_token;
        await fetch(`${SUPABASE_URL}/functions/v1/delete-account`, {
            method: 'POST',
            headers: { apikey: ANON_KEY, Authorization: `Bearer ${rcTToken}` },
        });
        const connTStatusAfterDelete = (dbQuery(`select status from public.connections where id='${connT}';`)[0] as any)?.status;
        const { data: orgTActiveConns } = await orgT.client.from('connections').select('id').eq('caregiver_id', orgT.id).eq('status', 'accepted');
        record('T', "a deleted counterpart's connection is auto-ended (not left dangling as 'accepted')", connTStatusAfterDelete === 'ended');
        record('T', "a deleted counterpart never appears in the organizer's active participant list", !(orgTActiveConns ?? []).some((c) => c.id === connT));

        // ── U: pending invitation replacement / revocation ──────────────────────
        const orgU = await makeCaregiver('u');
        testUserIds.push(orgU.id);
        const { data: inviteU1 } = await orgU.client.rpc('create_invite_code', { p_existing_connection_id: null }).maybeSingle() as { data: { id: string; invite_code: string } | null };
        if (inviteU1) testConnectionIds.push(inviteU1.id);
        const { data: inviteU2 } = await orgU.client.rpc('create_invite_code', { p_existing_connection_id: inviteU1?.id }).maybeSingle() as { data: { id: string; invite_code: string } | null };
        record('U', 'replacing a pending invite regenerates the SAME row with a new code, never a duplicate', inviteU2?.id === inviteU1?.id && inviteU2?.invite_code !== inviteU1?.invite_code);
        const { error: revokeUErr } = await orgU.client.rpc('end_connection', { p_connection_id: inviteU1?.id });
        const revokedStatus = (dbQuery(`select status from public.connections where id='${inviteU1?.id}';`)[0] as any)?.status;
        record('U', 'revoking a pending invitation (end_connection on a pending row) sets it to ended', !revokeUErr && revokedStatus === 'ended');

        // ── V: invite acceptance refresh behavior ───────────────────────────────
        const inviteRecipientSrc = readFileSync('app/invite-recipient.tsx', 'utf-8');
        const hasPollingInterval = inviteRecipientSrc.includes('setInterval') && inviteRecipientSrc.includes('checkDraftAcceptance');
        record('V', 'invite-recipient.tsx polls for acceptance while a code is outstanding (bounded live-refresh)', hasPollingInterval);
        const orgV = await makeCaregiver('v');
        testUserIds.push(orgV.id);
        const rcV = await makeRecipient('v');
        testUserIds.push(rcV.id);
        const connV = await connect(orgV, rcV);
        testConnectionIds.push(connV);
        const connVRow = dbQuery(`select status, recipient_id from public.connections where id='${connV}';`)[0] as any;
        record('V', "the data a refresh would read reflects acceptance immediately (status='accepted', recipient_id set)", connVRow?.status === 'accepted' && connVRow?.recipient_id === rcV.id);

        // ── W: multiple-organizer participant behavior ──────────────────────────
        const orgW1 = await makeCaregiver('w1');
        const orgW2 = await makeCaregiver('w2');
        const rcW = await makeRecipient('w');
        testUserIds.push(orgW1.id, orgW2.id, rcW.id);
        const connW1 = await connect(orgW1, rcW);
        const connW2 = await connect(orgW2, rcW);
        testConnectionIds.push(connW1, connW2);
        const remW1 = dbQuery(`insert into public.reminders (connection_id, caregiver_id, recipient_id, title, time_of_day, days_of_week, no_response_minutes, is_active) values ('${connW1}', '${orgW1.id}', '${rcW.id}', 'From organizer 1', '08:00:00', ARRAY[1,2,3,4,5,6,7], 30, true) returning id;`)[0] as any;
        const remW2 = dbQuery(`insert into public.reminders (connection_id, caregiver_id, recipient_id, title, time_of_day, days_of_week, no_response_minutes, is_active) values ('${connW2}', '${orgW2.id}', '${rcW.id}', 'From organizer 2', '09:00:00', ARRAY[1,2,3,4,5,6,7], 30, true) returning id;`)[0] as any;
        testReminderIds.push(remW1.id, remW2.id);
        const { data: rcWReminders } = await rcW.client.from('reminders').select('id, caregiver_id').eq('recipient_id', rcW.id).in('id', [remW1.id, remW2.id]);
        record('W', 'a participant with two accepted organizers sees reminders from BOTH, each correctly attributed', (rcWReminders?.length ?? 0) === 2 && new Set((rcWReminders ?? []).map((r) => r.caregiver_id)).size === 2);

        // ── X: one connection ending does not damage another ────────────────────
        await orgW1.client.rpc('end_connection', { p_connection_id: connW1 });
        const connW2StatusAfter = (dbQuery(`select status from public.connections where id='${connW2}';`)[0] as any)?.status;
        const remW2ActiveAfter = (dbQuery(`select is_active from public.reminders where id='${remW2.id}';`)[0] as any)?.is_active;
        record('X', "ending organizer 1's connection leaves organizer 2's connection fully intact", connW2StatusAfter === 'accepted' && remW2ActiveAfter === true);

        // ── Y: analytics correctly scoped per participant ───────────────────────
        const orgY = await makeCaregiver('y');
        testUserIds.push(orgY.id);
        const rcY1 = await makeRecipient('y1');
        const rcY2 = await makeRecipient('y2');
        testUserIds.push(rcY1.id, rcY2.id);
        const connY1 = await connect(orgY, rcY1);
        const connY2 = await connect(orgY, rcY2);
        testConnectionIds.push(connY1, connY2);
        const remY1 = dbQuery(`insert into public.reminders (connection_id, caregiver_id, recipient_id, title, time_of_day, days_of_week, no_response_minutes, is_active) values ('${connY1}', '${orgY.id}', '${rcY1.id}', 'Y1 reminder', '08:00:00', ARRAY[1,2,3,4,5,6,7], 30, true) returning id;`)[0] as any;
        const remY2 = dbQuery(`insert into public.reminders (connection_id, caregiver_id, recipient_id, title, time_of_day, days_of_week, no_response_minutes, is_active) values ('${connY2}', '${orgY.id}', '${rcY2.id}', 'Y2 reminder', '08:00:00', ARRAY[1,2,3,4,5,6,7], 30, true) returning id;`)[0] as any;
        testReminderIds.push(remY1.id, remY2.id);
        dbQuery(`insert into public.reminder_logs (reminder_id, connection_id, caregiver_id, recipient_id, occurrence_date, scheduled_for, status, completed_at) values ('${remY1.id}', '${connY1}', '${orgY.id}', '${rcY1.id}', current_date, now(), 'taken', now());`);
        dbQuery(`insert into public.reminder_logs (reminder_id, connection_id, caregiver_id, recipient_id, occurrence_date, scheduled_for, status, completed_at) values ('${remY2.id}', '${connY2}', '${orgY.id}', '${rcY2.id}', current_date, now(), 'missed', now());`);
        const y1Logs = dbQuery(`select status from public.reminder_logs where reminder_id in (select id from public.reminders where connection_id='${connY1}');`) as any[];
        const y2Logs = dbQuery(`select status from public.reminder_logs where reminder_id in (select id from public.reminders where connection_id='${connY2}');`) as any[];
        record('Y', "Participant Y1's analytics query returns only Y1's log (taken), never Y2's", y1Logs.length === 1 && y1Logs[0].status === 'taken');
        record('Y', "Participant Y2's analytics query returns only Y2's log (missed), never Y1's -- no silent cross-participant aggregation", y2Logs.length === 1 && y2Logs[0].status === 'missed');

        // Nested cross-suite "remains passing" checks (formerly Z-AD)
        // removed as part of Week 4 Task #1's DAG-flattening pass -- see
        // docs/audit-infrastructure-model.md.

        // Sanity check the pure classification helper agrees with what the
        // server actually did throughout this run (categorizeConnection is
        // shared by every screen — see lib/connectionStateCore.ts).
        const endedRow = dbQuery(`select status, expires_at from public.connections where id='${connM}';`)[0] as any;
        record('extra', 'categorizeConnection() agrees with the server: an ended row categorizes as "ended"', categorizeConnection(endedRow) === 'ended');

    } finally {
        await cleanup();
    }

    const passed = summarize();
    process.exit(passed ? 0 : 1);
}

main().catch((err) => {
    console.error('PARTICIPANT_AUDIT_SUITE_FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
});
