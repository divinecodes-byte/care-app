// Invoked every 30s by pg_cron (see trigger_send_due_recipient_reminders in
// the migration). Claims due recipient reminder/snooze occurrences, re-
// validates each against live DB state, and sends Expo push notifications —
// this function, not the recipient device, is the sole authority on whether
// and when a recipient reminder push goes out.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { assertCronRequest, jsonLog, chunk } from '../_shared/cron-auth.ts';

const FN_NAME = 'send-due-recipient-reminders';
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_BATCH_SIZE = 100;
const MAX_ATTEMPTS = 5;
const RETRY_COOLDOWN_SECONDS = 30;

type DeliveryRow = {
  id: string;
  reminder_id: string;
  recipient_id: string;
  occurrence_date: string;
  scheduled_for: string;
  delivery_type: 'reminder' | 'snooze';
  status: string;
  attempt_count: number;
};

type ReminderInfo = {
  id: string;
  title: string;
  reminder_type: string;
  recipient_id: string;
  is_active: boolean;
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

  const [reminderClaim, snoozeClaim] = await Promise.all([
    supabase.rpc('claim_due_recipient_reminder_deliveries'),
    supabase.rpc('claim_due_recipient_snooze_deliveries'),
  ]);

  if (reminderClaim.error) log('claim_reminders_error', { error: reminderClaim.error.message });
  if (snoozeClaim.error) log('claim_snoozes_error', { error: snoozeClaim.error.message });

  const retryQuery = await supabase
    .from('reminder_notification_deliveries')
    .select('id, reminder_id, recipient_id, occurrence_date, scheduled_for, delivery_type, status, attempt_count')
    .in('status', ['failed', 'pending'])
    .lt('attempt_count', MAX_ATTEMPTS)
    .lt('updated_at', new Date(Date.now() - RETRY_COOLDOWN_SECONDS * 1000).toISOString());

  if (retryQuery.error) log('retry_query_error', { error: retryQuery.error.message });

  const claimed = [...(reminderClaim.data ?? []), ...(snoozeClaim.data ?? [])] as DeliveryRow[];
  const retryable = (retryQuery.data ?? []) as DeliveryRow[];

  // A row freshly claimed this tick can't also be retry-eligible (it was
  // just inserted, updated_at is now()), but key by id defensively anyway.
  const byId = new Map<string, DeliveryRow>();
  for (const row of [...claimed, ...retryable]) byId.set(row.id, row);
  const toProcess = [...byId.values()];

  log('scanned', { claimed: claimed.length, retryable: retryable.length, toProcess: toProcess.length });

  if (toProcess.length === 0) {
    log('end', { sent: 0, failed: 0, skipped: 0, missingToken: 0 });
    return Response.json({ scanned: 0, sent: 0, failed: 0, skipped: 0 });
  }

  const reminderCache = new Map<string, ReminderInfo | null>();
  async function getReminder(reminderId: string): Promise<ReminderInfo | null> {
    if (reminderCache.has(reminderId)) return reminderCache.get(reminderId)!;
    const { data, error } = await supabase
      .from('reminders')
      .select('id, title, reminder_type, recipient_id, is_active')
      .eq('id', reminderId)
      .maybeSingle();
    if (error) log('get_reminder_error', { reminderId, error: error.message });
    reminderCache.set(reminderId, (data as ReminderInfo | null) ?? null);
    return (data as ReminderInfo | null) ?? null;
  }

  const logCache = new Map<string, string | null>();
  async function getLogStatus(reminderId: string, occurrenceDate: string): Promise<string | null> {
    const key = `${reminderId}|${occurrenceDate}`;
    if (logCache.has(key)) return logCache.get(key)!;
    const { data, error } = await supabase
      .from('reminder_logs')
      .select('status')
      .eq('reminder_id', reminderId)
      .eq('occurrence_date', occurrenceDate)
      .maybeSingle();
    if (error) log('get_log_status_error', { reminderId, occurrenceDate, error: error.message });
    const status = data?.status ?? null;
    logCache.set(key, status);
    return status;
  }

  const tokenCache = new Map<string, { id: string; expo_push_token: string }[]>();
  async function getActiveTokens(recipientId: string) {
    if (tokenCache.has(recipientId)) return tokenCache.get(recipientId)!;
    const { data, error } = await supabase
      .from('push_tokens')
      .select('id, expo_push_token')
      .eq('user_id', recipientId)
      .eq('is_active', true);
    if (error) log('get_active_tokens_error', { recipientId, error: error.message });
    const tokens = data ?? [];
    tokenCache.set(recipientId, tokens);
    return tokens;
  }

  // ── Phase 1: re-validate live state right before sending ──────────────────
  const skipReasons = new Map<string, string>();
  const attemptRows: DeliveryRow[] = [];

  for (const row of toProcess) {
    const reminder = await getReminder(row.reminder_id);
    if (!reminder) {
      skipReasons.set(row.id, 'reminder_not_found');
      continue;
    }
    if (!reminder.is_active) {
      skipReasons.set(row.id, 'reminder_inactive');
      continue;
    }
    if (reminder.recipient_id !== row.recipient_id) {
      skipReasons.set(row.id, 'reminder_reassigned');
      continue;
    }

    const logStatus = await getLogStatus(row.reminder_id, row.occurrence_date);
    if (row.delivery_type === 'snooze') {
      // Taken/Skipped/re-snoozed-elsewhere since the claim — don't send a
      // stale snooze re-alert.
      if (logStatus !== 'snoozed') {
        skipReasons.set(row.id, `snooze_no_longer_pending:${logStatus ?? 'none'}`);
        continue;
      }
    } else if (logStatus !== null && logStatus !== 'pending') {
      // Answered (taken/skipped/snoozed/missed) since the claim.
      skipReasons.set(row.id, `already_answered:${logStatus}`);
      continue;
    }

    attemptRows.push(row);
  }

  if (skipReasons.size > 0) {
    const skippedNow = new Date().toISOString();
    await Promise.all(
      [...skipReasons.entries()].map(([id, reason]) =>
        supabase
          .from('reminder_notification_deliveries')
          .update({ status: 'skipped', error_message: reason, updated_at: skippedNow })
          .eq('id', id)
      )
    );
  }

  log('validated', { skipped: skipReasons.size, toAttempt: attemptRows.length });

  // ── Phase 2: build Expo messages ───────────────────────────────────────────
  type PendingMessage = {
    rowId: string;
    tokenId: string;
    to: string;
    title: string;
    body: string;
    data: Record<string, unknown>;
  };

  const messages: PendingMessage[] = [];
  const rowOutcome = new Map<string, { anyOk: boolean; ticketId?: string; lastError?: string }>();

  for (const row of attemptRows) {
    const reminder = reminderCache.get(row.reminder_id)!;
    const tokens = await getActiveTokens(row.recipient_id);

    if (tokens.length === 0) {
      rowOutcome.set(row.id, { anyOk: false, lastError: 'no_active_push_token' });
      continue;
    }

    for (const token of tokens) {
      messages.push({
        rowId: row.id,
        tokenId: token.id,
        to: token.expo_push_token,
        title: reminder.title,
        body:
          row.delivery_type === 'snooze'
            ? 'Snoozed reminder — time to respond.'
            : 'Time to respond to this reminder.',
        data: {
          reminderId: row.reminder_id,
          recipientId: row.recipient_id,
          occurrenceDate: row.occurrence_date,
          scheduledFor: row.scheduled_for,
          reminderType: reminder.reminder_type,
          title: reminder.title,
          notificationType: row.delivery_type,
        },
      });
    }
  }

  // ── Phase 3: send in Expo-sized batches, parse tickets ─────────────────────
  const tokensToDeactivate = new Set<string>();

  for (const batch of chunk(messages, EXPO_BATCH_SIZE)) {
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(
          batch.map((m) => ({
            to: m.to,
            title: m.title,
            body: m.body,
            data: m.data,
            sound: 'default',
            priority: 'high',
            // Expo's server-side Push API uses hyphenated enum values here —
            // distinct from expo-notifications' client-side camelCase
            // 'timeSensitive' used for local notifications.
            interruptionLevel: 'time-sensitive',
            channelId: 'care-reminders',
          }))
        ),
      });
      const json = await res.json();

      if (Array.isArray(json.errors) && json.errors.length > 0) {
        // Batch-level validation error (e.g. malformed request) — Expo
        // rejects the whole batch with no per-message tickets at all.
        const batchError = json.errors[0]?.message ?? 'expo_batch_validation_error';
        log('expo_batch_validation_error', { error: batchError, batchSize: batch.length });
        for (const m of batch) {
          const existing = rowOutcome.get(m.rowId) ?? { anyOk: false };
          existing.lastError = existing.lastError ?? batchError;
          rowOutcome.set(m.rowId, existing);
        }
        continue;
      }

      const tickets: ExpoTicket[] = json.data ?? [];

      batch.forEach((m, i) => {
        const ticket = tickets[i];
        const existing = rowOutcome.get(m.rowId) ?? { anyOk: false };

        if (!ticket) {
          existing.lastError = existing.lastError ?? 'no_ticket_returned';
        } else if (ticket.status === 'ok') {
          existing.anyOk = true;
          existing.ticketId = ticket.id;
        } else {
          existing.lastError = ticket.message;
          if (ticket.details?.error === 'DeviceNotRegistered') {
            tokensToDeactivate.add(m.tokenId);
          }
        }
        rowOutcome.set(m.rowId, existing);
      });
    } catch (err) {
      log('expo_batch_error', { error: err instanceof Error ? err.message : String(err), batchSize: batch.length });
      for (const m of batch) {
        const existing = rowOutcome.get(m.rowId) ?? { anyOk: false };
        existing.lastError = existing.lastError ?? 'expo_request_failed';
        rowOutcome.set(m.rowId, existing);
      }
    }
  }

  // ── Phase 4: persist outcomes ───────────────────────────────────────────────
  let sent = 0;
  let failed = 0;
  let missingToken = 0;
  const nowIso = new Date().toISOString();

  for (const row of attemptRows) {
    const outcome = rowOutcome.get(row.id);
    if (!outcome) continue;

    if (outcome.anyOk) {
      sent++;
      await supabase
        .from('reminder_notification_deliveries')
        .update({
          status: 'sent',
          sent_at: nowIso,
          updated_at: nowIso,
          expo_ticket_id: outcome.ticketId ?? null,
          error_message: null,
        })
        .eq('id', row.id);
      continue;
    }

    if (outcome.lastError === 'no_active_push_token') missingToken++;
    failed++;
    const nextAttempt = row.attempt_count + 1;
    await supabase
      .from('reminder_notification_deliveries')
      .update({
        status: nextAttempt >= MAX_ATTEMPTS ? 'skipped' : 'failed',
        attempt_count: nextAttempt,
        error_message: outcome.lastError ?? 'unknown_error',
        updated_at: nowIso,
      })
      .eq('id', row.id);
  }

  if (tokensToDeactivate.size > 0) {
    await supabase
      .from('push_tokens')
      .update({ is_active: false, updated_at: nowIso })
      .in('id', [...tokensToDeactivate]);
  }

  log('end', {
    sent,
    failed,
    skipped: skipReasons.size,
    missingToken,
    tokensDeactivated: tokensToDeactivate.size,
  });

  return Response.json({
    scanned: toProcess.length,
    sent,
    failed,
    skipped: skipReasons.size,
    missingToken,
  });
});
