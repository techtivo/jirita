"use client";

// JIR-118 — "Import from JIRA": select a JIRA CSV export → parse and
// validate it locally → preview (read-only) → confirm → one atomic
// import_external_tickets call → result. From the CSV only tickets are
// read (Issue id, Issue key, the built title, the mapped type) — never
// JIRA's worklog. Time is optional and typed by hand: each preview row
// has an Hours field, and a value above zero becomes one normal time
// entry for the signed-in user, dated today, created in the same
// transaction as the tickets (see lib/jira-csv-import.ts's toImportPayload).

import { useEffect, useMemo, useRef, useState } from "react";
import type { TicketStatusOption } from "@/lib/tickets";
import { getTodayISO } from "@/components/tickets/ticket-ui";
import {
  IMPORTED_STATUS_NAME,
  canConfirmImport,
  classifyJiraIssues,
  formatMinutesAsHours,
  parseHoursInput,
  resolveImportStatus,
  parseJiraCsv,
  summarizeHours,
  toImportPayload,
  validateImportFile,
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
      <li>
        JIRA worklogs and logged hours are <strong className="font-semibold">not</strong> imported — only the hours you
        type here are logged, as your own time entries dated today.
      </li>
      <li>The JIRA Assignee is ignored — new tickets are assigned to you.</li>
      <li>Tickets already imported are reused, never duplicated, and keep their current assignee.</li>
      <li>Existing JIRITA time entries are not touched; hours typed for an existing ticket are added as a new entry.</li>
    </ul>
  );
}

function NoClosedStatusNotice() {
  return (
    <p className="rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-4 py-3 text-[13px] text-amber-800 dark:text-amber-200">
      This project has no closed status, so tickets can&apos;t be imported yet. An Admin or Project Lead needs to add at
      least one Closed status in Project Settings → Statuses.
    </p>
  );
}

