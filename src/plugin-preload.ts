/**
 * Plugin UI Preload — #237 Option B
 *
 * Runs inside each plugin webview's isolated renderer process. Exposes a
 * narrow `window.lvisPlugin` bridge to plugin code. The pluginId is
 * authoritative on the main side: the host renderer registers
 * (webContents.id → pluginId) before navigation, and main resolves
 * pluginId from `event.sender.id` on every plugin IPC. The renderer
 * cannot supply, override, or spoof pluginId from this side.
 *
 * Exposed to plugins:
 *   - callTool(name, args)       → host runtime; cross-plugin call denied
 *   - emitEvent(type, data)      → host event bus, capability-gated
 *   - onEvent(type, handler)     → host events scoped to this plugin
 *   - getEntryUrl()              → canonical entry URL from main
 *
 * Explicitly NOT exposed (vs host `window.lvisApi`):
 *   - Lifecycle / runtime / marketplace / chat / memory / settings / MCP /
 *     permission / approval / audit / DLP APIs.
 */
import electron from "electron";

const { contextBridge, ipcRenderer } = electron;

contextBridge.exposeInMainWorld("lvisPlugin", {
  callTool: (name: string, args?: unknown): Promise<unknown> =>
    ipcRenderer.invoke("lvis:plugin:call-tool", name, args),

  emitEvent: (type: string, data?: unknown): Promise<void> =>
    ipcRenderer.invoke("lvis:plugin:emit-event", type, data) as Promise<void>,

  onEvent: (type: string, handler: (data: unknown) => void): (() => void) => {
    const listener = (_event: unknown, incomingType: string, data: unknown) => {
      if (incomingType === type) handler(data);
    };
    ipcRenderer.on("lvis:plugin:event", listener);
    return () => ipcRenderer.removeListener("lvis:plugin:event", listener);
  },

  /**
   * Fetch the verified entry URL for this plugin. Main resolves it from
   * the (webContents.id → pluginId, entryUrl) registry populated by the
   * host renderer at `did-attach`. The shell awaits this before its
   * dynamic `import()` so plugin code cannot request an arbitrary file
   * via a query-string-driven path.
   *
   * Main returns either `{ ok: true, entryUrl }` on success or a
   * `{ ok: false, error }` sentinel when the sender frame fails the
   * plugin-frame guard (e.g. host frame, unregistered webContents). The
   * preload unwraps to a string so the shell can keep its simple
   * await-then-import flow, and throws on the rejected sentinel so the
   * shell's catch block surfaces the reason.
   */
  getEntryUrl: async (): Promise<string> => {
    const reply = (await ipcRenderer.invoke("lvis:plugin:get-entry-url")) as
      | { ok: true; entryUrl: string }
      | { ok: false; error: string };
    if (!reply || reply.ok !== true) {
      throw new Error(`lvis:plugin:get-entry-url rejected: ${reply?.error ?? "unknown"}`);
    }
    return reply.entryUrl;
  },
});
