/**
 * Boot step — MCP server connection + signed marketplace artifact stores
 * (§9.5 + §FU#259, extracted from boot.ts C18).
 *
 * Constructs the MCP governance + manager, connects any configured servers
 * (non-fatal), starts the policy-refresh kill-switch loop, and builds the
 * signed-artifact stores for marketplace MCP servers / agents / skills — each
 * rooted under `~/.lvis/<feature>/` and only when the marketplace fetcher
 * supports verified downloads (the disabled fetcher leaves them undefined).
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { McpGovernance } from "../../mcp/mcp-governance.js";
import { McpManager } from "../../mcp/mcp-manager.js";
import { createElicitationResolverFactory } from "../../mcp/mcp-elicitation-resolver.js";
import { DisabledMarketplaceFetcher } from "../../plugins/marketplace.js";
import { PluginArtifactStore } from "../../plugins/plugin-artifact-store.js";
import { getBundledPublicKeys } from "../../plugins/publisher-keys.js";
import { lvisHome } from "../../shared/lvis-home.js";
import { mcpAppPartitionName } from "../../shared/mcp-app-partition.js";
import { CHANNELS } from "../../contract/app-contract.js";
import { getWindowManager } from "../../main/app-state.js";
import { createLogger } from "../../lib/logger.js";
import type { BootContext } from "../context.js";

const log = createLogger("lvis");
const require = createRequire(import.meta.url);

// ─── b3 disconnect sink (#885) ─────────────────────────────────────────────────

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
 * #885 b3 — build the `onServerDisconnected` sink wired into McpManager.
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

export async function setupMcp(ctx: BootContext): Promise<void> {
  const { approvalGate, toolRegistry, permissionManager, bootAuditLogger, marketplaceFetcher } = ctx;


  const mcpGovernance = new McpGovernance();
  // MRTR live-resolver wiring (milestone mrtr-input-loop): a server's
  // `input_required` (elicitation) is gathered through the host approval gate.
  const mcpInputResolverFactory = createElicitationResolverFactory({ approvalGate });
  const mcpManager = new McpManager(
    mcpGovernance,
    toolRegistry,
    undefined,
    permissionManager,
    bootAuditLogger,
    mcpInputResolverFactory,
    // #885 b3 — disconnect teardown sink. Resolves WindowManager lazily at emit
    // time (BootContext has no windowManager; it is the module-level singleton
    // in app-state, set at main.ts after window creation).
    createMcpServerDisconnectedSink(),
  );
  try {
    const configs = await mcpManager.loadFromConfig();
    if (configs.length > 0) {
      await mcpManager.connectAll();
      log.info("boot: MCP servers connected");
    }
  } catch (err) {
    log.warn("boot: MCP initialization failed (non-fatal): %s", (err as Error).message);
  }
  mcpGovernance.startPolicyRefresh((revokedIds) => {
    for (const serverId of revokedIds) {
      void mcpManager.killSwitch(serverId).catch((err) => {
        log.error({ serverId, err }, "boot: revoked MCP server kill failed");
      });
    }
  });

  // §FU#259 — MCP marketplace artifact store. Rooted at ~/.lvis/mcp/ so the
  // server config (servers.json) and install directories share one parent —
  // user-controlled state lives under ~/.lvis/, not Electron's userData.
  // Each installed server gets ~/.lvis/mcp/<slug>/; the catalog config sits
  // at ~/.lvis/mcp/servers.json. Constructed only when the fetcher supports
  // verified downloads (the disabled fetcher throws on any download attempt
  // anyway).
  const mcpArtifactStore = (() => {
    if (marketplaceFetcher instanceof DisabledMarketplaceFetcher) return undefined;
    const mcpInstallRoot = resolve(lvisHome(), "mcp");
    return new PluginArtifactStore({
      installRoot: mcpInstallRoot,
      cacheRoot: resolve(mcpInstallRoot, ".cache"),
      fetcher: marketplaceFetcher,
      publicKeys: getBundledPublicKeys(),
    });
  })();
  const agentArtifactStore = (() => {
    if (marketplaceFetcher instanceof DisabledMarketplaceFetcher) return undefined;
    const agentInstallRoot = resolve(lvisHome(), "agents");
    return new PluginArtifactStore({
      installRoot: agentInstallRoot,
      cacheRoot: resolve(agentInstallRoot, ".cache"),
      fetcher: marketplaceFetcher,
      publicKeys: getBundledPublicKeys(),
    });
  })();
  const skillArtifactStore = (() => {
    if (marketplaceFetcher instanceof DisabledMarketplaceFetcher) return undefined;
    const skillInstallRoot = resolve(lvisHome(), "skills");
    return new PluginArtifactStore({
      installRoot: skillInstallRoot,
      cacheRoot: resolve(skillInstallRoot, ".cache"),
      fetcher: marketplaceFetcher,
      publicKeys: getBundledPublicKeys(),
    });
  })();

  ctx.mcpGovernance = mcpGovernance;
  ctx.mcpManager = mcpManager;
  ctx.mcpArtifactStore = mcpArtifactStore;
  ctx.agentArtifactStore = agentArtifactStore;
  ctx.skillArtifactStore = skillArtifactStore;
}
