"use client";

// JIR-119 — a Member's Reports → Hours: a personal, read-only timesheet
// (week strip / month calendar with a per-day total and a day detail, plus
// the original Custom Range summary). Only ever mounted for the MEMBER role
// (see hours-report-entry.tsx). The views themselves are shared with the
// administrative report (hours-timesheet-views.tsx, JIR-120); what stays
// here is a Member's own scope: only their own hours, a Projects filter,
// Excel — no People, no PDF, never `$`.
//
// Data is the same canonical logged time as before: the Member's own
// ticket_time_entries, fetched by loadProfileTimeEntriesForRange
// (`logged_by` = the session's own profile id, in the query) — once per
// visible period, never per day. Everything on screen and the Excel export
// derive from that one result through filterTimesheetEntries, so the
// calendar, the day detail and the export always agree.

import { useEffect, useMemo, useState } from "react";
import { useCurrentUser } from "@/components/current-user-provider";
import { Section } from "@/components/reports-shared";
import { SkeletonBlock } from "@/components/dashboard-shared";
import { downloadBinaryFile } from "@/components/reports-screen";
import { PersonalProjectsFilter, SummaryPreview } from "@/components/hours-report-screen";
import {
  TIMESHEET_CARD_CLASS,
  TimesheetCalendar,
  TimesheetDayDetailBody,
  TimesheetPeriodBar,
  timesheetDayDetailTitle,
  useTimesheetView,
} from "@/components/hours-timesheet-views";
import { loadOrganizationTickets, loadProfileTimeEntriesForRange } from "@/lib/tickets";
import type { OrganizationTimeEntry } from "@/lib/tickets";
import { loadOrganizationProjects } from "@/lib/projects";
import {
  buildHoursReportData,
  buildHoursReportWorkbookSheets,
  buildHoursReportFilename,
  buildPersonalProjectOptions,
  reconcileProjectSelection,
} from "@/lib/hours-report";
import type { HoursReportProjectOption } from "@/lib/hours-report";
import { buildTimesheetDayDetail, filterTimesheetEntries, sumMinutesByDate } from "@/lib/hours-timesheet";
import { buildXlsxWorkbook } from "@/lib/xlsx-writer";
import type { Ticket } from "@/lib/mock-tickets";
import type { ProjectCategory } from "@/lib/mock-projects";

interface TimesheetProject {
  slug: string;
  name: string;
  status?: string;
  category: ProjectCategory;
}

type ScopeState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; tickets: Ticket[]; projects: TimesheetProject[] };

type RangeState = { from: string; to: string } & (
  | { status: "ready"; entries: OrganizationTimeEntry[]; projectOptions: HoursReportProjectOption[] }
  | { status: "error"; message: string }
);

// ── Main screen ───────────────────────────────────────────────────────────────

