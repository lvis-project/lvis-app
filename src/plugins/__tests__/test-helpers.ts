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
import {
  AGENT_PLUGINS_SCHEMA_URL,
  LVIS_EXTENSION_NAMESPACE,
} from "../runtime/manifest-validation.js";
import type {
  HostPluginGenerationState,
  PluginRuntimeGenerationProjection,
} from "../plugin-host-generation.js";
import type { ActivePluginGeneration } from "../plugin-generation-coordinator.js";

type GenerationCommitScope = <T>(operation: () => Promise<T>) => Promise<T>;

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
  async (prepared) => {
    const completion = Promise.resolve();
    return {
      result: await prepared.durableCommit(),
      retirement: completion,
      completion,
      retirementDeferred: false,
    };
  };

export const preparedActivationOptionsForTest = Object.freeze({
  activatePreparedArtifact: activateAndCommitPreparedPluginForTest,
});
export const preparedManagedActivationOptionsForTest = Object.freeze({
  mode: "pre-start-sync" as const,
  ensurePluginStateReadyForInstall: async (_pluginId: string) => undefined,
  // Registry-removal commit only. What the real remover does around that commit
  // is pinned in marketplace-managed-bootstrap.test.ts, which binds the actual
  // `removeQuiescentPluginResidualState` instead of this default.
  removeDelistedAdminInstall: async (
    _removal: { pluginId: string; secretKeys: readonly string[] },
    commitRegistryRemoval: () => Promise<void>,
  ) => { await commitRegistryRemoval(); },
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
    return super.ensureManagedInstalled(
      args[0] ?? preparedManagedActivationOptionsForTest,
    );
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
    },
): PluginManifest {
  const { tools: overrideTools, ...rest } = overrides;
  const tools = normalizeTestTools(overrideTools);
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

/**
 * Patch LVIS fields inside an on-disk Agent Plugins document.
 *
 * A fixture that reads `plugin.json`, edits a field and writes it back is
 * editing a DOCUMENT, not a flat manifest — passing it through
 * {@link agentPluginsDocument} again would nest the whole document inside the
 * namespace. This edits at the right depth instead, and throws if the namespace
 * is missing rather than creating one, so a wrong-shaped fixture fails loudly.
 */
export function patchLvisFields(
  document: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const extensions = document.extensions as
    | Record<string, Record<string, unknown>>
    | undefined;
  const namespace = extensions?.[LVIS_EXTENSION_NAMESPACE];
  if (!namespace) {
    throw new Error(
      `manifest document has no extensions["${LVIS_EXTENSION_NAMESPACE}"] to patch`,
    );
  }
  Object.assign(namespace, patch);
  return document;
}

/**
 * A deliberately permissive Agent Plugins envelope, for suites that want to
 * exercise a HOST cross-field check rather than the real manifest schema.
 *
 * Those suites pass `parsePluginJson` a loose validator on purpose: if the test
 * passes, the rejection came from the host check and not from the schema. That
 * only works while the stand-in agrees with the document shape — an envelope
 * that disagrees fails for the wrong reason and the suite stops measuring what
 * it is about. Hence one definition rather than a literal per suite.
 *
 * `namespaceProperties` names the LVIS fields a given suite cares about;
 * everything else inside the namespace is left unconstrained unless `strict`.
 */
export function permissiveManifestEnvelopeSchema(options: {
  namespaceProperties?: Record<string, unknown>;
  namespaceRequired?: string[];
  strict?: boolean;
} = {}): Record<string, unknown> {
  const strict = options.strict ?? false;
  return {
    type: "object",
    additionalProperties: !strict,
    required: ["$schema", "name", "version", "description", "extensions"],
    properties: {
      $schema: { type: "string" },
      name: { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9._-]*$", minLength: 3 },
      description: { type: "string" },
      version: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" },
      extensions: {
        type: "object",
        // Non-strict still has to admit a foreign namespace, which is an
        // object of someone else's shape.
        additionalProperties: strict ? false : { type: "object" },
        properties: {
          [LVIS_EXTENSION_NAMESPACE]: {
            type: "object",
            additionalProperties: !strict,
            required: options.namespaceRequired ?? [],
            properties: {
              displayName: { type: "string" },
              ...options.namespaceProperties,
            },
          },
        },
      },
    },
  };
}

/**
 * The `properties` map of the LVIS namespace inside the host manifest schema.
 *
 * Every LVIS field sits under `extensions["xyz.lvisai"]` in an Agent Plugins
 * document, so a suite reaching for `schema.properties.<lvisField>` is reaching
 * into the portable top level, where that field is not. The path gets one
 * definition here rather than one per suite, and throws rather than returning
 * undefined so a wrong path fails loudly instead of asserting against nothing.
 */
export function lvisSchemaProperties(
  schema: unknown,
): Record<string, Record<string, unknown>> {
  const properties = (schema as { properties?: Record<string, unknown> })
    .properties;
  const extensions = properties?.extensions as
    | { properties?: Record<string, unknown> }
    | undefined;
  const namespace = extensions?.properties?.[LVIS_EXTENSION_NAMESPACE] as
    | { properties?: Record<string, Record<string, unknown>> }
    | undefined;
  if (!namespace?.properties) {
    throw new Error(
      `host manifest schema has no extensions["${LVIS_EXTENSION_NAMESPACE}"].properties`,
    );
  }
  return namespace.properties;
}

/**
 * Fields Agent Plugins 1.0.0 puts at the top level besides identity. A fixture
 * naming one of these means the top-level field, not a host field that happens
 * to share the name — the split has to match `flattenAgentPluginsManifest`, or
 * a round trip would move a field.
 */
const AGENT_PLUGINS_PORTABLE_FIELDS: ReadonlySet<string> = new Set([
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
]);

/**
 * Project a flat manifest into the Agent Plugins 1.0.0 document that actually
 * goes on disk — the inverse of the host's `flattenAgentPluginsManifest`.
 *
 * Fixtures stay flat because that is the shape assertions read and the shape a
 * test is usually about. Only the bytes written to `plugin.json` are nested, so
 * a fixture's subject stays its content rather than its envelope.
 *
 * Faithful about absence: a fixture that omits `id` produces a document with no
 * `name`, which is how a test drives the "missing identity" path.
 */
export function agentPluginsDocument(
  manifest: Readonly<Record<string, unknown>> | PluginManifest,
): Record<string, unknown> {
  const { id, name, ...rest } = manifest as Record<string, unknown>;
  const top: Record<string, unknown> = { $schema: AGENT_PLUGINS_SCHEMA_URL };
  if (id !== undefined) top.name = id;
  const lvis: Record<string, unknown> = {};
  if (name !== undefined) lvis.displayName = name;
  for (const [key, value] of Object.entries(rest)) {
    if (AGENT_PLUGINS_PORTABLE_FIELDS.has(key)) top[key] = value;
    else lvis[key] = value;
  }
  top.extensions = { [LVIS_EXTENSION_NAMESPACE]: lvis };
  return top;
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
  await writeFile(
    manifestPath,
    JSON.stringify(agentPluginsDocument(manifest)),
    "utf-8",
  );
  return { pluginDir, manifestPath, manifest };
}

export interface TestRegistryEntry {
  id: string;
  manifestPath: string;
  enabled?: boolean;
  approvedPluginAccess?: unknown;
  /** Staged-update marker. Rows carrying it are skipped by manifest discovery. */
  pendingUpdate?: unknown;
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

export function makeTestPluginRuntimeWithAudit(
  fixture: TestPluginRuntimeFixture,
  auditEntries: Array<{ level: string; message: string; data?: unknown }>,
): PluginRuntime {
  return makeTestPluginRuntime(fixture, {
    auditLog: (level, message, data) => {
      auditEntries.push({ level, message, data });
    },
  });
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
    // A failed prepared candidate has never been published into the runtime
    // projection. Do not manufacture a legacy identity merely because failure
    // cleanup asks whether a generation is active; doing so would make its
    // later retry collide with a phantom `undefined` install claim.
    if (!runtime.listPluginIds().includes(pluginId)) return undefined;
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
    runtime.prepareRuntimeGeneration(projection, predecessor?.generationId).publish();
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
    runtime.prepareRuntimeRemoval(pluginId, predecessor?.generationId).publish();
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
    replaceRuntime: async (
      projection: PluginRuntimeGenerationProjection,
      commitScope?: GenerationCommitScope,
    ) => {
      const commit = () => publish(projection);
      await (commitScope ? commitScope(commit) : commit());
    },
    replaceRuntimeWithCommit: <T>(
      projection: PluginRuntimeGenerationProjection,
      _receiptRaw: string,
      durableCommit: () => Promise<T>,
      commitScope?: GenerationCommitScope,
    ) => runInLifecycleQueue(projection.manifest.id, async () => {
      const commit = async () => {
        const result = await durableCommit();
        const { retirement } = await publish(projection);
        return {
          result,
          retirement,
          completion: retirement,
          retirementDeferred: false,
        };
      };
      return commitScope ? commitScope(commit) : commit();
    }),
    deactivate: (pluginId: string) => runInLifecycleQueue(pluginId, async () => {
      await deactivate(pluginId);
    }),
    deactivateWithCommit: <T>(
      pluginId: string,
      durableCommit: () => Promise<T>,
      commitScope?: GenerationCommitScope,
    ) =>
      runInLifecycleQueue(pluginId, async () => {
        const commit = async () => {
          const result = await durableCommit();
          const { retirement } = await deactivate(pluginId);
          return {
            result,
            retirement,
            completion: retirement,
            retirementDeferred: false,
          };
        };
        return commitScope ? commitScope(commit) : commit();
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
