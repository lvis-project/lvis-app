import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginHostApiIncarnation } from "../index.js";
import { PluginRuntime } from "../index.js";
import { createNoopHostApi } from "../sandbox.js";
import type { PluginManifest } from "../../types.js";

class IncarnationTestRuntime extends PluginRuntime {
  buildPending(pluginId: string, manifest: PluginManifest, dataDir: string) {
    return this.buildHostApiIncarnation(pluginId, manifest, dataDir);
  }

  invalidate(pluginId: string): void {
    this.beginPluginLifecycleOperation(pluginId);
  }

  resetState(): void {
    this.resetLoadedState();
  }
}

describe("pending HostApi incarnation lifecycle", () => {
  it("revokes a factory-pending incarnation immediately on generation invalidation", () => {
    let captured!: PluginHostApiIncarnation;
    const runtime = new IncarnationTestRuntime({
      hostRoot: "/tmp/lvis-incarnation-host",
      createHostApi: (pluginId, _manifest, pluginDataDir, incarnation) => {
        captured = incarnation;
        return createNoopHostApi(pluginId, pluginDataDir);
      },
    });
    const manifest = {
      id: "plugin-a",
      name: "Plugin A",
      version: "1.0.0",
      entry: "entry.mjs",
      description: "test",
      publisher: "test",
      tools: [],
    } satisfies PluginManifest;

    const pending = runtime.buildPending(
      "plugin-a",
      manifest,
      mkdtempSync(join(tmpdir(), "lvis-incarnation-data-")),
    );
    expect(captured.isActive()).toBe(true);

    runtime.invalidate("plugin-a");

    expect(captured.isActive()).toBe(false);
    expect(() => pending.commit()).toThrow(/Cannot commit inactive HostApi incarnation/);
  });

  it("does not revoke an incarnation after it has committed", () => {
    let captured!: PluginHostApiIncarnation;
    const runtime = new IncarnationTestRuntime({
      hostRoot: "/tmp/lvis-incarnation-host",
      createHostApi: (pluginId, _manifest, pluginDataDir, incarnation) => {
        captured = incarnation;
        return createNoopHostApi(pluginId, pluginDataDir);
      },
    });
    const manifest = {
      id: "plugin-a", name: "Plugin A", version: "1.0.0", entry: "entry.mjs",
      description: "test", publisher: "test", tools: [],
    } satisfies PluginManifest;
    const committed = runtime.buildPending(
      "plugin-a",
      manifest,
      mkdtempSync(join(tmpdir(), "lvis-incarnation-data-")),
    );
    committed.commit();

    runtime.invalidate("plugin-a");

    expect(captured.isActive()).toBe(true);
    committed.deactivate();
    expect(captured.isActive()).toBe(false);
  });

  it("revokes every pending incarnation when loaded state is reset", () => {
    let captured!: PluginHostApiIncarnation;
    const runtime = new IncarnationTestRuntime({
      hostRoot: "/tmp/lvis-incarnation-host",
      createHostApi: (pluginId, _manifest, pluginDataDir, incarnation) => {
        captured = incarnation;
        return createNoopHostApi(pluginId, pluginDataDir);
      },
    });
    const manifest = {
      id: "plugin-a", name: "Plugin A", version: "1.0.0", entry: "entry.mjs",
      description: "test", publisher: "test", tools: [],
    } satisfies PluginManifest;
    const pending = runtime.buildPending(
      "plugin-a",
      manifest,
      mkdtempSync(join(tmpdir(), "lvis-incarnation-data-")),
    );

    runtime.resetState();

    expect(captured.isActive()).toBe(false);
    expect(() => pending.commit()).toThrow(/Cannot commit inactive HostApi incarnation/);
  });
});
