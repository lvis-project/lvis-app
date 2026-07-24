/**
 * `PluginLoopbackManager` — lifecycle owner for first-party plugins running as
 * in-process MCP servers (mcp-alignment-design.md §3.1, `plugin-loopback-server`).
 *
 * This is the integration layer between the atomic bundle lifecycle and each
 * plugin's in-process {@link PluginMcpHost}. Candidates are prepared while
 * hidden, published with the shared generation pointer, and retired only after
 * outstanding generation leases drain.
 *
 * It composes the parity pieces: each host runs the plugin's manifest through
 * {@link PluginMcpServer} with {@link pluginRuntimeToolDelegate}. Tools register
 * under their natural names with plugin authority sourced from `_meta` (NOT the
 * external `mcp_` namespace), and every call is pinned to the exact published
 * generation. There is no direct plugin-tool registration fallback.
 */
import { ToolRegistry, type PreparedPluginRegistryReplacement } from "../tools/registry.js";
import { PluginMcpHost } from "./plugin-mcp-host.js";
import { pluginRuntimeToolDelegate } from "./plugin-runtime-delegate.js";
import {
  createPluginUiResourceProvider,
  type PluginUiResourceProvider,
} from "./plugin-ui-resource-provider.js";
import { createMcpServerDisconnectedSink } from "./mcp-server-disconnect-sink.js";
import type { PluginRuntime } from "../plugins/runtime.js";
import type { PluginManifest } from "../plugins/types.js";
import type { McpUiResourceRead } from "./types.js";
import type { Tool } from "../tools/base.js";

export interface PreparedPluginLoopbackGeneration {
  readonly pluginId: string;
  readonly generationId: string;
  readonly host?: PluginMcpHost;
  readonly tools: readonly Tool[];
  readonly registryReplacement: PreparedPluginRegistryReplacement;
  published: boolean;
  disconnectPredecessor: boolean;
  predecessorGenerationId?: string;
}

export class PluginLoopbackManager {
  private readonly hosts = new Map<string, PluginMcpHost>();
  private readonly hostGenerations = new Map<string, string>();
  private readonly retiredHosts = new Map<
    string,
    { host: PluginMcpHost; emitDisconnect: boolean }
  >();

  constructor(
    private readonly runtime: PluginRuntime,
    private readonly toolRegistry: ToolRegistry,
    /**
     * #885 b3 teardown sink — the SAME factory `McpManager` gets, so a plugin's
     * in-process MCP server going away is indistinguishable, to a rendered card,
     * from an external server going away (`serverDisconnected` broadcast →
     * detached-window close → partition clear). A loopback server's id IS its
     * pluginId, so the payload needs no translation.
     *
     * It DEFAULTS to the real sink rather than being injected by boot: this arm
     * used to be silent, and a default-on sink means no future construction site
     * can re-introduce that silence by forgetting to wire it. Tests inject a stub.
     */
    private readonly onServerDisconnected: (serverId: string) => void =
      createMcpServerDisconnectedSink(),
  ) {}

  private retirementKey(pluginId: string, generationId: string): string {
    return `${pluginId}\0${generationId}`;
  }

  /** Prepare discovery and a registry snapshot while the candidate is hidden. */
  async prepareGeneration(
    manifest: PluginManifest,
    generationId: string,
    predecessorMcpServerIds: readonly string[] = [],
  ): Promise<PreparedPluginLoopbackGeneration> {
    const uiResources = this.buildUiResourceProvider(manifest, generationId);
    const declaredUiUris = new Set(uiResources?.list().map((resource) => resource.uri) ?? []);
    const host = PluginMcpHost.loopback(
      manifest,
      pluginRuntimeToolDelegate(this.runtime, manifest.id, declaredUiUris, generationId),
      uiResources,
      generationId,
    );
    try {
      const tools = await host.prepareTools();
      return {
        pluginId: manifest.id,
        generationId,
        host,
        tools,
        registryReplacement: this.toolRegistry.reservePluginReplacement(
          manifest.id,
          tools,
          predecessorMcpServerIds,
        ),
        published: false,
        disconnectPredecessor: false,
      };
    } catch (error) {
      await host.dispose();
      throw error;
    }
  }

  /** Prepare an inactive ToolRegistry snapshot without disposing the predecessor. */
  prepareRemoval(
    pluginId: string,
    generationId: string,
    predecessorMcpServerIds: readonly string[] = [],
  ): PreparedPluginLoopbackGeneration {
    return {
      pluginId,
      generationId,
      tools: Object.freeze([]),
      registryReplacement: this.toolRegistry.reservePluginReplacement(
        pluginId,
        [],
        predecessorMcpServerIds,
      ),
      published: false,
      disconnectPredecessor: false,
    };
  }

