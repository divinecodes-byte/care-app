// Tavora security-audit synthetic attack test suite.
//
// Run from the repo root:
//   EXPO_PUBLIC_SUPABASE_URL=... EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=... npx tsx scripts/security-audit/run.ts
// (both values already live in .env — this repo's other scripts source it
// the same way; nothing here reads or prints a secret).
//
// Creates disposable synthetic users (tavora.secaudit.*@example.com),
// attacks them against each other using only the public anon key (exactly
// what a real client/attacker has), verifies/cleans up via the
// already-authenticated `supabase` CLI, and never touches a real account.
// Every check below maps to a lettered scenario from the Week 1 security
// audit task (A-T) — see docs/security-model.md for what each is defending.

import { newClient, randomSuffix, record, summarize, signUpTestUser, dbQuery, SUPABASE_URL, ANON_KEY } from './helpers';
import { installCrashSafety } from '../audit-infrastructure/cleanup';

const RAND = randomSuffix();
const PASSWORD = `SecAudit!${RAND}9X`;

async function main() {
    console.log(`Security audit run ${RAND}\n`);

    // Every ID pushed here is guaranteed to be purged in the finally block
    // below, even if setup itself fails partway through. installCrashSafety
    // additionally runs this same cleanup on SIGINT/SIGTERM/uncaughtException/
    // unhandledRejection -- previously this script had no signal handler at
    // all, so an interrupt mid-run skipped the finally block entirely and
    // orphaned whatever synthetic accounts had been created so far.
    const testUserIds: string[] = [];
    const testConnectionIds: string[] = [];
    let cleaned = false;
    async function cleanup() {
        if (cleaned) return;
        cleaned = true;
        console.log('\nCleaning up synthetic test data...');
        const idList = testUserIds.map((id) => `'${id}'`).join(',');
        dbQuery(`delete from public.profiles where id in (${idList});`);

        const verifyProfiles = dbQuery(`select count(*) as c from public.profiles where id in (${idList});`) as { c: number }[];
        const verifyAuth = dbQuery(`select count(*) as c from auth.users where email like 'tavora.secaudit.%.${RAND}@example.com';`) as { c: number }[];
        console.log(`Leftover profiles: ${verifyProfiles[0]?.c ?? '?'}, leftover auth users needing manual cleanup: ${verifyAuth[0]?.c ?? '?'}`);

        // profiles.id no longer FKs to auth.users (account-deletion migration),
        // so auth.users rows for accounts that were never soft-deleted through
        // delete-account must be removed directly too.
        dbQuery(`delete from auth.users where email like 'tavora.secaudit.%.${RAND}@example.com';`);
        const verifyAuthAfter = dbQuery(`select count(*) as c from auth.users where email like 'tavora.secaudit.%.${RAND}@example.com';`) as { c: number }[];
        record('cleanup', 'all synthetic auth users removed', (verifyAuthAfter[0]?.c ?? 1) === 0, `remaining: ${verifyAuthAfter[0]?.c}`);
    }
    installCrashSafety(cleanup);

    try {
        // ── Setup: two connected users (caregiverA/recipientA) + one outsider (caregiverB) ──
        const caregiverA = await signUpTestUser('caregiverA', RAND, PASSWORD, 'Sec Caregiver A');
        testUserIds.push(caregiverA.id);
        const recipientA = await signUpTestUser('recipientA', RAND, PASSWORD, 'Sec Recipient A');
        testUserIds.push(recipientA.id);
        const caregiverB = await signUpTestUser('caregiverB', RAND, PASSWORD, 'Sec Caregiver B Outsider');
        testUserIds.push(caregiverB.id);

        dbQuery(`update public.profiles set role='caregiver' where id='${caregiverA.id}';`);
        dbQuery(`update public.profiles set role='recipient' where id='${recipientA.id}';`);
        dbQuery(`update public.profiles set role='caregiver' where id='${caregiverB.id}';`);
        // Real invite flow, through the actual RPCs, exactly as the app does.
        const { data: invite } = await caregiverA.client
            .rpc('create_invite_code', { p_existing_connection_id: null })
            .maybeSingle() as { data: { id: string; invite_code: string; expires_at: string } | null };
        if (!invite) throw new Error('setup: create_invite_code failed');
        testConnectionIds.push(invite.id);

        // ── H: self-connection ──────────────────────────────────────────────────
        const { data: selfResult } = await caregiverA.client.rpc('accept_invite_code', { p_code: invite.invite_code });
        record('H', 'caregiver cannot accept their own invite code', selfResult === 'self', `got ${selfResult}`);

        // ── E: invite brute-force yields no information ────────────────────────
        const { data: bruteForce1 } = await recipientA.client.rpc('accept_invite_code', { p_code: 'ZZZZZZ' });
        const { data: bruteForce2 } = await recipientA.client.rpc('accept_invite_code', { p_code: '000000' });
        record(
            'E',
            'brute-forced/guessed codes return only not_found, no data',
            bruteForce1 === 'not_found' && bruteForce2 === 'not_found',
            `got ${bruteForce1}, ${bruteForce2}`
        );

        // ── U: preview_invite_code brute-force yields no information ──────────
        // Build Batch 2: preview_invite_code is read-only (never mutates
        // connections) but must carry the exact same guessed-code
        // information-disclosure boundary as accept_invite_code above --
        // requires authentication and the exact code, reveals nothing for
        // a code that doesn't resolve to a real, currently-pending,
        // not-yet-expired invite belonging to someone else.
        const { data: previewBrute1 } = await recipientA.client.rpc('preview_invite_code', { p_code: 'ZZZZZZ' }).maybeSingle() as { data: { status: string; organizer_full_name: string | null; relationship_pair: string | null } | null };
        const { data: previewBrute2 } = await recipientA.client.rpc('preview_invite_code', { p_code: '000000' }).maybeSingle() as { data: { status: string; organizer_full_name: string | null; relationship_pair: string | null } | null };
        record(
            'U',
            'preview_invite_code on brute-forced/guessed codes returns only not_found, never an organizer name or relationship',
            previewBrute1?.status === 'not_found' && !previewBrute1?.organizer_full_name && !previewBrute1?.relationship_pair
                && previewBrute2?.status === 'not_found' && !previewBrute2?.organizer_full_name && !previewBrute2?.relationship_pair,
            JSON.stringify({ previewBrute1, previewBrute2 })
        );

        // ── V: preview_invite_code never mutates the row it previews ──────────
        const { data: inviteV } = await caregiverA.client.rpc('create_invite_code', { p_existing_connection_id: null, p_relationship_pair: 'mentor_mentee' }).maybeSingle() as { data: { id: string; invite_code: string } | null };
        if (inviteV) testConnectionIds.push(inviteV.id);
        const beforePreview = dbQuery(`select status, recipient_id from public.connections where id = '${inviteV?.id}'`)[0] as { status: string; recipient_id: string | null };
        await recipientA.client.rpc('preview_invite_code', { p_code: inviteV?.invite_code ?? '' });
        await recipientA.client.rpc('preview_invite_code', { p_code: inviteV?.invite_code ?? '' }); // repeatable -- previewing twice is still non-consuming
        const afterPreview = dbQuery(`select status, recipient_id from public.connections where id = '${inviteV?.id}'`)[0] as { status: string; recipient_id: string | null };
        record(
            'V',
            'preview_invite_code never mutates connections -- status/recipient_id unchanged after (repeated) preview',
            beforePreview.status === 'pending' && beforePreview.recipient_id === null
                && afterPreview.status === 'pending' && afterPreview.recipient_id === null,
            JSON.stringify({ beforePreview, afterPreview })
        );

        // ── D: forged connection row ────────────────────────────────────────────
        const { error: forgedConnErr } = await caregiverB.client
            .from('connections')
            .insert({ caregiver_id: caregiverB.id, recipient_id: recipientA.id, invite_code: `FORGE${RAND.slice(0, 3)}`, status: 'accepted' });
        record('D', 'direct client INSERT into connections is rejected', !!forgedConnErr, forgedConnErr?.message);

        // Real acceptance, through the real RPC — this becomes the legitimate connection.
        const { data: acceptResult } = await recipientA.client.rpc('accept_invite_code', { p_code: invite.invite_code });
        record('setup', 'recipientA accepts the real invite', acceptResult === 'accepted', `got ${acceptResult}`);

        // ── F / T: invite reuse / replay ────────────────────────────────────────
        const { data: reuseResult } = await caregiverB.client.rpc('accept_invite_code', { p_code: invite.invite_code });
        record('F', 'reusing an already-accepted code fails cleanly', reuseResult === 'already_accepted', `got ${reuseResult}`);
        const { data: replayResult } = await recipientA.client.rpc('accept_invite_code', { p_code: invite.invite_code });
        record('T', 'replaying the same acceptance request is harmless (idempotent)', replayResult === 'already_accepted', `got ${replayResult}`);

        // ── G: concurrent acceptance of a fresh code resolves to exactly one winner ──
        const { data: invite2 } = await caregiverA.client
            .rpc('create_invite_code', { p_existing_connection_id: null })
            .maybeSingle() as { data: { id: string; invite_code: string } | null };
        if (!invite2) throw new Error('setup: second create_invite_code failed');
        testConnectionIds.push(invite2.id);

        const recipientC = await signUpTestUser('recipientC', RAND, PASSWORD, 'Sec Recipient C');
        testUserIds.push(recipientC.id);
        dbQuery(`update public.profiles set role='recipient' where id='${recipientC.id}';`);

        const [concurrent1, concurrent2] = await Promise.all([
            recipientC.client.rpc('accept_invite_code', { p_code: invite2.invite_code }),
            caregiverB.client.rpc('accept_invite_code', { p_code: invite2.invite_code }),
        ]);
        const outcomes = [concurrent1.data, concurrent2.data].sort();
        record(
            'G',
            'concurrent acceptance of one code produces exactly one winner',
            outcomes[0] === 'accepted' && outcomes[1] !== 'accepted',
            `outcomes: ${outcomes.join(', ')}`
        );

        // A reminder + reminder_log for the real caregiverA/recipientA relationship.
        const connRow = dbQuery(
            `select id from public.connections where caregiver_id='${caregiverA.id}' and recipient_id='${recipientA.id}' and status='accepted';`
        ) as { id: string }[];
        const connId = connRow[0]?.id;
        if (!connId) throw new Error('setup: accepted connection not found');

        const { data: reminder, error: reminderInsertErr } = await caregiverA.client
            .from('reminders')
            .insert({
                connection_id: connId,
                caregiver_id: caregiverA.id,
                recipient_id: recipientA.id,
                title: 'Sec audit reminder',
                reminder_type: 'medication',
                time_of_day: '09:00',
                frequency: 'daily',
                days_of_week: [1, 2, 3, 4, 5, 6, 7],
                no_response_minutes: 15,
                is_active: true,
            })
            .select('id')
            .maybeSingle();
        if (reminderInsertErr || !reminder) throw new Error(`setup: reminder insert failed: ${reminderInsertErr?.message}`);

        // ── K: forged reminder ownership (caregiverB using caregiverA's connection) ──
        const { error: forgedReminderErr } = await caregiverB.client.from('reminders').insert({
            connection_id: connId,
            caregiver_id: caregiverB.id,
            recipient_id: recipientA.id,
            title: 'forged',
            reminder_type: 'medication',
            time_of_day: '09:00',
            frequency: 'daily',
            days_of_week: [1],
            no_response_minutes: 15,
            is_active: true,
        });
        record('K', 'cannot create a reminder via a connection you do not own', !!forgedReminderErr, forgedReminderErr?.message);

        // ── I: cross-reminder read ──────────────────────────────────────────────
        const { data: crossRead } = await caregiverB.client.from('reminders').select('id').eq('id', reminder.id);
        record('I', 'outsider cannot read another relationship\'s reminder', (crossRead ?? []).length === 0, `rows: ${(crossRead ?? []).length}`);

        // ── J: reminder ownership reassignment (the RLS gap this audit fixed) ──
        const { data: reassignData, error: reassignErr } = await caregiverA.client
            .from('reminders')
            .update({ recipient_id: caregiverB.id })
            .eq('id', reminder.id)
            .select();
        const reassignBlocked = !!reassignErr || (reassignData ?? []).length === 0;
        record('J', 'caregiver cannot reassign their own reminder to an unconnected recipient', reassignBlocked, reassignErr?.message ?? `rows affected: ${(reassignData ?? []).length}`);

        // A real reminder_log row, seeded directly via the CLI (not through
        // respond_to_reminder_occurrence -- that RPC now enforces strict
        // occurrence-eligibility windows that this fixed-schedule reminder
        // may or may not currently satisfy, and this fixture only needs a
        // row to exist for the L/L2 attack tests below, not to exercise
        // the response RPC itself). Direct client inserts are no longer
        // possible at all as of the Week 1 task #7 RLS hardening -- see L2.
        const logRows = dbQuery(`
          insert into public.reminder_logs (reminder_id, connection_id, caregiver_id, recipient_id, occurrence_date, scheduled_for, status, completed_at)
          values ('${reminder.id}', '${connId}', '${caregiverA.id}', '${recipientA.id}', current_date, now(), 'taken', now())
          returning id;
        `);
        const log = logRows[0] as { id: string } | undefined;
        if (!log) throw new Error('setup: log seed failed');

        // ── L: forged reminder_logs (redirect to a different reminder) ──────────
        const { data: redirectData, error: redirectErr } = await recipientA.client
            .from('reminder_logs')
            .update({ reminder_id: '00000000-0000-0000-0000-000000000000' })
            .eq('id', log.id)
            .select();
        const redirectBlocked = !!redirectErr || (redirectData ?? []).length === 0;
        record('L', 'recipient cannot redirect their own log row to a different reminder', redirectBlocked, redirectErr?.message ?? `rows affected: ${(redirectData ?? []).length}`);

        const { error: forgedLogErr } = await caregiverB.client.from('reminder_logs').insert({
            reminder_id: reminder.id,
            connection_id: connId,
            caregiver_id: caregiverA.id,
            recipient_id: caregiverB.id,
            occurrence_date: new Date().toISOString().slice(0, 10),
            scheduled_for: new Date().toISOString(),
            status: 'taken',
        });
        record('L2', 'outsider cannot forge a log for another recipient\'s reminder', !!forgedLogErr, forgedLogErr?.message);

        // ── N: delivery-ledger access ────────────────────────────────────────────
        const { data: deliveries } = await caregiverA.client.from('reminder_notification_deliveries').select('*');
        record('N', 'no authenticated client can read the delivery ledger', (deliveries ?? []).length === 0, `rows: ${(deliveries ?? []).length}`);

        // ── M: cross-user push token registration ────────────────────────────────
        const { error: forgedTokenErr } = await caregiverB.client.from('push_tokens').insert({
            user_id: recipientA.id,
            expo_push_token: `ExponentPushToken[SECAUDIT_FORGE_${RAND}]`,
            platform: 'ios',
            is_active: true,
        });
        record('M', 'cannot register a push token for another user', !!forgedTokenErr, forgedTokenErr?.message);

        // ── B / C: cross-profile read/update ─────────────────────────────────────
        const { data: crossProfileRead } = await caregiverB.client.from('profiles').select('*').eq('id', recipientA.id);
        record('B', 'unconnected user cannot read another user\'s profile', (crossProfileRead ?? []).length === 0, `rows: ${(crossProfileRead ?? []).length}`);

        const { data: crossProfileUpdate } = await caregiverB.client
            .from('profiles')
            .update({ full_name: 'HACKED' })
            .eq('id', recipientA.id)
            .select();
        record('C', 'unconnected user cannot update another user\'s profile', (crossProfileUpdate ?? []).length === 0, `rows affected: ${(crossProfileUpdate ?? []).length}`);

        // ── A: anonymous access ──────────────────────────────────────────────────
        const anonClient = newClient(); // never signed in
        const { data: anonProfiles } = await anonClient.from('profiles').select('*');
        const { data: anonReminders } = await anonClient.from('reminders').select('*');
        record(
            'A',
            'anonymous (unauthenticated) client sees no rows in any protected table',
            (anonProfiles ?? []).length === 0 && (anonReminders ?? []).length === 0,
            `profiles: ${(anonProfiles ?? []).length}, reminders: ${(anonReminders ?? []).length}`
        );

        // ── O: unauthorized RPC execution ────────────────────────────────────────
        const { error: claimRpcErr } = await caregiverA.client.rpc('claim_due_recipient_reminder_deliveries');
        const { error: deleteRpcErr } = await caregiverA.client.rpc('delete_current_user_data', { target_user_id: caregiverB.id });
        record(
            'O',
            'authenticated client cannot call service-role-only RPCs',
            !!claimRpcErr && !!deleteRpcErr,
            `claim: ${claimRpcErr?.message}; delete: ${deleteRpcErr?.message}`
        );

        // ── P / Q: unauthorized Edge Function invocation / cron-secret rejection ──
        const noAuthResp = await fetch(`${SUPABASE_URL}/functions/v1/send-due-recipient-reminders`, { method: 'POST' });
        const wrongSecretResp = await fetch(`${SUPABASE_URL}/functions/v1/send-due-recipient-reminders`, {
            method: 'POST',
            headers: { 'x-cron-secret': 'definitely-wrong-secret' },
        });
        const wrongSecretResp2 = await fetch(`${SUPABASE_URL}/functions/v1/check-push-receipts`, {
            method: 'POST',
            headers: { 'x-cron-secret': 'definitely-wrong-secret' },
        });
        record(
            'P',
            'cron-only Edge Functions reject calls with no cron secret',
            noAuthResp.status === 401,
            `status: ${noAuthResp.status}`
        );
        record(
            'Q',
            'cron-only Edge Functions reject an incorrect cron secret',
            wrongSecretResp.status === 401 && wrongSecretResp2.status === 401,
            `statuses: ${wrongSecretResp.status}, ${wrongSecretResp2.status}`
        );

        // delete-account with no auth / with User A's JWT targeting nothing else (it can't).
        const deleteNoAuthResp = await fetch(`${SUPABASE_URL}/functions/v1/delete-account`, {
            method: 'POST',
            headers: { apikey: ANON_KEY },
        });
        record('P2', 'delete-account rejects calls with no Authorization header', deleteNoAuthResp.status === 401, `status: ${deleteNoAuthResp.status}`);

        // ── R: deleted-account behavior ──────────────────────────────────────────
        const deletable = await signUpTestUser('deletable', RAND, PASSWORD, 'Sec Deletable User');
        testUserIds.push(deletable.id);
        dbQuery(`update public.profiles set role='recipient' where id='${deletable.id}';`);

        const { data: signInData } = await deletable.client.auth.signInWithPassword({ email: deletable.email, password: PASSWORD });
        const capturedToken = signInData?.session?.access_token;

        const deleteResp = await fetch(`${SUPABASE_URL}/functions/v1/delete-account`, {
            method: 'POST',
            headers: { apikey: ANON_KEY, Authorization: `Bearer ${capturedToken}` },
        });
        const deleteOk = deleteResp.status === 200;

        let oldTokenRejected = false;
        if (capturedToken) {
            const staleClient = newClient();
            const { data: staleUser, error: staleErr } = await staleClient.auth.getUser(capturedToken);
            oldTokenRejected = !!staleErr || !staleUser?.user;
        }
        record('R', 'a deleted account\'s captured JWT no longer resolves to a live user', deleteOk && oldTokenRejected, `delete status: ${deleteResp.status}, old token rejected: ${oldTokenRejected}`);

        // ── S: ended-connection behavior ─────────────────────────────────────────
        // Real deletion of caregiverA (who has the real, accepted connection to
        // recipientA used throughout this run) exercises the actual production
        // path — every prior check above that needed caregiverA/recipientA
        // alive has already run, so this is safe to do last.
        const { data: caregiverASignIn } = await caregiverA.client.auth.signInWithPassword({ email: caregiverA.email, password: PASSWORD });
        const caregiverAToken = caregiverASignIn?.session?.access_token;
        await fetch(`${SUPABASE_URL}/functions/v1/delete-account`, {
            method: 'POST',
            headers: { apikey: ANON_KEY, Authorization: `Bearer ${caregiverAToken}` },
        });

        const endedConn = dbQuery(
            `select status from public.connections where caregiver_id='${caregiverA.id}' and recipient_id='${recipientA.id}';`
        ) as { status: string }[];
        const { data: staleConnectedProfile } = await recipientA.client.from('profiles').select('*').eq('id', caregiverA.id);
        record(
            'S',
            'an ended connection no longer grants active-relationship privileges',
            endedConn[0]?.status === 'ended' && (staleConnectedProfile ?? []).length === 0,
            `status: ${endedConn[0]?.status}, counterpart profile still visible: ${(staleConnectedProfile ?? []).length}`
        );

        console.log('\nAll scenario checks executed.');
    } finally {
        await cleanup();
    }

    const allPassed = summarize();
    process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
    console.error('SECURITY_AUDIT_SUITE_FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
});
