/**
 * LVIS App — Electron Main Process Entry
 *
 * 슬림 엔트리. 모든 로직은 boot.ts와 ipc-bridge.ts로 위임.
 * §4.1 Client Architecture 준수.
 */
import { Menu, Tray, app, BrowserWindow, ipcMain, shell, dialog, nativeImage, protocol, screen, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from "electron";
import { Buffer } from "node:buffer";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import * as https from "node:https";
import * as tls from "node:tls";
import { Agent, setGlobalDispatcher } from "undici";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bootstrap, type AppServices } from "./boot.js";
import {
  auditUnauthorized,
  getLastThemePayload,
  registerIpcHandlers,
  registerWindowEventListeners,
  unregisterPluginWebview,
  UNAUTHORIZED_FRAME,
  validateSender,
} from "./ipc-bridge.js";
import { sendToWindow } from "./ipc/safe-send.js";
import {
  INITIAL_THEME_ARG_PREFIX,
  INITIAL_THEME_ARG_MAX_BYTES,
  type InitialThemePrime,
} from "./shared/initial-theme.js";
import { ensureCorporateCa } from "./main/corp-ca-loader.js";
import { isAuthOwned } from "./main/auth-window-registry.js";
import { isLinkOwned } from "./main/link-window-registry.js";
import { shouldBlockGlobalWebviewNavigation } from "./main/webview-navigation-policy.js";
import { installHtmlPreviewPartitionBlock, installPluginPartitionPolicy } from "./main/html-preview-partition.js";
import { registerPluginAssetProtocolScheme } from "./main/plugin-asset-protocol.js";
import { findLvisProtocolUri, parseMarketplacePluginActionUri, parseMcpLoginUri, parsePluginAuthUri } from "./main/lvis-protocol.js";
import { buildDevProtocolArgs } from "./main/electron-protocol-args.js";
import { devNoSandboxAllowed, setIsPackaged } from "./boot/dev-flags.js";
import { emitEvent as emitHostEvent } from "./boot/types.js";
import { resolveAppIconPath } from "./main/app-icon.js";
import { WindowManager, type DetachedWindowOptions } from "./main/window-manager.js";
import { createLogger } from "./lib/logger.js";
import { LVIS_LOGO_PATH, LVIS_LOGO_VIEW_BOX } from "./shared/lvis-logo.js";
import { normalizeSettingsTab } from "./shared/settings-tabs.js";
import { preparePythonRuntimeForInstalledPlugin, withPluginInstallLock } from "./plugins/install-lifecycle.js";
import { ensureWorkspaceCwd } from "./main/ensure-workspace-cwd.js";
import { uninstallPluginWithLifecycle } from "./plugins/uninstall-lifecycle.js";
import { lvisHome } from "./shared/lvis-home.js";
import { runShutdownRoutines } from "./main/shutdown-routines.js";
import { captureDemoCredentials } from "./main/demo-credentials.js";
const log = createLogger("lvis");

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distRoot = resolve(__dirname, "..", "..");
const projectRoot = resolve(distRoot, "..");

const workspaceCwd = ensureWorkspaceCwd();
log.info({ workspaceCwd }, "main: cwd anchored to ~/.lvis/workspace");

registerPluginAssetProtocolScheme(protocol);

// Tab detach + magnetic snap — created before createWindow() so it is ready
// when the main window is registered.
let windowManager: WindowManager | null = null;

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

function applyRuntimeAppIcon() {
  const iconPath = resolveAppIconPath();
  if (iconPath && process.platform === "darwin" && app.dock) {
    app.dock.setIcon(iconPath);
  }
}

// Phase 1 trust-hardening — strip LVIS_DEV* from process.env in packaged
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
// #893 / PR #894 B1 — Capture `LVIS_DEMO_*` BEFORE the scrub so the mockup
// auth handler can still consume the demo keys + enable flag through an
// internal channel, while the renderer/preload/workers never observe them
// via inherited `process.env`. Capture is idempotent; the scrub below
// runs unconditionally to close the env side-channel.
captureDemoCredentials();

if (app.isPackaged) {
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith("LVIS_DEV") ||
      key.startsWith("LVIS_DEMO") ||
      key === "LVIS_WIN_NO_SANDBOX"
    ) {
      delete process.env[key];
    }
  }
  // Force NODE_ENV=production in packaged builds so downstream gates
  // (preload `__lvisDevMode`, dev IPC, auto-compact runtime override) read
  // a reliable signal. Electron itself does not set NODE_ENV, so without
  // this an internal QA build with `NODE_ENV=development` leaking into the
  // env would expose dev affordances in shipped product.
  process.env.NODE_ENV = "production";
}

// §17 C1: Corporate CA 런타임 주입 — corp-ca-loader 사용 (정식 대응 완료).
// Phase 1.5의 dev-only TLS bypass 완전 제거. Chromium은 OS keystore 자동 신뢰.
async function injectCorporateCa() {
  try {
    const result = await ensureCorporateCa();
    if (!result.pem) {
      log.warn("corporate CA not found — 해외망 사용 중이거나 MDM 미배포. TLS 검증 기본값 유지.");
      return;
    }
    const ca = [...tls.rootCertificates, result.pem];
    // 1) undici (Node fetch / global dispatcher)
    setGlobalDispatcher(new Agent({ connect: { ca } }));
    // 2) https.globalAgent (legacy https.get / https.request)
    (https.globalAgent.options as Record<string, unknown>).ca = ca;
    // 3) tls.setDefaultCACertificates — Node 24 기준 미존재, 향후 확장 포인트
    log.info(`corporate CA injected: source=${result.source} certs=${result.certCount} path=${result.path}`);
  } catch (e) {
    // 주입 실패해도 앱은 계속 실행 (해외망에서는 기본 CA로 충분)
    log.error("corporate CA 주입 실패 (non-fatal): %s", errorMessage(e));
  }
}

let corporateCaReady: Promise<void> | null = null;
function ensureCorporateCaInjected(): Promise<void> {
  corporateCaReady ??= injectCorporateCa();
  return corporateCaReady;
}

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
// Holds the most-recently requested tab while the settings window's renderer
// is still loading. Flushed once on `did-finish-load`; any later tab requests
// after the renderer is ready are sent immediately via IPC. See the rapid
// second-invoke race the renderer review surfaced.
let settingsWindowPendingTab: string | null = null;
let services: AppServices | null = null;
let pendingLvisUri: string | null = null;
let lastRendererReloadAt = 0;
let rendererReloadReady = false;
let pendingRendererReload = false;
let appShutdownStarted = false;
let appShutdownCompleted = false;

const MAIN_WINDOW_WIDTH = 460;
const MAIN_WINDOW_HEIGHT = 840;
const MAIN_WINDOW_MIN_WIDTH = 460;
const MAIN_WINDOW_MIN_HEIGHT = 640;
const MAIN_WINDOW_TOP_GAP = 24;
const MAIN_WINDOW_RIGHT_GAP = 10;
const SETTINGS_WINDOW_WIDTH = 1040;
const SETTINGS_WINDOW_HEIGHT = 760;
const SETTINGS_WINDOW_MIN_WIDTH = 820;
const SETTINGS_WINDOW_MIN_HEIGHT = 560;
const rendererIndexUrl = () => pathToFileURL(resolve(__dirname, "..", "index.html")).toString();

function initialMainWindowBounds(): { x: number; y: number; width: number; height: number } {
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.max(MAIN_WINDOW_MIN_WIDTH, Math.min(MAIN_WINDOW_WIDTH, workArea.width));
  const height = Math.max(MAIN_WINDOW_MIN_HEIGHT, Math.min(MAIN_WINDOW_HEIGHT, workArea.height));
  const rightGap = width < workArea.width ? MAIN_WINDOW_RIGHT_GAP : 0;
  return {
    x: workArea.x + workArea.width - width - rightGap,
    y: workArea.y + Math.min(MAIN_WINDOW_TOP_GAP, Math.max(0, workArea.height - height)),
    width,
    height,
  };
}

/**
 * W1.0 — `--plugin-smoke=<id1>,<id2>,...` CLI flag.
 *
 * Verifies that the named plugins mount + init correctly during boot, then
 * exits 0 (success) or 1 (any plugin missing / failed to initialize). Used
 * by per-plugin smoke tests in CI and by the Cycle 2 verification gate.
 *
 * Returns null if the flag is not present.
 */
function parsePluginSmokeFlag(argv: readonly string[]): string[] | null {
  for (const arg of argv) {
    if (arg.startsWith("--plugin-smoke=")) {
      const raw = arg.slice("--plugin-smoke=".length);
      const ids = raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return ids;
    }
  }
  return null;
}

