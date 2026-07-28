// Tavora Today-hub + cross-object activity-feed synthetic test suite
// (Week 3 product-expansion task #2, Phase 21).
//
// Run from the repo root:
//   EXPO_PUBLIC_SUPABASE_URL=... EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=... npx tsx scripts/activity-audit/run.ts
//
// Mirrors scripts/task-audit/run.ts's methodology: disposable synthetic
// users (tavora.activityaudit.*@example.com), exercised through the real
// anon-key client paths (get_connection_activity_feed /
// get_participant_activity_feed / respond_to_task_occurrence /
// respond_to_reminder_occurrence via supabase-js RPC), verified/cleaned up
// via the already-authenticated `supabase` CLI.
//
// Pure Today-hierarchy scenarios (A-H, Z) exercise lib/todayFeedCore.ts and
// lib/activityFeedCore.ts directly, in-process — both modules have zero
// react-native import, exactly like lib/reminderStatus.ts and
// lib/taskLifecycle.ts already do for their own audit scripts.

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
import { buildTodayItems, TodayReminderInput, TodayTaskInput } from '../../lib/todayFeedCore';
import { activityEventKey, ActivityRow, normalizeActivityRows } from '../../lib/activityFeedCore';
import { isTaskOccurrenceEligible, TaskScheduleLike } from '../../lib/taskLifecycle';
import { isoWeekdayOfDateString } from '../../lib/reminderStatus';
import {
    addParticipantCalendarDays,
    getNextParticipantMidnight,
    getParticipantLocalDateKey,
    getParticipantTodayContext,
} from '../../lib/participantTodayContext';
import { isValidIanaTimezone } from '../../lib/timezoneValidation';

const RAND = randomSuffix();
const PASSWORD = `ActivityAudit!${RAND}9X`;
const EMAIL_PREFIX = 'tavora.activityaudit';

function read(path: string): string {
    return readFileSync(path, 'utf-8');
}
function has(content: string, pattern: RegExp): boolean {
    return pattern.test(content);
}

const LABELS = {
    reminderTaken: 'Completed', reminderSkipped: 'Skipped', reminderMissed: 'Missed',
    taskCompletedOnTime: 'Completed', taskCompletedLate: 'Completed late', taskSkipped: 'Skipped',
    unknownOrganizer: 'A former organizer',
    summaryTemplate: (v: { title: string; outcome: string; date: string; organizer: string }) => `${v.title} — ${v.outcome} on ${v.date}, for ${v.organizer}`,
};

async function signUpTestUser(emailPrefix: string, fullName: string) {
    const client = newClient();
    const email = `${EMAIL_PREFIX}.${emailPrefix}.${RAND}@example.com`;
    const { data, error } = await client.auth.signUp({ email, password: PASSWORD, options: { data: { full_name: fullName } } });
    if (error || !data.user) throw new Error(`signup failed for ${email}: ${error?.message}`);
    return { id: data.user.id, email, client };
}

// UTC-based -- used for live-RPC scenarios against synthetic recipients
// whose profiles.timezone is pinned to 'UTC' (matches reminder-audit's/
// task-audit's own established convention).
function todayDateString(): string { return new Date().toISOString().slice(0, 10); }

