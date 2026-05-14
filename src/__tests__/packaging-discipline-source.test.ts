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
});
