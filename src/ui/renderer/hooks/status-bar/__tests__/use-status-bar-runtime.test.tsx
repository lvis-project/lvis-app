// @vitest-environment jsdom
import "../../../../../../test/renderer/setup.js";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { STATUS_BAR_RUNTIME_EMOJIS } from "../../../../../shared/status-bar-emojis.js";
import type { LvisApi } from "../../../types.js";
import type { PersistentItem } from "../types.js";
import { useStatusBarRuntime } from "../use-status-bar-runtime.js";

type RuntimeCounts = Awaited<ReturnType<NonNullable<LvisApi["getRuntimeCounts"]>>>;
type PluginInstallHandler = Parameters<NonNullable<LvisApi["onPluginInstallResult"]>>[0];

function runtimeApi(overrides: Partial<LvisApi> = {}): LvisApi {
  return {
    getRuntimeCounts: vi.fn(async () => ({ tools: 3, plugins: 2, mcps: 1 })),
    onPluginInstallResult: vi.fn(() => () => undefined),
    onPluginUninstallResult: vi.fn(() => () => undefined),
    ...overrides,
  } as unknown as LvisApi;
}

function deferredCounts(): {
  promise: Promise<RuntimeCounts>;
  resolve: (value: RuntimeCounts) => void;
} {
  let resolve!: (value: RuntimeCounts) => void;
  const promise = new Promise<RuntimeCounts>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("useStatusBarRuntime", () => {
  it("uses the shared emoji SOT for runtime producer labels", async () => {
    const upsertPersistent = vi.fn<(item: PersistentItem) => void>();

    renderHook(() =>
      useStatusBarRuntime({
        api: runtimeApi(),
        upsertPersistent,
      }),
    );

    await waitFor(() => expect(upsertPersistent).toHaveBeenCalledTimes(3));
    expect(upsertPersistent.mock.calls.map(([item]) => [item.id, item.label, item.value])).toEqual([
      ["runtime:tools", STATUS_BAR_RUNTIME_EMOJIS.tools, "3"],
      ["runtime:plugins", STATUS_BAR_RUNTIME_EMOJIS.plugins, "2"],
      ["runtime:mcps", STATUS_BAR_RUNTIME_EMOJIS.mcps, "1"],
    ]);
  });

  it("does not let a stale runtime-count refresh overwrite a newer refresh", async () => {
    const first = deferredCounts();
    const second = deferredCounts();
    const getRuntimeCounts = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    let installHandler: PluginInstallHandler | null = null;
    const upsertPersistent = vi.fn<(item: PersistentItem) => void>();

    renderHook(() =>
      useStatusBarRuntime({
        api: runtimeApi({
          getRuntimeCounts,
          onPluginInstallResult: vi.fn((handler) => {
            installHandler = handler;
            return () => undefined;
          }),
        }),
        upsertPersistent,
      }),
    );

    await waitFor(() => expect(getRuntimeCounts).toHaveBeenCalledTimes(1));
    act(() => {
      installHandler?.({ slug: "meeting", success: true });
    });
    await waitFor(() => expect(getRuntimeCounts).toHaveBeenCalledTimes(2));

    await act(async () => {
      second.resolve({ tools: 10, plugins: 20, mcps: 30 });
      await second.promise;
    });
    await waitFor(() =>
      expect(upsertPersistent.mock.calls.map(([item]) => item.value)).toEqual(["10", "20", "30"]),
    );

    await act(async () => {
      first.resolve({ tools: 1, plugins: 2, mcps: 3 });
      await first.promise;
    });

    expect(upsertPersistent.mock.calls.map(([item]) => item.value)).toEqual(["10", "20", "30"]);
  });
});
