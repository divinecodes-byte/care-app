-- Week 1 launch hardening: full security audit fixes.
--
-- Findings addressed here (see docs/backend-security-inventory.md and
-- docs/backend-cleanup-report.md for the full audit):
--
-- 1. "Authenticated users can view pending invite codes" let ANY signed-in
--    user list every outstanding pending invite (code, caregiver_id,
--    created_at) system-wide via a plain SELECT -- confirmed unused by any
--    client code path (join-invite.tsx validates via the check_invite_code
--    RPC and accepts via a targeted UPDATE, neither of which needs this
--    policy). This is worse than "not brute-force-resistant" -- it's a full
--    enumeration. Dropped.
-- 2. reminders' and reminder_logs' UPDATE policies checked ownership
--    (caregiver_id / recipient_id) but never pinned the OTHER identifying
--    columns -- a caregiver could reassign one of their own reminders'
--    recipient_id to a stranger; a recipient could rewrite one of their own
--    log rows' reminder_id to point at someone else's reminder. Both
--    WITH CHECK clauses now revalidate full ownership consistency, mirroring
--    the pattern their own INSERT policies already use.
-- 3. Invite codes were generated client-side with Math.random() (not
--    cryptographically secure), never expired, and accepted via a raw
--    client UPDATE with no self-connection or duplicate-connection guard.
--    Replaced with two SECURITY DEFINER RPCs (create_invite_code,
--    accept_invite_code) using pgcrypto-backed randomness, a 7-day
--    expiration, and explicit self-connection/duplicate-connection checks --
--    then removed the client's direct INSERT/UPDATE access to `connections`
--    entirely (every mutation now goes through one of these two functions).
-- 4. Several RLS policies were scoped to role {public} instead of
--    {authenticated} -- functionally harmless (auth.uid() is null for
--    anon regardless) but tightened for defense-in-depth/clarity.
-- 5. No constraint prevented two ACCEPTED connections existing between the
--    same caregiver/recipient pair, or a user accepting their own invite.

-- ─── connections: expiration + integrity ────────────────────────────────────

alter table public.connections
  add column expires_at timestamptz;

comment on column public.connections.expires_at is
  'Set by create_invite_code(); a pending row past this timestamp can no longer be accepted by accept_invite_code(). Null for already-accepted/ended rows (irrelevant once resolved).';

-- A user cannot connect to themselves.
alter table public.connections
  add constraint connections_no_self_connection_check
  check (recipient_id is null or recipient_id <> caregiver_id);

-- Only one ACCEPTED connection may exist between the same pair at a time
-- (a new invite/acceptance after an 'ended' one is fine -- this only
-- constrains the 'accepted' state).
create unique index connections_unique_accepted_pair
  on public.connections (caregiver_id, recipient_id)
  where status = 'accepted';

-- ─── Secured invite RPCs (replace direct client writes entirely) ──────────

create or replace function public.create_invite_code(p_existing_connection_id uuid default null)
returns table (id uuid, invite_code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_code text;
  v_random_bytes bytea;
  v_expires_at timestamptz := now() + interval '7 days';
  v_id uuid;
  v_attempt int := 0;
  v_byte_index int;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not exists (select 1 from public.profiles where id = auth.uid() and role = 'caregiver') then
    raise exception 'only caregivers can create invite codes';
  end if;

  -- Cryptographically secure code: pgcrypto's gen_random_bytes, mapped into
  -- the same 32-character alphabet the app already uses (excludes visually
  -- ambiguous characters: no I, O, 0, 1). Retries on the astronomically
  -- unlikely event of a collision with an existing code (invite_code stays
  -- globally UNIQUE forever, so an old code -- accepted or not -- can never
  -- be reissued).
  loop
    v_attempt := v_attempt + 1;
    v_random_bytes := gen_random_bytes(6);
    v_code := '';
    for v_byte_index in 0..5 loop
      v_code := v_code || substr(
        'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
        (get_byte(v_random_bytes, v_byte_index) % 32) + 1,
        1
      );
    end loop;

    exit when not exists (select 1 from public.connections where invite_code = v_code);
    if v_attempt > 10 then
      raise exception 'could not generate a unique invite code, try again';
    end if;
  end loop;

  if p_existing_connection_id is not null then
    update public.connections
    set invite_code = v_code, expires_at = v_expires_at
    where public.connections.id = p_existing_connection_id
      and caregiver_id = auth.uid()
      and status = 'pending'
    returning public.connections.id into v_id;
  end if;

  if v_id is null then
    insert into public.connections (caregiver_id, invite_code, status, expires_at)
    values (auth.uid(), v_code, 'pending', v_expires_at)
    returning public.connections.id into v_id;
  end if;

  return query select v_id, v_code, v_expires_at;
end;
$$;

comment on function public.create_invite_code(uuid) is
  'Creates (or regenerates, via p_existing_connection_id) a pending invite for the calling caregiver. Cryptographically secure code, 7-day expiration. Callable directly by authenticated clients -- this is the only sanctioned way to write to connections as caregiver-inviter.';

create or replace function public.accept_invite_code(p_code text)
returns text
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_caregiver_id uuid;
  v_status text;
  v_expires_at timestamptz;
  v_recipient_id uuid;
  v_updated_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select caregiver_id, status, expires_at, recipient_id
  into v_caregiver_id, v_status, v_expires_at, v_recipient_id
  from public.connections
  where invite_code = p_code;

  if v_caregiver_id is null then
    return 'not_found';
  end if;

  if v_caregiver_id = auth.uid() then
    return 'self';
  end if;

  if v_status = 'accepted' or v_recipient_id is not null then
    return 'already_accepted';
  end if;

  if v_status <> 'pending' then
    return 'not_found';
  end if;

  if v_expires_at is not null and v_expires_at < now() then
    return 'expired';
  end if;

  -- Atomic guard: only one concurrent caller can win this UPDATE. A second
  -- caller's WHERE clause no longer matches once the first commits (status
  -- is no longer 'pending'), so it affects 0 rows and falls through below.
  update public.connections
  set recipient_id = auth.uid(), status = 'accepted', accepted_at = now()
  where invite_code = p_code
    and status = 'pending'
    and recipient_id is null
    and (expires_at is null or expires_at >= now())
  returning public.connections.id into v_updated_id;

  if v_updated_id is null then
    return 'already_accepted';
  end if;

  return 'accepted';
