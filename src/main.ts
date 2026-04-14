/**
 * LVIS App — Electron Main Process Entry
 *
 * 슬림 엔트리. 모든 로직은 boot.ts와 ipc-bridge.ts로 위임.
 * §4.1 Client Architecture 준수.
 */
import { Menu, app, BrowserWindow, type MenuItemConstructorOptions } from "electron";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrap, type AppServices } from "./boot.js";
import { registerIpcHandlers } from "./ipc-bridge.js";

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

// ⚠️⚠️⚠️ DEV-ONLY: corporate TLS interception 우회 (Phase 1.5 임시 — TODO §17)
//
// LG 사내망은 outbound HTTPS를 self-signed CA로 MITM 인터셉트한다. Node fetch는
// OS keystore를 읽지 않으므로 `SELF_SIGNED_CERT_IN_CHAIN` 으로 실패 (meeting STT,
// chat LLM, embedding 모두 동일). dev 단계 한정으로 검증을 끈다.
//
// **production build (app.isPackaged === true)에는 자동 미적용** —
// packaged 앱은 그대로 cert 검증 실패할 것이므로, Phase 2 진입 전에 반드시
// `mac-ca` / `win-ca` 등으로 OS keystore 런타임 추출 (Option B)로 교체.
// 자세한 내용: TODO.md §17.
if (!app.isPackaged) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  app.commandLine.appendSwitch("ignore-certificate-errors");
  console.warn("[lvis] ⚠️ DEV-ONLY: corporate TLS interception 우회 활성화");
  console.warn("[lvis]    - NODE_TLS_REJECT_UNAUTHORIZED=0 (Node fetch / main process)");
  console.warn("[lvis]    - --ignore-certificate-errors (Chromium / renderer)");
  console.warn("[lvis]    - 정식 대응: TODO.md §17 (OS keystore 통합 — Phase 2)");
}

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
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    show: true,
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: resolve(__dirname, "preload.cjs"),
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
