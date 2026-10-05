// Pure helpers behind "an image pasted into a comment belongs to that
// comment" (JIR-41). Deliberately free of React/DOM globals so the routing
// rules themselves are unit-testable in the plain Node Vitest environment.
//
// Why "claiming" instead of asking "is the comment editor focused?": when
// the clipboard carries only a file (a screenshot — no text/html),
// ProseMirror's own paste handler moves focus to a temporary off-screen
// element *during the paste event itself*. The editor therefore reports a
// blur before a document-level listener ever runs, so any focus-based
// check sees "no comment editor is focused" and the image falls through to
// the general ticket Attachments section. Each comment composer instead
// claims the paste in the capture phase (before ProseMirror touches
// focus); the page-level fallback then simply skips claimed events.

type PastedItemLike = { kind: string; getAsFile: () => File | null };
type PasteEventLike = { clipboardData: { items?: ArrayLike<PastedItemLike> | null } | null };

/** Every real file (image or otherwise) carried by a paste event — empty
 *  for an ordinary text paste. */
export function extractPastedFiles(event: PasteEventLike): File[] {
  const items = event.clipboardData?.items;
  if (!items) return [];
  const files: File[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

const claimedPasteEvents = new WeakSet<object>();

/** Called by a comment composer (new comment, reply, or edit) in the
 *  capture phase: returns the pasted files and marks the event as owned by
 *  that comment. A paste with no files (plain text) is never claimed and
 *  returns [] — the caller must not preventDefault either way, so text in
 *  the same clipboard still pastes normally. */
export function claimPastedFiles(event: PasteEventLike): File[] {
  const files = extractPastedFiles(event);
  if (files.length > 0) claimedPasteEvents.add(event);
  return files;
}

/** True once a comment composer has taken this paste's files — the
 *  page-level handler must then leave it alone instead of also creating a
 *  general ticket attachment. */
export function isPasteClaimed(event: object): boolean {
  return claimedPasteEvents.has(event);
}

/** A comment is postable with text, with at least one attachment, or
 *  both — never with neither. */
export function hasCommentContent(isTextEmpty: boolean, attachmentCount: number): boolean {
  return !isTextEmpty || attachmentCount > 0;
}

/** Only meaningful for a comment posted with no text at all: if every one
 *  of its attachments then failed to upload, nothing of the comment is
 *  left and the caller should remove the empty shell rather than leave a
 *  blank comment behind. */
export function isEmptyCommentShell(isTextEmpty: boolean, attemptedCount: number, failedCount: number): boolean {
  return isTextEmpty && attemptedCount > 0 && failedCount >= attemptedCount;
}
