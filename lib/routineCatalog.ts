// ─── Built-in Tavora Routine Pack catalog (pure, zero react-native import) ─
// Week 3 product-expansion task #3, Phase 4. A versioned, localized client
// catalog — never stored server-side (see docs/routine-template-model.md
// for the full reasoning). Every pack expands into the exact same
// validated apply payload a personal template produces; the server never
// trusts packId/version for authorization, only for descriptive metadata
// on the resulting routine_instances row.
//
// These are organizational examples, not medical prescriptions or
// professional advice. No pack here implies diagnosis, treatment,
// employee monitoring/surveillance, or any HIPAA-covered claim — every
// reminder in a health-adjacent pack (Dental, Daily Care) deliberately uses
// reminder_type 'other', never 'medication', to avoid implying medical
// categorization Tavora is not making.
//
// Version changes to a pack (bumping BUILT_IN_PACK_CATALOG_VERSION or an
// individual pack's own `version`) never mutate any routine_instances
// already created from an earlier version — routine_instances.source_
// version snapshots whatever version was live at apply time.

import type { UseCase } from '@/lib/onboardingCore';
import type { ReminderType, RoutineFrequency, TemplateItemDraft } from '@/lib/routineCore';

export type BuiltInPackItem =
    | {
          sourceItemKey: string;
          itemKind: 'reminder';
          titleKey: string;
          notesKey?: string;
          reminderType: ReminderType;
          timeOfDay: string;
          frequency: RoutineFrequency;
          daysOfWeek: number[];
          noResponseMinutes: number;
          /** Optional, defaults to 0 — see MAX_REMINDER_START_OFFSET_DAYS in lib/routineCore.ts. None of the launch packs currently need a nonzero value, but the field exists for full symmetry with personal templates, which flow through the identical resolve/apply code path. */
          startOffsetDays?: number;
      }
    | {
          sourceItemKey: string;
          itemKind: 'task';
          titleKey: string;
          notesKey?: string;
          frequency: 'one_time' | RoutineFrequency;
          daysOfWeek: number[];
          startOffsetDays: number;
          dueOffsetDays: number | null;
      };

export type BuiltInPack = {
    packId: string;
    version: string;
    titleKey: string;
    descriptionKey: string;
    /** Influences "Recommended for you" — every pack stays discoverable regardless of use case. */
    recommendedUseCases: UseCase[];
    items: BuiltInPackItem[];
};

const DAILY = [1, 2, 3, 4, 5, 6, 7];
const WEEKDAYS = [1, 2, 3, 4, 5];

