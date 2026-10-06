"use client";

import {
  useState,
  useRef,
  useEffect,
  useMemo,
  forwardRef,
  useImperativeHandle,
  type KeyboardEvent,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ThumbsUp, ThumbsDown, Eye, EyeOff, CornerUpLeft, CornerDownRight } from "lucide-react";
import type { Ticket, TicketStatus, TicketPriority, TicketType } from "@/lib/mock-tickets";
import { tickets as ALL_TICKETS, getTicketDisplayKey } from "@/lib/mock-tickets";
import {
  StatusBadge,
  PriorityBadge,
  LabelTag,
  TicketTypeIcon,
  TicketTypeSelect,
  PRIORITY_LABEL,
  buildLabelCatalog,
  EDIT_BTN,
  INPUT_BASE,
  PencilIcon,
  CalendarIcon,
  parseDisplayDate,
  formatISODate,
  getTodayISO,
  EditableStatusBadge,
  EditableDescription,
  ErrorToast,
} from "@/components/tickets/ticket-ui";
import { BackToTicketsButton } from "@/components/tickets/back-to-tickets-button";
import { NewTicketModal } from "@/components/tickets/new-ticket-modal";
import { CloseParentConfirmModal } from "@/components/tickets/close-parent-confirm-modal";
import { MoveTicketModal } from "@/components/tickets/move-ticket-modal";
import { AcceptanceCriteriaFields } from "@/components/tickets/acceptance-criteria-fields";
import { getRegisteredTicketByCode } from "@/lib/pending-tickets";
import {
  loadTicketByCode,
  resolveTicketRouteAlias,
  ticketRouteRedirectTarget,
  loadTicketComments,
  loadTicketActivity,
  createTicketComment,
  updateTicketComment,
  deleteTicketComment,
  groupCommentThreads,
  setCommentReaction,
  updateTicket,
  loadOrganizationLabels,
  createOrganizationLabel,
  loadTicketAttachments,
  uploadTicketAttachment,
  downloadTicketAttachment,
  resolveTicketAttachmentPreviewUrl,
  resolveTicketAttachmentThumbnailUrl,
  renameTicketAttachment,
  deleteTicketAttachment,
  loadTicketTimeEntries,
  logTicketTime,
  updateTicketTimeEntry,
  deleteTicketTimeEntry,
  loadProjectTickets,
  loadTicketRelations,
  createTicketRelation,
  deleteTicketRelation,
  loadTicketSubscriptionState,
  setTicketSubscription,
  formatRelativeTime,
  STATUS_FROM_DB,
  FALLBACK_TICKET_STATUSES,
  loadTicketHierarchy,
  countOpenChildTickets,
  type TicketComment,
  type CommentReactionType,
  type TicketActivityEvent,
  type UpdateTicketInput,
  type TicketAttachment,
  type TimeEntryRecord,
  type LogTimeInput,
  type RelatedTicket,
  type TicketRelationKind,
  type TicketStatusOption,
  type TicketParentSummary,
  type TicketChildSummary,
} from "@/lib/tickets";
import { loadProjectTeam, loadProjectDetail, type OrgMember, type ProjectTeamMember } from "@/lib/projects";
import type { Sprint } from "@/lib/sprints";
import {
  SPRINT_BACKLOG_BADGE_CLASS,
  SPRINT_ACTIVE_BADGE_CLASS,
  SPRINT_CLOSED_BADGE_CLASS,
} from "@/components/tickets/sprint-context-selector";
import { formatAbsoluteDate } from "@/lib/date-format";
import { FALLBACK_AVATAR } from "@/lib/current-user";
import { formatHours } from "@/components/time-tracking-screen";
import { MemberTrigger } from "@/components/member-profile";
import { RichTextEditor, type MentionCandidate } from "@/components/rich-text/rich-text-editor";
import { ImageViewerToolbar, ImageViewerCanvas } from "@/components/image-viewer";
import { RichTextViewer } from "@/components/rich-text/rich-text-viewer";
import { sanitizeRichTextHtml, isRichTextEmpty } from "@/components/rich-text/rich-text-utils";
import { claimPastedFiles, extractPastedFiles, hasCommentContent, isEmptyCommentShell, isPasteClaimed } from "@/lib/comment-paste";
import { Avatar } from "@/components/ui/avatar";
import { useCurrentUser } from "@/components/current-user-provider";
import { useOrganizationProjects } from "@/components/organization-projects-provider";
import { getSupabaseBrowserClient } from "@/lib/supabase-client";
import { SkeletonBlock } from "@/components/dashboard-shared";
import {
  loadTicketDevelopmentActivityAction,
  type TicketDevelopmentResult,
  type DevelopmentPullRequestState,
} from "@/lib/server/ticket-development-actions";

// ── Constants ─────────────────────────────────────────────────────────────────

const MILESTONES = ["App Store Submission", "Beta Release", "Security Audit"];

// Attachments data lives inside AttachmentsSection state (see below)

// ── Shared style tokens ───────────────────────────────────────────────────────

const SECTION_LABEL =
  "text-[11px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600";

// ── Sidebar layout ────────────────────────────────────────────────────────────

function SidebarField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="py-3.5 border-b border-slate-100 dark:border-zinc-800/70 last:border-0">
      <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600 mb-1.5">
        {label}
      </p>
      <div className="text-[13px] font-medium text-slate-800 dark:text-zinc-200">{children}</div>
    </div>
  );
}

// ── Editable: Title ───────────────────────────────────────────────────────────

function EditableTitle({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const save = () => { onChange(draft.trim() || value); setEditing(false); };
  const cancel = () => { setDraft(value); setEditing(false); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); save(); }
    if (e.key === "Escape") cancel();
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className={
          "w-full text-[22px] font-bold text-slate-900 dark:text-zinc-50 leading-snug tracking-tight " +
          "bg-transparent border-0 border-b-2 border-brand-500 outline-none pb-0.5 dark:border-brand-accent"
        }
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={onKey}
      />
    );
  }

  return (
    <div className="group flex items-start gap-0">
      <h1
        className="text-[22px] font-bold text-slate-900 dark:text-zinc-50 leading-snug tracking-tight cursor-text"
        onClick={() => { setDraft(value); setEditing(true); }}
      >
        {value}
      </h1>
      <button
        className={EDIT_BTN + " mt-1"}
        onClick={() => { setDraft(value); setEditing(true); }}
        aria-label="Edit title"
      >
        <PencilIcon />
      </button>
    </div>
  );
}

// ── Editable: Sidebar Status ──────────────────────────────────────────────────

function EditableSidebarStatus({
  value,
  statusId,
  label,
  statuses,
  onChange,
  isSubscribed,
  onToggleSubscribe,
}: {
  value: TicketStatus;
  /** Real ticket_statuses.id (Fase 2.5) — see EditableStatusBadge's own doc
   *  (ticket-ui.tsx) for why this is the primary match, with legacy-value
   *  matching only as a mock/dev-fallback fallback. */
  statusId?: string;
  /** Real ticket_statuses.name for the current value — falls back to
   *  STATUS_LABEL[value] when not given. */
  label?: string;
  /** Real, ordered per-project ticket_statuses (Fase 2) — falls back to
   *  FALLBACK_TICKET_STATUSES (identical to the old fixed list) while not
   *  yet loaded. */
  statuses?: TicketStatusOption[];
  /** Fires with the chosen real status row — see EditableStatusBadge's own
   *  onChange doc (ticket-ui.tsx) for why this is a full option, not just
   *  the legacy TicketStatus value. */
  onChange: (option: TicketStatusOption) => void;
  /** The viewer's own manual ticket_subscribers state — null while not yet
   *  loaded (icon hidden, same as its previous home in the header row). */
  isSubscribed?: boolean | null;
  /** Toggles the viewer's own subscription — undefined/omitted hides the
   *  icon entirely (never rendered mid-way through a missing handler). */
  onToggleSubscribe?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLSelectElement>(null);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);
  const options = statuses && statuses.length > 0 ? statuses : FALLBACK_TICKET_STATUSES;

  return (
    <SidebarField label="Status">
      {editing ? (
        (() => {
          const currentOption = statusId
            ? options.find((option) => option.id === statusId)
            : options.find((option) => option.legacyEnumValue && STATUS_FROM_DB[option.legacyEnumValue] === value);
          return (
            <select
              ref={ref}
              className={INPUT_BASE + " py-0.5 text-[16px] sm:text-[12px]"}
              value={currentOption?.id ?? value}
              onChange={(e) => {
                const chosen = options.find((option) => option.id === e.target.value);
                if (chosen) onChange(chosen);
                setEditing(false);
              }}
              onBlur={() => setEditing(false)}
              onKeyDown={(e) => { if (e.key === "Escape") setEditing(false); }}
            >
              {options.map((option) => (
                <option key={option.id} value={option.id}>{option.name}</option>
              ))}
            </select>
          );
        })()
      ) : (
        <div className="group flex items-center gap-1.5 cursor-pointer" onClick={() => setEditing(true)}>
          <StatusBadge status={value} label={label} />
          {isSubscribed !== null && isSubscribed !== undefined && onToggleSubscribe && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onToggleSubscribe(); }}
              aria-label={isSubscribed ? "Unsubscribe from this ticket" : "Subscribe to this ticket"}
              aria-pressed={isSubscribed}
              title={isSubscribed ? "Unsubscribe from this ticket" : "Subscribe to this ticket"}
              className={`flex items-center justify-center p-1 rounded-md transition-colors hover:bg-slate-100 dark:hover:bg-zinc-800 ${
                isSubscribed ? "text-brand-600 dark:text-brand-accent" : "text-slate-400 dark:text-zinc-600"
              }`}
            >
              {isSubscribed ? <Eye className="w-4 h-4" strokeWidth={2} /> : <EyeOff className="w-4 h-4" strokeWidth={2} />}
            </button>
          )}
          <button className={EDIT_BTN} aria-label="Edit status"><PencilIcon /></button>
        </div>
      )}
    </SidebarField>
  );
}

// ── Editable: Sidebar Priority ────────────────────────────────────────────────

function EditableSidebarPriority({ value, onChange }: { value: TicketPriority; onChange: (v: TicketPriority) => void }) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLSelectElement>(null);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);

  return (
    <SidebarField label="Priority">
      {editing ? (
        <select
          ref={ref}
          className={INPUT_BASE + " py-0.5 text-[16px] sm:text-[12px]"}
          value={value}
          onChange={(e) => { onChange(e.target.value as TicketPriority); setEditing(false); }}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => { if (e.key === "Escape") setEditing(false); }}
        >
          {(Object.keys(PRIORITY_LABEL) as TicketPriority[]).map((k) => (
            <option key={k} value={k}>{PRIORITY_LABEL[k]}</option>
          ))}
        </select>
      ) : (
        <div className="group flex items-center gap-1.5 cursor-pointer" onClick={() => setEditing(true)}>
          <PriorityBadge priority={value} />
          <button className={EDIT_BTN} aria-label="Edit priority"><PencilIcon /></button>
        </div>
      )}
    </SidebarField>
  );
}

function EditableSidebarType({ value, onChange }: { value: TicketType; onChange: (v: TicketType) => void }) {
  return (
    <SidebarField label="Type">
      <TicketTypeSelect
        value={value}
        onChange={onChange}
        buttonClassName="group inline-flex items-center gap-1.5 text-[13px] font-medium text-slate-700 dark:text-zinc-300 hover:text-brand-600 dark:hover:text-brand-accent transition-colors cursor-pointer"
      />
    </SidebarField>
  );
}

// ── Editable: Sidebar Assignee ────────────────────────────────────────────────

function EditableSidebarAssignee({
  value,
  onChange,
  members,
}: {
  value: { name: string; avatar: string };
  onChange: (v: { name: string; avatar: string }) => void;
  /** Real organization members only — no mock names. */
  members: OrgMember[];
}) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLSelectElement>(null);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);

  const handleChange = (name: string) => {
    if (name === "Unassigned") {
      onChange({ name: "Unassigned", avatar: FALLBACK_AVATAR });
      setEditing(false);
      return;
    }
    const member = members.find((m) => m.name === name);
    if (member) { onChange({ name: member.name, avatar: member.avatar }); setEditing(false); }
  };

  return (
    <SidebarField label="Assignee">
      {editing ? (
        <select
          ref={ref}
          className={INPUT_BASE + " py-0.5 text-[16px] sm:text-[12px]"}
          value={value.name}
          onChange={(e) => handleChange(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => { if (e.key === "Escape") setEditing(false); }}
        >
          <option value="Unassigned">Unassigned</option>
          {members.map((m) => (
            <option key={m.id} value={m.name}>{m.name}</option>
          ))}
        </select>
      ) : (
        // Whole-row trigger (not just the pencil icon) — a plain <button>
        // rather than MemberTrigger + a separate small edit button: a real
        // <button> is what already gives every other same-row trigger in
        // this file (MemberTrigger's own non-nested render, the old pencil
        // button) native keyboard focus/Enter/Space for free, no manual
        // key handler needed. This does mean clicking the name/avatar here
        // now opens the assignee selector instead of this person's profile
        // (MemberTrigger, shared app-wide, was intentionally left
        // untouched) — the same profile is still reachable from every
        // other place this person appears (Comments, Team, Reports, ...).
        <button
          type="button"
          onClick={() => setEditing(true)}
          aria-label="Edit assignee"
          className={
            "group w-full flex items-center gap-1.5 -mx-1 px-1 py-0.5 rounded-md text-left " +
            "cursor-pointer transition-colors hover:bg-slate-50 dark:hover:bg-zinc-800/60 " +
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 dark:focus-visible:ring-brand-accent/40"
          }
        >
          <Avatar src={value.avatar} name={value.name} className="w-5 h-5 rounded-full flex-shrink-0" />
          <span className="truncate">{value.name}</span>
          <span
            aria-hidden="true"
            className={EDIT_BTN + " group-hover:opacity-100 group-focus-visible:opacity-100"}
          >
            <PencilIcon />
          </span>
        </button>
      )}
    </SidebarField>
  );
}

// ── Read-only: Sidebar Created By ─────────────────────────────────────────────
// Purely informational — never editable, unlike every other sidebar field
// above/below it. `creator` is already resolved (name+avatar) by
// loadTicketByCode (lib/tickets.ts) as part of the same ticket load, same
// as `ticket.assignee` — no separate fetch happens here. Undefined only
// when the creator genuinely can't be resolved (no created_by recorded, or
// that profile no longer exists), in which case this renders a plain,
// non-interactive "Unknown user" row (same layout, no MemberTrigger —
// there's no real profile to open), mirroring MemberTrigger's own
// "Unassigned" convention rather than opening a broken profile lookup.

function SidebarCreatedBy({
  creator,
  createdByProfileId,
  projectSlug,
}: {
  creator?: { name: string; avatar: string };
  createdByProfileId?: string | null;
  projectSlug?: string;
}) {
  if (!creator) {
    return (
      <SidebarField label="Created by">
        <div className="flex items-center gap-1.5 text-slate-400 dark:text-zinc-600">
          <Avatar src={FALLBACK_AVATAR} name="Unknown user" className="w-5 h-5 rounded-full flex-shrink-0" />
          <span className="truncate">Unknown user</span>
        </div>
      </SidebarField>
    );
  }

  return (
    <SidebarField label="Created by">
      <MemberTrigger
        name={creator.name}
        avatar={creator.avatar}
        profileId={createdByProfileId ?? undefined}
        projectSlug={projectSlug}
        className="flex items-center gap-1.5 min-w-0"
      >
        <Avatar src={creator.avatar} name={creator.name} className="w-5 h-5 rounded-full flex-shrink-0" />
        <span className="truncate">{creator.name}</span>
      </MemberTrigger>
    </SidebarField>
  );
}

// ── Editable: Sidebar Milestone ───────────────────────────────────────────────

function EditableSidebarMilestone({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLSelectElement>(null);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);

  return (
    <SidebarField label="Milestone">
      {editing ? (
        <select
          ref={ref}
          className={INPUT_BASE + " py-0.5 text-[16px] sm:text-[12px]"}
          value={value}
          onChange={(e) => { onChange(e.target.value); setEditing(false); }}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => { if (e.key === "Escape") setEditing(false); }}
        >
          {MILESTONES.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      ) : (
        <div className="group flex items-center gap-1.5 cursor-pointer" onClick={() => setEditing(true)}>
          <span className="truncate">{value}</span>
          <button className={EDIT_BTN} aria-label="Edit milestone"><PencilIcon /></button>
        </div>
      )}
    </SidebarField>
  );
}

// ── Editable: Sidebar Story Points ────────────────────────────────────────────

function EditableSidebarStoryPoints({
  value,
  onChange,
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value?.toString() ?? "");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);

  const save = () => {
    const n = parseInt(draft, 10);
    onChange(isNaN(n) ? undefined : Math.max(0, n));
    setEditing(false);
  };
  const cancel = () => { setDraft(value?.toString() ?? ""); setEditing(false); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); save(); }
    if (e.key === "Escape") cancel();
  };

  return (
    <SidebarField label="Story points">
      {editing ? (
        <input
          ref={ref}
          type="number"
          min="0"
          className={INPUT_BASE + " w-24"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={onKey}
        />
      ) : (
        <div
          className="group flex items-center gap-1.5 cursor-pointer"
          onClick={() => { setDraft(value?.toString() ?? ""); setEditing(true); }}
        >
          <span>{value !== undefined ? `${value} pts` : "—"}</span>
          <button className={EDIT_BTN} aria-label="Edit story points"><PencilIcon /></button>
        </div>
      )}
    </SidebarField>
  );
}

// ── Editable: Sidebar Hours ───────────────────────────────────────────────────

function EditableSidebarHours({
  value,
  onChange,
  isParent = false,
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  /** A parent's own Estimated is derived from its children (tickets_block_
   *  hours_on_parent, 20260927000000 — even the DB itself rejects a direct
   *  edit) — `value` is still the real aggregated number, just rendered
   *  read-only instead of as an editable field. */
  isParent?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value?.toString() ?? "");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);

  const save = () => {
    const n = parseInt(draft, 10);
    onChange(isNaN(n) || n < 0 ? undefined : n);
    setEditing(false);
  };
  const cancel = () => { setDraft(value?.toString() ?? ""); setEditing(false); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); save(); }
    if (e.key === "Escape") cancel();
  };

  if (isParent) {
    return (
      <SidebarField label="Estimated">
        <span>{value !== undefined ? `${value} h` : "—"}</span>
        <p className="mt-0.5 text-[11px] font-normal text-slate-400 dark:text-zinc-600">From children</p>
      </SidebarField>
    );
  }

  return (
    <SidebarField label="Estimated">
      {editing ? (
        <div className="flex items-center gap-1.5">
          <input
            ref={ref}
            type="number"
            min="0"
            step="1"
            className={INPUT_BASE + " w-20"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={onKey}
          />
          <span className="text-[12px] text-slate-500 dark:text-zinc-400 flex-shrink-0">h</span>
        </div>
      ) : (
        <div
          className="group flex items-center gap-1.5 cursor-pointer"
          onClick={() => { setDraft(value?.toString() ?? ""); setEditing(true); }}
        >
          <span>{value !== undefined ? `${value} h` : "—"}</span>
          <button className={EDIT_BTN} aria-label="Edit hours"><PencilIcon /></button>
        </div>
      )}
    </SidebarField>
  );
}

// ── Editable: Sidebar Due Date ────────────────────────────────────────────────

function EditableSidebarDueDate({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (v: string | undefined) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ? parseDisplayDate(value) : "");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);

  const save = () => {
    onChange(draft ? formatISODate(draft) : undefined);
    setEditing(false);
  };
  const cancel = () => { setDraft(value ? parseDisplayDate(value) : ""); setEditing(false); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); save(); }
    if (e.key === "Escape") cancel();
  };

  const display = value ?? "—";

  return (
    <SidebarField label="Due date">
      {editing ? (
        <input
          ref={ref}
          type="date"
          className={INPUT_BASE}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={onKey}
        />
      ) : (
        <div
          className="group flex items-center gap-1.5 cursor-pointer"
          onClick={() => { setDraft(value ? parseDisplayDate(value) : ""); setEditing(true); }}
        >
          {value ? (
            <>
              <CalendarIcon />
              <span>{display}</span>
            </>
          ) : (
            <span className="text-slate-400 dark:text-zinc-600">{display}</span>
          )}
          <button className={EDIT_BTN} aria-label="Edit due date"><PencilIcon /></button>
        </div>
      )}
    </SidebarField>
  );
}

// ── Editable: Sidebar Labels ──────────────────────────────────────────────────

function EditableSidebarLabels({
  value,
  onChange,
  allLabels,
  onCreateLabel,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  /** Static seed categories merged with the real, growing per-org catalog. */
  allLabels: string[];
  onCreateLabel: (name: string) => Promise<{ status: "success"; name: string } | { status: "error"; message: string }>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>(value);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const toggle = (label: string) => {
    setDraft((prev) =>
      prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label]
    );
  };

  const resetPicker = () => { setSearch(""); setCreateError(null); };
  const save = () => { onChange(draft); setEditing(false); resetPicker(); };
  const cancel = () => { setDraft(value); setEditing(false); resetPicker(); };

  // Close on outside click
  useEffect(() => {
    if (!editing) return;
    const handle = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        save();
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, draft]);

  const trimmedSearch = search.trim();
  const filteredLabels = trimmedSearch
    ? allLabels.filter((l) => l.toLowerCase().includes(trimmedSearch.toLowerCase()))
    : allLabels;
  const exactMatch = allLabels.some((l) => l.toLowerCase() === trimmedSearch.toLowerCase());
  const showCreateOption = trimmedSearch.length > 0 && trimmedSearch.length <= 40 && !exactMatch;

  const handleCreate = async () => {
    if (!showCreateOption || creating) return;
    setCreating(true);
    setCreateError(null);
    const result = await onCreateLabel(trimmedSearch);
    setCreating(false);
    if (result.status === "error") {
      setCreateError(result.message);
      return;
    }
    setDraft((prev) => (prev.includes(result.name) ? prev : [...prev, result.name]));
    setSearch("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") cancel();
    if (e.key === "Enter") {
      if (showCreateOption) {
        e.preventDefault();
        handleCreate();
      } else {
        save();
      }
    }
  };

  return (
    <SidebarField label="Labels">
      <div ref={containerRef}>
        {editing ? (
          <div onKeyDown={onKeyDown} tabIndex={-1} className="outline-none">
            <div className="flex items-center gap-1.5 px-2 py-1 mb-2 rounded-md border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900">
              <svg className="w-3 h-3 text-slate-400 dark:text-zinc-600 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
              </svg>
              <input
                type="text"
                placeholder="Search or create…"
                value={search}
                onChange={(e) => { setSearch(e.target.value); setCreateError(null); }}
                className="flex-1 min-w-0 bg-transparent text-[16px] sm:text-[12px] text-slate-800 dark:text-zinc-200 outline-none placeholder:text-slate-400 dark:placeholder:text-zinc-600"
              />
            </div>

            <div className="flex flex-wrap gap-1 mb-2">
              {filteredLabels.map((label) => {
                const active = draft.includes(label);
                return (
                  <button
                    key={label}
                    onClick={() => toggle(label)}
                    className={
                      `px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors cursor-pointer ` +
                      (active
                        ? "bg-brand-500 text-white dark:bg-brand-accent dark:text-brand-accent-foreground"
                        : "bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-400 hover:bg-slate-200 dark:hover:bg-zinc-700")
                    }
                  >
                    {label}
                  </button>
                );
              })}
              {showCreateOption && (
                <button
                  onClick={handleCreate}
                  disabled={creating}
                  className="px-1.5 py-0.5 rounded text-[10px] font-medium border border-dashed border-brand-300 dark:border-brand-accent/40 text-brand-600 dark:text-brand-accent hover:bg-brand-50 dark:hover:bg-brand-accent/10 transition-colors cursor-pointer disabled:opacity-50"
                >
                  {creating ? "Creating…" : `➕ Create "${trimmedSearch}"`}
                </button>
              )}
            </div>

            {createError && (
              <p className="text-[10px] text-red-600 dark:text-red-400 mb-2">{createError}</p>
            )}

            <div className="flex gap-2">
              <button
                onClick={save}
                className="text-[10px] font-medium text-brand-600 dark:text-brand-accent hover:underline"
              >
                Done
              </button>
              <button
                onClick={cancel}
                className="text-[10px] font-medium text-slate-400 dark:text-zinc-600 hover:underline"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div
            className="group flex items-start gap-1.5 cursor-pointer"
            onClick={() => { setDraft(value); setEditing(true); }}
          >
            <div className="flex flex-wrap gap-1 mt-0.5 flex-1">
              {value.length > 0
                ? value.map((l) => <LabelTag key={l} label={l} />)
                : <span className="text-slate-400 dark:text-zinc-600">None</span>}
            </div>
            <button className={EDIT_BTN + " mt-0.5"} aria-label="Edit labels"><PencilIcon /></button>
          </div>
        )}
      </div>
    </SidebarField>
  );
}

// ── Editable: Sidebar Sprint ─────────────────────────────────────────────────
// Sprint MVP — tickets.sprint_id, read/write reuses the exact same
// updateTicket({ sprintId }) path Manage Sprint's own dual-list selector
// already uses (tickets-screen.tsx / manage-sprint-modal.tsx); no second
// assignment implementation. `sprintId = null` is "Backlog" — this never
// touches `status`, which stays whatever it already was (a ticket's
// workflow status and its sprint are two completely independent facts).

const SPRINT_BACKLOG_VALUE = "__backlog__";

function EditableSidebarSprint({
  sprintId,
  sprints,
  canEdit,
  onChange,
}: {
  /** tickets.sprint_id — null/undefined means the general backlog. */
  sprintId?: string | null;
  /** This project's real sprints, every status included (not just open
   *  ones) — the closed ones are never offered as a new destination below,
   *  but are still needed to resolve/display a ticket already locked into
   *  one, e.g. Sprint 0. */
  sprints: Sprint[];
  /** Admin/Project Lead only (mirrors Manage Sprint's own UI gate,
   *  sprint-context-selector.tsx) — Member sees this field read-only.
   *  tickets.sprint_id itself is still governed by the same tickets_update
   *  RLS policy as every other field here regardless of this prop; this is
   *  purely the UI-level mirror of that same product decision, not a
   *  second authorization mechanism. */
  canEdit: boolean;
  onChange: (sprintId: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLSelectElement>(null);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);

  const currentSprint = sprintId ? sprints.find((s) => s.id === sprintId) : undefined;
  // A ticket already sitting in a closed sprint (Sprint 0 included) is
  // always locked, regardless of role — closed-sprint history can never be
  // disturbed from here, the same rule Manage Sprint's own dual-list
  // enforces for its "In other sprints" search results.
  const isLockedToClosedSprint = currentSprint?.status === "closed";
  const canActuallyEdit = canEdit && !isLockedToClosedSprint;
  // Same three pill classes the Tickets/Board Sprint context selector
  // already uses (sprint-context-selector.tsx) — active/closed read the
  // ticket's real sprint.status, never inferred by name; Backlog (no
  // sprint) and any other real status (e.g. planned) stay neutral.
  const sprintBadgeClass =
    currentSprint?.status === "active"
      ? SPRINT_ACTIVE_BADGE_CLASS
      : currentSprint?.status === "closed"
      ? SPRINT_CLOSED_BADGE_CLASS
      : SPRINT_BACKLOG_BADGE_CLASS;

  // Valid new destinations: Backlog, plus every non-closed sprint (the
  // active one and any planned ones) — never a closed sprint, Sprint 0
  // included, as a target to move *into*.
  const eligibleSprints = sprints
    .filter((s) => s.status !== "closed")
    .sort((a, b) => (a.status === "active" ? -1 : b.status === "active" ? 1 : b.createdAt.localeCompare(a.createdAt)));

  return (
    <SidebarField label="Sprint">
      {editing ? (
        <select
          ref={ref}
          className={INPUT_BASE + " py-0.5 text-[16px] sm:text-[12px]"}
          value={sprintId ?? SPRINT_BACKLOG_VALUE}
          onChange={(e) => {
            onChange(e.target.value === SPRINT_BACKLOG_VALUE ? null : e.target.value);
            setEditing(false);
          }}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => { if (e.key === "Escape") setEditing(false); }}
        >
          <option value={SPRINT_BACKLOG_VALUE}>Backlog</option>
          {eligibleSprints.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}{s.status === "active" ? " (Active)" : ""}
            </option>
          ))}
        </select>
      ) : (
        <div
          className={`group flex items-center gap-1.5 ${canActuallyEdit ? "cursor-pointer" : ""}`}
          onClick={canActuallyEdit ? () => setEditing(true) : undefined}
        >
          <span className={`inline-flex items-center px-1.5 py-0.5 rounded-md text-[11px] font-semibold ${sprintBadgeClass}`}>
            {currentSprint ? currentSprint.name : "Backlog"}
          </span>
          {isLockedToClosedSprint && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-semibold bg-slate-100 text-slate-500 dark:bg-zinc-800 dark:text-zinc-400">
              Closed
            </span>
          )}
          {canActuallyEdit && (
            <button className={EDIT_BTN} aria-label="Edit sprint"><PencilIcon /></button>
          )}
        </div>
      )}
    </SidebarField>
  );
}

