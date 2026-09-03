/**
 * Phase 2d FU — useBootstrapStatus hook.
 *
 * Verifies the renderer subscription contract: a `start` event flips
 * `installing` true; a `complete` or `error` event flips it back; the
 * hook never auto-clears (renderer dismiss is the only way to clear).
 *
 * Plus the cold-boot pull: the host finishes the whole status sequence before
 * this renderer loads, so the hook reads the recorded snapshot on mount. A
 * live event outranks that snapshot no matter which resolves first.
 */
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useBootstrapStatus } from "../use-bootstrap-status.js";
import type { LvisApi } from "../../types.js";
import { makeMockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";

function bootstrapStatusApi() {
  const { api, emitBootstrapStatus } = makeMockLvisApi();
  return {
    api: api as unknown as LvisApi,
    retryBootstrap: api.retryBootstrap as ReturnType<typeof vi.fn>,
    getBootstrapStatus: api.getBootstrapStatus as ReturnType<typeof vi.fn>,
    emit: (s: Parameters<LvisApi["onBootstrapStatus"]>[0] extends (status: infer S) => void ? S : never) =>
      emitBootstrapStatus(s),
  };
}

describe("useBootstrapStatus", () => {
  it("starts with no status and installing=false", () => {
    const { api } = bootstrapStatusApi();
    const { result } = renderHook(() => useBootstrapStatus(api));
    expect(result.current.status).toBeNull();
    expect(result.current.installing).toBe(false);
  });

  it("`start` event flips installing true and exposes the event", () => {
    const { api, emit } = bootstrapStatusApi();
    const { result } = renderHook(() => useBootstrapStatus(api));
    act(() => emit({ phase: "start" }));
    expect(result.current.status).toEqual({ phase: "start" });
    expect(result.current.installing).toBe(true);
  });

  it("`complete` event resets installing and surfaces failed list", () => {
    const { api, emit } = bootstrapStatusApi();
    const { result } = renderHook(() => useBootstrapStatus(api));
    act(() => emit({ phase: "start" }));
    act(() =>
      emit({
        phase: "complete",
        installed: ["calendar"],
        failed: [{ id: "meeting", error: "tarball unreachable" }],
      }),
    );
    expect(result.current.installing).toBe(false);
    expect(result.current.status).toMatchObject({
      phase: "complete",
      installed: ["calendar"],
      failed: [{ id: "meeting", error: "tarball unreachable" }],
    });
  });

  it("`error` event resets installing and exposes the host message", () => {
    const { api, emit } = bootstrapStatusApi();
    const { result } = renderHook(() => useBootstrapStatus(api));
    act(() => emit({ phase: "error", message: "catalog fetch failed" }));
    expect(result.current.installing).toBe(false);
    expect(result.current.status).toEqual({ phase: "error", message: "catalog fetch failed" });
  });

  it("dismiss clears status without re-subscribing", () => {
    const { api, emit } = bootstrapStatusApi();
    const { result } = renderHook(() => useBootstrapStatus(api));
    act(() => emit({ phase: "error", message: "x" }));
    expect(result.current.status).not.toBeNull();
    act(() => result.current.dismiss());
    expect(result.current.status).toBeNull();
  });

  it("retry calls api.retryBootstrap and lets host status events drive updates", async () => {
    const { api, retryBootstrap, emit } = bootstrapStatusApi();
    const { result } = renderHook(() => useBootstrapStatus(api));
    act(() => emit({ phase: "error", message: "catalog down" }));
    expect(result.current.status).toMatchObject({ phase: "error" });

    await act(async () => {
      await result.current.retry();
    });
    expect(retryBootstrap).toHaveBeenCalledTimes(1);
    // The host re-emits the lifecycle around `runManagedBootstrap`. Hook must
    // not synthesise its own state — it stays on the last received event
    // until the next emit lands.
    expect(result.current.status).toMatchObject({ phase: "error" });

    act(() => emit({ phase: "complete", installed: ["calendar"], failed: [] }));
    expect(result.current.status).toMatchObject({ phase: "complete", installed: ["calendar"] });
  });

  it("applies the host snapshot on mount when no live event arrives", async () => {
    const { api, getBootstrapStatus } = bootstrapStatusApi();
    getBootstrapStatus.mockResolvedValueOnce({
      phase: "complete",
      installed: [],
      failed: [{ id: "meeting", error: "marketplace unreachable" }],
    });
    const { result } = renderHook(() => useBootstrapStatus(api));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.installing).toBe(false);
    expect(result.current.status).toMatchObject({
      phase: "complete",
      failed: [{ id: "meeting", error: "marketplace unreachable" }],
    });
  });

  it("keeps a live event that arrived while the snapshot was still in flight", async () => {
    const { api, getBootstrapStatus, emit } = bootstrapStatusApi();
    let resolveSnapshot: (s: unknown) => void = () => {};
    getBootstrapStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      }),
    );
    const { result } = renderHook(() => useBootstrapStatus(api));
    act(() => emit({ phase: "start" }));
    expect(result.current.status).toEqual({ phase: "start" });

    // The stale snapshot lands after the event. It must not overwrite it.
    await act(async () => {
      resolveSnapshot({ phase: "complete", installed: ["calendar"], failed: [] });
      await Promise.resolve();
    });
    expect(result.current.status).toEqual({ phase: "start" });
    expect(result.current.installing).toBe(true);
  });

  it("leaves status null when the host has recorded no snapshot", async () => {
    const { api, getBootstrapStatus } = bootstrapStatusApi();
    getBootstrapStatus.mockResolvedValueOnce(null);
    const { result } = renderHook(() => useBootstrapStatus(api));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.status).toBeNull();
    expect(result.current.installing).toBe(false);
  });

  it("retry swallows api errors so the banner never throws", async () => {
    const { api, retryBootstrap } = bootstrapStatusApi();
    retryBootstrap.mockRejectedValueOnce(new Error("ipc closed"));
    const { result } = renderHook(() => useBootstrapStatus(api));
    await act(async () => {
      await expect(result.current.retry()).resolves.toBeUndefined();
    });
  });
});
