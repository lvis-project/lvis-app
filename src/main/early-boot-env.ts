/**
 * Early boot environment setup — the top-level side effects that MUST run at
 * module load, before `app.whenReady()`:
 *   - workspace cwd anchoring
 *   - plugin-asset custom protocol scheme registration
 *   - WSL / GPU command-line switches
 *   - app name + AppUserModelId
 *   - demo activation hydration + host-resolver rules
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
import { captureDemoCredentials } from "./demo-credentials.js";
import {
  loadEmbeddedDemoActivationSync,
  loadPersistedDemoActivationSync,
} from "./demo-activation-loader.js";
import { applyDemoHostResolverRules } from "./demo-host-resolver.js";
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

  // WSL 환경 대응
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
  // Demo activation code system — on packaged-app boot, if the user has
  // previously activated via the LoginModal chip 1 (paste activation string),
  // the decrypted `.env.demo` payload was persisted under
  // `~/.lvis/secrets/.env.demo`. Inject those values into `process.env` BEFORE
  // `captureDemoCredentials()` runs so the existing boot-time capture pipeline
  // observes them identically to a dev-mode `.env.demo` on disk. Sync I/O so
  // the capture sees the values without an awaited boot path.
  loadPersistedDemoActivationSync();
  // Internal-distribution builds embed an activation key in the bundle. When
  // no `.env.demo` was persisted yet (fresh install), hydrate from that
  // embedded key NOW — before `captureDemoCredentials()` + the host-resolver
  // install below — so a first activation needs no relaunch (the Chromium
  // host-resolver command line is frozen after `app.whenReady()`). No-op when
  // a persisted file exists, no key is embedded, or the user logged out
  // (demo-disabled sentinel). See loadEmbeddedDemoActivationSync.
  loadEmbeddedDemoActivationSync();
  // #893 / PR #894 B1 — Capture `LVIS_DEMO_*` BEFORE the scrub so the mockup
  // auth handler can still consume the demo keys + enable flag through an
  // internal channel, while the renderer/preload/workers never observe them
  // via inherited `process.env`. Capture is idempotent; the scrub below
  // runs unconditionally to close the env side-channel.
  captureDemoCredentials();
  // Path 2 hotfix — when `LVIS_DEMO_VENDOR=azure-foundry` and
  // `LVIS_DEMO_HOST_MAP` is non-empty, install a Chromium `host-resolver-rules`
  // switch so the demo Azure Foundry hostnames resolve to the internal
  // intranet IPs *inside Electron only* (no `/etc/hosts` mutation, no sudo).
  // MUST be called before `app.whenReady()` — done here so the switch is
  // installed before any network service initialisation. Also runs BEFORE
  // the env scrub for the same reason as `captureDemoCredentials()`: the
  // vendor + map env vars are wiped immediately after.
  applyDemoHostResolverRules(app);
  // Manual host-resolver map — applies the user-configured /etc/hosts-style
  // mapping when authMode==="manual". No-op when demo mode is active (demo
  // map takes precedence) or when no map has been configured. Reads the same
  // settings file the SettingsService writes to (under app.getPath("userData"))
  // so a map saved via Settings is the one applied on the next boot.
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
