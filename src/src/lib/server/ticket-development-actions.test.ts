import { beforeEach, describe, expect, it, vi } from "vitest";

// JIR-116 — Development keeps a moved ticket's GitHub history. Runs the
// real loadTicketDevelopmentActivityAction against fake Supabase clients
// (caller = RLS-scoped, admin = service role) and a fake GitHub API, using
// the real-world history JIR-116 → JL-19 → JIR-117.

type Row = Record<string, unknown>;

const PROJECTS: Row[] = [
  { id: "p-jir", organization_id: "org", project_code: "JIR", repository_provider: "github", repository_url: "https://github.com/techtivo/jirita" },
  { id: "p-jl", organization_id: "org", project_code: "JL", repository_provider: "github", repository_url: "https://github.com/techtivo/jirita-live" },
  { id: "p-oth", organization_id: "org", project_code: "OTH", repository_provider: "github", repository_url: "https://github.com/techtivo/other" },
];
const TICKETS: Row[] = [
  { id: "ticket-x", project_id: "p-jir", ticket_number: 117 },
  { id: "ticket-y", project_id: "p-jir", ticket_number: 11 },
  { id: "ticket-z", project_id: "p-jir", ticket_number: 120 },
];
let ALIASES: Row[] = [];
let CONNECTIONS: Row[] = [];
let visibleProjectIds = new Set<string>();
const fetched: string[] = [];

function fakeClient(tables: Record<string, () => Row[]>) {
  return {
    auth: { getUser: async () => ({ data: { user: { id: "alex" } }, error: null }) },
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = [];
      const run = () => (tables[table]?.() ?? []).filter((r) => filters.every((f) => f(r)));
      const chain = {
        select() { return chain; },
        eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return chain; },
        in(c: string, vs: unknown[]) { filters.push((r) => vs.includes(r[c])); return chain; },
        returns() { return chain; },
        maybeSingle() { return Promise.resolve({ data: run()[0] ?? null, error: null }); },
        then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
          return Promise.resolve({ data: run(), error: null }).then(resolve, reject);
        },
      };
      return chain;
    },
  };
}

vi.mock("./github-repository-connection", () => ({
  consumeBridgeSessionToken: async () => "session-token",
  githubApiHeaders: () => ({}),
  // Caller: RLS — only projects (and their tickets) this user can view.
  getCallerClient: () =>
    fakeClient({
      projects: () => PROJECTS.filter((p) => visibleProjectIds.has(p.id as string)),
      tickets: () => TICKETS.filter((t) => visibleProjectIds.has(t.project_id as string)),
    }),
  // Service role: aliases and repository connections.
  getAdminClient: () =>
    fakeClient({
      ticket_route_aliases: () => ALIASES,
      project_repository_connections: () => CONNECTIONS,
    }),
}));
vi.mock("./github-token-crypto", () => ({ decryptGitHubToken: () => "decrypted" }));

const commit = (sha: string, message: string, date: string) => ({
  sha,
  html_url: `https://github.com/x/commit/${sha}`,
  commit: { message, author: { name: "dev", date } },
  author: { login: "dev", avatar_url: null },
});
const pr = (repo: string, number: number, title: string, head = "main") => ({
  number,
  title,
  body: null,
  state: "open",
  draft: false,
  merged_at: null,
  updated_at: `2026-10-0${number % 9}T10:00:00Z`,
  html_url: `https://github.com/${repo}/pull/${number}`,
  head: { ref: head },
  user: { login: "dev", avatar_url: null },
});