export const BUILT_IN_ROUTINE_PACKS: BuiltInPack[] = [
    {
        packId: 'morning_routine',
        version: '1',
        titleKey: 'routineCatalog.morningRoutine.title',
        descriptionKey: 'routineCatalog.morningRoutine.description',
        recommendedUseCases: ['care', 'family', 'personal'],
        items: [
            { sourceItemKey: 'get_ready', itemKind: 'task', titleKey: 'routineCatalog.morningRoutine.getReady', frequency: 'daily', daysOfWeek: DAILY, startOffsetDays: 0, dueOffsetDays: null },
            { sourceItemKey: 'morning_checkin', itemKind: 'reminder', titleKey: 'routineCatalog.morningRoutine.checkIn', reminderType: 'other', timeOfDay: '08:00', frequency: 'daily', daysOfWeek: DAILY, noResponseMinutes: 30 },
            { sourceItemKey: 'prepare_essentials', itemKind: 'task', titleKey: 'routineCatalog.morningRoutine.prepareEssentials', frequency: 'daily', daysOfWeek: DAILY, startOffsetDays: 0, dueOffsetDays: null },
        ],
    },
    {
        packId: 'evening_routine',
        version: '1',
        titleKey: 'routineCatalog.eveningRoutine.title',
        descriptionKey: 'routineCatalog.eveningRoutine.description',
        recommendedUseCases: ['care', 'family', 'personal'],
        items: [
            { sourceItemKey: 'evening_responsibilities', itemKind: 'task', titleKey: 'routineCatalog.eveningRoutine.responsibilities', frequency: 'daily', daysOfWeek: DAILY, startOffsetDays: 0, dueOffsetDays: null },
            { sourceItemKey: 'evening_checkin', itemKind: 'reminder', titleKey: 'routineCatalog.eveningRoutine.checkIn', reminderType: 'other', timeOfDay: '20:00', frequency: 'daily', daysOfWeek: DAILY, noResponseMinutes: 30 },
            { sourceItemKey: 'prepare_tomorrow', itemKind: 'task', titleKey: 'routineCatalog.eveningRoutine.prepareTomorrow', frequency: 'daily', daysOfWeek: DAILY, startOffsetDays: 0, dueOffsetDays: null },
        ],
    },
    {
        packId: 'family_chores',
        version: '1',
        titleKey: 'routineCatalog.familyChores.title',
        descriptionKey: 'routineCatalog.familyChores.description',
        recommendedUseCases: ['family'],
        items: [
            { sourceItemKey: 'tidy_shared_spaces', itemKind: 'task', titleKey: 'routineCatalog.familyChores.tidySharedSpaces', frequency: 'daily', daysOfWeek: DAILY, startOffsetDays: 0, dueOffsetDays: null },
            { sourceItemKey: 'take_out_trash', itemKind: 'task', titleKey: 'routineCatalog.familyChores.takeOutTrash', frequency: 'custom', daysOfWeek: [2, 5], startOffsetDays: 0, dueOffsetDays: null },
            { sourceItemKey: 'put_away_laundry', itemKind: 'task', titleKey: 'routineCatalog.familyChores.putAwayLaundry', frequency: 'weekdays', daysOfWeek: WEEKDAYS, startOffsetDays: 0, dueOffsetDays: null },
        ],
    },
    {
        packId: 'workout_accountability',
        version: '1',
        titleKey: 'routineCatalog.workoutAccountability.title',
        descriptionKey: 'routineCatalog.workoutAccountability.description',
        recommendedUseCases: ['coaching', 'personal'],
        items: [
            { sourceItemKey: 'complete_workout', itemKind: 'task', titleKey: 'routineCatalog.workoutAccountability.completeWorkout', frequency: 'daily', daysOfWeek: DAILY, startOffsetDays: 0, dueOffsetDays: null },
            { sourceItemKey: 'workout_checkin', itemKind: 'reminder', titleKey: 'routineCatalog.workoutAccountability.checkIn', reminderType: 'exercise', timeOfDay: '17:00', frequency: 'daily', daysOfWeek: DAILY, noResponseMinutes: 30 },
            { sourceItemKey: 'record_completion', itemKind: 'task', titleKey: 'routineCatalog.workoutAccountability.recordCompletion', frequency: 'daily', daysOfWeek: DAILY, startOffsetDays: 0, dueOffsetDays: null },
        ],
    },
    {
        packId: 'study_routine',
        version: '1',
        titleKey: 'routineCatalog.studyRoutine.title',
        descriptionKey: 'routineCatalog.studyRoutine.description',
        recommendedUseCases: ['coaching', 'personal', 'family'],
        items: [
            { sourceItemKey: 'start_session', itemKind: 'reminder', titleKey: 'routineCatalog.studyRoutine.startSession', reminderType: 'other', timeOfDay: '16:00', frequency: 'weekdays', daysOfWeek: WEEKDAYS, noResponseMinutes: 30 },
            { sourceItemKey: 'complete_goal', itemKind: 'task', titleKey: 'routineCatalog.studyRoutine.completeGoal', frequency: 'weekdays', daysOfWeek: WEEKDAYS, startOffsetDays: 0, dueOffsetDays: null },
            { sourceItemKey: 'prepare_next_session', itemKind: 'task', titleKey: 'routineCatalog.studyRoutine.prepareNextSession', frequency: 'weekdays', daysOfWeek: WEEKDAYS, startOffsetDays: 0, dueOffsetDays: null },
        ],
    },
    {
        packId: 'dental_routine',
        version: '1',
        titleKey: 'routineCatalog.dentalRoutine.title',
        descriptionKey: 'routineCatalog.dentalRoutine.description',
        recommendedUseCases: ['care', 'family', 'personal'],
        items: [
            { sourceItemKey: 'morning_dental', itemKind: 'reminder', titleKey: 'routineCatalog.dentalRoutine.morning', reminderType: 'other', timeOfDay: '07:30', frequency: 'daily', daysOfWeek: DAILY, noResponseMinutes: 30 },
            { sourceItemKey: 'evening_dental', itemKind: 'reminder', titleKey: 'routineCatalog.dentalRoutine.evening', reminderType: 'other', timeOfDay: '20:30', frequency: 'daily', daysOfWeek: DAILY, noResponseMinutes: 30 },
        ],
    },
    {
        packId: 'daily_care_routine',
        version: '1',
        titleKey: 'routineCatalog.dailyCareRoutine.title',
        descriptionKey: 'routineCatalog.dailyCareRoutine.description',
        recommendedUseCases: ['care'],
        items: [
            { sourceItemKey: 'daily_checkin', itemKind: 'reminder', titleKey: 'routineCatalog.dailyCareRoutine.checkIn', reminderType: 'other', timeOfDay: '09:00', frequency: 'daily', daysOfWeek: DAILY, noResponseMinutes: 30 },
            { sourceItemKey: 'care_activities', itemKind: 'task', titleKey: 'routineCatalog.dailyCareRoutine.careActivities', frequency: 'daily', daysOfWeek: DAILY, startOffsetDays: 0, dueOffsetDays: null },
            { sourceItemKey: 'notes_to_share', itemKind: 'task', titleKey: 'routineCatalog.dailyCareRoutine.notesToShare', frequency: 'daily', daysOfWeek: DAILY, startOffsetDays: 0, dueOffsetDays: null },
        ],
    },
    {
        packId: 'workday_checkin',
        version: '1',
        titleKey: 'routineCatalog.workdayCheckin.title',
        descriptionKey: 'routineCatalog.workdayCheckin.description',
        recommendedUseCases: ['team', 'coaching', 'personal'],
        items: [
            { sourceItemKey: 'start_checkin', itemKind: 'reminder', titleKey: 'routineCatalog.workdayCheckin.start', reminderType: 'other', timeOfDay: '09:00', frequency: 'weekdays', daysOfWeek: WEEKDAYS, noResponseMinutes: 30 },
            { sourceItemKey: 'assigned_work_item', itemKind: 'task', titleKey: 'routineCatalog.workdayCheckin.assignedWorkItem', frequency: 'weekdays', daysOfWeek: WEEKDAYS, startOffsetDays: 0, dueOffsetDays: null },
            { sourceItemKey: 'end_checkin', itemKind: 'reminder', titleKey: 'routineCatalog.workdayCheckin.end', reminderType: 'other', timeOfDay: '17:00', frequency: 'weekdays', daysOfWeek: WEEKDAYS, noResponseMinutes: 30 },
        ],
    },
];

