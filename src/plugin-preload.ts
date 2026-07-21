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
 *   - config.get(key)            → read this plugin's config field
 *   - config.set(key, value)     → write this plugin's config field
 *   - storage.get(key)           → read JSON from per-plugin sandboxed dir
 *   - storage.set(key, value)    → write JSON to per-plugin sandboxed dir
 *
 * Explicitly NOT exposed (vs host `window.lvisApi`):
 *   - Lifecycle / runtime / marketplace / chat / memory / settings / MCP /
 *     permission / approval / audit / DLP APIs.
 */
// Named imports — esbuild bundles these as
// `var import_electron = require("electron"); import_electron.contextBridge`,
// i.e. direct property access on the CJS module with NO `__toESM` wrapper
// and NO `.default` indirection.
//
// `import electron from "electron"` is what previously caused the silent
// failure in Electron 41 sandboxed webview preload contexts: the bundled
// output went through `__toESM(require("electron"), 1).default.contextBridge`
// and the wrapper machinery (Object.create + getter property descriptors)
// interacted badly with the sandbox isolation, leaving `contextBridge`
// undefined while the preload appeared to have executed cleanly.
import { contextBridge, ipcRenderer } from "electron";

// Diagnostic probe — temporarily ungated while we verify the
// session.setPreloads() fix for sandboxed <webview> preload loading.
// Surfaces in the plugin webview's DevTools console at preload boot. If
// `[lvis:plugin-preload] loaded` is missing, the preload script never ran
// (URL wrong, sandbox isolation, etc.). Once the fix is confirmed working
// in the wild, re-gate behind `process.env.LVIS_DEV === "1"`.
console.log("[lvis:plugin-preload] loaded", {
  url: typeof window !== "undefined" ? window.location?.href : "no-window",
});

/**
 * Hide the host's `{ ok, result | error }` envelope from plugin code so
 * `await bridge.callTool(...)` resolves to the raw tool result and rejects
 * with an `Error` when the host returned `{ ok: false }`. Plugins should
 * never have to know about the envelope — without this, a host-side
 * capability denial or method-not-found becomes a *resolved* Promise
 * carrying `{ ok: false, error }`, which silently bypasses every
 * `try/catch` plugins write.
 *
 */
/**
 * Event types whose most recent payload should be replayed to a freshly
 * subscribed handler. Plain `ipcRenderer.on(...)` is late-binding — `onEvent`
 * only attaches its listener when the plugin calls `bridge.onEvent(type, h)`,
 * which happens inside `useEffect` (i.e. after the React tree mounts). Any
 * `lvis:plugin:event` IPC that arrives before that — including main's
 * register-time theme replay — is silently dropped without this buffer.
 *
 * For these types we keep ONLY the latest payload (state, not log), so the
 * buffer never grows past `STICKY_EVENT_TYPES.size` entries. New types can
 * be added when main starts caching them too (see lvis-app
 * `src/ipc/domains/plugins.ts` `lastThemePayload`).
 */
const STICKY_EVENT_TYPES = new Set<string>(["host.theme.changed"]);
const stickyLastPayload = new Map<string, unknown>();

ipcRenderer.on("lvis:plugin:event", (_e, type: string, data: unknown) => {
  if (STICKY_EVENT_TYPES.has(type)) stickyLastPayload.set(type, data);
});

function unwrapEnvelope(reply: unknown): unknown {
  if (!reply || typeof reply !== "object" || !("ok" in reply)) {
    throw new Error("plugin-call-malformed-envelope");
  }
  const env = reply as { ok: unknown; result?: unknown; error?: unknown };
  // Strict boolean check — refuses to treat a host-side bug emitting
  // `{ok: "yes"}` as success.
  if (env.ok === true) return "result" in env ? env.result : undefined;
  if (env.ok === false) {
    throw new Error(typeof env.error === "string" ? env.error : "plugin-call-failed");
  }
  throw new Error("plugin-call-malformed-envelope");
}

function hasActiveUserActivation(): boolean {
  return globalThis.navigator?.userActivation?.isActive === true;
}

