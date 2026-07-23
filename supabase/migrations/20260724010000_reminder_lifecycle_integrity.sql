-- Week 1 launch hardening task #7: reminder lifecycle, recurrence,
-- response-state, history, and analytics integrity.
--
-- Audit findings driving this migration (verified live before writing):
--
-- 1. reminder_logs RLS allowed a recipient to directly INSERT/UPDATE their
--    own rows with NO validation of transition legality, occurrence
--    eligibility, reminder.is_active, or connection.status — a client
--    could overwrite a terminal response, respond to an inactive reminder,
--    or respond after its connection ended, and nothing serialized two
--    concurrent responses to the same occurrence (last write wins).
--    recipient-dashboard.tsx and reminder-alert.tsx both did exactly this
--    via raw .upsert() calls. Fixed by respond_to_reminder_occurrence(),
--    a SECURITY DEFINER RPC that validates everything the RLS policy
--    didn't and serializes concurrent callers with `for update`; the old
--    permissive INSERT/UPDATE policies are dropped so this RPC becomes
--    the only write path (SELECT policy is untouched — dashboards still
--    read directly).
--
-- 2. Both the client (recipient-dashboard.tsx, reminder-alert.tsx) AND the
--    server cron (sync_missed_reminders_db) wrote 'missed' rows. The
--    client path's guard ("only upsert if locally-read status was
--    pending") was a read-then-write race, not atomic like the server's
--    `ON CONFLICT ... WHERE status = 'pending'`. Consolidated to
--    server-only authority — the client keeps computing a "missed" status
--    for *instant display* (lib/reminderStatus.ts, unchanged) but no
--    longer persists it.
--
-- 3. sync_missed_reminders_db() had no snoozed-occurrence path at all — an
--    unanswered snooze re-alert stayed 'snoozed' forever, with no
--    transition to 'missed' ever firing. Added, using the reminder's own
--    no_response_minutes as the grace period past snoozed_until (no new
--    field needed). Also excluded snoozed occurrences from the *original*
--    due-reminders branch, which previously had no reminder_logs join at
--    all — adding the snooze branch without this exclusion would have let
--    the same (reminder_id, occurrence_date) key appear twice in one
--    INSERT's source rows, which Postgres rejects
--    ("ON CONFLICT DO UPDATE command cannot affect row a second time").
--
-- 4. Editing a reminder's time_of_day/days_of_week/no_response_minutes
--    (edit-reminder.tsx) never touched any already-claimed-but-unsent
--    reminder_notification_deliveries row for today's occurrence — a
--    stale claim reflecting the pre-edit schedule could still send.
--    clear_stale_reminder_deliveries() lets the caregiver purge exactly
--    that (today's unsent 'reminder'-type delivery only — never a
--    successfully sent one, never a snooze delivery, never another day).

