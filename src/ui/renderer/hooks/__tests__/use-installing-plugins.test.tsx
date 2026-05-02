/**
 * useInstallingPlugins — unit tests
 *
 * Verifies the Set<string> lifecycle driven by onPluginInstallProgress
 * and onPluginInstallResult IPC events, plus cleanup on unmount.
 */
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useInstallingPlugins } from "../use-installing-plugins.js";
import type { LvisApi } from "../../types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function noop() {
  return () => {};
}

type ProgressPayload =
  | { slug: string; phase: "installing" | "restarting" | "verifying" | "registering" }
  | { slug: string; phase: "downloading"; bytesDownloaded: number; bytesTotal: number | null };

type ResultPayload = { slug: string; success: boolean; error?: string };

interface FakeHandlers {
  progress: (payload: ProgressPayload) => void;
  result: (payload: ResultPayload) => void;
}

function makeApi(handlers: Partial<FakeHandlers> = {}): { api: LvisApi; emit: FakeHandlers } {
  let capturedProgress: ((p: ProgressPayload) => void) | null = null;
  let capturedResult: ((p: ResultPayload) => void) | null = null;

  const api = {
    onPluginInstallProgress: vi.fn((h: (p: ProgressPayload) => void) => {
      capturedProgress = h;
      return noop();
    }),
    onPluginInstallResult: vi.fn((h: (p: ResultPayload) => void) => {
      capturedResult = h;
      return noop();
    }),
    ...handlers,
  } as unknown as LvisApi;

  const emit: FakeHandlers = {
    progress: (p) => capturedProgress?.(p),
    result: (p) => capturedResult?.(p),
  };

  return { api, emit };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("useInstallingPlugins — initial state", () => {
  it("returns an empty Set on mount", () => {
    const { api } = makeApi();
    const { result } = renderHook(() => useInstallingPlugins(api));
    expect(result.current.size).toBe(0);
  });
});

describe("useInstallingPlugins — install-progress adds pluginId", () => {
  it("adds the slug when an install-progress event fires", () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useInstallingPlugins(api));

    act(() => {
      emit.progress({ slug: "agent-hub", phase: "installing" });
    });

    expect(result.current.has("agent-hub")).toBe(true);
    expect(result.current.size).toBe(1);
  });
});

describe("useInstallingPlugins — install-result removes pluginId", () => {
  it("removes the slug when an install-result event fires (success)", () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useInstallingPlugins(api));

    act(() => {
      emit.progress({ slug: "agent-hub", phase: "installing" });
    });
    expect(result.current.has("agent-hub")).toBe(true);

    act(() => {
      emit.result({ slug: "agent-hub", success: true });
    });
    expect(result.current.has("agent-hub")).toBe(false);
    expect(result.current.size).toBe(0);
  });

  it("removes the slug when an install-result event fires (failure)", () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useInstallingPlugins(api));

    act(() => {
      emit.progress({ slug: "meeting", phase: "installing" });
    });
    act(() => {
      emit.result({ slug: "meeting", success: false, error: "network error" });
    });

    expect(result.current.has("meeting")).toBe(false);
  });
});

describe("useInstallingPlugins — duplicate add", () => {
  it("holds only one entry when the same pluginId is added twice", () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useInstallingPlugins(api));

    act(() => {
      emit.progress({ slug: "agent-hub", phase: "installing" });
    });
    act(() => {
      emit.progress({ slug: "agent-hub", phase: "restarting" });
    });

    expect(result.current.size).toBe(1);
    expect(result.current.has("agent-hub")).toBe(true);
  });
});

describe("useInstallingPlugins — simultaneous installs", () => {
  it("holds all slugs when multiple plugins are installing concurrently", () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useInstallingPlugins(api));

    act(() => {
      emit.progress({ slug: "agent-hub", phase: "installing" });
      emit.progress({ slug: "meeting", phase: "downloading", bytesDownloaded: 1000, bytesTotal: null });
      emit.progress({ slug: "pageindex", phase: "verifying" });
    });

    expect(result.current.size).toBe(3);
    expect(result.current.has("agent-hub")).toBe(true);
    expect(result.current.has("meeting")).toBe(true);
    expect(result.current.has("pageindex")).toBe(true);
  });

  it("removes only the completed slug when one of multiple concurrent installs finishes", () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useInstallingPlugins(api));

    act(() => {
      emit.progress({ slug: "agent-hub", phase: "installing" });
      emit.progress({ slug: "meeting", phase: "installing" });
    });

    act(() => {
      emit.result({ slug: "agent-hub", success: true });
    });

    expect(result.current.has("agent-hub")).toBe(false);
    expect(result.current.has("meeting")).toBe(true);
    expect(result.current.size).toBe(1);
  });
});

describe("useInstallingPlugins — cleanup on unmount", () => {
  it("calls unsubscribe for both event handlers when the hook unmounts", () => {
    const unsubProgress = vi.fn();
    const unsubResult = vi.fn();

    const api = {
      onPluginInstallProgress: vi.fn(() => unsubProgress),
      onPluginInstallResult: vi.fn(() => unsubResult),
    } as unknown as LvisApi;

    const { unmount } = renderHook(() => useInstallingPlugins(api));

    expect(unsubProgress).not.toHaveBeenCalled();
    expect(unsubResult).not.toHaveBeenCalled();

    unmount();

    expect(unsubProgress).toHaveBeenCalledOnce();
    expect(unsubResult).toHaveBeenCalledOnce();
  });
});
