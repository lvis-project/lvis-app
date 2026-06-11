/**
 * manualCompact — user-flow scenario suite for /compact slash command.
 *
 * Verifies behaviour from the user's perspective (not function-level):
 *   M3-B: no-op compact (removedCount=0) returns generic "not needed" message.
 *         Both genuine-small-history and structural-deadlock branches collapse
 *         to the same message — the "actionable deadlock guidance" approach
 *         was dropped because the right fix is the Gemini-style 3-layer
 *         compact pipeline (tracked as a follow-up rewrite issue) rather
 *         than telling the user to delete messages manually.
 *   M3-C: successful compact returns compacted=true + removedMessageCount.
 *   Trigger: manualCompact emits onCompactStarted with triggerSource="manual".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConversationLoop } from "../conversation-loop.js";
import type { GenericMessage } from "../llm/types.js";
import {
  makeConversationLoopDeps as makeDeps,
  makeConversationLoopMemoryManager as makeMemoryManager,
  makeConversationTurnProvider as makeProviderStub,
} from "./conversation-loop-test-helpers.js";

vi.mock("../structured-compact.js", () => ({
  DEFAULT_PRESERVE_RECENT_TURNS: 5,
  compactWithBoundary: vi.fn(),
  renderBoundaryAsPreamble: vi.fn(() => "## Compact preamble"),
}));

import { compactWithBoundary } from "../structured-compact.js";
import { CompressionStatus } from "../../shared/compact-status.js";

beforeEach(() => {
  vi.mocked(compactWithBoundary).mockClear();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("manualCompact — /compact deadlock guidance (M3 scenarios)", () => {
  it("M3-B: removedCount=0 returns generic 'not needed' message (both small-history and deadlock branches)", async () => {
    // Tiny history — well below 80% of preflight.
    const small: GenericMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];

    const loop = new ConversationLoop(makeDeps({ memoryManager: makeMemoryManager(small) }));
    loop.resetAndResume("sess-1");
    (loop as unknown as { provider: ReturnType<typeof makeProviderStub> }).provider = makeProviderStub();

    vi.mocked(compactWithBoundary).mockResolvedValueOnce({
      status: CompressionStatus.NOOP,
      boundary: null,
      newHistory: small,
      removedCount: 0,
      estimatedAfter: 0,
      truncatedCount: 0,
    });

    const result = await loop.manualCompact();
    expect(result.compacted).toBe(false);
    expect(result.summary).toBe("컴팩트 불필요: 메시지 수가 충분히 적습니다.");
  });

  it("M3-C: successful compact returns compacted=true with removedMessageCount", async () => {
    const history: GenericMessage[] = [
      { role: "user", content: "msg1" },
      { role: "assistant", content: "reply1" },
      { role: "user", content: "msg2" },
      { role: "assistant", content: "reply2" },
    ];

    const loop = new ConversationLoop(makeDeps({ memoryManager: makeMemoryManager(history) }));
    loop.resetAndResume("sess-1");
    (loop as unknown as { provider: ReturnType<typeof makeProviderStub> }).provider = makeProviderStub();

    vi.mocked(compactWithBoundary).mockResolvedValueOnce({
      status: CompressionStatus.SUMMARIZED,
      boundary: {
        id: "b1",
        compactNum: 1,
        summary: { goal: "", constraints: "", progress: "", decisions: "", files: [], nextSteps: "", criticalContext: "", currentPlan: "", verificationState: "", openBlockers: "", unsafePendingActions: "", lastToolBoundary: "" },
        toolBoundaryLedger: [],
        pinnedArtifacts: [],
        createdAt: new Date().toISOString(),
      } as never,
      newHistory: history.slice(-2),
      removedCount: 2,
      estimatedAfter: 100,
      truncatedCount: 0,
    });

    const result = await loop.manualCompact();
    expect(result.compacted).toBe(true);
    expect(result.removedMessageCount).toBe(2);
  });

  it("Trigger: manualCompact fires onCompactStarted with triggerSource='manual'", async () => {
    const history: GenericMessage[] = [
      { role: "user", content: "x".repeat(40_000) },
    ];

    const loop = new ConversationLoop(makeDeps({ memoryManager: makeMemoryManager(history) }));
    loop.resetAndResume("sess-1");
    (loop as unknown as { provider: ReturnType<typeof makeProviderStub> }).provider = makeProviderStub();

    vi.mocked(compactWithBoundary).mockResolvedValueOnce({
      status: CompressionStatus.NOOP,
      boundary: null,
      newHistory: history,
      removedCount: 0,
      estimatedAfter: 0,
      truncatedCount: 0,
    });

    const startedCb = vi.fn();
    await loop.manualCompact({ onCompactStarted: startedCb });

    expect(startedCb).toHaveBeenCalledTimes(1);
    const arg = startedCb.mock.calls[0]?.[0];
    expect(arg?.triggerSource).toBe("manual");
    expect(typeof arg?.estimatedBefore).toBe("number");
    expect(arg?.preflight).toBeGreaterThan(0);
  });
});

// #811 milestone-2 — PreCompact / PostCompact lifecycle events on the manual path.
describe("manualCompact — #811 m2 PreCompact / PostCompact lifecycle events", () => {
  function stubManager() {
    return {
      setTrustedHooks: vi.fn(),
      setTrustedRegistry: vi.fn(),
      size: () => 0,
      runPreToolUse: vi.fn(),
      runPostToolUse: vi.fn(),
      runPermissionRequest: vi.fn(),
      runLifecycleEvent: vi.fn(async () => ({ decision: "allow" as const, reason: "noop", results: [] })),
    };
  }

  it("fires PreCompact (reason=manual) then PostCompact around an applied compaction", async () => {
    const history: GenericMessage[] = [
      { role: "user", content: "msg1" },
      { role: "assistant", content: "reply1" },
      { role: "user", content: "msg2" },
      { role: "assistant", content: "reply2" },
    ];
    const mgr = stubManager();
    const loop = new ConversationLoop(
      makeDeps({ memoryManager: makeMemoryManager(history), scriptHookManager: mgr as never }),
    );
    loop.resetAndResume("sess-1");
    (loop as unknown as { provider: ReturnType<typeof makeProviderStub> }).provider = makeProviderStub();

    vi.mocked(compactWithBoundary).mockResolvedValueOnce({
      status: CompressionStatus.SUMMARIZED,
      boundary: {
        id: "b1",
        compactNum: 1,
        summary: { goal: "", constraints: "", progress: "", decisions: "", files: [], nextSteps: "", criticalContext: "", currentPlan: "", verificationState: "", openBlockers: "", unsafePendingActions: "", lastToolBoundary: "" },
        toolBoundaryLedger: [],
        pinnedArtifacts: [],
        createdAt: new Date().toISOString(),
      } as never,
      newHistory: history.slice(-2),
      removedCount: 2,
      estimatedAfter: 100,
      truncatedCount: 0,
    });

    await loop.manualCompact();

    const pre = mgr.runLifecycleEvent.mock.calls.find((c) => c[0] === "PreCompact");
    const post = mgr.runLifecycleEvent.mock.calls.find((c) => c[0] === "PostCompact");
    expect(pre).toBeDefined();
    expect((pre?.[3] as { reason: string }).reason).toBe("manual");
    expect(typeof (pre?.[3] as { tokenEstimate: number }).tokenEstimate).toBe("number");

    expect(post).toBeDefined();
    const postPayload = post?.[3] as {
      messagesBefore: number; messagesAfter: number; tokensBefore: number; tokensAfter: number;
    };
    expect(postPayload.messagesBefore).toBe(4);
    expect(typeof postPayload.messagesAfter).toBe("number");
    expect(typeof postPayload.tokensBefore).toBe("number");
    expect(typeof postPayload.tokensAfter).toBe("number");
  });

  it("a NOOP compact fires PreCompact but NOT PostCompact (no mutation applied)", async () => {
    const small: GenericMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const mgr = stubManager();
    const loop = new ConversationLoop(
      makeDeps({ memoryManager: makeMemoryManager(small), scriptHookManager: mgr as never }),
    );
    loop.resetAndResume("sess-1");
    (loop as unknown as { provider: ReturnType<typeof makeProviderStub> }).provider = makeProviderStub();

    vi.mocked(compactWithBoundary).mockResolvedValueOnce({
      status: CompressionStatus.NOOP,
      boundary: null,
      newHistory: small,
      removedCount: 0,
      estimatedAfter: 0,
      truncatedCount: 0,
    });

    await loop.manualCompact();

    expect(mgr.runLifecycleEvent.mock.calls.some((c) => c[0] === "PreCompact")).toBe(true);
    expect(mgr.runLifecycleEvent.mock.calls.some((c) => c[0] === "PostCompact")).toBe(false);
  });
});
