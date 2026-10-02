"use client";

// JIR-116 — "Move to project" from Ticket Detail: one ticket, one
// destination. Lists only the destinations the viewer can use
// (loadTicketMoveDestinations), confirms what will happen, then calls the
// single atomic move_ticket_to_project database function — which re-checks
// every rule itself, so this dialog is never the authority. On success the
// caller navigates to the ticket's new URL. Shell modeled on
// close-parent-confirm-modal.tsx.

import { useEffect, useState } from "react";
import { FilterDropdown } from "@/components/tickets/filter-dropdown";
import { loadTicketMoveDestinations, moveTicketToProject } from "@/lib/tickets";
import type { TicketMoveDestination } from "@/lib/tickets";

export function MoveTicketModal({
  organizationId,
  sourceSlug,
  ticketId,
  ticketKey,
  viewer,
  blockedReason,
  onCancel,
  onMoved,
}: {
  organizationId: string;
  sourceSlug: string;
  ticketId: string;
  ticketKey: string;
  viewer: { role: "ADMIN" | "PROJECT_LEAD" | "MEMBER"; profileId: string };
  /** Set when the ticket is already known to be unmovable (parent/child) —
   *  shown instead of the selector. The database enforces it regardless. */
  blockedReason: string | null;
  onCancel: () => void;
  onMoved: (projectSlug: string, ticketCode: string) => void;
}) {
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(blockedReason ? "ready" : "loading");
  const [source, setSource] = useState<TicketMoveDestination | null>(null);
  const [destinations, setDestinations] = useState<TicketMoveDestination[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (blockedReason) return;
    let cancelled = false;
    loadTicketMoveDestinations(organizationId, sourceSlug, viewer).then((result) => {
      if (cancelled) return;
      if (result.status === "error") {
        setError(result.message);
        setLoadState("error");
        return;
      }
      setSource(result.source);
      setDestinations(result.destinations);
      setLoadState("ready");
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleCancel() {
    if (submitting) return;
    onCancel();
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleCancel();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitting]);

  const destination = destinations.find((d) => d.id === selected[0]) ?? null;

  async function handleConfirm() {
    if (submitting || !destination || !source) return;
    setSubmitting(true);
    setError(null);
    const result = await moveTicketToProject(ticketId, destination.id, source.id);
    if (result.status === "error") {
      setSubmitting(false);
      setError(result.message);
      return;
    }
    onMoved(result.projectSlug, result.ticketCode);
  }

  return (
    <>
      <div aria-hidden onClick={handleCancel} className="fixed inset-0 z-50 bg-black/30 dark:bg-black/50" />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          role="dialog"
          aria-modal
          aria-label={`Move ${ticketKey} to another project`}
          className="w-full max-w-md bg-white dark:bg-zinc-950 rounded-2xl border border-slate-200 dark:border-zinc-800 shadow-2xl shadow-black/20 dark:shadow-black/60 p-6"
        >
          <h2 className="text-[15px] font-semibold text-slate-900 dark:text-zinc-50">Move {ticketKey} to another project</h2>

          {blockedReason ? (
            <p className="text-[13px] text-slate-500 dark:text-zinc-400 mt-2">{blockedReason}</p>
          ) : loadState === "loading" ? (
            <p className="text-[13px] text-slate-400 dark:text-zinc-500 mt-2">Loading projects…</p>
          ) : loadState === "ready" && destinations.length === 0 ? (
            <p className="text-[13px] text-slate-500 dark:text-zinc-400 mt-2">
              There are no other projects you can move this ticket to.
            </p>
          ) : loadState === "ready" && source ? (
            <>
              <div className="mt-4">
                <FilterDropdown
                  label="Destination project"
                  mode="single"
                  searchable
                  groups={[{ options: destinations.map((d) => ({ value: d.id, label: d.name })) }]}
                  selected={selected}
                  onChange={setSelected}
                />
              </div>

              {destination && (
                <div className="mt-4 rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900/60 px-3.5 py-3 text-[13px] text-slate-600 dark:text-zinc-300 space-y-1.5">
                  <p>
                    <span className="font-semibold text-slate-800 dark:text-zinc-100">{source.name}</span>{" "}
                    <span className="font-mono text-slate-400 dark:text-zinc-500">({ticketKey})</span>
                    {" → "}
                    <span className="font-semibold text-slate-800 dark:text-zinc-100">{destination.name}</span>
                  </p>
                  <p>
                    It will get a new {destination.projectCode}- ticket number. Comments, attachments, time entries and
                    history are kept.
                  </p>
                  <p className="text-slate-500 dark:text-zinc-400">
                    Status moves to the matching status in {destination.name} (or its default status). The assignee is
                    kept only if they&apos;re a member of {destination.name}; the sprint is cleared.
                  </p>
                </div>
              )}
            </>
          ) : null}

          {error && <p className="text-[13px] text-red-600 dark:text-red-400 mt-3">{error}</p>}

          <div className="flex items-center justify-end gap-2 mt-6">
            <button
              onClick={handleCancel}
              disabled={submitting}
              className="px-4 py-2 text-[13px] font-medium text-slate-500 dark:text-zinc-500 hover:text-slate-800 dark:hover:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 rounded-lg transition-colors disabled:opacity-50"
            >
              {blockedReason ? "Close" : "Cancel"}
            </button>
            {!blockedReason && (
              <button
                onClick={handleConfirm}
                disabled={submitting || !destination}
                className="px-4 py-2 text-[13px] font-semibold text-white bg-brand-500 hover:bg-brand-600 rounded-lg transition-colors disabled:opacity-50 dark:bg-brand-accent dark:hover:bg-brand-accent-strong dark:text-brand-accent-foreground"
              >
                {submitting ? "Moving…" : "Move ticket"}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
