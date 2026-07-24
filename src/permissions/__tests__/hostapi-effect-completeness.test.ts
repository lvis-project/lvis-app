/**
 * hostapi-effect-completeness.test.ts
 *
 * The lever that ENDS the per-method whack-a-mole. The host asserts
 * `hostObservable:true` for every in-process plugin tool, so EVERY
 * function-valued hostApi method a plugin can call must be classified in the
 * effect SOT — otherwise a mutation reached through an unmapped method records
 * an empty ledger and surfaces as a confirmed READ (a fail-open seed for the
 * future read-recognition gate).
 *
 * This test constructs the REAL hostApi object via the production
 * `createHostApi` factory (captured from `initPluginRuntime`), recursively
 * collects every function-valued leaf method PATH, and asserts each is present
 * in {@link HOSTAPI_EFFECT_BY_PATH}. It fails on ANY unmapped method — including
 * a future-added one — so structural coverage is enforced mechanically rather
 * than rediscovered round-by-round in review.
 *
 * It also pins the runtime backstop: the recording wrapper records a
 * fail-closed `unclassifiedHostApiMethod` WRITE for an unmapped path, and is a
 * PURE side-effect (it never alters the wrapped method's behavior).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const harness = vi.hoisted(() => ({
  capturedRuntimeOptions: null as Record<string, unknown> | null,
  readPluginRegistry: vi.fn(async () => ({ version: 1, plugins: [] })),
  appPrependOnceListener: vi.fn(),
  runtime: {
    startAll: vi.fn(async () => {}),
    listToolNames: vi.fn(() => [] as string[]),
    listPluginIds: vi.fn(() => [] as string[]),
    listPluginManifests: vi.fn(() => [] as Array<{ pluginId: string; manifest: unknown }>),
    getPluginRoot: vi.fn((pluginId: string) => `/tmp/lvis-test/plugins/${pluginId}`),
    getPluginManifest: vi.fn(() => null),
    resolvePluginInstallId: vi.fn((pluginId: string) => pluginId),
    isPluginEnabled: vi.fn(() => true),
    getApprovedPluginAccess: vi.fn(() => undefined),
    registerDisposer: vi.fn(),
    resolveToolOwner: vi.fn((toolName: string) => `${toolName}-owner`),
  },
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp/lvis-test"),
    isPackaged: false,
    prependOnceListener: harness.appPrependOnceListener,
  },
  BrowserWindow: Object.assign(vi.fn(), {
    getAllWindows: vi.fn(() => []),
    getFocusedWindow: vi.fn(() => null),
  }),
  shell: { openExternal: vi.fn() },
}));

vi.mock("../../plugins/runtime.js", () => ({
  PluginRuntime: vi.fn().mockImplementation(function (this: unknown, options: Record<string, unknown>) {
    harness.capturedRuntimeOptions = options;
    return harness.runtime;
  }),
}));

vi.mock("../../plugins/dev-watcher.js", () => ({
  startPluginDevWatcher: vi.fn(() => ({ stop: vi.fn() })),
}));

vi.mock("../../main/html-preview-partition.js", () => ({
  installPluginPartitionPolicy: vi.fn(),
}));

vi.mock("../../plugins/plugin-paths.js", () => ({
  resolvePluginPaths: vi.fn(() => ({
    pluginsRoot: "/tmp/lvis-test/plugins",
    registryPath: "/tmp/lvis-test/registry.json",
    cacheRoot: "/tmp/lvis-test/cache",
  })),
}));

vi.mock("../../plugins/registry.js", () => ({
  readPluginRegistry: harness.readPluginRegistry,
}));

import { initPluginRuntime } from "../../boot/steps/plugin-runtime.js";
import { KNOWN_CAPABILITIES } from "../../plugins/capabilities.js";
import { HOSTAPI_EFFECT_BY_PATH } from "../effect-kind.js";
import { instrumentEffectsByPath, isPlainNamespace } from "../hostapi-effect-recorder.js";
import {
  createEffectLedger,
  runWithEffectLedger,
  type EffectLedger,
} from "../effect-ledger.js";
import type { PluginHostApi } from "../../plugins/types.js";

type CreateHostApi = (
  pluginId: string,
  manifest: { id: string; config?: Record<string, unknown>; capabilities?: string[] },
  pluginDataDir: string,
  incarnation: {
    registerDisposer: (dispose: () => void) => void;
    trackOperation: <T>(operation: Promise<T>) => Promise<T>;
    isActive: () => boolean;
    isLifecycleHookActive: () => boolean;
  },
) => PluginHostApi;

/** Build a REAL hostApi object via the production createHostApi factory. */
async function buildRealHostApi(): Promise<PluginHostApi> {
  harness.capturedRuntimeOptions = null;
  const bootAuditLogger = { log: vi.fn() };
  await initPluginRuntime({
    projectRoot: "/tmp/lvis-test/project",
    settingsService: {
      get: vi.fn((key: string) => {
        if (key === "llm") return { provider: "openai" };
        if (key === "pluginConfigs") return {};
        return undefined;
      }),
      getSecret: vi.fn(() => undefined),
      getPluginConfig: vi.fn(() => ({})),
      setPluginConfig: vi.fn(),
    } as never,
    memoryManager: {} as never,
    keywordEngine: { registerKeywords: vi.fn(), unregisterByPlugin: vi.fn() } as never,
    toolRegistry: {
      unregisterByPlugin: vi.fn(),
      register: vi.fn(),
      listAll: vi.fn(() => []),
      listPluginIds: vi.fn(() => []),
      replacePluginTools: vi.fn(),
    } as never,
    pythonPath: undefined,
    bootAuditLogger: bootAuditLogger as never,
    mainWindow: {} as never,
    networkFetch: vi.fn(async () => new Response("")) as never,
    openAuthWindowService: vi.fn(),
    openLinkWindowService: vi.fn(),
    openAuthPartitionViewerService: vi.fn(),
    clearAuthPartitionService: vi.fn(),
    shellOpenExternal: vi.fn(),
    approvalGate: { requestAndWait: vi.fn(), resolve: vi.fn() } as never,
    routinesStore: { list: () => [] } as never,
  });

  const createHostApi = harness.capturedRuntimeOptions?.createHostApi as CreateHostApi | undefined;
  expect(createHostApi, "initPluginRuntime must register a createHostApi factory").toBeDefined();
  const pluginDataDir = mkdtempSync(join(tmpdir(), "lvis-hostapi-completeness-"));
  // Build with the FULL capability vocabulary, not a sampled subset. A
  // namespace/method wired ONLY under a capability ABSENT from the fixture would
  // escape BOTH the non-plain-namespace assertion AND the SOT-coverage assertion
  // below (it would never be enumerated), so completeness coverage must enumerate
  // every conditionally-wired method — declare the maximal capability set.
  return createHostApi!(
    "completeness-plugin",
    { id: "completeness-plugin", config: {}, capabilities: [...KNOWN_CAPABILITIES] },
    pluginDataDir,
    {
      registerDisposer: vi.fn(),
      trackOperation: <T>(operation: Promise<T>) => operation,
      isActive: () => true,
      isLifecycleHookActive: () => false,
    },
  );
}

