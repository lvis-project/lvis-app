/**
 * Plugins domain IPC handlers.
 * Covers: lvis:plugins:*, lvis:bootstrap:*, lvis:runtime:*, lvis:marketplace:*,
 *         lvis:mcp:*, lvis:plugin:* (webview bridge), lvis:file:*,
 *         lvis:notification:clicked
 */
import { dialog, ipcMain, webContents } from "electron";
import { t } from "../../i18n/index.js";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { emitEvent as emitHostEvent } from "../../boot/types.js";
import { HOST_ONLY_EMIT_NAMESPACES, canEmitEvent, requiredCapabilityForEmit } from "../../plugins/capabilities.js";
import { getDeclaredEmittedEvents } from "../../plugins/runtime/manifest-validation.js";
import { stripSecretFields } from "../../plugins/config-schema.js";
import { shouldBlockPluginSecretRead, validateApiKeyLikeSecretValue } from "../../plugins/secret-shape.js";
import { emitPluginConfigChange, SECRET_REDACTED_SENTINEL } from "../../plugins/config-change-bus.js";
import { runManagedBootstrap } from "../../boot/managed-marketplace.js";
import { isDevModeUnlocked } from "../../boot/dev-flags.js";
import {
  IPC_NOTIFICATION_CLICKED,
  NOTIFICATION_KINDS,
  type NotificationContextRef,
  type NotificationKind,
} from "../../main/notification-service.js";
import { validateSender, validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized, validatePluginFrame } from "../gated.js";
import { CHANNELS } from "../../contract/app-contract.js";
import type { IpcDeps } from "../types.js";
import { sendToWindow } from "../safe-send.js";
import { createLogger } from "../../lib/logger.js";
import { plog, PluginPhase } from "../../plugins/lifecycle-log.js";
import { redactFsPath, redactAuditPayload } from "../../audit/dlp-filter.js";
import {
  cloneThemePayload,
  getLastThemePayload,
  recordValidatedTheme,
  resetLastThemePayloadForTests,
  validateThemePayload,
  type SafeThemePayload,
} from "../../shared/plugin-theme-cache.js";
import { pluginAssetUrlFromRealPath } from "../../main/plugin-asset-protocol.js";
import { installMcpAppPartitionPolicy } from "../../main/html-preview-partition.js";
import { createMcpAppProxySession, disposeMcpAppProxySession } from "../../main/mcp-app-protocol.js";
import { resolveMcpUiBackend } from "../../mcp/mcp-ui-backend-resolver.js";
import {
  createExternalToolCallSource,
  createLoopbackToolCallSource,
} from "../../mcp/mcp-ui-tool-call.js";
import type { McpUiResourceBundle, McpUiToolCallOutcome } from "../../mcp/types.js";
import { parseUiMessageIntent, type McpUiMessageOutcome } from "../../mcp/mcp-ui-message.js";
import { parseMcpAppDownload, type McpUiDownloadOutcome } from "../../mcp/mcp-app-download.js";
import type { McpUiModelContextOutcome } from "../../mcp/mcp-app-model-context.js";
import { appMessageSource, formatAppMessageEnvelope, isAppMessageOrigin } from "../../shared/mcp-app-message-source.js";
// The MCP-app `ui/message` staging path reuses the plugin overlay gate's rate limiter
// (one mechanism for "staged conversation proposals") and the same overlay push channel.
import {
  deriveOverlaySummaryForDisplay,
  triggerConversationRateLimiter,
} from "../../boot/steps/plugin-runtime/trigger-gate.js";
import { OVERLAY_V1 } from "../../shared/ipc-channels.js";
import {
  installMarketplacePluginWithLifecycle,
  rollbackMarketplacePluginWithLifecycle,
  withPluginInstallLock,
} from "../../plugins/install-lifecycle.js";
import {
  cleanupFailedPluginInstallWithLifecycle,
  uninstallPluginWithLifecycle,
} from "../../plugins/uninstall-lifecycle.js";
import { IncompatibleAppVersionError, INCOMPATIBLE_APP_VERSION_CODE } from "../../plugins/types.js";
import { lvisHome } from "../../shared/lvis-home.js";
import type { NetworkAccessAcknowledgement } from "../../shared/network-access.js";
import { isPluginInstallFailureKind, type PluginInstallFailureKind } from "../../shared/plugin-install-failure.js";
import {
  handlePluginBundleE2eSnapshot,
  handlePluginCards,
  handleMarketplaceList,
} from "../handlers/plugins.js";
const log = createLogger("lvis");
const MARKETPLACE_PING_TIMEOUT_MS = 15_000;
const MARKETPLACE_PING_CACHE_TTL_MS = 10_000;

export {
  getLastThemePayload,
  recordValidatedTheme,
  validateThemePayload,
};
export type { SafeThemePayload };

type MarketplacePingResult = { configured: boolean; online: boolean };

function pluginConfigError(
  error: string,
  message: string,
): { ok: false; error: string; message: string } {
  return { ok: false, error, message };
}

function asPlainRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function parseNetworkAccessAcknowledgement(value: unknown): NetworkAccessAcknowledgement | undefined {
  const input = asPlainRecord(value);
  const rawDomains = input.allowedDomains;
  if (!Array.isArray(rawDomains)) return undefined;
  const allowedDomains = rawDomains
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
  return {
    allowedDomains,
    ...(input.allowPrivateNetworks === true ? { allowPrivateNetworks: true as const } : {}),
  };
}

function parseDoctorCleanupKind(value: unknown): PluginInstallFailureKind | undefined {
  const input = asPlainRecord(value);
  const doctorCleanup = asPlainRecord(input.doctorCleanup);
  const kind = doctorCleanup.installFailureKind;
  return isPluginInstallFailureKind(kind) ? kind : undefined;
}

function sanitizeNotificationContextRef(value: unknown): NotificationContextRef | undefined {
  const input = asPlainRecord(value);
  const contextRef: NotificationContextRef = {};
  for (const key of ["sessionId", "routineId", "questionId", "approvalId"] as const) {
    const candidate = input[key];
    if (typeof candidate === "string" && candidate.length > 0) {
      contextRef[key] = candidate.slice(0, 256);
    }
  }
  return Object.keys(contextRef).length > 0 ? contextRef : undefined;
}

/**
 * Normalize unknown thrown values to a string message — `instantiateAndStart`
 * / userland `createPlugin` callbacks may `throw "string"` or
 * `throw { code, … }` rather than `Error`. `(err as Error).message` would
 * print `undefined` in those cases. Used by the install rollback paths
 * where the message goes to both the renderer toast and the IPC error.
 */
function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function validateSecretConfigValue(
  pluginId: string,
  key: string,
  value: string,
): { ok: false; error: string; message: string } | null {
  if (validateApiKeyLikeSecretValue({ key, value })) {
    return pluginConfigError(
      "plugin-config-secret-invalid-value",
      `Plugin '${pluginId}' secret field '${key}' looks like an endpoint URL. Save endpoint URLs in the matching URL/baseUrl field, not in the API key field.`,
    );
  }
  return null;
}
interface PluginWebviewBinding {
  pluginId: string;
  entryUrl: string;
  assetEntryUrl: string;
  /** Host-minted authority scope; never accepted from the renderer/plugin. */
  appSessionId: string;
}
const pluginWebviewRegistry = new Map<number, PluginWebviewBinding>();

/**
 * Publish a host-owned theme change on the plugin event bus. Plugin webviews
 * still receive the direct IPC fanout below; host plugins that own detached
 * windows can subscribe through hostApi.onEvent("host.theme.changed").
 */
export function publishHostThemeChanged(safe: SafeThemePayload): void {
  emitHostEvent("host.theme.changed", cloneThemePayload(safe));
}

/**
 * Push the cached theme payload to a freshly registered webview so the
 * plugin paints with the active tokens from first frame instead of the
 * SDK `:root` fallback. Returns the payload that was sent (or null when
 * the cache is empty / wc destroyed) so callers can log lifecycle.
 *
 * Synchronous between `register-webview` returning OK and this call, so
 * `webContents.fromId` should always succeed; the catch is defensive
 * against pathological reload paths where the wc tears down between
 * registry-set and send.
 */
export function replayThemeToWebview(webContentsId: number): SafeThemePayload | null {
  const theme = getLastThemePayload();
  if (!theme) return null;
  try {
    const wc = webContents.fromId(webContentsId);
    if (wc && !wc.isDestroyed()) {
      wc.send(CHANNELS.pluginBridge.event, "host.theme.changed", theme);
      return theme;
    }
  } catch {
    /* swallowed — caller logs at debug. */
  }
  return null;
}

/** @internal — test-only reset to keep cross-test state clean. */
export function __resetLastThemePayloadForTests(): void {
  resetLastThemePayloadForTests();
}

/**
 * Wait queue for `lvis:plugin:get-entry-url` invocations that arrive before
 * `lvis:plugin:register-webview` lands a binding for the same webContentsId.
 *
 * Why this exists: `<webview>` in `plugin-ui-host.tsx` renders with an initial
 * `src={shellSrc || shellUrl}` because Electron only runs `<webview preload>`
 * at the *first* attach — switching from about:blank to the real shell URL
 * does NOT re-execute preload, so the lvisPlugin contextBridge would be lost.
 * That fallback means the shell can call `getEntryUrl()` *before* the host
 * renderer's `did-attach` → `registerPluginWebview` round-trip completes.
 * Queue holds those resolvers until the matching register lands (or the 5s
 * deadline expires, in which case the original "not-registered" sentinel is
 * returned so a truly absent registration is still surfaced).
 *
 * Restored in 2026-05-04 after PR #447 removed it on the assumption that
 * register-before-attach was airtight; the assumption broke in the plugin
 * update lifecycle (plugin webview re-attach with a fresh wcId), where the
 * shell's first paint raced ahead of the host's register IPC.
 */
const PENDING_ENTRY_URL_DEADLINE_MS = 5_000;
type PendingEntryUrlResolver = (
  reply: { ok: true; entryUrl: string } | { ok: false; error: "not-registered" },
) => void;
const pendingEntryUrlResolvers = new Map<number, Set<PendingEntryUrlResolver>>();

function flushPendingEntryUrl(webContentsId: number, binding: PluginWebviewBinding): void {
  const resolvers = pendingEntryUrlResolvers.get(webContentsId);
  if (!resolvers) return;
  pendingEntryUrlResolvers.delete(webContentsId);
  for (const resolve of resolvers) resolve({ ok: true, entryUrl: binding.assetEntryUrl });
}

function clearPendingEntryUrl(webContentsId: number): void {
  const resolvers = pendingEntryUrlResolvers.get(webContentsId);
  if (!resolvers) return;
  pendingEntryUrlResolvers.delete(webContentsId);
  for (const resolve of resolvers) resolve({ ok: false, error: "not-registered" });
}


export function unregisterPluginWebview(
  webContentsId: number,
  revokeSession: (appSessionId: string) => void,
): void {
  const binding = pluginWebviewRegistry.get(webContentsId);
  if (binding) revokeSession(binding.appSessionId);
  pluginWebviewRegistry.delete(webContentsId);
  clearPendingEntryUrl(webContentsId);
}

