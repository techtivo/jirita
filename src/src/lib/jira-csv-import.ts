// JIR-118 — pure parsing/mapping for "import tickets from a JIRA CSV
// export". No Supabase, no DOM: everything here runs (and is tested) in
// plain Node. The database side is import_external_tickets
// (20261006000000); the calls into it live in lib/ticket-import.ts.
//
// TICKETS ONLY. Exactly four JIRA columns are read — Issue id, Issue key,
// Summary (required) and Issue Type (optional). Status, Assignee, Created/Updated, worklog/time
// columns and anything else in the file are ignored on purpose: a new
// ticket is assigned to whoever runs the import (decided by the database
// from the session, never from the file) in a Closed status of the
// project ("Imported" when it exists, otherwise one the user picks), and
// hours are logged by hand in JIRITA afterwards.

export const JIRA_SOURCE = "jira";
/** Same cap import_external_tickets enforces server-side. */
export const JIRA_IMPORT_MAX_ROWS = 2000;
export const JIRA_IMPORT_MAX_FILE_BYTES = 5 * 1024 * 1024;
/** The Closed status new imported tickets go into automatically when the
 *  project has one by this name (see resolveImportStatus); otherwise the
 *  user picks another Closed status. The importer never creates a status. */
export const IMPORTED_STATUS_NAME = "Imported";

// ── CSV ─────────────────────────────────────────────────────────────────

export type CsvParseResult =
  | { status: "ok"; rows: string[][] }
  | { status: "error"; message: string };

/** RFC 4180: quoted fields, commas and newlines inside quotes, "" as an
 *  escaped quote, CRLF or LF line endings, optional BOM. Malformed input
 *  (a quote that never closes, or text glued to a closing quote) is an
 *  error — never a best-effort guess that could shift columns. Fully blank
 *  lines are dropped. */
export function parseCsv(input: string): CsvParseResult {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldWasQuoted = false;
  let line = 1;
  let quoteOpenedAtLine = 0;

  const endField = () => {
    row.push(field);
    field = "";
    fieldWasQuoted = false;
  };
  const endRow = () => {
    endField();
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }
    if (fieldWasQuoted && ch !== "," && ch !== "\n" && ch !== "\r") {
      return { status: "error", message: `Malformed CSV: unexpected text after a closing quote on line ${line}.` };
    }
    if (ch === '"') {
      if (field !== "") {
        return { status: "error", message: `Malformed CSV: unexpected quote inside an unquoted field on line ${line}.` };
      }
      inQuotes = true;
      fieldWasQuoted = true;
      quoteOpenedAtLine = line;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRow();
      line++;
    } else {
      field += ch;
    }
  }

  if (inQuotes) {
    return { status: "error", message: `Malformed CSV: a quoted field opened on line ${quoteOpenedAtLine} is never closed.` };
  }
  if (field !== "" || row.length > 0 || fieldWasQuoted) endRow();
  return { status: "ok", rows };
}

// ── JIRA mapping ────────────────────────────────────────────────────────

export type ImportedTicketType = "task" | "bug";

/** Bug → bug; every other JIRA issue type → task. */
export function mapJiraIssueType(issueType: string): ImportedTicketType {
  return issueType.trim().toLowerCase() === "bug" ? "bug" : "task";
}

/** "<Issue key> <Summary>" — the JIRA key leads the title because JIRITA
 *  shows its own ticket key; this is what makes "SO-1832" searchable. */
export function buildImportedTitle(issueKey: string, summary: string): string {
  return `${issueKey.trim()} ${summary.replace(/\s+/g, " ").trim()}`;
}

export interface JiraIssue {
  externalId: string;
  externalKey: string;
  title: string;
  type: ImportedTicketType;
  /** 1-based data row in the file (the header is not counted). */
  rowNumber: number;
}

export interface JiraInvalidRow {
  rowNumber: number;
  reason: string;
  /** Whatever identifies the row to a human, when present. */
  label: string;
}

