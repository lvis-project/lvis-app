/**
 * Production release prep — Electron auto-update via electron-updater.
 *
 * Behavior (user-gated, no implicit downloads):
 *   - On app start (after boot), and every 4h, call checkForUpdates().
 *     This only QUERIES the GitHub release feed — `autoDownload = false`
 *     prevents the implicit ~100MB fetch the previous default behavior
 *     would have triggered. Hard rule from user: 사용자 명시 클릭 전엔
 *     절대 다운로드 금지.
 *   - On `update-available` → broadcast state `{ kind: "available", version }`
 *     to the renderer. The renderer shows a permanent badge next to the
 *     Home button. NO download starts here.
 *   - Renderer → main: `lvis:update:download-now` triggers downloadUpdate().
 *     `download-progress` / `update-downloaded` events feed the same
 *     state stream the badge consumes.
 *   - Renderer → main: `lvis:update:install-now` triggers quitAndInstall()
 *     after the user clicks the "재시작해서 적용" badge action.
 *   - Network errors silently logged (no user-facing noise).
 *
 * All credentials/publish config are declared in package.json `build.publish`
 * — NEVER in code. Users supply signing certs + GH_TOKEN at release time.
 */
import { createRequire } from "node:module";
import type { BrowserWindow, IpcMain } from "electron";
import { createLogger } from "../lib/logger.js";
import type { UpdateState } from "../shared/update-state.js";
export type { UpdateState };
const log = createLogger("auto-updater");

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
  on(event: "update-not-available", cb: (info: { version: string }) => void): void;
  on(event: "download-progress", cb: (p: { percent: number; transferred: number; total: number }) => void): void;
  on(event: "update-downloaded", cb: (info: { version: string }) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
  // Hardening: explicit anti-downgrade + channel pin + manual-download flag.
  // Optional on the type so tests can pass minimal fakes.
  allowDowngrade?: boolean;
  channel?: string;
  /** When false (our choice), `checkForUpdates` only detects — caller must
   *  invoke `downloadUpdate()` explicitly. Default in electron-updater is
   *  `true`, which would silently fetch ~100MB on every app start. */
  autoDownload?: boolean;
}

// UpdateState type now lives in src/shared/update-state.ts and is
// re-exported above for callers that traditionally imported from this
// module (test harness, settings UI). Transient feed/download errors are
// logged but not surfaced to the renderer — we keep the last good state
// rather than introducing a fifth variant whose badge UX is unclear.

