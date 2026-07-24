/**
 * #885 b3 — the ONE `serverDisconnected` teardown sink, shared by BOTH MCP server
 * arms so a card cannot tell them apart:
 *
 *   - external servers  → `McpManager` (kill-switch / remove / disconnectAll),
 *   - first-party plugins running as in-process loopback MCP servers →
 *     `PluginLoopbackManager.retireGeneration()` (plugin disable / uninstall / re-sync).
 *
 * Before this was shared, only the external arm emitted: disabling a plugin tore
 * its loopback server down SILENTLY, leaving its live MCP-App cards rendered and
 * interactive against a server that no longer existed, while an external server's
 * cards correctly flipped to the `mcp-app-disconnected` placeholder. One sink, one
 * event shape (`CHANNELS.mcp.serverDisconnected` with `{ serverId }` — a loopback
 * server's id IS its pluginId), both arms.
 *
 * It lives here rather than in the boot step so the `mcp/` layer can reach it
 * without importing `boot/`.
 */
import { createRequire } from "node:module";
import { CHANNELS } from "../contract/app-contract.js";
import { getWindowManager } from "../main/app-state.js";
import { mcpAppPartitionName } from "../shared/mcp-app-partition.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("mcp-disconnect-sink");
const require = createRequire(import.meta.url);

type DisconnectSinkWindow = {
  isDestroyed(): boolean;
  webContents: { send(channel: string, payload: unknown): void };
};
type DisconnectSinkSession = { clearStorageData(): Promise<void> };

export interface McpServerDisconnectedSinkDeps {
  /** Resolves the WindowManager LAZILY (BootContext carries no windowManager). */
  getWindowManager?: () => { closeDetachedMcpWindows(serverId: string): void } | null;
  getAllWindows?: () => DisconnectSinkWindow[];
  fromPartition?: (name: string) => DisconnectSinkSession;
}

/**
 * Build the `onServerDisconnected` sink wired into McpManager AND
 * PluginLoopbackManager.
 *
 * On each teardown it does THREE things, in this order (broadcast → close →
 * clear) so no live detached webContents races a wiped jar:
 *   1. broadcast `serverDisconnected` to every non-destroyed window (main +
 *      detached) — the `isDestroyed()` guard + swallowed send cover the
 *      `disconnectAll`-at-shutdown case (Q4);
 *   2. `closeDetachedMcpWindows(serverId)` — scoped-close this server's detached
 *      MCP-app windows (resolved lazily; null before window creation is harmless
 *      since no `mcp-app:` window can exist yet);
 *   3. `clearStorageData()` on the ephemeral per-server partition (MAJOR-2) —
 *      an in-memory Session persists for the whole process lifetime, so a
 *      remove→re-add of the same id would otherwise inherit stale storage.
 *
 * The WHOLE body is wrapped in try/catch (MINOR-A): the MINOR-4 encode-time
 * length guard throws SYNCHRONOUSLY through `mcpAppViewKeyPrefix` (step 2) and
 * `mcpAppPartitionName` (step 3) — the `.catch()` on `clearStorageData()` only
 * covers the async rejection — so without the outer guard a tampered >128-char
 * id (arriving via the servers.json/loadFromConfig path that bypasses addConfig)
 * would break teardown mid-emit. Best-effort by contract anyway (Q4).
 */
export function createMcpServerDisconnectedSink(
  deps: McpServerDisconnectedSinkDeps = {},
): (serverId: string) => void {
  const resolveWindowManager = deps.getWindowManager ?? getWindowManager;
  const getAllWindows =
    deps.getAllWindows ??
    (() =>
      (require("electron").BrowserWindow as typeof import("electron").BrowserWindow)
        .getAllWindows() as unknown as DisconnectSinkWindow[]);
  const fromPartition =
    deps.fromPartition ??
    ((name: string) =>
      (require("electron").session as typeof import("electron").session)
        .fromPartition(name) as unknown as DisconnectSinkSession);

  return (serverId: string) => {
    try {
      // 1. broadcast to the main window AND every detached window.
      for (const win of getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(CHANNELS.mcp.serverDisconnected, { serverId });
        }
      }
      // 2. scoped close of this server's detached MCP-app windows.
      resolveWindowManager()?.closeDetachedMcpWindows(serverId);
      // 3. clear the ephemeral per-server partition (best-effort, awaited-with-catch).
      void fromPartition(mcpAppPartitionName(serverId)).clearStorageData().catch(() => undefined);
    } catch (err) {
      log.warn("mcp: server-disconnected sink failed (%s): %s", serverId, (err as Error).message);
    }
  };
}
