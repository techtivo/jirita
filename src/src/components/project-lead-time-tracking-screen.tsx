"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FilterDropdown } from "@/components/tickets/filter-dropdown";
import type { DropdownGroup } from "@/components/tickets/filter-dropdown";
import { KpiCard, Section } from "@/components/reports-shared";
import { SkeletonBlock } from "@/components/dashboard-shared";
import { Avatar } from "@/components/ui/avatar";
import {
  PeriodSelector,
  StatusPill,
  CapacityCell,
  formatHours,
  formatCurrency,
  periodSubLabel,
  getCurrentWeekRange,
  getCurrentMonthRange,
  expectedHoursForPeriod,
  scopeEntries,
  hoursByMember,
  parseListParam,
  round1,
} from "@/components/time-tracking-screen";
import { buildFinanceKpiSummary } from "@/components/reports-screen";
import { periodDisplayLabel } from "@/lib/mock-time-tracking";
import type { CustomRange, TimePeriod, TimesheetStatus } from "@/lib/mock-time-tracking";
import type { ProjectSummary } from "@/lib/mock-projects";
import type { Ticket } from "@/lib/mock-tickets";
import { getTodayISO } from "@/components/tickets/ticket-ui";
import { MemberTrigger } from "@/components/member-profile";
import { useCurrentUser } from "@/components/current-user-provider";
import { hasFinancialAccess, ROLE_LABELS } from "@/lib/current-user";
import { loadLeadProjects, loadOrganizationProjects, loadProjectTeam } from "@/lib/projects";
import type { LeadProject, ProjectTeamMember } from "@/lib/projects";
import { loadProjectTickets, isTicketClosed } from "@/lib/tickets";
import type { OrganizationTimeEntry } from "@/lib/tickets";
import { loadScopedTimeEntries } from "@/lib/scoped-time-entries";
import {
  buildLeadTimeTrackingProjectOptions,
  slugsWithAccess,
  visibleTimesheetMembers,
  countsTowardWorkload,
  ownWorkHistoryHref,
} from "@/lib/time-tracking-scope";
import type { TimeTrackingProjectOption } from "@/lib/time-tracking-scope";

// Project Leads manage delivery and team capacity, not company finances — no
// invoicing, hourly rates, or billing-by-client here. Every widget on this
// page answers a delivery question (who's overloaded, who's missing hours,
// which projects are consuming the most effort), never a financial one. See
// time-tracking-screen.tsx for the Admin/finance version this page is
// deliberately not a filtered copy of.
//
// Real data source: the team-level view is scoped to exactly the projects
// this profile *leads* (project_memberships.project_role = 'lead', via
// loadLeadProjects — the same authoritative definition
// project-lead-dashboard.tsx's own project scope selector already uses).
// Every other active project this profile can access as a regular member
// is also selectable, but contributes only this profile's OWN time — never
// that project's team, workload or revenue (see lib/time-tracking-scope.ts).
// Tickets/team come from loadProjectTickets/loadProjectTeam
// per led project (the same per-project loaders the Dashboard already uses),
// merged client-side; time entries reuse loadOrganizationLoggedTimeForRange
// verbatim, just fed a ticket-id set already narrowed to led projects only.
// Every KPI/section computation below (scopeEntries, hoursByMember,
// expectedHoursForPeriod, the per-row view-model shape, missing-hours/
// weekly-utilization math, and Logged/Internal Hours via
// buildFinanceKpiSummary) is imported and reused verbatim from the real,
// connected Admin/Member Time Tracking screen — never re-implemented here.

// Synthetic Client-filter value for "projects with no real client" — never
// written to Supabase, never a fabricated client. Matched against each
// project's own real `client` field (null/absent), not `category`, so a
// mis-tagged project (e.g. category "internal" but a real client set) is
// never miscounted either way.
const NO_CLIENT_FILTER_VALUE = "__no-client__";

interface LedTeamMember {
  id: string;
  name: string;
  avatar: string;
  role: string;
  weeklyCapacity: number;
  projectSlugs: string[];
}

