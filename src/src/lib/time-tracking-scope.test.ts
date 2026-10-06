import { describe, expect, it } from "vitest";
import {
  buildLeadTimeTrackingProjectOptions,
  slugsWithAccess,
  selectionIncludesLedProject,
  visibleTimesheetMembers,
  keepOwnEntries,
  countsTowardWorkload,
  workHistoryScopeSlugs,
  ownWorkHistoryHref,
  inPersonBreakdown,
} from "@/lib/time-tracking-scope";

// The reported production scenario: a Project Lead who leads Collab and is
// a regular member of TCFCU and Small Business (lead of neither).
const led = [{ slug: "collab", name: "Collab" }];

// What RLS (projects_select → can_view_project) returns for that profile:
// only projects they're a member of. "Secret" (no membership) is never in
// this list; "Legacy" is an archived project they're still a member of.
const accessible = [
  { slug: "tcfcu", name: "TCFCU", status: "active" },
  { slug: "collab", name: "Collab", status: "active" },
  { slug: "smallbusiness", name: "Small Business", status: "planning" },
  { slug: "legacy", name: "Legacy", status: "archived" },
];

const options = buildLeadTimeTrackingProjectOptions(led, accessible);
const ledSlugs = slugsWithAccess(options, "lead");
const ledSlugSet = new Set(ledSlugs);

describe("Project Lead Time Tracking — project options", () => {
  it("offers led projects plus member-only projects, with zero logged hours anywhere", () => {
    // No time entries are an input at all — options never depend on hours.
    expect(options.map((o) => o.name)).toEqual(["Collab", "Small Business", "TCFCU"]);
  });

  it("keeps lead access on Collab and gives own-only access on TCFCU / Small Business", () => {
    expect(options).toEqual([
      { slug: "collab", name: "Collab", access: "lead" },
      { slug: "smallbusiness", name: "Small Business", access: "own" },
      { slug: "tcfcu", name: "TCFCU", access: "own" },
    ]);
    expect(ledSlugs).toEqual(["collab"]);
    expect(slugsWithAccess(options, "own")).toEqual(["smallbusiness", "tcfcu"]);
  });

  it("never offers an inaccessible project or an archived one", () => {
    expect(options.some((o) => o.slug === "secret")).toBe(false);
    expect(options.some((o) => o.slug === "legacy")).toBe(false);
  });

  it("a Project Lead who leads nothing still gets their member projects, own-only", () => {
    expect(buildLeadTimeTrackingProjectOptions([], accessible).map((o) => [o.slug, o.access])).toEqual([
      ["collab", "own"],
      ["smallbusiness", "own"],
      ["tcfcu", "own"],
    ]);
  });
});

describe("Project Lead Time Tracking — lead privileges stay on led projects", () => {
  const team = [{ id: "ana" }, { id: "miguel" }];
  const self = { id: "miguel" };

  it("shows the led team with no filter or with a led project selected", () => {
    expect(selectionIncludesLedProject([], ledSlugs)).toBe(true);
    expect(visibleTimesheetMembers(team, self, [], ledSlugs)).toBe(team);
    expect(visibleTimesheetMembers(team, self, ["collab"], ledSlugs)).toBe(team);
    expect(visibleTimesheetMembers(team, self, ["collab", "tcfcu"], ledSlugs)).toBe(team);
  });

  it("shows only the Lead's own row when only member-only projects are selected", () => {
    expect(selectionIncludesLedProject(["tcfcu"], ledSlugs)).toBe(false);
    expect(visibleTimesheetMembers(team, self, ["tcfcu"], ledSlugs)).toEqual([self]);
    expect(visibleTimesheetMembers(team, self, ["tcfcu", "smallbusiness"], ledSlugs)).toEqual([self]);
    expect(visibleTimesheetMembers(team, null, ["tcfcu"], ledSlugs)).toEqual([]);
  });

  it("keeps only the Lead's own entries for member-only projects", () => {
    const entries = [
      { ticketId: "t1", loggedBy: "miguel", minutes: 60 },
      { ticketId: "t1", loggedBy: "ana", minutes: 45 },
      { ticketId: "t2", loggedBy: null, minutes: 30 },
    ];
    expect(keepOwnEntries(entries, "miguel")).toEqual([{ ticketId: "t1", loggedBy: "miguel", minutes: 60 }]);
  });

  it("counts workload for anyone on a led project, but only the Lead's own on a member-only one", () => {
    expect(countsTowardWorkload({ projectSlug: "collab", assigneeProfileId: "ana" }, ledSlugSet, "miguel")).toBe(true);
    expect(countsTowardWorkload({ projectSlug: "tcfcu", assigneeProfileId: "miguel" }, ledSlugSet, "miguel")).toBe(true);
    expect(countsTowardWorkload({ projectSlug: "tcfcu", assigneeProfileId: "ana" }, ledSlugSet, "miguel")).toBe(false);
    expect(countsTowardWorkload({ projectSlug: "smallbusiness", assigneeProfileId: null }, ledSlugSet, "miguel")).toBe(false);
  });
});

