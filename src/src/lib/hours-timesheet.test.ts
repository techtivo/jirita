import { describe, expect, it } from "vitest";
import {
  TIMESHEET_PERIOD_OPTIONS,
  buildTimesheetDayDetail,
  initialTimesheetState,
  timesheetActivePeriod,
  timesheetRange,
  timesheetReducer,
  addDaysISO,
  addMonthsISO,
  filterTimesheetEntries,
  formatHoursLabel,
  formatLongDate,
  formatMonthLabel,
  formatWeekRangeLabel,
  getHoursReportExperience,
  monthEndISO,
  monthGridDays,
  monthStartISO,
  sumMinutesByDate,
  weekDaysISO,
  weekStartISO,
} from "@/lib/hours-timesheet";
import { buildHoursReportData } from "@/lib/hours-report";
import { PERIOD_OPTIONS } from "@/components/reports-screen";
import { filterTimeEntriesByPeople } from "@/lib/hours-report";
import type { OrganizationTimeEntry } from "@/lib/tickets";
import type { Ticket } from "@/lib/mock-tickets";

// JIR-119 — a Member's personal timesheet (Reports → Hours).

describe("experience by role", () => {
  it("only MEMBER gets the timesheet; Admin and Project Lead keep the administrative report", () => {
    expect(getHoursReportExperience("MEMBER")).toBe("member-timesheet");
    expect(getHoursReportExperience("PROJECT_LEAD")).toBe("administrative");
    expect(getHoursReportExperience("ADMIN")).toBe("administrative");
  });

  it("the Hours Report periods are This Week first and no This Quarter; Reports' own list is untouched", () => {
    expect(TIMESHEET_PERIOD_OPTIONS.map((o) => o.label)).toEqual(["This Week", "This Month", "Last Month", "Custom Range"]);
    expect(PERIOD_OPTIONS.map((o) => o.label)).toEqual(["This Month", "Last Month", "This Quarter", "Custom Range"]);
  });
});

describe("week math", () => {
  it("weeks run Monday–Sunday and always list seven days", () => {
    expect(weekStartISO("2026-10-07")).toBe("2026-10-05"); // Wednesday
    expect(weekStartISO("2026-10-05")).toBe("2026-10-05"); // Monday
    expect(weekStartISO("2026-10-11")).toBe("2026-10-05"); // Sunday
    expect(weekDaysISO("2026-10-05")).toEqual([
      "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11",
    ]);
  });

  it("crosses month and year boundaries", () => {
    expect(weekDaysISO(weekStartISO("2026-10-01"))).toEqual([
      "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04",
    ]);
    expect(weekStartISO("2027-01-01")).toBe("2026-12-28");
    expect(addDaysISO("2026-12-28", 7)).toBe("2027-01-04");
    expect(addDaysISO("2026-10-05", -7)).toBe("2026-09-28");
  });

  it("is stable across DST changes", () => {
    // US DST ends Nov 1, 2026 and starts Mar 14, 2027.
    expect(weekDaysISO("2026-10-26")[6]).toBe("2026-11-01");
    expect(addDaysISO("2026-11-01", 1)).toBe("2026-11-02");
    expect(addDaysISO("2027-03-14", 1)).toBe("2027-03-15");
  });

  it("labels the week range", () => {
    expect(formatWeekRangeLabel("2026-10-05", "2026-10-07")).toBe("5 Oct – 11 Oct");
    expect(formatWeekRangeLabel("2026-09-28", "2026-10-07")).toBe("28 Sep – 4 Oct");
    expect(formatWeekRangeLabel("2025-10-06", "2026-10-07")).toBe("6 Oct – 12 Oct 2025");
    expect(formatWeekRangeLabel("2026-12-28", "2026-12-30")).toBe("28 Dec 2026 – 3 Jan 2027");
  });
});

