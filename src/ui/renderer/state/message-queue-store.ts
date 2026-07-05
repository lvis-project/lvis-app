




import { t } from "../../../i18n/runtime.js";

export interface MessageQueueItem {
  id: string;
  text: string;
  selected: boolean;
  createdAt: number;

  expiresAt: number;
}

let nextId = 0;
function makeId(): string {

  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  nextId += 1;
  return `mq-${Date.now()}-${nextId}`;
}

/**
 * 자동 인입 prompt 포맷.
 * - 0 items: 빈 문자열 (caller 가 inject 하지 말지 결정)
 * - 1 item: 항목 그 자체 (wrap 없음 — 어색함 회피)
 * - 2+ items: "사용자가 다음 항목을 추가 요청했습니다:\n- a\n- b" 로 wrap
 *
 * 모든 vendor (Claude/OpenAI/Gemini) 호환 — 연속 user role 제약 회피용.
 */
export function formatQueueInject(items: readonly MessageQueueItem[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0].text;
  return (
    t("messageQueueStore.queueInjectHeader") +
    items.map((it) => `- ${it.text}`).join("\n")
  );
}

export class MessageQueueStore {
  /** 큐 capacity caps — economic DoS 방어. add() 가 throw 함. */
  static readonly MAX_ITEMS = 50;
  static readonly MAX_ITEM_CHARS = 8000;
  /**
   * 큐 항목 자동 만료 TTL (30 분). 사용자가 큐에 적재 후 장시간 방치 시
   * stale 항목이 의도치 않게 inject 되는 회귀 방지. take/getItems 에서
   * lazy prune.
   */
  static readonly DEFAULT_TTL_MS = 30 * 60 * 1000;

  private items: MessageQueueItem[] = [];
  private listeners = new Set<() => void>();

  /**
   * Lazy prune — 만료된 항목 제거. 모든 read/take 메서드가 호출.
   * 항목 변동 있으면 listener notify.
   */
  private prune(): void {
    const now = Date.now();
    const next = this.items.filter((it) => it.expiresAt > now);
    if (next.length === this.items.length) return;
    this.items = next;
    this.notify();
  }

  add(text: string): MessageQueueItem {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      throw new Error("MessageQueueStore.add: empty text rejected");
    }
    // Cap: economic DoS / API cost blast 방어 (security review MAJOR-1).
    // 사용자 button-mash 사고로 1000+ 항목 누적 시 formatQueueInject 의 거대
    // string 이 다음 brake-point 에 통째로 paid LLM API 로 전송되는 것 차단.
    if (trimmed.length > MessageQueueStore.MAX_ITEM_CHARS) {
      throw new Error(
        `MessageQueueStore.add: item exceeds ${MessageQueueStore.MAX_ITEM_CHARS} chars`,
      );
    }
    if (this.items.length >= MessageQueueStore.MAX_ITEMS) {
      throw new Error(
        `MessageQueueStore.add: queue full (${MessageQueueStore.MAX_ITEMS})`,
      );
    }
    const now = Date.now();
    const item: MessageQueueItem = {
      id: makeId(),
      text: trimmed,
      selected: false,
      createdAt: now,
      expiresAt: now + MessageQueueStore.DEFAULT_TTL_MS,
    };
    this.items = [...this.items, item];
    this.notify();
    return item;
  }

  remove(id: string): void {
    const before = this.items.length;
    this.items = this.items.filter((it) => it.id !== id);
    if (this.items.length !== before) this.notify();
  }

  /**
   * 큐 항목 텍스트 수정. 빈/cap 초과 throw — add 와 동일 contract.
   * Returns: true 면 변경됨 (listener notify). 같은 텍스트면 false (no-op).
   * 수정 시 expiresAt 갱신 (사용자 액션 = TTL reset).
   */
  update(id: string, text: string): boolean {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      throw new Error("MessageQueueStore.update: empty text rejected");
    }
    if (trimmed.length > MessageQueueStore.MAX_ITEM_CHARS) {
      throw new Error(
        `MessageQueueStore.update: item exceeds ${MessageQueueStore.MAX_ITEM_CHARS} chars`,
      );
    }
    let changed = false;
    const now = Date.now();
    this.items = this.items.map((it) => {
      if (it.id !== id) return it;
      if (it.text === trimmed) return it;
      changed = true;
      return { ...it, text: trimmed, expiresAt: now + MessageQueueStore.DEFAULT_TTL_MS };
    });
    if (changed) this.notify();
    return changed;
  }

  toggleSelect(id: string): void {
    let changed = false;
    this.items = this.items.map((it) => {
      if (it.id !== id) return it;
      changed = true;
      return { ...it, selected: !it.selected };
    });
    if (changed) this.notify();
  }

  clearSelection(): void {
    let changed = false;
    this.items = this.items.map((it) => {
      if (!it.selected) return it;
      changed = true;
      return { ...it, selected: false };
    });
    if (changed) this.notify();
  }

  /** 큐 전체 비우기 — turn 종료 / session 변경 시 호출. */
  clear(): void {
    if (this.items.length === 0) return;
    this.items = [];
    this.notify();
  }

  /**
   * 자연 인입 — 큐 전체를 꺼내고 비움. brake-point hook 에서 호출.
   * Returns: items in insertion order (selection state 무시).
   */
  takeAll(): MessageQueueItem[] {
    if (this.items.length === 0) return [];
    const taken = this.items;
    this.items = [];
    this.notify();
    return taken;
  }

  /**
   * 즉시 주입 — 선택된 항목만 꺼내고 비움. 미선택 항목은 잔존.
   * ⌘⏎ 인터럽트에서 호출. selection state 가 false 인 항목은 그대로.
   */
  takeSelected(): MessageQueueItem[] {
    const selected = this.items.filter((it) => it.selected);
    if (selected.length === 0) return [];
    this.items = this.items.filter((it) => !it.selected);
    this.notify();
    return selected;
  }

  /**
   * 행별 즉시 — 특정 1 항목을 꺼내고 비움. 다른 항목은 잔존.
   * 큐 행의 [↑ 즉시] 버튼에서 호출.
   */
  takeOne(id: string): MessageQueueItem | null {
    const idx = this.items.findIndex((it) => it.id === id);
    if (idx === -1) return null;
    const taken = this.items[idx];
    this.items = [...this.items.slice(0, idx), ...this.items.slice(idx + 1)];
    this.notify();
    return taken;
  }

  // ─── selectors ───
  // 모든 selector + take* 는 prune 먼저 호출 — 만료된 항목 lazy 제거.
  getItems(): readonly MessageQueueItem[] {
    this.prune();
    return this.items;
  }
  size(): number {
    this.prune();
    return this.items.length;
  }
  hasSelected(): boolean {
    this.prune();
    return this.items.some((it) => it.selected);
  }
  selectedCount(): number {
    this.prune();
    return this.items.reduce((n, it) => (it.selected ? n + 1 : n), 0);
  }

  // ─── subscription ───
  /**
   * useSyncExternalStore 호환 subscribe.
   * 반환된 unsubscribe 함수로 listener 제거.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private notify(): void {
    // Listener isolation — 한 listener throw 가 다른 listener 호출 막지 않음.
    // useSyncExternalStore 가 React 내부에서 listener 호출하므로 throw 가
    // 다른 구독자 (외부 sync) 까지 영향 안 미치도록.
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[message-queue-store] listener threw:", err);
      }
    }
  }
}
