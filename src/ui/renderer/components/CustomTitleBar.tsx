/**
 * CustomTitleBar — cross-platform custom window chrome, now the single top
 * band that also hosts the app toolbar content.
 *
 * The band content (sidebar-collapse toggle, Chat/Action mode, Dev badge,
 * search / star / export) is passed in as `children` and rendered in the
 * band's left + middle, LEFT of the native window controls. There is no
 * separate toolbar row below the band — the toolbar lives IN the band.
 *
 * Win/Linux: renders the band with `children` on the left + middle and the
 *            native Minimize / Maximize / Close buttons pinned to the trailing
 *            corner. The band stays a drag region in empty zones; every
 *            interactive control opts out via `WebkitAppRegion: "no-drag"`.
 * macOS:     no renderer-drawn window buttons — the OS draws the traffic
 *            lights into the `hiddenInset` area (trafficLightPosition
 *            {x:14,y:12}). The band renders `children` with left padding so the
 *            first control clears the traffic lights (x:72), keeping the band a
 *            drag region elsewhere.
 *
 * Platform detection uses `window.lvisPlatform.isDarwin` (set by preload)
 * rather than a UA sniff — throw if the bridge is absent so misconfigurations
 * are loud, not silent.
 *
 * Drag region uses the Electron CSS hint `WebkitAppRegion: "drag"`;
 * interactive children opt out with `WebkitAppRegion: "no-drag"`.
 *
 * Theme sync: when the resolved shell theme changes, the component calls
 * `window.lvisWindow.syncTitleBarTheme` so the Electron titleBarOverlay
 * (Win/Linux native layer) matches our CSS tokens.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Minus, Maximize2, Minimize2, X } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { useOptionalTheme } from "../theme/ThemeProvider.js";
import { useTranslation } from "../../../i18n/react.js";

// ─── Token → hex helpers ──────────────────────────────────────────────────
// We read the CSS variable as an HSL triple (e.g. "222.2 84% 4.9%") and
// convert it to a hex string that Electron's setTitleBarOverlay() accepts.
function hslTripleToHex(triple: string): string {
  const parts = triple.trim().split(/\s+/);
  if (parts.length < 3) {
    throw new Error(`[CustomTitleBar] invalid HSL triple from CSS variable: "${triple}"`);
  }
  const h = parseFloat(parts[0]);
  const s = parseFloat(parts[1]) / 100;
  const l = parseFloat(parts[2]) / 100;

  // HSL → RGB (standard formula)
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const r = Math.round(f(0) * 255);
  const g = Math.round(f(8) * 255);
  const b = Math.round(f(4) * 255);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function readCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name);
}

// ─── Platform bridge ─────────────────────────────────────────────────────
// Returns null when the Electron preload bridge is absent (jsdom / Storybook /
// SSR). In those environments the component renders nothing — there is no
// native window chrome to replace. In Electron production the bridge is always
// injected by preload.ts; if it IS present but contains invalid data, we throw
// so the misconfiguration is loud rather than silently defaulting.
function tryGetPlatformBridge(): { isDarwin: boolean } | null {
  return (window as unknown as { lvisPlatform?: { isDarwin: boolean } }).lvisPlatform ?? null;
}

function getWindowBridge(): {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  syncTitleBarTheme: (color: string, symbolColor: string) => Promise<void>;
  onMaximizedChanged: (handler: (maximized: boolean) => void) => () => void;
  onFullscreenChanged: (handler: (fullscreen: boolean) => void) => () => void;
} {
  const w = (window as unknown as { lvisWindow?: unknown }).lvisWindow;
  if (!w) {
    throw new Error("[CustomTitleBar] window.lvisWindow is not defined — check preload.ts");
  }
  return w as ReturnType<typeof getWindowBridge>;
}

// ─── Component ────────────────────────────────────────────────────────────

export interface CustomTitleBarProps {
  /**
   * Band content — the app toolbar cluster (collapse toggle, Chat/Action mode,
   * Dev badge, search / star / export). Rendered in the band's left + middle,
   * LEFT of the native window controls. Interactive controls inside must wrap
   * themselves `WebkitAppRegion: "no-drag"`; the band itself is a drag region
   * in the gaps between them.
   */
  children?: ReactNode;
}