const GITHUB: Record<string, unknown> = {
  "techtivo/jirita/branches": [{ name: "feature/JIR-116-move" }, { name: "JIR-117-fix" }, { name: "JIR-11-unrelated" }, { name: "JIR-1160-other" }, { name: "main" }],
  "techtivo/jirita/pulls": [
    pr("techtivo/jirita", 5, "JIR-116 move tickets", "feature/JIR-116-move"),
    pr("techtivo/jirita", 6, "JIR-117 fix ticket movement", "JIR-117-fix"),
    pr("techtivo/jirita", 7, "JIR-11 unrelated work", "JIR-11-unrelated"),
    pr("techtivo/jirita", 8, "Covers JIR-116 and JIR-117"),
  ],
  "techtivo/jirita/commits?sha=main": [
    commit("aaaaaaa1", "JIR-116 initial movement work", "2026-10-01T10:00:00Z"),
    commit("bbbbbbb2", "JIR-117 fix ticket movement", "2026-10-03T10:00:00Z"),
    commit("ccccccc3", "JIR-11 unrelated", "2026-10-02T10:00:00Z"),
    commit("ddddddd4", "mentions JL-19 but in the wrong repo", "2026-10-02T11:00:00Z"),
  ],
  "techtivo/jirita/commits?sha=feature%2FJIR-116-move": [commit("aaaaaaa1", "JIR-116 initial movement work", "2026-10-01T10:00:00Z")],
  "techtivo/jirita/commits?sha=JIR-117-fix": [commit("bbbbbbb2", "JIR-117 fix ticket movement", "2026-10-03T10:00:00Z")],
  "techtivo/jirita-live/branches": [{ name: "JL-19-live" }],
  "techtivo/jirita-live/pulls": [pr("techtivo/jirita-live", 3, "JL-19 live tweaks", "JL-19-live")],
  "techtivo/jirita-live/commits?sha=main": [commit("eeeeeee5", "JL-19 live fix", "2026-10-02T09:00:00Z")],
  "techtivo/jirita-live/commits?sha=JL-19-live": [commit("eeeeeee5", "JL-19 live fix", "2026-10-02T09:00:00Z")],
};

vi.stubGlobal("fetch", async (url: string) => {
  const key = url.replace("https://api.github.com/repos/", "").replace(/[?&]per_page=\d+/, "").replace("?state=all", "");
  fetched.push(key);
  const body = GITHUB[key];
  return { ok: body !== undefined, status: body !== undefined ? 200 : 404, json: async () => body } as Response;
});

const { loadTicketDevelopmentActivityAction } = await import("./ticket-development-actions");
const { buildTicketCodeMatcher } = await import("./ticket-development-matching");

const connection = (projectId: string, repo: string) => ({
  project_id: projectId,
  provider: "github",
  organization_id: "org",
  access_token_ciphertext: "c",
  access_token_iv: "i",
  access_token_auth_tag: "t",
  repository_full_name: repo,
  repository_default_branch: "main",
  last_verified_at: null,
});

async function load(ticketCode = "JIR-117") {
  const result = await loadTicketDevelopmentActivityAction({ projectId: "p-jir", ticketCode, forceRefresh: true });
  if (result.status !== "ready") return result;
  return {
    status: result.status,
    commits: result.commits.map((c) => c.message),
    pulls: result.pullRequests.map((p) => p.htmlUrl.replace("https://github.com/", "")),
    branches: result.branches.map((b) => b.htmlUrl.replace("https://github.com/", "")),
  };
}

beforeEach(() => {
  fetched.length = 0;
  visibleProjectIds = new Set(["p-jir", "p-jl", "p-oth"]);
  CONNECTIONS = [connection("p-jir", "techtivo/jirita"), connection("p-jl", "techtivo/jirita-live"), connection("p-oth", "techtivo/other")];
  ALIASES = [
    { ticket_id: "ticket-x", project_id: "p-jir", ticket_number: 116 },
    { ticket_id: "ticket-x", project_id: "p-jl", ticket_number: 19 },
  ];
});

