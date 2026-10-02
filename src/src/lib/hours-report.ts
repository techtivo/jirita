// Pure data-shaping for the Admin-only Hours Report (Reports → Hours
// Report). Takes the same real tickets/projects/members the rest of
// Reports already loads, plus a fresh OrganizationTimeEntry[] fetched for
// the report's own selected date range (see loadOrganizationLoggedTimeForRange
// in lib/tickets.ts — filtered by the entry's own real work_date, never
// ticket creation or time-entry created_at). No Supabase calls live here;
// the caller (reports-screen.tsx) owns the fetch, this module only turns
// the result into the Summary/Details shape the workbook needs.

import { getTicketDisplayKey } from "@/lib/mock-tickets";
import type { Ticket } from "@/lib/mock-tickets";
import type { ProjectCategory } from "@/lib/mock-projects";
import type { OrganizationTimeEntry } from "@/lib/tickets";
import type { XlsxSheet } from "@/lib/xlsx-writer";
import { HOURS_REPORT_BRANDING } from "@/lib/hours-report-branding";

export interface HoursReportTicketRow {
  ticketKey: string;
  summary: string;
  hours: number;
  /** hours * the ticket's own project.defaultHourlyRate — the same real
   *  Project Settings rate Reports' Finance tab already bills hours
   *  against, never a new rate/calculation of its own. `null` (never `0`)
   *  for an Internal-category project: Internal work is never billable
   *  regardless of what rate (if any) happens to be stored, so it must
   *  read as "not applicable," not "billed at $0." `undefined` — a
   *  distinct state from `null` — when the caller (buildHoursReportData)
   *  was told the viewer has no financial access at all: no rate is ever
   *  read/multiplied in that case, so there's no `$` column concept to
   *  show as either a number or a dash. See HoursReportData.includesFinancials,
   *  the one flag every renderer (preview/PDF/Excel) reads to decide
   *  whether a `$` column exists at all. */
  amount: number | null | undefined;
}

export interface HoursReportProjectGroup {
  projectName: string;
  /** Used only by the web preview to link each ticket key to its Ticket
   *  Detail page (/projects/<slug>/tickets/<key>); the PDF/Excel exports
   *  never read it, so they keep plain-text keys. */
  projectSlug: string;
  /** Project Settings' own real category — the sole source of truth for
   *  whether this project's hours are billable. Never inferred from
   *  `defaultHourlyRate` being 0/unset (a Client project can legitimately
   *  have no rate set yet and must still show `$0.00`, not `—`). Kept
   *  (and the "Internal" label built from it) regardless of financial
   *  access — a project's category is not itself a monetary value. */
  isInternal: boolean;
  tickets: HoursReportTicketRow[];
  totalHours: number;
  /** Sum of the group's own ticket amounts — `null` whenever `isInternal`
   *  is true, `undefined` whenever the viewer has no financial access at
   *  all (see HoursReportTicketRow.amount). */
  totalAmount: number | null | undefined;
}

export interface HoursReportDetailRow {
  projectName: string;
  ticketKey: string;
  summary: string;
  memberName: string;
  workDate: string;
  description: string;
  hours: number;
  /** Same null/undefined rules as HoursReportTicketRow.amount. */
  amount: number | null | undefined;
}

export interface HoursReportData {
  /** The one authoritative "does this report carry any $ at all" flag —
   *  every renderer (the web preview, the PDF, both Excel sheets) reads
   *  this exactly once to decide whether a `$`/Amount column exists,
   *  rather than each re-deriving its own financial-access check. False
   *  for a Project Lead without financial_access; true for Admin and a
   *  financial Project Lead. Set once, here, by buildHoursReportData's own
   *  `includeFinancials` parameter — never re-computed downstream. */
  includesFinancials: boolean;
  projectGroups: HoursReportProjectGroup[];
  /** Every project's hours, Client and Internal alike — category never
   *  excludes a project from the hours total. Always a real number,
   *  regardless of `includesFinancials`. */
  grandTotalHours: number;
  /** Client-category projects only — every Internal group's `totalAmount`
   *  is `null` and contributes nothing here, never $0 "counted in."
   *  `undefined` (not 0) when `includesFinancials` is false — there is no
   *  real total to report, not a real total that happens to be zero. */
  grandTotalAmount: number | undefined;
  detailRows: HoursReportDetailRow[];
}

