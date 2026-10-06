"use client";

// Dedicated Hours Report page (/reports/hours) — the full experience the
// Reports page's own "Hours Report" card (reports-screen.tsx) now just
// links into. Everything here reuses existing, already-real building
// blocks rather than inventing parallel ones:
//   - loadOrganizationTickets / loadOrganizationMembers (lib/tickets.ts,
//     lib/projects.ts) for the org-wide ticket/project/member universe —
//     the exact same real queries Reports' own Delivery tab already uses.
//   - loadOrganizationLoggedTimeForRange (lib/tickets.ts) for the real,
//     work_date-filtered time entries — never ticket creation date or a
//     time entry's own created_at.
//   - buildHoursReportData / buildHoursReportWorkbookSheets (lib/hours-
//     report.ts) for the Summary/Details shaping — the exact same
//     functions the previous inline card used, now shared between the live
//     preview below and the real .xlsx export, so the two can never
//     disagree.
//   - buildXlsxWorkbook (lib/xlsx-writer.ts) + downloadBinaryFile
//     (reports-screen.tsx, exported for this reuse) for the real .xlsx
//     bytes and the browser download.
//   - PeriodKey/PERIOD_OPTIONS/CustomRange/realRangeForPeriod (reports-
//     screen.tsx) for the exact same "This Month/Last Month/This
//     Quarter/Custom Range" date math Reports' own period selectors
//     already use — only the pill/inline-date UI here is new, not the date
//     arithmetic.
//
// Access (JIR-113): every role can open this report; what it shows comes
// from getHoursReportCapabilities (lib/hours-report.ts) — Admin/Project
// Lead get the administrative report, a Member gets a personal one (only
// their own entries, Projects filter, Excel; no People, no PDF). Whether
// the report carries `$` at all is a completely
// separate question, answered once by hasFinancialAccess (lib/current-user.ts,
// `canViewFinancials` below) and threaded into buildHoursReportData's own
// `includeFinancials` parameter — every renderer (this screen's preview,
// the PDF, both Excel sheets) reads the resulting `data.includesFinancials`
// flag rather than re-deriving the permission itself. An Admin still gets
// the org-wide universe above; any Project Lead (financial or not) instead
// gets only the projects loadLeadProjects says they lead, fanned out
// per-project via loadProjectTickets/loadProjectTeam (never the org-wide
// loaders) — so project scope is always the same for a Project Lead
// regardless of financial_access, and a non-financial Project Lead's own
// real hourly rate is never even carried into this screen's state (see the
// data-scope effect below), not just hidden from the rendered columns.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useCurrentUser } from "@/components/current-user-provider";
import { Section } from "@/components/reports-shared";
import { SkeletonBlock } from "@/components/dashboard-shared";
import { getTodayISO } from "@/components/tickets/ticket-ui";
import {
  PERIOD_OPTIONS,
  realRangeForPeriod,
  downloadBinaryFile,
} from "@/components/reports-screen";
import type { PeriodKey, CustomRange } from "@/components/reports-screen";
import {
  loadOrganizationTickets,
  loadOrganizationLoggedTimeForRange,
  loadProfileTimeEntriesForRange,
  loadProjectTickets,
} from "@/lib/tickets";
import type { OrganizationTimeEntry } from "@/lib/tickets";
import { loadOrganizationProjects, loadOrganizationMembers, loadLeadProjects, loadProjectTeam } from "@/lib/projects";
import type { OrgMember, OrgMembersResult } from "@/lib/projects";
import {
  buildHoursReportData,
  buildHoursReportWorkbookSheets,
  formatCurrencyAmount,
  buildHoursReportPeopleOptions,
  filterTimeEntriesByPeople,
  reconcilePeopleSelection,
  getHoursReportCapabilities,
  buildHoursReportFilename,
  buildPersonalProjectOptions,
  reconcileProjectSelection,
} from "@/lib/hours-report";
import type { HoursReportData, HoursReportPersonOption, HoursReportProjectOption } from "@/lib/hours-report";
import { buildXlsxWorkbook } from "@/lib/xlsx-writer";
import { buildHoursReportPdf } from "@/lib/hours-report-pdf";
import type { Ticket } from "@/lib/mock-tickets";
import type { ProjectCategory } from "@/lib/mock-projects";

interface ReportProject {
  slug: string;
  name: string;
  /** Real project status — only read by a Member's Projects options
   *  (buildPersonalProjectOptions), to keep archived projects out unless
   *  they have hours in the period. */
  status?: string;
  /** Project Settings' own real category — Client or Internal. The sole
   *  source of truth for whether this project's hours are billable (see
   *  buildHoursReportData); never inferred from `defaultHourlyRate`. */
  category: ProjectCategory;
  /** Project Settings' own real hourly rate (Client-category projects only)
   *  — the exact same rate Reports' Finance tab already bills hours
   *  against, never a new rate model. null/undefined for a project with no
   *  rate set (contributes $0, same as Finance's own rule). */
  defaultHourlyRate?: number | null;
}

// $ display for a possibly-null (Internal-category) amount — an em dash
// instead of a currency-formatted 0, so Internal hours never read as
// "billed at $0." Only ever called from inside a `data.includesFinancials`
// branch, so `amount` is really just `number | null` there — `undefined`
// is accepted only so callers don't need an extra cast.
function formatAmountOrDash(amount: number | null | undefined): string {
  return amount === null || amount === undefined ? "—" : formatCurrencyAmount(round2(amount));
}

