/**
 * The HOST page for the permissions e2e. Mounts BOTH probe cards — `declared` and
 * `absent` — through the shipping renderer wiring (`createMcpAppBridge`), the same
 * function `McpAppView` uses, so the cards reach the inner frame exactly as in
 * production. The bridge is what delivers the app HTML over
 * `ui/notifications/sandbox-resource-ready`, i.e. the RENDERER-forwarded channel — which
 * is precisely why the `allow` attribute must NOT ride on it, and does not.
 */
import { createMcpAppBridge } from "../../../../src/ui/renderer/components/mcp-app-bridge.js";
import type { BridgeWebviewElement } from "../../../../src/ui/renderer/components/webview-ipc-transport.js";

declare global {
  interface Window {
    __startProbe: (opts: {
      card: { label: string; proxyUrl: string; html: string };
      partition: string;
      serverId: string;
    }) => void;
  }
}

/**
 * ONE card per page load. `navigator.clipboard.writeText` requires the document to be
 * focused, and two webviews cannot both hold focus — mounting both at once made the
 * unfocused card report a false "denied". The two cases therefore run sequentially, each
 * in its own shown-and-focused window (see `main.ts`).
 */
window.__startProbe = ({ card, partition, serverId }) => {
  const webview = document.createElement("webview");
  // partition MUST be set before src (Electron binds it at attach time).
  webview.setAttribute("partition", partition);
  webview.setAttribute(
    "webpreferences",
    "contextIsolation=yes, sandbox=yes, nodeIntegration=no, javascript=yes",
  );
  webview.setAttribute("src", card.proxyUrl);
  webview.style.width = "400px";
  webview.style.height = "200px";
  document.body.appendChild(webview);
  // Give the guest the focus chain the clipboard API needs. The inner frame focuses
  // itself from inside (probe-app.ts) once this has put the webview in the path.
  webview.addEventListener("dom-ready", () => webview.focus());

  const { connected } = createMcpAppBridge(
    { serverId },
    card.html,
    webview as unknown as BridgeWebviewElement,
    {},
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

  connected.catch((err: unknown) =>
    console.log(`E2E_PROBE ${card.label} BRIDGE_CONNECT_FAILED:${String(err)}`),
  );
};
