"use server";

// Server Action backing Ticket Detail's "Development" section — real
// GitHub branches/commits/pull requests related to one ticket, matched
// solely by its ticket codes (e.g. "JIR-8"), read-only. JIR-116: that is
// the current code plus every code the ticket had before being moved
// (ticket_route_aliases), each searched in the repository of the project
// it belonged to — see ticket-development-matching.ts. Reuses the
// existing GitHub OAuth infrastructure (lib/server/github-repository-
// connection.ts, github-token-crypto.ts) without modifying either file.
//
// Auth: the Supabase JWT is never a parameter here — same reasoning (and
// the exact same short-lived cookie mechanism) github-repository-
// connection-actions.ts already established: a Server Action's own
// arguments are visible in Next.js's dev-time Server Action logging, so
// the token is bridged via consumeBridgeSessionToken() instead. Ticket
// Detail's own client code sets that cookie right before calling this,
// mirroring project-settings-screen.tsx's bridgeGithubSession() exactly.
//
// Authorization: project/ticket access is re-verified using the CALLER's
// own Supabase client (anon key + their bearer token), so `projects_select`/
// `tickets_select`'s existing real RLS (can_view_project) decides what's
// visible — never a second, hand-written permission model, and never
// trusts projectId/ticketCode blindly (a ticket row only ever comes back
// for a ticket that genuinely exists in that exact project). Only once
// that's confirmed does anything escalate to the service-role client, and
// only to read project_repository_connections (which has no grant for
// `authenticated` at all) and decrypt its token.

import {
  consumeBridgeSessionToken,
  getAdminClient,
  getCallerClient,
  githubApiHeaders,
} from "./github-repository-connection";
import { decryptGitHubToken } from "./github-token-crypto";
import {
  buildTicketCodeMatcher,
  matchBranches,
  matchCommits,
  matchPullRequests,
  mergeDevelopmentMatches,
  type GithubBranchApiRow,
  type GithubCommitApiRow,
  type GithubPullRequestApiRow,
  type RepositoryDevelopmentMatches,
} from "./ticket-development-matching";

function logDev(...args: unknown[]): void {
  if (process.env.NODE_ENV !== "production") console.warn("[ticket-development]", ...args);
}

// ── Safe DTOs ────────────────────────────────────────────────────────────
// Never a GitHub access token, ciphertext/IV/auth tag, scopes, OAuth code,
// raw headers, or a full GitHub API response — only these hand-picked
// fields ever leave this file.

export interface DevelopmentBranch {
  name: string;
  htmlUrl: string;
}

export interface DevelopmentCommit {
  shaShort: string;
  message: string;
  authorName: string;
  authorAvatar: string | null;
  authoredAt: string;
  htmlUrl: string;
}

export type DevelopmentPullRequestState = "open" | "draft" | "merged" | "closed";

export interface DevelopmentPullRequest {
  number: number;
  title: string;
  state: DevelopmentPullRequestState;
  isDraft: boolean;
  merged: boolean;
  authorName: string;
  authorAvatar: string | null;
  updatedAt: string;
  htmlUrl: string;
  headBranch: string;
}

// The section either has real data to show, or it doesn't exist as far as
// the UI is concerned — "hidden" deliberately collapses every reason
// (no connection, needs-reconnect, GitHub error, no matches, no access)
// into one outcome, matching this feature's own rule that Development
// never renders an empty state or a technical error inside a ticket.
export type TicketDevelopmentResult =
  | { status: "ready"; branches: DevelopmentBranch[]; commits: DevelopmentCommit[]; pullRequests: DevelopmentPullRequest[] }
  | { status: "hidden" };

const GITHUB_PAGE_SIZE = 100;

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  expiresAt: number;
  result: TicketDevelopmentResult;
}

// Server-process-local cache, keyed by projectId+ticketCode — 5 minutes,
// per this feature's own spec. Not a distributed cache (no new dependency
// added for one), acceptable at this app's scale, same convention as
// github-repository-connection-actions.ts's own in-flight verification map.
const developmentCache = new Map<string, CacheEntry>();
const inFlightRequests = new Map<string, Promise<TicketDevelopmentResult>>();

