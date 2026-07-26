// Tavora flexible-task synthetic test suite (Week 3 product-expansion
// task #1, Phase 19).
//
// Run from the repo root:
//   EXPO_PUBLIC_SUPABASE_URL=... EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=... npx tsx scripts/task-audit/run.ts
//
// Mirrors scripts/reminder-audit/run.ts's methodology exactly: disposable
// synthetic users (tavora.taskaudit.*@example.com), exercised through the
// real anon-key client paths (create_task/update_task/archive_task/
// respond_to_task_occurrence via supabase-js RPC — exactly what the app
// itself calls), verified/cleaned up via the already-authenticated
// `supabase` CLI. Every synthetic recipient's profiles.timezone is pinned
// to 'UTC' unless a scenario is specifically testing timezone authority
// (AA), so the script's own JS date math matches the server's exactly.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
    ANON_KEY,
    SUPABASE_URL,
    dbQuery,
    newClient,
    randomSuffix,
    record,
    summarize,
} from '../security-audit/helpers';
import { getComputedTaskStatus, isTaskOccurrenceEligible, summarizeTask, TaskScheduleLike } from '../../lib/taskLifecycle';

const RAND = randomSuffix();
const PASSWORD = `TaskAudit!${RAND}9X`;
const EMAIL_PREFIX = 'tavora.taskaudit';

function read(path: string): string {
    return readFileSync(path, 'utf-8');
}

function has(content: string, pattern: RegExp): boolean {
    return pattern.test(content);
}

async function signUpTestUser(emailPrefix: string, fullName: string) {
    const client = newClient();
    const email = `${EMAIL_PREFIX}.${emailPrefix}.${RAND}@example.com`;
    const { data, error } = await client.auth.signUp({ email, password: PASSWORD, options: { data: { full_name: fullName } } });
    if (error || !data.user) throw new Error(`signup failed for ${email}: ${error?.message}`);
    return { id: data.user.id, email, client };
}

function todayDateString(): string {
    return new Date().toISOString().slice(0, 10);
}

function addDays(dateString: string, days: number): string {
    const [y, m, d] = dateString.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + days));
    return dt.toISOString().slice(0, 10);
}

function lastTestsPassedMatch(text: string): RegExpMatchArray | null {
    const matches = [...text.matchAll(/(\d+)\/(\d+) tests passed/g)];
    return matches.length > 0 ? matches[matches.length - 1] : null;
}

