// Loads real Tickets for a single project — the replacement data source
// for src/lib/mock-tickets.ts on the /projects/[slug]/tickets page's five
// views (List/Board/Calendar/Timeline/Insights) only. Ticket creation,
// editing, comments, attachments, time tracking, and activity are all out
// of scope here and keep working exactly as they do today (mock/local,
// unconnected) — see tickets-screen.tsx and ticket-detail-screen.tsx.
//
// RLS on `tickets` (tickets_select) already scopes rows to whoever can see
// the parent project, so no client-side role filtering is needed — the
// query just returns whatever the signed-in user is allowed to see for
// this one project.

import { getSupabaseBrowserClient } from "./supabase-client";
import { resolveAvatarUrl } from "./membership";
import { FALLBACK_AVATAR } from "./current-user";
import { registerProjectCode } from "./mock-tickets";
import type { Ticket, TicketPriority, TicketStatus, TicketType } from "./mock-tickets";
import { loadOrganizationProjects, projectStatusFromDb } from "./projects";
import type { ProjectStatus } from "./mock-projects";
import { formatAbsoluteDate, formatAbsoluteDateTime } from "./date-format";
import { createNotification } from "./notifications";
import { generateAttachmentThumbnail } from "./attachment-thumbnail";
import { attachmentPathsToRemove, findUnremovedPaths } from "./attachment-storage-remove";
import { loadProjectSprints, type Sprint } from "./sprints";
// Plain, browser-only DOMPurify — same package/reasoning as
// components/rich-text/rich-text-utils.ts (never "isomorphic-dompurify").
// This module already only ever runs client-side (every function here
// goes through getSupabaseBrowserClient), so using it — and the browser's
// own DOMParser below — directly here is safe.
import DOMPurify from "dompurify";

export type TicketsResult =
  | {
      status: "ready";
      tickets: Ticket[];
      statuses: TicketStatusOption[];
      /** Real projects.id (Sprint MVP) — the internal uuid loadProjectTickets
       *  already resolves from `slug` for its own tickets/statuses queries
       *  below, surfaced here so a caller can load this project's sprints
       *  without a second slug->id lookup of its own. Single-project mode
       *  only — never set by loadOrganizationTickets. */
      projectId: string;
    }
  | { status: "not-found" }
  | { status: "error"; message: string };

export interface CreateTicketInput {
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  hours?: number;
  assigneeProfileId?: string;
  /** Real ticket_statuses.id (Fase 2) — the preferred way to set a new
   *  ticket's status; when omitted, createTicket resolves the project's own
   *  is_default open status instead of a hardcoded "backlog". `status`
   *  below is accepted only as a legacy fallback and ignored whenever
   *  `statusId` is also given. */
  statusId?: string;
  status?: TicketStatus;
  type?: TicketType;
  priority?: TicketPriority;
  labels?: string[];
  /** ISO date (yyyy-mm-dd). */
  dueDate?: string;
  /** "Create a child" (Ticket Detail's Children section) reuses this exact
   *  creation flow with this one extra field — the new tickets_guard_
   *  parent_hierarchy trigger (20260927000000) is the real enforcement of
   *  same-project/one-level-only, this is just where the value is threaded
   *  through. */
  parentTicketId?: string;
  /** Real tickets.sprint_id (Sprint MVP) — set to a real sprints.id to
   *  create the ticket directly into that sprint, or omit/null to leave it
   *  in the general backlog (the column's own default). Lets a Sprint-
   *  filtered Board/List context preselect its sprint on the New Ticket
   *  form without changing the default for any other entry point. */
  sprintId?: string | null;
}

export type CreateTicketResult =
  | { status: "success"; ticket: Ticket }
  | { status: "error"; message: string };

// Exported for reuse wherever a raw DB status string (snake_case, e.g. the
// old_value/new_value ticket_activity stores for status_changed) needs to
// become the app's own display-domain TicketStatus (hyphenated) — e.g.
// Admin Reports' Recent Changes.
export const STATUS_FROM_DB: Record<string, TicketStatus> = {
  backlog: "backlog",
  to_do: "to-do",
  in_progress: "in-progress",
  review: "review",
  blocked: "blocked",
  done: "done",
};

// Open/closed (Fase 2.5) — the one correct, shared source for "is this
// ticket open or closed" across the whole app, real ticket_statuses.
// group_type, never the literal `status === "done"` enum comparison
// (which breaks the moment a project has a custom closed status with no
// legacy equivalent, or renames/reorders its statuses). Falls back to the
// legacy literal only for mock/dev-fallback tickets, which never populate
// statusGroupType. Never use this for a SPECIFIC comparison like
// "blocked"/"in_review" — those intentionally keep reading `t.status`
// (or, going forward, a status's own legacy_enum_value) directly.
export function isTicketClosed(t: Pick<Ticket, "status" | "statusGroupType">): boolean {
  return t.statusGroupType ? t.statusGroupType === "closed" : t.status === "done";
}

const PRIORITY_VALUES: TicketPriority[] = ["highest", "high", "medium", "low"];

const TYPE_FROM_DB: Record<string, TicketType> = {
  task: "TASK",
  bug: "BUG",
};

// Inverse of STATUS_FROM_DB / TYPE_FROM_DB — used when writing an inline
// edit back to Supabase. Priority needs no map: the enum values already
// match the DB exactly (high/normal/low).
const STATUS_TO_DB: Record<TicketStatus, string> = {
  backlog: "backlog",
  "to-do": "to_do",
  "in-progress": "in_progress",
  review: "review",
  blocked: "blocked",
  done: "done",
};

const TYPE_TO_DB: Record<TicketType, string> = {
  TASK: "task",
  BUG: "bug",
};

interface ProjectLookupRow {
  id: string;
  project_code: string;
}

interface TicketRow {
  id: string;
  project_id: string;
  ticket_number: number;
  title: string;
  description: string | null;
  status: string;
  status_id: string;
  priority: string;
  type: string;
  assignee_profile_id: string | null;
  milestone: string | null;
  labels: string[] | null;
  acceptance_criteria: string[] | null;
  acceptance_criteria_done: boolean[] | null;
  story_points: number | null;
  // PostgREST/Supabase serializes `numeric` columns as strings (to avoid
  // JS floating-point precision loss) — unlike `integer` columns like
  // ticket_number/story_points above, which come back as real numbers.
  // Coerced with Number(...) in rowToTicket below; left un-coerced here so
  // the type matches what the wire actually sends.
  hours: string | null;
  due_date: string | null;
  updated_at: string;
  created_by: string | null;
  created_at: string;
  parent_ticket_id: string | null;
  sprint_id: string | null;
}

// ── Per-project configurable ticket statuses (Fase 2) ──────────────────────
// `ticket_statuses` (20260830000000 / 20260918000000) is the one real,
// per-project status catalog — every project has exactly 6 rows today
// (Backlog/To Do[default]/In Progress/Blocked/In Review/Done), ordered by
// sort_order. Fetched as a flat, separate query (never an embedded
// `tickets.select("...,ticket_statuses(...)")`) for the same reason
// assignee profiles already are throughout this file: PostgREST's FK
// relationship cache can lag behind a hand-applied migration, and
// tickets.status_id -> ticket_statuses.id is exactly that — a brand new FK.
export interface TicketStatusOption {
  id: string;
  name: string;
  sortOrder: number;
  groupType: "open" | "closed";
  isDefault: boolean;
  /** The legacy `ticket_status` enum value this status corresponds to.
   *  Every status seeded so far has one (this phase builds no status-
   *  creation UI); only ever null for a hypothetical future custom status
   *  with no legacy equivalent. */
  legacyEnumValue: string | null;
}

interface TicketStatusRow {
  id: string;
  name: string;
  sort_order: number;
  group_type: string;
  is_default: boolean;
  legacy_enum_value: string | null;
}

function rowToTicketStatusOption(row: TicketStatusRow): TicketStatusOption {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order,
    groupType: row.group_type === "closed" ? "closed" : "open",
    isDefault: row.is_default,
    legacyEnumValue: row.legacy_enum_value,
  };
}

export type TicketStatusesResult =
  | { status: "ready"; statuses: TicketStatusOption[] }
  | { status: "error"; message: string };

// The same 6 legacy-linked statuses every project is seeded with — the one
// shared fallback used wherever a real per-project list hasn't loaded yet
// (or, for a mock/dev-fallback ticket, never will). Never shown as an
// error state: visually identical to a real project's own 6 rows today, so
// callers can render this during that window without anything appearing
// to flicker once the real list arrives.
export const FALLBACK_TICKET_STATUSES: TicketStatusOption[] = [
  { id: "backlog", name: "Backlog", sortOrder: 1, groupType: "open", isDefault: false, legacyEnumValue: "backlog" },
  { id: "to_do", name: "To Do", sortOrder: 2, groupType: "open", isDefault: true, legacyEnumValue: "to_do" },
  { id: "in_progress", name: "In Progress", sortOrder: 3, groupType: "open", isDefault: false, legacyEnumValue: "in_progress" },
  { id: "blocked", name: "Blocked", sortOrder: 4, groupType: "open", isDefault: false, legacyEnumValue: "blocked" },
  { id: "review", name: "In Review", sortOrder: 5, groupType: "open", isDefault: false, legacyEnumValue: "review" },
  { id: "done", name: "Done", sortOrder: 6, groupType: "closed", isDefault: false, legacyEnumValue: "done" },
];

// Real, ordered status catalog for one project — the source Board columns,
// the status selector (New Ticket / Ticket Detail / Ticket Preview), and
// the Status filter are all built from, instead of the old fixed 6-value
// enum. Every caller here already has a resolved project id (never a slug)
// since they all sit downstream of loadProjectTickets/loadTicketByCode.
export async function loadProjectTicketStatuses(projectId: string): Promise<TicketStatusesResult> {
  const supabase = getSupabaseBrowserClient();

  const { data, error } = await supabase
    .from("ticket_statuses")
    .select("id, name, sort_order, group_type, is_default, legacy_enum_value")
    .eq("project_id", projectId)
    .order("sort_order", { ascending: true })
    .returns<TicketStatusRow[]>();

  if (error) {
    logDev("ticket statuses query failed", error);
    return { status: "error", message: error.message };
  }

  return { status: "ready", statuses: (data ?? []).map(rowToTicketStatusOption) };
}

// ── Fase 3: Project Settings → Statuses management ─────────────────────────
// Create/rename are plain RLS-gated writes (ticket_statuses_insert/_update,
// 20260920000000 — any org-wide Admin or Project Lead, same trust level
// projects_update/tickets_insert already grant). Set default / change
// group / reorder each touch more than one row's invariant-bearing column
// at once, so each goes through its own SECURITY DEFINER RPC instead —
// same shape update_own_weekly_capacity/restore_project_phase1 already
// use in this schema. Delete is a plain RLS-gated delete; the real safety
// rules (no tickets attached, never the default, never the last status in
// its own group) live in a BEFORE DELETE trigger
// (ticket_statuses_block_unsafe_delete), so its own error message is
// already a clear, non-technical sentence — passed through as-is, same
// convention removeProjectMember already uses for its own
// trigger-blocked-delete case.
//
// Every one of these re-fetches and returns the project's full, fresh
// ordered list on success, so a caller can just replace its local state
// wholesale rather than hand-patching one row — the list is always small
// (today: 6-ish rows per project), so this is never a real cost.

export type TicketStatusMutationResult =
  | { status: "success"; statuses: TicketStatusOption[] }
  | { status: "error"; message: string };

async function reloadTicketStatusesAfterMutation(projectId: string): Promise<TicketStatusMutationResult> {
  const result = await loadProjectTicketStatuses(projectId);
  if (result.status === "error") return result;
  return { status: "success", statuses: result.statuses };
}

export async function createTicketStatus(
  projectId: string,
  name: string,
  groupType: "open" | "closed"
): Promise<TicketStatusMutationResult> {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { status: "error", message: "Status name can't be empty." };
  }

  const supabase = getSupabaseBrowserClient();

  const { data: lastStatus, error: lastStatusError } = await supabase
    .from("ticket_statuses")
    .select("sort_order")
    .eq("project_id", projectId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle<{ sort_order: number }>();

  if (lastStatusError) {
    logDev("ticket status sort_order lookup failed", lastStatusError);
    return { status: "error", message: lastStatusError.message };
  }

  const { error } = await supabase.from("ticket_statuses").insert({
    project_id: projectId,
    name: trimmed,
    sort_order: (lastStatus?.sort_order ?? 0) + 1,
    group_type: groupType,
  });

  if (error) {
    logDev("ticket status creation failed", error);
    // 23505 = unique_violation on (project_id, lower(trim(name))) — same
    // case-insensitive duplicate-prevention convention as labels.
    if (error.code === "23505") {
      return { status: "error", message: "A status with this name already exists." };
    }
    return { status: "error", message: error.message };
  }

  return reloadTicketStatusesAfterMutation(projectId);
}

export async function renameTicketStatus(
  statusId: string,
  projectId: string,
  name: string
): Promise<TicketStatusMutationResult> {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { status: "error", message: "Status name can't be empty." };
  }

  const supabase = getSupabaseBrowserClient();

  const { error } = await supabase
    .from("ticket_statuses")
    .update({ name: trimmed })
    .eq("id", statusId);

  if (error) {
    logDev("ticket status rename failed", error);
    if (error.code === "23505") {
      return { status: "error", message: "A status with this name already exists." };
    }
    return { status: "error", message: error.message };
  }

  return reloadTicketStatusesAfterMutation(projectId);
}

export async function setDefaultTicketStatus(
  statusId: string,
  projectId: string
): Promise<TicketStatusMutationResult> {
  const supabase = getSupabaseBrowserClient();

  const { error } = await supabase.rpc("set_default_ticket_status", { p_status_id: statusId });

  if (error) {
    logDev("set default ticket status failed", error);
    return { status: "error", message: error.message };
  }

  return reloadTicketStatusesAfterMutation(projectId);
}

// `newDefaultStatusId` is required by the RPC itself (change_ticket_status_group,
// 20260920000000) only when moving the current default open status to
// closed — every other open<->closed change ignores it. The UI only needs
// to supply it in that one case (see the Statuses section's own "choose a
// replacement default" prompt).
export async function changeTicketStatusGroup(
  statusId: string,
  projectId: string,
  newGroupType: "open" | "closed",
  newDefaultStatusId?: string
): Promise<TicketStatusMutationResult> {
  const supabase = getSupabaseBrowserClient();

  const { error } = await supabase.rpc("change_ticket_status_group", {
    p_status_id: statusId,
    p_new_group_type: newGroupType,
    p_new_default_status_id: newDefaultStatusId ?? null,
  });

  if (error) {
    logDev("change ticket status group failed", error);
    return { status: "error", message: error.message };
  }

  return reloadTicketStatusesAfterMutation(projectId);
}

export async function reorderTicketStatuses(
  projectId: string,
  groupType: "open" | "closed",
  orderedIds: string[]
): Promise<TicketStatusMutationResult> {
  const supabase = getSupabaseBrowserClient();

  const { error } = await supabase.rpc("reorder_ticket_statuses", {
    p_project_id: projectId,
    p_group_type: groupType,
    p_ordered_ids: orderedIds,
  });

  if (error) {
    logDev("reorder ticket statuses failed", error);
    return { status: "error", message: error.message };
  }

  return reloadTicketStatusesAfterMutation(projectId);
}

export async function deleteTicketStatus(
  statusId: string,
  projectId: string
): Promise<TicketStatusMutationResult> {
  const supabase = getSupabaseBrowserClient();

  const { error } = await supabase.from("ticket_statuses").delete().eq("id", statusId);

  if (error) {
    logDev("ticket status delete failed", error);
    // Includes the ticket_statuses_block_unsafe_delete trigger's own
    // raised message when this deletion is actually blocked (tickets still
    // assigned, is the default, or the last status in its own group) —
    // surfaced as-is, same convention removeProjectMember already uses.
    return { status: "error", message: error.message };
  }

  return reloadTicketStatusesAfterMutation(projectId);
}

interface AssigneeProfileRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  avatar_url: string | null;
  updated_at: string;
}

const TICKET_COLUMNS =
  "id, project_id, ticket_number, title, description, status, status_id, priority, type, assignee_profile_id, milestone, labels, acceptance_criteria, acceptance_criteria_done, story_points, hours, due_date, updated_at, created_by, created_at, parent_ticket_id, sprint_id";

// Absolute, year-inclusive date — every date-parsing helper across the
// ticket views (Calendar/Timeline/Insights) parses this exact "MMM D, YYYY"
// shape back to ISO, so it must stay byte-for-byte the same as
// formatAbsoluteDate's output.
function formatDueDate(isoDate: string | null): string | undefined {
  if (!isoDate) return undefined;
  return formatAbsoluteDate(isoDate);
}

// Absolute date+time, plus the "Updated " prefix every ticket string already
// carries — board-column.tsx's "last activity" subtitle strips that exact
// prefix back off (`.replace("Updated ", "")`), so the prefix has to be
// there verbatim. Named/kept as "UpdatedAt" rather than renamed to avoid
// touching its many call sites; it no longer computes a relative diff.
function formatTicketUpdatedAt(isoTimestamp: string): string {
  return `Updated ${formatAbsoluteDateTime(isoTimestamp)}`;
}

// Absolute date+time, minus the "Updated " prefix — used for
// Comments/Activity (Ticket Detail, Ticket Preview Drawer, Activity Log,
// notifications) which render their own leading text ("· Jul 30, 2026 at
// 7:42 AM") instead of that prefix. Kept its original (now misleading) name
// to avoid churning its many import sites.
export function formatRelativeTime(isoTimestamp: string): string {
  return formatTicketUpdatedAt(isoTimestamp).replace(/^Updated /, "");
}

function logDev(...args: unknown[]): void {
  if (process.env.NODE_ENV !== "production") console.warn("[tickets]", ...args);
}

function rowToTicket(
  row: TicketRow,
  projectSlug: string,
  assigneeRow: AssigneeProfileRow | undefined,
  creatorRow?: AssigneeProfileRow,
  statusesById?: Map<string, TicketStatusOption>
): Ticket {
  const assigneeName = assigneeRow
    ? [assigneeRow.first_name, assigneeRow.last_name].filter(Boolean).join(" ") || "Unnamed"
    : "Unassigned";

  const statusOption = statusesById?.get(row.status_id);

  return {
    id: row.id,
    projectSlug,
    ticketNumber: row.ticket_number,
    title: row.title,
    description: row.description ?? "",
    status: STATUS_FROM_DB[row.status] ?? "backlog",
    statusId: row.status_id,
    statusName: statusOption?.name,
    statusGroupType: statusOption?.groupType,
    priority: PRIORITY_VALUES.includes(row.priority as TicketPriority) ? (row.priority as TicketPriority) : "medium",
    type: TYPE_FROM_DB[row.type] ?? "TASK",
    assignee: {
      name: assigneeName,
      avatar: (assigneeRow ? resolveAvatarUrl(assigneeRow.avatar_url, assigneeRow.updated_at) : null) ?? FALLBACK_AVATAR,
    },
    assigneeProfileId: row.assignee_profile_id,
    milestone: row.milestone ?? "No Milestone",
    labels: row.labels ?? [],
    acceptanceCriteria: row.acceptance_criteria && row.acceptance_criteria.length > 0 ? row.acceptance_criteria : undefined,
    acceptanceCriteriaDone: row.acceptance_criteria_done ?? [],
    storyPoints: row.story_points ?? undefined,
    hours: row.hours !== null ? Number(row.hours) : undefined,
    dueDate: formatDueDate(row.due_date),
    updatedAt: formatTicketUpdatedAt(row.updated_at),
    updatedAtISO: row.updated_at,
    createdByProfileId: row.created_by,
    createdAtISO: row.created_at,
    parentTicketId: row.parent_ticket_id,
    sprintId: row.sprint_id,
    creator: creatorRow
      ? {
          name: [creatorRow.first_name, creatorRow.last_name].filter(Boolean).join(" ") || "Unnamed",
          avatar: resolveAvatarUrl(creatorRow.avatar_url, creatorRow.updated_at) ?? FALLBACK_AVATAR,
        }
      : undefined,
  };
}

// Scoped to exactly one project (by slug, within the signed-in user's
// organization) — never the whole workspace, per this feature's scope.
export async function loadProjectTickets(organizationId: string, slug: string): Promise<TicketsResult> {
  const supabase = getSupabaseBrowserClient();

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id, project_code")
    .eq("organization_id", organizationId)
    .eq("slug", slug)
    .maybeSingle<ProjectLookupRow>();

  if (projectError) {
    logDev("project lookup for tickets failed", projectError);
    return { status: "error", message: projectError.message };
  }
  if (!project) return { status: "not-found" };

  registerProjectCode(slug, project.project_code);

  const { data: rows, error } = await supabase
    .from("tickets")
    .select(TICKET_COLUMNS)
    .eq("project_id", project.id)
    .order("ticket_number", { ascending: true })
    .returns<TicketRow[]>();

  if (error) {
    logDev("tickets query failed", error);
    return { status: "error", message: error.message };
  }

  const assigneeIds = Array.from(
    new Set((rows ?? []).map((row) => row.assignee_profile_id).filter((id): id is string => Boolean(id)))
  );

  // Flat second query instead of an embedded select — same reasoning as
  // loadOrganizationProjects in lib/projects.ts: avoids depending on
  // PostgREST's FK relationship cache picking up a hand-applied migration.
  const assigneesById = new Map<string, AssigneeProfileRow>();
  if (assigneeIds.length > 0) {
    const { data: assigneeRows, error: assigneeError } = await supabase
      .from("profiles")
      .select("id, first_name, last_name, avatar_url, updated_at")
      .in("id", assigneeIds)
      .returns<AssigneeProfileRow[]>();

    if (assigneeError) {
      logDev("assignee profiles query failed", assigneeError);
    } else {
      for (const assigneeRow of assigneeRows ?? []) assigneesById.set(assigneeRow.id, assigneeRow);
    }
  }

  const { list: statuses, byId: statusesById } = await loadProjectTicketStatusesData(supabase, project.id);

  const tickets: Ticket[] = (rows ?? []).map((row) =>
    rowToTicket(row, slug, row.assignee_profile_id ? assigneesById.get(row.assignee_profile_id) : undefined, undefined, statusesById)
  );

  return { status: "ready", tickets, statuses, projectId: project.id };
}

// Shared by loadProjectTickets/loadTicketByCode — same flat-query,
// keyed-by-id shape as the assignee profile maps above.
async function loadProjectTicketStatusesData(
  supabase: ReturnType<typeof getSupabaseBrowserClient>,
  projectId: string
): Promise<{ list: TicketStatusOption[]; byId: Map<string, TicketStatusOption> }> {
  const { data, error } = await supabase
    .from("ticket_statuses")
    .select("id, name, sort_order, group_type, is_default, legacy_enum_value")
    .eq("project_id", projectId)
    .order("sort_order", { ascending: true })
    .returns<TicketStatusRow[]>();

  if (error) {
    logDev("ticket statuses query failed", error);
    return { list: [], byId: new Map() };
  }

  const list = (data ?? []).map(rowToTicketStatusOption);
  return { list, byId: new Map(list.map((option) => [option.id, option])) };
}

export type TicketByCodeResult =
  | {
      status: "ready";
      ticket: Ticket;
      statuses: TicketStatusOption[];
      /** This project's real sprints (every status — Ticket Detail's own
       *  Sprint field needs the closed ones too, to display/lock a ticket
       *  already stuck in one, e.g. Sprint 0). Loaded in the same call as
       *  the ticket itself, same "bundled, not a separate race-prone fetch"
       *  convention `statuses` above already established. */
      sprints: Sprint[];
    }
  | { status: "not-found" }
  | { status: "error"; message: string };

// Loads a single ticket for the Ticket Detail page, resolved by its visible
// ticket code (e.g. "JIR-1") within one project — never by the internal
// uuid, which stays a database-only identifier and is never exposed in a
// ticket URL. The code is "<project_code>-<ticket_number>" (see
// getTicketDisplayKey in mock-tickets.ts); parsed back into ticket_number
// and matched against this project's own project_code only, so a code from
// another project can never resolve here.
export async function loadTicketByCode(
  organizationId: string,
  slug: string,
  ticketCode: string
): Promise<TicketByCodeResult> {
  const supabase = getSupabaseBrowserClient();

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id, project_code")
    .eq("organization_id", organizationId)
    .eq("slug", slug)
    .maybeSingle<ProjectLookupRow>();

  if (projectError) {
    logDev("project lookup for ticket detail failed", projectError);
    return { status: "error", message: projectError.message };
  }
  if (!project) return { status: "not-found" };

  registerProjectCode(slug, project.project_code);

  const prefix = `${project.project_code}-`;
  if (!ticketCode.startsWith(prefix)) return { status: "not-found" };
  const ticketNumber = Number(ticketCode.slice(prefix.length));
  if (!Number.isInteger(ticketNumber) || ticketNumber <= 0) return { status: "not-found" };

  const { data: row, error } = await supabase
    .from("tickets")
    .select(TICKET_COLUMNS)
    .eq("project_id", project.id)
    .eq("ticket_number", ticketNumber)
    .maybeSingle<TicketRow>();

  if (error) {
    logDev("ticket lookup by code failed", error);
    return { status: "error", message: error.message };
  }
  if (!row) return { status: "not-found" };

  let assigneeRow: AssigneeProfileRow | undefined;
  if (row.assignee_profile_id) {
    const { data: profileRow, error: profileError } = await supabase
      .from("profiles")
      .select("id, first_name, last_name, avatar_url, updated_at")
      .eq("id", row.assignee_profile_id)
      .maybeSingle<AssigneeProfileRow>();
    if (profileError) {
      logDev("assignee profile lookup failed", profileError);
    } else {
      assigneeRow = profileRow ?? undefined;
    }
  }

  // Real creator ("Created by"), for Ticket Detail's sidebar only — every
  // other real ticket loader never resolves this. Reuses the assignee's
  // own already-fetched row when they're the same real person, rather than
  // a second, redundant profiles query for identical data.
  let creatorRow: AssigneeProfileRow | undefined;
  if (row.created_by) {
    if (row.created_by === row.assignee_profile_id) {
      creatorRow = assigneeRow;
    } else {
      const { data: profileRow, error: profileError } = await supabase
        .from("profiles")
        .select("id, first_name, last_name, avatar_url, updated_at")
        .eq("id", row.created_by)
        .maybeSingle<AssigneeProfileRow>();
      if (profileError) {
        logDev("creator profile lookup failed", profileError);
      } else {
        creatorRow = profileRow ?? undefined;
      }
    }
  }

  const { list: statuses, byId: statusesById } = await loadProjectTicketStatusesData(supabase, project.id);

  const sprintsResult = await loadProjectSprints(project.id);
  const sprints = sprintsResult.status === "ready" ? sprintsResult.sprints : [];

  return { status: "ready", ticket: rowToTicket(row, slug, assigneeRow, creatorRow, statusesById), statuses, sprints };
}

