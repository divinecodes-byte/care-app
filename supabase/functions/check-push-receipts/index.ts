// Invoked every 15 minutes by pg_cron (see trigger_check_push_receipts in
// the migration). Expo tickets returned at send-time only catch obviously
// malformed tokens immediately — DeviceNotRegistered (app uninstalled,
// token revoked) is often only visible ~15+ minutes later via the receipts
// endpoint. This is the follow-up half of push-token hygiene.
//
// Week 3 flexible-tasks addition: also checks task_notification_deliveries'
// sent tickets in the same batched Expo call (one Expo API round trip for
// both ledgers rather than a second redundant cron/function) — each row is
// tagged with its source table so the update lands back on the right one.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { assertCronRequest, jsonLog, chunk } from '../_shared/cron-auth.ts';

const FN_NAME = 'check-push-receipts';
const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const RECEIPT_BATCH_SIZE = 300; // Expo's documented max ids per getReceipts call
const LOOKBACK_HOURS = 24;

type ExpoReceipt =
  | { status: 'ok' }
  | { status: 'error'; message: string; details?: { error?: string } };

type Source = 'reminder' | 'task';
type TrackedRow = { source: Source; id: string; recipientId: string; ticketId: string };

Deno.serve(async (req) => {
  const unauthorized = assertCronRequest(req);
  if (unauthorized) return unauthorized;

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const log = (event: string, data?: Record<string, unknown>) => jsonLog(FN_NAME, event, data);
  log('start');

  const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();

  const [{ data: reminderRows, error: reminderError }, { data: taskRows, error: taskError }] = await Promise.all([
    supabase
      .from('reminder_notification_deliveries')
      .select('id, recipient_id, expo_ticket_id')
      .eq('status', 'sent')
      .not('expo_ticket_id', 'is', null)
      .gte('sent_at', since),
    supabase
      .from('task_notification_deliveries')
      .select('id, recipient_id, expo_ticket_id')
      .eq('status', 'sent')
      .not('expo_ticket_id', 'is', null)
      .gte('sent_at', since),
  ]);

  if (reminderError) log('reminder_query_error', { error: reminderError.message });
  if (taskError) log('task_query_error', { error: taskError.message });

  const rows: TrackedRow[] = [
    ...(reminderRows ?? []).map((r: any) => ({ source: 'reminder' as const, id: r.id, recipientId: r.recipient_id, ticketId: r.expo_ticket_id as string })),
    ...(taskRows ?? []).map((r: any) => ({ source: 'task' as const, id: r.id, recipientId: r.recipient_id, ticketId: r.expo_ticket_id as string })),
  ];

  log('scanned', { reminderDeliveries: reminderRows?.length ?? 0, taskDeliveries: taskRows?.length ?? 0 });

  if (rows.length === 0) {
    log('end', { checked: 0, deactivated: 0 });
    return Response.json({ checked: 0, deactivated: 0 });
  }

  // A push_token row can't be recovered from a ticket id alone (Expo's
  // getReceipts only returns ticket -> status), so re-derive which
  // push_tokens row a failing ticket belongs to via the recipient's current
  // active tokens — best-effort: if a recipient has only one active token
  // when a DeviceNotRegistered receipt comes back for them, deactivate it;
  // multi-device disambiguation isn't possible from Expo's response shape
  // alone, so a recipient with several active devices and one stale one
  // among them needs the periodic ticket-time DeviceNotRegistered check
  // (handled in the send functions) to catch it precisely instead.
  const ticketToRow = new Map<string, TrackedRow>();
  for (const row of rows) ticketToRow.set(row.ticketId, row);

  let checked = 0;
  let deactivated = 0;
  const recipientsToDeactivate = new Set<string>();
  const checkedIdsBySource: Record<Source, string[]> = { reminder: [], task: [] };

  for (const batch of chunk(rows.map((r) => r.ticketId), RECEIPT_BATCH_SIZE)) {
    try {
      const res = await fetch(EXPO_RECEIPTS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ids: batch }),
      });
      const json = await res.json();
      const receipts: Record<string, ExpoReceipt> = json.data ?? {};

      for (const ticketId of batch) {
        const receipt = receipts[ticketId];
        checked++;
        const row = ticketToRow.get(ticketId);
        if (row) checkedIdsBySource[row.source].push(row.id);

        if (receipt?.status === 'error' && receipt.details?.error === 'DeviceNotRegistered') {
          if (row) recipientsToDeactivate.add(row.recipientId);
        }
      }
    } catch (err) {
      // The batch fetch itself failed — nothing in this batch was actually
      // checked, so their receipt_checked_at deliberately stays null and
      // they'll be picked up again on the next run.
      log('expo_receipts_batch_error', {
        error: err instanceof Error ? err.message : String(err),
        batchSize: batch.length,
      });
    }
  }

  const nowIso = new Date().toISOString();
  if (checkedIdsBySource.reminder.length > 0) {
    await supabase.from('reminder_notification_deliveries').update({ receipt_checked_at: nowIso }).in('id', checkedIdsBySource.reminder);
  }
  if (checkedIdsBySource.task.length > 0) {
    await supabase.from('task_notification_deliveries').update({ receipt_checked_at: nowIso }).in('id', checkedIdsBySource.task);
  }

  if (recipientsToDeactivate.size > 0) {
    // Deactivate only tokens that are currently the sole active token for a
    // recipient flagged DeviceNotRegistered — safe default for multi-device
    // recipients until per-token ticket tracking (see comment above) is
    // available.
    for (const recipientId of recipientsToDeactivate) {
      const { data: activeTokens } = await supabase
        .from('push_tokens')
        .select('id')
        .eq('user_id', recipientId)
        .eq('is_active', true);

      if (activeTokens && activeTokens.length === 1) {
        await supabase
          .from('push_tokens')
          .update({ is_active: false, updated_at: nowIso })
          .eq('id', activeTokens[0].id);
        deactivated++;
      }
    }
  }

  log('end', { checked, deactivated });
  return Response.json({ checked, deactivated });
});
