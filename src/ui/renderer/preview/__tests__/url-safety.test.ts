/**
 * `normalizeBrowserNavigationUrl` — the renderer's navigation gate.
 *
 * The protocol + embedded-credential decision is delegated to the shared
 * `validateExternalUrl` authority; this module owns only the renderer-side
 * affordance (trim, and treat a bare host as https). These cases therefore pin
 * BOTH: dropping the credential rule from the shared authority turns the
 * credential cases red, and re-inlining a private copy here would be caught by
 * the same red when the shared rule is mutated.
 */
import { describe, it, expect } from "vitest";
import { normalizeBrowserNavigationUrl } from "../url-safety.js";

describe("normalizeBrowserNavigationUrl", () => {
  it("accepts http(s) URLs and returns the canonical form", () => {
    expect(normalizeBrowserNavigationUrl("https://example.com/docs")).toBe("https://example.com/docs");
    expect(normalizeBrowserNavigationUrl("http://localhost:8000/")).toBe("http://localhost:8000/");
  });

  it("treats a bare host as https and trims surrounding whitespace", () => {
    expect(normalizeBrowserNavigationUrl("  example.com/a  ")).toBe("https://example.com/a");
  });

  it("rejects empty / whitespace-only input", () => {
    expect(normalizeBrowserNavigationUrl("")).toBeNull();
    expect(normalizeBrowserNavigationUrl("   ")).toBeNull();
  });

  it("rejects non-http(s) schemes", () => {
    expect(normalizeBrowserNavigationUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeBrowserNavigationUrl("javascript://x/%0aalert(1)")).toBeNull();
    expect(normalizeBrowserNavigationUrl("data://text/html,x")).toBeNull();
  });

  it("rejects URLs with embedded credentials", () => {
    expect(normalizeBrowserNavigationUrl("https://trusted.example@evil.tld/")).toBeNull();
    expect(normalizeBrowserNavigationUrl("https://user:pass@evil.tld/")).toBeNull();
    expect(normalizeBrowserNavigationUrl("http://:hunter2@evil.tld/pay")).toBeNull();
  });

  it("does not over-reject an @ in the path or query", () => {
    expect(normalizeBrowserNavigationUrl("https://example.com/users/@alice"))
      .toBe("https://example.com/users/@alice");
    expect(normalizeBrowserNavigationUrl("https://example.com/s?to=a@b.com"))
      .toBe("https://example.com/s?to=a@b.com");
  });
});
