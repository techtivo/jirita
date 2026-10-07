import { describe, expect, it } from "vitest";
import {
  buildDeliveryPersonRows,
  capacityHoursForRange,
  countDoneInScope,
  remainingHoursForTicket,
} from "@/lib/delivery-report";
import { buildDeliveryKpiSummary } from "@/components/reports-screen";
import type { Ticket } from "@/lib/mock-tickets";

// Admin Reports → Delivery: current-portfolio numbers and selected-period
// numbers must never be mixed in one figure.

const ALEX = "alex";
const JUAN = "juan";
const members = [
  { id: ALEX, name: "Alex", avatar: "" },
  { id: JUAN, name: "Juan", avatar: "" },
  { id: "idle", name: "Idle", avatar: "" }, // no open tickets, no time
];
const MON_FRI = [1, 2, 3, 4, 5];

function ticket(
  id: string,
  o: { assignee?: string; hours?: number; status?: string; closed?: boolean; dueDate?: string } = {}
): Ticket {
  return {
    id,
    projectSlug: "p",
    assigneeProfileId: o.assignee,
    hours: o.hours,
    status: o.status ?? (o.closed ? "done" : "in-progress"),
    statusGroupType: o.closed ? "closed" : "open",
    dueDate: o.dueDate,
    priority: "medium",
    labels: [],
  } as unknown as Ticket;
}

function entry(ticketId: string, loggedBy: string | null, minutes: number) {
  return { ticketId, loggedBy, minutes };
}

function rows(
  tickets: Ticket[],
  periodEntries: ReturnType<typeof entry>[],
  opts: {
    allTime?: Record<string, number>;
    capacities?: { profileId: string; weeklyCapacity: number }[];
    from?: string;
    to?: string;
  } = {}
) {
  return buildDeliveryPersonRows({
    tickets,
    members,
    capacities: opts.capacities ?? [],
    periodEntries,
    allTimeMinutesByTicketId: new Map(Object.entries(opts.allTime ?? {})),
    periodFrom: opts.from ?? "2026-10-01",
    periodTo: opts.to ?? "2026-10-31",
    activeDays: MON_FRI,
  });
}

describe("Hours by Person — Logged belongs to whoever logged it", () => {
  const tickets = [ticket("t1", { assignee: ALEX, hours: 8 })];

  it("Juan's 2h on a ticket assigned to Alex count for Juan, not Alex", () => {
    const result = rows(tickets, [entry("t1", JUAN, 120), entry("t1", ALEX, 180)]);
    const byId = Object.fromEntries(result.map((r) => [r.id, r]));
    expect(byId[JUAN].loggedHours).toBe(2);
    expect(byId[ALEX].loggedHours).toBe(3);
    // Juan appears even though nothing is assigned to him.
    expect(byId[JUAN].openTickets).toBe(0);
    expect(byId[JUAN].estimatedHours).toBe(0);
    expect(result.map((r) => r.id).sort()).toEqual([ALEX, JUAN]);
  });

  it("only counts time on tickets inside the filtered scope", () => {
    const result = rows(tickets, [entry("t1", JUAN, 60), entry("out-of-scope", JUAN, 600)]);
    expect(result.find((r) => r.id === JUAN)!.loggedHours).toBe(1);
  });
});

describe("Hours by Person — open work as of today", () => {
  const tickets = [
    ticket("open1", { assignee: ALEX, hours: 8 }),
    ticket("open2", { assignee: ALEX }), // no estimate
    ticket("blocked", { assignee: ALEX, hours: 4, status: "blocked" }),
    ticket("closed", { assignee: ALEX, hours: 500, closed: true }),
    ticket("closedBlocked", { assignee: ALEX, hours: 9, status: "blocked", closed: true }),
  ];

  it("Open Tickets and Est. Hours exclude closed tickets; no estimate adds 0", () => {
    const alex = rows(tickets, []).find((r) => r.id === ALEX)!;
    expect(alex.openTickets).toBe(3);
    expect(alex.estimatedHours).toBe(12);
  });

  it("Blocked is a count of open blocked tickets", () => {
    expect(rows(tickets, []).find((r) => r.id === ALEX)!.blockedTickets).toBe(1);
  });

  it("someone with only closed tickets and no time in the period has no row", () => {
    expect(rows([ticket("c", { assignee: JUAN, hours: 5, closed: true })], [])).toEqual([]);
  });
});

