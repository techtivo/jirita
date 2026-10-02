import { beforeEach, describe, expect, it, vi } from "vitest";

// JIR-113 — a Member's Hours Report fetches its entries with
// loadProfileTimeEntriesForRange. This pins the query itself (not just the
// UI) to `logged_by = <the given profile id>` plus the period, so the
// personal report can only ever read the signed-in user's own entries.
interface RecordedQuery {
  table: string;
  eq: [string, unknown][];
  inFilter: [string, unknown[]][];
  gte: [string, unknown][];
  lte: [string, unknown][];
}

const queries: RecordedQuery[] = [];

function builder(table: string) {
  const q: RecordedQuery = { table, eq: [], inFilter: [], gte: [], lte: [] };
  queries.push(q);
  const result = () =>
    table === "ticket_time_entries"
      ? {
          data: [
            { id: "e1", minutes: 45, comment: "c", work_date: "2026-09-10", logged_by: "me", created_at: "2026-09-10T10:00:00Z", ticket_id: "t1" },
          ],
          error: null,
        }
      : { data: { id: "me", first_name: "Michaela", last_name: "Doe", avatar_url: null, updated_at: null }, error: null };
  const chain = {
    select() { return chain; },
    eq(column: string, value: unknown) { q.eq.push([column, value]); return chain; },
    in(column: string, values: unknown[]) { q.inFilter.push([column, values]); return chain; },
    gte(column: string, value: unknown) { q.gte.push([column, value]); return chain; },
    lte(column: string, value: unknown) { q.lte.push([column, value]); return chain; },
    order() { return chain; },
    returns() { return chain; },
    maybeSingle() { return Promise.resolve(result()); },
    then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(result()).then(resolve, reject);
    },
  };
  return chain;
}

vi.mock("./supabase-client", () => ({ getSupabaseBrowserClient: () => ({ from: builder }) }));

const { loadProfileTimeEntriesForRange } = await import("./tickets");

beforeEach(() => {
  queries.length = 0;
});

describe("loadProfileTimeEntriesForRange (Member Hours Report source)", () => {
  it("filters time entries by logged_by = the given profile and by work_date range", async () => {
    const result = await loadProfileTimeEntriesForRange("me", ["t1", "t2"], "2026-09-01", "2026-09-30");
    const entryQueries = queries.filter((q) => q.table === "ticket_time_entries");
    expect(entryQueries.length).toBeGreaterThan(0);
    for (const q of entryQueries) {
      expect(q.eq).toContainEqual(["logged_by", "me"]);
      expect(q.gte).toContainEqual(["work_date", "2026-09-01"]);
      expect(q.lte).toContainEqual(["work_date", "2026-09-30"]);
    }
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.entries.map((e) => [e.ticketId, e.loggedByProfileId, e.minutes])).toEqual([["t1", "me", 45]]);
    }
  });

  it("makes no query at all without accessible tickets", async () => {
    expect(await loadProfileTimeEntriesForRange("me", [], "2026-09-01", "2026-09-30")).toEqual({ status: "ready", entries: [] });
    expect(queries).toHaveLength(0);
  });
});
