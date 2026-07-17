import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithAbortableDeadline } from "../abortable-deadline.js";

describe("runWithAbortableDeadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns deadline promptly and aborts work that ignores the linked signal", async () => {
    let linkedSignal: AbortSignal | undefined;
    const task = vi.fn((signal: AbortSignal) => {
      linkedSignal = signal;
      return new Promise<never>(() => {});
    });
    const pending = runWithAbortableDeadline(task, { deadlineMs: 100 });
    await vi.advanceTimersByTimeAsync(101);

    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("deadline");
      expect(outcome.error.message).toBe("deadline exceeded after 100ms");
    }
    expect(linkedSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps caller abort distinct and preserves its error", async () => {
    const caller = new AbortController();
    let linkedSignal: AbortSignal | undefined;
    const pending = runWithAbortableDeadline(
      async (signal) => {
        linkedSignal = signal;
        return await new Promise<never>(() => {});
      },
      { deadlineMs: 10_000, callerAbortSignal: caller.signal },
    );
    await vi.advanceTimersByTimeAsync(0);
    caller.abort(new Error("caller stopped"));

    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("caller-abort");
      expect(outcome.error.message).toBe("caller stopped");
    }
    expect(linkedSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns ordinary task errors without relabeling them", async () => {
    const outcome = await runWithAbortableDeadline(
      async () => { throw new Error("task failed independently"); },
      { deadlineMs: 10_000 },
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("error");
      expect(outcome.error.message).toBe("task failed independently");
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start work when the caller signal is already aborted", async () => {
    const caller = new AbortController();
    caller.abort(new Error("already stopped"));
    const task = vi.fn(async () => "unreachable");

    const outcome = await runWithAbortableDeadline(task, {
      deadlineMs: 10_000,
      callerAbortSignal: caller.signal,
    });

    expect(task).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      ok: false,
      reason: "caller-abort",
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
