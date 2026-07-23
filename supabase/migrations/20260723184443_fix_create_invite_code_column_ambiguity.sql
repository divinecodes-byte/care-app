-- Fix a bug found while testing create_invite_code(): RETURNS TABLE(id,
-- invite_code, expires_at) implicitly declares PL/pgSQL variables with
-- those exact names, which collided with unqualified column references of
-- the same name inside the function body (e.g. `where id = auth.uid()`
-- against public.profiles, and `invite_code = v_code` / `expires_at =
-- v_expires_at` in the regenerate UPDATE's SET clause), raising
-- "column reference is ambiguous" on every real call. Every table
-- reference is now qualified with an explicit alias.

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

  if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'caregiver') then
    raise exception 'only caregivers can create invite codes';
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
