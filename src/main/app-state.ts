/**
 * Main-process shared mutable state.
 *
 * `src/main.ts` (the Electron entry) historically held ~9 mutable
 * module-level bindings — the main/settings windows, the tray, the
 * `WindowManager`, the resolved `AppServices`, and a handful of boot/shutdown
 * flags — that were read and written across many top-level functions. When
 * those functions moved into cohesive `src/main/*` modules (commit C17) they
 * could no longer close over `main.ts` locals, so the shared bindings live
 * here behind small get/set accessors instead. This is a single source of
 * truth for cross-module runtime state; behaviour is identical to the previous
 * closed-over module locals.
 *
 * Accessors return live values (no snapshotting), matching the semantics of
 * reading the module-level `let` binding directly.
 */
import type { BrowserWindow, Tray } from "electron";
import type { WindowManager } from "./window-manager.js";
import type { AppServices } from "../boot.js";

// Tab detach + magnetic snap — created before createWindow() so it is ready
// when the main window is registered.
let windowManager: WindowManager | null = null;
export function getWindowManager(): WindowManager | null {
  return windowManager;
}
export function setWindowManager(value: WindowManager | null): void {
  windowManager = value;
}

let mainWindow: BrowserWindow | null = null;
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
export function setMainWindow(value: BrowserWindow | null): void {
  mainWindow = value;
}

let settingsWindow: BrowserWindow | null = null;
export function getSettingsWindow(): BrowserWindow | null {
  return settingsWindow;
}
export function setSettingsWindow(value: BrowserWindow | null): void {
  settingsWindow = value;
}

let tray: Tray | null = null;
export function getTray(): Tray | null {
  return tray;
}
export function setTray(value: Tray | null): void {
  tray = value;
}

let services: AppServices | null = null;
export function getServices(): AppServices | null {
  return services;
}
export function setServices(value: AppServices | null): void {
  services = value;
}

let pendingLvisUri: string | null = null;
export function getPendingLvisUri(): string | null {
  return pendingLvisUri;
}
export function setPendingLvisUri(value: string | null): void {
  pendingLvisUri = value;
}

let lastRendererReloadAt = 0;
export function getLastRendererReloadAt(): number {
  return lastRendererReloadAt;
}
export function setLastRendererReloadAt(value: number): void {
  lastRendererReloadAt = value;
}

let rendererReloadReady = false;
export function isRendererReloadReady(): boolean {
  return rendererReloadReady;
}
export function setRendererReloadReady(value: boolean): void {
  rendererReloadReady = value;
}

let pendingRendererReload = false;
export function isPendingRendererReload(): boolean {
  return pendingRendererReload;
}
export function setPendingRendererReload(value: boolean): void {
  pendingRendererReload = value;
}

let appShutdownStarted = false;
export function isAppShutdownStarted(): boolean {
  return appShutdownStarted;
}
export function setAppShutdownStarted(value: boolean): void {
  appShutdownStarted = value;
}

let appShutdownCompleted = false;
export function isAppShutdownCompleted(): boolean {
  return appShutdownCompleted;
}
export function setAppShutdownCompleted(value: boolean): void {
  appShutdownCompleted = value;
}
