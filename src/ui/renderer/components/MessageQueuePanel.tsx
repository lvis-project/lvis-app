/**
 * MessageQueuePanel — the queued-turn strip that sits directly above the
 * composer, next to SessionTasksPanel.
 *
 * Colour contract: the panel's hue is `info`, and every foreground it paints
 * comes from a foreground token (`text-info`, `text-info-foreground`,
 * `text-foreground`, `text-muted-foreground`). It must never reach for
 * `text-accent` / `border-accent` — `--accent` is a SURFACE token (a pale
 * tint in the light bundles), so using it as a text or border colour makes the
 * control vanish against the panel. That is exactly how the per-row "즉시"
 * action and the selected-row outline disappeared.
 */
import { useSyncExternalStore, useState, useMemo, useCallback, useEffect, useRef } from "react";
import { ChevronDown, ChevronRight, MessageSquarePlus, ArrowUp, Check, X, Pencil } from "lucide-react";
import { Badge } from "../../../components/ui/badge.js";
import type { MessageQueueStore, MessageQueueItem } from "../state/message-queue-store.js";
import { useTranslation } from "../../../i18n/react.js";

interface MessageQueuePanelProps {
  store: MessageQueueStore;

  onSendNow: (item: MessageQueueItem) => void;
  /**
   * The turn is parked on an approval. Rows drain at the next tool boundary,
   * and a parked turn reaches none until the approval is answered — so the
   * strip says that instead of promising the next break-point.
   */
  heldByApproval: boolean;
}

