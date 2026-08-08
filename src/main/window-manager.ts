/**
 * WindowManager — the main window's identity and its mode-driven bounds.
 *
 * This used to manage detached child BrowserWindows and a magnetic snap-to-edge
 * system for them. Detach is a retired feature: every view renders inline, and MCP-app
 * cards reach `fullscreen` and `pip` through in-renderer surfaces (see
 * `shared/mcp-app-display-mode.ts`). Nothing spawns a child window any more, so the
 * child registry, the snap geometry, and the per-window bounds persistence went with
 * the feature they served.
 *
 * What remains is the main window: who it is (`registerMainWindow` / `getMainWindow`,
 * the one place the rest of main asks), and the animated resizes the workspace mode and
 * the chat side panel ask for. Other windows in the app own themselves — the settings
 * window (`settings-window.ts`), the HTML preview (`ipc/domains/window.ts`), and the
 * auth windows — and none of them route through here.
 */

import { BrowserWindow, ipcMain, screen, type IpcMainInvokeEvent } from "electron";
import { auditUnauthorized, UNAUTHORIZED_FRAME } from "../ipc-bridge.js";
import { validateHostRendererSender } from "../ipc/gated.js";
import { CHANNELS } from "../contract/app-contract.js";
import type { AuditLogger } from "../audit/audit-logger.js";
import {
  computeChatModeSidePanelBounds,
  computeInitialMainWindowBounds,
  computeWorkModeBounds,
} from "./main-window-bounds.js";

export class WindowManager {
  private _mainWindowId: number | null = null;
  /**
   * Active resize tween interval. At most one tween runs at a time — a new tween
   * cancels any in-flight one so rapid chat↔work toggling does not overlap
   * animations; the latest target always wins and lands exactly.
   */
  private _resizeTween: ReturnType<typeof setInterval> | null = null;

  // ── Registration ──────────────────────────────────────────────────────────

  registerMainWindow(win: BrowserWindow): void {
    this._mainWindowId = win.id;
    win.on("closed", () => {
      this._mainWindowId = null;
    });
  }

  getMainWindow(): BrowserWindow | null {
    if (this._mainWindowId === null) return null;
    return BrowserWindow.fromId(this._mainWindowId) ?? null;
  }

  /**
   * Smoothly animate a window to `target` bounds via a manual, cancellable
   * tween. Electron's `setBounds(bounds, animate=true)` flag is macOS-ONLY —
   * Windows/Linux ignore it and snap instantly. This interpolates x/y/width/
   * height with an easeOutCubic curve on a ~60fps interval so the resize is
   * smooth uniformly on every platform.
   *
   * Cancellation: any in-flight tween (`_resizeTween`) is cleared before a new
   * one starts, so rapid chat↔work toggling never overlaps animations — the
   * latest target wins and still lands EXACTLY on `target` (the final step
   * snaps to the precise integer bounds rather than an interpolated value).
   */
  animateBoundsTo(
    win: BrowserWindow,
    target: { x: number; y: number; width: number; height: number },
    opts: { durationMs?: number } = {},
  ): void {
    const durationMs = opts.durationMs ?? 220;

    // Cancel any in-flight tween — latest target wins.
    if (this._resizeTween !== null) {
      clearInterval(this._resizeTween);
      this._resizeTween = null;
    }

    if (win.isDestroyed()) return;

    const start = win.getBounds();
    const sameTarget =
      start.x === target.x &&
      start.y === target.y &&
      start.width === target.width &&
      start.height === target.height;
    if (sameTarget || durationMs <= 0) {
      win.setBounds(target, false);
      return;
    }

    const frameMs = 16; // ≈60fps
    const startedAt = Date.now();
    // easeOutCubic: fast start, gentle settle.
    const ease = (t: number): number => 1 - Math.pow(1 - t, 3);

    this._resizeTween = setInterval(() => {
      if (win.isDestroyed()) {
        if (this._resizeTween !== null) {
          clearInterval(this._resizeTween);
          this._resizeTween = null;
        }
        return;
      }

      const elapsed = Date.now() - startedAt;
      const linear = Math.min(1, elapsed / durationMs);

      if (linear >= 1) {
        // Final step — snap to the EXACT target, never an interpolated value.
        if (this._resizeTween !== null) {
          clearInterval(this._resizeTween);
          this._resizeTween = null;
        }
        win.setBounds(target, false);
        return;
      }

      const k = ease(linear);
      win.setBounds(
        {
          x: Math.round(start.x + (target.x - start.x) * k),
          y: Math.round(start.y + (target.y - start.y) * k),
          width: Math.round(start.width + (target.width - start.width) * k),
          height: Math.round(start.height + (target.height - start.height) * k),
        },
        false,
      );
    }, frameMs);
  }

  // ── IPC registration ──────────────────────────────────────────────────────

  registerIpc(auditLogger: AuditLogger): void {
    // Resize the main window to match the active workspace mode.
    //   work → centered 1243×768 (golden ratio, clamped to the work area), the focused
    //          working canvas where inline views need room.
    //   chat → the right-docked initial bounds (the same ones the window boots with),
    //          computed from the primary work area.
    // State-mutating channel — validateHostRendererSender (rejects plugin UI shells),
    // mirroring the other host-only window IPCs.
    ipcMain.handle(CHANNELS.window.resizeForMode, (event: IpcMainInvokeEvent, mode: unknown) => {
      if (!validateHostRendererSender(event)) {
        auditUnauthorized(auditLogger, CHANNELS.window.resizeForMode, event);
        return UNAUTHORIZED_FRAME;
      }
      if (mode !== "chat" && mode !== "work") {
        return { ok: false, error: "invalid-mode" };
      }
      const main = this.getMainWindow();
      if (!main || main.isDestroyed()) return { ok: false, error: "main-window-not-found" };

      const { workArea } = screen.getPrimaryDisplay();
      if (mode === "work") {
        // Manual easeOut tween (uniform on every platform). The native animate
        // flag is macOS-only and is intentionally NOT passed anymore.
        this.animateBoundsTo(main, computeWorkModeBounds(workArea));
      } else {
        this.animateBoundsTo(main, computeInitialMainWindowBounds(workArea));
      }
      return { ok: true };
    });

    // Resize the main window when the in-chat right-side work panel opens or
    // closes. Work mode keeps the panel in normal flex layout and does not call
    // this channel; this is only for chat mode's narrower OS window.
    ipcMain.handle(CHANNELS.window.resizeForSidePanel, (event: IpcMainInvokeEvent, open: unknown) => {
      if (!validateHostRendererSender(event)) {
        auditUnauthorized(auditLogger, CHANNELS.window.resizeForSidePanel, event);
        return UNAUTHORIZED_FRAME;
      }
      if (typeof open !== "boolean") {
        return { ok: false, error: "invalid-open-state" };
      }
      const main = this.getMainWindow();
      if (!main || main.isDestroyed()) return { ok: false, error: "main-window-not-found" };

      const { workArea } = screen.getPrimaryDisplay();
      this.animateBoundsTo(
        main,
        open
          ? computeChatModeSidePanelBounds(workArea)
          : computeInitialMainWindowBounds(workArea),
      );
      return { ok: true };
    });
  }
}
