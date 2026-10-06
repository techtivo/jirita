import { describe, expect, it, vi } from "vitest";
import { shouldSubmitOnEnter, hasUnpublishedCommentDraft } from "@/lib/comment-composer";
import type { EnterKeyEvent, EnterKeyContext } from "@/lib/comment-composer";
import { hasCommentContent } from "@/lib/comment-paste";
import { createLeaveGuard, inAppLinkDestination } from "@/lib/unsaved-changes";
import type { LinkClick } from "@/lib/unsaved-changes";

const enter: EnterKeyEvent = { key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false };
const typing: EnterKeyContext = { suggestionActive: false, inStructuralBlock: false, touchKeyboard: false };

describe("comment composer — Enter (JIR-93)", () => {
  it("plain Enter submits", () => {
    expect(shouldSubmitOnEnter(enter, typing)).toBe(true);
  });

  it("Shift+Enter never submits — it stays a newline", () => {
    expect(shouldSubmitOnEnter({ ...enter, shiftKey: true }, typing)).toBe(false);
  });

  it("other modified Enters and other keys are left to the editor", () => {
    expect(shouldSubmitOnEnter({ ...enter, ctrlKey: true }, typing)).toBe(false);
    expect(shouldSubmitOnEnter({ ...enter, metaKey: true }, typing)).toBe(false);
    expect(shouldSubmitOnEnter({ ...enter, altKey: true }, typing)).toBe(false);
    expect(shouldSubmitOnEnter({ ...enter, key: "a" }, typing)).toBe(false);
  });

  it("never submits during IME composition", () => {
    expect(shouldSubmitOnEnter({ ...enter, isComposing: true }, typing)).toBe(false);
    expect(shouldSubmitOnEnter({ ...enter, keyCode: 229 }, typing)).toBe(false);
  });

  it("holding Enter down doesn't fire repeated submits", () => {
    expect(shouldSubmitOnEnter({ ...enter, repeat: true }, typing)).toBe(false);
  });

  it("leaves Enter alone where it already means something else", () => {
    expect(shouldSubmitOnEnter(enter, { ...typing, suggestionActive: true })).toBe(false); // picks the @mention
    expect(shouldSubmitOnEnter(enter, { ...typing, inStructuralBlock: true })).toBe(false); // next list item / code line
    expect(shouldSubmitOnEnter(enter, { ...typing, touchKeyboard: true })).toBe(false); // no Shift+Enter on touch
  });
});

// The composer's own submit handler: same guards submitComment has, so the
// Enter path can be exercised end to end without the editor.
function makeComposer() {
  const state = { open: true, isTextEmpty: true, attachmentCount: 0, submitting: false };
  const post = vi.fn();
  return {
    state,
    post,
    type(isTextEmpty: boolean) {
      state.isTextEmpty = isTextEmpty;
    },
    /** What the editor's onSubmit calls. */
    submit() {
      if (!hasCommentContent(state.isTextEmpty, state.attachmentCount) || state.submitting) return;
      state.submitting = true;
      post();
    },
    posted() {
      state.submitting = false;
      state.isTextEmpty = true;
      state.attachmentCount = 0;
      state.open = false;
    },
    pressEnter(event: EnterKeyEvent = enter) {
      if (shouldSubmitOnEnter(event, typing)) this.submit();
    },
  };
}

describe("comment composer — submitting with Enter", () => {
  it("Enter with a valid comment posts it once", () => {
    const composer = makeComposer();
    composer.type(false);
    composer.pressEnter();
    expect(composer.post).toHaveBeenCalledTimes(1);
  });

  it("Enter on an empty / whitespace-only comment posts nothing", () => {
    const composer = makeComposer();
    composer.pressEnter();
    expect(composer.post).not.toHaveBeenCalled();
  });

  it("Enter while a submission is in flight doesn't post twice", () => {
    const composer = makeComposer();
    composer.type(false);
    composer.pressEnter();
    composer.pressEnter();
    expect(composer.post).toHaveBeenCalledTimes(1);
  });

  it("Shift+Enter and IME Enter post nothing", () => {
    const composer = makeComposer();
    composer.type(false);
    composer.pressEnter({ ...enter, shiftKey: true });
    composer.pressEnter({ ...enter, isComposing: true });
    expect(composer.post).not.toHaveBeenCalled();
  });
});

