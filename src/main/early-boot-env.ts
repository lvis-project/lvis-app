/**
 * Early boot environment setup — the top-level side effects that MUST run at
 * module load, before `app.whenReady()`:
 *   - workspace cwd anchoring
 *   - plugin-asset custom protocol scheme registration
 *   - WSL / GPU command-line switches
 *   - app name + AppUserModelId
 *   - persisted host-resolver rules
 *   - packaged env scrub
 *
 * `src/main.ts` calls `runEarlyBootEnv()` once, near the top of its module
 * body, so the ordering relative to protocol registration and the whenReady
 * gate is identical to the previous inline sequence.
 */
import { app, protocol } from "electron";
import { createLogger } from "../lib/logger.js";
import { ensureWorkspaceCwd } from "./ensure-workspace-cwd.js";
import { registerPluginAssetProtocolScheme } from "./plugin-asset-protocol.js";
import { registerMcpAppProtocolScheme } from "./mcp-app-protocol.js";
import { applyManualHostResolverRules } from "./manual-host-resolver.js";
import { scrubPackagedProcessEnv } from "./packaged-env-scrub.js";
import { resolveAppIconPath } from "./app-icon.js";

const log = createLogger("lvis");

export function applyRuntimeAppIcon() {
  const iconPath = resolveAppIconPath();
  if (iconPath && process.platform === "darwin" && app.dock) {
    app.dock.setIcon(iconPath);
  }
}

export function runEarlyBootEnv(): void {
  const workspaceCwd = ensureWorkspaceCwd();
  log.info({ workspaceCwd }, "main: cwd anchored to ~/.lvis/workspace");

  registerPluginAssetProtocolScheme(protocol);
  // Must also happen before `app.ready` — the MCP-app sandbox-proxy document is
  // served from this scheme and needs `standard: true` for a real origin.
  registerMcpAppProtocolScheme(protocol);


  if (process.platform === "linux" && process.env.WSL_DISTRO_NAME) {
    app.commandLine.appendSwitch("enable-features", "UseOzonePlatform");
    if (process.env.WAYLAND_DISPLAY) {
      app.commandLine.appendSwitch("ozone-platform-hint", "wayland");
    } else if (process.env.DISPLAY) {
      app.commandLine.appendSwitch("ozone-platform-hint", "x11");
    }
  }
  // §GPU: Prevent the Chromium GPU utility process from spawning on corp/VDI
  // machines where restricted drivers produce repeated ContextResult::kFatalFailure
  // errors that eventually kill the renderer process (GPU-lost IPC → render-process-gone).
  // Must be called before app.whenReady(). The launch-script --disable-gpu flags only
  // stop renderer compositing; only disableHardwareAcceleration() stops the GPU process.
  // Linux packaged builds also prune Electron's GPU fallback libraries afterPack,
  // so dev and packaged Linux both use the same software-rendered path.
  // Mirror the same guard as scripts/run-electron.mjs: opt-out with LVIS_KEEP_GPU=1.
  if ((process.platform === "win32" || process.platform === "linux") && process.env.LVIS_KEEP_GPU !== "1") {
    app.disableHardwareAcceleration();
  }

  app.setName("LVIS");
  // Windows 10/11 OS notifications require an AppUserModelId — without this,
  // `new Notification(...)` toasts are silently dropped or grouped under the
  // generic "Electron" identity. Issue #260 NotificationService relies on this.
  // Safe to call on all platforms; non-Windows treats it as a no-op.
  app.setAppUserModelId("xyz.lvisai.app");

  // Trust-hardening — strip dev/test-only LVIS flags from process.env in packaged
  // builds before any preload, renderer, or worker inherits it. Without this
  // scrub, a packaged binary launched with LVIS_DEV=1 in the user environment
  // would expose `env.isDev=true` to the renderer (via preload's
  // contextBridge) and let UI code enable dev affordances. Renderer-side flags
  // are advisory rather than load-bearing for trust decisions, but allowing
  // them to flip in packaged builds creates a confusing forensic signal.
  //
  // Round-3: the prefix scrub now catches `LVIS_DEV_CONSOLE` (renamed from
  // `LVIS_ENABLE_DEV_CONSOLE`) automatically. `LVIS_WIN_NO_SANDBOX` is the
  // Windows-only sandbox bypass — it was previously named
  // `LVIS_DEV_NO_SANDBOX`, which made it incorrectly look like a dev flag;
  // the rename moves it out of the dev mask but it's still hard-gated on
  // `!app.isPackaged` by `dev-flags.ts:devNoSandboxAllowed()`.
  // Manual host-resolver map — applies the user-configured /etc/hosts-style
  // mapping when it is configured. It reads the same settings file the
  // SettingsService writes to (under app.getPath("userData")), so a map saved
  // through Settings is applied on the next boot.
  applyManualHostResolverRules(app, app.getPath("userData"));

  if (app.isPackaged) {
    scrubPackagedProcessEnv(process.env);
    // Force NODE_ENV=production in packaged builds so downstream gates
    // (preload `__lvisDevMode`, dev IPC, auto-compact runtime override) read
    // a reliable signal. Electron itself does not set NODE_ENV, so without
    // this an internal QA build with `NODE_ENV=development` leaking into the
    // env would expose dev affordances in shipped product.
    process.env.NODE_ENV = "production";
  }
}
