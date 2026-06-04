/**
 * Plugins domain IPC handlers.
 * Covers: lvis:plugins:*, lvis:bootstrap:*, lvis:runtime:*, lvis:marketplace:*,
 *         lvis:mcp:*, lvis:plugin:* (webview bridge), lvis:file:*,
 *         lvis:notification:clicked
 */
import { dialog, ipcMain, webContents } from "electron";
import { t } from "../../i18n/index.js";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { emitEvent as emitHostEvent } from "../../boot/types.js";
import { HOST_ONLY_EMIT_NAMESPACES, requiredCapabilityForEmit } from "../../plugins/capabilities.js";
import { stripSecretFields } from "../../plugins/config-schema.js";
import { shouldBlockPluginSecretRead, validateApiKeyLikeSecretValue } from "../../plugins/secret-shape.js";
import { emitPluginConfigChange, SECRET_REDACTED_SENTINEL } from "../../plugins/config-change-bus.js";
import { runManagedBootstrap } from "../../boot/managed-marketplace.js";
import { isDevModeUnlocked } from "../../boot/dev-flags.js";
import { NOTIFICATION_KINDS } from "../../main/notification-service.js";
import { validateSender, validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized, validatePluginFrame } from "../gated.js";
import type { IpcDeps } from "../types.js";
import { sendToWindow } from "../safe-send.js";
import { BUNDLE_IDS } from "../../shared/theme-bundles.js";
import { createLogger } from "../../lib/logger.js";
import { plog, PluginPhase } from "../../plugins/lifecycle-log.js";
import { redactFsPath, redactAuditPayload } from "../../audit/dlp-filter.js";
import { LVIS_TOKEN_NAMES } from "../../shared/plugin-ui-tokens.js";
import { pluginAssetUrlFromRealPath } from "../../main/plugin-asset-protocol.js";
import {
  installMarketplacePluginWithLifecycle,
  startInstalledPluginWithLifecycle,
  withPluginInstallLock,
} from "../../plugins/install-lifecycle.js";
import { uninstallPluginWithLifecycle } from "../../plugins/uninstall-lifecycle.js";
import { lvisHome } from "../../shared/lvis-home.js";
const log = createLogger("lvis");
const MARKETPLACE_PING_TIMEOUT_MS = 15_000;
const MARKETPLACE_PING_CACHE_TTL_MS = 10_000;

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
}
const pluginWebviewRegistry = new Map<number, PluginWebviewBinding>();

export type SafeThemePayload = {
  /** v2: bundle identifier (e.g. "tokyo-night", "violet-dark"). */
  bundleId: string;
  /** v2: shell polarity derived from the active bundle. */
  shell: "light" | "dark";
  colorScheme?: "light" | "dark";
  reducedMotion?: boolean;
  tokens?: Record<string, string>;
};

/**
 * Last validated `host.theme.changed` payload broadcast to plugin webviews.
 *
 * Why: a plugin webview that registers AFTER the renderer's last
 * `notifyPluginTheme` call would otherwise miss the active theme entirely
 * (stuck on the SDK's `:root` fallback) until the user toggles a theme.
 * On register we replay this cached payload to the freshly attached wc so
 * the plugin paints with the right tokens from first frame.
 *
 * Null until the renderer's first broadcast — pre-broadcast registrations
 * still fall through to the SDK fallback (acceptable boot window). Renderer
 * always re-broadcasts on its own mount, so this gap closes within milliseconds.
 */
let lastThemePayload: SafeThemePayload | null = null;

function cloneThemePayload(payload: SafeThemePayload): SafeThemePayload {
  const clone: SafeThemePayload = {
    bundleId: payload.bundleId,
    shell: payload.shell,
  };
  if (payload.colorScheme) clone.colorScheme = payload.colorScheme;
  if (typeof payload.reducedMotion === "boolean") clone.reducedMotion = payload.reducedMotion;
  if (payload.tokens) {
    clone.tokens = Object.freeze({ ...payload.tokens }) as Record<string, string>;
  }
  return Object.freeze(clone);
}

/** @internal — read access to the cached theme payload (tests + replay). */
export function getLastThemePayload(): SafeThemePayload | null {
  return lastThemePayload ? cloneThemePayload(lastThemePayload) : null;
}

/**
 * Validate a theme payload and, on success, record it as the new replay cache.
 * Invalid payloads leave the existing cache untouched. The IPC handler uses
 * this so the validate + cache step stays atomic under unit test.
 */
