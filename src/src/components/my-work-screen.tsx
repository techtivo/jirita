"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { Ticket } from "@/lib/mock-tickets";
import { getTicketDisplayKey } from "@/lib/mock-tickets";
import { TicketListRow } from "@/components/tickets/ticket-card";
import { BoardView, ticketColumnKey } from "@/components/tickets/board-view";
import { FilterDropdown } from "@/components/tickets/filter-dropdown";
import type { DropdownGroup } from "@/components/tickets/filter-dropdown";
import {
  StatusBadge,
  TicketTypeIcon,
  PRIORITY_LABEL,
  PRIORITY_VALUES,
  getTodayISO,
  parseDisplayDate,
  formatISODate,
} from "@/components/tickets/ticket-ui";
import { MemberTrigger } from "@/components/member-profile";
import { Avatar } from "@/components/ui/avatar";
import { useCurrentUser } from "@/components/current-user-provider";
import { SkeletonBlock } from "@/components/dashboard-shared";
import {
  loadOrganizationTickets,
  loadOrganizationActivity,
  loadProfileLoggedTimeForDate,
  loadProfileLoggedMinutesForRange,
  loadProfileTimeEntries,
  isTicketClosed,
  FALLBACK_TICKET_STATUSES,
} from "@/lib/tickets";
import type { OrganizationActivityEvent, ProfileTimeEntryRecord, TicketStatusOption } from "@/lib/tickets";
import { loadMemberWeeklyCapacity } from "@/lib/projects";
import { CapacityCell, formatHours, formatHoursMaybe } from "@/components/time-tracking-screen";
import { PersonalTimesheetPanel } from "@/components/personal-timesheet-panel";
import { KPI_INTERACTIVE_CLASS } from "@/components/reports-shared";
import type { PersonalTimesheetEntry } from "@/components/personal-timesheet-panel";

// My Work is the Member's own cross-project work queue — every KPI, ticket,
// hour, and activity entry below is scoped to the signed-in member's own
// real assignments (assignee_profile_id = their profile id). Project
// membership itself is never checked client-side: loadOrganizationTickets
// composes loadOrganizationProjects + loadProjectTickets, both RLS-scoped to
// "projects this profile can see" (is_project_member for a Member), so a
// ticket from a project this member doesn't currently belong to can never
// come back from the query in the first place.

// ── Recent activity (with time groups) ───────────────────────────────────────

interface ActivityEntry {
  id: string;
  name: string;
  avatar: string;
  /** Real profiles.id of the actor, when known — lets a "click this person"
   *  trigger open the Member Profile Modal against their real identity
   *  instead of a name-based guess. */
  actorProfileId: string | null;
  /** The action fragment only — the ticket title never appears here; when
   *  `ticket` is set it renders on its own clickable line instead. */
  action: ReactNode;
  time: string;
  group: "today" | "yesterday" | "earlier";
  ticket?: Ticket;
}

const ACTIVITY_GROUPS: { id: string; label: string; key: ActivityEntry["group"] }[] = [
  { id: "today",     label: "Today",              key: "today" },
  { id: "yesterday", label: "Yesterday",           key: "yesterday" },
  { id: "earlier",   label: "Earlier This Week",   key: "earlier" },
];

const RECENT_ACTIVITY_LIMIT = 10;
const TIMESHEET_ENTRY_LIMIT = 20;

// Only the 5 real event categories loadOrganizationActivity already exposes
// (blocked/completed/hours/assigned/priority) — same vocabulary Admin/Project
// Lead Project Overview's own activity feeds use (activityEventToEntry in
// admin-project-overview.tsx); this file keeps its own local mapping since
// this section's shape (action fragment + day `group`) differs from theirs.
function activityEventToEntry(
  event: OrganizationActivityEvent,
  ticket: Ticket | undefined,
  todayISO: string,
  yesterdayISO: string
): ActivityEntry {
  const localDate = toLocalDateISO(event.createdAtISO);
  const group: ActivityEntry["group"] =
    localDate === todayISO ? "today" : localDate === yesterdayISO ? "yesterday" : "earlier";

  const base = {
    id: event.id,
    name: event.actorName ?? "Someone",
    avatar: event.actorAvatar,
    actorProfileId: event.actorProfileId,
    time: event.time,
    group,
    ticket,
  };

  if (event.type === "blocked") {
    return { ...base, action: <>marked <span className="text-red-600 dark:text-red-400 font-medium">Blocked</span></> };
  }
  if (event.type === "completed") {
    return { ...base, action: <>moved to <span className="text-emerald-600 dark:text-emerald-400 font-medium">Done</span></> };
  }
  if (event.type === "hours") {
    return { ...base, action: <>changed Hours — <span className="font-medium">{formatHoursMaybe(event.oldHours)} → {formatHoursMaybe(event.newHours)}</span></> };
  }
  if (event.type === "assigned") {
    return { ...base, action: <>reassigned to <span className="font-medium">{event.newAssigneeName}</span></> };
  }
  return {
    ...base,
    action: (
      <>
        {event.priorityRaised ? "raised" : "lowered"} priority to{" "}
        <span className="font-medium">{event.newPriorityLabel}</span>
      </>
    ),
  };
}

// ── List groups (blocked first — most urgent) ─────────────────────────────────
// Priority order for the 6 legacy-linked statuses this phase seeds for
// every project (blocked surfaces first regardless of its real
// sort_order) — a real per-project status with no legacy equivalent has
// no defined urgency yet, so it sorts after every known one, ordered by
// its own sort_order among any other unknowns.
const LIST_GROUP_PRIORITY: Record<string, number> = {
  blocked: 0,
  in_progress: 1,
  review: 2,
  to_do: 3,
  backlog: 4,
  done: 5,
};

