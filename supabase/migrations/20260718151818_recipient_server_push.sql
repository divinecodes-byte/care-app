-- Migrate Loved One reminder delivery to server-authoritative push.
--
-- Adds a per-recipient IANA timezone + rollout flag, a delivery ledger table
-- for idempotent Expo push sends, two claim functions used by a new
-- send-due-recipient-reminders Edge Function, and fixes a latent timezone
-- bug in the existing missed-reminder detector so both jobs agree on "today"
-- for any recipient (previously hardcoded to America/New_York for everyone).
--
-- Fully inert on deploy: server_push_enabled defaults false for every
-- existing profile, so the new claim functions return zero rows and the
-- cron jobs wired up here are no-ops until a recipient's flag is flipped.

-- ─── profiles: timezone + rollout flag ─────────────────────────────────────

alter table public.profiles
  add column timezone text not null default 'America/New_York',
  add column server_push_enabled boolean not null default false;

comment on column public.profiles.timezone is
  'IANA timezone (e.g. America/New_York) used server-side to compute reminder due-times for this user when they are a recipient. Defaults to America/New York to match pre-migration behavior; the client updates this once from device settings.';
comment on column public.profiles.server_push_enabled is
  'Per-recipient rollout flag for server-authoritative reminder push. While false, the recipient client keeps pre-scheduling local notifications and the server claim functions ignore this recipient entirely.';

-- ─── reminder_notification_deliveries: idempotency ledger ──────────────────

create table public.reminder_notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  reminder_id uuid not null references public.reminders(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  occurrence_date date not null,
  scheduled_for timestamptz not null,
  delivery_type text not null default 'reminder' check (delivery_type in ('reminder', 'snooze')),
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped')),
  expo_ticket_id text,
  error_message text,
  attempt_count integer not null default 0,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (reminder_id, occurrence_date, delivery_type)
);

comment on table public.reminder_notification_deliveries is
  'Idempotency ledger for server-sent recipient reminder/snooze pushes. Written only by SECURITY DEFINER claim functions and the send-due-recipient-reminders Edge Function (service role) — no client-facing RLS policies.';

alter table public.reminder_notification_deliveries enable row level security;
-- Deliberately no policies: neither anon nor authenticated roles can read,
-- insert, or update this table. Service-role (Edge Function) and
-- SECURITY DEFINER functions both bypass RLS regardless. Stricter than
-- caregiver_notification_events (which grants caregivers SELECT-own) because
-- nothing in the current UI needs to read delivery state.

create index idx_rnd_due_lookup on public.reminder_notification_deliveries
  (reminder_id, occurrence_date, delivery_type);

create index idx_rnd_retryable on public.reminder_notification_deliveries
  (status, attempt_count, updated_at)
  where status in ('failed', 'pending');

create index idx_rnd_receipts_lookup on public.reminder_notification_deliveries
  (status, sent_at)
  where status = 'sent';

-- ─── Claim functions ────────────────────────────────────────────────────────
--
-- Both are the atomic idempotent "claim" step: INSERT ... ON CONFLICT DO
-- NOTHING RETURNING *, so concurrent cron invocations can never double-claim
-- the same (reminder_id, occurrence_date, delivery_type). The calling Edge
-- Function re-validates live state immediately before sending — this claim
-- only decides "due and not yet claimed," not "still safe to send right now."

create or replace function public.claim_due_recipient_reminder_deliveries()
returns setof public.reminder_notification_deliveries
language sql
security definer
set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
  insert into public.reminder_notification_deliveries
    (reminder_id, recipient_id, occurrence_date, scheduled_for, delivery_type, status)
  select
    r.id,
    r.recipient_id,
    occ.occurrence_date,
    occ.scheduled_for,
    'reminder',
    'pending'
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
$function$;

comment on function public.claim_due_recipient_reminder_deliveries() is
  'Atomically claims (inserts pending delivery rows for) every recipient reminder occurrence that is currently due, per-recipient IANA timezone, for recipients with server_push_enabled=true. Safe to call every tick from any number of concurrent invocations.';

create or replace function public.claim_due_recipient_snooze_deliveries()
returns setof public.reminder_notification_deliveries
language sql
security definer
set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
  insert into public.reminder_notification_deliveries
    (reminder_id, recipient_id, occurrence_date, scheduled_for, delivery_type, status)
  select
    rl.reminder_id,
    rl.recipient_id,
    rl.occurrence_date,
    rl.snoozed_until,
    'snooze',
    'pending'
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
$function$;

