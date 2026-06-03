/**
 * MessageQueuePanel — composer 위 in-flow 큐 패널.
 *
 * SessionTodoPanel 의 시각 패턴 (border-dashed strip) 미러링하되 색만
 * 다름: warning (TODO) ↔ info (큐). 두 영역이 동시 노출되어도 시각 충돌 X.
 *
 * 표시 조건: store.size() > 0 일 때만. 큐 비면 panel 자체가 사라져
 * idle 상태에서 noise 추가 안 됨.
 *
 * 행별 액션:
 *  - 체크박스 클릭: 선택 토글 (⌘⏎ 대상 지정)
 *  - [↑ 즉시] 버튼: 그 1 개만 즉시 inject (LLM abort + 다른 항목 잔존)
 *  - [✕] 버튼: 그 1 개만 큐에서 제거
 *
 * 단축키 없음 — 행별 액션은 마우스 only.
 *
 * Spec: docs/blueprints/composer-redesign-message-queue.md
 */

import { useSyncExternalStore, useState, useMemo, useCallback, useRef } from "react";
import { ChevronDown, ChevronRight, MessageSquarePlus, ArrowUp, X, Pencil } from "lucide-react";
import { Badge } from "../../../components/ui/badge.js";
import type { MessageQueueStore, MessageQueueItem } from "../state/message-queue-store.js";
import { useTranslation } from "../../../i18n/react.js";

interface MessageQueuePanelProps {
  store: MessageQueueStore;
  /** 행별 [↑ 즉시] click — caller (ChatView) 가 LLM abort + inject 처리. */
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

  const selectedCount = useMemo(
    () => items.reduce((n, it) => (it.selected ? n + 1 : n), 0),
    [items],
  );

  if (items.length === 0) return null;

  return (
    <div
      className="border-x border-y border-dashed border-info/40 bg-info/5"
      data-testid="message-queue-panel"
    >
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-info/10"
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
          {items.map((item) => (
            <MessageQueueRow
              key={item.id}
              item={item}
              onToggle={() => store.toggleSelect(item.id)}
              onSendNow={() => onSendNow(item)}
              onRemove={() => store.remove(item.id)}
              onEdit={(next) => store.update(item.id, next)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

interface MessageQueueRowProps {
  item: MessageQueueItem;
  onToggle: () => void;
  onSendNow: () => void;
  onRemove: () => void;
  /** 텍스트 수정 — Enter / blur 로 저장. 빈 텍스트 또는 cap 초과 시 throw. */
  onEdit: (newText: string) => void;
}

function MessageQueueRow({ item, onToggle, onSendNow, onRemove, onEdit }: MessageQueueRowProps) {
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
      // 빈 텍스트 → 제거 의도
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
      className={
        "flex items-center gap-2 rounded border px-2 py-1 transition-colors " +
        (item.selected
          ? "border-accent bg-accent/10"
          : "border-transparent hover:border-border")
      }
      data-testid="message-queue-row"
      data-selected={item.selected ? "true" : "false"}
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
          className="flex-1 rounded border border-accent/50 bg-background px-1.5 py-0.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-accent"
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
            className="inline-flex h-5 items-center gap-1 rounded border border-transparent px-1.5 text-[10px] text-accent hover:border-accent hover:bg-accent/10"
            aria-label={t("messageQueuePanel.sendNowAriaLabel")}
            title={t("messageQueuePanel.sendNowTitle")}
          >
            <ArrowUp className="h-2.5 w-2.5" /> {t("messageQueuePanel.sendNowLabel")}
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="inline-flex h-5 w-5 items-center justify-center rounded border border-transparent text-muted-foreground hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
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
