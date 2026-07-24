/**
 * Shared helpers for marketplace test fixtures.
 *
 * Tests construct `PluginMarketplaceService` with the (paths, fetcher,
 * deploymentGuard?) shape. registry.json lives at the root of pluginsRoot,
 * so tests pick a single tmp root and the helper derives the rest.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync } from "node:fs";
import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { PluginPaths } from "../plugin-paths.js";
import { resolvePluginPaths } from "../plugin-paths.js";
import {
  PluginMarketplaceService,
  type PreparedMarketplacePluginActivation,
} from "../marketplace.js";
import type { MarketplaceFetcher } from "../marketplace-fetcher.js";
import {
  createNoopHostApiForTests,
  PluginRuntime,
  type PluginRuntimeOptions,
} from "../runtime.js";
import type { PluginManifest, Tool } from "../types.js";
import type {
  HostPluginGenerationState,
  PluginRuntimeGenerationProjection,
} from "../plugin-host-generation.js";
import type { ActivePluginGeneration } from "../plugin-generation-coordinator.js";

/** Restore owner write access before deleting immutable generation fixtures. */
export async function makeTestTreeWritable(root: string): Promise<void> {
  await chmod(root, 0o700).catch(() => undefined);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => makeTestTreeWritable(join(root, entry.name))));
}

/**
 * Explicit test lifecycle for storage-focused Marketplace tests. Production
 * code must supply `PluginRuntime.activatePreparedArtifact`; this helper keeps
 * unit fixtures honest about crossing the same mandatory coordination seam.
 */
export const activateAndCommitPreparedPluginForTest: PreparedMarketplacePluginActivation =
  async (prepared) => ({
    result: await prepared.durableCommit(),
    retirement: Promise.resolve(),
  });

export const preparedActivationOptionsForTest = Object.freeze({
  activatePreparedArtifact: activateAndCommitPreparedPluginForTest,
});

/**
 * Storage/unit-test service with an explicit test lifecycle default. Keeping
 * this adapter under `__tests__` lets legacy storage fixtures omit repetitive
 * options without weakening the production method signatures or runtime gate.
 */
export class TestPluginMarketplaceService extends PluginMarketplaceService {
  override install(...args: Parameters<PluginMarketplaceService["install"]>) {
    const [pluginId, onProgress, options] = args;
    return super.install(
      pluginId,
      onProgress,
      options ?? preparedActivationOptionsForTest,
    );
  }

  override ensureManagedInstalled(
    ...args: Parameters<PluginMarketplaceService["ensureManagedInstalled"]>
  ) {
    return super.ensureManagedInstalled(args[0] ?? preparedActivationOptionsForTest);
  }

  override installPlugin(...args: Parameters<PluginMarketplaceService["installPlugin"]>) {
    const [pluginId, version, options] = args;
    return super.installPlugin(
      pluginId,
      version,
      options ?? preparedActivationOptionsForTest,
    );
  }

  override rollbackPlugin(...args: Parameters<PluginMarketplaceService["rollbackPlugin"]>) {
    const [pluginId, options] = args;
    return super.rollbackPlugin(
      pluginId,
      options ?? preparedActivationOptionsForTest,
    );
  }

  override installLocal(...args: Parameters<PluginMarketplaceService["installLocal"]>) {
    const [sourcePath, options] = args;
    return super.installLocal(
      sourcePath,
      options ?? preparedActivationOptionsForTest,
    );
  }
}

/**
 * #885 v6 — build a pure MCP `Tool` object from a bare tool name. Tests declare
 * tools ergonomically as name strings; the host contract is pure `Tool[]`, so
 * each name is expanded to a minimal model+app-visible tool with an empty input
 * schema (the SEP-1865 standard default visibility).
 */
export function pureTool(
  name: string,
  visibility: Array<"model" | "app"> = ["model", "app"],
  extra: Partial<Tool> = {},
): Tool {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: { type: "object", properties: {} },
    _meta: { ui: { visibility } },
    ...extra,
  };
}

/** Build a pure `Tool[]` from bare names, all model+app visible (SEP-1865 default). */
export function pureTools(...names: string[]): Tool[] {
  return names.map((n) => pureTool(n));
}

