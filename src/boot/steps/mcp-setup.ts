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
import { resolve } from "node:path";
import { McpGovernance } from "../../mcp/mcp-governance.js";
import { McpManager } from "../../mcp/mcp-manager.js";
import { createElicitationResolverFactory } from "../../mcp/mcp-elicitation-resolver.js";
import { DisabledMarketplaceFetcher } from "../../plugins/marketplace.js";
import { PluginArtifactStore } from "../../plugins/plugin-artifact-store.js";
import { getBundledPublicKeys } from "../../plugins/publisher-keys.js";
import { lvisHome } from "../../shared/lvis-home.js";
import { createLogger } from "../../lib/logger.js";
import type { BootContext } from "../context.js";

const log = createLogger("lvis");

export async function setupMcp(ctx: BootContext): Promise<void> {
  const { approvalGate, toolRegistry, permissionManager, bootAuditLogger, marketplaceFetcher } = ctx;

  // §9.5: MCP Server 연결.
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
