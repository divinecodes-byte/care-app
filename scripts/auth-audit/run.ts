// Tavora auth/session synthetic test suite (Week 1 launch hardening task #6).
//
// Run from the repo root:
//   EXPO_PUBLIC_SUPABASE_URL=... EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=... npx tsx scripts/auth-audit/run.ts
// (both values already live in .env, sourced the same way as
// scripts/security-audit/run.ts).
//
// Creates disposable synthetic users (tavora.authaudit.*@example.com),
// exercises them through the real anon-key client paths (exactly what the
// app itself does), verifies/cleans up via the already-authenticated
// `supabase` CLI, and never touches a real account. Several scenarios
// (D/E/F/S) are necessarily proxy tests: this is a Node script, not a
// React Native runtime, so client-side-only behavior (AsyncStorage
// clearing, expo-router navigation gating, the foreground notification
// handler) is verified by code review, not runtime execution here — each
// such scenario says so explicitly in its own comment.

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

const RAND = randomSuffix();
const PASSWORD = `AuthAudit!${RAND}9X`;
const EMAIL_PREFIX = 'tavora.authaudit';

/**
 * This suite's own signup helper — deliberately not reusing
 * security-audit/helpers.ts's signUpTestUser, which hardcodes a
 * tavora.secaudit. email prefix. Relies on the handle_new_user trigger
 * (Week 1 task #6 migration) to create the profiles row atomically; sets
 * full_name via signUp's own options.data, matching what app/signup.tsx
 * now does, rather than a separate .insert()/.upsert() call.
 */
async function signUpTestUser(emailPrefix: string, fullName: string) {
    const client = newClient();
    const email = `${EMAIL_PREFIX}.${emailPrefix}.${RAND}@example.com`;
    const { data, error } = await client.auth.signUp({ email, password: PASSWORD, options: { data: { full_name: fullName, audit_account: true } } });
    if (error || !data.user) throw new Error(`signup failed for ${email}: ${error?.message}`);
    return { id: data.user.id, email, client };
}

function classifyLike(message: string | undefined): string {
    // Minimal standalone re-implementation of lib/authErrors.ts's
    // classifyAuthError for this Node-only script (that module isn't
    // importable here — it has no RN-coupled dependencies itself, but
    // pulling it in would require resolving the app's tsconfig paths
    // outside the RN toolchain). Kept in exact sync by inspection; any
    // future change to lib/authErrors.ts's patterns should be mirrored
    // here too.
    const m = (message ?? '').toLowerCase();
    if (['network request failed', 'fetch failed', 'failed to fetch', 'timed out', 'timeout'].some((p) => m.includes(p))) return 'network';
    if (['user already registered', 'already registered', 'already exists'].some((p) => m.includes(p))) return 'email_in_use';
    if (['invalid login credentials', 'invalid email or password'].some((p) => m.includes(p))) return 'invalid_credentials';
    if (['jwt expired', 'invalid refresh token', 'session_not_found', 'invalid jwt', 'user_not_found'].some((p) => m.includes(p))) return 'expired_session';
    return 'unexpected';
}

