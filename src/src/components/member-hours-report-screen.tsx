"use client";

// JIR-119 — a Member's Reports → Hours: a personal, read-only timesheet
// (week strip / month calendar with a per-day total and a day detail, plus
// the original Custom Range summary). Only ever mounted for the MEMBER role
// (see hours-report-entry.tsx); Admin/Project Lead keep
// hours-report-screen.tsx untouched.
//
// Data is the same canonical logged time as before: the Member's own
// ticket_time_entries, fetched by loadProfileTimeEntriesForRange
// (`logged_by` = the session's own profile id, in the query) — once per
// visible period, never per day. Everything on screen and the Excel export
// derive from that one result through filterTimesheetEntries, so the
// calendar, the day detail and the export always agree.

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { useCurrentUser } from "@/components/current-user-provider";
import { Section } from "@/components/reports-shared";
import { SkeletonBlock } from "@/components/dashboard-shared";
import { getTodayISO } from "@/components/tickets/ticket-ui";
import { downloadBinaryFile } from "@/components/reports-screen";
import type { CustomRange } from "@/components/reports-screen";
import { DATE_INPUT_CLASS, PersonalProjectsFilter, SummaryPreview } from "@/components/hours-report-screen";
import { loadOrganizationTickets, loadProfileTimeEntriesForRange } from "@/lib/tickets";
import type { OrganizationTimeEntry } from "@/lib/tickets";
import { loadOrganizationProjects } from "@/lib/projects";
import {
  buildHoursReportData,
  buildHoursReportWorkbookSheets,
  buildHoursReportFilename,
  buildPersonalProjectOptions,
  reconcileProjectSelection,
} from "@/lib/hours-report";
import type { HoursReportData, HoursReportProjectOption } from "@/lib/hours-report";
import {
  MEMBER_PERIOD_OPTIONS,
  WEEKDAY_SHORT_LABELS,
  addDaysISO,
  addMonthsISO,
  dayOfMonth,
  filterTimesheetEntries,
  formatHoursLabel,
  formatLongDate,
  formatMonthLabel,
  formatWeekRangeLabel,
  monthEndISO,
  monthGridDays,
  monthStartISO,
  sumMinutesByDate,
  weekDaysISO,
  weekStartISO,
} from "@/lib/hours-timesheet";
import type { MemberPeriodKey } from "@/lib/hours-timesheet";
import { buildXlsxWorkbook } from "@/lib/xlsx-writer";
import type { Ticket } from "@/lib/mock-tickets";
import type { ProjectCategory } from "@/lib/mock-projects";

interface TimesheetProject {
  slug: string;
  name: string;
  status?: string;
  category: ProjectCategory;
}

// What's on screen: a week, a month, or the Custom Range summary. The
// period pills are only presets into this — after manual navigation the
// visible week/month here is the single source of truth for the totals, the
// detail and the export.
type TimesheetView =
  | { kind: "week"; weekStart: string }
  | { kind: "month"; monthStart: string }
  | { kind: "custom" };

type ScopeState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; tickets: Ticket[]; projects: TimesheetProject[] };

type RangeState = { from: string; to: string } & (
  | { status: "ready"; entries: OrganizationTimeEntry[]; projectOptions: HoursReportProjectOption[] }
  | { status: "error"; message: string }
);

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 dark:focus-visible:outline-brand-accent";

const DAY_CELL_BASE = `rounded-lg border transition-colors duration-150 cursor-pointer ${FOCUS_RING}`;
const DAY_CELL_IDLE =
  "border-slate-200 dark:border-zinc-700/70 bg-white dark:bg-zinc-900 hover:bg-slate-50 dark:hover:bg-zinc-800/60";
const DAY_CELL_SELECTED =
  "border-brand-500 dark:border-brand-accent ring-1 ring-brand-500 dark:ring-brand-accent bg-brand-50/60 dark:bg-brand-accent/10";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function dayAriaLabel(date: string, minutes: number | null, isToday: boolean): string {
  const hours = minutes === null ? "" : `, ${formatHoursLabel(minutes).replace("h", "")} hours logged`;
  return `${formatLongDate(date)}${isToday ? ", today" : ""}${hours}`;
}

