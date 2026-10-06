-- JIR-118 — import tickets from an external tracker's export (JIRA CSV
-- today) into an existing project as normal, native JIRITA tickets.
--
-- Scope: TICKETS ONLY. Nothing here reads, creates, updates or deletes
-- ticket_time_entries — hours are logged afterwards through the normal
-- Time Tracking flow, and a repeated import of the same issue can never
-- touch them (there is no statement against that table in this file).
--
-- Identity: (project_id, external_source, external_id). For JIRA,
-- external_id is the numeric "Issue id" — never the "Issue key", which
-- changes when JIRA moves an issue between projects. external_key keeps
-- the current key for display only.
--
-- Not reusing tickets.unfuddle_id: that column is globally unique,
-- Unfuddle-specific, and owned by the one-time historical importer and by
-- backup/restore. These three columns are additive and nullable; every
-- existing row (and every Unfuddle import path) is unaffected.

alter table public.tickets
  add column external_source text,
  add column external_id text,
  add column external_key text;

alter table public.tickets
  add constraint tickets_external_identity_complete
  check ((external_source is null) = (external_id is null));

create unique index tickets_external_identity_idx
  on public.tickets (project_id, external_source, external_id)
  where external_id is not null;

comment on column public.tickets.external_source is
  'Tracker an imported ticket came from (''jira''). Null for native tickets.';
comment on column public.tickets.external_id is
  'Stable id of the source issue in external_source (JIRA "Issue id"). Unique per project + source.';
comment on column public.tickets.external_key is
  'Current human-readable key of the source issue (JIRA "Issue key"). Display only — never identity.';

-- ── import_external_tickets ─────────────────────────────────────────────
-- One atomic call per import. Authorization is re-derived from the
-- session (same rule as the tickets_insert policy: an active org
-- Admin/Project Lead, or a member of the project) — never from anything
-- the client sends. p_rows is a JSON array of
--   { "external_id", "external_key", "title", "type" }   (type: task|bug)
--
-- A row whose identity is new creates a ticket: next free number, the
-- given closed status, assigned to the caller (the person importing —
-- never anyone named in the source file). A row whose identity already
-- exists only ever has its external_key / title / type refreshed, and
-- only when they differ (so an unchanged re-import writes nothing and
-- doesn't bump updated_at). Status, assignee, creator and every other
-- column of an existing ticket are never written — a later import by
-- someone else does not reassign it; no ticket is ever deleted.
create or replace function public.import_external_tickets(
  p_project_id uuid,
  p_source text,
  p_status_id uuid,
  p_rows jsonb
)
returns table (external_id text, ticket_id uuid, ticket_number integer, action text)
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
  v_new_id uuid;
  v_new_number integer;
  v_attempt integer;
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

  -- The same external_id twice in one payload: the last occurrence wins,
  -- deterministically (the client reports the duplicate; this just makes
  -- sure it can never become two tickets).
  for v_row in
    select distinct on (btrim(r.item ->> 'external_id'))
      btrim(r.item ->> 'external_id') as external_id,
      btrim(r.item ->> 'external_key') as external_key,
      btrim(r.item ->> 'title') as title,
      (r.item ->> 'type')::public.ticket_type as type,
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
      if v_existing.external_key is distinct from v_row.external_key
         or v_existing.title is distinct from v_row.title
         or v_existing.type is distinct from v_row.type then
        update public.tickets t
        set external_key = v_row.external_key,
            title = v_row.title,
            type = v_row.type
        where t.id = v_existing.id;
        external_id := v_row.external_id;
        ticket_id := v_existing.id;
        ticket_number := v_existing.ticket_number;
        action := 'updated';
      else
        external_id := v_row.external_id;
        ticket_id := v_existing.id;
        ticket_number := v_existing.ticket_number;
        action := 'unchanged';
      end if;
      return next;
      continue;
    end if;

    -- New ticket. Same number rule as next_ticket_number (20261003000000):
    -- past both live tickets and numbers reserved by moved tickets. A
    -- plain client createTicket() racing this is absorbed by the retry.
    v_attempt := 0;
    loop
      v_attempt := v_attempt + 1;
      select greatest(
        coalesce((select max(t.ticket_number) from public.tickets t where t.project_id = v_project.id), 0),
        coalesce((select max(a.ticket_number) from public.ticket_route_aliases a where a.project_id = v_project.id), 0)
      ) + 1 into v_new_number;
      begin
        insert into public.tickets (
          project_id, ticket_number, title, type, status_id, assignee_profile_id,
          created_by, external_source, external_id, external_key
        )
        values (
          v_project.id, v_new_number, v_row.title, v_row.type, v_status.id, v_actor,
          v_actor, p_source, v_row.external_id, v_row.external_key
        )
        returning id into v_new_id;
        exit;
      exception when unique_violation then
        if v_attempt >= 5 then
          raise exception 'import_tickets:number_conflict';
        end if;
      end;
    end loop;

    external_id := v_row.external_id;
    ticket_id := v_new_id;
    ticket_number := v_new_number;
    action := 'created';
    return next;
  end loop;
end;
$$;

revoke all on function public.import_external_tickets(uuid, text, uuid, jsonb) from public;
revoke all on function public.import_external_tickets(uuid, text, uuid, jsonb) from anon;
grant execute on function public.import_external_tickets(uuid, text, uuid, jsonb) to authenticated;
