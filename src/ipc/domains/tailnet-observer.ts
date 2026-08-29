/**
 * Host-renderer-only IPC for the Tailnet observer configuration.
 *
 * The renderer proposes a configuration; the host validates and persists it.
 * `apply` decides whether a listener comes up at all, which capability key
 * authorizes it, and whether remote control and the web surface are in scope,
 * so it carries the same live-keyboard-intent requirement as a share and never
 * routes through the renderer-writable settings store.
 */
import { ipcMain } from "electron";
import { CHANNELS } from "../../contract/app-contract.js";
import { hasUserKeyboardIntentPayload, USER_KEYBOARD_REQUIRED } from "../../shared/chat-origin.js";
import {
  parseTailnetObserverConfigView,
  parseTailnetObserverSnapshot,
} from "../../shared/tailnet-observer-config.js";
import { auditUnauthorized, UNAUTHORIZED_FRAME, validateHostRendererSender } from "../gated.js";
import type { IpcDeps } from "../types.js";

const DISABLED = Object.freeze({
  ok: false as const,
  error: "tailnet-observer-unavailable" as const,
});
const INPUT_INVALID = Object.freeze({
  ok: false as const,
  error: "tailnet-observer-input-invalid" as const,
});
const UNAVAILABLE = Object.freeze({
  ok: false as const,
  error: "tailnet-observer-unavailable" as const,
});

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The resolver's own kebab-case codes reach the renderer verbatim.
 *
 * That is the point of the surface: "why is my observer not up" was previously
 * answerable only from a main-process log. Every one of these codes is a
 * classification of the user's own proposal — no path, host, or credential
 * appears in any of them.
 */
function rejection(err: unknown): { ok: false; error: string } {
  const code = err instanceof Error ? err.message : "";
  return Object.freeze({
    ok: false as const,
    error: /^[a-z0-9-]+$/.test(code) ? code : "tailnet-observer-write-failed",
  });
}

export function registerTailnetObserverHandlers(deps: IpcDeps): void {
  const service = deps.tailnetObserverConfigService;

  ipcMain.handle(CHANNELS.tailnetObserver.snapshot, async (event) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.tailnetObserver.snapshot, event);
      return UNAUTHORIZED_FRAME;
    }
    if (!service) return DISABLED;
    try {
      const snapshot = parseTailnetObserverSnapshot(await service.snapshot());
      return snapshot === null ? UNAVAILABLE : { ok: true as const, snapshot };
    } catch (err) {
      return rejection(err);
    }
  });

  ipcMain.handle(CHANNELS.tailnetObserver.apply, async (event, payload: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.tailnetObserver.apply, event);
      return UNAUTHORIZED_FRAME;
    }
    if (!service) return DISABLED;
    if (!hasUserKeyboardIntentPayload(payload)) return USER_KEYBOARD_REQUIRED;
    const config = record(payload) ? parseTailnetObserverConfigView(payload.config) : null;
    if (config === null) return INPUT_INVALID;
    try {
      await service.apply(config);
      return { ok: true as const };
    } catch (err) {
      return rejection(err);
    }
  });
}