export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export function createAutoUpdater(deps: AutoUpdaterDeps): {
  start: () => void;
  stop: () => void;
  triggerCheck: () => Promise<void>;
  /** Test seam — exposes the same closure-private handlers that are
   *  registered against ipcMain at start(). Used by release-prep tests
   *  to assert negative paths (download-when-not-available, etc.)
   *  without spinning up a real Electron ipcMain. NOT used by production
   *  callers; the registered ipcMain handlers are the SoT for runtime. */
  _testOnly: {
    downloadNow: () => Promise<{ ok: boolean; reason?: string }>;
    installNow: () => Promise<{ ok: boolean; reason?: string }>;
    confirmInstall: () => Promise<{ confirmed: boolean }>;
    getState: () => UpdateState;
  };
} {
  let timer: NodeJS.Timeout | undefined;
  let updater: UpdaterLike | null = null;
  let wired = false;
  let lastState: UpdateState = { kind: "idle" };

  const loadUpdater = (): UpdaterLike | null => {
    if (updater) return updater;
    try {
      updater = deps.updaterFactory
        ? deps.updaterFactory()
        : (_require("electron-updater").autoUpdater as UpdaterLike);
      return updater;
    } catch (err) {
      log.warn("electron-updater unavailable: %s", (err as Error).message);
      return null;
    }
  };

  const broadcast = (state: UpdateState): void => {
    lastState = state;
    if (deps.mainWindow.isDestroyed()) return;
    try {
      deps.mainWindow.webContents.send("lvis:update:state", state);
    } catch (err) {
      log.warn("state broadcast failed: %s", (err as Error).message);
    }
  };

  const wire = (u: UpdaterLike) => {
    if (wired) return;
    wired = true;
    // Defend against downgrade attacks: Linux AppImage integrity rests
    // solely on the SHA512 in latest-linux.yml, so a release-feed
    // compromise + a forged older version YAML would otherwise be
    // accepted. Pin the channel to "latest" as well so a malicious
    // pre-release tag cannot redirect end users.
    u.allowDowngrade = false;
    u.channel = "latest";
    // 사용자 명시 클릭 전엔 다운로드 금지 — electron-updater의 default
    // (autoDownload=true) 를 끄지 않으면 checkForUpdates 가 새 버전을
    // 감지한 즉시 ~100MB 를 백그라운드로 받아버린다.
    u.autoDownload = false;
    u.on("update-available", (info) => {
      log.info("update-available: v%s", info.version);
      broadcast({ kind: "available", version: info.version });
    });
    u.on("update-not-available", (info) => {
      log.info("update-not-available: at v%s", info.version);
      // No state change — keep whatever the user last saw (e.g. a
      // previously-detected available update across reconnects).
    });
    u.on("download-progress", (p) => {
      // Only emit progress when we actually expect a user-gated download
      // to be in flight. If `lastState` is something else, electron-updater
      // is generating a spurious event (e.g., delta probe, blockmap fetch)
      // and we MUST NOT broadcast — otherwise the badge tooltip would
      // render "v 다운로드 중 — N%" with an empty version string (the
      // exact MAJOR finding from PR #876 review).
      if (lastState.kind !== "downloading" && lastState.kind !== "available") {
        return;
      }
      const version = (lastState as { version: string }).version;
      broadcast({ kind: "downloading", version, percent: Math.round(p.percent) });
    });
    u.on("update-downloaded", (info) => {
      log.info("update-downloaded: v%s", info.version);
      broadcast({ kind: "downloaded", version: info.version });
    });
    u.on("error", (err) => {
      log.warn("error (non-fatal): %s", err.message);
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
      log.warn("checkForUpdates failed: %s", (err as Error).message);
    }
  };

  // Renderer-initiated commands. Registered once at start(); removed at
  // stop() so a re-start (e.g. settings toggle on→off→on) doesn't double-
  // register. Both commands are no-ops when the updater module is
  // unavailable (dev mode, packaging gap) so the renderer can safely
  // fire-and-forget.
  const onDownloadNow = async (): Promise<{ ok: boolean; reason?: string }> => {
    const u = loadUpdater();
    if (!u) return { ok: false, reason: "updater-unavailable" };
    if (lastState.kind !== "available") {
      return { ok: false, reason: `not-available (state=${lastState.kind})` };
    }
    log.info("user-initiated download for v%s", lastState.version);
    // Promote state immediately so the badge flips to "다운로드 중…" even
    // before electron-updater emits the first progress event.
    const version = lastState.version;
    broadcast({ kind: "downloading", version, percent: 0 });
    try {
      await u.downloadUpdate();
      return { ok: true };
    } catch (err) {
      log.warn("downloadUpdate failed: %s", (err as Error).message);
      // Revert badge to "available" so the user can retry instead of being
      // stuck on a spinning "downloading…" state with no progress events.
      broadcast({ kind: "available", version });
      return { ok: false, reason: (err as Error).message };
    }
  };

  const onInstallNow = async (): Promise<{ ok: boolean; reason?: string }> => {
    const u = loadUpdater();
    if (!u) return { ok: false, reason: "updater-unavailable" };
    if (lastState.kind !== "downloaded") {
      return { ok: false, reason: `not-downloaded (state=${lastState.kind})` };
    }
    log.info("user-initiated install for v%s", lastState.version);
    try {
      // Fires quit-and-install on the next tick. Confirmation runs via
      // the separate `lvis:update:confirm-install` IPC (native dialog
      // shown from the main process) BEFORE the renderer invokes us, so
      // by the time we get here the user has already accepted.
      setImmediate(() => {
        try { u.quitAndInstall(); } catch (err) {
          log.warn("quitAndInstall failed: %s", (err as Error).message);
        }
      });
      return { ok: true };
    } catch (err) {
      log.warn("install scheduling failed: %s", (err as Error).message);
      return { ok: false, reason: (err as Error).message };
    }
  };

  /**
   * Native confirmation dialog shown via the main process. Replaces
   * `window.confirm()` which (a) blocks the renderer JS thread, (b)
   * shows a Chromium-style alert that doesn't respect window focus on
   * macOS, and (c) sets a bad precedent — every other destructive
   * confirm in this codebase goes through `dialog.showMessageBox`.
   *
   * Returns `{ confirmed: true }` only when the user clicks 재시작.
   * Cancel / Esc / window close → `{ confirmed: false }`.
   */
  const onConfirmInstall = async (): Promise<{ confirmed: boolean }> => {
    if (lastState.kind !== "downloaded") {
      return { confirmed: false };
    }
    try {
      const electron = _require("electron") as {
        dialog?: { showMessageBox?: (window: BrowserWindow | undefined, opts: unknown) => Promise<{ response: number }> };
      };
      if (typeof electron.dialog?.showMessageBox !== "function") {
        return { confirmed: false };
      }
      const result = await electron.dialog.showMessageBox(deps.mainWindow, {
        type: "question",
        buttons: ["취소", "재시작"],
        defaultId: 1,
        cancelId: 0,
        title: "업데이트 적용",
        message: `LVIS v${lastState.version} 으로 재시작합니다.`,
        detail: "진행 중인 작업이 종료됩니다. 계속하시겠습니까?",
      });
      return { confirmed: result.response === 1 };
    } catch (err) {
      log.warn("confirm-install dialog failed: %s", (err as Error).message);
      return { confirmed: false };
    }
  };

  const onGetState = (): UpdateState => lastState;

  // Defensive lazy-load of ipcMain — unit tests run outside Electron and
  // `import { ipcMain } from "electron"` resolves to a stub without `.handle`.
  // We load it only at start() time and skip registration entirely when the
  // API surface isn't available, so tests can call start() without crashing.
  let ipcRegistered = false;
  const loadIpcMain = (): IpcMain | null => {
    try {
      const m = _require("electron") as { ipcMain?: IpcMain };
      return typeof m.ipcMain?.handle === "function" ? m.ipcMain : null;
    } catch {
      return null;
    }
  };
  const registerIpc = () => {
    if (ipcRegistered) return;
    const ipc = loadIpcMain();
    if (!ipc) return;
    ipcRegistered = true;
    ipc.handle("lvis:update:download-now", onDownloadNow);
    ipc.handle("lvis:update:install-now", onInstallNow);
    ipc.handle("lvis:update:confirm-install", onConfirmInstall);
    ipc.handle("lvis:update:get-state", onGetState);
  };
  const unregisterIpc = () => {
    // Always clear the flag, even if loadIpcMain returns null — otherwise
    // a future start() would skip re-registration because the gate would
    // stay stuck on `true`.
    if (!ipcRegistered) return;
    ipcRegistered = false;
    const ipc = loadIpcMain();
    if (!ipc) return;
    ipc.removeHandler("lvis:update:download-now");
    ipc.removeHandler("lvis:update:install-now");
    ipc.removeHandler("lvis:update:confirm-install");
    ipc.removeHandler("lvis:update:get-state");
  };

  return {
    start() {
      if (timer) return;
      registerIpc();
      void triggerCheck();
      timer = setInterval(() => void triggerCheck(), CHECK_INTERVAL_MS);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      unregisterIpc();
    },
    triggerCheck,
    _testOnly: {
      downloadNow: onDownloadNow,
      installNow: onInstallNow,
      confirmInstall: onConfirmInstall,
      getState: onGetState,
    },
  };
}
