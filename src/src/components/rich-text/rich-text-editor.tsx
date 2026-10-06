"use client";

// The one reusable rich-text editor for the whole app — Ticket Description
// is its first real caller, but nothing here is Description-specific.
// Comments/Project Notes/Documentation should mount this same component
// rather than a second implementation. `content`/`onChange` are HTML
// strings (see rich-text-utils.ts); this component never talks to Supabase
// or any particular field's save action itself — that stays the caller's
// job, same as a plain <textarea> would.

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TextStyle } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import Highlight from "@tiptap/extension-highlight";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Placeholder from "@tiptap/extension-placeholder";
import Mention from "@tiptap/extension-mention";
import { useEffect, useLayoutEffect, useRef } from "react";
import { shouldSubmitOnEnter } from "@/lib/comment-composer";
import { normalizeRichText } from "./rich-text-utils";
import { RichTextToolbar } from "./rich-text-toolbar";
import { buildMentionSuggestion } from "./mention-suggestion";
import type { MentionCandidate } from "./mention-types";

export type { MentionCandidate };

export function RichTextEditor({
  content,
  onChange,
  onFocus,
  onBlur,
  placeholder = "Write something…",
  autoFocus = false,
  className,
  contentClassName,
  mentionCandidates,
  onSubmit,
}: {
  /** Initial HTML (or legacy plain text — normalized transparently). Only
   *  read once, on mount; remount via a `key` change to load new content
   *  into a fresh editor instance, same convention a plain <textarea>
   *  would need for an uncontrolled value. */
  content: string;
  /** Called with the editor's current HTML on every change. */
  onChange: (html: string) => void;
  /** Mirrors the underlying editor's own focus state — e.g. so a caller can
   *  tell "is the user actively typing here right now" (contextual paste
   *  routing, an active-state indicator, etc.) without reaching into
   *  ProseMirror internals itself. */
  onFocus?: () => void;
  onBlur?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
  /** Extra classes for the actual editable content element — every real
   *  field sets its own text size here (Description: 14px, Comments: 13px)
   *  since this component deliberately has no size opinion of its own
   *  beyond the mobile iOS-zoom-prevention default below. */
  contentClassName?: string;
  /** Enables @mention support (typing "@" opens a picker over these real,
   *  active project members) when — and only when — this is passed at all;
   *  omit entirely for fields that shouldn't support mentions (e.g.
   *  Description) to leave them completely unaffected. Comments passes the
   *  ticket's own real project roster. */
  mentionCandidates?: MentionCandidate[];
  /** Makes plain Enter call this instead of starting a new paragraph
   *  (Shift+Enter still inserts a line break) — for composers whose Enter
   *  means "post" (comments, JIR-93). Omit for every other field: Enter
   *  then behaves exactly as before. See shouldSubmitOnEnter for when
   *  Enter is deliberately left alone (IME, @mention picker, lists, code
   *  blocks, touch keyboards). */
  onSubmit?: () => void;
}) {
  // The Mention extension itself is only ever configured once, at mount
  // (below) — but the roster it searches can still arrive asynchronously
  // after that (a fetch already in flight when this editor mounts), so
  // its own items() callback always reads the freshest list via this ref
  // rather than a value captured once at construction time.
  const mentionCandidatesRef = useRef<MentionCandidate[]>(mentionCandidates ?? []);
  useEffect(() => {
    mentionCandidatesRef.current = mentionCandidates ?? [];
  }, [mentionCandidates]);

  // Read at keydown time, never captured at editor-mount time — the caller's
  // handler closes over its latest draft/in-flight state. Layout effect, so
  // it's current before the next key event can arrive.
  const onSubmitRef = useRef(onSubmit);
  useLayoutEffect(() => {
    onSubmitRef.current = onSubmit;
  });

  const editor = useEditor({
    // Next.js renders client components once on the server too —
    // Tiptap's own SSR content would then mismatch the client's first
    // render (ProseMirror decorates the DOM in ways React can't predict).
    // false means the first real render only ever happens client-side.
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        link: {
          openOnClick: false,
          HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" },
        },
      }),
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      TaskList,
      TaskItem.configure({ nested: false }),
      Placeholder.configure({ placeholder }),
      // Presence of the prop (not its length) decides whether this field
      // supports mentions at all — an empty array while the roster is
      // still loading still gets the extension, since mentionCandidatesRef
      // will pick up the real list the moment it arrives.
      ...(mentionCandidates !== undefined
        ? [
            Mention.configure({
              HTMLAttributes: { class: "mention" },
              // eslint-disable-next-line react-hooks/refs -- intentional: this closure is only ever invoked later, inside Suggestion's own async items() callback (fired on each "@" keystroke, never during render) — it never dereferences mentionCandidatesRef.current synchronously here
              suggestion: buildMentionSuggestion(() => mentionCandidatesRef.current),
            }),
          ]
        : []),
    ],
    content: normalizeRichText(content),
    editorProps: {
      attributes: {
        class:
          "jirita-rich-text jirita-rich-text-editable text-[16px] focus:outline-none " +
          (contentClassName ?? ""),
      },
      // View-level handler: runs before every plugin keymap (including the
      // @mention picker's), so shouldSubmitOnEnter is told about each case
      // where Enter must keep its existing meaning.
      handleKeyDown: (view, event) => {
        const submit = onSubmitRef.current;
        if (!submit) return false;
        const { $from } = view.state.selection;
        let inStructuralBlock = false;
        for (let depth = $from.depth; depth > 0; depth--) {
          const name = $from.node(depth).type.name;
          if (name === "listItem" || name === "taskItem" || name === "codeBlock") {
            inStructuralBlock = true;
            break;
          }
        }
        const shouldSubmit = shouldSubmitOnEnter(event, {
          // Tiptap's Suggestion plugin wraps the "@query" being typed in
          // a `.suggestion` decoration for exactly as long as its picker
          // owns Enter.
          suggestionActive: view.dom.querySelector(".suggestion") !== null,
          inStructuralBlock,
          touchKeyboard: typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches,
        });
        if (!shouldSubmit) return false;
        event.preventDefault();
        submit();
        return true;
      },
    },
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
    onFocus: () => onFocus?.(),
    onBlur: () => onBlur?.(),
  });

  useEffect(() => {
    if (autoFocus) editor?.commands.focus("end");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires once when the editor instance first becomes available
  }, [editor]);

  if (!editor) return null;

  return (
    <div
      className={
        "rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 overflow-hidden " +
        "focus-within:border-brand-500 dark:focus-within:border-brand-accent focus-within:ring-1 focus-within:ring-brand-500/30 dark:focus-within:ring-brand-accent/30 " +
        (className ?? "")
      }
    >
      <RichTextToolbar editor={editor} />
      <EditorContent editor={editor} className="px-3 py-2.5 max-h-[60vh] overflow-y-auto" />
    </div>
  );
}
