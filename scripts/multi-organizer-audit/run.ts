// Tavora multi-organizer participant audit (Week 4 launch-hardening task
// #2). Proves the product-level authoritative rule end to end: every
// connection is independent; each reminder/task/routine belongs to exactly
// one connection; each organizer manages only their own connection's
// objects; a participant's view across every accepted organizer carries
// correct, never-merged, never-hidden, never-stale attribution; ending or
// deleting one connection/account never damages another; private templates
// never leak; analytics/notifications are connection-specific.
//
// Mirrors scripts/task-audit/run.ts / scripts/routine-audit/run.ts's
// methodology: disposable synthetic users (tavora.multiorgaudit.*@example.com)
// for scenarios that mutate the connection graph itself (invitations,
// connection-ending, account deletion), and the shared persistent fixture
// pool (organizerA, organizerB, participantMultiOrg — already connected to
// BOTH organizers by resetFixturePool()'s own baseline, see
// scripts/audit-infrastructure/fixtures.ts) for scenarios that only create/
// read/delete reminders/tasks/routines without touching the connection
// graph. Every scenario id A-BT is recorded exactly once — BK-BS are
// recorded as SKIP (never silently omitted) because they point at whole
// existing suites that would otherwise require this script to recursively
// invoke another suite's run.ts, which only scripts/final-regression/run.ts
// is allowed to do (see docs/audit-infrastructure-model.md's DAG-flattening
// rule). BT calls public.ops_health_evaluate() directly (a single SQL call,
// not a nested process) matching the Week 4 Task #1 meta-suite's own
// precedent.

import { readFileSync } from 'node:fs';
import {
    dbQuery,
    newClient,
    randomSuffix,
    record,
    skip,
    summarize,
} from '../security-audit/helpers';
import { installCrashSafety } from '../audit-infrastructure/cleanup';
import {
    provisionFixturePool,
    resetFixturePool,
    detectFixtureContamination,
    verifyFixtureBaseline,
    getFixtureClient,
    getFixturePassword,
} from '../audit-infrastructure/fixtures';
import { resolveOrganizerDisplay, OrganizerProfileForDisplay } from '../../lib/organizerDisplay';
import { BUILT_IN_ROUTINE_PACKS } from '../../lib/routineCatalog';

const RAND = randomSuffix();
const PASSWORD = `MultiOrgAudit!${RAND}9X`;
const EMAIL_PREFIX = 'tavora.multiorgaudit';

function read(path: string): string {
    return readFileSync(path, 'utf-8');
}
function has(content: string, pattern: RegExp): boolean {
    return pattern.test(content);
}

// A minimal, deterministic stand-in for the app's real t() -- resolves
// exactly the two fallback keys resolveOrganizerDisplay actually calls,
// nothing else. Never a substitute for the real i18n system: this script
// tests resolveOrganizerDisplay's LOGIC (which fallbackKind for which
// input), not string localization (already covered by routine-audit C/D).
function fakeT(key: string): string {
    if (key === 'common.organizer') return 'Organizer';
    if (key === 'activityFeed.formerOrganizer') return 'A former organizer';
    return key;
}

