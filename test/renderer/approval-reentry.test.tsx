/**
 * Regression net for approval FIFO re-entrancy.
 *
 * Rapid double-invocation of decide() must only dispatch one IPC respond
 * call for the current in-flight approval. The pending head remains visible
 * until that response is acknowledged, so the next item is never surfaced as
 * an inert dialog.
 */
import "./setup.js";
import { useLayoutEffect } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render, renderHook, waitFor } from "@testing-library/react";
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
  const listPending = vi.fn(async () => [] as unknown[]);
  const ns = { approval: { onRequest, respond, listPending }, permission: {}, policy: {} };
  vi.stubGlobal("lvis", ns);
  (window as unknown as { lvis: unknown }).lvis = ns;
  return {
    emit: (r: unknown) => handlers.forEach((h) => h(r)),
    respond,
    listPending,
    drainOne: () => resolvers.shift()?.({ ok: true }),
    drainAll: () => {
      for (const resolve of resolvers.splice(0)) {
        resolve({ ok: true });
      }
    },
  };
}

describe("useApproval — Copilot HIGH #2 re-entrancy", () => {
  it("responds to a request that becomes interactive before passive effects", async () => {
    const { emit, respond, drainAll } = installMockNs();

    function ImmediateDecisionHarness() {
      const { queue, decide } = useApproval();
      // Browser input can arrive as soon as the dialog has been committed,
      // before passive effects. Model that boundary directly: this layout
      // effect runs after the queue has rendered but before paint.
      useLayoutEffect(() => {
        if (queue[0]?.id === "req-layout") {
          void decide("allow-once");
        }
      }, [queue, decide]);
      return null;
    }

    render(<ImmediateDecisionHarness />);

    act(() => {
      emit({
        id: "req-layout",
        category: "tool",
        toolName: "read_file",
        args: {},
        reason: "r",
        createdAt: 0,
        requireExplicit: false,
        nonce: "nonce-layout",
        hmac: "hmac-layout",
      });
    });

    await waitFor(() => {
      expect(respond).toHaveBeenCalledTimes(1);
    });
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-layout",
        choice: "allow-once",
        nonce: "nonce-layout",
        hmac: "hmac-layout",
      }),
    );

    await act(async () => {
      drainAll();
    });
  });

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
    // must early-return while req-1 remains the visible, in-flight head.
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0]?.[0]).toMatchObject({ requestId: "req-1" });
    expect(result.current.queue.map((request) => request.id)).toEqual(["req-1", "req-2"]);

    // Drain the in-flight promise; both awaited calls resolve.
    await act(async () => {
      drainOne();
      await first;
      await second;
    });

    expect(result.current.queue.map((request) => request.id)).toEqual(["req-2"]);

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

  it("sequential decide echoes nonce and hmac for each queued request", async () => {
    const { emit, respond, drainOne } = installMockNs();
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

    let first!: Promise<void>;
    act(() => {
      first = result.current.decide("allow-once");
    });

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0]?.[0]).toMatchObject({
      requestId: "req-1",
      choice: "allow-once",
      nonce: "nonce-1",
      hmac: "hmac-1",
    });

    await act(async () => {
      drainOne();
      await first;
    });

    let second!: Promise<void>;
    act(() => {
      second = result.current.decide("allow-once");
    });

    expect(respond).toHaveBeenCalledTimes(2);
    expect(respond.mock.calls[1]?.[0]).toMatchObject({
      requestId: "req-2",
      choice: "allow-once",
      nonce: "nonce-2",
      hmac: "hmac-2",
    });

    await act(async () => {
      drainOne();
      await second;
    });
  });
});

describe("useApproval — requests parked before this renderer mounted", () => {
  it("seeds the queue from listPending, oldest first, without duplicating a request that also arrived live", async () => {
    const { emit, listPending } = installMockNs();
    listPending.mockResolvedValueOnce([
      { id: "parked-1", category: "tool", toolName: "read_file", args: {}, reason: "r", createdAt: 1, requireExplicit: false },
      { id: "live-1", category: "tool", toolName: "list_files", args: {}, reason: "r", createdAt: 2, requireExplicit: false },
    ]);
    const { result } = renderHook(() => useApproval());
    // A request that went out between the subscribe and the fetch arrives both ways.
    act(() => {
      emit({ id: "live-1", category: "tool", toolName: "list_files", args: {}, reason: "r", createdAt: 2, requireExplicit: false });
    });
    await waitFor(() => expect(result.current.queue.map((req) => req.id)).toEqual(["parked-1", "live-1"]));
    expect(listPending).toHaveBeenCalledTimes(1);
  });

  it("dropSettled forgets settled requests but keeps the head whose answer is still in flight", async () => {
    const { emit, respond, drainAll } = installMockNs();
    const { result } = renderHook(() => useApproval());
    act(() => {
      emit({ id: "req-1", category: "tool", toolName: "read_file", args: {}, reason: "r", createdAt: 1, requireExplicit: false, nonce: "n1", hmac: "h1" });
      emit({ id: "req-2", category: "tool", toolName: "list_files", args: {}, reason: "r", createdAt: 2, requireExplicit: false, nonce: "n2", hmac: "h2" });
      emit({ id: "req-3", category: "tool", toolName: "bash_run", args: {}, reason: "r", createdAt: 3, requireExplicit: false, nonce: "n3", hmac: "h3" });
    });
    await waitFor(() => expect(result.current.queue).toHaveLength(3));

    let deciding!: Promise<void>;
    act(() => {
      deciding = result.current.decide("allow-once");
    });
    expect(respond).toHaveBeenCalledTimes(1);

    // The head is being acknowledged: dropping it would make the pending
    // positional shift remove req-2 instead. Only req-3 goes.
    act(() => {
      result.current.dropSettled(["req-1", "req-3"]);
    });
    expect(result.current.queue.map((req) => req.id)).toEqual(["req-1", "req-2"]);

    await act(async () => {
      drainAll();
      await deciding;
    });
    expect(result.current.queue.map((req) => req.id)).toEqual(["req-2"]);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
