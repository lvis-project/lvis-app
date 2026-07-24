/**
 * `lvis://` deep-link handling — the runtime side of the protocol.
 *
 * Parsing lives in `lvis-protocol.ts` (pure, unit-tested); this module owns the
 * side-effecting handlers those parsers route to: marketplace install/uninstall
 * for plugins, MCP servers, agents, and skills, the MCP-login prepare flow, and
 * plugin OAuth callback re-emit. Deep links may arrive before `services` is
 * ready (cold start / second-instance), so unresolved URIs are queued via
 * `setPendingLvisUri` and drained by `main()` after boot.
 */
import { app, dialog, type BrowserWindow } from "electron";
import { resolve } from "node:path";
import { t } from "../i18n/index.js";
import { createLogger } from "../lib/logger.js";
import { sendToWindow } from "../ipc/safe-send.js";
import { emitEvent as emitHostEvent } from "../boot/types.js";
import type { AppServices } from "../boot.js";
import { lvisHome } from "../shared/lvis-home.js";
import {
  drainPluginInstallLockOperations,
  installMarketplacePluginWithLifecycle,
} from "../plugins/install-lifecycle.js";
import {
  ensurePluginStateReadyForInstall,
  uninstallPluginWithLifecycle,
} from "../plugins/uninstall-lifecycle.js";
import {
  buildNetworkAccessAcknowledgement,
  hasNetworkAccessDisclosure,
  type NetworkAccessGrant,
} from "../shared/network-access.js";
import {
  parseMarketplacePluginActionUri,
  parseMcpLoginUri,
  parsePluginAuthUri,
} from "./lvis-protocol.js";
import { getMainWindow, getServices, setPendingLvisUri } from "./app-state.js";
import {
  createWindow,
  getAppWindows,
  loadMainInterface,
  registerMainWindowPluginEventBridge,
  showMainWindow,
} from "./main-window.js";
import { activateInlineSettings } from "./app-menu.js";

const log = createLogger("lvis");

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function requirePluginCleanupServices(services: AppServices): {
  pluginPaths: NonNullable<AppServices["pluginPaths"]>;
  clearAuthPartitionService: NonNullable<
    AppServices["clearAuthPartitionService"]
  >;
  listPluginAuthPartitionsService: NonNullable<
    AppServices["listPluginAuthPartitionsService"]
  >;
  forgetPluginAuthPartitionsService: NonNullable<
    AppServices["forgetPluginAuthPartitionsService"]
  >;
} {
  const {
    pluginPaths,
    clearAuthPartitionService,
    listPluginAuthPartitionsService,
    forgetPluginAuthPartitionsService,
  } = services;
  if (
    !pluginPaths
    || !clearAuthPartitionService
    || !listPluginAuthPartitionsService
    || !forgetPluginAuthPartitionsService
  ) {
    throw new Error("plugin lifecycle cleanup services are not fully wired");
  }
  return {
    pluginPaths,
    clearAuthPartitionService,
    listPluginAuthPartitionsService,
    forgetPluginAuthPartitionsService,
  };
}

/**
 * Diagnostic log gate — diagnostic console output is dev-only. Packaged
 * builds skip these noisy traces so end-user log files stay clean.
 *
 * Intentionally NOT routed through `dev-flags.ts:isDevModeUnlocked()`:
 * those helpers require an explicit LVIS_DEV* opt-in to enable, but the
 * lvis:// protocol diagnostic flow needs to be debuggable on every
 * unpackaged dev session without forcing the operator to flip an env var.
 * The `app.isPackaged` boundary alone is the right level for log-only
 * output (no trust decisions ride on these calls).
 */
export const lvisDevLog = (msg: string, obj?: object) => {
  if (app.isPackaged) return;
  if (obj !== undefined) log.info(obj, msg);
  else log.info(msg);
};
const lvisDevWarn = (msg: string, obj?: object) => {
  if (app.isPackaged) return;
  if (obj !== undefined) log.warn(obj, msg);
  else log.warn(msg);
};