  /** Nonthrowing publication: prebuilt registry + map assignments only. */
  publishGeneration(prepared: PreparedPluginLoopbackGeneration): void {
    if (prepared.published) return;
    const previous = this.hosts.get(prepared.pluginId);
    const previousGeneration = this.hostGenerations.get(prepared.pluginId);
    prepared.registryReplacement.publish();
    if (previous && previousGeneration && previous !== prepared.host) {
      this.retiredHosts.set(
        this.retirementKey(prepared.pluginId, previousGeneration),
        { host: previous, emitDisconnect: prepared.host === undefined },
      );
      prepared.disconnectPredecessor = prepared.host === undefined;
      prepared.predecessorGenerationId = previousGeneration;
    }
    if (prepared.host) {
      prepared.host.publishPrepared(prepared.tools);
      this.hosts.set(prepared.pluginId, prepared.host);
      this.hostGenerations.set(prepared.pluginId, prepared.generationId);
    } else {
      this.hosts.delete(prepared.pluginId);
      this.hostGenerations.delete(prepared.pluginId);
    }
    prepared.published = true;
  }

  /** Close stale generation cards immediately after the atomic pointer publish. */
  postPublishGeneration(prepared: PreparedPluginLoopbackGeneration): void {
    if (!prepared.published || !prepared.disconnectPredecessor) return;
    prepared.disconnectPredecessor = false;
    this.onServerDisconnected(prepared.pluginId);
    const predecessorGenerationId = prepared.predecessorGenerationId;
    const retired = predecessorGenerationId
      ? this.retiredHosts.get(this.retirementKey(prepared.pluginId, predecessorGenerationId))
      : undefined;
    if (retired) retired.emitDisconnect = false;
  }

  async discardGeneration(prepared: PreparedPluginLoopbackGeneration): Promise<void> {
    if (prepared.published) return;
    prepared.registryReplacement.cancel();
    await prepared.host?.dispose();
  }

  async retireGeneration(pluginId: string, generationId: string): Promise<void> {
    const key = this.retirementKey(pluginId, generationId);
    const retired = this.retiredHosts.get(key);
    if (!retired) return;
    this.retiredHosts.delete(key);
    await retired.host.dispose();
    if (retired.emitDisconnect) this.onServerDisconnected(pluginId);
  }

  /**
   * Serve a `ui://` resource from a running plugin's loopback host — the plugin
   * arm of the unified UI-resource resolver (see `mcp-ui-backend-resolver.ts`).
   * Fail-closed: an unknown plugin, an undeclared uri, or a cross-namespace uri
   * throws (never a served body). Own-namespace enforcement lives in the host's
   * `PluginUiResourceProvider`, so the render path (which passes `serverId ===
   * pluginId`) can only ever reach this plugin's OWN declared resources.
   */
  async readUiResource(pluginId: string, uri: string): Promise<McpUiResourceRead> {
    const host = this.hosts.get(pluginId);
    if (!host) {
      throw new Error(`[plugin-loopback] no running loopback host for plugin '${pluginId}'`);
    }
    return host.readUiResource(uri);
  }

  /** Fail closed when a loopback card is not bound to the currently published generation. */
  assertCardGeneration(pluginId: string, generationId: string): void {
    const activeGenerationId = this.hostGenerations.get(pluginId);
    if (!activeGenerationId) {
      throw new Error(`[plugin-loopback] no running loopback host for plugin '${pluginId}'`);
    }
    if (generationId !== activeGenerationId) {
      throw new Error(`[plugin-loopback] stale card generation for plugin '${pluginId}'`);
    }
  }

  /**
   * Build the per-plugin `ui://` resource provider from the manifest's
   * `uiResources[]`. Returns `undefined` when the plugin declares no MCP App
   * resources (the common case) so the loopback host serves none.
   *
   * The provider is a pure policy gate (own-namespace + declared-only); the CONTENT
   * comes from the plugin itself via `runtime.readUiResource`, which applies the
   * runtime-state gates and bounds the hook. The host reads no plugin file here.
   */
  private buildUiResourceProvider(
    manifest: PluginManifest,
    generationId: string,
  ): PluginUiResourceProvider | undefined {
    const declarations = manifest.uiResources;
    if (!declarations || declarations.length === 0) return undefined;
    return createPluginUiResourceProvider({
      pluginId: manifest.id,
      declarations,
      readHtml: (uri) => this.runtime.readUiResource(
        manifest.id,
        uri,
        undefined,
        generationId,
      ),
    });
  }

  /** Is a loopback host currently running for this plugin? */
  has(pluginId: string): boolean {
    return this.hosts.has(pluginId);
  }

  /** Plugin ids with a running loopback host. */
  list(): string[] {
    return [...this.hosts.keys()];
  }
}
