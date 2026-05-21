import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

describe("installer smoke and packaging discipline", () => {
  it("smoke-launches the packaged app before uploading installer artifacts", () => {
    const workflow = readRepoFile(".github/workflows/build-installers.yml");
    const smokeScript = readRepoFile("scripts/smoke-packaged-app.mjs");

    expect(workflow).toContain("Smoke launch packaged app");
    expect(workflow).toContain("scripts/smoke-packaged-app.mjs --target");
    expect(workflow).toContain("xvfb-run -a");
    expect(workflow).toContain("sudo apt-get update && sudo apt-get install -y fakeroot rpm xvfb");
    expect(workflow).toContain("actions/cache@v4");
    expect(workflow).toContain("~/.bun/install/cache");
    expect(workflow).toContain("ELECTRON_BUILDER_CACHE");
    expect(workflow).toContain("--skip-native-rebuild");
    expect(workflow.indexOf("Smoke launch packaged app")).toBeLessThan(workflow.indexOf("Upload installers"));

    expect(smokeScript).toContain("ERR_MODULE_NOT_FOUND");
    expect(smokeScript).toContain("Cannot find package");
    expect(smokeScript).toContain("linux-unpacked");
    expect(smokeScript).toContain("win-unpacked");
    expect(smokeScript).toContain(".app");
  });

  it("documents runtime package imports as dependencies, not devDependencies", () => {
    const claude = readRepoFile("CLAUDE.md");

    expect(claude).toContain("## Packaging Discipline (REQUIRED)");
    expect(claude).toContain("unbundled runtime 코드에 새 top-level package import");
    expect(claude).toContain("webpack/esbuild 로 dist asset에 번들되는 renderer/UI import");
    expect(claude).toContain("`dependencies`");
    expect(claude).toContain("`devDependencies`");
    expect(claude).toContain("ERR_MODULE_NOT_FOUND");
    expect(claude).toContain("adm-zip");
  });

  it("keeps fast preview installer mode separate from size-optimized release artifacts", () => {
    const packageJson = readRepoFile("package.json");
    const buildInstallers = readRepoFile("scripts/build-installers.mjs");
    const releaseChecklist = readRepoFile("docs/references/production-release-checklist.md");

    expect(packageJson).toContain('"dist:fast"');
    expect(packageJson).toContain('"dist:mac:fast"');
    expect(packageJson).toContain('"dist:win:fast"');

    expect(buildInstallers).toContain("--fast");
    expect(buildInstallers).toContain("release-fast");
    expect(buildInstallers).toContain("-c.compression=store");
    expect(buildInstallers).toContain("-c.npmRebuild=false");
    expect(buildInstallers).toContain("cannot be combined with --publish");

    expect(releaseChecklist).toContain("Fast preview mode is only for quick QA links");
    expect(releaseChecklist).toContain("Keep normal `dist:*` / `release`");
    expect(releaseChecklist).toContain("public release assets");
    expect(releaseChecklist).toContain("DMG 106M / ZIP 103M");
    expect(releaseChecklist).toContain("DMG 227M / ZIP 226M");
  });

  it("fails packaging when the platform uv payload or uv license notice is missing", () => {
    const buildInstallers = readRepoFile("scripts/build-installers.mjs");
    const afterPack = readRepoFile("scripts/electron-after-pack.cjs");
    const packageFootprint = readRepoFile("scripts/check-package-footprint.mjs");
    const runtimeAssets = readRepoFile("scripts/packaged-runtime-assets.mjs");

    expect(runtimeAssets).toContain("HOST_PACKAGED_RUNTIME_ASSETS");
    expect(runtimeAssets).toContain("PLUGIN_MANAGED_RUNTIME_ASSETS");
    expect(runtimeAssets).toContain("resources/uv-runtime");
    expect(runtimeAssets).toContain("resources/licenses/uv");
    expect(runtimeAssets).toContain("better-sqlite3-native-binding");
    expect(runtimeAssets).toContain("python-wheelhouse");
    expect(buildInstallers).toContain("hostRuntimeAssetSummary(target)");
    expect(buildInstallers).toContain("required runtime assets");
    expect(buildInstallers).toContain("checkPackageFootprint(target, fast)");
    expect(buildInstallers).toContain("expected exactly one packaged app.asar");
    expect(buildInstallers).toContain("assertUvRuntimePayload(target)");
    expect(buildInstallers).toContain("staged uv runtime must contain only");
    expect(buildInstallers).toContain("compressed uv archive missing from staged runtime");
    expect(buildInstallers).toContain("staged uv binary SHA mismatch");
    expect(afterPack).toContain("assertBundledUvResource(context)");
    expect(afterPack).toContain("packaged uv resource must contain exactly one target");
    expect(afterPack).toContain("packaged uv binary SHA mismatch");
    expect(afterPack).toContain("uv license notice missing");
    expect(packageFootprint).toContain("packaged uv binary SHA mismatch");
    expect(packageFootprint).toContain("uv license notice missing");
  });

  it("keeps electron-builder host runtime resources aligned with the runtime asset inventory", async () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      build?: { extraResources?: Array<{ from?: string; to?: string }> };
    };
    const runtimeAssets = await import("../../scripts/packaged-runtime-assets.mjs");
    const extraResources = packageJson.build?.extraResources ?? [];
    const hostResources = runtimeAssets.HOST_PACKAGED_RUNTIME_ASSETS.flatMap(
      (asset: {
        stagedBy?: string;
        packageResource?: { from: string; to: string };
        licenseResource?: { from: string; to: string };
      }) =>
        asset.stagedBy === "electron-builder native rebuild"
          ? []
          : [asset.packageResource, asset.licenseResource].filter(Boolean),
    );

    for (const resource of hostResources) {
      expect(extraResources).toContainEqual({
        from: resource.from,
        to: resource.to,
      });
    }
  });
});