// ── Date helpers ──────────────────────────────────────────────────────────────
// Real local-calendar date logic throughout (never a fixed/mock date) — same
// conventions already established elsewhere in this app (Member Dashboard,
// tickets-screen.tsx).

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// Local calendar date behind a full timestamp — same reasoning/shape as
// tickets-screen.tsx's own toLocalDateISO (kept local here too, page-local
// glue over a shared real timestamp, not a duplicated business rule).
function toLocalDateISO(iso: string): string {
  const d = new Date(iso);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

// Monday–Sunday containing todayISO — same "This Week" convention already
// used by Member Dashboard/Reports, duplicated here as page-local glue.
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

// Same "urgent window" convention Member Dashboard's own isUrgentDue uses —
// today plus the two days right after it.
const URGENT_WINDOW_DAYS = 2;

function isUrgentDue(dueISO: string, todayISO: string): boolean {
  if (dueISO > todayISO) {
    const diffDays = Math.round(
      (new Date(`${dueISO}T00:00:00`).getTime() - new Date(`${todayISO}T00:00:00`).getTime()) / 86_400_000
    );
    return diffDays <= URGENT_WINDOW_DAYS;
  }
  return false;
}

function isDueThisWeek(t: Ticket, weekStart: string, weekEnd: string): boolean {
  if (isTicketClosed(t) || !t.dueDate) return false;
  const iso = parseDisplayDate(t.dueDate);
  return Boolean(iso) && iso >= weekStart && iso <= weekEnd;
}

// Matches the header's original "Tuesday, June 30" style — real local date,
// same helper shape as Member/Project Lead Dashboards' own formatFullDate.
function formatFullDate(todayISO: string): string {
  return new Date(`${todayISO}T00:00:00`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function formatEntryDateLabel(workDateISO: string, todayISO: string, yesterdayISO: string): string {
  if (workDateISO === todayISO) return "Today";
  if (workDateISO === yesterdayISO) return "Yesterday";
  return formatISODate(workDateISO);
}

// ── Focus mode config ─────────────────────────────────────────────────────────

// Sections hidden in focus mode. Add entries here to extend without rewriting the page.
const FOCUS_MODE_HIDDEN: ReadonlySet<string> = new Set([
  "kpis", "my-hours", "my-time", "blocked", "due-soon", "activity",
]);

// ── KPI filter mode ───────────────────────────────────────────────────────────

type KpiMode = "all" | "blocked" | "due-soon" | "hours";

const KPI_MODE_LABELS: Record<KpiMode, string> = {
  all:      "All tickets",
  blocked:  "Blocked only",
  "due-soon": "Due this week",
  hours:    "By hours",
};

// ── Loading skeleton ──────────────────────────────────────────────────────────
//
// Mirrors this screen's own real layout (header, KPI strip, My Hours/My Time
// bars, toolbar, ticket rows), built from the same shared `SkeletonBlock`
// primitive the Admin/Project Lead/Member Dashboards and the Projects list
// already use for their own loading states — never a second skeleton
// pattern. Shown both on first load and on every re-run of the data-loading
// effect below (e.g. returning to a backgrounded browser tab), so real
// content never has to share the screen with stale data mid-refresh.
function MyWorkLoadingSkeleton({ showMyTime }: { showMyTime: boolean }) {
  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 pb-16">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4 mb-4 sm:mb-6">
        <div>
          <SkeletonBlock className="h-[21px] w-56 mb-1.5" />
          <SkeletonBlock className="h-3 w-32" />
        </div>
        <SkeletonBlock className="h-8 w-28 flex-shrink-0 self-end sm:self-auto" />
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="rounded-xl border border-slate-200 dark:border-zinc-700/70 bg-white dark:bg-zinc-900 px-5 py-4 shadow-sm shadow-slate-200/40 dark:shadow-black/20"
          >
            <SkeletonBlock className="h-[10px] w-24 mb-2" />
            <SkeletonBlock className="h-6 w-12 mb-1.5" />
            <SkeletonBlock className="h-3 w-16" />
          </div>
        ))}
      </div>

      {/* My Hours breakdown */}
      <div className="mt-3 flex items-center gap-5 rounded-xl border border-slate-200 dark:border-zinc-700/70 bg-white dark:bg-zinc-900 px-5 py-3.5 shadow-sm shadow-slate-200/40 dark:shadow-black/20 overflow-x-auto">
        <SkeletonBlock className="h-[10px] w-16 flex-shrink-0" />
        <div className="flex items-center gap-6 flex-1 min-w-0">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex-shrink-0">
              <SkeletonBlock className="h-[10px] w-12 mb-1" />
              <SkeletonBlock className="h-4 w-8" />
            </div>
          ))}
        </div>
      </div>

      {/* My Time (Member only) */}
      {showMyTime && (
        <div className="mt-3 flex items-center gap-5 rounded-xl border border-slate-200 dark:border-zinc-700/70 bg-white dark:bg-zinc-900 px-5 py-3.5 shadow-sm shadow-slate-200/40 dark:shadow-black/20 overflow-x-auto">
          <SkeletonBlock className="h-[10px] w-14 flex-shrink-0" />
          <div className="flex items-center gap-6 flex-1 min-w-0">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex-shrink-0">
                <SkeletonBlock className="h-[10px] w-16 mb-1" />
                <SkeletonBlock className="h-4 w-10" />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div className="mt-8 flex items-center justify-between gap-4 mb-4 flex-wrap">
        <SkeletonBlock className="h-[10px] w-20" />
        <div className="flex items-center gap-1.5">
          <SkeletonBlock className="h-7 w-16" />
          <SkeletonBlock className="h-7 w-16" />
          <SkeletonBlock className="h-7 w-16" />
          <SkeletonBlock className="h-7 w-16" />
          <SkeletonBlock className="h-7 w-24" />
        </div>
      </div>

      {/* Ticket rows */}
      <div className="divide-y divide-slate-100 dark:divide-zinc-800">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 py-3">
            <SkeletonBlock className="h-4 flex-1" />
            <SkeletonBlock className="h-4 w-16" />
            <SkeletonBlock className="h-6 w-6 rounded-full flex-shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── KPI card (clickable) ──────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  sub,
  accent,
  danger,
  active,
  disabled,
  onClick,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  accent?: boolean;
  danger?: boolean;
  active?: boolean;
  /** True when there's nothing real to act on (e.g. "Assigned Tickets" with
   *  zero real tickets) — renders the exact same content as a plain,
   *  non-interactive block instead of a button, so it never shows a
   *  cursor/hover affordance or responds to a click, same as every other
   *  real KPI card elsewhere that goes non-interactive at zero. Only
   *  "Assigned Tickets" passes this today; every other card here keeps its
   *  existing always-interactive toggle behavior unchanged. */
  disabled?: boolean;
  onClick?: () => void;
}) {
  const content = (
    <>
      <p
        className={[
          "text-[10px] font-bold uppercase tracking-widest mb-1",
          accent ? "text-brand-500 dark:text-brand-accent" : "text-slate-400 dark:text-zinc-600",
        ].join(" ")}
      >
        {label}
      </p>
      <p
        className={[
          "text-2xl font-bold leading-none",
          danger ? "text-red-600 dark:text-red-400" :
          accent ? "text-brand-700 dark:text-brand-accent-soft" :
          "text-slate-900 dark:text-zinc-50",
        ].join(" ")}
      >
        {value}
      </p>
      {sub && (
        <p className="text-xs text-slate-400 dark:text-zinc-600 mt-1">{sub}</p>
      )}
    </>
  );

  const baseClassName = [
    "rounded-xl border px-5 py-4 w-full text-left transition-all duration-150",
    "shadow-sm shadow-slate-200/40 dark:shadow-black/20",
    accent
      ? "border-brand-100 dark:border-brand-accent/20 bg-brand-50/40 dark:bg-brand-accent/5"
      : "border-slate-200 dark:border-zinc-700/70 bg-white dark:bg-zinc-900",
  ];

  if (disabled) {
    return <div className={baseClassName.join(" ")}>{content}</div>;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        ...baseClassName,
        KPI_INTERACTIVE_CLASS,
        accent
          ? "hover:border-brand-200 dark:hover:border-brand-accent/40"
          : "hover:border-slate-300 dark:hover:border-zinc-600",
        active
          ? "ring-2 ring-brand-500/40 dark:ring-brand-accent/30 !border-brand-300 dark:!border-brand-700"
          : "",
      ].join(" ")}
    >
      {content}
    </button>
  );
}