async function resolveMarketplaceActionTarget(
  activeServices: AppServices,
  slug: string,
): Promise<{
  pluginId: string;
  name: string;
  installed?: boolean;
  isManaged?: boolean;
  networkAccess?: NetworkAccessGrant;
}> {
  try {
    const catalogItems = await activeServices.pluginMarketplace.list();
    const item = catalogItems.find((candidate) => candidate.id === slug || candidate.slug === slug);
    return {
      pluginId: item?.id ?? slug,
      name: item?.name ?? slug,
      installed: item?.installed,
      isManaged: item?.isManaged,
      networkAccess: item?.networkAccess,
    };
  } catch (err) {
    lvisDevWarn("[lvis] marketplace target lookup failed; falling back to slug", {
      slug,
      error: errorMessage(err),
    });
    return { pluginId: slug, name: slug };
  }
}

function appendNetworkAccessDisclosureDetail(
  detail: string,
  networkAccess: NetworkAccessGrant | undefined,
): string {
  if (!hasNetworkAccessDisclosure(networkAccess)) return detail;
  const acknowledgement = buildNetworkAccessAcknowledgement(networkAccess);
  const lines = [
    detail,
    "",
    t("pluginInstallDialog.networkAccessTitle"),
  ];
  const reasoning = networkAccess?.reasoning?.trim();
  if (reasoning) lines.push(reasoning);
  if (acknowledgement?.allowedDomains.length) {
    lines.push(`${t("pluginInstallDialog.allowedDomainsLabel")}: ${acknowledgement.allowedDomains.join(", ")}`);
  }
  if (acknowledgement?.allowPrivateNetworks === true) {
    lines.push(t("pluginInstallDialog.allowPrivateNetworks"));
  }
  return lines.join("\n");
}

type MarketplacePackageType = "plugin" | "mcp" | "agent" | "skill";

function marketplacePackageLabel(packageType: MarketplacePackageType): string {
  if (packageType === "agent") return t("be_main.labelAgent");
  if (packageType === "skill") return t("be_main.labelSkill");
  if (packageType === "mcp") return t("be_main.labelMcpServer");
  return t("be_main.labelPlugin");
}

function assistantPackageChannels(packageType: "agent" | "skill"): {
  installProgress: string;
  installResult: string;
  uninstallResult: string;
} {
  const ns = packageType === "agent" ? "agents" : "skills";
  return {
    installProgress: `lvis:${ns}:install-progress`,
    installResult: `lvis:${ns}:install-result`,
    uninstallResult: `lvis:${ns}:uninstall-result`,
  };
}

