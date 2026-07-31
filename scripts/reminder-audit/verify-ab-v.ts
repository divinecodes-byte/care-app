// Targeted, standalone verification for the AB (midnight-hour wraparound)
// and V (live-cron race) fixes applied to scripts/reminder-audit/run.ts
// (Week 4 Task #3 correction, item 6). Not part of the permanent 41-
// scenario suite -- a one-off, run once after the fix instead of
// re-running the entire suite repeatedly, per item 6's explicit
// instruction. Exercises the exact fixed logic from run.ts directly.
import { getComputedStatus } from '../../lib/reminderStatus';
import { dbQuery, newClient, randomSuffix } from '../security-audit/helpers';
import { installCrashSafety, scopedCleanup } from '../audit-infrastructure/cleanup';

const RAND = randomSuffix();
const PASSWORD = `AbVVerify!${RAND}9X`;
const EMAIL_PREFIX = 'tavora.reminderaudit'; // reuses the suite's own already-registered namespace

let failures = 0;
function assert(label: string, cond: boolean, detail?: string) {
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? `  (${detail})` : ''}`);
    if (!cond) failures++;
}

// The exact fixed AB formula (mirrors scripts/reminder-audit/run.ts's AB
// block verbatim), parameterized on "now" so it can be exercised at the
// specific hour that broke the old `(hour+1)%24` formula, regardless of
// the real wall-clock time this script happens to run at.
function runAB(nowOverride: Date): number {
    const analyticsReminder = {
        days_of_week: [1, 2, 3, 4, 5, 6, 7],
        time_of_day: '09:00:00',
        created_at: '2026-01-01T00:00:00.000Z',
        is_active: true,
        no_response_minutes: 15,
    };
    const realNow = nowOverride;
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
        { status: getComputedStatus(notYetDueReminder, oneHourFromNowDateStr, realTodayStr, undefined) },
        { status: getComputedStatus(analyticsReminder, `${realFutureYear}-01-01`, realTodayStr, undefined) },
    ];
    return displays.filter((d) => d.status !== 'pending').length;
}

async function main() {
    const today = new Date();

    // The exact hour where the OLD `(hour+1)%24` formula wrapped to
    // "00:00:00" -- a time EARLIER than "now" -- turning the second
    // display into non-pending and producing the originally observed
    // countable=2 failure.
    const at2330 = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 30, 0, 0);
    assert('AB @ 23:30 (the exact old wraparound hour)', runAB(at2330) === 1, `countable=${runAB(at2330)}`);

    const at2300 = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 0, 0, 0);
    assert('AB @ 23:00 (boundary instant)', runAB(at2300) === 1, `countable=${runAB(at2300)}`);

    const at2359 = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 0, 0);
    assert('AB @ 23:59 (last minute of the boundary hour)', runAB(at2359) === 1, `countable=${runAB(at2359)}`);

    const atNoon = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12, 0, 0, 0);
    assert('AB @ 12:00 (baseline, non-boundary hour)', runAB(atNoon) === 1, `countable=${runAB(atNoon)}`);

    const atRealNow = new Date();
    assert('AB @ actual current instant', runAB(atRealNow) === 1, `countable=${runAB(atRealNow)}`);

    // ── V: create a real connected pair, exercise the exact fixed
    // create(future)->deactivate->backdate->sync sequence, confirm no
    // missed row is ever written -- with no window in which the
    // reminder was ever both active and overdue.
    const orgEmail = `${EMAIL_PREFIX}.verifyabv-org.${RAND}@example.com`;
    const recEmail = `${EMAIL_PREFIX}.verifyabv-rec.${RAND}@example.com`;
    const orgClient = newClient();
    const { data: orgData, error: orgErr } = await orgClient.auth.signUp({ email: orgEmail, password: PASSWORD, options: { data: { audit_account: true } } });
    if (orgErr || !orgData.user) throw new Error(`org signup failed: ${orgErr?.message}`);
    const recClient = newClient();
    const { data: recData, error: recErr } = await recClient.auth.signUp({ email: recEmail, password: PASSWORD, options: { data: { audit_account: true } } });
    if (recErr || !recData.user) throw new Error(`recipient signup failed: ${recErr?.message}`);
    await recClient.from('profiles').update({ role: 'recipient', timezone: 'UTC' }).eq('id', recData.user.id);

    const ids = [orgData.user.id, recData.user.id];
    installCrashSafety(async () => { scopedCleanup(ids); });

    const { data: invite } = await orgClient.rpc('create_invite_code', { p_existing_connection_id: null }).maybeSingle() as { data: { id: string; invite_code: string } | null; error: any } as any;
    await recClient.rpc('accept_invite_code', { p_code: invite.invite_code });
    const connId = invite.id as string;

    const futureUtcTime = `${String(new Date(Date.now() + 60 * 60000).getUTCHours()).padStart(2, '0')}:${String(new Date(Date.now() + 60 * 60000).getUTCMinutes()).padStart(2, '0')}:00`;
    const rows = dbQuery(`
      insert into public.reminders (connection_id, caregiver_id, recipient_id, title, time_of_day, days_of_week, no_response_minutes, is_active, created_at, updated_at)
      values ('${connId}', '${orgData.user.id}', '${recData.user.id}', 'AB/V verify', '${futureUtcTime}', ARRAY[1,2,3,4,5,6,7], 1, true, now() - interval '1 day', now())
      returning id;
    `) as { id: string }[];
    const reminderV = rows[0].id;
    dbQuery(`update public.reminders set is_active = false where id = '${reminderV}';`);
    dbQuery(`update public.reminders set time_of_day = ((now() - interval '30 minutes') at time zone 'UTC')::time where id = '${reminderV}';`);
    dbQuery(`select public.sync_missed_reminders_db();`);
    const logRows = dbQuery(`select status from public.reminder_logs where reminder_id = '${reminderV}';`) as { status: string }[];
    assert('V — a deactivated reminder never gets a missed row written for it', logRows.length === 0, `rows=${logRows.length}`);

    scopedCleanup(ids);

    console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error('VERIFY_AB_V_FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
});
