/**
 * useStatusBar — unit tests for toast TTL eviction, queue cap,
 * persistent item management, and producer lifecycle effects.
 *
 * The CONTROL_CHARS regex in use-status-bar.ts is `/[\x00-\x1f\x7f]/g`
 * (rendered as invisible bytes in the file — verified by reading raw hex).
 * It strips C0 control characters (0x00–0x1F) and DEL (0x7F).
 * Spaces, hyphens, and other visible ASCII are NOT stripped.
 */
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useStatusBar } from "../use-status-bar.js";
import type { LvisApi } from "../../types.js";

// ── Minimal API factory ───────────────────────────────────────────────────────
// Only wire up the methods exercised by each test so that accidental calls to
// missing methods throw "not a function" rather than silently succeeding.

function noop() {
  return () => {};
}

function makeApi(overrides: Partial<LvisApi> = {}): LvisApi {
  return {
    // Defaults that let the hook mount without triggering visible side-effects.
    getSettings: vi.fn(async () => ({
      llm: { provider: "openai", model: "gpt-4o-mini" },
      chat: { systemPrompt: "", autoCompact: false },
      webSearch: { provider: "none" },
    })),
    ...overrides,
  } as unknown as LvisApi;
}

// ── Fake-timer harness ────────────────────────────────────────────────────────
// shouldAdvanceTime: true is required so that @testing-library/react's
// internal waitFor polling timers advance alongside our fake clock.

