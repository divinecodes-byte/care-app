// Invoked every minute by pg_cron (see trigger_send_routine_assignment_
// notifications in migration 20260730000000). Sends exactly one
// routine-assignment push per applied routine instance --
// routine_notification_deliveries has a unique(routine_instance_id)
// constraint, so there is structurally no way for this to become a
// repeated nag, and no way for it to combine with the individual
// per-task assignment pushes (those are suppressed entirely for tasks
// created inside apply_routine_template -- see _create_task_core's
// p_suppress_notification parameter).
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { assertCronRequest, jsonLog, chunk } from '../_shared/cron-auth.ts';

const FN_NAME = 'send-routine-assignment-notifications';
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_BATCH_SIZE = 100;
const MAX_ATTEMPTS = 5;
const RETRY_COOLDOWN_SECONDS = 30;

type PreviewMode = 'private' | 'detailed';
const PRIVATE_TITLE = 'Tavora routine';
const PRIVATE_BODY = 'You have a new routine waiting.';
const DETAILED_BODY = 'You have a new routine waiting.';

type DeliveryRow = {
  id: string;
  routine_instance_id: string;
  recipient_id: string;
  status: string;
  attempt_count: number;
};

type ExpoTicket =
  | { status: 'ok'; id: string }
  | { status: 'error'; message: string; details?: { error?: string } };

Deno.serve(async (req) => {
  const unauthorized = assertCronRequest(req);
  if (unauthorized) return unauthorized;

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const log = (event: string, data?: Record<string, unknown>) => jsonLog(FN_NAME, event, data);
  log('start');

  try {
    return await handleTick();
  } catch (err) {
    log('fatal_error', { error: err instanceof Error ? err.message : String(err) });
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }

  async function handleTick(): Promise<Response> {
    const { data: rows, error: queryError } = await supabase
      .from('routine_notification_deliveries')
      .select('id, routine_instance_id, recipient_id, status, attempt_count')
      .in('status', ['pending', 'failed'])
      .lt('attempt_count', MAX_ATTEMPTS)
      .lt('updated_at', new Date(Date.now() - RETRY_COOLDOWN_SECONDS * 1000).toISOString())
      .limit(200);

    if (queryError) log('query_error', { error: queryError.message });
    const toProcess = (rows ?? []) as DeliveryRow[];
    log('scanned', { toProcess: toProcess.length });

    if (toProcess.length === 0) {
      log('end', { sent: 0, failed: 0 });
      return Response.json({ scanned: 0, sent: 0, failed: 0 });
    }

    const nowIso = new Date().toISOString();
    let sent = 0;
    let failed = 0;

    // Small volume (at most one row per applied routine, ever) -- a
    // per-row round trip is simple and fine, matching the task-assignment
    // pipeline's own precedent rather than the higher-volume recurring
    // reminder pipeline's batched-RPC approach.
    for (const row of toProcess) {
      const { data: instance, error: instanceError } = await supabase
        .from('routine_instances')
        .select('id, title, status, connection_id, participant_id')
        .eq('id', row.routine_instance_id)
        .maybeSingle();

      if (instanceError) {
        failed++;
        await markFailed(row, 'internal_error', 'routine lookup failed, will retry');
        continue;
      }
      if (!instance) {
        failed++;
        await markFailed(row, 'routine_inactive', 'routine_not_found');
        continue;
      }
      if (instance.status !== 'active') {
        failed++;
        await markFailed(row, 'routine_inactive', 'routine_archived');
        continue;
      }

      const { data: connection } = await supabase
        .from('connections')
        .select('status, accepted_at')
        .eq('id', instance.connection_id)
        .maybeSingle();
      if (!connection || connection.status !== 'accepted' || !connection.accepted_at) {
        failed++;
        await markFailed(row, 'connection_inactive', 'connection_inactive');
        continue;
      }

      const { data: tokens } = await supabase
        .from('push_tokens')
        .select('id, expo_push_token')
        .eq('user_id', row.recipient_id)
        .eq('is_active', true);

      if (!tokens || tokens.length === 0) {
        failed++;
        await markFailed(row, 'no_active_push_token', 'no_active_push_token');
        continue;
      }

      const { data: profile } = await supabase
        .from('profiles')
        .select('notification_preview_mode')
        .eq('id', row.recipient_id)
        .maybeSingle();
      const mode: PreviewMode = profile?.notification_preview_mode === 'detailed' ? 'detailed' : 'private';
      const title = PRIVATE_TITLE;
      // Detailed mode may include the routine title only -- never notes,
      // and never a list of the routine's individual item titles.
      const body = mode === 'detailed' && instance.title ? `"${instance.title}" — ${DETAILED_BODY}` : PRIVATE_BODY;

      const messages = tokens.map((tk: { id: string; expo_push_token: string }) => ({
        to: tk.expo_push_token,
        title,
        body,
        sound: 'default',
        data: { routineInstanceId: instance.id, notificationType: 'routine_assignment' },
      }));

      let anyOk = false;
      let ticketId: string | undefined;
      let lastError: string | undefined;
      let lastErrorDetail: string | undefined;
      let deviceNotRegisteredTokenIds: string[] = [];

      try {
        for (const batch of chunk(messages, EXPO_BATCH_SIZE)) {
          const res = await fetch(EXPO_PUSH_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(batch),
          });
          const json = await res.json();
          const tickets: ExpoTicket[] = json.data ?? [];
          tickets.forEach((ticket, i) => {
            if (ticket.status === 'ok') {
              anyOk = true;
              ticketId = ticket.id;
            } else {
              lastError = ticket.message ?? 'expo_ticket_error';
              lastErrorDetail = ticket.details?.error;
              if (ticket.details?.error === 'DeviceNotRegistered') {
                deviceNotRegisteredTokenIds.push(tokens[i]?.id);
              }
            }
          });
        }
      } catch (err) {
        lastError = 'expo_request_failed';
        log('expo_request_error', { error: err instanceof Error ? err.message : String(err) });
      }

      if (deviceNotRegisteredTokenIds.length > 0) {
        await supabase
          .from('push_tokens')
          .update({ is_active: false, updated_at: nowIso })
          .in('id', deviceNotRegisteredTokenIds.filter(Boolean));
      }

      if (anyOk) {
        sent++;
        await supabase
          .from('routine_notification_deliveries')
          .update({ status: 'sent', sent_at: nowIso, updated_at: nowIso, expo_ticket_id: ticketId ?? null, error_code: null, error_message: null })
          .eq('id', row.id);
        continue;
      }

      failed++;
      const code = lastErrorDetail === 'DeviceNotRegistered'
        ? 'device_not_registered'
        : lastError === 'expo_request_failed'
        ? 'internal_error'
        : 'expo_ticket_error';
      await markFailed(row, code, sanitizeMessage(lastError ?? 'unknown_error'));
    }

    log('end', { sent, failed });
    return Response.json({ scanned: toProcess.length, sent, failed });

    async function markFailed(row: DeliveryRow, code: string, message: string) {
      await supabase
        .from('routine_notification_deliveries')
        .update({
          status: 'failed',
          attempt_count: row.attempt_count + 1,
          error_code: code,
          error_message: message,
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id);
    }
  }
});

const TOKEN_PATTERN = /ExponentPushToken\[[^\]]*\]/g;
function sanitizeMessage(raw: string): string {
  return raw.replace(TOKEN_PATTERN, 'ExponentPushToken[REDACTED]').slice(0, 300);
}
