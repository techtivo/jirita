-- JIR-118 (extension) — the import can also log time, typed by hand in the
-- import preview, on each imported/reused ticket.
--
-- The hours never come from the CSV: each row of p_rows may carry an
-- optional "minutes" (a whole number, what the user typed converted by
-- the client). A row with minutes > 0 gets ONE new, ordinary
-- ticket_time_entries row — same table, same columns, same triggers
-- (ticket_time_entries_log_activity, _ensure_membership, _block_on_parent)
-- as the normal "Log Time" flow (logTicketTime, src/lib/tickets.ts):
--   logged_by = the caller (never anyone named in the source file),
--   work_date = p_work_date — the caller's own local "today", exactly
--               what Log Time's date field defaults to (getTodayISO),
--   comment   = null.
-- Nothing is aggregated or written onto the ticket itself.
--
-- A repeated import is a new logging action: entering hours again for a
-- ticket that already exists ADDS another entry. Existing entries are
-- never read, updated or deleted here — there is no UPDATE/DELETE against
-- ticket_time_entries in this file, and deliberately no deduplication by
-- issue, hours or date.
--
-- Everything else about import_external_tickets (20261006000000) is
-- unchanged: authorization, status validation, identity, numbering, the
-- importer as assignee of NEW tickets only, and one transaction for the
-- whole call — so tickets and their time entries are created together or
-- not at all.
--
-- The function is dropped and recreated (not replaced) because its result
-- gains a column, logged_minutes. Both changes are backward compatible
-- with a client that predates this migration: p_work_date is optional and
-- rows without "minutes" behave exactly as before.

drop function public.import_external_tickets(uuid, text, uuid, jsonb);

create function public.import_external_tickets(
  p_project_id uuid,
  p_source text,
  p_status_id uuid,
  p_rows jsonb,
  p_work_date date default null
)
returns table (external_id text, ticket_id uuid, ticket_number integer, action text, logged_minutes integer)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_actor uuid := auth.uid();
  v_project public.projects%rowtype;
  v_status public.ticket_statuses%rowtype;
  v_row record;
  v_existing public.tickets%rowtype;
  v_ticket_id uuid;
  v_ticket_number integer;
  v_action text;
  v_attempt integer;
  v_today date := (now() at time zone 'utc')::date;
