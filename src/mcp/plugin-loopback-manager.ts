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
import { createLogger } from "../lib/logger.js";
import type { PluginRuntime } from "../plugins/runtime.js";
import type { PluginManifest } from "../plugins/types.js";

const log = createLogger("plugin-loopback-manager");

export class PluginLoopbackManager {
  private readonly hosts = new Map<string, PluginMcpHost>();

  constructor(
    private readonly runtime: PluginRuntime,
    private readonly toolRegistry: ToolRegistry,
  ) {}

  /**
   * Start (or restart) a plugin's loopback MCP host and register its tools.
   * Idempotent: an already-running host for this id is stopped first, so a
   * reload re-discovers the (possibly changed) manifest cleanly. Returns the
   * registered natural tool names.
   */
  async start(manifest: PluginManifest): Promise<string[]> {
    await this.stop(manifest.id);
    const host = PluginMcpHost.loopback(
      manifest,
      pluginRuntimeToolDelegate(this.runtime, manifest.id),
      this.toolRegistry,
    );
    const names = await host.start();
    this.hosts.set(manifest.id, host);
    log.info(`loopback plugin '${manifest.id}' registered ${names.length} tool(s): ${names.join(", ")}`);
    return names;
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
