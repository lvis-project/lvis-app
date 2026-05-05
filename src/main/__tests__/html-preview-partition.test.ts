/**
 * html-preview-partition unit tests
 *
 * Verifies that installHtmlPreviewPartitionBlock() registers a webRequest
 * handler that allows data:/blob:/about:blank and cancels everything else.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock electron ────────────────────────────────────────────────────────────
const mockOnBeforeRequest = vi.fn();
const mockOnBeforeRequestMcp = vi.fn();
const mockOnBeforeRequestPlugin = vi.fn();
const mockSetPreloadsPlugin = vi.fn();
const mockProtocolHandlePlugin = vi.fn();
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
  setPreloads: vi.fn(),
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
  installPluginPartitionPolicy,
} from "../html-preview-partition.js";

const mockSessionApi = {
  fromPartition: vi.fn((partition: string) => {
    if (partition === "lvis-mcp-app") return mockMcpSession as unknown as Electron.Session;
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

describe("installHtmlPreviewPartitionBlock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installHtmlPreviewPartitionBlock(mockSessionApi);
  });

  it("calls session.fromPartition with the correct partition name", () => {
    expect(mockSessionApi.fromPartition).toHaveBeenCalledWith("lvis-render-html");
    expect(mockSessionApi.fromPartition).toHaveBeenCalledWith("lvis-mcp-app");
  });

  it("registers a webRequest.onBeforeRequest handler", () => {
    expect(mockOnBeforeRequest).toHaveBeenCalledOnce();
    expect(mockOnBeforeRequestMcp).toHaveBeenCalledOnce();
    expect(mockOnBeforeRequest.mock.calls[0][0]).toBeTypeOf("function");
  });

  it("allows data: URLs", () => {
    expect(invokeHandler("data:text/html;charset=utf-8,hello")).toEqual({ cancel: false });
  });

  it("allows blob: URLs", () => {
    expect(invokeHandler("blob:null/abc-123")).toEqual({ cancel: false });
  });

  it("allows about:blank", () => {
    expect(invokeHandler("about:blank")).toEqual({ cancel: false });
  });

  it("blocks http URLs", () => {
    expect(invokeHandler("http://example.com/evil")).toEqual({ cancel: true });
  });

  it("blocks https URLs", () => {
    expect(invokeHandler("https://attacker.example/exfil")).toEqual({ cancel: true });
  });

  it("allows CDN https URLs only for MCP apps", () => {
    expect(invokeHandler("https://cdn.jsdelivr.net/npm/vue")).toEqual({ cancel: true });
    expect(invokeMcpHandler("https://cdn.jsdelivr.net/npm/vue")).toEqual({ cancel: false });
  });

  it("blocks file URLs", () => {
    expect(invokeHandler("file:///etc/passwd")).toEqual({ cancel: true });
  });

  it("blocks ftp URLs", () => {
    expect(invokeHandler("ftp://ftp.example.com/data")).toEqual({ cancel: true });
  });

  it("blocks unknown scheme URLs", () => {
    expect(invokeHandler("custom-scheme://something")).toEqual({ cancel: true });
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
    // Unique partition name avoids the module-level installedPluginPartitions
    // Set short-circuit from prior test runs.
    installPluginPartitionPolicy("persist:plugin:abc123", {}, mockSessionApi);

    expect(mockSessionApi.fromPartition).toHaveBeenCalledWith("persist:plugin:abc123");
    expect(mockSetPreloadsPlugin).toHaveBeenCalledOnce();

    const [preloadList] = mockSetPreloadsPlugin.mock.calls[0] as [string[]];
    expect(Array.isArray(preloadList)).toBe(true);
    expect(preloadList).toHaveLength(1);
    // resolve(__dirname, "..", "plugin-preload.cjs") at runtime; in tests
    // __dirname is `src/main/__tests__` so the resolved path ends with
    // `src/plugin-preload.cjs`. Match flexibly across path separators.
    expect(preloadList[0]).toMatch(/plugin-preload\.cjs$/);
  });

  it("also installs the webRequest allowlist on the plugin partition session", () => {
    installPluginPartitionPolicy("persist:plugin:def456", {}, mockSessionApi);
    expect(mockOnBeforeRequestPlugin).toHaveBeenCalledOnce();
    expect(mockOnBeforeRequestPlugin.mock.calls[0][0]).toBeTypeOf("function");
  });

  it("allows the lvis-plugin asset protocol on plugin partitions", () => {
    installPluginPartitionPolicy("persist:plugin:lvisasset", {}, mockSessionApi);
    const handler = mockOnBeforeRequestPlugin.mock.calls[0][0] as (
      details: { url: string },
      callback: (result: { cancel: boolean }) => void,
    ) => void;
    let result!: { cancel: boolean };
    handler({ url: "lvis-plugin://asset/dist/ui/panel.js" }, (r) => {
      result = r;
    });
    expect(result).toEqual({ cancel: false });
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
