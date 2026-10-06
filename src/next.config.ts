import { execFileSync } from "node:child_process";
import type { NextConfig } from "next";

// Commit time of the deployed build as "DDMM-HH:mm", in the commit's own
// recorded UTC offset (git's `--date=format:`) — read from Git at build
// time, never the build/render/browser clock. Returns "" whenever it can't
// be resolved (no SHA, no git binary, no .git, unknown commit, unexpected
// output), so the build never fails and nothing misleading is shown.
function commitTimeLabel(sha: string | undefined): string {
  if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) return "";
  try {
    const out = execFileSync("git", ["show", "-s", "--format=%cd", "--date=format:%d%m-%H:%M", sha], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    return /^\d{4}-\d{2}:\d{2}$/.test(out) ? out : "";
  } catch {
    return "";
  }
}

const nextConfig: NextConfig = {
  experimental: {
    viewTransition: true,
  },
  // Hides the floating dev-tools "N" badge during normal (error-free) dev
  // usage. Next.js still forces it visible on build errors, runtime errors,
  // and warnings regardless of this setting, and it's already a no-op in
  // production builds.
  devIndicators: false,
  // Inlines only the short commit SHA of the deployed build (Vercel sets
  // VERCEL_GIT_COMMIT_SHA at build time) so the Sidebar can show a discreet
  // "Build: <sha>" marker. Falls back to "local" outside Vercel.
  // NEXT_PUBLIC_BUILD_TIME is that same commit's own timestamp (see
  // commitTimeLabel) — "" when unavailable, and always "" for "local".
  env: {
    NEXT_PUBLIC_BUILD_SHA: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || "local",
    NEXT_PUBLIC_BUILD_TIME: commitTimeLabel(process.env.VERCEL_GIT_COMMIT_SHA),
  },
};

export default nextConfig;
