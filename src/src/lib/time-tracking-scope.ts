// Project Lead Time Tracking — the one place that separates the two scopes
// that screen works with:
//
//   - LED projects (project_memberships.project_role = 'lead', via
//     loadLeadProjects): the Lead's elevated view — the whole team's
//     timesheets, missing hours, workload/capacity and (with financial
//     access) revenue.
//   - OWN-ONLY projects: every other project this profile can access as a
//     regular member (the RLS-scoped project list — projects_select →
//     can_view_project). Selectable, but only ever for the Lead's OWN
//     time — never anyone else's hours, workload or $.
//
// Being a Project Lead somewhere must not hide the projects a person works
// on as a member; appearing in the selector must not grant lead-level
// visibility. Every rule below is pure so both halves are testable.

export type TimeTrackingProjectAccess = "lead" | "own";

export interface TimeTrackingProjectOption {
  slug: string;
  name: string;
  access: TimeTrackingProjectAccess;
}

// `ledProjects` is loadLeadProjects' own result with `includeNonActive` —
// every non-archived project where this profile's real
// project_memberships.project_role is 'lead', whatever its status
// (planning/on-hold included). Lead scope comes from that role alone, never
// from mere access. `accessibleProjects` is the profile's RLS-scoped project list; anything
// archived is dropped — same `status !== "archived"` rule the Sidebar uses
// — so an archived project never becomes an operational choice merely
// because the membership row still exists. A project with no logged time
// is still offered: options never depend on time entries.
export function buildLeadTimeTrackingProjectOptions(
  ledProjects: { slug: string; name: string }[],
  accessibleProjects: { slug: string; name: string; status: string }[]
): TimeTrackingProjectOption[] {
  const ledSlugs = new Set(ledProjects.map((p) => p.slug));
  const led = ledProjects.map((p): TimeTrackingProjectOption => ({ slug: p.slug, name: p.name, access: "lead" }));
  const ownOnly = accessibleProjects
    .filter((p) => p.status !== "archived" && !ledSlugs.has(p.slug))
    .map((p): TimeTrackingProjectOption => ({ slug: p.slug, name: p.name, access: "own" }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...led, ...ownOnly];
}

export function slugsWithAccess(options: TimeTrackingProjectOption[], access: TimeTrackingProjectAccess): string[] {
  return options.filter((o) => o.access === access).map((o) => o.slug);
}

// Whether the current Project filter includes any led project — i.e.
// whether the team-level view applies at all. No filter = everything, which
// includes the led projects whenever there are any.
export function selectionIncludesLedProject(projectFilter: string[], ledSlugs: string[]): boolean {
  if (projectFilter.length === 0) return ledSlugs.length > 0;
  const led = new Set(ledSlugs);
  return projectFilter.some((slug) => led.has(slug));
}

// The Timesheets roster for the current Project filter: the led team while
// a led project is in scope; otherwise (only own-only projects selected)
// just the Lead's own row — never the led team padded with zero-hour rows,
// and never the own-only project's real team.
export function visibleTimesheetMembers<T extends { id: string }>(
  ledTeam: T[],
  self: T | null,
  projectFilter: string[],
  ledSlugs: string[]
): T[] {
  if (selectionIncludesLedProject(projectFilter, ledSlugs)) return ledTeam;
  return self ? [self] : [];
}

// Defense in depth for own-only projects: the query already filters
// `logged_by = profileId` (loadProfileTimeEntriesForRange), and this drops
// anything else before it can reach an aggregate.
export function keepOwnEntries<T extends { loggedBy: string | null }>(entries: T[], profileId: string): T[] {
  return entries.filter((e) => e.loggedBy === profileId);
}

// Whether a ticket's assigned-hours estimate may count toward a person's
// workload/capacity on this screen: always on a led project; on an
// own-only project only for the Lead's own assignments.
export function countsTowardWorkload(
  ticket: { projectSlug: string; assigneeProfileId?: string | null },
  ledSlugs: Set<string>,
  profileId: string
): boolean {
  return ledSlugs.has(ticket.projectSlug) || ticket.assigneeProfileId === profileId;
}

// Which projects a Work History opened from Time Tracking may read: the
// viewer's own history spans every project they can work on (led +
// own-only); anyone else's stays inside the projects the viewer leads.
export function workHistoryScopeSlugs(
  options: TimeTrackingProjectOption[],
  targetProfileId: string,
  viewerProfileId: string
): string[] {
  return targetProfileId === viewerProfileId ? options.map((o) => o.slug) : slugsWithAccess(options, "lead");
}

// The signed-in Lead's own "View →" target when the Project filter includes
// a member-only project: that one project's own Work History page, or —
// for several selected projects — the global Work History pre-filtered to
// exactly that selection (`?projects=`, its existing multi-select Project
// filter). null = no member-only project selected, so the existing
// led-project resolution applies unchanged. Only ever called for the
// viewer's own row; the profile id in the URL is always their own.
export function ownWorkHistoryHref(profileId: string, projectFilter: string[], ledSlugs: string[]): string | null {
  const led = new Set(ledSlugs);
  if (!projectFilter.some((slug) => !led.has(slug))) return null;
  if (projectFilter.length === 1) return `/projects/${projectFilter[0]}/team/${profileId}/work-history`;
  return `/time-tracking/team/${profileId}/work-history?projects=${projectFilter.map(encodeURIComponent).join(",")}`;
}

// Whether a ticket may appear in a per-person breakdown (Reports → Tickets
// by Member): any ticket of a led project; on an own-only project only the
// viewer's own work — assigned to them, or carrying their own logged time
// (`ownLoggedTicketIds`) — never a colleague's assignments.
export function inPersonBreakdown(
  ticket: { id: string; projectSlug: string; assigneeProfileId?: string | null },
  ledSlugs: Set<string>,
  profileId: string,
  ownLoggedTicketIds: Set<string>
): boolean {
  return countsTowardWorkload(ticket, ledSlugs, profileId) || ownLoggedTicketIds.has(ticket.id);
}
