// Pure rules for the ticket comment composers (JIR-93): when Enter posts,
// and when an unpublished draft is worth protecting. Kept free of React /
// editor / DOM types so both are unit-testable.

/** The subset of a keydown event the Enter rule reads. */
export interface EnterKeyEvent {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  /** IME composition in progress (also signalled by keyCode 229). */
  isComposing: boolean;
  keyCode?: number;
  /** Auto-repeat from holding the key down. */
  repeat?: boolean;
}

export interface EnterKeyContext {
  /** The @mention picker is open — Enter picks a person there. */
  suggestionActive: boolean;
  /** Cursor is inside a list item / task item / code block, where Enter
   *  keeps its structural meaning (next item / next code line). */
  inStructuralBlock: boolean;
  /** Touch keyboard (no practical Shift+Enter) — Enter stays a newline and
   *  the Comment button posts. */
  touchKeyboard: boolean;
}

/**
 * Plain Enter posts the comment. Shift+Enter (and any other modified
 * Enter) is left to the editor, i.e. a newline. Never during IME
 * composition, never on key auto-repeat, and never when Enter already
 * means something else at the cursor (see EnterKeyContext).
 */
export function shouldSubmitOnEnter(event: EnterKeyEvent, context: EnterKeyContext): boolean {
  if (event.key !== "Enter") return false;
  if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
  if (event.isComposing || event.keyCode === 229) return false;
  if (event.repeat) return false;
  if (context.suggestionActive || context.inStructuralBlock || context.touchKeyboard) return false;
  return true;
}

/** One open composer's draft, already reduced to what "meaningful" needs. */
export interface ComposerDraft {
  /** The composer is currently open (a closed one holds no draft). */
  open: boolean;
  /** No visible text — whitespace-only/empty markup counts as empty. */
  isTextEmpty: boolean;
  /** Files staged on the draft, not yet uploaded. */
  attachmentCount: number;
}

/**
 * Whether any open composer holds meaningful unpublished content — text
 * or staged files. Merely opening/focusing a composer is not a draft.
 */
export function hasUnpublishedCommentDraft(drafts: ComposerDraft[]): boolean {
  return drafts.some((d) => d.open && (!d.isTextEmpty || d.attachmentCount > 0));
}
