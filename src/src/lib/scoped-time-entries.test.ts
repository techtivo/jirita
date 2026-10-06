import { beforeEach, describe, expect, it, vi } from "vitest";

// Pins which query each scope goes through: led-project tickets use the
// whole-team loader; member-only project tickets only ever use the
// own-entries loader (logged_by = profile), and anything else it might
// return is dropped.
const orgCalls: unknown[][] = [];
const ownCalls: unknown[][] = [];

vi.mock("@/lib/tickets", () => ({
  loadOrganizationLoggedTimeForRange: async (...args: unknown[]) => {
    orgCalls.push(args);
    return {
      status: "ready",
      entries: [
        { ticketId: "collab-1", loggedBy: "cristian", minutes: 120, workDate: "2026-10-05", comment: null },
        { ticketId: "collab-1", loggedBy: "miguel", minutes: 30, workDate: "2026-10-05", comment: null },
      ],
    };
  },
  loadProfileTimeEntriesForRange: async (...args: unknown[]) => {
    ownCalls.push(args);
    return {
      status: "ready",
      entries: [
        { ticketId: "tcfcu-1", loggedByProfileId: "miguel", minutes: 90, workDate: "2026-10-06", comment: "own" },
        // Should never come back from a logged_by-filtered query; dropped anyway.
        { ticketId: "tcfcu-1", loggedByProfileId: "mex", minutes: 240, workDate: "2026-10-06", comment: null },
      ],
    };
  },
}));

const { loadScopedTimeEntries } = await import("./scoped-time-entries");

beforeEach(() => {
  orgCalls.length = 0;
  ownCalls.length = 0;
});

describe("loadScopedTimeEntries", () => {
  it("reads team time only for led tickets and own time only for member-only tickets", async () => {
    const result = await loadScopedTimeEntries(["collab-1"], ["tcfcu-1"], "miguel", "2026-10-01", "2026-10-31");

    expect(orgCalls).toEqual([[["collab-1"], "2026-10-01", "2026-10-31"]]);
    expect(ownCalls).toEqual([["miguel", ["tcfcu-1"], "2026-10-01", "2026-10-31"]]);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.entries.map((e) => [e.ticketId, e.loggedBy, e.minutes])).toEqual([
      ["collab-1", "cristian", 120],
      ["collab-1", "miguel", 30],
      ["tcfcu-1", "miguel", 90],
    ]);
    expect(result.entries.some((e) => e.loggedBy === "mex")).toBe(false);
  });
});
