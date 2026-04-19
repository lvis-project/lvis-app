/**
 * Production release prep — Electron auto-update via electron-updater.
 *
 * Behavior:
 *   - On app start (after boot), and every 4h, call checkForUpdates().
 *   - On `update-available` → toast 렌더러에 "새 버전 vX.Y.Z 다운로드 중".
 *   - On `update-downloaded` → toast "재시작해서 적용" with action button.
 *   - Network errors silently logged (no user-facing noise).
 *
 * All credentials/publish config are declared in package.json `build.publish`
 * — NEVER in code. Users supply signing certs + GH_TOKEN at release time.
 */
import { createRequire } from "node:module";
import type { BrowserWindow } from "electron";

const _require = createRequire(import.meta.url);

export interface AutoUpdaterDeps {
  mainWindow: BrowserWindow;
  /** Settings accessor — re-read on every tick so user can toggle at runtime. */
  isEnabled: () => boolean;
  /**
   * Injectable updater (test seam). In production we dynamically require
   * `electron-updater` so unit tests don't need the native dep.
   */
  updaterFactory?: () => UpdaterLike;
}

/** Minimal surface of electron-updater.autoUpdater we rely on. */
export interface UpdaterLike {
  on(event: "update-available", cb: (info: { version: string }) => void): void;
  on(event: "update-downloaded", cb: (info: { version: string }) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
}

export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export function createAutoUpdater(deps: AutoUpdaterDeps): {
  start: () => void;
  stop: () => void;
  triggerCheck: () => Promise<void>;
} {
  let timer: NodeJS.Timeout | undefined;
  let updater: UpdaterLike | null = null;
  let wired = false;

  const loadUpdater = (): UpdaterLike | null => {
    if (updater) return updater;
    try {
      updater = deps.updaterFactory
        ? deps.updaterFactory()
        : (_require("electron-updater").autoUpdater as UpdaterLike);
      return updater;
    } catch (err) {
      console.warn("[auto-updater] electron-updater unavailable:", (err as Error).message);
      return null;
    }
  };

  const wire = (u: UpdaterLike) => {
    if (wired) return;
    wired = true;
    u.on("update-available", (info) => {
      sendToast(deps.mainWindow, `새 버전 v${info.version} 다운로드 중`, "info");
    });
    u.on("update-downloaded", (info) => {
      sendToast(
        deps.mainWindow,
        `업데이트 준비 완료 — 재시작해서 적용 (v${info.version})`,
        "action",
        { action: "restart-to-update" },
      );
    });
    u.on("error", (err) => {
      console.warn("[auto-updater] error (non-fatal):", err.message);
    });
  };

  const triggerCheck = async (): Promise<void> => {
    if (!deps.isEnabled()) return;
    const u = loadUpdater();
    if (!u) return;
    wire(u);
    try {
      await u.checkForUpdates();
    } catch (err) {
      console.warn("[auto-updater] checkForUpdates failed:", (err as Error).message);
    }
  };

  return {
    start() {
      if (timer) return;
      void triggerCheck();
      timer = setInterval(() => void triggerCheck(), CHECK_INTERVAL_MS);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    triggerCheck,
  };
}

function sendToast(
  win: BrowserWindow,
  message: string,
  kind: "info" | "action",
  payload?: Record<string, unknown>,
): void {
  if (win.isDestroyed()) return;
  try {
    win.webContents.send("lvis:update:toast", { message, kind, ...payload });
  } catch (err) {
    console.warn("[auto-updater] toast send failed:", (err as Error).message);
  }
}
