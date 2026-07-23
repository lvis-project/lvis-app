/**
 * host-fetch-verb-snapshot.test.ts
 *
 * Closes the hostFetch VERB-FORGERY class (value-divergence variant). hostFetch
 * is the ONLY host chokepoint whose recorded read/write class depends on a
 * plugin-controlled arg VALUE (the HTTP method). A malicious 1st-party plugin
 * (in the declared threat model) could pass a STATEFUL `init.method` getter that
 * returns a safe verb (GET) the FIRST time it is read and a mutating verb (POST)
 * a later time. If the recorder, the audit line, and the wire each read the live
 * getter INDEPENDENTLY, the recorder could log a confirmed host-observed READ
 * while the wire actually performs a WRITE — a fail-open forgery in the dangerous
 * direction.
 *
 * The fix: the hostFetch host closure snapshots the verb to a PRIMITIVE with a
 * SINGLE getter read (destructuring `method` out of `init`), then derives the
 * recorded effect, the audit verb, AND the pinned wire verb from that one
 * primitive. This test drives the REAL closure (built via the production
 * `createHostApi` factory) with a counting/stateful getter and asserts: the
 * getter is invoked EXACTLY ONCE, and the recorded shadow effect == the wire
 * verb (both reflect the single read) — so the shadow can no longer say "read"
 * while the wire does POST.
 *
 * `evaluateHostFetch` is mocked to a deterministic allow so the test isolates the
 * verb-snapshot flow from the DNS/SSRF/allow-list gate (which is unchanged and
 * covered by host-fetch-guard.test.ts).
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

// Deterministic egress allow: the verb the closure passes (`methodSnapshot`)
// flows straight back as decision.method/effect, isolating the verb-snapshot
// flow from the real DNS/SSRF/allow-list gate (unchanged; tested separately).
vi.mock("../../main/host-fetch-guard.js", () => ({
  evaluateHostFetch: vi.fn(
    async (input: { rawUrl: string; method: string }) => ({
      ok: true,
      url: new URL(input.rawUrl),
      method: input.method,
      effect: ["GET", "HEAD", "OPTIONS"].includes(input.method) ? "read" : "write",
    }),
  ),
}));

import { initPluginRuntime } from "../../boot/steps/plugin-runtime.js";
import {
  createEffectLedger,
  runWithEffectLedger,
  type EffectEntry,
} from "../effect-ledger.js";
import type { PluginHostApi } from "../../plugins/types.js";

type CreateHostApi = (
  pluginId: string,
  manifest: {
    id: string;
    config?: Record<string, unknown>;
    capabilities?: string[];
    networkAccess?: { allowedDomains?: string[]; allowPrivateNetworks?: boolean };
  },
  pluginDataDir: string,
  incarnation: {
    registerDisposer: (dispose: () => void) => void;
    trackOperation: <T>(operation: Promise<T>) => Promise<T>;
    isActive: () => boolean;
    isLifecycleHookActive: () => boolean;
  },
) => PluginHostApi;

/** Build a REAL hostApi + the captured networkFetch mock (the wire). */
async function buildRealHostApi(): Promise<{
  hostApi: PluginHostApi;
  networkFetch: ReturnType<typeof vi.fn>;
}> {
  harness.capturedRuntimeOptions = null;
  const networkFetch = vi.fn(async () => new Response(""));
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
    bootAuditLogger: { log: vi.fn() } as never,
    mainWindow: {} as never,
    networkFetch: networkFetch as never,
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
  const pluginDataDir = mkdtempSync(join(tmpdir(), "lvis-hostfetch-verb-"));
  const hostApi = createHostApi!(
    "verb-snapshot-plugin",
    {
      id: "verb-snapshot-plugin",
      config: {},
      capabilities: ["external-auth-consumer"],
      networkAccess: { allowedDomains: ["api.example.com"] },
    },
    pluginDataDir,
    {
      registerDisposer: vi.fn(),
      trackOperation: <T>(operation: Promise<T>) => operation,
      isActive: () => true,
      isLifecycleHookActive: () => false,
    },
  );
  return { hostApi, networkFetch };
}

/** Invoke the real hostFetch in a ledger scope; return the recorded effects + wire init. */
async function driveHostFetch(
  hostApi: PluginHostApi,
  networkFetch: ReturnType<typeof vi.fn>,
  url: string | URL,
  init?: RequestInit,
): Promise<{ effects: EffectEntry[]; wireInit: RequestInit }> {
  const ledger = createEffectLedger("cid-verb");
  await runWithEffectLedger(ledger, async () => {
    await hostApi.hostFetch!(url, init);
  });
  const wireInit = (networkFetch.mock.calls[0]?.[1] ?? {}) as RequestInit;
  return { effects: ledger.summary().effects, wireInit };
}

describe("hostFetch verb snapshot — single read, recorded effect == wire verb", () => {
  beforeEach(() => {
    harness.readPluginRegistry.mockReset();
    harness.readPluginRegistry.mockResolvedValue({ version: 1, plugins: [] });
  });

  it("a STATEFUL init.method getter (GET then POST) is read EXACTLY ONCE — shadow and wire agree", async () => {
    const { hostApi, networkFetch } = await buildRealHostApi();
    let accessCount = 0;
    const statefulInit = {
      get method(): string {
        accessCount += 1;
        // GET on the first read; POST on any later read. With a single read the
        // ONLY value either consumer can observe is "GET".
        return accessCount === 1 ? "GET" : "POST";
      },
    } as unknown as RequestInit;

    const { effects, wireInit } = await driveHostFetch(
      hostApi,
      networkFetch,
      "https://api.example.com/x",
      statefulInit,
    );

    // The getter was invoked exactly once — there is NO second, independent read
    // the recorder/wire could disagree on.
    expect(accessCount).toBe(1);
    // The recorded shadow effect reflects that single read (GET → read)…
    expect(effects).toEqual([
      { kind: "hostFetch", effect: "read", target: "https://api.example.com" },
    ]);
    // …and the WIRE verb is the SAME primitive — NOT a later re-read that would
    // send POST. Before the fix the spread re-read the live getter → POST on the
    // wire while the shadow said read (the forgery).
    expect(wireInit.method).toBe("GET");
    expect(networkFetch).toHaveBeenCalledOnce();
  });

  it("a genuine mutating verb records WRITE and sends that same verb on the wire", async () => {
    const { hostApi, networkFetch } = await buildRealHostApi();
    let accessCount = 0;
    const statefulInit = {
      get method(): string {
        accessCount += 1;
        return "POST";
      },
    } as unknown as RequestInit;

    const { effects, wireInit } = await driveHostFetch(
      hostApi,
      networkFetch,
      "https://api.example.com/x",
      statefulInit,
    );

    expect(accessCount).toBe(1);
    expect(effects).toEqual([
      { kind: "hostFetch", effect: "write", target: "https://api.example.com" },
    ]);
    expect(wireInit.method).toBe("POST");
  });

  it("omitted method defaults to GET (read) on both the shadow and the wire", async () => {
    const { hostApi, networkFetch } = await buildRealHostApi();
    const { effects, wireInit } = await driveHostFetch(
      hostApi,
      networkFetch,
      "https://api.example.com/x",
    );
    expect(effects).toEqual([
      { kind: "hostFetch", effect: "read", target: "https://api.example.com" },
    ]);
    expect(wireInit.method).toBe("GET");
  });
});
