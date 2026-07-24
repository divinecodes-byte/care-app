-- Week 1 launch hardening task #8, Phase 8: final-send validation,
-- performed natively in Postgres rather than reimplemented in the Edge
-- Function's Deno/JS runtime. This is a deliberate design choice: the
-- claim functions already compute occurrence eligibility and scheduled_for
-- via Postgres's own `AT TIME ZONE` operator, and reimplementing the same
-- timezone math in JS would risk the two disagreeing at a DST boundary or
-- some other edge case Postgres's tz database already handles correctly.
-- One SQL function, one source of truth for "is this claimed delivery
-- still valid right now," callable in a single batched round trip
-- immediately before send-due-recipient-reminders builds any Expo message.
create or replace function public.validate_reminder_deliveries_for_send(p_delivery_ids uuid[])
returns table (delivery_id uuid, ok boolean, skip_code text)
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_id uuid;
  v_delivery public.reminder_notification_deliveries%rowtype;
  v_reminder public.reminders%rowtype;
  v_connection public.connections%rowtype;
  v_tz text;
  v_log_status text;
  v_expected_scheduled_for timestamptz;
  v_isodow int;
begin
  foreach v_id in array p_delivery_ids loop
    select * into v_delivery from public.reminder_notification_deliveries where id = v_id;
    if not found then
      delivery_id := v_id; ok := false; skip_code := 'reminder_not_found';
      return next; continue;
    end if;

    select * into v_reminder from public.reminders where id = v_delivery.reminder_id;
    if not found then
      delivery_id := v_id; ok := false; skip_code := 'reminder_not_found';
      return next; continue;
    end if;

    if not v_reminder.is_active then
      delivery_id := v_id; ok := false; skip_code := 'reminder_inactive';
      return next; continue;
    end if;

    if v_reminder.recipient_id <> v_delivery.recipient_id then
      delivery_id := v_id; ok := false; skip_code := 'reminder_reassigned';
      return next; continue;
    end if;

    select * into v_connection from public.connections where id = v_reminder.connection_id;
    if not found or v_connection.status <> 'accepted' or v_connection.accepted_at is null then
      delivery_id := v_id; ok := false; skip_code := 'connection_inactive';
      return next; continue;
    end if;

    select status into v_log_status
    from public.reminder_logs
    where reminder_id = v_delivery.reminder_id and occurrence_date = v_delivery.occurrence_date;

    if v_delivery.delivery_type = 'snooze' then
      -- A snoozed re-alert's scheduled_for (snoozed_until) is the
      -- recipient's own prior commitment, independent of the reminder's
      -- general schedule -- it is never gated on schedule_version or
      -- recomputed against time_of_day, only on the occurrence still
      -- genuinely being unanswered.
      if v_log_status is distinct from 'snoozed' then
        delivery_id := v_id; ok := false; skip_code := 'occurrence_answered';
        return next; continue;
      end if;
      delivery_id := v_id; ok := true; skip_code := null;
      return next; continue;
    end if;

    -- delivery_type = 'reminder' from here on.
    if v_log_status is not null and v_log_status <> 'pending' then
      delivery_id := v_id; ok := false; skip_code := 'occurrence_answered';
      return next; continue;
    end if;

    if v_delivery.schedule_version <> v_reminder.schedule_version then
      delivery_id := v_id; ok := false; skip_code := 'stale_schedule';
      return next; continue;
    end if;

    select timezone into v_tz from public.profiles where id = v_delivery.recipient_id;
    if v_tz is null then
      delivery_id := v_id; ok := false; skip_code := 'reminder_not_found';
      return next; continue;
    end if;

    -- Defense-in-depth beyond the version check: a timezone sync (not a
    -- schedule edit, so it never touches schedule_version) between claim
    -- and send could also make the claimed scheduled_for stale.
    v_expected_scheduled_for := ((v_delivery.occurrence_date::timestamp + v_reminder.time_of_day) at time zone v_tz);
    if v_delivery.scheduled_for <> v_expected_scheduled_for then
      delivery_id := v_id; ok := false; skip_code := 'stale_schedule';
      return next; continue;
    end if;

    -- occurrence_date is already a specific calendar day -- its ISO
    -- weekday needs no timezone conversion.
    v_isodow := extract(isodow from v_delivery.occurrence_date)::int;
    if not (v_isodow = any(v_reminder.days_of_week)) then
      delivery_id := v_id; ok := false; skip_code := 'occurrence_ineligible';
      return next; continue;
    end if;

    delivery_id := v_id; ok := true; skip_code := null;
    return next;
  end loop;
end;
$$;

revoke all on function public.validate_reminder_deliveries_for_send(uuid[]) from public, anon, authenticated;
grant execute on function public.validate_reminder_deliveries_for_send(uuid[]) to service_role;

-- Document the now-larger error_code vocabulary (existing column, comment
-- updated to include the three codes this task adds).
comment on column public.reminder_notification_deliveries.error_code is
  'Normalized internal code: no_active_push_token | device_not_registered | expo_ticket_error | expo_batch_error | reminder_not_found | reminder_inactive | reminder_reassigned | connection_inactive | stale_schedule | occurrence_ineligible | occurrence_answered | internal_error. Null for status=sent. Prefer this over parsing error_message for any programmatic check.';
