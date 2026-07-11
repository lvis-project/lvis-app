/**
 * `PluginLoopbackManager` — lifecycle owner for first-party plugins running as
 * in-process MCP servers (mcp-alignment-design.md §3.1, `plugin-loopback-server`).
 *
 * This is the integration layer between the host's plugin lifecycle (enable /
 * disable / reload) and the per-plugin {@link PluginMcpHost}. It owns the set of
 * running hosts so boot can:
 *   - `start(manifest)` a migrated plugin (idempotent: re-start replaces),
 *   - `stop(pluginId)` on disable/uninstall,
 *   - `stopAll()` on shutdown.
 *
 * It composes the parity pieces: each host runs the plugin's manifest through
 * {@link PluginMcpServer} with {@link pluginRuntimeToolDelegate} (the same
 * fail-closed gates + rawResult channel as the legacy adapter), so a migrated
 * plugin registers and executes IDENTICALLY to `pluginToolsForRegistration` —
 * the milestone gate. Tools register under their natural names with plugin
 * authority sourced from `_meta` (NOT the external `mcp_` namespace).
 *
 * Scope: this manager is the seam the boot cutover wires into. Until a plugin id
 * is actually routed here (the live flip — a per-plugin product/review decision),
 * it changes no live behavior; the legacy path remains in force for every plugin
 * not handed to `start()`.
 */
import { ToolRegistry } from "../tools/registry.js";
import { PluginMcpHost } from "./plugin-mcp-host.js";
import { pluginRuntimeToolDelegate } from "./plugin-runtime-delegate.js";
import {
  createPluginUiResourceProvider,
  type PluginUiResourceProvider,
} from "./plugin-ui-resource-provider.js";
import { createLogger } from "../lib/logger.js";
import type { PluginRuntime } from "../plugins/runtime.js";
import type { PluginManifest } from "../plugins/types.js";
import type { McpUiResourceRead } from "./types.js";

const log = createLogger("plugin-loopback-manager");

export class PluginLoopbackManager {
  private readonly hosts = new Map<string, PluginMcpHost>();

  constructor(
    private readonly runtime: PluginRuntime,
    private readonly toolRegistry: ToolRegistry,
  ) {}

  /**
   * Start (or atomically reload) a plugin's loopback MCP host and register its
   * tools. ATOMIC: the new host builds + validates its full tool set and commits
   * it in a single `replacePluginTools` swap BEFORE the previous host is torn
   * down — so a FAILED reload (e.g. the new manifest drops a tool's category)
   * throws with the PREVIOUS registration left fully intact (no zero-tools
   * window). Returns the registered natural tool names.
   */
  async start(manifest: PluginManifest): Promise<string[]> {
    const previous = this.hosts.get(manifest.id);
    const host = PluginMcpHost.loopback(
      manifest,
      pluginRuntimeToolDelegate(this.runtime, manifest.id),
      this.toolRegistry,
      this.buildUiResourceProvider(manifest),
    );
    // host.start() is registry-read-only until its final atomic swap; if it
    // throws, `previous` (and its registered tools) are untouched.
    const names = await host.start();
    this.hosts.set(manifest.id, host);
    // The atomic swap already replaced the old tools — close the superseded
    // host's transport WITHOUT unregistering (stop() would delete the new tools).
    if (previous) await previous.dispose();
    log.info(`loopback plugin '${manifest.id}' registered ${names.length} tool(s): ${names.join(", ")}`);
    return names;
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
  ): PluginUiResourceProvider | undefined {
    const declarations = manifest.uiResources;
    if (!declarations || declarations.length === 0) return undefined;
    return createPluginUiResourceProvider({
      pluginId: manifest.id,
      declarations,
      readHtml: (uri) => this.runtime.readUiResource(manifest.id, uri),
    });
  }

  /** Stop a plugin's host and unregister its tools. No-op if not running. */
  async stop(pluginId: string): Promise<void> {
    const host = this.hosts.get(pluginId);
    if (!host) return;
    this.hosts.delete(pluginId);
    await host.stop();
    log.info(`loopback plugin '${pluginId}' stopped`);
  }

  /** Stop every running host (shutdown / full re-sync). */
  async stopAll(): Promise<void> {
    for (const pluginId of [...this.hosts.keys()]) {
      await this.stop(pluginId);
    }
  }

  /**
   * Reconcile the running hosts to the current runtime state: stop hosts whose
   * plugin is gone, (re)start a host for every present plugin. This is the
   * universal registration entry point after the legacy-removal flag-day — it
   * replaces the old `syncPluginToolRegistry` full re-sync. A single plugin whose
   * start throws (e.g. an invalid manifest) is logged and skipped so one bad
   * plugin never aborts the whole boot.
   */
  async syncAll(entries: Array<{ pluginId: string; manifest: PluginManifest }>): Promise<void> {
    const present = new Set(entries.map((e) => e.pluginId));
    for (const pluginId of this.list()) {
      if (!present.has(pluginId)) await this.stop(pluginId);
    }
    for (const { pluginId, manifest } of entries) {
      // Skip already-running hosts so an uninstall re-sync only stops the removed
      // plugin and never churns (transiently unregisters) its bystanders. A
      // CHANGED manifest re-registers through the explicit onEnable → start path,
      // not syncAll, so this guard never staleness-traps a reload.
      if (this.has(pluginId)) continue;
      try {
        await this.start(manifest);
      } catch (err) {
        log.error(
          `loopback plugin '${pluginId}' failed to register: ${(err as Error).message}`,
        );
      }
    }
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
