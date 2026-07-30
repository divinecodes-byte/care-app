-- Week 3 product-expansion task #3: reusable templates, routine packs, and
-- transactional routine assignment.
--
-- Architecture summary (see docs/routine-template-model.md and
-- docs/routine-application-model.md for the full reasoning):
--
-- * Built-in "Tavora Packs" are NOT stored server-side at all -- they are a
--   versioned, localized client catalog (lib/routineCatalog.ts) expanded into
--   the exact same validated apply payload a personal template produces.
--   The server never trusts a built-in pack's identity for authorization;
--   every reminder/task field in an apply request is independently
--   validated regardless of where it claims to have come from.
-- * Personal templates (routine_templates / routine_template_items) are a
--   reusable, participant-less, non-actionable blueprint. Editing one never
--   touches anything previously created from it -- routine_instance_items
--   link to concrete reminder_id/task_id rows, never to template item rows.
-- * Applying a pack/template creates exactly one routine_instances row
--   (grouping/metadata only) plus one routine_instance_items row per member,
--   linking to reminders/tasks created via the *existing* reminder-insert
--   path and the *existing* create_task() RPC (now delegating to a shared
--   internal helper, _create_task_core, so it can be called both from the
--   public create_task() entry point and from apply_routine_template() in
--   the same transaction without weakening create_task's own authorization).
-- * There is no new lifecycle authority: reminder_logs and task_occurrences
--   remain the sole source of truth for status/history. routine_instances
--   never stores a completion status for its members.
-- * All four new tables have zero INSERT/UPDATE/DELETE grants to
--   `authenticated` -- every mutation goes through a SECURITY DEFINER RPC.
--   Direct client reads are SELECT-only, RLS-scoped.
-- * apply_routine_template() is one PL/pgSQL function call: Postgres gives
--   this all-or-nothing transactional behavior for free (an unhandled
--   exception anywhere in the function body aborts every effect of the
--   call, including the routine_instances insert). Idempotency is a UNIQUE
--   (organizer_id, apply_request_id) constraint used as the concurrency
--   gate: a losing concurrent duplicate detects the conflict on the very
--   first insert, before any reminder/task is created, and simply returns
--   the winner's already-built result.

-- ─── routine_templates ────────────────────────────────────────────────────

create table public.routine_templates (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references public.profiles(id) on delete cascade,
    title text not null,
    description text,
    use_case text,
    status text not null default 'active',
    revision integer not null default 1,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint routine_templates_title_check check (btrim(title) <> '' and char_length(title) <= 200),
    constraint routine_templates_description_check check (description is null or char_length(description) <= 2000),
    constraint routine_templates_use_case_check check (use_case is null or use_case = any(array['care','family','coaching','team','personal','other'])),
    constraint routine_templates_status_check check (status in ('active','archived'))
);

create index idx_routine_templates_owner on public.routine_templates(owner_id, status);

comment on table public.routine_templates is
    'Personal, reusable accountability blueprints. No participant, no completion state. Private to owner_id (RLS SELECT-only; all mutation is RPC-mediated). Hard-delete is intentional (see delete_routine_template) -- templates carry no shared response history, unlike reminders/tasks.';

-- ─── routine_template_items ───────────────────────────────────────────────

create table public.routine_template_items (
    id uuid primary key default gen_random_uuid(),
    template_id uuid not null references public.routine_templates(id) on delete cascade,
    item_kind text not null,
    display_order integer not null,
    title text not null,
    notes text,
    enabled_by_default boolean not null default true,
    frequency text not null,
    days_of_week integer[] not null default '{}',
    start_offset_days integer not null default 0,
    due_offset_days integer,
    reminder_type text,
    time_of_day time,
    no_response_minutes integer,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint routine_template_items_kind_check check (item_kind in ('reminder','task')),
    constraint routine_template_items_title_check check (btrim(title) <> '' and char_length(title) <= 200),
    constraint routine_template_items_notes_check check (notes is null or char_length(notes) <= 2000),
    constraint routine_template_items_start_offset_check check (start_offset_days >= 0),
    constraint routine_template_items_due_offset_check check (due_offset_days is null or due_offset_days >= 0),
    constraint routine_template_items_due_after_start_check check (due_offset_days is null or due_offset_days >= start_offset_days),
    constraint routine_template_items_no_response_minutes_check check (no_response_minutes is null or (no_response_minutes >= 1 and no_response_minutes <= 120)),
    -- Reminder items always carry exact-time configuration and never a due
    -- offset (reminders have no due_date concept). Task items never carry
    -- reminder-only fields (no fake times), and only a one_time task item
    -- may carry a due_offset_days; a recurring task item must carry
    -- days_of_week instead, exactly mirroring the tasks table's own
    -- frequency/days_of_week/due_date CHECK constraints.
    constraint routine_template_items_kind_fields_check check (
        (item_kind = 'reminder'
            and time_of_day is not null
            and reminder_type is not null
            and no_response_minutes is not null
            and due_offset_days is null
            and frequency in ('daily','weekdays','weekends','custom')
            and cardinality(days_of_week) >= 1 and cardinality(days_of_week) <= 7
            and days_of_week <@ array[1,2,3,4,5,6,7])
        or
        (item_kind = 'task'
            and time_of_day is null
            and reminder_type is null
            and no_response_minutes is null
            and frequency in ('one_time','daily','weekdays','weekends','custom')
            and (
                (frequency = 'one_time' and cardinality(days_of_week) = 0)
                or
                (frequency <> 'one_time' and due_offset_days is null
                    and cardinality(days_of_week) >= 1 and cardinality(days_of_week) <= 7
                    and days_of_week <@ array[1,2,3,4,5,6,7])
            ))
    ),
    constraint routine_template_items_display_order_unique unique (template_id, display_order)
);

create index idx_routine_template_items_template on public.routine_template_items(template_id, display_order);

comment on table public.routine_template_items is
    'Configuration-only rows: no completion state, no notification-delivery data. start_offset_days/due_offset_days are relative to whatever start date a future apply chooses -- resolved into concrete dates client-side (lib/routineCore.ts) before apply_routine_template is ever called.';

-- ─── routine_instances ─────────────────────────────────────────────────────

create table public.routine_instances (
    id uuid primary key default gen_random_uuid(),
    organizer_id uuid not null references public.profiles(id) on delete cascade,
    participant_id uuid not null references public.profiles(id) on delete cascade,
    connection_id uuid not null references public.connections(id) on delete cascade,
    title text not null,
    source_template_id uuid references public.routine_templates(id) on delete set null,
    built_in_pack_id text,
    source_version text not null,
    participant_timezone_snapshot text,
    start_date date not null,
    status text not null default 'active',
    apply_request_id text not null,
    created_at timestamptz not null default now(),
    archived_at timestamptz,
    updated_at timestamptz not null default now(),
    constraint routine_instances_title_check check (char_length(title) <= 200),
    constraint routine_instances_status_check check (status in ('active','archived')),
    -- Exactly one source per instance -- a built-in pack has no server-side
    -- row to reference, a personal template does. source_template_id uses
    -- ON DELETE SET NULL (above) specifically so deleting a personal
    -- template never deletes or orphans routine instances/history already
    -- created from it -- the title snapshot below is what keeps the
    -- instance understandable even after that happens.
    constraint routine_instances_source_check check (
        (source_template_id is not null and built_in_pack_id is null) or
        (source_template_id is null and built_in_pack_id is not null)
    ),
    constraint routine_instances_apply_request_id_check check (btrim(apply_request_id) <> ''),
    constraint routine_instances_organizer_apply_request_unique unique (organizer_id, apply_request_id)
);

create index idx_routine_instances_connection on public.routine_instances(connection_id, status);
create index idx_routine_instances_participant on public.routine_instances(participant_id, status);
create index idx_routine_instances_organizer on public.routine_instances(organizer_id, status);

comment on table public.routine_instances is
    'Metadata/grouping snapshot produced by one successful apply_routine_template() call. Never a second lifecycle authority -- no member completion status is stored here. The (organizer_id, apply_request_id) unique constraint is the sole concurrency/idempotency gate for apply_routine_template.';

-- ─── routine_instance_items ────────────────────────────────────────────────

create table public.routine_instance_items (
    id uuid primary key default gen_random_uuid(),
    routine_instance_id uuid not null references public.routine_instances(id) on delete cascade,
    source_item_key text,
    item_kind text not null,
    reminder_id uuid references public.reminders(id) on delete cascade,
    task_id uuid references public.tasks(id) on delete cascade,
    display_order integer not null,
    created_at timestamptz not null default now(),
    constraint routine_instance_items_kind_check check (item_kind in ('reminder','task')),
    constraint routine_instance_items_exactly_one_source_check check (
        (item_kind = 'reminder' and reminder_id is not null and task_id is null) or
        (item_kind = 'task' and task_id is not null and reminder_id is null)
    ),
    constraint routine_instance_items_display_order_unique unique (routine_instance_id, display_order)
);

-- A reminder/task can belong to at most one routine instance, ever -- these
-- partial unique indexes are what make that a database-enforced invariant
-- rather than just an application convention.
create unique index idx_routine_instance_items_reminder_unique on public.routine_instance_items(reminder_id) where reminder_id is not null;
create unique index idx_routine_instance_items_task_unique on public.routine_instance_items(task_id) where task_id is not null;
create index idx_routine_instance_items_instance on public.routine_instance_items(routine_instance_id, display_order);

comment on table public.routine_instance_items is
    'Pure linkage rows. reminder_id/task_id point at the real, sole-authority reminders/tasks rows -- no status, no notification-delivery data is duplicated here.';

-- ─── routine_notification_deliveries ──────────────────────────────────────
-- Mirrors task_notification_deliveries' shape and its "exactly one, ever"
-- guarantee (a UNIQUE(routine_instance_id) constraint, not a
-- unique(task_id)-style column here since there is exactly one delivery per
-- routine regardless of how many reminders/tasks it contains).

create table public.routine_notification_deliveries (
    id uuid primary key default gen_random_uuid(),
    routine_instance_id uuid not null references public.routine_instances(id) on delete cascade,
    recipient_id uuid not null references public.profiles(id) on delete cascade,
    status text not null default 'pending',
    error_code text,
    error_message text,
    attempt_count integer not null default 0,
    expo_ticket_id text,
    sent_at timestamptz,
    receipt_checked_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint routine_notification_deliveries_status_check check (status in ('pending','sent','failed')),
    constraint routine_notification_deliveries_error_code_check check (error_code is null or error_code in (
        'no_active_push_token','device_not_registered','expo_ticket_error','expo_batch_error',
        'routine_inactive','connection_inactive','internal_error'
    )),
    constraint routine_notification_deliveries_instance_unique unique (routine_instance_id)
);

comment on table public.routine_notification_deliveries is
    'Exactly one row per routine_instance_id (enforced by the unique constraint) -- structurally impossible to send more than one routine-assignment push per apply, regardless of how many reminders/tasks the routine contains. No notes, item titles, or full item lists are ever placed on this row or in its push payload.';

-- ─── RLS: enable + SELECT-only client policies ────────────────────────────
-- Every one of these four tables has zero INSERT/UPDATE/DELETE grant to
-- `authenticated` below -- all mutation is RPC-mediated (SECURITY DEFINER
-- functions execute as their owning role, which is exempt from RLS, exactly
-- like the existing create_task()/tasks table precedent).

alter table public.routine_templates enable row level security;
alter table public.routine_template_items enable row level security;
alter table public.routine_instances enable row level security;
alter table public.routine_instance_items enable row level security;
alter table public.routine_notification_deliveries enable row level security;

create policy "Owner can read own templates" on public.routine_templates
    for select using (auth.uid() = owner_id);

create policy "Owner can read own template items" on public.routine_template_items
    for select using (exists (
        select 1 from public.routine_templates rt where rt.id = routine_template_items.template_id and rt.owner_id = auth.uid()
    ));

create policy "Organizer or participant can read a routine instance" on public.routine_instances
    for select using (auth.uid() = organizer_id or auth.uid() = participant_id);

create policy "Organizer or participant can read routine instance items" on public.routine_instance_items
    for select using (exists (
        select 1 from public.routine_instances ri
        where ri.id = routine_instance_items.routine_instance_id
          and (ri.organizer_id = auth.uid() or ri.participant_id = auth.uid())
    ));

-- No client-facing policy on routine_notification_deliveries at all --
-- matches reminder_notification_deliveries' existing precedent. There is no
-- UI need to read this table; service-role/SECURITY DEFINER functions
-- bypass RLS regardless.

revoke all on public.routine_templates from authenticated, anon;
grant select on public.routine_templates to authenticated;
grant all on public.routine_templates to service_role;

revoke all on public.routine_template_items from authenticated, anon;
grant select on public.routine_template_items to authenticated;
grant all on public.routine_template_items to service_role;

revoke all on public.routine_instances from authenticated, anon;
grant select on public.routine_instances to authenticated;
grant all on public.routine_instances to service_role;

revoke all on public.routine_instance_items from authenticated, anon;
grant select on public.routine_instance_items to authenticated;
grant all on public.routine_instance_items to service_role;

revoke all on public.routine_notification_deliveries from authenticated, anon;
grant all on public.routine_notification_deliveries to service_role;

-- ─── Internal helpers (never granted to authenticated/anon/public) ────────

create or replace function public._is_valid_iana_timezone(p_tz text)
returns boolean
language plpgsql
set search_path = public, extensions, pg_catalog
as $$
begin
    if p_tz is null or btrim(p_tz) = '' then
        return false;
    end if;
    perform now() at time zone p_tz;
    return true;
exception when others then
    return false;
end;
$$;
revoke all on function public._is_valid_iana_timezone(text) from public, anon, authenticated;

-- Shared by create_task() (public entry point, full auth/validation) and
-- apply_routine_template() (validates the connection/participant once,
-- then calls this per task item) -- extracted so a mixed routine's tasks
-- can be created inside the same transaction as its reminders without
-- duplicating create_task's validation logic, and without weakening
-- create_task's own public authorization (create_task still performs every
-- check it always did, before ever reaching this helper).
create or replace function public._create_task_core(
    p_connection_id uuid,
    p_caregiver_id uuid,
    p_recipient_id uuid,
    p_title text,
    p_notes text,
    p_frequency text,
    p_days_of_week integer[],
    p_start_date date,
    p_due_date date,
    p_recurrence_end_date date,
    p_suppress_notification boolean
)
returns public.tasks
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
    v_result public.tasks%rowtype;
