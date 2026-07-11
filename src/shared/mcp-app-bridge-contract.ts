/**
 * MCP-App bridge wire contract — shared by main, the relay preload, and the renderer.
 *
 * Pure module (no DOM / Electron / ext-apps deps) so the sandbox-proxy relay
 * preload stays tiny: importing `@modelcontextprotocol/ext-apps` there would drag
 * `zod/v4` + the SDK Protocol into a preload bundle that only needs to forward
 * opaque JSON-RPC frames.
 *
 * The two method literals below are ext-apps' *wire* constants, duplicated here
 * on purpose. `__tests__/mcp-app-bridge-contract.test.ts` asserts they are
 * identical to `SANDBOX_PROXY_READY_METHOD` / `SANDBOX_RESOURCE_READY_METHOD`
 * exported by the installed ext-apps build, so an upstream rename fails the
 * suite instead of silently breaking the handshake.
 */

/**
 * The single `<webview>` ipc channel carrying the MCP-Apps JSON-RPC stream.
 *
 * Renderer → guest: `webview.send(MCP_APP_BRIDGE_CHANNEL, frame)`
 * Guest → renderer: `ipcRenderer.sendToHost(MCP_APP_BRIDGE_CHANNEL, frame)`
 *
 * One channel, both directions, opaque frames — the relay never interprets the
 * app's traffic. It only intercepts the two sandbox-proxy frames below.
 */
export const MCP_APP_BRIDGE_CHANNEL = "mcp-app-bridge";

/**
 * Sandbox proxy → host. Emitted by the relay preload once the proxy document is
 * ready to receive HTML. The host answers with {@link SANDBOX_RESOURCE_READY}.
 */
export const SANDBOX_PROXY_READY = "ui/notifications/sandbox-proxy-ready";

/**
 * Host → sandbox proxy. Carries the app HTML for the inner sandboxed iframe.
 * Consumed by the relay preload; never forwarded to the inner frame.
 */
export const SANDBOX_RESOURCE_READY = "ui/notifications/sandbox-resource-ready";

/** The inner iframe's sandbox attribute. No `allow-same-origin` ⇒ opaque origin. */
export const INNER_SANDBOX_ATTR = "allow-scripts";

/**
 * How the host identifies itself to an App during `ui/initialize`.
 * MCP's `Implementation` is the name+version of the *implementation* speaking the
 * protocol — i.e. this bridge — not the LVIS release version.
 */
export const MCP_APP_HOST_INFO = { name: "LVIS", version: "1.0.0" } as const;
