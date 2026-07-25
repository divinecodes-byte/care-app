-- Tavora Week 2 product-polish task #2: multi-participant management,
-- participant switching, connection organization, and five-participant
-- readiness.
--
-- 1. Server-side enforcement of the standard-account participant limit
--    (MAX_STANDARD_PARTICIPANTS = 5) inside create_invite_code() -- the
--    prior limit (MAX_FREE_PARTICIPANTS = 3, lib/limits.ts) was enforced
--    client-only; nothing stopped a concurrent or modified client from
--    exceeding it. This is explicitly LAUNCH-PLAN behavior: a fixed
--    per-account cap, not an entitlement/plan system. A future task can
--    replace the hardcoded `5` below with a lookup against a real
--    entitlement table without changing this function's shape or the
--    client contract (a stable 'participant_limit_reached' exception).
-- 2. end_connection() -- no such capability existed before this task;
--    'ended' was reachable only as a side effect of full account deletion
--    (delete_current_user_data()). This lets either party end ONE
--    connection while keeping their own account and other connections
--    intact.
-- 3. A small robustness fix to accept_invite_code(), found while auditing
--    this area: two concurrent accept_invite_code() calls for two
--    different still-pending invite codes between the same caregiver/
--    recipient pair both pass every check inside the function and only
--    fail at the final UPDATE, against connections_unique_accepted_pair
--    (the partial unique index from 20260723181123). That surfaced as a
--    raw, untranslated Postgres unique-violation error to the client
--    instead of one of this function's own typed string results. Now
--    caught and normalized to 'already_accepted', consistent with every
--    other "someone already claimed this" outcome the function returns.

create or replace function public.create_invite_code(p_existing_connection_id uuid default null::uuid)
returns table(id uuid, invite_code text, expires_at timestamptz)
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
  v_active_count int;
  v_profile public.profiles%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  -- FOR UPDATE on the caller's own profile row serializes concurrent
  -- create_invite_code() calls from the SAME caregiver -- the second
  -- concurrent call blocks here until the first transaction commits, so
  -- the count-then-insert check below can never race against itself
  -- (confirmed: this is the same locking pattern already used by
  -- update_reminder_schedule() for the equivalent reason).
  select * into v_profile from public.profiles where id = auth.uid() for update;

  if not found or v_profile.role <> 'caregiver' or v_profile.account_status <> 'active' then
    raise exception 'only active caregivers can create invite codes';
  end if;

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

    exit when not exists (select 1 from public.connections c where c.invite_code = v_code);
    if v_attempt > 10 then
      raise exception 'could not generate a unique invite code, try again';
    end if;
  end loop;

  if p_existing_connection_id is not null then
    -- Regenerating an existing pending invite's code is never a new
    -- participant slot -- that row is already counted below (it's still
    -- 'pending'), so this path never needs the limit check.
    update public.connections c
    set invite_code = v_code, expires_at = v_expires_at
    where c.id = p_existing_connection_id
      and c.caregiver_id = auth.uid()
      and c.status = 'pending'
    returning c.id into v_id;
  end if;

  if v_id is null then
    -- A genuinely NEW invite (fresh slot) -- count everything that
    -- currently occupies a slot: accepted connections, plus pending
    -- invitations that have not expired. Never counts expired invites or
    -- ended connections (an ended counterpart's row is already 'ended',
    -- not 'accepted', including when that counterpart deleted their own
    -- account -- delete_current_user_data() already sets 'ended' on every
    -- connection a deleted account was party to).
    select count(*) into v_active_count
    from public.connections
    where caregiver_id = auth.uid()
      and (
        status = 'accepted'
        or (status = 'pending' and (expires_at is null or expires_at >= now()))
      );

    if v_active_count >= 5 then
      raise exception 'participant_limit_reached';
    end if;

    insert into public.connections as c (caregiver_id, invite_code, status, expires_at)
    values (auth.uid(), v_code, 'pending', v_expires_at)
    returning c.id into v_id;
  end if;

  return query select v_id, v_code, v_expires_at;
end;
$$;

