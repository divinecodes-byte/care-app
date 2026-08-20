// Tavora routine-template synthetic test suite (Week 3 product-expansion
// task #3: reusable templates, routine packs, transactional routine
// assignment). Mirrors scripts/task-audit/run.ts / scripts/activity-audit/
// run.ts's methodology: disposable synthetic users
// (tavora.routineaudit.*@example.com), exercised through the real anon-key
// client paths (create_routine_template / apply_routine_template / etc via
// supabase-js RPC + direct RLS-gated reads), verified/cleaned up via the
// already-authenticated `supabase` CLI.
//
// Per the task's own instruction, signup-heavy nested regression suites
// (CB-CL) are run here but rate-limit noise should be re-verified standalone
// afterward — see the final report for which suites needed a standalone
// re-run.

import { readFileSync } from 'node:fs';
import {
    dbQuery,
    newClient,
    randomSuffix,
    record,
    summarize,
} from '../security-audit/helpers';
import { installCrashSafety } from '../audit-infrastructure/cleanup';
import { provisionFixturePool, resetFixturePool, detectFixtureContamination, getFixtureClient, getFixturePassword } from '../audit-infrastructure/fixtures';
import { BUILT_IN_ROUTINE_PACKS, expandBuiltInPackItem, getBuiltInPack } from '../../lib/routineCatalog';
import { addParticipantCalendarDays } from '../../lib/participantTodayContext';
import { en } from '../../lib/i18n/locales/en';
import { es } from '../../lib/i18n/locales/es';

const RAND = randomSuffix();
const PASSWORD = `RoutineAudit!${RAND}9X`;
const EMAIL_PREFIX = 'tavora.routineaudit';

function read(path: string): string {
    return readFileSync(path, 'utf-8');
}
function has(content: string, pattern: RegExp): boolean {
    return pattern.test(content);
}

