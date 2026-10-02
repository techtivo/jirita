import { describe, expect, it, vi } from "vitest";

// JIR-116 — how a 'ticket_moved' row shows up in Ticket Detail → Activity.
// Runs the real loadTicketActivity against a fake client that returns the
// exact row shape move_ticket_to_project writes (actor_profile_id,
// event_type 'ticket_moved', field_name 'project', old_value/new_value
// "<Project> (<CODE-N>)", created_at).

type Row = Record<string, unknown>;
let activityRows: Row[] = [];
const PROFILES: Row[] = [
  { id: "alex", first_name: "Alex", last_name: "Sosa", avatar_url: null, updated_at: null },
  { id: "ana", first_name: "Ana", last_name: "Diaz", avatar_url: null, updated_at: null },
];

function query(table: string) {
  const rows = () => (table === "ticket_activity" ? activityRows : table === "profiles" ? PROFILES : []);
  const chain = {
    select() { return chain; },
    eq() { return chain; },
    in() { return chain; },
    order() { return chain; },
    returns() { return chain; },
    maybeSingle() { return Promise.resolve({ data: null, error: null }); },
    then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve({ data: rows(), error: null }).then(resolve, reject);
    },
  };
  return chain;
}

vi.mock("./supabase-client", () => ({ getSupabaseBrowserClient: () => ({ from: query }) }));

const { loadTicketActivity, formatRelativeTime } = await import("./tickets");

const created = { id: "a0", actor_profile_id: "ana", event_type: "ticket_created", field_name: null, old_value: null, new_value: null, created_at: "2026-09-01T10:00:00Z" };

async function labels(rows: Row[]) {
  activityRows = rows;
  const result = await loadTicketActivity("ticket-1");
  if (result.status !== "ready") throw new Error("load failed");
  return result.events;
}

describe("Activity — ticket_moved", () => {
  it("shows actor, source project/code and destination project/code, with the event's own timestamp", async () => {
    const movedAt = "2026-10-02T15:30:00Z";
    const events = await labels([
      { id: "a1", actor_profile_id: "alex", event_type: "ticket_moved", field_name: "project", old_value: "JIRITA (JIR-116)", new_value: "JIRITA Live (JL-19)", created_at: movedAt },
      created,
    ]);
    expect(events[0]).toEqual({
      label: "Alex Sosa moved this ticket from JIRITA (JIR-116) to JIRITA Live (JL-19)",
      timeAgo: formatRelativeTime(movedAt),
    });
  });

  it("each move is its own entry with the identities it had at that moment", async () => {
    const events = await labels([
      { id: "a2", actor_profile_id: "ana", event_type: "ticket_moved", field_name: "project", old_value: "JIRITA Live (JL-19)", new_value: "ABC (ABC-81)", created_at: "2026-10-05T09:00:00Z" },
      { id: "a1", actor_profile_id: "alex", event_type: "ticket_moved", field_name: "project", old_value: "JIRITA (JIR-116)", new_value: "JIRITA Live (JL-19)", created_at: "2026-10-02T15:30:00Z" },
      created,
    ]);
    expect(events.map((e) => e.label)).toEqual([
      "Ana Diaz moved this ticket from JIRITA Live (JL-19) to ABC (ABC-81)",
      "Alex Sosa moved this ticket from JIRITA (JIR-116) to JIRITA Live (JL-19)",
      "Ana Diaz created this ticket",
    ]);
  });

  it("tolerates incomplete legacy rows without breaking Activity", async () => {
    const events = await labels([
      { id: "a3", actor_profile_id: null, event_type: "ticket_moved", field_name: "project", old_value: null, new_value: null, created_at: "2026-10-02T15:30:00Z" },
      { id: "a4", actor_profile_id: "alex", event_type: "ticket_moved", field_name: "project", old_value: null, new_value: "JIRITA Live (JL-19)", created_at: "2026-10-02T15:30:00Z" },
      created,
    ]);
    expect(events.map((e) => e.label)).toEqual([
      "moved this ticket to another project",
      "Alex Sosa moved this ticket to JIRITA Live (JL-19)",
      "Ana Diaz created this ticket",
    ]);
  });

  it("other event types render exactly as before", async () => {
    const events = await labels([
      { id: "b1", actor_profile_id: "alex", event_type: "status_changed", field_name: "status", old_value: "to_do", new_value: "in_progress", created_at: "2026-10-02T15:00:00Z" },
      { id: "b2", actor_profile_id: "alex", event_type: "assignee_changed", field_name: "assignee_profile_id", old_value: "ana", new_value: null, created_at: "2026-10-02T15:00:00Z" },
      { id: "b3", actor_profile_id: "ana", event_type: "added_a_comment", field_name: null, old_value: null, new_value: null, created_at: "2026-10-02T15:00:00Z" },
      created,
    ]);
    expect(events.map((e) => e.label)).toEqual([
      "Alex Sosa changed Status from To Do to In Progress",
      "Alex Sosa unassigned the ticket",
      "Ana Diaz added a comment",
      "Ana Diaz created this ticket",
    ]);
  });
});
