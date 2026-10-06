"use client";

// JIR-118 — "Import from JIRA": select a JIRA CSV export → parse and
// validate it locally → preview (read-only) → confirm → one atomic
// import_external_tickets call → result. TICKETS ONLY: nothing in this
// flow reads or writes time entries, and the only fields that ever leave
// the browser are Issue id, Issue key, the built title and the mapped
// type (see lib/jira-csv-import.ts's toImportPayload).

import { useEffect, useMemo, useRef, useState } from "react";
import type { TicketStatusOption } from "@/lib/tickets";
import {
  IMPORTED_STATUS_NAME,
  JIRA_IMPORT_MAX_FILE_BYTES,
  classifyJiraIssues,
  findImportedStatus,
  parseJiraCsv,
  toImportPayload,
  type JiraDuplicate,
  type JiraImportAction,
  type JiraImportPreviewItem,
  type JiraInvalidRow,
} from "@/lib/jira-csv-import";
import { importJiraTickets, loadExistingImportedTickets, type ImportTicketsSummary } from "@/lib/ticket-import";

interface Preview {
  fileName: string;
  rowCount: number;
  items: JiraImportPreviewItem[];
  invalidRows: JiraInvalidRow[];
  duplicates: JiraDuplicate[];
}

type Step =
  | { name: "select" }
  | { name: "preview"; preview: Preview }
  | { name: "result"; preview: Preview; summary: ImportTicketsSummary };

const ACTION_LABEL: Record<JiraImportAction, string> = {
  create: "New",
  update: "Update",
  unchanged: "Unchanged",
};

const ACTION_BADGE: Record<JiraImportAction, string> = {
  create: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
  update: "bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300",
  unchanged: "bg-slate-100 text-slate-500 dark:bg-zinc-800 dark:text-zinc-400",
};

const SECONDARY_BUTTON =
  "px-4 py-2 text-[13px] font-medium text-slate-500 dark:text-zinc-500 hover:text-slate-800 dark:hover:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 rounded-lg transition-colors disabled:opacity-50";
const PRIMARY_BUTTON =
  "px-4 py-2 text-[13px] font-semibold text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed dark:bg-brand-accent dark:text-brand-accent-foreground dark:hover:bg-brand-accent-strong";

function ImportFacts() {
  return (
    <ul className="rounded-lg border border-slate-100 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900 px-4 py-3 space-y-1 text-[12px] text-slate-600 dark:text-zinc-400 list-disc list-inside">
      <li>JIRA worklogs and logged hours are <strong className="font-semibold">not</strong> imported.</li>
      <li>The JIRA Assignee is ignored — new tickets are assigned to you.</li>
      <li>Tickets already imported are reused, never duplicated, and keep their current assignee.</li>
      <li>Existing JIRITA time entries are not touched.</li>
    </ul>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-100 dark:border-zinc-800 px-3 py-2">
      <p className="text-[18px] font-semibold text-slate-900 dark:text-zinc-50 leading-tight">{value}</p>
      <p className="text-[11px] text-slate-500 dark:text-zinc-500">{label}</p>
    </div>
  );
}

