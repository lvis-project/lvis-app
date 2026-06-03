/**
 * window-titlebar-shell — shared HTML+CSS template builder for the LVIS
 * BrowserWindow header chrome.
 *
 * Used by:
 *   - `src/main/auth-window-service.ts`  — login flow shells
 *   - `src/main/link-window-service.ts`  — external link viewer shells
 *
 * The main app window uses the React `CustomTitleBar` component; auth and
 * link windows can't easily mount a React tree (they load a `data:` URL
 * or an external URL inside a `<webview>`), so this module emits the
 * equivalent visual contract as a CSS+HTML string that both data-URL
 * shells can splice into their templates.
 *
 * Theme: light by default, with `@media (prefers-color-scheme: dark)`
 * overrides so dark-OS users don't see a bright flash when an auth flow
 * opens. Bundle-accent matching (e.g. forcing Cherry Blossom's pink
 * accent into the titlebar) is intentionally out of scope here — it
 * would require an IPC roundtrip into the renderer's ThemeProvider, and
 * the practical legibility win sits in the light/dark gate.
 *
 * Surfaces emitted:
 *   - `:root` token variables (--ts-bg, --ts-fg, --ts-border, --ts-btn,
 *     --ts-btn-hover, --ts-btn-close-hover)
 *   - `.titlebar`, `.titlebar-mac` (height + drag region)
 *   - `.title`                     (window title text)
 *   - `.controls`, `.titlebar-btn`, `.titlebar-btn-close`
 */

import { t } from "../i18n/index.js";

export interface TitlebarShellOptions {
  /** Process platform — drives macOS hidden-inset vs Win/Linux full titlebar. */
  platform: NodeJS.Platform;
  /** Window title — shown next to controls on Win/Linux, hidden on macOS. */
  title: string;
}

/** Render the titlebar root <div>. macOS gets a 36px drag-only strip (matches
 *  Win/Linux height so chrome looks consistent and OS traffic lights center
 *  cleanly); Win/Linux gets a full bar with title + min/max/close buttons. */
export function buildTitlebarHtml({ platform }: TitlebarShellOptions): string {
  const isMac = platform === "darwin";
  if (isMac) {
    return `<div class="titlebar titlebar-mac" id="titlebar"></div>`;
  }
  return `<div class="titlebar" id="titlebar">
    <div class="title" id="title"></div>
    <div class="controls">
      <button class="titlebar-btn" id="minimize" title="${t("be_windowTitlebarShell.minimize")}" aria-label="${t("be_windowTitlebarShell.minimize")}">
        <svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>
      </button>
      <button class="titlebar-btn" id="maximize" title="${t("be_windowTitlebarShell.maximize")}" aria-label="${t("be_windowTitlebarShell.maximize")}">
        <svg id="max-icon" viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
      </button>
      <button class="titlebar-btn titlebar-btn-close" id="close" title="${t("be_windowTitlebarShell.close")}" aria-label="${t("be_windowTitlebarShell.close")}">
        <svg viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
    </button>
    </div>
  </div>`;
}

/** Emit the CSS for the titlebar + supporting layout primitives.
 *  Light tokens are warm-cream (matches Violet Light feel); dark tokens are
 *  warm-grey-1 (matches Violet Dark feel). Both use HSL so theme bundle
 *  changes in a future revision can reuse the same variable names. */
export function buildTitlebarCss(): string {
  return `
    :root {
      --ts-bg:              hsl(48 20% 94%);
      --ts-fg:              hsl(24 10% 10%);
      --ts-border:          hsl(35 14% 80% / 0.7);
      --ts-btn:             hsl(24 8% 32%);
      --ts-btn-hover-bg:    hsl(35 14% 84% / 0.8);
      --ts-btn-close-hover: hsl(0 72% 51%);
      --ts-webview-bg:      white;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --ts-bg:              hsl(20 6% 18%);
        --ts-fg:              hsl(44 37% 94%);
        --ts-border:          hsl(20 8% 30% / 0.7);
        --ts-btn:             hsl(40 8% 68%);
        --ts-btn-hover-bg:    hsl(20 6% 24%);
        --ts-btn-close-hover: hsl(0 72% 56%);
        --ts-webview-bg:      hsl(0 0% 15%);
      }
    }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body {
      display: flex;
      flex-direction: column;
      background: var(--ts-bg);
      color: var(--ts-fg);
      /* Mirrors HOST_FONT_STACK (src/shared/host-font-stack.ts) — issue #556 */
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif;
    }
    .titlebar {
      height: 36px;
      flex: 0 0 36px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--ts-border);
      background: var(--ts-bg);
      color: var(--ts-fg);
      user-select: none;
      -webkit-app-region: drag;
    }
    .titlebar-mac {
      height: 36px;
      flex: 0 0 36px;
      border-bottom: 0;
      background: transparent;
    }
    .title {
      min-width: 0;
      padding-left: 12px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      font-size: 12px;
      font-weight: 600;
      opacity: .82;
    }
    .controls {
      height: 100%;
      display: flex;
      align-items: stretch;
      -webkit-app-region: no-drag;
    }
    .titlebar-btn {
      width: 44px;
      height: 36px;
      border: 0;
      border-radius: 0;
      display: grid;
      place-items: center;
      background: transparent;
      color: var(--ts-btn);
      cursor: default;
    }
    .titlebar-btn:hover { background: var(--ts-btn-hover-bg); color: var(--ts-fg); }
    .titlebar-btn-close:hover { background: var(--ts-btn-close-hover); color: white; }
    .titlebar-btn svg { width: 14px; height: 14px; stroke: currentColor; stroke-width: 2; fill: none; stroke-linecap: round; stroke-linejoin: round; }
    webview {
      flex: 1 1 auto;
      width: 100%;
      min-height: 0;
      border: 0;
      background: var(--ts-webview-bg);
    }
  `;
}

/** JS string that wires the titlebar buttons (minimize/maximize/close) to
 *  `window.lvisWindow.*` preload bridge. Caller is responsible for
 *  loading this inside its own `<script>` tag along with any window-
 *  specific JS. macOS skips this (no buttons rendered). */
export function buildTitlebarButtonScript({ platform }: TitlebarShellOptions): string {
  const isMac = platform === "darwin";
  if (isMac) {
    return `
      document.getElementById("titlebar")?.addEventListener("dblclick", (event) => {
        if (event.target.closest && event.target.closest("button")) return;
        window.lvisWindow?.toggleMaximize();
      });
    `;
  }
  return `
    document.getElementById("minimize").addEventListener("click", () => window.lvisWindow?.minimize());
    document.getElementById("maximize").addEventListener("click", () => window.lvisWindow?.toggleMaximize());
    document.getElementById("close").addEventListener("click", () => window.lvisWindow?.close());
    window.lvisWindow?.onMaximizedChanged?.((maximized) => {
      const btn = document.getElementById("maximize");
      btn.title = maximized ? "${t("be_windowTitlebarShell.restore")}" : "${t("be_windowTitlebarShell.maximize")}";
      btn.setAttribute("aria-label", btn.title);
    });
    document.getElementById("titlebar").addEventListener("dblclick", (event) => {
      if (event.target.closest && event.target.closest("button")) return;
      window.lvisWindow?.toggleMaximize();
    });
  `;
}