const DATE_INPUT_CLASS =
  "text-[16px] sm:text-sm bg-slate-50 dark:bg-zinc-800 text-slate-800 dark:text-zinc-100 rounded-md border border-slate-200 dark:border-zinc-700 px-2.5 py-1.5 outline-none focus:ring-2 focus:ring-brand-500/30 transition-colors dark:focus:ring-brand-accent/30";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Date presets (pills) ──────────────────────────────────────────────────────
// Same 4 PeriodKey values/labels Reports' own period selectors already use
// (PERIOD_OPTIONS) — just rendered as a plain pill row with inline From/To
// fields instead of a popover, per this page's own spec (dates only ever
// show/editable when "Custom Range" is the active preset).
function DatePresetBar({
  period,
  onPeriodChange,
  customRange,
  onCustomRangeChange,
}: {
  period: PeriodKey;
  onPeriodChange: (key: PeriodKey) => void;
  customRange: CustomRange;
  onCustomRangeChange: (range: CustomRange) => void;
}) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="inline-flex items-center gap-0.5 rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800/60 p-1">
        {PERIOD_OPTIONS.map((option) => {
          const active = option.key === period;
          return (
            <button
              key={option.key}
              type="button"
              onClick={() => onPeriodChange(option.key)}
              className={[
                "text-xs font-medium px-2.5 py-1.5 rounded-md transition-colors duration-150 whitespace-nowrap cursor-pointer",
                active
                  ? "bg-white dark:bg-zinc-900 text-slate-900 dark:text-zinc-50 shadow-sm"
                  : "text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-200",
              ].join(" ")}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      {period === "custom" && (
        <div className="flex items-end gap-3 flex-wrap">
          <label className="block">
            <span className="block text-xs font-medium text-slate-500 dark:text-zinc-400 mb-1">From</span>
            <input
              type="date"
              value={customRange.from}
              max={customRange.to || undefined}
              onChange={(e) => onCustomRangeChange({ ...customRange, from: e.target.value })}
              className={DATE_INPUT_CLASS}
            />
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-slate-500 dark:text-zinc-400 mb-1">To</span>
            <input
              type="date"
              value={customRange.to}
              min={customRange.from || undefined}
              onChange={(e) => onCustomRangeChange({ ...customRange, to: e.target.value })}
              className={DATE_INPUT_CLASS}
            />
          </label>
        </div>
      )}
    </div>
  );
}

// ── Multi-select filter shell ─────────────────────────────────────────────────
// The one dropdown both the Projects and People filters render through, so
// the two can never drift apart visually. Purpose-built rather than reusing
// tickets/filter-dropdown.tsx's generic FilterDropdown — each caller decides
// for itself what its "All" row means (see ProjectsFilter/PeopleFilter).
function CheckboxMark({ checked }: { checked: boolean }) {
  return (
    <span
      className={[
        "flex-shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors",
        checked
          ? "bg-brand-600 border-brand-600 dark:bg-brand-accent dark:border-brand-accent"
          : "border-slate-300 dark:border-zinc-600",
      ].join(" ")}
    >
      {checked && (
        <svg className="w-3 h-3 text-white dark:text-brand-accent-foreground" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
          <path d="M5 12l5 5L20 7" />
        </svg>
      )}
    </span>
  );
}

function MultiSelectFilter({
  buttonLabel,
  dialogLabel,
  isFiltered,
  allRowLabel,
  allChecked,
  onToggleAll,
  options,
  onToggleOption,
  emptyMessage,
}: {
  buttonLabel: string;
  dialogLabel: string;
  /** Whether the button reads as an active (narrowing) filter. */
  isFiltered: boolean;
  allRowLabel: string;
  allChecked: boolean;
  onToggleAll: () => void;
  options: { key: string; label: string; checked: boolean }[];
  onToggleOption: (key: string) => void;
  /** Shown under the "All" row when there are no options at all. */
  emptyMessage?: string;
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

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={[
          "inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border transition-colors duration-150 shadow-sm cursor-pointer",
          !isFiltered
            ? "border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-slate-600 dark:text-zinc-400 hover:bg-slate-50 dark:hover:bg-zinc-800"
            : "border-brand-200 dark:border-brand-accent/50 bg-brand-50/60 dark:bg-brand-accent/10 text-brand-700 dark:text-brand-accent",
        ].join(" ")}
      >
        {buttonLabel}
        <svg
          className={`w-3 h-3 text-slate-400 dark:text-zinc-600 mt-px transition-transform duration-150 ${open ? "-rotate-180" : ""}`}
          fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={dialogLabel}
          className="absolute left-0 top-full mt-1.5 z-30 w-64 max-h-80 overflow-y-auto rounded-xl border border-slate-200 dark:border-zinc-700/60 bg-white dark:bg-zinc-900 shadow-lg shadow-black/10 dark:shadow-black/40 py-1.5"
        >
          <button
            type="button"
            onClick={onToggleAll}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-left text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800/60 transition-colors"
          >
            <CheckboxMark checked={allChecked} />
            <span className="font-medium">{allRowLabel}</span>
          </button>

          <div className="my-1 mx-2 border-t border-slate-100 dark:border-zinc-800" />

          {options.length === 0 && emptyMessage && (
            <p className="px-3 py-1.5 text-xs text-slate-400 dark:text-zinc-500">{emptyMessage}</p>
          )}

          {options.map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => onToggleOption(option.key)}
              className={[
                "w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-left transition-colors",
                option.checked
                  ? "text-brand-700 dark:text-brand-accent bg-brand-50/60 dark:bg-brand-accent/10"
                  : "text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800/60",
              ].join(" ")}
            >
              <CheckboxMark checked={option.checked} />
              <span className="truncate">{option.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Projects filter ───────────────────────────────────────────────────────────
// "All projects selected by default" — here `selected` always holds the
// real, currently-included slugs, and an explicit "All Projects" row
// selects/deselects every one of them at once.
function ProjectsFilter({
  projects,
  selected,
  onChange,
}: {
  projects: ReportProject[];
  selected: string[];
  onChange: (slugs: string[]) => void;
}) {
  const allSelected = projects.length > 0 && selected.length === projects.length;
  const selectedSet = new Set(selected);

  function toggleAll() {
    onChange(allSelected ? [] : projects.map((p) => p.slug));
  }

  function toggleOne(slug: string) {
    onChange(selectedSet.has(slug) ? selected.filter((s) => s !== slug) : [...selected, slug]);
  }

  const label = allSelected
    ? "All projects"
    : selected.length === 0
    ? "No projects"
    : `${selected.length} of ${projects.length} projects`;

  return (
    <MultiSelectFilter
      buttonLabel={`Projects: ${label}`}
      dialogLabel="Projects filter"
      isFiltered={!allSelected}
      allRowLabel="All Projects"
      allChecked={allSelected}
      onToggleAll={toggleAll}
      options={projects.map((p) => ({ key: p.slug, label: p.name, checked: selectedSet.has(p.slug) }))}
      onToggleOption={toggleOne}
    />
  );
}

// ── People filter (JIR-112) ───────────────────────────────────────────────────
// Unlike Projects, an empty `selected` is the "All people" default — no
// filter at all, exactly the report's pre-JIR-112 behavior. `people` is
// only ever the real participants for the current Projects + date range
// (buildHoursReportPeopleOptions), and `selected` is reconciled against it
// whenever that changes, so it never holds an invisible stale person.
function PeopleFilter({
  people,
  selected,
  onChange,
}: {
  people: HoursReportPersonOption[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const selectedSet = new Set(selected);
  const isAll = selected.length === 0;

  function toggleOne(id: string) {
    const next = selectedSet.has(id) ? selected.filter((s) => s !== id) : [...selected, id];
    // Every participant checked individually is the same report as "All
    // people" — normalized back to it so the label never says "5 of 5".
    onChange(next.length === people.length ? [] : next);
  }

  const label = isAll
    ? "All people"
    : selected.length === 1
    ? people.find((p) => p.id === selected[0])?.name ?? "1 person"
    : `${selected.length} of ${people.length} people`;

  return (
    <MultiSelectFilter
      buttonLabel={`People: ${label}`}
      dialogLabel="People filter"
      isFiltered={!isAll}
      allRowLabel="All People"
      allChecked={isAll}
      onToggleAll={() => onChange([])}
      options={people.map((p) => ({ key: p.id, label: p.name, checked: selectedSet.has(p.id) }))}
      onToggleOption={toggleOne}
      emptyMessage="No one logged time for the selected projects and dates."
    />
  );
}

// ── Personal Projects filter (JIR-113, Member) ───────────────────────────────
// A Member's Projects filter: like PeopleFilter, an empty `selected` is the
// "All projects" default, and `projects` is every non-archived project this
// Member can access (buildPersonalProjectOptions) — including ones where
// they haven't logged any time yet — plus any archived one with hours in
// the selected period.
function PersonalProjectsFilter({
  projects,
  selected,
  onChange,
}: {
  projects: HoursReportProjectOption[];
  selected: string[];
  onChange: (slugs: string[]) => void;
}) {
  const selectedSet = new Set(selected);
  const isAll = selected.length === 0;

  function toggleOne(slug: string) {
    const next = selectedSet.has(slug) ? selected.filter((s) => s !== slug) : [...selected, slug];
    onChange(next.length === projects.length ? [] : next);
  }

  const label = isAll
    ? "All projects"
    : selected.length === 1
    ? projects.find((p) => p.slug === selected[0])?.name ?? "1 project"
    : `${selected.length} of ${projects.length} projects`;

  return (
    <MultiSelectFilter
      buttonLabel={`Projects: ${label}`}
      dialogLabel="Projects filter"
      isFiltered={!isAll}
      allRowLabel="All Projects"
      allChecked={isAll}
      onToggleAll={() => onChange([])}
      options={projects.map((p) => ({ key: p.slug, label: p.name, checked: selectedSet.has(p.slug) }))}
      onToggleOption={toggleOne}
      emptyMessage="No projects available."
    />
  );
}

// ── Summary preview ───────────────────────────────────────────────────────────
// Exact same grouping/subtotal/total shape as the Excel Summary sheet
// (buildHoursReportWorkbookSheets) — rendered as a table instead of
// worksheet rows, off the exact same HoursReportData.
function SummaryPreview({ data }: { data: HoursReportData }) {
  if (data.projectGroups.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center text-center py-16 px-4">
        <div className="w-10 h-10 rounded-lg border border-slate-200 dark:border-zinc-700 flex items-center justify-center text-slate-400 dark:text-zinc-500 mb-3">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M4 19V9M12 19V5M20 19v-7" />
          </svg>
        </div>
        <h3 className="text-sm font-semibold text-slate-700 dark:text-zinc-200">No logged hours</h3>
        <p className="text-sm text-slate-400 mt-1 max-w-xs dark:text-zinc-500">
          No time was logged in the selected date range for the selected projects.
        </p>
      </div>
    );
  }

  const includeFinancials = data.includesFinancials;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 dark:border-zinc-700/70">
            <th className="text-left pb-2 pr-3 text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">Ticket</th>
            <th className="text-left pb-2 pr-3 text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">Summary</th>
            <th className={`text-right pb-2 ${includeFinancials ? "pr-3" : ""} text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600`}>Hours</th>
            {includeFinancials && (
              <th className="text-right pb-2 text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">$</th>
            )}
          </tr>
        </thead>
        <tbody>
          {data.projectGroups.map((group) => (
            <TableFragmentGroup key={group.projectName} group={group} includeFinancials={includeFinancials} />
          ))}
          <tr>
            <td colSpan={2} className="pt-3 pr-3 text-right text-sm font-bold text-slate-900 dark:text-zinc-50">
              TOTAL HOURS
            </td>
            <td className={`pt-3 ${includeFinancials ? "pr-3" : ""} text-right text-sm font-bold text-slate-900 dark:text-zinc-50 tabular-nums`}>
              {round2(data.grandTotalHours)}
            </td>
            {includeFinancials && (
              <td className="pt-3 text-right text-sm font-bold text-slate-900 dark:text-zinc-50 tabular-nums">
                {formatCurrencyAmount(round2(data.grandTotalAmount ?? 0))}
              </td>
            )}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function TableFragmentGroup({
  group,
  includeFinancials,
}: {
  group: HoursReportData["projectGroups"][number];
  includeFinancials: boolean;
}) {
  return (
    <>
      <tr>
        <td colSpan={includeFinancials ? 4 : 3} className="pt-4 pb-1.5 text-xs font-bold text-slate-700 dark:text-zinc-200">
          {group.projectName}
          {group.isInternal && (
            <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-zinc-500 bg-slate-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded-full align-middle">
              Internal
            </span>
          )}
        </td>
      </tr>
      {group.tickets.map((ticket) => (
        <tr key={ticket.ticketKey} className="border-b border-slate-100 dark:border-zinc-800/70">
          <td className="py-1.5 pr-3 text-slate-500 dark:text-zinc-400 whitespace-nowrap">
            <Link href={`/projects/${group.projectSlug}/tickets/${ticket.ticketKey}`} className="hover:underline">
              {ticket.ticketKey}
            </Link>
          </td>
          <td className="py-1.5 pr-3 text-slate-700 dark:text-zinc-300">{ticket.summary}</td>
          <td className={`py-1.5 ${includeFinancials ? "pr-3" : ""} text-right text-slate-700 dark:text-zinc-300 tabular-nums`}>{round2(ticket.hours)}</td>
          {includeFinancials && (
            <td className="py-1.5 text-right text-slate-700 dark:text-zinc-300 tabular-nums">{formatAmountOrDash(ticket.amount)}</td>
          )}
        </tr>
      ))}
      <tr>
        <td colSpan={2} className="pt-1.5 pb-1 pr-3 text-right text-xs font-bold text-slate-600 dark:text-zinc-300">
          Project Total
        </td>
        <td className={`pt-1.5 pb-1 ${includeFinancials ? "pr-3" : ""} text-right text-xs font-bold text-slate-600 dark:text-zinc-300 tabular-nums`}>
          {round2(group.totalHours)}
        </td>
        {includeFinancials && (
          <td className="pt-1.5 pb-1 text-right text-xs font-bold text-slate-600 dark:text-zinc-300 tabular-nums">
            {formatAmountOrDash(group.totalAmount)}
          </td>
        )}
      </tr>
    </>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export function HoursReportScreen() {
  const { user, organization, userId } = useCurrentUser();
  // JIR-113 — every per-role difference on this screen comes from this one
  // capability set (lib/hours-report.ts), not scattered role checks.
  const capabilities = getHoursReportCapabilities(user.role, user.financialAccess);
  const isAdmin = capabilities.scope === "organization";
  // Member: a personal report — only this signed-in user's own entries.
  const isPersonal = capabilities.scope === "own";
  // Whether the report carries `$` at all — hasFinancialAccess, via the
  // capability set: Admin always; a Project Lead only with their own real
  // financial_access grant; never a Member. Fed straight into
  // buildHoursReportData's own `includeFinancials` parameter below; every
  // renderer (this screen, the PDF, both Excel sheets) then reads the
  // resulting `data.includesFinancials` rather than re-deriving this itself.
  const canViewFinancials = capabilities.includeFinancials;
  const userName = user.name;
  const userAvatar = user.avatar;
  // A plain id, not the `organization` object itself, is what the org-wide
  // load effect below keys off of. CurrentUserProvider revalidates the
  // session's membership (and so produces a brand-new `organization`
  // object, even though nothing about it changed) on window focus regain —
  // that's deliberate, global behavior this page must not alter, but this
  // page's own report shouldn't silently refetch/reset its filters every
  // time an Admin tabs back in. Keying off the id (a stable primitive)
  // instead of the object reference means the effect still reruns for an
  // actual org change or the page's own first mount, just never for a
  // same-org focus-driven re-fetch upstream.
  const organizationId = organization?.id;

  const todayISO = getTodayISO();
  const defaultRange = useMemo(() => realRangeForPeriod("this-month", { from: "", to: "" }, todayISO), [todayISO]);

  const [period, setPeriod] = useState<PeriodKey>("this-month");
  const [customRange, setCustomRange] = useState<CustomRange>(defaultRange);

  const [rawTickets, setRawTickets] = useState<Ticket[]>([]);
  const [rawProjects, setRawProjects] = useState<ReportProject[]>([]);
  const [rawMembers, setRawMembers] = useState<OrgMember[]>([]);
  const [orgLoadState, setOrgLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [orgLoadError, setOrgLoadError] = useState<string | null>(null);

  const [selectedProjectSlugs, setSelectedProjectSlugs] = useState<string[]>([]);
  // True only until the first real project list arrives — after that, the
  // Admin's own (de)selections are authoritative and this never re-runs the
  // "select everything" default again.
  const projectsInitialized = useRef(false);

  // Empty = "All people" (JIR-112) — see PeopleFilter.
  const [selectedPersonIds, setSelectedPersonIds] = useState<string[]>([]);

  // The raw result of the preview fetch below — the selected projects'
  // tickets plus their real time entries in range. `hoursData` and the
  // People options (or, for a Member, the Projects options) are all derived
  // from this, so a People change — or a Member's Projects change — never
  // refetches anything; it only re-derives from data already loaded.
  const [rangeResult, setRangeResult] = useState<{
    tickets: Ticket[];
    entries: OrganizationTimeEntry[];
    people: HoursReportPersonOption[];
    projectOptions: HoursReportProjectOption[];
  } | null>(null);
  const [previewState, setPreviewState] = useState<"loading" | "ready" | "error">("loading");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [downloadingExcel, setDownloadingExcel] = useState(false);
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

  // ── Data-scope load — page entry / actual org change only ──────────────────
  // Deliberately keyed on `organizationId` (see its own comment above), not
  // on `[isAdmin, organization]`: this effect now runs exactly once on
  // mount (or if the org id / caller identity genuinely changes) and never
  // again on a window-focus-driven membership revalidation. Date/project
  // filter changes still refresh the report — that's the separate preview
  // effect below, keyed on `from`/`to`/`selectedProjectSlugs`, untouched by
  // this.
  //
  // Three data scopes, from `capabilities.scope` (never from
  // `canViewFinancials`, which never changes *which projects* are loaded,
  // only whether a real rate ever enters this screen's state at all — see
  // below):
  //   - Admin: every real org project/ticket/member, exactly as before.
  //   - Member (JIR-113): the same RLS-scoped tickets/projects every other
  //     Member screen already reads (loadOrganizationTickets — only projects
  //     they can see), but never the org member list: the only "member" in
  //     a personal report is the signed-in user, and the entries themselves
  //     are fetched as `logged_by = this user` (see the preview effect).
  //   - Project Lead (financial or not): only the projects
  //     `loadLeadProjects` says this exact profile leads
  //     (project_memberships.project_role = 'lead') — the same real
  //     "projects I'm staffed on as lead" primitive
  //     project-lead-time-tracking-screen.tsx already uses, fanned out with
  //     loadProjectTickets/loadProjectTeam per led project rather than the
  //     org-wide loaders. This is what keeps the report from ever
  //     expanding project scope: a Project Lead can only ever see hours
  //     (and, if authorized, $) for projects they already lead, never the
  //     whole org — identical for a financial and a non-financial Project
  //     Lead, since this scoping is about role, not about the money
  //     permission.
  useEffect(() => {
    if (!organizationId || (!isAdmin && !userId)) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: shows the loading state for this effect's own (rare) reruns — mount, or an actual org id/identity change
    setOrgLoadState("loading");

    // Shared tail for both scopes below — the exact same "apply real
    // tickets/projects/members, flip to ready, seed the one-time default
    // Projects selection" sequence, so the two data paths can never diverge
    // in how they finish.
    function applyLoadedScope(tickets: Ticket[], projects: ReportProject[], members: OrgMember[]) {
      const slugsWithTickets = new Set(tickets.map((t) => t.projectSlug));
      setRawTickets(tickets);
      setRawProjects(projects);
      setRawMembers(members);
      setOrgLoadState("ready");

      // Same-batch default selection — deliberately set here (not in a
      // separate effect reacting to the derived project list) so a fresh
      // "all selected" state and `orgLoadState: "ready"` always land in the
      // same render. A separate effect would leave one intermediate render
      // where the org data is ready but the selection hasn't caught up
      // yet, which the preview fetch below would see and read as "0
      // projects selected" — a real, if brief, empty-report flash.
      // `projectsInitialized` still guards this to "only ever once per
      // this effect's lifetime" — now academic for focus (this effect no
      // longer reruns on focus at all), but still correct if this effect
      // ever reruns for a genuine org id/identity change.
      // A Member's Projects default is instead the empty "All projects"
      // selection (see PersonalProjectsFilter).
      if (!projectsInitialized.current) {
        projectsInitialized.current = true;
        setSelectedProjectSlugs(isPersonal ? [] : projects.filter((p) => slugsWithTickets.has(p.slug)).map((p) => p.slug));
      }
    }

    (async () => {
      if (isAdmin || isPersonal) {
        const [ticketsResult, projectsResult, membersResult] = await Promise.all([
          loadOrganizationTickets(organizationId),
          loadOrganizationProjects(organizationId),
          isAdmin
            ? loadOrganizationMembers(organizationId)
            : Promise.resolve<OrgMembersResult>({
                status: "ready",
                members: [{ id: userId!, name: userName, avatar: userAvatar }],
              }),
        ]);
        if (cancelled) return;

        if (ticketsResult.status === "error") {
          setOrgLoadState("error");
          setOrgLoadError(ticketsResult.message);
          return;
        }
        if (projectsResult.status === "error") {
          setOrgLoadState("error");
          setOrgLoadError(projectsResult.message);
          return;
        }
        if (membersResult.status === "error") {
          setOrgLoadState("error");
          setOrgLoadError(membersResult.message);
          return;
        }

        // The real Project Settings hourly rate and category both live on
        // loadOrganizationProjects' own ProjectSummary (loadOrganizationTickets
        // only forwards a slug/name/status subset) — pulled in here for the
        // `$` column and its Client/Internal billing rule, same real
        // rate/category Finance's own billing widgets already read.
        const projectDetailsBySlug = new Map(
          projectsResult.projects.map((p) => [p.slug, { category: p.category, defaultHourlyRate: p.defaultHourlyRate ?? null }])
        );
        const projects = ticketsResult.projects.map((p) => {
          const details = projectDetailsBySlug.get(p.slug);
          return {
            slug: p.slug,
            name: p.name,
            status: p.status,
            category: details?.category ?? "internal",
            // Always true for Admin (unchanged); never for a Member, whose
            // session never carries a real rate into this screen.
            defaultHourlyRate: canViewFinancials ? details?.defaultHourlyRate ?? null : null,
          };
        });

        applyLoadedScope(ticketsResult.tickets, projects, membersResult.members);
        return;
      }

      // Project Lead (financial or not) — scoped to exactly the projects
      // they lead, same as the financial case; only the rate below differs.
      const leadResult = await loadLeadProjects(organizationId, userId!);
      if (cancelled) return;
      if (leadResult.status === "error") {
        setOrgLoadState("error");
        setOrgLoadError(leadResult.message);
        return;
      }

      const ledSlugs = leadResult.projects.map((p) => p.slug);
      if (ledSlugs.length === 0) {
        applyLoadedScope([], [], []);
        return;
      }

      const [projectsResult, ticketsPerProject, teamPerProject] = await Promise.all([
        loadOrganizationProjects(organizationId),
        Promise.all(ledSlugs.map((slug) => loadProjectTickets(organizationId, slug))),
        Promise.all(ledSlugs.map((slug) => loadProjectTeam(organizationId, slug))),
      ]);
      if (cancelled) return;

      if (projectsResult.status === "error") {
        setOrgLoadState("error");
        setOrgLoadError(projectsResult.message);
        return;
      }
      const failedTickets = ticketsPerProject.find((r) => r.status === "error");
      if (failedTickets && failedTickets.status === "error") {
        setOrgLoadState("error");
        setOrgLoadError(failedTickets.message);
        return;
      }
      const failedTeam = teamPerProject.find((r) => r.status === "error");
      if (failedTeam && failedTeam.status === "error") {
        setOrgLoadState("error");
        setOrgLoadError(failedTeam.message);
        return;
      }

      const ledSlugSet = new Set(ledSlugs);
      // Category always flows through (it's not itself a monetary value —
      // the "Internal" label stays visible regardless), but the real rate
      // is only ever carried into this screen's own state when this exact
      // viewer has financial access — never fetched-then-hidden. A
      // non-financial Project Lead's session simply never holds a real
      // rate number, which is what keeps this from being enforcement by
      // UI/export formatting alone.
      const projects = projectsResult.projects
        .filter((p) => ledSlugSet.has(p.slug))
        .map((p) => ({
          slug: p.slug,
          name: p.name,
          category: p.category,
          defaultHourlyRate: canViewFinancials ? p.defaultHourlyRate ?? null : null,
        }));
      const tickets = ticketsPerProject.flatMap((r) => (r.status === "ready" ? r.tickets : []));
      const memberById = new Map<string, OrgMember>();
      for (const teamResult of teamPerProject) {
        if (teamResult.status !== "ready") continue;
        for (const member of teamResult.members) {
          if (!memberById.has(member.id)) {
            memberById.set(member.id, { id: member.id, name: member.name, avatar: member.avatar });
          }
        }
      }

      applyLoadedScope(tickets, projects, Array.from(memberById.values()));
    })();

    return () => {
      cancelled = true;
    };
  }, [isAdmin, isPersonal, organizationId, userId, userName, userAvatar, canViewFinancials]);

  // Projects with at least one real ticket — same "only real, in-scope
  // values" convention Reports' own Project filter already follows.
  const projectsWithTickets = useMemo(() => {
    const slugsWithTickets = new Set(rawTickets.map((t) => t.projectSlug));
    return rawProjects.filter((p) => slugsWithTickets.has(p.slug));
  }, [rawTickets, rawProjects]);

  const { from, to } = realRangeForPeriod(period, customRange, todayISO);
  const invalidRange = period === "custom" && Boolean(from) && Boolean(to) && from > to;

  // Admin/Project Lead's Projects selection scopes the fetch itself; a
  // Member's only filters already-loaded rows (their options depend on the
  // fetch, not the other way around), so it's kept out of the fetch's deps.
  const fetchProjectSlugs = isPersonal ? null : selectedProjectSlugs;

  // ── Preview fetch — re-runs on date range / project selection change ───────
  // Scopes the real query to only the tickets in the selected projects
  // (rather than fetching every org ticket's entries and filtering after),
  // so a Projects deselection is a smaller real query, not a client-side
  // filter over a bigger one.
  useEffect(() => {
    if (orgLoadState !== "ready" || invalidRange || !from || !to) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: shows the preview's own loading state the instant filters change, before the async fetch resolves
    setPreviewState("loading");

    // JIR-113 — Member: only this signed-in user's own entries, across
    // every ticket they can see, for the period. loadProfileTimeEntriesForRange
    // filters `logged_by = userId` in the query itself, and `userId` is the
    // session's own profile id (useCurrentUser), never a value from the
    // page — so no filter state here can widen it to someone else's hours.
    // Projects options are every non-archived project this Member can
    // access (rawProjects is already RLS-scoped), so a project with no
    // logged time stays selectable; these entries only add back an
    // archived project that has hours in the period. Any
    // selected project no longer accessible is dropped in this same batch
    // (no separate effect, no stale invisible filter, no loop:
    // selectedProjectSlugs isn't a dependency for a Member).
    if (isPersonal) {
      (async () => {
        const result = await loadProfileTimeEntriesForRange(userId!, rawTickets.map((t) => t.id), from, to);
        if (cancelled) return;
        if (result.status === "error") {
          setPreviewState("error");
          setPreviewError(result.message);
          return;
        }
        const entries: OrganizationTimeEntry[] = result.entries.map((r) => ({
          ticketId: r.ticketId,
          loggedBy: r.loggedByProfileId,
          minutes: r.minutes,
          workDate: r.workDate,
          comment: r.comment,
        }));
        const projectOptions = buildPersonalProjectOptions(rawProjects, entries, rawTickets);
        setRangeResult({ tickets: rawTickets, entries, people: [], projectOptions });
        setSelectedProjectSlugs((prev) => reconcileProjectSelection(prev, projectOptions));
        setPreviewState("ready");
      })();
      return () => {
        cancelled = true;
      };
    }

    const selectedSlugSet = new Set(fetchProjectSlugs ?? []);
    const scopedTickets = rawTickets.filter((t) => selectedSlugSet.has(t.projectSlug));
    const ticketIds = scopedTickets.map((t) => t.id);

    (async () => {
      const result = await loadOrganizationLoggedTimeForRange(ticketIds, from, to);
      if (cancelled) return;

      if (result.status === "error") {
        setPreviewState("error");
        setPreviewError(result.message);
        return;
      }

      // People options come from these exact entries — only real
      // participants (> 0 minutes) in the selected projects + range, never
      // project membership. Any selected person no longer among them is
      // dropped in this same batch (never a separate effect reacting to
      // the options), so there's no render where a stale, invisible person
      // filter is applied, and no state loop: selectedPersonIds isn't a
      // dependency of this effect.
      const people = buildHoursReportPeopleOptions(result.entries, rawMembers);
      setRangeResult({ tickets: scopedTickets, entries: result.entries, people, projectOptions: [] });
      setSelectedPersonIds((prev) => reconcilePeopleSelection(prev, people));
      setPreviewState("ready");
    })();

    return () => {
      cancelled = true;
    };
  }, [orgLoadState, rawTickets, rawProjects, rawMembers, fetchProjectSlugs, isPersonal, userId, from, to, invalidRange]);

  // `canViewFinancials` is buildHoursReportData's own authorization gate
  // (its `includeFinancials` parameter) — the single point the resulting
  // HoursReportData's `includesFinancials` flag comes from, which the
  // preview below, handleDownloadExcel, and handleDownloadPdf all read
  // instead of re-deciding this themselves. The People filter (or, for a
  // Member, the Projects filter — buildHoursReportData drops any entry
  // whose ticket isn't passed in) is applied before this, so every total,
  // the preview, and the exports are built from the same fully-filtered set.
  const hoursData = useMemo<HoursReportData | null>(() => {
    if (!rangeResult) return null;
    const personalSlugSet = isPersonal && selectedProjectSlugs.length > 0 ? new Set(selectedProjectSlugs) : null;
    return buildHoursReportData(
      personalSlugSet ? rangeResult.tickets.filter((t) => personalSlugSet.has(t.projectSlug)) : rangeResult.tickets,
      rawProjects,
      rawMembers.map((m) => ({ id: m.id, name: m.name })),
      isPersonal ? rangeResult.entries : filterTimeEntriesByPeople(rangeResult.entries, selectedPersonIds),
      canViewFinancials
    );
  }, [rangeResult, rawProjects, rawMembers, selectedPersonIds, isPersonal, selectedProjectSlugs, canViewFinancials]);

  async function handleDownloadExcel() {
    if (!hoursData || !from || !to) return;
    setDownloadingExcel(true);
    try {
      // A Member's personal workbook is labeled with their own session
      // name (JIR-113) — presentation only; the data is already theirs.
      const personalUserName = isPersonal ? userName : undefined;
      const sheets = await buildHoursReportWorkbookSheets(hoursData, from, to, personalUserName);
      const bytes = buildXlsxWorkbook(sheets);
      downloadBinaryFile(
        buildHoursReportFilename(from, to, "xlsx", personalUserName),
        bytes,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
    } finally {
      setDownloadingExcel(false);
    }
  }

  // Same `hoursData`/`from`/`to` as handleDownloadExcel above — the PDF is
  // never a separate query or a separately-filtered dataset, just a
  // different rendering of the exact same already-computed Summary.
  async function handleDownloadPdf() {
    if (!hoursData || !from || !to) return;
    setDownloadingPdf(true);
    setPdfError(null);
    try {
      const bytes = await buildHoursReportPdf(hoursData, `${from} to ${to}`);
      downloadBinaryFile(`jirita-hours-report-${from}-to-${to}.pdf`, bytes, "application/pdf");
    } catch (err) {
      setPdfError(err instanceof Error ? err.message : "Something went wrong generating the PDF.");
    } finally {
      setDownloadingPdf(false);
    }
  }

  const hasReportData = Boolean(hoursData) && hoursData!.projectGroups.length > 0 && previewState === "ready";
  const canDownloadExcel = hasReportData && !downloadingExcel;
  const canDownloadPdf = hasReportData && !downloadingPdf;

  return (
    <div className="max-w-5xl mx-auto px-6 py-6 pb-16">
      <div className="flex items-start justify-between mb-5 gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-zinc-50 tracking-tight leading-none">
            Hours Report
          </h1>
          <p className="text-xs text-slate-400 dark:text-zinc-500 mt-0.5">
            Logged hours by project and ticket
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {capabilities.canDownloadPdf && (
            <button
              type="button"
              onClick={handleDownloadPdf}
              disabled={!canDownloadPdf}
              className="inline-flex items-center gap-1.5 text-xs font-semibold px-3.5 py-2 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-slate-600 dark:text-zinc-400 hover:bg-slate-50 dark:hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm cursor-pointer"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
              </svg>
              {downloadingPdf ? "Preparing…" : "Download PDF"}
            </button>
          )}
          <button
            type="button"
            onClick={handleDownloadExcel}
            disabled={!canDownloadExcel}
            className="inline-flex items-center gap-1.5 text-xs font-semibold px-3.5 py-2 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed text-white transition-colors shadow-sm shadow-brand-500/30 cursor-pointer dark:bg-brand-accent dark:hover:bg-brand-accent-strong dark:shadow-brand-accent/30 dark:text-brand-accent-foreground"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
            </svg>
            {downloadingExcel ? "Preparing…" : "Download Excel"}
          </button>
        </div>
      </div>

      {pdfError && (
        <div className="rounded-xl border border-red-200 dark:border-red-700/40 bg-red-50 dark:bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-400 mb-3">
          {pdfError}
        </div>
      )}

      {orgLoadState === "error" ? (
        <div className="rounded-xl border border-red-200 dark:border-red-700/40 bg-red-50 dark:bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-400">
          {orgLoadError ?? "Something went wrong loading the Hours Report."}
        </div>
      ) : (
        <>
          <div className="rounded-xl border border-slate-200 dark:border-zinc-700/70 bg-white dark:bg-zinc-900 px-4 py-3.5 shadow-sm shadow-slate-200/40 dark:shadow-black/20 mb-3">
            <DatePresetBar
              period={period}
              onPeriodChange={setPeriod}
              customRange={customRange}
              onCustomRangeChange={setCustomRange}
            />
          </div>

          <div className="flex items-center gap-2 mb-5">
            {isPersonal ? (
              <PersonalProjectsFilter
                projects={rangeResult?.projectOptions ?? []}
                selected={selectedProjectSlugs}
                onChange={setSelectedProjectSlugs}
              />
            ) : (
              <ProjectsFilter
                projects={projectsWithTickets}
                selected={selectedProjectSlugs}
                onChange={setSelectedProjectSlugs}
              />
            )}
            {capabilities.canFilterPeople && (
              <PeopleFilter
                people={rangeResult?.people ?? []}
                selected={selectedPersonIds}
                onChange={setSelectedPersonIds}
              />
            )}
          </div>

          {invalidRange && (
            <p className="text-xs text-red-600 dark:text-red-400 mb-4">
              The &quot;From&quot; date must be on or before the &quot;To&quot; date.
            </p>
          )}

          <Section title="Summary">
            {orgLoadState === "loading" || previewState === "loading" ? (
              <div className="space-y-2">
                <SkeletonBlock className="h-5 w-40" />
                <SkeletonBlock className="h-24 w-full" />
              </div>
            ) : previewState === "error" ? (
              <div className="rounded-lg border border-red-200 dark:border-red-700/40 bg-red-50 dark:bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-400">
                {previewError ?? "Something went wrong loading logged hours."}
              </div>
            ) : hoursData ? (
              <SummaryPreview data={hoursData} />
            ) : null}
          </Section>
        </>
      )}
    </div>
  );
}
