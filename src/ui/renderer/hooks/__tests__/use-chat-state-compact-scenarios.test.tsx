/**
 * useChatState — compact pipeline scenario suite.
 *
 * Verifies user-visible behaviour around the pre-turn / manual compact
 * lifecycle (not function-level unit tests). Each scenario captures the
 * `onChatStream` handler the hook registers, then dispatches a sequence
 * of simulated stream events and asserts on the resulting public state.
 *
 * Coverage:
 *   S1: compact_started flips isCompacting on (StatusBar hint appears)
 *   S2: compact_notice with estimatedAfter → checkpoint + accurate
 *       synthetic context_usage drives ring refresh
 *   S3: compact_notice without estimatedAfter → checkpoint only
 *   S4 (M2 fix): compact_notice without estimatedAfter AND freed === 0
 *       → checkpoint only, no misleading synthetic context_usage
 *   S5 (M4 fix): applyLoadedSession during mid-compact clears the stale
 *       isCompacting indicator
 *   S6 (M4 fix): clearForNewChat during mid-compact clears it as well
 *   S7: done event clears isCompacting (defensive)
 *   S8: error event clears isCompacting (defensive)
 */
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useChatState } from "../use-chat-state.js";
import type { LvisApi } from "../../types.js";
import type { StreamEvent } from "../../../../lib/chat-stream-state.js";
import type { ChatEntry } from "../../../../lib/chat-stream-state.js";

// ─── Test harness ─────────────────────────────────────────────────────────────

type StreamHandler = (ev: StreamEvent) => void;

interface CapturedApi {
  api: LvisApi;
  streamHandler: { current: StreamHandler | null };
}

function makeCapturedApi(): CapturedApi {
  const streamHandler: { current: StreamHandler | null } = { current: null };
  const noop = () => () => {};
  const api = {
    onChatStream: (h: StreamHandler) => {
      streamHandler.current = h;
      return () => {
        streamHandler.current = null;
      };
    },
    onChatFallback: noop,
    onLoadSessionInMain: noop,
    onLogEntry: noop,
    onPluginInstallProgress: noop,
    onPluginInstallResult: noop,
    onPluginUninstallResult: noop,
    chatCompact: vi.fn(async () => ({ compacted: true, removedMessageCount: 1, compactedAt: "x", summary: "ok" })),
  } as unknown as LvisApi;
  return { api, streamHandler };
}

