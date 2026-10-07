import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Role } from "@/lib/current-user";

// JIR-120 — what an Admin / Project Lead sees the moment Reports → Hours
// opens, before any data has loaded (a server render runs no effects, so no
// query is made).
let role: Role = "ADMIN";

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
