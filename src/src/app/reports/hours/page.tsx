import { Suspense } from "react";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { HoursReportEntry } from "@/components/hours-report-entry";

export const metadata = {
  title: "Hours Report — Jirita",
};

export default function HoursReportPage() {
  return (
    <AppShell
      activePage="reports"
      breadcrumb={
        <>
          <Link href="/reports" className="text-slate-400 hover:text-slate-600 dark:text-zinc-500 dark:hover:text-zinc-300">
            Reports
          </Link>
          <span className="text-slate-300 dark:text-zinc-700">/</span>
          <span className="text-slate-800 font-medium dark:text-zinc-200">Hours Report</span>
        </>
      }
    >
      {/* useSearchParams() (the report's URL-persisted state) requires a Suspense boundary */}
      <Suspense fallback={null}>
        <HoursReportEntry />
      </Suspense>
    </AppShell>
  );
}
