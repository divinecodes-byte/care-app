# Security audit test suite

Synthetic-user attack tests against the live linked Supabase project. Run
before any change to RLS policies, `SECURITY DEFINER` functions, or Edge
Function auth — and periodically as a regression check.

## Run it

```bash
set -a; source .env; set +a
npx tsx scripts/security-audit/run.ts
```

Requires the `supabase` CLI already authenticated and linked
(`supabase link`) — used for setup/verification/cleanup queries, never for
the attacks themselves (those use only the public anon key, exactly what a
real client has).

## What it does

Creates disposable users (`tavora.secaudit.*@example.com`), attacks them
against each other over the network exactly as a real client would, and
hard-deletes every trace of them afterward (in a `finally` block, so this
runs even if a check throws). Never touches a real account. Prints one
`[PASS]`/`[FAIL]` line per scenario and exits non-zero if anything failed.

See `docs/security-model.md` for what each lettered scenario (A–T) is
actually defending against.
