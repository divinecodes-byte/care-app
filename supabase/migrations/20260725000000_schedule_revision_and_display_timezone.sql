-- Week 1 launch hardening task #8: recipient-timezone display consistency
-- and race-proof reminder schedule editing.
--
-- Two confirmed residual risks from the prior reminder-lifecycle task:
--
-- 1. Caregiver-facing screens (caregiver-dashboard.tsx, reminder-details.tsx)
--    computed pending/missed/future status using the CAREGIVER's own device
--    clock, not the connected recipient's stored profiles.timezone. Fixed
--    client-side (this migration adds no schema for that half) by fetching
--    the recipient's timezone and using new Intl-based zoned helpers.
--
-- 2. clear_stale_reminder_deliveries() (added in the prior task) ran as a
--    second, separate, best-effort RPC call after the reminders UPDATE had
--    already committed -- not atomic with the edit, and it DELETED the
--    stale row rather than updating it in place, meaning a claim racing
--    the delete/edit could still slip through with no schedule-revision
--    check at all. This migration replaces that two-step flow with one
--    RPC (update_reminder_schedule) that edits the reminder AND reconciles
--    today's unsent delivery row in the same transaction, and adds a
--    schedule_version counter the Edge Function can check immediately
--    before every send.

-- ── 1. Schedule revision counter ─────────────────────────────────────────

alter table public.reminders
  add column schedule_version integer not null default 1;

comment on column public.reminders.schedule_version is
  'Incremented by update_reminder_schedule() whenever a schedule-affecting field (time_of_day, days_of_week, no_response_minutes) actually changes value. A claimed reminder_notification_deliveries row copies the reminder''s schedule_version at claim time; send-due-recipient-reminders compares it immediately before sending and skips (stale_schedule) on any mismatch.';

alter table public.reminder_notification_deliveries
  add column schedule_version integer not null default 1;

comment on column public.reminder_notification_deliveries.schedule_version is
  'Copied from reminders.schedule_version at claim time. Only meaningful for delivery_type=''reminder'' -- a snooze delivery''s scheduled_for (snoozed_until) is an independent recipient commitment, not derived from the reminder''s general schedule, so it is never gated on this value.';

-- ── 2. Claim functions now copy the current schedule_version ────────────

create or replace function public.claim_due_recipient_reminder_deliveries()
returns setof reminder_notification_deliveries
language sql
security definer
set search_path = public, extensions, pg_catalog
as $$
  insert into public.reminder_notification_deliveries
    (reminder_id, recipient_id, occurrence_date, scheduled_for, delivery_type, status, schedule_version)
  select
    r.id,
    r.recipient_id,
    occ.occurrence_date,
    occ.scheduled_for,
    'reminder',
    'pending',
    r.schedule_version
  from public.reminders r
  join public.connections c on c.id = r.connection_id
  join public.profiles p on p.id = r.recipient_id
  cross join lateral (
    select
      (now() at time zone p.timezone)::date as occurrence_date,
      (((now() at time zone p.timezone)::date::timestamp + r.time_of_day) at time zone p.timezone) as scheduled_for
  ) occ
  left join public.reminder_logs rl
    on rl.reminder_id = r.id and rl.occurrence_date = occ.occurrence_date
  where r.is_active = true
    and c.status = 'accepted'
    and c.accepted_at is not null
    and p.server_push_enabled = true
    and extract(isodow from (now() at time zone p.timezone))::integer = any(r.days_of_week)
    and occ.scheduled_for >= greatest(r.created_at, c.accepted_at)
    and now() >= occ.scheduled_for
    and now() <  occ.scheduled_for + make_interval(mins => r.no_response_minutes)
    and (rl.status is null or rl.status = 'pending')
  on conflict (reminder_id, occurrence_date, delivery_type) do nothing
  returning *;
$$;

create or replace function public.claim_due_recipient_snooze_deliveries()
returns setof reminder_notification_deliveries
language sql
security definer
set search_path = public, extensions, pg_catalog
as $$
  insert into public.reminder_notification_deliveries
    (reminder_id, recipient_id, occurrence_date, scheduled_for, delivery_type, status, schedule_version)
  select
    rl.reminder_id,
    rl.recipient_id,
    rl.occurrence_date,
    rl.snoozed_until,
    'snooze',
    'pending',
    r.schedule_version
  from public.reminder_logs rl
  join public.reminders r on r.id = rl.reminder_id
  join public.connections c on c.id = r.connection_id
  join public.profiles p on p.id = rl.recipient_id
  where rl.status = 'snoozed'
    and rl.snoozed_until is not null
    and rl.snoozed_until <= now()
    and r.is_active = true
    and c.status = 'accepted'
    and c.accepted_at is not null
    and p.server_push_enabled = true
  on conflict (reminder_id, occurrence_date, delivery_type) do nothing
  returning *;
$$;

-- ── 3. update_reminder_schedule: the sole reminder-edit write path ──────
-- Replaces edit-reminder.tsx's two-step (plain UPDATE, then a separate
-- best-effort clear_stale_reminder_deliveries call) with one transaction:
-- the reminder is updated, schedule_version is bumped only if a
-- schedule-affecting field actually changed, and -- only when it did --
-- today's still-unsent 'reminder'-type delivery row (if any) is
-- reconciled in place: updated to the new scheduled_for/schedule_version
-- if today is still eligible under the new schedule, or removed if today
-- is no longer eligible. A 'sent' or 'skipped' row is never touched --
-- already-sent occurrences stay terminal, and reactivating a skipped row
-- is deliberately out of scope for an ordinary edit (see
-- docs/reminder-editing-model.md).
create or replace function public.update_reminder_schedule(
  p_reminder_id uuid,
  p_title text,
  p_reminder_type text,
  p_notes text,
  p_time_of_day time,
  p_frequency text,
  p_days_of_week int[],
  p_no_response_minutes int
)
returns public.reminders
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
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

  if p_reminder_type not in ('medication', 'hydration', 'appointment', 'meal', 'exercise', 'other') then
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
$$;

revoke all on function public.update_reminder_schedule(uuid, text, text, text, time, text, int[], int) from public, anon;
grant execute on function public.update_reminder_schedule(uuid, text, text, text, time, text, int[], int) to authenticated;
