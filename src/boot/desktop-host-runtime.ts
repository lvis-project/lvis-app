import { app, BrowserWindow, Notification, powerMonitor, session, shell } from "electron";
import { desktopSecretEncryption } from "../main/desktop-secret-encryption.js";
import { join } from "node:path";
import { createDesktopNetworkFetch } from "./steps/desktop-network-fetch.js";
import { prepareDesktopRelease } from "./steps/desktop-release.js";
import { adaptPowerMonitor } from "../main/idle-scheduler.js";
import { getAppWindows } from "../main/main-window.js";
import { isAppShutdownStarted } from "../main/app-state.js";
import { isAppUpdateInstallRequested } from "../main/app-update-install-intent.js";
import { unregisterAllGlobalShortcuts } from "../main/global-shortcuts.js";
import { openAuthWindow, clearAuthPartition } from "../main/auth-window-service.js";
import { openLinkWindow } from "../main/link-window-service.js";
import { openAuthPartitionViewer } from "../main/auth-partition-viewer-service.js";
import { installPluginPartitionPolicy } from "../main/html-preview-partition.js";
import { pluginPartitionName } from "../shared/plugin-partition.js";
import { revokePluginWebviewsForPlugin } from "../ipc/domains/plugins.js";
import { ElectronAudioCaptureSurface } from "../main/audio-capture-surface.js";
import { ElectronFloatingDockSurface } from "../main/floating-dock-surface.js";
import { peekFloatingDock } from "./steps/plugin-runtime/host-api-factory.js";
import { pickFoldersForPlugin } from "../main/host-api/pick-folders.js";
import type { BootHost } from "./host-runtime.js";

export function createDesktopBootHost(projectRoot: string): BootHost {
  return {
    userDataPath: app.getPath("userData"),
    resourcePath: app.isPackaged ? process.resourcesPath : join(projectRoot, "resources"),
    systemLocale: app.getPreferredSystemLanguages()[0] ?? "en",
    isPackaged: app.isPackaged,
    encryption: desktopSecretEncryption,
    ...createDesktopNetworkFetch(),
    resolveProxy: (url) => session.defaultSession.resolveProxy(url),
    exit: (code) => app.exit(code),
    close: async () => {},
    desktop: {
      getAppWindows,
      getFocusedWindow: () => BrowserWindow.getFocusedWindow(),
      getAuthPartition: (partition) => session.fromPartition(partition),
      openAuthWindowService: openAuthWindow,
      openLinkWindowService: openLinkWindow,
      openAuthPartitionViewerService: (_parent, options) => openAuthPartitionViewer(options),
      clearAuthPartitionService: clearAuthPartition,
      shellOpenExternal: (url) => shell.openExternal(url),
      installPluginPartition: (pluginId, pluginRoot) => {
        installPluginPartitionPolicy(pluginPartitionName(pluginId), { pluginRoot });
      },
      revokePluginWebviews: revokePluginWebviewsForPlugin,
      onBootShutdown: (run, needed) => {
        app.once("before-quit", (event) => {
          if (isAppUpdateInstallRequested() || isAppShutdownStarted() || !needed()) return;
          event.preventDefault();
          void run().finally(() => app.quit());
        });
      },
      notificationSupported: () => Notification.isSupported(),
      notificationOptions: {
        isReady: () => app.isReady(),
        isAnyWindowFocused: () => BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isFocused()),
        notificationFactory: (options) => {
          const notification = new Notification(options);
          return { show: () => notification.show(), on: (event, handler) => notification.on(event, handler) };
        },
        notificationActivationRegistration: process.platform === "win32"
          ? (handler) => Notification.handleActivation(handler) : null,
      },
      powerMonitor: adaptPowerMonitor(powerMonitor),
      createAudioCaptureSurface: () => new ElectronAudioCaptureSurface(),
      createFloatingDockSurface: () => new ElectronFloatingDockSurface(),
      pickFolders: (pluginId, parentWindow) => pickFoldersForPlugin(pluginId, { parentWindow }),
      prepareRelease: prepareDesktopRelease,
      beforeShutdown: () => {
        unregisterAllGlobalShortcuts();
        peekFloatingDock()?.shutdown();
      },
    },
  };
}
