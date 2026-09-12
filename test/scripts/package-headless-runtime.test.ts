import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { writeFixtureFile } from "./gate-script-runner.js";

const require = createRequire(import.meta.url);
const node = process.env.LVIS_TEST_NODE_EXEC_PATH ?? process.execPath;
const roots: string[] = [];
const packager = pathToFileURL(resolve("scripts/package-headless-runtime.mjs")).href;
const selectedBinding = "node_modules/better-sqlite3/prebuilds/linux-x64.node";
const foreignBinding = "node_modules/better-sqlite3/prebuilds/win32-x64.node";

function runNode(args: string[]) {
  return spawnSync(node, args, {
    encoding: "utf8", timeout: 15_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
}

function fixture({ headless = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "native-package-extraction-"));
  roots.push(root);
  const input = join(root, "input");
  const archive = join(root, "app.asar");
  const unpacked = `${archive}.unpacked`;
  const app = join(root, "app");
  writeFixtureFile(input, "package.json", JSON.stringify({ name: "lvis-app" }));
  writeFixtureFile(input, "node_modules/better-sqlite3/package.json", JSON.stringify({ main: "prebuilds/linux-x64.node" }));
  writeFixtureFile(input, selectedBinding, "selected before post-pack replacement");
  writeFixtureFile(input, foreignBinding, "foreign native binding");
  if (headless) {
    writeFixtureFile(input, "dist/src/main/headless.js", "process.stdout.write('headless entry');\n");
    chmodSync(join(input, "dist/src/main/headless.js"), 0o755);
  }
  const packed = runNode([require.resolve("@electron/asar/bin/asar.js"), "pack", input, archive, "--unpack", "*.node"]);
  expect(packed.error).toBeUndefined();
  expect(packed.status, packed.stderr).toBe(0);
  return { archive, unpacked, app };
}

function extract(archive: string, app: string) {
  return runNode(["--input-type=module", "-e",
    "const { extractPackagedRuntime } = await import(process.argv[1]); extractPackagedRuntime(process.argv[2], process.argv[3]);",
    packager, archive, app]);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("native packaged payload extraction", () => {
  it("retains packed files and the physical sidecar after pruning and replacement", () => {
    const { archive, unpacked, app } = fixture();
    rmSync(join(unpacked, foreignBinding));
    writeFixtureFile(unpacked, selectedBinding, "replacement native binding with different bytes");
    chmodSync(join(unpacked, selectedBinding), 0o750);
    writeFixtureFile(unpacked, "runtime-assets/added.txt", "post-pack asset");

    const headerExtraction = runNode([require.resolve("@electron/asar/bin/asar.js"), "extract", archive, `${app}-header`]);
    expect(headerExtraction.status).toBe(1);
    expect(headerExtraction.stderr).toContain("win32-x64.node");

    const result = extract(archive, app);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(app, "dist/src/main/headless.js"), "utf8")).toContain("headless entry");
    expect(readFileSync(join(app, selectedBinding), "utf8")).toBe("replacement native binding with different bytes");
    expect(readFileSync(join(app, "runtime-assets/added.txt"), "utf8")).toBe("post-pack asset");
    expect(existsSync(join(app, foreignBinding))).toBe(false);
    if (process.platform !== "win32") {
      expect(statSync(join(app, "dist/src/main/headless.js")).mode & 0o777).toBe(0o755);
      expect(statSync(join(app, selectedBinding)).mode & 0o777).toBe(0o750);
    }
  });

  it("rejects a sidecar file that would overwrite packed content", () => {
    const { archive, unpacked, app } = fixture();
    writeFixtureFile(unpacked, "package.json", "replacement package");
    const result = extract(archive, app);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/already exists|EEXIST|ERR_FS_CP_EEXIST/);
    expect(JSON.parse(readFileSync(join(app, "package.json"), "utf8")).name).toBe("lvis-app");
  });

  it("rejects an absent required server entry", () => {
    const { archive, app } = fixture({ headless: false });
    const result = extract(archive, app);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("headless.js");
  });

  it("leaves missing required native bindings fatal to the existing runtime probe", () => {
    const { archive, unpacked, app } = fixture();
    rmSync(join(unpacked, selectedBinding));
    const extracted = extract(archive, app);
    expect(extracted.status, extracted.stderr).toBe(0);
    const env = { ...process.env };
    delete env.NODE_PATH;
    delete env.NODE_OPTIONS;
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(node, [resolve("scripts/headless-runtime-smoke.mjs"), app], {
      encoding: "utf8", timeout: 15_000, env,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MODULE_NOT_FOUND");
    expect(result.stderr).toContain("linux-x64.node");
  });

  it.skipIf(process.platform === "win32")("rejects sidecar links outside the regular-file inventory", () => {
    const { archive, unpacked, app } = fixture();
    mkdirSync(join(unpacked, "runtime-assets"));
    symlinkSync("../package.json", join(unpacked, "runtime-assets/link"));
    const result = extract(archive, app);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unsupported runtime payload entry");
  });
});
