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

import { useSyncExternalStore, useState, useMemo } from "react";
import { ChevronDown, ChevronRight, MessageSquarePlus, ArrowUp, X } from "lucide-react";
import { Badge } from "../../../components/ui/badge.js";
import type { MessageQueueStore, MessageQueueItem } from "../state/message-queue-store.js";

interface MessageQueuePanelProps {
  store: MessageQueueStore;
  /** 행별 [↑ 즉시] click — caller (ChatView) 가 LLM abort + inject 처리. */
  onSendNow: (item: MessageQueueItem) => void;
}

export function MessageQueuePanel({ store, onSendNow }: MessageQueuePanelProps) {
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
        <span className="text-sm font-medium">메세지 큐</span>
        <Badge className="bg-info text-[10px] font-semibold text-background">{items.length}</Badge>
        {selectedCount > 0 && (
          <span className="text-xs text-muted-foreground">
            · <span className="text-accent">{selectedCount} 선택</span>
            <span className="ml-1 text-[10px]">(⌘⏎ 대상)</span>
          </span>
        )}
        {!expanded && (
          <span className="ml-2 truncate text-xs text-muted-foreground">
            · 다음 brake-point 에 자동 주입
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
}

function MessageQueueRow({ item, onToggle, onSendNow, onRemove }: MessageQueueRowProps) {
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
        className={
          "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border " +
          (item.selected
            ? "border-accent bg-accent text-[9px] text-background"
            : "border-muted-foreground")
        }
        aria-label={item.selected ? "선택 해제" : "선택"}
        aria-pressed={item.selected}
      >
        {item.selected ? "✓" : null}
      </button>
      <span className="flex-1 truncate text-xs text-foreground">{item.text}</span>
      <button
        type="button"
        onClick={onSendNow}
        className="inline-flex h-5 items-center gap-1 rounded border border-transparent px-1.5 text-[10px] text-accent hover:border-accent hover:bg-accent/10"
        aria-label="이 항목만 즉시 주입"
        title="이 항목만 즉시 주입 (인터럽트)"
      >
        <ArrowUp className="h-2.5 w-2.5" /> 즉시
      </button>
      <button
        type="button"
        onClick={onRemove}
        className="inline-flex h-5 w-5 items-center justify-center rounded border border-transparent text-muted-foreground hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
        aria-label="제거"
        title="제거"
      >
        <X className="h-3 w-3" />
      </button>
    </li>
  );
}