/**
 * Compile a legacy `{ tools: string[], uiActions, toolSchemas }` surface into the
 * pure v6 `Tool[]` — the same derivation the removed pre-v6 legacy-shape reader
 * performed. Visibility: model if in `tools[]`, app if in `uiActions`;
 * description/inputSchema sourced from `toolSchemas`/`uiActions`; non-empty
 * `pathFields` moved to `_meta["lvisai/pathFields"]`; removed fields dropped.
 * Tests that historically declared the legacy surface use this to emit the pure
 * shape the host now reads.
 */
export function compileLegacyToolSurface(spec: {
  tools?: string[];
  uiActions?: Record<string, { description?: string } | undefined>;
  toolSchemas?: Record<
    string,
    { description?: string; pathFields?: string[]; inputSchema?: unknown } & Record<string, unknown>
  >;
}): Tool[] {
  const names = spec.tools ?? [];
  const uiActions = spec.uiActions ?? {};
  const uiNames = Object.keys(uiActions);
  const schemas = spec.toolSchemas ?? {};
  const all = [...names, ...uiNames.filter((n) => !names.includes(n))];
  return all.map((name): Tool => {
    const schema = schemas[name];
    const visibility: Array<"model" | "app"> = [
      ...(names.includes(name) ? (["model"] as const) : []),
      ...(uiNames.includes(name) ? (["app"] as const) : []),
    ];
    const meta: Tool["_meta"] = { ui: { visibility } };
    if (schema?.pathFields && schema.pathFields.length > 0) {
      meta!["lvisai/pathFields"] = schema.pathFields;
    }
    const description = schema?.description ?? uiActions[name]?.description;
    return {
      name,
      ...(description !== undefined ? { description } : {}),
      inputSchema: (schema?.inputSchema as Tool["inputSchema"]) ?? { type: "object", properties: {} },
      _meta: meta,
    };
  });
}

/** Accept either bare names (ergonomic) or already-pure `Tool` objects. */
function normalizeTestTools(
  tools: ReadonlyArray<string | Tool> | undefined,
): Tool[] {
  return (tools ?? []).map((t) => (typeof t === "string" ? pureTool(t) : t));
}

export interface TestPluginPathsInput {
  /** A tmp directory; the helper anchors plugin paths under it. */
  rootDir: string;
  /** Optional override — defaults to `<rootDir>/plugins`. */
  pluginsRoot?: string;
  /** Optional override — defaults to `<pluginsRoot>/.cache`. */
  cacheRoot?: string;
}

/**
 * Build a fully-formed `PluginPaths` for a test. Mirrors the production
 * resolver shape so any future PluginPaths field addition flows through
 * here without 20-site updates.
 */
export function makeTestPluginPaths(input: TestPluginPathsInput): PluginPaths {
  return resolvePluginPaths({
    pluginsRoot: input.pluginsRoot ?? resolve(input.rootDir, "plugins"),
    cacheRoot: input.cacheRoot,
  });
}

/**
 * Build a schema-valid PluginManifest for tests. All required fields are
 * pre-filled with sensible defaults; callers only need to supply an id and
 * any overrides. Type-checked at build time — if the schema adds a new
 * required field this factory will surface a TS error at every test that
 * uses it, rather than a runtime AJV failure with an opaque fixture path.
 */
export function makeTestManifest(
  overrides: Partial<Omit<PluginManifest, "tools">> &
    Pick<PluginManifest, "id"> & {
      tools?: ReadonlyArray<string | Tool>;
      /** Legacy compat: tests may still express the surface as uiActions/toolSchemas maps. */
      uiActions?: Record<string, { description?: string } | undefined>;
      toolSchemas?: Record<string, Record<string, unknown>>;
    },
): PluginManifest {
  const { tools: overrideTools, uiActions, toolSchemas, ...rest } = overrides as typeof overrides & {
    uiActions?: Record<string, { description?: string } | undefined>;
    toolSchemas?: Record<string, Record<string, unknown>>;
  };
  // If a test still declares the legacy `uiActions`/`toolSchemas` surface, compile
  // it (plus any tool-name list) into pure Tool[] and drop the legacy maps — the
  // host reads pure form only (#885 Phase R).
  const hasLegacyMaps = uiActions !== undefined || toolSchemas !== undefined;
  const tools = hasLegacyMaps
    ? compileLegacyToolSurface({
        tools: (overrideTools ?? []).filter((t): t is string => typeof t === "string"),
        uiActions,
        toolSchemas: toolSchemas as Parameters<typeof compileLegacyToolSurface>[0]["toolSchemas"],
      })
    : normalizeTestTools(overrideTools);
  return {
    name: overrides.id,
    version: "0.0.0",
    description: "test fixture",
    publisher: "tests",
    entry: "dist/hostPlugin.js",
    ...(rest as Partial<PluginManifest>),
    tools,
  };
}

