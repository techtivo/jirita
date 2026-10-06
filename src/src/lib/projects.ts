// Loads and creates real Projects rows for the signed-in user's active
// organization — the replacement data source for src/lib/mock-projects.ts
// on the Sidebar and the /projects page only (Tickets/Dashboard/Reports/
// Project Overview keep reading mock-projects.ts for now — see
// PROJECT_STATUS.md). See docs/SUPABASE_MVP_SCHEMA.md for the `projects`
// table shape this reads/writes.
//
// RLS on `projects` already scopes rows per role (Admin sees every org
// project; Project Lead/Member see only projects they're staffed on via
// project_memberships), so no client-side role filtering is needed here —
// the query just returns whatever the signed-in user is allowed to see.
// The same RLS also gates insert to org role admin/project_lead — a
// disallowed create attempt surfaces as an error from createProject below,
// not a client-side check.
//
// Not stored on `projects` (by schema design — meant to be derived from
// `tickets` at read time, out of scope here): activeMilestones,
// openTickets, blockedTickets, overdueTickets, awaitingReviewTickets,
// dueThisWeekTickets, progress. These default to 0 until Tickets is wired
// to Supabase.

import { getSupabaseBrowserClient } from "./supabase-client";
import { resolveAvatarUrl } from "./membership";
import { FALLBACK_AVATAR } from "./current-user";
import { createNotification } from "./notifications";
import { formatAbsoluteDate } from "./date-format";
import { deleteProjectAction, type DeleteProjectResult } from "./server/delete-project-action";
import { notifyProjectAccessRequestAction } from "./server/notify-project-access-request-action";
import type { ClientName, ProjectCategory, ProjectHealth, ProjectStatus, ProjectSummary } from "./mock-projects";

export type ProjectsResult =
  | { status: "ready"; projects: ProjectSummary[] }
  | { status: "error"; message: string };

export type CreateProjectResult =
  | { status: "success"; project: ProjectSummary }
  | { status: "error"; message: string };

// Superset of ProjectSummary used only by Project Settings — adds the raw
// owner_profile_id (needed to preselect the Project Lead picker), which the
// Sidebar/Projects-list ProjectSummary shape deliberately omits (it only
// ever displays the resolved name/avatar, never the id).
export interface ProjectDetail extends ProjectSummary {
  /** Real projects.id — Project Settings' own GitHub Repository Integration
   *  Server Actions/API routes need the real id, never resolved by slug/
   *  name/position. ProjectSummary itself deliberately omits this (nothing
   *  outside Project Settings needs it). */
  id: string;
  ownerProfileId: string | null;
  /** Real projects.created_at, "Mar 3, 2026" — Project Overview header's "Started ..." line only. */
  createdAt: string;
  /** Same value as createdAt, raw ISO — Project Overview's health/alerts queries use it as their lower date bound. */
  createdAtISO: string;
  /** Same value as ProjectSummary.targetDate, raw ISO (`yyyy-mm-dd`) or null — Project Settings' own `<input type="date">` needs this instead of the "Jul 16"-formatted display string. */
  targetDateISO: string | null;
  /** projects.repository_provider — Project Settings' own Repository Integration section only. null means "None"/not configured, never a separate "none" value. */
  repositoryProvider: RepositoryProvider | null;
  /** projects.repository_url — always null when repositoryProvider is null (enforced by a DB constraint, not just application code). */
  repositoryUrl: string | null;
}

export type ProjectDetailResult =
  | { status: "ready"; project: ProjectDetail }
  | { status: "not-found" }
  | { status: "error"; message: string };

export interface OrgMember {
  id: string;
  name: string;
  avatar: string;
}

export type OrgMembersResult =
  | { status: "ready"; members: OrgMember[] }
  | { status: "error"; message: string };

const STATUS_FROM_DB: Record<string, ProjectStatus> = {
  planning: "planning",
  active: "active",
  on_hold: "on-hold",
  completed: "completed",
  archived: "archived",
};

/** Same DB → UI project status mapping (and "planning" fallback) as every
 *  loader in this file — exported for lib/tickets.ts's Admin Dashboard
 *  loader, which reads project rows directly (JIR-101). */
export function projectStatusFromDb(value: string): ProjectStatus {
  return STATUS_FROM_DB[value] ?? "planning";
}

// Inverse of STATUS_FROM_DB, deliberately excluding "archived" — that
// transition only ever happens through archiveProject/restoreProject,
// never through updateProjectSettings (see EditableProjectStatus).
export type EditableProjectStatus = Exclude<ProjectStatus, "archived">;
const STATUS_TO_DB: Record<EditableProjectStatus, string> = {
  planning: "planning",
  active: "active",
  "on-hold": "on_hold",
  completed: "completed",
};

const HEALTH_FROM_DB: Record<string, ProjectHealth> = {
  healthy: "healthy",
  needs_attention: "needs-attention",
  critical: "critical",
};

const CATEGORY_VALUES: ProjectCategory[] = ["client", "internal"];

interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  short_name: string | null;
  project_code: string;
  description: string | null;
  status: string;
  health: string;
  category: string;
  client_name: string | null;
  // PostgREST/Supabase serializes `numeric` columns as strings (to avoid JS
  // floating-point precision loss) — coerced with Number(...) below.
  default_hourly_rate: string | null;
  owner_profile_id: string | null;
  target_date: string | null;
  repository_provider: string | null;
  repository_url: string | null;
  updated_at: string;
  created_at: string;
}

// ── Repository Integration (Project Settings) ───────────────────────────────
// No OAuth/sync/webhooks/commit reads/PRs/branches/issue import — just which
// provider (if any) this project links to, and its URL. `null` is "None";
// there is no separate "none" string value (see
// 20260819000000_make_project_repository_provider_nullable.sql).
export type RepositoryProvider = "github" | "gitlab";
const REPOSITORY_PROVIDER_VALUES: RepositoryProvider[] = ["github", "gitlab"];

// Host anchored exactly to avoid lookalike domains (github.fake.com,
// notgithub.com, etc.) — the literal "github.com"/"gitlab.com" must appear
// immediately after the scheme, never as a suffix of a longer host.
// Exactly two path segments for GitHub (owner/repository); GitLab allows
// two or more (group/project, or group/subgroup(/subgroup...)/project).
// A single optional trailing slash is allowed; ".git" is never required or
// stripped — it's just more `[\w.-]+` characters in the last segment.
const GITHUB_REPO_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/;
const GITLAB_REPO_URL_RE = /^https:\/\/gitlab\.com\/[\w.-]+(?:\/[\w.-]+)+\/?$/;

// Pure — never calls out to GitHub/GitLab, only checks shape. Shared by the
// UI (pre-Save validation) and updateProjectSettings below (the real write
// path's own backend-side check), so the two can never drift apart.
export function validateRepositoryUrl(provider: RepositoryProvider | null, url: string): string | null {
  if (provider === null) return null;
  const trimmed = url.trim();
  if (!trimmed) return "Repository URL is required.";
  if (provider === "github" && !GITHUB_REPO_URL_RE.test(trimmed)) {
    return "Enter a valid GitHub repository URL, e.g. https://github.com/owner/repository";
  }
  if (provider === "gitlab" && !GITLAB_REPO_URL_RE.test(trimmed)) {
    return "Enter a valid GitLab repository URL, e.g. https://gitlab.com/group/project";
  }
  return null;
}

// Trims, then strips exactly one trailing "/" if present — never touches
// ".git" or anything else. Applied once, at the real write path, so every
// caller's persisted value is normalized the same way regardless of what
// was typed.
function normalizeRepositoryUrl(url: string): string {
  const trimmed = url.trim();
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

interface OwnerProfileRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  avatar_url: string | null;
  updated_at: string;
}

const PROJECT_COLUMNS =
  "id, slug, name, short_name, project_code, description, status, health, category, client_name, default_hourly_rate, owner_profile_id, target_date, repository_provider, repository_url, updated_at, created_at";

// Kebab-cases a project name into a URL-safe slug (routes are
// /projects/[slug]). Falls back to a timestamp if the name has no
// alphanumeric characters at all.
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || `project-${Date.now()}`;
}

