/**
 * Boot §4.2 Step 8 — Post-boot hooks (release prep + update detector).
 *
 * Wires anonymous telemetry, crash reporter, auto-updater, plugin lifecycle
 * telemetry, first-boot consent prompt, and the plugin-update-check timer.
 * All init is best-effort (try/catch around release prep; non-fatal).
 */
import { resolve } from "node:path";
import { app } from "electron";
import type { BrowserWindow } from "electron";
import type { PluginRuntime } from "../../plugins/runtime.js";
import type { SettingsService } from "../../data/settings-store.js";
import type { AuditLogger } from "../../audit/audit-logger.js";
import type { MarketplaceFetcher } from "../../plugins/marketplace.js";
import type { PluginPaths } from "../../plugins/plugin-paths.js";
import { PluginUpdateDetector, isUpdateCheckEnabled } from "../../plugins/update-detector.js";
import { createAutoUpdater } from "../../main/auto-updater.js";
import { startCrashReporter } from "../../main/crash-reporter.js";
import { TelemetryService } from "../../main/telemetry.js";
import { PluginTelemetryClient } from "../../telemetry/client.js";
import { onEvent } from "../types.js";

export interface ReleasePrepOutput {
  telemetry?: TelemetryService;
  pluginTelemetry?: PluginTelemetryClient;
  autoUpdaterStop?: () => void;
}

export interface ReleasePrepInput {
  mainWindow: BrowserWindow;
  settingsService: SettingsService;
  bootAuditLogger: AuditLogger;
}

/**
 * Start crash reporter, anonymous telemetry, plugin-lifecycle telemetry, and
 * the auto-updater. All default-off or settings-driven. Non-fatal on error.
 */
export function wireReleasePrep(input: ReleasePrepInput): ReleasePrepOutput {
  const { mainWindow, settingsService, bootAuditLogger } = input;
  let telemetry: TelemetryService | undefined;
  let pluginTelemetry: PluginTelemetryClient | undefined;
  let autoUpdaterStop: (() => void) | undefined;

  try {
    startCrashReporter({
      userDataPath: app.getPath("userData"),
      telemetry: settingsService.get("telemetry"),
    });
    telemetry = new TelemetryService({
      settings: () => settingsService.get("telemetry"),
      appVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      auditLogger: bootAuditLogger,
    });
    telemetry.start();
    telemetry.track("app_start");

    // S12 — first-boot consent prompt.
    const telemetrySettings = settingsService.get("telemetry");
    if (!telemetrySettings.telemetryPromptAnswered) {
      setTimeout(() => {
        try {
          if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send("lvis:telemetry:consent-prompt");
          }
        } catch (e) {
          console.warn("[lvis] boot: telemetry consent prompt send failed:", (e as Error).message);
        }
      }, 500);
    }

    // S12 — PluginTelemetryClient.
    const ptClient = new PluginTelemetryClient({
      settings: () => settingsService.get("telemetry"),
      marketplaceBaseUrl: () => settingsService.get("marketplace").realCloudBaseUrl,
      installToken: () => settingsService.getSecret("marketplace.apiKey"),
      deviceUuidPath: resolve(app.getPath("userData"), ".lvis", "device-uuid"),
    });
    pluginTelemetry = ptClient;
    ptClient.start();

    onEvent("plugin.installed", (data) => {
      const d = data as { pluginId?: string; version?: string } | undefined;
      ptClient.track("plugin_install", {
        slug: d?.pluginId ?? "unknown",
        version: d?.version ?? "unknown",
      });
    });
    onEvent("plugin.uninstalled", (data) => {
      const d = data as { pluginId?: string; version?: string } | undefined;
      ptClient.track("plugin_uninstall", {
        slug: d?.pluginId ?? "unknown",
        version: d?.version ?? "unknown",
      });
    });
    onEvent("plugin.updated", (data) => {
      const d = data as { pluginId?: string; version?: string } | undefined;
      ptClient.track("plugin_update", {
        slug: d?.pluginId ?? "unknown",
        version: d?.version ?? "unknown",
      });
    });
    onEvent("plugin.error", (data) => {
      const d = data as { pluginId?: string; version?: string; errorClass?: string } | undefined;
      ptClient.track("plugin_error", {
        slug: d?.pluginId ?? "unknown",
        version: d?.version ?? "unknown",
        errorClass: d?.errorClass,
      });
    });

    app.prependOnceListener("before-quit", () => {
      try {
        ptClient.stop();
        void ptClient.flush();
      } catch (err) {
        console.warn("[lvis] shutdown: plugin telemetry final flush failed:", (err as Error).message);
      }
    });

    const updater = createAutoUpdater({
      mainWindow,
      isEnabled: () => settingsService.get("updates")?.autoCheckEnabled ?? true,
    });
    updater.start();
    autoUpdaterStop = updater.stop;
    const retainedTelemetry = telemetry;
    app.prependOnceListener("before-quit", () => {
      try { autoUpdaterStop?.(); } catch { /* noop */ }
      try {
        retainedTelemetry.stop();
        void retainedTelemetry.flush();
      } catch (err) {
        console.warn("[lvis] shutdown: telemetry final flush failed:", (err as Error).message);
      }
    });
    console.log("[lvis] boot: release prep wired (updater/crash/telemetry)");
  } catch (err) {
    console.warn("[lvis] boot: release prep init failed (non-fatal):", (err as Error).message);
  }

  return { telemetry, pluginTelemetry, autoUpdaterStop };
}