// ── Focus ticket row (compact, scannable) ─────────────────────────────────────

function FocusTicketRow({ ticket, todayISO, onOpen }: { ticket: Ticket; todayISO: string; onOpen: (t: Ticket) => void }) {
  const dueISO    = ticket.dueDate ? parseDisplayDate(ticket.dueDate) : "";
  const isOverdue = Boolean(dueISO) && dueISO < todayISO && !isTicketClosed(ticket);
  const isUrgent  = !isOverdue && Boolean(dueISO) && isUrgentDue(dueISO, todayISO);

  return (
    <button
      type="button"
      onClick={() => onOpen(ticket)}
      // flex-wrap (not present before): unlike TicketListRow (its sibling
      // row component, tickets/ticket-card.tsx), this row's StatusBadge,
      // hours, and due date badges are all `flex-shrink-0`/unshrinkable and
      // must stay visible (never `hidden sm:` on Mobile, unlike
      // TicketListRow's). The due date text grew to "MMM D, YYYY" (see the
      // date-formatting task) — on narrow Mobile widths the combined
      // minimum width of StatusBadge + hours + due date no longer fits on
      // one line even with the title (flex-1 min-w-0) fully collapsed,
      // which is what forced this whole row — and with it the whole page,
      // since nothing upstream clips horizontal overflow — wider than the
      // viewport. Wrapping lets the secondary badges drop to a second line
      // instead, with every value still visible, nothing hidden or
      // truncated beyond the title's own existing `truncate`.
      className="w-full flex flex-wrap items-center gap-x-3 gap-y-1 py-2 px-3 -mx-3 rounded-lg hover:bg-slate-50 dark:hover:bg-zinc-800/50 transition-colors text-left"
    >
      <StatusBadge status={ticket.status} />

      <span className="flex-1 min-w-0 flex items-baseline gap-1.5">
        <TicketTypeIcon type={ticket.type} />
        <span className="text-[11px] font-mono font-medium text-slate-400 dark:text-zinc-500 flex-shrink-0">
          {getTicketDisplayKey(ticket)}
        </span>
        <span className="min-w-0 text-[13px] font-medium text-slate-800 dark:text-zinc-200 truncate">
          {ticket.title}
        </span>
      </span>

      {ticket.hours !== undefined && (
        <span className="flex items-center gap-0.5 text-[11px] font-semibold text-slate-500 dark:text-zinc-400 flex-shrink-0">
          <svg className="w-2.5 h-2.5 opacity-50" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />
          </svg>
          {formatHours(ticket.hours)}
        </span>
      )}

      {ticket.dueDate && (
        <span
          className={[
            "text-[11px] font-medium flex-shrink-0",
            isOverdue ? "text-red-600 dark:text-red-400" :
            isUrgent  ? "text-amber-600 dark:text-amber-400" :
            "text-slate-400 dark:text-zinc-500",
          ].join(" ")}
        >
          {ticket.dueDate}
        </span>
      )}
    </button>
  );
}

// ── Section wrapper ───────────────────────────────────────────────────────────