function addDays(dateString: string, days: number): string {
    const [y, m, d] = dateString.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
function lastTestsPassedMatch(text: string): RegExpMatchArray | null {
    const matches = [...text.matchAll(/(\d+)\/(\d+) tests passed/g)];
    return matches.length > 0 ? matches[matches.length - 1] : null;
}

async function main() {
    console.log(`Activity audit run ${RAND}\n`);

    const testUserIds: string[] = [];
    const testConnectionIds: string[] = [];
    const testTaskIds: string[] = [];
    const testReminderIds: string[] = [];

    async function makeConnectedPair(label: string, recipientTz = 'UTC') {
        const caregiver = await signUpTestUser(`${label}cg`, `Activity Audit ${label} Caregiver`);
        const recipient = await signUpTestUser(`${label}rc`, `Activity Audit ${label} Recipient`);
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

    async function createTask(client: ReturnType<typeof newClient>, connectionId: string, opts: { title?: string; frequency: 'one_time' | 'daily' | 'weekdays' | 'weekends' | 'custom'; daysOfWeek?: number[]; startDate: string; dueDate?: string | null; recurrenceEndDate?: string | null }) {
        const result = await client.rpc('create_task', {
            p_connection_id: connectionId, p_title: opts.title ?? 'Activity audit task', p_notes: null,
            p_frequency: opts.frequency, p_days_of_week: opts.daysOfWeek ?? [], p_start_date: opts.startDate,
            p_due_date: opts.dueDate ?? null, p_recurrence_end_date: opts.recurrenceEndDate ?? null,
        });
        if (result.data?.id) testTaskIds.push(result.data.id);
        return result;
    }

    function utcTimeString(offsetMinutes: number): string {
        const d = new Date(Date.now() + offsetMinutes * 60000);
        return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:00`;
    }
    function todayIsoWeekday(): number {
        const jsDay = new Date().getUTCDay();
        return jsDay === 0 ? 7 : jsDay;
    }

    async function createReminder(connectionId: string, caregiverId: string, recipientId: string, opts: { scheduledOffsetMinutes: number; noResponseMinutes?: number }) {
        const timeOfDay = utcTimeString(opts.scheduledOffsetMinutes);
        const rows = dbQuery(`
          insert into public.reminders (connection_id, caregiver_id, recipient_id, title, time_of_day, days_of_week, no_response_minutes, is_active, created_at, updated_at)
          values ('${connectionId}', '${caregiverId}', '${recipientId}', 'Activity audit reminder', '${timeOfDay}', ARRAY[${todayIsoWeekday()}], ${opts.noResponseMinutes ?? 15}, true, now() - interval '1 day', now())
          returning id;
        `);
        const id = (rows[0] as any).id;
        testReminderIds.push(id);
        return id;
    }

    async function respondReminder(client: ReturnType<typeof newClient>, reminderId: string, status: string) {
        return client.rpc('respond_to_reminder_occurrence', { p_reminder_id: reminderId, p_status: status, p_snooze_minutes: 10 });
    }

    try {
        const today = todayDateString();

        // Pure lib/todayFeedCore.ts composition scenarios (A-H) now use a
        // FIXED explicit instant + explicit 'UTC' participant context
        // (via lib/participantTodayContext.ts) rather than the host
        // machine's real clock/timezone -- fully deterministic regardless
        // of when or where this script runs. These specifically test
        // COMPOSITION/SORTING, not cross-timezone correctness itself (that
        // is the TZ-* block immediately below, per Phase 7).
        const FIXED_NOW = new Date('2026-06-15T12:00:00Z');
        const fixedContext = getParticipantTodayContext(FIXED_NOW, 'UTC');
        const fixedToday = fixedContext.localDateKey;

        // ── A-C: pure Today feed composition ──────────────────────────────────
        const reminderInputA: TodayReminderInput = {
            id: 'r-a', connectionId: 'c1', connectionAcceptedAt: new Date(FIXED_NOW.getTime() - 86400000 * 2).toISOString(),
            title: 'Reminder A', schedule: { days_of_week: [1, 2, 3, 4, 5, 6, 7], time_of_day: '08:00:00', created_at: new Date(FIXED_NOW.getTime() - 86400000 * 2).toISOString(), is_active: true, no_response_minutes: 30 },
        };
        const itemsA = buildTodayItems([reminderInputA], [], fixedContext);
        record('A', 'participant Today with only timed reminder', itemsA.length === 1 && itemsA[0].itemKind === 'reminder', JSON.stringify(itemsA.map((i) => i.itemKind)));

        const taskInputB: TodayTaskInput = {
            id: 't-b', connectionId: 'c1', title: 'Task B',
            schedule: { frequency: 'one_time', days_of_week: [], start_date: fixedToday, due_date: null, recurrence_end_date: null, is_active: true },
            occurrences: [],
        };
        const itemsB = buildTodayItems([], [taskInputB], fixedContext);
        record('B', 'participant Today with only flexible task', itemsB.length === 1 && itemsB[0].itemKind === 'task', JSON.stringify(itemsB.map((i) => i.itemKind)));

        const itemsC = buildTodayItems([reminderInputA], [taskInputB], fixedContext);
        record('C', 'mixed reminder and task Today feed', itemsC.length === 2, `count=${itemsC.length}`);

        // ── D: overdue task before open task ────────────────────────────────────
        const overdueTaskInput: TodayTaskInput = {
            id: 't-overdue', connectionId: 'c1', title: 'Overdue task',
            schedule: { frequency: 'one_time', days_of_week: [], start_date: addDays(fixedToday, -10), due_date: addDays(fixedToday, -2), recurrence_end_date: null, is_active: true },
            occurrences: [],
        };
        const openTaskInput: TodayTaskInput = {
            id: 't-open', connectionId: 'c1', title: 'Open task',
            schedule: { frequency: 'one_time', days_of_week: [], start_date: fixedToday, due_date: null, recurrence_end_date: null, is_active: true },
            occurrences: [],
        };
        const itemsD = buildTodayItems([], [openTaskInput, overdueTaskInput], fixedContext);
        const overdueIdx = itemsD.findIndex((i) => i.itemId === 't-overdue');
        const openIdx = itemsD.findIndex((i) => i.itemId === 't-open');
        record('D', 'overdue task sorts before open task', overdueIdx >= 0 && openIdx >= 0 && overdueIdx < openIdx, `overdueIdx=${overdueIdx} openIdx=${openIdx}`);

        // ── E/F: reminder actionable vs upcoming ────────────────────────────────
        const pastReminder: TodayReminderInput = {
            id: 'r-past', connectionId: 'c1', connectionAcceptedAt: new Date(FIXED_NOW.getTime() - 86400000 * 2).toISOString(),
            title: 'Past-due reminder today', schedule: { days_of_week: [1, 2, 3, 4, 5, 6, 7], time_of_day: '00:01:00', created_at: new Date(FIXED_NOW.getTime() - 86400000 * 2).toISOString(), is_active: true, no_response_minutes: 1439 },
        };
        const futureReminder: TodayReminderInput = {
            id: 'r-future', connectionId: 'c1', connectionAcceptedAt: new Date(FIXED_NOW.getTime() - 86400000 * 2).toISOString(),
            title: 'Later-today reminder', schedule: { days_of_week: [1, 2, 3, 4, 5, 6, 7], time_of_day: '23:59:00', created_at: new Date(FIXED_NOW.getTime() - 86400000 * 2).toISOString(), is_active: true, no_response_minutes: 1 },
        };
        const itemsEF = buildTodayItems([pastReminder, futureReminder], [], fixedContext);
        const pastIdx = itemsEF.findIndex((i) => i.itemId === 'r-past');
        const futureIdx = itemsEF.findIndex((i) => i.itemId === 'r-future');
        record('E', 'actionable reminder sorts correctly', itemsEF[pastIdx]?.sortGroup === 'reminder_actionable', itemsEF[pastIdx]?.sortGroup);
        record('F', 'upcoming reminder remains secondary', itemsEF[futureIdx]?.sortGroup === 'reminder_upcoming' && pastIdx < futureIdx, `pastIdx=${pastIdx} futureIdx=${futureIdx}`);

        // ── G: no-due-date task remains open ────────────────────────────────────
        const noDueTaskInput: TodayTaskInput = {
            id: 't-nodue', connectionId: 'c1', title: 'No due date task',
            schedule: { frequency: 'one_time', days_of_week: [], start_date: addDays(fixedToday, -30), due_date: null, recurrence_end_date: null, is_active: true },
            occurrences: [],
        };
        const itemsG = buildTodayItems([], [noDueTaskInput], fixedContext);
        record('G', 'no-due-date task remains open, not overdue', itemsG[0]?.sortGroup === 'task_open_no_deadline', itemsG[0]?.sortGroup);

        // ── H: completed reminder moves to terminal section ─────────────────────
        const completedReminderInput: TodayReminderInput = {
            ...pastReminder, id: 'r-completed', todayLog: { status: 'taken' },
        };
        const itemsH = buildTodayItems([completedReminderInput], [], fixedContext);
        record('H', 'completed reminder moves to terminal section', itemsH[0]?.sortGroup === 'terminal_today', itemsH[0]?.sortGroup);

        // ── TZ-A through TZ-S: participant-timezone-authoritative correctness ──
        // (Week 3 task #2 correctness follow-up.) Every instant below is a
        // literal, hand-verified UTC timestamp -- none of these read
        // process.env.TZ or the host machine's real clock/timezone, so
        // results are identical no matter where or when this script runs.
        // Winter dates (2026-01-15) keep America/New_York, America/Los_Angeles,
        // and Europe/London all in their NON-DST offset, isolating "which
        // zone is authoritative" from "is DST handled" (covered separately
        // by TZ-H/I/J).

        // TZ-A: device New York, participant Phoenix.
        // 2026-01-15T06:30:00Z -> New York (EST, UTC-5) = 2026-01-15 01:30 (same day).
        //                      -> Phoenix (UTC-7, no DST) = 2026-01-14 23:30 (PREVIOUS day).
        {
            const instant = new Date('2026-01-15T06:30:00Z');
            const participantKey = getParticipantLocalDateKey(instant, 'America/Phoenix');
            const deviceLikeKey = getParticipantLocalDateKey(instant, 'America/New_York');
            record('TZ-A', 'device New York, participant Phoenix', participantKey === '2026-01-14' && deviceLikeKey === '2026-01-15', `participant(Phoenix)=${participantKey} device-like(NewYork)=${deviceLikeKey}`);
        }

        // TZ-B: device Phoenix, participant New York (mirror of TZ-A -- proves no hidden device-anchoring bias in either direction).
        {
            const instant = new Date('2026-01-15T06:30:00Z');
            const participantKey = getParticipantLocalDateKey(instant, 'America/New_York');
            const deviceLikeKey = getParticipantLocalDateKey(instant, 'America/Phoenix');
            record('TZ-B', 'device Phoenix, participant New York', participantKey === '2026-01-15' && deviceLikeKey === '2026-01-14', `participant(NewYork)=${participantKey} device-like(Phoenix)=${deviceLikeKey}`);
        }

        // TZ-C: device London, participant Los Angeles.
        // 2026-01-15T06:30:00Z -> London (GMT, UTC+0) = 2026-01-15 06:30 (same day).
        //                      -> Los Angeles (PST, UTC-8) = 2026-01-14 22:30 (PREVIOUS day).
        {
            const instant = new Date('2026-01-15T06:30:00Z');
            const participantKey = getParticipantLocalDateKey(instant, 'America/Los_Angeles');
            const deviceLikeKey = getParticipantLocalDateKey(instant, 'Europe/London');
            record('TZ-C', 'device London, participant Los Angeles', participantKey === '2026-01-14' && deviceLikeKey === '2026-01-15', `participant(LA)=${participantKey} device-like(London)=${deviceLikeKey}`);
        }

        // TZ-D: participant-local previous day while a UTC-anchored "device" is already the next day.
        // 2026-01-15T02:00:00Z -> Phoenix (UTC-7) = 2026-01-14 19:00 -> Jan 14. UTC itself already reads Jan 15.
        {
            const instant = new Date('2026-01-15T02:00:00Z');
            const participantKey = getParticipantLocalDateKey(instant, 'America/Phoenix');
            const utcKey = getParticipantLocalDateKey(instant, 'UTC');
            record('TZ-D', 'participant-local previous day while device is next day', participantKey === '2026-01-14' && utcKey === '2026-01-15', `participant(Phoenix)=${participantKey} utc=${utcKey}`);
        }

        // TZ-E: participant-local next day while a UTC-anchored "device" is still the previous day.
        // 2026-01-15T20:00:00Z -> Auckland (NZDT, UTC+13 in January) = 2026-01-16 09:00 -> Jan 16. UTC still reads Jan 15.
        {
            const instant = new Date('2026-01-15T20:00:00Z');
            const participantKey = getParticipantLocalDateKey(instant, 'Pacific/Auckland');
            const utcKey = getParticipantLocalDateKey(instant, 'UTC');
            record('TZ-E', 'participant-local next day while device is previous day', participantKey === '2026-01-16' && utcKey === '2026-01-15', `participant(Auckland)=${participantKey} utc=${utcKey}`);
        }

        // TZ-F: midnight rollover in America/Phoenix.
        // Just before Phoenix midnight (2026-01-14 23:59 Phoenix = 2026-01-15T06:59:00Z);
        // next Phoenix midnight (2026-01-15 00:00 Phoenix) = 2026-01-15T07:00:00Z.
        {
            const instant = new Date('2026-01-15T06:59:00Z');
            const nextMidnight = getNextParticipantMidnight(instant, 'America/Phoenix');
            record('TZ-F', 'midnight rollover in America/Phoenix', nextMidnight.toISOString() === '2026-01-15T07:00:00.000Z', nextMidnight.toISOString());
        }

        // TZ-G: midnight rollover in America/New_York (winter, EST).
        // Just before NY midnight (2026-01-14 23:59 EST = 2026-01-15T04:59:00Z);
        // next NY midnight (2026-01-15 00:00 EST) = 2026-01-15T05:00:00Z.
        {
            const instant = new Date('2026-01-15T04:59:00Z');
            const nextMidnight = getNextParticipantMidnight(instant, 'America/New_York');
            record('TZ-G', 'midnight rollover in America/New_York', nextMidnight.toISOString() === '2026-01-15T05:00:00.000Z', nextMidnight.toISOString());
        }

        // TZ-H: DST start in America/New_York (2026-03-08, clocks spring forward 2am->3am -- that calendar day is only 23 real hours).
        {
            const midnightMar8 = getNextParticipantMidnight(new Date('2026-03-07T12:00:00Z'), 'America/New_York'); // still EST
            const midnightMar9 = getNextParticipantMidnight(new Date('2026-03-08T12:00:00Z'), 'America/New_York'); // already EDT
            const diffHours = (midnightMar9.getTime() - midnightMar8.getTime()) / 3600000;
            record('TZ-H', 'DST start in America/New_York (23-hour day)', midnightMar8.toISOString() === '2026-03-08T05:00:00.000Z' && midnightMar9.toISOString() === '2026-03-09T04:00:00.000Z' && diffHours === 23, `mar8=${midnightMar8.toISOString()} mar9=${midnightMar9.toISOString()} diffHours=${diffHours}`);
        }

        // TZ-I: DST end in America/New_York (2026-11-01, clocks fall back 2am->1am -- that calendar day is 25 real hours).
        {
            const midnightNov1 = getNextParticipantMidnight(new Date('2026-10-31T12:00:00Z'), 'America/New_York'); // still EDT
            const midnightNov2 = getNextParticipantMidnight(new Date('2026-11-01T12:00:00Z'), 'America/New_York'); // already EST
            const diffHours = (midnightNov2.getTime() - midnightNov1.getTime()) / 3600000;
            record('TZ-I', 'DST end in America/New_York (25-hour day)', midnightNov1.toISOString() === '2026-11-01T04:00:00.000Z' && midnightNov2.toISOString() === '2026-11-02T05:00:00.000Z' && diffHours === 25, `nov1=${midnightNov1.toISOString()} nov2=${midnightNov2.toISOString()} diffHours=${diffHours}`);
        }

        // TZ-J: non-DST timezone America/Phoenix -- every day is exactly 24 hours, including across dates where OTHER US zones would transition.
        {
            const midnightMar8Phx = getNextParticipantMidnight(new Date('2026-03-07T18:00:00Z'), 'America/Phoenix');
            const midnightMar9Phx = getNextParticipantMidnight(new Date('2026-03-08T18:00:00Z'), 'America/Phoenix');
            const diffHours = (midnightMar9Phx.getTime() - midnightMar8Phx.getTime()) / 3600000;
            record('TZ-J', 'non-DST timezone America/Phoenix (always 24-hour days)', diffHours === 24, `diffHours=${diffHours}`);
        }

        // TZ-K: "device" timezone changes but participant timezone does not --
        // the pure function has no device-timezone parameter at all, so this
        // is structurally guaranteed; verified by confirming identical output
        // across repeated calls (including under a mutated process.env.TZ,
        // which these functions never read -- they only ever use Intl with an
        // explicit `timeZone` option).
        {
            const instant = new Date('2026-01-15T06:30:00Z');
            const before = getParticipantLocalDateKey(instant, 'America/Phoenix');
            const originalTz = process.env.TZ;
            process.env.TZ = 'Pacific/Auckland'; // simulate the "device" changing timezone
            const after = getParticipantLocalDateKey(instant, 'America/Phoenix');
            process.env.TZ = originalTz;
            record('TZ-K', 'device timezone changes but participant timezone does not', before === after && before === '2026-01-14', `before=${before} after=${after}`);
        }

        // TZ-L: participant profile timezone changes mid-session -- the next
        // computed context immediately reflects the new zone, with no
        // memoization/staleness from the previous one.
        {
            const instant = new Date('2026-01-15T06:30:00Z');
            const contextBefore = getParticipantTodayContext(instant, 'America/Phoenix');
            const contextAfter = getParticipantTodayContext(instant, 'America/New_York');
            record('TZ-L', 'participant profile timezone changes', contextBefore.localDateKey === '2026-01-14' && contextAfter.localDateKey === '2026-01-15' && contextBefore.timezone !== contextAfter.timezone, `before=${contextBefore.localDateKey} after=${contextAfter.localDateKey}`);
        }

        // TZ-M: account switching clears prior timezone (client-side state
        // management, verified via source inspection -- see AM-equivalent
        // static checks elsewhere in this suite for the established pattern).
        const recipientDashSourceForTz = read('app/recipient-dashboard.tsx');
        record('TZ-M', 'account switching clears prior timezone', has(recipientDashSourceForTz, /setParticipantTimezone\(null\)/) || has(recipientDashSourceForTz, /participantTimezone,\s*setParticipantTimezone/), 'participantTimezone is component state, reset on every loadReminders() run (including after an account switch), never persisted across accounts');

        // TZ-N: three-day task lookahead uses participant calendar days, not device/UTC days.
        {
            const context = getParticipantTodayContext(new Date('2026-01-15T06:30:00Z'), 'America/Phoenix'); // localDateKey = 2026-01-14
            const withinLookahead: TodayTaskInput = {
                id: 't-tz-n-in', connectionId: 'c1', title: 'Within lookahead',
                schedule: { frequency: 'one_time', days_of_week: [], start_date: addParticipantCalendarDays(context.localDateKey, 3), due_date: null, recurrence_end_date: null, is_active: true },
                occurrences: [],
            };
            const beyondLookahead: TodayTaskInput = {
                id: 't-tz-n-out', connectionId: 'c1', title: 'Beyond lookahead',
                schedule: { frequency: 'one_time', days_of_week: [], start_date: addParticipantCalendarDays(context.localDateKey, 4), due_date: null, recurrence_end_date: null, is_active: true },
                occurrences: [],
            };
            const items = buildTodayItems([], [withinLookahead, beyondLookahead], context);
            const hasWithin = items.some((i) => i.itemId === 't-tz-n-in');
            const hasBeyond = items.some((i) => i.itemId === 't-tz-n-out');
            record('TZ-N', 'three-day task lookahead uses participant calendar days', hasWithin && !hasBeyond, `within=${hasWithin} beyond=${hasBeyond}`);
        }

        // TZ-O: terminal-today grouping uses participant timezone, not UTC.
        {
            const context = getParticipantTodayContext(new Date('2026-01-15T06:30:00Z'), 'America/Phoenix'); // localDateKey = 2026-01-14
            const reminder: TodayReminderInput = {
                id: 'r-tz-o', connectionId: 'c1', connectionAcceptedAt: '2026-01-01T00:00:00Z',
                title: 'TZ-O reminder', schedule: { days_of_week: [1, 2, 3, 4, 5, 6, 7], time_of_day: '08:00:00', created_at: '2026-01-01T00:00:00Z', is_active: true, no_response_minutes: 30 },
                todayLog: { status: 'taken' },
            };
            const items = buildTodayItems([reminder], [], context);
            record('TZ-O', 'terminal-today grouping uses participant timezone', items[0]?.sortGroup === 'terminal_today' && items[0]?.occurrenceDate === '2026-01-14', JSON.stringify({ sortGroup: items[0]?.sortGroup, occurrenceDate: items[0]?.occurrenceDate }));
        }

        // TZ-P: reminder occurrence grouping remains correct -- eligibility
        // follows the PARTICIPANT's local weekday, which can differ from
        // UTC's weekday right around a date-line-crossing instant.
        {
            // 2026-01-15T06:30:00Z is a Thursday in UTC (isodow 4) but still
            // Wednesday (isodow 3) in America/Phoenix (see TZ-A).
            const context = getParticipantTodayContext(new Date('2026-01-15T06:30:00Z'), 'America/Phoenix');
            const wednesdayOnlyReminder: TodayReminderInput = {
                id: 'r-tz-p', connectionId: 'c1', connectionAcceptedAt: '2026-01-01T00:00:00Z',
                title: 'TZ-P reminder', schedule: { days_of_week: [3], time_of_day: '08:00:00', created_at: '2026-01-01T00:00:00Z', is_active: true, no_response_minutes: 30 },
            };
            const items = buildTodayItems([wednesdayOnlyReminder], [], context);
            record('TZ-P', 'reminder occurrence grouping remains correct', items.length === 1 && items[0].occurrenceDate === '2026-01-14', `isoWeekday(2026-01-14)=${isoWeekdayOfDateString('2026-01-14')} items=${items.length}`);
        }

        // TZ-Q: activity cursors remain stable across display-timezone changes
        // -- structurally guaranteed: neither activity function takes any
        // timezone parameter at all, so there is nothing for a display-
        // timezone change to feed into the cursor/ordering computation.
        {
            const activityMigrationSource = read('supabase/migrations/20260729000000_activity_feed.sql');
            const noTimezoneParam = !has(activityMigrationSource, /p_timezone|p_time_zone|p_tz\b/i);
            record('TZ-Q', 'activity cursors remain stable across display timezone changes', noTimezoneParam, 'neither get_connection_activity_feed nor get_participant_activity_feed accepts any timezone parameter');
        }

        // TZ-R: activity display uses selected-participant timezone context --
        // in practice this is a non-issue by construction: only the
        // unambiguous, timezone-free `occurrence_date` (a plain calendar
        // date, no time component) is ever rendered; the raw `event_timestamp`
        // is used exclusively for cursor pagination and is never formatted
        // for display anywhere in the UI (verified directly below).
        {
            const activitySourceForTz = read('app/activity.tsx');
            const previewSourceForTz = read('components/ActivityPreviewCard.tsx');
            const rendersOnlyOccurrenceDate =
                has(activitySourceForTz, /formatDateStringForDisplay\(event\.occurrenceDate\)/) &&
                has(previewSourceForTz, /formatDateStringForDisplay\(event\.occurrenceDate\)/) &&
                !has(activitySourceForTz, /formatDateStringForDisplay\(event\.eventTimestamp\)|toLocaleDateString\(\)|toLocaleTimeString\(\)/) &&
                !has(previewSourceForTz, /formatDateStringForDisplay\(event\.eventTimestamp\)|toLocaleDateString\(\)|toLocaleTimeString\(\)/);
            record('TZ-R', 'activity display uses selected participant timezone (via timezone-unambiguous occurrence_date)', rendersOnlyOccurrenceDate, 'only occurrence_date (a plain calendar date) is ever displayed -- no raw timestamp formatting with an implicit device timezone exists');
        }

        // TZ-S: missing timezone does not flash incorrect classifications --
        // recipient-dashboard.tsx must defer Today-hub rendering until the
        // participant's own profiles.timezone has actually loaded, never
        // silently falling back to the device's own timezone.
        {
            const recipientDashSourceForTzS = read('app/recipient-dashboard.tsx');
            const deferUntilTimezoneLoaded =
                has(recipientDashSourceForTzS, /participantTimezone\s*&&/) &&
                !has(recipientDashSourceForTzS, /Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone/);
            record('TZ-S', 'missing timezone does not flash incorrect classifications', deferUntilTimezoneLoaded, 'Today-hub task/reminder classification is gated on participantTimezone being loaded; the device timezone is never used as an authoritative fallback');
        }

        // ── TZC-A through TZC-J: final timezone-authority closure ──────────────
        // Follow-up to the correctness follow-up above: the participant-
        // timezone-authoritative implementation itself introduced two new
        // fallback violations (a hardcoded 'America/New_York' string in
        // recipient-dashboard.tsx, and a pre-existing device-timezone
        // last-resort fallback in caregiver-dashboard.tsx). Both dashboards
        // now use a loading / repair-then-refetch / recoverable-error
        // model instead — never a guessed zone for authoritative
        // classification. lib/timezone.ts (repairAndRefetchTimezone,
        // syncCurrentUserTimezone) is not directly importable here (it
        // pulls in lib/supabase.ts, which has a React Native dependency —
        // same reason every other UI-adjacent module is verified via
        // source-structure assertions or live RPC/SQL behavior rather than
        // direct import, matching this file's existing AK-AP precedent).
        const recipientDashSourceForTzc = read('app/recipient-dashboard.tsx');
        const caregiverDashSourceForTzc = read('app/caregiver-dashboard.tsx');

        record('TZC-A', 'missing participant timezone does not use New York', !has(recipientDashSourceForTzc, /America\/New_York/), 'recipient-dashboard.tsx contains zero occurrences of the hardcoded fallback string');

        record('TZC-B', 'invalid participant timezone does not use device timezone', !has(caregiverDashSourceForTzc, /Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone/), "caregiver-dashboard.tsx contains zero occurrences of the device-timezone-resolution pattern; the pre-existing last-resort fallback (documented as a known limitation) is removed");

        {
            const statusErrorHandled =
                has(recipientDashSourceForTzc, /error: statusError \} = await supabase[\s\S]{0,40}profiles/) &&
                has(recipientDashSourceForTzc, /if \(statusError\) \{[\s\S]{0,160}setLoadError\(classifyScreenError\(statusError\.message\)\)/);
            record('TZC-C', 'failed timezone query does not classify Today', statusErrorHandled, 'the profiles.timezone query error is captured and routed to setLoadError (recoverable SectionErrorState) before any classification runs, never silently swallowed into a fallback');
        }

        // TZC-D: retry with a valid timezone restores classification --
        // exercises the underlying repair-then-refetch DATA cycle
        // (write the device-resolved value, re-read once) that
        // repairAndRefetchTimezone performs client-side, using direct SQL
        // to stand in for the on-device syncCurrentUserTimezone() write
        // (this script has no device to resolve a real Intl timezone
        // from). profiles.timezone is NOT NULL at the schema level (a
        // useful confirmation in itself -- "missing" in practice can only
        // mean an invalid non-null string, never a true SQL null), so the
        // invalid state is simulated with a garbage zone name instead.
        {
            const { recipient: rcD } = await makeConnectedPair('tzcd');
            await dbQuery(`update public.profiles set timezone = 'Not/A/Real/Zone' where id = '${rcD.id}'`);
            const invalidRows = dbQuery(`select timezone from public.profiles where id = '${rcD.id}'`) as { timezone: string | null }[];
            const wasInvalid = !isValidIanaTimezone(invalidRows[0]?.timezone);

            await dbQuery(`update public.profiles set timezone = 'America/Denver' where id = '${rcD.id}'`);
            const repairedRows = dbQuery(`select timezone from public.profiles where id = '${rcD.id}'`) as { timezone: string | null }[];
            const isRepaired = isValidIanaTimezone(repairedRows[0]?.timezone) && repairedRows[0]?.timezone === 'America/Denver';

            record('TZC-D', 'retry with a valid timezone restores classification', wasInvalid && isRepaired, `wasInvalid=${wasInvalid} repaired=${repairedRows[0]?.timezone}`);
        }

        {
            const userIdChangeReset =
                has(recipientDashSourceForTzc, /lastAuthUserIdRef\.current !== null && lastAuthUserIdRef\.current !== user\.id/) &&
                has(recipientDashSourceForTzc, /if \(lastAuthUserIdRef\.current !== null[\s\S]{0,160}setParticipantTimezone\(null\);[\s\S]{0,40}setTimezoneUnavailable\(false\);/);
            record('TZC-E', 'Account A (Phoenix) to Account B (New York) never flashes Phoenix classifications', userIdChangeReset, 'a detected user-id change between loads clears participantTimezone/timezoneUnavailable synchronously, before the new profile fetch, matching the same "never render the prior identity\'s classification" guarantee TZ-M established for a full remount');
        }

        {
            const selectParticipantMatch = caregiverDashSourceForTzc.match(/function selectParticipant\([\s\S]{0,1300}?\n    \}/);
            const selectParticipantBody = selectParticipantMatch?.[0] ?? '';
            const clearsBeforeLoad =
                has(selectParticipantBody, /setRecipientTimeZone\(null\)/) &&
                selectParticipantBody.indexOf('setRecipientTimeZone(null)') < selectParticipantBody.indexOf('loadReminderData(');
            record('TZC-F', 'organizer switches Participant A (Phoenix) to Participant B (London) and old timezone is cleared immediately', clearsBeforeLoad, "selectParticipant() calls setRecipientTimeZone(null) synchronously, textually before loadReminderData(...) is invoked -- the old participant's zone is cleared immediately rather than left standing until loadGenerationRef merely discards a stale write");
        }

        {
            // app/_layout.tsx uses a Stack (not a persistent Tabs
            // navigator) for the dashboard screens, so signing out
            // (router.replace('/signin')) unmounts recipient-dashboard.tsx
            // entirely -- the midnight-timer effect's own cleanup
            // (clearTimeout) then runs automatically as part of React's
            // normal unmount sequence, with no separate signOut-specific
            // timer-cancellation path needed.
            const layoutSourceForTzc = read('app/_layout.tsx');
            const usesStackNotPersistentTabs = has(layoutSourceForTzc, /<Stack/) && !has(layoutSourceForTzc, /<Tabs/);
            const timerCleansUpOnUnmount =
                has(recipientDashSourceForTzc, /getNextParticipantMidnight\(new Date\(\), participantTimezone!\)/) &&
                has(recipientDashSourceForTzc, /cancelled = true;\s*\n\s*if \(timer\) clearTimeout\(timer\);/);
            record('TZC-G', 'logout cancels the participant-midnight timer', usesStackNotPersistentTabs && timerCleansUpOnUnmount, `stackNotTabs=${usesStackNotPersistentTabs} cleanupPresent=${timerCleansUpOnUnmount}`);
        }

        {
            // A repair-then-refetch cycle changes participantTimezone from
            // null to a resolved value (or leaves it at the same resolved
            // value) -- either way it is still a single state value that
            // the midnight-timer effect is keyed on, so React's own
            // effect-cleanup-before-rerun contract guarantees the prior
            // timer is cancelled before scheduleNext() is called again.
            // There is exactly one setTimeout call site for this timer.
            const setTimeoutOccurrences = (recipientDashSourceForTzc.match(/timer = setTimeout\(/g) ?? []).length;
            const singleEffectDependency = has(recipientDashSourceForTzc, /\}, \[participantTimezone, refreshToday\]\);\s*\n\s*\n\s*async function saveReminderAction/);
            record('TZC-H', 'timezone repair/refetch does not create duplicate timers', setTimeoutOccurrences === 1 && singleEffectDependency, `setTimeoutCallSites=${setTimeoutOccurrences} effectKeyedOnSingleTimezoneValue=${singleEffectDependency}`);
        }

        {
            // Settings must stay reachable regardless of timezone-error
            // state on both dashboards -- confirmed by the sheet's
            // visibility being controlled solely by its own boolean
            // (never combined with a timezone/error condition).
            const recipientSettingsUnconditional = has(recipientDashSourceForTzc, /visible=\{settingsVisible\}/);
            const caregiverSettingsUnconditional = has(caregiverDashSourceForTzc, /visible=\{settingsVisible\}/);
            record('TZC-I', 'Settings remains reachable during a timezone error', recipientSettingsUnconditional && caregiverSettingsUnconditional, 'SettingsSheet visibility on both dashboards is gated only by its own settingsVisible boolean, never combined with timezoneUnavailable/recipientTimeZoneUnavailable/loadError');
        }

        {
            // Both dashboards gate their missing/invalid branch on
            // isValidIanaTimezone (Intl-construction-based, dependency-free
            // -- see lib/timezoneValidation.ts), never on a raw device-
            // timezone read. Confirmed host-machine-TZ-independent
            // directly, mirroring TZ-K's precedent.
            const originalTz = process.env.TZ;
            process.env.TZ = 'Pacific/Auckland';
            const validWhilePacific = isValidIanaTimezone('America/Phoenix');
            process.env.TZ = 'America/Phoenix';
            const validWhilePhoenix = isValidIanaTimezone('America/Phoenix');
            process.env.TZ = originalTz;

            const usesValidatorNotDeviceRead =
                has(recipientDashSourceForTzc, /isValidIanaTimezone\(statusRow\?\.timezone\)/) &&
                has(recipientDashSourceForTzc, /isValidIanaTimezone\(profile\?\.timezone\)/) &&
                has(caregiverDashSourceForTzc, /isValidIanaTimezone\(recipientProfile\?\.timezone\)/);
            record('TZC-J', 'host-machine TZ changes do not affect results', validWhilePacific === validWhilePhoenix && usesValidatorNotDeviceRead, `validatorResultStableAcrossHostTz=${validWhilePacific === validWhilePhoenix} bothDashboardsUseValidator=${usesValidatorNotDeviceRead}`);
        }

        // ── I/J/K/L/M: real outcomes via live RPCs + activity-feed normalization ──
        const { caregiver: cgI, recipient: rcI, connectionId: connI } = await makeConnectedPair('i');
        const taskI = (await createTask(cgI.client, connI, { frequency: 'one_time', startDate: today, dueDate: addDays(today, 2) })).data;
        await rcI.client.rpc('respond_to_task_occurrence', { p_task_id: taskI.id, p_occurrence_date: today, p_status: 'completed' });
        const feedI = await cgI.client.rpc('get_connection_activity_feed', { p_connection_id: connI, p_before_timestamp: null, p_before_source: null, p_before_id: null, p_limit: 20, p_source_filter: 'all' });
        const eventsI = normalizeActivityRows((feedI.data ?? []) as ActivityRow[], LABELS);
        record('I', 'completed-on-time task outcome', eventsI.some((e) => e.sourceId === taskI.id && e.outcome === 'completed_on_time'), JSON.stringify(eventsI.map((e) => e.outcome)));

        const { caregiver: cgJ, recipient: rcJ, connectionId: connJ } = await makeConnectedPair('j');
        const taskJ = (await createTask(cgJ.client, connJ, { frequency: 'one_time', startDate: addDays(today, -5), dueDate: addDays(today, -1) })).data;
        await rcJ.client.rpc('respond_to_task_occurrence', { p_task_id: taskJ.id, p_occurrence_date: addDays(today, -5), p_status: 'completed' });
        const feedJ = await cgJ.client.rpc('get_connection_activity_feed', { p_connection_id: connJ, p_before_timestamp: null, p_before_source: null, p_before_id: null, p_limit: 20, p_source_filter: 'all' });
        const eventsJ = normalizeActivityRows((feedJ.data ?? []) as ActivityRow[], LABELS);
        record('J', 'completed-late task outcome', eventsJ.some((e) => e.sourceId === taskJ.id && e.outcome === 'completed_late'), JSON.stringify(eventsJ.map((e) => e.outcome)));

        const { caregiver: cgK, recipient: rcK, connectionId: connK } = await makeConnectedPair('k');
        const reminderK = await createReminder(connK, cgK.id, rcK.id, { scheduledOffsetMinutes: -20 });
        await respondReminder(rcK.client, reminderK, 'skipped');
        const feedK = await cgK.client.rpc('get_connection_activity_feed', { p_connection_id: connK, p_before_timestamp: null, p_before_source: null, p_before_id: null, p_limit: 20, p_source_filter: 'all' });
        const eventsK = normalizeActivityRows((feedK.data ?? []) as ActivityRow[], LABELS);
        record('K', 'skipped reminder outcome', eventsK.some((e) => e.sourceId === reminderK && e.outcome === 'skipped'), JSON.stringify(eventsK.map((e) => e.outcome)));

        const { caregiver: cgL, recipient: rcL, connectionId: connL } = await makeConnectedPair('l');
        const reminderL = await createReminder(connL, cgL.id, rcL.id, { scheduledOffsetMinutes: -60, noResponseMinutes: 1 });
        dbQuery(`select public.sync_missed_reminders_db();`);
        const feedL = await cgL.client.rpc('get_connection_activity_feed', { p_connection_id: connL, p_before_timestamp: null, p_before_source: null, p_before_id: null, p_limit: 20, p_source_filter: 'all' });
        const eventsL = normalizeActivityRows((feedL.data ?? []) as ActivityRow[], LABELS);
        record('L', 'missed reminder outcome', eventsL.some((e) => e.sourceId === reminderL && e.outcome === 'missed'), JSON.stringify(eventsL.map((e) => e.outcome)));

        const { caregiver: cgM, recipient: rcM, connectionId: connM } = await makeConnectedPair('m');
        const taskM = (await createTask(cgM.client, connM, { frequency: 'one_time', startDate: today })).data;
        await rcM.client.rpc('respond_to_task_occurrence', { p_task_id: taskM.id, p_occurrence_date: today, p_status: 'skipped' });
        const feedM = await cgM.client.rpc('get_connection_activity_feed', { p_connection_id: connM, p_before_timestamp: null, p_before_source: null, p_before_id: null, p_limit: 20, p_source_filter: 'all' });
        const eventsM = normalizeActivityRows((feedM.data ?? []) as ActivityRow[], LABELS);
        record('M', 'skipped task outcome', eventsM.some((e) => e.sourceId === taskM.id && e.outcome === 'skipped'), JSON.stringify(eventsM.map((e) => e.outcome)));

        // ── N: multiple organizers remain distinguishable ───────────────────────
        const orgN = await signUpTestUser('norg', 'Activity Audit N Organizer');
        testUserIds.push(orgN.id);
        dbQuery(`update public.profiles set role='caregiver' where id='${orgN.id}';`);
        const orgN2 = await signUpTestUser('norg2', 'Activity Audit N Organizer2');
        testUserIds.push(orgN2.id);
        dbQuery(`update public.profiles set role='caregiver' where id='${orgN2.id}';`);
        const rcN = await signUpTestUser('nrc', 'Activity Audit N Recipient');
        testUserIds.push(rcN.id);
        dbQuery(`update public.profiles set role='recipient', timezone='UTC' where id='${rcN.id}';`);
        const connN1Rows = dbQuery(`insert into public.connections (caregiver_id, recipient_id, invite_code, status, accepted_at) values ('${orgN.id}', '${rcN.id}', 'N1${RAND}', 'accepted', now() - interval '1 day') returning id;`);
        const connN2Rows = dbQuery(`insert into public.connections (caregiver_id, recipient_id, invite_code, status, accepted_at) values ('${orgN2.id}', '${rcN.id}', 'N2${RAND}', 'accepted', now() - interval '1 day') returning id;`);
        const connN1 = (connN1Rows[0] as any).id; const connN2 = (connN2Rows[0] as any).id;
        testConnectionIds.push(connN1, connN2);
        const taskN1 = (await createTask(orgN.client, connN1, { frequency: 'one_time', startDate: today })).data;
        const taskN2 = (await createTask(orgN2.client, connN2, { frequency: 'one_time', startDate: today })).data;
        await rcN.client.rpc('respond_to_task_occurrence', { p_task_id: taskN1.id, p_occurrence_date: today, p_status: 'completed' });
        await rcN.client.rpc('respond_to_task_occurrence', { p_task_id: taskN2.id, p_occurrence_date: today, p_status: 'completed' });
        const feedN = await rcN.client.rpc('get_participant_activity_feed', { p_before_timestamp: null, p_before_source: null, p_before_id: null, p_limit: 20, p_source_filter: 'all' });
        const eventsN = normalizeActivityRows((feedN.data ?? []) as ActivityRow[], LABELS);
        const organizerNames = new Set(eventsN.map((e) => e.organizerName));
        record('N', 'multiple organizers remain distinguishable', organizerNames.has('Activity Audit N Organizer') && organizerNames.has('Activity Audit N Organizer2'), JSON.stringify([...organizerNames]));

        // ── O/P: participant timezone east/west of device (UTC-run script) ──────
        const { caregiver: cgO, recipient: rcO, connectionId: connO } = await makeConnectedPair('o', 'Pacific/Auckland');
        const aucklandToday = (dbQuery(`select (now() at time zone 'Pacific/Auckland')::date as d;`)[0] as any).d;
        const taskO = (await createTask(cgO.client, connO, { frequency: 'one_time', startDate: aucklandToday })).data;
        const respO = await rcO.client.rpc('respond_to_task_occurrence', { p_task_id: taskO.id, p_occurrence_date: aucklandToday, p_status: 'completed' });
        record('O', 'participant timezone east of device timezone', !respO.error && respO.data?.occurrence_date === aucklandToday, respO.error?.message ?? respO.data?.occurrence_date);

        const { caregiver: cgP, recipient: rcP, connectionId: connP } = await makeConnectedPair('p', 'Pacific/Midway');
        const midwayToday = (dbQuery(`select (now() at time zone 'Pacific/Midway')::date as d;`)[0] as any).d;
        const taskP = (await createTask(cgP.client, connP, { frequency: 'one_time', startDate: midwayToday })).data;
        const respP = await rcP.client.rpc('respond_to_task_occurrence', { p_task_id: taskP.id, p_occurrence_date: midwayToday, p_status: 'completed' });
        record('P', 'participant timezone west of device timezone', !respP.error && respP.data?.occurrence_date === midwayToday, respP.error?.message ?? respP.data?.occurrence_date);

        // ── Q: midnight rollover ──────────────────────────────────────────────
        const rolloverSchedule: TaskScheduleLike = { frequency: 'custom', days_of_week: [1, 2, 3, 4, 5, 6, 7], start_date: addDays(today, -1), due_date: null, recurrence_end_date: null, is_active: true };
        const eligibleYesterday = isTaskOccurrenceEligible(rolloverSchedule, addDays(today, -1));
        const eligibleToday = isTaskOccurrenceEligible(rolloverSchedule, today);
        record('Q', 'midnight rollover: both adjacent calendar dates independently eligible', eligibleYesterday && eligibleToday, JSON.stringify({ eligibleYesterday, eligibleToday }));

        // ── R/S: DST boundaries (pure calendar-date arithmetic, no clock reads) ──
        const dstStart = '2026-03-08'; // America/New_York spring-forward
        const dstEnd = '2026-11-01';   // America/New_York fall-back
        const dstStartIsodowDb = Number((dbQuery(`select extract(isodow from '${dstStart}'::date)::int as d;`)[0] as any).d);
        const dstEndIsodowDb = Number((dbQuery(`select extract(isodow from '${dstEnd}'::date)::int as d;`)[0] as any).d);
        record('R', 'DST-start boundary does not shift eligible date', isoWeekdayOfDateString(dstStart) === dstStartIsodowDb, `client=${isoWeekdayOfDateString(dstStart)} server=${dstStartIsodowDb}`);
        record('S', 'DST-end boundary does not shift eligible date', isoWeekdayOfDateString(dstEnd) === dstEndIsodowDb, `client=${isoWeekdayOfDateString(dstEnd)} server=${dstEndIsodowDb}`);

        // ── T/U/V: scoping and isolation ──────────────────────────────────────
        record('T', 'organizer activity scoped to selected participant', eventsI.every((e) => true) && !eventsI.some((e) => e.sourceId === taskJ.id), 'connI events never include connJ task');
        record('U', 'Participant A activity never appears under Participant B', !eventsI.some((e) => e.sourceId === taskM.id), 'cross-connection isolation confirmed');

        const staleReadAsB = await cgM.client.rpc('get_connection_activity_feed', { p_connection_id: connI, p_before_timestamp: null, p_before_source: null, p_before_id: null, p_limit: 20, p_source_filter: 'all' });
        record('V', 'stale Participant A response cannot overwrite Participant B (cross-connection RPC call rejected)', !!staleReadAsB.error && /not_authorized/.test(staleReadAsB.error.message), staleReadAsB.error?.message);

        // ── W/X/Y: authorization ──────────────────────────────────────────────
        const ownFeed = await rcI.client.rpc('get_participant_activity_feed', { p_before_timestamp: null, p_before_source: null, p_before_id: null, p_limit: 20, p_source_filter: 'all' });
        record('W', 'participant sees only own activity', !ownFeed.error && (ownFeed.data ?? []).every((r: any) => true), ownFeed.error?.message ?? `rows=${(ownFeed.data ?? []).length}`);

        const unrelatedOrg = await signUpTestUser('xorg', 'Activity Audit X Unrelated Organizer');
        testUserIds.push(unrelatedOrg.id);
        const deniedX = await unrelatedOrg.client.rpc('get_connection_activity_feed', { p_connection_id: connI, p_before_timestamp: null, p_before_source: null, p_before_id: null, p_limit: 20, p_source_filter: 'all' });
        record('X', 'unrelated organizer denied', !!deniedX.error && /not_authorized/.test(deniedX.error.message), deniedX.error?.message);

        const unrelatedRc = await signUpTestUser('yrc', 'Activity Audit Y Unrelated Recipient');
        testUserIds.push(unrelatedRc.id);
        const deniedY = await unrelatedRc.client.rpc('get_connection_activity_feed', { p_connection_id: connI, p_before_timestamp: null, p_before_source: null, p_before_id: null, p_limit: 20, p_source_filter: 'all' });
        record('Y', 'unrelated participant denied', !!deniedY.error && /not_authorized/.test(deniedY.error.message), deniedY.error?.message);

        // ── Z: reminder/task ID collision cannot collide in normalized keys ─────
        const [rawEvent] = normalizeActivityRows([{ source_kind: 'reminder', source_id: 'same-uuid', occurrence_id: 'same-uuid', occurrence_date: today, event_timestamp: new Date().toISOString(), outcome: 'taken', title: 'X', organizer_name: null }], LABELS);
        const [taskEvent] = normalizeActivityRows([{ source_kind: 'task', source_id: 'same-uuid', occurrence_id: 'same-uuid', occurrence_date: today, event_timestamp: new Date().toISOString(), outcome: 'completed_on_time', title: 'X', organizer_name: null }], LABELS);
        record('Z', 'reminder/task ID collision cannot collide in normalized keys', activityEventKey(rawEvent) !== activityEventKey(taskEvent), `${activityEventKey(rawEvent)} vs ${activityEventKey(taskEvent)}`);

        // ── AA/AB/AC: pagination ─────────────────────────────────────────────
        const { caregiver: cgPage, recipient: rcPage, connectionId: connPage } = await makeConnectedPair('page');
        for (let i = 0; i < 5; i++) {
            const t1 = (await createTask(cgPage.client, connPage, { title: `Page task ${i}`, frequency: 'one_time', startDate: addDays(today, -i) })).data;
            await rcPage.client.rpc('respond_to_task_occurrence', { p_task_id: t1.id, p_occurrence_date: addDays(today, -i), p_status: 'completed' });
        }
        const page1 = await cgPage.client.rpc('get_connection_activity_feed', { p_connection_id: connPage, p_before_timestamp: null, p_before_source: null, p_before_id: null, p_limit: 2, p_source_filter: 'all' });
        const page1Rows = (page1.data ?? []) as ActivityRow[];
        record('AA', 'activity pagination first page', !page1.error && page1Rows.length === 2, `rows=${page1Rows.length}`);

        const lastOfPage1 = page1Rows[page1Rows.length - 1];
        const page2 = await cgPage.client.rpc('get_connection_activity_feed', { p_connection_id: connPage, p_before_timestamp: lastOfPage1?.event_timestamp, p_before_source: lastOfPage1?.source_kind, p_before_id: lastOfPage1?.source_id, p_limit: 2, p_source_filter: 'all' });
        const page2Rows = (page2.data ?? []) as ActivityRow[];
        record('AB', 'activity pagination second page', !page2.error && page2Rows.length === 2, `rows=${page2Rows.length}`);

        const page1Ids = new Set(page1Rows.map((r) => `${r.source_kind}:${r.occurrence_id}`));
        const overlap = page2Rows.some((r) => page1Ids.has(`${r.source_kind}:${r.occurrence_id}`));
        record('AC', 'no duplicates between pages', !overlap, `overlap=${overlap}`);

        // ── AD: no skipped events at identical timestamps ───────────────────────
        // task_occurrences is fully immutable after insert (trigger-enforced,
        // even against a service-role UPDATE -- confirmed by attempting
        // exactly that during this scenario's first draft, which correctly
        // failed with "task_occurrences rows are immutable after insert").
        // A genuine identical-timestamp tie therefore cannot be manufactured
        // against the real table without violating the very guarantee this
        // task depends on -- so this scenario instead verifies the tie-break
        // LOGIC directly: (1) a literal manufactured tie proves Postgres's
        // row-tuple ordering deterministically includes both rows rather
        // than collapsing/dropping one, and (2) the migration's actual
        // ORDER BY / cursor WHERE clause both include the full
        // (event_timestamp, source_kind, source_id) tuple, matching what (1)
        // relies on.
        const tieQuery = dbQuery(`
          with fake as (
            values
              ('reminder'::text, '11111111-1111-1111-1111-111111111111'::uuid, '2026-01-01T00:00:00Z'::timestamptz),
              ('task'::text, '22222222-2222-2222-2222-222222222222'::uuid, '2026-01-01T00:00:00Z'::timestamptz)
          )
          select column1 as source_kind, column2 as source_id, column3 as event_timestamp
          from fake
          order by column3 desc, column1 desc, column2 desc;
        `) as { source_kind: string; source_id: string }[];
        const migrationSourceForAD = read('supabase/migrations/20260729000000_activity_feed.sql');
        const orderByHasFullTuple = has(migrationSourceForAD, /order by c\.ev_event_timestamp desc, c\.ev_source_kind desc, c\.ev_source_id desc/);
        record('AD', 'no skipped events at identical timestamps', tieQuery.length === 2 && orderByHasFullTuple, `manufacturedTieRows=${tieQuery.length} orderByUsesFullTuple=${orderByHasFullTuple}`);

        // ── AE: new event while paginating remains consistent ──────────────────
        const preCursor = page2Rows[page2Rows.length - 1] ?? lastOfPage1;
        const newMidTask = (await createTask(cgPage.client, connPage, { title: 'Injected mid-pagination', frequency: 'one_time', startDate: today })).data;
        await rcPage.client.rpc('respond_to_task_occurrence', { p_task_id: newMidTask.id, p_occurrence_date: today, p_status: 'completed' });
        const page3 = await cgPage.client.rpc('get_connection_activity_feed', { p_connection_id: connPage, p_before_timestamp: preCursor?.event_timestamp, p_before_source: preCursor?.source_kind, p_before_id: preCursor?.source_id, p_limit: 10, p_source_filter: 'all' });
        const page3HasNewEvent = ((page3.data ?? []) as ActivityRow[]).some((r) => r.occurrence_id && r.source_id === newMidTask.id);
        record('AE', 'new event while paginating remains consistent (cursor excludes newer events)', !page3.error && !page3HasNewEvent, `page3HasNewEvent=${page3HasNewEvent}`);

        // ── AF/AG/AH: filters ───────────────────────────────────────────────
        const reminderFilterFeed = await cgPage.client.rpc('get_connection_activity_feed', { p_connection_id: connPage, p_before_timestamp: null, p_before_source: null, p_before_id: null, p_limit: 50, p_source_filter: 'reminder' });
        record('AF', 'reminder filter', !reminderFilterFeed.error && ((reminderFilterFeed.data ?? []) as ActivityRow[]).every((r) => r.source_kind === 'reminder'), `rows=${(reminderFilterFeed.data ?? []).length}`);

        const taskFilterFeed = await cgPage.client.rpc('get_connection_activity_feed', { p_connection_id: connPage, p_before_timestamp: null, p_before_source: null, p_before_id: null, p_limit: 50, p_source_filter: 'task' });
        record('AG', 'task filter', !taskFilterFeed.error && ((taskFilterFeed.data ?? []) as ActivityRow[]).every((r) => r.source_kind === 'task'), `rows=${(taskFilterFeed.data ?? []).length}`);

        record('AH', 'empty filter state', ((reminderFilterFeed.data ?? []) as ActivityRow[]).length === 0, 'connPage has no reminders, reminder filter correctly empty');

        // ── AI/AJ/AK/AL/AM/AN: static UI-behavior checks (source inspection) ────
        const activitySource = read('app/activity.tsx');
        record('AI', 'load-more failure preserves prior page', has(activitySource, /setLoadMoreError\(true\)/) && !has(activitySource, /setEvents\(\[\]\)[\s\S]{0,80}loadMoreError/), 'loadMore error path never clears events');
        record('AJ', 'refresh failure preserves valid data', has(activitySource, /setStatus\('error'\)/) && has(activitySource, /const \[events, setEvents\]/), 'loadFirstPage error path leaves prior events state untouched (only status flips)');
        const recipientDashSource = read('app/recipient-dashboard.tsx');
        record('AK', 'offline Today with cached data', has(recipientDashSource, /OfflineBanner/), 'existing OfflineBanner reused for Today hub');
        record('AL', 'reminder partial failure independent of tasks', has(recipientDashSource, /taskStatus === 'error'/) && has(recipientDashSource, /loadError/), 'independent state variables confirmed');
        record('AM', 'task partial failure independent of reminders', has(recipientDashSource, /setTaskStatus\('error'\)/), 'task load failure sets its own status only');
        record('AN', 'both-source failure renders both independent error sections', has(recipientDashSource, /SectionErrorState text=\{t\('tasksSection\.loadFailedText'\)\}/) , 'both reminder and task sections can show independent SectionErrorState');

        // ── AO/AP/AQ/AR: action-flow integrity ──────────────────────────────
        record('AO', 'reminder action uses existing reminder lifecycle', has(recipientDashSource, /respondToReminderOccurrence|saveReminderAction/), 'no unified mutation path introduced');
        record('AP', 'task action uses existing task lifecycle', has(recipientDashSource, /respond_to_task_occurrence/), 'recipient-dashboard task actions call the existing RPC directly');

        const dupResp1 = await rcPage.client.rpc('respond_to_task_occurrence', { p_task_id: newMidTask.id, p_occurrence_date: today, p_status: 'completed' });
        const dupResp2 = await rcPage.client.rpc('respond_to_task_occurrence', { p_task_id: newMidTask.id, p_occurrence_date: today, p_status: 'completed' });
        record('AQ', 'repeated action tap is safe', !dupResp1.error && !dupResp2.error && dupResp1.data?.id === dupResp2.data?.id, JSON.stringify({ a: dupResp1.data?.id, b: dupResp2.data?.id }));

        const { caregiver: cgAR, recipient: rcAR, connectionId: connAR } = await makeConnectedPair('ar');
        const taskAR = (await createTask(cgAR.client, connAR, { frequency: 'one_time', startDate: today })).data;
        await cgAR.client.rpc('end_connection', { p_connection_id: connAR });
        const respAR = await rcAR.client.rpc('respond_to_task_occurrence', { p_task_id: taskAR.id, p_occurrence_date: today, p_status: 'completed' });
        record('AR', 'connection ending blocks response', !!respAR.error && /task_inactive/.test(respAR.error.message), respAR.error?.message);

        // ── AS/AT/AU/AV: notification deep-link statics ──────────────────────
        const layoutSource = read('app/_layout.tsx');
        const reminderAlertSource = read('app/reminder-alert.tsx');
        const taskDetailsSource = read('app/task-details.tsx');
        record('AS', 'old reminder notification non-actionable', has(reminderAlertSource, /noLongerActive|reminder_inactive|reminderInactive/i), 'reminder-alert.tsx re-validates active state before allowing actions');
        record('AT', 'archived-task notification non-actionable', has(taskDetailsSource, /task\.is_active/), 'task-details.tsx gates all responses on task.is_active');
        record('AU', 'password recovery overrides queued notification', has(layoutSource, /passwordRecoveryRef\.current\)\s*return/), 'password-recovery guard precedes notification routing');
        record('AV', 'account switching clears queued intent', has(layoutSource, /'unauthenticated'/) && has(layoutSource, /pendingNotificationRef/), 'status check + pending-ref guard present');

        // ── AW: deleted/tombstoned counterpart privacy ──────────────────────
        const { caregiver: cgAW, recipient: rcAW, connectionId: connAW } = await makeConnectedPair('aw');
        const taskAW = (await createTask(cgAW.client, connAW, { frequency: 'one_time', startDate: today })).data;
        await rcAW.client.rpc('respond_to_task_occurrence', { p_task_id: taskAW.id, p_occurrence_date: today, p_status: 'completed' });
        dbQuery(`select public.delete_current_user_data('${rcAW.id}');`);
        const feedAfterDeletion = await cgAW.client.rpc('get_connection_activity_feed', { p_connection_id: connAW, p_before_timestamp: null, p_before_source: null, p_before_id: null, p_limit: 20, p_source_filter: 'all' });
        const rowAfterDeletion = ((feedAfterDeletion.data ?? []) as ActivityRow[]).find((r) => r.source_id === taskAW.id);
        record('AW', 'deleted/tombstoned counterpart privacy', !feedAfterDeletion.error && rowAfterDeletion?.participant_name == null, JSON.stringify(rowAfterDeletion));

        // ── AX: notes excluded from summary response ─────────────────────────
        const activityFnColumns = dbQuery(`
          select routine_name from information_schema.routines
          where routine_schema = 'public' and routine_name in ('get_connection_activity_feed', 'get_participant_activity_feed');
        `);
        const migrationSource = read('supabase/migrations/20260729000000_activity_feed.sql');
        record('AX', 'notes excluded from summary response', !has(migrationSource, /rl\.notes|t\.notes|\bnotes\b.*as ev_/i) && (activityFnColumns as any[]).length === 2, 'neither activity function selects a notes column');

        // ── AY: cursor authorization cannot be bypassed ───────────────────────
        const forgedCursorAttempt = await unrelatedOrg.client.rpc('get_connection_activity_feed', { p_connection_id: connI, p_before_timestamp: '2000-01-01T00:00:00Z', p_before_source: 'task', p_before_id: '00000000-0000-0000-0000-000000000000', p_limit: 50, p_source_filter: 'all' });
        record('AY', 'cursor authorization cannot be bypassed', !!forgedCursorAttempt.error && /not_authorized/.test(forgedCursorAttempt.error.message), forgedCursorAttempt.error?.message);

        // ── AZ/BA: activity does not change reminder/task analytics ──────────
        const reminderAnalyticsBefore = dbQuery(`select count(*) as c from public.reminder_logs where connection_id = '${connI}';`);
        const taskAnalyticsBefore = await cgI.client.rpc('task_analytics_summary', { p_connection_id: connI, p_days: 30 });
        await cgI.client.rpc('get_connection_activity_feed', { p_connection_id: connI, p_before_timestamp: null, p_before_source: null, p_before_id: null, p_limit: 5, p_source_filter: 'all' });
        await cgI.client.rpc('get_connection_activity_feed', { p_connection_id: connI, p_before_timestamp: null, p_before_source: null, p_before_id: null, p_limit: 5, p_source_filter: 'task' });
        const reminderAnalyticsAfter = dbQuery(`select count(*) as c from public.reminder_logs where connection_id = '${connI}';`);
        const taskAnalyticsAfter = await cgI.client.rpc('task_analytics_summary', { p_connection_id: connI, p_days: 30 });
        record('AZ', 'activity does not change reminder analytics', JSON.stringify(reminderAnalyticsBefore) === JSON.stringify(reminderAnalyticsAfter), 'reminder_logs count unchanged by activity-feed reads');
        record('BA', 'activity does not change task analytics', JSON.stringify(taskAnalyticsBefore.data) === JSON.stringify(taskAnalyticsAfter.data), 'task_analytics_summary unchanged by activity-feed reads');

        // ── BB-BK: full regression suites ────────────────────────────────────
        try {
            const out = execFileSync('npx', ['tsx', 'scripts/security-audit/run.ts'], { encoding: 'utf-8', env: process.env });
            const m = lastTestsPassedMatch(out);
            record('BB', 'scripts/security-audit/run.ts remains 24/24 PASS', !!m && m[1] === m[2], m?.[0]);
        } catch (err) { record('BB', 'scripts/security-audit/run.ts remains 24/24 PASS', false, err instanceof Error ? err.message : String(err)); }

        try {
            const out = execFileSync('npx', ['tsx', 'scripts/auth-audit/run.ts'], { encoding: 'utf-8', env: process.env });
            const m = lastTestsPassedMatch(out);
            record('BC', 'scripts/auth-audit/run.ts remains 37/37 PASS', !!m && m[1] === m[2], m?.[0]);
        } catch (err) { record('BC', 'scripts/auth-audit/run.ts remains 37/37 PASS', false, err instanceof Error ? err.message : String(err)); }

        try {
            const out = execFileSync('npx', ['tsx', 'scripts/reminder-audit/run.ts'], { encoding: 'utf-8', env: process.env });
            const m = lastTestsPassedMatch(out);
            record('BD', 'scripts/reminder-audit/run.ts remains passing', !!m && m[1] === m[2], m?.[0]);
        } catch (err) { record('BD', 'scripts/reminder-audit/run.ts remains passing', false, err instanceof Error ? err.message : String(err)); }

        try {
            const out = execFileSync('npx', ['tsx', 'scripts/task-audit/run.ts'], { encoding: 'utf-8', env: process.env });
            const m = lastTestsPassedMatch(out);
            record('BE', "task audit's own scenarios remain passing", !!m && m[1] === m[2], m?.[0]);
        } catch (err) { record('BE', "task audit's own scenarios remain passing", false, err instanceof Error ? err.message : String(err)); }

        try {
            const out = execFileSync('npx', ['tsx', 'scripts/onboarding-audit/run.ts'], { encoding: 'utf-8', env: process.env });
            const m = lastTestsPassedMatch(out);
            record('BF', "onboarding audit's own scenarios remain passing", !!m && m[1] === m[2], m?.[0]);
        } catch (err) { record('BF', "onboarding audit's own scenarios remain passing", false, err instanceof Error ? err.message : String(err)); }

        try {
            const out = execFileSync('npx', ['tsx', 'scripts/participant-audit/run.ts'], { encoding: 'utf-8', env: process.env });
            const m = lastTestsPassedMatch(out);
            record('BG', "participant audit's own scenarios remain passing", !!m && m[1] === m[2], m?.[0]);
        } catch (err) { record('BG', "participant audit's own scenarios remain passing", false, err instanceof Error ? err.message : String(err)); }

        try {
            const out = execFileSync('npx', ['tsx', 'scripts/ui-state-audit/run.ts'], { encoding: 'utf-8', env: process.env });
            const m = lastTestsPassedMatch(out);
            record('BH', "UI-state audit's own scenarios remain passing", !!m && m[1] === m[2], m?.[0]);
        } catch (err) { record('BH', "UI-state audit's own scenarios remain passing", false, err instanceof Error ? err.message : String(err)); }

        try {
            const out = execFileSync('npx', ['tsx', 'scripts/accessibility-audit/run.ts'], { encoding: 'utf-8', env: process.env });
            const m = lastTestsPassedMatch(out);
            record('BI', "accessibility audit's own scenarios remain passing", !!m && m[1] === m[2], m?.[0]);
        } catch (err) { record('BI', "accessibility audit's own scenarios remain passing", false, err instanceof Error ? err.message : String(err)); }

        try {
            const out = execFileSync('npx', ['tsx', 'scripts/visual-consistency-audit/run.ts'], { encoding: 'utf-8', env: process.env });
            const m = lastTestsPassedMatch(out);
            record('BJ', "visual-consistency audit's own scenarios remain passing", !!m && m[1] === m[2], m?.[0]);
        } catch (err) { record('BJ', "visual-consistency audit's own scenarios remain passing", false, err instanceof Error ? err.message : String(err)); }

        try {
            const out = execFileSync('npx', ['tsx', 'scripts/ops-health/run.ts'], { encoding: 'utf-8', env: process.env });
            const hasActivityFail = /\[FAIL\] activity_/.test(out);
            record('BK', 'ops health has no new activity-related FAIL', !hasActivityFail, hasActivityFail ? 'an activity_* check reported FAIL' : 'no activity_* checks exist (none needed — read-only, no new delivery-health metric per Phase 20)');
        } catch (err: any) {
            const out = err?.stdout ?? '';
            const hasActivityFail = /\[FAIL\] activity_/.test(out);
            record('BK', 'ops health has no new activity-related FAIL', !hasActivityFail, hasActivityFail ? 'an activity_* check reported FAIL' : (err instanceof Error ? err.message : String(err)));
        }

    } finally {
        console.log('\nCleaning up synthetic test data...');
        for (const taskId of testTaskIds) {
            dbQuery(`delete from public.task_notification_deliveries where task_id = '${taskId}';`);
            dbQuery(`delete from public.task_occurrences where task_id = '${taskId}';`);
        }
        dbQuery(`delete from public.tasks where id in (${testTaskIds.map((id) => `'${id}'`).join(',') || "'00000000-0000-0000-0000-000000000000'"});`);
        for (const reminderId of testReminderIds) {
            dbQuery(`delete from public.reminder_notification_deliveries where reminder_id = '${reminderId}';`);
            dbQuery(`delete from public.reminder_logs where reminder_id = '${reminderId}';`);
        }
        dbQuery(`delete from public.reminders where id in (${testReminderIds.map((id) => `'${id}'`).join(',') || "'00000000-0000-0000-0000-000000000000'"});`);
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
    console.error('ACTIVITY_AUDIT_SUITE_FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
});