async function handleAssistantMarketplaceAction(
  activeServices: AppServices,
  win: BrowserWindow,
  params: { action: "install" | "uninstall"; slug: string; packageType: "agent" | "skill" },
): Promise<void> {
  const channels = assistantPackageChannels(params.packageType);
  const label = marketplacePackageLabel(params.packageType);
  const target = await resolveMarketplaceActionTarget(activeServices, params.slug);
  if (params.action === "uninstall") {
    if (target.installed === false) {
      await dialog.showMessageBox(win, {
        type: "info",
        buttons: [t("be_main.btnOk")],
        defaultId: 0,
        cancelId: 0,
        message: t("be_main.packageNotInstalledMsg", { label, name: target.name }),
        detail: t("be_main.packageNotInstalledDetail"),
      });
      broadcastPluginLifecycleEvent(channels.uninstallResult, {
        slug: params.slug,
        success: false,
        error: `${label} not installed`,
      });
      return;
    }
    const { response } = await dialog.showMessageBox(win, {
      type: "warning",
      buttons: [t("be_main.btnRemove"), t("be_main.btnCancel")],
      defaultId: 1,
      cancelId: 1,
      message: t("be_main.packageUninstallMsg", { label, name: target.name }),
      detail: t("be_main.packageUninstallDetail"),
    });
    if (response !== 0) return;
    void (async () => {
      if (params.packageType === "agent") {
        const { uninstallAgentPackage } = await import("../agents/agent-installer.js");
        const result = await uninstallAgentPackage(params.slug, {
          installRoot: resolve(lvisHome(), "agents"),
          registryPath: resolve(lvisHome(), "agents", "registry.json"),
        });
        emitHostEvent("agent.uninstalled", { agentId: result.agentId, slug: result.slug, source: "marketplace" });
        broadcastPluginLifecycleEvent(channels.uninstallResult, {
          slug: result.slug,
          agentId: result.agentId,
          success: true,
        });
        return;
      }
      const { uninstallSkillPackage } = await import("../skills/skill-installer.js");
      const result = await uninstallSkillPackage(params.slug, {
        installRoot: resolve(lvisHome(), "skills"),
        registryPath: resolve(lvisHome(), "skills", "registry.json"),
      });
      emitHostEvent("skill.uninstalled", { skillId: result.skillId, slug: result.slug, source: "marketplace" });
      broadcastPluginLifecycleEvent(channels.uninstallResult, {
        slug: result.slug,
        skillId: result.skillId,
        success: true,
      });
    })().catch((err: Error) => {
      log.error({ slug: params.slug, packageType: params.packageType, error: err.message, stack: err.stack }, "lvis:// assistant package uninstall failed");
      broadcastPluginLifecycleEvent(channels.uninstallResult, {
        slug: params.slug,
        success: false,
        error: err.message,
      });
    });
    return;
  }

  const { response } = await dialog.showMessageBox(win, {
    type: "question",
    buttons: [t("be_main.btnInstall"), t("be_main.btnCancel")],
    defaultId: 1,
    cancelId: 1,
    message: t("be_main.packageInstallMsg", { label, name: target.name }),
    detail: t("be_main.packageInstallDetail"),
  });
  if (response !== 0) return;
  broadcastPluginLifecycleEvent(channels.installProgress, { slug: params.slug, phase: "installing" });
  void (async () => {
    if (params.packageType === "agent") {
      if (!activeServices.agentArtifactStore) {
        throw new Error("Agent marketplace install is unavailable: marketplace backend is disabled in this build.");
      }
      const { installAgentPackageFromMarketplace } = await import("../agents/agent-installer.js");
      const result = await installAgentPackageFromMarketplace(params.slug, {
        fetcher: activeServices.pluginMarketplace.getFetcher(),
        store: activeServices.agentArtifactStore,
        registryPath: resolve(lvisHome(), "agents", "registry.json"),
        onProgress: (evt) => {
          if (evt.phase === "downloading") {
            broadcastPluginLifecycleEvent(channels.installProgress, {
              slug: params.slug,
              phase: "downloading",
              bytesDownloaded: evt.bytesDownloaded,
              bytesTotal: evt.bytesTotal,
            });
          } else {
            broadcastPluginLifecycleEvent(channels.installProgress, { slug: params.slug, phase: evt.phase });
          }
        },
      });
      emitHostEvent("agent.installed", { agentId: result.agentId, slug: result.slug, source: "marketplace" });
      broadcastPluginLifecycleEvent(channels.installResult, {
        slug: result.slug,
        agentId: result.agentId,
        success: true,
      });
      return;
    }
    if (!activeServices.skillArtifactStore) {
      throw new Error("Skill marketplace install is unavailable: marketplace backend is disabled in this build.");
    }
    const { installSkillPackageFromMarketplace } = await import("../skills/skill-installer.js");
    const result = await installSkillPackageFromMarketplace(params.slug, {
      fetcher: activeServices.pluginMarketplace.getFetcher(),
      store: activeServices.skillArtifactStore,
      registryPath: resolve(lvisHome(), "skills", "registry.json"),
      onProgress: (evt) => {
        if (evt.phase === "downloading") {
          broadcastPluginLifecycleEvent(channels.installProgress, {
            slug: params.slug,
            phase: "downloading",
            bytesDownloaded: evt.bytesDownloaded,
            bytesTotal: evt.bytesTotal,
          });
        } else {
          broadcastPluginLifecycleEvent(channels.installProgress, { slug: params.slug, phase: evt.phase });
        }
      },
    });
    emitHostEvent("skill.installed", { skillId: result.skillId, slug: result.slug, source: "marketplace" });
    broadcastPluginLifecycleEvent(channels.installResult, {
      slug: result.slug,
      skillId: result.skillId,
      success: true,
    });
  })().catch((err: Error) => {
    log.error({ slug: params.slug, packageType: params.packageType, error: err.message, stack: err.stack }, "lvis:// assistant package install failed");
    broadcastPluginLifecycleEvent(channels.installResult, {
      slug: params.slug,
      success: false,
      error: err.message,
    });
  });
}