// Creates a ticket for the currently-open project only. Ticket Number is
// generated here (max existing number for the project + 1) since the
// `tickets` table has no auto-numbering — matches pending-tickets.ts's
// existing per-project counter design, just backed by a real query instead
// of an in-memory Map. Status/Type/Priority/Labels/Due Date are all real,
// optional inputs now, each falling back to the modal's own default
// (backlog/task/medium/no labels/no due date) only when omitted.
export async function createTicket(
  organizationId: string,
  slug: string,
  input: CreateTicketInput
): Promise<CreateTicketResult> {
  const supabase = getSupabaseBrowserClient();

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id, project_code")
    .eq("organization_id", organizationId)
    .eq("slug", slug)
    .maybeSingle<ProjectLookupRow>();

  if (projectError) {
    logDev("project lookup for ticket creation failed", projectError);
    return { status: "error", message: projectError.message };
  }
  if (!project) return { status: "error", message: "Project not found." };

  // Reject an assignee who isn't a real, active member of this project —
  // same "row exists in project_memberships" definition loadProjectTeam/
  // is_project_member already use, enforced here too since neither RLS nor
  // a DB constraint checks this (project_memberships/tickets' own FKs only
  // ever validate assignee_profile_id against profiles, not against this
  // specific project). Never auto-adds the assignee to the project — that
  // stays exclusively a Team action.
  if (input.assigneeProfileId) {
    const { data: membershipRow, error: membershipError } = await supabase
      .from("project_memberships")
      .select("id")
      .eq("project_id", project.id)
      .eq("profile_id", input.assigneeProfileId)
      .maybeSingle<{ id: string }>();
    if (membershipError) {
      logDev("assignee project membership check failed", membershipError);
      return { status: "error", message: membershipError.message };
    }
    if (!membershipRow) {
      return { status: "error", message: "This person isn't a member of this project and can't be assigned." };
    }
  }

  const { data: lastTicket, error: lastTicketError } = await supabase
    .from("tickets")
    .select("ticket_number")
    .eq("project_id", project.id)
    .order("ticket_number", { ascending: false })
    .limit(1)
    .maybeSingle<{ ticket_number: number }>();

  if (lastTicketError) {
    logDev("ticket number lookup failed", lastTicketError);
    return { status: "error", message: lastTicketError.message };
  }

  const ticketNumber = (lastTicket?.ticket_number ?? 0) + 1;
  const acceptanceCriteria =
    input.acceptanceCriteria && input.acceptanceCriteria.length > 0 ? input.acceptanceCriteria : null;

  const { byId: statusesById } = await loadProjectTicketStatusesData(supabase, project.id);

  // status_id (Fase 2.5) is the actual functional source now — written
  // directly, never derived from a legacy enum value first. The
  // tickets_sync_status_id trigger (20260919000000) mirrors it into the
  // legacy `status` column only when the target status has a
  // legacy_enum_value; a custom status (none yet possible without a
  // status-management UI, but the write path itself no longer assumes
  // one) simply leaves `status` at its column default. Prefers an
  // explicit statusId (Board/status selector); falls back to the legacy
  // `status` enum only for callers that haven't migrated (in which case
  // the trigger itself derives status_id — nothing to resolve here); and
  // otherwise defaults to the project's own is_default open status,
  // never a hardcoded "backlog".
  const insertPayload: Record<string, unknown> = {
    project_id: project.id,
    ticket_number: ticketNumber,
    title: input.title,
    description: input.description ?? null,
    priority: input.priority ?? "medium",
    type: input.type ? TYPE_TO_DB[input.type] : "task",
    // NOT NULL column — must always be an array, never null/undefined,
    // even when no labels were selected.
    labels: input.labels ?? [],
    acceptance_criteria: acceptanceCriteria,
    hours: input.hours ?? null,
    due_date: input.dueDate ?? null,
    assignee_profile_id: input.assigneeProfileId ?? null,
    parent_ticket_id: input.parentTicketId ?? null,
    sprint_id: input.sprintId ?? null,
  };

  if (input.statusId) {
    if (!statusesById.has(input.statusId)) {
      return { status: "error", message: "Invalid status for this project." };
    }
    insertPayload.status_id = input.statusId;
  } else if (input.status) {
    insertPayload.status = STATUS_TO_DB[input.status];
  } else {
    const defaultStatus = Array.from(statusesById.values()).find((option) => option.isDefault);
    if (defaultStatus) {
      insertPayload.status_id = defaultStatus.id;
    }
    // No default status resolved (shouldn't happen — enforced by a DB
    // constraint) — omit both fields and let `status`'s own NOT NULL
    // default ("backlog") apply, same safety net as before this phase.
  }

  const { data: row, error } = await supabase
    .from("tickets")
    .insert(insertPayload)
    .select(TICKET_COLUMNS)
    .single<TicketRow>();

  if (error) {
    logDev("ticket creation failed", error);
    return { status: "error", message: error.message };
  }

  registerProjectCode(slug, project.project_code);

  // The creator (and, if one was set at creation, the initial assignee)
  // become this ticket's first real subscribers — fire-and-forget, same
  // resilience as every other notification-adjacent side effect here: a
  // failed subscribe must never fail or roll back the ticket that was just
  // created.
  void subscribeToTicket(supabase, row.id, row.created_by).catch((err) => {
    logDev("ticket subscribe (creator) failed", err);
  });
  if (row.assignee_profile_id) {
    void subscribeToTicket(supabase, row.id, row.assignee_profile_id).catch((err) => {
      logDev("ticket subscribe (initial assignee) failed", err);
    });
  }

  // Resolve the assignee's real name/avatar for the ticket handed back to
  // the UI immediately — same lookup shape loadProjectTickets uses on read.
  let assigneeRow: AssigneeProfileRow | undefined;
  if (row.assignee_profile_id) {
    const { data: profileRow, error: profileError } = await supabase
      .from("profiles")
      .select("id, first_name, last_name, avatar_url, updated_at")
      .eq("id", row.assignee_profile_id)
      .maybeSingle<AssigneeProfileRow>();
    if (profileError) {
      logDev("assignee profile lookup failed", profileError);
    } else {
      assigneeRow = profileRow ?? undefined;
    }
  }

  return {
    status: "success",
    ticket: rowToTicket(row, slug, assigneeRow, undefined, statusesById),
  };
}

// Persists a single Ticket Detail inline edit. Only fields already present
// in the schema are accepted — every field here maps 1:1 to a real column.
export interface UpdateTicketInput {
  title?: string;
  description?: string;
  /** Real ticket_statuses.id (Fase 2) — the preferred way to change a
   *  ticket's status: Board drag-and-drop, the status selector (Ticket
   *  Detail/Preview), and quick status-change actions all resolve a target
   *  status row and pass its id here. Writes both `status_id` and the
   *  matching legacy `status` enum in the same update (the
   *  tickets_sync_status_id trigger requires them to agree — see
   *  20260830000000). `status` below is accepted only as a legacy
   *  fallback and ignored whenever `statusId` is also given. */
  statusId?: string;
  status?: TicketStatus;
  type?: TicketType;
  priority?: TicketPriority;
  /** null clears the assignee (Unassigned). */
  assigneeProfileId?: string | null;
  /** null clears the estimate. */
  hours?: number | null;
  /** ISO date (yyyy-mm-dd), or null to clear. */
  dueDate?: string | null;
  labels?: string[];
  /** Full, ordered replacement of the ticket's Acceptance Criteria text list (Ticket Detail's edit mode) — an empty array clears it entirely, same as never having set any. */
  acceptanceCriteria?: string[];
  /** Checked/unchecked state, aligned by index with the ticket's acceptanceCriteria. */
  acceptanceCriteriaDone?: boolean[];
  /** Link (a real ticket id) / unlink (null) this ticket under a parent —
   *  Ticket Detail's Children section, on the CHILD ticket's own row.
   *  tickets_guard_parent_hierarchy (20260927000000) is the real same-
   *  project/one-level-only enforcement. */
  parentTicketId?: string | null;
  /** Real tickets.sprint_id (Sprint MVP) — set to a real sprints.id to add
   *  this ticket to that sprint, or null to return it to the general
   *  backlog. The only write path Manage Sprint's ticket checklist uses;
   *  covered by the existing tickets_update RLS policy, no new one needed. */
  sprintId?: string | null;
}

export type UpdateTicketResult =
  | { status: "success"; ticket: Ticket }
  | { status: "error"; message: string };

// Every field notifyTicketChange below needs to diff against — see
// updateTicket's own "before" fetch for why this is wider than just
// status/assignee.
interface TicketChangeBeforeSnapshot {
  project_id: string;
  status: string;
  status_id: string;
  assignee_profile_id: string | null;
  priority: string;
  due_date: string | null;
  description: string | null;
  labels: string[] | null;
  acceptance_criteria: string[] | null;
  acceptance_criteria_done: boolean[] | null;
}

export async function updateTicket(
  ticketId: string,
  slug: string,
  input: UpdateTicketInput
): Promise<UpdateTicketResult> {
  const supabase = getSupabaseBrowserClient();

  // Real "before" snapshot of every field a notification could care about —
  // needed both for the existing assignee-membership check below and to
  // detect a genuine change afterwards (never notify when nothing actually
  // changed). Widened beyond status/assignee so subscriber fan-out
  // (notifyTicketChange below) can also detect a real priority/due-date/
  // description/labels/acceptance-criteria change — only fetched when at
  // least one notification-relevant field is part of this edit.
  const notifiableFieldsTouched =
    input.status !== undefined ||
    input.statusId !== undefined ||
    input.assigneeProfileId !== undefined ||
    input.priority !== undefined ||
    input.dueDate !== undefined ||
    input.description !== undefined ||
    input.labels !== undefined ||
    input.acceptanceCriteria !== undefined ||
    input.acceptanceCriteriaDone !== undefined;

  let beforeRow: TicketChangeBeforeSnapshot | undefined;
  if (notifiableFieldsTouched) {
    const { data: existingRow, error: beforeError } = await supabase
      .from("tickets")
      .select(
        "project_id, status, status_id, assignee_profile_id, priority, due_date, description, labels, acceptance_criteria, acceptance_criteria_done"
      )
      .eq("id", ticketId)
      .maybeSingle<TicketChangeBeforeSnapshot>();
    if (beforeError) {
      logDev("ticket lookup before update failed", beforeError);
      return { status: "error", message: beforeError.message };
    }
    if (!existingRow) return { status: "error", message: "Ticket not found." };
    beforeRow = existingRow;
  }

  // Same real-membership validation createTicket applies — reject setting
  // (not clearing) an assignee who isn't an active member of this ticket's
  // project. Never auto-adds the assignee to the project.
  if (input.assigneeProfileId && beforeRow) {
    const { data: membershipRow, error: membershipError } = await supabase
      .from("project_memberships")
      .select("id")
      .eq("project_id", beforeRow.project_id)
      .eq("profile_id", input.assigneeProfileId)
      .maybeSingle<{ id: string }>();
    if (membershipError) {
      logDev("assignee project membership check failed", membershipError);
      return { status: "error", message: membershipError.message };
    }
    if (!membershipRow) {
      return { status: "error", message: "This person isn't a member of this project and can't be assigned." };
    }
  }

  const patch: Record<string, unknown> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.description !== undefined) patch.description = input.description;
  if (input.statusId !== undefined && beforeRow) {
    // status_id (Fase 2.5) is written alone — the tickets_sync_status_id
    // trigger (20260919000000) mirrors it into the legacy `status` column
    // itself when the target status has a legacy_enum_value, and leaves
    // `status` untouched otherwise (a custom status, not yet reachable
    // without a status-management UI, but the write path already supports
    // it). Still validated client-side against this project's own real
    // statuses first, for a friendlier error than the trigger's own
    // project-mismatch exception.
    const { byId: statusesById } = await loadProjectTicketStatusesData(supabase, beforeRow.project_id);
    if (!statusesById.has(input.statusId)) {
      return { status: "error", message: "Invalid status for this project." };
    }
    patch.status_id = input.statusId;
    // Every real status change reaching this function is a human-initiated
    // one — Ticket Detail's status selector, the Preview/Quick Edit panel,
    // and Kanban drag-and-drop (including its own "Close anyway" override)
    // all funnel through here. Only recompute_parent_ticket_status
    // (20260927000000) ever sets this back to true, via a direct SQL
    // UPDATE that never goes through this function — so a manual close can
    // never be mistaken for the parent/children auto-close automation.
    patch.auto_closed = false;
  } else if (input.status !== undefined) {
    patch.status = STATUS_TO_DB[input.status];
    patch.auto_closed = false;
  }
  if (input.type !== undefined) patch.type = TYPE_TO_DB[input.type];
  if (input.priority !== undefined) patch.priority = input.priority;
  if (input.assigneeProfileId !== undefined) patch.assignee_profile_id = input.assigneeProfileId;
  if (input.hours !== undefined) patch.hours = input.hours;
  if (input.dueDate !== undefined) patch.due_date = input.dueDate;
  if (input.labels !== undefined) patch.labels = input.labels;
  if (input.parentTicketId !== undefined) patch.parent_ticket_id = input.parentTicketId;
  if (input.sprintId !== undefined) patch.sprint_id = input.sprintId;
  // Same "empty list stored as null" convention createTicket already uses
  // for this column.
  if (input.acceptanceCriteria !== undefined) {
    patch.acceptance_criteria = input.acceptanceCriteria.length > 0 ? input.acceptanceCriteria : null;
  }
  if (input.acceptanceCriteriaDone !== undefined) patch.acceptance_criteria_done = input.acceptanceCriteriaDone;

  const { data: row, error } = await supabase
    .from("tickets")
    .update(patch)
    .eq("id", ticketId)
    .select(TICKET_COLUMNS)
    .single<TicketRow>();

  if (error) {
    logDev("ticket update failed", error);
    return { status: "error", message: error.message };
  }

  let assigneeRow: AssigneeProfileRow | undefined;
  if (row.assignee_profile_id) {
    const { data: profileRow, error: profileError } = await supabase
      .from("profiles")
      .select("id, first_name, last_name, avatar_url, updated_at")
      .eq("id", row.assignee_profile_id)
      .maybeSingle<AssigneeProfileRow>();
    if (profileError) {
      logDev("assignee profile lookup failed", profileError);
    } else {
      assigneeRow = profileRow ?? undefined;
    }
  }

  const { byId: statusesById } = await loadProjectTicketStatusesData(supabase, row.project_id);

  // Whoever is now assigned becomes a real, permanent subscriber —
  // regardless of whether this counts as a genuine *change* for
  // notification purposes below (idempotent either way: re-saving the same
  // assignee is a harmless no-op insert). This is what keeps a later
  // reassignment away from them from ever erasing their own history on
  // this ticket.
  if (input.assigneeProfileId !== undefined && row.assignee_profile_id) {
    void subscribeToTicket(supabase, row.id, row.assignee_profile_id).catch((err) => {
      logDev("ticket subscribe (assignee) failed", err);
    });
  }

  // Fire-and-forget: never delays or can fail the already-successful update
  // above. Reassignment, a genuine status change, or a genuine change to
  // priority/due date/description/labels/acceptance criteria all notify —
  // see notifyTicketChange below for exactly what's excluded (title/type/
  // estimate, per this feature's own scope) and how subscribers factor in.
  if (beforeRow) {
    void notifyTicketChange(supabase, beforeRow, row, input, statusesById).catch((err) => {
      logDev("ticket change notification failed", err);
    });
  }

  return { status: "success", ticket: rowToTicket(row, slug, assigneeRow, undefined, statusesById) };
}

// ── Parent / Children hierarchy (exactly one level) ─────────────────────────
// "Is this ticket a parent" is never stored — it's purely whether any other
// ticket's own parent_ticket_id points at it. Every read here is a flat,
// separate query (never an embedded tickets.select("...,ticket_statuses(...)")),
// same reasoning as loadProjectTicketStatusesData's own comment: parent_ticket_id
// is a brand new FK, and PostgREST's relationship cache can lag behind a
// hand-applied migration.

export interface TicketParentSummary {
  id: string;
  ticketNumber: number;
  title: string;
  type: TicketType;
  status: TicketStatus;
  statusName?: string;
  statusGroupType?: "open" | "closed";
}

export interface TicketChildSummary {
  id: string;
  ticketNumber: number;
  title: string;
  type: TicketType;
  status: TicketStatus;
  statusName?: string;
  statusGroupType?: "open" | "closed";
  hours?: number;
  /** Real profiles.id — undefined/null when unassigned. Ticket Detail's
   *  Children rows use this (plus assigneeName/assigneeAvatar below) to
   *  show just the assignee's avatar, same MemberTrigger popover every
   *  other assignee avatar in the app already opens. */
  assigneeProfileId?: string | null;
  assigneeName?: string;
  assigneeAvatar?: string;
}

export type TicketHierarchyResult =
  | {
      status: "ready";
      parent: TicketParentSummary | null;
      children: TicketChildSummary[];
      /** Sum of every child's own Estimated hours — undefined (never 0)
       *  when there are no children at all, so callers can tell "not a
       *  parent" apart from "a parent whose children have no estimate". */
      estimatedHours: number | undefined;
      loggedHours: number;
    }
  | { status: "error"; message: string };

interface HierarchyTicketRow {
  id: string;
  ticket_number: number;
  title: string;
  type: string;
  status: string;
  status_id: string;
  hours: string | null;
  assignee_profile_id: string | null;
}

function rowToHierarchySummary(
  row: HierarchyTicketRow,
  statusesById: Map<string, TicketStatusOption>,
  assigneesById?: Map<string, AssigneeProfileRow>
): TicketChildSummary {
  const statusOption = statusesById.get(row.status_id);
  const assigneeRow = row.assignee_profile_id ? assigneesById?.get(row.assignee_profile_id) : undefined;
  return {
    id: row.id,
    ticketNumber: row.ticket_number,
    title: row.title,
    type: TYPE_FROM_DB[row.type] ?? "TASK",
    status: STATUS_FROM_DB[row.status] ?? "backlog",
    statusName: statusOption?.name,
    statusGroupType: statusOption?.groupType,
    hours: row.hours !== null ? Number(row.hours) : undefined,
    assigneeProfileId: row.assignee_profile_id,
    assigneeName: assigneeRow
      ? [assigneeRow.first_name, assigneeRow.last_name].filter(Boolean).join(" ") || "Unnamed"
      : undefined,
    assigneeAvatar: assigneeRow ? resolveAvatarUrl(assigneeRow.avatar_url, assigneeRow.updated_at) ?? FALLBACK_AVATAR : undefined,
  };
}

const HIERARCHY_TICKET_COLUMNS = "id, ticket_number, title, type, status, status_id, hours, assignee_profile_id";

// Ticket Detail's PARENT + CHILDREN sections, and the parent's own
// aggregated Estimated/Logged hours (Estimated = sum of children's own
// Estimated; Logged = sum of every logged time entry across all children —
// never the parent's own, which is structurally impossible to have once it
// has children, see tickets_block_hours_on_parent/
// ticket_time_entries_block_on_parent, 20260927000000).
export async function loadTicketHierarchy(ticket: Ticket): Promise<TicketHierarchyResult> {
  const supabase = getSupabaseBrowserClient();

  const [parentRes, childrenRes] = await Promise.all([
    ticket.parentTicketId
      ? supabase
          .from("tickets")
          .select(HIERARCHY_TICKET_COLUMNS)
          .eq("id", ticket.parentTicketId)
          .maybeSingle<HierarchyTicketRow>()
      : Promise.resolve({ data: null, error: null }),
    supabase
      .from("tickets")
      .select(HIERARCHY_TICKET_COLUMNS)
      .eq("parent_ticket_id", ticket.id)
      .order("ticket_number", { ascending: true })
      .returns<HierarchyTicketRow[]>(),
  ]);

  if (parentRes.error) {
    logDev("ticket parent lookup failed", parentRes.error);
    return { status: "error", message: parentRes.error.message };
  }
  if (childrenRes.error) {
    logDev("ticket children lookup failed", childrenRes.error);
    return { status: "error", message: childrenRes.error.message };
  }

  const childRows = childrenRes.data ?? [];

  const statusIds = Array.from(
    new Set([parentRes.data?.status_id, ...childRows.map((r) => r.status_id)].filter((id): id is string => Boolean(id)))
  );
  const statusesById = new Map<string, TicketStatusOption>();
  if (statusIds.length > 0) {
    const { data: statusRows, error: statusError } = await supabase
      .from("ticket_statuses")
      .select("id, name, sort_order, group_type, is_default, legacy_enum_value")
      .in("id", statusIds)
      .returns<TicketStatusRow[]>();
    if (statusError) {
      logDev("ticket hierarchy statuses lookup failed", statusError);
    } else {
      for (const row of statusRows ?? []) statusesById.set(row.id, rowToTicketStatusOption(row));
    }
  }

  // Flat, single query for every distinct child assignee — same "avoid
  // N+1" reasoning as loadProjectTickets' own assignee lookup. Parent
  // summaries never resolve an assignee (not needed anywhere yet), so
  // this is scoped to children only.
  const childAssigneeIds = Array.from(
    new Set(childRows.map((r) => r.assignee_profile_id).filter((id): id is string => Boolean(id)))
  );
  const assigneesById = new Map<string, AssigneeProfileRow>();
  if (childAssigneeIds.length > 0) {
    const { data: assigneeRows, error: assigneeError } = await supabase
      .from("profiles")
      .select("id, first_name, last_name, avatar_url, updated_at")
      .in("id", childAssigneeIds)
      .returns<AssigneeProfileRow[]>();
    if (assigneeError) {
      logDev("ticket hierarchy assignees lookup failed", assigneeError);
    } else {
      for (const row of assigneeRows ?? []) assigneesById.set(row.id, row);
    }
  }

  const parent: TicketParentSummary | null = parentRes.data
    ? rowToHierarchySummary(parentRes.data, statusesById)
    : null;
  const children = childRows.map((row) => rowToHierarchySummary(row, statusesById, assigneesById));

  let loggedHours = 0;
  if (children.length > 0) {
    const { data: entryRows, error: entriesError } = await supabase
      .from("ticket_time_entries")
      .select("minutes")
      .in(
        "ticket_id",
        children.map((c) => c.id)
      )
      .returns<{ minutes: number }[]>();
    if (entriesError) {
      logDev("ticket hierarchy time entries lookup failed", entriesError);
    } else {
      loggedHours = (entryRows ?? []).reduce((sum, e) => sum + e.minutes, 0) / 60;
    }
  }

  const estimatedHours =
    children.length > 0 ? children.reduce((sum, c) => sum + (c.hours ?? 0), 0) : undefined;

  return { status: "ready", parent, children, estimatedHours, loggedHours };
}

// Ticket Detail/Preview/Kanban's shared "would closing this ticket leave
// open child tickets behind" check — the one place all three surfaces ask
// this, so "Close anyway" behaves identically everywhere (see updateTicket's
// own auto_closed handling above for the other half of that centralization).
// Cheap and safe to call for any ticket, parent or not: a childless ticket
// simply resolves to 0 with a single, empty-result query.
export async function countOpenChildTickets(ticketId: string): Promise<number> {
  const supabase = getSupabaseBrowserClient();

  const { data: children, error } = await supabase
    .from("tickets")
    .select("status_id")
    .eq("parent_ticket_id", ticketId)
    .returns<{ status_id: string }[]>();

  if (error) {
    logDev("open child count lookup failed", error);
    return 0;
  }
  if (!children || children.length === 0) return 0;

  const statusIds = Array.from(new Set(children.map((c) => c.status_id)));
  const { data: statusRows, error: statusError } = await supabase
    .from("ticket_statuses")
    .select("id, group_type")
    .in("id", statusIds)
    .returns<{ id: string; group_type: string }[]>();

  if (statusError) {
    logDev("open child count statuses lookup failed", statusError);
    return 0;
  }

  const closedIds = new Set((statusRows ?? []).filter((s) => s.group_type === "closed").map((s) => s.id));
  return children.filter((c) => !closedIds.has(c.status_id)).length;
}

// ── Ticket subscribers ───────────────────────────────────────────────────────
// Persistent, additive "who has meaningfully interacted with this ticket"
// list (20260925000000) — a row here is never removed or moved when a
// ticket is reassigned, unlike tickets.assignee_profile_id itself, which is
// simply overwritten. Every write below is idempotent (INSERT ... ON
// CONFLICT DO NOTHING via Supabase's own upsert + ignoreDuplicates), so
// repeated interactions (logging time twice, re-mentioning the same
// person, re-saving the same assignee) never error or create a duplicate
// row — the table's own (ticket_id, profile_id) primary key is what makes
// that possible.

async function subscribeToTicket(
  supabase: ReturnType<typeof getSupabaseBrowserClient>,
  ticketId: string,
  profileId: string | null | undefined
): Promise<void> {
  if (!profileId) return;
  const { error } = await supabase
    .from("ticket_subscribers")
    .upsert({ ticket_id: ticketId, profile_id: profileId }, { onConflict: "ticket_id,profile_id", ignoreDuplicates: true });
  if (error) logDev("ticket subscribe failed", error);
}

// Same idempotent insert, for more than one profile at once (e.g. every
// real @mention in a single comment).
async function subscribeManyToTicket(
  supabase: ReturnType<typeof getSupabaseBrowserClient>,
  ticketId: string,
  profileIds: string[]
): Promise<void> {
  const rows = Array.from(new Set(profileIds.filter((id): id is string => Boolean(id)))).map((profile_id) => ({
    ticket_id: ticketId,
    profile_id,
  }));
  if (rows.length === 0) return;
  const { error } = await supabase
    .from("ticket_subscribers")
    .upsert(rows, { onConflict: "ticket_id,profile_id", ignoreDuplicates: true });
  if (error) logDev("ticket subscribe (many) failed", error);
}

// Every real subscriber for a ticket, minus whoever a more specific rule
// for this exact event already notified (the ticket's current assignee, a
// specific @mention, a reply's parent author) and minus the acting user —
// createNotification's own actor-guard would catch the latter too, but
// excluding it here avoids sending (and immediately discarding) a
// notification for no reason. This is the one place "existing recipients +
// subscribers, deduplicated" actually happens — every call site below
// builds its own `alreadyNotified` set first, then calls this once.
async function loadRemainingTicketSubscribers(
  supabase: ReturnType<typeof getSupabaseBrowserClient>,
  ticketId: string,
  alreadyNotified: Set<string>
): Promise<string[]> {
  const { data, error } = await supabase
    .from("ticket_subscribers")
    .select("profile_id")
    .eq("ticket_id", ticketId)
    .returns<{ profile_id: string }[]>();
  if (error) {
    logDev("ticket subscribers lookup failed", error);
    return [];
  }
  return (data ?? []).map((r) => r.profile_id).filter((id) => !alreadyNotified.has(id));
}

export type TicketSubscriptionStateResult =
  | { status: "ready"; subscribed: boolean }
  | { status: "error"; message: string };

// Whether the signed-in viewer has their own row in ticket_subscribers for
// this ticket — the one read Ticket Detail's manual subscribe/unsubscribe
// icon needs to render its current state, and only that read (never
// inferred from whether the viewer happens to be the assignee/creator/a
// commenter — a subscription is either a real row or it isn't).
export async function loadTicketSubscriptionState(ticketId: string): Promise<TicketSubscriptionStateResult> {
  const supabase = getSupabaseBrowserClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { status: "ready", subscribed: false };

  const { data, error } = await supabase
    .from("ticket_subscribers")
    .select("ticket_id")
    .eq("ticket_id", ticketId)
    .eq("profile_id", user.id)
    .maybeSingle();

  if (error) {
    logDev("ticket subscription state lookup failed", error);
    return { status: "error", message: error.message };
  }

  return { status: "ready", subscribed: data !== null };
}

export type SetTicketSubscriptionResult = { status: "success" } | { status: "error"; message: string };

// Manual subscribe/unsubscribe — the viewer's own toggle on Ticket Detail,
// entirely separate from the automatic subscribe points above (create/
// assign/comment/mention/log-time keep firing exactly as before; this is
// the only place a row is ever removed). A user may subscribe to any ticket
// they can already view even with zero prior interaction — ticket_subscribers_
// insert's own `profile_id = auth.uid()` branch allows that; unsubscribing
// only ever removes the caller's own row (ticket_subscribers_delete: same
// `profile_id = auth.uid()` restriction), so it can never touch another
// user's subscription and never changes ticket/project access either way.
// Deliberately never notifies anyone — subscribing/unsubscribing is a
// silent preference change, not an event subscribers themselves get told
// about.
export async function setTicketSubscription(ticketId: string, subscribed: boolean): Promise<SetTicketSubscriptionResult> {
  const supabase = getSupabaseBrowserClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { status: "error", message: "Your session has expired. Please sign in again." };

  if (subscribed) {
    const { error } = await supabase
      .from("ticket_subscribers")
      .upsert({ ticket_id: ticketId, profile_id: user.id }, { onConflict: "ticket_id,profile_id", ignoreDuplicates: true });
    if (error) {
      logDev("manual ticket subscribe failed", error);
      return { status: "error", message: error.message };
    }
  } else {
    const { error } = await supabase
      .from("ticket_subscribers")
      .delete()
      .eq("ticket_id", ticketId)
      .eq("profile_id", user.id);
    if (error) {
      logDev("manual ticket unsubscribe failed", error);
      return { status: "error", message: error.message };
    }
  }

  return { status: "success" };
}

