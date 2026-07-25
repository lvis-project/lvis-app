/**
 * Resource URI validation — the boundary between "an identifier the host carries"
 * and "a string the host might resolve".
 *
 * The host never fetches these URIs itself; it hands them back to the server that
 * published them. What the allowlist buys is that a resource cannot claim a scheme
 * the host has OTHER meaning for — `ui:` belongs to the MCP-Apps serving path with
 * different containment rules, and the renderer-dangerous schemes must never reach
 * a link or an iframe by mistake.
 */
import { describe, expect, it } from "vitest";
import {
  isHostFetchRefusedUri,
  isUsableResourceUri,
  MCP_RESOURCE_DESCRIPTION_MAX_CHARS,
  MCP_RESOURCE_NAME_MAX_CHARS,
  MCP_RESOURCE_URI_MAX_CHARS,
  usableResourceText,
} from "../mcp-resource-bounds.js";

describe("isUsableResourceUri", () => {
  it("accepts the schemes the spec names plus server-custom ones", () => {
    for (const uri of [
      "file:///project/src/main.rs",
      "git://repo/HEAD",
      "https://example.com/doc",
      "schema://users",
      "issue://123",
      "acme-internal://records/42",
      "x:y",
    ]) {
      expect(isUsableResourceUri(uri), uri).toBe(true);
    }
  });

  it("refuses schemes the host reserves for other meanings", () => {
    for (const uri of [
      "ui://widget/main.html", // MCP-Apps extension — its own serving path
      "javascript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "blob:http://x/y",
      "vbscript:msgbox",
      "about:blank",
      "UI://Widget", // case-insensitive, or the check is trivially bypassed
      "JavaScript:alert(1)",
    ]) {
      expect(isUsableResourceUri(uri), uri).toBe(false);
    }
  });

  it("refuses shapes that are not a URI at all", () => {
    for (const uri of [
      "",
      "no-scheme-here",
      "/absolute/path",
      "./relative",
      "9lives:x", // scheme must start with a letter
      `file://${"a".repeat(MCP_RESOURCE_URI_MAX_CHARS)}`,
      42,
      null,
      undefined,
      { uri: "file:///x" },
    ]) {
      expect(isUsableResourceUri(uri as unknown), String(uri).slice(0, 40)).toBe(false);
    }
  });

  it("refuses a control character anywhere in the URI", () => {
    // The URI is interpolated into audit rows and labels; a newline there can forge
    // a log line, and a NUL can truncate one.
    expect(isUsableResourceUri("file:///a\u0000b")).toBe(false);
    expect(isUsableResourceUri("file:///a\nb")).toBe(false);
    expect(isUsableResourceUri("file:///a\u007fb")).toBe(false);
  });

  it("cannot be tricked by a path that looks like a scheme", () => {
    // A scheme may not contain `/`, so a path segment with a colon is not a scheme.
    expect(isUsableResourceUri("some/path:with-colon")).toBe(false);
  });
});

describe("isHostFetchRefusedUri", () => {
  it("refuses to fetch https, which the spec reserves for direct client access", () => {
    // Listing it is fine; the host becoming a fetcher for a server-chosen URL is an
    // SSRF primitive, so the read is refused instead.
    expect(isHostFetchRefusedUri("https://example.com/doc")).toBe(true);
    expect(isHostFetchRefusedUri("HTTPS://EXAMPLE.COM")).toBe(true);
    expect(isHostFetchRefusedUri("file:///x")).toBe(false);
    expect(isHostFetchRefusedUri("git://x")).toBe(false);
  });
});

describe("usableResourceText", () => {
  it("trims, bounds, and rejects unusable values", () => {
    expect(usableResourceText("  main.rs  ", MCP_RESOURCE_NAME_MAX_CHARS)).toBe("main.rs");
    expect(usableResourceText("", MCP_RESOURCE_NAME_MAX_CHARS)).toBeUndefined();
    expect(usableResourceText("   ", MCP_RESOURCE_NAME_MAX_CHARS)).toBeUndefined();
    expect(usableResourceText(42 as unknown, MCP_RESOURCE_NAME_MAX_CHARS)).toBeUndefined();
    expect(usableResourceText("a\u0000b", MCP_RESOURCE_NAME_MAX_CHARS)).toBeUndefined();
  });

  it("truncates to the caller's bound", () => {
    const long = "x".repeat(MCP_RESOURCE_DESCRIPTION_MAX_CHARS + 100);
    expect(usableResourceText(long, MCP_RESOURCE_DESCRIPTION_MAX_CHARS)?.length).toBe(
      MCP_RESOURCE_DESCRIPTION_MAX_CHARS,
    );
  });
});
