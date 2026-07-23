import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginHostApiIncarnation } from "../index.js";
import { PluginRuntime, type PluginRuntimeOptions } from "../index.js";
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

  async runHook<T>(scope: ReturnType<IncarnationTestRuntime["buildPending"]>["lifecycleHookScope"], hook: () => Promise<T>): Promise<T> {
    return this.runPluginLifecycleHook(scope, hook);
  }
}

describe("pending HostApi incarnation lifecycle", () => {
  it("rejects missing HostApi composition instead of silently installing a noop", () => {
    expect(() => new PluginRuntime({
      hostRoot: "/tmp/lvis-incarnation-host",
    } as PluginRuntimeOptions)).toThrow(/requires an explicit createHostApi factory/);
  });

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

  it("releases resources registered by a pending incarnation immediately and once", () => {
    let captured!: PluginHostApiIncarnation;
    let disposeCalls = 0;
    const runtime = new IncarnationTestRuntime({
      hostRoot: "/tmp/lvis-incarnation-host",
      createHostApi: (pluginId, _manifest, pluginDataDir, incarnation) => {
        captured = incarnation;
        incarnation.registerDisposer(() => {
          disposeCalls += 1;
        });
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

    runtime.invalidate("plugin-a");

    expect(captured.isActive()).toBe(false);
    expect(disposeCalls).toBe(1);
    expect(pending.disposers).toEqual([]);
    pending.deactivate();
    expect(disposeCalls).toBe(1);
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

  it("does not leak a hung hook marker into a same-id replacement incarnation", async () => {
    const runtime = new IncarnationTestRuntime({
      hostRoot: "/tmp/lvis-incarnation-host",
      createHostApi: (pluginId, _manifest, pluginDataDir) =>
        createNoopHostApi(pluginId, pluginDataDir),
    });
    const manifest = {
      id: "plugin-a", name: "Plugin A", version: "1.0.0", entry: "entry.mjs",
      description: "test", publisher: "test", tools: [],
    } satisfies PluginManifest;
    const first = runtime.buildPending(
      "plugin-a",
      manifest,
      mkdtempSync(join(tmpdir(), "lvis-incarnation-data-")),
    );
    void runtime.runHook(first.lifecycleHookScope, () => new Promise<never>(() => undefined));
    await Promise.resolve();
    expect(first.lifecycleHookScope.depth).toBe(1);

    first.deactivate();
    const replacement = runtime.buildPending(
      "plugin-a",
      manifest,
      mkdtempSync(join(tmpdir(), "lvis-incarnation-data-")),
    );

    expect(first.lifecycleHookScope.depth).toBe(0);
    expect(replacement.lifecycleHookScope.depth).toBe(0);
    expect(replacement.lifecycleHookScope.active).toBe(true);
  });

  it("drains already-started HostApi operations before incarnation cleanup completes", async () => {
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
    let release!: () => void;
    const operation = new Promise<void>((resolve) => { release = resolve; });
    void captured.trackOperation(operation);

    let drained = false;
    const drain = pending.drainOperations().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await drain;
    expect(drained).toBe(true);
  });
});
