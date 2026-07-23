-- Week 1 launch hardening task #7 follow-up: close a TOCTOU race in
-- respond_to_reminder_occurrence found while designing its own concurrency
-- tests (Phase 4, scenarios 5/6 — "caregiver deactivates while recipient
-- responds" / "connection ends while recipient responds").
--
-- The original version SELECTed reminders/connections with no row lock,
-- then only took a `for update` lock on reminder_logs afterward. Under
-- READ COMMITTED (Postgres's default), a concurrent deactivation or
-- connection-ending could commit in the gap between that early SELECT and
-- the final insert/update, and this function would still proceed using
-- the now-stale is_active/status values it read earlier — successfully
-- recording a response against a reminder that had, by the time the write
-- actually happened, already been deactivated.
--
-- Fixed by taking `for share` locks on the reminders and connections rows
-- at read time. This doesn't block concurrent readers, only serializes
-- against a concurrent UPDATE to either row: whichever transaction (this
-- one, or a deactivation/connection-end) acquires its lock first is seen
-- in full by the other before it proceeds, making the interaction
-- deterministic instead of racy.
create or replace function public.respond_to_reminder_occurrence(
  p_reminder_id uuid,
  p_status text,
  p_snooze_minutes int default 10
)
returns public.reminder_logs
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_recipient_id uuid := auth.uid();
  v_tz text;
  v_reminder public.reminders%rowtype;
  v_connection public.connections%rowtype;
  v_occurrence_date date;
  v_scheduled_for timestamptz;
  v_existing public.reminder_logs%rowtype;
  v_snooze_minutes int := coalesce(p_snooze_minutes, 10);
  v_completed_at timestamptz;
  v_snoozed_until timestamptz;
  v_result public.reminder_logs%rowtype;
begin
  if v_recipient_id is null then
    raise exception 'authentication_required';
  end if;

  if p_status not in ('taken', 'skipped', 'snoozed') then
    raise exception 'invalid_status';
  end if;

  if v_snooze_minutes < 1 or v_snooze_minutes > 120 then
    v_snooze_minutes := 10;
  end if;

  select timezone into v_tz from public.profiles where id = v_recipient_id;
  if v_tz is null then
    raise exception 'profile_not_found';
  end if;

  select * into v_reminder from public.reminders where id = p_reminder_id for share;
  if not found then
    raise exception 'reminder_not_found';
  end if;

  if v_reminder.recipient_id <> v_recipient_id then
    raise exception 'not_authorized';
  end if;

  if not v_reminder.is_active then
    raise exception 'reminder_inactive';
  end if;

  select * into v_connection from public.connections where id = v_reminder.connection_id for share;
  if not found or v_connection.status <> 'accepted' or v_connection.accepted_at is null then
    raise exception 'connection_inactive';
  end if;

  v_occurrence_date := (now() at time zone v_tz)::date;
  v_scheduled_for := (((v_occurrence_date::timestamp) + v_reminder.time_of_day) at time zone v_tz);

  if not (extract(isodow from (now() at time zone v_tz))::int = any(v_reminder.days_of_week)) then
    raise exception 'not_eligible_today';
  end if;

  if v_scheduled_for < greatest(v_reminder.created_at, v_connection.accepted_at) then
    raise exception 'not_eligible_yet';
  end if;
  if now() < v_scheduled_for then
    raise exception 'not_eligible_yet';
  end if;

  select * into v_existing
  from public.reminder_logs
  where reminder_id = p_reminder_id and occurrence_date = v_occurrence_date
  for update;

  v_completed_at := case when p_status = 'taken' then now() else null end;
  v_snoozed_until := case when p_status = 'snoozed' then now() + make_interval(mins => v_snooze_minutes) else null end;

  if not found then
    insert into public.reminder_logs (
      reminder_id, connection_id, caregiver_id, recipient_id,
      occurrence_date, scheduled_for, status, completed_at, snoozed_until,
      created_at, updated_at
    ) values (
      p_reminder_id, v_reminder.connection_id, v_reminder.caregiver_id, v_recipient_id,
      v_occurrence_date, v_scheduled_for, p_status, v_completed_at, v_snoozed_until,
      now(), now()
    )
    returning * into v_result;
    return v_result;
  end if;

  if v_existing.status = p_status then
    if p_status in ('taken', 'skipped') then
      return v_existing;
    end if;
    if p_status = 'snoozed' and v_existing.snoozed_until is not null and v_existing.snoozed_until > now() then
      return v_existing;
    end if;
  elsif v_existing.status in ('taken', 'skipped') then
    raise exception 'already_answered';
  end if;

  update public.reminder_logs
  set status = p_status,
      completed_at = v_completed_at,
      snoozed_until = v_snoozed_until,
      updated_at = now()
  where id = v_existing.id
  returning * into v_result;

  return v_result;
end;
$$;

revoke all on function public.respond_to_reminder_occurrence(uuid, text, int) from public, anon;
grant execute on function public.respond_to_reminder_occurrence(uuid, text, int) to authenticated;
