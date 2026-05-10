/**
 * Regression net for Copilot HIGH #2 — useApproval re-entrancy guard.
 *
 * Rapid double-invocation of decide() must only dispatch one IPC respond
 * call for the current in-flight approval. Without the inFlightRef guard,
 * the second call would shift() an already-shifted queue and silently drop
 * the follow-up pending item.
 */
import "./setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useApproval } from "../../src/ui/renderer/hooks/use-approval.js";

type ApprovalHandler = (r: unknown) => void;

function installMockNs() {
  const handlers = new Set<ApprovalHandler>();
  const resolvers: Array<(v: unknown) => void> = [];
  const respond = vi.fn(
    () =>
      new Promise((res) => {
        resolvers.push(res);
      }),
  );
  const onRequest = vi.fn((cb: ApprovalHandler) => {
    handlers.add(cb);
    return () => handlers.delete(cb);
  });
  const ns = { approval: { onRequest, respond }, permission: {}, policy: {} };
  vi.stubGlobal("lvis", ns);
  (window as unknown as { lvis: unknown }).lvis = ns;
  return {
    emit: (r: unknown) => handlers.forEach((h) => h(r)),
    respond,
    drainOne: () => resolvers.shift()?.({ ok: true }),
    drainAll: () => {
      for (const resolve of resolvers.splice(0)) {
        resolve({ ok: true });
      }
    },
  };
}

describe("useApproval — Copilot HIGH #2 re-entrancy", () => {
  it("rapid double decide() only dispatches one respond() for the current item", async () => {
    const { emit, respond, drainOne } = installMockNs();
    const { result } = renderHook(() => useApproval());

    act(() => {
      emit({
        id: "req-1",
        category: "tool",
        toolName: "t",
        args: {},
        reason: "r",
        createdAt: 0,
        requireExplicit: false,
      });
      emit({
        id: "req-2",
        category: "tool",
        toolName: "t",
        args: {},
        reason: "r",
        createdAt: 0,
        requireExplicit: false,
      });
    });

    expect(result.current.queue.length).toBe(2);

    // Rapid double-click — both calls fire before respond() resolves.
    // Fire-and-forget; we assert synchronously before awaiting.
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.decide("allow-once");
      second = result.current.decide("allow-once");
    });

    // Only one respond should have been issued for req-1 — the second decide
    // should have early-returned from the inFlightRef guard.
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0]?.[0]).toMatchObject({ requestId: "req-1" });

    // Drain the in-flight promise; both awaited calls resolve.
    await act(async () => {
      drainOne();
      await first;
      await second;
    });

    // The next decide should now go through for req-2 (not dropped).
    let third!: Promise<void>;
    act(() => {
      third = result.current.decide("allow-once");
    });
    expect(respond).toHaveBeenCalledTimes(2);
    expect(respond.mock.calls[1]?.[0]).toMatchObject({ requestId: "req-2" });
    await act(async () => {
      drainOne();
      await third;
    });
  });

  it("bulk decide echoes nonce and hmac for every queued request", async () => {
    const { emit, respond, drainAll } = installMockNs();
    const { result } = renderHook(() => useApproval());

    act(() => {
      emit({
        id: "req-1",
        category: "tool",
        toolName: "read_file",
        args: {},
        reason: "r",
        createdAt: 0,
        requireExplicit: false,
        nonce: "nonce-1",
        hmac: "hmac-1",
      });
      emit({
        id: "req-2",
        category: "tool",
        toolName: "write_file",
        args: {},
        reason: "r",
        createdAt: 0,
        requireExplicit: false,
        nonce: "nonce-2",
        hmac: "hmac-2",
      });
    });

    let bulk!: Promise<void>;
    act(() => {
      bulk = result.current.decideAll("allow-once");
    });

    expect(respond).toHaveBeenCalledTimes(2);
    expect(respond.mock.calls[0]?.[0]).toMatchObject({
      requestId: "req-1",
      choice: "allow-once",
      nonce: "nonce-1",
      hmac: "hmac-1",
    });
    expect(respond.mock.calls[1]?.[0]).toMatchObject({
      requestId: "req-2",
      choice: "allow-once",
      nonce: "nonce-2",
      hmac: "hmac-2",
    });

    await act(async () => {
      drainAll();
      await bulk;
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
