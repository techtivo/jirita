import { beforeEach, describe, expect, it, vi } from "vitest";

// JIR-114 — Work History's Project filter as a multi-select. Runs the real
// summary/page loaders (and so the real computeTeamWorkHistoryRows) against
// an in-memory fake Supabase client, so list and KPIs are checked against
// the same filtered dataset, combined with Search/Status/Activity/period.

type Row = Record<string, unknown>;

const PROJECTS: Row[] = [
  { id: "p-jir", organization_id: "org", slug: "jirita", project_code: "JIR" },
  { id: "p-tfc", organization_id: "org", slug: "tfcu", project_code: "TFC" },
  { id: "p-smb", organization_id: "org", slug: "smallbusiness", project_code: "SMB" },
  // Same display name could exist elsewhere — identity is the slug, never a name.
  { id: "p-sec", organization_id: "org", slug: "secret", project_code: "SEC" },
];

// Participation rows the per-project RPC returns for member "m".
const PARTICIPATION: Record<string, Row[]> = {
  "p-jir": [
    { ticket_id: "j1", ticket_number: 1, title: "Login page", status: "in_progress", priority: "high", hours: 2, activity_count: 1, last_activity_at: "2026-09-10T10:00:00Z" },
    { ticket_id: "j2", ticket_number: 2, title: "Reports", status: "done", priority: "low", hours: 1, activity_count: 0, last_activity_at: "2026-09-02T10:00:00Z" },
  ],
  "p-tfc": [
    { ticket_id: "t1", ticket_number: 7, title: "Login SSO", status: "done", priority: "medium", hours: 1.5, activity_count: 2, last_activity_at: "2026-09-12T10:00:00Z" },
  ],
  "p-smb": [
    { ticket_id: "s1", ticket_number: 3, title: "Invoices", status: "in_progress", priority: "medium", hours: 0.5, activity_count: 0, last_activity_at: "2026-09-05T10:00:00Z" },
  ],
  "p-sec": [
    { ticket_id: "x1", ticket_number: 1, title: "Login secret", status: "done", priority: "high", hours: 9, activity_count: 0, last_activity_at: "2026-09-15T10:00:00Z" },
  ],
};

const TABLES: Record<string, Row[]> = {
  projects: PROJECTS,
  ticket_time_entries: [
    { ticket_id: "j1", logged_by: "m", minutes: 120, work_date: "2026-09-10", created_at: "2026-09-10T10:00:00Z" },
    { ticket_id: "j2", logged_by: "m", minutes: 60, work_date: "2026-08-20", created_at: "2026-08-20T10:00:00Z" },
    { ticket_id: "t1", logged_by: "m", minutes: 90, work_date: "2026-09-12", created_at: "2026-09-12T10:00:00Z" },
    { ticket_id: "s1", logged_by: "m", minutes: 30, work_date: "2026-09-05", created_at: "2026-09-05T10:00:00Z" },
    { ticket_id: "x1", logged_by: "m", minutes: 540, work_date: "2026-09-15", created_at: "2026-09-15T10:00:00Z" },
  ],
  ticket_activity: [
    { ticket_id: "j1", actor_profile_id: "m", event_type: "added_a_comment", created_at: "2026-09-10T11:00:00Z" },
    { ticket_id: "t1", actor_profile_id: "m", event_type: "added_a_comment", created_at: "2026-09-12T11:00:00Z" },
    { ticket_id: "t1", actor_profile_id: "m", event_type: "status_changed", created_at: "2026-09-12T12:00:00Z" },
  ],
};

type Filter = (row: Row) => boolean;

function query(table: string) {
  const filters: Filter[] = [];
  const run = () => ({ data: (TABLES[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null });
  const chain = {
    select() { return chain; },
    eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return chain; },
    in(c: string, vs: unknown[]) { filters.push((r) => vs.includes(r[c])); return chain; },
    gte(c: string, v: string) { filters.push((r) => String(r[c]) >= v); return chain; },
    lte(c: string, v: string) { filters.push((r) => String(r[c]) <= v); return chain; },
    lt(c: string, v: string) { filters.push((r) => String(r[c]) < v); return chain; },
    order() { return chain; },
    returns() { return chain; },
    maybeSingle() { const { data } = run(); return Promise.resolve({ data: data[0] ?? null, error: null }); },
    then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(run()).then(resolve, reject);
    },
  };
  return chain;
}

const rpcCalls: string[] = [];
function rpc(name: string, args: { target_project_id: string }) {
  rpcCalls.push(args.target_project_id);
  const rows = PARTICIPATION[args.target_project_id] ?? [];
  const result = name === "project_member_work_history_summary" ? { ticket_count: rows.length } : rows;
  return {
    maybeSingle: () => Promise.resolve({ data: result, error: null }),
    then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve({ data: result, error: null }).then(resolve, reject);
    },
  };
}

vi.mock("./supabase-client", () => ({ getSupabaseBrowserClient: () => ({ from: query, rpc }) }));

