/**
 * LVIS App — Electron Main Process Entry
 *
 * 슬림 엔트리. 모든 로직은 boot.ts와 ipc-bridge.ts로 위임.
 * §4.1 Client Architecture 준수.
 */
import { Menu, app, BrowserWindow, shell, type MenuItemConstructorOptions } from "electron";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import * as https from "node:https";
import * as tls from "node:tls";
import { Agent, setGlobalDispatcher } from "undici";
import { fileURLToPath } from "node:url";
import { bootstrap, type AppServices } from "./boot.js";
import { registerIpcHandlers } from "./ipc-bridge.js";
import { ensureCorporateCa } from "./main/corp-ca-loader.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distRoot = resolve(__dirname, "..");
const projectRoot = resolve(distRoot, "..");

// WSL 환경 대응
if (process.platform === "linux" && process.env.WSL_DISTRO_NAME) {
  app.commandLine.appendSwitch("enable-features", "UseOzonePlatform");
  if (process.env.WAYLAND_DISPLAY) {
    app.commandLine.appendSwitch("ozone-platform-hint", "wayland");
  } else if (process.env.DISPLAY) {
    app.commandLine.appendSwitch("ozone-platform-hint", "x11");
  }
}
// app.disableHardwareAcceleration();

// §17 C1: 사내망 Corporate CA 런타임 주입 — corp-ca-loader 사용 (정식 대응 완료).
// Phase 1.5의 dev-only TLS bypass 완전 제거. Chromium은 OS keystore 자동 신뢰.
async function injectCorporateCa() {
  try {
    const result = await ensureCorporateCa();
    if (!result.pem) {
      console.warn("[lvis] corporate CA not found — 해외망 사용 중이거나 MDM 미배포. TLS 검증 기본값 유지.");
      return;
    }
    const ca = [...tls.rootCertificates, result.pem];
    // 1) undici (Node fetch / global dispatcher)
    setGlobalDispatcher(new Agent({ connect: { ca } }));
    // 2) https.globalAgent (legacy https.get / https.request)
    (https.globalAgent.options as Record<string, unknown>).ca = ca;
    // 3) tls.setDefaultCACertificates — Node 24 기준 미존재, 향후 확장 포인트
    console.log(`[lvis] corporate CA injected: source=${result.source} certs=${result.certCount} path=${result.path}`);
  } catch (e) {
    // 주입 실패해도 앱은 계속 실행 (해외망에서는 기본 CA로 충분)
    console.error("[lvis] corporate CA 주입 실패 (non-fatal):", (e as Error).message);
  }
}
await injectCorporateCa();

let mainWindow: BrowserWindow | null = null;
let services: AppServices | null = null;

function activateView(viewKey: string) {
  mainWindow?.webContents.send("lvis:view:activate", { viewKey });
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

function refreshApplicationMenu() {
  const template: MenuItemConstructorOptions[] =
    process.platform === "darwin"
      ? [
          { label: app.name, submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }] },
          createViewMenu(),
          { label: "편집", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }] },
          { label: "보기", submenu: [{ role: "reload" }, { role: "toggleDevTools" }] },
        ]
      : [createViewMenu()];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Bootstrap 동안 렌더러에 표시할 임시 splash HTML.
 * 실 index.html은 IPC 핸들러 등록 후에 로드된다 — 초기 useEffect IPC 호출이
 * 핸들러보다 앞서는 race 방지 (§M-race fix).
 */
const BOOTSTRAP_SPLASH = `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><title>LVIS</title>
<style>
  html,body{margin:0;height:100%;background:#0b0b10;color:#e4e4e8;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  .wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:.8rem}
  h1{margin:0;font-size:1.1rem;font-weight:600;letter-spacing:.02em}
  p{margin:0;font-size:.85rem;opacity:.65}
  .spin{width:24px;height:24px;border:2px solid #2a2a33;border-top-color:#7a7aff;border-radius:50%;animation:s 1s linear infinite}
  @keyframes s{to{transform:rotate(360deg)}}
</style></head><body><div class="wrap"><div class="spin"></div><h1>LVIS 초기 부팅 중</h1><p>Python 런타임과 플러그인을 준비하고 있습니다…</p></div></body></html>`;

function createWindow() {
  const preloadPath = resolve(__dirname, "preload.js");
  if (!existsSync(preloadPath)) {
    throw new Error(`[lvis] preload.js not found at ${preloadPath} — run 'npm run build:preload' first`);
  }

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    show: true,
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
    },
  });

  const win = mainWindow;
  win.webContents.openDevTools();

  win.once("ready-to-show", () => {
    console.log("[lvis] window ready-to-show");
    win.show();
    win.focus();
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error("[lvis] window failed to load", { code, desc, url });
  });

  // 외부 URL → 시스템 브라우저로 리다이렉트 (앱 내 탐색 방지)
  // window.open() 차단
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsedUrl = new URL(url);
      const allowedProtocols = new Set(["http:", "https:"]);

      if (allowedProtocols.has(parsedUrl.protocol)) {
        void shell.openExternal(parsedUrl.toString()).catch((err) => {
          console.error("[lvis] failed to open external URL", { url: parsedUrl.toString(), err });
        });
      } else {
        console.warn("[lvis] blocked external URL with disallowed protocol", {
          url,
          protocol: parsedUrl.protocol,
        });
      }
    } catch (err) {
      console.warn("[lvis] blocked invalid external URL", { url, err });
    }
    return { action: "deny" };
  });
  // <a href> 클릭 또는 location.href 변경으로 인한 탐색 차단
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://") && !url.startsWith("data:")) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  // §M-race: bootstrap 동안 splash만 표시. 실 index.html 로드는 main()이
  // IPC 핸들러 등록 후 수행.
  void win
    .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(BOOTSTRAP_SPLASH)}`)
    .catch((err) => console.error("[lvis] splash load failed", err));
}

async function main() {
  // §4.2 Step 8: window 생성 (splash 표시) — bootstrap이 mainWindow를 필요로 함
  createWindow();

  // §4.2 Boot Sequence (mainWindow 전달 — PythonRuntimeBootstrapper IPC 사용)
  services = await bootstrap(projectRoot, mainWindow!);

  // §4.1 IPC Bridge — 반드시 index.html 로드 전에 등록 (renderer useEffect race 방지)
  registerIpcHandlers(services, () => mainWindow);

  refreshApplicationMenu();

  // 실 UI 로드 — 이 시점부터 렌더러의 IPC 호출이 항상 handler와 매칭됨
  if (mainWindow) {
    try {
      await mainWindow.loadFile(resolve(__dirname, "index.html"));
    } catch (err) {
      console.error("[lvis] failed to load index.html", err);
    }
  }
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async () => {
  if (services) {
    await services.pluginRuntime.stopAll();
    services.taskService.close();
  }
});

app.whenReady().then(() => {
  void main().catch((error) => {
    console.error("[lvis] bootstrap failed", error);
    app.quit();
  });
});
