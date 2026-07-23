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
import type { SettingsService } from "../../data/settings-store.js";
import type { AuditLogger } from "../../audit/audit-logger.js";
import type {
  MarketplaceAnnouncement,
  MarketplaceFetcher,
} from "../../plugins/marketplace.js";
import { MARKETPLACE } from "../../shared/ipc-channels.js";
import type { MarketplaceAnnouncementPayload } from "../../shared/marketplace-announcements.js";
import type { PluginPaths } from "../../plugins/plugin-paths.js";
import { PluginUpdateDetector, isUpdateCheckEnabled } from "../../plugins/update-detector.js";
import { createAutoUpdater } from "../../main/auto-updater.js";
import { startCrashReporter } from "../../main/crash-reporter.js";
import { TelemetryService } from "../../main/telemetry.js";
import { PluginTelemetryClient } from "../../telemetry/client.js";
import { sendToWindow } from "../../ipc/safe-send.js";
import { onEvent } from "../types.js";
import { createLogger } from "../../lib/logger.js";
import { CHANNELS } from "../../contract/app-contract.js";
const log = createLogger("lvis");

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
            mainWindow.webContents.send(CHANNELS.telemetry.consentPrompt);
          }
        } catch (e) {
          log.warn("boot: telemetry consent prompt send failed: %s", (e as Error).message);
        }
      }, 500);
    }

    // S12 — PluginTelemetryClient.
    const ptClient = new PluginTelemetryClient({
      settings: () => settingsService.get("telemetry"),
      marketplaceBaseUrl: () => settingsService.get("marketplace").cloudBaseUrl,
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
    app.prependOnceListener("before-quit", () => {
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

export interface UpdateCheckInput {
  mainWindow: BrowserWindow;
  settingsService: SettingsService;
  marketplaceFetcher: MarketplaceFetcher;
  /** SoT — registry path resolved once at boot from userDataDir. */
  pluginPaths: PluginPaths;
}

/**
 * S8 — plugin update detection. Fires an IPC event `marketplace:updates-available`
 * to the renderer when newer catalog versions are found. Runs once at boot
 * and on a configurable interval (default 10m). Feature-flagged.
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
  const DEFAULT_UPDATE_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

  let lastBroadcastKey = "";
  const runUpdateCheck = async () => {
    try {
      const skippedPluginUpdates = readSkippedPluginUpdates(
        settingsService.get("marketplace")?.skippedPluginUpdates,
      );
      const updates = (await updateDetector.checkForUpdates()).filter(
        (update) => !isSkippedPluginUpdate(update, skippedPluginUpdates),
      );
      const key = updates
        .map((u) => `${u.pluginId}@${u.installedVersion}->${u.latestVersion}`)
        .sort()
        .join("|");
      if (key === lastBroadcastKey) {
        log.debug("update-check: no change (%d)", updates.length);
        return;
      }
      lastBroadcastKey = key;
      mainWindow?.webContents?.send(CHANNELS.marketplace.updatesAvailable, updates);
      if (updates.length > 0) {
        log.info("update-check: %d plugin update(s) available", updates.length);
      } else {
        log.debug("update-check: cleared previous updates");
      }
    } catch (err) {
      log.warn("update-check: error: %s", (err as Error).message);
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

const RESERVED_SKIPPED_PLUGIN_UPDATE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function readSkippedPluginUpdates(
  input: unknown,
): Record<string, string> {
  const result = Object.create(null) as Record<string, string>;
  if (!input || typeof input !== "object" || Array.isArray(input)) return result;
  for (const [pluginId, version] of Object.entries(input)) {
    const key = normalizeSkippedPluginUpdateKey(pluginId);
    const value = typeof version === "string" ? version.trim() : "";
    if (!key || !value) continue;
    result[key] = value;
  }
  return result;
}

function isSkippedPluginUpdate(
  update: { pluginId: string; latestVersion: string },
  skipped: Record<string, string>,
): boolean {
  const key = normalizeSkippedPluginUpdateKey(update.pluginId);
  const version = update.latestVersion.trim();
  return Boolean(key && version && skipped[key] === version);
}

function normalizeSkippedPluginUpdateKey(pluginId: string): string | null {
  const key = pluginId.trim();
  if (!key || RESERVED_SKIPPED_PLUGIN_UPDATE_KEYS.has(key)) return null;
  return key;
}

export interface AnnouncementCheckInput {
  getMainWindow: () => BrowserWindow | null;
  settingsService: SettingsService;
  marketplaceFetcher: MarketplaceFetcher;
}

/**
 * Marketplace announcement polling. Fetches the server's active announcement
 * set, drops the ids the user has already dismissed (persisted in
 * `settings.marketplace.dismissedAnnouncementIds`), and pushes the remainder
 * to the renderer via `MARKETPLACE.announcements`. Runs once after the real
 * renderer load and on the same interval as the plugin update-check.
 *
 * The dedup key folds in the target webContents, full visible payload, and
 * dismissed id set so a dismiss clears the banner, server-side corrections to
 * an existing announcement id rebroadcast, and a replaced main window receives
 * the current payload at least once.
 */
export function wireAnnouncementCheck(input: AnnouncementCheckInput): void {
  const { getMainWindow, settingsService, marketplaceFetcher } = input;
  const DEFAULT_ANNOUNCEMENT_INTERVAL_MS = 10 * 60 * 1000; // default 10m
  const marketplaceSettings = settingsService.get("marketplace");
  const announcementCheckEnabled =
    (marketplaceSettings?.updateCheckEnabled ?? true) && isUpdateCheckEnabled();
  if (!announcementCheckEnabled) return;

  let lastBroadcastKey = "";
  let nextWebContentsId = 0;
  const webContentsIds = new WeakMap<object, number>();
  const normalizeDismissedAnnouncementIds = (ids: unknown): number[] => {
    if (!Array.isArray(ids)) return [];
    const validIds = new Set<number>();
    for (const id of ids) {
      if (typeof id === "number" && Number.isSafeInteger(id)) {
        validIds.add(id);
      }
    }
    return Array.from(validIds).sort((a, b) => a - b);
  };
  const sortNewestFirst = (items: MarketplaceAnnouncement[]) =>
    [...items].sort((a, b) => {
      const aCreatedAt = Date.parse(a.createdAt);
      const bCreatedAt = Date.parse(b.createdAt);
      const aTime = Number.isFinite(aCreatedAt) ? aCreatedAt : 0;
      const bTime = Number.isFinite(bCreatedAt) ? bCreatedAt : 0;
      if (aTime !== bTime) return bTime - aTime;
      return b.id - a.id;
    });
  const broadcastAnnouncements = (
    visible: MarketplaceAnnouncement[],
    dismissed: number[],
  ) => {
    const targetWindow = getMainWindow();
    const webContents = targetWindow?.webContents;
    let targetKey = "none";
    if (webContents && typeof webContents === "object") {
      let id = webContentsIds.get(webContents);
      if (id === undefined) {
        id = ++nextWebContentsId;
        webContentsIds.set(webContents, id);
      }
      targetKey = `webContents:${id}`;
    }
    const key = JSON.stringify({
      target: targetKey,
      visible: visible.map((a) => ({
        id: a.id,
        title: a.title,
        body: a.body,
        level: a.level,
        createdAt: a.createdAt,
        startsAt: a.startsAt,
        endsAt: a.endsAt,
      })),
      dismissed: normalizeDismissedAnnouncementIds(dismissed),
    });
    if (key === lastBroadcastKey) return false;
    const sent = sendToWindow(
      targetWindow,
      MARKETPLACE.announcements,
      visible satisfies MarketplaceAnnouncementPayload,
      log,
    );
    if (!sent) return false;
    lastBroadcastKey = key;
    return true;
  };

  const runAnnouncementCheck = async () => {
    try {
      const announcements = await marketplaceFetcher.listAnnouncements();
      const dismissedIds = normalizeDismissedAnnouncementIds(
        settingsService.get("marketplace")?.dismissedAnnouncementIds,
      );
      const dismissed = new Set(dismissedIds);
      const visible = sortNewestFirst(
        announcements.filter((a) => !dismissed.has(a.id)),
      );
      if (!broadcastAnnouncements(visible, dismissedIds)) {
        log.debug("announcement-check: no change (%d)", visible.length);
        return;
      }
      log.info("announcement-check: %d announcement(s) active", visible.length);
    } catch (err) {
      if (broadcastAnnouncements([], [])) {
        log.warn(
          "announcement-check: error; cleared announcements: %s",
          (err as Error).message,
        );
        return;
      }
      log.debug(
        "announcement-check: still unavailable: %s",
        (err as Error).message,
      );
    }
  };

  const runAfterRendererLoad = () => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) {
      void runAnnouncementCheck();
      return;
    }
    const webContents = win.webContents as BrowserWindow["webContents"] & {
      getURL?: () => string;
      isLoading?: () => boolean;
      once?: (event: "did-finish-load", listener: () => void) => void;
    };
    const url = typeof webContents.getURL === "function" ? webContents.getURL() : "";
    const loading = typeof webContents.isLoading === "function" && webContents.isLoading();
    if (
      typeof webContents.once === "function" &&
      (loading || url.startsWith("data:"))
    ) {
      webContents.once("did-finish-load", () => void runAnnouncementCheck());
      return;
    }
    void runAnnouncementCheck();
  };

  runAfterRendererLoad();

  const intervalMs =
    settingsService.get("marketplace")?.updateCheckIntervalMs ??
    DEFAULT_ANNOUNCEMENT_INTERVAL_MS;
  let announcementTimer: ReturnType<typeof setInterval> | undefined;
  if (intervalMs > 0) {
    announcementTimer = setInterval(() => void runAnnouncementCheck(), intervalMs);
    announcementTimer.unref?.();
  }

  app.prependOnceListener("before-quit", () => {
    if (announcementTimer) clearInterval(announcementTimer);
  });
}