beforeEach(() => {
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: ["setInterval", "setTimeout", "clearInterval", "clearTimeout", "Date"],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
// Case 1 — Toast TTL eviction
// ─────────────────────────────────────────────────────────────────────────────
describe("useStatusBar — toast TTL eviction", () => {
  it("removes a toast after its TTL elapses (default 5 s, checked after 6 s)", async () => {
    const api = makeApi();
    const { result } = renderHook(() =>
      useStatusBar({ api, defaultToastTtlMs: 5000 }),
    );

    act(() => {
      result.current.pushToast({ severity: "info", message: "hello" });
    });

    // Immediately after push: 1 toast.
    expect(result.current.toasts).toHaveLength(1);

    // Advance 6 s — past the 5 s TTL. The eviction interval fires at ≤1 s
    // granularity, so the toast is swept by the 6th tick.
    await act(async () => {
      vi.advanceTimersByTime(6000);
    });

    expect(result.current.toasts).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Case 2 — Toast queue cap at 50
// ─────────────────────────────────────────────────────────────────────────────
describe("useStatusBar — toast queue cap", () => {
  it("caps at 50 toasts and keeps the LATEST 50 when 100 are pushed", () => {
    const api = makeApi();
    const { result } = renderHook(() =>
      useStatusBar({ api, defaultToastTtlMs: 60_000 }),
    );

    act(() => {
      for (let i = 1; i <= 100; i++) {
        result.current.pushToast({ severity: "info", message: `msg-${i}` });
      }
    });

    expect(result.current.toasts).toHaveLength(50);

    // The oldest 50 (toast:1 … toast:50) should have been dropped.
    const ids = result.current.toasts.map((t) => t.id);
    expect(ids[0]).toBe("toast:51");
    expect(ids[49]).toBe("toast:100");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Case 3 — upsertPersistent updates in place
// ─────────────────────────────────────────────────────────────────────────────
describe("useStatusBar — upsertPersistent", () => {
  it("updates an existing persistent item in place (no duplicate entries)", () => {
    const api = makeApi();
    const { result } = renderHook(() => useStatusBar({ api }));

    act(() => {
      result.current.upsertPersistent({
        id: "x",
        severity: "info",
        label: "Label",
        value: "first",
      });
    });
    act(() => {
      result.current.upsertPersistent({
        id: "x",
        severity: "info",
        label: "Label",
        value: "second",
      });
    });

    expect(result.current.persistent).toHaveLength(1);
    expect(result.current.persistent[0]?.value).toBe("second");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Case 4 — removePersistent
// ─────────────────────────────────────────────────────────────────────────────
describe("useStatusBar — removePersistent", () => {
  it("removes a previously upserted persistent item by id", () => {
    const api = makeApi();
    const { result } = renderHook(() => useStatusBar({ api }));

    act(() => {
      result.current.upsertPersistent({
        id: "y",
        severity: "info",
        label: "L",
        value: "v",
      });
    });
    expect(result.current.persistent).toHaveLength(1);

    act(() => {
      result.current.removePersistent("y");
    });
    expect(result.current.persistent).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Case 5 — Install lifecycle producer wires onPluginInstallProgress
// ─────────────────────────────────────────────────────────────────────────────
describe("useStatusBar — install lifecycle producer", () => {
  it("pushes a toast when onPluginInstallProgress fires with phase=installing", () => {
    let capturedHandler:
      | ((payload: { slug: string; phase: "installing" | "restarting" }) => void)
      | null = null;

    const api = makeApi({
      onPluginInstallProgress: vi.fn((h) => {
        capturedHandler = h;
        return noop();
      }),
    });

    const { result } = renderHook(() => useStatusBar({ api }));

    expect(api.onPluginInstallProgress).toHaveBeenCalledOnce();
    expect(capturedHandler).not.toBeNull();

    act(() => {
      capturedHandler!({ slug: "agent-hub", phase: "installing" });
    });

    expect(result.current.toasts).toHaveLength(1);
    // Spaces and hyphens are NOT stripped by CONTROL_CHARS (they're visible
    // ASCII, not control chars). Only 0x00–0x1F and 0x7F are stripped.
    expect(result.current.toasts[0]?.message).toBe("agent-hub 설치 중…");
  });

  it("safeField strips C0 control characters (0x00–0x1F) from slug", () => {
    let capturedHandler:
      | ((payload: { slug: string; phase: "installing" | "restarting" }) => void)
      | null = null;

    const api = makeApi({
      onPluginInstallProgress: vi.fn((h) => {
        capturedHandler = h;
        return noop();
      }),
    });

    const { result } = renderHook(() => useStatusBar({ api }));

    // Null byte (0x00) is in the C0 range → stripped.
    act(() => {
      capturedHandler!({ slug: "ev\x00il", phase: "installing" });
    });

    expect(result.current.toasts[0]?.message).toBe("evil 설치 중…");

    // Other C0 control chars — tab (0x09), LF (0x0A), CR (0x0D).
    act(() => {
      capturedHandler!({ slug: "a\tb\nc\rd", phase: "installing" });
    });
    expect(result.current.toasts[1]?.message).toBe("abcd 설치 중…");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Case 6 — Counts producer race token
// ─────────────────────────────────────────────────────────────────────────────
describe("useStatusBar — counts producer race token", () => {
  it("second getRuntimeCounts result wins even when first resolves last", async () => {
    let resolveFirst!: (v: { tools: number; plugins: number; mcps: number }) => void;
    let resolveSecond!: (v: { tools: number; plugins: number; mcps: number }) => void;
    let call = 0;

    let installHandler: (() => void) | null = null;

    const api = makeApi({
      getRuntimeCounts: vi.fn(() => {
        call++;
        if (call === 1) {
          return new Promise<{ tools: number; plugins: number; mcps: number }>((res) => {
            resolveFirst = res;
          });
        }
        return new Promise<{ tools: number; plugins: number; mcps: number }>((res) => {
          resolveSecond = res;
        });
      }),
      onPluginInstallResult: vi.fn((h) => {
        installHandler = h as () => void;
        return noop();
      }),
      onPluginUninstallResult: vi.fn((_h) => noop()),
    });

    const { result } = renderHook(() => useStatusBar({ api }));

    // Wait for mount to trigger first getRuntimeCounts call (call=1).
    await waitFor(() => {
      expect(call).toBeGreaterThanOrEqual(1);
    });

    // Trigger a second fetch via a simulated install-result event (call=2).
    act(() => {
      installHandler?.();
    });

    await waitFor(() => {
      expect(call).toBe(2);
    });

    // Resolve second call first → tools: 2.
    await act(async () => {
      resolveSecond({ tools: 2, plugins: 0, mcps: 0 });
    });

    await waitFor(() => {
      const item = result.current.persistent.find((p) => p.id === "runtime:counts");
      expect(item?.value).toContain("Tools 2");
    });

    // Resolve first call (stale) → tools: 1. Race token should discard this.
    await act(async () => {
      resolveFirst({ tools: 1, plugins: 0, mcps: 0 });
    });

    // Yield one microtask cycle to let any pending setState settle.
    await act(async () => { await Promise.resolve(); });

    const item = result.current.persistent.find((p) => p.id === "runtime:counts");
    expect(item?.value).toContain("Tools 2");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Case 7 — Marketplace producer focus/blur
// ─────────────────────────────────────────────────────────────────────────────
describe("useStatusBar — marketplace producer focus/blur", () => {
  it("pauses interval on blur and resumes on focus", async () => {
    const pingFn = vi.fn(async () => ({
      configured: true as const,
      online: true as const,
    }));

    const hasFocusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(true);

    const api = makeApi({
      pingMarketplace: pingFn,
    });

    const { result } = renderHook(() => useStatusBar({ api }));

    // Allow the initial ping to complete.
    await act(async () => { await Promise.resolve(); });

    await waitFor(() => {
      expect(result.current.persistent.find((p) => p.id === "marketplace:online")).toBeDefined();
    });

    const pingCountAfterMount = pingFn.mock.calls.length;
    expect(pingCountAfterMount).toBeGreaterThanOrEqual(1);

    // Blur → interval should stop.
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    // Advance 35 s — no additional pings should fire after blur.
    await act(async () => {
      vi.advanceTimersByTime(35_000);
    });

    expect(pingFn.mock.calls.length).toBe(pingCountAfterMount);

    // Focus → interval should restart (immediate ping).
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => { await Promise.resolve(); });

    await waitFor(() => {
      expect(pingFn.mock.calls.length).toBeGreaterThan(pingCountAfterMount);
    });

    hasFocusSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Case 8 — Marketplace producer respects configured: false
// ─────────────────────────────────────────────────────────────────────────────
describe("useStatusBar — marketplace producer configured=false", () => {
  it("does not upsert marketplace:online when pingMarketplace returns configured=false", async () => {
    const hasFocusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const pingFn = vi.fn(async () => ({
      configured: false as const,
      online: false as const,
    }));

    const api = makeApi({
      pingMarketplace: pingFn,
    });

    const { result } = renderHook(() => useStatusBar({ api }));

    await act(async () => { await Promise.resolve(); });

    await waitFor(() => {
      expect(pingFn).toHaveBeenCalled();
    });

    // marketplace:online must not appear in persistent state.
    expect(result.current.persistent.find((p) => p.id === "marketplace:online")).toBeUndefined();

    hasFocusSpy.mockRestore();
  });

  it("removes marketplace:online if it was present and a subsequent ping returns configured=false", async () => {
    const hasFocusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(true);

    let call = 0;
    const pingFn = vi.fn(async () => {
      call++;
      if (call === 1) return { configured: true as const, online: true as const };
      return { configured: false as const, online: false as const };
    });

    const api = makeApi({
      pingMarketplace: pingFn,
    });

    const { result } = renderHook(() => useStatusBar({ api }));

    // Wait for first ping (configured=true → item appears).
    await act(async () => { await Promise.resolve(); });
    await waitFor(() => {
      expect(result.current.persistent.find((p) => p.id === "marketplace:online")).toBeDefined();
    });

    // Advance 30 s to trigger the second ping interval.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.persistent.find((p) => p.id === "marketplace:online")).toBeUndefined();
    });

    hasFocusSpy.mockRestore();
  });
});