const pluginSmokeIds = parsePluginSmokeFlag(process.argv);

/**
 * Diagnostic log gate — diagnostic console output is dev-only. Packaged
 * builds skip these noisy traces so end-user log files stay clean.
 *
 * Intentionally NOT routed through `dev-flags.ts:isDevModeUnlocked()`:
 * those helpers require an explicit LVIS_DEV* opt-in to enable, but the
 * lvis:// protocol diagnostic flow needs to be debuggable on every
 * unpackaged dev session without forcing the operator to flip an env var.
 * The `app.isPackaged` boundary alone is the right level for log-only
 * output (no trust decisions ride on these calls).
 */
const lvisDevLog = (msg: string, obj?: object) => {
  if (app.isPackaged) return;
  if (obj !== undefined) log.info(obj, msg);
  else log.info(msg);
};
const lvisDevWarn = (msg: string, obj?: object) => {
  if (app.isPackaged) return;
  if (obj !== undefined) log.warn(obj, msg);
  else log.warn(msg);
};

async function resolveMarketplaceActionTarget(
  activeServices: AppServices,
  slug: string,
): Promise<{ pluginId: string; name: string; installed?: boolean; isManaged?: boolean }> {
  try {
    const catalogItems = await activeServices.pluginMarketplace.list();
    const item = catalogItems.find((candidate) => candidate.id === slug || candidate.slug === slug);
    return {
      pluginId: item?.id ?? slug,
      name: item?.name ?? slug,
      installed: item?.installed,
      isManaged: item?.isManaged,
    };
  } catch (err) {
    lvisDevWarn("[lvis] marketplace target lookup failed; falling back to slug", {
      slug,
      error: errorMessage(err),
    });
    return { pluginId: slug, name: slug };
  }
}

type MarketplacePackageType = "plugin" | "mcp" | "agent" | "skill";

function marketplacePackageLabel(packageType: MarketplacePackageType): string {
  if (packageType === "agent") return "에이전트";
  if (packageType === "skill") return "스킬";
  if (packageType === "mcp") return "MCP 서버";
  return "플러그인";
}

function assistantPackageChannels(packageType: "agent" | "skill"): {
  installProgress: string;
  installResult: string;
  uninstallResult: string;
} {
  const ns = packageType === "agent" ? "agents" : "skills";
  return {
    installProgress: `lvis:${ns}:install-progress`,
    installResult: `lvis:${ns}:install-result`,
    uninstallResult: `lvis:${ns}:uninstall-result`,
  };
}

async function handleAssistantMarketplaceAction(
  activeServices: AppServices,
  win: BrowserWindow,
  params: { action: "install" | "uninstall"; slug: string; packageType: "agent" | "skill" },
): Promise<void> {
  const channels = assistantPackageChannels(params.packageType);
  const label = marketplacePackageLabel(params.packageType);
  const target = await resolveMarketplaceActionTarget(activeServices, params.slug);
  if (params.action === "uninstall") {
    if (target.installed === false) {
      await dialog.showMessageBox(win, {
        type: "info",
        buttons: ["확인"],
        defaultId: 0,
        cancelId: 0,
        message: `${label} '${target.name}'은(는) 설치되어 있지 않습니다.`,
        detail: "외부 링크의 제거 요청을 처리하지 않았습니다.",
      });
      broadcastPluginLifecycleEvent(channels.uninstallResult, {
        slug: params.slug,
        success: false,
        error: `${label} not installed`,
      });
      return;
    }
    const { response } = await dialog.showMessageBox(win, {
      type: "warning",
      buttons: ["제거", "취소"],
      defaultId: 1,
      cancelId: 1,
      message: `${label} '${target.name}'을(를) 제거하시겠습니까?`,
      detail: "외부 링크로부터 요청된 제거입니다.",
    });
    if (response !== 0) return;
    void (async () => {
      if (params.packageType === "agent") {
        const { uninstallAgentPackage } = await import("./agents/agent-installer.js");
        const result = await uninstallAgentPackage(params.slug, {
          installRoot: resolve(lvisHome(), "agents"),
          registryPath: resolve(lvisHome(), "agents", "registry.json"),
        });
        emitHostEvent("agent.uninstalled", { agentId: result.agentId, slug: result.slug, source: "marketplace" });
        broadcastPluginLifecycleEvent(channels.uninstallResult, {
          slug: result.slug,
          agentId: result.agentId,
          success: true,
        });
        return;
      }
      const { uninstallSkillPackage } = await import("./skills/skill-installer.js");
      const result = await uninstallSkillPackage(params.slug, {
        installRoot: resolve(lvisHome(), "skills"),
        registryPath: resolve(lvisHome(), "skills", "registry.json"),
      });
      emitHostEvent("skill.uninstalled", { skillId: result.skillId, slug: result.slug, source: "marketplace" });
      broadcastPluginLifecycleEvent(channels.uninstallResult, {
        slug: result.slug,
        skillId: result.skillId,
        success: true,
      });
    })().catch((err: Error) => {
      log.error({ slug: params.slug, packageType: params.packageType, error: err.message, stack: err.stack }, "lvis:// assistant package uninstall failed");
      broadcastPluginLifecycleEvent(channels.uninstallResult, {
        slug: params.slug,
        success: false,
        error: err.message,
      });
    });
    return;
  }

  const { response } = await dialog.showMessageBox(win, {
    type: "question",
    buttons: ["설치", "취소"],
    defaultId: 1,
    cancelId: 1,
    message: `${label} '${target.name}'을(를) 설치하시겠습니까?`,
    detail: "외부 링크로부터 요청된 설치입니다.",
  });
  if (response !== 0) return;
  broadcastPluginLifecycleEvent(channels.installProgress, { slug: params.slug, phase: "installing" });
  void (async () => {
    if (params.packageType === "agent") {
      if (!activeServices.agentArtifactStore) {
        throw new Error("Agent marketplace install is unavailable: marketplace backend is disabled in this build.");
      }
      const { installAgentPackageFromMarketplace } = await import("./agents/agent-installer.js");
      const result = await installAgentPackageFromMarketplace(params.slug, {
        fetcher: activeServices.pluginMarketplace.getFetcher(),
        store: activeServices.agentArtifactStore,
        registryPath: resolve(lvisHome(), "agents", "registry.json"),
        onProgress: (evt) => {
          if (evt.phase === "downloading") {
            broadcastPluginLifecycleEvent(channels.installProgress, {
              slug: params.slug,
              phase: "downloading",
              bytesDownloaded: evt.bytesDownloaded,
              bytesTotal: evt.bytesTotal,
            });
          } else {
            broadcastPluginLifecycleEvent(channels.installProgress, { slug: params.slug, phase: evt.phase });
          }
        },
      });
      emitHostEvent("agent.installed", { agentId: result.agentId, slug: result.slug, source: "marketplace" });
      broadcastPluginLifecycleEvent(channels.installResult, {
        slug: result.slug,
        agentId: result.agentId,
        success: true,
      });
      return;
    }
    if (!activeServices.skillArtifactStore) {
      throw new Error("Skill marketplace install is unavailable: marketplace backend is disabled in this build.");
    }
    const { installSkillPackageFromMarketplace } = await import("./skills/skill-installer.js");
    const result = await installSkillPackageFromMarketplace(params.slug, {
      fetcher: activeServices.pluginMarketplace.getFetcher(),
      store: activeServices.skillArtifactStore,
      registryPath: resolve(lvisHome(), "skills", "registry.json"),
      onProgress: (evt) => {
        if (evt.phase === "downloading") {
          broadcastPluginLifecycleEvent(channels.installProgress, {
            slug: params.slug,
            phase: "downloading",
            bytesDownloaded: evt.bytesDownloaded,
            bytesTotal: evt.bytesTotal,
          });
        } else {
          broadcastPluginLifecycleEvent(channels.installProgress, { slug: params.slug, phase: evt.phase });
        }
      },
    });
    emitHostEvent("skill.installed", { skillId: result.skillId, slug: result.slug, source: "marketplace" });
    broadcastPluginLifecycleEvent(channels.installResult, {
      slug: result.slug,
      skillId: result.skillId,
      success: true,
    });
  })().catch((err: Error) => {
    log.error({ slug: params.slug, packageType: params.packageType, error: err.message, stack: err.stack }, "lvis:// assistant package install failed");
    broadcastPluginLifecycleEvent(channels.installResult, {
      slug: params.slug,
      success: false,
      error: err.message,
    });
  });
}

