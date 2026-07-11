// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { render, screen, waitFor, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpAppView } from "../McpAppView.js";
import { mcpAppPartitionName } from "../../../../shared/mcp-app-partition.js";
import type { McpUiPayload } from "../../../../mcp/types.js";

let disconnectHandler: ((serverId: string) => void) | null = null;
// Main now returns a BUNDLE: the sandbox-proxy URL the <webview> navigates to,
// plus the app HTML that is handed to the proxy over the bridge (never in the URL).
const readUiResource = vi.fn(async (serverId: string) => ({
  proxyUrl: `lvis-mcp-app://${Buffer.from(serverId, "utf8").toString("hex")}/proxy.html?t=tok-${serverId}`,
  html: "<html><body>card</body></html>",
}));
const disposeUiSession = vi.fn();

function stubLvis() {
  disconnectHandler = null;
  vi.stubGlobal("lvis", {
    mcp: {
      readUiResource,
      disposeUiSession,
      onServerDisconnected: (handler: (serverId: string) => void) => {
        disconnectHandler = handler;
        return () => {
          disconnectHandler = null;
        };
      },
    },
  });
  (window as unknown as { lvis: unknown }).lvis = (globalThis as unknown as { lvis: unknown }).lvis;
}

const payload = (serverId: string): McpUiPayload => ({ serverId, resourceUri: "ui://card/1" });

beforeEach(() => {
  readUiResource.mockClear();
  stubLvis();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Query the MOUNTED <webview> node (asserts the node attribute, not a setter). */
function webviewNode(container: HTMLElement): Element | null {
  return container.querySelector("webview");
}

describe("McpAppView — MAJOR-1 per-server partition as a createElement PROP", () => {
  it("sets partition=lvis-mcp-app:<enc(serverId)> on the MOUNTED webview node", async () => {
    const { container } = render(<McpAppView payload={payload("github")} />);
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());
    const node = webviewNode(container)!;
    // The whole point of the fix: the attribute must be present on the mounted
    // node (Electron binds partition only before src loads), NOT set post-mount.
    expect(node.getAttribute("partition")).toBe(mcpAppPartitionName("github"));
    // Sandbox posture also declared as creation-time props.
    expect(node.getAttribute("webpreferences")).toContain("contextIsolation=yes");
    expect(node.getAttribute("webpreferences")).toContain("sandbox=yes");
    // The webview now navigates to the host-owned sandbox-proxy document on the
    // privileged scheme — NOT a `data:` URL carrying the app HTML. The app HTML
    // travels over the bridge instead, so it never hits the ~2MB data:-URL cap and
    // the document gets a real origin + a real CSP response header.
    expect(node.getAttribute("src")?.startsWith("lvis-mcp-app://")).toBe(true);
    expect(node.getAttribute("src")).not.toContain("data:text/html");
    // No preload ATTRIBUTE: it is silently ignored under sandbox=yes and stripped
    // by the will-attach guards. The relay preload rides session.setPreloads().
    expect(node.getAttribute("preload")).toBeNull();
  });

  it("distinct serverIds yield distinct partition attributes", async () => {
    const a = render(<McpAppView payload={payload("github")} />);
    await waitFor(() => expect(webviewNode(a.container)).toBeTruthy());
    const b = render(<McpAppView payload={payload("gitlab")} />);
    await waitFor(() => expect(webviewNode(b.container)).toBeTruthy());

    const pa = webviewNode(a.container)!.getAttribute("partition");
    const pb = webviewNode(b.container)!.getAttribute("partition");
    expect(pa).toBe(mcpAppPartitionName("github"));
    expect(pb).toBe(mcpAppPartitionName("gitlab"));
    expect(pa).not.toBe(pb);
  });
});

describe("McpAppView — b3 disable-in-place on disconnect", () => {
  it("swaps the webview for a placeholder when its own server disconnects", async () => {
    const { container } = render(<McpAppView payload={payload("github")} />);
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());

    act(() => {
      disconnectHandler?.("github");
    });

    // The live webview is torn down; the placeholder takes the same card frame.
    expect(webviewNode(container)).toBeNull();
    expect(screen.getByTestId("mcp-app-disconnected")).toBeInTheDocument();
  });

  it("ignores a disconnect for a DIFFERENT server", async () => {
    const { container } = render(<McpAppView payload={payload("github")} />);
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());

    act(() => {
      disconnectHandler?.("some-other-server");
    });

    expect(webviewNode(container)).toBeTruthy();
    expect(screen.queryByTestId("mcp-app-disconnected")).toBeNull();
  });
});
