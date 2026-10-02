-- JIR-116 — Move one ticket to another project, atomically.
--
-- A move is an UPDATE of the same tickets row (same id), never a copy:
-- comments, replies, reactions, attachments (Storage keys are
-- `<ticket_id>/…`, and attachment access resolves the project through the
-- ticket at request time), time entries (logged_by/minutes untouched),
-- subscribers, and activity all stay attached by ticket_id. Everything
-- project-derived (reports, Work History, Hours Report) follows the ticket
-- to its new project automatically.
--
-- One security-definer function, one transaction: authorization, the new
-- ticket number, status, assignee, and the audit row either all happen or
-- none do. Authorization is derived here from auth.uid() — never from
-- anything the client sends besides the two ids:
--   - Admin (active org membership, role 'admin'): any non-archived
--     destination in the ticket's own organization.
--   - Project Lead (active org membership, role 'project_lead'): only when
--     they lead (project_memberships.project_role = 'lead') BOTH the source
--     and the destination project.
--   - Anyone else: rejected.
--
-- V1 restrictions (enforced here, not just in the UI): a ticket with a
-- parent, with child tickets, or with related-ticket links can't be moved —
-- moving it would create cross-project hierarchy/relations, which JIRITA
-- doesn't support (both are same-project-only at creation).
--
-- Numbering: same invariant ticket creation relies on — the next number
-- is max(ticket_number) + 1 within the destination project, and
-- unique (project_id, ticket_number) is the hard guarantee. The destination
-- project row is locked first, so concurrent moves into the same project
-- serialize; a concurrent ticket *creation* (which doesn't take that lock)
-- can still race, so a unique violation is retried with a freshly computed
-- number instead of failing the move.
--
-- Status: per-project statuses share a semantic key, legacy_enum_value
-- (unique per project). The source status's legacy value is mapped to the
-- destination status with the same value; a custom status (no legacy
-- value) or one the destination doesn't have falls back to the
-- destination's is_default status. Never matched by display name.
--
-- Assignee: kept only if they're a member of the destination project
-- (same project_memberships rule createTicket enforces); otherwise the
-- ticket becomes unassigned. Memberships are never added or changed for
-- the assignee. (As with any ticket update, the existing
-- tickets_ensure_membership_on_update trigger records the acting user as a
-- contributor of the destination project.)
--
-- Sprint: sprints belong to a project, so sprint_id is cleared (the ticket
-- lands in the destination's backlog). last_open_status_id is reset so it
-- never points at a source-project status.
--
-- Audit: status/assignee changes are logged by the existing
-- log_ticket_field_changes trigger; the move itself is one 'ticket_moved'
-- ticket_activity row: old_value/new_value hold "<Project> (<CODE-N>)" as
-- of the move, payload holds the ids/numbers.
--
-- Errors are raised with stable message keys (P0001) the client maps to
-- user-facing copy, never raw SQL.

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

  -- Lock the ticket first: a concurrent move/edit of the same ticket waits.
  select * into v_ticket from public.tickets t where t.id = p_ticket_id for update;
  if not found then
    raise exception 'move_ticket:ticket_not_found';
  end if;

  if p_expected_source_project_id is not null and v_ticket.project_id <> p_expected_source_project_id then
    raise exception 'move_ticket:ticket_changed';
  end if;

  select * into v_source from public.projects p where p.id = v_ticket.project_id;

  -- The caller's own role in the ticket's organization — an unauthorized
  -- caller learns nothing about the destination.
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

  -- Locking the destination row serializes concurrent moves into it.
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

  loop
    v_attempt := v_attempt + 1;
    select coalesce(max(t.ticket_number), 0) + 1 into v_new_number
    from public.tickets t where t.project_id = v_dest.id;

    begin
      update public.tickets t
      set project_id = v_dest.id,
          ticket_number = v_new_number,
          status_id = v_new_status_id,
          assignee_profile_id = v_new_assignee,
          sprint_id = null,
          -- tickets_track_last_open_status sets it again when the new
          -- status is open; a closed one leaves it null rather than
          -- pointing at a source-project status.
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