comment on function public.claim_due_recipient_snooze_deliveries() is
  'Atomically claims due snooze re-alerts (reminder_logs.status = snoozed and snoozed_until has passed) for recipients with server_push_enabled=true.';

-- ─── Fix: sync_missed_reminders_db no longer hardcodes a timezone ──────────
--
-- Previously used a single `app_timezone := 'America/New_York'` constant for
-- every recipient regardless of where they live. Now reads profiles.timezone
-- per-row so missed-detection agrees with the new claim functions about
-- "today" and "due" for any recipient, not just US Eastern ones. Logic is
-- otherwise unchanged (same eligibility/window rules, same upsert shape).

create or replace function public.sync_missed_reminders_db()
returns integer
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
declare
  affected_count integer;
begin
  with due_reminders as (
    select
      r.id as reminder_id,
      r.connection_id,
      r.caregiver_id,
      r.recipient_id,
      occ.occurrence_date,
      occ.scheduled_for
    from public.reminders r
    join public.connections c
      on c.id = r.connection_id
    join public.profiles p
      on p.id = r.recipient_id
    cross join lateral (
      select
        (now() at time zone p.timezone)::date as occurrence_date,
        (((now() at time zone p.timezone)::date::timestamp + r.time_of_day) at time zone p.timezone) as scheduled_for
    ) occ
    where r.is_active = true
      and c.status = 'accepted'
      and c.accepted_at is not null

      -- day-of-week rule
      and extract(isodow from (now() at time zone p.timezone))::integer = any(r.days_of_week)

      -- do not process reminders before setup
      and occ.scheduled_for >= greatest(r.created_at, c.accepted_at)

      -- no-response window has passed
      and now() >= (occ.scheduled_for + make_interval(mins => r.no_response_minutes))
  ),

  upserted as (
    insert into public.reminder_logs (
      reminder_id,
      connection_id,
      caregiver_id,
      recipient_id,
      occurrence_date,
      scheduled_for,
      status,
      completed_at,
      snoozed_until,
      created_at,
      updated_at
    )
    select
      reminder_id,
      connection_id,
      caregiver_id,
      recipient_id,
      occurrence_date,
      scheduled_for,
      'missed',
      null,
      null,
      now(),
      now()
    from due_reminders
    on conflict (reminder_id, occurrence_date)
    do update set
      status = 'missed',
      completed_at = null,
      snoozed_until = null,
      updated_at = now()
    where public.reminder_logs.status = 'pending'
    returning id
  )

  select count(*) into affected_count
  from upserted;

  return affected_count;
end;
$function$;

-- ─── Cron wiring ────────────────────────────────────────────────────────────
--
-- The shared secret used to authenticate pg_net's calls to the new Edge
-- Functions is created separately (vault.create_secret, generated server-side
-- via gen_random_bytes so it never appears in this file or in git history)
-- and only *referenced by name* here. See the deployment runbook for the
-- one-off command that creates it before this migration's cron jobs can
-- succeed.

create or replace function public.trigger_send_due_recipient_reminders()
returns void
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
declare
  secret text;
begin
  select decrypted_secret into secret
  from vault.decrypted_secrets
  where name = 'recipient_push_cron_secret';

  if secret is null then
    raise warning 'recipient_push_cron_secret not set in vault; skipping send-due-recipient-reminders invocation';
    return;
  end if;

  perform net.http_post(
    url := 'https://ofpzbifonihfutghbjbw.supabase.co/functions/v1/send-due-recipient-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
end;
$function$;

create or replace function public.trigger_check_push_receipts()
returns void
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
declare
  secret text;
begin
  select decrypted_secret into secret
  from vault.decrypted_secrets
  where name = 'recipient_push_cron_secret';

  if secret is null then
    raise warning 'recipient_push_cron_secret not set in vault; skipping check-push-receipts invocation';
    return;
  end if;

  perform net.http_post(
    url := 'https://ofpzbifonihfutghbjbw.supabase.co/functions/v1/check-push-receipts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
end;
$function$;

select cron.schedule(
  'send-due-recipient-reminders',
  '30 seconds',
  $$select public.trigger_send_due_recipient_reminders();$$
);

select cron.schedule(
  'check-push-receipts',
  '*/15 * * * *',
  $$select public.trigger_check_push_receipts();$$
);