// Compact per-ticket Hours input. Free text (not type="number") so a
// comma decimal works and an unreadable value can be shown as invalid
// instead of being silently dropped by the browser.
function HoursField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const invalid = parseHoursInput(value).status === "invalid";
  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={label}
      aria-invalid={invalid}
      placeholder="0"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={
        "flex-shrink-0 w-16 rounded-md border bg-white dark:bg-zinc-900 px-2 py-1 text-right text-[16px] sm:text-[13px] text-slate-700 dark:text-zinc-200 placeholder:text-slate-300 dark:placeholder:text-zinc-600 focus:outline-none disabled:opacity-50 " +
        (invalid
          ? "border-red-400 dark:border-red-500 focus:border-red-500"
          : "border-slate-200 dark:border-zinc-700 focus:border-brand-500 dark:focus:border-brand-accent")
      }
    />
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
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
  /** This project's own real statuses — the importer only ever uses one
   *  of its existing Closed statuses for new tickets; it never creates or
   *  changes a status. */
  statuses: TicketStatusOption[];
  onClose: () => void;
  /** Called after a successful import so the Tickets screen can reload. */
  onImported: () => void;
}) {
  const [step, setStep] = useState<Step>({ name: "select" });
  const [busy, setBusy] = useState<"reading" | "importing" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [draggingFile, setDraggingFile] = useState(false);
  // Free text per ticket (keyed by JIRA Issue id), exactly as typed —
  // blank means "log nothing". Reset whenever a file is (re)loaded.
  const [hoursByExternalId, setHoursByExternalId] = useState<Record<string, string>>({});

  // Which status NEW tickets get: "Imported" automatically when the
  // project has it as Closed, otherwise whichever Closed status the user
  // picks below. Never applied to tickets that already exist.
  const statusResolution = useMemo(() => resolveImportStatus(statuses), [statuses]);
  const [chosenStatusId, setChosenStatusId] = useState("");
  const newTicketStatus =
    statusResolution.mode === "auto"
      ? statusResolution.status
      : statusResolution.mode === "choose"
        ? statusResolution.options.find((s) => s.id === chosenStatusId) ?? null
        : null;

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

  // The single entry point for a file, whether it was picked or dropped.
  async function handleFile(file: File) {
    setError(null);
    const fileProblem = validateImportFile(file);
    if (fileProblem) {
      setError(fileProblem);
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
      setHoursByExternalId({});
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
    const hours = summarizeHours(preview.items.map((item) => item.issue.externalId), hoursByExternalId);
    if (!newTicketStatus || hours.invalidExternalIds.length > 0) return;
    setError(null);
    setBusy("importing");
    try {
      // work_date = the user's local "today" — the same default the normal
      // Log Time modal uses for its own date field.
      const result = await importJiraTickets(
        projectId,
        newTicketStatus.id,
        toImportPayload(preview.items.map((item) => item.issue), hours.minutesByExternalId),
        getTodayISO()
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

  const previewHours =
    step.name === "preview"
      ? summarizeHours(step.preview.items.map((item) => item.issue.externalId), hoursByExternalId)
      : null;
  const canConfirm =
    step.name === "preview" && previewHours !== null
      ? canConfirmImport({
          hasNewTicketStatus: newTicketStatus !== null,
          ticketsToCreateOrUpdate: count(step.preview, "create") + count(step.preview, "update"),
          hours: previewHours,
        })
      : false;

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
              Turns the issues in a JIRA CSV export into normal tickets in this project, in a closed status. You can
              log your time on them right here, or afterwards as on any other ticket.
            </p>
          </div>

          <div className="px-6 pb-2 overflow-y-auto flex-1 min-h-0 space-y-4">
            {step.name === "select" && (
              <>
                {statusResolution.mode === "blocked" && <NoClosedStatusNotice />}
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (busy === null) setDraggingFile(true);
                  }}
                  onDragLeave={(e) => {
                    // Moving over a child element also fires dragleave — only
                    // a real exit from the drop area clears the highlight.
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDraggingFile(false);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDraggingFile(false);
                    const file = e.dataTransfer.files?.[0];
                    if (file && busy === null) void handleFile(file);
                  }}
                  className={
                    "rounded-lg border border-dashed px-4 py-6 text-center transition-colors " +
                    (draggingFile
                      ? "border-brand-500 bg-brand-50/60 dark:border-brand-accent dark:bg-brand-accent/10"
                      : "border-slate-200 dark:border-zinc-700")
                  }
                >
                  <p className="text-[13px] text-slate-600 dark:text-zinc-400">
                    {draggingFile
                      ? "Drop the CSV file to load it."
                      : "In JIRA, open your filter and export it as CSV, then drop that file here or choose it."}
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
                    <div className="sticky top-0 z-10 flex items-center gap-3 px-3 py-1.5 bg-slate-50 dark:bg-zinc-900 text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:text-zinc-500">
                      <span className="flex-shrink-0 w-[76px]">Import</span>
                      <span className="flex-1 min-w-0">Ticket</span>
                      <span className="flex-shrink-0 w-10">Type</span>
                      <span className="flex-shrink-0 w-16 text-right">Hours</span>
                    </div>
                    {step.preview.items.map((item) => (
                      <div key={item.issue.externalId} className="flex items-center gap-3 px-3 py-1.5">
                        <span className={"flex-shrink-0 w-[76px] text-center rounded px-1.5 py-0.5 text-[11px] font-medium " + ACTION_BADGE[item.action]}>
                          {ACTION_LABEL[item.action]}
                        </span>
                        <span className="flex-1 min-w-0 text-[13px] text-slate-700 dark:text-zinc-300 truncate">
                          {item.issue.title}
                        </span>
                        <span className="flex-shrink-0 w-10 text-[11px] uppercase tracking-wide text-slate-400 dark:text-zinc-600">
                          {item.issue.type}
                        </span>
                        <HoursField
                          label={`Hours for ${item.issue.externalKey}`}
                          value={hoursByExternalId[item.issue.externalId] ?? ""}
                          disabled={busy !== null}
                          onChange={(value) =>
                            setHoursByExternalId((prev) => ({ ...prev, [item.issue.externalId]: value }))
                          }
                        />
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

                {previewHours && previewHours.invalidExternalIds.length > 0 ? (
                  <p className="text-[12px] text-red-600 dark:text-red-400">
                    {previewHours.invalidExternalIds.length === 1
                      ? "1 Hours value isn't valid."
                      : `${previewHours.invalidExternalIds.length} Hours values aren't valid.`}{" "}
                    Use a positive number with up to 2 decimals (for example 1.5), or leave it blank.
                  </p>
                ) : (
                  previewHours &&
                  previewHours.totalMinutes > 0 && (
                    <p className="text-[12px] text-slate-600 dark:text-zinc-400">
                      Time to log:{" "}
                      <strong className="font-semibold text-slate-800 dark:text-zinc-200">
                        {formatMinutesAsHours(previewHours.totalMinutes)}
                      </strong>{" "}
                      across {previewHours.ticketCount} ticket{previewHours.ticketCount === 1 ? "" : "s"} — logged as your
                      time, dated today.
                    </p>
                  )
                )}

                <div>
                  <p className="text-[12px] font-medium text-slate-700 dark:text-zinc-300">Status for imported tickets</p>
                  {statusResolution.mode === "auto" && (
                    <p className="mt-1 text-[12px] text-slate-500 dark:text-zinc-500">
                      New tickets will be created in{" "}
                      <strong className="font-semibold text-slate-700 dark:text-zinc-300">{statusResolution.status.name}</strong>.
                      Tickets that already exist keep their current status.
                    </p>
                  )}
                  {statusResolution.mode === "choose" && (
                    <>
                      <label htmlFor="import-jira-status" className="mt-1 block text-[12px] text-slate-500 dark:text-zinc-500">
                        This project has no closed &quot;{IMPORTED_STATUS_NAME}&quot; status. Choose a closed status to use for
                        the new tickets created by this import — tickets that already exist keep their current status.
                      </label>
                      <select
                        id="import-jira-status"
                        value={chosenStatusId}
                        disabled={busy !== null}
                        onChange={(e) => setChosenStatusId(e.target.value)}
                        className="mt-2 w-full sm:w-64 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-[16px] sm:text-[13px] text-slate-700 dark:text-zinc-200 focus:outline-none focus:border-brand-500 dark:focus:border-brand-accent"
                      >
                        <option value="">Choose a closed status…</option>
                        {statusResolution.options.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.name}
                          </option>
                        ))}
                      </select>
                    </>
                  )}
                  {statusResolution.mode === "blocked" && (
                    <div className="mt-1">
                      <NoClosedStatusNotice />
                    </div>
                  )}
                </div>

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
                  <Stat label="Time entries created" value={step.summary.timeEntriesCreated} />
                  <Stat label="Time logged" value={formatMinutesAsHours(step.summary.minutesLogged)} />
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
                  onClick={() => { setError(null); setHoursByExternalId({}); setStep({ name: "select" }); }}
                  disabled={busy !== null}
                  className={SECONDARY_BUTTON}
                >
                  Choose another file
                </button>
                <button
                  type="button"
                  onClick={() => void handleConfirm(step.preview)}
                  disabled={busy !== null || !canConfirm}
                  className={PRIMARY_BUTTON}
                >
                  {busy === "importing"
                    ? "Importing…"
                    : count(step.preview, "create") + count(step.preview, "update") === 0 &&
                        (previewHours?.totalMinutes ?? 0) === 0 &&
                        (previewHours?.invalidExternalIds.length ?? 0) === 0
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
