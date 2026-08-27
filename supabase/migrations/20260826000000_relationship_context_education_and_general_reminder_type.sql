-- Week 4 product-reset Build Batch 2: per-connection relationship context,
-- education use case, and a genuinely neutral reminder category.
--
-- Confirmed live before writing this migration (see the Batch 2 pre-work
-- verification): 36 profiles, 13 connections, 29 reminders (27
-- 'medication', 2 'other'), 2 tasks, 0 routine_instances, 0
-- routine_templates, 31 reminder_logs, 0 task_occurrences. Every change
-- below is additive (new column, new allowed CHECK values, new function,
-- or a body-only redefinition of an existing function with an unchanged
-- signature) except create_invite_code and get_my_organizer_connections_
-- summary, whose signature/return type changes require DROP + CREATE (the
-- same pattern already used in
-- 20260801040000_activity_feed_organizer_deleted_state.sql) -- neither
-- drops or narrows anything a caller currently depends on; both are purely
-- additive from the caller's perspective (new optional parameter with a
-- default, new nullable output column).
--
-- ═══ 1. connections.relationship_pair ════════════════════════════════════
--
-- Per-connection, not per-profile: profiles.use_case (added
-- 20260726000000) is a coarse, pre-connection onboarding signal (asked
-- once, before any participant exists, so it cannot be connection-scoped
-- by construction) that continues to drive onboarding copy and routine-
-- pack recommendations completely unchanged. relationship_pair is the
-- finer-grained, per-connection label an organizer with multiple
-- participants in different relationships (e.g. Parent/Child with one,
-- Trainer/Client with another) genuinely needs and profiles.use_case
-- structurally cannot represent. Nullable, additive, zero backfill --
-- every one of the 13 live connections gets NULL, which is the permanent,
-- correct "relationship unspecified" state, not a temporary migration
-- artifact. NULL must always safely resolve to the generic Organizer/
-- Participant labels client-side (lib/relationshipCore.ts) -- never
-- treated as an error or a reason to block anything.

alter table public.connections add column relationship_pair text;

alter table public.connections add constraint connections_relationship_pair_check
  check (relationship_pair is null or relationship_pair in (
    'parent_child',
    'trainer_client',
    'coach_athlete',
    'caregiver_family_member',
    'tutor_student',
    'mentor_mentee',
    'manager_team_member',
    'provider_patient',
    'accountability_partner',
    'family_member_family_member',
    'other'
  ));

comment on column public.connections.relationship_pair is
  'Display-only per-connection relationship label (e.g. trainer_client, parent_child) -- never read by RLS or any authorization check, exactly like profiles.use_case. NULL means "relationship unspecified"; every UI surface must fall back to generic Organizer/Participant, never error. Set optionally at invite-creation time (create_invite_code), visible to the participant before acceptance only via preview_invite_code (never via a direct table read, since RLS on this table -- "Users can view their related connections", auth.uid() = caregiver_id or auth.uid() = recipient_id -- grants no read at all on a still-pending row with recipient_id null).';

-- No RLS policy change needed: the existing single SELECT policy
-- ("Users can view their related connections") already governs this new
-- column exactly as it governs every other connections column (row-level,
-- not column-level) -- confirmed live before writing this migration that
-- INSERT/UPDATE have zero policies on this table (all mutation is already
-- forced through SECURITY DEFINER RPCs), so relationship_pair inherits
-- that same protection automatically.

-- ═══ 2. education: profiles.use_case ═════════════════════════════════════
--
-- Batch 1 proved live (SQLSTATE 23514) that 'education' was rejected here.
-- Purely additive -- every existing value stays valid, nothing renamed.

alter table public.profiles drop constraint profiles_use_case_check;
alter table public.profiles add constraint profiles_use_case_check
  check (use_case is null or use_case in ('care', 'family', 'coaching', 'team', 'education', 'personal', 'other'));

-- ═══ 3. education: routine_templates.use_case ════════════════════════════

alter table public.routine_templates drop constraint routine_templates_use_case_check;
alter table public.routine_templates add constraint routine_templates_use_case_check
  check (use_case is null or use_case = any(array['care','family','coaching','team','education','personal','other']));

-- ═══ 4. education: create_routine_template / update_routine_template ════
-- Body-only changes (widened p_use_case allow-list); signatures unchanged,
-- so CREATE OR REPLACE is sufficient and grants are preserved automatically
-- -- restated below anyway to match this codebase's established convention
-- of always re-stating them after a SECURITY DEFINER redefinition.

