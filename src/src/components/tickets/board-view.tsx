"use client";

import { useMemo, useState } from "react";
import type { Ticket } from "@/lib/mock-tickets";
import { STATUS_FROM_DB, FALLBACK_TICKET_STATUSES, type TicketStatusOption } from "@/lib/tickets";
import { BoardColumn, type ColumnDefinition, type OnTicketClick, type BoardHierarchyInfo } from "@/components/tickets/board-column";
import { TicketStatusChangeModal } from "@/components/tickets/ticket-status-change-modal";
import { CloseParentConfirmModal } from "@/components/tickets/close-parent-confirm-modal";
import { countOpenChildTickets } from "@/lib/tickets";

// Color pair for each of the 6 legacy-linked statuses this phase seeds for
// every project — keyed by legacy_enum_value (the one thing stable across
// projects and guaranteed to exist today) rather than name/sort_order,
// since this phase builds no per-status color configuration UI. A future
// custom status with no legacy equivalent falls back to a neutral gray.
const COLUMN_COLORS: Record<string, { dotClass: string; countClass: string }> = {
  backlog: {
    dotClass: "bg-slate-400 dark:bg-zinc-500",
    countClass: "bg-slate-200/80 text-slate-600 dark:bg-zinc-700 dark:text-zinc-300",
  },
  to_do: {
    dotClass: "bg-sky-400 dark:bg-sky-500",
    countClass: "bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-400",
  },
  in_progress: {
    dotClass: "bg-amber-400 dark:bg-amber-500",
    countClass: "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400",
  },
  blocked: {
    dotClass: "bg-red-400 dark:bg-red-500",
    countClass: "bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-400",
  },
  review: {
    dotClass: "bg-violet-400 dark:bg-violet-500",
    countClass: "bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-400",
  },
  done: {
    dotClass: "bg-emerald-400 dark:bg-emerald-500",
    countClass: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400",
  },
};

const FALLBACK_COLUMN_COLOR = {
  dotClass: "bg-slate-400 dark:bg-zinc-500",
  countClass: "bg-slate-200/80 text-slate-600 dark:bg-zinc-700 dark:text-zinc-300",
};

// De-duped by name (Fase 2.5) — the caller (tickets-screen.tsx) already
// merges every distinct project's own status list by name before this
// runs in "all projects" mode, so this never sees the same name twice;
// kept as a defensive de-dup here too since this is also the single-
// project path, where a project's own (project_id, name) unique
// constraint already guarantees no duplicates exist anyway.
function buildColumns(statuses: TicketStatusOption[]): ColumnDefinition[] {
  const seen = new Set<string>();
  const columns: ColumnDefinition[] = [];
  for (const option of statuses) {
    if (seen.has(option.name)) continue;
    seen.add(option.name);
    const colors = (option.legacyEnumValue && COLUMN_COLORS[option.legacyEnumValue]) || FALLBACK_COLUMN_COLOR;
    columns.push({
      id: option.name,
      label: option.name,
      legacyValue: option.legacyEnumValue,
      dotClass: colors.dotClass,
      countClass: colors.countClass,
      groupType: option.groupType,
    });
  }
  return columns;
}

// How many columns the Board renders for these statuses — the same
// fallback and de-dup BoardView itself applies below.
export function countBoardColumns(statuses: TicketStatusOption[]): number {
  return buildColumns(statuses.length > 0 ? statuses : FALLBACK_TICKET_STATUSES).length;
}

// The one stable, name-based key a ticket belongs under — real
// tickets always carry statusName (Fase 2); a mock/dev-fallback ticket
// has none, so it falls back to resolving its legacy `status` domain
// value through the same fallback catalog the columns themselves fall
// back to, keeping the two in sync. Exported for My Work's own grouped
// List view (my-work-screen.tsx), which groups a cross-project ticket
// list by status the same name-based way this Board does, rather than
// duplicating this exact logic a second time.
export function ticketColumnKey(t: Ticket): string | undefined {
  if (t.statusName) return t.statusName;
  const fallback = FALLBACK_TICKET_STATUSES.find(
    (option) => option.legacyEnumValue && STATUS_FROM_DB[option.legacyEnumValue] === t.status
  );
  return fallback?.name;
}

function groupByColumn(tickets: Ticket[], columns: ColumnDefinition[]): Record<string, Ticket[]> {
  const groups: Record<string, Ticket[]> = {};
  for (const col of columns) groups[col.id] = [];
  for (const ticket of tickets) {
    const key = ticketColumnKey(ticket);
    const col = key ? columns.find((c) => c.label === key) : undefined;
    // No matching column — shouldn't happen in single-project mode (every
    // ticket's own project seeded the same list these columns come from);
    // in "all projects" mode the merged column set (built from every
    // loaded project) already covers every status name in use, so this is
    // only reachable if a ticket's status data hasn't loaded yet.
    if (col) groups[col.id].push(ticket);
  }
  return groups;
}

function columnForTicket(t: Ticket, columns: ColumnDefinition[]): ColumnDefinition | undefined {
  const key = ticketColumnKey(t);
  return key ? columns.find((c) => c.label === key) : undefined;
}

export interface BoardDragAndDropOptions {
  /** The real save — the exact same updateTicket() action Ticket
   *  Detail's own status editor already goes through, so permissions/RLS
   *  and the Activity Log trigger it fires are identical, never a second path.
   *  `nextStatusName` is the dropped-on column's real ticket_statuses.name
   *  (Fase 2.5) — the caller resolves it back to a real status_id within
   *  the dragged ticket's OWN project, never assuming the same id/legacy
   *  value is valid across projects. Resolves to the {success, message?}
   *  shape this app's other confirm-then-save modals already use (see
   *  archive-project-modal.tsx). */
  onMoveTicket: (ticket: Ticket, nextStatusName: string) => Promise<{ success: boolean; message?: string }>;
}

