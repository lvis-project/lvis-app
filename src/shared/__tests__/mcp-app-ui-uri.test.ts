/**
 * `isMcpAppUiUri` — the one rule deciding what the MCP-Apps read path will serve.
 *
 * Two consumers, and they pull in opposite directions, which is why this is one function
 * rather than two `startsWith` calls:
 *
 *   - `McpClient.readResource` REFUSES what this rejects, so a rejection here closes a
 *     read a compromised renderer would otherwise reach.
 *   - governance EXEMPTS what this accepts from the `resources` capability, so an
 *     acceptance here skips a capability check.
 *
 * Accepting too much widens the exemption; refusing too much breaks MCP Apps on a
 * tools-only server. The tests below hold both edges, not just the refusals.
 */
import { describe, expect, it } from "vitest";
import { isMcpAppUiUri, MCP_APP_UI_SCHEME } from "../mcp-app-partition.js";

describe("isMcpAppUiUri", () => {
  it("accepts the card URIs MCP Apps actually publishes", () => {
    for (const uri of [
      "ui://app/panel.html",
      "ui://widget/main.html",
      "ui://acme-plugin/cards/detail.html?id=1",
      "ui://a",
    ]) {
      expect(isMcpAppUiUri(uri), uri).toBe(true);
    }
  });

  it("refuses every scheme that is not the Apps path", () => {
    // THE case. Each of these reached `resources/read` on any server holding the
    // `resources` capability, because main had no scheme check on this path at all and
    // the `ui://` restriction lived only in the renderer — the side the threat model
    // assumes is compromised.
    for (const uri of [
      "file:///etc/passwd",
      "file:///C:/Users/me/.ssh/id_rsa",
      "https://example.com/x",
      "doc:1",
      "resource://internal/secrets",
      "javascript:alert(1)",
      "",
      "not-a-uri",
    ]) {
      expect(isMcpAppUiUri(uri), uri).toBe(false);
    }
  });

  it("is case-SENSITIVE, because it decides what skips a capability check", () => {
    // Widening this widens the governance exemption, and the URI is passed verbatim to
    // the server besides — the host has no business normalizing a scheme the server will
    // compare literally. A rejection here costs nothing: it falls back to the ordinary
    // `resources` rule rather than opening anything.
    expect(isMcpAppUiUri("UI://app/panel.html")).toBe(false);
    expect(isMcpAppUiUri("Ui://app/panel.html")).toBe(false);
  });

  it("requires an authority", () => {
    // `ui://` names nothing and `ui:///x` has an empty authority — the plugin arm's own
    // authority parse already refuses both, so accepting them here would exempt a URI
    // that cannot be served.
    expect(isMcpAppUiUri(MCP_APP_UI_SCHEME)).toBe(false);
    expect(isMcpAppUiUri("ui:///panel.html")).toBe(false);
    expect(isMcpAppUiUri("ui:////panel.html")).toBe(false);
  });

  it("refuses a scheme that only starts like the Apps one", () => {
    // `ui:` without the slashes, and the near-miss that a bare `startsWith("ui")` would
    // have taken.
    expect(isMcpAppUiUri("ui:/panel.html")).toBe(false);
    expect(isMcpAppUiUri("ui:panel.html")).toBe(false);
    expect(isMcpAppUiUri("uix://app/panel.html")).toBe(false);
  });

  it("refuses control, whitespace and reordering characters", () => {
    // Same class the resource URI rule refuses, and for the same reason: this string
    // reaches an audit line and a card's provenance.
    expect(isMcpAppUiUri("ui://app/pa nel.html")).toBe(false);
    expect(isMcpAppUiUri(`ui://app/panel${String.fromCodePoint(0x0a)}.html`)).toBe(false);
    expect(isMcpAppUiUri(`ui://app/${String.fromCodePoint(0x202e)}lmth.exe`)).toBe(false);
    expect(isMcpAppUiUri(`ui://app/pa${String.fromCodePoint(0x200b)}nel.html`)).toBe(false);
  });

  it("bounds the length", () => {
    expect(isMcpAppUiUri(`ui://app/${"a".repeat(2039)}`)).toBe(true);
    expect(isMcpAppUiUri(`ui://app/${"a".repeat(2040)}`)).toBe(false);
  });

  it("rejects non-strings", () => {
    for (const value of [42, null, undefined, {}, ["ui://app/x"]]) {
      expect(isMcpAppUiUri(value), String(value)).toBe(false);
    }
  });
});
