/**
 * Production host-side wiring for one MCP App card: `AppBridge` + transport.
 *
 * Extracted from `McpAppView.tsx` on purpose. This is the code that actually decides
 * whether an MCP App works — the constructor argument order, the sandbox handshake,
 * the `resources/read` proxy, the `connect()` call — and the real-<webview> e2e gate
 * (`test/e2e/ui/mcp-app-handshake/`) imports THIS module so it exercises the shipping
 * wiring rather than a look-alike reimplementation.
 *
 * That distinction is not academic. The gate previously stood up its own AppBridge, so
 * it proved the architecture end-to-end while proving nothing about how the renderer
 * wired it: drop the `onsandboxready` assignment or swap two constructor args and the
 * product would be dead with the gate still green. Keeping this in a React-free module
 * (no react / lucide / i18n imports) is what lets the e2e page bundle import the real
 * thing.
 */
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpUiPayload } from "../../../mcp/types.js";
import { INNER_SANDBOX_ATTR, MCP_APP_HOST_INFO } from "../../../shared/mcp-app-bridge-contract.js";
import { WebviewIpcTransport, type BridgeWebviewElement } from "./webview-ipc-transport.js";

/**
 * Wire an `AppBridge` to a freshly mounted <webview> for one card.
 *
 * `_client` is `null` and is the FIRST ctor arg: we do not hand ext-apps an MCP
 * `Client` — the real client lives in the main process — so handlers are registered
 * manually and proxied over our existing IPC. `Client` is deliberately never imported
 * as a value; that would drag `sdk/client/index.js` (and with it eventsource/express/
 * hono) into the renderer bundle.
 */
export function createMcpAppBridge(
  payload: Pick<McpUiPayload, "serverId">,
  html: string,
  el: BridgeWebviewElement,
): { bridge: AppBridge; transport: WebviewIpcTransport; connected: Promise<void> } {
  const transport = new WebviewIpcTransport(el);
  const bridge = new AppBridge(
    null,
    MCP_APP_HOST_INFO,
    { serverResources: {} },
    { hostContext: {} },
  );

  // The proxy announces it is ready for HTML; answer with the app document. The relay
  // preload mounts it into the inner sandboxed iframe, after which the App inside
  // performs `ui/initialize` over this same transport.
  //
  // Upstream prefers `addEventListener("sandboxready", …)`, but that member is
  // inherited from `ProtocolWithEvents`, and ext-apps 1.7.4's `.d.ts` files use
  // EXTENSIONLESS relative imports (`from "./events"`) which do not resolve under
  // `moduleResolution: NodeNext` — so the base class, and every member it brings, is
  // invisible to TypeScript here (`skipLibCheck` merely hides the .d.ts error).
  // Members declared directly on `AppBridge` resolve fine, so we use the singular
  // setter: marked @deprecated but a supported API with identical semantics for a
  // single listener, and the runtime JS is unaffected. Worth an upstream issue; NOT
  // worth forking.
  bridge.onsandboxready = () => {
    void bridge.sendSandboxResourceReady({ html, sandbox: INNER_SANDBOX_ATTR });
  };

  // resources/read from the app → the same main-process chokepoint that gated and
  // fetched this card (the partition policy is already installed for this server).
  bridge.onreadresource = async ({ uri }) => {
    const bundle = await window.lvis.mcp.readUiResource(payload.serverId, uri);
    return {
      contents: [{ uri, mimeType: "text/html;profile=mcp-app", text: bundle.html }],
    };
  };

  return { bridge, transport, connected: bridge.connect(transport) };
}