// Order-insensitive — label order isn't meaningful, so reordering the same
// set is never treated as a change.
function labelSetsEqual(a: string[] | null | undefined, b: string[] | null | undefined): boolean {
  const x = new Set(a ?? []);
  const y = new Set(b ?? []);
  if (x.size !== y.size) return false;
  for (const v of x) if (!y.has(v)) return false;
  return true;
}

// Order-sensitive — used for Acceptance Criteria's own ordered text list
// and its aligned done-flags, where position matters.
function orderedArraysEqual<T>(a: T[] | null | undefined, b: T[] | null | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

// Real actor + project/ticket text for every ticket-update notification
// type — the one place any of them is ever composed, so Ticket Detail's
// inline edits and the Ticket Preview panel (updateTicket's only two
// callers) can never diverge or duplicate this logic themselves.
//
// Two recipient tiers, in priority order:
//   1. The existing specific-rule recipient for reassignment
//      (ticket_assigned, to the new assignee) and status change
//      (ticket_status_changed, to the current assignee) — wording and
//      audience unchanged from before this feature.
//   2. This ticket's persistent subscribers (ticket_subscribers), minus
//      whoever tier 1 already notified for this exact update and minus the
//      actor — status reuses its own tier-1 wording verbatim (it never
//      says "you", so it reads correctly for anyone); reassignment and
//      every other tracked field (priority/due date/description/labels/
//      acceptance criteria) share one bundled ticket_field_changed
//      notification per update, so changing several fields at once can't
//      spam a subscriber with one notification per field.
async function notifyTicketChange(
  supabase: ReturnType<typeof getSupabaseBrowserClient>,
  beforeRow: TicketChangeBeforeSnapshot,
  row: TicketRow,
  input: UpdateTicketInput,
  statusesById: Map<string, TicketStatusOption>
): Promise<void> {
  const assigneeChanged =
    input.assigneeProfileId !== undefined &&
    row.assignee_profile_id !== null &&
    row.assignee_profile_id !== beforeRow.assignee_profile_id;
  // status_id (Fase 2.5) is the real change signal — comparing the legacy
  // `status` column alone would miss a genuine move between two custom
  // statuses that share no legacy_enum_value (it never changes for either).
  const statusChanged =
    (input.status !== undefined || input.statusId !== undefined) && beforeRow.status_id !== row.status_id;
  const priorityChanged = input.priority !== undefined && input.priority !== beforeRow.priority;
  const dueDateChanged = input.dueDate !== undefined && (row.due_date ?? null) !== (beforeRow.due_date ?? null);
  const descriptionChanged =
    input.description !== undefined && (row.description ?? "") !== (beforeRow.description ?? "");
  const labelsChanged = input.labels !== undefined && !labelSetsEqual(row.labels, beforeRow.labels);
  const acceptanceCriteriaChanged =
    (input.acceptanceCriteria !== undefined &&
      !orderedArraysEqual(row.acceptance_criteria, beforeRow.acceptance_criteria)) ||
    (input.acceptanceCriteriaDone !== undefined &&
      !orderedArraysEqual(row.acceptance_criteria_done, beforeRow.acceptance_criteria_done));

  const otherFieldsChanged =
    priorityChanged || dueDateChanged || descriptionChanged || labelsChanged || acceptanceCriteriaChanged;

  if (!assigneeChanged && !statusChanged && !otherFieldsChanged) return;

  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  const actorProfileId = authUser?.id ?? null;

  const { data: projectRow, error: projectLookupError } = await supabase
    .from("projects")
    .select("id, organization_id, project_code")
    .eq("id", row.project_id)
    .maybeSingle<{ id: string; organization_id: string; project_code: string }>();

  if (projectLookupError || !projectRow) {
    logDev("project lookup for ticket notification failed", projectLookupError);
    return;
  }

  const ticketCode = `${projectRow.project_code}-${row.ticket_number}`;

  let actorName = "Someone";
  if (actorProfileId) {
    const actorsById = await loadProfilesByIds(supabase, [actorProfileId]);
    actorName = resolveProfileName(actorsById.get(actorProfileId)) ?? "Someone";
  }

  const alreadyNotified = new Set<string>();
  if (actorProfileId) alreadyNotified.add(actorProfileId);

  if (assigneeChanged && row.assignee_profile_id) {
    await createNotification({
      organizationId: projectRow.organization_id,
      recipientProfileId: row.assignee_profile_id,
      actorProfileId,
      type: "ticket_assigned",
      title: `${actorName} assigned you to ${ticketCode}`,
      message: row.title,
      projectId: projectRow.id,
      ticketId: row.id,
    });
    alreadyNotified.add(row.assignee_profile_id);
  }

  let statusTitle: string | null = null;
  if (statusChanged && row.assignee_profile_id) {
    // Real ticket_statuses.name (Fase 2.5) — falls back to the legacy
    // label only if a status id somehow isn't in this project's own
    // current list (e.g. a race with a concurrent delete — defensive,
    // not expected in practice, since no status deletion UI exists yet).
    const fromLabel = statusesById.get(beforeRow.status_id)?.name ?? activityStatusLabel(beforeRow.status);
    const toLabel = statusesById.get(row.status_id)?.name ?? activityStatusLabel(row.status);
    statusTitle = `${actorName} moved ${ticketCode} from ${fromLabel} to ${toLabel}`;
    await createNotification({
      organizationId: projectRow.organization_id,
      recipientProfileId: row.assignee_profile_id,
      actorProfileId,
      type: "ticket_status_changed",
      title: statusTitle,
      message: row.title,
      projectId: projectRow.id,
      ticketId: row.id,
    });
    alreadyNotified.add(row.assignee_profile_id);
  }

  // Tier 2 — this ticket's remaining subscribers.
  const subscriberIds = await loadRemainingTicketSubscribers(supabase, row.id, alreadyNotified);
  if (subscriberIds.length === 0) return;

  if (statusChanged && statusTitle) {
    await Promise.all(
      subscriberIds.map((recipientProfileId) =>
        createNotification({
          organizationId: projectRow.organization_id,
          recipientProfileId,
          actorProfileId,
          type: "ticket_status_changed",
          title: statusTitle!,
          message: row.title,
          projectId: projectRow.id,
          ticketId: row.id,
        })
      )
    );
  }

  const changedFieldLabels: string[] = [];
  if (assigneeChanged) changedFieldLabels.push("Assignee");
  if (priorityChanged) changedFieldLabels.push("Priority");
  if (dueDateChanged) changedFieldLabels.push("Due Date");
  if (descriptionChanged) changedFieldLabels.push("Description");
  if (labelsChanged) changedFieldLabels.push("Labels");
  if (acceptanceCriteriaChanged) changedFieldLabels.push("Acceptance Criteria");

  if (changedFieldLabels.length > 0) {
    const title = `${actorName} updated ${changedFieldLabels.join(", ")} on ${ticketCode}`;
    await Promise.all(
      subscriberIds.map((recipientProfileId) =>
        createNotification({
          organizationId: projectRow.organization_id,
          recipientProfileId,
          actorProfileId,
          type: "ticket_field_changed",
          title,
          message: row.title,
          projectId: projectRow.id,
          ticketId: row.id,
        })
      )
    );
  }
}

// ── Labels catalog (Ticket Detail's Labels selector "+ Create") ────────────────
// Real, growing, per-organization label catalog — separate from
// tickets.labels itself (a free-text text[] column, unchanged). This table
// only supplies "which names exist" plus case-insensitive duplicate
// prevention, shared across every ticket in the workspace.

export interface Label {
  id: string;
  name: string;
}

export type LabelsResult =
  | { status: "ready"; labels: Label[] }
  | { status: "error"; message: string };

export async function loadOrganizationLabels(organizationId: string): Promise<LabelsResult> {
  const supabase = getSupabaseBrowserClient();

  const { data, error } = await supabase
    .from("labels")
    .select("id, name")
    .eq("organization_id", organizationId)
    .order("name", { ascending: true })
    .returns<Label[]>();

  if (error) {
    logDev("labels query failed", error);
    return { status: "error", message: error.message };
  }

  return { status: "ready", labels: data ?? [] };
}

export type CreateLabelResult =
  | { status: "success"; label: Label }
  | { status: "error"; message: string };

export async function createOrganizationLabel(organizationId: string, name: string): Promise<CreateLabelResult> {
  const supabase = getSupabaseBrowserClient();
  const trimmed = name.trim();

  if (trimmed.length === 0) {
    return { status: "error", message: "Label name can't be empty." };
  }
  if (trimmed.length > 40) {
    return { status: "error", message: "Label name must be 40 characters or fewer." };
  }

  const { data, error } = await supabase
    .from("labels")
    .insert({ organization_id: organizationId, name: trimmed })
    .select("id, name")
    .single<Label>();

  if (error) {
    logDev("label insert failed", error);
    // 23505 = unique_violation on (organization_id, lower(name)) — the
    // case-insensitive duplicate-prevention this table's index provides.
    if (error.code === "23505") {
      return { status: "error", message: "A label with this name already exists." };
    }
    return { status: "error", message: error.message };
  }

  return { status: "success", label: data };
}

// ── Comments / Activity (Ticket Preview Drawer) ────────────────────────────────
// Read-only for this sprint — there is no comment-creation or activity-
// logging UI yet, so both simply return whatever real rows already exist
// for the ticket (today: none, until those write paths are built). Shapes
// match the drawer's existing MockComment/MockActivity fields exactly
// (name/avatar/timeAgo/text and label/timeAgo) so no JSX changes are needed
// there beyond swapping the data source.

export interface TicketComment {
  id: string;
  name: string;
  avatar: string;
  /** Real profiles.id of the comment author, when known — lets a "click this
   *  person" trigger open the Member Profile Modal against their real
   *  identity instead of a name-based guess. Null when genuinely unknown
   *  (author_profile_id is null). */
  authorProfileId: string | null;
  timeAgo: string;
  text: string;
  /** True once updated_at is real (the set_updated_at trigger only ever
   *  sets it on an actual UPDATE) — lets the UI show "(edited)" without a
   *  second, separately-tracked flag. */
  wasEdited: boolean;
  /** Comment-level attachments only (ticket_attachments.comment_id = this comment's id) — read-only here, see loadTicketComments. */
  attachments: TicketAttachment[];
  /** Null for a top-level (parent) comment; otherwise the real id of the
   *  top-level comment this one replies to — never a second level deep, a
   *  database trigger (20260912000000) auto-flattens any reply-to-a-reply
   *  to the real top-level ancestor before it's ever stored. */
  parentCommentId: string | null;
  /** Like/Dislike totals + the viewer's own current reaction, if any —
   *  same for a parent comment or a reply, no distinction at this level. */
  reactions: CommentReactionSummary;
}

export type CommentReactionType = "like" | "dislike";

export interface CommentReactionSummary {
  likeCount: number;
  dislikeCount: number;
  /** The signed-in viewer's own current reaction on this comment, or null —
   *  never another user's; ticket_comment_reactions' own unique
   *  (comment_id, profile_id) constraint (20260915000000) guarantees at
   *  most one row per person per comment. */
  myReaction: CommentReactionType | null;
}

const EMPTY_REACTIONS: CommentReactionSummary = { likeCount: 0, dislikeCount: 0, myReaction: null };

export interface TicketActivityEvent {
  label: string;
  timeAgo: string;
}

export type TicketCommentsResult =
  | { status: "ready"; comments: TicketComment[] }
  | { status: "error"; message: string };

export type TicketActivityResult =
  | { status: "ready"; events: TicketActivityEvent[] }
  | { status: "error"; message: string };

interface CommentRow {
  id: string;
  author_profile_id: string | null;
  body: string;
  created_at: string;
  updated_at: string | null;
  parent_comment_id: string | null;
  /** Only ever actually selected (and populated) by updateTicketComment,
   *  which needs it to notify newly-added @mentions — createTicketComment
   *  already has ticketId as its own param and never selects this column. */
  ticket_id?: string;
}

interface ActivityRow {
  id: string;
  actor_profile_id: string | null;
  event_type: string;
  field_name: string | null;
  old_value: string | null;
  new_value: string | null;
  created_at: string;
}

// Human-readable labels for the Activity feed only — small, deliberate
// duplicates of ticket-ui.tsx's STATUS_LABEL / the app's Type/Priority
// wording, kept local so lib/ doesn't import from components/.
const ACTIVITY_STATUS_LABEL: Record<TicketStatus, string> = {
  backlog: "Backlog",
  "to-do": "To Do",
  "in-progress": "In Progress",
  review: "In Review",
  blocked: "Blocked",
  done: "Done",
};

const ACTIVITY_TYPE_LABEL: Record<TicketType, string> = {
  TASK: "Task",
  BUG: "Bug",
};

const ACTIVITY_PRIORITY_LABEL: Record<TicketPriority, string> = {
  highest: "Highest",
  high: "High",
  medium: "Medium",
  low: "Low",
};

function activityStatusLabel(dbValue: string | null): string {
  if (!dbValue) return "";
  const domain = STATUS_FROM_DB[dbValue];
  return domain ? ACTIVITY_STATUS_LABEL[domain] : dbValue;
}

function activityTypeLabel(dbValue: string | null): string {
  if (!dbValue) return "";
  const domain = TYPE_FROM_DB[dbValue];
  return domain ? ACTIVITY_TYPE_LABEL[domain] : dbValue;
}

function activityPriorityLabel(dbValue: string | null): string {
  if (!dbValue) return "";
  return PRIORITY_VALUES.includes(dbValue as TicketPriority) ? ACTIVITY_PRIORITY_LABEL[dbValue as TicketPriority] : dbValue;
}

// Builds the single display line for one activity row — the only place
// that turns event_type/field_name/old_value/new_value into the text the
// existing Activity UI renders (label + timeAgo), so no JSX changes are
// needed anywhere this is consumed.
function buildActivityLabel(row: ActivityRow, actorName: string | null, resolveName: (id: string | null) => string | null): string {
  const who = actorName ? `${actorName} ` : "";
  switch (row.event_type) {
    case "ticket_created":
      return `${who}created this ticket`.trim();
    case "title_changed":
      return `${who}changed Title from "${row.old_value ?? ""}" to "${row.new_value ?? ""}"`.trim();
    case "description_changed":
      return `${who}updated the description`.trim();
    case "status_changed":
      return `${who}changed Status from ${activityStatusLabel(row.old_value)} to ${activityStatusLabel(row.new_value)}`.trim();
    case "type_changed":
      return `${who}changed Type from ${activityTypeLabel(row.old_value)} to ${activityTypeLabel(row.new_value)}`.trim();
    case "priority_changed":
      return `${who}changed Priority from ${activityPriorityLabel(row.old_value)} to ${activityPriorityLabel(row.new_value)}`.trim();
    case "assignee_changed": {
      const oldName = resolveName(row.old_value);
      const newName = resolveName(row.new_value);
      if (!row.old_value && row.new_value) return `${who}assigned the ticket to ${newName ?? "Unknown"}`.trim();
      if (row.old_value && !row.new_value) return `${who}unassigned the ticket`.trim();
      return `${who}reassigned the ticket from ${oldName ?? "Unknown"} to ${newName ?? "Unknown"}`.trim();
    }
    case "hours_changed":
      if (!row.old_value && row.new_value) return `${who}set Estimate to ${row.new_value} h`.trim();
      if (row.old_value && !row.new_value) return `${who}removed the estimate`.trim();
      return `${who}changed Estimate from ${row.old_value} h to ${row.new_value} h`.trim();
    case "due_date_changed": {
      const oldLabel = formatDueDate(row.old_value) ?? "";
      const newLabel = formatDueDate(row.new_value) ?? "";
      if (!row.old_value && row.new_value) return `${who}set Due Date to ${newLabel}`.trim();
      if (row.old_value && !row.new_value) return `${who}removed the due date`.trim();
      return `${who}changed Due Date from ${oldLabel} to ${newLabel}`.trim();
    }
    case "label_added":
      return `${who}added label "${row.new_value ?? ""}"`.trim();
    case "label_removed":
      return `${who}removed label "${row.old_value ?? ""}"`.trim();
    case "acceptance_criteria_updated":
      return `${who}updated the acceptance criteria`.trim();
    case "acceptance_criterion_completed":
      return `${who}completed acceptance criterion "${row.new_value ?? ""}"`.trim();
    case "acceptance_criterion_unchecked":
      return `${who}unchecked acceptance criterion "${row.new_value ?? ""}"`.trim();
    case "attachment_uploaded":
      return `${who}uploaded "${row.new_value ?? ""}"`.trim();
    case "attachment_renamed":
      return `${who}renamed attachment from "${row.old_value ?? ""}" to "${row.new_value ?? ""}"`.trim();
    case "attachment_deleted":
      return `${who}deleted attachment "${row.old_value ?? ""}"`.trim();
    case "time_logged": {
      // Exact, never rounded to 1 decimal — logTicketTime persists the
      // real entered minutes as-is (no forced rounding), so this must
      // reflect that same exact duration rather than lossily rounding it
      // for display (the earlier per-entry 1-decimal rounding here turned
      // a real e.g. 0.25h entry into a displayed "0.3 h").
      const minutes = Number(row.new_value ?? "0");
      const hrs = minutes / 60;
      return `${who}logged ${hrs} h`.trim();
    }
    case "time_entry_updated": {
      const oldHrs = Number(row.old_value ?? "0") / 60;
      const newHrs = Number(row.new_value ?? "0") / 60;
      return `${who}updated a time entry from ${oldHrs} h to ${newHrs} h`.trim();
    }
    case "time_entry_deleted": {
      const hrs = Number(row.old_value ?? "0") / 60;
      return `${who}deleted a time entry of ${hrs} h`.trim();
    }
    case "added_a_comment":
      return `${who}added a comment`.trim();
    case "relation_added":
      return `${who}linked this ticket to ${row.new_value ?? ""} (${row.field_name ?? ""})`.trim();
    case "relation_removed":
      return `${who}removed the link to ${row.old_value ?? ""} (${row.field_name ?? ""})`.trim();
    default:
      return `${who}${row.event_type.replace(/_/g, " ")}`.trim();
  }
}

async function loadProfilesByIds(
  supabase: ReturnType<typeof getSupabaseBrowserClient>,
  ids: string[]
): Promise<Map<string, AssigneeProfileRow>> {
  const byId = new Map<string, AssigneeProfileRow>();
  if (ids.length === 0) return byId;
  const { data, error } = await supabase
    .from("profiles")
    .select("id, first_name, last_name, avatar_url, updated_at")
    .in("id", ids)
    .returns<AssigneeProfileRow[]>();
  if (error) {
    logDev("profiles lookup failed", error);
    return byId;
  }
  for (const row of data ?? []) byId.set(row.id, row);
  return byId;
}

function resolveProfileName(row: AssigneeProfileRow | undefined): string | null {
  if (!row) return null;
  return [row.first_name, row.last_name].filter(Boolean).join(" ") || "Unnamed";
}

export type ProfileSummaryResult =
  | { status: "ready"; name: string; avatar: string }
  | { status: "not-found" }
  | { status: "error"; message: string };

// Resolves a single real profile's display name/avatar by id — same
// "profiles" columns and name/avatar resolution every other lookup in this
// file already uses (assignee, comment/attachment author, activity actor).
// Used by the Ticket Preview panel's "Created by" field, which only ever
// has a bare profiles.id (Ticket.createdByProfileId) to work with.
export async function loadProfileSummary(profileId: string): Promise<ProfileSummaryResult> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, first_name, last_name, avatar_url, updated_at")
    .eq("id", profileId)
    .maybeSingle<AssigneeProfileRow>();

  if (error) {
    logDev("profile summary lookup failed", error);
    return { status: "error", message: error.message };
  }
  if (!data) return { status: "not-found" };

  return {
    status: "ready",
    name: resolveProfileName(data) ?? "Unnamed",
    avatar: resolveAvatarUrl(data.avatar_url, data.updated_at) ?? FALLBACK_AVATAR,
  };
}

// Newest first — the new comment goes to the top of the list immediately
// after posting, without needing a full refetch to reorder it.
export async function loadTicketComments(ticketId: string): Promise<TicketCommentsResult> {
  const supabase = getSupabaseBrowserClient();

  const { data: rows, error } = await supabase
    .from("ticket_comments")
    .select("id, author_profile_id, body, created_at, updated_at, parent_comment_id")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: false })
    .returns<CommentRow[]>();

  if (error) {
    logDev("ticket comments query failed", error);
    return { status: "error", message: error.message };
  }

  const authorIds = Array.from(
    new Set((rows ?? []).map((row) => row.author_profile_id).filter((id): id is string => Boolean(id)))
  );
  const authorsById = await loadProfilesByIds(supabase, authorIds);

  // Comment-level attachments only (comment_id IS NOT NULL) — ticket-level
  // attachments (comment_id IS NULL) belong to loadTicketAttachments'
  // general section instead and must never show up here too. Fetched once
  // for the whole ticket and grouped in memory below (ascending, to
  // preserve historical order within a comment), so this stays a single
  // extra query no matter how many comments there are.
  const { data: attachmentRows, error: attachmentsError } = await supabase
    .from("ticket_attachments")
    .select("id, filename, storage_path, size_bytes, mime_type, uploaded_by, created_at, comment_id, is_available")
    .eq("ticket_id", ticketId)
    .not("comment_id", "is", null)
    .order("created_at", { ascending: true })
    .returns<(AttachmentRow & { comment_id: string })[]>();

  if (attachmentsError) {
    logDev("ticket comment attachments query failed", attachmentsError);
  }

  const uploaderIds = Array.from(
    new Set((attachmentRows ?? []).map((row) => row.uploaded_by).filter((id): id is string => Boolean(id)))
  );
  const uploadersById = await loadProfilesByIds(supabase, uploaderIds);

  const attachmentsByCommentId = new Map<string, TicketAttachment[]>();
  for (const row of attachmentRows ?? []) {
    const list = attachmentsByCommentId.get(row.comment_id) ?? [];
    list.push(rowToAttachment(row, row.uploaded_by ? uploadersById.get(row.uploaded_by) : undefined));
    attachmentsByCommentId.set(row.comment_id, list);
  }

  // Like/Dislike totals for every comment on this ticket, fetched once
  // (same "one extra query no matter how many comments" shape as
  // attachments above) and grouped in memory — never a per-comment query.
  const commentIds = (rows ?? []).map((row) => row.id);
  const reactionsByCommentId = new Map<string, CommentReactionSummary>();
  if (commentIds.length > 0) {
    const { data: { user: viewerUser } } = await supabase.auth.getUser();
    const viewerId = viewerUser?.id ?? null;

    const { data: reactionRows, error: reactionsError } = await supabase
      .from("ticket_comment_reactions")
      .select("comment_id, profile_id, reaction")
      .in("comment_id", commentIds)
      .returns<{ comment_id: string; profile_id: string; reaction: CommentReactionType }[]>();

    if (reactionsError) {
      logDev("ticket comment reactions query failed", reactionsError);
    } else {
      for (const row of reactionRows ?? []) {
        const summary = reactionsByCommentId.get(row.comment_id) ?? { likeCount: 0, dislikeCount: 0, myReaction: null };
        if (row.reaction === "like") summary.likeCount += 1;
        else summary.dislikeCount += 1;
        if (viewerId && row.profile_id === viewerId) summary.myReaction = row.reaction;
        reactionsByCommentId.set(row.comment_id, summary);
      }
    }
  }

  const comments: TicketComment[] = (rows ?? []).map((row) => {
    const author = row.author_profile_id ? authorsById.get(row.author_profile_id) : undefined;
    return {
      id: row.id,
      name: resolveProfileName(author) ?? "Unknown",
      avatar: (author ? resolveAvatarUrl(author.avatar_url, author.updated_at) : null) ?? FALLBACK_AVATAR,
      authorProfileId: row.author_profile_id,
      timeAgo: formatRelativeTime(row.created_at),
      text: row.body,
      wasEdited: row.updated_at !== null,
      attachments: attachmentsByCommentId.get(row.id) ?? [],
      parentCommentId: row.parent_comment_id,
      reactions: reactionsByCommentId.get(row.id) ?? EMPTY_REACTIONS,
    };
  });

  return { status: "ready", comments };
}

// Applies (or removes) the signed-in viewer's own Like/Dislike on one
// comment — currentReaction is whatever that comment's own already-loaded
// `reactions.myReaction` was (the caller always already has this; no extra
// read needed to decide delete-vs-upsert). Pressing the already-active
// reaction removes it; pressing the other one switches it (a real UPDATE
// of the same row, never a second one — ticket_comment_reactions' own
// unique (comment_id, profile_id) constraint guarantees that regardless).
// Returns the freshly recomputed totals for just this one comment, so the
// caller can update its local state without refetching every comment.
export async function setCommentReaction(
  commentId: string,
  reaction: CommentReactionType,
  currentReaction: CommentReactionType | null
): Promise<{ status: "success"; reactions: CommentReactionSummary } | { status: "error"; message: string }> {
  const supabase = getSupabaseBrowserClient();

  if (currentReaction === reaction) {
    // ticket_comment_reactions_delete RLS (author-only) means this can
    // never remove anyone else's row even without an explicit profile_id
    // filter here.
    const { error } = await supabase.from("ticket_comment_reactions").delete().eq("comment_id", commentId);
    if (error) {
      logDev("comment reaction delete failed", error);
      return { status: "error", message: error.message };
    }
  } else if (currentReaction === null) {
    // No existing row for this viewer on this comment yet — a real INSERT
    // (profile_id defaults to auth.uid(), never sent).
    const { error } = await supabase.from("ticket_comment_reactions").insert({ comment_id: commentId, reaction });
    if (error) {
      logDev("comment reaction insert failed", error);
      return { status: "error", message: error.message };
    }
  } else {
    // Switching Like <-> Dislike on the viewer's already-existing row — a
    // plain UPDATE touching only the `reaction` column, never `comment_id`.
    // Deliberately NOT an upsert: Postgres/PostgREST's `INSERT ... ON
    // CONFLICT DO UPDATE` sets every column present in the insert payload
    // (comment_id included), and authenticated only holds a column-level
    // UPDATE grant on `reaction` (20260915000000) — that upsert form
    // always failed with "permission denied for table
    // ticket_comment_reactions" the moment it tried to also set comment_id.
    // ticket_comment_reactions_update RLS (author-only) restricts this to
    // the viewer's own row regardless of not filtering by profile_id here.
    const { error } = await supabase.from("ticket_comment_reactions").update({ reaction }).eq("comment_id", commentId);
    if (error) {
      logDev("comment reaction update failed", error);
      return { status: "error", message: error.message };
    }
  }

  const { data: { user: viewerUser } } = await supabase.auth.getUser();
  const viewerId = viewerUser?.id ?? null;

  const { data: rows, error: readError } = await supabase
    .from("ticket_comment_reactions")
    .select("profile_id, reaction")
    .eq("comment_id", commentId)
    .returns<{ profile_id: string; reaction: CommentReactionType }[]>();

  if (readError) {
    logDev("comment reaction summary read failed", readError);
    return { status: "error", message: readError.message };
  }

  const summary: CommentReactionSummary = { likeCount: 0, dislikeCount: 0, myReaction: null };
  for (const row of rows ?? []) {
    if (row.reaction === "like") summary.likeCount += 1;
    else summary.dislikeCount += 1;
    if (viewerId && row.profile_id === viewerId) summary.myReaction = row.reaction;
  }

  return { status: "success", reactions: summary };
}

