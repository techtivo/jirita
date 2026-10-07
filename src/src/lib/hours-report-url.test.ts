import { describe, expect, it } from "vitest";
import {
  buildHoursReportParams,
  parseListParam,
  resolveProjectSelectionFromUrl,
  serializeOptionalList,
  serializeProjectSelection,
  timesheetStateFromParams,
  timesheetStateToParams,
  toQueryString,
} from "@/lib/hours-report-url";
import { initialTimesheetState, timesheetReducer } from "@/lib/hours-timesheet";
import type { TimesheetAction, TimesheetState } from "@/lib/hours-timesheet";

// JIR-120 — Hours Report state survives a browser refresh through the URL.

const TODAY = "2026-10-07"; // Wednesday
const DEFAULT_RANGE = { from: "2026-10-01", to: "2026-10-31" };

const reader = (query: string) => {
  const params = new URLSearchParams(query);
  return (key: string) => params.get(key);
};
const parse = (query: string, today = TODAY) => timesheetStateFromParams(reader(query), today);
const run = (...actions: TimesheetAction[]): TimesheetState =>
  actions.reduce((state, action) => timesheetReducer(state, action, TODAY), initialTimesheetState(TODAY));

// What a refresh does: state → URL → state.
function refresh(state: TimesheetState, customRange = DEFAULT_RANGE, today = TODAY) {
  const query = toQueryString(timesheetStateToParams(state, customRange, today));
  return { query, ...parse(query, today) };
}

describe("period / week / month / day", () => {
  it("a URL without params is the default: this week, today selected", () => {
    expect(parse("")).toEqual({ state: initialTimesheetState(TODAY), customRange: DEFAULT_RANGE });
    expect(timesheetStateToParams(initialTimesheetState(TODAY), DEFAULT_RANGE, TODAY)).toEqual({});
  });

  it("every navigable state round-trips through the URL", () => {
    const states: TimesheetState[] = [
      run(),
      run({ type: "select", date: "2026-10-05" }),
      run({ type: "shift", by: -1 }),
      run({ type: "shift", by: -1 }, { type: "select", date: "2026-10-02" }),
      run({ type: "shift", by: 1 }),
      run({ type: "preset", key: "this-month" }),
      run({ type: "preset", key: "this-month" }, { type: "select", date: "2026-10-20" }),
      run({ type: "preset", key: "last-month" }),
      run({ type: "preset", key: "last-month" }, { type: "select", date: "2026-09-15" }),
      run({ type: "preset", key: "last-month" }, { type: "shift", by: -1 }),
      run({ type: "preset", key: "last-month" }, { type: "shift", by: -1 }, { type: "select", date: "2026-08-31" }),
    ];
    for (const state of states) expect(refresh(state).state).toEqual(state);
  });

  it("writes readable params", () => {
    expect(refresh(run({ type: "shift", by: -1 })).query).toBe("week=2026-09-28&day=2026-09-30");
    expect(refresh(run({ type: "select", date: "2026-10-05" })).query).toBe("day=2026-10-05");
    expect(refresh(run({ type: "preset", key: "this-month" })).query).toBe("period=this-month");
    expect(refresh(run({ type: "preset", key: "last-month" })).query).toBe("period=last-month");
    expect(refresh(run({ type: "preset", key: "last-month" }, { type: "shift", by: -1 })).query).toBe("month=2026-08");
  });

  it("Custom Range keeps its dates", () => {
    const custom = run({ type: "preset", key: "custom" });
    const range = { from: "2026-09-10", to: "2026-09-20" };
    const result = refresh(custom, range);
    expect(result.query).toBe("period=custom&from=2026-09-10&to=2026-09-20");
    expect(result.state.view).toEqual({ kind: "custom" });
    expect(result.customRange).toEqual(range);
  });

  it("presets stay relative: the same link opened later means that day's week/month", () => {
    expect(parse("", "2026-11-18").state).toEqual(initialTimesheetState("2026-11-18"));
    expect(parse("period=this-month", "2026-11-18").state).toEqual({
      view: { kind: "month", monthStart: "2026-11-01" },
      selectedDate: "2026-11-18",
    });
    expect(parse("period=last-month", "2027-01-05").state.view).toEqual({ kind: "month", monthStart: "2026-12-01" });
    // An explicitly navigated week/month stays where it was.
    expect(parse("week=2026-09-28", "2026-11-18").state.view).toEqual({ kind: "week", weekStart: "2026-09-28" });
  });

  it("ignores invalid params safely", () => {
    const fallback = { state: initialTimesheetState(TODAY), customRange: DEFAULT_RANGE };
    for (const query of [
      "week=nope",
      "week=2026-13-40",
      "month=2026-99",
      "period=this-quarter",
      "day=2026-02-30",
      "day=<script>",
      "week=&month=&day=",
    ]) {
      expect(parse(query)).toEqual(fallback);
    }
    // A day outside the visible period is dropped, the view is kept.
    expect(parse("week=2026-09-28&day=2026-10-07").state).toEqual({
      view: { kind: "week", weekStart: "2026-09-28" },
      selectedDate: "2026-09-28",
    });
    expect(parse("period=last-month&day=2026-10-07").state.selectedDate).toBeNull();
    // Any day of a week resolves to that week's Monday.
    expect(parse("week=2026-10-01").state.view).toEqual({ kind: "week", weekStart: "2026-09-28" });
    // A malformed Custom Range falls back to the default dates.
    expect(parse("period=custom&from=bad&to=2026-09-20")).toEqual({
      state: { view: { kind: "custom" }, selectedDate: null },
      customRange: DEFAULT_RANGE,
    });
  });
});

