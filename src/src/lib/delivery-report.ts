// Pure data-shaping for Admin Reports → Delivery. The tab shows two kinds
// of numbers that must never be mixed in one figure:
//   - Current portfolio — the state of the work right now (open tickets,
//     their estimates, what's left on them, what's blocked). Never changes
//     with the Reporting Period.
//   - Selected period — what happened inside the Reporting Period (hours
//     logged, tickets done, utilization against that same period's
//     capacity).
// No Supabase calls live here; reports-screen.tsx owns the fetches.

import { isTicketClosed } from "@/lib/tickets";
import type { Ticket } from "@/lib/mock-tickets";
import { countActiveDaysInRange } from "@/lib/active-days";

type DeliveryTicket = Pick<Ticket, "id" | "assigneeProfileId" | "status" | "statusGroupType" | "hours">;

export interface DeliveryPersonRow {
  id: string;
  name: string;
  avatar: string;
  /** Current: open tickets assigned to this person. */
  openTickets: number;
  /** Current: estimate of those open tickets (no estimate = 0). */
  estimatedHours: number;
  /** Period: every hour this person logged, on any in-scope ticket —
   *  whoever that ticket is assigned to. */
  loggedHours: number;
  /** Current: what's left on those open tickets — see buildDeliveryPersonRows. */
  remainingHours: number;
  /** Current: how many of those open tickets are blocked. */
  blockedTickets: number;
  /** Period: loggedHours ÷ this person's capacity for the same period, as a
   *  percentage — not capped at 100. null when they have no capacity for
   *  the period (no weekly capacity set, or a range with no working days). */
  utilization: number | null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// A person's capacity for a date range: their weekly capacity spread over
// the organization's own working days (organizations.active_days), times
// the working days the range really contains — the same rule Time
// Tracking's expectedHoursForPeriod uses. So a month is ~4.2–4.6 weeks of
// capacity (never a flat ×4), and a Custom Range uses its real days.
export function capacityHoursForRange(
  weeklyCapacity: number,
  fromISO: string,
  toISO: string,
  activeDays: number[]
): number {
  if (activeDays.length === 0 || !fromISO || !toISO || fromISO > toISO) return 0;
  return (weeklyCapacity / activeDays.length) * countActiveDaysInRange(fromISO, toISO, activeDays);
}

// What's left on one open ticket: its estimate minus everything ever
// logged against it, by anyone — never below 0, and 0 with no estimate.
export function remainingHoursForTicket(estimateHours: number | undefined, loggedMinutesAllTime: number): number {
  return Math.max((estimateHours ?? 0) - loggedMinutesAllTime / 60, 0);
}

// "Hours by Person" rows.
//
// `tickets` is the dashboard's filtered ticket scope. `periodEntries` are
// the time entries of that same scope whose work_date is in the Reporting
// Period. `allTimeMinutesByTicketId` is the total ever logged per open
// ticket (any author, any date).
//
// A row exists for anyone with an open ticket assigned in scope OR with
// time logged in the period on an in-scope ticket — so someone who worked
// on a ticket assigned to somebody else still appears, with their own
// hours. Logged is attributed to the time entry's author only, never to
// the ticket's assignee. Open Tickets/Est. Hours/Remaining/Blocked describe
// the assignee's open tickets as they are today. Remaining is summed per
// ticket, so a ticket that ran over its estimate never hides what's left on
// another one.
export function buildDeliveryPersonRows({
  tickets,
  members,
  capacities,
  periodEntries,
  allTimeMinutesByTicketId,
  periodFrom,
  periodTo,
  activeDays,
}: {
  tickets: DeliveryTicket[];
  members: { id: string; name: string; avatar: string }[];
  capacities: { profileId: string; weeklyCapacity: number }[];
  periodEntries: { ticketId: string; loggedBy: string | null; minutes: number }[];
  allTimeMinutesByTicketId: ReadonlyMap<string, number>;
  periodFrom: string;
  periodTo: string;
  activeDays: number[];
}): DeliveryPersonRow[] {
  const capacityByProfileId = new Map(capacities.map((c) => [c.profileId, c.weeklyCapacity]));
  const ticketIds = new Set(tickets.map((t) => t.id));

  const loggedMinutesByPerson = new Map<string, number>();
  for (const entry of periodEntries) {
    if (!entry.loggedBy || !ticketIds.has(entry.ticketId)) continue;
    loggedMinutesByPerson.set(entry.loggedBy, (loggedMinutesByPerson.get(entry.loggedBy) ?? 0) + entry.minutes);
  }

  const openTicketsByAssignee = new Map<string, DeliveryTicket[]>();
  for (const ticket of tickets) {
    if (!ticket.assigneeProfileId || isTicketClosed(ticket)) continue;
    const list = openTicketsByAssignee.get(ticket.assigneeProfileId) ?? [];
    list.push(ticket);
    openTicketsByAssignee.set(ticket.assigneeProfileId, list);
  }

  const rows: DeliveryPersonRow[] = [];
  for (const member of members) {
    const openTickets = openTicketsByAssignee.get(member.id) ?? [];
    const loggedMinutes = loggedMinutesByPerson.get(member.id) ?? 0;
    if (openTickets.length === 0 && loggedMinutes === 0) continue;

    const loggedHours = loggedMinutes / 60;
    const capacityHours = capacityHoursForRange(
      capacityByProfileId.get(member.id) ?? 0,
      periodFrom,
      periodTo,
      activeDays
    );

    rows.push({
      id: member.id,
      name: member.name,
      avatar: member.avatar,
      openTickets: openTickets.length,
      estimatedHours: round1(openTickets.reduce((sum, t) => sum + (t.hours ?? 0), 0)),
      loggedHours: round1(loggedHours),
      remainingHours: round1(
        openTickets.reduce(
          (sum, t) => sum + remainingHoursForTicket(t.hours, allTimeMinutesByTicketId.get(t.id) ?? 0),
          0
        )
      ),
      // "blocked" is one specific status, read the same way the Blocked KPI
      // reads it (see isTicketClosed's own note in lib/tickets.ts).
      blockedTickets: openTickets.filter((t) => t.status === "blocked").length,
      utilization: capacityHours > 0 ? Math.round((loggedHours / capacityHours) * 100) : null,
    });
  }
  return rows;
}

// Tickets done in the Reporting Period, within the dashboard's filtered
// ticket scope — the Done KPI responds to the same filters as every other
// ticket-level number (Assignee = the ticket's current assignee).
export function countDoneInScope(doneTicketIds: string[], scopeTicketIds: ReadonlySet<string>): number {
  return doneTicketIds.filter((id) => scopeTicketIds.has(id)).length;
}
