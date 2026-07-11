/**
 * html-preview-partition unit tests
 *
 * Verifies:
 *  - installHtmlPreviewPartitionBlock() registers the strict inline-only gate on
 *    `lvis-render-html` and NO LONGER touches any `lvis-mcp-app` partition (the
 *    boot-time shared MCP-app install was removed in #885 b1);
 *  - installMcpAppPartitionPolicy(serverId) lazily installs the per-server policy
 *    (declared-origin network gate + sandbox-proxy protocol handler + relay preload)
 *    on the `lvis-mcp-app:<hex>` partition and is idempotent;
 *  - installPluginPartitionPolicy() still wires the sandboxed <webview> preload +
 *    network block.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { mcpAppPartitionName, MCP_APP_PARTITION_PREFIX } from "../../shared/mcp-app-partition.js";
import {
  createMcpAppProxySession,
  _resetMcpAppProxySessions,
} from "../mcp-app-protocol.js";

const __dirnameLocal = dirname(fileURLToPath(import.meta.url));
const pluginShellHtmlUrl = pathToFileURL(resolve(__dirnameLocal, "..", "..", "plugin-ui-shell.html")).toString();
const pluginShellJsUrl = pathToFileURL(resolve(__dirnameLocal, "..", "..", "plugin-ui-shell.js")).toString();

// ─── Mock electron ────────────────────────────────────────────────────────────
const mockOnBeforeRequest = vi.fn();
const mockOnBeforeRequestMcp = vi.fn();
const mockOnBeforeRequestPlugin = vi.fn();
const mockSetPreloadsPlugin = vi.fn();
const mockProtocolHandlePlugin = vi.fn();
const mockSetPreloadsMcp = vi.fn();
const mockProtocolHandleMcp = vi.fn();
const mockSession = {
  webRequest: {
    onBeforeRequest: mockOnBeforeRequest,
  },
  setPreloads: vi.fn(),
};
const mockMcpSession = {
  webRequest: {
    onBeforeRequest: mockOnBeforeRequestMcp,
  },
  // The MCP-app partition now also carries the sandbox-proxy relay preload and
  // the `lvis-mcp-app://` protocol handler that serves the proxy document.
  setPreloads: mockSetPreloadsMcp,
  protocol: {
    handle: mockProtocolHandleMcp,
  },
};
const mockPluginSession = {
  webRequest: {
    onBeforeRequest: mockOnBeforeRequestPlugin,
  },
  setPreloads: mockSetPreloadsPlugin,
  protocol: {
    handle: mockProtocolHandlePlugin,
  },
};

import {
  installHtmlPreviewPartitionBlock,
  installMcpAppPartitionPolicy,
  installPluginPartitionPolicy,
} from "../html-preview-partition.js";

const mockSessionApi = {
  fromPartition: vi.fn((partition: string) => {
    if (partition.startsWith(MCP_APP_PARTITION_PREFIX)) return mockMcpSession as unknown as Electron.Session;
    if (partition.startsWith("persist:plugin:")) return mockPluginSession as unknown as Electron.Session;
    return mockSession as unknown as Electron.Session;
  }),
};

// Helper: invoke the registered handler and return callback result
function invokeHandler(url: string): { cancel: boolean } {
  const handler = mockOnBeforeRequest.mock.calls[0][0] as (
    details: { url: string },
    callback: (result: { cancel: boolean }) => void,
  ) => void;
  let result!: { cancel: boolean };
  handler({ url }, (r) => {
    result = r;
  });
  return result;
}

function invokeMcpHandler(url: string): { cancel: boolean } {
  const handler = mockOnBeforeRequestMcp.mock.calls[0][0] as (
    details: { url: string },
    callback: (result: { cancel: boolean }) => void,
  ) => void;
  let result!: { cancel: boolean };
  handler({ url }, (r) => {
    result = r;
  });
  return result;
}

function invokePluginHandler(url: string): { cancel: boolean } {
  const handler = mockOnBeforeRequestPlugin.mock.calls[0][0] as (
    details: { url: string },
    callback: (result: { cancel: boolean }) => void,
  ) => void;
  let result!: { cancel: boolean };
  handler({ url }, (r) => {
    result = r;
  });
  return result;
}

describe("installHtmlPreviewPartitionBlock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installHtmlPreviewPartitionBlock(mockSessionApi);
  });

  it("installs ONLY the strict inline-only gate on lvis-render-html (no boot-time mcp-app install)", () => {
    expect(mockSessionApi.fromPartition).toHaveBeenCalledWith("lvis-render-html");
    // The bare `lvis-mcp-app` boot install is GONE — per-server partitions are
    // installed lazily in the readUiResource chokepoint instead.
    const partitions = mockSessionApi.fromPartition.mock.calls.map((c) => c[0] as string);
    expect(partitions).toEqual(["lvis-render-html"]);
    expect(partitions.some((p) => p.startsWith(MCP_APP_PARTITION_PREFIX))).toBe(false);
    expect(mockOnBeforeRequest).toHaveBeenCalledOnce();
    expect(mockOnBeforeRequestMcp).not.toHaveBeenCalled();
  });

  it("allows data:/blob:/about:blank on the render-html gate", () => {
    expect(invokeHandler("data:text/html;charset=utf-8,hello")).toEqual({ cancel: false });
    expect(invokeHandler("blob:null/abc-123")).toEqual({ cancel: false });
    expect(invokeHandler("about:blank")).toEqual({ cancel: false });
  });

  it("blocks http/https/file/ftp/unknown on the render-html gate", () => {
    expect(invokeHandler("http://example.com/evil")).toEqual({ cancel: true });
    expect(invokeHandler("https://attacker.example/exfil")).toEqual({ cancel: true });
    // CDN hosts are NOT allowed on the render-html partition — only on mcp-app.
    expect(invokeHandler("https://cdn.jsdelivr.net/npm/vue")).toEqual({ cancel: true });
    expect(invokeHandler("file:///etc/passwd")).toEqual({ cancel: true });
    expect(invokeHandler("ftp://ftp.example.com/data")).toEqual({ cancel: true });
    expect(invokeHandler("custom-scheme://something")).toEqual({ cancel: true });
  });
});

describe("installMcpAppPartitionPolicy (#885 b1 — lazy per-server partition policy)", () => {
  beforeEach(() => {
    mockOnBeforeRequestMcp.mockClear();
    mockSessionApi.fromPartition.mockClear();
    mockSetPreloadsMcp.mockClear();
    mockProtocolHandleMcp.mockClear();
  });

  it("installs the network gate on the per-server lvis-mcp-app:<hex> partition", () => {
    // Unique serverId avoids the module-level installedMcpAppPartitions Set
    // short-circuit from other tests.
    installMcpAppPartitionPolicy("github-a", mockSessionApi);
    expect(mockSessionApi.fromPartition).toHaveBeenCalledWith(mcpAppPartitionName("github-a"));
    expect(mockOnBeforeRequestMcp).toHaveBeenCalledOnce();
  });

  it("is deny-by-default: blocks UNDECLARED https hosts, including the old hardcoded CDNs", () => {
    // The gate used to hardcode 5 CDNs, which GRANTED hosts no app had declared —
    // the spec's No-Loosening MUST says the host MUST NOT allow undeclared domains.
    installMcpAppPartitionPolicy("github-b", mockSessionApi);
    expect(invokeMcpHandler("https://cdn.jsdelivr.net/npm/vue")).toEqual({ cancel: true });
    expect(invokeMcpHandler("https://unpkg.com/x")).toEqual({ cancel: true });
    expect(invokeMcpHandler("https://attacker.example/exfil")).toEqual({ cancel: true });
    expect(invokeMcpHandler("http://cdn.jsdelivr.net/x")).toEqual({ cancel: true });
    expect(invokeMcpHandler("file:///etc/passwd")).toEqual({ cancel: true });
    // Local inline schemes stay open — not exfiltration channels.
    expect(invokeMcpHandler("data:text/html,x")).toEqual({ cancel: false });
    // The host-owned sandbox-proxy document. Without this the gate cancels the proxy
    // navigation and the card never loads (caught by the real-webview e2e).
    expect(invokeMcpHandler("lvis-mcp-app://abc/proxy.html?t=tok")).toEqual({ cancel: false });
  });

  it("opens ONLY the origins that server's own resource declared (CSP ↔ network lockstep)", () => {
    // Previously the CSP could permit a declared `connectDomains` host while this gate
    // silently cancelled it, so declared network access could never actually work.
    _resetMcpAppProxySessions();
    createMcpAppProxySession("github-declared", {
      connectDomains: ["https://api.example.com"],
    });
    installMcpAppPartitionPolicy("github-declared", mockSessionApi);

    expect(invokeMcpHandler("https://api.example.com/v1/data")).toEqual({ cancel: false });
    // A host the resource did NOT declare stays blocked...
    expect(invokeMcpHandler("https://other.example.com/x")).toEqual({ cancel: true });
    // ...and so does another server's declared host (the set is per-server).
    expect(invokeMcpHandler("https://cdn.jsdelivr.net/x")).toEqual({ cancel: true });
  });

  it("installs the host-owned relay preload via setPreloads (sandboxed <webview> requirement)", () => {
    // The `preload=` ATTRIBUTE is silently ignored under sandbox=yes and is stripped
    // by the will-attach-webview guards, so session.setPreloads is the only path.
    // The path must be host-resolved — an MCP server can never nominate a preload.
    installMcpAppPartitionPolicy("github-preload", mockSessionApi);
    expect(mockSetPreloadsMcp).toHaveBeenCalledOnce();
    const [paths] = mockSetPreloadsMcp.mock.calls[0] as [string[]];
    expect(paths).toHaveLength(1);
    expect(paths[0].endsWith("mcp-app-preload.cjs")).toBe(true);
  });

  it("registers the lvis-mcp-app:// protocol handler that serves the sandbox proxy", () => {
    installMcpAppPartitionPolicy("github-proto", mockSessionApi);
    expect(mockProtocolHandleMcp).toHaveBeenCalledWith("lvis-mcp-app", expect.any(Function));
  });

  it("is idempotent: re-installing the same server does not re-register the gate", () => {
    installMcpAppPartitionPolicy("github-c", mockSessionApi);
    installMcpAppPartitionPolicy("github-c", mockSessionApi);
    expect(mockOnBeforeRequestMcp).toHaveBeenCalledOnce();
  });

  it("distinct servers get distinct partitions (injective encode)", () => {
    installMcpAppPartitionPolicy("srv-x", mockSessionApi);
    installMcpAppPartitionPolicy("srv-y", mockSessionApi);
    const partitions = mockSessionApi.fromPartition.mock.calls.map((c) => c[0] as string);
    expect(partitions).toContain(mcpAppPartitionName("srv-x"));
    expect(partitions).toContain(mcpAppPartitionName("srv-y"));
    expect(mcpAppPartitionName("srv-x")).not.toBe(mcpAppPartitionName("srv-y"));
  });
});

describe("installPluginPartitionPolicy", () => {
  beforeEach(() => {
    mockOnBeforeRequestPlugin.mockClear();
    mockSetPreloadsPlugin.mockClear();
    mockProtocolHandlePlugin.mockClear();
    mockSessionApi.fromPartition.mockClear();
  });

  it("registers plugin-preload.cjs via session.setPreloads (sandboxed <webview> requirement)", () => {
    installPluginPartitionPolicy("persist:plugin:abc123", {}, mockSessionApi);

    expect(mockSessionApi.fromPartition).toHaveBeenCalledWith("persist:plugin:abc123");
    expect(mockSetPreloadsPlugin).toHaveBeenCalledOnce();

    const [preloadList] = mockSetPreloadsPlugin.mock.calls[0] as [string[]];
    expect(Array.isArray(preloadList)).toBe(true);
    expect(preloadList).toHaveLength(1);
    expect(preloadList[0]).toMatch(/plugin-preload\.cjs$/);
  });

  it("also installs the webRequest allowlist on the plugin partition session", () => {
    installPluginPartitionPolicy("persist:plugin:def456", {}, mockSessionApi);
    expect(mockOnBeforeRequestPlugin).toHaveBeenCalledOnce();
    expect(mockOnBeforeRequestPlugin.mock.calls[0][0]).toBeTypeOf("function");
  });

  it("allows the lvis-plugin asset protocol on plugin partitions", () => {
    installPluginPartitionPolicy("persist:plugin:lvisasset", {}, mockSessionApi);
    expect(invokePluginHandler("lvis-plugin://asset/dist/ui/panel.js")).toEqual({ cancel: false });
  });

  it("allows only host-owned plugin shell file URLs on plugin partitions", () => {
    installPluginPartitionPolicy("persist:plugin:shellfiles", {}, mockSessionApi);

    expect(invokePluginHandler("file:///etc/passwd")).toEqual({ cancel: true });
    expect(invokePluginHandler("file:///plugins/agent-hub/dist/ui.js")).toEqual({ cancel: true });
    expect(invokePluginHandler(pluginShellHtmlUrl)).toEqual({ cancel: false });
    expect(invokePluginHandler(pluginShellJsUrl)).toEqual({ cancel: false });
  });

  it("registers the lvis-plugin handler when a plugin root is provided", () => {
    installPluginPartitionPolicy("persist:plugin:withroot", { pluginRoot: "/plugins/agent-hub" }, mockSessionApi);
    expect(mockProtocolHandlePlugin).toHaveBeenCalledWith("lvis-plugin", expect.any(Function));
  });

  it("is idempotent: re-installing the same partition does not re-register setPreloads", () => {
    installPluginPartitionPolicy("persist:plugin:idempotent", {}, mockSessionApi);
    installPluginPartitionPolicy("persist:plugin:idempotent", {}, mockSessionApi);
    expect(mockSetPreloadsPlugin).toHaveBeenCalledOnce();
    expect(mockOnBeforeRequestPlugin).toHaveBeenCalledOnce();
  });
});
