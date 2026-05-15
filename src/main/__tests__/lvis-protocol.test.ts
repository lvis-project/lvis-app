import { describe, expect, it } from "vitest";
import { findLvisProtocolUri, parseMarketplacePluginActionUri, parsePluginAuthUri } from "../lvis-protocol.js";

describe("findLvisProtocolUri", () => {
  it("returns the custom protocol URI from argv", () => {
    expect(
      findLvisProtocolUri([
        "/Applications/LVIS.app/Contents/MacOS/LVIS",
        "--flag",
        "lvis://install/my-plugin",
      ]),
    ).toBe("lvis://install/my-plugin");
  });

  it("returns null when argv has no lvis protocol URI", () => {
    expect(findLvisProtocolUri(["/usr/bin/lvis", "--flag", "https://example.com"])).toBeNull();
  });

  it("matches uppercase scheme LVIS://", () => {
    expect(
      findLvisProtocolUri(["/Applications/LVIS.app/Contents/MacOS/LVIS", "LVIS://install/plugin"]),
    ).toBe("LVIS://install/plugin");
  });

  it("matches mixed-case scheme e.g. Lvis://", () => {
    expect(findLvisProtocolUri(["Lvis://open/dashboard"])).toBe("Lvis://open/dashboard");
  });

  it("returns the first matching URI when multiple are present", () => {
    expect(
      findLvisProtocolUri(["lvis://first", "LVIS://second"]),
    ).toBe("lvis://first");
  });
});

describe("parsePluginAuthUri", () => {
  // 32-char URL-safe code — representative of a real plugin OAuth callback.
  const validCode = "abc123_DEF456-ghi789.JKL012~mno3";

  it("parses a well-formed plugin-auth URL with pluginId 'agent-hub'", () => {
    expect(parsePluginAuthUri(`lvis://plugin-auth/agent-hub?code=${validCode}`)).toEqual({
      pluginId: "agent-hub",
      code: validCode,
    });
  });

  it("parses a well-formed plugin-auth URL with a different pluginId", () => {
    expect(parsePluginAuthUri(`lvis://plugin-auth/some-other-plugin?code=${validCode}`)).toEqual({
      pluginId: "some-other-plugin",
      code: validCode,
    });
  });

  it("ignores URL fragments — they never reach the host process anyway", () => {
    expect(
      parsePluginAuthUri(`lvis://plugin-auth/agent-hub?code=${validCode}#noise`),
    ).toEqual({ pluginId: "agent-hub", code: validCode });
  });

  it("rejects empty code (`?code=`)", () => {
    expect(parsePluginAuthUri("lvis://plugin-auth/agent-hub?code=")).toBeNull();
  });

  it("rejects missing code", () => {
    expect(parsePluginAuthUri("lvis://plugin-auth/agent-hub")).toBeNull();
  });

  it("rejects code shorter than the minimum length", () => {
    expect(parsePluginAuthUri("lvis://plugin-auth/agent-hub?code=short")).toBeNull();
  });

  it("rejects code longer than the maximum length (>256)", () => {
    const tooLong = "a".repeat(257);
    expect(parsePluginAuthUri(`lvis://plugin-auth/agent-hub?code=${tooLong}`)).toBeNull();
  });

  it("rejects parameter pollution (`?code=a&code=b`)", () => {
    expect(
      parsePluginAuthUri(`lvis://plugin-auth/agent-hub?code=${validCode}&code=${validCode}`),
    ).toBeNull();
  });

  it("rejects missing pluginId (`lvis://plugin-auth?code=...`)", () => {
    expect(parsePluginAuthUri(`lvis://plugin-auth?code=${validCode}`)).toBeNull();
  });

  it("rejects empty pluginId (`lvis://plugin-auth/?code=...`)", () => {
    expect(parsePluginAuthUri(`lvis://plugin-auth/?code=${validCode}`)).toBeNull();
  });

  it("rejects pluginId with invalid characters (uppercase, '!')", () => {
    expect(
      parsePluginAuthUri(`lvis://plugin-auth/Bad-PluginID!?code=${validCode}`),
    ).toBeNull();
  });

  it("rejects pluginId starting with a digit", () => {
    expect(
      parsePluginAuthUri(`lvis://plugin-auth/1plugin?code=${validCode}`),
    ).toBeNull();
  });

  it("rejects extra path segments under plugin-auth", () => {
    expect(
      parsePluginAuthUri(`lvis://plugin-auth/agent-hub/extra?code=${validCode}`),
    ).toBeNull();
  });

  it("rejects the legacy `lvis://agent-hub-auth?code=...` host (no backwards compat)", () => {
    expect(parsePluginAuthUri(`lvis://agent-hub-auth?code=${validCode}`)).toBeNull();
  });

  it("rejects unrelated host (`lvis://other-host?code=...`)", () => {
    expect(parsePluginAuthUri(`lvis://other-host?code=${validCode}`)).toBeNull();
  });

  it("rejects non-lvis schemes", () => {
    expect(parsePluginAuthUri(`https://plugin-auth/agent-hub?code=${validCode}`)).toBeNull();
  });

  it("rejects code with disallowed characters", () => {
    // Spaces decode but aren't in the unreserved class.
    expect(
      parsePluginAuthUri("lvis://plugin-auth/agent-hub?code=has%20space1234567"),
    ).toBeNull();
    // Slashes are not URL-safe-base64.
    expect(
      parsePluginAuthUri("lvis://plugin-auth/agent-hub?code=has/slash1234567"),
    ).toBeNull();
  });

  it("rejects malformed URLs", () => {
    expect(parsePluginAuthUri("not a url")).toBeNull();
    expect(parsePluginAuthUri("")).toBeNull();
  });

  it("does not collide with the install route — `lvis://install/<slug>` is not auth", () => {
    // Documents that install URIs don't accidentally satisfy auth parser.
    expect(parsePluginAuthUri("lvis://install/my-plugin?code=" + validCode)).toBeNull();
  });
});