// Today is a filled badge around the day number (a shape, not only a
// color); the selected day is the cell's own border/ring and aria-pressed —
// so the two read independently and stack when today is selected.
function DayNumber({ date, isToday }: { date: string; isToday: boolean }) {
  return (
    <span
      className={[
        "inline-flex items-center justify-center w-6 h-6 rounded-full text-sm tabular-nums",
        isToday
          ? "bg-brand-600 text-white font-bold dark:bg-brand-accent dark:text-brand-accent-foreground"
          : "font-medium text-slate-700 dark:text-zinc-200",
      ].join(" ")}
    >
      {dayOfMonth(date)}
    </span>
  );
}

// A day with logged time reads at a glance: a small accent dot plus the
// value in the accent color. 0h stays muted with no dot. This is the only
// "has hours" signal — the cell itself is never tinted for it, so it can't
// be confused with the selected day (border/fill) or today (number badge).
function DayHours({ minutes }: { minutes: number | null }) {
  if (minutes === null) return <SkeletonBlock className="h-3 w-6 mx-auto" />;
  if (minutes <= 0) {
    return (
      <span className="block text-[11px] sm:text-xs tabular-nums leading-none text-slate-400 dark:text-zinc-600">
        {formatHoursLabel(minutes)}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-center gap-1 text-[11px] sm:text-xs font-bold tabular-nums leading-none text-brand-600 dark:text-brand-accent">
      <span aria-hidden="true" className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-brand-accent" />
      {formatHoursLabel(minutes)}
    </span>
  );
}

function NavButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={`inline-flex items-center justify-center w-9 h-9 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-slate-600 dark:text-zinc-400 hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors cursor-pointer ${FOCUS_RING}`}
    >
      {children}
    </button>
  );
}

// Previous / label + period total / Today / Next — shared by the week strip
// and the month calendar.
function PeriodNavigator({
  unit,
  label,
  totalMinutes,
  onPrevious,
  onNext,
  onToday,
}: {
  unit: "week" | "month";
  label: string;
  /** null while the visible period is still loading. */
  totalMinutes: number | null;
  onPrevious: () => void;
  onNext: () => void;
  onToday: () => void;
}) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <NavButton label={`Previous ${unit}`} onClick={onPrevious}>
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path d="M15 18l-6-6 6-6" />
        </svg>
      </NavButton>
      <div className="flex-1 min-w-0 text-center" aria-live="polite">
        <div className="text-sm font-semibold text-slate-900 dark:text-zinc-50 truncate">{label}</div>
        <div className="text-xs text-slate-400 dark:text-zinc-500 tabular-nums">
          {totalMinutes === null ? "Loading…" : `${formatHoursLabel(totalMinutes)} logged`}
        </div>
      </div>
      <button
        type="button"
        onClick={onToday}
        className={`text-xs font-medium px-3 h-9 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-slate-600 dark:text-zinc-400 hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors cursor-pointer ${FOCUS_RING}`}
      >
        Today
      </button>
      <NavButton label={`Next ${unit}`} onClick={onNext}>
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path d="M9 18l6-6-6-6" />
        </svg>
      </NavButton>
    </div>
  );
}

function WeekStrip({
  weekStart,
  todayISO,
  selectedDate,
  minutesByDate,
  onSelect,
}: {
  weekStart: string;
  todayISO: string;
  selectedDate: string | null;
  /** null while the visible week is still loading. */
  minutesByDate: Map<string, number> | null;
  onSelect: (date: string) => void;
}) {
  return (
    <div className="grid grid-cols-7 gap-1 sm:gap-2">
      {weekDaysISO(weekStart).map((date, index) => {
        const minutes = minutesByDate ? minutesByDate.get(date) ?? 0 : null;
        const isToday = date === todayISO;
        const selected = date === selectedDate;
        return (
          <button
            key={date}
            type="button"
            aria-pressed={selected}
            aria-label={dayAriaLabel(date, minutes, isToday)}
            onClick={() => onSelect(date)}
            className={`${DAY_CELL_BASE} ${selected ? DAY_CELL_SELECTED : DAY_CELL_IDLE} flex flex-col items-center gap-1.5 px-0.5 py-2.5 sm:py-3 min-h-[76px]`}
          >
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-zinc-500 leading-none">
              {WEEKDAY_SHORT_LABELS[index]}
            </span>
            <DayNumber date={date} isToday={isToday} />
            <DayHours minutes={minutes} />
          </button>
        );
      })}
    </div>
  );
}