export function ImportJiraModal({
  projectId,
  statuses,
  onClose,
  onImported,
}: {
  projectId: string;
  /** This project's own real statuses — the importer only ever looks up
   *  the existing closed "Imported" one; it never creates a status. */
  statuses: TicketStatusOption[];
  onClose: () => void;
  /** Called after a successful import so the Tickets screen can reload. */
  onImported: () => void;
}) {
  const [step, setStep] = useState<Step>({ name: "select" });
  const [busy, setBusy] = useState<"reading" | "importing" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const importedStatus = useMemo(() => findImportedStatus(statuses), [statuses]);

  function handleClose() {
    if (busy) return;
    onClose();
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  async function handleFile(file: File) {
    setError(null);
    if (file.size > JIRA_IMPORT_MAX_FILE_BYTES) {
      setError("This file is too large. Export fewer issues from JIRA and try again.");
      return;
    }
    setBusy("reading");
    try {
      const parsed = parseJiraCsv(await file.text());
      if (parsed.status === "error") {
        setError(parsed.message);
        return;
      }
      // Read-only lookup — the preview never writes anything.
      const existing = await loadExistingImportedTickets(projectId, parsed.issues.map((issue) => issue.externalId));
      if (existing.status === "error") {
        setError(existing.message);
        return;
      }
      setStep({
        name: "preview",
        preview: {
          fileName: file.name,
          rowCount: parsed.rowCount,
          items: classifyJiraIssues(parsed.issues, existing.tickets),
          invalidRows: parsed.invalidRows,
          duplicates: parsed.duplicates,
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read this file.");
    } finally {
      setBusy(null);
    }
  }

  async function handleConfirm(preview: Preview) {
    if (importedStatus.status !== "ready") return;
    setError(null);
    setBusy("importing");
    try {
      const result = await importJiraTickets(
        projectId,
        importedStatus.importedStatus.id,
        toImportPayload(preview.items.map((item) => item.issue))
      );
      if (result.status === "error") {
        setError(result.message);
        return;
      }
      setStep({ name: "result", preview, summary: result.summary });
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The import failed and nothing was imported. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  const count = (preview: Preview, action: JiraImportAction) => preview.items.filter((i) => i.action === action).length;

  return (
    <>
      <div aria-hidden onClick={handleClose} className="fixed inset-0 z-50 bg-black/30 dark:bg-black/50" />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          role="dialog"
          aria-modal
          aria-label="Import tickets from JIRA"
          className="w-full max-w-2xl max-h-[90vh] flex flex-col bg-white dark:bg-zinc-950 rounded-2xl border border-slate-200 dark:border-zinc-800 shadow-2xl shadow-black/20 dark:shadow-black/60"
        >
          <div className="px-6 pt-6 pb-4 flex-shrink-0">
            <h2 className="text-[15px] font-semibold text-slate-900 dark:text-zinc-50">Import tickets from JIRA</h2>
            <p className="text-[13px] text-slate-500 dark:text-zinc-400 mt-1">
              Turns the issues in a JIRA CSV export into normal tickets in this project, in the{" "}
              <strong className="font-semibold">{IMPORTED_STATUS_NAME}</strong> status. Log your time on them afterwards,
              as on any other ticket.
            </p>
          </div>

          <div className="px-6 pb-2 overflow-y-auto flex-1 min-h-0 space-y-4">
            {step.name === "select" && (
              <>
                {importedStatus.status !== "ready" ? (
                  <p className="rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-4 py-3 text-[13px] text-amber-800 dark:text-amber-200">
                    {importedStatus.status === "missing"
                      ? `This project has no "${IMPORTED_STATUS_NAME}" status yet. An Admin or Project Lead needs to create it as a Closed status in Project Settings → Statuses before tickets can be imported.`
                      : `This project's "${IMPORTED_STATUS_NAME}" status is Open. Move it to Closed in Project Settings → Statuses before importing.`}
                  </p>
                ) : (
                  <div className="rounded-lg border border-dashed border-slate-200 dark:border-zinc-700 px-4 py-6 text-center">
                    <p className="text-[13px] text-slate-600 dark:text-zinc-400">
                      In JIRA, open your filter and export it as CSV, then choose that file here.
                    </p>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".csv,text/csv"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        if (file) void handleFile(file);
                      }}
                    />
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => fileInputRef.current?.click()}
                      className={PRIMARY_BUTTON + " mt-3"}
                    >
                      {busy === "reading" ? "Reading…" : "Choose CSV file"}
                    </button>
                  </div>
                )}
                <ImportFacts />
              </>
            )}

            {step.name === "preview" && (
              <>
                <p className="text-[12px] text-slate-500 dark:text-zinc-500 truncate">
                  {step.preview.fileName} · {step.preview.rowCount} row{step.preview.rowCount === 1 ? "" : "s"} · nothing
                  has been imported yet
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <Stat label="New tickets" value={count(step.preview, "create")} />
                  <Stat label="Existing, to update" value={count(step.preview, "update")} />
                  <Stat label="Existing, unchanged" value={count(step.preview, "unchanged")} />
                  <Stat label="Invalid rows" value={step.preview.invalidRows.length} />
                </div>

                {step.preview.duplicates.length > 0 && (
                  <p className="text-[12px] text-amber-700 dark:text-amber-300">
                    {step.preview.duplicates.length === 1 ? "1 issue appears" : `${step.preview.duplicates.length} issues appear`}{" "}
                    more than once in this file ({step.preview.duplicates.map((d) => d.externalKey).join(", ")}); the last
                    row of each is used.
                  </p>
                )}

                {step.preview.items.length > 0 && (
                  <div className="rounded-lg border border-slate-100 dark:border-zinc-800 divide-y divide-slate-100 dark:divide-zinc-800 max-h-64 overflow-y-auto">
                    {step.preview.items.map((item) => (
                      <div key={item.issue.externalId} className="flex items-center gap-3 px-3 py-2">
                        <span className={"flex-shrink-0 w-[76px] text-center rounded px-1.5 py-0.5 text-[11px] font-medium " + ACTION_BADGE[item.action]}>
                          {ACTION_LABEL[item.action]}
                        </span>
                        <span className="flex-1 min-w-0 text-[13px] text-slate-700 dark:text-zinc-300 truncate">
                          {item.issue.title}
                        </span>
                        <span className="flex-shrink-0 text-[11px] uppercase tracking-wide text-slate-400 dark:text-zinc-600">
                          {item.issue.type}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {step.preview.invalidRows.length > 0 && (
                  <div className="rounded-lg border border-red-100 dark:border-red-900/40 px-3 py-2">
                    <p className="text-[12px] font-medium text-red-700 dark:text-red-300">
                      Invalid rows — these will be skipped
                    </p>
                    <ul className="mt-1 space-y-0.5 max-h-28 overflow-y-auto">
                      {step.preview.invalidRows.map((row) => (
                        <li key={row.rowNumber} className="text-[12px] text-slate-600 dark:text-zinc-400">
                          Row {row.rowNumber} ({row.label}): {row.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <ImportFacts />
              </>
            )}

            {step.name === "result" && (
              <>
                <p className="text-[13px] font-medium text-emerald-700 dark:text-emerald-300">Import complete.</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  <Stat label="Rows processed" value={step.preview.rowCount} />
                  <Stat label="Tickets created" value={step.summary.created} />
                  <Stat label="Tickets updated" value={step.summary.updated} />
                  <Stat label="Tickets unchanged" value={step.summary.unchanged} />
                  <Stat label="Invalid rows skipped" value={step.preview.invalidRows.length} />
                  <Stat label="Errors" value={0} />
                </div>
                <ImportFacts />
              </>
            )}

            {error && <p className="text-[13px] text-red-600 dark:text-red-400">{error}</p>}
          </div>

          <div className="px-6 py-4 flex items-center justify-end gap-2 flex-shrink-0">
            {step.name === "select" && (
              <button type="button" onClick={handleClose} disabled={busy !== null} className={SECONDARY_BUTTON}>
                Cancel
              </button>
            )}
            {step.name === "preview" && (
              <>
                <button
                  type="button"
                  onClick={() => { setError(null); setStep({ name: "select" }); }}
                  disabled={busy !== null}
                  className={SECONDARY_BUTTON}
                >
                  Choose another file
                </button>
                <button
                  type="button"
                  onClick={() => void handleConfirm(step.preview)}
                  disabled={busy !== null || count(step.preview, "create") + count(step.preview, "update") === 0}
                  className={PRIMARY_BUTTON}
                >
                  {busy === "importing"
                    ? "Importing…"
                    : count(step.preview, "create") + count(step.preview, "update") === 0
                      ? "Nothing to import"
                      : "Import tickets"}
                </button>
              </>
            )}
            {step.name === "result" && (
              <button type="button" onClick={handleClose} className={PRIMARY_BUTTON}>
                Done
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
