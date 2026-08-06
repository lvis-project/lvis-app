import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { currentUvTarget, resolveBundledUvBinaryPath } from "../uv-runtime.js";

describe("resolveBundledUvBinaryPath", () => {
  it("uses the canonical project resources directory for a split main chunk in development", () => {
    const projectRoot = resolve("uv-runtime-fixture");
    const target = currentUvTarget({ platform: "linux", arch: "x64" });

    expect(resolveBundledUvBinaryPath({
      defaultApp: true,
      requireDevBinary: false,
      projectRoot,
      platform: "linux",
      arch: "x64",
    })).toBe(join(projectRoot, "resources", "uv", target.dir, target.bin));
  });

  it("preserves an explicit module-directory seam for callers that supply one", () => {
    const moduleDir = resolve("uv-runtime-fixture", "dist", "src", "main");
    const target = currentUvTarget({ platform: "linux", arch: "x64" });

    expect(resolveBundledUvBinaryPath({
      defaultApp: true,
      requireDevBinary: false,
      moduleDir,
      platform: "linux",
      arch: "x64",
    })).toBe(join(moduleDir, "..", "..", "..", "resources", "uv", target.dir, target.bin));
  });
});