async function handleMcpMarketplaceAction(
  activeServices: AppServices,
  win: BrowserWindow,
  params: { action: "install" | "uninstall"; slug: string },
): Promise<void> {
  const label = marketplacePackageLabel("mcp");
  const target = await resolveMarketplaceActionTarget(activeServices, params.slug);
  if (params.action === "uninstall") {
    const { response } = await dialog.showMessageBox(win, {
      type: "warning",
      buttons: ["제거", "취소"],
      defaultId: 1,
      cancelId: 1,
      message: `${label} '${target.name}'을(를) 제거하시겠습니까?`,
      detail: "외부 링크로부터 요청된 제거입니다.",
    });
    if (response !== 0) return;
    void activeServices.mcpManager.removeConfig(params.slug).catch((err: Error) => {
      log.error({ slug: params.slug, error: err.message, stack: err.stack }, "lvis:// MCP uninstall failed");
    });
    return;
  }
  const { response } = await dialog.showMessageBox(win, {
    type: "question",
    buttons: ["설치", "취소"],
    defaultId: 1,
    cancelId: 1,
    message: `${label} '${target.name}'을(를) 설치하시겠습니까?`,
    detail: "외부 링크로부터 요청된 설치입니다.",
  });
  if (response !== 0) return;
  void (async () => {
    if (!activeServices.mcpArtifactStore) {
      throw new Error("MCP marketplace install is unavailable: marketplace backend is disabled in this build.");
    }
    const { installMcpFromMarketplace } = await import("./mcp/mcp-marketplace-install.js");
    const result = await installMcpFromMarketplace(params.slug, {
      fetcher: activeServices.pluginMarketplace.getFetcher(),
      store: activeServices.mcpArtifactStore,
      pythonPath: activeServices.pythonPath,
    });
    await activeServices.mcpManager.addConfig(result.config);
  })().catch((err: Error) => {
    log.error({ slug: params.slug, error: err.message, stack: err.stack }, "lvis:// MCP install failed");
  });
}

async function handleMcpLoginAction(
  activeServices: AppServices,
  win: BrowserWindow,
  params: { slug: string },
): Promise<void> {
  const existingConfigs = await activeServices.mcpManager.getConfigs().catch(() => []);
  if (existingConfigs.some((config) => config.id === params.slug)) {
    openSettingsWindow("mcp");
    return;
  }
  const target = await resolveMarketplaceActionTarget(activeServices, params.slug);

  const { response } = await dialog.showMessageBox(win, {
    type: "question",
    buttons: ["설치 후 설정 열기", "취소"],
    defaultId: 1,
    cancelId: 1,
    message: `MCP '${target.name}' 로그인을 준비하시겠습니까?`,
    detail:
      "OAuth 로그인을 위해 먼저 MCP 서버를 설치하고 연결 설정을 등록합니다. 토큰이나 인증 코드는 마켓플레이스 manifest에 저장되지 않습니다.",
  });
  if (response !== 0) return;

  void (async () => {
    if (!activeServices.mcpArtifactStore) {
      throw new Error("MCP marketplace login is unavailable: marketplace backend is disabled in this build.");
    }
    const { installMcpFromMarketplace } = await import("./mcp/mcp-marketplace-install.js");
    const result = await installMcpFromMarketplace(params.slug, {
      fetcher: activeServices.pluginMarketplace.getFetcher(),
      store: activeServices.mcpArtifactStore,
      pythonPath: activeServices.pythonPath,
    });
    await activeServices.mcpManager.addConfig(result.config);
    openSettingsWindow("mcp");
  })().catch((err: Error) => {
    log.error({ slug: params.slug, error: err.message, stack: err.stack }, "lvis:// MCP login failed");
  });
}