export interface UpdateCheckInput {
  mainWindow: BrowserWindow;
  settingsService: SettingsService;
  marketplaceFetcher: MarketplaceFetcher;
  /** Phase 2a SoT — registry path resolved once at boot from userDataDir. */
  pluginPaths: PluginPaths;
}

/**
 * S8 — plugin update detection. Fires an IPC event `marketplace:updates-available`
 * to the renderer when newer catalog versions are found. Runs once at boot
 * and on a configurable interval (default 6h). Feature-flagged.
 */
export function wireUpdateCheck(input: UpdateCheckInput): void {
  const { mainWindow, settingsService, marketplaceFetcher, pluginPaths } = input;
  const marketplaceSettings = settingsService.get("marketplace");
  const updateCheckFeatureEnabled =
    (marketplaceSettings?.updateCheckEnabled ?? true) && isUpdateCheckEnabled();
  if (!updateCheckFeatureEnabled) return;

  const registryPath = pluginPaths.registryPath;
  const updateDetector = new PluginUpdateDetector(registryPath, marketplaceFetcher, {
    canaryOptIn: marketplaceSettings?.canaryOptIn ?? false,
  });
  const DEFAULT_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

  let lastBroadcastKey = "";
  const runUpdateCheck = async () => {
    try {
      const updates = await updateDetector.checkForUpdates();
      const key = updates
        .map((u) => `${u.pluginId}@${u.installedVersion}->${u.latestVersion}`)
        .sort()
        .join("|");
      if (key === lastBroadcastKey) {
        console.debug("[lvis] update-check: no change (%d)", updates.length);
        return;
      }
      lastBroadcastKey = key;
      mainWindow?.webContents?.send("marketplace:updates-available", updates);
      if (updates.length > 0) {
        console.log("[lvis] update-check: %d plugin update(s) available", updates.length);
      } else {
        console.debug("[lvis] update-check: cleared previous updates");
      }
    } catch (err) {
      console.warn("[lvis] update-check: error:", (err as Error).message);
    }
  };

  void runUpdateCheck();

  const intervalMs =
    settingsService.get("marketplace")?.updateCheckIntervalMs ?? DEFAULT_UPDATE_INTERVAL_MS;
  let updateCheckTimer: ReturnType<typeof setInterval> | undefined;
  if (intervalMs > 0) {
    updateCheckTimer = setInterval(() => void runUpdateCheck(), intervalMs);
    updateCheckTimer.unref?.();
  }

  app.prependOnceListener("before-quit", () => {
    if (updateCheckTimer) clearInterval(updateCheckTimer);
  });
}