describe("month math", () => {
  it("handles month lengths, leap years and year changes", () => {
    expect(monthStartISO("2026-10-07")).toBe("2026-10-01");
    expect(monthEndISO("2026-10-01")).toBe("2026-10-31");
    expect(monthEndISO("2026-09-01")).toBe("2026-09-30");
    expect(monthEndISO("2026-02-01")).toBe("2026-02-28");
    expect(monthEndISO("2028-02-01")).toBe("2028-02-29");
    expect(addMonthsISO("2026-10-01", -1)).toBe("2026-09-01");
    expect(addMonthsISO("2027-01-01", -1)).toBe("2026-12-01");
    expect(addMonthsISO("2026-12-01", 1)).toBe("2027-01-01");
  });

  it("builds a whole-week grid with the adjacent months' days flagged", () => {
    const grid = monthGridDays("2026-10-01"); // Oct 1, 2026 is a Thursday
    expect(grid.length % 7).toBe(0);
    expect(grid[0]).toEqual({ date: "2026-09-28", inMonth: false });
    expect(grid[3]).toEqual({ date: "2026-10-01", inMonth: true });
    expect(grid[grid.length - 1]).toEqual({ date: "2026-11-01", inMonth: false });
    expect(grid.filter((d) => d.inMonth).map((d) => d.date)).toHaveLength(31);

    // A month that fits exactly four Monday–Sunday weeks.
    const feb = monthGridDays("2027-02-01");
    expect(feb).toHaveLength(28);
    expect(feb.every((d) => d.inMonth)).toBe(true);
  });

  it("labels months and days", () => {
    expect(formatMonthLabel("2026-10-01")).toBe("October 2026");
    expect(formatLongDate("2026-10-07")).toBe("Wednesday, October 7, 2026");
    expect(formatLongDate("2027-01-01")).toBe("Friday, January 1, 2027");
  });
});

describe("hours", () => {
  it("keeps decimal precision", () => {
    expect(formatHoursLabel(0)).toBe("0h");
    expect(formatHoursLabel(480)).toBe("8h");
    expect(formatHoursLabel(390)).toBe("6.5h");
    expect(formatHoursLabel(15)).toBe("0.25h");
    expect(formatHoursLabel(405)).toBe("6.75h");
  });

  const tickets = [
    { id: "t1", ticketNumber: 14, projectSlug: "lp", title: "Resumptive Flow Errors" },
    { id: "t2", ticketNumber: 15, projectSlug: "lp", title: "SSN Stored" },
    { id: "t3", ticketNumber: 3, projectSlug: "beta", title: "Beta work" },
    { id: "t4", ticketNumber: 9, projectSlug: "gone", title: "Project no longer listed" },
  ] as unknown as Ticket[];
  const projects = [
    { slug: "lp", name: "LendingPoint", category: "client" as const },
    { slug: "beta", name: "Beta", category: "internal" as const },
  ];
  const slugs = projects.map((p) => p.slug);

  function entry(ticketId: string, minutes: number, workDate: string): OrganizationTimeEntry {
    return { ticketId, loggedBy: "me", minutes, workDate, comment: null };
  }

  // Yesterday (Oct 6): 6h logged. Today (Oct 7): 2.5h across two projects.
  const entries = [
    entry("t1", 240, "2026-10-06"),
    entry("t2", 120, "2026-10-06"),
    entry("t1", 60, "2026-10-07"),
    entry("t2", 30, "2026-10-07"),
    entry("t3", 60, "2026-10-07"),
    entry("t4", 45, "2026-10-07"), // ticket of a project the report can't attribute
    entry("unknown", 45, "2026-10-07"), // ticket not in scope at all
  ];

  it("totals each day from real entries only, leaving empty days absent (0h)", () => {
    const byDate = sumMinutesByDate(filterTimesheetEntries(entries, tickets, slugs, []));
    expect(byDate.get("2026-10-06")).toBe(360);
    expect(byDate.get("2026-10-07")).toBe(150);
    expect(byDate.get("2026-10-05")).toBeUndefined();
    expect(formatHoursLabel(byDate.get("2026-10-06") ?? 0)).toBe("6h");
    expect(formatHoursLabel(byDate.get("2026-10-05") ?? 0)).toBe("0h");
  });

  it("the Projects filter narrows the day totals", () => {
    const byDate = sumMinutesByDate(filterTimesheetEntries(entries, tickets, slugs, ["lp"]));
    expect(byDate.get("2026-10-07")).toBe(90);
    expect(byDate.get("2026-10-06")).toBe(360);
  });

  it("calendar totals, the day detail and the period export always agree", () => {
    for (const selected of [[], ["lp"], ["beta"], ["lp", "beta"]]) {
      const filtered = filterTimesheetEntries(entries, tickets, slugs, selected);
      const byDate = sumMinutesByDate(filtered);
      const build = (subset: OrganizationTimeEntry[]) =>
        buildHoursReportData(tickets, projects, [{ id: "me", name: "Me" }], subset, false);

      let daySum = 0;
      for (const [date, minutes] of byDate) {
        const day = build(filtered.filter((e) => e.workDate === date));
        expect(day.grandTotalHours).toBeCloseTo(minutes / 60, 10);
        daySum += minutes;
      }
      // The export is the whole period, not the selected day.
      const period = build(filtered);
      expect(period.grandTotalHours).toBeCloseTo(daySum / 60, 10);
      expect(period.detailRows).toHaveLength(filtered.length);
      expect(period.includesFinancials).toBe(false);
    }
  });

  it("builds the day detail grouped by project with real ticket hours", () => {
    const filtered = filterTimesheetEntries(entries, tickets, slugs, []);
    const day = buildHoursReportData(
      tickets,
      projects,
      [{ id: "me", name: "Me" }],
      filtered.filter((e) => e.workDate === "2026-10-07"),
      false
    );
    expect(day.projectGroups.map((g) => [g.projectName, g.totalHours])).toEqual([
      ["Beta", 1],
      ["LendingPoint", 1.5],
    ]);
    expect(day.projectGroups[1].tickets.map((t) => t.hours)).toEqual([1, 0.5]);
    expect(day.grandTotalHours).toBe(2.5);
  });
});