begin
    if p_title is null or btrim(p_title) = '' then
        raise exception 'invalid_title';
    end if;

    if p_frequency not in ('one_time', 'daily', 'weekdays', 'weekends', 'custom') then
        raise exception 'invalid_frequency';
    end if;

    if p_frequency <> 'one_time' then
        if p_days_of_week is null or cardinality(p_days_of_week) < 1 or cardinality(p_days_of_week) > 7
           or not (p_days_of_week <@ array[1,2,3,4,5,6,7]) then
            raise exception 'invalid_days_of_week';
        end if;
        if p_due_date is not null then
            raise exception 'recurring_task_cannot_have_due_date';
        end if;
    end if;

    if p_start_date is null then
        raise exception 'invalid_start_date';
    end if;

    if p_due_date is not null and p_due_date < p_start_date then
        raise exception 'due_date_before_start_date';
    end if;

    if p_recurrence_end_date is not null and p_recurrence_end_date < p_start_date then
        raise exception 'recurrence_end_before_start_date';
    end if;

    insert into public.tasks (
        connection_id, caregiver_id, recipient_id, title, notes,
        frequency, days_of_week, start_date, due_date, recurrence_end_date
    ) values (
        p_connection_id, p_caregiver_id, p_recipient_id, btrim(p_title), nullif(btrim(coalesce(p_notes, '')), ''),
        p_frequency, case when p_frequency = 'one_time' then '{}'::integer[] else p_days_of_week end,
        p_start_date, p_due_date, p_recurrence_end_date
    )
    returning * into v_result;

    if not p_suppress_notification then
        insert into public.task_notification_deliveries (task_id, recipient_id)
        values (v_result.id, v_result.recipient_id);
    end if;

    return v_result;
