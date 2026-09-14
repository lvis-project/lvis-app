import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonRpcPendingRequests } from "../json-rpc-pending-request.js";

afterEach(() => vi.useRealTimers());

describe("pending RPC lifecycle", () => {
  it("settles out of order and clears every response timer", async () => {
    vi.useFakeTimers();
    const pending = new JsonRpcPendingRequests();
    const options = { method: "read", timeoutMs: 100, unrefTimer: true, timeoutError: () => new Error("timeout") };
    expect(pending.nextRequestId).toBe(1);
    const first = pending.begin(options);
    const second = pending.begin({ ...options, method: "write" });
    const reply = pending.take(second.id);
    expect(reply?.method).toBe("write");
    reply?.resolve(2);
    pending.take(first.id)?.resolve(1);
    await expect(first.promise).resolves.toBe(1);
    await expect(second.promise).resolves.toBe(2);
    expect(pending.take(first.id)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allocates an untracked request ID without reusing it", () => {
    const pending = new JsonRpcPendingRequests();
    expect(pending.allocateId()).toBe(1);
    expect(pending.nextRequestId).toBe(2);
    expect(pending.take(1)).toBeUndefined();
    const tracked = pending.begin({
      method: "next",
      timeoutMs: 100,
      unrefTimer: true,
      timeoutError: () => new Error("timeout"),
    });
    expect(tracked.id).toBe(2);
    pending.take(tracked.id)?.resolve(null);
  });

  it("rejects an expired request before applying owner closure to the rest", async () => {
    vi.useFakeTimers();
    const pending = new JsonRpcPendingRequests();
    const error = new Error("closed");
    const onTimeout = vi.fn(() => pending.rejectAll(error));
    const first = pending.begin({ method: "one", timeoutMs: 10, unrefTimer: false, timeoutError: () => error, onTimeout });
    const second = pending.begin({ method: "two", timeoutMs: 100, unrefTimer: true, timeoutError: () => error });
    const firstCheck = expect(first.promise).rejects.toBe(error);
    const secondCheck = expect(second.promise).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all([firstCheck, secondCheck]);
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(pending.take(first.id)).toBeUndefined();
    expect(pending.nextRequestId).toBe(3);
  });

  it("can expire only one request without closing an unrelated request", async () => {
    vi.useFakeTimers();
    const pending = new JsonRpcPendingRequests();
    const options = { method: "prompt", timeoutMs: 10, unrefTimer: true, timeoutError: () => new Error("prompt expired") };
    const first = pending.begin(options);
    const second = pending.begin({ ...options, timeoutMs: 100 });
    const check = expect(first.promise).rejects.toThrow("prompt expired");
    await vi.advanceTimersByTimeAsync(10);
    await check;
    expect(pending.take(first.id)).toBeUndefined();
    pending.take(second.id)?.resolve("ready");
    await expect(second.promise).resolves.toBe("ready");
    expect(vi.getTimerCount()).toBe(0);
  });
});