const {
  loadTeamMemberWorkHistorySummaryAcrossProjects: loadSummary,
  loadTeamMemberWorkHistoryPageAcrossProjects: loadPage,
  resolveWorkHistoryScopeSlugs,
} = await import("./tickets");
type Filters = import("./tickets").TeamWorkHistoryFilters;

// The viewer's authorized scope — "secret" is deliberately NOT in it.
const SCOPE = ["jirita", "tfcu", "smallbusiness"];

async function run(filters: Filters) {
  const [summary, page] = await Promise.all([
    loadSummary("org", SCOPE, "m", filters),
    loadPage("org", SCOPE, "m", filters, 1, 50),
  ]);
  if (summary.status !== "ready" || page.status !== "ready") throw new Error("load failed");
  return { summary: summary.summary, keys: page.entries.map((e) => e.ticketKey), entries: page.entries };
}

beforeEach(() => {
  rpcCalls.length = 0;
});

describe("resolveWorkHistoryScopeSlugs", () => {
  it("All projects (no / empty selection) is the whole authorized scope", () => {
    expect(resolveWorkHistoryScopeSlugs(SCOPE)).toEqual(SCOPE);
    expect(resolveWorkHistoryScopeSlugs(SCOPE, [])).toEqual(SCOPE);
  });
  it("narrows to the selected slugs, and never adds one outside the scope", () => {
    expect(resolveWorkHistoryScopeSlugs(SCOPE, ["tfcu"])).toEqual(["tfcu"]);
    expect(resolveWorkHistoryScopeSlugs(SCOPE, ["tfcu", "jirita"])).toEqual(["jirita", "tfcu"]);
    expect(resolveWorkHistoryScopeSlugs(SCOPE, ["secret", "tfcu"])).toEqual(["tfcu"]);
    expect(resolveWorkHistoryScopeSlugs(SCOPE, ["secret"])).toEqual([]);
  });
});

describe("Work History Project multi-select (JIR-114)", () => {
  it("All projects keeps every in-scope project, unrestricted", async () => {
    const { summary, keys } = await run({});
    expect(keys.sort()).toEqual(["JIR-1", "JIR-2", "SMB-3", "TFC-7"]);
    expect(summary.ticketCount).toBe(4);
    expect(summary.totalHours).toBe(5);
    expect(rpcCalls).not.toContain("p-sec");
  });

  it("one project returns only that project", async () => {
    const { summary, keys } = await run({ projectSlugs: ["tfcu"] });
    expect(keys).toEqual(["TFC-7"]);
    expect(summary).toMatchObject({ ticketCount: 1, totalHours: 1.5 });
  });

  it("several projects return their union — KPIs from the same rows, no other project, no duplicates", async () => {
    const { summary, keys, entries } = await run({ projectSlugs: ["jirita", "tfcu"] });
    expect(keys).toEqual(["TFC-7", "JIR-1", "JIR-2"]); // most-recent first
    expect(new Set(keys).size).toBe(keys.length);
    expect(entries.every((e) => e.projectSlug === "jirita" || e.projectSlug === "tfcu")).toBe(true);
    expect(summary.ticketCount).toBe(keys.length);
    expect(summary.totalHours).toBe(4.5);
    expect(summary.totalHours).toBe(entries.reduce((s, e) => s + e.hours, 0));
    expect(summary.lastActivityLabel).not.toBeNull();
  });

  it("a slug outside the authorized scope never adds data", async () => {
    const { keys } = await run({ projectSlugs: ["secret", "tfcu"] });
    expect(keys).toEqual(["TFC-7"]);
    expect(rpcCalls).not.toContain("p-sec");
  });

  it("combines with Search (AND) inside the selected projects", async () => {
    const { keys } = await run({ projectSlugs: ["jirita", "tfcu"], search: "login" });
    expect(keys).toEqual(["TFC-7", "JIR-1"]);
  });

  it("combines with Status", async () => {
    const { keys } = await run({ projectSlugs: ["jirita", "smallbusiness"], status: "in-progress" });
    expect(keys.sort()).toEqual(["JIR-1", "SMB-3"]);
  });

  it("combines with Activity", async () => {
    const { keys, summary } = await run({ projectSlugs: ["jirita", "tfcu", "smallbusiness"], activity: "comments" });
    expect(keys).toEqual(["TFC-7", "JIR-1"]);
    expect(summary.totalHours).toBe(0); // existing semantics: non-time activity reports 0 hours
  });

  it("combines with the period", async () => {
    const { keys, summary } = await run({ projectSlugs: ["jirita", "tfcu"], period: { from: "2026-09-01", to: "2026-09-30" } });
    expect(keys).toEqual(["TFC-7", "JIR-1"]); // JIR-2's only entry is in August
    expect(summary.totalHours).toBe(3.5);
  });

  it("clearing the selection is All projects again", async () => {
    expect((await run({ projectSlugs: [] })).keys.sort()).toEqual((await run({})).keys.sort());
  });
});
