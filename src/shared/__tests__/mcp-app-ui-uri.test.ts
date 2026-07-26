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
import { isMcpAppUiUri } from "../mcp-app-partition.js";

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
    expect(isMcpAppUiUri("ui://")).toBe(false);
    expect(isMcpAppUiUri("ui:///panel.html")).toBe(false);
    expect(isMcpAppUiUri("ui:////panel.html")).toBe(false);
    // `?` and `#` give an empty hostname just as `/` does — verified against `new URL()`.
    // Missing these was the gap: the predicate claimed to require an authority and did
    // not, so it would have exempted a URI no arm could serve.
    expect(isMcpAppUiUri("ui://?q=1")).toBe(false);
    expect(isMcpAppUiUri("ui://#frag")).toBe(false);
    // …and a real authority carrying a query or fragment is still fine.
    expect(isMcpAppUiUri("ui://app/panel.html?q=1#top")).toBe(true);
  });

  it("refuses a scheme that only starts like the Apps one", () => {
    // `ui:` without the slashes, and the near-miss that a bare `startsWith("ui")` would
    // have taken.
    expect(isMcpAppUiUri("ui:/panel.html")).toBe(false);
    expect(isMcpAppUiUri("ui:panel.html")).toBe(false);
    expect(isMcpAppUiUri("uix://app/panel.html")).toBe(false);
  });

  it("refuses control, whitespace and reordering characters", () => {
    // The SAME class `isUsableResourceUri` refuses, because both ask one function for it.
    // Control and whitespace first — these are why `hasInvisibleOrReorderingChars` alone
    // is not enough: it deliberately admits TAB/LF/CR/space, which prose may hold and an
    // identifier may not.
    expect(isMcpAppUiUri("ui://app/pa nel.html")).toBe(false);
    expect(isMcpAppUiUri(`ui://app/panel${String.fromCodePoint(0x0a)}.html`)).toBe(false);
    expect(isMcpAppUiUri(`ui://app/panel${String.fromCodePoint(0x09)}.html`)).toBe(false);
    expect(isMcpAppUiUri(`ui://app/panel${String.fromCodePoint(0x00)}.html`)).toBe(false);
    // …and the RFC 3986 excluded set, which is what stops a URI closing a fence it is
    // interpolated into.
    for (const ch of ['"', "<", ">", "\\", "^", "`", "{", "}", "|"]) {
      expect(isMcpAppUiUri(`ui://app/pa${ch}nel.html`), ch).toBe(false);
    }
  });

  it("refuses the invisible class WITHOUT enumerating it here", () => {
    // The first version of this predicate hand-listed its ranges and leaked ten of the
    // eleven members below — including U+061C, a bidi control the comment above it
    // claimed to cover. Two reviewers found that independently.
    //
    // So these probes are deliberately drawn from OUTSIDE any list this module holds: if
    // someone re-inlines an enumeration here, this test is what notices. A fixture built
    // from the implementation's own ranges could not — that is the whole reason the leak
    // survived its first test.
    for (const code of [
      0x00ad, // SOFT HYPHEN
      0x034f, // COMBINING GRAPHEME JOINER
      0x061c, // ARABIC LETTER MARK — a bidi control
      0x115f, // HANGUL CHOSEONG FILLER
      0x180e, // MONGOLIAN VOWEL SEPARATOR
      0x2060, // WORD JOINER
      0x2064, // INVISIBLE PLUS
      0x200b, // ZERO WIDTH SPACE
      0x202e, // RIGHT-TO-LEFT OVERRIDE
      0xfe0f, // VARIATION SELECTOR-16
      0xfeff, // ZERO WIDTH NO-BREAK SPACE
    ]) {
      const uri = `ui://app/pa${String.fromCodePoint(code)}nel.html`;
      expect(isMcpAppUiUri(uri), `U+${code.toString(16).toUpperCase().padStart(4, "0")}`)
        .toBe(false);
    }
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
