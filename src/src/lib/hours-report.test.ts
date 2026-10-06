import { describe, expect, it } from "vitest";
import {
  buildHoursReportData,
  buildHoursReportWorkbookSheets,
  buildHoursReportFilename,
  getHoursReportCapabilities,
  buildPersonalProjectOptions,
  reconcileProjectSelection,
  buildHoursReportPeopleOptions,
  filterTimeEntriesByPeople,
  reconcilePeopleSelection,
} from "@/lib/hours-report";
import type { OrganizationTimeEntry } from "@/lib/tickets";
import type { Ticket } from "@/lib/mock-tickets";
import { realRangeForPeriod } from "@/components/reports-screen";

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

describe("getHoursReportCapabilities (JIR-113)", () => {
  it("keeps Admin's administrative report: org scope, People, PDF, $", () => {
    expect(getHoursReportCapabilities("ADMIN", false)).toEqual({
      scope: "organization",
      canFilterPeople: true,
      canDownloadPdf: true,
      includeFinancials: true,
    });
  });

  it("keeps Project Lead's led-projects report, $ only with financial access", () => {
    expect(getHoursReportCapabilities("PROJECT_LEAD", false)).toEqual({
      scope: "led-projects",
      canFilterPeople: true,
      canDownloadPdf: true,
      includeFinancials: false,
    });
    expect(getHoursReportCapabilities("PROJECT_LEAD", true).includeFinancials).toBe(true);
  });

  it("gives a Member a personal report: own scope, no People, no PDF, never $", () => {
    for (const financialAccess of [false, true]) {
      expect(getHoursReportCapabilities("MEMBER", financialAccess)).toEqual({
        scope: "own",
        canFilterPeople: false,
        canDownloadPdf: false,
        includeFinancials: false,
      });
    }
  });
});

