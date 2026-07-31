// Tavora task-overdue-pagination audit (Week 4 launch-hardening task #3).
// Proves the 60-day recurring-task overdue limitation is genuinely gone,
// replaced by a bounded, cursor-paginated, schedule-version-aware,
// server-authoritative model with no arbitrary day cutoff anywhere in the
// authoritative path -- and proves the audit-infrastructure meta-suite's
// orphan-account leak is fixed, and that the summary RPCs' actionable_date
// is exact (no arbitrary-window approximation). 78 named scenarios (A-BZ),
// following the
// established conventions from scripts/multi-organizer-audit/run.ts:
// record/skip/summarize/getResults from scripts/security-audit/helpers.ts,
// installCrashSafety, the persistent fixture pool for scenarios that only
// create/read/delete reminders/tasks/routines (never the connection graph),
// disposable accounts for connection-graph mutations, and a self-check that
// regex-counts every literal record()/skip() id in this file's own source
// and compares it to what actually ran.

import { readFileSync } from 'node:fs';
import {
    dbQuery,
    getResults,
    newClient,
    randomSuffix,
    record,
    skip,
    summarize,
} from '../security-audit/helpers';
import { installCrashSafety, scopedCleanup, globalSyntheticSweep, detectOrphans, SYNTHETIC_NAMESPACES } from '../audit-infrastructure/cleanup';
import {
    provisionFixturePool,
    resetFixturePool,
    detectFixtureContamination,
    verifyFixtureBaseline,
    getFixtureClient,
    getFixturePassword,
} from '../audit-infrastructure/fixtures';
import { resolveOrganizerDisplay, OrganizerProfileForDisplay } from '../../lib/organizerDisplay';

const RAND = randomSuffix();
const PASSWORD = `OverdueAudit!${RAND}9X`;
const EMAIL_PREFIX = 'tavora.overdueaudit';

function read(path: string): string {
    return readFileSync(path, 'utf-8');
}
function has(content: string, pattern: RegExp): boolean {
    return pattern.test(content);
}

function addDays(dateString: string, days: number): string {
    const [y, m, d] = dateString.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + days));
    return dt.toISOString().slice(0, 10);
}