// ── Navigation (shared by every role) ────────────────────────────────────────
describe("timesheet navigation", () => {
  const today = "2026-10-07"; // Wednesday
  const run = (...actions: Parameters<typeof timesheetReducer>[1][]) =>
    actions.reduce((state, action) => timesheetReducer(state, action, today), initialTimesheetState(today));

  it("opens on the current week with today selected", () => {
    const state = initialTimesheetState(today);
    expect(state).toEqual({ view: { kind: "week", weekStart: "2026-10-05" }, selectedDate: today });
    expect(timesheetActivePeriod(state.view, today)).toBe("this-week");
    expect(timesheetRange(state.view, { from: "", to: "" })).toEqual({ from: "2026-10-05", to: "2026-10-11" });
  });

  it("previous/next week moves the range and keeps the same weekday selected", () => {
    const prev = run({ type: "shift", by: -1 });
    expect(prev).toEqual({ view: { kind: "week", weekStart: "2026-09-28" }, selectedDate: "2026-09-30" });
    expect(timesheetActivePeriod(prev.view, today)).toBeNull();
    expect(run({ type: "shift", by: -1 }, { type: "shift", by: 1 })).toEqual(initialTimesheetState(today));
    expect(run({ type: "shift", by: 1 }).view).toEqual({ kind: "week", weekStart: "2026-10-12" });
  });

  it("Today returns to the current week and selects today", () => {
    const state = run({ type: "shift", by: -1 }, { type: "shift", by: -1 }, { type: "select", date: "2026-09-21" }, { type: "today" });
    expect(state).toEqual(initialTimesheetState(today));
  });

  it("selecting a day only changes the selection", () => {
    expect(run({ type: "select", date: "2026-10-06" })).toEqual({
      view: { kind: "week", weekStart: "2026-10-05" },
      selectedDate: "2026-10-06",
    });
  });

  it("This Month opens the current month on today; Last Month opens the previous month with no day selected", () => {
    const thisMonth = run({ type: "preset", key: "this-month" });
    expect(thisMonth).toEqual({ view: { kind: "month", monthStart: "2026-10-01" }, selectedDate: today });
    expect(timesheetRange(thisMonth.view, { from: "", to: "" })).toEqual({ from: "2026-10-01", to: "2026-10-31" });

    const lastMonth = run({ type: "preset", key: "last-month" });
    expect(lastMonth).toEqual({ view: { kind: "month", monthStart: "2026-09-01" }, selectedDate: null });
    expect(timesheetActivePeriod(lastMonth.view, today)).toBe("last-month");
    expect(timesheetRange(lastMonth.view, { from: "", to: "" })).toEqual({ from: "2026-09-01", to: "2026-09-30" });
  });

  it("previous/next month follows the visible month; the pills only match what is visible", () => {
    const august = run({ type: "preset", key: "last-month" }, { type: "shift", by: -1 });
    expect(august).toEqual({ view: { kind: "month", monthStart: "2026-08-01" }, selectedDate: null });
    expect(timesheetActivePeriod(august.view, today)).toBeNull();

    const back = run({ type: "preset", key: "last-month" }, { type: "shift", by: 1 });
    expect(back).toEqual({ view: { kind: "month", monthStart: "2026-10-01" }, selectedDate: today });
    expect(timesheetActivePeriod(back.view, today)).toBe("this-month");

    // Year boundary.
    const jan = timesheetReducer({ view: { kind: "month", monthStart: "2026-12-01" }, selectedDate: null }, { type: "shift", by: 1 }, today);
    expect(jan.view).toEqual({ kind: "month", monthStart: "2027-01-01" });
  });

  it("Today in a month view returns to the current month and selects today", () => {
    expect(run({ type: "preset", key: "last-month" }, { type: "shift", by: -1 }, { type: "today" })).toEqual({
      view: { kind: "month", monthStart: "2026-10-01" },
      selectedDate: today,
    });
  });

  it("Custom Range uses the range the user picked", () => {
    const custom = run({ type: "preset", key: "custom" });
    expect(custom.view).toEqual({ kind: "custom" });
    expect(timesheetActivePeriod(custom.view, today)).toBe("custom");
    expect(timesheetRange(custom.view, { from: "2026-09-10", to: "2026-09-20" })).toEqual({ from: "2026-09-10", to: "2026-09-20" });
  });
});

