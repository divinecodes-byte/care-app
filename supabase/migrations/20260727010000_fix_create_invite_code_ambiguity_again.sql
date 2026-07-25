-- Fix a regression found while running the participant audit for the
-- first time: create_invite_code()'s RETURNS TABLE(id, invite_code,
-- expires_at) implicitly declares PL/pgSQL variables with those exact
-- names (the same footgun 20260723184443_fix_create_invite_code_column_
-- ambiguity.sql already fixed once for the ORIGINAL body) -- the new
-- participant-limit COUNT query added in
-- 20260727000000_participant_limit_and_connection_ending.sql referenced
-- `expires_at` unqualified in its WHERE clause, which collided with the
-- function's own `expires_at` OUT parameter and raised "column reference
-- is ambiguous" (42702) on every real call, exactly like before. Every
-- reference in that query is now qualified with an explicit alias.

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
    update public.connections c
    set invite_code = v_code, expires_at = v_expires_at
    where c.id = p_existing_connection_id
      and c.caregiver_id = auth.uid()
      and c.status = 'pending'
    returning c.id into v_id;
  end if;

  if v_id is null then
    -- Every column reference here is qualified with `c.` -- this is the
    -- exact fix: c.expires_at / c.status can never be confused with this
    -- function's own `expires_at` OUT parameter or any other identifier.
    select count(*) into v_active_count
    from public.connections c
    where c.caregiver_id = auth.uid()
      and (
        c.status = 'accepted'
        or (c.status = 'pending' and (c.expires_at is null or c.expires_at >= now()))
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
  'Generates (or regenerates, via p_existing_connection_id) a pending invite code for the calling caregiver. Enforces the launch-plan standard-account limit of 5 active/pending participant slots server-side (counts accepted + non-expired pending; never expired pending or ended) -- serialized against concurrent calls from the same caregiver via a FOR UPDATE lock on their own profiles row. Raises the fixed message ''participant_limit_reached'' when at the limit, so the client can classify it without parsing free text. Every column reference inside is qualified with an explicit table alias -- this function''s own OUT parameters (id, invite_code, expires_at) implicitly declare same-named PL/pgSQL variables, so any unqualified reference to those column names anywhere in the body raises "column reference is ambiguous" (learned twice now -- see 20260723184443 and 20260727010000).';

revoke all on function public.create_invite_code(uuid) from public, anon;
grant execute on function public.create_invite_code(uuid) to authenticated, service_role;
