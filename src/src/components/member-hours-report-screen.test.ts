import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// JIR-119 — what a Member sees the moment Reports → Hours opens, before any
// data has loaded (a server render runs no effects, so no query is made).
vi.mock("@/components/current-user-provider", () => ({
  useCurrentUser: () => ({
    user: { role: "MEMBER", name: "Michaela Doe", financialAccess: false },
    organization: { id: "org" },
    userId: "me",
  }),
}));

const { MemberHoursReportScreen } = await import("@/components/member-hours-report-screen");

describe("Member Hours Report — initial view", () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 7, 12, 0, 0)); // Wednesday, Oct 7, 2026 (local)
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it("opens on This Week with seven days, today selected, and no This Quarter", () => {
    const html = renderToStaticMarkup(createElement(MemberHoursReportScreen));

    expect(html).toContain("5 Oct – 11 Oct");
    for (const label of ["This Week", "This Month", "Last Month", "Custom Range"]) expect(html).toContain(label);
    expect(html).not.toContain("This Quarter");
    expect(html).toMatch(/aria-pressed="true"[^>]*>This Week</);

    const days = html.match(/<button[^>]*aria-label="[A-Za-z]+day, October \d+, 2026[^"]*"/g) ?? [];
    expect(days).toHaveLength(7);
    const selected = days.filter((d) => d.includes('aria-pressed="true"'));
    expect(selected).toHaveLength(1);
    expect(selected[0]).toContain("Wednesday, October 7, 2026, today");
    // The detail below is today's.
    expect(html).toContain(">Wednesday, October 7, 2026</h2>");

    expect(html).toContain('aria-label="Previous week"');
    expect(html).toContain('aria-label="Next week"');
    expect(html).toContain("Download Excel");
    // Read-only: nothing to add, edit or delete hours from here.
    expect(html).not.toMatch(/Log time|Add hours|Edit|Delete/i);
  });
});
