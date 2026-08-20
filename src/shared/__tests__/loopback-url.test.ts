/**
 * The two gates that asked "is this http URL local?" and answered differently.
 */
import { describe, expect, it } from "vitest";
import { isLoopbackHttpUrl, isLoopbackUrlHostname } from "../loopback-url.js";

describe("isLoopbackHttpUrl", () => {
  it("accepts the whole 127.0.0.0/8 block, not just 127.0.0.1", () => {
    // mcp-governance matched 127.0.0.1 exactly, so a legitimate MCP server on
    // 127.0.0.2 was told it needed HTTPS while the marketplace provider gate
    // admitted the same address.
    expect(isLoopbackHttpUrl("http://127.0.0.1:11434/")).toBe(true);
    expect(isLoopbackHttpUrl("http://127.0.0.2:9000/")).toBe(true);
    expect(isLoopbackHttpUrl("http://127.255.255.254/")).toBe(true);
  });

  it("accepts every spelling the URL parser canonicalises to a loopback literal", () => {
    expect(isLoopbackHttpUrl("http://127.1/")).toBe(true);
    expect(isLoopbackHttpUrl("http://2130706433/")).toBe(true);
    expect(isLoopbackHttpUrl("http://[::1]:3000/")).toBe(true);
    expect(isLoopbackHttpUrl("http://[0:0:0:0:0:0:0:1]/")).toBe(true);
    expect(isLoopbackHttpUrl("http://LOCALHOST/")).toBe(true);
    expect(isLoopbackHttpUrl("http://localhost./")).toBe(true);
  });

  it("refuses *.localhost", () => {
    // The one behaviour change: `foo.localhost` resolves through the same
    // /etc/hosts and DNS that can point it at a remote address, and Node's
    // getaddrinfo does not implement the RFC 6761 loopback mapping.
    expect(isLoopbackHttpUrl("http://ollama.localhost/")).toBe(false);
    expect(isLoopbackHttpUrl("http://evil.localhost:8080/")).toBe(false);
  });

  it("refuses a hostname that merely looks like a loopback literal", () => {
    expect(isLoopbackHttpUrl("http://127.0.0.1.evil.com/")).toBe(false);
    expect(isLoopbackHttpUrl("http://localhost.evil.com/")).toBe(false);
    expect(isLoopbackHttpUrl("http://notlocalhost/")).toBe(false);
    expect(isLoopbackHttpUrl("http://128.0.0.1/")).toBe(false);
    expect(isLoopbackHttpUrl("http://12.7.0.1/")).toBe(false);
  });

  it("answers only about http:", () => {
    expect(isLoopbackHttpUrl("https://127.0.0.1/")).toBe(false);
    expect(isLoopbackHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isLoopbackHttpUrl("ws://localhost/")).toBe(false);
    expect(isLoopbackHttpUrl("not a url")).toBe(false);
    expect(isLoopbackHttpUrl("")).toBe(false);
  });

  it("hostname half agrees with the URL half", () => {
    for (const url of ["http://127.0.0.2:9000/", "http://[::1]/", "http://localhost/"]) {
      expect(isLoopbackUrlHostname(new URL(url).hostname)).toBe(true);
    }
    expect(isLoopbackUrlHostname(new URL("http://ollama.localhost/").hostname)).toBe(false);
  });
});
