-- Week 3 product-expansion task #3 correctness closure: reminder template
-- items' start_offset_days was accepted and stored (routine_template_items
-- already has the column, _insert_routine_template_item already validated
-- it as >= 0 for both kinds) but silently dropped at apply time -- the
-- apply_routine_template reminder branch never read it, so a personal
-- template's reminder item with a nonzero offset produced a reminder that
-- started immediately regardless of the configured offset. This is a
-- "silently accepted and ignored configuration" bug, not a documented
-- product limitation, and is fixed here.
--
-- Reminders have no start_date column at all (unlike tasks) -- their
-- eligibility is governed entirely by `days_of_week` plus `created_at`
-- (see claim_due_recipient_reminder_deliveries, sync_missed_reminders_db,
-- and respond_to_reminder_occurrence, all of which already gate on
-- `occ.scheduled_for >= greatest(r.created_at, c.accepted_at)` or the
-- equivalent). This is exactly the existing, unmodified lever a start
-- offset needs: apply_routine_template now computes the reminder's
-- intended first-eligible calendar date (`p_start_date + start_offset_days`,
-- pure `date` arithmetic -- zero DST exposure, since a `date` has no time
-- zone component at all) and converts *that date's participant-local
-- midnight* into the correct UTC instant via `at time zone` (the same
-- DST-aware conversion already used throughout this codebase's reminder
-- scheduling), then inserts the reminder with that instant as its
-- `created_at`/`updated_at`. No new column, no new eligibility branch, no
-- change to respond_to_reminder_occurrence / claim_due_recipient_reminder_
-- deliveries / sync_missed_reminders_db -- every one of them already
-- treats a future-dated `created_at` as "not yet started" for free.
--
-- Documented safe range: 0-90 days (a routine's reminder cannot be
-- scheduled to start more than three months out). Negative offsets are
-- rejected -- there is no supported "reminder started before the routine's
-- own start date" concept. Task start-offset handling is completely
-- unchanged (tasks already resolve their own absolute start_date
-- client-side via pure calendar-date arithmetic and send it directly;
-- this migration touches only the reminder branch).

create or replace function public._insert_routine_template_item(p_template_id uuid, p_order integer, p_item jsonb)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
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
        if v_reminder_type is null or v_reminder_type not in ('medication', 'hydration', 'appointment', 'meal', 'exercise', 'other') then
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
$$;
revoke all on function public._insert_routine_template_item(uuid, integer, jsonb) from public, anon, authenticated;

create or replace function public.apply_routine_template(
    p_connection_id uuid,
    p_source_template_id uuid,
    p_source_template_revision integer,
    p_built_in_pack_id text,
    p_built_in_pack_version text,
    p_title text,
    p_start_date date,
    p_items jsonb,
    p_apply_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
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
            if v_reminder_type is null or v_reminder_type not in ('medication', 'hydration', 'appointment', 'meal', 'exercise', 'other') then
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
$$;
revoke all on function public.apply_routine_template(uuid, uuid, integer, text, text, text, date, jsonb, text) from public, anon;
grant execute on function public.apply_routine_template(uuid, uuid, integer, text, text, text, date, jsonb, text) to authenticated;

-- ─── Rollback ───────────────────────────────────────────────────────────────
-- Restores both functions to their pre-offset bodies from migration
-- 20260730010000 (reminder created_at always defaults to now(), no
-- start-offset upper bound in _insert_routine_template_item).
