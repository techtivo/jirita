"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FilterDropdown } from "@/components/tickets/filter-dropdown";
import type { DropdownGroup } from "@/components/tickets/filter-dropdown";
import { useCurrentUser } from "@/components/current-user-provider";
import { ReportStatusBar, KpiCard, Section, BlockCompletion, AnimatedBar } from "@/components/reports-shared";
import type { StatusItem } from "@/components/reports-shared";
import { SkeletonBlock } from "@/components/dashboard-shared";
import { ProjectLeadReportsScreen } from "@/components/project-lead-reports-screen";
import { getTicketDisplayKey } from "@/lib/mock-tickets";
import type { Ticket, TicketStatus, TicketPriority } from "@/lib/mock-tickets";
import type { ProjectStatus, ProjectSummary } from "@/lib/mock-projects";
import { getTodayISO, parseDisplayDate, PriorityBadge, StatusBadge, PRIORITY_VALUES } from "@/components/tickets/ticket-ui";
import { MemberTrigger } from "@/components/member-profile";
import { Avatar } from "@/components/ui/avatar";
import {
  loadOrganizationTickets,
  loadOrganizationLoggedTimeForRange,
  loadHoursAndAssigneeActivityForRange,
  loadTicketsCompletedInRange,
  isTicketClosed,
} from "@/lib/tickets";
import type { OrganizationTimeEntry, HoursOrAssigneeActivityEvent } from "@/lib/tickets";
import {
  loadOrganizationProjects,
  loadOrganizationWorkloadMembers,
  loadOrganizationMemberWeeklyCapacities,
} from "@/lib/projects";
import type { OrgWorkloadMember, MemberWeeklyCapacityEntry } from "@/lib/projects";

// ── Types ─────────────────────────────────────────────────────────────────────

export type Risk    = "on-track" | "at-risk" | "blocked";
type PersonSortKey = "assignedTickets" | "estimatedHours" | "completedHours" | "remainingHours" | "blockedHours" | "capacity";

export interface PersonRow {
  id:              string;
  name:            string;
  avatar:          string;
  assignedTickets: number;
  estimatedHours:  number;
  completedHours:  number;
  blockedHours:    number;
  capacity:        number;
}

export interface ProjectRow {
  id:             string;
  name:           string;
  shortName:      string;
  tickets:        number;
  open:           number;
  completedHours: number;
  estimatedHours: number;
  blocked:        number;
  overdueOpen:    number;
  completion:     number;
  risk:           Risk;
}

interface WorkloadRow {
  id:             string;
  name:           string;
  avatar:         string;
  assignedHours:  number;
  weeklyCapacity: number;
  /** Uncapped real percentage — the bar clamps visually, the text never does. */
  utilizationPct: number;
  /** Real net change in assigned estimated hours this calendar week, derived
   *  only from real ticket_activity rows — null when there's no real signal
   *  to derive it from (never fabricated as 0). */
  weekDelta: number | null;
}

interface HoursEntry {
  id:       string;
  label:    string;
  hours:    number;
  barClass: string;
}

export type PeriodKey = "this-month" | "last-month" | "this-quarter" | "custom";

// ── Billing (Admin-only) ─────────────────────────────────────────────────────

export const PERIOD_OPTIONS: { key: PeriodKey; label: string }[] = [
  { key: "this-month",   label: "This Month" },
  { key: "last-month",   label: "Last Month" },
  { key: "this-quarter", label: "This Quarter" },
  { key: "custom",       label: "Custom Range" },
];

export interface CustomRange {
  from: string; // yyyy-mm-dd, native <input type="date"> format
  to:   string;
}

// Pre-filled with June's bounds so Apply produces a sensible label even if
// nobody touches the fields — matches the "This Month" mock period.
export const DEFAULT_CUSTOM_RANGE: CustomRange = { from: "2026-06-01", to: "2026-06-30" };

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatShortDate(iso: string): string {
  if (!iso) return "";
  const [, month, day] = iso.split("-").map(Number);
  return `${SHORT_MONTHS[month - 1]} ${day}`;
}

export function formatRangeLabel(range: CustomRange): string {
  return `${formatShortDate(range.from)} – ${formatShortDate(range.to)}`;
}

// Real page-header date — "Weekday, Month Day, Year" (e.g. "Wednesday,
// July 15, 2026"). Same real-local-date source (getTodayISO) and the same
// toLocaleDateString pattern already used for this exact style elsewhere
// (the Member Dashboard's own header), just with the year included to
// match this header's existing format.
function formatHeaderDate(todayISO: string): string {
  return new Date(`${todayISO}T00:00:00`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

// Same mock "today" the rest of this report is dated against.
const TODAY = new Date(2026, 5, 30);

function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, days: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + days);
  return copy;
}

type PresetKey = "today" | "this-week" | "this-month" | "last-month" | "this-quarter";

const RANGE_PRESETS: { key: PresetKey; label: string }[] = [
  { key: "today",        label: "Today" },
  { key: "this-week",    label: "This Week" },
  { key: "this-month",   label: "This Month" },
  { key: "last-month",   label: "Last Month" },
  { key: "this-quarter", label: "This Quarter" },
];

function rangeForPreset(preset: PresetKey): CustomRange {
  const year = TODAY.getFullYear();
  const month = TODAY.getMonth();

  switch (preset) {
    case "today":
      return { from: toISO(TODAY), to: toISO(TODAY) };
    case "this-week": {
      const day = TODAY.getDay();
      const start = addDays(TODAY, day === 0 ? -6 : 1 - day); // Monday
      return { from: toISO(start), to: toISO(addDays(start, 6)) };
    }
    case "this-month":
      return { from: toISO(new Date(year, month, 1)), to: toISO(new Date(year, month + 1, 0)) };
    case "last-month":
      return { from: toISO(new Date(year, month - 1, 1)), to: toISO(new Date(year, month, 0)) };
    case "this-quarter": {
      const quarterStartMonth = Math.floor(month / 3) * 3;
      return { from: toISO(new Date(year, quarterStartMonth, 1)), to: toISO(new Date(year, quarterStartMonth + 3, 0)) };
    }
  }
}

// Real date range for the shared "Billing Period" selector — separate from
// rangeForPreset above (which stays dated against the mock TODAY, unrelated
// to Hours by Person and used only to prefill the custom-range popover's
// own quick-pick buttons) so Hours by Person's real Supabase query is
// scoped to the user's actual current date, not the mock report date.
export function realRangeForPeriod(period: PeriodKey, customRange: CustomRange, todayISO: string): CustomRange {
  if (period === "custom") return customRange;
  const [y, m] = todayISO.split("-").map(Number);
  const year = y;
  const month = m - 1;
  if (period === "this-month") {
    return { from: toISO(new Date(year, month, 1)), to: toISO(new Date(year, month + 1, 0)) };
  }
  if (period === "last-month") {
    return { from: toISO(new Date(year, month - 1, 1)), to: toISO(new Date(year, month, 0)) };
  }
  const quarterStartMonth = Math.floor(month / 3) * 3;
  return { from: toISO(new Date(year, quarterStartMonth, 1)), to: toISO(new Date(year, quarterStartMonth + 3, 0)) };
}

function formatCurrency(amount: number): string {
  return `$${amount.toLocaleString("en-US")}`;
}

// Bucket visual config (id/label/color) — same 5 categories, same order,
// same colors as before. Only "hours" becomes real; which real
// TicketStatus values roll into each bucket reuses the exact same
// single-status-per-column mapping the real ticket Board already uses
// (board-view.tsx's COLUMNS) rather than text-matching a status label.
// "backlog" has no column of its own here (Board keeps it as its own
// separate column too) — it's the one real status this widget can't map
// safely to any of these five, so it's excluded from the total/bars
// rather than folded into "To Do".
interface HoursDistributionBucket {
  id:       string;
  label:    string;
  barClass: string;
  statuses: TicketStatus[];
}

const HOURS_DIST_BUCKETS: HoursDistributionBucket[] = [
  { id: "done",        label: "Done",        barClass: "bg-emerald-500",                statuses: ["done"] },
  { id: "in-progress", label: "In Progress", barClass: "bg-amber-400",                  statuses: ["in-progress"] },
  { id: "to-do",       label: "To Do",       barClass: "bg-slate-300 dark:bg-zinc-600", statuses: ["to-do"] },
  { id: "blocked",     label: "Blocked",     barClass: "bg-red-400",                    statuses: ["blocked"] },
  { id: "review",      label: "In Review",   barClass: "bg-violet-500",                 statuses: ["review"] },
];

// Real estimated-hours distribution across the five buckets above, scoped
// to whatever tickets are already in the report's current scope/filters
// (tickets is expected to be the same filteredTickets every other Delivery
// widget already uses). Uses each ticket's own total estimate (never
// logged/remaining hours), 0h for a ticket with no estimate, and counts
// each ticket in at most one bucket (a ticket's status is single-valued,
// so this can never double-count).
function buildHoursDistribution(tickets: Ticket[]): HoursEntry[] {
  return HOURS_DIST_BUCKETS.map((bucket) => ({
    id: bucket.id,
    label: bucket.label,
    barClass: bucket.barClass,
    hours: round1(
      tickets
        .filter((t) => (bucket.statuses as string[]).includes(t.status))
        .reduce((sum, t) => sum + (t.hours ?? 0), 0)
    ),
  }));
}

// ── Filter groups ─────────────────────────────────────────────────────────────

// Used by Project Lead's filter bar only — Admin has the Billing Period
// selector as the single source of truth for the reporting window instead.
const DATE_GROUPS: DropdownGroup[] = [{
  options: [
    { value: "this-week",    label: "This Week" },
    { value: "this-month",   label: "This Month" },
    { value: "last-month",   label: "Last Month" },
    { value: "this-quarter", label: "This Quarter" },
  ],
}];

// Fixed numeric buckets (not a catalog of real "existing values" the way
// Project/Assignee/Client/Status/Priority/Labels are) — kept static, same
// as the period presets. Real filtering against a ticket's actual hours
// happens in hoursInBucket below.
const HOURS_GROUPS: DropdownGroup[] = [{
  options: [
    { value: "0-8",   label: "0 – 8h"   },
    { value: "8-24",  label: "8 – 24h"  },
    { value: "24-48", label: "24 – 48h" },
    { value: "48+",   label: "48h+"     },
  ],
}];

function hoursInBucket(hours: number | undefined, bucket: string): boolean {
  const h = hours ?? 0;
  switch (bucket) {
    case "0-8":   return h <= 8;
    case "8-24":  return h > 8 && h <= 24;
    case "24-48": return h > 24 && h <= 48;
    case "48+":   return h > 48;
    default:      return true;
  }
}

// Real Project/Assignee/Client/Status/Priority/Labels filter option lists
// are built from the org's own real data (see AdminReportsScreen below) —
// no static catalog for any of these six, since the task requires each
// filter to show only values that actually exist in the current report
// scope. Status/Priority keep a fixed real display order/label map (the
// full domain, same labels the rest of the app already uses — e.g.
// "Inbox" for backlog, "In Review" for review) but only the values
// actually present on a real ticket ever appear as options.
const STATUS_FILTER_ORDER: TicketStatus[] = ["backlog", "to-do", "in-progress", "blocked", "review", "done"];
const STATUS_FILTER_LABELS: Record<TicketStatus, string> = {
  backlog:       "Inbox",
  "to-do":       "To Do",
  "in-progress": "In Progress",
  blocked:       "Blocked",
  review:        "In Review",
  done:          "Done",
};

const PRIORITY_FILTER_ORDER: TicketPriority[] = ["highest", "high", "medium", "low"];
const PRIORITY_FILTER_LABELS: Record<TicketPriority, string> = {
  highest: "Highest",
  high:    "High",
  medium:  "Medium",
  low:     "Low",
};

// ReportStatusBar, KpiCard, Section, BlockCompletion, and AnimatedBar all live
// in reports-shared.tsx now — reused as-is by the Project Lead's Reports page.

const RISK_STYLES: Record<Risk, string> = {
  "on-track": "text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10",
  "at-risk":  "text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/10",
  "blocked":  "text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-500/10",
};

const RISK_LABELS: Record<Risk, string> = {
  "on-track": "On Track",
  "at-risk":  "At Risk",
  "blocked":  "Blocked",
};

function RiskBadge({ risk }: { risk: Risk }) {
  return (
    <span className={`inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-full ${RISK_STYLES[risk]}`}>
      {RISK_LABELS[risk]}
    </span>
  );
}

function CapacityCell({ pct }: { pct: number }) {
  const cls =
    pct > 100 ? "text-red-600 dark:text-red-400" :
    pct > 80  ? "text-amber-600 dark:text-amber-400" :
                "text-emerald-600 dark:text-emerald-400";
  return (
    <span className={`font-semibold tabular-nums ${cls}`}>{pct}%</span>
  );
}

// Unlike CapacityCell (where high = overloaded = bad), a high billable
// utilization % is the goal, so the color scale runs the other direction.
function UtilizationCell({ pct }: { pct: number }) {
  const cls =
    pct < 60 ? "text-red-600 dark:text-red-400" :
    pct < 80 ? "text-amber-600 dark:text-amber-400" :
               "text-emerald-600 dark:text-emerald-400";
  return (
    <span className={`font-semibold tabular-nums ${cls}`}>{pct}%</span>
  );
}

type ReportTab = "delivery" | "finance";

const REPORT_TABS: { key: ReportTab; label: string }[] = [
  { key: "delivery", label: "Delivery" },
  { key: "finance",  label: "Finance"  },
];

// Same segmented-pill styling as ViewSwitcher (tickets board/list/etc. toggle)
// so the tab language stays consistent across the app.
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

