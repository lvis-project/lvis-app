/**
 * App update hook regression tests.
 *
 * The initial `getAppUpdateState()` snapshot is a catch-up path for late
 * mounts, not an authority over live pushes. If an app-update event lands
 * while another renderer event burst is being processed, a stale initial
 * snapshot must not erase the update badge.
 */
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, it, expect, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useAppUpdate } from "../use-app-update.js";
import type { LvisApi } from "../../types.js";
import type { UpdateState } from "../../../../shared/update-state.js";
import { deferred } from "../../../../../test/renderer/helpers.js";

function appUpdateApi(
  initialState: Promise<UpdateState>,
  overrides: {
    downloadAppUpdate?: () => Promise<{ ok: boolean; reason?: string }>;
    installAppUpdate?: () => Promise<{ ok: boolean; reason?: string }>;
  } = {},
) {
  let handler: ((state: UpdateState) => void) | null = null;
  const api = {
    onAppUpdateState: vi.fn((h: (state: UpdateState) => void) => {
      handler = h;
      return () => {
        handler = null;
      };
    }),
    getAppUpdateState: vi.fn(() => initialState),
    downloadAppUpdate: vi.fn(overrides.downloadAppUpdate ?? (async () => ({ ok: true }))),
    installAppUpdate: vi.fn(overrides.installAppUpdate ?? (async () => ({ ok: true }))),
  };
  return {
    api: api as unknown as LvisApi,
    rawApi: api,
    emit: (state: UpdateState) => {
      if (!handler) throw new Error("app update handler not registered");
      handler(state);
    },
  };
}

describe("useAppUpdate", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies the initial state when no live update push has arrived", async () => {
    const { api } = appUpdateApi(Promise.resolve({ kind: "available", version: "1.2.3" }));
    const { result } = renderHook(() => useAppUpdate(api));

    await waitFor(() => {
      expect(result.current.state).toEqual({ kind: "available", version: "1.2.3" });
    });
  });

  it("does not let a stale initial snapshot erase a live app-update push", async () => {
    const snapshot = deferred<UpdateState>();
    const { api, rawApi, emit } = appUpdateApi(snapshot.promise);
    const { result } = renderHook(() => useAppUpdate(api));

    await waitFor(() => {
      expect(rawApi.onAppUpdateState).toHaveBeenCalledOnce();
    });

    act(() => {
      emit({ kind: "available", version: "2.0.0" });
    });
    expect(result.current.state).toEqual({ kind: "available", version: "2.0.0" });

    await act(async () => {
      snapshot.resolve({ kind: "idle" });
      await snapshot.promise;
    });

    expect(result.current.state).toEqual({ kind: "available", version: "2.0.0" });
  });

  it("keeps the install gate during successful handoff and releases if the app stays alive", async () => {
    vi.useFakeTimers();
    const { api, emit } = appUpdateApi(Promise.resolve({ kind: "idle" }), {
      installAppUpdate: async () => ({ ok: true }),
    });
    const { result } = renderHook(() => useAppUpdate(api));

    act(() => {
      emit({ kind: "downloaded", version: "2.0.0" });
    });

    await act(async () => {
      await result.current.install();
    });

    expect(result.current.inFlight).toBe(true);

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(result.current.inFlight).toBe(false);
  });

  it("releases the click gate when install IPC returns ok=false", async () => {
    const { api, rawApi, emit } = appUpdateApi(Promise.resolve({ kind: "idle" }), {
      installAppUpdate: async () => ({ ok: false, reason: "quit failed" }),
    });
    const { result } = renderHook(() => useAppUpdate(api));

    act(() => {
      emit({ kind: "downloaded", version: "2.0.0" });
    });

    await act(async () => {
      await result.current.install();
    });

    expect(rawApi.installAppUpdate).toHaveBeenCalledOnce();
    expect(result.current.inFlight).toBe(false);
  });
});
