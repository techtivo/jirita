// Pure logic for the Hours Report's visual timesheet (Reports → Hours):
// which screen a role gets, the week/month calendar math and navigation,
// the per-day totals and the day detail. JIR-119 built it for a Member's
// personal report; JIR-120 extended the same views to Admin/Project Lead,
// scoped by their Projects + People filters. No Supabase calls and no React
// here; each screen owns its single per-period fetch and this module only
// shapes the result.
//
// Dates are plain `yyyy-mm-dd` strings end to end — the same shape as
// `ticket_time_entries.work_date` (a Postgres `date`, no time, no zone) and
// as getTodayISO's real local date. All arithmetic goes through UTC
// midnight, so no local timezone or DST change can ever move an entry to
// the day before/after.

import type { Role } from "@/lib/current-user";
import { getTicketDisplayKey } from "@/lib/mock-tickets";
import type { Ticket } from "@/lib/mock-tickets";
import type { OrganizationTimeEntry } from "@/lib/tickets";

// ── Role → experience ────────────────────────────────────────────────────────
// The one decision point for which Hours Report screen a viewer gets. It
// reads the viewer's real role (useCurrentUser().user.role — the
// membership's own role), never the data: an Admin or Project Lead who only
// has their own hours still gets the administrative report (Projects +
// People filters, PDF, `$` when authorized). Both screens share the same
// week/month views; only a Member's is a personal, own-hours-only report.
export type HoursReportExperience = "member-timesheet" | "administrative";

export function getHoursReportExperience(role: Role): HoursReportExperience {
  return role === "MEMBER" ? "member-timesheet" : "administrative";
}

// ── Periods ──────────────────────────────────────────────────────────────────
// The Hours Report's own list, for every role — deliberately not Reports'
// shared PERIOD_OPTIONS (This Month/Last Month/This Quarter/Custom Range),
// which the Reports page itself keeps.
export type TimesheetPeriodKey = "this-week" | "this-month" | "last-month" | "custom";

export const TIMESHEET_PERIOD_OPTIONS: { key: TimesheetPeriodKey; label: string }[] = [
  { key: "this-week", label: "This Week" },
  { key: "this-month", label: "This Month" },
  { key: "last-month", label: "Last Month" },
  { key: "custom", label: "Custom Range" },
];

// ── Date math ────────────────────────────────────────────────────────────────

function toUTCDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUTCDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDaysISO(iso: string, days: number): string {
  const date = toUTCDate(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return fromUTCDate(date);
}

// Weeks run Monday–Sunday, same as Time Tracking and Reports' own "This
// Week" preset.
export function weekStartISO(iso: string): string {
  const day = toUTCDate(iso).getUTCDay();
  return addDaysISO(iso, day === 0 ? -6 : 1 - day);
}

export function weekDaysISO(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDaysISO(weekStart, i));
}

