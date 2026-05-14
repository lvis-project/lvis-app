/**
 * MessageQueueStore 단위 테스트.
 *
 * Spec: docs/blueprints/composer-redesign-message-queue.md (메세지 큐 시맨틱)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageQueueStore, formatQueueInject } from "../message-queue-store.js";

describe("MessageQueueStore", () => {
  let store: MessageQueueStore;

  beforeEach(() => {
    store = new MessageQueueStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── add ──────────────────────────────────────────────────────────────

  it("add 는 item 을 추가하고 size 증가", () => {
    expect(store.size()).toBe(0);
    const item = store.add("first");
    expect(store.size()).toBe(1);
    expect(item.text).toBe("first");
    expect(item.selected).toBe(false);
    expect(item.id).toBeTruthy();
  });

  it("add 는 trim 후 빈 텍스트면 throw", () => {
    expect(() => store.add("")).toThrow(/empty/);
    expect(() => store.add("   ")).toThrow(/empty/);
    expect(() => store.add("\n\t")).toThrow(/empty/);
    expect(store.size()).toBe(0);
  });

  it("add 는 text 를 trim 해서 저장", () => {
    const item = store.add("  hello  ");
    expect(item.text).toBe("hello");
  });

  it("add 는 listener 호출", () => {
    const listener = vi.fn();
    store.subscribe(listener);
    store.add("a");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  // ─── remove ───────────────────────────────────────────────────────────

  it("remove 는 해당 항목만 제거", () => {
    const a = store.add("a");
    store.add("b");
    const c = store.add("c");
    store.remove(a.id);
    const items = store.getItems();
    expect(items.map((it) => it.text)).toEqual(["b", "c"]);
    expect(items.find((it) => it.id === c.id)).toBeDefined();
  });

  it("remove 가 없는 id 면 no-op + listener 호출 안 함", () => {
    store.add("a");
    const listener = vi.fn();
    store.subscribe(listener);
    store.remove("nonexistent");
    expect(listener).not.toHaveBeenCalled();
    expect(store.size()).toBe(1);
  });

  // ─── toggleSelect ─────────────────────────────────────────────────────

  it("toggleSelect 는 selection 토글", () => {
    const a = store.add("a");
    expect(store.getItems()[0].selected).toBe(false);
    store.toggleSelect(a.id);
    expect(store.getItems()[0].selected).toBe(true);
    store.toggleSelect(a.id);
    expect(store.getItems()[0].selected).toBe(false);
  });

  it("toggleSelect 가 없는 id 면 no-op + listener 호출 안 함", () => {
    store.add("a");
    const listener = vi.fn();
    store.subscribe(listener);
    store.toggleSelect("nonexistent");
    expect(listener).not.toHaveBeenCalled();
  });

  it("hasSelected / selectedCount 정확", () => {
    const a = store.add("a");
    const b = store.add("b");
    store.add("c");
    expect(store.hasSelected()).toBe(false);
    expect(store.selectedCount()).toBe(0);
    store.toggleSelect(a.id);
    store.toggleSelect(b.id);
    expect(store.hasSelected()).toBe(true);
    expect(store.selectedCount()).toBe(2);
  });

  // ─── clearSelection ───────────────────────────────────────────────────

  it("clearSelection 은 모든 선택 해제 (item 은 유지)", () => {
    const a = store.add("a");
    const b = store.add("b");
    store.toggleSelect(a.id);
    store.toggleSelect(b.id);
    store.clearSelection();
    expect(store.size()).toBe(2);
    expect(store.hasSelected()).toBe(false);
  });

  it("clearSelection 은 선택 없을 때 listener 호출 안 함", () => {
    store.add("a");
    const listener = vi.fn();
    store.subscribe(listener);
    store.clearSelection();
    expect(listener).not.toHaveBeenCalled();
  });

  // ─── clear ────────────────────────────────────────────────────────────

  it("clear 는 큐 전체 비움", () => {
    store.add("a");
    store.add("b");
    store.clear();
    expect(store.size()).toBe(0);
  });

  it("clear 는 빈 큐에서 listener 호출 안 함", () => {
    const listener = vi.fn();
    store.subscribe(listener);
    store.clear();
    expect(listener).not.toHaveBeenCalled();
  });

  // ─── takeAll (자연 인입) ──────────────────────────────────────────────

  it("takeAll 은 전체 항목 반환 + 큐 비움", () => {
    store.add("a");
    store.add("b");
    store.add("c");
    const taken = store.takeAll();
    expect(taken.map((it) => it.text)).toEqual(["a", "b", "c"]);
    expect(store.size()).toBe(0);
  });

  it("takeAll 은 빈 큐에서 [] 반환 + listener 호출 안 함", () => {
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.takeAll()).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });

  // ─── takeSelected (즉시 주입) ─────────────────────────────────────────

  it("takeSelected 는 선택 항목만 꺼냄, 미선택 잔존", () => {
    const a = store.add("a");
    store.add("b");
    const c = store.add("c");
    store.toggleSelect(a.id);
    store.toggleSelect(c.id);
    const taken = store.takeSelected();
    expect(taken.map((it) => it.text)).toEqual(["a", "c"]);
    expect(store.getItems().map((it) => it.text)).toEqual(["b"]);
  });

  it("takeSelected 는 선택 없을 때 [] 반환 + listener 호출 안 함", () => {
    store.add("a");
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.takeSelected()).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });

  // ─── takeOne (행별 즉시) ──────────────────────────────────────────────

  it("takeOne 은 특정 1 항목 꺼냄, 다른 항목 잔존", () => {
    store.add("a");
    const b = store.add("b");
    store.add("c");
    const taken = store.takeOne(b.id);
    expect(taken?.text).toBe("b");
    expect(store.getItems().map((it) => it.text)).toEqual(["a", "c"]);
  });

  it("takeOne 은 없는 id 면 null + listener 호출 안 함", () => {
    store.add("a");
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.takeOne("nonexistent")).toBeNull();
    expect(listener).not.toHaveBeenCalled();
    expect(store.size()).toBe(1);
  });

  // ─── subscribe / unsubscribe ──────────────────────────────────────────

  it("subscribe 가 unsubscribe 함수 반환", () => {
    const listener = vi.fn();
    const unsub = store.subscribe(listener);
    store.add("a");
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    store.add("b");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("여러 listener 가 동시 등록 가능", () => {
    const l1 = vi.fn();
    const l2 = vi.fn();
    store.subscribe(l1);
    store.subscribe(l2);
    store.add("a");
    expect(l1).toHaveBeenCalledTimes(1);
    expect(l2).toHaveBeenCalledTimes(1);
  });
});

describe("formatQueueInject", () => {
  function makeItem(text: string): {
    id: string; text: string; selected: boolean; createdAt: number;
  } {
    return { id: "x", text, selected: false, createdAt: 0 };
  }

  it("0 항목 → 빈 문자열", () => {
    expect(formatQueueInject([])).toBe("");
  });

  it("1 항목 → wrap 없이 항목 자체", () => {
    expect(formatQueueInject([makeItem("끝나면 요약해줘")])).toBe("끝나면 요약해줘");
  });

  it("2+ 항목 → wrap + bullet list", () => {
    const result = formatQueueInject([
      makeItem("가사 요약"),
      makeItem("출처 URL"),
      makeItem("노트 정리"),
    ]);
    expect(result).toBe(
      "사용자가 다음 항목을 추가 요청했습니다:\n- 가사 요약\n- 출처 URL\n- 노트 정리"
    );
  });

  it("줄바꿈 포함 항목도 안전하게 wrap", () => {
    const result = formatQueueInject([
      makeItem("first"),
      makeItem("multi\nline"),
    ]);
    expect(result).toContain("- first");
    expect(result).toContain("- multi\nline");
  });
});
