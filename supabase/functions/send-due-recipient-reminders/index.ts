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

// ── Error normalization (ops-hardening) ─────────────────────────────────────
// A raw Expo ticket message can embed the full push token (e.g. `"Exponent
// PushToken[xxx]" is not a valid Expo push token`) — always redact before
// persisting. error_code is the small, fixed, queryable vocabulary; the
// (redacted, truncated) message is for human debugging only.
const TOKEN_PATTERN = /ExponentPushToken\[[^\]]*\]/g;

function sanitizeMessage(raw: string): string {
  return raw.replace(TOKEN_PATTERN, 'ExponentPushToken[REDACTED]').slice(0, 300);
}

function normalizeSkipReason(reason: string): { code: string; message: string } {
  if (reason === 'reminder_not_found') return { code: 'reminder_not_found', message: reason };
  if (reason === 'reminder_inactive') return { code: 'reminder_inactive', message: reason };
  if (reason === 'reminder_reassigned') return { code: 'reminder_reassigned', message: reason };
  if (reason.startsWith('snooze_no_longer_pending:') || reason.startsWith('already_answered:')) {
    return { code: 'occurrence_answered', message: reason };
  }
  return { code: 'internal_error', message: sanitizeMessage(reason) };
}

function normalizeSendError(lastError: string | undefined, lastErrorDetail: string | undefined): { code: string; message: string } {
  if (lastErrorDetail === 'DeviceNotRegistered') {
    return { code: 'device_not_registered', message: sanitizeMessage(lastError ?? lastErrorDetail) };
  }
  if (lastError === 'no_active_push_token') return { code: 'no_active_push_token', message: lastError };
  if (lastError === 'expo_request_failed') return { code: 'internal_error', message: lastError };
  if (lastError === 'no_ticket_returned') return { code: 'expo_ticket_error', message: lastError };
  if (lastError && lastError.toLowerCase().includes('batch')) {
    return { code: 'expo_batch_error', message: sanitizeMessage(lastError) };
  }
  return { code: 'expo_ticket_error', message: sanitizeMessage(lastError ?? 'unknown_error') };
}

