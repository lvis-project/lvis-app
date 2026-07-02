/**
 * Bootstrap splash — the temporary in-window HTML shown while boot runs.
 *
 * The real `index.html` is loaded only after IPC handlers are registered (so
 * the renderer's first `useEffect` IPC calls never race the handlers — §M-race
 * fix). The main process drives the splash status line directly from the boot
 * pipeline via `updateSplashStatus`, and enforces a minimum visible time so
 * the splash never flickers past on fast machines.
 */
import { t } from "../i18n/index.js";
import { LVIS_LOGO_PATH, LVIS_LOGO_VIEW_BOX } from "../shared/lvis-logo.js";
import { getLvisAppVersion } from "../shared/app-version.js";
import { getMainWindow } from "./app-state.js";

const BOOTSTRAP_STATUS_MESSAGES = [
  t("be_main.bootstrapStatus0"),
  t("be_main.bootstrapStatus1"),
  t("be_main.bootstrapStatus2"),
  t("be_main.bootstrapStatus3"),
  t("be_main.bootstrapStatus4"),
] as const;
const BOOTSTRAP_MESSAGE_MIN_VISIBLE_MS = 500;
const BOOTSTRAP_SPLASH_MIN_VISIBLE_MS = 500;
let bootstrapSplashShownAt = 0;

/** Record the moment the splash became visible (called from createWindow). */
export function markBootstrapSplashShown(): void {
  bootstrapSplashShownAt = Date.now();
}

export async function waitForMinimumBootstrapSplash() {
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
export const BOOTSTRAP_SPLASH = `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><title>LVIS</title>
<style>
  /* font-family mirrors HOST_FONT_STACK (src/shared/host-font-stack.ts) — issue #556. Inline minified
     form (no space after comma) is intentional for splash byte-budget; test invariant
     whitespace-normalizes before equality check. */
  html,body{margin:0;height:100%;background:#f3f3f3;color:#2c2c2c;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",sans-serif}
  body{overflow:hidden}

  /* Light shell (default) — cherry-blossom radial gradient + vivid red wordmark */
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
    color:rgba(44,44,44,.5);font-size:10px;line-height:1.35;
    font-variant-numeric:tabular-nums;letter-spacing:.02em;
    text-align:right;opacity:.85;
    display:flex;flex-direction:column;gap:1px;
  }
  .version span{display:block}

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
    .version{color:rgba(240,230,255,.5)}
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
  <div class="version" aria-label="${t("be_main.splashVersionLabel")}">
    <span>LVIS v${getLvisAppVersion()}</span>
    <span>Electron v${process.versions.electron ?? ""}</span>
    <span>Node v${process.versions.node ?? ""}</span>
    <span>Chromium v${process.versions.chrome ?? ""}</span>
    <span>V8 v${process.versions.v8 ?? ""}</span>
  </div>
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
export function updateSplashStatus(message: string): void {
  const mainWindow = getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const escaped = JSON.stringify(message);
  mainWindow.webContents
    .executeJavaScript(`window.__lvisSetSplashStatus && window.__lvisSetSplashStatus(${escaped})`)
    .catch(() => { /* splash window already replaced or page is mid-navigation */ });
}