export function CustomTitleBar({ children }: CustomTitleBarProps = {}) {
  // Rules-of-hooks: all hook calls MUST come before any early return so the
  // hook order stays stable across renders. The platformBridge check is moved
  // below all hooks; the bridge-dependent useEffect bodies are gated with an
  // internal `if (!platformBridge) return;` so they noop when the bridge is
  // absent (jsdom / Storybook / SSR) without affecting hook count.
  const { t } = useTranslation();
  const platformBridge = tryGetPlatformBridge();
  const isDarwin = platformBridge?.isDarwin ?? false;
  const [isMaximized, setIsMaximized] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const optionalTheme = useOptionalTheme();

  // Listen for maximize / fullscreen state from main process.
  useEffect(() => {
    if (!platformBridge) return;
    const bridge = getWindowBridge();
    const unsubMax = bridge.onMaximizedChanged((maximized) => setIsMaximized(maximized));
    const unsubFull = bridge.onFullscreenChanged((fullscreen) => setIsFullscreen(fullscreen));
    return () => { unsubMax(); unsubFull(); };
  }, [platformBridge]);

  // Sync titlebar overlay colors when theme changes (Win/Linux only).
  useEffect(() => {
    if (!platformBridge) return;
    if (isDarwin) return;
    if (typeof document === "undefined") return;
    try {
      const bg = readCssVar("--background");
      const fg = readCssVar("--foreground");
      if (!bg.trim() || !fg.trim()) return;
      const color = hslTripleToHex(bg);
      const symbolColor = hslTripleToHex(fg);
      void getWindowBridge().syncTitleBarTheme(color, symbolColor);
    } catch (err) {
      console.warn("[CustomTitleBar] theme sync failed:", err);
    }
    // optionalTheme.resolved is the dependency — rerun whenever shell theme flips
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platformBridge, isDarwin, optionalTheme?.resolved]);

  const handleMinimize = useCallback(() => { void getWindowBridge().minimize(); }, []);
  const handleMaximize = useCallback(() => { void getWindowBridge().toggleMaximize(); }, []);
  const handleClose = useCallback(() => { void getWindowBridge().close(); }, []);
  const handleDoubleClick = useCallback(() => { void getWindowBridge().toggleMaximize(); }, []);

  // Early returns (all AFTER hooks have been called):
  // - No preload bridge → non-Electron environment (jsdom / Storybook / SSR).
  //   When band content is passed we still render a plain band hosting it
  //   (no native window buttons, no drag region — there is no OS chrome to
  //   integrate with) so the toolbar is never silently dropped. When no
  //   children are passed there is nothing to show, so render nothing.
  // - Fullscreen → OS/Electron draws fullscreen chrome.
  if (!platformBridge) {
    if (children === undefined || children === null) return null;
    return (
      <div
        data-testid="custom-titlebar-plain"
        className="flex h-9 shrink-0 items-center gap-2 border-b border-border/(--opacity-half) bg-background px-3 text-foreground select-none"
      >
        {children}
      </div>
    );
  }
  if (isFullscreen) return null;

  if (isDarwin) {
    // macOS: the OS draws the traffic lights into the hiddenInset area
    // (trafficLightPosition {x:14,y:12}). The band stays a drag region and
    // hosts the toolbar content with left padding (pl-[72px]) so the first
    // control clears the traffic lights.
    return (
      <div
        data-testid="custom-titlebar-darwin"
        className="flex h-9 shrink-0 items-center gap-2 border-b border-border/(--opacity-half) bg-background pl-[72px] pr-3 text-foreground select-none"
        style={{
          // @ts-expect-error — Electron-specific CSS extension
          WebkitAppRegion: "drag",
        }}
        onDoubleClick={handleDoubleClick}
      >
        {children}
      </div>
    );
  }

  // Win / Linux: band hosts the toolbar content on the left + middle, with the
  // native − □ × cluster pinned to the trailing corner.
  return (
    <div
      data-testid="custom-titlebar"
      className="flex h-9 shrink-0 items-center gap-2 border-b border-border/(--opacity-half) bg-background pl-3 text-foreground select-none"
      style={{
        // @ts-expect-error — Electron-specific CSS extension
        WebkitAppRegion: "drag",
      }}
      onDoubleClick={handleDoubleClick}
    >
      {children}
      {/* Spacer pushes the native window controls to the trailing corner; the
          empty span stays a drag region. */}
      <div className="flex-1" aria-hidden="true" />
      {/* no-drag wrapper so buttons receive mouse events */}
      <div
        className="flex h-full items-stretch"
        style={{
          // @ts-expect-error — Electron-specific CSS extension
          WebkitAppRegion: "no-drag",
        }}
      >
        <Button
          data-testid="titlebar-minimize"
          type="button"
          variant="ghost"
          size="icon"
          onClick={handleMinimize}
          title={t("customTitleBar.minimize")}
          className="titlebar-btn titlebar-btn-minimize h-9 w-11 rounded-none text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Minus size={14} />
        </Button>
        <Button
          data-testid="titlebar-maximize"
          type="button"
          variant="ghost"
          size="icon"
          onClick={handleMaximize}
          title={isMaximized ? t("customTitleBar.restore") : t("customTitleBar.maximize")}
          className="titlebar-btn titlebar-btn-maximize h-9 w-11 rounded-none text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {isMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </Button>
        <Button
          data-testid="titlebar-close"
          type="button"
          variant="ghost"
          size="icon"
          onClick={handleClose}
          title={t("customTitleBar.close")}
          className="titlebar-btn titlebar-btn-close h-9 w-11 rounded-none text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"
        >
          <X size={14} />
        </Button>
      </div>
    </div>
  );
}