async function handleLvisUri(url: string) {
  lvisDevLog("[lvis] handleLvisUri called", { url });

  // Route generic plugin OAuth callback (`lvis://plugin-auth/<pluginId>?code=<code>`)
  // to a host event so the matching plugin can exchange the code.
  // Validation lives in parsePluginAuthUri — bad URIs silently drop
  // (DoS / probing defense). Plain-text `code` MUST NOT be logged.
  const authParams = parsePluginAuthUri(url);
  if (authParams) {
    lvisDevLog("[lvis] handleLvisUri: plugin auth callback received", {
      pluginId: authParams.pluginId,
      codeLength: authParams.code.length,
    });
    emitHostEvent("plugin.auth.code.received", {
      pluginId: authParams.pluginId,
      code: authParams.code,
    });
    return;
  }

  const mcpLoginParams = parseMcpLoginUri(url);
  if (mcpLoginParams) {
    lvisDevLog("[lvis] handleLvisUri: MCP login URI parsed", {
      slug: mcpLoginParams.slug,
      servicesReady: !!services,
    });
    if (!services) {
      pendingLvisUri = url;
      return;
    }
    const activeServices = services;
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow({ showBootstrapSplash: false });
      if (mainWindow) registerMainWindowPluginEventBridge(mainWindow);
      try {
        if (mainWindow) await loadMainInterface(mainWindow, "lvis-uri-mcp-login");
      } catch (err) {
        log.error({ err }, "failed to load index.html for lvis:// MCP login URI");
      }
    }
    mainWindow?.focus();
    const win = mainWindow;
    if (!win) {
      log.warn(`handleLvisUri: no window available, aborting MCP login for ${mcpLoginParams.slug}`);
      return;
    }
    await handleMcpLoginAction(activeServices, win, mcpLoginParams);
    return;
  }

  const params = parseMarketplacePluginActionUri(url);
  if (!params) {
    lvisDevWarn("[lvis] handleLvisUri: parseMarketplacePluginActionUri returned null", { url });
    return;
  }
  lvisDevLog("[lvis] handleLvisUri parsed", {
    action: params.action,
    slug: params.slug,
    packageType: params.packageType,
    servicesReady: !!services,
  });
  if (!services) {
    lvisDevLog("[lvis] handleLvisUri: services not ready, queueing", {
      action: params.action,
      slug: params.slug,
      packageType: params.packageType,
    });
    pendingLvisUri = url;
    return;
  }
  const activeServices = services;
  // macOS: app stays running after all windows closed. If the deep link arrives
  // with no window, re-open one so the confirmation dialog has a parent and the
  // user actually sees the install prompt (rather than it silently no-op'ing).
  if (!mainWindow || mainWindow.isDestroyed()) {
    lvisDevLog("[lvis] handleLvisUri: recreating window");
    createWindow({ showBootstrapSplash: false });
    if (mainWindow) registerMainWindowPluginEventBridge(mainWindow);
    try {
      if (mainWindow) await loadMainInterface(mainWindow, "lvis-uri-recreate");
    } catch (err) {
      log.error({ err }, "failed to load index.html for lvis:// URI");
    }
  }
  mainWindow?.focus();
  const win = mainWindow;
  if (!win) {
    // createWindow() failed or was destroyed — abort rather than install silently.
    log.warn(`handleLvisUri: no window available, aborting ${params.action}`);
    return;
  }
  if (params.packageType === "agent" || params.packageType === "skill") {
    await handleAssistantMarketplaceAction(activeServices, win, {
      action: params.action,
      slug: params.slug,
      packageType: params.packageType,
    });
    return;
  }
  if (params.packageType === "mcp") {
    await handleMcpMarketplaceAction(activeServices, win, {
      action: params.action,
      slug: params.slug,
    });
    return;
  }
  if (params.action === "uninstall") {
    const target = await resolveMarketplaceActionTarget(activeServices, params.slug);
    if (target.isManaged) {
      await dialog.showMessageBox(win, {
        type: "warning",
        buttons: ["확인"],
        defaultId: 0,
        cancelId: 0,
        message: `플러그인 '${target.name}'은(는) 제거할 수 없습니다.`,
        detail: "관리자가 설치한 플러그인은 사용자 요청으로 제거할 수 없습니다.",
      });
      broadcastPluginLifecycleEvent("lvis:plugins:uninstall-result", {
        slug: target.pluginId,
        success: false,
        error: "Admin plugin cannot be uninstalled by user",
      });
      return;
    }
    if (target.installed === false) {
      await dialog.showMessageBox(win, {
        type: "info",
        buttons: ["확인"],
        defaultId: 0,
        cancelId: 0,
        message: `플러그인 '${target.name}'은(는) 설치되어 있지 않습니다.`,
        detail: "외부 링크의 제거 요청을 처리하지 않았습니다.",
      });
      broadcastPluginLifecycleEvent("lvis:plugins:uninstall-result", {
        slug: target.pluginId,
        success: false,
        error: "Plugin not installed",
      });
      return;
    }
    lvisDevLog("[lvis] handleLvisUri: showing uninstall confirmation dialog", {
      slug: params.slug,
      pluginId: target.pluginId,
    });
    const { response } = await dialog.showMessageBox(win, {
      type: "warning",
      buttons: ["제거", "취소"],
      defaultId: 1,
      cancelId: 1,
      message: `플러그인 '${target.name}'을(를) 제거하시겠습니까?`,
      detail: "외부 링크로부터 요청된 제거입니다. 플러그인 파일, 로컬 데이터, 설정, 저장된 비밀값, 기록된 로그인 세션이 삭제됩니다.",
    });
    lvisDevLog("[lvis] handleLvisUri: uninstall dialog response", {
      slug: params.slug,
      pluginId: target.pluginId,
      response,
    });
    if (response !== 0) return;
    void (async () => {
      const result = await uninstallPluginWithLifecycle(target.pluginId, {
        pluginMarketplace: activeServices.pluginMarketplace,
        pluginRuntime: activeServices.pluginRuntime,
        settingsService: activeServices.settingsService,
        pluginPaths: activeServices.pluginPaths,
        clearAuthPartitionService: activeServices.clearAuthPartitionService,
        listPluginAuthPartitionsService: activeServices.listPluginAuthPartitionsService,
        forgetPluginAuthPartitionsService: activeServices.forgetPluginAuthPartitionsService,
        refreshPluginNotifications: activeServices.refreshPluginNotifications,
        emitHostEvent,
        log,
      });
      broadcastPluginLifecycleEvent("lvis:plugins:uninstall-result", {
        slug: result.pluginId,
        success: true,
      });
    })().catch((err: Error) => {
      log.error({ slug: params.slug, error: err.message, stack: err.stack }, "lvis:// uninstall failed");
      broadcastPluginLifecycleEvent("lvis:plugins:uninstall-result", {
        slug: params.slug,
        success: false,
        error: err.message,
      });
    });
    return;
  }

  lvisDevLog("[lvis] handleLvisUri: showing confirmation dialog", { slug: params.slug });
  const { response } = await dialog.showMessageBox(win, {
    type: "question",
    buttons: ["설치", "취소"],
    defaultId: 1,
    cancelId: 1,
    message: `플러그인 '${params.slug}'을(를) 설치하시겠습니까?`,
    detail: "외부 링크로부터 요청된 설치입니다.",
  });
  lvisDevLog("[lvis] handleLvisUri: dialog response", { slug: params.slug, response });
  if (response !== 0) return;
  lvisDevLog("[lvis] handleLvisUri: starting install", { slug: params.slug });
  // Renderer renders a skeleton card while these phase events fire — see
  // PluginConfigTab + plugin grid progress UI.
  broadcastPluginLifecycleEvent("lvis:plugins:install-progress", { slug: params.slug, phase: "installing" });
  void (async () => {
    const catalogItems = await activeServices.pluginMarketplace.list();
    const installLockId =
      catalogItems.find((item) => item.id === params.slug || item.slug === params.slug)?.id ?? params.slug;
    return await withPluginInstallLock(installLockId, async () => {
      const result = await activeServices.pluginMarketplace.install(params.slug, "user", (evt) => {
        if (evt.phase === "downloading") {
          broadcastPluginLifecycleEvent("lvis:plugins:install-progress", {
            slug: params.slug,
            phase: "downloading",
            bytesDownloaded: evt.bytesDownloaded,
            bytesTotal: evt.bytesTotal,
          });
        } else {
          broadcastPluginLifecycleEvent("lvis:plugins:install-progress", { slug: params.slug, phase: evt.phase });
        }
      });
      const pluginId = result.pluginId;
      lvisDevLog("[lvis] handleLvisUri: install succeeded", { slug: pluginId });
      // Mirror the post-install steps from the lvis:plugins:install IPC handler
      // so deep-link installs behave identically to in-app installs.
      try {
        broadcastPluginLifecycleEvent("lvis:plugins:install-progress", { slug: pluginId, phase: "restarting" });
        await preparePythonRuntimeForInstalledPlugin(pluginId, {
          pythonRuntime: activeServices.pythonRuntime,
          pluginRuntime: activeServices.pluginRuntime,
          getMainWindow: () => mainWindow,
        });
        // US-A3 — single-plugin lifecycle: only the deep-link-installed
        // plugin starts up. Other plugins keep their in-memory state.
        await activeServices.pluginRuntime.addPlugin(pluginId);
        emitHostEvent("plugin.installed", { pluginId, source: "marketplace" });
        activeServices.refreshPluginNotifications?.();
      } catch (err) {
        const message = errorMessage(err) || "addPlugin failed";
        log.error({ pluginId, err }, "post-install steps failed for lvis:// install");
        try {
          await activeServices.pluginRuntime.removePlugin(pluginId).catch((rmPluginErr) => {
            log.warn(
              { pluginId, rmPluginErr },
              "lvis:// install rollback removePlugin failed",
            );
          });
          await activeServices.pluginMarketplace.uninstall(pluginId);
        } catch (rollbackErr) {
          log.warn(
            { pluginId, rollbackErr },
            "lvis:// install rollback uninstall failed",
          );
        }
        broadcastPluginLifecycleEvent("lvis:plugins:install-result", { slug: pluginId, success: false, error: message });
        return;
      }
      broadcastPluginLifecycleEvent("lvis:plugins:install-result", { slug: pluginId, success: true });
    });
  })().catch((err: Error) => {
    log.error({ slug: params.slug, error: err.message, stack: err.stack }, "lvis:// install failed");
    broadcastPluginLifecycleEvent("lvis:plugins:install-result", { slug: params.slug, success: false, error: err.message });
  });
}

function activateView(viewKey: string) {
  mainWindow?.webContents.send("lvis:view:activate", { viewKey });
}

function broadcastPluginLifecycleEvent(channel: string, payload: unknown): void {
  for (const win of getAppWindows()) {
    sendToWindow(win, channel, payload, log);
  }
}

function createViewMenu() {
  if (!services) return { label: "플러그인", submenu: [] as MenuItemConstructorOptions[] };
  const pluginViews = services.pluginRuntime
    .listUiExtensions()
    .filter((item) => item.extension.slot === "sidebar")
    .map((item) => ({
      key: `plugin:${item.pluginId}:${item.extension.id}`,
      label: item.extension.displayName?.trim() || item.extension.title || item.pluginId,
    }));
  return {
    label: "플러그인",
    submenu: [
      { label: "홈", click: () => activateView("home") },
      ...pluginViews.map((item) => ({
        label: item.label,
        click: () => activateView(item.key),
      })),
    ],
  };
}

function detachedWindowOptionsForViewKey(viewKey: string): DetachedWindowOptions | undefined {
  if (!services || !viewKey.startsWith("plugin:")) return undefined;
  const [, pluginId, extensionId, extra] = viewKey.split(":");
  if (!pluginId || !extensionId || extra !== undefined) return undefined;
  const view = services.pluginRuntime
    .listUiExtensions()
    .find((item) => item.pluginId === pluginId && item.extension.id === extensionId);
  return view?.extension.window;
}

function createSettingsMenuItem(): MenuItemConstructorOptions {
  return {
    label: "설정...",
    accelerator: "CommandOrControl+,",
    click: () => {
      openSettingsWindow("llm");
    },
  };
}

function isMainWindowAlwaysOnTop(): boolean {
  return mainWindow !== null && !mainWindow.isDestroyed() && mainWindow.isAlwaysOnTop();
}

function registerMainWindowPluginEventBridge(win: BrowserWindow): void {
  services?.registerPluginEventBridge?.(win);
}

function showOrCreateMainWindow(reason: string): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showMainWindow(mainWindow);
    refreshApplicationMenu();
    refreshTrayMenu();
    return;
  }
  createWindow({ showBootstrapSplash: false });
  if (mainWindow) registerMainWindowPluginEventBridge(mainWindow);
  if (mainWindow && rendererReloadReady) {
    void loadMainInterface(mainWindow, reason).finally(() => {
      refreshApplicationMenu();
      refreshTrayMenu();
    });
  }
  refreshApplicationMenu();
  refreshTrayMenu();
}

function refreshTrayMenu(): void {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: "LVIS 열기",
      click: () => showOrCreateMainWindow("tray-open"),
    },
    { type: "separator" },
    createAlwaysOnTopMenuItem(),
    createSettingsMenuItem(),
    { type: "separator" },
    { label: "종료", role: "quit" },
  ]));
}

function createTrayIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${LVIS_LOGO_VIEW_BOX}"><path fill="#f8fafc" d="${LVIS_LOGO_PATH}"/></svg>`;
  const icon = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
  const resized = icon.isEmpty() ? icon : icon.resize({ width: 18, height: 18 });
  if (process.platform === "darwin") {
    resized.setTemplateImage(true);
  }
  return resized;
}

function ensureTray(): void {
  if (tray) return;
  tray = new Tray(createTrayIcon());
  tray.setToolTip("LVIS");
  tray.on("click", () => showOrCreateMainWindow("tray-click"));
  tray.on("double-click", () => showOrCreateMainWindow("tray-double-click"));
  refreshTrayMenu();
}

function createAlwaysOnTopMenuItem(): MenuItemConstructorOptions {
  return {
    label: "항상 위에",
    type: "checkbox",
    checked: isMainWindowAlwaysOnTop(),
    click: () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.setAlwaysOnTop(!isMainWindowAlwaysOnTop());
      refreshApplicationMenu();
      refreshTrayMenu();
    },
  };
}

function createDisplayMenu(): MenuItemConstructorOptions {
  return {
    label: "보기",
    submenu: [
      { role: "reload" },
      { type: "separator" },
      createAlwaysOnTopMenuItem(),
    ],
  };
}

function createEditMenu(): MenuItemConstructorOptions {
  return {
    label: "편집",
    submenu: [
      { role: "undo", label: "실행 취소" },
      { role: "redo", label: "다시 실행" },
      { type: "separator" },
      { role: "cut", label: "잘라내기" },
      { role: "copy", label: "복사" },
      { role: "paste", label: "붙여넣기" },
      { role: "pasteAndMatchStyle", label: "서식 없이 붙여넣기" },
      { role: "delete", label: "삭제" },
      { type: "separator" },
      { role: "selectAll", label: "전체 선택" },
    ],
  };
}

function refreshApplicationMenu() {
  const settingsMenuItem = createSettingsMenuItem();
  const editMenu = createEditMenu();
  const displayMenu = createDisplayMenu();
  const template: MenuItemConstructorOptions[] =
    process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              createAlwaysOnTopMenuItem(),
              settingsMenuItem,
              { type: "separator" },
              { role: "quit" },
            ],
          },
          editMenu,
          createViewMenu(),
          displayMenu,
        ]
      : [
          { label: "앱", submenu: [createAlwaysOnTopMenuItem(), settingsMenuItem, { type: "separator" }, { role: "quit" }] },
          editMenu,
          createViewMenu(),
          displayMenu,
        ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function loadMainInterface(win: BrowserWindow, reason: string) {
  if (win.isDestroyed()) return;
  try {
    await win.loadFile(resolve(__dirname, "..", "index.html"));
    pendingRendererReload = false;
    showMainWindow(win);
    log.info({ reason }, "main interface loaded");
  } catch (err) {
    log.error({ reason, err }, "failed to load index.html");
  }
}

function showMainWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.moveTop();
}

function getAppWindows(): BrowserWindow[] {
  const seen = new Set<number>();
  const windows = [
    mainWindow,
    settingsWindow,
    ...(windowManager?.getDetachedWindows() ?? []),
  ];
  return windows.filter((win): win is BrowserWindow => {
    if (!win || win.isDestroyed() || seen.has(win.id)) return false;
    seen.add(win.id);
    return true;
  });
}

function settingsWindowUrl(initialTab: string): string {
  return `${rendererIndexUrl()}#settings/${encodeURIComponent(initialTab)}`;
}

function isSettingsWindowUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const expected = new URL(rendererIndexUrl());
    return (
      parsed.protocol === "file:" &&
      parsed.origin === expected.origin &&
      parsed.pathname === expected.pathname &&
      parsed.hash.startsWith("#settings/")
    );
  } catch {
    return false;
  }
}

function openSettingsWindow(initialTabInput: unknown = "llm"): BrowserWindow {
  const initialTab = normalizeSettingsTab(initialTabInput);
  const preloadPath = resolve(__dirname, "..", "preload.cjs");
  if (!existsSync(preloadPath)) {
    throw new Error(`[lvis] preload.cjs not found at ${preloadPath} — run 'npm run build:preload' first`);
  }

  if (settingsWindow && !settingsWindow.isDestroyed()) {
    // If the renderer is still loading, the IPC listener isn't attached yet
    // and `webContents.send` would be lost. Park the tab so the existing
    // `did-finish-load` flusher can deliver it; otherwise send immediately.
    if (settingsWindow.webContents.isLoading()) {
      settingsWindowPendingTab = initialTab;
    } else {
      settingsWindow.webContents.send("lvis:settings-window:tab", { initialTab });
    }
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }

  settingsWindow = new BrowserWindow({
    width: SETTINGS_WINDOW_WIDTH,
    height: SETTINGS_WINDOW_HEIGHT,
    minWidth: SETTINGS_WINDOW_MIN_WIDTH,
    minHeight: SETTINGS_WINDOW_MIN_HEIGHT,
    show: false,
    title: "LVIS 설정",
    icon: resolveAppIconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
      preload: preloadPath,
      // Settings window must paint its first frame against the active bundle
      // tokens — without this the dialog flashes the default-bundle palette
      // until ThemeProvider's async hydrate lands. Same mechanism as main
      // and detached windows (architecture.md §6.7.1 "race window = 0").
      additionalArguments: initialThemeArgs(),
    },
  });
  // Keep the hidden application menu attached so standard Edit-role
  // accelerators (Cmd/Ctrl+C/V/X/A/Z) continue to work in settings inputs.
  // `autoHideMenuBar` preserves the chrome-free settings-window appearance.

  const win = settingsWindow;
  registerWindowEventListeners(win);

  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });
  win.on("closed", () => {
    if (settingsWindow === win) settingsWindow = null;
    settingsWindowPendingTab = null;
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    log.error({ code, desc, url }, "settings window failed to load");
  });
  // Drain any tab requests queued while the renderer was loading. The initial
  // URL fragment already lands us on the right tab for the FIRST open; this
  // covers a rapid second `openSettingsWindow(differentTab)` invocation before
  // the renderer's IPC listener has attached.
  win.webContents.once("did-finish-load", () => {
    if (settingsWindowPendingTab && !win.isDestroyed()) {
      win.webContents.send("lvis:settings-window:tab", { initialTab: settingsWindowPendingTab });
      settingsWindowPendingTab = null;
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") {
        void shell.openExternal(parsedUrl.toString()).catch((err) => {
          log.error({ url: parsedUrl.toString(), err }, "failed to open external URL from settings window");
        });
      }
    } catch (err) {
      log.warn({ url, err }, "blocked invalid settings window URL");
    }
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (details) => {
    const url = details.url;
    if (isSettingsWindowUrl(url)) return;
    details.preventDefault();
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") {
        void shell.openExternal(parsedUrl.toString()).catch((err) => {
          log.error({ url: parsedUrl.toString(), err }, "failed to open external URL from settings window navigation");
        });
        return;
      }
      log.warn({ url }, "blocked settings window navigation");
    } catch (err) {
      log.warn({ url, err }, "blocked invalid settings window navigation");
    }
  });

  void win.loadURL(settingsWindowUrl(initialTab));
  return win;
}

function registerSettingsWindowHandlers(auditLogger: AppServices["auditLogger"]): void {
  ipcMain.handle("lvis:settings-window:open", (event: IpcMainInvokeEvent, initialTab: unknown) => {
    if (!validateSender(event)) {
      auditUnauthorized(auditLogger, "lvis:settings-window:open", event);
      return UNAUTHORIZED_FRAME;
    }
    try {
      const win = openSettingsWindow(initialTab);
      return { ok: true, windowId: win.id };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle("lvis:settings-window:saved", (event: IpcMainInvokeEvent) => {
    if (!validateSender(event)) {
      auditUnauthorized(auditLogger, "lvis:settings-window:saved", event);
      return UNAUTHORIZED_FRAME;
    }
    // Broadcast to every app-owned window (main + detached) so any consumer
    // — not just the main window — can react to a settings save. Same scope
    // as the SETTINGS.updated state broadcast; this `saved` signal is the
    // discrete "save committed, you may close" event vs. the state diff.
    for (const win of getAppWindows()) {
      if (win === settingsWindow) continue; // sender skip — settings window initiated and closes itself
      win.webContents.send("lvis:settings-window:saved");
    }
    return { ok: true };
  });
}

const BOOTSTRAP_STATUS_MESSAGES = [
  "런타임을 준비하는 중...",
  "사용자 설정과 메모리를 불러오는 중...",
  "플러그인 무결성을 확인하는 중...",
  "마켓플레이스와 동기화하는 중...",
  "작업 화면을 여는 중...",
] as const;
const BOOTSTRAP_MESSAGE_MIN_VISIBLE_MS = 500;
const BOOTSTRAP_SPLASH_MIN_VISIBLE_MS = BOOTSTRAP_MESSAGE_MIN_VISIBLE_MS;
let bootstrapSplashShownAt = 0;

async function waitForMinimumBootstrapSplash() {
  if (bootstrapSplashShownAt <= 0) return;
  const remaining = BOOTSTRAP_SPLASH_MIN_VISIBLE_MS - (Date.now() - bootstrapSplashShownAt);
  if (remaining > 0) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, remaining));
  }
}

