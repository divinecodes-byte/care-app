-- Week 4 Task #1, Phase 14: schedule the health-alert evaluator.
--
-- Cadence: every 10 minutes -- within the suggested 5-15 minute range,
-- well clear of the existing 30-second/60-second/5-minute jobs, and
-- matched to what it's actually evaluating (24h-window failure rates,
-- 20-minute receipt-overdue thresholds, daily retention) -- there is no
-- value in evaluating those more often than this.
--
-- One cron job triggers both evaluate-ops-health and deliver-ops-alerts
-- in sequence (rather than two independently-scheduled jobs) so delivery
-- always runs immediately after that same tick's evaluation, never before
-- it on a cold start. Reuses the existing `recipient_push_cron_secret`
-- vault entry -- no new secret is minted, matching every other scheduled
-- Edge Function trigger in this project.

create or replace function public.trigger_evaluate_and_deliver_ops_alerts()
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
    raise warning 'recipient_push_cron_secret not set in vault; skipping evaluate-ops-health/deliver-ops-alerts invocation';
    return;
  end if;

  perform net.http_post(
    url := 'https://ofpzbifonihfutghbjbw.supabase.co/functions/v1/evaluate-ops-health',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );

  perform net.http_post(
    url := 'https://ofpzbifonihfutghbjbw.supabase.co/functions/v1/deliver-ops-alerts',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
end;
$function$;

revoke all on function public.trigger_evaluate_and_deliver_ops_alerts() from public, anon, authenticated;
grant execute on function public.trigger_evaluate_and_deliver_ops_alerts() to service_role;

-- Singleton-checked per this project's own established convention:
-- cron.schedule() on an existing job name replaces it rather than
-- duplicating it, so re-running this migration (or a future one that
-- re-schedules) cannot create a second copy.
select cron.schedule(
  'evaluate-ops-health',
  '*/10 * * * *',
  $$select public.trigger_evaluate_and_deliver_ops_alerts();$$
);