// ── Related Tickets ───────────────────────────────────────────────────────────

const RELATION_LABEL: Record<TicketRelationKind, string> = {
  "related-to":    "Related to",
  "blocks":        "Blocks",
  "blocked-by":    "Blocked by",
  "duplicates":    "Duplicates",
  "duplicated-by": "Duplicated by",
};

const RELATION_KIND_ORDER: TicketRelationKind[] = ["blocks", "blocked-by", "duplicates", "duplicated-by", "related-to"];

function RelatedTicketCard({
  ticket,
  slug,
  onRemove,
}: {
  ticket: Ticket;
  slug: string;
  onRemove: () => void;
}) {
  return (
    <div className="group relative">
      <Link
        href={`/projects/${slug}/tickets/${getTicketDisplayKey(ticket)}`}
        className={
          "block w-full text-left px-2.5 py-2 rounded-lg transition-colors " +
          "bg-slate-50 dark:bg-zinc-900/50 hover:bg-slate-100 dark:hover:bg-zinc-800/60 " +
          "border border-slate-100 dark:border-zinc-800"
        }
      >
        <div className="flex items-center gap-1 mb-1 pr-3">
          <TicketTypeIcon type={ticket.type} className="w-2.5 h-2.5" />
          <span className="font-mono text-[9px] font-semibold text-slate-400 dark:text-zinc-600 flex-shrink-0">
            {getTicketDisplayKey(ticket)}
          </span>
          <div className="flex-shrink-0">
            <StatusBadge status={ticket.status} />
          </div>
          {(ticket.priority === "highest" || ticket.priority === "high") && (
            <span
              className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-rose-400 dark:bg-rose-500"
              title="High priority"
            />
          )}
          <MemberTrigger
            name={ticket.assignee.name}
            avatar={ticket.assignee.avatar}
            profileId={ticket.assigneeProfileId ?? undefined}
            projectSlug={ticket.projectSlug}
            nested
            className="ml-auto flex-shrink-0 rounded-full"
          >
            <Avatar src={ticket.assignee.avatar} name={ticket.assignee.name} className="w-3.5 h-3.5 rounded-full flex-shrink-0" />
          </MemberTrigger>
        </div>
        <p className="text-[11px] text-slate-700 dark:text-zinc-300 leading-snug line-clamp-2 pr-2">
          {ticket.title}
        </p>
      </Link>
      <button
        onClick={onRemove}
        className={
          "absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 " +
          "w-3.5 h-3.5 flex items-center justify-center rounded " +
          "text-slate-400 dark:text-zinc-600 hover:text-slate-600 dark:hover:text-zinc-400 " +
          "hover:bg-slate-200 dark:hover:bg-zinc-700 transition-all"
        }
        aria-label="Remove link"
      >
        <svg className="w-2 h-2" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
          <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

function RelatedTicketsSection({
  ticketId,
  slug,
  onChanged,
  onError,
}: {
  ticketId: string;
  slug: string;
  /** Called after a successful add/remove — a database trigger already
   *  logged the real Activity Log rows as part of the same write; this just
   *  tells the parent to refetch it (same pattern as AttachmentsSection's
   *  onUploaded / TimeTrackingSection's onLogged). */
  onChanged: () => void;
  /** Called when removing a link fails — surfaced via the shared error toast.
   *  Adding a link has its own inline error (linkError) inside the picker, but
   *  a remove can happen while the picker is closed, so it needs this instead. */
  onError: (message: string) => void;
}) {
  const { organization, isDevFallback } = useCurrentUser();

  const [relations, setRelations]     = useState<RelatedTicket[]>([]);
  const [linking, setLinking]         = useState(false);
  const [linkKind, setLinkKind]       = useState<TicketRelationKind>("related-to");
  const [searchQuery, setSearchQuery] = useState("");
  // All of this project's tickets, loaded once when the link picker first
  // opens — the same loader Tickets' own list views use, reused here rather
  // than a separate search endpoint, and filtered client-side below.
  const [projectTickets, setProjectTickets] = useState<Ticket[] | null>(null);
  const [linkError, setLinkError]     = useState<string | null>(null);
  const selectorRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const loadRelations = () => {
    if (isDevFallback) return;
    loadTicketRelations(ticketId, slug).then((result) => {
      if (result.status === "ready") setRelations(result.relations);
    });
  };

  useEffect(() => {
    loadRelations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketId, isDevFallback]);

  useEffect(() => {
    if (!linking) return;
    const handle = (e: MouseEvent) => {
      if (selectorRef.current && !selectorRef.current.contains(e.target as Node)) {
        setLinking(false);
        setSearchQuery("");
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [linking]);

  useEffect(() => {
    if (linking) searchRef.current?.focus();
  }, [linking]);

  useEffect(() => {
    if (!linking || isDevFallback || !organization || projectTickets !== null) return;
    loadProjectTickets(organization.id, slug).then((result) => {
      if (result.status === "ready") setProjectTickets(result.tickets);
    });
  }, [linking, isDevFallback, organization, slug, projectTickets]);

  const linkedTicketIds = new Set(relations.map((r) => r.ticket.id));
  const query = searchQuery.trim().toLowerCase();
  const searchResults = (projectTickets ?? []).filter((t) => {
    if (t.id === ticketId || linkedTicketIds.has(t.id)) return false;
    if (!query) return true;
    return t.title.toLowerCase().includes(query) || getTicketDisplayKey(t).toLowerCase().includes(query);
  });

  const addLink = (otherTicketId: string) => {
    if (isDevFallback) return;
    setLinkError(null);
    createTicketRelation(ticketId, otherTicketId, linkKind).then((result) => {
      if (result.status === "error") {
        setLinkError(result.message);
        return;
      }
      setLinking(false);
      setSearchQuery("");
      loadRelations();
      onChanged();
    }).catch((err) => {
      setLinkError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    });
  };

  const removeLink = (linkId: string) => {
    if (isDevFallback) return;
    deleteTicketRelation(linkId).then((result) => {
      if (result.status === "error") {
        console.warn("[ticket-detail] failed to remove related ticket:", result.message);
        onError(result.message);
        return;
      }
      loadRelations();
      onChanged();
    }).catch((err) => {
      console.warn("[ticket-detail] failed to remove related ticket:", err);
      onError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    });
  };

  const grouped = RELATION_KIND_ORDER
    .map((kind) => ({ kind, items: relations.filter((r) => r.kind === kind) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="py-3.5 border-b border-slate-100 dark:border-zinc-800/70 last:border-0">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">
          Related Tickets
        </p>
        <button
          onClick={() => { setLinking((v) => !v); setLinkError(null); }}
          className="text-[10px] font-semibold text-brand-600 dark:text-brand-accent hover:text-brand-700 dark:hover:text-brand-accent transition-colors leading-none"
        >
          + Link
        </button>
      </div>

      {/* Link selector */}
      {linking && (
        <div
          ref={selectorRef}
          className="mb-3 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 overflow-hidden shadow-sm"
        >
          <div className="flex items-stretch border-b border-slate-100 dark:border-zinc-800">
            <select
              value={linkKind}
              onChange={(e) => setLinkKind(e.target.value as TicketRelationKind)}
              className="text-[16px] sm:text-[10px] font-medium bg-slate-50 dark:bg-zinc-800/80 text-slate-600 dark:text-zinc-400 border-r border-slate-100 dark:border-zinc-800 px-1.5 outline-none flex-shrink-0 cursor-pointer"
            >
              {(Object.keys(RELATION_LABEL) as TicketRelationKind[]).map((k) => (
                <option key={k} value={k}>{RELATION_LABEL[k]}</option>
              ))}
            </select>
            <input
              ref={searchRef}
              type="text"
              placeholder="Search…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="flex-1 min-w-0 text-[16px] sm:text-[11px] px-2 py-1.5 outline-none bg-transparent text-slate-700 dark:text-zinc-300 placeholder:text-slate-300 dark:placeholder:text-zinc-700"
              onKeyDown={(e) => {
                if (e.key === "Escape") { setLinking(false); setSearchQuery(""); }
              }}
            />
          </div>
          <div className="max-h-40 overflow-y-auto">
            {searchResults.length === 0 ? (
              <p className="px-2.5 py-2 text-[11px] text-slate-400 dark:text-zinc-600">
                {projectTickets === null ? "Loading…" : searchQuery ? "No results" : "No more tickets to link"}
              </p>
            ) : (
              searchResults.slice(0, 6).map((t) => (
                <button
                  key={t.id}
                  onClick={() => addLink(t.id)}
                  className="w-full text-left px-2.5 py-2 hover:bg-slate-50 dark:hover:bg-zinc-800/50 transition-colors border-b border-slate-50 dark:border-zinc-800/30 last:border-0"
                >
                  <div className="flex items-center gap-1 mb-0.5">
                    <TicketTypeIcon type={t.type} className="w-2.5 h-2.5" />
                    <span className="font-mono text-[9px] font-semibold text-slate-400 dark:text-zinc-600 flex-shrink-0">
                      {getTicketDisplayKey(t)}
                    </span>
                    <StatusBadge status={t.status} label={t.statusName} />
                  </div>
                  <p className="text-[11px] text-slate-700 dark:text-zinc-300 truncate leading-snug">
                    {t.title}
                  </p>
                </button>
              ))
            )}
          </div>
          {linkError && (
            <p className="px-2.5 py-1.5 text-[10px] text-red-600 dark:text-red-400 border-t border-slate-100 dark:border-zinc-800">
              {linkError}
            </p>
          )}
        </div>
      )}

      {/* Empty state */}
      {grouped.length === 0 && !linking && (
        <p className="text-[12px] font-medium text-slate-400 dark:text-zinc-600">None</p>
      )}

      {/* Grouped related tickets */}
      {grouped.length > 0 && (
        <div className="space-y-3">
          {grouped.map(({ kind, items }) => (
            <div key={kind}>
              <p className="text-[9px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600 mb-1.5">
                {RELATION_LABEL[kind]}
              </p>
              <div className="space-y-1.5">
                {items.map(({ linkId, ticket: t }) => (
                  <RelatedTicketCard
                    key={linkId}
                    ticket={t}
                    slug={slug}
                    onRemove={() => removeLink(linkId)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

    </div>
  );
}

// ── Parent / Children (exactly one level) ───────────────────────────────────
// "Is this ticket a parent" is never stored — see lib/tickets.ts's own
// loadTicketHierarchy doc. Related Tickets (above) stays completely
// untouched: this is a separate, dedicated section.

function ChildTicketRow({
  child,
  slug,
  onUnlink,
}: {
  child: TicketChildSummary;
  slug: string;
  onUnlink: () => void;
}) {
  const code = getTicketDisplayKey({ projectSlug: slug, ticketNumber: child.ticketNumber } as Ticket);
  return (
    <div className="group relative">
      <Link
        href={`/projects/${slug}/tickets/${code}`}
        className="flex items-center gap-2.5 w-full text-left pl-3 pr-8 py-2.5 rounded-lg transition-colors bg-slate-50/70 dark:bg-zinc-900/40 hover:bg-slate-100 dark:hover:bg-zinc-800/60 border border-slate-100 dark:border-zinc-800"
      >
        <TicketTypeIcon type={child.type} className="w-3 h-3 flex-shrink-0" />
        {/* Sky, not the brand lilac reserved for Parent — same Board
            hierarchy grammar (Board's ticket-card.tsx), same exact
            classes. */}
        <CornerDownRight className="w-3 h-3 flex-shrink-0 text-sky-600 dark:text-sky-400" aria-hidden="true" />
        <span className="font-mono text-[11px] font-semibold text-sky-600 dark:text-sky-400 flex-shrink-0">
          {code}
        </span>
        <p className="flex-1 min-w-0 text-[13px] text-slate-700 dark:text-zinc-300 truncate">
          {child.title}
        </p>
        <div className="flex-shrink-0 flex items-center gap-1.5">
          <StatusBadge status={child.status} label={child.statusName} />
          {/* Avatar only (no name) — same MemberTrigger popover every other
              assignee avatar in the app opens; `nested` stops the click
              from bubbling into the row's own Link navigation. Nothing
              rendered at all when unassigned (no placeholder). */}
          {child.assigneeProfileId && (
            <MemberTrigger
              name={child.assigneeName ?? ""}
              avatar={child.assigneeAvatar ?? FALLBACK_AVATAR}
              profileId={child.assigneeProfileId}
              projectSlug={slug}
              nested
              className="flex-shrink-0 rounded-full"
            >
              <Avatar
                src={child.assigneeAvatar ?? FALLBACK_AVATAR}
                name={child.assigneeName ?? ""}
                className="w-4 h-4 rounded-full flex-shrink-0 ring-1 ring-white dark:ring-zinc-900"
              />
            </MemberTrigger>
          )}
        </div>
      </Link>
      <button
        onClick={onUnlink}
        className="absolute top-1/2 -translate-y-1/2 right-2.5 opacity-0 group-hover:opacity-100 w-4 h-4 flex items-center justify-center rounded text-slate-400 dark:text-zinc-600 hover:text-slate-600 dark:hover:text-zinc-400 hover:bg-slate-200 dark:hover:bg-zinc-700 transition-all"
        aria-label="Unlink child ticket"
        title="Unlink (doesn't delete the ticket)"
      >
        <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
          <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

function ChildrenSection({
  ticket,
  slug,
  childTickets,
  onChanged,
  onCreateChild,
  onError,
}: {
  ticket: Ticket;
  slug: string;
  /** Named childTickets, not `children` — this is a plain data prop, never
   *  meant as this component's own JSX children. */
  childTickets: TicketChildSummary[];
  /** Called after a successful link/unlink — a database trigger may also
   *  have just auto-closed/auto-reopened this ticket itself, so the caller
   *  re-fetches both the hierarchy and the ticket's own row. */
  onChanged: () => void;
  onCreateChild: () => void;
  onError: (message: string) => void;
}) {
  const { organization, isDevFallback } = useCurrentUser();

  const [linking, setLinking]         = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // Same lazy, once-per-open load RelatedTicketsSection's own picker uses.
  const [projectTickets, setProjectTickets] = useState<Ticket[] | null>(null);
  const [linkError, setLinkError]     = useState<string | null>(null);
  const selectorRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!linking) return;
    const handle = (e: MouseEvent) => {
      if (selectorRef.current && !selectorRef.current.contains(e.target as Node)) {
        setLinking(false);
        setSearchQuery("");
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [linking]);

  useEffect(() => {
    if (linking) searchRef.current?.focus();
  }, [linking]);

  useEffect(() => {
    if (!linking || isDevFallback || !organization || projectTickets !== null) return;
    loadProjectTickets(organization.id, slug).then((result) => {
      if (result.status === "ready") setProjectTickets(result.tickets);
    });
  }, [linking, isDevFallback, organization, slug, projectTickets]);

  // Excludes: this ticket itself; anything already a child of any ticket
  // (including this one — already shown below, not offered again); and
  // anything that already has children of its own — both of the latter two
  // would create a third level, which tickets_guard_parent_hierarchy
  // (20260927000000) rejects regardless, this just keeps invalid picks out
  // of the list in the first place.
  const usedAsParentIds = new Set(
    (projectTickets ?? []).filter((t) => t.parentTicketId).map((t) => t.parentTicketId as string)
  );
  const query = searchQuery.trim().toLowerCase();
  const searchResults = (projectTickets ?? []).filter((t) => {
    if (t.id === ticket.id) return false;
    if (t.parentTicketId) return false;
    if (usedAsParentIds.has(t.id)) return false;
    if (!query) return true;
    return t.title.toLowerCase().includes(query) || getTicketDisplayKey(t).toLowerCase().includes(query);
  });

  const linkChild = (childTicketId: string) => {
    if (isDevFallback) return;
    setLinkError(null);
    updateTicket(childTicketId, slug, { parentTicketId: ticket.id }).then((result) => {
      if (result.status === "error") {
        setLinkError(result.message);
        return;
      }
      setLinking(false);
      setSearchQuery("");
      onChanged();
    }).catch((err) => {
      setLinkError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    });
  };

  const unlinkChild = (childTicketId: string) => {
    if (isDevFallback) return;
    updateTicket(childTicketId, slug, { parentTicketId: null }).then((result) => {
      if (result.status === "error") {
        onError(result.message);
        return;
      }
      onChanged();
    }).catch((err) => {
      onError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    });
  };

  const closedCount = childTickets.filter((c) => c.statusGroupType === "closed").length;
  const progressPct = childTickets.length > 0 ? Math.round((closedCount / childTickets.length) * 100) : 0;

  const createLinkActions = (
    <div className="flex items-center gap-3">
      <button
        onClick={onCreateChild}
        className="text-[11px] font-semibold text-brand-600 dark:text-brand-accent hover:text-brand-700 dark:hover:text-brand-accent transition-colors leading-none"
      >
        + Create
      </button>
      <button
        onClick={() => { setLinking((v) => !v); setLinkError(null); }}
        className="text-[11px] font-semibold text-brand-600 dark:text-brand-accent hover:text-brand-700 dark:hover:text-brand-accent transition-colors leading-none"
      >
        + Link
      </button>
    </div>
  );

  const linkPicker = linking && (
    <div
      ref={selectorRef}
      className="mb-3 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 overflow-hidden shadow-sm"
    >
      <div className="flex items-stretch border-b border-slate-100 dark:border-zinc-800">
        <input
          ref={searchRef}
          type="text"
          placeholder="Search this project's tickets…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="flex-1 min-w-0 text-[16px] sm:text-[13px] px-3 py-2 outline-none bg-transparent text-slate-700 dark:text-zinc-300 placeholder:text-slate-300 dark:placeholder:text-zinc-700"
          onKeyDown={(e) => {
            if (e.key === "Escape") { setLinking(false); setSearchQuery(""); }
          }}
        />
      </div>
      <div className="max-h-52 overflow-y-auto">
        {searchResults.length === 0 ? (
          <p className="px-3 py-2.5 text-[12px] text-slate-400 dark:text-zinc-600">
            {projectTickets === null ? "Loading…" : searchQuery ? "No results" : "No more tickets to link"}
          </p>
        ) : (
          searchResults.slice(0, 6).map((t) => (
            <button
              key={t.id}
              onClick={() => linkChild(t.id)}
              className="w-full flex items-center gap-2.5 text-left px-3 py-2 hover:bg-slate-50 dark:hover:bg-zinc-800/50 transition-colors border-b border-slate-50 dark:border-zinc-800/30 last:border-0"
            >
              <TicketTypeIcon type={t.type} className="w-3 h-3 flex-shrink-0" />
              <span className="font-mono text-[11px] font-semibold text-slate-400 dark:text-zinc-600 flex-shrink-0">
                {getTicketDisplayKey(t)}
              </span>
              <span className="flex-1 min-w-0 text-[13px] text-slate-700 dark:text-zinc-300 truncate">
                {t.title}
              </span>
              <StatusBadge status={t.status} label={t.statusName} />
            </button>
          ))
        )}
      </div>
      {linkError && (
        <p className="px-3 py-1.5 text-[11px] text-red-600 dark:text-red-400 border-t border-slate-100 dark:border-zinc-800">
          {linkError}
        </p>
      )}
    </div>
  );

  // Nothing to show yet — a slim single line (label + the two actions),
  // never the full structural section chrome, so a ticket that has never
  // used hierarchy doesn't carry an empty "Children" block around. Becomes
  // the real structural section below the moment a first child exists.
  if (childTickets.length === 0) {
    return (
      <div className="mt-10">
        <div className="flex items-center gap-3">
          <span className={SECTION_LABEL}>Children</span>
          {createLinkActions}
        </div>
        {linkPicker}
      </div>
    );
  }

  return (
    <CollapsibleSection
      title="Children"
      badge={`· ${closedCount}/${childTickets.length} closed`}
      headerAction={createLinkActions}
    >
      {linkPicker}

      {/* Progress — a parent represents exclusively the aggregated work of
          its children (product rule); this is purely a completion readout,
          never itself editable. */}
      <div className="mb-3">
        <p className="text-[12px] font-medium text-slate-500 dark:text-zinc-400 mb-1.5">
          {closedCount} / {childTickets.length} closed
        </p>
        <div className="h-1 rounded-full bg-slate-100 dark:bg-zinc-800 overflow-hidden">
          <div
            className="h-full bg-brand-500 rounded-full transition-all duration-300 dark:bg-brand-accent"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        {childTickets.map((child) => (
          <ChildTicketRow key={child.id} child={child} slug={slug} onUnlink={() => unlinkChild(child.id)} />
        ))}
      </div>
    </CollapsibleSection>
  );
}

// ── CollapsibleSection ────────────────────────────────────────────────────────

function CollapsibleSection({
  title,
  badge,
  headerAction,
  defaultOpen = true,
  forceOpenSignal,
  collapsible = true,
  onOpenChange,
  children,
}: {
  // ReactNode (not just string) so Development can prefix its own title
  // with a small icon — every existing caller keeps passing a plain
  // string, which renders exactly as it always has.
  title: ReactNode;
  badge?: string;
  headerAction?: ReactNode;
  defaultOpen?: boolean;
  // Bump this (e.g. an incrementing counter) to force the section open
  // without turning it into a fully controlled component — every other
  // caller that doesn't pass it keeps managing `open` internally, exactly
  // as before. Never fires on mount, only on a later change, so it can't
  // override defaultOpen on first render.
  forceOpenSignal?: number;
  // false permanently removes the expand/collapse behavior — always open,
  // no chevron, and the header is no longer a clickable toggle. Only
  // Attachments passes this; every other caller keeps the default
  // (collapsible) behavior unchanged.
  collapsible?: boolean;
  /** Optional — fires with the current open state on mount and on every
   *  toggle. Lets a caller (e.g. CommentAttachmentsOverview) defer work
   *  inside `children` until the section is actually expanded, without
   *  turning this into a fully controlled component. Every other caller
   *  omits it and renders exactly as before. */
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const isFirstRender = useRef(true);

  useEffect(() => {
    if (!collapsible || forceOpenSignal === undefined) return;
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    setOpen(true);
  }, [collapsible, forceOpenSignal]);

  useEffect(() => {
    onOpenChange?.(open);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const isOpen = !collapsible || open;

  return (
    <div className="mt-10 pt-8 border-t border-slate-100 dark:border-zinc-800">
      <div className="flex items-center gap-2">
        {collapsible ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex-1 flex items-center gap-2 min-w-0 py-0.5 focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-500/50 rounded dark:focus-visible:ring-brand-accent/50"
            aria-expanded={open}
          >
            <span className={SECTION_LABEL}>{title}</span>
            {badge && (
              <span className="text-[11px] font-normal normal-case tracking-normal text-slate-400 dark:text-zinc-600">
                {badge}
              </span>
            )}
            <svg
              className={
                "ml-auto w-3 h-3 text-slate-300 dark:text-zinc-700 transition-transform duration-200 flex-shrink-0 " +
                (open ? "rotate-0" : "-rotate-90")
              }
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ) : (
          <div className="flex-1 flex items-center gap-2 min-w-0 py-0.5">
            <span className={SECTION_LABEL}>{title}</span>
            {badge && (
              <span className="text-[11px] font-normal normal-case tracking-normal text-slate-400 dark:text-zinc-600">
                {badge}
              </span>
            )}
          </div>
        )}
        {headerAction && <div className="flex-shrink-0">{headerAction}</div>}
      </div>

      <div
        className={
          "grid transition-all duration-200 ease-in-out " +
          (isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]")
        }
      >
        <div className="overflow-hidden">
          <div className="pt-4">{children}</div>
        </div>
      </div>
    </div>
  );
}

// ── Acceptance Criteria ───────────────────────────────────────────────────────
// Read-only checklist rows — the surrounding CollapsibleSection (title,
// "N/M done" badge, header "Edit" action, and the view/edit-mode/empty-
// state swap) lives in EditableAcceptanceCriteria below, which is the only
// caller of this checklist.

function AcceptanceCriteriaChecklist({
  criteria,
  doneFlags,
  onToggle,
}: {
  criteria: string[];
  /** Real, persisted checked/unchecked state, aligned by index with criteria. */
  doneFlags: boolean[];
  onToggle: (index: number) => void;
}) {
  return (
    <ul className="space-y-2.5">
      {criteria.map((text, i) => {
        const done = doneFlags[i] ?? false;
        return (
          <li key={i} className="flex items-start gap-3">
            <button
              onClick={() => onToggle(i)}
              aria-label={done ? "Mark incomplete" : "Mark complete"}
              className={
                "mt-0.5 w-4 h-4 rounded flex-shrink-0 border transition-colors flex items-center justify-center " +
                (done
                  ? "bg-brand-500 border-brand-500 dark:bg-brand-accent dark:border-brand-accent"
                  : "border-slate-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 hover:border-brand-400 dark:hover:border-brand-accent")
              }
            >
              {done && (
                <svg className="w-2.5 h-2.5 text-white dark:text-brand-accent-foreground" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 12 12">
                  <path d="M2 6l3 3 5-5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
            <span
              className={
                "text-[14px] leading-snug select-none cursor-pointer " +
                (done
                  ? "line-through text-slate-400 dark:text-zinc-600"
                  : "text-slate-700 dark:text-zinc-300")
              }
              onClick={() => onToggle(i)}
            >
              {text}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// Adds create/edit/delete on top of the read-only checklist above — reuses
// AcceptanceCriteriaFields, the exact same array-editor component and
// underlying string[] data structure new-ticket-modal.tsx's own Acceptance
// Criteria field already uses, and follows EditableDescription's own
// click-to-edit / Save-Cancel pattern rather than inventing a new one.
// Saving persists both the text list and a re-aligned doneFlags array
// together through the ticket's existing onSave (persist()/updateTicket)
// — never a separate write path — so this goes through exactly the same
// RLS/permission enforcement every other Ticket Detail edit already does.
function EditableAcceptanceCriteria({
  criteria,
  doneFlags,
  onToggle,
  onSave,
}: {
  criteria: string[];
  doneFlags: boolean[];
  onToggle: (index: number) => void;
  onSave: (nextCriteria: string[], nextDoneFlags: boolean[]) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  // Text and its own done-state travel together per row here (never two
  // parallel arrays during the edit session), so adding/removing rows can
  // never misalign a criterion's checked state with the wrong row once saved.
  const [draftItems, setDraftItems] = useState<{ text: string; done: boolean }[]>([]);
  const [saving, setSaving] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const justAdded = useRef(false);

  // Same "focus the newest row" behavior new-ticket-modal.tsx's own
  // Acceptance Criteria field already has.
  useEffect(() => {
    if (justAdded.current && draftItems.length > 0) {
      justAdded.current = false;
      inputRefs.current[draftItems.length - 1]?.focus();
    }
  }, [draftItems.length]);

  const startEditing = () => {
    setDraftItems(criteria.map((text, i) => ({ text, done: doneFlags[i] ?? false })));
    setEditing(true);
  };

  const addCriterion = () => {
    justAdded.current = true;
    setDraftItems((prev) => [...prev, { text: "", done: false }]);
  };
  const updateCriterion = (i: number, value: string) =>
    setDraftItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, text: value } : it)));
  const removeCriterion = (i: number) =>
    setDraftItems((prev) => prev.filter((_, idx) => idx !== i));

  const save = async () => {
    setSaving(true);
    // Same "drop blank rows before persisting" rule the New Ticket form's
    // own filledCriteria already applies.
    const filled = draftItems.filter((it) => it.text.trim().length > 0);
    const ok = await onSave(filled.map((it) => it.text.trim()), filled.map((it) => it.done));
    setSaving(false);
    if (ok) setEditing(false);
  };
  const cancel = () => setEditing(false);

  if (editing) {
    return (
      <CollapsibleSection title="Acceptance Criteria" defaultOpen={true}>
        <AcceptanceCriteriaFields
          criteria={draftItems.map((it) => it.text)}
          inputRefs={inputRefs}
          onAdd={addCriterion}
          onUpdate={updateCriterion}
          onRemove={removeCriterion}
        />
        <div className="flex items-center justify-end gap-2 mt-3">
          <button
            type="button"
            onClick={cancel}
            disabled={saving}
            className="px-3.5 py-1.5 text-[13px] font-medium text-slate-600 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className={[
              "px-3.5 py-1.5 text-[13px] font-semibold rounded-lg transition-all",
              saving
                ? "bg-slate-100 dark:bg-zinc-800 text-slate-400 dark:text-zinc-600 cursor-not-allowed"
                : "bg-brand-500 hover:bg-brand-600 text-white shadow-sm shadow-brand-500/30 cursor-pointer dark:bg-brand-accent dark:hover:bg-brand-accent-strong dark:shadow-brand-accent/30 dark:text-brand-accent-foreground",
            ].join(" ")}
          >
            Save
          </button>
        </div>
      </CollapsibleSection>
    );
  }

  if (criteria.length === 0) {
    return (
      <CollapsibleSection title="Acceptance Criteria" defaultOpen={true}>
        <button
          type="button"
          onClick={startEditing}
          className="flex items-center gap-1.5 text-[13px] font-medium text-slate-400 dark:text-zinc-600 hover:text-brand-600 dark:hover:text-brand-accent transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12h14" strokeLinecap="round" />
          </svg>
          Add acceptance criteria
        </button>
      </CollapsibleSection>
    );
  }

  const doneCount = criteria.filter((_, i) => doneFlags[i] ?? false).length;

  return (
    <CollapsibleSection
      title="Acceptance Criteria"
      badge={`· ${doneCount}/${criteria.length} done`}
      defaultOpen={true}
      headerAction={
        <button
          type="button"
          onClick={startEditing}
          aria-label="Edit acceptance criteria"
          className="flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-md bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-300 hover:bg-slate-200 dark:hover:bg-zinc-700 transition-colors"
        >
          <PencilIcon className="w-3 h-3" />
          Edit
        </button>
      }
    >
      <AcceptanceCriteriaChecklist criteria={criteria} doneFlags={doneFlags} onToggle={onToggle} />
    </CollapsibleSection>
  );
}

// ── Attachments ───────────────────────────────────────────────────────────────

type AttachmentItem = {
  id: string;
  name: string;
  ext: string;
  size: string;
  addedBy: string;
  avatar: string;
  /** Real profiles.id of the uploader, when known — lets the "addedBy"
   *  trigger open the Member Profile Modal against their real identity
   *  instead of a name-based guess. */
  profileId: string | null;
  uploadedAt: string;
  storagePath: string;
  /** False for attachment metadata restored from a Data Only Backup — no
   *  physical file exists at storagePath. Download/Preview must never be
   *  attempted in that case (see AttachmentRow/CommentAttachmentRow). */
  isAvailable: boolean;
  /** Storage path of the pre-resized inline-preview derivative, when one
   *  exists — see TicketAttachment.thumbnailPath (lib/tickets.ts). Null
   *  falls back to storagePath (resolveTicketAttachmentThumbnailUrl handles
   *  that itself). */
  thumbnailPath: string | null;
};

type UploadingItem = {
  id: string;
  name: string;
  ext: string;
  size: string;
  progress: number;
};

// A file picked in the comment composer, staged locally before the
// comment (and therefore its comment_id) exists — see PendingCommentFileRow
// and submitComment.
type PendingCommentFile = {
  id: string;
  file: File;
};

const EXT_COLOR: Record<string, string> = {
  fig:  "bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400",
  pdf:  "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400",
  mp4:  "bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400",
  mov:  "bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400",
  png:  "bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400",
  jpg:  "bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400",
  jpeg: "bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400",
  svg:  "bg-orange-100 text-orange-600 dark:bg-orange-900/30 dark:text-orange-400",
  zip:  "bg-yellow-100 text-yellow-600 dark:bg-yellow-900/30 dark:text-yellow-400",
  doc:  "bg-sky-100 text-sky-600 dark:bg-sky-900/30 dark:text-sky-400",
  docx: "bg-sky-100 text-sky-600 dark:bg-sky-900/30 dark:text-sky-400",
};

function getExt(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "file";
}

// Image formats every evergreen browser can render directly in an <img>
// tag. Anything else (Office docs, zips, video, etc.) gets no Preview
// action, per this feature's explicit scope.
const PREVIEWABLE_IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);

function getPreviewKind(ext: string): "image" | "pdf" | null {
  if (ext === "pdf") return "pdf";
  if (PREVIEWABLE_IMAGE_EXTS.has(ext)) return "image";
  return null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRemainingHours(hours: number): string {
  const clamped = Math.max(0, hours);
  return `${Number(clamped.toFixed(1))}`;
}

let attachmentIdCounter = 0;

// Date.now() + Math.random() alone can collide when several files are
// selected in the same synchronous batch (same millisecond) — the counter
// guarantees uniqueness regardless of timing, so a temp upload id can never
// match another temp id or a persisted attachment's id.
function newId(): string {
  attachmentIdCounter += 1;
  return `att-${Date.now()}-${attachmentIdCounter}-${Math.random().toString(36).slice(2, 7)}`;
}

// ── UploadingRow ──────────────────────────────────────────────────────────────

function UploadingRow({ item }: { item: UploadingItem }) {
  const extColor = EXT_COLOR[item.ext] ?? "bg-slate-100 text-slate-500 dark:bg-zinc-800 dark:text-zinc-400";
  return (
    <li className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-900/60">
      <span className={"w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0 text-[9px] font-bold uppercase tracking-wide opacity-50 " + extColor}>
        {item.ext}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-medium text-slate-700 dark:text-zinc-300 truncate">{item.name}</p>
        <div className="mt-1.5 flex items-center gap-2">
          <div className="flex-1 h-1 rounded-full bg-slate-200 dark:bg-zinc-700 overflow-hidden">
            <div
              className="h-full rounded-full bg-brand-500 dark:bg-brand-accent transition-all duration-100 ease-linear"
              style={{ width: `${Math.round(item.progress)}%` }}
            />
          </div>
          <span className="text-[10px] tabular-nums text-slate-400 dark:text-zinc-600 w-7 text-right flex-shrink-0">
            {Math.round(item.progress)}%
          </span>
        </div>
      </div>
    </li>
  );
}

// ── AttachmentRow ─────────────────────────────────────────────────────────────

function AttachmentRow({
  file,
  projectSlug,
  onDelete,
  onRename,
  onDownload,
}: {
  file: AttachmentItem;
  /** This ticket's own real project — lets the "addedBy" MemberTrigger fetch
   *  the uploader's real per-project metrics instead of aggregating org-wide. */
  projectSlug?: string;
  onDelete: () => void;
  /** Resolves to whether the rename actually persisted — the input only
   *  closes on success, so a failure leaves it open to retry instead of
   *  silently discarding the edit. */
  onRename: (name: string) => Promise<boolean>;
  onDownload: () => void;
}) {
  const [renaming, setRenaming]     = useState(false);
  const [renameDraft, setRenameDraft] = useState(file.name);
  const [menuOpen, setMenuOpen]     = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  // Never offered for an unavailable file — there is no physical object
  // in Storage to preview, so a preview attempt would only ever fail.
  const previewKind = file.isAvailable ? getPreviewKind(file.ext) : null;
  // Same detection this section's own "Preview" menu action already uses
  // (previewKind === "image") — an inline thumbnail replaces the plain row
  // for these instead of duplicating a second image/extension allowlist.
  const isImage = previewKind === "image";

  const [inlineImageUrl, setInlineImageUrl] = useState<string | null>(null);
  const [inlineImageFailed, setInlineImageFailed] = useState(false);

  useEffect(() => {
    if (!isImage) return;
    let cancelled = false;
    resolveTicketAttachmentThumbnailUrl(file.storagePath, file.thumbnailPath).then((result) => {
      if (cancelled) return;
      if (result.status === "error") { setInlineImageFailed(true); return; }
      setInlineImageUrl(result.url);
    });
    return () => { cancelled = true; };
  }, [isImage, file.storagePath, file.thumbnailPath]);
  // Screen-space position for the portaled menu panel below — computed from
  // the trigger button at the moment the menu opens (see toggleMenu) so it
  // tracks the button correctly even though it's no longer a DOM descendant
  // of it once rendered via the portal.
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);

  const renameRef    = useRef<HTMLInputElement>(null);
  const menuRef       = useRef<HTMLDivElement>(null);
  const menuPanelRef  = useRef<HTMLDivElement>(null);

  useEffect(() => { if (renaming) renameRef.current?.focus(); }, [renaming]);

  useEffect(() => {
    if (!menuOpen) return;
    const handle = (e: MouseEvent) => {
      const target = e.target as Node;
      const insideTrigger = menuRef.current?.contains(target) ?? false;
      const insidePanel   = menuPanelRef.current?.contains(target) ?? false;
      if (!insideTrigger && !insidePanel) setMenuOpen(false);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [menuOpen]);

  // Keeps the portaled menu tracking the trigger button's viewport position
  // while it's open (e.g. if the page scrolls) — the initial position is set
  // synchronously in toggleMenu below, this effect only keeps it in sync.
  useEffect(() => {
    if (!menuOpen) return;
    const updatePos = () => {
      const rect = menuRef.current?.getBoundingClientRect();
      if (rect) setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    };
    window.addEventListener("scroll", updatePos, true);
    window.addEventListener("resize", updatePos);
    return () => {
      window.removeEventListener("scroll", updatePos, true);
      window.removeEventListener("resize", updatePos);
    };
  }, [menuOpen]);

  // Rendered via a portal (see below) so the menu isn't clipped by the
  // Attachments section's overflow-hidden collapse wrapper (CollapsibleSection)
  // — position is computed in viewport coordinates from the trigger button
  // at the moment the menu opens.
  const toggleMenu = () => {
    if (menuOpen) {
      setMenuOpen(false);
      setMenuPos(null);
      return;
    }
    const rect = menuRef.current?.getBoundingClientRect();
    setMenuPos(rect ? { top: rect.bottom + 4, right: window.innerWidth - rect.right } : null);
    setMenuOpen(true);
  };

  const saveRename = async () => {
    const v = renameDraft.trim();
    if (v && v !== file.name) {
      const ok = await onRename(v);
      if (!ok) return; // keep the input open so the user can retry or cancel
    } else {
      setRenameDraft(file.name);
    }
    setRenaming(false);
  };

  const extColor = EXT_COLOR[file.ext] ?? "bg-slate-100 text-slate-500 dark:bg-zinc-800 dark:text-zinc-400";

  if (confirming) {
    return (
      <li className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50/60 dark:bg-red-950/20">
        <span className="flex-1 min-w-0 text-[13px] text-slate-700 dark:text-zinc-300 truncate">
          Delete <strong className="font-semibold">{file.name}</strong>?
        </span>
        <button
          onClick={onDelete}
          className="flex-shrink-0 text-[12px] font-semibold text-red-600 dark:text-red-400 hover:text-red-700 px-2 py-0.5 rounded hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors"
        >
          Delete
        </button>
        <button
          onClick={() => setConfirming(false)}
          className="flex-shrink-0 text-[12px] text-slate-400 dark:text-zinc-600 hover:text-slate-600 dark:hover:text-zinc-400 px-2 py-0.5 rounded hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
        >
          Cancel
        </button>
      </li>
    );
  }

  // Shared between both layouts below — name (+ rename input)/size/author/
  // date, and the download+"more options" actions — so the image and
  // non-image cases never drift into two different implementations of the
  // same info/actions, just two different containers around them.
  const nameAndMeta = (
    <div className="flex-1 min-w-0">
      {renaming ? (
        <input
          ref={renameRef}
          className={
            "text-[16px] sm:text-[13px] font-medium text-slate-800 dark:text-zinc-200 w-full " +
            "bg-white dark:bg-zinc-900 border border-brand-500 dark:border-brand-accent " +
            "rounded px-1.5 py-0.5 outline-none focus:ring-1 focus:ring-brand-500/30 dark:focus:ring-brand-accent/30"
          }
          value={renameDraft}
          onChange={(e) => setRenameDraft(e.target.value)}
          onBlur={saveRename}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
            if (e.key === "Enter") { e.preventDefault(); saveRename(); }
            if (e.key === "Escape") { setRenameDraft(file.name); setRenaming(false); }
          }}
        />
      ) : (
        <p className="text-[13px] font-medium text-slate-800 dark:text-zinc-200 truncate">{file.name}</p>
      )}
      <div className="text-[11px] text-slate-400 dark:text-zinc-600 mt-0.5 flex items-center gap-1.5">
        <span>{file.size}</span>
        <span>·</span>
        <MemberTrigger name={file.addedBy} avatar={file.avatar} profileId={file.profileId ?? undefined} projectSlug={projectSlug} nested className="flex items-center gap-1.5">
          <Avatar src={file.avatar} name={file.addedBy} className="w-3.5 h-3.5 rounded-full flex-shrink-0" />
          <span>{file.addedBy}</span>
        </MemberTrigger>
        <span>·</span>
        <span>{file.uploadedAt}</span>
      </div>
      {!file.isAvailable && (
        <p className="text-[11px] font-medium text-amber-600 dark:text-amber-400 mt-1">
          File not included in this backup
        </p>
      )}
    </div>
  );

  const actions = !renaming && (
    <div className="flex items-center gap-0.5 flex-shrink-0">
      {file.isAvailable && (
        <button
          aria-label={`Download ${file.name}`}
          onClick={(e) => { e.stopPropagation(); onDownload(); }}
          className="p-1.5 rounded-md text-slate-400 dark:text-zinc-600 hover:text-slate-600 dark:hover:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}

      <div ref={menuRef} className="relative">
        <button
          aria-label="More options"
          onClick={(e) => { e.stopPropagation(); toggleMenu(); }}
          className="p-1.5 rounded-md text-slate-400 dark:text-zinc-600 hover:text-slate-600 dark:hover:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
        >
          <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="3"  cy="8" r="1.25" />
            <circle cx="8"  cy="8" r="1.25" />
            <circle cx="13" cy="8" r="1.25" />
          </svg>
        </button>

        {menuOpen && menuPos && createPortal(
          <div
            ref={menuPanelRef}
            style={{ position: "fixed", top: menuPos.top, right: menuPos.right }}
            className="w-36 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-lg shadow-slate-200/50 dark:shadow-black/40 z-20 py-1"
          >
            {previewKind && (
              <button
                className="w-full text-left px-3 py-1.5 text-[12px] text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800 flex items-center gap-2.5 transition-colors"
                onClick={() => { setMenuOpen(false); setPreviewOpen(true); }}
              >
                <svg className="w-3 h-3 text-slate-400 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Preview
              </button>
            )}
            <button
              className="w-full text-left px-3 py-1.5 text-[12px] text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800 flex items-center gap-2.5 transition-colors"
              onClick={() => { setMenuOpen(false); setRenameDraft(file.name); setRenaming(true); }}
            >
              <svg className="w-3 h-3 text-slate-400 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 012.828 2.828L11.828 15.828a2 2 0 01-2.828 0L7 14l2-1z" />
                <path d="M3 21h18" strokeLinecap="round" />
              </svg>
              Rename
            </button>
            <div className="my-1 h-px bg-slate-100 dark:bg-zinc-800" />
            <button
              className="w-full text-left px-3 py-1.5 text-[12px] text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 flex items-center gap-2.5 transition-colors"
              onClick={() => { setMenuOpen(false); setConfirming(true); }}
            >
              <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Delete
            </button>
          </div>,
          document.body
        )}
      </div>
    </div>
  );

  const previewModal = previewOpen && previewKind && createPortal(
    <AttachmentPreviewModal file={file} kind={previewKind} onClose={() => setPreviewOpen(false)} />,
    document.body
  );

  // Image attachments get an inline thumbnail (fit to width, aspect ratio
  // preserved via object-contain inside a capped-height box, so it can
  // never overflow the section) instead of the plain ext-badge row below.
  if (isImage) {
    return (
      <>
        <li className="group rounded-lg border transition-colors border-slate-100 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900/60 hover:border-slate-200 dark:hover:border-zinc-700 overflow-hidden">
          <div
            className="w-full h-48 flex items-center justify-center bg-slate-100 dark:bg-zinc-900 cursor-pointer"
            onClick={() => setPreviewOpen(true)}
          >
            {inlineImageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={inlineImageUrl} alt={file.name} loading="lazy" className="max-w-full max-h-full object-contain" />
            )}
            {!inlineImageUrl && !inlineImageFailed && (
              <svg className="w-4 h-4 animate-spin text-slate-300 dark:text-zinc-700" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            )}
            {inlineImageFailed && (
              <p className="text-[11px] text-slate-400 dark:text-zinc-600">Couldn&apos;t load preview.</p>
            )}
          </div>
          <div className="flex items-center gap-3 px-3 py-2.5 border-t border-slate-100 dark:border-zinc-800">
            {nameAndMeta}
            {actions}
          </div>
        </li>
        {previewModal}
      </>
    );
  }

  return (
    <>
      <li
        className={
          "group flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors " +
          "border-slate-100 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900/60 hover:border-slate-200 dark:hover:border-zinc-700 " +
          (file.isAvailable ? "cursor-pointer" : "")
        }
        onClick={() => {
          if (!file.isAvailable || renaming) return;
          onDownload();
        }}
      >
        {/* Extension badge */}
        <span className={"w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0 text-[9px] font-bold uppercase tracking-wide " + extColor}>
          {file.ext}
        </span>

        {nameAndMeta}
        {actions}
      </li>
      {previewModal}
    </>
  );
}

// ── CommentDropZone ──────────────────────────────────────────────────────────
// Makes one already-posted comment its own drop target — but only ever
// rendered `active` for the viewer's own comments (see the Comments section
// below). A drop here calls onFilesDropped and stops the event's propagation
// so it never also reaches TicketDetailScreen's page-level drop handler,
// which is exactly how "drop outside a comment → ticket attachment instead"
// falls out for free: nothing special-cases it, the event simply never gets
// there. Inactive comments (someone else's) render `children` completely
// unwrapped — no drag handlers, so a drop on those already bubbles straight
// to the page-level handler.
function CommentDropZone({
  active,
  onFilesDropped,
  children,
}: {
  active: boolean;
  onFilesDropped: (files: File[]) => void;
  children: ReactNode;
}) {
  const [dragOver, setDragOver] = useState(false);
  const counterRef = useRef(0);

  if (!active) return <>{children}</>;

  function isFileDrag(e: ReactDragEvent): boolean {
    return Array.from(e.dataTransfer?.types ?? []).includes("Files");
  }

  return (
    <div
      className={
        "rounded-xl transition-colors " +
        (dragOver ? "ring-2 ring-brand-500 dark:ring-brand-accent/70" : "")
      }
      onDragEnter={(e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        counterRef.current += 1;
        setDragOver(true);
      }}
      onDragOver={(e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
      }}
      onDragLeave={(e) => {
        if (!isFileDrag(e)) return;
        e.stopPropagation();
        counterRef.current -= 1;
        if (counterRef.current <= 0) {
          counterRef.current = 0;
          setDragOver(false);
        }
      }}
      onDrop={(e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        counterRef.current = 0;
        setDragOver(false);
        if (e.dataTransfer.files.length > 0) onFilesDropped(Array.from(e.dataTransfer.files));
      }}
    >
      {children}
    </div>
  );
}

// ── CommentItem ──────────────────────────────────────────────────────────────
// One posted comment: real rich-text rendering (RichTextViewer, migrating
// legacy plain text transparently) plus, only for the viewer's own
// comments, a click-to-edit affordance reusing RichTextEditor and the same
// click-pencil/Cancel-Save pattern EditableDescription already established
// — never a second editing UI. Wraps CommentDropZone itself so the .map()
// call site in TicketDetailScreen stays a single, simple component call.

function CommentItem({
  comment,
  projectSlug,
  isOwn,
  mentionCandidates,
  onFilesDropped,
  onSaveEdit,
  onSaveAttachmentEdits,
  onReply,
  onDelete,
  onReact,
  replySlot,
}: {
  comment: TicketComment;
  projectSlug?: string;
  /** Only the viewer's own comments are editable/deletable or become drop
   *  targets — ticket_comments_update RLS (20260907000000) and the
   *  delete_ticket_comment RPC (20260912000000) both enforce the same rule
   *  again at the database level regardless of what this prop says. */
  isOwn: boolean;
  /** Real, active members of this comment's own project — same list the
   *  composer's own RichTextEditor uses, so @mention support is identical
   *  whether creating a comment or editing an existing one. */
  mentionCandidates: MentionCandidate[];
  onFilesDropped: (files: File[]) => void;
  /** `hasAttachments` — whether the comment will still have at least one
   *  attachment once this edit session's staged changes apply; the only
   *  case in which its text may be saved empty. */
  onSaveEdit: (html: string, hasAttachments: boolean) => Promise<boolean>;
  /** Applies this edit session's staged attachment changes (removals +
   *  new uploads) — called once, right after onSaveEdit succeeds, never
   *  before. Both operations reuse the exact same deleteTicketAttachment/
   *  uploadFilesToComment calls the general Attachments section and the
   *  new-comment composer already use. */
  onSaveAttachmentEdits: (toRemove: TicketAttachment[], newFiles: File[]) => Promise<void>;
  /** Opens the "Replying to {this comment's author}" composer under this
   *  comment. Only ever rendered for a top-level comment (see the "Reply"
   *  button below) — with a single level of nesting, offering it on a
   *  reply too would be confusing even though it wouldn't actually create
   *  a second level (the database trigger would just re-file it under the
   *  same parent). Still accepted unconditionally here so CommentItem
   *  doesn't need a second, reply-specific prop shape. */
  onReply: () => void;
  onDelete: () => void;
  /** Like/Dislike on this exact comment — offered on parent and reply
   *  comments alike, no distinction (see comment.reactions doc). */
  onReact: (reaction: CommentReactionType) => void;
  /** The reply composer, rendered directly under this exact comment while
   *  it's the active reply target — null the rest of the time. */
  replySlot?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.text);
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Bumped every time editing starts — remounts RichTextEditor with a
  // fresh instance loaded from the latest real comment text, same role it
  // plays in EditableDescription.
  const [editorKey, setEditorKey] = useState(0);
  // Attachment changes staged during this edit session only — neither a
  // removal nor a new file is ever actually persisted until Save (see
  // save() below); Cancel just discards both, leaving the comment's real
  // attachments completely untouched.
  const [stagedFiles, setStagedFiles] = useState<PendingCommentFile[]>([]);
  const [removedAttachmentIds, setRemovedAttachmentIds] = useState<string[]>([]);
  const editFileInputRef = useRef<HTMLInputElement>(null);

  const stageFiles = (files: File[]) => {
    setStagedFiles((prev) => [...prev, ...files.map((file) => ({ id: newId(), file }))]);
  };

  const startEditing = () => {
    setDraft(comment.text);
    setEditorKey((k) => k + 1);
    setStagedFiles([]);
    setRemovedAttachmentIds([]);
    setEditing(true);
  };
  const cancel = () => {
    setDraft(comment.text);
    setStagedFiles([]);
    setRemovedAttachmentIds([]);
    setEditing(false);
  };
  // What this comment's attachments will be once Save applies the staged
  // changes — lets an image-only comment stay editable (and a comment's
  // text be cleared) as long as something is still attached.
  const remainingAttachmentCount =
    comment.attachments.filter((a) => !removedAttachmentIds.includes(a.id)).length + stagedFiles.length;
  const canSave = hasCommentContent(isRichTextEmpty(draft), remainingAttachmentCount);
  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    const ok = await onSaveEdit(isRichTextEmpty(draft) ? "" : sanitizeRichTextHtml(draft), remainingAttachmentCount > 0);
    if (!ok) {
      setSaving(false);
      return;
    }

    const toRemove = comment.attachments.filter((a) => removedAttachmentIds.includes(a.id));
    const newFiles = stagedFiles.map((item) => item.file);
    if (toRemove.length > 0 || newFiles.length > 0) {
      await onSaveAttachmentEdits(toRemove, newFiles);
    }

    setStagedFiles([]);
    setRemovedAttachmentIds([]);
    setSaving(false);
    setEditing(false);
  };

  return (
    <CommentDropZone
      active={isOwn}
      onFilesDropped={(files) => { if (editing) stageFiles(files); else onFilesDropped(files); }}
    >
      <div className="flex items-start gap-3">
        <MemberTrigger
          name={comment.name}
          avatar={comment.avatar}
          profileId={comment.authorProfileId ?? undefined}
          projectSlug={projectSlug}
          className="flex-shrink-0 mt-0.5 rounded-full"
        >
          <Avatar
            src={comment.avatar}
            name={comment.name}
            className="w-7 h-7 rounded-full flex-shrink-0 ring-1 ring-slate-200 dark:ring-zinc-700"
          />
        </MemberTrigger>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold text-slate-800 dark:text-zinc-200 leading-snug">
            <MemberTrigger name={comment.name} avatar={comment.avatar} profileId={comment.authorProfileId ?? undefined} projectSlug={projectSlug} className="hover:underline">
              {comment.name}
            </MemberTrigger>
            <span className="ml-2 font-normal text-slate-400 dark:text-zinc-600">
              · {comment.timeAgo}
              {comment.wasEdited && " · edited"}
            </span>
          </p>

          {editing ? (
            <CommentPasteScope className="mt-2" onFiles={stageFiles}>
              <RichTextEditor
                key={editorKey}
                content={comment.text}
                onChange={setDraft}
                autoFocus
                contentClassName="sm:text-[13px]"
                mentionCandidates={mentionCandidates}
              />

              <input
                ref={editFileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) {
                    stageFiles(Array.from(e.target.files));
                    e.target.value = "";
                  }
                }}
              />

              {comment.attachments.filter((a) => !removedAttachmentIds.includes(a.id)).length > 0 && (
                <div className="mt-2 space-y-1.5">
                  {comment.attachments
                    .filter((a) => !removedAttachmentIds.includes(a.id))
                    .map((a) => (
                      <CommentAttachmentRow
                        key={a.id}
                        file={toAttachmentItem(a)}
                        onRemove={() => setRemovedAttachmentIds((prev) => [...prev, a.id])}
                      />
                    ))}
                </div>
              )}

              {stagedFiles.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  {stagedFiles.map((item) => (
                    <PendingCommentFileRow
                      key={item.id}
                      file={item.file}
                      onRemove={() => setStagedFiles((prev) => prev.filter((p) => p.id !== item.id))}
                    />
                  ))}
                </div>
              )}

              <div className="flex items-center justify-between gap-2 mt-2">
                <button
                  type="button"
                  aria-label="Attach files"
                  onClick={() => editFileInputRef.current?.click()}
                  className="p-1.5 rounded-md text-slate-400 dark:text-zinc-600 hover:text-slate-600 dark:hover:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={cancel}
                    disabled={saving}
                    className="px-3.5 py-1.5 text-[13px] font-medium text-slate-600 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={save}
                    disabled={saving || !canSave}
                    className={[
                      "px-3.5 py-1.5 text-[13px] font-semibold rounded-lg transition-all",
                      saving || !canSave
                        ? "bg-slate-100 dark:bg-zinc-800 text-slate-400 dark:text-zinc-600 cursor-not-allowed"
                        : "bg-brand-500 hover:bg-brand-600 text-white shadow-sm shadow-brand-500/30 cursor-pointer dark:bg-brand-accent dark:hover:bg-brand-accent-strong dark:shadow-brand-accent/30 dark:text-brand-accent-foreground",
                    ].join(" ")}
                  >
                    Save
                  </button>
                </div>
              </div>
            </CommentPasteScope>
          ) : (
            <div className="group relative mt-2 px-4 py-3 rounded-xl bg-slate-50 dark:bg-zinc-900 border border-slate-100 dark:border-zinc-800/80">
              {/* An image-only comment has no text — keep the bubble's own
                  height (it still anchors the edit/delete actions) without
                  rendering an empty rich-text block. */}
              {isRichTextEmpty(comment.text) ? (
                <div className="h-5" aria-hidden="true" />
              ) : (
                <RichTextViewer content={comment.text} className="text-[13px] text-slate-700 dark:text-zinc-300" />
              )}
              {isOwn && (
                <div className="absolute top-2 right-2 flex items-center gap-1">
                  <button
                    className={EDIT_BTN.replace("ml-1.5 ", "")}
                    onClick={startEditing}
                    aria-label="Edit comment"
                  >
                    <PencilIcon />
                  </button>
                  <button
                    className={EDIT_BTN.replace("ml-1.5 ", "")}
                    onClick={() => setConfirmingDelete(true)}
                    aria-label="Delete comment"
                  >
                    <TrashIcon />
                  </button>
                </div>
              )}
            </div>
          )}

          {!editing && (
            confirmingDelete ? (
              <div className="mt-1.5 flex items-center gap-3 px-3 py-1.5 rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50/60 dark:bg-red-950/20">
                <span className="flex-1 text-[12px] text-slate-700 dark:text-zinc-300">Delete this comment?</span>
                <button
                  type="button"
                  onClick={() => { setConfirmingDelete(false); onDelete(); }}
                  className="text-[12px] font-semibold text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 transition-colors"
                >
                  Delete
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  className="text-[12px] text-slate-400 dark:text-zinc-600 hover:text-slate-600 dark:hover:text-zinc-400 transition-colors"
                >
                  Cancel
                </button>
              </div>
            ) : (
              // Like/Dislike are offered on every comment, parent or reply
              // alike; Reply only on top-level ones — with just one level
              // of nesting, "Reply" on a reply would be confusing (it
              // still wouldn't create a second level; the database just
              // auto-files it under the same parent), so it's simplest to
              // not offer it there at all.
              <div className="mt-1.5 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => onReact("like")}
                  aria-label="Like"
                  aria-pressed={comment.reactions.myReaction === "like"}
                  className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md transition-colors hover:bg-slate-100 dark:hover:bg-zinc-800 ${
                    comment.reactions.myReaction === "like"
                      ? "text-brand-600 dark:text-brand-accent"
                      : "text-slate-400 dark:text-zinc-600"
                  }`}
                >
                  <ThumbsUp className="w-4 h-4" strokeWidth={2} />
                  {comment.reactions.likeCount > 0 && (
                    <span className="text-[12px] font-medium">{comment.reactions.likeCount}</span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => onReact("dislike")}
                  aria-label="Dislike"
                  aria-pressed={comment.reactions.myReaction === "dislike"}
                  className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md transition-colors hover:bg-slate-100 dark:hover:bg-zinc-800 ${
                    comment.reactions.myReaction === "dislike"
                      ? "text-red-500 dark:text-red-400"
                      : "text-slate-400 dark:text-zinc-600"
                  }`}
                >
                  <ThumbsDown className="w-4 h-4" strokeWidth={2} />
                  {comment.reactions.dislikeCount > 0 && (
                    <span className="text-[12px] font-medium">{comment.reactions.dislikeCount}</span>
                  )}
                </button>
                {!comment.parentCommentId && (
                  <button
                    type="button"
                    onClick={onReply}
                    className="text-[12px] font-medium text-slate-400 dark:text-zinc-600 hover:text-brand-600 dark:hover:text-brand-accent transition-colors"
                  >
                    Reply
                  </button>
                )}
              </div>
            )
          )}

          {!editing && comment.attachments.length > 0 && (
            <div className="mt-2 space-y-1.5">
              {comment.attachments.map((a) => (
                <CommentAttachmentRow key={a.id} file={toAttachmentItem(a)} />
              ))}
            </div>
          )}

          {replySlot}
        </div>
      </div>
    </CommentDropZone>
  );
}

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className ?? "w-3 h-3"}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ── ReplyComposer ────────────────────────────────────────────────────────────
// Rendered directly under whichever comment "Reply" was just clicked on
// (see CommentItem's replySlot prop) — the same RichTextEditor/attach/
// mention-candidate composer the top-level "Add comment" box already uses,
// just with a small "Replying to {author}" indicator (and its own "X"
// cancel) above it instead of a plain placeholder.

function ReplyComposer({
  authorName,
  draft,
  onChange,
  onCancel,
  onSubmit,
  submitting,
  mentionCandidates,
  pendingFiles,
  onFilesSelected,
  onRemoveFile,
}: {
  authorName: string;
  draft: string;
  onChange: (html: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
  submitting: boolean;
  mentionCandidates: MentionCandidate[];
  pendingFiles: PendingCommentFile[];
  onFilesSelected: (files: File[]) => void;
  onRemoveFile: (id: string) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canSubmit = hasCommentContent(isRichTextEmpty(draft), pendingFiles.length);

  return (
    <CommentPasteScope className="mt-2" onFiles={onFilesSelected}>
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-[12px] text-slate-500 dark:text-zinc-500">
          Replying to <span className="font-semibold text-slate-700 dark:text-zinc-300">{authorName}</span>
        </p>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cancel reply"
          className="p-0.5 rounded text-slate-400 dark:text-zinc-600 hover:text-slate-600 dark:hover:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <RichTextEditor
        content={draft}
        onChange={onChange}
        placeholder="Write a reply…"
        autoFocus
        contentClassName="sm:text-[13px]"
        mentionCandidates={mentionCandidates}
      />

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) {
            onFilesSelected(Array.from(e.target.files));
            e.target.value = "";
          }
        }}
      />

      {pendingFiles.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {pendingFiles.map((item) => (
            <PendingCommentFileRow key={item.id} file={item.file} onRemove={() => onRemoveFile(item.id)} />
          ))}
        </div>
      )}

      <div className="flex items-center justify-between gap-2 mt-2">
        <button
          type="button"
          aria-label="Attach files"
          onClick={() => fileInputRef.current?.click()}
          className="p-1.5 rounded-md text-slate-400 dark:text-zinc-600 hover:text-slate-600 dark:hover:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3.5 py-1.5 text-[13px] font-medium text-slate-600 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={!canSubmit || submitting}
            className={[
              "px-3.5 py-1.5 text-[13px] font-semibold rounded-lg transition-all",
              !canSubmit || submitting
                ? "bg-slate-100 dark:bg-zinc-800 text-slate-400 dark:text-zinc-600 cursor-not-allowed"
                : "bg-brand-500 hover:bg-brand-600 text-white shadow-sm shadow-brand-500/30 cursor-pointer dark:bg-brand-accent dark:hover:bg-brand-accent-strong dark:shadow-brand-accent/30 dark:text-brand-accent-foreground",
            ].join(" ")}
          >
            Reply
          </button>
        </div>
      </div>
    </CommentPasteScope>
  );
}

// ── CommentPasteScope ────────────────────────────────────────────────────────
// Wraps one comment composer (new comment, reply, or an edit session) so
// an image/file pasted anywhere inside it is staged for THAT comment
// (JIR-41). Runs in the capture phase on purpose — see lib/comment-paste.ts
// for why a focus-based check can't work — and never preventDefault()s, so
// text in the same clipboard still pastes into the editor as usual.

function CommentPasteScope({
  onFiles,
  className,
  children,
}: {
  onFiles: (files: File[]) => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={className}
      onPasteCapture={(e) => {
        const files = claimPastedFiles(e.nativeEvent);
        if (files.length > 0) onFiles(files);
      }}
    >
      {children}
    </div>
  );
}

// ── CommentAttachmentRow ─────────────────────────────────────────────────────
// Read-only by design: comment attachments are view/preview/download only in
// this feature (no rename, delete, or upload-from-comment) — see the
// Comments section below. Reuses the same AttachmentPreviewModal, ext badge,
// and downloadTicketAttachment as the general AttachmentsSection so preview
// and download behavior stay identical.

function CommentAttachmentRow({
  file,
  onRemove,
  loadEnabled = true,
}: {
  file: AttachmentItem;
  /** Only passed while editing an existing comment (see CommentItem) —
   *  marks this attachment for removal in that edit session; the real
   *  deleteTicketAttachment call only happens on Save, so Cancel leaves
   *  it untouched. Omitted everywhere else (view mode), which renders
   *  exactly as it always has. */
  onRemove?: () => void;
  /** False only while this row's instance lives inside a collapsed
   *  "Attachments from comments" accordion (see CommentAttachmentsOverview)
   *  — defers resolving/downloading the image until the section is
   *  actually expanded. Every other caller (a comment's own inline
   *  attachments) omits this and keeps the original eager behavior. */
  loadEnabled?: boolean;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  // Never offered for an unavailable file — no physical object exists in
  // Storage to preview.
  const previewKind = file.isAvailable ? getPreviewKind(file.ext) : null;
  // Same detection this section's own AttachmentRow already uses
  // (previewKind === "image") — an inline thumbnail replaces the plain row
  // for these instead of duplicating a second image/extension allowlist.
  const isImage = previewKind === "image";
  const extColor = EXT_COLOR[file.ext] ?? "bg-slate-100 text-slate-500 dark:bg-zinc-800 dark:text-zinc-400";

  const [inlineImageUrl, setInlineImageUrl] = useState<string | null>(null);
  const [inlineImageFailed, setInlineImageFailed] = useState(false);

  useEffect(() => {
    if (!isImage || !loadEnabled) return;
    let cancelled = false;
    resolveTicketAttachmentThumbnailUrl(file.storagePath, file.thumbnailPath).then((result) => {
      if (cancelled) return;
      if (result.status === "error") { setInlineImageFailed(true); return; }
      setInlineImageUrl(result.url);
    });
    return () => { cancelled = true; };
  }, [isImage, loadEnabled, file.storagePath, file.thumbnailPath]);

  // Same behavior as before, just reused by both the image thumbnail and
  // the plain row below: opens the existing preview modal when available,
  // otherwise downloads via the same authenticated fetch either way used.
  const handleClick = () => {
    if (!file.isAvailable) return;
    if (previewKind) {
      setPreviewOpen(true);
      return;
    }
    downloadTicketAttachment(file.storagePath, file.name).then((result) => {
      if (result.status === "error") {
        console.warn("[ticket-detail] comment attachment download failed:", result.message);
      }
    });
  };

  if (onRemove && confirmingRemove) {
    return (
      <div className="flex items-center gap-3 px-3 py-2 rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50/60 dark:bg-red-950/20">
        <span className="flex-1 min-w-0 text-[12px] text-slate-700 dark:text-zinc-300 truncate">
          Remove <strong className="font-semibold">{file.name}</strong>?
        </span>
        <button
          type="button"
          onClick={() => { setConfirmingRemove(false); onRemove(); }}
          className="flex-shrink-0 text-[12px] font-semibold text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 transition-colors"
        >
          Remove
        </button>
        <button
          type="button"
          onClick={() => setConfirmingRemove(false)}
          className="flex-shrink-0 text-[12px] text-slate-400 dark:text-zinc-600 hover:text-slate-600 dark:hover:text-zinc-400 transition-colors"
        >
          Cancel
        </button>
      </div>
    );
  }

  if (isImage) {
    return (
      <div className="relative">
        <button
          type="button"
          onClick={handleClick}
          className="w-full rounded-lg border border-slate-100 dark:border-zinc-800 bg-white dark:bg-zinc-950/40 hover:border-slate-200 dark:hover:border-zinc-700 transition-colors overflow-hidden text-left"
        >
          <div className="w-full h-48 flex items-center justify-center bg-slate-50 dark:bg-zinc-900">
            {inlineImageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={inlineImageUrl} alt={file.name} loading="lazy" className="max-w-full max-h-full object-contain" />
            )}
            {!inlineImageUrl && !inlineImageFailed && (
              <svg className="w-4 h-4 animate-spin text-slate-300 dark:text-zinc-700" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            )}
            {inlineImageFailed && (
              <p className="text-[11px] text-slate-400 dark:text-zinc-600">Couldn&apos;t load preview.</p>
            )}
          </div>
          <div className="flex items-center gap-2 px-2.5 py-1.5 border-t border-slate-100 dark:border-zinc-800">
            <span className="flex-1 min-w-0 text-[12px] font-medium text-slate-700 dark:text-zinc-300 truncate">
              {file.name}
            </span>
            <span className="text-[11px] text-slate-400 dark:text-zinc-600 flex-shrink-0">{file.size}</span>
          </div>
        </button>

        {onRemove && (
          <button
            type="button"
            aria-label={`Remove ${file.name}`}
            onClick={() => setConfirmingRemove(true)}
            className="absolute top-1.5 right-1.5 p-1 rounded-md bg-white/90 dark:bg-zinc-950/80 text-slate-400 dark:text-zinc-600 hover:text-red-600 dark:hover:text-red-400 hover:bg-white dark:hover:bg-zinc-900 shadow-sm transition-colors"
          >
            <TrashIcon className="w-3 h-3" />
          </button>
        )}

        {previewOpen && previewKind && createPortal(
          <AttachmentPreviewModal file={file} kind={previewKind} onClose={() => setPreviewOpen(false)} />,
          document.body
        )}
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        disabled={!file.isAvailable}
        onClick={handleClick}
        className={
          "w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-slate-100 dark:border-zinc-800 bg-white dark:bg-zinc-950/40 hover:border-slate-200 dark:hover:border-zinc-700 transition-colors text-left disabled:cursor-default disabled:hover:border-slate-100 dark:disabled:hover:border-zinc-800" +
          (onRemove ? " pr-8" : "")
        }
      >
        <span className={"w-5 h-5 rounded flex items-center justify-center flex-shrink-0 text-[7px] font-bold uppercase tracking-wide " + extColor}>
          {file.ext}
        </span>
        <span className="flex-1 min-w-0 text-[12px] font-medium text-slate-700 dark:text-zinc-300 truncate">
          {file.name}
        </span>
        {file.isAvailable ? (
          <span className="text-[11px] text-slate-400 dark:text-zinc-600 flex-shrink-0">{file.size}</span>
        ) : (
          <span className="text-[11px] font-medium text-amber-600 dark:text-amber-400 flex-shrink-0">Not included in this backup</span>
        )}
      </button>

      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${file.name}`}
          onClick={() => setConfirmingRemove(true)}
          className="absolute top-1/2 -translate-y-1/2 right-2 p-1 rounded text-slate-300 dark:text-zinc-600 hover:text-red-600 dark:hover:text-red-400 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
        >
          <TrashIcon className="w-3 h-3" />
        </button>
      )}

      {previewOpen && previewKind && createPortal(
        <AttachmentPreviewModal file={file} kind={previewKind} onClose={() => setPreviewOpen(false)} />,
        document.body
      )}
    </div>
  );
}

// ── PendingCommentFileRow ────────────────────────────────────────────────────
// Staged, not-yet-uploaded file in the comment composer — same ext badge and
// size formatting as CommentAttachmentRow/AttachmentRow, but with a Remove
// action instead of preview/download since there's nothing to open yet.

function PendingCommentFileRow({ file, onRemove }: { file: File; onRemove: () => void }) {
  const ext = getExt(file.name);
  const extColor = EXT_COLOR[ext] ?? "bg-slate-100 text-slate-500 dark:bg-zinc-800 dark:text-zinc-400";
  // A staged image shows itself (JIR-41) — a purely local object URL, so
  // nothing is uploaded or fetched until the comment is actually posted.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file.type.startsWith("image/")) return;
    const url = URL.createObjectURL(file);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: the object URL must be created and revoked by the same effect run (a memoized URL would be revoked by Strict Mode's extra cleanup and never recreated)
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  return (
    <div className="w-full rounded-lg border border-slate-100 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900/60 overflow-hidden">
      {previewUrl && (
        <div className="w-full h-32 flex items-center justify-center border-b border-slate-100 dark:border-zinc-800">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={previewUrl} alt={file.name} className="max-w-full max-h-full object-contain" />
        </div>
      )}
    <div className="w-full flex items-center gap-2 px-2.5 py-1.5">
      <span className={"w-5 h-5 rounded flex items-center justify-center flex-shrink-0 text-[7px] font-bold uppercase tracking-wide " + extColor}>
        {ext}
      </span>
      <span className="flex-1 min-w-0 text-[12px] font-medium text-slate-700 dark:text-zinc-300 truncate">
        {file.name}
      </span>
      <span className="text-[11px] text-slate-400 dark:text-zinc-600 flex-shrink-0">{formatBytes(file.size)}</span>
      <button
        type="button"
        aria-label={`Remove ${file.name}`}
        onClick={onRemove}
        className="p-1 rounded text-slate-400 dark:text-zinc-600 hover:text-slate-600 dark:hover:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors flex-shrink-0"
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
          <path strokeLinecap="round" d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
    </div>
  );
}

// ── AttachmentPreviewModal ───────────────────────────────────────────────────

function AttachmentPreviewModal({
  file,
  kind,
  onClose,
}: {
  file: AttachmentItem;
  kind: "image" | "pdf";
  onClose: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    resolveTicketAttachmentPreviewUrl(file.storagePath).then((result) => {
      if (cancelled) return;
      if (result.status === "error") { setFailed(true); return; }
      setUrl(result.url);
    });
    return () => { cancelled = true; };
  }, [file.storagePath]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 dark:bg-black/60" onClick={onClose} aria-hidden="true" />
      <div
        className="relative w-full max-w-2xl max-h-[calc(100dvh-3rem)] flex flex-col rounded-2xl border shadow-2xl bg-white dark:bg-zinc-900 border-slate-200 dark:border-zinc-700 shadow-black/15 dark:shadow-black/50 overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="attachment-preview-title"
      >
        <div className="flex-shrink-0">
          <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-slate-100 dark:border-zinc-800">
            <h2 id="attachment-preview-title" className="text-[15px] font-bold text-slate-900 dark:text-zinc-50 truncate pr-4">
              {file.name}
            </h2>
            <button
              onClick={onClose}
              className="w-6 h-6 rounded-md flex items-center justify-center text-slate-400 dark:text-zinc-500 hover:text-slate-600 dark:hover:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors flex-shrink-0"
              aria-label="Close"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                <path strokeLinecap="round" d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          {kind === "image" && url && !failed && (
            <div className="border-b border-slate-100 dark:border-zinc-800">
              <ImageViewerToolbar
                onOpenOriginal={() => window.open(url, "_blank", "noopener,noreferrer")}
                onDownload={() => {
                  downloadTicketAttachment(file.storagePath, file.name).then((result) => {
                    if (result.status === "error") {
                      console.warn("[ticket-detail] attachment download failed:", result.message);
                    }
                  });
                }}
              />
            </div>
          )}
        </div>

        <div className={`flex-1 min-h-0 bg-slate-50 dark:bg-zinc-950/40 ${kind === "image" ? "overflow-hidden" : "overflow-auto"}`}>
          {!url && !failed && (
            <div className="flex items-center justify-center h-[70vh]">
              <svg className="w-5 h-5 animate-spin text-slate-300 dark:text-zinc-700" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            </div>
          )}

          {failed && (
            <p className="text-[13px] text-slate-400 dark:text-zinc-600 text-center py-16">
              Couldn&apos;t load preview.
            </p>
          )}

          {url && kind === "image" && (
            <div className="h-[70vh]">
              <ImageViewerCanvas src={url} alt={file.name} />
            </div>
          )}

          {url && kind === "pdf" && (
            <iframe src={url} title={file.name} className="w-full h-[70vh] border-0" />
          )}
        </div>
      </div>
    </div>
  );
}

// ── AttachmentsSection ────────────────────────────────────────────────────────

function toAttachmentItem(a: TicketAttachment): AttachmentItem {
  return {
    id: a.id,
    name: a.filename,
    ext: getExt(a.filename),
    size: formatBytes(a.sizeBytes),
    addedBy: a.uploadedByName,
    avatar: a.uploadedByAvatar,
    profileId: a.uploadedByProfileId,
    uploadedAt: a.uploadedAt,
    storagePath: a.storagePath,
    isAvailable: a.isAvailable,
    thumbnailPath: a.thumbnailPath,
  };
}

// ── CommentAttachmentsOverview ───────────────────────────────────────────────
// Read-only, consolidated view of every attachment posted through any
// comment on this ticket — parent or reply alike, same as CommentItem's own
// Reply action makes no distinction between them. Purely a derived render
// over the already-loaded `comments` array (no second fetch, no separate
// state, nothing here can upload/edit/delete) — reuses the exact same
// CommentAttachmentRow (image inline preview / clickable non-image row)
// every comment's own inline attachments already render, so this can never
// drift into a second attachment presentation. Order matches exactly what
// the Comments section itself already displays — groupCommentThreads'
// own top-level-then-its-replies shape — rather than inventing a
// different sort for this same data.
function CommentAttachmentsOverview({
  comments,
  projectSlug,
}: {
  comments: TicketComment[];
  projectSlug?: string;
}) {
  const commentsWithAttachments = groupCommentThreads(comments)
    .flatMap(({ parent, replies }) => [parent, ...replies])
    .filter((c) => c.attachments.length > 0);

  // Sticky once true: this section starts collapsed (defaultOpen={false}),
  // so its own CommentAttachmentRow instances must not resolve a signed URL
  // or download an image until the user actually expands it — every
  // attachment here is also already rendered inline on its own comment
  // above, so a closed accordion has zero reason to duplicate that fetch.
  // Once opened it stays "loaded" even if collapsed again, instead of
  // re-fetching on every expand.
  const [everOpened, setEverOpened] = useState(false);

  if (commentsWithAttachments.length === 0) return null;

  const totalAttachments = commentsWithAttachments.reduce((sum, c) => sum + c.attachments.length, 0);

  return (
    <CollapsibleSection
      title="Attachments from comments"
      badge={`· ${totalAttachments} total`}
      defaultOpen={false}
      onOpenChange={(open) => { if (open) setEverOpened(true); }}
    >
      <div className="space-y-5">
        {commentsWithAttachments.map((c) => (
          <div key={c.id}>
            <div className="flex items-center gap-2 mb-2">
              <MemberTrigger
                name={c.name}
                avatar={c.avatar}
                profileId={c.authorProfileId ?? undefined}
                projectSlug={projectSlug}
                className="flex-shrink-0 rounded-full"
              >
                <Avatar
                  src={c.avatar}
                  name={c.name}
                  className="w-5 h-5 rounded-full flex-shrink-0 ring-1 ring-white dark:ring-zinc-900"
                />
              </MemberTrigger>
              <p className="text-[12px] text-slate-500 dark:text-zinc-400 min-w-0 truncate">
                <MemberTrigger
                  name={c.name}
                  avatar={c.avatar}
                  profileId={c.authorProfileId ?? undefined}
                  projectSlug={projectSlug}
                  className="font-semibold text-slate-700 dark:text-zinc-300 hover:underline"
                >
                  {c.name}
                </MemberTrigger>
                <span> · {c.timeAgo}</span>
              </p>
            </div>
            <div className="space-y-1.5">
              {c.attachments.map((a) => (
                <CommentAttachmentRow key={a.id} file={toAttachmentItem(a)} loadEnabled={everOpened} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </CollapsibleSection>
  );
}

// Imperative handle so the page-level drag & drop / paste handlers (see
// TicketDetailScreen) can feed files into this exact section's own
// startUpload — the same validations/upload/visualization "Upload Files"
// already uses — instead of a second, parallel upload implementation.
export type AttachmentsSectionHandle = {
  /** `onSettled` is optional and additive only — it fires once this exact
   *  batch has fully settled (every file either uploaded or failed), on top
   *  of (never instead of) the section's own onUploaded/onError props,
   *  which keep firing exactly as before for every caller. Only the
   *  page-level paste handler passes it today (to know precisely when its
   *  own toast should flip from "uploading" to success/error); the file
   *  input button and drag & drop omit it and are completely unaffected. */
  addFiles: (
    files: FileList | File[],
    onSettled?: (results: { file: File; ok: boolean; filename?: string }[]) => void
  ) => void;
};

const AttachmentsSection = forwardRef<
  AttachmentsSectionHandle,
  {
    ticketId: string;
    /** This ticket's own real project — passed straight through to each
     *  AttachmentRow's "addedBy" MemberTrigger. */
    projectSlug?: string;
    isDevFallback: boolean;
    /** Called after a successful upload, rename, or delete — a database trigger already logged the real activity row; this just tells the parent to refetch it. */
    onUploaded: () => void;
    /** Called with a message when an upload/rename/delete fails — surfaced via the shared error toast. */
    onError: (message: string) => void;
  }
>(function AttachmentsSection({ ticketId, projectSlug, isDevFallback, onUploaded, onError }, ref) {
  const [attachments,   setAttachments]   = useState<AttachmentItem[]>([]);
  const [uploading,     setUploading]     = useState<UploadingItem[]>([]);
  const [dragActive,    setDragActive]    = useState(false);

  const dragCounter    = useRef(0);
  const fileInputRef   = useRef<HTMLInputElement>(null);

  // Real attachments for this ticket only, loaded from Supabase. Dev
  // fallback: no real ticket row exists to query against, so this simply
  // stays empty (matches Comments/Activity/Labels' own dev-fallback
  // behavior) rather than sending a request guaranteed to fail.
  useEffect(() => {
    if (isDevFallback) return;
    let cancelled = false;
    loadTicketAttachments(ticketId).then((result) => {
      if (cancelled) return;
      if (result.status === "ready") setAttachments(result.attachments.map(toAttachmentItem));
    });
    return () => {
      cancelled = true;
    };
  }, [ticketId, isDevFallback]);

  // Trickle each uploading item's progress bar toward 90% while its real
  // upload request is in flight — Supabase Storage's upload() has no
  // granular byte-progress callback, so this is a visual approximation
  // only (same UploadingRow/progress-bar UI as before); the item is
  // removed and swapped for the real attachment once the actual request
  // settles, in startUpload below, never by this timer.
  useEffect(() => {
    if (uploading.length === 0) return;
    const timer = setTimeout(() => {
      setUploading((prev) =>
        prev.map((item) =>
          item.progress < 90 ? { ...item, progress: Math.min(90, item.progress + Math.random() * 12 + 5) } : item
        )
      );
    }, 150);
    return () => clearTimeout(timer);
  }, [uploading]);

  const startUpload: AttachmentsSectionHandle["addFiles"] = (files, onSettled) => {
    if (isDevFallback) return; // no real ticket to upload against
    const fileArray = Array.from(files);
    const items: UploadingItem[] = fileArray.map((f) => ({
      id:       newId(),
      name:     f.name,
      ext:      getExt(f.name),
      size:     formatBytes(f.size),
      progress: 0,
    }));
    setUploading((prev) => [...prev, ...items]);

    // Only tracked/reported when a caller actually passed onSettled (the
    // page-level paste handler) — an ordinary array push+length check, never
    // touching onUploaded/onError's own existing per-file firing above.
    const settled: { file: File; ok: boolean; filename?: string }[] = [];

    items.forEach((item, i) => {
      const file = fileArray[i];
      uploadTicketAttachment(ticketId, file).then((result) => {
        // Briefly show the bar at 100% (matches the previous "fills, then
        // swaps" visual) before removing the temp row.
        setUploading((prev) => prev.map((u) => (u.id === item.id ? { ...u, progress: 100 } : u)));
        setTimeout(() => {
          setUploading((prev) => prev.filter((u) => u.id !== item.id));
          if (result.status === "error") {
            console.warn("[ticket-detail] attachment upload failed:", result.message);
            onError(result.message);
            settled.push({ file, ok: false });
            if (settled.length === items.length) onSettled?.(settled);
            return;
          }
          setAttachments((prev) => {
            if (prev.some((a) => a.id === result.attachment.id)) return prev;
            return [toAttachmentItem(result.attachment), ...prev];
          });
          onUploaded();
          settled.push({ file, ok: true, filename: result.attachment.filename });
          if (settled.length === items.length) onSettled?.(settled);
        }, 200);
      }).catch((err) => {
        // Without this, a rejected (not just {status:"error"}) upload would
        // leave this item's progress bar stuck on screen forever.
        setUploading((prev) => prev.filter((u) => u.id !== item.id));
        console.warn("[ticket-detail] attachment upload failed:", err);
        onError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
        settled.push({ file, ok: false });
        if (settled.length === items.length) onSettled?.(settled);
      });
    });
  };

  useImperativeHandle(ref, () => ({ addFiles: startUpload }));

  const totalCount = attachments.length + uploading.length;
  const isEmpty    = attachments.length === 0 && uploading.length === 0;

  return (
    <CollapsibleSection
      title="Attachments"
      badge={totalCount > 0 ? `· ${totalCount} ${totalCount === 1 ? "file" : "files"}` : undefined}
      collapsible={false}
      headerAction={
        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-md bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-300 hover:bg-slate-200 dark:hover:bg-zinc-700 transition-colors"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 4v16m8-8H4" strokeLinecap="round" />
          </svg>
          Upload Files
        </button>
      }
    >
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) { startUpload(e.target.files); e.target.value = ""; }
        }}
      />

      {/* Drag zone */}
      <div
        className={"relative" + (dragActive ? " rounded-lg" : "")}
        onDragEnter={(e) => { e.preventDefault(); dragCounter.current++; setDragActive(true); }}
        onDragLeave={() => { dragCounter.current--; if (dragCounter.current === 0) setDragActive(false); }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          dragCounter.current = 0;
          setDragActive(false);
          if (e.dataTransfer.files.length > 0) startUpload(e.dataTransfer.files);
        }}
      >
        {/* Drag-over overlay */}
        {dragActive && (
          <div className="absolute inset-0 rounded-lg bg-white/90 dark:bg-zinc-950/90 border-2 border-dashed border-brand-500 dark:border-brand-accent flex items-center justify-center z-10 pointer-events-none">
            <div className="flex flex-col items-center gap-2">
              <svg className="w-8 h-8 text-brand-500 dark:text-brand-accent/70" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                <path d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <p className="text-[13px] font-semibold text-brand-600 dark:text-brand-accent">Drop files to upload</p>
            </div>
          </div>
        )}

        {/* Empty state */}
        {isEmpty && (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="w-full rounded-lg border-2 border-dashed border-slate-200 dark:border-zinc-800 flex flex-col items-center justify-center py-8 gap-2 hover:border-slate-300 dark:hover:border-zinc-700 hover:bg-slate-50/50 dark:hover:bg-zinc-900/30 transition-colors"
          >
            <svg className="w-7 h-7 text-slate-300 dark:text-zinc-700" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 011.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 00-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 01-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 00-3.375-3.375h-1.5a1.125 1.125 0 01-1.125-1.125v-1.5a3.375 3.375 0 00-3.375-3.375H9.75" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <p className="text-[13px] text-slate-400 dark:text-zinc-600">No attachments yet</p>
            <p className="text-[11px] font-medium text-brand-500 dark:text-brand-accent/70">Click to upload · drag &amp; drop files here</p>
          </button>
        )}

        {/* File list */}
        {!isEmpty && (
          <ul className="space-y-2">
            {uploading.map((u) => <UploadingRow key={u.id} item={u} />)}
            {attachments.map((a) => (
              <AttachmentRow
                key={a.id}
                file={a}
                projectSlug={projectSlug}
                onDelete={() => {
                  // Dev fallback: no real attachment row to delete.
                  if (isDevFallback) {
                    setAttachments((prev) => prev.filter((x) => x.id !== a.id));
                    return;
                  }
                  // Local state only updates after a successful delete, so a
                  // failed delete leaves the row (and its confirm prompt) in
                  // place instead of optimistically vanishing.
                  deleteTicketAttachment(a.id, a.storagePath, a.thumbnailPath).then((result) => {
                    if (result.status === "error") {
                      console.warn("[ticket-detail] attachment delete failed:", result.message);
                      onError(result.message);
                      return;
                    }
                    setAttachments((prev) => prev.filter((x) => x.id !== a.id));
                    // A database trigger already logged the real
                    // "attachment_deleted" activity row as part of the same
                    // delete — refetch instead of inventing a local entry.
                    onUploaded();
                  }).catch((err) => {
                    console.warn("[ticket-detail] attachment delete failed:", err);
                    onError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
                  });
                }}
                onRename={async (name) => {
                  // Dev fallback: no real attachment row to write to, keep
                  // the previous local-only behavior.
                  if (isDevFallback) {
                    setAttachments((prev) => prev.map((x) => x.id === a.id ? { ...x, name, ext: getExt(name) } : x));
                    return true;
                  }
                  // Local state only updates after a successful write, so a
                  // failed rename never shows a name that didn't persist.
                  try {
                    const result = await renameTicketAttachment(a.id, name);
                    if (result.status === "error") {
                      console.warn("[ticket-detail] attachment rename failed:", result.message);
                      onError(result.message);
                      return false;
                    }
                    setAttachments((prev) => prev.map((x) => x.id === a.id ? { ...x, name, ext: getExt(name) } : x));
                    // A database trigger already logged the real
                    // "attachment_renamed" activity row as part of the same
                    // update — refetch instead of inventing a local entry.
                    onUploaded();
                    return true;
                  } catch (err) {
                    console.warn("[ticket-detail] attachment rename failed:", err);
                    onError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
                    return false;
                  }
                }}
                onDownload={() => {
                  // Defense in depth — AttachmentRow already hides the
                  // Download button entirely when !a.isAvailable, so this
                  // should be unreachable, but never attempt a download
                  // against a storage_path known to have no object.
                  if (!a.isAvailable) return;
                  downloadTicketAttachment(a.storagePath, a.name).then((result) => {
                    if (result.status === "error") {
                      console.warn("[ticket-detail] attachment download failed:", result.message);
                    }
                  });
                }}
              />
            ))}
          </ul>
        )}
      </div>
    </CollapsibleSection>
  );
});

// ── Paste-image feedback toast ──────────────────────────────────────────────
// The page-level paste effect (TicketDetailScreen, below) is the only thing
// that ever renders this — pasting an image while Attachments is scrolled
// out of view otherwise gives no sign anything happened until the user
// scrolls down to check. Same shell/position/timing convention as the
// shared ErrorToast (ticket-ui.tsx); positioned a bit higher (bottom-20
// instead of bottom-5) purely so it can never visually stack on top of that
// other, independent toast if both happen to be showing at once. The
// "uploading" state never auto-dismisses on its own — it always gets
// explicitly replaced by "success" (or cleared in favor of the shared error
// toast) once the real upload actually settles, never before.
function PasteImageToast({
  state,
  onDismiss,
}: {
  state: { status: "uploading" } | { status: "success"; filename?: string };
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (state.status !== "success") return;
    const id = setTimeout(onDismiss, 5000);
    return () => clearTimeout(id);
  }, [state.status, onDismiss]);

  return (
    <div className="fixed bottom-20 right-5 z-[60] flex items-center gap-2 bg-slate-900 dark:bg-zinc-800 text-white text-[13px] font-medium px-4 py-2.5 rounded-lg shadow-lg shadow-black/20 max-w-sm">
      {state.status === "uploading" ? (
        <svg className="w-4 h-4 text-slate-300 flex-shrink-0 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      ) : (
        <svg className="w-4 h-4 text-emerald-400 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 12l5 5L20 7" />
        </svg>
      )}
      <span className="leading-snug">
        {state.status === "uploading" ? (
          "Uploading pasted image…"
        ) : (
          <>
            Image attached
            {state.filename && (
              <span className="block text-[11px] font-normal text-slate-300 dark:text-zinc-400 mt-0.5 truncate">
                {state.filename}
              </span>
            )}
          </>
        )}
      </span>
    </div>
  );
}

// ── Development (real GitHub, read-only) ────────────────────────────────────
// Real branches/commits/pull requests related to this ticket by its own
// real code (e.g. "JIR-8") — never by title, author name, or any other
// ambiguous text. See lib/server/ticket-development-actions.ts for the
// actual query/matching/cache logic. Only ever shown once that Server
// Action confirms the project's real, persisted repository_provider is
// "github", a verified OAuth connection exists, and at least one real
// match was found — every other case (no connection, needs-reconnect,
// GitHub error, no matches, no access) renders nothing at all: no CTA, no
// empty state, no technical error inside the ticket. Project Settings'
// own Repository Integration section remains the only place the
// connection itself is configured/connected/disconnected — this is
// read-only display, nothing here can create a branch/PR, comment, merge,
// or otherwise write back to GitHub.

const PR_STATE_LABEL: Record<DevelopmentPullRequestState, string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

// Same pill shape as StatusBadge (ticket-ui.tsx) — inline-flex, px-2 py-0.5,
// rounded-md, text-[11px] font-semibold — reused rather than a new badge
// design; only uppercase/tracking-wide is added on top, to keep the actual
// on-screen text as "MERGED"/"OPEN"/etc.
const PR_STATE_BADGE_CLASS: Record<DevelopmentPullRequestState, string> = {
  open: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400",
  draft: "bg-slate-100 text-slate-500 dark:bg-zinc-800 dark:text-zinc-400",
  merged: "bg-brand-50 text-brand-700 dark:bg-brand-accent/10 dark:text-brand-accent",
  closed: "bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400",
};

// Light — a hover tint and a visible focus ring, never a bordered/filled
// card per row (this is a compact, scannable list, not a set of tiles).
const DEVELOPMENT_ROW_CLASS =
  "flex items-center gap-2.5 px-2 py-1.5 rounded-md transition-colors hover:bg-slate-50 dark:hover:bg-zinc-800/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-500/50 dark:focus-visible:ring-brand-accent/50";

// Small, coherent icon set for the three group headers — plain outline
// strokes matching every other icon already used in this file (e.g. the
// chevron in CollapsibleSection), never a colorful/branded glyph. Purely
// decorative (the adjacent text already names the group), so aria-hidden.
function DevelopmentBranchIcon({ className }: { className: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 3v12M18 9a3 3 0 100-6 3 3 0 000 6zm0 0a9 9 0 01-9 9M6 21a3 3 0 100-6 3 3 0 000 6z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DevelopmentCommitIcon({ className }: { className: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M3 12h6M15 12h6" strokeLinecap="round" />
    </svg>
  );
}

function DevelopmentPullRequestIcon({ className }: { className: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="6" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="6" r="2" />
      <path d="M6 8v8M18 8a6 6 0 01-6 6h-2" strokeLinecap="round" />
    </svg>
  );
}

// Discreet GitHub mark next to the section title — same small size/neutral
// color as the rest of Development's own icon set (branch/commit/PR
// above), never a colorful/branded rendering. Inline SVG, no asset
// download; no other GitHub glyph exists elsewhere in the live codebase to
// import instead (the old Settings → Integrations mock section, the only
// prior place one existed, was removed outright in an earlier pass).
function DevelopmentGithubIcon({ className }: { className: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 0C5.373 0 0 5.373 0 12c0 5.303 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.727-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.117 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.565 21.796 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
    </svg>
  );
}

// GitHub's own auto-generated merge commit message ("Merge pull request #1
// from owner/branch") is meaningless noise in a compact list — shown here
// as "Merged "<PR title>"" when that PR's title is already available from
// this same Development load (a Map built from the already-fetched
// pullRequests, never a second GitHub request just to look it up). If no
// matching PR is found, the original message is left exactly as GitHub
// wrote it — never a fabricated "Merged Pull Request #N" stand-in. Purely
// a display transform either way: the real commit message/SHA/URL are
// never altered, only what's rendered.
const MERGE_COMMIT_RE = /^Merge pull request #(\d+) from \S+/;

function developmentCommitDisplayMessage(rawMessage: string, prTitleByNumber: Map<number, string>): string {
  const message = firstLine(rawMessage);
  const match = message.match(MERGE_COMMIT_RE);
  if (!match) return message;
  const prNumber = Number(match[1]);
  const title = prTitleByNumber.get(prNumber);
  return title ? `Merged "${title}"` : message;
}

// "1 Branch · 3 Commits · 1 PR" — real counts only, correct singular/
// plural, categories with zero items simply omitted. Stays on the same
// single line as the "Development" title (CollapsibleSection's existing
// badge slot, always visible whether collapsed or not), never a second
// line that would grow the header's own height.
function developmentSummaryBadge(branchCount: number, commitCount: number, pullRequestCount: number): string | undefined {
  const parts = [
    branchCount > 0 ? `${branchCount} ${branchCount === 1 ? "Branch" : "Branches"}` : null,
    commitCount > 0 ? `${commitCount} ${commitCount === 1 ? "Commit" : "Commits"}` : null,
    pullRequestCount > 0 ? `${pullRequestCount} ${pullRequestCount === 1 ? "PR" : "PRs"}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? `· ${parts.join(" · ")}` : undefined;
}

// Same title shown whether the section is still loading or ready — never
// changes the visible text "Development", just prefixes the discreet
// GitHub mark next to it.
const DEVELOPMENT_TITLE = (
  <span className="inline-flex items-center gap-1.5">
    <DevelopmentGithubIcon className="w-3.5 h-3.5 text-slate-400 dark:text-zinc-500" />
    Development
  </span>
);

// One group header shape shared by Branches/Commits/Pull Requests — icon +
// name + real count in parentheses (e.g. "Branches (1)"), never a second,
// redundant total alongside CollapsibleSection's own existing header badge.
function developmentGroupHeader(icon: ReactNode, text: string, count: number) {
  return (
    <div className="flex items-center gap-1.5 mb-1">
      {icon}
      <p className="text-[11px] font-semibold text-slate-500 dark:text-zinc-400">
        {text} <span className="font-normal text-slate-400 dark:text-zinc-600">({count})</span>
      </p>
    </div>
  );
}

// First line only — a multi-line commit message shouldn't blow up a single
// compact row; the rest is still one click away on GitHub itself.
function firstLine(message: string): string {
  return message.split("\n")[0] || message;
}

// Same session-bridge mechanism project-settings-screen.tsx's own
// bridgeGithubSession() already established for the exact same reason: a
// Server Action's own arguments are visible in Next.js's dev-time Server
// Action logging, so the Supabase JWT must never be one of them. Reused
// here (same cookie name/path/lifetime) rather than a second
// authentication strategy; duplicated locally rather than extracted into a
// new shared client module, matching this app's existing convention of
// keeping each screen's own small helpers local.
async function bridgeGithubSessionForDevelopment(): Promise<boolean> {
  const supabase = getSupabaseBrowserClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return false;

  const isSecureContext = window.location.protocol === "https:";
  document.cookie = [
    `jirita_gh_bridge=${encodeURIComponent(session.access_token)}`,
    "Path=/",
    "Max-Age=30",
    "SameSite=Lax",
    isSecureContext ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
  return true;
}

type DevelopmentState = "loading" | TicketDevelopmentResult;

function DevelopmentSection({ slug, ticketCode }: { slug: string; ticketCode: string }) {
  const { organization, isDevFallback } = useCurrentUser();
  const [state, setState] = useState<DevelopmentState>("loading");
  const [refreshing, setRefreshing] = useState(false);
  const requestIdRef = useRef(0);
  // The real project id resolved by the effect below — handleRefresh needs
  // it too, but reads it from this ref rather than re-running
  // loadProjectDetail itself, since nothing about the project identity
  // changes between an automatic check and a manual Refresh.
  const projectIdRef = useRef<string | null>(null);

  useEffect(() => {
    // A ticket/project navigation always supersedes any refresh that was
    // still in flight for the previous one — never leave the button stuck
    // disabled for a project/ticket this effect has already moved on from.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: resets whenever this effect's own dependencies (ticket/project identity) genuinely change, same pattern used elsewhere in this app
    setRefreshing(false);

    // Dev fallback never has a real organization/project to resolve a
    // GitHub connection against — no mock Development data is ever shown.
    if (isDevFallback || !organization) {
      projectIdRef.current = null;
      setState({ status: "hidden" });
      return;
    }

    const requestId = ++requestIdRef.current;
    setState("loading");

    // Real projects.id is required by the Server Action below (never
    // resolved by slug/name/position) — loadProjectDetail is the same
    // already-real loader Project Settings itself uses, reused here rather
    // than a second project-lookup implementation.
    loadProjectDetail(organization.id, slug).then((projectResult) => {
      if (requestIdRef.current !== requestId) return;

      if (projectResult.status !== "ready" || projectResult.project.repositoryProvider !== "github") {
        // No GitHub provider configured at all (None or GitLab) — never a
        // CTA to connect one here; that only ever lives in Project Settings.
        projectIdRef.current = null;
        setState({ status: "hidden" });
        return;
      }

      const projectId = projectResult.project.id;
      projectIdRef.current = projectId;
      bridgeGithubSessionForDevelopment().then((bridged) => {
        if (requestIdRef.current !== requestId) return;
        if (!bridged) {
          setState({ status: "hidden" });
          return;
        }
        loadTicketDevelopmentActivityAction({ projectId, ticketCode }).then((result) => {
          if (requestIdRef.current !== requestId) return;
          setState(result);
        });
      });
    });
    // Re-checks only when the ticket/project identity actually changes, or
    // the signed-in org actually changes (organization?.id) — no longer on
    // window-focus/tab-visibility regain. Ticket Detail no longer
    // auto-refreshes on focus at all; the manual "Refresh" button below is
    // now the only way to see new branches/commits/PRs before the Server
    // Action's own 5-minute cache naturally expires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDevFallback, organization?.id, slug, ticketCode]);

  // Manual "Refresh" — the only way to see new branches/commits/PRs before
  // the 5-minute cache naturally expires, without polling or reloading the
  // page. forceRefresh only ever touches this exact project+ticket's own
  // cache entry (rebuilt server-side, never a client-supplied key) and
  // never invalidates the OAuth connection, other tickets, or other
  // projects. Existing data stays on screen for the whole round trip —
  // state is only ever replaced once the new result actually arrives, and
  // the Server Action itself keeps a still-good previous snapshot in place
  // if this particular check comes back empty (see
  // computeTicketDevelopmentActivity in ticket-development-actions.ts), so
  // a transient GitHub error here can't blank out data that was already
  // correctly on screen.
  async function handleRefresh() {
    if (refreshing || !projectIdRef.current) return;
    const projectId = projectIdRef.current;
    const requestId = ++requestIdRef.current;
    setRefreshing(true);

    const bridged = await bridgeGithubSessionForDevelopment();
    if (requestIdRef.current !== requestId) return; // superseded meanwhile — a newer check already owns refreshing/state

    if (!bridged) {
      setRefreshing(false);
      return; // no session to bridge — keep whatever is currently shown, let the user try again
    }

    const result = await loadTicketDevelopmentActivityAction({ projectId, ticketCode, forceRefresh: true });
    if (requestIdRef.current !== requestId) return;
    setRefreshing(false);
    setState(result);
  }

  if (state === "loading") {
    return (
      <CollapsibleSection title={DEVELOPMENT_TITLE}>
        <div className="space-y-2">
          <SkeletonBlock className="h-9 w-full rounded-lg" />
          <SkeletonBlock className="h-9 w-full rounded-lg" />
        </div>
      </CollapsibleSection>
    );
  }

  if (state.status === "hidden") return null;

  const { branches, commits, pullRequests } = state;
  // PR titles already loaded in this same Development fetch — reused to
  // make a GitHub merge commit's own auto-generated message readable,
  // never a second GitHub request just to look one up.
  const prTitleByNumber = new Map(pullRequests.map((pr) => [pr.number, pr.title]));

  return (
    <CollapsibleSection
      title={DEVELOPMENT_TITLE}
      badge={developmentSummaryBadge(branches.length, commits.length, pullRequests.length)}
      headerAction={
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-md bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-300 hover:bg-slate-200 dark:hover:bg-zinc-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          <svg
            className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              d="M4 4v5h5M20 20v-5h-5M4.5 9a8 8 0 0114.5-3M19.5 15a8 8 0 01-14.5 3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Refresh
        </button>
      }
    >
      <div className="space-y-3">
        {branches.length > 0 && (
          <div>
            {developmentGroupHeader(<DevelopmentBranchIcon className="w-3.5 h-3.5 text-slate-400 dark:text-zinc-500" />, "Branches", branches.length)}
            <ul>
              {branches.map((branch) => (
                <li key={branch.name}>
                  <a
                    href={branch.htmlUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Open branch ${branch.name} on GitHub`}
                    className={DEVELOPMENT_ROW_CLASS}
                  >
                    <DevelopmentBranchIcon className="w-3.5 h-3.5 text-slate-400 dark:text-zinc-500 flex-shrink-0" />
                    <span className="text-[13px] font-mono text-slate-700 dark:text-zinc-300 break-all">{branch.name}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}

        {commits.length > 0 && (
          <div>
            {developmentGroupHeader(<DevelopmentCommitIcon className="w-3.5 h-3.5 text-slate-400 dark:text-zinc-500" />, "Commits", commits.length)}
            <ul>
              {commits.map((commit) => {
                const displayMessage = developmentCommitDisplayMessage(commit.message, prTitleByNumber);
                return (
                <li key={commit.htmlUrl}>
                  <a
                    href={commit.htmlUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Open commit ${commit.shaShort} on GitHub: ${displayMessage}`}
                    className={DEVELOPMENT_ROW_CLASS}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] text-slate-700 dark:text-zinc-300 truncate">
                        <span className="font-mono text-slate-400 dark:text-zinc-500 mr-1.5">{commit.shaShort}</span>
                        {displayMessage}
                      </p>
                      <div className="text-[11px] text-slate-400 dark:text-zinc-600 mt-0.5 flex items-center gap-1.5 flex-wrap">
                        <Avatar src={commit.authorAvatar ?? FALLBACK_AVATAR} name={commit.authorName} alt="" className="w-3.5 h-3.5 rounded-full flex-shrink-0" />
                        <span className="truncate">{commit.authorName}</span>
                        <span aria-hidden="true">·</span>
                        <span className="flex-shrink-0">{formatRelativeTime(commit.authoredAt)}</span>
                      </div>
                    </div>
                  </a>
                </li>
                );
              })}
            </ul>
          </div>
        )}

        {pullRequests.length > 0 && (
          <div>
            {developmentGroupHeader(<DevelopmentPullRequestIcon className="w-3.5 h-3.5 text-slate-400 dark:text-zinc-500" />, "Pull Requests", pullRequests.length)}
            <ul>
              {pullRequests.map((pr) => (
                <li key={pr.number}>
                  <a
                    href={pr.htmlUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Open pull request #${pr.number} on GitHub: ${pr.title}, ${PR_STATE_LABEL[pr.state]}`}
                    className={DEVELOPMENT_ROW_CLASS}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] text-slate-700 dark:text-zinc-300 truncate">
                        <span className="font-mono text-slate-400 dark:text-zinc-500 mr-1.5">#{pr.number}</span>
                        {pr.title}
                      </p>
                      <div className="text-[11px] text-slate-400 dark:text-zinc-600 mt-0.5 flex items-center gap-1.5 flex-wrap">
                        <Avatar src={pr.authorAvatar ?? FALLBACK_AVATAR} name={pr.authorName} alt="" className="w-3.5 h-3.5 rounded-full flex-shrink-0" />
                        <span className="truncate">{pr.authorName}</span>
                        <span aria-hidden="true">·</span>
                        <span className="flex-shrink-0">{formatRelativeTime(pr.updatedAt)}</span>
                        {pr.headBranch && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono truncate">{pr.headBranch}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <span
                      className={`inline-flex items-center flex-shrink-0 px-2 py-0.5 rounded-md text-[11px] font-semibold uppercase tracking-wide ${PR_STATE_BADGE_CLASS[pr.state]}`}
                    >
                      {PR_STATE_LABEL[pr.state]}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}

// ── Time Tracking ─────────────────────────────────────────────────────────────

interface TimeEntry {
  id:           string;
  /** Real, exact minutes — the source of truth for editing (prefills
   *  LogTimeModal) and for the entry's own author check. Never derived
   *  from `hours` (hours*60 would reintroduce float error for a
   *  non-quarter-hour value like 3 minutes). */
  minutes:      number;
  hours:        number;
  comment:      string;
  date:         string;
  /** Real ISO date (yyyy-mm-dd) — `date` above is already formatted for
   *  display only; editing needs the raw value to prefill the date input. */
  workDateISO:  string;
  authorName:   string;
  authorAvatar: string;
  /** Real profiles.id of who logged this entry, when known — lets
   *  TimeHistoryModal restrict Edit/Delete to the entry's own real author. */
  authorProfileId: string | null;
}


// workDate is a date-only column (the calendar day work was logged against,
// not a real moment in time) — always shown as an absolute calendar date,
// never "Today"/"Yesterday" or relative text, so historical entries stay
// traceable and every entry always includes its year.
function formatDateDisplay(iso: string): string {
  return formatAbsoluteDate(iso);
}

// Presentation only, used consistently across the whole TimeHistoryModal —
// both its own per-entry rows and its top Logged/Estimated/Remaining
// figures — so every hours value in that one modal reads the same way
// (the underlying numbers themselves stay exact; e.g. a 5-minute entry is
// really 0.08333333333333333, unreadable printed raw). Caps at 4 decimals
// and drops trailing zeros (0.0833h, 0.05h, 1h, 1.5h), never rounding to a
// coarser increment the way formatHours/formatRemainingHours' own
// 1-decimal rounding does — those two are untouched and keep formatting
// every other Time Tracking total in the app (TimeTrackingSection's own
// summary line, the ticket sidebar's Logged/Remaining) exactly as before.
function formatEntryHours(hours: number): string {
  return Number(hours.toFixed(4)).toString();
}

function toTimeEntry(record: TimeEntryRecord): TimeEntry {
  return {
    id: record.id,
    minutes: record.minutes,
    // Exact, never pre-rounded: record.minutes is the real logged duration
    // (logTicketTime no longer force-rounds it to any increment), and
    // rounding this per-entry value to 1 decimal before it's summed below
    // (as this used to do) both loses real precision on a single entry and
    // compounds across every entry once totaled for the ticket's own
    // total/remaining — display-rounding (formatHours/formatRemainingHours)
    // already happens exactly once, at that final total, which is the only
    // place it should.
    hours: record.minutes / 60,
    comment: record.comment,
    date: formatDateDisplay(record.workDate),
    workDateISO: record.workDate,
    authorName: record.loggedByName,
    authorAvatar: record.loggedByAvatar,
    authorProfileId: record.loggedByProfileId,
  };
}

function LogTimeModal({
  onClose,
  onSubmit,
  initialEntry,
}: {
  onClose:  () => void;
  // Returns whether the entry actually persisted — the modal only closes
  // itself on success, matching every other real-data modal in this file.
  onSubmit: (input: LogTimeInput) => Promise<boolean>;
  /** Present only when editing an already-logged entry (see
   *  TimeHistoryModal) — prefills every field from its real, exact values
   *  and switches the header/submit label to "Edit"/"Save". Omitted when
   *  logging a brand-new entry, which keeps every field at its original
   *  empty/today default. */
  initialEntry?: { minutes: number; comment: string; workDate: string };
}) {
  const isEditing = initialEntry !== undefined;
  const [hrsStr,  setHrsStr]  = useState(() => (initialEntry ? String(Math.floor(initialEntry.minutes / 60)) : ""));
  const [minsStr, setMinsStr] = useState(() => (initialEntry ? String(initialEntry.minutes % 60) : ""));
  const [comment, setComment] = useState(initialEntry?.comment ?? "");
  const [date,    setDate]    = useState(() => initialEntry?.workDate ?? getTodayISO());
  const [submitting, setSubmitting] = useState(false);

  const hrsRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    hrsRef.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const h          = Math.max(0, parseInt(hrsStr  || "0", 10) || 0);
  const m          = Math.max(0, Math.min(59, parseInt(minsStr || "0", 10) || 0));
  const totalMinutes = h * 60 + m;
  const canSubmit  = totalMinutes > 0 && !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    const ok = await onSubmit({
      minutes:  totalMinutes,
      comment:  comment.trim(),
      workDate: date,
    });
    setSubmitting(false);
    if (ok) onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/40 dark:bg-black/60"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className={[
          "relative w-full max-w-sm rounded-2xl border shadow-2xl",
          "bg-white dark:bg-zinc-900",
          "border-slate-200 dark:border-zinc-700",
          "shadow-black/15 dark:shadow-black/50",
        ].join(" ")}
        role="dialog"
        aria-modal="true"
        aria-labelledby="log-time-title"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-slate-100 dark:border-zinc-800">
          <h2 id="log-time-title" className="text-[15px] font-bold text-slate-900 dark:text-zinc-50">
            {isEditing ? "Edit Time Entry" : "Log Time"}
          </h2>
          <button
            onClick={onClose}
            className="w-6 h-6 rounded-md flex items-center justify-center text-slate-400 dark:text-zinc-500 hover:text-slate-600 dark:hover:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
            aria-label="Close"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {/* Time */}
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600 mb-1.5">
              Worked Time
            </label>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <input
                  ref={hrsRef}
                  type="number"
                  min="0"
                  max="99"
                  placeholder="0"
                  value={hrsStr}
                  onChange={(e) => setHrsStr(e.target.value)}
                  onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") handleSubmit(); }}
                  className="bg-white dark:bg-zinc-950 text-[16px] sm:text-[13px] font-medium text-slate-800 dark:text-zinc-200 border border-slate-200 dark:border-zinc-700 rounded-md px-2 py-1 outline-none focus:border-brand-500 dark:focus:border-brand-accent focus:ring-1 focus:ring-brand-500/30 w-16 text-center dark:focus:ring-brand-accent/30"
                />
                <span className="text-[13px] text-slate-500 dark:text-zinc-400 font-medium">h</span>
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min="0"
                  max="59"
                  placeholder="0"
                  value={minsStr}
                  onChange={(e) => setMinsStr(e.target.value)}
                  onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") handleSubmit(); }}
                  className="bg-white dark:bg-zinc-950 text-[16px] sm:text-[13px] font-medium text-slate-800 dark:text-zinc-200 border border-slate-200 dark:border-zinc-700 rounded-md px-2 py-1 outline-none focus:border-brand-500 dark:focus:border-brand-accent focus:ring-1 focus:ring-brand-500/30 w-16 text-center dark:focus:ring-brand-accent/30"
                />
                <span className="text-[13px] text-slate-500 dark:text-zinc-400 font-medium">min</span>
              </div>
            </div>
          </div>

          {/* Date */}
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600 mb-1.5">
              Date
            </label>
            <input
              type="date"
              value={date}
              max={getTodayISO()}
              onChange={(e) => setDate(e.target.value)}
              className={INPUT_BASE}
            />
          </div>

          {/* Comment */}
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600 mb-1.5">
              Comment{" "}
              <span className="font-normal normal-case tracking-normal text-slate-400 dark:text-zinc-600">
                (optional)
              </span>
            </label>
            <textarea
              rows={3}
              placeholder="What did you work on?"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              className={
                "w-full resize-none text-[16px] sm:text-[13px] font-medium text-slate-800 dark:text-zinc-200 " +
                "bg-white dark:bg-zinc-950 border border-slate-200 dark:border-zinc-700 rounded-md px-2.5 py-2 outline-none " +
                "focus:border-brand-500 dark:focus:border-brand-accent focus:ring-1 focus:ring-brand-500/30 dark:focus:ring-brand-accent/30 " +
                "placeholder:text-slate-300 dark:placeholder:text-zinc-700"
              }
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 pb-5">
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-1.5 text-[13px] font-medium text-slate-600 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className={[
              "px-3.5 py-1.5 text-[13px] font-semibold rounded-lg transition-all",
              canSubmit
                ? "bg-brand-500 hover:bg-brand-600 text-white shadow-sm shadow-brand-500/30 cursor-pointer dark:bg-brand-accent dark:hover:bg-brand-accent-strong dark:shadow-brand-accent/30 dark:text-brand-accent-foreground"
                : "bg-slate-100 dark:bg-zinc-800 text-slate-400 dark:text-zinc-600 cursor-not-allowed",
            ].join(" ")}
          >
            {isEditing ? "Save" : "Log Time"}
          </button>
        </div>
      </div>
    </div>
  );
}

function TimeHistoryModal({
  entries,
  estimatedHours,
  projectSlug,
  userId,
  isAdmin,
  onClose,
  onUpdateEntry,
  onDeleteEntry,
}: {
  entries:        TimeEntry[];
  estimatedHours: number | undefined;
  projectSlug?: string;
  /** An entry's own real logger, or any Admin, sees Edit/Delete on it —
   *  ticket_time_entries_update/_delete RLS (20260913000000/20260914000000)
   *  enforces the same rule again at the database level regardless of what
   *  this prop says. */
  userId: string | null;
  isAdmin: boolean;
  onClose:        () => void;
  onUpdateEntry: (entryId: string, input: LogTimeInput) => Promise<boolean>;
  onDeleteEntry: (entryId: string) => void;
}) {
  const totalLogged = entries.reduce((s, e) => s + e.hours, 0);
  const remaining   = estimatedHours !== undefined ? Math.max(0, estimatedHours - totalLogged) : undefined;
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const editingEntry = editingEntryId ? entries.find((e) => e.id === editingEntryId) : undefined;

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 dark:bg-black/60" onClick={onClose} aria-hidden="true" />
      <div
        className="relative w-full max-w-md rounded-2xl border shadow-2xl bg-white dark:bg-zinc-900 border-slate-200 dark:border-zinc-700 shadow-black/15 dark:shadow-black/50 overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="hist-modal-title"
      >
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-slate-100 dark:border-zinc-800">
          <h2 id="hist-modal-title" className="text-[15px] font-bold text-slate-900 dark:text-zinc-50">
            Time History
          </h2>
          <button
            onClick={onClose}
            className="w-6 h-6 rounded-md flex items-center justify-center text-slate-400 dark:text-zinc-500 hover:text-slate-600 dark:hover:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
            aria-label="Close"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 pt-4 pb-4 border-b border-slate-100 dark:border-zinc-800">
          <div className="flex items-center gap-6">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600 mb-0.5">Logged</p>
              <p className="text-[18px] font-bold text-slate-800 dark:text-zinc-100 tabular-nums leading-none">{formatEntryHours(totalLogged)}h</p>
            </div>
            {estimatedHours !== undefined && (
              <>
                <div className="w-px h-8 bg-slate-200 dark:bg-zinc-800 flex-shrink-0" />
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600 mb-0.5">Estimated</p>
                  <p className="text-[18px] font-bold text-slate-500 dark:text-zinc-400 tabular-nums leading-none">{formatEntryHours(estimatedHours)}h</p>
                </div>
                {remaining !== undefined && (
                  <>
                    <div className="w-px h-8 bg-slate-200 dark:bg-zinc-800 flex-shrink-0" />
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600 mb-0.5">Remaining</p>
                      <p className={`text-[18px] font-bold tabular-nums leading-none ${remaining === 0 ? "text-emerald-600 dark:text-emerald-400" : "text-slate-800 dark:text-zinc-100"}`}>
                        {formatEntryHours(remaining)}h
                      </p>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>

        <div className="overflow-y-auto max-h-72 px-5 py-3">
          {entries.length === 0 ? (
            <p className="text-[13px] text-slate-400 dark:text-zinc-600 text-center py-6">No entries yet.</p>
          ) : (
            <div>
              {entries.map((entry, i) => {
                const isOwn = userId !== null && entry.authorProfileId === userId;
                // Admin may edit/delete any entry — Project Lead/Member stay
                // restricted to their own (ticket_time_entries_update/_delete
                // RLS, 20260914000000, enforces the same rule again at the
                // database level regardless of what this drives here).
                const canManage = isOwn || isAdmin;
                const isLast = i === entries.length - 1;

                if (confirmingDeleteId === entry.id) {
                  return (
                    <div
                      key={entry.id}
                      className={`flex items-center gap-3 py-3 ${!isLast ? "border-b border-slate-100 dark:border-zinc-800/60" : ""}`}
                    >
                      <div className="flex-1 min-w-0 flex items-center gap-3 px-3 py-2 rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50/60 dark:bg-red-950/20">
                        <span className="flex-1 text-[12px] text-slate-700 dark:text-zinc-300">Delete this entry?</span>
                        <button
                          type="button"
                          onClick={() => { setConfirmingDeleteId(null); onDeleteEntry(entry.id); }}
                          className="flex-shrink-0 text-[12px] font-semibold text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 transition-colors"
                        >
                          Delete
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmingDeleteId(null)}
                          className="flex-shrink-0 text-[12px] text-slate-400 dark:text-zinc-600 hover:text-slate-600 dark:hover:text-zinc-400 transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  );
                }

                return (
                  <div
                    key={entry.id}
                    className={`group flex items-start gap-3.5 py-3 ${!isLast ? "border-b border-slate-100 dark:border-zinc-800/60" : ""}`}
                  >
                    <div className="flex flex-col items-center flex-shrink-0 w-3.5 mt-0.5">
                      <div className="w-1.5 h-1.5 rounded-full bg-brand-400 dark:bg-brand-accent ring-2 ring-white dark:ring-zinc-900" />
                      {!isLast && (
                        <div className="w-px flex-1 bg-slate-200 dark:bg-zinc-800 mt-1 min-h-[20px]" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-3 mb-0.5">
                        <span className="flex items-center gap-1.5 min-w-0">
                          <MemberTrigger
                            name={entry.authorName}
                            avatar={entry.authorAvatar}
                            profileId={entry.authorProfileId ?? undefined}
                            projectSlug={projectSlug}
                            className="flex-shrink-0 rounded-full"
                          >
                            <Avatar
                              src={entry.authorAvatar}
                              name={entry.authorName}
                              className="w-5 h-5 rounded-full flex-shrink-0 ring-1 ring-white dark:ring-zinc-900"
                            />
                          </MemberTrigger>
                          <span className="text-[12px] font-semibold text-slate-500 dark:text-zinc-400 truncate">
                            <MemberTrigger
                              name={entry.authorName}
                              avatar={entry.authorAvatar}
                              profileId={entry.authorProfileId ?? undefined}
                              projectSlug={projectSlug}
                              className="hover:underline"
                            >
                              {entry.authorName}
                            </MemberTrigger>
                            <span className="font-normal text-slate-400 dark:text-zinc-600"> · {entry.date}</span>
                          </span>
                        </span>
                        <span className="flex items-center gap-0.5 flex-shrink-0">
                          <span className="text-[14px] font-bold text-slate-800 dark:text-zinc-100 tabular-nums">{formatEntryHours(entry.hours)}h</span>
                          {canManage && (
                            <>
                              <button
                                type="button"
                                className={EDIT_BTN.replace("ml-1.5 ", "")}
                                onClick={() => setEditingEntryId(entry.id)}
                                aria-label="Edit time entry"
                              >
                                <PencilIcon />
                              </button>
                              <button
                                type="button"
                                className={EDIT_BTN.replace("ml-1.5 ", "")}
                                onClick={() => setConfirmingDeleteId(entry.id)}
                                aria-label="Delete time entry"
                              >
                                <TrashIcon />
                              </button>
                            </>
                          )}
                        </span>
                      </div>
                      {entry.comment && (
                        <p className="text-[13px] text-slate-600 dark:text-zinc-400 leading-snug">
                          &ldquo;{entry.comment}&rdquo;
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end px-5 pb-5 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-1.5 text-[13px] font-medium text-slate-600 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 rounded-lg transition-colors"
          >
            Close
          </button>
        </div>
      </div>

      {editingEntry && (
        <LogTimeModal
          initialEntry={{ minutes: editingEntry.minutes, comment: editingEntry.comment, workDate: editingEntry.workDateISO }}
          onClose={() => setEditingEntryId(null)}
          onSubmit={(input) => onUpdateEntry(editingEntry.id, input)}
        />
      )}
    </div>
  );
}

function TimeTrackingSection({
  ticketId,
  projectSlug,
  entries,
  estimatedHours,
  userId,
  isAdmin,
  onAddEntry,
  onUpdateEntry,
  onDeleteEntry,
  onError,
  isParent = false,
  aggregatedLoggedHours,
}: {
  ticketId:       string;
  /** This ticket's own real project — lets each entry's author "avatar"
   *  MemberTrigger fetch real per-project metrics, same convention as
   *  Comments/Attachments. */
  projectSlug?: string;
  entries:        TimeEntry[];
  estimatedHours: number | undefined;
  /** Passed straight through to TimeHistoryModal — restricts Edit/Delete
   *  there to each entry's own real logger, unless isAdmin. */
  userId: string | null;
  /** Admin may edit/delete any entry, not just their own — see
   *  TicketDetailScreen's own doc comment on this same flag. */
  isAdmin: boolean;
  /** Called with the real, persisted entry — after a successful save only. */
  onAddEntry:     (entry: TimeEntry) => void;
  onUpdateEntry: (entryId: string, input: LogTimeInput) => Promise<boolean>;
  onDeleteEntry: (entryId: string) => void;
  /** Called with a message when a save fails — surfaced via the shared error toast. */
  onError:        (message: string) => void;
  /** A parent ticket can never log time directly on itself (tickets_block_
   *  hours_on_parent / ticket_time_entries_block_on_parent, 20260927000000)
   *  — hides "Log Time" and the per-entry list, replacing them with a note
   *  pointing at aggregatedLoggedHours instead. */
  isParent?: boolean;
  /** Sum of every child ticket's own logged time — only meaningful (and
   *  only passed) when isParent. */
  aggregatedLoggedHours?: number;
}) {
  const [logModal,  setLogModal]  = useState(false);
  const [histModal, setHistModal] = useState(false);

  // Persists the entry to Supabase; only calls onAddEntry (which updates the
  // visible list/total/remaining/progress bar) once the write actually
  // succeeds — never from local state alone.
  async function handleLogTime(input: LogTimeInput): Promise<boolean> {
    try {
      const result = await logTicketTime(ticketId, input);
      if (result.status === "error") {
        console.warn("[ticket-detail] failed to log time:", result.message);
        onError(result.message);
        return false;
      }
      onAddEntry(toTimeEntry(result.entry));
      return true;
    } catch (err) {
      console.warn("[ticket-detail] failed to log time:", err);
      onError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      return false;
    }
  }

  const totalLogged = isParent ? (aggregatedLoggedHours ?? 0) : entries.reduce((s, e) => s + e.hours, 0);
  const pct         = estimatedHours ? Math.min(100, Math.round((totalLogged / estimatedHours) * 100)) : 0;
  const variance    = estimatedHours !== undefined ? totalLogged - estimatedHours : null;
  const isOver      = variance !== null && variance > 0;
  // When over: brand fills the estimated portion, amber fills the rest
  const brandPct    = isOver && estimatedHours
    ? Math.round((estimatedHours / totalLogged) * 100)
    : pct;

  return (
    <>
      <CollapsibleSection
        title="Time Tracking"
        defaultOpen={true}
        headerAction={
          isParent ? undefined : (
            <button
              type="button"
              onClick={() => setLogModal(true)}
              className="flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-md bg-brand-500 text-white hover:bg-brand-600 transition-colors shadow-sm shadow-brand-500/30 dark:bg-brand-accent dark:hover:bg-brand-accent-strong dark:shadow-brand-accent/30 dark:text-brand-accent-foreground"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" d="M12 4v16m8-8H4" />
              </svg>
              Log Time
            </button>
          )
        }
      >
        {/* Single summary line: "11h logged / 8h estimated" */}
        <p className="text-[13px] mb-1.5">
          <span className="font-semibold text-slate-700 dark:text-zinc-200 tabular-nums">{formatHours(totalLogged)}</span>
          <span className="text-slate-400 dark:text-zinc-600"> logged</span>
          {estimatedHours !== undefined && (
            <>
              <span className="text-slate-300 dark:text-zinc-700 mx-1.5">/</span>
              <span className="font-semibold text-slate-500 dark:text-zinc-400 tabular-nums">{formatHours(estimatedHours)}</span>
              <span className="text-slate-400 dark:text-zinc-600"> estimated</span>
            </>
          )}
        </p>

        {/* Over-estimate label — only shown when over */}
        {isOver && variance !== null && (
          <p className="text-[11px] font-medium text-amber-600 dark:text-amber-400 mb-2">
            +{formatHours(variance)} over estimate
          </p>
        )}

        {/* Smart progress bar: brand up to estimate, amber for overage */}
        {estimatedHours !== undefined && (
          <div className="relative h-[4px] rounded-full bg-slate-100 dark:bg-zinc-800 overflow-hidden mb-3">
            {isOver ? (
              <div className="absolute inset-0 flex">
                <div
                  className="h-full bg-brand-500 flex-shrink-0 transition-all duration-300 dark:bg-brand-accent"
                  style={{ width: `${brandPct}%` }}
                />
                <div className="h-full bg-amber-400 flex-1 transition-all duration-300" />
              </div>
            ) : (
              <div
                className="h-full bg-brand-500 rounded-full transition-all duration-300 dark:bg-brand-accent"
                style={{ width: `${pct}%` }}
              />
            )}
          </div>
        )}
        {estimatedHours === undefined && <div className="mb-2" />}

        {/* "View N entries →" link — a parent has none of its own (see
            isParent doc above); its total is a sum across child tickets,
            each viewable from the Children section instead. */}
        {isParent ? (
          <p className="text-[12px] text-slate-400 dark:text-zinc-600">Aggregated from its child tickets.</p>
        ) : entries.length > 0 ? (
          <button
            type="button"
            onClick={() => setHistModal(true)}
            className="text-[12px] font-medium text-brand-600 dark:text-brand-accent hover:text-brand-700 dark:hover:text-brand-accent-soft flex items-center gap-1 transition-colors"
          >
            View {entries.length} {entries.length === 1 ? "entry" : "entries"}
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" d="M9 18l6-6-6-6" />
            </svg>
          </button>
        ) : (
          <p className="text-[12px] text-slate-400 dark:text-zinc-600">No time logged yet.</p>
        )}
      </CollapsibleSection>

      {logModal && (
        <LogTimeModal
          onClose={() => setLogModal(false)}
          onSubmit={handleLogTime}
        />
      )}

      {histModal && (
        <TimeHistoryModal
          entries={entries}
          estimatedHours={estimatedHours}
          projectSlug={projectSlug}
          userId={userId}
          isAdmin={isAdmin}
          onClose={() => setHistModal(false)}
          onUpdateEntry={onUpdateEntry}
          onDeleteEntry={onDeleteEntry}
        />
      )}
    </>
  );
}

// ── Not-found state ───────────────────────────────────────────────────────────

function NotFound({ ticketId, slug }: { ticketId: string; slug: string }) {
  return (
    <div className="min-h-full bg-white dark:bg-zinc-950 flex items-center justify-center">
      <div className="text-center py-24">
        <div className="mx-auto w-10 h-10 rounded-lg bg-slate-100 dark:bg-zinc-800 flex items-center justify-center mb-4">
          <svg
            className="w-5 h-5 text-slate-400 dark:text-zinc-500"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            viewBox="0 0 24 24"
          >
            <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
        </div>
        <h1 className="text-base font-semibold text-slate-900 dark:text-zinc-50">Ticket not found</h1>
        <p className="text-sm text-slate-500 dark:text-zinc-400 mt-1">
          No ticket with ID &ldquo;{ticketId}&rdquo; exists.
        </p>
        <Link
          href={`/projects/${slug}/tickets`}
          className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 dark:text-brand-accent hover:underline"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          Back to Tickets
        </Link>
      </div>
    </div>
  );
}

// Dev-only fallback lookup (no real organization) — the static mock array
// scoped to this project, plus anything just created this session via the
// New Ticket modal's dev-fallback path (see pending-tickets.ts). Never
// reached once a real organization exists.
function resolveDevTicket(slug: string, ticketCode: string): Ticket | undefined {
  return (
    ALL_TICKETS.find((t) => t.projectSlug === slug && getTicketDisplayKey(t) === ticketCode) ??
    getRegisteredTicketByCode(slug, ticketCode)
  );
}

// ── Breadcrumb ────────────────────────────────────────────────────────────────
// Client component, same reasoning as ProjectSettingsBreadcrumb in
// project-settings-screen.tsx: real project/ticket data lives client-side
// (Supabase + the shared Projects context), so a server-rendered breadcrumb
// can't show it — this reads the real project name from the shared
// provider and the real ticket code/title from its own lookup.
export function TicketDetailBreadcrumb({ slug, ticketCode }: { slug: string; ticketCode: string }) {
  const { organization, isDevFallback } = useCurrentUser();
  const { projects } = useOrganizationProjects();
  const projectName = projects.find((p) => p.slug === slug)?.name ?? slug;

  const [loadedTitle, setLoadedTitle] = useState<string | null>(null);

  useEffect(() => {
    if (isDevFallback || !organization) return;
    let cancelled = false;
    loadTicketByCode(organization.id, slug, ticketCode).then((result) => {
      if (cancelled) return;
      setLoadedTitle(result.status === "ready" ? result.ticket.title : null);
    });
    return () => {
      cancelled = true;
    };
    // organization?.id (not the object) — the object gets a new reference on
    // every window-focus regain (current-user-provider.tsx's own session
    // revalidation), which used to re-run this on focus alone. Ticket Detail
    // (this breadcrumb included) only refetches on a real navigation
    // (slug/ticketCode change) or an actual org switch (id change) now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDevFallback, organization?.id, slug, ticketCode]);

  const displayText = (isDevFallback ? resolveDevTicket(slug, ticketCode)?.title : loadedTitle) ?? ticketCode;

  return (
    <>
      <Link href="/projects" className="text-slate-400 hover:text-slate-600 dark:text-zinc-500 dark:hover:text-zinc-300">
        Projects
      </Link>
      <span className="text-slate-300 dark:text-zinc-700">/</span>
      <Link
        href={`/projects/${slug}`}
        className="text-slate-400 hover:text-slate-600 dark:text-zinc-500 dark:hover:text-zinc-300"
      >
        {projectName}
      </Link>
      <span className="text-slate-300 dark:text-zinc-700">/</span>
      <Link
        href={`/projects/${slug}/tickets`}
        className="text-slate-400 hover:text-slate-600 dark:text-zinc-500 dark:hover:text-zinc-300"
      >
        Tickets
      </Link>
      <span className="text-slate-300 dark:text-zinc-700">/</span>
      <span className="text-slate-800 font-medium dark:text-zinc-200 truncate">{displayText}</span>
    </>
  );
}

// ── Loading skeleton ─────────────────────────────────────────────────────────
// Shown for the initial load and for the automatic refresh already
// triggered on focus/tab-visibility regain (runFetchTicket's own
// setLoadState("loading"), unchanged — this only replaces what was
// rendered for that state, a plain "Loading ticket…" text, with a real,
// full-fidelity skeleton). Mirrors the actual layout below exactly
// (max-w-5xl/px-6 sm:px-10 py-10 outer shell, the article/aside flex-gap-12
// two-column split, CollapsibleSection's own mt-10 pt-8 border-t rhythm,
// and SidebarField's own py-3.5 border-b rows) so nothing shifts once the
// real content mounts. Development gets only a light, generic placeholder
// here — DevelopmentSection itself is never mounted while this is showing,
// so it can't run its own GitHub check during a plain ticket-detail load.

function TicketDetailSkeletonSection({ titleWidth, children }: { titleWidth: string; children: ReactNode }) {
  return (
    <div className="mt-10 pt-8 border-t border-slate-100 dark:border-zinc-800">
      <SkeletonBlock className={`h-3 ${titleWidth} rounded mb-4`} />
      <div className="space-y-2">{children}</div>
    </div>
  );
}

const SIDEBAR_SKELETON_FIELDS = ["Status", "Assignee", "Type", "Priority", "Estimated", "Due Date", "Labels", "Sprint", "Related Tickets"];

function TicketDetailSkeleton() {
  return (
    <div className="min-h-full bg-white dark:bg-zinc-950" aria-busy="true">
      <div className="max-w-5xl mx-auto px-4 sm:px-10 py-6 sm:py-10">
        <div className="mb-8">
          {/* Real, already-functional navigation — never blocked while the
              ticket itself is loading. */}
          <BackToTicketsButton />
        </div>

        <div className="flex flex-col sm:flex-row gap-6 sm:gap-12 sm:items-start">
          {/* ── Main content ─────────────────────────────────────────────── */}
          <article className="flex-1 min-w-0">
            {/* Header: ticket code + status, title, updated/due date, Estimated/Logged/Remaining */}
            <header>
              <div className="flex items-center gap-2.5 mb-3">
                <SkeletonBlock className="h-4 w-16 rounded" />
                <SkeletonBlock className="h-5 w-20 rounded-md" />
              </div>
              <SkeletonBlock className="h-7 w-3/4 rounded" />
              <SkeletonBlock className="h-3 w-40 rounded mt-3" />
              <div className="mt-3 flex items-center gap-3.5 flex-wrap">
                <SkeletonBlock className="h-3 w-24 rounded" />
                <SkeletonBlock className="h-3 w-24 rounded" />
                <SkeletonBlock className="h-3 w-24 rounded" />
              </div>
            </header>

            {/* Description */}
            <TicketDetailSkeletonSection titleWidth="w-24">
              <SkeletonBlock className="h-3.5 w-full rounded" />
              <SkeletonBlock className="h-3.5 w-5/6 rounded" />
              <SkeletonBlock className="h-3.5 w-2/3 rounded" />
            </TicketDetailSkeletonSection>

            {/* Attachments */}
            <TicketDetailSkeletonSection titleWidth="w-28">
              <SkeletonBlock className="h-9 w-full rounded-lg" />
            </TicketDetailSkeletonSection>

            {/* Development — a light generic placeholder only; the real
                DevelopmentSection (and its own GitHub check) never mounts
                during this whole-ticket skeleton. */}
            <TicketDetailSkeletonSection titleWidth="w-28">
              <SkeletonBlock className="h-9 w-full rounded-lg" />
              <SkeletonBlock className="h-9 w-full rounded-lg" />
            </TicketDetailSkeletonSection>

            {/* Time Tracking */}
            <TicketDetailSkeletonSection titleWidth="w-32">
              <SkeletonBlock className="h-9 w-full rounded-lg" />
            </TicketDetailSkeletonSection>

            {/* Comments */}
            <TicketDetailSkeletonSection titleWidth="w-24">
              <div className="flex items-start gap-3">
                <SkeletonBlock className="w-7 h-7 rounded-full flex-shrink-0" />
                <div className="flex-1 space-y-2">
                  <SkeletonBlock className="h-3 w-32 rounded" />
                  <SkeletonBlock className="h-12 w-full rounded-xl" />
                </div>
              </div>
            </TicketDetailSkeletonSection>

            {/* Activity — a compact, representative number of rows, never a
                long simulated list. */}
            <TicketDetailSkeletonSection titleWidth="w-20">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex gap-3.5">
                  <SkeletonBlock className="w-2 h-2 rounded-full mt-1.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0 pb-2 space-y-1.5">
                    <SkeletonBlock className="h-3 w-3/4 rounded" />
                    <SkeletonBlock className="h-2.5 w-20 rounded" />
                  </div>
                </div>
              ))}
            </TicketDetailSkeletonSection>
          </article>

          {/* ── Metadata sidebar ─────────────────────────────────────────── */}
          <aside className="w-56 flex-shrink-0 sticky top-8">
            {SIDEBAR_SKELETON_FIELDS.map((label, i) => (
              <div
                key={label}
                className={`py-3.5 border-b border-slate-100 dark:border-zinc-800/70 ${
                  i === SIDEBAR_SKELETON_FIELDS.length - 1 ? "last:border-0" : ""
                }`}
              >
                <SkeletonBlock className="h-2.5 w-16 rounded mb-1.5" />
                <SkeletonBlock className="h-4 w-24 rounded" />
              </div>
            ))}
          </aside>
        </div>
      </div>
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export function TicketDetailScreen({
  slug,
  ticketCode,
}: {
  slug: string;
  ticketCode: string;
}) {
  const { organization, isDevFallback, userId, user } = useCurrentUser();
  const router = useRouter();
  // JIR-116 — "Move to project": Admin/Project Lead only (the database
  // function re-checks role and lead scope; this only hides the entry point).
  const canMoveTicket = !isDevFallback && Boolean(organization) && Boolean(userId) && (user.role === "ADMIN" || user.role === "PROJECT_LEAD");
  const [showMoveModal, setShowMoveModal] = useState(false);
  // Ticket actions ⋯ menu — same three-dot trigger/panel styling as the
  // attachment rows' own "More options" menu in this file.
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!actionsMenuOpen) return;
    function onMouseDown(e: MouseEvent) {
      if (actionsMenuRef.current && !actionsMenuRef.current.contains(e.target as Node)) setActionsMenuOpen(false);
    }
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") setActionsMenuOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [actionsMenuOpen]);
  // Admin may edit/delete any time entry, not just their own — Project
  // Lead and Member stay restricted to their own (ticket_time_entries_update/
  // _delete RLS, 20260914000000, enforces the same rule again at the
  // database level regardless of what this drives in the UI).
  const isAdmin = user.role === "ADMIN";

  // Feeds the page-level drag & drop / paste handlers below — lets them
  // reuse this exact section's own real upload/validation flow instead of
  // a second implementation. Only ever populated once the section mounts.
  const attachmentsSectionRef = useRef<AttachmentsSectionHandle | null>(null);

  const [loadState, setLoadState] = useState<"loading" | "ready" | "not-found" | "error">(
    isDevFallback ? (resolveDevTicket(slug, ticketCode) ? "ready" : "not-found") : "loading"
  );
  const [loadErrorMessage, setLoadErrorMessage] = useState<string | null>(null);
  const [ticket, setTicket] = useState<Ticket | undefined>(() =>
    isDevFallback ? resolveDevTicket(slug, ticketCode) : undefined
  );
  // This project's real, ordered ticket_statuses (Fase 2) — the Status
  // selector's own options (near the title and in the sidebar), instead of
  // the old fixed 6-value enum. Dev fallback keeps EditableStatusBadge's
  // own FALLBACK_TICKET_STATUSES default.
  const [statuses, setStatuses] = useState<TicketStatusOption[]>([]);
  // Sprint MVP — this project's real sprints (every status), bundled into
  // the same loadTicketByCode result as `ticket`/`statuses` above rather
  // than a separate fetch, so the Sprint field's own currentSprint lookup
  // can never briefly resolve wrong while sprints are still loading. Dev
  // fallback stays empty (no real sprints table to query) — same "Backlog"
  // display as a real ticket genuinely outside any sprint.
  const [sprints, setSprints] = useState<Sprint[]>([]);
  // Real Comments/Activity — start empty and stay empty unless real rows
  // exist, in every mode (including dev fallback — no mock people, ever).
  const [comments, setComments] = useState<TicketComment[]>([]);
  const [activityLog, setActivityLog] = useState<TicketActivityEvent[]>([]);
  // The viewer's own manual subscription state (Ticket Detail's
  // subscribe/unsubscribe icon) — null until the real row is loaded
  // (loadTicketSubscriptionState below), so the icon can stay hidden rather
  // than briefly rendering the wrong state.
  const [isSubscribed, setIsSubscribed] = useState<boolean | null>(null);
  // Small "Enlace al ticket copiado" tooltip shown briefly after clicking
  // the ticket key (JIR-50, etc.) — never a toast, just this one flag.
  const [linkCopied, setLinkCopied] = useState(false);
  const linkCopiedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (linkCopiedTimeoutRef.current) clearTimeout(linkCopiedTimeoutRef.current); }, []);
  const [addingComment, setAddingComment] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");
  const [submittingComment, setSubmittingComment] = useState(false);
  // Files picked via the composer's Attach button — local only, no upload
  // starts until the comment itself is created (see submitComment below).
  const [pendingCommentFiles, setPendingCommentFiles] = useState<PendingCommentFile[]>([]);
  const commentFileInputRef = useRef<HTMLInputElement>(null);
  // One-level-deep replies — the id of whichever comment "Reply" was just
  // clicked on (parent or reply alike; see CommentItem's own onReply doc),
  // and that reply's own small composer state. Only one reply composer is
  // ever open at a time across the whole thread.
  const [replyingTo, setReplyingTo] = useState<{ id: string; name: string } | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [submittingReply, setSubmittingReply] = useState(false);
  const [pendingReplyFiles, setPendingReplyFiles] = useState<PendingCommentFile[]>([]);
  const [loggedEntries, setLoggedEntries] = useState<TimeEntry[]>([]);
  // Parent/Children hierarchy (exactly one level) — see lib/tickets.ts's
  // own loadTicketHierarchy doc. hierarchyChildren.length > 0 is this
  // component's one definition of "isParent" (never a stored flag).
  const [hierarchyParent, setHierarchyParent] = useState<TicketParentSummary | null>(null);
  const [hierarchyChildren, setHierarchyChildren] = useState<TicketChildSummary[]>([]);
  const [hierarchyEstimated, setHierarchyEstimated] = useState<number | undefined>(undefined);
  const [hierarchyLogged, setHierarchyLogged] = useState<number>(0);
  // "Close anyway" confirmation (Ticket Detail's own status selector) —
  // set only when a manual close would leave open child tickets behind.
  const [pendingCloseConfirm, setPendingCloseConfirm] = useState<{ option: TicketStatusOption; openCount: number } | null>(null);
  // Children section's "+ Create" — reuses NewTicketModal exactly as
  // tickets-screen.tsx does, just pre-set to this ticket as parent.
  const [creatingChild, setCreatingChild] = useState(false);
  const applyHierarchy = (t: Ticket) => {
    if (isDevFallback) return;
    loadTicketHierarchy(t).then((r) => {
      if (r.status !== "ready") return;
      setHierarchyParent(r.parent);
      setHierarchyChildren(r.children);
      setHierarchyEstimated(r.estimatedHours);
      setHierarchyLogged(r.loggedHours);
    });
  };
  // Typed ProjectTeamMember[] (not the narrower OrgMember[] other
  // consumers of this same roster declare) purely to keep `email` around —
  // needed for the @mention picker's real name/email search below; every
  // existing read of `members` only ever touched id/name/avatar anyway, so
  // this widening changes nothing else.
  const [members, setMembers] = useState<ProjectTeamMember[]>([]);
  // @mention candidates for both the new-comment composer and each
  // CommentItem's own edit mode — real, active members of this exact
  // project only (the same roster Assignee/Team already use), never the
  // wider organization. Rebuilt only when `members` itself actually changes.
  const mentionCandidates: MentionCandidate[] = useMemo(
    () => members.map((m) => ({ id: m.id, name: m.name, email: m.email, avatar: m.avatar })),
    [members]
  );
  // Real, per-organization label catalog — starts empty; merged with the
  // static ALL_LABELS seed list below. Dev fallback: no real catalog to
  // load, so only the static seed list is offered (no persistence anyway).
  const [orgLabels, setOrgLabels] = useState<string[]>([]);
  // Single shared surface for every write failure below (inline edits,
  // comments, time entries, attachments, related tickets) — previously most
  // of these only logged to the console with nothing shown to the user.
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const showError = (message: string) => setErrorMessage(message);

  // Feedback for the one paste-to-attach case that has none today: pasting
  // an image while Attachments is scrolled out of view leaves the user with
  // no sign anything happened until they scroll down to check. Deliberately
  // its own state (not reusing errorMessage) since this one needs an
  // "uploading" state that then flips *in place* to success — see the
  // page-level paste effect below, the only place this is ever set to
  // "uploading". The file input button and drag & drop already have their
  // own always-visible inline progress row in Attachments itself, so they
  // never touch this.
  const [pasteImageToast, setPasteImageToast] = useState<
    { status: "uploading" } | { status: "success"; filename?: string } | null
  >(null);

  // Extracted (not just inlined in the effect below) so the load-error state
  // can offer a real Retry, the same way tickets-screen.tsx's ticket *list*
  // already does — this was previously the one load path in the module with
  // no way to recover without a full page reload.
  const detailRequestIdRef = useRef(0);
  const runFetchTicket = () => {
    if (!organization) return;
    const requestId = ++detailRequestIdRef.current;
    setLoadState("loading");
    loadTicketByCode(organization.id, slug, ticketCode).then((result) => {
      if (detailRequestIdRef.current !== requestId) return;
      if (result.status === "ready") {
        setTicket(result.ticket);
        setStatuses(result.statuses);
        setSprints(result.sprints);
        setLoadState("ready");
        loadTicketComments(result.ticket.id).then((r) => {
          if (detailRequestIdRef.current === requestId) setComments(r.status === "ready" ? r.comments : []);
        });
        loadTicketActivity(result.ticket.id).then((r) => {
          if (detailRequestIdRef.current === requestId) setActivityLog(r.status === "ready" ? r.events : []);
        });
        loadTicketTimeEntries(result.ticket.id).then((r) => {
          if (detailRequestIdRef.current === requestId) setLoggedEntries(r.status === "ready" ? r.entries.map(toTimeEntry) : []);
        });
        loadTicketSubscriptionState(result.ticket.id).then((r) => {
          if (detailRequestIdRef.current === requestId) setIsSubscribed(r.status === "ready" ? r.subscribed : false);
        });
        applyHierarchy(result.ticket);
      } else if (result.status === "not-found") {
        // JIR-116 — an old URL of a ticket that was moved resolves to its
        // current location (only if this user can view it there); stay on
        // the loading state while redirecting, so "not found" never flashes.
        resolveTicketRouteAlias(organization.id, slug, ticketCode).then((current) => {
          if (detailRequestIdRef.current !== requestId) return;
          const target = ticketRouteRedirectTarget(current, slug, ticketCode);
          if (target) {
            router.replace(target);
            return;
          }
          setLoadState("not-found");
        });
      } else {
        setLoadErrorMessage(result.message);
        setLoadState("error");
      }
    });
  };

  useEffect(() => {
    if (isDevFallback) return; // handled synchronously above
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: runFetchTicket also runs from the Retry button, and must show "Loading…" immediately either way
    runFetchTicket();
    // organization?.id (not the object) — the object gets a new reference on
    // every window-focus regain (current-user-provider.tsx's own session
    // revalidation). Ticket Detail must not refetch (or re-show the
    // skeleton) just from switching tabs and back — only a real navigation
    // (slug/ticketCode change) or an actual org switch (id change) should.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDevFallback, organization?.id, slug, ticketCode]);

  useEffect(() => {
    if (isDevFallback || !organization) return; // dev fallback: no mock members either
    // Project-scoped roster (not loadOrganizationMembers) — only an active
    // member of this ticket's own project can be assigned to it.
    loadProjectTeam(organization.id, slug).then((result) => {
      if (result.status === "ready") setMembers(result.members);
    });
    // organization?.id, not the object — see the main ticket-load effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDevFallback, organization?.id, slug]);

  useEffect(() => {
    if (isDevFallback || !organization) return;
    loadOrganizationLabels(organization.id).then((result) => {
      if (result.status === "ready") setOrgLabels(result.labels.map((l) => l.name));
    });
    // organization?.id, not the object — see the main ticket-load effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDevFallback, organization?.id]);


  // ── Page-level drag & drop ──────────────────────────────────────────────
  // Files dropped directly on one of the viewer's own comments never reach
  // here — CommentDropZone's own onDrop handles those and stops propagation
  // before the event bubbles up to these document-level listeners, so
  // everything else (including someone else's comment) falls through to
  // the general ticket Attachments section, exactly as "Upload Files"
  // already would. Registered from mount (attachmentsSectionRef is simply
  // still null, a safe no-op, until the ticket loads and that section
  // mounts) and cleaned up on unmount.
  useEffect(() => {
    function isFileDrag(e: DragEvent): boolean {
      return Array.from(e.dataTransfer?.types ?? []).includes("Files");
    }
    function onDragOver(e: DragEvent) {
      if (!isFileDrag(e)) return;
      // Required on dragover (not just drop) to stop the browser's own
      // default of opening/navigating to the dropped file.
      e.preventDefault();
    }
    function onDrop(e: DragEvent) {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      if (e.dataTransfer?.files?.length) {
        attachmentsSectionRef.current?.addFiles(e.dataTransfer.files);
      }
    }
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDrop);
    };
  }, []);

  // ── Page-level paste ─────────────────────────────────────────────────────
  // The fallback destination only: a file pasted anywhere that is NOT a
  // comment composer becomes a general ticket attachment, through the same
  // real flow "Upload Files" uses. A paste inside a comment composer (new
  // comment, reply, or an edit session) was already claimed by that
  // composer's own CommentPasteScope in the capture phase and is skipped
  // here, so a pasted image belongs to its comment and never also lands
  // in Attachments (JIR-41). Never calls preventDefault(): a clipboard
  // with both text and files must still paste its text normally.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      if (isPasteClaimed(e)) return;
      const files = extractPastedFiles(e);
      if (files.length === 0) return;

      // The target section can be scrolled out of view, hence the toast.
      // Only pasted images trigger it (per spec); the underlying upload
      // itself is untouched either way — every pasted file, image or not,
      // still goes through addFiles exactly as before.
      const hasImage = files.some((f) => f.type.startsWith("image/"));
      if (hasImage) {
        setPasteImageToast({ status: "uploading" });
        attachmentsSectionRef.current?.addFiles(files, (results) => {
          const failed = results.some((r) => !r.ok);
          if (failed) {
            setPasteImageToast(null);
            showError("Could not attach image");
            return;
          }
          const imageResults = results.filter((r) => r.file.type.startsWith("image/"));
          const filename = imageResults.length === 1 ? imageResults[0].filename : undefined;
          setPasteImageToast({ status: "success", filename });
        });
      } else {
        attachmentsSectionRef.current?.addFiles(files);
      }
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  if (loadState === "loading") {
    return <TicketDetailSkeleton />;
  }

  if (loadState === "error") {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-4">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-zinc-200">Couldn&apos;t load ticket</h3>
        <p className="text-sm text-slate-400 mt-1 max-w-xs dark:text-zinc-500">
          {loadErrorMessage ?? "Something went wrong."}
        </p>
        <button
          type="button"
          onClick={runFetchTicket}
          className="mt-5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg px-3.5 py-2 shadow-sm shadow-brand-600/20 transition-colors dark:bg-brand-accent dark:text-brand-accent-foreground dark:hover:bg-brand-accent-strong dark:focus-visible:outline-2 dark:focus-visible:outline-offset-2 dark:focus-visible:outline-brand-accent dark:shadow-brand-accent/20"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!ticket) {
    return <NotFound ticketId={ticketCode} slug={slug} />;
  }

  const update = <K extends keyof Ticket>(key: K, value: Ticket[K]) => {
    setTicket((prev) => prev ? { ...prev, [key]: value } : prev);
  };

  const ticketId = ticket.id;
  // A ticket is a parent purely because at least one other ticket's own
  // parentTicketId points at it — never a stored flag (see lib/tickets.ts's
  // loadTicketHierarchy doc). Governs the Estimated/Log Time overrides
  // below and the progress bar in the Children section.
  const isParent = hierarchyChildren.length > 0;
  const effectiveEstimatedHours = isParent ? hierarchyEstimated : ticket.hours;
  const effectiveLoggedHours = isParent ? hierarchyLogged : loggedEntries.reduce((s, e) => s + e.hours, 0);
  const effectiveRemainingHours =
    effectiveEstimatedHours !== undefined ? Math.max(0, effectiveEstimatedHours - effectiveLoggedHours) : undefined;

  // Refetches real Activity from Supabase — every field edit, acceptance
  // criteria toggle, attachment upload, and time entry is now logged by a
  // database trigger as part of its own real write (see
  // 20260727000000/20260728000000), so this never invents a local entry;
  // it only ever reflects what's already been committed.
  const refreshActivity = () => {
    loadTicketActivity(ticketId).then((r) => {
      if (r.status === "ready") setActivityLog(r.events);
    });
  };

  // Re-fetches PARENT/CHILDREN + their aggregated hours after a link/
  // unlink/create — a database trigger may also have just auto-closed or
  // auto-reopened this exact ticket (e.g. unlinking the last open child),
  // so this always re-reads the ticket's own row too rather than assuming
  // only the hierarchy itself changed.
  const refreshHierarchy = () => {
    if (!organization) return;
    applyHierarchy(ticket);
    loadTicketByCode(organization.id, slug, ticketCode).then((r) => {
      if (r.status === "ready") setTicket(r.ticket);
    });
  };

  // Persists one inline edit to Supabase. Dev fallback (no real organization)
  // keeps today's local-only behavior — there is no real ticket row to write
  // to. Every call site pairs this with an optimistic update(key, value)
  // immediately before calling persist(patch) — `ticket` is closed over at
  // that same synchronous moment, so `previousTicket` below is exactly the
  // pre-optimistic snapshot, regardless of which field changed. On failure
  // that snapshot is restored (so a rejected edit never stays on screen) and
  // the error is shown via the shared toast, not just logged. On success the
  // ticket is synced to the server's own confirmed row rather than trusting
  // the optimistic value stayed in sync.
  // Returns whether the save succeeded so call sites that need to know
  // (e.g. EditableDescription, which keeps its draft on screen until a
  // save is confirmed) can await it; existing fire-and-forget call sites
  // are unaffected since they never read the returned promise.
  const persist = (patch: UpdateTicketInput): Promise<boolean> => {
    if (isDevFallback) return Promise.resolve(true);
    const previousTicket = ticket;
    return updateTicket(ticketId, slug, patch).then((result) => {
      if (result.status === "error") {
        console.warn("[ticket-detail] failed to save change:", result.message);
        setTicket(previousTicket);
        showError(result.message);
        return false;
      }
      // Success path intentionally unchanged from before this fix — only
      // the failure branch above (and the .catch() below) are new.
      refreshActivity();
      return true;
    }).catch((err) => {
      console.warn("[ticket-detail] failed to save change:", err);
      setTicket(previousTicket);
      showError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      return false;
    });
  };

  // A status change now writes `statusId` (Fase 2) — the option's own
  // legacy_enum_value drives the optimistic local `status`/`statusName`/
  // `statusGroupType` update (persist()'s success path never re-syncs
  // `ticket` from the server, see its own comment above, so this optimistic
  // update is what actually keeps state correct).
  const applyStatusChange = (option: TicketStatusOption): Promise<boolean> => {
    const nextStatus = option.legacyEnumValue ? STATUS_FROM_DB[option.legacyEnumValue] ?? ticket.status : ticket.status;
    setTicket((prev) =>
      prev
        ? { ...prev, status: nextStatus, statusId: option.id, statusName: option.name, statusGroupType: option.groupType }
        : prev
    );
    return persist({ statusId: option.id });
  };

  // Same open-children check Kanban drag-and-drop also runs
  // (countOpenChildTickets, lib/tickets.ts) before letting a manual close
  // through — this is the "centralize the evaluation" requirement: one
  // shared query, each surface showing its own matching confirmation UI.
  const updateStatus = (option: TicketStatusOption) => {
    if (isDevFallback || option.groupType !== "closed") {
      applyStatusChange(option);
      return;
    }
    countOpenChildTickets(ticket.id).then((openCount) => {
      if (openCount > 0) {
        setPendingCloseConfirm({ option, openCount });
      } else {
        applyStatusChange(option);
      }
    });
  };

  // Acceptance Criteria checkbox — unlike persist() above, this updates
  // local state only AFTER a successful write, so a failed save never shows
  // a checked box that didn't actually persist. Dev fallback keeps the
  // pre-existing instant-toggle behavior (no real ticket to write to).
  const toggleAcceptanceCriterion = (index: number) => {
    const criteria = ticket.acceptanceCriteria;
    if (!criteria) return;
    const currentDone = ticket.acceptanceCriteriaDone ?? [];
    const nextDone = criteria.map((_, i) => (i === index ? !(currentDone[i] ?? false) : (currentDone[i] ?? false)));

    if (isDevFallback) {
      update("acceptanceCriteriaDone", nextDone);
      return;
    }

    updateTicket(ticketId, slug, { acceptanceCriteriaDone: nextDone }).then((result) => {
      if (result.status === "error") {
        console.warn("[ticket-detail] failed to save change:", result.message);
        showError(result.message);
        return;
      }
      update("acceptanceCriteriaDone", nextDone);
      refreshActivity();
    }).catch((err) => {
      console.warn("[ticket-detail] failed to save change:", err);
      showError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    });
  };

  // Available to any ticket in the workspace, since orgLabels is loaded from
  // the shared `labels` table, not per-ticket.
  const allLabelOptions = buildLabelCatalog(orgLabels);

  const createLabel = async (name: string): Promise<{ status: "success"; name: string } | { status: "error"; message: string }> => {
    if (isDevFallback || !organization) {
      return { status: "error", message: "Not available in this mode." };
    }
    const result = await createOrganizationLabel(organization.id, name);
    if (result.status === "error") return result;
    setOrgLabels((prev) => [...prev, result.label.name]);
    return { status: "success", name: result.label.name };
  };

  // A parent's own Estimated/Logged/Remaining are derived from its
  // children (effectiveEstimatedHours/effectiveLoggedHours/
  // effectiveRemainingHours, computed above) rather than this ticket's own
  // (always-empty, for a parent — see tickets_block_hours_on_parent/
  // ticket_time_entries_block_on_parent, 20260927000000) hours/entries.
  const totalLogged = effectiveLoggedHours;
  const remaining   = effectiveRemainingHours ?? 0;

  const addEntry = (entry: TimeEntry) => {
    setLoggedEntries((prev) => [entry, ...prev]);
    // A database trigger already logged the real "time_logged" activity
    // row as part of the same insert (see 20260728000000) — refetch
    // instead of inventing a local entry.
    refreshActivity();
  };

  // Edits an already-logged entry's own minutes/comment/date — reachable
  // only for the entry's real logger (ticket_time_entries_update RLS,
  // 20260913000000, enforces the same rule again at the database level
  // regardless of what TimeHistoryModal's own isOwn check says).
  async function updateEntry(entryId: string, input: LogTimeInput): Promise<boolean> {
    const result = await updateTicketTimeEntry(entryId, input);
    if (result.status === "error") {
      showError(result.message);
      return false;
    }
    const updated = toTimeEntry(result.entry);
    setLoggedEntries((prev) => prev.map((e) => (e.id === entryId ? updated : e)));
    // A database trigger already logged the real "time_entry_updated"
    // activity row as part of the same update (see 20260913000000) —
    // refetch instead of inventing a local entry.
    refreshActivity();
    return true;
  }

  function deleteEntry(entryId: string) {
    deleteTicketTimeEntry(entryId).then((result) => {
      if (result.status === "error") {
        console.warn("[ticket-detail] time entry delete failed:", result.message);
        showError(result.message);
        return;
      }
      setLoggedEntries((prev) => prev.filter((e) => e.id !== entryId));
      refreshActivity();
    }).catch((err) => {
      console.warn("[ticket-detail] time entry delete failed:", err);
      showError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    });
  }

  const canSubmitComment = hasCommentContent(isRichTextEmpty(commentDraft), pendingCommentFiles.length);

  function cancelComment() {
    setCommentDraft("");
    setAddingComment(false);
    setPendingCommentFiles([]);
  }

  // The one place files actually get attached to an existing comment —
  // reused by submitComment's own post-creation upload below and by
  // dropping files directly onto one of the viewer's own already-posted
  // comments (see CommentDropZone). Each upload targets the same
  // ticket_id/uploaded_by-default path as a direct ticket upload, just with
  // this comment's real id attached (see uploadTicketAttachment's commentId
  // param) — so a comment attachment can never reference a comment_id that
  // doesn't exist. Returns which files failed so each caller can phrase its
  // own error toast for its own context.
  async function uploadFilesToComment(commentId: string, files: File[]): Promise<{ failedNames: string[] }> {
    if (files.length === 0) return { failedNames: [] };
    const uploads = await Promise.all(
      files.map(async (file) => {
        try {
          return { name: file.name, result: await uploadTicketAttachment(ticketId, file, commentId) };
        } catch (err) {
          return {
            name: file.name,
            result: { status: "error" as const, message: err instanceof Error ? err.message : "Something went wrong. Please try again." },
          };
        }
      })
    );

    const failedNames: string[] = [];
    let anySucceeded = false;
    for (const upload of uploads) {
      if (upload.result.status === "error") {
        console.warn("[ticket-detail] comment attachment upload failed:", upload.name, upload.result.message);
        failedNames.push(upload.name);
        continue;
      }
      anySucceeded = true;
      const uploadedAttachment = upload.result.attachment;
      setComments((prev) =>
        prev.map((c) =>
          c.id === commentId ? { ...c, attachments: [...c.attachments, uploadedAttachment] } : c
        )
      );
    }
    // Each successful upload already logged its own real
    // "attachment_uploaded" activity row (same trigger as a direct
    // ticket upload) — refetch once instead of inventing local entries.
    if (anySucceeded) refreshActivity();
    return { failedNames };
  }

  // A file (or several) dropped directly onto one of the viewer's own
  // already-posted comments — see CommentDropZone, only ever rendered for
  // comments where authorProfileId === the signed-in user. Uploads
  // immediately (the comment already exists, unlike the composer's own
  // stage-then-upload-on-submit flow above) via the exact same
  // uploadFilesToComment used there.
  async function handleFilesDroppedOnComment(commentId: string, files: File[]) {
    const { failedNames } = await uploadFilesToComment(commentId, files);
    if (failedNames.length > 0) {
      showError(
        failedNames.length === 1
          ? `"${failedNames[0]}" failed to attach.`
          : `These files failed to attach: ${failedNames.join(", ")}.`
      );
    }
  }

  // Edits an already-posted comment's own text — reachable only for the
  // viewer's own comments (see CommentItem below; ticket_comments_update
  // RLS, 20260907000000, enforces the same rule again at the database
  // level regardless). Merges just the text/wasEdited fields into the
  // existing comment, so its already-loaded real attachments are never
  // touched or refetched by this. Returns success the same way
  // EditableDescription's own onSave contract does, so CommentItem can
  // reuse the identical click-to-edit/Cancel/Save pattern.
  async function saveCommentEdit(commentId: string, html: string, hasAttachments: boolean): Promise<boolean> {
    const result = await updateTicketComment(commentId, html, { hasAttachments });
    if (result.status === "error") {
      showError(result.message);
      return false;
    }
    setComments((prev) =>
      prev.map((c) =>
        c.id === commentId ? { ...c, text: result.comment.text, wasEdited: result.comment.wasEdited } : c
      )
    );
    return true;
  }

  // Applies the attachment side of editing an existing comment — called
  // once from CommentItem's own save(), right after saveCommentEdit above
  // already succeeded. Both removals and new uploads were only ever
  // staged locally until now (see CommentItem's stagedFiles/
  // removedAttachmentIds); this is the one place either actually persists,
  // reusing the exact same deleteTicketAttachment/uploadFilesToComment
  // calls the general Attachments section and the new-comment composer
  // already use — no second deletion/upload implementation. A failed
  // removal is reported the same way a failed upload already is (an error
  // toast, without blocking whatever else in this same save can still
  // succeed) rather than rolling anything back — matches the exact same
  // partial-success tolerance submitComment's own upload step already has.
  async function saveCommentAttachmentEdits(
    commentId: string,
    toRemove: TicketAttachment[],
    newFiles: File[]
  ): Promise<void> {
    let anyRemovalSucceeded = false;
    for (const attachment of toRemove) {
      const result = await deleteTicketAttachment(attachment.id, attachment.storagePath, attachment.thumbnailPath);
      if (result.status === "error") {
        console.warn("[ticket-detail] comment attachment delete failed:", result.message);
        showError(result.message);
        continue;
      }
      anyRemovalSucceeded = true;
      setComments((prev) =>
        prev.map((c) => (c.id === commentId ? { ...c, attachments: c.attachments.filter((a) => a.id !== attachment.id) } : c))
      );
    }
    // A database trigger already logs "attachment_deleted" as part of the
    // same delete (see the general Attachments section's own onDelete) —
    // refetch instead of inventing a local entry.
    if (anyRemovalSucceeded) refreshActivity();

    if (newFiles.length > 0) {
      const { failedNames } = await uploadFilesToComment(commentId, newFiles);
      if (failedNames.length > 0) {
        showError(
          failedNames.length === 1
            ? `Comment updated, but "${failedNames[0]}" failed to attach.`
            : `Comment updated, but these files failed to attach: ${failedNames.join(", ")}.`
        );
      }
    }
  }

  // Removes a just-created comment that ended up with neither text nor a
  // single successfully uploaded attachment (see isEmptyCommentShell) — so
  // a failed image-only post never leaves a blank comment behind. Best
  // effort: if the delete itself fails the (empty) comment simply stays,
  // and its author can still delete it by hand.
  async function discardEmptyComment(commentId: string) {
    const result = await deleteTicketComment(commentId);
    if (result.status === "error") {
      console.warn("[ticket-detail] failed to discard empty comment:", result.message);
      return;
    }
    setComments((prev) => prev.filter((c) => c.id !== commentId));
    refreshActivity();
  }

  // Attachments only ever start uploading after the comment itself exists —
  // never before "Comment" is pressed, and never at all if the comment
  // insert fails (see the early return on result.status === "error" below).
  //
  // The comment may be text, image(s)/file(s), or both (JIR-41). The one
  // inconsistent outcome that ordering allows — a text-less comment whose
  // every attachment then failed to upload — is undone via
  // discardEmptyComment below, handing the files back to the composer.
  async function submitComment() {
    const textEmpty = isRichTextEmpty(commentDraft);
    const filesToUpload = pendingCommentFiles;
    if (!hasCommentContent(textEmpty, filesToUpload.length) || submittingComment) return;
    setSubmittingComment(true);
    try {
      const result = await createTicketComment(
        ticketId,
        textEmpty ? "" : sanitizeRichTextHtml(commentDraft),
        null,
        { hasAttachments: filesToUpload.length > 0 }
      );
      if (result.status === "error") {
        console.warn("[ticket-detail] failed to post comment:", result.message);
        showError(result.message);
        return;
      }
      const newComment = result.comment;
      setComments((prev) => [newComment, ...prev]);
      setCommentDraft("");
      setAddingComment(false);
      // A database trigger already created the matching "<name> added a
      // comment" ticket_activity row as part of the same insert.
      refreshActivity();

      setPendingCommentFiles([]);

      if (filesToUpload.length > 0) {
        const { failedNames } = await uploadFilesToComment(newComment.id, filesToUpload.map((item) => item.file));
        if (isEmptyCommentShell(textEmpty, filesToUpload.length, failedNames.length)) {
          await discardEmptyComment(newComment.id);
          setPendingCommentFiles(filesToUpload);
          setAddingComment(true);
          showError("The attachment couldn't be uploaded, so the comment wasn't posted. Please try again.");
        } else if (failedNames.length > 0) {
          showError(
            failedNames.length === 1
              ? `Comment posted, but "${failedNames[0]}" failed to attach.`
              : `Comment posted, but these files failed to attach: ${failedNames.join(", ")}.`
          );
        }
      }
    } catch (err) {
      console.warn("[ticket-detail] failed to post comment:", err);
      showError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      // In a `finally` (not right after the await) so a thrown/rejected
      // request still always clears the spinner instead of leaving the
      // composer stuck disabled.
      setSubmittingComment(false);
    }
  }

  function startReply(comment: TicketComment) {
    setReplyingTo({ id: comment.id, name: comment.name });
    setReplyDraft("");
    setPendingReplyFiles([]);
  }

  function cancelReply() {
    setReplyingTo(null);
    setReplyDraft("");
    setPendingReplyFiles([]);
  }

  // Same shape as submitComment above, just targeting replyingTo.id as the
  // new comment's parent — a database trigger (20260912000000) auto-files
  // this under the real top-level ancestor if replyingTo.id turns out to
  // itself already be a reply, so this never needs to resolve that itself.
  async function submitReply() {
    const textEmpty = isRichTextEmpty(replyDraft);
    const filesToUpload = pendingReplyFiles;
    const replyTarget = replyingTo;
    if (!replyTarget || !hasCommentContent(textEmpty, filesToUpload.length) || submittingReply) return;
    setSubmittingReply(true);
    try {
      const result = await createTicketComment(
        ticketId,
        textEmpty ? "" : sanitizeRichTextHtml(replyDraft),
        replyTarget.id,
        { hasAttachments: filesToUpload.length > 0 }
      );
      if (result.status === "error") {
        console.warn("[ticket-detail] failed to post reply:", result.message);
        showError(result.message);
        return;
      }
      const newComment = result.comment;
      setComments((prev) => [newComment, ...prev]);
      setReplyDraft("");
      setReplyingTo(null);
      // A database trigger already created the matching "<name> added a
      // comment" ticket_activity row as part of the same insert.
      refreshActivity();

      setPendingReplyFiles([]);

      if (filesToUpload.length > 0) {
        const { failedNames } = await uploadFilesToComment(newComment.id, filesToUpload.map((item) => item.file));
        if (isEmptyCommentShell(textEmpty, filesToUpload.length, failedNames.length)) {
          await discardEmptyComment(newComment.id);
          setReplyingTo(replyTarget);
          setPendingReplyFiles(filesToUpload);
          showError("The attachment couldn't be uploaded, so the reply wasn't posted. Please try again.");
        } else if (failedNames.length > 0) {
          showError(
            failedNames.length === 1
              ? `Reply posted, but "${failedNames[0]}" failed to attach.`
              : `Reply posted, but these files failed to attach: ${failedNames.join(", ")}.`
          );
        }
      }
    } catch (err) {
      console.warn("[ticket-detail] failed to post reply:", err);
      showError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmittingReply(false);
    }
  }

  // Deleting a parent comment also cascade-deletes its own replies at the
  // database level (ticket_comments.parent_comment_id ON DELETE CASCADE,
  // 20260912000000) — mirrored in local state here so the list reflects
  // that immediately, without a full refetch.
  function deleteComment(commentId: string) {
    deleteTicketComment(commentId).then((result) => {
      if (result.status === "error") {
        console.warn("[ticket-detail] comment delete failed:", result.message);
        showError(result.message);
        return;
      }
      setComments((prev) => prev.filter((c) => c.id !== commentId && c.parentCommentId !== commentId));
      if (replyingTo?.id === commentId) setReplyingTo(null);
      refreshActivity();
    }).catch((err) => {
      console.warn("[ticket-detail] comment delete failed:", err);
      showError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    });
  }

  // Copies the current, real ticket URL (window.location.href — whatever
  // route/host this page is actually being viewed at, never a hardcoded
  // domain) to the clipboard, then shows a small "Enlace al ticket
  // copiado" tooltip near the ticket key for a couple seconds. Clipboard
  // access can fail (no permission, insecure context, older browser) —
  // caught and logged only; the page/UI never breaks over it.
  function copyTicketLink() {
    if (!navigator.clipboard) {
      console.warn("[ticket-detail] copy ticket link failed: clipboard API unavailable");
      return;
    }
    navigator.clipboard.writeText(window.location.href).then(() => {
      setLinkCopied(true);
      if (linkCopiedTimeoutRef.current) clearTimeout(linkCopiedTimeoutRef.current);
      linkCopiedTimeoutRef.current = setTimeout(() => setLinkCopied(false), 1800);
    }).catch((err) => {
      console.warn("[ticket-detail] copy ticket link failed:", err);
    });
  }

  // Manual subscribe/unsubscribe toggle — entirely separate from the
  // automatic subscribe rules (create/assign/comment/mention/log-time),
  // which keep firing unchanged. Optimistic: flips isSubscribed immediately
  // for a responsive icon, then rolls back to the pre-toggle value if the
  // write fails. A failed toggle never leaves the icon claiming a state
  // that isn't actually persisted.
  function toggleSubscription() {
    if (!ticket || isSubscribed === null) return;
    const next = !isSubscribed;
    setIsSubscribed(next);
    setTicketSubscription(ticket.id, next).then((result) => {
      if (result.status === "error") {
        console.warn("[ticket-detail] subscription toggle failed:", result.message);
        showError(result.message);
        setIsSubscribed(!next);
      }
    }).catch((err) => {
      console.warn("[ticket-detail] subscription toggle failed:", err);
      showError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      setIsSubscribed(!next);
    });
  }

  // Like/Dislike a comment (parent or reply alike) — pressing the already-
  // active reaction removes it, pressing the other one switches it.
  // currentReaction comes from this exact comment's own already-loaded
  // state, so setCommentReaction never needs an extra read to decide
  // delete-vs-upsert.
  function reactToComment(commentId: string, reaction: CommentReactionType) {
    const target = comments.find((c) => c.id === commentId);
    if (!target) return;
    setCommentReaction(commentId, reaction, target.reactions.myReaction).then((result) => {
      if (result.status === "error") {
        console.warn("[ticket-detail] comment reaction failed:", result.message);
        showError(result.message);
        return;
      }
      setComments((prev) => prev.map((c) => (c.id === commentId ? { ...c, reactions: result.reactions } : c)));
    }).catch((err) => {
      console.warn("[ticket-detail] comment reaction failed:", err);
      showError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    });
  }

  // Shared between the top-level comments loop and each parent's own
  // indented replies loop below — a single CommentItem call site either
  // way, since a reply only ever differs from a parent in where it's
  // rendered (indented, under its parent), never in what it can do.
  function renderComment(c: TicketComment) {
    return (
      <CommentItem
        key={c.id}
        comment={c}
        projectSlug={ticket?.projectSlug}
        // Only the viewer's own comments are editable or become
        // drop targets — dropping on/editing anyone else's
        // falls through to the page-level handler (general
        // ticket attachment) or simply isn't offered.
        isOwn={userId !== null && c.authorProfileId === userId}
        mentionCandidates={mentionCandidates}
        onFilesDropped={(files) => handleFilesDroppedOnComment(c.id, files)}
        onSaveEdit={(html, hasAttachments) => saveCommentEdit(c.id, html, hasAttachments)}
        onSaveAttachmentEdits={(toRemove, newFiles) => saveCommentAttachmentEdits(c.id, toRemove, newFiles)}
        onReply={() => startReply(c)}
        onDelete={() => deleteComment(c.id)}
        onReact={(reaction) => reactToComment(c.id, reaction)}
        replySlot={
          replyingTo?.id === c.id ? (
            <ReplyComposer
              authorName={replyingTo.name}
              draft={replyDraft}
              onChange={setReplyDraft}
              onCancel={cancelReply}
              onSubmit={submitReply}
              submitting={submittingReply}
              mentionCandidates={mentionCandidates}
              pendingFiles={pendingReplyFiles}
              onFilesSelected={(files) => {
                const items = files.map((file) => ({ id: newId(), file }));
                setPendingReplyFiles((prev) => [...prev, ...items]);
              }}
              onRemoveFile={(id) => setPendingReplyFiles((prev) => prev.filter((p) => p.id !== id))}
            />
          ) : null
        }
      />
    );
  }

  return (
    <div className="min-h-full bg-white dark:bg-zinc-950">
      <div className="max-w-5xl mx-auto px-4 sm:px-10 py-6 sm:py-10">
        <div className="mb-8 flex items-center justify-between gap-4">
          <BackToTicketsButton />
          {canMoveTicket && (
            <div ref={actionsMenuRef} className="relative">
              <button
                type="button"
                aria-label="Ticket actions"
                aria-haspopup="menu"
                aria-expanded={actionsMenuOpen}
                onClick={() => setActionsMenuOpen((v) => !v)}
                className="p-1.5 rounded-md text-slate-400 dark:text-zinc-500 hover:text-slate-600 dark:hover:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true">
                  <circle cx="3"  cy="8" r="1.25" />
                  <circle cx="8"  cy="8" r="1.25" />
                  <circle cx="13" cy="8" r="1.25" />
                </svg>
              </button>
              {actionsMenuOpen && (
                <div
                  role="menu"
                  className="absolute right-0 top-full mt-1 w-44 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-lg shadow-slate-200/50 dark:shadow-black/40 z-20 py-1"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => { setActionsMenuOpen(false); setShowMoveModal(true); }}
                    className="w-full text-left px-3 py-1.5 text-[12px] text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800 flex items-center gap-2.5 transition-colors"
                  >
                    <svg className="w-3 h-3 text-slate-400 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 7h13m0 0l-4-4m4 4l-4 4M21 17H8m0 0l4-4m-4 4l4 4" />
                    </svg>
                    Move to project
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {showMoveModal && canMoveTicket && (
          <MoveTicketModal
            organizationId={organization!.id}
            sourceSlug={slug}
            ticketId={ticket.id}
            ticketKey={getTicketDisplayKey(ticket)}
            viewer={{ role: user.role, profileId: userId! }}
            blockedReason={
              hierarchyParent || hierarchyChildren.length > 0
                ? "This ticket has a parent or child tickets. Tickets in a hierarchy can't be moved between projects yet."
                : null
            }
            onCancel={() => setShowMoveModal(false)}
            onMoved={(projectSlug, ticketCode) => {
              setShowMoveModal(false);
              router.replace(`/projects/${projectSlug}/tickets/${ticketCode}`);
            }}
          />
        )}

        <div className="flex flex-col sm:flex-row gap-6 sm:gap-12 sm:items-start">

          {/* ── Main content ─────────────────────────────────────────────────── */}
          {/* `contents` on Mobile flattens this into direct children of the
              row above so each section can be individually repositioned via
              `order-*` to match the required Mobile sequence; reverts to the
              exact original single flex-item box at `sm:`, unaffected. */}
          <article className="contents sm:block sm:flex-1 sm:min-w-0">

            {/* Title */}
            <header className="order-[10]">
              {/* Parent reference — deliberately placed above the ticket's
                  own key/status/title, not in the sidebar next to Related
                  Tickets: a child ticket belonging to another ticket is
                  structural context that should read before anything else
                  on the page, not a same-weight relation among others. */}
              {hierarchyParent && (() => {
                const parentCode = getTicketDisplayKey({ projectSlug: slug, ticketNumber: hierarchyParent.ticketNumber } as Ticket);
                return (
                  <Link
                    href={`/projects/${slug}/tickets/${parentCode}`}
                    className="group inline-flex items-center gap-1 mb-2 text-[10px] font-bold uppercase tracking-widest text-brand-600 dark:text-brand-accent hover:text-brand-700 dark:hover:text-brand-accent-soft transition-colors"
                  >
                    <CornerUpLeft className="w-3 h-3" aria-hidden="true" />
                    Parent
                    <span aria-hidden="true">·</span>
                    <span className="font-mono">{parentCode}</span>
                  </Link>
                );
              })()}

              <div className="flex items-center gap-2.5 mb-3">
                <span className="relative inline-flex">
                  <button
                    type="button"
                    onClick={copyTicketLink}
                    aria-label="Copy link to this ticket"
                    title="Copy link to this ticket"
                    className="flex items-center gap-1.5 font-mono text-[12px] font-semibold tracking-wider text-slate-400 dark:text-zinc-500 cursor-pointer rounded hover:text-slate-600 dark:hover:text-zinc-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 dark:focus-visible:ring-brand-accent/50"
                  >
                    <TicketTypeIcon type={ticket.type} className="w-3.5 h-3.5" />
                    {getTicketDisplayKey(ticket)}
                  </button>
                  {linkCopied && (
                    <span className="absolute left-0 top-full mt-1 whitespace-nowrap bg-slate-900 dark:bg-zinc-800 text-white text-[11px] font-medium px-2 py-1 rounded shadow-md z-10">
                      Enlace al ticket copiado
                    </span>
                  )}
                </span>
                <EditableStatusBadge
                  value={ticket.status}
                  statusId={ticket.statusId}
                  label={ticket.statusName}
                  statuses={statuses}
                  onChange={updateStatus}
                />
              </div>

              <EditableTitle
                value={ticket.title}
                onChange={(v) => { update("title", v); persist({ title: v }); }}
              />

              <p className="text-[12px] text-slate-400 dark:text-zinc-600 mt-2.5 flex items-center gap-1.5 flex-wrap">
                <span>{ticket.updatedAt}</span>
                {ticket.dueDate && (
                  <>
                    <span>·</span>
                    <span className="inline-flex items-center gap-1">
                      <CalendarIcon />
                      Due {ticket.dueDate}
                    </span>
                  </>
                )}
              </p>
              {effectiveEstimatedHours !== undefined && (
                <div className="hidden sm:flex mt-2 items-center gap-3.5 flex-wrap">
                  <span className="text-[12px] text-slate-400 dark:text-zinc-600">
                    Estimated{" "}
                    <span className="font-semibold text-slate-600 dark:text-zinc-300">{formatHours(effectiveEstimatedHours)}</span>
                  </span>
                  <span className="text-slate-200 dark:text-zinc-800 select-none" aria-hidden="true">·</span>
                  <span className="text-[12px] text-slate-400 dark:text-zinc-600">
                    Logged{" "}
                    <span className="font-semibold text-slate-600 dark:text-zinc-300">{formatHours(totalLogged)}</span>
                  </span>
                  <span className="text-slate-200 dark:text-zinc-800 select-none" aria-hidden="true">·</span>
                  <span className="text-[12px] text-slate-400 dark:text-zinc-600">
                    Remaining{" "}
                    <span className={`font-semibold ${remaining <= 0 && effectiveEstimatedHours !== undefined ? "text-amber-600 dark:text-amber-400" : "text-slate-600 dark:text-zinc-300"}`}>
                      {formatRemainingHours(remaining)}h
                    </span>
                  </span>
                </div>
              )}
            </header>

            {/* Quick summary — Mobile only (Due date/Estimated/Logged/Remaining
                as a compact 2-column grid); Desktop keeps showing these same
                real values inline in the header line above, unchanged. */}
            {effectiveEstimatedHours !== undefined && (
              <div className="order-[20] sm:hidden mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 rounded-xl border border-slate-200 dark:border-zinc-700/70 bg-white dark:bg-zinc-900 shadow-sm shadow-slate-200/40 dark:shadow-black/20 px-3.5 py-3">
                {ticket.dueDate && (
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600 mb-0.5">Due Date</p>
                    <p className="text-[13px] font-semibold text-slate-700 dark:text-zinc-200">{ticket.dueDate}</p>
                  </div>
                )}
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600 mb-0.5">Estimated</p>
                  <p className="text-[13px] font-semibold text-slate-600 dark:text-zinc-300">{formatHours(effectiveEstimatedHours ?? 0)}</p>
                </div>
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600 mb-0.5">Logged</p>
                  <p className="text-[13px] font-semibold text-slate-600 dark:text-zinc-300">{formatHours(totalLogged)}</p>
                </div>
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600 mb-0.5">Remaining</p>
                  <p className={`text-[13px] font-semibold ${remaining <= 0 ? "text-amber-600 dark:text-amber-400" : "text-slate-600 dark:text-zinc-300"}`}>
                    {formatRemainingHours(remaining)}h
                  </p>
                </div>
              </div>
            )}

            <div className="order-[40]">
            <CollapsibleSection title="Description" defaultOpen={true}>
              <EditableDescription
                value={ticket.description}
                onSave={async (v) => {
                  const ok = await persist({ description: v });
                  if (ok) update("description", v);
                  return ok;
                }}
              />
            </CollapsibleSection>
            </div>

            {/* Attachments — directly below Description (JIR-83), so
                attaching a file doesn't require scrolling past Acceptance
                Criteria/Children. */}
            <div className="order-[42]">
              <AttachmentsSection ref={attachmentsSectionRef} ticketId={ticket.id} projectSlug={ticket.projectSlug} isDevFallback={isDevFallback} onUploaded={refreshActivity} onError={showError} />
            </div>

            <div className="order-[45]">
              <EditableAcceptanceCriteria
                criteria={ticket.acceptanceCriteria ?? []}
                doneFlags={ticket.acceptanceCriteriaDone ?? []}
                onToggle={toggleAcceptanceCriterion}
                onSave={async (nextCriteria, nextDoneFlags) => {
                  const ok = await persist({ acceptanceCriteria: nextCriteria, acceptanceCriteriaDone: nextDoneFlags });
                  if (ok) {
                    update("acceptanceCriteria", nextCriteria.length > 0 ? nextCriteria : undefined);
                    update("acceptanceCriteriaDone", nextDoneFlags);
                  }
                  return ok;
                }}
              />
            </div>

            {/* Children — a ticket that is itself a child can never have
                children of its own (one level only), so this never renders
                for one; its own Parent reference lives in the header
                instead (above). Structural, main-column placement — same
                weight as Description/Acceptance Criteria/Attachments, never
                mixed with the sidebar's Related Tickets. */}
            {!hierarchyParent && (
              <div className="order-[47]">
                <ChildrenSection
                  ticket={ticket}
                  slug={slug}
                  childTickets={hierarchyChildren}
                  onChanged={refreshHierarchy}
                  onCreateChild={() => setCreatingChild(true)}
                  onError={showError}
                />
              </div>
            )}

            <div className="order-[55]">
              <CommentAttachmentsOverview comments={comments} projectSlug={ticket.projectSlug} />
            </div>

            <div className="order-[70]">
              <DevelopmentSection slug={slug} ticketCode={ticketCode} />
            </div>

            <div className="order-[80]">
              <TimeTrackingSection
                ticketId={ticket.id}
                projectSlug={ticket.projectSlug}
                entries={loggedEntries}
                estimatedHours={effectiveEstimatedHours}
                userId={userId}
                isAdmin={isAdmin}
                onAddEntry={addEntry}
                onUpdateEntry={updateEntry}
                onDeleteEntry={deleteEntry}
                onError={showError}
                isParent={isParent}
                aggregatedLoggedHours={hierarchyLogged}
              />
            </div>

            <div className="order-[90]">
            <CollapsibleSection
              title="Comments"
              badge={ticket.commentCount !== undefined ? `· ${ticket.commentCount} total` : undefined}
              defaultOpen={true}
            >
              {/* Add comment — above the list, right under the section header */}
              <div className={comments.length === 0 ? "mb-4" : "mb-6"}>
                {addingComment ? (
                  <CommentPasteScope
                    onFiles={(files) => {
                      const items = files.map((file) => ({ id: newId(), file }));
                      setPendingCommentFiles((prev) => [...prev, ...items]);
                    }}
                  >
                    <RichTextEditor
                      content={commentDraft}
                      onChange={setCommentDraft}
                      placeholder="Write a comment…"
                      autoFocus
                      contentClassName="sm:text-[13px]"
                      mentionCandidates={mentionCandidates}
                    />

                    <input
                      ref={commentFileInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        if (e.target.files?.length) {
                          const items = Array.from(e.target.files).map((file) => ({ id: newId(), file }));
                          setPendingCommentFiles((prev) => [...prev, ...items]);
                          e.target.value = "";
                        }
                      }}
                    />

                    {pendingCommentFiles.length > 0 && (
                      <div className="mt-2 space-y-1.5">
                        {pendingCommentFiles.map((item) => (
                          <PendingCommentFileRow
                            key={item.id}
                            file={item.file}
                            onRemove={() => setPendingCommentFiles((prev) => prev.filter((p) => p.id !== item.id))}
                          />
                        ))}
                      </div>
                    )}

                    <div className="flex items-center justify-between gap-2 mt-2">
                      <button
                        type="button"
                        aria-label="Attach files"
                        onClick={() => commentFileInputRef.current?.click()}
                        className="p-1.5 rounded-md text-slate-400 dark:text-zinc-600 hover:text-slate-600 dark:hover:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                          <path d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </button>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={cancelComment}
                          className="px-3.5 py-1.5 text-[13px] font-medium text-slate-600 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 rounded-lg transition-colors"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={submitComment}
                          disabled={!canSubmitComment || submittingComment}
                          className={[
                            "px-3.5 py-1.5 text-[13px] font-semibold rounded-lg transition-all",
                            !canSubmitComment || submittingComment
                              ? "bg-slate-100 dark:bg-zinc-800 text-slate-400 dark:text-zinc-600 cursor-not-allowed"
                              : "bg-brand-500 hover:bg-brand-600 text-white shadow-sm shadow-brand-500/30 cursor-pointer dark:bg-brand-accent dark:hover:bg-brand-accent-strong dark:shadow-brand-accent/30 dark:text-brand-accent-foreground",
                          ].join(" ")}
                        >
                          Comment
                        </button>
                      </div>
                    </div>
                  </CommentPasteScope>
                ) : (
                  <button
                    type="button"
                    onClick={() => setAddingComment(true)}
                    className="text-[12px] font-medium text-brand-600 dark:text-brand-accent hover:text-brand-700 dark:hover:text-brand-accent-soft transition-colors"
                  >
                    Add comment
                  </button>
                )}
              </div>

              {comments.length === 0 ? (
                <p className="text-[13px] text-slate-400 dark:text-zinc-600">No comments yet.</p>
              ) : (
              <div className="space-y-6">
                {groupCommentThreads(comments).map(({ parent, replies }) => (
                  <div key={parent.id}>
                    {renderComment(parent)}
                    {replies.length > 0 && (
                      <div className="mt-4 space-y-4 pl-6 ml-3.5 border-l-2 border-slate-100 dark:border-zinc-800/80">
                        {replies.map((r) => renderComment(r))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              )}
            </CollapsibleSection>
            </div>

            <div className="order-[100]">
            <CollapsibleSection
              title="Activity"
              badge={`· ${activityLog.length} updates`}
              defaultOpen={true}
            >
              {activityLog.length === 0 ? (
                <p className="text-[13px] text-slate-400 dark:text-zinc-600">No activity yet.</p>
              ) : (
              <div className="pb-2">
                {activityLog.map((a, i) => {
                  const isLast = i === activityLog.length - 1;
                  return (
                    <div key={i} className="flex gap-3.5">
                      <div className="flex flex-col items-center w-4 flex-shrink-0">
                        <div className="w-2 h-2 rounded-full bg-slate-300 dark:bg-zinc-600 mt-1.5 flex-shrink-0 ring-2 ring-white dark:ring-zinc-950" />
                        {!isLast && (
                          <div className="w-px flex-1 bg-slate-200 dark:bg-zinc-800 mt-1 min-h-[24px]" />
                        )}
                      </div>
                      <div className={`flex-1 min-w-0 ${isLast ? "pb-0" : "pb-4"}`}>
                        <p className="text-[13px] text-slate-700 dark:text-zinc-300 leading-snug">
                          {a.label}
                        </p>
                        <p className="text-[11px] text-slate-400 dark:text-zinc-600 mt-0.5">
                          {a.timeAgo}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
              )}
            </CollapsibleSection>
            </div>

          </article>

          {/* ── Metadata sidebar ─────────────────────────────────────────────── */}
          {/* `contents` on Mobile flattens these 10 fields into direct
              children of the row above. Each gets its `order-*` via an
              `nth-child` arbitrary selector on `aside` itself (rather than a
              wrapper div per field) specifically because SidebarField/
              RelatedTicketsSection rely on `last:border-0` — a wrapper would
              make every field its own single-child parent, breaking that
              divider. Fields 1–9 (Status…Sprint) group right after the
              header/quick-summary; field 10 (Related Tickets) is
              repositioned after Attachments. Reverts to the exact original
              sticky column at `sm:`, where `order` has no effect (these are
              no longer flex siblings). Parent/Children moved out of this
              sidebar entirely — see the header breadcrumb and the main
              column's own Children section below, so hierarchy reads as
              structural, not as another sidebar relation alongside Related
              Tickets. */}
          <aside
            className={
              "contents sm:block sm:w-56 sm:flex-shrink-0 sm:sticky sm:top-8 " +
              "[&>*:nth-child(1)]:order-[30] [&>*:nth-child(2)]:order-[30] " +
              "[&>*:nth-child(3)]:order-[30] [&>*:nth-child(4)]:order-[30] " +
              "[&>*:nth-child(5)]:order-[30] [&>*:nth-child(6)]:order-[30] " +
              "[&>*:nth-child(7)]:order-[30] [&>*:nth-child(8)]:order-[30] " +
              "[&>*:nth-child(9)]:order-[30] [&>*:nth-child(10)]:order-[60]"
            }
          >

            <EditableSidebarStatus
              value={ticket.status}
              statusId={ticket.statusId}
              label={ticket.statusName}
              statuses={statuses}
              onChange={updateStatus}
              isSubscribed={isSubscribed}
              onToggleSubscribe={toggleSubscription}
            />

            <EditableSidebarAssignee
              value={ticket.assignee}
              onChange={(v) => {
                update("assignee", v);
                const member = members.find((m) => m.name === v.name);
                persist({ assigneeProfileId: member ? member.id : null });
              }}
              members={members}
            />

            <SidebarCreatedBy
              creator={ticket.creator}
              createdByProfileId={ticket.createdByProfileId}
              projectSlug={ticket.projectSlug}
            />

            <EditableSidebarType
              value={ticket.type}
              onChange={(v) => { update("type", v); persist({ type: v }); }}
            />

            <EditableSidebarPriority
              value={ticket.priority}
              onChange={(v) => { update("priority", v); persist({ priority: v }); }}
            />

            {/* Estimated Hours — always visible (fixed product rule); a
                parent shows its aggregated value read-only instead of its
                own (structurally impossible once it has children) hours. */}
            <EditableSidebarHours
              value={effectiveEstimatedHours}
              onChange={(next) => {
                update("hours", next);
                persist({ hours: next ?? null });
              }}
              isParent={isParent}
            />

            <EditableSidebarDueDate
              value={ticket.dueDate}
              onChange={(v) => {
                update("dueDate", v);
                persist({ dueDate: v ? parseDisplayDate(v) : null });
              }}
            />

            <EditableSidebarLabels
              value={ticket.labels}
              onChange={(v) => { update("labels", v); persist({ labels: v }); }}
              allLabels={allLabelOptions}
              onCreateLabel={createLabel}
            />

            <EditableSidebarSprint
              sprintId={ticket.sprintId}
              sprints={sprints}
              canEdit={user.role !== "MEMBER"}
              onChange={(v) => { update("sprintId", v); persist({ sprintId: v }); }}
            />

            <RelatedTicketsSection ticketId={ticket.id} slug={slug} onChanged={refreshActivity} onError={showError} />

          </aside>

        </div>
      </div>

      {pendingCloseConfirm && (
        <CloseParentConfirmModal
          ticket={ticket}
          openChildrenCount={pendingCloseConfirm.openCount}
          onCancel={() => setPendingCloseConfirm(null)}
          onConfirm={async () => {
            const ok = await applyStatusChange(pendingCloseConfirm.option);
            if (ok) setPendingCloseConfirm(null);
            return { success: ok };
          }}
        />
      )}

      {creatingChild && (
        <NewTicketModal
          slug={slug}
          tickets={[]}
          members={members}
          onClose={() => setCreatingChild(false)}
          onCreated={() => { setCreatingChild(false); refreshHierarchy(); }}
          onPreviewDuplicate={() => {}}
          statuses={statuses}
          parentTicketId={ticket.id}
          parentTicketLabel={getTicketDisplayKey(ticket)}
        />
      )}

      {errorMessage && <ErrorToast message={errorMessage} onDismiss={() => setErrorMessage(null)} />}
      {pasteImageToast && <PasteImageToast state={pasteImageToast} onDismiss={() => setPasteImageToast(null)} />}
    </div>
  );
}
