/**
 * The HOST page for the handshake e2e.
 *
 * It drives the SHIPPING renderer wiring — `createMcpAppBridge` from
 * `src/ui/renderer/components/mcp-app-bridge.ts`, the exact function `McpAppView`
 * uses — rather than standing up its own AppBridge. That is deliberate: the earlier
 * version reimplemented the wiring here, so the gate proved the architecture but not
 * how the renderer wires it (drop `onsandboxready`, swap two ctor args, or skip
 * `connect()` and the product dies with the gate still green). Now a regression in the
 * real wiring turns this gate red.
 *
 * Everything below the transport (the privileged scheme, the sandbox-proxy document,
 * the relay preload, the inner sandboxed iframe) is the real production code path,
 * exercised inside a real Electron <webview>.
 */
import { createMcpAppBridge } from "../../../../src/ui/renderer/components/mcp-app-bridge.js";
import type { BridgeWebviewElement } from "../../../../src/ui/renderer/components/webview-ipc-transport.js";

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

  // The shipping wiring. If `createMcpAppBridge` forgets `onsandboxready`, misorders
  // the ctor args, or skips `connect()`, none of the markers below will ever fire.
  const { bridge, connected } = createMcpAppBridge(
    { serverId: "e2e-mcp-server" },
    html,
    webview as unknown as BridgeWebviewElement,
    // This gate exercises the sandbox handshake, not theming: an empty standard
    // host context matches the prior behavior (previously `{ hostContext: {} }`).
    {},
    // The handshake never sends `ui/open-link`, `ui/notifications/size-changed`,
    // `tools/call`, `ui/message`, `ui/download-file`, or `ui/request-display-mode`, so
    // these adapters are inert no-ops here — present only to satisfy the signature.
    {
      onResize: () => {},
      openLink: async () => ({ ok: false }),
      callTool: async () => ({ ok: false as const, error: "not-wired-in-e2e-harness" }),
      postMessage: async () => ({ ok: false as const, error: "not-wired-in-e2e-harness" }),
      getDisplayMode: () => "inline" as const,
      applyDisplayMode: async () => "inline" as const,
      downloadFile: async () => ({
        ok: false as const,
        error: "not-wired-in-e2e-harness",
        message: "not wired in the e2e harness",
      }),
      updateModelContext: async () => ({
        ok: false as const,
        error: "not-wired-in-e2e-harness",
        message: "not wired in the e2e harness",
      }),
    },
  );

  // Prove the sandbox handshake actually reached the (production) bridge. We observe
  // it via a SECOND `sandboxready` listener so we neither replace nor depend on the
  // production `onsandboxready` handler — `addEventListener` composes with it.
  bridge.addEventListener("sandboxready", () => console.log("E2E_HOST SANDBOX_READY"));

  // THE GATE: fires only if the unmodified inner App completed `ui/initialize` over the
  // full chain — i.e. its postMessage really crossed out of the guest.
  bridge.oninitialized = () => console.log("E2E_HOST HANDSHAKE_OK");

  connected
    .then(() => console.log("E2E_HOST BRIDGE_CONNECTED"))
    .catch((err: unknown) => console.log(`E2E_HOST BRIDGE_CONNECT_FAILED:${String(err)}`));
};