describe("parseMarketplacePluginActionUri", () => {
  it("parses install and uninstall plugin action URLs", () => {
    expect(parseMarketplacePluginActionUri("lvis://install/agent-hub")).toEqual({
      action: "install",
      slug: "agent-hub",
      packageType: "plugin",
    });
    expect(parseMarketplacePluginActionUri("lvis://uninstall/agent-hub")).toEqual({
      action: "uninstall",
      slug: "agent-hub",
      packageType: "plugin",
    });
  });

  it("accepts URL-encoded slug paths after decoding", () => {
    expect(parseMarketplacePluginActionUri("lvis://uninstall/agent.hub_2")).toEqual({
      action: "uninstall",
      slug: "agent.hub_2",
      packageType: "plugin",
    });
  });

  it("parses package-typed marketplace action URLs", () => {
    expect(parseMarketplacePluginActionUri("lvis://install/agent/research-helper")).toEqual({
      action: "install",
      slug: "research-helper",
      packageType: "agent",
    });
    expect(parseMarketplacePluginActionUri("lvis://uninstall/skill/summarizer")).toEqual({
      action: "uninstall",
      slug: "summarizer",
      packageType: "skill",
    });
  });

  it("rejects query strings, fragments, unknown hosts, and unsafe slugs", () => {
    expect(parseMarketplacePluginActionUri("lvis://uninstall/agent-hub?confirm=1")).toBeNull();
    expect(parseMarketplacePluginActionUri("lvis://uninstall/agent-hub#confirm")).toBeNull();
    expect(parseMarketplacePluginActionUri("lvis://remove/agent-hub")).toBeNull();
    expect(parseMarketplacePluginActionUri("lvis://uninstall/%2E%2E%2Fagent-hub")).toBeNull();
    expect(parseMarketplacePluginActionUri("lvis://uninstall/%E0%A4%A")).toBeNull();
    expect(parseMarketplacePluginActionUri("lvis://install/theme/agent-hub")).toBeNull();
    expect(parseMarketplacePluginActionUri("lvis://install/agent/agent-hub/extra")).toBeNull();
  });
});
