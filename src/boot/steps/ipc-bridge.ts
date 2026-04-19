/**
 * Boot §4.2 Step 7 — IPC bridge (plugin event → renderer).
 *
 * Extracted from boot.ts. Responsibilities:
 *   • Collect event types declared by manifest.emittedEvents (+ always include
 *     the legacy meeting.transcript.updated literal for back-compat).
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

/** True if the event type is a high-frequency transcript stream event. */
function isTranscriptEvent(type: string): boolean {
  return type.endsWith(".transcript.updated");
}

/** Build a coalescing send wrapper for a given event type + window. */
function makeCoalescingSend(
  type: string,
  getWin: () => BrowserWindow,
): (data: unknown) => void {
  let lastData: unknown = undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const flush = (data: unknown) => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
    const win = getWin();
    if (win.isDestroyed()) return;
    try {
      win.webContents.send("lvis:plugin:event", type, data);
    } catch (e) {
      console.warn(`[lvis] boot: ${type} send failed:`, (e as Error).message);
    }
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

/** Collect plugin emitted event types — manifest.emittedEvents + legacy literal. */
function collectPluginEventTypes(pluginRuntime: PluginRuntime): Set<string> {
  const types = new Set<string>(["meeting.transcript.updated"]);
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
    const sendFn = isTranscriptEvent(type)
      ? makeCoalescingSend(type, () => win)
      : (data: unknown) => {
          if (win.isDestroyed()) return;
          try {
            win.webContents.send("lvis:plugin:event", type, data);
          } catch (e) {
            console.warn(`[lvis] boot: ${type} send failed:`, (e as Error).message);
          }
        };
    unsubs.push(onEvent(type, sendFn));
  }

  const unsubscribeAll = () => { for (const u of unsubs) u(); };
  win.once("closed", unsubscribeAll);
  return unsubscribeAll;
}