contextBridge.exposeInMainWorld("lvisPlugin", {
  callTool: async (name: string, args?: unknown): Promise<unknown> =>
    unwrapEnvelope(
      await ipcRenderer.invoke("lvis:plugin:call-tool", name, args, {
        userAction: hasActiveUserActivation(),
      }),
    ),

  emitEvent: async (type: string, data?: unknown): Promise<void> => {
    unwrapEnvelope(await ipcRenderer.invoke("lvis:plugin:emit-event", type, data));
  },

  onEvent: (type: string, handler: (data: unknown) => void): (() => void) => {
    if (STICKY_EVENT_TYPES.has(type) && stickyLastPayload.has(type)) {
      try { handler(stickyLastPayload.get(type)); } catch { /* handler errors are the plugin's */ }
    }
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

  /**
   * Fetch the host's currently-broadcast theme payload (theme axis +
   * `--lvis-*` token map) for pre-paint application before the plugin
   * module loads. Plugin-ui-shell calls this between `getEntryUrl` and
   * the dynamic `import()` so the page's `documentElement` carries the
   * right token values from frame 0 — eliminating the wc.send-vs-listener
   * race that the prior register-time replay model had.
   *
   * Returns `null` only when the host has not yet broadcast. Rejected or
   * malformed host envelopes throw so preload/main contract bugs do not get
   * hidden as a cold-boot theme.
   */
  getTheme: async (): Promise<unknown> => {
    const reply = (await ipcRenderer.invoke("lvis:plugin:get-theme")) as
      | { ok: true; theme: unknown }
      | { ok: false; error: string };
    if (!reply || typeof reply !== "object" || typeof reply.ok !== "boolean") {
      throw new Error("plugin-theme-malformed-envelope");
    }
    if (reply.ok === false) {
      throw new Error(typeof reply.error === "string" ? reply.error : "plugin-theme-failed");
    }
    return "theme" in reply ? reply.theme : null;
  },

  // ─── Config namespace (#B1) ────────────────────────────────────────────
  // Reads/writes this plugin's config record (the same record managed by the
  // PluginConfigTab). Cross-plugin writes are refused at the IPC boundary —
  // pluginId is resolved from `event.sender.id`, never from the renderer.
  // Secret-formatted fields are stripped server-side before persistence
  // (mirrors the `lvis:plugins:config:set` host handler), so plugin UI cannot
  // bypass the keychain by writing through this surface.
  config: {
    get: async <T = unknown>(key: string): Promise<T | undefined> => {
      const reply = (await ipcRenderer.invoke("lvis:plugin:config:get", key)) as
        | { ok: true; value: T | undefined }
        | { ok: false; error: string };
      if (!reply || reply.ok !== true) {
        throw new Error(`lvis:plugin:config:get rejected: ${reply?.error ?? "unknown"}`);
      }
      return reply.value;
    },
    set: async <T = unknown>(key: string, value: T): Promise<void> => {
      const reply = (await ipcRenderer.invoke("lvis:plugin:config:set", key, value)) as
        | { ok: true }
        | { ok: false; error: string };
      if (!reply || reply.ok !== true) {
        throw new Error(`lvis:plugin:config:set rejected: ${reply?.error ?? "unknown"}`);
      }
    },
  },

  // ─── Storage namespace (#B1) ────────────────────────────────────────────
  // Persistent key/value JSON store rooted at the plugin's sandboxed data
  // dir (createPluginStorage). Keys are restricted to `[A-Za-z0-9._-]{1,128}`;
  // each key maps to `<pluginDataDir>/ui-storage/<key>.json`. Path traversal
  // is rejected before the storage layer ever sees the key. Plugins should
  // use this for UI-side state that must survive a webview reload — anything
  // that needs cross-plugin coordination goes through the event bus.
  storage: {
    get: async <T = unknown>(key: string): Promise<T | undefined> => {
      const reply = (await ipcRenderer.invoke("lvis:plugin:storage:get", key)) as
        | { ok: true; value: T | undefined }
        | { ok: false; error: string };
      if (!reply || reply.ok !== true) {
        throw new Error(`lvis:plugin:storage:get rejected: ${reply?.error ?? "unknown"}`);
      }
      return reply.value;
    },
    set: async <T = unknown>(key: string, value: T): Promise<void> => {
      const reply = (await ipcRenderer.invoke("lvis:plugin:storage:set", key, value)) as
        | { ok: true }
        | { ok: false; error: string };
      if (!reply || reply.ok !== true) {
        throw new Error(`lvis:plugin:storage:set rejected: ${reply?.error ?? "unknown"}`);
      }
    },
  },
});
