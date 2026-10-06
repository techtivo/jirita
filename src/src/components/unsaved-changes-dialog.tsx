"use client";

// Shared "discard unsaved changes?" confirmation — only ever shown for a
// real, explicit abandon action (closing a modal, Cancel, navigating to a
// different entity that would destroy the form). Never shown for a tab
// switch, window-focus/blur, or visibilitychange regain — those aren't
// "leaving the form" and must never trigger this.

export function UnsavedChangesDialog({
  open,
  onKeepEditing,
  onDiscard,
  title = "Unsaved changes",
  message = "You have unsaved changes. Discard them?",
  discardLabel = "Discard changes",
}: {
  open: boolean;
  onKeepEditing: () => void;
  onDiscard: () => void;
  /** Copy overrides for a caller whose "changes" are something more
   *  specific (e.g. an unpublished comment). Defaults are unchanged. */
  title?: string;
  message?: string;
  discardLabel?: string;
}) {
  if (!open) return null;

  return (
    <div
      aria-hidden
      onClick={onKeepEditing}
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/40 dark:bg-black/60"
    >
      <div
        role="alertdialog"
        aria-modal
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm bg-white dark:bg-zinc-950 rounded-2xl border border-slate-200 dark:border-zinc-800 shadow-2xl shadow-black/20 dark:shadow-black/60 p-5"
      >
        <h3 className="text-[15px] font-semibold text-slate-900 dark:text-zinc-50">{title}</h3>
        <p className="text-[13px] text-slate-500 dark:text-zinc-400 mt-1.5 leading-relaxed">
          {message}
        </p>
        <div className="flex items-center justify-end gap-2 mt-5">
          <button
            type="button"
            onClick={onKeepEditing}
            className="px-3.5 py-2 text-[13px] font-medium text-slate-600 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 rounded-lg transition-colors"
          >
            Keep editing
          </button>
          <button
            type="button"
            onClick={onDiscard}
            className="px-3.5 py-2 text-[13px] font-semibold rounded-lg bg-red-600 hover:bg-red-700 text-white transition-colors"
          >
            {discardLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
