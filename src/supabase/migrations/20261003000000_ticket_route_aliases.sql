-- JIR-116 (extension) — historical ticket URLs survive a move.
--
-- A ticket's visible identity is project + ticket number (shown as
-- <PROJECT_CODE>-<N>, URL /projects/<slug>/tickets/<CODE>-<N>); its real
-- identity is tickets.id. Every identity a ticket leaves behind when it's
-- moved is kept here, pointing at the same stable ticket id, so an old URL
-- resolves to wherever the ticket lives *now* — directly, never through a
-- chain of older aliases.
--
-- Reservation: a historical (project, number) stays reserved forever — it
-- can never be handed to a different ticket, so an old link can't silently
-- start opening some other ticket months later:
--   - unique (project_id, ticket_number) here: one historical identity maps
--     to exactly one ticket;
--   - tickets_block_reserved_ticket_number: no ticket may take a number
--     another ticket left behind in that project;
--   - next_ticket_number(): new numbers start after both live tickets and
--     reserved numbers (ticket creation and moves both use it);
--   - ticket_id is ON DELETE SET NULL, so deleting a moved ticket keeps its
--     old numbers reserved (they then simply resolve to nothing).
--
-- Access: no client policies — the table is only read/written by the
-- security-definer functions below. Resolving an alias never bypasses
-- authorization: resolve_ticket_route_alias only answers when the caller
-- can view the ticket's *current* project (the same can_view_project rule
-- tickets_select uses), otherwise it returns nothing, exactly like an
-- unknown URL.
--
-- move_ticket_to_project is replaced (same signature, same behavior from
-- 20261002000000) so the alias for the identity being vacated is written in
-- the same transaction as the move: no successful move without its alias.
--
-- No backfill: aliases only come from moves, and moves before this
-- migration (if any) have their old identity in the 'ticket_moved'
-- ticket_activity payload; none is invented here.

create table public.ticket_route_aliases (
  id            uuid primary key default gen_random_uuid(),
  ticket_id     uuid references public.tickets (id) on delete set null,
  project_id    uuid not null references public.projects (id) on delete cascade,
  ticket_number integer not null,
  created_at    timestamptz not null default now(),
  created_by    uuid references public.profiles (id) on delete set null,
  constraint ticket_route_aliases_project_number_key unique (project_id, ticket_number)
);

create index ticket_route_aliases_ticket_id_idx on public.ticket_route_aliases (ticket_id);

alter table public.ticket_route_aliases enable row level security;
-- Deliberately no policies: only the security-definer functions below use it.


-- ── Reserved numbers can't be taken by another ticket ─────────────────────
create or replace function public.tickets_block_reserved_ticket_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.ticket_route_aliases a
    where a.project_id = new.project_id
      and a.ticket_number = new.ticket_number
      and a.ticket_id is distinct from new.id
  ) then
    raise exception 'ticket number % is reserved in project %', new.ticket_number, new.project_id
      using errcode = 'unique_violation';
  end if;
  return new;
end;
$$;

create trigger tickets_block_reserved_ticket_number
  before insert or update of project_id, ticket_number on public.tickets
  for each row execute function public.tickets_block_reserved_ticket_number();


