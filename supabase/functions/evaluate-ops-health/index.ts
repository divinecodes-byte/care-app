// Invoked every 10 minutes by pg_cron (see trigger_evaluate_ops_health in
// the migration). Calls public.record_ops_alert_evaluation(), which itself
// wraps public.ops_health_evaluate() -- the exact same SQL function
// scripts/ops-health/run.ts's terminal report reads. This is deliberate:
// the CLI report and the automatic evaluator can never compute a different
// verdict for the same underlying state, because there is only one place
// the WARN/FAIL thresholds live (Week 4 Task #1, Phase E).
//
// This function only opens/updates/resolves rows in operational_alerts --
// it never attempts delivery itself. deliver-ops-alerts (separate function,
// separate cron) is the only thing that writes to
// operational_alert_deliveries, and since no external destination is
// configured yet, that function's current behavior is an honest
// "unconfigured" stub -- see its own header comment.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { assertCronRequest, jsonLog } from '../_shared/cron-auth.ts';

const FN_NAME = 'evaluate-ops-health';

Deno.serve(async (req) => {
  const unauthorized = assertCronRequest(req);
  if (unauthorized) return unauthorized;

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const log = (event: string, data?: Record<string, unknown>) => jsonLog(FN_NAME, event, data);
  log('start');

  try {
    const { data, error } = await supabase.rpc('record_ops_alert_evaluation');
    if (error) {
      log('fatal_error', { message: error.message });
      return new Response(JSON.stringify({ error: 'evaluation_failed' }), { status: 500 });
    }

    const transitions = (data ?? []) as { alert_key: string; transition: string; severity: string }[];
    const opened = transitions.filter((t) => t.transition === 'opened').length;
    const stillOpen = transitions.filter((t) => t.transition === 'still_open').length;
    const resolved = transitions.filter((t) => t.transition === 'resolved').length;

    log('done', { opened, stillOpen, resolved });
    return new Response(JSON.stringify({ opened, stillOpen, resolved }), { status: 200 });
  } catch (err) {
    log('fatal_error', { message: err instanceof Error ? err.message : String(err) });
    return new Response(JSON.stringify({ error: 'internal_error' }), { status: 500 });
  }
});