function cacheKey(projectId: string, ticketCode: string): string {
  return `${projectId}:${ticketCode.trim().toLowerCase()}`;
}

export interface LoadTicketDevelopmentActivityParams {
  projectId: string;
  ticketCode: string;
  /** Set only by Development's manual "Refresh" action — skips this exact
   *  cache entry (never any other project/ticket's) and re-checks GitHub
   *  immediately. The cache key itself is always rebuilt server-side from
   *  projectId/ticketCode below; the client can never supply an arbitrary
   *  key. Every validation (session/organization/project+ticket access/
   *  GitHub connection) still runs in full on every forced check, exactly
   *  as it does on a normal one — this flag only ever affects the cache
   *  read/write below, nothing about authorization. */
  forceRefresh?: boolean;
}

export async function loadTicketDevelopmentActivityAction(
  params: LoadTicketDevelopmentActivityParams
): Promise<TicketDevelopmentResult> {
  const key = cacheKey(params.projectId, params.ticketCode);

  if (!params.forceRefresh) {
    const cached = developmentCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.result;
  }

  const existing = inFlightRequests.get(key);
  if (existing) return existing;

  const promise = computeTicketDevelopmentActivity(params, key);
  inFlightRequests.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlightRequests.delete(key);
  }
}

async function computeTicketDevelopmentActivity(
  params: LoadTicketDevelopmentActivityParams,
  key: string
): Promise<TicketDevelopmentResult> {
  const result = await resolveTicketDevelopmentActivity(params);

  // A forced manual refresh that comes back "hidden" (a transient GitHub
  // error, a momentary connection hiccup) never overwrites a previously
  // good "ready" snapshot still sitting in the cache for this exact key —
  // the whole point of Refresh is to get fresher data, never to make
  // already-correct data disappear because of one failed attempt. TTL
  // itself is untouched either way (the kept entry's original expiresAt is
  // left as-is, never extended). A normal (non-forced) check always writes
  // through exactly as before.
  if (params.forceRefresh && result.status === "hidden") {
    const previous = developmentCache.get(key);
    if (previous && previous.result.status === "ready") {
      return previous.result;
    }
  }

  // Only a real "ready" result (or a confirmed "hidden") is cached — an
  // in-flight request that later fails is simply not memoized here, since
  // resolveTicketDevelopmentActivity itself never throws (every branch
  // below returns a value), so this always has something real to cache.
  developmentCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, result });
  return result;
}

