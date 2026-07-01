import { describe, expect, it, vi } from "vitest";
import type { McpUiPayload } from "../../../../mcp/types.js";
import { createMcpAppBridge } from "../McpAppView.js";
import { buildMcpCsp, wrapWithCsp } from "../mcp-app-csp.js";

function makePayload(): McpUiPayload {
  return {
    serverId: "mcp-a",
    resourceUri: "ui://app-a/index.html",
    title: "App A",
    slot: "chat",
  };
}

function makeWebview() {
  const listeners = new Map<string, EventListenerOrEventListenerObject[]>();
  return {
    contentWindow: { name: "guest-a" } as MessageEventSource,
    executeJavaScript: vi.fn(async () => undefined),
    setAttribute: vi.fn(),
    addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry !== listener));
    }),
    listeners,
  };
}

function readPostedJson(executeJavaScript: ReturnType<typeof vi.fn>) {
  const code = executeJavaScript.mock.calls.at(-1)?.[0] as string;
  const match = code.match(/^window\.postMessage\((.*), "\*"\);$/);
  if (!match) {
    throw new Error(`unexpected bridge response: ${code}`);
  }
  return JSON.parse(match[1]) as unknown;
}

describe("createMcpAppBridge", () => {
  it("responds to mcp/ping over window.message only for the owning webview", () => {
    const webview = makeWebview();
    const bridge = createMcpAppBridge(makePayload(), webview);

    bridge.handleWindowMessage({
      source: { name: "guest-b" } as MessageEventSource,
      data: { jsonrpc: "2.0", id: 1, method: "mcp/ping" },
    } as MessageEvent);
    expect(webview.executeJavaScript).not.toHaveBeenCalled();

    bridge.handleWindowMessage({
      source: webview.contentWindow,
      data: { jsonrpc: "2.0", id: 2, method: "mcp/ping" },
    } as MessageEvent);
    expect(readPostedJson(webview.executeJavaScript)).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: { pong: true },
    });
  });

  it("returns payload context for mcp/getContext", () => {
    const webview = makeWebview();
    const payload = makePayload();
    const bridge = createMcpAppBridge(payload, webview);

    bridge.handleWindowMessage({
      source: webview.contentWindow,
      data: { jsonrpc: "2.0", id: 3, method: "mcp/getContext" },
    } as MessageEvent);

    expect(readPostedJson(webview.executeJavaScript)).toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: {
        serverId: payload.serverId,
        resourceUri: payload.resourceUri,
        title: payload.title,
      },
    });
  });

  it("returns method not found for unknown methods", () => {
    const webview = makeWebview();
    const bridge = createMcpAppBridge(makePayload(), webview);

    bridge.handleWindowMessage({
      source: webview.contentWindow,
      data: { jsonrpc: "2.0", id: 4, method: "mcp/unknown" },
    } as MessageEvent);

    expect(readPostedJson(webview.executeJavaScript)).toEqual({
      jsonrpc: "2.0",
      id: 4,
      error: { code: -32601, message: "Method not found" },
    });
  });

  it("supports legacy ipc-message input", () => {
    const webview = makeWebview();
    const bridge = createMcpAppBridge(makePayload(), webview);

    bridge.handleIpcMessage({
      channel: "mcp-bridge",
      args: [{ jsonrpc: "2.0", id: 5, method: "mcp/ping" }],
    } as unknown as Event);

    expect(readPostedJson(webview.executeJavaScript)).toEqual({
      jsonrpc: "2.0",
      id: 5,
      result: { pong: true },
    });
  });

  it("attaches and detaches both listeners", () => {
    const webview = makeWebview();
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal("window", {
      addEventListener,
      removeEventListener,
    });
    const bridge = createMcpAppBridge(makePayload(), webview);

    bridge.attach();
    expect(addEventListener).toHaveBeenCalledWith("message", bridge.handleWindowMessage);
    expect(webview.addEventListener).toHaveBeenCalledWith("ipc-message", bridge.handleIpcMessage);

    bridge.detach();
    expect(removeEventListener).toHaveBeenCalledWith("message", bridge.handleWindowMessage);
    expect(webview.removeEventListener).toHaveBeenCalledWith("ipc-message", bridge.handleIpcMessage);
  });
});

describe("McpAppView CSP", () => {
  it("injects metadata CSP additions into the host-built document policy", () => {
    const wrapped = wrapWithCsp("<html><head></head><body>app</body></html>", {
      connectSrc: ["https://api.example.com/v1"],
      imgSrc: ["https://images.example.com", "data:"],
    });

    expect(wrapped).toContain("Content-Security-Policy");
    expect(wrapped).toContain("connect-src https://api.example.com");
    expect(wrapped).toContain("img-src data: blob: https: https://images.example.com");
  });

  it("ignores unsafe metadata CSP sources and locked boundary directives", () => {
    const csp = buildMcpCsp({
      connectSrc: ["*", "https:", "http://api.example.com", "https://safe.example.com"],
      scriptSrc: ["'unsafe-eval'", "https://cdn.example.com"],
      "frame-ancestors": ["https://evil.example.com"],
    });

    expect(csp).toContain("connect-src https://safe.example.com");
    expect(csp).toContain("script-src 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://cdn.example.com");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("http://api.example.com");
    expect(csp).not.toMatch(/connect-src[^;]*\bhttps:(?:\s|;|")/);
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("evil.example.com");
    expect(csp).not.toContain("*");
  });
});
