-- Week 1 launch hardening: production observability, delivery monitoring,
-- and backend data-retention controls.
--
-- Findings this migration addresses (see docs/backend-security-inventory.md
-- update and the task report for full detail):
--   1. reminder_notification_deliveries had no way to know whether/when a
--      sent push's receipt was ever checked -- added receipt_checked_at.
--   2. No read-only, safely-scoped way to ask "is the notification pipeline
--      healthy right now" without hand-writing SQL each time --
--      notification_delivery_health_summary().
--   3. No summarized cron health view -- cron_health_summary(), built on
--      cron.job_run_details (which itself turned out to need retention --
--      see below, an additional finding beyond what the task named).
--   4. net._http_response (747 rows) AND cron.job_run_details (80,917 rows
--      -- found during this audit, growing far faster) both had zero
--      retention. Both get a conservative daily cleanup job.

-- ─── 1. Delivery-ledger observability column ────────────────────────────────

alter table public.reminder_notification_deliveries
  add column receipt_checked_at timestamptz;

comment on column public.reminder_notification_deliveries.receipt_checked_at is
  'Set by check-push-receipts the moment it examines this delivery''s Expo ticket receipt, regardless of outcome. Null means "never checked yet" -- used to detect receipt-overdue sent rows. claimed_at/ticket-acceptance-time are intentionally NOT separate columns: created_at already is the claim moment (set at INSERT by the claim functions) and sent_at already is Expo ticket-acceptance time -- adding redundant columns for values already available was avoided per this migration''s own design principle.';

-- ─── 2. Notification delivery health summary ────────────────────────────────
--
-- Server-side processing latency only (claim -> Expo ticket acceptance).
-- This is NOT device-received latency -- Expo accepting a ticket is not the
-- same as the phone displaying a notification, and this function must never
-- be read as claiming otherwise.
create or replace function public.notification_delivery_health_summary(p_window_hours int default 24)
returns table (metric text, value numeric)
language sql
security definer
set search_path = public, extensions, pg_catalog
stable
as $$
  with window_deliveries as (
    select *
    from public.reminder_notification_deliveries
    where scheduled_for >= now() - make_interval(hours => greatest(p_window_hours, 1))
  ),
  latencies as (
    select extract(epoch from (sent_at - created_at)) as latency_seconds
    from window_deliveries
    where status = 'sent' and sent_at is not null
  )
  select 'due_in_window'::text, count(*)::numeric from window_deliveries
  union all
  select 'sent', count(*) from window_deliveries where status = 'sent'
  union all
  select 'failed', count(*) from window_deliveries where status = 'failed'
  union all
  select 'skipped_clean', count(*) from window_deliveries where status = 'skipped' and attempt_count < 5
  union all
  select 'retry_exhausted', count(*) from window_deliveries where status = 'skipped' and attempt_count >= 5
  union all
  select 'pending', count(*) from window_deliveries where status = 'pending'
  -- Not window-scoped below: a truly stuck/old row must be visible even if
  -- its scheduled_for has aged out of the reporting window.
  union all
  select 'stuck_pending', count(*)
    from public.reminder_notification_deliveries
    where status = 'pending' and updated_at < now() - interval '2 minutes'
  union all
  select 'no_active_token', count(*)
    from window_deliveries
    where status in ('failed', 'skipped') and error_message = 'no_active_push_token'
  union all
  select 'avg_ticket_latency_seconds', round(avg(latency_seconds)::numeric, 2) from latencies
  union all
  select 'p95_ticket_latency_seconds', round((percentile_cont(0.95) within group (order by latency_seconds))::numeric, 2) from latencies
  union all
  select 'oldest_unresolved_minutes', round(extract(epoch from (now() - min(created_at)))::numeric / 60, 1)
    from public.reminder_notification_deliveries
    where status in ('pending', 'failed')
  union all
  select 'inactive_push_tokens', count(*) from public.push_tokens where is_active = false
  union all
  select 'receipt_overdue', count(*)
    from public.reminder_notification_deliveries
    where status = 'sent' and receipt_checked_at is null and sent_at < now() - interval '20 minutes';
$$;

comment on function public.notification_delivery_health_summary(int) is
  'Read-only operational summary of the recipient-push delivery pipeline over the trailing p_window_hours (default 24). No reminder titles, notes, names, emails, or push tokens are returned -- counts and timing only. service_role/postgres only.';

revoke all on function public.notification_delivery_health_summary(int) from public, anon, authenticated;
grant execute on function public.notification_delivery_health_summary(int) to service_role;

