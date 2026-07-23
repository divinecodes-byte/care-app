// Permanently deletes the calling user's Tavora account. Invoked from
// app/delete-account.tsx immediately after the client re-authenticates with
// the current password (that reauthentication happens client-side via
// supabase.auth.signInWithPassword — this function never sees a password).
//
// Deployed with verify_jwt left at its default (true is NOT what we want
// either, since that only checks "is this any valid Supabase JWT" — we
// independently resolve and validate the caller from the JWT ourselves via
// supabase.auth.getUser(), which is what actually determines the deletion
// target). See --no-verify-jwt note in the deploy command.
import { createClient } from 'jsr:@supabase/supabase-js@2';

// "Require recent authentication" (Phase 2) is enforced here, not just
// trusted from the client: the JWT's own iat claim (already
// signature-verified by auth.getUser() below, so reading it back out is
// safe) must be within this window. The client's reauthentication step
// mints a fresh token immediately before calling this function, so this
// only ever rejects a genuinely stale/replayed token.
const MAX_TOKEN_AGE_SECONDS = 15 * 60;

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

function jsonLog(event: string, data?: Record<string, unknown>) {
  // Never include email, name, password, or access tokens — user id alone
  // is the only identifier logged.
  console.log(JSON.stringify({ fn: 'delete-account', event, ...data }));
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return Response.json({ error: 'method_not_allowed' }, { status: 405 });
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (!jwt) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  // Resolve the caller EXCLUSIVELY from the JWT via Supabase Auth itself.
  // The request body is never consulted for identity — there is no
  // request body at all, by design, so there is nothing for a client to
  // forge a different target with.
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });

  const { data: { user }, error: userError } = await callerClient.auth.getUser();

  if (userError || !user) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const claims = decodeJwtPayload(jwt);
  const issuedAt = typeof claims?.iat === 'number' ? claims.iat : null;
  if (!issuedAt || Date.now() / 1000 - issuedAt > MAX_TOKEN_AGE_SECONDS) {
    return Response.json({ error: 'reauthentication_required' }, { status: 401 });
  }

  const targetUserId = user.id;
  const serviceClient = createClient(supabaseUrl, serviceRoleKey);

  jsonLog('start', { userId: targetUserId });

  // Idempotent — safe to run again on retry after a partial failure below.
  const { error: cleanupError } = await serviceClient.rpc('delete_current_user_data', {
    target_user_id: targetUserId,
  });

  if (cleanupError) {
    jsonLog('cleanup_failed', { userId: targetUserId, error: cleanupError.message });
    return Response.json({ error: 'cleanup_failed', retryable: true }, { status: 500 });
  }

  jsonLog('cleanup_ok', { userId: targetUserId });

  const { error: authDeleteError } = await serviceClient.auth.admin.deleteUser(targetUserId);

  if (authDeleteError) {
    // Database cleanup already succeeded and is idempotent — the account
    // is already fully disabled (no push tokens, no active connections, no
    // active reminders) even though the Auth identity technically still
    // exists. A later call re-runs the same (no-op) cleanup and retries
    // just this step.
    jsonLog('auth_delete_failed', { userId: targetUserId, error: authDeleteError.message });
    return Response.json({ error: 'auth_delete_failed', retryable: true }, { status: 500 });
  }

  jsonLog('complete', { userId: targetUserId });
  return Response.json({ success: true });
});
