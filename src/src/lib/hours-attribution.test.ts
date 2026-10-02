import { describe, expect, it } from "vitest";

// Hours attribution audit — the canonical rule: a person's logged hours come
// only from ticket_time_entries they logged (logged_by), summed in exact
// minutes and rounded only for display. Assignment, comments, status
// changes and estimates never add logged hours to anyone.
import { buildHoursReportData, filterTimeEntriesByPeople } from "@/lib/hours-report";
import { buildTicketsByMember, buildHoursByPersonRows } from "@/components/reports-screen";
import { hoursByMember, scopeEntries } from "@/components/time-tracking-screen";
import type { OrganizationTimeEntry } from "@/lib/tickets";
import type { Ticket } from "@/lib/mock-tickets";

const MEX = "mex";
const ANA = "ana";
const CARLOS = "carlos";
const members = [
  { id: MEX, name: "Mex", avatar: "", weeklyCapacity: 40 },
  { id: ANA, name: "Ana", avatar: "", weeklyCapacity: 40 },
  { id: CARLOS, name: "Carlos", avatar: "", weeklyCapacity: 40 },
];

function ticket(id: string, projectSlug: string, opts: { assignee?: string; hours?: number; status?: string } = {}): Ticket {
  return {
    id,
    ticketNumber: Number(id.replace(/\D/g, "")) || 1,
    projectSlug,
    title: `Ticket ${id}`,
    status: opts.status ?? "in-progress",
    priority: "medium",
    hours: opts.hours,
    assigneeProfileId: opts.assignee ?? null,
    assignee: { name: opts.assignee ?? "Unassigned", avatar: "" },
  } as unknown as Ticket;
}

function entry(ticketId: string, loggedBy: string | null, minutes: number, workDate = "2026-09-10"): OrganizationTimeEntry {
  return { ticketId, loggedBy, minutes, workDate, comment: null };
}

const projects = [
  { slug: "a", name: "Project A", category: "client" as const, defaultHourlyRate: null },
  { slug: "b", name: "Project B", category: "client" as const, defaultHourlyRate: null },
];

describe("Case 1/2/3 — assignment, comments or status changes never give logged hours", () => {
  // ABC-1: estimate 8h, assigned to Mex. Mex commented and changed status
  // (activity only — there is no time entry for it). Ana logged 2h, Carlos 1h.
  const tickets = [ticket("t1", "a", { assignee: MEX, hours: 8 })];
  const entries = [entry("t1", ANA, 120), entry("t1", CARLOS, 60)];

  it("Time Tracking per-member hours: Mex 0, Ana 2, Carlos 1", () => {
    const byMember = hoursByMember(entries);
    expect(byMember.get(MEX)).toBeUndefined();
    expect(byMember.get(ANA)).toBe(2);
    expect(byMember.get(CARLOS)).toBe(1);
  });

  it("Hours Report with People = Mex has no hours", () => {
    const data = buildHoursReportData(tickets, projects, members, filterTimeEntriesByPeople(entries, [MEX]), false);
    expect(data.grandTotalHours).toBe(0);
    expect(data.detailRows).toHaveLength(0);
  });

  it("Tickets by Member: the ticket can sit in Mex's group (assigned) but with 0 logged hours", () => {
    const groups = buildTicketsByMember(tickets, entries, members, "2026-09-15");
    const mex = groups.find((g) => g.profileId === MEX)!;
    expect(mex.tickets.map((r) => [r.ticket.id, r.loggedHours])).toEqual([["t1", 0]]);
    expect(mex.totalLoggedHours).toBe(0);
    expect(groups.find((g) => g.profileId === ANA)!.totalLoggedHours).toBe(2);
    expect(groups.find((g) => g.profileId === CARLOS)!.totalLoggedHours).toBe(1);
  });

  it("Hours by Person: Mex's 8h estimate stays estimated; his Completed (logged) is 0", () => {
    const rows = buildHoursByPersonRows(tickets, members, [], entries);
    const mex = rows.find((r) => r.id === MEX)!;
    expect(mex.estimatedHours).toBe(8);
    expect(mex.completedHours).toBe(0);
  });
});

