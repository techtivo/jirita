"use client";

// Shared "unsaved changes" primitives — the one reusable answer to "a form
// must never lose local edits to a background refresh/refetch/remount."
// See CLAUDE.md/PROJECT_STATUS.md for the incident this exists to prevent:
// project-settings-screen.tsx used to resync every field from the server
// (applyProject) whenever `organization`'s object reference changed, which
// happens on every window-focus regain (current-user-provider.tsx's own
// session-revalidation effect) — not just on a real navigation or an actual
// data change. Any caller that fetches fresh data into an editable form
// should route the "should I overwrite local state right now" decision
// through here instead of re-deriving its own ad hoc guard.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Shows the browser's own native "leave site?" prompt only on a real
 * unload attempt (tab close, hard navigation, reload) — never on a tab
 * switch, window-focus/blur, or visibilitychange, since `beforeunload`
 * simply doesn't fire for those.
 */
export function useUnsavedChangesWarning(isDirty: boolean) {
  useEffect(() => {
    if (!isDirty) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      // Chrome/legacy: a truthy returnValue is what actually triggers the
      // native prompt — the string itself is never shown (browsers supply
      // their own fixed copy).
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDirty]);
}

// ── sessionStorage draft persistence ────────────────────────────────────────
// Second-layer protection for the highest-value forms (Create/Edit Ticket):
// if the component ever does get unmounted/remounted unexpectedly within the
// same browser session, the draft survives that. Only ever holds
// JSON-serializable fields — never File/Blob objects (see each caller's own
// "what's excluded" note).

function readDraft<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeDraft<T>(key: string, value: T) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Best-effort only (private browsing/storage-full can throw) — losing
    // the draft-recovery safety net is never worse than the status quo.
  }
}

function clearDraft(key: string) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // see writeDraft
  }
}

/** Reads a previously-saved draft once — call this from a lazy `useState`
 *  initializer (or similar mount-time-only read) on the entity's own key,
 *  never from an effect that could re-run mid-session. */
export function loadDraft<T>(key: string): T | null {
  return readDraft<T>(key);
}

/**
 * Keeps sessionStorage[key] in sync with `value` while `enabled` (i.e. the
 * form is actually dirty) — call `clear()` after a successful Save or an
 * explicit Discard so a stale draft never resurfaces on the next visit.
 *
 * Also clears the key itself the moment `enabled` goes false while content
 * still exists there (e.g. the user manually deletes everything they'd
 * typed, back to blank) — otherwise a stale, no-longer-true draft from
 * before that edit would keep sitting in storage and could resurface on
 * the next mount even though the user never confirmed a Discard.
 */
export function useDraftAutosave<T>(key: string | null, value: T, enabled: boolean) {
  useEffect(() => {
    if (!key) return;
    if (enabled) {
      writeDraft(key, value);
    } else {
      clearDraft(key);
    }
  }, [key, value, enabled]);

  // A fresh closure each render (over the current `key`) rather than a
  // ref — this hook already re-renders whenever `key` changes, so there's
  // no stale-closure risk, and it keeps every read of `key` a plain render
  // value instead of a ref access.
  return {
    clear: () => { if (key) clearDraft(key); },
  };
}

// ── Leave guard (in-app navigation) ─────────────────────────────────────────
// `beforeunload` above only covers a real unload. Next's App Router has no
// route-blocking API, so leaving a dirty screen through the app itself is
// guarded at the two places a screen can actually see it coming: its own
// navigation controls (requestLeave) and clicks on in-app links
// (useLeaveGuard's capture listener). Not a global navigation framework —
// a screen opts in for its own draft only.

export interface LeaveGuard {
  /** Run `proceed` now when there's nothing to lose; otherwise hold it and
   *  ask for confirmation. */
  requestLeave: (proceed: () => void) => void;
  /** Dismiss the confirmation; the held navigation is dropped and the
   *  draft is left exactly as it was. */
  keepEditing: () => void;
  /** Discard the draft and run the held navigation — once, without
   *  asking again. */
  confirmLeave: () => void;
}

/** The guard's whole decision logic, free of React so it can be tested —
 *  the caller owns where `pending` (the held navigation) is stored. */
export function createLeaveGuard(options: {
  isDirty: boolean;
  pending: (() => void) | null;
  setPending: (pending: (() => void) | null) => void;
  onDiscard: () => void;
}): LeaveGuard {
  return {
    requestLeave(proceed) {
      if (!options.isDirty) {
        proceed();
        return;
      }
      options.setPending(proceed);
    },
    keepEditing() {
      options.setPending(null);
    },
    confirmLeave() {
      const proceed = options.pending;
      options.setPending(null);
      options.onDiscard();
      proceed?.();
    },
  };
}

/** What the link guard reads off a click + the anchor it landed on. */
export interface LinkClick {
  /** The anchor's resolved absolute URL (`HTMLAnchorElement.href`). */
  href: string;
  target: string;
  download: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}

/**
 * The in-app destination a link click would navigate this tab to, or null
 * when the click doesn't leave the current screen in this tab: new
 * tab/window (target, modifier keys, middle click), a download, another
 * origin (a real unload — `beforeunload` covers it), or the same page
 * (hash-only / identical URL).
 */
export function inAppLinkDestination(click: LinkClick, currentHref: string): string | null {
  if (click.defaultPrevented || click.button !== 0) return null;
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return null;
  if (click.download || (click.target !== "" && click.target !== "_self")) return null;
  let destination: URL;
  let current: URL;
  try {
    destination = new URL(click.href);
    current = new URL(currentHref);
  } catch {
    return null;
  }
  if (destination.origin !== current.origin) return null;
  if (destination.pathname === current.pathname && destination.search === current.search) return null;
  return destination.pathname + destination.search + destination.hash;
}

/**
 * Protects a screen's own unsaved draft against leaving: the native prompt
 * on unload/reload, and a confirmation (render UnsavedChangesDialog with
 * `confirmOpen`) for in-app link clicks and for the screen's own
 * navigation controls routed through `requestLeave`. Does nothing at all
 * while `isDirty` is false.
 */
export function useLeaveGuard(isDirty: boolean, onDiscard: () => void): LeaveGuard & { confirmOpen: boolean } {
  const router = useRouter();
  // The held navigation, while its confirmation is showing.
  const [pending, setPending] = useState<{ proceed: () => void } | null>(null);
  const guard = createLeaveGuard({
    isDirty,
    pending: pending?.proceed ?? null,
    setPending: (proceed) => setPending(proceed ? { proceed } : null),
    onDiscard,
  });

  useUnsavedChangesWarning(isDirty);

  // In-app links (<Link>/<a>) anywhere on the page — sidebar, breadcrumb,
  // other tickets. Capture phase on the document, so it runs before the
  // link's own handler; only attached while there is something to lose.
  useEffect(() => {
    if (!isDirty) return;
    function onClick(e: MouseEvent) {
      const anchor = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!anchor) return;
      const destination = inAppLinkDestination(
        {
          href: anchor.href,
          target: anchor.target,
          download: anchor.hasAttribute("download"),
          button: e.button,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          defaultPrevented: e.defaultPrevented,
        },
        window.location.href
      );
      if (!destination) return;
      e.preventDefault();
      e.stopPropagation();
      // Only attached while dirty, so this click always needs confirming.
      setPending({ proceed: () => router.push(destination) });
    }
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [isDirty, router]);

  return { ...guard, confirmOpen: pending !== null };
}
