import { describe, expect, it, vi } from "vitest";
import {
  SANDBOX_PROXY_READY_METHOD,
  SANDBOX_RESOURCE_READY_METHOD,
} from "@modelcontextprotocol/ext-apps";
import { buildMcpCsp, buildMcpCspHeader } from "../../../../shared/mcp-app-csp.js";
import {
  MCP_APP_BRIDGE_CHANNEL,
  SANDBOX_PROXY_READY,
  SANDBOX_RESOURCE_READY,
} from "../../../../shared/mcp-app-bridge-contract.js";
import { WebviewIpcTransport } from "../webview-ipc-transport.js";

/**
 * A fake Electron <webview>: `send` is host→guest, and `emit` replays a guest→host
 * `ipc-message` event.
 */
function makeWebview() {
  const listeners: Array<(event: Event) => void> = [];
  return {
    send: vi.fn<(channel: string, ...args: unknown[]) => void>(),
    addEventListener: vi.fn((_type: string, listener: (event: Event) => void) => {
      listeners.push(listener);
    }),
    removeEventListener: vi.fn((_type: string, listener: (event: Event) => void) => {
      const i = listeners.indexOf(listener);
      if (i >= 0) listeners.splice(i, 1);
    }),
    /** Replay a guest→host `ipc-message` event. */
    emit(channel: string, frame: unknown) {
      const event = new Event("ipc-message") as Event & { channel: string; args: unknown[] };
      event.channel = channel;
      event.args = [frame];
      for (const l of [...listeners]) l(event);
    },
    listenerCount: () => listeners.length,
  };
}

describe("mcp-app bridge wire contract", () => {
  // The relay preload cannot import ext-apps (it would drag zod + the SDK Protocol
  // into a preload that only forwards opaque frames), so it re-declares these two
  // wire literals. This test is the anti-drift guard: an upstream rename fails here
  // instead of silently deadlocking the handshake.
  it("re-declared sandbox method literals match the installed ext-apps constants", () => {
    expect(SANDBOX_PROXY_READY).toBe(SANDBOX_PROXY_READY_METHOD);
    expect(SANDBOX_RESOURCE_READY).toBe(SANDBOX_RESOURCE_READY_METHOD);
  });
});

describe("WebviewIpcTransport", () => {
  it("delivers guest frames to onmessage once started", async () => {
    const webview = makeWebview();
    const transport = new WebviewIpcTransport(webview);
    const seen: unknown[] = [];
    transport.onmessage = (m) => seen.push(m);

    await transport.start();
    webview.emit(MCP_APP_BRIDGE_CHANNEL, { jsonrpc: "2.0", id: 1, method: "ui/initialize" });

    expect(seen).toEqual([{ jsonrpc: "2.0", id: 1, method: "ui/initialize" }]);
  });

  it("buffers frames that arrive BEFORE start() and replays them", async () => {
    // The relay preload announces sandbox-proxy-ready the moment the proxy document
    // loads, which can beat AppBridge.connect(). Dropping it would deadlock the
    // handshake: the host would never send the app HTML.
    const webview = makeWebview();
    const transport = new WebviewIpcTransport(webview);
    const seen: unknown[] = [];
    transport.onmessage = (m) => seen.push(m);

    webview.emit(MCP_APP_BRIDGE_CHANNEL, {
      jsonrpc: "2.0",
      method: SANDBOX_PROXY_READY,
      params: {},
    });
    expect(seen).toEqual([]); // not started yet

    await transport.start();
    expect(seen).toEqual([{ jsonrpc: "2.0", method: SANDBOX_PROXY_READY, params: {} }]);
  });

  it("ignores ipc-message events on other channels", async () => {
    const webview = makeWebview();
    const transport = new WebviewIpcTransport(webview);
    const seen: unknown[] = [];
    transport.onmessage = (m) => seen.push(m);
    await transport.start();

    webview.emit("some-other-channel", { jsonrpc: "2.0", id: 9 });

    expect(seen).toEqual([]);
  });

  it("sends host frames over the bridge channel", async () => {
    const webview = makeWebview();
    const transport = new WebviewIpcTransport(webview);
    await transport.start();

    await transport.send({ jsonrpc: "2.0", id: 2, result: {} } as never);

    expect(webview.send).toHaveBeenCalledWith(MCP_APP_BRIDGE_CHANNEL, {
      jsonrpc: "2.0",
      id: 2,
      result: {},
    });
  });

  it("close() detaches the listener and fires onclose", async () => {
    const webview = makeWebview();
    const transport = new WebviewIpcTransport(webview);
    const onclose = vi.fn();
    transport.onclose = onclose;
    await transport.start();
    expect(webview.listenerCount()).toBe(1);

    await transport.close();

    expect(onclose).toHaveBeenCalledOnce();
    expect(webview.listenerCount()).toBe(0);
  });
});

describe("McpAppView CSP", () => {
  it("injects metadata CSP additions into the host-built document policy", () => {
    const wrapped = buildMcpCsp({
      imgSrc: ["https://images.example.com", "data:"],
    });

    expect(wrapped).toContain("img-src data: blob: https: https://images.example.com");
  });

  it("ignores unsafe metadata CSP sources and locked boundary directives", () => {
    const csp = buildMcpCspHeader({
      connectSrc: ["http://insecure.example.com", "https://api.example.com"],
      // @ts-expect-error — boundary directives are not overridable by metadata
      baseUri: ["https://evil.example.com"],
    });

    expect(csp).toContain("connect-src https://api.example.com");
    expect(csp).not.toContain("http://insecure.example.com");
    expect(csp).toContain("base-uri 'none'");
  });

  it("emits a header string (no <meta> wrapper) — the proxy response-header form", () => {
    // The header is the SOT: the inner srcdoc app frame INHERITS it and can only
    // narrow it, so this string is the effective envelope for untrusted app code.
    const header = buildMcpCspHeader();
    expect(header.startsWith("default-src 'none'")).toBe(true);
    expect(header).not.toContain("<meta");
    expect(header).toContain("frame-ancestors 'none'");
  });
});