create or replace function public.create_routine_template(p_title text, p_description text, p_use_case text, p_items jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
declare
    v_owner uuid := auth.uid();
    v_profile public.profiles%rowtype;
    v_template public.routine_templates%rowtype;
    v_item jsonb;
    v_idx integer := 0;
    v_count integer;
begin
    if v_owner is null then
        raise exception 'authentication_required';
    end if;

    select * into v_profile from public.profiles where id = v_owner;
    if not found or v_profile.account_status <> 'active' then
        raise exception 'not_authorized';
    end if;
    if v_profile.role is distinct from 'caregiver' then
        raise exception 'organizer_role_required';
    end if;

    if p_title is null or btrim(p_title) = '' or char_length(p_title) > 200 then
        raise exception 'invalid_title';
    end if;
    if p_description is not null and char_length(p_description) > 2000 then
        raise exception 'invalid_description';
    end if;
    if p_use_case is not null and p_use_case not in ('care','family','coaching','team','education','personal','other') then
        raise exception 'invalid_use_case';
    end if;

    v_count := jsonb_array_length(coalesce(p_items, '[]'::jsonb));
    if v_count < 1 or v_count > 20 then
        raise exception 'invalid_item_count';
    end if;

    insert into public.routine_templates (owner_id, title, description, use_case)
    values (v_owner, btrim(p_title), nullif(btrim(coalesce(p_description, '')), ''), p_use_case)
    returning * into v_template;

    for v_item in select * from jsonb_array_elements(p_items)
    loop
        v_idx := v_idx + 1;
        perform public._insert_routine_template_item(v_template.id, v_idx, v_item);
    end loop;

    return public._routine_template_summary(v_template.id);
end;
$function$;

revoke all on function public.create_routine_template(text, text, text, jsonb) from public, anon;
grant execute on function public.create_routine_template(text, text, text, jsonb) to authenticated;

create or replace function public.update_routine_template(p_template_id uuid, p_title text, p_description text, p_use_case text, p_items jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
declare
    v_owner uuid := auth.uid();
    v_template public.routine_templates%rowtype;
    v_item jsonb;
    v_idx integer := 0;
    v_count integer;
begin
    if v_owner is null then
        raise exception 'authentication_required';
    end if;

    select * into v_template from public.routine_templates where id = p_template_id for update;
    if not found or v_template.owner_id <> v_owner then
        raise exception 'not_authorized';
    end if;

    if p_title is null or btrim(p_title) = '' or char_length(p_title) > 200 then
        raise exception 'invalid_title';
    end if;
    if p_description is not null and char_length(p_description) > 2000 then
        raise exception 'invalid_description';
    end if;
    if p_use_case is not null and p_use_case not in ('care','family','coaching','team','education','personal','other') then
        raise exception 'invalid_use_case';
    end if;

    v_count := jsonb_array_length(coalesce(p_items, '[]'::jsonb));
    if v_count < 1 or v_count > 20 then
        raise exception 'invalid_item_count';
    end if;

    update public.routine_templates
    set title = btrim(p_title),
        description = nullif(btrim(coalesce(p_description, '')), ''),
        use_case = p_use_case,
        revision = revision + 1,
        updated_at = now()
    where id = p_template_id;

    -- Full replace, not an incremental diff -- simplest correct behavior
    -- for reordering/editing/removing items in one call. Instances already
    -- applied from this template are entirely unaffected: they link to
    -- concrete reminder/task rows, never to these item rows.
    delete from public.routine_template_items where template_id = p_template_id;

    for v_item in select * from jsonb_array_elements(p_items)
    loop
        v_idx := v_idx + 1;
        perform public._insert_routine_template_item(p_template_id, v_idx, v_item);
    end loop;

    return public._routine_template_summary(p_template_id);
end;
$function$;

revoke all on function public.update_routine_template(uuid, text, text, text, jsonb) from public, anon;
grant execute on function public.update_routine_template(uuid, text, text, text, jsonb) to authenticated;

-- ═══ 5. general: reminders.reminder_type ═════════════════════════════════
--
-- Confirmed live before writing this migration: reminders.reminder_type is
-- NOT NULL with an actual column DEFAULT of 'medication' -- not merely a
-- client-side default (Build Batch 1 only fixed the client's initial
-- useState value; the database itself independently defaulted every
-- column-omitting INSERT to 'medication' the whole time). 27 of 29 live
-- reminders carry 'medication' (2 carry 'other') -- none are touched here;
-- this only changes what a *future* row defaults to when reminder_type is
-- omitted, and widens the allowed set to add 'general'. Every existing
-- value remains valid and is preserved verbatim.

alter table public.reminders drop constraint reminders_reminder_type_check;
alter table public.reminders add constraint reminders_reminder_type_check
  check (reminder_type = any(array['general', 'medication', 'hydration', 'appointment', 'meal', 'exercise', 'other']));

alter table public.reminders alter column reminder_type set default 'general';

-- ═══ 6. general: update_reminder_schedule / _insert_routine_template_item /
--        apply_routine_template reminder_type validation ═════════════════
-- Body-only changes (widened allow-list); signatures unchanged.

create or replace function public.update_reminder_schedule(p_reminder_id uuid, p_title text, p_reminder_type text, p_notes text, p_time_of_day time without time zone, p_frequency text, p_days_of_week integer[], p_no_response_minutes integer)
 returns reminders
 language plpgsql
 security definer
 set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
declare
  v_caregiver_id uuid := auth.uid();
  v_reminder public.reminders%rowtype;
  v_connection public.connections%rowtype;
  v_schedule_changed boolean;
  v_tz text;
  v_today date;
  v_today_isodow int;
  v_new_scheduled_for timestamptz;
  v_today_eligible boolean;
  v_existing_delivery public.reminder_notification_deliveries%rowtype;
  v_result public.reminders%rowtype;
begin
  if v_caregiver_id is null then
    raise exception 'authentication_required';
  end if;

  if p_title is null or btrim(p_title) = '' then
    raise exception 'invalid_title';
  end if;

  if p_reminder_type not in ('general', 'medication', 'hydration', 'appointment', 'meal', 'exercise', 'other') then
    raise exception 'invalid_reminder_type';
  end if;

  if p_frequency not in ('daily', 'weekdays', 'weekends', 'custom') then
    raise exception 'invalid_frequency';
  end if;

  if p_days_of_week is null or cardinality(p_days_of_week) < 1 or cardinality(p_days_of_week) > 7
     or not (p_days_of_week <@ array[1, 2, 3, 4, 5, 6, 7]) then
    raise exception 'invalid_days_of_week';
  end if;

  if p_no_response_minutes is null or p_no_response_minutes < 1 or p_no_response_minutes > 120 then
    raise exception 'invalid_no_response_minutes';
  end if;

  -- Row lock: serializes this edit against a concurrent respond/claim/
  -- another edit for the same reminder.
  select * into v_reminder from public.reminders where id = p_reminder_id for update;
  if not found or v_reminder.caregiver_id <> v_caregiver_id then
    raise exception 'not_authorized';
  end if;

  if not v_reminder.is_active then
    raise exception 'reminder_inactive';
  end if;

  select * into v_connection from public.connections where id = v_reminder.connection_id for share;
  if not found or v_connection.status <> 'accepted' or v_connection.accepted_at is null then
    raise exception 'connection_inactive';
  end if;

  -- Compare days_of_week as normalized (order-independent) sets -- the
  -- stored array's element order should never itself count as a schedule
  -- change.
  v_schedule_changed :=
    v_reminder.time_of_day <> p_time_of_day
    or v_reminder.no_response_minutes <> p_no_response_minutes
    or (select array_agg(d order by d) from unnest(v_reminder.days_of_week) d)
       is distinct from (select array_agg(d order by d) from unnest(p_days_of_week) d);

  update public.reminders
  set title = btrim(p_title),
      reminder_type = p_reminder_type,
      notes = nullif(btrim(coalesce(p_notes, '')), ''),
      time_of_day = p_time_of_day,
      frequency = p_frequency,
      days_of_week = p_days_of_week,
      no_response_minutes = p_no_response_minutes,
      schedule_version = case when v_schedule_changed then schedule_version + 1 else schedule_version end,
      updated_at = now()
  where id = p_reminder_id
  returning * into v_result;

  if v_schedule_changed then
    select timezone into v_tz from public.profiles where id = v_result.recipient_id;

    if v_tz is not null then
      v_today := (now() at time zone v_tz)::date;
      v_today_isodow := extract(isodow from (now() at time zone v_tz))::int;
      v_new_scheduled_for := ((v_today::timestamp + v_result.time_of_day) at time zone v_tz);
      v_today_eligible :=
        v_today_isodow = any(v_result.days_of_week)
        and v_new_scheduled_for >= greatest(v_result.created_at, v_connection.accepted_at);

      select * into v_existing_delivery
      from public.reminder_notification_deliveries
      where reminder_id = p_reminder_id
        and occurrence_date = v_today
        and delivery_type = 'reminder'
      for update;

      if found and v_existing_delivery.status in ('pending', 'failed') then
        if v_today_eligible then
          -- Requeue in place -- never a second row for the same
          -- (reminder_id, occurrence_date, delivery_type): the unique
          -- constraint stays exactly as strict as before, and this is
          -- what lets the new time send without waiting for a delete to
          -- be separately reclaimed on the next cron tick.
          update public.reminder_notification_deliveries
          set scheduled_for = v_new_scheduled_for,
              schedule_version = v_result.schedule_version,
              status = 'pending',
              attempt_count = 0,
              error_code = null,
              error_message = null,
              updated_at = now()
          where id = v_existing_delivery.id;
        else
          -- Today no longer eligible under the new schedule (e.g. the day
          -- was removed) -- nothing valid to send today; remove the stale
          -- claim rather than leave it stuck consuming retry attempts
          -- forever. This never touches reminder_logs.
          delete from public.reminder_notification_deliveries where id = v_existing_delivery.id;
        end if;
      end if;
      -- A 'sent' or 'skipped' row (found = true, status not in
      -- pending/failed) is deliberately left untouched.
    end if;
  end if;

  return v_result;
end;
$function$;

revoke all on function public.update_reminder_schedule(uuid, text, text, text, time, text, int[], int) from public, anon;
grant execute on function public.update_reminder_schedule(uuid, text, text, text, time, text, int[], int) to authenticated;

create or replace function public._insert_routine_template_item(p_template_id uuid, p_order integer, p_item jsonb)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
declare
    v_kind text := p_item->>'item_kind';
    v_title text := btrim(coalesce(p_item->>'title', ''));
    v_notes text := nullif(btrim(coalesce(p_item->>'notes', '')), '');
    v_frequency text := p_item->>'frequency';
    v_days integer[];
    v_start_offset integer := coalesce((p_item->>'start_offset_days')::integer, 0);
    v_due_offset integer := nullif(p_item->>'due_offset_days', '')::integer;
    v_enabled boolean := coalesce((p_item->>'enabled_by_default')::boolean, true);
    v_reminder_type text := p_item->>'reminder_type';
    v_time_of_day time := nullif(p_item->>'time_of_day', '')::time;
    v_no_response integer := nullif(p_item->>'no_response_minutes', '')::integer;
begin
    if v_kind is null or v_kind not in ('reminder', 'task') then
        raise exception 'invalid_item_kind';
    end if;
    if v_title = '' or char_length(v_title) > 200 then
        raise exception 'invalid_item_title';
    end if;
    if v_notes is not null and char_length(v_notes) > 2000 then
        raise exception 'invalid_item_notes';
    end if;
    if v_start_offset < 0 then
        raise exception 'invalid_start_offset';
    end if;
    if v_due_offset is not null and v_due_offset < v_start_offset then
        raise exception 'due_offset_before_start_offset';
    end if;

    select coalesce(array_agg(x::int order by x), '{}')
    into v_days
    from jsonb_array_elements_text(coalesce(p_item->'days_of_week', '[]'::jsonb)) as x;

    if v_kind = 'reminder' then
        if v_frequency is null or v_frequency not in ('daily', 'weekdays', 'weekends', 'custom') then
            raise exception 'invalid_frequency';
        end if;
        if cardinality(v_days) < 1 or cardinality(v_days) > 7 or not (v_days <@ array[1,2,3,4,5,6,7]) then
            raise exception 'invalid_days_of_week';
        end if;
        if v_time_of_day is null then
            raise exception 'reminder_requires_time_of_day';
        end if;
        if v_reminder_type is null or v_reminder_type not in ('general', 'medication', 'hydration', 'appointment', 'meal', 'exercise', 'other') then
            raise exception 'invalid_reminder_type';
        end if;
        if v_no_response is null or v_no_response < 1 or v_no_response > 120 then
            raise exception 'invalid_no_response_minutes';
        end if;
        if v_due_offset is not null then
            raise exception 'reminder_cannot_have_due_offset';
        end if;
        -- Documented safe range for a reminder's start offset -- see
        -- migration header. Task items have no equivalent upper bound
        -- (unchanged).
        if v_start_offset > 90 then
            raise exception 'invalid_start_offset';
        end if;

        insert into public.routine_template_items (
            template_id, item_kind, display_order, title, notes, enabled_by_default,
            frequency, days_of_week, start_offset_days, due_offset_days,
            reminder_type, time_of_day, no_response_minutes
        ) values (
            p_template_id, 'reminder', p_order, v_title, v_notes, v_enabled,
            v_frequency, v_days, v_start_offset, null,
            v_reminder_type, v_time_of_day, v_no_response
        );
    else
        if v_frequency is null or v_frequency not in ('one_time', 'daily', 'weekdays', 'weekends', 'custom') then
            raise exception 'invalid_frequency';
        end if;
        if v_time_of_day is not null then
            raise exception 'task_cannot_have_time_of_day';
        end if;
        if v_no_response is not null then
            raise exception 'task_cannot_have_no_response_minutes';
        end if;
        if v_frequency = 'one_time' then
            if cardinality(v_days) <> 0 then
                raise exception 'one_time_task_cannot_have_days_of_week';
            end if;
        else
            if cardinality(v_days) < 1 or cardinality(v_days) > 7 or not (v_days <@ array[1,2,3,4,5,6,7]) then
                raise exception 'invalid_days_of_week';
            end if;
            if v_due_offset is not null then
                raise exception 'recurring_task_cannot_have_due_offset';
            end if;
        end if;

        insert into public.routine_template_items (
            template_id, item_kind, display_order, title, notes, enabled_by_default,
            frequency, days_of_week, start_offset_days, due_offset_days,
            reminder_type, time_of_day, no_response_minutes
        ) values (
            p_template_id, 'task', p_order, v_title, v_notes, v_enabled,
            v_frequency, v_days, v_start_offset, v_due_offset,
            null, null, null
        );
    end if;
end;
$function$;

revoke all on function public._insert_routine_template_item(uuid, integer, jsonb) from public, anon, authenticated;

create or replace function public.apply_routine_template(p_connection_id uuid, p_source_template_id uuid, p_source_template_revision integer, p_built_in_pack_id text, p_built_in_pack_version text, p_title text, p_start_date date, p_items jsonb, p_apply_request_id text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
declare
    v_organizer_id uuid := auth.uid();
    v_profile public.profiles%rowtype;
    v_connection public.connections%rowtype;
    v_participant public.profiles%rowtype;
    v_template public.routine_templates%rowtype;
    v_existing public.routine_instances%rowtype;
    v_instance public.routine_instances%rowtype;
    v_item jsonb;
    v_idx integer := 0;
    v_item_count integer;
    v_kind text;
    v_title text;
    v_notes text;
    v_reminder public.reminders%rowtype;
    v_task public.tasks%rowtype;
    v_days integer[];
    v_time_of_day time;
    v_reminder_type text;
    v_no_response integer;
    v_frequency text;
    v_created boolean;
    v_start_offset integer;
    v_target_date date;
    v_reminder_instant timestamptz;
begin
    if v_organizer_id is null then
        raise exception 'authentication_required';
    end if;

    if p_apply_request_id is null or btrim(p_apply_request_id) = '' then
        raise exception 'invalid_apply_request_id';
    end if;
    if p_title is null or btrim(p_title) = '' or char_length(p_title) > 200 then
        raise exception 'invalid_title';
    end if;
    if p_start_date is null then
        raise exception 'invalid_start_date';
    end if;
    if (p_source_template_id is null) = (p_built_in_pack_id is null) then
        raise exception 'invalid_source';
    end if;

    v_item_count := jsonb_array_length(coalesce(p_items, '[]'::jsonb));
    if v_item_count < 1 or v_item_count > 20 then
        raise exception 'invalid_item_count';
    end if;

    select * into v_existing from public.routine_instances
    where organizer_id = v_organizer_id and apply_request_id = p_apply_request_id;
    if found then
        return public._routine_instance_summary(v_existing.id) || jsonb_build_object('alreadyExisted', true);
    end if;

    select * into v_profile from public.profiles where id = v_organizer_id;
    if not found or v_profile.account_status <> 'active' then
        raise exception 'not_authorized';
    end if;
    if v_profile.role is distinct from 'caregiver' then
        raise exception 'organizer_role_required';
    end if;

    select * into v_connection from public.connections where id = p_connection_id for share;
    if not found or v_connection.caregiver_id <> v_organizer_id or v_connection.status <> 'accepted' or v_connection.accepted_at is null then
        raise exception 'connection_inactive';
    end if;

    select * into v_participant from public.profiles where id = v_connection.recipient_id;
    if not found or v_participant.account_status <> 'active' then
        raise exception 'not_authorized';
    end if;
    if not public._is_valid_iana_timezone(v_participant.timezone) then
        raise exception 'participant_timezone_unavailable';
    end if;

    if p_source_template_id is not null then
        select * into v_template from public.routine_templates where id = p_source_template_id;
        if not found or v_template.owner_id <> v_organizer_id then
            raise exception 'template_not_found';
        end if;
        if v_template.status <> 'active' then
            raise exception 'template_archived';
        end if;
        if p_source_template_revision is not null and p_source_template_revision <> v_template.revision then
            raise exception 'template_revision_changed';
        end if;
    end if;

    insert into public.routine_instances (
        organizer_id, participant_id, connection_id, title,
        source_template_id, built_in_pack_id, source_version,
        participant_timezone_snapshot, start_date, apply_request_id
    ) values (
        v_organizer_id, v_connection.recipient_id, p_connection_id, btrim(p_title),
        p_source_template_id, p_built_in_pack_id, coalesce(p_built_in_pack_version, '1'),
        v_participant.timezone, p_start_date, p_apply_request_id
    )
    on conflict (organizer_id, apply_request_id) do nothing
    returning * into v_instance;

    v_created := found;

    if not v_created then
        select * into v_existing from public.routine_instances
        where organizer_id = v_organizer_id and apply_request_id = p_apply_request_id;
        return public._routine_instance_summary(v_existing.id) || jsonb_build_object('alreadyExisted', true);
    end if;

    for v_item in select * from jsonb_array_elements(p_items)
    loop
        v_idx := v_idx + 1;
        v_kind := v_item->>'item_kind';
        v_title := btrim(coalesce(v_item->>'title', ''));
        v_notes := nullif(btrim(coalesce(v_item->>'notes', '')), '');

        if v_title = '' or char_length(v_title) > 200 then
            raise exception 'invalid_item_title';
        end if;
        if v_notes is not null and char_length(v_notes) > 2000 then
            raise exception 'invalid_item_notes';
        end if;

        if v_kind = 'reminder' then
            select coalesce(array_agg(x::int order by x), '{}') into v_days
            from jsonb_array_elements_text(coalesce(v_item->'days_of_week', '[]'::jsonb)) as x;

            v_frequency := v_item->>'frequency';
            v_time_of_day := nullif(v_item->>'time_of_day', '')::time;
            v_reminder_type := nullif(v_item->>'reminder_type', '');
            v_no_response := nullif(v_item->>'no_response_minutes', '')::integer;
            v_start_offset := coalesce((v_item->>'start_offset_days')::integer, 0);

            -- Mirrors _insert_routine_template_item's reminder validation
            -- exactly (see migrations 20260730000000/20260731000000) --
            -- every apply-time reminder item is independently re-validated
            -- here regardless of source, never left to fall through to a
            -- raw constraint-violation error.
            if v_frequency is null or v_frequency not in ('daily', 'weekdays', 'weekends', 'custom') then
                raise exception 'invalid_frequency';
            end if;
            if cardinality(v_days) < 1 or cardinality(v_days) > 7 or not (v_days <@ array[1,2,3,4,5,6,7]) then
                raise exception 'invalid_days_of_week';
            end if;
            if v_time_of_day is null then
                raise exception 'reminder_requires_time_of_day';
            end if;
            if v_reminder_type is null or v_reminder_type not in ('general', 'medication', 'hydration', 'appointment', 'meal', 'exercise', 'other') then
                raise exception 'invalid_reminder_type';
            end if;
            if v_no_response is null or v_no_response < 1 or v_no_response > 120 then
                raise exception 'invalid_no_response_minutes';
            end if;
            -- Negative offsets are rejected outright (no supported concept
            -- of a reminder starting before the routine's own start date);
            -- 90 days is the documented safe upper bound.
            if v_start_offset < 0 or v_start_offset > 90 then
                raise exception 'invalid_start_offset';
            end if;

            -- Pure calendar-date arithmetic (date + integer) -- zero DST
            -- exposure, a `date` has no time-zone component at all. Only
            -- the conversion of that resulting calendar date's participant-
            -- local midnight into a concrete instant involves a time zone,
            -- and `at time zone` is DST-aware by construction (the same
            -- pattern already used by claim_due_recipient_reminder_
            -- deliveries/sync_missed_reminders_db's own scheduled_for
            -- computation). The reminder's existing, unmodified eligibility
            -- gate (`occ.scheduled_for >= greatest(r.created_at,
            -- c.accepted_at)` in both of those functions, and the
            -- equivalent check in respond_to_reminder_occurrence) is what
            -- makes this authoritative: setting created_at to this instant
            -- is sufficient on its own to prevent any push/response/missed-
            -- detection before the intended start date -- no other
            -- function needed to change.
            v_target_date := p_start_date + v_start_offset;
            v_reminder_instant := (v_target_date::timestamp) at time zone v_participant.timezone;

            insert into public.reminders (
                connection_id, caregiver_id, recipient_id, title, reminder_type, notes,
                time_of_day, frequency, days_of_week, no_response_minutes,
                created_at, updated_at
            ) values (
                p_connection_id, v_organizer_id, v_connection.recipient_id,
                v_title, v_reminder_type, v_notes,
                v_time_of_day, v_frequency, v_days, v_no_response,
                v_reminder_instant, v_reminder_instant
            )
            returning * into v_reminder;

            insert into public.routine_instance_items (routine_instance_id, source_item_key, item_kind, reminder_id, display_order)
            values (v_instance.id, v_item->>'source_item_key', 'reminder', v_reminder.id, v_idx);

        elsif v_kind = 'task' then
            v_task := public._create_task_core(
                p_connection_id, v_organizer_id, v_connection.recipient_id,
                v_title, v_notes,
                v_item->>'frequency',
                (select coalesce(array_agg(x::int order by x), '{}') from jsonb_array_elements_text(coalesce(v_item->'days_of_week', '[]'::jsonb)) as x),
                nullif(v_item->>'start_date', '')::date,
                nullif(v_item->>'due_date', '')::date,
                nullif(v_item->>'recurrence_end_date', '')::date,
                true
            );

            insert into public.routine_instance_items (routine_instance_id, source_item_key, item_kind, task_id, display_order)
            values (v_instance.id, v_item->>'source_item_key', 'task', v_task.id, v_idx);
        else
            raise exception 'invalid_item_kind';
        end if;
    end loop;

    insert into public.routine_notification_deliveries (routine_instance_id, recipient_id)
    values (v_instance.id, v_connection.recipient_id);

    return public._routine_instance_summary(v_instance.id) || jsonb_build_object('alreadyExisted', false);
end;
$function$;

revoke all on function public.apply_routine_template(uuid, uuid, integer, text, text, text, date, jsonb, text) from public, anon;
grant execute on function public.apply_routine_template(uuid, uuid, integer, text, text, text, date, jsonb, text) to authenticated;

-- ═══ 7. create_invite_code: capture relationship_pair at invite time ═════
--
-- New optional parameter (default null) -- an old client omitting it
-- behaves byte-for-byte as before (no relationship recorded, exactly
-- today's behavior). Validated server-side against the same fixed
-- vocabulary as the new connections check constraint (never trust the
-- client's own picker to have sent a legal value). Signature changes
-- (new parameter, new output column) so CREATE OR REPLACE is not
-- permitted -- DROP + CREATE, matching the established convention in
-- 20260801040000_activity_feed_organizer_deleted_state.sql.

drop function if exists public.create_invite_code(uuid);

create function public.create_invite_code(p_existing_connection_id uuid default null, p_relationship_pair text default null)
returns table(id uuid, invite_code text, expires_at timestamptz, relationship_pair text)
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
declare
  v_code text;
  v_random_bytes bytea;
  v_expires_at timestamptz := now() + interval '7 days';
  v_id uuid;
  v_attempt int := 0;
  v_byte_index int;
  v_active_count int;
  v_profile public.profiles%rowtype;
  v_relationship_pair text;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_relationship_pair is not null and p_relationship_pair not in (
    'parent_child', 'trainer_client', 'coach_athlete', 'caregiver_family_member',
    'tutor_student', 'mentor_mentee', 'manager_team_member', 'provider_patient',
    'accountability_partner', 'family_member_family_member', 'other'
  ) then
    raise exception 'invalid_relationship_pair';
  end if;
  v_relationship_pair := p_relationship_pair;

  select * into v_profile from public.profiles p where p.id = auth.uid() for update;

  if not found or v_profile.role <> 'caregiver' or v_profile.account_status <> 'active' then
    raise exception 'only active caregivers can create invite codes';
  end if;

  loop
    v_attempt := v_attempt + 1;
    v_random_bytes := gen_random_bytes(6);
    v_code := '';
    for v_byte_index in 0..5 loop
      v_code := v_code || substr(
        'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
        (get_byte(v_random_bytes, v_byte_index) % 32) + 1,
        1
      );
    end loop;

    exit when not exists (select 1 from public.connections c where c.invite_code = v_code);
    if v_attempt > 10 then
      raise exception 'could not generate a unique invite code, try again';
    end if;
  end loop;

  if p_existing_connection_id is not null then
    update public.connections c
    set invite_code = v_code, expires_at = v_expires_at, relationship_pair = v_relationship_pair
    where c.id = p_existing_connection_id
      and c.caregiver_id = auth.uid()
      and c.status = 'pending'
    returning c.id into v_id;
  end if;

  if v_id is null then
    select count(*) into v_active_count
    from public.connections c
    where c.caregiver_id = auth.uid()
      and (
        c.status = 'accepted'
        or (c.status = 'pending' and (c.expires_at is null or c.expires_at >= now()))
      );

    if v_active_count >= 5 then
      raise exception 'participant_limit_reached';
    end if;

    insert into public.connections as c (caregiver_id, invite_code, status, expires_at, relationship_pair)
    values (auth.uid(), v_code, 'pending', v_expires_at, v_relationship_pair)
    returning c.id into v_id;
  end if;

  return query select v_id, v_code, v_expires_at, v_relationship_pair;
end;
$function$;

comment on function public.create_invite_code(uuid, text) is
  'Organizer-only. Generates (or regenerates, if p_existing_connection_id is given) a pending invite code, optionally tagged with a relationship_pair for the participant who accepts it to see (via preview_invite_code) before accepting. p_relationship_pair is validated server-side against a fixed vocabulary and defaults to null ("relationship unspecified") for full backward compatibility with any caller that omits it.';

revoke all on function public.create_invite_code(uuid, text) from public, anon;
grant execute on function public.create_invite_code(uuid, text) to authenticated, service_role;

-- ═══ 8. preview_invite_code: read-only, non-consuming invite preview ═════
--
-- New RPC closing the "participant sees who invited them AND the proposed
-- relationship before accepting" requirement without weakening invite
-- security: requires the caller to already know the exact 6-character
-- code (same 32^6 search space accept_invite_code has always required --
-- no new brute-force surface), requires authentication, and -- critically
-- -- never mutates the row (no UPDATE, no status/timestamp change), so
-- previewing a code carries none of accept_invite_code's real, consequential
-- side effect (irreversibly consuming the invite and creating a
-- connection). Returns the exact same not_found/self/already_accepted/
-- expired status vocabulary as accept_invite_code for a code that isn't
-- currently previewable, and only reveals organizer_full_name/
-- relationship_pair on a genuinely valid, still-pending, not-yet-expired
-- code belonging to someone else -- the same information-disclosure
-- boundary accept_invite_code already has (you already had to supply the
-- exact code to learn anything at all).

create or replace function public.preview_invite_code(p_code text)
returns table(status text, organizer_full_name text, relationship_pair text)
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
declare
  v_caregiver_id uuid;
  v_status text;
  v_expires_at timestamptz;
  v_recipient_id uuid;
  v_relationship_pair text;
  v_organizer_name text;
begin
  if auth.uid() is null then
    raise exception 'authentication_required';
  end if;

  if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.account_status = 'active') then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;

  -- Every column read here is qualified with the table name -- `status`
  -- and `relationship_pair` are also this function's own OUT parameters
  -- (RETURNS TABLE implicitly declares them as PL/pgSQL variables in
  -- scope), and an unqualified reference would be genuinely ambiguous
  -- between the two. This exact bug class has bitten this codebase twice
  -- before (see 20260723184443_fix_create_invite_code_column_ambiguity.sql
  -- and 20260801090000_fix_overdue_rpc_column_ambiguity.sql) -- qualified
  -- here from the start rather than discovered live.
  select connections.caregiver_id, connections.status, connections.expires_at, connections.recipient_id, connections.relationship_pair
  into v_caregiver_id, v_status, v_expires_at, v_recipient_id, v_relationship_pair
  from public.connections
  where invite_code = p_code;

  if v_caregiver_id is null then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;

  if v_caregiver_id = auth.uid() then
    return query select 'self'::text, null::text, null::text;
    return;
  end if;

  if v_status = 'accepted' or v_recipient_id is not null then
    return query select 'already_accepted'::text, null::text, null::text;
    return;
  end if;

  if v_status <> 'pending' then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;

  if v_expires_at is not null and v_expires_at < now() then
    return query select 'expired'::text, null::text, null::text;
    return;
  end if;

  select full_name into v_organizer_name from public.profiles where id = v_caregiver_id;

  return query select 'valid'::text, v_organizer_name, v_relationship_pair;
end;
$function$;

comment on function public.preview_invite_code(text) is
  'Participant-facing, read-only. Never mutates connections -- a genuine second RPC call for a genuine second purpose alongside accept_invite_code, not a refactor of it. Returns organizer_full_name/relationship_pair only for a currently-valid, not-yet-accepted, not-yet-expired code that does not belong to the caller, matching accept_invite_code''s exact same not_found/self/already_accepted/expired classification for every other case.';

revoke all on function public.preview_invite_code(text) from public, anon;
grant execute on function public.preview_invite_code(text) to authenticated;

-- ═══ 9. get_my_organizer_connections_summary: expose relationship_pair ═══
--
-- Adds one nullable output column. Return type changes so CREATE OR
-- REPLACE is not permitted -- DROP + CREATE, body otherwise byte-identical
-- to 20260801030000_multi_organizer_deletion_and_summary.sql's version.
-- relationship_pair here is the participant's own connection's value,
-- read through the same existing `c.recipient_id = auth.uid()` scoping --
-- no new information-disclosure surface (a participant already sees every
-- other column of their own accepted connections here).

drop function if exists public.get_my_organizer_connections_summary();

create function public.get_my_organizer_connections_summary()
returns table(connection_id uuid, status text, accepted_at timestamptz, organizer_id uuid, organizer_full_name text, organizer_account_status text, organizer_deleted_at timestamptz, relationship_pair text, active_reminder_count bigint, active_task_count bigint, active_routine_count bigint)
language sql
stable security definer
set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
    select
        c.id,
        c.status,
        c.accepted_at,
        p.id,
        p.full_name,
        p.account_status,
        p.deleted_at,
        c.relationship_pair,
        coalesce(r.cnt, 0),
        coalesce(t.cnt, 0),
        coalesce(ri.cnt, 0)
    from public.connections c
    join public.profiles p on p.id = c.caregiver_id
    left join lateral (
        select count(*) as cnt from public.reminders where connection_id = c.id and is_active
    ) r on true
    left join lateral (
        select count(*) as cnt from public.tasks where connection_id = c.id and is_active
    ) t on true
    left join lateral (
        select count(*) as cnt from public.routine_instances where connection_id = c.id and status = 'active'
    ) ri on true
    where c.recipient_id = auth.uid()
    order by (c.status = 'accepted') desc, c.accepted_at desc nulls last, c.created_at desc;
$function$;

revoke all on function public.get_my_organizer_connections_summary() from public, anon;
grant execute on function public.get_my_organizer_connections_summary() to authenticated;

-- ═══ Rollback ═════════════════════════════════════════════════════════════
-- drop function if exists public.get_my_organizer_connections_summary();
-- restore get_my_organizer_connections_summary() from 20260801030000_multi_organizer_deletion_and_summary.sql.
-- drop function if exists public.preview_invite_code(text);
-- drop function if exists public.create_invite_code(uuid, text);
-- restore create_invite_code(uuid) from 20260727010000_fix_create_invite_code_ambiguity_again.sql.
-- restore apply_routine_template/_insert_routine_template_item/update_reminder_schedule bodies from 20260731000000_reminder_start_offset_days.sql.
-- alter table public.reminders alter column reminder_type set default 'medication';
-- alter table public.reminders drop constraint reminders_reminder_type_check;
-- alter table public.reminders add constraint reminders_reminder_type_check check (reminder_type = any(array['medication','hydration','appointment','meal','exercise','other']));
-- restore create_routine_template/update_routine_template bodies from 20260730000000_routine_templates_and_instances.sql.
-- alter table public.routine_templates drop constraint routine_templates_use_case_check;
-- alter table public.routine_templates add constraint routine_templates_use_case_check check (use_case is null or use_case = any(array['care','family','coaching','team','personal','other']));
-- alter table public.profiles drop constraint profiles_use_case_check;
-- alter table public.profiles add constraint profiles_use_case_check check (use_case is null or use_case in ('care','family','coaching','team','personal','other'));
-- alter table public.connections drop constraint connections_relationship_pair_check;
-- alter table public.connections drop column relationship_pair;
