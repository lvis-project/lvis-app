import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScriptHookManager } from "../../../hooks/script-hook-manager.js";
import { SkillStore } from "../../../main/skill-store.js";
import {
  makeTestPluginRuntime,
  makeTestTreeWritable,
} from "../../__tests__/test-helpers.js";
import { PluginBundleLifecycle } from "../../plugin-bundle-lifecycle.js";
import {
  buildInstallReceipt,
  writeInstallReceipt,
} from "../../plugin-install-receipt.js";
import { createNoopHostApiForTests, PluginRuntime } from "../../runtime.js";
import type { PluginManifest } from "../../types.js";
import { canonicalJSON } from "../../whitelist/canonical-json.js";
import { agentPluginsDocument } from "../../__tests__/test-helpers.js";

type WrittenPlugin = {
  id: string;
  pluginDir: string;
  manifestPath: string;
  manifest: PluginManifest;
  toolName: string;
};

type GenerationCommitScope = <T>(operation: () => Promise<T>) => Promise<T>;
type TestGenerationLifecycle = {
  deactivateWithCommit<T>(
    pluginId: string,
    durableCommit: () => Promise<T>,
    commitScope?: GenerationCommitScope,
  ): Promise<{ result: T; retirement: Promise<void> }>;
};

function deferredGate(): {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("PluginRuntime capability dependencies use active generations", () => {
  let root: string;
  let pluginsRoot: string;
  let registryPath: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "lvis-active-capabilities-"));
    pluginsRoot = join(root, "plugins");
    registryPath = join(pluginsRoot, "registry.json");
    await mkdir(pluginsRoot, { recursive: true });
  });

  afterEach(async () => {
    await makeTestTreeWritable(root);
    await rm(root, { recursive: true, force: true });
  });

  async function writePlugin(options: {
    id: string;
    capabilities?: string[];
    requires?: PluginManifest["requires"];
    entrySource?: string;
  }): Promise<WrittenPlugin> {
    const pluginDir = join(pluginsRoot, options.id);
    const toolName = `${options.id.replaceAll("-", "_")}_ping`;
    await mkdir(pluginDir, { recursive: true });
    const manifest: PluginManifest = {
      id: options.id,
      name: options.id,
      version: "1.0.0",
      description: "active capability dependency fixture",
      publisher: "LVIS tests",
      entry: "entry.mjs",
      tools: [{
        name: toolName,
        description: `${toolName} tool`,
        inputSchema: { type: "object", properties: {} },
        _meta: { ui: { visibility: ["model", "app"] } },
      }],
      ...(options.capabilities ? { capabilities: options.capabilities } : {}),
      ...(options.requires ? { requires: options.requires } : {}),
    };
    await writeFile(
      join(pluginDir, "entry.mjs"),
      options.entrySource ?? `export default async function createPlugin() {
  return {
    handlers: { ${JSON.stringify(toolName)}: async () => "pong" },
    start: async () => {},
    stop: async () => {},
  };
}
`,
      "utf8",
    );
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(agentPluginsDocument(manifest)), "utf8");
    return {
      id: options.id,
      pluginDir,
      manifestPath,
      manifest,
      toolName,
    };
  }

  async function writeRegistry(
    plugins: Array<Pick<WrittenPlugin, "id" | "manifestPath"> & { enabled?: boolean }>,
  ): Promise<void> {
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: plugins.map(({ id, manifestPath, enabled = true }) => ({
          id,
          manifestPath,
          enabled,
        })),
      }),
      "utf8",
    );
  }

  async function writeReceipt(plugin: WrittenPlugin): Promise<void> {
    const { receipt } = await buildInstallReceipt(plugin.pluginDir, {
      pluginId: plugin.id,
      version: plugin.manifest.version,
      installSource: "marketplace",
      artifactSha256: "a".repeat(64),
      signerKeyId: "test-v1",
      files: ["entry.mjs", "plugin.json"],
      installedAt: new Date(0).toISOString(),
    });
    await writeInstallReceipt(root, receipt);
  }

  function makeRuntime(
    withReceipts = false,
    options: Parameters<typeof makeTestPluginRuntime>[1] = {},
  ) {
    return makeTestPluginRuntime(
      { rootDir: root, pluginsRoot, registryPath },
      {
        ...options,
        ...(withReceipts ? { installReceiptCacheRoot: root } : {}),
      },
    );
  }

  function bindRealBundleLifecycle(runtime: PluginRuntime): PluginBundleLifecycle {
    const lifecycle = new PluginBundleLifecycle({
      pluginRuntime: runtime,
      receiptCacheRoot: root,
      skillStore: new SkillStore({ userDir: join(root, "real-lifecycle-skills") }),
      hookManager: new ScriptHookManager(),
      mcpManager: {
        bundledServerIdsForPlugin: vi.fn(() => []),
        prepareBundledGeneration: vi.fn(async () => ({
          predecessorServerIds: [],
          predecessorToolNames: [],
          records: [],
          registryReplacement: { publish: vi.fn(), cancel: vi.fn(), replacementTools: [] },
          published: false,
        })),
        publishBundledGeneration: vi.fn((prepared) => { prepared.published = true; }),
        discardBundledGeneration: vi.fn(async () => undefined),
        retirePublishedMcpReplacement: vi.fn(async () => undefined),
        disconnectBundledGeneration: vi.fn(async () => undefined),
      } as never,
      loopbackManager: {
        prepareGeneration: vi.fn(async (manifest: PluginManifest, generationId: string) => ({
          pluginId: manifest.id,
          generationId,
          tools: [],
          registryReplacement: { publish: vi.fn(), cancel: vi.fn(), replacementTools: [] },
          published: false,
          disconnectPredecessor: false,
        })),
        prepareRemoval: vi.fn((pluginId: string, generationId: string) => ({
          pluginId,
          generationId,
          tools: [],
          registryReplacement: { publish: vi.fn(), cancel: vi.fn(), replacementTools: [] },
          published: false,
          disconnectPredecessor: false,
        })),
        publishGeneration: vi.fn((prepared) => { prepared.published = true; }),
        postPublishGeneration: vi.fn(),
        discardGeneration: vi.fn(async () => undefined),
        retireGeneration: vi.fn(async () => undefined),
      } as never,
      revokeOperationGeneration: vi.fn(),
    });
    runtime.setGenerationAccess(lifecycle);
    return lifecycle;
  }

  async function makeRealLifecycleBlockedRuntime(options: {
    onActiveStateChange?: (pluginId: string, enabled: boolean) => void | Promise<void>;
    consumerEntrySource?: string;
    onConsumerHostApiReady?: (registerDisposer: (dispose: () => void) => void) => void;
  } = {}) {
    const consumer = await writePlugin({
      id: "real-lifecycle-blocked-consumer",
      requires: { capabilities: ["calendar-source"] },
      ...(options.consumerEntrySource ? { entrySource: options.consumerEntrySource } : {}),
    });
    const provider = await writePlugin({
      id: "real-lifecycle-blocked-provider",
      capabilities: ["calendar-source"],
    });
    await writeRegistry([consumer, provider]);
    await Promise.all([writeReceipt(consumer), writeReceipt(provider)]);

    const providerPreparation = deferredGate();
    const runtime = new PluginRuntime({
      hostRoot: root,
      pluginsRoot,
      registryPath,
      installReceiptCacheRoot: root,
      createHostApi: (pluginId, manifest, pluginDataDir, incarnation) => {
        if (pluginId === consumer.id) {
          options.onConsumerHostApiReady?.((dispose) => incarnation.registerDisposer(dispose));
        }
        return createNoopHostApiForTests(pluginId, manifest, pluginDataDir);
      },
      preparePluginStart: ({ pluginId }) =>
        pluginId === provider.id ? providerPreparation.promise : undefined,
      onActiveStateChange: options.onActiveStateChange,
    });
    const lifecycle = bindRealBundleLifecycle(runtime);
    await runtime.startAll();

    expect(runtime.getRuntimeGenerationProjection(consumer.id)).toBeDefined();
    expect(lifecycle.getActive(consumer.id)).toBeUndefined();
    expect(runtime.listPluginCards().find((card) => card.id === consumer.id))
      .toMatchObject({ runtimeLoaded: true, loadStatus: "preparing", active: false });

    return { consumer, lifecycle, provider, providerPreparation, runtime };
  }

  async function resolveRealLifecycleProvider(
    fixture: Awaited<ReturnType<typeof makeRealLifecycleBlockedRuntime>>,
  ): Promise<void> {
    fixture.providerPreparation.resolve();
    await expect(fixture.runtime.waitForPluginReady(fixture.provider.id)).resolves.toBeUndefined();
    await nextTurn();
    expect(fixture.lifecycle.getActive(fixture.consumer.id)).toBeUndefined();
    expect(fixture.runtime.listPluginIds()).not.toContain(fixture.consumer.id);
  }

  async function writePreparedConsumer(): Promise<{
    installId: string;
    pluginRoot: string;
    manifest: PluginManifest;
    receiptRaw: string;
    registryEntry: {
      installSource: "user";
      manifestSha256: string;
    };
    toolName: string;
  }> {
    const installId = "prepared-consumer";
    const pluginRoot = join(root, "prepared-consumer-staging");
    const toolName = "prepared_consumer_ping";
    const manifest: PluginManifest = {
      id: "prepared-consumer",
      name: "prepared-consumer",
      version: "1.0.0",
      description: "prepared active capability fixture",
      publisher: "LVIS tests",
      entry: "entry.mjs",
      requires: { capabilities: ["calendar-source"] },
      tools: [{
        name: toolName,
        description: "prepared consumer tool",
        inputSchema: { type: "object", properties: {} },
        _meta: { ui: { visibility: ["model", "app"] } },
      }],
    };
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(pluginRoot, "plugin.json"), JSON.stringify(agentPluginsDocument(manifest)), "utf8");
    await writeFile(
      join(pluginRoot, "entry.mjs"),
      `export default async function createPlugin() {
  return { handlers: { prepared_consumer_ping: async () => "pong" } };
}
`,
      "utf8",
    );
    const { receipt } = await buildInstallReceipt(pluginRoot, {
      pluginId: installId,
      version: manifest.version,
      installSource: "marketplace",
      artifactSha256: "b".repeat(64),
      signerKeyId: "test-v1",
      files: ["entry.mjs", "plugin.json"],
      installedAt: new Date(0).toISOString(),
    });
    return {
      installId,
      pluginRoot,
      manifest,
      receiptRaw: JSON.stringify(receipt),
      registryEntry: {
        installSource: "user",
        manifestSha256: createHash("sha256")
          .update(canonicalJSON(manifest))
          .digest("hex"),
      },
      toolName,
    };
  }

  /**
   * A same-id replacement which deliberately removes the blocked consumer's
   * capability requirement. This makes prepared activation reachable while the
   * old candidate is still waiting for its provider, rather than relying on a
   * synthetic direct mutation of runtime state.
   */
  async function writePreparedUnblockedReplacement(
    plugin: Pick<WrittenPlugin, "id">,
  ): Promise<{
    installId: string;
    pluginRoot: string;
    manifest: PluginManifest;
    receiptRaw: string;
    registryEntry: {
      installSource: "user";
      manifestSha256: string;
    };
    toolName: string;
  }> {
    const pluginRoot = join(root, `${plugin.id}-prepared-unblocked-replacement`);
    const toolName = `${plugin.id.replaceAll("-", "_")}_replacement_ping`;
    const manifest: PluginManifest = {
      id: plugin.id,
      name: plugin.id,
      version: "1.0.1",
      description: "prepared replacement without a pending capability requirement",
      publisher: "LVIS tests",
      entry: "entry.mjs",
      tools: [{
        name: toolName,
        description: "prepared replacement tool",
        inputSchema: { type: "object", properties: {} },
        _meta: { ui: { visibility: ["model", "app"] } },
      }],
    };
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(pluginRoot, "plugin.json"), JSON.stringify(agentPluginsDocument(manifest)), "utf8");
    await writeFile(
      join(pluginRoot, "entry.mjs"),
      `export default async function createPlugin() {
  return {
    handlers: { ${JSON.stringify(toolName)}: async () => "replacement-pong" },
    start: async () => {},
    stop: async () => {},
  };
}
`,
      "utf8",
    );
    const { receipt } = await buildInstallReceipt(pluginRoot, {
      pluginId: plugin.id,
      version: manifest.version,
      installSource: "marketplace",
      artifactSha256: "c".repeat(64),
      signerKeyId: "test-v1",
      files: ["entry.mjs", "plugin.json"],
      installedAt: new Date(0).toISOString(),
    });
    return {
      installId: plugin.id,
      pluginRoot,
      manifest,
      receiptRaw: JSON.stringify(receipt),
      registryEntry: {
        installSource: "user",
        manifestSha256: createHash("sha256")
          .update(canonicalJSON(manifest))
          .digest("hex"),
      },
      toolName,
    };
  }

  it("does not admit a consumer when its enabled provider fails startup", async () => {
    const consumerStartedPath = join(root, "consumer-started");
    const consumer = await writePlugin({
      id: "failed-provider-consumer",
      requires: { capabilities: ["calendar-source"] },
      entrySource: `import { writeFile } from "node:fs/promises";
export default async function createPlugin() {
  return {
    handlers: { failed_provider_consumer_ping: async () => "never" },
    start: async () => { await writeFile(${JSON.stringify(consumerStartedPath)}, "started", "utf8"); },
    stop: async () => {},
  };
}
`,
    });
    const provider = await writePlugin({
      id: "failed-provider",
      capabilities: ["calendar-source"],
      entrySource: `export default async function createPlugin() {
  return {
    handlers: { failed_provider_ping: async () => "never" },
    start: async () => { throw new Error("provider startup failed"); },
    stop: async () => {},
  };
}
`,
    });
    // The consumer deliberately appears first: manifest presence must not
    // satisfy it before the provider has successfully started.
    await writeRegistry([consumer, provider]);

    const runtime = makeRuntime();
    await runtime.startAll();

    expect(runtime.listPluginIds()).toEqual([]);
    await expect(access(consumerStartedPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(runtime.listPluginCards().find((card) => card.id === provider.id)?.loadStatus)
      .toBe("failed");
    expect(runtime.listPluginCards().find((card) => card.id === consumer.id)?.loadStatus)
      .toBe("failed");
  });

  it("starts a provider before a consumer even when the registry lists the consumer first", async () => {
    const providerReadyPath = join(root, "provider-ready");
    const consumerStartedPath = join(root, "consumer-started");
    const consumer = await writePlugin({
      id: "reverse-order-consumer",
      requires: { capabilities: ["calendar-source"] },
      entrySource: `import { access, writeFile } from "node:fs/promises";
export default async function createPlugin() {
  return {
    handlers: { reverse_order_consumer_ping: async () => "pong" },
    start: async () => {
      await access(${JSON.stringify(providerReadyPath)});
      await writeFile(${JSON.stringify(consumerStartedPath)}, "started", "utf8");
    },
    stop: async () => {},
  };
}
`,
    });
    const provider = await writePlugin({
      id: "reverse-order-provider",
      capabilities: ["calendar-source"],
      entrySource: `import { writeFile } from "node:fs/promises";
export default async function createPlugin() {
  return {
    handlers: { reverse_order_provider_ping: async () => "pong" },
    start: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      await writeFile(${JSON.stringify(providerReadyPath)}, "ready", "utf8");
    },
    stop: async () => {},
  };
}
`,
    });
    await writeRegistry([consumer, provider]);

    const runtime = makeRuntime();
    await runtime.startAll();

    expect(runtime.listPluginIds().sort()).toEqual([
      consumer.id,
      provider.id,
    ].sort());
    await expect(readFile(consumerStartedPath, "utf8")).resolves.toBe("started");
  });

  it("starts independent capability layers in parallel", async () => {
    const firstId = "parallel-start-a";
    const secondId = "parallel-start-b";
    const firstGate = deferredGate();
    const secondGate = deferredGate();
    const entered = new Set<string>();
    const testGlobals = globalThis as typeof globalThis & {
      __lvisCapabilityStartGates?: Record<string, {
        entered(): void;
        promise: Promise<void>;
      }>;
    };
    testGlobals.__lvisCapabilityStartGates = {
      [firstId]: {
        entered: () => entered.add(firstId),
        promise: firstGate.promise,
      },
      [secondId]: {
        entered: () => entered.add(secondId),
        promise: secondGate.promise,
      },
    };
    const entrySource = (id: string, toolName: string) => `export default async function createPlugin() {
  return {
    handlers: { ${JSON.stringify(toolName)}: async () => "pong" },
    start: async () => {
      const gate = globalThis.__lvisCapabilityStartGates[${JSON.stringify(id)}];
      gate.entered();
      await gate.promise;
    },
    stop: async () => {},
  };
}
`;
    const first = await writePlugin({
      id: firstId,
      entrySource: entrySource(firstId, "parallel_start_a_ping"),
    });
    const second = await writePlugin({
      id: secondId,
      entrySource: entrySource(secondId, "parallel_start_b_ping"),
    });
    await writeRegistry([first, second]);

    const runtime = makeRuntime();
    const starting = runtime.startAll();
    try {
      await vi.waitFor(() => {
        expect([...entered].sort()).toEqual([firstId, secondId]);
      });
    } finally {
      firstGate.resolve();
      secondGate.resolve();
      await starting;
      delete testGlobals.__lvisCapabilityStartGates;
    }
    expect(runtime.listPluginIds().sort()).toEqual([firstId, secondId]);
  });

  it("returns from boot while a provider prepares, then admits its blocked consumer", async () => {
    const consumer = await writePlugin({
      id: "preparing-provider-consumer",
      requires: { capabilities: ["calendar-source"] },
    });
    const provider = await writePlugin({
      id: "preparing-provider",
      capabilities: ["calendar-source"],
    });
    await writeRegistry([consumer, provider]);

    const providerPreparation = deferredGate();
    const runtime = makeRuntime(false, {
      preparePluginStart: ({ pluginId }) =>
        pluginId === provider.id ? providerPreparation.promise : undefined,
    });

    // Boot must resolve without waiting for an unbounded provider preparation.
    await runtime.startAll();
    const consumerCard = runtime.listPluginCards().find((card) => card.id === consumer.id);
    expect(consumerCard).toMatchObject({ loadStatus: "preparing", active: false });
    await expect(runtime.call(consumer.toolName)).rejects.toThrow(
      /still installing its runtime dependencies/,
    );

    const consumerReady = runtime.waitForPluginReady(consumer.id);
    let consumerReadySettled = false;
    void consumerReady.finally(() => {
      consumerReadySettled = true;
    });
    await nextTurn();
    expect(consumerReadySettled).toBe(false);

    providerPreparation.resolve();
    await expect(consumerReady).resolves.toBeUndefined();
    expect(runtime.listPluginCards().find((card) => card.id === consumer.id))
      .toMatchObject({ loadStatus: "loaded", active: true });
    await expect(runtime.call(consumer.toolName)).resolves.toBe("pong");
  });

  it("returns from cold restartAll while a provider prepares, then admits its consumer", async () => {
    const consumer = await writePlugin({
      id: "restart-preparing-provider-consumer",
      requires: { capabilities: ["calendar-source"] },
    });
    const provider = await writePlugin({
      id: "restart-preparing-provider",
      capabilities: ["calendar-source"],
    });
    await writeRegistry([consumer, provider]);

    const providerPreparation = deferredGate();
    const runtime = makeRuntime(false, {
      preparePluginStart: ({ pluginId }) =>
        pluginId === provider.id ? providerPreparation.promise : undefined,
    });

    await runtime.restartAll();
    expect(runtime.listPluginCards().find((card) => card.id === consumer.id))
      .toMatchObject({ loadStatus: "preparing", active: false });
    const consumerReady = runtime.waitForPluginReady(consumer.id);

    providerPreparation.resolve();
    await expect(consumerReady).resolves.toBeUndefined();
    await expect(runtime.call(consumer.toolName)).resolves.toBe("pong");
  });

  it("fails a blocked consumer closed when its preparing provider fails", async () => {
    const consumer = await writePlugin({
      id: "failing-preparing-provider-consumer",
      requires: { capabilities: ["calendar-source"] },
    });
    const provider = await writePlugin({
      id: "failing-preparing-provider",
      capabilities: ["calendar-source"],
    });
    await writeRegistry([consumer, provider]);

    const providerPreparation = deferredGate();
    const runtime = makeRuntime(false, {
      preparePluginStart: ({ pluginId }) =>
        pluginId === provider.id ? providerPreparation.promise : undefined,
    });
    await runtime.startAll();
    const consumerReady = runtime.waitForPluginReady(consumer.id);

    providerPreparation.reject(new Error("provider preparation failed"));
    await expect(consumerReady).rejects.toThrow(
      /missing required capabilities: calendar-source/,
    );
    await vi.waitFor(() => {
      expect(runtime.listPluginCards().find((card) => card.id === consumer.id))
        .toMatchObject({ loadStatus: "failed", active: false });
    });
    await expect(runtime.call(consumer.toolName)).rejects.toThrow(/not found/);
  });

  it("keeps waiting when only one of multiple preparing capability providers settles", async () => {
    const consumer = await writePlugin({
      id: "multi-preparing-consumer",
      requires: { capabilities: ["calendar-source", "contacts-source"] },
    });
    const calendarProvider = await writePlugin({
      id: "multi-calendar-provider",
      capabilities: ["calendar-source"],
    });
    const contactsProvider = await writePlugin({
      id: "multi-contacts-provider",
      capabilities: ["contacts-source"],
    });
    await writeRegistry([consumer, calendarProvider, contactsProvider]);

    const calendarPreparation = deferredGate();
    const contactsPreparation = deferredGate();
    const runtime = makeRuntime(false, {
      preparePluginStart: ({ pluginId }) => {
        if (pluginId === calendarProvider.id) return calendarPreparation.promise;
        if (pluginId === contactsProvider.id) return contactsPreparation.promise;
        return undefined;
      },
    });
    await runtime.startAll();
    const consumerReady = runtime.waitForPluginReady(consumer.id);
    let consumerReadySettled = false;
    void consumerReady.finally(() => {
      consumerReadySettled = true;
    });

    calendarPreparation.resolve();
    await expect(runtime.waitForPluginReady(calendarProvider.id)).resolves.toBeUndefined();
    await nextTurn();
    expect(consumerReadySettled).toBe(false);
    expect(runtime.listPluginCards().find((card) => card.id === consumer.id))
      .toMatchObject({ loadStatus: "preparing", active: false });

    contactsPreparation.resolve();
    await expect(consumerReady).resolves.toBeUndefined();
    await expect(runtime.call(consumer.toolName)).resolves.toBe("pong");
  });

  it("does not resurrect a removed consumer when its old provider wait settles", async () => {
    const consumer = await writePlugin({
      id: "removed-preparing-consumer",
      requires: { capabilities: ["calendar-source"] },
    });
    const provider = await writePlugin({
      id: "removed-preparing-provider",
      capabilities: ["calendar-source"],
    });
    await writeRegistry([consumer, provider]);

    const providerPreparation = deferredGate();
    const runtime = makeRuntime(false, {
      preparePluginStart: ({ pluginId }) =>
        pluginId === provider.id ? providerPreparation.promise : undefined,
    });
    await runtime.startAll();
    const oldConsumerReady = runtime.waitForPluginReady(consumer.id);

    await runtime.removePlugin(consumer.id);
    await expect(oldConsumerReady).rejects.toThrow(/cancelled by removal/);
    providerPreparation.resolve();
    await expect(runtime.waitForPluginReady(provider.id)).resolves.toBeUndefined();
    await nextTurn();

    expect(runtime.listPluginIds()).toEqual([provider.id]);
    await expect(runtime.call(consumer.toolName)).rejects.toThrow(/not found/);
  });

  it("keeps an old blocked retry from starting a reinstalled consumer twice", async () => {
    const startsPath = join(root, "reinstalled-consumer-starts");
    const consumer = await writePlugin({
      id: "reinstalled-preparing-consumer",
      requires: { capabilities: ["calendar-source"] },
      entrySource: `import { appendFile } from "node:fs/promises";
export default async function createPlugin() {
  return {
    handlers: { reinstalled_preparing_consumer_ping: async () => "pong" },
    start: async () => { await appendFile(${JSON.stringify(startsPath)}, "x", "utf8"); },
    stop: async () => {},
  };
}
`,
    });
    const provider = await writePlugin({
      id: "reinstalled-preparing-provider",
      capabilities: ["calendar-source"],
    });
    await writeRegistry([consumer, provider]);

    const providerPreparation = deferredGate();
    const runtime = makeRuntime(false, {
      preparePluginStart: ({ pluginId }) =>
        pluginId === provider.id ? providerPreparation.promise : undefined,
    });
    await runtime.startAll();
    const oldConsumerReady = runtime.waitForPluginReady(consumer.id);
    await runtime.removePlugin(consumer.id);
    await expect(oldConsumerReady).rejects.toThrow(/cancelled by removal/);

    await expect(runtime.addPlugin(consumer.id)).resolves.toBe("preparing");
    const reinstalledReady = runtime.waitForPluginReady(consumer.id);

    providerPreparation.resolve();
    await expect(reinstalledReady).resolves.toBeUndefined();
    await expect(readFile(startsPath, "utf8")).resolves.toBe("x");
    await expect(runtime.call(consumer.toolName)).resolves.toBe("pong");
  });

  it("serializes a blocked consumer retry with a queued remove and reinstall", async () => {
    const consumerStartGate = deferredGate();
    const consumerStartEntered = deferredGate();
    const testGlobals = globalThis as typeof globalThis & {
      __lvisCapabilityRetryStartGate?: {
        entered(): void;
        promise: Promise<void>;
      };
    };
    testGlobals.__lvisCapabilityRetryStartGate = {
      entered: consumerStartEntered.resolve,
      promise: consumerStartGate.promise,
    };
    const consumer = await writePlugin({
      id: "queued-retry-consumer",
      requires: { capabilities: ["calendar-source"] },
      entrySource: `export default async function createPlugin() {
  return {
    handlers: { queued_retry_consumer_ping: async () => "pong" },
    start: async () => {
      globalThis.__lvisCapabilityRetryStartGate.entered();
      await globalThis.__lvisCapabilityRetryStartGate.promise;
    },
    stop: async () => {},
  };
}
`,
    });
    const provider = await writePlugin({
      id: "queued-retry-provider",
      capabilities: ["calendar-source"],
    });
    await writeRegistry([consumer, provider]);

    const providerPreparation = deferredGate();
    const runtime = makeRuntime(false, {
      preparePluginStart: ({ pluginId }) =>
        pluginId === provider.id ? providerPreparation.promise : undefined,
    });
    let removing: Promise<void> | undefined;
    try {
      await runtime.startAll();
      providerPreparation.resolve();
      await expect(runtime.waitForPluginReady(provider.id)).resolves.toBeUndefined();
      await consumerStartEntered.promise;

      let removeSettled = false;
      removing = runtime.removePlugin(consumer.id).then(() => {
        removeSettled = true;
      });
      await nextTurn();
      // The start retry holds the same reentrant lifecycle lock, so removal
      // waits rather than tearing down/replacing its candidate mid-start.
      expect(removeSettled).toBe(false);

      consumerStartGate.resolve();
      await removing;
      expect(runtime.listPluginIds()).toEqual([provider.id]);

      await expect(runtime.addPlugin(consumer.id)).resolves.toBe("started");
      await expect(runtime.call(consumer.toolName)).resolves.toBe("pong");
    } finally {
      consumerStartGate.resolve();
      await removing;
      delete testGlobals.__lvisCapabilityRetryStartGate;
    }
  });

  it("cancels a blocked consumer on direct disable before its provider settles", async () => {
    const consumer = await writePlugin({
      id: "disabled-preparing-consumer",
      requires: { capabilities: ["calendar-source"] },
    });
    const provider = await writePlugin({
      id: "disabled-preparing-provider",
      capabilities: ["calendar-source"],
    });
    await writeRegistry([consumer, provider]);

    const providerPreparation = deferredGate();
    const runtime = makeRuntime(false, {
      preparePluginStart: ({ pluginId }) =>
        pluginId === provider.id ? providerPreparation.promise : undefined,
    });
    await runtime.startAll();
    const consumerReady = runtime.waitForPluginReady(consumer.id);

    await runtime.disable(consumer.id);
    await expect(consumerReady).rejects.toThrow(/cancelled by disable/);
    providerPreparation.resolve();
    await expect(runtime.waitForPluginReady(provider.id)).resolves.toBeUndefined();
    await nextTurn();

    expect(runtime.listPluginIds()).toEqual([provider.id]);
    await expect(runtime.call(consumer.toolName)).rejects.toThrow(/not found/);
  });

  it("removes an unpublished blocked candidate with the real bundle lifecycle", async () => {
    const fixture = await makeRealLifecycleBlockedRuntime();
    const ready = fixture.runtime.waitForPluginReady(fixture.consumer.id);

    await expect(fixture.runtime.removePlugin(fixture.consumer.id)).resolves.toBeUndefined();
    await expect(ready).rejects.toThrow(/cancelled by removal/);
    await resolveRealLifecycleProvider(fixture);
  });

  it("retains an unpublished candidate root when its direct cleanup cannot stop", async () => {
    const fixture = await makeRealLifecycleBlockedRuntime({
      consumerEntrySource: `export default async function createPlugin() {
  return {
    handlers: { real_lifecycle_blocked_consumer_ping: async () => "pong" },
    start: async () => {},
    stop: async () => { throw new Error("candidate stop failed"); },
  };
}
`,
    });
    const oldRuntime = fixture.runtime.getRuntimeGenerationProjection(fixture.consumer.id);
    expect(oldRuntime).toBeDefined();

    await expect(fixture.runtime.removePlugin(fixture.consumer.id)).rejects.toThrow(
      /unpublished plugin candidate stop failed/,
    );
    await expect(access(oldRuntime!.pluginRoot)).resolves.toBeUndefined();

    fixture.providerPreparation.resolve();
    await expect(fixture.runtime.waitForPluginReady(fixture.provider.id)).resolves.toBeUndefined();
    await nextTurn();
    expect(fixture.runtime.listPluginIds()).not.toContain(fixture.consumer.id);
  });

  it("directly disables an unpublished blocked candidate with the real bundle lifecycle", async () => {
    const fixture = await makeRealLifecycleBlockedRuntime();
    const ready = fixture.runtime.waitForPluginReady(fixture.consumer.id);

    await expect(fixture.runtime.disable(fixture.consumer.id)).resolves.toBeUndefined();
    await expect(ready).rejects.toThrow(/cancelled by disable/);
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
      plugins: Array<{ id: string; enabled?: boolean }>;
    };
    expect(registry.plugins.find((entry) => entry.id === fixture.consumer.id)?.enabled).toBe(false);
    await resolveRealLifecycleProvider(fixture);
  });

  it("lets the UI-facing enabled toggle cancel an unpublished blocked candidate", async () => {
    const activeChanges: Array<{ pluginId: string; enabled: boolean }> = [];
    const fixture = await makeRealLifecycleBlockedRuntime({
      onActiveStateChange: (pluginId, enabled) => { activeChanges.push({ pluginId, enabled }); },
    });
    const ready = fixture.runtime.waitForPluginReady(fixture.consumer.id);

    await expect(fixture.runtime.setPluginEnabled(fixture.consumer.id, false)).resolves.toBeUndefined();
    await expect(ready).rejects.toThrow(/cancelled by disable/);
    expect(activeChanges).toEqual([{ pluginId: fixture.consumer.id, enabled: false }]);
    expect(fixture.runtime.listPluginCards().find((card) => card.id === fixture.consumer.id))
      .toMatchObject({ runtimeLoaded: false, loadStatus: "disabled", active: false });
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
      plugins: Array<{ id: string; enabled?: boolean }>;
    };
    expect(registry.plugins.find((entry) => entry.id === fixture.consumer.id)?.enabled).toBe(false);
    await resolveRealLifecycleProvider(fixture);
  });

  it("atomically uninstalls an unpublished blocked candidate after durable commit", async () => {
    const fixture = await makeRealLifecycleBlockedRuntime();
    const ready = fixture.runtime.waitForPluginReady(fixture.consumer.id);
    const durableFailure = vi.fn(async () => { throw new Error("durable removal failed"); });

    await expect(
      fixture.runtime.removePluginWithCommit(fixture.consumer.id, durableFailure),
    ).rejects.toThrow("durable removal failed");
    expect(fixture.runtime.listPluginIds()).toContain(fixture.consumer.id);

    const durableCommit = vi.fn(async () => "removed");
    await expect(
      fixture.runtime.removePluginWithCommit(fixture.consumer.id, durableCommit),
    ).resolves.toBe("removed");
    expect(durableCommit).toHaveBeenCalledOnce();
    await expect(ready).rejects.toThrow(/cancelled by removal/);
    await resolveRealLifecycleProvider(fixture);
  });

  it("replaces and retires an unpublished blocked candidate after prepared durable commit", async () => {
    const oldStopPath = join(root, "prepared-replacement-old-stop");
    const oldDisposer = vi.fn();
    const fixture = await makeRealLifecycleBlockedRuntime({
      consumerEntrySource: `import { writeFile } from "node:fs/promises";
export default async function createPlugin() {
  return {
    handlers: { real_lifecycle_blocked_consumer_ping: async () => "pong" },
    start: async () => {},
    stop: async () => { await writeFile(${JSON.stringify(oldStopPath)}, "stopped", "utf8"); },
  };
}
`,
      onConsumerHostApiReady: (registerDisposer) => registerDisposer(oldDisposer),
    });
    const oldRuntime = fixture.runtime.getRuntimeGenerationProjection(fixture.consumer.id);
    expect(oldRuntime).toBeDefined();
    const oldReady = fixture.runtime.waitForPluginReady(fixture.consumer.id);
    const prepared = await writePreparedUnblockedReplacement(fixture.consumer);
    const durableCommit = vi.fn(async () => "prepared-committed");

    const committed = await fixture.runtime.activatePreparedArtifact({
      ...prepared,
      durableCommit,
    });

    expect(committed.result).toBe("prepared-committed");
    expect(durableCommit).toHaveBeenCalledOnce();
    await expect(oldReady).rejects.toThrow(/superseded by prepared activation/);
    expect(fixture.lifecycle.getActive(fixture.consumer.id)).toBeDefined();
    expect(fixture.runtime.getPluginManifest(fixture.consumer.id)).toMatchObject({
      version: "1.0.1",
    });
    await expect(fixture.runtime.call(prepared.toolName)).resolves.toBe("replacement-pong");

    await committed.retirement;
    await expect(access(oldRuntime!.pluginRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(oldStopPath, "utf8")).resolves.toBe("stopped");
    expect(oldDisposer).toHaveBeenCalledOnce();

    // The old provider watcher is still allowed to settle, but must not revive
    // the superseded requirement-bearing candidate over the active replacement.
    fixture.providerPreparation.resolve();
    await expect(fixture.runtime.waitForPluginReady(fixture.provider.id)).resolves.toBeUndefined();
    await nextTurn();
    await expect(fixture.runtime.call(prepared.toolName)).resolves.toBe("replacement-pong");
    await expect(fixture.runtime.call(fixture.consumer.toolName)).rejects.toThrow(/not found/);
  });

  it("reports failed old-candidate cleanup through prepared replacement retirement", async () => {
    const fixture = await makeRealLifecycleBlockedRuntime({
      consumerEntrySource: `export default async function createPlugin() {
  return {
    handlers: { real_lifecycle_blocked_consumer_ping: async () => "pong" },
    start: async () => {},
    stop: async () => { throw new Error("prepared replacement old stop failed"); },
  };
}
`,
    });
    const oldRuntime = fixture.runtime.getRuntimeGenerationProjection(fixture.consumer.id);
    expect(oldRuntime).toBeDefined();
    const oldReady = fixture.runtime.waitForPluginReady(fixture.consumer.id);
    const prepared = await writePreparedUnblockedReplacement(fixture.consumer);

    const committed = await fixture.runtime.activatePreparedArtifact({
      ...prepared,
      durableCommit: async () => "prepared-committed",
    });

    expect(committed.result).toBe("prepared-committed");
    expect(fixture.lifecycle.getActive(fixture.consumer.id)).toBeDefined();
    await expect(oldReady).rejects.toThrow(/superseded by prepared activation/);
    await expect(fixture.runtime.call(prepared.toolName)).resolves.toBe("replacement-pong");
    await expect(committed.retirement).rejects.toThrow(
      /unpublished plugin candidate stop failed/,
    );
    await expect(access(oldRuntime!.pluginRoot)).resolves.toBeUndefined();

    fixture.providerPreparation.resolve();
    await expect(fixture.runtime.waitForPluginReady(fixture.provider.id)).resolves.toBeUndefined();
    await nextTurn();
    await expect(fixture.runtime.call(prepared.toolName)).resolves.toBe("replacement-pong");
  });

  it("keeps an unpublished blocked candidate retryable when prepared durable commit fails", async () => {
    const oldStopPath = join(root, "prepared-durable-failure-old-stop");
    const oldDisposer = vi.fn();
    const fixture = await makeRealLifecycleBlockedRuntime({
      consumerEntrySource: `import { writeFile } from "node:fs/promises";
export default async function createPlugin() {
  return {
    handlers: { real_lifecycle_blocked_consumer_ping: async () => "pong" },
    start: async () => {},
    stop: async () => { await writeFile(${JSON.stringify(oldStopPath)}, "stopped", "utf8"); },
  };
}
`,
      onConsumerHostApiReady: (registerDisposer) => registerDisposer(oldDisposer),
    });
    const oldRuntime = fixture.runtime.getRuntimeGenerationProjection(fixture.consumer.id);
    expect(oldRuntime).toBeDefined();
    const oldReady = fixture.runtime.waitForPluginReady(fixture.consumer.id);
    const prepared = await writePreparedUnblockedReplacement(fixture.consumer);
    const durableCommit = vi.fn(async () => { throw new Error("prepared durable commit failed"); });

    await expect(fixture.runtime.activatePreparedArtifact({
      ...prepared,
      durableCommit,
    })).rejects.toThrow("prepared durable commit failed");
    expect(durableCommit).toHaveBeenCalledOnce();
    expect(fixture.lifecycle.getActive(fixture.consumer.id)).toBeUndefined();
    await expect(access(oldRuntime!.pluginRoot)).resolves.toBeUndefined();
    await expect(access(oldStopPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(oldDisposer).not.toHaveBeenCalled();

    let oldReadySettled = false;
    void oldReady.finally(() => { oldReadySettled = true; });
    await nextTurn();
    expect(oldReadySettled).toBe(false);

    fixture.providerPreparation.resolve();
    await expect(oldReady).resolves.toBeUndefined();
    await expect(fixture.runtime.call(fixture.consumer.toolName)).resolves.toBe("pong");
    await expect(fixture.runtime.call(prepared.toolName)).rejects.toThrow(/not found/);
  });

  it("uses an alternative active provider when disabling one provider", async () => {
    const firstProvider = await writePlugin({
      id: "alternative-provider-a",
      capabilities: ["calendar-source"],
    });
    const secondProvider = await writePlugin({
      id: "alternative-provider-b",
      capabilities: ["calendar-source"],
    });
    const consumer = await writePlugin({
      id: "alternative-provider-consumer",
      requires: { capabilities: ["calendar-source"] },
    });
    await writeRegistry([consumer, firstProvider, secondProvider]);

    const runtime = makeRuntime();
    await runtime.startAll();
    await expect(runtime.disable(firstProvider.id)).resolves.toBeUndefined();

    expect(runtime.listPluginIds().sort()).toEqual([
      consumer.id,
      secondProvider.id,
    ].sort());
    await expect(runtime.call(consumer.toolName)).resolves.toBe("pong");
  });

  it("rejects a provider restart that would remove an active consumer's sole capability", async () => {
    const provider = await writePlugin({
      id: "restart-capability-provider",
      capabilities: ["calendar-source"],
    });
    const consumer = await writePlugin({
      id: "restart-capability-consumer",
      capabilities: ["calendar-source"],
      requires: { capabilities: ["calendar-source"] },
    });
    await writeRegistry([consumer, provider]);

    const runtime = makeRuntime();
    await runtime.startAll();
    const replacementManifest = { ...provider.manifest };
    delete replacementManifest.capabilities;
    await writeFile(
      provider.manifestPath,
      JSON.stringify(replacementManifest),
      "utf8",
    );

    await expect(runtime.restartPlugin(provider.id)).resolves.toBe("failed");
    await expect(runtime.call(consumer.toolName)).resolves.toBe("pong");
    expect(runtime.getPluginManifest(provider.id)?.capabilities).toEqual([
      "calendar-source",
    ]);
  });

  it("allows a capability-removing provider restart when an alternative provider is active", async () => {
    const firstProvider = await writePlugin({
      id: "restart-alternative-provider-a",
      capabilities: ["calendar-source"],
    });
    const secondProvider = await writePlugin({
      id: "restart-alternative-provider-b",
      capabilities: ["calendar-source"],
    });
    const consumer = await writePlugin({
      id: "restart-alternative-consumer",
      requires: { capabilities: ["calendar-source"] },
    });
    await writeRegistry([consumer, firstProvider, secondProvider]);

    const runtime = makeRuntime();
    await runtime.startAll();
    const replacementManifest = { ...firstProvider.manifest };
    delete replacementManifest.capabilities;
    await writeFile(
      firstProvider.manifestPath,
      JSON.stringify(replacementManifest),
      "utf8",
    );

    await expect(runtime.restartPlugin(firstProvider.id)).resolves.toBe("started");
    expect(runtime.getPluginManifest(firstProvider.id)?.capabilities).toBeUndefined();
    await expect(runtime.call(consumer.toolName)).resolves.toBe("pong");
  });

  it("blocks a prepared provider replacement that removes a sole active capability", async () => {
    const provider = await writePlugin({
      id: "prepared-replacement-provider",
      capabilities: ["calendar-source"],
    });
    const consumer = await writePlugin({
      id: "prepared-replacement-consumer",
      capabilities: ["calendar-source"],
      requires: { capabilities: ["calendar-source"] },
    });
    await writeRegistry([consumer, provider]);
    await writeReceipt(provider);
    await writeReceipt(consumer);

    const runtime = makeRuntime(true);
    await runtime.startAll();
    const stagingRoot = join(root, "prepared-provider-replacement");
    const replacementManifest = { ...provider.manifest };
    delete replacementManifest.capabilities;
    await mkdir(stagingRoot, { recursive: true });
    await writeFile(
      join(stagingRoot, "plugin.json"),
      JSON.stringify(agentPluginsDocument(replacementManifest)),
      "utf8");
    await writeFile(
      join(stagingRoot, "entry.mjs"),
      `export default async function createPlugin() {
  return { handlers: { prepared_replacement_provider_ping: async () => "pong" } };
}
`,
      "utf8",
    );
    const durableCommit = vi.fn(async () => "must-not-commit");

    await expect(runtime.activatePreparedArtifact({
      installId: provider.id,
      pluginRoot: stagingRoot,
      manifest: replacementManifest,
      receiptRaw: "not-reached-before-dependency-preflight",
      registryEntry: {
        installSource: "user",
        manifestSha256: createHash("sha256")
          .update(canonicalJSON(replacementManifest))
          .digest("hex"),
      },
      durableCommit,
    })).rejects.toThrow(
      "prepared artifact activation blocked — active dependents require capabilities",
    );
    expect(durableCommit).not.toHaveBeenCalled();
    await expect(runtime.call(consumer.toolName)).resolves.toBe("pong");
  });

  it("does not let a self-capable consumer keep its sole provider removable", async () => {
    const provider = await writePlugin({
      id: "sole-provider",
      capabilities: ["calendar-source"],
    });
    const consumer = await writePlugin({
      id: "sole-provider-consumer",
      capabilities: ["calendar-source"],
      requires: { capabilities: ["calendar-source"] },
    });
    await writeRegistry([consumer, provider]);
    await writeReceipt(provider);
    await writeReceipt(consumer);

    const runtime = makeRuntime(true);
    await runtime.startAll();

    await expect(runtime.setPluginEnabled(provider.id, false)).rejects.toThrow(
      "plugin disable blocked — active dependents require capabilities",
    );
    await expect(runtime.disable(provider.id)).rejects.toThrow(
      "plugin disable blocked — active dependents require capabilities",
    );
    await expect(runtime.removePlugin(provider.id)).rejects.toThrow(
      "plugin remove blocked — active dependents require capabilities",
    );
    const durableRemoval = vi.fn(async () => "must-not-commit");
    await expect(
      runtime.removePluginWithCommit(provider.id, durableRemoval),
    ).rejects.toThrow(
      "plugin remove blocked — active dependents require capabilities",
    );
    expect(durableRemoval).not.toHaveBeenCalled();
    expect(runtime.listPluginIds().sort()).toEqual([consumer.id, provider.id].sort());
    await expect(runtime.call(consumer.toolName)).resolves.toBe("pong");
  });

  it("rechecks provider removal after a consumer is admitted during its commit race", async () => {
    const provider = await writePlugin({
      id: "commit-race-provider",
      capabilities: ["calendar-source"],
    });
    const consumer = await writePlugin({
      id: "commit-race-consumer",
      requires: { capabilities: ["calendar-source"] },
    });
    await writeRegistry([provider, { ...consumer, enabled: false }]);

    const runtime = makeRuntime();
    await runtime.startAll();
    await writeRegistry([provider, consumer]);

    const providerRemovalEntered = deferredGate();
    const allowProviderRemoval = deferredGate();
    const baseLifecycle = runtime.getGenerationAccess() as unknown as
      TestGenerationLifecycle & Record<string, unknown>;
    runtime.setGenerationAccess({
      ...baseLifecycle,
      deactivateWithCommit: async <T>(
        pluginId: string,
        durableCommit: () => Promise<T>,
        commitScope?: GenerationCommitScope,
      ) => {
        if (pluginId === provider.id) {
          providerRemovalEntered.resolve();
          await allowProviderRemoval.promise;
        }
        return baseLifecycle.deactivateWithCommit(
          pluginId,
          durableCommit,
          commitScope,
        );
      },
    } as never);

    const removingProvider = runtime.removePlugin(provider.id);
    try {
      await providerRemovalEntered.promise;
      await expect(runtime.addPlugin(consumer.id)).resolves.toBe("started");

      allowProviderRemoval.resolve();
      await expect(removingProvider).rejects.toThrow(
        "plugin remove blocked — active dependents require capabilities",
      );
    } finally {
      allowProviderRemoval.resolve();
      await removingProvider.catch(() => undefined);
    }
    await expect(runtime.call(provider.toolName)).resolves.toBe("pong");
    await expect(runtime.call(consumer.toolName)).resolves.toBe("pong");
  });

  it("restartAll removes active consumers before providers removed from the registry", async () => {
    const provider = await writePlugin({
      id: "restart-removal-provider",
      capabilities: ["calendar-source"],
    });
    const consumer = await writePlugin({
      id: "restart-removal-consumer",
      requires: { capabilities: ["calendar-source"] },
    });
    // Provider insertion first reproduces the former provider-first teardown.
    await writeRegistry([provider, consumer]);

    const runtime = makeRuntime();
    await runtime.startAll();
    await writeRegistry([
      { ...provider, enabled: false },
      { ...consumer, enabled: false },
    ]);

    await expect(runtime.restartAll()).resolves.toBeUndefined();
    expect(runtime.listPluginIds()).toEqual([]);
  });

  it("does not let a failed provider satisfy re-enable or prepared Marketplace activation", async () => {
    const provider = await writePlugin({
      id: "failed-active-provider",
      capabilities: ["calendar-source"],
      entrySource: `export default async function createPlugin() {
  return {
    handlers: { failed_active_provider_ping: async () => "never" },
    start: async () => { throw new Error("provider startup failed"); },
    stop: async () => {},
  };
}
`,
    });
    const disabledConsumer = await writePlugin({
      id: "reenable-consumer",
      requires: { capabilities: ["calendar-source"] },
    });
    await writeRegistry([
      { ...disabledConsumer, enabled: false },
      provider,
    ]);
    await writeReceipt(provider);
    await writeReceipt(disabledConsumer);

    const runtime = makeRuntime(true);
    await runtime.startAll();
    expect(runtime.listPluginIds()).toEqual([]);

    await expect(
      runtime.setPluginEnabled(disabledConsumer.id, true),
    ).rejects.toThrow(
      "plugin re-enable blocked — missing required capabilities: calendar-source",
    );

    const prepared = await writePreparedConsumer();
    const durableCommit = vi.fn(async () => "must-not-commit");
    await expect(runtime.activatePreparedArtifact({
      ...prepared,
      durableCommit,
    })).rejects.toThrow(
      "prepared artifact activation blocked — missing required capabilities: calendar-source",
    );
    expect(durableCommit).not.toHaveBeenCalled();
  });

  it("orders cold restartAll activation by active provider availability", async () => {
    const consumer = await writePlugin({
      id: "restart-order-consumer",
      requires: { capabilities: ["calendar-source"] },
    });
    const provider = await writePlugin({
      id: "restart-order-provider",
      capabilities: ["calendar-source"],
    });
    await writeRegistry([consumer, provider]);

    const runtime = makeRuntime();
    await expect(runtime.restartAll()).resolves.toBeUndefined();

    expect(runtime.listPluginIds().sort()).toEqual([
      consumer.id,
      provider.id,
    ].sort());
    await expect(runtime.call(consumer.toolName)).resolves.toBe("pong");
  });
});