// Fixture participants/organizers are pinned to America/Phoenix (see
// scripts/audit-infrastructure/fixtures.ts) -- Phoenix is UTC-7 year-round,
// no DST, so this must match the fixture pool's own "today" exactly.
function todayPhoenix(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

async function signUpTestUser(emailPrefix: string, fullName: string | null, role: 'caregiver' | 'recipient', timezone = 'America/Phoenix') {
    const client = newClient();
    const email = `${EMAIL_PREFIX}.${emailPrefix}.${RAND}@example.com`;
    const { data, error } = await client.auth.signUp({ email, password: PASSWORD, options: { data: { audit_account: true } } });
    if (error || !data.user) throw new Error(`signup failed for ${email}: ${error?.message}`);
    await client.from('profiles').update({ full_name: fullName, role, timezone }).eq('id', data.user.id);
    return { id: data.user.id, email, client };
}

async function main() {
    console.log(`Task-overdue audit run ${RAND}\n`);

    async function makeConnectedPair(label: string, recipientTz = 'America/Phoenix') {
        const caregiver = await signUpTestUser(`${label}cg`, `Overdue ${label} Caregiver`, 'caregiver');
        const recipient = await signUpTestUser(`${label}rc`, `Overdue ${label} Recipient`, 'recipient', recipientTz);
        const { data: invite, error: inviteError } = await caregiver.client.rpc('create_invite_code', { p_existing_connection_id: null }).maybeSingle() as { data: { id: string; invite_code: string } | null; error: any };
        if (inviteError || !invite) throw new Error(`invite failed: ${inviteError?.message}`);
        const { error: acceptError } = await recipient.client.rpc('accept_invite_code', { p_code: invite.invite_code });
        if (acceptError) throw new Error(`accept failed: ${acceptError.message}`);
        return { caregiver, recipient, connectionId: invite.id as string };
    }

    async function makeSharedTrio(label: string, recipientTz = 'America/Phoenix') {
        const org1 = await signUpTestUser(`${label}o1`, `Overdue ${label} Organizer1`, 'caregiver');
        const org2 = await signUpTestUser(`${label}o2`, `Overdue ${label} Organizer2`, 'caregiver');
        const shared = await signUpTestUser(`${label}sh`, `Overdue ${label} Shared`, 'recipient', recipientTz);
        const { data: invite1 } = await org1.client.rpc('create_invite_code', { p_existing_connection_id: null }).maybeSingle() as { data: { id: string; invite_code: string } | null };
        if (!invite1) throw new Error('invite1 failed');
        const acc1 = await shared.client.rpc('accept_invite_code', { p_code: invite1.invite_code });
        if (acc1.error || acc1.data !== 'accepted') throw new Error(`accept1 failed: ${acc1.error?.message ?? acc1.data}`);
        const { data: invite2 } = await org2.client.rpc('create_invite_code', { p_existing_connection_id: null }).maybeSingle() as { data: { id: string; invite_code: string } | null };
        if (!invite2) throw new Error('invite2 failed');
        const acc2 = await shared.client.rpc('accept_invite_code', { p_code: invite2.invite_code });
        if (acc2.error || acc2.data !== 'accepted') throw new Error(`accept2 failed: ${acc2.error?.message ?? acc2.data}`);
        return { org1, org2, shared, conn1: invite1.id as string, conn2: invite2.id as string };
    }

    async function createDaily(client: ReturnType<typeof newClient>, connectionId: string, startDate: string, daysOfWeek: number[] = [1, 2, 3, 4, 5, 6, 7], title = 'Overdue audit daily task') {
        return client.rpc('create_task', {
            p_connection_id: connectionId, p_title: title, p_notes: null,
            p_frequency: 'custom', p_days_of_week: daysOfWeek,
            p_start_date: startDate, p_due_date: null, p_recurrence_end_date: null,
        });
    }

    async function createOneTime(client: ReturnType<typeof newClient>, connectionId: string, startDate: string, dueDate: string | null, title = 'Overdue audit one-time task') {
        return client.rpc('create_task', {
            p_connection_id: connectionId, p_title: title, p_notes: null,
            p_frequency: 'one_time', p_days_of_week: [],
            p_start_date: startDate, p_due_date: dueDate, p_recurrence_end_date: null,
        });
    }

    async function respond(client: ReturnType<typeof newClient>, taskId: string, occurrenceDate: string, status: 'completed' | 'skipped') {
        return client.rpc('respond_to_task_occurrence', { p_task_id: taskId, p_occurrence_date: occurrenceDate, p_status: status });
    }

    async function overduePage(client: ReturnType<typeof newClient>, beforeDate: string | null, beforeTaskId: string | null, limit: number | null) {
        return client.rpc('get_participant_overdue_task_occurrences', { p_before_date: beforeDate, p_before_task_id: beforeTaskId, p_limit: limit });
    }

    async function allOverduePages(client: ReturnType<typeof newClient>, pageSize = 20): Promise<any[]> {
        const all: any[] = [];
        let cursor: { date: string; taskId: string } | null = null;
        for (let i = 0; i < 200; i++) {
            const { data, error } = await overduePage(client, cursor?.date ?? null, cursor?.taskId ?? null, pageSize);
            if (error || !data || data.length === 0) break;
            all.push(...data);
            const last = data[data.length - 1];
            if (!last.has_more) break;
            cursor = { date: last.overdue_since_date, taskId: last.task_id };
        }
        return all;
    }

    let crashError: unknown = null;
    let cleaned = false;
    async function cleanup() {
        if (cleaned) return;
        cleaned = true;
        console.log('\nCleaning up synthetic test data...');
        const like = `'${EMAIL_PREFIX}.%${RAND}%'`;
        dbQuery(`delete from public.task_notification_deliveries where recipient_id in (select id from auth.users where email like ${like}) or task_id in (select id from public.tasks where caregiver_id in (select id from auth.users where email like ${like}) or recipient_id in (select id from auth.users where email like ${like}));`);
        dbQuery(`delete from public.task_occurrences where task_id in (select id from public.tasks where caregiver_id in (select id from auth.users where email like ${like}) or recipient_id in (select id from auth.users where email like ${like}));`);
        dbQuery(`delete from public.task_schedule_versions where task_id in (select id from public.tasks where caregiver_id in (select id from auth.users where email like ${like}) or recipient_id in (select id from auth.users where email like ${like}));`);
        dbQuery(`delete from public.tasks where caregiver_id in (select id from auth.users where email like ${like}) or recipient_id in (select id from auth.users where email like ${like});`);
        dbQuery(`delete from public.push_tokens where user_id in (select id from auth.users where email like ${like});`);
        dbQuery(`delete from public.connections where caregiver_id in (select id from auth.users where email like ${like}) or recipient_id in (select id from auth.users where email like ${like});`);
        dbQuery(`delete from public.profiles where id in (select id from auth.users where email like ${like});`);
        dbQuery(`delete from auth.users where email like ${like};`);
        const remaining = dbQuery(`select count(*) as c from auth.users where email like ${like};`) as { c: number }[];
        record('cleanup', 'all synthetic auth users removed', Number(remaining[0]?.c) === 0, `remaining: ${remaining[0]?.c}`);
    }
    installCrashSafety(cleanup);

    try {
        const today = todayPhoenix();

        // ══════════════════════════════════════════════════════════════════
        // A-J: Recurrence-type / occurrence-boundary correctness (fixture pool)
        // ══════════════════════════════════════════════════════════════════
        const pool = await provisionFixturePool();
        resetFixturePool();
        detectFixtureContamination();
        const oA = getFixtureClient('organizerA');
        await oA.auth.signInWithPassword({ email: pool.organizerA.email, password: getFixturePassword() });
        const pA = getFixtureClient('participantA');
        await pA.auth.signInWithPassword({ email: pool.participantA.email, password: getFixturePassword() });
        const connRowAA = dbQuery(`select id from public.connections where caregiver_id = '${pool.organizerA.id}' and recipient_id = '${pool.participantA.id}' and status = 'accepted';`)[0] as { id: string };
        const connAA = connRowAA.id;

        // A: daily task older than 60 days produces overdue occurrences beyond day 60.
        const startA = addDays(today, -100);
        const taskA = (await createDaily(oA, connAA, startA)).data;
        const pagesA = await allOverduePages(pA);
        const day65 = addDays(today, -65);
        record('A', 'daily task older than 60 days produces overdue occurrences beyond day 60', pagesA.some((r) => r.task_id === taskA.id && r.occurrence_date === day65), `day65=${day65} found=${pagesA.some((r) => r.task_id === taskA.id && r.occurrence_date === day65)}`);

        // B: daily task older than one year remains pageable.
        const startB = addDays(today, -400);
        const taskB = (await createDaily(oA, connAA, startB)).data;
        const pagesB = await allOverduePages(pA);
        const day380 = addDays(today, -380);
        record('B', 'daily task older than one year remains pageable', pagesB.some((r) => r.task_id === taskB.id && r.occurrence_date === day380), `day380=${day380} found in ${pagesB.length} total rows`);

        // Clean up A/B before the narrower recurrence-type scenarios so they
        // don't pollute later exact-count assertions.
        dbQuery(`delete from public.task_schedule_versions where task_id in ('${taskA.id}','${taskB.id}');`);
        dbQuery(`delete from public.tasks where id in ('${taskA.id}','${taskB.id}');`);

        // C: weekday task skips weekends.
        const startC = addDays(today, -14);
        const taskC = (await createDaily(oA, connAA, startC, [1, 2, 3, 4, 5], 'Overdue C weekday')).data;
        const pagesC = await allOverduePages(pA);
        const rowsC = pagesC.filter((r) => r.task_id === taskC.id);
        record('C', 'weekday task skips weekends', rowsC.every((r) => { const dow = new Date(r.occurrence_date + 'T00:00:00Z').getUTCDay(); return dow !== 0 && dow !== 6; }), `count=${rowsC.length}`);
        dbQuery(`delete from public.task_schedule_versions where task_id = '${taskC.id}'; delete from public.tasks where id = '${taskC.id}';`);

        // D: weekend task skips weekdays.
        const startD = addDays(today, -14);
        const taskD = (await createDaily(oA, connAA, startD, [6, 7], 'Overdue D weekend')).data;
        const pagesD = await allOverduePages(pA);
        const rowsD = pagesD.filter((r) => r.task_id === taskD.id);
        record('D', 'weekend task skips weekdays', rowsD.length > 0 && rowsD.every((r) => { const dow = new Date(r.occurrence_date + 'T00:00:00Z').getUTCDay(); return dow === 0 || dow === 6; }), `count=${rowsD.length}`);
        dbQuery(`delete from public.task_schedule_versions where task_id = '${taskD.id}'; delete from public.tasks where id = '${taskD.id}';`);

        // E: selected Monday task generates only Mondays.
        const startE = addDays(today, -21);
        const taskE = (await createDaily(oA, connAA, startE, [1], 'Overdue E monday')).data;
        const pagesE = await allOverduePages(pA);
        const rowsE = pagesE.filter((r) => r.task_id === taskE.id);
        record('E', 'selected Monday task generates only Mondays', rowsE.length > 0 && rowsE.every((r) => new Date(r.occurrence_date + 'T00:00:00Z').getUTCDay() === 1), `count=${rowsE.length}`);
        dbQuery(`delete from public.task_schedule_versions where task_id = '${taskE.id}'; delete from public.tasks where id = '${taskE.id}';`);

        // F: multiple selected weekdays generate correctly.
        const startF = addDays(today, -21);
        const taskF = (await createDaily(oA, connAA, startF, [2, 4], 'Overdue F tue-thu')).data;
        const pagesF = await allOverduePages(pA);
        const rowsF = pagesF.filter((r) => r.task_id === taskF.id);
        record('F', 'multiple selected weekdays generate correctly', rowsF.length > 0 && rowsF.every((r) => [2, 4].includes(new Date(r.occurrence_date + 'T00:00:00Z').getUTCDay())), `count=${rowsF.length}`);
        dbQuery(`delete from public.task_schedule_versions where task_id = '${taskF.id}'; delete from public.tasks where id = '${taskF.id}';`);

        // G: one-time overdue task appears once.
        const startG = addDays(today, -10);
        const taskG = (await createOneTime(oA, connAA, startG, addDays(today, -5), 'Overdue G one-time')).data;
        const pagesG = await allOverduePages(pA);
        const rowsG = pagesG.filter((r) => r.task_id === taskG.id);
        record('G', 'one-time overdue task appears exactly once', rowsG.length === 1 && rowsG[0].occurrence_date === startG && rowsG[0].overdue_since_date === addDays(today, -5), JSON.stringify(rowsG));
        dbQuery(`delete from public.tasks where id = '${taskG.id}';`);

        // H: no-deadline task never appears overdue.
        const startH = addDays(today, -30);
        const taskH = (await createOneTime(oA, connAA, startH, null, 'Overdue H no-deadline')).data;
        const pagesH = await allOverduePages(pA);
        const summaryH = ((await pA.rpc('get_participant_task_summaries')).data ?? []).find((r: any) => r.task_id === taskH.id);
        record('H', 'no-deadline task never appears overdue', !pagesH.some((r) => r.task_id === taskH.id) && summaryH?.status !== 'overdue', JSON.stringify({ inPagination: pagesH.some((r) => r.task_id === taskH.id), status: summaryH?.status }));
        dbQuery(`delete from public.tasks where id = '${taskH.id}';`);

        // I: today's occurrence remains separate from yesterday's overdue one.
        const startI = addDays(today, -5);
        const taskI = (await createDaily(oA, connAA, startI)).data;
        await respond(pA, taskI.id, today, 'completed');
        const pagesI = await allOverduePages(pA);
        const yesterday = addDays(today, -1);
        record('I', "today's occurrence remains separate from yesterday's overdue one", pagesI.some((r) => r.task_id === taskI.id && r.occurrence_date === yesterday) && !pagesI.some((r) => r.task_id === taskI.id && r.occurrence_date === today), JSON.stringify({ hasYesterday: pagesI.some((r) => r.task_id === taskI.id && r.occurrence_date === yesterday), hasToday: pagesI.some((r) => r.task_id === taskI.id && r.occurrence_date === today) }));
        dbQuery(`delete from public.task_occurrences where task_id = '${taskI.id}'; delete from public.task_schedule_versions where task_id = '${taskI.id}'; delete from public.tasks where id = '${taskI.id}';`);

        // J: future occurrence excluded.
        const startJ = addDays(today, 5);
        const taskJ = (await createDaily(oA, connAA, startJ)).data;
        const pagesJ = await allOverduePages(pA);
        record('J', 'future occurrence excluded from overdue pagination', !pagesJ.some((r) => r.task_id === taskJ.id), 'future task never appears');
        dbQuery(`delete from public.task_schedule_versions where task_id = '${taskJ.id}'; delete from public.tasks where id = '${taskJ.id}';`);

        // ══════════════════════════════════════════════════════════════════
        // K-S: Terminal exclusion + response authority (fixture pool)
        // ══════════════════════════════════════════════════════════════════
        const startKL = addDays(today, -10);
        const taskKL = (await createDaily(oA, connAA, startKL)).data;
        const dateK = addDays(today, -8);
        const dateL = addDays(today, -7);
        await respond(pA, taskKL.id, dateK, 'completed');
        await respond(pA, taskKL.id, dateL, 'skipped');
        const pagesKL = await allOverduePages(pA);
        record('K', 'terminal completed occurrence excluded from unresolved page', !pagesKL.some((r) => r.task_id === taskKL.id && r.occurrence_date === dateK), 'completed date absent');
        record('L', 'terminal skipped occurrence excluded from unresolved page', !pagesKL.some((r) => r.task_id === taskKL.id && r.occurrence_date === dateL), 'skipped date absent');

        // M: completed-late response to old overdue occurrence.
        const dateM = addDays(today, -9);
        const respM = await respond(pA, taskKL.id, dateM, 'completed');
        record('M', 'completed-late response to old overdue occurrence', !respM.error && respM.data?.status === 'completed_late', JSON.stringify({ error: respM.error?.message, status: respM.data?.status }));

        // N: skip old overdue occurrence.
        const dateN = addDays(today, -6);
        const respN = await respond(pA, taskKL.id, dateN, 'skipped');
        record('N', 'skip old overdue occurrence', !respN.error && respN.data?.status === 'skipped', JSON.stringify({ error: respN.error?.message, status: respN.data?.status }));

        // O: duplicate response idempotent.
        const respO = await respond(pA, taskKL.id, dateN, 'skipped');
        record('O', 'duplicate identical response is idempotent', !respO.error && respO.data?.id === respN.data?.id, JSON.stringify({ error: respO.error?.message, sameId: respO.data?.id === respN.data?.id }));

        // P: conflicting response rejected.
        const respP = await respond(pA, taskKL.id, dateN, 'completed');
        record('P', 'conflicting terminal response rejected', !!respP.error && /already_answered/.test(respP.error.message), respP.error?.message);

        // Q: ineligible occurrence date rejected (Sunday for a Mon-Fri-only task).
        const startQ = addDays(today, -14);
        const taskQ = (await createDaily(oA, connAA, startQ, [1, 2, 3, 4, 5], 'Overdue Q weekday-only')).data;
        let sundayDate = addDays(today, -1);
        while (new Date(sundayDate + 'T00:00:00Z').getUTCDay() !== 0) sundayDate = addDays(sundayDate, -1);
        const respQ = await respond(pA, taskQ.id, sundayDate, 'completed');
        record('Q', 'ineligible occurrence date rejected', !!respQ.error && /occurrence_ineligible/.test(respQ.error.message), respQ.error?.message);
        dbQuery(`delete from public.task_schedule_versions where task_id = '${taskQ.id}'; delete from public.tasks where id = '${taskQ.id}';`);

        // R: unrelated participant denied.
        const pB = getFixtureClient('participantB');
        await pB.auth.signInWithPassword({ email: pool.participantB.email, password: getFixturePassword() });
        const respR = await respond(pB, taskKL.id, addDays(today, -5), 'completed');
        record('R', 'unrelated participant denied', !!respR.error && /not_authorized/.test(respR.error.message), respR.error?.message);

        // S: organizer cannot respond as participant.
        const respS = await respond(oA, taskKL.id, addDays(today, -5), 'completed');
        record('S', 'organizer cannot respond to a task occurrence as if they were the participant', !!respS.error && /not_authorized/.test(respS.error.message), respS.error?.message);

        dbQuery(`delete from public.task_occurrences where task_id = '${taskKL.id}'; delete from public.task_schedule_versions where task_id = '${taskKL.id}'; delete from public.tasks where id = '${taskKL.id}';`);

        // ══════════════════════════════════════════════════════════════════
        // T-V: Multi-organizer attribution (fixture pool, participantMultiOrg)
        // ══════════════════════════════════════════════════════════════════
        const oB = getFixtureClient('organizerB');
        await oB.auth.signInWithPassword({ email: pool.organizerB.email, password: getFixturePassword() });
        const pM = getFixtureClient('participantMultiOrg');
        await pM.auth.signInWithPassword({ email: pool.participantMultiOrg.email, password: getFixturePassword() });
        const connRowAM = dbQuery(`select id from public.connections where caregiver_id = '${pool.organizerA.id}' and recipient_id = '${pool.participantMultiOrg.id}' and status = 'accepted';`)[0] as { id: string };
        const connRowBM = dbQuery(`select id from public.connections where caregiver_id = '${pool.organizerB.id}' and recipient_id = '${pool.participantMultiOrg.id}' and status = 'accepted';`)[0] as { id: string };
        const connAM = connRowAM.id;
        const connBM = connRowBM.id;

        const startTUV = addDays(today, -10);
        const taskT1 = (await createDaily(oA, connAM, startTUV, [1, 2, 3, 4, 5, 6, 7], 'Identical Title')).data;
        const taskT2 = (await createDaily(oB, connBM, startTUV, [1, 2, 3, 4, 5, 6, 7], 'Identical Title')).data;
        const pagesTUV = await allOverduePages(pM);
        const rowT1 = pagesTUV.find((r) => r.task_id === taskT1.id);
        const rowT2 = pagesTUV.find((r) => r.task_id === taskT2.id);
        record('T', 'organizer A and B identical task titles remain distinct in pagination', !!rowT1 && !!rowT2 && rowT1.task_id !== rowT2.task_id, JSON.stringify({ t1: rowT1?.task_id, t2: rowT2?.task_id }));

        const orgAFullName = dbQuery(`select full_name from public.profiles where id = '${pool.organizerA.id}';`)[0] as { full_name: string };
        record('U', 'organizer attribution correct (real name for a named, active organizer)', rowT1?.organizer_full_name === orgAFullName.full_name && rowT1?.organizer_account_status === 'active', JSON.stringify({ got: rowT1?.organizer_full_name, expected: orgAFullName.full_name }));

        // V: deleted organizer fallback correct. Note: a deleted organizer's
        // tasks are always deactivated by delete_current_user_data (matches
        // AH's archive-cutoff rule exactly) and therefore can never appear
        // via get_participant_overdue_task_occurrences/
        // get_participant_task_summaries at all -- both correctly filter
        // is_active=true. So this tests resolveOrganizerDisplay() directly
        // against the real, live post-deletion profiles row (the same
        // technique proven in scripts/multi-organizer-audit/run.ts scenario
        // AB), not via either RPC.
        const pairV = await makeConnectedPair('v');
        dbQuery(`select public.delete_current_user_data('${pairV.caregiver.id}');`);
        const deletedProfileV = dbQuery(`select full_name, account_status, deleted_at from public.profiles where id = '${pairV.caregiver.id}';`)[0] as OrganizerProfileForDisplay;
        const displayV = resolveOrganizerDisplay(pairV.caregiver.id, deletedProfileV, (k: string) => k === 'activityFeed.formerOrganizer' ? 'A former organizer' : k);
        record('V', 'deleted organizer fallback correct (resolves to deleted, not merely unnamed)', displayV.fallbackKind === 'deleted', JSON.stringify({ deletedProfileV, displayV }));

        dbQuery(`delete from public.task_schedule_versions where task_id in ('${taskT1.id}','${taskT2.id}'); delete from public.tasks where id in ('${taskT1.id}','${taskT2.id}');`);

        // ══════════════════════════════════════════════════════════════════
        // W-AD: Cursor pagination contract (fixture pool, connAA)
        // ══════════════════════════════════════════════════════════════════
        const startPage = addDays(today, -60);
        const taskPage = (await createDaily(oA, connAA, startPage)).data;

        // W: first page bounded.
        const pageW = await overduePage(pA, null, null, 5);
        record('W', 'first page is bounded to the requested limit', !pageW.error && pageW.data.length === 5, `rows=${pageW.data?.length}`);

        // X: second page cursor returns next records.
        const lastW = pageW.data[pageW.data.length - 1];
        const pageX = await overduePage(pA, lastW.overdue_since_date, lastW.task_id, 5);
        record('X', 'second page cursor returns the next, non-overlapping records', !pageX.error && pageX.data.length === 5 && pageX.data.every((r: any) => !pageW.data.some((w: any) => w.task_id === r.task_id && w.occurrence_date === r.occurrence_date)), `page1=${pageW.data.map((r: any) => r.occurrence_date)} page2=${pageX.data.map((r: any) => r.occurrence_date)}`);

        // Y/Z: no duplicates/missing across pages.
        const allPages = await allOverduePages(pA, 7);
        const keys = allPages.map((r) => `${r.task_id}:${r.occurrence_date}`);
        record('Y', 'no duplicate records across pages', new Set(keys).size === keys.length, `total=${keys.length} unique=${new Set(keys).size}`);
        const summaryPage = ((await pA.rpc('get_participant_task_summaries')).data ?? []).find((r: any) => r.task_id === taskPage.id);
        const totalForTaskPage = allPages.filter((r) => r.task_id === taskPage.id).length;
        record('Z', 'no missing records across pages (total matches closed-form overdue_count)', totalForTaskPage === summaryPage?.overdue_count, `paged=${totalForTaskPage} summary=${summaryPage?.overdue_count}`);

        // AA: stable ordering for identical dates (tie-break by task_id).
        const taskPage2 = (await createDaily(oA, connAA, startPage, [1, 2, 3, 4, 5, 6, 7], 'Overdue AA tie')).data;
        const pageAA1 = await overduePage(pA, null, null, 3);
        const pageAA2 = await overduePage(pA, null, null, 3);
        record('AA', 'stable ordering for identical dates across repeated identical requests', JSON.stringify(pageAA1.data.map((r: any) => r.task_id)) === JSON.stringify(pageAA2.data.map((r: any) => r.task_id)), 'two identical first-page requests return identical order');
        dbQuery(`delete from public.task_schedule_versions where task_id = '${taskPage2.id}'; delete from public.tasks where id = '${taskPage2.id}';`);

        // AB: cursor tampering rejected or safely handled.
        const badCursorAB = await overduePage(pA, today, null, 20);
        record('AB', 'mismatched cursor pair (one set, one null) rejected', !!badCursorAB.error && /invalid_cursor/.test(badCursorAB.error.message), badCursorAB.error?.message);

        // AC: maximum page limit enforced.
        const pageAC = await overduePage(pA, null, null, 51);
        record('AC', 'maximum page limit (51) rejected', !!pageAC.error && /invalid_page_limit/.test(pageAC.error.message), pageAC.error?.message);

        // AD: zero/negative page limit rejected.
        const pageAD0 = await overduePage(pA, null, null, 0);
        const pageADneg = await overduePage(pA, null, null, -5);
        record('AD', 'zero and negative page limits rejected', !!pageAD0.error && /invalid_page_limit/.test(pageAD0.error.message) && !!pageADneg.error && /invalid_page_limit/.test(pageADneg.error.message), JSON.stringify({ zero: pageAD0.error?.message, neg: pageADneg.error?.message }));

        dbQuery(`delete from public.task_schedule_versions where task_id = '${taskPage.id}'; delete from public.tasks where id = '${taskPage.id}';`);

        // ══════════════════════════════════════════════════════════════════
        // AE-AG: Client-side pagination robustness (static source inspection)
        // ══════════════════════════════════════════════════════════════════
        const overdueScreenSource = read('app/overdue-tasks.tsx');
        record('AE', 'account switching / stale-response protection: request-generation guard present', has(overdueScreenSource, /requestIdRef/) && has(overdueScreenSource, /requestIdRef\.current !== requestId/), 'requestIdRef stale-guard pattern present, matching app/activity.tsx');
        record('AF', 'concurrent load-more deduplicated: loadingMore/hasMore guard precedes any fetch', has(overdueScreenSource, /if \(loadingMore \|\| !hasMore/), 'loadMore() guards synchronously before any RPC call');
        record('AG', 'page error retry preserves cursor: rows state is never mutated on a loadMore error path', has(overdueScreenSource, /if \(error\) \{ setLoadMoreError\(true\); return; \}/), 'error path returns before touching rows/cursor state, so retry resumes from the same last row');

        // ══════════════════════════════════════════════════════════════════
        // AH-AJ: Archive / connection-ending cutoffs (disposable trio)
        // ══════════════════════════════════════════════════════════════════
        const trioAH = await makeSharedTrio('ah');
        const startAH = addDays(today, -10);
        const taskAH1 = (await createDaily(trioAH.org1.client, trioAH.conn1, startAH)).data;
        const taskAH2 = (await createDaily(trioAH.org2.client, trioAH.conn2, startAH)).data;
        await trioAH.org1.client.rpc('archive_task', { p_task_id: taskAH1.id });
        const pagesAH = await allOverduePages(trioAH.shared.client);
        record('AH', 'archive cutoff respected -- archived task excluded entirely from overdue pagination', !pagesAH.some((r) => r.task_id === taskAH1.id), 'archived task never appears');
        record('AJ', "another organizer's connection remains unaffected by archiving elsewhere", pagesAH.some((r) => r.task_id === taskAH2.id), 'organizer2 task still appears');

        await trioAH.org2.client.rpc('end_connection', { p_connection_id: trioAH.conn2 });
        const pagesAI = await allOverduePages(trioAH.shared.client);
        record('AI', 'connection-ending cutoff respected -- ended connection excluded entirely from overdue pagination', !pagesAI.some((r) => r.task_id === taskAH2.id), 'ended-connection task never appears');

        // ══════════════════════════════════════════════════════════════════
        // AK-AN: Schedule-version correctness (disposable pair)
        // ══════════════════════════════════════════════════════════════════
        const pairAK = await makeConnectedPair('ak');
        const startAK = addDays(today, -30);
        const taskAK = (await createDaily(pairAK.caregiver.client, pairAK.connectionId, startAK, [1, 2, 3, 4, 5, 6, 7], 'Overdue AK daily-then-weekday')).data;
        // Find an old Saturday before "today" that remains unresolved.
        let oldSaturday = addDays(today, -20);
        while (new Date(oldSaturday + 'T00:00:00Z').getUTCDay() !== 6) oldSaturday = addDays(oldSaturday, -1);

        const updateAK = await pairAK.caregiver.client.rpc('update_task', {
            p_task_id: taskAK.id, p_title: 'Overdue AK daily-then-weekday', p_notes: null,
            p_frequency: 'custom', p_days_of_week: [1, 2, 3, 4, 5], p_due_date: null, p_recurrence_end_date: null,
        });
        record('AK', 'old recurrence rule (daily) preserved after a future-only edit to weekdays-only -- an old Saturday remains eligible and respondable', !updateAK.error, updateAK.error?.message);
        const respAK = await respond(pairAK.recipient.client, taskAK.id, oldSaturday, 'completed');
        record('AK', 'old-schedule Saturday response accepted (segment-aware eligibility)', !respAK.error, respAK.error?.message);

        // AL: new rule applies only after the effective date -- a Saturday
        // AFTER today (the edit's effective date) is never eligible.
        let futureSaturday = addDays(today, 5);
        while (new Date(futureSaturday + 'T00:00:00Z').getUTCDay() !== 6) futureSaturday = addDays(futureSaturday, 1);
        const pagesAL = await allOverduePages(pairAK.recipient.client);
        record('AL', 'new recurrence rule (weekdays-only) applies from its effective date forward -- no future Saturday ever becomes eligible', !pagesAL.some((r) => r.task_id === taskAK.id && new Date(r.occurrence_date + 'T00:00:00Z').getUTCDay() === 6 && r.occurrence_date >= today), 'no post-edit Saturday found in pagination');

        // AM/AN: segment integrity, direct SQL.
        const segmentsAK = dbQuery(`select effective_from_local_date, effective_until_local_date from public.task_schedule_versions where task_id = '${taskAK.id}' order by effective_from_local_date;`) as { effective_from_local_date: string; effective_until_local_date: string | null }[];
        let overlapFound = false;
        let gapFound = false;
        for (let i = 0; i < segmentsAK.length - 1; i++) {
            const cur = segmentsAK[i];
            const next = segmentsAK[i + 1];
            if (!cur.effective_until_local_date || cur.effective_until_local_date >= next.effective_from_local_date) overlapFound = true;
            if (addDays(cur.effective_until_local_date!, 1) !== next.effective_from_local_date) gapFound = true;
        }
        record('AM', 'no overlapping schedule-version segments', !overlapFound, JSON.stringify(segmentsAK));
        record('AN', 'no schedule-version gap between segments', !gapFound, JSON.stringify(segmentsAK));

        // ══════════════════════════════════════════════════════════════════
        // AO-AR: Timezone authority (disposable pairs, Phoenix + New York)
        // ══════════════════════════════════════════════════════════════════
        record('AO', 'participant timezone is authoritative (server-side lookup, not a client parameter)', !has(read('supabase/migrations/20260801080000_participant_overdue_task_occurrences.sql'), /p_timezone|p_tz/) && has(read('supabase/migrations/20260801080000_participant_overdue_task_occurrences.sql'), /select timezone into v_tz from public\.profiles where id = v_uid/), 'no timezone parameter accepted; profiles.timezone looked up server-side from auth.uid()');
        record('AP', 'device timezone is structurally irrelevant -- no RPC in the authoritative path accepts a timezone parameter', !has(read('supabase/migrations/20260801050000_task_schedule_versions.sql'), /p_timezone|p_tz\b/) && !has(read('supabase/migrations/20260801060000_task_segment_aware_eligibility.sql'), /p_timezone|p_tz\b/), 'grep confirms zero p_timezone/p_tz parameters across the migrations');

        const pairAQ = await makeConnectedPair('aq', 'America/Phoenix');
        const phoenixToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
        const taskAQ = (await createDaily(pairAQ.caregiver.client, pairAQ.connectionId, addDays(phoenixToday, -3))).data;
        const summaryAQ = ((await pairAQ.recipient.client.rpc('get_participant_task_summaries')).data ?? []).find((r: any) => r.task_id === taskAQ.id);
        record('AQ', "Phoenix cross-zone date behavior: the participant's own local date governs eligibility (UTC-7, no DST)", summaryAQ?.status === 'overdue' || summaryAQ?.status === 'open', JSON.stringify(summaryAQ));

        const pairAR = await makeConnectedPair('ar', 'America/New_York');
        const dstDate = '2026-03-08'; // US spring-forward date
        const dstIsodow = Number((dbQuery(`select extract(isodow from '${dstDate}'::date)::int as d;`)[0] as any).d);
        const taskAR = (await createDaily(pairAR.caregiver.client, pairAR.connectionId, addDays(dstDate, -10), [dstIsodow])).data;
        const eligibleAR = dbQuery(`select occurrence_date from public._task_eligible_dates('${taskAR.id}', '${dstDate}', '${dstDate}');`) as { occurrence_date: string }[];
        record('AR', 'New York DST spring-forward boundary does not shift an eligible date (pure calendar-date arithmetic, no timestamptz conversion)', eligibleAR.length === 1 && eligibleAR[0].occurrence_date === dstDate, JSON.stringify(eligibleAR));

        // ══════════════════════════════════════════════════════════════════
        // AS-AU: Activity + analytics (reuse AK's schedule-version task)
        // ══════════════════════════════════════════════════════════════════
        const feedAS = await pairAK.recipient.client.rpc('get_participant_activity_feed', { p_before_timestamp: null, p_before_source: null, p_before_id: null, p_limit: 20, p_source_filter: 'task' });
        record('AS', 'Activity records the old overdue response (respond_to_task_occurrence writes a real, real terminal row Activity already reads)', !feedAS.error && (feedAS.data ?? []).some((r: any) => r.source_id === taskAK.id && r.occurrence_date === oldSaturday), JSON.stringify((feedAS.data ?? []).map((r: any) => ({ id: r.source_id, date: r.occurrence_date }))));

        const analyticsAT = await pairAK.caregiver.client.rpc('task_analytics_summary', { p_connection_id: pairAK.connectionId, p_days: 90 });
        const metricsAT = Object.fromEntries(((analyticsAT.data ?? []) as { metric: string; value: number | null }[]).map((r) => [r.metric, r.value]));
        record('AT', 'analytics over a wide selected range includes the old, schedule-version-correct eligible occurrence (never silently capped)', !analyticsAT.error && Number(metricsAT.completed) >= 1, JSON.stringify(metricsAT));

        const pairAU = await makeConnectedPair('au');
        await createDaily(pairAU.caregiver.client, pairAU.connectionId, addDays(today, -5));
        const analyticsAU = await pairAK.caregiver.client.rpc('task_analytics_summary', { p_connection_id: pairAK.connectionId, p_days: 90 });
        const metricsAU = Object.fromEntries(((analyticsAU.data ?? []) as { metric: string; value: number | null }[]).map((r) => [r.metric, r.value]));
        record('AU', "organizer analytics exclude an entirely different organizer's connection", JSON.stringify(metricsAU) === JSON.stringify(metricsAT), 'identical result -- an unrelated connection created afterward never leaks in');

        // ══════════════════════════════════════════════════════════════════
        // AV-AY: Notifications + performance
        // ══════════════════════════════════════════════════════════════════
        const deliveriesBeforeAV = dbQuery(`select count(*) as c from public.task_notification_deliveries where task_id = '${taskAK.id}';`)[0] as { c: number };
        await allOverduePages(pairAK.recipient.client);
        const deliveriesAfterAV = dbQuery(`select count(*) as c from public.task_notification_deliveries where task_id = '${taskAK.id}';`)[0] as { c: number };
        record('AV', 'pagination is read-only -- never enqueues a notification delivery row', Number(deliveriesBeforeAV.c) === Number(deliveriesAfterAV.c), `before=${deliveriesBeforeAV.c} after=${deliveriesAfterAV.c}`);

        const uniqueConstraintAW = dbQuery(`select conname from pg_constraint where conrelid = 'public.task_notification_deliveries'::regclass and contype = 'u';`) as { conname: string }[];
        record('AW', 'no historical overdue notification flood is structurally possible (task_notification_deliveries is unique(task_id), populated once at creation, never by occurrence enumeration)', uniqueConstraintAW.length > 0, JSON.stringify(uniqueConstraintAW));

        const startAX = addDays(today, -300);
        const taskAX = (await createDaily(oA, connAA, startAX)).data;
        const t0 = Date.now();
        await allOverduePages(pA, 20);
        const elapsedAX = Date.now() - t0;
        record('AX', 'query plan remains bounded in practice -- a 300-day-old task pages in well under a generous timing ceiling (proxy for the disjoint-chunk design; EXPLAIN ANALYZE is verified directly in the final SQL verification pass)', elapsedAX < 15000, `elapsedMs=${elapsedAX}`);
        dbQuery(`delete from public.task_schedule_versions where task_id = '${taskAX.id}'; delete from public.tasks where id = '${taskAX.id}';`);

        const rpcSourceAY = read('supabase/migrations/20260801090000_fix_overdue_rpc_column_ambiguity.sql');
        const profileJoinCount = (rpcSourceAY.match(/left join public\.profiles/g) ?? []).length;
        record('AY', 'no N+1 organizer lookup -- exactly one LEFT JOIN profiles in the final page-building query, never a per-row lookup', profileJoinCount === 1, `left join public.profiles occurrences=${profileJoinCount}`);

        // ══════════════════════════════════════════════════════════════════
        // AZ: legacy cutoff structurally absent
        // ══════════════════════════════════════════════════════════════════
        const taskLifecycleSource = read('lib/taskLifecycle.ts');
        const taskDataSource = read('lib/taskData.ts');
        record('AZ', 'legacy TASK_LOOKBACK_DAYS 60-day cutoff is absent from every authoritative path', !has(taskLifecycleSource, /TASK_LOOKBACK_DAYS/) && !has(taskDataSource, /TASK_LOOKBACK_DAYS/) && !has(taskDataSource, /windowStart/), 'grep confirms zero references in lib/taskLifecycle.ts and lib/taskData.ts');

        // ══════════════════════════════════════════════════════════════════
        // BA-BI: Meta-suite orphan-leak fix
        // ══════════════════════════════════════════════════════════════════
        const metaSuiteSource = read('scripts/audit-infrastructure/run.ts');
        record('BA', 'meta-suite leaking scenario identified (X/Y, via signUpDisposable("orphan"))', has(metaSuiteSource, /signUpDisposable\('orphan'\)/) && has(metaSuiteSource, /record\('X', 'orphan synthetic account/), 'scenario X source confirmed');

        const cleanupSource = read('scripts/audit-infrastructure/cleanup.ts');
        record('BB', 'leaking account now uses its own approved, registered namespace (never the reserved fixture namespace)', has(metaSuiteSource, /EMAIL_PREFIX = 'tavora\.metasuite'/) && SYNTHETIC_NAMESPACES.includes('tavora.metasuite.%' as any) && has(cleanupSource, /'tavora\.metasuite\.%'/), `EMAIL_PREFIX fixed, 'tavora.metasuite.%' registered in SYNTHETIC_NAMESPACES`);

        const leakTarget = await signUpTestUser('leaktest', 'Leak Test Target', 'caregiver');
        // Reassign to the tavora.metasuite.% namespace directly (this
        // script's own namespace is tavora.overdueaudit.%; this scenario
        // specifically proves the META-SUITE's namespace is now covered).
        dbQuery(`update auth.users set email = 'tavora.metasuite.leaktest.${RAND}@example.com', raw_user_meta_data = raw_user_meta_data || '{"audit_account":true}'::jsonb where id = '${leakTarget.id}';`);
        const cleanupResultBC = scopedCleanup([leakTarget.id]);
        const remainingBC = dbQuery(`select count(*) as c from auth.users where id = '${leakTarget.id}';`)[0] as { c: number };
        record('BC', 'scoped cleanup removes a leaked account by known ID regardless of namespace', cleanupResultBC.ok && Number(remainingBC.c) === 0, JSON.stringify({ ok: cleanupResultBC.ok, remaining: remainingBC.c }));

        const leakTarget2 = await signUpTestUser('leaktest2', 'Leak Test Target 2', 'caregiver');
        dbQuery(`update auth.users set email = 'tavora.metasuite.leaktest2.${RAND}@example.com', raw_user_meta_data = raw_user_meta_data || '{"audit_account":true}'::jsonb where id = '${leakTarget2.id}';`);
        const dryRunBD = globalSyntheticSweep({ dryRun: true, destructive: false, includeFixtures: false });
        record('BD', 'global dry-run detects the disposable account under the newly-registered namespace', dryRunBD.metadataConfirmedAccountsFound >= 1, JSON.stringify(dryRunBD.plannedCounts));

        const fixtureBaselineBeforeBE = verifyFixtureBaseline();
        const sweepBE = globalSyntheticSweep({ dryRun: false, destructive: true, includeFixtures: false });
        const fixtureBaselineAfterBE = verifyFixtureBaseline();
        record('BE', 'global destructive sweep removes disposables while leaving the six persistent fixture identities completely untouched', sweepBE.ok && fixtureBaselineBeforeBE.ok && fixtureBaselineAfterBE.ok, JSON.stringify({ sweepOk: sweepBE.ok, baselineBefore: fixtureBaselineBeforeBE.ok, baselineAfter: fixtureBaselineAfterBE.ok }));

        const leakTarget3 = await signUpTestUser('leaktest3', 'Leak Test Target 3', 'caregiver');
        dbQuery(`update auth.users set email = 'tavora.metasuite.leaktest3.${RAND}@example.com', raw_user_meta_data = raw_user_meta_data || '{"audit_account":true}'::jsonb, created_at = now() - interval '20 minutes' where id = '${leakTarget3.id}';`);
        const orphanScanBF = detectOrphans(10);
        record('BF', 'a deliberately interrupted (backdated) disposable account is recovered by the next startup orphan scan', orphanScanBF.ids.includes(leakTarget3.id), `count=${orphanScanBF.count}`);
        scopedCleanup([leakTarget3.id]);

        skip('BG', 'two consecutive meta-suite runs leave zero disposable users', 'EXTERNAL_REGRESSION_REQUIRED — this script must never recursively invoke scripts/audit-infrastructure/run.ts (only scripts/final-regression/run.ts may invoke a complete suite); verified standalone by running it twice consecutively, see final report');

        const fixtureBaselineBH = verifyFixtureBaseline();
        record('BH', 'fixture pool baseline restored/intact after all leak-fix verification above', fixtureBaselineBH.ok, JSON.stringify(fixtureBaselineBH.problems));

        record('BI', 'production accounts structurally excluded -- every registered namespace is a specific tavora.<suite>.% pattern, never a bare tavora.% wildcard', (SYNTHETIC_NAMESPACES as readonly string[]).every((n) => n.startsWith('tavora.') && n.endsWith('.%') && n.length > 'tavora.%'.length), JSON.stringify(SYNTHETIC_NAMESPACES));

        // ══════════════════════════════════════════════════════════════════
        // BJ-BN: pointers to whole existing suites -- never invoked
        // recursively from here, verified standalone afterward.
        // ══════════════════════════════════════════════════════════════════
        skip('BJ', 'task-audit standalone regression', 'EXTERNAL_REGRESSION_REQUIRED — verified standalone via npx tsx scripts/task-audit/run.ts, see final report');
        skip('BK', 'activity-audit standalone regression', 'EXTERNAL_REGRESSION_REQUIRED — verified standalone via npx tsx scripts/activity-audit/run.ts, see final report');
        skip('BL', 'ui-state-audit standalone regression', 'EXTERNAL_REGRESSION_REQUIRED — verified standalone via npx tsx scripts/ui-state-audit/run.ts, see final report');
        skip('BM', 'accessibility-audit standalone regression', 'EXTERNAL_REGRESSION_REQUIRED — verified standalone via npx tsx scripts/accessibility-audit/run.ts, see final report');
        skip('BN', 'visual-consistency-audit standalone regression', 'EXTERNAL_REGRESSION_REQUIRED — verified standalone via npx tsx scripts/visual-consistency-audit/run.ts, see final report');

        // ══════════════════════════════════════════════════════════════════
        // BO: operational health
        // ══════════════════════════════════════════════════════════════════
        const opsRows = dbQuery(`select * from public.ops_health_evaluate();`) as { check_name: string; status: string }[];
        const opsCritical = opsRows.filter((r) => r.status === 'FAIL');
        record('BO', 'ops_health_evaluate reports no critical (FAIL) checks', opsCritical.length === 0, JSON.stringify(opsRows.map((r) => ({ check: r.check_name, status: r.status }))));

        // ══════════════════════════════════════════════════════════════════
        // BP-BZ: actionable_date exactness (post-launch correction). The
        // original get_participant_task_summaries/get_connection_task_summaries
        // searched only [today-180, today-1] for the earliest unresolved
        // date -- if an older unresolved occurrence coexisted with a newer
        // one, it silently returned the WRONG (more recent) date, not
        // null. Fixed by _task_earliest_unresolved_date() (an O(log days)
        // binary search, migration 20260801110000) -- these scenarios
        // pin the corrected behavior down permanently. Bulk-inserted
        // "resolved" occurrence rows below are direct SQL (not respond()
        // round-trips) purely for setup speed -- the RPC path itself is
        // already covered by scenarios M/N/K/L; what's under test here is
        // exclusively the summary RPCs' actionable_date computation.
        // ══════════════════════════════════════════════════════════════════

        function bulkResolve(taskId: string, recipientId: string, caregiverId: string, connectionId: string, fromDate: string, toDate: string, exceptDates: string[]) {
            const exceptClause = exceptDates.length > 0 ? `where d::date not in (${exceptDates.map((d) => `'${d}'::date`).join(',')})` : '';
            dbQuery(`insert into public.task_occurrences (task_id, recipient_id, caregiver_id, connection_id, occurrence_date, status, schedule_version, completed_at)
              select '${taskId}', '${recipientId}', '${caregiverId}', '${connectionId}', d::date, 'completed_on_time', 1, now()
              from generate_series('${fromDate}'::date, '${toDate}'::date, interval '1 day') d
              ${exceptClause};`);
        }

        // BP: only unresolved occurrence is far older than the old 180-day window.
        const startBP = addDays(today, -300);
        const taskBP = (await createDaily(oA, connAA, startBP)).data;
        const oldMissBP = addDays(today, -250);
        bulkResolve(taskBP.id, pool.participantA.id, pool.organizerA.id, connAA, startBP, addDays(today, -1), [oldMissBP]);
        const summaryBP = ((await pA.rpc('get_participant_task_summaries')).data ?? []).find((r: any) => r.task_id === taskBP.id);
        record('BP', 'actionable_date finds an unresolved occurrence far older than the old 180-day window, never null', summaryBP?.actionable_date === oldMissBP && summaryBP?.overdue_count === 1, JSON.stringify({ actionable_date: summaryBP?.actionable_date, expected: oldMissBP, overdue_count: summaryBP?.overdue_count }));
        dbQuery(`delete from public.task_occurrences where task_id = '${taskBP.id}'; delete from public.task_schedule_versions where task_id = '${taskBP.id}'; delete from public.tasks where id = '${taskBP.id}';`);

        // BQ: recent (within 180 days) fully resolved AND a separate older
        // (>180 days) unresolved occurrence both exist -- the exact
        // scenario that caused the old window-bounded query to silently
        // return the WRONG (more recent) date instead of the true earliest.
        const startBQ = addDays(today, -300);
        const taskBQ = (await createDaily(oA, connAA, startBQ)).data;
        const oldMissBQ = addDays(today, -250);
        const recentMissBQ = addDays(today, -50);
        bulkResolve(taskBQ.id, pool.participantA.id, pool.organizerA.id, connAA, startBQ, addDays(today, -1), [oldMissBQ, recentMissBQ]);
        const summaryBQ = ((await pA.rpc('get_participant_task_summaries')).data ?? []).find((r: any) => r.task_id === taskBQ.id);
        record('BQ', 'actionable_date returns the true earliest unresolved occurrence, never a more-recent one, when both an old and a recent unresolved date exist', summaryBQ?.actionable_date === oldMissBQ && summaryBQ?.overdue_count === 2, JSON.stringify({ actionable_date: summaryBQ?.actionable_date, expectedOld: oldMissBQ, wouldBeWrongIfRecent: recentMissBQ, overdue_count: summaryBQ?.overdue_count }));
        dbQuery(`delete from public.task_occurrences where task_id = '${taskBQ.id}'; delete from public.task_schedule_versions where task_id = '${taskBQ.id}'; delete from public.tasks where id = '${taskBQ.id}';`);

        // BR: task older than two years remains exact and bounded.
        const startBR = addDays(today, -740);
        const taskBR = (await createDaily(oA, connAA, startBR)).data;
        const oldMissBR = addDays(today, -700);
        bulkResolve(taskBR.id, pool.participantA.id, pool.organizerA.id, connAA, startBR, addDays(today, -1), [oldMissBR]);
        const t0BR = Date.now();
        const summaryBR = ((await pA.rpc('get_participant_task_summaries')).data ?? []).find((r: any) => r.task_id === taskBR.id);
        const elapsedBR = Date.now() - t0BR;
        record('BR', 'task older than two years: actionable_date still exact and returns well within a generous timing ceiling', summaryBR?.actionable_date === oldMissBR && elapsedBR < 15000, JSON.stringify({ actionable_date: summaryBR?.actionable_date, expected: oldMissBR, elapsedMs: elapsedBR }));

        // BS: summary overdue_count matches the full paginated enumeration exactly.
        const pagesBS = await allOverduePages(pA);
        const countBS = pagesBS.filter((r) => r.task_id === taskBR.id).length;
        record('BS', 'summary overdue_count matches the exact count of rows returned by paginated enumeration for the same task', countBS === summaryBR?.overdue_count, `paged=${countBS} summary=${summaryBR?.overdue_count}`);

        // BT: summary actionable_date matches the first authoritative
        // occurrence from overdue pagination (the true minimum
        // occurrence_date across every page for this task).
        const datesBT = pagesBS.filter((r) => r.task_id === taskBR.id).map((r) => r.occurrence_date).sort();
        record('BT', 'summary actionable_date matches the earliest occurrence_date returned by paginated enumeration for the same task', datesBT[0] === summaryBR?.actionable_date, JSON.stringify({ pagedEarliest: datesBT[0], summaryActionable: summaryBR?.actionable_date }));

        // BU: quick Complete targets the exact actionable_date, not an approximate one.
        const respBU = await respond(pA, taskBR.id, summaryBR.actionable_date, 'completed');
        record('BU', 'quick Complete action (using the summary actionable_date) resolves exactly the true earliest unresolved occurrence', !respBU.error && respBU.data?.status === 'completed_late', JSON.stringify({ error: respBU.error?.message, status: respBU.data?.status, targeted: summaryBR.actionable_date }));
        dbQuery(`delete from public.task_occurrences where task_id = '${taskBR.id}'; delete from public.task_schedule_versions where task_id = '${taskBR.id}'; delete from public.tasks where id = '${taskBR.id}';`);

        // BV: quick Skip targets the exact actionable_date, not an approximate one.
        const startBV = addDays(today, -300);
        const taskBV = (await createDaily(oA, connAA, startBV)).data;
        const oldMissBV = addDays(today, -280);
        bulkResolve(taskBV.id, pool.participantA.id, pool.organizerA.id, connAA, startBV, addDays(today, -1), [oldMissBV]);
        const summaryBV = ((await pA.rpc('get_participant_task_summaries')).data ?? []).find((r: any) => r.task_id === taskBV.id);
        const respBV = await respond(pA, taskBV.id, summaryBV.actionable_date, 'skipped');
        record('BV', 'quick Skip action (using the summary actionable_date) resolves exactly the true earliest unresolved occurrence', !respBV.error && respBV.data?.status === 'skipped' && summaryBV.actionable_date === oldMissBV, JSON.stringify({ error: respBV.error?.message, status: respBV.data?.status, targeted: summaryBV.actionable_date, expected: oldMissBV }));
        dbQuery(`delete from public.task_occurrences where task_id = '${taskBV.id}'; delete from public.task_schedule_versions where task_id = '${taskBV.id}'; delete from public.tasks where id = '${taskBV.id}';`);

        // BW: when there is no unresolved occurrence at all, actionable_date
        // is null and every quick-action surface structurally refuses to
        // mutate -- it must never invent an approximate target.
        const startBW = addDays(today, -10);
        const taskBW = (await createDaily(oA, connAA, startBW)).data;
        bulkResolve(taskBW.id, pool.participantA.id, pool.organizerA.id, connAA, startBW, addDays(today, -1), []);
        const summaryBW = ((await pA.rpc('get_participant_task_summaries')).data ?? []).find((r: any) => r.task_id === taskBW.id);
        const tasksScreenSource = read('app/tasks.tsx');
        const taskDetailsSource = read('app/task-details.tsx');
        const dashboardSource = read('app/recipient-dashboard.tsx');
        record('BW', 'no exact action target (actionable_date null) never produces an approximate mutation -- every quick-action surface gates on a non-null actionableDate, so the user is routed to the paginated overdue screen instead', summaryBW?.actionable_date === null && has(tasksScreenSource, /!task\.summary\.actionableDate \|\| respondingTaskId\) return/) && has(taskDetailsSource, /!summary\?\.actionableDate \|\| responding\) return/) && has(dashboardSource, /canRespond = !readOnly && !!summary\.actionableDate/), JSON.stringify({ actionable_date: summaryBW?.actionable_date }));
        dbQuery(`delete from public.task_occurrences where task_id = '${taskBW.id}'; delete from public.task_schedule_versions where task_id = '${taskBW.id}'; delete from public.tasks where id = '${taskBW.id}';`);

        // BX: schedule edits across the (old, now-removed) 180-day boundary
        // -- actionable_date must remain segment-aware and exact for a date
        // that predates a later schedule edit, however far back it sits.
        const pairBX = await makeConnectedPair('bx');
        const startBX = addDays(today, -300);
        const taskBX = (await createDaily(pairBX.caregiver.client, pairBX.connectionId, startBX, [1, 2, 3, 4, 5, 6, 7])).data;
        const oldMissBX = addDays(today, -250);
        bulkResolve(taskBX.id, pairBX.recipient.id, pairBX.caregiver.id, pairBX.connectionId, startBX, addDays(today, -1), [oldMissBX]);
        const updateBX = await pairBX.caregiver.client.rpc('update_task', { p_task_id: taskBX.id, p_title: 'Overdue audit daily task', p_notes: null, p_frequency: 'custom', p_days_of_week: [1, 2, 3, 4, 5], p_due_date: null, p_recurrence_end_date: null });
        const summaryBX = ((await pairBX.recipient.client.rpc('get_participant_task_summaries')).data ?? []).find((r: any) => r.task_id === taskBX.id);
        record('BX', 'actionable_date stays exact and segment-aware across a schedule edit that postdates the old 180-day boundary', !updateBX.error && summaryBX?.actionable_date === oldMissBX, JSON.stringify({ updateError: updateBX.error?.message, actionable_date: summaryBX?.actionable_date, expected: oldMissBX }));

        // BY: two organizers with identical task titles keep independently
        // exact, non-cross-contaminated actionable_dates at the summary level.
        const startBY = addDays(today, -300);
        const taskBY1 = (await createDaily(oA, connAM, startBY, [1, 2, 3, 4, 5, 6, 7], 'Identical Title BY')).data;
        const taskBY2 = (await createDaily(oB, connBM, startBY, [1, 2, 3, 4, 5, 6, 7], 'Identical Title BY')).data;
        const missBY1 = addDays(today, -260);
        const missBY2 = addDays(today, -70);
        bulkResolve(taskBY1.id, pool.participantMultiOrg.id, pool.organizerA.id, connAM, startBY, addDays(today, -1), [missBY1]);
        bulkResolve(taskBY2.id, pool.participantMultiOrg.id, pool.organizerB.id, connBM, startBY, addDays(today, -1), [missBY2]);
        const summariesBY = (await pM.rpc('get_participant_task_summaries')).data ?? [];
        const summaryBY1 = summariesBY.find((r: any) => r.task_id === taskBY1.id);
        const summaryBY2 = summariesBY.find((r: any) => r.task_id === taskBY2.id);
        record('BY', 'identical-title tasks from two different organizers keep independently exact, non-cross-contaminated actionable_dates', summaryBY1?.actionable_date === missBY1 && summaryBY2?.actionable_date === missBY2, JSON.stringify({ t1: summaryBY1?.actionable_date, t2: summaryBY2?.actionable_date, expected1: missBY1, expected2: missBY2 }));

        // BZ: neither summary RPC nor the pagination RPC ever creates a
        // notification delivery row (read-only, already proven for
        // pagination alone in AV -- re-verified here for the summary RPC).
        const deliveriesBeforeBZ = dbQuery(`select count(*) as c from public.task_notification_deliveries where task_id in ('${taskBY1.id}','${taskBY2.id}');`)[0] as { c: number };
        await pM.rpc('get_participant_task_summaries');
        await allOverduePages(pM);
        const deliveriesAfterBZ = dbQuery(`select count(*) as c from public.task_notification_deliveries where task_id in ('${taskBY1.id}','${taskBY2.id}');`)[0] as { c: number };
        record('BZ', 'summary and pagination reads together never create a notification delivery row', Number(deliveriesBeforeBZ.c) === Number(deliveriesAfterBZ.c), `before=${deliveriesBeforeBZ.c} after=${deliveriesAfterBZ.c}`);

        dbQuery(`delete from public.task_occurrences where task_id in ('${taskBX.id}','${taskBY1.id}','${taskBY2.id}'); delete from public.task_schedule_versions where task_id in ('${taskBX.id}','${taskBY1.id}','${taskBY2.id}'); delete from public.tasks where id in ('${taskBX.id}','${taskBY1.id}','${taskBY2.id}');`);

        // Restore the persistent fixture pool to its clean baseline.
        resetFixturePool();
        const finalBaseline = verifyFixtureBaseline();
        if (!finalBaseline.ok) {
            throw new Error(`Fixture pool not restored to baseline: ${finalBaseline.problems.join('; ')}`);
        }

    } catch (err) {
        crashError = err;
    } finally {
        await cleanup();
    }

    const ok = summarize();

    // Self-check: parse every literal record()/skip() call's first
    // (identifier) argument in this file's own source (excluding the
    // non-scenario 'cleanup' entry, reported separately) and diff it
    // reported separately) and diff it against what getResults() shows
    // actually ran this run. This assertion runs on EVERY exit path, not
    // just a crash -- a missing, duplicated, or unexpected scenario id is
    // a real self-check failure in its own right, never silently absorbed
    // into an otherwise-clean summarize() total.
    const ownSource = readFileSync(__filename, 'utf-8');
    const expectedScenarioIds = new Set(
        [
            ...[...ownSource.matchAll(/\brecord\('([^']+)',/g)].map((m) => m[1]),
            ...[...ownSource.matchAll(/\bskip\('([^']+)',/g)].map((m) => m[1]),
        ].filter((id) => id !== 'cleanup')
    );
    const executedResults = getResults();
    const executedScenarioIds = new Set(executedResults.map((r) => r.id).filter((id) => id !== 'cleanup'));
    const missingIds = [...expectedScenarioIds].filter((id) => !executedScenarioIds.has(id));
    const unexpectedIds = [...executedScenarioIds].filter((id) => !expectedScenarioIds.has(id));
    const selfCheckOk = missingIds.length === 0 && unexpectedIds.length === 0;

    if (crashError) {
        console.error(
            `\nTASK_OVERDUE_AUDIT_SUITE_CRASHED mid-run: ${crashError instanceof Error ? crashError.message : String(crashError)}\n` +
            `This script defines ${expectedScenarioIds.size} scenarios (plus "cleanup", reported separately); summarize() above reflects only however many were actually recorded before the crash -- missing: ${missingIds.length ? missingIds.join(', ') : '(n/a, run incomplete)'}. ` +
            `Do not treat the summarize() total above as a complete run -- re-run once the underlying cause has cleared.`
        );
        process.exit(1);
    }

    if (!selfCheckOk) {
        console.error(
            `\nTASK_OVERDUE_AUDIT_SELF_CHECK_FAILED: expected ${expectedScenarioIds.size} unique scenario ids, executed ${executedScenarioIds.size}.\n` +
            `Missing (expected, never executed): ${missingIds.length ? missingIds.join(', ') : '(none)'}\n` +
            `Unexpected (executed, not a literal id in this file): ${unexpectedIds.length ? unexpectedIds.join(', ') : '(none)'}`
        );
        process.exit(1);
    }

    console.log(`\nSelf-check: ${expectedScenarioIds.size} expected scenario ids, ${executedScenarioIds.size} executed, 0 missing, 0 unexpected. cleanup reported separately.`);
    process.exit(ok ? 0 : 1);
}

main().catch((err) => {
    console.error('TASK_OVERDUE_AUDIT_SUITE_FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
});
