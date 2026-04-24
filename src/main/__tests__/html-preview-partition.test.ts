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
const mockSession = {
  webRequest: {
    onBeforeRequest: mockOnBeforeRequest,
  },
};
const mockMcpSession = {
  webRequest: {
    onBeforeRequest: mockOnBeforeRequestMcp,
  },
};

vi.mock("electron", () => ({
  session: {
    fromPartition: vi.fn((partition: string) =>
      partition === "lvis-mcp-app" ? mockMcpSession : mockSession),
  },
}));

import { session } from "electron";
import { installHtmlPreviewPartitionBlock } from "../html-preview-partition.js";

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
    installHtmlPreviewPartitionBlock();
  });

  it("calls session.fromPartition with the correct partition name", () => {
    expect(vi.mocked(session.fromPartition)).toHaveBeenCalledWith("lvis-render-html");
    expect(vi.mocked(session.fromPartition)).toHaveBeenCalledWith("lvis-mcp-app");
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
