import { describe, expect, it, vi } from "vitest";

// Hours attribution audit — Work History (Team → Person → Work History).
// A ticket may appear because the person interacted with it (comment,
// status change, assignment), but their Hours Logged only ever counts their
// own ticket_time_entries (logged_by), summed exactly and rounded once.

type Row = Record<string, unknown>;

const PROJECTS: Row[] = [{ id: "p-a", organization_id: "org", slug: "a", project_code: "ABC" }];

// What the per-project RPC returns for "mex": the RPC's `hours` is its own
// sum(minutes)/60 over logged_by = mex only (see 20260810000000), so it's
// exact and unrounded — e.g. 20m = 0.333…h.
const PARTICIPATION: Row[] = [
  // Mex only commented / changed status here — Ana logged the time.
  { ticket_id: "t1", ticket_number: 123, title: "Commented only", status: "in_progress", priority: "high", hours: 0, activity_count: 2, last_activity_at: "2026-09-10T10:00:00Z" },
  { ticket_id: "t2", ticket_number: 2, title: "Own 20m", status: "done", priority: "low", hours: 20 / 60, activity_count: 1, last_activity_at: "2026-09-09T10:00:00Z" },
  { ticket_id: "t3", ticket_number: 3, title: "Own 20m", status: "done", priority: "low", hours: 20 / 60, activity_count: 1, last_activity_at: "2026-09-08T10:00:00Z" },
  { ticket_id: "t4", ticket_number: 4, title: "Own 20m", status: "done", priority: "low", hours: 20 / 60, activity_count: 1, last_activity_at: "2026-09-07T10:00:00Z" },
];

const TABLES: Record<string, Row[]> = {
  projects: PROJECTS,
  ticket_time_entries: [
    { ticket_id: "t1", logged_by: "ana", minutes: 120, work_date: "2026-09-10", created_at: "2026-09-10T10:00:00Z" },
    { ticket_id: "t2", logged_by: "mex", minutes: 20, work_date: "2026-09-09", created_at: "2026-09-09T10:00:00Z" },
    { ticket_id: "t3", logged_by: "mex", minutes: 20, work_date: "2026-09-08", created_at: "2026-09-08T10:00:00Z" },
    { ticket_id: "t4", logged_by: "mex", minutes: 20, work_date: "2026-09-07", created_at: "2026-09-07T10:00:00Z" },
  ],
  ticket_activity: [
    { ticket_id: "t1", actor_profile_id: "mex", event_type: "added_a_comment", created_at: "2026-09-10T11:00:00Z" },
    { ticket_id: "t1", actor_profile_id: "mex", event_type: "status_changed", created_at: "2026-09-10T12:00:00Z" },
    { ticket_id: "t2", actor_profile_id: "mex", event_type: "time_logged", created_at: "2026-09-09T10:00:00Z" },
    { ticket_id: "t3", actor_profile_id: "mex", event_type: "time_logged", created_at: "2026-09-08T10:00:00Z" },
    { ticket_id: "t4", actor_profile_id: "mex", event_type: "time_logged", created_at: "2026-09-07T10:00:00Z" },
  ],
};

function query(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
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

function rpc(name: string) {
  const result = name === "project_member_work_history_summary" ? { ticket_count: PARTICIPATION.length } : PARTICIPATION;
  return {
    maybeSingle: () => Promise.resolve({ data: result, error: null }),
    then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve({ data: result, error: null }).then(resolve, reject);
    },
  };
}

vi.mock("./supabase-client", () => ({ getSupabaseBrowserClient: () => ({ from: query, rpc }) }));

const { loadTeamMemberWorkHistorySummaryAcrossProjects: loadSummary, loadTeamMemberWorkHistoryPageAcrossProjects: loadPage } =
  await import("./tickets");
type Filters = import("./tickets").TeamWorkHistoryFilters;

async function run(filters: Filters) {
  const [summary, page] = await Promise.all([loadSummary("org", ["a"], "mex", filters), loadPage("org", ["a"], "mex", filters, 1, 50)]);
  if (summary.status !== "ready" || page.status !== "ready") throw new Error("load failed");
  return { summary: summary.summary, hoursByKey: Object.fromEntries(page.entries.map((e) => [e.ticketKey, e.hours])) };
}

describe("Work History hours attribution", () => {
  it("a ticket Mex only commented on / changed status on appears with 0h — Ana's 2h never count for Mex", async () => {
    for (const filters of [{}, { period: { from: "2026-09-01", to: "2026-09-30" } }] as Filters[]) {
      const { summary, hoursByKey } = await run(filters);
      expect(hoursByKey["ABC-123"]).toBe(0);
      expect(summary.ticketCount).toBe(4);
      expect(summary.totalHours).toBe(1); // only Mex's own 3 × 20m
    }
  });

  it("totals sum exact minutes (3 × 20m = 1h), not per-ticket rounded 0.3 × 3 = 0.9", async () => {
    const all = await run({});
    expect(all.summary.totalHours).toBe(1);
    expect(all.hoursByKey["ABC-2"]).toBe(0.3); // per-row display precision unchanged
    const inPeriod = await run({ period: { from: "2026-09-01", to: "2026-09-30" } });
    expect(inPeriod.summary.totalHours).toBe(1);
  });

  it("Activity = Comments keeps the commented ticket but reports 0 hours (existing semantics)", async () => {
    const { summary, hoursByKey } = await run({ activity: "comments" });
    expect(Object.keys(hoursByKey)).toEqual(["ABC-123"]);
    expect(summary.totalHours).toBe(0);
  });
});
