import "../../../../../test/renderer/setup.ts";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { usePluginAuthStatuses } from "../use-plugin-auth-status.js";
import type { LvisApi, PluginCardSummary } from "../../types.js";

function makePlugin(id: string, withAuth: boolean): PluginCardSummary {
  return {
    id,
    name: id,
    description: "",
    sampleTools: [],
    capabilities: [],
    tools: ["foo_status", "foo_login", "foo_signout"],
    loadStatus: "loaded",
    auth: withAuth
      ? {
          label: id,
          statusTool: "foo_status",
          loginTool: "foo_login",
          logoutTool: "foo_signout",
        }
      : undefined,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("usePluginAuthStatuses", () => {
  it("returns empty map when no plugin declares auth", async () => {
    const api = {
      callPluginMethod: vi.fn(),
      onPluginEvent: vi.fn(() => () => undefined),
    } as unknown as LvisApi;
    const { result } = renderHook(() =>
      usePluginAuthStatuses(api, [makePlugin("a", false), makePlugin("b", false)]),
    );
    expect(result.current.statuses.size).toBe(0);
    expect(api.callPluginMethod).not.toHaveBeenCalled();
  });

  it("invokes statusTool on mount and surfaces authed state", async () => {
    const api = {
      callPluginMethod: vi.fn(async () => ({ authenticated: true, account: "u@x" })),
      onPluginEvent: vi.fn(() => () => undefined),
    } as unknown as LvisApi;
    const { result } = renderHook(() =>
      usePluginAuthStatuses(api, [makePlugin("ms-graph", true)]),
    );
    await waitFor(() => {
      expect(result.current.statuses.get("ms-graph")?.kind).toBe("authed");
    });
    const state = result.current.statuses.get("ms-graph");
    if (state?.kind === "authed") expect(state.account).toBe("u@x");
    expect(api.callPluginMethod).toHaveBeenCalledWith("foo_status");
  });

  it("treats { authenticated: false } as unauthed", async () => {
    const api = {
      callPluginMethod: vi.fn(async () => ({ authenticated: false })),
      onPluginEvent: vi.fn(() => () => undefined),
    } as unknown as LvisApi;
    const { result } = renderHook(() =>
      usePluginAuthStatuses(api, [makePlugin("ms-graph", true)]),
    );
    await waitFor(() => {
      expect(result.current.statuses.get("ms-graph")?.kind).toBe("unauthed");
    });
  });

  it("surfaces error when statusTool rejects", async () => {
    const api = {
      callPluginMethod: vi.fn(async () => {
        throw new Error("boom");
      }),
      onPluginEvent: vi.fn(() => () => undefined),
    } as unknown as LvisApi;
    const { result } = renderHook(() =>
      usePluginAuthStatuses(api, [makePlugin("ms-graph", true)]),
    );
    await waitFor(() => {
      expect(result.current.statuses.get("ms-graph")?.kind).toBe("error");
    });
  });

  it("survives non-Error throws (null / string) without crashing the catch handler", async () => {
    let callCount = 0;
    const api = {
      callPluginMethod: vi.fn(async () => {
        callCount += 1;
        // Two pathological throws that would crash `(err as Error).message`.
        if (callCount === 1) throw null;
        throw "raw string";
      }),
      onPluginEvent: vi.fn(() => () => undefined),
    } as unknown as LvisApi;
    const { result } = renderHook(() =>
      usePluginAuthStatuses(api, [makePlugin("ms-graph", true)]),
    );
    await waitFor(() => {
      expect(result.current.statuses.get("ms-graph")?.kind).toBe("error");
    });
    const first = result.current.statuses.get("ms-graph");
    if (first?.kind === "error") expect(first.message).toContain("auth status");

    act(() => result.current.refresh("ms-graph"));
    await waitFor(() => {
      const s = result.current.statuses.get("ms-graph");
      if (s?.kind === "error") expect(s.message).toBe("raw string");
    });
  });

  it("subscribes to <pluginId>.auth.changed and re-invokes statusTool on emit", async () => {
    let onAuthChanged: ((data: unknown) => void) | undefined;
    const callPluginMethod = vi
      .fn()
      .mockResolvedValueOnce({ authenticated: false }) // initial
      .mockResolvedValueOnce({ authenticated: true, account: "post-login@x" });
    const api = {
      callPluginMethod,
      onPluginEvent: vi.fn((eventType: string, handler: (d: unknown) => void) => {
        if (eventType === "ms-graph.auth.changed") onAuthChanged = handler;
        return () => undefined;
      }),
    } as unknown as LvisApi;

    const { result } = renderHook(() =>
      usePluginAuthStatuses(api, [makePlugin("ms-graph", true)]),
    );
    await waitFor(() => {
      expect(result.current.statuses.get("ms-graph")?.kind).toBe("unauthed");
    });

    expect(onAuthChanged).toBeDefined();
    act(() => onAuthChanged?.(undefined));

    await waitFor(() => {
      expect(result.current.statuses.get("ms-graph")?.kind).toBe("authed");
    });
    expect(callPluginMethod).toHaveBeenCalledTimes(2);
  });

  it("manual refresh re-invokes statusTool", async () => {
    const callPluginMethod = vi
      .fn()
      .mockResolvedValueOnce({ authenticated: false })
      .mockResolvedValueOnce({ authenticated: true });
    const api = {
      callPluginMethod,
      onPluginEvent: vi.fn(() => () => undefined),
    } as unknown as LvisApi;
    const { result } = renderHook(() =>
      usePluginAuthStatuses(api, [makePlugin("ms-graph", true)]),
    );
    await waitFor(() => {
      expect(result.current.statuses.get("ms-graph")?.kind).toBe("unauthed");
    });
    act(() => result.current.refresh("ms-graph"));
    await waitFor(() => {
      expect(result.current.statuses.get("ms-graph")?.kind).toBe("authed");
    });
  });
});
