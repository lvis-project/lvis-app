// @vitest-environment jsdom
/**
 * useStatusBarHealth — hysteresis on the combined services health dot.
 *
 * The status dot used to flip online↔offline on every flaky LLM probe, which
 * (combined with the upsertPersistent → App re-render path) fed the onboarding
 * ping flicker. The hook now holds the last-known-good online state through a
 * single transient failure and only flips to offline after two consecutive
 * failures. Recovery is immediate on the first success.
 */
import "../../../../../../test/renderer/setup.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useStatusBarHealth } from "../use-status-bar-health.js";
import type { LvisApi } from "../../../types.js";
import type { PersistentItem } from "../types.js";
import type { AiProviderPingIpcResult } from "../../../../../shared/ai-provider-ping.js";

beforeEach(() => {
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: ["setInterval", "setTimeout", "clearInterval", "clearTimeout", "Date"],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

function onlineResult(latencyMs = 12): AiProviderPingIpcResult {
  return {
    configured: true,
    online: true,
    vendor: "openai",
    model: "gpt-5.4",
    latencyMs,
  };
}

function offlineResult(): AiProviderPingIpcResult {
  return {
    configured: true,
    online: false,
    vendor: "openai",
    model: "gpt-5.4",
    error: "timeout",
    latencyMs: 8000,
  };
}

function renderHealth(pingAiProvider: () => Promise<AiProviderPingIpcResult>) {
  const items = new Map<string, PersistentItem>();
  const upsertPersistent = vi.fn((item: PersistentItem) => {
    items.set(item.id, item);
  });
  const removePersistent = vi.fn((id: string) => {
    items.delete(id);
  });
  // Only the LLM probe is wired — pingMarketplace stays undefined so the
  // marketplace half resolves to "unavailable" and does not affect the LLM
  // hysteresis assertions (it contributes a steady "warning" at most).
  const api = { pingAiProvider } as unknown as LvisApi;

  const view = renderHook(() =>
    useStatusBarHealth({ api, upsertPersistent, removePersistent }),
  );
  const health = () => items.get("health:services");
  return { ...view, upsertPersistent, removePersistent, health };
}

describe("useStatusBarHealth — offline hysteresis", () => {
  it("keeps the dot non-error on a single transient LLM failure after being online", async () => {
    const pingAiProvider = vi
      .fn<[], Promise<AiProviderPingIpcResult>>()
      .mockResolvedValueOnce(onlineResult())
      .mockResolvedValueOnce(offlineResult());

    const { health } = renderHealth(pingAiProvider);

    // First probe → online.
    await waitFor(() => {
      expect(health()?.tooltip).toContain("LLM: online");
    });

    // Second probe (next 30 s tick) → single failure. The dot must HOLD online.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });

    expect(pingAiProvider).toHaveBeenCalledTimes(2);
    expect(health()?.tooltip).toContain("LLM: online");
    expect(health()?.tooltip).not.toContain("LLM: offline");
  });

  it("flips the dot to offline only after two consecutive LLM failures", async () => {
    const pingAiProvider = vi
      .fn<[], Promise<AiProviderPingIpcResult>>()
      .mockResolvedValueOnce(onlineResult())
      .mockResolvedValueOnce(offlineResult())
      .mockResolvedValueOnce(offlineResult());

    const { health } = renderHealth(pingAiProvider);

    await waitFor(() => {
      expect(health()?.tooltip).toContain("LLM: online");
    });

    // 1st failure — still online (hysteresis holds).
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(health()?.tooltip).toContain("LLM: online");

    // 2nd consecutive failure — now flips to offline.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(pingAiProvider).toHaveBeenCalledTimes(3);
    expect(health()?.tooltip).toContain("LLM: offline");
    expect(health()?.severity).toBe("error");
  });

  it("recovers to online immediately on the first success after a failure streak", async () => {
    const pingAiProvider = vi
      .fn<[], Promise<AiProviderPingIpcResult>>()
      .mockResolvedValueOnce(onlineResult())
      .mockResolvedValueOnce(offlineResult())
      .mockResolvedValueOnce(offlineResult())
      .mockResolvedValueOnce(onlineResult(20));

    const { health } = renderHealth(pingAiProvider);

    await waitFor(() => {
      expect(health()?.tooltip).toContain("LLM: online");
    });

    // Two failures → offline.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(health()?.tooltip).toContain("LLM: offline");

    // One success → immediate recovery (no second success required).
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(pingAiProvider).toHaveBeenCalledTimes(4);
    expect(health()?.tooltip).toContain("LLM: online");
    expect(health()?.tooltip).not.toContain("LLM: offline");
  });
});
