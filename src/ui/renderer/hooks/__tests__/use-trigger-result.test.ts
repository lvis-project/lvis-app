/**
 * useTriggerResult — round-5 paths that integration tests don't cover:
 *  - onTriggerFailed clears the matching session
 *  - onTriggerExpired clears the matching session
 *  - displaced session triggers dismissTrigger on the host side
 *  - dismiss keeps the card visible when the IPC returns ok:false
 *  - silent visibility is filtered at the hook
 */
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useTriggerResult } from "../use-trigger-result.js";
import type { LvisApi } from "../../types.js";

type CompletedHandler = Parameters<LvisApi["onTriggerCompleted"]>[0];
type FailedHandler = Parameters<LvisApi["onTriggerFailed"]>[0];
type ExpiredHandler = Parameters<LvisApi["onTriggerExpired"]>[0];

interface ApiHarness {
  api: LvisApi;
  emitCompleted: (
    payload: Parameters<CompletedHandler>[0],
  ) => void;
  emitFailed: (payload: Parameters<FailedHandler>[0]) => void;
  emitExpired: (payload: Parameters<ExpiredHandler>[0]) => void;
  dismissCalls: string[];
}

function makeApi(opts?: { dismissResult?: { ok: boolean } }): ApiHarness {
  const completedHandlers = new Set<CompletedHandler>();
  const failedHandlers = new Set<FailedHandler>();
  const expiredHandlers = new Set<ExpiredHandler>();
  const dismissCalls: string[] = [];
  const dismissResult = opts?.dismissResult ?? { ok: true };
  const api = {
    onTriggerCompleted: (h: CompletedHandler) => {
      completedHandlers.add(h);
      return () => completedHandlers.delete(h);
    },
    onTriggerFailed: (h: FailedHandler) => {
      failedHandlers.add(h);
      return () => failedHandlers.delete(h);
    },
    onTriggerExpired: (h: ExpiredHandler) => {
      expiredHandlers.add(h);
      return () => expiredHandlers.delete(h);
    },
    dismissTrigger: vi.fn(async (sessionId: string) => {
      dismissCalls.push(sessionId);
      return dismissResult;
    }),
    importTrigger: vi.fn(async () => ({ ok: true, imported: 0 })),
  } as unknown as LvisApi;
  return {
    api,
    emitCompleted: (payload) => completedHandlers.forEach((h) => h(payload)),
    emitFailed: (payload) => failedHandlers.forEach((h) => h(payload)),
    emitExpired: (payload) => expiredHandlers.forEach((h) => h(payload)),
    dismissCalls,
  };
}

const baseCompleted = {
  pluginId: "work-proactive",
  source: "proactive:meeting-detection",
  visibility: "user-visible" as const,
  priority: "normal" as const,
  prompt: "p",
  summary: "s",
  completedAt: "2026-04-26T00:00:00.000Z",
};

describe("useTriggerResult", () => {
  it("filters silent visibility — never surfaces a card", () => {
    const h = makeApi();
    const { result } = renderHook(() => useTriggerResult(h.api));
    act(() => {
      h.emitCompleted({ ...baseCompleted, sessionId: "s1", visibility: "silent" });
    });
    expect(result.current.triggerResult).toBeNull();
  });

  it("onTriggerFailed clears the matching session", () => {
    const h = makeApi();
    const { result } = renderHook(() => useTriggerResult(h.api));
    act(() => {
      h.emitCompleted({ ...baseCompleted, sessionId: "s1" });
    });
    expect(result.current.triggerResult?.sessionId).toBe("s1");
    act(() => {
      h.emitFailed({
        sessionId: "s1",
        pluginId: "work-proactive",
        source: "proactive:meeting-detection",
        reason: "provider_error",
        errorId: "te-12345678",
      });
    });
    expect(result.current.triggerResult).toBeNull();
  });

  it("onTriggerFailed for a different session does NOT clear the visible one", () => {
    const h = makeApi();
    const { result } = renderHook(() => useTriggerResult(h.api));
    act(() => {
      h.emitCompleted({ ...baseCompleted, sessionId: "visible" });
    });
    act(() => {
      h.emitFailed({
        sessionId: "other",
        pluginId: "work-proactive",
        source: "proactive:meeting-detection",
        reason: "provider_error",
        errorId: "te-other",
      });
    });
    expect(result.current.triggerResult?.sessionId).toBe("visible");
  });

  it("onTriggerExpired clears the matching session", () => {
    const h = makeApi();
    const { result } = renderHook(() => useTriggerResult(h.api));
    act(() => {
      h.emitCompleted({ ...baseCompleted, sessionId: "s1" });
    });
    act(() => {
      h.emitExpired({
        sessionId: "s1",
        pluginId: "work-proactive",
        source: "proactive:meeting-detection",
      });
    });
    expect(result.current.triggerResult).toBeNull();
  });

  it("displaced session triggers dismissTrigger on the host side", () => {
    const h = makeApi();
    const { result } = renderHook(() => useTriggerResult(h.api));
    act(() => {
      h.emitCompleted({ ...baseCompleted, sessionId: "old" });
    });
    act(() => {
      h.emitCompleted({ ...baseCompleted, sessionId: "new" });
    });
    // New session is visible; old is host-side dismissed so accept-on-stale
    // closure can't import an orphan.
    expect(result.current.triggerResult?.sessionId).toBe("new");
    expect(h.dismissCalls).toEqual(["old"]);
  });

  it("dismiss keeps the card visible when IPC returns ok:false", async () => {
    const h = makeApi({ dismissResult: { ok: false } });
    const { result } = renderHook(() => useTriggerResult(h.api));
    act(() => {
      h.emitCompleted({ ...baseCompleted, sessionId: "s1" });
    });
    await act(async () => {
      await result.current.dismiss("s1");
    });
    expect(result.current.triggerResult?.sessionId).toBe("s1");
  });
});
