import type { BrowserWindow, Session } from "electron";
import type { SecretEncryption } from "../data/secret-document-store.js";
import type { AudioCaptureSurface } from "../main/audio-capture.js";
import type { FloatingDockSurface } from "../main/floating-dock.js";
import type { PowerMonitorLike } from "../main/idle-scheduler.js";
import type { NotificationServiceOptions } from "../main/notification-service.js";
import type { InitPluginRuntimeInput } from "./steps/plugin-runtime.js";
import type { ReleasePrepInput, ReleasePrepOutput } from "./steps/post-boot.js";

/** Desktop-owned capabilities. The server has no presentation surface. */
export interface DesktopHostCapabilities extends Pick<InitPluginRuntimeInput,
  "openAuthWindowService" | "openLinkWindowService" | "openAuthPartitionViewerService"
  | "clearAuthPartitionService" | "shellOpenExternal"> {
  getAppWindows(): BrowserWindow[];
  getFocusedWindow(): BrowserWindow | null;
  getAuthPartition(partition: string): Session;
  installPluginPartition(pluginId: string, pluginRoot: string | undefined): void;
  revokePluginWebviews(pluginId: string, revokeSession: (sessionId: string) => void): void;
  onBootShutdown(run: () => Promise<void>, needed: () => boolean): void;
  notificationSupported(): boolean;
  notificationOptions: Partial<NotificationServiceOptions>;
  powerMonitor: PowerMonitorLike;
  createAudioCaptureSurface(): AudioCaptureSurface;
  createFloatingDockSurface(): FloatingDockSurface;
  pickFolders(pluginId: string, parent: () => BrowserWindow | null): Promise<{ canceled: boolean; folders: readonly string[] }>;
  prepareRelease(input: ReleasePrepInput): ReleasePrepOutput;
  beforeShutdown(): void;
}

/** Runtime services required before any host state or outbound connection exists. */
export interface BootHost {
  readonly userDataPath: string;
  readonly resourcePath: string;
  readonly systemLocale: string;
  readonly isPackaged: boolean;
  readonly encryption: SecretEncryption;
  readonly networkFetch: typeof fetch;
  readonly singleHopNetworkFetch: typeof fetch;
  readonly llmFetch: typeof fetch;
  resolveProxy?: (url: string) => Promise<string>;
  readonly desktop?: DesktopHostCapabilities;
  exit(code: number): never | void;
  close(): Promise<void>;
}

export function requireDesktopHost(host: Pick<BootHost, "desktop">): DesktopHostCapabilities {
  if (!host.desktop) throw new Error("desktop-surface-unavailable");
  return host.desktop;
}