// Merges a member's roster entries across every led project they're staffed
// on. `weeklyCapacity` is a person's real total availability, not a
// per-project allocation — loadProjectTeam (lib/projects.ts) now resolves it
// purely from organization_memberships.weekly_capacity, the single org-wide
// source of truth, so every one of a member's own per-project rows already
// carries the exact same real number; `Math.max` across those rows reduces
// them to that one canonical value — never summed across the projects
// they're staffed on. `projectSlugs` still concatenates every led project
// they're on (used for scoping, not capacity).
function mergeLedTeams(perProject: { slug: string; members: ProjectTeamMember[] }[]): LedTeamMember[] {
  const merged = new Map<string, LedTeamMember>();
  for (const { slug, members } of perProject) {
    for (const m of members) {
      const existing = merged.get(m.id);
      if (existing) {
        existing.weeklyCapacity = Math.max(existing.weeklyCapacity, m.weeklyCapacity);
        existing.projectSlugs.push(slug);
      } else {
        merged.set(m.id, {
          id: m.id,
          name: m.name,
          avatar: m.avatar,
          role: m.title,
          weeklyCapacity: m.weeklyCapacity,
          projectSlugs: [slug],
        });
      }
    }
  }
  return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// Real page-header date — "Weekday, Month Day, Year", same real
// getTodayISO()-based convention (and toLocaleDateString pattern) Project
// Lead Reports' own header already uses, duplicated here as page-local glue
// rather than importing a non-exported helper from that file. Always
// today's real date — never the selected Period/Custom Range.
function formatHeaderDate(todayISO: string): string {
  return new Date(`${todayISO}T00:00:00`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

// Resolves the single real project a Timesheets row's "View →" (Work
// History) action should scope to — never a name/position guess. Priority:
// (1) the active Project filter's real slug, whenever it narrows to exactly
// one selected project; (2) this member's own single led project when the
// filter doesn't apply; (3) the Project Lead's own single led project
// overall, as a last real-data fallback. `undefined` means genuinely
// ambiguous (member staffed on >1 led project, no filter narrowing it to
// one) — the row's own action then falls back to the real, existing global
// "/time-tracking/team/{profileId}/work-history" route (every real project
// this Lead leads) instead of guessing a single one.
function resolveWorkHistoryProjectSlug(
  memberProjectSlugs: string[],
  projectFilter: string[],
  leadProjects: LeadProject[]
): string | undefined {
  if (projectFilter.length === 1) return projectFilter[0];
  if (memberProjectSlugs.length === 1) return memberProjectSlugs[0];
  if (leadProjects.length === 1) return leadProjects[0].slug;
  return undefined;
}

interface LedTimesheetViewRow {
  id: string;
  name: string;
  avatar: string;
  role: string;
  projectSlug?: string;
  /** Real, unambiguous single-project scope for this row's own "View →"
   *  (Work History) action — see resolveWorkHistoryProjectSlug above.
   *  `undefined` routes the action to the global, multi-project Work
   *  History instead (never disabled). Kept separate from `projectSlug`
   *  (the Member column's own Member Profile Modal scope) so that
   *  trigger's existing behavior is untouched. */
  workHistoryProjectSlug?: string;
  /** Set only on the signed-in Lead's own row while a member-only project
   *  is in the Project filter — their own Work History for that selection
   *  (see ownWorkHistoryHref); takes precedence over the led-project
   *  resolution above. */
  ownWorkHistoryHref?: string;
  hoursToday: number;
  hoursWeek: number;
  hoursMonth: number;
  hoursSelected: number;
  capacityPct: number;
  status: TimesheetStatus;
}

interface ProjectHoursRow {
  projectSlug: string;
  projectName: string;
  hours: number;
}

// ── Loading skeleton ──────────────────────────────────────────────────────────
//
// Mirrors this screen's own real layout (header, period selector, filter
// bar, KPI strip, Timesheets table, Hours Missing/Hours by Project cards),
// built from the same shared `SkeletonBlock` primitive the Admin/Project
// Lead/Member Dashboards, Projects list, My Work, and Project Lead Reports
// already use for their own loading states — never a second skeleton
// pattern. Reuses the real `Section` container (with its own real title/
// icon, same markup as the real render below) for each section, same as
// Project Lead Reports' own loading state already does, so only the
// still-loading numbers/rows are placeholders. Shown both on first load and
// on every re-run of the data-loading effect below (e.g. returning to a
// backgrounded browser tab), so real content never has to share the screen
// with stale data mid-refresh.
function ProjectLeadTimeTrackingLoadingSkeleton() {
  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 pb-16">
      {/* Page header + period selector */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4 mb-4 sm:mb-5">
        <div>
          <SkeletonBlock className="h-[21px] w-40 mb-1.5" />
          <SkeletonBlock className="h-3 w-44" />
        </div>
        <SkeletonBlock className="h-8 w-full sm:w-64 rounded-lg flex-shrink-0" />
      </div>

      {/* Filters */}
      <div className="flex items-center gap-1.5 flex-wrap mb-6 rounded-xl border border-slate-200 dark:border-zinc-700/70 bg-white dark:bg-zinc-900 px-4 py-2.5 shadow-sm shadow-slate-200/40 dark:shadow-black/20">
        <SkeletonBlock className="h-[10px] w-10 mr-2" />
        <SkeletonBlock className="h-7 w-20" />
        <SkeletonBlock className="h-7 w-20" />
        <SkeletonBlock className="h-7 w-16" />
      </div>

      {/* Overview KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-8">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="rounded-xl border border-slate-200 dark:border-zinc-700/70 bg-white dark:bg-zinc-900 px-5 pt-4 pb-4 shadow-sm shadow-slate-200/40 dark:shadow-black/20"
          >
            <SkeletonBlock className="h-[10px] w-20 mb-2" />
            <SkeletonBlock className="h-6 w-14 mb-1.5" />
            <SkeletonBlock className="h-3 w-16" />
          </div>
        ))}
      </div>

      {/* Timesheets */}
      <Section
        title="Timesheets"
        icon={
          <svg className="w-3.5 h-3.5 text-slate-400 dark:text-zinc-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
        }
      >
        <div className="overflow-x-auto -mx-5 px-5">
          <table className="w-full text-sm min-w-[820px]">
            <tbody className="divide-y divide-slate-50 dark:divide-zinc-800/60">
              {Array.from({ length: 3 }).map((_, i) => (
                <tr key={i}>
                  <td className="py-2.5 pr-4">
                    <div className="flex items-center gap-2.5">
                      <SkeletonBlock className="h-7 w-7 rounded-full flex-shrink-0" />
                      <div className="min-w-0">
                        <SkeletonBlock className="h-4 w-28 mb-1" />
                        <SkeletonBlock className="h-3 w-16" />
                      </div>
                    </div>
                  </td>
                  <td className="py-2.5 text-right"><SkeletonBlock className="h-4 w-10 ml-auto" /></td>
                  <td className="py-2.5 text-right"><SkeletonBlock className="h-4 w-10 ml-auto" /></td>
                  <td className="py-2.5 text-right"><SkeletonBlock className="h-4 w-10 ml-auto" /></td>
                  <td className="py-2.5 pl-4 text-right"><SkeletonBlock className="h-4 w-12 ml-auto" /></td>
                  <td className="py-2.5 pl-4 text-right"><SkeletonBlock className="h-5 w-16 ml-auto rounded-full" /></td>
                  <td className="py-2.5 pl-4 text-right"><SkeletonBlock className="h-4 w-10 ml-auto" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* Action cards */}
      <div className="grid md:grid-cols-2 gap-5 mt-6">
        <Section
          title="Hours Missing"
          icon={
            <svg className="w-3.5 h-3.5 text-slate-400 dark:text-zinc-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
          }
        >
          <div>
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between gap-2 py-2 border-b border-slate-100 dark:border-zinc-800/70 last:border-0">
                <div className="flex items-center gap-2 min-w-0">
                  <SkeletonBlock className="h-6 w-6 rounded-full flex-shrink-0" />
                  <div className="min-w-0">
                    <SkeletonBlock className="h-3.5 w-24 mb-1" />
                    <SkeletonBlock className="h-3 w-16" />
                  </div>
                </div>
                <SkeletonBlock className="h-3 w-14 flex-shrink-0" />
              </div>
            ))}
          </div>
        </Section>

        <Section
          title="Hours by Project"
          icon={
            <svg className="w-3.5 h-3.5 text-slate-400 dark:text-zinc-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
            </svg>
          }
        >
          <div>
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between gap-2 py-2 border-b border-slate-100 dark:border-zinc-800/70 last:border-0">
                <SkeletonBlock className="h-3.5 w-32" />
                <div className="text-right flex-shrink-0">
                  <SkeletonBlock className="h-3.5 w-10 mb-1 ml-auto" />
                  <SkeletonBlock className="h-3 w-16 ml-auto" />
                </div>
              </div>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}

export function ProjectLeadTimeTrackingScreen() {
  const { user, organization, userId, isDevFallback } = useCurrentUser();
  const canViewFinancials = hasFinancialAccess(user.role, user.financialAccess);
  const router = useRouter();
  const searchParams = useSearchParams();

  // Same real, org-wide source of truth Admin/Member Time Tracking reads
  // (time-tracking-screen.tsx) — never a second/different definition of
  // "active days" for this role's own view. Memoized so its identity only
  // changes when `organization` itself does, not on every render.
  const activeDays = useMemo(() => organization?.activeDays ?? [], [organization]);

  const [period, setPeriod] = useState<TimePeriod>("week");
  const [customRange, setCustomRange] = useState<CustomRange>({ from: getTodayISO(-13), to: getTodayISO() });
  const [memberFilter, setMemberFilter] = useState<string[]>([]);
  const [projectFilter, setProjectFilter] = useState<string[]>(() => parseListParam(searchParams.get("projects")));
  const [clientFilter, setClientFilter] = useState<string[]>([]);

  // `?projects=` is the same real query-state convention the Admin/Member
  // Time Tracking screen already uses — kept in sync both ways so a link
  // like `/time-tracking?projects=jirita` lands with that project applied
  // and visible, and so switching the Project filter here updates the URL.
  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    if (projectFilter.length > 0) params.set("projects", projectFilter.join(","));
    else params.delete("projects");
    const qs = params.toString();
    if (qs === searchParams.toString()) return;
    router.replace(`/time-tracking${qs ? `?${qs}` : ""}`, { scroll: false });
  }, [projectFilter, router, searchParams]);

  // ── Real data load — whole-team data for exactly the projects this
  //    profile leads, plus this profile's OWN time on every other active
  //    project they can access as a regular member. ──
  const [leadProjects, setLeadProjects] = useState<LeadProject[]>([]);
  const [projectOptions, setProjectOptions] = useState<TimeTrackingProjectOption[]>([]);
  const [rawProjects, setRawProjects] = useState<ProjectSummary[]>([]);
  const [rawTeam, setRawTeam] = useState<LedTeamMember[]>([]);
  const [rawTickets, setRawTickets] = useState<Ticket[]>([]);
  const [entriesToday, setEntriesToday] = useState<OrganizationTimeEntry[]>([]);
  const [entriesWeek, setEntriesWeek] = useState<OrganizationTimeEntry[]>([]);
  const [entriesMonth, setEntriesMonth] = useState<OrganizationTimeEntry[]>([]);
  const [entriesCustom, setEntriesCustom] = useState<OrganizationTimeEntry[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(isDevFallback ? "ready" : "loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadRequestId, setLoadRequestId] = useState(0);

  const ledSlugs = useMemo(() => slugsWithAccess(projectOptions, "lead"), [projectOptions]);
  const ledSlugSet = useMemo(() => new Set(ledSlugs), [ledSlugs]);

  useEffect(() => {
    if (isDevFallback || !organization || !userId) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: same "clear before the async fetch below resolves" pattern used elsewhere in this app (e.g. project-lead-dashboard.tsx)
    setLoadState("loading");

    (async () => {
      const [leadResult, projectsResult] = await Promise.all([
        // Lead scope by real project_role on any non-archived project —
        // a led project in planning/on-hold keeps its full team view.
        loadLeadProjects(organization.id, userId, { includeNonActive: true }),
        loadOrganizationProjects(organization.id),
      ]);
      if (cancelled) return;
      if (leadResult.status === "error") {
        setLoadState("error");
        setLoadError(leadResult.message);
        return;
      }
      if (projectsResult.status === "error") {
        setLoadState("error");
        setLoadError(projectsResult.message);
        return;
      }

      // Led projects keep the full team view; every other non-archived
      // project in this profile's own RLS-scoped list is own-time only.
      const options = buildLeadTimeTrackingProjectOptions(leadResult.projects, projectsResult.projects);
      const ledSlugs = slugsWithAccess(options, "lead");
      const ownOnlySlugs = slugsWithAccess(options, "own");
      if (options.length === 0) {
        setLeadProjects([]);
        setProjectOptions([]);
        setRawProjects([]);
        setRawTeam([]);
        setRawTickets([]);
        setEntriesToday([]);
        setEntriesWeek([]);
        setEntriesMonth([]);
        setEntriesCustom([]);
        setLoadState("ready");
        return;
      }

      // The team roster is only ever loaded for led projects.
      const [ticketsPerProject, teamPerProject, ownOnlyTicketsPerProject] = await Promise.all([
        Promise.all(ledSlugs.map((slug) => loadProjectTickets(organization.id, slug))),
        Promise.all(ledSlugs.map((slug) => loadProjectTeam(organization.id, slug))),
        Promise.all(ownOnlySlugs.map((slug) => loadProjectTickets(organization.id, slug))),
      ]);
      if (cancelled) return;

      const failedTickets = [...ticketsPerProject, ...ownOnlyTicketsPerProject].find((r) => r.status === "error");
      if (failedTickets && failedTickets.status === "error") {
        setLoadState("error");
        setLoadError(failedTickets.message);
        return;
      }
      const failedTeam = teamPerProject.find((r) => r.status === "error");
      if (failedTeam && failedTeam.status === "error") {
        setLoadState("error");
        setLoadError(failedTeam.message);
        return;
      }

      const optionSlugSet = new Set(options.map((o) => o.slug));
      const scopedProjects = projectsResult.projects.filter((p) => optionSlugSet.has(p.slug));
      const ledTickets = ticketsPerProject.flatMap((r) => (r.status === "ready" ? r.tickets : []));
      const ownOnlyTickets = ownOnlyTicketsPerProject.flatMap((r) => (r.status === "ready" ? r.tickets : []));
      const tickets = [...ledTickets, ...ownOnlyTickets];
      const team = mergeLedTeams(
        ledSlugs.map((slug, i) => ({
          slug,
          members: teamPerProject[i].status === "ready" ? teamPerProject[i].members : [],
        }))
      );

      const ledTicketIds = ledTickets.map((t) => t.id);
      const ownOnlyTicketIds = ownOnlyTickets.map((t) => t.id);
      const todayISO = getTodayISO();
      const week = getCurrentWeekRange();
      const month = getCurrentMonthRange();

      const [todayResult, weekResult, monthResult] = await Promise.all([
        loadScopedTimeEntries(ledTicketIds, ownOnlyTicketIds, userId, todayISO, todayISO),
        loadScopedTimeEntries(ledTicketIds, ownOnlyTicketIds, userId, week.from, week.to),
        loadScopedTimeEntries(ledTicketIds, ownOnlyTicketIds, userId, month.from, month.to),
      ]);
      if (cancelled) return;

      if (todayResult.status === "error") {
        setLoadState("error");
        setLoadError(todayResult.message);
        return;
      }
      if (weekResult.status === "error") {
        setLoadState("error");
        setLoadError(weekResult.message);
        return;
      }
      if (monthResult.status === "error") {
        setLoadState("error");
        setLoadError(monthResult.message);
        return;
      }

      setLeadProjects(leadResult.projects);
      setProjectOptions(options);
      setRawProjects(scopedProjects);
      setRawTeam(team);
      setRawTickets(tickets);
      setEntriesToday(todayResult.entries);
      setEntriesWeek(weekResult.entries);
      setEntriesMonth(monthResult.entries);
      setLoadState("ready");
    })();

    return () => {
      cancelled = true;
    };
    // organization?.id (not the whole `organization` object) — depending on
    // the object re-triggers this effect (and its full-page loading flash)
    // on every window-focus regain, since current-user-provider.tsx hands
    // back a new `organization` reference on its own session revalidation
    // even when the org itself hasn't changed. Keying off the real identity
    // means this only re-runs on a genuine org change, the initial mount,
    // or an explicit user-triggered loadRequestId bump (Retry) — no
    // background auto-refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDevFallback, organization?.id, userId, loadRequestId]);

  // Custom Range has no fixed window, so it's fetched on its own — only once
  // the core load above is ready, and only while Custom Range is selected.
  useEffect(() => {
    if (isDevFallback || !organization || !userId) return;
    if (period !== "custom" || loadState !== "ready") return;
    let cancelled = false;
    const ledTicketIds = rawTickets.filter((t) => ledSlugSet.has(t.projectSlug)).map((t) => t.id);
    const ownOnlyTicketIds = rawTickets.filter((t) => !ledSlugSet.has(t.projectSlug)).map((t) => t.id);

    (async () => {
      const result = await loadScopedTimeEntries(ledTicketIds, ownOnlyTicketIds, userId, customRange.from, customRange.to);
      if (cancelled) return;
      if (result.status === "ready") setEntriesCustom(result.entries);
    })();

    return () => {
      cancelled = true;
    };
    // organization?.id, not the object — see the main effect's own comment
    // above for why.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDevFallback, organization?.id, userId, period, customRange, loadState, rawTickets, ledSlugSet]);

  // This Lead's own Timesheets row — their real roster entry on a led
  // project when there is one, otherwise built from their own session
  // (a Project Lead who currently leads nothing still has own time).
  const selfMember = useMemo<LedTeamMember | null>(() => {
    if (!userId) return null;
    return (
      rawTeam.find((m) => m.id === userId) ?? {
        id: userId,
        name: user.name,
        avatar: user.avatar,
        role: ROLE_LABELS[user.role],
        weeklyCapacity: user.weeklyCapacity,
        projectSlugs: [],
      }
    );
  }, [rawTeam, userId, user.name, user.avatar, user.role, user.weeklyCapacity]);

  // The led team while a led project is in scope; only this Lead's own row
  // once the Project filter narrows to member-only projects.
  const visibleMembers = useMemo(() => {
    const roster = visibleTimesheetMembers(rawTeam, selfMember, projectFilter, ledSlugs);
    if (memberFilter.length === 0) return roster;
    const selected = new Set(memberFilter);
    return roster.filter((m) => selected.has(m.id));
  }, [rawTeam, selfMember, projectFilter, ledSlugs, memberFilter]);

  const capacityByMember = useMemo(() => {
    const capacities = new Map(rawTeam.map((m) => [m.id, m.weeklyCapacity]));
    if (selfMember && !capacities.has(selfMember.id)) capacities.set(selfMember.id, selfMember.weeklyCapacity);
    return capacities;
  }, [rawTeam, selfMember]);

  // Project/Client scoping — narrows the ticket set every time-entry
  // aggregate below reads from, same "Project/Client narrow the ticket-id
  // set, Member narrows scopeEntries on top of that" mechanism the real
  // Admin/Member screen already uses (capacityTicketIds there); collapsed to
  // one set here since there's no separate Billing filter on this page.
  const projectBySlug = useMemo(() => new Map(rawProjects.map((p) => [p.slug, p])), [rawProjects]);

  const scopedTicketIds = useMemo(() => {
    const ids = new Set<string>();
    for (const t of rawTickets) {
      if (projectFilter.length > 0 && !projectFilter.includes(t.projectSlug)) continue;
      const project = projectBySlug.get(t.projectSlug);
      if (clientFilter.length > 0) {
        const client = project?.client as string | undefined;
        if (clientFilter[0] === NO_CLIENT_FILTER_VALUE) {
          if (client) continue;
        } else if (project?.category !== "client" || client !== clientFilter[0]) {
          continue;
        }
      }
      ids.add(t.id);
    }
    return ids;
  }, [rawTickets, projectBySlug, projectFilter, clientFilter]);

  // Real assigned workload per member — the same official "over capacity"
  // numerator Team/Reports/Dashboards/Projects/Member Profile Modal already
  // share (active, non-`done` tickets' own real `hours` estimate, summed by
  // `assigneeProfileId`), reused verbatim here off the exact same `rawTickets`
  // already loaded — never a second query, never timesheet-logged hours.
  // Scoped by the same Project/Client `scopedTicketIds` every other widget
  // on this page already narrows by, so selecting a Project limits this to
  // that project's own assigned work while each member's own canonical
  // weekly capacity (see `capacityByMember` below) stays unchanged.
  const assignedHoursByMember = useMemo(() => {
    const assigned = new Map<string, number>();
    for (const t of rawTickets) {
      if (isTicketClosed(t) || !t.assigneeProfileId) continue;
      if (!scopedTicketIds.has(t.id)) continue;
      // Workload on a member-only project is only ever this Lead's own.
      if (!userId || !countsTowardWorkload(t, ledSlugSet, userId)) continue;
      assigned.set(t.assigneeProfileId, (assigned.get(t.assigneeProfileId) ?? 0) + (t.hours ?? 0));
    }
    return assigned;
  }, [rawTickets, scopedTicketIds, ledSlugSet, userId]);

  const scopedToday = useMemo(() => scopeEntries(entriesToday, scopedTicketIds, memberFilter), [entriesToday, scopedTicketIds, memberFilter]);
  const scopedWeek = useMemo(() => scopeEntries(entriesWeek, scopedTicketIds, memberFilter), [entriesWeek, scopedTicketIds, memberFilter]);
  const scopedMonth = useMemo(() => scopeEntries(entriesMonth, scopedTicketIds, memberFilter), [entriesMonth, scopedTicketIds, memberFilter]);
  const scopedCustom = useMemo(() => scopeEntries(entriesCustom, scopedTicketIds, memberFilter), [entriesCustom, scopedTicketIds, memberFilter]);

  const todayHours = useMemo(() => hoursByMember(scopedToday), [scopedToday]);
  const weekHours = useMemo(() => hoursByMember(scopedWeek), [scopedWeek]);
  const monthHours = useMemo(() => hoursByMember(scopedMonth), [scopedMonth]);
  const customHours = useMemo(() => hoursByMember(scopedCustom), [scopedCustom]);

  const entriesForSelectedPeriod = useMemo(() => {
    const raw =
      period === "today" ? entriesToday :
      period === "month" ? entriesMonth :
      period === "custom" ? entriesCustom :
      entriesWeek;
    return scopeEntries(raw, scopedTicketIds, memberFilter);
  }, [period, entriesToday, entriesWeek, entriesMonth, entriesCustom, scopedTicketIds, memberFilter]);

  // Reused verbatim from Reports → Finance (via the real Admin Time Tracking
  // screen's own import of it) — project category is the only billability
  // signal, never re-derived here. Only its `nonBillableHours` half feeds
  // "Internal Hours" below; "Logged Hours" is its own real total (see
  // `totalLoggedHours` below), never this function's `billableHours`, since
  // that half silently excludes internal-category projects (e.g. JIRITA
  // Live) — this function's own billable/non-billable split stays exactly
  // as Admin Reports/Time Tracking already rely on it, untouched.
  const financeSummary = useMemo(
    () => buildFinanceKpiSummary(rawTickets, rawProjects, entriesForSelectedPeriod),
    [rawTickets, rawProjects, entriesForSelectedPeriod]
  );

  // "Logged Hours" — the real total hours logged this period across every
  // project in scope (client + internal alike), summed directly off the
  // exact same `entriesForSelectedPeriod` collection "Hours by Project"
  // below already reads from — never buildFinanceKpiSummary's billable-only
  // half, and never a second/duplicate query.
  // "Estimated Revenue" stays a led-project figure: a member-only project's
  // billing rate is never applied here, whatever the Project filter says.
  const ledEstimatedRevenue = useMemo(
    () =>
      buildFinanceKpiSummary(
        rawTickets,
        rawProjects.filter((p) => ledSlugSet.has(p.slug)),
        entriesForSelectedPeriod
      ).estimatedRevenue,
    [rawTickets, rawProjects, ledSlugSet, entriesForSelectedPeriod]
  );

  const totalLoggedHours = useMemo(
    () => round1(entriesForSelectedPeriod.reduce((sum, e) => sum + e.minutes, 0) / 60),
    [entriesForSelectedPeriod]
  );

  const viewRows = useMemo<LedTimesheetViewRow[]>(() => {
    // Only real options — a stale/hand-typed `?projects=` slug never
    // becomes a link target.
    const selectable = new Set(projectOptions.map((o) => o.slug));
    const selectableFilter = projectFilter.filter((slug) => selectable.has(slug));
    return visibleMembers.map((m): LedTimesheetViewRow => {
      const hoursToday = todayHours.get(m.id) ?? 0;
      const hoursWeek = weekHours.get(m.id) ?? 0;
      const hoursMonth = monthHours.get(m.id) ?? 0;
      const hoursSelected =
        period === "today" ? hoursToday :
        period === "month" ? hoursMonth :
        period === "custom" ? (customHours.get(m.id) ?? 0) :
        hoursWeek;

      const weeklyCapacity = capacityByMember.get(m.id) ?? 0;
      // "Capacity" — workload risk, not timesheet compliance: same official
      // assigned-hours-over-capacity definition as Team/Reports/Dashboards/
      // Projects/Member Profile Modal (assignedHoursByMember above), never
      // hours actually logged — this feeds both this row's own Capacity
      // column and "Capacity Risk" below (overCapacityCount), so neither can
      // disagree with the Member Profile Modal opened from this same row.
      const assignedHours = assignedHoursByMember.get(m.id) ?? 0;
      const capacityPct = weeklyCapacity > 0 ? Math.round((assignedHours / weeklyCapacity) * 100) : 0;
      const expected = expectedHoursForPeriod(weeklyCapacity, period, customRange, activeDays);
      const status: TimesheetStatus = hoursSelected + 0.01 < expected ? "Missing" : "Complete";

      return {
        id: m.id,
        name: m.name,
        avatar: m.avatar,
        role: m.role,
        // Same "exactly one led project → its slug, otherwise no scope"
        // convention project-lead-reports-screen.tsx's own Member Profile
        // Modal triggers already use, rather than arbitrarily picking the
        // first of this member's own real projectSlugs.
        projectSlug: m.projectSlugs.length === 1 ? m.projectSlugs[0] : undefined,
        // Work History is a led-project view — a member-only project in
        // the filter never becomes its scope.
        workHistoryProjectSlug: resolveWorkHistoryProjectSlug(
          m.projectSlugs,
          projectFilter.filter((slug) => ledSlugSet.has(slug)),
          leadProjects
        ),
        ownWorkHistoryHref: m.id === userId ? ownWorkHistoryHref(m.id, selectableFilter, ledSlugs) ?? undefined : undefined,
        hoursToday,
        hoursWeek,
        hoursMonth,
        hoursSelected,
        capacityPct,
        status,
      };
    });
  }, [visibleMembers, todayHours, weekHours, monthHours, customHours, capacityByMember, assignedHoursByMember, period, customRange, projectFilter, projectOptions, ledSlugs, ledSlugSet, leadProjects, activeDays, userId]);

  const missingHours = useMemo(() => {
    return viewRows
      .filter((r) => r.status === "Missing")
      .map((r) => {
        const weeklyCapacity = capacityByMember.get(r.id) ?? 0;
        const expected = expectedHoursForPeriod(weeklyCapacity, period, customRange, activeDays);
        return {
          id: r.id,
          name: r.name,
          avatar: r.avatar,
          projectSlug: r.projectSlug,
          periodLabel: periodDisplayLabel(period),
          missingHours: round1(Math.max(0, expected - r.hoursSelected)),
        };
      })
      .sort((a, b) => b.missingHours - a.missingHours);
  }, [viewRows, capacityByMember, period, customRange, activeDays]);

  const weeklyUtilizationPct = useMemo(() => {
    let totalWeekHours = 0;
    let totalCapacity = 0;
    for (const r of viewRows) {
      totalWeekHours += r.hoursWeek;
      totalCapacity += capacityByMember.get(r.id) ?? 0;
    }
    return totalCapacity > 0 ? Math.round((totalWeekHours / totalCapacity) * 100) : 0;
  }, [viewRows, capacityByMember]);

  // "Capacity Risk" — count of distinct real profileIds whose assigned
  // workload (r.capacityPct, computed above from assignedHoursByMember ÷
  // each member's own canonical weeklyCapacity) exceeds 100%; `viewRows` is
  // already deduped one row per profileId by `mergeLedTeams`, so no one is
  // ever counted twice for being staffed on more than one led project.
  const overCapacityCount = useMemo(() => viewRows.filter((r) => r.capacityPct > 100).length, [viewRows]);

  const summary = {
    billableHours: financeSummary.billableHours,
    nonBillableHours: financeSummary.nonBillableHours,
    hoursMissing: missingHours.length,
    weeklyUtilizationPct,
  };

  // Delivery-focused breakdown of the same entriesForSelectedPeriod every
  // other widget on this page reads from — never a second query.
  const projectHours = useMemo<ProjectHoursRow[]>(() => {
    const projectSlugByTicketId = new Map(rawTickets.map((t) => [t.id, t.projectSlug]));
    const nameBySlug = new Map(rawProjects.map((p) => [p.slug, p.name]));
    const minutesBySlug = new Map<string, number>();
    for (const entry of entriesForSelectedPeriod) {
      const slug = projectSlugByTicketId.get(entry.ticketId);
      if (!slug) continue;
      minutesBySlug.set(slug, (minutesBySlug.get(slug) ?? 0) + entry.minutes);
    }
    return Array.from(minutesBySlug.entries())
      .map(([projectSlug, minutes]) => ({
        projectSlug,
        projectName: nameBySlug.get(projectSlug) ?? projectSlug,
        hours: round1(minutes / 60),
      }))
      .sort((a, b) => b.hours - a.hours);
  }, [rawTickets, rawProjects, entriesForSelectedPeriod]);

  // ── Real filter option lists — scoped to led projects/their own team only. ──
  const memberGroups = useMemo<DropdownGroup[]>(() => {
    const options = rawTeam.map((m) => ({ value: m.id, label: m.name, avatar: m.avatar }));
    return options.length === 0 ? [] : [{ options }];
  }, [rawTeam]);

  // Led projects first, then (after a divider) the active projects this
  // profile is only a regular member of — own time only, see
  // lib/time-tracking-scope.ts.
  const projectGroups = useMemo<DropdownGroup[]>(() => {
    const toOption = (p: TimeTrackingProjectOption) => ({ value: p.slug, label: p.name });
    const led = projectOptions.filter((p) => p.access === "lead").map(toOption);
    const ownOnly = projectOptions.filter((p) => p.access === "own").map(toOption);
    const groups: DropdownGroup[] = [];
    if (led.length > 0) groups.push({ options: led });
    if (ownOnly.length > 0) groups.push({ divider: led.length > 0, options: ownOnly });
    return groups;
  }, [projectOptions]);

  const clientGroups = useMemo<DropdownGroup[]>(() => {
    const clients = Array.from(
      new Set(
        rawProjects
          .filter((p) => p.category === "client")
          .map((p) => p.client as string | undefined)
          .filter((c): c is string => Boolean(c))
      )
    );
    const options = clients.map((c) => ({ value: c, label: c }));
    // Real absence-of-client signal (each project's own `client` field),
    // never inferred from `category` alone — see NO_CLIENT_FILTER_VALUE note.
    const hasNoClientProject = rawProjects.some((p) => !p.client);
    if (hasNoClientProject) options.push({ value: NO_CLIENT_FILTER_VALUE, label: "No Client" });
    return options.length === 0 ? [] : [{ options }];
  }, [rawProjects]);

  if (loadState === "loading") {
    return <ProjectLeadTimeTrackingLoadingSkeleton />;
  }

  if (loadState === "error") {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 pb-16">
        <div className="flex flex-col items-center justify-center text-center px-4 py-20">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-zinc-200">Couldn&apos;t load time tracking</h3>
          <p className="text-sm text-slate-400 mt-1 max-w-xs dark:text-zinc-500">
            {loadError ?? "Something went wrong."}
          </p>
          <button
            type="button"
            onClick={() => setLoadRequestId((id) => id + 1)}
            className="mt-5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg px-3.5 py-2 shadow-sm shadow-brand-600/20 transition-colors dark:bg-brand-accent dark:text-brand-accent-foreground dark:hover:bg-brand-accent-strong dark:focus-visible:outline-2 dark:focus-visible:outline-offset-2 dark:focus-visible:outline-brand-accent dark:shadow-brand-accent/20"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 pb-16">

      {/* ── Page header ──────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4 mb-4 sm:mb-5">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-zinc-50 tracking-tight leading-none">
            Time Tracking
          </h1>
          <p className="text-xs text-slate-400 dark:text-zinc-500 mt-0.5">{formatHeaderDate(getTodayISO())}</p>
        </div>
        <PeriodSelector value={period} onChange={setPeriod} appliedRange={customRange} onApplyRange={setCustomRange} />
      </div>

      {/* ── Filters ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 flex-wrap mb-6 rounded-xl border border-slate-200 dark:border-zinc-700/70 bg-white dark:bg-zinc-900 px-4 py-2.5 shadow-sm shadow-slate-200/40 dark:shadow-black/20">
        <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600 mr-2">
          Filter
        </span>
        <FilterDropdown label="Member"  mode="multi"  groups={memberGroups}  selected={memberFilter}  onChange={setMemberFilter} searchable />
        <FilterDropdown label="Project" mode="multi"  groups={projectGroups} selected={projectFilter} onChange={setProjectFilter} />
        <FilterDropdown label="Client"  mode="single" groups={clientGroups}  selected={clientFilter}  onChange={setClientFilter} />
      </div>

      {/* ── Overview ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-8">
        <KpiCard label="Logged Hours"       value={formatHours(totalLoggedHours)}        sub={periodSubLabel(period, customRange)} accent />
        <KpiCard label="Internal Hours"     value={formatHours(summary.nonBillableHours)} sub={periodSubLabel(period, customRange)} />
        <KpiCard label="Hours Missing"      value={summary.hoursMissing}                  sub="team members" danger={summary.hoursMissing > 0} />
        <KpiCard label="Weekly Utilization" value={`${summary.weeklyUtilizationPct}%`}     sub="of capacity" />
        <KpiCard
          label="Capacity Risk"
          value={overCapacityCount}
          sub="team members overloaded"
          danger={overCapacityCount > 0}
        />
        {/* Financial access only — a Project Lead without it never sees $,
            and only ever for led projects (ledEstimatedRevenue), built from
            the same entries the KPI row above reads, no separate query. */}
        {canViewFinancials && (
          <KpiCard
            label="Estimated Revenue"
            value={formatCurrency(ledEstimatedRevenue)}
            sub={periodSubLabel(period, customRange)}
            accent
          />
        )}
      </div>

      {/* ── Timesheets ───────────────────────────────────────────────────── */}
      <Section
        title="Timesheets"
        count={viewRows.length}
        icon={
          <svg className="w-3.5 h-3.5 text-slate-400 dark:text-zinc-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
        }
      >
        <div className="overflow-x-auto -mx-5 px-5">
          <table className="w-full text-sm min-w-[820px]">
            <thead>
              <tr className="border-b border-slate-100 dark:border-zinc-800">
                <th className="pb-2.5 text-left text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600 w-[200px]">
                  Member
                </th>
                <th className="pb-2.5 text-right text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">
                  Today
                </th>
                <th className="pb-2.5 text-right text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">
                  Week Total
                </th>
                <th className="pb-2.5 text-right text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">
                  Month Total
                </th>
                <th className="pb-2.5 pl-4 text-right text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">
                  Capacity
                </th>
                <th className="pb-2.5 pl-4 text-right text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">
                  Status
                </th>
                <th className="pb-2.5 pl-4 text-right text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 dark:divide-zinc-800/60">
              {viewRows.map((row) => (
                <TimesheetTableRow key={row.id} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* ── Action cards ─────────────────────────────────────────────────── */}
      <div className="grid md:grid-cols-2 gap-5 mt-6">
        <Section
          title="Hours Missing"
          count={missingHours.length}
          icon={
            <svg className="w-3.5 h-3.5 text-slate-400 dark:text-zinc-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
          }
        >
          {missingHours.length === 0 ? (
            <p className="text-[13px] text-slate-400 dark:text-zinc-600 py-1">Everyone is caught up for this period.</p>
          ) : (
            <div>
              {missingHours.slice(0, 5).map((entry) => (
                <div key={entry.id} className="flex items-center justify-between gap-2 py-2 border-b border-slate-100 dark:border-zinc-800/70 last:border-0">
                  <MemberTrigger
                    name={entry.name}
                    avatar={entry.avatar}
                    profileId={entry.id}
                    projectSlug={entry.projectSlug}
                    className="flex items-center gap-2 min-w-0"
                  >
                    <Avatar src={entry.avatar} name={entry.name} className="w-6 h-6 rounded-full flex-shrink-0" />
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium text-slate-800 dark:text-zinc-200 truncate">{entry.name}</p>
                      <p className="text-[11px] text-slate-400 dark:text-zinc-500">{entry.periodLabel}</p>
                    </div>
                  </MemberTrigger>
                  <span className="text-[11px] font-semibold text-red-600 dark:text-red-400 whitespace-nowrap flex-shrink-0">
                    {formatHours(entry.missingHours)} missing
                  </span>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section
          title="Hours by Project"
          count={projectHours.length}
          icon={
            <svg className="w-3.5 h-3.5 text-slate-400 dark:text-zinc-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
            </svg>
          }
        >
          <div>
            {projectHours.map((p) => {
              const pct = summary.billableHours + summary.nonBillableHours > 0
                ? Math.round((p.hours / (summary.billableHours + summary.nonBillableHours)) * 100)
                : 0;
              return (
                <div key={p.projectSlug} className="flex items-center justify-between gap-2 py-2 border-b border-slate-100 dark:border-zinc-800/70 last:border-0">
                  <p className="text-[13px] font-medium text-slate-800 dark:text-zinc-200 truncate">{p.projectName}</p>
                  <div className="text-right flex-shrink-0">
                    <p className="text-[13px] font-semibold text-slate-800 dark:text-zinc-200 tabular-nums">
                      {formatHours(p.hours)}
                    </p>
                    <p className="text-[11px] text-slate-400 dark:text-zinc-500 tabular-nums">
                      {pct}% of team time
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </Section>
      </div>
    </div>
  );
}

function TimesheetTableRow({ row }: { row: LedTimesheetViewRow }) {
  const router = useRouter();
  const goToWorkHistory = useCallback(() => {
    // A resolved single project → its own real Work History page; otherwise
    // (this row genuinely spans more than one of this Lead's led projects)
    // → the real global Work History, scoped to this Lead's own led
    // projects — never disabled, never a guessed single project.
    router.push(
      row.ownWorkHistoryHref ??
        (row.workHistoryProjectSlug
          ? `/projects/${row.workHistoryProjectSlug}/team/${row.id}/work-history`
          : `/time-tracking/team/${row.id}/work-history`)
    );
  }, [router, row.ownWorkHistoryHref, row.workHistoryProjectSlug, row.id]);
  return (
    <tr className="hover:bg-slate-50/60 dark:hover:bg-zinc-800/30 transition-colors duration-150">
      <td className="py-2.5 pr-4">
        <MemberTrigger
          name={row.name}
          avatar={row.avatar}
          role={row.role}
          profileId={row.id}
          projectSlug={row.projectSlug}
          className="flex items-center gap-2.5"
        >
          <Avatar src={row.avatar} name={row.name} className="w-7 h-7 rounded-full flex-shrink-0" />
          <div className="min-w-0">
            <p className="font-medium text-slate-800 dark:text-zinc-200 truncate">{row.name}</p>
            <p className="text-[11px] text-slate-400 dark:text-zinc-500 truncate">{row.role}</p>
          </div>
        </MemberTrigger>
      </td>
      <td className="py-2.5 text-right tabular-nums text-slate-600 dark:text-zinc-400">
        {formatHours(row.hoursToday)}
      </td>
      <td className="py-2.5 text-right tabular-nums text-slate-600 dark:text-zinc-400">
        {formatHours(row.hoursWeek)}
      </td>
      <td className="py-2.5 text-right tabular-nums text-slate-600 dark:text-zinc-400">
        {formatHours(row.hoursMonth)}
      </td>
      <td className="py-2.5 pl-4 text-right">
        <CapacityCell pct={row.capacityPct} />
      </td>
      <td className="py-2.5 pl-4 text-right">
        <StatusPill status={row.status} />
      </td>
      <td className="py-2.5 pl-4 text-right">
        <button
          type="button"
          onClick={goToWorkHistory}
          className="text-[12px] font-medium text-brand-600 dark:text-brand-accent hover:text-brand-700 dark:hover:text-brand-accent-soft whitespace-nowrap transition-colors"
        >
          View →
        </button>
      </td>
    </tr>
  );
}
