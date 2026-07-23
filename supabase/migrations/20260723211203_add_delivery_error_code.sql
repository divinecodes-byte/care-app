-- Error normalization (Week 1 ops-hardening task, Phase 7).
--
-- error_message was free text mixing internal short codes
-- ('reminder_inactive') with raw Expo ticket messages -- which can embed
-- the full push token, e.g. `"ExponentPushToken[xxx]" is not a valid Expo
-- push token`. Confirmed this actually happened (seen in prior-session
-- testing). error_code is a small, fixed, internal vocabulary for
-- filtering/alerting; error_message remains for human debugging but the
-- Edge Function now redacts any token-shaped substring before storing it.

alter table public.reminder_notification_deliveries
  add column error_code text;

comment on column public.reminder_notification_deliveries.error_code is
  'Normalized internal code: no_active_push_token | device_not_registered | expo_ticket_error | expo_batch_error | reminder_not_found | reminder_inactive | reminder_reassigned | occurrence_answered | internal_error. Null for status=sent. Prefer this over parsing error_message for any programmatic check.';

-- Recreate the health summary against error_code (exact, stable) instead of
-- pattern-matching error_message (free text, not meant to be queried against).
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

revoke all on function public.notification_delivery_health_summary(int) from public, anon, authenticated;
grant execute on function public.notification_delivery_health_summary(int) to service_role;