describe("projects / people", () => {
  const available = ["collab", "lendingpoint", "tcfcu"];

  it("parses list params", () => {
    expect(parseListParam(null)).toBeNull();
    expect(parseListParam("")).toEqual([]);
    expect(parseListParam("a,b, a ,,c")).toEqual(["a", "b", "c"]);
  });

  it("no param means the default — every available project", () => {
    expect(resolveProjectSelectionFromUrl(null, available)).toEqual(available);
    expect(serializeProjectSelection(available, available)).toBeUndefined();
  });

  it("keeps a valid selection across a refresh", () => {
    const param = serializeProjectSelection(["lendingpoint"], available);
    expect(param).toBe("lendingpoint");
    expect(resolveProjectSelectionFromUrl(parseListParam(param!), available)).toEqual(["lendingpoint"]);
    const two = serializeProjectSelection(["tcfcu", "collab"], available)!;
    expect(resolveProjectSelectionFromUrl(parseListParam(two), available)).toEqual(["collab", "tcfcu"]);
  });

  it("drops projects the viewer can't access; with none left, falls back to the default", () => {
    // e.g. a Project Lead opening an Admin's link.
    expect(resolveProjectSelectionFromUrl(["lendingpoint", "secret-project"], available)).toEqual(["lendingpoint"]);
    expect(resolveProjectSelectionFromUrl(["secret-project", "deleted"], available)).toEqual(available);
    expect(resolveProjectSelectionFromUrl(["lendingpoint"], [])).toEqual([]);
  });

  it("an explicit empty selection stays empty", () => {
    expect(serializeProjectSelection([], available)).toBe("");
    expect(resolveProjectSelectionFromUrl(parseListParam(""), available)).toEqual([]);
  });

  it("People / a Member's Projects: empty means all, so no param", () => {
    expect(serializeOptionalList([])).toBeUndefined();
    expect(serializeOptionalList(["u1", "u2"])).toBe("u1,u2");
  });

  it("builds the full query: scope + period, nothing for defaults", () => {
    expect(toQueryString(buildHoursReportParams({}, {}))).toBe("");
    expect(
      toQueryString(
        buildHoursReportParams(timesheetStateToParams(run({ type: "preset", key: "this-month" }), DEFAULT_RANGE, TODAY), {
          projects: "lendingpoint",
          people: "u1,u2",
        })
      )
    ).toBe("period=this-month&projects=lendingpoint&people=u1,u2");
    // The main case: LendingPoint + All people + This Week.
    expect(toQueryString(buildHoursReportParams({}, { projects: "lendingpoint" }))).toBe("projects=lendingpoint");
  });
});