begin
  if v_actor is null then
    raise exception 'import_tickets:not_authorized';
  end if;

  -- Locking the project row serializes concurrent imports into the same
  -- project, so two of them can never both decide an issue is "new".
  select * into v_project from public.projects p where p.id = p_project_id for update;
  if not found then
    raise exception 'import_tickets:project_not_found';
  end if;

  if not public.is_org_member(v_project.organization_id)
     or not (public.is_org_admin_or_lead(v_project.organization_id) or public.is_project_member(v_project.id)) then
    raise exception 'import_tickets:not_authorized';
  end if;

  if v_project.status = 'archived' then
    raise exception 'import_tickets:project_archived';
  end if;

  if p_source is distinct from 'jira' then
    raise exception 'import_tickets:unsupported_source';
  end if;

  select * into v_status from public.ticket_statuses s where s.id = p_status_id;
  if not found or v_status.project_id <> v_project.id then
    raise exception 'import_tickets:status_not_in_project';
  end if;
  if v_status.group_type <> 'closed' then
    raise exception 'import_tickets:status_not_closed';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'import_tickets:invalid_rows';
  end if;
  if jsonb_array_length(p_rows) > 2000 then
    raise exception 'import_tickets:too_many_rows';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_rows) as r(item)
    where jsonb_typeof(r.item) <> 'object'
       or coalesce(btrim(r.item ->> 'external_id'), '') = ''
       or coalesce(btrim(r.item ->> 'external_key'), '') = ''
       or coalesce(btrim(r.item ->> 'title'), '') = ''
       or coalesce(r.item ->> 'type', '') not in ('task', 'bug')
  ) then
    raise exception 'import_tickets:invalid_rows';
  end if;

  -- "minutes" is optional (absent/null = no time). When present it must be
  -- a whole, non-negative number of minutes — never a fraction this
  -- function would have to round. No business maximum, same as Log Time
  -- (ticket_time_entries only requires minutes > 0); the 9-digit bound is
  -- purely so the value always fits the integer column.
  if exists (
    select 1
    from jsonb_array_elements(p_rows) as r(item)
    where jsonb_typeof(r.item -> 'minutes') is not null
      and jsonb_typeof(r.item -> 'minutes') <> 'null'
      and (
        jsonb_typeof(r.item -> 'minutes') <> 'number'
        or (r.item ->> 'minutes') !~ '^[0-9]{1,9}$'
      )
  ) then
    raise exception 'import_tickets:invalid_minutes';
  end if;

  -- The work date only matters when some row actually logs time. It is the
  -- caller's local "today"; one day either side of the server's own (UTC)
  -- date covers every timezone without accepting an arbitrary date.
  if exists (
    select 1 from jsonb_array_elements(p_rows) as r(item)
    where coalesce((r.item ->> 'minutes')::integer, 0) > 0
  ) and (p_work_date is null or p_work_date < v_today - 1 or p_work_date > v_today + 1) then
    raise exception 'import_tickets:invalid_work_date';
  end if;

  -- The same external_id twice in one payload: the last occurrence wins,
  -- deterministically — for its fields and for its minutes alike.
  for v_row in
    select distinct on (btrim(r.item ->> 'external_id'))
      btrim(r.item ->> 'external_id') as external_id,
      btrim(r.item ->> 'external_key') as external_key,
      btrim(r.item ->> 'title') as title,
      (r.item ->> 'type')::public.ticket_type as type,
      coalesce((r.item ->> 'minutes')::integer, 0) as minutes,
      r.ord
    from jsonb_array_elements(p_rows) with ordinality as r(item, ord)
    order by btrim(r.item ->> 'external_id'), r.ord desc
  loop
    select * into v_existing
    from public.tickets t
    where t.project_id = v_project.id
      and t.external_source = p_source
      and t.external_id = v_row.external_id
    for update;

    if found then
      v_ticket_id := v_existing.id;
      v_ticket_number := v_existing.ticket_number;
      if v_existing.external_key is distinct from v_row.external_key
         or v_existing.title is distinct from v_row.title
         or v_existing.type is distinct from v_row.type then
        update public.tickets t
        set external_key = v_row.external_key,
            title = v_row.title,
            type = v_row.type
        where t.id = v_existing.id;
        v_action := 'updated';
      else
        v_action := 'unchanged';
      end if;
    else
      -- New ticket. Same number rule as next_ticket_number (20261003000000):
      -- past both live tickets and numbers reserved by moved tickets. A
      -- plain client createTicket() racing this is absorbed by the retry.
      v_attempt := 0;
      loop
        v_attempt := v_attempt + 1;
        select greatest(
          coalesce((select max(t.ticket_number) from public.tickets t where t.project_id = v_project.id), 0),
          coalesce((select max(a.ticket_number) from public.ticket_route_aliases a where a.project_id = v_project.id), 0)
        ) + 1 into v_ticket_number;
        begin
          insert into public.tickets (
            project_id, ticket_number, title, type, status_id, assignee_profile_id,
            created_by, external_source, external_id, external_key
          )
          values (
            v_project.id, v_ticket_number, v_row.title, v_row.type, v_status.id, v_actor,
            v_actor, p_source, v_row.external_id, v_row.external_key
          )
          returning id into v_ticket_id;
          exit;
        exception when unique_violation then
          if v_attempt >= 5 then
            raise exception 'import_tickets:number_conflict';
          end if;
        end;
      end loop;
      v_action := 'created';
    end if;

    if v_row.minutes > 0 then
      -- Same rule ticket_time_entries_block_on_parent enforces for Log
      -- Time, surfaced here with this function's own error code so the
      -- whole import fails with a readable reason.
      if exists (select 1 from public.tickets c where c.parent_ticket_id = v_ticket_id) then
        raise exception 'import_tickets:time_on_parent_ticket';
      end if;
      insert into public.ticket_time_entries (ticket_id, logged_by, minutes, work_date, comment)
      values (v_ticket_id, v_actor, v_row.minutes, p_work_date, null);
    end if;

    external_id := v_row.external_id;
    ticket_id := v_ticket_id;
    ticket_number := v_ticket_number;
    action := v_action;
    logged_minutes := v_row.minutes;
    return next;
  end loop;
end;
$$;

revoke all on function public.import_external_tickets(uuid, text, uuid, jsonb, date) from public;
revoke all on function public.import_external_tickets(uuid, text, uuid, jsonb, date) from anon;
grant execute on function public.import_external_tickets(uuid, text, uuid, jsonb, date) to authenticated;
