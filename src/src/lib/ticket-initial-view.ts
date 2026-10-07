// Which view a project's Tickets page opens on. A Board with only a few
// columns wastes most of its width, so such a project lands on List
// instead. This only picks the view on entry — it never disables Board, and
// tickets-screen.tsx applies it once per project entry, so a view the user
// picks afterwards is never overridden.

/** A Board with this many columns or fewer opens on List. */
export const MAX_BOARD_COLUMNS_FOR_LIST_DEFAULT = 3;

export function resolveInitialTicketView<View extends string>({
  explicitView,
  defaultView,
  boardColumnCount,
}: {
  /** A view already chosen for this entry — restored session state (e.g.
   *  coming back from a ticket), a hand-off from another screen, or the
   *  user's own click. Always wins over the automatic default. */
  explicitView: View | null;
  /** The existing default (the user's Profile preference). */
  defaultView: View;
  /** The columns the Board would really render for this project. */
  boardColumnCount: number;
}): View | "list" {
  if (explicitView !== null) return explicitView;
  return boardColumnCount <= MAX_BOARD_COLUMNS_FOR_LIST_DEFAULT ? "list" : defaultView;
}