describe("Development after moves (JIR-116 → JL-19 → JIR-117)", () => {
  it("shows historical (JIR-116), intermediate (JL-19) and current (JIR-117) work, each once", async () => {
    const r = await load();
    expect(r).toEqual({
      status: "ready",
      commits: ["JIR-117 fix ticket movement", "JL-19 live fix", "JIR-116 initial movement work"],
      pulls: ["techtivo/jirita/pull/8", "techtivo/jirita/pull/6", "techtivo/jirita/pull/5", "techtivo/jirita-live/pull/3"],
      branches: ["techtivo/jirita/tree/feature%2FJIR-116-move", "techtivo/jirita/tree/JIR-117-fix", "techtivo/jirita-live/tree/JL-19-live"],
    });
  });

  it("searches each code only in the repository of the project it belonged to; unrelated repos are never queried", async () => {
    const r = await load();
    if (r.status !== "ready") throw new Error("expected ready");
    expect(r.commits).not.toContain("mentions JL-19 but in the wrong repo");
    expect(fetched.some((k) => k.startsWith("techtivo/other"))).toBe(false);
    // One branches + one pulls request per repository, not per code.
    expect(fetched.filter((k) => k === "techtivo/jirita/branches")).toHaveLength(1);
  });

  it("never picks up another ticket's work (JIR-11, JIR-1160)", async () => {
    const r = await load();
    if (r.status !== "ready") throw new Error("expected ready");
    expect(r.commits).not.toContain("JIR-11 unrelated");
    expect(r.pulls).not.toContain("techtivo/jirita/pull/7");
    expect(r.branches.some((b) => b.includes("JIR-11-unrelated") || b.includes("JIR-1160"))).toBe(false);
  });

  it("a former project the caller can't view adds nothing (no repository exposed)", async () => {
    visibleProjectIds = new Set(["p-jir"]);
    const r = await load();
    if (r.status !== "ready") throw new Error("expected ready");
    expect(r.commits).toEqual(["JIR-117 fix ticket movement", "JIR-116 initial movement work"]);
    expect(fetched.some((k) => k.startsWith("techtivo/jirita-live"))).toBe(false);
  });

  it("a former project without a GitHub connection is simply skipped", async () => {
    CONNECTIONS = [connection("p-jir", "techtivo/jirita")];
    const r = await load();
    if (r.status !== "ready") throw new Error("expected ready");
    expect(r.commits).toEqual(["JIR-117 fix ticket movement", "JIR-116 initial movement work"]);
  });

  it("a ticket that was never moved behaves as before: only its own code", async () => {
    ALIASES = [];
    const r = await load();
    if (r.status !== "ready") throw new Error("expected ready");
    expect(r.commits).toEqual(["JIR-117 fix ticket movement"]);
    expect(r.pulls).toEqual(["techtivo/jirita/pull/8", "techtivo/jirita/pull/6"]);
    expect(r.branches).toEqual(["techtivo/jirita/tree/JIR-117-fix"]);
  });

  it("another ticket (JIR-11) only sees its own work, never the moved ticket's aliases", async () => {
    const r = await load("JIR-11");
    if (r.status !== "ready") throw new Error("expected ready");
    expect(r.commits).toEqual(["JIR-11 unrelated"]);
    expect(r.pulls).toEqual(["techtivo/jirita/pull/7"]);
  });

  it("hidden when the ticket isn't visible to the caller", async () => {
    // A ticket never loaded before (a forced refresh that comes back hidden
    // intentionally keeps an earlier good snapshot of the same ticket).
    visibleProjectIds = new Set();
    expect(await load("JIR-120")).toEqual({ status: "hidden" });
    expect(fetched).toEqual([]);
  });
});

describe("buildTicketCodeMatcher", () => {
  const m = buildTicketCodeMatcher(["JIR-116", "JL-19"]);
  it("matches whole codes, case-insensitively, in messages and branch names", () => {
    for (const text of ["JIR-116 fix", "feature/jir-116-move", "[JIR-116]", "Fixes JL-19.", "jl-19_hotfix"]) expect(m(text)).toBe(true);
  });
  it("does not match longer numbers, prefixed codes, or nothing", () => {
    for (const text of ["JIR-1160", "XJIR-116", "JIR-11", "JIR116", "", null, undefined]) expect(m(text)).toBe(false);
    expect(buildTicketCodeMatcher([])("JIR-116")).toBe(false);
  });
});