-- ── Next free number in a project (live tickets + reserved numbers) ───────
-- Same "highest + 1" rule ticket creation always used, now also past every
-- reserved historical number. Only a number is returned, and only to a
-- member of the project's organization.
create or replace function public.next_ticket_number(p_project_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select greatest(
    coalesce((select max(t.ticket_number) from public.tickets t where t.project_id = p_project_id), 0),
    coalesce((select max(a.ticket_number) from public.ticket_route_aliases a where a.project_id = p_project_id), 0)
  ) + 1
  from public.projects p
  where p.id = p_project_id
    and public.is_org_member(p.organization_id);
$$;

revoke all on function public.next_ticket_number(uuid) from public;
grant execute on function public.next_ticket_number(uuid) to authenticated;


-- ── Resolve an old URL to the ticket's current location ───────────────────
-- Input is exactly what the URL carries (project slug + "<CODE>-<N>").
-- Returns the current slug/code only when that historical identity exists
-- AND the caller can view the ticket where it lives now; otherwise no row.
create or replace function public.resolve_ticket_route_alias(
  p_organization_id uuid,
  p_project_slug text,
  p_ticket_code text
)
returns table (project_slug text, ticket_code text)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_project public.projects%rowtype;
  v_number integer;
  v_ticket_id uuid;
begin
  if auth.uid() is null or not public.is_org_member(p_organization_id) then
    return;
  end if;

  select * into v_project from public.projects p
  where p.organization_id = p_organization_id and p.slug = p_project_slug;
  if not found then
    return;
  end if;

  if p_ticket_code is null
     or left(p_ticket_code, length(v_project.project_code) + 1) <> v_project.project_code || '-' then
    return;
  end if;
  begin
    v_number := substr(p_ticket_code, length(v_project.project_code) + 2)::integer;
  exception when others then
    return;
  end;

  select a.ticket_id into v_ticket_id
  from public.ticket_route_aliases a
  where a.project_id = v_project.id and a.ticket_number = v_number;
  if v_ticket_id is null then
    return;
  end if;

  return query
    select cp.slug, cp.project_code || '-' || t.ticket_number
    from public.tickets t
    join public.projects cp on cp.id = t.project_id
    where t.id = v_ticket_id
      and public.can_view_project(t.project_id);
end;
$$;

revoke all on function public.resolve_ticket_route_alias(uuid, text, text) from public;
grant execute on function public.resolve_ticket_route_alias(uuid, text, text) to authenticated;


-- ── move_ticket_to_project — now also reserves the identity it vacates ────
-- Identical to 20261002000000 except: (1) the identity being left is
-- written to ticket_route_aliases before the ticket changes, in the same
-- transaction; (2) the new number comes from next_ticket_number's rule
-- (past reserved numbers too).
create or replace function public.move_ticket_to_project(
  p_ticket_id uuid,
  p_destination_project_id uuid,
  p_expected_source_project_id uuid default null
)
returns table (ticket_id uuid, project_slug text, project_code text, ticket_number integer)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_actor uuid := auth.uid();
  v_ticket public.tickets%rowtype;
  v_source public.projects%rowtype;
  v_dest public.projects%rowtype;
  v_role text;
  v_source_legacy public.ticket_status;
  v_new_status_id uuid;
  v_new_assignee uuid;
  v_new_number integer;
  v_attempt integer := 0;
begin
  if v_actor is null then
    raise exception 'move_ticket:not_authorized';
  end if;

  select * into v_ticket from public.tickets t where t.id = p_ticket_id for update;
  if not found then
    raise exception 'move_ticket:ticket_not_found';
  end if;

  if p_expected_source_project_id is not null and v_ticket.project_id <> p_expected_source_project_id then
    raise exception 'move_ticket:ticket_changed';
  end if;

  select * into v_source from public.projects p where p.id = v_ticket.project_id;

  select om.role::text into v_role
  from public.organization_memberships om
  where om.organization_id = v_source.organization_id
    and om.profile_id = v_actor
    and om.status = 'active';

  if v_role is null or v_role not in ('admin', 'project_lead') then
    raise exception 'move_ticket:not_authorized';
  end if;
  if v_role = 'project_lead' and not public.project_membership_is_active_lead(v_source.id, v_actor) then
    raise exception 'move_ticket:not_authorized';
  end if;

  select * into v_dest from public.projects p
  where p.id = p_destination_project_id and p.organization_id = v_source.organization_id
  for update;
  if not found then
    raise exception 'move_ticket:destination_not_found';
  end if;
  if v_dest.id = v_source.id then
    raise exception 'move_ticket:same_project';
  end if;
  if v_role = 'project_lead' and not public.project_membership_is_active_lead(v_dest.id, v_actor) then
    raise exception 'move_ticket:not_authorized';
  end if;
  if v_dest.status = 'archived' then
    raise exception 'move_ticket:destination_archived';
  end if;

  if v_ticket.parent_ticket_id is not null
     or exists (select 1 from public.tickets c where c.parent_ticket_id = v_ticket.id) then
    raise exception 'move_ticket:has_hierarchy';
  end if;
  if exists (
    select 1 from public.ticket_relations r
    where r.ticket_id = v_ticket.id or r.related_ticket_id = v_ticket.id
  ) then
    raise exception 'move_ticket:has_relations';
  end if;

  select s.legacy_enum_value into v_source_legacy from public.ticket_statuses s where s.id = v_ticket.status_id;
  if v_source_legacy is not null then
    select s.id into v_new_status_id
    from public.ticket_statuses s
    where s.project_id = v_dest.id and s.legacy_enum_value = v_source_legacy;
  end if;
  if v_new_status_id is null then
    select s.id into v_new_status_id
    from public.ticket_statuses s
    where s.project_id = v_dest.id and s.is_default;
  end if;
  if v_new_status_id is null then
    raise exception 'move_ticket:destination_missing_default_status';
  end if;

  v_new_assignee := case
    when v_ticket.assignee_profile_id is not null and exists (
      select 1 from public.project_memberships pm
      where pm.project_id = v_dest.id and pm.profile_id = v_ticket.assignee_profile_id
    ) then v_ticket.assignee_profile_id
    else null
  end;

  -- Reserve the identity being vacated, pointing at this same ticket.
  insert into public.ticket_route_aliases (ticket_id, project_id, ticket_number, created_by)
  values (v_ticket.id, v_source.id, v_ticket.ticket_number, v_actor);

  loop
    v_attempt := v_attempt + 1;
    select greatest(
      coalesce((select max(t.ticket_number) from public.tickets t where t.project_id = v_dest.id), 0),
      coalesce((select max(a.ticket_number) from public.ticket_route_aliases a where a.project_id = v_dest.id), 0)
    ) + 1 into v_new_number;

    begin
      update public.tickets t
      set project_id = v_dest.id,
          ticket_number = v_new_number,
          status_id = v_new_status_id,
          assignee_profile_id = v_new_assignee,
          sprint_id = null,
          last_open_status_id = null
      where t.id = v_ticket.id;
      exit;
    exception when unique_violation then
      if v_attempt >= 5 then
        raise exception 'move_ticket:number_conflict';
      end if;
    end;
  end loop;

  insert into public.ticket_activity (ticket_id, actor_profile_id, event_type, field_name, old_value, new_value, payload)
  values (
    v_ticket.id,
    v_actor,
    'ticket_moved',
    'project',
    v_source.name || ' (' || v_source.project_code || '-' || v_ticket.ticket_number || ')',
    v_dest.name || ' (' || v_dest.project_code || '-' || v_new_number || ')',
    jsonb_build_object(
      'from_project_id', v_source.id,
      'from_project_code', v_source.project_code,
      'from_ticket_number', v_ticket.ticket_number,
      'to_project_id', v_dest.id,
      'to_project_code', v_dest.project_code,
      'to_ticket_number', v_new_number
    )
  );

  return query select v_ticket.id, v_dest.slug, v_dest.project_code, v_new_number;
end;
$$;

revoke all on function public.move_ticket_to_project(uuid, uuid, uuid) from public;
grant execute on function public.move_ticket_to_project(uuid, uuid, uuid) to authenticated;