function MonthCalendar({
  monthStart,
  todayISO,
  selectedDate,
  minutesByDate,
  onSelect,
}: {
  monthStart: string;
  todayISO: string;
  selectedDate: string | null;
  /** null while the visible month is still loading. */
  minutesByDate: Map<string, number> | null;
  onSelect: (date: string) => void;
}) {
  return (
    <div>
      <div className="grid grid-cols-7 gap-1 sm:gap-2 mb-1.5" aria-hidden="true">
        {WEEKDAY_SHORT_LABELS.map((weekday) => (
          <div
            key={weekday}
            className="text-center text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-zinc-500"
          >
            {weekday}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1 sm:gap-2">
        {monthGridDays(monthStart).map(({ date, inMonth }) => {
          // Days of the adjacent months only complete the grid's rows: this
          // month's fetch has no data for them, so they carry no total and
          // aren't selectable.
          if (!inMonth) {
            return (
              <div
                key={date}
                aria-hidden="true"
                className="rounded-lg min-h-[52px] sm:min-h-[68px] flex flex-col items-center pt-1.5 sm:pt-2 text-sm tabular-nums text-slate-300 dark:text-zinc-700"
              >
                <span className="inline-flex items-center justify-center h-6">{dayOfMonth(date)}</span>
              </div>
            );
          }
          const minutes = minutesByDate ? minutesByDate.get(date) ?? 0 : null;
          const isToday = date === todayISO;
          const selected = date === selectedDate;
          return (
            <button
              key={date}
              type="button"
              aria-pressed={selected}
              aria-label={dayAriaLabel(date, minutes, isToday)}
              onClick={() => onSelect(date)}
              className={`${DAY_CELL_BASE} ${selected ? DAY_CELL_SELECTED : DAY_CELL_IDLE} flex flex-col items-center gap-1 sm:gap-1.5 px-0.5 pt-1.5 sm:pt-2 pb-1.5 min-h-[52px] sm:min-h-[68px]`}
            >
              <DayNumber date={date} isToday={isToday} />
              <DayHours minutes={minutes} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

// One day's entries, grouped by project like the Hours Report summary —
// built by the same buildHoursReportData, just from that day's entries.
function DayDetail({ data }: { data: HoursReportData }) {
  if (data.projectGroups.length === 0) {
    return <p className="text-sm text-slate-400 dark:text-zinc-500 py-6 text-center">No hours logged for this day.</p>;
  }
  return (
    <div className="space-y-4">
      {data.projectGroups.map((group) => (
        <div key={group.projectSlug}>
          <h3 className="text-xs font-bold text-slate-700 dark:text-zinc-200 mb-1">
            {group.projectName}
            {group.isInternal && (
              <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-zinc-500 bg-slate-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded-full align-middle">
                Internal
              </span>
            )}
          </h3>
          <ul>
            {group.tickets.map((ticket) => (
              <li
                key={ticket.ticketKey}
                className="flex items-baseline gap-3 py-1.5 border-b border-slate-100 dark:border-zinc-800/70 text-sm"
              >
                <Link
                  href={`/projects/${group.projectSlug}/tickets/${ticket.ticketKey}`}
                  className="flex-shrink-0 whitespace-nowrap text-slate-500 dark:text-zinc-400 hover:underline"
                >
                  {ticket.ticketKey}
                </Link>
                <span className="flex-1 min-w-0 text-slate-700 dark:text-zinc-300 break-words">{ticket.summary}</span>
                <span className="flex-shrink-0 text-slate-700 dark:text-zinc-300 tabular-nums">{round2(ticket.hours)}</span>
              </li>
            ))}
          </ul>
          <div className="flex items-baseline justify-end gap-3 pt-1.5 text-xs font-bold text-slate-600 dark:text-zinc-300">
            <span>Project Total</span>
            <span className="tabular-nums">{round2(group.totalHours)}</span>
          </div>
        </div>
      ))}
      <div className="flex items-baseline justify-end gap-3 pt-3 border-t border-slate-200 dark:border-zinc-700/70 text-sm font-bold text-slate-900 dark:text-zinc-50">
        <span>Day Total</span>
        <span className="tabular-nums">{round2(data.grandTotalHours)}</span>
      </div>
    </div>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export function MemberHoursReportScreen() {
  const { user, organization, userId } = useCurrentUser();
  const userName = user.name;
  // A plain id, not the `organization` object — see hours-report-screen.tsx.
  const organizationId = organization?.id;

  const todayISO = getTodayISO();

  const [view, setView] = useState<TimesheetView>(() => ({ kind: "week", weekStart: weekStartISO(todayISO) }));
  const [selectedDate, setSelectedDate] = useState<string | null>(todayISO);
  const [customRange, setCustomRange] = useState<CustomRange>(() => ({
    from: monthStartISO(todayISO),
    to: monthEndISO(monthStartISO(todayISO)),
  }));
  // Empty = "All projects" — see PersonalProjectsFilter.
  const [selectedProjectSlugs, setSelectedProjectSlugs] = useState<string[]>([]);

  const [scope, setScope] = useState<ScopeState>({ status: "loading" });
  const [rangeState, setRangeState] = useState<RangeState | null>(null);
  const [downloadingExcel, setDownloadingExcel] = useState(false);

  // ── Scope load — page entry / actual org change only ───────────────────────
  // The same RLS-scoped tickets/projects every other Member screen reads
  // (only projects this Member can see); never the org member list, and
  // never a project's hourly rate.
  useEffect(() => {
    if (!organizationId || !userId) return;
    let cancelled = false;
    (async () => {
      const [ticketsResult, projectsResult] = await Promise.all([
        loadOrganizationTickets(organizationId),
        loadOrganizationProjects(organizationId),
      ]);
      if (cancelled) return;
      if (ticketsResult.status === "error") {
        setScope({ status: "error", message: ticketsResult.message });
        return;
      }
      if (projectsResult.status === "error") {
        setScope({ status: "error", message: projectsResult.message });
        return;
      }
      const categoryBySlug = new Map(projectsResult.projects.map((p) => [p.slug, p.category]));
      setScope({
        status: "ready",
        tickets: ticketsResult.tickets,
        projects: ticketsResult.projects.map((p) => ({
          slug: p.slug,
          name: p.name,
          status: p.status,
          category: categoryBySlug.get(p.slug) ?? "internal",
        })),
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [organizationId, userId]);

  // The visible period — the one range the fetch, the totals and the Excel
  // export all use.
  const { from, to } =
    view.kind === "week"
      ? { from: view.weekStart, to: addDaysISO(view.weekStart, 6) }
      : view.kind === "month"
      ? { from: view.monthStart, to: monthEndISO(view.monthStart) }
      : customRange;
  const invalidRange = view.kind === "custom" && Boolean(from) && Boolean(to) && from > to;

  // ── Period fetch — one query set per visible period ────────────────────────
  // `logged_by = userId` is in the query itself and `userId` is the
  // session's own profile id, so nothing on this page can widen it to
  // another person's hours. The Projects filter only narrows these rows
  // client-side (it isn't a dependency here), so toggling it never refetches.
  useEffect(() => {
    if (scope.status !== "ready" || !userId || invalidRange || !from || !to) return;
    let cancelled = false;
    const { tickets, projects } = scope;
    (async () => {
      const result = await loadProfileTimeEntriesForRange(userId, tickets.map((t) => t.id), from, to);
      if (cancelled) return;
      if (result.status === "error") {
        setRangeState({ from, to, status: "error", message: result.message });
        return;
      }
      const entries: OrganizationTimeEntry[] = result.entries.map((r) => ({
        ticketId: r.ticketId,
        loggedBy: r.loggedByProfileId,
        minutes: r.minutes,
        workDate: r.workDate,
        comment: r.comment,
      }));
      const projectOptions = buildPersonalProjectOptions(projects, entries, tickets);
      setRangeState({ from, to, status: "ready", entries, projectOptions });
      setSelectedProjectSlugs((prev) => reconcileProjectSelection(prev, projectOptions));
    })();
    return () => {
      cancelled = true;
    };
  }, [scope, userId, from, to, invalidRange]);

  // A result only counts for the period it was fetched for: while the next
  // period loads, nothing from the previous one is shown under the new
  // week/month heading.
  const current = rangeState && rangeState.from === from && rangeState.to === to ? rangeState : null;
  const loaded = current?.status === "ready" ? current : null;
  const rangeError = current?.status === "error" ? current.message : null;

  const derived = useMemo(() => {
    if (scope.status !== "ready" || !loaded || !userId) return null;
    const entries = filterTimesheetEntries(
      loaded.entries,
      scope.tickets,
      scope.projects.map((p) => p.slug),
      selectedProjectSlugs
    );
    const members = [{ id: userId, name: userName }];
    const build = (subset: OrganizationTimeEntry[]) =>
      buildHoursReportData(scope.tickets, scope.projects, members, subset, false);
    return {
      minutesByDate: sumMinutesByDate(entries),
      totalMinutes: entries.reduce((sum, entry) => sum + entry.minutes, 0),
      // The whole visible period — Custom Range's summary and the export.
      periodData: build(entries),
      dayData: selectedDate ? build(entries.filter((entry) => entry.workDate === selectedDate)) : null,
    };
  }, [scope, loaded, userId, userName, selectedProjectSlugs, selectedDate]);

  // ── Period presets ─────────────────────────────────────────────────────────
  const currentWeekStart = weekStartISO(todayISO);
  const currentMonthStart = monthStartISO(todayISO);
  const lastMonthStart = addMonthsISO(currentMonthStart, -1);

  // Which pill reads as active follows what's actually visible, so a pill
  // never claims "This Month" over a month navigated away from.
  const activePeriod: MemberPeriodKey | null =
    view.kind === "custom"
      ? "custom"
      : view.kind === "week"
      ? view.weekStart === currentWeekStart
        ? "this-week"
        : null
      : view.monthStart === currentMonthStart
      ? "this-month"
      : view.monthStart === lastMonthStart
      ? "last-month"
      : null;

  function showMonth(monthStart: string) {
    setView({ kind: "month", monthStart });
    // Only the current month has a "today" to land on; any other month
    // opens with no day selected rather than a same-numbered guess.
    setSelectedDate(monthStart === currentMonthStart ? todayISO : null);
  }

  function showWeek(weekStart: string, selected: string) {
    setView({ kind: "week", weekStart });
    setSelectedDate(selected);
  }

  function selectPeriod(key: MemberPeriodKey) {
    if (key === "this-week") showWeek(currentWeekStart, todayISO);
    else if (key === "this-month") showMonth(currentMonthStart);
    else if (key === "last-month") showMonth(lastMonthStart);
    else setView({ kind: "custom" });
  }

  // Moving a week keeps the same weekday selected, so the detail follows.
  function shiftWeek(weeks: number) {
    if (view.kind !== "week") return;
    const weekStart = addDaysISO(view.weekStart, weeks * 7);
    const selected =
      selectedDate && selectedDate >= view.weekStart && selectedDate <= addDaysISO(view.weekStart, 6)
        ? addDaysISO(selectedDate, weeks * 7)
        : weekStart;
    showWeek(weekStart, selected);
  }

  async function handleDownloadExcel() {
    if (!derived || !from || !to) return;
    setDownloadingExcel(true);
    try {
      const sheets = await buildHoursReportWorkbookSheets(derived.periodData, from, to, userName);
      downloadBinaryFile(
        buildHoursReportFilename(from, to, "xlsx", userName),
        buildXlsxWorkbook(sheets),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
    } finally {
      setDownloadingExcel(false);
    }
  }

  const canDownloadExcel =
    Boolean(derived) && derived!.periodData.projectGroups.length > 0 && !invalidRange && !downloadingExcel;

  const cardClass =
    "rounded-xl border border-slate-200 dark:border-zinc-700/70 bg-white dark:bg-zinc-900 shadow-sm shadow-slate-200/40 dark:shadow-black/20";
  const errorClass =
    "rounded-xl border border-red-200 dark:border-red-700/40 bg-red-50 dark:bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-400";

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 pb-16">
      <div className="flex items-start justify-between mb-5 gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-zinc-50 tracking-tight leading-none">
            Hours Report
          </h1>
          <p className="text-xs text-slate-400 dark:text-zinc-500 mt-0.5">Your logged hours by day</p>
        </div>
        <button
          type="button"
          onClick={handleDownloadExcel}
          disabled={!canDownloadExcel}
          className="flex-shrink-0 inline-flex items-center gap-1.5 text-xs font-semibold px-3.5 py-2 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed text-white transition-colors shadow-sm shadow-brand-500/30 cursor-pointer dark:bg-brand-accent dark:hover:bg-brand-accent-strong dark:shadow-brand-accent/30 dark:text-brand-accent-foreground"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
          </svg>
          {downloadingExcel ? "Preparing…" : "Download Excel"}
        </button>
      </div>

      {scope.status === "error" ? (
        <div className={errorClass}>{scope.message || "Something went wrong loading the Hours Report."}</div>
      ) : (
        <>
          <div className={`${cardClass} px-4 py-3.5 mb-3`}>
            <div className="flex items-center gap-3 flex-wrap">
              <div className="inline-flex items-center gap-0.5 rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800/60 p-1 max-w-full overflow-x-auto">
                {MEMBER_PERIOD_OPTIONS.map((option) => {
                  const active = option.key === activePeriod;
                  return (
                    <button
                      key={option.key}
                      type="button"
                      aria-pressed={active}
                      onClick={() => selectPeriod(option.key)}
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

              {view.kind === "custom" && (
                <div className="flex items-end gap-3 flex-wrap">
                  <label className="block">
                    <span className="block text-xs font-medium text-slate-500 dark:text-zinc-400 mb-1">From</span>
                    <input
                      type="date"
                      value={customRange.from}
                      max={customRange.to || undefined}
                      onChange={(e) => setCustomRange({ ...customRange, from: e.target.value })}
                      className={DATE_INPUT_CLASS}
                    />
                  </label>
                  <label className="block">
                    <span className="block text-xs font-medium text-slate-500 dark:text-zinc-400 mb-1">To</span>
                    <input
                      type="date"
                      value={customRange.to}
                      min={customRange.from || undefined}
                      onChange={(e) => setCustomRange({ ...customRange, to: e.target.value })}
                      className={DATE_INPUT_CLASS}
                    />
                  </label>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 mb-5">
            <PersonalProjectsFilter
              projects={loaded?.projectOptions ?? []}
              selected={selectedProjectSlugs}
              onChange={setSelectedProjectSlugs}
            />
          </div>

          {invalidRange && (
            <p className="text-xs text-red-600 dark:text-red-400 mb-4">
              The &quot;From&quot; date must be on or before the &quot;To&quot; date.
            </p>
          )}

          {view.kind !== "custom" && (
            <div className={`${cardClass} p-3 sm:p-5 mb-3`}>
              {view.kind === "week" ? (
                <>
                  <PeriodNavigator
                    unit="week"
                    label={formatWeekRangeLabel(view.weekStart, todayISO)}
                    totalMinutes={derived?.totalMinutes ?? null}
                    onPrevious={() => shiftWeek(-1)}
                    onNext={() => shiftWeek(1)}
                    onToday={() => showWeek(currentWeekStart, todayISO)}
                  />
                  <WeekStrip
                    weekStart={view.weekStart}
                    todayISO={todayISO}
                    selectedDate={selectedDate}
                    minutesByDate={derived?.minutesByDate ?? null}
                    onSelect={setSelectedDate}
                  />
                </>
              ) : (
                <>
                  <PeriodNavigator
                    unit="month"
                    label={formatMonthLabel(view.monthStart)}
                    totalMinutes={derived?.totalMinutes ?? null}
                    onPrevious={() => showMonth(addMonthsISO(view.monthStart, -1))}
                    onNext={() => showMonth(addMonthsISO(view.monthStart, 1))}
                    onToday={() => showMonth(currentMonthStart)}
                  />
                  <MonthCalendar
                    monthStart={view.monthStart}
                    todayISO={todayISO}
                    selectedDate={selectedDate}
                    minutesByDate={derived?.minutesByDate ?? null}
                    onSelect={setSelectedDate}
                  />
                </>
              )}
            </div>
          )}

          {rangeError !== null ? (
            <div className={errorClass}>{rangeError || "Something went wrong loading logged hours."}</div>
          ) : view.kind === "custom" ? (
            <Section title="Summary">
              {invalidRange ? null : derived ? (
                <SummaryPreview data={derived.periodData} />
              ) : (
                <div className="space-y-2">
                  <SkeletonBlock className="h-5 w-40" />
                  <SkeletonBlock className="h-24 w-full" />
                </div>
              )}
            </Section>
          ) : (
            <Section title={selectedDate ? formatLongDate(selectedDate) : "Day detail"}>
              {!selectedDate ? (
                <p className="text-sm text-slate-400 dark:text-zinc-500 py-6 text-center">
                  Select a day to see its logged hours.
                </p>
              ) : derived?.dayData ? (
                <DayDetail data={derived.dayData} />
              ) : (
                <div className="space-y-2">
                  <SkeletonBlock className="h-5 w-40" />
                  <SkeletonBlock className="h-16 w-full" />
                </div>
              )}
            </Section>
          )}
        </>
      )}
    </div>
  );
}