async function resolveTicketDevelopmentActivity(
  params: LoadTicketDevelopmentActivityParams
): Promise<TicketDevelopmentResult> {
  const accessToken = await consumeBridgeSessionToken();
  if (!accessToken) return { status: "hidden" };

  const caller = getCallerClient(accessToken);
  const { data: callerData, error: callerAuthError } = await caller.auth.getUser(accessToken);
  if (callerAuthError || !callerData.user) return { status: "hidden" };

  // RLS-scoped read (projects_select → can_view_project) — a row only
  // comes back if this profile can really view this project; never a
  // second, hand-rolled permission check duplicating that policy.
  const { data: projectRow, error: projectError } = await caller
    .from("projects")
    .select("id, organization_id, project_code, repository_provider, repository_url")
    .eq("id", params.projectId)
    .maybeSingle<{
      id: string;
      organization_id: string;
      project_code: string;
      repository_provider: string | null;
      repository_url: string | null;
    }>();

  if (projectError || !projectRow) return { status: "hidden" };
  if (projectRow.repository_provider !== "github" || !projectRow.repository_url) {
    return { status: "hidden" };
  }

  // Never trusts ticketCode blindly — parses it the same
  // "<project_code>-<ticket_number>" way lib/tickets.ts's own
  // loadTicketByCode does, then confirms a real ticket row exists (RLS-
  // scoped the same way as the project lookup above).
  const prefix = `${projectRow.project_code}-`;
  if (!params.ticketCode.toUpperCase().startsWith(prefix.toUpperCase())) return { status: "hidden" };
  const ticketNumber = Number(params.ticketCode.slice(prefix.length));
  if (!Number.isInteger(ticketNumber) || ticketNumber <= 0) return { status: "hidden" };

  const { data: ticketRow, error: ticketError } = await caller
    .from("tickets")
    .select("id")
    .eq("project_id", projectRow.id)
    .eq("ticket_number", ticketNumber)
    .maybeSingle<{ id: string }>();

  if (ticketError || !ticketRow) return { status: "hidden" };

  // From here on, service-role only — project_repository_connections has
  // no grant for `authenticated` at all (see
  // 20260821000000_add_project_repository_connections.sql), and neither
  // does ticket_route_aliases (20261003000000) — so this is the only way to
  // read them, same as every real read/write in
  // github-repository-connection-actions.ts.
  const admin = getAdminClient();

  // JIR-116 — every identity this ticket has had, grouped by the project it
  // belonged to: the current code (this project) plus each code it left
  // behind when moved. A former project is only included when the CALLER
  // can still view it (RLS-scoped read) — finding older codes never widens
  // which repositories this user sees.
  const codesByProjectId = new Map<string, { project: typeof projectRow; codes: Set<string> }>();
  codesByProjectId.set(projectRow.id, { project: projectRow, codes: new Set([params.ticketCode]) });

  const { data: aliasRows, error: aliasError } = await admin
    .from("ticket_route_aliases")
    .select("project_id, ticket_number")
    .eq("ticket_id", ticketRow.id)
    .returns<{ project_id: string; ticket_number: number }[]>();
  if (aliasError) {
    // e.g. before the aliases migration exists — the current code still works.
    logDev("ticket aliases lookup failed", aliasError.message);
  }
  const aliases = aliasError ? [] : aliasRows ?? [];
  const formerProjectIds = Array.from(new Set(aliases.map((a) => a.project_id).filter((id) => id !== projectRow.id)));
  const visibleFormerProjects = new Map<string, typeof projectRow>();
  if (formerProjectIds.length > 0) {
    const { data: rows, error } = await caller
      .from("projects")
      .select("id, organization_id, project_code, repository_provider, repository_url")
      .in("id", formerProjectIds)
      .returns<(typeof projectRow)[]>();
    if (error) logDev("former projects lookup failed", error.message);
    for (const row of rows ?? []) {
      if (row.organization_id === projectRow.organization_id) visibleFormerProjects.set(row.id, row);
    }
  }
  for (const alias of aliases) {
    const project = alias.project_id === projectRow.id ? projectRow : visibleFormerProjects.get(alias.project_id);
    if (!project) continue;
    const group = codesByProjectId.get(project.id) ?? { project, codes: new Set<string>() };
    group.codes.add(`${project.project_code}-${alias.ticket_number}`);
    codesByProjectId.set(project.id, group);
  }

  // One GitHub repository per project (when connected); two projects on the
  // same repository are searched once with both projects' codes.
  const repositories = new Map<string, { token: string; defaultBranch: string | null; codes: Set<string> }>();
  for (const { project, codes } of codesByProjectId.values()) {
    if (project.repository_provider !== "github" || !project.repository_url) continue;

    const { data: connectionRow, error: connectionError } = await admin
      .from("project_repository_connections")
      .select("organization_id, access_token_ciphertext, access_token_iv, access_token_auth_tag, repository_full_name, repository_default_branch, last_verified_at")
      .eq("project_id", project.id)
      .eq("provider", "github")
      .maybeSingle<{
        organization_id: string;
        access_token_ciphertext: string;
        access_token_iv: string;
        access_token_auth_tag: string;
        repository_full_name: string | null;
        repository_default_branch: string | null;
        last_verified_at: string | null;
      }>();

    if (connectionError || !connectionRow || !connectionRow.repository_full_name) continue;
    // Defense in depth — should be structurally impossible (both derived
    // from the same real project row), never trusted blindly.
    if (connectionRow.organization_id !== projectRow.organization_id) continue;

    const existing = repositories.get(connectionRow.repository_full_name);
    if (existing) {
      for (const code of codes) existing.codes.add(code);
      continue;
    }

    let token: string;
    try {
      token = decryptGitHubToken({
        ciphertext: connectionRow.access_token_ciphertext,
        iv: connectionRow.access_token_iv,
        authTag: connectionRow.access_token_auth_tag,
      });
    } catch (err) {
      logDev("token decrypt failed", err instanceof Error ? err.message : "unknown error");
      continue;
    }
    repositories.set(connectionRow.repository_full_name, {
      token,
      defaultBranch: connectionRow.repository_default_branch,
      codes: new Set(codes),
    });
  }

  if (repositories.size === 0) return { status: "hidden" };

  const repoMatches = await Promise.all(
    Array.from(repositories.entries()).map(([fullName, repo]) => loadRepositoryMatches(fullName, repo))
  );
  const found = repoMatches.filter((m): m is RepositoryDevelopmentMatches => m !== null);
  if (found.length === 0) return { status: "hidden" };

  const { branches, commits, pullRequests } = mergeDevelopmentMatches(found);
  if (branches.length === 0 && commits.length === 0 && pullRequests.length === 0) {
    return { status: "hidden" };
  }

  return { status: "ready", branches, commits, pullRequests };
}

