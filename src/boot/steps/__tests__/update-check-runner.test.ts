import { describe, expect, it, vi } from "vitest";
import { createUpdateCheckRunner } from "../update-check-runner.js";
import type { PluginUpdateCheckResult } from "../../../plugins/update-detector.js";

function update(version: string) {
  return {
    pluginId: "calendar",
    pluginName: "Calendar",
    installedVersion: "1.0.0",
    latestVersion: version,
  };
}

describe("createUpdateCheckRunner", () => {
  it("coalesces overlapping polls so stale completion cannot overwrite newer state", async () => {
    let release = (_result: PluginUpdateCheckResult) => {};
    const pending = new Promise<PluginUpdateCheckResult>((resolve) => {
      release = resolve;
    });
    const check = vi.fn(() => pending);
    const broadcast = vi.fn();
    const run = createUpdateCheckRunner({
      check,
      filter: (updates) => updates,
      broadcast,
    });

    const first = run();
    const overlap = run();
    expect(first).toBe(overlap);
    expect(check).toHaveBeenCalledOnce();

    release({ status: "success", updates: [update("2.0.0")] });
    await Promise.all([first, overlap]);
    expect(broadcast).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledWith([update("2.0.0")]);
  });

  it("preserves the last successful broadcast across catalog failure", async () => {
    const check = vi
      .fn<() => Promise<PluginUpdateCheckResult>>()
      .mockResolvedValueOnce({ status: "success", updates: [update("2.0.0")] })
      .mockResolvedValueOnce({ status: "catalog-unavailable" })
      .mockResolvedValueOnce({ status: "success", updates: [update("2.0.0")] });
    const broadcast = vi.fn();
    const run = createUpdateCheckRunner({
      check,
      filter: (updates) => updates,
      broadcast,
    });

    await run();
    await run();
    await run();

    expect(broadcast).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledWith([update("2.0.0")]);
  });

  it("preserves the last successful broadcast and reports an internal failure", async () => {
    const registryError = new Error("registry read failed");
    const check = vi
      .fn<() => Promise<PluginUpdateCheckResult>>()
      .mockResolvedValueOnce({ status: "success", updates: [update("2.0.0")] })
      .mockResolvedValueOnce({ status: "error", error: registryError })
      .mockResolvedValueOnce({ status: "success", updates: [update("2.0.0")] });
    const broadcast = vi.fn();
    const onError = vi.fn();
    const run = createUpdateCheckRunner({
      check,
      filter: (updates) => updates,
      broadcast,
      onError,
    });

    await run();
    await run();
    await run();

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(registryError);
    expect(broadcast).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledWith([update("2.0.0")]);
  });
});