async function handleMcpMarketplaceAction(
  activeServices: AppServices,
  win: BrowserWindow,
  params: { action: "install" | "uninstall"; slug: string },
): Promise<void> {
  const label = marketplacePackageLabel("mcp");
  const target = await resolveMarketplaceActionTarget(activeServices, params.slug);
  if (params.action === "uninstall") {
    const { response } = await dialog.showMessageBox(win, {
      type: "warning",
      buttons: [t("be_main.btnRemove"), t("be_main.btnCancel")],
      defaultId: 1,
      cancelId: 1,
      message: t("be_main.packageUninstallMsg", { label, name: target.name }),
      detail: t("be_main.packageUninstallDetail"),
    });
    if (response !== 0) return;
    void activeServices.mcpManager.removeConfig(params.slug).catch((err: Error) => {
      log.error({ slug: params.slug, error: err.message, stack: err.stack }, "lvis:// MCP uninstall failed");
    });
    return;
  }
  const { response } = await dialog.showMessageBox(win, {
    type: "question",
    buttons: [t("be_main.btnInstall"), t("be_main.btnCancel")],
    defaultId: 1,
    cancelId: 1,
    message: t("be_main.packageInstallMsg", { label, name: target.name }),
    detail: t("be_main.packageInstallDetail"),
  });
  if (response !== 0) return;
  void (async () => {
    if (!activeServices.mcpArtifactStore) {
      throw new Error("MCP marketplace install is unavailable: marketplace backend is disabled in this build.");
    }
    const { installMcpFromMarketplace } = await import("../mcp/mcp-marketplace-install.js");
    await installMcpFromMarketplace(params.slug, {
      fetcher: activeServices.pluginMarketplace.getFetcher(),
      store: activeServices.mcpArtifactStore,
      pythonPath: activeServices.pythonPath,
      registerConfig: (config) => activeServices.mcpManager.addConfig(config),
    });
  })().catch((err: Error) => {
    log.error({ slug: params.slug, error: err.message, stack: err.stack }, "lvis:// MCP install failed");
  });
}

async function handleMcpLoginAction(
  activeServices: AppServices,
  win: BrowserWindow,
  params: { slug: string },
): Promise<void> {
  const existingConfigs = await activeServices.mcpManager.getConfigs().catch(() => []);
  if (existingConfigs.some((config) => config.id === params.slug)) {
    activateInlineSettings("mcp");
    return;
  }
  const target = await resolveMarketplaceActionTarget(activeServices, params.slug);

  const { response } = await dialog.showMessageBox(win, {
    type: "question",
    buttons: [t("be_main.btnInstallAndOpenSettings"), t("be_main.btnCancel")],
    defaultId: 1,
    cancelId: 1,
    message: t("be_main.mcpLoginPrepareMsg", { name: target.name }),
    detail: t("be_main.mcpLoginPrepareDetail"),
  });
  if (response !== 0) return;

  void (async () => {
    if (!activeServices.mcpArtifactStore) {
      throw new Error("MCP marketplace login is unavailable: marketplace backend is disabled in this build.");
    }
    const { installMcpFromMarketplace } = await import("../mcp/mcp-marketplace-install.js");
    await installMcpFromMarketplace(params.slug, {
      fetcher: activeServices.pluginMarketplace.getFetcher(),
      store: activeServices.mcpArtifactStore,
      pythonPath: activeServices.pythonPath,
      registerConfig: (config) => activeServices.mcpManager.addConfig(config),
    });
    activateInlineSettings("mcp");
  })().catch((err: Error) => {
    log.error({ slug: params.slug, error: err.message, stack: err.stack }, "lvis:// MCP login failed");
  });
}

