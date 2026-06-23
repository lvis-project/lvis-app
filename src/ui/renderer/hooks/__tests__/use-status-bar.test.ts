// @vitest-environment jsdom
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
import { makeMockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";

// ── Minimal API factory ───────────────────────────────────────────────────────
// Only wire up the methods exercised by each test so that accidental calls to
// missing methods throw "not a function" rather than silently succeeding.

function noop() {
  return () => {};
}

function statusBarApi(overrides: Partial<LvisApi> = {}): LvisApi {
  const { api } = makeMockLvisApi();
  // Keep the default status-bar fixture quiet. Individual producer tests opt
  // into the API methods they exercise through overrides below.
  delete api.getSettings;
  delete api.onSettingsUpdated;
  delete api.pingMarketplace;
  Object.assign(api, overrides);
  return api as unknown as LvisApi;
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
    const api = statusBarApi();
    const { result } = renderHook(() =>
      useStatusBar({ api, defaultToastTtlMs: 5000 }),
    );

    act(() => {
      result.current.pushToast({ severity: "info", message: "hello" });
    });

    // Immediately after push: 1 toast.
    expect(result.current.toasts).toHaveLength(1);

    // Advance 6 s — past the 5 s TTL. The sequential display effect schedules
    // a setTimeout at exactly the TTL, so the toast is gone after 5 s.
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
    const api = statusBarApi();
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
    const api = statusBarApi();
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
    const api = statusBarApi();
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
type InstallProgressPayload =
  | { slug: string; phase: "installing" | "restarting" | "verifying" | "extracting" | "registering" }
  | { slug: string; phase: "downloading"; bytesDownloaded: number; bytesTotal: number | null };

describe("useStatusBar — install lifecycle producer", () => {
  it("pushes a toast when onPluginInstallProgress fires with phase=installing", () => {
    let capturedHandler:
      | ((payload: InstallProgressPayload) => void)
      | null = null;

    const api = statusBarApi({
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
      | ((payload: InstallProgressPayload) => void)
      | null = null;

    const api = statusBarApi({
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

  it("renders downloading label with byte counts when bytesTotal is known", () => {
    let capturedHandler: ((payload: InstallProgressPayload) => void) | null = null;

    const api = statusBarApi({
      onPluginInstallProgress: vi.fn((h) => {
        capturedHandler = h;
        return noop();
      }),
    });

    const { result } = renderHook(() => useStatusBar({ api }));

    act(() => {
      capturedHandler!({
        slug: "agent-hub",
        phase: "downloading",
        bytesDownloaded: 13_000_000,
        bytesTotal: 32_000_000,
      });
    });

    expect(result.current.toasts).toHaveLength(1);
    // 13 000 000 bytes = 12.4 MB (rounded), 32 000 000 bytes = 30.5 MB
    expect(result.current.toasts[0]?.message).toBe("12.4 MB / 30.5 MB · agent-hub 다운로드 중");
  });

  it("renders downloading label without denominator when bytesTotal is null", () => {
    let capturedHandler: ((payload: InstallProgressPayload) => void) | null = null;

    const api = statusBarApi({
      onPluginInstallProgress: vi.fn((h) => {
        capturedHandler = h;
        return noop();
      }),
    });

    const { result } = renderHook(() => useStatusBar({ api }));

    act(() => {
      capturedHandler!({
        slug: "my-plugin",
        phase: "downloading",
        bytesDownloaded: 5_000,
        bytesTotal: null,
      });
    });

    expect(result.current.toasts[0]?.message).toBe("my-plugin … 다운로드 중");
  });

  it("renders verifying label for phase=verifying", () => {
    let capturedHandler: ((payload: InstallProgressPayload) => void) | null = null;

    const api = statusBarApi({
      onPluginInstallProgress: vi.fn((h) => {
        capturedHandler = h;
        return noop();
      }),
    });

    const { result } = renderHook(() => useStatusBar({ api }));

    act(() => {
      capturedHandler!({ slug: "agent-hub", phase: "verifying" });
    });

    expect(result.current.toasts[0]?.message).toBe("agent-hub 검증 중…");
  });

  it("renders registering label for phase=registering", () => {
    let capturedHandler: ((payload: InstallProgressPayload) => void) | null = null;

    const api = statusBarApi({
      onPluginInstallProgress: vi.fn((h) => {
        capturedHandler = h;
        return noop();
      }),
    });

    const { result } = renderHook(() => useStatusBar({ api }));

    act(() => {
      capturedHandler!({ slug: "agent-hub", phase: "registering" });
    });

    expect(result.current.toasts[0]?.message).toBe("agent-hub 등록 중…");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Note: the vendor (provider/model) + combined health producers were removed
// from useStatusBar — the window status bar is NOTIFICATIONS-ONLY. Those cells
// now live in the unified InputActionBar status sub-row (see
// use-input-status-row.ts + InputActionBar.test.tsx). useStatusBar retains only
// the toast/notification surface plus the install lifecycle producer.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Case 9 — Sequential toast display (visibleToast + pendingCount)
// ─────────────────────────────────────────────────────────────────────────────
describe("useStatusBar — sequential toast display", () => {
  it("visibleToast exposes the queue head, pendingCount reflects the rest", () => {
    const api = statusBarApi();
    const { result } = renderHook(() =>
      useStatusBar({ api, defaultToastTtlMs: 5000 }),
    );

    act(() => {
      result.current.pushToast({ severity: "info", message: "first" });
      result.current.pushToast({ severity: "success", message: "second" });
      result.current.pushToast({ severity: "warning", message: "third" });
    });

    expect(result.current.visibleToast?.message).toBe("first");
    expect(result.current.pendingCount).toBe(2);
  });

  it("auto-advances to next toast after the visible one's TTL elapses", async () => {
    const api = statusBarApi();
    const { result } = renderHook(() =>
      useStatusBar({ api, defaultToastTtlMs: 3000 }),
    );

    act(() => {
      result.current.pushToast({ severity: "info", message: "first", ttlMs: 3000 });
      result.current.pushToast({ severity: "success", message: "second", ttlMs: 3000 });
    });

    expect(result.current.visibleToast?.message).toBe("first");
    expect(result.current.pendingCount).toBe(1);

    // Advance past first toast TTL.
    await act(async () => {
      vi.advanceTimersByTime(3100);
    });

    expect(result.current.visibleToast?.message).toBe("second");
    expect(result.current.pendingCount).toBe(0);
  });

  it("queue drains to null visibleToast after all toasts expire", async () => {
    const api = statusBarApi();
    const { result } = renderHook(() =>
      useStatusBar({ api, defaultToastTtlMs: 3000 }),
    );

    act(() => {
      result.current.pushToast({ severity: "info", message: "only one", ttlMs: 3000 });
    });

    expect(result.current.visibleToast?.message).toBe("only one");

    await act(async () => {
      vi.advanceTimersByTime(3100);
    });

    expect(result.current.visibleToast).toBeNull();
    expect(result.current.pendingCount).toBe(0);
  });

  it("removeToast on visibleToast immediately advances to next", () => {
    const api = statusBarApi();
    const { result } = renderHook(() =>
      useStatusBar({ api, defaultToastTtlMs: 30_000 }),
    );

    act(() => {
      result.current.pushToast({ severity: "info", message: "first" });
      result.current.pushToast({ severity: "success", message: "second" });
    });

    const firstId = result.current.visibleToast?.id;
    expect(firstId).toBeDefined();

    act(() => {
      result.current.removeToast(firstId!);
    });

    expect(result.current.visibleToast?.message).toBe("second");
    expect(result.current.pendingCount).toBe(0);
  });

  it("burst of 3 install-result events shows only 1 toast at a time, advancing sequentially", async () => {
    let capturedHandler: ((payload: { slug: string; success: boolean; error?: string }) => void) | null = null;

    const api = statusBarApi({
      onPluginInstallResult: vi.fn((h) => {
        capturedHandler = h;
        return () => {};
      }),
    });

    const { result } = renderHook(() =>
      useStatusBar({ api, defaultToastTtlMs: 3000 }),
    );

    // Pin the fake clock to a known epoch before pushing toasts so that
    // expiresAt values are deterministic regardless of real CI wall-clock
    // drift (shouldAdvanceTime: true can cause extra advancement on slow
    // runners, draining the queue prematurely).
    vi.setSystemTime(0);

    // Burst: 3 install-result events in the same tick.
    act(() => {
      capturedHandler!({ slug: "plugin-a", success: true });
      capturedHandler!({ slug: "plugin-b", success: true });
      capturedHandler!({ slug: "plugin-c", success: true });
    });

    // Only 1 visible at a time.
    expect(result.current.visibleToast?.message).toBe("plugin-a 설치 완료");
    expect(result.current.pendingCount).toBe(2);

    // Advance past first TTL → second becomes visible.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(result.current.visibleToast?.message).toBe("plugin-b 설치 완료");
    expect(result.current.pendingCount).toBe(1);

    // Advance past second TTL → third becomes visible.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(result.current.visibleToast?.message).toBe("plugin-c 설치 완료");
    expect(result.current.pendingCount).toBe(0);

    // Advance past third TTL → queue empty.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(result.current.visibleToast).toBeNull();
  });
});