export function recordValidatedTheme(payload: unknown):
  | { ok: true; safe: SafeThemePayload }
  | { ok: false; error: string } {
  const result = validateThemePayload(payload);
  if (!result.ok) return result;
  const safe = cloneThemePayload(result.safe);
  lastThemePayload = safe;
  return { ok: true, safe };
}

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
      wc.send("lvis:plugin:event", "host.theme.changed", theme);
      return theme;
    }
  } catch {
    /* swallowed — caller logs at debug. */
  }
  return null;
}

/** @internal — test-only reset to keep cross-test state clean. */
export function __resetLastThemePayloadForTests(): void {
  lastThemePayload = null;
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


// §C3: single source from src/shared/theme-bundles.ts — no manual sync needed.
const ALLOWED_BUNDLE_IDS = new Set<string>(BUNDLE_IDS);
const ALLOWED_SHELLS = new Set(["light", "dark"]);
// Host SoT: runtime validation stays in-app so main-process code never depends
// on SDK runtime values. The SDK republishes the same contract for plugin
// authors via sync-from-host.
const PLUGIN_TOKEN_NAMES: Set<string> = new Set(LVIS_TOKEN_NAMES);
// Allowlist-based value guard: only HSL colors, hex colors, dimension values,
// font-weight integers, and motion timing values pass.
// Blocklist patterns (url(), expression(), Unicode-escaped equivalents) would all fail this check.
// Hex: only valid CSS lengths — 3 (#RGB), 4 (#RGBA), 6 (#RRGGBB), 8 (#RRGGBBAA).
// 5- and 7-char hex are not valid CSS and would be silently ignored by browsers.
// [1-9]00: font-weight values (100-900). \d+ms: motion timing (150ms, 200ms).
const _SAFE_TOKEN_VALUE = /^(hsl\(\s*-?\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?%\s*,\s*\d+(?:\.\d+)?%\s*\)|#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})|\d+(?:\.\d+)?(?:rem|em|px|%)|[1-9]00|\d+(?:\.\d+)?ms)$/;

export function validateThemePayload(payload: unknown):
  | { ok: true; safe: SafeThemePayload }
  | { ok: false; error: string } {
  if (!payload || typeof payload !== "object") return { ok: false, error: "invalid-payload" };
  const p = payload as Record<string, unknown>;
  if (typeof p.bundleId !== "string" || !ALLOWED_BUNDLE_IDS.has(p.bundleId)) return { ok: false, error: "invalid-bundle-id" };
  if (typeof p.shell !== "string" || !ALLOWED_SHELLS.has(p.shell)) return { ok: false, error: "invalid-shell" };
  const safe: SafeThemePayload = {
    bundleId: p.bundleId,
    shell: p.shell as "light" | "dark",
  };
  if (!p.tokens || typeof p.tokens !== "object" || Array.isArray(p.tokens)) {
    return { ok: false, error: "missing-tokens" };
  }
  const safeTokens: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.tokens as Record<string, unknown>)) {
    if (PLUGIN_TOKEN_NAMES.has(k) && typeof v === "string" && _SAFE_TOKEN_VALUE.test(v)) {
      safeTokens[k] = v;
    }
  }
  safe.tokens = safeTokens;
  // `fonts` is intentionally dropped. SDK v5+ removed the channel
  // (`LvisThemePayload.fonts` is `@deprecated No longer emitted by the host`)
  // and the renderer's `notifyPluginTheme` bridge no longer surfaces a
  // `fonts` field. Any inbound `fonts` is silently ignored — letterforms
  // come from each host-owned shell's `font-family` mirror of HOST_FONT_STACK.
  if (typeof p.colorScheme === "string" && (p.colorScheme === "light" || p.colorScheme === "dark")) {
    safe.colorScheme = p.colorScheme;
  }
  if (typeof p.reducedMotion === "boolean") {
    safe.reducedMotion = p.reducedMotion;
  }
  return { ok: true, safe };
}