describe("Hours by Person — Remaining", () => {
  it("is the open estimate minus ALL time ever logged on the ticket, by anyone", () => {
    // 8h estimate; Alex logged 3h and Juan 2h historically → 3h left, not 5h.
    const result = rows([ticket("t1", { assignee: ALEX, hours: 8 })], [], { allTime: { t1: 300 } });
    expect(result.find((r) => r.id === ALEX)!.remainingHours).toBe(3);
  });

  it("does not depend on the hours logged in the selected period", () => {
    const tickets = [ticket("t1", { assignee: ALEX, hours: 8 })];
    const quiet = rows(tickets, [], { allTime: { t1: 300 } });
    const busy = rows(tickets, [entry("t1", ALEX, 60)], { allTime: { t1: 300 } });
    expect(quiet[0].remainingHours).toBe(3);
    expect(busy[0].remainingHours).toBe(3);
  });

  it("is summed per ticket: an over-run ticket never hides another's remaining work", () => {
    const tickets = [ticket("over", { assignee: ALEX, hours: 2 }), ticket("fresh", { assignee: ALEX, hours: 5 })];
    const result = rows(tickets, [], { allTime: { over: 600 } });
    expect(result[0].remainingHours).toBe(5);
    expect(remainingHoursForTicket(2, 600)).toBe(0);
    expect(remainingHoursForTicket(undefined, 0)).toBe(0);
  });

  it("ignores closed tickets entirely", () => {
    const tickets = [ticket("open", { assignee: ALEX, hours: 4 }), ticket("closed", { assignee: ALEX, hours: 40, closed: true })];
    expect(rows(tickets, [])[0].remainingHours).toBe(4);
  });
});

describe("Utilization — capacity scaled to the selected period", () => {
  it("scales weekly capacity by the working days the range really has", () => {
    // October 2026 has 22 Mon–Fri days → 4.4 weeks, not 1 and not a flat 4.
    expect(capacityHoursForRange(40, "2026-10-01", "2026-10-31", MON_FRI)).toBe(176);
    // February 2026 has 20.
    expect(capacityHoursForRange(40, "2026-02-01", "2026-02-28", MON_FRI)).toBe(160);
    // A custom range uses its own real days: Mon Oct 5 – Wed Oct 7.
    expect(capacityHoursForRange(40, "2026-10-05", "2026-10-07", MON_FRI)).toBe(24);
    // A weekend-only range has no capacity.
    expect(capacityHoursForRange(40, "2026-10-10", "2026-10-11", MON_FRI)).toBe(0);
    // The organization's own working days are respected (Mon–Sat).
    expect(capacityHoursForRange(48, "2026-10-05", "2026-10-11", [1, 2, 3, 4, 5, 6])).toBe(48);
  });

  const tickets = [ticket("t1", { assignee: ALEX, hours: 8 })];
  const capacities = [{ profileId: ALEX, weeklyCapacity: 40 }];

  it("This Month divides by the month's capacity, not by one week", () => {
    // 20h in October against 176h — 11%, where one week's 40h would say 50%.
    const alex = rows(tickets, [entry("t1", ALEX, 1200)], { capacities })[0];
    expect(alex.utilization).toBe(11);
  });

  it("can exceed 100%", () => {
    const alex = rows(tickets, [entry("t1", ALEX, 30 * 60)], { capacities, from: "2026-10-05", to: "2026-10-07" })[0];
    expect(alex.utilization).toBe(125);
  });

  it("is null without capacity for the period", () => {
    expect(rows(tickets, [entry("t1", ALEX, 60)])[0].utilization).toBeNull();
    expect(rows(tickets, [entry("t1", ALEX, 60)], { capacities, from: "2026-10-10", to: "2026-10-11" })[0].utilization).toBeNull();
  });
});

describe("KPIs", () => {
  const today = "2026-10-07";
  const tickets = [
    ticket("a", { assignee: ALEX, hours: 10 }),
    ticket("b", { assignee: ALEX, hours: 5, status: "blocked" }),
    ticket("late", { assignee: JUAN, hours: 2, dueDate: "Oct 1, 2026" }),
    ticket("old", { assignee: ALEX, hours: 1000, closed: true }),
  ];
  const projects = [{ status: "active" as const }, { status: "active" as const }, { status: "archived" as const }];

  it("Logged Hours is just the period's entries in scope — no estimate, no percentage on screen", () => {
    const scoped = [{ minutes: 90 }, { minutes: 45 }]; // already period + scope filtered by the screen
    const kpis = buildDeliveryKpiSummary(tickets, projects, scoped, today, 0);
    expect(kpis.loggedHours).toBe(2.3); // 135 min at this card's 0.1 precision
    // The old "Hours Burn" (period hours ÷ all-time estimate) is gone.
    expect(kpis).not.toHaveProperty("hoursBurnPct");
    expect(kpis).not.toHaveProperty("estimatedHours");
  });

  it("current-portfolio cards are a snapshot: unchanged by the period's entries or Done count", () => {
    const quiet = buildDeliveryKpiSummary(tickets, projects, [], today, 0);
    const busy = buildDeliveryKpiSummary(tickets, projects, [{ minutes: 6000 }], today, 7);
    for (const key of ["activeProjects", "activeTickets", "blockedTickets", "overdueTickets"] as const) {
      expect(busy[key]).toBe(quiet[key]);
    }
    expect(quiet.activeProjects).toBe(2);
    expect(quiet.activeTickets).toBe(3);
    expect(quiet.blockedTickets).toBe(1);
    expect(busy.completedThisMonth).toBe(7);
  });

  it("Done only counts tickets inside the filtered scope", () => {
    const done = ["d1", "d2", "d3"];
    expect(countDoneInScope(done, new Set(["d1", "d2", "d3", "x"]))).toBe(3); // no filter
    expect(countDoneInScope(done, new Set(["d2", "x"]))).toBe(1); // e.g. Project/Assignee filter
    expect(countDoneInScope(done, new Set())).toBe(0);
  });
});
