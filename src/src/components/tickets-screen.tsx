"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { tickets as MOCK_TICKETS, getTicketDisplayKey } from "@/lib/mock-tickets";
import type { Ticket } from "@/lib/mock-tickets";
import {
  loadProjectTickets,
  loadOrganizationTickets,
  loadOrganizationLabels,
  updateTicket,
  STATUS_FROM_DB,
  FALLBACK_TICKET_STATUSES,
  isTicketClosed,
  type TicketStatusOption,
} from "@/lib/tickets";
import {
  loadOrganizationMembers,
  loadProjectTeam,
  loadOrganizationProjects,
  loadLeadProjects,
  loadMemberProjects,
  type OrgMember,
} from "@/lib/projects";
import { buildLabelCatalog, parseDisplayDate, getTodayISO } from "@/components/tickets/ticket-ui";
import { formatHours } from "@/components/time-tracking-screen";
import { NewTicketModal } from "@/components/tickets/new-ticket-modal";
import { ImportJiraModal } from "@/components/tickets/import-jira-modal";
import { ViewSwitcher, type ViewMode } from "@/components/tickets/view-switcher";
import { FilterBar, type AddFilterKind } from "@/components/tickets/filter-bar";
import { EMPTY_DATE_RANGE, type DateRangeValue } from "@/components/tickets/date-range-filter-dropdown";
import { BoardView, countBoardColumns, ticketColumnKey } from "@/components/tickets/board-view";
import { ListView } from "@/components/tickets/list-view";
import { CalendarView } from "@/components/tickets/calendar-view";
import { TimelineView } from "@/components/tickets/timeline-view";
import { InsightsView } from "@/components/tickets/insights-view";
import { useCurrentUser } from "@/components/current-user-provider";
import { useOrganizationProjects } from "@/components/organization-projects-provider";
import { getDefaultTicketView } from "@/lib/user-preferences";
import { resolveInitialTicketView } from "@/lib/ticket-initial-view";
import { SkeletonBlock } from "@/components/dashboard-shared";
import { useRefreshOnFocusAndVisibility } from "@/components/member-profile-modal";
import { loadProjectSprints, type Sprint } from "@/lib/sprints";
import {
  SprintContextSelector,
  SPRINT_CONTEXT_ALL,
  SPRINT_CONTEXT_BACKLOG,
} from "@/components/tickets/sprint-context-selector";
import { ManageSprintModal } from "@/components/tickets/manage-sprint-modal";

// ── Persisted state shape ─────────────────────────────────────────────────────

interface SavedState {
  view: ViewMode;
  activeChips: string[];
  searchQuery: string;
  scrollTop: number;
  /** Sprint MVP — "all" | "backlog" | a real sprints.id. Undefined on state
   *  saved before this feature existed; treated the same as unset (falls
   *  back to the active-sprint-or-"all" default below). */
  sprintContext?: string;
}

function sessionKey(slug: string) {
  return `jirita-tickets-${slug}`;
}

// Read (but don't yet remove) saved state on render so it's available to useState.
// Removal happens in useEffect to avoid strict-mode double-invoke issues.
function readSaved(slug: string): SavedState | null {
  if (typeof window === "undefined") return null;
  const raw = sessionStorage.getItem(sessionKey(slug));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SavedState;
  } catch {
    return null;
  }
}

function saveState(slug: string, state: SavedState) {
  sessionStorage.setItem(sessionKey(slug), JSON.stringify(state));
}

// Lets another screen (e.g. the Admin Project Overview's blocked-tickets
// banner) hand off to this screen already filtered, by writing into the same
// saved-state slot this screen reads on mount — the same mechanism openTicket
// below already uses to restore view/scroll position after visiting a
// ticket's own Detail page.
export function presetTicketsFilter(slug: string, chips: string[]) {
  if (typeof window === "undefined") return;
  saveState(slug, {
    view: "board",
    activeChips: chips,
    searchQuery: "",
    scrollTop: 0,
  });
}

// ── Loading skeleton ─────────────────────────────────────────────────────────
// Shown only for the true first load (`loadState === "loading"`, now gated
// by `hasLoadedRef` above so a background focus/visibility refresh never
// re-shows it once real tickets already exist). Mirrors the real header/
// filter-bar/quick-stats/Board layout below section-for-section and
// proportion-for-proportion — same 6 real columns board-view.tsx itself
// renders (Backlog/To Do/In Progress/Blocked/In Review/Done), each with a
// small, representative number of card placeholders, never a fabricated
// count pretending to be real data — so nothing shifts once real tickets
// land. Uses the existing `SkeletonBlock` primitive only (no new skeleton
// primitive). List/Calendar/Timeline/Insights are unaffected — this is only
// ever shown before any real ticket data exists, before `view` even matters.
const TICKETS_SKELETON_COLUMN_CARD_COUNTS = [3, 2, 2, 1, 1, 2];