// ── Admin / Project Lead scope (JIR-120): Projects + People ──────────────────
describe("administrative timesheet — Projects + People scope", () => {
  const ALEX = "alex";
  const JUAN = "juan";
  const members = [
    { id: ALEX, name: "Alex Sosa" },
    { id: JUAN, name: "Juan David Olarte" },
  ];
  const projects = [
    { slug: "lp", name: "LendingPoint", category: "client" as const },
    { slug: "collab", name: "Collab", category: "internal" as const },
    { slug: "other", name: "Other Lead's Project", category: "client" as const },
  ];
  // LP-14 is assigned to Alex only; both Alex and Juan log time on it.
  const tickets = [
    { id: "lp14", ticketNumber: 14, projectSlug: "lp", title: "Resumptive Flow Errors", assigneeProfileId: ALEX },
    { id: "lp20", ticketNumber: 20, projectSlug: "lp", title: "Another ticket", assigneeProfileId: ALEX },
    { id: "c1", ticketNumber: 1, projectSlug: "collab", title: "Collab work", assigneeProfileId: JUAN },
    { id: "o1", ticketNumber: 1, projectSlug: "other", title: "Out of a lead's scope", assigneeProfileId: JUAN },
  ] as unknown as Ticket[];
  const slugs = projects.map((p) => p.slug);

  const e = (ticketId: string, loggedBy: string, minutes: number, workDate: string): OrganizationTimeEntry => ({
    ticketId, loggedBy, minutes, workDate, comment: null,
  });
  const FRI = "2026-10-02";
  const MON = "2026-10-05";
  const all = [
    e("lp14", ALEX, 120, FRI),
    e("lp14", JUAN, 60, FRI),
    e("lp20", JUAN, 120, FRI),
    e("lp20", ALEX, 60, FRI),
    e("c1", ALEX, 90, FRI),
    e("c1", JUAN, 45, MON),
    e("o1", JUAN, 300, FRI),
  ];

  // What the screen does: `scopeTickets` are the tickets the fetch covered
  // (the viewer's authorized projects ∩ the Projects selection), People
  // narrows by the entry's author.
  function scope(scopeTickets: Ticket[], people: string[]) {
    const entries = filterTimesheetEntries(filterTimeEntriesByPeople(all, people), scopeTickets, slugs, []);
    const byDate = sumMinutesByDate(entries);
    const total = entries.reduce((sum, entry) => sum + entry.minutes, 0);
    const day = (date: string) =>
      buildTimesheetDayDetail(entries.filter((x) => x.workDate === date), scopeTickets, projects, members);
    return { entries, byDate, total, day };
  }
  const inProject = (...projectSlugs: string[]) => tickets.filter((t) => projectSlugs.includes(t.projectSlug));

  it("Admin, All projects + All people: every accessible hour", () => {
    const s = scope(tickets, []);
    expect(s.total).toBe(795);
    expect(s.byDate.get(FRI)).toBe(750);
    expect(s.byDate.get(MON)).toBe(45);
  });

  it("Project Lead: hours outside the tickets in their scope never appear", () => {
    const s = scope(inProject("lp", "collab"), []);
    expect(s.total).toBe(495);
    expect(s.byDate.get(FRI)).toBe(450);
    expect(s.day(FRI).projects.map((p) => p.projectSlug)).toEqual(["collab", "lp"]);
    // …even when filtering by the person who logged them.
    expect(scope(inProject("lp", "collab"), [JUAN]).total).toBe(225);
  });

  it("one project + All people: everyone's hours in that project", () => {
    const s = scope(inProject("lp"), []);
    expect(s.byDate.get(FRI)).toBe(360);
    expect(s.total).toBe(360);
  });

  it("All projects + one person: that person's hours across projects", () => {
    const s = scope(tickets, [ALEX]);
    expect(s.total).toBe(270);
    expect(s.day(FRI).projects.map((p) => [p.projectName, p.totalMinutes])).toEqual([["Collab", 90], ["LendingPoint", 180]]);
  });

  it("one project + one person: only that person's hours in that project", () => {
    const s = scope(inProject("lp"), [JUAN]);
    expect(s.total).toBe(180);
    expect(s.byDate.get(FRI)).toBe(180);
    expect(s.byDate.get(MON)).toBeUndefined();
  });

  it("day detail is Project → Person → Ticket, by who logged the time — not the assignee", () => {
    const detail = scope(inProject("lp"), []).day(FRI);
    expect(detail.projects).toHaveLength(1);
    const lp = detail.projects[0];
    expect(lp.people.map((p) => [p.personName, p.totalMinutes, p.tickets.map((t) => [t.summary, t.minutes])])).toEqual([
      ["Alex Sosa", 180, [["Resumptive Flow Errors", 120], ["Another ticket", 60]]],
      // Juan logged on LP-14 and LP-20, both assigned to Alex.
      ["Juan David Olarte", 180, [["Resumptive Flow Errors", 60], ["Another ticket", 120]]],
    ]);
    expect(lp.totalMinutes).toBe(360);
    // The single-person layout merges the same ticket across people.
    expect(lp.tickets.map((t) => [t.summary, t.minutes])).toEqual([["Resumptive Flow Errors", 180], ["Another ticket", 180]]);
  });

  it("a ticket assigned to someone who logged nothing shows only the people who did", () => {
    const detail = scope(inProject("collab"), []).day(FRI); // c1 is assigned to Juan; Alex logged
    expect(detail.projects[0].people.map((p) => p.personName)).toEqual(["Alex Sosa"]);
  });

  it("an entry with no recorded author is kept under Unknown Member", () => {
    const detail = buildTimesheetDayDetail(
      [{ ticketId: "lp14", loggedBy: null, minutes: 30, workDate: FRI, comment: null }],
      tickets,
      projects,
      members
    );
    expect(detail.projects[0].people).toEqual([
      { personId: null, personName: "Unknown Member", totalMinutes: 30, tickets: [{ ticketKey: expect.any(String), summary: "Resumptive Flow Errors", minutes: 30 }] },
    ]);
  });

  it("for any Projects + People scope: day pills = period total = entries, and each day's levels add up", () => {
    const scopes: [Ticket[], string[]][] = [
      [tickets, []],
      [inProject("lp", "collab"), []],
      [inProject("lp"), []],
      [tickets, [ALEX]],
      [inProject("lp"), [JUAN]],
      [inProject("collab"), [ALEX, JUAN]],
    ];
    for (const [scopeTickets, people] of scopes) {
      const s = scope(scopeTickets, people);
      expect(Array.from(s.byDate.values()).reduce((a, b) => a + b, 0)).toBe(s.total);
      // The period export is built from the same entries.
      const period = buildHoursReportData(scopeTickets, projects, members, filterTimeEntriesByPeople(all, people), false);
      expect(period.grandTotalHours * 60).toBeCloseTo(s.total, 6);

      for (const [date, minutes] of s.byDate) {
        const detail = s.day(date);
        expect(detail.totalMinutes).toBe(minutes);
        expect(detail.projects.reduce((sum, p) => sum + p.totalMinutes, 0)).toBe(minutes);
        for (const project of detail.projects) {
          expect(project.people.reduce((sum, p) => sum + p.totalMinutes, 0)).toBe(project.totalMinutes);
          expect(project.tickets.reduce((sum, t) => sum + t.minutes, 0)).toBe(project.totalMinutes);
          for (const person of project.people) {
            expect(person.tickets.reduce((sum, t) => sum + t.minutes, 0)).toBe(person.totalMinutes);
          }
        }
      }
    }
  });
});