export interface TestPluginRuntimeFixture {
  rootDir: string;
  pluginsRoot: string;
  registryPath: string;
}

export interface TestPluginRuntimeFixtureOptions {
  /** Prefix passed to `mkdtempSync`; defaults to `lvis-plugin-test-`. */
  prefix?: string;
  /** Optional plugin root override relative to `rootDir`; defaults to `plugins/installed`. */
  pluginsRootRelative?: string;
}

export async function makeTestPluginRuntimeFixture(
  options: TestPluginRuntimeFixtureOptions = {},
): Promise<TestPluginRuntimeFixture> {
  const rootDir = mkdtempSync(join(tmpdir(), options.prefix ?? "lvis-plugin-test-"));
  const pluginsRoot = join(rootDir, options.pluginsRootRelative ?? "plugins/installed");
  const registryPath = join(rootDir, "plugins", "registry.json");
  await mkdir(pluginsRoot, { recursive: true });
  await mkdir(dirname(registryPath), { recursive: true });
  return { rootDir, pluginsRoot, registryPath };
}

export interface WriteTestPluginOptions {
  id: string;
  entry?: string;
  entrySource?: string;
  tools?: string[];
  manifest?: Partial<PluginManifest> & Record<string, unknown>;
}

export interface WrittenTestPlugin {
  pluginDir: string;
  manifestPath: string;
  manifest: PluginManifest;
}

export function makeTestPluginEntrySource(
  handlers: Record<string, string> = {},
): string {
  const handlerEntries = Object.entries(handlers)
    .map(([name, body]) => `${JSON.stringify(name)}: async () => ${body}`)
    .join(", ");
  return `export default async function createPlugin() {
  return { handlers: { ${handlerEntries} }, start: async () => {}, stop: async () => {} };
}
`;
}

export async function writeTestPlugin(
  fixture: TestPluginRuntimeFixture,
  options: WriteTestPluginOptions,
): Promise<WrittenTestPlugin> {
  const entry = options.entry ?? "entry.mjs";
  const tools = options.tools ?? [];
  const pluginDir = join(fixture.pluginsRoot, options.id);
  await mkdir(pluginDir, { recursive: true });
  if (options.entrySource !== undefined) {
    await writeFile(join(pluginDir, entry), options.entrySource, "utf-8");
  }
  const manifest = makeTestManifest({
    id: options.id,
    entry,
    tools,
    ...options.manifest,
  });
  const manifestPath = join(pluginDir, "plugin.json");
  await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");
  return { pluginDir, manifestPath, manifest };
}

export interface TestRegistryEntry {
  id: string;
  manifestPath: string;
  enabled?: boolean;
  approvedPluginAccess?: unknown;
  installSource?: "admin" | "user" | "local-dev";
  installedBy?: "admin" | "user";
  _devLinked?: boolean;
}

export async function writeTestPluginRegistry(
  fixture: Pick<TestPluginRuntimeFixture, "registryPath">,
  entries: TestRegistryEntry[],
): Promise<void> {
  await mkdir(dirname(fixture.registryPath), { recursive: true });
  await writeFile(
    fixture.registryPath,
    JSON.stringify({ version: 1, plugins: entries }),
    "utf-8",
  );
}

export function makeTestPluginRuntime(
  fixture: TestPluginRuntimeFixture,
  options: Partial<PluginRuntimeOptions> = {},
): PluginRuntime {
  return bindTestPluginRuntimeGeneration(new PluginRuntime({
    hostRoot: fixture.rootDir,
    registryPath: fixture.registryPath,
    pluginsRoot: fixture.pluginsRoot,
    createHostApi: createNoopHostApiForTests,
    ...options,
  }));
}

/**
 * Bind the smallest complete generation lifecycle needed by legacy runtime
 * unit tests. Product code never receives this adapter: strict lifecycle
 * binding and immutable receipt-backed roots are covered by dedicated tests.
 * These older tests intentionally exercise parsing, startup, restart, and
 * teardown in their mutable tmp fixture, so their candidate-root materializer
 * is replaced with that fixture root while publication still goes through the
 * same runtime prepare/publish boundary as production.
 */