// One repository, all of this ticket's codes that belong to it. Returns
// null when the repository can't be read (401/403/404, network, parse) —
// the caller hides the section only if no repository could be read.
async function loadRepositoryMatches(
  fullName: string,
  repo: { token: string; defaultBranch: string | null; codes: Set<string> }
): Promise<RepositoryDevelopmentMatches | null> {
  const headers = githubApiHeaders(repo.token);
  const matches = buildTicketCodeMatcher(Array.from(repo.codes));

  let branchesRes: Response, pullsRes: Response;
  try {
    [branchesRes, pullsRes] = await Promise.all([
      fetch(`https://api.github.com/repos/${fullName}/branches?per_page=${GITHUB_PAGE_SIZE}`, { headers }),
      fetch(`https://api.github.com/repos/${fullName}/pulls?state=all&per_page=${GITHUB_PAGE_SIZE}`, { headers }),
    ]);
  } catch (err) {
    logDev("github request failed", err instanceof Error ? err.message : "network error");
    return null;
  }

  // Status codes only, never the response body.
  if (!branchesRes.ok || !pullsRes.ok) {
    logDev("github api error", { branches: branchesRes.status, pulls: pullsRes.status });
    return null;
  }

  let branchRows: GithubBranchApiRow[];
  let pullRows: GithubPullRequestApiRow[];
  try {
    [branchRows, pullRows] = (await Promise.all([branchesRes.json(), pullsRes.json()])) as [
      GithubBranchApiRow[],
      GithubPullRequestApiRow[],
    ];
  } catch (err) {
    logDev("github response parse failed", err instanceof Error ? err.message : "parse error");
    return null;
  }

  const branchNames = matchBranches(branchRows, matches);

  // Commits related to the ticket can still exist only on an unmerged
  // feature branch — GitHub's default (no `sha`) /commits endpoint only
  // ever returns the default branch's own history. Query each related
  // branch plus the repository's real default branch (never "main"/"master"
  // assumed), deduped by name so the same ref is never requested twice.
  const commitRefs = Array.from(new Set([...branchNames, ...(repo.defaultBranch ? [repo.defaultBranch] : [])]));

  const commitResponses = await Promise.allSettled(
    commitRefs.map((ref) =>
      fetch(`https://api.github.com/repos/${fullName}/commits?sha=${encodeURIComponent(ref)}&per_page=${GITHUB_PAGE_SIZE}`, {
        headers,
      })
    )
  );

  const commits: GithubCommitApiRow[] = [];
  for (const settled of commitResponses) {
    // A single deleted/unreadable branch never hides what other refs found.
    if (settled.status !== "fulfilled") {
      logDev("commit request failed for one branch", settled.reason instanceof Error ? settled.reason.message : "network error");
      continue;
    }
    const res = settled.value;
    if (!res.ok) {
      logDev("commit fetch returned non-ok status for one branch", res.status);
      continue;
    }
    try {
      commits.push(...matchCommits((await res.json()) as GithubCommitApiRow[], matches));
    } catch (err) {
      logDev("commit response parse failed for one branch", err instanceof Error ? err.message : "parse error");
    }
  }

  return { fullName, branchNames, commits, pullRequests: matchPullRequests(pullRows, matches) };
}
