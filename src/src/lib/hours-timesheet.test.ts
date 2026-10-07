import { describe, expect, it } from "vitest";
import {
  MEMBER_PERIOD_OPTIONS,
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
import type { OrganizationTimeEntry } from "@/lib/tickets";
import type { Ticket } from "@/lib/mock-tickets";

// JIR-119 — a Member's personal timesheet (Reports → Hours).

describe("experience by role", () => {
  it("only MEMBER gets the timesheet; Admin and Project Lead keep the administrative report", () => {
    expect(getHoursReportExperience("MEMBER")).toBe("member-timesheet");
    expect(getHoursReportExperience("PROJECT_LEAD")).toBe("administrative");
    expect(getHoursReportExperience("ADMIN")).toBe("administrative");
  });

  it("Member periods drop This Quarter and add This Week first; the administrative list is untouched", () => {
    expect(MEMBER_PERIOD_OPTIONS.map((o) => o.label)).toEqual(["This Week", "This Month", "Last Month", "Custom Range"]);
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