export interface JiraDuplicate {
  externalId: string;
  externalKey: string;
  /** Every data row carrying this Issue id; the last one is the one kept. */
  rowNumbers: number[];
}

export type JiraCsvResult =
  | {
      status: "ok";
      /** Total data rows in the file (valid + invalid, duplicates included). */
      rowCount: number;
      /** One entry per distinct Issue id, in first-appearance order. */
      issues: JiraIssue[];
      invalidRows: JiraInvalidRow[];
      duplicates: JiraDuplicate[];
    }
  | { status: "error"; message: string };

// Issue Type is optional: a file without that column imports every issue
// as a task (same as any non-Bug value). Nothing else is ever required,
// and no required column is ever inferred from another.
const REQUIRED_COLUMNS = ["Issue id", "Issue key", "Summary"] as const;

/** Turns a JIRA CSV export into importable issues. Column lookup is by
 *  header name (case-insensitive, first occurrence — JIRA repeats headers
 *  such as "Labels"/"Sprint"), never by position. A row missing any
 *  required value is reported as invalid and skipped; the same Issue id
 *  appearing more than once resolves to its LAST row and is reported. */
export function parseJiraCsv(text: string): JiraCsvResult {
  const parsed = parseCsv(text);
  if (parsed.status === "error") return parsed;
  if (parsed.rows.length === 0) return { status: "error", message: "The file is empty." };

  const [header, ...dataRows] = parsed.rows;
  const normalizedHeader = header.map((h) => h.trim().toLowerCase());
  const columnIndex = (name: string) => normalizedHeader.indexOf(name.toLowerCase());

  const missing = REQUIRED_COLUMNS.filter((name) => columnIndex(name) === -1);
  if (missing.length > 0) {
    return {
      status: "error",
      message: `This doesn't look like a JIRA issue export — missing column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.`,
    };
  }
  if (dataRows.length === 0) return { status: "error", message: "The file has a header but no issues." };
  if (dataRows.length > JIRA_IMPORT_MAX_ROWS) {
    return {
      status: "error",
      message: `The file has ${dataRows.length} rows; the limit is ${JIRA_IMPORT_MAX_ROWS} per import. Narrow the JIRA filter and export again.`,
    };
  }

  const idIndex = columnIndex("Issue id");
  const keyIndex = columnIndex("Issue key");
  const summaryIndex = columnIndex("Summary");
  const typeIndex = columnIndex("Issue Type");

  const byId = new Map<string, JiraIssue>();
  const rowNumbersById = new Map<string, number[]>();
  const invalidRows: JiraInvalidRow[] = [];

  dataRows.forEach((cells, index) => {
    const rowNumber = index + 1;
    const externalId = (cells[idIndex] ?? "").trim();
    const externalKey = (cells[keyIndex] ?? "").trim();
    const summary = (cells[summaryIndex] ?? "").trim();
    const label = externalKey || externalId || `row ${rowNumber}`;

    const missingValues = [
      externalId ? null : "Issue id",
      externalKey ? null : "Issue key",
      summary ? null : "Summary",
    ].filter((v): v is string => v !== null);
    if (missingValues.length > 0) {
      invalidRows.push({ rowNumber, label, reason: `Missing ${missingValues.join(", ")}` });
      return;
    }

    const issue: JiraIssue = {
      externalId,
      externalKey,
      title: buildImportedTitle(externalKey, summary),
      type: mapJiraIssueType(typeIndex === -1 ? "" : cells[typeIndex] ?? ""),
      rowNumber,
    };
    const seen = rowNumbersById.get(externalId);
    if (seen) {
      seen.push(rowNumber);
      // Map#set on an existing key keeps its original insertion position,
      // so `issues` stays in first-appearance order while the data is the
      // last row's.
      byId.set(externalId, issue);
    } else {
      rowNumbersById.set(externalId, [rowNumber]);
      byId.set(externalId, issue);
    }
  });

  const issues = Array.from(byId.values());
  const duplicates: JiraDuplicate[] = issues
    .filter((issue) => (rowNumbersById.get(issue.externalId)?.length ?? 0) > 1)
    .map((issue) => ({
      externalId: issue.externalId,
      externalKey: issue.externalKey,
      rowNumbers: rowNumbersById.get(issue.externalId)!,
    }));

  return { status: "ok", rowCount: dataRows.length, issues, invalidRows, duplicates };
}

