import { describe, expect, it } from "vitest";
import { findLvisProtocolUri } from "../lvis-protocol.js";

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
