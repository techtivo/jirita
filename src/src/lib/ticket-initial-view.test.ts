import { describe, expect, it } from "vitest";
import { resolveInitialTicketView } from "@/lib/ticket-initial-view";
import { countBoardColumns } from "@/components/tickets/board-view";
import type { TicketStatusOption } from "@/lib/tickets";

type View = "list" | "board" | "calendar" | "timeline" | "insights";

function statuses(...names: string[]): TicketStatusOption[] {
  return names.map((name, i) => ({
    id: `s${i}`,
    name,
    sortOrder: i + 1,
    groupType: "open",
    isDefault: i === 0,
    legacyEnumValue: null,
  }));
}

// What the Tickets screen does on entering a project: count the Board's
// real columns, then pick the view.
function enter(projectStatuses: TicketStatusOption[], defaultView: View = "board", explicitView: View | null = null) {
  return resolveInitialTicketView<View>({
    explicitView,
    defaultView,
    boardColumnCount: countBoardColumns(projectStatuses),
  });
}

describe("Tickets initial view", () => {
  it("a project with 2 or 3 Board columns opens on List", () => {
    expect(enter(statuses("Backlog", "Imported"))).toBe("list");
    expect(enter(statuses("A", "B", "C"))).toBe("list");
    expect(enter(statuses("Only"))).toBe("list");
  });

  it("a project with 4+ columns keeps the existing default", () => {
    expect(enter(statuses("A", "B", "C", "D"))).toBe("board");
    expect(enter(statuses("A", "B", "C", "D", "E", "F"))).toBe("board");
    expect(enter(statuses("A", "B", "C", "D"), "list")).toBe("list");
  });

  it("an explicit view always wins — Board stays Board on a small project", () => {
    expect(enter(statuses("Backlog", "Imported"), "board", "board")).toBe("board");
    expect(enter(statuses("Backlog", "Imported"), "board", "calendar")).toBe("calendar");
    expect(enter(statuses("A", "B", "C", "D"), "board", "list")).toBe("list");
  });

  it("is re-evaluated per project from that project's own columns", () => {
    expect(enter(statuses("Backlog", "Imported"))).toBe("list");
    expect(enter(statuses("A", "B", "C", "D", "E"))).toBe("board");
  });

  it("counts the columns the Board really renders", () => {
    expect(countBoardColumns(statuses("A", "B"))).toBe(2);
    // The Board de-dupes by name, so a repeated name is one column.
    expect(countBoardColumns(statuses("A", "A", "B", "C"))).toBe(3);
    // With no statuses loaded the Board falls back to its 6 standard columns.
    expect(countBoardColumns([])).toBe(6);
    expect(enter([])).toBe("board");
  });
});
