"use client";

// The Hours Report's visual timesheet pieces (Reports → Hours), shared by
// both screens so there is one implementation: a Member's personal report
// (member-hours-report-screen.tsx, JIR-119) and the administrative report
// for Admin/Project Lead (hours-report-screen.tsx, JIR-120). Everything here
// is presentation plus the view state; what the numbers cover (own hours,
// or a Projects + People scope) is decided by the screen that passes them
// in. All calendar math and navigation rules live in lib/hours-timesheet.ts.

import { useCallback, useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import Link from "next/link";
import { SkeletonBlock } from "@/components/dashboard-shared";
import { getTodayISO } from "@/components/tickets/ticket-ui";
import {
  TIMESHEET_PERIOD_OPTIONS,
  WEEKDAY_SHORT_LABELS,
  dayOfMonth,
  formatHoursLabel,
  formatLongDate,
  formatMonthLabel,
  formatWeekRangeLabel,
  initialTimesheetState,
  monthEndISO,
  monthGridDays,
  monthStartISO,
  timesheetActivePeriod,
  timesheetRange,
  timesheetReducer,
  weekDaysISO,
} from "@/lib/hours-timesheet";
import {
  parseListParam,
  timesheetStateFromParams,
  timesheetStateToParams,
  toQueryString,
} from "@/lib/hours-report-url";
import type { QueryParams } from "@/lib/hours-report-url";
import type {
  TimesheetAction,
  TimesheetDayDetail,
  TimesheetDayTicket,
  TimesheetPeriodKey,
  TimesheetState,
} from "@/lib/hours-timesheet";

export const DATE_INPUT_CLASS =
  "text-[16px] sm:text-sm bg-slate-50 dark:bg-zinc-800 text-slate-800 dark:text-zinc-100 rounded-md border border-slate-200 dark:border-zinc-700 px-2.5 py-1.5 outline-none focus:ring-2 focus:ring-brand-500/30 transition-colors dark:focus:ring-brand-accent/30";

export const TIMESHEET_CARD_CLASS =
  "rounded-xl border border-slate-200 dark:border-zinc-700/70 bg-white dark:bg-zinc-900 shadow-sm shadow-slate-200/40 dark:shadow-black/20";

// ── View state ───────────────────────────────────────────────────────────────
// Which week/month/custom range is on screen and which day is selected —
// opens on the current week with today selected. `from`/`to` are the
// visible period: the one range a screen fetches, totals and exports.
export interface TimesheetViewState extends TimesheetState {
  todayISO: string;
  customRange: { from: string; to: string };
  setCustomRange: (range: { from: string; to: string }) => void;
  from: string;
  to: string;
  /** Custom Range only: From is after To. */
  invalidRange: boolean;
  activePeriod: TimesheetPeriodKey | null;
  dispatch: (action: TimesheetAction) => void;
  /** This view as URL search params — see lib/hours-report-url.ts. */
  urlParams: QueryParams;
}

// ── URL state ────────────────────────────────────────────────────────────────
// The report's navigable state lives in the URL's search params, so a
// browser refresh (or a shared link) reopens the same period, day and
// filters. React state stays the source of truth while the page is open:
// it is seeded from the URL once, on mount, and then written back to it.

/** What the URL asked for when the page opened — untrusted until validated. */
export interface HoursReportUrlSnapshot {
  timesheet: ReturnType<typeof timesheetStateFromParams>;
  /** null = not in the URL. */
  projects: string[] | null;
  people: string[] | null;
}

export function useHoursReportUrlSnapshot(): HoursReportUrlSnapshot {
  const searchParams = useSearchParams();
  const [snapshot] = useState<HoursReportUrlSnapshot>(() => {
    const get = (key: string) => searchParams?.get(key) ?? null;
    return {
      timesheet: timesheetStateFromParams(get, getTodayISO()),
      projects: parseListParam(get("projects")),
      people: parseListParam(get("people")),
    };
  });
  return snapshot;
}

// Writes `params` to the URL whenever they differ from what's there —
// replacing the current history entry (no entry per click, so Back still
// leaves the report, and returning to it restores the last state). Pass
// null while the state isn't final yet (e.g. the default selection hasn't
// loaded), so a URL's own params are never overwritten early. It only ever
// writes; it never reads the URL back into state, so it cannot loop.
export function useSyncHoursReportUrl(params: QueryParams | null): void {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const next = params === null ? null : toQueryString(params);
  const current = searchParams?.toString() ?? "";
  useEffect(() => {
    if (next === null || !pathname) return;
    if (new URLSearchParams(next).toString() === current) return;
    window.history.replaceState(null, "", next ? `${pathname}?${next}` : pathname);
  }, [next, current, pathname]);
}

export function useTimesheetView(initial?: HoursReportUrlSnapshot["timesheet"]): TimesheetViewState {
  const todayISO = getTodayISO();
  const [state, setState] = useState<TimesheetState>(() => initial?.state ?? initialTimesheetState(todayISO));
  const [customRange, setCustomRange] = useState(
    () => initial?.customRange ?? { from: monthStartISO(todayISO), to: monthEndISO(monthStartISO(todayISO)) }
  );
  const dispatch = useCallback(
    (action: TimesheetAction) => setState((prev) => timesheetReducer(prev, action, getTodayISO())),
    []
  );
  const { from, to } = timesheetRange(state.view, customRange);
  return {
    ...state,
    todayISO,
    customRange,
    setCustomRange,
    from,
    to,
    invalidRange: state.view.kind === "custom" && Boolean(from) && Boolean(to) && from > to,
    activePeriod: timesheetActivePeriod(state.view, todayISO),
    dispatch,
    urlParams: timesheetStateToParams(state, customRange, todayISO),
  };
}

// ── Period pills (+ From/To for Custom Range) ────────────────────────────────
export function TimesheetPeriodBar({ timesheet }: { timesheet: TimesheetViewState }) {
  const { customRange, setCustomRange } = timesheet;
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="inline-flex items-center gap-0.5 rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800/60 p-1 max-w-full overflow-x-auto">
        {TIMESHEET_PERIOD_OPTIONS.map((option) => {
          const active = option.key === timesheet.activePeriod;
          return (
            <button
              key={option.key}
              type="button"
              aria-pressed={active}
              onClick={() => timesheet.dispatch({ type: "preset", key: option.key })}
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

      {timesheet.view.kind === "custom" && (
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
  );
}

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 dark:focus-visible:outline-brand-accent";

const DAY_CELL_BASE = `rounded-lg border transition-colors duration-150 cursor-pointer ${FOCUS_RING}`;
const DAY_CELL_IDLE =
  "border-slate-200 dark:border-zinc-700/70 bg-white dark:bg-zinc-900 hover:bg-slate-50 dark:hover:bg-zinc-800/60";
const DAY_CELL_SELECTED =
  "border-brand-500 dark:border-brand-accent ring-1 ring-brand-500 dark:ring-brand-accent bg-brand-50/60 dark:bg-brand-accent/10";

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

// A day with logged time reads at a glance: its value sits in a compact
// accent pill. 0h stays plain muted text. The pill is the only "has hours"
// signal — the cell itself is never tinted for it, so it can't be confused
// with the selected day (cell border/fill) or today (number badge), and all
// three can show on the same day.
function DayHours({ minutes }: { minutes: number | null }) {
  if (minutes === null) return <SkeletonBlock className="h-3 w-6 mx-auto" />;
  const base = "inline-block py-0.5 text-[11px] sm:text-xs tabular-nums leading-none";
  if (minutes <= 0) {
    return <span className={`${base} text-slate-400 dark:text-zinc-600`}>{formatHoursLabel(minutes)}</span>;
  }
  return (
    <span
      className={`${base} px-1 sm:px-1.5 rounded-full font-bold bg-brand-100 text-brand-700 dark:bg-brand-accent/20 dark:text-brand-accent`}
    >
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

// ── Week strip / month calendar card ─────────────────────────────────────────
// Renders nothing for Custom Range, which has no calendar. `minutesByDate`
// and `totalMinutes` are whatever scope the screen computed them for; both
// are null while the visible period is still loading.
export function TimesheetCalendar({
  timesheet,
  minutesByDate,
  totalMinutes,
}: {
  timesheet: TimesheetViewState;
  minutesByDate: Map<string, number> | null;
  totalMinutes: number | null;
}) {
  const { view, todayISO, selectedDate, dispatch } = timesheet;
  if (view.kind === "custom") return null;
  const onSelect = (date: string) => dispatch({ type: "select", date });
  return (
    <div className={`${TIMESHEET_CARD_CLASS} p-3 sm:p-5 mb-3`}>
      <PeriodNavigator
        unit={view.kind}
        label={view.kind === "week" ? formatWeekRangeLabel(view.weekStart, todayISO) : formatMonthLabel(view.monthStart)}
        totalMinutes={totalMinutes}
        onPrevious={() => dispatch({ type: "shift", by: -1 })}
        onNext={() => dispatch({ type: "shift", by: 1 })}
        onToday={() => dispatch({ type: "today" })}
      />
      {view.kind === "week" ? (
        <WeekStrip
          weekStart={view.weekStart}
          todayISO={todayISO}
          selectedDate={selectedDate}
          minutesByDate={minutesByDate}
          onSelect={onSelect}
        />
      ) : (
        <MonthCalendar
          monthStart={view.monthStart}
          todayISO={todayISO}
          selectedDate={selectedDate}
          minutesByDate={minutesByDate}
          onSelect={onSelect}
        />
      )}
    </div>
  );
}

// ── Day detail ───────────────────────────────────────────────────────────────

function hoursFromMinutes(minutes: number): number {
  return Math.round((minutes / 60) * 100) / 100;
}

function TicketRows({ projectSlug, tickets }: { projectSlug: string; tickets: TimesheetDayTicket[] }) {
  return (
    <ul>
      {tickets.map((ticket) => (
        <li
          key={ticket.ticketKey}
          className="flex items-baseline gap-3 py-1.5 border-b border-slate-100 dark:border-zinc-800/70 text-sm"
        >
          <Link
            href={`/projects/${projectSlug}/tickets/${ticket.ticketKey}`}
            className="flex-shrink-0 whitespace-nowrap text-slate-500 dark:text-zinc-400 hover:underline"
          >
            {ticket.ticketKey}
          </Link>
          <span className="flex-1 min-w-0 text-slate-700 dark:text-zinc-300 break-words">{ticket.summary}</span>
          <span className="flex-shrink-0 text-slate-700 dark:text-zinc-300 tabular-nums">
            {hoursFromMinutes(ticket.minutes)}
          </span>
        </li>
      ))}
    </ul>
  );
}

// One day's logged time: Project → Ticket, or Project → Person → Ticket
// when `showPeople` is set (several people can be in scope). The person is
// always who logged the time (see buildTimesheetDayDetail).
export function TimesheetDayDetailView({ detail, showPeople }: { detail: TimesheetDayDetail; showPeople: boolean }) {
  if (detail.projects.length === 0) {
    return <p className="text-sm text-slate-400 dark:text-zinc-500 py-6 text-center">No hours logged for this day.</p>;
  }
  return (
    <div className="space-y-4">
      {detail.projects.map((project) => (
        <div key={project.projectSlug}>
          <h3 className="text-xs font-bold text-slate-700 dark:text-zinc-200 mb-1">
            {project.projectName}
            {project.isInternal && (
              <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-zinc-500 bg-slate-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded-full align-middle">
                Internal
              </span>
            )}
          </h3>
          {showPeople ? (
            <div className="space-y-3 pl-3 border-l-2 border-slate-100 dark:border-zinc-800">
              {project.people.map((person) => (
                <div key={person.personId ?? "unknown"}>
                  <h4 className="text-xs font-semibold text-slate-600 dark:text-zinc-300">{person.personName}</h4>
                  <TicketRows projectSlug={project.projectSlug} tickets={person.tickets} />
                  <div className="flex items-baseline justify-end gap-3 pt-1.5 text-xs font-semibold text-slate-500 dark:text-zinc-400">
                    <span>{person.personName} Total</span>
                    <span className="tabular-nums">{hoursFromMinutes(person.totalMinutes)}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <TicketRows projectSlug={project.projectSlug} tickets={project.tickets} />
          )}
          <div className="flex items-baseline justify-end gap-3 pt-1.5 text-xs font-bold text-slate-600 dark:text-zinc-300">
            <span>Project Total</span>
            <span className="tabular-nums">{hoursFromMinutes(project.totalMinutes)}</span>
          </div>
        </div>
      ))}
      <div className="flex items-baseline justify-end gap-3 pt-3 border-t border-slate-200 dark:border-zinc-700/70 text-sm font-bold text-slate-900 dark:text-zinc-50">
        <span>Day Total</span>
        <span className="tabular-nums">{hoursFromMinutes(detail.totalMinutes)}</span>
      </div>
    </div>
  );
}

// The day-detail section's body for a week/month view: a prompt with no
// day selected, a skeleton while loading, otherwise the detail.
export function TimesheetDayDetailBody({
  selectedDate,
  detail,
  showPeople,
}: {
  selectedDate: string | null;
  /** null while the visible period is still loading. */
  detail: TimesheetDayDetail | null;
  showPeople: boolean;
}) {
  if (!selectedDate) {
    return (
      <p className="text-sm text-slate-400 dark:text-zinc-500 py-6 text-center">Select a day to see its logged hours.</p>
    );
  }
  if (!detail) {
    return (
      <div className="space-y-2">
        <SkeletonBlock className="h-5 w-40" />
        <SkeletonBlock className="h-16 w-full" />
      </div>
    );
  }
  return <TimesheetDayDetailView detail={detail} showPeople={showPeople} />;
}

export function timesheetDayDetailTitle(selectedDate: string | null): string {
  return selectedDate ? formatLongDate(selectedDate) : "Day detail";
}
