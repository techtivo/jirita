"use client";

import { useRouter } from "next/navigation";

export function BackToTicketsButton({
  onRequestBack,
}: {
  /** Lets the screen hold the navigation behind its own confirmation (e.g.
   *  an unpublished comment, JIR-93) — call `proceed` to actually go back.
   *  Omitted: goes back immediately, as before. */
  onRequestBack?: (proceed: () => void) => void;
} = {}) {
  const router = useRouter();
  const goBack = () => router.back();

  return (
    <button
      onClick={() => (onRequestBack ? onRequestBack(goBack) : goBack())}
      className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-zinc-100 transition-colors"
    >
      <svg
        className="w-4 h-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path d="M15 18l-6-6 6-6" />
      </svg>
      Back
    </button>
  );
}
