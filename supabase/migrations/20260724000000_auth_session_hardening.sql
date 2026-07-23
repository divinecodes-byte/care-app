-- Week 1 launch hardening task #6: authentication, session recovery,
-- logout, account switching, and local-data isolation.
--
-- Two independently-confirmed live findings drive this migration:
--
-- 1. Signup atomicity gap: profile creation happens as a second, separate
--    client-side INSERT after auth.users signup, with no server-side
--    guarantee linking them. A real orphaned auth.users row (no matching
--    profiles row) was found in the live project at audit time — that
--    account could sign in (valid credentials) but every profile lookup
--    used `.single()`, which throws on zero rows, permanently trapping the
--    user on the signin screen behind a raw Postgres error. Fixed two ways:
--    a trigger that makes profile creation atomic with the auth.users
--    insert going forward, and a one-time backfill for any existing
--    orphaned row(s) so no real account stays trapped.
--
-- 2. Push-token reassignment gap: push_tokens.expo_push_token is UNIQUE
--    (one row per physical device), and its RLS UPDATE policy requires
--    `user_id = auth.uid()` against the EXISTING row. When a second Tavora
--    account signs into a device previously used by a different account,
--    the client-side `INSERT ... ON CONFLICT (expo_push_token) DO UPDATE`
--    upsert used by registerPushToken() must update a row it does not own
--    -- RLS rejects that update, so the second account's push registration
--    fails on every attempt, permanently, on that device. A SECURITY
--    DEFINER RPC (self-scoped to auth.uid(), never a client-supplied user
--    id) is the safe way to allow this reassignment.

-- ── 1. Signup atomicity ──────────────────────────────────────────────────

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, nullif(btrim(new.raw_user_meta_data->>'full_name'), ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- One-time backfill for any account that predates this trigger and was
-- left without a profile row. Additive only — creates a minimal row
-- (full_name/role null, every other column its normal default) so the
-- account can complete signup normally next time it signs in; never
-- deletes or otherwise touches auth.users.
insert into public.profiles (id, full_name)
select u.id, null
from auth.users u
left join public.profiles p on p.id = u.id
where p.id is null
on conflict (id) do nothing;

-- ── 2. Push-token ownership reassignment ─────────────────────────────────

create or replace function public.register_push_token(p_expo_push_token text, p_platform text default null)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
begin
  if p_expo_push_token is null or btrim(p_expo_push_token) = '' then
    raise exception 'expo_push_token is required';
  end if;

  -- auth.uid() resolves from the caller's own JWT regardless of this
  -- function's SECURITY DEFINER privilege escalation -- a client can only
  -- ever register a token as themselves, never as an arbitrary user id.
  insert into public.push_tokens (user_id, expo_push_token, platform, is_active, last_seen_at, updated_at)
  values (auth.uid(), p_expo_push_token, p_platform, true, now(), now())
  on conflict (expo_push_token)
  do update set
    user_id      = excluded.user_id,
    platform     = excluded.platform,
    is_active    = true,
    last_seen_at = now(),
    updated_at   = now();

  -- A user should have at most one active token at a time (the existing
  -- client-side behavior this RPC replaces already enforced this) -- any
  -- other token previously active under this account is superseded by the
  -- one just registered.
  update public.push_tokens
  set is_active = false, updated_at = now()
  where user_id = auth.uid()
    and expo_push_token <> p_expo_push_token
    and is_active = true;
end;
$$;

revoke all on function public.register_push_token(text, text) from public, anon;
grant execute on function public.register_push_token(text, text) to authenticated;

-- ── 3. Deactivate-own-tokens helper for logout ───────────────────────────
-- Plain RLS already permits a user to update their own push_tokens rows
-- (user_id = auth.uid() on both USING and WITH CHECK), so this doesn't
-- strictly need SECURITY DEFINER -- kept as a thin RPC anyway so the client
-- has one clearly-named, single-purpose call for the logout path instead
-- of hand-rolling the same update inline in multiple places.
create or replace function public.deactivate_own_push_tokens()
returns void
language sql
security invoker
set search_path = public, extensions, pg_catalog
as $$
  update public.push_tokens
  set is_active = false, updated_at = now()
  where user_id = auth.uid()
    and is_active = true;
$$;

revoke all on function public.deactivate_own_push_tokens() from public, anon;
grant execute on function public.deactivate_own_push_tokens() to authenticated;