export async function handleLvisUri(url: string) {
  lvisDevLog("[lvis] handleLvisUri called", { url });

  // Route generic plugin OAuth callback (`lvis://plugin-auth/<pluginId>?code=<code>`)
  // to a host event so the matching plugin can exchange the code.
  // Validation lives in parsePluginAuthUri — bad URIs silently drop
  // (DoS / probing defense). Plain-text `code` MUST NOT be logged.
  const authParams = parsePluginAuthUri(url);
  if (authParams) {
    lvisDevLog("[lvis] handleLvisUri: plugin auth callback received", {
      pluginId: authParams.pluginId,
      codeLength: authParams.code.length,
    });
    emitHostEvent("plugin.auth.code.received", {
      pluginId: authParams.pluginId,
      code: authParams.code,
    });
    return;
  }

  const mcpLoginParams = parseMcpLoginUri(url);
  if (mcpLoginParams) {
    const services = getServices();
    lvisDevLog("[lvis] handleLvisUri: MCP login URI parsed", {
      slug: mcpLoginParams.slug,
      servicesReady: !!services,
    });
    if (!services) {
      setPendingLvisUri(url);
      return;
    }
    const activeServices = services;
    let mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow({ showBootstrapSplash: false });
      mainWindow = getMainWindow();
      if (mainWindow) registerMainWindowPluginEventBridge(mainWindow);
      try {
        if (mainWindow) await loadMainInterface(mainWindow, "lvis-uri-mcp-login");
      } catch (err) {
        log.error({ err }, "failed to load index.html for lvis:// MCP login URI");
      }
    }
    // Fully surface the window (show + restore + focus + moveTop), not just
    // focus(): a hidden auto-launch (launchMinimized) leaves an alive-but-hidden
    // window, and a bare focus() would run the MCP-login dialog against an
    // invisible parent. showMainWindow also covers the hide-to-tray case where
    // the window is hidden (non-destroyed) when the deep link arrives.
    if (mainWindow) showMainWindow(mainWindow);
    const win = mainWindow;
    if (!win) {
      log.warn(`handleLvisUri: no window available, aborting MCP login for ${mcpLoginParams.slug}`);
      return;
    }
    await handleMcpLoginAction(activeServices, win, mcpLoginParams);
    return;
  }

  const params = parseMarketplacePluginActionUri(url);
  if (!params) {
    lvisDevWarn("[lvis] handleLvisUri: parseMarketplacePluginActionUri returned null", { url });
    return;
  }
  const services = getServices();
  lvisDevLog("[lvis] handleLvisUri parsed", {
    action: params.action,
    slug: params.slug,
    packageType: params.packageType,
    servicesReady: !!services,
  });
  if (!services) {
    lvisDevLog("[lvis] handleLvisUri: services not ready, queueing", {
      action: params.action,
      slug: params.slug,
      packageType: params.packageType,
    });
    setPendingLvisUri(url);
    return;
  }
  const activeServices = services;
  // macOS: app stays running after all windows closed. If the deep link arrives
  // with no window, re-open one so the confirmation dialog has a parent and the
  // user actually sees the install prompt (rather than it silently no-op'ing).
  let mainWindow = getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) {
    lvisDevLog("[lvis] handleLvisUri: recreating window");
    createWindow({ showBootstrapSplash: false });
    mainWindow = getMainWindow();
    if (mainWindow) registerMainWindowPluginEventBridge(mainWindow);
    try {
      if (mainWindow) await loadMainInterface(mainWindow, "lvis-uri-recreate");
    } catch (err) {
      log.error({ err }, "failed to load index.html for lvis:// URI");
    }
  }
  // Fully surface the window (show + restore + focus + moveTop), not just
  // focus(): a hidden auto-launch (launchMinimized) leaves an alive-but-hidden
  // window, and a bare focus() would run the install/uninstall confirmation
  // dialog against an invisible parent. showMainWindow also covers the
  // hide-to-tray case where the window is hidden (non-destroyed) at arrival.
  if (mainWindow) showMainWindow(mainWindow);
  const win = mainWindow;
  if (!win) {
    // createWindow() failed or was destroyed — abort rather than install silently.
    log.warn(`handleLvisUri: no window available, aborting ${params.action}`);
    return;
  }
  if (params.packageType === "agent" || params.packageType === "skill") {
    await handleAssistantMarketplaceAction(activeServices, win, {
      action: params.action,
      slug: params.slug,
      packageType: params.packageType,
    });
    return;
  }
  if (params.packageType === "mcp") {
    await handleMcpMarketplaceAction(activeServices, win, {
      action: params.action,
      slug: params.slug,
    });
    return;
  }
  if (params.action === "uninstall") {
    const target = await resolveMarketplaceActionTarget(activeServices, params.slug);
    if (target.isManaged) {
      await dialog.showMessageBox(win, {
        type: "warning",
        buttons: [t("be_main.btnOk")],
        defaultId: 0,
        cancelId: 0,
        message: t("be_main.pluginManagedCannotRemoveMsg", { name: target.name }),
        detail: t("be_main.pluginManagedCannotRemoveDetail"),
      });
      broadcastPluginLifecycleEvent("lvis:plugins:uninstall-result", {
        slug: target.pluginId,
        success: false,
        error: "Admin plugin cannot be uninstalled by user",
      });
      return;
    }
    if (target.installed === false) {
      await dialog.showMessageBox(win, {
        type: "info",
        buttons: [t("be_main.btnOk")],
        defaultId: 0,
        cancelId: 0,
        message: t("be_main.pluginNotInstalledMsg", { name: target.name }),
        detail: t("be_main.pluginNotInstalledDetail"),
      });
      broadcastPluginLifecycleEvent("lvis:plugins:uninstall-result", {
        slug: target.pluginId,
        success: false,
        error: "Plugin not installed",
      });
      return;
    }
    lvisDevLog("[lvis] handleLvisUri: showing uninstall confirmation dialog", {
      slug: params.slug,
      pluginId: target.pluginId,
    });
    const { response } = await dialog.showMessageBox(win, {
      type: "warning",
      buttons: [t("be_main.btnRemove"), t("be_main.btnCancel")],
      defaultId: 1,
      cancelId: 1,
      message: t("be_main.pluginUninstallMsg", { name: target.name }),
      detail: t("be_main.pluginUninstallDetail"),
    });
    lvisDevLog("[lvis] handleLvisUri: uninstall dialog response", {
      slug: params.slug,
      pluginId: target.pluginId,
      response,
    });
    if (response !== 0) return;
    void (async () => {
      const cleanupServices = requirePluginCleanupServices(activeServices);
      const result = await uninstallPluginWithLifecycle(target.pluginId, {
        pluginMarketplace: activeServices.pluginMarketplace,
        pluginRuntime: activeServices.pluginRuntime,
        settingsService: activeServices.settingsService,
        ...cleanupServices,
        drainPluginInstallLockOperationsService:
          drainPluginInstallLockOperations,
        refreshPluginNotifications: activeServices.refreshPluginNotifications,
        emitHostEvent,
        log,
      });
      broadcastPluginLifecycleEvent("lvis:plugins:uninstall-result", {
        slug: result.pluginId,
        success: true,
      });
    })().catch((err: Error) => {
      log.error({ slug: params.slug, error: err.message, stack: err.stack }, "lvis:// uninstall failed");
      broadcastPluginLifecycleEvent("lvis:plugins:uninstall-result", {
        slug: params.slug,
        success: false,
        error: err.message,
      });
    });
    return;
  }

  const target = await resolveMarketplaceActionTarget(activeServices, params.slug);
  lvisDevLog("[lvis] handleLvisUri: showing confirmation dialog", { slug: params.slug });
  const { response } = await dialog.showMessageBox(win, {
    type: "question",
    buttons: [t("be_main.btnInstall"), t("be_main.btnCancel")],
    defaultId: 1,
    cancelId: 1,
    message: t("be_main.pluginInstallMsg", { slug: params.slug }),
    detail: appendNetworkAccessDisclosureDetail(
      t("be_main.pluginInstallDetail"),
      target.networkAccess,
    ),
  });
  lvisDevLog("[lvis] handleLvisUri: dialog response", { slug: params.slug, response });
  if (response !== 0) return;
  lvisDevLog("[lvis] handleLvisUri: starting install", { slug: params.slug });
  const networkAccessAcknowledgement = buildNetworkAccessAcknowledgement(target.networkAccess);
  let installProgressSlug = params.slug;
  void (async () => {
    const cleanupServices = requirePluginCleanupServices(activeServices);
    const catalogItems = await activeServices.pluginMarketplace.list();
    const installLockId =
      catalogItems.find((item) => item.id === params.slug || item.slug === params.slug)?.id ?? params.slug;
    installProgressSlug = installLockId;
    // Renderer renders a skeleton card while these phase events fire — see
    // PluginConfigTab + plugin grid progress UI. Key every phase by the
    // canonical plugin id so alias deep-links don't leave stale in-flight rows.
    const result = await installMarketplacePluginWithLifecycle({
      requestedPluginId: params.slug,
      eventSlug: installLockId,
      lifecyclePluginId: installLockId,
      networkAccessAcknowledgement,
      pluginRuntime: activeServices.pluginRuntime,
      pluginMarketplace: activeServices.pluginMarketplace,
      ensurePluginStateReadyForInstall: (candidatePluginId) =>
        ensurePluginStateReadyForInstall(candidatePluginId, {
          pluginMarketplace: activeServices.pluginMarketplace,
          pluginRuntime: activeServices.pluginRuntime,
          settingsService: activeServices.settingsService,
          ...cleanupServices,
          drainPluginInstallLockOperationsService:
            drainPluginInstallLockOperations,
          refreshPluginNotifications: activeServices.refreshPluginNotifications,
          emitHostEvent,
          log,
        }),
      broadcastInstallProgress: (payload) =>
        broadcastPluginLifecycleEvent("lvis:plugins:install-progress", payload),
      emitPluginInstalled: (payload) => emitHostEvent("plugin.installed", payload),
      refreshPluginNotifications: activeServices.refreshPluginNotifications,
    });
    const pluginId = result.pluginId;
    lvisDevLog("[lvis] handleLvisUri: install succeeded", { slug: pluginId });
    broadcastPluginLifecycleEvent("lvis:plugins:install-result", {
      slug: pluginId,
      success: true,
    });
  })().catch((err: Error) => {
    log.error({ slug: params.slug, error: err.message, stack: err.stack }, "lvis:// install failed");
    broadcastPluginLifecycleEvent("lvis:plugins:install-result", { slug: installProgressSlug, success: false, error: err.message });
  });
}

function broadcastPluginLifecycleEvent(channel: string, payload: unknown): void {
  for (const win of getAppWindows()) {
    sendToWindow(win, channel, payload, log);
  }
}
