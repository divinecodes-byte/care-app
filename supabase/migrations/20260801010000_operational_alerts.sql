-- Week 4 Task #1, Phase 13: backend health-alert foundation.
--
-- No external delivery destination exists yet (confirmed this session via
-- `supabase secrets list` and a full codebase grep -- only CRON_SECRET and
-- Supabase's auto-injected keys are present; no email provider, Slack,
-- webhook, or admin/owner push registration anywhere). This migration
-- therefore ships an honest, inert outbox + evaluator only:
--   - operational_alerts: normalized alert state, deduped by alert_key
--     while open, with opened_at/last_seen_at/resolved_at.
--   - operational_alert_deliveries: at most one 'unconfigured' delivery
--     row per alert's open-state (never re-inserted every evaluation
--     cycle) -- see record_ops_alert_evaluation()'s comment for why.
-- Both tables are service-role-only -- no `authenticated`/`anon` RLS
-- policy exists, matching reminder_notification_deliveries' precedent.
--
-- record_ops_alert_evaluation() wraps public.ops_health_evaluate() (the
-- single source of truth also used by scripts/ops-health/run.ts) so the
-- Edge Function and any direct SQL test both exercise identical logic.

create table public.operational_alerts (
    id uuid primary key default gen_random_uuid(),
    alert_key text not null,
    severity text not null check (severity in ('warning', 'critical')),
    opened_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    resolved_at timestamptz,
    summary text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

comment on table public.operational_alerts is
    'Internal ops-health alert outbox. Sanitized summaries only -- no reminder/task/routine content, no push tokens, no participant names. Service-role only.';

-- At most one *open* row per alert_key -- a resolved alert can reopen
-- later as a brand-new row (preserving history of each open/resolved
-- cycle rather than overwriting it).
create unique index idx_operational_alerts_open_key on public.operational_alerts (alert_key) where resolved_at is null;
create index idx_operational_alerts_key_history on public.operational_alerts (alert_key, opened_at desc);

alter table public.operational_alerts enable row level security;
-- Deliberately zero policies granted to authenticated/anon -- service-role
-- and SECURITY DEFINER functions bypass RLS regardless; there is no
-- product UI reading this table yet.

create table public.operational_alert_deliveries (
    id uuid primary key default gen_random_uuid(),
    alert_id uuid not null references public.operational_alerts(id) on delete cascade,
    attempted_at timestamptz not null default now(),
    status text not null check (status in ('sent', 'unconfigured', 'failed')),
    detail text
);

comment on table public.operational_alert_deliveries is
    'One row per delivery attempt for an alert''s open-state. deliver-ops-alerts writes at most one status=unconfigured row per alert_id until a real destination adapter exists -- never re-attempted every evaluation cycle. Service-role only.';

create index idx_operational_alert_deliveries_alert on public.operational_alert_deliveries (alert_id);

alter table public.operational_alert_deliveries enable row level security;

revoke all on public.operational_alerts from public, anon, authenticated;
revoke all on public.operational_alert_deliveries from public, anon, authenticated;
grant all on public.operational_alerts to service_role;
grant all on public.operational_alert_deliveries to service_role;

-- ── Alert-key mapping + open/update/resolve transitions ─────────────────
create or replace function public.record_ops_alert_evaluation()
returns table(alert_key text, transition text, severity text, summary text)
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_catalog'
as $$
declare
    v_check record;
    v_mapped_key text;
    v_severity text;
    v_existing public.operational_alerts%rowtype;
    v_seen_keys text[] := array[]::text[];
    v_stale record;
begin
    for v_check in select * from public.ops_health_evaluate() loop
        v_mapped_key := case
            when v_check.check_name like 'cron:%' then 'cron_not_running'
            when v_check.check_name = 'recipient_pushes:failure_rate' then 'recipient_push_failure_rate'
            when v_check.check_name = 'task_pushes:failure_rate' then 'task_push_failure_rate'
            when v_check.check_name = 'routine_pushes:failure_rate' then 'routine_push_failure_rate'
            when v_check.check_name in ('recipient_pushes:stuck_pending', 'task_pushes:stuck_pending', 'routine_pushes:stuck_pending') then 'stuck_deliveries'
            when v_check.check_name = 'recipient_pushes:retry_exhausted' then 'retry_exhausted'
            when v_check.check_name = 'recipient_pushes:receipt_overdue' then 'receipt_overdue'
            when v_check.check_name = 'retention:pg_net_and_cron_logs' then 'retention_cleanup_failed'
            else null
        end;
        if v_mapped_key is null then
            continue; -- not an alertable check (e.g. push_tokens:inactive, migrations)
        end if;
        if v_check.status = 'PASS' then
            continue; -- handled by the resolve pass below
        end if;

        v_severity := case when v_check.status = 'FAIL' then 'critical' else 'warning' end;
        v_seen_keys := array_append(v_seen_keys, v_mapped_key);

        select * into v_existing from public.operational_alerts a where a.alert_key = v_mapped_key and a.resolved_at is null;
        if v_existing.id is null then
            insert into public.operational_alerts (alert_key, severity, summary)
              values (v_mapped_key, v_severity, v_check.detail)
              returning * into v_existing;
            alert_key := v_mapped_key; transition := 'opened'; severity := v_severity; summary := v_check.detail;
            return next;
        else
            update public.operational_alerts
              set last_seen_at = now(), severity = v_severity, summary = v_check.detail, updated_at = now()
              where id = v_existing.id;
            alert_key := v_mapped_key; transition := 'still_open'; severity := v_severity; summary := v_check.detail;
            return next;
        end if;
    end loop;

    -- Resolve any open alert whose key did NOT appear as WARNING/FAIL this pass.
    for v_stale in
        select * from public.operational_alerts a
        where a.resolved_at is null
          and not (a.alert_key = any(v_seen_keys))
    loop
        update public.operational_alerts set resolved_at = now(), updated_at = now() where id = v_stale.id;
        alert_key := v_stale.alert_key; transition := 'resolved'; severity := v_stale.severity; summary := 'resolved -- check no longer WARNING/FAIL';
        return next;
    end loop;
end;
$$;

revoke all on function public.record_ops_alert_evaluation() from public, anon, authenticated;
grant execute on function public.record_ops_alert_evaluation() to service_role;

-- PostgREST's `.not('id','in', <subquery>)` filter does not support a raw
-- SQL subquery (only a static value list) -- deliver-ops-alerts calls this
-- function via .rpc() instead of trying to express the "no delivery row
-- yet" join as a client-side filter.
create or replace function public.alerts_needing_initial_delivery()
returns table(id uuid, alert_key text, severity text)
language sql
stable
security definer
set search_path to 'public', 'extensions', 'pg_catalog'
as $$
    select a.id, a.alert_key, a.severity
    from public.operational_alerts a
    where a.resolved_at is null
      and not exists (select 1 from public.operational_alert_deliveries d where d.alert_id = a.id);
$$;

revoke all on function public.alerts_needing_initial_delivery() from public, anon, authenticated;
grant execute on function public.alerts_needing_initial_delivery() to service_role;
