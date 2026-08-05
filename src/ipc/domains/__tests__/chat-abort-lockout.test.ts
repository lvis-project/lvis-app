/**
 * The owner's Stop, while the conversation's one turn is parked on an approval
 * nobody is going to answer.
 *
 * This composes the two real ends of that path — the shared
 * `ConversationActivityCoordinator` lease and a real `ApprovalGate` — around
 * the real `lvis:chat:abort` handler, and stands in for the layers between
 * them (`runTurn` -> `queryLoop` -> the executor) with a promise that settles
 * only when the gate does. Those layers are traversal, not decision: the
 * relationship the test depends on is that the turn's `AbortController` is the
 * one whose signal reaches the gate, which is how `runTurn` builds it.
 *
 * Nothing here is specific to a remote turn. The remote case is what makes an
 * unanswerable approval ordinary rather than hypothetical — the desk sees a
 * modal for work it did not start — but a desk turn parked on the same gate
 * locks the same way, and the fix is not conditioned on origin.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WebContents } from "electron";
import { CHANNELS } from "../../../contract/app-contract.js";
import {
  invokeRegisteredHandler,
  makeMockWebContents,
} from "../../../__tests__/test-helpers.js";
import { createConversationSurfaceRuntime } from "../../../engine/conversation-surface-runtime.js";
import { ApprovalGate } from "../../../permissions/approval-gate.js";
import { fakeLlmSettings } from "../../../shared/__tests__/fake-llm-settings.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

/** How long the probe below waits before calling the Stop blocked. */
const STOP_PROBE_WINDOW_MS = 60_000;

type StopProbe = "stopped" | "still-blocked";

describe("lvis:chat:abort with a turn parked on an approval", () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function parkedTurnWithStopHandler(): Promise<{
    runtime: ReturnType<typeof createConversationSurfaceRuntime>;
    approvalWindow: ReturnType<typeof makeMockWebContents>;
    approval: Promise<{ choice: string }>;
    abortCurrentTurn: ReturnType<typeof vi.fn>;
  }> {
    const runtime = createConversationSurfaceRuntime();
    const approvalWindow = makeMockWebContents();
    const gate = new ApprovalGate(approvalWindow as unknown as WebContents);
    const turnAbortController = new AbortController();
    const abortCurrentTurn = vi.fn(() => {
      turnAbortController.abort(new Error("user cancelled turn"));
    });
    const conversationLoop = {
      getSessionId: () => "conv-parked",
      getSessionKind: () => "main",
      hasProvider: () => true,
      abortCurrentTurn,
      getHistory: () => ({ length: 0, getMessages: () => [] }),
    };

    const approval = gate.requestAndWait({
      id: "parked-1",
      category: "tool",
      toolName: "fs_write",
      toolCategory: "write",
      sessionId: "conv-parked",
      args: { path: "/srv/report.md", content: "hello" },
      reason: "write outside the workspace",
      source: "builtin",
      createdAt: Date.now(),
      isReadOnly: false,
      remoteControllerOrigin: "platform-bridge",
      abortSignal: turnAbortController.signal,
    });
    // The turn holds the conversation's one execution lease for as long as the
    // approval is unanswered — the executor is inside `requestAndWait`.
    const lease = runtime.activity.tryTrackTurn(async () => {
      await approval;
      return "turn-settled" as const;
    });
    expect(lease).not.toBeNull();

    const { registerChatHandlers } = await import("../chat.js");
    registerChatHandlers({
      conversationLoop,
      conversationSurfaceRuntime: runtime,
      settingsService: {
        get: vi.fn((key?: string) =>
          key === "llm" ? fakeLlmSettings() : {},
        ),
        patch: vi.fn(async () => undefined),
      },
      memoryManager: {
        loadMainActiveSessionState: vi.fn(() => null),
        markMainActiveFresh: vi.fn(async () => undefined),
        saveSessionMetadata: vi.fn(async () => undefined),
      },
      auditLogger: { log: vi.fn() },
      getMainWindow: vi.fn(() => null),
    } as unknown as Parameters<typeof registerChatHandlers>[0]);

    return { runtime, approvalWindow, approval, abortCurrentTurn };
  }

  it("completes the Stop and frees the conversation for the owner", async () => {
    const { runtime, approvalWindow, approval, abortCurrentTurn } =
      await parkedTurnWithStopHandler();

    // The state the owner is actually in: the modal is up, the turn owns the
    // lease, and anything the owner starts is refused while it does.
    expect(approvalWindow.send).toHaveBeenCalledTimes(1);
    expect(runtime.activity.isBusy()).toBe(true);
    expect(runtime.activity.tryTrackTurn(async () => "owner-send")).toBeNull();

    const stop = Promise.resolve(
      invokeRegisteredHandler<Promise<{ ok: boolean }>>(
        handlers,
        CHANNELS.chat.abort,
      ),
    );
    // A bound the Stop must beat. The gate's own wait is five minutes, so a
    // Stop that only "completes" because that timer fired fails here.
    const probe = Promise.race<StopProbe>([
      stop.then(() => "stopped" as const),
      new Promise<StopProbe>((resolve) => {
        setTimeout(() => resolve("still-blocked"), STOP_PROBE_WINDOW_MS);
      }),
    ]);
    await vi.advanceTimersByTimeAsync(STOP_PROBE_WINDOW_MS);

    expect(await probe).toBe("stopped");
    expect(await stop).toEqual({ ok: true });
    expect(abortCurrentTurn).toHaveBeenCalledTimes(1);
    // The approval the turn was parked on answered fail-closed, and the lease
    // it held is back, so the owner's next send is accepted rather than
    // refused with `streaming-active`.
    await expect(approval).resolves.toMatchObject({ choice: "deny-once" });
    expect(runtime.activity.isBusy()).toBe(false);
    expect(runtime.activity.tryTrackTurn(async () => "owner-send")).not.toBeNull();
  });
});