describe("Case 4/5 — own time and several people on one ticket", () => {
  it("Mex 15m + 30m + 45m = 90m = 1.5h", () => {
    const entries = [entry("t1", MEX, 15), entry("t1", MEX, 30), entry("t1", MEX, 45)];
    expect(hoursByMember(entries).get(MEX)).toBe(1.5);
    const data = buildHoursReportData([ticket("t1", "a")], projects, members, entries, false);
    expect(data.grandTotalHours).toBe(1.5);
  });

  it("Mex 0.5h, Ana 1.5h, Carlos 1h personally; ticket total 3h", () => {
    const tickets = [ticket("t1", "a")];
    const entries = [entry("t1", MEX, 30), entry("t1", ANA, 90), entry("t1", CARLOS, 60)];
    const per = (id: string) =>
      buildHoursReportData(tickets, projects, members, filterTimeEntriesByPeople(entries, [id]), false).grandTotalHours;
    expect([per(MEX), per(ANA), per(CARLOS)]).toEqual([0.5, 1.5, 1]);
    expect(buildHoursReportData(tickets, projects, members, entries, false).grandTotalHours).toBe(3);
    const groups = buildTicketsByMember(tickets, entries, members, "2026-09-15");
    expect(Object.fromEntries(groups.map((g) => [g.profileId, g.totalLoggedHours]))).toEqual({ mex: 0.5, ana: 1.5, carlos: 1 });
  });
});

describe("Case 6 — estimated vs logged", () => {
  it("12h estimate, Mex logs 45m: estimated 12, logged 0.75 — never 12 logged", () => {
    const tickets = [ticket("t1", "a", { assignee: MEX, hours: 12 })];
    const entries = [entry("t1", MEX, 45)];
    const row = buildHoursByPersonRows(tickets, members, [], entries).find((r) => r.id === MEX)!;
    expect(row.estimatedHours).toBe(12);
    expect(row.completedHours).toBe(0.8); // 0.75 shown at this table's 0.1 precision
    expect(buildHoursReportData(tickets, projects, members, entries, false).grandTotalHours).toBe(0.75);
  });
});

describe("Case 7 — precision: sum exact minutes, round only at display", () => {
  it("three 15m entries are 45m = 0.75h exactly", () => {
    const entries = [entry("t1", MEX, 15), entry("t2", MEX, 15), entry("t3", MEX, 15)];
    const tickets = [ticket("t1", "a"), ticket("t2", "a"), ticket("t3", "a")];
    expect(buildHoursReportData(tickets, projects, members, entries, false).grandTotalHours).toBe(0.75);
  });

  it("Tickets by Member group total rounds the exact sum, not the rounded per-ticket values", () => {
    // 3 tickets × 20m = 60m = 1h. Per-ticket rounding would give 0.3 × 3 = 0.9.
    const tickets = [ticket("t1", "a"), ticket("t2", "a"), ticket("t3", "a")];
    const entries = [entry("t1", MEX, 20), entry("t2", MEX, 20), entry("t3", MEX, 20)];
    const mex = buildTicketsByMember(tickets, entries, members, "2026-09-15").find((g) => g.profileId === MEX)!;
    expect(mex.tickets.map((r) => r.loggedHours)).toEqual([0.3, 0.3, 0.3]); // per-row display
    expect(mex.totalLoggedHours).toBe(1);
  });
});

describe("Case 8 — project filters keep only that person's own entries", () => {
  const tickets = [ticket("a1", "a"), ticket("b1", "b")];
  const entries = [entry("a1", MEX, 60), entry("b1", MEX, 30), entry("a1", ANA, 600)];

  it("Project A: only Mex's A entries; A+B: the exact union", () => {
    const onlyA = scopeEntries(entries, new Set(["a1"]), [MEX]);
    expect(hoursByMember(onlyA).get(MEX)).toBe(1);
    const aAndB = scopeEntries(entries, new Set(["a1", "b1"]), [MEX]);
    expect(hoursByMember(aAndB).get(MEX)).toBe(1.5);
    expect(aAndB.every((e) => e.loggedBy === MEX)).toBe(true);
  });

  it("Hours Report: People = Mex with Projects A+B is 1.5h; with A only 1h", () => {
    const mexEntries = filterTimeEntriesByPeople(entries, [MEX]);
    expect(buildHoursReportData(tickets, projects, members, mexEntries, false).grandTotalHours).toBe(1.5);
    expect(buildHoursReportData([tickets[0]], projects, members, mexEntries, false).grandTotalHours).toBe(1);
  });
});
