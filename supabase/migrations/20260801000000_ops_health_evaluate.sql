-- Week 4 Task #1: single operational-health source of truth.
--
-- Before this migration, WARN/FAIL threshold decisions lived only in
-- scripts/ops-health/run.ts (TypeScript), computed from the raw metrics
-- already exposed by notification_delivery_health_summary(),
-- task_notification_health_summary(), routine_notification_health_summary(),
-- and cron_health_summary(). That meant a second consumer (the new
-- evaluate-ops-health Edge Function) would have had to reimplement the same
-- thresholds in a second language, with a real risk of the two drifting
-- apart over time. This migration moves the threshold logic itself into
-- one SQL function; scripts/ops-health/run.ts is rewritten (separately) to
-- call it and just format the rows for the terminal.
--
-- It also fixes the cron.job_run_details/net._http_response retention
-- false-positive: both cleanup jobs have run successfully every day since
-- 2026-07-24 with zero errors (confirmed via direct query of
-- cron.job_run_details this session), but the prior check counted rows
-- past the raw retention boundary (7/14 days), which is *always* nonzero
-- in the hours before the once-daily cleanup run given ~7,584
-- job_run_details rows/day of generation (dominated by the 30-second
-- recipient-reminder cron). The corrected check adds a
-- cleanup-cadence grace period on top of the retention window, and
-- additionally looks at the cleanup job's own last-success recency and the
-- single oldest overdue row's age -- not a raw count alone.
--
-- Uses `return next` against the RETURNS TABLE's implicit OUT variables
-- (check_name/status/detail/numeric_value) rather than a temp table -- a
-- temp table's CREATE TABLE is DDL, which Postgres rejects inside a
-- function marked STABLE.

create or replace function public.ops_health_evaluate(
    p_cron_stale_warn_multiplier numeric default 4,
    p_cron_stale_fail_multiplier numeric default 10,
    p_stuck_pending_warn integer default 1,
    p_stuck_pending_fail integer default 10,
    p_retry_exhausted_warn integer default 1,
    p_retry_exhausted_fail integer default 10,
    p_failure_rate_warn numeric default 0.1,
    p_failure_rate_fail numeric default 0.3,
    p_failure_rate_min_sample integer default 5,
    p_failure_rate_min_sample_abs_warn integer default 3,
    p_job_run_details_retention_days integer default 7,
    p_http_response_retention_days integer default 14,
    p_cleanup_grace_hours integer default 26
)
returns table(check_name text, status text, detail text, numeric_value numeric)
language plpgsql
stable
security definer
set search_path to 'public', 'extensions', 'pg_catalog', 'cron', 'net'
as $$
declare
    -- Two parallel 1D arrays rather than a single text[][] -- PL/pgSQL's
    -- 2D-array indexing (arr[i]) does not extract "row i" as a 1D
    -- sub-array the way it would in most other languages; arr[i] on a true
    -- 2D array is not valid single-subscript access and silently yields
    -- NULL, not an error, so this was originally a real bug caught only by
    -- actually invoking the function.
    v_required_job_names constant text[] := array[
        'send-due-recipient-reminders', 'check-push-receipts', 'sync-missed-reminders-db',
        'send-caregiver-push-notifications', 'send-task-assignment-notifications',
        'send-routine-assignment-notifications', 'cleanup-pg-net-responses', 'cleanup-cron-job-run-details'
    ];
    v_required_job_cadences constant integer[] := array[30, 900, 300, 60, 60, 60, 86400, 86400];
    v_job_name text;
    v_cadence integer;
    v_job_count integer;
    v_row record;
    v_age_seconds numeric;
    v_warn_at numeric;
    v_fail_at numeric;

    v_delivery jsonb;
    v_task jsonb;
    v_routine jsonb;

    v_sent numeric; v_failed numeric; v_failed_token numeric; v_failed_other numeric; v_due numeric;
    v_rate numeric;
    v_stuck numeric; v_retry_exhausted numeric; v_receipt_overdue numeric; v_inactive_tokens numeric;

    v_caregiver_sent numeric; v_caregiver_pending numeric; v_caregiver_total numeric;

    v_old_http numeric; v_old_job_run numeric;
    v_oldest_overdue_job_run_minutes numeric;
    v_cleanup_pg_net_last record;
    v_cleanup_job_run_last record;
