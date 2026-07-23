// Invoked every 15 minutes by pg_cron (see trigger_check_push_receipts in
// the migration). Expo tickets returned at send-time only catch obviously
// malformed tokens immediately — DeviceNotRegistered (app uninstalled,
// token revoked) is often only visible ~15+ minutes later via the receipts
// endpoint. This is the follow-up half of push-token hygiene.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { assertCronRequest, jsonLog, chunk } from '../_shared/cron-auth.ts';

const FN_NAME = 'check-push-receipts';
const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const RECEIPT_BATCH_SIZE = 300; // Expo's documented max ids per getReceipts call
const LOOKBACK_HOURS = 24;

type ExpoReceipt =
  | { status: 'ok' }
  | { status: 'error'; message: string; details?: { error?: string } };

Deno.serve(async (req) => {
  const unauthorized = assertCronRequest(req);
  if (unauthorized) return unauthorized;

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const log = (event: string, data?: Record<string, unknown>) => jsonLog(FN_NAME, event, data);
  log('start');

  const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();

  const { data: deliveries, error } = await supabase
    .from('reminder_notification_deliveries')
    .select('id, recipient_id, expo_ticket_id')
    .eq('status', 'sent')
    .not('expo_ticket_id', 'is', null)
    .gte('sent_at', since);

  if (error) {
    log('query_error', { error: error.message });
    return Response.json({ error: error.message }, { status: 500 });
  }

  const rows = deliveries ?? [];
  log('scanned', { deliveries: rows.length });

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
  // (handled in send-due-recipient-reminders) to catch it precisely instead.
  const ticketToRecipient = new Map<string, string>();
  const ticketToDeliveryId = new Map<string, string>();
  for (const row of rows) {
    if (row.expo_ticket_id) {
      ticketToRecipient.set(row.expo_ticket_id, row.recipient_id);
      ticketToDeliveryId.set(row.expo_ticket_id, row.id);
    }
  }

  let checked = 0;
  let deactivated = 0;
  const recipientsToDeactivate = new Set<string>();
  const checkedDeliveryIds: string[] = [];

  for (const batch of chunk(rows.map((r) => r.expo_ticket_id!), RECEIPT_BATCH_SIZE)) {
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
        // Recorded regardless of outcome — "checked" means we got a
        // response from Expo for this ticket, ok or not, which is what
        // receipt_checked_at/"receipt overdue" monitoring needs to know.
        const deliveryId = ticketToDeliveryId.get(ticketId);
        if (deliveryId) checkedDeliveryIds.push(deliveryId);

        if (receipt?.status === 'error' && receipt.details?.error === 'DeviceNotRegistered') {
          const recipientId = ticketToRecipient.get(ticketId);
          if (recipientId) recipientsToDeactivate.add(recipientId);
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

  if (checkedDeliveryIds.length > 0) {
    await supabase
      .from('reminder_notification_deliveries')
      .update({ receipt_checked_at: new Date().toISOString() })
      .in('id', checkedDeliveryIds);
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
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq('id', activeTokens[0].id);
        deactivated++;
      }
    }
  }

  log('end', { checked, deactivated });
  return Response.json({ checked, deactivated });
});
