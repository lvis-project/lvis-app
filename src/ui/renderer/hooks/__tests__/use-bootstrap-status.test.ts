/**
 * Phase 2d FU — useBootstrapStatus hook.
 *
 * Verifies the renderer subscription contract: a `start` event flips
 * `installing` true; a `complete` or `error` event flips it back; the
 * hook never auto-clears (renderer dismiss is the only way to clear).
 */
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useBootstrapStatus } from "../use-bootstrap-status.js";
import type { LvisApi } from "../../types.js";

function makeApi() {
  let cb: ((status: Parameters<LvisApi["onBootstrapStatus"]>[0] extends (s: infer S) => void ? S : never) => void) | null = null;
  const retryBootstrap = vi.fn().mockResolvedValue({ ok: true });
  const api = {
    onBootstrapStatus: vi.fn((handler: typeof cb) => {
      cb = handler;
      return () => {
        cb = null;
      };
    }),
    retryBootstrap,
  } as unknown as LvisApi;
  return {
    api,
    retryBootstrap,
    emit: (s: Parameters<NonNullable<typeof cb>>[0]) => cb?.(s),
  };
}

describe("useBootstrapStatus", () => {
  it("starts with no status and installing=false", () => {
    const { api } = makeApi();
    const { result } = renderHook(() => useBootstrapStatus(api));
    expect(result.current.status).toBeNull();
    expect(result.current.installing).toBe(false);
  });

  it("`start` event flips installing true and exposes the event", () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useBootstrapStatus(api));
    act(() => emit({ phase: "start" }));
    expect(result.current.status).toEqual({ phase: "start" });
    expect(result.current.installing).toBe(true);
  });

  it("`complete` event resets installing and surfaces failed list", () => {
    const { api, emit } = makeApi();
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
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useBootstrapStatus(api));
    act(() => emit({ phase: "error", message: "catalog fetch failed" }));
    expect(result.current.installing).toBe(false);
    expect(result.current.status).toEqual({ phase: "error", message: "catalog fetch failed" });
  });

  it("dismiss clears status without re-subscribing", () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useBootstrapStatus(api));
    act(() => emit({ phase: "error", message: "x" }));
    expect(result.current.status).not.toBeNull();
    act(() => result.current.dismiss());
    expect(result.current.status).toBeNull();
  });

  it("retry calls api.retryBootstrap and lets host status events drive updates", async () => {
    const { api, retryBootstrap, emit } = makeApi();
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

  it("retry swallows api errors so the banner never throws", async () => {
    const { api, retryBootstrap } = makeApi();
    retryBootstrap.mockRejectedValueOnce(new Error("ipc closed"));
    const { result } = renderHook(() => useBootstrapStatus(api));
    await act(async () => {
      await expect(result.current.retry()).resolves.toBeUndefined();
    });
  });
});