export function BoardView({
  tickets,
  onTicketClick,
  dragAndDrop,
  statuses,
  hierarchy,
}: {
  tickets: Ticket[];
  onTicketClick: OnTicketClick;
  /** Enables dragging a card between columns to change its status —
   *  omitted entirely (the default) leaves the Board exactly as it was.
   *  Only the main Tickets screen's Board tab passes this; the other,
   *  read-only "preview" mounts of this same component (My Work, Project
   *  Overview) are unaffected. */
  dragAndDrop?: BoardDragAndDropOptions;
  /** The real, ordered ticket_statuses (Fase 2) columns are built from —
   *  in "all projects" mode, tickets-screen.tsx already merges every
   *  loaded project's own list by name before passing it here, so this
   *  component itself never needs to know about more than one project's
   *  status set at a time. Falls back to the fixed legacy 6-column layout
   *  while still loading, or for any caller that doesn't pass this yet. */
  statuses?: TicketStatusOption[];
  /** Omitted entirely by every other caller (My Work, Project Overview),
   *  which keep rendering cards with no Parent/Child indicator at all —
   *  only the main Tickets screen's Board tab passes this. */
  hierarchy?: BoardHierarchyInfo;
}) {
  const columns = useMemo(
    () => buildColumns(statuses && statuses.length > 0 ? statuses : FALLBACK_TICKET_STATUSES),
    [statuses]
  );
  const byColumn = groupByColumn(tickets, columns);
  const dragAndDropEnabled = dragAndDrop !== undefined;

  // Which real ticket is currently mid-drag — drives both the dragged
  // card's own dimmed "in motion" look (BoardColumn) and resolving
  // fromColumn on drop. Never touches `tickets` itself: the card only
  // ever actually moves column once a confirmed save succeeds (below),
  // so a cancelled or failed drag needs no explicit "revert" — nothing
  // was changed to revert.
  const [draggingTicket, setDraggingTicket] = useState<Ticket | null>(null);
  const [pendingMove, setPendingMove] = useState<{
    ticket: Ticket;
    fromColumn: ColumnDefinition;
    toColumn: ColumnDefinition;
  } | null>(null);
  // Same countOpenChildTickets() check Ticket Detail/Preview's own status
  // selectors run before a manual close — set instead of pendingMove
  // whenever dropping onto a closed-group column would leave open child
  // tickets behind, so Kanban shows this exact same confirmation.
  const [pendingCloseConfirm, setPendingCloseConfirm] = useState<{
    ticket: Ticket;
    toColumn: ColumnDefinition;
    openCount: number;
  } | null>(null);

  function handleCardDragStart(ticket: Ticket) {
    setDraggingTicket(ticket);
  }

  function handleCardDragEnd() {
    setDraggingTicket(null);
  }

  function handleDropOnColumn(toColumn: ColumnDefinition) {
    const ticket = draggingTicket;
    setDraggingTicket(null);
    if (!ticket) return;
    const fromColumn = columnForTicket(ticket, columns);
    // Dropped back on its own column (or a column that already covers this
    // ticket's current status) — a real no-op, never a confirmation.
    if (!fromColumn || fromColumn.id === toColumn.id) return;
    if (toColumn.groupType === "closed") {
      countOpenChildTickets(ticket.id).then((openCount) => {
        if (openCount > 0) {
          setPendingCloseConfirm({ ticket, toColumn, openCount });
        } else {
          setPendingMove({ ticket, fromColumn, toColumn });
        }
      });
      return;
    }
    setPendingMove({ ticket, fromColumn, toColumn });
  }

  return (
    <div className="flex-1 min-h-0 overflow-x-auto">
      <div className="flex gap-4 h-full px-6 pt-4 pb-6">
        {columns.map((col) => (
          <BoardColumn
            key={col.id}
            column={col}
            tickets={byColumn[col.id]}
            onTicketClick={onTicketClick}
            dragAndDropEnabled={dragAndDropEnabled}
            draggingTicketId={draggingTicket?.id ?? null}
            onCardDragStart={handleCardDragStart}
            onCardDragEnd={handleCardDragEnd}
            onDropTicket={() => handleDropOnColumn(col)}
            hierarchy={hierarchy}
          />
        ))}
      </div>

      {pendingMove && dragAndDrop && (
        <TicketStatusChangeModal
          ticket={pendingMove.ticket}
          fromLabel={pendingMove.fromColumn.label}
          toLabel={pendingMove.toColumn.label}
          onCancel={() => setPendingMove(null)}
          onConfirm={async () => {
            const result = await dragAndDrop.onMoveTicket(pendingMove.ticket, pendingMove.toColumn.label);
            if (result.success) setPendingMove(null);
            return result;
          }}
        />
      )}

      {pendingCloseConfirm && dragAndDrop && (
        <CloseParentConfirmModal
          ticket={pendingCloseConfirm.ticket}
          openChildrenCount={pendingCloseConfirm.openCount}
          onCancel={() => setPendingCloseConfirm(null)}
          onConfirm={async () => {
            const result = await dragAndDrop.onMoveTicket(pendingCloseConfirm.ticket, pendingCloseConfirm.toColumn.label);
            if (result.success) setPendingCloseConfirm(null);
            return result;
          }}
        />
      )}
    </div>
  );
}
