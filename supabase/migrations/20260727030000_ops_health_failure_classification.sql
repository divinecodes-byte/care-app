-- Ops-health investigation (Week 2 close-out): the recipient_pushes:failure_rate
-- check flagged a single historical delivery as "100% failed" during Week 2
-- verification. Root cause: reminder-audit's own scenario T inserted a
-- synthetic delivery row directly (bypassing the claim functions'
-- server_push_enabled gate) and left it live long enough for the real
-- production send-due-recipient-reminders cron to claim it, find no push
-- token for the synthetic recipient, and record a genuine status='failed'
-- row with error_code='no_active_push_token'. Fixed at the source in
-- scripts/reminder-audit/run.ts (the row is now deleted immediately after
-- its assertion instead of lingering until end-of-run cleanup).
--
-- Independent of that trigger, this migration also fixes a real metric-
-- design gap the same incident exposed: notification_delivery_health_summary
-- had no minimum-sample-size floor, so a denominator of 1 could produce a
-- maximally alarming 100% figure from a single data point — statistically
-- meaningless at pre-launch traffic volumes. It also lumped every 'failed'
-- row into one bucket, with no way to tell "our pipeline is broken" apart
-- from "this recipient simply has no registered device yet" (the latter is
-- the expected pre-launch state today: 0 recipient push tokens exist in
-- production). Both are fixed here by splitting 'failed' into two metrics;
-- scripts/ops-health/run.ts (not this migration) applies the minimum-sample
-- guard and computes the alarm-worthy rate from failed_other only.

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
  -- A recipient with no active push token yet is an expected pre-launch
  -- rollout state, not a pipeline defect -- kept out of failed_other so it
  -- never drives the alarm-worthy failure rate on its own.
  select 'failed_token_absence', count(*)
    from window_deliveries
    where status = 'failed' and error_code in ('no_active_push_token', 'device_not_registered')
  union all
  select 'failed_other', count(*)
    from window_deliveries
    where status = 'failed' and (error_code is null or error_code not in ('no_active_push_token', 'device_not_registered'))
  union all
  select 'skipped_clean', count(*) from window_deliveries where status = 'skipped' and attempt_count < 5
  union all
  select 'retry_exhausted', count(*) from window_deliveries where status = 'skipped' and attempt_count >= 5
  union all
  select 'pending', count(*) from window_deliveries where status = 'pending'
  union all
  select 'stuck_pending', count(*)
    from public.reminder_notification_deliveries
    where status = 'pending' and updated_at < now() - interval '2 minutes'
  union all
  select 'no_active_token', count(*)
    from window_deliveries
    where error_code = 'no_active_push_token'
  union all
  select 'device_not_registered', count(*)
    from window_deliveries
    where error_code = 'device_not_registered'
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
  'Read-only operational summary of the recipient-push delivery pipeline over the trailing p_window_hours (default 24). No reminder titles, notes, names, emails, or push tokens are returned -- counts and timing only. failed_token_absence/failed_other split status=failed by whether the recipient simply has no active push token yet (expected pre-launch) versus a genuine pipeline error. service_role/postgres only.';

revoke all on function public.notification_delivery_health_summary(int) from public, anon, authenticated;
grant execute on function public.notification_delivery_health_summary(int) to service_role;
