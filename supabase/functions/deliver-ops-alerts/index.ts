// Invoked every 10 minutes by pg_cron, right after evaluate-ops-health.
//
// IMPORTANT: no external alert-delivery destination is configured for this
// project (confirmed via `supabase secrets list` and a full codebase grep
// -- no email provider, Slack, webhook, or admin/owner push token exists).
// This function does NOT send anything anywhere. Its only job right now is
// to record, once per alert open-state, an honest 'unconfigured' delivery
// row and log a single clear line saying so -- never claiming delivery is
// active, and never re-attempting/re-logging the same open alert every
// cycle (that would be an indefinite-growth outbox, not useful signal).
//
// To activate real delivery: add a destination secret (e.g. a webhook URL
// or an email-provider API key) and replace the `unconfigured` branch below
// with an actual HTTP call to that destination, keeping the
// one-attempt-per-open-state guard intact (or replacing it with your own
// retry policy) so this can't become the exact spam problem it exists to
// prevent. See docs/operational-alert-model.md.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { assertCronRequest, jsonLog } from '../_shared/cron-auth.ts';

const FN_NAME = 'deliver-ops-alerts';

Deno.serve(async (req) => {
  const unauthorized = assertCronRequest(req);
  if (unauthorized) return unauthorized;

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const log = (event: string, data?: Record<string, unknown>) => jsonLog(FN_NAME, event, data);
  log('start');

  try {
    // Open alerts with no delivery row yet for this open-state -- an alert
    // that resolves and later reopens gets a brand-new row (see the
    // migration's unique-while-open index), so "no delivery row for this
    // alert_id" is exactly "haven't recorded anything for this open-state
    // yet," never a reason to re-fire on an alert that's been open for
    // hours.
    const { data: undelivered, error: selErr } = await supabase.rpc('alerts_needing_initial_delivery');

    if (selErr) {
      log('fatal_error', { message: selErr.message });
      return new Response(JSON.stringify({ error: 'select_failed' }), { status: 500 });
    }

    const alerts = undelivered ?? [];
    let recorded = 0;
    for (const alert of alerts) {
      // No destination configured -- record the honest unconfigured state
      // rather than pretending to deliver.
      log('would_alert_no_destination_configured', { alertKey: alert.alert_key, severity: alert.severity });
      const { error: insErr } = await supabase.from('operational_alert_deliveries').insert({
        alert_id: alert.id,
        status: 'unconfigured',
        detail: `would alert: ${alert.alert_key} (${alert.severity}) — no delivery destination configured`,
      });
      if (insErr) {
        log('delivery_insert_failed', { alertKey: alert.alert_key, message: insErr.message });
        continue;
      }
      recorded++;
    }

    log('done', { candidates: alerts.length, recorded });
    return new Response(JSON.stringify({ candidates: alerts.length, recorded, destinationConfigured: false }), { status: 200 });
  } catch (err) {
    log('fatal_error', { message: err instanceof Error ? err.message : String(err) });
    return new Response(JSON.stringify({ error: 'internal_error' }), { status: 500 });
  }
});