// $, formatted consistently (symbol + thousands separators + exactly 2
// decimals) everywhere it's shown outside a real numeric spreadsheet cell
// (the web preview and the PDF — Excel instead applies its own native
// "$#,##0.00" cell format in xlsx-writer.ts, so the two are visually
// identical without sharing this string helper).
export function formatCurrencyAmount(amount: number): string {
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ── People filter (JIR-112) ──────────────────────────────────────────────────
// The People filter's options and its filtering both read the exact same
// OrganizationTimeEntry[] the report itself is built from — already scoped
// by the caller to the viewer's authorized tickets, the selected Projects,
// and the selected date range (see hours-report-screen.tsx). So a person is
// only ever offered when they have real logged time (> 0 minutes) matching
// all three at once — never because they're a project member — and the
// filter can only ever narrow that already-authorized set, never widen it.

export interface HoursReportPersonOption {
  id: string;
  name: string;
}

export function buildHoursReportPeopleOptions(
  timeEntries: OrganizationTimeEntry[],
  members: { id: string; name: string }[]
): HoursReportPersonOption[] {
  const memberById = new Map(members.map((m) => [m.id, m]));
  const minutesByPerson = new Map<string, number>();
  for (const entry of timeEntries) {
    if (!entry.loggedBy) continue;
    minutesByPerson.set(entry.loggedBy, (minutesByPerson.get(entry.loggedBy) ?? 0) + entry.minutes);
  }
  return Array.from(minutesByPerson)
    .filter(([, minutes]) => minutes > 0)
    .map(([id]) => ({ id, name: memberById.get(id)?.name ?? "Unknown Member" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// An empty selection means "All people" — every entry, exactly as before
// this filter existed (including any entry with no real `loggedBy`).
export function filterTimeEntriesByPeople(
  timeEntries: OrganizationTimeEntry[],
  selectedPersonIds: string[]
): OrganizationTimeEntry[] {
  if (selectedPersonIds.length === 0) return timeEntries;
  const selected = new Set(selectedPersonIds);
  return timeEntries.filter((entry) => entry.loggedBy !== null && selected.has(entry.loggedBy));
}

// Drops any selected person no longer among `options` (e.g. after a
// Projects/date range change); if what's left is every remaining option,
// that's the same as "All people" and collapses to it. Returns the same
// array reference when nothing changed, so callers can hand it straight to
// a state setter without causing an extra render. An empty result is
// "All people".
export function reconcilePeopleSelection(
  selectedPersonIds: string[],
  options: HoursReportPersonOption[]
): string[] {
  if (selectedPersonIds.length === 0) return selectedPersonIds;
  const eligible = new Set(options.map((o) => o.id));
  const next = selectedPersonIds.filter((id) => eligible.has(id));
  if (next.length === options.length) return [];
  return next.length === selectedPersonIds.length ? selectedPersonIds : next;
}

// Real per-ticket, per-project consolidation for the Summary sheet, and a
// flat per-entry list for the Details sheet — both built from the exact
// same `timeEntries` input, so the two sheets can never disagree with each
// other. A ticket/project only appears when it has at least one real entry
// in `timeEntries` (the caller has already scoped that array to the
// selected From/To range by work_date), so a project or ticket with zero
// hours in range is simply absent — never a zero-hours row.
//
// `$` follows the exact same filtering/consolidation as hours: each
// Client-category project's own real `defaultHourlyRate` (Project
// Settings — the same rate Finance's own billing widgets already multiply
// hours by, see buildFinanceKpiSummary/buildBillingOverviewRows in
// reports-screen.tsx) is applied per entry, summed into the same
// ticket/project/grand groupings hours already use — never a separate rate
// model, and never rounded before it's summed. An Internal-category
// project's hours flow through those exact same groupings unchanged; only
// its `amount` fields are forced to `null` instead of being computed.
//
// `includeFinancials` is this function's own authorization gate — the
// single point every one of this report's three renderers (web preview,
// PDF, Excel) ultimately defers to via the `includesFinancials` flag on
// the object this returns, rather than each independently re-deciding
// whether to show `$`. When false (a Project Lead without financial_access),
// `defaultHourlyRate` is never read and no `amount` is ever computed —
// callers should also avoid passing a real rate through `projects` at all
// in that case (see hours-report-screen.tsx), so the number never even
// reaches this function, not just never reaches the screen.
export function buildHoursReportData(
  tickets: Ticket[],
  projects: { slug: string; name: string; category: ProjectCategory; defaultHourlyRate?: number | null }[],
  members: { id: string; name: string }[],
  timeEntries: OrganizationTimeEntry[],
  includeFinancials: boolean
): HoursReportData {
  const ticketById = new Map(tickets.map((t) => [t.id, t]));
  const projectBySlug = new Map(projects.map((p) => [p.slug, p]));
  const memberById = new Map(members.map((m) => [m.id, m]));

  const minutesByTicketId = new Map<string, number>();
  for (const entry of timeEntries) {
    minutesByTicketId.set(entry.ticketId, (minutesByTicketId.get(entry.ticketId) ?? 0) + entry.minutes);
  }

  const ticketIdsByProjectSlug = new Map<string, Set<string>>();
  for (const ticketId of minutesByTicketId.keys()) {
    const ticket = ticketById.get(ticketId);
    if (!ticket) continue;
    const set = ticketIdsByProjectSlug.get(ticket.projectSlug) ?? new Set<string>();
    set.add(ticketId);
    ticketIdsByProjectSlug.set(ticket.projectSlug, set);
  }

  const projectGroups: HoursReportProjectGroup[] = [];
  for (const [slug, ticketIds] of ticketIdsByProjectSlug) {
    const project = projectBySlug.get(slug);
    if (!project) continue; // no real project left to attribute these hours to
    const isInternal = project.category !== "client";
    const rate = includeFinancials ? project.defaultHourlyRate ?? 0 : 0;

    const ticketRows = Array.from(ticketIds)
      .map((id) => {
        const ticket = ticketById.get(id)!;
        const hours = (minutesByTicketId.get(id) ?? 0) / 60;
        return {
          ticketNumber: ticket.ticketNumber,
          ticketKey: getTicketDisplayKey(ticket),
          summary: ticket.title,
          hours,
          amount: !includeFinancials ? undefined : isInternal ? null : hours * rate,
        };
      })
      .sort((a, b) => a.ticketNumber - b.ticketNumber)
      .map(({ ticketKey, summary, hours, amount }) => ({ ticketKey, summary, hours, amount }));

    const totalHours = ticketRows.reduce((sum, row) => sum + row.hours, 0);
    const totalAmount = !includeFinancials
      ? undefined
      : isInternal
      ? null
      : ticketRows.reduce((sum, row) => sum + (row.amount ?? 0), 0);
    projectGroups.push({ projectName: project.name, projectSlug: slug, isInternal, tickets: ticketRows, totalHours, totalAmount });
  }
  projectGroups.sort((a, b) => a.projectName.localeCompare(b.projectName));

  const grandTotalHours = projectGroups.reduce((sum, group) => sum + group.totalHours, 0);
  // Internal groups' `totalAmount` is `null`, so `?? 0` correctly leaves
  // them out of this sum entirely rather than counting them as $0.
  const grandTotalAmount = includeFinancials
    ? projectGroups.reduce((sum, group) => sum + (group.totalAmount ?? 0), 0)
    : undefined;

  const detailRows: (HoursReportDetailRow & { ticketNumber: number })[] = [];
  for (const entry of timeEntries) {
    const ticket = ticketById.get(entry.ticketId);
    if (!ticket) continue;
    const project = projectBySlug.get(ticket.projectSlug);
    if (!project) continue;
    const member = entry.loggedBy ? memberById.get(entry.loggedBy) : undefined;
    const hours = entry.minutes / 60;
    const isInternal = project.category !== "client";

    detailRows.push({
      projectName: project.name,
      ticketKey: getTicketDisplayKey(ticket),
      summary: ticket.title,
      memberName: member?.name ?? "Unknown Member",
      workDate: entry.workDate,
      description: entry.comment ?? "",
      hours,
      amount: !includeFinancials ? undefined : isInternal ? null : hours * (project.defaultHourlyRate ?? 0),
      ticketNumber: ticket.ticketNumber,
    });
  }
  detailRows.sort((a, b) => {
    if (a.projectName !== b.projectName) return a.projectName.localeCompare(b.projectName);
    if (a.ticketNumber !== b.ticketNumber) return a.ticketNumber - b.ticketNumber;
    return a.workDate.localeCompare(b.workDate);
  });

  return {
    includesFinancials: includeFinancials,
    projectGroups,
    grandTotalHours,
    grandTotalAmount,
    detailRows: detailRows.map((row) => ({
      projectName: row.projectName,
      ticketKey: row.ticketKey,
      summary: row.summary,
      memberName: row.memberName,
      workDate: row.workDate,
      description: row.description,
      hours: row.hours,
      amount: row.amount,
    })),
  };
}

// Turns HoursReportData into the two real worksheets the workbook needs.
// Summary groups tickets under their project with a bold "Project Total"
// row and ends with a bold overall "TOTAL HOURS" row; Details lists every
// individual entry. Both read from the exact same `data`, so they can never
// disagree with each other or with the on-screen totals.
// `$` cell for a possibly-`null` amount (Internal-category rows) — an
// em dash, plain-styled, instead of a currency-formatted `0`, so Internal
// hours never read as "billed at $0." Only ever called once `includesFinancials`
// has already gated whether a `$` column exists at all — see below.
function amountCell(amount: number | null, bold: boolean): XlsxSheet["rows"][number][number] {
  if (amount === null) return { value: "—", bold };
  return { value: amount, bold, currency: true };
}

// Fixed on-sheet display size for the Summary header logo — small enough
// to sit comfortably within the two blank rows reserved for it below,
// large enough to actually read as a logo. This is a *floating* image
// (see xlsx-writer.ts's XlsxImage) — Excel never resizes a row/column to
// fit it, so this fixed size can't distort the sheet's own layout.
const LOGO_HEIGHT_PX = 34;
const LOGO_WIDTH_PX = Math.round(LOGO_HEIGHT_PX * (HOURS_REPORT_BRANDING.logoWidthPx / HOURS_REPORT_BRANDING.logoHeightPx));

// Same real logo asset the PDF header already uses (hours-report-branding.ts
// is the one shared place naming it) — fetched fresh per export rather than
// cached, since this runs rarely (once per Download Excel click). A logo
// that fails to fetch (offline, asset moved) degrades to a Summary sheet
// with no image rather than failing the whole export — the report itself
// never depends on the image loading, same resilience the PDF's own logo
// fetch already has.
async function loadLogoBytes(url: string): Promise<Uint8Array | null> {
  try {
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  } catch {
    return null;
  }
}

export async function buildHoursReportWorkbookSheets(
  data: HoursReportData,
  fromISO: string,
  toISO: string
): Promise<XlsxSheet[]> {
  // The one place this workbook decides whether a `$`/Amount column exists
  // at all — reads `data.includesFinancials` (set once, by
  // buildHoursReportData's own authorization parameter) rather than
  // re-deriving a role/permission check here. A Project Lead without
  // financial_access gets a workbook with no `$` column whatsoever in
  // either sheet — never a dash, never a $0 — Hours/Ticket/Summary/
  // grouping/Project Total/TOTAL HOURS are otherwise identical.
  const includeFinancials = data.includesFinancials;
  const logoBytes = await loadLogoBytes(HOURS_REPORT_BRANDING.logoUrl);

  const summaryHeader: XlsxSheet["rows"][number] = [
    { value: "Ticket", bold: true },
    { value: "Summary", bold: true },
    { value: "Hours", bold: true },
  ];
  if (includeFinancials) summaryHeader.push({ value: "$", bold: true });

  // Summary-only header block: two blank rows reserved for the floating
  // logo (it doesn't occupy cell content, so these rows just give it clear
  // space to sit in — see xlsx-writer.ts's XlsxImage), then the title,
  // then the period (same "<from> to <to>" format the PDF header already
  // uses), then one blank row as the small gap before the first
  // project/table. Details intentionally starts straight at its own title
  // row, with no logo and no reserved rows — see its own rows below.
  const summaryRows: XlsxSheet["rows"] = [
    [],
    [],
    [{ value: "HOURS REPORT", bold: true }],
    [{ value: `Period: ${fromISO} to ${toISO}` }],
    [],
    summaryHeader,
  ];

  for (const group of data.projectGroups) {
    summaryRows.push([{ value: group.isInternal ? `${group.projectName} (Internal)` : group.projectName, bold: true }]);
    for (const ticket of group.tickets) {
      const row: XlsxSheet["rows"][number] = [
        { value: ticket.ticketKey },
        { value: ticket.summary },
        { value: ticket.hours, decimal: true },
      ];
      if (includeFinancials) row.push(amountCell(ticket.amount ?? null, false));
      summaryRows.push(row);
    }
    const totalRow: XlsxSheet["rows"][number] = [
      { value: "" },
      { value: "Project Total", bold: true },
      { value: group.totalHours, bold: true, decimal: true },
    ];
    if (includeFinancials) totalRow.push(amountCell(group.totalAmount ?? null, true));
    summaryRows.push(totalRow);
    summaryRows.push([]);
  }

  const grandTotalRow: XlsxSheet["rows"][number] = [
    { value: "" },
    { value: "TOTAL HOURS", bold: true },
    { value: data.grandTotalHours, bold: true, decimal: true },
  ];
  if (includeFinancials) grandTotalRow.push({ value: data.grandTotalAmount ?? 0, bold: true, currency: true });
  summaryRows.push(grandTotalRow);

  const detailHeader: XlsxSheet["rows"][number] = [
    { value: "Project", bold: true },
    { value: "Ticket", bold: true },
    { value: "Summary", bold: true },
    { value: "Member", bold: true },
    { value: "Work Date", bold: true },
    { value: "Time Entry Description", bold: true },
    { value: "Hours", bold: true },
  ];
  if (includeFinancials) detailHeader.push({ value: "$", bold: true });

  const detailRows: XlsxSheet["rows"] = [
    [{ value: "Jirita — Hours Report (Details)", bold: true }],
    [{ value: `Period: ${fromISO} to ${toISO}` }],
    [],
    detailHeader,
    ...data.detailRows.map((row): XlsxSheet["rows"][number] => {
      const cells: XlsxSheet["rows"][number] = [
        { value: row.projectName },
        { value: row.ticketKey },
        { value: row.summary },
        { value: row.memberName },
        { value: row.workDate },
        { value: row.description },
        { value: row.hours, decimal: true },
      ];
      if (includeFinancials) cells.push(amountCell(row.amount ?? null, false));
      return cells;
    }),
  ];

  return [
    {
      name: "Summary",
      rows: summaryRows,
      columnWidths: includeFinancials ? [14, 50, 12, 14] : [14, 50, 12],
      // Details never gets this — only Summary carries the logo header.
      image: logoBytes ? { data: logoBytes, widthPx: LOGO_WIDTH_PX, heightPx: LOGO_HEIGHT_PX } : undefined,
    },
    {
      name: "Details",
      rows: detailRows,
      columnWidths: includeFinancials ? [22, 12, 40, 20, 12, 40, 12, 14] : [22, 12, 40, 20, 12, 40, 12],
    },
  ];
}
