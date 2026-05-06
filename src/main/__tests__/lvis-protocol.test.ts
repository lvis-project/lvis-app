import { describe, expect, it } from "vitest";
import { findLvisProtocolUri, parseAgentHubAuthUri } from "../lvis-protocol.js";

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

describe("parseAgentHubAuthUri", () => {
  // 32-char URL-safe code — representative of a real agent-hub callback.
  const validCode = "abc123_DEF456-ghi789.JKL012~mno3";

  it("parses a well-formed agent-hub-auth URL", () => {
    expect(parseAgentHubAuthUri(`lvis://agent-hub-auth?code=${validCode}`)).toEqual({
      code: validCode,
    });
  });

  it("accepts a trailing slash on the host (`lvis://agent-hub-auth/?code=...`)", () => {
    expect(parseAgentHubAuthUri(`lvis://agent-hub-auth/?code=${validCode}`)).toEqual({
      code: validCode,
    });
  });

  it("ignores URL fragments — they never reach the host process anyway", () => {
    expect(
      parseAgentHubAuthUri(`lvis://agent-hub-auth?code=${validCode}#noise`),
    ).toEqual({ code: validCode });
  });

  it("rejects empty code (`?code=`)", () => {
    expect(parseAgentHubAuthUri("lvis://agent-hub-auth?code=")).toBeNull();
  });

  it("rejects missing code", () => {
    expect(parseAgentHubAuthUri("lvis://agent-hub-auth")).toBeNull();
  });

  it("rejects code shorter than the minimum length", () => {
    expect(parseAgentHubAuthUri("lvis://agent-hub-auth?code=short")).toBeNull();
  });

  it("rejects code longer than the maximum length (>256)", () => {
    const tooLong = "a".repeat(257);
    expect(parseAgentHubAuthUri(`lvis://agent-hub-auth?code=${tooLong}`)).toBeNull();
  });

  it("rejects parameter pollution (`?code=a&code=b`)", () => {
    expect(
      parseAgentHubAuthUri(`lvis://agent-hub-auth?code=${validCode}&code=${validCode}`),
    ).toBeNull();
  });

  it("rejects non-agent-hub-auth host (`lvis://install/...`)", () => {
    expect(parseAgentHubAuthUri("lvis://install/my-plugin")).toBeNull();
  });

  it("rejects unrelated host (`lvis://other-host?code=...`)", () => {
    expect(parseAgentHubAuthUri(`lvis://other-host?code=${validCode}`)).toBeNull();
  });

  it("rejects non-lvis schemes", () => {
    expect(parseAgentHubAuthUri(`https://agent-hub-auth?code=${validCode}`)).toBeNull();
  });

  it("rejects path segments under agent-hub-auth", () => {
    expect(
      parseAgentHubAuthUri(`lvis://agent-hub-auth/extra?code=${validCode}`),
    ).toBeNull();
  });

  it("rejects code with disallowed characters", () => {
    // Spaces decode but aren't in the unreserved class.
    expect(
      parseAgentHubAuthUri("lvis://agent-hub-auth?code=has%20space1234567"),
    ).toBeNull();
    // Slashes are not URL-safe-base64.
    expect(
      parseAgentHubAuthUri("lvis://agent-hub-auth?code=has/slash1234567"),
    ).toBeNull();
  });

  it("rejects malformed URLs", () => {
    expect(parseAgentHubAuthUri("not a url")).toBeNull();
    expect(parseAgentHubAuthUri("")).toBeNull();
  });

  it("does not collide with parseLvisInstallUri's domain (`lvis://install/...`)", () => {
    // Documents that install URIs don't accidentally satisfy auth parser.
    expect(parseAgentHubAuthUri("lvis://install/my-plugin?code=" + validCode)).toBeNull();
  });
});