-- ── 1. respond_to_reminder_occurrence: the sole recipient-response write path ──

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

  -- 'missed' and 'pending' are never client-settable -- missed is the
  -- server cron's exclusive authority (see sync_missed_reminders_db
  -- below), and "pending" is simply the absence of a log row.
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

  select * into v_reminder from public.reminders where id = p_reminder_id;
  if not found then
    raise exception 'reminder_not_found';
  end if;

  -- Ownership: a client can only ever respond to their own reminder, never
  -- one addressed to a different recipient.
  if v_reminder.recipient_id <> v_recipient_id then
    raise exception 'not_authorized';
  end if;

  -- Cannot revive/respond to a reminder the caregiver has deactivated.
  if not v_reminder.is_active then
    raise exception 'reminder_inactive';
  end if;

  select * into v_connection from public.connections where id = v_reminder.connection_id;
  if not found or v_connection.status <> 'accepted' or v_connection.accepted_at is null then
    raise exception 'connection_inactive';
  end if;

  -- Canonical occurrence identity: recipient's OWN current timezone, never
  -- the caregiver's and never a client-supplied date -- this is what keeps
  -- a timezone change from ever duplicating an already-recorded occurrence
  -- (it's still exactly today-in-their-timezone, however that maps to UTC).
  v_occurrence_date := (now() at time zone v_tz)::date;
  v_scheduled_for := (((v_occurrence_date::timestamp) + v_reminder.time_of_day) at time zone v_tz);

  if not (extract(isodow from (now() at time zone v_tz))::int = any(v_reminder.days_of_week)) then
    raise exception 'not_eligible_today';
  end if;

  -- Never before the reminder existed or the connection was accepted, and
  -- never before its own scheduled moment today.
  if v_scheduled_for < greatest(v_reminder.created_at, v_connection.accepted_at) then
    raise exception 'not_eligible_yet';
  end if;
  if now() < v_scheduled_for then
    raise exception 'not_eligible_yet';
  end if;

  -- Row lock: serializes this call against any concurrent call for the
  -- SAME occurrence -- another respond_to_reminder_occurrence() call for
  -- this reminder+date, or sync_missed_reminders_db()'s conflicting
  -- upsert. Whichever commits first is seen by the other before it
  -- proceeds, which is what makes "first valid terminal action wins" and
  -- "a response at the exact missed-boundary resolves consistently" true
  -- rather than just intended.
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
      -- Double-tap / retry of an already-recorded terminal action: return
      -- the existing row unchanged, not an error.
      return v_existing;
    end if;
    if p_status = 'snoozed' and v_existing.snoozed_until is not null and v_existing.snoozed_until > now() then
      -- Double-tap on Snooze while the current snooze hasn't expired yet:
      -- idempotent, do not re-extend the deadline (this is what keeps a
      -- concurrent repeated snooze request from generating a second push
      -- or silently pushing the deadline back every retry).
      return v_existing;
    end if;
    -- Otherwise (a fresh 'snoozed' request after the previous snooze
    -- already expired) falls through to the update below as a legitimate
    -- re-snooze with a new deadline.
  elsif v_existing.status in ('taken', 'skipped') then
    -- Never overwrite a different terminal action.
    raise exception 'already_answered';
  end if;

  -- Remaining reachable cases: existing is pending/missed/expired-snoozed,
  -- or existing is snoozed and being re-snoozed after expiry -- all valid
  -- transitions, including late taken/skipped after missed, which is
  -- existing app-intended behavior (reminder-alert.tsx keeps its action
  -- buttons visible after a reminder shows as missed).
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

-- ── 2. Lock down direct client writes to reminder_logs ─────────────────────
-- SELECT policy is untouched -- dashboards still read reminder_logs
-- directly. With no INSERT/UPDATE policy for `authenticated` and RLS
-- enabled, both commands are denied by default; respond_to_reminder_occurrence
-- (SECURITY DEFINER, bypasses RLS) becomes the only way to write a
-- recipient response, and sync_missed_reminders_db (also SECURITY DEFINER)
-- remains the only way 'missed' gets written.
drop policy if exists "Recipients can create logs for their reminders" on public.reminder_logs;
drop policy if exists "Recipients can update their own logs" on public.reminder_logs;

-- ── 3. Immutable occurrence identity ────────────────────────────────────────
-- Defense-in-depth beyond the RPC itself: no UPDATE, from any caller at
-- any privilege level, can ever reassign which reminder/occurrence/
-- connection/parties a log row belongs to.
create or replace function public.prevent_reminder_log_identity_change()
returns trigger
language plpgsql
as $$
begin
  if new.reminder_id <> old.reminder_id
     or new.occurrence_date <> old.occurrence_date
     or new.connection_id <> old.connection_id
     or new.caregiver_id <> old.caregiver_id
     or new.recipient_id <> old.recipient_id then
    raise exception 'reminder_logs identity fields are immutable after insert';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_reminder_log_identity_immutable on public.reminder_logs;
create trigger trg_reminder_log_identity_immutable
  before update on public.reminder_logs
  for each row execute function public.prevent_reminder_log_identity_change();

-- ── 4. Missed-authority consolidation + snoozed -> missed transition ───────
create or replace function public.sync_missed_reminders_db()
returns integer
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  affected_count integer;
begin
  with due_reminders as (
    select
      r.id as reminder_id, r.connection_id, r.caregiver_id, r.recipient_id,
      occ.occurrence_date, occ.scheduled_for
    from public.reminders r
    join public.connections c on c.id = r.connection_id
    join public.profiles p on p.id = r.recipient_id
    cross join lateral (
      select
        (now() at time zone p.timezone)::date as occurrence_date,
        (((now() at time zone p.timezone)::date::timestamp + r.time_of_day) at time zone p.timezone) as scheduled_for
    ) occ
    where r.is_active = true
      and c.status = 'accepted'
      and c.accepted_at is not null
      and extract(isodow from (now() at time zone p.timezone))::integer = any(r.days_of_week)
      and occ.scheduled_for >= greatest(r.created_at, c.accepted_at)
      and now() >= (occ.scheduled_for + make_interval(mins => r.no_response_minutes))
      -- A currently-snoozed occurrence is exclusively due_snoozes' concern
      -- below (different grace-period anchor) -- excluding it here is what
      -- keeps the same (reminder_id, occurrence_date) key from appearing
      -- twice in one INSERT's source rows.
      and not exists (
        select 1 from public.reminder_logs rl2
        where rl2.reminder_id = r.id
          and rl2.occurrence_date = occ.occurrence_date
          and rl2.status = 'snoozed'
      )
  ),
  due_snoozes as (
    select
      rl.reminder_id, rl.connection_id, rl.caregiver_id, rl.recipient_id,
      rl.occurrence_date, rl.scheduled_for
    from public.reminder_logs rl
    join public.reminders r on r.id = rl.reminder_id
    join public.connections c on c.id = r.connection_id
    where rl.status = 'snoozed'
      and rl.snoozed_until is not null
      and r.is_active = true
      and c.status = 'accepted'
      and c.accepted_at is not null
      and now() >= (rl.snoozed_until + make_interval(mins => r.no_response_minutes))
  ),
  combined as (
    select * from due_reminders
    union all
    select * from due_snoozes
  ),
  upserted as (
    insert into public.reminder_logs (
      reminder_id, connection_id, caregiver_id, recipient_id,
      occurrence_date, scheduled_for, status, completed_at, snoozed_until,
      created_at, updated_at
    )
    select
      reminder_id, connection_id, caregiver_id, recipient_id,
      occurrence_date, scheduled_for, 'missed', null, null, now(), now()
    from combined
    on conflict (reminder_id, occurrence_date)
    do update set
      status = 'missed',
      completed_at = null,
      snoozed_until = null,
      updated_at = now()
    where public.reminder_logs.status in ('pending', 'snoozed')
    returning id
  )
  select count(*) into affected_count from upserted;

  return affected_count;
end;
$$;

-- ── 5. Edit-time stale delivery cleanup ─────────────────────────────────────
create or replace function public.clear_stale_reminder_deliveries(p_reminder_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_caregiver_id uuid := auth.uid();
  v_reminder public.reminders%rowtype;
  v_tz text;
  v_occurrence_date date;
begin
  if v_caregiver_id is null then
    raise exception 'authentication_required';
  end if;

  select * into v_reminder from public.reminders where id = p_reminder_id;
  if not found or v_reminder.caregiver_id <> v_caregiver_id then
    raise exception 'not_authorized';
  end if;

  select timezone into v_tz from public.profiles where id = v_reminder.recipient_id;
  if v_tz is null then
    return;
  end if;

  v_occurrence_date := (now() at time zone v_tz)::date;

  -- Only today's occurrence, only the original-reminder delivery type
  -- (never a snooze delivery -- that's a separate, already-user-initiated
  -- branch), and only rows that haven't successfully sent yet. A delivery
  -- that already sent can't be unsent and is left alone.
  delete from public.reminder_notification_deliveries
  where reminder_id = p_reminder_id
    and occurrence_date = v_occurrence_date
    and delivery_type = 'reminder'
    and status in ('pending', 'failed');
end;
$$;

revoke all on function public.clear_stale_reminder_deliveries(uuid) from public, anon;
grant execute on function public.clear_stale_reminder_deliveries(uuid) to authenticated;

-- ── 6. Constraints (verified zero violations against live data first) ──────

-- snoozed_until required exactly when status='snoozed', never otherwise --
-- confirmed 0 violations in production data before adding as VALID (not
-- NOT VALID) directly.
alter table public.reminder_logs
  add constraint reminder_logs_snoozed_until_consistency
  check (
    (status = 'snoozed' and snoozed_until is not null)
    or (status <> 'snoozed' and snoozed_until is null)
  );

-- Generous upper bound -- current UI only ever offers up to 60 minutes
-- (lib/reminderOptions.ts), but this is a defense-in-depth ceiling against
-- a pathological value, not a re-statement of the UI's exact option set.
-- The pre-existing `>= 1` floor is untouched; 10 legacy rows at exactly 1
-- minute (predating the current 5-minute UI floor) remain valid under
-- both the old and this constraint -- no legacy exception needed.
alter table public.reminders
  add constraint reminders_no_response_minutes_upper_bound
  check (no_response_minutes <= 120);

-- ── 7. Indexes for dashboard/analytics reminder queries ─────────────────────
create index if not exists idx_reminders_recipient_active on public.reminders (recipient_id, is_active);
create index if not exists idx_reminders_connection on public.reminders (connection_id);
create index if not exists idx_reminders_caregiver_active on public.reminders (caregiver_id, is_active);
