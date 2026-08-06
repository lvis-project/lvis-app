import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { resolveAppIconPath } from "../app-icon.js";

describe("resolveAppIconPath", () => {
  it("uses the canonical project build directory when the main module is code-split", () => {
    const projectRoot = resolve("app-icon-fixture");
    const expected = join(projectRoot, "build", "icon.png");

    expect(resolveAppIconPath({
      projectRoot,
      cwd: resolve("unrelated-workspace"),
      exists: (candidate) => candidate === expected,
    })).toBe(expected);
  });

  it("prefers the packaged resources icon over the development asset", () => {
    const resourcesPath = resolve("packaged-resources");
    const expected = join(resourcesPath, "icon.png");

    expect(resolveAppIconPath({
      resourcesPath,
      projectRoot: resolve("app-icon-fixture"),
      exists: (candidate) => candidate === expected,
    })).toBe(expected);
  });
});
