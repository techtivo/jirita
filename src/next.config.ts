import type { NextConfig } from "next";

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
  env: {
    NEXT_PUBLIC_BUILD_SHA: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || "local",
  },
};

export default nextConfig;