// Groups a flat TicketComment[] (as loaded above/kept in local component
// state) into top-level comments each paired with their own replies — pure
// and stateless, so both Ticket Detail and the Ticket Preview panel share
// one real implementation instead of two. Top-level order is left exactly
// as given (loadTicketComments' own newest-first order, unchanged by this
// feature); replies come back oldest-first within their own parent
// (loadTicketComments fetches newest-first overall, so this just reverses
// each parent's own slice).
export function groupCommentThreads(comments: TicketComment[]): { parent: TicketComment; replies: TicketComment[] }[] {
  return comments
    .filter((c) => !c.parentCommentId)
    .map((parent) => ({
      parent,
      replies: comments.filter((c) => c.parentCommentId === parent.id).slice().reverse(),
    }));
}

export type CreateTicketCommentResult =
  | { status: "success"; comment: TicketComment }
  | { status: "error"; message: string };

// author_profile_id is never sent by the client — it defaults to
// auth.uid() at the database level (same pattern as
// ticket_attachments.uploaded_by / ticket_time_entries.logged_by), so it
// can't be spoofed. A database trigger on this insert also creates the
// matching "<name> added a comment" ticket_activity row — see
// 20260727000000_enable_real_ticket_comments.sql.
export async function createTicketComment(
  ticketId: string,
  body: string,
  parentCommentId?: string | null
): Promise<CreateTicketCommentResult> {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return { status: "error", message: "Comment can't be empty." };
  }

  const supabase = getSupabaseBrowserClient();

  const { data: row, error } = await supabase
    .from("ticket_comments")
    .insert({ ticket_id: ticketId, body: trimmed, parent_comment_id: parentCommentId ?? null })
    .select("id, author_profile_id, body, created_at, updated_at, parent_comment_id")
    .single<CommentRow>();

  if (error) {
    logDev("ticket comment insert failed", error);
    return { status: "error", message: error.message };
  }

  let authorRow: AssigneeProfileRow | undefined;
  if (row.author_profile_id) {
    const { data: profileRow, error: profileError } = await supabase
      .from("profiles")
      .select("id, first_name, last_name, avatar_url, updated_at")
      .eq("id", row.author_profile_id)
      .maybeSingle<AssigneeProfileRow>();
    if (profileError) {
      logDev("comment author profile lookup failed", profileError);
    } else {
      authorRow = profileRow ?? undefined;
    }
  }

  // Fire-and-forget: never delays or can fail the already-successful post
  // above. notifyNewComment is the single place that resolves every
  // possible recipient for a brand-new comment/reply (a specific @mention,
  // the parent comment's own author, the ticket's current assignee, and
  // this ticket's remaining subscribers) with the priority/dedup rules
  // that keep any one of them from ever being notified twice for this one
  // comment — see its own header comment.
  if (row.author_profile_id) {
    // Every real @mention in a brand-new comment is a new mention by
    // definition — no "already existed" set to diff against, unlike edits.
    const mentionedProfileIds = extractMentionedProfileIds(trimmed);
    // row.parent_comment_id reflects whatever the DB actually stored — the
    // flatten-depth trigger (20260912000000) may have re-pointed it at a
    // different (the real top-level) comment than what was passed in.
    void notifyNewComment(
      supabase,
      ticketId,
      row.author_profile_id,
      trimmed,
      authorRow,
      row.parent_comment_id,
      mentionedProfileIds
    ).catch((err) => {
      logDev("comment notification failed", err);
    });
  }

  return {
    status: "success",
    comment: {
      id: row.id,
      name: resolveProfileName(authorRow) ?? "Unknown",
      avatar: (authorRow ? resolveAvatarUrl(authorRow.avatar_url, authorRow.updated_at) : null) ?? FALLBACK_AVATAR,
      authorProfileId: row.author_profile_id,
      timeAgo: formatRelativeTime(row.created_at),
      text: row.body,
      wasEdited: row.updated_at !== null,
      attachments: [],
      parentCommentId: row.parent_comment_id,
      reactions: EMPTY_REACTIONS,
    },
  };
}

export type UpdateTicketCommentResult =
  | { status: "success"; comment: TicketComment }
  | { status: "error"; message: string };

// Edits a comment's own body — only ever reachable for the comment's real
// author (ticket_comments_update RLS, 20260907000000), re-enforced here
// too since Postgres would otherwise just return zero rows updated rather
// than a clear error. attachments come back empty the same way
// createTicketComment's own result does; the caller merges this into the
// comment it already has loaded (with its own real attachments intact),
// never replaces the whole row from this result alone.
export async function updateTicketComment(commentId: string, body: string): Promise<UpdateTicketCommentResult> {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return { status: "error", message: "Comment can't be empty." };
  }

  const supabase = getSupabaseBrowserClient();

  // Real "before" body, read purely to diff @mentions afterward — never
  // what gates the edit itself (the update below, restricted by
  // ticket_comments_update RLS to the real author, is what does that).
  // Any project member can already read any comment in a visible project
  // (ticket_comments_select), so this succeeds regardless of who's editing;
  // a missing row here just means there's nothing prior to diff against.
  const { data: beforeRow } = await supabase
    .from("ticket_comments")
    .select("body")
    .eq("id", commentId)
    .maybeSingle<{ body: string }>();

  const { data: row, error } = await supabase
    .from("ticket_comments")
    .update({ body: trimmed })
    .eq("id", commentId)
    .select("id, ticket_id, author_profile_id, body, created_at, updated_at, parent_comment_id")
    .maybeSingle<CommentRow>();

  if (error) {
    logDev("ticket comment update failed", error);
    return { status: "error", message: error.message };
  }
  if (!row) {
    return { status: "error", message: "You can only edit your own comments." };
  }

  let authorRow: AssigneeProfileRow | undefined;
  if (row.author_profile_id) {
    const { data: profileRow, error: profileError } = await supabase
      .from("profiles")
      .select("id, first_name, last_name, avatar_url, updated_at")
      .eq("id", row.author_profile_id)
      .maybeSingle<AssigneeProfileRow>();
    if (profileError) {
      logDev("comment author profile lookup failed", profileError);
    } else {
      authorRow = profileRow ?? undefined;
    }
  }

  // Only ever notify @mentions newly added by this specific edit — a
  // mention that was already there before never fires again.
  if (row.author_profile_id && row.ticket_id) {
    const oldMentionIds = new Set(beforeRow ? extractMentionedProfileIds(beforeRow.body) : []);
    const newMentionIds = extractMentionedProfileIds(trimmed).filter((id) => !oldMentionIds.has(id));
    if (newMentionIds.length > 0) {
      void notifyEditedCommentMentions(supabase, row.ticket_id, row.author_profile_id, newMentionIds, trimmed, authorRow).catch((err) => {
        logDev("comment mention notification failed", err);
      });
    }
  }

  return {
    status: "success",
    comment: {
      id: row.id,
      name: resolveProfileName(authorRow) ?? "Unknown",
      avatar: (authorRow ? resolveAvatarUrl(authorRow.avatar_url, authorRow.updated_at) : null) ?? FALLBACK_AVATAR,
      authorProfileId: row.author_profile_id,
      timeAgo: formatRelativeTime(row.created_at),
      text: row.body,
      wasEdited: row.updated_at !== null,
      attachments: [],
      parentCommentId: row.parent_comment_id,
      reactions: EMPTY_REACTIONS,
    },
  };
}

export type DeleteTicketCommentResult = { status: "success" } | { status: "error"; message: string };

// Goes through a SECURITY DEFINER RPC (delete_ticket_comment,
// 20260912000000) rather than a direct table DELETE: deleting a parent
// comment cascades to its own replies (parent_comment_id ON DELETE
// CASCADE), which a plain author-only RLS delete policy would then block
// whenever a reply's author differs from the parent's own author — the RPC
// re-verifies authorship itself, then deletes as its own definer, so that
// cascade always succeeds regardless of who authored the replies.
export async function deleteTicketComment(commentId: string): Promise<DeleteTicketCommentResult> {
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase.rpc("delete_ticket_comment", { p_comment_id: commentId });
  if (error) {
    logDev("ticket comment delete failed", error);
    return { status: "error", message: error.message };
  }
  return { status: "success" };
}

// The real profiles.id of every @mention in a saved comment's HTML —
// Mention's own default markup (<span data-type="mention" data-id="...">,
// see components/rich-text/mention-suggestion.ts), never resolved by
// name-matching. Deduped via the Set (repeating the same mention several
// times in one comment still yields it once) — the one real source of
// truth both createTicketComment and updateTicketComment diff against,
// so the two can never disagree about what a comment actually mentions.
function extractMentionedProfileIds(html: string): string[] {
  if (!html || typeof DOMParser === "undefined") return [];
  const doc = new DOMParser().parseFromString(html, "text/html");
  const ids = new Set<string>();
  doc.querySelectorAll('span[data-type="mention"]').forEach((el) => {
    const id = el.getAttribute("data-id");
    if (id) ids.add(id);
  });
  return Array.from(ids);
}

// Plain-text excerpt for a comment_mention notification's message — strips
// every tag (DOMPurify with an empty allowlist, same technique
// rich-text-utils.ts's own isRichTextEmpty already uses) rather than
// truncating raw sanitized HTML mid-tag.
function plainTextExcerpt(html: string, maxLength = 300): string {
  const text = DOMPurify.sanitize(html, { ALLOWED_TAGS: [] }).replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

// Validates candidate @mention ids against real, currently-active
// project_memberships for this ticket's project, then notifies each
// survivor — never trusts the editor's own suggestion list at face value
// (mentionCandidates, threaded from loadProjectTeam, is already scoped to
// real project members, but this re-checks server-side regardless). Used
// by both a brand-new comment (notifyNewComment below) and an edit that
// adds new mentions (notifyEditedCommentMentions below), so the two can
// never validate/word this differently. Returns the ids actually notified,
// so callers can subscribe them and exclude them from other recipient
// tiers for the same comment.
async function notifyValidMentions(
  supabase: ReturnType<typeof getSupabaseBrowserClient>,
  ticketId: string,
  projectId: string,
  organizationId: string,
  ticketCode: string,
  authorProfileId: string,
  candidateIds: string[],
  commentBody: string,
  authorName: string
): Promise<string[]> {
  if (candidateIds.length === 0) return [];

  const { data: memberRows, error: memberError } = await supabase
    .from("project_memberships")
    .select("profile_id")
    .eq("project_id", projectId)
    .in("profile_id", candidateIds)
    .returns<{ profile_id: string }[]>();

  if (memberError || !memberRows || memberRows.length === 0) return [];

  const message = plainTextExcerpt(commentBody);

  await Promise.all(
    memberRows.map((member) =>
      createNotification({
        organizationId,
        recipientProfileId: member.profile_id,
        actorProfileId: authorProfileId,
        type: "comment_mention",
        title: `${authorName} mentioned you in ${ticketCode}`,
        message,
        projectId,
        ticketId,
      })
    )
  );

  return memberRows.map((m) => m.profile_id);
}

// The single place a brand-new comment or reply resolves every possible
// recipient and sends at most one notification per person — the fix for
// the previous behavior where an assignee who was also @mentioned in the
// same comment received two separate notifications (comment_mention and
// ticket_comment) for one action.
//
// Recipients, in priority order (first match wins — `alreadyNotified`
// tracks who's already been sent something for this exact comment):
//   1. Every validated @mention — the most deliberate, targeted signal.
//   2. A reply's parent-comment author (skipped if already mentioned above
//      — same rule the previous notifyCommentReply already enforced).
//   3. The ticket's current assignee (skipped if already covered by 1 or 2
//      — this is the actual fix for the assignee+mention duplicate).
//   4. This ticket's remaining persistent subscribers (ticket_subscribers)
//      — everyone tier 1-3 already reached is excluded here too, so a
//      subscriber who's also the assignee, a mention, or the parent author
//      never gets a second, generic "commented on" notification on top of
//      their more specific one.
// The comment's own author is always subscribed (a real, permanent
// interaction), and every validated @mention is subscribed alongside their
// notification — both fire-and-forget, same resilience as every other
// notification-adjacent side effect in this file.
async function notifyNewComment(
  supabase: ReturnType<typeof getSupabaseBrowserClient>,
  ticketId: string,
  authorProfileId: string,
  commentBody: string,
  authorRow: AssigneeProfileRow | undefined,
  parentCommentId: string | null,
  mentionedProfileIds: string[]
): Promise<void> {
  const { data: ticketRow, error: ticketError } = await supabase
    .from("tickets")
    .select("assignee_profile_id, project_id, ticket_number")
    .eq("id", ticketId)
    .maybeSingle<{ assignee_profile_id: string | null; project_id: string; ticket_number: number }>();

  if (ticketError || !ticketRow) return;

  const { data: projectRow, error: projectError } = await supabase
    .from("projects")
    .select("id, organization_id, project_code")
    .eq("id", ticketRow.project_id)
    .maybeSingle<{ id: string; organization_id: string; project_code: string }>();

  if (projectError || !projectRow) return;

  const ticketCode = `${projectRow.project_code}-${ticketRow.ticket_number}`;
  const authorName = resolveProfileName(authorRow) ?? "Someone";

  void subscribeToTicket(supabase, ticketId, authorProfileId).catch((err) => {
    logDev("ticket subscribe (comment author) failed", err);
  });

  const alreadyNotified = new Set<string>([authorProfileId]);

  // Tier 1: @mentions.
  const candidateMentionIds = mentionedProfileIds.filter((id) => !alreadyNotified.has(id));
  const validMentionIds = await notifyValidMentions(
    supabase,
    ticketId,
    ticketRow.project_id,
    projectRow.organization_id,
    ticketCode,
    authorProfileId,
    candidateMentionIds,
    commentBody,
    authorName
  );
  validMentionIds.forEach((id) => alreadyNotified.add(id));
  if (validMentionIds.length > 0) {
    void subscribeManyToTicket(supabase, ticketId, validMentionIds).catch((err) => {
      logDev("ticket subscribe (mentions) failed", err);
    });
  }

  // Tier 2: reply's parent-comment author. Only ever called with the
  // DB-flattened parent id (see createTicketComment), so this is always
  // the real top-level ancestor, never a second level of nesting.
  if (parentCommentId) {
    const { data: parentRow, error: parentError } = await supabase
      .from("ticket_comments")
      .select("author_profile_id")
      .eq("id", parentCommentId)
      .maybeSingle<{ author_profile_id: string | null }>();

    if (!parentError && parentRow?.author_profile_id && !alreadyNotified.has(parentRow.author_profile_id)) {
      await createNotification({
        organizationId: projectRow.organization_id,
        recipientProfileId: parentRow.author_profile_id,
        actorProfileId: authorProfileId,
        type: "comment_reply",
        title: `${authorName} replied to your comment on ${ticketCode}`,
        message: plainTextExcerpt(commentBody),
        projectId: projectRow.id,
        ticketId,
      });
      alreadyNotified.add(parentRow.author_profile_id);
    }
  }

  const commentTitle = `${authorName} commented on ${ticketCode}`;
  const commentMessage = commentBody.length > 300 ? `${commentBody.slice(0, 300)}…` : commentBody;

  // Tier 3: the ticket's current assignee.
  if (ticketRow.assignee_profile_id && !alreadyNotified.has(ticketRow.assignee_profile_id)) {
    await createNotification({
      organizationId: projectRow.organization_id,
      recipientProfileId: ticketRow.assignee_profile_id,
      actorProfileId: authorProfileId,
      type: "ticket_comment",
      title: commentTitle,
      message: commentMessage,
      projectId: projectRow.id,
      ticketId,
    });
    alreadyNotified.add(ticketRow.assignee_profile_id);
  }

  // Tier 4: remaining subscribers — same generic "commented on" wording
  // whether this was a fresh top-level comment or a reply; from a
  // subscriber's point of view (as opposed to the parent author's) it's
  // just new comment activity on a ticket they're already following.
  const subscriberIds = await loadRemainingTicketSubscribers(supabase, ticketId, alreadyNotified);
  if (subscriberIds.length === 0) return;

  await Promise.all(
    subscriberIds.map((recipientProfileId) =>
      createNotification({
        organizationId: projectRow.organization_id,
        recipientProfileId,
        actorProfileId: authorProfileId,
        type: "ticket_comment",
        title: commentTitle,
        message: commentMessage,
        projectId: projectRow.id,
        ticketId,
      })
    )
  );
}

// Edit-time mention notify only — resolves ticket/project itself (unlike
// notifyNewComment above, which already has both resolved for everything
// else it does at creation time), then defers to the same
// notifyValidMentions used there, plus the same subscribe-the-validated-
// mentions side effect. Never re-runs the assignee/reply/subscriber tiers
// on an edit — those already fired once, at creation.
async function notifyEditedCommentMentions(
  supabase: ReturnType<typeof getSupabaseBrowserClient>,
  ticketId: string,
  authorProfileId: string,
  candidateIds: string[],
  commentBody: string,
  authorRow: AssigneeProfileRow | undefined
): Promise<void> {
  const { data: ticketRow, error: ticketError } = await supabase
    .from("tickets")
    .select("project_id, ticket_number")
    .eq("id", ticketId)
    .maybeSingle<{ project_id: string; ticket_number: number }>();

  if (ticketError || !ticketRow) return;

  const { data: projectRow, error: projectError } = await supabase
    .from("projects")
    .select("id, organization_id, project_code")
    .eq("id", ticketRow.project_id)
    .maybeSingle<{ id: string; organization_id: string; project_code: string }>();

  if (projectError || !projectRow) return;

  const ticketCode = `${projectRow.project_code}-${ticketRow.ticket_number}`;
  const authorName = resolveProfileName(authorRow) ?? "Someone";

  const validIds = await notifyValidMentions(
    supabase,
    ticketId,
    ticketRow.project_id,
    projectRow.organization_id,
    ticketCode,
    authorProfileId,
    candidateIds.filter((id) => id !== authorProfileId),
    commentBody,
    authorName
  );
  if (validIds.length > 0) {
    void subscribeManyToTicket(supabase, ticketId, validIds).catch((err) => {
      logDev("ticket subscribe (mentions) failed", err);
    });
  }
}

// Newest first. Every real action (create, field edits, labels, acceptance
// criteria, attachments, time entries, comments) is logged by a database
// trigger as part of the same transaction as its real write — see
// 20260727000000/20260728000000 — so this is a pure read, nothing here
// ever creates an activity row.
export async function loadTicketActivity(ticketId: string): Promise<TicketActivityResult> {
  const supabase = getSupabaseBrowserClient();

  const { data: rows, error } = await supabase
    .from("ticket_activity")
    .select("id, actor_profile_id, event_type, field_name, old_value, new_value, created_at")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: false })
    .returns<ActivityRow[]>();

  if (error) {
    logDev("ticket activity query failed", error);
    return { status: "error", message: error.message };
  }

  let allRows = rows ?? [];

  // Tickets created before this feature existed have no real
  // ticket_created row (the insert trigger only fires for new inserts) —
  // synthesize exactly one, using the ticket's own real created_at /
  // created_by. Never fabricated: if created_by is null (genuinely
  // unknown for a pre-existing ticket), the event simply has no actor,
  // same as any other event with a null actor_profile_id.
  if (!allRows.some((row) => row.event_type === "ticket_created")) {
    const { data: ticketRow } = await supabase
      .from("tickets")
      .select("created_by, created_at")
      .eq("id", ticketId)
      .maybeSingle<{ created_by: string | null; created_at: string }>();
    if (ticketRow) {
      allRows = [
        ...allRows,
        {
          id: `synthetic-created-${ticketId}`,
          actor_profile_id: ticketRow.created_by,
          event_type: "ticket_created",
          field_name: null,
          old_value: null,
          new_value: null,
          created_at: ticketRow.created_at,
        },
      ];
      allRows = [...allRows].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    }
  }

  // Every profile this page of activity could reference: each row's actor,
  // plus assignee_changed's old/new profile ids.
  const profileIds = new Set<string>();
  for (const row of allRows) {
    if (row.actor_profile_id) profileIds.add(row.actor_profile_id);
    if (row.event_type === "assignee_changed") {
      if (row.old_value) profileIds.add(row.old_value);
      if (row.new_value) profileIds.add(row.new_value);
    }
  }
  const profilesById = await loadProfilesByIds(supabase, Array.from(profileIds));
  const resolveName = (id: string | null) => (id ? resolveProfileName(profilesById.get(id)) : null);

  const events: TicketActivityEvent[] = allRows.map((row) => ({
    label: buildActivityLabel(row, resolveName(row.actor_profile_id), resolveName),
    timeAgo: formatRelativeTime(row.created_at),
  }));

  return { status: "ready", events };
}

// ── User Activity (Member Profile modal's Activity tab) ─────────────────────────
// A summarized, cross-ticket, cross-project view of one person's real
// ticket_activity rows — reuses the exact same table/triggers
// loadTicketActivity above reads, just filtered by actor instead of by
// ticket. This is deliberately a *summary*, not a detailed log (that's what
// the ticket's own Activity Log is for — see buildActivityLabel above,
// still used there, untouched): every event_type except ticket_created gets
// folded into a single "Working on <ticket>" entry per ticket, counting how
// many raw rows it represents, rather than describing each field change.
// RLS (ticket_activity_select → can_view_project → is_org_member) is what
// actually scopes this to the caller's own organization — a foreign-org
// profile id simply has no visible rows, never a leak, so no separate
// server-side org check is needed for this read (unlike the privileged
// writes elsewhere in this module's Server Actions).

export interface UserActivityEvent {
  id: string;
  timeAgo: string;
  /** Text before the ticket reference (the whole label when ticketKey is null). */
  labelPrefix: string;
  /** Text after the ticket reference — only meaningful when ticketKey is set. */
  labelSuffix: string;
  /** e.g. "JIR-42" — null when the row's ticket/project couldn't be resolved. */
  ticketKey: string | null;
  /** Needed alongside ticketKey to build the ticket's real URL — never set without ticketKey. */
  projectSlug: string | null;
}

export type UserActivityResult =
  | { status: "ready"; events: UserActivityEvent[] }
  | { status: "error"; message: string };

// Final, post-grouping entry count shown in the tab.
const USER_ACTIVITY_LIMIT = 10;
// Raw ticket_activity rows fetched before grouping — larger than the display
// limit on purpose: grouping only ever *reduces* the row count (many raw
// rows on one ticket become one entry), so a single-ticket-heavy actor would
// otherwise never fill out 10 summarized entries. Still one bounded query,
// not pagination.
const USER_ACTIVITY_RAW_FETCH_LIMIT = 100;

interface UserActivityTicketRow {
  id: string;
  ticket_number: number;
  project_id: string;
}

interface UserActivityProjectRow {
  id: string;
  slug: string;
  project_code: string;
}

type UserActivityRawRow = ActivityRow & { ticket_id: string };

// One summarized entry per ticket: either the ticket's own creation (kept
// as its own milestone entry, never folded in) or every other real action
// this actor took on that ticket, collapsed into a single "Working on"
// count — comments, status/priority changes, attachments, time entries,
// relations, and every other field edit all count toward it, never listed
// individually here.
interface SummarizedTicketActivity {
  ticketId: string;
  mostRecentAt: string;
  count: number;
  kind: "created" | "working-on";
}

function summarizeUserActivityRows(rows: UserActivityRawRow[]): SummarizedTicketActivity[] {
  const summaries: SummarizedTicketActivity[] = [];
  const workingOnByTicket = new Map<string, SummarizedTicketActivity>();

  // rows is already newest-first (the query below orders it that way), so
  // the first row seen for a given ticket in this loop is always its most
  // recent — no separate sort needed to find it.
  for (const row of rows) {
    if (row.event_type === "ticket_created") {
      summaries.push({ ticketId: row.ticket_id, mostRecentAt: row.created_at, count: 1, kind: "created" });
      continue;
    }
    const existing = workingOnByTicket.get(row.ticket_id);
    if (existing) {
      existing.count += 1;
    } else {
      const summary: SummarizedTicketActivity = {
        ticketId: row.ticket_id,
        mostRecentAt: row.created_at,
        count: 1,
        kind: "working-on",
      };
      workingOnByTicket.set(row.ticket_id, summary);
      summaries.push(summary);
    }
  }

  return summaries.sort((a, b) => new Date(b.mostRecentAt).getTime() - new Date(a.mostRecentAt).getTime());
}

// Newest first, capped at USER_ACTIVITY_LIMIT *after* grouping — see
// summarizeUserActivityRows above. Never infers anything from current
// ticket state or the person's account status: every entry here is built
// from real, already-logged ticket_activity rows for this exact actor.
export async function loadUserActivity(profileId: string, limit = USER_ACTIVITY_LIMIT): Promise<UserActivityResult> {
  const supabase = getSupabaseBrowserClient();

  const { data: rows, error } = await supabase
    .from("ticket_activity")
    .select("id, actor_profile_id, ticket_id, event_type, field_name, old_value, new_value, created_at")
    .eq("actor_profile_id", profileId)
    .order("created_at", { ascending: false })
    .limit(USER_ACTIVITY_RAW_FETCH_LIMIT)
    .returns<UserActivityRawRow[]>();

  if (error) {
    logDev("user activity query failed", error);
    return { status: "error", message: error.message };
  }

  const activityRows = rows ?? [];
  if (activityRows.length === 0) return { status: "ready", events: [] };

  const summarized = summarizeUserActivityRows(activityRows).slice(0, limit);

  const ticketIds = Array.from(new Set(summarized.map((s) => s.ticketId)));
  const { data: ticketRows, error: ticketsError } = await supabase
    .from("tickets")
    .select("id, ticket_number, project_id")
    .in("id", ticketIds)
    .returns<UserActivityTicketRow[]>();

  if (ticketsError) {
    logDev("user activity tickets lookup failed", ticketsError);
    return { status: "error", message: ticketsError.message };
  }

  const ticketById = new Map((ticketRows ?? []).map((t) => [t.id, t]));
  const projectIds = Array.from(new Set((ticketRows ?? []).map((t) => t.project_id)));

  let projectRows: UserActivityProjectRow[] = [];
  if (projectIds.length > 0) {
    const { data, error: projectsError } = await supabase
      .from("projects")
      .select("id, slug, project_code")
      .in("id", projectIds)
      .returns<UserActivityProjectRow[]>();

    if (projectsError) {
      logDev("user activity projects lookup failed", projectsError);
      return { status: "error", message: projectsError.message };
    }
    projectRows = data ?? [];
  }
  const projectById = new Map(projectRows.map((p) => [p.id, p]));

  const events: UserActivityEvent[] = summarized.map((s) => {
    const ticket = ticketById.get(s.ticketId);
    const project = ticket ? projectById.get(ticket.project_id) : undefined;
    const ticketKey = ticket && project ? `${project.project_code}-${ticket.ticket_number}` : null;
    const relativeTime = formatRelativeTime(s.mostRecentAt);

    if (s.kind === "created") {
      return {
        id: `created-${s.ticketId}`,
        timeAgo: relativeTime,
        labelPrefix: "Created ",
        labelSuffix: "",
        ticketKey,
        projectSlug: ticketKey ? (project?.slug ?? null) : null,
      };
    }

    return {
      id: `working-on-${s.ticketId}`,
      // The count rides in the same subtitle line as the relative time
      // (e.g. "2 hours ago · 5 updates") rather than a third line, so the
      // existing two-line timeline entry (label + subtitle) needs no
      // structural change.
      timeAgo: `${relativeTime} · ${s.count} update${s.count === 1 ? "" : "s"}`,
      labelPrefix: "Working on ",
      labelSuffix: "",
      ticketKey,
      projectSlug: ticketKey ? (project?.slug ?? null) : null,
    };
  });

  return { status: "ready", events };
}

