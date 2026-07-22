// Both scheduled recipient-push functions are invoked only by pg_cron (via
// pg_net, see the trigger_send_due_recipient_reminders/trigger_check_push_receipts
// wrapper functions in the migration). verify_jwt is disabled on deploy
// because a valid Supabase JWT from ANY authenticated user would otherwise
// pass — this shared secret is the actual access control.
export function assertCronRequest(req: Request): Response | null {
  const expected = Deno.env.get('CRON_SECRET');
  const provided = req.headers.get('x-cron-secret');

  if (!expected || !provided || provided !== expected) {
    return new Response('Unauthorized', { status: 401 });
  }
  return null;
}

export function jsonLog(fn: string, event: string, data?: Record<string, unknown>): void {
  console.log(JSON.stringify({ fn, event, ...data }));
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
