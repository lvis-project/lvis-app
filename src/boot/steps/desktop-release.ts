/**
 * Boot §4.2 Step 8 — Post-boot hooks (release prep + update detector).
 *
 * Wires anonymous telemetry, crash reporter, auto-updater, plugin lifecycle
 * telemetry, first-boot consent prompt, and the plugin-update-check timer.
 * All init is best-effort (try/catch around release prep; non-fatal).
 */
import { resolve } from "node:path";
import { app } from "electron";
import { createAutoUpdater } from "../../main/auto-updater.js";
import { startCrashReporter } from "../../main/crash-reporter.js";
import { TelemetryService } from "../../main/telemetry.js";
import { PluginTelemetryClient, relocateDeviceUuid } from "../../telemetry/client.js";
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";
import { registerShutdownHook } from "../../main/app-shutdown.js";
import { onEvent } from "../types.js";
import { createLogger } from "../../lib/logger.js";
import { CHANNELS } from "../../contract/app-contract.js";
const log = createLogger("lvis");

import type { ReleasePrepInput, ReleasePrepOutput } from "./post-boot.js";
export function prepareDesktopRelease(input: ReleasePrepInput): ReleasePrepOutput {
  const { mainWindow, settingsService, bootAuditLogger, networkFetch } = input;
  let telemetry: TelemetryService | undefined;
  let pluginTelemetry: PluginTelemetryClient | undefined;
  let autoUpdaterStop: (() => void) | undefined;

  try {
    // Always started: this is the local minidump collector, and `remoteReporting`
    // is what decides whether a dump may leave the machine.
    startCrashReporter({
      userDataPath: app.getPath("userData"),
      telemetry: settingsService.get("telemetry"),
      remoteReporting: input.discretionaryEgress,
    });
    if (!input.discretionaryEgress) {
      log.info("boot: release prep wired (local crash dumps only)");
      return { telemetry, pluginTelemetry, autoUpdaterStop };
    }
    if (!mainWindow) throw new Error("Interactive release services require a main window");
    telemetry = new TelemetryService({
      settings: () => settingsService.get("telemetry"),
      appVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      auditLogger: bootAuditLogger,
      fetchImpl: networkFetch,
    });
    telemetry.start();
    telemetry.track("app_start");

    // S12 — first-boot consent prompt.
    const telemetrySettings = settingsService.get("telemetry");
    if (!telemetrySettings.telemetryPromptAnswered) {
      setTimeout(() => {
        try {
          if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send(CHANNELS.telemetry.consentPrompt);
          }
        } catch (e) {
          log.warn("boot: telemetry consent prompt send failed: %s", (e as Error).message);
        }
      }, 500);
    }

    // S12 — PluginTelemetryClient. The device id lives under `~/.lvis/telemetry/`
    // like every other feature's user data; it used to sit in a second `.lvis`
    // root under Electron's userData, and is carried over once so the device
    // keeps its identity.
    const deviceUuidPath = resolve(openFeatureNamespace("telemetry").dir, "device-uuid");
    relocateDeviceUuid(resolve(app.getPath("userData"), ".lvis", "device-uuid"), deviceUuidPath);
    const ptClient = new PluginTelemetryClient({
      settings: () => settingsService.get("telemetry"),
      marketplaceBaseUrl: () => settingsService.get("marketplace").cloudBaseUrl,
      installToken: () => settingsService.getSecret("marketplace.apiKey"),
      deviceUuidPath,
      fetchImpl: networkFetch,
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

    registerShutdownHook("plugin-telemetry-flush", () => {
      try {
        ptClient.stop();
        void ptClient.flush();
      } catch (err) {
        log.warn("shutdown: plugin telemetry final flush failed: %s", (err as Error).message);
      }
    });

    const updater = createAutoUpdater({
      mainWindow,
      auditLogger: bootAuditLogger,
      isEnabled: () => settingsService.get("updates")?.autoCheckEnabled ?? true,
      getSkippedVersion: () => settingsService.get("updates")?.skippedVersion,
      setSkippedVersion: async (version) => {
        await settingsService.patch({
          updates: {
            ...settingsService.get("updates"),
            skippedVersion: version,
          },
        });
      },
    });
    updater.start();
    autoUpdaterStop = updater.stop;
    const retainedTelemetry = telemetry;
    registerShutdownHook("auto-updater-and-telemetry-flush", () => {
      try { autoUpdaterStop?.(); } catch { /* noop */ }
      try {
        retainedTelemetry.stop();
        void retainedTelemetry.flush();
      } catch (err) {
        log.warn("shutdown: telemetry final flush failed: %s", (err as Error).message);
      }
    });
    log.info("boot: release prep wired (updater/crash/telemetry)");
  } catch (err) {
    log.warn("boot: release prep init failed (non-fatal): %s", (err as Error).message);
  }

  return { telemetry, pluginTelemetry, autoUpdaterStop };
}