function dispatchEvent(streamHandler: { current: StreamHandler | null }, ev: StreamEvent): void {
  expect(streamHandler.current).not.toBeNull();
  act(() => {
    streamHandler.current?.(ev);
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("useChatState — compact lifecycle scenarios", () => {
  it("S1: compact_started flips isCompacting on (StatusBar hint visible)", () => {
    const { api, streamHandler } = makeCapturedApi();
    const { result } = renderHook(() => useChatState(api));

    expect(result.current.isCompacting).toBe(false);

    dispatchEvent(streamHandler, {
      type: "compact_started",
      triggerSource: "estimate",
      estimatedBefore: 90_000,
      preflight: 88_000,
    } as StreamEvent);

    expect(result.current.isCompacting).toBe(true);
  });

  it("S2: compact_notice with estimatedAfter writes accurate post-compact context_usage", () => {
    const { api, streamHandler } = makeCapturedApi();
    const { result } = renderHook(() => useChatState(api));

    dispatchEvent(streamHandler, { type: "compact_started" } as StreamEvent);
    dispatchEvent(streamHandler, {
      type: "compact_notice",
      removedMessages: 12,
      freedTokens: 4_000,
      estimatedAfter: 50_000,
      trigger: "auto-compact",
      compactNum: 1,
    } as StreamEvent);

    expect(result.current.isCompacting).toBe(false);

    const lastTwo = result.current.entries.slice(-2);
    expect(lastTwo[0]).toMatchObject({
      kind: "checkpoint",
      removedMessages: 12,
      freedTokens: 4_000,
      trigger: "auto-compact",
      compactNum: 1,
    });
    expect(lastTwo[1]).toMatchObject({
      kind: "context_usage",
      tokensIn: 50_000,
      source: "compact-estimate",
    });
  });

  it("S3: compact_notice without estimatedAfter writes checkpoint only", () => {
    const { api, streamHandler } = makeCapturedApi();
    const { result } = renderHook(() => useChatState(api));

    // Seed a prior turn_summary; without estimatedAfter, compact_notice must
    // not synthesize a replacement usage estimate.
    act(() => {
      result.current.applyLoadedSession([
        { kind: "user", text: "hi" },
        { kind: "turn_summary", tokensIn: 10_000, freshInputTokens: 10_000, tokensOut: 500, turnDurationMs: 100, toolCount: 0, cumulativeToolMs: 0 } as ChatEntry,
      ]);
    });

    const before = result.current.entries.length;

    dispatchEvent(streamHandler, {
      type: "compact_notice",
      removedMessages: 5,
      freedTokens: 3_000,
      // estimatedAfter intentionally omitted
    } as StreamEvent);

    expect(result.current.entries.length).toBe(before + 1);
    expect(result.current.entries.at(-1)).toMatchObject({
      kind: "checkpoint",
      removedMessages: 5,
      freedTokens: 3_000,
    });
    const lastUsage = [...result.current.entries].reverse().find(
      (e) => e.kind === "turn_summary" || e.kind === "context_usage",
    );
    expect(lastUsage?.kind).toBe("turn_summary");
    expect(lastUsage && "tokensIn" in lastUsage ? lastUsage.tokensIn : -1).toBe(10_000);
  });

  it("S4 (M2): compact_notice without estimatedAfter AND freed === 0 → checkpoint only, NO synthetic context_usage", () => {
    const { api, streamHandler } = makeCapturedApi();
    const { result } = renderHook(() => useChatState(api));

    act(() => {
      result.current.applyLoadedSession([
        { kind: "user", text: "hi" },
        { kind: "turn_summary", tokensIn: 9_999, freshInputTokens: 9_999, tokensOut: 100, turnDurationMs: 50, toolCount: 0, cumulativeToolMs: 0 } as ChatEntry,
      ]);
    });

    const before = result.current.entries.length;

    dispatchEvent(streamHandler, {
      type: "compact_notice",
      removedMessages: 0,
      freedTokens: 0,
    } as StreamEvent);

    // Exactly one new entry — the checkpoint. No synthetic context_usage
    // that would overwrite the existing turn_summary signal.
    expect(result.current.entries.length).toBe(before + 1);
    expect(result.current.entries[result.current.entries.length - 1]).toMatchObject({
      kind: "checkpoint",
      removedMessages: 0,
      freedTokens: 0,
    });
    // The most recent usage carrier should still be the original turn_summary.
    const lastUsage = [...result.current.entries].reverse().find(
      (e) => e.kind === "turn_summary" || e.kind === "context_usage",
    );
    expect(lastUsage?.kind).toBe("turn_summary");
    expect(lastUsage && "tokensIn" in lastUsage ? lastUsage.tokensIn : -1).toBe(9_999);
  });

  it("S5 (M4): applyLoadedSession during mid-compact clears stale isCompacting", () => {
    const { api, streamHandler } = makeCapturedApi();
    const { result } = renderHook(() => useChatState(api));

    dispatchEvent(streamHandler, { type: "compact_started" } as StreamEvent);
    expect(result.current.isCompacting).toBe(true);

    act(() => {
      result.current.applyLoadedSession([{ kind: "user", text: "new session" }]);
    });

    expect(result.current.isCompacting).toBe(false);
  });

  it("S5b (M4-ext): truncateToEntry during mid-compact clears stale isCompacting", () => {
    // Edit/retry rewind drops history forward of the cut point. If a
    // pre-turn compact is mid-flight, its compact_notice will land in
    // a different streaming context — same stale-indicator race as
    // session switch.
    const { api, streamHandler } = makeCapturedApi();
    const { result } = renderHook(() => useChatState(api));

    act(() => {
      result.current.applyLoadedSession([
        { kind: "user", text: "first" },
        { kind: "assistant", text: "reply" },
      ]);
    });

    dispatchEvent(streamHandler, { type: "compact_started" } as StreamEvent);
    expect(result.current.isCompacting).toBe(true);

    act(() => {
      result.current.truncateToEntry(0);
    });

    expect(result.current.isCompacting).toBe(false);
  });

  it("S6 (M4): clearForNewChat during mid-compact clears stale isCompacting", () => {
    const { api, streamHandler } = makeCapturedApi();
    const { result } = renderHook(() => useChatState(api));

    dispatchEvent(streamHandler, { type: "compact_started" } as StreamEvent);
    expect(result.current.isCompacting).toBe(true);

    act(() => {
      result.current.clearForNewChat();
    });

    expect(result.current.isCompacting).toBe(false);
    expect(result.current.entries).toEqual([]);
  });

  it("S7: done event clears isCompacting defensively", () => {
    const { api, streamHandler } = makeCapturedApi();
    const { result } = renderHook(() => useChatState(api));

    dispatchEvent(streamHandler, { type: "compact_started" } as StreamEvent);
    dispatchEvent(streamHandler, { type: "done" } as StreamEvent);

    expect(result.current.isCompacting).toBe(false);
  });

  it("S8: error event clears isCompacting defensively", () => {
    const { api, streamHandler } = makeCapturedApi();
    const { result } = renderHook(() => useChatState(api));

    dispatchEvent(streamHandler, { type: "compact_started" } as StreamEvent);
    dispatchEvent(streamHandler, { type: "error", error: "boom" } as StreamEvent);

    expect(result.current.isCompacting).toBe(false);
  });

  it("S9: error event propagates systemNotice for live/reload alert parity", () => {
    const { api, streamHandler } = makeCapturedApi();
    const { result } = renderHook(() => useChatState(api));

    dispatchEvent(streamHandler, {
      type: "error",
      error: "Resource not found",
      systemNotice: "stream-error",
    } as StreamEvent);

    const assistant = result.current.entries.at(-1);
    expect(assistant).toMatchObject({
      kind: "assistant",
      text: "오류: Resource not found",
      systemNotice: "stream-error",
    });
  });

  it("S9b: turn_summary requires the token fields and preserves cache breakdown", () => {
    const { api, streamHandler } = makeCapturedApi();
    const { result } = renderHook(() => useChatState(api));

    dispatchEvent(streamHandler, {
      type: "turn_summary",
      turnDurationMs: 100,
      toolCount: 0,
      cumulativeToolMs: 0,
      tokensIn: 1000,
      freshInputTokens: 700,
      tokensOut: 50,
      cacheReadTokens: 200,
      cacheWriteTokens: 100,
      vendorProvider: "claude",
      vendorModel: "claude-opus-4-6",
    } as StreamEvent);

    expect(result.current.entries.at(-1)).toMatchObject({
      kind: "turn_summary",
      tokensIn: 1000,
      freshInputTokens: 700,
      tokensOut: 50,
      cacheReadTokens: 200,
      cacheWriteTokens: 100,
      vendorProvider: "claude",
      vendorModel: "claude-opus-4-6",
    });

    dispatchEvent(streamHandler, {
      type: "turn_summary",
      turnDurationMs: 100,
      toolCount: 0,
      cumulativeToolMs: 0,
      tokensIn: 2000,
      tokensOut: 50,
    } as StreamEvent);

    expect(result.current.entries.filter((entry) => entry.kind === "turn_summary")).toHaveLength(1);
  });

  it("S10: manual compact NOOP clears isCompacting and surfaces the engine summary", async () => {
    const { api, streamHandler } = makeCapturedApi();
    api.chatCompact = vi.fn(async () => ({
      compacted: false,
      compactedAt: null,
      removedMessageCount: 0,
      summary: "LLM provider 미구성 — 압축 실행 불가.",
    }));
    const { result } = renderHook(() => useChatState(api));

    dispatchEvent(streamHandler, { type: "compact_started" } as StreamEvent);
    await act(async () => {
      const handled = await result.current.handleCompactCommand("/compact");
      expect(handled).toBe(true);
    });

    expect(result.current.isCompacting).toBe(false);
    expect(result.current.entries.at(-1)).toMatchObject({
      kind: "system",
      text: "LLM provider 미구성 — 압축 실행 불가.",
    });
  });

  it("S11: only the exact /compact command is intercepted", async () => {
    const { api } = makeCapturedApi();
    const { result } = renderHook(() => useChatState(api));

    await act(async () => {
      const handled = await result.current.handleCompactCommand("/compactfoo");
      expect(handled).toBe(false);
    });

    expect(api.chatCompact).not.toHaveBeenCalled();
  });

  // ─── #916: force-recover OFF-override banner ──────────────────────────────

  it("S12 (#916): compact_started with triggerSource=force-recover exposes compactTriggerSource", () => {
    const { api, streamHandler } = makeCapturedApi();
    const { result } = renderHook(() => useChatState(api));

    expect(result.current.compactTriggerSource).toBeNull();

    dispatchEvent(streamHandler, {
      type: "compact_started",
      triggerSource: "force-recover",
      estimatedBefore: 90_000,
      preflight: 88_000,
    } as StreamEvent);

    expect(result.current.isCompacting).toBe(true);
    expect(result.current.compactTriggerSource).toBe("force-recover");
  });

  it("S13 (#916): compact_notice clears compactTriggerSource", () => {
    const { api, streamHandler } = makeCapturedApi();
    const { result } = renderHook(() => useChatState(api));

    dispatchEvent(streamHandler, {
      type: "compact_started",
      triggerSource: "force-recover",
      estimatedBefore: 90_000,
      preflight: 88_000,
    } as StreamEvent);

    expect(result.current.compactTriggerSource).toBe("force-recover");

    dispatchEvent(streamHandler, {
      type: "compact_notice",
      removedMessages: 10,
      freedTokens: 5_000,
    } as StreamEvent);

    expect(result.current.isCompacting).toBe(false);
    expect(result.current.compactTriggerSource).toBeNull();
  });

  it("S14 (#916): done event clears compactTriggerSource defensively", () => {
    const { api, streamHandler } = makeCapturedApi();
    const { result } = renderHook(() => useChatState(api));

    dispatchEvent(streamHandler, {
      type: "compact_started",
      triggerSource: "force-recover",
    } as StreamEvent);

    expect(result.current.compactTriggerSource).toBe("force-recover");

    dispatchEvent(streamHandler, { type: "done" } as StreamEvent);

    expect(result.current.compactTriggerSource).toBeNull();
  });

  // ─── #917: recovery_exhausted banner ─────────────────────────────────────

  it("S15 (#917): recovery_exhausted event sets isRecoveryExhausted", () => {
    const { api, streamHandler } = makeCapturedApi();
    const { result } = renderHook(() => useChatState(api));

    expect(result.current.isRecoveryExhausted).toBe(false);

    dispatchEvent(streamHandler, { type: "recovery_exhausted" } as StreamEvent);

    expect(result.current.isRecoveryExhausted).toBe(true);
  });

  it("S16 (#917): clearForNewChat resets isRecoveryExhausted", () => {
    const { api, streamHandler } = makeCapturedApi();
    const { result } = renderHook(() => useChatState(api));

    dispatchEvent(streamHandler, { type: "recovery_exhausted" } as StreamEvent);
    expect(result.current.isRecoveryExhausted).toBe(true);

    act(() => {
      result.current.clearForNewChat();
    });

    expect(result.current.isRecoveryExhausted).toBe(false);
  });

  it("S17 (#917): clearForNewChat also resets compactTriggerSource", () => {
    const { api, streamHandler } = makeCapturedApi();
    const { result } = renderHook(() => useChatState(api));

    dispatchEvent(streamHandler, {
      type: "compact_started",
      triggerSource: "force-recover",
    } as StreamEvent);
    expect(result.current.compactTriggerSource).toBe("force-recover");

    act(() => {
      result.current.clearForNewChat();
    });

    expect(result.current.compactTriggerSource).toBeNull();
    expect(result.current.isCompacting).toBe(false);
  });
});
