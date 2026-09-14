import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { writeImageRuntimePackage } from "../../src/__tests__/support/image-runtime-package.js";

const { assertImageRuntimeFiles } = createRequire(import.meta.url)("../../scripts/lib/image-runtime-files.cjs") as {
  assertImageRuntimeFiles(modules: string, platform: string, arch: string): void;
};
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("packaged image decoder files", () => {
  it.each(["linux", "darwin", "win32"])("requires the %s target's own regular native files", (platform) => {
    const root = mkdtempSync(join(tmpdir(), "image-package-")); roots.push(root);
    writeImageRuntimePackage(root, platform);
    expect(() => assertImageRuntimeFiles(root, platform, "x64")).not.toThrow();
    expect(() => assertImageRuntimeFiles(root, platform, "arm64")).toThrow();
    writeFileSync(join(root, `@img/sharp-${platform}-x64/lib/runtime.node`), "");
    expect(() => assertImageRuntimeFiles(root, platform, "x64")).toThrow("missing or empty");
  });

  it("requires the separate physical codec library", () => {
    const root = mkdtempSync(join(tmpdir(), "image-package-")); roots.push(root);
    writeImageRuntimePackage(root, "linux");
    rmSync(join(root, "@img/sharp-libvips-linux-x64/lib/runtime-library"));
    expect(() => assertImageRuntimeFiles(root, "linux", "x64")).toThrow("missing or empty");
  });
});
