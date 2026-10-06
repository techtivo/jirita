"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { ProjectHealth } from "@/lib/mock-projects";
import type { TeamMember } from "@/lib/mock-team";
import { utilizationOf, capacityBarColor, capacityTextColor, remainingAvailabilityLabel } from "@/components/member-profile-modal";
import { formatHours, round1 } from "@/components/time-tracking-screen";
import { MemberTrigger, useMemberProfile } from "@/components/member-profile";
import { Avatar } from "@/components/ui/avatar";
import { StatusBadge, HealthBadge } from "@/components/status-badge";
import { ReportStatusBar, Section, KpiCard, BlockCompletion, AnimatedBar } from "@/components/reports-shared";
import type { StatusItem } from "@/components/reports-shared";
import { SkeletonBlock } from "@/components/dashboard-shared";
import { FilterDropdown } from "@/components/tickets/filter-dropdown";
import type { DropdownGroup } from "@/components/tickets/filter-dropdown";
import { FilterChip } from "@/components/tickets/filter-chip";
import { getTicketDisplayKey } from "@/lib/mock-tickets";
import type { Ticket, TicketStatus } from "@/lib/mock-tickets";
import {
  TicketTypeIcon,
  getTodayISO,
  parseDisplayDate,
  STATUS_LABEL,
  PRIORITY_LABEL,
  PRIORITY_VALUES,
  StatusBadge as TicketStatusBadge,
  PriorityBadge,
} from "@/components/tickets/ticket-ui";
import { useCurrentUser } from "@/components/current-user-provider";
import { useOrganizationProjects } from "@/components/organization-projects-provider";
import { loadOrganizationTickets, isTicketClosed } from "@/lib/tickets";
import type { OrganizationTimeEntry } from "@/lib/tickets";
import { loadLeadProjects, loadProjectTeam } from "@/lib/projects";
import { buildLeadTimeTrackingProjectOptions, slugsWithAccess, countsTowardWorkload, inPersonBreakdown } from "@/lib/time-tracking-scope";
import { loadScopedTimeEntries } from "@/lib/scoped-time-entries";
import { ROLE_LABELS } from "@/lib/current-user";
import type { ProjectTeamMember, OrgWorkloadMember } from "@/lib/projects";
import {
  buildProjectHealthRows,
  computeProjectProgressPct,
  buildTicketsByMember,
  PeriodSelector,
  defaultCustomRange,
  realRangeForPeriod,
  HoursReportEntryCard,
} from "@/components/reports-screen";
import type { Risk, PeriodKey, CustomRange } from "@/components/reports-screen";

// ── Delivery tab (real) ──────────────────────────────────────────────────────
//
// Every number on this tab, plus the 6 top KPIs shared with the Team tab
// below it, is now real Supabase data, scoped to this profile's own
// projects (`useOrganizationProjects()` — the same real, RLS-scoped
// "staffed on" list Projects' own Project Lead view already reads, so "My
// Projects" here can never disagree with that screen). Reuses
// buildProjectHealthRows/computeProjectProgressPct (reports-screen.tsx,
// already exported and reused the same way by Projects/Dashboard) rather
// than a second definition of Health/Progress/Risk.
//
// The Team tab further down (Hours by Person, Workload, Blocked Work by
// Member, Team Health) is also real now — see teamStats below — and reuses
// the exact same per-member capacity/utilization functions Team itself
// uses (member-profile-modal.tsx), never a second formula.

const RISK_TO_HEALTH: Record<Risk, ProjectHealth> = {
  "on-track": "healthy",
  "at-risk": "needs-attention",
  blocked: "critical",
};