end;
$$;
revoke all on function public._create_task_core(uuid, uuid, uuid, text, text, text, integer[], date, date, date, boolean) from public, anon, authenticated;

-- create_task() itself is unchanged in signature and in every check it
-- performs -- it now simply delegates its final insert to the shared
-- helper above with p_suppress_notification = false (ordinary standalone
-- task creation always gets its normal assignment notification).
create or replace function public.create_task(
    p_connection_id uuid,
    p_title text,
    p_notes text,
    p_frequency text,
    p_days_of_week integer[],
    p_start_date date,
    p_due_date date,
    p_recurrence_end_date date
)
returns public.tasks
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
    v_caregiver_id uuid := auth.uid();
    v_connection public.connections%rowtype;
    v_profile public.profiles%rowtype;
begin
    if v_caregiver_id is null then
        raise exception 'authentication_required';
    end if;

    select * into v_profile from public.profiles where id = v_caregiver_id;
    if not found or v_profile.account_status <> 'active' then
        raise exception 'not_authorized';
    end if;

    select * into v_connection from public.connections where id = p_connection_id for share;
    if not found or v_connection.caregiver_id <> v_caregiver_id or v_connection.status <> 'accepted' or v_connection.accepted_at is null then
        raise exception 'connection_inactive';
    end if;

    return public._create_task_core(
        p_connection_id, v_caregiver_id, v_connection.recipient_id,
        p_title, p_notes, p_frequency, p_days_of_week, p_start_date, p_due_date, p_recurrence_end_date,
        false
    );
