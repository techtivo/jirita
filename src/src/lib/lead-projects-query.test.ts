import { beforeEach, describe, expect, it, vi } from "vitest";

// Pins loadLeadProjects' own query: lead scope always comes from
// project_memberships.project_role = 'lead' for the given profile, and
// `includeNonActive` only ever swaps the project status filter from
// "active" to "not archived" — it never drops the lead test.
interface RecordedQuery {
  table: string;
  eq: [string, unknown][];
  neq: [string, unknown][];
  inFilter: [string, unknown[]][];
}

const queries: RecordedQuery[] = [];

function builder(table: string) {
  const q: RecordedQuery = { table, eq: [], neq: [], inFilter: [] };
  queries.push(q);
  const data =
    table === "project_memberships"
      ? [{ project_id: "p-collab" }, { project_id: "p-planned" }]
      : [{ slug: "collab", name: "Collab", target_date: null }];
  const chain = {
    select() { return chain; },
    eq(column: string, value: unknown) { q.eq.push([column, value]); return chain; },
    neq(column: string, value: unknown) { q.neq.push([column, value]); return chain; },
    in(column: string, values: unknown[]) { q.inFilter.push([column, values]); return chain; },
    order() { return chain; },
    returns() { return Promise.resolve({ data, error: null }); },
  };
  return chain;
}

vi.mock("./supabase-client", () => ({ getSupabaseBrowserClient: () => ({ from: builder }) }));

const { loadLeadProjects } = await import("./projects");

beforeEach(() => {
  queries.length = 0;
});

describe("loadLeadProjects", () => {
  it("default: real lead memberships of this profile, active projects only", async () => {
    const result = await loadLeadProjects("org", "miguel");
    expect(result.status).toBe("ready");
    const [memberships, projects] = queries;
    expect(memberships.table).toBe("project_memberships");
    expect(memberships.eq).toEqual([["profile_id", "miguel"], ["project_role", "lead"]]);
    expect(projects.eq).toEqual([["organization_id", "org"], ["status", "active"]]);
    expect(projects.neq).toEqual([]);
    expect(projects.inFilter).toEqual([["id", ["p-collab", "p-planned"]]]);
  });

  it("includeNonActive: same lead test, only archived projects excluded", async () => {
    await loadLeadProjects("org", "miguel", { includeNonActive: true });
    const [memberships, projects] = queries;
    expect(memberships.eq).toEqual([["profile_id", "miguel"], ["project_role", "lead"]]);
    expect(projects.eq).toEqual([["organization_id", "org"]]);
    expect(projects.neq).toEqual([["status", "archived"]]);
    expect(projects.inFilter).toEqual([["id", ["p-collab", "p-planned"]]]);
  });
});