/**
 * Bootstrap 동안 렌더러에 표시할 임시 splash HTML.
 * 실 index.html은 IPC 핸들러 등록 후에 로드된다 — 초기 useEffect IPC 호출이
 * 핸들러보다 앞서는 race 방지 (§M-race fix).
 */
const BOOTSTRAP_SPLASH = `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><title>LVIS</title>
<style>
  /* font-family mirrors HOST_FONT_STACK (src/shared/host-font-stack.ts) — issue #556. Inline minified
     form (no space after comma) is intentional for splash byte-budget; test invariant
     whitespace-normalizes before equality check. */
  html,body{margin:0;height:100%;background:#f3f3f3;color:#2c2c2c;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",sans-serif}
  body{overflow:hidden}

  /* Light shell (default) — cherry-blossom radial gradient + LG vivid red wordmark */
  .wrap{
    box-sizing:border-box;display:flex;align-items:center;justify-content:center;
    min-height:100vh;padding:28px;
    background:radial-gradient(circle at 62% 34%,rgba(255,255,255,.94),rgba(255,220,228,.74) 34%,rgba(255,180,198,.68) 68%,rgba(255,255,255,.82));
    background-size:cover;
    opacity:0;
    animation:lvis-splash-enter 220ms ease-out 60ms both;
  }
  .panel{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px}
  /* Logo sits cleanly above the wordmark — no overlap. (The previous
     translateY(-26px) + margin:-20px combo, and the first cleanup that
     used margin-bottom:-14px, both produced too much overlap with the
     "LVIS" wordmark passing through the logo's chin area.) */
  .logo{
    width:96px;height:auto;
    filter:drop-shadow(0 8px 18px rgba(217,0,255,.18));
    animation:lvis-splash-breathing 2.6s ease-in-out infinite;
    transform-origin:center;
  }
  .name{margin:0;color:#ef0b4c;font-size:26px;font-weight:650;line-height:1;letter-spacing:0}
  .status{min-height:18px;margin:8px 0 0;color:rgba(239,11,76,.62);font-size:12px;line-height:18px;text-align:center;transition:opacity .25s ease}
  .dots{display:flex;gap:6px;margin-top:10px}
  .dot{
    width:6px;height:6px;border-radius:999px;background:#ef0b4c;opacity:.32;
    animation:lvis-splash-bounce 1.1s ease-in-out infinite;
  }
  .dot:nth-child(2){animation-delay:.18s}
  .dot:nth-child(3){animation-delay:.36s}
  .version{
    position:fixed;right:14px;bottom:10px;
    color:rgba(44,44,44,.34);font-size:10.5px;
    font-variant-numeric:tabular-nums;letter-spacing:.02em;
  }

  @keyframes lvis-splash-enter{from{opacity:0}to{opacity:1}}
  @keyframes lvis-splash-breathing{0%,100%{transform:scale(1)}50%{transform:scale(1.035)}}
  @keyframes lvis-splash-bounce{0%,100%{opacity:.32;transform:translateY(0)}45%{opacity:1;transform:translateY(-4px)}}

  /* Dark OS preference — keeps the brand red mark but swaps the gradient
     to a deep plum so the splash doesn't flash bright before a dark
     bundle paints in the renderer. */
  @media (prefers-color-scheme: dark){
    html,body{background:#0d0a14;color:#f0e6ff}
    .wrap{background:radial-gradient(circle at 62% 34%,rgba(70,28,52,.92),rgba(80,30,55,.82) 34%,rgba(50,18,42,.86) 68%,rgba(18,10,28,.96))}
    .name{color:#ff5b8f}
    .status{color:rgba(255,141,178,.72)}
    .dot{background:#ff5b8f}
    .version{color:rgba(240,230,255,.32)}
  }

  /* Reduced motion — disable scale, breathing, bounce; keep entrance fade only */
  @media (prefers-reduced-motion: reduce){
    .wrap{animation:lvis-splash-enter 150ms ease-out both}
    .logo{animation:none}
    .dot{animation:none;opacity:.5}
  }
</style></head><body>
  <div class="wrap">
    <div class="panel" role="status" aria-live="polite">
      <svg class="logo" viewBox="${LVIS_LOGO_VIEW_BOX}" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
        <path d="${LVIS_LOGO_PATH}" fill="url(#lvisSplashLogo)" />
        <defs>
          <linearGradient id="lvisSplashLogo" x1="50.1574" y1="-3.85755" x2="181.301" y2="235.331" gradientUnits="userSpaceOnUse">
            <stop stop-color="#FF0000" />
            <stop offset="1" stop-color="#D900FF" />
          </linearGradient>
        </defs>
      </svg>
      <h1 class="name">LVIS</h1>
      <p id="status" class="status">${BOOTSTRAP_STATUS_MESSAGES[0]}</p>
      <div class="dots" aria-hidden="true"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
    </div>
  </div>
  <div class="version">v${app.getVersion()}</div>
  <script>
    const messages = ${JSON.stringify(BOOTSTRAP_STATUS_MESSAGES)};
    const statusEl = document.getElementById("status");
    let cycleI = 0;
    let cycleTimer = null;
    let overridden = false;

    /* Main process can drive status directly at real boot-phase transitions.
       When called, the idle cycle stops so the splash text never "jitters"
       backwards once the bootstrap pipeline starts reporting. */
    window.__lvisSetSplashStatus = (msg) => {
      overridden = true;
      if (statusEl && typeof msg === "string") statusEl.textContent = msg;
      if (cycleTimer) { clearInterval(cycleTimer); cycleTimer = null; }
    };

    /* Fallback idle cycle for the gap between main()'s phase emits.
       Bounded so it doesn't outlive the splash. */
    cycleTimer = setInterval(() => {
      if (overridden) return;
      cycleI = (cycleI + 1) % messages.length;
      if (statusEl) statusEl.textContent = messages[cycleI];
    }, ${BOOTSTRAP_MESSAGE_MIN_VISIBLE_MS});

    window.addEventListener("beforeunload", () => {
      if (cycleTimer) clearInterval(cycleTimer);
    });
  </script>
</body></html>`;

/** Push a status message to the splash window from the main process.
 *  Best-effort — silently no-ops if the splash has already navigated away
 *  to the real renderer or if executeJavaScript rejects. */
function updateSplashStatus(message: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const escaped = JSON.stringify(message);
  mainWindow.webContents
    .executeJavaScript(`window.__lvisSetSplashStatus && window.__lvisSetSplashStatus(${escaped})`)
    .catch(() => { /* splash window already replaced or page is mid-navigation */ });
}

/**
 * Build the `webPreferences.additionalArguments` strings that carry the
 * host's currently cached `lastThemePayload` into every new BrowserWindow.
 *
 * The preload script parses these on document-start, applies tokens to
 * `documentElement` (frame-0 paint correct), and exposes the payload as
 * `window.__lvisInitialTheme` so ThemeProvider can init synchronously
 * without racing the renderer's first `notifyPluginTheme` broadcast. See
 * `architecture.md` §6.7.1.
 *
 * Returns `[]` when no payload is cached yet (cold-boot first window) OR
 * when the serialized payload exceeds `INITIAL_THEME_ARG_MAX_BYTES` —
 * either case is harmless because the renderer's async hydrate path
 * remains in effect.
 */
function initialThemeArgs(): string[] {
  const payload = getLastThemePayload();
  if (!payload) return [];
  // Narrow projection to `InitialThemePrime` — the three fields that drive
  // frame-0 paint. `colorScheme` / `reducedMotion` / `fonts` are renderer-
  // only and hydrate from settings.json a few ms later, so embedding them in
  // argv is pure overhead.
  const prime: InitialThemePrime = {
    bundleId: payload.bundleId,
    shell: payload.shell,
    ...(payload.tokens ? { tokens: payload.tokens } : {}),
  };
  let serialized: string;
  try {
    serialized = JSON.stringify(prime);
  } catch {
    return [];
  }
  if (serialized.length > INITIAL_THEME_ARG_MAX_BYTES) return [];
  return [`${INITIAL_THEME_ARG_PREFIX}${serialized}`];
}

