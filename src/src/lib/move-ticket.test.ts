import { beforeEach, describe, expect, it, vi } from "vitest";

// JIR-116 — client side of "Move to project". The move itself (authorization,
// numbering, status/assignee, hierarchy, atomicity) lives in the
// move_ticket_to_project database function; these tests cover what the app
// offers, what it sends, and how it reports the function's result.

const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
let rpcResponse: { data: unknown; error: { message: string } | null } = { data: null, error: null };

vi.mock("./supabase-client", () => ({
  getSupabaseBrowserClient: () => ({
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return Promise.resolve(rpcResponse);
    },
  }),
}));

const { filterTicketMoveDestinations, moveTicketErrorMessage, moveTicketToProject } = await import("./tickets");
const { getTicketDisplayKey } = await import("./mock-tickets");

const projects = [
  { id: "p-sma", slug: "smallbusiness", name: "Smallbusiness", project_code: "SMA", status: "active" },
  { id: "p-jir", slug: "jirita", name: "JIRITA", project_code: "JIR", status: "active" },
  { id: "p-old", slug: "old", name: "Old", project_code: "OLD", status: "archived" },
  { id: "p-tfc", slug: "tfcu", name: "TFCU", project_code: "TFC", status: "planning" },
];

beforeEach(() => {
  rpcCalls.length = 0;
});

describe("filterTicketMoveDestinations", () => {
  it("Admin: every non-archived project except the current one", () => {
    expect(filterTicketMoveDestinations(projects, "p-sma", "ADMIN", new Set()).map((d) => d.slug)).toEqual(["jirita", "tfcu"]);
  });

  it("Project Lead: only projects they lead, and only if they lead the source", () => {
    expect(filterTicketMoveDestinations(projects, "p-sma", "PROJECT_LEAD", new Set(["p-sma", "p-jir"])).map((d) => d.slug)).toEqual(["jirita"]);
    expect(filterTicketMoveDestinations(projects, "p-sma", "PROJECT_LEAD", new Set(["p-jir", "p-tfc"]))).toEqual([]);
    expect(filterTicketMoveDestinations(projects, "p-sma", "PROJECT_LEAD", new Set(["p-sma", "p-old"]))).toEqual([]);
  });

  it("Member: never any destination", () => {
    expect(filterTicketMoveDestinations(projects, "p-sma", "MEMBER", new Set(["p-sma", "p-jir"]))).toEqual([]);
  });
});

describe("moveTicketErrorMessage", () => {
  it("maps the database function's error keys to user-facing copy", () => {
    expect(moveTicketErrorMessage("move_ticket:has_hierarchy")).toMatch(/parent or child tickets/);
    expect(moveTicketErrorMessage("move_ticket:not_authorized")).toMatch(/permission/);
    expect(moveTicketErrorMessage("move_ticket:destination_archived")).toMatch(/archived/);
    expect(moveTicketErrorMessage("move_ticket:ticket_changed")).toMatch(/changed or moved/);
  });

  it("never exposes raw database errors", () => {
    expect(moveTicketErrorMessage('duplicate key value violates unique constraint "tickets_project_id_ticket_number_key"')).toBe(
      "Couldn't move the ticket. Please try again."
    );
    expect(moveTicketErrorMessage(undefined)).toBe("Couldn't move the ticket. Please try again.");
  });
});

describe("moveTicketToProject", () => {
  it("calls the single atomic function with the ticket, destination and expected source", async () => {
    rpcResponse = { data: [{ ticket_id: "t-1", project_slug: "jirita", project_code: "JIR", ticket_number: 116 }], error: null };
    const result = await moveTicketToProject("t-1", "p-jir", "p-sma");
    expect(rpcCalls).toEqual([
      {
        name: "move_ticket_to_project",
        args: { p_ticket_id: "t-1", p_destination_project_id: "p-jir", p_expected_source_project_id: "p-sma" },
      },
    ]);
    expect(result).toEqual({ status: "moved", projectSlug: "jirita", ticketCode: "JIR-116" });
    // The destination's code is registered, so keys render with it right away.
    expect(getTicketDisplayKey({ projectSlug: "jirita", ticketNumber: 116 })).toBe("JIR-116");
  });

  it("returns a friendly error and no navigation target on failure", async () => {
    rpcResponse = { data: null, error: { message: "move_ticket:has_relations" } };
    const result = await moveTicketToProject("t-1", "p-jir", "p-sma");
    expect(result).toEqual({
      status: "error",
      message: "This ticket is linked to related tickets. Linked tickets can't be moved between projects yet.",
    });
  });
});

// ── JIR-116 extension: historical URLs ─────────────────────────────────────
describe("historical ticket URLs", () => {
  it("resolveTicketRouteAlias sends exactly the URL parts and returns the current location", async () => {
    const { resolveTicketRouteAlias } = await import("./tickets");
    rpcResponse = { data: [{ project_slug: "abc", ticket_code: "ABC-81" }], error: null };
    expect(await resolveTicketRouteAlias("org-1", "jirita", "JIR-116")).toEqual({ projectSlug: "abc", ticketCode: "ABC-81" });
    expect(rpcCalls.at(-1)).toEqual({
      name: "resolve_ticket_route_alias",
      args: { p_organization_id: "org-1", p_project_slug: "jirita", p_ticket_code: "JIR-116" },
    });
  });

  it("unknown or unauthorized URLs resolve to null (the page keeps its normal not-found)", async () => {
    const { resolveTicketRouteAlias } = await import("./tickets");
    rpcResponse = { data: [], error: null };
    expect(await resolveTicketRouteAlias("org-1", "jirita", "JIR-999")).toBeNull();
    rpcResponse = { data: null, error: { message: "boom" } };
    expect(await resolveTicketRouteAlias("org-1", "jirita", "JIR-999")).toBeNull();
  });

  it("redirects an old URL straight to the current one, never to itself", async () => {
    const { ticketRouteRedirectTarget } = await import("./tickets");
    expect(ticketRouteRedirectTarget({ projectSlug: "abc", ticketCode: "ABC-81" }, "jirita", "JIR-116")).toBe("/projects/abc/tickets/ABC-81");
    expect(ticketRouteRedirectTarget({ projectSlug: "abc", ticketCode: "ABC-81" }, "jirita-live", "LIVE-42")).toBe("/projects/abc/tickets/ABC-81");
    expect(ticketRouteRedirectTarget({ projectSlug: "abc", ticketCode: "ABC-81" }, "abc", "ABC-81")).toBeNull();
    expect(ticketRouteRedirectTarget(null, "jirita", "JIR-999")).toBeNull();
  });

  it("new ticket numbers come from next_ticket_number (which skips reserved historical numbers)", async () => {
    const { nextTicketNumber } = await import("./tickets");
    const { getSupabaseBrowserClient } = await import("./supabase-client");
    rpcResponse = { data: 124, error: null };
    expect(await nextTicketNumber(getSupabaseBrowserClient(), "p-sma")).toEqual({ status: "ready", ticketNumber: 124 });
    expect(rpcCalls.at(-1)).toEqual({ name: "next_ticket_number", args: { p_project_id: "p-sma" } });
    rpcResponse = { data: null, error: { message: "permission denied" } };
    expect(await nextTicketNumber(getSupabaseBrowserClient(), "p-sma")).toEqual({ status: "error", message: "permission denied" });
  });
});
