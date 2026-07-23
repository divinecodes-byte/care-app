-- Week 1 launch hardening task #6, Phase 3: "disabled/deletion-pending
-- accounts cannot create reminders or connections" — enforced at the
-- database layer, not just client-side route checks, per the task's own
-- instruction that existing database authorization remains authoritative.
--
-- Audit finding: delete_current_user_data() resets full_name, timezone,
-- server_push_enabled, notification_preview_mode, and account_status, but
-- deliberately leaves `role` untouched (it's not private data, and other
-- code doesn't currently depend on it being cleared). create_invite_code()
-- and accept_invite_code() only ever checked `role`, never
-- `account_status` — so a tombstoned account that still held a technically
-- valid session (the documented Auth-deletion-partially-failed edge case)
-- could still create or accept a connection invite. Reminder creation
-- turned out to already be protected transitively (it requires an
-- *accepted* connection, and deletion already force-ends every
-- connection), but that protection was an emergent side effect rather than
-- an explicit guarantee, so this migration makes it explicit too.

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
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'caregiver' and p.account_status = 'active') then
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
    update public.connections c
    set invite_code = v_code, expires_at = v_expires_at
    where c.id = p_existing_connection_id
      and c.caregiver_id = auth.uid()
      and c.status = 'pending'
    returning c.id into v_id;
  end if;

  if v_id is null then
    insert into public.connections as c (caregiver_id, invite_code, status, expires_at)
    values (auth.uid(), v_code, 'pending', v_expires_at)
    returning c.id into v_id;
  end if;

  return query select v_id, v_code, v_expires_at;
end;
$$;

revoke all on function public.create_invite_code(uuid) from public, anon;
grant execute on function public.create_invite_code(uuid) to authenticated, service_role;

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

revoke all on function public.accept_invite_code(text) from public, anon;
grant execute on function public.accept_invite_code(text) to authenticated, service_role;

-- Explicit (not just transitively-true-via-ended-connections) guard on
-- reminder creation/reactivation for a deleted caregiver account.
drop policy if exists "Caregivers can create reminders for accepted connections" on public.reminders;
create policy "Caregivers can create reminders for accepted connections"
  on public.reminders for insert to authenticated
  with check (
    auth.uid() = caregiver_id
    and exists (
      select 1 from public.connections c
      where c.id = reminders.connection_id
        and c.caregiver_id = auth.uid()
        and c.recipient_id = reminders.recipient_id
        and c.status = 'accepted'
    )
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.account_status = 'active'
    )
  );

drop policy if exists "Caregivers can update their own reminders" on public.reminders;
create policy "Caregivers can update their own reminders"
  on public.reminders for update to authenticated
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
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.account_status = 'active'
    )
  );
