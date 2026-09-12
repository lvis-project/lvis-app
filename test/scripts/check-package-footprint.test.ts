import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeFixtureFile } from "./gate-script-runner";

const require = createRequire(import.meta.url);
const { resolveBuildAssets } = require("../../scripts/lib/build-assets.mjs") as {
  resolveBuildAssets(root: string, category: string): Array<{ out: string }>;
};
const node = process.env.LVIS_TEST_NODE_EXEC_PATH ?? process.execPath;
const roots: string[] = [];
const repo = process.cwd();

function fixture(outputDirectory: string, mac: boolean) {
  const root = mkdtempSync(join(tmpdir(), "footprint-cli-"));
  roots.push(root);
  const appOutDir = join(root, outputDirectory);
  const resources = join(appOutDir, mac ? "Resources" : "resources");
  const input = join(root, "asar-input");
  const appAsar = join(resources, "app.asar");
  for (const entry of [
    "dist/src/main/main.js", "dist/src/renderer.js", "dist/src/preload.cjs",
    "dist/src/renderer/chunks/mermaid.12345678.js", "package.json",
    ...resolveBuildAssets(repo, "runtime-script").map((asset) => relative(repo, asset.out)),
  ]) writeFixtureFile(input, entry, "");
  writeFixtureFile(input, "dist/src/main/bundle-manifest.json", JSON.stringify({
    schemaVersion: 1, entry: "main.js", files: [{ path: "main.js", bytes: 0 }],
  }));
  mkdirSync(resources, { recursive: true });
  const pack = spawnSync(node, [require.resolve("@electron/asar/bin/asar.js"), "pack", input, appAsar], {
    encoding: "utf8", timeout: 15_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  expect(pack.error).toBeUndefined();
  expect(pack.status, pack.stderr).toBe(0);
  return { resources, appAsar };
}

function audit(appAsar: string) {
  return spawnSync(node,
    [resolve(repo, "scripts/check-package-footprint.mjs"), appAsar], {
      cwd: repo, encoding: "utf8", timeout: 15_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("package footprint CLI native target validation", () => {
  it.each([
    ["linux-unpacked", "linux-x64", false],
    ["linux-arm64-unpacked", "linux-arm64", false],
    ["win-unpacked", "win32-x64", false],
    ["mac/Client.app/Contents", "darwin-x64", true],
    ["mac-arm64/Client.app/Contents", "darwin-arm64", true],
  ] as const)("checks %s SQLite independently of the test host", (output, target, mac) => {
    const { appAsar, resources } = fixture(output, mac);
    const expectedBinding = join(resources, "app.asar.unpacked", "node_modules",
      "better-sqlite3", "prebuilds", `${target}.node`);
    const missing = audit(appAsar);
    expect(missing.error).toBeUndefined();
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(`better-sqlite3 native binding missing: ${expectedBinding}`);
    expect(missing.stderr).not.toContain("ReferenceError");

    // A wrong-platform file must not satisfy the target check.
    writeFixtureFile(dirname(expectedBinding), "unsupported-x64.node", "fixture binding");
    expect(audit(appAsar).stderr).toContain(`native binding missing: ${expectedBinding}`);
    writeFixtureFile(dirname(expectedBinding), `${target}.node`, "fixture binding");
    const found = audit(appAsar);
    expect(found.status).toBe(1);
    // Reaching the next resource check proves the requested binding was accepted.
    expect(found.stderr).toContain("packaged uv resource missing:");
    expect(found.stderr).not.toContain("native binding missing");
  });
});