// Real page-header date — "Weekday, Month Day, Year", same real
// getTodayISO()-based convention (and toLocaleDateString pattern) Admin
// Reports' own header already uses, duplicated here as page-local glue
// rather than importing a non-exported helper from that file.
function formatHeaderDate(todayISO: string): string {
  return new Date(`${todayISO}T00:00:00`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

// Monday–Sunday containing todayISO — same "This Week" convention already
// used by Projects/My Work/Member Dashboard, duplicated here as page-local
// glue (same precedent as those screens), never a second/different
// definition of "this week".
function getWeekRangeISO(todayISO: string): { start: string; end: string } {
  const today = new Date(`${todayISO}T00:00:00`);
  const day = today.getDay();
  const monday = new Date(today);
  monday.setDate(today.getDate() + (day === 0 ? -6 : 1 - day));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const toISO = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { start: toISO(monday), end: toISO(sunday) };
}

// ── Team tab (real) ──────────────────────────────────────────────────────────
//
// Now backed by the exact same real per-member data (teamStats, computed
// once in the main component below from loadProjectTeam/real tickets) the
// Team Capacity KPI and the top KPI strip already use — never a second
// roster or a parallel utilization/over-capacity rule.

interface RealTeamMemberStat {
  id: string;
  name: string;
  avatar: string;
  role: string;
  /** Every one of the Lead's own real projects this member is staffed on —
   *  used to scope the Member Profile Modal precisely (only when this
   *  resolves to exactly one project) and to decide the Team Capacity KPI's
   *  own navigation target (a single common project vs. Reports > Team). */
  projectSlugs: string[];
  weeklyCapacity: number;
  assignedHours: number;
  blockedHours: number;
  isOverCapacity: boolean;
}

// Reuses Team's own real per-member capacity functions (utilizationOf/
// capacityBarColor/capacityTextColor/remainingAvailabilityLabel, all from
// member-profile-modal.tsx) — they only ever read weeklyCapacity/
// assignedHours, so a real per-member stat can stand in for the full
// TeamMember shape those functions expect without a second formula.
function toTeamMemberShape(member: RealTeamMemberStat): TeamMember {
  return {
    id: member.id,
    projectSlug: member.projectSlugs[0] ?? "",
    name: member.name,
    role: member.role,
    email: "",
    avatar: member.avatar,
    status: "Available",
    weeklyCapacity: member.weeklyCapacity,
    assignedHours: member.assignedHours,
    activeTicketIds: [],
  };
}

// Reuses the exact same 3-tier vocabulary/badge as project health, so a
// member's status reads the same way a project's does — same thresholds
// this screen already established, now fed real utilization/blocked hours
// instead of a mock lookup.
function healthOfReal(utilizationPct: number, blockedHours: number): ProjectHealth {
  if (utilizationPct > 100) return "critical";
  if (utilizationPct >= 90 || blockedHours >= 6) return "needs-attention";
  return "healthy";
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

type ReportTab = "delivery" | "team";

const REPORT_TABS: { key: ReportTab; label: string }[] = [
  { key: "delivery", label: "Delivery" },
  { key: "team", label: "Team" },
];

function ReportTabs({ tab, onChange }: { tab: ReportTab; onChange: (t: ReportTab) => void }) {
  return (
    <div className="inline-flex items-center bg-slate-100 dark:bg-zinc-800/80 rounded-lg p-0.5 gap-0.5">
      {REPORT_TABS.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onChange(t.key)}
          className={[
            "px-3.5 py-1.5 rounded-[7px] text-sm font-medium transition-all duration-150",
            tab === t.key
              ? "bg-white dark:bg-zinc-900 text-slate-900 dark:text-zinc-50 shadow-sm shadow-slate-200/80 dark:shadow-black/40"
              : "text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-200",
          ].join(" ")}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────────

const ProjectIcon = (
  <svg className="w-3.5 h-3.5 text-slate-400 dark:text-zinc-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
    <path d="M3 7l4-4h6l4 4" />
    <rect x="3" y="7" width="18" height="13" rx="2" />
  </svg>
);
const ClockIcon = (
  <svg className="w-3.5 h-3.5 text-slate-400 dark:text-zinc-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="10" />
    <path d="M12 6v6l4 2" />
  </svg>
);
const PersonIcon = (
  <svg className="w-3.5 h-3.5 text-slate-400 dark:text-zinc-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
  </svg>
);
const PeopleIcon = (
  <svg className="w-3.5 h-3.5 text-slate-400 dark:text-zinc-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
    <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
  </svg>
);
const BarsIcon = (
  <svg className="w-3.5 h-3.5 text-slate-400 dark:text-zinc-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
    <path d="M3 6h18M3 12h14M3 18h8" />
  </svg>
);
const BlockedIcon = (
  <svg className="w-3.5 h-3.5 text-slate-400 dark:text-zinc-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
  </svg>
);
const PulseIcon = (
  <svg className="w-3.5 h-3.5 text-slate-400 dark:text-zinc-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 12h4l2-5 4 10 2-5h6" />
  </svg>
);

// ── Loading skeleton ──────────────────────────────────────────────────────────
//
// Mirrors this screen's own real Delivery-tab layout (header, tabs, KPI
// strip, alerts banner, filter bar, Project Health/Upcoming Deadlines/Recent
// Changes), built from the same shared `SkeletonBlock` primitive the
// Admin/Project Lead/Member Dashboards, Projects list, and My Work already
// use for their own loading states — never a second skeleton pattern.
// Reuses the real `Section` container (with its real title/icon) for each
// section below, same as Admin Reports' own loading state does, so only the
// still-loading numbers/rows are placeholders. Shown both on first load and
// on every re-run of the data-loading effect below (e.g. returning to a
// backgrounded browser tab), so real content never has to share the screen
// with stale data mid-refresh.
function ProjectLeadReportsLoadingSkeleton() {
  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 pb-16">
      {/* Page header */}
      <div className="mb-3">
        <SkeletonBlock className="h-[21px] w-24 mb-1.5" />
        <SkeletonBlock className="h-3 w-40" />
      </div>

      {/* Tabs */}
      <div className="mb-5">
        <SkeletonBlock className="h-8 w-40 rounded-lg" />
      </div>

      {/* Top KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-8">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="rounded-xl border border-slate-200 dark:border-zinc-700/70 bg-white dark:bg-zinc-900 px-5 pt-4 pb-4 shadow-sm shadow-slate-200/40 dark:shadow-black/20"
          >
            <SkeletonBlock className="h-[10px] w-16 mb-2" />
            <SkeletonBlock className="h-6 w-10 mb-1.5" />
            <SkeletonBlock className="h-3 w-14" />
          </div>
        ))}
      </div>

      {/* Alerts banner */}
      <div className="mb-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-center gap-y-2 px-5 py-2.5 min-h-[44px] rounded-xl border border-slate-200 dark:border-zinc-700/70 bg-white dark:bg-zinc-900 shadow-sm shadow-slate-200/40 dark:shadow-black/20">
          {Array.from({ length: 3 }).map((_, i) => (
            <SkeletonBlock key={i} className="h-3.5 w-32 mx-3" />
          ))}
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-1.5 flex-wrap mb-6 rounded-xl border border-slate-200 dark:border-zinc-700/70 bg-white dark:bg-zinc-900 px-4 py-2.5 shadow-sm shadow-slate-200/40 dark:shadow-black/20">
        <SkeletonBlock className="h-[10px] w-10 mr-2" />
        <SkeletonBlock className="h-7 w-20" />
        <SkeletonBlock className="h-7 w-20" />
        <SkeletonBlock className="h-7 w-16" />
        <SkeletonBlock className="h-7 w-16" />
      </div>

      {/* Reporting period */}
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <SkeletonBlock className="h-[10px] w-28" />
        <SkeletonBlock className="h-8 w-64 rounded-lg" />
      </div>

      <div className="space-y-5">
        {/* Project Health */}
        <Section title="Project Health" icon={ProjectIcon}>
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 py-1">
                <SkeletonBlock className="h-6 w-6 rounded-md flex-shrink-0" />
                <SkeletonBlock className="h-4 flex-1 max-w-[180px]" />
                <SkeletonBlock className="h-5 w-16 rounded-full flex-shrink-0" />
                <SkeletonBlock className="h-5 w-20 rounded-full flex-shrink-0" />
                <SkeletonBlock className="h-4 w-8 flex-shrink-0" />
                <SkeletonBlock className="h-4 w-20 flex-shrink-0" />
              </div>
            ))}
          </div>
        </Section>

        {/* Upcoming Deadlines */}
        <Section title="Upcoming Deadlines" icon={ClockIcon}>
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2.5 py-1.5">
                <SkeletonBlock className="h-1.5 w-1.5 rounded-full flex-shrink-0" />
                <SkeletonBlock className="h-3.5 w-3.5 flex-shrink-0" />
                <SkeletonBlock className="h-3.5 w-10 flex-shrink-0" />
                <SkeletonBlock className="h-3.5 flex-1 max-w-[240px]" />
                <SkeletonBlock className="h-3.5 w-14 flex-shrink-0" />
              </div>
            ))}
          </div>
        </Section>

        {/* Tickets by Member */}
        <Section title="Tickets by Member" icon={PersonIcon}>
          <div className="space-y-5">
            {Array.from({ length: 3 }).map((_, gi) => (
              <div key={gi}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <SkeletonBlock className="h-6 w-6 rounded-full flex-shrink-0" />
                    <SkeletonBlock className="h-4 w-24" />
                  </div>
                  <SkeletonBlock className="h-3 w-20" />
                </div>
                <ul className="space-y-1.5 pl-8">
                  {Array.from({ length: 3 }).map((_, ti) => (
                    <li key={ti} className="flex items-center gap-3 py-1">
                      <SkeletonBlock className="h-3 w-16 flex-shrink-0" />
                      <SkeletonBlock className="h-3 flex-1" />
                      <SkeletonBlock className="h-3 w-8 flex-shrink-0" />
                      <SkeletonBlock className="h-4 w-14 rounded-md flex-shrink-0" />
                    </li>
                  ))}
                </ul>
                <SkeletonBlock className="h-3 w-24 mt-1.5 ml-8" />
              </div>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ProjectLeadReportsScreen() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { organization, userId, user } = useCurrentUser();
  const { projects: myProjects } = useOrganizationProjects();
  const { openMemberProfile } = useMemberProfile();

  // Real query-state handoff for the Team Capacity KPI's own "2+ people
  // over capacity across several projects" case below — same `?param=`
  // URL-as-source-of-truth precedent as Tickets' own `?alerts=`/Projects'
  // own `?blocked=`, seeded once on mount rather than kept continuously
  // synced back to the URL on every manual tab switch.
  const [tab, setTab] = useState<ReportTab>(() => (searchParams.get("tab") === "team" ? "team" : "delivery"));
  const [teamCapacityFilterActive, setTeamCapacityFilterActive] = useState(
    () => searchParams.get("filter") === "over-capacity"
  );
  const [projectFilter, setProjectFilter] = useState<string[]>([]);
  const [assigneeFilter, setAssigneeFilter] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [priorityFilter, setPriorityFilter] = useState<string[]>([]);
  // A ticket click now navigates straight to its own Detail page — no more
  // intermediate Preview step. Kept as `setPreview` (not renamed) so every
  // existing call site below needs no change.
  function setPreview(ticket: Ticket) {
    router.push(`/projects/${ticket.projectSlug}/tickets/${getTicketDisplayKey(ticket)}`);
  }

  // Delivery tab's own reporting period, for Tickets by Member (and any
  // other historical/logged-hours metric on that tab) — same real
  // PeriodSelector component/PeriodKey/CustomRange/realRangeForPeriod Admin
  // Reports' own Delivery tab already uses. Never applied to Project
  // Health/Upcoming Deadlines, which stay current-state-only, same as
  // before. Team has no period selector of its own (every Team widget is a
  // current-state metric — active assignments vs. organization_memberships'
  // own real weekly capacity — never scoped to a date range), so this is
  // the only reporting period on this whole screen.
  const [period, setPeriod] = useState<PeriodKey>("this-month");
  const [customRange, setCustomRange] = useState<CustomRange>(() => defaultCustomRange());

  function clearTeamCapacityFilter() {
    setTeamCapacityFilterActive(false);
    const params = new URLSearchParams(searchParams.toString());
    params.delete("filter");
    const qs = params.toString();
    router.replace(`/reports${qs ? `?${qs}` : ""}`);
  }

  // ── Real data load — tickets across every led project, that same
  //    project's own real team roster/capacity, and that same real ticket
  //    set's own real logged time within the active Period (Tickets by
  //    Member) — one fetch backs every widget below, no per-widget query. ─
  const [rawTickets, setRawTickets] = useState<Ticket[]>([]);
  const [teamBySlug, setTeamBySlug] = useState<Map<string, ProjectTeamMember[]>>(new Map());
  const [rawTimeEntries, setRawTimeEntries] = useState<OrganizationTimeEntry[]>([]);
  // Projects this profile really leads (project_role = 'lead'). "My
  // Projects" is every project they can access, and its project-level
  // delivery numbers cover all of them — but anything about another
  // person (their roster entry, workload, logged time) is only ever read
  // for these; on the rest only this profile's own data is. Same two
  // scopes as Time Tracking / Hours Report (lib/time-tracking-scope.ts).
  const [ledSlugs, setLedSlugs] = useState<string[]>([]);
  const ledSlugSet = useMemo(() => new Set(ledSlugs), [ledSlugs]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState(0);

  useEffect(() => {
    if (!organization || !userId) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: clears the previous scope's data the instant this effect re-runs (on mount, on a Period change), before the async fetch below resolves, same pattern used elsewhere in this app.
    setLoadState("loading");

    (async () => {
      const [ticketsResult, leadResult] = await Promise.all([
        loadOrganizationTickets(organization.id),
        loadLeadProjects(organization.id, userId, { includeNonActive: true }),
      ]);
      if (cancelled) return;
      if (ticketsResult.status === "error") {
        setLoadState("error");
        setLoadError(ticketsResult.message);
        return;
      }
      if (leadResult.status === "error") {
        setLoadState("error");
        setLoadError(leadResult.message);
        return;
      }

      const led = new Set(
        slugsWithAccess(buildLeadTimeTrackingProjectOptions(leadResult.projects, myProjects), "lead")
      );

      // Rosters only for led projects — a member-only project's team is
      // never loaded here.
      const teamResults = await Promise.all(
        myProjects.map((p) =>
          led.has(p.slug)
            ? loadProjectTeam(organization.id, p.slug)
            : Promise.resolve<Awaited<ReturnType<typeof loadProjectTeam>>>({ status: "ready", members: [] })
        )
      );
      if (cancelled) return;

      // Whole-team time only for led-project tickets; own entries only for
      // the rest (the query itself filters logged_by).
      const { from, to } = realRangeForPeriod(period, customRange, getTodayISO());
      const timeResult = await loadScopedTimeEntries(
        ticketsResult.tickets.filter((t) => led.has(t.projectSlug)).map((t) => t.id),
        ticketsResult.tickets.filter((t) => !led.has(t.projectSlug)).map((t) => t.id),
        userId,
        from,
        to
      );
      if (cancelled) return;
      if (timeResult.status === "error") {
        setLoadState("error");
        setLoadError(timeResult.message);
        return;
      }

      // On a member-only project the "team" is just this profile — their
      // real roster entry from a led project when there is one, otherwise
      // their own session identity.
      const selfMember: ProjectTeamMember =
        teamResults.flatMap((r) => (r.status === "ready" ? r.members : [])).find((m) => m.id === userId) ?? {
          id: userId,
          name: user.name,
          email: user.email,
          avatar: user.avatar,
          title: ROLE_LABELS[user.role],
          weeklyCapacity: user.weeklyCapacity,
          projectRole: "member",
        };
      const teamMap = new Map<string, ProjectTeamMember[]>();
      myProjects.forEach((p, i) => {
        const teamResult = teamResults[i];
        teamMap.set(
          p.slug,
          led.has(p.slug) ? (teamResult.status === "ready" ? teamResult.members : []) : [selfMember]
        );
      });

      setLedSlugs(Array.from(led));
      setRawTickets(ticketsResult.tickets);
      setTeamBySlug(teamMap);
      setRawTimeEntries(timeResult.entries);
      setLoadState("ready");
    })();

    return () => {
      cancelled = true;
    };
    // organization?.id (not the whole `organization` object) — depending on
    // the object re-triggers this effect on every window-focus regain,
    // since current-user-provider.tsx hands back a new `organization`
    // reference on its own session revalidation even when the org itself
    // hasn't changed. Keying off the real identity means this only re-runs
    // on a genuine org change, myProjects/Period changing, the initial
    // mount, or an explicit user-triggered runFetch() (Retry) — no
    // background auto-refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organization?.id, userId, myProjects, requestId, period, customRange]);

  const todayISO = getTodayISO();

  const ticketsByProjectSlug = useMemo(() => {
    const map = new Map<string, Ticket[]>();
    for (const t of rawTickets) {
      const list = map.get(t.projectSlug) ?? [];
      list.push(t);
      map.set(t.projectSlug, list);
    }
    return map;
  }, [rawTickets]);

  // Real Health/Blocked/Progress — one shared computation (buildProjectHealthRows,
  // reports-screen.tsx) reused by the Project Health table, the Blocked
  // Tickets KPI, and the alerts banner below, never a parallel rule.
  const healthRows = useMemo(
    () =>
      buildProjectHealthRows(
        myProjects.map((p) => ({ slug: p.slug, name: p.name, projectCode: p.projectCode })),
        rawTickets,
        [],
        todayISO
      ),
    [myProjects, rawTickets, todayISO]
  );
  const healthRowsBySlug = useMemo(() => new Map(healthRows.map((r) => [r.id, r])), [healthRows]);

  const progressBySlug = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of myProjects) {
      map.set(p.slug, computeProjectProgressPct(ticketsByProjectSlug.get(p.slug) ?? []));
    }
    return map;
  }, [myProjects, ticketsByProjectSlug]);

  const totalBlockedTickets = useMemo(() => healthRows.reduce((sum, r) => sum + r.blocked, 0), [healthRows]);

  // Real ticket list backing the "Blocked Tickets" KPI's own navigation
  // below — the exact same real `rawTickets` already summed (via
  // healthRows) into `totalBlockedTickets` above, just resolved down to the
  // actual tickets instead of a count; never a second query/recount.
  const blockedTicketsList = useMemo(() => rawTickets.filter((t) => t.status === "blocked"), [rawTickets]);

  const weekRange = useMemo(() => getWeekRangeISO(todayISO), [todayISO]);
  // Real ticket list backing the "Due This Week" KPI's own navigation below
  // — the exact same real `rawTickets` and Monday–Sunday week bounds
  // already used for this KPI's own count, just resolved down to the
  // actual tickets instead of a count; never a second query or a
  // different "this week" definition.
  const dueThisWeekList = useMemo(
    () =>
      rawTickets.filter((t) => {
        if (isTicketClosed(t) || !t.dueDate) return false;
        const iso = parseDisplayDate(t.dueDate);
        return Boolean(iso) && iso >= weekRange.start && iso <= weekRange.end;
      }),
    [rawTickets, weekRange]
  );
  const totalDueThisWeek = dueThisWeekList.length;

  // Real Team Capacity/Utilization — weeklyCapacity belongs to the member,
  // never the project: loadProjectTeam now resolves it purely from
  // organization_memberships.weekly_capacity (the single org-wide source of
  // truth), so every one of a member's own per-led-project roster rows
  // already carries the exact same real number — `Math.max` across those
  // rows (same de-dupe pattern project-lead-time-tracking-screen.tsx's own
  // mergeLedTeams already uses) reduces them to that one canonical value,
  // never `+=` (a member staffed on 2 led projects must never show
  // 2×capacity). assignedHours, by contrast, legitimately accumulates
  // across every led project's own active tickets (that's real work in
  // real scope, not a per-project capacity allocation) — unioned by
  // profileId, same "count unique people, never per-project" rule
  // Projects' own Over Capacity KPI already established. Over-capacity is
  // evaluated once, after the full merge, against each member's own final
  // total assignedHours vs. their single real weeklyCapacity — never a
  // per-project partial comparison, which could miss a member whose hours
  // are split (and so individually under capacity) across several led
  // projects but whose real total exceeds it.
  const teamStats = useMemo(() => {
    const byProfileId = new Map<string, RealTeamMemberStat>();

    for (const project of myProjects) {
      const members = teamBySlug.get(project.slug) ?? [];
      const projectTickets = ticketsByProjectSlug.get(project.slug) ?? [];

      const assignedByProfileId = new Map<string, number>();
      const blockedByProfileId = new Map<string, number>();
      for (const t of projectTickets) {
        if (!t.assigneeProfileId) continue;
        if (t.status === "blocked") {
          blockedByProfileId.set(t.assigneeProfileId, (blockedByProfileId.get(t.assigneeProfileId) ?? 0) + (t.hours ?? 0));
        }
        if (isTicketClosed(t)) continue;
        assignedByProfileId.set(t.assigneeProfileId, (assignedByProfileId.get(t.assigneeProfileId) ?? 0) + (t.hours ?? 0));
      }

      for (const member of members) {
        const assignedInProject = assignedByProfileId.get(member.id) ?? 0;
        const blockedInProject = blockedByProfileId.get(member.id) ?? 0;
        const existing = byProfileId.get(member.id);
        if (existing) {
          existing.weeklyCapacity = Math.max(existing.weeklyCapacity, member.weeklyCapacity);
          existing.assignedHours += assignedInProject;
          existing.blockedHours += blockedInProject;
          existing.projectSlugs.push(project.slug);
        } else {
          byProfileId.set(member.id, {
            id: member.id,
            name: member.name,
            avatar: member.avatar,
            role: member.title,
            projectSlugs: [project.slug],
            weeklyCapacity: member.weeklyCapacity,
            assignedHours: assignedInProject,
            blockedHours: blockedInProject,
            isOverCapacity: false,
          });
        }
      }
    }

    let overCapacityCount = 0;
    for (const member of byProfileId.values()) {
      if (member.assignedHours > member.weeklyCapacity) {
        member.isOverCapacity = true;
        overCapacityCount++;
      }
    }

    const members = Array.from(byProfileId.values()).sort((a, b) => a.name.localeCompare(b.name));
    const totalCapacityHours = members.reduce((sum, m) => sum + m.weeklyCapacity, 0);
    const totalAssignedHours = rawTickets
      // Team workload: anyone's on a led project, only this profile's own
      // on a member-only one — same rule as the per-member rows above.
      .filter((t) => !isTicketClosed(t) && t.assigneeProfileId && userId && countsTowardWorkload(t, ledSlugSet, userId))
      .reduce((sum, t) => sum + (t.hours ?? 0), 0);
    const utilizationPct = totalCapacityHours > 0 ? Math.round((totalAssignedHours / totalCapacityHours) * 100) : 0;

    return {
      members,
      overCapacityCount,
      totalCapacityHours,
      totalAssignedHours,
      utilizationPct,
    };
  }, [myProjects, teamBySlug, ticketsByProjectSlug, rawTickets, ledSlugSet, userId]);

  // "Team Capacity" KPI — reuses `teamStats.members`, the exact same real
  // per-member collection already driving this KPI's own displayed count
  // (unique by profileId, never summed per-project) — no second query, no
  // duplicated capacity/utilization rule. Zero stays non-interactive;
  // exactly one real person over capacity opens their Member Profile Modal
  // directly (real profileId, scoped to their own project only when they
  // have exactly one); more than one hands off to that one project's real
  // Team page when every one of them shares the exact same single project,
  // or to this same page's own Team tab (filtered, real, `?filter=
  // over-capacity`) when they span more than one — never an arbitrarily
  // picked project.
  function handleTeamCapacityClick() {
    const overCapacityMembers = teamStats.members.filter((m) => m.isOverCapacity);
    if (overCapacityMembers.length === 0) return;

    if (overCapacityMembers.length === 1) {
      const member = overCapacityMembers[0];
      openMemberProfile({
        name: member.name,
        avatar: member.avatar,
        profileId: member.id,
        projectSlug: member.projectSlugs.length === 1 ? member.projectSlugs[0] : undefined,
      });
      return;
    }

    const involvedSlugs = new Set(overCapacityMembers.flatMap((m) => m.projectSlugs));
    if (involvedSlugs.size === 1) {
      router.push(`/projects/${Array.from(involvedSlugs)[0]}/team`);
      return;
    }

    router.push("/reports?tab=team&filter=over-capacity");
  }

  // "Blocked Tickets" KPI — reuses `blockedTicketsList`, the exact same
  // real tickets already summed into this KPI's own displayed count above
  // — no second query, no duplicated status check. Same real 0/1/2+ rule
  // already established by the other navigable KPIs: zero stays
  // non-interactive; exactly one navigates straight to its own Ticket
  // Detail (no new modal, no navigating to the list); more than one
  // hands off to the Tickets module's own org-wide view with the real
  // `?alerts=blocked` filter applied and visible (same query-state
  // convention Tickets' own filter bar already reads) — RLS already scopes
  // that destination to this same Project Lead's own visible projects, so
  // it can never show a project outside their real scope.
  function handleBlockedTicketsClick() {
    if (blockedTicketsList.length === 0) return;
    if (blockedTicketsList.length === 1) {
      setPreview(blockedTicketsList[0]);
      return;
    }
    router.push("/tickets?alerts=blocked");
  }

  // "Due This Week" KPI — reuses `dueThisWeekList`, the exact same real
  // tickets/week-range already used for this KPI's own displayed count
  // above — no second query, no different "this week" definition. Same
  // real 0/1/2+ rule as the other navigable KPIs: zero stays
  // non-interactive; exactly one navigates straight to its own Ticket
  // Detail; more than one hands off to the Tickets module's own
  // org-wide view with the real `?alerts=due-this-week` filter applied and
  // visible (same query-state convention `?alerts=blocked`/`due-today`
  // already use) — RLS already scopes that destination to this same
  // Project Lead's own visible projects.
  function handleDueThisWeekClick() {
    if (dueThisWeekList.length === 0) return;
    if (dueThisWeekList.length === 1) {
      setPreview(dueThisWeekList[0]);
      return;
    }
    router.push("/tickets?alerts=due-this-week");
  }

  // Team tab's own real member list — the exact same `teamStats.members`
  // the Team Capacity KPI already reads, narrowed to only the real
  // over-capacity ones when that KPI's own `?filter=over-capacity` handoff
  // is active, never a second/different member list.
  const displayedTeamMembers = useMemo(
    () => (teamCapacityFilterActive ? teamStats.members.filter((m) => m.isOverCapacity) : teamStats.members),
    [teamCapacityFilterActive, teamStats.members]
  );

  // "Sprint Progress" replacement — JIRITA has no real sprint source in
  // Supabase, so this reuses the same real ticket-count Progress every
  // project already computes (computeProjectProgressPct, reports-screen.tsx
  // — same formula Project Health's own Progress column below uses),
  // averaged across the Lead's own real projects, rather than inventing
  // sprint data.
  const avgProgressPct = useMemo(() => {
    if (myProjects.length === 0) return 0;
    const total = myProjects.reduce((sum, p) => sum + (progressBySlug.get(p.slug) ?? 0), 0);
    return Math.round(total / myProjects.length);
  }, [myProjects, progressBySlug]);

  // Real project Health counts (Healthy/Needs Attention/Critical) — same
  // official definition as Projects (buildProjectHealthRows' own risk,
  // defaulting to "healthy" for a project with no real tickets yet).
  const healthCounts = useMemo(() => {
    let healthy = 0;
    let needsAttention = 0;
    let critical = 0;
    for (const p of myProjects) {
      const risk = healthRowsBySlug.get(p.slug)?.risk ?? "on-track";
      if (risk === "blocked") critical++;
      else if (risk === "at-risk") needsAttention++;
      else healthy++;
    }
    return { healthy, needsAttention, critical };
  }, [myProjects, healthRowsBySlug]);

  // Real per-tier project slugs backing the "Project Health" alert's own
  // navigation below — reuses the exact same `healthRowsBySlug`/
  // RISK_TO_HEALTH already used for `healthCounts` above and for every
  // project's own Health badge in the table below, just resolved down to
  // each tier's real project slugs instead of a count; never a second/
  // different definition of Health.
  const projectSlugsByHealth = useMemo(() => {
    const groups: Record<ProjectHealth, string[]> = { healthy: [], "needs-attention": [], critical: [] };
    for (const p of myProjects) {
      const risk = healthRowsBySlug.get(p.slug)?.risk ?? "on-track";
      groups[RISK_TO_HEALTH[risk]].push(p.slug);
    }
    return groups;
  }, [myProjects, healthRowsBySlug]);

  // "Project Health" alert — each of the three states (Healthy/Needs
  // Attention/Critical) navigates independently. Same real 0/1/2+ rule as
  // every other navigable KPI/alert here: zero stays non-interactive; exactly
  // one real project in that tier opens that project's own Project Overview
  // directly (by its real slug); more than one hands off to the Projects
  // module's own list with that tier's real `?health=` filter applied and
  // visible (same query-state convention `?alerts=`/`?filter=` already use).
  function handleProjectHealthClick(tier: ProjectHealth) {
    const slugs = projectSlugsByHealth[tier];
    if (slugs.length === 0) return;
    if (slugs.length === 1) {
      router.push(`/projects/${slugs[0]}`);
      return;
    }
    router.push(`/projects?health=${tier}`);
  }

  // ── Alerts banner — only real, calculable conditions: members over
  //    capacity, blocked tickets, and the real Health split above. Each
  //    item reuses the exact same click-through logic/data as its own KPI
  //    card above (handleTeamCapacityClick/handleBlockedTicketsClick) or the
  //    real per-tier Health navigation just above — never a second rule. ──
  const statusItems = useMemo<StatusItem[]>(() => {
    const items: StatusItem[] = [];
    if (teamStats.overCapacityCount > 0) {
      items.push({
        id: "over-capacity",
        level: "warning",
        text: `${teamStats.overCapacityCount} team member${teamStats.overCapacityCount === 1 ? "" : "s"} over capacity`,
        onClick: handleTeamCapacityClick,
      });
    }
    if (totalBlockedTickets > 0) {
      items.push({
        id: "blocked",
        level: "critical",
        text: `${totalBlockedTickets} ticket${totalBlockedTickets === 1 ? "" : "s"} blocked`,
        onClick: handleBlockedTicketsClick,
      });
    }
    items.push({
      id: "health",
      level: healthCounts.critical > 0 ? "critical" : healthCounts.needsAttention > 0 ? "warning" : "ok",
      text: `${healthCounts.healthy} Healthy · ${healthCounts.needsAttention} Needs Attention · ${healthCounts.critical} Critical`,
      segments: [
        {
          key: "healthy",
          label: `${healthCounts.healthy} Healthy`,
          onClick: healthCounts.healthy > 0 ? () => handleProjectHealthClick("healthy") : undefined,
        },
        {
          key: "needs-attention",
          label: `${healthCounts.needsAttention} Needs Attention`,
          onClick: healthCounts.needsAttention > 0 ? () => handleProjectHealthClick("needs-attention") : undefined,
        },
        {
          key: "critical",
          label: `${healthCounts.critical} Critical`,
          onClick: healthCounts.critical > 0 ? () => handleProjectHealthClick("critical") : undefined,
        },
      ],
    });
    return items.slice(0, 3);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleTeamCapacityClick/handleBlockedTicketsClick/handleProjectHealthClick close over teamStats/blockedTicketsList/projectSlugsByHealth (already listed) and are redefined every render; adding them here would only make this memo recompute unconditionally, same tradeoff already accepted for the KpiCard onClick props above.
  }, [teamStats.overCapacityCount, totalBlockedTickets, healthCounts]);

  // ── Filters (Delivery tab, cosmetic — mirrors the rest of Reports) —
  //    real projects/members/statuses/priorities only, restricted to values
  //    that actually occur in the current real scope (same "only real
  //    values" precedent Admin Reports already established). ─────────────
  const projectGroups = useMemo<DropdownGroup[]>(
    () => [{ options: myProjects.map((p) => ({ value: p.slug, label: p.name })) }],
    [myProjects]
  );
  const assigneeGroups = useMemo<DropdownGroup[]>(
    () => [{ options: teamStats.members.map((m) => ({ value: m.id, label: m.name, avatar: m.avatar })) }],
    [teamStats.members]
  );
  const statusGroups = useMemo<DropdownGroup[]>(() => {
    const present = new Set(rawTickets.map((t) => t.status));
    const order = Object.keys(STATUS_LABEL) as TicketStatus[];
    return [{ options: order.filter((s) => present.has(s)).map((s) => ({ value: s, label: STATUS_LABEL[s] })) }];
  }, [rawTickets]);
  const priorityGroups = useMemo<DropdownGroup[]>(() => {
    const present = new Set(rawTickets.map((t) => t.priority));
    return [{ options: PRIORITY_VALUES.filter((p) => present.has(p)).map((p) => ({ value: p, label: PRIORITY_LABEL[p] })) }];
  }, [rawTickets]);

  // ── Upcoming Deadlines — real open tickets with a due date, across every
  //    led project, nearest first. ────────────────────────────────────────
  const upcomingDeadlines = useMemo(
    () =>
      rawTickets
        .filter((t) => !isTicketClosed(t) && t.dueDate)
        .slice()
        .sort((a, b) => parseDisplayDate(a.dueDate as string).localeCompare(parseDisplayDate(b.dueDate as string))),
    [rawTickets]
  );

  // ── Tickets by Member — same real grouping/dedup/hours rules as Admin
  //    Reports' own Delivery tab (buildTicketsByMember, reports-screen.tsx,
  //    reused as-is): a ticket belongs to a member's group when it's
  //    currently assigned to them and not Done, OR they logged real hours
  //    on it within the active Period, regardless of current
  //    assignee/status. `scopedProjectSlugs` keeps this to exactly this
  //    profile's own projects (further narrowed by the Project filter),
  //    never a project outside their scope — same defense-in-depth
  //    intersection every other real scope on this page already applies.
  //    On a project they don't lead, only their own work is listed
  //    (inPersonBreakdown) — never a colleague's assignments. ──
  const scopedProjectSlugs = useMemo(() => {
    const mySlugs = new Set(myProjects.map((p) => p.slug));
    if (projectFilter.length === 0) return mySlugs;
    return new Set(projectFilter.filter((slug) => mySlugs.has(slug)));
  }, [myProjects, projectFilter]);

  // Entries on non-led projects are only ever this profile's own (see the
  // load effect), so any of them marks a ticket as their own work.
  const ownLoggedTicketIds = useMemo(
    () => new Set(rawTimeEntries.filter((e) => e.loggedBy === userId).map((e) => e.ticketId)),
    [rawTimeEntries, userId]
  );

  const ticketsByMemberScope = useMemo(
    () =>
      rawTickets.filter((t) => {
        if (!scopedProjectSlugs.has(t.projectSlug)) return false;
        if (!userId || !inPersonBreakdown(t, ledSlugSet, userId, ownLoggedTicketIds)) return false;
        if (statusFilter.length > 0 && !statusFilter.includes(t.status)) return false;
        if (priorityFilter.length > 0 && !priorityFilter.includes(t.priority)) return false;
        return true;
      }),
    [rawTickets, scopedProjectSlugs, ledSlugSet, userId, ownLoggedTicketIds, statusFilter, priorityFilter]
  );
  const ticketsByMemberScopeIds = useMemo(
    () => new Set(ticketsByMemberScope.map((t) => t.id)),
    [ticketsByMemberScope]
  );
  const timeEntriesForMemberBlock = useMemo(
    () => rawTimeEntries.filter((e) => ticketsByMemberScopeIds.has(e.ticketId)),
    [rawTimeEntries, ticketsByMemberScopeIds]
  );
  // Real name/avatar/weeklyCapacity roster for grouping — teamStats.members
  // is already scoped to exactly this Lead's own led projects (see
  // teamStats above), reshaped to the OrgWorkloadMember shape
  // buildTicketsByMember expects, never the org-wide roster.
  const membersForGrouping = useMemo<OrgWorkloadMember[]>(
    () => teamStats.members.map((m) => ({ id: m.id, name: m.name, avatar: m.avatar, weeklyCapacity: m.weeklyCapacity })),
    [teamStats.members]
  );
  const ticketsByMember = useMemo(() => {
    const groups = buildTicketsByMember(ticketsByMemberScope, timeEntriesForMemberBlock, membersForGrouping, todayISO)
      // A member-only project's ticket only ever sits in this profile's own
      // group — never a colleague's, even when they're its assignee.
      .map((g) =>
        g.profileId === userId ? g : { ...g, tickets: g.tickets.filter((row) => ledSlugSet.has(row.ticket.projectSlug)) }
      )
      .filter((g) => g.tickets.length > 0);
    if (assigneeFilter.length === 0) return groups;
    return groups.filter((g) => g.profileId !== null && assigneeFilter.includes(g.profileId));
  }, [ticketsByMemberScope, timeEntriesForMemberBlock, membersForGrouping, assigneeFilter, todayISO, ledSlugSet, userId]);

  // "My Projects" KPI — reuses `myProjects`, the exact same real collection
  // already driving this KPI's own displayed count, regardless of health/
  // status — no second query, no duplicated scope. Same real 0/1/2+ rule
  // already established by the other navigable KPIs in this app: zero
  // stays non-interactive; exactly one navigates straight to that real
  // project's own Project Overview (by its real slug, never by name); more
  // than one navigates to the Projects module's own list (no extra
  // filters), reusing the exact same routes every other "open a project" /
  // "open the Projects list" trigger already uses.
  function handleMyProjectsClick() {
    if (myProjects.length === 0) return;
    if (myProjects.length === 1) {
      router.push(`/projects/${myProjects[0].slug}`);
      return;
    }
    router.push("/projects");
  }

  if (loadState === "loading") {
    return <ProjectLeadReportsLoadingSkeleton />;
  }

  if (loadState === "error") {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 pb-16">
        <div className="flex flex-col items-center justify-center text-center px-4 py-20">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-zinc-200">Couldn&apos;t load reports</h3>
          <p className="text-sm text-slate-400 mt-1 max-w-xs dark:text-zinc-500">
            {loadError ?? "Something went wrong."}
          </p>
          <button
            type="button"
            onClick={() => setRequestId((id) => id + 1)}
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
      <div className="mb-3">
        <h1 className="text-xl font-bold text-slate-900 dark:text-zinc-50 tracking-tight leading-none">
          Reports
        </h1>
        <p className="text-xs text-slate-400 dark:text-zinc-500 mt-0.5">{formatHeaderDate(todayISO)}</p>
      </div>

      {/* ── Hours Report — entry point card ─────────────────────────────────── */}
      {/* Every Project Lead can reach the report (access is role-based, not
          financial_access-based); the report page itself decides whether
          `$` is shown, via hasFinancialAccess. */}
      <div className="mb-5">
        <HoursReportEntryCard />
      </div>

      {/* ── Tabs ─────────────────────────────────────────────────────────── */}
      <div className="mb-5">
        <ReportTabs tab={tab} onChange={setTab} />
      </div>

      {/* ── Top KPIs — always visible, both tabs ────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-8">
        <KpiCard
          label="My Projects"
          value={myProjects.length}
          sub="active"
          disabled={myProjects.length === 0}
          onClick={handleMyProjectsClick}
        />
        <KpiCard
          label="Team Capacity"
          value={teamStats.overCapacityCount}
          sub={`of ${teamStats.members.length} over capacity`}
          danger={teamStats.overCapacityCount > 0}
          disabled={teamStats.overCapacityCount === 0}
          onClick={handleTeamCapacityClick}
        />
        <KpiCard
          label="Blocked Tickets"
          value={totalBlockedTickets}
          sub="need attention"
          danger={totalBlockedTickets > 0}
          disabled={totalBlockedTickets === 0}
          onClick={handleBlockedTicketsClick}
        />
        <KpiCard
          label="Due This Week"
          value={totalDueThisWeek}
          sub="tickets"
          disabled={totalDueThisWeek === 0}
          onClick={handleDueThisWeekClick}
        />
        <KpiCard
          label="Team Utilization"
          value={`${teamStats.utilizationPct}%`}
          sub="assigned ÷ capacity"
          progress={teamStats.utilizationPct}
          accent
        />
        <KpiCard
          label="Avg. Progress"
          value={`${avgProgressPct}%`}
          sub="across projects"
          progress={avgProgressPct}
          accent
        />
      </div>

      {tab === "delivery" && (
        <>
          {/* ── Alerts banner ────────────────────────────────────────────── */}
          <div className="mb-4">
            <ReportStatusBar items={statusItems} />
          </div>

          {/* ── Filters ──────────────────────────────────────────────────── */}
          <div className="flex items-center gap-1 flex-wrap mb-6 rounded-xl border border-slate-200 dark:border-zinc-700/70 bg-white dark:bg-zinc-900 px-4 py-2.5 shadow-sm shadow-slate-200/40 dark:shadow-black/20">
            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600 mr-2">
              Filter
            </span>
            <FilterDropdown label="Project" mode="multi" groups={projectGroups} selected={projectFilter} onChange={setProjectFilter} />
            <FilterDropdown label="Assignee" mode="multi" groups={assigneeGroups} selected={assigneeFilter} onChange={setAssigneeFilter} searchable />
            <FilterDropdown label="Status" mode="multi" groups={statusGroups} selected={statusFilter} onChange={setStatusFilter} />
            <FilterDropdown label="Priority" mode="multi" groups={priorityGroups} selected={priorityFilter} onChange={setPriorityFilter} />
          </div>

          {/* ── Reporting period — same real PeriodSelector component/behavior
              Admin Reports' own Delivery tab uses, combines with the 4
              filters above without resetting either. Scopes Tickets by
              Member's own logged hours/historical inclusion only — Project
              Health/Upcoming Deadlines/KPIs above stay current-state-only. */}
          <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
            <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">
              Reporting Period
            </h2>
            <PeriodSelector value={period} onChange={setPeriod} customRange={customRange} onCustomRangeChange={setCustomRange} />
          </div>

          <div className="space-y-5">
            {/* ── Project Health (+ Progress) ─────────────────────────────── */}
            <Section title="Project Health" count={healthRows.length} icon={ProjectIcon}>
              <div className="overflow-x-auto -mx-5 px-5">
                <table className="w-full text-sm min-w-[560px]">
                  <thead>
                    <tr className="border-b border-slate-100 dark:border-zinc-800">
                      <th className="pb-2.5 text-left text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600 w-[220px]">
                        Project
                      </th>
                      <th className="pb-2.5 text-left text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">
                        Status
                      </th>
                      <th className="pb-2.5 text-left text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">
                        Health
                      </th>
                      <th className="pb-2.5 text-right text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">
                        Blocked
                      </th>
                      <th className="pb-2.5 pl-4 text-left text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">
                        Progress
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50 dark:divide-zinc-800/60">
                    {healthRows.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-6 text-center text-sm text-slate-400 dark:text-zinc-500">
                          No real projects in the current report scope.
                        </td>
                      </tr>
                    ) : (
                      healthRows.map((row) => {
                        const project = myProjects.find((p) => p.slug === row.id);
                        if (!project) return null;
                        return (
                          <tr
                            key={project.slug}
                            role="button"
                            tabIndex={0}
                            onClick={() => router.push(`/projects/${project.slug}`)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                router.push(`/projects/${project.slug}`);
                              }
                            }}
                            className="hover:bg-slate-50/60 dark:hover:bg-zinc-800/30 transition-colors duration-150 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500/40 dark:focus-visible:ring-brand-accent/40"
                          >
                            <td className="py-2.5 pr-4">
                              <div className="flex items-center gap-2">
                                <span className="w-6 h-6 rounded-md bg-slate-100 dark:bg-zinc-800 text-[9px] font-bold text-slate-500 dark:text-zinc-400 flex items-center justify-center flex-shrink-0">
                                  {project.shortName}
                                </span>
                                <span className="font-medium text-slate-800 dark:text-zinc-200 truncate">{project.name}</span>
                              </div>
                            </td>
                            <td className="py-2.5">
                              <StatusBadge status={project.status} />
                            </td>
                            <td className="py-2.5">
                              <HealthBadge health={RISK_TO_HEALTH[row.risk]} />
                            </td>
                            <td className="py-2.5 text-right tabular-nums">
                              {row.blocked > 0 ? (
                                <span className="font-medium text-red-600 dark:text-red-400">{row.blocked}</span>
                              ) : (
                                <span className="text-slate-300 dark:text-zinc-600">—</span>
                              )}
                            </td>
                            <td className="py-2.5 pl-4">
                              <BlockCompletion pct={progressBySlug.get(project.slug) ?? 0} />
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </Section>

            {/* ── Upcoming Deadlines (replaces Hours Distribution) ────────── */}
            <Section title="Upcoming Deadlines" count={upcomingDeadlines.length} icon={ClockIcon}>
              {upcomingDeadlines.length === 0 ? (
                <p className="text-xs text-slate-400 dark:text-zinc-600 py-2">No upcoming deadlines.</p>
              ) : (
                <div className="space-y-1">
                  {upcomingDeadlines.map((ticket) => {
                    const isOverdue = Boolean(ticket.dueDate) && parseDisplayDate(ticket.dueDate as string) < todayISO;
                    return (
                      <div
                        key={ticket.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => setPreview(ticket)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setPreview(ticket);
                          }
                        }}
                        className="flex items-center gap-2.5 py-1.5 px-2.5 -mx-2.5 rounded-lg cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500/40 dark:focus-visible:ring-brand-accent/40"
                      >
                        <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isOverdue ? "bg-red-400" : "bg-slate-300 dark:bg-zinc-600"}`} />
                        <span className="flex-1 min-w-0 flex items-baseline gap-1.5">
                          <TicketTypeIcon type={ticket.type} />
                          <span className="text-[11px] font-mono font-medium text-slate-400 dark:text-zinc-500 flex-shrink-0">
                            {getTicketDisplayKey(ticket)}
                          </span>
                          <span className="min-w-0 text-[13px] text-slate-700 dark:text-zinc-300 truncate">
                            {ticket.title}
                          </span>
                        </span>
                        <span className={`text-[11px] font-semibold flex-shrink-0 ${isOverdue ? "text-red-500 dark:text-red-400" : "text-slate-500 dark:text-zinc-400"}`}>
                          {ticket.dueDate}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </Section>

            {/* ── Tickets by Member — same real implementation (grouping,
                dedup, hours, ordering) as Admin Reports' own Delivery tab
                (buildTicketsByMember, reports-screen.tsx), scoped to
                exactly this Lead's own led projects. ─────────────────── */}
            <Section
              title="Tickets by Member"
              count={ticketsByMember.reduce((sum, g) => sum + g.tickets.length, 0)}
              icon={PersonIcon}
            >
              <div className="space-y-5">
                {ticketsByMember.length === 0 ? (
                  <p className="text-sm text-slate-400 dark:text-zinc-500">No real active tickets in the current report scope.</p>
                ) : (
                  ticketsByMember.map((group) => (
                    <div key={group.key}>
                      <div className="flex items-center justify-between mb-2">
                        {group.profileId ? (
                          <MemberTrigger
                            name={group.name}
                            avatar={group.avatar}
                            profileId={group.profileId}
                            projectSlug={projectFilter.length === 1 ? projectFilter[0] : undefined}
                            className="flex items-center gap-2"
                          >
                            <Avatar src={group.avatar} name={group.name} className="w-6 h-6 rounded-full flex-shrink-0" />
                            <span className="text-sm font-medium text-slate-900 dark:text-zinc-100 hover:underline">
                              {group.name}
                            </span>
                          </MemberTrigger>
                        ) : (
                          <span className="flex items-center gap-2">
                            <Avatar src={group.avatar} name={group.name} className="w-6 h-6 rounded-full flex-shrink-0" />
                            <span className="text-sm font-medium text-slate-700 dark:text-zinc-300">
                              {group.name}
                            </span>
                          </span>
                        )}
                        <span className="text-xs font-semibold text-slate-400 dark:text-zinc-500 tabular-nums flex-shrink-0">
                          {group.tickets.length} ticket{group.tickets.length === 1 ? "" : "s"}
                        </span>
                      </div>
                      <ul className="space-y-1 pl-8">
                        {group.tickets.map(({ ticket: t, loggedHours }) => (
                          <li key={t.id}>
                            <button
                              type="button"
                              onClick={() => setPreview(t)}
                              className="group/ref w-full flex items-center gap-3 py-1 text-left"
                            >
                              <span className="text-xs font-mono text-slate-400 dark:text-zinc-500 flex-shrink-0 w-16">
                                {getTicketDisplayKey(t)}
                              </span>
                              <span className="flex-1 min-w-0 text-sm text-slate-700 dark:text-zinc-300 group-hover/ref:text-brand-600 dark:group-hover/ref:text-brand-400 group-hover/ref:underline truncate">
                                {t.title}
                              </span>
                              {t.dueDate && (
                                <span className="text-[11px] text-slate-400 dark:text-zinc-500 flex-shrink-0">
                                  {t.dueDate}
                                </span>
                              )}
                              {/* Real hours this member logged on this ticket
                                  (ticket_time_entries, period-scoped) —
                                  never the ticket's own estimate. */}
                              <span className="text-[11px] text-slate-400 dark:text-zinc-500 flex-shrink-0 tabular-nums">
                                {loggedHours}h
                              </span>
                              <PriorityBadge priority={t.priority} />
                              <TicketStatusBadge status={t.status} />
                            </button>
                          </li>
                        ))}
                      </ul>
                      {/* Real per-group total — sum of this same group's own
                          already-shown per-ticket logged hours, never a
                          separate KPI/card and never clickable. */}
                      <p className="pl-8 mt-1 text-[11px] text-slate-400 dark:text-zinc-500">
                        Total Logged: <span className="tabular-nums">{group.totalLoggedHours}h</span>
                      </p>
                    </div>
                  ))
                )}
              </div>
            </Section>
          </div>
        </>
      )}

      {tab === "team" && (
        <div className="space-y-5">

          {/* Real ?filter=over-capacity handoff from this same page's own
              Team Capacity KPI (2+ real people over capacity across more
              than one project) — same removable FilterChip style/pattern
              Projects' own `?blocked=` handoff already uses. */}
          {teamCapacityFilterActive && (
            <div className="flex items-center gap-1.5">
              <FilterChip label="Over Capacity" active onToggle={clearTeamCapacityFilter} />
            </div>
          )}

          {/* ── Team Capacity + Team Utilization ────────────────────────── */}
          <Section title="Team Capacity" icon={PeopleIcon}>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <KpiCard label="Total Capacity" value={<>{round1(teamStats.totalCapacityHours)}<span className="text-base font-medium ml-0.5">h</span></>} sub="per week" />
              <KpiCard label="Assigned" value={<>{round1(teamStats.totalAssignedHours)}<span className="text-base font-medium ml-0.5">h</span></>} sub="this week" />
              <KpiCard
                label="Team Utilization"
                value={`${teamStats.utilizationPct}%`}
                sub={`${teamStats.overCapacityCount} over capacity`}
                progress={teamStats.utilizationPct}
                accent
              />
            </div>
          </Section>

          {/* ── Hours by Person ──────────────────────────────────────────── */}
          <Section title="Hours by Person" count={displayedTeamMembers.length} icon={PersonIcon}>
            <div className="overflow-x-auto -mx-5 px-5">
              <table className="w-full text-sm min-w-[480px]">
                <thead>
                  <tr className="border-b border-slate-100 dark:border-zinc-800">
                    <th className="pb-2.5 text-left text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600 w-[200px]">
                      Person
                    </th>
                    <th className="pb-2.5 text-right text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">
                      Assigned
                    </th>
                    <th className="pb-2.5 text-right text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">
                      Capacity
                    </th>
                    <th className="pb-2.5 text-right text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">
                      Utilization
                    </th>
                    <th className="pb-2.5 text-right text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">
                      Remaining
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50 dark:divide-zinc-800/60">
                  {displayedTeamMembers.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-6 text-center text-sm text-slate-400 dark:text-zinc-500">
                        No real team members in the current scope.
                      </td>
                    </tr>
                  ) : (
                    displayedTeamMembers.map((member) => {
                      const shape = toTeamMemberShape(member);
                      const pct = utilizationOf(shape);
                      return (
                        <tr key={member.id} className="hover:bg-slate-50/60 dark:hover:bg-zinc-800/30 transition-colors duration-150 cursor-default">
                          <td className="py-2.5 pr-4">
                            <MemberTrigger
                              name={member.name}
                              avatar={member.avatar}
                              role={member.role}
                              profileId={member.id}
                              projectSlug={member.projectSlugs.length === 1 ? member.projectSlugs[0] : undefined}
                              className="flex items-center gap-2.5"
                            >
                              <Avatar src={member.avatar} name={member.name} className="w-6 h-6 rounded-full flex-shrink-0" />
                              <span className="font-medium text-slate-800 dark:text-zinc-200">{member.name}</span>
                            </MemberTrigger>
                          </td>
                          <td className="py-2.5 text-right font-semibold text-slate-800 dark:text-zinc-200 tabular-nums">
                            {formatHours(member.assignedHours)}
                          </td>
                          <td className="py-2.5 text-right text-slate-500 dark:text-zinc-400 tabular-nums">
                            {formatHours(member.weeklyCapacity)}
                          </td>
                          <td className="py-2.5 text-right">
                            <span className={`font-semibold tabular-nums ${capacityTextColor(pct)}`}>{pct}%</span>
                          </td>
                          <td className="py-2.5 text-right text-xs text-slate-500 dark:text-zinc-400 tabular-nums">
                            {remainingAvailabilityLabel(shape)}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </Section>

          {/* ── Workload ─────────────────────────────────────────────────── */}
          <Section title="Workload" icon={BarsIcon}>
            <div className="space-y-4">
              {displayedTeamMembers.length === 0 ? (
                <p className="text-sm text-slate-400 dark:text-zinc-500">No real team members in the current scope.</p>
              ) : (
                displayedTeamMembers.map((member) => {
                  const shape = toTeamMemberShape(member);
                  const pct = utilizationOf(shape);
                  return (
                    <div key={member.id}>
                      <div className="flex items-center justify-between mb-1">
                        <MemberTrigger
                          name={member.name}
                          avatar={member.avatar}
                          role={member.role}
                          profileId={member.id}
                          projectSlug={member.projectSlugs.length === 1 ? member.projectSlugs[0] : undefined}
                          className="flex items-center gap-2"
                        >
                          <Avatar src={member.avatar} name={member.name} className="w-5 h-5 rounded-full flex-shrink-0" />
                          <span className="text-sm font-medium text-slate-700 dark:text-zinc-300">{member.name}</span>
                        </MemberTrigger>
                        <p className="text-sm font-semibold text-slate-700 dark:text-zinc-200 tabular-nums leading-tight">
                          {formatHours(member.assignedHours)}
                          <span className="font-normal text-slate-400 dark:text-zinc-600">{" / "}{formatHours(member.weeklyCapacity)}</span>
                          <span className={`ml-2 font-semibold ${capacityTextColor(pct)}`}>{pct}%</span>
                        </p>
                      </div>
                      <div className="h-1.5 rounded-full bg-slate-100 dark:bg-zinc-800 overflow-hidden">
                        <AnimatedBar pct={Math.min(pct, 100)} className={capacityBarColor(pct)} />
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </Section>

          {/* ── Blocked Work by Member ───────────────────────────────────── */}
          <Section title="Blocked Work by Member" icon={BlockedIcon}>
            <div className="overflow-x-auto -mx-5 px-5">
              <table className="w-full text-sm min-w-[360px]">
                <thead>
                  <tr className="border-b border-slate-100 dark:border-zinc-800">
                    <th className="pb-2.5 text-left text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600 w-[200px]">
                      Member
                    </th>
                    <th className="pb-2.5 text-right text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">
                      Blocked Hours
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50 dark:divide-zinc-800/60">
                  {displayedTeamMembers.length === 0 ? (
                    <tr>
                      <td colSpan={2} className="py-6 text-center text-sm text-slate-400 dark:text-zinc-500">
                        No real team members in the current scope.
                      </td>
                    </tr>
                  ) : (
                    displayedTeamMembers.map((member) => (
                      <tr key={member.id} className="hover:bg-slate-50/60 dark:hover:bg-zinc-800/30 transition-colors duration-150 cursor-default">
                        <td className="py-2.5 pr-4">
                          <MemberTrigger
                            name={member.name}
                            avatar={member.avatar}
                            role={member.role}
                            profileId={member.id}
                            projectSlug={member.projectSlugs.length === 1 ? member.projectSlugs[0] : undefined}
                            className="flex items-center gap-2.5"
                          >
                            <Avatar src={member.avatar} name={member.name} className="w-6 h-6 rounded-full flex-shrink-0" />
                            <span className="font-medium text-slate-800 dark:text-zinc-200">{member.name}</span>
                          </MemberTrigger>
                        </td>
                        <td className="py-2.5 text-right tabular-nums">
                          {member.blockedHours > 0 ? (
                            <span className="font-medium text-red-600 dark:text-red-400">{formatHours(member.blockedHours)}</span>
                          ) : (
                            <span className="text-slate-300 dark:text-zinc-600">—</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Section>

          {/* ── Team Health ──────────────────────────────────────────────── */}
          <Section title="Team Health" count={displayedTeamMembers.length} icon={PulseIcon}>
            <div className="overflow-x-auto -mx-5 px-5">
              <table className="w-full text-sm min-w-[360px]">
                <thead>
                  <tr className="border-b border-slate-100 dark:border-zinc-800">
                    <th className="pb-2.5 text-left text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600 w-[200px]">
                      Member
                    </th>
                    <th className="pb-2.5 text-left text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">
                      Health
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50 dark:divide-zinc-800/60">
                  {displayedTeamMembers.length === 0 ? (
                    <tr>
                      <td colSpan={2} className="py-6 text-center text-sm text-slate-400 dark:text-zinc-500">
                        No real team members in the current scope.
                      </td>
                    </tr>
                  ) : (
                    displayedTeamMembers.map((member) => {
                      const pct = utilizationOf(toTeamMemberShape(member));
                      return (
                        <tr key={member.id} className="hover:bg-slate-50/60 dark:hover:bg-zinc-800/30 transition-colors duration-150 cursor-default">
                          <td className="py-2.5 pr-4">
                            <MemberTrigger
                              name={member.name}
                              avatar={member.avatar}
                              role={member.role}
                              profileId={member.id}
                              projectSlug={member.projectSlugs.length === 1 ? member.projectSlugs[0] : undefined}
                              className="flex items-center gap-2.5"
                            >
                              <Avatar src={member.avatar} name={member.name} className="w-6 h-6 rounded-full flex-shrink-0" />
                              <span className="font-medium text-slate-800 dark:text-zinc-200">{member.name}</span>
                            </MemberTrigger>
                          </td>
                          <td className="py-2.5">
                            <HealthBadge health={healthOfReal(pct, member.blockedHours)} />
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </Section>

        </div>
      )}

    </div>
  );
}