export function MessageQueuePanel({ store, onSendNow, heldByApproval }: MessageQueuePanelProps) {
  const { t } = useTranslation();
  const items = useSyncExternalStore<readonly MessageQueueItem[]>(
    store.subscribe,
    () => store.getItems(),
    () => store.getItems(),
  );

  const [expanded, setExpanded] = useState(true);
  const rowRefs = useRef<(HTMLLIElement | null)[]>([]);

  const selectedCount = useMemo(
    () => items.reduce((n, it) => (it.selected ? n + 1 : n), 0),
    [items],
  );

  useEffect(() => {
    if (!expanded || items.length === 0) return;
    const frame = requestAnimationFrame(() => rowRefs.current[0]?.focus());
    return () => cancelAnimationFrame(frame);
  }, [expanded, items.length]);

  if (items.length === 0) return null;

  const focusRow = (index: number) => {
    if (items.length === 0) return;
    const next = (index + items.length) % items.length;
    rowRefs.current[next]?.focus();
  };

  return (
    <div
      /* Full-bleed band across <main>, like SessionTasksPanel above it: dock
         strips are BANDS and the composer is the inset card. That split is a
         deliberate system decision, pinned for the tasks strip by
         session-tasks-in-chat.spec.ts — do not inset this one either, or the
         two siblings stop agreeing. Dashed border = "not committed yet", the
         shared language; the hue is what separates them (info here, warning
         there). */
      className="border-x border-y border-dashed border-info/(--opacity-medium) bg-info/(--opacity-faint) text-xs"
      data-testid="message-queue-panel"
    >
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-info/(--opacity-subtle) motion-reduce:transition-none"
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        <MessageSquarePlus className="h-3 w-3 shrink-0 text-info" />
        <span className="font-medium">{t("messageQueuePanel.panelTitle")}</span>
        <Badge variant="outline" className="px-1 py-0 text-[10px] font-semibold text-info">
          {items.length}
        </Badge>
        {selectedCount > 0 && (
          <span className="min-w-0 truncate text-muted-foreground">
            · <span className="font-medium text-foreground">{t("messageQueuePanel.selectedCount", { count: selectedCount })}</span>
            <span className="ml-1 text-[10px]">{t("messageQueuePanel.cmdEnterHint")}</span>
          </span>
        )}
        {heldByApproval ? (
          <span
            className="ml-2 min-w-0 truncate font-medium text-warning"
            data-testid="message-queue-held-by-approval"
          >
            · {t("messageQueuePanel.heldByApprovalHint")}
          </span>
        ) : !expanded ? (
          <span className="ml-2 min-w-0 truncate text-muted-foreground">
            · {t("messageQueuePanel.collapsedHint")}
          </span>
        ) : null}
      </button>

      {expanded && (
        <ul
          className="flex max-h-[35vh] flex-col gap-0.5 overflow-y-auto px-2 pb-2"
          data-testid="message-queue-list"
        >
          {items.map((item, index) => (
            <MessageQueueRow
              key={item.id}
              item={item}
              rowRef={(node) => { rowRefs.current[index] = node; }}
              onToggle={() => store.toggleSelect(item.id)}
              onSendNow={() => onSendNow(item)}
              onRemove={() => store.remove(item.id)}
              onEdit={(next) => store.update(item.id, next)}
              onMoveFocus={(delta) => focusRow(index + delta)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

interface MessageQueueRowProps {
  item: MessageQueueItem;
  rowRef: (node: HTMLLIElement | null) => void;
  onToggle: () => void;
  onSendNow: () => void;
  onRemove: () => void;

  onEdit: (newText: string) => void;
  onMoveFocus: (delta: 1 | -1) => void;
}

function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

function MessageQueueRow({
  item,
  rowRef,
  onToggle,
  onSendNow,
  onRemove,
  onEdit,
  onMoveFocus,
}: MessageQueueRowProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Accepted by the engine, not yet delivered. The row is no longer the
  // user's to change — editing or re-injecting it would diverge from what the
  // engine already holds — but it stays visible so the message is never
  // missing from both the queue and the transcript at once.
  const handedOff = item.handedOffAs !== undefined;

  const enterEdit = useCallback(() => {
    setDraft(item.text);
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [item.text]);

  const commit = useCallback(() => {
    const next = draft.trim();
    if (next.length === 0) {

      setEditing(false);
      onRemove();
      return;
    }
    if (next === item.text) {
      setEditing(false);
      return;
    }
    try {
      onEdit(next);
      setEditing(false);
    } catch (err) {
      console.warn("[message-queue] edit rejected:", (err as Error).message);
    }
  }, [draft, item.text, onEdit, onRemove]);

  const cancel = useCallback(() => {
    setDraft(item.text);
    setEditing(false);
  }, [item.text]);

  return (
    <li
      ref={rowRef}
      className={
        "flex items-center gap-2 rounded border px-2 py-1 transition-colors focus:outline-none focus:ring-1 focus:ring-info/(--opacity-strong) motion-reduce:transition-none " +
        (item.selected
          ? "border-info/(--opacity-medium) bg-info/(--opacity-subtle)"
          : "border-transparent hover:border-info/(--opacity-muted) hover:bg-info/(--opacity-subtle)")
      }
      data-testid="message-queue-row"
      data-selected={item.selected ? "true" : "false"}
      tabIndex={editing ? -1 : 0}
      aria-selected={item.selected}
      onKeyDown={(e) => {
        if (editing) return;
        if (isTextEditingTarget(e.target)) return;
        if (e.key === "ArrowDown") {
          e.preventDefault();
          onMoveFocus(1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          onMoveFocus(-1);
        } else if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
          e.preventDefault();
          onToggle();
        } else if ((e.key === "Delete" || e.key === "Backspace") && e.target === e.currentTarget) {
          e.preventDefault();
          onRemove();
        }
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        disabled={editing || handedOff}
        className={
          "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border transition-colors motion-reduce:transition-none " +
          (item.selected
            ? "border-info bg-info text-info-foreground"
            : "border-muted-foreground hover:border-info")
        }
        aria-label={item.selected ? t("messageQueuePanel.deselectAriaLabel") : t("messageQueuePanel.selectAriaLabel")}
        aria-pressed={item.selected}
      >
        {item.selected ? <Check className="h-2.5 w-2.5" strokeWidth={3} /> : null}
      </button>
      {editing ? (
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          data-testid="message-queue-row-edit"
          className="min-w-0 flex-1 rounded border border-input-bar-border bg-background px-1.5 py-0.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-input-bar-focus"
          maxLength={8000}
          aria-label={t("messageQueuePanel.editInputAriaLabel")}
        />
      ) : (
        <span
          className={
            "min-w-0 flex-1 truncate text-xs " +
            (handedOff ? "text-muted-foreground" : "cursor-text text-foreground")
          }
          onDoubleClick={handedOff ? undefined : enterEdit}
          title={handedOff
            ? t("messageQueuePanel.handedOffTitle")
            : t("messageQueuePanel.doubleClickToEditTitle")}
          data-testid="message-queue-row-text"
        >
          {item.text}
        </span>
      )}
      {!editing && handedOff && (
        <span
          className="shrink-0 rounded border border-info/(--opacity-medium) bg-info/(--opacity-subtle) px-1.5 py-0.5 text-[10px] font-medium text-foreground"
          title={t("messageQueuePanel.handedOffTitle")}
          data-testid="message-queue-row-handed-off"
        >
          {t("messageQueuePanel.handedOffBadge")}
        </span>
      )}
      {!editing && !handedOff && (
        /* One action cluster, uniform 20px hit targets and a single gap so the
           three verbs read as a row rather than three differently-sized chips.
           "즉시" keeps its label — it is the only destructive-adjacent action
           whose meaning an icon alone does not carry. */
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={enterEdit}
            className="inline-flex h-5 w-5 items-center justify-center rounded border border-transparent text-muted-foreground transition-colors hover:border-border hover:bg-muted hover:text-foreground motion-reduce:transition-none"
            aria-label={t("messageQueuePanel.editButtonAriaLabel")}
            title={t("messageQueuePanel.editButtonTitle")}
            data-testid="message-queue-row-edit-button"
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={onSendNow}
            /* `text-info` at 10px only reaches 4.1:1 on the panel — under AA.
               The label rests in the readable foreground and the panel's hue
               carries the hover/focus state instead, where it is decoration
               rather than the thing you have to read. */
            className="inline-flex h-5 items-center gap-0.5 rounded border border-transparent px-1.5 text-[10px] font-medium text-foreground transition-colors hover:border-info/(--opacity-medium) hover:bg-info/(--opacity-subtle) hover:text-info motion-reduce:transition-none"
            aria-label={t("messageQueuePanel.sendNowAriaLabel")}
            title={t("messageQueuePanel.sendNowTitle")}
            data-testid="message-queue-row-send-now-button"
          >
            <ArrowUp className="h-2.5 w-2.5" />
            {t("messageQueuePanel.sendNowLabel")}
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="inline-flex h-5 w-5 items-center justify-center rounded border border-transparent text-muted-foreground transition-colors hover:border-destructive/(--opacity-medium) hover:bg-destructive/(--opacity-subtle) hover:text-destructive motion-reduce:transition-none"
            aria-label={t("messageQueuePanel.removeAriaLabel")}
            title={t("messageQueuePanel.removeTitle")}
            data-testid="message-queue-row-remove-button"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
    </li>
  );
}