describe("Project Lead Time Tracking — lead scope follows the real project role, not status", () => {
  // loadLeadProjects({ includeNonActive: true }) — real project_role =
  // 'lead' rows on any non-archived project. The archived one it leads is
  // already excluded there, and stays excluded via the accessible list too.
  const ledAnyStatus = [
    { slug: "collab", name: "Collab" },
    { slug: "holding", name: "Holding" },
    { slug: "planned", name: "Planned" },
  ];
  const accessibleAnyStatus = [
    { slug: "collab", name: "Collab", status: "active" },
    { slug: "planned", name: "Planned", status: "planning" },
    { slug: "holding", name: "Holding", status: "on-hold" },
    { slug: "tcfcu", name: "TCFCU", status: "active" },
    { slug: "paused-member", name: "Paused Member", status: "on-hold" },
    { slug: "old-led", name: "Old Led", status: "archived" },
    { slug: "legacy", name: "Legacy", status: "archived" },
  ];
  const classified = buildLeadTimeTrackingProjectOptions(ledAnyStatus, accessibleAnyStatus);
  const accessOf = (slug: string) => classified.find((o) => o.slug === slug)?.access;

  it("active, planning and on-hold led projects all get lead scope", () => {
    expect(accessOf("collab")).toBe("lead");
    expect(accessOf("planned")).toBe("lead");
    expect(accessOf("holding")).toBe("lead");
  });

  it("member-only projects get own-time scope whatever their status", () => {
    expect(accessOf("tcfcu")).toBe("own");
    expect(accessOf("paused-member")).toBe("own");
  });

  it("archived projects are excluded, led or not", () => {
    expect(accessOf("old-led")).toBeUndefined();
    expect(accessOf("legacy")).toBeUndefined();
    expect(classified).toHaveLength(5);
  });
});

describe("Project Lead Time Tracking — Work History", () => {
  it("own row, one member-only project → that project's own Work History for the signed-in user", () => {
    expect(ownWorkHistoryHref("miguel", ["tcfcu"], ledSlugs)).toBe("/projects/tcfcu/team/miguel/work-history");
    expect(ownWorkHistoryHref("miguel", ["smallbusiness"], ledSlugs)).toBe(
      "/projects/smallbusiness/team/miguel/work-history"
    );
  });

  it("own row, several projects incl. a member-only one → global Work History pre-filtered to the selection", () => {
    expect(ownWorkHistoryHref("miguel", ["tcfcu", "smallbusiness"], ledSlugs)).toBe(
      "/time-tracking/team/miguel/work-history?projects=tcfcu,smallbusiness"
    );
    expect(ownWorkHistoryHref("miguel", ["collab", "tcfcu"], ledSlugs)).toBe(
      "/time-tracking/team/miguel/work-history?projects=collab,tcfcu"
    );
  });

  it("leaves led-project / unfiltered views to the existing resolution", () => {
    expect(ownWorkHistoryHref("miguel", [], ledSlugs)).toBeNull();
    expect(ownWorkHistoryHref("miguel", ["collab"], ledSlugs)).toBeNull();
  });

  it("scopes the viewer's own history to led + member-only projects, anyone else's to led only", () => {
    expect(workHistoryScopeSlugs(options, "miguel", "miguel")).toEqual(["collab", "smallbusiness", "tcfcu"]);
    expect(workHistoryScopeSlugs(options, "ana", "miguel")).toEqual(["collab"]);
    // Never archived / inaccessible, even for the viewer's own history.
    expect(workHistoryScopeSlugs(options, "miguel", "miguel")).not.toContain("legacy");
    expect(workHistoryScopeSlugs(options, "miguel", "miguel")).not.toContain("secret");
  });
});

