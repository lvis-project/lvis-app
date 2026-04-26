/**
 * AskUserQuestionGate — H5 / M2 timeout coverage.
 *
 * The gate must:
 *   1. Resolve `{ dismissed: true }` after the configured timeout.
 *   2. Send a `lvis:ask-user-question:timeout` IPC event so the renderer
 *      can drop the stale card before the user clicks into a no-op.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  AskUserQuestionGate,
  IPC_ASK_USER_QUESTION_TIMEOUT,
} from "../ask-user-question-gate.js";

function makeMockWebContents() {
  return {
    send: vi.fn(),
    isDestroyed: vi.fn(() => false),
  };
}

describe("AskUserQuestionGate — timeout path", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with dismissed=true after 5 minutes and emits timeout event", async () => {
    const wc = makeMockWebContents();
    const gate = new AskUserQuestionGate(wc as never, 5 * 60 * 1000);
    const promise = gate.ask({ question: "still there?" });
    // Drain the request emission tick first.
    expect(wc.send).toHaveBeenCalledWith(
      "lvis:ask-user-question:request",
      expect.objectContaining({ question: "still there?" }),
    );

    // Fast-forward past the 5-minute timeout.
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    const response = await promise;
    expect(response.dismissed).toBe(true);

    // M2: renderer must be notified via the dedicated timeout channel.
    const timeoutCall = wc.send.mock.calls.find(
      (call) => call[0] === IPC_ASK_USER_QUESTION_TIMEOUT,
    );
    expect(timeoutCall).toBeDefined();
    expect(timeoutCall![1]).toMatchObject({ requestId: response.requestId });
  });

  it("caps concurrent pending requests to 5 (H3)", async () => {
    const wc = makeMockWebContents();
    const gate = new AskUserQuestionGate(wc as never, 60_000);
    const slots: Array<Promise<unknown>> = [];
    // Fill the gate up to the cap.
    for (let i = 0; i < 5; i++) {
      slots.push(gate.ask({ question: `q-${i}` }));
    }
    expect(gate.pendingCount).toBe(5);
    // The 6th must be dismissed immediately, not queued.
    const overflow = await gate.ask({ question: "q-6" });
    expect(overflow.dismissed).toBe(true);
    // Pending count unchanged — the overflow never registered.
    expect(gate.pendingCount).toBe(5);
    // Cleanup so unrelated timers don't leak.
    gate.disposeAll();
    await Promise.allSettled(slots);
  });
});