-- ─── 3. Cron health summary ──────────────────────────────────────────────────
--
-- "recent_failure_count" deliberately does not claim to be a true
-- consecutive-failure streak (that needs a running-streak calculation this
-- table's actual history -- 100% success across 80k+ runs at the time of
-- writing -- doesn't currently justify the complexity of). It is simply
-- "how many of the last 20 runs failed," documented as such.
create or replace function public.cron_health_summary()
returns table (
  jobname text,
  schedule text,
  active boolean,
  last_run_at timestamptz,
  last_status text,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error text,
  last_duration_seconds numeric,
  recent_failure_count bigint
)
language sql
security definer
set search_path = public, extensions, pg_catalog, cron
stable
as $$
  select
    j.jobname,
    j.schedule,
    j.active,
    lr.start_time,
    lr.status,
    (select max(d.start_time) from cron.job_run_details d where d.jobid = j.jobid and d.status = 'succeeded'),
    (select max(d.start_time) from cron.job_run_details d where d.jobid = j.jobid and d.status = 'failed'),
    (select d.return_message from cron.job_run_details d where d.jobid = j.jobid and d.status = 'failed' order by d.start_time desc limit 1),
    extract(epoch from (lr.end_time - lr.start_time)),
    (
      select count(*)
      from (
        select d.status
        from cron.job_run_details d
        where d.jobid = j.jobid
        order by d.start_time desc
        limit 20
      ) recent
      where recent.status = 'failed'
    )
  from cron.job j
  left join lateral (
    select d.start_time, d.status, d.end_time
    from cron.job_run_details d
    where d.jobid = j.jobid
    order by d.start_time desc
    limit 1
  ) lr on true;
$$;

comment on function public.cron_health_summary() is
  'Read-only summary of every pg_cron job (name, schedule, last run/success/failure, last error text, recent failure count). No secret values, headers, or payload bodies -- job_run_details.command is plain SQL text (e.g. "select public.trigger_send_due_recipient_reminders();"), never a secret. service_role/postgres only.';

revoke all on function public.cron_health_summary() from public, anon, authenticated;
grant execute on function public.cron_health_summary() to service_role;

-- ─── 4. Retention: net._http_response ───────────────────────────────────────
--
-- Conservative launch default: success (2xx) responses kept 7 days,
-- everything else (failures, timeouts) kept 14 days for debugging headroom.
-- Bodies are push-ticket/receipt JSON keyed by UUIDs -- no PII beyond that,
-- but indefinite retention of raw HTTP response bodies is still unwarranted.
create or replace function public.cleanup_pg_net_responses()
returns integer
language plpgsql
security definer
set search_path = public, extensions, pg_catalog, net
as $$
declare
  v_deleted integer;
begin
  delete from net._http_response
  where created < now() - interval '14 days'
     or (created < now() - interval '7 days' and status_code between 200 and 299);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

comment on function public.cleanup_pg_net_responses() is
  'Daily retention for net._http_response: success rows >7 days, all rows >14 days. Run by the cleanup-pg-net-responses cron job.';

revoke all on function public.cleanup_pg_net_responses() from public, anon, authenticated;
grant execute on function public.cleanup_pg_net_responses() to service_role;

-- ─── 5. Retention: cron.job_run_details ─────────────────────────────────────
--
-- Additional finding beyond what this task named: 80,917 rows at audit time
-- (the caregiver-push job alone, at a 1-minute cadence since mid-June,
-- accounts for the majority), growing roughly 4,700 rows/day across all
-- four jobs combined, with zero existing retention -- a materially bigger
-- unbounded-growth risk than net._http_response. 7-day retention is ample:
-- operational failures are cross-referenced against
-- reminder_notification_deliveries/caregiver_notification_events (which
-- have their own, longer retention -- see docs/operations-runbook.md), not
-- solely dependent on this raw pg_cron execution log.
create or replace function public.cleanup_cron_job_run_details()
returns integer
language plpgsql
security definer
set search_path = public, extensions, pg_catalog, cron
as $$
declare
  v_deleted integer;
begin
  delete from cron.job_run_details
  where start_time < now() - interval '7 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

comment on function public.cleanup_cron_job_run_details() is
  'Daily retention for cron.job_run_details: rows >7 days removed. Run by the cleanup-cron-job-run-details cron job.';

revoke all on function public.cleanup_cron_job_run_details() from public, anon, authenticated;
grant execute on function public.cleanup_cron_job_run_details() to service_role;

-- ─── 6. Daily retention cron jobs (staggered, low-traffic hour) ────────────

select cron.schedule('cleanup-pg-net-responses', '0 3 * * *',
  $$select public.cleanup_pg_net_responses();$$);

select cron.schedule('cleanup-cron-job-run-details', '15 3 * * *',
  $$select public.cleanup_cron_job_run_details();$$);