function TicketsScreenSkeleton({ showNewTicketButton }: { showNewTicketButton: boolean }) {
  return (
    <div className="h-full flex flex-col" aria-busy="true">
      {/* Page header */}
      <div className="flex-shrink-0 px-4 sm:px-6 pt-4 sm:pt-5 pb-0">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4 mb-3 sm:mb-4">
          <div>
            <SkeletonBlock className="h-7 w-24 rounded mb-2" />
            <SkeletonBlock className="h-4 w-72 rounded" />
          </div>
          <div className="hidden sm:flex items-center gap-3 flex-shrink-0 mt-0.5">
            <SkeletonBlock className="h-8 w-40 rounded-lg" />
            {showNewTicketButton && <SkeletonBlock className="h-8 w-28 rounded-lg" />}
          </div>
          <div className="flex sm:hidden flex-col gap-3">
            {showNewTicketButton && (
              <div className="flex justify-end">
                <SkeletonBlock className="h-8 w-28 rounded-lg" />
              </div>
            )}
            <SkeletonBlock className="h-8 w-40 rounded-lg" />
          </div>
        </div>

        {/* Search + filters */}
        <div className="flex items-center gap-2 flex-wrap">
          <SkeletonBlock className="h-8 w-full sm:w-64 rounded-md" />
          <SkeletonBlock className="h-8 w-24 rounded-md" />
          <SkeletonBlock className="h-8 w-24 rounded-md" />
          <SkeletonBlock className="h-8 w-24 rounded-md" />
          <SkeletonBlock className="h-8 w-28 rounded-md" />
        </div>
        <div className="flex items-center gap-2 mt-2">
          <SkeletonBlock className="h-6 w-16 rounded-full" />
          <SkeletonBlock className="h-6 w-20 rounded-full" />
          <SkeletonBlock className="h-6 w-24 rounded-full" />
        </div>

        {/* Quick stats — Tickets · Estimated · Blocked */}
        <div className="mt-3">
          <SkeletonBlock className="h-3 w-64 rounded" />
        </div>

        <div className="mt-3 border-b border-slate-200 dark:border-zinc-800" />
      </div>

      {/* Board columns */}
      <div className="flex-1 min-h-0 overflow-x-auto">
        <div className="flex gap-4 h-full px-6 pt-4 pb-6">
          {TICKETS_SKELETON_COLUMN_CARD_COUNTS.map((cardCount, i) => (
            <div
              key={i}
              className="flex-1 min-w-[170px] flex flex-col min-h-0 rounded-xl bg-slate-100/60 dark:bg-zinc-800/40 border border-slate-200/80 dark:border-zinc-700/30"
            >
              <div className="flex-shrink-0 px-4 pt-4 pb-3">
                <div className="flex items-center justify-between gap-2">
                  <SkeletonBlock className="h-2.5 w-16 rounded" />
                  <SkeletonBlock className="h-4 w-5 rounded-full" />
                </div>
              </div>
              <div className="flex-1 min-h-0 px-3 pb-3 space-y-1.5">
                {Array.from({ length: cardCount }).map((_, j) => (
                  <SkeletonBlock key={j} className="h-16 w-full rounded-lg" />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Same "server page, client breadcrumb" split as ProjectReportsBreadcrumb/
// ProjectSettingsBreadcrumb — the real project name comes from the org's
// already-loaded project list (OrganizationProjectsProvider), not the old
// mock-projects.ts lookup app/projects/[slug]/tickets/page.tsx used to do
// (which fell back to a hardcoded "Mobile Banking App" for any real,
// non-mock project — e.g. KTVibe — it couldn't find).
export function TicketsBreadcrumb({ slug }: { slug: string }) {
  const { projects } = useOrganizationProjects();
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
      <span className="text-slate-800 font-medium dark:text-zinc-200">Tickets</span>
    </>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

// `slug` is omitted for the org-wide "all projects" mode (the Admin
// Dashboard's global ticket list, reached at `/tickets` — see
// app/tickets/page.tsx) — every other caller keeps passing a real slug and
// is completely unaffected. `projectName` was already unused in this
// component before this change; left as-is.
export function TicketsScreen({ slug, projectName }: { slug?: string; projectName?: string }) {
  const { user, userId, organization, isDevFallback } = useCurrentUser();
  // Any role, as long as there's a single real project to create into
  // (never in "all projects" mode, where slug is undefined) — this used to
  // require canManage(role) (Admin/Project Lead only), but the real
  // authorization boundary is the tickets_insert RLS policy itself
  // (is_org_admin_or_lead(...) OR is_project_member(project_id) — see
  // supabase/migrations/20260719000000_fix_tickets_insert_rls_admin_lead.sql),
  // which already allows a Member with a real project_memberships row on
  // this project. Excluding Member here was stale UI-only gating, not a
  // deliberate restriction.
  const canCreateTicket = Boolean(slug);
  // Stable storage/session key for the "all projects" mode, kept distinct
  // from any real project slug so it can never collide with one.
  const scopeKey = slug ?? "__all__";
  // Real query-state handoff from Project Overview's Health Alert action
  // (admin-project-overview.tsx) and Project Reports' Delivery Progress
  // cards (project-reports-screen.tsx) — carried in the URL itself, unlike
  // the sessionStorage-based presetTicketsFilter below, so it survives a
  // refresh or browser back/forward the same way Work History's own
  // `?page=` query param already does.
  const router = useRouter();
  const searchParams = useSearchParams();
  // Project filter — org-wide "all projects" mode only (see
  // availableProjects/selectedProjectSlug below); `?project=` is never read
  // in single-project mode, where the route's own `slug` already fixes it
  // and this filter isn't rendered at all.
  const projectParam = slug ? null : searchParams.get("project");
  const alertsParam = searchParams.get("alerts");
  // De-duplicated (a malformed `?alerts=blocked,blocked` must never apply
  // or display a filter twice) — the single source both the OR-filter below
  // and FilterBar's visible alert chips read from, so they can never drift
  // out of sync with each other.
  const alertTypes = useMemo(
    () => (alertsParam ? Array.from(new Set(alertsParam.split(",").filter(Boolean))) : []),
    [alertsParam]
  );
  // Removes just one alert type from the URL (never touches activeChips,
  // which stays the quick filters' own separate state) — same router.push
  // query-state convention Work History's own `?page=` Previous/Next
  // already uses, so this stays part of browser history like every other
  // real navigation here (back restores the removed chip).
  const removeAlertType = useCallback(
    (type: string) => {
      const remaining = alertTypes.filter((t) => t !== type);
      const params = new URLSearchParams(searchParams.toString());
      if (remaining.length > 0) params.set("alerts", remaining.join(","));
      else params.delete("alerts");
      const qs = params.toString();
      const basePath = slug ? `/projects/${slug}/tickets` : "/tickets";
      router.push(`${basePath}${qs ? `?${qs}` : ""}`);
    },
    [alertTypes, searchParams, router, slug]
  );
  const [showNewTicket, setShowNewTicket] = useState(false);
  // JIR-118 — "Import from JIRA" (project scope only, like New Ticket).
  const [showImportJira, setShowImportJira] = useState(false);
  // Read saved state once per mount (useMemo with [] deps).
  // We keep it in sessionStorage until useEffect clears it, so strict-mode
  // double-invocation doesn't lose it on the "real" render.
  const saved = useMemo(() => readSaved(scopeKey), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Dev-only fallback: no real organization membership — same mock array
  // used before this feature existed, just scoped to the current project
  // when there is one (real data is always scoped this way; see
  // loadProjectTickets), or every mock ticket in the org-wide "all
  // projects" mode (mirrors loadOrganizationTickets below). Never reached
  // once a real organization exists.
  const initialDevTickets = useMemo(
    () => (isDevFallback ? (slug ? MOCK_TICKETS.filter((t) => t.projectSlug === slug) : MOCK_TICKETS) : []),
    [isDevFallback, slug]
  );

  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(isDevFallback ? "ready" : "loading");
  const [loadErrorMessage, setLoadErrorMessage] = useState<string | null>(null);
  const [ticketList, setTicketList] = useState<Ticket[]>(initialDevTickets);
  // Real, ordered per-project ticket_statuses (Fase 2) — Board columns and
  // the Status filter are both built from these instead of the old fixed
  // 6-value enum. Single-project mode: this
  // project's own list. Org-wide "all projects" mode: keyed by slug, since a
  // drag-and-drop move must resolve its target status_id within that
  // ticket's own project, never a different project's row.
  const [statuses, setStatuses] = useState<TicketStatusOption[]>([]);
  const [statusesBySlug, setStatusesBySlug] = useState<Record<string, TicketStatusOption[]>>({});
  // Sprint MVP — real projects.id (single-project mode only), resolved once
  // by the same tickets fetch below (loadProjectTickets now also returns
  // it), and this project's own sprints. Both stay null/empty in org-wide
  // "all projects" mode, where the sprint selector/Manage Sprint action are
  // never rendered at all (sprints are inherently project-scoped).
  const [projectId, setProjectId] = useState<string | null>(null);
  // Real projects only — the import runs through a database function, so
  // there is nothing to offer in dev fallback or org-wide "all projects" mode.
  const canImportTickets = Boolean(slug) && projectId !== null && !isDevFallback;
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [showManageSprint, setShowManageSprint] = useState(false);
  // Real org members for the Assigned filter's dropdown options only — the
  // filter itself stays unwired (see FilterBar), this just replaces the
  // mock names it used to show. Dev fallback shows none, never mock names.
  const [members, setMembers] = useState<OrgMember[]>([]);
  // Real, project-scoped roster for New Ticket's own Assignee-picking UI —
  // deliberately separate from `members` above: only an active member of
  // *this* project can be assigned a
  // ticket in it, but the Assigned filter is intentionally left showing
  // every org member, unchanged (out of scope for this restriction).
  const [assignableMembers, setAssignableMembers] = useState<OrgMember[]>([]);
  // The Project filter's own dropdown options — org-wide "all projects"
  // mode only (see the effect below); stays empty in single-project mode,
  // where the filter itself is never rendered at all.
  const [availableProjects, setAvailableProjects] = useState<{ slug: string; name: string }[]>([]);
  // Real per-org label catalog — feeds the Labels filter's own options
  // (allLabelOptions below), same catalog/merge Ticket Detail uses.
  const [orgLabels, setOrgLabels] = useState<string[]>([]);
  const [view, setView] = useState<ViewMode>(saved?.view ?? getDefaultTicketView());
  // The view this project entry already has an explicit choice for, if any:
  // restored session state (back from a ticket, or another screen's
  // presetTicketsFilter hand-off) or the user's own click on the switcher.
  // Tagged with the project it belongs to, so it never carries over to a
  // different project.
  const explicitViewRef = useRef<{ slug: string | undefined; view: ViewMode } | null>(
    saved?.view ? { slug, view: saved.view } : null
  );
  // The project whose initial view was already decided (see runFetch) — a
  // background refresh must never decide it again.
  const initialViewSlugRef = useRef<string | null>(null);
  const selectView = useCallback(
    (next: ViewMode) => {
      explicitViewRef.current = { slug, view: next };
      setView(next);
    },
    [slug]
  );
  const [activeChips, setActiveChips] = useState<Set<string>>(
    () => new Set(saved?.activeChips ?? [])
  );
  // Sprint MVP — "all" | "backlog" | a real sprints.id, restricted to
  // single-project mode (see filteredTickets below). Restored from the same
  // per-project sessionStorage slot as view/activeChips/searchQuery when
  // present; when there's no saved preference yet, an effect below defaults
  // it to the project's active sprint once sprints finish loading (else
  // stays "all" so a project that hasn't adopted sprints keeps showing
  // everything — Board stays usable with no active sprint).
  const [sprintContext, setSprintContext] = useState<string>(saved?.sprintContext ?? SPRINT_CONTEXT_ALL);
  const hasAppliedDefaultSprintContextRef = useRef(Boolean(saved?.sprintContext));
  const [searchQuery, setSearchQuery] = useState(saved?.searchQuery ?? "");
  // Controlled here (not local to FilterBar) so they can be combined with
  // the quick-filter chips below in one shared filteredTickets — see
  // filter-bar.tsx's own comment on why these are now props, not state.
  // Seeded from `?assignee=` (same real-URL-state handoff `?alerts=`
  // already uses) so a dashboard KPI/report widget can deep-link straight
  // to one person's tickets with the existing Assigned filter already
  // applied and visible. Recognizes the literal sentinels "me" (matches
  // `isMine` below) and "unassigned" (matches `isUnassigned` below), or
  // any other value as a real `assigneeProfileId` — the exact same three
  // cases the filter's own apply logic further down already handles, so
  // this only widens what's accepted from the URL, never a second rule.
  const [assigned, setAssigned] = useState<string[]>(() => {
    const raw = searchParams.get("assignee");
    return raw ? [raw] : [];
  });
  const [priority, setPriority] = useState<string[]>([]);
  const [status,   setStatus]   = useState<string[]>([]);
  // "Add Filter" filters — activeAddFilters tracks which chips are showing
  // in the bar (added via the menu, removed by clearing their value back to
  // empty); the values themselves live in their own state so each one keeps
  // working even while the others are added/removed independently.
  const [activeAddFilters, setActiveAddFilters] = useState<Set<AddFilterKind>>(new Set());
  const [labelsFilter,       setLabelsFilter]       = useState<string[]>([]);
  const [reporterFilter,     setReporterFilter]     = useState<string[]>([]);
  const [dueDateFilter,      setDueDateFilter]      = useState<DateRangeValue>(EMPTY_DATE_RANGE);
  const [createdDateFilter,  setCreatedDateFilter]  = useState<DateRangeValue>(EMPTY_DATE_RANGE);
  const [updatedDateFilter,  setUpdatedDateFilter]  = useState<DateRangeValue>(EMPTY_DATE_RANGE);

  const requestIdRef = useRef(0);
  // Once the first real load has ever succeeded, a later background refresh
  // (tab focus/visibility regain) must never blank the screen back to the
  // skeleton or an error state — only the true first load ever shows those;
  // a failed background refresh just leaves the last real, valid ticket
  // list on screen instead. Same convention as users-screen.tsx's own
  // `hasLoadedRef`.
  const hasLoadedRef = useRef(false);
  // Collapses `organization`'s own focus-driven reference change (which
  // already changes `runFetch`'s identity, see its deps below, and so
  // re-fires the mount effect) and the explicit focus/visibilitychange
  // listener below firing together into a single real request — same
  // convention as users-screen.tsx's own `lastRunAtRef`.
  const lastRunAtRef = useRef(0);

  const runFetch = useCallback(() => {
    if (!organization) return;
    const now = Date.now();
    if (now - lastRunAtRef.current < 300) return;
    lastRunAtRef.current = now;
    const requestId = ++requestIdRef.current;
    if (!hasLoadedRef.current) setLoadState("loading");
    // Org-wide "all projects" mode (no slug) loads every project's tickets
    // via the same real, RLS-scoped org-wide loader the Dashboards/Reports
    // already use — never a second/parallel query.
    const result$ = slug ? loadProjectTickets(organization.id, slug) : loadOrganizationTickets(organization.id);
    result$.then((result) => {
      if (requestIdRef.current !== requestId) return;
      if (result.status === "ready") {
        hasLoadedRef.current = true;
        setTicketList(result.tickets);
        if ("statuses" in result) {
          setStatuses(result.statuses);
          setProjectId(result.projectId);
          // Initial view, decided once per project entry, in the same batch
          // that reveals the content: a Board with few columns opens on
          // List. Done here rather than in an effect on `statuses`/`view`
          // so nothing can re-apply it after the user picks Board.
          if (slug && initialViewSlugRef.current !== slug) {
            initialViewSlugRef.current = slug;
            const explicit = explicitViewRef.current;
            setView(
              resolveInitialTicketView<ViewMode>({
                explicitView: explicit && explicit.slug === slug ? explicit.view : null,
                defaultView: getDefaultTicketView(),
                boardColumnCount: countBoardColumns(result.statuses),
              })
            );
          }
        } else {
          setStatusesBySlug(result.statusesBySlug);
        }
        setLoadState("ready");
      } else if (result.status === "not-found") {
        hasLoadedRef.current = true;
        setTicketList([]);
        setLoadState("ready");
      } else if (!hasLoadedRef.current) {
        setLoadErrorMessage(result.message);
        setLoadState("error");
      }
    });
  }, [organization, slug]);

  useEffect(() => {
    if (isDevFallback) return; // handled synchronously above — no fetch needed
    runFetch();
  }, [isDevFallback, runFetch]);

  // Real refresh on window focus regain and tab-visibility regain — filters,
  // search, selected view, and navigation/session state below are all
  // independent React state untouched by runFetch, so they survive this
  // refresh unchanged; only the fetched ticketList (and everything derived
  // from it — filteredTickets, the Tickets/Estimated/Blocked counters, and
  // every view's own columns/counts) is refreshed. runFetch itself already
  // no-ops without a real `organization` (dev fallback), so no extra guard
  // is needed here.
  useRefreshOnFocusAndVisibility(runFetch);

  useEffect(() => {
    if (isDevFallback || !organization) return; // dev fallback: no mock members either
    loadOrganizationMembers(organization.id).then((result) => {
      if (result.status === "ready") setMembers(result.members);
    });
  }, [isDevFallback, organization]);

  useEffect(() => {
    // No single project to staff New Ticket's Assignee picker from in
    // "all projects" mode — New Ticket is already hidden there, so
    // `assignableMembers` simply stays empty rather than loading a roster
    // nothing will use.
    if (isDevFallback || !organization || !slug) return;
    loadProjectTeam(organization.id, slug).then((result) => {
      if (result.status === "ready") setAssignableMembers(result.members);
    });
  }, [isDevFallback, organization, slug]);

  useEffect(() => {
    if (isDevFallback || !organization) return;
    loadOrganizationLabels(organization.id).then((result) => {
      if (result.status === "ready") setOrgLabels(result.labels.map((l) => l.name));
    });
  }, [isDevFallback, organization]);

  // Sprint MVP — this project's own sprints (single-project mode only;
  // `projectId` is never set in org-wide "all projects" mode, see runFetch
  // above). Dev fallback has no real sprints table to query, so it just
  // stays empty (same "no real data" convention every other real loader in
  // this component follows in dev fallback).
  useEffect(() => {
    if (isDevFallback || !projectId) return;
    loadProjectSprints(projectId).then((result) => {
      if (result.status === "ready") setSprints(result.sprints);
    });
  }, [isDevFallback, projectId]);

  // Default the sprint context to the project's active sprint the first
  // time sprints load, but only when there's no saved preference already
  // (hasAppliedDefaultSprintContextRef starts true whenever `saved` already
  // carried one) — never overrides a user's own explicit choice, including
  // one made moments ago via Manage Sprint (activating/closing a sprint
  // reloads this same `sprints` list). No active sprint: stays "all", so a
  // project that hasn't adopted sprints yet keeps showing everything.
  useEffect(() => {
    if (hasAppliedDefaultSprintContextRef.current) return;
    if (sprints.length === 0) return;
    hasAppliedDefaultSprintContextRef.current = true;
    const active = sprints.find((s) => s.status === "active");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: a one-time default sync from just-loaded sprint data, guarded by the ref above so it only ever runs once and never overrides a later user choice
    if (active) setSprintContext(active.id);
  }, [sprints]);

  // Project filter options — org-wide "all projects" mode only (the
  // per-project Tickets page never renders this filter, so there's nothing
  // to load there). Scoped per the same real permission rule each role's
  // own "current project" picker elsewhere in this app already uses:
  // Admin sees every active org project (loadOrganizationProjects, RLS
  // already returns everything for an admin); Project Lead only projects
  // where they hold `project_memberships.project_role = 'lead'`
  // (loadLeadProjects — the exact same query the Project Lead Dashboard's
  // own Current Project selector uses); Member only projects with any real
  // active membership (loadMemberProjects — same as the Member Dashboard's
  // own project scope selector).
  useEffect(() => {
    if (isDevFallback || !organization || slug) return;
    if (user.role === "PROJECT_LEAD") {
      if (!userId) return;
      loadLeadProjects(organization.id, userId).then((result) => {
        if (result.status === "ready") setAvailableProjects(result.projects.map((p) => ({ slug: p.slug, name: p.name })));
      });
    } else if (user.role === "MEMBER") {
      if (!userId) return;
      loadMemberProjects(organization.id, userId).then((result) => {
        if (result.status === "ready") setAvailableProjects(result.projects.map((p) => ({ slug: p.slug, name: p.name })));
      });
    } else {
      loadOrganizationProjects(organization.id).then((result) => {
        if (result.status === "ready") {
          setAvailableProjects(
            result.projects.filter((p) => p.status === "active").map((p) => ({ slug: p.slug, name: p.name }))
          );
        }
      });
    }
  }, [isDevFallback, organization, slug, user.role, userId]);

  // Validated against the real, permission-scoped options list — same
  // "ignore a stale/inaccessible slug, fall back to unset" precedent the
  // Admin/Project Lead/Member Dashboards' own `?project=` scope selectors
  // already use (dashboard-screen.tsx's selectedProjectSlug), rather than
  // trusting the URL param as-is.
  const selectedProjectSlug = useMemo(
    () => (projectParam && availableProjects.some((p) => p.slug === projectParam) ? projectParam : null),
    [projectParam, availableProjects]
  );
  const projectFilter = useMemo(() => (selectedProjectSlug ? [selectedProjectSlug] : []), [selectedProjectSlug]);
  // The Board's own column source (Fase 2.5). Single-project mode: this
  // project's real statuses. Org-wide "all projects" mode: the union, by
  // name, of every loaded project's own real statuses — never assumes two
  // projects share the same list. A status name shared by several
  // projects collapses into one column (today, every project happens to
  // share the same 6 names, so this produces the exact same result as
  // before); a name unique to one project gets its own column. First
  // occurrence wins for display order (sort_order can differ slightly
  // between projects only once real per-project customization exists).
  const boardColumnStatuses = useMemo(() => {
    if (slug) return statuses;
    const byName = new Map<string, TicketStatusOption>();
    for (const list of Object.values(statusesBySlug)) {
      for (const option of list) {
        if (!byName.has(option.name)) byName.set(option.name, option);
      }
    }
    const merged = Array.from(byName.values()).sort((a, b) => a.sortOrder - b.sortOrder);
    return merged.length > 0 ? merged : FALLBACK_TICKET_STATUSES;
  }, [slug, statuses, statusesBySlug]);
  const onProjectChange = useCallback(
    (values: string[]) => {
      const params = new URLSearchParams(searchParams.toString());
      if (values.length > 0) params.set("project", values[0]);
      else params.delete("project");
      const qs = params.toString();
      router.push(`/tickets${qs ? `?${qs}` : ""}`);
    },
    [searchParams, router]
  );

  // Clear sessionStorage and restore scroll after first render
  useEffect(() => {
    const raw = sessionStorage.getItem(sessionKey(scopeKey));
    if (raw) {
      sessionStorage.removeItem(sessionKey(scopeKey));
      try {
        const state = JSON.parse(raw) as SavedState;
        if (state.scrollTop) {
          const main = document.querySelector("main");
          if (main) main.scrollTop = state.scrollTop;
        }
      } catch {}
    }
  }, [scopeKey]);

  function toggleChip(label: string) {
    setActiveChips((prev) => {
      const next = new Set(prev);
      next.has(label) ? next.delete(label) : next.add(label);
      return next;
    });
  }

  function handleAddFilter(kind: AddFilterKind) {
    setActiveAddFilters((prev) => new Set(prev).add(kind));
  }

  // Clearing a filter's value back to empty removes its chip from the bar
  // (returns it to the "Add Filter" menu) — same "clear = gone" convention
  // as the date-range popover's own comment.
  function removeAddFilter(kind: AddFilterKind) {
    setActiveAddFilters((prev) => {
      const next = new Set(prev);
      next.delete(kind);
      return next;
    });
  }

  function handleLabelsChange(values: string[]) {
    setLabelsFilter(values);
    if (values.length === 0) removeAddFilter("labels");
  }

  function handleReporterChange(values: string[]) {
    setReporterFilter(values);
    if (values.length === 0) removeAddFilter("reporter");
  }

  function handleDueDateRangeChange(value: DateRangeValue) {
    setDueDateFilter(value);
    if (!value.from && !value.to) removeAddFilter("due-date");
  }

  function handleCreatedDateRangeChange(value: DateRangeValue) {
    setCreatedDateFilter(value);
    if (!value.from && !value.to) removeAddFilter("created-date");
  }

  function handleUpdatedDateRangeChange(value: DateRangeValue) {
    setUpdatedDateFilter(value);
    if (!value.from && !value.to) removeAddFilter("updated-date");
  }

  // Board's own Parent/Child indicators (see ticket-card.tsx's
  // TicketBoardCard) — built once from `ticketList`, the full unfiltered
  // list this screen already loads, so a status/assignee/search filter
  // hiding some of a parent's children never undercounts `↳ N`. Every
  // Ticket already carries parentTicketId (lib/tickets.ts's TICKET_COLUMNS),
  // so this is a single O(n) pass over already-loaded data — no extra
  // query, no N+1 per card.
  const childrenCountById = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of ticketList) {
      if (t.parentTicketId) m.set(t.parentTicketId, (m.get(t.parentTicketId) ?? 0) + 1);
    }
    return m;
  }, [ticketList]);

  const ticketCodeById = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of ticketList) m.set(t.id, getTicketDisplayKey(t));
    return m;
  }, [ticketList]);

  // The single place every filter (search, the 3 dropdowns, the 5 "Add
  // Filter" filters, and the 5 quick chips) is actually applied — every view
  // below (Board/List/Calendar/Timeline/Insights) and the header's Tickets/
  // Estimated/Blocked counters all read from this one filtered list, so none
  // of them can drift out of sync or need their own copy of this logic.
  const filteredTickets = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    // "Mine"/"Unassigned" match the real assignee_profile_id, not the
    // display name (a name isn't a stable identifier — see
    // Ticket.assigneeProfileId). Dev fallback has no real ids to compare
    // (mock tickets never carry assigneeProfileId), so it falls back to
    // matching by name there only, same convention used elsewhere in dev
    // fallback (e.g. member-profile-modal.tsx).
    const isMine = (t: Ticket) =>
      isDevFallback ? t.assignee.name === user.name : userId !== null && t.assigneeProfileId === userId;
    const isUnassigned = (t: Ticket) =>
      isDevFallback ? t.assignee.name === "Unassigned" : t.assigneeProfileId == null;

    // Due Soon: active tickets due from today through the next 7 days,
    // never overdue — no existing reusable "due soon" definition applies to
    // real (non-mock-dated) tickets, see my-work-screen.tsx's isDueSoon,
    // which is pinned to a hardcoded mock "today" and isn't safe to reuse
    // for real dates.
    const todayISO = getTodayISO();
    const dueSoonCutoffISO = getTodayISO(7);
    const isDueSoon = (t: Ticket) => {
      if (isTicketClosed(t) || !t.dueDate) return false;
      const dueISO = parseDisplayDate(t.dueDate);
      if (!dueISO) return false;
      return dueISO >= todayISO && dueISO <= dueSoonCutoffISO;
    };

    // Recently Updated: real updatedAtISO within the last 7 days. Undefined
    // for mock tickets (no real timestamp exists), so this never matches in
    // dev fallback.
    const nowMs = new Date().getTime();
    const isRecentlyUpdated = (t: Ticket) => {
      if (!t.updatedAtISO) return false;
      const diffMs = nowMs - new Date(t.updatedAtISO).getTime();
      return diffMs >= 0 && diffMs <= 7 * 24 * 60 * 60 * 1000;
    };

    // Overdue — same real definition Project Overview's own Health Alerts
    // already use (not closed, a real due date, in the past).
    const isOverdue = (t: Ticket) => !isTicketClosed(t) && Boolean(t.dueDate) && parseDisplayDate(t.dueDate!) < todayISO;

    // Due Today — the exact same real definition the Admin Dashboard's own
    // "Due Today" KPI already uses (a real due date equal to today, no
    // status exclusion — unlike the "Due Soon" quick filter above, which
    // excludes done tickets and covers a 7-day window instead of one day).
    // Same todayISO/parseDisplayDate, never a second/different "today".
    const isDueToday = (t: Ticket) => Boolean(t.dueDate) && parseDisplayDate(t.dueDate!) === todayISO;

    // Completed This Month — the exact same real definition the Admin
    // Dashboard's own "tickets completed this month" health insight already
    // uses (status done, real updatedAtISO in the current calendar month —
    // the closest available signal for "when it was completed," since no
    // dedicated completed_at column exists). Same todayISO, never a
    // second/different "this month".
    const monthPrefix = todayISO.slice(0, 7);
    const isCompletedThisMonth = (t: Ticket) => isTicketClosed(t) && t.updatedAtISO?.slice(0, 7) === monthPrefix;

    // Due This Week — the exact same real Monday–Sunday "this week"
    // convention already established by Projects/My Work/Member Dashboard/
    // the Project Lead's own Reports "Due This Week" KPI, never a second/
    // different definition of "this week". Same non-done + real due date
    // requirement as Overdue/Due Today above.
    const weekDay = new Date(`${todayISO}T00:00:00`).getDay();
    const weekMonday = new Date(`${todayISO}T00:00:00`);
    weekMonday.setDate(weekMonday.getDate() + (weekDay === 0 ? -6 : 1 - weekDay));
    const weekSunday = new Date(weekMonday);
    weekSunday.setDate(weekMonday.getDate() + 6);
    const toWeekBoundISO = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const weekStartISO = toWeekBoundISO(weekMonday);
    const weekEndISO = toWeekBoundISO(weekSunday);
    const isDueThisWeek = (t: Ticket) => {
      if (isTicketClosed(t) || !t.dueDate) return false;
      const dueISO = parseDisplayDate(t.dueDate);
      return Boolean(dueISO) && dueISO >= weekStartISO && dueISO <= weekEndISO;
    };

    // Local calendar date (not UTC — same reasoning as getTodayISO) behind a
    // full timestamp, so Created/Updated Date ranges compare day-to-day like
    // the date-only inputs that set them, not exact instants.
    const toLocalDateISO = (iso: string): string => {
      const d = new Date(iso);
      const month = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${d.getFullYear()}-${month}-${day}`;
    };
    const inDateRange = (dateISO: string | undefined, range: DateRangeValue): boolean => {
      if (!dateISO) return false;
      if (range.from && dateISO < range.from) return false;
      if (range.to && dateISO > range.to) return false;
      return true;
    };
    const hasDueDateFilter     = Boolean(dueDateFilter.from || dueDateFilter.to);
    const hasCreatedDateFilter = Boolean(createdDateFilter.from || createdDateFilter.to);
    const hasUpdatedDateFilter = Boolean(updatedDateFilter.from || updatedDateFilter.to);

    return ticketList.filter((t) => {
      if (query) {
        const matchesText =
          t.title.toLowerCase().includes(query) || getTicketDisplayKey(t).toLowerCase().includes(query);
        if (!matchesText) return false;
      }

      // Project — org-wide "all projects" mode only; selectedProjectSlug is
      // always null in single-project mode, so this is a no-op there.
      if (selectedProjectSlug && t.projectSlug !== selectedProjectSlug) return false;

      // Sprint context — single-project mode only (org-wide "all projects"
      // has no single sprint concept; the selector itself is never rendered
      // there, so sprintContext always stays "all" in that mode anyway).
      if (slug && sprintContext !== SPRINT_CONTEXT_ALL) {
        if (sprintContext === SPRINT_CONTEXT_BACKLOG) {
          if (t.sprintId) return false;
        } else if (t.sprintId !== sprintContext) {
          return false;
        }
      }

      if (assigned.length > 0) {
        const value = assigned[0];
        if (value === "me") {
          if (!isMine(t)) return false;
        } else if (value === "unassigned") {
          if (!isUnassigned(t)) return false;
        } else if (t.assigneeProfileId !== value) {
          return false;
        }
      }

      if (priority.length > 0 && !priority.includes(t.priority)) return false;
      // Matched by real status name (Fase 3), never the legacy 6-value
      // domain — a custom, non-legacy status has no TicketStatus
      // equivalent at all, so `t.status` alone can't represent it.
      if (status.length > 0 && !status.includes(ticketColumnKey(t) ?? "")) return false;

      // "Add Filter" filters.
      // Labels: matches if the ticket has at least one of the selected
      // labels (OR within this filter — labels are multi-valued per
      // ticket, same convention as Priority/Status's own multi-select).
      if (labelsFilter.length > 0 && !labelsFilter.some((l) => t.labels.includes(l))) return false;
      // Reporter: who created the ticket, by real id — never the display name.
      if (reporterFilter.length > 0 && !reporterFilter.includes(t.createdByProfileId ?? "")) return false;
      if (hasDueDateFilter) {
        const dueISO = t.dueDate ? parseDisplayDate(t.dueDate) : "";
        if (!inDateRange(dueISO || undefined, dueDateFilter)) return false;
      }
      if (hasCreatedDateFilter && !inDateRange(t.createdAtISO ? toLocalDateISO(t.createdAtISO) : undefined, createdDateFilter)) return false;
      if (hasUpdatedDateFilter && !inDateRange(t.updatedAtISO ? toLocalDateISO(t.updatedAtISO) : undefined, updatedDateFilter)) return false;

      // Quick filter chips — every active one must match (AND).
      if (activeChips.has("Mine") && !isMine(t)) return false;
      if (activeChips.has("Blocked") && t.status !== "blocked") return false;
      if (activeChips.has("High Priority") && t.priority !== "highest" && t.priority !== "high") return false;
      if (activeChips.has("Due Soon") && !isDueSoon(t)) return false;
      if (activeChips.has("Recently Updated") && !isRecentlyUpdated(t)) return false;

      // Real URL query-state handoff (`?alerts=overdue,blocked`, etc.) from
      // both Project Overview's Health Alert action and Project Reports'
      // Delivery Progress cards — a ticket matches if it satisfies ANY of
      // the requested types (OR between types), still ANDed with
      // everything else above like every other filter here; in practice
      // nothing else is active when arriving from either link. "done"/
      // "in-progress"/"blocked" are the same canonical ticket statuses
      // used everywhere else in this app, never a parallel value.
      if (alertTypes.length > 0) {
        const matchesAlert = alertTypes.some((type) =>
          type === "overdue" ? isOverdue(t) :
          type === "due-today" ? isDueToday(t) :
          type === "completed-this-month" ? isCompletedThisMonth(t) :
          type === "due-this-week" ? isDueThisWeek(t) :
          t.status === type
        );
        if (!matchesAlert) return false;
      }

      return true;
    });
  }, [
    ticketList, searchQuery, assigned, priority, status, activeChips, isDevFallback, user.name, userId,
    labelsFilter, reporterFilter, dueDateFilter, createdDateFilter, updatedDateFilter, alertTypes,
    selectedProjectSlug, slug, sprintContext,
  ]);

  // A ticket click now navigates straight to its own Detail page — no more
  // intermediate Preview step. Saves this screen's own view/filters/scroll
  // to sessionStorage first (the same state Expand used to save right
  // before navigating), so returning (Back / "Back to Tickets") restores
  // exactly where the user left off, same as before.
  function openTicket(ticket: Ticket) {
    const main = document.querySelector("main");
    saveState(scopeKey, {
      view,
      activeChips: [...activeChips],
      searchQuery,
      scrollTop: main?.scrollTop ?? 0,
      sprintContext,
    });
    router.push(`/projects/${ticket.projectSlug}/tickets/${getTicketDisplayKey(ticket)}`);
  }

  function handleTicketCreated(ticket: Ticket) {
    setTicketList((prev) => [ticket, ...prev]);
    setShowNewTicket(false);
    openTicket(ticket);
  }

  function handlePreviewDuplicate(ticket: Ticket) {
    setShowNewTicket(false);
    openTicket(ticket);
  }

  // Keeps this screen's own ticket list in sync after a real write made
  // elsewhere (currently only Board drag-and-drop, below) without a full
  // page reload.
  function handleTicketUpdated(updated: Ticket) {
    setTicketList((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
  }

  // Board's drag-and-drop status change — the exact same updateTicket()
  // action Ticket Detail's own status editor already uses, so permissions/
  // RLS and the Activity Log trigger it fires are identical, never a second
  // path. Uses ticket.projectSlug rather than this screen's own `slug`, since
  // this screen can also show every project's tickets at once (no `slug`
  // at all, e.g. a cross-project queue) — each ticket still knows its own.
  //
  // `nextStatusName` (Fase 2.5) is the dropped-on column's real
  // ticket_statuses.name — resolved back to a real status_id within THIS
  // ticket's own project (never assumed to share an id, or even a legacy
  // enum value, with whatever other project's status the merged column
  // happened to be built from). If this ticket's own project has no
  // status by that exact name (two projects with genuinely different
  // configurations), the move is rejected with a clear message instead of
  // silently landing on the wrong status or corrupting the ticket.
  async function handleBoardMoveTicket(
    ticket: Ticket,
    nextStatusName: string
  ): Promise<{ success: boolean; message?: string }> {
    const projectStatuses = slug ? statuses : statusesBySlug[ticket.projectSlug];
    const options = projectStatuses && projectStatuses.length > 0 ? projectStatuses : FALLBACK_TICKET_STATUSES;
    const target = options.find((option) => option.name === nextStatusName);
    if (!target) {
      return { success: false, message: "This status isn't available for that ticket's project." };
    }
    if (isDevFallback) {
      const nextStatus = target.legacyEnumValue ? STATUS_FROM_DB[target.legacyEnumValue] ?? ticket.status : ticket.status;
      handleTicketUpdated({
        ...ticket,
        status: nextStatus,
        statusId: target.id,
        statusName: target.name,
        statusGroupType: target.groupType,
      });
      return { success: true };
    }
    const result = await updateTicket(ticket.id, ticket.projectSlug, { statusId: target.id });
    if (result.status === "error") {
      return { success: false, message: result.message };
    }
    handleTicketUpdated(result.ticket);
    return { success: true };
  }

  if (loadState === "loading") {
    return <TicketsScreenSkeleton showNewTicketButton={canCreateTicket} />;
  }

  if (loadState === "error") {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-4">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-zinc-200">Couldn&apos;t load tickets</h3>
        <p className="text-sm text-slate-400 mt-1 max-w-xs dark:text-zinc-500">
          {loadErrorMessage ?? "Something went wrong."}
        </p>
        <button
          type="button"
          onClick={runFetch}
          className="mt-5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg px-3.5 py-2 shadow-sm shadow-brand-600/20 transition-colors dark:bg-brand-accent dark:text-brand-accent-foreground dark:hover:bg-brand-accent-strong dark:focus-visible:outline-2 dark:focus-visible:outline-offset-2 dark:focus-visible:outline-brand-accent dark:shadow-brand-accent/20"
        >
          Retry
        </button>
      </div>
    );
  }

  // Computed once for the Labels filter (FilterBar).
  const allLabelOptions = buildLabelCatalog(orgLabels);

  return (
    <div className="h-full flex flex-col">
      {/* Page header */}
      <div className="flex-shrink-0 px-4 sm:px-6 pt-4 sm:pt-5 pb-0">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4 mb-3 sm:mb-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-zinc-50 tracking-tight leading-none">
              Tickets
            </h1>
            <p className="text-sm text-slate-500 dark:text-zinc-400 mt-1">
              {slug ? "Track and manage all work items for this project." : "Track and manage all work items across every project."}
            </p>
          </div>

          {/* Desktop: Tabs + New Ticket grouped together on the right, exactly
              as before. Mobile hides this copy — see the stacked mobile-only
              block below, which reorders New Ticket above the view tabs and
              gives the tabs their own horizontally-scrollable row instead. */}
          <div className="hidden sm:flex items-center gap-3 flex-shrink-0 mt-0.5">
            <ViewSwitcher view={view} onChange={selectView} />
            {slug && projectId && (
              <SprintContextSelector
                sprints={sprints}
                value={sprintContext}
                onChange={setSprintContext}
                canManage={user.role !== "MEMBER"}
                onManage={() => setShowManageSprint(true)}
              />
            )}
            {canImportTickets && (
              <button
                type="button"
                onClick={() => setShowImportJira(true)}
                className="text-sm font-medium text-slate-600 hover:text-slate-900 border border-slate-200 hover:bg-slate-50 rounded-lg px-3 py-2 transition-colors dark:text-zinc-300 dark:hover:text-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                Import from JIRA
              </button>
            )}
            {canCreateTicket && (
              <button
                type="button"
                onClick={() => setShowNewTicket(true)}
                className="text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg px-4 py-2 shadow-sm shadow-brand-600/20 transition-colors dark:bg-brand-accent dark:text-brand-accent-foreground dark:hover:bg-brand-accent-strong dark:focus-visible:outline-2 dark:focus-visible:outline-offset-2 dark:focus-visible:outline-brand-accent dark:shadow-brand-accent/20 whitespace-nowrap"
              >
                + New Ticket
              </button>
            )}
          </div>
        </div>

        <div className="flex sm:hidden flex-col gap-3 mb-3">
          {canCreateTicket && (
            <div className="flex justify-end gap-2">
              {canImportTickets && (
                <button
                  type="button"
                  onClick={() => setShowImportJira(true)}
                  className="text-sm font-medium text-slate-600 hover:text-slate-900 border border-slate-200 hover:bg-slate-50 rounded-lg px-3 py-2 transition-colors dark:text-zinc-300 dark:hover:text-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  Import from JIRA
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowNewTicket(true)}
                className="text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg px-4 py-2 shadow-sm shadow-brand-600/20 transition-colors dark:bg-brand-accent dark:text-brand-accent-foreground dark:hover:bg-brand-accent-strong dark:focus-visible:outline-2 dark:focus-visible:outline-offset-2 dark:focus-visible:outline-brand-accent dark:shadow-brand-accent/20 whitespace-nowrap"
              >
                + New Ticket
              </button>
            </div>
          )}
          <div className="overflow-x-auto flex items-center gap-3">
            <ViewSwitcher view={view} onChange={selectView} />
            {slug && projectId && (
              <SprintContextSelector
                sprints={sprints}
                value={sprintContext}
                onChange={setSprintContext}
                canManage={user.role !== "MEMBER"}
                onManage={() => setShowManageSprint(true)}
              />
            )}
          </div>
        </div>

        <FilterBar
          activeChips={activeChips}
          onToggleChip={toggleChip}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          showProjectFilter={!slug}
          projects={availableProjects}
          project={projectFilter}
          onProjectChange={onProjectChange}
          members={members}
          assigned={assigned}
          onAssignedChange={setAssigned}
          priority={priority}
          onPriorityChange={setPriority}
          status={status}
          onStatusChange={setStatus}
          statuses={boardColumnStatuses}
          activeAddFilters={activeAddFilters}
          onAddFilter={handleAddFilter}
          allLabels={allLabelOptions}
          labels={labelsFilter}
          onLabelsChange={handleLabelsChange}
          reporter={reporterFilter}
          onReporterChange={handleReporterChange}
          dueDateRange={dueDateFilter}
          onDueDateRangeChange={handleDueDateRangeChange}
          createdDateRange={createdDateFilter}
          onCreatedDateRangeChange={handleCreatedDateRangeChange}
          updatedDateRange={updatedDateFilter}
          onUpdatedDateRangeChange={handleUpdatedDateRangeChange}
          alertChipTypes={alertTypes}
          onRemoveAlertChip={removeAlertType}
        />

        {/* Quick stats — recalculated from the filtered results, same as every view below */}
        <div className="flex items-center gap-1.5 mt-3 text-xs text-slate-500 dark:text-zinc-500">
          <span className="font-semibold text-slate-700 dark:text-zinc-300">{filteredTickets.length}</span>
          <span>Tickets</span>
          <span className="mx-1 text-slate-200 dark:text-zinc-700">·</span>
          <span className="font-semibold text-slate-700 dark:text-zinc-300">
            {formatHours(filteredTickets.reduce((s, t) => s + (t.hours ?? 0), 0))}
          </span>
          <span>Estimated</span>
          <span className="mx-1 text-slate-200 dark:text-zinc-700">·</span>
          <span className="font-semibold text-red-600 dark:text-red-400">
            {filteredTickets.filter((t) => t.status === "blocked").length}
          </span>
          <span>Blocked</span>
        </div>

        <div className="mt-3 border-b border-slate-200 dark:border-zinc-800" />
      </div>

      {/* Content area — every view reads the same filteredTickets, so Board/List/Calendar/Timeline/Insights always agree.
          A ticket click navigates straight to its own Detail page (openTicket, above) — no intermediate Preview step. */}
      {view === "board" ? (
        <BoardView
          tickets={filteredTickets}
          onTicketClick={openTicket}
          dragAndDrop={{ onMoveTicket: handleBoardMoveTicket }}
          statuses={boardColumnStatuses}
          hierarchy={{ childrenCountById, ticketCodeById }}
        />
      ) : view === "calendar" ? (
        <CalendarView tickets={filteredTickets} onTicketClick={openTicket} />
      ) : view === "timeline" ? (
        <TimelineView tickets={filteredTickets} onTicketClick={openTicket} />
      ) : view === "insights" ? (
        <InsightsView tickets={filteredTickets} onTicketClick={openTicket} />
      ) : (
        <ListView tickets={filteredTickets} onTicketClick={openTicket} hierarchy={{ childrenCountById, ticketCodeById }} />
      )}

      {/* No single project to create into in "all projects" mode — the
          button above is already hidden there (canCreateTicket requires
          slug), this guard just keeps the type honest. */}
      {showNewTicket && slug && (
        <NewTicketModal
          slug={slug}
          tickets={ticketList}
          members={assignableMembers}
          onClose={() => setShowNewTicket(false)}
          onCreated={handleTicketCreated}
          onPreviewDuplicate={handlePreviewDuplicate}
          statuses={statuses}
          sprints={sprints}
          initialSprintId={sprintContext !== SPRINT_CONTEXT_ALL && sprintContext !== SPRINT_CONTEXT_BACKLOG ? sprintContext : null}
        />
      )}

      {showImportJira && projectId && (
        <ImportJiraModal
          projectId={projectId}
          statuses={statuses}
          onClose={() => setShowImportJira(false)}
          onImported={runFetch}
        />
      )}

      {showManageSprint && slug && projectId && (
        <ManageSprintModal
          slug={slug}
          projectId={projectId}
          tickets={ticketList}
          sprints={sprints}
          statuses={statuses}
          initialSprintId={sprintContext !== SPRINT_CONTEXT_ALL && sprintContext !== SPRINT_CONTEXT_BACKLOG ? sprintContext : null}
          onClose={() => setShowManageSprint(false)}
          onSprintsChange={setSprints}
          onTicketChange={handleTicketUpdated}
        />
      )}
    </div>
  );
}