// ── Preview classification ──────────────────────────────────────────────

/** What JIRITA already holds for an Issue id in the selected project. */
export interface ExistingImportedTicket {
  externalId: string;
  externalKey: string | null;
  title: string;
  type: ImportedTicketType;
  ticketNumber: number;
}

export type JiraImportAction = "create" | "update" | "unchanged";

export interface JiraImportPreviewItem {
  issue: JiraIssue;
  action: JiraImportAction;
  existing: ExistingImportedTicket | null;
}

/** Mirrors import_external_tickets' own decision exactly: an unknown
 *  Issue id is created; a known one is updated only if its key, title or
 *  type differs, otherwise left untouched. Read-only — the preview never
 *  writes anything. */
export function classifyJiraIssues(issues: JiraIssue[], existing: ExistingImportedTicket[]): JiraImportPreviewItem[] {
  const existingById = new Map(existing.map((ticket) => [ticket.externalId, ticket]));
  return issues.map((issue) => {
    const match = existingById.get(issue.externalId) ?? null;
    if (!match) return { issue, action: "create", existing: null };
    const changed =
      match.externalKey !== issue.externalKey || match.title !== issue.title || match.type !== issue.type;
    return { issue, action: changed ? "update" : "unchanged", existing: match };
  });
}

export interface ImportedTicketRowPayload {
  external_id: string;
  external_key: string;
  title: string;
  type: ImportedTicketType;
}

/** The exact rows sent to import_external_tickets — only the four mapped
 *  fields; nothing about status, assignee, dates or time ever leaves the
 *  browser. */
export function toImportPayload(issues: JiraIssue[]): ImportedTicketRowPayload[] {
  return issues.map((issue) => ({
    external_id: issue.externalId,
    external_key: issue.externalKey,
    title: issue.title,
    type: issue.type,
  }));
}

// ── Status for new imported tickets ─────────────────────────────────────

export type ImportStatusResolution<T> =
  /** The project has a Closed "Imported" status — used without asking. */
  | { mode: "auto"; status: T }
  /** No usable "Imported" status: the user picks one of the project's own
   *  Closed statuses (given here in the project's own order). */
  | { mode: "choose"; options: T[] }
  /** The project has no Closed status at all — nothing can be imported. */
  | { mode: "blocked" };

/** Decides which status NEW imported tickets are created in. Only ever
 *  offers statuses this project already has with group_type "closed" (the
 *  same open/closed source of truth as isTicketClosed) — never a name
 *  hardcoded here other than "Imported" itself, and never a status the
 *  importer would have to create or reconfigure. "Imported" is matched by
 *  name ignoring case and surrounding spaces, the same rule the database
 *  uses for status-name uniqueness; an "Imported" status that is Open
 *  doesn't qualify and simply isn't offered. Existing tickets are never
 *  affected by this choice — import_external_tickets only applies it to
 *  the tickets it creates. */
export function resolveImportStatus<T extends { name: string; groupType: "open" | "closed" }>(
  statuses: T[]
): ImportStatusResolution<T> {
  const closed = statuses.filter((s) => s.groupType === "closed");
  if (closed.length === 0) return { mode: "blocked" };
  const imported = closed.find((s) => s.name.trim().toLowerCase() === IMPORTED_STATUS_NAME.toLowerCase());
  return imported ? { mode: "auto", status: imported } : { mode: "choose", options: closed };
}
