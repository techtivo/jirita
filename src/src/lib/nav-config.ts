import type { Role } from "@/lib/current-user";

export type MainNavKey = "dashboard" | "projects" | "my-work" | "reports" | "time-tracking" | "users";
export type ProjectNavKey = "overview" | "tickets" | "notes" | "team" | "reports" | "settings";

// Order matters: the sidebar renders each role's main nav in this exact
// sequence (a JS Set preserves insertion order), so reordering a role's
// array here reorders its sidebar links too.
// "users" (workspace-wide account management) is Admin-only.
// Member's "reports" (JIR-113) leads only to their personal Hours Report —
// /reports itself redirects a Member there (see ReportsScreen).
// The workspace-wide Settings link was removed outright — JIRITA remains
// single-tenant, so those settings (workspace name, active days, default
// role/capacity) are no longer user-configurable; see PROJECT_STATUS.md.
const MAIN_NAV_BY_ROLE: Record<Role, MainNavKey[]> = {
  ADMIN: ["dashboard", "projects", "my-work", "reports", "time-tracking", "users"],
  PROJECT_LEAD: ["dashboard", "projects", "my-work", "reports", "time-tracking"],
  MEMBER: ["dashboard", "my-work", "projects", "reports"],
};

// Per-project Settings (billing/category, archive, Repository Integration)
// is Admin-only. Project Lead regained the link (Fase 3, configurable
// ticket statuses) but the page itself only ever renders the Statuses
// section for them — every other section stays Admin-only, gated inline
// in project-settings-screen.tsx. A Member never had it.
const PROJECT_NAV_BY_ROLE: Record<Role, ProjectNavKey[]> = {
  ADMIN: ["overview", "tickets", "notes", "team", "reports", "settings"],
  PROJECT_LEAD: ["overview", "tickets", "notes", "team", "reports", "settings"],
  MEMBER: ["overview", "tickets", "notes"],
};

export function mainNavForRole(role: Role): Set<MainNavKey> {
  return new Set(MAIN_NAV_BY_ROLE[role]);
}

export function projectNavForRole(role: Role): Set<ProjectNavKey> {
  return new Set(PROJECT_NAV_BY_ROLE[role]);
}
