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

/**
 * The inner app iframe's `sandbox` attribute.
 *
 * `allow-scripts allow-same-origin` — the MCP Apps spec (`2026-01-26/apps.mdx:474-475`)
 * MUSTs BOTH: the Sandbox and Host must have different origins, AND the Sandbox must
 * carry `allow-scripts` and `allow-same-origin`. We satisfy the origin-separation MUST
 * structurally — the renderer is `file://` and the sandbox-proxy is a per-server
 * `lvis-mcp-app://<hex(serverId)>` custom scheme (a real, non-opaque, per-server
 * origin). `allow-same-origin` therefore makes the inner `srcdoc` frame inherit the
 * PROXY's per-server origin (NOT the renderer's `file://`), which is exactly what makes
 * the spec's `permissions` (Permissions-Policy delegation + a non-opaque origin the
 * Electron session handler can grant to) able to work at all.
 *
 * Why this does NOT weaken containment: the containment never rested on the opaque
 * origin. It rests on the per-server partition + injective scheme authority
 * (`mcp-app-partition.ts`), the isolated-world relay preload (`contextIsolation` is
 * true, so same-origin DOM access cannot reach it) with `nodeIntegrationInSubFrames`
 * false (no preload in the inner frame at all), the main-computed CSP response header,
 * and the declared-origin navigation/network gates. The proxy top document the inner
 * frame is now same-origin with is host-generated and script-free — reading it yields
 * nothing. `allow-forms` is deliberately NOT included: the spec does not MUST it and
 * `form-action` defaults to `'none'`, so it would be inert; add it only with evidence.
 *
 * Set UNCONDITIONALLY by the relay preload (`createInnerAppFrame`) — the wire never
 * supplies a `sandbox` value.
 *
 * ─── REVERT COUPLING (do not split) ──────────────────────────────────────────
 * This origin flip (`allow-same-origin`, making the inner frame NON-opaque) and the
 * `permissions` plumbing it enables — the manifest/schema `mcpUiResourcePermissions`, the
 * host-computed `allow` attribute (`mcp-app-permissions.ts`), and the Electron session
 * grant — are ONE change and MUST be reverted together. Reverting only this sandbox attr
 * back to the opaque origin while leaving the permissions plumbing in place re-creates the
 * #1600 "unhonored knob": a plugin's `permissions` would be accepted by the schema and
 * pass review, but an opaque origin cannot have camera/microphone/geolocation delegated to
 * it, so the declared feature would silently do nothing.
 */
export const INNER_SANDBOX_ATTR = "allow-scripts allow-same-origin";

/**
 * The `<meta name>` main uses to hand the relay preload the host-computed `allow`
 * attribute for the inner app iframe (spec `McpUiResourcePermissions`).
 *
 * Why a meta tag in the proxy document and NOT the bridge wire: the app HTML reaches
 * the preload via `SANDBOX_RESOURCE_READY`, i.e. RENDERER-forwarded, and a Permissions
 * Policy is a containment flag — the same class as `sandbox`, which the preload owns
 * unconditionally for exactly this reason. The proxy document, by contrast, is
 * host-generated and host-SERVED over the privileged `lvis-mcp-app://` scheme (with the
 * token→serverId authority check), so anything main writes into it is unreachable by
 * the renderer and by the app. Main computes the value from the closed feature table in
 * `shared/mcp-app-permissions.ts`; the preload copies it verbatim onto the frame.
 */
export const MCP_APP_ALLOW_META_NAME = "lvis-mcp-app-allow";

/**
 * How the host identifies itself to an App during `ui/initialize`.
 * MCP's `Implementation` is the name+version of the *implementation* speaking the
 * protocol — i.e. this bridge — not the LVIS release version.
 */
export const MCP_APP_HOST_INFO = { name: "LVIS", version: "1.0.0" } as const;
