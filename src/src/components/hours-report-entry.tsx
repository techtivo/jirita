"use client";

// Reports → Hours (/reports/hours) entry point. JIR-119: a MEMBER gets the
// personal timesheet; every other role keeps the existing administrative
// Hours Report, unchanged. The choice is made from the viewer's real role
// alone (getHoursReportExperience) — never from what data they happen to
// have.

import { useCurrentUser } from "@/components/current-user-provider";
import { HoursReportScreen } from "@/components/hours-report-screen";
import { MemberHoursReportScreen } from "@/components/member-hours-report-screen";
import { getHoursReportExperience } from "@/lib/hours-timesheet";

export function HoursReportEntry() {
  const { user } = useCurrentUser();
  return getHoursReportExperience(user.role) === "member-timesheet" ? <MemberHoursReportScreen /> : <HoursReportScreen />;
}
