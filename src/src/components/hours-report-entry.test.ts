import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Role } from "@/lib/current-user";

// JIR-119 role regression — /reports/hours renders the new personal
// timesheet for a MEMBER and the existing administrative Hours Report for
// everyone else. Both screens are stubbed: this pins which one is mounted.
let role: Role = "MEMBER";

vi.mock("@/components/current-user-provider", () => ({
  useCurrentUser: () => ({ user: { role } }),
}));
vi.mock("@/components/hours-report-screen", () => ({ HoursReportScreen: () => "ADMINISTRATIVE_HOURS_REPORT" }));
vi.mock("@/components/member-hours-report-screen", () => ({ MemberHoursReportScreen: () => "MEMBER_TIMESHEET" }));

const { HoursReportEntry } = await import("@/components/hours-report-entry");

function renderFor(nextRole: Role): string {
  role = nextRole;
  return renderToStaticMarkup(createElement(HoursReportEntry));
}

describe("Reports → Hours entry by role", () => {
  it("MEMBER gets the JIR-119 timesheet", () => {
    expect(renderFor("MEMBER")).toBe("MEMBER_TIMESHEET");
  });

  it("PROJECT_LEAD keeps the administrative Hours Report", () => {
    expect(renderFor("PROJECT_LEAD")).toBe("ADMINISTRATIVE_HOURS_REPORT");
  });

  it("ADMIN keeps the administrative Hours Report", () => {
    expect(renderFor("ADMIN")).toBe("ADMINISTRATIVE_HOURS_REPORT");
  });
});
