// Pure matching/merging for Ticket Detail's Development section
// (ticket-development-actions.ts) — kept out of that "use server" file so
// it can be unit-tested and so non-async helpers can be exported.
//
// JIR-116: a ticket can have several codes over its life (its current one
// plus every identity it left behind when moved — ticket_route_aliases),
// each belonging to the project it had at the time, and each project has
// its own GitHub repository. Development matches every code against the
// repository of the project that code belonged to, then merges the
// results, so a commit/PR/branch shows once no matter how many codes or
// repositories it was found through.

import type { DevelopmentBranch, DevelopmentCommit, DevelopmentPullRequest, DevelopmentPullRequestState } from "./ticket-development-actions";

export const MAX_BRANCHES = 5;
export const MAX_COMMITS = 10;
export const MAX_PULL_REQUESTS = 10;

export interface GithubBranchApiRow {
  name?: string;
}

export interface GithubCommitApiRow {
  sha?: string;
  html_url?: string;
  commit?: { message?: string; author?: { name?: string; date?: string } };
  author?: { login?: string; avatar_url?: string } | null;
}

export interface GithubPullRequestApiRow {
  number?: number;
  title?: string;
  body?: string | null;
  state?: string;
  draft?: boolean;
  merged_at?: string | null;
  updated_at?: string;
  html_url?: string;
  head?: { ref?: string };
  user?: { login?: string; avatar_url?: string } | null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// True when `text` mentions any of `codes` as a whole ticket code
// (case-insensitive): "JIR-116" matches "JIR-116 fix", "feature/jir-116-x"
// or "[JIR-116]", but never "JIR-1160" or "XJIR-116" — so ticket JIR-11
// never picks up JIR-116's work.
export function buildTicketCodeMatcher(codes: string[]): (text: string | null | undefined) => boolean {
  const unique = Array.from(new Set(codes.map((c) => c.trim()).filter(Boolean)));
  if (unique.length === 0) return () => false;
  const pattern = new RegExp(`(?<![A-Za-z0-9])(?:${unique.map(escapeRegExp).join("|")})(?![0-9])`, "i");
  return (text) => typeof text === "string" && pattern.test(text);
}

export function matchBranches(rows: GithubBranchApiRow[], matches: (text: string) => boolean): string[] {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => row.name)
    .filter((name): name is string => typeof name === "string" && matches(name))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_BRANCHES);
}

export function matchPullRequests(rows: GithubPullRequestApiRow[], matches: (text: string) => boolean): GithubPullRequestApiRow[] {
  return (Array.isArray(rows) ? rows : []).filter(
    (row) => matches(row.title ?? "") || matches(row.body ?? "") || matches(row.head?.ref ?? "")
  );
}

export function matchCommits(rows: GithubCommitApiRow[], matches: (text: string) => boolean): GithubCommitApiRow[] {
  return (Array.isArray(rows) ? rows : []).filter((row) => typeof row.commit?.message === "string" && matches(row.commit.message));
}

function pullRequestDisplayState(row: GithubPullRequestApiRow): DevelopmentPullRequestState {
  if (row.merged_at) return "merged";
  if (row.state === "open" && row.draft) return "draft";
  if (row.state === "open") return "open";
  return "closed";
}

export interface RepositoryDevelopmentMatches {
  fullName: string;
  branchNames: string[];
  commits: GithubCommitApiRow[];
  pullRequests: GithubPullRequestApiRow[];
}

// Merges every repository's matches into the section's DTOs: deduped
// (branches and PRs by their GitHub URL, i.e. repository + name/number;
// commits by full SHA), sorted, and capped exactly as before.
export function mergeDevelopmentMatches(repos: RepositoryDevelopmentMatches[]): {
  branches: DevelopmentBranch[];
  commits: DevelopmentCommit[];
  pullRequests: DevelopmentPullRequest[];
} {
  const branchesByUrl = new Map<string, DevelopmentBranch>();
  const commitsBySha = new Map<string, { row: GithubCommitApiRow; fullName: string }>();
  const pullsByUrl = new Map<string, { row: GithubPullRequestApiRow; fullName: string }>();

  for (const repo of repos) {
    for (const name of repo.branchNames) {
      const htmlUrl = `https://github.com/${repo.fullName}/tree/${encodeURIComponent(name)}`;
      if (!branchesByUrl.has(htmlUrl)) branchesByUrl.set(htmlUrl, { name, htmlUrl });
    }
    for (const row of repo.commits) {
      if (!row.sha || commitsBySha.has(row.sha)) continue;
      commitsBySha.set(row.sha, { row, fullName: repo.fullName });
    }
    for (const row of repo.pullRequests) {
      const htmlUrl = row.html_url ?? `https://github.com/${repo.fullName}/pull/${row.number ?? ""}`;
      if (!pullsByUrl.has(htmlUrl)) pullsByUrl.set(htmlUrl, { row, fullName: repo.fullName });
    }
  }

  const branches = Array.from(branchesByUrl.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_BRANCHES);

  const commits: DevelopmentCommit[] = Array.from(commitsBySha.values())
    .sort((a, b) => new Date(b.row.commit?.author?.date ?? 0).getTime() - new Date(a.row.commit?.author?.date ?? 0).getTime())
    .slice(0, MAX_COMMITS)
    .map(({ row, fullName }) => ({
      shaShort: (row.sha ?? "").slice(0, 7),
      message: row.commit?.message ?? "",
      authorName: row.author?.login ?? row.commit?.author?.name ?? "Unknown",
      authorAvatar: row.author?.avatar_url ?? null,
      authoredAt: row.commit?.author?.date ?? new Date(0).toISOString(),
      htmlUrl: row.html_url ?? `https://github.com/${fullName}/commit/${row.sha ?? ""}`,
    }));

  const pullRequests: DevelopmentPullRequest[] = Array.from(pullsByUrl.entries())
    .sort(([, a], [, b]) => new Date(b.row.updated_at ?? 0).getTime() - new Date(a.row.updated_at ?? 0).getTime())
    .slice(0, MAX_PULL_REQUESTS)
    .map(([htmlUrl, { row }]) => ({
      number: row.number ?? 0,
      title: row.title ?? "",
      state: pullRequestDisplayState(row),
      isDraft: Boolean(row.draft),
      merged: Boolean(row.merged_at),
      authorName: row.user?.login ?? "Unknown",
      authorAvatar: row.user?.avatar_url ?? null,
      updatedAt: row.updated_at ?? new Date(0).toISOString(),
      htmlUrl,
      headBranch: row.head?.ref ?? "",
    }));

  return { branches, commits, pullRequests };
}
