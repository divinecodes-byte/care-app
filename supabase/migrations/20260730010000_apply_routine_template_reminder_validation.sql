-- Follow-up fix to apply_routine_template (migration 20260730000000):
-- the task branch of its item loop delegates to _create_task_core, which
-- fully validates every field before insert and raises a friendly, stable
-- exception on anything invalid. The reminder branch had no equivalent
-- pre-validation at all -- an invalid frequency/reminder_type/days_of_week/
-- no_response_minutes/missing time_of_day would fall straight through to
-- the reminders table's own CHECK constraints, surfacing a raw Postgres
-- constraint-violation message instead of a stable, friendly error code.
-- This violates "every item server-validated" / "no raw SQL errors" from
-- the routine-templates spec. Fixed by mirroring the exact same
-- reminder-field validation _insert_routine_template_item already performs
-- for template items, applied here to apply-time reminder items too.
--
-- No table/column changes; this migration only replaces the function body.

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

            -- Mirrors _insert_routine_template_item's reminder validation
            -- exactly (see migration 20260730000000) -- every apply-time
            -- reminder item is independently re-validated here regardless
            -- of source, never left to fall through to a raw constraint-
            -- violation error.
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

            insert into public.reminders (
                connection_id, caregiver_id, recipient_id, title, reminder_type, notes,
                time_of_day, frequency, days_of_week, no_response_minutes
            ) values (
                p_connection_id, v_organizer_id, v_connection.recipient_id,
                v_title, v_reminder_type, v_notes,
                v_time_of_day, v_frequency, v_days, v_no_response
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
-- Restores the pre-fix function body from migration 20260730000000
-- (reminder items unvalidated before insert).
