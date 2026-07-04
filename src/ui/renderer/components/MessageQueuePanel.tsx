




import { useSyncExternalStore, useState, useMemo, useCallback, useEffect, useRef } from "react";
import { ChevronDown, ChevronRight, MessageSquarePlus, ArrowUp, X, Pencil } from "lucide-react";
import { Badge } from "../../../components/ui/badge.js";
import type { MessageQueueStore, MessageQueueItem } from "../state/message-queue-store.js";
import { useTranslation } from "../../../i18n/react.js";

interface MessageQueuePanelProps {
  store: MessageQueueStore;

  onSendNow: (item: MessageQueueItem) => void;
}

export function MessageQueuePanel({ store, onSendNow }: MessageQueuePanelProps) {
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
      className="border-x border-y border-dashed border-info/(--opacity-medium) bg-info/(--opacity-faint)"
      data-testid="message-queue-panel"
    >
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-info/(--opacity-subtle)"
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        )}
        <MessageSquarePlus className="h-3.5 w-3.5 text-info" />
        <span className="text-sm font-medium">{t("messageQueuePanel.panelTitle")}</span>
        <Badge className="bg-info text-[10px] font-semibold text-background">{items.length}</Badge>
        {selectedCount > 0 && (
          <span className="text-xs text-muted-foreground">
            · <span className="text-accent">{t("messageQueuePanel.selectedCount", { count: selectedCount })}</span>
            <span className="ml-1 text-[10px]">{t("messageQueuePanel.cmdEnterHint")}</span>
          </span>
        )}
        {!expanded && (
          <span className="ml-2 truncate text-xs text-muted-foreground">
            · {t("messageQueuePanel.collapsedHint")}
          </span>
        )}
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
        "flex items-center gap-2 rounded border px-2 py-1 transition-colors focus:outline-none focus:ring-1 focus:ring-info/(--opacity-strong) " +
        (item.selected
          ? "border-accent bg-accent/(--opacity-subtle)"
          : "border-transparent hover:border-border")
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
        disabled={editing}
        className={
          "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border " +
          (item.selected
            ? "border-accent bg-accent text-[9px] text-background"
            : "border-muted-foreground")
        }
        aria-label={item.selected ? t("messageQueuePanel.deselectAriaLabel") : t("messageQueuePanel.selectAriaLabel")}
        aria-pressed={item.selected}
      >
        {item.selected ? "✓" : null}
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
          className="flex-1 rounded border border-accent/(--opacity-half) bg-background px-1.5 py-0.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-accent"
          maxLength={8000}
          aria-label={t("messageQueuePanel.editInputAriaLabel")}
        />
      ) : (
        <span
          className="flex-1 cursor-text truncate text-xs text-foreground"
          onDoubleClick={enterEdit}
          title={t("messageQueuePanel.doubleClickToEditTitle")}
          data-testid="message-queue-row-text"
        >
          {item.text}
        </span>
      )}
      {!editing && (
        <>
          <button
            type="button"
            onClick={enterEdit}
            className="inline-flex h-5 w-5 items-center justify-center rounded border border-transparent text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground"
            aria-label={t("messageQueuePanel.editButtonAriaLabel")}
            title={t("messageQueuePanel.editButtonTitle")}
            data-testid="message-queue-row-edit-button"
          >
            <Pencil className="h-2.5 w-2.5" />
          </button>
          <button
            type="button"
            onClick={onSendNow}
            className="inline-flex h-5 items-center gap-1 rounded border border-transparent px-1.5 text-[10px] text-accent hover:border-accent hover:bg-accent/(--opacity-subtle)"
            aria-label={t("messageQueuePanel.sendNowAriaLabel")}
            title={t("messageQueuePanel.sendNowTitle")}
          >
            <ArrowUp className="h-2.5 w-2.5" /> {t("messageQueuePanel.sendNowLabel")}
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="inline-flex h-5 w-5 items-center justify-center rounded border border-transparent text-muted-foreground hover:border-destructive/(--opacity-medium) hover:bg-destructive/(--opacity-subtle) hover:text-destructive"
            aria-label={t("messageQueuePanel.removeAriaLabel")}
            title={t("messageQueuePanel.removeTitle")}
          >
            <X className="h-3 w-3" />
          </button>
        </>
      )}
    </li>
  );
}
