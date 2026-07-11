/**
 * The HOST page for the handshake e2e — stands in for McpAppView's renderer role,
 * using the REAL production pieces: the upstream `AppBridge` (null-client, manual
 * handlers) driven over our `WebviewIpcTransport`.
 *
 * Everything below the transport (the privileged scheme, the sandbox-proxy
 * document, the relay preload, the inner sandboxed iframe) is the real production
 * code path, exercised inside a real Electron <webview>.
 */
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { WebviewIpcTransport, type BridgeWebviewElement } from "../../../../src/ui/renderer/components/webview-ipc-transport.js";
import {
  INNER_SANDBOX_ATTR,
  MCP_APP_HOST_INFO,
} from "../../../../src/shared/mcp-app-bridge-contract.js";

declare global {
  interface Window {
    __startHandshake: (opts: { proxyUrl: string; partition: string; html: string }) => void;
  }
}

window.__startHandshake = ({ proxyUrl, partition, html }) => {
  const webview = document.createElement("webview");
  // partition MUST be set before src (Electron binds it at attach time).
  webview.setAttribute("partition", partition);
  webview.setAttribute(
    "webpreferences",
    "contextIsolation=yes, sandbox=yes, nodeIntegration=no, javascript=yes",
  );
  webview.setAttribute("src", proxyUrl);
  webview.style.width = "600px";
  webview.style.height = "300px";
  document.body.appendChild(webview);

  const transport = new WebviewIpcTransport(webview as unknown as BridgeWebviewElement);
  const bridge = new AppBridge(null, MCP_APP_HOST_INFO, { serverResources: {} }, { hostContext: {} });

  bridge.onsandboxready = () => {
    console.log("E2E_HOST SANDBOX_READY");
    void bridge.sendSandboxResourceReady({ html, sandbox: INNER_SANDBOX_ATTR });
  };

  // THE GATE: this only fires if the unmodified inner App completed `ui/initialize`
  // over the full chain — i.e. its postMessage really crossed out of the guest.
  bridge.oninitialized = () => {
    console.log("E2E_HOST HANDSHAKE_OK");
  };

  bridge
    .connect(transport)
    .then(() => console.log("E2E_HOST BRIDGE_CONNECTED"))
    .catch((err: unknown) => console.log(`E2E_HOST BRIDGE_CONNECT_FAILED:${String(err)}`));
};