export function MemberHoursReportScreen() {
  const { user, organization, userId } = useCurrentUser();
  const userName = user.name;
  // A plain id, not the `organization` object — see hours-report-screen.tsx.
  const organizationId = organization?.id;

  const timesheet = useTimesheetView();
  const { view, selectedDate, from, to, invalidRange } = timesheet;
  // Empty = "All projects" — see PersonalProjectsFilter.
  const [selectedProjectSlugs, setSelectedProjectSlugs] = useState<string[]>([]);

  const [scope, setScope] = useState<ScopeState>({ status: "loading" });
  const [rangeState, setRangeState] = useState<RangeState | null>(null);
  const [downloadingExcel, setDownloadingExcel] = useState(false);

  // ── Scope load — page entry / actual org change only ───────────────────────
  // The same RLS-scoped tickets/projects every other Member screen reads
  // (only projects this Member can see); never the org member list, and
  // never a project's hourly rate.
  useEffect(() => {
    if (!organizationId || !userId) return;
    let cancelled = false;
    (async () => {
      const [ticketsResult, projectsResult] = await Promise.all([
        loadOrganizationTickets(organizationId),
        loadOrganizationProjects(organizationId),
      ]);
      if (cancelled) return;
      if (ticketsResult.status === "error") {
        setScope({ status: "error", message: ticketsResult.message });
        return;
      }
      if (projectsResult.status === "error") {
        setScope({ status: "error", message: projectsResult.message });
        return;
      }
      const categoryBySlug = new Map(projectsResult.projects.map((p) => [p.slug, p.category]));
      setScope({
        status: "ready",
        tickets: ticketsResult.tickets,
        projects: ticketsResult.projects.map((p) => ({
          slug: p.slug,
          name: p.name,
          status: p.status,
          category: categoryBySlug.get(p.slug) ?? "internal",
        })),
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [organizationId, userId]);

  // ── Period fetch — one query set per visible period ────────────────────────
  // `logged_by = userId` is in the query itself and `userId` is the
  // session's own profile id, so nothing on this page can widen it to
  // another person's hours. The Projects filter only narrows these rows
  // client-side (it isn't a dependency here), so toggling it never refetches.
  useEffect(() => {
    if (scope.status !== "ready" || !userId || invalidRange || !from || !to) return;
    let cancelled = false;
    const { tickets, projects } = scope;
    (async () => {
      const result = await loadProfileTimeEntriesForRange(userId, tickets.map((t) => t.id), from, to);
      if (cancelled) return;
      if (result.status === "error") {
        setRangeState({ from, to, status: "error", message: result.message });
        return;
      }
      const entries: OrganizationTimeEntry[] = result.entries.map((r) => ({
        ticketId: r.ticketId,
        loggedBy: r.loggedByProfileId,
        minutes: r.minutes,
        workDate: r.workDate,
        comment: r.comment,
      }));
      const projectOptions = buildPersonalProjectOptions(projects, entries, tickets);
      setRangeState({ from, to, status: "ready", entries, projectOptions });
      setSelectedProjectSlugs((prev) => reconcileProjectSelection(prev, projectOptions));
    })();
    return () => {
      cancelled = true;
    };
  }, [scope, userId, from, to, invalidRange]);

  // A result only counts for the period it was fetched for: while the next
  // period loads, nothing from the previous one is shown under the new
  // week/month heading.
  const current = rangeState && rangeState.from === from && rangeState.to === to ? rangeState : null;
  const loaded = current?.status === "ready" ? current : null;
  const rangeError = current?.status === "error" ? current.message : null;

  const derived = useMemo(() => {
    if (scope.status !== "ready" || !loaded || !userId) return null;
    const entries = filterTimesheetEntries(
      loaded.entries,
      scope.tickets,
      scope.projects.map((p) => p.slug),
      selectedProjectSlugs
    );
    const members = [{ id: userId, name: userName }];
    return {
      minutesByDate: sumMinutesByDate(entries),
      totalMinutes: entries.reduce((sum, entry) => sum + entry.minutes, 0),
      // The whole visible period — Custom Range's summary and the export.
      periodData: buildHoursReportData(scope.tickets, scope.projects, members, entries, false),
      dayDetail: selectedDate
        ? buildTimesheetDayDetail(
            entries.filter((entry) => entry.workDate === selectedDate),
            scope.tickets,
            scope.projects,
            members
          )
        : null,
    };
  }, [scope, loaded, userId, userName, selectedProjectSlugs, selectedDate]);

  async function handleDownloadExcel() {
    if (!derived || !from || !to) return;
    setDownloadingExcel(true);
    try {
      const sheets = await buildHoursReportWorkbookSheets(derived.periodData, from, to, userName);
      downloadBinaryFile(
        buildHoursReportFilename(from, to, "xlsx", userName),
        buildXlsxWorkbook(sheets),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
    } finally {
      setDownloadingExcel(false);
    }
  }

  const canDownloadExcel =
    Boolean(derived) && derived!.periodData.projectGroups.length > 0 && !invalidRange && !downloadingExcel;

  const errorClass =
    "rounded-xl border border-red-200 dark:border-red-700/40 bg-red-50 dark:bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-400";

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 pb-16">
      <div className="flex items-start justify-between mb-5 gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-zinc-50 tracking-tight leading-none">
            Hours Report
          </h1>
          <p className="text-xs text-slate-400 dark:text-zinc-500 mt-0.5">Your logged hours by day</p>
        </div>
        <button
          type="button"
          onClick={handleDownloadExcel}
          disabled={!canDownloadExcel}
          className="flex-shrink-0 inline-flex items-center gap-1.5 text-xs font-semibold px-3.5 py-2 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed text-white transition-colors shadow-sm shadow-brand-500/30 cursor-pointer dark:bg-brand-accent dark:hover:bg-brand-accent-strong dark:shadow-brand-accent/30 dark:text-brand-accent-foreground"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
          </svg>
          {downloadingExcel ? "Preparing…" : "Download Excel"}
        </button>
      </div>

      {scope.status === "error" ? (
        <div className={errorClass}>{scope.message || "Something went wrong loading the Hours Report."}</div>
      ) : (
        <>
          <div className={`${TIMESHEET_CARD_CLASS} px-4 py-3.5 mb-3`}>
            <TimesheetPeriodBar timesheet={timesheet} />
          </div>

          <div className="flex items-center gap-2 mb-5">
            <PersonalProjectsFilter
              projects={loaded?.projectOptions ?? []}
              selected={selectedProjectSlugs}
              onChange={setSelectedProjectSlugs}
            />
          </div>

          {invalidRange && (
            <p className="text-xs text-red-600 dark:text-red-400 mb-4">
              The &quot;From&quot; date must be on or before the &quot;To&quot; date.
            </p>
          )}

          <TimesheetCalendar
            timesheet={timesheet}
            minutesByDate={derived?.minutesByDate ?? null}
            totalMinutes={derived?.totalMinutes ?? null}
          />

          {rangeError !== null ? (
            <div className={errorClass}>{rangeError || "Something went wrong loading logged hours."}</div>
          ) : view.kind === "custom" ? (
            <Section title="Summary">
              {invalidRange ? null : derived ? (
                <SummaryPreview data={derived.periodData} />
              ) : (
                <div className="space-y-2">
                  <SkeletonBlock className="h-5 w-40" />
                  <SkeletonBlock className="h-24 w-full" />
                </div>
              )}
            </Section>
          ) : (
            <Section title={timesheetDayDetailTitle(selectedDate)}>
              <TimesheetDayDetailBody
                selectedDate={selectedDate}
                detail={derived ? derived.dayDetail : null}
                showPeople={false}
              />
            </Section>
          )}
        </>
      )}
    </div>
  );
}