async function main() {
    console.log(`Auth audit run ${RAND}\n`);

    const testUserIds: string[] = [];
    const testConnectionIds: string[] = [];
    let cleaned = false;
    async function cleanup() {
        if (cleaned) return;
        cleaned = true;
        console.log('\nCleaning up synthetic test data...');
        for (const connectionId of testConnectionIds) {
            dbQuery(`delete from public.reminder_notification_deliveries where reminder_id in (select id from public.reminders where connection_id = '${connectionId}');`);
            dbQuery(`delete from public.reminders where connection_id = '${connectionId}';`);
            dbQuery(`delete from public.connections where id = '${connectionId}';`);
        }
        dbQuery(`delete from public.push_tokens where expo_push_token like 'ExponentPushToken[authaudit-${RAND}%';`);
        if (testUserIds.length > 0) {
            const idList = testUserIds.map((id) => `'${id}'`).join(',');
            dbQuery(`delete from public.profiles where id in (${idList});`);
            try {
                execFileSync('supabase', ['db', 'query', '--linked', '-o', 'json', `delete from auth.users where id in (${idList});`], { stdio: 'pipe' });
            } catch (err) {
                console.warn('Leftover auth users needing manual cleanup:', testUserIds.length, err instanceof Error ? err.message : err);
            }
        }
        const remaining = dbQuery(`select count(*) as c from auth.users where email like 'tavora.authaudit.%${RAND}%';`);
        record('cleanup', 'all synthetic auth users removed', Number((remaining[0] as any)?.c ?? 1) === 0, `remaining: ${(remaining[0] as any)?.c}`);
    }
    installCrashSafety(cleanup);

    try {
        // ── A: normal signup and atomic profile creation ────────────────────
        const userA = await signUpTestUser('userA', 'Auth Audit User A');
        testUserIds.push(userA.id);
        const profRowsA = dbQuery(`select role, full_name, account_status, notification_preview_mode, timezone from public.profiles where id = '${userA.id}';`);
        const profA = profRowsA[0] as any;
        record('A', 'signup creates a profile row atomically (no separate insert needed)', !!profA, JSON.stringify(profA));
        record('A', 'new profile defaults: role null, account_status active, preview private', profA?.role === null && profA?.account_status === 'active' && profA?.notification_preview_mode === 'private');
        record('A', 'new profile has a non-blank default timezone', typeof profA?.timezone === 'string' && profA.timezone.trim().length > 0, profA?.timezone);

        dbQuery(`update public.profiles set role='recipient' where id='${userA.id}';`);

        // ── B: normal sign-in ─────────────────────────────────────────────────
        const signinClient = newClient();
        const { data: signinData, error: signinError } = await signinClient.auth.signInWithPassword({ email: userA.email, password: PASSWORD });
        record('B', 'sign-in with correct credentials succeeds', !signinError && !!signinData.session, signinError?.message);

        // ── C: wrong password ────────────────────────────────────────────────
        const wrongPassClient = newClient();
        const { error: wrongPassError } = await wrongPassClient.auth.signInWithPassword({ email: userA.email, password: 'DefinitelyWrong123!' });
        record('C', 'sign-in with wrong password fails', !!wrongPassError);
        record('C', 'wrong-password error classifies as invalid_credentials', classifyLike(wrongPassError?.message) === 'invalid_credentials', wrongPassError?.message);

        // ── D: session restoration (proxy — no RN AsyncStorage in this runtime) ─
        const { data: restoredSession } = await signinClient.auth.getSession();
        record('D', 'session is held/retrievable after sign-in (restoration proxy)', restoredSession.session?.user.id === userA.id);

        // ── E: token refresh ─────────────────────────────────────────────────
        const originalAccessToken = signinData.session?.access_token;
        const { data: refreshed, error: refreshError } = await signinClient.auth.refreshSession();
        record('E', 'refreshSession succeeds and returns a new access token', !refreshError && !!refreshed.session && refreshed.session.access_token !== originalAccessToken, refreshError?.message);
        const { data: afterRefreshUser, error: afterRefreshErr } = await signinClient.auth.getUser();
        record('E', 'session remains valid immediately after refresh', !afterRefreshErr && afterRefreshUser.user?.id === userA.id);

        // ── F: expired/invalid session ───────────────────────────────────────
        const invalidClient = newClient();
        await invalidClient.auth.setSession({ access_token: 'not-a-real-jwt', refresh_token: 'not-a-real-refresh-token' }).catch(() => {});
        const { error: invalidUserError } = await invalidClient.auth.getUser();
        record('F', 'a garbage/invalid session is rejected by getUser()', !!invalidUserError, invalidUserError?.message);
        if (invalidUserError) {
            record('F', 'invalid-session error classifies as expired_session or unexpected (never silently authenticated)', ['expired_session', 'unexpected'].includes(classifyLike(invalidUserError.message)), invalidUserError.message);
        }

        // ── G: logout ─────────────────────────────────────────────────────────
        const { error: signOutError } = await signinClient.auth.signOut();
        record('G', 'signOut succeeds', !signOutError, signOutError?.message);
        const { data: postSignoutSession } = await signinClient.auth.getSession();
        record('G', 'session is gone after signOut', !postSignoutSession.session);

        // ── H: logout with simulated push-token cleanup failure ────────────────
        // Calling the token-deactivation RPC with no valid session simulates
        // the "remote cleanup step fails" case — it must fail cleanly
        // (permission/auth error), never throw in a way that would block
        // the rest of a logout sequence built around it (see
        // lib/accountCleanup.ts's logout(), which wraps this exact call in
        // .catch(() => false)).
        const { error: deactivateAfterSignoutError } = await signinClient.rpc('deactivate_own_push_tokens');
        record('H', 'token-cleanup RPC fails cleanly (not a crash) when called without a session', !!deactivateAfterSignoutError, deactivateAfterSignoutError?.message);

        // ── I/J/K: account switching A -> B -> A, push-token reassignment ──────
        const userB = await signUpTestUser('userB', 'Auth Audit User B');
        testUserIds.push(userB.id);
        dbQuery(`update public.profiles set role='recipient' where id='${userB.id}';`);

        const deviceToken = `ExponentPushToken[authaudit-${RAND}]`;

        const clientA = newClient();
        await clientA.auth.signInWithPassword({ email: userA.email, password: PASSWORD });
        const { error: regAErr } = await clientA.rpc('register_push_token', { p_expo_push_token: deviceToken, p_platform: 'ios' });
        record('I', 'User A can register this device token', !regAErr, regAErr?.message);
        const ownerAfterA = dbQuery(`select user_id, is_active from public.push_tokens where expo_push_token = '${deviceToken}';`);
        record('I', 'token is owned by User A and active', (ownerAfterA[0] as any)?.user_id === userA.id && (ownerAfterA[0] as any)?.is_active === true, JSON.stringify(ownerAfterA[0]));
        await clientA.auth.signOut();

        const clientB = newClient();
        await clientB.auth.signInWithPassword({ email: userB.email, password: PASSWORD });
        const { error: regBErr } = await clientB.rpc('register_push_token', { p_expo_push_token: deviceToken, p_platform: 'ios' });
        record('J', 'User B can register the SAME device token previously owned by User A (no RLS deadlock/loop)', !regBErr, regBErr?.message);
        const ownerAfterB = dbQuery(`select user_id, is_active from public.push_tokens where expo_push_token = '${deviceToken}';`);
        record('K', 'token ownership reassigned to User B', (ownerAfterB[0] as any)?.user_id === userB.id && (ownerAfterB[0] as any)?.is_active === true, JSON.stringify(ownerAfterB[0]));
        const userATokensAfterSwitch = dbQuery(`select count(*) as c from public.push_tokens where user_id = '${userA.id}' and is_active = true;`);
        record('K', "User A has zero active tokens after B claims the device (A can't receive pushes on it anymore)", Number((userATokensAfterSwitch[0] as any).c) === 0);
        await clientB.auth.signOut();

        const clientA2 = newClient();
        const { data: backToA, error: backToAErr } = await clientA2.auth.signInWithPassword({ email: userA.email, password: PASSWORD });
        record('J', 'User A can sign back in afterward', !backToAErr && !!backToA.session, backToAErr?.message);
        const { data: reloadedProfile } = await clientA2.from('profiles').select('role').eq('id', userA.id).maybeSingle();
        record('J', "signing back into User A reloads that user's own profile from the server", reloadedProfile?.role === 'recipient');

        // ── L: previous account's data is absent after switching (server-side proxy) ──
        // The client-side guarantee (AsyncStorage cleared, in-memory state
        // reset) is enforced by lib/accountCleanup.ts's logout() and was
        // verified by code review, not runtime here (no RN environment).
        // What IS directly testable here is the server-side half of the
        // same guarantee: User B's client can never read User A's rows
        // regardless of local cache state, because RLS scopes every query
        // to auth.uid() — so even a stale local cache could only ever be
        // *displayed* incorrectly, never *fetched* successfully.
        const clientBAgain = newClient();
        await clientBAgain.auth.signInWithPassword({ email: userB.email, password: PASSWORD });
        const { data: bReadingA } = await clientBAgain.from('profiles').select('full_name').eq('id', userA.id);
        record('L', "User B's session cannot read User A's profile row (RLS-enforced isolation backing the local-cleanup guarantee)", (bReadingA ?? []).length === 0);
        await clientBAgain.auth.signOut();

        // ── M: deleted/tombstoned profile rejection ─────────────────────────────
        const userM = await signUpTestUser('userM', 'Auth Audit User M');
        testUserIds.push(userM.id);
        dbQuery(`update public.profiles set account_status='deleted', deleted_at=now() where id='${userM.id}';`);
        const tombstoneRow = dbQuery(`select account_status from public.profiles where id='${userM.id}';`);
        record('M', 'a tombstoned profile is queryable as deleted (matches signin.tsx/dashboard checks)', (tombstoneRow[0] as any)?.account_status === 'deleted');
        const { error: inviteAsDeletedErr } = await (async () => {
            const deletedClient = newClient();
            await deletedClient.auth.signInWithPassword({ email: userM.email, password: PASSWORD });
            return deletedClient.rpc('create_invite_code');
        })();
        record('M', 'a tombstoned account cannot create an invite code (server-side account_status guard)', !!inviteAsDeletedErr, inviteAsDeletedErr?.message);

        // ── N: partial/duplicate signup recovery ────────────────────────────────
        const dupClient = newClient();
        const { error: dupError } = await dupClient.auth.signUp({ email: userA.email, password: PASSWORD });
        record('N', 'signing up again with an already-used email fails cleanly, not silently', !!dupError, dupError?.message);
        if (dupError) {
            record('N', 'duplicate-email error classifies as email_in_use', classifyLike(dupError.message) === 'email_in_use', dupError.message);
        }

        // ── O/P: notification deep-link authorization (data-layer proxy) ───────
        // The client-side gating in app/_layout.tsx (queue until auth
        // resolves; drop the deep link entirely for unauthenticated/
        // deleted/profile_missing status) is code-reviewed, not runtime-
        // tested here. What's directly verifiable is the authoritative
        // layer underneath it: a reminder's route param (reminderId) is
        // never itself trusted — RLS decides who can actually read it,
        // regardless of what a deep link claims.
        const connRows = dbQuery(`
          insert into public.connections (caregiver_id, recipient_id, invite_code, status, accepted_at)
          values ('${userB.id}', '${userA.id}', 'AUTHAUDIT${RAND}', 'accepted', now())
          returning id;
        `);
        const connectionId = (connRows[0] as any).id;
        testConnectionIds.push(connectionId);
        dbQuery(`update public.profiles set role='caregiver' where id='${userB.id}';`);
        const remRows = dbQuery(`
          insert into public.reminders (connection_id, caregiver_id, recipient_id, title, time_of_day, no_response_minutes, is_active)
          values ('${connectionId}', '${userB.id}', '${userA.id}', 'Auth audit reminder', '09:00:00', 15, true)
          returning id;
        `);
        const reminderId = (remRows[0] as any).id;

        const outsiderClient = newClient();
        const userOut = await signUpTestUser('userOut', 'Auth Audit Outsider');
        testUserIds.push(userOut.id);
        await outsiderClient.auth.signInWithPassword({ email: userOut.email, password: PASSWORD });
        const { data: outsiderRead } = await outsiderClient.from('reminders').select('id').eq('id', reminderId);
        record('O', 'an unauthorized account cannot read a reminder via its id alone (deep-link param is never trusted)', (outsiderRead ?? []).length === 0);

        const clientA3 = newClient();
        await clientA3.auth.signInWithPassword({ email: userA.email, password: PASSWORD });
        const { data: ownerRead } = await clientA3.from('reminders').select('id').eq('id', reminderId);
        record('P', 'the authorized recipient CAN read their own reminder by id (legitimate deep link still works)', (ownerRead ?? []).length === 1);
        await clientA3.auth.signOut();
        await outsiderClient.auth.signOut();

        // ── Q: repeated sign-out is idempotent ──────────────────────────────────
        const idempotentClient = newClient();
        await idempotentClient.auth.signInWithPassword({ email: userA.email, password: PASSWORD });
        const { error: firstSignOut } = await idempotentClient.auth.signOut();
        const { error: secondSignOut } = await idempotentClient.auth.signOut();
        record('Q', 'signing out twice in a row does not error either time', !firstSignOut && !secondSignOut, `${firstSignOut?.message ?? ''} ${secondSignOut?.message ?? ''}`.trim());

        // ── R: repeated local cleanup is idempotent ─────────────────────────────
        const cleanupClient = newClient();
        await cleanupClient.auth.signInWithPassword({ email: userA.email, password: PASSWORD });
        await cleanupClient.rpc('register_push_token', { p_expo_push_token: `${deviceToken}-r`, p_platform: 'ios' });
        const { error: dea1 } = await cleanupClient.rpc('deactivate_own_push_tokens');
        const { error: dea2 } = await cleanupClient.rpc('deactivate_own_push_tokens');
        record('R', 'deactivating own push tokens twice in a row is harmless both times', !dea1 && !dea2, `${dea1?.message ?? ''} ${dea2?.message ?? ''}`.trim());
        await cleanupClient.auth.signOut();

        // ── S: offline / network-failure classification (proxy) ────────────────
        const unreachableClient = newClient(); // reuses real URL/key; we simulate the network error class directly instead of actually cutting network access, which this sandboxed environment can't safely do.
        record('S', 'network-style error messages classify as "network", not "expired_session" or "unexpected" (fail-safe: keeps existing session)', classifyLike('Network request failed') === 'network');
        record('S', 'a bare timeout message also classifies as network', classifyLike('The operation timed out') === 'network');
        await unreachableClient.auth.signOut().catch(() => {});

        // ── T: account deletion remains functional ──────────────────────────────
        const userT = await signUpTestUser('userT', 'Auth Audit User T');
        testUserIds.push(userT.id);
        const clientT = newClient();
        const { data: signinT } = await clientT.auth.signInWithPassword({ email: userT.email, password: PASSWORD });
        const deleteResp = await fetch(`${SUPABASE_URL}/functions/v1/delete-account`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${signinT.session?.access_token}`, apikey: ANON_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        const deleteBody = await deleteResp.json().catch(() => ({}));
        record('T', 'delete-account still succeeds for a fresh synthetic account', deleteResp.status === 200 && deleteBody.success === true, `status=${deleteResp.status} body=${JSON.stringify(deleteBody)}`);
        const tombstoneAfterDelete = dbQuery(`select account_status, notification_preview_mode from public.profiles where id='${userT.id}';`);
        record('T', 'deletion still tombstones the profile correctly (account_status=deleted, preview reset to private)', (tombstoneAfterDelete[0] as any)?.account_status === 'deleted' && (tombstoneAfterDelete[0] as any)?.notification_preview_mode === 'private');

        // Nested cross-suite "remains passing" checks (formerly U, V) were
        // removed here as part of Week 4 Task #1's DAG-flattening pass --
        // security-audit and ops-health are now each run exactly once, by
        // scripts/final-regression/run.ts, instead of being re-invoked from
        // inside every other suite (the combinatorial fan-out that was
        // producing ~thousands of theoretical signups per full routine-audit
        // run). See docs/audit-infrastructure-model.md.

    } finally {
        await cleanup();
    }

    const passed = summarize();
    process.exit(passed ? 0 : 1);
}

main().catch((err) => {
    console.error('AUTH_AUDIT_SUITE_FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
});
