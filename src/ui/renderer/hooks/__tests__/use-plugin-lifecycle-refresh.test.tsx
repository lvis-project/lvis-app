import "../../../../../test/renderer/setup.js";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { makeMockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";
import { usePluginLifecycleRefresh } from "../use-plugin-lifecycle-refresh.js";
import type { LvisApi } from "../../types.js";

function renderLifecycleHook() {
  const { api, emitPluginInstallResult, emitBootstrapStatus } = makeMockLvisApi();
  const refreshViews = vi.fn();
  const refreshCards = vi.fn();
  const refreshMarketplace = vi.fn();
  renderHook(() =>
    usePluginLifecycleRefresh({
      api: api as unknown as LvisApi,
      pluginCards: [],
      refreshViews,
      refreshCards,
      refreshMarketplace,
    }),
  );
  return {
    emitPluginInstallResult,
    emitBootstrapStatus,
    refreshViews,
    refreshCards,
    refreshMarketplace,
  };
}

describe("usePluginLifecycleRefresh", () => {
  it("refreshes cards when a plugin install fails so Doctor cards can appear", () => {
    const { emitPluginInstallResult, refreshViews, refreshCards, refreshMarketplace } =
      renderLifecycleHook();

    act(() => {
      emitPluginInstallResult({ slug: "meeting", success: false, error: "install failed" });
    });

    expect(refreshCards).toHaveBeenCalledTimes(1);
    expect(refreshViews).not.toHaveBeenCalled();
    expect(refreshMarketplace).not.toHaveBeenCalled();
  });

  it("refreshes plugin surfaces when managed bootstrap completes with failures", () => {
    const { emitBootstrapStatus, refreshViews, refreshCards, refreshMarketplace } =
      renderLifecycleHook();

    act(() => {
      emitBootstrapStatus({
        phase: "complete",
        installed: [],
        failed: [{ id: "meeting", error: "manifest grant mismatch" }],
      });
    });

    expect(refreshCards).toHaveBeenCalledTimes(1);
    expect(refreshViews).toHaveBeenCalledTimes(1);
    expect(refreshMarketplace).toHaveBeenCalledTimes(1);
  });
});