function createWindow(options: { showBootstrapSplash?: boolean } = {}) {
  const showBootstrapSplash = options.showBootstrapSplash ?? true;
  const preloadPath = resolve(__dirname, "..", "preload.cjs");
  if (!existsSync(preloadPath)) {
    throw new Error(`[lvis] preload.cjs not found at ${preloadPath} — run 'npm run build:preload' first`);
  }

  mainWindow = new BrowserWindow({
    ...initialMainWindowBounds(),
    minWidth: MAIN_WINDOW_MIN_WIDTH,
    minHeight: MAIN_WINDOW_MIN_HEIGHT,
    show: true,
    icon: resolveAppIconPath(),
    autoHideMenuBar: false,
    // ─── Cross-platform titlebar ─────────────────────────────────────────
    // macOS: keep native frame so traffic-light buttons render via the OS;
    //        hiddenInset shifts content area below the traffic lights.
    // Win/Linux: remove native frame entirely — CustomTitleBar.tsx renders
    //            our own minimize/maximize/close buttons in the renderer.
    frame: process.platform !== "darwin" ? false : undefined,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    // x=14 keeps existing left inset; y=12 vertically centers the 12px lights
    // inside the 36px CustomTitleBar (see CustomTitleBar.tsx darwin branch).
    trafficLightPosition: process.platform === "darwin" ? { x: 14, y: 12 } : undefined,
    // ─────────────────────────────────────────────────────────────────────
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox:false required for Node built-ins (node:path, node:url) in preload.cjs
      sandbox: false,
      // render_html tool renders LLM-produced HTML inside an Electron
      // <webview>. The webview runs on its own webContents / OS process so
      // a malicious or runaway payload (e.g. `while(true){}`) can't freeze
      // the main UI. The <webview> tag is gated by webPreferences.webviewTag.
      webviewTag: true,
      preload: preloadPath,
      // Pass the host's cached lastThemePayload to the renderer so
      // ThemeProvider can init from frame 0. See initialThemeArgs() above.
      additionalArguments: initialThemeArgs(),
    },
  });

  const win = mainWindow;

  // Register with WindowManager so snap logic can track the main window.
  if (windowManager) {
    windowManager.registerMainWindow(win);
  }

  // Attach maximize / fullscreen broadcast listeners. These must be registered
  // on every new BrowserWindow instance (initial boot, macOS re-activation,
  // and any recovery path). The IPC handlers in ipc-bridge.ts look up the
  // current window via getMainWindow() at call-time, but win.on() bindings
  // are instance-specific and are lost when a new window object is created.
  registerWindowEventListeners(win);

  // Development debugging is provided by the renderer-side eruda console
  // (LVIS_DEV_CONSOLE=1). Do not auto-open native Chromium DevTools: it
  // changes the runtime viewport and makes UI regressions look different
  // from the real app window.

  win.once("ready-to-show", () => {
    log.info("window ready-to-show");
    showMainWindow(win);
  });
  win.on("close", (event) => {
    if (appShutdownStarted || appShutdownCompleted || !tray || win.isDestroyed()) return;
    event.preventDefault();
    win.hide();
    refreshApplicationMenu();
    refreshTrayMenu();
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
    refreshApplicationMenu();
    refreshTrayMenu();
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    log.error({ code, desc, url }, "window failed to load");
  });
  // Recovery: if the renderer crashes (e.g. GPU-lost after GPU utility failure),
  // reload index.html. IPC handlers are registered on the main-process side and
  // survive a renderer restart — the reloaded renderer reconnects automatically.
  win.webContents.on("render-process-gone", (_e, details) => {
    log.error({ details }, "main window renderer process gone");
    if (!rendererReloadReady) {
      pendingRendererReload = true;
      log.warn("renderer reload deferred until bootstrap + IPC registration complete");
      return;
    }
    const now = Date.now();
    if (!win.isDestroyed() && now - lastRendererReloadAt > 3000) {
      lastRendererReloadAt = now;
      void loadMainInterface(win, "render-process-gone");
    } else if (!win.isDestroyed()) {
      log.warn("render-process-gone reload suppressed to avoid crash loop");
    }
  });

  // 외부 URL → 시스템 브라우저로 리다이렉트 (앱 내 탐색 방지)
  // window.open() 차단
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsedUrl = new URL(url);
      const allowedProtocols = new Set(["http:", "https:"]);

      if (allowedProtocols.has(parsedUrl.protocol)) {
        void shell.openExternal(parsedUrl.toString()).catch((err) => {
          log.error({ url: parsedUrl.toString(), err }, "failed to open external URL");
        });
      } else {
        log.warn({
          url,
          protocol: parsedUrl.protocol,
        }, "blocked external URL with disallowed protocol");
      }
    } catch (err) {
      log.warn({ url, err }, "blocked invalid external URL");
    }
    return { action: "deny" };
  });
  // <a href> 클릭 또는 location.href 변경으로 인한 탐색 차단.
  // Electron 24+ exposes the URL on `details.url`; the legacy positional
  // `url` arg is deprecated and arrives empty on Electron 41.x, so we read
  // the canonical event payload only.
  win.webContents.on("will-navigate", (details) => {
    const url = details.url;
    if (!url.startsWith("file://") && !url.startsWith("data:")) {
      details.preventDefault();
      void shell.openExternal(url);
    }
  });

  if (showBootstrapSplash) {
    // §M-race: bootstrap 동안 splash만 표시. 실 index.html 로드는 main()이
    // IPC 핸들러 등록 후 수행.
    bootstrapSplashShownAt = Date.now();
    void win
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(BOOTSTRAP_SPLASH)}`)
      .then(() => showMainWindow(win))
      .catch((err) => log.error({ err }, "splash load failed"));
  }
}

async function main() {
  // Initialise WindowManager before createWindow so registerMainWindow() can
  // be called synchronously inside createWindow().
  const preloadPath = resolve(__dirname, "..", "preload.cjs");
  windowManager = new WindowManager({
    preloadPath,
    distRoot,
    getInitialThemeArgs: initialThemeArgs,
    resolveDetachedWindowOptions: detachedWindowOptionsForViewKey,
  });

  // §4.2 Step 8: window 생성 (splash 표시) — bootstrap이 mainWindow를 필요로 함
  createWindow();

  updateSplashStatus("네트워크 인증서를 확인하는 중...");
  await ensureCorporateCaInjected();

  // Drive splash status from the real bootstrap pipeline so the text below
  // the wordmark matches what's actually happening rather than cycling
  // through a setInterval list. The fallback idle cycle inside the splash
  // still runs until the first explicit update lands.
  updateSplashStatus("사용자 설정과 메모리를 불러오는 중...");

  // §4.2 Boot Sequence (mainWindow 전달 — PythonRuntimeBootstrapper IPC 사용)
  services = await bootstrap(projectRoot, mainWindow!, () => mainWindow);

  updateSplashStatus("작업 화면을 여는 중...");

  // W1.0 — `--plugin-smoke=<id,...>` exits early after verifying that the
  // named plugins mounted + initialized. Boot already awaited
  // pluginRuntime.startAll(); here we just confirm the named ids are loaded.
  if (pluginSmokeIds !== null) {
    const loadedIds = new Set(services.pluginRuntime.listPluginIds());
    const missing = pluginSmokeIds.filter((id) => !loadedIds.has(id));
    if (missing.length > 0) {
      log.error(
        "plugin-smoke: %d/%d plugins missing: %s",
        missing.length,
        pluginSmokeIds.length,
        missing.join(","),
      );
      app.exit(1);
      return;
    }
    log.info(`all ${pluginSmokeIds.length} plugins initialized`);
    app.exit(0);
    return;
  }

  // Window IPC handlers registered after bootstrap so auditLogger is available
  // for validateSender + viewKey security guards added in PR #354 follow-up.
  windowManager.registerIpc(services.auditLogger);

  // §4.1 IPC Bridge — 반드시 index.html 로드 전에 등록 (renderer useEffect race 방지)
  registerIpcHandlers(
    services,
    () => mainWindow,
    getAppWindows,
  );
  registerSettingsWindowHandlers(services.auditLogger);

  // L1: start the routines scheduler AFTER IPC handlers are wired so a
  // routine past-due at boot fires into a renderer that already has a
  // `lvis:routines:v2:fired` listener attached. The scheduler is otherwise
  // safe to start at any time — `start()` is idempotent.
  services.startRoutinesScheduler?.();

  refreshApplicationMenu();
  ensureTray();
  rendererReloadReady = true;

  // 실 UI 로드 — 이 시점부터 렌더러의 IPC 호출이 항상 handler와 매칭됨
  if (mainWindow) {
    if (!pendingRendererReload) await waitForMinimumBootstrapSplash();
    await loadMainInterface(mainWindow, pendingRendererReload ? "bootstrap-recovery" : "bootstrap-complete");
  }

  // Process any lvis:// URI that arrived before services were ready.
  // Deferred until after loadFile so IPC handlers are registered and the
  // renderer's lvis:plugins:install-result listener is active.
  if (pendingLvisUri) {
    void handleLvisUri(pendingLvisUri);
    pendingLvisUri = null;
  }
}

// render_html tool webview hardening — the <webview> element carries LLM
// authored HTML. It loads a data: URL and must never navigate anywhere else
// (a click on <a href="…"> would bypass the injected meta CSP by moving to a
// new document). Deny every non-data navigation and new-window attempt on
// any webview webContents as soon as it's created.
// lvis:// custom URI scheme — register before app ready.
// In dev mode (unpackaged) on Windows, Electron requires explicit execPath + args
// so the OS can locate the app correctly when launching from a protocol URI.
// We must also propagate the running process's --user-data-dir so the OS-spawned
// instance lands on the same userData and the single-instance lock actually
// gates it. Without this, dev (Electron-LVIS-Dev) and the protocol-launched
// process land on different userData dirs and both apps coexist.
//
// Argument-builder lives in `src/main/electron-protocol-args.ts` (pure helper)
// so the platform / argv / env policy can be unit-tested without Electron.
//
// `LVIS_WIN_NO_SANDBOX` is read through `dev-flags.ts` SoT instead of by the
// helper itself: the helper takes a resolved `disableSandbox: boolean` so the
// `!app.isPackaged` policy gate cannot be bypassed by a packaged binary that
// inherits the env var. Boot also calls `setIsPackaged` later for any other
// dev-flag callers; this top-level call early-seeds the cache.
setIsPackaged(app.isPackaged);
const _protocolRegistered = app.isPackaged
  ? app.setAsDefaultProtocolClient("lvis")
  : app.setAsDefaultProtocolClient(
      "lvis",
      process.execPath,
      buildDevProtocolArgs({
        argv1: process.argv[1],
        userDataDir: app.getPath("userData") || undefined,
        platform: process.platform,
        disableGpu: process.env.LVIS_KEEP_GPU !== "1",
        disableSandbox: devNoSandboxAllowed(),
      }),
    );
if (!_protocolRegistered) {
  log.warn("setAsDefaultProtocolClient('lvis') failed — deep links may not work in this environment");
}

// macOS: URI delivered via open-url event (register before whenReady to avoid missing cold-start)
app.on("open-url", (event, url) => {
  event.preventDefault();
  void handleLvisUri(url);
});

// Windows/Linux: URI delivered as argv of second instance
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  // We are NOT the primary instance — quit immediately and let the existing
  // primary handle the protocol URL via its `second-instance` listener.
  // Do NOT run bootstrap on this doomed process: pino-pretty's thread-stream
  // worker exits with the process, and the first `log.info(...)` afterwards
  // would throw "the worker has exited" — Electron surfaces that as an
  // uncaught-exception dialog the user sees during marketplace plugin
  // install. Quitting before `whenReady` keeps the second-instance exit
  // silent. Regression guard: `src/__tests__/main-single-instance-gate.test.ts`.
  app.quit();
} else {
  const coldStartUri = findLvisProtocolUri(process.argv);
  if (coldStartUri) {
    pendingLvisUri = coldStartUri;
  }
  app.on("second-instance", (_event, argv) => {
    // Redact `--user-data-dir=<absolute path>` before logging — the path
    // contains the OS username and on shared/VDI/corp boxes that's PII that
    // would otherwise land in screenshots, support bundles, and stdout
    // capture tools.
    const safeArgv = argv.map((a) =>
      a.startsWith("--user-data-dir=") ? "--user-data-dir=<redacted>" : a,
    );
    lvisDevLog("[lvis] second-instance event fired", { argv: safeArgv });
    const url = findLvisProtocolUri(argv);
    lvisDevLog("[lvis] second-instance URL extracted", { url });
    if (url) void handleLvisUri(url);
    if (mainWindow) {
      showMainWindow(mainWindow);
    }
  });

  // whenReady is scoped to the primary-instance branch — second-instance
  // processes must NOT run main(). See the comment on `app.quit()` above.
  app.whenReady().then(() => {
    applyRuntimeAppIcon();
    installHtmlPreviewPartitionBlock();
    void main().catch((error) => {
      log.error({ err: error }, "bootstrap failed");
      app.quit();
    });
  });
}

app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() !== "webview") return;

  // Eagerly install the partition network policy at attach time —
  // BEFORE the first navigation lands. The previous `did-navigate`
  // hook ran AFTER the first request, leaving a TOCTOU window where
  // the plugin shell document itself escaped the file://-only allow
  // list. `installPluginPartitionPolicy` is idempotent so re-installs
  // on the same partition are no-ops.
  //
  // BUG (#498): `contents.session.partition` is undocumented and returns
  // `undefined` on current Electron, so this guard never matches and
  // `setPreloads` is never called → plugin webviews load without the
  // `lvisPlugin` contextBridge → shell aborts with "lvisPlugin bridge
  // missing". The proper fix pre-registers the policy at boot for every
  // known plugin partition (see `boot/steps/plugin-runtime.ts`); the
  // attach-time hook here is kept for the case where the partition wasn't
  // pre-registered (defensive only).
  const partitionName = (contents.session as unknown as { partition?: string }).partition;
  if (typeof partitionName === "string" && partitionName.startsWith("persist:plugin:")) {
    installPluginPartitionPolicy(partitionName);
  }

  // Plugin webview lifecycle: clean up the (webContents.id → pluginId)
  // registry entry on destroy so a stale id can't be reused for an
  // unrelated future webContents. `render-process-gone` covers the case
  // where the underlying renderer process crashes (sandbox kill, OOM,
  // GPU lost) — Electron does not always emit `destroyed` synchronously
  // afterwards, so we clear the binding eagerly.
  const dropBinding = () => unregisterPluginWebview(contents.id);
  contents.on("destroyed", dropBinding);
  contents.on("render-process-gone", dropBinding);

  contents.on("will-navigate", (navEvent) => {
    // Plugin webview policy: allow file:// navigations ONLY into the app's
    // dist/src directory (plugin-ui-shell.html + plugin entry modules
    // resolved by the shell). The previous substring match on ".js" or
    // "plugin-ui-shell" let any local .js file load — treat that as LFI
    // and reject. LLM-HTML webviews (different consumer) keep the
    // data:/about: only fallback below.
    //
    // URL must come from the canonical `navEvent.url` payload. Electron 41.x
    // empties the deprecated positional `url` arg, so reading it would crash
    // here and bypass the security check entirely.
    const url = navEvent.url;
    const currentUrl = contents.getURL();
    // Auth and external-link viewer webviews load remote http(s) pages under
    // scoped per-window policies. Keep the global guard deny-by-default for
    // every unregistered webview.
    if (shouldBlockGlobalWebviewNavigation({
      url,
      currentUrl,
      distRoot,
      authOwned: isAuthOwned(contents),
      linkOwned: isLinkOwned(contents),
    })) {
      navEvent.preventDefault();
    }
  });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
});

app.on("child-process-gone", (_event, details) => {
  log.error({
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    serviceName: details.serviceName ?? "",
    name: details.name ?? "",
  }, "child process gone");
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// macOS: re-create window on Dock icon click when all windows are closed.
// Re-register the plugin event bridge for the new window (Issue 5).
app.on("activate", () => {
  showOrCreateMainWindow("activate");
});

app.on("before-quit", (event) => {
  if (!services || appShutdownCompleted) return;
  if (appShutdownStarted) {
    event.preventDefault();
    return;
  }
  appShutdownStarted = true;
  event.preventDefault();
  // Capture services in a local so TypeScript narrowing survives the async
  // closure boundary, and so a future window-closed handler that nulls
  // `services` mid-shutdown cannot NPE us on the next member access.
  const svc = services;
  void (async () => {
    try {
      // v2 shutdown routines — fire all active shutdown-trigger routines with a
      // 5s timeout so a hung LLM call cannot block app.quit() indefinitely.
      await runShutdownRoutines(svc);
      await svc.shutdown?.();
      await svc.pluginRuntime.stopAll();
      windowManager?.persistAll();
    } finally {
      appShutdownCompleted = true;
      app.quit();
    }
  })();
});