describe("period presets (shared by every role)", () => {
  const today = "2026-10-02";
  const none = { from: "", to: "" };
  it("This Month is the full current calendar month", () => {
    expect(realRangeForPeriod("this-month", none, today)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
  });
  it("Last Month is the full previous calendar month, not the last 30 days", () => {
    expect(realRangeForPeriod("last-month", none, today)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(realRangeForPeriod("last-month", none, "2026-01-15")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });
  it("This Quarter is the current calendar quarter", () => {
    expect(realRangeForPeriod("this-quarter", none, today)).toEqual({ from: "2026-10-01", to: "2026-12-31" });
    expect(realRangeForPeriod("this-quarter", none, "2026-05-20")).toEqual({ from: "2026-04-01", to: "2026-06-30" });
  });
  it("Custom Range uses From/To as given", () => {
    const custom = { from: "2026-08-03", to: "2026-08-17" };
    expect(realRangeForPeriod("custom", custom, today)).toBe(custom);
  });
});

describe("Member personal report (JIR-113)", () => {
  // Member belongs to A, B and C; this period they only logged time in A
  // and C (B has a zero-minute entry). Entries are what the Member fetch
  // returns: only their own.
  const memberProjects = [
    { slug: "a", name: "Project A", category: "client" as const, defaultHourlyRate: null },
    { slug: "b", name: "Project B", category: "client" as const, defaultHourlyRate: null },
    { slug: "c", name: "Project C", category: "internal" as const, defaultHourlyRate: null },
  ];
  const memberTickets = [
    { id: "ta", ticketNumber: 1, projectSlug: "a", title: "A ticket" },
    { id: "tb", ticketNumber: 2, projectSlug: "b", title: "B ticket" },
    { id: "tc", ticketNumber: 3, projectSlug: "c", title: "C ticket" },
  ] as unknown as Ticket[];
  const me = [{ id: "me", name: "Michaela Doe" }];
  const own = [
    entry("ta", "me", 15),
    entry("ta", "me", 15),
    entry("tc", "me", 15),
    entry("tb", "me", 0),
  ];

  it("offers every accessible project, including ones with zero logged hours", () => {
    // B has only a zero-minute entry this period — still selectable.
    expect(buildPersonalProjectOptions(memberProjects, own, memberTickets)).toEqual([
      { slug: "a", name: "Project A" },
      { slug: "b", name: "Project B" },
      { slug: "c", name: "Project C" },
    ]);
    expect(buildPersonalProjectOptions(memberProjects, [], memberTickets)).toHaveLength(3);
  });

  it("member of Collab/TCFCU/Small Business with hours only in Collab sees all three, and nothing else", () => {
    // What RLS (can_view_project) returns for this Member: only their own
    // three projects — "Secret" (not a member) never reaches the client.
    const accessible = [
      { slug: "tcfcu", name: "TCFCU", status: "active" },
      { slug: "collab", name: "Collab", status: "active" },
      { slug: "smallbusiness", name: "Small Business", status: "planning" },
    ];
    const accessibleTickets = [
      { id: "c1", ticketNumber: 1, projectSlug: "collab", title: "Collab ticket" },
      { id: "s1", ticketNumber: 1, projectSlug: "secret", title: "Not visible" },
    ] as unknown as Ticket[];
    const hours = [entry("c1", "me", 120), entry("s1", "me", 60)];

    const options = buildPersonalProjectOptions(accessible, hours, accessibleTickets);
    expect(options.map((o) => o.name)).toEqual(["Collab", "Small Business", "TCFCU"]);
    expect(options.some((o) => o.slug === "secret")).toBe(false);

    // Selecting a zero-hours project is valid (kept by reconcile) and
    // simply yields an empty report; a non-accessible slug is dropped.
    const selected = ["tcfcu"];
    expect(reconcileProjectSelection(selected, options)).toBe(selected);
    expect(reconcileProjectSelection(["secret"], options)).toEqual([]);
    const tcfcuOnly = buildHoursReportData(
      accessibleTickets.filter((t) => t.projectSlug === "tcfcu"),
      accessible.map((p) => ({ ...p, category: "client" as const, defaultHourlyRate: null })),
      me,
      hours,
      false
    );
    expect(tcfcuOnly.projectGroups).toEqual([]);
    expect(tcfcuOnly.grandTotalHours).toBe(0);
  });

  it("archived projects: hidden with no hours in the period, still offered (and reported) with hours", () => {
    const withArchived = [
      { slug: "live", name: "Live", status: "active", category: "client" as const, defaultHourlyRate: null },
      { slug: "old-empty", name: "Old Empty", status: "archived", category: "client" as const, defaultHourlyRate: null },
      { slug: "old-worked", name: "Old Worked", status: "archived", category: "client" as const, defaultHourlyRate: null },
    ];
    const archivedTickets = [
      { id: "l1", ticketNumber: 1, projectSlug: "live", title: "Live ticket" },
      { id: "o1", ticketNumber: 1, projectSlug: "old-worked", title: "Old ticket" },
    ] as unknown as Ticket[];
    const history = [entry("o1", "me", 90)];

    expect(buildPersonalProjectOptions(withArchived, history, archivedTickets).map((o) => o.slug)).toEqual([
      "live",
      "old-worked",
    ]);
    // A period with no archived hours offers only the operational project.
    expect(buildPersonalProjectOptions(withArchived, [], archivedTickets).map((o) => o.slug)).toEqual(["live"]);
    // The default "All projects" report still includes the archived hours.
    const all = buildHoursReportData(archivedTickets, withArchived, me, history, false);
    expect(all.projectGroups.map((g) => [g.projectName, g.totalHours])).toEqual([["Old Worked", 1.5]]);
  });

  it("reconciles a stale selection: keeps A, drops B, falls back to All when nothing is valid", () => {
    const thisMonth = [{ slug: "a", name: "Project A" }, { slug: "c", name: "Project C" }];
    expect(reconcileProjectSelection(["a", "b"], thisMonth)).toEqual(["a"]);
    expect(reconcileProjectSelection(["b"], thisMonth)).toEqual([]);
    expect(reconcileProjectSelection(["a", "c"], thisMonth)).toEqual([]);
    const selected = ["a"];
    expect(reconcileProjectSelection(selected, thisMonth)).toBe(selected);
  });

  it("filters by selected projects via the tickets passed in, with exact (unrounded) totals", () => {
    const all = buildHoursReportData(memberTickets, memberProjects, me, own, false);
    expect(all.grandTotalHours).toBe(0.75);
    const onlyA = buildHoursReportData(
      memberTickets.filter((t) => t.projectSlug === "a"),
      memberProjects,
      me,
      own,
      false
    );
    expect(onlyA.projectGroups.map((g) => [g.projectName, g.totalHours])).toEqual([["Project A", 0.5]]);
    expect(onlyA.grandTotalHours).toBe(0.5);
    expect(onlyA.detailRows).toHaveLength(2);
  });

  it("produces an Excel with no $ column, only the Member's own name, and plain-text keys", async () => {
    const data = buildHoursReportData(memberTickets, memberProjects, me, own, false);
    const [summary, details] = await buildHoursReportWorkbookSheets(data, "2026-09-01", "2026-09-30", "Michaela Doe");
    const allCells = [...summary.rows, ...details.rows].flat();
    expect(allCells.some((c) => c.value === "$")).toBe(false);
    expect(allCells.some((c) => "currency" in c && c.currency)).toBe(false);
    const memberColumn = details.rows.slice(5).map((r) => r[3].value);
    expect(new Set(memberColumn)).toEqual(new Set(["Michaela Doe"]));
    expect(allCells.some((c) => typeof c.value === "string" && c.value.includes("/tickets/"))).toBe(false);
  });
});

describe("Member Excel labeling (JIR-113)", () => {
  const memberProjects = [{ slug: "a", name: "Project A", category: "client" as const, defaultHourlyRate: null }];
  const memberTickets = [{ id: "ta", ticketNumber: 1, projectSlug: "a", title: "A ticket" }] as unknown as Ticket[];
  const me = [{ id: "me", name: "Michaela Levinsonas" }];
  const own = [entry("ta", "me", 30), entry("ta", "me", 15)];

  it("shows `User: <name>` right under each sheet's title, before the period", async () => {
    const data = buildHoursReportData(memberTickets, memberProjects, me, own, false);
    const [summary, details] = await buildHoursReportWorkbookSheets(data, "2026-09-01", "2026-09-30", "Michaela Levinsonas");
    expect(summary.rows.slice(2, 5).map((r) => r[0]?.value)).toEqual([
      "HOURS REPORT",
      "User: Michaela Levinsonas",
      "Period: 2026-09-01 to 2026-09-30",
    ]);
    expect(details.rows.slice(0, 3).map((r) => r[0]?.value)).toEqual([
      "Jirita — Hours Report (Details)",
      "User: Michaela Levinsonas",
      "Period: 2026-09-01 to 2026-09-30",
    ]);
    // Still only the Member's already-filtered entries, keys as plain text.
    const totalRow = summary.rows[summary.rows.length - 1];
    expect(totalRow[2].value).toBe(0.75);
    const detailRows = details.rows.slice(5);
    expect(detailRows).toHaveLength(2);
    for (const row of detailRows) expect(Object.keys(row[1])).toEqual(["value"]);
  });

  it("includes the normalized user name and the dates in a Member's filename", () => {
    expect(buildHoursReportFilename("2026-09-01", "2026-09-30", "xlsx", "Michaela Levinsonas")).toBe(
      "jirita-hours-report-michaela-levinsonas-2026-09-01-to-2026-09-30.xlsx"
    );
    expect(buildHoursReportFilename("2026-09-01", "2026-09-30", "xlsx", "  José Ñúñez O'Brien ")).toBe(
      "jirita-hours-report-jose-nunez-o-brien-2026-09-01-to-2026-09-30.xlsx"
    );
    // A name with nothing filename-safe left just falls back to the plain name.
    expect(buildHoursReportFilename("2026-09-01", "2026-09-30", "xlsx", "李")).toBe(
      "jirita-hours-report-2026-09-01-to-2026-09-30.xlsx"
    );
  });

  it("leaves Admin/Project Lead exports unchanged: original filename, no User row", async () => {
    expect(buildHoursReportFilename("2026-09-01", "2026-09-30", "xlsx")).toBe("jirita-hours-report-2026-09-01-to-2026-09-30.xlsx");
    const data = buildHoursReportData(tickets, projects, members, entries, true);
    const [summary, details] = await buildHoursReportWorkbookSheets(data, "2026-09-01", "2026-09-30");
    expect(summary.rows.slice(0, 6).map((r) => r[0]?.value)).toEqual([
      undefined,
      undefined,
      "HOURS REPORT",
      "Period: 2026-09-01 to 2026-09-30",
      undefined,
      "Ticket",
    ]);
    expect(details.rows.slice(0, 4).map((r) => r[0]?.value)).toEqual([
      "Jirita — Hours Report (Details)",
      "Period: 2026-09-01 to 2026-09-30",
      undefined,
      "Project",
    ]);
    expect([...summary.rows, ...details.rows].flat().some((c) => String(c.value).startsWith("User:"))).toBe(false);
  });
});
