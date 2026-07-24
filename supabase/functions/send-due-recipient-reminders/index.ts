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

// ── Notification-preview privacy (ops-hardening task #5) ────────────────────
// private (default): generic banner text, no reminder title anywhere in the
// payload. detailed: the recipient explicitly opted in via Settings, so the
// banner (not content.data — that stays minimal either way) may show the
// reminder's own title. A preference that can't be read for any reason
// always resolves to 'private' — never silently upgrades to detailed.
type PreviewMode = 'private' | 'detailed';
const DEFAULT_REMINDER_TITLE = 'Reminder';

const PRIVATE_REMINDER_TITLE = 'Tavora reminder';
const PRIVATE_REMINDER_BODY = 'You have a reminder waiting.';
const PRIVATE_SNOOZE_BODY = 'Your snoozed reminder is ready.';
const DETAILED_REMINDER_BODY = 'Time to respond to this reminder.';
const DETAILED_SNOOZE_BODY = 'Snoozed reminder — time to respond.';

function buildNotificationContent(
  mode: PreviewMode,
  deliveryType: 'reminder' | 'snooze',
  reminderTitle: string
): { title: string; body: string } {
  if (mode !== 'detailed') {
    return {
      title: PRIVATE_REMINDER_TITLE,
      body: deliveryType === 'snooze' ? PRIVATE_SNOOZE_BODY : PRIVATE_REMINDER_BODY,
    };
  }
  return {
    title: reminderTitle.trim() || DEFAULT_REMINDER_TITLE,
    body: deliveryType === 'snooze' ? DETAILED_SNOOZE_BODY : DETAILED_REMINDER_BODY,
  };
}

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

// Skip codes now come directly from validate_reminder_deliveries_for_send
// (Week 1 task #8) -- it already returns one of this exact vocabulary, so
// there's no free-text reason string left to parse/classify here.
const KNOWN_SKIP_CODES = new Set([
  'reminder_not_found',
  'reminder_inactive',
  'reminder_reassigned',
  'connection_inactive',
  'stale_schedule',
  'occurrence_ineligible',
  'occurrence_answered',
]);

function normalizeSkipReason(code: string): { code: string; message: string } {
  if (KNOWN_SKIP_CODES.has(code)) return { code, message: code };
  return { code: 'internal_error', message: sanitizeMessage(code) };
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

  // Content lookup (title only, for the Expo message body in detailed
  // mode) — deliberately separate from validation now. Live
  // reminder/connection/schedule-revision/occurrence-answered validation
  // is delegated entirely to validate_reminder_deliveries_for_send (Week 1
  // task #8), a single native-SQL function that recomputes the exact same
  // AT TIME ZONE math the claim functions use, in one batched round trip —
  // this is what closes the edit-race window a per-row JS-side re-check
  // could never fully cover (see docs/reminder-editing-model.md).
  type Lookup<T> = { ok: true; value: T } | { ok: false };

  const reminderCache = new Map<string, ReminderInfo | null>();
  async function getReminderContent(reminderId: string): Promise<Lookup<ReminderInfo | null>> {
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

  // Unlike getReminderContent, a failed lookup here must never block or
  // retry a send — it fails toward the safe default (private) and the
  // notification still goes out, just with generic content. This is the
  // literal "fail private, do not default to detailed" requirement.
  const previewModeCache = new Map<string, PreviewMode>();
  async function getPreviewMode(recipientId: string): Promise<PreviewMode> {
    if (previewModeCache.has(recipientId)) return previewModeCache.get(recipientId)!;
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('notification_preview_mode')
        .eq('id', recipientId)
        .maybeSingle();
      const mode: PreviewMode = !error && data?.notification_preview_mode === 'detailed' ? 'detailed' : 'private';
      previewModeCache.set(recipientId, mode);
      return mode;
    } catch {
      previewModeCache.set(recipientId, 'private');
      return 'private';
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
  // One batched call — every row gets a single, internally-consistent
  // snapshot of reminder/connection/schedule-revision/occurrence state,
  // computed natively in Postgres. A failure of the call itself (network/
  // DB error) is a lookup failure for the *whole batch*, retried exactly
  // like a failed send attempt — never silently treated as if every row
  // had failed validation for a real reason.
  const skipReasons = new Map<string, string>();
  const lookupFailedRows: DeliveryRow[] = [];
  const attemptRows: DeliveryRow[] = [];

  try {
    const { data: verdicts, error: validateError } = await supabase.rpc('validate_reminder_deliveries_for_send', {
      p_delivery_ids: toProcess.map((r) => r.id),
    });

    if (validateError) {
      log('validate_batch_error', { error: validateError.message });
      lookupFailedRows.push(...toProcess);
    } else {
      const verdictById = new Map<string, { ok: boolean; skip_code: string | null }>(
        (verdicts ?? []).map((v: { delivery_id: string; ok: boolean; skip_code: string | null }) => [v.delivery_id, v])
      );
      for (const row of toProcess) {
        const verdict = verdictById.get(row.id);
        if (!verdict) {
          // The validator didn't return a row for this id at all — treat
          // as a lookup failure (retry), not a silent skip.
          lookupFailedRows.push(row);
          continue;
        }
        if (verdict.ok) {
          attemptRows.push(row);
        } else {
          skipReasons.set(row.id, verdict.skip_code ?? 'internal_error');
        }
      }
    }
  } catch (err) {
    log('validate_batch_exception', { error: err instanceof Error ? err.message : String(err) });
    lookupFailedRows.push(...toProcess);
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
  const contentFailedRows: DeliveryRow[] = [];

  for (const row of attemptRows) {
    const contentLookup = await getReminderContent(row.reminder_id);
    if (!contentLookup.ok || !contentLookup.value) {
      // Passed live validation a moment ago but the content fetch itself
      // failed (or the row vanished in the gap) — retry next tick rather
      // than crash or send with missing content.
      contentFailedRows.push(row);
      continue;
    }
    const reminder = contentLookup.value;
    const tokens = await getActiveTokens(row.recipient_id);

    if (tokens.length === 0) {
      rowOutcome.set(row.id, { anyOk: false, lastError: 'no_active_push_token' });
      continue;
    }

    const mode = await getPreviewMode(row.recipient_id);
    const { title, body } = buildNotificationContent(mode, row.delivery_type, reminder.title);

    for (const token of tokens) {
      messages.push({
        rowId: row.id,
        tokenId: token.id,
        to: token.expo_push_token,
        title,
        body,
        // Minimal routing/state payload only — reminderId is required to
        // fetch current state after tap; occurrenceDate/scheduledFor/
        // notificationType are the delivery's own identity. recipientId and
        // reminderType were never read by any client code (confirmed by
        // audit) and reminder title never belongs in data, private or
        // detailed — the tap flow always re-fetches from Supabase before
        // showing anything (reminder-alert.tsx), so nothing here needs to
        // carry content, only enough to know what to fetch.
        data: {
          reminderId: row.reminder_id,
          occurrenceDate: row.occurrence_date,
          scheduledFor: row.scheduled_for,
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
  // attempt_count stuck at its old value indefinitely. Content-fetch
  // failures (passed validation, then couldn't be re-read for the Expo
  // message body) get the exact same treatment.
  for (const row of [...lookupFailedRows, ...contentFailedRows]) {
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
    contentFailed: contentFailedRows.length,
    missingToken,
    tokensDeactivated: tokensToDeactivate.size,
  });

  return Response.json({
    scanned: toProcess.length,
    sent,
    failed,
    skipped: skipReasons.size,
    lookupFailed: lookupFailedRows.length + contentFailedRows.length,
    missingToken,
  });
  }
});
