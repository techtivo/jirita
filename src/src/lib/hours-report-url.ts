// The Hours Report's navigable state ↔ URL search params (JIR-120), so a
// browser refresh, a bookmark or a shared link reopens the same scope:
//
//   period=this-month | last-month | custom   (absent = a week view)
//   week=YYYY-MM-DD    a navigated week (absent = the current week)
//   month=YYYY-MM      a navigated month other than this/last month
//   day=YYYY-MM-DD     the selected day, when it isn't the view's default
//   from= / to=        Custom Range
//   projects=a,b       selected project slugs (absent = all; empty = none)
//   people=id1,id2     selected person ids (absent = all)
//
// "This week / this month / last month / today" are stored relatively (by
// omission or by name), so a link opened later still means the current one;
// anything navigated to explicitly is stored as its real date. Defaults
// produce no params at all.
//
// Everything read from a URL is untrusted: dates are validated here, and a
// project/person is only honored after the screen has checked it against
// what this viewer can actually see (resolveProjectSelectionFromUrl; People
// via the report's own reconcilePeopleSelection). A URL can narrow the
// report, never widen it.

import {
  addMonthsISO,
  initialTimesheetState,
  monthEndISO,
  monthStartISO,
  timesheetRange,
  weekStartISO,
} from "@/lib/hours-timesheet";
import type { TimesheetState, TimesheetView } from "@/lib/hours-timesheet";

export type QueryParams = Record<string, string>;
type ParamReader = (key: string) => string | null;

function isValidISODate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function defaultCustomRange(todayISO: string): { from: string; to: string } {
  const monthStart = monthStartISO(todayISO);
  return { from: monthStart, to: monthEndISO(monthStart) };
}

// The day a view selects on its own: today when it's in view; otherwise a
// navigated week selects its Monday and a navigated month nothing.
function defaultSelectedDate(view: TimesheetView, todayISO: string): string | null {
  if (view.kind === "custom") return null;
  const { from, to } = timesheetRange(view, { from: "", to: "" });
  if (todayISO >= from && todayISO <= to) return todayISO;
  return view.kind === "week" ? view.weekStart : null;
}

export interface TimesheetUrlState {
  state: TimesheetState;
  customRange: { from: string; to: string };
}

export function timesheetStateFromParams(get: ParamReader, todayISO: string): TimesheetUrlState {
  const currentMonth = monthStartISO(todayISO);
  const period = get("period");
  const monthParam = get("month");
  const weekParam = get("week");

  let view: TimesheetView = initialTimesheetState(todayISO).view;
  let customRange = defaultCustomRange(todayISO);

  if (period === "custom") {
    view = { kind: "custom" };
    const from = get("from");
    const to = get("to");
    // An empty From/To is a legitimate in-progress range; a malformed one
    // falls back to the default.
    if ((from === "" || isValidISODate(from)) && (to === "" || isValidISODate(to))) customRange = { from, to };
  } else if (period === "this-month") {
    view = { kind: "month", monthStart: currentMonth };
  } else if (period === "last-month") {
    view = { kind: "month", monthStart: addMonthsISO(currentMonth, -1) };
  } else if (monthParam && isValidISODate(`${monthParam}-01`)) {
    view = { kind: "month", monthStart: `${monthParam}-01` };
  } else if (isValidISODate(weekParam)) {
    view = { kind: "week", weekStart: weekStartISO(weekParam) };
  }

  let selectedDate = defaultSelectedDate(view, todayISO);
  const day = get("day");
  if (view.kind !== "custom" && isValidISODate(day)) {
    const { from, to } = timesheetRange(view, customRange);
    if (day >= from && day <= to) selectedDate = day;
  }

  return { state: { view, selectedDate }, customRange };
}

export function timesheetStateToParams(
  state: TimesheetState,
  customRange: { from: string; to: string },
  todayISO: string
): QueryParams {
  const { view, selectedDate } = state;
  const params: QueryParams = {};

  if (view.kind === "custom") {
    params.period = "custom";
    params.from = customRange.from;
    params.to = customRange.to;
    return params;
  }

  if (view.kind === "week") {
    if (view.weekStart !== weekStartISO(todayISO)) params.week = view.weekStart;
  } else {
    const currentMonth = monthStartISO(todayISO);
    if (view.monthStart === currentMonth) params.period = "this-month";
    else if (view.monthStart === addMonthsISO(currentMonth, -1)) params.period = "last-month";
    else params.month = view.monthStart.slice(0, 7);
  }

  if (selectedDate !== null && selectedDate !== defaultSelectedDate(view, todayISO)) params.day = selectedDate;
  return params;
}

// ── List params (projects / people) ──────────────────────────────────────────

/** null = the param is absent; [] = present but empty. */
export function parseListParam(value: string | null): string[] | null {
  if (value === null) return null;
  return Array.from(new Set(value.split(",").map((item) => item.trim()).filter(Boolean)));
}

// The administrative report's Projects selection is an explicit list of
// included slugs ("all" = every available one). A URL's list is only ever
// intersected with `availableSlugs` — the projects this viewer's own scope
// load returned — so an unknown, removed or unauthorized slug is silently
// dropped. If nothing valid is left, the default (all) applies; an
// explicitly empty list stays "no projects".
export function resolveProjectSelectionFromUrl(urlSlugs: string[] | null, availableSlugs: string[]): string[] {
  if (urlSlugs === null) return availableSlugs;
  if (urlSlugs.length === 0) return [];
  const requested = new Set(urlSlugs);
  const valid = availableSlugs.filter((slug) => requested.has(slug));
  return valid.length > 0 ? valid : availableSlugs;
}

/** undefined = every available project is selected (the default): no param. */
export function serializeProjectSelection(selectedSlugs: string[], availableSlugs: string[]): string | undefined {
  if (availableSlugs.length > 0 && selectedSlugs.length === availableSlugs.length) return undefined;
  if (availableSlugs.length === 0 && selectedSlugs.length === 0) return undefined;
  return selectedSlugs.join(",");
}

// Selections where empty means "all" (People; a Member's Projects).
export function serializeOptionalList(selected: string[]): string | undefined {
  return selected.length > 0 ? selected.join(",") : undefined;
}

export function buildHoursReportParams(
  timesheet: QueryParams,
  lists: { projects?: string; people?: string }
): QueryParams {
  const params: QueryParams = { ...timesheet };
  if (lists.projects !== undefined) params.projects = lists.projects;
  if (lists.people !== undefined) params.people = lists.people;
  return params;
}

// Stable, readable query string (commas kept literal).
export function toQueryString(params: QueryParams): string {
  return Object.keys(params)
    .map((key) => `${key}=${encodeURIComponent(params[key]).replace(/%2C/g, ",")}`)
    .join("&");
}
