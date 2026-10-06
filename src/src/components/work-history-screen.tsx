"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCurrentUser } from "@/components/current-user-provider";
import { useOrganizationProjects } from "@/components/organization-projects-provider";
import { loadLeadProjects, loadProjectTeam } from "@/lib/projects";
import {
  loadProjectMemberWorkHistorySummary,
  loadProjectMemberWorkHistoryPage,
  loadTeamMemberWorkHistorySummaryAcrossProjects,
  loadTeamMemberWorkHistoryPageAcrossProjects,
  loadTeamMemberWorkHistoryProjectOptions,
} from "@/lib/tickets";
import type {
  ProjectMemberWorkHistorySummary,
  ProjectMemberWorkHistoryEntry,
  TeamWorkHistoryFilters,
  TeamWorkHistoryActivityFilter,
} from "@/lib/tickets";
import { StatusBadge as TicketStatusBadge, PriorityBadge, STATUS_LABEL, getTodayISO } from "@/components/tickets/ticket-ui";
import type { TicketStatus } from "@/lib/mock-tickets";
import { FALLBACK_AVATAR } from "@/lib/current-user";
import { Avatar } from "@/components/ui/avatar";
import { SkeletonBlock } from "@/components/dashboard-shared";
import { FilterDropdown, type DropdownGroup } from "@/components/tickets/filter-dropdown";
import { PeriodSelector, getCurrentWeekRange, getCurrentMonthRange, parseListParam } from "@/components/time-tracking-screen";
import { buildLeadTimeTrackingProjectOptions, slugsWithAccess, workHistoryScopeSlugs } from "@/lib/time-tracking-scope";
import type { TimePeriod, CustomRange } from "@/lib/mock-time-tracking";

// Real replacement for the "View Work History" modal (member-profile-modal.tsx,
// now removed) — the same "which tickets has this person worked on in this
// project" question, but as its own page so a history that grows into the
// hundreds/thousands of tickets is paginated server-side instead of loaded
// whole into a modal. See src/lib/tickets.ts's loadProjectMemberWorkHistorySummary/
// loadProjectMemberWorkHistoryPage for the actual data — this screen only
// renders it and manages the ?page= URL param.
//
// The global "/time-tracking/team/[userId]/work-history" route (no `slug`)
// reuses this exact same component/markup, just with a real Search/Project/
// Period/Status/Activity filter row and a 4th "Activities" KPI added on top
// — the project-scoped route (`slug` set) renders every one of its own
// branches below completely unchanged.

const PAGE_SIZE = 20;

