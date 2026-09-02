/**
 * Construction of the REAL plugin hostApi object, and the traversal every
 * hostApi-surface gate runs over.
 *
 * Two gates walk this surface — effect classification
 * (`hostapi-effect-completeness.test.ts`) and marshalling classification
 * (`hostapi-serialization-conformance.test.ts`). They must agree on WHICH
 * members exist, so the object they inspect and the traversal that enumerates it
 * live here rather than being restated per gate: a divergence between the two
 * enumerations would let a member be classified by one gate and invisible to the
 * other.
 *
 * The electron / PluginRuntime / registry module mocks stay in each test file —
 * `vi.mock` is hoisted per file — and supply the `harness` passed in here.
 */
import { expect, vi } from "vitest";

import { initPluginRuntime } from "../../boot/steps/plugin-runtime.js";
import { KNOWN_CAPABILITIES } from "../../plugins/capabilities.js";
import { isPlainNamespace } from "../hostapi-effect-recorder.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkBoardStore } from "../../main/work-board-store.js";
import type { PluginHostApi } from "../../plugins/types.js";

/**
 * The one field this module needs from the caller's `vi.hoisted` harness: the
 * `PluginRuntime` constructor mock records the options `initPluginRuntime`
 * passed it, and `createHostApi` is the production factory hiding in there.
 * Declared as the minimum so a test file can carry whatever additional mock
 * state its own factories need.
 */
export interface RealHostApiHarness {
  capturedRuntimeOptions: Record<string, unknown> | null;
}

type CreateHostApi = (
  pluginId: string,
  manifest: {
    id: string;
    config?: Record<string, unknown>;
    capabilities?: string[];
  },
  pluginDataDir: string,
  incarnation: {
    registerDisposer: (dispose: () => void) => void;
    trackOperation: <T>(operation: Promise<T>) => Promise<T>;
    isActive: () => boolean;
    isLifecycleHookActive: () => boolean;
  },
  installPluginId: string | null,
) => PluginHostApi;

/**
 * Read back the factory `initPluginRuntime` handed to the `PluginRuntime`
 * constructor. Behind a function because the caller nulls the field first, and
 * the mock that refills it is invisible to the compiler from here.
 */
function capturedCreateHostApi(
  harness: RealHostApiHarness,
): CreateHostApi | undefined {
  return harness.capturedRuntimeOptions?.createHostApi as
    | CreateHostApi
    | undefined;
}

/**
 * Build a REAL hostApi object via the production `createHostApi` factory
 * captured from `initPluginRuntime`.
 *
 * Built with the FULL capability vocabulary, not a sampled subset: a
 * namespace/method wired ONLY under a capability absent from the fixture would
 * never be enumerated, and would therefore escape every assertion made about
 * this surface. Declare the maximal capability set so conditionally-wired
 * members are present.
 */
export async function buildRealHostApi(
  harness: RealHostApiHarness,
  pluginDataDir: string,
): Promise<PluginHostApi> {
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
    // A real store over a temp path: `proposeWork` must return a genuine
    // envelope for the JSON-representability probe, and the probe's kind is
    // undeclared so it refuses before it ever touches the file.
    getWorkBoardStore: () =>
      new WorkBoardStore(join(mkdtempSync(join(tmpdir(), "lvis-probe-wb-")), "board.json")),
  });

  const createHostApi = capturedCreateHostApi(harness);
  expect(
    createHostApi,
    "initPluginRuntime must register a createHostApi factory",
  ).toBeDefined();
  return createHostApi!(
    "surface-probe-plugin",
    {
      id: "surface-probe-plugin",
      config: {},
      capabilities: [...KNOWN_CAPABILITIES],
    },
    pluginDataDir,
    {
      registerDisposer: vi.fn(),
      trackOperation: <T>(operation: Promise<T>) => operation,
      isActive: () => true,
      isLifecycleHookActive: () => false,
    },
    null,
  );
}

/**
 * Recursively collect every function-valued leaf method PATH (dotted) into
 * `out`, AND every non-plain namespace path into `nonPlainNamespaces`. The
 * effect-recording wrapper only INSTRUMENTS plain namespaces (the shared
 * {@link isPlainNamespace} predicate); a non-plain namespace (class instance /
 * custom prototype) would pass a path-completeness check yet be copied verbatim
 * and left UNINSTRUMENTED by the wrapper — a silent fail-open one level up.
 * Flagging it here keeps the callers and the wrapper on the SAME traversal
 * surface so such a namespace fails CI and must be handled.
 */
export function collectFunctionPaths(
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
    } else if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      if (!isPlainNamespace(value)) nonPlainNamespaces.push(path);
      collectFunctionPaths(value, path, out, nonPlainNamespaces);
    }
  }
}