function Section({
  title,
  count,
  icon,
  children,
}: {
  title: string;
  count?: number;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 dark:border-zinc-700/70 bg-white dark:bg-zinc-900 p-5 shadow-sm shadow-slate-200/40 dark:shadow-black/20">
      <div className="flex items-center gap-2 mb-4">
        {icon}
        <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-500 dark:text-zinc-400">
          {title}
        </h2>
        {count !== undefined && (
          <span className="text-[10px] font-semibold text-slate-400 dark:text-zinc-500 bg-slate-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded-full">
            {count}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

// ── View toggle ───────────────────────────────────────────────────────────────

type WorkView = "list" | "board";

const VIEW_ICONS: Record<WorkView, ReactNode> = {
  list: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M9 6H5v3h4V6zM9 15H5v3h4v-3zM21 8H13M21 12H13M21 17H13" />
    </svg>
  ),
  board: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <rect x="3" y="3" width="7" height="18" rx="1.5" />
      <rect x="14" y="3" width="7" height="11" rx="1.5" />
    </svg>
  ),
};

// ── Main component ────────────────────────────────────────────────────────────

export function MyWorkScreen() {
  const { user, userId, organization, isDevFallback } = useCurrentUser();
  const router = useRouter();

  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(isDevFallback ? "ready" : "loading");
  const [loadErrorMessage, setLoadErrorMessage] = useState<string | null>(null);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [projects, setProjects] = useState<{ slug: string; name: string }[]>([]);
  // Every loaded project's own real, ordered ticket_statuses (Fase 2.5),
  // keyed by slug — merged by name below for the Board tab's own columns,
  // since My Work spans every project the member belongs to and two of
  // them are never assumed to share the same status configuration.
  const [statusesBySlug, setStatusesBySlug] = useState<Record<string, TicketStatusOption[]>>({});
  const [activityEvents, setActivityEvents] = useState<OrganizationActivityEvent[]>([]);
  const [todayMinutes, setTodayMinutes] = useState(0);
  const [weekMinutes, setWeekMinutes] = useState(0);
  const [monthMinutes, setMonthMinutes] = useState(0);
  const [weeklyCapacity, setWeeklyCapacity] = useState(user.weeklyCapacity);
  const [timesheetRecords, setTimesheetRecords] = useState<ProfileTimeEntryRecord[]>([]);
  const [requestId, setRequestId] = useState(0);

  const [view, setView]                   = useState<WorkView>("list");
  const [statusFilter, setStatusFilter]   = useState<string[]>([]);
  const [priorityFilter, setPriorityFilter] = useState<string[]>([]);
  const [projectFilter, setProjectFilter] = useState<string[]>([]);
  const [labelFilter, setLabelFilter]     = useState<string[]>([]);
  const [kpiMode, setKpiMode]             = useState<KpiMode | null>(null);
  const [focusMode, setFocusMode]         = useState(false);
  const [showTimesheet, setShowTimesheet] = useState(false);

  const runFetch = useCallback(() => setRequestId((id) => id + 1), []);

  // Depends on organization?.id, not the whole `organization` object:
  // CurrentUserProvider hands back a brand-new `organization` object
  // reference on its own window-focus/route-change session revalidation
  // (see current-user-provider.tsx) even when the org itself hasn't
  // changed — depending on the object would silently refetch and flash
  // this whole screen back to its loading skeleton every time the tab
  // regains focus. Keying off the real identity instead means this effect
  // only ever re-runs on a genuine org change, the initial mount, or an
  // explicit user-triggered runFetch() (the Retry button) — never an
  // automatic background refresh.
  useEffect(() => {
    if (isDevFallback || !organization || !userId) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: same "clear before the async fetch below resolves" pattern used elsewhere in this app (e.g. member-profile-modal.tsx)
    setLoadState("loading");

    (async () => {
      const ticketsResult = await loadOrganizationTickets(organization.id);
      if (cancelled) return;
      if (ticketsResult.status === "error") {
        setLoadState("error");
        setLoadErrorMessage(ticketsResult.message);
        return;
      }

      const myTicketIds = ticketsResult.tickets.filter((t) => t.assigneeProfileId === userId).map((t) => t.id);

      const todayISO = getTodayISO();
      const { start: weekStart, end: weekEnd } = getWeekRangeISO(todayISO);
      const monthStart = `${todayISO.slice(0, 7)}-01`;

      const [activityResult, todayResult, weekResult, monthResult, capacityResult, entriesResult] = await Promise.all([
        loadOrganizationActivity(myTicketIds, RECENT_ACTIVITY_LIMIT),
        loadProfileLoggedTimeForDate(userId, todayISO),
        loadProfileLoggedMinutesForRange(userId, weekStart, weekEnd),
        loadProfileLoggedMinutesForRange(userId, monthStart, todayISO),
        loadMemberWeeklyCapacity(userId, user.weeklyCapacity),
        // Every one of this user's own entries (logged_by = userId) on any
        // ticket they can see — not just tickets currently assigned to them —
        // so the list matches the Today/Week/Month totals above it, which
        // already count all of their own time regardless of assignee.
        loadProfileTimeEntries(userId, ticketsResult.tickets.map((t) => t.id), TIMESHEET_ENTRY_LIMIT),
      ]);
      if (cancelled) return;

      if (activityResult.status === "error") {
        setLoadState("error");
        setLoadErrorMessage(activityResult.message);
        return;
      }
      if (todayResult.status === "error") {
        setLoadState("error");
        setLoadErrorMessage(todayResult.message);
        return;
      }
      if (weekResult.status === "error") {
        setLoadState("error");
        setLoadErrorMessage(weekResult.message);
        return;
      }
      if (monthResult.status === "error") {
        setLoadState("error");
        setLoadErrorMessage(monthResult.message);
        return;
      }
      if (capacityResult.status === "error") {
        setLoadState("error");
        setLoadErrorMessage(capacityResult.message);
        return;
      }
      if (entriesResult.status === "error") {
        setLoadState("error");
        setLoadErrorMessage(entriesResult.message);
        return;
      }

      setTickets(ticketsResult.tickets);
      setProjects(ticketsResult.projects);
      setStatusesBySlug(ticketsResult.statusesBySlug);
      setActivityEvents(activityResult.events);
      setTodayMinutes(todayResult.entries.reduce((sum, e) => sum + e.minutes, 0));
      setWeekMinutes(weekResult.totalMinutes);
      setMonthMinutes(monthResult.totalMinutes);
      setWeeklyCapacity(capacityResult.weeklyCapacity);
      setTimesheetRecords(entriesResult.entries);
      setLoadState("ready");
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDevFallback, organization?.id, userId, requestId, user.weeklyCapacity]);

  // A ticket click now navigates straight to its own Detail page — no more
  // intermediate Preview step. Kept as `openPreview` (not renamed) so every
  // existing call site below needs no change.
  const openPreview = (ticket: Ticket) =>
    router.push(`/projects/${ticket.projectSlug}/tickets/${getTicketDisplayKey(ticket)}`);
  const show        = (section: string) => !focusMode || !FOCUS_MODE_HIDDEN.has(section);

  const todayISO     = getTodayISO();
  const yesterdayISO = getTodayISO(-1);
  const { start: weekStart, end: weekEnd } = getWeekRangeISO(todayISO);

  const myTickets = useMemo(
    () => (userId ? tickets.filter((t) => t.assigneeProfileId === userId) : []),
    [tickets, userId]
  );
  const myTicketsById = useMemo(() => new Map(myTickets.map((t) => [t.id, t])), [myTickets]);
  const projectsBySlug = useMemo(() => new Map(projects.map((p) => [p.slug, p])), [projects]);
  const activeCount = myTickets.filter((t) => !isTicketClosed(t)).length;
  const totalHours = useMemo(() => myTickets.reduce((s, t) => s + (t.hours ?? 0), 0), [myTickets]);
  const blockedTickets = useMemo(() => myTickets.filter((t) => t.status === "blocked"), [myTickets]);
  const dueThisWeekTickets = useMemo(
    () =>
      myTickets
        .filter((t) => isDueThisWeek(t, weekStart, weekEnd))
        .sort((a, b) => parseDisplayDate(a.dueDate as string).localeCompare(parseDisplayDate(b.dueDate as string))),
    [myTickets, weekStart, weekEnd]
  );

  const hoursByStatus = useMemo(
    () => ({
      assigned:   totalHours,
      blocked:    myTickets.filter((t) => t.status === "blocked").reduce((s, t) => s + (t.hours ?? 0), 0),
      inProgress: myTickets.filter((t) => t.status === "in-progress").reduce((s, t) => s + (t.hours ?? 0), 0),
      review:     myTickets.filter((t) => t.status === "review").reduce((s, t) => s + (t.hours ?? 0), 0),
      done:       myTickets.filter((t) => isTicketClosed(t)).reduce((s, t) => s + (t.hours ?? 0), 0),
    }),
    [myTickets, totalHours]
  );
  const remainingEstimatedHours = Math.max(0, totalHours - hoursByStatus.done);

  // The Board tab's own column source (Fase 2.5) — the union, by name, of
  // every one of the member's own projects' real statuses, never assuming
  // two of them share the same configuration (see tickets-screen.tsx's own
  // identical merge for the org-wide "all projects" Board). Declared here
  // (not lower, nearer the Board tab itself) since the Status filter
  // options below also read from it.
  const boardColumnStatuses = useMemo(() => {
    const byName = new Map<string, TicketStatusOption>();
    for (const list of Object.values(statusesBySlug)) {
      for (const option of list) {
        if (!byName.has(option.name)) byName.set(option.name, option);
      }
    }
    const merged = Array.from(byName.values()).sort((a, b) => a.sortOrder - b.sortOrder);
    return merged.length > 0 ? merged : FALLBACK_TICKET_STATUSES;
  }, [statusesBySlug]);

  // Status filter options: every real, configured status across this
  // member's own projects (boardColumnStatuses, already sourced straight
  // from ticket_statuses, sort_order-ordered — see above), never narrowed
  // to values that happen to occur among this member's own tickets. Unlike
  // Priority/Project below, a status with zero tickets right now must
  // still be selectable — it's a real, admin-configured status, not a
  // derived value.
  const statusOptions: DropdownGroup[] = useMemo(
    () => [{ options: boardColumnStatuses.map((s) => ({ value: s.name, label: s.name })) }],
    [boardColumnStatuses]
  );

  const priorityOptions: DropdownGroup[] = useMemo(() => {
    const present = new Set(myTickets.map((t) => t.priority));
    return [{ options: PRIORITY_VALUES.filter((p) => present.has(p)).map((p) => ({ value: p, label: PRIORITY_LABEL[p] })) }];
  }, [myTickets]);

  const projectOptions: DropdownGroup[] = useMemo(() => {
    const seen = new Map<string, string>();
    for (const t of myTickets) {
      if (!seen.has(t.projectSlug)) seen.set(t.projectSlug, projectsBySlug.get(t.projectSlug)?.name ?? t.projectSlug);
    }
    return [{ options: Array.from(seen.entries()).map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label)) }];
  }, [myTickets, projectsBySlug]);

  const labelOptions: DropdownGroup[] = useMemo(() => {
    const set = new Set<string>();
    for (const t of myTickets) for (const l of t.labels) set.add(l);
    return [{ options: Array.from(set).sort().map((l) => ({ value: l, label: l })) }];
  }, [myTickets]);

  // Status/Priority/Project/Labels ANDed together, same multi-select-OR/
  // cross-filter-AND convention tickets-screen.tsx already uses.
  const filteredMyTickets = useMemo(
    () =>
      myTickets.filter((t) => {
        if (statusFilter.length > 0 && !statusFilter.includes(ticketColumnKey(t) ?? "")) return false;
        if (priorityFilter.length > 0 && !priorityFilter.includes(t.priority)) return false;
        if (projectFilter.length > 0 && !projectFilter.includes(t.projectSlug)) return false;
        if (labelFilter.length > 0 && !labelFilter.some((l) => t.labels.includes(l))) return false;
        return true;
      }),
    [myTickets, statusFilter, priorityFilter, projectFilter, labelFilter]
  );

  // KPI cards toggle their own filter; clicking the active one clears it
  function handleKpiClick(mode: KpiMode) {
    setKpiMode((prev) => (prev === mode ? null : mode));
  }

  // "Assigned Tickets" KPI — reuses `myTickets`, the exact same real,
  // per-user (assigneeProfileId === userId) ticket list already driving
  // this KPI's own displayed count, regardless of status — no second
  // query, no duplicated assignee criteria. Same real 0/1/2+ rule already
  // established by the Admin/Member Dashboards' own navigable KPI cards:
  // zero stays non-interactive; exactly one navigates straight to its own
  // Ticket Detail; more than one hands off to the org-wide Tickets view
  // with the real `?assignee=me` filter applied and visible (Tickets'
  // existing "Assigned" filter, already readable from the URL the same way
  // `?alerts=` is — same destination/param the Admin Dashboard's own
  // "Assigned Tickets" KPI already uses for its own "All Projects" case).
  function handleAssignedTicketsClick() {
    if (myTickets.length === 0) return;
    if (myTickets.length === 1) {
      openPreview(myTickets[0]);
      return;
    }
    router.push("/tickets?assignee=me");
  }

  // Displayed tickets: the 4 dropdown filters above, further narrowed by
  // whichever KPI quick-filter is active — so group/board counts always
  // match what's actually visible, never the unfiltered totals the KPI
  // cards themselves show.
  const displayedTickets = useMemo(() => {
    if (kpiMode === "blocked")   return filteredMyTickets.filter((t) => t.status === "blocked");
    if (kpiMode === "due-soon") {
      return filteredMyTickets
        .filter((t) => isDueThisWeek(t, weekStart, weekEnd))
        .sort((a, b) => parseDisplayDate(a.dueDate as string).localeCompare(parseDisplayDate(b.dueDate as string)));
    }
    if (kpiMode === "hours")     return [...filteredMyTickets].sort((a, b) => (b.hours ?? 0) - (a.hours ?? 0));
    return filteredMyTickets;
  }, [filteredMyTickets, kpiMode, weekStart, weekEnd]);


  // Grouped List view's own sections (Fase 2.5) — same merged status set as
  // the Board tab, just re-ordered blocked-first (this list's own
  // deliberate urgency convention, unrelated to sort_order) and with
  // "Inbox" kept as Backlog's display label here only, same as before this
  // phase. `id`/matching stays the real status name (ticketColumnKey),
  // "Inbox" is a label override for this one list, never an actual rename.
  const listGroups = useMemo(() => {
    return [...boardColumnStatuses]
      .sort((a, b) => {
        const pa = (a.legacyEnumValue ? LIST_GROUP_PRIORITY[a.legacyEnumValue] : undefined) ?? 99;
        const pb = (b.legacyEnumValue ? LIST_GROUP_PRIORITY[b.legacyEnumValue] : undefined) ?? 99;
        if (pa !== pb) return pa - pb;
        return a.sortOrder - b.sortOrder;
      })
      .map((option) => ({
        id: option.name,
        label: option.legacyEnumValue === "backlog" ? "Inbox" : option.name,
      }));
  }, [boardColumnStatuses]);

  // Flat list when kpiMode imposes its own order; grouped otherwise
  const useFlatList = kpiMode === "due-soon" || kpiMode === "hours";

  const myRecentActivity: ActivityEntry[] = useMemo(
    () => activityEvents.map((event) => activityEventToEntry(event, myTicketsById.get(event.ticketId), todayISO, yesterdayISO)),
    [activityEvents, myTicketsById, todayISO, yesterdayISO]
  );

  // Any accessible ticket, not only assigned ones — a user's own time can be
  // on a ticket assigned to someone else (or unassigned).
  const allTicketsById = useMemo(() => new Map(tickets.map((t) => [t.id, t])), [tickets]);
  const myTimeEntries: PersonalTimesheetEntry[] = useMemo(
    () =>
      timesheetRecords
        .map((r) => {
          const ticket = allTicketsById.get(r.ticketId);
          if (!ticket) return null;
          return {
            id: r.id,
            ticket,
            // Exact hours, not rounded — round1 here would collapse sub-3-
            // minute entries to 0.0 before the panel's own total sums them
            // (JIR-92). formatHours rounds only for display.
            hours: r.minutes / 60,
            date: formatEntryDateLabel(r.workDate, todayISO, yesterdayISO),
            comment: r.comment,
          };
        })
        .filter((e): e is PersonalTimesheetEntry => e !== null),
    [timesheetRecords, allTicketsById, todayISO, yesterdayISO]
  );

  const weekHours = weekMinutes / 60;
  const capacityPct = weeklyCapacity > 0 ? Math.min(100, Math.round((weekHours / weeklyCapacity) * 100)) : 0;
  const showMyTime = user.role === "MEMBER";

  if (loadState === "loading") {
    return <MyWorkLoadingSkeleton showMyTime={showMyTime} />;
  }

  if (loadState === "error") {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 pb-16">
        <div className="flex flex-col items-center justify-center text-center px-4 py-20">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-zinc-200">Couldn&apos;t load your work</h3>
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
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 pb-16">

      {/* ── Compact page header ─────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4 mb-4 sm:mb-6">
        <div>
          <div className="flex items-center gap-2 mb-0.5">
            <h1 className="text-xl font-bold text-slate-900 dark:text-zinc-50 tracking-tight leading-none">
              My Work
            </h1>
            <span className="text-slate-300 dark:text-zinc-600">·</span>
            <span className="text-sm font-medium text-slate-600 dark:text-zinc-400">
              Good morning, {user.name.split(" ")[0]} 👋
            </span>
          </div>
          <p className="text-xs text-slate-400 dark:text-zinc-500">{formatFullDate(todayISO)}</p>
        </div>

        {/* Focus Mode toggle */}
        <button
          type="button"
          onClick={() => setFocusMode((v) => !v)}
          className={[
            "inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors border flex-shrink-0 self-end sm:self-auto",
            focusMode
              ? "bg-brand-600 text-white border-brand-600 dark:bg-brand-accent dark:border-brand-accent shadow-sm shadow-brand-600/20 dark:shadow-brand-accent/20 dark:text-brand-accent-foreground"
              : "text-slate-600 border-slate-200 hover:bg-slate-50 dark:text-zinc-400 dark:border-zinc-700 dark:hover:bg-zinc-800",
          ].join(" ")}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v4M12 18v4M2 12h4M18 12h4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
          </svg>
          {focusMode ? "Exit Focus" : "Focus Mode"}
        </button>
      </div>

      {/* ── KPI strip ──────────────────────────────────────────────────────── */}
      {show("kpis") && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard
            label="Assigned Tickets"
            value={activeCount}
            sub={`${myTickets.length} total`}
            disabled={myTickets.length === 0}
            onClick={handleAssignedTicketsClick}
          />
          <KpiCard
            label="Estimated Hours"
            value={<>{round1(totalHours)}<span className="text-base font-medium ml-0.5">h</span></>}
            sub="assigned"
            accent
            active={kpiMode === "hours"}
            onClick={() => handleKpiClick("hours")}
          />
          <KpiCard
            label="Blocked"
            value={blockedTickets.length}
            sub={blockedTickets.length > 0 ? "needs attention" : "you're clear"}
            danger={blockedTickets.length > 0}
            active={kpiMode === "blocked"}
            onClick={() => handleKpiClick("blocked")}
          />
          <KpiCard
            label="Due This Week"
            value={dueThisWeekTickets.length}
            sub={`by ${formatISODate(weekEnd)}`}
            active={kpiMode === "due-soon"}
            onClick={() => handleKpiClick("due-soon")}
          />
        </div>
      )}

      {/* ── My Hours breakdown ──────────────────────────────────────────────── */}
      {show("my-hours") && (
        <div className="mt-3 flex items-center gap-5 rounded-xl border border-slate-200 dark:border-zinc-700/70 bg-white dark:bg-zinc-900 px-5 py-3.5 shadow-sm shadow-slate-200/40 dark:shadow-black/20 overflow-x-auto">
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600 flex-shrink-0">
            My Hours
          </p>
          <div className="flex items-center gap-6 flex-1 min-w-0">
            {([
              { label: "Assigned",    value: hoursByStatus.assigned,   cls: "text-slate-900 dark:text-zinc-50" },
              { label: "Blocked",     value: hoursByStatus.blocked,    cls: "text-red-600 dark:text-red-400" },
              { label: "In Progress", value: hoursByStatus.inProgress, cls: "text-amber-600 dark:text-amber-400" },
              { label: "In Review",   value: hoursByStatus.review,     cls: "text-violet-600 dark:text-violet-400" },
              { label: "Done",        value: hoursByStatus.done,       cls: "text-emerald-600 dark:text-emerald-400" },
            ] as const).map(({ label, value, cls }) => (
              <div key={label} className="flex-shrink-0">
                <p className="text-[10px] text-slate-400 dark:text-zinc-600">{label}</p>
                <p className={`text-sm font-bold ${cls}`}>{formatHours(value)}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── My Time (Member only) ───────────────────────────────────────────── */}
      {/* Time tracking isn't a separate module for a Member — it's folded in
          here as a compact summary, with the ticket's own Log Time button
          remaining the only way to actually log time. */}
      {showMyTime && show("my-time") && (
        <div className="mt-3 flex items-center gap-5 rounded-xl border border-slate-200 dark:border-zinc-700/70 bg-white dark:bg-zinc-900 px-5 py-3.5 shadow-sm shadow-slate-200/40 dark:shadow-black/20 overflow-x-auto">
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600 flex-shrink-0">
            My Time
          </p>
          <div className="flex items-center gap-6 flex-1 min-w-0">
            <div className="flex-shrink-0">
              <p className="text-[10px] text-slate-400 dark:text-zinc-600">Logged Today</p>
              <p className="text-sm font-bold text-slate-900 dark:text-zinc-50 tabular-nums">{formatHours(todayMinutes / 60)}</p>
            </div>
            <div className="flex-shrink-0">
              <p className="text-[10px] text-slate-400 dark:text-zinc-600">Logged This Week</p>
              <p className="text-sm font-bold text-slate-900 dark:text-zinc-50 tabular-nums">{formatHours(weekHours)}</p>
            </div>
            <div className="flex-shrink-0">
              <p className="text-[10px] text-slate-400 dark:text-zinc-600">Remaining Estimated</p>
              <p className="text-sm font-bold text-slate-900 dark:text-zinc-50 tabular-nums">{formatHours(remainingEstimatedHours)}</p>
            </div>
            <div className="flex-shrink-0">
              <p className="text-[10px] text-slate-400 dark:text-zinc-600 mb-0.5">Personal Capacity</p>
              <CapacityCell pct={capacityPct} />
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowTimesheet(true)}
            className="flex-shrink-0 text-[11px] font-medium text-brand-600 dark:text-brand-accent hover:underline whitespace-nowrap"
          >
            View Timesheet →
          </button>
        </div>
      )}

      {/* ── My Tickets ─────────────────────────────────────────────────────── */}
      <div className={show("kpis") || show("my-hours") ? "mt-8" : "mt-0"}>
        {/* Toolbar */}
        <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-500 dark:text-zinc-400">
              My Tickets
            </h2>
            <span className="text-[10px] font-semibold text-slate-400 dark:text-zinc-500 bg-slate-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded-full">
              {displayedTickets.length}
            </span>
            <span className="hidden sm:block text-xs text-slate-400 dark:text-zinc-600">
              · {formatHours(totalHours)} estimated
            </span>

            {/* Active KPI filter chip */}
            {kpiMode && kpiMode !== "all" && (
              <button
                type="button"
                onClick={() => setKpiMode(null)}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-brand-600 dark:text-brand-accent bg-brand-50 dark:bg-brand-accent/10 px-2 py-0.5 rounded-full hover:bg-brand-100 dark:hover:bg-brand-accent/20 transition-colors"
              >
                {KPI_MODE_LABELS[kpiMode]}
                <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            <FilterDropdown label="Status"   mode="multi"  groups={statusOptions}   selected={statusFilter}   onChange={setStatusFilter} />
            <FilterDropdown label="Priority" mode="multi"  groups={priorityOptions} selected={priorityFilter} onChange={setPriorityFilter} />
            <FilterDropdown label="Project"  mode="single" groups={projectOptions}  selected={projectFilter}  onChange={setProjectFilter} />
            <FilterDropdown label="Labels"   mode="multi"  groups={labelOptions}    selected={labelFilter}    onChange={setLabelFilter} />

            <div className="w-px h-4 bg-slate-200 dark:bg-zinc-700 mx-1" />

            {/* View toggle */}
            <div className="flex items-center bg-slate-100 dark:bg-zinc-800/80 rounded-lg p-0.5 gap-0.5">
              {(["list", "board"] as WorkView[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  className={[
                    "flex items-center gap-1.5 px-2.5 py-1.5 rounded-[7px] text-xs font-medium transition-all duration-150",
                    view === v
                      ? "bg-white dark:bg-zinc-900 text-slate-900 dark:text-zinc-50 shadow-sm shadow-slate-200/80 dark:shadow-black/40"
                      : "text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-200",
                  ].join(" ")}
                >
                  {VIEW_ICONS[v]}
                  {v.charAt(0).toUpperCase() + v.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Board view */}
        {view === "board" ? (
          <div className="flex flex-col h-[440px]">
            <BoardView tickets={displayedTickets} onTicketClick={openPreview} statuses={boardColumnStatuses} />
          </div>
        ) : useFlatList ? (
          /* Flat list (for due-soon / hours kpiMode) */
          <div className="rounded-xl border border-slate-200 dark:border-zinc-700/70 bg-white dark:bg-zinc-900 overflow-hidden divide-y divide-slate-100 dark:divide-zinc-800">
            {displayedTickets.length === 0 ? (
              <p className="px-5 py-6 text-sm text-slate-400 dark:text-zinc-500">No tickets match this filter.</p>
            ) : (
              displayedTickets.map((ticket) => (
                <TicketListRow key={ticket.id} ticket={ticket} onTicketClick={openPreview} />
              ))
            )}
          </div>
        ) : (
          /* Grouped list */
          <div>
            {displayedTickets.length === 0 && (
              <p className="text-sm text-slate-400 dark:text-zinc-500 py-2">No tickets match this filter.</p>
            )}
            {listGroups.map((group) => {
              const groupTickets = displayedTickets.filter((t) => ticketColumnKey(t) === group.id);
              if (groupTickets.length === 0) return null;
              return (
                <section key={group.id} className="mb-6">
                  <div className="flex items-center gap-3 py-1.5 mb-1">
                    <h3 className="text-[11px] font-bold uppercase tracking-widest text-slate-500 dark:text-zinc-400">
                      {group.label}
                    </h3>
                    <span className="text-xs text-slate-400 dark:text-zinc-500">{groupTickets.length}</span>
                    <div className="flex-1 h-px bg-slate-200 dark:bg-zinc-800" />
                  </div>
                  <div className="rounded-xl border border-slate-200 dark:border-zinc-700/70 bg-white dark:bg-zinc-900 overflow-hidden divide-y divide-slate-100 dark:divide-zinc-800">
                    {groupTickets.map((ticket) => (
                      <TicketListRow key={ticket.id} ticket={ticket} onTicketClick={openPreview} />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Focus sections (hidden in Focus Mode) ──────────────────────────── */}
      {(show("blocked") || show("due-soon")) && (
        <div className="mt-8 grid md:grid-cols-2 gap-5">

          {/* Blocked */}
          {show("blocked") && (
            <Section
              title="Blocked"
              count={blockedTickets.length}
              icon={
                <svg className="w-3.5 h-3.5 text-red-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                </svg>
              }
            >
              {blockedTickets.length === 0 ? (
                <div className="flex items-center gap-2 py-2 text-sm text-slate-400 dark:text-zinc-500">
                  <svg className="w-4 h-4 text-emerald-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                    <path d="M5 12l5 5L20 7" />
                  </svg>
                  You&apos;re all clear.
                </div>
              ) : (
                <div className="space-y-0.5">
                  {blockedTickets.map((t) => (
                    <FocusTicketRow key={t.id} ticket={t} todayISO={todayISO} onOpen={openPreview} />
                  ))}
                </div>
              )}
            </Section>
          )}

          {/* Due Soon */}
          {show("due-soon") && (
            <Section
              title="Due Soon"
              count={dueThisWeekTickets.length}
              icon={
                <svg className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />
                </svg>
              }
            >
              {dueThisWeekTickets.length === 0 ? (
                <p className="text-sm text-slate-400 dark:text-zinc-500 py-2">Nothing due this week.</p>
              ) : (
                <div className="space-y-0.5">
                  {dueThisWeekTickets.map((t) => (
                    <FocusTicketRow key={t.id} ticket={t} todayISO={todayISO} onOpen={openPreview} />
                  ))}
                </div>
              )}
            </Section>
          )}
        </div>
      )}

      {/* ── Recently Updated (with time groups) ────────────────────────────── */}
      {show("activity") && (
        <div className="mt-5">
          <Section title="Recently Updated">
            {myRecentActivity.length === 0 ? (
              <p className="text-sm text-slate-400 dark:text-zinc-500 py-2">No recent activity on your tickets yet.</p>
            ) : (
              <div className="space-y-5">
                {ACTIVITY_GROUPS.map((ag) => {
                  const entries = myRecentActivity.filter((e) => e.group === ag.key);
                  if (entries.length === 0) return null;
                  return (
                    <div key={ag.id}>
                      <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600 mb-2.5">
                        {ag.label}
                      </p>
                      <ul className="space-y-3.5">
                        {entries.map((entry) => (
                          <li key={entry.id} className="flex items-start gap-3">
                            <MemberTrigger name={entry.name} avatar={entry.avatar} profileId={entry.actorProfileId ?? undefined} projectSlug={entry.ticket?.projectSlug} className="flex-shrink-0 mt-0.5 rounded-full">
                              <Avatar src={entry.avatar} name={entry.name} className="w-6 h-6 rounded-full" />
                            </MemberTrigger>
                            <div className="text-sm leading-snug min-w-0 flex-1">
                              <p className="text-slate-700 dark:text-zinc-300">
                                <MemberTrigger name={entry.name} avatar={entry.avatar} profileId={entry.actorProfileId ?? undefined} projectSlug={entry.ticket?.projectSlug} className="font-medium text-slate-900 dark:text-zinc-100 hover:underline">
                                  {entry.name}
                                </MemberTrigger>{" "}
                                {entry.action}
                              </p>
                              {entry.ticket && (
                                <button
                                  type="button"
                                  onClick={() => openPreview(entry.ticket!)}
                                  className="group/ref mt-1 flex items-baseline gap-1.5 min-w-0 max-w-full text-left"
                                >
                                  <TicketTypeIcon type={entry.ticket.type} />
                                  <span className="text-[11px] font-mono font-semibold text-slate-500 dark:text-zinc-400 group-hover/ref:text-brand-600 dark:group-hover/ref:text-brand-400 flex-shrink-0">
                                    {getTicketDisplayKey(entry.ticket)}
                                  </span>
                                  <span className="text-sm font-medium text-slate-700 dark:text-zinc-300 group-hover/ref:text-brand-600 dark:group-hover/ref:text-brand-400 group-hover/ref:underline truncate">
                                    {entry.ticket.title}
                                  </span>
                                </button>
                              )}
                              <p className="text-xs text-slate-400 dark:text-zinc-500 mt-0.5">
                                {entry.time}
                              </p>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            )}
          </Section>
        </div>
      )}

      {/* ── My Timesheet panel ──────────────────────────────────────────────── */}
      {showTimesheet && showMyTime && (
        <PersonalTimesheetPanel
          today={todayMinutes / 60}
          week={weekHours}
          month={monthMinutes / 60}
          entries={myTimeEntries}
          onOpenTicket={(ticket) => {
            setShowTimesheet(false);
            openPreview(ticket);
          }}
          onClose={() => setShowTimesheet(false)}
        />
      )}
    </div>
  );
}