export function registerPluginsHandlers(deps: IpcDeps): void {
  const {
    pluginRuntime,
    pluginMarketplace,
    settingsService,
    auditLogger,
    refreshPluginNotifications,
    pluginPaths,
    clearAuthPartitionService,
    listPluginAuthPartitionsService,
    forgetPluginAuthPartitionsService,
    mcpArtifactStore,
    agentArtifactStore,
    skillArtifactStore,
    getMainWindow,
    getAppWindows,
  } = deps;
  const broadcastPluginLifecycleEvent = (channel: string, payload: unknown) => {
    for (const win of getAppWindows?.() ?? [getMainWindow()]) {
      sendToWindow(win, channel, payload, log);
    }
  };
  let marketplacePingCache:
    | { key: string; result: MarketplacePingResult; timestampMs: number }
    | null = null;
  let marketplacePingInflight:
    | { key: string; promise: Promise<MarketplacePingResult> }
    | null = null;

  const runMarketplacePing = async (): Promise<MarketplacePingResult> => {
    const settings = settingsService.get("marketplace");
    if (settings.backend !== "real-cloud" || !settings.cloudBaseUrl) {
      return { configured: false, online: false };
    }

    const base = settings.cloudBaseUrl.replace(/\/?$/, "/");
    const key = `${settings.backend}|${base}|${settings.cloudAllowPrivateNetwork === true}`;
    const now = Date.now();
    if (
      marketplacePingCache &&
      marketplacePingCache.key === key &&
      now - marketplacePingCache.timestampMs < MARKETPLACE_PING_CACHE_TTL_MS
    ) {
      return marketplacePingCache.result;
    }
    if (marketplacePingInflight?.key === key) {
      return marketplacePingInflight.promise;
    }

    const promise = (async (): Promise<MarketplacePingResult> => {
      try {
        const url = new URL("api/v1/health", base).toString();
        let res: Response;
        if (settings.cloudAllowPrivateNetwork === true) {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), MARKETPLACE_PING_TIMEOUT_MS);
          try {
            res = await fetch(url, { signal: ctrl.signal });
          } finally {
            clearTimeout(timer);
          }
        } else {
          const { fetchPublicHttpResponse } = await import("../../core/network-guard.js");
          res = await fetchPublicHttpResponse(url, { timeoutMs: MARKETPLACE_PING_TIMEOUT_MS });
        }
        const result = { configured: true, online: res.ok } as const;
        marketplacePingCache = { key, result, timestampMs: Date.now() };
        return result;
      } catch (err) {
        // Periodic health probes are user-visible via the status dot. Logging
        // every timeout at warn level turns transient network latency into log
        // noise while update-check/catalog fetches still report actionable
        // marketplace failures on their own paths.
        log.debug("marketplace ping failed: %s", errMessage(err));
        const result = { configured: true, online: false } as const;
        marketplacePingCache = { key, result, timestampMs: Date.now() };
        return result;
      } finally {
        if (marketplacePingInflight?.key === key) {
          marketplacePingInflight = null;
        }
      }
    })();
    marketplacePingInflight = { key, promise };
    return promise;
  };
  // Bootstrap retry
  ipcMain.handle(CHANNELS.bootstrap.retry, async (e) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.bootstrap.retry, e);
      return UNAUTHORIZED_FRAME;
    }
    const marketplace = settingsService.get("marketplace");
    await runManagedBootstrap({
      pluginMarketplace,
      pluginRuntime,
      mainWindow: getMainWindow(),
      marketplace,
    });
    return { ok: true } as const;
  });

  ipcMain.handle(CHANNELS.plugins.install, async (e, pluginId: string, options?: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.plugins.install, e); return UNAUTHORIZED_FRAME; }
    const lifecycleSlug = pluginId;
    const installOptions = asPlainRecord(options);
    const expectedVersionValue = installOptions.expectedVersion;
    const networkAccessAcknowledgement = parseNetworkAccessAcknowledgement(
      installOptions.networkAccessAcknowledgement,
    );
    if (expectedVersionValue !== undefined && typeof expectedVersionValue !== "string") {
      throw new Error("expectedVersion must be a string when provided");
    }
    const expectedVersion = typeof expectedVersionValue === "string" ? expectedVersionValue.trim() || undefined : undefined;
    let result: { pluginId: string; installed: true } | null = null;
    // IPC is pure transport — actor decisions live inside
    // PluginMarketplaceService.install (catalog → admin escalation).
    // deployment-guard §7.3: "IPC 핸들러에서 actor를 직접 받지 말 것 —
    // 'it-admin'은 ManagedPluginInstaller 같은 내부 플로우에서만 사용."
    try {
      result = await installMarketplacePluginWithLifecycle({
        requestedPluginId: pluginId,
        eventSlug: lifecycleSlug,
        expectedVersion,
        networkAccessAcknowledgement,
        pluginRuntime,
        pluginMarketplace,
        broadcastInstallProgress: (payload) =>
          broadcastPluginLifecycleEvent(CHANNELS.plugins.installProgress, payload),
        emitPluginInstalled: (payload) => emitHostEvent("plugin.installed", payload),
        refreshPluginNotifications,
      });
    } catch (err) {
      const message = errMessage(err) || "addPlugin failed";
      // Plugin↔app minimum-version gate — surface the stable English IPC code
      // so the renderer maps it to the Korean "needs newer app" copy + update
      // link (per the IPC Error Message Language Convention). Other install
      // failures keep their plain message.
      const code = err instanceof IncompatibleAppVersionError
        ? INCOMPATIBLE_APP_VERSION_CODE
        : undefined;
      broadcastPluginLifecycleEvent(CHANNELS.plugins.installResult, {
        slug: lifecycleSlug,
        success: false,
        error: code ?? message,
        ...(code ? { message } : {}),
      });
      throw err;
    }
    broadcastPluginLifecycleEvent(CHANNELS.plugins.installResult, { slug: lifecycleSlug, success: true });
    return result;
  });

  ipcMain.handle(CHANNELS.plugins.rollback, async (e, pluginId: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.plugins.rollback, e);
      return UNAUTHORIZED_FRAME;
    }
    const normalizedPluginId = typeof pluginId === "string" ? pluginId.trim() : "";
    if (!normalizedPluginId) throw new Error("pluginId is required for rollback");
    return rollbackMarketplacePluginWithLifecycle({
      pluginId: normalizedPluginId,
      pluginRuntime,
      pluginMarketplace,
    });
  });

  ipcMain.handle(CHANNELS.plugins.uninstall, async (e, pluginId: string, rawOptions?: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.plugins.uninstall, e); return UNAUTHORIZED_FRAME; }
    const broadcastUninstallResult = (payload: { slug: string; success: boolean; error?: string }) => {
      broadcastPluginLifecycleEvent(CHANNELS.plugins.uninstallResult, payload);
    };
    try {
      const doctorCleanupKind = parseDoctorCleanupKind(rawOptions);
      const matchingFailure = doctorCleanupKind
        ? pluginMarketplace
            .getInstallFailureDiagnostics()
            .find((failure) => failure.id === pluginId && failure.installFailureKind === doctorCleanupKind)
        : undefined;
      const canCleanupSyntheticFailure = matchingFailure
        ? await pluginMarketplace.getInstalledVersion(pluginId)
            .then((installedVersion) => installedVersion === null)
            .catch((err) => {
              log.warn(`doctor cleanup refused for '${pluginId}': cannot prove plugin is absent: ${errMessage(err)}`);
              return false;
            })
        : false;
      if (matchingFailure && canCleanupSyntheticFailure) {
        const result = await cleanupFailedPluginInstallWithLifecycle(pluginId, {
          pluginMarketplace,
          pluginRuntime,
          settingsService,
          pluginPaths,
          clearAuthPartitionService,
          listPluginAuthPartitionsService,
          forgetPluginAuthPartitionsService,
          refreshPluginNotifications,
          emitHostEvent,
          log,
        });
        broadcastUninstallResult({ slug: pluginId, success: true });
        return result;
      }

      // Lifecycle ordering lives in uninstallPluginWithLifecycle:
      // runtime remove (stop/dispose) first, marketplace file removal second,
      // then best-effort host state cleanup. This keeps the Windows EBUSY
      // defense from PR #734 while centralizing config/secret/auth cleanup.
      const result = await uninstallPluginWithLifecycle(pluginId, {
        pluginMarketplace,
        pluginRuntime,
        settingsService,
        pluginPaths,
        clearAuthPartitionService,
        listPluginAuthPartitionsService,
        forgetPluginAuthPartitionsService,
        refreshPluginNotifications,
        emitHostEvent,
        log,
      });
      broadcastUninstallResult({ slug: pluginId, success: true });
      return result;
    } catch (err) {
      const message = (err as Error).message ?? "uninstall failed";
      broadcastUninstallResult({ slug: pluginId, success: false, error: message });
      throw err;
    }
  });

  // Toggle through the immutable generation lifecycle. Disable publishes an
  // inactive pointer and drains teardown; re-enable reverifies installed bytes
  // before atomically publishing a new generation.
  ipcMain.handle(
    CHANNELS.plugins.setEnabled,
    async (e, pluginId: unknown, enabled: unknown) => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.plugins.setEnabled, e);
        return UNAUTHORIZED_FRAME;
      }
      if (typeof pluginId !== "string" || pluginId.length === 0) {
        return pluginConfigError("invalid-plugin-id", "pluginId must be a non-empty string");
      }
      if (typeof enabled !== "boolean") {
        return pluginConfigError("invalid-enabled", "enabled must be a boolean");
      }
      try {
        await pluginRuntime.setPluginEnabled(pluginId, enabled);
      } catch (err) {
        const message = errMessage(err);
        if (message.startsWith("Plugin not found")) {
          return pluginConfigError("no-such-plugin", `unknown plugin: ${pluginId}`);
        }
        log.error(`plugin enabled-state change failed (${pluginId}): %s`, message);
        return pluginConfigError("toggle-failed", "plugin enabled state could not be changed");
      }
      emitHostEvent("plugin.enabled-changed", { pluginId, enabled });
      broadcastPluginLifecycleEvent(CHANNELS.plugins.enabledChanged, { pluginId, enabled });
      return { ok: true, pluginId, enabled } as const;
    },
  );

  ipcMain.handle(CHANNELS.plugins.installLocal, async (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.plugins.installLocal, e); return UNAUTHORIZED_FRAME; }
    if (!isDevModeUnlocked()) {
      throw new Error("[security] dev mode not unlocked — enable a supported LVIS_DEV* flag in a non-packaged build");
    }
    const { filePaths, canceled } = await dialog.showOpenDialog({
      title: t("mainDialog.installLocalPluginTitle"),
      properties: ["openDirectory"],
      message: t("mainDialog.installLocalPluginMessage"),
    });
    if (canceled || !filePaths[0]) return null;
    // Local-dev uses the same staged generation transaction as marketplace:
    // candidate import/start happens from immutable bytes before live payload,
    // receipt, registry, or active pointer publication.
    const pluginId = await pluginMarketplace.resolveLocalInstallPluginId(filePaths[0]);
    return await withPluginInstallLock(pluginId, async () => {
      try {
        const result = await pluginMarketplace.installLocal(filePaths[0], {
          activatePreparedArtifact: (prepared) => pluginRuntime.activatePreparedArtifact<string>(prepared),
        });
        if (!pluginRuntime.listPluginIds().includes(result.pluginId)) {
          throw new Error(`atomic local install committed without active runtime: ${result.pluginId}`);
        }
        emitHostEvent("plugin.installed", { pluginId: result.pluginId, source: "local-dev" });
        refreshPluginNotifications?.();
        broadcastPluginLifecycleEvent(CHANNELS.plugins.installResult, {
          slug: result.pluginId,
          success: true,
        });
        return result;
      } catch (err) {
        const message = errMessage(err) || "addPlugin failed";
        broadcastPluginLifecycleEvent(CHANNELS.plugins.installResult, {
          slug: pluginId,
          success: false,
          error: message,
        });
        throw err;
      }
    });
  });

  // read-only, sender guard optional
  ipcMain.handle(CHANNELS.plugins.uiList, () => pluginRuntime.listUiExtensions());

  ipcMain.handle(CHANNELS.plugins.uiReadModule, async (e, payload?: { pluginId?: string; viewId?: string }) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.plugins.uiReadModule, e);
      throw new Error("Unauthorized renderer frame for lvis:plugins:ui:read-module");
    }

    const pluginId = payload?.pluginId?.trim();
    const viewId = payload?.viewId?.trim();
    if (!pluginId || !viewId) {
      throw new Error("pluginId and viewId are required to load a plugin UI module.");
    }

    const view = pluginRuntime
      .listUiExtensions()
      .find((item) => item.pluginId === pluginId && item.extension.id === viewId);
    if (!view?.entryUrl) {
      throw new Error(`Plugin UI entry not found (plugin=${pluginId}, view=${viewId}).`);
    }
    if (!view.entryUrl.startsWith("file:")) {
      throw new Error(`Plugin UI entry is not file-backed (plugin=${pluginId}, view=${viewId}).`);
    }

    const entryPath = fileURLToPath(view.entryUrl);

    const rawPluginRoot = pluginRuntime.getPluginRoot(pluginId);
    if (!rawPluginRoot) {
      throw new Error(`Plugin root not found (plugin=${pluginId}).`);
    }
    const pluginRoot = realpathSync(rawPluginRoot);
    let realEntryPath: string;
    try {
      realEntryPath = realpathSync(entryPath);
    } catch {
      throw new Error(`Plugin UI entry path could not be resolved (plugin=${pluginId}).`);
    }
    const rootWithSep = pluginRoot.endsWith(path.sep) ? pluginRoot : pluginRoot + path.sep;
    if (realEntryPath !== pluginRoot && !realEntryPath.startsWith(rootWithSep)) {
      throw new Error(`Plugin UI entry path escapes plugin directory (plugin=${pluginId}).`);
    }
    return readFile(realEntryPath, "utf-8");
  });

  // read-only, sender guard optional
  ipcMain.handle(CHANNELS.plugins.cards, () => handlePluginCards(deps));

  ipcMain.handle(CHANNELS.plugins.contributionTrustList, (e, pluginId?: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.plugins.contributionTrustList, e);
      return UNAUTHORIZED_FRAME;
    }
    if (pluginId !== undefined && (typeof pluginId !== "string" || pluginId.length === 0)) {
      return { ok: false, error: "invalid-plugin-id" };
    }
    return {
      ok: true,
      rows: deps.pluginBundleLifecycle?.listContributionTrust(pluginId as string | undefined) ?? [],
    };
  });

  ipcMain.handle(CHANNELS.plugins.contributionTrustSet, async (e, input: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.plugins.contributionTrustSet, e);
      return UNAUTHORIZED_FRAME;
    }
    const value = asPlainRecord(input);
    const pluginId = value.pluginId;
    const localId = value.localId;
    const kind = value.kind;
    const approved = value.approved;
    if (
      typeof pluginId !== "string" || !pluginId ||
      typeof localId !== "string" || !localId ||
      (kind !== "hook" && kind !== "mcpServer") ||
      typeof approved !== "boolean"
    ) {
      return { ok: false, error: "invalid-contribution-trust-request" };
    }
    const lifecycle = deps.pluginBundleLifecycle;
    if (!lifecycle) return { ok: false, error: "plugin-bundle-lifecycle-unavailable" };
    try {
      if (kind === "hook") {
        if (approved) await lifecycle.approveHook(pluginId, localId);
        else await lifecycle.revokeHook(pluginId, localId);
      } else if (approved) {
        await lifecycle.approveMcpServer(pluginId, localId);
      } else {
        await lifecycle.revokeMcpServer(pluginId, localId);
      }
      return { ok: true, pluginId, localId, kind, approved };
    } catch (error) {
      return { ok: false, error: "contribution-trust-update-failed", message: errMessage(error) };
    }
  });

  ipcMain.handle(CHANNELS.runtime.counts, (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.runtime.counts, e); return UNAUTHORIZED_FRAME; }
    return {
      // The user-facing tool COUNT reflects the model's tools — getModelVisibleTools,
      // not `size` (every registered tool). `size` now includes app-only tools + the
      // auth trio (registry `Tool`s so their card call runs under the gate); counting
      // them here would inflate "the model's tools" and softly disclose app-only names.
      tools: deps.toolRegistry.getModelVisibleTools().length,
      plugins: pluginRuntime.listPluginIds().length,
      mcps: deps.mcpManager.listServers().filter((s) => s.status === "connected").length,
    };
  });

  ipcMain.handle(CHANNELS.runtime.env, async (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.runtime.env, e); return UNAUTHORIZED_FRAME; }
    const os = await import("node:os");
    return {
      platform: process.platform,
      hostname: os.hostname(),
      user: os.userInfo().username,
    };
  });

  ipcMain.handle(CHANNELS.marketplace.ping, async (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.marketplace.ping, e); return UNAUTHORIZED_FRAME; }
    return runMarketplacePing();
  });

  // read-only, sender guard optional
  ipcMain.handle(CHANNELS.plugins.marketplaceList, () => handleMarketplaceList(deps));

  ipcMain.handle(CHANNELS.agents.list, async (e) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.agents.list, e);
      return UNAUTHORIZED_FRAME;
    }
    const agents = (await deps.agentProfileStore?.list() ?? []).map((agent) => ({
      name: agent.name,
      description: agent.description,
      sourceTools: agent.sourceTools,
      triggers: agent.triggers,
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.mode ? { mode: agent.mode } : {}),
    }));
    return { agents };
  });

  ipcMain.handle(CHANNELS.skills.list, async (e) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.skills.list, e);
      return UNAUTHORIZED_FRAME;
    }
    const skills = deps.skillStore?.listCatalogSync() ?? [];
    return { skills };
  });

  ipcMain.handle(CHANNELS.agents.install, async (e, slug: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.agents.install, e);
      return UNAUTHORIZED_FRAME;
    }
    const trimmed = typeof slug === "string" ? slug.trim() : "";
    if (!trimmed) return { ok: false, error: "invalid-slug", message: "slug is required" } as const;
    if (!agentArtifactStore) {
      return {
        ok: false,
        error: "marketplace-disabled",
        message: "Agent marketplace install is unavailable: marketplace backend is disabled in this build.",
      } as const;
    }
    try {
      const { installAgentPackageFromMarketplace } = await import("../../agents/agent-installer.js");
      broadcastPluginLifecycleEvent(CHANNELS.agents.installProgress, { slug: trimmed, phase: "installing" });
      const result = await installAgentPackageFromMarketplace(trimmed, {
        fetcher: pluginMarketplace.getFetcher(),
        store: agentArtifactStore,
        registryPath: path.resolve(lvisHome(), "agents", "registry.json"),
        onProgress: (evt) => {
          if (evt.phase === "downloading") {
            broadcastPluginLifecycleEvent(CHANNELS.agents.installProgress, {
              slug: trimmed,
              phase: "downloading",
              bytesDownloaded: evt.bytesDownloaded,
              bytesTotal: evt.bytesTotal,
            });
          } else {
            broadcastPluginLifecycleEvent(CHANNELS.agents.installProgress, { slug: trimmed, phase: evt.phase });
          }
        },
      });
      emitHostEvent("agent.installed", { agentId: result.agentId, slug: result.slug, source: "marketplace" });
      broadcastPluginLifecycleEvent(CHANNELS.agents.installResult, {
        slug: result.slug,
        agentId: result.agentId,
        success: true,
      });
      return { ok: true as const, slug: result.slug, agentId: result.agentId, version: result.version, installed: true as const };
    } catch (err) {
      const message = (err as Error).message ?? "Agent install failed";
      broadcastPluginLifecycleEvent(CHANNELS.agents.installResult, { slug: trimmed, success: false, error: message });
      return { ok: false as const, error: "install-failed", message };
    }
  });

  ipcMain.handle(CHANNELS.agents.uninstall, async (e, slug: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.agents.uninstall, e);
      return UNAUTHORIZED_FRAME;
    }
    const trimmed = typeof slug === "string" ? slug.trim() : "";
    if (!trimmed) return { ok: false, error: "invalid-slug", message: "slug is required" } as const;
    try {
      const { uninstallAgentPackage } = await import("../../agents/agent-installer.js");
      const result = await uninstallAgentPackage(trimmed, {
        installRoot: path.resolve(lvisHome(), "agents"),
        registryPath: path.resolve(lvisHome(), "agents", "registry.json"),
      });
      emitHostEvent("agent.uninstalled", { agentId: result.agentId, slug: result.slug, source: "marketplace" });
      broadcastPluginLifecycleEvent(CHANNELS.agents.uninstallResult, {
        slug: result.slug,
        agentId: result.agentId,
        success: true,
      });
      return { ok: true as const, slug: result.slug, agentId: result.agentId, uninstalled: true as const };
    } catch (err) {
      const message = (err as Error).message ?? "Agent uninstall failed";
      broadcastPluginLifecycleEvent(CHANNELS.agents.uninstallResult, { slug: trimmed, success: false, error: message });
      return { ok: false as const, error: "uninstall-failed", message };
    }
  });

  ipcMain.handle(CHANNELS.skills.install, async (e, slug: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.skills.install, e);
      return UNAUTHORIZED_FRAME;
    }
    const trimmed = typeof slug === "string" ? slug.trim() : "";
    if (!trimmed) return { ok: false, error: "invalid-slug", message: "slug is required" } as const;
    if (!skillArtifactStore) {
      return {
        ok: false,
        error: "marketplace-disabled",
        message: "Skill marketplace install is unavailable: marketplace backend is disabled in this build.",
      } as const;
    }
    try {
      const { installSkillPackageFromMarketplace } = await import("../../skills/skill-installer.js");
      broadcastPluginLifecycleEvent(CHANNELS.skills.installProgress, { slug: trimmed, phase: "installing" });
      const result = await installSkillPackageFromMarketplace(trimmed, {
        fetcher: pluginMarketplace.getFetcher(),
        store: skillArtifactStore,
        registryPath: path.resolve(lvisHome(), "skills", "registry.json"),
        onProgress: (evt) => {
          if (evt.phase === "downloading") {
            broadcastPluginLifecycleEvent(CHANNELS.skills.installProgress, {
              slug: trimmed,
              phase: "downloading",
              bytesDownloaded: evt.bytesDownloaded,
              bytesTotal: evt.bytesTotal,
            });
          } else {
            broadcastPluginLifecycleEvent(CHANNELS.skills.installProgress, { slug: trimmed, phase: evt.phase });
          }
        },
      });
      emitHostEvent("skill.installed", { skillId: result.skillId, slug: result.slug, source: "marketplace" });
      broadcastPluginLifecycleEvent(CHANNELS.skills.installResult, {
        slug: result.slug,
        skillId: result.skillId,
        success: true,
      });
      return { ok: true as const, slug: result.slug, skillId: result.skillId, version: result.version, installed: true as const };
    } catch (err) {
      const message = (err as Error).message ?? "Skill install failed";
      broadcastPluginLifecycleEvent(CHANNELS.skills.installResult, { slug: trimmed, success: false, error: message });
      return { ok: false as const, error: "install-failed", message };
    }
  });

  ipcMain.handle(CHANNELS.skills.uninstall, async (e, slug: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.skills.uninstall, e);
      return UNAUTHORIZED_FRAME;
    }
    const trimmed = typeof slug === "string" ? slug.trim() : "";
    if (!trimmed) return { ok: false, error: "invalid-slug", message: "slug is required" } as const;
    try {
      const { uninstallSkillPackage } = await import("../../skills/skill-installer.js");
      const result = await uninstallSkillPackage(trimmed, {
        installRoot: path.resolve(lvisHome(), "skills"),
        registryPath: path.resolve(lvisHome(), "skills", "registry.json"),
      });
      emitHostEvent("skill.uninstalled", { skillId: result.skillId, slug: result.slug, source: "marketplace" });
      broadcastPluginLifecycleEvent(CHANNELS.skills.uninstallResult, {
        slug: result.slug,
        skillId: result.skillId,
        success: true,
      });
      return { ok: true as const, slug: result.slug, skillId: result.skillId, uninstalled: true as const };
    } catch (err) {
      const message = (err as Error).message ?? "Skill uninstall failed";
      broadcastPluginLifecycleEvent(CHANNELS.skills.uninstallResult, { slug: trimmed, success: false, error: message });
      return { ok: false as const, error: "uninstall-failed", message };
    }
  });

  ipcMain.handle(CHANNELS.plugins.configGet, (e, pluginId: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.plugins.configGet, e);
      return pluginConfigError("unauthorized-frame", t("mainDialog.unauthorizedFrame"));
    }
    try {
      return { ok: true as const, config: settingsService.getPluginConfig(pluginId) };
    } catch (err) {
      return pluginConfigError("invalid-plugin-config-request", (err as Error).message);
    }
  });

  ipcMain.handle(CHANNELS.plugins.configSet, async (e, pluginId: string, config: unknown) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.plugins.configSet, e);
      return pluginConfigError("unauthorized-frame", t("mainDialog.unauthorizedFrame"));
    }
    try {
      const manifest = pluginRuntime.getPluginManifest(pluginId);
      const schema = manifest?.configSchema;
      const stripped = stripSecretFields(schema, asPlainRecord(config));
      const savedConfig = await settingsService.setPluginConfig(pluginId, stripped);
      pluginRuntime.setConfigOverride(pluginId, savedConfig);
      const previous = settingsService.getPluginConfig(pluginId) ?? {};
      const observed = new Set<string>([
        ...Object.keys(savedConfig ?? {}),
        ...Object.keys(previous ?? {}),
      ]);
      for (const k of observed) {
        emitPluginConfigChange(pluginId, k, savedConfig?.[k]);
      }
      // `restartPlugin` resolves after the runtime's wired `onEnable`
      // resyncs ToolRegistry, so no explicit sync is needed here.
      await pluginRuntime.restartPlugin(pluginId);
      return { ok: true as const, config: savedConfig };
    } catch (err) {
      return pluginConfigError("plugin-config-save-failed", (err as Error).message);
    }
  });

  ipcMain.handle(CHANNELS.plugins.configSchemaGet, (e, pluginId: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.plugins.configSchemaGet, e);
      return pluginConfigError("unauthorized-frame", t("mainDialog.unauthorizedFrame"));
    }
    try {
      const manifest = pluginRuntime.getPluginManifest(pluginId);
      return { ok: true as const, schema: manifest?.configSchema ?? null };
    } catch (err) {
      return pluginConfigError("plugin-config-schema-load-failed", (err as Error).message);
    }
  });

  ipcMain.handle(CHANNELS.plugins.configSecretSet, async (e, pluginId: string, key: string, value: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.plugins.configSecretSet, e);
      return pluginConfigError("unauthorized-frame", t("mainDialog.unauthorizedFrame"));
    }
    try {
      const manifest = pluginRuntime.getPluginManifest(pluginId);
      const prop = manifest?.configSchema?.properties?.[key];
      if (!prop || prop.type !== "string" || prop.format !== "secret") {
        return pluginConfigError(
          "plugin-config-secret-invalid-key",
          `Plugin '${pluginId}' configSchema does not declare a secret field '${key}'.`,
        );
      }
      const safePluginId = pluginId.trim();
      if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(safePluginId)) {
        return pluginConfigError("plugin-config-secret-invalid-plugin-id", `Invalid pluginId: ${pluginId}`);
      }
      const secretValue = String(value ?? "");
      const validationError = validateSecretConfigValue(safePluginId, key, secretValue);
      if (validationError) return validationError;
      await settingsService.setSecret(`plugin.${safePluginId}.${key}`, secretValue);
      const current = settingsService.getPluginConfig(safePluginId) ?? {};
      if (key in current) {
        const next = { ...current };
        delete next[key];
        await settingsService.setPluginConfig(safePluginId, next);
        pluginRuntime.setConfigOverride(safePluginId, next);
      }
      emitPluginConfigChange(safePluginId, key, SECRET_REDACTED_SENTINEL);
      return { ok: true as const };
    } catch (err) {
      return pluginConfigError("plugin-config-secret-save-failed", (err as Error).message);
    }
  });

  ipcMain.handle(CHANNELS.plugins.configSecretListKeys, (e, pluginId: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.plugins.configSecretListKeys, e);
      return pluginConfigError("unauthorized-frame", t("mainDialog.unauthorizedFrame"));
    }
    try {
      const manifest = pluginRuntime.getPluginManifest(pluginId);
      const schema = manifest?.configSchema;
      if (!schema?.properties) return { ok: true as const, keys: [] as string[] };
      const presentKeys: string[] = [];
      for (const key of Object.keys(schema.properties)) {
        const prop = schema.properties[key];
        if (prop?.type === "string" && prop.format === "secret") {
          const storageKey = `plugin.${pluginId}.${key}`;
          const stored = settingsService.getSecret(storageKey);
          if (stored !== null && !shouldBlockPluginSecretRead({ pluginId, storageKey, value: stored })) {
            presentKeys.push(key);
          }
        }
      }
      return { ok: true as const, keys: presentKeys };
    } catch (err) {
      return pluginConfigError("plugin-config-secret-list-failed", (err as Error).message);
    }
  });

  // read-only, sender guard optional
  ipcMain.handle(CHANNELS.plugins.perfStats, () => pluginRuntime.getPerfStats());

  ipcMain.handle(CHANNELS.plugins.call, (
    e,
    method: string,
    payload?: unknown,
    options?: { userAction?: boolean; operationGrantToken?: string },
  ) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.plugins.call, e); return UNAUTHORIZED_FRAME; }
    return pluginRuntime.callFromUi(method, payload, {
      userAction: options?.userAction === true,
      // Renderer cannot choose the authority-bearing session identity.
      appSessionId: `plugin-ui:${e.sender?.id ?? `${e.processId}:${e.frameId}`}`,
      ...(typeof options?.operationGrantToken === "string"
        ? { operationGrantToken: options.operationGrantToken }
        : {}),
    });
  });

  ipcMain.handle(
    CHANNELS.plugins.e2eBundleSnapshot,
    async (
      e,
      pluginId: unknown,
      skillLocalId: unknown,
      hookProbeToolName: unknown,
    ) => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.plugins.e2eBundleSnapshot, e);
        return UNAUTHORIZED_FRAME;
      }
      if (process.env.LVIS_E2E !== "1") {
        return { ok: false as const, error: "production-disabled" };
      }
      return handlePluginBundleE2eSnapshot(
        deps,
        pluginId,
        skillLocalId,
        hookProbeToolName,
      );
    },
  );

  // ─── MCP ──────────────────────────────────────

  // MEDIUM: in-process token-bucket rate limiter for set-api-key (5 calls/min/serverId)
  const setApiKeyRateBucket = new Map<string, { count: number; windowStart: number }>();
  const SET_API_KEY_MAX_CALLS = 5;
  const SET_API_KEY_WINDOW_MS = 60_000;

  function checkSetApiKeyRateLimit(serverId: string): boolean {
    // NOTE: Date.now() relies on wall clock; NTP adjustment or laptop sleep
    // can cause windowStart to be > now (negative delta), locking the bucket
    // until clock catches up. Acceptable for 5/min limits — switch to
    // performance.now() if monotonic semantics become critical.
    const now = Date.now();
    // Lazy GC: when Map exceeds 64 entries, evict expired windows to bound
    // memory under serverId fuzzing (NEW-2 MEDIUM). 64 active servers is a
    // generous real-world ceiling; anything beyond is adversarial.
    if (setApiKeyRateBucket.size > 64) {
      for (const [k, b] of setApiKeyRateBucket) {
        if (now - b.windowStart >= SET_API_KEY_WINDOW_MS) {
          setApiKeyRateBucket.delete(k);
        }
      }
    }
    const bucket = setApiKeyRateBucket.get(serverId);
    if (!bucket || now - bucket.windowStart >= SET_API_KEY_WINDOW_MS) {
      setApiKeyRateBucket.set(serverId, { count: 1, windowStart: now });
      return true;
    }
    if (bucket.count >= SET_API_KEY_MAX_CALLS) {
      return false;
    }
    bucket.count += 1;
    return true;
  }

  // ── The ONE `serverId → backend` source set (SoT) ─────────────────────────
  // Both MCP-App IPCs — the card RENDER (`mcp.uiResource`) and the app's own
  // `tools/call` (`mcp.callTool`) — resolve through `resolveMcpUiBackend` over THIS
  // object, so the loopback-first rule exists in exactly one place and the two paths
  // can never disagree about who owns a serverId. The tool-call halves come from
  // `mcp-ui-tool-call.ts`; nothing here branches on backend kind.
  const mcpUiSources = {
    loopback: {
      has: (serverId: string) => deps.pluginLoopbackManager.has(serverId),
      assertCardGeneration: (serverId: string, generationId: string) =>
        deps.pluginLoopbackManager.assertCardGeneration(serverId, generationId),
      readUiResource: (serverId: string, uri: string) =>
        deps.pluginLoopbackManager.readUiResource(serverId, uri),
      ...createLoopbackToolCallSource({
        runtime: pluginRuntime,
        findTool: (name) => deps.toolRegistry.findByName(name),
      }),
    },
    mcpManager: {
      readUiResource: (serverId: string, uri: string) => deps.mcpManager.readUiResource(serverId, uri),
      ...createExternalToolCallSource({
        namespacedToolName: (serverId, toolName) => deps.mcpManager.namespacedToolName(serverId, toolName),
        findTool: (name) => deps.toolRegistry.findByName(name),
        // Late binding: the plugin-surface ToolExecutor is installed by a boot step
        // that runs AFTER IPC registration, so resolve it per call, never capture it.
        getInvoker: () => deps.getPluginToolInvoker(),
      }),
    },
  };

  ipcMain.handle(CHANNELS.mcp.servers, (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.mcp.servers, e); return UNAUTHORIZED_FRAME; }
    return deps.mcpManager.listServers();
  });
  ipcMain.handle(CHANNELS.mcp.kill, (e, serverId: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.mcp.kill, e); return UNAUTHORIZED_FRAME; }
    return deps.mcpManager.killSwitch(serverId);
  });
  ipcMain.handle(CHANNELS.mcp.configGet, (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.mcp.configGet, e); return UNAUTHORIZED_FRAME; }
    return deps.mcpManager.getConfigs();
  });
  ipcMain.handle(CHANNELS.mcp.configPath, (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.mcp.configPath, e); return UNAUTHORIZED_FRAME; }
    return deps.mcpManager.getConfigPath();
  });
  ipcMain.handle(CHANNELS.mcp.configAdd, async (e, config: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.mcp.configAdd, e); return UNAUTHORIZED_FRAME; }
    return deps.mcpManager.addConfig(config as import("../../mcp/types.js").McpServerConfig);
  });
  ipcMain.handle(CHANNELS.mcp.configSetApiKey, async (e, serverId: string, apiKey: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.mcp.configSetApiKey, e); return UNAUTHORIZED_FRAME; }
    if (!checkSetApiKeyRateLimit(String(serverId))) {
      throw new Error("Rate limit exceeded: lvis:mcp:config:set-api-key (5/min per server)");
    }
    return deps.mcpManager.setApiKey(serverId, apiKey);
  });
  ipcMain.handle(CHANNELS.mcp.configRemove, async (e, serverId: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.mcp.configRemove, e); return UNAUTHORIZED_FRAME; }
    return deps.mcpManager.removeConfig(serverId);
  });
  ipcMain.handle(CHANNELS.mcp.uiResource, async (e, serverId: string, uri: string, generationId?: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.mcp.uiResource, e); return UNAUTHORIZED_FRAME; }
    // b1 — install the per-server network gate BEFORE the resource is read. (It is
    // the deny-by-default declared-origin gate now, not the old CDN allowlist.)
    // This is the single chokepoint every card render (inline + detached) passes
    // through, and the webview only mounts after this promise resolves, so the
    // gate is guaranteed present before the guest's first request. Fail-closed:
    // an invalid/over-length serverId throws out of encodeMcpServerId here rather
    // than rendering on an ungated partition (No-Fallback).
    //
    // This ALSO installs the sandbox-proxy protocol handler and the relay preload
    // on the partition, so both are in place before the webview navigates.
    installMcpAppPartitionPolicy(serverId);

    // SoT resolution: a first-party plugin runs as an in-process loopback MCP
    // server (serverId === pluginId) that is NEVER in mcpManager.clients, so try
    // the loopback host FIRST, else the external MCP client registry. ONE
    // resolver, shared with the oncalltool seam below — no duplicated backend
    // branch.
    const backend = resolveMcpUiBackend(serverId, mcpUiSources, generationId);

    // The resource carries its OWN `_meta.ui.csp` — main reads it here and never
    // accepts one from the renderer. A compromised renderer must not be able to
    // forge a permissive policy and widen the envelope that contains the untrusted
    // app HTML. Per-resource, so one card's declared domains never leak to another.
    // Plugin-served HTML rides the SAME sandbox-proxy + main-computed CSP path.
    //
    // Same for `_meta.ui.permissions`: the RESOURCE declares which powerful features it
    // wants, and main derives BOTH the inner frame's `allow` attribute and the Electron
    // session grant from it. The renderer never supplies either — a compromised one must
    // not be able to hand a card the camera.
    const resource = await backend.readUiResource(uri);
    const proxyUrl = createMcpAppProxySession(serverId, resource.csp, resource.permissions);
    return { proxyUrl, html: resource.html } satisfies McpUiResourceBundle;
  });

  // ─── MCP Apps `oncalltool` — an app calls a tool on ITS OWN server ──────────
  //
  // The straight line: app → bridge (`oncalltool`) → renderer (binds the CARD's
  // serverId) → THIS channel → `resolveMcpUiBackend` → the backend's gated call
  // path → ToolExecutor → `inspectHostRisk` → reviewer/approval → audit.
  //
  // Invariants, each enforced exactly ONCE:
  //  1. Server binding — STRUCTURAL. The app never names a server: `serverId` is the
  //     card's own `payload.serverId`, supplied by the trusted renderer, and the
  //     resolver binds every backend method to it. Nothing downstream re-derives it.
  //  2. Tool owner == serverId — HERE, one comparison, backend-kind agnostic
  //     (`resolveToolOwner` is the plugin runtime's method map on the loopback arm
  //     and the registry entry's `mcpServerId` on the external arm). A call for
  //     another server's tool, a host builtin, or an unknown name is denied.
  //  3. App-visibility (`_meta.ui.visibility` ∋ "app") — the SPEC MUST, enforced
  //     inside each backend's call path: `assertUiActionInvokable` (loopback) /
  //     the `appInvokable` check (external). NOT re-checked here: one site per path.
  //  4. Risk + consent — the SAME ToolExecutor gate every host tool call takes, entered
  //     under a DISTINCT `"mcp-app"` invocation origin. That origin is what makes the
  //     claim structural rather than aspirational: the ungoverned dispatch an app-only
  //     tool can otherwise reach (the manifest's `auth.statusTool` carve-out) is keyed
  //     off the host's own origins, so an app-initiated call cannot enter it — only
  //     registry tools, which are governed, are reachable from a card. No new classifier.
  //     `userAction` is never set (see mcp-ui-tool-call.ts): a gesture claim made inside
  //     an untrusted iframe is not verifiable.
  //
  // Sender: `validateHostRendererSender` (NOT the base `validateSender` the read-only
  // render channel uses) — this channel RUNS A TOOL, so it takes the mutating-channel
  // validator (fails closed on an empty frame URL, rejects plugin-ui-shell frames),
  // exactly like `plugins.call` and `mcp.openDetached`. The MCP-app <webview> itself
  // is on the `lvis-mcp-app:` scheme and could never pass either validator.
  ipcMain.handle(CHANNELS.mcp.callTool, async (e, serverId: unknown, name: unknown, args: unknown, generationId?: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.mcp.callTool, e);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof serverId !== "string" || !serverId.trim()) {
      return { ok: false, error: "invalid-server-id", message: "serverId must be a non-empty string" } satisfies McpUiToolCallOutcome;
    }
    if (typeof name !== "string" || !name.trim()) {
      return { ok: false, error: "invalid-tool-name", message: "tool name must be a non-empty string" } satisfies McpUiToolCallOutcome;
    }

    const backend = resolveMcpUiBackend(
      serverId,
      mcpUiSources,
      typeof generationId === "string" ? generationId : undefined,
    );

    // Invariant 2 — the card's server must OWN the tool it asks for.
    const owner = backend.resolveToolOwner(name);
    if (owner !== serverId) {
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "mcp-app",
        type: "error",
        input: `[mcp-app:${serverId}] cross-server call denied: tool='${name}' owner='${owner ?? "unknown"}'`,
      });
      return {
        ok: false,
        error: "cross-server-call-denied",
        message: `Tool '${name}' is not owned by MCP server '${serverId}'`,
      } satisfies McpUiToolCallOutcome;
    }

    try {
      // Invariants 3 + 4 live inside this call (visibility MUST, then the gate).
      const input = asPlainRecord(args);
      // The authority-bearing session is minted from Host-owned IPC identity plus
      // the already-bound server. It is never accepted from the card or renderer.
      const appSessionId = `mcp-app:${serverId}:${e.sender?.id ?? `${e.processId}:${e.frameId}`}`;
      const grantTarget = backend.resolveOperationGrantTarget(name, input);
      const grant = grantTarget
        ? await deps.requestPluginOperationGrant({
            pluginId: grantTarget.pluginId,
            toolName: grantTarget.toolName,
            input,
            appSessionId,
            origin: "mcp-app",
            ...(grantTarget.expectedGenerationId
              ? { expectedGenerationId: grantTarget.expectedGenerationId }
              : {}),
          })
        : undefined;
      const result = await backend.callTool(name, input, {
        appSessionId,
        ...(grant ? { operationGrantToken: grant.operationGrantToken } : {}),
      });
      return { ok: true, result } satisfies McpUiToolCallOutcome;
    } catch (err) {
      // Every rejection — app-visibility denial, permission/consent denial, tool
      // error — surfaces as ONE outcome the bridge renders as an MCP-style
      // `{ isError: true }` CallToolResult. Never a raw throw across the bridge.
      const message = errMessage(err);
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "mcp-app",
        type: "error",
        input: `[mcp-app:${serverId}] tools/call denied or failed: tool='${name}' reason='${message}'`,
      });
      return { ok: false, error: "tool-call-failed", message } satisfies McpUiToolCallOutcome;
    }
  });

  // ─── MCP Apps `onmessage` (`ui/message`) — the app speaks to the user or the model ──
  //
  // Two paths, chosen ONCE by `parseUiMessageIntent` (mcp/mcp-ui-message.ts):
  //
  //  A. NOTIFICATION (`_meta["lvisai/notification"]` on a content block) → the EXISTING
  //     popup surface. `NotificationService.fire` already owns the focus gate, the
  //     per-kind cooldown, title/body sanitization, and the audit row — we add none of
  //     that here, and we let the app OVERRIDE none of it either: the app supplies text
  //     to show, never the policy for showing it (see `notify` below). Never the
  //     transcript; never a slash dispatch.
  //
  //  B. CONVERSATION. The app's text enters the ACTIVE conversation, but NEVER as if the
  //     user typed it. Three invariants, one enforcement site each:
  //
  //     1. PROVENANCE — `formatAppMessageEnvelope` (shared/mcp-app-message-source.ts) is
  //        the only builder of `<app-message source="app:<serverId>">`. Everything
  //        downstream (turn origin, transcript marker, permission force-ask, keyword
  //        bypass) reads provenance from that one envelope. It also strips a leading
  //        slash, so app text can never dispatch a host command.
  //     2. SESSION BINDING — HERE, one comparison. The renderer binds the card's ORIGIN
  //        session id; if it is not the loop's current session the user has navigated
  //        away, and we fall back to the notification path rather than inject into a
  //        conversation they are no longer looking at. Fail-safe, one rule.
  //     3. TURN POLICY — `queueGuidance` is the race-safe round-boundary seam and its
  //        `no-active-turn` answer is the ATOMIC active-turn check (a separate
  //        `hasActiveTurn()` probe would reopen the race it was written to close):
  //          · active turn  → queued as guidance; the drain site (query-loop) sees the
  //            app envelope and downgrades the rest of the turn to the app's origin, so
  //            it is NOT treated as the user's own mid-stream guide.
  //          · no active turn → USER-GATED. We stage an overlay card the user must
  //            CLICK; confirming inserts the `imported_trigger` marker and starts the
  //            turn with `app-emitted` origin. An app must NOT autonomously wake the
  //            model: VS Code's MCP-Apps host only *fills* the chat box ("does not
  //            auto-send"), ChatGPT fires only from a synchronous user gesture, and the
  //            spec's "host SHOULD add to context, MAY request consent" is trending
  //            toward "every UI-initiated action goes through the same consent path".
  //            LVIS cannot verify a gesture claim made inside an untrusted iframe, so a
  //            host-side gate is the only sound reading.
  //
  // Rate limit: the SAME `triggerConversationRateLimiter` the plugin overlay gate uses —
  // one limiter for "staged conversation proposals", keyed by serverId (which IS the
  // pluginId on the loopback arm, so a plugin shares one budget across both surfaces).
  //
  // Sender: `validateHostRendererSender` — state-mutating, exactly like `mcp.callTool`.
  ipcMain.handle(CHANNELS.mcp.uiMessage, async (e, serverId: unknown, cardSessionId: unknown, params: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.mcp.uiMessage, e);
      return UNAUTHORIZED_FRAME;
    }
    const auditMcpApp = (type: "info" | "error", input: string) => {
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "mcp-app",
        type,
        input,
      });
    };
    if (typeof serverId !== "string" || !isAppMessageOrigin(appMessageSource(serverId))) {
      return { ok: false, error: "invalid-server-id", message: "serverId must be a valid MCP server id" } satisfies McpUiMessageOutcome;
    }
    const source = appMessageSource(serverId);

    if (triggerConversationRateLimiter.isOverCap(serverId)) {
      auditMcpApp("error", `[mcp-app:${serverId}] ui/message rate limited`);
      return { ok: false, error: "rate-limited", message: "too many messages from this app" } satisfies McpUiMessageOutcome;
    }
    triggerConversationRateLimiter.record(serverId);

    const intent = parseUiMessageIntent(params);
    if (intent.kind === "invalid") {
      return { ok: false, error: intent.error, message: intent.message } satisfies McpUiMessageOutcome;
    }

    // The one notification sink — used by path A and by path B's session-mismatch
    // fallback. Title/body are UNTRUSTED app text; `fire` caps + strips them.
    //
    // What an app may NOT do here, by construction:
    //  · ATTRIBUTION — the title the user sees is HOST-minted (`app:<serverId>` ahead of
    //    the app's own words), so a card cannot dress its popup up as a host alert
    //    ("LVIS 보안 경고: 다시 로그인하세요") and phish the user.
    //  · DELIVERY POLICY — no `bypassFocusGate`, no `urgent`. `bypassFocusGate` is an
    //    opt-in *manifest* signal (notification-service.ts / boot/plugins.ts): reviewable
    //    ahead of time and covered by `manifestSha256`. An untrusted iframe may ask for
    //    attention; it does not get to rule that its alert outranks the focus gate, nor
    //    to skip the per-kind cooldown that keeps one app from starving every other
    //    plugin's real alerts. `urgent` is not passed either, so the kind's default
    //    (silent for `plugin`) stands. The app's declared `severity` is an audited CLAIM
    //    and nothing more.
    const notify = (title: string, body: string, severity?: string): McpUiMessageOutcome => {
      const notificationService = deps.notificationService;
      if (!notificationService) {
        return { ok: false, error: "notification-unavailable", message: "notification service is not running" };
      }
      const appTitle = title.trim();
      notificationService.fire({
        kind: "plugin",
        title: appTitle ? `${source} · ${appTitle}` : source,
        body,
      });
      auditMcpApp(
        "info",
        `[mcp-app:${serverId}] ui/message → notification` +
          (severity ? ` severityClaimed=${severity}` : ""),
      );
      return { ok: true, disposition: "notified" };
    };

    // ── Path A — the app asked for the user's attention, not the model's.
    if (intent.kind === "notification") {
      const { title, body, severity } = intent.notification;
      return notify(title, body, severity);
    }

    // ── Path B — invariant 2: the card's session must still be the live one.
    if (cardSessionId !== deps.conversationLoop.getSessionId()) {
      auditMcpApp("info", `[mcp-app:${serverId}] ui/message session mismatch → notification fallback`);
      // No app-authored title on this path — the source tag IS the title.
      return notify("", intent.text);
    }

    const envelope = formatAppMessageEnvelope(intent.text, source);

    // ── Path B — invariant 3: turn policy. `queueGuidance` IS the atomic check.
    const queued = deps.conversationLoop.queueGuidance(envelope);
    if (queued === "queued") {
      auditMcpApp("info", `[mcp-app:${serverId}] ui/message → guidance queued (active turn)`);
      return { ok: true, disposition: "queued" } satisfies McpUiMessageOutcome;
    }
    if (queued !== "no-active-turn") {
      auditMcpApp("error", `[mcp-app:${serverId}] ui/message guidance rejected: ${queued}`);
      return { ok: false, error: queued, message: `guidance rejected: ${queued}` } satisfies McpUiMessageOutcome;
    }

    // No active turn → stage the user-gated card. The renderer inserts the
    // `imported_trigger` marker and starts the turn ONLY on the user's click.
    //
    // `summary` is what the OverlayCard SHOWS. It goes through the SAME display
    // sanitizer the plugin overlay path uses (`deriveOverlaySummaryForDisplay` —
    // `<untrusted-*>` strip + 2 000-char cap): one card, one rule, and the less-trusted
    // source does not get the weaker one. The full text still rides `pendingPrompt`,
    // where the envelope is the thing that carries provenance.
    const eventId = randomUUID();
    const overlayItem = {
      id: `app:${serverId}:${eventId}`,
      source: { kind: "app" as const, serverId, eventId },
      title: serverId,
      summary: deriveOverlaySummaryForDisplay({ prompt: intent.text }),
      running: false,
      pendingPrompt: envelope,
      createdAt: new Date().toISOString(),
    };
    const win = getMainWindow();
    if (!win || win.isDestroyed()) {
      return { ok: false, error: "no-window", message: "host window is unavailable" } satisfies McpUiMessageOutcome;
    }
    sendToWindow(win, OVERLAY_V1.show, overlayItem, log);
    auditMcpApp("info", `[mcp-app:${serverId}] ui/message → staged for user confirmation (no active turn)`);
    return { ok: true, disposition: "staged" } satisfies McpUiMessageOutcome;
  });

  // ─── MCP Apps `ondownloadfile` (`ui/download-file`) — the app saves a file ──────
  //
  // The straight line: app → bridge (`ondownloadfile`) → renderer (binds the CARD's
  // serverId) → THIS channel → `parseMcpAppDownload` → `dialog.showSaveDialog` → write.
  //
  // The security invariant, enforced in exactly ONE place: THE HOST NEVER FETCHES A URI
  // ON AN UNTRUSTED APP'S BEHALF. `parseMcpAppDownload` rejects `resource_link` outright
  // (the ext-apps JSDoc's `window.open(item.uri)` would make the host a confused deputy —
  // an egress channel with the host's network identity, reachable from a sandboxed iframe
  // without any of the gates a tool call takes). What survives the parse is INLINE bytes
  // the app already possessed, size-capped before decode, count-capped, with a filename
  // that cannot pre-fill a traversal. Nothing downstream re-checks any of it.
  //
  // The AUTHORIZATION for the write is the user's own save dialog — the same
  // `dialog.showSaveDialog` seam the diagnostics bundle / transcript export / usage CSV
  // use. No new save path, no host-chosen destination, no silent write. A CANCEL is
  // therefore a normal outcome, NOT an error (the spec's `isError` must not be raised for
  // it), and it aborts the remaining files: the user declined.
  //
  // Sender: `validateHostRendererSender` — state-mutating (it writes a file), exactly
  // like `mcp.callTool` / `mcp.uiMessage`.
  ipcMain.handle(CHANNELS.mcp.uiDownloadFile, async (e, serverId: unknown, params: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.mcp.uiDownloadFile, e);
      return UNAUTHORIZED_FRAME;
    }
    const auditDownload = (type: "info" | "error", input: string) => {
      auditLogger.log({ timestamp: new Date().toISOString(), sessionId: "mcp-app", type, input });
    };
    if (typeof serverId !== "string" || !serverId.trim()) {
      return { ok: false, error: "invalid-server-id", message: "serverId must be a non-empty string" } satisfies McpUiDownloadOutcome;
    }

    const parsed = parseMcpAppDownload(params);
    if (parsed.kind === "invalid") {
      auditDownload("error", `[mcp-app:${serverId}] ui/download-file rejected: ${parsed.error}`);
      return { ok: false, error: parsed.error, message: parsed.message } satisfies McpUiDownloadOutcome;
    }

    const win = getMainWindow();
    for (const file of parsed.files) {
      const extension = file.filename.includes(".") ? file.filename.split(".").pop() ?? "" : "";
      const dialogOptions = {
        // User-facing dialog copy — Korean per the IPC/UI language convention.
        title: "MCP 앱 파일 저장",
        defaultPath: file.filename,
        ...(extension ? { filters: [{ name: extension.toUpperCase(), extensions: [extension] }] } : {}),
      };
      const result = win && !win.isDestroyed()
        ? await dialog.showSaveDialog(win, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);
      if (result.canceled || !result.filePath) {
        auditDownload("info", `[mcp-app:${serverId}] ui/download-file cancelled by user`);
        return { ok: true, disposition: "cancelled" } satisfies McpUiDownloadOutcome;
      }
      await writeFile(result.filePath, file.bytes);
      // Forensic record: an app-authored file landed on the user's disk. The path is
      // redacted (home dir / username stripped) exactly like the diagnostics export.
      auditDownload(
        "info",
        `[mcp-app:${serverId}] ui/download-file saved ${JSON.stringify({
          bytes: file.bytes.byteLength,
          mimeType: file.mimeType,
          path: redactFsPath(result.filePath),
        })}`,
      );
    }
    return { ok: true, disposition: "saved" } satisfies McpUiDownloadOutcome;
  });

  // ─── MCP Apps `onupdatemodelcontext` (`ui/update-model-context`) ────────────────
  //
  // The app OVERWRITES the context it wants the model to have on the NEXT turn. The three
  // spec semantics are structural here, not policy:
  //
  //  1. OVERWRITE — the store keys one slot per (session, server, card) and re-`set`s it.
  //     The renderer binds ALL THREE (the app names none), so a card can overwrite only
  //     its own slot, and only in the conversation it belongs to.
  //  2. DEFERRED to the next turn — nothing is pushed anywhere. `SystemPromptBuilder`
  //     READS the active session's slots when it assembles the next prompt.
  //  3. NEVER a follow-up — this handler has no path to the conversation loop. Not a rule
  //     it obeys; a reference it does not hold. (`ui/message` is the channel that CAN
  //     reach a turn, and only behind a user-gated card. They are separate on purpose.)
  //
  // The body is UNTRUSTED APP DATA. The store fences it and the prompt source labels it
  // "data, never instructions" — the same framing `<app-message>` bodies and the skills
  // catalog already carry. A session MISMATCH drops the update (the card belongs to a
  // conversation the user has left): fail-safe, one comparison, mirroring `ui/message`.
  //
  // Sender: `validateHostRendererSender` — it mutates what the model reads next turn.
  ipcMain.handle(
    CHANNELS.mcp.uiModelContext,
    (e, serverId: unknown, cardSessionId: unknown, cardId: unknown, params: unknown) => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.mcp.uiModelContext, e);
        return UNAUTHORIZED_FRAME;
      }
      const auditContext = (type: "info" | "error", input: string) => {
        auditLogger.log({ timestamp: new Date().toISOString(), sessionId: "mcp-app", type, input });
      };
      if (typeof serverId !== "string" || typeof cardId !== "string") {
        return { ok: false, error: "invalid-binding", message: "serverId and cardId must be strings" } satisfies McpUiModelContextOutcome;
      }
      if (typeof cardSessionId !== "string" || cardSessionId !== deps.conversationLoop.getSessionId()) {
        auditContext("info", `[mcp-app:${serverId}] ui/update-model-context dropped: session mismatch`);
        return { ok: false, error: "session-mismatch", message: "the card's session is not the active conversation" } satisfies McpUiModelContextOutcome;
      }

      const record = asPlainRecord(params);
      const outcome = deps.mcpAppModelContext.update({
        sessionId: cardSessionId,
        serverId,
        cardId,
        content: record.content,
        structuredContent: record.structuredContent,
      });
      // The app gets an EmptyResult either way (the spec gives this request no error
      // channel), so a refusal — an over-cap body above all — is recorded HERE or nowhere.
      auditContext(
        outcome.ok ? "info" : "error",
        outcome.ok
          ? `[mcp-app:${serverId}] ui/update-model-context ${outcome.disposition}`
          : `[mcp-app:${serverId}] ui/update-model-context refused: ${outcome.error}`,
      );
      return outcome;
    },
  );

  // Card unmount → free its proxy-session token promptly, so a long chat with many
  // cards does not let the global LRU evict a STILL-MOUNTED card's token (which would
  // 404 that card's next reload). Idempotent; a bad/absent token is a no-op.
  ipcMain.handle(CHANNELS.mcp.disposeUiSession, (e, token: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.mcp.disposeUiSession, e); return UNAUTHORIZED_FRAME; }
    if (typeof token === "string" && token.length > 0) disposeMcpAppProxySession(token);
    return { ok: true as const };
  });

  ipcMain.handle(CHANNELS.mcp.catalogList, async (e) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.mcp.catalogList, e);
      return UNAUTHORIZED_FRAME;
    }
    const all = await pluginMarketplace.list();
    return all.filter((p) => p.pluginType === "mcp");
  });

  ipcMain.handle(CHANNELS.mcp.installFromMarketplace, async (e, slug: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.mcp.installFromMarketplace, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!mcpArtifactStore) {
      return {
        ok: false,
        error: "marketplace-disabled",
        message: "MCP marketplace install is unavailable: marketplace backend is disabled in this build.",
      } as const;
    }
    if (typeof slug !== "string" || slug.trim().length === 0) {
      return { ok: false, error: "invalid-slug", message: "slug is required" } as const;
    }
    try {
      const { installMcpFromMarketplace } = await import("../../mcp/mcp-marketplace-install.js");
      const result = await installMcpFromMarketplace(slug.trim(), {
        fetcher: pluginMarketplace.getFetcher(),
        store: mcpArtifactStore,
        registerConfig: (config) => deps.mcpManager.addConfig(config),
      });
      return {
        ok: true as const,
        slug: slug.trim(),
        installDir: result.installDir,
        connected: result.connected,
        warning: result.warning,
        needsCredential: result.needsCredential,
        authMode: result.authMode,
      };
    } catch (err) {
      return {
        ok: false as const,
        error: "install-failed",
        message: (err as Error).message ?? "MCP install failed",
      };
    }
  });

  ipcMain.handle(CHANNELS.mcp.importClaudeDesktopPreview, async (e, raw: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.mcp.importClaudeDesktopPreview, e);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof raw === "string" && raw.length > 1_000_000) {
      return {
        entries: [],
        errors: [{ id: "<root>", reason: "config exceeds 1MB size limit" }],
      };
    }
    const { parseClaudeDesktopConfig } = await import("../../mcp/claude-desktop-import.js");
    return parseClaudeDesktopConfig(typeof raw === "string" ? raw : "");
  });

  ipcMain.handle(
    CHANNELS.mcp.importClaudeDesktopApply,
    async (
      e,
      payload: { raw: string; conflictPolicy?: "skip" | "overwrite" },
    ) => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.mcp.importClaudeDesktopApply, e);
        return UNAUTHORIZED_FRAME;
      }
      const { parseClaudeDesktopConfig } = await import("../../mcp/claude-desktop-import.js");
      const policy = payload?.conflictPolicy ?? "skip";
      const parsed = parseClaudeDesktopConfig(typeof payload?.raw === "string" ? payload.raw : "");
      const seenIds = new Set<string>();
      const dedupedEntries: typeof parsed.entries = [];
      for (const entry of parsed.entries) {
        if (seenIds.has(entry.id)) continue;
        seenIds.add(entry.id);
        dedupedEntries.push(entry);
      }

      const existing = await deps.mcpManager.getConfigs();
      const existingIds = new Set(existing.map((s) => s.id));
      const results: Array<{
        id: string;
        action: "added" | "skipped-conflict" | "overwritten" | "failed";
        reason?: string;
        warning?: string;
      }> = [];
      for (const entry of dedupedEntries) {
        const conflictedAtStart = existingIds.has(entry.id);
        if (conflictedAtStart) {
          if (policy === "skip") {
            results.push({ id: entry.id, action: "skipped-conflict" });
            continue;
          }
          try {
            await deps.mcpManager.removeConfig(entry.id);
            existingIds.delete(entry.id);
          } catch (err) {
            results.push({
              id: entry.id,
              action: "failed",
              reason: (err as Error).message ?? "remove failed",
            });
            continue;
          }
        }
        try {
          const addResult = await deps.mcpManager.addConfig(entry.config);
          existingIds.add(entry.id);
          results.push({
            id: entry.id,
            action: conflictedAtStart ? "overwritten" : "added",
            reason: addResult.connected ? undefined : addResult.warning,
            warning: entry.warning,
          });
        } catch (err) {
          results.push({
            id: entry.id,
            action: "failed",
            reason: (err as Error).message ?? "addConfig failed",
            warning: entry.warning,
          });
        }
      }
      return {
        ok: true as const,
        results,
        parseErrors: parsed.errors,
      };
    },
  );

  // ─── Plugin webview bridge (#237 Option B) ────────────────────────────────
  // Issue #439: every reject path now logs to audit. Previously these returned
  // silently and the shell would just see a 500ms timeout from get-entry-url
  // with no way to tell whether registration itself had failed (and why) or
  // simply not arrived yet.
  // Safe-stringify: clamp to 1KB and never throw — a malicious renderer could
  // pass a BigInt, circular ref, or throwing toJSON, which would otherwise
  // bubble up and break the IPC sentinel return.
  const safeStringify = (value: unknown): string => {
    try {
      const s = JSON.stringify(value);
      return typeof s === "string" && s.length > 1024 ? s.slice(0, 1024) + "...<truncated>" : s ?? "<unserializable>";
    } catch {
      return "<unserializable>";
    }
  };
  const logRegisterReject = (reason: string, payload: unknown) => {
    try {
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "ipc-guard",
        type: "warn",
        input: safeStringify({
          channel: CHANNELS.pluginBridge.registerWebview,
          reason,
          payload: redactAuditPayload(payload),
        }),
      });
    } catch {
      // Never let audit logging break the IPC sentinel return.
    }
  };
  ipcMain.handle(CHANNELS.pluginBridge.registerWebview, (e, payload: { webContentsId: number; pluginId: string; entryUrl: string }) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.pluginBridge.registerWebview, e);
      return UNAUTHORIZED_FRAME;
    }
    const { webContentsId, pluginId, entryUrl } = payload ?? {};
    plog("debug", { pluginId: pluginId ?? "<unknown>", phase: PluginPhase.WEBVIEW_REGISTER, webContentsId, entryUrl: typeof entryUrl === "string" ? redactFsPath(entryUrl) : entryUrl }, "webview register requested");
    if (typeof webContentsId !== "number" || !Number.isFinite(webContentsId)) {
      logRegisterReject("invalid-webcontents-id", payload);
      plog("warn", { pluginId: pluginId ?? "<unknown>", phase: PluginPhase.WEBVIEW_REJECT, webContentsId, reason: "invalid-webcontents-id" }, "webview register rejected");
      return { ok: false, error: "invalid-webcontents-id" };
    }
    if (typeof pluginId !== "string" || !pluginRuntime.getPluginManifest(pluginId)) {
      logRegisterReject("unknown-plugin-id", { webContentsId, pluginId });
      plog("warn", { pluginId: pluginId ?? "<unknown>", phase: PluginPhase.WEBVIEW_REJECT, webContentsId, reason: "unknown-plugin-id" }, "webview register rejected");
      return { ok: false, error: "unknown-plugin-id" };
    }
    if (typeof entryUrl !== "string" || !entryUrl.startsWith("file://") || entryUrl.length <= "file://".length) {
      logRegisterReject("invalid-entry-url", { webContentsId, pluginId, entryUrl });
      plog("warn", { pluginId, phase: PluginPhase.WEBVIEW_REJECT, webContentsId, reason: "invalid-entry-url" }, "webview register rejected");
      return { ok: false, error: "invalid-entry-url" };
    }
    const rawInstallRoot = pluginRuntime.getPluginRoot(pluginId);
    if (!rawInstallRoot) {
      logRegisterReject("plugin-not-loaded", { webContentsId, pluginId });
      plog("warn", { pluginId, phase: PluginPhase.WEBVIEW_REJECT, webContentsId, reason: "plugin-not-loaded" }, "webview register rejected");
      return { ok: false, error: "plugin-not-loaded" };
    }
    let entryFsPath: string;
    try {
      entryFsPath = fileURLToPath(entryUrl);
    } catch {
      logRegisterReject("invalid-entry-url", { webContentsId, pluginId, entryUrl });
      plog("warn", { pluginId, phase: PluginPhase.WEBVIEW_REJECT, webContentsId, reason: "invalid-entry-url" }, "webview register rejected");
      return { ok: false, error: "invalid-entry-url" };
    }
    let realRoot: string;
    let realEntry: string;
    try {
      realRoot = realpathSync(rawInstallRoot);
      realEntry = realpathSync(entryFsPath);
    } catch (err) {
      // Classify ENOENT separately from genuine boundary violations.
      // ENOENT here means the install dir was deleted under us — either a
      // half-completed uninstall left a runtime tracking entry pointing at
      // a vanished path, or the user manually rm'd ~/.lvis/plugins/<id>.
      // Surfacing this as `entry-url-outside-install-root` is misleading
      // (it's not a security violation) and traps the user behind a
      // confusing error. Return `plugin-not-loaded` and trigger a runtime
      // purge so the plugin card disappears on next refresh.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // Auto-purge the runtime tracking entry so the plugin card disappears
        // on next refresh. Fire-and-forget — we want to return promptly to
        // the webview-register IPC. Concurrent uninstall in flight is OK
        // (removePlugin is map-level idempotent + JS event-loop serialized);
        // log on failure for forensics rather than swallowing silently.
        void pluginRuntime.removePlugin(pluginId).catch((purgeErr) => {
          plog(
            "warn",
            { pluginId, phase: PluginPhase.WEBVIEW_REJECT, reason: "auto-purge-failed", error: (purgeErr as Error).message },
            "register-webview auto-purge after ENOENT failed",
          );
        });
        logRegisterReject("plugin-not-loaded", { webContentsId, pluginId, reason: "install-dir-missing" });
        plog("warn", { pluginId, phase: PluginPhase.WEBVIEW_REJECT, webContentsId, reason: "plugin-not-loaded" }, "webview register rejected (install dir missing)");
        return { ok: false, error: "plugin-not-loaded" };
      }
      logRegisterReject("entry-url-outside-install-root", { webContentsId, pluginId, entryFsPath, rawInstallRoot });
      plog("warn", { pluginId, phase: PluginPhase.WEBVIEW_REJECT, webContentsId, reason: "entry-url-outside-install-root" }, "webview register rejected");
      return { ok: false, error: "entry-url-outside-install-root" };
    }
    const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    if (realEntry !== realRoot && !realEntry.startsWith(rootWithSep)) {
      logRegisterReject("entry-url-outside-install-root", { webContentsId, pluginId, realEntry, realRoot });
      plog("warn", { pluginId, phase: PluginPhase.WEBVIEW_REJECT, webContentsId, reason: "entry-url-outside-install-root" }, "webview register rejected");
      return { ok: false, error: "entry-url-outside-install-root" };
    }
    const assetEntryUrl = pluginAssetUrlFromRealPath(realRoot, realEntry);
    // Carry the runtime-revision cache-bust query through to the asset URL so
    // the shell's import() gets a fresh ESM cache key after plugin reload.
    // entryUrl already parsed successfully via fileURLToPath above, so this
    // URL construction cannot throw.
    const entrySearch = new URL(entryUrl).search;
    const versionedAssetEntryUrl = entrySearch ? `${assetEntryUrl}${entrySearch}` : assetEntryUrl;
    const binding = {
      pluginId,
      entryUrl,
      assetEntryUrl: versionedAssetEntryUrl,
      appSessionId: `plugin-ui:${webContentsId}:${randomUUID()}`,
    };
    pluginWebviewRegistry.set(webContentsId, binding);
    flushPendingEntryUrl(webContentsId, binding);
    plog("debug", { pluginId, phase: PluginPhase.WEBVIEW_ATTACH, webContentsId }, "webview attached");
    const replayedTheme = replayThemeToWebview(webContentsId);
    if (replayedTheme) {
      publishHostThemeChanged(replayedTheme);
      plog("debug", { pluginId, phase: PluginPhase.WEBVIEW_ATTACH, webContentsId }, "theme replay sent");
    }
    return { ok: true };
  });

  function resolvePluginFromSender(e: import("electron").IpcMainInvokeEvent): PluginWebviewBinding | null {
    if (!validatePluginFrame(e)) return null;
    const senderId = e.sender?.id;
    if (typeof senderId !== "number") return null;
    return pluginWebviewRegistry.get(senderId) ?? null;
  }

  ipcMain.handle(CHANNELS.pluginBridge.getEntryUrl, (e) => {
    const binding = resolvePluginFromSender(e);
    if (binding) return { ok: true as const, entryUrl: binding.assetEntryUrl };

    if (!validatePluginFrame(e)) {
      auditUnauthorized(auditLogger, CHANNELS.pluginBridge.getEntryUrl, e);
      return UNAUTHORIZED_FRAME;
    }
    const senderId = e.sender?.id;
    if (typeof senderId !== "number") {
      return { ok: false as const, error: "not-registered" };
    }
    // Race-tolerant path: the shell can call get-entry-url before the host
    // renderer's `did-attach → registerPluginWebview` round-trip completes
    // (e.g. plugin update lifecycle where the plugin webview re-attaches
    // with a fresh wcId). Queue this resolver and let the matching register
    // call flush it. If no register lands within the deadline, fall back to
    // the original "not-registered" sentinel so a genuinely absent
    // registration is still surfaced.
    return new Promise<{ ok: true; entryUrl: string } | { ok: false; error: "not-registered" }>(
      (resolve) => {
        let settled = false;
        const wrapped: PendingEntryUrlResolver = (reply) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(reply);
        };
        const set = pendingEntryUrlResolvers.get(senderId) ?? new Set();
        set.add(wrapped);
        pendingEntryUrlResolvers.set(senderId, set);
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          const current = pendingEntryUrlResolvers.get(senderId);
          if (current) {
            current.delete(wrapped);
            if (current.size === 0) pendingEntryUrlResolvers.delete(senderId);
          }
          try {
            auditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "ipc-guard",
              type: "warn",
              input: safeStringify({
                channel: CHANNELS.pluginBridge.getEntryUrl,
                reason: "not-registered",
                frameUrl: redactFsPath(e?.senderFrame?.url ?? ""),
                senderId,
                deadlineMs: PENDING_ENTRY_URL_DEADLINE_MS,
              }),
            });
          } catch { /* audit must never break the sentinel return */ }
          resolve({ ok: false, error: "not-registered" });
        }, PENDING_ENTRY_URL_DEADLINE_MS);
      },
    );
  });

  // Pull-on-load theme handshake. The plugin shell calls this BEFORE
  // dynamic-importing the plugin entry, applies the returned tokens to
  // documentElement inline style, and then loads the plugin code — so
  // every plugin paints with correct host tokens from frame 0.
  //
  // This avoids the race the prior register-time replay had: `wc.send`
  // does not buffer for late-attaching listeners, so a replay sent
  // before the preload's `ipcRenderer.on` registration was lost. Pull
  // is request-response and timing-safe: main answers whenever the
  // shell asks, regardless of when preload listeners were set up.
  //
  // Returns `null` when the host hasn't broadcast yet (extreme cold-
  // boot window). The shell falls back to SDK CSS-side defaults in
  // that case.
  ipcMain.handle(CHANNELS.pluginBridge.getTheme, (e) => {
    if (!validatePluginFrame(e)) {
      auditUnauthorized(auditLogger, CHANNELS.pluginBridge.getTheme, e);
      return UNAUTHORIZED_FRAME;
    }
    return { ok: true as const, theme: getLastThemePayload() };
  });

  ipcMain.handle(CHANNELS.pluginBridge.callTool, async (
    e,
    method: string,
    payload?: unknown,
    options?: { userAction?: boolean; operationGrantToken?: string },
  ) => {
    const binding = resolvePluginFromSender(e);
    if (!binding) {
      auditUnauthorized(auditLogger, CHANNELS.pluginBridge.callTool, e);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof method !== "string" || !method.trim()) {
      return { ok: false, error: "invalid-method" };
    }
    const ownerPluginId = pluginRuntime.resolveToolOwner(method);
    if (!ownerPluginId) {
      return { ok: false, error: `Plugin method not found: ${method}` };
    }
    if (ownerPluginId !== binding.pluginId) {
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "plugin-frame",
        type: "error",
        input: `[plugin:${binding.pluginId}] cross-plugin call denied: method='${method}' owner='${ownerPluginId}'`,
      });
      return { ok: false, error: "cross-plugin-call-denied" };
    }
    try {
      const result = await pluginRuntime.callFromUi(method, payload, {
        userAction: options?.userAction === true,
        appSessionId: binding.appSessionId,
        ...(typeof options?.operationGrantToken === "string"
          ? { operationGrantToken: options.operationGrantToken }
          : {}),
      });
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle(CHANNELS.pluginBridge.requestOperationGrant, async (
    e,
    method: unknown,
    payload: unknown,
  ) => {
    const binding = resolvePluginFromSender(e);
    if (!binding) {
      auditUnauthorized(auditLogger, CHANNELS.pluginBridge.requestOperationGrant, e);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof method !== "string" || !method.trim()) {
      return { ok: false as const, error: "invalid-method" };
    }
    const ownerPluginId = pluginRuntime.resolveToolOwner(method);
    if (ownerPluginId !== binding.pluginId) {
      return { ok: false as const, error: "cross-plugin-call-denied" };
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { ok: false as const, error: "invalid-operation-input" };
    }
    try {
      const result = await deps.requestPluginOperationGrant({
        pluginId: binding.pluginId,
        toolName: method,
        input: payload as Record<string, unknown>,
        appSessionId: binding.appSessionId,
      });
      return { ok: true as const, result };
    } catch (error) {
      return { ok: false as const, error: errMessage(error) };
    }
  });

  // ─── Plugin webview config bridge (#B1 — bridge.config namespace) ─────────
  // Plugin UI webviews call these via `bridge.config.get/set(key)` to read/
  // write their own per-plugin config record (the same record managed by
  // PluginConfigTab via lvis:plugins:config:get/set). Cross-plugin access is
  // refused by `resolvePluginFromSender` — a webview can only touch its own
  // plugin's config. Secret fields are stripped before persistence (matches
  // `lvis:plugins:config:set` behaviour) so plugin UI cannot bypass the
  // keychain-backed secret store via this surface.
  ipcMain.handle(CHANNELS.pluginBridge.configGet, (e, key: string) => {
    const binding = resolvePluginFromSender(e);
    if (!binding) {
      auditUnauthorized(auditLogger, CHANNELS.pluginBridge.configGet, e);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof key !== "string" || !key.trim()) {
      return { ok: false as const, error: "invalid-key" };
    }
    try {
      const config = settingsService.getPluginConfig(binding.pluginId) ?? {};
      return { ok: true as const, value: config[key] };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  });

  ipcMain.handle(CHANNELS.pluginBridge.configSet, async (e, key: string, value: unknown) => {
    const binding = resolvePluginFromSender(e);
    if (!binding) {
      auditUnauthorized(auditLogger, CHANNELS.pluginBridge.configSet, e);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof key !== "string" || !key.trim()) {
      return { ok: false as const, error: "invalid-key" };
    }
    try {
      const manifest = pluginRuntime.getPluginManifest(binding.pluginId);
      const schema = manifest?.configSchema;
      const current = settingsService.getPluginConfig(binding.pluginId) ?? {};
      const next = { ...current, [key]: value };
      // Same secret-strip path used by `lvis:plugins:config:set` — keeps
      // declared secret fields out of the plain-config record. Plugins
      // store secrets via the existing `setSecret` IPC.
      const stripped = stripSecretFields(schema, asPlainRecord(next));
      const savedConfig = await settingsService.setPluginConfig(binding.pluginId, stripped);
      pluginRuntime.setConfigOverride(binding.pluginId, savedConfig);
      emitPluginConfigChange(binding.pluginId, key, savedConfig?.[key]);
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  });

  // ─── Plugin webview storage bridge (#B1 — bridge.storage namespace) ───────
  // Plugin UI webviews call these via `bridge.storage.get/set(key)`. Storage
  // is the per-plugin sandboxed data directory (createPluginStorage) — the
  // same root the host plugin sees via `hostApi.storage`. Each key maps to a
  // JSON file `<pluginDataDir>/ui-storage/<sanitized-key>.json` so the bridge
  // surface (key/value) doesn't leak the underlying filesystem layout to the
  // webview. Path traversal in `key` is rejected at `sanitizeStorageKey`.
  function sanitizeStorageKey(key: unknown): string | null {
    if (typeof key !== "string") return null;
    const trimmed = key.trim();
    if (!trimmed || trimmed.length > 128) return null;
    // Allowlist: alphanumerics, `-`, `_`, `.` only. Refuses `..`, slashes, and
    // any control char a malicious renderer could embed to escape the
    // ui-storage subdir even before the storage layer's realpath check fires.
    if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return null;
    if (trimmed === "." || trimmed === "..") return null;
    return trimmed;
  }
  ipcMain.handle(CHANNELS.pluginBridge.storageGet, async (e, key: string) => {
    const binding = resolvePluginFromSender(e);
    if (!binding) {
      auditUnauthorized(auditLogger, CHANNELS.pluginBridge.storageGet, e);
      return UNAUTHORIZED_FRAME;
    }
    const safeKey = sanitizeStorageKey(key);
    if (!safeKey) return { ok: false as const, error: "invalid-key" };
    const storage = pluginRuntime.getPluginStorage(binding.pluginId);
    if (!storage) return { ok: false as const, error: "unknown-plugin-id" };
    try {
      const value = await storage.readJson<unknown>(`ui-storage/${safeKey}.json`);
      return { ok: true as const, value: value ?? undefined };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  });
  ipcMain.handle(CHANNELS.pluginBridge.storageSet, async (e, key: string, value: unknown) => {
    const binding = resolvePluginFromSender(e);
    if (!binding) {
      auditUnauthorized(auditLogger, CHANNELS.pluginBridge.storageSet, e);
      return UNAUTHORIZED_FRAME;
    }
    const safeKey = sanitizeStorageKey(key);
    if (!safeKey) return { ok: false as const, error: "invalid-key" };
    const storage = pluginRuntime.getPluginStorage(binding.pluginId);
    if (!storage) return { ok: false as const, error: "unknown-plugin-id" };
    try {
      await storage.writeJson(`ui-storage/${safeKey}.json`, value);
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  });

  ipcMain.handle(CHANNELS.pluginBridge.emitEvent, (e, type: string, data?: unknown) => {
    const binding = resolvePluginFromSender(e);
    if (!binding) {
      auditUnauthorized(auditLogger, CHANNELS.pluginBridge.emitEvent, e);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof type !== "string" || !type.trim()) {
      return { ok: false, error: "invalid-event-type" };
    }
    const manifest = pluginRuntime.getPluginManifest(binding.pluginId);
    if (!manifest) {
      return { ok: false, error: "unknown-plugin-id" };
    }
    // Host-only namespaces (plugin.*, etc.) are reserved for host-side emit
    // via boot/types.ts:emitEvent — plugin webview/renderer MUST NOT spoof
    // them. Mirrors the canEmitEvent gate at boot/steps/plugin-runtime.ts
    // (which covers the SDK hostApi.emitEvent path); this branch covers the
    // IPC bridge path that webviews use directly.
    const namespacePrefix = type.split(".")[0] ?? "";
    if (HOST_ONLY_EMIT_NAMESPACES.has(namespacePrefix)) {
      return { ok: false, error: `host-only-namespace:${namespacePrefix}` };
    }
    // Emit authorization for gated event-source namespaces is inferred from the
    // manifest's declared emittedEvents, not a separately-declared capability
    // (same predicate as the SDK hostApi.emitEvent path). The error code keeps
    // the `missing-capability:` prefix for renderer/preload compatibility.
    if (!canEmitEvent(type, getDeclaredEmittedEvents(manifest))) {
      const requiredCap = requiredCapabilityForEmit(type);
      return { ok: false, error: `missing-capability:${requiredCap}` };
    }
    try {
      pluginRuntime.assertPluginEventEmitAccess(binding.pluginId, type);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    try {
      emitHostEvent(type, { ...((data as Record<string, unknown>) ?? {}), pluginId: binding.pluginId });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // ─── Theme propagation ─────────────────────────────────────────────────
  // Host renderer calls this when any theme axis changes; main fans out to
  // every registered plugin webview via the existing lvis:plugin:event channel
  // and publishes the same host event for plugin host services.
  ipcMain.handle(CHANNELS.host.pluginThemeNotify, (e, payload: unknown) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.host.pluginThemeNotify, e);
      return UNAUTHORIZED_FRAME;
    }
    const validated = recordValidatedTheme(payload);
    if (!validated.ok) return validated;
    const { safe } = validated;
    publishHostThemeChanged(safe);
    for (const [wcId] of pluginWebviewRegistry) {
      try {
        const wc = webContents.fromId(wcId);
        if (wc && !wc.isDestroyed()) {
          wc.send(CHANNELS.pluginBridge.event, "host.theme.changed", cloneThemePayload(safe));
        }
      } catch { /* webview destroyed between registry read and send */ }
    }
    return { ok: true };
  });

  // ─── Notifications ──────────────────────────────────────────────────────
  ipcMain.handle(CHANNELS.notification.clicked, (e, payload: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.notification.clicked, e);
      return UNAUTHORIZED_FRAME;
    }
    const kind = (payload as { kind?: unknown } | null | undefined)?.kind;
    if (typeof kind !== "string" || !NOTIFICATION_KINDS.has(kind as never)) {
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "ipc-bridge",
        type: "warn",
        input: JSON.stringify({
          event: "notification.clicked.invalid-payload",
          receivedKind: typeof kind === "string" ? kind.slice(0, 32) : typeof kind,
          hasContextRef: typeof (payload as Record<string, unknown> | null | undefined)?.contextRef === "object",
        }),
      });
      return { ok: false, error: "invalid-payload" };
    }
    const clickPayload: { kind: NotificationKind; contextRef?: NotificationContextRef } = {
      kind: kind as NotificationKind,
    };
    const contextRef = sanitizeNotificationContextRef(
      (payload as { contextRef?: unknown } | null | undefined)?.contextRef,
    );
    if (contextRef) clickPayload.contextRef = contextRef;
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      try {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        win.webContents.send(IPC_NOTIFICATION_CLICKED, clickPayload);
      } catch (err) {
        log.warn(
          "notification:clicked focus failed: %s",
          (err as Error).message,
        );
      }
    }
    return { ok: true };
  });
}
