// JIR-119 — pure logic for a Member's personal timesheet (Reports → Hours):
// which experience a role gets, the week/month calendar math, and the
// per-day totals. No Supabase calls and no React here; the screen
// (member-hours-report-screen.tsx) owns the single per-period fetch and this
// module only shapes its result.
//
// Dates are plain `yyyy-mm-dd` strings end to end — the same shape as
// `ticket_time_entries.work_date` (a Postgres `date`, no time, no zone) and
// as getTodayISO's real local date. All arithmetic goes through UTC
// midnight, so no local timezone or DST change can ever move an entry to
// the day before/after.

import type { Role } from "@/lib/current-user";
import type { Ticket } from "@/lib/mock-tickets";
import type { OrganizationTimeEntry } from "@/lib/tickets";

// ── Role → experience ────────────────────────────────────────────────────────
// The one decision point for which Hours Report a viewer gets. It reads the
// viewer's real role (useCurrentUser().user.role — the membership's own
// role), never the data: an Admin or Project Lead who only has their own
// hours still gets the administrative report.
export type HoursReportExperience = "member-timesheet" | "administrative";

export function getHoursReportExperience(role: Role): HoursReportExperience {
  return role === "MEMBER" ? "member-timesheet" : "administrative";
}

// ── Periods (Member only) ────────────────────────────────────────────────────
// Deliberately its own list rather than Reports' shared PERIOD_OPTIONS, which
// the administrative report keeps (including "This Quarter").
export type MemberPeriodKey = "this-week" | "this-month" | "last-month" | "custom";

export const MEMBER_PERIOD_OPTIONS: { key: MemberPeriodKey; label: string }[] = [
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

// The one filtered entry set every Member surface reads — the day totals,
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
