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

  // Regression: the user's 중단 button must unblock a pending question
  // immediately. Before this, the gate sat on its 5-minute timer even after
  // the conversation loop had aborted, and the abort button felt dead.
  it("aborts immediately when the abortSignal fires and notifies the renderer", async () => {
    const wc = makeMockWebContents();
    const gate = new AskUserQuestionGate(wc as never, 60_000);
    const ac = new AbortController();
    const promise = gate.ask({ question: "blocking?", abortSignal: ac.signal });
    expect(gate.pendingCount).toBe(1);

    ac.abort();
    const response = await promise;
    expect(response.dismissed).toBe(true);
    expect(gate.pendingCount).toBe(0);

    // Renderer must be told the card is gone, same channel as the timeout
    // path, so the inline card disappears even if the user never clicked.
    const timeoutCall = wc.send.mock.calls.find(
      (call) => call[0] === IPC_ASK_USER_QUESTION_TIMEOUT,
    );
    expect(timeoutCall).toBeDefined();
    expect(timeoutCall![1]).toMatchObject({ requestId: response.requestId });
  });

  // Regression for the LOW from PR #287's review: a long-lived
  // AbortController reused across several sequential asks must not leak an
  // abort listener every time the user resolves a question via IPC.
  it("removes the abort listener when the user resolves via IPC (no leak across sequential asks)", async () => {
    const wc = makeMockWebContents();
    const gate = new AskUserQuestionGate(wc as never, 60_000);
    const ac = new AbortController();
    const removeSpy = vi.spyOn(ac.signal, "removeEventListener");

    const slot = gate.ask({ question: "first?", abortSignal: ac.signal });
    // Find the request id that was sent to the renderer.
    const reqCall = wc.send.mock.calls.find(
      (c) => c[0] === "lvis:ask-user-question:request",
    );
    const requestId = (reqCall![1] as { id: string }).id;

    // User clicks an option — this is what `ipcMain.handle("lvis:ask-user-question:respond")` calls.
    gate.resolve({ requestId, choice: "yes" });
    const response = await slot;
    expect(response.choice).toBe("yes");

    // The listener registered on the controller's signal must have been cleaned up,
    // so a later abort on the same controller does not invoke a stale handler.
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(gate.pendingCount).toBe(0);
  });

  it("returns immediately as dismissed when called with an already-aborted signal", async () => {
    const wc = makeMockWebContents();
    const gate = new AskUserQuestionGate(wc as never, 60_000);
    const ac = new AbortController();
    ac.abort();

    const response = await gate.ask({ question: "stale", abortSignal: ac.signal });
    expect(response.dismissed).toBe(true);
    // Never registered as pending, so the request event never fires.
    expect(gate.pendingCount).toBe(0);
    expect(wc.send).not.toHaveBeenCalled();
  });

  // Dev-mode reload destroys the boot-time webContents. A lazy resolver lets
  // the gate keep working against the current window after reload.
  it("uses the lazy resolver every send so a fresh webContents is picked up after reload", async () => {
    const stale = makeMockWebContents();
    stale.isDestroyed.mockReturnValue(true);
    const fresh = makeMockWebContents();
    let current = stale;

    const gate = new AskUserQuestionGate(() => (current.isDestroyed() ? null : (current as never)), 60_000);

    // Stale window: gate must short-circuit to dismissed.
    const dismissed = await gate.ask({ question: "before reload" });
    expect(dismissed.dismissed).toBe(true);
    expect(stale.send).not.toHaveBeenCalled();

    // Simulate a reload — fresh webContents is now current.
    current = fresh;
    const slot = gate.ask({ question: "after reload" });
    expect(fresh.send).toHaveBeenCalledWith(
      "lvis:ask-user-question:request",
      expect.objectContaining({ question: "after reload" }),
    );
    gate.disposeAll();
    await slot;
  });
});