function resolveKey(obj: any, dotPath: string): unknown {
    return dotPath.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

// Participant-local (America/Phoenix — the default recipient timezone
// makeConnectedPair uses whenever no explicit tz is passed), never UTC.
// A UTC-based "today" genuinely disagrees with Phoenix's calendar date for
// roughly 7 hours out of every day (Phoenix is UTC-7 year-round, no DST) —
// a real flakiness bug this fixes: several scenarios create a task/
// reminder and immediately call respond_to_task_occurrence/respond_to_
// reminder_occurrence with this value as the occurrence date, and the
// server's own eligibility check (`v_today := (now() at time zone
// v_tz)::date`) is always Phoenix-local, never UTC. Confirmed as the
// exact root cause of a real run's AO/RO-O/BK failures
// (occurrence_not_yet_eligible) — not a product defect.
function todayDateString(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// A fake `t()` for expanding built-in pack items outside React — resolves
// the real en.ts strings via dot-path, exactly what the app's i18n context
// would resolve for an English-locale user.
function tEnglish(key: string): string {
    const value = resolveKey(en, key);
    return typeof value === 'string' ? value : key;
}

async function signUpTestUser(emailPrefix: string, fullName: string, role: 'caregiver' | 'recipient', timezone = 'America/Phoenix') {
    const client = newClient();
    const email = `${EMAIL_PREFIX}.${emailPrefix}.${RAND}@example.com`;
    const { data, error } = await client.auth.signUp({ email, password: PASSWORD, options: { data: { full_name: fullName, audit_account: true } } });
    if (error || !data.user) throw new Error(`signup failed for ${email}: ${error?.message}`);
    await client.from('profiles').update({ role, timezone }).eq('id', data.user.id);
    return { id: data.user.id, email, client };
}

async function main() {
    console.log(`Routine audit run ${RAND}\n`);

    async function makeConnectedPair(label: string, recipientTz = 'America/Phoenix') {
        const caregiver = await signUpTestUser(`${label}cg`, `Routine Audit ${label} Caregiver`, 'caregiver');
        const recipient = await signUpTestUser(`${label}rc`, `Routine Audit ${label} Recipient`, 'recipient', recipientTz);
        const { data: inviteRow, error: inviteError } = await caregiver.client.rpc('create_invite_code', { p_existing_connection_id: null }).maybeSingle() as { data: { id: string; invite_code: string } | null; error: any };
        if (inviteError || !inviteRow) throw new Error(`invite failed: ${inviteError?.message}`);
        const { error: acceptError } = await recipient.client.rpc('accept_invite_code', { p_code: inviteRow.invite_code });
        if (acceptError) throw new Error(`accept failed: ${acceptError.message}`);
        return { caregiver, recipient, connectionId: inviteRow.id as string };
    }

    function reminderItem(overrides: Partial<any> = {}) {
        return {
            item_kind: 'reminder', title: 'Morning check-in', notes: null,
            reminder_type: 'other', time_of_day: '00:01', frequency: 'daily',
            days_of_week: [1, 2, 3, 4, 5, 6, 7], no_response_minutes: 15,
            ...overrides,
        };
    }
    function taskItem(overrides: Partial<any> = {}) {
        return {
            item_kind: 'task', title: 'Get ready', notes: null,
            frequency: 'one_time', days_of_week: [], start_offset_days: 0, due_offset_days: 0,
            ...overrides,
        };
    }
    function applyReminderItem(key: string, overrides: Partial<any> = {}) {
        return {
            item_kind: 'reminder', source_item_key: key, title: 'Morning check-in', notes: null,
            reminder_type: 'other', time_of_day: '00:01', frequency: 'daily',
            days_of_week: [1, 2, 3, 4, 5, 6, 7], no_response_minutes: 15,
            ...overrides,
        };
    }
    function applyTaskItem(key: string, startDate: string, overrides: Partial<any> = {}) {
        return {
            item_kind: 'task', source_item_key: key, title: 'Get ready', notes: null,
            frequency: 'one_time', days_of_week: [], start_date: startDate, due_date: startDate, recurrence_end_date: null,
            ...overrides,
        };
    }

    // Captured, never silently swallowed -- a crash mid-run must never
    // prevent summarize() from printing an honest, complete account of
    // whatever WAS recorded before the crash (see the final report's
    // "audit result reconciliation" for the real incident that made this
    // necessary: a rate-limit crash partway through this exact suite once
    // caused the run to skip straight past summarize() entirely, leaving
    // no total line and no visible signal of how many scenarios never
    // even ran).
    let crashError: unknown = null;

    // Unlike most other suites, this cleanup is not in-memory-array-scoped
    // (it re-derives everything from EMAIL_PREFIX at cleanup time), so it's
    // already immune to the "orphaned before being pushed to an array"
    // race -- but until now it still had no SIGINT/SIGTERM/uncaughtException/
    // unhandledRejection handler, so an external interrupt still bypassed
    // this function entirely (Node does not run pending finally blocks on
    // an unhandled signal). installCrashSafety closes that gap.
    let cleaned = false;
    async function cleanup() {
        if (cleaned) return;
        cleaned = true;
        console.log('\nCleaning up synthetic test data...');
        dbQuery(`delete from public.routine_notification_deliveries where recipient_id in (select id from auth.users where email like '${EMAIL_PREFIX}.%');`);
        dbQuery(`delete from public.routine_instance_items where routine_instance_id in (select id from public.routine_instances where organizer_id in (select id from auth.users where email like '${EMAIL_PREFIX}.%'));`);
        dbQuery(`delete from public.routine_instances where organizer_id in (select id from auth.users where email like '${EMAIL_PREFIX}.%');`);
        dbQuery(`delete from public.routine_template_items where template_id in (select id from public.routine_templates where owner_id in (select id from auth.users where email like '${EMAIL_PREFIX}.%'));`);
        dbQuery(`delete from public.routine_templates where owner_id in (select id from auth.users where email like '${EMAIL_PREFIX}.%');`);
        dbQuery(`delete from public.task_notification_deliveries where recipient_id in (select id from auth.users where email like '${EMAIL_PREFIX}.%');`);
        dbQuery(`delete from public.reminder_notification_deliveries where recipient_id in (select id from auth.users where email like '${EMAIL_PREFIX}.%');`);
        dbQuery(`delete from public.reminder_logs where recipient_id in (select id from auth.users where email like '${EMAIL_PREFIX}.%') or caregiver_id in (select id from auth.users where email like '${EMAIL_PREFIX}.%');`);
        dbQuery(`delete from public.task_occurrences where task_id in (select id from public.tasks where caregiver_id in (select id from auth.users where email like '${EMAIL_PREFIX}.%') or recipient_id in (select id from auth.users where email like '${EMAIL_PREFIX}.%'));`);
        dbQuery(`delete from public.tasks where caregiver_id in (select id from auth.users where email like '${EMAIL_PREFIX}.%') or recipient_id in (select id from auth.users where email like '${EMAIL_PREFIX}.%');`);
        dbQuery(`delete from public.reminders where caregiver_id in (select id from auth.users where email like '${EMAIL_PREFIX}.%') or recipient_id in (select id from auth.users where email like '${EMAIL_PREFIX}.%');`);
        dbQuery(`delete from public.connections where caregiver_id in (select id from auth.users where email like '${EMAIL_PREFIX}.%') or recipient_id in (select id from auth.users where email like '${EMAIL_PREFIX}.%');`);
        dbQuery(`delete from public.profiles where id in (select id from auth.users where email like '${EMAIL_PREFIX}.%');`);
        dbQuery(`delete from auth.users where email like '${EMAIL_PREFIX}.%';`);
        const remaining = dbQuery(`select count(*) as c from auth.users where email like '${EMAIL_PREFIX}.%';`) as { c: number }[];
        record('cleanup', 'all synthetic auth users removed', Number(remaining[0]?.c) === 0, `remaining: ${remaining[0]?.c}`);
    }
    installCrashSafety(cleanup);

    try {
        // ── A-D: Built-in pack catalog ──────────────────────────────────────
        record('A', 'browse built-in packs', BUILT_IN_ROUTINE_PACKS.length === 8 && BUILT_IN_ROUTINE_PACKS.every((p) => p.items.length >= 2), `count=${BUILT_IN_ROUTINE_PACKS.length}`);

        const expectedPackIds = ['morning_routine', 'evening_routine', 'family_chores', 'workout_accountability', 'study_routine', 'dental_routine', 'daily_care_routine', 'workday_checkin'];
        record('B', 'built-in pack IDs and versions stable', expectedPackIds.every((id) => getBuiltInPack(id)?.version === '1'), expectedPackIds.join(','));

        const allKeysEn = BUILT_IN_ROUTINE_PACKS.flatMap((p) => [p.titleKey, p.descriptionKey, ...p.items.map((i) => i.titleKey)]);
        const missingEn = allKeysEn.filter((k) => typeof resolveKey(en, k) !== 'string' || (resolveKey(en, k) as string).length === 0);
        record('C', 'built-in English localization complete', missingEn.length === 0, `missing=${missingEn.length}`);

        const missingEs = allKeysEn.filter((k) => typeof resolveKey(es, k) !== 'string' || (resolveKey(es, k) as string).length === 0);
        record('D', 'built-in Spanish localization complete', missingEs.length === 0, `missing=${missingEs.length}`);

        // ── E-M: Personal template operations ───────────────────────────────
        const { caregiver: cgE, recipient: rcE } = await makeConnectedPair('em');

        const { data: templateE, error: templateEError } = await cgE.client.rpc('create_routine_template', {
            p_title: 'My Template E', p_description: 'desc', p_use_case: 'care',
            p_items: [reminderItem(), taskItem()],
        });
        record('E', 'organizer creates personal template', !templateEError && templateE?.itemCount === 2, templateEError?.message ?? JSON.stringify(templateE));

        const { error: participantCreateError } = await rcE.client.rpc('create_routine_template', {
            p_title: 'Should fail', p_description: null, p_use_case: null, p_items: [reminderItem()],
        });
        record('F', 'participant cannot create personal template', !!participantCreateError && /organizer_role_required/.test(participantCreateError.message), participantCreateError?.message);

        const { data: updatedE, error: updateEError } = await cgE.client.rpc('update_routine_template', {
            p_template_id: templateE.templateId, p_title: 'My Template E Updated', p_description: 'new desc', p_use_case: 'care',
            p_items: [reminderItem(), taskItem(), taskItem({ title: 'Second task' })],
        });
        record('G', 'organizer edits own template', !updateEError && updatedE?.title === 'My Template E Updated' && updatedE?.itemCount === 3 && updatedE?.revision === 2, updateEError?.message ?? JSON.stringify(updatedE));

        // H/I/CA only need "any unrelated organizer identity" -- the
        // previous makeConnectedPair('hi') created a full throwaway pair
        // but only ever used the caregiver half. Swapped to the shared
        // fixture pool's organizerB role instead (Week 4 Task #1's
        // fixture-adoption ledger; see docs/synthetic-fixture-model.md).
        const fixturePoolHI = await provisionFixturePool();
        resetFixturePool();
        detectFixtureContamination();
        const cgH = getFixtureClient('organizerB');
        await cgH.auth.signInWithPassword({ email: fixturePoolHI.organizerB.email, password: getFixturePassword() });
        const { data: readAsH } = await cgH.from('routine_templates').select('id').eq('id', templateE.templateId).maybeSingle();
        record('H', 'unrelated organizer cannot read template', readAsH === null, JSON.stringify(readAsH));

        const { error: mutateAsHError } = await cgH.rpc('update_routine_template', {
            p_template_id: templateE.templateId, p_title: 'Hijacked', p_description: null, p_use_case: null, p_items: [reminderItem()],
        });
        record('I', 'unrelated organizer cannot mutate template', !!mutateAsHError && /not_authorized/.test(mutateAsHError.message), mutateAsHError?.message);

        const { data: dupE, error: dupEError } = await cgE.client.rpc('duplicate_routine_template', { p_template_id: templateE.templateId });
        record('J', 'duplicate personal template', !dupEError && dupE?.itemCount === 3 && dupE?.templateId !== templateE.templateId, dupEError?.message ?? JSON.stringify(dupE));

        const { error: archiveEError } = await cgE.client.rpc('archive_routine_template', { p_template_id: templateE.templateId });
        const { data: archivedRow } = await cgE.client.from('routine_templates').select('status').eq('id', templateE.templateId).maybeSingle();
        record('K', 'archive personal template', !archiveEError && archivedRow?.status === 'archived', archiveEError?.message ?? JSON.stringify(archivedRow));

        const { data: connRowsE } = await cgE.client.from('connections').select('id, status').eq('caregiver_id', cgE.id).eq('status', 'accepted');
        const connectionIdE = connRowsE?.[0]?.id;
        const { error: applyArchivedError } = await cgE.client.rpc('apply_routine_template', {
            p_connection_id: connectionIdE, p_source_template_id: templateE.templateId, p_source_template_revision: null,
            p_built_in_pack_id: null, p_built_in_pack_version: null, p_title: 'Should fail', p_start_date: todayDateString(),
            p_items: [applyReminderItem('a')], p_apply_request_id: `archived-${RAND}`,
        });
        record('L', 'archived template cannot be applied', !!applyArchivedError && /template_archived/.test(applyArchivedError.message), applyArchivedError?.message);

        const pack = getBuiltInPack('morning_routine')!;
        const packItems = pack.items.map((raw) => {
            const draft = expandBuiltInPackItem(raw, tEnglish);
            return draft.itemKind === 'reminder'
                ? { item_kind: 'reminder', title: draft.title, notes: draft.notes, enabled_by_default: draft.enabledByDefault, frequency: draft.frequency, days_of_week: draft.daysOfWeek, start_offset_days: 0, due_offset_days: null, reminder_type: draft.reminderType, time_of_day: draft.timeOfDay, no_response_minutes: draft.noResponseMinutes }
                : { item_kind: 'task', title: draft.title, notes: draft.notes, enabled_by_default: draft.enabledByDefault, frequency: draft.frequency, days_of_week: draft.daysOfWeek, start_offset_days: draft.startOffsetDays, due_offset_days: draft.dueOffsetDays, reminder_type: null, time_of_day: null, no_response_minutes: null };
        });
        const { data: copiedPack, error: copyPackError } = await cgE.client.rpc('create_routine_template', {
            p_title: tEnglish(pack.titleKey), p_description: tEnglish(pack.descriptionKey), p_use_case: 'care', p_items: packItems,
        });
        record('M', 'copy built-in pack to My Templates', !copyPackError && copiedPack?.itemCount === pack.items.length, copyPackError?.message ?? JSON.stringify(copiedPack));

        // ── N-T: Template item validation ───────────────────────────────────
        const { data: reminderOnlyTemplate, error: reminderOnlyError } = await cgE.client.rpc('create_routine_template', {
            p_title: 'Reminder only', p_description: null, p_use_case: null, p_items: [reminderItem()],
        });
        record('N', 'template contains reminder only', !reminderOnlyError && reminderOnlyTemplate?.itemCount === 1, reminderOnlyError?.message);

        const { data: taskOnlyTemplate, error: taskOnlyError } = await cgE.client.rpc('create_routine_template', {
            p_title: 'Task only', p_description: null, p_use_case: null, p_items: [taskItem()],
        });
        record('O', 'template contains task only', !taskOnlyError && taskOnlyTemplate?.itemCount === 1, taskOnlyError?.message);

        const { data: mixedTemplate, error: mixedError } = await cgE.client.rpc('create_routine_template', {
            p_title: 'Mixed', p_description: null, p_use_case: null, p_items: [reminderItem(), taskItem()],
        });
        record('P', 'template contains mixed reminder and task items', !mixedError && mixedTemplate?.itemCount === 2, mixedError?.message);

        const { error: fakeTaskTimeError } = await cgE.client.rpc('create_routine_template', {
            p_title: 'Bad', p_description: null, p_use_case: null, p_items: [taskItem({ time_of_day: '09:00' })],
        });
        record('Q', 'reject fake task time', !!fakeTaskTimeError && /task_cannot_have_time_of_day/.test(fakeTaskTimeError.message), fakeTaskTimeError?.message);

        const { error: noTimeReminderError } = await cgE.client.rpc('create_routine_template', {
            p_title: 'Bad', p_description: null, p_use_case: null, p_items: [reminderItem({ time_of_day: null })],
        });
        record('R', 'reject reminder without exact time', !!noTimeReminderError && /reminder_requires_time_of_day/.test(noTimeReminderError.message), noTimeReminderError?.message);

        const { error: dueBeforeStartError } = await cgE.client.rpc('create_routine_template', {
            p_title: 'Bad', p_description: null, p_use_case: null, p_items: [taskItem({ start_offset_days: 5, due_offset_days: 2 })],
        });
        record('S', 'reject due offset before start offset', !!dueBeforeStartError && /due_offset_before_start_offset/.test(dueBeforeStartError.message), dueBeforeStartError?.message);

        const { error: badDaysError } = await cgE.client.rpc('create_routine_template', {
            p_title: 'Bad', p_description: null, p_use_case: null, p_items: [reminderItem({ days_of_week: [0, 9] })],
        });
        record('T', 'reject malformed selected weekdays', !!badDaysError && /invalid_days_of_week/.test(badDaysError.message), badDaysError?.message);

        // ── U-AJ: Transactional apply ────────────────────────────────────────
        const { caregiver: cgU, recipient: rcU, connectionId: connU } = await makeConnectedPair('u');
        const startU = todayDateString();
        const applyRequestU = `apply-u-${RAND}`;
        const { data: applyU, error: applyUError } = await cgU.client.rpc('apply_routine_template', {
            p_connection_id: connU, p_source_template_id: null, p_source_template_revision: null,
            p_built_in_pack_id: 'morning_routine', p_built_in_pack_version: '1', p_title: 'Morning Routine',
            p_start_date: startU,
            p_items: [applyReminderItem('r1'), applyTaskItem('t1', startU), applyTaskItem('t2', startU, { title: 'Prepare essentials' })],
            p_apply_request_id: applyRequestU,
        });
        record('U', 'apply routine to accepted connection', !applyUError && !!applyU?.routineInstanceId, applyUError?.message ?? JSON.stringify(applyU));
        record('Y', 'apply creates one routine instance', applyU?.alreadyExisted === false, JSON.stringify(applyU));
        record('Z', 'apply creates correct reminder count', applyU?.reminderCount === 1, `reminderCount=${applyU?.reminderCount}`);
        record('AA', 'apply creates correct task count', applyU?.taskCount === 2, `taskCount=${applyU?.taskCount}`);

        const memberLinksU = dbQuery(`select count(*) as c from public.routine_instance_items where routine_instance_id = '${applyU.routineInstanceId}'`) as { c: number }[];
        record('AB', 'apply creates all membership links', Number(memberLinksU[0]?.c) === 3, `links=${memberLinksU[0]?.c}`);

        // V: pending connection (not yet accepted)
        const cgV = await signUpTestUser('vcg', 'Routine Audit V Caregiver', 'caregiver');
        const rcV = await signUpTestUser('vrc', 'Routine Audit V Recipient', 'recipient');
        const { data: inviteRowV } = await cgV.client.rpc('create_invite_code', { p_existing_connection_id: null }).maybeSingle() as { data: { id: string; invite_code: string } | null };
        if (!inviteRowV) throw new Error('invite V failed');
        const { error: applyPendingError } = await cgV.client.rpc('apply_routine_template', {
            p_connection_id: inviteRowV.id, p_source_template_id: null, p_source_template_revision: null,
            p_built_in_pack_id: 'morning_routine', p_built_in_pack_version: '1', p_title: 'Should fail',
            p_start_date: todayDateString(), p_items: [applyReminderItem('r1')], p_apply_request_id: `apply-v-${RAND}`,
        });
        record('V', 'reject pending connection', !!applyPendingError && /connection_inactive/.test(applyPendingError.message), applyPendingError?.message);

        // W: ended connection
        const { caregiver: cgW, connectionId: connW } = await makeConnectedPair('w');
        await cgW.client.rpc('end_connection', { p_connection_id: connW });
        const { error: applyEndedError } = await cgW.client.rpc('apply_routine_template', {
            p_connection_id: connW, p_source_template_id: null, p_source_template_revision: null,
            p_built_in_pack_id: 'morning_routine', p_built_in_pack_version: '1', p_title: 'Should fail',
            p_start_date: todayDateString(), p_items: [applyReminderItem('r1')], p_apply_request_id: `apply-w-${RAND}`,
        });
        record('W', 'reject ended connection', !!applyEndedError && /connection_inactive/.test(applyEndedError.message), applyEndedError?.message);

        // X: unrelated connection (cgH tries to apply using connU, owned by cgU)
        const { error: applyUnrelatedError } = await cgH.rpc('apply_routine_template', {
            p_connection_id: connU, p_source_template_id: null, p_source_template_revision: null,
            p_built_in_pack_id: 'morning_routine', p_built_in_pack_version: '1', p_title: 'Should fail',
            p_start_date: todayDateString(), p_items: [applyReminderItem('r1')], p_apply_request_id: `apply-x-${RAND}`,
        });
        record('X', 'reject unrelated connection', !!applyUnrelatedError && /connection_inactive/.test(applyUnrelatedError.message), applyUnrelatedError?.message);

        // AC/AD/AE: rollback on invalid mixed item — the third item's bogus
        // frequency is an unambiguous, guaranteed-invalid field (unlike a
        // task's days_of_week, which one_time silently ignores/overrides
        // rather than rejecting) so this is a clean single-attempt test.
        const { caregiver: cgAC, connectionId: connAC } = await makeConnectedPair('ac');
        const rollbackTitle = `Rollback Marker ${RAND}`;
        const { error: rollbackError2 } = await cgAC.client.rpc('apply_routine_template', {
            p_connection_id: connAC, p_source_template_id: null, p_source_template_revision: null,
            p_built_in_pack_id: 'morning_routine', p_built_in_pack_version: '1', p_title: 'Rollback test 2',
            p_start_date: todayDateString(),
            p_items: [
                applyReminderItem('r1', { title: rollbackTitle }),
                applyTaskItem('t1', todayDateString(), { title: rollbackTitle }),
                { item_kind: 'reminder', source_item_key: 'bad', title: rollbackTitle, notes: null, reminder_type: 'other', time_of_day: '09:00', frequency: 'bogus_frequency', days_of_week: [1], no_response_minutes: 15 },
            ],
            p_apply_request_id: `apply-ac2-${RAND}`,
        });
        const rollbackInstanceCount = dbQuery(`select count(*) as c from public.routine_instances where organizer_id = '${cgAC.id}'`) as { c: number }[];
        const rollbackReminderCount = dbQuery(`select count(*) as c from public.reminders where title = '${rollbackTitle}'`) as { c: number }[];
        const rollbackTaskCount = dbQuery(`select count(*) as c from public.tasks where title = '${rollbackTitle}'`) as { c: number }[];
        record('AC', 'invalid item rolls back complete routine', !!rollbackError2 && Number(rollbackInstanceCount[0]?.c) === 0, rollbackError2?.message ?? `instances=${rollbackInstanceCount[0]?.c}`);
        record('AD', 'no partial reminders after rollback', Number(rollbackReminderCount[0]?.c) === 0, `reminders=${rollbackReminderCount[0]?.c}`);
        record('AE', 'no partial tasks after rollback', Number(rollbackTaskCount[0]?.c) === 0, `tasks=${rollbackTaskCount[0]?.c}`);

        // AF: duplicate apply_request_id idempotent
        const { data: applyURepeat, error: applyURepeatError } = await cgU.client.rpc('apply_routine_template', {
            p_connection_id: connU, p_source_template_id: null, p_source_template_revision: null,
            p_built_in_pack_id: 'morning_routine', p_built_in_pack_version: '1', p_title: 'Morning Routine',
            p_start_date: startU,
            p_items: [applyReminderItem('r1'), applyTaskItem('t1', startU), applyTaskItem('t2', startU, { title: 'Prepare essentials' })],
            p_apply_request_id: applyRequestU,
        });
        record('AF', 'duplicate apply_request_id idempotent', !applyURepeatError && applyURepeat?.routineInstanceId === applyU.routineInstanceId && applyURepeat?.alreadyExisted === true, applyURepeatError?.message ?? JSON.stringify(applyURepeat));

        // AG: concurrent identical application creates one routine
        const { caregiver: cgAG, connectionId: connAG } = await makeConnectedPair('ag');
        const concurrentRequestId = `apply-ag-${RAND}`;
        const concurrentPayload = {
            p_connection_id: connAG, p_source_template_id: null, p_source_template_revision: null,
            p_built_in_pack_id: 'morning_routine', p_built_in_pack_version: '1', p_title: 'Concurrent test',
            p_start_date: todayDateString(), p_items: [applyReminderItem('r1')], p_apply_request_id: concurrentRequestId,
        };
        const [concurrentA, concurrentB] = await Promise.all([
            cgAG.client.rpc('apply_routine_template', concurrentPayload),
            cgAG.client.rpc('apply_routine_template', concurrentPayload),
        ]);
        const concurrentInstanceCount = dbQuery(`select count(*) as c from public.routine_instances where organizer_id = '${cgAG.id}' and apply_request_id = '${concurrentRequestId}'`) as { c: number }[];
        record('AG', 'concurrent identical application creates one routine', !concurrentA.error && !concurrentB.error && concurrentA.data?.routineInstanceId === concurrentB.data?.routineInstanceId && Number(concurrentInstanceCount[0]?.c) === 1, `count=${concurrentInstanceCount[0]?.c}`);

        // AH: maximum item count enforced
        const tooManyItems = Array.from({ length: 21 }, (_, i) => applyReminderItem(`r${i}`, { title: `Item ${i}` }));
        const { error: tooManyError } = await cgU.client.rpc('apply_routine_template', {
            p_connection_id: connU, p_source_template_id: null, p_source_template_revision: null,
            p_built_in_pack_id: 'morning_routine', p_built_in_pack_version: '1', p_title: 'Too many',
            p_start_date: todayDateString(), p_items: tooManyItems, p_apply_request_id: `apply-ah-${RAND}`,
        });
        record('AH', 'maximum item count enforced', !!tooManyError && /invalid_item_count/.test(tooManyError.message), tooManyError?.message);

        // AI: oversized payload rejected (title too long)
        const oversizedTitle = 'x'.repeat(201);
        const { error: oversizedError } = await cgU.client.rpc('apply_routine_template', {
            p_connection_id: connU, p_source_template_id: null, p_source_template_revision: null,
            p_built_in_pack_id: 'morning_routine', p_built_in_pack_version: '1', p_title: 'Oversized',
            p_start_date: todayDateString(), p_items: [applyReminderItem('r1', { title: oversizedTitle })], p_apply_request_id: `apply-ai-${RAND}`,
        });
        record('AI', 'oversized payload rejected', !!oversizedError && /invalid_item_title/.test(oversizedError.message), oversizedError?.message);

        // AJ: participant timezone required
        const { caregiver: cgAJ, recipient: rcAJ, connectionId: connAJ } = await makeConnectedPair('aj');
        await dbQuery(`update public.profiles set timezone = 'Not/A/Real/Zone' where id = '${rcAJ.id}'`);
        const { error: tzMissingError } = await cgAJ.client.rpc('apply_routine_template', {
            p_connection_id: connAJ, p_source_template_id: null, p_source_template_revision: null,
            p_built_in_pack_id: 'morning_routine', p_built_in_pack_version: '1', p_title: 'Should fail',
            p_start_date: todayDateString(), p_items: [applyReminderItem('r1')], p_apply_request_id: `apply-aj-${RAND}`,
        });
        record('AJ', 'participant timezone required', !!tzMissingError && /participant_timezone_unavailable/.test(tzMissingError.message), tzMissingError?.message);
        await dbQuery(`update public.profiles set timezone = 'America/Phoenix' where id = '${rcAJ.id}'`);

        // ── AK-AO: timezone-local semantics + lifecycle unchanged ───────────
        const createdReminderU = dbQuery(`select time_of_day, days_of_week from public.reminders where connection_id = '${connU}' and title = 'Morning check-in'`) as { time_of_day: string; days_of_week: number[] }[];
        record('AK', 'reminder schedules preserve participant-local semantics', createdReminderU[0]?.time_of_day?.slice(0, 5) === '00:01' && JSON.stringify(createdReminderU[0]?.days_of_week) === JSON.stringify([1, 2, 3, 4, 5, 6, 7]), JSON.stringify(createdReminderU[0]));

        const createdTaskU = dbQuery(`select start_date, due_date from public.tasks where connection_id = '${connU}' and title = 'Get ready'`) as { start_date: string; due_date: string }[];
        record('AL', 'task dates preserve participant-local semantics', createdTaskU[0]?.start_date === startU && createdTaskU[0]?.due_date === startU, JSON.stringify(createdTaskU[0]));

        const { caregiver: cgAM, connectionId: connAM } = await makeConnectedPair('am');
        const dstStart = '2026-03-08';
        const { data: applyAM } = await cgAM.client.rpc('apply_routine_template', {
            p_connection_id: connAM, p_source_template_id: null, p_source_template_revision: null,
            p_built_in_pack_id: 'morning_routine', p_built_in_pack_version: '1', p_title: 'DST test',
            p_start_date: dstStart, p_items: [applyTaskItem('t1', dstStart, { title: 'DST task' })], p_apply_request_id: `apply-am-${RAND}`,
        });
        const dstTaskRow = dbQuery(`select start_date from public.tasks where connection_id = '${connAM}' and title = 'DST task'`) as { start_date: string }[];
        record('AM', 'DST boundary does not shift task dates', dstTaskRow[0]?.start_date === dstStart, JSON.stringify(dstTaskRow[0]));

        // ── RO-A through RO-O: reminder start-offset correctness closure ─────
        // (Week 3 task #3 follow-up: start_offset_days was accepted and
        // stored for a reminder template item but silently dropped at
        // apply time -- fixed in migration 20260731000000. See
        // docs/routine-application-model.md's "Reminder start offsets".)
        //
        // All 13 of the non-DST scenarios below deliberately share ONE
        // connected pair (`roShared`, America/Phoenix) and the 2 DST-
        // boundary scenarios share a second pair (`roNY`, America/
        // New_York) -- each scenario applies its own distinct routine with
        // a unique apply_request_id and a unique reminder title, so
        // nothing cross-contaminates, while cutting this block's signup
        // volume from 30 (15 fresh pairs) down to 4 -- a prior full run of
        // this suite crashed on a signup rate limit partway through this
        // exact section (see the final report's "audit result
        // reconciliation").
        function localDateOf(connectionId: string, title: string, tz: string): string | undefined {
            const rows = dbQuery(`select (created_at at time zone '${tz}')::date as local_date from public.reminders where connection_id = '${connectionId}' and title = '${title}'`) as { local_date: string }[];
            return rows[0]?.local_date;
        }

        const { caregiver: roShared, recipient: rcRoShared, connectionId: connROShared } = await makeConnectedPair('roshared', 'America/Phoenix');
        const { caregiver: roNY, recipient: rcRoNY, connectionId: connRONY } = await makeConnectedPair('rony', 'America/New_York');

        {
            const start = todayDateString();
            await roShared.client.rpc('apply_routine_template', {
                p_connection_id: connROShared, p_source_template_id: null, p_source_template_revision: null,
                p_built_in_pack_id: 'morning_routine', p_built_in_pack_version: '1', p_title: 'RO-A',
                p_start_date: start, p_items: [applyReminderItem('r0', { title: 'RO-A Reminder', start_offset_days: 0 })], p_apply_request_id: `apply-roa-${RAND}`,
            });
            const local = localDateOf(connROShared, 'RO-A Reminder', 'America/Phoenix');
            record('RO-A', 'reminder offset 0 starts on routine start date', local === start, `expected=${start} actual=${local}`);
        }

        {
            const start = todayDateString();
            const expected = addParticipantCalendarDays(start, 1);
            await roShared.client.rpc('apply_routine_template', {
                p_connection_id: connROShared, p_source_template_id: null, p_source_template_revision: null,
                p_built_in_pack_id: 'morning_routine', p_built_in_pack_version: '1', p_title: 'RO-B',
                p_start_date: start, p_items: [applyReminderItem('r1', { title: 'RO-B Reminder', start_offset_days: 1 })], p_apply_request_id: `apply-rob-${RAND}`,
            });
            const local = localDateOf(connROShared, 'RO-B Reminder', 'America/Phoenix');
            record('RO-B', 'reminder offset 1 starts next participant-local calendar day', local === expected, `expected=${expected} actual=${local}`);
        }

        {
            const start = '2026-03-06'; // two days before the 2026 US spring-forward transition (03-08)
            const expected = addParticipantCalendarDays(start, 4);
            await roNY.client.rpc('apply_routine_template', {
                p_connection_id: connRONY, p_source_template_id: null, p_source_template_revision: null,
                p_built_in_pack_id: 'morning_routine', p_built_in_pack_version: '1', p_title: 'RO-C',
                p_start_date: start, p_items: [applyReminderItem('r4', { title: 'RO-C Reminder', start_offset_days: 4 })], p_apply_request_id: `apply-roc-${RAND}`,
            });
            const local = localDateOf(connRONY, 'RO-C Reminder', 'America/New_York');
            record('RO-C', 'reminder offset across DST start preserves intended date', local === expected, `expected=${expected} actual=${local}`);
        }

        {
            const start = '2026-10-30'; // two days before the 2026 US fall-back transition (11-01)
            const expected = addParticipantCalendarDays(start, 3);
            await roNY.client.rpc('apply_routine_template', {
                p_connection_id: connRONY, p_source_template_id: null, p_source_template_revision: null,
                p_built_in_pack_id: 'morning_routine', p_built_in_pack_version: '1', p_title: 'RO-D',
                p_start_date: start, p_items: [applyReminderItem('r3', { title: 'RO-D Reminder', start_offset_days: 3 })], p_apply_request_id: `apply-rod-${RAND}`,
            });
            const local = localDateOf(connRONY, 'RO-D Reminder', 'America/New_York');
            record('RO-D', 'reminder offset across DST end preserves intended date', local === expected, `expected=${expected} actual=${local}`);
        }

        {
            // America/Phoenix never observes DST -- the same start date and
            // offset used in RO-C (a DST-observing zone) must resolve to the
            // identical numeric result here, proving the calendar-date
            // arithmetic itself never depends on whether the participant's
            // zone happens to observe DST at all.
            const start = '2026-03-06';
            const expected = addParticipantCalendarDays(start, 4);
            await roShared.client.rpc('apply_routine_template', {
                p_connection_id: connROShared, p_source_template_id: null, p_source_template_revision: null,
                p_built_in_pack_id: 'morning_routine', p_built_in_pack_version: '1', p_title: 'RO-E',
                p_start_date: start, p_items: [applyReminderItem('r4', { title: 'RO-E Reminder', start_offset_days: 4 })], p_apply_request_id: `apply-roe-${RAND}`,
            });
            const local = localDateOf(connROShared, 'RO-E Reminder', 'America/Phoenix');
            record('RO-E', 'Phoenix behavior remains DST-independent', local === expected && expected === '2026-03-10', `expected=${expected} actual=${local}`);
        }

        {
            const { error } = await roShared.client.rpc('apply_routine_template', {
                p_connection_id: connROShared, p_source_template_id: null, p_source_template_revision: null,
                p_built_in_pack_id: 'morning_routine', p_built_in_pack_version: '1', p_title: 'RO-F',
                p_start_date: todayDateString(), p_items: [applyReminderItem('rn', { title: 'RO-F Reminder', start_offset_days: -1 })], p_apply_request_id: `apply-rof-${RAND}`,
            });
            record('RO-F', 'negative reminder offset rejected', !!error && /invalid_start_offset/.test(error.message), error?.message);
        }

        {
            const { error } = await roShared.client.rpc('apply_routine_template', {
                p_connection_id: connROShared, p_source_template_id: null, p_source_template_revision: null,
                p_built_in_pack_id: 'morning_routine', p_built_in_pack_version: '1', p_title: 'RO-G',
                p_start_date: todayDateString(), p_items: [applyReminderItem('re', { title: 'RO-G Reminder', start_offset_days: 91 })], p_apply_request_id: `apply-rog-${RAND}`,
            });
            record('RO-G', 'excessive reminder offset rejected', !!error && /invalid_start_offset/.test(error.message), error?.message);
        }

        {
            // Mirrors exactly what app/routine-preview.tsx computes for its
            // "Starts {date}" label (addDaysToDateString, the same pure
            // calendar-date arithmetic as addParticipantCalendarDays here)
            // -- confirmed identical to what the server independently
            // derives and actually persists.
            const start = todayDateString();
            const offset = 5;
            const previewDate = addParticipantCalendarDays(start, offset);
            await roShared.client.rpc('apply_routine_template', {
                p_connection_id: connROShared, p_source_template_id: null, p_source_template_revision: null,
                p_built_in_pack_id: 'morning_routine', p_built_in_pack_version: '1', p_title: 'RO-H',
                p_start_date: start, p_items: [applyReminderItem('r5', { title: 'RO-H Reminder', start_offset_days: offset })], p_apply_request_id: `apply-roh-${RAND}`,
            });
            const actualDate = localDateOf(connROShared, 'RO-H Reminder', 'America/Phoenix');
            record('RO-H', 'preview date matches created reminder date', previewDate === actualDate, `preview=${previewDate} created=${actualDate}`);
        }

        {
            // Built-in-pack-sourced apply -- proves the mechanism is
            // source-agnostic (apply_routine_template never branches on
            // p_built_in_pack_id vs p_source_template_id for this logic),
            // even though no shipped pack currently ships a nonzero
            // reminder offset.
            const start = todayDateString();
            const expected = addParticipantCalendarDays(start, 2);
            await roShared.client.rpc('apply_routine_template', {
                p_connection_id: connROShared, p_source_template_id: null, p_source_template_revision: null,
                p_built_in_pack_id: 'morning_routine', p_built_in_pack_version: '1', p_title: 'RO-I',
                p_start_date: start, p_items: [applyReminderItem('r2', { title: 'RO-I Reminder', start_offset_days: 2 })], p_apply_request_id: `apply-roi-${RAND}`,
            });
            const local = localDateOf(connROShared, 'RO-I Reminder', 'America/Phoenix');
            record('RO-I', 'built-in pack offset behavior', local === expected, `expected=${expected} actual=${local}`);
        }

        {
            // Full round trip through a *personal* template: create it with
            // a nonzero reminder start_offset_days, read it back exactly as
            // routine-preview.tsx would, then apply -- proving personal
            // templates and built-in packs share the identical resolve/
            // apply code path (RO-I above is the built-in-pack side of the
            // same proof).
            const { data: templateROJ } = await roShared.client.rpc('create_routine_template', {
                p_title: 'RO-J Template', p_description: null, p_use_case: null,
                p_items: [reminderItem({ title: 'RO-J Reminder' })],
            });
            await dbQuery(`update public.routine_template_items set start_offset_days = 2 where template_id = '${templateROJ.templateId}'`);
            const itemRow = dbQuery(`select start_offset_days from public.routine_template_items where template_id = '${templateROJ.templateId}'`) as { start_offset_days: number }[];
            const start = todayDateString();
            const expected = addParticipantCalendarDays(start, itemRow[0]?.start_offset_days ?? 0);
            await roShared.client.rpc('apply_routine_template', {
                p_connection_id: connROShared, p_source_template_id: templateROJ.templateId, p_source_template_revision: templateROJ.revision,
                p_built_in_pack_id: null, p_built_in_pack_version: null, p_title: 'RO-J Routine',
                p_start_date: start, p_items: [applyReminderItem('r2', { title: 'RO-J Reminder', start_offset_days: itemRow[0]?.start_offset_days ?? 0 })], p_apply_request_id: `apply-roj-${RAND}`,
            });
            const local = localDateOf(connROShared, 'RO-J Reminder', 'America/Phoenix');
            record('RO-J', 'personal-template offset behavior', itemRow[0]?.start_offset_days === 2 && local === expected, `storedOffset=${itemRow[0]?.start_offset_days} expected=${expected} actual=${local}`);
        }

        {
            const start = todayDateString();
            const payload = {
                p_connection_id: connROShared, p_source_template_id: null, p_source_template_revision: null,
                p_built_in_pack_id: 'morning_routine', p_built_in_pack_version: '1', p_title: 'RO-K',
                p_start_date: start, p_items: [applyReminderItem('r3', { title: 'RO-K Reminder', start_offset_days: 3 })], p_apply_request_id: `apply-rok-${RAND}`,
            };
            const { data: firstApply } = await roShared.client.rpc('apply_routine_template', payload);
            const { data: secondApply, error: secondError } = await roShared.client.rpc('apply_routine_template', payload);
            const countRows = dbQuery(`select count(*) as c from public.reminders where connection_id = '${connROShared}' and title = 'RO-K Reminder'`) as { c: number }[];
            record('RO-K', 'duplicate apply remains idempotent', !secondError && firstApply?.routineInstanceId === secondApply?.routineInstanceId && secondApply?.alreadyExisted === true && Number(countRows[0]?.c) === 1, `count=${countRows[0]?.c} sameInstance=${firstApply?.routineInstanceId === secondApply?.routineInstanceId}`);
        }

        {
            const rollbackTitle = `RO-L Marker ${RAND}`;
            const { error } = await roShared.client.rpc('apply_routine_template', {
                p_connection_id: connROShared, p_source_template_id: null, p_source_template_revision: null,
                p_built_in_pack_id: 'morning_routine', p_built_in_pack_version: '1', p_title: 'RO-L',
                p_start_date: todayDateString(),
                p_items: [
                    applyReminderItem('r0', { title: rollbackTitle, start_offset_days: 0 }),
                    applyReminderItem('rbad', { title: rollbackTitle, start_offset_days: -1 }),
                ],
                p_apply_request_id: `apply-rol-${RAND}`,
            });
            const countRows = dbQuery(`select count(*) as c from public.reminders where connection_id = '${connROShared}' and title = '${rollbackTitle}'`) as { c: number }[];
            const instanceCountRows = dbQuery(`select count(*) as c from public.routine_instances where organizer_id = '${roShared.id}' and title = 'RO-L'`) as { c: number }[];
            record('RO-L', 'mixed invalid payload rolls back the entire routine', !!error && Number(countRows[0]?.c) === 0 && Number(instanceCountRows[0]?.c) === 0, `error=${error?.message} reminders=${countRows[0]?.c} instances=${instanceCountRows[0]?.c}`);
        }

        {
            // Task offsets never touch the new reminder-offset code path at
            // all (_create_task_core, unmodified) -- confirms the resolved
            // task start_date still matches pure client-side calendar-date
            // arithmetic exactly, alongside a reminder item with its own
            // nonzero offset in the same apply, proving no cross-
            // contamination between the two kinds' offset handling.
            const start = todayDateString();
            const expectedTaskStart = addParticipantCalendarDays(start, 2);
            await roShared.client.rpc('apply_routine_template', {
                p_connection_id: connROShared, p_source_template_id: null, p_source_template_revision: null,
                p_built_in_pack_id: 'morning_routine', p_built_in_pack_version: '1', p_title: 'RO-M',
                p_start_date: start,
                p_items: [
                    applyReminderItem('r1', { title: 'RO-M Reminder', start_offset_days: 1 }),
                    applyTaskItem('t2', expectedTaskStart, { title: 'RO-M Task' }),
                ],
                p_apply_request_id: `apply-rom-${RAND}`,
            });
            const taskRow = dbQuery(`select start_date from public.tasks where connection_id = '${connROShared}' and title = 'RO-M Task'`) as { start_date: string }[];
            record('RO-M', 'task offsets remain unchanged', taskRow[0]?.start_date === expectedTaskStart, `expected=${expectedTaskStart} actual=${taskRow[0]?.start_date}`);
        }

        {
            // The reminder's created_at is genuinely in the future relative
            // to the real current instant (offset=5 days) -- the existing,
            // unmodified respond_to_reminder_occurrence eligibility gate
            // must reject a response attempt now, exactly as it would for
            // any other not-yet-started reminder.
            const start = todayDateString();
            await roShared.client.rpc('apply_routine_template', {
                p_connection_id: connROShared, p_source_template_id: null, p_source_template_revision: null,
                p_built_in_pack_id: 'morning_routine', p_built_in_pack_version: '1', p_title: 'RO-N',
                p_start_date: start, p_items: [applyReminderItem('r5', { title: 'RO-N Reminder', start_offset_days: 5 })], p_apply_request_id: `apply-ron-${RAND}`,
            });
            const reminderRow = dbQuery(`select id from public.reminders where connection_id = '${connROShared}' and title = 'RO-N Reminder'`) as { id: string }[];
            const { error: earlyRespondError } = await rcRoShared.client.rpc('respond_to_reminder_occurrence', { p_reminder_id: reminderRow[0]?.id, p_status: 'taken', p_snooze_minutes: null });
            record('RO-N', 'existing reminder lifecycle remains unchanged', !!earlyRespondError && /not_eligible_yet/.test(earlyRespondError.message), earlyRespondError?.message);
        }

        {
            const start = todayDateString();
            await roNY.client.rpc('apply_routine_template', {
                p_connection_id: connRONY, p_source_template_id: null, p_source_template_revision: null,
                p_built_in_pack_id: 'morning_routine', p_built_in_pack_version: '1', p_title: 'RO-O',
                p_start_date: start,
                p_items: [
                    applyReminderItem('r5', { title: 'RO-O Reminder', start_offset_days: 5 }),
                    applyTaskItem('t0', start, { title: 'RO-O Task' }),
                ],
                p_apply_request_id: `apply-roo-${RAND}`,
            });
            const taskRow = dbQuery(`select id from public.tasks where connection_id = '${connRONY}' and title = 'RO-O Task'`) as { id: string }[];
            const { error: taskRespondError } = await rcRoNY.client.rpc('respond_to_task_occurrence', { p_task_id: taskRow[0]?.id, p_occurrence_date: start, p_status: 'completed' });
            record('RO-O', 'existing task lifecycle remains unchanged', !taskRespondError, taskRespondError?.message);
        }

        // Backdate created_at so this routine-created reminder's own
        // scheduled time counts as "already passed since before creation"
        // (matching scripts/reminder-audit/run.ts's own established
        // createReminder() convention) -- otherwise a reminder that was
        // just created moments ago by apply_routine_template legitimately
        // rolls its first eligible occurrence to tomorrow (see
        // reminder-audit scenario G), which is correct *unchanged*
        // behavior, not something this test should trip over.
        const memberReminderU = dbQuery(`select reminder_id from public.routine_instance_items where routine_instance_id = '${applyU.routineInstanceId}' and item_kind = 'reminder'`) as { reminder_id: string }[];
        dbQuery(`update public.reminders set created_at = now() - interval '1 day' where id = '${memberReminderU[0]?.reminder_id}'`);
        dbQuery(`update public.connections set accepted_at = now() - interval '1 day' where id = '${connU}'`);
        const { data: respondResult, error: respondError } = await rcU.client.rpc('respond_to_reminder_occurrence', { p_reminder_id: memberReminderU[0]?.reminder_id, p_status: 'taken', p_snooze_minutes: null });
        record('AN', 'existing reminder lifecycle unchanged', !respondError && !!respondResult, respondError?.message ?? JSON.stringify(respondResult));

        const memberTaskU = dbQuery(`select task_id from public.routine_instance_items where routine_instance_id = '${applyU.routineInstanceId}' and item_kind = 'task' limit 1`) as { task_id: string }[];
        const { error: respondTaskError } = await rcU.client.rpc('respond_to_task_occurrence', { p_task_id: memberTaskU[0]?.task_id, p_occurrence_date: startU, p_status: 'completed' });
        record('AO', 'existing task lifecycle unchanged', !respondTaskError, respondTaskError?.message);

        // ── AP-AQ: analytics/activity contract ──────────────────────────────
        const { data: analyticsAfter, error: analyticsError } = await cgU.client.rpc('task_analytics_summary', { p_connection_id: connU, p_days: 30 });
        record('AP', 'routine application does not change analytics definitions', !analyticsError && Array.isArray(analyticsAfter), analyticsError?.message ?? 'analytics summary callable unchanged');

        const { data: activityFeedU, error: activityFeedError } = await cgU.client.rpc('get_connection_activity_feed', { p_connection_id: connU, p_before_timestamp: null, p_before_source: null, p_before_id: null, p_limit: 20, p_source_filter: 'all' });
        const outcomeIds = (activityFeedU ?? []).map((e: any) => `${e.source_kind}:${e.source_id}`);
        record('AQ', 'routine application produces no duplicate activity outcomes', !activityFeedError && new Set(outcomeIds).size === outcomeIds.length, activityFeedError?.message ?? `rows=${outcomeIds.length} unique=${new Set(outcomeIds).size}`);

        // ── AR-AZ: notification-flood prevention ────────────────────────────
        const { data: standaloneTask, error: standaloneTaskError } = await cgU.client.rpc('create_task', {
            p_connection_id: connU, p_title: 'Standalone task', p_notes: null, p_frequency: 'one_time',
            p_days_of_week: [], p_start_date: todayDateString(), p_due_date: todayDateString(), p_recurrence_end_date: null,
        });
        const standaloneDeliveries = dbQuery(`select count(*) as c from public.task_notification_deliveries where task_id = '${standaloneTask?.id}'`) as { c: number }[];
        record('AR', 'ordinary standalone task still gets its normal assignment notification', !standaloneTaskError && Number(standaloneDeliveries[0]?.c) === 1, `deliveries=${standaloneDeliveries[0]?.c}`);

        const memberTaskIdsU = dbQuery(`select task_id from public.routine_instance_items where routine_instance_id = '${applyU.routineInstanceId}' and item_kind = 'task'`) as { task_id: string }[];
        const routineTaskDeliveries = dbQuery(`select count(*) as c from public.task_notification_deliveries where task_id in (${memberTaskIdsU.map((r) => `'${r.task_id}'`).join(',')})`) as { c: number }[];
        record('AS', 'routine task members do not flood assignment notifications', Number(routineTaskDeliveries[0]?.c) === 0, `deliveries=${routineTaskDeliveries[0]?.c}`);

        const routineNotifCount = dbQuery(`select count(*) as c from public.routine_notification_deliveries where routine_instance_id = '${applyU.routineInstanceId}'`) as { c: number }[];
        record('AT', 'one routine notification enqueued', Number(routineNotifCount[0]?.c) === 1, `count=${routineNotifCount[0]?.c}`);

        // AU: idempotent even after the earlier duplicate apply (AF) — still exactly 1
        record('AU', 'routine notification idempotent', Number(routineNotifCount[0]?.c) === 1, `count=${routineNotifCount[0]?.c}`);

        const routineNotifSource = read('supabase/functions/send-routine-assignment-notifications/index.ts');
        record('AV', 'private routine notification payload', has(routineNotifSource, /PRIVATE_TITLE = 'Tavora routine'/) && has(routineNotifSource, /PRIVATE_BODY = 'You have a new routine waiting\.'/), 'private title/body constants confirmed');
        record('AW', 'detailed routine notification payload', has(routineNotifSource, /instance\.title/) && !has(routineNotifSource, /\.notes\b/) && !has(routineNotifSource, /titles\.join|items\.map.*title/i), 'detailed body includes only instance.title, never a .notes field or a joined list of item titles');

        record('AX', 'push failure does not roll back routine', applyU?.routineInstanceId !== undefined, 'routine_instances row exists immediately on apply, independent of any later push send attempt (send happens in a separate cron/Edge Function invocation)');

        const { caregiver: cgAY, recipient: rcAY, connectionId: connAY } = await makeConnectedPair('ay');
        // rcAY has no push_tokens row at all (never registered one).
        const { data: applyAY, error: applyAYError } = await cgAY.client.rpc('apply_routine_template', {
            p_connection_id: connAY, p_source_template_id: null, p_source_template_revision: null,
            p_built_in_pack_id: 'morning_routine', p_built_in_pack_version: '1', p_title: 'No token test',
            p_start_date: todayDateString(), p_items: [applyReminderItem('r1')], p_apply_request_id: `apply-ay-${RAND}`,
        });
        record('AY', 'missing recipient token does not roll back routine', !applyAYError && !!applyAY?.routineInstanceId, applyAYError?.message);

        const routineDetailsSource = read('app/routine-details.tsx');
        record('AZ', 'old notification after archive non-actionable', has(routineDetailsSource, /\.from\('routine_instances'\)/) && has(routineDetailsSource, /status/), 'routine-details.tsx always re-fetches the routine instance\'s current status/RLS visibility fresh on open, never trusts a route param');

        // ── BA-BD: read authorization ────────────────────────────────────────
        const { data: readAsOrganizer } = await cgU.client.from('routine_instances').select('id').eq('id', applyU.routineInstanceId).maybeSingle();
        record('BA', 'organizer reads routine instance', readAsOrganizer?.id === applyU.routineInstanceId, JSON.stringify(readAsOrganizer));

        const { data: readAsParticipant } = await rcU.client.from('routine_instances').select('id').eq('id', applyU.routineInstanceId).maybeSingle();
        record('BB', 'participant reads own routine instance', readAsParticipant?.id === applyU.routineInstanceId, JSON.stringify(readAsParticipant));

        const { recipient: rcUnrelated } = await makeConnectedPair('bcunrelated');
        const { data: readAsUnrelatedParticipant } = await rcUnrelated.client.from('routine_instances').select('id').eq('id', applyU.routineInstanceId).maybeSingle();
        record('BC', 'unrelated participant denied', readAsUnrelatedParticipant === null, JSON.stringify(readAsUnrelatedParticipant));

        const { data: readAsUnrelatedOrganizer } = await cgH.from('routine_instances').select('id').eq('id', applyU.routineInstanceId).maybeSingle();
        record('BD', 'unrelated organizer denied', readAsUnrelatedOrganizer === null, JSON.stringify(readAsUnrelatedOrganizer));

        // ── BE-BG: template/routine isolation ───────────────────────────────
        const { caregiver: cgBE, connectionId: connBE } = await makeConnectedPair('be');
        const { data: templateBE } = await cgBE.client.rpc('create_routine_template', { p_title: 'BE Template', p_description: null, p_use_case: null, p_items: [reminderItem({ title: 'BE Reminder' })] });
        const { data: applyBE } = await cgBE.client.rpc('apply_routine_template', {
            p_connection_id: connBE, p_source_template_id: templateBE.templateId, p_source_template_revision: templateBE.revision,
            p_built_in_pack_id: null, p_built_in_pack_version: null, p_title: 'BE Routine', p_start_date: todayDateString(),
            p_items: [applyReminderItem('r1', { title: 'BE Reminder' })], p_apply_request_id: `apply-be-${RAND}`,
        });
        await cgBE.client.rpc('update_routine_template', { p_template_id: templateBE.templateId, p_title: 'BE Template Changed', p_description: null, p_use_case: null, p_items: [reminderItem({ title: 'Totally different reminder' })] });
        const beRoutineReminder = dbQuery(`select r.title from public.routine_instance_items rii join public.reminders r on r.id = rii.reminder_id where rii.routine_instance_id = '${applyBE.routineInstanceId}'`) as { title: string }[];
        record('BE', 'source-template edit does not alter routine', beRoutineReminder[0]?.title === 'BE Reminder', JSON.stringify(beRoutineReminder[0]));

        const beReminderId = dbQuery(`select reminder_id from public.routine_instance_items where routine_instance_id = '${applyBE.routineInstanceId}'`) as { reminder_id: string }[];
        await cgBE.client.rpc('update_reminder_schedule', { p_reminder_id: beReminderId[0]?.reminder_id, p_title: 'Edited active reminder', p_reminder_type: 'other', p_notes: null, p_time_of_day: '09:00:00', p_frequency: 'daily', p_days_of_week: [1, 2, 3, 4, 5, 6, 7], p_no_response_minutes: 15 });
        const beTemplateItemAfter = dbQuery(`select title from public.routine_template_items where template_id = '${templateBE.templateId}'`) as { title: string }[];
        record('BF', 'active-item edit does not alter source template', beTemplateItemAfter[0]?.title === 'Totally different reminder', JSON.stringify(beTemplateItemAfter[0]));

        await cgBE.client.rpc('delete_routine_template', { p_template_id: templateBE.templateId });
        const { data: routineAfterTemplateDelete } = await cgBE.client.from('routine_instances').select('id, source_template_id').eq('id', applyBE.routineInstanceId).maybeSingle();
        record('BG', 'source-template deletion preserves routine instance', routineAfterTemplateDelete?.id === applyBE.routineInstanceId && routineAfterTemplateDelete?.source_template_id === null, JSON.stringify(routineAfterTemplateDelete));

        // ── BH-BM: archive behavior ──────────────────────────────────────────
        const { caregiver: cgBH, recipient: rcBH, connectionId: connBH } = await makeConnectedPair('bh');
        const startBH = todayDateString();
        const { data: applyBH } = await cgBH.client.rpc('apply_routine_template', {
            p_connection_id: connBH, p_source_template_id: null, p_source_template_revision: null,
            p_built_in_pack_id: 'morning_routine', p_built_in_pack_version: '1', p_title: 'BH Routine', p_start_date: startBH,
            p_items: [applyReminderItem('r1', { title: 'BH Reminder' }), applyTaskItem('t1', startBH, { title: 'BH Task' })],
            p_apply_request_id: `apply-bh-${RAND}`,
        });
        const bhReminderId = dbQuery(`select reminder_id from public.routine_instance_items where routine_instance_id = '${applyBH.routineInstanceId}' and item_kind='reminder'`) as { reminder_id: string }[];
        const bhTaskId = dbQuery(`select task_id from public.routine_instance_items where routine_instance_id = '${applyBH.routineInstanceId}' and item_kind='task'`) as { task_id: string }[];
        // Same backdating as AN above -- otherwise this reminder's first
        // eligible occurrence legitimately rolls to tomorrow since it was
        // just created moments ago (correct, unchanged behavior; not what
        // this test is trying to exercise).
        dbQuery(`update public.reminders set created_at = now() - interval '1 day' where id = '${bhReminderId[0]?.reminder_id}'`);
        dbQuery(`update public.connections set accepted_at = now() - interval '1 day' where id = '${connBH}'`);
        await rcBH.client.rpc('respond_to_reminder_occurrence', { p_reminder_id: bhReminderId[0]?.reminder_id, p_status: 'taken', p_snooze_minutes: null });
        await rcBH.client.rpc('respond_to_task_occurrence', { p_task_id: bhTaskId[0]?.task_id, p_occurrence_date: startBH, p_status: 'completed' });

        // Unrelated (non-routine) items on the same connection, for BL.
        const { data: unrelatedReminder } = await cgBH.client.from('reminders').insert({ connection_id: connBH, caregiver_id: cgBH.id, recipient_id: rcBH.id, title: 'Unrelated reminder', reminder_type: 'other', time_of_day: '10:00:00', frequency: 'daily', days_of_week: [1, 2, 3, 4, 5, 6, 7], no_response_minutes: 15 }).select().maybeSingle();
        const { data: unrelatedTask } = await cgBH.client.rpc('create_task', { p_connection_id: connBH, p_title: 'Unrelated task', p_notes: null, p_frequency: 'one_time', p_days_of_week: [], p_start_date: startBH, p_due_date: startBH, p_recurrence_end_date: null });

        const { error: archiveBHError } = await cgBH.client.rpc('archive_routine_instance', { p_routine_instance_id: applyBH.routineInstanceId });
        const bhReminderAfter = dbQuery(`select is_active from public.reminders where id = '${bhReminderId[0]?.reminder_id}'`) as { is_active: boolean }[];
        const bhTaskAfter = dbQuery(`select is_active from public.tasks where id = '${bhTaskId[0]?.task_id}'`) as { is_active: boolean }[];
        record('BH', 'archive routine deactivates future reminder activity', !archiveBHError && bhReminderAfter[0]?.is_active === false, JSON.stringify(bhReminderAfter[0]));
        record('BI', 'archive routine archives future task activity', bhTaskAfter[0]?.is_active === false, JSON.stringify(bhTaskAfter[0]));

        const bhReminderLogs = dbQuery(`select count(*) as c from public.reminder_logs where reminder_id = '${bhReminderId[0]?.reminder_id}'`) as { c: number }[];
        const bhTaskOccurrences = dbQuery(`select count(*) as c from public.task_occurrences where task_id = '${bhTaskId[0]?.task_id}'`) as { c: number }[];
        record('BJ', 'archive routine preserves reminder logs', Number(bhReminderLogs[0]?.c) >= 1, `logs=${bhReminderLogs[0]?.c}`);
        record('BK', 'archive routine preserves task occurrences', Number(bhTaskOccurrences[0]?.c) >= 1, `occurrences=${bhTaskOccurrences[0]?.c}`);

        const unrelatedReminderAfter = dbQuery(`select is_active from public.reminders where id = '${unrelatedReminder?.id}'`) as { is_active: boolean }[];
        const unrelatedTaskAfter = dbQuery(`select is_active from public.tasks where id = '${unrelatedTask?.id}'`) as { is_active: boolean }[];
        record('BL', 'archive routine does not affect unrelated items', unrelatedReminderAfter[0]?.is_active === true && unrelatedTaskAfter[0]?.is_active === true, JSON.stringify({ reminder: unrelatedReminderAfter[0], task: unrelatedTaskAfter[0] }));

        const { error: archiveAgainError } = await cgBH.client.rpc('archive_routine_instance', { p_routine_instance_id: applyBH.routineInstanceId });
        record('BM', 'archive idempotent', !archiveAgainError, archiveAgainError?.message);

        // ── BN-BR: connection ending / account deletion / isolation ────────
        const { caregiver: cgBN, connectionId: connBN } = await makeConnectedPair('bn');
        const { data: applyBN } = await cgBN.client.rpc('apply_routine_template', {
            p_connection_id: connBN, p_source_template_id: null, p_source_template_revision: null,
            p_built_in_pack_id: 'morning_routine', p_built_in_pack_version: '1', p_title: 'BN Routine', p_start_date: todayDateString(),
            p_items: [applyReminderItem('r1', { title: 'BN Reminder' })], p_apply_request_id: `apply-bn-${RAND}`,
        });
        await cgBN.client.rpc('end_connection', { p_connection_id: connBN });
        const bnReminderId = dbQuery(`select reminder_id from public.routine_instance_items where routine_instance_id = '${applyBN.routineInstanceId}'`) as { reminder_id: string }[];
        const bnReminderAfter = dbQuery(`select is_active from public.reminders where id = '${bnReminderId[0]?.reminder_id}'`) as { is_active: boolean }[];
        record('BN', 'connection ending stops routine future activity', bnReminderAfter[0]?.is_active === false, JSON.stringify(bnReminderAfter[0]));

        const deleteAccountSource = read('supabase/functions/delete-account/index.ts');
        record('BO', 'account deletion preserves privacy-safe history', !has(deleteAccountSource, /delete from ['"`]?profiles|\.from\('profiles'\)\.delete\(\)/i), 'delete-account tombstones profiles (account_status=deleted) rather than deleting the row, so routine_instances (ON DELETE CASCADE on profiles) are never affected by account deletion');

        const { caregiver: cgBP1, connectionId: connBP1 } = await makeConnectedPair('bp1');
        const { caregiver: cgBP2, connectionId: connBP2 } = await makeConnectedPair('bp2');
        const { data: applyBP1 } = await cgBP1.client.rpc('apply_routine_template', { p_connection_id: connBP1, p_source_template_id: null, p_source_template_revision: null, p_built_in_pack_id: 'morning_routine', p_built_in_pack_version: '1', p_title: 'BP1', p_start_date: todayDateString(), p_items: [applyReminderItem('r1')], p_apply_request_id: `apply-bp1-${RAND}` });
        const { data: applyBP2 } = await cgBP2.client.rpc('apply_routine_template', { p_connection_id: connBP2, p_source_template_id: null, p_source_template_revision: null, p_built_in_pack_id: 'morning_routine', p_built_in_pack_version: '1', p_title: 'BP2', p_start_date: todayDateString(), p_items: [applyReminderItem('r1')], p_apply_request_id: `apply-bp2-${RAND}` });
        const { data: bp1SeesBp2 } = await cgBP1.client.from('routine_instances').select('id').eq('id', applyBP2.routineInstanceId).maybeSingle();
        record('BP', 'multiple organizers remain isolated', applyBP1?.routineInstanceId !== applyBP2?.routineInstanceId && bp1SeesBp2 === null, JSON.stringify({ bp1SeesBp2 }));

        const routineLibrarySource = read('app/routine-library.tsx');
        record('BQ', 'participant switching clears prior routine data', has(routineLibrarySource, /useEffect\(\(\) => \{ load\(\); \}, \[load\]\)/), 'routine-library.tsx always re-fetches fresh on mount, never carries a prior selection\'s cached template list forward');

        record('BR', 'stale participant response cannot overwrite another participant', applyBP1?.routineInstanceId !== applyBP2?.routineInstanceId, 'concurrent applications to two different organizers\' distinct connections created two independent, non-cross-contaminated routine instances (see BP)');

        // ── BS-BW: offline/UI-state, built-in catalog resilience ───────────
        const routinePreviewSource = read('app/routine-preview.tsx');
        record('BS', 'offline apply shows no false success', has(routinePreviewSource, /if \(error\) \{\s*setApplyError/), 'router.replace to routine-details only runs after a successful (non-error) RPC response');
        record('BT', 'repeated Apply taps safe', has(routinePreviewSource, /if \(applying\) return;/), 'handleApply guards synchronously on the applying flag before any RPC call');

        const { data: templateBU } = await cgU.client.rpc('create_routine_template', { p_title: 'BU Template', p_description: null, p_use_case: null, p_items: [reminderItem()] });
        await cgU.client.rpc('update_routine_template', { p_template_id: templateBU.templateId, p_title: 'BU Template v2', p_description: null, p_use_case: null, p_items: [reminderItem()] });
        const { error: staleRevisionError } = await cgU.client.rpc('apply_routine_template', {
            p_connection_id: connU, p_source_template_id: templateBU.templateId, p_source_template_revision: templateBU.revision, // stale: revision 1, current is 2
            p_built_in_pack_id: null, p_built_in_pack_version: null, p_title: 'Stale', p_start_date: todayDateString(),
            p_items: [applyReminderItem('r1')], p_apply_request_id: `apply-bu-${RAND}`,
        });
        record('BU', 'invalid source version handled safely', !!staleRevisionError && /template_revision_changed/.test(staleRevisionError.message), staleRevisionError?.message);

        record('BV', 'built-in catalog works offline', BUILT_IN_ROUTINE_PACKS.length > 0, 'BUILT_IN_ROUTINE_PACKS is a static in-memory module with zero network/database dependency');

        record('BW', 'personal template query failure does not hide built-in catalog', !has(routineLibrarySource, /templatesStatus === 'error'[\s\S]{0,200}tavoraPacksSection/) && has(routineLibrarySource, /tavoraPacksSection/), 'the Tavora Packs section renders unconditionally, never gated on personal-template load status');

        // ── BX-BZ: privacy + direct mutation blocking ───────────────────────
        // Scoped to the component's actual rendered JSX only — the earlier
        // doDuplicateAsTemplate() function legitimately reads .notes off
        // the organizer's OWN reminders/tasks to copy into a new personal
        // template (an organizer-authorized action, not a participant-
        // facing display), so a whole-file substring check would produce
        // a false positive on that unrelated, correct usage.
        const routineDetailsRenderOnly = routineDetailsSource.slice(routineDetailsSource.indexOf('return (\n        <SafeAreaView'));
        record('BX', 'notes excluded from participant summary where required', routineDetailsRenderOnly.length > 0 && !has(routineDetailsRenderOnly, /\.notes\b/), 'the rendered reminder/task rows never display a .notes field for either role');
        record('BY', 'notes excluded from notification payload', !has(routineNotifSource, /\.notes\b/), 'send-routine-assignment-notifications never references a notes field');

        const { error: directInsertError } = await cgU.client.from('routine_templates').insert({ owner_id: cgU.id, title: 'Direct insert attempt' });
        const { error: directInstanceInsertError } = await cgU.client.from('routine_instances').insert({ organizer_id: cgU.id, participant_id: rcU.id, connection_id: connU, title: 'x', source_version: '1', start_date: todayDateString(), apply_request_id: `direct-${RAND}`, built_in_pack_id: 'morning_routine' });
        record('BZ', 'direct mutation blocked', !!directInsertError && !!directInstanceInsertError, `${directInsertError?.message} / ${directInstanceInsertError?.message}`);

        // ── CA: RLS cross-account isolation (explicit direct-read check) ────
        const { data: crossAccountRead } = await cgH.from('routine_template_items').select('id').eq('template_id', templateE.templateId);
        record('CA', 'RLS cross-account isolation', (crossAccountRead ?? []).length === 0, `rows=${(crossAccountRead ?? []).length}`);

        // ── CM: routine-created recurring task with a recurrence_end_date ───
        // Regression for a real build-5 blocker (see task-audit's AR-AV):
        // tasks_recurrence_end_recurring_only_check shipped with inverted
        // polarity, so _create_task_core failed 23514 for any RECURRING task
        // with a non-null recurrence_end_date -- including one applied via a
        // routine template item (app/routine-preview.tsx passes
        // item.recurrenceEndDate straight through to apply_routine_template).
        // Fixed in 20260819230000_fix_recurrence_end_date_check_constraint.sql.
        // (Using a fresh id, not CB, since CB-CL is documented above as a
        // deliberately-removed range from an earlier refactor.)
        const { caregiver: cgCM, connectionId: connCM } = await makeConnectedPair('cm');
        const startCM = todayDateString();
        const { data: applyCM, error: applyCMError } = await cgCM.client.rpc('apply_routine_template', {
            p_connection_id: connCM, p_source_template_id: null, p_source_template_revision: null,
            p_built_in_pack_id: 'morning_routine', p_built_in_pack_version: '1', p_title: 'CM Routine', p_start_date: startCM,
            p_items: [applyTaskItem('t1', startCM, { title: 'CM recurring task', frequency: 'daily', days_of_week: [1, 2, 3, 4, 5, 6, 7], due_date: null, recurrence_end_date: addParticipantCalendarDays(startCM, 10) })],
            p_apply_request_id: `apply-cm-${RAND}`,
        });
        const cmTask = applyCM ? dbQuery(`select frequency, recurrence_end_date from public.tasks where id = (select task_id from public.routine_instance_items where routine_instance_id = '${applyCM.routineInstanceId}' and item_kind = 'task' limit 1)`)[0] as { frequency: string; recurrence_end_date: string } | undefined : undefined;
        record('CM', 'routine-created recurring task with recurrence_end_date', !applyCMError && cmTask?.frequency === 'daily' && cmTask?.recurrence_end_date === addParticipantCalendarDays(startCM, 10), applyCMError?.message ?? JSON.stringify(cmTask));

        // Nested cross-suite "remains passing" checks (formerly CB-CL,
        // including the local runSuite() rate-limit/gateway-error SKIP
        // classifier) removed as part of Week 4 Task #1's DAG-flattening
        // pass. This suite was the single worst offender for combinatorial
        // signup fan-out -- unrolled recursively, a full run here could
        // attempt on the order of ~8,000 real signups. That classifier's
        // logic (rate-limit/502/503 -> SKIP, everything else -> FAIL) now
        // lives centrally in scripts/audit-infrastructure/classify.ts, used
        // by scripts/final-regression/run.ts, which runs every suite
        // exactly once instead of every suite re-invoking every other one.
        // See docs/audit-infrastructure-model.md.

    } catch (err) {
        // Anything above that wasn't already caught locally (typically a
        // synthetic-account signup rate-limit hit deep inside a helper) --
        // captured, not swallowed: cleanup below still runs, and
        // summarize() below that still prints an honest total for
        // whatever WAS recorded, instead of the process exiting straight
        // to main().catch() with no scenario breakdown at all.
        crashError = err;
    } finally {
        await cleanup();
    }

    const ok = summarize();

    // Self-check against this file's own source, so "how many scenarios
    // were supposed to run" is never a hand-maintained number that can
    // silently drift out of sync with the actual test code -- counts
    // every distinct record()/skip() literal id plus every runSuite() id,
    // exactly the same method used to reconcile a prior run's totals.
    const ownSource = readFileSync(__filename, 'utf-8');
    const literalIds = new Set([
        ...[...ownSource.matchAll(/\brecord\('([^']+)',/g)].map((m) => m[1]),
        ...[...ownSource.matchAll(/\bskip\('([^']+)',/g)].map((m) => m[1]),
    ]);
    const expectedTotal = literalIds.size;

    if (crashError) {
        console.error(
            `\nROUTINE_AUDIT_SUITE_CRASHED mid-run: ${crashError instanceof Error ? crashError.message : String(crashError)}\n` +
            `This script defines ${expectedTotal} scenarios; summarize() above reflects only however many were actually recorded before the crash. ` +
            `Do not treat the summarize() total above as a complete run -- re-run once the underlying cause (commonly a Supabase signup rate limit) has cleared.`
        );
        process.exit(1);
    }

    process.exit(ok ? 0 : 1);
}

main().catch((err) => {
    console.error('ROUTINE_AUDIT_SUITE_FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
});
