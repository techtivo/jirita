import { describe, expect, it } from "vitest";
import { rangeForPreset, defaultCustomRange, realRangeForPeriod } from "@/components/reports-screen";

// Reports → Reporting Period → Custom Range quick-picks. These used to be
// computed from a hardcoded mock date (June 30, 2026), so on October 6 "This
// Week" filled in Jun 29 – Jul 5. They now derive from the date passed in —
// the same real local date the page header shows.
describe("Reports custom-range presets", () => {
  const today = "2026-10-06"; // a Tuesday

  it("Today is the reference date itself", () => {
    expect(rangeForPreset("today", today)).toEqual({ from: "2026-10-06", to: "2026-10-06" });
  });

  it("This Week is the Monday–Sunday week containing the reference date", () => {
    expect(rangeForPreset("this-week", today)).toEqual({ from: "2026-10-05", to: "2026-10-11" });
    // Monday and Sunday both stay inside their own week.
    expect(rangeForPreset("this-week", "2026-10-05")).toEqual({ from: "2026-10-05", to: "2026-10-11" });
    expect(rangeForPreset("this-week", "2026-10-11")).toEqual({ from: "2026-10-05", to: "2026-10-11" });
    // A week that crosses a month boundary.
    expect(rangeForPreset("this-week", "2026-10-01")).toEqual({ from: "2026-09-28", to: "2026-10-04" });
  });

  it("This Month / Last Month / This Quarter follow the reference date", () => {
    expect(rangeForPreset("this-month", today)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(rangeForPreset("last-month", today)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(rangeForPreset("this-quarter", today)).toEqual({ from: "2026-10-01", to: "2026-12-31" });
  });

  it("handles year boundaries", () => {
    expect(rangeForPreset("last-month", "2027-01-10")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
    expect(rangeForPreset("this-quarter", "2027-01-10")).toEqual({ from: "2027-01-01", to: "2027-03-31" });
    expect(rangeForPreset("this-week", "2027-01-01")).toEqual({ from: "2026-12-28", to: "2027-01-03" });
  });

  it("is never pinned to the old mock date", () => {
    for (const preset of ["today", "this-week", "this-month", "last-month", "this-quarter"] as const) {
      const range = rangeForPreset(preset, today);
      expect(range.from.startsWith("2026-06")).toBe(false);
      expect(range.to >= "2026-09-30").toBe(true);
    }
  });

  it("agrees with the period tabs, and the default custom range is the current month", () => {
    const none = { from: "", to: "" };
    for (const key of ["this-month", "last-month", "this-quarter"] as const) {
      expect(rangeForPreset(key, today)).toEqual(realRangeForPeriod(key, none, today));
    }
    expect(defaultCustomRange(today)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
  });
});