// ── Project member work history (Team → member menu's "View Work History") ──
// A per-ticket summary, not an activity log — "which tickets has this person
// actually worked on in this project, and how much" — never lists
// individual comments/changes/attachments/time entries (that's still the
// ticket's own Activity Log's job, buildActivityLabel above, untouched).
// The actual participation/aggregation logic lives entirely in three
// database functions (20260810000000_project_member_work_history_pagination.sql
// — see that migration's own header comment for why it's a real,
// server-side LIMIT/OFFSET rather than fetching everything and slicing
// here): this module only calls them and reshapes the result into this
// app's existing TicketStatus/TicketPriority/relative-time conventions.

export interface ProjectMemberWorkHistorySummary {
  ticketCount: number;
  totalHours: number;
  /** Pre-formatted relative time, or null when there's no history at all yet. */
  lastActivityLabel: string | null;
  /** Real count of qualifying ticket_activity rows — only set by the
   *  aggregated "across led projects" summary below (the global Work
   *  History route's own 4th "Activities" KPI); the single-project summary
   *  above never sets it since that page only ever renders 3 KPI tiles. */
  activityCount?: number;
}

export type ProjectMemberWorkHistorySummaryResult =
  | { status: "ready"; summary: ProjectMemberWorkHistorySummary }
  | { status: "error"; message: string };

export interface ProjectMemberWorkHistoryEntry {
  ticketId: string;
  ticketKey: string;
  title: string;
  status: TicketStatus;
  priority: TicketPriority;
  /** Hours this person specifically logged on this ticket — never the ticket's total. */
  hours: number;
  /** Count of this person's own ticket_activity rows on this ticket — never includes being assigned by someone else. */
  activityCount: number;
  /** Pre-formatted relative time ("3 days ago") — same convention as TicketComment/TicketActivityEvent/UserActivityEvent. */
  lastActivityLabel: string;
  /** Real project slug this entry belongs to — only set by the aggregated
   *  "across led projects" loaders below (loadTeamMemberWorkHistory*
   *  AcrossProjects); the single-project loaders above never set it since
   *  their caller already has the one real slug. */
  projectSlug?: string;
}

export type ProjectMemberWorkHistoryPageResult =
  | { status: "ready"; entries: ProjectMemberWorkHistoryEntry[] }
  | { status: "error"; message: string };

// Resolves the project id once — both RPCs below take it, not the slug —
// same "not found ⇒ ready with nothing" convention as this module's other
// project-scoped loaders (e.g. loadProjectTeam) rather than a hard error,
// since a not-yet-loaded organization/slug pairing during the first render
// isn't itself a failure.
async function resolveWorkHistoryProjectId(
  organizationId: string,
  slug: string
): Promise<{ status: "ready"; projectId: string | null } | { status: "error"; message: string }> {
  const supabase = getSupabaseBrowserClient();
  const { data: projectRow, error } = await supabase
    .from("projects")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("slug", slug)
    .maybeSingle<{ id: string }>();

  if (error) {
    logDev("work history project lookup failed", error);
    return { status: "error", message: error.message };
  }
  return { status: "ready", projectId: projectRow?.id ?? null };
}

// Full-history totals — Tickets worked on / Hours logged / Last activity —
// always computed over every matching ticket, independent of which page
// (if any) is currently being viewed.
export async function loadProjectMemberWorkHistorySummary(
  organizationId: string,
  slug: string,
  profileId: string
): Promise<ProjectMemberWorkHistorySummaryResult> {
  const projectResult = await resolveWorkHistoryProjectId(organizationId, slug);
  if (projectResult.status === "error") return projectResult;
  if (!projectResult.projectId) {
    return { status: "ready", summary: { ticketCount: 0, totalHours: 0, lastActivityLabel: null } };
  }

  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase
    .rpc("project_member_work_history_summary", {
      target_project_id: projectResult.projectId,
      target_profile_id: profileId,
    })
    .maybeSingle<{ ticket_count: number; total_hours: number; most_recent_activity_at: string | null }>();

  if (error) {
    logDev("work history summary rpc failed", error);
    return { status: "error", message: error.message };
  }

  return {
    status: "ready",
    summary: {
      ticketCount: data?.ticket_count ?? 0,
      totalHours: Math.round((data?.total_hours ?? 0) * 10) / 10,
      lastActivityLabel: data?.most_recent_activity_at ? formatRelativeTime(data.most_recent_activity_at) : null,
    },
  };
}

interface WorkHistoryPageRow {
  ticket_id: string;
  ticket_number: number;
  title: string;
  status: string;
  priority: string;
  hours: number;
  activity_count: number;
  last_activity_at: string;
}

// One page of rows (default 20 — see the caller, work-history-screen.tsx),
// ordered by this person's last activity on each ticket, most recent
// first, resolved entirely server-side via LIMIT/OFFSET in
// project_member_work_history_page — this function never fetches more
// than one page's worth of tickets.
export async function loadProjectMemberWorkHistoryPage(
  organizationId: string,
  slug: string,
  profileId: string,
  page: number,
  pageSize: number
): Promise<ProjectMemberWorkHistoryPageResult> {
  const projectResult = await resolveWorkHistoryProjectId(organizationId, slug);
  if (projectResult.status === "error") return projectResult;
  if (!projectResult.projectId) return { status: "ready", entries: [] };

  const supabase = getSupabaseBrowserClient();
  const { data: projectCodeRow, error: projectCodeError } = await supabase
    .from("projects")
    .select("project_code")
    .eq("id", projectResult.projectId)
    .maybeSingle<{ project_code: string }>();

  if (projectCodeError) {
    logDev("work history project code lookup failed", projectCodeError);
    return { status: "error", message: projectCodeError.message };
  }
  const projectCode = projectCodeRow?.project_code ?? "";

  const { data, error } = await supabase.rpc("project_member_work_history_page", {
    target_project_id: projectResult.projectId,
    target_profile_id: profileId,
    page_size: pageSize,
    page_offset: Math.max(0, page - 1) * pageSize,
  });

  if (error) {
    logDev("work history page rpc failed", error);
    return { status: "error", message: error.message };
  }

  const rows = (data ?? []) as WorkHistoryPageRow[];
  const entries: ProjectMemberWorkHistoryEntry[] = rows.map((row) => ({
    ticketId: row.ticket_id,
    ticketKey: `${projectCode}-${row.ticket_number}`,
    title: row.title,
    status: STATUS_FROM_DB[row.status] ?? "backlog",
    priority: row.priority as TicketPriority,
    hours: Math.round(row.hours * 10) / 10,
    activityCount: row.activity_count,
    lastActivityLabel: formatRelativeTime(row.last_activity_at),
  }));

  return { status: "ready", entries };
}

// ── Work History aggregated across every project a Project Lead leads ──────
// Backs only the Project Lead's own global "/time-tracking/team/[userId]/
// work-history" route (project-lead-time-tracking-screen.tsx's Timesheets
// "View →" action, for a row whose member spans more than one of that
// Lead's real led projects and no single Project filter narrows it to one).
// `leadProjectSlugs` here is always the caller's already-resolved real led
// projects (loadLeadProjects) — never picked/guessed by this module.

export type TeamWorkHistoryActivityFilter =
  | "time_logged"
  | "comments"
  | "status_changes"
  | "assignments"
  | "attachments";

// Real ticket_activity event_type values (see buildActivityLabel above for
// the authoritative full list) mapped to each Activity filter option — never
// an invented event type. "Attachments" spans all three real attachment
// events (upload/rename/delete) since the filter has no finer distinction.
const ACTIVITY_FILTER_EVENT_TYPES: Record<TeamWorkHistoryActivityFilter, string[]> = {
  time_logged: ["time_logged", "time_entry_updated", "time_entry_deleted"],
  comments: ["added_a_comment"],
  status_changes: ["status_changed"],
  assignments: ["assignee_changed"],
  attachments: ["attachment_uploaded", "attachment_renamed", "attachment_deleted"],
};

export interface TeamWorkHistoryFilters {
  /** Real led project slug to narrow to, or undefined for every led project. */
  projectSlug?: string;
  /** Case-insensitive substring match against ticket code or title only. */
  search?: string;
  /** Inclusive date-only range — same work_date/created_at convention every
   *  other Period-based feature in this app already uses. */
  period?: { from: string; to: string };
  status?: TicketStatus;
  activity?: TeamWorkHistoryActivityFilter;
}

interface TeamWorkHistoryRow {
  ticketId: string;
  ticketKey: string;
  title: string;
  status: TicketStatus;
  priority: TicketPriority;
  projectSlug: string;
  hours: number;
  activityCount: number;
  lastActivityAt: string;
}

type TeamWorkHistoryRowsResult =
  | { status: "ready"; rows: TeamWorkHistoryRow[] }
  | { status: "error"; message: string };

// Real, all-time participation universe across every given real led
// project — one call to the exact same two RPCs the single-project Work
// History page already uses (never re-derived participation rules), each
// project's own full real ticket_count becoming that project's own
// page_size so every one of this person's matching tickets comes back
// without a second, arbitrary cap.
async function fetchLedProjectParticipationRows(
  organizationId: string,
  slugs: string[],
  profileId: string
): Promise<TeamWorkHistoryRowsResult> {
  if (slugs.length === 0) return { status: "ready", rows: [] };

  const projectResults = await Promise.all(
    slugs.map(async (slug) => ({ slug, result: await resolveWorkHistoryProjectId(organizationId, slug) }))
  );
  const failedProject = projectResults.find((r) => r.result.status === "error");
  if (failedProject && failedProject.result.status === "error") return failedProject.result;
  const projects: { slug: string; projectId: string }[] = [];
  for (const { slug, result } of projectResults) {
    if (result.status === "ready" && result.projectId) projects.push({ slug, projectId: result.projectId });
  }
  if (projects.length === 0) return { status: "ready", rows: [] };

  const supabase = getSupabaseBrowserClient();

  const perProjectRows = await Promise.all(
    projects.map(async ({ slug, projectId }) => {
      const { data: summaryData, error: summaryError } = await supabase
        .rpc("project_member_work_history_summary", { target_project_id: projectId, target_profile_id: profileId })
        .maybeSingle<{ ticket_count: number }>();
      if (summaryError) {
        logDev("team work history participation summary rpc failed", summaryError);
        return { status: "error" as const, message: summaryError.message };
      }
      const ticketCount = summaryData?.ticket_count ?? 0;
      if (ticketCount === 0) return { status: "ready" as const, rows: [] as TeamWorkHistoryRow[] };

      const { data: projectCodeRow, error: projectCodeError } = await supabase
        .from("projects")
        .select("project_code")
        .eq("id", projectId)
        .maybeSingle<{ project_code: string }>();
      if (projectCodeError) {
        logDev("team work history project code lookup failed", projectCodeError);
        return { status: "error" as const, message: projectCodeError.message };
      }
      const projectCode = projectCodeRow?.project_code ?? "";

      const { data, error } = await supabase.rpc("project_member_work_history_page", {
        target_project_id: projectId,
        target_profile_id: profileId,
        page_size: ticketCount,
        page_offset: 0,
      });
      if (error) {
        logDev("team work history participation page rpc failed", error);
        return { status: "error" as const, message: error.message };
      }

      const rows = (data ?? []) as WorkHistoryPageRow[];
      return {
        status: "ready" as const,
        rows: rows.map(
          (row): TeamWorkHistoryRow => ({
            ticketId: row.ticket_id,
            ticketKey: `${projectCode}-${row.ticket_number}`,
            title: row.title,
            status: STATUS_FROM_DB[row.status] ?? "backlog",
            priority: row.priority as TicketPriority,
            projectSlug: slug,
            hours: Math.round(row.hours * 10) / 10,
            activityCount: row.activity_count,
            lastActivityAt: row.last_activity_at,
          })
        ),
      };
    })
  );

  const failedRows = perProjectRows.find((r) => r.status === "error");
  if (failedRows && failedRows.status === "error") return failedRows;

  return { status: "ready", rows: perProjectRows.flatMap((r) => (r.status === "ready" ? r.rows : [])) };
}

export type TeamWorkHistoryProjectOptionsResult =
  | { status: "ready"; projectSlugs: string[] }
  | { status: "error"; message: string };

// Real led-project slugs the Project filter should offer — only the ones
// this exact member has any all-time real participation in (never every
// project the Lead leads regardless of this member's history), independent
// of whatever Search/Period/Status/Activity filters are currently active
// (same "options come from the full scope, not the filtered result"
// convention the rest of this app's filter dropdowns already follow).
export async function loadTeamMemberWorkHistoryProjectOptions(
  organizationId: string,
  leadProjectSlugs: string[],
  profileId: string
): Promise<TeamWorkHistoryProjectOptionsResult> {
  const result = await fetchLedProjectParticipationRows(organizationId, leadProjectSlugs, profileId);
  if (result.status === "error") return result;
  const withRealHistory = result.rows.filter((row) => row.hours > 0 || row.activityCount > 0);
  return { status: "ready", projectSlugs: Array.from(new Set(withRealHistory.map((row) => row.projectSlug))) };
}

// Chunked via chunkArray/ORG_TICKET_ID_BATCH_SIZE — `ticketIds` here is a
// Project Lead's whole led-project participation universe for one team
// member (computeTeamWorkHistoryRows below), which for an active member on
// a large migrated project can realistically exceed 1,000 (1,035 confirmed
// in production for one real member of María José's led projects; 725 for
// her own participation as a member). Reproduced directly against
// production at that scale as a 400. Unlike the paginated/`.order()+.limit()`
// functions elsewhere in this file, this query has no cap of its own — the
// caller aggregates every matching row — so batches are simply concatenated,
// no re-sort/re-slice needed to reproduce the unchunked result.
async function fetchScopedTimeEntryRows(
  supabase: ReturnType<typeof getSupabaseBrowserClient>,
  ticketIds: string[],
  profileId: string,
  period?: { from: string; to: string }
): Promise<{ status: "ready"; rows: { ticket_id: string; minutes: number; created_at: string }[] } | { status: "error"; message: string }> {
  if (ticketIds.length === 0) return { status: "ready", rows: [] };
  const batches = chunkArray(ticketIds, ORG_TICKET_ID_BATCH_SIZE);

  const results = await Promise.all(
    batches.map((batch) => {
      let query = supabase
        .from("ticket_time_entries")
        .select("ticket_id, minutes, created_at")
        .in("ticket_id", batch)
        .eq("logged_by", profileId);
      if (period) query = query.gte("work_date", period.from).lte("work_date", period.to);
      return query.returns<{ ticket_id: string; minutes: number; created_at: string }[]>();
    })
  );

  for (let i = 0; i < results.length; i++) {
    const { error } = results[i];
    if (error) {
      logDev("team work history scoped time entries query failed", {
        batch: i,
        batchSize: batches[i].length,
        message: error.message,
      });
      return { status: "error", message: error.message };
    }
  }

  return { status: "ready", rows: results.flatMap((r) => r.data ?? []) };
}

async function fetchScopedActivityRows(
  supabase: ReturnType<typeof getSupabaseBrowserClient>,
  ticketIds: string[],
  profileId: string,
  period?: { from: string; to: string },
  eventTypes?: string[]
): Promise<{ status: "ready"; rows: { ticket_id: string; created_at: string }[] } | { status: "error"; message: string }> {
  if (ticketIds.length === 0) return { status: "ready", rows: [] };
  const batches = chunkArray(ticketIds, ORG_TICKET_ID_BATCH_SIZE);

  const results = await Promise.all(
    batches.map((batch) => {
      let query = supabase
        .from("ticket_activity")
        .select("ticket_id, created_at")
        .in("ticket_id", batch)
        .eq("actor_profile_id", profileId);
      if (eventTypes) query = query.in("event_type", eventTypes);
      if (period) {
        const start = new Date(`${period.from}T00:00:00`);
        const endExclusive = new Date(`${period.to}T00:00:00`);
        endExclusive.setDate(endExclusive.getDate() + 1);
        query = query.gte("created_at", start.toISOString()).lt("created_at", endExclusive.toISOString());
      }
      return query.returns<{ ticket_id: string; created_at: string }[]>();
    })
  );

  for (let i = 0; i < results.length; i++) {
    const { error } = results[i];
    if (error) {
      logDev("team work history scoped activity query failed", {
        batch: i,
        batchSize: batches[i].length,
        message: error.message,
      });
      return { status: "error", message: error.message };
    }
  }

  return { status: "ready", rows: results.flatMap((r) => r.data ?? []) };
}