// Auto-derives the short prefix `projects.project_code` requires (used
// elsewhere to build visible ticket IDs, e.g. MBA-12) since the create-form
// only collects a name — two-plus words take initials ("Client Website
// Redesign" → "CWR"), a single word takes its first letters ("Marketing" →
// "MAR"). Never surfaced in this UI; only has to be non-empty and
// reasonably identify the project.
export function generateProjectCode(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const raw =
    words.length >= 2
      ? words.map((word) => word[0]).join("").toUpperCase().slice(0, 4)
      : (words[0] ?? "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 3).toUpperCase();
  return raw || `P${Date.now().toString().slice(-4)}`;
}

function rowToProjectSummary(
  row: ProjectRow,
  ownerRow: OwnerProfileRow | undefined,
  leadRow?: OwnerProfileRow | undefined
): ProjectSummary {
  const ownerName = ownerRow ? [ownerRow.first_name, ownerRow.last_name].filter(Boolean).join(" ") : "Unassigned";

  return {
    slug: row.slug,
    name: row.name,
    shortName: row.short_name ?? row.name.slice(0, 2).toUpperCase(),
    projectCode: row.project_code,
    description: row.description ?? "",
    status: STATUS_FROM_DB[row.status] ?? "planning",
    health: HEALTH_FROM_DB[row.health] ?? "healthy",
    owner: {
      name: ownerName || "Unassigned",
      avatar: (ownerRow ? resolveAvatarUrl(ownerRow.avatar_url, ownerRow.updated_at) : null) ?? FALLBACK_AVATAR,
    },
    lead: leadRow
      ? {
          id: leadRow.id,
          name: [leadRow.first_name, leadRow.last_name].filter(Boolean).join(" ") || "Unassigned",
          avatar: resolveAvatarUrl(leadRow.avatar_url, leadRow.updated_at) ?? FALLBACK_AVATAR,
        }
      : null,
    updatedAt: formatUpdatedAt(row.updated_at),
    targetDate: formatTargetDate(row.target_date),
    activeMilestones: 0,
    openTickets: 0,
    blockedTickets: 0,
    overdueTickets: 0,
    awaitingReviewTickets: 0,
    dueThisWeekTickets: 0,
    progress: 0,
    category: CATEGORY_VALUES.includes(row.category as ProjectCategory) ? (row.category as ProjectCategory) : "internal",
    // ClientName is a closed union in mock-projects.ts (a placeholder
    // roster, per its own comment, for a future real Clients entity) —
    // client_name in the real schema is free text, so this is a display
    // cast, not a validated membership check.
    client: (row.client_name as ClientName | null) ?? undefined,
    defaultHourlyRate: row.default_hourly_rate !== null ? Number(row.default_hourly_rate) : undefined,
  };
}

export function formatTargetDate(isoDate: string | null): string {
  if (!isoDate) return "—";
  return new Date(`${isoDate}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// "Mar 3, 2026" — Project Overview header's "Started ..." line only.
function formatCreatedAt(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatUpdatedAt(isoTimestamp: string): string {
  const diffHours = (Date.now() - new Date(isoTimestamp).getTime()) / (1000 * 60 * 60);
  if (diffHours < 1) return "Just now";
  if (diffHours < 24) {
    const hours = Math.floor(diffHours);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  const diffWeeks = Math.floor(diffDays / 7);
  if (diffWeeks < 5) return `${diffWeeks} week${diffWeeks === 1 ? "" : "s"} ago`;
  const diffMonths = Math.floor(diffDays / 30);
  return `${diffMonths} month${diffMonths === 1 ? "" : "s"} ago`;
}

function logDev(...args: unknown[]): void {
  if (process.env.NODE_ENV !== "production") console.warn("[projects]", ...args);
}

export interface LoadProjectsOptions {
  /**
   * Reserved for future pagination — omitted (the default everywhere today)
   * fetches every project for the org, exactly like before this option
   * existed. Passing `limit` (with optional `offset`) applies `.range()`
   * without changing any other behavior, so pagination can be added later
   * by wiring these through from the UI rather than restructuring the query.
   */
  limit?: number;
  offset?: number;
}

export async function loadOrganizationProjects(
  organizationId: string,
  options: LoadProjectsOptions = {}
): Promise<ProjectsResult> {
  const supabase = getSupabaseBrowserClient();

  let query = supabase
    .from("projects")
    .select(PROJECT_COLUMNS)
    .eq("organization_id", organizationId)
    // Secondary tie-break so row order is fully deterministic even when
    // two projects share the same updated_at down to the microsecond —
    // .range()-based pagination later needs a stable sort to avoid
    // skipping/duplicating rows across pages; today it's just a harmless
    // guarantee since ties are otherwise vanishingly rare.
    .order("updated_at", { ascending: false })
    .order("slug", { ascending: true });

  if (options.limit !== undefined) {
    const offset = options.offset ?? 0;
    query = query.range(offset, offset + options.limit - 1);
  }

  const { data: rows, error } = await query.returns<ProjectRow[]>();

  if (error) {
    logDev("projects query failed", error);
    return { status: "error", message: error.message };
  }

  const ownerIds = Array.from(
    new Set((rows ?? []).map((row) => row.owner_profile_id).filter((id): id is string => Boolean(id)))
  );

  // Flat second query instead of an embedded select (`owner:profiles(...)`)
  // — same reasoning as loadMembership in membership.ts: embedded selects
  // rely on PostgREST's FK relationship cache, which can lag behind a
  // migration applied by hand until the schema cache is reloaded.
  const ownersById = new Map<string, OwnerProfileRow>();
  if (ownerIds.length > 0) {
    const { data: ownerRows, error: ownerError } = await supabase
      .from("profiles")
      .select("id, first_name, last_name, avatar_url, updated_at")
      .in("id", ownerIds)
      .returns<OwnerProfileRow[]>();

    if (ownerError) {
      logDev("owner profiles query failed", ownerError);
    } else {
      for (const ownerRow of ownerRows ?? []) ownersById.set(ownerRow.id, ownerRow);
    }
  }

  // Real Project Lead is a project_memberships row with project_role =
  // 'lead' — a separate, authoritative signal from owner_profile_id above
  // (same reasoning as loadLeadProjects' own comment further down: Team and
  // the Dashboards already key off project_role = 'lead', never
  // owner_profile_id, so this mirrors that instead of introducing a second
  // notion of "lead"). Batched the same way as the owner lookup just above,
  // and merged into the same `ownersById` profiles map/query so a profile
  // that's both someone's owner_profile_id and a project_role = 'lead'
  // isn't fetched twice.
  const projectIds = (rows ?? []).map((row) => row.id);
  const leadProfileIdByProjectId = new Map<string, string>();
  if (projectIds.length > 0) {
    const { data: leadRows, error: leadError } = await supabase
      .from("project_memberships")
      .select("project_id, profile_id")
      .eq("project_role", "lead")
      .in("project_id", projectIds)
      .returns<{ project_id: string; profile_id: string }[]>();

    if (leadError) {
      logDev("project lead memberships query failed", leadError);
    } else {
      for (const leadRow of leadRows ?? []) leadProfileIdByProjectId.set(leadRow.project_id, leadRow.profile_id);
    }
  }

  const missingLeadProfileIds = Array.from(new Set(leadProfileIdByProjectId.values())).filter(
    (id) => !ownersById.has(id)
  );
  if (missingLeadProfileIds.length > 0) {
    const { data: leadProfileRows, error: leadProfileError } = await supabase
      .from("profiles")
      .select("id, first_name, last_name, avatar_url, updated_at")
      .in("id", missingLeadProfileIds)
      .returns<OwnerProfileRow[]>();

    if (leadProfileError) {
      logDev("lead profiles query failed", leadProfileError);
    } else {
      for (const leadProfileRow of leadProfileRows ?? []) ownersById.set(leadProfileRow.id, leadProfileRow);
    }
  }

  const projects: ProjectSummary[] = (rows ?? []).map((row) => {
    const leadProfileId = leadProfileIdByProjectId.get(row.id);
    return rowToProjectSummary(
      row,
      row.owner_profile_id ? ownersById.get(row.owner_profile_id) : undefined,
      leadProfileId ? ownersById.get(leadProfileId) : undefined
    );
  });

  return { status: "ready", projects };
}

// Minimal create flow: name + optional description, status starts "active"
// (the schema's own column default is "planning" — this overrides it per
// product requirement), slug/project_code auto-derived from the name since
// the create form doesn't collect them. Leaves owner_profile_id/category/
// health at their column defaults — not part of this flow.
//
// Deliberately two separate requests, not a single chained
// `.insert(...).select().single()` (which compiles to one INSERT ...
// RETURNING): a project's SELECT visibility for a non-admin creator
// (Project Lead) depends on projects_add_creator_membership
// (20260803000000, an AFTER INSERT trigger) having already inserted their
// own project_memberships row — Postgres applies the table's SELECT
// policy to a RETURNING clause the same as it would a plain SELECT, and
// this is the very first real path where that visibility depends on a
// side effect of the same statement rather than the row's own columns
// (every other RETURNING call site in this codebase is Admin-only or
// keys off a column the inserting user already owns). Splitting into an
// insert, then a separate follow-up read, removes any dependency on
// exactly when a same-statement AFTER trigger's effects become visible to
// that statement's own RETURNING output — the second request is a
// genuinely new statement, issued only once the first has already
// completed, so the trigger's row is unambiguously committed and visible
// by the time it runs.
export async function createProject(params: {
  organizationId: string;
  name: string;
  description: string;
}): Promise<CreateProjectResult> {
  const supabase = getSupabaseBrowserClient();
  const name = params.name.trim();
  const slug = slugify(name);

  const { error: insertError } = await supabase.from("projects").insert({
    organization_id: params.organizationId,
    slug,
    name,
    project_code: generateProjectCode(name),
    description: params.description.trim() || null,
    status: "active",
  });

  if (insertError) {
    logDev("projects insert failed", insertError);
    // 23505 = unique_violation — collides with (organization_id, slug) or
    // (organization_id, project_code), both derived from the same name.
    if (insertError.code === "23505") {
      return { status: "error", message: "A project with this name already exists in your organization." };
    }
    return { status: "error", message: insertError.message };
  }

  const { data, error } = await supabase
    .from("projects")
    .select(PROJECT_COLUMNS)
    .eq("organization_id", params.organizationId)
    .eq("slug", slug)
    .single<ProjectRow>();

  if (error || !data) {
    logDev("project read-back after creation failed", error);
    return { status: "error", message: error?.message ?? "Project was created but could not be loaded." };
  }

  return { status: "success", project: rowToProjectSummary(data, undefined) };
}

// Minimal edit flow: name + description only. organization_id, slug,
// project_code, status, and every other column are left untouched — the
// WHERE clause matches on (organization_id, slug), the same unique pair
// used to look the project up, so no other column needs to change to
// identify the row.
export async function updateProject(params: {
  organizationId: string;
  slug: string;
  name: string;
  description: string;
}): Promise<CreateProjectResult> {
  const supabase = getSupabaseBrowserClient();
  const name = params.name.trim();

  const { data, error } = await supabase
    .from("projects")
    .update({ name, description: params.description.trim() || null })
    .eq("organization_id", params.organizationId)
    .eq("slug", params.slug)
    .select(PROJECT_COLUMNS)
    .single<ProjectRow>();

  if (error) {
    logDev("projects update failed", error);
    return { status: "error", message: error.message };
  }

  return { status: "success", project: rowToProjectSummary(data, undefined) };
}

// Archive only sets status to "archived" — no other column changes, and
// nothing is deleted. Tickets/comments/activity/time tracking reference
// the project by id, untouched by this update, so they remain exactly as
// they were.
export async function archiveProject(params: { organizationId: string; slug: string }): Promise<CreateProjectResult> {
  const supabase = getSupabaseBrowserClient();

  const { data, error } = await supabase
    .from("projects")
    .update({ status: "archived" })
    .eq("organization_id", params.organizationId)
    .eq("slug", params.slug)
    .select(PROJECT_COLUMNS)
    .single<ProjectRow>();

  if (error) {
    logDev("projects archive failed", error);
    return { status: "error", message: error.message };
  }

  return { status: "success", project: rowToProjectSummary(data, undefined) };
}

// Mirror of archiveProject — sets status back to "active". No confirmation
// step at this layer; the UI decides whether to prompt (restore doesn't).
export async function restoreProject(params: { organizationId: string; slug: string }): Promise<CreateProjectResult> {
  const supabase = getSupabaseBrowserClient();

  const { data, error } = await supabase
    .from("projects")
    .update({ status: "active" })
    .eq("organization_id", params.organizationId)
    .eq("slug", params.slug)
    .select(PROJECT_COLUMNS)
    .single<ProjectRow>();

  if (error) {
    logDev("projects restore failed", error);
    return { status: "error", message: error.message };
  }

  return { status: "success", project: rowToProjectSummary(data, undefined) };
}

// "Delete Project" (Project Settings → Danger Zone) — permanent removal,
// never a direct client-side delete: this feature's own Admin-only
// requirement is stricter than projects_delete's own RLS policy (which
// also allows Project Lead), so it has to be re-verified server-side
// regardless of what this screen's own role check shows. See
// src/lib/server/delete-project-action.ts.
export async function deleteProjectPermanently(organizationId: string, projectId: string): Promise<DeleteProjectResult> {
  const supabase = getSupabaseBrowserClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    return { status: "error", message: "Your session has expired. Please sign in again." };
  }

  return deleteProjectAction({
    accessToken: session.access_token,
    organizationId,
    projectId,
  });
}

// Single-project read for Project Settings — same PROJECT_COLUMNS as the
// list loader, plus owner_profile_id exposed on the result (see
// ProjectDetail) so the Project Lead picker can preselect the right member.
export async function loadProjectDetail(organizationId: string, slug: string): Promise<ProjectDetailResult> {
  const supabase = getSupabaseBrowserClient();

  const { data: row, error } = await supabase
    .from("projects")
    .select(PROJECT_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("slug", slug)
    .maybeSingle<ProjectRow>();

  if (error) {
    logDev("project detail query failed", error);
    return { status: "error", message: error.message };
  }
  if (!row) return { status: "not-found" };

  let ownerRow: OwnerProfileRow | undefined;
  if (row.owner_profile_id) {
    const { data: profileRow, error: ownerError } = await supabase
      .from("profiles")
      .select("id, first_name, last_name, avatar_url, updated_at")
      .eq("id", row.owner_profile_id)
      .maybeSingle<OwnerProfileRow>();
    if (ownerError) logDev("owner profile query failed", ownerError);
    else ownerRow = profileRow ?? undefined;
  }

  return {
    status: "ready",
    project: {
      ...rowToProjectSummary(row, ownerRow),
      id: row.id,
      ownerProfileId: row.owner_profile_id,
      createdAt: formatCreatedAt(row.created_at),
      createdAtISO: row.created_at,
      targetDateISO: row.target_date,
      repositoryProvider:
        row.repository_provider && REPOSITORY_PROVIDER_VALUES.includes(row.repository_provider as RepositoryProvider)
          ? (row.repository_provider as RepositoryProvider)
          : null,
      // A provider-less row's URL is always null anyway (DB constraint),
      // but this never trusts a stale/malformed row to display one.
      repositoryUrl: row.repository_provider ? row.repository_url : null,
    },
  };
}

// Org roster for the Project Lead picker — any active member is a valid
// candidate (the schema doesn't restrict owner_profile_id to a role), same
// scope as the Admin-only Users module's eventual real data source. Two
// flat queries rather than an embedded select, same reasoning as
// loadOrganizationProjects above (avoids depending on PostgREST's FK
// relationship cache).
export async function loadOrganizationMembers(organizationId: string): Promise<OrgMembersResult> {
  const supabase = getSupabaseBrowserClient();

  const { data: membershipRows, error } = await supabase
    .from("organization_memberships")
    .select("profile_id")
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .returns<{ profile_id: string }[]>();

  if (error) {
    logDev("organization members query failed", error);
    return { status: "error", message: error.message };
  }

  const profileIds = (membershipRows ?? []).map((row) => row.profile_id);
  if (profileIds.length === 0) return { status: "ready", members: [] };

  const { data: profileRows, error: profileError } = await supabase
    .from("profiles")
    .select("id, first_name, last_name, avatar_url, updated_at")
    .in("id", profileIds)
    .returns<OwnerProfileRow[]>();

  if (profileError) {
    logDev("member profiles query failed", profileError);
    return { status: "error", message: profileError.message };
  }

  const members: OrgMember[] = (profileRows ?? [])
    .map((row) => ({
      id: row.id,
      name: [row.first_name, row.last_name].filter(Boolean).join(" ") || "Unnamed",
      avatar: resolveAvatarUrl(row.avatar_url, row.updated_at) ?? FALLBACK_AVATAR,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { status: "ready", members };
}

export interface OrgWorkloadMember {
  id: string;
  name: string;
  avatar: string;
  weeklyCapacity: number;
}

export type OrgWorkloadMembersResult =
  | { status: "ready"; members: OrgWorkloadMember[] }
  | { status: "error"; message: string };

// Active org members with their real weekly_capacity — backs the Admin
// Dashboard's Team Workload widget only. Deliberately its own function
// rather than adding weekly_capacity onto loadOrganizationMembers above:
// that one's existing callers (the Project Lead picker) don't need it, and
// this keeps that unrelated call site untouched. Assigned hours (the other
// half of "workload") come from tickets already loaded elsewhere — see
// dashboard-screen.tsx — computed with the exact same "active tickets only"
// definition team-screen.tsx already uses, not duplicated here.
export async function loadOrganizationWorkloadMembers(organizationId: string): Promise<OrgWorkloadMembersResult> {
  const supabase = getSupabaseBrowserClient();

  const { data: membershipRows, error } = await supabase
    .from("organization_memberships")
    .select("profile_id, weekly_capacity")
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .returns<{ profile_id: string; weekly_capacity: number | null }[]>();

  if (error) {
    logDev("organization workload members query failed", error);
    return { status: "error", message: error.message };
  }

  if (!membershipRows || membershipRows.length === 0) return { status: "ready", members: [] };

  const capacityByProfileId = new Map(membershipRows.map((row) => [row.profile_id, row.weekly_capacity ?? 0]));
  const profileIds = membershipRows.map((row) => row.profile_id);

  const { data: profileRows, error: profileError } = await supabase
    .from("profiles")
    .select("id, first_name, last_name, avatar_url, updated_at")
    .in("id", profileIds)
    .returns<OwnerProfileRow[]>();

  if (profileError) {
    logDev("workload member profiles query failed", profileError);
    return { status: "error", message: profileError.message };
  }

  const members: OrgWorkloadMember[] = (profileRows ?? []).map((row) => ({
    id: row.id,
    name: [row.first_name, row.last_name].filter(Boolean).join(" ") || "Unnamed",
    avatar: resolveAvatarUrl(row.avatar_url, row.updated_at) ?? FALLBACK_AVATAR,
    weeklyCapacity: capacityByProfileId.get(row.id) ?? 0,
  }));

  return { status: "ready", members };
}

export interface LeadProject {
  slug: string;
  name: string;
  targetDate: string;
}

export type LeadProjectsResult =
  | { status: "ready"; projects: LeadProject[] }
  | { status: "error"; message: string };

// Active projects this specific profile leads, per the one authoritative
// per-project signal for that: project_memberships.project_role = 'lead'
// (see 20260812000000_add_project_membership_project_role.sql and Team's
// "Make Project Lead" action, which is the only thing that ever writes
// it). Backs the Project Lead Dashboard's Current Project selector only.
//
// Previously this queried projects.owner_profile_id instead — a different,
// older "Project Lead" field (Project Settings' own picker) that Make
// Project Lead never touches, so a real project_role = 'lead' membership
// never showed up here even though Team and the sidebar both already
// recognized it correctly (both ultimately key off project_memberships,
// via can_view_project's is_project_member check — this function now does
// the same). profile_id, not any organization_membership id, is what
// project_memberships is keyed on throughout this app.
//
// RLS (project_memberships_select / projects_select, both via
// can_view_project) already limits results to what this profile can
// actually see — a lead row on a project this profile can't otherwise view
// simply won't come back, same as everywhere else in this app.
//
// `includeNonActive` (default false — every existing caller unchanged)
// widens the status filter from "active only" to "anything not archived"
// (planning/on-hold/completed too), for callers that must classify a
// project as led by the real project_role alone — Project Lead Time
// Tracking and its Work History. The lead test itself is identical.
export async function loadLeadProjects(
  organizationId: string,
  profileId: string,
  options: { includeNonActive?: boolean } = {}
): Promise<LeadProjectsResult> {
  const supabase = getSupabaseBrowserClient();

  const { data: leadRows, error: leadError } = await supabase
    .from("project_memberships")
    .select("project_id")
    .eq("profile_id", profileId)
    .eq("project_role", "lead")
    .returns<{ project_id: string }[]>();

  if (leadError) {
    logDev("lead project memberships query failed", leadError);
    return { status: "error", message: leadError.message };
  }
  if (!leadRows || leadRows.length === 0) return { status: "ready", projects: [] };

  const projectIds = leadRows.map((row) => row.project_id);

  const scoped = supabase
    .from("projects")
    .select("slug, name, target_date")
    .eq("organization_id", organizationId);
  const { data: rows, error } = await (options.includeNonActive
    ? scoped.neq("status", "archived")
    : scoped.eq("status", "active")
  )
    .in("id", projectIds)
    .order("name", { ascending: true })
    .returns<{ slug: string; name: string; target_date: string | null }[]>();

  if (error) {
    logDev("lead projects query failed", error);
    return { status: "error", message: error.message };
  }

  const projects: LeadProject[] = (rows ?? []).map((row) => ({
    slug: row.slug,
    name: row.name,
    targetDate: formatTargetDate(row.target_date),
  }));

  return { status: "ready", projects };
}

export interface MemberProject {
  slug: string;
  name: string;
}

export type MemberProjectsResult =
  | { status: "ready"; projects: MemberProject[] }
  | { status: "error"; message: string };

// Active projects this profile currently has any real Team membership on —
// same shape/query as loadLeadProjects just above, minus its
// project_role = 'lead' filter, since here any real project_memberships row
// (Lead or Member) counts. Backs the Member Dashboard's own project
// selector only. RLS (project_memberships_select / projects_select, both
// via can_view_project) already limits results to what this profile can
// actually see, same as loadLeadProjects.
export async function loadMemberProjects(organizationId: string, profileId: string): Promise<MemberProjectsResult> {
  const supabase = getSupabaseBrowserClient();

  const { data: membershipRows, error: membershipError } = await supabase
    .from("project_memberships")
    .select("project_id")
    .eq("profile_id", profileId)
    .returns<{ project_id: string }[]>();

  if (membershipError) {
    logDev("member project memberships query failed", membershipError);
    return { status: "error", message: membershipError.message };
  }
  if (!membershipRows || membershipRows.length === 0) return { status: "ready", projects: [] };

  const projectIds = membershipRows.map((row) => row.project_id);

  const { data: rows, error } = await supabase
    .from("projects")
    .select("slug, name")
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .in("id", projectIds)
    .order("name", { ascending: true })
    .returns<{ slug: string; name: string }[]>();

  if (error) {
    logDev("member projects query failed", error);
    return { status: "error", message: error.message };
  }

  return { status: "ready", projects: (rows ?? []).map((row) => ({ slug: row.slug, name: row.name })) };
}

export interface ProjectSettingsUpdate {
  name?: string;
  description?: string;
  projectCode?: string;
  status?: EditableProjectStatus;
  category?: ProjectCategory;
  client?: string | null;
  defaultHourlyRate?: number | null;
  ownerProfileId?: string | null;
  /** Raw ISO `yyyy-mm-dd`, or null to clear — writes projects.target_date directly, the same real column Project Overview/the Project Lead Dashboard already read. */
  targetDate?: string | null;
  /** null clears the integration entirely ("None") — repositoryUrl is then ignored and always written as null. */
  repositoryProvider?: RepositoryProvider | null;
  repositoryUrl?: string | null;
}

// Settings-only write: only the keys present on `updates` are sent to
// Supabase ("persist only the fields that changed"). Archiving/restoring
// (status -> "archived"/"active" specifically) goes through
// archiveProject/restoreProject exclusively — updates.status's type
// (EditableProjectStatus) makes "archived" structurally impossible to pass
// through this function, so there's no parallel path to that transition.
export async function updateProjectSettings(
  organizationId: string,
  slug: string,
  updates: ProjectSettingsUpdate
): Promise<CreateProjectResult> {
  const supabase = getSupabaseBrowserClient();

  const payload: Record<string, string | number | null> = {};
  if (updates.name !== undefined) payload.name = updates.name.trim();
  if (updates.description !== undefined) payload.description = updates.description.trim() || null;
  if (updates.projectCode !== undefined) payload.project_code = updates.projectCode.trim();
  if (updates.status !== undefined) payload.status = STATUS_TO_DB[updates.status];
  if (updates.category !== undefined) payload.category = updates.category;
  if (updates.client !== undefined) payload.client_name = updates.client;
  if (updates.defaultHourlyRate !== undefined) payload.default_hourly_rate = updates.defaultHourlyRate;
  if (updates.ownerProfileId !== undefined) payload.owner_profile_id = updates.ownerProfileId;
  if (updates.targetDate !== undefined) payload.target_date = updates.targetDate;

  if (updates.repositoryProvider !== undefined) {
    if (updates.repositoryProvider === null) {
      // "None" — provider and URL are always cleared together, regardless
      // of what updates.repositoryUrl itself is.
      payload.repository_provider = null;
      payload.repository_url = null;
    } else {
      // Backend-side safety net behind the UI's own pre-Save check — this
      // is the one real write path Project Settings uses, so a direct call
      // (bypassing the UI) can never persist a malformed/missing URL either.
      const rawUrl = updates.repositoryUrl ?? "";
      const validationError = validateRepositoryUrl(updates.repositoryProvider, rawUrl);
      if (validationError) {
        return { status: "error", message: validationError };
      }
      payload.repository_provider = updates.repositoryProvider;
      payload.repository_url = normalizeRepositoryUrl(rawUrl);
    }
  } else if (updates.repositoryUrl !== undefined) {
    payload.repository_url = updates.repositoryUrl;
  }

  const { data, error } = await supabase
    .from("projects")
    .update(payload)
    .eq("organization_id", organizationId)
    .eq("slug", slug)
    .select(PROJECT_COLUMNS)
    .single<ProjectRow>();

  if (error) {
    logDev("project settings update failed", error);
    // 23505 = unique_violation — only project_code carries a unique
    // constraint among the fields this function ever writes (slug itself
    // is never edited here).
    if (error.code === "23505") {
      return { status: "error", message: "This project code is already used by another project in your organization." };
    }
    return { status: "error", message: error.message };
  }

  return { status: "success", project: rowToProjectSummary(data, undefined) };
}

// ── Clients (Project Settings → Billing → "+ Add new client") ───────────────
// Deliberately not a foreign key on projects — projects.client_name stays
// free text (see updateProjectSettings above). This table exists only so
// the Client dropdown can offer a real, growing, per-organization roster
// instead of the hardcoded CLIENT_NAMES placeholder in mock-projects.ts.

export interface Client {
  id: string;
  name: string;
}

export type ClientsResult =
  | { status: "ready"; clients: Client[] }
  | { status: "error"; message: string };

export async function loadOrganizationClients(organizationId: string): Promise<ClientsResult> {
  const supabase = getSupabaseBrowserClient();

  const { data, error } = await supabase
    .from("clients")
    .select("id, name")
    .eq("organization_id", organizationId)
    .order("name", { ascending: true })
    .returns<Client[]>();

  if (error) {
    logDev("clients query failed", error);
    return { status: "error", message: error.message };
  }

  return { status: "ready", clients: data ?? [] };
}

export type CreateClientResult =
  | { status: "success"; client: Client }
  | { status: "error"; message: string };

// Named createOrganizationClient (not createClient) to avoid any confusion
// with @supabase/supabase-js's own createClient re-exported from
// supabase-client.ts in this same module graph.
export async function createOrganizationClient(organizationId: string, name: string): Promise<CreateClientResult> {
  const supabase = getSupabaseBrowserClient();
  const trimmed = name.trim();

  const { data, error } = await supabase
    .from("clients")
    .insert({ organization_id: organizationId, name: trimmed })
    .select("id, name")
    .single<Client>();

  if (error) {
    logDev("client insert failed", error);
    // 23505 = unique_violation on (organization_id, name) — the basic
    // duplicate-prevention this table's unique constraint provides.
    if (error.code === "23505") {
      return { status: "error", message: "A client with this name already exists in your organization." };
    }
    return { status: "error", message: error.message };
  }

  return { status: "success", client: data };
}

// ── Team (Project → Team) ────────────────────────────────────────────────────
// Real replacement for src/lib/mock-team.ts on the Team screen only
// (/projects/[slug]/team) — every other mock-team.ts consumer (the shared
// Member Profile Modal's per-project single-view mode, resolveTeamMember,
// etc.) is untouched. project_memberships rows here are mostly *not*
// written by this module: a database trigger (see migration
// 20260808000000_auto_project_membership_on_contribution.sql) creates one
// automatically the first time a person contributes to the project's
// tickets (create/edit a ticket, comment, attach a file, log time, link a
// ticket) — this only reads that table, plus the two writes "+ Add Member"
// and (if ever wired up) member removal need directly.
//
// weeklyCapacity/assignedHours are *not* combined here: assignedHours needs
// real tickets, which this module intentionally never imports (tickets.ts
// already exports loadProjectTickets for that, and every other real-data
// consumer that needs both — e.g. member-profile-modal.tsx — already
// combines them itself instead of one module depending on the other).

// Same organization_memberships.role -> display label mapping Users
// already shows (see ROLE_LABELS in lib/current-user.ts) — duplicated here
// as a small local map (same convention as every other DB-value label map
// in this codebase, e.g. tickets.ts's own activityStatusLabel) rather than
// importing a differently-shaped module for one lookup table.
const ORG_ROLE_LABEL: Record<string, string> = {
  admin: "Admin",
  project_lead: "Project Lead",
  member: "Member",
};

export interface ProjectTeamMember {
  /** profiles.id — also what project_memberships is keyed on for this project. */
  id: string;
  name: string;
  email: string;
  avatar: string;
  /** organization_memberships.role for this profile, in this org — "Admin" /
   *  "Project Lead" / "Member". This is the person's real org-wide role,
   *  never project_memberships.title (see below) — that field only ever
   *  determines project membership, not what's displayed as their role. */
  title: string;
  weeklyCapacity: number;
  /** project_memberships.project_role ('lead' | 'member') — the one
   *  project-scoped role this table models today; see
   *  20260812000000_add_project_membership_project_role.sql. Never derived
   *  from organization_memberships. */
  projectRole: "lead" | "member";
}

export type ProjectTeamResult =
  | { status: "ready"; members: ProjectTeamMember[] }
  | { status: "error"; message: string };

interface TeamMembershipRow {
  profile_id: string;
  project_role: string;
}

interface TeamProfileRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  avatar_url: string | null;
  updated_at: string;
}

interface TeamOrgRoleRow {
  profile_id: string;
  role: string;
  weekly_capacity: number | null;
}

export async function loadProjectTeam(organizationId: string, slug: string): Promise<ProjectTeamResult> {
  const supabase = getSupabaseBrowserClient();

  const { data: projectRow, error: projectError } = await supabase
    .from("projects")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("slug", slug)
    .maybeSingle<{ id: string }>();

  if (projectError) {
    logDev("project id lookup failed", projectError);
    return { status: "error", message: projectError.message };
  }
  if (!projectRow) return { status: "ready", members: [] };

  const { data: membershipRows, error: membershipError } = await supabase
    .from("project_memberships")
    .select("profile_id, project_role")
    .eq("project_id", projectRow.id)
    .returns<TeamMembershipRow[]>();

  if (membershipError) {
    logDev("project_memberships query failed", membershipError);
    return { status: "error", message: membershipError.message };
  }
  if (!membershipRows || membershipRows.length === 0) return { status: "ready", members: [] };

  const profileIds = membershipRows.map((row) => row.profile_id);

  // Real org role (Admin/Project Lead/Member) comes from
  // organization_memberships — the same table Users reads — fetched here
  // as one batched query for every member at once, in parallel with the
  // profiles lookup, never one query per person.
  const [profilesResult, orgRolesResult] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, first_name, last_name, email, avatar_url, updated_at")
      .in("id", profileIds)
      .returns<TeamProfileRow[]>(),
    supabase
      .from("organization_memberships")
      .select("profile_id, role, weekly_capacity")
      .eq("organization_id", organizationId)
      .in("profile_id", profileIds)
      .returns<TeamOrgRoleRow[]>(),
  ]);

  if (profilesResult.error) {
    logDev("team profiles query failed", profilesResult.error);
    return { status: "error", message: profilesResult.error.message };
  }
  if (orgRolesResult.error) {
    logDev("team org roles query failed", orgRolesResult.error);
    return { status: "error", message: orgRolesResult.error.message };
  }

  const profileById = new Map((profilesResult.data ?? []).map((p) => [p.id, p]));
  const orgRoleLabelByProfileId = new Map(
    (orgRolesResult.data ?? []).map((row) => [row.profile_id, ORG_ROLE_LABEL[row.role] ?? row.role])
  );
  // Weekly capacity belongs to the member, never the project — the single
  // source of truth is always organization_memberships.weekly_capacity,
  // never project_memberships.weekly_capacity (which may still exist in the
  // schema for other features, but is never read for capacity/utilization
  // here or anywhere else). Same real number Users/Profile already show for
  // this member, regardless of how many projects they're staffed on.
  const orgCapacityByProfileId = new Map((orgRolesResult.data ?? []).map((row) => [row.profile_id, row.weekly_capacity ?? 0]));

  const members: ProjectTeamMember[] = membershipRows
    .map((membership): ProjectTeamMember | null => {
      const profile = profileById.get(membership.profile_id);
      if (!profile) return null; // orphaned membership row, no matching profile
      return {
        id: profile.id,
        name: [profile.first_name, profile.last_name].filter(Boolean).join(" ") || "Unnamed",
        email: profile.email ?? "",
        avatar: resolveAvatarUrl(profile.avatar_url, profile.updated_at) ?? FALLBACK_AVATAR,
        title: orgRoleLabelByProfileId.get(profile.id) ?? "Member",
        weeklyCapacity: orgCapacityByProfileId.get(profile.id) ?? 0,
        projectRole: membership.project_role === "lead" ? "lead" : "member",
      };
    })
    .filter((m): m is ProjectTeamMember => m !== null)
    .sort((a, b) => a.name.localeCompare(b.name));

  return { status: "ready", members };
}

export type ProjectMemberWriteResult = { status: "success" } | { status: "error"; message: string };

// "+ Add Member" — direct client write, unlike the Server Actions elsewhere
// in this app: project_memberships_insert's own RLS (is_org_admin_or_lead)
// is exactly who Team's "+ Add Member" button is already gated to
// (canManage(user.role) in team-screen.tsx), so no privileged service-role
// escalation is needed here, only the table grant added in
// 20260807000000. Never touches organization_memberships/profiles/auth
// users — only this one project_memberships row.
export async function addProjectMember(
  organizationId: string,
  slug: string,
  profileId: string
): Promise<ProjectMemberWriteResult> {
  const supabase = getSupabaseBrowserClient();

  const { data: projectRow, error: projectError } = await supabase
    .from("projects")
    .select("id, name")
    .eq("organization_id", organizationId)
    .eq("slug", slug)
    .maybeSingle<{ id: string; name: string }>();

  if (projectError) {
    logDev("project id lookup failed", projectError);
    return { status: "error", message: projectError.message };
  }
  if (!projectRow) return { status: "error", message: "Project not found." };

  const { error } = await supabase
    .from("project_memberships")
    .insert({ project_id: projectRow.id, profile_id: profileId, title: "Member" });

  if (error) {
    logDev("project_memberships insert failed", error);
    // 23505 = unique_violation on (project_id, profile_id) — already a
    // member (e.g. auto-added by a contribution) is not a real failure, and
    // — since nothing was actually newly added — never notifies either.
    if (error.code === "23505") return { status: "success" };
    return { status: "error", message: error.message };
  }

  // Fire-and-forget: never delays or can fail the already-successful add
  // above. createNotification's own actor===recipient guard covers a
  // member adding themselves to a project, if that flow is ever possible.
  void notifyProjectMemberAdded(supabase, organizationId, projectRow.id, projectRow.name, profileId).catch((err) => {
    logDev("project member added notification failed", err);
  });

  return { status: "success" };
}

// The one place "added to project" text is composed, so Team's "+ Add
// Member" and the Project Lead Dashboard's own add-member action (both real
// callers of addProjectMember) share it rather than duplicating this
// lookup. Never fires for the auto-membership-on-contribution DB trigger,
// which doesn't go through this JS function at all — only a real, explicit
// add does.
async function notifyProjectMemberAdded(
  supabase: ReturnType<typeof getSupabaseBrowserClient>,
  organizationId: string,
  projectId: string,
  projectName: string,
  recipientProfileId: string
): Promise<void> {
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  const actorProfileId = authUser?.id ?? null;

  let actorName = "Someone";
  if (actorProfileId) {
    const { data: actorRow } = await supabase
      .from("profiles")
      .select("first_name, last_name")
      .eq("id", actorProfileId)
      .maybeSingle<{ first_name: string | null; last_name: string | null }>();
    actorName = actorRow ? [actorRow.first_name, actorRow.last_name].filter(Boolean).join(" ") || "Unnamed" : "Someone";
  }

  await createNotification({
    organizationId,
    recipientProfileId,
    actorProfileId,
    type: "project_member_added",
    title: `${actorName} added you to ${projectName}`,
    projectId,
  });
}

// ── Project access requests ──────────────────────────────────────────────────
// A Member requesting to join a project they're not staffed on yet
// ("Other Projects" in their own /projects view), and that project's real
// Lead approving/rejecting it from theirs. See
// 20260908000000_add_project_access_requests.sql for the table/RLS/
// trigger this all rests on. Approving reuses addProjectMember above
// verbatim — this file never inserts into project_memberships a second way.

export type ProjectAccessRequestStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface BrowsableOrgProject {
  id: string;
  slug: string;
  name: string;
  shortName: string | null;
  category: ProjectCategory;
  description: string | null;
  clientName: string | null;
}

export type BrowsableOrgProjectsResult =
  | { status: "ready"; projects: BrowsableOrgProject[] }
  | { status: "error"; message: string };

interface BrowsableProjectRow {
  id: string;
  slug: string;
  name: string;
  short_name: string | null;
  category: ProjectCategory;
  description: string | null;
  client_name: string | null;
}

// Active org projects the caller isn't already staffed on — projects_select
// RLS (can_view_project) deliberately hides these from a plain Member, so
// this goes through list_browsable_org_projects (security definer, exposes
// only the fields the "Other Projects" card needs) rather than a second,
// looser projects_select policy.
export async function loadBrowsableOrgProjects(organizationId: string): Promise<BrowsableOrgProjectsResult> {
  const supabase = getSupabaseBrowserClient();

  const { data, error } = await supabase.rpc("list_browsable_org_projects", { target_org_id: organizationId });

  if (error) {
    logDev("browsable org projects query failed", error);
    return { status: "error", message: error.message };
  }

  const rows = (data ?? []) as BrowsableProjectRow[];
  const projects: BrowsableOrgProject[] = rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    shortName: row.short_name,
    category: row.category,
    description: row.description,
    clientName: row.client_name,
  }));

  return { status: "ready", projects };
}

export interface ProjectAccessRequest {
  id: string;
  projectId: string;
  projectSlug: string;
  projectName: string;
  requesterProfileId: string;
  requesterName: string;
  requesterAvatar: string;
  status: ProjectAccessRequestStatus;
  /** Pre-formatted absolute date ("Aug 3, 2026"), same convention as the rest of this app's date displays. */
  requestedAt: string;
}

export type ProjectAccessRequestsResult =
  | { status: "ready"; requests: ProjectAccessRequest[] }
  | { status: "error"; message: string };

interface AccessRequestRow {
  id: string;
  project_id: string;
  requester_profile_id: string;
  status: ProjectAccessRequestStatus;
  created_at: string;
}

interface AccessRequestProfileRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  avatar_url: string | null;
  updated_at: string;
}

async function hydrateAccessRequests(
  supabase: ReturnType<typeof getSupabaseBrowserClient>,
  rows: AccessRequestRow[]
): Promise<ProjectAccessRequest[]> {
  if (rows.length === 0) return [];

  const projectIds = Array.from(new Set(rows.map((r) => r.project_id)));
  const requesterIds = Array.from(new Set(rows.map((r) => r.requester_profile_id)));

  const [{ data: projectRows }, { data: profileRows }] = await Promise.all([
    supabase.from("projects").select("id, slug, name").in("id", projectIds).returns<{ id: string; slug: string; name: string }[]>(),
    supabase
      .from("profiles")
      .select("id, first_name, last_name, avatar_url, updated_at")
      .in("id", requesterIds)
      .returns<AccessRequestProfileRow[]>(),
  ]);

  const projectById = new Map((projectRows ?? []).map((p) => [p.id, p]));
  const profileById = new Map((profileRows ?? []).map((p) => [p.id, p]));

  return rows.map((row) => {
    const project = projectById.get(row.project_id);
    const profile = profileById.get(row.requester_profile_id);
    return {
      id: row.id,
      projectId: row.project_id,
      projectSlug: project?.slug ?? "",
      projectName: project?.name ?? "Unknown project",
      requesterProfileId: row.requester_profile_id,
      requesterName: profile ? [profile.first_name, profile.last_name].filter(Boolean).join(" ") || "Unnamed" : "Unknown",
      requesterAvatar: (profile ? resolveAvatarUrl(profile.avatar_url, profile.updated_at) : null) ?? FALLBACK_AVATAR,
      status: row.status,
      // created_at is a real timestamptz ("2026-08-26T20:34:19.66...+00:00"),
      // not the date-only "YYYY-MM-DD" formatAbsoluteDate expects — passing
      // it through unsliced produced "Invalid Date" (it appends its own
      // "T00:00:00" to whatever string it's given). Slicing to just the
      // date portion keeps this display date-only, matching requestedAt's
      // documented "Aug 3, 2026" shape, without changing formatAbsoluteDate
      // itself or any of its other (genuinely date-only) callers.
      requestedAt: formatAbsoluteDate(row.created_at.slice(0, 10)),
    };
  });
}

// This member's own requests, every status — lets the "Other Projects" card
// know whether to show "Request to be added"/"Pending access" per project
// (only ever one *pending* row per project/requester, see the migration's
// partial unique index) without a second query per card.
export async function loadMyProjectAccessRequests(profileId: string): Promise<ProjectAccessRequestsResult> {
  const supabase = getSupabaseBrowserClient();

  const { data, error } = await supabase
    .from("project_access_requests")
    .select("id, project_id, requester_profile_id, status, created_at")
    .eq("requester_profile_id", profileId)
    .returns<AccessRequestRow[]>();

  if (error) {
    logDev("my project access requests query failed", error);
    return { status: "error", message: error.message };
  }

  return { status: "ready", requests: await hydrateAccessRequests(supabase, data ?? []) };
}

// Pending requests for whatever projects the caller actually leads —
// project_access_requests_select RLS already scopes this to exactly that
// (or an Admin), so no separate "which projects do I lead" filter is
// needed client-side; a Member calling this simply gets an empty list.
export async function loadPendingAccessRequestsForLead(): Promise<ProjectAccessRequestsResult> {
  const supabase = getSupabaseBrowserClient();

  const { data, error } = await supabase
    .from("project_access_requests")
    .select("id, project_id, requester_profile_id, status, created_at")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .returns<AccessRequestRow[]>();

  if (error) {
    logDev("pending access requests query failed", error);
    return { status: "error", message: error.message };
  }

  return { status: "ready", requests: await hydrateAccessRequests(supabase, data ?? []) };
}

export type ProjectAccessRequestWriteResult = { status: "success" } | { status: "error"; message: string };

// "Request to be added to the team" — direct client insert, gated by
// project_access_requests_insert RLS (requester_profile_id = auth.uid(),
// not already a member, project must be active/in-org). The partial
// unique index on (project_id, requester_profile_id) where pending is
// what actually prevents a duplicate active request; 23505 here means one
// already exists, not a real failure.
export async function requestProjectAccess(
  organizationId: string,
  projectId: string,
  projectName: string,
  requesterProfileId: string
): Promise<ProjectAccessRequestWriteResult> {
  const supabase = getSupabaseBrowserClient();

  const { error } = await supabase
    .from("project_access_requests")
    .insert({ project_id: projectId, requester_profile_id: requesterProfileId });

  if (error) {
    logDev("project access request insert failed", error);
    if (error.code === "23505") return { status: "success" };
    return { status: "error", message: error.message };
  }

  // Notify every real Lead of this project (there's normally exactly one —
  // the partial unique index on project_role = 'lead' — but this holds
  // even if that's ever momentarily untrue). Done via a Server Action
  // (notifyProjectAccessRequestAction) rather than a direct client query
  // for the Leads, because project_memberships_select RLS (can_view_project)
  // hides this project's memberships from the requester — they're, by
  // definition, not yet a member of it. A direct client-side query here
  // silently returned zero rows under RLS (no error), which was a real
  // production bug: the request itself was created, but its Lead was never
  // notified in-app or by email. Fire-and-forget: never delays or can fail
  // the already-successful request above.
  void (async () => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      logDev("project access request notification skipped: no session");
      return;
    }
    const result = await notifyProjectAccessRequestAction({
      accessToken: session.access_token,
      organizationId,
      projectId,
      projectName,
    });
    if (result.status === "error") logDev("project access request notification failed", result.message);
  })().catch((err) => {
    logDev("project access request notification failed", err);
  });

  return { status: "success" };
}

// "Cancel request" — the requester withdrawing their own still-pending
// request. project_access_requests_update RLS only allows this exact
// transition (pending -> cancelled) by the request's own requester; no
// notification is sent (nothing to tell the Lead that changes what they'd do).
export async function cancelProjectAccessRequest(requestId: string): Promise<ProjectAccessRequestWriteResult> {
  const supabase = getSupabaseBrowserClient();

  const { error } = await supabase
    .from("project_access_requests")
    .update({ status: "cancelled" })
    .eq("id", requestId);

  if (error) {
    logDev("project access request cancel failed", error);
    return { status: "error", message: error.message };
  }
  return { status: "success" };
}

// "Accept" — adds the requester to the team via the exact same
// addProjectMember every other real "add to project" flow already uses
// (so it fires the exact same project_member_added notification too, one
// of this feature's own required notifications, for free), then marks the
// request approved. If the membership add fails, the request is left
// pending rather than silently marked approved with no real membership —
// project_access_requests_update RLS only allows this project's real Lead/
// an Admin to make this transition at all, re-enforcing "only the right
// Lead, only once" at the database level regardless of this ordering.
export async function approveProjectAccessRequest(
  organizationId: string,
  request: ProjectAccessRequest
): Promise<ProjectAccessRequestWriteResult> {
  const addResult = await addProjectMember(organizationId, request.projectSlug, request.requesterProfileId);
  if (addResult.status === "error") return addResult;

  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase
    .from("project_access_requests")
    .update({ status: "approved" })
    .eq("id", request.id);

  if (error) {
    logDev("project access request approve failed", error);
    return { status: "error", message: error.message };
  }
  return { status: "success" };
}

// "Reject" — no membership is ever created; the project stays in the
// requester's own "Other Projects" and a fresh request is allowed
// afterwards (the partial unique index only blocks a second *pending* row).
export async function rejectProjectAccessRequest(
  organizationId: string,
  request: ProjectAccessRequest
): Promise<ProjectAccessRequestWriteResult> {
  const supabase = getSupabaseBrowserClient();

  const { error } = await supabase
    .from("project_access_requests")
    .update({ status: "rejected" })
    .eq("id", request.id);

  if (error) {
    logDev("project access request reject failed", error);
    return { status: "error", message: error.message };
  }

  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  void createNotification({
    organizationId,
    recipientProfileId: request.requesterProfileId,
    actorProfileId: authUser?.id ?? null,
    type: "project_access_rejected",
    title: `Your request to join ${request.projectName} was rejected`,
    projectId: request.projectId,
  }).catch((err) => {
    logDev("project access reject notification failed", err);
  });

  return { status: "success" };
}

// Wired from member-profile-modal.tsx's MemberMenu "Make Project Lead"
// (Team's real member cards only, same as addProjectMember/removeProjectMember
// above). The DB only allows one project_role = 'lead' row per project (the
// partial unique index from 20260812000000_add_project_membership_project_role.sql),
// so the previous lead — if any — has to be cleared back to 'member' first;
// the second update is what actually promotes the new one. Only ever
// touches this project's own project_memberships rows: no organization
// role, no other project, no ticket/hours/KPI data. RLS
// (project_memberships_update: is_org_admin_or_lead) is the same
// unmodified floor every other project_memberships write already uses in
// this app — "only Admin" for this specific action is enforced by the UI
// only offering it to an Admin viewer (MemberMenu), same client-side-gate
// pattern as every other role-gated action in this app (e.g. canManage for
// Quick Actions), not a new RLS policy.
export async function setProjectLead(
  organizationId: string,
  slug: string,
  profileId: string
): Promise<ProjectMemberWriteResult> {
  const supabase = getSupabaseBrowserClient();

  const { data: projectRow, error: projectError } = await supabase
    .from("projects")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("slug", slug)
    .maybeSingle<{ id: string }>();

  if (projectError) {
    logDev("project id lookup failed", projectError);
    return { status: "error", message: projectError.message };
  }
  if (!projectRow) return { status: "error", message: "Project not found." };

  const { error: clearError } = await supabase
    .from("project_memberships")
    .update({ project_role: "member" })
    .eq("project_id", projectRow.id)
    .eq("project_role", "lead");

  if (clearError) {
    logDev("clearing previous project lead failed", clearError);
    return { status: "error", message: clearError.message };
  }

  const { error: setError } = await supabase
    .from("project_memberships")
    .update({ project_role: "lead" })
    .eq("project_id", projectRow.id)
    .eq("profile_id", profileId);

  if (setError) {
    logDev("setting project lead failed", setError);
    return { status: "error", message: setError.message };
  }

  return { status: "success" };
}

// Wired from member-profile-modal.tsx's MemberMenu (Team's real member
// cards only). Deletes only the one project_memberships row for this exact
// project + profile — never the profile, the auth user, the organization
// membership, or any ticket/comment/attachment/time-entry history, none of
// which reference project_memberships at all. The real guarantee against
// removing the project's only active Project Lead, or a member who still
// has a non-Done ticket assigned in this project, isn't this function or
// any client-side pre-check — it's the
// project_memberships_prevent_unsafe_delete trigger (20260910000000),
// which blocks the delete at the database level no matter how it's
// invoked; a rejected delete here just surfaces that trigger's own
// exception message as-is, which MemberMenu shows the caller directly.
export async function removeProjectMember(
  organizationId: string,
  slug: string,
  profileId: string
): Promise<ProjectMemberWriteResult> {
  const supabase = getSupabaseBrowserClient();

  const { data: projectRow, error: projectError } = await supabase
    .from("projects")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("slug", slug)
    .maybeSingle<{ id: string }>();

  if (projectError) {
    logDev("project id lookup failed", projectError);
    return { status: "error", message: projectError.message };
  }
  if (!projectRow) return { status: "error", message: "Project not found." };

  const { error } = await supabase
    .from("project_memberships")
    .delete()
    .eq("project_id", projectRow.id)
    .eq("profile_id", profileId);

  if (error) {
    logDev("project_memberships delete failed", error);
    // Includes the project_memberships_prevent_unsafe_delete trigger's own
    // raised message when this removal is actually blocked (last active
    // Project Lead, or a non-Done ticket still assigned) — surfaced as-is
    // rather than a generic string, since it's already a clear,
    // non-technical sentence.
    return { status: "error", message: error.message };
  }

  return { status: "success" };
}


// ── Member Dashboard reads ──────────────────────────────────────────────────
// (src/components/member-dashboard.tsx).

export type MemberWeeklyCapacityResult =
  | { status: "ready"; weeklyCapacity: number }
  | { status: "error"; message: string };

// A member's real weekly capacity — belongs to the member, never a project,
// so this is (and only ever should be) organization_memberships.weekly_capacity,
// the single org-wide source of truth (never project_memberships.weekly_capacity,
// and never summed/multiplied across however many projects they're staffed
// on). organizationWeeklyCapacity is passed in (already loaded by
// useCurrentUser, itself organization_memberships.weekly_capacity) rather
// than re-querying it here — this function stays `async`/its own query-free
// "ready" result only for call-site compatibility (every caller already
// awaits a MemberWeeklyCapacityResult).
export async function loadMemberWeeklyCapacity(
  _profileId: string,
  organizationWeeklyCapacity: number
): Promise<MemberWeeklyCapacityResult> {
  return { status: "ready", weeklyCapacity: organizationWeeklyCapacity };
}

export interface MemberWeeklyCapacityEntry {
  profileId: string;
  weeklyCapacity: number;
}

export type OrganizationMemberWeeklyCapacitiesResult =
  | { status: "ready"; capacities: MemberWeeklyCapacityEntry[] }
  | { status: "error"; message: string };

// A member's real weekly capacity belongs to the member, never a project —
// organization_memberships.weekly_capacity is the single org-wide source of
// truth (never project_memberships.weekly_capacity, and never summed across
// however many projects a member is staffed on), batched for every active
// org member at once — backs Admin Reports' "Hours by Person" Capacity
// column and every other org-wide capacity/utilization consumer.
export async function loadOrganizationMemberWeeklyCapacities(
  organizationId: string
): Promise<OrganizationMemberWeeklyCapacitiesResult> {
  const supabase = getSupabaseBrowserClient();

  const { data: orgRows, error: orgError } = await supabase
    .from("organization_memberships")
    .select("profile_id, weekly_capacity")
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .returns<{ profile_id: string; weekly_capacity: number | null }[]>();

  if (orgError) {
    logDev("organization member weekly capacities query failed", orgError);
    return { status: "error", message: orgError.message };
  }

  const capacities = (orgRows ?? []).map((row) => ({
    profileId: row.profile_id,
    weeklyCapacity: row.weekly_capacity ?? 0,
  }));

  return { status: "ready", capacities };
}

// ── Project Favorites (Sidebar) ─────────────────────────────────────────────
// Per-user, per-organization quick-access list — see
// 20260930020000_add_project_favorites.sql for the table/RLS. Keyed by
// `slug` (this app's stable, immutable-after-creation project identifier),
// never by another user's data — RLS already enforces `profile_id =
// auth.uid()` on every operation, these functions just pass the caller's
// own real profile id through.

export type FavoriteProjectSlugsResult =
  | { status: "ready"; slugs: string[] }
  | { status: "error"; message: string };

export async function loadFavoriteProjectSlugs(
  organizationId: string,
  profileId: string
): Promise<FavoriteProjectSlugsResult> {
  const supabase = getSupabaseBrowserClient();

  const { data: rows, error } = await supabase
    .from("project_favorites")
    .select("project_slug")
    .eq("organization_id", organizationId)
    .eq("profile_id", profileId)
    .returns<{ project_slug: string }[]>();

  if (error) {
    logDev("project favorites query failed", error);
    return { status: "error", message: error.message };
  }

  return { status: "ready", slugs: (rows ?? []).map((row) => row.project_slug) };
}

export type ProjectFavoriteWriteResult = { status: "success" } | { status: "error"; message: string };

// Plain insert, not .upsert() — PostgREST compiles .upsert() into
// `INSERT ... ON CONFLICT DO UPDATE`, which Postgres requires real UPDATE
// privilege for (checked at statement-analysis time, regardless of whether
// a conflict actually occurs) even though this table deliberately never
// grants UPDATE (project_favorites is add/remove-only, see the migration's
// own comment) — that mismatch was the real cause of every "Couldn't add
// favorite" (42501 permission denied for table project_favorites, hint:
// GRANT UPDATE...). Idempotency instead comes from treating the PK's own
// unique_violation (23505) — "this exact favorite already exists" — as a
// silent success below, never a second/duplicate row and never a UI error
// just because a fast double-click (or Favorites and Projects both firing
// the same toggle) raced to insert it twice.
const POSTGRES_UNIQUE_VIOLATION = "23505";

export async function addProjectFavorite(
  organizationId: string,
  profileId: string,
  slug: string
): Promise<ProjectFavoriteWriteResult> {
  const supabase = getSupabaseBrowserClient();

  const { error } = await supabase
    .from("project_favorites")
    .insert({ organization_id: organizationId, profile_id: profileId, project_slug: slug });

  if (error && error.code !== POSTGRES_UNIQUE_VIOLATION) {
    logDev("add project favorite failed", error);
    return { status: "error", message: error.message };
  }
  return { status: "success" };
}

export async function removeProjectFavorite(
  organizationId: string,
  profileId: string,
  slug: string
): Promise<ProjectFavoriteWriteResult> {
  const supabase = getSupabaseBrowserClient();

  const { error } = await supabase
    .from("project_favorites")
    .delete()
    .eq("organization_id", organizationId)
    .eq("profile_id", profileId)
    .eq("project_slug", slug);

  if (error) {
    logDev("remove project favorite failed", error);
    return { status: "error", message: error.message };
  }
  return { status: "success" };
}
