// JIR-118 — the two Supabase calls behind "Import from JIRA": a read-only
// lookup of what the project already holds (for the preview) and the one
// atomic import_external_tickets RPC (20261006000000) that actually
// creates/refreshes tickets. Runs as the signed-in user — authorization,
// status validation, numbering and idempotency are all enforced by the
// database function, never here. The lookup never touches time entries;
// the import creates one only for a row carrying hand-typed minutes
// (20261007000000) and never reads or changes an existing one.

import { getSupabaseBrowserClient } from "./supabase-client";
import {
  JIRA_SOURCE,
  type ExistingImportedTicket,
  type ImportedTicketRowPayload,
  type ImportedTicketType,
} from "./jira-csv-import";

function logDev(...args: unknown[]): void {
  if (process.env.NODE_ENV !== "production") console.warn("[ticket-import]", ...args);
}

// Kept well under the gateway's URL-length limit for an `in (...)` filter
// (JIRA issue ids are short numeric strings).
const EXTERNAL_ID_BATCH_SIZE = 200;

export type ExistingImportedTicketsResult =
  | { status: "ready"; tickets: ExistingImportedTicket[] }
  | { status: "error"; message: string };

/** The tickets this project already has for the given JIRA Issue ids —
 *  ordinary RLS-scoped select, nothing is written. */
export async function loadExistingImportedTickets(
  projectId: string,
  externalIds: string[]
): Promise<ExistingImportedTicketsResult> {
  if (externalIds.length === 0) return { status: "ready", tickets: [] };
  const supabase = getSupabaseBrowserClient();

  const batches: string[][] = [];
  for (let i = 0; i < externalIds.length; i += EXTERNAL_ID_BATCH_SIZE) {
    batches.push(externalIds.slice(i, i + EXTERNAL_ID_BATCH_SIZE));
  }

  const results = await Promise.all(
    batches.map((batch) =>
      supabase
        .from("tickets")
        .select("ticket_number, title, type, external_id, external_key")
        .eq("project_id", projectId)
        .eq("external_source", JIRA_SOURCE)
        .in("external_id", batch)
        .returns<
          { ticket_number: number; title: string; type: ImportedTicketType; external_id: string; external_key: string | null }[]
        >()
    )
  );

  const tickets: ExistingImportedTicket[] = [];
  for (const { data, error } of results) {
    if (error) {
      logDev("existing imported tickets lookup failed", error);
      return { status: "error", message: error.message };
    }
    for (const row of data ?? []) {
      tickets.push({
        externalId: row.external_id,
        externalKey: row.external_key,
        title: row.title,
        type: row.type,
        ticketNumber: row.ticket_number,
      });
    }
  }
  return { status: "ready", tickets };
}

const IMPORT_ERROR_MESSAGES: Record<string, string> = {
  not_authorized: "You don't have permission to import tickets into this project.",
  project_not_found: "This project no longer exists.",
  project_archived: "This project is archived. Restore it before importing tickets.",
  unsupported_source: "This import source isn't supported.",
  status_not_in_project: "The selected status doesn't belong to this project. Reload and try again.",
  status_not_closed: "The selected status is no longer a Closed status. Reload and choose a Closed status.",
  invalid_rows: "The file contains rows that can't be imported. Nothing was imported.",
  too_many_rows: "Too many rows for one import. Narrow the JIRA filter and export again.",
  number_conflict: "Tickets were being created at the same time. Nothing was imported — try again.",
  invalid_minutes: "One of the Hours values isn't valid. Nothing was imported.",
  invalid_work_date: "Today's date couldn't be confirmed for the time entries. Nothing was imported — check your device's date and try again.",
  time_on_parent_ticket: "Time can't be logged on a ticket that has child tickets. Clear its Hours and try again — nothing was imported.",
};
const IMPORT_GENERIC_ERROR = "The import failed and nothing was imported. Please try again.";

export function importTicketsErrorMessage(rawMessage: string | undefined): string {
  const key = rawMessage?.match(/import_tickets:([a-z_]+)/)?.[1];
  return (key && IMPORT_ERROR_MESSAGES[key]) || IMPORT_GENERIC_ERROR;
}

export interface ImportTicketsSummary {
  processed: number;
  created: number;
  updated: number;
  unchanged: number;
  /** Real ticket_time_entries rows this import created (one per ticket with hours). */
  timeEntriesCreated: number;
  minutesLogged: number;
}

export type ImportTicketsResult =
  | { status: "success"; summary: ImportTicketsSummary }
  | { status: "error"; message: string };

type ImportOutcomeRow = {
  external_id: string;
  ticket_id: string;
  ticket_number: number;
  action: string;
  logged_minutes?: number | null;
};

export function summarizeImportOutcome(rows: Pick<ImportOutcomeRow, "action" | "logged_minutes">[]): ImportTicketsSummary {
  const count = (action: string) => rows.filter((row) => row.action === action).length;
  const logged = rows.map((row) => row.logged_minutes ?? 0).filter((minutes) => minutes > 0);
  return {
    processed: rows.length,
    created: count("created"),
    updated: count("updated"),
    unchanged: count("unchanged"),
    timeEntriesCreated: logged.length,
    minutesLogged: logged.reduce((sum, minutes) => sum + minutes, 0),
  };
}

/** One atomic call: either every row is applied or none is. `newTicketStatusId`
 *  is only used for the tickets this call creates — the database function
 *  re-validates that it belongs to the project and is Closed, and never
 *  writes it onto a ticket that already exists. */
//
// `workDate` is the user's local "today" (yyyy-mm-dd) — the same default
// Log Time's own date field uses — and becomes work_date of every time
// entry this call creates. It is always sent, even when no row has
// minutes: a database that doesn't have 20261007000000 yet then rejects
// the call outright instead of importing the tickets and silently
// dropping the hours.
export async function importJiraTickets(
  projectId: string,
  newTicketStatusId: string,
  rows: ImportedTicketRowPayload[],
  workDate: string
): Promise<ImportTicketsResult> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("import_external_tickets", {
    p_project_id: projectId,
    p_source: JIRA_SOURCE,
    p_status_id: newTicketStatusId,
    p_rows: rows,
    p_work_date: workDate,
  });
  if (error) {
    logDev("import_external_tickets rpc failed", error);
    return { status: "error", message: importTicketsErrorMessage(error.message) };
  }
  return { status: "success", summary: summarizeImportOutcome((data ?? []) as ImportOutcomeRow[]) };
}