end;
$$;

comment on function public.accept_invite_code(text) is
  'Validates and accepts an invite code atomically -- self-connection, expiration, and concurrent-acceptance are all enforced here rather than relying on a raw client UPDATE. Callable directly by authenticated clients -- this is the only sanctioned way to write to connections as recipient-acceptor. Returns: accepted | not_found | already_accepted | expired | self.';

revoke all on function public.create_invite_code(uuid) from public, anon;
grant execute on function public.create_invite_code(uuid) to authenticated, service_role;

revoke all on function public.accept_invite_code(text) from public, anon;
grant execute on function public.accept_invite_code(text) to authenticated, service_role;

-- check_invite_code is superseded by accept_invite_code (which validates
-- and accepts atomically, closing the check-then-act gap entirely) --
-- confirmed no remaining call site after this migration's client changes.
drop function if exists public.check_invite_code(text);

-- No more direct client INSERT/UPDATE on connections -- every mutation now
-- goes through create_invite_code() / accept_invite_code() (both
-- SECURITY DEFINER, bypass RLS internally, and enforce the invariants this
-- migration's RLS/constraint changes above can't fully express alone).
drop policy if exists "Caregivers can create their own connections" on public.connections;
drop policy if exists "Caregivers can update own pending invites" on public.connections;
drop policy if exists "Recipients can accept pending invite codes" on public.connections;

-- The broad enumeration policy -- confirmed unused by any client code path.
drop policy if exists "Authenticated users can view pending invite codes" on public.connections;

-- ─── reminders: UPDATE can no longer reassign ownership ────────────────────

drop policy if exists "Caregivers can update their own reminders" on public.reminders;
create policy "Caregivers can update their own reminders"
  on public.reminders
  for update
  to authenticated
  using (auth.uid() = caregiver_id)
  with check (
    auth.uid() = caregiver_id
    and exists (
      select 1 from public.connections c
      where c.id = reminders.connection_id
        and c.caregiver_id = auth.uid()
        and c.recipient_id = reminders.recipient_id
        and c.status = 'accepted'
    )
  );

-- ─── reminder_logs: UPDATE can no longer be redirected to another reminder ──

drop policy if exists "Recipients can update their own logs" on public.reminder_logs;
create policy "Recipients can update their own logs"
  on public.reminder_logs
  for update
  to authenticated
  using (auth.uid() = recipient_id)
  with check (
    auth.uid() = recipient_id
    and exists (
      select 1 from public.reminders r
      where r.id = reminder_logs.reminder_id
        and r.recipient_id = auth.uid()
        and r.connection_id = reminder_logs.connection_id
        and r.caregiver_id = reminder_logs.caregiver_id
    )
  );

-- ─── Role-scoping cleanup: {public} -> {authenticated} ─────────────────────
-- Functionally identical (auth.uid() is null for anon regardless, so these
-- could never match) -- tightened for explicitness/defense-in-depth.

drop policy if exists "Users can insert own notification preferences" on public.notification_preferences;
create policy "Users can insert own notification preferences"
  on public.notification_preferences for insert to authenticated
  with check (caregiver_id = auth.uid());

drop policy if exists "Users can view own notification preferences" on public.notification_preferences;
create policy "Users can view own notification preferences"
  on public.notification_preferences for select to authenticated
  using (caregiver_id = auth.uid());

drop policy if exists "Users can update own notification preferences" on public.notification_preferences;
create policy "Users can update own notification preferences"
  on public.notification_preferences for update to authenticated
  using (caregiver_id = auth.uid())
  with check (caregiver_id = auth.uid());

drop policy if exists "Users can insert own push tokens" on public.push_tokens;
create policy "Users can insert own push tokens"
  on public.push_tokens for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists "Users can view own push tokens" on public.push_tokens;
create policy "Users can view own push tokens"
  on public.push_tokens for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "Users can update own push tokens" on public.push_tokens;
create policy "Users can update own push tokens"
  on public.push_tokens for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