comment on function public.create_invite_code(uuid) is
  'Generates (or regenerates, via p_existing_connection_id) a pending invite code for the calling caregiver. Enforces the launch-plan standard-account limit of 5 active/pending participant slots server-side (counts accepted + non-expired pending; never expired pending or ended) -- serialized against concurrent calls from the same caregiver via a FOR UPDATE lock on their own profiles row. Raises the fixed message ''participant_limit_reached'' when at the limit, so the client can classify it without parsing free text. This is launch-plan behavior (a fixed cap), not an entitlement system -- a future task can replace the hardcoded 5 with a real per-account entitlement lookup without changing this function''s external contract.';

revoke all on function public.create_invite_code(uuid) from public, anon;
grant execute on function public.create_invite_code(uuid) to authenticated, service_role;

-- ─── accept_invite_code: normalize the concurrent-accept race ─────────────

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

  if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.account_status = 'active') then
    return 'not_found';
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

  begin
    update public.connections
    set recipient_id = auth.uid(), status = 'accepted', accepted_at = now()
    where invite_code = p_code
      and status = 'pending'
      and recipient_id is null
      and (expires_at is null or expires_at >= now())
    returning public.connections.id into v_updated_id;
  exception
    when unique_violation then
      -- A different still-pending invite code between this same
      -- caregiver/recipient pair was accepted first (a genuine race, not
      -- a client bug) -- connections_unique_accepted_pair caught it.
      -- Normalize to the same typed outcome as any other
      -- already-claimed-by-someone-else case rather than letting a raw
      -- Postgres error reach the client.
      return 'already_accepted';
  end;

  if v_updated_id is null then
    return 'already_accepted';
  end if;

  return 'accepted';
end;
$$;

comment on function public.accept_invite_code(text) is
  'Validates and accepts an invite code atomically -- self-connection, expiration, concurrent-acceptance of the SAME code, and concurrent-acceptance of a DIFFERENT still-pending code between the same caregiver/recipient pair (caught via connections_unique_accepted_pair) are all normalized to typed string results rather than a raw error. Returns: accepted | not_found | already_accepted | expired | self.';

revoke all on function public.accept_invite_code(text) from public, anon;
grant execute on function public.accept_invite_code(text) to authenticated, service_role;

-- ─── end_connection: new capability, did not exist before this task ───────

create or replace function public.end_connection(p_connection_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_conn public.connections%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_conn from public.connections where id = p_connection_id for update;

  if not found then
    raise exception 'connection_not_found';
  end if;

  if v_conn.caregiver_id <> auth.uid() and v_conn.recipient_id <> auth.uid() then
    raise exception 'not_authorized';
  end if;

  -- Idempotent: ending an already-ended connection is a harmless no-op
  -- success, never an error (a double-tap, a retried request after a
  -- flaky response, or two tabs/devices both ending the same connection
  -- must all resolve the same way).
  if v_conn.status = 'ended' then
    return;
  end if;

  update public.connections set status = 'ended' where id = p_connection_id;

  -- Deactivating every reminder tied to this connection is what actually
  -- stops future deliveries and snoozes: both claim_due_recipient_
  -- reminder_deliveries() and claim_due_recipient_snooze_deliveries()
  -- already require r.is_active = true and c.status = 'accepted' (see
  -- docs/reminder-editing-model.md), and validate_reminder_deliveries_
  -- for_send() already fails closed with reminder_inactive/
  -- connection_inactive for any already-claimed-but-unsent row -- no
  -- separate mutation of reminder_notification_deliveries is needed or
  -- introduced here, and reminder lifecycle semantics are otherwise
  -- completely unchanged. reminder_logs (historical responses) are never
  -- touched, exactly like the existing account-deletion path.
  update public.reminders
  set is_active = false, updated_at = now()
  where connection_id = p_connection_id and is_active = true;
end;
$$;

comment on function public.end_connection(uuid) is
  'Ends ONE connection (status -> ended) while leaving the caller''s account and every other connection untouched -- callable by either party (caregiver_id or recipient_id = auth.uid()), idempotent, and deactivates every reminder tied to this connection so future deliveries/snoozes stop through the existing claim/send guards. reminder_logs (history) is never modified. No client UPDATE policy exists on connections (all mutation is through SECURITY DEFINER functions), so an ended connection can never be reactivated except by a brand-new invite through create_invite_code()/accept_invite_code().';

revoke all on function public.end_connection(uuid) from public, anon;
grant execute on function public.end_connection(uuid) to authenticated;
