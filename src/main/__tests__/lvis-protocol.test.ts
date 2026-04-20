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
});