export function bindTestPluginRuntimeGeneration(runtime: PluginRuntime): PluginRuntime {
  const active = new Map<string, ActivePluginGeneration<HostPluginGenerationState>>();
  const lifecycleTails = new Map<string, Promise<void>>();
  const lifecycleQueueContext = new AsyncLocalStorage<ReadonlyMap<string, object>>();
  const activeLifecycleQueueTokens = new WeakSet<object>();
  const retirementTasks = new Set<Promise<void>>();
  let sequence = 0;

  const trackRetirement = (retirement: Promise<void>): Promise<void> => {
    retirementTasks.add(retirement);
    void retirement
      .finally(() => retirementTasks.delete(retirement))
      .catch(() => undefined);
    return retirement;
  };

  const runInLifecycleQueue = <T>(
    pluginId: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const current = lifecycleQueueContext.getStore();
    const currentToken = current?.get(pluginId);
    if (currentToken && activeLifecycleQueueTokens.has(currentToken)) return operation();
    const prior = lifecycleTails.get(pluginId) ?? Promise.resolve();
    const next = prior.then(async () => {
      const token = {};
      const inherited = new Map(lifecycleQueueContext.getStore() ?? current ?? []);
      inherited.set(pluginId, token);
      activeLifecycleQueueTokens.add(token);
      try {
        return await lifecycleQueueContext.run(inherited, operation);
      } finally {
        activeLifecycleQueueTokens.delete(token);
      }
    });
    const tail = next.then(() => undefined, () => undefined);
    lifecycleTails.set(pluginId, tail);
    return next.finally(() => {
      if (lifecycleTails.get(pluginId) === tail) lifecycleTails.delete(pluginId);
    });
  };

  const adoptLegacyProjection = (
    pluginId: string,
  ): ActivePluginGeneration<HostPluginGenerationState> | undefined => {
    const existing = active.get(pluginId);
    if (existing) return existing;
    if (runtime.resolvePluginInstallIdIfKnown(pluginId) === undefined) {
      (runtime as unknown as {
        rememberPluginInstallAlias(id: string, alias: undefined): void;
      }).rememberPluginInstallAlias(pluginId, undefined);
    }
    const projection = runtime.getRuntimeGenerationProjection(pluginId);
    if (!projection) return undefined;
    const methods = new Map(
      [...runtime.getMethodMap()].flatMap(([name, entry]) =>
        entry.pluginId === pluginId ? [[name, entry.handler] as const] : [],
      ),
    );
    const generationId = projection.activationId || `test-generation-${++sequence}`;
    const normalizedProjection = Object.freeze({
      ...projection,
      activationId: generationId,
      pluginRoot: projection.pluginRoot || "/tmp/test-plugin-runtime",
      methods,
    });
    const generation: ActivePluginGeneration<HostPluginGenerationState> = {
      pluginId,
      pluginVersion: projection.manifest.version,
      artifactGenerationId: generationId,
      generationId,
      manifestSha256: generationId,
      receiptSha256: generationId,
      contributions: [],
      state: {
        payloadRoot: normalizedProjection.pluginRoot,
        runtime: normalizedProjection,
        hooks: [],
        mcpServers: [],
      },
    };
    active.set(pluginId, generation);
    return generation;
  };

  const runRuntimeRetirement = async (
    projection: PluginRuntimeGenerationProjection,
  ): Promise<void> => {
    const errors: Error[] = [];
    for (const step of runtime.prepareRuntimeRetirement(projection)) {
      try {
        await step.run();
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `plugin '${projection.manifest.id}' generation retirement failed`,
      );
    }
  };

  const publish = async (
    projection: PluginRuntimeGenerationProjection,
  ): Promise<{ retirement: Promise<void> }> => {
    const pluginId = projection.manifest.id;
    const predecessor = active.get(pluginId);
    const generationId = `test-generation-${++sequence}`;
    projection.hostEffects?.bindGeneration(lifecycle as never, generationId);
    runtime.prepareRuntimeGeneration(projection).publish();
    active.set(pluginId, {
      pluginId,
      pluginVersion: projection.manifest.version,
      artifactGenerationId: generationId,
      generationId,
      manifestSha256: generationId,
      receiptSha256: generationId,
      contributions: [],
      state: {
        payloadRoot: projection.pluginRoot,
        runtime: projection,
        hooks: [],
        mcpServers: [],
      },
    });
    const retirement = predecessor && predecessor.state.runtime !== projection
      ? trackRetirement(runRuntimeRetirement(predecessor.state.runtime))
      : Promise.resolve();
    return { retirement };
  };

  const deactivate = async (
    pluginId: string,
  ): Promise<{ retirement: Promise<void> }> => {
    const predecessor = active.get(pluginId);
    runtime.prepareRuntimeRemoval(pluginId).publish();
    active.delete(pluginId);
    const retirement = predecessor
      ? trackRetirement(runRuntimeRetirement(predecessor.state.runtime))
      : Promise.resolve();
    return { retirement };
  };

  const lifecycle = {
    runInLifecycleQueue,
    getActive: (pluginId: string) => {
      const generation = active.get(pluginId) ?? adoptLegacyProjection(pluginId);
      return generation
        ? {
            pluginId: generation.pluginId,
            generationId: generation.generationId,
            manifest: generation.state.runtime.manifest,
          }
        : undefined;
    },
    isExactAdmitted: (pluginId: string, generationId: string) =>
      active.get(pluginId)?.generationId === generationId,
    acquire: async (pluginId: string) => {
      const generation = active.get(pluginId) ?? adoptLegacyProjection(pluginId);
      if (!generation) throw new Error(`test generation is not active for '${pluginId}'`);
      return { generation, release: () => undefined };
    },
    acquireExact: async (pluginId: string, generationId: string) => {
      const generation = active.get(pluginId) ?? adoptLegacyProjection(pluginId);
      if (!generation || generation.generationId !== generationId) {
        throw new Error(`test generation '${pluginId}:${generationId}' is not active`);
      }
      return { generation, release: () => undefined };
    },
    runWithLease: async <T>(_lease: unknown, operation: () => Promise<T>) => operation(),
    replaceRuntime: async (projection: PluginRuntimeGenerationProjection) => {
      await publish(projection);
    },
    replaceRuntimeWithCommit: <T>(
      projection: PluginRuntimeGenerationProjection,
      _receiptRaw: string,
      durableCommit: () => Promise<T>,
    ) => runInLifecycleQueue(projection.manifest.id, async () => {
      const result = await durableCommit();
      const { retirement } = await publish(projection);
      return { result, retirement };
    }),
    deactivate: (pluginId: string) => runInLifecycleQueue(pluginId, async () => {
      await deactivate(pluginId);
    }),
    deactivateWithCommit: <T>(pluginId: string, durableCommit: () => Promise<T>) =>
      runInLifecycleQueue(pluginId, async () => {
        const result = await durableCommit();
        const { retirement } = await deactivate(pluginId);
        return { result, retirement };
      }),
    recoverRetirements: async () => undefined,
    waitForRetirements: async () => {
      await Promise.all([...retirementTasks]);
    },
  };

  const testInternals = runtime as unknown as {
    materializeImmutableRuntimeRoot: (
      pluginId: string,
      pluginRoot: string,
      activationId: string,
    ) => Promise<string>;
    removeUnpublishedRuntimeRoot: (pluginId: string, pluginRoot: string) => Promise<void>;
  };
  testInternals.materializeImmutableRuntimeRoot = async (_pluginId, pluginRoot) => pluginRoot;
  testInternals.removeUnpublishedRuntimeRoot = async () => undefined;
  runtime.setGenerationAccess(lifecycle as never);
  return runtime;
}

export function createTestHostApiFactory(
  provided?: PluginRuntimeOptions["createHostApi"],
): PluginRuntimeOptions["createHostApi"] {
  return (...args) => {
    const fallback = createNoopHostApiForTests(...args);
    const hostApi = provided?.(...args);
    if (!hostApi) return fallback;
    return {
      ...fallback,
      ...hostApi,
      storage: hostApi.storage ?? fallback.storage,
    };
  };
}

/** PluginRuntime constructor for tests that need the complete generation fixture. */
export class TestPluginRuntime extends PluginRuntime {
  constructor(
    options: Omit<PluginRuntimeOptions, "createHostApi">
      & Partial<Pick<PluginRuntimeOptions, "createHostApi">>,
  ) {
    super({
      ...options,
      createHostApi: createTestHostApiFactory(options.createHostApi),
    });
    bindTestPluginRuntimeGeneration(this);
  }
}

export function makeTestPluginMarketplaceService(
  rootDir: string,
  fetcher: MarketplaceFetcher,
): PluginMarketplaceService {
  return new TestPluginMarketplaceService(
    makeTestPluginPaths({ rootDir }),
    fetcher,
  );
}