end;
$$;
revoke all on function public.create_task(uuid, text, text, text, integer[], date, date, date) from public, anon;
grant execute on function public.create_task(uuid, text, text, text, integer[], date, date, date) to authenticated;

create or replace function public._routine_template_summary(p_template_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, extensions, pg_catalog
as $$
    select jsonb_build_object(
        'templateId', rt.id,
        'title', rt.title,
        'status', rt.status,
        'revision', rt.revision,
        'itemCount', (select count(*) from public.routine_template_items where template_id = rt.id)
    )
    from public.routine_templates rt
    where rt.id = p_template_id;
$$;
revoke all on function public._routine_template_summary(uuid) from public, anon, authenticated;

create or replace function public._routine_instance_summary(p_instance_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, extensions, pg_catalog
as $$
    select jsonb_build_object(
        'routineInstanceId', ri.id,
        'title', ri.title,
        'status', ri.status,
        'reminderCount', (select count(*) from public.routine_instance_items where routine_instance_id = ri.id and item_kind = 'reminder'),
        'taskCount', (select count(*) from public.routine_instance_items where routine_instance_id = ri.id and item_kind = 'task')
    )
    from public.routine_instances ri
    where ri.id = p_instance_id;
$$;
revoke all on function public._routine_instance_summary(uuid) from public, anon, authenticated;

-- Validates and inserts exactly one routine_template_items row. Shared by
-- create_routine_template / update_routine_template / duplicate_routine_
-- template so the kind-specific field validation exists in exactly one
-- place, matching (and enforcing at insert time, not just via the table's
-- own CHECK constraints, so a violation raises a stable, friendly error
-- rather than a raw constraint-violation message) the routine_template_
-- items_kind_fields_check invariant above.
create or replace function public._insert_routine_template_item(p_template_id uuid, p_order integer, p_item jsonb)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
    v_kind text := p_item->>'item_kind';
    v_title text := btrim(coalesce(p_item->>'title', ''));
    v_notes text := nullif(btrim(coalesce(p_item->>'notes', '')), '');
    v_frequency text := p_item->>'frequency';
    v_days integer[];
    v_start_offset integer := coalesce((p_item->>'start_offset_days')::integer, 0);
    v_due_offset integer := nullif(p_item->>'due_offset_days', '')::integer;
    v_enabled boolean := coalesce((p_item->>'enabled_by_default')::boolean, true);
    v_reminder_type text := p_item->>'reminder_type';
    v_time_of_day time := nullif(p_item->>'time_of_day', '')::time;
    v_no_response integer := nullif(p_item->>'no_response_minutes', '')::integer;
begin
    if v_kind is null or v_kind not in ('reminder', 'task') then
        raise exception 'invalid_item_kind';
    end if;
    if v_title = '' or char_length(v_title) > 200 then
        raise exception 'invalid_item_title';
    end if;
    if v_notes is not null and char_length(v_notes) > 2000 then
        raise exception 'invalid_item_notes';
    end if;
    if v_start_offset < 0 then
        raise exception 'invalid_start_offset';
    end if;
    if v_due_offset is not null and v_due_offset < v_start_offset then
        raise exception 'due_offset_before_start_offset';
    end if;

    select coalesce(array_agg(x::int order by x), '{}')
    into v_days
    from jsonb_array_elements_text(coalesce(p_item->'days_of_week', '[]'::jsonb)) as x;

    if v_kind = 'reminder' then
        if v_frequency is null or v_frequency not in ('daily', 'weekdays', 'weekends', 'custom') then
            raise exception 'invalid_frequency';
        end if;
        if cardinality(v_days) < 1 or cardinality(v_days) > 7 or not (v_days <@ array[1,2,3,4,5,6,7]) then
            raise exception 'invalid_days_of_week';
        end if;
        if v_time_of_day is null then
            raise exception 'reminder_requires_time_of_day';
        end if;
        if v_reminder_type is null or v_reminder_type not in ('medication', 'hydration', 'appointment', 'meal', 'exercise', 'other') then
            raise exception 'invalid_reminder_type';
        end if;
        if v_no_response is null or v_no_response < 1 or v_no_response > 120 then
            raise exception 'invalid_no_response_minutes';
        end if;
        if v_due_offset is not null then
            raise exception 'reminder_cannot_have_due_offset';
        end if;

        insert into public.routine_template_items (
            template_id, item_kind, display_order, title, notes, enabled_by_default,
            frequency, days_of_week, start_offset_days, due_offset_days,
            reminder_type, time_of_day, no_response_minutes
        ) values (
            p_template_id, 'reminder', p_order, v_title, v_notes, v_enabled,
            v_frequency, v_days, v_start_offset, null,
            v_reminder_type, v_time_of_day, v_no_response
        );
    else
        if v_frequency is null or v_frequency not in ('one_time', 'daily', 'weekdays', 'weekends', 'custom') then
            raise exception 'invalid_frequency';
        end if;
        if v_time_of_day is not null then
            raise exception 'task_cannot_have_time_of_day';
        end if;
        if v_no_response is not null then
            raise exception 'task_cannot_have_no_response_minutes';
        end if;
        if v_frequency = 'one_time' then
            if cardinality(v_days) <> 0 then
                raise exception 'one_time_task_cannot_have_days_of_week';
            end if;
        else
            if cardinality(v_days) < 1 or cardinality(v_days) > 7 or not (v_days <@ array[1,2,3,4,5,6,7]) then
                raise exception 'invalid_days_of_week';
            end if;
            if v_due_offset is not null then
                raise exception 'recurring_task_cannot_have_due_offset';
            end if;
        end if;

        insert into public.routine_template_items (
            template_id, item_kind, display_order, title, notes, enabled_by_default,
            frequency, days_of_week, start_offset_days, due_offset_days,
            reminder_type, time_of_day, no_response_minutes
        ) values (
            p_template_id, 'task', p_order, v_title, v_notes, v_enabled,
            v_frequency, v_days, v_start_offset, v_due_offset,
            null, null, null
        );
    end if;
end;
$$;
revoke all on function public._insert_routine_template_item(uuid, integer, jsonb) from public, anon, authenticated;

-- ─── Public template RPCs ──────────────────────────────────────────────────

create or replace function public.create_routine_template(p_title text, p_description text, p_use_case text, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
    v_owner uuid := auth.uid();
    v_profile public.profiles%rowtype;
    v_template public.routine_templates%rowtype;
    v_item jsonb;
    v_idx integer := 0;
    v_count integer;
begin
    if v_owner is null then
        raise exception 'authentication_required';
    end if;

    select * into v_profile from public.profiles where id = v_owner;
    if not found or v_profile.account_status <> 'active' then
        raise exception 'not_authorized';
    end if;
    if v_profile.role is distinct from 'caregiver' then
        raise exception 'organizer_role_required';
    end if;

    if p_title is null or btrim(p_title) = '' or char_length(p_title) > 200 then
        raise exception 'invalid_title';
    end if;
    if p_description is not null and char_length(p_description) > 2000 then
        raise exception 'invalid_description';
    end if;
    if p_use_case is not null and p_use_case not in ('care','family','coaching','team','personal','other') then
        raise exception 'invalid_use_case';
    end if;

    v_count := jsonb_array_length(coalesce(p_items, '[]'::jsonb));
    if v_count < 1 or v_count > 20 then
        raise exception 'invalid_item_count';
    end if;

    insert into public.routine_templates (owner_id, title, description, use_case)
    values (v_owner, btrim(p_title), nullif(btrim(coalesce(p_description, '')), ''), p_use_case)
    returning * into v_template;

    for v_item in select * from jsonb_array_elements(p_items)
    loop
        v_idx := v_idx + 1;
        perform public._insert_routine_template_item(v_template.id, v_idx, v_item);
    end loop;

    return public._routine_template_summary(v_template.id);
end;
$$;
revoke all on function public.create_routine_template(text, text, text, jsonb) from public, anon;
grant execute on function public.create_routine_template(text, text, text, jsonb) to authenticated;

create or replace function public.update_routine_template(p_template_id uuid, p_title text, p_description text, p_use_case text, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
    v_owner uuid := auth.uid();
    v_template public.routine_templates%rowtype;
    v_item jsonb;
    v_idx integer := 0;
    v_count integer;
begin
    if v_owner is null then
        raise exception 'authentication_required';
    end if;

    select * into v_template from public.routine_templates where id = p_template_id for update;
    if not found or v_template.owner_id <> v_owner then
        raise exception 'not_authorized';
    end if;

    if p_title is null or btrim(p_title) = '' or char_length(p_title) > 200 then
        raise exception 'invalid_title';
    end if;
    if p_description is not null and char_length(p_description) > 2000 then
        raise exception 'invalid_description';
    end if;
    if p_use_case is not null and p_use_case not in ('care','family','coaching','team','personal','other') then
        raise exception 'invalid_use_case';
    end if;

    v_count := jsonb_array_length(coalesce(p_items, '[]'::jsonb));
    if v_count < 1 or v_count > 20 then
        raise exception 'invalid_item_count';
    end if;

    update public.routine_templates
    set title = btrim(p_title),
        description = nullif(btrim(coalesce(p_description, '')), ''),
        use_case = p_use_case,
        revision = revision + 1,
        updated_at = now()
    where id = p_template_id;

    -- Full replace, not an incremental diff -- simplest correct behavior
    -- for reordering/editing/removing items in one call. Instances already
    -- applied from this template are entirely unaffected: they link to
    -- concrete reminder/task rows, never to these item rows.
    delete from public.routine_template_items where template_id = p_template_id;

    for v_item in select * from jsonb_array_elements(p_items)
    loop
        v_idx := v_idx + 1;
        perform public._insert_routine_template_item(p_template_id, v_idx, v_item);
    end loop;

    return public._routine_template_summary(p_template_id);
end;
$$;
revoke all on function public.update_routine_template(uuid, text, text, text, jsonb) from public, anon;
grant execute on function public.update_routine_template(uuid, text, text, text, jsonb) to authenticated;

create or replace function public.duplicate_routine_template(p_template_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
    v_owner uuid := auth.uid();
    v_source public.routine_templates%rowtype;
    v_new public.routine_templates%rowtype;
begin
    if v_owner is null then
        raise exception 'authentication_required';
    end if;

    select * into v_source from public.routine_templates where id = p_template_id;
    if not found or v_source.owner_id <> v_owner then
        raise exception 'not_authorized';
    end if;

    insert into public.routine_templates (owner_id, title, description, use_case)
    values (v_owner, v_source.title, v_source.description, v_source.use_case)
    returning * into v_new;

    insert into public.routine_template_items (
        template_id, item_kind, display_order, title, notes, enabled_by_default,
        frequency, days_of_week, start_offset_days, due_offset_days,
        reminder_type, time_of_day, no_response_minutes
    )
    select v_new.id, item_kind, display_order, title, notes, enabled_by_default,
           frequency, days_of_week, start_offset_days, due_offset_days,
           reminder_type, time_of_day, no_response_minutes
    from public.routine_template_items
    where template_id = p_template_id;

    return public._routine_template_summary(v_new.id);
end;
$$;
revoke all on function public.duplicate_routine_template(uuid) from public, anon;
grant execute on function public.duplicate_routine_template(uuid) to authenticated;

create or replace function public.archive_routine_template(p_template_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
    v_owner uuid := auth.uid();
    v_row public.routine_templates%rowtype;
begin
    if v_owner is null then
        raise exception 'authentication_required';
    end if;
    select * into v_row from public.routine_templates where id = p_template_id for update;
    if not found or v_row.owner_id <> v_owner then
        raise exception 'not_authorized';
    end if;
    update public.routine_templates set status = 'archived', updated_at = now()
    where id = p_template_id and status <> 'archived';
end;
$$;
revoke all on function public.archive_routine_template(uuid) from public, anon;
grant execute on function public.archive_routine_template(uuid) to authenticated;

create or replace function public.restore_routine_template(p_template_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
    v_owner uuid := auth.uid();
    v_row public.routine_templates%rowtype;
begin
    if v_owner is null then
        raise exception 'authentication_required';
    end if;
    select * into v_row from public.routine_templates where id = p_template_id for update;
    if not found or v_row.owner_id <> v_owner then
        raise exception 'not_authorized';
    end if;
    update public.routine_templates set status = 'active', updated_at = now()
    where id = p_template_id and status <> 'active';
end;
$$;
revoke all on function public.restore_routine_template(uuid) from public, anon;
grant execute on function public.restore_routine_template(uuid) to authenticated;

-- Hard delete is a deliberate choice (see docs/routine-template-model.md):
-- templates carry no shared participant history. source_template_id's
-- ON DELETE SET NULL is what protects every already-applied routine
-- instance (and the real reminders/tasks/history underneath it) from being
-- affected by this at all.
create or replace function public.delete_routine_template(p_template_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
    v_owner uuid := auth.uid();
    v_row public.routine_templates%rowtype;
begin
    if v_owner is null then
        raise exception 'authentication_required';
    end if;
    select * into v_row from public.routine_templates where id = p_template_id for update;
    if not found or v_row.owner_id <> v_owner then
        raise exception 'not_authorized';
    end if;
    delete from public.routine_templates where id = p_template_id;
end;
$$;
revoke all on function public.delete_routine_template(uuid) from public, anon;
grant execute on function public.delete_routine_template(uuid) to authenticated;

-- ─── apply_routine_template: the single transactional apply operation ─────
--
-- p_items is a jsonb array of already-resolved, concrete items (the client
-- -- lib/routineCore.ts -- turns each template/pack item's relative
-- start_offset_days/due_offset_days into an absolute date against the
-- organizer-chosen p_start_date and the participant's own timezone before
-- ever calling this function). Only enabled items are included; a
-- disabled-in-preview item is simply omitted from the array. Shape:
--
--   reminder: { item_kind:'reminder', title, notes, reminder_type,
--               time_of_day:'HH:MM', frequency, days_of_week:[1..7],
--               no_response_minutes }
--   task:     { item_kind:'task', title, notes, frequency,
--               days_of_week:[1..7] (omit/[] for one_time),
--               start_date:'YYYY-MM-DD', due_date, recurrence_end_date }
--
-- Every field is independently re-validated here regardless of source
-- (personal template or built-in pack) -- p_built_in_pack_id/p_built_in_
-- pack_version are pure descriptive metadata, never trusted for anything.
create or replace function public.apply_routine_template(
    p_connection_id uuid,
    p_source_template_id uuid,
    p_source_template_revision integer,
    p_built_in_pack_id text,
    p_built_in_pack_version text,
    p_title text,
    p_start_date date,
    p_items jsonb,
    p_apply_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
    v_organizer_id uuid := auth.uid();
    v_profile public.profiles%rowtype;
    v_connection public.connections%rowtype;
    v_participant public.profiles%rowtype;
    v_template public.routine_templates%rowtype;
    v_existing public.routine_instances%rowtype;
    v_instance public.routine_instances%rowtype;
    v_item jsonb;
    v_idx integer := 0;
    v_item_count integer;
    v_kind text;
    v_title text;
    v_notes text;
    v_reminder public.reminders%rowtype;
    v_task public.tasks%rowtype;
    v_days integer[];
    v_created boolean;
begin
    if v_organizer_id is null then
        raise exception 'authentication_required';
    end if;

    if p_apply_request_id is null or btrim(p_apply_request_id) = '' then
        raise exception 'invalid_apply_request_id';
    end if;
    if p_title is null or btrim(p_title) = '' or char_length(p_title) > 200 then
        raise exception 'invalid_title';
    end if;
    if p_start_date is null then
        raise exception 'invalid_start_date';
    end if;
    if (p_source_template_id is null) = (p_built_in_pack_id is null) then
        raise exception 'invalid_source';
    end if;

    v_item_count := jsonb_array_length(coalesce(p_items, '[]'::jsonb));
    if v_item_count < 1 or v_item_count > 20 then
        raise exception 'invalid_item_count';
    end if;

    -- Idempotency short-circuit: an existing instance for this exact
    -- (organizer, apply_request_id) pair is returned as-is, before any
    -- other validation runs, so a naive retry (or a slow duplicate network
    -- request) is always safe.
    select * into v_existing from public.routine_instances
    where organizer_id = v_organizer_id and apply_request_id = p_apply_request_id;
    if found then
        return public._routine_instance_summary(v_existing.id) || jsonb_build_object('alreadyExisted', true);
    end if;

    select * into v_profile from public.profiles where id = v_organizer_id;
    if not found or v_profile.account_status <> 'active' then
        raise exception 'not_authorized';
    end if;
    if v_profile.role is distinct from 'caregiver' then
        raise exception 'organizer_role_required';
    end if;

    select * into v_connection from public.connections where id = p_connection_id for share;
    if not found or v_connection.caregiver_id <> v_organizer_id or v_connection.status <> 'accepted' or v_connection.accepted_at is null then
        raise exception 'connection_inactive';
    end if;

    select * into v_participant from public.profiles where id = v_connection.recipient_id;
    if not found or v_participant.account_status <> 'active' then
        raise exception 'not_authorized';
    end if;
    if not public._is_valid_iana_timezone(v_participant.timezone) then
        raise exception 'participant_timezone_unavailable';
    end if;

    if p_source_template_id is not null then
        select * into v_template from public.routine_templates where id = p_source_template_id;
        if not found or v_template.owner_id <> v_organizer_id then
            raise exception 'template_not_found';
        end if;
        if v_template.status <> 'active' then
            raise exception 'template_archived';
        end if;
        if p_source_template_revision is not null and p_source_template_revision <> v_template.revision then
            raise exception 'template_revision_changed';
        end if;
    end if;

    -- The idempotency/concurrency gate: whichever concurrent identical
    -- request wins this insert proceeds to create items below; the loser
    -- sees `not found` and falls through to reading back the winner's
    -- result, never creating a second instance or any duplicate items.
    insert into public.routine_instances (
        organizer_id, participant_id, connection_id, title,
        source_template_id, built_in_pack_id, source_version,
        participant_timezone_snapshot, start_date, apply_request_id
    ) values (
        v_organizer_id, v_connection.recipient_id, p_connection_id, btrim(p_title),
        p_source_template_id, p_built_in_pack_id, coalesce(p_built_in_pack_version, '1'),
        v_participant.timezone, p_start_date, p_apply_request_id
    )
    on conflict (organizer_id, apply_request_id) do nothing
    returning * into v_instance;

    v_created := found;

    if not v_created then
        select * into v_existing from public.routine_instances
        where organizer_id = v_organizer_id and apply_request_id = p_apply_request_id;
        return public._routine_instance_summary(v_existing.id) || jsonb_build_object('alreadyExisted', true);
    end if;

    -- Validate + create every item. Any exception from here on rolls back
    -- the entire function call, including the routine_instances insert
    -- above -- Postgres functions have no partial commit.
    for v_item in select * from jsonb_array_elements(p_items)
    loop
        v_idx := v_idx + 1;
        v_kind := v_item->>'item_kind';
        v_title := btrim(coalesce(v_item->>'title', ''));
        v_notes := nullif(btrim(coalesce(v_item->>'notes', '')), '');

        if v_title = '' or char_length(v_title) > 200 then
            raise exception 'invalid_item_title';
        end if;
        if v_notes is not null and char_length(v_notes) > 2000 then
            raise exception 'invalid_item_notes';
        end if;

        if v_kind = 'reminder' then
            select coalesce(array_agg(x::int order by x), '{}') into v_days
            from jsonb_array_elements_text(coalesce(v_item->'days_of_week', '[]'::jsonb)) as x;

            insert into public.reminders (
                connection_id, caregiver_id, recipient_id, title, reminder_type, notes,
                time_of_day, frequency, days_of_week, no_response_minutes
            ) values (
                p_connection_id, v_organizer_id, v_connection.recipient_id,
                v_title,
                nullif(v_item->>'reminder_type', ''),
                v_notes,
                nullif(v_item->>'time_of_day', '')::time,
                v_item->>'frequency',
                v_days,
                nullif(v_item->>'no_response_minutes', '')::integer
            )
            returning * into v_reminder;

            insert into public.routine_instance_items (routine_instance_id, source_item_key, item_kind, reminder_id, display_order)
            values (v_instance.id, v_item->>'source_item_key', 'reminder', v_reminder.id, v_idx);

        elsif v_kind = 'task' then
            v_task := public._create_task_core(
                p_connection_id, v_organizer_id, v_connection.recipient_id,
                v_title, v_notes,
                v_item->>'frequency',
                (select coalesce(array_agg(x::int order by x), '{}') from jsonb_array_elements_text(coalesce(v_item->'days_of_week', '[]'::jsonb)) as x),
                nullif(v_item->>'start_date', '')::date,
                nullif(v_item->>'due_date', '')::date,
                nullif(v_item->>'recurrence_end_date', '')::date,
                true -- suppress the individual task-assignment notification; see routine_notification_deliveries below
            );

            insert into public.routine_instance_items (routine_instance_id, source_item_key, item_kind, task_id, display_order)
            values (v_instance.id, v_item->>'source_item_key', 'task', v_task.id, v_idx);
        else
            raise exception 'invalid_item_kind';
        end if;
    end loop;

    -- Exactly one routine-assignment notification, regardless of item
    -- composition (reminder-only, task-only, or mixed) -- the unique
    -- constraint on routine_instance_id makes a second one structurally
    -- impossible even under a retried/duplicated call to this function
    -- (which would have already short-circuited above before reaching
    -- here).
    insert into public.routine_notification_deliveries (routine_instance_id, recipient_id)
    values (v_instance.id, v_connection.recipient_id);

    return public._routine_instance_summary(v_instance.id) || jsonb_build_object('alreadyExisted', false);
end;
$$;
revoke all on function public.apply_routine_template(uuid, uuid, integer, text, text, text, date, jsonb, text) from public, anon;
grant execute on function public.apply_routine_template(uuid, uuid, integer, text, text, text, date, jsonb, text) to authenticated;

-- ─── archive_routine_instance ──────────────────────────────────────────────
-- Product meaning: stop future activity created by this routine, preserve
-- every historical reminder_logs/task_occurrences row, never touch the
-- source template. Reuses the *exact* is_active=false mechanism already
-- used by end_connection/archive_task (see migration 20260727000000 and
-- 20260728010000) -- there is no separate "archived" concept to invent for
-- member reminders/tasks; is_active=false already makes the existing
-- send-*-notifications functions fail closed (task_inactive/connection_
-- inactive guards) and already excludes them from future Today/eligibility
-- computations.
create or replace function public.archive_routine_instance(p_routine_instance_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
    v_instance public.routine_instances%rowtype;
begin
    if auth.uid() is null then
        raise exception 'authentication_required';
    end if;

    select * into v_instance from public.routine_instances where id = p_routine_instance_id for update;
    if not found or v_instance.organizer_id <> auth.uid() then
        raise exception 'not_authorized';
    end if;

    if v_instance.status = 'archived' then
        return; -- idempotent, mirrors end_connection/archive_task
    end if;

    update public.routine_instances set status = 'archived', archived_at = now(), updated_at = now()
    where id = p_routine_instance_id;

    update public.reminders r
    set is_active = false, updated_at = now()
    from public.routine_instance_items rii
    where rii.routine_instance_id = p_routine_instance_id
      and rii.reminder_id = r.id
      and r.is_active = true;

    update public.tasks tk
    set is_active = false, updated_at = now()
    from public.routine_instance_items rii
    where rii.routine_instance_id = p_routine_instance_id
      and rii.task_id = tk.id
      and tk.is_active = true;
end;
$$;
revoke all on function public.archive_routine_instance(uuid) from public, anon;
grant execute on function public.archive_routine_instance(uuid) to authenticated;

-- ─── Operational health parity with task_notification_health_summary ─────

create or replace function public.routine_notification_health_summary(p_window_hours integer default 24)
returns table(metric text, value numeric)
language sql
stable
security definer
set search_path = public, extensions, pg_catalog
as $$
    with window_deliveries as (
        select * from public.routine_notification_deliveries
        where created_at >= now() - make_interval(hours => greatest(p_window_hours, 1))
    )
    select 'due_in_window'::text, count(*)::numeric from window_deliveries
    union all
    select 'sent', count(*) from window_deliveries where status = 'sent'
    union all
    select 'failed_token_absence', count(*) from window_deliveries
        where status = 'failed' and error_code in ('no_active_push_token', 'device_not_registered')
    union all
    select 'failed_other', count(*) from window_deliveries
        where status = 'failed' and (error_code is null or error_code not in ('no_active_push_token', 'device_not_registered'))
    union all
    select 'pending', count(*) from window_deliveries where status = 'pending'
    union all
    select 'stuck_pending', count(*) from public.routine_notification_deliveries
        where status = 'pending' and updated_at < now() - interval '5 minutes';
$$;
revoke all on function public.routine_notification_health_summary(integer) from public, anon, authenticated;
grant execute on function public.routine_notification_health_summary(integer) to service_role;

-- ─── Cron wiring for send-routine-assignment-notifications ────────────────
-- Reuses the existing shared cron secret (recipient_push_cron_secret,
-- already in vault since the server-push migration) -- no new secret
-- needed. Cadence matches send-task-assignment-notifications (every
-- minute): routine-assignment volume is the same order of magnitude as
-- task-assignment volume (at most one row per successful apply, ever), so
-- the faster 30-second due-window cadence used for time-critical reminder
-- delivery is unnecessary here.

create or replace function public.trigger_send_routine_assignment_notifications()
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
    secret text;
begin
    select decrypted_secret into secret
    from vault.decrypted_secrets
    where name = 'recipient_push_cron_secret';

    if secret is null then
        raise warning 'recipient_push_cron_secret not set in vault; skipping send-routine-assignment-notifications invocation';
        return;
    end if;

    perform net.http_post(
        url := 'https://ofpzbifonihfutghbjbw.supabase.co/functions/v1/send-routine-assignment-notifications',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-cron-secret', secret
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 20000
    );
end;
$$;
revoke all on function public.trigger_send_routine_assignment_notifications() from public, anon, authenticated;
grant execute on function public.trigger_send_routine_assignment_notifications() to service_role;

select cron.schedule(
    'send-routine-assignment-notifications',
    '* * * * *',
    $$select public.trigger_send_routine_assignment_notifications();$$
);

-- ─── Rollback ───────────────────────────────────────────────────────────────
-- select cron.unschedule('send-routine-assignment-notifications');
-- drop function if exists public.trigger_send_routine_assignment_notifications();
-- drop function if exists public.routine_notification_health_summary(integer);
-- drop function if exists public.archive_routine_instance(uuid);
-- drop function if exists public.apply_routine_template(uuid, uuid, integer, text, text, text, date, jsonb, text);
-- drop function if exists public.delete_routine_template(uuid);
-- drop function if exists public.restore_routine_template(uuid);
-- drop function if exists public.archive_routine_template(uuid);
-- drop function if exists public.duplicate_routine_template(uuid);
-- drop function if exists public.update_routine_template(uuid, text, text, text, jsonb);
-- drop function if exists public.create_routine_template(text, text, text, jsonb);
-- drop function if exists public._insert_routine_template_item(uuid, integer, jsonb);
-- drop function if exists public._routine_instance_summary(uuid);
-- drop function if exists public._routine_template_summary(uuid);
-- -- create_task() reverts to its pre-migration body (inline insert, no
-- -- _create_task_core delegation) if this migration is rolled back --
-- -- restore from migration 20260728000000_flexible_tasks.sql.
-- drop function if exists public._create_task_core(uuid, uuid, uuid, text, text, text, integer[], date, date, date, boolean);
-- drop function if exists public._is_valid_iana_timezone(text);
-- drop table if exists public.routine_notification_deliveries;
-- drop table if exists public.routine_instance_items;
-- drop table if exists public.routine_instances;
-- drop table if exists public.routine_template_items;
-- drop table if exists public.routine_templates;