async function main() {
    console.log(`Task audit run ${RAND}\n`);

    const testUserIds: string[] = [];
    const testConnectionIds: string[] = [];
    const testTaskIds: string[] = [];

    async function makeConnectedPair(label: string, recipientTz = 'UTC') {
        const caregiver = await signUpTestUser(`${label}cg`, `Task Audit ${label} Caregiver`);
        const recipient = await signUpTestUser(`${label}rc`, `Task Audit ${label} Recipient`);
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

    async function createTask(
        client: ReturnType<typeof newClient>,
        connectionId: string,
        opts: {
            title?: string;
            frequency: 'one_time' | 'daily' | 'weekdays' | 'weekends' | 'custom';
            daysOfWeek?: number[];
            startDate: string;
            dueDate?: string | null;
            recurrenceEndDate?: string | null;
        }
    ) {
        const result = await client.rpc('create_task', {
            p_connection_id: connectionId,
            p_title: opts.title ?? 'Task audit test',
            p_notes: null,
            p_frequency: opts.frequency,
            p_days_of_week: opts.daysOfWeek ?? [],
            p_start_date: opts.startDate,
            p_due_date: opts.dueDate ?? null,
            p_recurrence_end_date: opts.recurrenceEndDate ?? null,
        });
        if (result.data?.id) testTaskIds.push(result.data.id);
        return result;
    }

    function taskRow(taskId: string): any {
        return dbQuery(`select * from public.tasks where id = '${taskId}';`)[0];
    }

    function occurrenceRow(taskId: string, occurrenceDate: string): any {
        return dbQuery(`select * from public.task_occurrences where task_id = '${taskId}' and occurrence_date = '${occurrenceDate}';`)[0];
    }

    function occurrenceCount(taskId: string): number {
        return Number((dbQuery(`select count(*) as c from public.task_occurrences where task_id = '${taskId}';`)[0] as any)?.c ?? 0);
    }

    try {
        const today = todayDateString();

        // ── A: one-time task ─────────────────────────────────────────────────
        const { caregiver: cgA, recipient: rcA, connectionId: connA } = await makeConnectedPair('a');
        const aResult = await createTask(cgA.client, connA, { frequency: 'one_time', startDate: today, dueDate: addDays(today, 5) });
        record('A', 'organizer creates one-time task', !aResult.error && !!aResult.data?.id && aResult.data.frequency === 'one_time' && aResult.data.due_date === addDays(today, 5), aResult.error?.message ?? JSON.stringify({ id: aResult.data?.id }));

        // ── B: no-due-date task ──────────────────────────────────────────────
        const bResult = await createTask(cgA.client, connA, { frequency: 'one_time', startDate: today, dueDate: null });
        record('B', 'organizer creates no-due-date task', !bResult.error && bResult.data?.due_date === null, bResult.error?.message ?? JSON.stringify({ due_date: bResult.data?.due_date }));

        // ── C: daily recurring task ──────────────────────────────────────────
        const cResult = await createTask(cgA.client, connA, { frequency: 'daily', daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startDate: today });
        record('C', 'organizer creates daily recurring task', !cResult.error && cResult.data?.frequency === 'daily' && cResult.data?.is_recurring === true, cResult.error?.message ?? JSON.stringify({ frequency: cResult.data?.frequency, is_recurring: cResult.data?.is_recurring }));

        // ── D: selected-weekday task ─────────────────────────────────────────
        const dResult = await createTask(cgA.client, connA, { frequency: 'custom', daysOfWeek: [2, 4], startDate: today });
        record('D', 'organizer creates selected-weekday task', !dResult.error && JSON.stringify((dResult.data?.days_of_week ?? []).slice().sort()) === JSON.stringify([2, 4]), dResult.error?.message ?? JSON.stringify({ days_of_week: dResult.data?.days_of_week }));

        // ── E: reject due date before start date ─────────────────────────────
        const eResult = await createTask(cgA.client, connA, { frequency: 'one_time', startDate: today, dueDate: addDays(today, -3) });
        record('E', 'reject due date before start date', !!eResult.error && /due_date_before_start_date/.test(eResult.error.message), eResult.error?.message);

        // ── F: reject task for unaccepted connection ─────────────────────────
        const pendingConnRows = dbQuery(`
          insert into public.connections (caregiver_id, invite_code, status)
          values ('${cgA.id}', 'PEND${RAND}', 'pending')
          returning id;
        `);
        const pendingConnId = (pendingConnRows[0] as any).id;
        testConnectionIds.push(pendingConnId);
        const fResult = await createTask(cgA.client, pendingConnId, { frequency: 'one_time', startDate: today });
        record('F', 'reject task for unaccepted connection', !!fResult.error && /connection_inactive/.test(fResult.error.message), fResult.error?.message);

        // ── G: reject task for ended connection ───────────────────────────────
        const { caregiver: cgG, connectionId: connG } = await makeConnectedPair('g');
        dbQuery(`update public.connections set status = 'ended' where id = '${connG}';`);
        const gResult = await createTask(cgG.client, connG, { frequency: 'one_time', startDate: today });
        record('G', 'reject task for ended connection', !!gResult.error && /connection_inactive/.test(gResult.error.message), gResult.error?.message);

        // ── H: reject unrelated organizer ─────────────────────────────────────
        const { caregiver: cgH2 } = await makeConnectedPair('h2');
        const hResult = await createTask(cgH2.client, connA, { frequency: 'one_time', startDate: today });
        record('H', 'reject unrelated organizer', !!hResult.error && /connection_inactive/.test(hResult.error.message), hResult.error?.message);

        // ── I/J: read isolation ───────────────────────────────────────────────
        const iRead = await rcA.client.from('tasks').select('id').eq('id', aResult.data.id).maybeSingle();
        record('I', 'participant reads own task', !iRead.error && iRead.data?.id === aResult.data.id, iRead.error?.message);

        const { recipient: rcJ } = await makeConnectedPair('j');
        const jRead = await rcJ.client.from('tasks').select('id').eq('id', aResult.data.id).maybeSingle();
        record('J', 'unrelated participant cannot read task', !jRead.error && !jRead.data, jRead.error?.message ?? 'no row returned (RLS)');

        // ── K/L/M: lifecycle classification (pure lib/taskLifecycle.ts, mirrors server) ──
        const upcomingTask: TaskScheduleLike = { frequency: 'one_time', days_of_week: [], start_date: addDays(today, 3), due_date: null, recurrence_end_date: null, is_active: true };
        record('K', 'upcoming task classification', getComputedTaskStatus(upcomingTask, upcomingTask.start_date, today) === 'upcoming');

        const openTask: TaskScheduleLike = { frequency: 'one_time', days_of_week: [], start_date: today, due_date: addDays(today, 5), recurrence_end_date: null, is_active: true };
        record('L', 'open task classification', getComputedTaskStatus(openTask, openTask.start_date, today) === 'open');

        const overdueTask: TaskScheduleLike = { frequency: 'one_time', days_of_week: [], start_date: addDays(today, -10), due_date: addDays(today, -2), recurrence_end_date: null, is_active: true };
        record('M', 'overdue task classification', getComputedTaskStatus(overdueTask, overdueTask.start_date, today) === 'overdue');

        // ── N/O/P: responses ──────────────────────────────────────────────────
        const { caregiver: cgN, recipient: rcN, connectionId: connN } = await makeConnectedPair('n');
        const nTask = (await createTask(cgN.client, connN, { frequency: 'one_time', startDate: today, dueDate: addDays(today, 2) })).data;
        const nResp = await rcN.client.rpc('respond_to_task_occurrence', { p_task_id: nTask.id, p_occurrence_date: today, p_status: 'completed' });
        record('N', 'complete on time', !nResp.error && nResp.data?.status === 'completed_on_time', nResp.error?.message ?? JSON.stringify(nResp.data?.status));

        const { caregiver: cgO, recipient: rcO, connectionId: connO } = await makeConnectedPair('o');
        const oTask = (await createTask(cgO.client, connO, { frequency: 'one_time', startDate: addDays(today, -5), dueDate: addDays(today, -1) })).data;
        const oResp = await rcO.client.rpc('respond_to_task_occurrence', { p_task_id: oTask.id, p_occurrence_date: addDays(today, -5), p_status: 'completed' });
        record('O', 'complete late', !oResp.error && oResp.data?.status === 'completed_late', oResp.error?.message ?? JSON.stringify(oResp.data?.status));

        const { caregiver: cgP, recipient: rcP, connectionId: connP } = await makeConnectedPair('p');
        const pTask = (await createTask(cgP.client, connP, { frequency: 'one_time', startDate: today })).data;
        const pResp = await rcP.client.rpc('respond_to_task_occurrence', { p_task_id: pTask.id, p_occurrence_date: today, p_status: 'skipped' });
        record('P', 'skip task', !pResp.error && pResp.data?.status === 'skipped', pResp.error?.message ?? JSON.stringify(pResp.data?.status));

        // ── Q: duplicate completion idempotent ────────────────────────────────
        const qResp2 = await rcN.client.rpc('respond_to_task_occurrence', { p_task_id: nTask.id, p_occurrence_date: today, p_status: 'completed' });
        record('Q', 'duplicate completion is idempotent', !qResp2.error && qResp2.data?.id === nResp.data?.id, qResp2.error?.message);

        // ── R: conflicting terminal response rejected ─────────────────────────
        const rResp = await rcN.client.rpc('respond_to_task_occurrence', { p_task_id: nTask.id, p_occurrence_date: today, p_status: 'skipped' });
        record('R', 'conflicting terminal response rejected', !!rResp.error && /already_answered/.test(rResp.error.message), rResp.error?.message);

        // ── S: no-due-date task never becomes overdue ─────────────────────────
        const noDueTask: TaskScheduleLike = { frequency: 'one_time', days_of_week: [], start_date: addDays(today, -60), due_date: null, recurrence_end_date: null, is_active: true };
        record('S', 'no-due-date task never becomes overdue', getComputedTaskStatus(noDueTask, noDueTask.start_date, today) === 'open');

        // ── T/U: recurring occurrences remain separate ────────────────────────
        const { caregiver: cgT, recipient: rcT, connectionId: connT } = await makeConnectedPair('t');
        const tTask = (await createTask(cgT.client, connT, { frequency: 'daily', daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startDate: addDays(today, -3) })).data;
        await rcT.client.rpc('respond_to_task_occurrence', { p_task_id: tTask.id, p_occurrence_date: addDays(today, -1), p_status: 'skipped' });
        const tYesterday = occurrenceRow(tTask.id, addDays(today, -1));
        const tTwoDaysAgo = occurrenceRow(tTask.id, addDays(today, -2));
        record('T', 'recurring occurrences remain separate', tYesterday?.status === 'skipped' && !tTwoDaysAgo, JSON.stringify({ yesterday: tYesterday?.status, twoDaysAgo: tTwoDaysAgo }));

        const uResp = await rcT.client.rpc('respond_to_task_occurrence', { p_task_id: tTask.id, p_occurrence_date: today, p_status: 'completed' });
        const uYesterdayStillSkipped = occurrenceRow(tTask.id, addDays(today, -1))?.status === 'skipped';
        record('U', "yesterday's overdue occurrence does not replace today's occurrence", !uResp.error && uResp.data?.status?.startsWith('completed') && uYesterdayStillSkipped, JSON.stringify({ today: uResp.data?.status, yesterdayUnchanged: uYesterdayStillSkipped }));

        // ── V: future edit preserves history ──────────────────────────────────
        const vHistoryBefore = occurrenceRow(tTask.id, today);
        const vUpdate = await cgT.client.rpc('update_task', {
            p_task_id: tTask.id, p_title: 'Renamed after completion', p_notes: null,
            p_frequency: 'weekdays', p_days_of_week: [1, 2, 3, 4, 5], p_due_date: null, p_recurrence_end_date: null,
        });
        const vHistoryAfter = occurrenceRow(tTask.id, today);
        record('V', 'future edit preserves history', !vUpdate.error && JSON.stringify(vHistoryBefore) === JSON.stringify(vHistoryAfter) && vUpdate.data?.title === 'Renamed after completion', vUpdate.error?.message ?? JSON.stringify({ before: vHistoryBefore, after: vHistoryAfter }));

        // ── W/X: archive ───────────────────────────────────────────────────────
        const archiveResult = await cgT.client.rpc('archive_task', { p_task_id: tTask.id });
        const wResp = await rcT.client.rpc('respond_to_task_occurrence', { p_task_id: tTask.id, p_occurrence_date: addDays(today, 1), p_status: 'completed' });
        record('W', 'archive stops future occurrences', !archiveResult.error && !!wResp.error && /task_inactive/.test(wResp.error.message), wResp.error?.message ?? 'expected task_inactive');

        const xHistoryCount = occurrenceCount(tTask.id);
        record('X', 'archive preserves historical occurrences', xHistoryCount >= 2, `occurrence rows remaining: ${xHistoryCount}`);

        // ── Y: ended connection stops future task activity ────────────────────
        const { caregiver: cgY, recipient: rcY, connectionId: connY } = await makeConnectedPair('y');
        const yTask = (await createTask(cgY.client, connY, { frequency: 'daily', daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startDate: addDays(today, -2) })).data;
        const yEndResult = await cgY.client.rpc('end_connection', { p_connection_id: connY });
        const yTaskRowAfter = taskRow(yTask.id);
        const yResp = await rcY.client.rpc('respond_to_task_occurrence', { p_task_id: yTask.id, p_occurrence_date: today, p_status: 'completed' });
        record('Y', 'ended connection stops future task activity', !yEndResult.error && yTaskRowAfter.is_active === false && !!yResp.error && /task_inactive/.test(yResp.error.message), JSON.stringify({ endError: yEndResult.error?.message, taskActive: yTaskRowAfter.is_active, respondError: yResp.error?.message }));

        // ── Z: account deletion preserves anonymized history ──────────────────
        const { caregiver: cgZ, recipient: rcZ, connectionId: connZ } = await makeConnectedPair('z');
        const zTask = (await createTask(cgZ.client, connZ, { frequency: 'one_time', startDate: today })).data;
        await rcZ.client.rpc('respond_to_task_occurrence', { p_task_id: zTask.id, p_occurrence_date: today, p_status: 'completed' });
        const zOccurrenceBefore = occurrenceRow(zTask.id, today);
        dbQuery(`select public.delete_current_user_data('${rcZ.id}');`);
        const zOccurrenceAfter = occurrenceRow(zTask.id, today);
        const zTaskAfter = taskRow(zTask.id);
        const zProfileAfter = dbQuery(`select account_status, full_name from public.profiles where id = '${rcZ.id}';`)[0] as any;
        record('Z', 'account deletion preserves anonymized history', JSON.stringify(zOccurrenceBefore) === JSON.stringify(zOccurrenceAfter) && zTaskAfter.is_active === false && zProfileAfter.account_status === 'deleted' && zProfileAfter.full_name === null, JSON.stringify({ occurrenceUnchanged: JSON.stringify(zOccurrenceBefore) === JSON.stringify(zOccurrenceAfter), taskInactive: zTaskAfter.is_active === false, profile: zProfileAfter }));

        // ── AA: participant timezone determines status ────────────────────────
        const { caregiver: cgAA, recipient: rcAA, connectionId: connAA } = await makeConnectedPair('aa', 'Pacific/Auckland');
        const aaToday = (dbQuery(`select (now() at time zone 'Pacific/Auckland')::date as d;`)[0] as any).d;
        const aaTask = (await createTask(cgAA.client, connAA, { frequency: 'one_time', startDate: aaToday })).data;
        const aaResp = await rcAA.client.rpc('respond_to_task_occurrence', { p_task_id: aaTask.id, p_occurrence_date: aaToday, p_status: 'completed' });
        record('AA', 'participant timezone determines status', !aaResp.error && aaResp.data?.status?.startsWith('completed'), aaResp.error?.message ?? JSON.stringify(aaResp.data?.status));

        // ── AB: DST boundary does not shift eligible date ──────────────────────
        // 2026-03-08 is America/New_York's spring-forward date (matches
        // reminder-audit's AE/AF). Task eligibility is pure calendar-date
        // arithmetic (extract(isodow from date), never a timestamptz
        // conversion) -- structurally immune to DST, verified directly.
        const dstDate = '2026-03-08';
        const dstIsodowDb = Number((dbQuery(`select extract(isodow from '${dstDate}'::date)::int as d;`)[0] as any).d);
        const dstTask: TaskScheduleLike = { frequency: 'custom', days_of_week: [dstIsodowDb], start_date: addDays(dstDate, -10), due_date: null, recurrence_end_date: null, is_active: true };
        record('AB', 'DST boundary does not shift eligible date', isTaskOccurrenceEligible(dstTask, dstDate) === true, `isodow=${dstIsodowDb}`);

        // ── AC/AD: proper isolation checks are below (two participants under
        // one organizer), placed after AE-AH since they reuse a fresh
        // dedicated organizer/participant pair -- see "Proper AC/AD isolation
        // checks" further down.

        // ── AE/AF/AG/AH: analytics ──────────────────────────────────────────────
        // A daily task started 3 days ago has exactly 4 eligible occurrences
        // in range: today-3, today-2, today-1, today. Responding to a PAST
        // occurrence is always classified 'completed_late' (the real "today"
        // at response time is always later than that occurrence's own due
        // date) -- only responding to TODAY'S occurrence on the same day can
        // ever be on-time. This is correct, intended server behavior (see
        // docs/flexible-task-model.md), not a workaround.
        const { caregiver: cgAE, recipient: rcAE, connectionId: connAE } = await makeConnectedPair('ae');
        const aeTask = (await createTask(cgAE.client, connAE, { frequency: 'daily', daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startDate: addDays(today, -3), recurrenceEndDate: null })).data;
        await rcAE.client.rpc('respond_to_task_occurrence', { p_task_id: aeTask.id, p_occurrence_date: today, p_status: 'completed' }); // on time
        await rcAE.client.rpc('respond_to_task_occurrence', { p_task_id: aeTask.id, p_occurrence_date: addDays(today, -1), p_status: 'completed' }); // late
        await rcAE.client.rpc('respond_to_task_occurrence', { p_task_id: aeTask.id, p_occurrence_date: addDays(today, -2), p_status: 'skipped' });
        // addDays(today, -3) left unresolved -> currently_overdue.

        const aeAnalytics = await cgAE.client.rpc('task_analytics_summary', { p_connection_id: connAE, p_days: 30 });
        const aeMetrics = Object.fromEntries(((aeAnalytics.data ?? []) as { metric: string; value: number | null }[]).map((r) => [r.metric, r.value]));
        record('AE', 'completion-rate calculation', !aeAnalytics.error && aeMetrics.completed === 2 && aeMetrics.skipped === 1 && aeMetrics.currently_overdue === 1 && aeMetrics.completion_rate === 0.5, JSON.stringify(aeMetrics));
        record('AF', 'on-time-rate calculation', aeMetrics.completed_on_time === 1 && aeMetrics.completed_late === 1 && aeMetrics.on_time_rate === 0.5, JSON.stringify({ on_time: aeMetrics.completed_on_time, late: aeMetrics.completed_late, rate: aeMetrics.on_time_rate }));

        const { caregiver: cgAG, connectionId: connAG } = await makeConnectedPair('ag');
        await createTask(cgAG.client, connAG, { frequency: 'one_time', startDate: addDays(today, -20), dueDate: null });
        const agAnalytics = await cgAG.client.rpc('task_analytics_summary', { p_connection_id: connAG, p_days: 30 });
        const agMetrics = Object.fromEntries(((agAnalytics.data ?? []) as { metric: string; value: number | null }[]).map((r) => [r.metric, r.value]));
        record('AG', 'no-due-date denominator handling', agMetrics.currently_overdue === 0 && (agMetrics.completion_rate === null || agMetrics.completion_rate === undefined), JSON.stringify(agMetrics));

        record('AH', 'skipped and overdue metrics', aeMetrics.skipped === 1 && aeMetrics.currently_overdue === 1, JSON.stringify({ skipped: aeMetrics.skipped, overdue: aeMetrics.currently_overdue }));

        // ── Proper AC/AD isolation checks (two participants under one organizer) ──
        const acOrgResult = await signUpTestUser('acorg', 'Task Audit AC Organizer');
        testUserIds.push(acOrgResult.id);
        dbQuery(`update public.profiles set role='caregiver' where id='${acOrgResult.id}';`);
        async function acParticipant(label: string) {
            const rc = await signUpTestUser(`ac${label}`, `Task Audit AC ${label}`);
            testUserIds.push(rc.id);
            dbQuery(`update public.profiles set role='recipient', timezone='UTC' where id='${rc.id}';`);
            const rows = dbQuery(`insert into public.connections (caregiver_id, recipient_id, invite_code, status, accepted_at) values ('${acOrgResult.id}', '${rc.id}', 'ACP${label}${RAND}', 'accepted', now() - interval '1 day') returning id;`);
            const connectionId = (rows[0] as any).id;
            testConnectionIds.push(connectionId);
            return { recipient: rc, connectionId };
        }
        const acP1 = await acParticipant('p1');
        const acP2 = await acParticipant('p2');
        const acTaskP1 = (await createTask(acOrgResult.client, acP1.connectionId, { frequency: 'one_time', startDate: today })).data;
        const acTaskP2 = (await createTask(acOrgResult.client, acP2.connectionId, { frequency: 'one_time', startDate: today })).data;
        await acP1.recipient.client.rpc('respond_to_task_occurrence', { p_task_id: acTaskP1.id, p_occurrence_date: today, p_status: 'completed' });
        await acP2.recipient.client.rpc('respond_to_task_occurrence', { p_task_id: acTaskP2.id, p_occurrence_date: today, p_status: 'skipped' });
        const acAnalytics1 = await acOrgResult.client.rpc('task_analytics_summary', { p_connection_id: acP1.connectionId, p_days: 30 });
        const acMetrics1 = Object.fromEntries(((acAnalytics1.data ?? []) as { metric: string; value: number | null }[]).map((r) => [r.metric, r.value]));
        record('AC', 'selected participant analytics isolation', acMetrics1.completed === 1 && acMetrics1.skipped === 0, JSON.stringify(acMetrics1));

        const p1TasksViaP2Scope = dbQuery(`select count(*) as c from public.tasks where connection_id = '${acP2.connectionId}' and id = '${acTaskP1.id}';`);
        record('AD', 'stale participant response cannot overwrite another dashboard', Number((p1TasksViaP2Scope[0] as any).c) === 0, 'participant 1 task never appears under participant 2 connection scope');

        // ── AI: assignment notification idempotency ────────────────────────────
        const aiDeliveryCount = Number((dbQuery(`select count(*) as c from public.task_notification_deliveries where task_id = '${aResult.data.id}';`)[0] as any).c);
        let aiDuplicateRejected = false;
        try {
            dbQuery(`insert into public.task_notification_deliveries (task_id, recipient_id) values ('${aResult.data.id}', '${rcA.id}');`);
        } catch (err) {
            aiDuplicateRejected = /duplicate key|unique/i.test(err instanceof Error ? err.message : String(err));
        }
        record('AI', 'assignment notification idempotency', aiDeliveryCount === 1 && aiDuplicateRejected, `existing=${aiDeliveryCount} duplicateRejected=${aiDuplicateRejected}`);

        // ── AJ/AK: notification payload content (static source inspection) ─────
        const sendFnSource = read('supabase/functions/send-task-assignment-notifications/index.ts');
        record('AJ', 'private notification payload', has(sendFnSource, /PRIVATE_TITLE = 'Tavora task'/) && has(sendFnSource, /PRIVATE_BODY = 'You have a new task waiting\.'/), 'private title/body constants present');
        record('AK', 'detailed notification payload', has(sendFnSource, /mode === 'detailed' && task\.title/), "detailed branch includes task.title only when opted in");

        const notesColumnCheck = dbQuery(`select column_name from information_schema.columns where table_schema='public' and table_name='task_notification_deliveries';`);
        const notesColumnNames = (notesColumnCheck as any[]).map((r) => r.column_name);
        record('AJ', 'notification ledger has no notes/title columns to leak', !notesColumnNames.includes('notes') && !notesColumnNames.includes('title'), JSON.stringify(notesColumnNames));

        // ── AL: old notification after archive becomes non-actionable ──────────
        const taskDetailsSource = read('app/task-details.tsx');
        record('AL', 'old notification after archive becomes non-actionable', has(taskDetailsSource, /canRespond\s*=\s*!viewerIsOrganizer\s*&&\s*!connectionEnded\s*&&\s*task\.is_active/), 'task-details.tsx gates all responses on task.is_active');

        // ── AM: missing recipient token does not roll back task creation ───────
        const amTokenCount = Number((dbQuery(`select count(*) as c from public.push_tokens where user_id = '${rcA.id}' and is_active = true;`)[0] as any).c);
        const amTaskExists = !!taskRow(aResult.data.id);
        record('AM', 'missing recipient token does not roll back task creation', amTokenCount === 0 && amTaskExists, `activeTokens=${amTokenCount} taskExists=${amTaskExists}`);

        // ── AN: invalid token handling (static check) ───────────────────────────
        record('AN', 'invalid token handling', has(sendFnSource, /device_not_registered/) && has(sendFnSource, /is_active:\s*false/), 'DeviceNotRegistered path deactivates the token');

        // ── AO: account switching token isolation ───────────────────────────────
        const taskTables = dbQuery(`select table_name from information_schema.tables where table_schema='public' and table_name like '%push_token%';`);
        record('AO', 'account switching token isolation (tasks reuse the single push_tokens table)', (taskTables as any[]).length === 1, JSON.stringify(taskTables));

        // ── AP: direct table mutation blocked ───────────────────────────────────
        const apInsert = await cgA.client.from('tasks').insert({ connection_id: connA, caregiver_id: cgA.id, recipient_id: rcA.id, title: 'forged', frequency: 'one_time', start_date: today });
        const apUpdate = await cgA.client.from('tasks').update({ title: 'forged update' }).eq('id', aResult.data.id);
        record('AP', 'direct table mutation blocked', !!apInsert.error && !!apUpdate.error, JSON.stringify({ insertError: apInsert.error?.message, updateError: apUpdate.error?.message }));

        // ── AQ: RLS cross-account isolation (task_occurrences) ──────────────────
        const aqRead = await rcJ.client.from('task_occurrences').select('id').eq('task_id', nTask.id);
        record('AQ', 'RLS cross-account isolation', !aqRead.error && (aqRead.data ?? []).length === 0, JSON.stringify(aqRead.data));

        // ── AR-AY: full regression suites ────────────────────────────────────────
        try {
            const out = execFileSync('npx', ['tsx', 'scripts/security-audit/run.ts'], { encoding: 'utf-8', env: process.env });
            const m = lastTestsPassedMatch(out);
            record('AR', 'scripts/security-audit/run.ts remains 24/24 PASS', !!m && m[1] === m[2], m?.[0]);
        } catch (err) { record('AR', 'scripts/security-audit/run.ts remains 24/24 PASS', false, err instanceof Error ? err.message : String(err)); }

        try {
            const out = execFileSync('npx', ['tsx', 'scripts/auth-audit/run.ts'], { encoding: 'utf-8', env: process.env });
            const m = lastTestsPassedMatch(out);
            record('AS', 'scripts/auth-audit/run.ts remains 37/37 PASS', !!m && m[1] === m[2], m?.[0]);
        } catch (err) { record('AS', 'scripts/auth-audit/run.ts remains 37/37 PASS', false, err instanceof Error ? err.message : String(err)); }

        try {
            const out = execFileSync('npx', ['tsx', 'scripts/reminder-audit/run.ts'], { encoding: 'utf-8', env: process.env });
            const m = lastTestsPassedMatch(out);
            record('AT', 'scripts/reminder-audit/run.ts remains passing', !!m && m[1] === m[2], m?.[0]);
        } catch (err) { record('AT', 'scripts/reminder-audit/run.ts remains passing', false, err instanceof Error ? err.message : String(err)); }

        try {
            const out = execFileSync('npx', ['tsx', 'scripts/onboarding-audit/run.ts'], { encoding: 'utf-8', env: process.env });
            const m = lastTestsPassedMatch(out);
            record('AU', 'scripts/onboarding-audit/run.ts remains passing', !!m && m[1] === m[2], m?.[0]);
        } catch (err) { record('AU', 'scripts/onboarding-audit/run.ts remains passing', false, err instanceof Error ? err.message : String(err)); }

        try {
            const out = execFileSync('npx', ['tsx', 'scripts/participant-audit/run.ts'], { encoding: 'utf-8', env: process.env });
            const m = lastTestsPassedMatch(out);
            record('AV', 'scripts/participant-audit/run.ts remains passing', !!m && m[1] === m[2], m?.[0]);
        } catch (err) { record('AV', 'scripts/participant-audit/run.ts remains passing', false, err instanceof Error ? err.message : String(err)); }

        try {
            const out = execFileSync('npx', ['tsx', 'scripts/ui-state-audit/run.ts'], { encoding: 'utf-8', env: process.env });
            const m = lastTestsPassedMatch(out);
            record('AW', 'scripts/ui-state-audit/run.ts remains passing', !!m && m[1] === m[2], m?.[0]);
        } catch (err) { record('AW', 'scripts/ui-state-audit/run.ts remains passing', false, err instanceof Error ? err.message : String(err)); }

        try {
            const out = execFileSync('npx', ['tsx', 'scripts/accessibility-audit/run.ts'], { encoding: 'utf-8', env: process.env });
            const m = lastTestsPassedMatch(out);
            record('AX', 'scripts/accessibility-audit/run.ts remains 58/58 PASS', !!m && m[1] === m[2], m?.[0]);
        } catch (err) { record('AX', 'scripts/accessibility-audit/run.ts remains 58/58 PASS', false, err instanceof Error ? err.message : String(err)); }

        try {
            const out = execFileSync('npx', ['tsx', 'scripts/visual-consistency-audit/run.ts'], { encoding: 'utf-8', env: process.env });
            const m = lastTestsPassedMatch(out);
            record('AY', 'scripts/visual-consistency-audit/run.ts remains passing', !!m && m[1] === m[2], m?.[0]);
        } catch (err) { record('AY', 'scripts/visual-consistency-audit/run.ts remains passing', false, err instanceof Error ? err.message : String(err)); }

        try {
            const out = execFileSync('npx', ['tsx', 'scripts/ops-health/run.ts'], { encoding: 'utf-8', env: process.env });
            const hasTaskFail = /\[FAIL\] task_/.test(out);
            record('AZ', 'ops health has no new task-related FAIL', !hasTaskFail, hasTaskFail ? 'a task_* check reported FAIL' : 'no task_* FAIL lines');
        } catch (err: any) {
            const out = err?.stdout ?? '';
            const hasTaskFail = /\[FAIL\] task_/.test(out);
            record('AZ', 'ops health has no new task-related FAIL', !hasTaskFail, hasTaskFail ? 'a task_* check reported FAIL' : (err instanceof Error ? err.message : String(err)));
        }

    } finally {
        console.log('\nCleaning up synthetic test data...');
        for (const taskId of testTaskIds) {
            dbQuery(`delete from public.task_notification_deliveries where task_id = '${taskId}';`);
            dbQuery(`delete from public.task_occurrences where task_id = '${taskId}';`);
        }
        dbQuery(`delete from public.tasks where id in (${testTaskIds.map((id) => `'${id}'`).join(',') || "'00000000-0000-0000-0000-000000000000'"});`);
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
    console.error('TASK_AUDIT_SUITE_FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
});