// Production case (2026-10-06): Miguel leads Collab and is a regular member
// of General, JIRITA, Smallbusiness and TCFCU. Mex is on those four but not
// on Collab. Reports listed all five projects with full team data, Hours
// Report listed only Collab, Time Tracking's Member filter (correctly)
// listed only Collab's team.
describe("Project Lead scope shared by Reports / Hours Report / Time Tracking", () => {
  const miguelLed = [{ slug: "collab", name: "Collab" }];
  const miguelAccessible = [
    { slug: "smallbusiness", name: "Smallbusiness", status: "active" },
    { slug: "general", name: "General", status: "active" },
    { slug: "tcfcu", name: "TCFCU", status: "active" },
    { slug: "collab", name: "Collab", status: "active" },
    { slug: "jirita", name: "JIRITA", status: "active" },
  ];
  const scope = buildLeadTimeTrackingProjectOptions(miguelLed, miguelAccessible);
  const led = new Set(slugsWithAccess(scope, "lead"));

  it("accessible projects: all five, on every screen", () => {
    expect(scope.map((o) => o.slug).sort()).toEqual(["collab", "general", "jirita", "smallbusiness", "tcfcu"]);
  });

  it("team time can be inspected only where he leads", () => {
    expect([...led]).toEqual(["collab"]);
    expect(slugsWithAccess(scope, "own")).toEqual(["general", "jirita", "smallbusiness", "tcfcu"]);
  });

  it("the Member filter is the led team — a colleague from a member-only project is not offered", () => {
    const collabTeam = [{ id: "alejandro" }, { id: "cristian" }, { id: "maria" }, { id: "miguel" }];
    for (const filter of [[], ["collab"], ["collab", "tcfcu"]]) {
      const roster = visibleTimesheetMembers(collabTeam, { id: "miguel" }, filter, [...led]);
      expect(roster.map((m) => m.id)).toEqual(["alejandro", "cristian", "maria", "miguel"]);
      expect(roster.some((m) => m.id === "mex")).toBe(false);
    }
    expect(visibleTimesheetMembers(collabTeam, { id: "miguel" }, ["tcfcu"], [...led])).toEqual([{ id: "miguel" }]);
  });

  it("own time on a member-only project is visible; a colleague's there is not", () => {
    const tcfcuEntries = [
      { ticketId: "t1", loggedBy: "miguel", minutes: 90 },
      { ticketId: "t1", loggedBy: "mex", minutes: 240 },
    ];
    expect(keepOwnEntries(tcfcuEntries, "miguel")).toEqual([{ ticketId: "t1", loggedBy: "miguel", minutes: 90 }]);
  });

  it("per-person breakdowns: every led-project ticket, only his own work elsewhere", () => {
    const ownLogged = new Set(["tcfcu-closed-imported"]);
    const visible = (ticket: { id: string; projectSlug: string; assigneeProfileId?: string | null }) =>
      inPersonBreakdown(ticket, led, "miguel", ownLogged);
    // Led project: anyone's ticket, assigned or not.
    expect(visible({ id: "c1", projectSlug: "collab", assigneeProfileId: "cristian" })).toBe(true);
    expect(visible({ id: "c2", projectSlug: "collab", assigneeProfileId: null })).toBe(true);
    // Member-only project: his own assignment…
    expect(visible({ id: "t2", projectSlug: "tcfcu", assigneeProfileId: "miguel" })).toBe(true);
    // …and any ticket carrying his own logged time, even when it's
    // assigned to someone else (closed / imported / created by anyone).
    expect(visible({ id: "tcfcu-closed-imported", projectSlug: "tcfcu", assigneeProfileId: "mex" })).toBe(true);
    // Never a colleague's work he has no time on.
    expect(visible({ id: "t3", projectSlug: "tcfcu", assigneeProfileId: "mex" })).toBe(false);
    expect(visible({ id: "t4", projectSlug: "general", assigneeProfileId: null })).toBe(false);
  });

  it("a regular Member (leads nothing) never gets team scope from the same rules", () => {
    const memberScope = buildLeadTimeTrackingProjectOptions([], miguelAccessible);
    expect(slugsWithAccess(memberScope, "lead")).toEqual([]);
    expect(memberScope.every((o) => o.access === "own")).toBe(true);
  });
});
