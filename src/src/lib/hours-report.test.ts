import { describe, expect, it } from "vitest";
import {
  buildHoursReportData,
  buildHoursReportWorkbookSheets,
  buildHoursReportPeopleOptions,
  filterTimeEntriesByPeople,
  reconcilePeopleSelection,
} from "@/lib/hours-report";
import type { OrganizationTimeEntry } from "@/lib/tickets";
import type { Ticket } from "@/lib/mock-tickets";

const members = [
  { id: "ana", name: "Ana Pérez" },
  { id: "bob", name: "Bob Smith" },
  { id: "cy", name: "Cy Member" }, // project member who never logs time
];

const projects = [
  { slug: "alpha", name: "Alpha", category: "client" as const, defaultHourlyRate: 100 },
  { slug: "beta", name: "Beta", category: "client" as const, defaultHourlyRate: 50 },
];

const tickets = [
  { id: "t1", ticketNumber: 1, projectSlug: "alpha", title: "One", key: "ALP-1" },
  { id: "t2", ticketNumber: 2, projectSlug: "beta", title: "Two", key: "BET-2" },
] as unknown as Ticket[];

function entry(ticketId: string, loggedBy: string | null, minutes: number): OrganizationTimeEntry {
  return { ticketId, loggedBy, minutes, workDate: "2026-09-10", comment: null };
}

// What the screen's range query would return for the selected projects + dates.
const entries = [
  entry("t1", "ana", 60),
  entry("t1", "bob", 30),
  entry("t2", "bob", 90),
  entry("t2", "ana", 0), // zero-minute entry — not participation
  entry("t2", null, 15), // logger no longer resolvable
];

describe("buildHoursReportPeopleOptions", () => {
  it("lists only people with > 0 logged minutes in the given entries, sorted by name", () => {
    expect(buildHoursReportPeopleOptions(entries, members)).toEqual([
      { id: "ana", name: "Ana Pérez" },
      { id: "bob", name: "Bob Smith" },
    ]);
  });

  it("never lists a member without logged time (membership is not participation)", () => {
    const ids = buildHoursReportPeopleOptions(entries, members).map((p) => p.id);
    expect(ids).not.toContain("cy");
  });

  it("only reflects the entries passed in — e.g. a single project's entries", () => {
    const betaOnly = entries.filter((e) => e.ticketId === "t2");
    expect(buildHoursReportPeopleOptions(betaOnly, members)).toEqual([{ id: "bob", name: "Bob Smith" }]);
  });

  it("is empty when nobody logged time in range", () => {
    expect(buildHoursReportPeopleOptions([], members)).toEqual([]);
  });
});

describe("filterTimeEntriesByPeople", () => {
  it("returns every entry unchanged for All people (empty selection)", () => {
    expect(filterTimeEntriesByPeople(entries, [])).toBe(entries);
  });

  it("keeps only the selected people's entries", () => {
    expect(filterTimeEntriesByPeople(entries, ["bob"]).map((e) => e.minutes)).toEqual([30, 90]);
    expect(filterTimeEntriesByPeople(entries, ["ana", "bob"])).toHaveLength(4);
  });
});

describe("reconcilePeopleSelection", () => {
  const options = [
    { id: "ana", name: "Ana Pérez" },
    { id: "bob", name: "Bob Smith" },
    { id: "dee", name: "Dee" },
  ];

  it("keeps the same reference when nothing changed", () => {
    const selected = ["ana"];
    expect(reconcilePeopleSelection(selected, options)).toBe(selected);
  });

  it("drops people who are no longer eligible", () => {
    expect(reconcilePeopleSelection(["ana", "zed"], options)).toEqual(["ana"]);
  });

  it("falls back to All people when no selected person remains eligible", () => {
    expect(reconcilePeopleSelection(["zed"], options)).toEqual([]);
  });

  it("collapses to All people when every remaining option is selected", () => {
    expect(reconcilePeopleSelection(["ana", "bob", "zed"], options.slice(0, 2))).toEqual([]);
  });
});

describe("buildHoursReportData with the People filter applied", () => {
  it("All people reproduces the unfiltered report", () => {
    const unfiltered = buildHoursReportData(tickets, projects, members, entries, true);
    const allPeople = buildHoursReportData(tickets, projects, members, filterTimeEntriesByPeople(entries, []), true);
    expect(allPeople).toEqual(unfiltered);
    expect(unfiltered.grandTotalHours).toBeCloseTo(3.25);
  });

  it("computes project totals, grand totals and detail rows from the filtered entries only", () => {
    const data = buildHoursReportData(tickets, projects, members, filterTimeEntriesByPeople(entries, ["bob"]), true);
    expect(data.projectGroups.map((g) => [g.projectName, g.totalHours, g.totalAmount])).toEqual([
      ["Alpha", 0.5, 50],
      ["Beta", 1.5, 75],
    ]);
    expect(data.grandTotalHours).toBe(2);
    expect(data.grandTotalAmount).toBe(125);
    expect(data.detailRows.every((r) => r.memberName === "Bob Smith")).toBe(true);
  });

  it("omits a project entirely when the selected people logged nothing there", () => {
    const anaEntries = entries.filter((e) => e.minutes > 0);
    const data = buildHoursReportData(tickets, projects, members, filterTimeEntriesByPeople(anaEntries, ["ana"]), true);
    expect(data.projectGroups.map((g) => g.projectName)).toEqual(["Alpha"]);
    expect(data.grandTotalHours).toBe(1);
  });
});

describe("ticket links (web preview only)", () => {
  it("carries each group's project slug so the preview can link /projects/<slug>/tickets/<key>", () => {
    const data = buildHoursReportData(tickets, projects, members, entries, false);
    expect(data.projectGroups.map((g) => g.projectSlug)).toEqual(["alpha", "beta"]);
  });

  it("keeps ticket keys as plain-text cells in the Excel sheets", async () => {
    const data = buildHoursReportData(tickets, projects, members, entries, false);
    const sheets = await buildHoursReportWorkbookSheets(data, "2026-09-01", "2026-09-30");
    const cells = sheets.flatMap((sheet) => sheet.rows.flat());
    const keyCells = cells.filter((cell) => typeof cell.value === "string" && /^[A-Z]+-\d+$/.test(cell.value));
    expect(keyCells.length).toBeGreaterThan(0);
    expect(keyCells.every((cell) => Object.keys(cell).every((k) => k === "value"))).toBe(true);
    expect(cells.some((cell) => typeof cell.value === "string" && cell.value.includes("/tickets/"))).toBe(false);
  });
});
