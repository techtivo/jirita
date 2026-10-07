import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Role } from "@/lib/current-user";

// JIR-120 — what an Admin / Project Lead sees the moment Reports → Hours
// opens, before any data has loaded (a server render runs no effects, so no
// query is made).
let role: Role = "ADMIN";

// The URL the page was opened with.
let query = "";
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(query),
  usePathname: () => "/reports/hours",
}));

vi.mock("@/components/current-user-provider", () => ({
  useCurrentUser: () => ({
    user: { role, name: "Alex Sosa", avatar: "", financialAccess: false },
    organization: { id: "org", activeDays: [1, 2, 3, 4, 5] },
    userId: "me",
  }),
}));

const { HoursReportScreen } = await import("@/components/hours-report-screen");

describe("administrative Hours Report — initial view", () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 7, 12, 0, 0)); // Wednesday, Oct 7, 2026 (local)
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it("restores period, day and People from the URL (a browser refresh)", () => {
    role = "ADMIN";
    query = "week=2026-09-28&day=2026-10-02&projects=lendingpoint&people=juan";
    const html = renderToStaticMarkup(createElement(HoursReportScreen));
    query = "";

    expect(html).toContain("28 Sep – 4 Oct");
    expect(html).not.toMatch(/aria-pressed="true"[^>]*>This Week</);
    const selected = (html.match(/<button[^>]*aria-label="[A-Za-z]+day, [A-Za-z]+ \d+, 2026[^"]*"/g) ?? []).filter((d) =>
      d.includes('aria-pressed="true"')
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]).toContain("Friday, October 2, 2026");
    expect(html).toContain(">Friday, October 2, 2026</h2>");
    // Selected, pending validation against the viewer's own scope once data loads.
    expect(html).toContain("People: 1 person");
  });

  it("restores a month view from the URL", () => {
    role = "PROJECT_LEAD";
    query = "period=last-month";
    const html = renderToStaticMarkup(createElement(HoursReportScreen));
    query = "";
    expect(html).toContain("September 2026");
    expect(html).toMatch(/aria-pressed="true"[^>]*>Last Month</);
    expect(html).toContain("Month summary");
    expect(html).toContain("Select a day to see its logged hours.");
  });

  for (const viewer of ["ADMIN", "PROJECT_LEAD"] as const) {
    it(`${viewer}: opens on This Week with today selected, keeping Projects, People, PDF and Excel`, () => {
      role = viewer;
      const html = renderToStaticMarkup(createElement(HoursReportScreen));

      expect(html).toContain("5 Oct – 11 Oct");
      for (const label of ["This Week", "This Month", "Last Month", "Custom Range"]) expect(html).toContain(label);
      expect(html).not.toContain("This Quarter");
      expect(html).toMatch(/aria-pressed="true"[^>]*>This Week</);

      const days = html.match(/<button[^>]*aria-label="[A-Za-z]+day, October \d+, 2026[^"]*"/g) ?? [];
      expect(days).toHaveLength(7);
      const selected = days.filter((d) => d.includes('aria-pressed="true"'));
      expect(selected).toHaveLength(1);
      expect(selected[0]).toContain("Wednesday, October 7, 2026, today");
      expect(html).toContain(">Wednesday, October 7, 2026</h2>");

      expect(html).toContain("Projects:");
      expect(html).toContain("People: All people");
      expect(html).toContain("Download PDF");
      expect(html).toContain("Download Excel");
      expect(html).toContain("Week summary");
    });
  }
});