// Applies every real Work History filter (Project/Search/Period/Status/
// Activity) on top of the real participation universe above, recomputing
// per-ticket hours/activity/last-activity from raw ticket_time_entries/
// ticket_activity rows only when Period or Activity narrows the default
// "All time, All Activity" view (which otherwise stays byte-identical to
// the RPCs' own all-time aggregates — zero drift from the unfiltered
// default). "Time Logged" hours only count while the Activity filter is
// unset or itself "Time Logged" — every other Activity type isn't a time
// entry, so Hours Logged reports 0 rather than a number unrelated to the
// chosen activity type. A ticket only survives with real qualifying hours
// or activity (never zero/zero), matching "Tickets Worked On" below.
async function computeTeamWorkHistoryRows(
  organizationId: string,
  leadProjectSlugs: string[],
  profileId: string,
  filters: TeamWorkHistoryFilters
): Promise<TeamWorkHistoryRowsResult> {
  const scopedSlugs = filters.projectSlug
    ? leadProjectSlugs.filter((slug) => slug === filters.projectSlug)
    : leadProjectSlugs;

  const universe = await fetchLedProjectParticipationRows(organizationId, scopedSlugs, profileId);
  if (universe.status === "error") return universe;

  const search = filters.search?.trim().toLowerCase();
  const candidates = universe.rows.filter((row) => {
    if (filters.status && row.status !== filters.status) return false;
    if (search && !row.ticketKey.toLowerCase().includes(search) && !row.title.toLowerCase().includes(search)) {
      return false;
    }
    return true;
  });

  if (!filters.period && !filters.activity) {
    return {
      status: "ready",
      rows: candidates
        .filter((row) => row.hours > 0 || row.activityCount > 0)
        .sort((a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime()),
    };
  }

  const ticketIds = candidates.map((row) => row.ticketId);
  const supabase = getSupabaseBrowserClient();
  const includeHours = !filters.activity || filters.activity === "time_logged";
  const eventTypes = filters.activity ? ACTIVITY_FILTER_EVENT_TYPES[filters.activity] : undefined;

  const [timeResult, activityResult] = await Promise.all([
    includeHours
      ? fetchScopedTimeEntryRows(supabase, ticketIds, profileId, filters.period)
      : Promise.resolve({ status: "ready" as const, rows: [] }),
    fetchScopedActivityRows(supabase, ticketIds, profileId, filters.period, eventTypes),
  ]);
  if (timeResult.status === "error") return timeResult;
  if (activityResult.status === "error") return activityResult;

  const hoursByTicket = new Map<string, number>();
  const lastByTicket = new Map<string, string>();
  const bumpLast = (ticketId: string, createdAt: string) => {
    const prev = lastByTicket.get(ticketId);
    if (!prev || new Date(createdAt).getTime() > new Date(prev).getTime()) lastByTicket.set(ticketId, createdAt);
  };
  for (const row of timeResult.rows) {
    hoursByTicket.set(row.ticket_id, (hoursByTicket.get(row.ticket_id) ?? 0) + row.minutes / 60);
    bumpLast(row.ticket_id, row.created_at);
  }
  const countByTicket = new Map<string, number>();
  for (const row of activityResult.rows) {
    countByTicket.set(row.ticket_id, (countByTicket.get(row.ticket_id) ?? 0) + 1);
    bumpLast(row.ticket_id, row.created_at);
  }

  const rows: TeamWorkHistoryRow[] = [];
  for (const row of candidates) {
    const hours = Math.round((hoursByTicket.get(row.ticketId) ?? 0) * 10) / 10;
    const activityCount = countByTicket.get(row.ticketId) ?? 0;
    if (hours <= 0 && activityCount <= 0) continue;
    rows.push({ ...row, hours, activityCount, lastActivityAt: lastByTicket.get(row.ticketId) ?? row.lastActivityAt });
  }
  rows.sort((a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime());

  return { status: "ready", rows };
}

export async function loadTeamMemberWorkHistorySummaryAcrossProjects(
  organizationId: string,
  leadProjectSlugs: string[],
  profileId: string,
  filters: TeamWorkHistoryFilters = {}
): Promise<ProjectMemberWorkHistorySummaryResult> {
  const result = await computeTeamWorkHistoryRows(organizationId, leadProjectSlugs, profileId, filters);
  if (result.status === "error") return result;

  const ticketCount = result.rows.length;
  const totalHours = Math.round(result.rows.reduce((sum, row) => sum + row.hours, 0) * 10) / 10;
  const activityCount = result.rows.reduce((sum, row) => sum + row.activityCount, 0);
  // Rows are already sorted most-recent-first.
  const lastActivityLabel = result.rows.length > 0 ? formatRelativeTime(result.rows[0].lastActivityAt) : null;

  return { status: "ready", summary: { ticketCount, totalHours, activityCount, lastActivityLabel } };
}

export async function loadTeamMemberWorkHistoryPageAcrossProjects(
  organizationId: string,
  leadProjectSlugs: string[],
  profileId: string,
  filters: TeamWorkHistoryFilters,
  page: number,
  pageSize: number
): Promise<ProjectMemberWorkHistoryPageResult> {
  const result = await computeTeamWorkHistoryRows(organizationId, leadProjectSlugs, profileId, filters);
  if (result.status === "error") return result;

  const start = Math.max(0, (page - 1) * pageSize);
  const pageRows = result.rows.slice(start, start + pageSize);

  const entries: ProjectMemberWorkHistoryEntry[] = pageRows.map((row) => ({
    ticketId: row.ticketId,
    ticketKey: row.ticketKey,
    title: row.title,
    status: row.status,
    priority: row.priority,
    hours: row.hours,
    activityCount: row.activityCount,
    lastActivityLabel: formatRelativeTime(row.lastActivityAt),
    projectSlug: row.projectSlug,
  }));

  return { status: "ready", entries };
}

// ── Attachments (Ticket Detail) ─────────────────────────────────────────────────
// Real Supabase Storage + a ticket_attachments metadata row per file — upload,
// rename, and delete are all wired to real writes (see uploadTicketAttachment /
// renameTicketAttachment / deleteTicketAttachment below).

const ATTACHMENTS_BUCKET = "ticket-attachments";

// Every attachment/thumbnail object is written once to a uuid-derived path
// and never overwritten (uploadTicketAttachment always mints a fresh
// crypto.randomUUID() prefix) — so a long Cache-Control is safe: there is
// no "stale" version of a given path to ever serve. Cached Egress Phase 3.
const ATTACHMENT_UPLOAD_CACHE_CONTROL = "31536000";

export interface TicketAttachment {
  id: string;
  filename: string;
  storagePath: string;
  sizeBytes: number;
  mimeType: string | null;
  uploadedByName: string;
  uploadedByAvatar: string;
  /** Real profiles.id of the uploader, when known — lets a "click this
   *  person" trigger open the Member Profile Modal against their real
   *  identity instead of a name-based guess. Null when genuinely unknown
   *  (uploaded_by is null). */
  uploadedByProfileId: string | null;
  /** Pre-formatted relative time ("3 days ago") — same convention as TicketComment/TicketActivityEvent. */
  uploadedAt: string;
  /** False only for attachment metadata restored from a Data Only Backup
   *  (see ticket_attachments.is_available) — that backup never included
   *  the physical file, so nothing exists at storagePath in Storage.
   *  True for every attachment created normally and every attachment
   *  restored from a Full Backup. The UI must never attempt a
   *  download/preview when this is false. */
  isAvailable: boolean;
  /** Storage path of the pre-resized (max ~600px wide) derivative
   *  generateAttachmentThumbnail produced at upload time — null for every
   *  non-image attachment and for any image whose thumbnail generation
   *  failed or was skipped (already narrower than the cap). Every inline-
   *  thumbnail consumer resolves this path when present and falls back to
   *  storagePath when it isn't; the full-size preview modal and download
   *  always use storagePath, never this. */
  thumbnailPath: string | null;
}

interface AttachmentRow {
  id: string;
  filename: string;
  storage_path: string;
  size_bytes: number;
  mime_type: string | null;
  uploaded_by: string | null;
  created_at: string;
  is_available: boolean;
  thumbnail_path: string | null;
}

function rowToAttachment(row: AttachmentRow, uploaderRow: AssigneeProfileRow | undefined): TicketAttachment {
  return {
    id: row.id,
    filename: row.filename,
    storagePath: row.storage_path,
    sizeBytes: row.size_bytes,
    mimeType: row.mime_type,
    uploadedByName: resolveProfileName(uploaderRow) ?? "Unknown",
    uploadedByAvatar:
      (uploaderRow ? resolveAvatarUrl(uploaderRow.avatar_url, uploaderRow.updated_at) : null) ?? FALLBACK_AVATAR,
    uploadedByProfileId: row.uploaded_by,
    uploadedAt: formatRelativeTime(row.created_at),
    isAvailable: row.is_available,
    thumbnailPath: row.thumbnail_path,
  };
}

export type TicketAttachmentsResult =
  | { status: "ready"; attachments: TicketAttachment[] }
  | { status: "error"; message: string };

// Newest first — matches the section's existing "most recent upload on
// top" convention (see AttachmentsSection's setAttachments prepend logic).
// Ticket-level only (comment_id IS NULL) — attachments posted on a comment
// belong to that comment's own display inside loadTicketComments instead,
// so they're excluded here to avoid showing (or counting) them twice.
export async function loadTicketAttachments(ticketId: string): Promise<TicketAttachmentsResult> {
  const supabase = getSupabaseBrowserClient();

  const { data: rows, error } = await supabase
    .from("ticket_attachments")
    .select("id, filename, storage_path, size_bytes, mime_type, uploaded_by, created_at, is_available, thumbnail_path")
    .eq("ticket_id", ticketId)
    .is("comment_id", null)
    .order("created_at", { ascending: false })
    .returns<AttachmentRow[]>();

  if (error) {
    logDev("ticket attachments query failed", error);
    return { status: "error", message: error.message };
  }

  const uploaderIds = Array.from(
    new Set((rows ?? []).map((row) => row.uploaded_by).filter((id): id is string => Boolean(id)))
  );
  const uploadersById = await loadProfilesByIds(supabase, uploaderIds);

  const attachments = (rows ?? []).map((row) =>
    rowToAttachment(row, row.uploaded_by ? uploadersById.get(row.uploaded_by) : undefined)
  );

  return { status: "ready", attachments };
}

export type UploadTicketAttachmentResult =
  | { status: "success"; attachment: TicketAttachment }
  | { status: "error"; message: string };

// Storage path is "<ticket_id>/<uuid>-<sanitized filename>" — the leading
// ticket_id segment is exactly what the Storage RLS policies check via
// storage.foldername(name), so the path and the policies stay in lockstep.
// uploaded_by is never sent here — the column defaults to auth.uid() at
// the database level, so it can't be spoofed from the client.
//
// commentId is optional and only ever passed by the comment composer (see
// createTicketComment's caller in ticket-detail-screen.tsx) — omitting it
// (the general AttachmentsSection's call site) keeps comment_id null,
// i.e. a ticket-level attachment, exactly as before. Same insert, same
// RLS policy, same "attachment_uploaded" activity trigger either way —
// comment_id is just another column on the same row.
export async function uploadTicketAttachment(
  ticketId: string,
  file: File,
  commentId?: string
): Promise<UploadTicketAttachmentResult> {
  const supabase = getSupabaseBrowserClient();

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const uniquePrefix = crypto.randomUUID();
  const storagePath = `${ticketId}/${uniquePrefix}-${safeName}`;

  const { error: uploadError } = await supabase.storage
    .from(ATTACHMENTS_BUCKET)
    .upload(storagePath, file, { cacheControl: ATTACHMENT_UPLOAD_CACHE_CONTROL });

  if (uploadError) {
    logDev("attachment storage upload failed", uploadError);
    return { status: "error", message: uploadError.message };
  }

  // Best-effort, non-image-skipping, and never allowed to fail the upload
  // itself — a thumbnail is purely an egress optimization for later reads,
  // not something the original upload should ever depend on. Path is
  // deterministically derived from the original's own uuid+filename, just
  // under a "thumbnails/" subfolder (still "<ticket_id>/..." as its first
  // segment, so it's covered by the same Storage RLS policies with no
  // changes needed there).
  let thumbnailPath: string | null = null;
  try {
    const thumbnail = await generateAttachmentThumbnail(file);
    if (thumbnail) {
      const candidatePath = `${ticketId}/thumbnails/${uniquePrefix}-${safeName}.${thumbnail.ext}`;
      const { error: thumbnailUploadError } = await supabase.storage
        .from(ATTACHMENTS_BUCKET)
        .upload(candidatePath, thumbnail.blob, {
          contentType: thumbnail.blob.type,
          cacheControl: ATTACHMENT_UPLOAD_CACHE_CONTROL,
        });
      if (thumbnailUploadError) {
        logDev("attachment thumbnail upload failed", thumbnailUploadError);
      } else {
        thumbnailPath = candidatePath;
      }
    }
  } catch (err) {
    logDev("attachment thumbnail generation failed", err);
  }

  const { data: row, error: insertError } = await supabase
    .from("ticket_attachments")
    .insert({
      ticket_id: ticketId,
      comment_id: commentId ?? null,
      storage_path: storagePath,
      filename: file.name,
      size_bytes: file.size,
      mime_type: file.type || null,
      thumbnail_path: thumbnailPath,
    })
    .select("id, filename, storage_path, size_bytes, mime_type, uploaded_by, created_at, is_available, thumbnail_path")
    .single<AttachmentRow>();

  if (insertError) {
    logDev("attachment record insert failed", insertError);
    // Best-effort cleanup — don't leave an orphaned Storage object with no
    // corresponding row if the insert failed after the upload succeeded.
    const orphanedPaths = attachmentPathsToRemove(storagePath, thumbnailPath);
    const { data: removed, error: cleanupError } = await supabase.storage.from(ATTACHMENTS_BUCKET).remove(orphanedPaths);
    const unremovedPaths = findUnremovedPaths(orphanedPaths, removed);
    if (cleanupError || unremovedPaths.length > 0) {
      logDev("attachment upload cleanup failed — orphaned Storage objects left behind", cleanupError ?? unremovedPaths);
    }
    return { status: "error", message: insertError.message };
  }

  let uploaderRow: AssigneeProfileRow | undefined;
  if (row.uploaded_by) {
    const { data: profileRow, error: profileError } = await supabase
      .from("profiles")
      .select("id, first_name, last_name, avatar_url, updated_at")
      .eq("id", row.uploaded_by)
      .maybeSingle<AssigneeProfileRow>();
    if (profileError) {
      logDev("uploader profile lookup failed", profileError);
    } else {
      uploaderRow = profileRow ?? undefined;
    }
  }

  if (row.uploaded_by) {
    void notifyTicketAttachmentAdded(supabase, ticketId, row.uploaded_by, row.filename, uploaderRow).catch((err) => {
      logDev("ticket attachment notify failed", err);
    });
  }

  return { status: "success", attachment: rowToAttachment(row, uploaderRow) };
}

// Fans an attachment upload out to this ticket's remaining subscribers
// (excluding the uploader). The uploader is deliberately not auto-subscribed
// here — attaching a file isn't in the task's list of subscribe-triggering
// interactions (create/assign/comment/mention/log-time), unlike every other
// notifyTicketAttachmentAdded-adjacent write in this file.
async function notifyTicketAttachmentAdded(
  supabase: ReturnType<typeof getSupabaseBrowserClient>,
  ticketId: string,
  uploaderProfileId: string,
  filename: string,
  uploaderRow: AssigneeProfileRow | undefined
): Promise<void> {
  const alreadyNotified = new Set<string>([uploaderProfileId]);
  const subscriberIds = await loadRemainingTicketSubscribers(supabase, ticketId, alreadyNotified);
  if (subscriberIds.length === 0) return;

  const { data: ticketRow, error: ticketError } = await supabase
    .from("tickets")
    .select("project_id, ticket_number")
    .eq("id", ticketId)
    .maybeSingle<{ project_id: string; ticket_number: number }>();

  if (ticketError || !ticketRow) return;

  const { data: projectRow, error: projectError } = await supabase
    .from("projects")
    .select("id, organization_id, project_code")
    .eq("id", ticketRow.project_id)
    .maybeSingle<{ id: string; organization_id: string; project_code: string }>();

  if (projectError || !projectRow) return;

  const ticketCode = `${projectRow.project_code}-${ticketRow.ticket_number}`;
  const uploaderName = resolveProfileName(uploaderRow) ?? "Someone";

  await Promise.all(
    subscriberIds.map((recipientProfileId) =>
      createNotification({
        organizationId: projectRow.organization_id,
        recipientProfileId,
        actorProfileId: uploaderProfileId,
        type: "ticket_attachment_added",
        title: `${uploaderName} added an attachment on ${ticketCode}`,
        message: filename,
        projectId: projectRow.id,
        ticketId,
      })
    )
  );
}

export type DownloadTicketAttachmentResult =
  | { status: "success" }
  | { status: "error"; message: string };

// The bucket is private, so a plain public URL doesn't work — this fetches
// the object through the authenticated client (same ticket_attachments_
// storage_select RLS policy that already gates loadTicketAttachments) and
// saves it via a temporary object URL, so the browser downloads it with its
// original filename regardless of the randomized storage path.
export async function downloadTicketAttachment(
  storagePath: string,
  filename: string
): Promise<DownloadTicketAttachmentResult> {
  const supabase = getSupabaseBrowserClient();

  const { data: blob, error } = await supabase.storage.from(ATTACHMENTS_BUCKET).download(storagePath);

  if (error || !blob) {
    logDev("attachment download failed", error);
    return { status: "error", message: error?.message ?? "Download failed" };
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);

  return { status: "success" };
}

export type TicketAttachmentPreviewUrlResult =
  | { status: "success"; url: string }
  | { status: "error"; message: string };

// The bucket is private, so previewing (embedding in an <img>/<iframe>)
// needs a signed URL rather than getPublicUrl — createSignedUrl is gated by
// the same ticket_attachments_storage_select RLS policy that already
// authorizes loadTicketAttachments/downloadTicketAttachment for this object.
// 3600s (Cached Egress Phase 3, up from an earlier 300s) — long enough that
// a ticket left open for a while doesn't re-sign the same object, while the
// in-memory cache below still expires (and re-signs) well before this.
export async function getTicketAttachmentPreviewUrl(storagePath: string): Promise<TicketAttachmentPreviewUrlResult> {
  const supabase = getSupabaseBrowserClient();

  const { data, error } = await supabase.storage.from(ATTACHMENTS_BUCKET).createSignedUrl(storagePath, 3600);

  if (error || !data) {
    logDev("attachment preview signed url failed", error);
    return { status: "error", message: error?.message ?? "Preview failed" };
  }

  return { status: "success", url: data.signedUrl };
}

// Every attachment preview consumer (a comment's own inline attachments,
// the "Attachments from comments" overview, the preview modal, and the
// ticket preview panel) can render the very same storagePath at the same
// time — without this, each one calls getTicketAttachmentPreviewUrl
// independently and gets back a *different* signed URL (different token)
// for the same object, so the browser can't reuse its HTTP cache and the
// file is downloaded again per instance. Routing all of them through this
// cache instead means concurrent/duplicate renders share one in-flight
// request and, once resolved, the exact same URL string — letting the
// browser's own cache (see the object's Cache-Control from upload) satisfy
// the repeat instance for free. 55 minutes — comfortably under the 3600s
// createSignedUrl expiration above (both here and on the thumbnail
// resolver's own cache further down) so a cached entry is never handed out
// past the point Supabase would already reject it.
const TICKET_ATTACHMENT_PREVIEW_URL_TTL_MS = 55 * 60 * 1000;
const ticketAttachmentPreviewUrlCache = new Map<
  string,
  { promise: Promise<TicketAttachmentPreviewUrlResult>; fetchedAt: number }
>();

export function resolveTicketAttachmentPreviewUrl(storagePath: string): Promise<TicketAttachmentPreviewUrlResult> {
  const cached = ticketAttachmentPreviewUrlCache.get(storagePath);
  if (cached && Date.now() - cached.fetchedAt < TICKET_ATTACHMENT_PREVIEW_URL_TTL_MS) {
    return cached.promise;
  }

  const promise = getTicketAttachmentPreviewUrl(storagePath);
  ticketAttachmentPreviewUrlCache.set(storagePath, { promise, fetchedAt: Date.now() });
  // An error isn't worth remembering for the full TTL — the next mount
  // should get a fresh attempt rather than a cached failure.
  promise.then((result) => {
    if (result.status === "error") ticketAttachmentPreviewUrlCache.delete(storagePath);
  });
  return promise;
}

// Inline thumbnails (the small image rows rendered in the Attachments
// section, a comment's own attachments, "Attachments from comments", and
// the Ticket Preview panel) never need the full original. Rather than
// asking Supabase to transform the original on the fly (Image
// Transformations — dropped: it requires a project-level feature/plan this
// app can't assume is enabled, confirmed live by a correctly-formed
// createSignedUrl(..., { transform }) call never coming back under
// /render/image/sign/), uploadTicketAttachment below generates and stores a
// real, separate, width-capped derivative object at upload time; this just
// signs whichever object is the right one for the context — the physical
// thumbnail when one exists, the original when it doesn't (non-image
// attachments, or any image where thumbnail generation failed/was skipped).
// This is a *distinct* object from the one getTicketAttachmentPreviewUrl
// signs — never shares a cache entry with it (see the separate cache
// below): reusing one URL for the other context would either hand the
// full-size modal a downscaled image or hand a thumbnail row a needlessly
// heavy original.
export async function getTicketAttachmentThumbnailUrl(
  storagePath: string,
  thumbnailPath: string | null
): Promise<TicketAttachmentPreviewUrlResult> {
  const supabase = getSupabaseBrowserClient();
  const targetPath = thumbnailPath ?? storagePath;

  const { data, error } = await supabase.storage.from(ATTACHMENTS_BUCKET).createSignedUrl(targetPath, 3600);

  if (error || !data) {
    logDev("attachment thumbnail signed url failed", error);
    return { status: "error", message: error?.message ?? "Preview failed" };
  }

  return { status: "success", url: data.signedUrl };
}

// Mirrors resolveTicketAttachmentPreviewUrl's dedupe/TTL strategy exactly,
// but keyed into its own Map — deliberately never the same cache as the
// original-URL one above, so a thumbnail render can never be served the
// original (defeating the point of a separate, smaller object) and the
// full-size preview modal can never be served the downscaled thumbnail by
// mistake. Keyed by whichever path is actually being signed (thumbnailPath
// when present, storagePath otherwise) — that's the real identity for
// dedup purposes, and it can never collide with a different attachment's
// key since thumbnailPath/storagePath are both unique per object.
const ticketAttachmentThumbnailUrlCache = new Map<
  string,
  { promise: Promise<TicketAttachmentPreviewUrlResult>; fetchedAt: number }
>();

export function resolveTicketAttachmentThumbnailUrl(
  storagePath: string,
  thumbnailPath: string | null
): Promise<TicketAttachmentPreviewUrlResult> {
  const cacheKey = thumbnailPath ?? storagePath;
  const cached = ticketAttachmentThumbnailUrlCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < TICKET_ATTACHMENT_PREVIEW_URL_TTL_MS) {
    return cached.promise;
  }

  const promise = getTicketAttachmentThumbnailUrl(storagePath, thumbnailPath);
  ticketAttachmentThumbnailUrlCache.set(cacheKey, { promise, fetchedAt: Date.now() });
  promise.then((result) => {
    if (result.status === "error") ticketAttachmentThumbnailUrlCache.delete(cacheKey);
  });
  return promise;
}

export type RenameTicketAttachmentResult =
  | { status: "success" }
  | { status: "error"; message: string };

// Updates only the ticket_attachments.filename column — storage_path (the
// actual Storage object key) is deliberately never touched, since filename
// is already tracked separately from it (see uploadTicketAttachment above).
export async function renameTicketAttachment(
  attachmentId: string,
  filename: string
): Promise<RenameTicketAttachmentResult> {
  const supabase = getSupabaseBrowserClient();

  // .select() after .update() is required to actually detect a denied
  // write: PostgREST reports an UPDATE that RLS silently matched zero rows
  // on as a normal success with no error, so without this the UI would show
  // the new name and then have it quietly revert on refresh.
  const { data, error } = await supabase
    .from("ticket_attachments")
    .update({ filename })
    .eq("id", attachmentId)
    .select("id");

  if (error) {
    logDev("attachment rename failed", error);
    return { status: "error", message: error.message };
  }
  if (!data || data.length === 0) {
    logDev("attachment rename failed", "update matched no row (RLS denied or attachment no longer exists)");
    return { status: "error", message: "You don't have permission to rename this attachment." };
  }

  return { status: "success" };
}

export type DeleteTicketAttachmentResult =
  | { status: "success" }
  | { status: "error"; message: string };

// Deletes the metadata row first — that row is what the Attachments list
// (and "does it reappear after refresh") actually depends on. The Storage
// object is then removed best-effort: if that second step fails, the row is
// still gone, matching the UI, leaving at worst an orphaned Storage object
// rather than a row that points at a missing file.
export async function deleteTicketAttachment(
  attachmentId: string,
  storagePath: string,
  thumbnailPath: string | null
): Promise<DeleteTicketAttachmentResult> {
  const supabase = getSupabaseBrowserClient();

  // Same reasoning as renameTicketAttachment above: .select() is required to
  // tell "deleted" apart from "RLS silently matched zero rows."
  const { data, error } = await supabase.from("ticket_attachments").delete().eq("id", attachmentId).select("id");

  if (error) {
    logDev("attachment delete failed", error);
    return { status: "error", message: error.message };
  }
  if (!data || data.length === 0) {
    logDev("attachment delete failed", "delete matched no row (RLS denied or attachment already gone)");
    return { status: "error", message: "You don't have permission to delete this attachment." };
  }

  const pathsToRemove = attachmentPathsToRemove(storagePath, thumbnailPath);
  const { data: removed, error: storageError } = await supabase.storage.from(ATTACHMENTS_BUCKET).remove(pathsToRemove);
  // remove() reports an RLS-filtered object as success with nothing in
  // `removed` — checking `storageError` alone is what hid the broken
  // Storage delete policy (fixed in 20260930110000).
  const unremovedPaths = findUnremovedPaths(pathsToRemove, removed);
  if (storageError || unremovedPaths.length > 0) {
    // The row is already gone (and the UI already reflects that) — log for
    // visibility but don't surface this as a failure of the delete action.
    logDev("attachment storage cleanup failed — orphaned Storage objects left behind", storageError ?? unremovedPaths);
  }

  return { status: "success" };
}

// ── Related Tickets (Ticket Detail) ─────────────────────────────────────────────
// Real ticket_relations rows — the "+ Link" control, relation-kind selector,
// and search previously did nothing (search results were hardcoded empty,
// links only lived in local React state). Only 3 canonical kinds are ever
// stored ('related_to' | 'blocks' | 'duplicates'); the 5 UI-facing kinds are
// derived per-perspective (see loadTicketRelations) — this is what keeps the
// inverse relation (Blocks ↔ Is blocked by, Duplicates ↔ Is duplicated by)
// automatically correct, since there's only ever one row per relation to
// get out of sync.

export type TicketRelationKind = "related-to" | "blocks" | "blocked-by" | "duplicates" | "duplicated-by";

export interface RelatedTicket {
  linkId: string;
  kind: TicketRelationKind;
  ticket: Ticket;
}

interface TicketRelationRow {
  id: string;
  ticket_id: string;
  related_ticket_id: string;
  kind: string;
  created_at: string;
}

export type TicketRelationsResult =
  | { status: "ready"; relations: RelatedTicket[] }
  | { status: "error"; message: string };

// Newest first, same convention as the rest of Ticket Detail's lists.
export async function loadTicketRelations(ticketId: string, slug: string): Promise<TicketRelationsResult> {
  const supabase = getSupabaseBrowserClient();

  const { data: rows, error } = await supabase
    .from("ticket_relations")
    .select("id, ticket_id, related_ticket_id, kind, created_at")
    .or(`ticket_id.eq.${ticketId},related_ticket_id.eq.${ticketId}`)
    .order("created_at", { ascending: false })
    .returns<TicketRelationRow[]>();

  if (error) {
    logDev("ticket relations query failed", error);
    return { status: "error", message: error.message };
  }

  if (!rows || rows.length === 0) return { status: "ready", relations: [] };

  const otherIds = Array.from(
    new Set(rows.map((r) => (r.ticket_id === ticketId ? r.related_ticket_id : r.ticket_id)))
  );

  const { data: ticketRows, error: ticketsError } = await supabase
    .from("tickets")
    .select(TICKET_COLUMNS)
    .in("id", otherIds)
    .returns<TicketRow[]>();

  if (ticketsError) {
    logDev("related tickets query failed", ticketsError);
    return { status: "error", message: ticketsError.message };
  }

  const assigneeIds = Array.from(
    new Set((ticketRows ?? []).map((r) => r.assignee_profile_id).filter((id): id is string => Boolean(id)))
  );
  const assigneesById = await loadProfilesByIds(supabase, assigneeIds);

  const ticketsById = new Map(
    (ticketRows ?? []).map((row) => [
      row.id,
      rowToTicket(row, slug, row.assignee_profile_id ? assigneesById.get(row.assignee_profile_id) : undefined),
    ])
  );

  const relations: RelatedTicket[] = rows
    .map((r): RelatedTicket | undefined => {
      const isForward = r.ticket_id === ticketId;
      const otherId = isForward ? r.related_ticket_id : r.ticket_id;
      const ticket = ticketsById.get(otherId);
      if (!ticket) return undefined;

      let kind: TicketRelationKind;
      if (r.kind === "blocks") kind = isForward ? "blocks" : "blocked-by";
      else if (r.kind === "duplicates") kind = isForward ? "duplicates" : "duplicated-by";
      else kind = "related-to";

      return { linkId: r.id, kind, ticket };
    })
    .filter((x): x is RelatedTicket => x !== undefined);

  return { status: "ready", relations };
}

const RELATION_KIND_TO_DB: Record<TicketRelationKind, "related_to" | "blocks" | "duplicates"> = {
  "related-to":    "related_to",
  "blocks":        "blocks",
  "blocked-by":    "blocks",
  "duplicates":    "duplicates",
  "duplicated-by": "duplicates",
};

export type CreateTicketRelationResult =
  | { status: "success" }
  | { status: "error"; message: string };

export async function createTicketRelation(
  ticketId: string,
  otherTicketId: string,
  kind: TicketRelationKind
): Promise<CreateTicketRelationResult> {
  if (ticketId === otherTicketId) {
    return { status: "error", message: "A ticket can't be related to itself." };
  }

  const dbKind = RELATION_KIND_TO_DB[kind];

  // Normalize direction into the one canonical row this relation is stored
  // as: "blocked-by"/"duplicated-by" mean the OTHER ticket is the one doing
  // the blocking/duplicating, so the row is stored from its side instead.
  // "related-to" is symmetric, so it's always stored in a fixed (sorted)
  // order regardless of which ticket initiated it — otherwise requesting
  // the same relation from either ticket would create two different rows
  // instead of colliding on the unique constraint below.
  let fromId = ticketId;
  let toId = otherTicketId;
  if (kind === "blocked-by" || kind === "duplicated-by") {
    fromId = otherTicketId;
    toId = ticketId;
  } else if (kind === "related-to") {
    [fromId, toId] = [ticketId, otherTicketId].sort();
  }

  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase
    .from("ticket_relations")
    .insert({ ticket_id: fromId, related_ticket_id: toId, kind: dbKind });

  if (error) {
    logDev("ticket relation creation failed", error);
    // Postgres unique_violation — ticket_relations_unique already caught this.
    if (error.code === "23505") {
      return { status: "error", message: "These tickets are already related." };
    }
    return { status: "error", message: error.message };
  }

  return { status: "success" };
}

export type DeleteTicketRelationResult =
  | { status: "success" }
  | { status: "error"; message: string };

export async function deleteTicketRelation(linkId: string): Promise<DeleteTicketRelationResult> {
  const supabase = getSupabaseBrowserClient();

  const { data, error } = await supabase.from("ticket_relations").delete().eq("id", linkId).select("id");

  if (error) {
    logDev("ticket relation delete failed", error);
    return { status: "error", message: error.message };
  }
  if (!data || data.length === 0) {
    logDev("ticket relation delete failed", "delete matched no row (RLS denied or link already gone)");
    return { status: "error", message: "You don't have permission to remove this link." };
  }

  return { status: "success" };
}

// ── Time Tracking (Ticket Detail) ───────────────────────────────────────────────
// Real ticket_time_entries rows — the "Log Time" flow previously only
// appended to local React state (nothing persisted, and the modal's Date
// field defaulted to a hardcoded mock date). Minutes are the canonical
// stored unit (not a float "hours" value) to avoid floating-point drift
// when several entries are summed — hours-for-display is derived at the
// UI mapping layer in ticket-detail-screen.tsx.

export interface TimeEntryRecord {
  id: string;
  minutes: number;
  comment: string;
  /** ISO date (yyyy-mm-dd) the work was done on. */
  workDate: string;
  loggedByName: string;
  loggedByAvatar: string;
  /** Real profiles.id of who logged this entry, when known — lets the UI
   *  restrict edit/delete to the entry's own real author (re-enforced at
   *  the database level regardless by ticket_time_entries_update/_delete
   *  RLS, 20260913000000). Null exactly when logged_by itself is null. */
  loggedByProfileId: string | null;
}

interface TimeEntryRow {
  id: string;
  minutes: number;
  comment: string | null;
  work_date: string;
  logged_by: string | null;
  created_at: string;
}

function rowToTimeEntryRecord(row: TimeEntryRow, loggerRow: AssigneeProfileRow | undefined): TimeEntryRecord {
  return {
    id: row.id,
    minutes: row.minutes,
    comment: row.comment ?? "",
    workDate: row.work_date,
    loggedByName: resolveProfileName(loggerRow) ?? "Unknown",
    loggedByAvatar:
      (loggerRow ? resolveAvatarUrl(loggerRow.avatar_url, loggerRow.updated_at) : null) ?? FALLBACK_AVATAR,
    loggedByProfileId: row.logged_by,
  };
}

export type TicketTimeEntriesResult =
  | { status: "ready"; entries: TimeEntryRecord[] }
  | { status: "error"; message: string };

// Newest-logged first — matches the section's existing "prepend on log"
// convention (see TicketDetailScreen's addEntry).
export async function loadTicketTimeEntries(ticketId: string): Promise<TicketTimeEntriesResult> {
  const supabase = getSupabaseBrowserClient();

  const { data: rows, error } = await supabase
    .from("ticket_time_entries")
    .select("id, minutes, comment, work_date, logged_by, created_at")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: false })
    .returns<TimeEntryRow[]>();

  if (error) {
    logDev("ticket time entries query failed", error);
    return { status: "error", message: error.message };
  }

  const loggerIds = Array.from(
    new Set((rows ?? []).map((row) => row.logged_by).filter((id): id is string => Boolean(id)))
  );
  const loggersById = await loadProfilesByIds(supabase, loggerIds);

  const entries = (rows ?? []).map((row) =>
    rowToTimeEntryRecord(row, row.logged_by ? loggersById.get(row.logged_by) : undefined)
  );

  return { status: "ready", entries };
}

export interface ProfileTimeEntryRecord extends TimeEntryRecord {
  ticketId: string;
}

export type ProfileTimeEntriesResult =
  | { status: "ready"; entries: ProfileTimeEntryRecord[] }
  | { status: "error"; message: string };

// Real cross-ticket time entries for one profile, scoped to a given set of
// ticket ids (e.g. every ticket they're assigned to) — same row shape and
// rowToTimeEntryRecord mapping as loadTicketTimeEntries above, reused as-is,
// just filtered by logged_by + a ticket_id set instead of a single ticket.
// Backs My Work's own Personal Timesheet panel, the one place in the app
// that needs "all of one person's own logged entries across many tickets."
//
// Chunked via chunkArray/ORG_TICKET_ID_BATCH_SIZE — a profile assigned
// across many projects (e.g. a Project Lead who's also staffed as an
// individual contributor — 725 assigned tickets in production as of this
// fix) pushes ticketIds well past the single-GET-URL safe size; reproduced
// directly against production (725 ids, ~27KB URL) as a 400. Same "fetch
// each batch's own top-`limit` rows, merge, re-sort, re-slice to `limit`"
// shape as loadOrganizationActivity above — any row belonging in the true
// top-`limit` across the full ticketIds set necessarily ranks within its
// own batch's top-`limit` too (removing other batches' rows can only help
// a row's rank), so this reproduces exactly what one unchunked query would
// have returned.
export async function loadProfileTimeEntries(
  profileId: string,
  ticketIds: string[],
  limit = 20
): Promise<ProfileTimeEntriesResult> {
  if (ticketIds.length === 0) return { status: "ready", entries: [] };

  const supabase = getSupabaseBrowserClient();
  const batches = chunkArray(ticketIds, ORG_TICKET_ID_BATCH_SIZE);

  const batchResults = await Promise.all(
    batches.map((batch) =>
      supabase
        .from("ticket_time_entries")
        .select("id, minutes, comment, work_date, logged_by, created_at, ticket_id")
        .eq("logged_by", profileId)
        .in("ticket_id", batch)
        .order("created_at", { ascending: false })
        .limit(limit)
        .returns<(TimeEntryRow & { ticket_id: string })[]>()
    )
  );

  for (let i = 0; i < batchResults.length; i++) {
    const { error } = batchResults[i];
    if (error) {
      logDev("profile time entries query failed", {
        batch: i,
        batchSize: batches[i].length,
        message: error.message,
      });
      return { status: "error", message: error.message };
    }
  }

  const rows = batchResults
    .flatMap((result) => result.data ?? [])
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
    .slice(0, limit);

  // logged_by is always this same profile (filtered above), so the logger's
  // own profile row only needs to be resolved once, not per-row.
  const { data: profileRow, error: profileError } = await supabase
    .from("profiles")
    .select("id, first_name, last_name, avatar_url, updated_at")
    .eq("id", profileId)
    .maybeSingle<AssigneeProfileRow>();
  if (profileError) {
    logDev("profile lookup for time entries failed", profileError);
  }

  const entries: ProfileTimeEntryRecord[] = rows.map((row) => ({
    ...rowToTimeEntryRecord(row, profileRow ?? undefined),
    ticketId: row.ticket_id,
  }));

  return { status: "ready", entries };
}

export type ProfileTimeEntriesForRangeResult =
  | { status: "ready"; entries: ProfileTimeEntryRecord[] }
  | { status: "error"; message: string };

