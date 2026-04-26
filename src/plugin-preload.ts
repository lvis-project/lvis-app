/**
 * Plugin UI Preload — #237 Option B
 *
 * Runs inside each plugin webview's isolated renderer process.
 * Exposes a narrow `window.lvisPlugin` bridge that gives plugin UI code
 * ONLY the host capabilities it legitimately needs:
 *
 *   callTool(name, args)   — call a plugin-declared uiCallable method
 *   emitEvent(type, data)  — emit an event on the host event bus
 *   onEvent(type, handler) — subscribe to events scoped to this pluginId
 *
 * Explicitly NOT exposed (versus the host `window.lvisApi`):
 *   - getRuntimeCounts / getRuntimeEnv / pingMarketplace
 *   - onPluginInstallResult / onPluginUninstallResult / onPluginInstallProgress
 *   - chat, memory, settings, MCP, permission, approval, audit, DLP APIs
 *
 * The pluginId is taken from the `?pluginId=` query string that the host
 * renderer sets when constructing the webview src URL.  It is read once at
 * preload time and captured in a closure — plugin code cannot change it.
 */
import electron from "electron";

const { contextBridge, ipcRenderer } = electron;

// ─── Resolve pluginId from the webview src query string ──────────────────────
// The host renderer stamps the query string before the webview loads:
//   file:///…/plugin-ui-shell.html?pluginId=com.lge.meeting-recorder
const pluginId: string = (() => {
  try {
    return new URLSearchParams(window.location.search).get("pluginId") ?? "";
  } catch {
    return "";
  }
})();

// ─── Narrow bridge ───────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld("lvisPlugin", {
  /**
   * Call a plugin method declared in the manifest's `uiCallable[]` list.
   * Routes through `lvis:plugin:call-tool` — a main-process handler that
   * validates the sender frame is a known plugin webview before forwarding
   * to `pluginRuntime.callFromUi()`.
   */
  callTool: (name: string, args?: unknown): Promise<unknown> =>
    ipcRenderer.invoke("lvis:plugin:call-tool", pluginId, name, args),

  /**
   * Emit an event on the host bus.  Silently ignored for unknown event types
   * (the host runtime checks whether the plugin declares the event in
   * `eventPublishes[]`).
   */
  emitEvent: (type: string, data?: unknown): Promise<void> =>
    ipcRenderer.invoke("lvis:plugin:emit-event", pluginId, type, data) as Promise<void>,

  /**
   * Subscribe to host events.  The handler is scoped by `pluginId` so
   * plugin A cannot listen to events addressed to plugin B by constructing
   * the same `type` string.
   *
   * Returns an unsubscribe function in the same style as the host preload.
   */
  onEvent: (type: string, handler: (data: unknown) => void): (() => void) => {
    const listener = (_event: unknown, incomingType: string, data: unknown) => {
      if (incomingType === type) handler(data);
    };
    ipcRenderer.on("lvis:plugin:event", listener);
    return () => ipcRenderer.removeListener("lvis:plugin:event", listener);
  },

  /** Expose the resolved pluginId for debugging inside the webview. */
  pluginId,
});