Deno.serve(async (req) => {
  const unauthorized = assertCronRequest(req);
  if (unauthorized) return unauthorized;

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const log = (event: string, data?: Record<string, unknown>) => jsonLog(FN_NAME, event, data);
  log('start');

  // Defensive top-level catch: anything unexpected here must still return a
  // clean, logged response rather than an opaque runtime crash — and,
  // combined with the per-row isolation above, means a single bad row can
  // no longer take an entire tick's batch down with it.
  try {
  return await handleTick();
  } catch (err) {
    log('fatal_error', { error: err instanceof Error ? err.message : String(err) });
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }

  async function handleTick(): Promise<Response> {
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

  // Lookup helpers distinguish "confirmed not found / null" (a real skip
  // reason) from "the lookup itself failed" (a transient error that must be
  // retried, never silently treated as if the row didn't exist — this is
  // the fix for a crashed/erroring lookup being able to leave a delivery
  // stuck: previously an unhandled exception here aborted the entire
  // invocation, and every row in the batch — not just the one that failed —
  // would have been left completely unprocessed with no attempt_count
  // increment, indefinitely).
  type Lookup<T> = { ok: true; value: T } | { ok: false };

  const reminderCache = new Map<string, ReminderInfo | null>();
  async function getReminder(reminderId: string): Promise<Lookup<ReminderInfo | null>> {
    if (reminderCache.has(reminderId)) return { ok: true, value: reminderCache.get(reminderId)! };
    try {
      const { data, error } = await supabase
        .from('reminders')
        .select('id, title, reminder_type, recipient_id, is_active')
        .eq('id', reminderId)
        .maybeSingle();
      if (error) {
        log('get_reminder_error', { reminderId, error: error.message });
        return { ok: false };
      }
      const value = (data as ReminderInfo | null) ?? null;
      reminderCache.set(reminderId, value);
      return { ok: true, value };
    } catch (err) {
      log('get_reminder_exception', { reminderId, error: err instanceof Error ? err.message : String(err) });
      return { ok: false };
    }
  }

  const logCache = new Map<string, string | null>();
  async function getLogStatus(reminderId: string, occurrenceDate: string): Promise<Lookup<string | null>> {
    const key = `${reminderId}|${occurrenceDate}`;
    if (logCache.has(key)) return { ok: true, value: logCache.get(key)! };
    try {
      const { data, error } = await supabase
        .from('reminder_logs')
        .select('status')
        .eq('reminder_id', reminderId)
        .eq('occurrence_date', occurrenceDate)
        .maybeSingle();
      if (error) {
        log('get_log_status_error', { reminderId, occurrenceDate, error: error.message });
        return { ok: false };
      }
      const status = data?.status ?? null;
      logCache.set(key, status);
      return { ok: true, value: status };
    } catch (err) {
      log('get_log_status_exception', { reminderId, occurrenceDate, error: err instanceof Error ? err.message : String(err) });
      return { ok: false };
    }
  }

  const tokenCache = new Map<string, { id: string; expo_push_token: string }[]>();
  async function getActiveTokens(recipientId: string): Promise<{ id: string; expo_push_token: string }[]> {
    if (tokenCache.has(recipientId)) return tokenCache.get(recipientId)!;
    try {
      const { data, error } = await supabase
        .from('push_tokens')
        .select('id, expo_push_token')
        .eq('user_id', recipientId)
        .eq('is_active', true);
      if (error) log('get_active_tokens_error', { recipientId, error: error.message });
      const tokens = data ?? [];
      tokenCache.set(recipientId, tokens);
      return tokens;
    } catch (err) {
      log('get_active_tokens_exception', { recipientId, error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }

  // ── Phase 1: re-validate live state right before sending ──────────────────
  const skipReasons = new Map<string, string>();
  const lookupFailedRows: DeliveryRow[] = [];
  const attemptRows: DeliveryRow[] = [];

  for (const row of toProcess) {
    try {
      const reminderLookup = await getReminder(row.reminder_id);
      if (!reminderLookup.ok) {
        lookupFailedRows.push(row);
        continue;
      }
      const reminder = reminderLookup.value;
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

      const logLookup = await getLogStatus(row.reminder_id, row.occurrence_date);
      if (!logLookup.ok) {
        lookupFailedRows.push(row);
        continue;
      }
      const logStatus = logLookup.value;

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
    } catch (err) {
      // Defensive catch-all: whatever went wrong for this one row must
      // never abort processing of the rest of the batch.
      log('validate_row_exception', { deliveryId: row.id, error: err instanceof Error ? err.message : String(err) });
      lookupFailedRows.push(row);
    }
  }

  if (skipReasons.size > 0) {
    const skippedNow = new Date().toISOString();
    await Promise.all(
      [...skipReasons.entries()].map(([id, reason]) => {
        const normalized = normalizeSkipReason(reason);
        return supabase
          .from('reminder_notification_deliveries')
          .update({ status: 'skipped', error_code: normalized.code, error_message: normalized.message, updated_at: skippedNow })
          .eq('id', id);
      })
    );
  }

  log('validated', { skipped: skipReasons.size, lookupFailed: lookupFailedRows.length, toAttempt: attemptRows.length });

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
  const rowOutcome = new Map<string, { anyOk: boolean; ticketId?: string; lastError?: string; lastErrorDetail?: string }>();

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
          existing.lastErrorDetail = ticket.details?.error;
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
          error_code: null,
          error_message: null,
        })
        .eq('id', row.id);
      continue;
    }

    if (outcome.lastError === 'no_active_push_token') missingToken++;
    failed++;
    const normalized = normalizeSendError(outcome.lastError, outcome.lastErrorDetail);
    const nextAttempt = row.attempt_count + 1;
    await supabase
      .from('reminder_notification_deliveries')
      .update({
        status: nextAttempt >= MAX_ATTEMPTS ? 'skipped' : 'failed',
        attempt_count: nextAttempt,
        error_code: normalized.code,
        error_message: normalized.message,
        updated_at: nowIso,
      })
      .eq('id', row.id);
  }

  // Rows whose live-state lookup itself failed (transient DB/network error,
  // not a real skip reason) are retried exactly like a failed send attempt —
  // this is what guarantees they can never sit unprocessed with
  // attempt_count stuck at its old value indefinitely.
  for (const row of lookupFailedRows) {
    failed++;
    const nextAttempt = row.attempt_count + 1;
    await supabase
      .from('reminder_notification_deliveries')
      .update({
        status: nextAttempt >= MAX_ATTEMPTS ? 'skipped' : 'failed',
        attempt_count: nextAttempt,
        error_code: 'internal_error',
        error_message: 'live-state lookup failed, will retry',
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
    lookupFailed: lookupFailedRows.length,
    missingToken,
    tokensDeactivated: tokensToDeactivate.size,
  });

  return Response.json({
    scanned: toProcess.length,
    sent,
    failed,
    skipped: skipReasons.size,
    lookupFailed: lookupFailedRows.length,
    missingToken,
  });
  }
});