// Global period selector — reused as-is by the Project Lead's own Reports
// page (see project-lead-reports-screen.tsx) so both screens share one
// implementation.
export function PeriodSelector({
  value,
  onChange,
  customRange,
  onCustomRangeChange,
}: {
  value: PeriodKey;
  onChange: (key: PeriodKey) => void;
  /** The applied custom range — lifted to the parent (rather than kept
   *  purely local) so real-data consumers of the shared period (e.g. Hours
   *  by Person) can read the actual chosen dates, not just that "custom"
   *  was picked. */
  customRange: CustomRange;
  onCustomRangeChange: (range: CustomRange) => void;
}) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [draftRange, setDraftRange] = useState<CustomRange>(customRange);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!popoverOpen) return;
    function onMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setPopoverOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setPopoverOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [popoverOpen]);

  function openCustomRange() {
    setDraftRange(customRange);
    setPopoverOpen(true);
  }

  function applyCustomRange() {
    onCustomRangeChange(draftRange);
    onChange("custom");
    setPopoverOpen(false);
  }

  return (
    <div ref={ref} className="relative inline-block w-full sm:w-auto">
      {/* This Month/Last Month/This Quarter/Custom Range together are wider
          than a Mobile viewport (each button is `whitespace-nowrap` by
          design, so labels never break) — `w-full sm:w-auto` above lets this
          control use its row's full Mobile width instead of shrink-wrapping
          to its own (overflowing) content, and `overflow-x-auto` here scrolls
          the pill internally instead of ever widening the page. Unchanged at
          `sm:`, where it already fits on one line. */}
      <div className="flex sm:inline-flex w-full sm:w-auto overflow-x-auto items-center gap-0.5 rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800/60 p-1">
        {PERIOD_OPTIONS.map((option) => {
          const active = option.key === value;
          const isCustom = option.key === "custom";
          const label = isCustom && active ? formatRangeLabel(customRange) : option.label;
          return (
            <button
              key={option.key}
              type="button"
              onClick={() => {
                if (isCustom) {
                  openCustomRange();
                } else {
                  onChange(option.key);
                  setPopoverOpen(false);
                }
              }}
              className={[
                "text-xs font-medium px-2.5 py-1 rounded-md transition-colors duration-150 whitespace-nowrap",
                active
                  ? "bg-white dark:bg-zinc-900 text-slate-900 dark:text-zinc-50 shadow-sm"
                  : "text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-200",
              ].join(" ")}
            >
              {label}
            </button>
          );
        })}
      </div>

      {popoverOpen && (
        <div
          role="dialog"
          aria-label="Custom date range"
          className="absolute right-0 top-full mt-2 z-30 w-72 rounded-xl border border-slate-200 dark:border-zinc-700/60 bg-white dark:bg-zinc-900 shadow-lg shadow-black/10 dark:shadow-black/40 p-4"
        >
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600 mb-2.5">
            Custom Range
          </p>

          <div className="flex flex-wrap gap-1.5 mb-3">
            {RANGE_PRESETS.map((preset) => (
              <button
                key={preset.key}
                type="button"
                onClick={() => setDraftRange(rangeForPreset(preset.key))}
                className="text-[11px] font-medium px-2 py-1 rounded-full border border-slate-200 dark:border-zinc-700 text-slate-600 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors"
              >
                {preset.label}
              </button>
            ))}
          </div>

          <div className="border-t border-slate-100 dark:border-zinc-800 -mx-4 mb-3" />

          <div className="space-y-3">
            <label className="block">
              <span className="block text-xs font-medium text-slate-500 dark:text-zinc-400 mb-1">From</span>
              <input
                type="date"
                value={draftRange.from}
                onChange={(e) => setDraftRange((r) => ({ ...r, from: e.target.value }))}
                className="w-full text-[16px] sm:text-sm bg-slate-50 dark:bg-zinc-800 text-slate-800 dark:text-zinc-100 rounded-md border border-slate-200 dark:border-zinc-700 px-2.5 py-1.5 outline-none focus:ring-2 focus:ring-brand-500/30 transition-colors dark:focus:ring-brand-accent/30"
              />
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-slate-500 dark:text-zinc-400 mb-1">To</span>
              <input
                type="date"
                value={draftRange.to}
                onChange={(e) => setDraftRange((r) => ({ ...r, to: e.target.value }))}
                className="w-full text-[16px] sm:text-sm bg-slate-50 dark:bg-zinc-800 text-slate-800 dark:text-zinc-100 rounded-md border border-slate-200 dark:border-zinc-700 px-2.5 py-1.5 outline-none focus:ring-2 focus:ring-brand-500/30 transition-colors dark:focus:ring-brand-accent/30"
              />
            </label>
          </div>
          <div className="flex items-center justify-end gap-2 mt-4">
            <button
              type="button"
              onClick={() => setPopoverOpen(false)}
              className="text-xs font-medium px-3 py-1.5 rounded-lg border border-slate-200 dark:border-zinc-700 text-slate-600 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={applyCustomRange}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-brand-500 hover:bg-brand-600 text-white transition-colors shadow-sm shadow-brand-500/30 dark:bg-brand-accent dark:hover:bg-brand-accent-strong dark:shadow-brand-accent/30 dark:text-brand-accent-foreground"
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Sortable column header — shows a chevron on hover (always visible when active)
function SortTh({
  label,
  sortKey,
  currentSort,
  sortDir,
  onSort,
}: {
  label:       string;
  sortKey:     PersonSortKey;
  currentSort: PersonSortKey;
  sortDir:     "asc" | "desc";
  onSort:      (k: PersonSortKey) => void;
}) {
  const active = currentSort === sortKey;
  return (
    <th
      onClick={() => onSort(sortKey)}
      className="pb-2.5 text-right text-[10px] font-bold uppercase tracking-widest cursor-pointer select-none group whitespace-nowrap"
    >
      <span className="inline-flex items-center justify-end gap-1">
        <span className={active ? "text-slate-600 dark:text-zinc-300" : "text-slate-400 dark:text-zinc-600 group-hover:text-slate-500 dark:group-hover:text-zinc-500 transition-colors duration-150"}>
          {label}
        </span>
        <svg
          className={[
            "w-2.5 h-2.5 flex-shrink-0 transition-all duration-150",
            active
              ? "text-slate-500 dark:text-zinc-400 opacity-100"
              : "text-slate-300 dark:text-zinc-600 opacity-0 group-hover:opacity-100",
            active && sortDir === "asc" ? "-rotate-180" : "",
          ].join(" ")}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          viewBox="0 0 24 24"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </span>
    </th>
  );
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// Real "Hours by Person" rows — only people with at least one real ticket
// assigned to them within the current report scope (org-wide, same
// unfiltered scope every other Delivery section already uses — the
// Project/Assignee/etc. filter bar above is cosmetic everywhere else on
// this page too, not just here). "member" lookup skips a profile with no
// resolvable name/avatar rather than fabricating one.
export function buildHoursByPersonRows(
  tickets: Ticket[],
  members: { id: string; name: string; avatar: string }[],
  capacities: { profileId: string; weeklyCapacity: number }[],
  timeEntries: { ticketId: string; loggedBy: string | null; minutes: number }[]
): PersonRow[] {
  const memberById = new Map(members.map((m) => [m.id, m]));
  const capacityByProfileId = new Map(capacities.map((c) => [c.profileId, c.weeklyCapacity]));

  // Minutes logged BY each person ON each ticket, within the period.
  const minutesByPersonTicket = new Map<string, Map<string, number>>();
  for (const entry of timeEntries) {
    if (!entry.loggedBy) continue;
    let byTicket = minutesByPersonTicket.get(entry.loggedBy);
    if (!byTicket) {
      byTicket = new Map();
      minutesByPersonTicket.set(entry.loggedBy, byTicket);
    }
    byTicket.set(entry.ticketId, (byTicket.get(entry.ticketId) ?? 0) + entry.minutes);
  }

  const ticketsByAssignee = new Map<string, Ticket[]>();
  for (const ticket of tickets) {
    if (!ticket.assigneeProfileId) continue;
    const list = ticketsByAssignee.get(ticket.assigneeProfileId) ?? [];
    list.push(ticket);
    ticketsByAssignee.set(ticket.assigneeProfileId, list);
  }

  const rows: PersonRow[] = [];
  for (const [profileId, personTickets] of ticketsByAssignee) {
    const member = memberById.get(profileId);
    if (!member) continue;

    const byTicket = minutesByPersonTicket.get(profileId) ?? new Map<string, number>();

    const estimatedHours = personTickets.reduce((sum, t) => sum + (t.hours ?? 0), 0);
    const completedHours = personTickets.reduce((sum, t) => sum + (byTicket.get(t.id) ?? 0) / 60, 0);
    const blockedHours = personTickets
      .filter((t) => t.status === "blocked")
      .reduce((sum, t) => {
        const loggedHours = (byTicket.get(t.id) ?? 0) / 60;
        return sum + Math.max((t.hours ?? 0) - loggedHours, 0);
      }, 0);

    const weeklyCapacity = capacityByProfileId.get(profileId) ?? 0;
    const capacity = weeklyCapacity > 0 ? Math.round((completedHours / weeklyCapacity) * 100) : 0;

    rows.push({
      id: profileId,
      name: member.name,
      avatar: member.avatar,
      assignedTickets: personTickets.length,
      estimatedHours: round1(estimatedHours),
      completedHours: round1(completedHours),
      blockedHours: round1(blockedHours),
      capacity,
    });
  }

  return rows;
}

// Real "Project Health" rows — only real projects with at least one real
// ticket within the current report scope (same unfiltered org-wide scope
// Hours by Person already uses). "Hours" is logged/estimated, where logged
// is scoped to the shared report period and estimated is the real total
// across the project's own tickets, same split Hours by Person uses.
// Risk reuses dashboard-screen.tsx's own already-established real
// definition for "Projects at Risk" (blocked takes priority over at-risk;
// at-risk = has an overdue, still-open ticket) rather than inventing a new
// one — this table's third state, blocked > 0, is exactly that widget's.
export function buildProjectHealthRows(
  projects: { slug: string; name: string; projectCode: string }[],
  tickets: Ticket[],
  timeEntries: { ticketId: string; minutes: number }[],
  todayISO: string
): ProjectRow[] {
  const minutesByTicketId = new Map<string, number>();
  for (const entry of timeEntries) {
    minutesByTicketId.set(entry.ticketId, (minutesByTicketId.get(entry.ticketId) ?? 0) + entry.minutes);
  }

  const ticketsByProjectSlug = new Map<string, Ticket[]>();
  for (const ticket of tickets) {
    const list = ticketsByProjectSlug.get(ticket.projectSlug) ?? [];
    list.push(ticket);
    ticketsByProjectSlug.set(ticket.projectSlug, list);
  }

  const rows: ProjectRow[] = [];
  for (const project of projects) {
    const projectTickets = ticketsByProjectSlug.get(project.slug) ?? [];
    if (projectTickets.length === 0) continue;

    const estimatedHours = projectTickets.reduce((sum, t) => sum + (t.hours ?? 0), 0);
    const loggedHours = projectTickets.reduce((sum, t) => sum + (minutesByTicketId.get(t.id) ?? 0) / 60, 0);
    const completion = estimatedHours > 0 ? Math.min(100, Math.round((loggedHours / estimatedHours) * 100)) : 0;

    const open = projectTickets.filter((t) => !isTicketClosed(t)).length;
    const blocked = projectTickets.filter((t) => t.status === "blocked").length;
    const overdueOpenCount = projectTickets.filter(
      (t) => !isTicketClosed(t) && t.dueDate && parseDisplayDate(t.dueDate) < todayISO
    ).length;

    const risk: Risk = blocked > 0 ? "blocked" : overdueOpenCount > 0 ? "at-risk" : "on-track";

    rows.push({
      id: project.slug,
      name: project.name,
      shortName: project.projectCode,
      tickets: projectTickets.length,
      open,
      completedHours: round1(loggedHours),
      estimatedHours: round1(estimatedHours),
      blocked,
      overdueOpen: overdueOpenCount,
      completion,
      risk,
    });
  }

  return rows;
}

// Real per-project progress — the exact same ticket-count completion
// formula Project Overview (admin-project-overview.tsx/
// project-lead-project-overview.tsx) already uses for its own progress bar:
// completed ("done") tickets over every real ticket in the project, rounded,
// 0% when the project has no tickets yet (never a fabricated/default
// value). Exported so any other real per-project progress display (e.g. the
// Projects list) reuses this one definition instead of a second/stale one.
export function computeProjectProgressPct(tickets: Ticket[]): number {
  return tickets.length > 0
    ? Math.round((tickets.filter((t) => isTicketClosed(t)).length / tickets.length) * 100)
    : 0;
}

export interface DeliveryKpiSummary {
  activeProjects:     number;
  activeTickets:      number;
  loggedHours:        number;
  estimatedHours:     number;
  hoursBurnPct:       number;
  blockedTickets:     number;
  completedThisMonth: number;
  overdueTickets:     number;
}

// Real top KPI strip — reuses the exact same real rules already
// implemented for Hours by Person and Project Health rather than inventing
// new ones: "active" ticket = status !== "done" (same definition both
// tables already use), "blocked" = status === "blocked", "overdue" =
// status !== "done" && a real due date already in the past (same clause
// buildProjectHealthRows uses for its own at-risk/overdue check), and
// Hours Burn is the exact same registered/estimated/capped-at-100%/0%-
// when-no-estimate formula Project Health's Completion column already
// uses, just totaled org-wide instead of per-project. `completedThisMonth`
// (the field name is kept for the two other real callers below, even
// though it's no longer always "this month" — see next paragraph) defaults
// to the same current-calendar-month/`updated_at` proxy Admin Dashboard
// already established (no `completed_at` column exists) when
// `completedInPeriodCount` isn't supplied — Admin/Project Lead Project
// Overview's own two calls (they have no report period of their own) never
// pass it, so their numbers are completely unchanged by the paragraph below.
//
// AdminReportsScreen's own Delivery tab call *does* pass
// `completedInPeriodCount` — the real count of `status_changed`→`done`
// `ticket_activity` rows within Delivery's own selected report period
// (`loadTicketsCompletedInRange`, the same real transition-to-done signal
// `project-reports-screen.tsx` already uses — never `updated_at` there),
// so "Done This Month"/"Done Last Month"/"Done This Quarter"/"Done in
// Range" always reflects the period actually selected on that tab, not a
// permanently-fixed current month.
export function buildDeliveryKpiSummary(
  tickets: Ticket[],
  projects: { status: ProjectStatus }[],
  timeEntries: { minutes: number }[],
  todayISO: string,
  completedInPeriodCount?: number
): DeliveryKpiSummary {
  const activeProjects = projects.filter((p) => p.status === "active").length;
  const activeTickets = tickets.filter((t) => !isTicketClosed(t)).length;

  const estimatedHours = round1(tickets.reduce((sum, t) => sum + (t.hours ?? 0), 0));
  const loggedMinutes = timeEntries.reduce((sum, e) => sum + e.minutes, 0);
  const loggedHours = round1(loggedMinutes / 60);
  const hoursBurnPct = estimatedHours > 0 ? Math.min(100, Math.round((loggedHours / estimatedHours) * 100)) : 0;

  const blockedTickets = tickets.filter((t) => t.status === "blocked").length;

  const monthPrefix = todayISO.slice(0, 7);
  const completedThisMonth =
    completedInPeriodCount !== undefined
      ? completedInPeriodCount
      : tickets.filter((t) => isTicketClosed(t) && t.updatedAtISO?.slice(0, 7) === monthPrefix).length;

  const overdueTickets = tickets.filter(
    (t) => !isTicketClosed(t) && t.dueDate && parseDisplayDate(t.dueDate) < todayISO
  ).length;

  return {
    activeProjects,
    activeTickets,
    loggedHours,
    estimatedHours,
    hoursBurnPct,
    blockedTickets,
    completedThisMonth,
    overdueTickets,
  };
}

export interface FinanceKpiSummary {
  billableHours:     number;
  nonBillableHours:  number;
  utilizationPct:    number;
  estimatedRevenue:  number;
}

// Real Finance KPI strip — billable/non-billable status is inherited
// exclusively from the project's own real category (Project Settings'
// "client"/"internal"), never a per-time-entry flag (none exists). Reuses
// the exact same real tickets/projects/time-entries state Delivery's own
// shared fetch already loads for the same Billing Period (no separate
// query). A ticket whose project can no longer be resolved contributes to
// neither total rather than being guessed into one.
// Exported so Time Tracking (a separate module/page) can reuse this exact
// billable/non-billable rule instead of a second implementation of it.
export function buildFinanceKpiSummary(
  tickets: Ticket[],
  projects: { slug: string; category: string; defaultHourlyRate?: number }[],
  timeEntries: { ticketId: string; minutes: number }[]
): FinanceKpiSummary {
  const projectBySlug = new Map(projects.map((p) => [p.slug, p]));
  const ticketById = new Map(tickets.map((t) => [t.id, t]));

  const minutesByProjectSlug = new Map<string, number>();
  for (const entry of timeEntries) {
    const ticket = ticketById.get(entry.ticketId);
    if (!ticket) continue;
    minutesByProjectSlug.set(ticket.projectSlug, (minutesByProjectSlug.get(ticket.projectSlug) ?? 0) + entry.minutes);
  }

  let billableMinutes = 0;
  let nonBillableMinutes = 0;
  let estimatedRevenue = 0;

  for (const [slug, minutes] of minutesByProjectSlug) {
    const project = projectBySlug.get(slug);
    if (!project) continue;

    if (project.category === "client") {
      billableMinutes += minutes;
      // A Client project with no real billing_rate contributes $0 revenue
      // (its hours still count as billable) — never a guessed/default rate.
      estimatedRevenue += (minutes / 60) * (project.defaultHourlyRate ?? 0);
    } else {
      nonBillableMinutes += minutes;
    }
  }

  const billableHours = round1(billableMinutes / 60);
  const nonBillableHours = round1(nonBillableMinutes / 60);
  const totalLoggedHours = billableHours + nonBillableHours;
  const utilizationPct = totalLoggedHours > 0 ? Math.round((billableHours / totalLoggedHours) * 100) : 0;

  return {
    billableHours,
    nonBillableHours,
    utilizationPct,
    estimatedRevenue: Math.round(estimatedRevenue),
  };
}

export interface BillingClientRow {
  id:                string;
  client:            string;
  billableHours:     number;
  nonBillableHours:  number;
  /** 0 => the existing "—" empty state (no billable hours, or no project of
   *  this client's had a real rate). */
  avgRate:           number;
  estimatedInvoice:  number;
}

// Real "Billing Overview" rows — same real tickets/projects/timeEntries as
// buildFinanceKpiSummary above (never a parallel query or a different
// billable/internal rule). Client rows are grouped by each Client-category
// project's own real client name; every Internal-category project's real
// hours consolidate into one "Internal" row (never attributed to any
// client — no real association exists in this schema). A client/Internal
// group with zero real minutes in the period never gets a row at all.
// Exported for Time Tracking's own Billing by Client widget — see the note
// on buildFinanceKpiSummary above.
export function buildBillingOverviewRows(
  tickets: Ticket[],
  projects: { slug: string; category: string; client?: string; defaultHourlyRate?: number }[],
  timeEntries: { ticketId: string; minutes: number }[]
): BillingClientRow[] {
  const projectBySlug = new Map(projects.map((p) => [p.slug, p]));
  const ticketById = new Map(tickets.map((t) => [t.id, t]));

  const minutesByProjectSlug = new Map<string, number>();
  for (const entry of timeEntries) {
    const ticket = ticketById.get(entry.ticketId);
    if (!ticket) continue;
    minutesByProjectSlug.set(ticket.projectSlug, (minutesByProjectSlug.get(ticket.projectSlug) ?? 0) + entry.minutes);
  }

  const clientAgg = new Map<string, { billableHours: number; revenue: number }>();
  let internalMinutes = 0;

  for (const [slug, minutes] of minutesByProjectSlug) {
    const project = projectBySlug.get(slug);
    if (!project) continue;

    if (project.category === "client") {
      const clientName = project.client && project.client.trim() ? project.client : "Unassigned Client";
      const hours = minutes / 60;
      const revenue = hours * (project.defaultHourlyRate ?? 0);
      const agg = clientAgg.get(clientName) ?? { billableHours: 0, revenue: 0 };
      agg.billableHours += hours;
      agg.revenue += revenue;
      clientAgg.set(clientName, agg);
    } else {
      internalMinutes += minutes;
    }
  }

  const rows: BillingClientRow[] = Array.from(clientAgg.entries()).map(([client, agg]) => ({
    id: client,
    client,
    billableHours: round1(agg.billableHours),
    nonBillableHours: 0,
    avgRate: agg.billableHours > 0 ? Math.round(agg.revenue / agg.billableHours) : 0,
    estimatedInvoice: Math.round(agg.revenue),
  }));

  rows.sort((a, b) => b.estimatedInvoice - a.estimatedInvoice);

  if (internalMinutes > 0) {
    rows.push({
      id: "internal",
      client: "Internal",
      billableHours: 0,
      nonBillableHours: round1(internalMinutes / 60),
      avgRate: 0,
      estimatedInvoice: 0,
    });
  }

  return rows;
}

export interface MemberBillingRowReal {
  id:                string;
  name:              string;
  avatar:            string;
  billableHours:     number;
  nonBillableHours:  number;
  utilizationPct:    number;
  estimatedRevenue:  number;
}

// Real "Billable Hours by Member" rows — the exact same real
// tickets/projects/timeEntries as buildFinanceKpiSummary/buildBillingOverviewRows
// above, just grouped by who logged the time (timeEntries already carries
// loggedBy — no new query). Revenue is computed per (person, project)
// before summing, since one person can log time on several Client projects
// at different rates. Only people who resolve to a real org member (never a
// fabricated name/avatar) and have real logged minutes in the period get a
// row.
// Exported for Time Tracking's per-member Billable/Non-Billable columns —
// see the note on buildFinanceKpiSummary above.
export function buildBillableHoursByMemberRows(
  tickets: Ticket[],
  projects: { slug: string; category: string; defaultHourlyRate?: number }[],
  timeEntries: { ticketId: string; loggedBy: string | null; minutes: number }[],
  members: { id: string; name: string; avatar: string }[]
): MemberBillingRowReal[] {
  const projectBySlug = new Map(projects.map((p) => [p.slug, p]));
  const ticketById = new Map(tickets.map((t) => [t.id, t]));
  const memberById = new Map(members.map((m) => [m.id, m]));

  const agg = new Map<string, { billableMinutes: number; nonBillableMinutes: number; revenue: number }>();

  for (const entry of timeEntries) {
    if (!entry.loggedBy) continue;
    const ticket = ticketById.get(entry.ticketId);
    if (!ticket) continue;
    const project = projectBySlug.get(ticket.projectSlug);
    if (!project) continue;

    const personAgg = agg.get(entry.loggedBy) ?? { billableMinutes: 0, nonBillableMinutes: 0, revenue: 0 };
    if (project.category === "client") {
      personAgg.billableMinutes += entry.minutes;
      personAgg.revenue += (entry.minutes / 60) * (project.defaultHourlyRate ?? 0);
    } else {
      personAgg.nonBillableMinutes += entry.minutes;
    }
    agg.set(entry.loggedBy, personAgg);
  }

  const rows: MemberBillingRowReal[] = [];
  for (const [profileId, data] of agg) {
    const member = memberById.get(profileId);
    if (!member) continue;

    const billableHours = round1(data.billableMinutes / 60);
    const nonBillableHours = round1(data.nonBillableMinutes / 60);
    const totalHours = billableHours + nonBillableHours;
    const utilizationPct = totalHours > 0 ? Math.round((billableHours / totalHours) * 100) : 0;

    rows.push({
      id: profileId,
      name: member.name,
      avatar: member.avatar,
      billableHours,
      nonBillableHours,
      utilizationPct,
      estimatedRevenue: Math.round(data.revenue),
    });
  }

  return rows.sort((a, b) => b.billableHours - a.billableHours);
}

// Real alerts banner — sourced directly from the exact same real values
// already shown by the KPI strip (kpiSummary.overdueTickets/blockedTickets/
// completedThisMonth) and Hours by Person (personRows' own capacity, for
// "developers overloaded"), never re-derived with different queries/rules
// (in particular, "blocked" here is the same real ticket-level count the
// Blocked KPI shows — not a project-level derivation, which is what made
// the banner disagree with the KPIs before). Every real condition that
// applies is shown (no arbitrary cap), so a positive "tickets completed"
// item can never crowd out a critical one. Falls back to the neutral "no
// alerts" item only when there is truly nothing real to show — including
// while the KPI strip's own fetch hasn't resolved yet (kpiSummary is null
// only during loading/error, matching that section's own real state).
export function buildDeliveryStatusItems(
  personRows: PersonRow[],
  kpiSummary: DeliveryKpiSummary | null
): StatusItem[] {
  if (!kpiSummary) {
    return [{ id: "none", level: "ok", text: "No health alerts right now." }];
  }

  const items: StatusItem[] = [];

  if (kpiSummary.overdueTickets > 0) {
    items.push({
      id:    "overdue",
      level: "critical",
      text:  `${kpiSummary.overdueTickets} ticket${kpiSummary.overdueTickets !== 1 ? "s" : ""} overdue`,
    });
  }

  if (kpiSummary.blockedTickets > 0) {
    items.push({
      id:    "blocked",
      level: "critical",
      text:  `${kpiSummary.blockedTickets} ticket${kpiSummary.blockedTickets !== 1 ? "s" : ""} blocked`,
    });
  }

  const overloadedCount = personRows.filter((p) => p.capacity > 100).length;
  if (overloadedCount > 0) {
    items.push({
      id:    "overloaded",
      level: "warning",
      text:  `${overloadedCount} developer${overloadedCount !== 1 ? "s" : ""} overloaded`,
    });
  }

  if (kpiSummary.completedThisMonth > 0) {
    items.push({
      id:    "completed",
      level: "ok",
      text:  `${kpiSummary.completedThisMonth} ticket${kpiSummary.completedThisMonth !== 1 ? "s" : ""} completed`,
    });
  }

  if (items.length === 0) {
    return [{ id: "none", level: "ok", text: "No health alerts right now." }];
  }

  return items;
}

// Monday–Sunday bounds of the real current calendar week (never the
// selected report period) — end is exclusive (next Monday), for a plain
// timestamptz .gte/.lt range query. Same convention as the rest of this
// app's "this week" calculations, just seeded from the real current date.
function getCurrentWeekBounds(): { start: string; end: string } {
  const todayISO = getTodayISO();
  const today = new Date(`${todayISO}T00:00:00`);
  const day = today.getDay();
  const monday = new Date(today);
  monday.setDate(today.getDate() + (day === 0 ? -6 : 1 - day));
  const nextMonday = new Date(monday);
  nextMonday.setDate(monday.getDate() + 7);
  const toISODate = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { start: toISODate(monday), end: toISODate(nextMonday) };
}

// Exclusive upper bound (date-only, the day right after the given date) for
// a real inclusive-start/exclusive-end `ticket_activity` range query — same
// date-only-bounds convention getCurrentWeekBounds above already uses, just
// for the Delivery tab's own selected report period instead of a fixed
// "this week".
function exclusiveEndDate(dateISO: string): string {
  const d = new Date(`${dateISO}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Real "Workload" rows — only people with at least one real active
// (status !== "done") ticket assigned to them within the current report
// scope. Reuses the exact same real weekly-capacity source as Hours by
// Person/Team — organization_memberships.weekly_capacity, the single
// org-wide source of truth (see loadOrganizationMemberWeeklyCapacities),
// never project_memberships.weekly_capacity and never summed across
// however many projects a member is staffed on.
// "Variación de esta semana" is derived only from real hours_changed/
// assignee_changed ticket_activity rows on tickets currently in scope for
// that person — a person with zero such events this week gets weekDelta:
// null (never a fabricated 0).
function buildWorkloadRows(
  tickets: Ticket[],
  members: { id: string; name: string; avatar: string }[],
  capacities: { profileId: string; weeklyCapacity: number }[],
  timeEntries: { ticketId: string; minutes: number }[],
  activityEvents: HoursOrAssigneeActivityEvent[]
): WorkloadRow[] {
  const memberById = new Map(members.map((m) => [m.id, m]));
  const capacityByProfileId = new Map(capacities.map((c) => [c.profileId, c.weeklyCapacity]));

  const loggedMinutesByTicketId = new Map<string, number>();
  for (const entry of timeEntries) {
    loggedMinutesByTicketId.set(entry.ticketId, (loggedMinutesByTicketId.get(entry.ticketId) ?? 0) + entry.minutes);
  }

  const activeTicketById = new Map<string, Ticket>();
  const activeTicketsByAssignee = new Map<string, Ticket[]>();
  for (const ticket of tickets) {
    if (isTicketClosed(ticket) || !ticket.assigneeProfileId) continue;
    activeTicketById.set(ticket.id, ticket);
    const list = activeTicketsByAssignee.get(ticket.assigneeProfileId) ?? [];
    list.push(ticket);
    activeTicketsByAssignee.set(ticket.assigneeProfileId, list);
  }

  const deltaByProfileId = new Map<string, number>();
  const hasSignalByProfileId = new Set<string>();
  function addDelta(profileId: string | null, amount: number) {
    if (!profileId) return;
    deltaByProfileId.set(profileId, (deltaByProfileId.get(profileId) ?? 0) + amount);
    hasSignalByProfileId.add(profileId);
  }

  for (const event of activityEvents) {
    const ticket = activeTicketById.get(event.ticketId);
    if (event.eventType === "hours_changed") {
      if (!ticket || !ticket.assigneeProfileId) continue;
      const oldHours = event.oldValue !== null ? Number(event.oldValue) : 0;
      const newHours = event.newValue !== null ? Number(event.newValue) : 0;
      if (!Number.isFinite(oldHours) || !Number.isFinite(newHours)) continue;
      addDelta(ticket.assigneeProfileId, newHours - oldHours);
    } else {
      // assignee_changed — the ticket's own current real hours is the only
      // real figure available for what it added/removed from each side.
      const ticketHours = ticket?.hours ?? 0;
      if (event.newValue) addDelta(event.newValue, ticketHours);
      if (event.oldValue) addDelta(event.oldValue, -ticketHours);
    }
  }

  const rows: WorkloadRow[] = [];
  for (const [profileId, personTickets] of activeTicketsByAssignee) {
    const member = memberById.get(profileId);
    if (!member) continue;

    // Same official assigned-hours-over-capacity definition Team/Dashboards/
    // Member Profile Modal/Project Lead Time Tracking already share: the
    // plain sum of each active ticket's own real `hours` estimate, never
    // netted against hours already logged this period (that would make
    // this "remaining work," a different, already-real concept —
    // buildHoursByPersonRows' own blockedHours further below).
    const assignedHours = personTickets.reduce((sum, t) => sum + (t.hours ?? 0), 0);

    const weeklyCapacity = capacityByProfileId.get(profileId) ?? 0;
    const utilizationPct = weeklyCapacity > 0 ? Math.round((assignedHours / weeklyCapacity) * 100) : 0;
    const weekDelta = hasSignalByProfileId.has(profileId) ? round1(deltaByProfileId.get(profileId) ?? 0) : null;

    rows.push({
      id: profileId,
      name: member.name,
      avatar: member.avatar,
      assignedHours: round1(assignedHours),
      weeklyCapacity,
      utilizationPct,
      weekDelta,
    });
  }

  return rows.sort((a, b) => b.utilizationPct - a.utilizationPct);
}

// Real tickets grouped by real profileId — never by name/avatar/email. A
// ticket belongs to a member's group when EITHER is true: (a) it's
// currently assigned to them and not Done, or (b) they logged real time on
// it within the active period, regardless of who (if anyone) it's
// currently assigned to or whether it's since moved to Done — real
// historical work a ticket's current assignee/status alone would hide
// (reassigned, unassigned, or completed since). A ticket satisfying both
// rules for the same member still appears once, with hours summed once
// (see addTicketToGroup's own dedupe below). The same ticket can
// legitimately appear in more than one member's group when more than one
// person logged real time on it — each group only ever shows that group's
// own member's hours, never another's. `t.assignee` (name/avatar) is
// already resolved to a real value by rowToTicket (lib/tickets.ts) for
// every real ticket, reused as-is (with the org member roster) rather than
// re-deriving identity here.
export interface MemberTicketRow {
  ticket: Ticket;
  /** Real hours this exact group's own member logged on this exact ticket
   *  — never the ticket's own `hours` estimate, never assigned/capacity
   *  hours, and never another assignee's own logged time on the same
   *  ticket. Summed from real `ticket_time_entries` rows already scoped to
   *  the active Period and every other Delivery filter (see
   *  `filteredTimeEntries`, reused as-is — no second query). */
  loggedHours: number;
}

export interface MemberTicketGroup {
  key: string;
  profileId: string | null;
  name: string;
  avatar: string;
  tickets: MemberTicketRow[];
  /** This group's own member's exact logged minutes across the listed
   *  tickets, converted and rounded once — never a sum of the per-ticket
   *  values already rounded for display. */
  totalLoggedHours: number;
}

function compareTicketsForMemberGroup(a: Ticket, b: Ticket, todayISO: string): number {
  const aBlocked = a.status === "blocked" ? 0 : 1;
  const bBlocked = b.status === "blocked" ? 0 : 1;
  if (aBlocked !== bBlocked) return aBlocked - bBlocked;

  const aOverdue = a.dueDate && parseDisplayDate(a.dueDate) < todayISO ? 0 : 1;
  const bOverdue = b.dueDate && parseDisplayDate(b.dueDate) < todayISO ? 0 : 1;
  if (aOverdue !== bOverdue) return aOverdue - bOverdue;

  const aPriorityIdx = PRIORITY_VALUES.indexOf(a.priority);
  const bPriorityIdx = PRIORITY_VALUES.indexOf(b.priority);
  if (aPriorityIdx !== bPriorityIdx) return aPriorityIdx - bPriorityIdx;

  const aDue = a.dueDate ? parseDisplayDate(a.dueDate) : null;
  const bDue = b.dueDate ? parseDisplayDate(b.dueDate) : null;
  if (aDue !== bDue) {
    if (!aDue) return 1;
    if (!bDue) return -1;
    return aDue < bDue ? -1 : 1;
  }

  return getTicketDisplayKey(a).localeCompare(getTicketDisplayKey(b));
}

// Exported so Project Lead's own Reports page (project-lead-reports-screen.tsx)
// reuses this exact grouping/dedup/hours logic instead of a second
// implementation — see that file's own Tickets by Member block.
export function buildTicketsByMember(
  tickets: Ticket[],
  timeEntries: OrganizationTimeEntry[],
  members: OrgWorkloadMember[],
  todayISO: string
): MemberTicketGroup[] {
  // Real logged minutes per (ticketId, profileId) pair, from the exact same
  // already-period/filter-scoped time entries every other Delivery widget
  // reads from — one pass, never a query per ticket or member. `loggedBy`
  // can be null (a real, profile-less entry); collapsed to "" so it's only
  // ever attributed to Unassigned, never a real person.
  const minutesByTicketAndProfile = new Map<string, number>();
  // Real, identified (non-null loggedBy) profileIds who logged time on each
  // real ticket within the period — drives which member groups a ticket
  // historically belongs to regardless of its current assignee/status, and
  // keeps a currently-unassigned ticket out of Unassigned once a real
  // member's hours are attached to it.
  const loggedProfileIdsByTicket = new Map<string, Set<string>>();

  for (const entry of timeEntries) {
    const profileKey = entry.loggedBy ?? "";
    const minuteKey = `${entry.ticketId}|${profileKey}`;
    minutesByTicketAndProfile.set(minuteKey, (minutesByTicketAndProfile.get(minuteKey) ?? 0) + entry.minutes);
    if (entry.loggedBy) {
      const set = loggedProfileIdsByTicket.get(entry.ticketId) ?? new Set<string>();
      set.add(entry.loggedBy);
      loggedProfileIdsByTicket.set(entry.ticketId, set);
    }
  }

  // Real name/avatar per profileId — the org-wide roster first (covers
  // every real member regardless of whether they're a given ticket's
  // *current* assignee), each real ticket's own already-resolved
  // `assignee` as a fallback for any real assignee the roster doesn't
  // carry. Never a placeholder/`unknown-*` — see addTicketToGroup below.
  const identityByProfileId = new Map<string, { name: string; avatar: string }>();
  for (const m of members) identityByProfileId.set(m.id, { name: m.name, avatar: m.avatar });
  for (const t of tickets) {
    if (t.assigneeProfileId && !identityByProfileId.has(t.assigneeProfileId)) {
      identityByProfileId.set(t.assigneeProfileId, { name: t.assignee.name, avatar: t.assignee.avatar });
    }
  }

  const groupsByKey = new Map<string, MemberTicketGroup>();
  const includedTicketIdsByGroup = new Map<string, Set<string>>();
  // Exact minutes per group, so a group's total is rounded once from the
  // real sum — never a sum of per-ticket values already rounded to 0.1.
  const minutesByGroup = new Map<string, number>();

  function addTicketToGroup(t: Ticket, key: string, profileId: string | null) {
    let seen = includedTicketIdsByGroup.get(key);
    if (!seen) {
      seen = new Set<string>();
      includedTicketIdsByGroup.set(key, seen);
    }
    if (seen.has(t.id)) return; // already included — never a second row, never double-counted hours

    let group = groupsByKey.get(key);
    if (!group) {
      const name = profileId === null ? t.assignee.name : identityByProfileId.get(profileId)?.name;
      const avatar = profileId === null ? t.assignee.avatar : identityByProfileId.get(profileId)?.avatar;
      // A real profileId that resolves to no real name/avatar (neither the
      // org roster nor any real ticket's own assignee) is skipped rather
      // than shown with a guessed/placeholder identity.
      if (name === undefined || avatar === undefined) return;
      group = { key, profileId, name, avatar, tickets: [], totalLoggedHours: 0 };
      groupsByKey.set(key, group);
    }

    seen.add(t.id);
    const minutes = minutesByTicketAndProfile.get(`${t.id}|${profileId ?? ""}`) ?? 0;
    minutesByGroup.set(key, (minutesByGroup.get(key) ?? 0) + minutes);
    group.tickets.push({ ticket: t, loggedHours: round1(minutes / 60) });
  }

  for (const t of tickets) {
    const loggedProfileIds = loggedProfileIdsByTicket.get(t.id);

    // Rule (a): currently assigned to a real member, and not Done.
    if (t.assigneeProfileId && !isTicketClosed(t)) {
      addTicketToGroup(t, t.assigneeProfileId, t.assigneeProfileId);
    }

    // Rule (b): any real member who logged time on this ticket within the
    // period — independent of current assignee/status (covers reassigned,
    // unassigned, and Done-but-worked-on-this-period tickets alike).
    if (loggedProfileIds) {
      for (const profileId of loggedProfileIds) {
        addTicketToGroup(t, profileId, profileId);
      }
    }

    // Unassigned: only ever tickets with no *current* assignee, and only
    // when no real identified member's hours are already attached to it
    // (that ticket belongs in their group(s) via rule (b) instead) — same
    // "not Done, unless real hours were logged on it this period" shape as
    // rules (a)/(b), just for "no one."
    if (t.assigneeProfileId == null && !loggedProfileIds) {
      const hasUnattributedHours = (minutesByTicketAndProfile.get(`${t.id}|`) ?? 0) > 0;
      if (!isTicketClosed(t) || hasUnattributedHours) {
        addTicketToGroup(t, "unassigned", null);
      }
    }
  }

  for (const group of groupsByKey.values()) {
    group.tickets.sort((a, b) => compareTicketsForMemberGroup(a.ticket, b.ticket, todayISO));
    // The group's exact minutes (only ever this group's own member's
    // logged_by entries on the tickets listed), rounded once for display.
    group.totalLoggedHours = round1((minutesByGroup.get(group.key) ?? 0) / 60);
  }

  return Array.from(groupsByKey.values()).sort((a, b) => {
    if (a.key === "unassigned") return 1;
    if (b.key === "unassigned") return -1;
    if (a.tickets.length !== b.tickets.length) return b.tickets.length - a.tickets.length;
    return a.name.localeCompare(b.name);
  });
}

// ── Export (Delivery tab only) ───────────────────────────────────────────────
// Every field below is read straight from state/memos AdminReportsScreen
// already computed for the widgets themselves (kpiSummary, statusItems,
// personRows, projectRows, workloadRows, hoursDistribution, ticketsByMember)
// — no export-specific query, no recomputation with different rules.

interface DeliveryExportData {
  periodLabel:       string;
  filterSummary:      string;
  statusItems:        StatusItem[];
  kpiSummary:         DeliveryKpiSummary | null;
  personRows:         PersonRow[];
  projectRows:        ProjectRow[];
  workloadRows:       WorkloadRow[];
  hoursDistribution:  HoursEntry[];
  hoursDistTotal:     number;
  ticketsByMember:    MemberTicketGroup[];
}

interface ExportSection {
  title: string;
  headers?: string[];
  rows: string[][];
}

const RISK_EXPORT_LABEL: Record<Risk, string> = {
  "on-track": "On Track",
  "at-risk":  "At Risk",
  "blocked":  "Blocked",
};

// Turns the same real data the widgets render into a flat, format-agnostic
// section list — the one place CSV/Excel/PDF all read from, so the three
// formats can never disagree with each other or with the page.
function buildDeliveryExportSections(data: DeliveryExportData): ExportSection[] {
  const sections: ExportSection[] = [];

  sections.push({
    title: "KPIs",
    headers: ["Metric", "Value"],
    rows: data.kpiSummary
      ? [
          ["Projects (active)", String(data.kpiSummary.activeProjects)],
          ["Active Tickets", String(data.kpiSummary.activeTickets)],
          [
            "Hours Burn",
            `${data.kpiSummary.loggedHours}h / ${data.kpiSummary.estimatedHours}h (${data.kpiSummary.hoursBurnPct}%)`,
          ],
          ["Blocked", String(data.kpiSummary.blockedTickets)],
          ["Done This Month", String(data.kpiSummary.completedThisMonth)],
          ["Overdue", String(data.kpiSummary.overdueTickets)],
        ]
      : [],
  });

  sections.push({
    title: "Health Alerts",
    headers: ["Alert"],
    rows: data.statusItems.map((item) => [item.text]),
  });

  sections.push({
    title: "Hours by Person",
    headers: ["Person", "Tickets", "Est. Hours", "Completed", "Remaining", "Blocked", "Capacity"],
    rows: data.personRows.map((r) => [
      r.name,
      String(r.assignedTickets),
      `${r.estimatedHours}h`,
      `${r.completedHours}h`,
      `${round1(Math.max(r.estimatedHours - r.completedHours, 0))}h`,
      r.blockedHours > 0 ? `${r.blockedHours}h` : "",
      `${r.capacity}%`,
    ]),
  });

  sections.push({
    title: "Project Health",
    headers: ["Project", "Tickets", "Hours (logged / est.)", "Blocked", "Completion", "Risk"],
    rows: data.projectRows.map((r) => [
      r.name,
      String(r.tickets),
      `${r.completedHours}h / ${r.estimatedHours}h`,
      r.blocked > 0 ? String(r.blocked) : "",
      `${r.completion}%`,
      RISK_EXPORT_LABEL[r.risk],
    ]),
  });

  sections.push({
    title: "Workload",
    headers: ["Person", "Assigned Hours", "Weekly Capacity", "Utilization", "Change This Week"],
    rows: data.workloadRows.map((r) => [
      r.name,
      `${round1(r.assignedHours)}h`,
      `${round1(r.weeklyCapacity)}h`,
      `${r.utilizationPct}%`,
      r.weekDelta === null ? "No data this week" : `${r.weekDelta > 0 ? "+" : ""}${r.weekDelta}h this week`,
    ]),
  });

  sections.push({
    title: "Hours Distribution",
    headers: ["Category", "Hours", "Percent"],
    rows: [
      ...data.hoursDistribution.map((entry) => [
        entry.label,
        `${entry.hours}h`,
        `${data.hoursDistTotal > 0 ? Math.round((entry.hours / data.hoursDistTotal) * 100) : 0}%`,
      ]),
      ["Total", `${data.hoursDistTotal}h`, ""],
    ],
  });

  sections.push({
    title: "Tickets by Member",
    headers: ["Member", "Ticket", "Title", "Priority", "Status", "Due Date", "Hours Logged"],
    rows: data.ticketsByMember.flatMap((group) =>
      group.tickets.map(({ ticket: t, loggedHours }) => [
        group.name,
        getTicketDisplayKey(t),
        t.title,
        PRIORITY_FILTER_LABELS[t.priority],
        STATUS_FILTER_LABELS[t.status],
        t.dueDate ?? "",
        `${loggedHours}h`,
      ])
    ),
  });

  return sections;
}

function buildExportMeta(data: DeliveryExportData): string[] {
  return [
    "Jirita — Delivery Report",
    `Period: ${data.periodLabel}`,
    `Filters: ${data.filterSummary}`,
    `Generated: ${new Date().toLocaleString("en-US")}`,
  ];
}

// ── Export (Finance tab) ─────────────────────────────────────────────────────
// Same real state Finance's own widgets already render (KPI strip, Billing
// Overview, Billable Hours by Member) — no export-specific query or rule.
// Finance has no filter bar of its own (its data is scoped only by the org
// and the Billing Period, same as its KPIs), so — unlike Delivery — there is
// no "active filters" line to report; the Report Summary only ever contains
// the four fields the task itself asks for.

interface FinanceExportData {
  organizationName:           string;
  periodLabel:                string;
  financeKpiSummary:          FinanceKpiSummary | null;
  billingOverviewRows:        BillingClientRow[];
  billableHoursByMemberRows:  MemberBillingRowReal[];
}

interface FinanceExportGroup {
  name:     string;
  fileSlug: string;
  sections: ExportSection[];
}

function buildFinanceExportMeta(data: FinanceExportData): string[] {
  return [
    "Jirita — Finance Report",
    `Organization: ${data.organizationName}`,
    `Billing Period: ${data.periodLabel}`,
    `Generated: ${new Date().toLocaleString("en-US")}`,
    "Currency: USD",
  ];
}

// One group per section shown on the Finance tab (Report Summary, KPIs,
// Billing Overview, Billable Hours by Member) — CSV exports each as its own
// file, Excel exports each as its own worksheet, PDF renders them in this
// same order (matching the on-screen order top to bottom).
function buildFinanceExportGroups(data: FinanceExportData): FinanceExportGroup[] {
  const summarySection: ExportSection = {
    title: "Report Summary",
    headers: ["Field", "Value"],
    rows: [
      ["Organization", data.organizationName],
      ["Billing Period", data.periodLabel],
      ["Generated", new Date().toLocaleString("en-US")],
      ["Currency", "USD"],
    ],
  };

  const kpiSection: ExportSection = {
    title: "KPIs",
    headers: ["Metric", "Value"],
    rows: data.financeKpiSummary
      ? [
          ["Billable Hours", `${data.financeKpiSummary.billableHours}h`],
          ["Non-billable Hours", `${data.financeKpiSummary.nonBillableHours}h`],
          ["Utilization", `${data.financeKpiSummary.utilizationPct}%`],
          ["Estimated Revenue", formatCurrency(data.financeKpiSummary.estimatedRevenue)],
        ]
      : [],
  };

  const billingOverviewRows = data.billingOverviewRows.map((row) => [
    row.client,
    `${row.billableHours}h`,
    row.nonBillableHours > 0 ? `${row.nonBillableHours}h` : "",
    row.avgRate > 0 ? `${formatCurrency(row.avgRate)}/h` : "",
    formatCurrency(row.estimatedInvoice),
  ]);
  if (data.financeKpiSummary) {
    billingOverviewRows.push([
      "Total",
      `${data.financeKpiSummary.billableHours}h`,
      `${data.financeKpiSummary.nonBillableHours}h`,
      "",
      formatCurrency(data.financeKpiSummary.estimatedRevenue),
    ]);
  }
  const billingOverviewSection: ExportSection = {
    title: "Billing Overview",
    headers: ["Client", "Billable Hours", "Non-billable Hours", "Average Rate", "Estimated Invoice"],
    rows: billingOverviewRows,
  };

  const billableByMemberSection: ExportSection = {
    title: "Billable Hours by Member",
    headers: ["Member", "Billable", "Non-billable", "Utilization %", "Estimated Revenue"],
    rows: data.billableHoursByMemberRows.map((row) => [
      row.name,
      `${row.billableHours}h`,
      `${row.nonBillableHours}h`,
      `${row.utilizationPct}%`,
      formatCurrency(row.estimatedRevenue),
    ]),
  };

  return [
    { name: "Summary", fileSlug: "summary", sections: [summarySection] },
    { name: "KPIs", fileSlug: "kpis", sections: [kpiSection] },
    { name: "Billing Overview", fileSlug: "billing-overview", sections: [billingOverviewSection] },
    { name: "Billable Hours by Member", fileSlug: "billable-hours-by-member", sections: [billableByMemberSection] },
  ];
}

function sectionToSheetTable(section: ExportSection): string {
  const headerRow = section.headers
    ? `<tr>${section.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr>`
    : "";
  const bodyRows =
    section.rows.length === 0
      ? `<tr><td>No data</td></tr>`
      : section.rows.map((row) => `<tr>${row.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("");
  return `<table border="1" cellspacing="0" cellpadding="4">${headerRow}${bodyRows}</table>`;
}

// Real, separate worksheets in one workbook (one per Finance section) via
// Excel's own documented HTML + XML-namespace convention — no library. Each
// top-level <table> in <body> becomes one named sheet, in the same order as
// the <x:ExcelWorksheet> declarations.
function buildFinanceExcelHtml(groups: FinanceExportGroup[]): string {
  const worksheetDefs = groups
    .map((g) => `<x:ExcelWorksheet><x:Name>${escapeHtml(g.name.slice(0, 31))}</x:Name></x:ExcelWorksheet>`)
    .join("");
  const sheetsHtml = groups.map((g) => sectionToSheetTable(g.sections[0])).join("");
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="UTF-8">
<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets>${worksheetDefs}</x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
</head>
<body>${sheetsHtml}</body>
</html>`;
}

function escapeCsvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function sectionsToCsv(sections: ExportSection[], meta: string[]): string {
  const lines: string[] = meta.map(escapeCsvCell);
  lines.push("");
  for (const section of sections) {
    lines.push(escapeCsvCell(section.title));
    if (section.headers) lines.push(section.headers.map(escapeCsvCell).join(","));
    if (section.rows.length === 0) {
      lines.push(escapeCsvCell("No data"));
    } else {
      for (const row of section.rows) lines.push(row.map(escapeCsvCell).join(","));
    }
    lines.push("");
  }
  return lines.join("\n");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function sectionsToHtml(sections: ExportSection[], meta: string[]): string {
  const metaHtml = meta.map((line) => `<p>${escapeHtml(line)}</p>`).join("");
  const sectionsHtml = sections
    .map((section) => {
      const headerRow = section.headers
        ? `<tr>${section.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr>`
        : "";
      const bodyRows =
        section.rows.length === 0
          ? `<tr><td>No data</td></tr>`
          : section.rows.map((row) => `<tr>${row.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("");
      return `<h3>${escapeHtml(section.title)}</h3><table border="1" cellspacing="0" cellpadding="4">${headerRow}${bodyRows}</table>`;
    })
    .join("");
  return `${metaHtml}${sectionsHtml}`;
}

function downloadTextFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Same download mechanics as downloadTextFile above, just for real binary
// bytes (the Hours Report's .xlsx) instead of text content.
// Exported so the dedicated Hours Report page (hours-report-screen.tsx) can
// reuse the exact same download mechanics for its real .xlsx export.
export function downloadBinaryFile(filename: string, bytes: Uint8Array, mimeType: string) {
  // fflate's zipSync types its output as Uint8Array<ArrayBufferLike>, which
  // Blob's constructor (typed against plain ArrayBuffer) rejects — copying
  // into a fresh, plain-ArrayBuffer-backed view satisfies that without
  // altering a single byte.
  const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// No PDF-generation library exists in this app (adding one would be an
// architecture change) — this reuses the browser's own native print-to-PDF
// pipeline instead: a plain printable HTML view the user's browser can
// "Save as PDF" from, same real data as the other two formats. Reused by
// both Delivery's and Finance's Export PDF, hence the plain `title` param.
function openPrintableReport(title: string, sections: ExportSection[], meta: string[]) {
  const win = window.open("", "_blank");
  if (!win) return;
  win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${escapeHtml(title)}</title>
    <style>
      body { font-family: -apple-system, Arial, sans-serif; color: #1e293b; padding: 24px; }
      h3 { margin-top: 24px; }
      table { border-collapse: collapse; width: 100%; margin-top: 8px; font-size: 13px; }
      th, td { border: 1px solid #cbd5e1; padding: 4px 8px; text-align: left; }
      th { background: #f1f5f9; }
    </style>
  </head><body>${sectionsToHtml(sections, meta)}</body></html>`);
  win.document.close();
  win.onload = () => win.print();
}

function labelsForSelected(groups: DropdownGroup[], selected: string[]): string {
  const allOptions = groups.flatMap((g) => g.options);
  return selected.map((v) => allOptions.find((o) => o.value === v)?.label ?? v).join(", ");
}

function ExportDropdown({
  tab,
  deliveryData,
  financeData,
}: {
  tab: ReportTab;
  deliveryData: DeliveryExportData;
  financeData: FinanceExportData;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  // Real export on both Delivery and Finance, each from the exact same
  // real data its own widgets already render — never a shared/blended
  // computation between the two tabs.
  function handleExportCsv() {
    if (tab === "delivery") {
      const sections = buildDeliveryExportSections(deliveryData);
      downloadTextFile("jirita-delivery-report.csv", sectionsToCsv(sections, buildExportMeta(deliveryData)), "text/csv;charset=utf-8;");
      return;
    }
    // Finance: one CSV file per section — never several differently-shaped
    // tables mixed into a single file. The Summary file's own rows already
    // are the report meta, so it isn't prefixed with the meta lines again.
    const meta = buildFinanceExportMeta(financeData);
    for (const group of buildFinanceExportGroups(financeData)) {
      const csv = sectionsToCsv(group.sections, group.name === "Summary" ? [] : meta);
      downloadTextFile(`jirita-finance-${group.fileSlug}.csv`, csv, "text/csv;charset=utf-8;");
    }
  }
  function handleExportExcel() {
    if (tab === "delivery") {
      const sections = buildDeliveryExportSections(deliveryData);
      const html = `<html><head><meta charset="UTF-8"></head><body>${sectionsToHtml(sections, buildExportMeta(deliveryData))}</body></html>`;
      downloadTextFile("jirita-delivery-report.xls", html, "application/vnd.ms-excel;charset=utf-8;");
      return;
    }
    // Finance: one real worksheet per section, in one workbook.
    const html = buildFinanceExcelHtml(buildFinanceExportGroups(financeData));
    downloadTextFile("jirita-finance-report.xls", html, "application/vnd.ms-excel;charset=utf-8;");
  }
  function handleExportPdf() {
    if (tab === "delivery") {
      const sections = buildDeliveryExportSections(deliveryData);
      openPrintableReport("Jirita Delivery Report", sections, buildExportMeta(deliveryData));
      return;
    }
    // Finance: same order as the screen (Summary meta first, then KPIs,
    // Billing Overview, Billable Hours by Member) in one continuous page.
    const sections = buildFinanceExportGroups(financeData)
      .filter((g) => g.name !== "Summary")
      .flatMap((g) => g.sections);
    openPrintableReport("Jirita Finance Report", sections, buildFinanceExportMeta(financeData));
  }

  const standardFormats = [
    {
      label: "Export CSV",
      path: "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z",
      onClick: handleExportCsv,
    },
    {
      label: "Export Excel",
      path: "M3 10h18M3 14h18M10 3v18M3 7l2-2h14l2 2M3 17l2 2h14l2-2",
      onClick: handleExportExcel,
    },
    {
      label: "Export PDF",
      path: "M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z",
      onClick: handleExportPdf,
    },
  ];
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-slate-600 dark:text-zinc-400 hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors duration-150 shadow-sm cursor-pointer"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
        </svg>
        Export
        <svg
          className={`w-3 h-3 text-slate-400 dark:text-zinc-600 mt-px transition-transform duration-150 ${open ? "-rotate-180" : ""}`}
          fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      <div
        className={[
          "absolute right-0 top-full mt-1.5 z-50 w-56 rounded-xl border",
          "bg-white dark:bg-zinc-900",
          "shadow-lg shadow-black/10 dark:shadow-black/40",
          "border-slate-200 dark:border-zinc-700/60",
          "transition-all duration-150 origin-top-right",
          open ? "opacity-100 scale-100 pointer-events-auto" : "opacity-0 scale-95 pointer-events-none",
        ].join(" ")}
      >
        <div className="py-1.5">
          {standardFormats.map(({ label, path, onClick }) => (
            <button
              key={label}
              type="button"
              onClick={() => {
                onClick?.();
                setOpen(false);
              }}
              className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-left text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800/60 transition-colors duration-150 cursor-pointer"
            >
              <svg className="w-3.5 h-3.5 text-slate-400 dark:text-zinc-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d={path} />
              </svg>
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Hours Report — entry point card ─────────────────────────────────────────
// Purely presentational now: the actual date/project filters, live preview,
// and real .xlsx/.pdf export all moved to their own dedicated route
// (/reports/hours → hours-report-screen.tsx), which enforces its own real
// access independently of this card — any Admin or Project Lead can reach
// the report itself; whether it carries `$` is a separate, later check
// (hasFinancialAccess) that page makes on its own. Exported so both
// AdminReportsScreen below and ProjectLeadReportsScreen (every Project
// Lead, financial or not) can link to the exact same doorway rather than
// each rendering a slightly different copy of it.
export function HoursReportEntryCard() {
  return (
    <Section title="Hours Report">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <p className="text-xs text-slate-500 dark:text-zinc-400 max-w-md">
          Logged hours by project and ticket for a selected period — grouped,
          totaled, and exportable.
        </p>
        <Link
          href="/reports/hours"
          className="inline-flex items-center gap-1.5 text-xs font-semibold px-3.5 py-2 rounded-lg bg-brand-500 hover:bg-brand-600 text-white transition-colors shadow-sm shadow-brand-500/30 cursor-pointer flex-shrink-0 dark:bg-brand-accent dark:hover:bg-brand-accent-strong dark:shadow-brand-accent/30 dark:text-brand-accent-foreground"
        >
          View Report
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
          </svg>
        </Link>
      </div>
    </Section>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ReportsScreen() {
  const { user } = useCurrentUser();

  // Project Lead gets a purpose-built Delivery/Team report scoped to their own
  // projects instead of this company-wide Delivery/Finance view — has to be a
  // separate component (not just an early return with more hooks below) so
  // switching roles never changes how many hooks render on this component.
  if (user.role === "PROJECT_LEAD") {
    return <ProjectLeadReportsScreen />;
  }

  // JIR-113 — a Member's only report is their personal Hours Report, so
  // /reports (the sidebar's Reports link) goes straight there; a Member
  // never renders the company-wide Delivery/Finance view below.
  if (user.role === "MEMBER") {
    return <MemberReportsRedirect />;
  }

  return <AdminReportsScreen />;
}

function MemberReportsRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/reports/hours");
  }, [router]);
  return null;
}

function AdminReportsScreen() {
  const { user, organization } = useCurrentUser();
  const isAdmin = user.role === "ADMIN";

  const [tab, setTab] = useState<ReportTab>("delivery");

  // Finance's own "Billing Period" — independent of Delivery's own period
  // below (separate state, separate query, separate export label) so
  // switching one tab's period can never affect the other's, and each
  // keeps its own selection switching back and forth between tabs during
  // this session.
  const [period, setPeriod] = useState<PeriodKey>("this-month");
  const [customRange, setCustomRange] = useState<CustomRange>(DEFAULT_CUSTOM_RANGE);

  // Delivery's own report period — same real PeriodSelector component/
  // PeriodKey/CustomRange/realRangeForPeriod Finance's own already uses,
  // just a second, independent instance of all of them. Scopes every
  // time-entry/activity-derived Delivery metric (Hours Burn's logged half,
  // Hours by Person's Completed, Tickets by Member, Done-in-period) —
  // never the "current state" ones (Active Tickets/Blocked/Overdue/
  // Workload), which stay filter-scoped only, same as before.
  const [deliveryPeriod, setDeliveryPeriod] = useState<PeriodKey>("this-month");
  const [deliveryCustomRange, setDeliveryCustomRange] = useState<CustomRange>(DEFAULT_CUSTOM_RANGE);

  const [projectFilter,  setProjectFilter]  = useState<string[]>([]);
  const [assigneeFilter, setAssigneeFilter] = useState<string[]>([]);
  const [clientFilter,   setClientFilter]   = useState<string[]>([]);
  const [dateFilter,     setDateFilter]     = useState<string[]>([]);
  const [statusFilter,   setStatusFilter]   = useState<string[]>([]);
  const [priorityFilter, setPriorityFilter] = useState<string[]>([]);
  const [labelFilter,    setLabelFilter]    = useState<string[]>([]);
  const [hoursFilter,    setHoursFilter]    = useState<string[]>([]);
  const router = useRouter();
  // A ticket click now navigates straight to its own Detail page — no more
  // intermediate Preview step. Kept as `setPreview` (not renamed) so every
  // existing call site below needs no change.
  function setPreview(ticket: Ticket) {
    router.push(`/projects/${ticket.projectSlug}/tickets/${getTicketDisplayKey(ticket)}`);
  }

  // Hours by Person — sort state
  const [personSort,    setPersonSort]    = useState<PersonSortKey>("estimatedHours");
  const [personSortDir, setPersonSortDir] = useState<"asc" | "desc">("desc");
  const [personFading,  setPersonFading]  = useState(false);

  function handlePersonSort(key: PersonSortKey) {
    setPersonFading(true);
    setTimeout(() => {
      if (personSort === key) {
        setPersonSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setPersonSort(key);
        setPersonSortDir("desc");
      }
      setPersonFading(false);
    }, 110);
  }

  // ── Delivery tab: single shared real data source ──────────────────────────
  // One fetch backs every widget below (Health Alerts, KPI strip, Hours by
  // Person, Project Health) — no widget issues its own query. Tickets/
  // Projects/Members/Capacities are org-wide, not period-scoped, so they're
  // shared as-is by both tabs; `rawTimeEntries` stays Finance's own real
  // time entries (scoped to Finance's own `period`/`customRange` above),
  // while `rawDeliveryTimeEntries`/`rawDeliveryCompletedCount` below are the
  // real Delivery-period-scoped equivalents Delivery's own widgets read
  // from instead — two independent range queries off the same real
  // `ticketIds`, never two independent ticket/project/member fetches. The
  // 7 filters above are applied client-side to the shared raw tickets (see
  // filteredTickets/filteredProjects below), and every Delivery widget
  // derives from that same filtered result, so they can never disagree
  // with each other.
  const [rawTickets,        setRawTickets]        = useState<Ticket[]>([]);
  const [rawProjects,       setRawProjects]       = useState<ProjectSummary[]>([]);
  const [rawMembers,        setRawMembers]        = useState<OrgWorkloadMember[]>([]);
  const [rawCapacities,     setRawCapacities]     = useState<MemberWeeklyCapacityEntry[]>([]);
  const [rawTimeEntries,    setRawTimeEntries]    = useState<OrganizationTimeEntry[]>([]);
  const [rawActivityEvents, setRawActivityEvents] = useState<HoursOrAssigneeActivityEvent[]>([]);
  // Delivery's own real, period-scoped data — see the block comment above.
  const [rawDeliveryTimeEntries, setRawDeliveryTimeEntries] = useState<OrganizationTimeEntry[]>([]);
  // Real count of `status_changed`→`done` ticket_activity rows within
  // Delivery's own selected period (loadTicketsCompletedInRange) — the
  // "Done This Month"/"Done Last Month"/"Done This Quarter"/"Done in
  // Range" KPI's real value, never `updated_at`.
  const [rawDeliveryCompletedCount, setRawDeliveryCompletedCount] = useState(0);
  const [deliveryLoadState, setDeliveryLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [deliveryLoadError, setDeliveryLoadError] = useState<string | null>(null);
  const [deliveryRequestId, setDeliveryRequestId] = useState(0);
  // Finance tab's own loading flag — same underlying fetch as
  // deliveryLoadState above (Billing Period changes re-run the one effect
  // below), but tracked separately so a Billing Period change only shows
  // Finance's own KPIs/Billing Overview/Billable Hours by Member their own
  // skeleton again, without touching Delivery's own (unrelated)
  // loading/error gating. `deliveryLoadState`'s own "error" value is still
  // reused as-is for Finance's error branches below — this only fixes the
  // missing "loading" reset, never a second error path.
  const [financeLoadState, setFinanceLoadState] = useState<"loading" | "ready">("loading");

  useEffect(() => {
    if (!organization) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: both tabs' own widgets must show their own skeleton again the instant this effect re-runs — on mount, on a Billing Period change, and on Delivery's 7 filters (client-side, don't re-trigger this) staying put — same "reset before the async fetch resolves" pattern used elsewhere in this app.
    setDeliveryLoadState("loading");
    setFinanceLoadState("loading");

    const fetchPromise = (async () => {
      const [ticketsResult, projectsResult, membersResult, capacitiesResult] = await Promise.all([
        loadOrganizationTickets(organization.id),
        loadOrganizationProjects(organization.id),
        loadOrganizationWorkloadMembers(organization.id),
        loadOrganizationMemberWeeklyCapacities(organization.id),
      ]);
      if (cancelled) return;

      if (ticketsResult.status === "error") {
        setDeliveryLoadState("error");
        setDeliveryLoadError(ticketsResult.message);
        return;
      }
      if (projectsResult.status === "error") {
        setDeliveryLoadState("error");
        setDeliveryLoadError(projectsResult.message);
        return;
      }
      if (membersResult.status === "error") {
        setDeliveryLoadState("error");
        setDeliveryLoadError(membersResult.message);
        return;
      }
      if (capacitiesResult.status === "error") {
        setDeliveryLoadState("error");
        setDeliveryLoadError(capacitiesResult.message);
        return;
      }

      const ticketIds = ticketsResult.tickets.map((t) => t.id);
      const todayISO = getTodayISO();
      const { from, to } = realRangeForPeriod(period, customRange, todayISO);
      const deliveryRange = realRangeForPeriod(deliveryPeriod, deliveryCustomRange, todayISO);
      const weekBounds = getCurrentWeekBounds();
      const [timeResult, activityResult, deliveryTimeResult, deliveryCompletedResult] = await Promise.all([
        loadOrganizationLoggedTimeForRange(ticketIds, from, to),
        loadHoursAndAssigneeActivityForRange(ticketIds, weekBounds.start, weekBounds.end),
        loadOrganizationLoggedTimeForRange(ticketIds, deliveryRange.from, deliveryRange.to),
        loadTicketsCompletedInRange(ticketIds, deliveryRange.from, exclusiveEndDate(deliveryRange.to)),
      ]);
      if (cancelled) return;

      if (timeResult.status === "error") {
        setDeliveryLoadState("error");
        setDeliveryLoadError(timeResult.message);
        return;
      }
      if (activityResult.status === "error") {
        setDeliveryLoadState("error");
        setDeliveryLoadError(activityResult.message);
        return;
      }
      if (deliveryTimeResult.status === "error") {
        setDeliveryLoadState("error");
        setDeliveryLoadError(deliveryTimeResult.message);
        return;
      }
      if (deliveryCompletedResult.status === "error") {
        setDeliveryLoadState("error");
        setDeliveryLoadError(deliveryCompletedResult.message);
        return;
      }

      setRawTickets(ticketsResult.tickets);
      setRawProjects(projectsResult.projects);
      setRawMembers(membersResult.members);
      setRawCapacities(capacitiesResult.capacities);
      setRawTimeEntries(timeResult.entries);
      setRawActivityEvents(activityResult.events);
      setRawDeliveryTimeEntries(deliveryTimeResult.entries);
      setRawDeliveryCompletedCount(deliveryCompletedResult.ticketIds.length);
      setDeliveryLoadState("ready");
    })();

    // Settles Finance's own loading flag once this same fetch finishes,
    // success or failure alike (Finance has no separate error UI of its
    // own — deliveryLoadState === "error" already covers that) — guarded by
    // `cancelled` so a stale in-flight request from a previous Billing
    // Period can never clear the skeleton for a newer one already in
    // flight.
    fetchPromise.finally(() => {
      if (!cancelled) setFinanceLoadState("ready");
    });

    return () => {
      cancelled = true;
    };
    // organization?.id (not the whole `organization` object) — depending on
    // the object re-triggers this effect (both tabs' full skeleton) on
    // every window-focus regain, since current-user-provider.tsx hands back
    // a new `organization` reference on its own session revalidation even
    // when the org itself hasn't changed. Keying off the real identity
    // means this only re-runs on a genuine org change, a Period/Billing
    // Period change, the initial mount, or an explicit user-triggered
    // setDeliveryRequestId bump (Retry) — no background auto-refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organization?.id, period, customRange, deliveryPeriod, deliveryCustomRange, deliveryRequestId]);

  // ── Filter option lists — real values only, drawn from the unfiltered
  //    raw org data above (never a static catalog), and restricted to
  //    values that actually occur on a real ticket in scope — same "only
  //    real work counts" precedent Hours by Person/Project Health already
  //    use (e.g. an org member with zero tickets shouldn't appear as an
  //    Assignee option). A filter with nothing real to offer gets an empty
  //    groups array, which FilterDropdown already renders as its own
  //    built-in "No results" empty state. ──────────────────────────────────
  const projectSlugsWithTickets = useMemo(() => new Set(rawTickets.map((t) => t.projectSlug)), [rawTickets]);

  const projectFilterGroups = useMemo<DropdownGroup[]>(() => {
    const options = rawProjects
      .filter((p) => projectSlugsWithTickets.has(p.slug))
      .map((p) => ({ value: p.slug, label: p.name }));
    return options.length === 0 ? [] : [{ options }];
  }, [rawProjects, projectSlugsWithTickets]);

  const assigneeFilterGroups = useMemo<DropdownGroup[]>(() => {
    const assigneeIdsWithTickets = new Set(
      rawTickets.map((t) => t.assigneeProfileId).filter((id): id is string => Boolean(id))
    );
    const options = rawMembers
      .filter((m) => assigneeIdsWithTickets.has(m.id))
      .map((m) => ({ value: m.id, label: m.name, avatar: m.avatar }));
    return options.length === 0 ? [] : [{ options }];
  }, [rawMembers, rawTickets]);

  const clientFilterGroups = useMemo<DropdownGroup[]>(() => {
    // ProjectSummary.client is typed as the closed ClientName union, but the
    // real column behind it (client_name) is free text — rowToProjectSummary
    // casts rather than validates, so this reads it back out as the real
    // string it actually is instead of trusting the narrower type.
    const clients = Array.from(
      new Set(
        rawProjects
          .filter((p) => projectSlugsWithTickets.has(p.slug))
          .map((p) => p.client as string | undefined)
          .filter((c): c is string => Boolean(c))
      )
    );
    return clients.length === 0 ? [] : [{ options: clients.map((c) => ({ value: c, label: c })) }];
  }, [rawProjects, projectSlugsWithTickets]);

  const statusFilterGroups = useMemo<DropdownGroup[]>(() => {
    const present = new Set(rawTickets.map((t) => t.status));
    const options = STATUS_FILTER_ORDER.filter((s) => present.has(s)).map((s) => ({
      value: s,
      label: STATUS_FILTER_LABELS[s],
    }));
    return options.length === 0 ? [] : [{ options }];
  }, [rawTickets]);

  const priorityFilterGroups = useMemo<DropdownGroup[]>(() => {
    const present = new Set(rawTickets.map((t) => t.priority));
    const options = PRIORITY_FILTER_ORDER.filter((p) => present.has(p)).map((p) => ({
      value: p,
      label: PRIORITY_FILTER_LABELS[p],
    }));
    return options.length === 0 ? [] : [{ options }];
  }, [rawTickets]);

  const labelFilterGroups = useMemo<DropdownGroup[]>(() => {
    const labels = Array.from(new Set(rawTickets.flatMap((t) => t.labels))).sort();
    return labels.length === 0 ? [] : [{ options: labels.map((l) => ({ value: l, label: l })) }];
  }, [rawTickets]);

  // ── Apply the 7 filters (AND across filters, OR within a multi-select's
  //    own values) to the one shared raw dataset. Project + Client narrow
  //    which projects are in scope first; a ticket only survives if its own
  //    project survives, on top of its own Assignee/Status/Priority/Labels/
  //    Hours checks. ────────────────────────────────────────────────────────
  const filteredProjects = useMemo(
    () =>
      rawProjects.filter((p) => {
        if (projectFilter.length > 0 && !projectFilter.includes(p.slug)) return false;
        if (clientFilter.length > 0 && !(p.client && clientFilter.includes(p.client))) return false;
        return true;
      }),
    [rawProjects, projectFilter, clientFilter]
  );

  const filteredProjectSlugs = useMemo(() => new Set(filteredProjects.map((p) => p.slug)), [filteredProjects]);

  const filteredTickets = useMemo(
    () =>
      rawTickets.filter((t) => {
        if (!filteredProjectSlugs.has(t.projectSlug)) return false;
        if (assigneeFilter.length > 0 && !(t.assigneeProfileId && assigneeFilter.includes(t.assigneeProfileId))) return false;
        if (statusFilter.length > 0 && !statusFilter.includes(t.status)) return false;
        if (priorityFilter.length > 0 && !priorityFilter.includes(t.priority)) return false;
        if (labelFilter.length > 0 && !t.labels.some((l) => labelFilter.includes(l))) return false;
        if (hoursFilter.length > 0 && !hoursFilter.some((b) => hoursInBucket(t.hours, b))) return false;
        return true;
      }),
    [rawTickets, filteredProjectSlugs, assigneeFilter, statusFilter, priorityFilter, labelFilter, hoursFilter]
  );

  const filteredTicketIds = useMemo(() => new Set(filteredTickets.map((t) => t.id)), [filteredTickets]);

  // Delivery's own period-scoped logged time (rawDeliveryTimeEntries — see
  // the fetch effect above), never Finance's rawTimeEntries: Hours Burn,
  // Hours by Person's Completed/Remaining, Project Health's Completion, and
  // Workload's `filteredActivityEvents`-based capacity math all read this
  // same filtered slice, so they all move together with Delivery's own
  // Period selector while Finance's Billing Period stays untouched.
  const filteredTimeEntries = useMemo(
    () => rawDeliveryTimeEntries.filter((e) => filteredTicketIds.has(e.ticketId)),
    [rawDeliveryTimeEntries, filteredTicketIds]
  );

  const filteredActivityEvents = useMemo(
    () => rawActivityEvents.filter((e) => filteredTicketIds.has(e.ticketId)),
    [rawActivityEvents, filteredTicketIds]
  );

  // ── Every widget below derives from the same filtered slice above —
  //    Hours by Person, Project Health, KPIs, alerts, Workload — no
  //    independent queries or rules. ─────────────────────────────────────
  const personRows = useMemo(
    () => buildHoursByPersonRows(filteredTickets, rawMembers, rawCapacities, filteredTimeEntries),
    [filteredTickets, rawMembers, rawCapacities, filteredTimeEntries]
  );

  const sortedPersonRows = [...personRows].sort((a, b) => {
    const mult = personSortDir === "asc" ? 1 : -1;
    const val  = (r: PersonRow) =>
      personSort === "remainingHours" ? round1(Math.max(r.estimatedHours - r.completedHours, 0)) : r[personSort];
    return (val(a) - val(b)) * mult;
  });

  const projectRows = useMemo(
    () =>
      buildProjectHealthRows(
        filteredProjects.map((p) => ({ slug: p.slug, name: p.name, projectCode: p.projectCode })),
        filteredTickets,
        filteredTimeEntries,
        getTodayISO()
      ),
    [filteredProjects, filteredTickets, filteredTimeEntries]
  );

  const kpiSummary = useMemo<DeliveryKpiSummary | null>(
    () =>
      deliveryLoadState === "ready"
        ? buildDeliveryKpiSummary(
            filteredTickets,
            filteredProjects,
            filteredTimeEntries,
            getTodayISO(),
            rawDeliveryCompletedCount
          )
        : null,
    [deliveryLoadState, filteredTickets, filteredProjects, filteredTimeEntries, rawDeliveryCompletedCount]
  );

  const kpiReady = kpiSummary !== null;

  // Adaptive "Done …" KPI label/sub — Delivery's own Period, never the
  // fixed current calendar month: This Month/Last Month/This Quarter read
  // naturally as "Done <period>"; Custom Range has no single period name,
  // so it falls back to "Done in Range" with the resolved date range as
  // its sub-label.
  const deliveryPeriodLabel =
    deliveryPeriod === "custom"
      ? formatRangeLabel(deliveryCustomRange)
      : PERIOD_OPTIONS.find((o) => o.key === deliveryPeriod)?.label ?? deliveryPeriod;
  const deliveryCompletedLabel =
    deliveryPeriod === "this-month"
      ? "Done This Month"
      : deliveryPeriod === "last-month"
      ? "Done Last Month"
      : deliveryPeriod === "this-quarter"
      ? "Done This Quarter"
      : "Done in Range";

  // Finance KPI strip — reuses the exact same real rawTickets/rawProjects/
  // rawTimeEntries Delivery's own shared fetch above already loaded for
  // this same Billing Period (period/customRange is shared state — no
  // separate query). Deliberately NOT filteredTickets/filteredProjects:
  // Delivery's 7 filters are a Delivery-tab concept, Finance is scoped only
  // by the org and the Billing Period.
  const financeKpiSummary = useMemo<FinanceKpiSummary | null>(
    () => (deliveryLoadState === "ready" ? buildFinanceKpiSummary(rawTickets, rawProjects, rawTimeEntries) : null),
    [deliveryLoadState, rawTickets, rawProjects, rawTimeEntries]
  );
  const financeReady = financeKpiSummary !== null;

  // Billing Overview — same real state/period/rules as the Finance KPI
  // strip above; its own Total row reads financeKpiSummary directly
  // (never a separate sum) so it can never disagree with the KPIs.
  const billingOverviewRows = useMemo(
    () => buildBillingOverviewRows(rawTickets, rawProjects, rawTimeEntries),
    [rawTickets, rawProjects, rawTimeEntries]
  );

  // Billable Hours by Member — same real state/period/rules as the KPIs and
  // Billing Overview above (rawTimeEntries already carries loggedBy — no
  // new query); grouped by person instead of by client.
  const billableHoursByMemberRows = useMemo(
    () => buildBillableHoursByMemberRows(rawTickets, rawProjects, rawTimeEntries, rawMembers),
    [rawTickets, rawProjects, rawTimeEntries, rawMembers]
  );

  const workloadRows = useMemo(
    () => buildWorkloadRows(filteredTickets, rawMembers, rawCapacities, filteredTimeEntries, filteredActivityEvents),
    [filteredTickets, rawMembers, rawCapacities, filteredTimeEntries, filteredActivityEvents]
  );
  // Real scope handoff for every Delivery-tab Member Profile Modal trigger
  // below (Hours by Person, Workload, Tickets by Member — all three read
  // from `filteredTickets`) — reuses the existing Project filter's own real
  // selection, never a new interpretation of "scope": exactly one project
  // selected means these widgets are already reading that one project's own
  // tickets/team, so the modal should fetch that same project-scoped data;
  // zero or 2+ selected means they're already aggregating across more than
  // one project, so the modal aggregates org-wide too (its own existing
  // no-slug mode) rather than arbitrarily picking one. Billable Hours by
  // Member (Finance tab) is always org-wide (built from unfiltered
  // `rawTickets`, never `filteredTickets`), so its own trigger below never
  // passes this.
  const deliveryProjectSlug = projectFilter.length === 1 ? projectFilter[0] : undefined;

  const hoursDistribution = useMemo(() => buildHoursDistribution(filteredTickets), [filteredTickets]);
  const hoursDistTotal = useMemo(
    () => round1(hoursDistribution.reduce((sum, entry) => sum + entry.hours, 0)),
    [hoursDistribution]
  );

  // Tickets by Member — a real member's own group can legitimately include
  // a ticket no longer (or never) assigned to them, whenever they logged
  // real hours on it this period (see buildTicketsByMember's own doc), so
  // this block deliberately reuses `filteredProjects`/`filteredProjectSlugs`
  // (Project + Client scoping — unchanged, still shared with every other
  // Delivery widget) but builds its own ticket/time-entry scope on top,
  // applying Status/Priority/Labels/Hours the same way `filteredTickets`
  // does while leaving the Assignee filter out of the ticket-level scope
  // entirely — Member instead narrows which *groups* are shown, after
  // grouping, exactly as this block's own spec requires ("Member limita
  // los grupos visibles"), never which tickets a person's real historical
  // hours can surface. Never a second/duplicate ticket or time-entry
  // query — both still come straight from the same `rawTickets`/
  // `rawTimeEntries` every other Delivery widget already loaded.
  const ticketsByMemberScope = useMemo(
    () =>
      rawTickets.filter((t) => {
        if (!filteredProjectSlugs.has(t.projectSlug)) return false;
        if (statusFilter.length > 0 && !statusFilter.includes(t.status)) return false;
        if (priorityFilter.length > 0 && !priorityFilter.includes(t.priority)) return false;
        if (labelFilter.length > 0 && !t.labels.some((l) => labelFilter.includes(l))) return false;
        if (hoursFilter.length > 0 && !hoursFilter.some((b) => hoursInBucket(t.hours, b))) return false;
        return true;
      }),
    [rawTickets, filteredProjectSlugs, statusFilter, priorityFilter, labelFilter, hoursFilter]
  );
  const ticketsByMemberScopeIds = useMemo(
    () => new Set(ticketsByMemberScope.map((t) => t.id)),
    [ticketsByMemberScope]
  );
  const timeEntriesForMemberBlock = useMemo(
    () => rawDeliveryTimeEntries.filter((e) => ticketsByMemberScopeIds.has(e.ticketId)),
    [rawDeliveryTimeEntries, ticketsByMemberScopeIds]
  );

  const ticketsByMember = useMemo(() => {
    const groups = buildTicketsByMember(ticketsByMemberScope, timeEntriesForMemberBlock, rawMembers, getTodayISO());
    if (assigneeFilter.length === 0) return groups;
    return groups.filter((g) => g.profileId !== null && assigneeFilter.includes(g.profileId));
  }, [ticketsByMemberScope, timeEntriesForMemberBlock, rawMembers, assigneeFilter]);

  // Alerts banner — derived from the already-real personRows/kpiSummary
  // above, no separate fetch or rule of its own.
  const statusItems = useMemo(
    () => buildDeliveryStatusItems(personRows, kpiSummary),
    [personRows, kpiSummary]
  );

  // Export (Delivery tab) — the exact same real state/memos above, reused
  // as-is; no export-specific fetch or recomputation.
  const periodLabel =
    period === "custom" ? formatRangeLabel(customRange) : PERIOD_OPTIONS.find((o) => o.key === period)?.label ?? period;

  const filterSummary = useMemo(() => {
    const parts = [
      projectFilter.length  > 0 && `Project: ${labelsForSelected(projectFilterGroups, projectFilter)}`,
      assigneeFilter.length > 0 && `Assignee: ${labelsForSelected(assigneeFilterGroups, assigneeFilter)}`,
      clientFilter.length   > 0 && `Client: ${labelsForSelected(clientFilterGroups, clientFilter)}`,
      statusFilter.length   > 0 && `Status: ${labelsForSelected(statusFilterGroups, statusFilter)}`,
      priorityFilter.length > 0 && `Priority: ${labelsForSelected(priorityFilterGroups, priorityFilter)}`,
      labelFilter.length    > 0 && `Labels: ${labelsForSelected(labelFilterGroups, labelFilter)}`,
      hoursFilter.length    > 0 && `Hours: ${labelsForSelected(HOURS_GROUPS, hoursFilter)}`,
    ].filter((p): p is string => Boolean(p));
    return parts.length > 0 ? parts.join("; ") : "None";
  }, [
    projectFilter, projectFilterGroups,
    assigneeFilter, assigneeFilterGroups,
    clientFilter, clientFilterGroups,
    statusFilter, statusFilterGroups,
    priorityFilter, priorityFilterGroups,
    labelFilter, labelFilterGroups,
    hoursFilter,
  ]);

  const deliveryExportData = useMemo<DeliveryExportData>(
    () => ({
      periodLabel: deliveryPeriodLabel,
      filterSummary,
      statusItems,
      kpiSummary,
      personRows,
      projectRows,
      workloadRows,
      hoursDistribution,
      hoursDistTotal,
      ticketsByMember,
    }),
    [
      deliveryPeriodLabel, filterSummary, statusItems, kpiSummary, personRows, projectRows,
      workloadRows, hoursDistribution, hoursDistTotal, ticketsByMember,
    ]
  );

  const financeExportData = useMemo<FinanceExportData>(
    () => ({
      organizationName: organization?.name ?? "",
      periodLabel,
      financeKpiSummary,
      billingOverviewRows,
      billableHoursByMemberRows,
    }),
    [organization, periodLabel, financeKpiSummary, billingOverviewRows, billableHoursByMemberRows]
  );

  return (
    <div className="max-w-5xl mx-auto px-6 py-6 pb-16">

      {/* ── Page header ──────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between mb-3 gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-zinc-50 tracking-tight leading-none">
            Reports
          </h1>
          <p className="text-xs text-slate-400 dark:text-zinc-500 mt-0.5">{formatHeaderDate(getTodayISO())}</p>
        </div>
        <ExportDropdown tab={tab} deliveryData={deliveryExportData} financeData={financeExportData} />
      </div>

      {/* ── Hours Report (Admin only) — entry point card ─────────────────────── */}
      {isAdmin && (
        <div className="mb-5">
          <HoursReportEntryCard />
        </div>
      )}

      {/* ── Report tabs (Admin only — Project Lead only ever sees Delivery) ─── */}
      {isAdmin && (
        <div className="mb-5">
          <ReportTabs tab={tab} onChange={setTab} />
        </div>
      )}

      {(!isAdmin || tab === "delivery") && (
        <>

      {/* ── Status bar ───────────────────────────────────────────────────────── */}
      <div className="mb-4">
        <ReportStatusBar items={statusItems} />
      </div>

      {/* ── Top filters ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 flex-wrap mb-6 rounded-xl border border-slate-200 dark:border-zinc-700/70 bg-white dark:bg-zinc-900 px-4 py-2.5 shadow-sm shadow-slate-200/40 dark:shadow-black/20">
        <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600 mr-2">
          Filter
        </span>
        <FilterDropdown label="Project"    mode="multi"  groups={projectFilterGroups}  selected={projectFilter}  onChange={setProjectFilter} />
        <FilterDropdown label="Assignee"   mode="multi"  groups={assigneeFilterGroups} selected={assigneeFilter} onChange={setAssigneeFilter} searchable />
        <FilterDropdown label="Client"     mode="single" groups={clientFilterGroups}   selected={clientFilter}   onChange={setClientFilter} />
        {!isAdmin && (
          <FilterDropdown label="Date Range" mode="single" groups={DATE_GROUPS} selected={dateFilter} onChange={setDateFilter} />
        )}
        <FilterDropdown label="Status"     mode="multi"  groups={statusFilterGroups}   selected={statusFilter}   onChange={setStatusFilter} />
        <FilterDropdown label="Priority"   mode="multi"  groups={priorityFilterGroups} selected={priorityFilter} onChange={setPriorityFilter} />
        <FilterDropdown label="Labels"     mode="multi"  groups={labelFilterGroups}    selected={labelFilter}    onChange={setLabelFilter} />
        <FilterDropdown label="Hours"      mode="single" groups={HOURS_GROUPS}         selected={hoursFilter}    onChange={setHoursFilter} />
      </div>

      {/* ── Reporting period — Delivery's own, independent of Finance's own
          Billing Period above; same real PeriodSelector component/behavior,
          combines with the 7 filters above without resetting either. ───── */}
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">
          Reporting Period
        </h2>
        <PeriodSelector
          value={deliveryPeriod}
          onChange={setDeliveryPeriod}
          customRange={deliveryCustomRange}
          onCustomRangeChange={setDeliveryCustomRange}
        />
      </div>

      {/* ── KPI strip ────────────────────────────────────────────────────────── */}
      {deliveryLoadState === "loading" ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-8">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="rounded-xl border border-slate-200 dark:border-zinc-700/70 bg-white dark:bg-zinc-900 px-5 pt-4 pb-4 shadow-sm shadow-slate-200/40 dark:shadow-black/20"
            >
              <SkeletonBlock className="h-[10px] w-16 mb-2" />
              <SkeletonBlock className="h-6 w-12 mb-1.5" />
              <SkeletonBlock className="h-3 w-16" />
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-8">
          <KpiCard label="Projects"        value={kpiReady ? kpiSummary.activeProjects : "—"}     sub="active" />
          <KpiCard label="Active Tickets"  value={kpiReady ? kpiSummary.activeTickets : "—"}       sub="open" />
          <KpiCard
            label="Hours Burn"
            value={
              kpiReady ? (
                <>
                  {kpiSummary.loggedHours}
                  <span className="text-base font-medium ml-0.5">h</span>
                  <span className="text-sm font-normal text-brand-400 dark:text-brand-accent/70 mx-1.5">/</span>
                  <span className="text-lg font-semibold text-brand-400 dark:text-brand-accent/70">
                    {kpiSummary.estimatedHours}h
                  </span>
                </>
              ) : (
                "—"
              )
            }
            sub={kpiReady ? `${kpiSummary.hoursBurnPct}% complete` : undefined}
            progress={kpiReady ? kpiSummary.hoursBurnPct : undefined}
            accent
          />
          <KpiCard label="Blocked"         value={kpiReady ? kpiSummary.blockedTickets : "—"}      sub="need attention" danger />
          <KpiCard label={deliveryCompletedLabel} value={kpiReady ? kpiSummary.completedThisMonth : "—"}  sub={kpiReady ? deliveryPeriodLabel : undefined} />
          <KpiCard
            label="Overdue"
            value={kpiReady ? kpiSummary.overdueTickets : "—"}
            sub="past due date"
            danger={kpiReady && kpiSummary.overdueTickets > 0}
          />
        </div>
      )}

      {/* ── Sections ─────────────────────────────────────────────────────────── */}
      <div className="space-y-5">

        {/* ── Hours by Person ───────────────────────────────────────────────── */}
        <Section
          title="Hours by Person"
          count={deliveryLoadState === "loading" ? undefined : personRows.length}
          icon={
            <svg className="w-3.5 h-3.5 text-slate-400 dark:text-zinc-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <circle cx="12" cy="8" r="4" />
              <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
            </svg>
          }
        >
          <div className="overflow-x-auto -mx-5 px-5">
            <table className="w-full text-sm min-w-[480px]">
              <thead>
                <tr className="border-b border-slate-100 dark:border-zinc-800">
                  <th className="pb-2.5 text-left text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600 w-[200px]">
                    Person
                  </th>
                  <SortTh label="Tickets"    sortKey="assignedTickets" currentSort={personSort} sortDir={personSortDir} onSort={handlePersonSort} />
                  <SortTh label="Est. Hours" sortKey="estimatedHours"  currentSort={personSort} sortDir={personSortDir} onSort={handlePersonSort} />
                  <SortTh label="Completed"  sortKey="completedHours"  currentSort={personSort} sortDir={personSortDir} onSort={handlePersonSort} />
                  <SortTh label="Remaining"  sortKey="remainingHours"  currentSort={personSort} sortDir={personSortDir} onSort={handlePersonSort} />
                  <SortTh label="Blocked"    sortKey="blockedHours"    currentSort={personSort} sortDir={personSortDir} onSort={handlePersonSort} />
                  <SortTh label="Capacity"   sortKey="capacity"        currentSort={personSort} sortDir={personSortDir} onSort={handlePersonSort} />
                </tr>
              </thead>
              <tbody
                className="divide-y divide-slate-50 dark:divide-zinc-800/60 transition-opacity duration-110"
                style={{ opacity: personFading ? 0 : 1 }}
              >
                {deliveryLoadState === "loading" ? (
                  Array.from({ length: 3 }).map((_, i) => (
                    <tr key={i}>
                      <td className="py-2.5 pr-4">
                        <div className="flex items-center gap-2.5">
                          <SkeletonBlock className="h-6 w-6 rounded-full flex-shrink-0" />
                          <SkeletonBlock className="h-4 w-28" />
                        </div>
                      </td>
                      <td className="py-2.5 text-right"><SkeletonBlock className="h-4 w-8 ml-auto" /></td>
                      <td className="py-2.5 text-right"><SkeletonBlock className="h-4 w-10 ml-auto" /></td>
                      <td className="py-2.5 text-right"><SkeletonBlock className="h-4 w-10 ml-auto" /></td>
                      <td className="py-2.5 text-right"><SkeletonBlock className="h-4 w-10 ml-auto" /></td>
                      <td className="py-2.5 text-right"><SkeletonBlock className="h-4 w-10 ml-auto" /></td>
                      <td className="py-2.5 text-right"><SkeletonBlock className="h-4 w-10 ml-auto" /></td>
                    </tr>
                  ))
                ) : deliveryLoadState === "error" ? (
                  <tr>
                    <td colSpan={7} className="py-6 text-center text-sm text-slate-400 dark:text-zinc-500">
                      {deliveryLoadError ?? "Couldn't load Hours by Person."}{" "}
                      <button
                        type="button"
                        onClick={() => setDeliveryRequestId((id) => id + 1)}
                        className="font-medium text-brand-600 dark:text-brand-accent hover:underline"
                      >
                        Retry
                      </button>
                    </td>
                  </tr>
                ) : sortedPersonRows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-6 text-center text-sm text-slate-400 dark:text-zinc-500">
                      No real work in the current report scope.
                    </td>
                  </tr>
                ) : (
                  sortedPersonRows.map((row) => (
                    <tr
                      key={row.id}
                      className="hover:bg-slate-50/60 dark:hover:bg-zinc-800/30 transition-colors duration-150 cursor-default"
                    >
                      <td className="py-2.5 pr-4">
                        <MemberTrigger
                          name={row.name}
                          avatar={row.avatar}
                          profileId={row.id}
                          projectSlug={deliveryProjectSlug}
                          className="flex items-center gap-2.5"
                        >
                          <Avatar src={row.avatar} name={row.name} className="w-6 h-6 rounded-full flex-shrink-0" />
                          <span className="font-medium text-slate-800 dark:text-zinc-200">{row.name}</span>
                        </MemberTrigger>
                      </td>
                      <td className="py-2.5 text-right text-slate-500 dark:text-zinc-400 tabular-nums">
                        {row.assignedTickets}
                      </td>
                      <td className="py-2.5 text-right font-semibold text-slate-800 dark:text-zinc-200 tabular-nums">
                        {row.estimatedHours}h
                      </td>
                      <td className="py-2.5 text-right font-medium text-emerald-600 dark:text-emerald-400 tabular-nums">
                        {row.completedHours}h
                      </td>
                      <td className="py-2.5 text-right text-slate-500 dark:text-zinc-400 tabular-nums">
                        {round1(Math.max(row.estimatedHours - row.completedHours, 0))}h
                      </td>
                      <td className="py-2.5 text-right tabular-nums">
                        {row.blockedHours > 0 ? (
                          <span className="font-medium text-red-600 dark:text-red-400">{row.blockedHours}h</span>
                        ) : (
                          <span className="text-slate-300 dark:text-zinc-600">—</span>
                        )}
                      </td>
                      <td className="py-2.5 text-right">
                        <CapacityCell pct={row.capacity} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Section>

        {/* ── Project Health ────────────────────────────────────────────────── */}
        <Section
          title="Project Health"
          count={deliveryLoadState === "loading" ? undefined : projectRows.length}
          icon={
            <svg className="w-3.5 h-3.5 text-slate-400 dark:text-zinc-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M3 7l4-4h6l4 4" />
              <rect x="3" y="7" width="18" height="13" rx="2" />
            </svg>
          }
        >
          <div className="overflow-x-auto -mx-5 px-5">
            <table className="w-full text-sm min-w-[600px]">
              <thead>
                <tr className="border-b border-slate-100 dark:border-zinc-800">
                  <th className="pb-2.5 text-left text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600 w-[220px]">
                    Project
                  </th>
                  <th className="pb-2.5 text-right text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">
                    Tickets
                  </th>
                  <th className="pb-2.5 text-right text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">
                    Hours
                  </th>
                  <th className="pb-2.5 text-right text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">
                    Blocked
                  </th>
                  <th className="pb-2.5 pl-4 text-left text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">
                    Completion
                  </th>
                  <th className="pb-2.5 text-right text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">
                    Risk
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50 dark:divide-zinc-800/60">
                {deliveryLoadState === "loading" ? (
                  Array.from({ length: 3 }).map((_, i) => (
                    <tr key={i}>
                      <td className="py-2.5 pr-4">
                        <div className="flex items-center gap-2">
                          <SkeletonBlock className="h-6 w-6 rounded-md flex-shrink-0" />
                          <SkeletonBlock className="h-4 w-32" />
                        </div>
                      </td>
                      <td className="py-2.5 text-right"><SkeletonBlock className="h-4 w-8 ml-auto" /></td>
                      <td className="py-2.5 text-right"><SkeletonBlock className="h-4 w-16 ml-auto" /></td>
                      <td className="py-2.5 text-right"><SkeletonBlock className="h-4 w-6 ml-auto" /></td>
                      <td className="py-2.5 pl-4"><SkeletonBlock className="h-4 w-24" /></td>
                      <td className="py-2.5 text-right"><SkeletonBlock className="h-5 w-14 ml-auto rounded-full" /></td>
                    </tr>
                  ))
                ) : deliveryLoadState === "error" ? (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-sm text-slate-400 dark:text-zinc-500">
                      {deliveryLoadError ?? "Couldn't load Project Health."}{" "}
                      <button
                        type="button"
                        onClick={() => setDeliveryRequestId((id) => id + 1)}
                        className="font-medium text-brand-600 dark:text-brand-accent hover:underline"
                      >
                        Retry
                      </button>
                    </td>
                  </tr>
                ) : projectRows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-sm text-slate-400 dark:text-zinc-500">
                      No real projects in the current report scope.
                    </td>
                  </tr>
                ) : (
                  projectRows.map((row) => (
                    <tr
                      key={row.id}
                      className="hover:bg-slate-50/60 dark:hover:bg-zinc-800/30 transition-colors duration-150 cursor-pointer group"
                    >
                      <td className="py-2.5 pr-4">
                        <div className="flex items-center gap-2">
                          <span className="w-6 h-6 rounded-md bg-slate-100 dark:bg-zinc-800 text-[9px] font-bold text-slate-500 dark:text-zinc-400 flex items-center justify-center flex-shrink-0 transition-colors duration-150 group-hover:bg-brand-50 group-hover:text-brand-600 dark:group-hover:bg-brand-accent/10 dark:group-hover:text-brand-accent">
                            {row.shortName}
                          </span>
                          <span className="font-medium text-slate-800 dark:text-zinc-200 truncate group-hover:text-brand-700 dark:group-hover:text-brand-accent transition-colors duration-150">
                            {row.name}
                          </span>
                        </div>
                      </td>
                      <td className="py-2.5 text-right text-slate-500 dark:text-zinc-400 tabular-nums">
                        {row.tickets}
                      </td>
                      <td className="py-2.5 text-right tabular-nums whitespace-nowrap">
                        <span className="font-semibold text-slate-800 dark:text-zinc-200">
                          {row.completedHours}h
                        </span>
                        <span className="text-slate-400 dark:text-zinc-600 font-normal text-xs mx-1">/</span>
                        <span className="text-slate-400 dark:text-zinc-500 text-xs">
                          {row.estimatedHours}h
                        </span>
                      </td>
                      <td className="py-2.5 text-right tabular-nums">
                        {row.blocked > 0 ? (
                          <span className="font-medium text-red-600 dark:text-red-400">{row.blocked}</span>
                        ) : (
                          <span className="text-slate-300 dark:text-zinc-600">—</span>
                        )}
                      </td>
                      <td className="py-2.5 pl-4">
                        <BlockCompletion pct={row.completion} />
                      </td>
                      <td className="py-2.5 text-right">
                        <RiskBadge risk={row.risk} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Section>

        {/* ── Workload + Hours Distribution ─────────────────────────────────── */}
        <div className="grid md:grid-cols-2 gap-5">

          {/* Workload */}
          <Section
            title="Workload"
            icon={
              <svg className="w-3.5 h-3.5 text-slate-400 dark:text-zinc-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M3 6h18M3 12h14M3 18h8" />
              </svg>
            }
          >
            <div className="space-y-4">
              {deliveryLoadState === "loading" ? (
                <>
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i}>
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          <SkeletonBlock className="h-5 w-5 rounded-full flex-shrink-0" />
                          <SkeletonBlock className="h-4 w-24" />
                        </div>
                        <div className="text-right">
                          <SkeletonBlock className="h-4 w-16 mb-1 ml-auto" />
                          <SkeletonBlock className="h-3 w-10 ml-auto" />
                        </div>
                      </div>
                      <SkeletonBlock className="h-1.5 w-full rounded-full" />
                    </div>
                  ))}
                </>
              ) : deliveryLoadState === "error" ? (
                <p className="text-sm text-slate-400 dark:text-zinc-500">
                  {deliveryLoadError ?? "Couldn't load Workload."}{" "}
                  <button
                    type="button"
                    onClick={() => setDeliveryRequestId((id) => id + 1)}
                    className="font-medium text-brand-600 dark:text-brand-accent hover:underline"
                  >
                    Retry
                  </button>
                </p>
              ) : workloadRows.length === 0 ? (
                <p className="text-sm text-slate-400 dark:text-zinc-500">No real work in the current report scope.</p>
              ) : (
                workloadRows.map((entry) => {
                  const clampedBarPct = Math.min(entry.utilizationPct, 100);
                  const barColor  =
                    entry.utilizationPct > 100 ? "bg-red-400" :
                    entry.utilizationPct >= 80 ? "bg-amber-400" :
                                                 "bg-brand-500 dark:bg-brand-accent";
                  const pctColor  =
                    entry.utilizationPct > 100 ? "text-red-600 dark:text-red-400" :
                    entry.utilizationPct >= 80 ? "text-amber-600 dark:text-amber-400" :
                                                 "text-brand-600 dark:text-brand-accent";
                  const deltaPositive = entry.weekDelta !== null && entry.weekDelta > 0;
                  const deltaColor    = deltaPositive
                    ? "text-amber-500 dark:text-amber-500"
                    : "text-slate-400 dark:text-zinc-500";

                  return (
                    <div key={entry.id}>
                      <div className="flex items-center justify-between mb-1">
                        <MemberTrigger
                          name={entry.name}
                          avatar={entry.avatar}
                          profileId={entry.id}
                          projectSlug={deliveryProjectSlug}
                          className="flex items-center gap-2"
                        >
                          <Avatar src={entry.avatar} name={entry.name} className="w-5 h-5 rounded-full flex-shrink-0" />
                          <span className="text-sm font-medium text-slate-700 dark:text-zinc-300">
                            {entry.name}
                          </span>
                        </MemberTrigger>
                        <div className="text-right">
                          <p className="text-sm font-semibold text-slate-700 dark:text-zinc-200 tabular-nums leading-tight">
                            {entry.assignedHours}h
                            <span className="font-normal text-slate-400 dark:text-zinc-600">
                              {" / "}{round1(entry.weeklyCapacity)}h
                            </span>
                          </p>
                          <p className={`text-xs font-semibold tabular-nums leading-tight mt-0.5 ${pctColor}`}>
                            {entry.utilizationPct}%
                          </p>
                          <p className={`text-[10px] tabular-nums leading-tight mt-0.5 ${deltaColor}`}>
                            {entry.weekDelta === null
                              ? "No data this week"
                              : `${deltaPositive ? "+" : ""}${entry.weekDelta}h this week`}
                          </p>
                        </div>
                      </div>
                      <div className="h-1.5 rounded-full bg-slate-100 dark:bg-zinc-800 overflow-hidden">
                        <AnimatedBar pct={clampedBarPct} className={barColor} />
                      </div>
                    </div>
                  );
                })
              )}
            </div>
            <p className="mt-4 text-[11px] text-slate-400 dark:text-zinc-600 flex items-center gap-3">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-red-400 flex-shrink-0" />
                overloaded
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-amber-400 flex-shrink-0" />
                heavy
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-brand-500 flex-shrink-0 dark:bg-brand-accent" />
                normal
              </span>
            </p>
          </Section>

          {/* Hours Distribution */}
          <Section
            title="Hours Distribution"
            icon={
              <svg className="w-3.5 h-3.5 text-slate-400 dark:text-zinc-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M4 19V9M12 19V5M20 19v-7" />
              </svg>
            }
          >
            <div className="space-y-4">
              {deliveryLoadState === "loading" ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <div key={i}>
                    <div className="flex items-center justify-between mb-1.5">
                      <SkeletonBlock className="h-4 w-20" />
                      <SkeletonBlock className="h-4 w-10" />
                    </div>
                    <SkeletonBlock className="h-1.5 w-full rounded-full" />
                  </div>
                ))
              ) : (
                hoursDistribution.map((entry) => {
                  const pct = hoursDistTotal > 0 ? Math.round((entry.hours / hoursDistTotal) * 100) : 0;
                  return (
                    <div key={entry.id}>
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-sm font-medium text-slate-700 dark:text-zinc-300">
                          {entry.label}
                        </span>
                        <span className="text-sm font-semibold text-slate-700 dark:text-zinc-200 tabular-nums">
                          {entry.hours}h
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full bg-slate-100 dark:bg-zinc-800 overflow-hidden">
                        <AnimatedBar pct={pct} className={entry.barClass} />
                      </div>
                      <p className="mt-1 text-[11px] text-slate-400 dark:text-zinc-600 tabular-nums">
                        {pct}%
                      </p>
                    </div>
                  );
                })
              )}
            </div>
            <div className="mt-4 text-[11px] text-slate-400 dark:text-zinc-600 tabular-nums">
              Total:{" "}
              {deliveryLoadState === "loading" ? (
                <SkeletonBlock className="h-3 w-10 inline-block align-middle" />
              ) : (
                <span className="font-semibold text-slate-600 dark:text-zinc-400">
                  {hoursDistTotal}h
                </span>
              )}
            </div>
          </Section>
        </div>

        {/* ── Tickets by Member ────────────────────────────────────────────── */}
        <Section
          title="Tickets by Member"
          count={deliveryLoadState === "loading" ? undefined : ticketsByMember.reduce((sum, g) => sum + g.tickets.length, 0)}
          icon={
            <svg className="w-3.5 h-3.5 text-slate-400 dark:text-zinc-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <circle cx="12" cy="8" r="4" />
              <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
            </svg>
          }
        >
          <div className="space-y-5">
            {deliveryLoadState === "loading" ? (
              Array.from({ length: 3 }).map((_, gi) => (
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
              ))
            ) : deliveryLoadState === "error" ? (
              <p className="text-sm text-slate-400 dark:text-zinc-500">
                {deliveryLoadError ?? "Couldn't load Tickets by Member."}{" "}
                <button
                  type="button"
                  onClick={() => setDeliveryRequestId((id) => id + 1)}
                  className="font-medium text-brand-600 dark:text-brand-accent hover:underline"
                >
                  Retry
                </button>
              </p>
            ) : ticketsByMember.length === 0 ? (
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
                        projectSlug={deliveryProjectSlug}
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
                              (ticket_time_entries, period+filters-scoped)
                              — never the ticket's own estimate. */}
                          <span className="text-[11px] text-slate-400 dark:text-zinc-500 flex-shrink-0 tabular-nums">
                            {loggedHours}h
                          </span>
                          <PriorityBadge priority={t.priority} />
                          <StatusBadge status={t.status} label={t.statusName} />
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

      {/* ── Finance tab (Admin only) — billing/business metrics, kept fully
          separate from Delivery's project-execution metrics above. ─────── */}
      {isAdmin && tab === "finance" && (
        <>
          {/* ── Billing period + financial KPIs ──────────────────────────── */}
          <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
            <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">
              Billing Period
            </h2>
            <PeriodSelector value={period} onChange={setPeriod} customRange={customRange} onCustomRangeChange={setCustomRange} />
          </div>

          {financeLoadState === "loading" ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
              {Array.from({ length: 4 }).map((_, i) => (
                <div
                  key={i}
                  className="rounded-xl border border-slate-200 dark:border-zinc-700/70 bg-white dark:bg-zinc-900 px-5 pt-4 pb-4 shadow-sm shadow-slate-200/40 dark:shadow-black/20"
                >
                  <SkeletonBlock className="h-[10px] w-24 mb-2" />
                  <SkeletonBlock className="h-6 w-16 mb-1.5" />
                  <SkeletonBlock className="h-3 w-20" />
                </div>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
              <KpiCard
                label="Billable Hours"
                value={financeReady ? <>{financeKpiSummary.billableHours}<span className="text-base font-medium ml-0.5">h</span></> : "—"}
                sub="this period"
                accent
              />
              <KpiCard
                label="Non-billable Hours"
                value={financeReady ? <>{financeKpiSummary.nonBillableHours}<span className="text-base font-medium ml-0.5">h</span></> : "—"}
                sub="internal / overhead"
              />
              <KpiCard
                label="Utilization"
                value={financeReady ? `${financeKpiSummary.utilizationPct}%` : "—"}
                sub="billable ÷ logged"
                progress={financeReady ? Math.min(financeKpiSummary.utilizationPct, 100) : undefined}
                accent
              />
              <KpiCard
                label="Estimated Revenue"
                value={financeReady ? formatCurrency(financeKpiSummary.estimatedRevenue) : "—"}
                sub="billable hours × rate"
                accent
              />
            </div>
          )}

          {/* ── Sections ─────────────────────────────────────────────────── */}
          <div className="space-y-5">
            <Section
              title="Billing Overview"
              count={financeLoadState === "loading" ? undefined : billingOverviewRows.length}
              icon={
                <svg className="w-3.5 h-3.5 text-slate-400 dark:text-zinc-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.66 0-3 .672-3 1.5S10.34 11 12 11s3 .672 3 1.5-1.34 1.5-3 1.5m0-6V6m0 1v6m0 0v1m0-1c-1.66 0-3-.672-3-1.5M17 7H9a2 2 0 00-2 2v6a2 2 0 002 2h8a2 2 0 002-2V9a2 2 0 00-2-2z" />
                </svg>
              }
            >
              <div className="overflow-x-auto -mx-5 px-5">
                <table className="w-full text-sm min-w-[520px]">
                  <thead>
                    <tr className="border-b border-slate-100 dark:border-zinc-800">
                      <th className="pb-2.5 text-left text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600 w-[200px]">
                        Client
                      </th>
                      <th className="pb-2.5 text-right text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">
                        Billable Hours
                      </th>
                      <th className="pb-2.5 text-right text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">
                        Non-billable Hours
                      </th>
                      <th className="pb-2.5 text-right text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">
                        Average Rate
                      </th>
                      <th className="pb-2.5 text-right text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">
                        Estimated Invoice
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50 dark:divide-zinc-800/60">
                    {financeLoadState === "loading" ? (
                      Array.from({ length: 3 }).map((_, i) => (
                        <tr key={i}>
                          <td className="py-2.5 pr-4"><SkeletonBlock className="h-4 w-32" /></td>
                          <td className="py-2.5 text-right"><SkeletonBlock className="h-4 w-10 ml-auto" /></td>
                          <td className="py-2.5 text-right"><SkeletonBlock className="h-4 w-10 ml-auto" /></td>
                          <td className="py-2.5 text-right"><SkeletonBlock className="h-4 w-14 ml-auto" /></td>
                          <td className="py-2.5 text-right"><SkeletonBlock className="h-4 w-16 ml-auto" /></td>
                        </tr>
                      ))
                    ) : deliveryLoadState === "error" ? (
                      <tr>
                        <td colSpan={5} className="py-6 text-center text-sm text-slate-400 dark:text-zinc-500">
                          {deliveryLoadError ?? "Couldn't load Billing Overview."}{" "}
                          <button
                            type="button"
                            onClick={() => setDeliveryRequestId((id) => id + 1)}
                            className="font-medium text-brand-600 dark:text-brand-accent hover:underline"
                          >
                            Retry
                          </button>
                        </td>
                      </tr>
                    ) : billingOverviewRows.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-6 text-center text-sm text-slate-400 dark:text-zinc-500">
                          No real billing activity in the current report scope.
                        </td>
                      </tr>
                    ) : (
                      billingOverviewRows.map((row) => (
                        <tr key={row.id} className="hover:bg-slate-50/60 dark:hover:bg-zinc-800/30 transition-colors duration-150 cursor-default">
                          <td className="py-2.5 pr-4 font-medium text-slate-800 dark:text-zinc-200">
                            {row.client}
                          </td>
                          <td className="py-2.5 text-right font-semibold text-slate-800 dark:text-zinc-200 tabular-nums">
                            {row.billableHours}h
                          </td>
                          <td className="py-2.5 text-right tabular-nums">
                            {row.nonBillableHours > 0 ? (
                              <span className="text-slate-500 dark:text-zinc-400">{row.nonBillableHours}h</span>
                            ) : (
                              <span className="text-slate-300 dark:text-zinc-600">—</span>
                            )}
                          </td>
                          <td className="py-2.5 text-right tabular-nums">
                            {row.avgRate > 0 ? (
                              <span className="text-slate-500 dark:text-zinc-400">{formatCurrency(row.avgRate)}/h</span>
                            ) : (
                              <span className="text-slate-300 dark:text-zinc-600">—</span>
                            )}
                          </td>
                          <td className="py-2.5 text-right font-semibold text-brand-700 dark:text-brand-accent tabular-nums">
                            {formatCurrency(row.estimatedInvoice)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-slate-100 dark:border-zinc-800">
                      <td className="pt-2.5 font-semibold text-slate-600 dark:text-zinc-300">Total</td>
                      <td className="pt-2.5 text-right font-semibold text-slate-800 dark:text-zinc-200 tabular-nums">
                        {financeLoadState === "loading" ? (
                          <SkeletonBlock className="h-4 w-10 ml-auto" />
                        ) : (
                          <>{financeReady ? financeKpiSummary.billableHours : 0}h</>
                        )}
                      </td>
                      <td className="pt-2.5 text-right text-slate-500 dark:text-zinc-400 tabular-nums">
                        {financeLoadState === "loading" ? (
                          <SkeletonBlock className="h-4 w-10 ml-auto" />
                        ) : (
                          <>{financeReady ? financeKpiSummary.nonBillableHours : 0}h</>
                        )}
                      </td>
                      <td className="pt-2.5" />
                      <td className="pt-2.5 text-right font-bold text-brand-700 dark:text-brand-accent tabular-nums">
                        {financeLoadState === "loading" ? (
                          <SkeletonBlock className="h-4 w-16 ml-auto" />
                        ) : (
                          formatCurrency(financeReady ? financeKpiSummary.estimatedRevenue : 0)
                        )}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Section>

            <Section
              title="Billable Hours by Member"
              count={financeLoadState === "loading" ? undefined : billableHoursByMemberRows.length}
              icon={
                <svg className="w-3.5 h-3.5 text-slate-400 dark:text-zinc-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <circle cx="12" cy="8" r="4" />
                  <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
                </svg>
              }
            >
              <div className="overflow-x-auto -mx-5 px-5">
                <table className="w-full text-sm min-w-[480px]">
                  <thead>
                    <tr className="border-b border-slate-100 dark:border-zinc-800">
                      <th className="pb-2.5 text-left text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600 w-[200px]">
                        Member
                      </th>
                      <th className="pb-2.5 text-right text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">
                        Billable
                      </th>
                      <th className="pb-2.5 text-right text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">
                        Non-billable
                      </th>
                      <th className="pb-2.5 text-right text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">
                        Utilization %
                      </th>
                      <th className="pb-2.5 text-right text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">
                        Estimated Revenue
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50 dark:divide-zinc-800/60">
                    {financeLoadState === "loading" ? (
                      Array.from({ length: 3 }).map((_, i) => (
                        <tr key={i}>
                          <td className="py-2.5 pr-4"><SkeletonBlock className="h-4 w-32" /></td>
                          <td className="py-2.5 text-right"><SkeletonBlock className="h-4 w-10 ml-auto" /></td>
                          <td className="py-2.5 text-right"><SkeletonBlock className="h-4 w-10 ml-auto" /></td>
                          <td className="py-2.5 text-right"><SkeletonBlock className="h-4 w-10 ml-auto" /></td>
                          <td className="py-2.5 text-right"><SkeletonBlock className="h-4 w-16 ml-auto" /></td>
                        </tr>
                      ))
                    ) : deliveryLoadState === "error" ? (
                      <tr>
                        <td colSpan={5} className="py-6 text-center text-sm text-slate-400 dark:text-zinc-500">
                          {deliveryLoadError ?? "Couldn't load Billable Hours by Member."}{" "}
                          <button
                            type="button"
                            onClick={() => setDeliveryRequestId((id) => id + 1)}
                            className="font-medium text-brand-600 dark:text-brand-accent hover:underline"
                          >
                            Retry
                          </button>
                        </td>
                      </tr>
                    ) : billableHoursByMemberRows.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-6 text-center text-sm text-slate-400 dark:text-zinc-500">
                          No real billing activity in the current report scope.
                        </td>
                      </tr>
                    ) : (
                      billableHoursByMemberRows.map((row) => (
                        <tr key={row.id} className="hover:bg-slate-50/60 dark:hover:bg-zinc-800/30 transition-colors duration-150 cursor-default">
                          <td className="py-2.5 pr-4">
                            <MemberTrigger name={row.name} avatar={row.avatar} profileId={row.id} className="flex items-center gap-2.5">
                              <Avatar src={row.avatar} name={row.name} className="w-6 h-6 rounded-full flex-shrink-0" />
                              <span className="font-medium text-slate-800 dark:text-zinc-200">{row.name}</span>
                            </MemberTrigger>
                          </td>
                          <td className="py-2.5 text-right font-semibold text-slate-800 dark:text-zinc-200 tabular-nums">
                            {row.billableHours}h
                          </td>
                          <td className="py-2.5 text-right text-slate-500 dark:text-zinc-400 tabular-nums">
                            {row.nonBillableHours}h
                          </td>
                          <td className="py-2.5 text-right">
                            <UtilizationCell pct={row.utilizationPct} />
                          </td>
                          <td className="py-2.5 text-right font-semibold text-brand-700 dark:text-brand-accent tabular-nums">
                            {formatCurrency(row.estimatedRevenue)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </Section>
          </div>
        </>
      )}

    </div>
  );
}
