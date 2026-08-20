/**
 * What happens to a `config.onChange` listener that THROWS, on the real host.
 *
 * The member wraps the plugin's callback in the generation scope, and the
 * wrapper is asynchronous — so the failure does not travel back into
 * `emitPluginConfigChange`'s per-listener try/catch the way a synchronous
 * listener's does. Before `wrapListener` existed the wrapped promise was
 * discarded with `void`, which left the rejection with nothing attached: this
 * process installs no `unhandledRejection` handler, so on Node's defaults one
 * plugin listener ended the Electron main process.
 *
 * The out-of-process boundary reaches this on purpose — `encodeConfigChange`
 * REFUSES a value JSON cannot carry rather than delivering a payload the plugin
 * would read as "the key was cleared" — which is what makes the containment
 * load-bearing rather than hypothetical.
 *
 * Driven through `createHostApiFactory` itself rather than a reconstruction of
 * it: the defect was in how that file used the wrapper, so a harness that wired
 * the wrapper its own way would have proven nothing about the shipped call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostApiFactory } from "../host-api-factory.js";
import { HostApiGenerationScope } from "../../../../plugins/plugin-host-effect-scope.js";
import type { PluginRuntimeGenerationAccess } from "../../../../plugins/plugin-host-generation.js";
import type { PluginHostApiIncarnation } from "../../../../plugins/runtime/index.js";
import type { PluginManifest } from "../../../../plugins/types.js";
import {
  emitPluginConfigChange,
  _resetPluginConfigChangeBus,
} from "../../../../plugins/config-change-bus.js";

const PLUGIN_ID = "work-assistant";
const GENERATION_ID = "generation-under-test";

const MANIFEST = {
  id: PLUGIN_ID,
  name: "Work Assistant",
  version: "0.10.14",
  entry: "plugin.mjs",
  description: "subscribes to one config key",
  tools: [],
} as unknown as PluginManifest;

/**
 * The generation admission the scope leases against.
 *
 * Copied in shape from `plugin-host-effect-scope.test.ts`'s fake for the same
 * reason it exists there: the lease machinery is not what this case is about,
 * and standing up the real coordinator would put its scheduling between the
 * throw and the assertion.
 */
function generationAccess(): PluginRuntimeGenerationAccess {
  return {
    getActive: vi.fn(() => undefined),
    isExactAdmitted: vi.fn((_pluginId, generationId) => generationId === GENERATION_ID),
    acquire: vi.fn(async () => { throw new Error("not used"); }),
    acquireExact: vi.fn(async (_pluginId, generationId) => {
      if (generationId !== GENERATION_ID) throw new Error("not active");
      return { generation: { generationId } as never, release: vi.fn() };
    }),
    runWithLease: vi.fn(async (_lease, operation) => operation()),
  } as unknown as PluginRuntimeGenerationAccess;
}

/**
 * Only the deps `config.onChange` and the factory's own construction reach.
 *
 * Every other member of `CreateHostApiFactoryDeps` is a closure capture that
 * this case never calls, and filling them with working fakes would hide which
 * ones the path actually touches — the same argument the isolation suites make
 * for their partial hostApi casts.
 */
function hostApiUnderTest(pluginDataDir: string): {
  api: ReturnType<ReturnType<typeof createHostApiFactory>>;
  scope: HostApiGenerationScope;
} {
  const scope = new HostApiGenerationScope(PLUGIN_ID);
  const incarnation: PluginHostApiIncarnation = {
    registerDisposer: () => undefined,
    trackOperation: <T>(operation: Promise<T>) => operation,
    isActive: () => true,
    isLifecycleHookActive: () => true,
    generationScope: scope,
  };
  const factory = createHostApiFactory({
    getPluginRuntime: () => ({
      getApprovedPluginAccess: () => undefined,
      listPluginIds: () => [PLUGIN_ID],
      getWildcardConfigOverride: () => ({}),
    }),
    lateBinding: {},
    getRegistryEntry: () => undefined,
    hostClassifiesRiskEnabled: () => true,
    pluginShutdownHandlers: [],
    readAppPreference: () => undefined,
    settingsService: { getPluginConfig: () => ({}) },
    bootAuditLogger: { log: () => undefined },
    pluginRuntimeAuditLog: () => undefined,
    networkFetch: (() => { throw new Error("not used"); }) as unknown as typeof fetch,
    mainWindow: {},
    openAuthWindowService: async () => [],
    openLinkWindowService: async () => undefined,
    openAuthPartitionViewerService: async () => undefined,
    clearAuthPartitionService: async () => undefined,
    shellOpenExternal: async () => undefined,
    approvalGate: {},
    routinesStore: {},
  } as never);
  const api = factory(PLUGIN_ID, MANIFEST, pluginDataDir, incarnation, null, undefined, null);
  scope.bindGeneration(generationAccess(), GENERATION_ID);
  scope.publish();
  return { api, scope };
}

let temporaryRoot: string | undefined;

beforeEach(() => {
  _resetPluginConfigChangeBus();
  temporaryRoot = mkdtempSync(join(tmpdir(), "host-api-listener-"));
});

afterEach(() => {
  _resetPluginConfigChangeBus();
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
});

describe("a config.onChange listener that throws, on the real host member", () => {
  it("is reported and contained rather than left for the process", async () => {
    const { api } = hostApiUnderTest(temporaryRoot!);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      api.config.onChange("apiKey", () => {
        // What `encodeConfigChange` does for a value JSON cannot carry. The
        // out-of-process host handler registers exactly this shape of callback.
        throw new Error("value cannot cross the boundary");
      });
      emitPluginConfigChange(PLUGIN_ID, "apiKey", new Date());
      // Node reports an unhandled rejection on the macrotask AFTER the
      // microtask queue drains, so a turn of the timer queue is what makes
      // "nobody attached a handler" observable at all. Awaiting only
      // microtasks here would pass with the defect present.
      await new Promise((settle) => setTimeout(settle, 20));
      expect(unhandled).toEqual([]);
      expect(
        warn.mock.calls.some((call) =>
          call.some((argument) =>
            typeof argument === "string" && argument.includes("host listener failed"),
          ),
        ),
      ).toBe(true);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      warn.mockRestore();
    }
  });

  it("keeps delivering to the listeners that did not throw", async () => {
    const { api } = hostApiUnderTest(temporaryRoot!);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const delivered: unknown[] = [];
    try {
      api.config.onChange("apiKey", () => {
        throw new Error("value cannot cross the boundary");
      });
      api.config.onChange("apiKey", (value) => { delivered.push(value); });
      emitPluginConfigChange(PLUGIN_ID, "apiKey", "plain-text");
      await new Promise((settle) => setTimeout(settle, 20));
      expect(delivered).toEqual(["plain-text"]);
    } finally {
      warn.mockRestore();
    }
  });
});