// JIR-113 — a Member's personal Hours Report (Reports → Hours Report;
// originally JIR-77's My Work "Hours" tab, since removed): every one of this
// profile's own
// logged time entries whose work_date falls within
// [startDateISO, endDateISO] (inclusive), across a given ticket_id scope.
// Same row shape/rowToTimeEntryRecord mapping and the same
// chunkArray/ORG_TICKET_ID_BATCH_SIZE batching as loadProfileTimeEntries
// just above — reused, not reimplemented; the only real differences are a
// work_date range filter in place of a row-count `limit` (a person's own
// entries within an explicit date window are already inherently bounded,
// so no cap is applied here), and sorting by work_date — the date the
// work was actually performed — rather than created_at (when the row was
// written), since "newest first" here means the most recent workday.
//
// `logged_by = profileId` is the only real access boundary this needs:
// every ticketId a caller passes must already be one this same profile can
// see (the same RLS-scoped ticket list every other My Work section reads
// from — see loadOrganizationTickets), so this can never surface another
// user's hours or a ticket from an inaccessible project.
export async function loadProfileTimeEntriesForRange(
  profileId: string,
  ticketIds: string[],
  startDateISO: string,
  endDateISO: string
): Promise<ProfileTimeEntriesForRangeResult> {
  if (ticketIds.length === 0) return { status: "ready", entries: [] };

  const supabase = getSupabaseBrowserClient();
  const batches = chunkArray(ticketIds, ORG_TICKET_ID_BATCH_SIZE);

  const batchResults = await Promise.all(
    batches.map((batch) =>
      supabase
        .from("ticket_time_entries")
        .select("id, minutes, comment, work_date, logged_by, created_at, ticket_id")
        .eq("logged_by", profileId)
        .in("ticket_id", batch)
        .gte("work_date", startDateISO)
        .lte("work_date", endDateISO)
        .order("work_date", { ascending: false })
        .order("created_at", { ascending: false })
        .returns<(TimeEntryRow & { ticket_id: string })[]>()
    )
  );

  for (let i = 0; i < batchResults.length; i++) {
    const { error } = batchResults[i];
    if (error) {
      logDev("profile time entries range query failed", {
        batch: i,
        batchSize: batches[i].length,
        message: error.message,
      });
      return { status: "error", message: error.message };
    }
  }

  const rows = batchResults
    .flatMap((result) => result.data ?? [])
    .sort((a, b) => {
      if (a.work_date !== b.work_date) return a.work_date < b.work_date ? 1 : -1;
      return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;
    });

  // logged_by is always this same profile (filtered above), so the logger's
  // own profile row only needs to be resolved once, not per-row.
  const { data: profileRow, error: profileError } = await supabase
    .from("profiles")
    .select("id, first_name, last_name, avatar_url, updated_at")
    .eq("id", profileId)
    .maybeSingle<AssigneeProfileRow>();
  if (profileError) {
    logDev("profile lookup for time entries range failed", profileError);
  }

  const entries: ProfileTimeEntryRecord[] = rows.map((row) => ({
    ...rowToTimeEntryRecord(row, profileRow ?? undefined),
    ticketId: row.ticket_id,
  }));

  return { status: "ready", entries };
}

export interface LogTimeInput {
  /** Must be > 0 — normalized from the modal's separate hours/minutes fields. */
  minutes: number;
  comment?: string;
  /** ISO date (yyyy-mm-dd) — the user's local "today" by default, never a fixed/mock date. */
  workDate: string;
}

export type LogTimeResult =
  | { status: "success"; entry: TimeEntryRecord }
  | { status: "error"; message: string };

export async function logTicketTime(ticketId: string, input: LogTimeInput): Promise<LogTimeResult> {
  if (!Number.isFinite(input.minutes) || input.minutes <= 0) {
    return { status: "error", message: "Worked time must be greater than 0." };
  }

  const supabase = getSupabaseBrowserClient();

  // Persisted exactly as entered (the caller's own h*60+m, e.g.
  // LogTimeModal in ticket-detail-screen.tsx) — no rounding of any kind.
  // JIRITA previously force-rounded every logged duration up to the next
  // 15-minute increment here; that was a real product bug (a 3-minute
  // entry silently became 15 minutes) and has been removed. This is the
  // only real time-entry write path (Admin/Project Lead/Member all share
  // this same Ticket Detail component and this same function), so every
  // reader of ticket_time_entries.minutes — totals, Time History, Activity
  // Log — already reflects the real logged duration once this one write
  // stops altering it. Still never reads organizations.time_rounding_minutes/
  // round_time_up (deprecated, unused columns — see lib/membership.ts).
  const { data: row, error } = await supabase
    .from("ticket_time_entries")
    .insert({
      ticket_id: ticketId,
      minutes: input.minutes,
      comment: input.comment?.trim() || null,
      work_date: input.workDate,
    })
    .select("id, minutes, comment, work_date, logged_by, created_at")
    .single<TimeEntryRow>();

  if (error) {
    logDev("log time insert failed", error);
    return { status: "error", message: error.message };
  }

  let loggerRow: AssigneeProfileRow | undefined;
  if (row.logged_by) {
    const { data: profileRow, error: profileError } = await supabase
      .from("profiles")
      .select("id, first_name, last_name, avatar_url, updated_at")
      .eq("id", row.logged_by)
      .maybeSingle<AssigneeProfileRow>();
    if (profileError) {
      logDev("time entry logger profile lookup failed", profileError);
    } else {
      loggerRow = profileRow ?? undefined;
    }
  }

  if (row.logged_by) {
    void subscribeToTicket(supabase, ticketId, row.logged_by).catch((err) => {
      logDev("ticket subscribe (time logger) failed", err);
    });
    void notifyTicketTimeLogged(supabase, ticketId, row.logged_by, row.minutes, loggerRow).catch((err) => {
      logDev("ticket time log notify failed", err);
    });
  }

  return { status: "success", entry: rowToTimeEntryRecord(row, loggerRow) };
}

// Fans a new time entry out to this ticket's remaining subscribers
// (excluding the logger, who's already been subscribed above). Only
// logTicketTime calls this — updateTicketTimeEntry edits an existing
// entry's own minutes/comment/date and never creates a new subscription
// or notification of its own.
async function notifyTicketTimeLogged(
  supabase: ReturnType<typeof getSupabaseBrowserClient>,
  ticketId: string,
  loggerProfileId: string,
  minutes: number,
  loggerRow: AssigneeProfileRow | undefined
): Promise<void> {
  const alreadyNotified = new Set<string>([loggerProfileId]);
  const subscriberIds = await loadRemainingTicketSubscribers(supabase, ticketId, alreadyNotified);
  if (subscriberIds.length === 0) return;

  const { data: ticketRow, error: ticketError } = await supabase
    .from("tickets")
    .select("project_id, ticket_number")
    .eq("id", ticketId)
    .maybeSingle<{ project_id: string; ticket_number: number }>();

  if (ticketError || !ticketRow) return;

  const { data: projectRow, error: projectError } = await supabase
    .from("projects")
    .select("id, organization_id, project_code")
    .eq("id", ticketRow.project_id)
    .maybeSingle<{ id: string; organization_id: string; project_code: string }>();

  if (projectError || !projectRow) return;

  const ticketCode = `${projectRow.project_code}-${ticketRow.ticket_number}`;
  const loggerName = resolveProfileName(loggerRow) ?? "Someone";
  const hours = (minutes / 60).toFixed(minutes % 60 === 0 ? 0 : 2);

  await Promise.all(
    subscriberIds.map((recipientProfileId) =>
      createNotification({
        organizationId: projectRow.organization_id,
        recipientProfileId,
        actorProfileId: loggerProfileId,
        type: "ticket_time_logged",
        title: `${loggerName} logged ${hours}h on ${ticketCode}`,
        message: null,
        projectId: projectRow.id,
        ticketId,
      })
    )
  );
}

// Edits an already-logged time entry's own minutes/comment/work date —
// reachable only for the entry's real logger (ticket_time_entries_update
// RLS, 20260913000000, enforces the same rule again at the database level
// regardless). Same "no rounding of any kind" rule logTicketTime itself
// follows — an edit corrects a specific entry to its real exact duration,
// never re-applies any increment.
export async function updateTicketTimeEntry(entryId: string, input: LogTimeInput): Promise<LogTimeResult> {
  if (!Number.isFinite(input.minutes) || input.minutes <= 0) {
    return { status: "error", message: "Worked time must be greater than 0." };
  }

  const supabase = getSupabaseBrowserClient();

  const { data: row, error } = await supabase
    .from("ticket_time_entries")
    .update({
      minutes: input.minutes,
      comment: input.comment?.trim() || null,
      work_date: input.workDate,
    })
    .eq("id", entryId)
    .select("id, minutes, comment, work_date, logged_by, created_at")
    .maybeSingle<TimeEntryRow>();

  if (error) {
    logDev("time entry update failed", error);
    return { status: "error", message: error.message };
  }
  if (!row) {
    return { status: "error", message: "You can only edit your own time entries." };
  }

  let loggerRow: AssigneeProfileRow | undefined;
  if (row.logged_by) {
    const { data: profileRow, error: profileError } = await supabase
      .from("profiles")
      .select("id, first_name, last_name, avatar_url, updated_at")
      .eq("id", row.logged_by)
      .maybeSingle<AssigneeProfileRow>();
    if (profileError) {
      logDev("time entry logger profile lookup failed", profileError);
    } else {
      loggerRow = profileRow ?? undefined;
    }
  }

  return { status: "success", entry: rowToTimeEntryRecord(row, loggerRow) };
}

export type DeleteTimeEntryResult = { status: "success" } | { status: "error"; message: string };

// Deletes an already-logged time entry — reachable only for the entry's
// real logger (ticket_time_entries_delete RLS, 20260913000000). No
// security-definer RPC needed here (unlike deleteTicketComment): nothing
// references ticket_time_entries.id as a foreign key, so a plain RLS
// delete is never blocked by a cascade the way deleting a parent comment
// with replies from other authors was.
export async function deleteTicketTimeEntry(entryId: string): Promise<DeleteTimeEntryResult> {
  const supabase = getSupabaseBrowserClient();

  // Same reasoning as deleteTicketAttachment above: .select() is required
  // to tell "deleted" apart from "RLS silently matched zero rows."
  const { data, error } = await supabase.from("ticket_time_entries").delete().eq("id", entryId).select("id");

  if (error) {
    logDev("time entry delete failed", error);
    return { status: "error", message: error.message };
  }
  if (!data || data.length === 0) {
    return { status: "error", message: "You can only delete your own time entries." };
  }
  return { status: "success" };
}

// ── Organization-wide reads — backs the real Admin Dashboard only ──────────────
// (src/components/dashboard-screen.tsx). Project Lead's and Member's own
// dashboards are untouched and keep reading their own mock data.

export type OrganizationTicketsResult =
  | {
      status: "ready";
      tickets: Ticket[];
      projects: { slug: string; name: string; status: ProjectStatus }[];
      /** Each project's own real, ordered ticket_statuses — keyed by slug.
       *  The org-wide "all projects" Board (tickets-screen.tsx) needs this
       *  per-project (never a single shared list) since a drag-and-drop
       *  move must resolve its target status_id within that ticket's own
       *  project, not some other project's row with the same name. */
      statusesBySlug: Record<string, TicketStatusOption[]>;
    }
  | { status: "error"; message: string };

// Composes two already-existing loaders (loadOrganizationProjects +
// loadProjectTickets per project) instead of a new direct query, so this
// stays a thin aggregation over data paths that are already real and
// already tested — not a new source of truth for what a "ticket" is. Also
// returns the org's project slug/name/status triples (already fetched here
// anyway) so callers needing a real project display name — e.g. Recent
// Activity's "project" text — or needing to scope to active projects only
// — e.g. Projects at Risk — don't have to issue a second, redundant fetch.
export async function loadOrganizationTickets(organizationId: string): Promise<OrganizationTicketsResult> {
  const projectsResult = await loadOrganizationProjects(organizationId);
  if (projectsResult.status === "error") {
    return { status: "error", message: projectsResult.message };
  }

  const perProject = await Promise.all(
    projectsResult.projects.map((project) => loadProjectTickets(organizationId, project.slug))
  );

  const tickets: Ticket[] = [];
  const statusesBySlug: Record<string, TicketStatusOption[]> = {};
  for (let i = 0; i < perProject.length; i++) {
    const result = perProject[i];
    if (result.status === "error") return { status: "error", message: result.message };
    if (result.status === "ready") {
      tickets.push(...result.tickets);
      statusesBySlug[projectsResult.projects[i].slug] = result.statuses;
    }
  }

  return {
    status: "ready",
    tickets,
    projects: projectsResult.projects.map((project) => ({
      slug: project.slug,
      name: project.name,
      status: project.status,
    })),
    statusesBySlug,
  };
}

// ── Admin Dashboard tickets (JIR-101) ─────────────────────────────────────────
// The Admin Dashboard is a lightweight landing screen (Assigned / Blocked /
// Due Today / Overdue KPIs + My Active Work), so it doesn't use
// loadOrganizationTickets above (left untouched for its other callers): that
// one issues loadOrganizationProjects plus 4 sequential queries *per project*
// and returns full Tickets with every column. This returns only what the
// Dashboard needs, with a fixed number of organization-level queries:
//   1. projects (id/slug/name/status/project_code);
//   2. tickets for every project (paged, 9 small columns), in parallel with
//   3. ticket_statuses (id/group_type) for every project.
// RLS scopes projects/tickets exactly as before. Each field is mapped exactly
// like rowToTicket (status/type fallbacks, statusGroupType from the project's
// real statuses, dueDate display string), project codes are registered for
// getTicketDisplayKey, and order is project order then ticket_number — same
// as loadOrganizationTickets. Projects/tickets query errors fail the call; a
// statuses error degrades to isTicketClosed's status === "done" fallback.
export type AdminDashboardTicket = Pick<
  Ticket,
  "id" | "projectSlug" | "ticketNumber" | "title" | "type" | "status" | "statusGroupType" | "dueDate" | "assigneeProfileId"
> & {
  /** Raw due_date ("YYYY-MM-DD"), or null — `dueDate` is its display string. */
  dueDateISO: string | null;
};

export type AdminDashboardTicketsResult =
  | {
      status: "ready";
      tickets: AdminDashboardTicket[];
      projects: { slug: string; name: string; status: ProjectStatus }[];
    }
  | { status: "error"; message: string };

const ADMIN_DASHBOARD_TICKET_COLUMNS =
  "id, project_id, ticket_number, title, status, status_id, type, assignee_profile_id, due_date";
const ADMIN_DASHBOARD_TICKET_PAGE_SIZE = 1000;

interface AdminDashboardTicketRow {
  id: string;
  project_id: string;
  ticket_number: number;
  title: string;
  status: string;
  status_id: string;
  type: string;
  assignee_profile_id: string | null;
  due_date: string | null;
}

export async function loadAdminDashboardTickets(
  organizationId: string,
  signal?: AbortSignal
): Promise<AdminDashboardTicketsResult> {
  const supabase = getSupabaseBrowserClient();

  let projectsQuery = supabase
    .from("projects")
    .select("id, slug, name, status, project_code")
    .eq("organization_id", organizationId)
    // Same ordering as loadOrganizationProjects (the scope selector's order).
    .order("updated_at", { ascending: false })
    .order("slug", { ascending: true });
  if (signal) projectsQuery = projectsQuery.abortSignal(signal);
  const { data: projectRows, error: projectsError } = await projectsQuery.returns<
    { id: string; slug: string; name: string; status: string; project_code: string }[]
  >();
  if (projectsError) {
    logDev("admin dashboard projects query failed", projectsError);
    return { status: "error", message: projectsError.message };
  }

  const projects = projectRows ?? [];
  for (const project of projects) registerProjectCode(project.slug, project.project_code);
  const projectSummaries = projects.map((project) => ({
    slug: project.slug,
    name: project.name,
    status: projectStatusFromDb(project.status),
  }));
  if (projects.length === 0) return { status: "ready", tickets: [], projects: projectSummaries };

  // Chunked like the ticket-id batches below, so a very large org can never
  // push a single `.in()` past the gateway's max URL length.
  const projectIdBatches = chunkArray(
    projects.map((project) => project.id),
    ORG_TICKET_ID_BATCH_SIZE
  );

  async function loadTicketRows(projectIds: string[]): Promise<{ rows: AdminDashboardTicketRow[] } | { error: string }> {
    const rows: AdminDashboardTicketRow[] = [];
    for (let from = 0; ; from += ADMIN_DASHBOARD_TICKET_PAGE_SIZE) {
      let query = supabase
        .from("tickets")
        .select(ADMIN_DASHBOARD_TICKET_COLUMNS)
        .in("project_id", projectIds)
        .order("project_id", { ascending: true })
        .order("ticket_number", { ascending: true })
        .range(from, from + ADMIN_DASHBOARD_TICKET_PAGE_SIZE - 1);
      if (signal) query = query.abortSignal(signal);
      const { data, error } = await query.returns<AdminDashboardTicketRow[]>();
      if (error) {
        logDev("admin dashboard tickets query failed", error);
        return { error: error.message };
      }
      rows.push(...(data ?? []));
      if (!data || data.length < ADMIN_DASHBOARD_TICKET_PAGE_SIZE) return { rows };
    }
  }

  async function loadStatusGroups(projectIds: string[]): Promise<{ id: string; groupType: "open" | "closed" }[]> {
    let query = supabase.from("ticket_statuses").select("id, group_type").in("project_id", projectIds);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query.returns<{ id: string; group_type: string }[]>();
    if (error) {
      logDev("admin dashboard ticket statuses query failed", error);
      return [];
    }
    // Same group_type mapping as rowToTicketStatusOption.
    return (data ?? []).map((row) => ({ id: row.id, groupType: row.group_type === "closed" ? "closed" : "open" }));
  }

  const [ticketBatches, statusBatches] = await Promise.all([
    Promise.all(projectIdBatches.map(loadTicketRows)),
    Promise.all(projectIdBatches.map(loadStatusGroups)),
  ]);

  const rows: AdminDashboardTicketRow[] = [];
  for (const batch of ticketBatches) {
    if ("error" in batch) return { status: "error", message: batch.error };
    rows.push(...batch.rows);
  }

  const groupTypeByStatusId = new Map(statusBatches.flat().map((s) => [s.id, s.groupType]));
  const projectIndexById = new Map(projects.map((project, index) => [project.id, index]));
  const slugByProjectId = new Map(projects.map((project) => [project.id, project.slug]));

  rows.sort(
    (a, b) =>
      (projectIndexById.get(a.project_id) ?? 0) - (projectIndexById.get(b.project_id) ?? 0) ||
      a.ticket_number - b.ticket_number
  );

  const tickets: AdminDashboardTicket[] = rows.map((row) => ({
    id: row.id,
    projectSlug: slugByProjectId.get(row.project_id) ?? "",
    ticketNumber: row.ticket_number,
    title: row.title,
    type: TYPE_FROM_DB[row.type] ?? "TASK",
    status: STATUS_FROM_DB[row.status] ?? "backlog",
    statusGroupType: groupTypeByStatusId.get(row.status_id),
    dueDate: formatDueDate(row.due_date),
    assigneeProfileId: row.assignee_profile_id,
    dueDateISO: row.due_date,
  }));

  return { status: "ready", tickets, projects: projectSummaries };
}

export type OrganizationLoggedHoursResult =
  | { status: "ready"; totalMinutes: number }
  | { status: "error"; message: string };

// Both org-wide dashboard queries below (`loadOrganizationLoggedMinutes`,
// `loadOrganizationActivity`) filter `.in("ticket_id", ticketIds)` against
// every ticket in the organization — with an org's ticket count now
// regularly in the hundreds (e.g. a single historical import can add 100+
// at once), a single unchunked `.in()` serializes the whole id list into
// one GET query string and can exceed the gateway/proxy's max URL length,
// which Supabase/PostgREST then reports back as a bare, bodyless "Bad
// Request" — not a validation error. Splitting into fixed-size batches and
// querying each in parallel keeps every individual request's URL small
// regardless of how large the organization gets. Same local-helper
// convention already used the same way in unfuddle-import/execute-project-
// restore-phase3.ts/export-project.ts — not extracted to a shared util
// since this is the only other place it's needed.
function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const ORG_TICKET_ID_BATCH_SIZE = 100;

// Real logged hours (Time Entries) for the Hours Burn KPI — every other
// dashboard KPI is derived client-side from loadOrganizationTickets' own
// result, but estimated hours live on tickets while logged hours live in
// ticket_time_entries, so this is the one genuinely new query.
export async function loadOrganizationLoggedMinutes(ticketIds: string[]): Promise<OrganizationLoggedHoursResult> {
  if (ticketIds.length === 0) return { status: "ready", totalMinutes: 0 };

  const supabase = getSupabaseBrowserClient();
  const batches = chunkArray(ticketIds, ORG_TICKET_ID_BATCH_SIZE);

  const results = await Promise.all(
    batches.map((batch) =>
      supabase
        .from("ticket_time_entries")
        .select("minutes")
        .in("ticket_id", batch)
        .returns<{ minutes: number }[]>()
    )
  );

  // Any batch failing fails the whole call, same as the single-query
  // version did — never a silently-partial total.
  for (let i = 0; i < results.length; i++) {
    const { error } = results[i];
    if (error) {
      logDev("organization time entries query failed", {
        batch: i,
        batchSize: batches[i].length,
        message: error.message,
      });
      return { status: "error", message: error.message };
    }
  }

  const totalMinutes = results.reduce(
    (sum, { data }) => sum + (data ?? []).reduce((batchSum, row) => batchSum + row.minutes, 0),
    0
  );
  return { status: "ready", totalMinutes };
}

// The curated subset of real ticket_activity events the Admin Dashboard's
// Recent Activity widget already has a visual category for (see
// ACTIVITY_META in dashboard-shared.tsx: blocked/completed/hours/assigned/
// priority — "note" is Project Notes' own activity, a different table, not
// pulled in here). Every other real event_type (title/description edits,
// attachments, comments, labels, acceptance criteria, relations, logged
// time) is genuinely real too, just not one of the widget's existing
// categories, so it's left out of this feed rather than forced into one
// that doesn't fit. Returns plain data only (no JSX) — dashboard-screen.tsx
// builds the actual verb/detail text, same "lib returns data, component
// shapes presentation" split as the rest of this file.
export type OrganizationActivityEventType = "blocked" | "completed" | "hours" | "assigned" | "priority";

export interface OrganizationActivityEvent {
  id: string;
  type: OrganizationActivityEventType;
  actorName: string | null;
  actorAvatar: string;
  /** Real profiles.id of the actor, when known — lets any "click this
   *  person" trigger (Recent Activity, My Work's Recently Updated, etc.)
   *  open the Member Profile Modal against their real identity instead of
   *  a name-based guess. Null when the event has no real actor (same cases
   *  actorName is already null for). */
  actorProfileId: string | null;
  ticketId: string;
  time: string;
  /** Raw event timestamp — `time` above is already relative-formatted for
   *  direct display; this is only for callers that need to bucket events by
   *  real calendar day (e.g. My Work's "Recently Updated" Today/Yesterday/
   *  Earlier groups) without re-deriving it from the display string. */
  createdAtISO: string;
  oldHours?: string;
  newHours?: string;
  newAssigneeName?: string;
  oldPriorityLabel?: string;
  newPriorityLabel?: string;
  priorityRaised?: boolean;
}

export type OrganizationActivityResult =
  | { status: "ready"; events: OrganizationActivityEvent[] }
  | { status: "error"; message: string };

interface OrgActivityRawRow {
  id: string;
  ticket_id: string;
  actor_profile_id: string | null;
  event_type: string;
  old_value: string | null;
  new_value: string | null;
  created_at: string;
}

const ORG_ACTIVITY_RAW_FETCH_LIMIT = 200;

function isRelevantOrgActivityRow(row: OrgActivityRawRow): boolean {
  switch (row.event_type) {
    case "status_changed":
      return row.new_value === "blocked" || row.new_value === "done";
    case "hours_changed":
      return Boolean(row.old_value) && Boolean(row.new_value);
    case "assignee_changed":
      return Boolean(row.new_value);
    case "priority_changed":
      return Boolean(row.old_value) && Boolean(row.new_value);
    default:
      return false;
  }
}

// `actorProfileId`, when passed, narrows this to only the events that
// specific profile performed — reused as-is by the Member Project Overview's
// own "My Activity" (real activity on this project, scoped to the signed-in
// member as actor) instead of a second/parallel activity query. Every
// existing caller (Admin/Project Lead Dashboards, Admin Project Overview)
// omits it and keeps its prior, unfiltered behavior unchanged.
export async function loadOrganizationActivity(
  ticketIds: string[],
  limit = 10,
  actorProfileId?: string
): Promise<OrganizationActivityResult> {
  if (ticketIds.length === 0) return { status: "ready", events: [] };

  const supabase = getSupabaseBrowserClient();
  const batches = chunkArray(ticketIds, ORG_TICKET_ID_BATCH_SIZE);

  const batchResults = await Promise.all(
    batches.map((batch) => {
      let query = supabase
        .from("ticket_activity")
        .select("id, ticket_id, actor_profile_id, event_type, old_value, new_value, created_at")
        .in("ticket_id", batch);
      if (actorProfileId) query = query.eq("actor_profile_id", actorProfileId);

      return query
        .order("created_at", { ascending: false })
        .limit(ORG_ACTIVITY_RAW_FETCH_LIMIT)
        .returns<OrgActivityRawRow[]>();
    })
  );

  // Any batch failing fails the whole call, same as the single-query
  // version did — never a silently-partial activity feed.
  for (let i = 0; i < batchResults.length; i++) {
    const { error } = batchResults[i];
    if (error) {
      logDev("organization activity query failed", {
        batch: i,
        batchSize: batches[i].length,
        message: error.message,
      });
      return { status: "error", message: error.message };
    }
  }

  // Each batch already comes back as its own top ORG_ACTIVITY_RAW_FETCH_LIMIT
  // most recent raw rows (within that batch's tickets only). Any row that
  // belongs in the true organization-wide top ORG_ACTIVITY_RAW_FETCH_LIMIT
  // must also rank within its own batch's top ORG_ACTIVITY_RAW_FETCH_LIMIT —
  // so merging every batch's rows, re-sorting by recency, and re-capping at
  // the same limit reproduces exactly what one unchunked query would have
  // returned. Only after that does the existing relevant-event filter and
  // final `limit` apply, same as before chunking.
  const rows = batchResults
    .flatMap((result) => result.data ?? [])
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
    .slice(0, ORG_ACTIVITY_RAW_FETCH_LIMIT);

  const relevant = rows.filter(isRelevantOrgActivityRow).slice(0, limit);

  const profileIds = new Set<string>();
  for (const row of relevant) {
    if (row.actor_profile_id) profileIds.add(row.actor_profile_id);
    if (row.event_type === "assignee_changed" && row.new_value) profileIds.add(row.new_value);
  }
  const profilesById = await loadProfilesByIds(supabase, Array.from(profileIds));

  const events: OrganizationActivityEvent[] = relevant.map((row) => {
    const actor = row.actor_profile_id ? profilesById.get(row.actor_profile_id) : undefined;
    const base = {
      id: row.id,
      actorName: resolveProfileName(actor),
      actorAvatar: (actor ? resolveAvatarUrl(actor.avatar_url, actor.updated_at) : null) ?? FALLBACK_AVATAR,
      actorProfileId: row.actor_profile_id,
      ticketId: row.ticket_id,
      time: formatRelativeTime(row.created_at),
      createdAtISO: row.created_at,
    };

    if (row.event_type === "status_changed") {
      return { ...base, type: row.new_value === "blocked" ? "blocked" : "completed" };
    }

    if (row.event_type === "hours_changed") {
      return { ...base, type: "hours", oldHours: row.old_value ?? undefined, newHours: row.new_value ?? undefined };
    }

    if (row.event_type === "assignee_changed") {
      const newAssignee = row.new_value ? profilesById.get(row.new_value) : undefined;
      return { ...base, type: "assigned", newAssigneeName: resolveProfileName(newAssignee) ?? "Unknown" };
    }

    // priority_changed
    const oldIdx = PRIORITY_VALUES.indexOf((row.old_value ?? "") as TicketPriority);
    const newIdx = PRIORITY_VALUES.indexOf((row.new_value ?? "") as TicketPriority);
    return {
      ...base,
      type: "priority",
      oldPriorityLabel: activityPriorityLabel(row.old_value),
      newPriorityLabel: activityPriorityLabel(row.new_value),
      // Lower index in PRIORITY_VALUES ("highest" first) means more urgent.
      priorityRaised: oldIdx !== -1 && newIdx !== -1 && newIdx < oldIdx,
    };
  });

  return { status: "ready", events };
}