function todayDateString(): string {
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

function reminderItem(overrides: Partial<any> = {}) {
    return {
        item_kind: 'reminder', title: 'Multi-org check-in', notes: null,
        reminder_type: 'other', time_of_day: '00:01', frequency: 'daily',
        days_of_week: [1, 2, 3, 4, 5, 6, 7], no_response_minutes: 15,
        ...overrides,
    };
}
function taskItem(overrides: Partial<any> = {}) {
    return {
        item_kind: 'task', title: 'Multi-org get ready', notes: null,
        frequency: 'one_time', days_of_week: [], start_offset_days: 0, due_offset_days: 0,
        ...overrides,
    };
}
function applyReminderItem(key: string, overrides: Partial<any> = {}) {
    return {
        item_kind: 'reminder', source_item_key: key, title: 'Multi-org check-in', notes: null,
        reminder_type: 'other', time_of_day: '00:01', frequency: 'daily',
        days_of_week: [1, 2, 3, 4, 5, 6, 7], no_response_minutes: 15,
        ...overrides,
    };
}
function applyTaskItem(key: string, startDate: string, overrides: Partial<any> = {}) {
    return {
        item_kind: 'task', source_item_key: key, title: 'Multi-org get ready', notes: null,
        frequency: 'one_time', days_of_week: [], start_date: startDate, due_date: startDate, recurrence_end_date: null,
        ...overrides,
    };
}

async function main() {
    console.log(`Multi-organizer audit run ${RAND}\n`);

    async function makeConnectedPair(label: string, recipientTz = 'America/Phoenix') {
        const caregiver = await signUpTestUser(`${label}cg`, `MultiOrg ${label} Caregiver`, 'caregiver');
        const recipient = await signUpTestUser(`${label}rc`, `MultiOrg ${label} Recipient`, 'recipient', recipientTz);
        const { data: inviteRow, error: inviteError } = await caregiver.client.rpc('create_invite_code', { p_existing_connection_id: null }).maybeSingle() as { data: { id: string; invite_code: string } | null; error: any };
        if (inviteError || !inviteRow) throw new Error(`invite failed: ${inviteError?.message}`);
        const { error: acceptError } = await recipient.client.rpc('accept_invite_code', { p_code: inviteRow.invite_code });
        if (acceptError) throw new Error(`accept failed: ${acceptError.message}`);
        return { caregiver, recipient, connectionId: inviteRow.id as string };
    }

    /** Two independent organizers, each with their own accepted connection to ONE shared participant. */
    async function makeSharedTrio(label: string, recipientTz = 'America/Phoenix') {
        const org1 = await signUpTestUser(`${label}o1`, `MultiOrg ${label} Organizer1`, 'caregiver');
        const org2 = await signUpTestUser(`${label}o2`, `MultiOrg ${label} Organizer2`, 'caregiver');
        const shared = await signUpTestUser(`${label}sh`, `MultiOrg ${label} Shared`, 'recipient', recipientTz);
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

    async function createReminder(connectionId: string, caregiverId: string, recipientId: string, title: string): Promise<string> {
        const rows = dbQuery(`
          insert into public.reminders (connection_id, caregiver_id, recipient_id, title, time_of_day, days_of_week, no_response_minutes, is_active, created_at, updated_at)
          values ('${connectionId}', '${caregiverId}', '${recipientId}', '${title}', '09:00:00', ARRAY[1,2,3,4,5,6,7], 15, true, now() - interval '1 day', now())
          returning id;
        `);
        return (rows[0] as any).id;
    }

    async function createTask(client: ReturnType<typeof newClient>, connectionId: string, title: string) {
        return client.rpc('create_task', {
            p_connection_id: connectionId,
            p_title: title,
            p_notes: null,
            p_frequency: 'one_time',
            p_days_of_week: [],
            p_start_date: todayDateString(),
            p_due_date: null,
            p_recurrence_end_date: null,
        });
    }

    async function createAndApplyRoutine(client: ReturnType<typeof newClient>, connectionId: string, label: string) {
        const { data: template, error: templateError } = await client.rpc('create_routine_template', {
            p_title: `${label} Template`, p_description: null, p_use_case: null,
            p_items: [reminderItem({ title: `${label} Reminder` }), taskItem({ title: `${label} Task` })],
        });
        if (templateError || !template) throw new Error(`template creation failed for ${label}: ${templateError?.message}`);
        const { data: applied, error: applyError } = await client.rpc('apply_routine_template', {
            p_connection_id: connectionId, p_source_template_id: template.templateId, p_source_template_revision: template.revision,
            p_built_in_pack_id: null, p_built_in_pack_version: null, p_title: `${label} Routine`, p_start_date: todayDateString(),
            p_items: [applyReminderItem('r1', { title: `${label} Reminder` }), applyTaskItem('t1', todayDateString(), { title: `${label} Task` })],
            p_apply_request_id: `apply-${label.toLowerCase().replace(/\s+/g, '')}-${RAND}`,
        });
        if (applyError || !applied) throw new Error(`apply failed for ${label}: ${applyError?.message}`);
        return { template, instance: applied };
    }

    let crashError: unknown = null;
    let cleaned = false;
    async function cleanup() {
        if (cleaned) return;
        cleaned = true;
        console.log('\nCleaning up synthetic test data...');
        // Persistent-fixture product data (reminders/tasks/routines created
        // against organizerA/organizerB/participantMultiOrg during E-AK)
        // is restored by resetFixturePool() below, called from inside the
        // try block once E-AK completes -- never here, since this cleanup
        // must never touch the fixture identities themselves.
        const like = `'${EMAIL_PREFIX}.%${RAND}%'`;
        dbQuery(`delete from public.routine_notification_deliveries where recipient_id in (select id from auth.users where email like ${like}) or routine_instance_id in (select id from public.routine_instances where organizer_id in (select id from auth.users where email like ${like}) or participant_id in (select id from auth.users where email like ${like}));`);
        dbQuery(`delete from public.routine_instance_items where routine_instance_id in (select id from public.routine_instances where organizer_id in (select id from auth.users where email like ${like}) or participant_id in (select id from auth.users where email like ${like}));`);
        dbQuery(`delete from public.routine_instances where organizer_id in (select id from auth.users where email like ${like}) or participant_id in (select id from auth.users where email like ${like});`);
        dbQuery(`delete from public.routine_template_items where template_id in (select id from public.routine_templates where owner_id in (select id from auth.users where email like ${like}));`);
        dbQuery(`delete from public.routine_templates where owner_id in (select id from auth.users where email like ${like});`);
        dbQuery(`delete from public.task_notification_deliveries where recipient_id in (select id from auth.users where email like ${like}) or task_id in (select id from public.tasks where caregiver_id in (select id from auth.users where email like ${like}) or recipient_id in (select id from auth.users where email like ${like}));`);
        dbQuery(`delete from public.reminder_notification_deliveries where recipient_id in (select id from auth.users where email like ${like}) or reminder_id in (select id from public.reminders where caregiver_id in (select id from auth.users where email like ${like}) or recipient_id in (select id from auth.users where email like ${like}));`);
        dbQuery(`delete from public.reminder_logs where recipient_id in (select id from auth.users where email like ${like}) or caregiver_id in (select id from auth.users where email like ${like});`);
        dbQuery(`delete from public.task_occurrences where task_id in (select id from public.tasks where caregiver_id in (select id from auth.users where email like ${like}) or recipient_id in (select id from auth.users where email like ${like}));`);
        dbQuery(`delete from public.tasks where caregiver_id in (select id from auth.users where email like ${like}) or recipient_id in (select id from auth.users where email like ${like});`);
        dbQuery(`delete from public.reminders where caregiver_id in (select id from auth.users where email like ${like}) or recipient_id in (select id from auth.users where email like ${like});`);
        dbQuery(`delete from public.push_tokens where user_id in (select id from auth.users where email like ${like});`);
        dbQuery(`delete from public.connections where caregiver_id in (select id from auth.users where email like ${like}) or recipient_id in (select id from auth.users where email like ${like});`);
        dbQuery(`delete from public.profiles where id in (select id from auth.users where email like ${like});`);
        dbQuery(`delete from auth.users where email like ${like};`);
        const remaining = dbQuery(`select count(*) as c from auth.users where email like ${like};`) as { c: number }[];
        record('cleanup', 'all synthetic auth users removed', Number(remaining[0]?.c) === 0, `remaining: ${remaining[0]?.c}`);
    }
    installCrashSafety(cleanup);

    try {
        // ══════════════════════════════════════════════════════════════════
        // A-D: Invitation / duplicate-connection rules (disposable accounts)
        // ══════════════════════════════════════════════════════════════════
        const org1AD = await signUpTestUser('adorg1', 'MultiOrg AD Organizer1', 'caregiver');
        const org2AD = await signUpTestUser('adorg2', 'MultiOrg AD Organizer2', 'caregiver');
        const rcAD = await signUpTestUser('adrc', 'MultiOrg AD Recipient', 'recipient');

        const { data: inviteAD1 } = await org1AD.client.rpc('create_invite_code', { p_existing_connection_id: null }).maybeSingle() as { data: { id: string; invite_code: string } | null };
        const acceptAD1 = await rcAD.client.rpc('accept_invite_code', { p_code: inviteAD1!.invite_code });
        record('A', 'participant accepts first organizer\'s invite', acceptAD1.data === 'accepted' && !acceptAD1.error, JSON.stringify(acceptAD1));

        const { data: inviteAD2 } = await org2AD.client.rpc('create_invite_code', { p_existing_connection_id: null }).maybeSingle() as { data: { id: string; invite_code: string } | null };
        const acceptAD2 = await rcAD.client.rpc('accept_invite_code', { p_code: inviteAD2!.invite_code });
        record('B', 'same participant accepts a second, independent organizer\'s invite (no participant-side cap)', acceptAD2.data === 'accepted' && !acceptAD2.error && inviteAD2!.id !== inviteAD1!.id, JSON.stringify(acceptAD2));

        // A second, fresh invite between the SAME org1<->rcAD pair must be
        // rejected as already_accepted, and must not create a second
        // accepted row for that identical pair (connections_unique_accepted_pair).
        const { data: inviteAD1b } = await org1AD.client.rpc('create_invite_code', { p_existing_connection_id: null }).maybeSingle() as { data: { id: string; invite_code: string } | null };
        const acceptAD1b = await rcAD.client.rpc('accept_invite_code', { p_code: inviteAD1b!.invite_code });
        const acceptedPairCount = dbQuery(`select count(*) as c from public.connections where caregiver_id = '${org1AD.id}' and recipient_id = '${rcAD.id}' and status = 'accepted';`) as { c: number }[];
        record('C', 'duplicate identical accepted pair rejected, no second row created', acceptAD1b.data === 'already_accepted' && Number(acceptedPairCount[0]?.c) === 1, JSON.stringify({ result: acceptAD1b.data, count: acceptedPairCount[0]?.c }));

        const summaryAD = await rcAD.client.rpc('get_my_organizer_connections_summary');
        const summaryADRows = (summaryAD.data ?? []) as any[];
        const summaryADOrgIds = new Set(summaryADRows.filter((r) => r.status === 'accepted').map((r) => r.organizer_id));
        record('D', 'get_my_organizer_connections_summary returns both independent organizers with zero counts', !summaryAD.error && summaryADOrgIds.has(org1AD.id) && summaryADOrgIds.has(org2AD.id) && summaryADRows.every((r) => r.active_reminder_count === 0 && r.active_task_count === 0 && r.active_routine_count === 0), JSON.stringify(summaryADRows));

        // ══════════════════════════════════════════════════════════════════
        // E-AK: Cross-organizer isolation, attribution, aggregation
        // (persistent fixture pool -- organizerA, organizerB,
        // participantMultiOrg already share two independent accepted
        // connections per resetFixturePool()'s own baseline)
        // ══════════════════════════════════════════════════════════════════
        const pool = await provisionFixturePool();
        resetFixturePool();
        detectFixtureContamination();

        const oA = getFixtureClient('organizerA');
        await oA.auth.signInWithPassword({ email: pool.organizerA.email, password: getFixturePassword() });
        const oB = getFixtureClient('organizerB');
        await oB.auth.signInWithPassword({ email: pool.organizerB.email, password: getFixturePassword() });
        const pM = getFixtureClient('participantMultiOrg');
        await pM.auth.signInWithPassword({ email: pool.participantMultiOrg.email, password: getFixturePassword() });

        const connRowAM = dbQuery(`select id from public.connections where caregiver_id = '${pool.organizerA.id}' and recipient_id = '${pool.participantMultiOrg.id}' and status = 'accepted';`)[0] as { id: string };
        const connRowBM = dbQuery(`select id from public.connections where caregiver_id = '${pool.organizerB.id}' and recipient_id = '${pool.participantMultiOrg.id}' and status = 'accepted';`)[0] as { id: string };
        const connAM = connRowAM.id;
        const connBM = connRowBM.id;

        // E/F: each organizer independently creates a reminder for the SAME shared participant.
        const remAM = await createReminder(connAM, pool.organizerA.id, pool.participantMultiOrg.id, 'MOA Reminder E');
        record('E', 'organizerA creates a reminder for the shared participant', !!remAM, remAM);
        const remBM = await createReminder(connBM, pool.organizerB.id, pool.participantMultiOrg.id, 'MOA Reminder F');
        record('F', 'organizerB independently creates a reminder for the SAME shared participant', !!remBM, remBM);

        // G: participant's own reminder list spans both organizers with correct, distinct attribution.
        const pMReminders = dbQuery(`select id, caregiver_id, connection_id from public.reminders where recipient_id = '${pool.participantMultiOrg.id}' and id in ('${remAM}','${remBM}');`) as { id: string; caregiver_id: string; connection_id: string }[];
        const gRowA = pMReminders.find((r) => r.id === remAM);
        const gRowB = pMReminders.find((r) => r.id === remBM);
        record('G', 'participant\'s reminder list correctly attributes each reminder to its own organizer/connection', gRowA?.caregiver_id === pool.organizerA.id && gRowA?.connection_id === connAM && gRowB?.caregiver_id === pool.organizerB.id && gRowB?.connection_id === connBM, JSON.stringify({ gRowA, gRowB }));

        // H/I: cross-organizer read/write isolation on reminders.
        const { data: hRead } = await oB.from('reminders').select('id').eq('id', remAM).maybeSingle();
        record('H', 'organizerB cannot read organizerA\'s reminder for the shared participant', hRead === null, JSON.stringify(hRead));
        const { error: iUpdate } = await oB.from('reminders').update({ title: 'hijacked' }).eq('id', remAM);
        const remAMAfter = dbQuery(`select title from public.reminders where id = '${remAM}';`)[0] as { title: string };
        record('I', 'organizerB cannot mutate organizerA\'s reminder for the shared participant', remAMAfter?.title === 'MOA Reminder E', JSON.stringify({ updateAttempted: true, titleAfter: remAMAfter?.title }));

        // J: reminder organizer attribution resolves to the real name for a named, active organizer.
        const orgAProfile = dbQuery(`select full_name, account_status, deleted_at from public.profiles where id = '${pool.organizerA.id}';`)[0] as OrganizerProfileForDisplay;
        const jDisplay = resolveOrganizerDisplay(pool.organizerA.id, orgAProfile, fakeT);
        record('J', 'reminder attribution resolves to the real organizer name', jDisplay.fallbackKind === 'named' && jDisplay.displayName === orgAProfile?.full_name, JSON.stringify(jDisplay));

        // K/L: same isolation proof for tasks.
        const taskAMResult = await createTask(oA, connAM, 'MOA Task K');
        const taskBMResult = await createTask(oB, connBM, 'MOA Task K2');
        record('K', 'each organizer independently creates a task for the shared participant', !taskAMResult.error && !!taskAMResult.data?.id && !taskBMResult.error && !!taskBMResult.data?.id, JSON.stringify({ a: taskAMResult.error?.message, b: taskBMResult.error?.message }));
        const pMTasks = dbQuery(`select id, caregiver_id, connection_id from public.tasks where recipient_id = '${pool.participantMultiOrg.id}' and id in ('${taskAMResult.data?.id}','${taskBMResult.data?.id}');`) as { id: string; caregiver_id: string; connection_id: string }[];
        const lRowA = pMTasks.find((r) => r.id === taskAMResult.data?.id);
        const lRowB = pMTasks.find((r) => r.id === taskBMResult.data?.id);
        record('L', 'participant\'s task list correctly attributes each task to its own organizer/connection', lRowA?.caregiver_id === pool.organizerA.id && lRowB?.caregiver_id === pool.organizerB.id && lRowA?.connection_id !== lRowB?.connection_id, JSON.stringify({ lRowA, lRowB }));

        const { data: mRead } = await oB.from('tasks').select('id').eq('id', taskAMResult.data?.id).maybeSingle();
        record('M', 'organizerB cannot read organizerA\'s task for the shared participant', mRead === null, JSON.stringify(mRead));

        // N/O: same isolation proof for routines, using PERSONAL (private) templates.
        const routineA = await createAndApplyRoutine(oA, connAM, 'MOA Routine N');
        const routineB = await createAndApplyRoutine(oB, connBM, 'MOA Routine N2');
        record('N', 'each organizer independently applies their own private-template routine to the shared participant', !!routineA.instance.routineInstanceId && !!routineB.instance.routineInstanceId, JSON.stringify({ a: routineA.instance.routineInstanceId, b: routineB.instance.routineInstanceId }));

        const { data: oRead } = await oB.from('routine_instances').select('id').eq('id', routineA.instance.routineInstanceId).maybeSingle();
        record('O', 'organizerB cannot read organizerA\'s routine_instance for the shared participant', oRead === null, JSON.stringify(oRead));

        // P: Today-hub-style aggregation -- participant's own direct reads span both organizers.
        const pActiveReminders = dbQuery(`select distinct caregiver_id from public.reminders where recipient_id = '${pool.participantMultiOrg.id}' and is_active = true;`) as { caregiver_id: string }[];
        const pActiveOrgIds = new Set(pActiveReminders.map((r) => r.caregiver_id));
        record('P', 'participant\'s own aggregated reminder read spans both organizers (Today-hub aggregation)', pActiveOrgIds.has(pool.organizerA.id) && pActiveOrgIds.has(pool.organizerB.id), JSON.stringify([...pActiveOrgIds]));

        // Q: Activity aggregation -- respond to each organizer's task, then confirm the participant's own feed attributes each correctly.
        await pM.rpc('respond_to_task_occurrence', { p_task_id: taskAMResult.data?.id, p_occurrence_date: todayDateString(), p_status: 'completed' });
        await pM.rpc('respond_to_task_occurrence', { p_task_id: taskBMResult.data?.id, p_occurrence_date: todayDateString(), p_status: 'completed' });
        const feedQ = await pM.rpc('get_participant_activity_feed', { p_before_timestamp: null, p_before_source: null, p_before_id: null, p_limit: 20, p_source_filter: 'task' });
        const feedQRows = (feedQ.data ?? []) as any[];
        const feedQA = feedQRows.find((r) => r.source_id === taskAMResult.data?.id);
        const feedQB = feedQRows.find((r) => r.source_id === taskBMResult.data?.id);
        record('Q', 'participant\'s own activity feed attributes each event to the correct organizer, never merged', !feedQ.error && feedQA?.organizer_name === orgAProfile?.full_name && feedQB?.organizer_name !== feedQA?.organizer_name, JSON.stringify({ feedQA, feedQB }));

        // R: connection-scoped Activity -- participant viewing ONE organizer's connection never sees the other's events.
        const feedR = await pM.rpc('get_connection_activity_feed', { p_connection_id: connAM, p_before_timestamp: null, p_before_source: null, p_before_id: null, p_limit: 20, p_source_filter: 'task' });
        const feedRRows = (feedR.data ?? []) as any[];
        record('R', 'connection-scoped Activity (View activity for one organizer) never includes the other organizer\'s events', !feedR.error && feedRRows.some((r) => r.source_id === taskAMResult.data?.id) && !feedRRows.some((r) => r.source_id === taskBMResult.data?.id), JSON.stringify(feedRRows.map((r) => r.source_id)));

        // S: organizer-side task analytics isolation for a shared participant.
        const analyticsS = await oA.rpc('task_analytics_summary', { p_connection_id: connAM, p_days: 30 });
        const analyticsSMetrics = Object.fromEntries(((analyticsS.data ?? []) as { metric: string; value: number | null }[]).map((r) => [r.metric, r.value]));
        record('S', 'organizerA\'s task analytics for the shared participant reflect only organizerA\'s own connection', !analyticsS.error && analyticsSMetrics.completed === 1, JSON.stringify(analyticsSMetrics));

        // T: organizer's own connection-scoped read never includes the other organizer's rows despite the same recipient.
        const oaOwnTasks = await oA.from('tasks').select('id').eq('connection_id', connAM);
        record('T', 'organizerA\'s connection-scoped task read never includes organizerB\'s task for the same participant', !oaOwnTasks.error && (oaOwnTasks.data ?? []).every((r) => r.id !== taskBMResult.data?.id), JSON.stringify(oaOwnTasks.data?.map((r) => r.id)));

        // U: notification-delivery rows always resolve back to exactly the intended connection, never the other organizer's.
        const uDeliveryJoin = dbQuery(`
          select tnd.task_id, t.connection_id from public.task_notification_deliveries tnd
          join public.tasks t on t.id = tnd.task_id
          where tnd.task_id in ('${taskAMResult.data?.id}','${taskBMResult.data?.id}');
        `) as { task_id: string; connection_id: string }[];
        const uOk = uDeliveryJoin.every((row) => (row.task_id === taskAMResult.data?.id ? row.connection_id === connAM : row.connection_id === connBM));
        record('U', 'notification-delivery rows always resolve back to their own connection, never the other organizer\'s', uOk, JSON.stringify(uDeliveryJoin));

        // V/W: private-template exposure.
        const { data: vRead } = await oB.from('routine_templates').select('id').eq('id', routineA.template.templateId).maybeSingle();
        record('V', 'organizerB cannot read organizerA\'s private routine template', vRead === null, JSON.stringify(vRead));
        const { error: wApplyError } = await oB.rpc('apply_routine_template', {
            p_connection_id: connBM, p_source_template_id: routineA.template.templateId, p_source_template_revision: routineA.template.revision,
            p_built_in_pack_id: null, p_built_in_pack_version: null, p_title: 'Hijacked routine', p_start_date: todayDateString(),
            p_items: [applyReminderItem('r1', { title: 'MOA Routine N Reminder' })], p_apply_request_id: `apply-w-${RAND}`,
        });
        record('W', 'organizerB cannot apply organizerA\'s private template', !!wApplyError, wApplyError?.message);

        // X: the new connections-summary RPC keeps both organizers' counts fully independent.
        const summaryX = await pM.rpc('get_my_organizer_connections_summary');
        const summaryXRows = (summaryX.data ?? []) as any[];
        const xRowA = summaryXRows.find((r) => r.organizer_id === pool.organizerA.id);
        const xRowB = summaryXRows.find((r) => r.organizer_id === pool.organizerB.id);
        // Each organizer's connection has, by this point, exactly 2 active
        // reminders (E/F's standalone one + N's routine-member one) and 2
        // active tasks (K's standalone one + N's routine-member one), plus
        // the 1 routine applied in N -- and critically, organizerA's and
        // organizerB's counts are IDENTICAL to each other despite being
        // computed from two entirely independent connections, which is
        // exactly the isolation property this scenario exists to prove.
        record('X', 'get_my_organizer_connections_summary keeps each organizer\'s counts fully independent', !summaryX.error && xRowA?.active_reminder_count === 2 && xRowA?.active_task_count === 2 && xRowA?.active_routine_count === 1 && xRowB?.active_reminder_count === 2 && xRowB?.active_task_count === 2 && xRowB?.active_routine_count === 1, JSON.stringify({ xRowA, xRowB }));

        // Y: cross-organizer isolation extended to reminder_logs.
        await pM.rpc('respond_to_reminder_occurrence', { p_reminder_id: remAM, p_status: 'taken', p_snooze_minutes: 10 });
        const remAMLogId = (dbQuery(`select id from public.reminder_logs where reminder_id = '${remAM}';`)[0] as { id: string })?.id;
        const { data: yRead } = await oB.from('reminder_logs').select('id').eq('id', remAMLogId).maybeSingle();
        record('Y', 'organizerB cannot read organizerA\'s reminder_logs row for the shared participant', yRead === null, JSON.stringify(yRead));

        // Z: notification payload privacy (static check) -- no cross-organizer identifier ever embedded.
        const reminderSendSource = read('supabase/functions/send-due-recipient-reminders/index.ts');
        record('Z', 'private notification payload never embeds an organizer name or another connection\'s identifier', has(reminderSendSource, /PRIVATE_REMINDER_TITLE/) && has(reminderSendSource, /PRIVATE_REMINDER_BODY/) && !has(reminderSendSource, /organizer_name|caregiver_name/), 'private title/body constants present, no organizer-name field referenced');

        // AA/AB: the exact three-way distinction resolveOrganizerDisplay exists to make.
        const nullNamePair = await makeConnectedPair('aa');
        await nullNamePair.caregiver.client.from('profiles').update({ full_name: null }).eq('id', nullNamePair.caregiver.id);
        const aaProfile = dbQuery(`select full_name, account_status, deleted_at from public.profiles where id = '${nullNamePair.caregiver.id}';`)[0] as OrganizerProfileForDisplay;
        const aaDisplay = resolveOrganizerDisplay(nullNamePair.caregiver.id, aaProfile, fakeT);
        record('AA', 'an active organizer with no full_name resolves to "unavailable", never "deleted"', aaDisplay.fallbackKind === 'unavailable', JSON.stringify(aaDisplay));

        dbQuery(`select public.delete_current_user_data('${nullNamePair.caregiver.id}');`);
        const abProfile = dbQuery(`select full_name, account_status, deleted_at from public.profiles where id = '${nullNamePair.caregiver.id}';`)[0] as OrganizerProfileForDisplay;
        const abDisplay = resolveOrganizerDisplay(nullNamePair.caregiver.id, abProfile, fakeT);
        record('AB', 'a deleted organizer resolves to "deleted", correctly distinguished from merely unnamed', abDisplay.fallbackKind === 'deleted', JSON.stringify(abDisplay));

        // AC/AD/AE: product-code regression guards for the attribution fix.
        const recipientDashboardSource = read('app/recipient-dashboard.tsx');
        record('AC', 'app/recipient-dashboard.tsx resolves reminder organizer attribution via resolveOrganizerDisplay with account_status/deleted_at', has(recipientDashboardSource, /resolveOrganizerDisplay/) && has(recipientDashboardSource, /account_status,\s*deleted_at/), 'resolveOrganizerDisplay call + account_status/deleted_at fetch present');

        const taskDetailsSource = read('app/task-details.tsx');
        record('AD', 'app/task-details.tsx resolves organizer attribution via resolveOrganizerDisplay', has(taskDetailsSource, /resolveOrganizerDisplay/), 'resolveOrganizerDisplay call present');

        const activityFeedCoreSource = read('lib/activityFeedCore.ts');
        record('AE', 'lib/activityFeedCore.ts distinguishes deleted from unavailable organizers via organizer_account_status', has(activityFeedCoreSource, /organizer_account_status/) && has(activityFeedCoreSource, /organizer_deleted_at/), 'organizer_account_status/organizer_deleted_at referenced');

        // AF: SQL regression guard -- both activity RPCs return the deleted-state columns.
        const outColsConn = (dbQuery(`select parameter_name from information_schema.parameters where specific_name = (select specific_name from information_schema.routines where routine_schema='public' and routine_name='get_connection_activity_feed') and parameter_mode='OUT';`) as { parameter_name: string }[]).map((r) => r.parameter_name);
        const outColsPart = (dbQuery(`select parameter_name from information_schema.parameters where specific_name = (select specific_name from information_schema.routines where routine_schema='public' and routine_name='get_participant_activity_feed') and parameter_mode='OUT';`) as { parameter_name: string }[]).map((r) => r.parameter_name);
        record('AF', 'both activity RPCs return organizer_account_status/organizer_deleted_at', ['organizer_account_status', 'organizer_deleted_at'].every((c) => outColsConn.includes(c)) && ['organizer_account_status', 'organizer_deleted_at'].every((c) => outColsPart.includes(c)), JSON.stringify({ outColsConn, outColsPart }));

        // AG: no stale-attribution surface -- object tables never store their own copy of an organizer's name.
        const reminderCols = (dbQuery(`select column_name from information_schema.columns where table_schema='public' and table_name='reminders';`) as { column_name: string }[]).map((r) => r.column_name);
        const taskCols = (dbQuery(`select column_name from information_schema.columns where table_schema='public' and table_name='tasks';`) as { column_name: string }[]).map((r) => r.column_name);
        record('AG', 'reminders/tasks tables have no organizer-name column of their own -- attribution is always freshly resolved, never snapshotted', !reminderCols.some((c) => /name/i.test(c)) && !taskCols.some((c) => /name/i.test(c)), JSON.stringify({ reminderCols, taskCols }));

        // AH: hidden-organizer guard -- presence in the summary never depends on having nonzero counts.
        const zeroCountPair = await makeConnectedPair('ah');
        const summaryAH = await zeroCountPair.recipient.client.rpc('get_my_organizer_connections_summary');
        const summaryAHRows = (summaryAH.data ?? []) as any[];
        record('AH', 'get_my_organizer_connections_summary never hides an organizer connection for having zero active objects', !summaryAH.error && summaryAHRows.some((r) => r.organizer_id === zeroCountPair.caregiver.id && r.active_reminder_count === 0 && r.active_task_count === 0 && r.active_routine_count === 0), JSON.stringify(summaryAHRows));

        // AI: no combined-analytics entrypoint -- task_analytics_summary requires an explicit p_connection_id (no "all organizers" mode).
        const analyticsParams = (dbQuery(`select parameter_name, parameter_default from information_schema.parameters where specific_name = (select specific_name from information_schema.routines where routine_schema='public' and routine_name='task_analytics_summary') and parameter_mode='IN' order by ordinal_position;`) as { parameter_name: string; parameter_default: string | null }[]);
        const connParam = analyticsParams.find((p) => p.parameter_name === 'p_connection_id');
        record('AI', 'task_analytics_summary requires an explicit connection_id -- no combined multi-organizer analytics entrypoint exists', !!connParam && connParam.parameter_default === null, JSON.stringify(analyticsParams));

        // AJ: private-template RLS never grants visibility based on a shared participant.
        const templatePolicies = dbQuery(`select policyname, qual from pg_policies where schemaname='public' and tablename='routine_templates';`) as { policyname: string; qual: string | null }[];
        record('AJ', 'routine_templates RLS never grants visibility via a shared participant, only via owner_id', templatePolicies.length > 0 && templatePolicies.every((p) => !p.qual || !/participant_id|recipient_id/.test(p.qual)), JSON.stringify(templatePolicies));

        // AK: the new participant connections screen exists and is wired to the summary RPC + per-connection actions.
        const myConnectionsSource = read('app/my-connections.tsx');
        record('AK', 'app/my-connections.tsx calls get_my_organizer_connections_summary and exposes per-connection View-activity/End-connection actions', has(myConnectionsSource, /get_my_organizer_connections_summary/) && has(myConnectionsSource, /openActivity/) && has(myConnectionsSource, /endConnection/), 'RPC call + per-row actions present');

        // Restore the persistent fixture pool to its clean baseline before
        // moving on to the disposable-account block below.
        resetFixturePool();
        const fixtureBaselineAfterEAK = verifyFixtureBaseline();
        if (!fixtureBaselineAfterEAK.ok) {
            throw new Error(`Fixture pool not restored to baseline after E-AK: ${fixtureBaselineAfterEAK.problems.join('; ')}`);
        }

        // ══════════════════════════════════════════════════════════════════
        // AL-BJ: Connection-ending isolation, account-deletion isolation
        // (including routine isolation), invitation/cap edge cases
        // (disposable accounts -- these mutate the connection graph itself)
        // ══════════════════════════════════════════════════════════════════
        const trioAL = await makeSharedTrio('al');
        const remAL1 = await createReminder(trioAL.conn1, trioAL.org1.id, trioAL.shared.id, 'AL Reminder 1');
        const remAL2 = await createReminder(trioAL.conn2, trioAL.org2.id, trioAL.shared.id, 'AL Reminder 2');
        const taskAL1 = (await createTask(trioAL.org1.client, trioAL.conn1, 'AL Task 1')).data;
        const taskAL2 = (await createTask(trioAL.org2.client, trioAL.conn2, 'AL Task 2')).data;
        await trioAL.org1.client.rpc('end_connection', { p_connection_id: trioAL.conn1 });
        const alRem1After = dbQuery(`select is_active from public.reminders where id = '${remAL1}';`)[0] as { is_active: boolean };
        const alTask1After = dbQuery(`select is_active from public.tasks where id = '${taskAL1.id}';`)[0] as { is_active: boolean };
        record('AL', 'ending organizer1\'s connection deactivates only organizer1\'s reminder+task for the shared participant', alRem1After?.is_active === false && alTask1After?.is_active === false, JSON.stringify({ alRem1After, alTask1After }));

        const alConn2After = dbQuery(`select status from public.connections where id = '${trioAL.conn2}';`)[0] as { status: string };
        const alRem2After = dbQuery(`select is_active from public.reminders where id = '${remAL2}';`)[0] as { is_active: boolean };
        const alTask2After = dbQuery(`select is_active from public.tasks where id = '${taskAL2.id}';`)[0] as { is_active: boolean };
        record('AM', 'organizer2\'s connection/reminder/task are completely unaffected by organizer1 ending their own connection', alConn2After?.status === 'accepted' && alRem2After?.is_active === true && alTask2After?.is_active === true, JSON.stringify({ alConn2After, alRem2After, alTask2After }));

        const summaryAN = await trioAL.shared.client.rpc('get_my_organizer_connections_summary');
        const summaryANRows = (summaryAN.data ?? []) as any[];
        const anOrg1Row = summaryANRows.find((r) => r.organizer_id === trioAL.org1.id);
        const anOrg2Row = summaryANRows.find((r) => r.organizer_id === trioAL.org2.id);
        record('AN', 'participant\'s connections summary reflects organizer1 as ended while organizer2 remains fully accurate', anOrg1Row?.status !== 'accepted' && anOrg2Row?.status === 'accepted' && anOrg2Row?.active_reminder_count === 1 && anOrg2Row?.active_task_count === 1, JSON.stringify({ anOrg1Row, anOrg2Row }));

        await trioAL.shared.client.rpc('respond_to_task_occurrence', { p_task_id: taskAL2.id, p_occurrence_date: todayDateString(), p_status: 'completed' });
        const feedAO = await trioAL.shared.client.rpc('get_participant_activity_feed', { p_before_timestamp: null, p_before_source: null, p_before_id: null, p_limit: 20, p_source_filter: 'all' });
        const feedAORows = (feedAO.data ?? []) as any[];
        record('AO', 'participant\'s activity feed still includes an ended connection\'s PAST activity -- history isolation, not deletion', !feedAO.error && feedAORows.some((r) => r.source_id === taskAL2.id), JSON.stringify(feedAORows.map((r) => r.source_id)));

        // AP-AU: §J routine isolation during account deletion.
        const trioAP = await makeSharedTrio('ap');
        const routineAP1 = await createAndApplyRoutine(trioAP.org1.client, trioAP.conn1, 'AP Routine 1');
        const routineAP2 = await createAndApplyRoutine(trioAP.org2.client, trioAP.conn2, 'AP Routine 2');
        // apply_routine_template itself already inserted exactly one
        // routine_notification_deliveries row per instance, status
        // 'pending' by default (the unique constraint on
        // routine_instance_id means a second row is structurally
        // impossible) -- nothing to manufacture, AS below reads these
        // already-existing rows directly.
        const apTitleBefore = (dbQuery(`select title, source_version from public.routine_instances where id = '${routineAP1.instance.routineInstanceId}';`)[0] as { title: string; source_version: string });

        dbQuery(`select public.delete_current_user_data('${trioAP.org1.id}');`);

        const apInstance1After = dbQuery(`select status, archived_at, title, source_version from public.routine_instances where id = '${routineAP1.instance.routineInstanceId}';`)[0] as { status: string; archived_at: string | null; title: string; source_version: string };
        record('AP', 'organizer1\'s routine_instance is archived (never deleted) after organizer1\'s account deletion', apInstance1After?.status === 'archived' && !!apInstance1After?.archived_at, JSON.stringify(apInstance1After));

        const aqInstance2After = dbQuery(`select status from public.routine_instances where id = '${routineAP2.instance.routineInstanceId}';`)[0] as { status: string };
        record('AQ', 'organizer2\'s routine_instance remains active -- unaffected by organizer1\'s deletion', aqInstance2After?.status === 'active', JSON.stringify(aqInstance2After));

        const arMembers2 = dbQuery(`select r.is_active as rem_active, t.is_active as task_active from public.routine_instance_items rii left join public.reminders r on r.id = rii.reminder_id left join public.tasks t on t.id = rii.task_id where rii.routine_instance_id = '${routineAP2.instance.routineInstanceId}';`) as { rem_active: boolean | null; task_active: boolean | null }[];
        record('AR', 'organizer2\'s routine member reminders/tasks remain active after organizer1\'s deletion', arMembers2.every((m) => m.rem_active !== false && m.task_active !== false), JSON.stringify(arMembers2));

        const asDeliveries1 = dbQuery(`select count(*) as c from public.routine_notification_deliveries where routine_instance_id = '${routineAP1.instance.routineInstanceId}' and status = 'pending';`)[0] as { c: number };
        const asDeliveries2 = dbQuery(`select count(*) as c from public.routine_notification_deliveries where routine_instance_id = '${routineAP2.instance.routineInstanceId}' and status = 'pending';`)[0] as { c: number };
        record('AS', 'organizer1\'s pending routine-notification deliveries are cleaned up; organizer2\'s are untouched', Number(asDeliveries1.c) === 0 && Number(asDeliveries2.c) === 1, JSON.stringify({ asDeliveries1, asDeliveries2 }));

        record('AT', 'organizer1\'s routine_instance title/source_version snapshot is byte-identical before/after deletion', apInstance1After?.title === apTitleBefore?.title && apInstance1After?.source_version === apTitleBefore?.source_version, JSON.stringify({ before: apTitleBefore, after: apInstance1After }));

        const auTemplateCount = dbQuery(`select count(*) as c from public.routine_templates where owner_id = '${trioAP.org1.id}';`)[0] as { c: number };
        record('AU', 'organizer1\'s private routine templates are hard-deleted after account deletion', Number(auTemplateCount.c) === 0, JSON.stringify(auTemplateCount));

        const avSharedProfile = dbQuery(`select account_status from public.profiles where id = '${trioAP.shared.id}';`)[0] as { account_status: string };
        const avConn2 = dbQuery(`select status from public.connections where id = '${trioAP.conn2}';`)[0] as { status: string };
        record('AV', 'the shared participant\'s own account and organizer2\'s connection are entirely unaffected by organizer1\'s deletion', avSharedProfile?.account_status === 'active' && avConn2?.status === 'accepted', JSON.stringify({ avSharedProfile, avConn2 }));

        // AW/AX: reverse direction -- deleting the shared PARTICIPANT.
        const trioAW = await makeSharedTrio('aw');
        const routineAW1 = await createAndApplyRoutine(trioAW.org1.client, trioAW.conn1, 'AW Routine 1');
        const routineAW2 = await createAndApplyRoutine(trioAW.org2.client, trioAW.conn2, 'AW Routine 2');
        const otherParticipant = await makeConnectedPair('ax');
        const otherReminder = await createReminder(otherParticipant.connectionId, trioAW.org1.id === otherParticipant.caregiver.id ? trioAW.org1.id : otherParticipant.caregiver.id, otherParticipant.recipient.id, 'AX Control Reminder');

        dbQuery(`select public.delete_current_user_data('${trioAW.shared.id}');`);
        const awInstance1 = dbQuery(`select status from public.routine_instances where id = '${routineAW1.instance.routineInstanceId}';`)[0] as { status: string };
        const awInstance2 = dbQuery(`select status from public.routine_instances where id = '${routineAW2.instance.routineInstanceId}';`)[0] as { status: string };
        record('AW', 'deleting a shared participant\'s account archives BOTH organizers\' routine_instances correctly', awInstance1?.status === 'archived' && awInstance2?.status === 'archived', JSON.stringify({ awInstance1, awInstance2 }));

        const axControlReminder = dbQuery(`select is_active from public.reminders where id = '${otherReminder}';`)[0] as { is_active: boolean };
        record('AX', 'an unrelated participant\'s reminder is completely unaffected by the multi-organizer participant\'s deletion (blast-radius control)', axControlReminder?.is_active === true, JSON.stringify(axControlReminder));

        // AY: self-invite still rejected in a multi-organizer context.
        const { data: inviteAY } = await trioAL.org2.client.rpc('create_invite_code', { p_existing_connection_id: null }).maybeSingle() as { data: { id: string; invite_code: string } | null };
        const selfAcceptAY = await trioAL.org2.client.rpc('accept_invite_code', { p_code: inviteAY!.invite_code });
        record('AY', 'an organizer cannot accept their own invite code, even one already managing multiple connections', selfAcceptAY.data === 'self', JSON.stringify(selfAcceptAY));

        // AZ/BA: attribution-failure isolation (§G) -- simulated missing profile never affects another organizer's attribution or the underlying object's availability.
        const trioAZ = await makeSharedTrio('az');
        const remAZ1 = await createReminder(trioAZ.conn1, trioAZ.org1.id, trioAZ.shared.id, 'AZ Reminder 1');
        const orgQProfile = dbQuery(`select full_name, account_status, deleted_at from public.profiles where id = '${trioAZ.org2.id}';`)[0] as OrganizerProfileForDisplay;
        // Simulate a failed/missing profile fetch for org1 purely client-side
        // (never touches the database) -- an empty lookup map means org1's
        // id simply isn't present, exactly like a batch profile query that
        // silently dropped one row.
        const simulatedProfileMap = new Map<string, OrganizerProfileForDisplay>([[trioAZ.org2.id, orgQProfile]]);
        const azDisplayP = resolveOrganizerDisplay(trioAZ.org1.id, simulatedProfileMap.get(trioAZ.org1.id), fakeT);
        const azDisplayQ = resolveOrganizerDisplay(trioAZ.org2.id, simulatedProfileMap.get(trioAZ.org2.id), fakeT);
        record('AZ', 'one organizer\'s failed/missing profile fetch falls back to "unavailable" without affecting the other organizer\'s correct attribution', azDisplayP.fallbackKind === 'unavailable' && azDisplayQ.fallbackKind === 'named' && azDisplayQ.displayName === orgQProfile?.full_name, JSON.stringify({ azDisplayP, azDisplayQ }));

        const baReminderStillPresent = dbQuery(`select id from public.reminders where id = '${remAZ1}';`)[0] as { id: string } | undefined;
        record('BA', 'the underlying object remains fully present/authorized even when its organizer\'s display name failed to resolve -- only the label degrades, never availability', !!baReminderStillPresent, JSON.stringify(baReminderStillPresent));

        // BB: attribution-never-authorizes (§F) -- identical display names never blur RLS's ID-based isolation.
        await trioAZ.org2.client.from('profiles').update({ full_name: orgAProfile?.full_name }).eq('id', trioAZ.org2.id);
        const { data: bbRead } = await trioAZ.org2.client.from('reminders').select('id').eq('id', remAZ1).maybeSingle();
        record('BB', 'two organizers sharing the identical display name remain fully RLS-isolated -- authorization is ID-based, never name-based', bbRead === null, JSON.stringify(bbRead));

        // BC: create_invite_code's p_existing_connection_id path only ever
        // regenerates a still-PENDING invite's code (matches
        // participants.tsx's real "Replace code" action, which only ever
        // targets the pending section) -- it must never touch an
        // already-accepted connection. Proves regenerating org2's own
        // separate pending invite (for a hypothetical new participant)
        // never disturbs org2's existing accepted connection to the shared
        // participant.
        const { data: pendingBC } = await trioAL.org2.client.rpc('create_invite_code', { p_existing_connection_id: null }).maybeSingle() as { data: { id: string; invite_code: string } | null };
        const { data: replacedCode } = await trioAL.org2.client.rpc('create_invite_code', { p_existing_connection_id: pendingBC!.id }).maybeSingle() as { data: { id: string; invite_code: string } | null };
        // Exactly one row for this specific pending invite's id, and its
        // code actually changed (proving an UPDATE happened, not an
        // INSERT) -- never a blanket pending-row count, since an earlier
        // scenario (AY) already legitimately left org2 with an unrelated
        // stray pending row of its own.
        const bcRowCountForId = dbQuery(`select count(*) as c from public.connections where id = '${pendingBC!.id}';`)[0] as { c: number };
        const bcConnCount = dbQuery(`select count(*) as c from public.connections where caregiver_id = '${trioAL.org2.id}' and recipient_id = '${trioAL.shared.id}' and status = 'accepted';`)[0] as { c: number };
        record('BC', 'replacing a pending invite\'s code updates that one row in place, and never disturbs the organizer\'s other, already-accepted connection', replacedCode?.id === pendingBC!.id && replacedCode?.invite_code !== pendingBC!.invite_code && Number(bcRowCountForId.c) === 1 && Number(bcConnCount.c) === 1, JSON.stringify({ replacedCode, pendingBC, bcRowCountForId, bcConnCount }));

        // BD/BE/BF: per-organizer cap is independent of any participant's own organizer count; participant's own count remains unbounded end to end.
        const capOrg = await signUpTestUser('bdcap', 'MultiOrg BD Cap Organizer', 'caregiver');
        let capRejectedAtSix = false;
        let lastCapResult: any = null;
        for (let i = 0; i < 6; i++) {
            const rc = await signUpTestUser(`bdrc${i}`, `MultiOrg BD Recipient ${i}`, 'recipient');
            const { data: capInvite, error: capInviteError } = await capOrg.client.rpc('create_invite_code', { p_existing_connection_id: null }).maybeSingle() as { data: { id: string; invite_code: string } | null; error: any };
            if (capInviteError || !capInvite) {
                lastCapResult = { error: capInviteError };
                if (i === 5) capRejectedAtSix = true;
                continue;
            }
            lastCapResult = await rc.client.rpc('accept_invite_code', { p_code: capInvite.invite_code });
            if (i === 5 && lastCapResult.error) capRejectedAtSix = true;
        }
        record('BD', 'the per-organizer 5-participant cap is enforced correctly regardless of how many OTHER organizers those participants also have', capRejectedAtSix, JSON.stringify(lastCapResult));

        const thirdOrg = await signUpTestUser('bethird', 'MultiOrg BE Third Organizer', 'caregiver');
        const { data: inviteBE } = await thirdOrg.client.rpc('create_invite_code', { p_existing_connection_id: null }).maybeSingle() as { data: { id: string; invite_code: string } | null };
        const acceptBE = await trioAL.shared.client.rpc('accept_invite_code', { p_code: inviteBE!.invite_code });
        record('BE', 'a participant\'s own organizer count remains genuinely unbounded -- a third, distinct organizer\'s invite is accepted with zero rejection', acceptBE.data === 'accepted', JSON.stringify(acceptBE));

        // trioAL.org1's connection to this participant was already ended
        // back in AL -- get_my_organizer_connections_summary returns every
        // connection this participant has ever had (accepted or ended,
        // ordered accepted-first), so all 3 organizers this participant
        // has EVER connected to should still appear, fully distinct.
        const summaryBF = await trioAL.shared.client.rpc('get_my_organizer_connections_summary');
        const summaryBFRows = (summaryBF.data ?? []) as any[];
        const bfOrgIds = new Set(summaryBFRows.map((r) => r.organizer_id));
        record('BF', 'get_my_organizer_connections_summary reflects all 3 organizers this participant has ever connected to, fully distinct, no duplicates', bfOrgIds.size === 3 && bfOrgIds.has(trioAL.org1.id) && bfOrgIds.has(trioAL.org2.id) && bfOrgIds.has(thirdOrg.id), JSON.stringify([...bfOrgIds]));

        // BG: ending down to one connection leaves the remaining connection fully functional.
        await trioAL.org2.client.rpc('end_connection', { p_connection_id: trioAL.conn2 });
        const { data: bgTask } = await thirdOrg.client.rpc('create_task', { p_connection_id: inviteBE!.id, p_title: 'BG Task', p_notes: null, p_frequency: 'one_time', p_days_of_week: [], p_start_date: todayDateString(), p_due_date: null, p_recurrence_end_date: null });
        const bgResp = await trioAL.shared.client.rpc('respond_to_task_occurrence', { p_task_id: bgTask?.id, p_occurrence_date: todayDateString(), p_status: 'completed' });
        record('BG', 'the one remaining connection functions completely normally after every other connection has ended', !!bgTask?.id && !bgResp.error, JSON.stringify({ taskId: bgTask?.id, respError: bgResp.error?.message }));

        // BH: deleting an organizer whose sole connection was already ended succeeds cleanly.
        let bhCrashed = false;
        try {
            dbQuery(`select public.delete_current_user_data('${trioAL.org2.id}');`);
        } catch {
            bhCrashed = true;
        }
        record('BH', 'account deletion of an organizer whose only connection was already ended succeeds cleanly, no crash', !bhCrashed, `crashed=${bhCrashed}`);

        // BI: zero-orphan structural check, scoped to this script's own synthetic data.
        const like = `'${EMAIL_PREFIX}.%${RAND}%'`;
        const orphanReminders = dbQuery(`
          select count(*) as c from public.reminders r
          left join public.connections c on c.id = r.connection_id
          where r.caregiver_id in (select id from auth.users where email like ${like})
            and r.is_active = true and (c.status is null or c.status <> 'accepted');
        `)[0] as { c: number };
        record('BI', 'no orphaned active reminder references a non-accepted connection among this run\'s own synthetic data', Number(orphanReminders.c) === 0, JSON.stringify(orphanReminders));

        // BJ: disposable accounts are all correctly tagged for globalSyntheticSweep().
        const untaggedCount = dbQuery(`select count(*) as c from auth.users where email like ${like} and coalesce((raw_user_meta_data->>'audit_account')::boolean, false) = false;`)[0] as { c: number };
        record('BJ', 'every disposable account created in this run is tagged audit_account=true for globalSyntheticSweep()', Number(untaggedCount.c) === 0, JSON.stringify(untaggedCount));

        // ══════════════════════════════════════════════════════════════════
        // BK-BS: pointers to whole existing suites -- never invoked
        // recursively from here (only scripts/final-regression/run.ts may
        // invoke a complete suite). Each is recorded as SKIP with a stable,
        // greppable reason, verified standalone and reported separately —
        // never silently omitted, never counted as PASS.
        // ══════════════════════════════════════════════════════════════════
        skip('BK', 'participant-audit standalone regression', 'EXTERNAL_REGRESSION_REQUIRED — verified standalone via npx tsx scripts/participant-audit/run.ts, see final report');
        skip('BL', 'reminder-audit standalone regression', 'EXTERNAL_REGRESSION_REQUIRED — verified standalone via npx tsx scripts/reminder-audit/run.ts, see final report');
        skip('BM', 'reminder-audit-tz-race standalone regression', 'EXTERNAL_REGRESSION_REQUIRED — verified standalone via npx tsx scripts/reminder-audit/timezone-and-schedule-race.ts, see final report');
        skip('BN', 'task-audit standalone regression', 'EXTERNAL_REGRESSION_REQUIRED — verified standalone via npx tsx scripts/task-audit/run.ts, see final report');
        skip('BO', 'activity-audit standalone regression', 'EXTERNAL_REGRESSION_REQUIRED — verified standalone via npx tsx scripts/activity-audit/run.ts, see final report');
        skip('BP', 'routine-audit standalone regression', 'EXTERNAL_REGRESSION_REQUIRED — verified standalone via npx tsx scripts/routine-audit/run.ts, see final report');
        skip('BQ', 'ui-state-audit standalone regression', 'EXTERNAL_REGRESSION_REQUIRED — verified standalone via npx tsx scripts/ui-state-audit/run.ts, see final report');
        skip('BR', 'accessibility-audit standalone regression', 'EXTERNAL_REGRESSION_REQUIRED — verified standalone via npx tsx scripts/accessibility-audit/run.ts, see final report');
        skip('BS', 'visual-consistency-audit standalone regression', 'EXTERNAL_REGRESSION_REQUIRED — verified standalone via npx tsx scripts/visual-consistency-audit/run.ts, see final report');

        // ══════════════════════════════════════════════════════════════════
        // BT: operational health -- a single direct SQL call, not a nested process.
        // ══════════════════════════════════════════════════════════════════
        const opsRows = dbQuery(`select * from public.ops_health_evaluate();`) as { check_name: string; status: string; detail: string }[];
        const opsCritical = opsRows.filter((r) => r.status === 'FAIL');
        record('BT', 'ops_health_evaluate reports no critical (FAIL) checks', opsCritical.length === 0, JSON.stringify(opsRows.map((r) => ({ check: r.check_name, status: r.status }))));

    } catch (err) {
        crashError = err;
    } finally {
        await cleanup();
    }

    const ok = summarize();

    const ownSource = readFileSync(__filename, 'utf-8');
    const literalIds = new Set([
        ...[...ownSource.matchAll(/\brecord\('([^']+)',/g)].map((m) => m[1]),
        ...[...ownSource.matchAll(/\bskip\('([^']+)',/g)].map((m) => m[1]),
    ]);
    const expectedTotal = literalIds.size;

    if (crashError) {
        console.error(
            `\nMULTI_ORGANIZER_AUDIT_SUITE_CRASHED mid-run: ${crashError instanceof Error ? crashError.message : String(crashError)}\n` +
            `This script defines ${expectedTotal} scenarios (including "cleanup"); summarize() above reflects only however many were actually recorded before the crash. ` +
            `Do not treat the summarize() total above as a complete run -- re-run once the underlying cause has cleared.`
        );
        process.exit(1);
    }

    process.exit(ok ? 0 : 1);
}

main().catch((err) => {
    console.error('MULTI_ORGANIZER_AUDIT_SUITE_FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
});