function readPageParam(raw: string | null): number {
  const parsed = raw ? Number.parseInt(raw, 10) : 1;
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

const ACTIVITY_FILTER_LABEL: Record<TeamWorkHistoryActivityFilter, string> = {
  time_logged: "Time Logged",
  comments: "Comments",
  status_changes: "Status Changes",
  assignments: "Assignments",
  attachments: "Attachments",
};

const STATUS_FILTER_GROUPS: DropdownGroup[] = [
  {
    options: (Object.keys(STATUS_LABEL) as TicketStatus[]).map((s) => ({ value: s, label: STATUS_LABEL[s] })),
  },
];

const ACTIVITY_FILTER_GROUPS: DropdownGroup[] = [
  {
    options: (Object.keys(ACTIVITY_FILTER_LABEL) as TeamWorkHistoryActivityFilter[]).map((k) => ({
      value: k,
      label: ACTIVITY_FILTER_LABEL[k],
    })),
  },
];

// Real date bounds for the selected Period — same Today/This Week
// (Monday–Sunday)/This Month/Custom Range resolution Time Tracking already
// uses (getCurrentWeekRange/getCurrentMonthRange), never a fixed/guessed date.
function resolvePeriodRange(period: TimePeriod, customRange: CustomRange): { from: string; to: string } {
  if (period === "today") {
    const today = getTodayISO();
    return { from: today, to: today };
  }
  if (period === "month") return getCurrentMonthRange();
  if (period === "custom") return customRange;
  return getCurrentWeekRange();
}

export function WorkHistoryBreadcrumb({ slug, userId }: { slug?: string; userId: string }) {
  const { projects } = useOrganizationProjects();
  const { organization, userId: currentUserId, isDevFallback, user } = useCurrentUser();
  const [memberName, setMemberName] = useState<string | null>(null);

  // Real identity lookup only — never a project-selection decision. When
  // `slug` is real (the project-scoped route), this matches the original
  // single-project logic exactly. When it's absent (the global Project
  // Lead route), the same name is looked up across every one of the
  // *authenticated* Lead's own real led projects (loadLeadProjects) — never
  // the target member's own projects at large, and the first roster that
  // contains them is used only for name/avatar, which is identical across
  // every project they're staffed on.
  useEffect(() => {
    if (isDevFallback || !organization) return;
    let cancelled = false;

    if (slug) {
      loadProjectTeam(organization.id, slug).then((result) => {
        if (cancelled) return;
        if (result.status === "ready") {
          setMemberName(result.members.find((m) => m.id === userId)?.name ?? null);
        }
      });
    } else if (currentUserId) {
      (async () => {
        const leadResult = await loadLeadProjects(organization.id, currentUserId, { includeNonActive: true });
        if (cancelled || leadResult.status === "error") return;
        const teamResults = await Promise.all(
          leadResult.projects.map((p) => loadProjectTeam(organization.id, p.slug))
        );
        if (cancelled) return;
        for (const teamResult of teamResults) {
          if (teamResult.status !== "ready") continue;
          const found = teamResult.members.find((m) => m.id === userId);
          if (found) {
            setMemberName(found.name);
            return;
          }
        }
        // The viewer's own history (possibly on member-only projects, where
        // no led roster lists them) — their own session name.
        if (userId === currentUserId) setMemberName(user.name);
      })();
    }

    return () => {
      cancelled = true;
    };
  }, [organization, isDevFallback, slug, userId, currentUserId, user.name]);

  if (!slug) {
    return (
      <>
        <Link href="/time-tracking" className="text-slate-400 hover:text-slate-600 dark:text-zinc-500 dark:hover:text-zinc-300">
          Time Tracking
        </Link>
        <span className="text-slate-300 dark:text-zinc-700">/</span>
        <span className="text-slate-800 font-medium dark:text-zinc-200">
          {memberName ? `${memberName} · Work History` : "Work History"}
        </span>
      </>
    );
  }

  const projectName = projects.find((p) => p.slug === slug)?.name ?? slug;

  return (
    <>
      <Link href="/projects" className="text-slate-400 hover:text-slate-600 dark:text-zinc-500 dark:hover:text-zinc-300">
        Projects
      </Link>
      <span className="text-slate-300 dark:text-zinc-700">/</span>
      <Link
        href={`/projects/${slug}`}
        className="text-slate-400 hover:text-slate-600 dark:text-zinc-500 dark:hover:text-zinc-300"
      >
        {projectName}
      </Link>
      <span className="text-slate-300 dark:text-zinc-700">/</span>
      <Link
        href={`/projects/${slug}/team`}
        className="text-slate-400 hover:text-slate-600 dark:text-zinc-500 dark:hover:text-zinc-300"
      >
        Team
      </Link>
      <span className="text-slate-300 dark:text-zinc-700">/</span>
      <span className="text-slate-800 font-medium dark:text-zinc-200">
        {memberName ? `${memberName} · Work History` : "Work History"}
      </span>
    </>
  );
}

export function WorkHistoryScreen({ slug, userId }: { slug?: string; userId: string }) {
  const { organization, userId: currentUserId, isDevFallback, user } = useCurrentUser();
  const { projects: orgProjects, status: orgProjectsStatus } = useOrganizationProjects();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedPage = readPageParam(searchParams.get("page"));

  // Three real scopes share this one screen:
  // - "project": the plain project-scoped route (`slug` set) for any
  //   non-Admin viewer — completely unchanged, no filters, 3 KPI tiles.
  // - "team": the Project Lead's own global route (no `slug`) — scoped to
  //   `loadLeadProjects`, unchanged from before this task.
  // - "admin": the same `/projects/[slug]/team/[userId]/work-history` route,
  //   but for an Admin viewer — gets the exact same filter/KPI UI as "team"
  //   (reused verbatim below), scoped to every real org project instead of
  //   just this Lead's own, with Project pre-selected to the entry `slug`.
  const mode: "project" | "team" | "admin" = !slug ? "team" : user.role === "ADMIN" ? "admin" : "project";

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [member, setMember] = useState<{ name: string; avatar: string } | null>(null);
  const [summary, setSummary] = useState<ProjectMemberWorkHistorySummary>({
    ticketCount: 0,
    totalHours: 0,
    lastActivityLabel: null,
  });
  const [entries, setEntries] = useState<ProjectMemberWorkHistoryEntry[]>([]);

  // ── Real filters — "team"/"admin" modes only; plain "project" mode never
  // renders or reads any of these. Admin starts with Project pre-selected
  // to the real entry `slug` (never All Projects, never guessed). ─────────
  const [search, setSearch] = useState("");
  // "team" may arrive pre-filtered from Time Tracking (`?projects=`, the
  // same query-state convention that page uses) — anything outside this
  // viewer's authorized scope is dropped by the reconcile step below.
  const [projectFilter, setProjectFilter] = useState<string[]>(() =>
    mode === "admin" && slug ? [slug] : mode === "team" ? parseListParam(searchParams.get("projects")) : []
  );
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [activityFilter, setActivityFilter] = useState<string[]>([]);
  const [period, setPeriod] = useState<TimePeriod>("week");
  const [customRange, setCustomRange] = useState<CustomRange>({ from: getTodayISO(-13), to: getTodayISO() });
  const [projectOptions, setProjectOptions] = useState<{ slug: string; name: string }[]>([]);

  const activeFilters: TeamWorkHistoryFilters = {
    // JIR-114 — every selected project (OR); empty = All projects.
    projectSlugs: projectFilter.length > 0 ? projectFilter : undefined,
    search: search.trim() || undefined,
    period: resolvePeriodRange(period, customRange),
    status: statusFilter[0] as TicketStatus | undefined,
    activity: activityFilter[0] as TeamWorkHistoryActivityFilter | undefined,
  };

  // Show the skeleton again only for a real user-driven change (filters,
  // search, or page) — never for the silent focus-regain refresh below
  // (that effect keys off `organization`, not any of these), so background
  // revalidation never flickers the page back to a loading state.
  useEffect(() => {
    if (mode === "project") return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: shows the skeleton again only for a real filter/page change, never for the silent focus-regain refetch below (see that effect's own comment)
    setStatus("loading");
  }, [mode, userId, requestedPage, search, projectFilter, statusFilter, activityFilter, period, customRange]);

  // Any real filter/search change jumps back to page 1 — never leaves a
  // user stranded on a page number that may no longer exist for the new
  // filtered result set. Same URL the route already renders at (Admin never
  // navigates off `/projects/[slug]/...` just for switching Project/Status/
  // etc.) — only the `?page=` param resets.
  useEffect(() => {
    if (mode === "project" || requestedPage === 1) return;
    const base = mode === "team" ? `/time-tracking/team/${userId}/work-history` : `/projects/${slug}/team/${userId}/work-history`;
    router.replace(`${base}?page=1`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, projectFilter, statusFilter, activityFilter, period, customRange]);

  useEffect(() => {
    if (isDevFallback || !organization) return;
    let cancelled = false;

    if (mode === "project") {
      // ── Single real project (unchanged) ──────────────────────────────
      Promise.all([
        loadProjectTeam(organization.id, slug!),
        loadProjectMemberWorkHistorySummary(organization.id, slug!, userId),
      ]).then(([teamResult, summaryResult]) => {
        if (cancelled) return;

        if (teamResult.status === "ready") {
          const found = teamResult.members.find((m) => m.id === userId);
          setMember(found ? { name: found.name, avatar: found.avatar } : null);
        }

        if (summaryResult.status === "error") {
          setStatus("error");
          setErrorMessage(summaryResult.message);
          return;
        }
        setSummary(summaryResult.summary);

        const totalPages = Math.max(1, Math.ceil(summaryResult.summary.ticketCount / PAGE_SIZE));
        if (requestedPage > totalPages) {
          // Never render a page past the end as if it were legitimately
          // empty — resolve to the last real page instead (or page 1, which
          // is also the last page when there's no history at all).
          router.replace(`/projects/${slug}/team/${userId}/work-history?page=${totalPages}`);
          return;
        }

        loadProjectMemberWorkHistoryPage(organization.id, slug!, userId, requestedPage, PAGE_SIZE).then((pageResult) => {
          if (cancelled) return;
          if (pageResult.status === "error") {
            setStatus("error");
            setErrorMessage(pageResult.message);
            return;
          }
          setEntries(pageResult.entries);
          setStatus("ready");
        });
      });
    } else if (mode === "admin" && orgProjectsStatus === "error") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: surfaces the real useOrganizationProjects() failure instead of leaving the page stuck on its initial "loading" state forever
      setStatus("error");
      setErrorMessage("Couldn't load this organization's projects.");
    } else if (
      mode === "team"
        ? // The viewer's own history also needs their accessible projects.
          Boolean(currentUserId) && (userId !== currentUserId || orgProjectsStatus !== "loading")
        : orgProjectsStatus === "ready"
    ) {
      // ── "team": every real project the *authenticated* Project Lead
      // leads. "admin": every real project this organization has
      // (already the same real, org-scoped list Projects/Sidebar/etc. all
      // share via useOrganizationProjects — never a second query, never
      // another organization's data). Both narrowed by the real filters
      // above, both reusing the exact same data functions — never the
      // target member's own projects at large, and never picked/guessed.
      (async () => {
        let scopeSlugs: string[];
        // Team rosters (name/avatar lookup) are only ever read for led projects.
        let rosterSlugs: string[] = [];
        if (mode === "team") {
          const leadResult = await loadLeadProjects(organization.id, currentUserId!, { includeNonActive: true });
          if (cancelled) return;
          if (leadResult.status === "error") {
            setStatus("error");
            setErrorMessage(leadResult.message);
            return;
          }
          // Someone else's history: led projects only, as before. The
          // viewer's own: also the non-archived projects they're a regular
          // member of (see lib/time-tracking-scope.ts) — every loader below
          // is already keyed on `userId`, here the viewer's own id.
          const scopeOptions = buildLeadTimeTrackingProjectOptions(leadResult.projects, orgProjects);
          scopeSlugs = workHistoryScopeSlugs(scopeOptions, userId, currentUserId!);
          rosterSlugs = slugsWithAccess(scopeOptions, "lead");
        } else {
          scopeSlugs = orgProjects.map((p) => p.slug);
        }

        // JIR-114 — drop any selected project that's no longer in this
        // viewer's authorized scope (it could never match anything anyway —
        // the data layer only ever narrows the scope). Updating the filter
        // re-runs this effect once with the reconciled selection; when
        // nothing is stale this is a no-op.
        const scopeSet = new Set(scopeSlugs);
        if (projectFilter.some((s) => !scopeSet.has(s))) {
          setProjectFilter(projectFilter.filter((s) => scopeSet.has(s)));
          return;
        }

        const teamLookup =
          mode === "team"
            ? Promise.all(rosterSlugs.map((s) => loadProjectTeam(organization.id, s)))
            // Admin already entered from this real project's own Team
            // roster — the same single real lookup "project" mode above
            // already relies on, never every org project's roster.
            : loadProjectTeam(organization.id, slug!).then((r) => [r]);

        const [teamResults, projectOptionsResult, summaryResult] = await Promise.all([
          teamLookup,
          loadTeamMemberWorkHistoryProjectOptions(organization.id, scopeSlugs, userId),
          loadTeamMemberWorkHistorySummaryAcrossProjects(organization.id, scopeSlugs, userId, activeFilters),
        ]);
        if (cancelled) return;

        let foundMember = false;
        for (const teamResult of teamResults) {
          if (teamResult.status !== "ready") continue;
          const found = teamResult.members.find((m) => m.id === userId);
          if (found) {
            setMember({ name: found.name, avatar: found.avatar });
            foundMember = true;
            break;
          }
        }
        if (!foundMember && mode === "team" && userId === currentUserId) {
          setMember({ name: user.name, avatar: user.avatar });
        }

        if (projectOptionsResult.status === "ready") {
          setProjectOptions(
            projectOptionsResult.projectSlugs.map((s) => ({
              slug: s,
              name: orgProjects.find((p) => p.slug === s)?.name ?? s,
            }))
          );
        }

        if (summaryResult.status === "error") {
          setStatus("error");
          setErrorMessage(summaryResult.message);
          return;
        }
        setSummary(summaryResult.summary);

        const basePath = mode === "team" ? `/time-tracking/team/${userId}/work-history` : `/projects/${slug}/team/${userId}/work-history`;
        const totalPages = Math.max(1, Math.ceil(summaryResult.summary.ticketCount / PAGE_SIZE));
        if (requestedPage > totalPages && requestedPage > 1) {
          router.replace(`${basePath}?page=${totalPages}`);
          return;
        }

        const pageResult = await loadTeamMemberWorkHistoryPageAcrossProjects(
          organization.id,
          scopeSlugs,
          userId,
          activeFilters,
          requestedPage,
          PAGE_SIZE
        );
        if (cancelled) return;
        if (pageResult.status === "error") {
          setStatus("error");
          setErrorMessage(pageResult.message);
          return;
        }
        setEntries(pageResult.entries);
        setStatus("ready");
      })();
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organization, isDevFallback, mode, slug, userId, requestedPage, currentUserId, orgProjectsStatus, search, projectFilter, statusFilter, activityFilter, period, customRange]);

  const totalPages = Math.max(1, Math.ceil(summary.ticketCount / PAGE_SIZE));
  const hasNarrowingFilters =
    Boolean(search.trim()) || projectFilter.length > 0 || statusFilter.length > 0 || activityFilter.length > 0;
  const subtitle =
    mode === "project" ? "in this project" : mode === "team" ? "across your projects" : "across the organization";

  function goToPage(page: number) {
    const base = slug ? `/projects/${slug}/team/${userId}/work-history` : `/time-tracking/team/${userId}/work-history`;
    router.push(`${base}?page=${page}`);
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-8 py-10">
      {mode === "project" ? (
        <div className="flex items-center gap-3">
          <Avatar
            src={member?.avatar ?? FALLBACK_AVATAR}
            name={member?.name ?? "Team member"}
            className="w-10 h-10 rounded-full flex-shrink-0"
          />
          <div>
            <h1 className="text-xl font-bold text-slate-900 tracking-tight dark:text-zinc-50">Work History</h1>
            <p className="text-sm text-slate-500 mt-0.5 dark:text-zinc-400">
              {member?.name ?? "Team member"} · which tickets they&apos;ve worked on in this project.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <Avatar
              src={member?.avatar ?? FALLBACK_AVATAR}
              name={member?.name ?? "Team member"}
              className="w-10 h-10 rounded-full flex-shrink-0"
            />
            <div>
              <h1 className="text-xl font-bold text-slate-900 tracking-tight dark:text-zinc-50">Work History</h1>
              <p className="text-sm text-slate-500 mt-0.5 dark:text-zinc-400">
                {member?.name ?? "Team member"} · which tickets they&apos;ve worked on {subtitle}.
              </p>
            </div>
          </div>
          <PeriodSelector value={period} onChange={setPeriod} appliedRange={customRange} onApplyRange={setCustomRange} />
        </div>
      )}

      {/* ── Filters — "team"/"admin" modes only, same visual pattern Time
          Tracking's own filter bar already uses. ────────────────────── */}
      {mode !== "project" && (
        <div className="mt-4 flex items-center gap-1 flex-wrap rounded-xl border border-slate-200 dark:border-zinc-700/70 bg-white dark:bg-zinc-900 px-4 py-2.5 shadow-sm shadow-slate-200/40 dark:shadow-black/20">
          <label className="relative block mr-1">
            <svg
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 dark:text-zinc-500"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4.3-4.3" />
            </svg>
            <input
              type="text"
              placeholder="Search by ticket code or title…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-64 text-[16px] sm:text-sm bg-slate-100 dark:bg-zinc-900 placeholder:text-slate-400 dark:placeholder:text-zinc-500 text-slate-800 dark:text-zinc-100 rounded-md pl-8 pr-3 py-1.5 outline-none focus:ring-2 focus:ring-brand-500/30 transition-colors dark:focus:ring-brand-accent/30"
            />
          </label>
          {/* JIR-114 — multi-select (OR between projects), with search for
              organizations with many projects; clearing it is All projects. */}
          <FilterDropdown
            label="Project"
            mode="multi"
            searchable
            groups={projectOptions.length > 0 ? [{ options: projectOptions.map((p) => ({ value: p.slug, label: p.name })) }] : []}
            selected={projectFilter}
            onChange={setProjectFilter}
          />
          <FilterDropdown
            label="Status"
            mode="single"
            groups={STATUS_FILTER_GROUPS}
            selected={statusFilter}
            onChange={setStatusFilter}
          />
          <FilterDropdown
            label="Activity"
            mode="single"
            groups={ACTIVITY_FILTER_GROUPS}
            selected={activityFilter}
            onChange={setActivityFilter}
          />
        </div>
      )}

      {status === "loading" && mode === "project" && (
        <div className="flex items-center justify-center text-sm text-slate-400 dark:text-zinc-500 py-20">
          Loading work history…
        </div>
      )}

      {status === "loading" && mode !== "project" && (
        <div className="mt-6">
          <div className="flex items-stretch divide-x divide-slate-100 dark:divide-zinc-800 rounded-xl border border-slate-200 dark:border-zinc-700/70 bg-white dark:bg-zinc-900 overflow-hidden">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex-1 px-5 py-4">
                <SkeletonBlock className="h-2.5 w-20" />
                <SkeletonBlock className="h-6 w-12 mt-2" />
              </div>
            ))}
          </div>
          <div className="mt-6 divide-y divide-slate-100 dark:divide-zinc-800 rounded-xl border border-slate-200 dark:border-zinc-700/70 bg-white dark:bg-zinc-900">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="px-4 py-3">
                <SkeletonBlock className="h-3.5 w-full max-w-md" />
                <SkeletonBlock className="h-3 w-40 mt-2" />
              </div>
            ))}
          </div>
        </div>
      )}

      {status === "error" && (
        <div className="flex flex-col items-center justify-center text-center px-4 py-20">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-zinc-200">Couldn&apos;t load work history</h3>
          <p className="text-sm text-slate-400 mt-1 max-w-xs dark:text-zinc-500">
            {errorMessage ?? "Something went wrong."}
          </p>
        </div>
      )}

      {status === "ready" && (
        <>
          <div className="mt-6 flex items-stretch divide-x divide-slate-100 dark:divide-zinc-800 rounded-xl border border-slate-200 dark:border-zinc-700/70 bg-white dark:bg-zinc-900 shadow-sm shadow-slate-200/40 dark:shadow-black/20 overflow-hidden">
            <div className="flex-1 px-5 py-4">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">Tickets Worked On</p>
              <p className="text-2xl font-bold text-slate-900 dark:text-zinc-50 mt-1 leading-none">{summary.ticketCount}</p>
            </div>
            <div className="flex-1 px-5 py-4">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">Hours Logged</p>
              <p className="text-2xl font-bold text-slate-900 dark:text-zinc-50 mt-1 leading-none">{summary.totalHours}h</p>
            </div>
            {mode !== "project" && (
              <div className="flex-1 px-5 py-4">
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">Activities</p>
                <p className="text-2xl font-bold text-slate-900 dark:text-zinc-50 mt-1 leading-none">{summary.activityCount ?? 0}</p>
              </div>
            )}
            <div className="flex-1 px-5 py-4">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">Last Activity</p>
              <p className="text-2xl font-bold text-slate-900 dark:text-zinc-50 mt-1 leading-none">
                {summary.lastActivityLabel ?? "—"}
              </p>
            </div>
          </div>

          <div className="mt-6">
            {entries.length === 0 ? (
              <p className="text-sm text-slate-400 dark:text-zinc-500 py-2">
                {mode !== "project" && hasNarrowingFilters ? "No tickets match the current filters." : "No work history yet."}
              </p>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-zinc-800 rounded-xl border border-slate-200 dark:border-zinc-700/70 bg-white dark:bg-zinc-900">
                {entries.map((entry) => (
                  <Link
                    key={entry.ticketId}
                    href={`/projects/${entry.projectSlug ?? slug}/tickets/${entry.ticketKey}`}
                    className="block px-4 py-3 hover:bg-slate-50 dark:hover:bg-zinc-800/50 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-mono text-slate-400 dark:text-zinc-500 flex-shrink-0 w-16">
                        {entry.ticketKey}
                      </span>
                      <span className="flex-1 min-w-0 text-sm text-slate-700 dark:text-zinc-300 truncate">
                        {entry.title}
                      </span>
                      <PriorityBadge priority={entry.priority} />
                      <TicketStatusBadge status={entry.status} />
                    </div>
                    <p className="text-[11px] text-slate-400 dark:text-zinc-500 mt-1 pl-[4.75rem]">
                      {entry.hours}h logged · {entry.activityCount} {entry.activityCount === 1 ? "activity" : "activities"} · Last activity {entry.lastActivityLabel}
                    </p>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {summary.ticketCount > 0 && (
            <div className="mt-4 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => goToPage(requestedPage - 1)}
                disabled={requestedPage <= 1}
                className="text-sm font-medium text-slate-500 dark:text-zinc-400 border border-slate-200 dark:border-zinc-700 rounded-lg px-3.5 py-2 hover:bg-slate-50 dark:hover:bg-zinc-800/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              >
                Previous
              </button>
              <p className="text-[13px] text-slate-400 dark:text-zinc-500">
                Page {requestedPage} of {totalPages} · {summary.ticketCount} ticket{summary.ticketCount === 1 ? "" : "s"}
              </p>
              <button
                type="button"
                onClick={() => goToPage(requestedPage + 1)}
                disabled={requestedPage >= totalPages}
                className="text-sm font-medium text-slate-500 dark:text-zinc-400 border border-slate-200 dark:border-zinc-700 rounded-lg px-3.5 py-2 hover:bg-slate-50 dark:hover:bg-zinc-800/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