/**
 * Recursively collect every function-valued leaf method PATH (dotted) into
 * `out`, AND every non-plain namespace path into `nonPlainNamespaces`. The
 * recording wrapper only INSTRUMENTS plain namespaces (the shared
 * {@link isPlainNamespace} predicate); a non-plain namespace (class instance /
 * custom prototype) would pass the path-completeness check yet be copied
 * verbatim and left UNINSTRUMENTED by the wrapper — a silent fail-open one level
 * up. Flagging it here keeps the test and the wrapper on the SAME traversal
 * surface so such a namespace fails CI and must be handled.
 */
function collectFunctionPaths(
  obj: unknown,
  prefix: string,
  out: string[],
  nonPlainNamespaces: string[],
): void {
  if (obj === null || typeof obj !== "object") return;
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    const value = (obj as Record<string, unknown>)[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "function") {
      out.push(path);
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      if (!isPlainNamespace(value)) nonPlainNamespaces.push(path);
      collectFunctionPaths(value, path, out, nonPlainNamespaces);
    }
  }
}

describe("hostApi effect classification — STRUCTURAL completeness", () => {
  beforeEach(() => {
    harness.readPluginRegistry.mockReset();
    harness.readPluginRegistry.mockResolvedValue({ version: 1, plugins: [] });
  });

  it("every function-valued method of the REAL hostApi is classified in the SOT", async () => {
    const hostApi = await buildRealHostApi();
    const paths: string[] = [];
    const nonPlainNamespaces: string[] = [];
    collectFunctionPaths(hostApi, "", paths, nonPlainNamespaces);

    // Sanity: enumeration actually found the surface (guards against a refactor
    // that hides methods behind non-enumerable props and silently passes).
    expect(paths.length).toBeGreaterThan(20);
    expect(paths).toContain("storage.writeJson");
    expect(paths).toContain("agentApproval.request");
    expect(paths).toContain("callLlm");
    expect(paths).toContain("openAuthPartitionViewer");
    expect(paths).toContain("registerKeywords");

    // The wrapper only INSTRUMENTS plain namespaces; a non-plain namespace would
    // pass the path check below yet be left uninstrumented by the wrapper. Assert
    // there are none so the test and the wrapper agree on the traversal surface.
    expect(
      nonPlainNamespaces,
      `Non-plain hostApi namespace(s) the recording wrapper would NOT instrument — make them plain objects or instrument explicitly: ${nonPlainNamespaces.join(", ")}`,
    ).toEqual([]);

    const unmapped = paths.filter((p) => !(p in HOSTAPI_EFFECT_BY_PATH));
    expect(
      unmapped,
      `Uninstrumented hostApi method(s) — add to HOSTAPI_EFFECT_BY_PATH (effect-kind.ts): ${unmapped.join(", ")}`,
    ).toEqual([]);
  });

  it("a non-plain namespace is FLAGGED by the shared predicate (wrapper/test traversal alignment)", () => {
    class CustomProtoNamespace {
      // class field → an OWN-enumerable function property, but the prototype is
      // CustomProtoNamespace.prototype (NOT Object.prototype) → non-plain.
      doMutation = (): string => "mutated";
    }
    const fauxHostApi = { registerKeywords: () => {}, ns: new CustomProtoNamespace() };
    const paths: string[] = [];
    const nonPlainNamespaces: string[] = [];
    collectFunctionPaths(fauxHostApi, "", paths, nonPlainNamespaces);

    // Its method IS enumerated (so a path-only completeness check would pass)…
    expect(paths).toContain("ns.doMutation");
    // …but it is ALSO flagged as a non-plain namespace, which the completeness
    // assertion rejects — closing the wrapper/test traversal asymmetry.
    expect(nonPlainNamespaces).toEqual(["ns"]);
    // And the wrapper confirms the gap it guards: the non-plain namespace is
    // copied through verbatim (NOT instrumented).
    expect(instrumentEffectsByPath(fauxHostApi).ns).toBe(fauxHostApi.ns);
  });

  it("records a fail-closed WRITE + the SOT entry's effect is honored for a known method", async () => {
    const hostApi = await buildRealHostApi();
    const ledger: EffectLedger = createEffectLedger("cid-known");
    await runWithEffectLedger(ledger, async () => {
      // A pure read method records read; a write method records write — both via
      // the structural wrapper, no manual recordChokepoint at the call-site.
      hostApi.getInstalledPluginIds();
      hostApi.registerKeywords([{ keyword: "k", skillId: "s" }]);
    });
    const summary = ledger.summary();
    expect(summary.effects.map((e) => e.kind)).toEqual(["getInstalledPluginIds", "registerKeywords"]);
    expect(summary.hasMutatingEffect).toBe(true); // registerKeywords is a write
  });

  it("an UNMAPPED method records fail-closed as a mutating unclassifiedHostApiMethod", async () => {
    const wrapped = instrumentEffectsByPath({ futureUnmappedMethod: () => "ok" });
    const ledger: EffectLedger = createEffectLedger("cid-unmapped");
    let ret: unknown;
    await runWithEffectLedger(ledger, async () => {
      ret = wrapped.futureUnmappedMethod();
    });
    const summary = ledger.summary();
    expect(ret).toBe("ok"); // behavior preserved
    expect(summary.hasMutatingEffect).toBe(true);
    expect(summary.effects).toEqual([
      { kind: "unclassifiedHostApiMethod", effect: "write", target: "futureUnmappedMethod" },
    ]);
  });

  it("the wrapper is a PURE side-effect — args, return, throw, and async are preserved", async () => {
    const calls: unknown[][] = [];
    const wrapped = instrumentEffectsByPath({
      // mapped to read (config.get) so we exercise the static-effect path
      config: {
        get: (...args: unknown[]) => {
          calls.push(args);
          return "value";
        },
      },
      // mapped path callLlm — async passthrough + rejection propagation
      callLlm: async (prompt: string) => {
        if (prompt === "boom") throw new Error("nope");
        return `echo:${prompt}`;
      },
    } as unknown as PluginHostApi);

    expect(wrapped.config.get("k")).toBe("value");
    expect(calls).toEqual([["k"]]);
    await expect(wrapped.callLlm("hi")).resolves.toBe("echo:hi");
    await expect(wrapped.callLlm("boom")).rejects.toThrow("nope");
  });
});