export function unregisterPluginWebview(webContentsId: number): void {
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
  ipcMain.handle("lvis:bootstrap:retry", async (e) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:bootstrap:retry", e);
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

  ipcMain.handle("lvis:plugins:install", async (e, pluginId: string, options?: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:plugins:install", e); return UNAUTHORIZED_FRAME; }
    const lifecycleSlug = pluginId;
    const installOptions = asPlainRecord(options);
    const expectedVersionValue = installOptions.expectedVersion;
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
        pluginRuntime,
        pluginMarketplace,
        broadcastInstallProgress: (payload) =>
          broadcastPluginLifecycleEvent("lvis:plugins:install-progress", payload),
        emitPluginInstalled: (payload) => emitHostEvent("plugin.installed", payload),
        refreshPluginNotifications,
        log,
      });
    } catch (err) {
      const message = errMessage(err) || "addPlugin failed";
      broadcastPluginLifecycleEvent("lvis:plugins:install-result", {
        slug: lifecycleSlug,
        success: false,
        error: message,
      });
      throw err;
    }
    broadcastPluginLifecycleEvent("lvis:plugins:install-result", { slug: lifecycleSlug, success: true });
    return result;
  });

  ipcMain.handle("lvis:plugins:uninstall", async (e, pluginId: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:plugins:uninstall", e); return UNAUTHORIZED_FRAME; }
    const broadcastUninstallResult = (payload: { slug: string; success: boolean; error?: string }) => {
      broadcastPluginLifecycleEvent("lvis:plugins:uninstall-result", payload);
    };
    try {
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

  // #1176 — toggle a plugin's active/inactive state. Persists `enabled` to the
  // registry and broadcasts a lifecycle event so the renderer refreshes its
  // plugin cards. The plugin stays loaded; only its per-turn tool exposure is
  // gated (PluginRuntime.setPluginEnabled does not unload/reload).
  ipcMain.handle(
    "lvis:plugins:set-enabled",
    async (e, pluginId: unknown, enabled: unknown) => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, "lvis:plugins:set-enabled", e);
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
      broadcastPluginLifecycleEvent("lvis:plugins:enabled-changed", { pluginId, enabled });
      return { ok: true, pluginId, enabled } as const;
    },
  );

  ipcMain.handle("lvis:plugins:install-local", async (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:plugins:install-local", e); return UNAUTHORIZED_FRAME; }
    if (!isDevModeUnlocked()) {
      throw new Error("[security] dev mode not unlocked — enable a supported LVIS_DEV* flag in a non-packaged build");
    }
    const { filePaths, canceled } = await dialog.showOpenDialog({
      title: t("mainDialog.installLocalPluginTitle"),
      properties: ["openDirectory"],
      message: t("mainDialog.installLocalPluginMessage"),
    });
    if (canceled || !filePaths[0]) return null;
    const result = await pluginMarketplace.installLocal(filePaths[0]);
    // Atomic install — same rollback-on-addPlugin-fail contract as the
    // marketplace install path above. local-dev installs are dev-mode
    // only but a failed import (e.g. forgot to `bun run build` before
    // selecting the dir) still left a dangling registry entry pre-fix.
    //
    // Lock scope is post-extract because the pluginId is only known
    // after `installLocal` reads the on-disk plugin.json; the IPC entry
    // itself doesn't carry an id. Race window is narrow (single dev
    // double-clicking the dialog button) but the lock costs nothing.
    return await withPluginInstallLock(result.pluginId, async () => {
      try {
        await startInstalledPluginWithLifecycle({
          pluginId: result.pluginId,
          source: "local-dev",
          rollbackMode: "local-dev",
          pluginRuntime,
          pluginMarketplace,
          broadcastInstallProgress: (payload) =>
            broadcastPluginLifecycleEvent("lvis:plugins:install-progress", payload),
          emitPluginInstalled: (payload) => emitHostEvent("plugin.installed", payload),
          refreshPluginNotifications,
          log,
        });
      } catch (err) {
        const message = errMessage(err) || "addPlugin failed";
        broadcastPluginLifecycleEvent("lvis:plugins:install-result", {
          slug: result.pluginId,
          success: false,
          error: message,
        });
        throw err;
      }
      // Mirror the marketplace install path's renderer broadcast so
      // `App.tsx` `onPluginInstallResult` listener fires `refreshViews()`.
      broadcastPluginLifecycleEvent("lvis:plugins:install-result", {
        slug: result.pluginId,
        success: true,
      });
      return result;
    });
  });

  // read-only, sender guard optional
  ipcMain.handle("lvis:plugins:ui:list", () => pluginRuntime.listUiExtensions());

  ipcMain.handle("lvis:plugins:ui:read-module", async (e, payload?: { pluginId?: string; viewId?: string }) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:plugins:ui:read-module", e);
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
  ipcMain.handle("lvis:plugins:cards", () => pluginRuntime.listPluginCards(deps.toolRegistry));

  ipcMain.handle("lvis:runtime:counts", (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:runtime:counts", e); return UNAUTHORIZED_FRAME; }
    return {
      tools: deps.toolRegistry.size,
      plugins: pluginRuntime.listPluginIds().length,
      mcps: deps.mcpManager.listServers().filter((s) => s.status === "connected").length,
    };
  });

  ipcMain.handle("lvis:runtime:env", async (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:runtime:env", e); return UNAUTHORIZED_FRAME; }
    const os = await import("node:os");
    return {
      platform: process.platform,
      hostname: os.hostname(),
      user: os.userInfo().username,
    };
  });

  ipcMain.handle("lvis:marketplace:ping", async (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:marketplace:ping", e); return UNAUTHORIZED_FRAME; }
    return runMarketplacePing();
  });

  // read-only, sender guard optional
  ipcMain.handle("lvis:plugins:marketplace:list", () => pluginMarketplace.list());

  ipcMain.handle("lvis:agents:list", async (e) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:agents:list", e);
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

  ipcMain.handle("lvis:skills:list", async (e) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:skills:list", e);
      return UNAUTHORIZED_FRAME;
    }
    const skills = deps.skillStore?.listCatalogSync() ?? [];
    return { skills };
  });

  ipcMain.handle("lvis:agents:install", async (e, slug: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:agents:install", e);
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
      broadcastPluginLifecycleEvent("lvis:agents:install-progress", { slug: trimmed, phase: "installing" });
      const result = await installAgentPackageFromMarketplace(trimmed, {
        fetcher: pluginMarketplace.getFetcher(),
        store: agentArtifactStore,
        registryPath: path.resolve(lvisHome(), "agents", "registry.json"),
        onProgress: (evt) => {
          if (evt.phase === "downloading") {
            broadcastPluginLifecycleEvent("lvis:agents:install-progress", {
              slug: trimmed,
              phase: "downloading",
              bytesDownloaded: evt.bytesDownloaded,
              bytesTotal: evt.bytesTotal,
            });
          } else {
            broadcastPluginLifecycleEvent("lvis:agents:install-progress", { slug: trimmed, phase: evt.phase });
          }
        },
      });
      emitHostEvent("agent.installed", { agentId: result.agentId, slug: result.slug, source: "marketplace" });
      broadcastPluginLifecycleEvent("lvis:agents:install-result", {
        slug: result.slug,
        agentId: result.agentId,
        success: true,
      });
      return { ok: true as const, slug: result.slug, agentId: result.agentId, version: result.version, installed: true as const };
    } catch (err) {
      const message = (err as Error).message ?? "Agent install failed";
      broadcastPluginLifecycleEvent("lvis:agents:install-result", { slug: trimmed, success: false, error: message });
      return { ok: false as const, error: "install-failed", message };
    }
  });

  ipcMain.handle("lvis:agents:uninstall", async (e, slug: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:agents:uninstall", e);
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
      broadcastPluginLifecycleEvent("lvis:agents:uninstall-result", {
        slug: result.slug,
        agentId: result.agentId,
        success: true,
      });
      return { ok: true as const, slug: result.slug, agentId: result.agentId, uninstalled: true as const };
    } catch (err) {
      const message = (err as Error).message ?? "Agent uninstall failed";
      broadcastPluginLifecycleEvent("lvis:agents:uninstall-result", { slug: trimmed, success: false, error: message });
      return { ok: false as const, error: "uninstall-failed", message };
    }
  });

  ipcMain.handle("lvis:skills:install", async (e, slug: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:skills:install", e);
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
      broadcastPluginLifecycleEvent("lvis:skills:install-progress", { slug: trimmed, phase: "installing" });
      const result = await installSkillPackageFromMarketplace(trimmed, {
        fetcher: pluginMarketplace.getFetcher(),
        store: skillArtifactStore,
        registryPath: path.resolve(lvisHome(), "skills", "registry.json"),
        onProgress: (evt) => {
          if (evt.phase === "downloading") {
            broadcastPluginLifecycleEvent("lvis:skills:install-progress", {
              slug: trimmed,
              phase: "downloading",
              bytesDownloaded: evt.bytesDownloaded,
              bytesTotal: evt.bytesTotal,
            });
          } else {
            broadcastPluginLifecycleEvent("lvis:skills:install-progress", { slug: trimmed, phase: evt.phase });
          }
        },
      });
      emitHostEvent("skill.installed", { skillId: result.skillId, slug: result.slug, source: "marketplace" });
      broadcastPluginLifecycleEvent("lvis:skills:install-result", {
        slug: result.slug,
        skillId: result.skillId,
        success: true,
      });
      return { ok: true as const, slug: result.slug, skillId: result.skillId, version: result.version, installed: true as const };
    } catch (err) {
      const message = (err as Error).message ?? "Skill install failed";
      broadcastPluginLifecycleEvent("lvis:skills:install-result", { slug: trimmed, success: false, error: message });
      return { ok: false as const, error: "install-failed", message };
    }
  });

  ipcMain.handle("lvis:skills:uninstall", async (e, slug: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:skills:uninstall", e);
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
      broadcastPluginLifecycleEvent("lvis:skills:uninstall-result", {
        slug: result.slug,
        skillId: result.skillId,
        success: true,
      });
      return { ok: true as const, slug: result.slug, skillId: result.skillId, uninstalled: true as const };
    } catch (err) {
      const message = (err as Error).message ?? "Skill uninstall failed";
      broadcastPluginLifecycleEvent("lvis:skills:uninstall-result", { slug: trimmed, success: false, error: message });
      return { ok: false as const, error: "uninstall-failed", message };
    }
  });

  ipcMain.handle("lvis:plugins:config:get", (e, pluginId: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:plugins:config:get", e);
      return pluginConfigError("unauthorized-frame", t("mainDialog.unauthorizedFrame"));
    }
    try {
      return { ok: true as const, config: settingsService.getPluginConfig(pluginId) };
    } catch (err) {
      return pluginConfigError("invalid-plugin-config-request", (err as Error).message);
    }
  });

  ipcMain.handle("lvis:plugins:config:set", async (e, pluginId: string, config: unknown) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:plugins:config:set", e);
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

  ipcMain.handle("lvis:plugins:config:schema:get", (e, pluginId: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:plugins:config:schema:get", e);
      return pluginConfigError("unauthorized-frame", t("mainDialog.unauthorizedFrame"));
    }
    try {
      const manifest = pluginRuntime.getPluginManifest(pluginId);
      return { ok: true as const, schema: manifest?.configSchema ?? null };
    } catch (err) {
      return pluginConfigError("plugin-config-schema-load-failed", (err as Error).message);
    }
  });

  ipcMain.handle("lvis:plugins:config:secret:set", async (e, pluginId: string, key: string, value: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:plugins:config:secret:set", e);
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

  ipcMain.handle("lvis:plugins:config:secret:list-keys", (e, pluginId: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:plugins:config:secret:list-keys", e);
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
  ipcMain.handle("lvis:plugins:perf-stats", () => pluginRuntime.getPerfStats());

  ipcMain.handle("lvis:plugins:call", (e, method: string, payload?: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:plugins:call", e); return UNAUTHORIZED_FRAME; }
    return pluginRuntime.callFromUi(method, payload);
  });

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

  ipcMain.handle("lvis:mcp:servers", (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:mcp:servers", e); return UNAUTHORIZED_FRAME; }
    return deps.mcpManager.listServers();
  });
  ipcMain.handle("lvis:mcp:kill", (e, serverId: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:mcp:kill", e); return UNAUTHORIZED_FRAME; }
    return deps.mcpManager.killSwitch(serverId);
  });
  ipcMain.handle("lvis:mcp:config:get", (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:mcp:config:get", e); return UNAUTHORIZED_FRAME; }
    return deps.mcpManager.getConfigs();
  });
  ipcMain.handle("lvis:mcp:config:path", (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:mcp:config:path", e); return UNAUTHORIZED_FRAME; }
    return deps.mcpManager.getConfigPath();
  });
  ipcMain.handle("lvis:mcp:config:add", async (e, config: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:mcp:config:add", e); return UNAUTHORIZED_FRAME; }
    return deps.mcpManager.addConfig(config as import("../../mcp/types.js").McpServerConfig);
  });
  ipcMain.handle("lvis:mcp:config:set-api-key", async (e, serverId: string, apiKey: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:mcp:config:set-api-key", e); return UNAUTHORIZED_FRAME; }
    if (!checkSetApiKeyRateLimit(String(serverId))) {
      throw new Error("Rate limit exceeded: lvis:mcp:config:set-api-key (5/min per server)");
    }
    return deps.mcpManager.setApiKey(serverId, apiKey);
  });
  ipcMain.handle("lvis:mcp:config:remove", async (e, serverId: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:mcp:config:remove", e); return UNAUTHORIZED_FRAME; }
    return deps.mcpManager.removeConfig(serverId);
  });
  ipcMain.handle("lvis:mcp:ui-resource", async (e, serverId: string, uri: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:mcp:ui-resource", e); return UNAUTHORIZED_FRAME; }
    return deps.mcpManager.readUiResource(serverId, uri);
  });

  ipcMain.handle("lvis:mcp:catalog:list", async (e) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:mcp:catalog:list", e);
      return UNAUTHORIZED_FRAME;
    }
    const all = await pluginMarketplace.list();
    return all.filter((p) => p.pluginType === "mcp");
  });

  ipcMain.handle("lvis:mcp:install-from-marketplace", async (e, slug: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:mcp:install-from-marketplace", e);
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

  ipcMain.handle("lvis:mcp:import:claude-desktop:preview", async (e, raw: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:mcp:import:claude-desktop:preview", e);
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
    "lvis:mcp:import:claude-desktop:apply",
    async (
      e,
      payload: { raw: string; conflictPolicy?: "skip" | "overwrite" },
    ) => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, "lvis:mcp:import:claude-desktop:apply", e);
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
          channel: "lvis:plugin:register-webview",
          reason,
          payload: redactAuditPayload(payload),
        }),
      });
    } catch {
      // Never let audit logging break the IPC sentinel return.
    }
  };
  ipcMain.handle("lvis:plugin:register-webview", (e, payload: { webContentsId: number; pluginId: string; entryUrl: string }) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:plugin:register-webview", e);
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
    const binding = { pluginId, entryUrl, assetEntryUrl: versionedAssetEntryUrl };
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

  ipcMain.handle("lvis:plugin:get-entry-url", (e) => {
    const binding = resolvePluginFromSender(e);
    if (binding) return { ok: true as const, entryUrl: binding.assetEntryUrl };

    if (!validatePluginFrame(e)) {
      auditUnauthorized(auditLogger, "lvis:plugin:get-entry-url", e);
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
                channel: "lvis:plugin:get-entry-url",
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
  ipcMain.handle("lvis:plugin:get-theme", (e) => {
    if (!validatePluginFrame(e)) {
      auditUnauthorized(auditLogger, "lvis:plugin:get-theme", e);
      return UNAUTHORIZED_FRAME;
    }
    return { ok: true as const, theme: getLastThemePayload() };
  });

  ipcMain.handle("lvis:plugin:call-tool", async (e, method: string, payload?: unknown) => {
    const binding = resolvePluginFromSender(e);
    if (!binding) {
      auditUnauthorized(auditLogger, "lvis:plugin:call-tool", e);
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
      const result = await pluginRuntime.callFromUi(method, payload);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
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
  ipcMain.handle("lvis:plugin:config:get", (e, key: string) => {
    const binding = resolvePluginFromSender(e);
    if (!binding) {
      auditUnauthorized(auditLogger, "lvis:plugin:config:get", e);
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

  ipcMain.handle("lvis:plugin:config:set", async (e, key: string, value: unknown) => {
    const binding = resolvePluginFromSender(e);
    if (!binding) {
      auditUnauthorized(auditLogger, "lvis:plugin:config:set", e);
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
  ipcMain.handle("lvis:plugin:storage:get", async (e, key: string) => {
    const binding = resolvePluginFromSender(e);
    if (!binding) {
      auditUnauthorized(auditLogger, "lvis:plugin:storage:get", e);
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
  ipcMain.handle("lvis:plugin:storage:set", async (e, key: string, value: unknown) => {
    const binding = resolvePluginFromSender(e);
    if (!binding) {
      auditUnauthorized(auditLogger, "lvis:plugin:storage:set", e);
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

  ipcMain.handle("lvis:plugin:emit-event", (e, type: string, data?: unknown) => {
    const binding = resolvePluginFromSender(e);
    if (!binding) {
      auditUnauthorized(auditLogger, "lvis:plugin:emit-event", e);
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
    const requiredCap = requiredCapabilityForEmit(type);
    if (requiredCap && !manifest.capabilities?.includes(requiredCap)) {
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
  ipcMain.handle("lvis:host:plugin-theme-notify", (e, payload: unknown) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:host:plugin-theme-notify", e);
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
          wc.send("lvis:plugin:event", "host.theme.changed", cloneThemePayload(safe));
        }
      } catch { /* webview destroyed between registry read and send */ }
    }
    return { ok: true };
  });

  // ─── Notifications ──────────────────────────────────────────────────────
  ipcMain.handle("lvis:notification:clicked", (e, payload: unknown) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:notification:clicked", e);
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
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      try {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
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