export function monthStartISO(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

export function addMonthsISO(monthStart: string, months: number): string {
  const date = toUTCDate(monthStart);
  date.setUTCMonth(date.getUTCMonth() + months, 1);
  return fromUTCDate(date);
}

export function monthEndISO(monthStart: string): string {
  return addDaysISO(addMonthsISO(monthStart, 1), -1);
}

export interface MonthGridDay {
  date: string;
  /** False for the leading/trailing days that only complete the first and
   *  last week rows — they belong to the adjacent months. */
  inMonth: boolean;
}

// Every day of the Monday–Sunday weeks the month touches, so the grid is
// always whole rows of seven.
export function monthGridDays(monthStart: string): MonthGridDay[] {
  const first = weekStartISO(monthStart);
  const last = addDaysISO(weekStartISO(monthEndISO(monthStart)), 6);
  const month = monthStart.slice(0, 7);
  const days: MonthGridDay[] = [];
  for (let date = first; date <= last; date = addDaysISO(date, 1)) {
    days.push({ date, inMonth: date.slice(0, 7) === month });
  }
  return days;
}

// ── View state & navigation ──────────────────────────────────────────────────
// What's on screen: a week, a month, or the Custom Range summary. The
// period pills are only presets into this — after manual navigation the
// visible week/month is the single source of truth for the totals, the
// detail and the exports.
export type TimesheetView =
  | { kind: "week"; weekStart: string }
  | { kind: "month"; monthStart: string }
  | { kind: "custom" };

export interface TimesheetState {
  view: TimesheetView;
  /** The day whose detail is shown; null when none is selected. */
  selectedDate: string | null;
}

export type TimesheetAction =
  | { type: "preset"; key: TimesheetPeriodKey }
  | { type: "shift"; by: 1 | -1 }
  | { type: "today" }
  | { type: "select"; date: string };

// Opens on the current week with today selected.
export function initialTimesheetState(todayISO: string): TimesheetState {
  return { view: { kind: "week", weekStart: weekStartISO(todayISO) }, selectedDate: todayISO };
}

// Only the current month has a "today" to land on; any other month opens
// with no day selected rather than a same-numbered guess.
function monthState(monthStart: string, todayISO: string): TimesheetState {
  return {
    view: { kind: "month", monthStart },
    selectedDate: monthStart === monthStartISO(todayISO) ? todayISO : null,
  };
}

export function timesheetReducer(state: TimesheetState, action: TimesheetAction, todayISO: string): TimesheetState {
  const { view, selectedDate } = state;
  switch (action.type) {
    case "preset":
      if (action.key === "this-week") return initialTimesheetState(todayISO);
      if (action.key === "this-month") return monthState(monthStartISO(todayISO), todayISO);
      if (action.key === "last-month") return monthState(addMonthsISO(monthStartISO(todayISO), -1), todayISO);
      return { view: { kind: "custom" }, selectedDate };
    case "today":
      if (view.kind === "week") return initialTimesheetState(todayISO);
      if (view.kind === "month") return monthState(monthStartISO(todayISO), todayISO);
      return state;
    case "shift": {
      if (view.kind === "month") return monthState(addMonthsISO(view.monthStart, action.by), todayISO);
      if (view.kind !== "week") return state;
      // Moving a week keeps the same weekday selected, so the detail follows.
      const weekStart = addDaysISO(view.weekStart, action.by * 7);
      const inWeek =
        selectedDate !== null && selectedDate >= view.weekStart && selectedDate <= addDaysISO(view.weekStart, 6);
      return {
        view: { kind: "week", weekStart },
        selectedDate: inWeek ? addDaysISO(selectedDate, action.by * 7) : weekStart,
      };
    }
    case "select":
      return { view, selectedDate: action.date };
  }
}

// Which pill reads as active follows what's actually visible, so a pill
// never claims "This Month" over a month navigated away from.
export function timesheetActivePeriod(view: TimesheetView, todayISO: string): TimesheetPeriodKey | null {
  if (view.kind === "custom") return "custom";
  if (view.kind === "week") return view.weekStart === weekStartISO(todayISO) ? "this-week" : null;
  const currentMonth = monthStartISO(todayISO);
  if (view.monthStart === currentMonth) return "this-month";
  return view.monthStart === addMonthsISO(currentMonth, -1) ? "last-month" : null;
}

// The visible period — the one range the fetch, the totals and the exports
// all use.
export function timesheetRange(
  view: TimesheetView,
  customRange: { from: string; to: string }
): { from: string; to: string } {
  if (view.kind === "week") return { from: view.weekStart, to: addDaysISO(view.weekStart, 6) };
  if (view.kind === "month") return { from: view.monthStart, to: monthEndISO(view.monthStart) };
  return customRange;
}

// ── Labels ───────────────────────────────────────────────────────────────────

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const LONG_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Monday-first, matching weekDaysISO/monthGridDays column order. */
export const WEEKDAY_SHORT_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function dayOfMonth(iso: string): number {
  return Number(iso.slice(8, 10));
}

// "5 Oct – 11 Oct"; the year is added only when the week isn't in
// `todayISO`'s year (or straddles two years).
export function formatWeekRangeLabel(weekStart: string, todayISO: string): string {
  const weekEnd = addDaysISO(weekStart, 6);
  const short = (iso: string) => `${dayOfMonth(iso)} ${SHORT_MONTHS[Number(iso.slice(5, 7)) - 1]}`;
  const startYear = weekStart.slice(0, 4);
  const endYear = weekEnd.slice(0, 4);
  if (startYear !== endYear) return `${short(weekStart)} ${startYear} – ${short(weekEnd)} ${endYear}`;
  const label = `${short(weekStart)} – ${short(weekEnd)}`;
  return startYear === todayISO.slice(0, 4) ? label : `${label} ${endYear}`;
}

export function formatMonthLabel(monthStart: string): string {
  return `${LONG_MONTHS[Number(monthStart.slice(5, 7)) - 1]} ${monthStart.slice(0, 4)}`;
}

/** "Wednesday, October 7, 2026" */
export function formatLongDate(iso: string): string {
  const weekday = LONG_WEEKDAYS[toUTCDate(iso).getUTCDay()];
  return `${weekday}, ${LONG_MONTHS[Number(iso.slice(5, 7)) - 1]} ${dayOfMonth(iso)}, ${iso.slice(0, 4)}`;
}

// Logged time is stored in whole minutes; hours are only derived for
// display, at the same 2-decimal precision the Hours Report already shows
// (15-minute entries are exact at 2 decimals).
export function formatHoursLabel(minutes: number): string {
  return `${Math.round((minutes / 60) * 100) / 100}h`;
}

// ── Entries ──────────────────────────────────────────────────────────────────

// The one filtered entry set every timesheet surface reads — the day totals,
// the day detail, the Custom Range summary and the Excel export — so they
// can never disagree: only entries on a ticket of a known project, and of a
// selected project when the Projects filter is narrowed (an empty selection
// is "All projects"). This mirrors what buildHoursReportData itself keeps.
export function filterTimesheetEntries(
  entries: OrganizationTimeEntry[],
  tickets: Pick<Ticket, "id" | "projectSlug">[],
  knownProjectSlugs: string[],
  selectedProjectSlugs: string[]
): OrganizationTimeEntry[] {
  const known = new Set(knownProjectSlugs);
  const selected = selectedProjectSlugs.length > 0 ? new Set(selectedProjectSlugs) : null;
  const slugByTicketId = new Map(tickets.map((t) => [t.id, t.projectSlug]));
  return entries.filter((entry) => {
    const slug = slugByTicketId.get(entry.ticketId);
    return slug !== undefined && known.has(slug) && (!selected || selected.has(slug));
  });
}

export function sumMinutesByDate(entries: OrganizationTimeEntry[]): Map<string, number> {
  const minutesByDate = new Map<string, number>();
  for (const entry of entries) {
    minutesByDate.set(entry.workDate, (minutesByDate.get(entry.workDate) ?? 0) + entry.minutes);
  }
  return minutesByDate;
}

// ── Day detail ───────────────────────────────────────────────────────────────
// One day's entries as Project → Person → Ticket. The person is always the
// time entry's own author (`loggedBy`) — never the ticket's assignee, which
// can be someone else, can have changed, and is only ever one person while
// several people log time on the same ticket. Each project also carries its
// tickets merged across people, for a view that shows a single person.
// Everything stays in whole minutes, so every level's total is the exact
// sum of the one below it.
export interface TimesheetDayTicket {
  ticketKey: string;
  summary: string;
  minutes: number;
}

export interface TimesheetDayPerson {
  /** null for an entry with no recorded author. */
  personId: string | null;
  personName: string;
  totalMinutes: number;
  tickets: TimesheetDayTicket[];
}

export interface TimesheetDayProject {
  projectSlug: string;
  projectName: string;
  isInternal: boolean;
  totalMinutes: number;
  people: TimesheetDayPerson[];
  tickets: TimesheetDayTicket[];
}

export interface TimesheetDayDetail {
  projects: TimesheetDayProject[];
  totalMinutes: number;
}

type DetailTicket = Pick<Ticket, "id" | "projectSlug" | "ticketNumber" | "title">;

function ticketRows(minutesByTicket: Map<DetailTicket, number>): TimesheetDayTicket[] {
  return Array.from(minutesByTicket)
    .sort(([a], [b]) => a.ticketNumber - b.ticketNumber)
    .map(([ticket, minutes]) => ({ ticketKey: getTicketDisplayKey(ticket), summary: ticket.title, minutes }));
}

// `entries` are the day's entries, already scoped by the caller
// (filterTimesheetEntries + the selected date). An entry whose ticket or
// project isn't known is left out, exactly as the day totals leave it out.
export function buildTimesheetDayDetail(
  entries: OrganizationTimeEntry[],
  tickets: DetailTicket[],
  projects: { slug: string; name: string; category?: string }[],
  members: { id: string; name: string }[]
): TimesheetDayDetail {
  const ticketById = new Map(tickets.map((t) => [t.id, t]));
  const projectBySlug = new Map(projects.map((p) => [p.slug, p]));
  const nameById = new Map(members.map((m) => [m.id, m.name]));

  const byProject = new Map<string, Map<string | null, Map<DetailTicket, number>>>();
  for (const entry of entries) {
    const ticket = ticketById.get(entry.ticketId);
    if (!ticket || !projectBySlug.has(ticket.projectSlug)) continue;
    let byPerson = byProject.get(ticket.projectSlug);
    if (!byPerson) byProject.set(ticket.projectSlug, (byPerson = new Map()));
    let byTicket = byPerson.get(entry.loggedBy);
    if (!byTicket) byPerson.set(entry.loggedBy, (byTicket = new Map()));
    byTicket.set(ticket, (byTicket.get(ticket) ?? 0) + entry.minutes);
  }

  const result: TimesheetDayProject[] = [];
  for (const [slug, byPerson] of byProject) {
    const project = projectBySlug.get(slug)!;
    const merged = new Map<DetailTicket, number>();
    const people: TimesheetDayPerson[] = [];
    for (const [personId, byTicket] of byPerson) {
      let totalMinutes = 0;
      for (const [ticket, minutes] of byTicket) {
        totalMinutes += minutes;
        merged.set(ticket, (merged.get(ticket) ?? 0) + minutes);
      }
      people.push({
        personId,
        personName: (personId && nameById.get(personId)) || "Unknown Member",
        totalMinutes,
        tickets: ticketRows(byTicket),
      });
    }
    people.sort((a, b) => a.personName.localeCompare(b.personName));
    result.push({
      projectSlug: slug,
      projectName: project.name,
      isInternal: project.category !== "client",
      totalMinutes: people.reduce((sum, person) => sum + person.totalMinutes, 0),
      people,
      tickets: ticketRows(merged),
    });
  }
  result.sort((a, b) => a.projectName.localeCompare(b.projectName));

  return { projects: result, totalMinutes: result.reduce((sum, project) => sum + project.totalMinutes, 0) };
}