// ── Project Activity History (project-activity-history-screen.tsx) ─────────
// The full, real, comprehensive activity trail for one project — every real
// event type (not just loadOrganizationActivity's narrower blocked/
// completed/hours/assigned/priority dashboard categories), reusing the
// exact same buildActivityLabel this file's own loadTicketActivity already
// uses for one ticket's Activity Log, just resolved across every ticket in
// the project and paginated server-side (LIMIT/OFFSET via .range()) instead
// of loaded whole — same "?page=, 20/page, Previous/Next" real pagination
// shape as loadProjectMemberWorkHistoryPage/work-history-screen.tsx. Never
// synthesizes a ticket_created row the way loadTicketActivity does for
// legacy pre-trigger tickets (that fabricated row lives outside the real
// ticket_activity table's own ordering and would break correct
// LIMIT/OFFSET pagination across pages).

export interface ProjectActivityEntry {
  id: string;
  label: string;
  timeAgo: string;
  ticketKey: string;
  ticketTitle: string;
}

export type ProjectActivityPageResult =
  | { status: "ready"; entries: ProjectActivityEntry[]; totalCount: number }
  | { status: "error"; message: string };

interface ProjectActivityRawRow extends ActivityRow {
  ticket_id: string;
}

export async function loadProjectActivityPage(
  organizationId: string,
  slug: string,
  page: number,
  pageSize: number
): Promise<ProjectActivityPageResult> {
  const supabase = getSupabaseBrowserClient();

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id, project_code")
    .eq("organization_id", organizationId)
    .eq("slug", slug)
    .maybeSingle<ProjectLookupRow>();

  if (projectError) {
    logDev("project activity project lookup failed", projectError);
    return { status: "error", message: projectError.message };
  }
  if (!project) return { status: "ready", entries: [], totalCount: 0 };

  const { data: ticketRows, error: ticketsError } = await supabase
    .from("tickets")
    .select("id, ticket_number, title")
    .eq("project_id", project.id)
    .returns<{ id: string; ticket_number: number; title: string }[]>();

  if (ticketsError) {
    logDev("project activity tickets lookup failed", ticketsError);
    return { status: "error", message: ticketsError.message };
  }
  const ticketIds = (ticketRows ?? []).map((t) => t.id);
  if (ticketIds.length === 0) return { status: "ready", entries: [], totalCount: 0 };

  const ticketById = new Map((ticketRows ?? []).map((t) => [t.id, t]));

  const offset = (page - 1) * pageSize;
  const { data: rows, error, count } = await supabase
    .from("ticket_activity")
    .select("id, ticket_id, actor_profile_id, event_type, field_name, old_value, new_value, created_at", {
      count: "exact",
    })
    .in("ticket_id", ticketIds)
    .order("created_at", { ascending: false })
    // Secondary tie-break so row order is fully deterministic even when
    // several rows share the same created_at (e.g. a batch of field-change
    // rows logged by one trigger in the same instant) — same reasoning as
    // loadOrganizationProjects' own tie-break; without it, LIMIT/OFFSET
    // pagination could show a tied row twice or skip it across pages.
    .order("id", { ascending: true })
    .range(offset, offset + pageSize - 1)
    .returns<ProjectActivityRawRow[]>();

  if (error) {
    logDev("project activity page query failed", error);
    return { status: "error", message: error.message };
  }

  // Every profile this page of activity could reference: each row's actor,
  // plus assignee_changed's old/new profile ids — same resolution
  // loadTicketActivity already uses for its own single-ticket page.
  const profileIds = new Set<string>();
  for (const row of rows ?? []) {
    if (row.actor_profile_id) profileIds.add(row.actor_profile_id);
    if (row.event_type === "assignee_changed") {
      if (row.old_value) profileIds.add(row.old_value);
      if (row.new_value) profileIds.add(row.new_value);
    }
  }
  const profilesById = await loadProfilesByIds(supabase, Array.from(profileIds));
  const resolveName = (id: string | null) => (id ? resolveProfileName(profilesById.get(id)) : null);

  const entries: ProjectActivityEntry[] = (rows ?? []).map((row) => {
    const ticket = ticketById.get(row.ticket_id);
    return {
      id: row.id,
      label: buildActivityLabel(row, resolveName(row.actor_profile_id), resolveName),
      timeAgo: formatRelativeTime(row.created_at),
      ticketKey: `${project.project_code}-${ticket?.ticket_number ?? "?"}`,
      ticketTitle: ticket?.title ?? "",
    };
  });

  return { status: "ready", entries, totalCount: count ?? 0 };
}

// ── Organization Activity History (organization-activity-history-screen.tsx) ─
// The org-wide sibling of loadProjectActivityPage above — same real,
// comprehensive activity trail (every real event type, the same
// buildActivityLabel, the same server-side LIMIT/OFFSET pagination), just
// resolved across every project in the organization instead of one project's
// tickets. Backs Dashboard's "View all activity →" action. Each entry also
// carries its own project (projectSlug/projectName), since — unlike the
// single-project screen — entries here can come from any project.

export interface OrganizationActivityEntry {
  id: string;
  label: string;
  timeAgo: string;
  ticketKey: string;
  ticketTitle: string;
  projectSlug: string;
  projectName: string;
}

export type OrganizationActivityPageResult =
  | { status: "ready"; entries: OrganizationActivityEntry[]; totalCount: number }
  | { status: "error"; message: string };

// `id`/`ticket_id`/etc. are nullable here because the RPC (see
// 20260930080000_fix_organization_activity_page_count.sql) LEFT JOINs the
// paginated page onto a single always-present total_count row — an
// out-of-range page (or a genuinely empty organization) comes back as
// exactly one row with every activity column null, carrying only the real
// total_count, rather than zero rows with total_count unrecoverable. A
// null `id` marks that "count-only" row.
interface OrganizationActivityPageRpcRow {
  id: string | null;
  ticket_id: string | null;
  actor_profile_id: string | null;
  event_type: string | null;
  field_name: string | null;
  old_value: string | null;
  new_value: string | null;
  created_at: string | null;
  total_count: number;
}

// The non-null shape a row actually has once it's passed the `id !== null`
// filter below — same fields ActivityRow (buildActivityLabel's own param
// type) plus ticket_id expects, just narrowed down from the nullable RPC
// row type rather than redeclared from scratch.
type OrganizationActivityPageRow = { [K in keyof OrganizationActivityPageRpcRow]: NonNullable<OrganizationActivityPageRpcRow[K]> };

// Server-side pagination via the organization_activity_page RPC
// (20260930070000_add_organization_activity_page_rpc.sql,
// 20260930080000_fix_organization_activity_page_count.sql) — the relational
// filter (ticket_activity -> tickets -> projects -> organization_id), the
// created_at desc/id asc order, LIMIT/OFFSET, and exact total count all run
// inside one Postgres query now, instead of building a client-side
// `.in("ticket_id", ...)` from every ticket in the organization (1,492 in
// production as of this fix — a ~55KB GET URL that 400s at the gateway
// before it ever reaches PostgREST). The RPC is SECURITY INVOKER — it runs
// as the calling user, so it's bound by exactly the same
// ticket_activity_select/tickets_select/projects_select RLS this function
// relied on before; see the migration's own comment for why that's
// sufficient (no separate authorization logic to keep in sync).
export async function loadOrganizationActivityPage(
  organizationId: string,
  page: number,
  pageSize: number
): Promise<OrganizationActivityPageResult> {
  const supabase = getSupabaseBrowserClient();
  const offset = (page - 1) * pageSize;

  const { data, error } = await supabase.rpc("organization_activity_page", {
    target_organization_id: organizationId,
    page_size: pageSize,
    page_offset: offset,
  });

  if (error) {
    logDev("organization activity page rpc failed", error);
    return { status: "error", message: error.message };
  }
  const rpcRows = (data ?? []) as OrganizationActivityPageRpcRow[];
  // The RPC always returns exactly one row even with zero matching
  // activity (a count-only row with a null id) — real total count is
  // still readable from it, so this is never conflated with an actual
  // error/short-circuit path the way an empty array would be.
  const totalCount = rpcRows[0]?.total_count ?? 0;
  const rows = rpcRows.filter((row): row is OrganizationActivityPageRow => row.id !== null);
  if (rows.length === 0) return { status: "ready", entries: [], totalCount };

  // Hydrate only the tickets/projects referenced by this one page's rows —
  // never the whole organization's, now that the RPC above already did the
  // large-scope filtering/ordering/pagination inside Postgres.
  const ticketIds = Array.from(new Set(rows.map((row) => row.ticket_id)));
  const { data: ticketRows, error: ticketsError } = await supabase
    .from("tickets")
    .select("id, ticket_number, title, project_id")
    .in("id", ticketIds)
    .returns<{ id: string; ticket_number: number; title: string; project_id: string }[]>();

  if (ticketsError) {
    logDev("organization activity page tickets lookup failed", ticketsError);
    return { status: "error", message: ticketsError.message };
  }
  const ticketById = new Map((ticketRows ?? []).map((t) => [t.id, t]));

  const projectIds = Array.from(new Set((ticketRows ?? []).map((t) => t.project_id)));
  const projectById = new Map<string, { id: string; slug: string; name: string; project_code: string }>();
  if (projectIds.length > 0) {
    const { data: projectRows, error: projectsError } = await supabase
      .from("projects")
      .select("id, slug, name, project_code")
      .in("id", projectIds)
      .returns<{ id: string; slug: string; name: string; project_code: string }[]>();

    if (projectsError) {
      logDev("organization activity page projects lookup failed", projectsError);
      return { status: "error", message: projectsError.message };
    }
    for (const row of projectRows ?? []) projectById.set(row.id, row);
  }

  const profileIds = new Set<string>();
  for (const row of rows) {
    if (row.actor_profile_id) profileIds.add(row.actor_profile_id);
    if (row.event_type === "assignee_changed") {
      if (row.old_value) profileIds.add(row.old_value);
      if (row.new_value) profileIds.add(row.new_value);
    }
  }
  const profilesById = await loadProfilesByIds(supabase, Array.from(profileIds));
  const resolveName = (id: string | null) => (id ? resolveProfileName(profilesById.get(id)) : null);

  const entries: OrganizationActivityEntry[] = rows.map((row) => {
    const ticket = ticketById.get(row.ticket_id);
    const project = ticket ? projectById.get(ticket.project_id) : undefined;
    return {
      id: row.id,
      label: buildActivityLabel(row, resolveName(row.actor_profile_id), resolveName),
      timeAgo: formatRelativeTime(row.created_at),
      ticketKey: `${project?.project_code ?? "?"}-${ticket?.ticket_number ?? "?"}`,
      ticketTitle: ticket?.title ?? "",
      projectSlug: project?.slug ?? "",
      projectName: project?.name ?? "",
    };
  });

  return { status: "ready", entries, totalCount };
}

// ── Member Dashboard reads ──────────────────────────────────────────────────
// (src/components/member-dashboard.tsx). Admin's and Project Lead's own
// dashboards are untouched.

export interface ProfileTimeEntry {
  ticketId: string;
  minutes: number;
}

export type ProfileLoggedTimeResult =
  | { status: "ready"; entries: ProfileTimeEntry[] }
  | { status: "error"; message: string };

// Real "time logged today" for one profile, across every ticket they have
// access to (not just tickets assigned to them — pairing/helping on someone
// else's ticket still counts). Grouping by project is left to the caller,
// which already has the ticket→project mapping from loadOrganizationTickets.
export async function loadProfileLoggedTimeForDate(
  profileId: string,
  workDate: string
): Promise<ProfileLoggedTimeResult> {
  const supabase = getSupabaseBrowserClient();

  const { data: rows, error } = await supabase
    .from("ticket_time_entries")
    .select("ticket_id, minutes")
    .eq("logged_by", profileId)
    .eq("work_date", workDate)
    .returns<{ ticket_id: string; minutes: number }[]>();

  if (error) {
    logDev("profile logged time query failed", error);
    return { status: "error", message: error.message };
  }

  return {
    status: "ready",
    entries: (rows ?? []).map((row) => ({ ticketId: row.ticket_id, minutes: row.minutes })),
  };
}

export type ProfileLoggedMinutesResult =
  | { status: "ready"; totalMinutes: number }
  | { status: "error"; message: string };

// Real total minutes logged by one profile within an inclusive ISO date
// range (yyyy-mm-dd) — backs the Member Dashboard's "Remaining This Week"
// (Weekly Capacity minus this week's real logged hours). Same "every ticket
// they have access to, not just their own assignments" scope as
// loadProfileLoggedTimeForDate above, just totaled server-side instead of
// returned per-entry since no per-project breakdown is needed here.
export async function loadProfileLoggedMinutesForRange(
  profileId: string,
  startDate: string,
  endDate: string
): Promise<ProfileLoggedMinutesResult> {
  const supabase = getSupabaseBrowserClient();

  const { data: rows, error } = await supabase
    .from("ticket_time_entries")
    .select("minutes")
    .eq("logged_by", profileId)
    .gte("work_date", startDate)
    .lte("work_date", endDate)
    .returns<{ minutes: number }[]>();

  if (error) {
    logDev("profile logged minutes range query failed", error);
    return { status: "error", message: error.message };
  }

  const totalMinutes = (rows ?? []).reduce((sum, row) => sum + row.minutes, 0);
  return { status: "ready", totalMinutes };
}

export interface OrganizationTimeEntry {
  ticketId: string;
  loggedBy: string | null;
  minutes: number;
  /** The entry's own real work_date (yyyy-mm-dd) — already the column this
   *  query filters by below, just also surfaced per-row for callers (e.g.
   *  the Hours Report export) that need the effective work date on each
   *  entry rather than just the aggregate range. */
  workDate: string;
  /** The entry's own free-text comment, if any — surfaced for the Hours
   *  Report export's "Time Entry Description" column. Every existing caller
   *  of this function ignores this field, so adding it is not a breaking
   *  change. */
  comment: string | null;
}

export type OrganizationLoggedTimeResult =
  | { status: "ready"; entries: OrganizationTimeEntry[] }
  | { status: "error"; message: string };

// Real per-ticket, per-logger time entries within an inclusive ISO date
// range — backs Admin Reports' "Hours by Person" table (Completed/Blocked
// need to know not just how many minutes were logged, but by whom and on
// which ticket, not just a single aggregate like loadOrganizationLoggedMinutes
// above). Grouping by person/ticket is left to the caller.
//
// Chunked via the same chunkArray/ORG_TICKET_ID_BATCH_SIZE convention as
// loadOrganizationLoggedMinutes/loadOrganizationActivity above — a Project
// Lead scoped to a large migrated project (e.g. an Unfuddle import) can
// easily push ticketIds past 1,000+, which serialized into one unchunked
// `.in()` blows the gateway's max URL length and comes back as a bare,
// bodyless "Bad Request" (reproduced directly against the ticket_time_entries
// REST endpoint: a 1,391-id single query 400s, a 100-id batch is a clean
// 200). This is the same failure mode that function's own comment already
// documents, just reached here via a different caller.
export async function loadOrganizationLoggedTimeForRange(
  ticketIds: string[],
  startDate: string,
  endDate: string
): Promise<OrganizationLoggedTimeResult> {
  if (ticketIds.length === 0) return { status: "ready", entries: [] };

  const supabase = getSupabaseBrowserClient();
  const batches = chunkArray(ticketIds, ORG_TICKET_ID_BATCH_SIZE);

  const results = await Promise.all(
    batches.map((batch) =>
      supabase
        .from("ticket_time_entries")
        .select("ticket_id, logged_by, minutes, work_date, comment")
        .in("ticket_id", batch)
        .gte("work_date", startDate)
        .lte("work_date", endDate)
        .returns<{ ticket_id: string; logged_by: string | null; minutes: number; work_date: string; comment: string | null }[]>()
    )
  );

  // Any batch failing fails the whole call, same as the single-query
  // version did — never a silently-partial result.
  for (let i = 0; i < results.length; i++) {
    const { error } = results[i];
    if (error) {
      logDev("organization logged time range query failed", {
        batch: i,
        batchSize: batches[i].length,
        message: error.message,
      });
      return { status: "error", message: error.message };
    }
  }

  return {
    status: "ready",
    entries: results.flatMap(({ data }) =>
      (data ?? []).map((row) => ({
        ticketId: row.ticket_id,
        loggedBy: row.logged_by,
        minutes: row.minutes,
        workDate: row.work_date,
        comment: row.comment,
      }))
    ),
  };
}

export type MemberAttentionEventType = "blocked" | "reassigned" | "review" | "estimate";

export interface MemberAttentionEvent {
  id: string;
  type: MemberAttentionEventType;
  actorName: string | null;
  ticketId: string;
  time: string;
  oldHours?: string;
  newHours?: string;
}

export type MemberAttentionResult =
  | { status: "ready"; events: MemberAttentionEvent[] }
  | { status: "error"; message: string };

// The real "Needs Your Attention" feed — the subset of ticket_activity on
// this member's own active tickets that asks them to actually do something:
// one of their tickets got blocked, was reassigned to them, moved into
// review, or had its estimate change. No @mention-detection exists in this
// schema (comments aren't parsed), so that mock category is simply never
// populated here — never fabricated.
export async function loadMemberAttentionEvents(
  ticketIds: string[],
  profileId: string,
  limit = 10
): Promise<MemberAttentionResult> {
  if (ticketIds.length === 0) return { status: "ready", events: [] };

  const supabase = getSupabaseBrowserClient();

  const { data: rows, error } = await supabase
    .from("ticket_activity")
    .select("id, ticket_id, actor_profile_id, event_type, old_value, new_value, created_at")
    .in("ticket_id", ticketIds)
    .order("created_at", { ascending: false })
    .limit(ORG_ACTIVITY_RAW_FETCH_LIMIT)
    .returns<OrgActivityRawRow[]>();

  if (error) {
    logDev("member attention activity query failed", error);
    return { status: "error", message: error.message };
  }

  const relevant: { row: OrgActivityRawRow; type: MemberAttentionEventType }[] = [];
  for (const row of rows ?? []) {
    if (relevant.length >= limit) break;
    if (row.event_type === "status_changed" && row.new_value === "blocked") {
      relevant.push({ row, type: "blocked" });
    } else if (row.event_type === "status_changed" && row.new_value === "review") {
      relevant.push({ row, type: "review" });
    } else if (row.event_type === "assignee_changed" && row.new_value === profileId) {
      relevant.push({ row, type: "reassigned" });
    } else if (row.event_type === "hours_changed" && row.old_value && row.new_value) {
      relevant.push({ row, type: "estimate" });
    }
  }

  const actorIds = Array.from(
    new Set(relevant.map((r) => r.row.actor_profile_id).filter((id): id is string => Boolean(id)))
  );
  const actorsById = await loadProfilesByIds(supabase, actorIds);

  const events: MemberAttentionEvent[] = relevant.map(({ row, type }) => {
    const actor = row.actor_profile_id ? actorsById.get(row.actor_profile_id) : undefined;
    return {
      id: row.id,
      type,
      actorName: resolveProfileName(actor),
      ticketId: row.ticket_id,
      time: formatRelativeTime(row.created_at),
      oldHours: type === "estimate" ? row.old_value ?? undefined : undefined,
      newHours: type === "estimate" ? row.new_value ?? undefined : undefined,
    };
  });

  return { status: "ready", events };
}

export interface HoursOrAssigneeActivityEvent {
  ticketId: string;
  eventType: "hours_changed" | "assignee_changed";
  oldValue: string | null;
  newValue: string | null;
}

export type HoursOrAssigneeActivityResult =
  | { status: "ready"; events: HoursOrAssigneeActivityEvent[] }
  | { status: "error"; message: string };

// Real hours_changed/assignee_changed ticket_activity rows within an
// inclusive-start/exclusive-end timestamp range — backs Admin Reports'
// Workload "variación de esta semana" (the real net change in a person's
// assigned estimated hours during the current calendar week). Unlike
// loadOrganizationActivity above (curated to a handful of event types and
// capped for the Recent Activity widget's small display limit), this
// returns every matching row in the range uncapped, since a weekly sum
// can't silently drop events past a display limit.
//
// Chunked via chunkArray/ORG_TICKET_ID_BATCH_SIZE — same reasoning as
// loadOrganizationLoggedTimeForRange above. Admin Reports calls this with
// every org ticket id at once (1,488 in production as of this fix), which
// unbatched serializes into a ~55KB GET query string and 400s at the
// gateway before it ever reaches PostgREST; reproduced directly against
// this org's full ticket set.
export async function loadHoursAndAssigneeActivityForRange(
  ticketIds: string[],
  startISO: string,
  endExclusiveISO: string
): Promise<HoursOrAssigneeActivityResult> {
  if (ticketIds.length === 0) return { status: "ready", events: [] };

  const supabase = getSupabaseBrowserClient();
  const batches = chunkArray(ticketIds, ORG_TICKET_ID_BATCH_SIZE);

  const results = await Promise.all(
    batches.map((batch) =>
      supabase
        .from("ticket_activity")
        .select("ticket_id, event_type, old_value, new_value")
        .in("ticket_id", batch)
        .in("event_type", ["hours_changed", "assignee_changed"])
        .gte("created_at", startISO)
        .lt("created_at", endExclusiveISO)
        .returns<{ ticket_id: string; event_type: string; old_value: string | null; new_value: string | null }[]>()
    )
  );

  for (let i = 0; i < results.length; i++) {
    const { error } = results[i];
    if (error) {
      logDev("hours/assignee activity range query failed", {
        batch: i,
        batchSize: batches[i].length,
        message: error.message,
      });
      return { status: "error", message: error.message };
    }
  }

  return {
    status: "ready",
    events: results.flatMap(({ data }) =>
      (data ?? []).map((row) => ({
        ticketId: row.ticket_id,
        eventType: row.event_type as "hours_changed" | "assignee_changed",
        oldValue: row.old_value,
        newValue: row.new_value,
      }))
    ),
  };
}

export type TicketsCompletedInRangeResult =
  | { status: "ready"; ticketIds: string[] }
  | { status: "error"; message: string };

// Real status_changed→done ticket_activity rows within an inclusive-start/
// exclusive-end timestamp range — Project Reports' Delivery Snapshot uses
// this (status activity) rather than a ticket's own updated_at, which can
// be touched by any later field edit long after the ticket was actually
// completed. Same uncapped/date-ranged shape as
// loadHoursAndAssigneeActivityForRange above, just for a different event.
//
// Chunked via chunkArray/ORG_TICKET_ID_BATCH_SIZE — same reasoning as
// loadHoursAndAssigneeActivityForRange above; Admin Reports' Delivery tab
// calls this with every org ticket id at once (1,488 in production),
// which unbatched hits the same gateway URL-length 400.
export async function loadTicketsCompletedInRange(
  ticketIds: string[],
  startISO: string,
  endExclusiveISO: string
): Promise<TicketsCompletedInRangeResult> {
  if (ticketIds.length === 0) return { status: "ready", ticketIds: [] };

  const supabase = getSupabaseBrowserClient();
  const batches = chunkArray(ticketIds, ORG_TICKET_ID_BATCH_SIZE);

  const results = await Promise.all(
    batches.map((batch) =>
      supabase
        .from("ticket_activity")
        .select("ticket_id")
        .in("ticket_id", batch)
        .eq("event_type", "status_changed")
        .eq("new_value", "done")
        .gte("created_at", startISO)
        .lt("created_at", endExclusiveISO)
        .returns<{ ticket_id: string }[]>()
    )
  );

  for (let i = 0; i < results.length; i++) {
    const { error } = results[i];
    if (error) {
      logDev("tickets completed in range query failed", {
        batch: i,
        batchSize: batches[i].length,
        message: error.message,
      });
      return { status: "error", message: error.message };
    }
  }

  // De-duplicated — a ticket could in theory be marked Done more than once
  // in the same period (moved off Done and back), but it should still only
  // count once. Batches partition ticketIds disjointly, so this dedupe is
  // just as correct merged across batches as it was on one query's rows.
  return {
    status: "ready",
    ticketIds: Array.from(new Set(results.flatMap(({ data }) => (data ?? []).map((r) => r.ticket_id)))),
  };
}

export interface DeliveryActivityEvent {
  id: string;
  ticketId: string;
  actorId: string | null;
  actorName: string | null;
  actorAvatar: string;
  eventType: string;
  fieldName: string | null;
  oldValue: string | null;
  newValue: string | null;
  createdAt: string;
}

export type DeliveryActivityResult =
  | { status: "ready"; events: DeliveryActivityEvent[] }
  | { status: "error"; message: string };

// The subset of real ticket_activity event types that matter for delivery
// tracking (Admin Reports' "Recent Changes") — deliberately excludes
// title/description edits, labels, acceptance criteria, attachments, time
// entries, and comments, which are real too but low-value for this widget.
const DELIVERY_ACTIVITY_EVENT_TYPES = [
  "ticket_created",
  "status_changed",
  "assignee_changed",
  "hours_changed",
  "priority_changed",
  "due_date_changed",
  "relation_added",
  "relation_removed",
];

const DELIVERY_ACTIVITY_FETCH_LIMIT = 100;

// Real, uncurated delivery-relevant activity rows across a ticket set, most
// recent first — the caller (reports-screen.tsx) resolves each row against
// the tickets already in its own filtered scope, builds the display text,
// and dedupes relation_added/relation_removed's own two-rows-per-action
// shape. Reuses the same profile-resolution helpers as the rest of this
// file rather than a new lookup mechanism.
export async function loadDeliveryActivityForTickets(ticketIds: string[]): Promise<DeliveryActivityResult> {
  if (ticketIds.length === 0) return { status: "ready", events: [] };

  const supabase = getSupabaseBrowserClient();

  const { data: rows, error } = await supabase
    .from("ticket_activity")
    .select("id, ticket_id, actor_profile_id, event_type, field_name, old_value, new_value, created_at")
    .in("ticket_id", ticketIds)
    .in("event_type", DELIVERY_ACTIVITY_EVENT_TYPES)
    .order("created_at", { ascending: false })
    .limit(DELIVERY_ACTIVITY_FETCH_LIMIT)
    .returns<
      {
        id: string;
        ticket_id: string;
        actor_profile_id: string | null;
        event_type: string;
        field_name: string | null;
        old_value: string | null;
        new_value: string | null;
        created_at: string;
      }[]
    >();

  if (error) {
    logDev("delivery activity query failed", error);
    return { status: "error", message: error.message };
  }

  const actorIds = Array.from(
    new Set((rows ?? []).map((row) => row.actor_profile_id).filter((id): id is string => Boolean(id)))
  );
  const actorsById = await loadProfilesByIds(supabase, actorIds);

  const events: DeliveryActivityEvent[] = (rows ?? []).map((row) => {
    const actor = row.actor_profile_id ? actorsById.get(row.actor_profile_id) : undefined;
    return {
      id: row.id,
      ticketId: row.ticket_id,
      actorId: row.actor_profile_id,
      actorName: resolveProfileName(actor),
      actorAvatar: (actor ? resolveAvatarUrl(actor.avatar_url, actor.updated_at) : null) ?? FALLBACK_AVATAR,
      eventType: row.event_type,
      fieldName: row.field_name,
      oldValue: row.old_value,
      newValue: row.new_value,
      createdAt: row.created_at,
    };
  });

  return { status: "ready", events };
}