begin
    -- ── Cron: existence, active flag, staleness, recent failures ──────────
    for i in 1 .. array_length(v_required_job_names, 1) loop
        v_job_name := v_required_job_names[i];
        v_cadence := v_required_job_cadences[i];
        select count(*) into v_job_count from cron.job where jobname = v_job_name;
        if v_job_count = 0 then
            check_name := 'cron:' || v_job_name; status := 'FAIL'; detail := 'job does not exist'; numeric_value := null;
            return next;
            continue;
        end if;
        if v_job_count > 1 then
            check_name := 'cron:' || v_job_name; status := 'FAIL'; detail := format('scheduled %s times — must exist exactly once', v_job_count); numeric_value := v_job_count;
            return next;
            continue;
        end if;

        select * into v_row from public.cron_health_summary() c where c.jobname = v_job_name;
        if v_row is null then
            check_name := 'cron:' || v_job_name; status := 'FAIL'; detail := 'job exists but has no run history yet'; numeric_value := null;
            return next;
            continue;
        end if;
        if not v_row.active then
            check_name := 'cron:' || v_job_name; status := 'FAIL'; detail := 'job is disabled (active=false)'; numeric_value := null;
            return next;
            continue;
        end if;
        if v_row.last_run_at is null then
            check_name := 'cron:' || v_job_name; status := 'WARNING'; detail := 'no run recorded yet (new job or retention already pruned its own history)'; numeric_value := null;
            return next;
            continue;
        end if;

        v_age_seconds := extract(epoch from (now() - v_row.last_run_at));
        v_warn_at := v_cadence::numeric * p_cron_stale_warn_multiplier;
        v_fail_at := v_cadence::numeric * p_cron_stale_fail_multiplier;
        check_name := 'cron:' || v_job_name;

        if v_age_seconds > v_fail_at then
            status := 'FAIL'; detail := format('last run %ss ago (expected every ~%ss)', round(v_age_seconds), v_cadence); numeric_value := v_age_seconds;
        elsif v_age_seconds > v_warn_at or v_row.last_status is distinct from 'succeeded' then
            status := 'WARNING'; detail := format('last run %ss ago, status=%s', round(v_age_seconds), v_row.last_status); numeric_value := v_age_seconds;
        elsif v_row.recent_failure_count > 0 then
            status := 'WARNING'; detail := format('%s failure(s) in last 20 runs', v_row.recent_failure_count); numeric_value := v_row.recent_failure_count;
        else
            status := 'PASS'; detail := format('last run %ss ago, succeeded', round(v_age_seconds)); numeric_value := v_age_seconds;
        end if;
        return next;
    end loop;

    -- ── Recipient push delivery health ────────────────────────────────────
    select jsonb_object_agg(metric, value) into v_delivery from public.notification_delivery_health_summary(24);
    v_sent := coalesce((v_delivery->>'sent')::numeric, 0);
    v_failed := coalesce((v_delivery->>'failed')::numeric, 0);
    v_failed_token := coalesce((v_delivery->>'failed_token_absence')::numeric, 0);
    v_failed_other := coalesce((v_delivery->>'failed_other')::numeric, 0);
    v_due := coalesce((v_delivery->>'due_in_window')::numeric, 0);

    check_name := 'recipient_pushes:failure_rate';
    if v_due < p_failure_rate_min_sample then
        if v_failed_other >= p_failure_rate_min_sample_abs_warn then
            status := 'WARNING'; detail := format('%s genuine failure(s) of %s due in last 24h — sample too small for a rate, but the raw count crosses %s', v_failed_other, v_due, p_failure_rate_min_sample_abs_warn); numeric_value := v_failed_other;
        else
            status := 'PASS'; detail := format('%s due in last 24h (sent=%s, failed=%s, of which %s no-token) — sample below %s, rate not computed', v_due, v_sent, v_failed, v_failed_token, p_failure_rate_min_sample); numeric_value := v_due;
        end if;
    else
        v_rate := v_failed_other / v_due;
        if v_rate >= p_failure_rate_fail then
            status := 'FAIL'; detail := format('%s%% genuine-failure of %s due in last 24h (excludes %s no-token)', round(v_rate * 100, 1), v_due, v_failed_token); numeric_value := v_rate;
        elsif v_rate >= p_failure_rate_warn then
            status := 'WARNING'; detail := format('%s%% genuine-failure of %s due in last 24h (excludes %s no-token)', round(v_rate * 100, 1), v_due, v_failed_token); numeric_value := v_rate;
        else
            status := 'PASS'; detail := format('%s%% genuine-failure of %s due in last 24h (sent=%s, failed=%s, of which %s no-token)', round(v_rate * 100, 1), v_due, v_sent, v_failed, v_failed_token); numeric_value := v_rate;
        end if;
    end if;
    return next;

    check_name := 'recipient_pushes:no_recipient_token'; status := 'PASS';
    detail := format('%s delivery attempt(s) in last 24h had no active recipient push token (expected pre-launch)', v_failed_token);
    numeric_value := v_failed_token;
    return next;

    v_stuck := coalesce((v_delivery->>'stuck_pending')::numeric, 0);
    check_name := 'recipient_pushes:stuck_pending';
    status := case when v_stuck >= p_stuck_pending_fail then 'FAIL' when v_stuck >= p_stuck_pending_warn then 'WARNING' else 'PASS' end;
    detail := case when v_stuck = 0 then 'no stuck pending deliveries' else format('%s delivery row(s) pending > 2 minutes', v_stuck) end;
    numeric_value := v_stuck;
    return next;

    v_retry_exhausted := coalesce((v_delivery->>'retry_exhausted')::numeric, 0);
    check_name := 'recipient_pushes:retry_exhausted';
    status := case when v_retry_exhausted >= p_retry_exhausted_fail then 'FAIL' when v_retry_exhausted >= p_retry_exhausted_warn then 'WARNING' else 'PASS' end;
    detail := case when v_retry_exhausted = 0 then 'no retry-exhausted deliveries' else format('%s deliveries exhausted all retries in last 24h', v_retry_exhausted) end;
    numeric_value := v_retry_exhausted;
    return next;

    v_receipt_overdue := coalesce((v_delivery->>'receipt_overdue')::numeric, 0);
    check_name := 'recipient_pushes:receipt_overdue';
    status := case when v_receipt_overdue > 5 then 'WARNING' else 'PASS' end;
    detail := format('%s sent deliveries with no receipt check after 20 minutes', v_receipt_overdue);
    numeric_value := v_receipt_overdue;
    return next;

    -- ── Task-assignment push health ───────────────────────────────────────
    select jsonb_object_agg(metric, value) into v_task from public.task_notification_health_summary(24);
    v_due := coalesce((v_task->>'due_in_window')::numeric, 0);
    v_sent := coalesce((v_task->>'sent')::numeric, 0);
    v_failed_other := coalesce((v_task->>'failed_other')::numeric, 0);
    v_failed_token := coalesce((v_task->>'failed_token_absence')::numeric, 0);
    check_name := 'task_pushes:failure_rate';
    if v_due < p_failure_rate_min_sample then
        if v_failed_other >= p_failure_rate_min_sample_abs_warn then
            status := 'WARNING'; detail := format('%s genuine failure(s) of %s due in last 24h — sample too small for a rate', v_failed_other, v_due); numeric_value := v_failed_other;
        else
            status := 'PASS'; detail := format('%s due in last 24h (sent=%s, of which %s no-token) — sample below %s, rate not computed', v_due, v_sent, v_failed_token, p_failure_rate_min_sample); numeric_value := v_due;
        end if;
    else
        v_rate := v_failed_other / v_due;
        status := case when v_rate >= p_failure_rate_fail then 'FAIL' when v_rate >= p_failure_rate_warn then 'WARNING' else 'PASS' end;
        detail := format('%s%% genuine-failure of %s due in last 24h (sent=%s, excludes %s no-token)', round(v_rate * 100, 1), v_due, v_sent, v_failed_token);
        numeric_value := v_rate;
    end if;
    return next;

    v_stuck := coalesce((v_task->>'stuck_pending')::numeric, 0);
    check_name := 'task_pushes:stuck_pending';
    status := case when v_stuck >= p_stuck_pending_fail then 'FAIL' when v_stuck >= p_stuck_pending_warn then 'WARNING' else 'PASS' end;
    detail := format('%s task-assignment delivery row(s) pending > 5 minutes', v_stuck);
    numeric_value := v_stuck;
    return next;

    -- ── Routine-assignment push health ────────────────────────────────────
    select jsonb_object_agg(metric, value) into v_routine from public.routine_notification_health_summary(24);
    v_due := coalesce((v_routine->>'due_in_window')::numeric, 0);
    v_sent := coalesce((v_routine->>'sent')::numeric, 0);
    v_failed_other := coalesce((v_routine->>'failed_other')::numeric, 0);
    v_failed_token := coalesce((v_routine->>'failed_token_absence')::numeric, 0);
    check_name := 'routine_pushes:failure_rate';
    if v_due < p_failure_rate_min_sample then
        if v_failed_other >= p_failure_rate_min_sample_abs_warn then
            status := 'WARNING'; detail := format('%s genuine failure(s) of %s due in last 24h — sample too small for a rate', v_failed_other, v_due); numeric_value := v_failed_other;
        else
            status := 'PASS'; detail := format('%s due in last 24h (sent=%s, of which %s no-token) — sample below %s, rate not computed', v_due, v_sent, v_failed_token, p_failure_rate_min_sample); numeric_value := v_due;
        end if;
    else
        v_rate := v_failed_other / v_due;
        status := case when v_rate >= p_failure_rate_fail then 'FAIL' when v_rate >= p_failure_rate_warn then 'WARNING' else 'PASS' end;
        detail := format('%s%% genuine-failure of %s due in last 24h (sent=%s, excludes %s no-token)', round(v_rate * 100, 1), v_due, v_sent, v_failed_token);
        numeric_value := v_rate;
    end if;
    return next;

    v_stuck := coalesce((v_routine->>'stuck_pending')::numeric, 0);
    check_name := 'routine_pushes:stuck_pending';
    status := case when v_stuck >= p_stuck_pending_fail then 'FAIL' when v_stuck >= p_stuck_pending_warn then 'WARNING' else 'PASS' end;
    detail := format('%s routine-assignment delivery row(s) pending > 5 minutes', v_stuck);
    numeric_value := v_stuck;
    return next;

    -- ── Caregiver push health ──────────────────────────────────────────────
    select
        coalesce(sum(s.c) filter (where s.evt_status = 'sent'), 0),
        coalesce(sum(s.c) filter (where s.evt_status = 'pending'), 0),
        coalesce(sum(s.c), 0)
      into v_caregiver_sent, v_caregiver_pending, v_caregiver_total
      from (
        select cne.status as evt_status, count(*) as c
        from public.caregiver_notification_events cne
        where cne.created_at >= now() - interval '24 hours'
        group by cne.status
      ) s;
    check_name := 'caregiver_pushes';
    status := case when v_caregiver_pending > 20 then 'WARNING' else 'PASS' end;
    detail := format('%s event(s) in last 24h (sent=%s, pending=%s)', v_caregiver_total, v_caregiver_sent, v_caregiver_pending);
    numeric_value := v_caregiver_total;
    return next;

    -- ── Invalid/inactive tokens (informational) ───────────────────────────
    v_inactive_tokens := coalesce((v_delivery->>'inactive_push_tokens')::numeric, 0);
    check_name := 'push_tokens:inactive'; status := 'PASS';
    detail := format('%s inactive token(s) on file (informational)', v_inactive_tokens);
    numeric_value := v_inactive_tokens;
    return next;

    -- ── Retention: cadence-aware, not a raw-count-past-boundary check ─────
    -- Adds p_cleanup_grace_hours on top of each retention window before
    -- counting a row "overdue" -- eliminates the daily sawtooth (up to a
    -- full day's generation volume sits past the raw boundary in the hours
    -- before each once-daily cleanup run; that is expected, not a failure).
    select count(*) into v_old_job_run from cron.job_run_details
      where start_time < now() - make_interval(days => p_job_run_details_retention_days) - make_interval(hours => p_cleanup_grace_hours);
    select count(*) into v_old_http from net._http_response
      where created < now() - make_interval(days => p_http_response_retention_days) - make_interval(hours => p_cleanup_grace_hours);

    select round(extract(epoch from (now() - min(start_time)))::numeric / 60, 1) into v_oldest_overdue_job_run_minutes
      from cron.job_run_details
      where start_time < now() - make_interval(days => p_job_run_details_retention_days) - make_interval(hours => p_cleanup_grace_hours);

    select * into v_cleanup_job_run_last from public.cron_health_summary() c where c.jobname = 'cleanup-cron-job-run-details';
    select * into v_cleanup_pg_net_last from public.cron_health_summary() c where c.jobname = 'cleanup-pg-net-responses';

    check_name := 'retention:pg_net_and_cron_logs';
    if (v_cleanup_job_run_last is not null and v_cleanup_job_run_last.last_status is distinct from 'succeeded' and v_cleanup_job_run_last.last_run_at is not null)
       or (v_cleanup_pg_net_last is not null and v_cleanup_pg_net_last.last_status is distinct from 'succeeded' and v_cleanup_pg_net_last.last_run_at is not null) then
        status := 'FAIL';
        detail := format('a retention cleanup job''s most recent run did not succeed (job_run_details last_status=%s, pg_net last_status=%s) — genuine cleanup failure, not a volume artifact',
                   coalesce(v_cleanup_job_run_last.last_status, 'no_history'), coalesce(v_cleanup_pg_net_last.last_status, 'no_history'));
        numeric_value := null;
    elsif v_old_http > 0 or v_old_job_run > 0 then
        status := 'WARNING';
        detail := format('%s net._http_response and %s cron.job_run_details row(s) older than retention+%sh grace (oldest overdue job_run_details row is %s min past that bound) — cleanup may be falling behind, not merely mid-cycle',
                   v_old_http, v_old_job_run, p_cleanup_grace_hours, coalesce(v_oldest_overdue_job_run_minutes, 0));
        numeric_value := v_old_job_run;
    else
        status := 'PASS';
        detail := format('0 rows past retention+%sh grace on either table — daily cleanup is keeping up (some same-day rows naturally sit past the raw retention boundary between runs; that is expected and not counted here)', p_cleanup_grace_hours);
        numeric_value := 0;
    end if;
    return next;
end;
$$;

revoke all on function public.ops_health_evaluate(numeric, numeric, integer, integer, integer, integer, numeric, numeric, integer, integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.ops_health_evaluate(numeric, numeric, integer, integer, integer, integer, numeric, numeric, integer, integer, integer, integer, integer) to service_role;
