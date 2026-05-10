/**
 * IPC bridge (plugin event -> renderer).
 *
 * Extracted from boot.ts. Responsibilities:
 *   • Collect event types declared by manifest.emittedEvents.
 *   • For each type, register a main→renderer forwarder on the host event bus.
 *     High-frequency *.transcript.updated events are coalesced (100ms debounce;
 *     final events flush immediately).
 *   • Tie lifecycle to window `closed` so macOS activate-recreated windows
 *     get a fresh bridge.
 *
 * No plugin-id / event-literal hard-codes — everything is manifest-driven.
 */
import type { BrowserWindow } from "electron";
import type { PluginRuntime } from "../../plugins/runtime.js";
import { onEvent } from "../types.js";
import { createLogger } from "../../lib/logger.js";
const log = createLogger("lvis");

/** True if the event type is a high-frequency transcript stream event. */
export function isTranscriptEvent(type: string): boolean {
  return type.endsWith(".transcript.updated");
}

/**
 * Core coalescing debounce logic for a single event type.
 * Accepts a `sendFn` that performs the actual delivery. Callers are
 * responsible for any guard logic (e.g. `win.isDestroyed()` check) inside
 * `sendFn` — see `registerPluginEventBridge` for the production usage.
 *
 * Exported so unit tests can import and exercise the production coalescing
 * behaviour directly rather than duplicating the debounce implementation.
 */
export function makeCoalescingSend(
  sendFn: (data: unknown) => void,
): (data: unknown) => void {
  let lastData: unknown = undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const flush = (data: unknown) => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
    sendFn(data);
  };

  return (data: unknown) => {
    const payload = data as Record<string, unknown> | undefined;
    const isFinal = payload?.isFinal === true;
    if (isFinal) {
      flush(data);
      lastData = undefined;
    } else {
      lastData = data;
      if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = undefined;
          if (lastData !== undefined) flush(lastData);
        }, 100);
      }
    }
  };
}

/** Collect plugin emitted event types from manifest.emittedEvents. */
function collectPluginEventTypes(pluginRuntime: PluginRuntime): Set<string> {
  const types = new Set<string>();
  for (const { manifest } of pluginRuntime.listPluginManifests()) {
    const raw = manifest as unknown as Record<string, unknown>;
    if (Array.isArray(raw["emittedEvents"])) {
      for (const t of raw["emittedEvents"] as unknown[]) {
        if (typeof t === "string" && t.trim()) types.add(t.trim());
      }
    }
  }
  return types;
}

/**
 * Register the plugin event bridge for the given window. Returns an
 * `unsubscribeAll` disposer; additionally auto-disposes on `closed`.
 */
export function registerPluginEventBridge(
  pluginRuntime: PluginRuntime,
  win: BrowserWindow,
): () => void {
  const unsubs: Array<() => void> = [];
  const eventTypes = collectPluginEventTypes(pluginRuntime);

  for (const type of eventTypes) {
    const guardedSend = (data: unknown) => {
      if (win.isDestroyed()) return;
      try {
        win.webContents.send("lvis:plugin:event", type, data);
      } catch (e) {
        log.warn(`boot: ${type} send failed: %s`, (e as Error).message);
      }
    };
    const sendFn = isTranscriptEvent(type)
      ? makeCoalescingSend(guardedSend)
      : guardedSend;
    unsubs.push(onEvent(type, sendFn));
  }

  const unsubscribeAll = () => { for (const u of unsubs) u(); };
  win.once("closed", unsubscribeAll);
  return unsubscribeAll;
}