/** Resolves one catalog item's localized title/notes via `t`, producing a fully-formed template item draft (enabled by default). */
export function expandBuiltInPackItem(item: BuiltInPackItem, t: (key: string) => string): TemplateItemDraft {
    const title = t(item.titleKey);
    const notes = item.notesKey ? t(item.notesKey) : null;
    if (item.itemKind === 'reminder') {
        return {
            sourceItemKey: item.sourceItemKey,
            itemKind: 'reminder',
            title,
            notes,
            enabledByDefault: true,
            reminderType: item.reminderType,
            timeOfDay: item.timeOfDay,
            frequency: item.frequency,
            daysOfWeek: item.daysOfWeek,
            noResponseMinutes: item.noResponseMinutes,
            startOffsetDays: item.startOffsetDays ?? 0,
        };
    }
    return {
        sourceItemKey: item.sourceItemKey,
        itemKind: 'task',
        title,
        notes,
        enabledByDefault: true,
        frequency: item.frequency,
        daysOfWeek: item.daysOfWeek,
        startOffsetDays: item.startOffsetDays,
        dueOffsetDays: item.dueOffsetDays,
    };
}

export function getBuiltInPack(packId: string): BuiltInPack | undefined {
    return BUILT_IN_ROUTINE_PACKS.find((p) => p.packId === packId);
}