describe("unpublished comment draft (JIR-93)", () => {
  const closed = { open: false, isTextEmpty: true, attachmentCount: 0 };

  it("text or staged files in an open composer is a draft", () => {
    expect(hasUnpublishedCommentDraft([{ open: true, isTextEmpty: false, attachmentCount: 0 }, closed])).toBe(true);
    expect(hasUnpublishedCommentDraft([{ open: true, isTextEmpty: true, attachmentCount: 2 }, closed])).toBe(true);
    // A reply draft counts just like a new comment.
    expect(hasUnpublishedCommentDraft([closed, { open: true, isTextEmpty: false, attachmentCount: 0 }])).toBe(true);
  });

  it("an opened/focused but empty (or whitespace-only) composer is not", () => {
    expect(hasUnpublishedCommentDraft([{ open: true, isTextEmpty: true, attachmentCount: 0 }, closed])).toBe(false);
    expect(hasUnpublishedCommentDraft([closed, closed])).toBe(false);
    expect(hasUnpublishedCommentDraft([])).toBe(false);
  });
});

// A minimal host for the guard: stores the held navigation the way the
// hook's state does, and derives isDirty from a real composer draft.
function makeScreen() {
  const composer = makeComposer();
  let pending: (() => void) | null = null;
  const discard = vi.fn(() => composer.posted()); // cancelComment: clears the draft
  const guard = () =>
    createLeaveGuard({
      isDirty: hasUnpublishedCommentDraft([composer.state]),
      pending,
      setPending: (p) => {
        pending = p;
      },
      onDiscard: discard,
    });
  return { composer, discard, guard, confirmOpen: () => pending !== null };
}

describe("leave guard (JIR-93)", () => {
  it("empty comment: navigation proceeds immediately, no confirmation", () => {
    const screen = makeScreen();
    const navigate = vi.fn();
    screen.guard().requestLeave(navigate);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(screen.confirmOpen()).toBe(false);
  });

  it("unpublished comment: navigation is held and a confirmation opens", () => {
    const screen = makeScreen();
    screen.composer.type(false);
    const navigate = vi.fn();
    screen.guard().requestLeave(navigate);
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.confirmOpen()).toBe(true);
  });

  it("Keep editing: stays on the ticket with the draft intact", () => {
    const screen = makeScreen();
    screen.composer.type(false);
    const navigate = vi.fn();
    screen.guard().requestLeave(navigate);
    screen.guard().keepEditing();
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.discard).not.toHaveBeenCalled();
    expect(screen.confirmOpen()).toBe(false);
    expect(hasUnpublishedCommentDraft([screen.composer.state])).toBe(true);
  });

  it("Discard: clears the draft and runs the held navigation once, without asking again", () => {
    const screen = makeScreen();
    screen.composer.type(false);
    const navigate = vi.fn();
    screen.guard().requestLeave(navigate);
    screen.guard().confirmLeave();
    expect(screen.discard).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(screen.confirmOpen()).toBe(false);
    // The draft is gone, so the next navigation isn't interrupted.
    const next = vi.fn();
    screen.guard().requestLeave(next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(screen.confirmOpen()).toBe(false);
  });

  it("a successfully posted comment clears the protection", () => {
    const screen = makeScreen();
    screen.composer.type(false);
    screen.composer.pressEnter();
    screen.composer.posted();
    const navigate = vi.fn();
    screen.guard().requestLeave(navigate);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(screen.confirmOpen()).toBe(false);
  });
});

describe("in-app link detection", () => {
  const here = "https://jirita.test/projects/jirita/tickets/JIR-93";
  const click: LinkClick = {
    href: "https://jirita.test/projects/jirita/tickets",
    target: "",
    download: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
  };

  it("guards a plain click to another in-app page", () => {
    expect(inAppLinkDestination(click, here)).toBe("/projects/jirita/tickets");
    expect(inAppLinkDestination({ ...click, href: "https://jirita.test/reports?tab=team#x" }, here)).toBe("/reports?tab=team#x");
  });

  it("ignores clicks that don't leave this tab's current page", () => {
    expect(inAppLinkDestination({ ...click, metaKey: true }, here)).toBeNull(); // new tab
    expect(inAppLinkDestination({ ...click, ctrlKey: true }, here)).toBeNull();
    expect(inAppLinkDestination({ ...click, button: 1 }, here)).toBeNull(); // middle click
    expect(inAppLinkDestination({ ...click, target: "_blank" }, here)).toBeNull();
    expect(inAppLinkDestination({ ...click, download: true }, here)).toBeNull();
    expect(inAppLinkDestination({ ...click, href: here + "#comments" }, here)).toBeNull(); // same page
    expect(inAppLinkDestination({ ...click, defaultPrevented: true }, here)).toBeNull();
  });

  it("leaves other origins to the browser's own unload prompt", () => {
    expect(inAppLinkDestination({ ...click, href: "https://github.com/techtivo/jirita/pull/1" }, here)).toBeNull();
    expect(inAppLinkDestination({ ...click, href: "not a url" }, here)).toBeNull();
  });
});
